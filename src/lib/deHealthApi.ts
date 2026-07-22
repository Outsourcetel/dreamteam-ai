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

export type DevelopmentItemType = 'confidence_gap' | 'escalation_spike' | 'error_rate' | 'guardrail_pattern' | 'manual';
export type DevelopmentItemStatus = 'proposed' | 'in_progress' | 'completed' | 'dismissed';

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
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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
  incident_active: { label: 'Incident', color: 'bg-rose-500/15 text-rose-300' },
  degraded: { label: 'Degraded', color: 'bg-amber-500/15 text-amber-300' },
  low_confidence: { label: 'Low confidence', color: 'bg-amber-500/15 text-amber-300' },
  high_cost: { label: 'High cost', color: 'bg-orange-500/15 text-orange-300' },
  improving: { label: 'Improving', color: 'bg-sky-500/15 text-sky-300' },
  healthy: { label: 'Healthy', color: 'bg-emerald-500/15 text-emerald-300' },
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
