/**
 * de-orchestrate — multi-agent orchestration with shared context
 * (Frontier-20 #10).
 *
 * A supervisor DE receives a question and either answers it or routes it
 * to the best-suited teammate — ON THE SAME CONVERSATION THREAD, so
 * conversation-scoped memory (mig 155, already recalled+written by
 * de-answer) is shared context: the teammate sees what the thread already
 * established, and the supervisor remembers who handled what.
 *
 * ⚠⚠⚠ WHO OUTRANKS WHOM (mig 760 fix round, founder ruling R2):
 *   THE CUSTOMER'S TOPIC OWNER BEATS THE AI ROUTER. Where a support triage
 *   rule names the employee who answers this kind of question, that employee
 *   answers and the supervisor's model call never happens. The router chooses
 *   ONLY where no topic matched. Before this, the model's responsibility-fit
 *   judgement silently overrode the person the customer named in the interview,
 *   because this function always calls de-answer with `de_id: chosen` and a
 *   named employee wins in there. Dormant — is_supervisor is false on all 109
 *   employees across all 18 tenants — which is exactly why it is pinned.
 *
 * Governance is inherited, not reinvented:
 *   • The routing graph IS the consultation allow-list
 *     (de_consultation_grants, mig 111) — a supervisor can only route to
 *     teammates a human explicitly granted. No grants → no routing. It bounds
 *     what the SUPERVISOR may pick; it does not bound the customer's own
 *     triage rule, which is a human instruction rather than a model's choice.
 *   • The chosen DE answers through de-answer: its own persona, model,
 *     guardrails, confidence, escalation, budgets. Routing never widens
 *     authority — it only picks WHICH governed employee responds.
 *   • Routing itself is a cheap model call (haiku, mig-163 economics),
 *     with the question firewalled as untrusted content (#9).
 *   • Paused/retired teammates are never candidates (lifecycle rule).
 *
 * POST { tenant_id, supervisor_de_id, question, conversation_id?, channel? }
 *   -> { answer, confidence, sources, needs_escalation, conversation_id,
 *        handled_by: { de_id, name }, routed, route_reason }
 * Auth: dispatch secret or tenant-member JWT (frontend-callable).
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { hasLLMProvider, llmMessages } from '../_shared/llm.ts';
import { wrapUntrusted, FIREWALL_RULES } from '../_shared/injectionSafety.ts';
import { embedText } from '../_shared/knowledgeEmbed.ts';
import { loadTenantGate } from '../_shared/tenantStatus.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';
import { budgetBlocked } from '../_shared/rpcSafety.ts';
import { classifyAndRoute, routerMayChoose } from '../_shared/topicRouting.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const ROUTING_MODEL = 'claude-haiku-4-5';
const INELIGIBLE = ['paused', 'retired', 'archived'];

// One de-answer caller. de-answer returns llm_not_configured / ai_budget_exceeded
// as HTTP 200 with an `error` field, and 402 on suspension — so callers must
// propagate ITS status, never flatten to 502 (which would mis-tell the client
// the transport failed).
async function callDeAnswer(body: Record<string, unknown>): Promise<{ r: Response; j: Record<string, unknown> }> {
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/de-answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: svc, Authorization: `Bearer ${svc}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({} as Record<string, unknown>));
  return { r, j };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, question, conversation_id, de_id: passthroughDeId, channel } = body;
    const bodySupervisor = typeof body.supervisor_de_id === 'string' && body.supervisor_de_id ? body.supervisor_de_id : null;
    if (!tenant_id) return json({ error: 'tenant_id required' }, 400);
    if (!question || typeof question !== 'string') return json({ error: 'question required' }, 400);

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

    // Resolve the supervisor: explicit body value, else the tenant's designated
    // is_supervisor DE. No supervisor configured → byte-identical to today's
    // direct de-answer (no routing spend, no trace, no supervisor memory).
    let supervisor_de_id: string;
    {
      let resolved: string | null = bodySupervisor;
      if (!resolved) {
        const { data: supRow } = await admin.from('digital_employees')
          .select('id').eq('tenant_id', tenant_id).eq('is_supervisor', true)
          .not('lifecycle_status', 'in', '(paused,retired,archived)').maybeSingle();
        resolved = supRow?.id ?? null;
      }
      if (!resolved) {
        const { r, j } = await callDeAnswer({
          question, tenant_id,
          ...(typeof passthroughDeId === 'string' && passthroughDeId ? { de_id: passthroughDeId } : {}),
          ...(conversation_id ? { conversation_id } : {}),
          ...(channel ? { channel } : {}),
        });
        if (j.error) return json({ error: j.error, ...(j.conversation_id ? { conversation_id: j.conversation_id } : {}) }, r.status);
        return json({ ...j, routed: false, route_reason: 'no supervisor configured — answered directly',
          handled_by: { de_id: (j.de_id as string) ?? null, name: j.de_name } });
      }
      supervisor_de_id = resolved;
    }

    // Supervisor + its human-granted routing graph.
    const { data: sup } = await admin.from('digital_employees')
      .select('id, name, persona_name, description, lifecycle_status')
      .eq('id', supervisor_de_id).eq('tenant_id', tenant_id).maybeSingle();
    if (!sup) return json({ error: 'supervisor_not_in_tenant' }, 403);
    if (INELIGIBLE.includes(String(sup.lifecycle_status))) return json({ error: 'supervisor_not_active' }, 409);

    const { data: grants } = await admin.from('de_consultation_grants')
      .select('target_de_id')
      .eq('tenant_id', tenant_id).eq('requester_de_id', supervisor_de_id).eq('active', true);
    const targetIds = Array.from(new Set((grants ?? []).map((g: { target_de_id: string }) => g.target_de_id)));
    type Mate = { id: string; name: string; persona_name: string | null; description: string | null; responsibilities: string[] | null; lifecycle_status: string };
    let mates: Mate[] = [];
    if (targetIds.length > 0) {
      // SCOPE CONTAINMENT (docs/31 decision #2, 2026-07-28): the specialist
      // auto-grant gives every DE — supervisors included — a grant to the
      // tenant's Technical Specialist. Consult is the specialist interface;
      // routing an incoming question TO a teammate is a work handoff, so
      // specialists are excluded from the routable roster (is_specialist is
      // NOT NULL, so eq(false) is exact). Same decision as de-work delegation.
      const { data: rows } = await admin.from('digital_employees')
        .select('id, name, persona_name, description, responsibilities, lifecycle_status')
        .in('id', targetIds).eq('tenant_id', tenant_id).eq('is_specialist', false);
      mates = ((rows ?? []) as Mate[]).filter(m => !INELIGIBLE.includes(String(m.lifecycle_status)));
    }

    // ── ⚠⚠⚠ THE CUSTOMER'S TOPIC OWNER BEATS THE AI ROUTER (mig 760 FIX
    // ROUND, R2). Founder ruling, settled.
    //
    // This function always names an employee — `de_id: chosen` on the
    // callDeAnswer below — and a named employee wins inside de-answer. So the
    // day anyone sets `is_supervisor`, an LLM's responsibility-fit judgement
    // would silently override the owner a customer named in the interview or
    // wrote into Support › Triage rules. The default was AI-overrides-customer.
    //
    // It is DORMANT today: `is_supervisor` is false on all 109 employees across
    // all 18 tenants, so `active_supervisors = 0` and this branch is only ever
    // reached after somebody deliberately designates a supervisor. That is
    // precisely why the precedence is written down and pinned rather than left
    // to be discovered the first time the router wakes up.
    //
    // THE ROUTER CHOOSES ONLY WHERE NO TOPIC MATCHED, and the classification is
    // cheap SQL (classify_support_text), so a matched topic also SAVES the
    // haiku call rather than costing one.
    //
    // ⚠ SAME CHANNEL RULE AS de-answer, DERIVED THE SAME WAY. de-answer maps a
    // missing/unknown channel to 'dock' (index.ts:426-428) and classifyAndRoute
    // refuses anything outside the five channels the triage trigger accepts, so
    // this consults a topic for exactly the traffic de-answer would have
    // classified — and for `exam`, neither does.
    //
    // ⚠ AND WHAT IT DELIBERATELY DOES *NOT* DO. The topic owner is not filtered
    // through `de_consultation_grants`. That list governs what a SUPERVISOR may
    // pick; a topic owner is a human instruction, resolved by the database with
    // the tenant, lifecycle and Workspace-Assistant filters already applied, and
    // routing "never widens authority — it only picks WHICH governed employee
    // responds" (this file's own header): the chosen employee still answers
    // through de-answer under its own persona, guardrails, floors and budgets.
    //
    // ⚠ THE MONEY GATES BELOW ARE NOT SKIPPED, THEY ARE NOT NEEDED. They guard
    // the haiku routing call, and a matched topic does not make one:
    // classify_support_text is free SQL. The suspension refusal, the tenant AI
    // budget and the ANSWERING employee's budget are all enforced again inside
    // de-answer — a suspended workspace still comes back 402
    // {error:'tenant_suspended'}, propagated verbatim by the `aj.error` line
    // below. What is genuinely not charged is the SUPERVISOR's own per-DE
    // budget, because the supervisor did not do any paid work.
    // ⚠⚠⚠ AND NOT ON A THREAD THAT ALREADY EXISTS — the founder's R1 rule
    // applied to the call site R2 adds, because this is a call site and the
    // rule is about all of them. It matters MORE here than it looks:
    // knowledgeApi.ts:625 sends the request to de-orchestrate rather than
    // de-answer WHENEVER THE TENANT IS KNOWN, which is every portal turn
    // (EndUserChatPage.tsx:190/:259 pass a stored conversationId with de_id
    // null). Classifying here on turn 2 would hand the thread to a topic owner
    // and name them to de-answer, and a named employee beats the row — the
    // exact defect the three writers just closed, arriving through the back
    // door the moment a supervisor exists.
    //
    // The id is not validated first, deliberately: a bogus one is refused by
    // de-answer with 404 conversation_not_found, and "do not classify what you
    // are reusing" needs no round trip to be true.
    //
    // ⚠ WHAT THIS DOES NOT CLOSE, and it predates every part of this work: on a
    // reused thread the SUPERVISOR'S MODEL still routes, so a teammate can
    // still take over mid-thread while de_conversations.de_id stays put. That
    // is de-orchestrate's documented purpose ("the chosen employee answers on
    // the SAME thread (shared memory)") and the founder's ruling did not name
    // it, so it is left exactly as it was and said out loud instead.
    const reusedThread = typeof conversation_id === 'string' && !!conversation_id;
    const convChannel = channel === 'exam' ? 'exam' : channel === 'portal' ? 'portal' : 'dock';
    const topicRouted = reusedThread
      ? { triage: null, owner: null }
      : await classifyAndRoute(admin, tenant_id, String(question), convChannel);

    // Routing decision — only when there is somewhere to route.
    let chosen = supervisor_de_id as string;
    let routeReason = 'no teammates granted — answered directly';
    if (!routerMayChoose(topicRouted)) {
      chosen = topicRouted.owner!.id;
      routeReason = 'this workspace named an employee for this topic in Support › Triage rules — the supervisor did not choose';
    } else if (mates.length > 0) {
      // Suspended tenant does no paid AI work — refuse BEFORE the routing call.
      const gate = await loadTenantGate(admin, tenant_id);
      if (gate.suspended) return json({ error: 'tenant_suspended' }, 402);
      if (!(await hasLLMProvider(admin))) return json({ error: 'llm_not_configured' }, 503);
      const { data: budget, error: budgetErr } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenant_id });
      if (budgetBlocked(budgetErr, budget)) return json({ error: 'ai_budget_exceeded' }, 429);
      // Also honor the SUPERVISOR's own per-DE budget — routing is paid AI work
      // charged to it (audit: was tenant-only, so an over-ceiling supervisor still
      // paid for every routing call).
      const { data: deBudget, error: deBudgetErr } = await admin.rpc('check_de_budget', { p_de_id: supervisor_de_id });
      if (budgetBlocked(deBudgetErr, deBudget)) return json({ error: 'de_budget_exceeded' }, 429);

      const roster = [
        `0. ${sup.persona_name || sup.name} (the supervisor — you): ${sup.description ?? ''}`,
        ...mates.map((m, i) => `${i + 1}. ${m.persona_name || m.name}: ${m.description ?? ''} Responsibilities: ${(m.responsibilities ?? []).join('; ')}`),
      ].join('\n');
      const system = 'You are a team supervisor routing an incoming question to the best-suited team member. Pick BY RESPONSIBILITY FIT — choose 0 (yourself) when the question fits you best or fits nobody clearly. Return ONLY JSON {"route_to": number, "reason": string(short)}.' + FIREWALL_RULES;
      const res = await llmMessages(admin, { model: ROUTING_MODEL, max_tokens: 200, system, messages: [{ role: 'user', content: `Team:\n${roster}\n\nIncoming question:\n${wrapUntrusted(question, 'customer-question')}` }] }, 'de-orchestrate');
      if (res.ok) {
        const d = await res.json();
        await admin.rpc('record_de_token_usage', { p_tenant_id: tenant_id, p_de_id: supervisor_de_id, p_model_id: ROUTING_MODEL, p_input_tokens: Number(d.usage?.input_tokens ?? 0), p_output_tokens: Number(d.usage?.output_tokens ?? 0) });
        const text = (d.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '';
        try {
          const p = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
          const idx = Number(p.route_to);
          if (Number.isInteger(idx) && idx >= 1 && idx <= mates.length) {
            chosen = mates[idx - 1].id;
            routeReason = String(p.reason ?? 'best responsibility fit').slice(0, 300);
          } else {
            routeReason = String(p.reason ?? 'supervisor best fit').slice(0, 300);
          }
        } catch { routeReason = 'routing parse failed — answered directly'; }
      } else {
        routeReason = 'routing unavailable — answered directly';
      }
    }

    // The chosen employee answers on the SAME thread (shared memory).
    const { r: ar, j: aj } = await callDeAnswer({ question, tenant_id, de_id: chosen, ...(conversation_id ? { conversation_id } : {}), ...(channel ? { channel } : {}) });
    if (aj.error) return json({ error: aj.error, ...(aj.conversation_id ? { conversation_id: aj.conversation_id } : {}) }, ar.status >= 400 ? ar.status : 200);

    const routed = chosen !== supervisor_de_id;
    const mate = mates.find(m => m.id === chosen);

    // Trace + supervisor memory: the supervisor stays aware of the thread
    // even when a teammate handled it (shared context both directions).
    await admin.from('de_decision_trace').insert({
      tenant_id, de_id: supervisor_de_id, run_kind: 'consult', run_ref: aj.conversation_id ?? null, seq: 0,
      tool: 'route_question', inputs: { question: question.slice(0, 300) },
      outputs: { routed, handled_by: aj.de_name, reason: routeReason },
    });
    if (routed && aj.conversation_id) {
      try {
        const memEmb = await embedText(`Routed: ${question}`.slice(0, 1500));
        await admin.rpc('de_memory_write_internal', {
          p_tenant_id: tenant_id, p_de_id: supervisor_de_id,
          p_content: `I routed "${question.slice(0, 200)}" to ${aj.de_name} (${routeReason}) — they answered with confidence ${aj.confidence}%.`,
          p_embedding: memEmb, p_subject_kind: 'conversation', p_subject_ref: aj.conversation_id,
          p_kind: 'episodic', p_salience: 0.6, p_source: 'de',
        });
      } catch (e) { console.error('supervisor memory:', e); }
    }

    return json({
      answer: aj.answer, confidence: aj.confidence, sources: aj.sources,
      needs_escalation: aj.needs_escalation, conversation_id: aj.conversation_id,
      handled_by: { de_id: chosen, name: aj.de_name },
      routed, route_reason: routeReason,
      ...(aj.blocked ? { blocked: aj.blocked, rule: aj.rule } : {}),
      ...(aj.cached ? { cached: aj.cached } : {}),
      ...(aj.no_docs ? { no_docs: aj.no_docs } : {}),
      ...(aj.draft_id ? { draft_id: aj.draft_id } : {}),
    });
  } catch (err) {
    console.error('de-orchestrate error:', err);
    await reportEdgeError('de-orchestrate', err, {});
    return json({ error: String(err) }, 500);
  }
});
