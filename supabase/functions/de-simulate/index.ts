/**
 * de-simulate — simulation studio (Frontier-20 #3).
 *
 * Runs a scenario set through a DE and scores every answer with the LLM
 * judge (eval-judge), producing a certification-grade sim_run (mig 170)
 * BEFORE the DE goes customer-facing. Modes:
 *   golden     — the tenant's golden_qa (expected_fragments = judge reference)
 *   synthetic  — LLM-generated realistic customer questions for the DE's role
 *   historical — real past customer questions for this tenant
 * Each scenario: de-answer (the DE's real governed answer) → eval-judge
 * (grounding/correctness/guardrail/tone). Aggregate pass-rate → sim_run;
 * a passing run can satisfy the go-live gate via certify_de_from_sim.
 *
 * v1 tests the DE's CURRENT config (de-answer answers from live config).
 * Candidate-config diffing (test a proposed change pre-apply) needs a
 * de-answer config-override — a follow-up. Pre-go-live value holds because
 * the cert gate blocks customer-facing stages until a sim passes.
 *
 * Cost/wall-clock bounded: hard count cap; sequential; budget-gated at
 * both de-answer and eval-judge. Auth: dispatch secret or tenant-member JWT.
 * POST { tenant_id, de_id, mode?, count? } -> { sim_run_id, status, passed, total, avg_score }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { hasLLMProvider, llmMessages } from '../_shared/llm.ts';
import { wrapUntrusted, FIREWALL_RULES } from '../_shared/injectionSafety.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const MAX_COUNT = 5;
// Dreaming (#12): a HISTORICAL rehearsal replays real past traffic at
// scale before go-live — higher cap than ad-hoc sims, still hard-bounded
// (each scenario is one budget-gated de-answer + one judge call).
const MAX_COUNT_HISTORICAL = 20;
const PASS_THRESHOLD = 80;

async function scenarioQuestions(admin: SupabaseClient, tenantId: string, deId: string, mode: string, count: number): Promise<Array<{ question: string; reference: string | null }>> {
  if (mode === 'golden') {
    const { data } = await admin.from('golden_qa').select('question, expected_fragments').eq('tenant_id', tenantId).eq('active', true).limit(count);
    return (data ?? []).map((g: { question: string; expected_fragments: string[] }) => ({ question: g.question, reference: Array.isArray(g.expected_fragments) && g.expected_fragments.length ? `Key facts the answer should contain: ${g.expected_fragments.join('; ')}` : null }));
  }
  if (mode === 'historical') {
    // Dreaming (#12): fetch a WIDE recent slice, dedupe, then evenly-spaced
    // subsample — the rehearsal covers the variety of real traffic across
    // the window, not just whatever arrived in the last hour.
    const { data } = await admin.from('de_messages').select('content, conversation_id, de_conversations!inner(de_id, tenant_id)')
      .eq('role', 'user').eq('de_conversations.tenant_id', tenantId).eq('de_conversations.de_id', deId)
      .order('created_at', { ascending: false }).limit(Math.max(count * 3, 60));
    const seen = new Set<string>(); const pool: string[] = [];
    for (const r of (data ?? []) as Array<{ content: string }>) {
      const q = (r.content ?? '').trim();
      if (q.length > 8 && !seen.has(q.toLowerCase())) { seen.add(q.toLowerCase()); pool.push(q); }
    }
    if (pool.length <= count) return pool.map((q) => ({ question: q, reference: null }));
    const step = pool.length / count;
    return Array.from({ length: count }, (_, i) => ({ question: pool[Math.floor(i * step)], reference: null }));
  }
  // synthetic — LLM generates realistic customer questions from the DE's role.
  const { data: de } = await admin.from('digital_employees').select('name, description, department, responsibilities').eq('id', deId).maybeSingle();
  const system = 'You generate realistic first-person CUSTOMER questions to stress-test a support AI. Return ONLY JSON {"questions":[string,...]}. Mix easy, ambiguous, out-of-scope, and edge cases. No preamble.' + FIREWALL_RULES;
  const user = `The AI employee profile:\n${wrapUntrusted(
    `Name: ${de?.name ?? 'Support agent'} (${de?.department ?? 'Support'}). Role: ${de?.description ?? 'answers customer questions'}. Responsibilities: ${(de?.responsibilities ?? []).join(', ')}`,
    'de-profile',
  )}\nGenerate ${count} distinct customer questions.`;
  const res = await llmMessages(admin, { model: 'claude-sonnet-5', max_tokens: 800, system, messages: [{ role: 'user', content: user }] }, 'de-simulate');
  if (!res.ok) return [];
  const d = await res.json();
  const text = (d.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '';
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  try { const p = JSON.parse(text.slice(a, b + 1)); return (Array.isArray(p.questions) ? p.questions : []).slice(0, count).map((q: string) => ({ question: String(q), reference: null })); }
  catch { return []; }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, de_id } = body;
    if (!tenant_id || !de_id) return json({ error: 'tenant_id and de_id required' }, 400);
    const mode = ['golden', 'synthetic', 'historical'].includes(body.mode) ? body.mode : 'synthetic';
    const count = Math.min(mode === 'historical' ? MAX_COUNT_HISTORICAL : MAX_COUNT, Math.max(1, Number(body.count) || 3));
    // Optional candidate patch (Frontier-20 #5): when present, every scenario
    // is answered WITH the proposed knowledge injected (de-answer replay mode),
    // so a regression check can compare golden pass-rate with vs without it.
    const candidateKnowledge = typeof body.candidate_knowledge === 'string' ? body.candidate_knowledge.trim() : '';
    // candidate=true marks a dry-run (patch replay or its baseline comparison):
    // certify_de_from_sim (mig 172) refuses candidate runs as cert evidence.
    const isCandidate = candidateKnowledge.length > 0 || body.candidate === true;

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const isDispatch = dispatch && req.headers.get('x-dispatch-secret') === dispatch;
    if (!isDispatch) {
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const { data: u } = await admin.auth.getUser(jwt);
      if (!u?.user) return json({ error: 'unauthorized' }, 401);
      const { data: prof } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', u.user.id).maybeSingle();
      if (!(prof?.layer === 'platform' || prof?.tenant_id === tenant_id)) return json({ error: 'forbidden' }, 403);
    }

    // The DE must belong to the asserted tenant — the auth block only proves
    // the CALLER's tenant, and every query below runs on the RLS-bypassing
    // service client (consolidation-review: cross-tenant DE metadata leak).
    const { data: simDe } = await admin.from('digital_employees')
      .select('id').eq('id', de_id).eq('tenant_id', tenant_id).maybeSingle();
    if (!simDe) return json({ error: 'de_not_in_tenant' }, 403);

    if (!(await hasLLMProvider(admin))) return json({ error: 'llm_not_configured' }, 503);
    const { data: budget } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenant_id });
    if (budget && budget.allowed === false) return json({ error: 'ai_budget_exceeded' }, 429);

    const scenarios = await scenarioQuestions(admin, tenant_id, de_id, mode, count);
    if (scenarios.length === 0) return json({ error: mode === 'historical' ? 'no_historical_questions' : mode === 'golden' ? 'no_golden_qa' : 'scenario_generation_failed' }, 400);

    // The run records the config fingerprint it TESTS (mig 181): a cert
    // minted from this run vouches for this exact config — running under
    // config A then certifying config B no longer launders staleness.
    const { data: fp } = await admin.rpc('de_config_fingerprint', { p_de_id: de_id });
    const { data: run } = await admin.from('sim_runs').insert({ tenant_id, de_id, mode, status: 'running', total: scenarios.length, threshold_pct: PASS_THRESHOLD, candidate: isCandidate, config_fingerprint: fp ?? null }).select('id').single();
    const simRunId = run.id;
    const secret = dispatch;
    const results: Array<Record<string, unknown>> = [];

    for (const sc of scenarios) {
      // 1) the DE's real governed answer
      let answer = '', blockedLlm = false;
      try {
        const ar = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/de-answer`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '', 'x-dispatch-secret': secret, Authorization: `Bearer ${Deno.env.get('SUPABASE_ANON_KEY') ?? ''}` },
          body: JSON.stringify({ question: sc.question, tenant_id, de_id, ...(candidateKnowledge ? { candidate_knowledge: candidateKnowledge } : {}) }),
        });
        const aj = await ar.json().catch(() => ({}));
        if (aj.error === 'llm_not_configured') { blockedLlm = true; }
        answer = aj.answer ?? '';
      } catch { answer = ''; }
      if (blockedLlm) { await admin.from('sim_runs').update({ status: 'blocked_llm', finished_at: new Date().toISOString() }).eq('id', simRunId); return json({ sim_run_id: simRunId, status: 'blocked_llm' }); }

      // 2) judge it
      let verdict = 'fail', score = 0, dimensions = {}, rationale = 'no answer';
      if (answer) {
        try {
          const jr = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/eval-judge`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dispatch-secret': secret, apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
            body: JSON.stringify({ tenant_id, de_id, question: sc.question, answer, reference: sc.reference, source: 'simulation', persist: true }),
          });
          const jj = await jr.json().catch(() => ({}));
          if (!jj.error) { verdict = jj.verdict; score = jj.score; dimensions = jj.dimensions; rationale = jj.rationale; }
        } catch { /* keep fail */ }
      }
      results.push({ question: sc.question, answer: answer.slice(0, 1000), verdict, score, dimensions, rationale });
      // progress write so a client can poll
      await admin.from('sim_runs').update({ results }).eq('id', simRunId);
    }

    const passed = results.filter(r => r.verdict === 'pass').length;
    const failed = results.length - passed;
    const avg = results.length ? Math.round(results.reduce((a, r) => a + Number(r.score || 0), 0) / results.length) : 0;
    const passRate = results.length ? (100 * passed / results.length) : 0;
    const status = passRate >= PASS_THRESHOLD ? 'passed' : 'failed';
    await admin.from('sim_runs').update({ passed, failed, avg_score: avg, status, finished_at: new Date().toISOString() }).eq('id', simRunId);

    return json({ sim_run_id: simRunId, status, mode, passed, failed, total: results.length, avg_score: avg });
  } catch (err) {
    console.error('de-simulate error:', err);
    return json({ error: String(err) }, 500);
  }
});
