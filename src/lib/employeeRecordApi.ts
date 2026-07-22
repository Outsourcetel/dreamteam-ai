// The living employment record (Tier-1 surfacing) — reads the rich, populated
// datasets the Employee File was sitting on but never showing: evidence-earned
// skills, the lived-experience ledger, and per-run execution telemetry (which
// shows the actual model that served each answer — the failover, per reply).
// All three go through mig-259 SECURITY DEFINER, tenant-gated RPCs.
import { supabase } from '../supabase';

export interface DeSkill {
  skill_key: string;
  proficiency: number;        // 0–5, evidence-assessed
  sample_size: number;        // how much evidence backs it
  signal_value: number | null;
  detail: string | null;
  assessed_at: string | null;
}

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

// Human labels for the evidence-assessed competencies (mig skill cron).
export const SKILL_LABELS: Record<string, { label: string; blurb: string }> = {
  case_resolution: { label: 'Case resolution', blurb: 'Closing work correctly without a human' },
  judgment_calibration: { label: 'Judgment calibration', blurb: 'Knowing when to act vs. escalate' },
  domain_grounding: { label: 'Domain grounding', blurb: 'Answering from real knowledge, not guesses' },
  communication_quality: { label: 'Communication', blurb: 'Clear, on-brand customer replies' },
  system_integration: { label: 'System integration', blurb: 'Operating connected tools reliably' },
};

export async function getDeSkills(deId: string): Promise<DeSkill[]> {
  const { data, error } = await supabase.rpc('get_de_skills', { p_de_id: deId });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? 'could not load skills');
  return (data.skills ?? []) as DeSkill[];
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
