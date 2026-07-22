/**
 * proof-stats — the LIVE numbers behind the public proof page (docs/18 Move 1).
 *
 * Counter-positioning against agent washing only works if every figure on
 * /proof is real, current, and honestly scoped. These counters come from ONE
 * workspace: our own production tenant (we run our company on the product —
 * "I am my customer"). Demo/industry showcase workspaces are deliberately
 * EXCLUDED — synthetic traffic on a proof page would be exactly the fiction
 * the page exists to reject.
 *
 * Aggregate counts only — never message content, customer identity, or
 * anything a public caller shouldn't hold. Public GET, 5-minute cache.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });

const PROOF_TENANT_SLUG = 'outsourcetel-hq';
let cache: { at: number; body: unknown } | null = null;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  try {
    if (cache && Date.now() - cache.at < 300_000) return json(cache.body);
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: tenant } = await admin.from('tenants').select('id').eq('slug', PROOF_TENANT_SLUG).maybeSingle();
    if (!tenant?.id) return json({ ok: false, error: 'proof_tenant_missing' }, 503);
    const t = tenant.id;
    // deno-lint-ignore no-explicit-any
    const count = async (table: string, mod?: (q: any) => any): Promise<number> => {
      let q: any = admin.from(table).select('id', { count: 'exact', head: true }).eq('tenant_id', t);
      if (mod) q = mod(q);
      const { count: c } = await q;
      return c ?? 0;
    };

    const [
      conversations, escalations, guardrailBlocks, certsPassed, certsRun,
      amendmentsAdopted, knowledgeDocs, activeDes, auditEvents, workDone,
    ] = await Promise.all([
      count('de_conversations'),
      count('human_tasks', (q: any) => q.eq('type', 'escalation')),
      count('audit_events', (q: any) => q.eq('category', 'guardrail_block')),
      count('role_certifications', (q: any) => q.eq('status', 'passed')),
      count('role_certifications'),
      count('workforce_entity_amendments', (q: any) => q.in('status', ['applied', 'adopted'])),
      count('knowledge_docs', (q: any) => q.eq('is_current', true)),
      count('digital_employees', (q: any) => q.not('lifecycle_status', 'in', '(paused,retired,archived)')),
      count('audit_events'),
      count('de_work_items', (q: any) => q.eq('status', 'done')),
    ]);

    const body = {
      ok: true,
      scope: 'Live counts from our own production workspace — we run our company on this product. Demo environments are excluded.',
      generated_at: new Date().toISOString(),
      stats: {
        active_digital_employees: activeDes,
        conversations_handled: conversations,
        work_items_completed: workDone,
        escalations_to_humans: escalations,
        guardrail_blocks_enforced: guardrailBlocks,
        certification_exams: { run: certsRun, passed: certsPassed },
        amendments_adopted: amendmentsAdopted,
        knowledge_documents: knowledgeDocs,
        audit_chain_events: auditEvents,
      },
    };
    cache = { at: Date.now(), body };
    return json(body);
  } catch (err) {
    console.error('proof-stats error:', String(err));
    return json({ ok: false, error: 'internal' }, 500);
  }
});
