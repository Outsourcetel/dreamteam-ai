/**
 * de-improve — verified self-improvement loop (Frontier-20 #5).
 *
 * A production failure becomes a HUMAN-APPROVED knowledge fix, with proof:
 *   1. Failure signal: a failed eval_judgments row (online sampling, a
 *      simulation, or an explicit judgment_id).
 *   2. Propose: the LLM drafts a knowledge article that would have made the
 *      answer correct, grounded in the judge's rationale + existing KB docs.
 *   3. Replay (the "verified" part): re-answer the failing question WITH the
 *      patch via de-answer replay mode (zero side effects), re-judge it, AND
 *      run the golden set with vs without the patch (both sim_runs flagged
 *      candidate=true — mig 172 bars them from certification evidence).
 *   4. Gate: only if the failing answer now PASSES and the golden pass-count
 *      did not regress does a human_tasks 'knowledge_revision' review open.
 *   5. Apply: apply_improvement (SQL, mig 172) publishes the article scoped
 *      to the DE — and hard-refuses unless the review task is APPROVED.
 *
 * The DE never edits its own knowledge silently: the ONLY write path is the
 * approval-gated RPC. This function stops at "review opened".
 *
 * POST { tenant_id, de_id?, judgment_id? }
 *   -> { improvement_id, status: 'review_pending'|'failed_replay', replay, human_task_id? }
 * Auth: dispatch secret or tenant-member JWT. Budget-gated.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { wrapUntrusted, FIREWALL_RULES } from '../_shared/injectionSafety.ts';
import { getAIKey } from '../_shared/aiKeys.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const GOLDEN_COUNT = 2;   // regression sample per side (with/without) — cost-bounded

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id } = body;
    if (!tenant_id) return json({ error: 'tenant_id required' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const isDispatch = dispatch && req.headers.get('x-dispatch-secret') === dispatch;
    if (!isDispatch) {
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const { data: u } = await admin.auth.getUser(jwt);
      if (!u?.user) return json({ error: 'unauthorized' }, 401);
      const { data: prof } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', u.user.id).maybeSingle();
      const resolvedTenant = await resolveTenantWithRemoteAccess(admin, u.user.id, prof?.tenant_id, prof?.layer, tenant_id);
      if (resolvedTenant !== tenant_id) return json({ error: 'forbidden' }, 403);
    }

    const apiKey = await getAIKey(admin, 'ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'llm_not_configured' }, 503);
    const { data: budget } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenant_id });
    if (budget && budget.allowed === false) return json({ error: 'ai_budget_exceeded' }, 429);

    // ── 1) the failure ──
    // Improvement-worthy = below-standard, not only catastrophic: a
    // 'partial' scoring under 70 is a documented quality gap the judge
    // explained — exactly what a knowledge patch fixes. (Live-proof
    // finding: a DE whose answers improved from fail to partial fell out
    // of the loop entirely under the old fail-only filter.)
    let jq = admin.from('eval_judgments')
      .select('id, de_id, question, answer, rationale, score, reference, verdict')
      .eq('tenant_id', tenant_id).in('verdict', ['fail', 'partial']).lt('score', 70)
      .order('created_at', { ascending: false }).limit(10);
    if (body.judgment_id) jq = jq.eq('id', body.judgment_id);
    else if (body.de_id) jq = jq.eq('de_id', body.de_id);
    const { data: fails } = await jq;
    // one improvement per judgment (don't re-propose what's already in flight)
    const { data: seen } = await admin.from('de_improvements').select('judgment_id').eq('tenant_id', tenant_id).not('judgment_id', 'is', null);
    const seenIds = new Set((seen ?? []).map((r: { judgment_id: string }) => r.judgment_id));
    const fail = (fails ?? []).find((f: { id: string; de_id: string | null }) => f.de_id && !seenIds.has(f.id));
    if (!fail) return json({ error: 'no_unhandled_failed_judgment' }, 404);
    const deId = fail.de_id as string;

    // ── 2) propose a patch, grounded in the rationale + current KB ──
    const { data: kb } = await admin.rpc('hybrid_match_knowledge', {
      p_tenant_id: tenant_id, p_query_text: fail.question, p_account_id: null,
      p_query_embedding: null, p_match_count: 3, p_subject_kind: 'de', p_subject_id: deId,
    });
    const kbContext = (kb ?? []).map((c: { doc_title: string; content: string }) =>
      `[${c.doc_title}]\n${String(c.content).slice(0, 1500)}`).join('\n---\n') || '(no matching docs)';

    const system = 'You write corrective knowledge-base articles for a customer-support AI. Given a question the AI answered WRONGLY, the judge\'s explanation, and existing docs, write ONE focused article that would make the answer correct. Ground it in the judge\'s explanation of the correct behaviour — do NOT invent facts beyond it. Return ONLY JSON {"title": string, "content": string} (content 3-10 sentences, plain prose).' + FIREWALL_RULES;
    const user = `<failure>\nQuestion: ${wrapUntrusted(String(fail.question), 'eval-question')}\nWrong answer given: ${wrapUntrusted(String(fail.answer ?? ''), 'eval-answer')}\nJudge's explanation: ${wrapUntrusted(String(fail.rationale ?? ''), 'judge-rationale')}\n${fail.reference ? `Reference (known-correct facts): ${wrapUntrusted(String(fail.reference), 'eval-reference')}\n` : ''}</failure>\n\n<existing_docs>\n${wrapUntrusted(kbContext.slice(0, 6000), 'tenant-kb')}\n</existing_docs>`;
    const llm = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 900, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!llm.ok) return json({ error: 'proposal_llm_failed', status: llm.status }, 502);
    const ld = await llm.json();
    const text = (ld.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '';
    let patch: { title?: string; content?: string } = {};
    try { patch = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { /* fallthrough */ }
    if (!patch.title || !patch.content) return json({ error: 'proposal_parse_failed' }, 502);

    const { data: impRow, error: impErr } = await admin.from('de_improvements').insert({
      tenant_id, de_id: deId, judgment_id: fail.id,
      failure_question: fail.question, failure_answer: fail.answer ?? '', failure_rationale: fail.rationale ?? '',
      proposed_title: String(patch.title).slice(0, 200), proposed_content: String(patch.content).slice(0, 8000),
    }).select('id').single();
    if (impErr || !impRow) return json({ error: `improvement_insert_failed: ${impErr?.message ?? 'no row'}` }, 500);
    const impId = impRow.id;

    // ── 3) replay: the failing question WITH the patch, re-judged ──
    const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const base = Deno.env.get('SUPABASE_URL');
    const ar = await fetch(`${base}/functions/v1/de-answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anon, 'x-dispatch-secret': dispatch, Authorization: `Bearer ${anon}` },
      body: JSON.stringify({ question: fail.question, tenant_id, de_id: deId, candidate_knowledge: patch.content }),
    });
    const aj = await ar.json().catch(() => ({}));
    const newAnswer = aj.answer ?? '';
    let after: { score: number; verdict: string } = { score: 0, verdict: 'fail' };
    if (newAnswer) {
      const jr = await fetch(`${base}/functions/v1/eval-judge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dispatch-secret': dispatch, apikey: svc, Authorization: `Bearer ${svc}` },
        body: JSON.stringify({ tenant_id, de_id: deId, question: fail.question, answer: newAnswer, reference: fail.reference ?? fail.rationale, source: 'simulation', persist: false }),
      });
      const jj = await jr.json().catch(() => ({}));
      if (!jj.error) after = { score: Number(jj.score) || 0, verdict: jj.verdict ?? 'fail' };
    }

    // golden regression: with vs without the patch (both candidate dry-runs)
    const simCall = async (withPatch: boolean) => {
      const r = await fetch(`${base}/functions/v1/de-simulate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anon, 'x-dispatch-secret': dispatch, Authorization: `Bearer ${anon}` },
        body: JSON.stringify({ tenant_id, de_id: deId, mode: 'golden', count: GOLDEN_COUNT, candidate: true, ...(withPatch ? { candidate_knowledge: patch.content } : {}) }),
      });
      return await r.json().catch(() => ({}));
    };
    const [withP, withoutP] = [await simCall(true), await simCall(false)];
    // Regression check — FAIL CLOSED (consolidation-review finding): the
    // comparison passes only when BOTH sims genuinely completed. The single
    // honest skip is "this tenant has no golden set" (both sides agree);
    // any error, budget refusal, or blocked_llm on either side counts as a
    // failed replay — never as silent evidence of safety.
    const completed = (r: { error?: string; status?: string }) => !r.error && (r.status === 'passed' || r.status === 'failed');
    const noGolden = (r: { error?: string }) => r.error === 'no_golden_qa';
    let goldenOk: boolean;
    let goldenRecord: Record<string, unknown>;
    if (completed(withP) && completed(withoutP)) {
      goldenOk = Number(withP.passed ?? 0) >= Number(withoutP.passed ?? 0);
      goldenRecord = { with_patch: withP.passed, without_patch: withoutP.passed, total: withP.total, sim_run_id: withP.sim_run_id, baseline_sim_run_id: withoutP.sim_run_id };
    } else if (noGolden(withP) && noGolden(withoutP)) {
      goldenOk = true;   // honestly no golden set — the direct replay is the whole evidence
      goldenRecord = { skipped: 'no_golden_qa' };
    } else {
      goldenOk = false;  // fail closed
      goldenRecord = { failed_closed: true, with_patch: withP.error ?? withP.status ?? 'unknown', without_patch: withoutP.error ?? withoutP.status ?? 'unknown' };
    }

    const replay = {
      before: { score: Number(fail.score) || 0, verdict: String(fail.verdict ?? 'fail') },
      after,
      answer_preview: newAnswer.slice(0, 400),
      golden: goldenRecord,
    };
    // A patch earns HUMAN review on demonstrated improvement, not only
    // perfection (live-proof refinement): full pass, OR a better score on
    // the failing question, OR strict golden-set improvement — and never
    // when the answer still outright fails or the golden set regressed.
    // The human approval remains the final gate either way.
    const goldenStrictlyImproved = completed(withP) && completed(withoutP)
      && Number(withP.passed ?? 0) > Number(withoutP.passed ?? 0);
    const passed = goldenOk && after.verdict !== 'fail'
      && (after.verdict === 'pass' || after.score > (Number(fail.score) || 0) || goldenStrictlyImproved);
    await admin.rpc('record_improvement_replay', { p_improvement_id: impId, p_replay: replay, p_passed: passed });

    // ── 4) only a PROVEN patch reaches a human ──
    if (!passed) return json({ improvement_id: impId, status: 'failed_replay', replay });
    const { data: taskId, error: revErr } = await admin.rpc('create_improvement_review', { p_improvement_id: impId });
    if (revErr) return json({ error: revErr.message, improvement_id: impId }, 500);
    return json({ improvement_id: impId, status: 'review_pending', human_task_id: taskId, replay });
  } catch (err) {
    console.error('de-improve error:', err);
    return json({ error: String(err) }, 500);
  }
});
