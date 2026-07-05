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
  | 'max_discount_pct';

export interface GuardrailRule {
  id: string;
  tenant_id: string;
  rule: string;
  rule_type: GuardrailRuleType;
  pattern: string | null;
  threshold: number | null;
  applies_to: string;
  severity: 'blocking' | 'warning';
  active: boolean;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type AuditCategory =
  | 'resolved' | 'escalated' | 'approval' | 'guardrail_check'
  | 'guardrail_block' | 'config_change' | 'playbook_step' | 'invoice'
  | 'connector_sync' | 'connector_action' | 'evidence_step' | 'access_control';

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

export async function listGuardrailRules(): Promise<GuardrailRule[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('guardrail_rules')
    .select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: true });
  if (error) raise('listGuardrailRules', error);
  return (data ?? []) as GuardrailRule[];
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

export async function listAuditEvents(limit = 200): Promise<AuditEvent[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('audit_events')
    .select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) raise('listAuditEvents', error);
  return (data ?? []) as AuditEvent[];
}

export interface ChainVerification { intact: boolean; checked: number; broken_at: string | null }

/** Server-side walk of the tenant's full chain — recomputes every hash. */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('verify_audit_chain', { p_tenant_id: tid });
  if (error) raise('verifyAuditChain', error);
  const d = data as { intact?: boolean; checked?: number; broken_at?: string | null };
  return { intact: !!d?.intact, checked: Number(d?.checked ?? 0), broken_at: d?.broken_at ?? null };
}
