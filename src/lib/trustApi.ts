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

export type TrustCategory = 'invoice_auto_send' | 'answer_dock' | 'answer_widget';

export interface TrustPolicy {
  id: string;
  tenant_id: string;
  de_id: string | null;
  action_category: TrustCategory;
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
  action_category: TrustCategory;
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

/** Server-computed evidence for a category (never asserted client-side). */
export async function computeTrustEvidence(category: TrustCategory, deId: string | null = null): Promise<TrustEvidence> {
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
