/**
 * demo-ingest — fetch + ingest the pending source URLs for one demo tenant.
 *
 * Service-role/dispatch only. For every knowledge_docs row tagged
 * 'ingest-pending' on the tenant, it fetches the source URL (SSRF-guarded),
 * strips it to text, updates the doc content, and calls the proven
 * ingest-chunks function (dispatch path) to chunk + embed. Each source's
 * outcome — ingested (with char/chunk counts) or failed (with a reason) —
 * is recorded honestly and returned; a failure never throws or fabricates.
 *
 * Idempotent: re-running re-ingests, and only 'ingest-pending' rows are
 * touched. No credentials involved.
 *
 * POST { tenant_id }   (or { slug })
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isSafeExternalUrl } from '../_shared/urlSafety.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const MAX_TEXT_CHARS = 500_000;

function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    const body = await req.json().catch(() => ({})) as { tenant_id?: string; slug?: string };
    let tenantId = body.tenant_id ?? null;
    if (!tenantId && body.slug) {
      const { data: t } = await admin.from('tenants').select('id').eq('slug', body.slug).maybeSingle();
      tenantId = t?.id ?? null;
    }
    if (!tenantId) return json({ error: 'tenant_id or slug required' }, 400);

    const { data: docs, error: dErr } = await admin.from('knowledge_docs')
      .select('id, title, external_ref, tags')
      .eq('tenant_id', tenantId)
      .contains('tags', ['ingest-pending']);
    if (dErr) return json({ error: dErr.message }, 500);

    const results: Array<Record<string, unknown>> = [];
    for (const doc of (docs ?? [])) {
      const url = String(doc.external_ref ?? '').trim();
      const baseTags = (doc.tags as string[] ?? []).filter((t) => t !== 'ingest-pending' && t !== 'ingest-failed' && t !== 'ingested');
      const rec: Record<string, unknown> = { doc_id: doc.id, title: doc.title, url };
      try {
        if (!/^https?:\/\//i.test(url)) throw new Error('no http(s) URL');
        if (!isSafeExternalUrl(url)) throw new Error('blocked by SSRF policy');
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'Accept': 'text/html, text/plain', 'User-Agent': 'Mozilla/5.0 (compatible; DreamTeamBot/1.0)' } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ctype = resp.headers.get('content-type') ?? '';
        if (ctype.includes('application/pdf')) throw new Error('PDF (not handled in demo-ingest)');
        const text = stripHtml((await resp.text()).slice(0, 2_000_000)).slice(0, MAX_TEXT_CHARS);
        if (text.length < 200) throw new Error(`too little readable text (${text.length} chars — likely a JS-rendered SPA)`);

        await admin.from('knowledge_docs').update({
          content: text, is_current: true, tags: [...baseTags, 'ingested'],
        }).eq('id', doc.id);

        // Chunk + embed via the proven pipeline (dispatch path).
        const ing = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ingest-chunks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${svc}`, 'x-dispatch-secret': dispatch, 'apikey': svc },
          body: JSON.stringify({ doc_id: doc.id, tenant_id: tenantId }),
        });
        const ingBody = await ing.json().catch(() => ({}));
        rec.status = 'ingested';
        rec.chars = text.length;
        rec.chunks = ingBody?.chunks ?? null;
        rec.embedded = ingBody?.embedded ?? null;
      } catch (e) {
        await admin.from('knowledge_docs').update({ tags: [...baseTags, 'ingest-failed'] }).eq('id', doc.id);
        rec.status = 'failed';
        rec.reason = String((e as Error)?.message ?? e).slice(0, 160);
      }
      results.push(rec);
    }

    const ingested = results.filter((r) => r.status === 'ingested').length;
    return json({ ok: true, tenant_id: tenantId, total: results.length, ingested, failed: results.length - ingested, results });
  } catch (err) {
    console.error('demo-ingest error:', String(err));
    return json({ error: String(err) }, 500);
  }
});
