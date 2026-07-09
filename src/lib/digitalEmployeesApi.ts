// ============================================================
// Digital Employees — roster + the generic "Add a Digital Employee"
// capability (migration 037). Domain-agnostic: works for any future
// DE (Account, Finance, Onboarding, …), not just one department.
// ============================================================
import { supabase } from '../supabase';
import { raise, listTenantRows } from './liveShared';

export interface DigitalEmployee {
  id: string;
  tenant_id: string;
  name: string;
  persona_name: string | null;
  description: string;
  category: string;
  department: string;
  status: string;
  lifecycle_status: string;
  trust_level: 'supervised' | 'established' | 'trusted' | 'autonomous';
  confidence_threshold: number;
  required_approval: boolean;
  created_at: string;
  /** Wave 2 (migration 110) — governance triad */
  config_version: number;
  owner_id: string | null;
  icon: string | null;
  model_provider: string | null;
  model_id: string | null;
  task_type: string | null;
  escalation_model_id: string | null;
  escalation_threshold: number | null;
}

export async function listDigitalEmployees(): Promise<DigitalEmployee[]> {
  return listTenantRows<DigitalEmployee>('digital_employees', 'created_at', true, 'listDigitalEmployees');
}

export interface CreateDEInput {
  name: string;
  description?: string;
  category?: string;
  department?: string;
  personaName?: string;
  trustLevel?: 'supervised' | 'established' | 'trusted' | 'autonomous';
  confidenceThreshold?: number;
  requiredApproval?: boolean;
}

/** Creates a new Digital Employee persona row. Admin/owner role only
 *  (enforced server-side) — the RPC validates and audits the change.
 *  This is intentionally generic: no department-specific fields. */
export async function createDigitalEmployee(input: CreateDEInput): Promise<DigitalEmployee> {
  const { data, error } = await supabase.rpc('create_digital_employee', {
    p_name: input.name,
    p_description: input.description ?? '',
    p_category: input.category ?? 'Customer',
    p_department: input.department ?? '',
    p_persona_name: input.personaName ?? null,
    p_trust_level: input.trustLevel ?? 'supervised',
    p_confidence_threshold: input.confidenceThreshold ?? 75,
    p_required_approval: input.requiredApproval ?? false,
  });
  if (error) raise('createDigitalEmployee', error);
  return data as DigitalEmployee;
}

// ============================================================
// Wave 2 (migration 110) — the governance triad: config editing +
// versioning, ownership + transfer, retirement with real dependency
// checks. See docs/10_Digital_Workforce_Framework.md §13.5-13.7.
// ============================================================

export interface UpdateDEInput {
  name?: string;
  personaName?: string;
  description?: string;
  department?: string;
  icon?: string;
  confidenceThreshold?: number;
  requiredApproval?: boolean;
  modelProvider?: string;
  modelId?: string;
  taskType?: string;
  escalationModelId?: string;
  escalationThreshold?: number;
}

/** Edits a DE's config (owner/admin only). Excludes trust_level
 *  (governed by the evidence-gated promotion flow) and status/
 *  lifecycle_status (governed by retireDigitalEmployee below).
 *  config_version only increments when something genuinely changed. */
export async function updateDigitalEmployee(deId: string, input: UpdateDEInput): Promise<DigitalEmployee> {
  const { data, error } = await supabase.rpc('update_digital_employee', {
    p_de_id: deId,
    p_name: input.name ?? null,
    p_persona_name: input.personaName ?? null,
    p_description: input.description ?? null,
    p_department: input.department ?? null,
    p_icon: input.icon ?? null,
    p_confidence_threshold: input.confidenceThreshold ?? null,
    p_required_approval: input.requiredApproval ?? null,
    p_model_provider: input.modelProvider ?? null,
    p_model_id: input.modelId ?? null,
    p_task_type: input.taskType ?? null,
    p_escalation_model_id: input.escalationModelId ?? null,
    p_escalation_threshold: input.escalationThreshold ?? null,
  });
  if (error) raise('updateDigitalEmployee', error);
  return data as DigitalEmployee;
}

/** The full before/after diff history for one DE — reuses the
 *  tenant_activity_log trigger that already fires on every
 *  digital_employees write (migration 066/067), filtered to this
 *  row rather than building a second audit mechanism. */
export interface DEConfigHistoryEntry {
  id: number;
  operation: string;
  actor_name: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: string;
}

export async function getDEConfigHistory(deId: string): Promise<DEConfigHistoryEntry[]> {
  const { data, error } = await supabase
    .from('tenant_activity_log')
    .select('id, operation, actor_name, old_data, new_data, created_at')
    .eq('table_name', 'digital_employees')
    .eq('row_pk', deId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) raise('getDEConfigHistory', error);
  return (data ?? []) as DEConfigHistoryEntry[];
}

/** Hands ownership of a DE to another active member of the workspace
 *  (owner/admin only). A narrative audited event, not just a column
 *  edit — docs §13.6: "Transfer is an audited event." */
export async function transferDeOwnership(deId: string, newOwnerUserId: string, note?: string): Promise<DigitalEmployee> {
  const { data, error } = await supabase.rpc('transfer_de_ownership', {
    p_de_id: deId, p_new_owner_user_id: newOwnerUserId, p_note: note ?? null,
  });
  if (error) raise('transferDeOwnership', error);
  return data as DigitalEmployee;
}

export interface RetirementBlocker { kind: string; count: number; message: string }
export interface RetirementReadiness {
  de_id: string;
  ready: boolean;
  open_conversations: number;
  pending_approvals: number;
  playbook_assignments: number;
  active_charter_bindings: number;
  blockers: RetirementBlocker[];
}

/** docs §13.7 step 2: real, verifiable dependency counts — never a
 *  guess. Call before offering the Retire action so the UI can show
 *  exactly what's blocking, not just a generic "can't retire" error. */
export async function checkDeRetirementReadiness(deId: string): Promise<RetirementReadiness> {
  const { data, error } = await supabase.rpc('check_de_retirement_readiness', { p_de_id: deId });
  if (error) raise('checkDeRetirementReadiness', error);
  return data as RetirementReadiness;
}

/** Retires a DE — refused server-side (not just discouraged) while
 *  real dependencies remain open (docs §15.10: "No shortcut
 *  retirement paths exist"). Never deletes the row; this is terminal
 *  and cannot be reversed once it succeeds. */
export async function retireDigitalEmployee(deId: string, reason: string): Promise<DigitalEmployee> {
  const { data, error } = await supabase.rpc('retire_digital_employee', { p_de_id: deId, p_reason: reason });
  if (error) raise('retireDigitalEmployee', error);
  return data as DigitalEmployee;
}
