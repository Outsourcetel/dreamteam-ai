// ============================================================
// Self-Learning — LIVE data layer (migration 103).
//
// Detects recurring HUMAN CORRECTIONS of DE decisions (not unanswered
// questions — that's Knowledge Gaps' job). The signal is data that
// already flows today: evidence_run_decisions.decision = 'needs_review'
// joined to a human_tasks row that a human has actually decided.
//   - human REJECTED the DE's proposed answer -> 'correction' evidence
//   - human APPROVED despite the DE flagging it -> 'overcaution' evidence
// Clustering/promotion mirrors the proven Knowledge Gap Detection
// pipeline (070) exactly — embed, cosine-distance join-or-seed,
// threshold-promote into a real human_tasks review.
//
// Activation is real and immediate: approving a correction cluster
// inserts a new guardrail_rules row; approving an overcaution cluster
// loosens/deactivates the SPECIFIC rule the evidence shows was too
// strict. Both take effect on the very next guardrail evaluation for
// every DE type — no new enforcement code, since guardrail_rules is
// already the platform's one generic, tenant-authored gate.
// ============================================================
import { supabase } from '../supabase';
import { raise, requireTenantId } from './liveShared';

export interface LearningPolicy {
  id: string;
  tenant_id: string;
  category: string | null;
  min_cluster_size: number;
  window_days: number;
  similarity_threshold: number;
  enabled: boolean;
}

export interface LearnedBehaviorCluster {
  id: string;
  tenant_id: string;
  de_id: string;
  category: string | null;
  verdict_type: 'correction' | 'overcaution';
  representative_run_id: string;
  guardrail_rule_id: string | null;
  member_count: number;
  severity_score: number;
  status: 'open' | 'proposed' | 'resolved';
  proposed_rule: {
    action: 'insert_guardrail_rule' | 'loosen_guardrail_rule';
    rule_type?: string;
    suggested_pattern?: string;
    guardrail_rule_id?: string;
    current_rule_label?: string;
    current_pattern?: string;
    severity?: string;
    rationale: string;
  } | null;
  human_task_id: string | null;
  resulting_guardrail_rule_id: string | null;
  pre_fix_avg_confidence: number | null;
  fix_applied_at: string | null;
  recurred_after_fix: boolean;
  recurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface LearnedBehaviorClusterMember {
  id: string;
  cluster_id: string;
  evidence_run_id: string;
  human_task_id: string | null;
  similarity_to_representative: number | null;
  added_at: string;
}

export async function listLearningPolicies(): Promise<LearningPolicy[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('de_learning_policies').select('*')
    .eq('tenant_id', tid);
  if (error) raise('listLearningPolicies', error);
  return (data ?? []) as LearningPolicy[];
}

export async function listLearnedBehaviorClusters(): Promise<LearnedBehaviorCluster[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('de_learned_behavior_clusters').select('*')
    .eq('tenant_id', tid)
    .order('last_seen_at', { ascending: false });
  if (error) raise('listLearnedBehaviorClusters', error);
  return (data ?? []) as LearnedBehaviorCluster[];
}

/** The real evidence behind a cluster: which decisions make it up
 *  (real inquiry text), plus the human verdict on each. */
export async function getLearnedBehaviorClusterDetail(cluster: LearnedBehaviorCluster): Promise<{
  members: LearnedBehaviorClusterMember[];
  inquiries: Record<string, { inquiry: string; created_at: string }>;
}> {
  const { data: members, error } = await supabase
    .from('de_learned_behavior_cluster_members').select('*')
    .eq('cluster_id', cluster.id)
    .order('added_at', { ascending: true });
  if (error) raise('getLearnedBehaviorClusterDetail (members)', error);

  const ids = Array.from(new Set([cluster.representative_run_id, ...(members ?? []).map(m => m.evidence_run_id)]));
  let inquiries: Record<string, { inquiry: string; created_at: string }> = {};
  if (ids.length > 0) {
    const { data: runs, error: runsErr } = await supabase
      .from('evidence_runs').select('id, inquiry, created_at')
      .in('id', ids);
    if (runsErr) raise('getLearnedBehaviorClusterDetail (runs)', runsErr);
    inquiries = Object.fromEntries((runs ?? []).map(r => [r.id, { inquiry: r.inquiry, created_at: r.created_at }]));
  }
  return { members: (members ?? []) as LearnedBehaviorClusterMember[], inquiries };
}

/** Approve a proposed learned behavior — REALLY inserts (correction) or
 *  loosens/deactivates (overcaution) a guardrail_rules row. A human may
 *  override the suggested pattern/threshold before approving. */
export async function approveLearnedBehavior(
  clusterId: string,
  finalPattern?: string,
  finalThreshold?: number,
): Promise<{ ok: boolean; guardrail_rule_id?: string; error?: string }> {
  const { data, error } = await supabase.rpc('approve_learned_behavior', {
    p_cluster_id: clusterId,
    p_final_pattern: finalPattern ?? null,
    p_final_threshold: finalThreshold ?? null,
  });
  if (error) raise('approveLearnedBehavior', error);
  return data as { ok: boolean; guardrail_rule_id?: string; error?: string };
}

/** Reject a proposed learned behavior — reopens the cluster (it keeps
 *  accumulating for the next detection pass) rather than discarding
 *  the evidence. */
export async function rejectLearnedBehavior(clusterId: string, reason = ''): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('reject_learned_behavior', {
    p_cluster_id: clusterId,
    p_reason: reason,
  });
  if (error) raise('rejectLearnedBehavior', error);
  return data as { ok: boolean; error?: string };
}
