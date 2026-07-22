// de-mission — Mission Delegation rail (docs/14, founder-approved 2026-07-22).
// One-sentence order → compiled, previewable plan (action 'compile') →
// founder plan-approval in the app → deterministic fan-out into the EXISTING
// objective→case→work-item machinery (action 'approve'). Missions inherit
// every rail (guardrails, trust dial, human gates, audit, metering) and can
// never bypass a gate. Pause/resume/cancel live in SQL (migration 248).
//
// Founder decisions baked in: plan gate ALWAYS; approvals one-by-one;
// budget = SOFT warning only (tenant AI budget stays the hard ceiling).
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAIKey } from '../_shared/aiKeys.ts';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { wrapUntrusted } from '../_shared/injectionSafety.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const DEFAULT_MODEL = 'claude-sonnet-5';
const EST_PER_CASE_USD = 0.08; // honest rough planning figure, labeled as such in UI

// ── Scope whitelist — the ONLY things a compiled scope may query. Fields and
// ops are validated server-side; the LLM proposes, the server disposes.
type ScopeSource = keyof typeof SCOPE_SOURCES;
const SCOPE_SOURCES = {
  customer_accounts: {
    label: (r: Record<string, unknown>) => String(r.name ?? r.id),
    entity_kind: 'customer_account',
    fields: {
      status: ['eq', 'neq', 'in'],
      health_score: ['lt', 'lte', 'gt', 'gte'],
      arr_cents: ['lt', 'lte', 'gt', 'gte'],
      created_at: ['lt', 'gte'],
    } as Record<string, string[]>,
  },
  commercial_agreements: {
    label: (r: Record<string, unknown>) => String(r.title ?? r.name ?? r.id),
    entity_kind: 'commercial_agreement',
    fields: {
      status: ['eq', 'neq', 'in'],
      renewal_date: ['lt', 'lte', 'gt', 'gte'],
      notice_date: ['lt', 'lte', 'gt', 'gte'],
      end_date: ['lt', 'lte', 'gt', 'gte'],
    } as Record<string, string[]>,
  },
} as const;

interface ScopeFilter { field: string; op: string; value: unknown }
interface CompiledScope { source: ScopeSource; filters: ScopeFilter[] }

function validateScope(scope: unknown): { ok: true; scope: CompiledScope } | { ok: false; error: string } {
  const s = scope as CompiledScope | null;
  if (!s || typeof s !== 'object') return { ok: false, error: 'scope_missing' };
  const src = SCOPE_SOURCES[s.source as ScopeSource];
  if (!src) return { ok: false, error: `scope_source_not_allowed:${String((s as { source?: unknown }).source)}` };
  const filters = Array.isArray(s.filters) ? s.filters : [];
  for (const f of filters) {
    const ops = src.fields[f.field];
    if (!ops) return { ok: false, error: `scope_field_not_allowed:${f.field}` };
    if (!ops.includes(f.op)) return { ok: false, error: `scope_op_not_allowed:${f.field}.${f.op}` };
  }
  return { ok: true, scope: { source: s.source, filters } };
}

async function runScope(admin: SupabaseClient, tenantId: string, scope: CompiledScope) {
  const src = SCOPE_SOURCES[scope.source];
  let q = admin.from(scope.source).select('*').eq('tenant_id', tenantId);
  for (const f of scope.filters) {
    if (f.op === 'in' && Array.isArray(f.value)) q = q.in(f.field, f.value as string[]);
    else q = (q as unknown as Record<string, (c: string, v: unknown) => typeof q>)[f.op](f.field, f.value);
  }
  const { data, error } = await q.limit(500);
  if (error) throw new Error(`scope_query_failed: ${error.message}`);
  const rows = data ?? [];
  return {
    count: rows.length,
    entity_kind: src.entity_kind,
    preview: rows.slice(0, 12).map((r: Record<string, unknown>) => ({ ref: String(r.id), label: src.label(r) })),
    refs: rows.map((r: Record<string, unknown>) => ({ ref: String(r.id), label: src.label(r) })),
  };
}

// Compose the DE's operating model with the admin client (the SQL RPC of the
// same name serves the app under user auth; this is the service-side twin).
async function operatingModel(admin: SupabaseClient, tenantId: string, deId: string) {
  const [{ data: de }, { data: watchers }, { data: playbooks }] = await Promise.all([
    admin.from('digital_employees').select('id,name,persona_name,department,category,description,trust_level').eq('id', deId).eq('tenant_id', tenantId).maybeSingle(),
    admin.from('work_watchers').select('label,description,kind,active').eq('tenant_id', tenantId).eq('de_id', deId),
    admin.from('playbook_definitions').select('key,name,status,version,steps').eq('tenant_id', tenantId).eq('de_id', deId).eq('status', 'published'),
  ]);
  return { de, watchers: watchers ?? [], playbooks: (playbooks ?? []).map(p => ({ key: p.key, name: p.name, version: p.version, steps: Array.isArray(p.steps) ? p.steps.length : 0 })) };
}

async function compile(admin: SupabaseClient, apiKey: string, tenantId: string, missionId: string) {
  const { data: mission } = await admin.from('de_missions').select('*').eq('id', missionId).eq('tenant_id', tenantId).maybeSingle();
  if (!mission) return json({ error: 'mission_not_found' }, 404);
  if (!['draft', 'failed', 'awaiting_approval'].includes(mission.status)) {
    return json({ error: `cannot_compile_from_${mission.status}` }, 409);
  }
  await admin.from('de_missions').update({ status: 'compiling', error: null, updated_at: new Date().toISOString() }).eq('id', missionId);

  const om = await operatingModel(admin, tenantId, mission.de_id);
  const deName = om.de?.persona_name || om.de?.name || 'the employee';
  const system = [
    `You compile a manager's one-sentence order to a digital employee into a STRICT JSON mission plan. No prose outside JSON.`,
    `The employee: ${deName} — ${om.de?.description ?? ''} (department ${om.de?.department}, trust ${om.de?.trust_level}).`,
    `Its standing work sources: ${JSON.stringify(om.watchers)}.`,
    `Its published playbooks: ${JSON.stringify(om.playbooks)}.`,
    `Allowed scope sources and fields (you may use ONLY these): ${JSON.stringify(Object.fromEntries(Object.entries(SCOPE_SOURCES).map(([k, v]) => [k, Object.keys(v.fields)])))}.`,
    `Return JSON: {"interpretation": string, "shape": "batch"|"project"|"standing",`,
    ` "scope": {"source": string, "filters": [{"field","op","value"}]} | null (batch only),`,
    ` "subject": string | null (project only — who/what the project is about),`,
    ` "cadence": string | null (standing only — plain words),`,
    ` "case_title_template": string (use {label} for the entity name),`,
    ` "procedure_summary": string (2-4 sentences, plain language, name the playbook if one fits),`,
    ` "playbook_key": string | null,`,
    ` "gates": [string] (which steps will stop for human approval),`,
    ` "notes": [string] (risks, ambiguities, what you assumed)}.`,
    `Dates: resolve relative windows (e.g. "Q3") to ISO dates using today = ${new Date().toISOString().slice(0, 10)}.`,
    `If the order cannot map to this employee's job or allowed scopes, return {"impossible": string} explaining why in plain words.`,
  ].join('\n');

  let plan: Record<string, unknown>;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_MODEL, max_tokens: 2048, system,
        messages: [{ role: 'user', content: wrapUntrusted(mission.directive_text, 'directive') }],
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`anthropic_${res.status}: ${body.slice(0, 300)}`);
    const data = JSON.parse(body);
    const text = (data.content ?? []).filter((c: { type?: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '').join('');
    plan = JSON.parse(text.replace(/^```json?\s*|\s*```$/g, ''));
  } catch (e) {
    await admin.from('de_missions').update({ status: 'failed', error: String((e as Error).message).slice(0, 500), updated_at: new Date().toISOString() }).eq('id', missionId);
    return json({ error: 'compile_failed', detail: String((e as Error).message).slice(0, 300) }, 502);
  }

  if (plan.impossible) {
    await admin.from('de_missions').update({ status: 'failed', error: `cannot_do: ${String(plan.impossible).slice(0, 400)}`, updated_at: new Date().toISOString() }).eq('id', missionId);
    return json({ ok: false, impossible: plan.impossible });
  }

  const shape = ['batch', 'project', 'standing'].includes(String(plan.shape)) ? String(plan.shape) : 'batch';
  let scopeResolved: Awaited<ReturnType<typeof runScope>> | null = null;
  if (shape === 'batch') {
    const v = validateScope(plan.scope);
    if (!v.ok) {
      await admin.from('de_missions').update({ status: 'failed', error: v.error, updated_at: new Date().toISOString() }).eq('id', missionId);
      return json({ error: 'compile_failed', detail: v.error }, 422);
    }
    scopeResolved = await runScope(admin, tenantId, v.scope);
    plan.scope = v.scope;
  }

  // Dedup: entities that already have an open objective with this DE.
  let dedup: { ref: string; label: string }[] = [];
  if (scopeResolved) {
    const { data: open } = await admin.from('de_objectives')
      .select('entity_ref').eq('tenant_id', tenantId).eq('de_id', mission.de_id)
      .in('status', ['open', 'in_progress', 'blocked']).not('entity_ref', 'is', null);
    const busy = new Set((open ?? []).map(o => String(o.entity_ref)));
    dedup = scopeResolved.refs.filter(r => busy.has(r.ref));
  }

  const caseCount = shape === 'batch' ? (scopeResolved?.count ?? 0) - dedup.length : 1;
  const est = shape === 'standing' ? 0 : Math.max(caseCount, 0) * EST_PER_CASE_USD;

  const compiled = {
    interpretation: plan.interpretation, shape,
    scope: plan.scope ?? null, subject: plan.subject ?? null, cadence: plan.cadence ?? null,
    scope_preview: scopeResolved ? { count: scopeResolved.count, entity_kind: scopeResolved.entity_kind, sample: scopeResolved.preview } : null,
    case_title_template: plan.case_title_template ?? 'Work {label}',
    procedure_summary: plan.procedure_summary, playbook_key: plan.playbook_key ?? null,
    gates: plan.gates ?? [], notes: plan.notes ?? [],
    dedup: { count: dedup.length, sample: dedup.slice(0, 8), policy: 'skip' },
    est_cases: Math.max(caseCount, 0),
  };
  await admin.from('de_missions').update({
    status: 'awaiting_approval', shape, compiled_plan: compiled,
    est_cost_usd: est, updated_at: new Date().toISOString(),
  }).eq('id', missionId);
  return json({ ok: true, mission_id: missionId, plan: compiled, est_cost_usd: est });
}

async function approve(admin: SupabaseClient, tenantId: string, userId: string | null, missionId: string, excludedRefs: string[]) {
  const { data: mission } = await admin.from('de_missions').select('*').eq('id', missionId).eq('tenant_id', tenantId).maybeSingle();
  if (!mission) return json({ error: 'mission_not_found' }, 404);
  if (mission.status !== 'awaiting_approval') return json({ error: `cannot_approve_from_${mission.status}` }, 409);
  const plan = mission.compiled_plan as Record<string, unknown> | null;
  if (!plan) return json({ error: 'no_compiled_plan' }, 409);
  const shape = String(mission.shape ?? plan.shape ?? 'batch');

  if (shape === 'standing') {
    // v1: standing missions stop at the proposal — installing watchers from a
    // mission is a follow-up build; be honest rather than half-install.
    await admin.from('de_missions').update({ status: 'failed', error: 'standing_shape_not_installable_yet — use the role kit / watcher setup for recurring cadences', updated_at: new Date().toISOString() }).eq('id', missionId);
    return json({ error: 'standing_not_installable_yet' }, 422);
  }

  const excluded = new Set(excludedRefs.map(String));
  let created = 0, skippedBusy = 0, skippedExcluded = 0;

  if (shape === 'batch') {
    const v = validateScope(plan.scope);
    if (!v.ok) return json({ error: v.error }, 422);
    const resolved = await runScope(admin, tenantId, v.scope);
    const dedupSet = new Set((((plan.dedup as Record<string, unknown>)?.sample as { ref: string }[]) ?? []).map(d => d.ref));
    // Re-check open objectives at approval time (state may have moved since compile).
    const { data: open } = await admin.from('de_objectives')
      .select('entity_ref').eq('tenant_id', tenantId).eq('de_id', mission.de_id)
      .in('status', ['open', 'in_progress', 'blocked']).not('entity_ref', 'is', null);
    const busy = new Set((open ?? []).map(o => String(o.entity_ref)));
    for (const r of resolved.refs) {
      if (excluded.has(r.ref)) { skippedExcluded++; continue; }
      if (busy.has(r.ref) || dedupSet.has(r.ref)) { skippedBusy++; continue; }
      // Idempotent per (mission, entity): a retried approve never double-creates.
      const { data: exists } = await admin.from('de_objectives').select('id').eq('mission_id', mission.id).eq('entity_ref', r.ref).maybeSingle();
      if (exists) continue;
      const title = String(plan.case_title_template ?? 'Work {label}').replace('{label}', r.label);
      const { error } = await admin.from('de_objectives').insert({
        tenant_id: tenantId, de_id: mission.de_id, mission_id: mission.id,
        title: title.slice(0, 200),
        description: `${plan.interpretation ?? mission.directive_text}\n\nProcedure: ${plan.procedure_summary ?? ''}${plan.playbook_key ? `\nPlaybook: ${plan.playbook_key}` : ''}`,
        entity_kind: resolved.entity_kind, entity_ref: r.ref, priority: 3, created_by: userId,
      });
      if (!error) created++;
    }
  } else { // project
    const { data: exists } = await admin.from('de_objectives').select('id').eq('mission_id', mission.id).maybeSingle();
    if (!exists) {
      const { error } = await admin.from('de_objectives').insert({
        tenant_id: tenantId, de_id: mission.de_id, mission_id: mission.id,
        title: `${String(plan.interpretation ?? mission.directive_text).slice(0, 180)}`,
        description: `Project mission for ${String(plan.subject ?? 'the stated subject')}.\n\n${plan.procedure_summary ?? ''}${plan.playbook_key ? `\nPlaybook: ${plan.playbook_key}` : ''}`,
        entity_kind: null, entity_ref: String(plan.subject ?? '') || null, priority: 2, created_by: userId,
      });
      if (!error) created++;
    }
  }

  await admin.from('de_missions').update({
    status: 'running', approved_by: userId, approved_at: new Date().toISOString(),
    scope_edits: { excluded_refs: excludedRefs }, updated_at: new Date().toISOString(),
  }).eq('id', missionId);
  await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId, p_actor: 'Founder', p_actor_type: 'human', p_category: 'config_change',
    p_action: `Mission approved — "${String(mission.directive_text).slice(0, 100)}" fanned out: ${created} case(s), ${skippedBusy} skipped (already in motion), ${skippedExcluded} excluded by hand`,
    p_detail: { kind: 'de_mission', mission_id: mission.id, de_id: mission.de_id },
  }).then(() => undefined, () => undefined);
  return json({ ok: true, created, skipped_busy: skippedBusy, skipped_excluded: skippedExcluded });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');
    const missionId = String(body.mission_id ?? '');
    if (!missionId) return json({ error: 'mission_id required' }, 400);

    let tenantId: string | null = null;
    let userId: string | null = null;
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (bearer === svc) {
      tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : null;
      if (!tenantId) return json({ error: 'tenant_id required for service calls' }, 400);
    } else {
      const { data: u } = await admin.auth.getUser(bearer);
      if (!u?.user) return json({ error: 'unauthorized' }, 401);
      userId = u.user.id;
      const { data: prof } = await admin.from('profiles').select('tenant_id, layer, role').eq('user_id', u.user.id).maybeSingle();
      tenantId = await resolveTenantWithRemoteAccess(admin, u.user.id, prof?.tenant_id, prof?.layer, body?.tenant_id);
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
      if (!['tenant_owner', 'tenant_admin', 'tenant_manager'].includes(String(prof?.role ?? '')) && prof?.layer !== 'platform') {
        return json({ error: 'not_permitted' }, 403);
      }
    }

    if (action === 'compile') {
      const apiKey = await getAIKey(admin, 'ANTHROPIC_API_KEY');
      if (!apiKey) return json({ error: 'llm_not_configured' }, 503);
      const { data: budget } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
      if (budget && budget.allowed === false) return json({ error: 'ai_budget_exceeded' }, 429);
      return await compile(admin, apiKey, tenantId, missionId);
    }
    if (action === 'approve') {
      const excluded = Array.isArray(body.excluded_refs) ? body.excluded_refs.map(String) : [];
      return await approve(admin, tenantId, userId, missionId, excluded);
    }
    return json({ error: `unknown action ${action}` }, 400);
  } catch (e) {
    console.error('de-mission:', e);
    return json({ error: String((e as Error).message ?? e).slice(0, 400) }, 500);
  }
});
