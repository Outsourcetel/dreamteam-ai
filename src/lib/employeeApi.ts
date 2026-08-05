// ============================================================
// employeeApi — the person behind the login.
//
// `profiles` used to hold thirteen columns: a login, a display name, a role and
// a free-text department. No job title, no start date, no manager, no phone, no
// address, no emergency contact — and no email, despite the People page reading
// `row.email` on every render, which is why that column was always blank.
//
// Migration 594 splits the record by WHO MAY SEE IT, because row-level security
// answers "which rows" and never "which columns":
//
//   profile              — the directory. Workspace-visible.
//   private              — home address, date of birth, emergency contact.
//                          The person and owners/admins. NOT managers.
//   compensation         — pay. Readable by the person and owners/admins,
//                          writable by owners/admins only, effective-dated so
//                          a raise never erases what came before.
//
// ⚠ EVERY WRITE GOES THROUGH AN RPC, NEVER A TABLE UPDATE. `authenticated`
// holds column-level UPDATE on exactly three columns of `profiles` — avatar,
// full_name, last_seen_at — and that grant is the only thing standing between a
// user and their own `role` column, which `auth_has_tenant_role` reads. Adding
// a direct table write here would mean widening that grant.
// ============================================================
import { supabase } from '../supabase';
import { raise } from './liveShared';

export interface EmployeeProfile {
  user_id: string;
  full_name: string | null;
  employee_number: string | null;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  pronouns: string | null;
  work_email: string | null;
  work_phone: string | null;
  mobile_phone: string | null;
  job_title: string | null;
  employment_type: string | null;
  employment_status: string | null;
  hire_date: string | null;
  end_date: string | null;
  org_unit_id: string | null;
  reports_to_user_id: string | null;
  work_location: string | null;
  time_zone: string | null;
  locale: string | null;
  role: string;
  is_active: boolean;
}

export interface EmployeePrivate {
  date_of_birth: string | null;
  personal_email: string | null;
  personal_phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_region: string | null;
  postal_code: string | null;
  country: string | null;
  emergency_contact_name: string | null;
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string | null;
}

export interface CompensationRecord {
  id: string;
  amount_cents: number;
  currency: string;
  pay_frequency: string;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
}

export interface EmployeeRecord {
  profile: EmployeeProfile;
  private: EmployeePrivate | null;
  compensation: CompensationRecord[] | null;
  /** Which sections the caller may not see. A blank section that might mean
   *  "no data" or might mean "not for you" is worse than either answer. */
  withheld: string[];
  can_edit_job: boolean;
  can_edit_private: boolean;
  can_edit_pay: boolean;
}

export const EMPLOYMENT_TYPES = [
  { value: 'full_time', label: 'Full time' },
  { value: 'part_time', label: 'Part time' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'intern', label: 'Intern' },
  { value: 'temporary', label: 'Temporary' },
];

export const EMPLOYMENT_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'on_leave', label: 'On leave' },
  { value: 'notice_period', label: 'Notice period' },
  { value: 'terminated', label: 'Left' },
];

export const PAY_FREQUENCIES = [
  { value: 'annual', label: 'Per year' },
  { value: 'monthly', label: 'Per month' },
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'weekly', label: 'Per week' },
  { value: 'hourly', label: 'Per hour' },
];

export async function getEmployeeRecord(userId: string): Promise<EmployeeRecord> {
  const { data, error } = await supabase.rpc('get_employee_record', { p_user_id: userId });
  // .rpc() RESOLVES on a Postgres error rather than rejecting, so the error
  // must be read explicitly — otherwise a refusal reads as an empty record.
  if (error) raise('getEmployeeRecord', error);
  return data as EmployeeRecord;
}

/** Job and directory fields. The server decides which of them this caller may
 *  change and REFUSES by name — it does not silently drop the rest, because a
 *  dropped field is a save that reports success and changes nothing. */
export async function updateEmployeeProfile(
  userId: string, patch: Partial<EmployeeProfile>,
): Promise<void> {
  const { error } = await supabase.rpc('update_employee_profile', {
    p_user_id: userId, p_patch: patch,
  });
  if (error) raise('updateEmployeeProfile', error);
}

export async function updateEmployeePrivate(
  userId: string, patch: Partial<EmployeePrivate>,
): Promise<void> {
  const { error } = await supabase.rpc('update_employee_private', {
    p_user_id: userId, p_patch: patch,
  });
  if (error) raise('updateEmployeePrivate', error);
}

/** Records a NEW effective-dated row and closes the previous one — it never
 *  overwrites. What somebody used to be paid is exactly the record you need
 *  when a pay question arrives. */
export async function setEmployeeCompensation(input: {
  userId: string; amountCents: number; currency: string;
  payFrequency: string; effectiveFrom: string; note?: string;
}): Promise<void> {
  const { error } = await supabase.rpc('set_employee_compensation', {
    p_user_id: input.userId,
    p_amount_cents: input.amountCents,
    p_currency: input.currency,
    p_pay_frequency: input.payFrequency,
    p_effective_from: input.effectiveFrom,
    p_note: input.note ?? null,
  });
  if (error) raise('setEmployeeCompensation', error);
}
