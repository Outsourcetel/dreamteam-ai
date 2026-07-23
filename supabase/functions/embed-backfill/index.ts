/**
 * embed-backfill — sweep knowledge_doc_chunks that were stored with a null
 * embedding and embed them, resumably, in bounded batches.
 *
 * WHY: ingest-chunks embeds gte-small in the edge runtime and only embeds a
 * bounded batch per call (a large doc can land with most chunks still null).
 * Those chunks fall back to keyword-only retrieval, silently degrading
 * semantic search. This worker finishes the job — a cron can call it with no
 * body to sweep ALL tenants, or a tenant_id to backfill one, until every
 * chunk is embedded.
 *
 * Auth: service-role key or x-dispatch-secret (same dual pattern as
 * ingest-chunks / knowledge-gap-detect). No user data leaves the function.
 *
 * POST { tenant_id?, limit? }  ->  { processed, embedded, remaining, done }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

// The edge worker can only load gte-small + embed a handful of chunks per
// invocation before hitting its memory/CPU cap (ingest-chunks uses 4).
// Keep batches small and let the cron drain the backlog over many calls.
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 4;   // gte-small in the edge worker OOMs (HTTP 546) above ~4/call

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

    // WS8 kill-switch (P4): a single global brake for mass embedding. Must exist
    // BEFORE caps are lifted / a sync cron is enabled — it's the emergency stop
    // for a runaway re-embed. Flip via: platform_config key 'knowledge.embed_paused'.
    try {
      const { data: pause } = await admin.from('platform_config').select('value').eq('key', 'knowledge.embed_paused').maybeSingle();
      const v = pause?.value;
      if (v === true || v === 'true' || v === '1' || v === 1) {
        return json({ ok: true, paused: true, processed: 0, embedded: 0, remaining: 0, done: false });
      }
    } catch { /* config table/key absent → not paused */ }

    const body = await req.json().catch(() => ({})) as { tenant_id?: string; limit?: number };
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));

    // Which docs are in scope (tenant filter is applied through the doc set).
    let docIds: string[] | null = null;
    if (body.tenant_id) {
      const { data: docs } = await admin.from('knowledge_docs').select('id').eq('tenant_id', body.tenant_id);
      docIds = (docs ?? []).map((d) => d.id);
      if (docIds.length === 0) return json({ ok: true, processed: 0, embedded: 0, remaining: 0, done: true });
    }

    // Pull the next batch of null-embedding chunks.
    let q = admin.from('knowledge_doc_chunks').select('id, content').is('embedding', null).limit(limit);
    if (docIds) q = q.in('doc_id', docIds);
    const { data: pending, error: pErr } = await q;
    if (pErr) return json({ error: pErr.message }, 500);

    let embedded = 0;
    const processed = (pending ?? []).length;
    // deno-lint-ignore no-explicit-any
    const SupabaseAI = (globalThis as any).Supabase?.ai;
    if (!SupabaseAI) return json({ error: 'gte-small unavailable in this runtime' }, 503);
    const session = new SupabaseAI.Session('gte-small');
    for (const c of (pending ?? []) as { id: string; content: string }[]) {
      try {
        const out = await session.run(c.content, { mean_pool: true, normalize: true });
        const vec = Array.from(out as Iterable<number>);
        if (vec.length === 384) {
          const { error: updErr } = await admin.from('knowledge_doc_chunks').update({ embedding: vec }).eq('id', c.id);
          if (!updErr) embedded++;
        }
      } catch { /* leave null; a later sweep retries it */ }
    }

    // How many still null in scope (so the caller/cron knows to run again).
    let rq = admin.from('knowledge_doc_chunks').select('id', { count: 'exact', head: true }).is('embedding', null);
    if (docIds) rq = rq.in('doc_id', docIds);
    const { count: remaining } = await rq;

    return json({ ok: true, processed, embedded, remaining: remaining ?? 0, done: (remaining ?? 0) === 0 });
  } catch (err) {
    console.error('embed-backfill error:', String(err));
    return json({ error: String(err) }, 500);
  }
});
