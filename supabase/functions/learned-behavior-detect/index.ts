/**
 * learned-behavior-detect — migration 103's edge half of automatic
 * learned-behavior detection.
 *
 * Same split as knowledge-gap-detect (070): SQL resolves the worklist
 * (get_unembedded_learned_behavior_candidates), this edge function
 * does the one thing only the edge runtime can do (gte-small
 * embedding), then hands back to SQL
 * (cluster_learned_behavior_candidates) for the actual
 * clustering/promotion logic — no reasoning happens here.
 *
 * Auth: x-dispatch-secret header (pg_cron via pg_net, Vault-held
 * secret, piggybacked on the same 5-minute tick as the other three
 * dispatch jobs) or the service-role key directly.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const DEMO_TENANT_ID = 'a0000000-0000-0000-0000-000000000001';

async function embedText(text: string): Promise<number[] | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const SupabaseAI = (globalThis as any).Supabase?.ai;
    if (!SupabaseAI) return null;
    const session = new SupabaseAI.Session('gte-small');
    const out = await session.run(text, { mean_pool: true, normalize: true });
    const vec = Array.from(out as Iterable<number>);
    return vec.length === 384 ? vec : null;
  } catch (e) {
    console.error('gte-small embedding unavailable:', e);
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
    const authHeader = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const isServiceRole = authHeader === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const isDispatchCron = dispatchSecret !== '' && headerSecret === dispatchSecret;

    if (!isServiceRole && !isDispatchCron) return json({ error: 'unauthorized' }, 401);

    const admin: SupabaseClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: tenants, error: tenantsErr } = await admin
      .from('tenants').select('id').neq('id', DEMO_TENANT_ID).neq('status', 'suspended');
    if (tenantsErr) return json({ error: 'tenants_query_failed', detail: tenantsErr.message }, 500);

    let embedded = 0;
    const clusterResults: Record<string, unknown> = {};

    for (const t of tenants ?? []) {
      const { data: candidates, error: candErr } = await admin
        .rpc('get_unembedded_learned_behavior_candidates', { p_tenant_id: t.id });
      if (candErr) { console.error('candidates error for', t.id, candErr.message); continue; }

      for (const c of (candidates ?? []) as { evidence_run_id: string; inquiry: string }[]) {
        const vec = await embedText(c.inquiry);
        if (!vec) continue;
        const { error: updErr } = await admin
          .from('evidence_runs').update({ inquiry_embedding: vec }).eq('id', c.evidence_run_id);
        if (!updErr) embedded++;
      }

      const { data: clusterResult, error: clusterErr } = await admin
        .rpc('cluster_learned_behavior_candidates', { p_tenant_id: t.id });
      if (clusterErr) { console.error('cluster error for', t.id, clusterErr.message); continue; }
      if (clusterResult && Object.keys(clusterResult).length > 0 && !clusterResult.skipped) {
        clusterResults[t.id] = clusterResult;
      }
    }

    return json({ ok: true, tenants_scanned: (tenants ?? []).length, embedded, clusters: clusterResults });
  } catch (e) {
    console.error('learned-behavior-detect error:', e);
    return json({ error: 'internal_error', detail: String(e) }, 500);
  }
});
