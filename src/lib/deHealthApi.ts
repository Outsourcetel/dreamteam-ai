// ============================================================
// Wave 4 (Development Plans) + Wave 5 (DE Health) — migration 112.
// Both scoped deliberately narrower than the full docs/10 spec,
// built only on signals that are already real and live
// (get_de_performance_metrics/093, get_de_guardrail_activity/096,
// get_de_cost_metrics/094). See the migration's own header comment
// for exactly what was left out and why (Certifications, Skills
// proficiency, Capability primary/backup, Workforce Teams, FTE
// Equivalent/ROI — all would require fabricating data that doesn't
// exist anywhere in this codebase today).
// ============================================================
import { supabase } from '../supabase';
import { raise, requireTenantId } from './liveShared';

// Synced with the LIVE check constraints (docs/31 Q10): the DB also holds
// 'skill_gap' (consolidated skills flag) and 'pip' (opened by a below-verdict
// review), and a 'failed' status a missed PIP lands in — the UI must render
// all of them, not filter them out of existence.
export type DevelopmentItemType = 'confidence_gap' | 'escalation_spike' | 'error_rate' | 'guardrail_pattern' | 'skill_gap' | 'pip' | 'manual';
export type DevelopmentItemStatus = 'proposed' | 'in_progress' | 'completed' | 'dismissed' | 'failed';

/** One machine attempt recorded on a development item by the daily
 *  development-program worker (docs/31 decision #3). Written server-side
 *  only; the UI renders it read-only. */
export interface DEDevelopmentAttempt {
  at: string;
  action: 'knowledge_gap_refresh' | 'answer_quality_improve' | 'no_candidate';
  note?: string;
  /** True when another open item on the same DE triggered the dispatch and
   *  this item is covered by the same improvement draft. */
  shared?: boolean;
  gap_cluster_id?: string;
  judgment_id?: string;
  /** Consecutive no-candidate mornings collapse into one entry with a count. */
  times?: number;
}

export interface DEDevelopmentItem {
  id: string;
  tenant_id: string;
  de_id: string;
  item_type: DevelopmentItemType;
  source: 'detected' | 'manual';
  priority: 'low' | 'medium' | 'high';
  description: string;
  target_metric: string | null;
  target_value: number | null;
  baseline_value: number | null;
  status: DevelopmentItemStatus;
  assigned_to: string | null;
  due_date: string | null;
  /** The written consequence a PIP carries (live column; was stored but never displayed). */
  consequence: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** Machine-attempt log — absent until the development-program migration is applied. */
  attempts?: DEDevelopmentAttempt[] | null;
}

/** The improvement drafts the program's dispatches produced for this DE —
 *  joined client-side to attempts via judgment_id / gap_cluster_id so the
 *  card can say, honestly, where each attempt got to. */
export interface DEImprovementOutcome {
  id: string;
  judgment_id: string | null;
  gap_cluster_id: string | null;
  status: 'proposed' | 'replayed' | 'failed_replay' | 'review_pending' | 'approved' | 'applied' | 'rejected';
  proposed_title: string | null;
}

export async function listDeImprovementOutcomes(deId: string): Promise<DEImprovementOutcome[]> {
  const { data, error } = await supabase
    .from('de_improvements')
    .select('id, judgment_id, gap_cluster_id, status, proposed_title')
    .eq('de_id', deId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) raise('listDeImprovementOutcomes', error);
  return (data ?? []) as DEImprovementOutcome[];
}

export async function listDeDevelopmentItems(deId: string): Promise<DEDevelopmentItem[]> {
  const { data, error } = await supabase
    .from('de_development_items')
    .select('*')
    .eq('de_id', deId)
    .order('created_at', { ascending: false });
  if (error) raise('listDeDevelopmentItems', error);
  return (data ?? []) as DEDevelopmentItem[];
}

/** Scans real 8-week performance data (escalation rate, confidence,
 *  error rate, guardrail-block ratio) and proposes/refreshes
 *  development items for whatever genuinely crosses an evidence-based
 *  threshold — never fabricated, and a DE can get more than one item
 *  at once if more than one signal is real. Owner/admin only. */
export async function detectDeDevelopmentNeeds(): Promise<DEDevelopmentItem[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('detect_de_development_needs', { p_tenant_id: tid });
  if (error) raise('detectDeDevelopmentNeeds', error);
  return (data ?? []) as DEDevelopmentItem[];
}

export async function createDeDevelopmentItem(deId: string, input: {
  description: string; targetMetric?: string; targetValue?: number;
  priority?: 'low' | 'medium' | 'high'; dueDate?: string; assignedTo?: string;
}): Promise<DEDevelopmentItem> {
  const { data, error } = await supabase.rpc('create_de_development_item', {
    p_de_id: deId, p_description: input.description,
    p_target_metric: input.targetMetric ?? null, p_target_value: input.targetValue ?? null,
    p_priority: input.priority ?? 'medium', p_due_date: input.dueDate ?? null, p_assigned_to: input.assignedTo ?? null,
  });
  if (error) raise('createDeDevelopmentItem', error);
  return data as DEDevelopmentItem;
}

export async function updateDeDevelopmentItemStatus(itemId: string, status: DevelopmentItemStatus): Promise<DEDevelopmentItem> {
  const { data, error } = await supabase.rpc('update_de_development_item_status', { p_item_id: itemId, p_status: status });
  if (error) raise('updateDeDevelopmentItemStatus', error);
  return data as DEDevelopmentItem;
}

// ── DE Health (Wave 5) ─────────────────────────────────────────────

export type DEHealthState =
  | 'retired' | 'incident_active' | 'degraded' | 'low_confidence'
  | 'high_cost' | 'improving' | 'healthy' | 'insufficient_data';

export interface DEHealth {
  de_id: string;
  de_name: string;
  state: DEHealthState;
  signals: Record<string, unknown>;
  total_decisions: number;
  avg_confidence: number | null;
  escalation_rate: number | null;
  error_rate: number | null;
  recent_guardrail_blocks: number;
  cost_this_period_usd: number;
  cost_per_task_usd: number | null;
}

export const DE_HEALTH_LABELS: Record<DEHealthState, { label: string; color: string }> = {
  retired: { label: 'Retired', color: 'bg-dt-neutral-soft text-dt-neutral' },
  incident_active: { label: 'Incident', color: 'bg-dt-danger-soft text-dt-danger' },
  degraded: { label: 'Degraded', color: 'bg-dt-warn-soft text-dt-warn' },
  low_confidence: { label: 'Low confidence', color: 'bg-dt-warn-soft text-dt-warn' },
  // orange: non-core hue, kept as its own state-identity distinct from the
  // amber 'degraded'/'low_confidence' states in this 7-member health
  // vocabulary — made opaque per the mapping table's "non-semantic identity
  // hues keep their hue" rule.
  high_cost: { label: 'High cost', color: 'bg-orange-600 text-orange-100' },
  improving: { label: 'Improving', color: 'bg-dt-info-soft text-dt-info' },
  healthy: { label: 'Healthy', color: 'bg-dt-ok-soft text-dt-ok' },
  insufficient_data: { label: 'Not enough data yet', color: 'bg-dt-neutral-soft text-dt-neutral' },
};

/** Real per-DE health, composed only from signals that already exist
 *  live (resolution/confidence/escalation, guardrail activity, cost).
 *  Deliberately implements only the subset of docs §11.2's 11 states
 *  that have a real, attributable-per-DE signal today — see the
 *  migration's header comment for exactly what's excluded and why. */
export async function listDeHealth(): Promise<DEHealth[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('list_de_health', { p_tenant_id: tid });
  if (error) raise('listDeHealth', error);
  return (data ?? []) as DEHealth[];
}
