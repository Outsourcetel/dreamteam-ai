// DE Workbench — read layer that finally surfaces the Wave 1-3 "muscles"
// (memory, work queue, decision trace, exceptions, compliance, certification,
// training) in the UI. Every table has an RLS SELECT policy scoping to the
// caller's tenant (migs 155-163), so a de_id filter is sufficient and safe.
import { supabase } from '../supabase';

export interface MemoryRow { id: string; content: string; kind: string; subject_kind: string; subject_ref: string | null; salience: number; created_at: string }
export interface ObjectiveRow { id: string; title: string; status: string; priority: number; due_at: string | null; created_at: string }
export interface WorkItemRow { id: string; title: string; kind: string; status: string; scheduled_for: string; attempts: number; last_error: string | null; result: Record<string, unknown> | null; created_at: string }
export interface TraceRow { id: string; run_ref: string | null; run_kind: string; seq: number; thought: string | null; tool: string | null; inputs: Record<string, unknown> | null; outputs: Record<string, unknown> | null; created_at: string }
export interface ExceptionRow { id: string; situation: string; proposed_action: string; justification: string; status: string; outcome: string | null; learned: boolean; created_at: string }
export interface CertRow { id: string; archetype_key: string | null; score_pct: number; threshold_pct: number; status: string; evaluated_at: string | null; created_at: string }
export interface CertStatus { state: 'certified' | 'stale' | 'failed' | 'uncertified' | 'unknown'; fresh: boolean; latest_passed: { score_pct: number; evaluated_at: string | null; archetype_key: string | null } | null; latest_status: string | null }
export interface TrainingRow { module_key: string; status: string; completed_at: string | null }
export interface CompliancePackRow { pack_key: string; attached_at: string; name?: string; domain?: string }

export const getDeMemory = async (deId: string, limit = 40): Promise<MemoryRow[]> => {
  const { data, error } = await supabase.from('de_memory')
    .select('id, content, kind, subject_kind, subject_ref, salience, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as MemoryRow[];
};

export const getDeObjectives = async (deId: string): Promise<ObjectiveRow[]> => {
  const { data, error } = await supabase.from('de_objectives')
    .select('id, title, status, priority, due_at, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as ObjectiveRow[];
};

export const getDeWorkItems = async (deId: string): Promise<WorkItemRow[]> => {
  const { data, error } = await supabase.from('de_work_items')
    .select('id, title, kind, status, scheduled_for, attempts, last_error, result, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as WorkItemRow[];
};

export const getDeTrace = async (deId: string, limit = 60): Promise<TraceRow[]> => {
  const { data, error } = await supabase.from('de_decision_trace')
    .select('id, run_ref, run_kind, seq, thought, tool, inputs, outputs, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as TraceRow[];
};

export const getDeExceptions = async (deId: string): Promise<ExceptionRow[]> => {
  const { data, error } = await supabase.from('de_exceptions')
    .select('id, situation, proposed_action, justification, status, outcome, learned, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(30);
  if (error) throw error;
  return (data ?? []) as ExceptionRow[];
};

export const getDeCertifications = async (deId: string): Promise<CertRow[]> => {
  const { data, error } = await supabase.from('role_certifications')
    .select('id, archetype_key, score_pct, threshold_pct, status, evaluated_at, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(10);
  if (error) throw error;
  return (data ?? []) as CertRow[];
};

// Whether the DE's passing certification still vouches for its CURRENT config.
// state: certified (fresh) | stale (config changed since last pass) | failed | uncertified.
export const getDeCertStatus = async (deId: string): Promise<CertStatus | null> => {
  const { data, error } = await supabase.rpc('de_certification_status', { p_de_id: deId });
  if (error) throw error;
  return (data ?? null) as CertStatus | null;
};

export const getDeTraining = async (deId: string): Promise<TrainingRow[]> => {
  const { data, error } = await supabase.from('de_training_progress')
    .select('module_key, status, completed_at')
    .eq('de_id', deId).order('module_key', { ascending: true });
  if (error) throw error;
  return (data ?? []) as TrainingRow[];
};

// Compliance packs are tenant-scoped (not per-DE), but relevant on the DE
// workbench because attached packs enforce guardrails on every DE.
export const getTenantCompliancePacks = async (): Promise<CompliancePackRow[]> => {
  const { data, error } = await supabase.from('tenant_compliance_packs')
    .select('pack_key, attached_at, compliance_packs(name, domain)')
    .order('attached_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{ pack_key: string; attached_at: string; compliance_packs?: { name?: string; domain?: string } | { name?: string; domain?: string }[] }>).map((r) => {
    const pack = Array.isArray(r.compliance_packs) ? r.compliance_packs[0] : r.compliance_packs;
    return { pack_key: r.pack_key, attached_at: r.attached_at, name: pack?.name, domain: pack?.domain };
  });
};
