// The living employment record — reads the rich, populated datasets the
// Employee File was sitting on but never showing: the lived-experience ledger,
// per-run execution telemetry (which model served each answer — the failover,
// per reply), and the autonomous-run reasoning transcript. Via mig-259/260
// SECURITY DEFINER, tenant-gated RPCs. (Skills/KPIs are NOT here — they were
// already surfaced by DeSkillsPanel/DeKpisPanel via list_de_skills.)
import { supabase } from '../supabase';

export interface DeExperience {
  id: string;
  category: string | null;
  fact_summary: { outcome?: string; decision_made?: string; what_happened?: string } | null;
  external_ref: string | null;
  created_at: string;
  from_action: boolean;
  from_evidence: boolean;
}

export interface DeRun {
  name: string;
  duration_ms: number | null;
  started_at: string;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  confidence: number | null;
  escalated: boolean | null;
  work_status: string | null;
  turns: number | null;
}

export async function getDeExperience(deId: string, limit = 40): Promise<DeExperience[]> {
  const { data, error } = await supabase.rpc('get_de_experience', { p_de_id: deId, p_limit: limit });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? 'could not load experience');
  return (data.experience ?? []) as DeExperience[];
}

export async function getDeExecutionLog(deId: string, limit = 25): Promise<DeRun[]> {
  const { data, error } = await supabase.rpc('get_de_execution_log', { p_de_id: deId, p_limit: limit });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? 'could not load execution log');
  return (data.runs ?? []) as DeRun[];
}

// ── Autonomous-run reasoning transcript (Tier-2, mig 260) ──
export interface AgenticRun {
  id: string;
  goal: string | null;
  status: string;
  iteration_count: number;
  cost_used_cents: number;
  tokens_used: number | null;
  created_at: string;
  completed_at: string | null;
}
export interface AgenticMessage {
  id: string;
  turn_index: number;
  role: string;
  content: unknown;
  created_at: string;
}

export async function getDeAgenticRuns(deId: string, limit = 15): Promise<AgenticRun[]> {
  const { data, error } = await supabase.rpc('get_de_agentic_runs', { p_de_id: deId, p_limit: limit });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? 'could not load runs');
  return (data.runs ?? []) as AgenticRun[];
}

export async function getAgenticRunMessages(runId: string): Promise<AgenticMessage[]> {
  const { data, error } = await supabase.rpc('get_agentic_run_messages', { p_run_id: runId });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? 'could not load transcript');
  return (data.messages ?? []) as AgenticMessage[];
}

// ── Dedicated work-product by role (mig 261) ──
// A DE's domain resolved generically from the system categories it operates
// (never a hardcoded department), plus what it has actually produced.
export interface RoleContext {
  department: string | null;
  category: string | null;
  is_specialist: boolean;
  domains: string[];              // system categories it's granted (crm, helpdesk, erp_financials…)
  archetype_key: string | null;
  archetype_name: string | null;
  archetype_domain: string | null;
  archetype_categories: string[];
}
export interface WorkProductAction {
  category: string | null;
  label: string;
  n: number;
  auto_n: number;
  gated_n: number;
  last_at: string | null;
}
export interface WorkProduct {
  conversations: { total: number; resolved: number; open: number; by_channel: Record<string, number> };
  actions: WorkProductAction[];
}

export async function getDeRoleContext(deId: string): Promise<RoleContext> {
  const { data, error } = await supabase.rpc('get_de_role_context', { p_de_id: deId });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? 'could not load role');
  return data as RoleContext;
}

export async function getDeWorkProduct(deId: string): Promise<WorkProduct> {
  const { data, error } = await supabase.rpc('get_de_work_product', { p_de_id: deId });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? 'could not load work product');
  return data as WorkProduct;
}

// ── Whole-workforce economics (mig 193 get_workforce_economics) ──
export interface WorkforceEconomics {
  digital_employees: number;
  playbook_runs: number;
  playbook_completed: number;
  human_minutes_saved: number;
  ai_cost_usd: number;
  est_value_usd: number | null;
  baseline_configured: boolean;
}

export async function getWorkforceEconomics(tenantId: string): Promise<WorkforceEconomics> {
  const { data, error } = await supabase.rpc('get_workforce_economics', { p_tenant_id: tenantId });
  if (error) throw new Error(error.message);
  return data as WorkforceEconomics;
}

/** Set the FTE baseline that converts saved minutes into a dollar value.
 *  Owner/admin only (enforced in the RPC). */
export async function setWorkforceFteCost(monthlyUsd: number): Promise<void> {
  const { error } = await supabase.rpc('set_workforce_baselines', { p_avg_fte_cost_monthly_usd: monthlyUsd });
  if (error) throw new Error(error.message);
}
