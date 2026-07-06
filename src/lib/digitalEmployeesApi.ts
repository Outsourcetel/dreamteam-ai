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
  trust_level: 'supervised' | 'semi_autonomous' | 'autonomous';
  confidence_threshold: number;
  required_approval: boolean;
  created_at: string;
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
  trustLevel?: 'supervised' | 'semi_autonomous' | 'autonomous';
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
