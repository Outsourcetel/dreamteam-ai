/**
 * knowledge-ingest-drain — the worker for the mig-347 ingestion queue.
 *
 * Claims a bounded batch of knowledge_ingestion_items, turns each one into a
 * knowledge document, and hands it to the existing chunk+embed path. Nothing
 * here re-implements ingestion: content extraction reuses the same _shared
 * modules extract-document uses, and chunking/embedding is the proven
 * ingest-chunks function called with the dispatch secret. This worker's job is
 * the part that was missing — doing it repeatedly, safely, and giving up at the
 * right moment.
 *
 * Per item:
 *   1. content — raw_content if the enqueuer already had it, otherwise fetch
 *      source_ref through the SSRF guard (PDF -> unpdf, HTML -> strip)
 *   2. duplicate check via find_duplicate_knowledge_doc, so a re-run of the
 *      same job does not double the corpus
 *   3. create the document at the job's publish_mode (346 lifecycle)
 *   4. chunk + embed via ingest-chunks
 *   5. complete_ingestion_item, which also files it into the job's Space
 *
 * FAILURE CLASSIFICATION IS THE POINT. browserFetch already returns a machine
 * reason, so this maps that rather than inventing a second taxonomy:
 *     blocked | not_found | unsupported   -> terminal, stop now
 *     server_error | network | timeout    -> retryable, exponential backoff
 * A queue that retries an unreadable file forever burns its drain slot every
 * tick, buries the real failures, and never tells the human the file was bad.
 *
 * Auth: x-dispatch-secret (what pg_cron sends) or the service-role key.
 * Kill-switch: platform_config 'knowledge.ingest_paused'.
 *
 * POST { tenant_id?, limit? } -> { processed, succeeded, failed, skipped, remaining, done }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isSafeExternalUrl } from '../_shared/urlSafety.ts';
import { browserFetch } from '../_shared/browserFetch.ts';
import { pdfToText, MAX_PDF_BYTES } from '../_shared/pdfExtract.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const MAX_TEXT_CHARS = 500_000;

type Kind = 'retryable' | 'terminal';
class ItemError extends Error {
  kind: Kind;
  constructor(message: string, kind: Kind) { super(message); this.kind = kind; }
}

interface Item {
  id: string; job_id: string; tenant_id: string;
  source_ref: string; title: string | null; raw_content: string | null;
  attempts: number; max_attempts: number;
}
interface Job {
  id: string; tenant_id: string; publish_mode: string;
  target_collection_id: string | null; source_kind: string; status: string;
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Map browserFetch's reason onto retry policy. Its vocabulary, not a new one. */
function fetchReasonToKind(reason: string | undefined): Kind {
  switch (reason) {
    case 'blocked':      // SSRF guard or the origin refused us — retrying changes nothing
    case 'not_found':    // 404/410 — the URL is wrong, not busy
    case 'unsupported':  // content type we cannot read
      return 'terminal';
    default:
      return 'retryable'; // server_error, network, timeout
  }
}

async function resolveContent(item: Item): Promise<{ title: string; content: string }> {
  // Already in hand (paste, or a client-side extraction) — nothing to fetch.
  if (item.raw_content && item.raw_content.trim()) {
    return { title: item.title || item.source_ref, content: item.raw_content.slice(0, MAX_TEXT_CHARS) };
  }

  const ref = (item.source_ref || '').trim();
  if (!/^https?:\/\//i.test(ref)) {
    // No content and nothing fetchable. Retrying cannot conjure either.
    throw new ItemError(
      'this item has no content and its source is not a fetchable URL — re-add it with the text included',
      'terminal');
  }
  if (!isSafeExternalUrl(ref)) {
    throw new ItemError('that address is not allowed to be fetched (internal or unsafe target)', 'terminal');
  }

  const out = await browserFetch(ref, 20000, 2);
  if (!out.ok || !out.response) {
    throw new ItemError(
      out.detail || `could not fetch the page (${out.reason ?? 'unknown'}, status ${out.status})`,
      fetchReasonToKind(out.reason));
  }

  const ctype = (out.response.headers.get('content-type') ?? '').toLowerCase();
  let text: string;

  if (ctype.includes('pdf') || /\.pdf(\?|$)/i.test(ref)) {
    const buf = new Uint8Array(await out.response.arrayBuffer());
    if (buf.byteLength > MAX_PDF_BYTES) {
      throw new ItemError(`that PDF is larger than the ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB limit`, 'terminal');
    }
    try {
      text = await pdfToText(buf);
    } catch (e) {
      // A PDF that will not parse now will not parse in five minutes either.
      throw new ItemError(`that PDF could not be read (${String(e).slice(0, 120)})`, 'terminal');
    }
  } else if (ctype.includes('html') || ctype.includes('xml') || ctype.includes('text') || ctype === '') {
    text = stripHtml(await out.response.text());
  } else {
    throw new ItemError(`unsupported content type "${ctype}" — only web pages and PDFs can be imported`, 'terminal');
  }

  text = (text || '').trim();
  if (!text) {
    throw new ItemError('nothing readable was found at that address (the page may be script-rendered)', 'terminal');
  }

  // Prefer an explicit title, then the page's <title>, then the URL.
  let title = item.title || '';
  if (!title) {
    const m = /<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(text);
    title = (m?.[1] ?? '').trim();
  }
  return { title: (title || ref).slice(0, 300), content: text.slice(0, MAX_TEXT_CHARS) };
}

async function chunkAndEmbed(admin: SupabaseClient, docId: string, tenantId: string, dispatch: string) {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ingest-chunks`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ingest-chunks accepts the service-role key directly; the gateway needs a bearer.
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'x-dispatch-secret': dispatch,
      },
      body: JSON.stringify({ doc_id: docId, tenant_id: tenantId }),
    });
  } catch (e) {
    throw new ItemError(`could not reach the chunking service (${String(e).slice(0, 120)})`, 'retryable');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 4xx from our own service means the request is wrong, not that it is busy.
    throw new ItemError(`chunking failed (${res.status}) ${body.slice(0, 200)}`,
      res.status >= 400 && res.status < 500 ? 'terminal' : 'retryable');
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!((dispatch && req.headers.get('x-dispatch-secret') === dispatch) || bearer === svc)) {
      return json({ error: 'unauthorized' }, 401);
    }

    // Kill-switch before any work.
    try {
      const { data: pause } = await admin.from('platform_config')
        .select('value').eq('key', 'knowledge.ingest_paused').maybeSingle();
      const v = (pause?.value ?? '').toString().trim();
      if (v === 'true' || v === '1' || v === 't') {
        return json({ ok: true, paused: true, processed: 0, succeeded: 0, failed: 0, skipped: 0, remaining: 0, done: false });
      }
    } catch { /* absent → not paused */ }

    const body = await req.json().catch(() => ({})) as { tenant_id?: string; limit?: number };
    const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 25);

    // Scope the CLAIM, never the result. Filtering after claiming would flip
    // other workspaces' items to 'running', burn an attempt each, and strand
    // them until the reaper ran (mig 351).
    const { data: claimed, error: claimErr } = await admin.rpc('claim_ingestion_items', {
      p_limit: limit, p_tenant_id: body.tenant_id ?? null,
    });
    if (claimErr) return json({ error: claimErr.message }, 500);

    const items = (claimed ?? []) as Item[];

    let succeeded = 0, failed = 0, skipped = 0;
    const jobs = new Map<string, Job>();

    for (const item of items) {
      try {
        let job = jobs.get(item.job_id);
        if (!job) {
          const { data } = await admin.from('knowledge_ingestion_jobs')
            .select('id, tenant_id, publish_mode, target_collection_id, source_kind, status')
            .eq('id', item.job_id).maybeSingle();
          if (!data) throw new ItemError('the job this item belongs to no longer exists', 'terminal');
          job = data as Job;
          jobs.set(item.job_id, job);
        }
        // Someone pressed cancel between the claim and now.
        if (job.status === 'cancelled') {
          await admin.from('knowledge_ingestion_items')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', item.id);
          continue;
        }
        // Stamp the job as started on its first real item.
        if (!['running', 'cancelled'].includes(job.status)) {
          await admin.from('knowledge_ingestion_jobs')
            .update({ status: 'running', started_at: new Date().toISOString() }).eq('id', job.id);
          job.status = 'running';
        }

        const { title, content } = await resolveContent(item);

        // Already have this exact text? Link it, do not duplicate it.
        const { data: dupId } = await admin.rpc('find_duplicate_knowledge_doc', {
          p_tenant_id: item.tenant_id, p_title: title, p_content: content,
        });
        if (dupId) {
          await admin.rpc('complete_ingestion_item', {
            p_item_id: item.id, p_doc_id: dupId, p_duplicate: true,
          });
          skipped++;
          continue;
        }

        const { data: doc, error: docErr } = await admin.from('knowledge_docs').insert({
          tenant_id: item.tenant_id,
          title,
          content,
          source: job.source_kind === 'url' ? 'url' : 'upload',
          visibility: 'tenant',
          is_current: true,
          lifecycle_status: job.publish_mode,   // 346: import as published, or as drafts for review
          external_ref: item.source_ref,
        }).select('id').single();
        if (docErr) {
          // A constraint violation is our bug or bad input; neither is fixed by waiting.
          throw new ItemError(`could not save the document (${docErr.message})`, 'terminal');
        }

        await chunkAndEmbed(admin, doc.id, item.tenant_id, dispatch);

        // Records success AND files it into the job's Space.
        await admin.rpc('complete_ingestion_item', {
          p_item_id: item.id, p_doc_id: doc.id, p_duplicate: false,
        });
        succeeded++;
      } catch (e) {
        const kind: Kind = e instanceof ItemError ? e.kind : 'retryable';
        const msg = e instanceof Error ? e.message : String(e);
        // fail_ingestion_item decides retry-vs-final using attempts and kind.
        const { data: outcome } = await admin.rpc('fail_ingestion_item', {
          p_item_id: item.id, p_error: msg, p_kind: kind,
        });
        if (outcome === 'failed') failed++;
        console.error(`ingest item ${item.id} ${kind}: ${msg}`);
      }
    }

    let rq = admin.from('knowledge_ingestion_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'queued').lte('next_attempt_at', new Date().toISOString());
    if (body.tenant_id) rq = rq.eq('tenant_id', body.tenant_id);
    const { count: remaining } = await rq;

    return json({
      ok: true, processed: items.length, succeeded, failed, skipped,
      remaining: remaining ?? 0, done: (remaining ?? 0) === 0,
    });
  } catch (err) {
    console.error('knowledge-ingest-drain error:', String(err));
    await reportEdgeError('knowledge-ingest-drain', err, {});
    return json({ error: String(err) }, 500);
  }
});
