/**
 * de-eval-online — continuous online evals (Frontier-20 #2).
 *
 * Samples recently-delivered real answers (sample_messages_for_online_eval,
 * mig 168), scores each with the LLM judge (eval-judge), persists an
 * eval_judgments row tagged source='online' + message_id (deduped). When a
 * DE's recent online fail-rate crosses a threshold, writes an
 * activity_event flagging quality drift for the Insights/trust surfaces —
 * it does NOT auto-demote trust (that stays evidence-based + human-owned).
 *
 * Cost-bounded: hard sample cap per run; eval-judge itself is budget-gated
 * and metered. Auth: dispatch secret or service role (worker/cron).
 * POST { tenant_id?, limit?, window_minutes? } -> { judged, flagged }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const MAX_SAMPLE = 8;         // hard cap per run — cost guard
const FAIL_RATE_ALERT = 40;   // % over the recent window to flag drift
const MIN_N_FOR_ALERT = 5;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!((dispatch && req.headers.get('x-dispatch-secret') === dispatch) || bearer === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))) {
      return json({ error: 'unauthorized' }, 401);
    }
    const body = await req.json().catch(() => ({}));
    const limit = Math.min(MAX_SAMPLE, Number(body.limit) || MAX_SAMPLE);
    const secret = dispatch;

    const { data: samples } = await admin.rpc('sample_messages_for_online_eval', {
      p_limit: limit, p_window_minutes: Number(body.window_minutes) || 90, p_tenant_id: body.tenant_id ?? null,
    });
    const rows = (samples ?? []) as Array<{ message_id: string; tenant_id: string; de_id: string; conversation_id: string; question: string; answer: string }>;

    let judged = 0;
    const touchedDe = new Set<string>();
    for (const r of rows) {
      try {
        const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/eval-judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dispatch-secret': secret, Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! },
          body: JSON.stringify({ tenant_id: r.tenant_id, de_id: r.de_id, question: r.question, answer: r.answer, source: 'online', persist: true }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && !j.error) { judged++; touchedDe.add(`${r.tenant_id}:${r.de_id}`); }
        // Attach the message_id after the fact (eval-judge persists without it).
        if (j.judgment_id) await admin.from('eval_judgments').update({ message_id: r.message_id }).eq('id', j.judgment_id);
      } catch (e) { console.error('online judge:', e); }
    }

    // Drift flag per touched DE.
    let flagged = 0;
    for (const key of touchedDe) {
      const [tenantId, deId] = key.split(':');
      const { data: q } = await admin.rpc('de_eval_quality', { p_tenant_id: tenantId, p_de_id: deId, p_days: 1 });
      if (q && Number(q.n) >= MIN_N_FOR_ALERT && Number(q.fail_rate) >= FAIL_RATE_ALERT) {
        const { data: de } = await admin.from('digital_employees').select('name, persona_name').eq('id', deId).maybeSingle();
        await admin.from('activity_events').insert({
          tenant_id: tenantId, actor: de?.persona_name || de?.name || 'DE', actor_type: 'system', event_type: 'quality_drift',
          text: `Online quality check flagged ${de?.persona_name || de?.name || 'this employee'}: ${q.fail_rate}% of recently sampled answers failed review (avg score ${q.avg_score}). Review recent conversations and consider re-certifying.`,
          confidence: Number(q.avg_score) || 0,
        });
        flagged++;
      }
    }

    return json({ judged, flagged, sampled: rows.length });
  } catch (err) {
    console.error('de-eval-online error:', err);
    return json({ error: String(err) }, 500);
  }
});
