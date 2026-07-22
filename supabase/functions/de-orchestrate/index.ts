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
 * Governance is inherited, not reinvented:
 *   • The routing graph IS the consultation allow-list
 *     (de_consultation_grants, mig 111) — a supervisor can only route to
 *     teammates a human explicitly granted. No grants → no routing.
 *   • The chosen DE answers through de-answer: its own persona, model,
 *     guardrails, confidence, escalation, budgets. Routing never widens
 *     authority — it only picks WHICH governed employee responds.
 *   • Routing itself is a cheap model call (haiku, mig-163 economics),
 *     with the question firewalled as untrusted content (#9).
 *   • Paused/retired teammates are never candidates (lifecycle rule).
 *
 * POST { tenant_id, supervisor_de_id, question, conversation_id? }
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const ROUTING_MODEL = 'claude-haiku-4-5';
const INELIGIBLE = ['paused', 'retired', 'archived'];

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, supervisor_de_id, question, conversation_id } = body;
    if (!tenant_id || !supervisor_de_id) return json({ error: 'tenant_id and supervisor_de_id required' }, 400);
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
      const { data: rows } = await admin.from('digital_employees')
        .select('id, name, persona_name, description, responsibilities, lifecycle_status')
        .in('id', targetIds).eq('tenant_id', tenant_id);
      mates = ((rows ?? []) as Mate[]).filter(m => !INELIGIBLE.includes(String(m.lifecycle_status)));
    }

    // Routing decision — only when there is somewhere to route.
    let chosen = supervisor_de_id as string;
    let routeReason = 'no teammates granted — answered directly';
    if (mates.length > 0) {
      if (!(await hasLLMProvider(admin))) return json({ error: 'llm_not_configured' }, 503);
      const { data: budget } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenant_id });
      if (budget && budget.allowed === false) return json({ error: 'ai_budget_exceeded' }, 429);

      const roster = [
        `0. ${sup.persona_name || sup.name} (the supervisor — you): ${sup.description ?? ''}`,
        ...mates.map((m, i) => `${i + 1}. ${m.persona_name || m.name}: ${m.description ?? ''} Responsibilities: ${(m.responsibilities ?? []).join('; ')}`),
      ].join('\n');
      const system = 'You are a team supervisor routing an incoming question to the best-suited team member. Pick BY RESPONSIBILITY FIT — choose 0 (yourself) when the question fits you best or fits nobody clearly. Return ONLY JSON {"route_to": number, "reason": string(short)}.' + FIREWALL_RULES;
      const res = await llmMessages(admin, { model: ROUTING_MODEL, max_tokens: 200, system, messages: [{ role: 'user', content: `Team:\n${roster}\n\nIncoming question:\n${wrapUntrusted(question, 'customer-question')}` }] }, 'de-orchestrate');
      if (res.ok) {
        const d = await res.json();
        admin.rpc('record_de_token_usage', { p_tenant_id: tenant_id, p_de_id: supervisor_de_id, p_model_id: ROUTING_MODEL, p_input_tokens: Number(d.usage?.input_tokens ?? 0), p_output_tokens: Number(d.usage?.output_tokens ?? 0) });
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
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ar = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/de-answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: svc, Authorization: `Bearer ${svc}` },
      body: JSON.stringify({ question, tenant_id, de_id: chosen, ...(conversation_id ? { conversation_id } : {}) }),
    });
    const aj = await ar.json().catch(() => ({}));
    if (aj.error) return json({ error: aj.error }, 502);

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
        await admin.rpc('de_memory_write', {
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
    });
  } catch (err) {
    console.error('de-orchestrate error:', err);
    return json({ error: String(err) }, 500);
  }
});
