// ============================================================
// Digital Employees — roster + the generic "Add a Digital Employee"
// capability (migration 037). Domain-agnostic: works for any future
// DE (Account, Finance, Onboarding, …), not just one department.
// ============================================================
import { supabase } from '../supabase';
import { raise, listTenantRows, requireTenantId } from './liveShared';

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
  /** DE-C4 (migration 130) — structured identity + availability */
  display_title: string;
  purpose_statement: string;
  primary_business_outcome: string;
  responsibilities: string[];
  availability: { mode: string; timezone?: string; start_hour?: number; end_hour?: number; days?: number[] };
  /** Migration 136 — standard workforce-record fields + custom-field values */
  employee_code: string;
  location: string;
  cost_center: string;
  attributes: Record<string, string | number>;
  /** Migration 149 — customer send mode: 'draft' = every external reply is
   *  human-approved first; 'auto' = confident, guardrail-clean answers send
   *  on their own. */
  external_reply_mode: 'draft' | 'auto';
  /** Wave 4: an absorbed specialist — a deep-domain advisor other DEs
   *  consult. Still a digital employee; this flags its specialist facet. */
  is_specialist?: boolean;
  specialist_key?: string | null;
}

/** The roster. Retired and archived employees are hidden by default —
 *  retiring one used to change its status and leave it sitting in the list
 *  forever, so the action appeared to do nothing. They are never deleted;
 *  pass includeRetired to see them (the roster has a toggle). */
export async function listDigitalEmployees(includeRetired = false): Promise<DigitalEmployee[]> {
  const all = await listTenantRows<DigitalEmployee>('digital_employees', 'created_at', true, 'listDigitalEmployees');
  return includeRetired ? all : all.filter(d => !['retired', 'archived'].includes(String(d.lifecycle_status)));
}

/** Flip a DE between draft-for-approval and auto-send for external replies. */
export async function setExternalReplyMode(deId: string, mode: 'draft' | 'auto'): Promise<void> {
  const { error } = await supabase.rpc('set_de_external_reply_mode', { p_de_id: deId, p_mode: mode });
  if (error) raise('setExternalReplyMode', error);
}

// ── DE custom profile fields (migration 136) ──────────────────────
// Definitions live in de_profile_fields (tenant-scoped, owner/admin/
// manager writable via RLS); values live in digital_employees.attributes
// via set_de_attributes (config-versioned + audited).
export interface DeProfileField { id: string; field_key: string; label: string; field_type: 'text' | 'number' | 'date'; position: number }

export async function listDeProfileFields(): Promise<DeProfileField[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('de_profile_fields')
    .select('id, field_key, label, field_type, position')
    .eq('tenant_id', tid)
    .order('position', { ascending: true });
  if (error) raise('listDeProfileFields', error);
  return (data ?? []) as DeProfileField[];
}

export async function addDeProfileField(f: { field_key: string; label: string; field_type: 'text' | 'number' | 'date'; position?: number }): Promise<DeProfileField> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('de_profile_fields')
    .insert({ ...f, tenant_id: tid })
    .select('id, field_key, label, field_type, position')
    .single();
  if (error) raise('addDeProfileField', error);
  return data as DeProfileField;
}

/** Set custom-field values on a DE. Keys must be defined in
 *  de_profile_fields (server-enforced); a null value removes the key. */
export async function setDeAttributes(deId: string, attributes: Record<string, string | number | null>): Promise<DigitalEmployee> {
  const { data, error } = await supabase.rpc('set_de_attributes', { p_de_id: deId, p_attributes: attributes });
  if (error) raise('setDeAttributes', error);
  return data as DigitalEmployee;
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

// ============================================================
// Wave 3 (bounded, migration 111) — DE-to-DE consultation. NOT full
// Composition (docs §7.6): single-hop, governance-gated by an
// explicit allow-list, no coordinator role, no fan-out/synthesis.
// ============================================================

export interface DEConsultationGrant {
  id: string;
  tenant_id: string;
  requester_de_id: string;
  target_de_id: string;
  category: string;
  active: boolean;
  created_at: string;
}

/** All consultation grants where this DE is either the requester or
 *  the target — a plain RLS-scoped read, no RPC needed. */
export async function listDeConsultationGrants(deId: string): Promise<{ asRequester: DEConsultationGrant[]; asTarget: DEConsultationGrant[] }> {
  const { data, error } = await supabase
    .from('de_consultation_grants')
    .select('*')
    .or(`requester_de_id.eq.${deId},target_de_id.eq.${deId}`)
    .order('created_at', { ascending: false });
  if (error) raise('listDeConsultationGrants', error);
  const rows = (data ?? []) as DEConsultationGrant[];
  return {
    asRequester: rows.filter(r => r.requester_de_id === deId),
    asTarget: rows.filter(r => r.target_de_id === deId),
  };
}

/** Grants requesterDeId permission to consult targetDeId for one
 *  category — owner/admin only (enforced by RLS). The target DE's own
 *  data access grants govern what it can actually answer; this never
 *  widens the requester's own access. */
export async function createDeConsultationGrant(requesterDeId: string, targetDeId: string, category: string): Promise<DEConsultationGrant> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('de_consultation_grants')
    .insert({ tenant_id: tid, requester_de_id: requesterDeId, target_de_id: targetDeId, category })
    .select('*').single();
  if (error) raise('createDeConsultationGrant', error);
  return data as DEConsultationGrant;
}

export async function setDeConsultationGrantActive(grantId: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('de_consultation_grants').update({ active }).eq('id', grantId);
  if (error) raise('setDeConsultationGrantActive', error);
}

// ── Cross-DE task delegation (T1.2, mig 234/269) ──
export interface DETaskRequest {
  id: string; tenant_id: string; from_de_id: string | null; to_de_id: string;
  title: string; context: string | null; expected_output: string | null;
  urgency: string; due_date: string | null; status: string; result: string | null;
  objective_id: string | null; created_by: string | null; created_at: string;
  responded_at: string | null; completed_at: string | null;
}

/** Tasks assigned TO this DE (inbound) and tasks it assigned to others
 *  (outbound). Plain RLS-scoped read. */
export async function listDeTaskRequests(deId: string): Promise<{ inbound: DETaskRequest[]; outbound: DETaskRequest[] }> {
  const { data, error } = await supabase
    .from('de_task_requests')
    .select('*')
    .or(`to_de_id.eq.${deId},from_de_id.eq.${deId}`)
    .order('created_at', { ascending: false });
  if (error) raise('listDeTaskRequests', error);
  const rows = (data ?? []) as DETaskRequest[];
  return { inbound: rows.filter(r => r.to_de_id === deId), outbound: rows.filter(r => r.from_de_id === deId) };
}

/** A human assigns a task to a DE (from_de_id null). Owner/admin only —
 *  enforced in request_de_task (mig 269). Returns the RPC envelope so the
 *  caller can surface {ok:false, detail} rather than throw. */
export async function assignTaskToDe(toDeId: string, title: string, context?: string, expectedOutput?: string, urgency: string = 'normal'): Promise<{ ok: boolean; error?: string; detail?: string; request_id?: string }> {
  const { data, error } = await supabase.rpc('request_de_task', {
    p_from_de_id: null, p_to_de_id: toDeId, p_title: title,
    p_context: context ?? null, p_expected_output: expectedOutput ?? null, p_urgency: urgency,
  });
  if (error) raise('assignTaskToDe', error);
  return (data ?? { ok: false, error: 'no_response' }) as { ok: boolean; error?: string; detail?: string; request_id?: string };
}

export async function respondDeTask(requestId: string, status: string, result?: string): Promise<void> {
  const { error } = await supabase.rpc('respond_de_task', { p_request_id: requestId, p_status: status, p_result: result ?? null });
  if (error) raise('respondDeTask', error);
}
