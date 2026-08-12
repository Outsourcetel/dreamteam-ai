// ============================================================
// Workforce Engine (P3) — guardrail rules + immutable audit events.
// guardrail_rules: tenant-configurable rules enforced in the real
//   path (invoice approval threshold NOW; LLM answer checks in the
//   de-answer/widget-ask edge functions, dormant until the key).
// audit_events: INSERT-only hash chain — every write goes through
//   the append_audit_event() SECURITY DEFINER RPC.
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';

// ── Types ─────────────────────────────────────────────────────────

export type GuardrailRuleType =
  | 'blocked_topic'
  | 'blocked_phrase'
  | 'require_approval_over_cents'
  | 'max_discount_pct'
  // migration 070 — '|'-separated phrases that score customer frustration
  // (25 pts per matching rule; ≥ threshold forces human review). This was
  // missing from the union while real rows existed, which crashed the
  // Compliance page for any tenant with seeded frustration signals.
  | 'frustration_signal';

// Wave 2a — where a rule applies. 'workspace' = the whole tenant (the
// pre-2a behavior and the default). 'department' matches a DE's free-text
// department; 'employee' matches a specific DE id. ('playbook' is honored
// by the resolver but not yet surfaced in the UI.)
export type GuardrailScope = 'workspace' | 'department' | 'employee' | 'playbook';

export interface GuardrailRule {
  id: string;
  tenant_id: string;
  rule: string;
  rule_type: GuardrailRuleType;
  pattern: string | null;
  threshold: number | null;
  applies_to: string;
  scope: GuardrailScope;
  scope_ref: string | null;
  severity: 'blocking' | 'warning';
  active: boolean;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Set when this row is a materialized copy of a shared compliance-pack rule.
   *  Such a row cannot be switched off or retired one at a time — the pack is
   *  detached as a whole (trg_guard_compliance_guardrails enforces this). It
   *  was always selected by `select *`; it just had no name in this type, so no
   *  screen could tell the two kinds of rule apart. */
  compliance_pack_key: string | null;
  /** mig 726 — when a person took this rule out of the working list. The row
   *  survives so a block recorded months ago can still be explained. Retiring
   *  also sets `active = false`, and a CHECK constraint keeps those two facts
   *  agreeing: that is what makes a retired rule stop being enforced by every
   *  reader, all of which filter on `active`. */
  retired_at: string | null;
  retired_by: string | null;
}

export type AuditCategory =
  | 'resolved' | 'escalated' | 'approval' | 'guardrail_check'
  | 'guardrail_block' | 'config_change' | 'playbook_step' | 'invoice'
  | 'connector_sync' | 'connector_action' | 'evidence_step' | 'access_control'
  | 'guardrail_adjudication';   // GI-10: a machine overturned a deterministic block

export interface AuditEvent {
  id: string;
  tenant_id: string;
  actor: string;
  actor_type: 'de' | 'human' | 'system';
  action: string;
  category: AuditCategory;
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  created_at: string;
}

import { raise, requireTenantId } from './liveShared';


// ── Guardrail rules CRUD ──────────────────────────────────────────

/**
 * The workspace's WORKING list of guardrails — retired rules excluded.
 *
 * ⚠ The exclusion lives here, in the one loader, deliberately. Five surfaces
 * call this (this page, the per-employee ScopedGuardrails panel, the hire
 * wizard, Company Setup, and the governance assistant's proposal targeting),
 * and a retired rule must be invisible to all of them — including as the target
 * of an assistant "resume" proposal. Excluding it at each call site would be
 * five chances to forget.
 */
export async function listGuardrailRules(): Promise<GuardrailRule[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('guardrail_rules')
    .select('*')
    .eq('tenant_id', tid)
    .is('retired_at', null)
    .order('created_at', { ascending: true });
  if (error) raise('listGuardrailRules', error);
  return (data ?? []) as GuardrailRule[];
}

/** The retired shelf — newest first. Loaded only when someone asks to see it;
 *  the point of retiring is that these stay out of the way while remaining
 *  recoverable and still able to explain an old block. */
export async function listRetiredGuardrailRules(): Promise<GuardrailRule[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('guardrail_rules')
    .select('*')
    .eq('tenant_id', tid)
    .not('retired_at', 'is', null)
    .order('retired_at', { ascending: false });
  if (error) raise('listRetiredGuardrailRules', error);
  return (data ?? []) as GuardrailRule[];
}

/**
 * How many times each rule has actually stopped something, and when it last
 * did. Keyed by rule id; a rule that has never fired is simply absent.
 *
 * A rule that fires daily and a rule that has never fired once look identical
 * in a list of rules — same row, same toggle — and they need completely
 * different attention. One is load-bearing; the other is either redundant or
 * written so it can never match.
 *
 * ⚠ The block→rule link was recorded as UNVERIFIED in the design handoff. It
 * exists: guardrail blocks write `rule_id` into audit_events.detail, and 25 of
 * the 28 that carry one resolve to a live rule. The other 3 point at rules
 * that no longer exist, which is why this counts by joining IN SQL terms here
 * — an unresolvable id contributes to nothing rather than to a wrong row.
 */
export async function getGuardrailBlockCounts(sinceDays = 30): Promise<Record<string, { count: number; last_at: string }>> {
  const tid = await requireTenantId();
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const { data, error } = await supabase
    .from('audit_events')
    .select('detail, created_at')
    .eq('tenant_id', tid)
    .eq('category', 'guardrail_block')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(2000);
  // A missing count must never take the rules list down with it — the rules
  // themselves are the point of the page; the counts are commentary.
  if (error) return {};
  const out: Record<string, { count: number; last_at: string }> = {};
  for (const row of (data ?? []) as { detail: Record<string, unknown> | null; created_at: string }[]) {
    const id = typeof row.detail?.rule_id === 'string' ? row.detail.rule_id : null;
    if (!id) continue;
    if (out[id]) out[id].count += 1;
    else out[id] = { count: 1, last_at: row.created_at };   // ordered desc, so the first is the latest
  }
  return out;
}

export async function addGuardrailRule(
  r: Partial<GuardrailRule> & { rule: string; rule_type: GuardrailRuleType }
): Promise<GuardrailRule> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('guardrail_rules')
    .insert({ ...r, tenant_id: tid, created_by: user?.id ?? null })
    .select()
    .single();
  if (error) raise('addGuardrailRule', error);
  const rule = data as GuardrailRule;
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Guardrail added — "${rule.rule}" (${rule.rule_type}, ${rule.severity})`,
    detail: { rule_id: rule.id, rule_type: rule.rule_type, version: rule.version },
  });
  return rule;
}

/** Edit a rule — version increments; the change is audited. */
export async function updateGuardrailRule(
  rule: GuardrailRule,
  updates: Partial<Pick<GuardrailRule, 'rule' | 'pattern' | 'threshold' | 'applies_to' | 'severity' | 'active'>>
): Promise<GuardrailRule> {
  const tid = await requireTenantId();
  // A retired rule cannot be switched back on from here. The database CHECK
  // (mig 726) refuses it anyway — this turns a 23514 into a sentence, and it
  // covers the assistant's "resume" proposal path too, which reaches this same
  // function with { active: true } and would otherwise surface the raw error.
  if (rule.retired_at && updates.active === true) {
    throw new CustomerApiError('This guardrail is retired. Restore it first, then switch it on.', false);
  }
  const { data, error } = await supabase
    .from('guardrail_rules')
    .update({ ...updates, version: rule.version + 1 })
    .eq('id', rule.id)
    .eq('tenant_id', tid)
    .select()
    .single();
  if (error) raise('updateGuardrailRule', error);
  const next = data as GuardrailRule;
  const what = updates.active === false ? 'deactivated'
    : updates.active === true ? 'reactivated'
    : 'updated';
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Guardrail ${what} — "${next.rule}" (v${rule.version} → v${next.version})`,
    detail: { rule_id: next.id, changes: updates as Record<string, unknown>, version: next.version },
  });
  return next;
}

/**
 * Take a guardrail out of the working list without destroying it (mig 726).
 *
 * ⚠ NOT A DELETE, and there is no delete to fall back to: `authenticated` holds
 * no DELETE grant on guardrail_rules, so a hand-rolled `.delete()` fails 42501
 * at the table grant before RLS is ever consulted. That grant stays shut on
 * purpose — audit_events.detail records a block by `rule_id` and nothing else,
 * so a deleted row turns every block it ever caused into an unexplainable one.
 *
 * The RPC does the whole thing in one transaction: it checks owner/admin,
 * refuses compliance-pack rules (detach the pack instead), sets
 * `active = false` — which is what actually stops enforcement, because every
 * reader filters on `active` — and writes the audit row. No audit row, no
 * retirement.
 */
export async function retireGuardrailRule(rule: GuardrailRule, reason?: string): Promise<void> {
  // ⚠ .rpc() RESOLVES on a Postgres error — the error lives on the result, not
  // in a rejection. Reading it is the difference between a refusal and a
  // silently successful-looking no-op.
  const { error } = await supabase.rpc('retire_guardrail_rule', {
    p_rule_id: rule.id,
    p_reason: reason?.trim() ? reason.trim() : null,
  });
  if (error) raise('retireGuardrailRule', error);
}

/** Put a retired guardrail back in the list. It returns SWITCHED OFF — undoing
 *  the filing decision is not the same as deciding to enforce it again, and a
 *  rule that quietly resumed blocking because someone clicked "restore" would
 *  be the same surprise in the other direction. */
export async function restoreGuardrailRule(rule: GuardrailRule): Promise<void> {
  const { error } = await supabase.rpc('restore_guardrail_rule', { p_rule_id: rule.id });
  if (error) raise('restoreGuardrailRule', error);
}

// ── What is actually enforced (mig 726) ───────────────────────────────────
// The Compliance page used to print the literal string 'Live' in an
// "Enforcement" tile, derived from nothing. Three separate layers decide the
// real answer and two of them are configured platform-side, in a table
// `authenticated` cannot read at all — hence an RPC that mirrors the two
// edge-function gates and returns only booleans and mode words.

export interface EnforcementStatus {
  /** Deterministic pattern matching. `live` is structurally true — it is
   *  unconditional code, not a flag — so the number is the load-bearing part:
   *  zero blocking rules means the check runs and has nothing to enforce. */
  patterns: { live: boolean; blocking_rules: number };
  /** The meaning judge (_shared/guardrailJudge.ts). `shadow` logs a verdict and
   *  never blocks; only `enforce` withholds an answer. */
  semantic: { enabled: boolean; mode: 'shadow' | 'enforce' | null };
  /** The adjudicator (_shared/guardrailAdjudicator.ts) — the only thing that can
   *  UN-block. `shadow` records `would_clear` and applies nothing. */
  adjudication: { enabled: boolean; mode: 'shadow' | 'enforce' | null };
}

/**
 * Read the three enforcement layers for this workspace.
 *
 * Returns null when it could not be established — and the caller must SAY so
 * rather than fall back to a confident word. A tile that prints "Live" because
 * a read failed is the defect this replaces, not a graceful degradation.
 */
export async function getEnforcementStatus(): Promise<EnforcementStatus | null> {
  try {
    const tid = await requireTenantId();
    const { data, error } = await supabase.rpc('guardrail_enforcement_status', { p_tenant_id: tid });
    if (error || !data) return null;
    const d = data as Partial<EnforcementStatus>;
    const mode = (m: unknown): 'shadow' | 'enforce' | null =>
      m === 'enforce' ? 'enforce' : m === 'shadow' ? 'shadow' : null;
    return {
      patterns: {
        live: d.patterns?.live === true,
        blocking_rules: Number(d.patterns?.blocking_rules ?? 0),
      },
      semantic: { enabled: d.semantic?.enabled === true, mode: mode(d.semantic?.mode) },
      adjudication: { enabled: d.adjudication?.enabled === true, mode: mode(d.adjudication?.mode) },
    };
  } catch {
    return null;
  }
}

/** Starter guardrails for a tenant with zero rules. */
export const STARTER_GUARDRAILS: Array<Partial<GuardrailRule> & { rule: string; rule_type: GuardrailRuleType }> = [
  {
    rule: 'No contractual guarantees or legal commitments in DE answers',
    rule_type: 'blocked_phrase', pattern: 'guarantee|guaranteed|we promise|legally binding|indemnif',
    severity: 'blocking',
  },
  {
    rule: 'No legal advice — route to a human specialist',
    rule_type: 'blocked_topic', pattern: 'legal advice|attorney|lawsuit|sue |liability waiver',
    severity: 'blocking',
  },
  {
    rule: 'Invoices over $10,000 require human approval before sending',
    rule_type: 'require_approval_over_cents', threshold: 1_000_000,
    severity: 'blocking',
  },
  {
    rule: 'Max 20% discount without VP approval',
    rule_type: 'max_discount_pct', threshold: 20,
    severity: 'blocking',
  },
];

export async function installStarterGuardrails(): Promise<GuardrailRule[]> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('guardrail_rules')
    .insert(STARTER_GUARDRAILS.map(r => ({ ...r, tenant_id: tid, created_by: user?.id ?? null })))
    .select();
  if (error) raise('installStarterGuardrails', error);
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Starter guardrails installed — ${STARTER_GUARDRAILS.length} rules (approval threshold, blocked topics/phrases, discount cap)`,
    detail: { count: STARTER_GUARDRAILS.length },
  });
  return (data ?? []) as GuardrailRule[];
}

/** The tenant's active invoice-approval threshold (cents). Falls back to
 *  $10K when no rule exists or the table isn't provisioned yet. */
export const DEFAULT_APPROVAL_THRESHOLD_CENTS = 10_000 * 100;

export async function getApprovalThresholdCents(): Promise<{ cents: number; fromRule: boolean }> {
  try {
    const tid = await requireTenantId();
    const { data, error } = await supabase
      .from('guardrail_rules')
      .select('threshold')
      .eq('tenant_id', tid)
      .eq('rule_type', 'require_approval_over_cents')
      .eq('active', true)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0 || typeof data[0].threshold !== 'number') {
      return { cents: DEFAULT_APPROVAL_THRESHOLD_CENTS, fromRule: false };
    }
    return { cents: data[0].threshold, fromRule: true };
  } catch {
    return { cents: DEFAULT_APPROVAL_THRESHOLD_CENTS, fromRule: false };
  }
}

// ── Immutable audit events ────────────────────────────────────────

/** Append to the tenant's hash-chained audit log via the RPC.
 *  Best-effort: audit failures never break the business action
 *  (they are logged to console) — except when the caller opts in. */
export async function appendAuditEvent(e: {
  actor: string;
  actor_type: 'de' | 'human' | 'system';
  action: string;
  category: AuditCategory;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const tid = await requireTenantId();
    const { error } = await supabase.rpc('append_audit_event', {
      p_tenant_id: tid,
      p_actor: e.actor,
      p_actor_type: e.actor_type,
      p_action: e.action,
      p_category: e.category,
      p_detail: e.detail ?? {},
    });
    if (error) console.error('appendAuditEvent:', error.message);
  } catch (err) {
    console.error('appendAuditEvent:', err);
  }
}

/**
 * Tenant-wide audit events, newest-first.
 * @param days  Time window in days (e.g. 7). Pass null for all-time.
 * @param limit Row cap (default 500 — a wide window can be busy).
 */
export async function listAuditEvents(days: number | null = 7, limit = 500): Promise<AuditEvent[]> {
  const tid = await requireTenantId();
  let q = supabase
    .from('audit_events')
    .select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (days != null) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    q = q.gte('created_at', since);
  }
  const { data, error } = await q;
  if (error) raise('listAuditEvents', error);
  return (data ?? []) as AuditEvent[];
}

export interface ChainVerification {
  intact: boolean;
  checked: number;
  broken_at: string | null;
  /** Why it failed, when it did — the server names the specific check. */
  reason: string | null;
  /** Records sharing a parent. Non-zero is only acceptable while every one of
   *  them is recorded in audit_chain_anomalies; an unrecorded fork fails. */
  forks: number;
  known_anomalies: number;
}

/**
 * Server-side verification of the tenant's full chain (mig 549). Three checks,
 * none of which assume any ordering: every row's hash matches its own contents,
 * every row is reachable from genesis (which catches deletions the old
 * timestamp-ordered walk could not), and no record has an unrecorded sibling.
 */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('verify_audit_chain', { p_tenant_id: tid });
  if (error) raise('verifyAuditChain', error);
  const d = data as {
    intact?: boolean; checked?: number; broken_at?: string | null;
    reason?: string | null; forks?: number; known_anomalies?: number;
  };
  return {
    intact: !!d?.intact,
    checked: Number(d?.checked ?? 0),
    broken_at: d?.broken_at ?? null,
    reason: d?.reason ?? null,
    forks: Number(d?.forks ?? 0),
    known_anomalies: Number(d?.known_anomalies ?? 0),
  };
}

// ── GI-10: guardrail adjudication ───────────────────────────────────────────
// A machine may clear a deterministic guardrail match ONLY on a rule a human
// has explicitly opted in, with a written justification. These are the read and
// write surfaces for that decision; the write is an RPC, never a table update —
// guardrail_rule_adjudicable revokes INSERT/UPDATE/DELETE from authenticated
// precisely so the permission cannot be granted without the audit record.

export interface AdjudicableGrant {
  rule_id: string;
  granted_at: string;
  justification: string;
}

export interface Adjudication {
  id: string;
  de_id: string | null;
  conversation_id: string | null;
  rule_id: string | null;
  rule_text: string | null;
  matched_text: string | null;
  assessment: 'describes' | 'enacts' | 'unclear' | 'error' | null;
  confidence: number | null;
  rationale: string | null;
  model: string | null;
  provider: string | null;
  mode: 'shadow' | 'enforce' | null;
  would_clear: boolean;
  applied: boolean;
  reason: string | null;
  cache_hit: boolean | null;
  duration_ms: number | null;
  content_preview: string | null;
  question_preview: string | null;
  created_at: string;
}

/** Which rules a human has made machine-clearable in this workspace. */
export async function listAdjudicableRules(): Promise<AdjudicableGrant[]> {
  const { data, error } = await supabase
    .from('guardrail_rule_adjudicable')
    .select('rule_id, granted_at, justification');
  if (error) throw error;
  return (data ?? []) as AdjudicableGrant[];
}

/**
 * Grant or revoke "a machine may clear a false match on this rule".
 * Owner/admin only, 40-character justification required, and compliance-pack
 * rules additionally need the owner override — all enforced server-side.
 */
export async function setRuleAdjudicable(ruleId: string, on: boolean, justification: string) {
  const { data, error } = await supabase.rpc('set_rule_adjudicable', {
    p_rule_id: ruleId, p_on: on, p_justification: justification,
  });
  if (error) throw error;
  return data;
}

/** The decision log — every adjudication, both shadow and enforce. */
export async function listAdjudications(days = 30, limit = 200): Promise<Adjudication[]> {
  let q = supabase.from('guardrail_adjudications')
    .select('id, de_id, conversation_id, rule_id, rule_text, matched_text, assessment, confidence, rationale, model, provider, mode, would_clear, applied, reason, cache_hit, duration_ms, content_preview, question_preview, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (days !== null) {
    q = q.gte('created_at', new Date(Date.now() - days * 86400_000).toISOString());
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Adjudication[];
}
