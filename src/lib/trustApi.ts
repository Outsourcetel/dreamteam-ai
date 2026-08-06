// ============================================================
// Earned-Trust Progression (migration 025) — thin RPC client.
//
// Autonomy is EARNED per action category from measured evidence
// (Proving Ground eval runs, human task outcomes, guardrail
// blocks), promoted by a human, demoted automatically on
// regression. "Promote slow, demote fast."
//
// All evidence and level changes are SERVER-computed (SECURITY
// DEFINER RPCs) — this lib never asserts evidence. Guardrails
// always cap: promotion only widens the trust dial within
// guardrails (composition rule, migration 016 — untouched).
// ============================================================
import { supabase } from '../supabase';
import { raise, requireTenantId, listTenantRows } from './liveShared';
import { getSessionTenantId, isMissingTableError } from './customerApi';

export type TrustCategory = 'invoice_auto_send' | 'answer_dock' | 'answer_widget';

// ── Ladder-as-data (trust program, docs/31 Q7 Architecture B) ────────────
// A policy's ladder is a manager-authored array of levels. Level 0 is always
// 'draft' (un-earned trust never acts); modes never narrow as levels rise;
// settings carry ONLY the field(s) that capability's enforcement reads.
// Validation is SERVER-side (validate_trust_ladder) — the shapes here are
// for editing and display, never asserted as enforcement truth.
export type TrustLadderMode = 'draft' | 'act_with_approval' | 'act_within_limits' | 'act';

export const TRUST_LADDER_MODE_LABELS: Record<TrustLadderMode, string> = {
  draft: 'Drafts for approval',
  act_with_approval: 'Prepares the action — a person confirms first',
  act_within_limits: 'Acts on its own within limits',
  act: 'Acts on its own',
};

export interface TrustLadderLevel {
  /** REQUIRED, 1..max_level, unique. Level 0 is implicit (always human-gated
   *  draft) and never stored — the server rejects a stored level 0. */
  level: number;
  name: string;
  mode: TrustLadderMode;
  settings?: { min_confidence?: number; max_amount_cents?: number };
}

export interface TrustPolicy {
  id: string;
  tenant_id: string;
  de_id: string | null;
  /** Free-text since the trust program unfroze the key axis: the legacy three,
   *  'action:<category>' for a whole connector category, or a raw action key. */
  action_category: string;
  baseline_level: number;
  current_level: number;
  target_level: number;
  criteria: Record<string, number>;
  status: 'active' | 'paused';
  pending_task_id: string | null;
  requested_by: string | null;
  requested_at: string | null;
  created_at: string;
  updated_at: string;
  /** null = the engine's built-in level rewards (exactly the legacy behavior). */
  ladder?: TrustLadderLevel[] | null;
  display_name?: string | null;
  max_level?: number;
}

// ── The surface-derived Trust tab (list_de_trust_surface) ────────────────
export interface TrustSurfaceEntry {
  capability_key: string;
  label: string;
  kind: 'answer' | 'playbook' | 'action_category' | 'action';
  /** The connector category an action entry nests under (null for answers/playbooks). */
  category: string | null;
  /** Destructive entries are visible but never dial-able — the destructive
   *  gate sits above the dial and always wins. */
  dialable: boolean;
  destructive: boolean;
  enforcement: { uses_confidence: boolean; uses_amount: boolean };
  /** Most specific policy: this employee's own row first, else workspace-wide. */
  policy: TrustPolicy | null;
  /** The enforcement truth from resolve_de_autonomy; null for destructive entries. */
  dial: { enabled: boolean; max_amount_cents: number | null; min_confidence: number | null } | null;
}

/** Everything this employee actually does — its answer channels, reachable
 *  registered actions and playbooks — with the governing policy and the
 *  enforced dial per entry. Server-derived from live config; guarded by
 *  can_access_de (refuses with an error, never an empty list). */
export async function listDeTrustSurface(deId: string): Promise<TrustSurfaceEntry[]> {
  const { data, error } = await supabase.rpc('list_de_trust_surface', { p_de_id: deId });
  if (error) raise('listDeTrustSurface', error);
  return (data ?? []) as TrustSurfaceEntry[];
}

/** Idempotent, level-0, per-capability lazy seeding (manager+). Refused for
 *  capabilities not on the employee's surface and for destructive actions. */
export async function seedDeTrustPolicy(deId: string, capabilityKey: string, displayName?: string): Promise<TrustPolicy> {
  const { data, error } = await supabase.rpc('seed_de_trust_policy', {
    p_de_id: deId, p_capability_key: capabilityKey, p_display_name: displayName ?? null,
  });
  if (error) raise('seedDeTrustPolicy', error);
  return data as TrustPolicy;
}

/** The manager's ladder customization write (set_trust_ladder).
 *  ladder contract: OMITTED (undefined) → unchanged; array → validated
 *  server-side and stored. RESET is the explicit clearLadder flag — never a
 *  null ladder: PostgREST maps a JSON null onto the SQL-NULL default for
 *  jsonb parameters, which the RPC reads as "unchanged", so sending
 *  `ladder: null` would make Reset a silent no-op. */
export async function setTrustLadder(policyId: string, opts: {
  ladder?: TrustLadderLevel[];
  clearLadder?: boolean;
  displayName?: string;
  criteria?: Record<string, number>;
}): Promise<TrustPolicy> {
  const args: Record<string, unknown> = { p_policy_id: policyId };
  if (opts.clearLadder) args.p_clear_ladder = true;
  else if (opts.ladder !== undefined) args.p_ladder = opts.ladder;
  if (opts.displayName !== undefined) args.p_display_name = opts.displayName;
  if (opts.criteria !== undefined) args.p_criteria = opts.criteria;
  const { data, error } = await supabase.rpc('set_trust_ladder', args);
  if (error) raise('setTrustLadder', error);
  return data as TrustPolicy;
}

/** mig 258/447 records gate for one employee, via the existing
 *  get_de_gate_status RPC (the same read EmployeeFilePage uses). Returns
 *  null when the status could not be read — callers must render ABSENCE,
 *  never a false "gate clear" claim. */
export async function getDeGateStatus(deId: string): Promise<{ gated: boolean; reasons: string[] } | null> {
  try {
    const { data, error } = await supabase.rpc('get_de_gate_status', { p_de_id: deId });
    if (error || !data?.ok) return null;
    return { gated: !!data.gated, reasons: (data.reasons ?? []) as string[] };
  } catch {
    return null;
  }
}

// ── Plain-language trust-plan compiler (compile-trust-plan edge fn) ──────
// The manager writes the plan in plain words; the edge function compiles it
// into a DRAFT of per-capability ladders, validated against the SAME
// validate_trust_ladder the write path enforces. NOTHING is applied by the
// compile — applying happens here in the UI, per capability, through the
// ordinary setTrustLadder writer.

/** current/proposed snapshot per capability. `current.ladder`/`criteria` are
 *  null when no policy row exists (display_name then falls back to the label). */
export interface TrustPlanSide {
  display_name: string;
  ladder: TrustLadderLevel[] | null;
  criteria: Record<string, number> | null;
}
export interface TrustPlanCapabilityDraft {
  capability_key: string;
  label: string;
  current: TrustPlanSide;
  /** proposed.ladder is never null — an invalid or empty proposal lands in
   *  `unmapped` server-side instead of shipping as a draft. */
  proposed: TrustPlanSide & { ladder: TrustLadderLevel[] };
  changed: boolean;
  explanation: string;
}
export interface TrustPlanGuardrailSuggestion { description: string; rationale: string }
export interface TrustPlanUnmapped { text: string; why: string }
export interface TrustPlanDraft {
  capabilities: TrustPlanCapabilityDraft[];
  /** Prohibition-shaped plan fragments. These are NOT applied by this flow —
   *  guardrails outrank trust and are approved in their own flow. */
  guardrail_suggestions: TrustPlanGuardrailSuggestion[];
  /** Plan fragments that honestly could not become a valid ladder, with why. */
  unmapped: TrustPlanUnmapped[];
}

/** Every non-200 from the edge fn is {ok:false, error, detail} with a
 *  plain-language detail — surface that, never a bare code. */
async function compileFailure(error: unknown, data: unknown): Promise<never> {
  const msgOf = (b: unknown) => {
    const body = b as { error?: string; detail?: string } | null;
    return body?.detail || body?.error || null;
  };
  let msg = msgOf(data);
  if (!msg) {
    const ctx = (error as { context?: Response } | null)?.context;
    if (ctx && typeof ctx.json === 'function') {
      try { msg = msgOf(await ctx.json()); } catch { /* non-JSON body */ }
    }
  }
  throw new Error(msg || (error as Error | null)?.message || 'The trust plan could not be compiled.');
}

/** POST /compile-trust-plan — plain-language plan → validated DRAFT.
 *  User-JWT only (manager+; both permission axes re-checked server-side);
 *  budget- and suspension-gated before any AI spend. The only server side
 *  effect is one audit row recording that a compile happened. An LLM or
 *  validation failure throws — it is NEVER returned as an empty draft. */
export async function compileTrustPlan(deId: string, planText: string): Promise<TrustPlanDraft> {
  // tenant_id is only honored for platform admins in an audited remote-access
  // session (the entity-draft pattern) — harmless for ordinary tenant users.
  const tid = await getSessionTenantId();
  const { data, error } = await supabase.functions.invoke('compile-trust-plan', {
    body: { de_id: deId, plan_text: planText, ...(tid ? { tenant_id: tid } : {}) },
  });
  const res = data as { ok?: boolean; draft?: TrustPlanDraft; error?: string; detail?: string } | null;
  if (error || !res || res.ok !== true) await compileFailure(error, data);
  const draft = res!.draft;
  // Contract: all three arrays are always present on a 200. A malformed body
  // is a failure — never rendered as an empty draft.
  if (!draft || !Array.isArray(draft.capabilities) || !Array.isArray(draft.guardrail_suggestions) || !Array.isArray(draft.unmapped)) {
    throw new Error('The compiler returned an unreadable draft — nothing was applied.');
  }
  return draft;
}

export interface TrustCriterion {
  key: string;
  label: string;
  actual: number;
  required: number;
  met: boolean;
  detail: string;
}

export interface TrustEvidence {
  policy_id: string;
  action_category: string;
  current_level: number;
  target_level: number;
  window_days: number;
  criteria: TrustCriterion[];
  eligible: boolean;
  at_max_level: boolean;
  computed_at: string;
}

/** Client-side mirror of trust_level_settings() — display only.
 *  The server ladder is authoritative; this exists so the UI can
 *  label manual dial raises above the earned level as overrides. */
export function trustLevelSettings(category: TrustCategory, level: number): {
  enabled: boolean; max_amount_cents: number | null; min_confidence: number | null;
} {
  if (level <= 0) return { enabled: false, max_amount_cents: null, min_confidence: null };
  const idx = Math.min(level, 3) - 1;
  if (category === 'invoice_auto_send') {
    return { enabled: true, max_amount_cents: [100000, 500000, 1000000][idx], min_confidence: null };
  }
  return { enabled: true, max_amount_cents: null, min_confidence: [90, 75, 60][idx] };
}

export const TRUST_LEVEL_LABELS = ['Human-gated', 'Level 1', 'Level 2', 'Level 3'];

/** The level's manager-chosen name from the policy's custom ladder, falling
 *  back to the legacy names. Display only. */
export function trustLevelName(policy: Pick<TrustPolicy, 'ladder'> | null | undefined, level: number): string {
  // Stored entries carry explicit levels 1..max_level; level 0 is the
  // implicit human-gated floor and always takes the legacy label.
  const entry = policy?.ladder?.find(e => e.level === level);
  const name = entry?.name?.trim();
  return name || (TRUST_LEVEL_LABELS[level] ?? `Level ${level}`);
}

/** Display-only mirror of the server's ladder compile, used ONLY to label a
 *  manual dial raise as an override. Returns null when the earned settings
 *  cannot be known client-side (a non-legacy key with no custom ladder) —
 *  callers must render ABSENCE in that case, never a guess.
 *  The server ladder (trust_ladder_settings) is authoritative. */
export function earnedLadderSettings(
  policy: Pick<TrustPolicy, 'action_category' | 'ladder' | 'max_level'> | null | undefined,
  level: number,
): { enabled: boolean; max_amount_cents: number | null; min_confidence: number | null } | null {
  if (!policy) return null;
  if (level <= 0) return { enabled: false, max_amount_cents: null, min_confidence: null };
  const ladder = policy.ladder;
  if (ladder && ladder.length > 0) {
    const capped = Math.min(level, policy.max_level ?? 3);
    // Highest defined entry at or below the earned level wins (server
    // semantics — entries carry explicit levels 1..max_level).
    let best: TrustLadderLevel | null = null;
    for (const e of ladder) {
      if (e.level <= capped && (!best || e.level > best.level)) best = e;
    }
    if (!best) return { enabled: false, max_amount_cents: null, min_confidence: null };
    // 'enabled' is DERIVED from the mode (the server's trust_ladder_settings
    // does the same): only act / act_within_limits compile open. The dial has
    // no "requires approval" bit, so act_with_approval MUST compile closed —
    // a label promising a person confirms first cannot grant uncapped action.
    const acts = best.mode === 'act' || best.mode === 'act_within_limits';
    return {
      enabled: acts,
      max_amount_cents: best.settings?.max_amount_cents ?? null,
      min_confidence: best.settings?.min_confidence ?? null,
    };
  }
  // Null ladder = the engine's built-in rewards — mirrored only for the
  // legacy keys whose reward tables are known. Anything else: unknown.
  const cat = policy.action_category;
  if (cat === 'invoice_auto_send' || cat === 'answer_dock' || cat === 'answer_widget') {
    return trustLevelSettings(cat as TrustCategory, level);
  }
  return null;
}

export async function listTrustPolicies(): Promise<TrustPolicy[]> {
  return listTenantRows<TrustPolicy>('trust_policies', 'action_category', true, 'listTrustPolicies');
}

/** Seed default policies for the caller's tenant (idempotent; the
 *  demo tenant is refused server-side — demo mode untouched). */
export async function seedTrustPolicies(): Promise<TrustPolicy[]> {
  const { data, error } = await supabase.rpc('seed_trust_policies');
  if (error) raise('seedTrustPolicies', error);
  return (data ?? []) as TrustPolicy[];
}

/** Server-computed evidence for a category (never asserted client-side).
 *  Accepts any capability key now the key axis is unfrozen. */
export async function computeTrustEvidence(category: string, deId: string | null = null): Promise<TrustEvidence> {
  const { data, error } = await supabase.rpc('compute_trust_evidence', {
    p_de_id: deId, p_action_category: category,
  });
  if (error) raise('computeTrustEvidence', error);
  return data as TrustEvidence;
}

/** Ask for a promotion. The server recomputes evidence and rejects
 *  the request outright if the criteria aren't met. */
export async function requestTrustPromotion(policyId: string): Promise<{ ok: boolean; task_id: string }> {
  const { data, error } = await supabase.rpc('request_trust_promotion', { p_policy_id: policyId });
  if (error) raise('requestTrustPromotion', error);
  return data as { ok: boolean; task_id: string };
}

/** decideHumanTask hook #4 — resolve a trust_promotion task.
 *  On approval the server re-verifies evidence is STILL eligible
 *  (stale-check) and blocks self-approval before moving the dial. */
export async function resolveTrustPromotion(taskId: string, decision: 'approved' | 'rejected'): Promise<{ applied: boolean }> {
  const { data, error } = await supabase.rpc('apply_trust_promotion', { p_task_id: taskId, p_decision: decision });
  if (error) raise('resolveTrustPromotion', error);
  return data as { applied: boolean };
}

export interface TrustHistoryEvent {
  id: string;
  kind: string;
  action: string;
  action_category: string | null;
  created_at: string;
}

/** Promotion / demotion history from the immutable audit trail. */
export async function listTrustHistory(limit = 20): Promise<TrustHistoryEvent[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('audit_events')
    .select('id, action, detail, created_at')
    .eq('tenant_id', tid)
    .eq('category', 'config_change')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) raise('listTrustHistory', error);
  const rows = (data ?? []) as Array<{ id: string; action: string; detail: Record<string, unknown>; created_at: string }>;
  return rows
    .filter(r => typeof r.detail?.kind === 'string' && (r.detail.kind as string).startsWith('trust_'))
    .slice(0, limit)
    .map(r => ({
      id: r.id,
      kind: r.detail.kind as string,
      action: r.action,
      action_category: (r.detail.action_category as string) ?? null,
      created_at: r.created_at,
    }));
}

// ── Workforce-level trust (migrations 621/622) + the stop button (624/625) ──
//
// Everything here is ORG-level and job-agnostic: each number means the same for
// a Support, Finance or Marketing employee because it is computed from the
// SHAPE of the work — was a human needed, did they change it, how long did they
// look — never from what the work was about.

export interface WorkforceTrustMetrics {
  window_days: number;
  as_of: string;
  /** ⚠ Read these FIRST. Below the minimum sample a rate comes back null and
   *  the UI must say "not enough yet" rather than print a number nobody should
   *  act on. Two flags because two denominators: decisions about work divide by
   *  everything the gate ruled on; what the workforce DID divides by what was
   *  actually performed. */
  min_actions_for_a_rate: number;
  min_decisions_for_a_rate: number;
  enough_considered: boolean;
  enough_performed: boolean;
  enough_decisions: boolean;

  actions_considered: number;
  actions_performed: number;
  actions_autonomous: number;
  autonomy_rate: number | null;

  decisions: number;
  decisions_unchanged: number;
  decisions_edited: number;
  decisions_rejected: number;
  acceptance_rate: number | null;
  edit_rate: number | null;
  reject_rate: number | null;

  median_seconds_to_decide: number | null;
  decided_under_a_minute: number;
  /** Enough decisions, all made in under a minute — the approval is a formality. */
  rubber_stamp_risk: boolean;

  guardrail_blocks: number;
  guardrail_block_rate: number | null;
  human_gated: number;
  failures: number;

  interventions: number;
  intervention_rate: number | null;
  /** ⚠ FALSE means no reversal has EVER been performed here. A 0% intervention
   *  rate then means "never used", not "nothing went wrong" — say so. */
  intervention_ever_recorded: boolean;

  incidents: number;
  incident_rate_per_100_actions: number | null;

  employees_active: number;
  employees_with_a_rule: number;
  rule_coverage_rate: number | null;
}

export async function getWorkforceTrustMetrics(days = 30): Promise<WorkforceTrustMetrics> {
  const { data, error } = await supabase.rpc('get_workforce_trust_metrics', {
    p_tenant_id: null, p_days: days,
  });
  if (error) raise('getWorkforceTrustMetrics', error);
  return data as WorkforceTrustMetrics;
}

export interface WorkforcePosture {
  autonomy_paused: boolean;
  paused_at: string | null;
  paused_reason: string | null;
  breaker_enabled: boolean;
  breaker_tripped_at: string | null;
  breaker_tripped_why: string | null;
}

/** No row means never paused and guarded by default — absent is the normal,
 *  protected state (migration 625), not missing configuration. */
export async function getWorkforcePosture(): Promise<WorkforcePosture> {
  const { data, error } = await supabase
    .from('workforce_trust_posture')
    .select('autonomy_paused, paused_at, paused_reason, breaker_enabled, breaker_tripped_at, breaker_tripped_why')
    .maybeSingle();
  if (error && !isMissingTableError(error)) raise('getWorkforcePosture', error);
  return (data as WorkforcePosture | null) ?? {
    autonomy_paused: false, paused_at: null, paused_reason: null,
    breaker_enabled: true, breaker_tripped_at: null, breaker_tripped_why: null,
  };
}

export async function pauseWorkforceAutonomy(reason: string): Promise<void> {
  const { error } = await supabase.rpc('pause_workforce_autonomy', { p_reason: reason });
  if (error) raise('pauseWorkforceAutonomy', error);
}

export async function resumeWorkforceAutonomy(note: string | null = null): Promise<void> {
  const { error } = await supabase.rpc('resume_workforce_autonomy', { p_note: note });
  if (error) raise('resumeWorkforceAutonomy', error);
}
