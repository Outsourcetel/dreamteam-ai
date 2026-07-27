// ============================================================================
// site-import — one website address in, a populated knowledge base out.
//
// ── The problem this exists to fix ─────────────────────────────────────────
// Of 16 workspaces, the two genuine outside signups both died with ZERO
// knowledge documents ("acs" 2026-07-24: 6 employees, 4 conversations, 0 docs;
// "Harbor Peak Consulting" 2026-07-06: 5 employees, 0 docs). Every workspace
// that HAS documents got them from a seed script. No human has ever added
// knowledge through the UI.
//
// The reason is mechanical, not motivational. The only URL path we shipped
// (LiveKnowledgeLibrary.importUrl -> extract-document kind:'url') imports ONE
// page per paste, and extract-document has no sitemap and no crawl. The user's
// answers are already written down — on their website, across dozens of
// help/FAQ/policy pages. "Import my website" meant pasting URLs one at a time.
//
// ── What this function does, and deliberately does NOT do ──────────────────
// It DISCOVERS and RANKS pages (../_shared/siteDiscovery.ts), then hands them
// to the existing mig-347 ingestion queue via create_ingestion_job. It creates
// no documents itself. knowledge-ingest-drain already fetches, extracts,
// de-duplicates (find_duplicate_knowledge_doc, mig 350 §3), creates the doc,
// chunks and embeds it, classifies failures as retryable vs terminal, and backs
// off. Re-implementing any of that here would be a second, divergent ingestion
// path — the exact mistake mig 350 §3 argues against.
//
// So the only genuinely NEW behaviour here is: find the pages, put the useful
// ones first, and report honestly what happened to each.
//
// ── Why it also waits, instead of just queueing ────────────────────────────
// The queue's pg_cron drain (mig 350 §6) runs every 2 minutes at 10 items a
// tick. A user who just typed their website address and is watching a spinner
// should not wait 4 minutes to learn whether it worked. So after enqueueing,
// this kicks the SAME drain directly and waits a bounded slice of time, then
// reports per-page outcomes — with anything unfinished honestly marked
// "still importing", because the cron will finish it either way.
//
// POST { url, max_pages?, tenant_id?, wait_ms?, publish_mode?, collection_id? }
// ============================================================================
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';
import {
  discoverSitePages, normalizeInputUrl, canonicalizeUrl, registrableDomain, titleFromUrl,
  DEFAULT_MAX_PAGES, MAX_PAGES_CEILING,
  type SkippedUrl,
} from '../_shared/siteDiscovery.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ── Wall-clock budget ───────────────────────────────────────────────────────
// Split explicitly so neither half can eat the other. Worst case is
// DISCOVERY + WAIT + a little slack, comfortably inside the edge runtime's
// request budget, and BOTH halves degrade to a useful answer when they expire:
// discovery returns what it found so far, waiting returns "still importing".
const DISCOVERY_BUDGET_MS = 35_000;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 60_000;
const DRAIN_ROUND_PAUSE_MS = 1500;

// knowledge-ingest-drain:256 maps the JOB's source_kind onto the DOCUMENT's
// `source` column:  source_kind === 'url' ? 'url' : 'upload'.
// But the live CHECK constraint knowledge_docs_source_check only permits
// ('upload','paste','connector','self_improvement','ai_assistant') — verified
// against production on 2026-07-26. So a job created with source_kind 'url'
// would fail EVERY item with a constraint violation, which the drain classifies
// as terminal ("could not save the document"). The queue has never run in
// production (0 rows in knowledge_ingestion_items), so nothing has exposed this.
//
// 'upload' is therefore the only value that works today. The job LABEL and each
// item's source_ref still carry the real website, so nothing is hidden from the
// human — only the internal source tag is imprecise. Switch this to 'url' the
// moment either the constraint gains 'url' or drain:256 stops emitting it.
const SOURCE_KIND = 'upload';

interface Body {
  url?: string;
  max_pages?: number;
  tenant_id?: string;
  wait_ms?: number;
  publish_mode?: 'published' | 'draft';
  collection_id?: string | null;
}

interface ItemRow {
  id: string; source_ref: string; title: string | null; status: string;
  last_error: string | null; error_kind: string | null; doc_id: string | null;
}

type PageStatus = 'imported' | 'already_in_library' | 'failed' | 'pending';

const SKIP_EXPLANATION: Record<SkippedUrl['reason'], string> = {
  login_or_cart: 'sign-in or checkout page — nothing readable behind it',
  listing_or_archive: 'index/archive page rather than content',
  not_a_page: 'not a readable page (image, script or download)',
  off_site: 'on a different website',
  unsafe_address: 'not a permitted public address',
  already_imported: 'already in your library',
  over_max_pages: `ranked below the page limit`,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask the drain to run now for this workspace. Returns false if it declined. */
async function kickDrain(tenantId: string, budgetMs: number): Promise<{ ok: boolean; paused: boolean }> {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/knowledge-ingest-drain`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The gateway wants a bearer; the drain's real check is the dispatch
        // secret or the service-role key (knowledge-ingest-drain:184).
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'x-dispatch-secret': Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '',
      },
      body: JSON.stringify({ tenant_id: tenantId, limit: 10 }),
      signal: AbortSignal.timeout(Math.max(5_000, budgetMs)),
    });
    if (!res.ok) return { ok: false, paused: false };
    const out = await res.json().catch(() => ({})) as { paused?: boolean };
    return { ok: true, paused: out.paused === true };
  } catch {
    // A timeout here does NOT mean failure — the drain invocation keeps running
    // server-side, and the cron would pick the queue up regardless.
    return { ok: false, paused: false };
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const started = Date.now();
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ── Auth. In-function validation, not just the gateway's verify_jwt
    // (external security review 2026-07-20). ──
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: userData, error: userErr } = await admin.auth.getUser(bearer);
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({})) as Body;

    // ── Tenant. A caller-supplied tenant_id is NEVER taken at face value: it is
    // only honoured when resolve_remote_access_tenant confirms a real, recent
    // platform Remote Access session (mig 102 / resolveTenant.ts). Same pattern
    // as ingest-chunks. The authoritative write below goes through
    // create_ingestion_job under the caller's OWN JWT, so auth_tenant_id() and
    // the mig-343 permission gate decide what actually happens. ──
    const { data: profile } = await admin
      .from('profiles').select('tenant_id, layer').eq('user_id', userId).single();
    const tenantId = await resolveTenantWithRemoteAccess(admin, userId, profile?.tenant_id, profile?.layer, body.tenant_id);
    if (!tenantId) return json({ error: 'no_tenant' }, 403);

    // ── Input ──
    const site = normalizeInputUrl(String(body.url ?? ''));
    if (!site) {
      return json({ error: 'that does not look like a public website address — try something like acme.com' }, 400);
    }
    const maxPages = Math.min(MAX_PAGES_CEILING, Math.max(1, Number(body.max_pages) || DEFAULT_MAX_PAGES));
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(body.wait_ms ?? DEFAULT_WAIT_MS)));

    // ── Idempotency, part 1: don't start a second import of the same site while
    // one is still running. Retrying a slow import must not double the corpus. ──
    const { data: inflight } = await admin
      .from('knowledge_ingestion_jobs')
      .select('id, created_at')
      .eq('tenant_id', tenantId).eq('source_ref', site)
      .in('status', ['queued', 'running'])
      .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (inflight?.id) {
      return json({
        ok: true, site, job_id: inflight.id, already_running: true,
        message: `An import of ${site} is already running — showing that one instead of starting a second.`,
      });
    }

    // ── Idempotency, part 2: skip pages already imported from this site.
    // The drain stamps knowledge_docs.external_ref with the item's source_ref
    // (knowledge-ingest-drain:260), so that column is the record of "we already
    // fetched this URL". Skipping here saves the fetch entirely; the drain's
    // content-hash dedupe is still the backstop for a page reachable at two
    // different URLs. ──
    const alreadyImported = new Set<string>();
    try {
      const domain = registrableDomain(new URL(site).hostname);
      // LIKE metacharacters cannot appear in a registrable domain. Rather than
      // guess at PostgREST's escaping rules, skip the prefilter if one somehow
      // does — the drain's content-hash dedupe is still the real guarantee.
      if (!/[%_\\]/.test(domain)) {
        const { data: existing } = await admin
          .from('knowledge_docs')
          .select('external_ref')
          .eq('tenant_id', tenantId).eq('is_current', true)
          .ilike('external_ref', `%${domain}%`)
          .limit(5000);
        for (const row of existing ?? []) {
          const k = canonicalizeUrl(String(row.external_ref ?? ''));
          if (k) alreadyImported.add(k);
        }
      }
    } catch (e) {
      // Non-fatal: without this list we re-fetch pages the drain will then
      // recognise as duplicates. Slower, still correct.
      console.error('site-import: could not read existing external_refs:', String(e));
    }

    // ── Discover ──
    const discovery = await discoverSitePages(site, {
      maxPages,
      deadline: started + DISCOVERY_BUDGET_MS,
      alreadyImported,
    });
    if ('error' in discovery) return json({ error: discovery.error }, 400);

    // 'input-only' means discovery reached NOTHING — no sitemap, no robots.txt,
    // no readable homepage. Verified against a domain that does not resolve
    // (2026-07-26): discovery still returns the site root as a lone candidate,
    // which would queue one item guaranteed to fail. Telling the human the site
    // could not be reached is better than a job that fails a minute later.
    if (discovery.method === 'input-only') {
      return json({
        ok: false, site: discovery.site, method: discovery.method,
        notes: discovery.notes,
        error: `Nothing could be read from ${discovery.site}. ${discovery.notes[0] ?? 'The address may be wrong, or the site may block automated access.'}`,
      }, 422);
    }

    if (discovery.ranked.length === 0) {
      const alreadyCount = discovery.skipped.filter((s) => s.reason === 'already_imported').length;
      return json({
        ok: false, site: discovery.site, method: discovery.method,
        found: discovery.found,
        skipped: discovery.skipped.slice(0, 50),
        notes: discovery.notes,
        error: alreadyCount > 0
          ? `Every page found on ${discovery.site} (${alreadyCount}) is already in your library.`
          : `No importable pages were found on ${discovery.site}. ${discovery.notes[0] ?? 'The site may be script-rendered or may block automated fetching.'}`,
      }, 422);
    }

    // ── Enqueue, under the CALLER's JWT ──
    // create_ingestion_job is SECURITY DEFINER and derives the tenant from
    // auth_tenant_id(), enforces the contributor gate, and enforces that
    // publishing on import requires publisher (mig 350 §4). Calling it as the
    // user means those checks run for real instead of being bypassed by the
    // service role — and means this function does not re-implement them.
    const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });

    const items = discovery.ranked.map((p) => ({ url: p.url, title: titleFromUrl(p.url) }));
    const label = `Website import — ${new URL(discovery.site).hostname}`;
    const enqueue = (publishMode: 'published' | 'draft') => asUser.rpc('create_ingestion_job', {
      p_label: label,
      p_source_kind: SOURCE_KIND,
      p_items: items,
      p_target_collection_id: body.collection_id ?? null,
      p_source_ref: discovery.site,
      p_connector_id: null,
      p_publish_mode: publishMode,
    });

    let publishMode: 'published' | 'draft' = body.publish_mode === 'draft' ? 'draft' : 'published';
    let { data: jobId, error: jobErr } = await enqueue(publishMode);
    if (jobErr && /publishing on import requires publisher/i.test(jobErr.message ?? '')) {
      // Every workspace grants 'everyone' editor (rank 3) and owners/admins
      // workspace_admin (rank 6) — checked live 2026-07-26. So an ordinary
      // member CAN import but CANNOT publish. Failing them outright would send
      // the very user we are trying to unblock back to a dead end; landing the
      // pages as drafts is the review flow mig 350 §4 describes, and the
      // response says so plainly rather than pretending they were published.
      publishMode = 'draft';
      ({ data: jobId, error: jobErr } = await enqueue(publishMode));
    }
    if (jobErr || !jobId) {
      const msg = jobErr?.message ?? 'the import could not be queued';
      const denied = /insufficient_permission|not_authenticated/i.test(msg);
      return json({ error: msg, site: discovery.site }, denied ? 403 : 500);
    }

    // The job's tenant came from auth_tenant_id() inside the SECURITY DEFINER,
    // which is the AUTHORITATIVE boundary — this read-back is a cross-check on
    // top of it, not the thing enforcing it.
    //
    // ⚠ THE TWO FAILURES BELOW ARE NOT THE SAME AND USED TO SHARE A MESSAGE.
    // The old check was `if (!job || job.tenant_id !== tenantId)`, so a job we
    // simply could not READ reported as "tenant mismatch". That is what a real
    // signed-in owner hit: the job row existed with exactly the right
    // tenant_id, and the import still failed 500 claiming the tenants
    // disagreed. An error that names the wrong cause sends the next person
    // hunting tenant resolution, which is fine here, and never at the read.
    const { data: job, error: jobReadErr } = await admin
      .from('knowledge_ingestion_jobs').select('id, tenant_id').eq('id', jobId).maybeSingle();

    if (job && job.tenant_id !== tenantId) {
      // A GENUINE mismatch. Refuse: reporting on another workspace's rows is
      // the one outcome worth failing the whole import for.
      return json({
        error: 'tenant mismatch while queueing the import',
        job_id: jobId, expected: tenantId, got: job.tenant_id,
      }, 500);
    }

    if (!job) {
      // Could not read back the job we just created. The job IS queued — the
      // RPC returned its id and set its tenant from auth_tenant_id() — and the
      // pg_cron drain will process it either way. Failing here would throw away
      // work that is already safely enqueued, so carry on and say so.
      console.warn('site-import: could not read back job', jobId, jobReadErr?.message ?? '(no row)');
    }

    // ── Run it now, bounded, instead of waiting for the 2-minute cron ──
    const waitDeadline = Date.now() + waitMs;
    let drainPaused = false;
    let rounds = 0;
    while (waitMs > 0 && Date.now() < waitDeadline && rounds < 12) {
      const { count: open } = await admin
        .from('knowledge_ingestion_items')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', jobId).in('status', ['queued', 'running']);
      if (!open) break;
      rounds++;
      const res = await kickDrain(tenantId, waitDeadline - Date.now());
      if (res.paused) { drainPaused = true; break; }
      // A round that processed nothing (items backing off) must not spin.
      if (Date.now() < waitDeadline) await sleep(DRAIN_ROUND_PAUSE_MS);
    }

    // ── Report. Per item, from the queue's own rows — not from what we hoped. ──
    const { data: rows } = await admin
      .from('knowledge_ingestion_items')
      .select('id, source_ref, title, status, last_error, error_kind, doc_id')
      .eq('job_id', jobId);

    // Report in RANK order, not the order Postgres happened to return rows in —
    // the whole point of ranking is that the top of the list is what matters.
    const rankOf = new Map(discovery.ranked.map((p, i) => [p.url, i]));
    const ordered = ((rows ?? []) as ItemRow[]).sort(
      (a, b) => (rankOf.get(a.source_ref) ?? 9999) - (rankOf.get(b.source_ref) ?? 9999));

    const pages = ordered.map((r) => {
      const status: PageStatus =
        r.status === 'succeeded' ? 'imported'
        : r.status === 'skipped_duplicate' ? 'already_in_library'
        : r.status === 'failed' ? 'failed'
        : 'pending';
      return {
        url: r.source_ref,
        title: r.title,
        status,
        doc_id: r.doc_id,
        error: status === 'failed' ? (r.last_error ?? 'unknown error') : null,
        error_kind: status === 'failed' ? r.error_kind : null,
      };
    });

    const count = (s: PageStatus) => pages.filter((p) => p.status === s).length;
    const imported = count('imported');
    const duplicates = count('already_in_library');
    const failed = count('failed');
    const pending = count('pending');

    // Group the discovery-time skips so the human sees WHY the tail was cut.
    const skipCounts: Record<string, number> = {};
    for (const s of discovery.skipped) skipCounts[s.reason] = (skipCounts[s.reason] ?? 0) + 1;

    // ── The sentence a human reads. Partial success stays partial. ──
    const bits: string[] = [];
    bits.push(`Imported ${imported} of ${pages.length} pages from ${new URL(discovery.site).hostname}`);
    if (publishMode === 'draft') bits.push('as drafts awaiting review');
    const tail: string[] = [];
    if (duplicates) tail.push(`${duplicates} ${duplicates === 1 ? 'was' : 'were'} already in your library`);
    if (failed) {
      const firstErr = pages.find((p) => p.status === 'failed')?.error ?? '';
      tail.push(`${failed} failed${firstErr ? ` (e.g. ${firstErr.slice(0, 120)})` : ''}`);
    }
    if (pending) {
      tail.push(drainPaused
        ? `${pending} ${pending === 1 ? 'is' : 'are'} queued — knowledge ingestion is currently paused by an administrator`
        : `${pending} ${pending === 1 ? 'is' : 'are'} still importing in the background and will finish within a couple of minutes`);
    }
    if (skipCounts.over_max_pages) {
      tail.push(`${skipCounts.over_max_pages} more pages were found but ranked below your limit of ${maxPages}`);
    }
    if (skipCounts.login_or_cart) tail.push(`${skipCounts.login_or_cart} sign-in/checkout pages were skipped`);
    if (skipCounts.already_imported) tail.push(`${skipCounts.already_imported} were skipped as already imported`);
    const message = bits.join(' ') + (tail.length ? `. ${tail.join('; ')}.` : '.');

    return json({
      ok: true,
      site: discovery.site,
      job_id: jobId,
      publish_mode: publishMode,
      // How the pages were found — 'homepage-links' means the site had no
      // usable sitemap, which is worth telling the human because the coverage
      // is then only as good as the site's own navigation.
      discovery: {
        method: discovery.method,
        found: discovery.found,
        queued: pages.length,
        max_pages: maxPages,
        skipped_counts: skipCounts,
        skipped: discovery.skipped.slice(0, 50).map((s) => ({
          url: s.url, reason: s.reason, explanation: SKIP_EXPLANATION[s.reason],
        })),
        notes: discovery.notes.slice(0, 20),
      },
      summary: { imported, already_in_library: duplicates, failed, pending, total: pages.length },
      pages,
      // Honest even when everything went right: the queue is still the owner of
      // the remaining work, and this is where the human watches it.
      still_running: pending > 0,
      elapsed_ms: Date.now() - started,
      message,
    });
  } catch (err) {
    console.error('site-import error:', err);
    await reportEdgeError('site-import', err, {});
    return json({ error: `site import failed: ${String((err as Error)?.message ?? err).slice(0, 200)}` }, 500);
  }
});
