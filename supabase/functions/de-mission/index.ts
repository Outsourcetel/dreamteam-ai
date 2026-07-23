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
import { hasLLMProvider, llmMessages } from '../_shared/llm.ts';
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
  // Wave-2 widening (truth audit docs/15): sales/BD employees can scope
  // missions over the pipeline — "chase every open opp closing this month".
  opportunities: {
    label: (r: Record<string, unknown>) => String(r.name ?? r.title ?? r.id),
    entity_kind: 'opportunity',
    fields: {
      stage: ['eq', 'neq', 'in'],
      status: ['eq', 'neq', 'in'],
      close_date: ['lt', 'lte', 'gt', 'gte'],
      amount_cents: ['lt', 'lte', 'gt', 'gte'],
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
async function operatingModel(admin: SupabaseClient, tenantId: string, deId: string | null) {
  if (!deId) return { de: null as Record<string, unknown> | null, watchers: [] as unknown[], playbooks: [] as { key: string; name: string; version: number; steps: number }[] };
  const [{ data: de }, { data: watchers }, { data: playbooks }] = await Promise.all([
    admin.from('digital_employees').select('id,name,persona_name,department,category,description,trust_level').eq('id', deId).eq('tenant_id', tenantId).maybeSingle(),
    admin.from('work_watchers').select('label,description,kind,active').eq('tenant_id', tenantId).eq('de_id', deId),
    admin.from('playbook_definitions').select('key,name,status,version,steps').eq('tenant_id', tenantId).eq('de_id', deId).eq('status', 'published'),
  ]);
  return { de, watchers: watchers ?? [], playbooks: (playbooks ?? []).map(p => ({ key: p.key, name: p.name, version: p.version, steps: Array.isArray(p.steps) ? p.steps.length : 0 })) };
}

// A representative receiver for a team mission — used only to give the compiler
// one concrete operating model to reason about (the real routing happens per
// entity at approve time). All lookups are tenant-scoped.
async function representativeDeId(admin: SupabaseClient, tenantId: string, targetSpec: Record<string, unknown> | null): Promise<string | null> {
  if (!targetSpec) return null;
  const kind = String(targetSpec.kind ?? '');
  if (kind === 'archetype') {
    const { data } = await admin.from('digital_employees').select('id')
      .eq('tenant_id', tenantId).eq('archetype_key', String(targetSpec.archetype_key ?? '')).eq('status', 'active')
      .order('created_at', { ascending: true }).limit(1).maybeSingle();
    return data?.id ?? null;
  }
  if (kind === 'explicit') {
    const ids = Array.isArray(targetSpec.de_ids) ? targetSpec.de_ids.map(String) : [];
    if (!ids.length) return null;
    const { data } = await admin.from('digital_employees').select('id')
      .eq('tenant_id', tenantId).in('id', ids).eq('status', 'active').limit(1).maybeSingle();
    return data?.id ?? null;
  }
  if (kind === 'supervisor') {
    const id = String(targetSpec.supervisor_de_id ?? '');
    const { data } = await admin.from('digital_employees').select('id')
      .eq('tenant_id', tenantId).eq('id', id).eq('status', 'active').maybeSingle();
    return data?.id ?? null;
  }
  return null;
}

// ── Cross-DE routing (approve + compile preview). Every candidate is proven
// in-tenant + active; a pick is chosen STRICTLY within the candidate set so a
// mission can never route work onto a DE outside its target or another tenant.
async function candidateSet(admin: SupabaseClient, tenantId: string, targetSpec: Record<string, unknown>): Promise<{ id: string; archetype_key: string | null }[]> {
  const kind = String(targetSpec.kind ?? '');
  let q = admin.from('digital_employees').select('id, archetype_key').eq('tenant_id', tenantId).eq('status', 'active');
  if (kind === 'archetype') q = q.eq('archetype_key', String(targetSpec.archetype_key ?? ''));
  else if (kind === 'explicit') q = q.in('id', Array.isArray(targetSpec.de_ids) ? targetSpec.de_ids.map(String) : ['00000000-0000-0000-0000-000000000000']);
  else if (kind === 'supervisor') q = q.eq('id', String(targetSpec.supervisor_de_id ?? '00000000-0000-0000-0000-000000000000'));
  else return [];
  const { data } = await q;
  return (data ?? []).map((d: Record<string, unknown>) => ({ id: String(d.id), archetype_key: d.archetype_key ? String(d.archetype_key) : null }));
}

async function compile(admin: SupabaseClient, tenantId: string, missionId: string) {
  const { data: mission } = await admin.from('de_missions').select('*').eq('id', missionId).eq('tenant_id', tenantId).maybeSingle();
  if (!mission) return json({ error: 'mission_not_found' }, 404);
  if (!['draft', 'failed', 'awaiting_approval'].includes(mission.status)) {
    return json({ error: `cannot_compile_from_${mission.status}` }, 409);
  }
  await admin.from('de_missions').update({ status: 'compiling', error: null, updated_at: new Date().toISOString() }).eq('id', missionId);

  // Team missions (de_id NULL, target_spec set) compile against a REPRESENTATIVE
  // model — the archetype/first receiver — not one specific employee.
  const isTeam = !mission.de_id && !!mission.target_spec;
  const modelDeId = mission.de_id ?? (await representativeDeId(admin, tenantId, mission.target_spec));
  const om = await operatingModel(admin, tenantId, modelDeId);
  const deName = isTeam ? 'the assigned team' : (om.de?.persona_name || om.de?.name || 'the employee');

  // Standing missions install watchers; give the compiler the catalog of
  // watchable sources/fields/ops so a standing plan can only propose real ones.
  const [{ data: catRows }, { data: fieldRows }] = await Promise.all([
    admin.from('watch_source_catalog').select('source_key, supports_kinds').eq('active', true).eq('legacy_bespoke', false),
    admin.from('watch_source_fields').select('source_key, column_name, role, allowed_ops'),
  ]);
  const watchCatalog = (catRows ?? []).map((s: Record<string, unknown>) => ({
    source: s.source_key, kinds: s.supports_kinds,
    fields: (fieldRows ?? []).filter((f: Record<string, unknown>) => f.source_key === s.source_key)
      .map((f: Record<string, unknown>) => ({ name: f.column_name, role: f.role, ops: f.allowed_ops })),
  }));

  const system = [
    `You compile a manager's one-sentence order to a digital employee into a STRICT JSON mission plan. No prose outside JSON.`,
    `The employee: ${deName} — ${om.de?.description ?? ''} (department ${om.de?.department}, trust ${om.de?.trust_level}).`,
    isTeam ? `This is a TEAM mission — every case fans out to the right team member automatically; do NOT pick a single playbook_key (each receiver chooses its own).` : `Its standing work sources: ${JSON.stringify(om.watchers)}.`,
    `Its published playbooks: ${JSON.stringify(om.playbooks)}.`,
    `Allowed scope sources and fields (you may use ONLY these): ${JSON.stringify(Object.fromEntries(Object.entries(SCOPE_SOURCES).map(([k, v]) => [k, Object.keys(v.fields)])))}.`,
    `Return JSON: {"interpretation": string, "shape": "batch"|"project"|"standing",`,
    ` "scope": {"source": string, "filters": [{"field","op","value"}]} | null (batch only),`,
    ` "subject": string | null (project only — who/what the project is about),`,
    ` "cadence": string | null (standing only — plain words),`,
    ` "standing": {"cadence_words": string, "watchers": [{"kind":"date_horizon"|"state_condition", "label": string, "description": string, "config": object}]} | null (standing only — see rules below),`,
    ` "case_title_template": string (use {label} for the entity name),`,
    ` "procedure_summary": string (2-4 sentences, plain language, name the playbook if one fits),`,
    ` "playbook_key": string | null,`,
    ` "gates": [string] (which steps will stop for human approval),`,
    ` "notes": [string] (risks, ambiguities, what you assumed)}.`,
    `A STANDING mission installs recurring watchers instead of a one-time batch. Emit standing.watchers using ONLY these watchable sources/fields/ops: ${JSON.stringify(watchCatalog)}. A date_horizon watcher config = {"source","date_field"(optional),"horizons_days":[ints]}; a state_condition watcher config = {"source","field","op","value"}. Give each watcher a short stable label. If the cadence can't map to these sources, return {"impossible": ...}.`,
    `Dates: resolve relative windows (e.g. "Q3") to ISO dates using today = ${new Date().toISOString().slice(0, 10)}.`,
    `If the order cannot map to this employee's job or allowed scopes, return {"impossible": string} explaining why in plain words.`,
  ].join('\n');

  let plan: Record<string, unknown>;
  try {
    const res = await llmMessages(admin, {
      model: DEFAULT_MODEL, max_tokens: 2048, system,
      messages: [{ role: 'user', content: wrapUntrusted(mission.directive_text, 'directive') }],
    }, 'de-mission');
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
  const failCompile = async (detail: string, code = 422) => {
    await admin.from('de_missions').update({ status: 'failed', error: detail.slice(0, 400), updated_at: new Date().toISOString() }).eq('id', missionId);
    return json({ error: 'compile_failed', detail }, code);
  };

  // Standing team missions aren't installable yet (per-receiver watcher install
  // is a follow-on) — be honest at compile rather than half-plan.
  if (shape === 'standing' && isTeam) return await failCompile('A recurring (standing) order can only be given to a single employee right now, not a whole team.');

  let scopeResolved: Awaited<ReturnType<typeof runScope>> | null = null;
  if (shape === 'batch') {
    const v = validateScope(plan.scope);
    if (!v.ok) return await failCompile(v.error);
    scopeResolved = await runScope(admin, tenantId, v.scope);
    plan.scope = v.scope;
  }

  // Standing: validate each proposed watcher against the catalog (one rule set,
  // same as install + cron) and COUNT the entities currently in scope so the
  // founder never approves a blind, unbounded case-spawner (adversary fix #3).
  let standing: { cadence_words: string; watchers: { kind: string; label: string; description: string; config: Record<string, unknown>; in_scope_count: number }[]; total_open_now: number } | null = null;
  if (shape === 'standing') {
    const raw = (plan.standing && typeof plan.standing === 'object') ? plan.standing as Record<string, unknown> : {};
    const rawWatchers = Array.isArray(raw.watchers) ? raw.watchers as Record<string, unknown>[] : [];
    if (!rawWatchers.length) return await failCompile('This recurring order didn’t produce anything watchable — try naming the trigger (e.g. "when a renewal is 60 days out").');
    const seenLabels = new Set<string>();
    const watchers: NonNullable<typeof standing>['watchers'] = [];
    for (const w of rawWatchers) {
      const kind = String(w.kind ?? '');
      const label = String(w.label ?? '').trim().slice(0, 200);
      const config = (w.config && typeof w.config === 'object') ? w.config as Record<string, unknown> : {};
      if (!label) return await failCompile('A recurring watcher is missing its name.');
      if (seenLabels.has(label.toLowerCase())) return await failCompile(`Two watchers share the name "${label}" — each needs a distinct name.`);
      seenLabels.add(label.toLowerCase());
      const { data: vErr } = await admin.rpc('validate_watcher_config', { p_kind: kind, p_config: config, p_tenant_id: tenantId, p_de_id: mission.de_id });
      if (vErr) return await failCompile(String(vErr));
      const { data: cnt } = await admin.rpc('preview_watcher_spec', { p_kind: kind, p_config: config, p_tenant_id: tenantId });
      watchers.push({ kind, label, description: String(w.description ?? '').slice(0, 500), config, in_scope_count: typeof cnt === 'number' ? cnt : -1 });
    }
    standing = { cadence_words: String(raw.cadence_words ?? plan.cadence ?? 'ongoing'), watchers, total_open_now: watchers.reduce((n, w) => n + Math.max(w.in_scope_count, 0), 0) };
  }

  // Dedup (batch): entities that already have an open objective — entity-centric
  // + tenant-scoped so it works for team missions (de_id NULL) too.
  let dedup: { ref: string; label: string }[] = [];
  if (scopeResolved && scopeResolved.refs.length) {
    const { data: open } = await admin.from('de_objectives')
      .select('entity_ref').eq('tenant_id', tenantId)
      .in('status', ['open', 'in_progress', 'blocked'])
      .in('entity_ref', scopeResolved.refs.map(r => r.ref));
    const busy = new Set((open ?? []).map(o => String(o.entity_ref)));
    dedup = scopeResolved.refs.filter(r => busy.has(r.ref));
  }

  // Team routing preview: how many receivers the cases will spread across.
  let routingPreview: { candidate_count: number; kind: string } | null = null;
  if (isTeam && mission.target_spec) {
    const cands = await candidateSet(admin, tenantId, mission.target_spec as Record<string, unknown>);
    routingPreview = { candidate_count: cands.length, kind: String((mission.target_spec as Record<string, unknown>).kind ?? '') };
  }

  const caseCount = shape === 'batch' ? (scopeResolved?.count ?? 0) - dedup.length
                   : shape === 'standing' ? (standing?.total_open_now ?? 0) : 1;
  const est = Math.max(caseCount, 0) * EST_PER_CASE_USD;

  const compiled = {
    interpretation: plan.interpretation, shape, team: isTeam, target_spec: mission.target_spec ?? null,
    routing_preview: routingPreview,
    scope: plan.scope ?? null, subject: plan.subject ?? null, cadence: plan.cadence ?? null,
    standing,
    scope_preview: scopeResolved ? { count: scopeResolved.count, entity_kind: scopeResolved.entity_kind, sample: scopeResolved.preview } : null,
    case_title_template: plan.case_title_template ?? 'Work {label}',
    procedure_summary: plan.procedure_summary, playbook_key: isTeam ? null : (plan.playbook_key ?? null),
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

// Route scoped entities to receiver DEs, strictly within the candidate set.
// Unrouted only when the candidate set is empty (e.g. an archetype with no
// active members) — that surfaces honestly as created=0, never a silent success.
async function routeReceivers(
  admin: SupabaseClient, tenantId: string, refs: string[],
  cands: { id: string; archetype_key: string | null }[], sourceDomain: string | null,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const candIds = cands.map(c => c.id);
  if (!candIds.length) { for (const r of refs) out.set(r, null); return out; }

  // owner-continuity: most-recent objective on each entity by a candidate DE
  const ownerMap = new Map<string, string>();
  if (refs.length) {
    const { data: hist } = await admin.from('de_objectives')
      .select('entity_ref, de_id, created_at').eq('tenant_id', tenantId)
      .in('entity_ref', refs).in('de_id', candIds).order('created_at', { ascending: false });
    for (const h of hist ?? []) { const ref = String(h.entity_ref); if (!ownerMap.has(ref)) ownerMap.set(ref, String(h.de_id)); }
  }
  // domain-grant preference (soft — the scope sources don't hard-require a grant)
  let granted = new Set<string>();
  if (sourceDomain) {
    const { data: g } = await admin.from('data_access_grants').select('subject_id')
      .eq('tenant_id', tenantId).eq('subject_kind', 'de').eq('resource_category', sourceDomain).in('subject_id', candIds);
    granted = new Set((g ?? []).map(x => String(x.subject_id)));
  }
  // current open-objective load per candidate (for least-loaded, deterministic)
  const load = new Map<string, number>(candIds.map(id => [id, 0]));
  const { data: openRows } = await admin.from('de_objectives').select('de_id')
    .eq('tenant_id', tenantId).in('de_id', candIds).in('status', ['open', 'in_progress', 'blocked']);
  for (const o of openRows ?? []) load.set(String(o.de_id), (load.get(String(o.de_id)) ?? 0) + 1);
  const pick = (pool: string[]): string => {
    let best = pool[0];
    for (const id of pool) {
      const li = load.get(id) ?? 0, lb = load.get(best) ?? 0;
      if (li < lb || (li === lb && id < best)) best = id;
    }
    load.set(best, (load.get(best) ?? 0) + 1);
    return best;
  };
  const grantedPool = candIds.filter(id => granted.has(id));
  for (const ref of refs) {
    if (ownerMap.has(ref)) { out.set(ref, ownerMap.get(ref)!); continue; }
    out.set(ref, pick(grantedPool.length ? grantedPool : candIds));
  }
  return out;
}

// The domain a scope source belongs to (for the routing grant preference).
async function sourceDomainFor(admin: SupabaseClient, source: string): Promise<string | null> {
  if (!source) return null;
  const { data } = await admin.from('watch_source_catalog').select('domain_category').eq('source_key', source).maybeSingle();
  return data?.domain_category ? String(data.domain_category) : null;
}

async function approve(admin: SupabaseClient, tenantId: string, userId: string | null, missionId: string, excludedRefs: string[]) {
  const { data: mission } = await admin.from('de_missions').select('*').eq('id', missionId).eq('tenant_id', tenantId).maybeSingle();
  if (!mission) return json({ error: 'mission_not_found' }, 404);
  if (mission.status !== 'awaiting_approval') return json({ error: `cannot_approve_from_${mission.status}` }, 409);
  const plan = mission.compiled_plan as Record<string, unknown> | null;
  if (!plan) return json({ error: 'no_compiled_plan' }, 409);
  const shape = String(mission.shape ?? plan.shape ?? 'batch');
  const isTeam = !mission.de_id && !!mission.target_spec;

  // ── Standing: install the compiled watchers atomically (all-or-nothing) ──
  if (shape === 'standing') {
    const specs = ((plan.standing as Record<string, unknown> | null)?.watchers ?? []) as Record<string, unknown>[];
    const { data: res, error } = await admin.rpc('install_standing_watchers', {
      p_mission_id: mission.id, p_specs: specs, p_approved_by: userId,
    });
    if (error || !res?.ok) {
      const detail = error?.message ?? res?.error ?? 'install_failed';
      await admin.from('de_missions').update({ status: 'failed', error: String(detail).slice(0, 400), updated_at: new Date().toISOString() }).eq('id', missionId);
      return json({ error: 'standing_install_failed', detail: String(detail) }, 422);
    }
    await admin.rpc('append_audit_event', {
      p_tenant_id: tenantId, p_actor: 'Founder', p_actor_type: 'human', p_category: 'config_change',
      p_action: `Standing mission approved — "${String(mission.directive_text).slice(0, 100)}" installed ${res.installed} watcher(s)`,
      p_detail: { kind: 'de_mission', mission_id: mission.id, de_id: mission.de_id, standing: true },
    }).then(() => undefined, () => undefined);
    return json({ ok: true, standing: true, installed: res.installed });
  }

  const excluded = new Set(excludedRefs.map(String));
  const cands = isTeam ? await candidateSet(admin, tenantId, mission.target_spec as Record<string, unknown>) : [];
  let created = 0, skippedBusy = 0, skippedExcluded = 0;
  const unrouted: { ref: string; label: string }[] = [];
  const perDe: Record<string, number> = {};
  const bump = (deId: string) => { perDe[deId] = (perDe[deId] ?? 0) + 1; };

  if (shape === 'batch') {
    const v = validateScope(plan.scope);
    if (!v.ok) return json({ error: v.error }, 422);
    const resolved = await runScope(admin, tenantId, v.scope);
    const eligible = resolved.refs.filter(r => !excluded.has(r.ref));
    if (excluded.size) skippedExcluded = resolved.refs.length - eligible.length;

    // Entity-centric busy re-check (works for team missions — no de_id filter).
    const { data: open } = eligible.length ? await admin.from('de_objectives')
      .select('entity_ref').eq('tenant_id', tenantId)
      .in('status', ['open', 'in_progress', 'blocked']).in('entity_ref', eligible.map(r => r.ref)) : { data: [] };
    const busy = new Set((open ?? []).map(o => String(o.entity_ref)));
    const toOpen = eligible.filter(r => { if (busy.has(r.ref)) { skippedBusy++; return false; } return true; });

    // Resolve receivers: team → per-entity routing; single → the one DE.
    const sourceDomain = isTeam ? await sourceDomainFor(admin, String((v.scope as Record<string, unknown>).source ?? '')) : null;
    const routeMap = isTeam ? await routeReceivers(admin, tenantId, toOpen.map(r => r.ref), cands, sourceDomain) : null;

    for (const r of toOpen) {
      const receiver = isTeam ? (routeMap!.get(r.ref) ?? null) : String(mission.de_id);
      if (!receiver) { unrouted.push({ ref: r.ref, label: r.label }); continue; }
      // Idempotent per (mission, entity): a retried approve never double-creates.
      const { data: exists } = await admin.from('de_objectives').select('id').eq('mission_id', mission.id).eq('entity_ref', r.ref).maybeSingle();
      if (exists) continue;
      const title = String(plan.case_title_template ?? 'Work {label}').replace('{label}', r.label);
      const { error } = await admin.from('de_objectives').insert({
        tenant_id: tenantId, de_id: receiver, mission_id: mission.id,
        title: title.slice(0, 200),
        description: `${plan.interpretation ?? mission.directive_text}\n\nProcedure: ${plan.procedure_summary ?? ''}${plan.playbook_key ? `\nPlaybook: ${plan.playbook_key}` : ''}`,
        entity_kind: resolved.entity_kind, entity_ref: r.ref, priority: 3, created_by: userId,
      });
      if (!error) { created++; bump(receiver); }
    }
  } else { // project — a single objective; team → route to one receiver
    const { data: exists } = await admin.from('de_objectives').select('id').eq('mission_id', mission.id).maybeSingle();
    if (!exists) {
      let receiver: string | null = String(mission.de_id ?? '');
      if (isTeam) {
        const rm = await routeReceivers(admin, tenantId, [String(plan.subject ?? mission.id)], cands, null);
        receiver = rm.get(String(plan.subject ?? mission.id)) ?? null;
      }
      if (!receiver) { unrouted.push({ ref: String(plan.subject ?? ''), label: String(plan.subject ?? 'the project') }); }
      else {
        const { error } = await admin.from('de_objectives').insert({
          tenant_id: tenantId, de_id: receiver, mission_id: mission.id,
          title: `${String(plan.interpretation ?? mission.directive_text).slice(0, 180)}`,
          description: `Project mission for ${String(plan.subject ?? 'the stated subject')}.\n\n${plan.procedure_summary ?? ''}${plan.playbook_key ? `\nPlaybook: ${plan.playbook_key}` : ''}`,
          entity_kind: null, entity_ref: String(plan.subject ?? '') || null, priority: 2, created_by: userId,
        });
        if (!error) { created++; bump(receiver); }
      }
    }
  }

  await admin.from('de_missions').update({
    status: 'running', approved_by: userId, approved_at: new Date().toISOString(),
    scope_edits: { excluded_refs: excludedRefs },
    report: { per_de: perDe, unrouted, created, skipped_busy: skippedBusy, skipped_excluded: skippedExcluded },
    updated_at: new Date().toISOString(),
  }).eq('id', missionId);
  await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId, p_actor: 'Founder', p_actor_type: 'human', p_category: 'config_change',
    p_action: `Mission approved — "${String(mission.directive_text).slice(0, 100)}" fanned out: ${created} case(s)${isTeam ? ` across ${Object.keys(perDe).length} employee(s)` : ''}, ${skippedBusy} skipped (already in motion)${unrouted.length ? `, ${unrouted.length} unrouted (no eligible employee)` : ''}`,
    p_detail: { kind: 'de_mission', mission_id: mission.id, team: isTeam },
  }).then(() => undefined, () => undefined);
  return json({ ok: true, created, skipped_busy: skippedBusy, skipped_excluded: skippedExcluded, unrouted: unrouted.length, per_de: perDe });
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
      if (!(await hasLLMProvider(admin))) return json({ error: 'llm_not_configured' }, 503);
      const { data: budget } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
      if (budget && budget.allowed === false) return json({ error: 'ai_budget_exceeded' }, 429);
      return await compile(admin, tenantId, missionId);
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
