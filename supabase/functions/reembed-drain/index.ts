/**
 * reembed-drain — forced re-index worker (Knowledge P4, WS7 Class-B).
 *
 * WHY: bulk_reembed_docs (mig 290) flags a set of chunks reembed_pending=true
 * when a workspace forces a re-embed (e.g. after an embedding-model change).
 * This worker recomputes each flagged chunk's gte-small embedding and OVERWRITES
 * it IN PLACE — the old vector is only ever replaced, never blanked, so search
 * never regresses to keyword-only while a re-index is in flight. That is the key
 * difference from a delete→null→re-embed shadow-swap: there is no window where a
 * chunk has no vector.
 *
 * A cron drains the backlog in bounded batches (gte-small OOMs above ~4/call).
 * It is INERT until a tenant opts in: the flag knowledge_reembed (default OFF)
 * gates the enqueue, so with no opt-in there are simply no reembed_pending rows.
 *
 * Kill-switch: platform_config key 'knowledge.reembed_paused' → no-op (mirrors
 * embed-backfill's 'knowledge.embed_paused' brake). Separate keys so pausing a
 * re-index does not stop the null-embedding backfill and vice-versa.
 *
 * Auth: service-role key or x-dispatch-secret (same dual pattern as
 * embed-backfill / ingest-chunks). No user data leaves the function.
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

// Same edge-worker embedding cap as ingest-chunks / embed-backfill.
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

    // Kill-switch for a runaway re-index — the emergency stop that must exist
    // before the enqueue is ever enabled. Flip via platform_config key
    // 'knowledge.reembed_paused'.
    try {
      const { data: pause } = await admin.from('platform_config').select('value').eq('key', 'knowledge.reembed_paused').maybeSingle();
      const v = pause?.value;
      if (v === true || v === 'true' || v === '1' || v === 1) {
        return json({ ok: true, paused: true, processed: 0, embedded: 0, remaining: 0, done: false });
      }
    } catch { /* config table/key absent → not paused */ }

    const body = await req.json().catch(() => ({})) as { tenant_id?: string; limit?: number };
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));

    // Optional tenant scope (fair-share: a cron with no body drains all tenants).
    let docIds: string[] | null = null;
    if (body.tenant_id) {
      const { data: docs } = await admin.from('knowledge_docs').select('id').eq('tenant_id', body.tenant_id);
      docIds = (docs ?? []).map((d) => d.id);
      if (docIds.length === 0) return json({ ok: true, processed: 0, embedded: 0, remaining: 0, done: true });
    }

    // Pull the next batch of chunks flagged for re-embed.
    let q = admin.from('knowledge_doc_chunks').select('id, content').eq('reembed_pending', true).limit(limit);
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
          // In-place overwrite: new vector replaces old, then clear the flag.
          // If the update fails, reembed_pending stays true and a later sweep retries.
          const { error: updErr } = await admin.from('knowledge_doc_chunks')
            .update({ embedding: vec, reembed_pending: false }).eq('id', c.id);
          if (!updErr) embedded++;
        }
        // vec.length !== 384: leave reembed_pending=true; a later sweep retries.
      } catch { /* leave flagged; a later sweep retries it */ }
    }

    // How many still flagged in scope (so the caller/cron knows to run again).
    let rq = admin.from('knowledge_doc_chunks').select('id', { count: 'exact', head: true }).eq('reembed_pending', true);
    if (docIds) rq = rq.in('doc_id', docIds);
    const { count: remaining } = await rq;

    return json({ ok: true, processed, embedded, remaining: remaining ?? 0, done: (remaining ?? 0) === 0 });
  } catch (err) {
    console.error('reembed-drain error:', String(err));
    return json({ error: String(err) }, 500);
  }
});
