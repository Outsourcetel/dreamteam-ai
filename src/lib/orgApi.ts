// ============================================================
// orgApi — the org chart, and the rules that route work into it.
//
// Until now the platform had no way to say who a person works with. It looked
// like it did: `departments` held rows and `workforce_teams` held rows. But
// workforce_teams links to DE_ID — those are teams of digital employees, used
// for consultation fallback, and no human is in one. And `profiles.department`
// is free text that matched no real department for any of the 21 profiles
// carrying a value. So approvals went to a shared queue, which is a place where
// no individual item is anybody's job. 318 of them were sitting there.
//
// This module reads and edits the real structure (mig 587/588): units form a
// tree — location/branch → department → team — people are placed into units,
// and rules say which unit a kind of work belongs to.
//
// Writes go straight to the tables. RLS restricts them to tenant owners,
// admins and managers, so there is no separate permission check here to drift
// out of step with the one the database actually enforces.
// ============================================================
import { supabase } from '../supabase';
import { raise, requireTenantId } from './liveShared';

export type UnitKind = 'location' | 'branch' | 'department' | 'team';
export type AssignStrategy = 'round_robin' | 'lead' | 'lead_then_round_robin';

export interface OrgMember {
  user_id: string;
  name: string | null;
  role_in_unit: 'member' | 'lead';
  job_title?: string | null;
  /** True for the membership mirroring this person's home department. A second
   *  team they were added to by hand is false. */
  is_primary?: boolean;
}

/** A digital employee in the same department as the people above it.
 *  Same tree, same unit — kept as its own list because only PEOPLE enter the
 *  approval rota, and a single blended list would hide that at the one moment
 *  it matters. */
export interface OrgDigitalEmployee {
  de_id: string;
  name: string;
  title: string | null;
  trust_level: string | null;
  status: string;
}

/** A unit as `list_org_tree` returns it — flattened, depth-tagged, in tree order. */
export interface OrgUnit {
  id: string;
  parent_id: string | null;
  kind: UnitKind;
  name: string;
  is_active: boolean;
  depth: number;
  /** "Head Office / Finance / Accounts Receivable" — unique even when names repeat. */
  path: string;
  member_count: number;
  /** Active digital employees in this same unit (mig 600). */
  de_count: number;
  /** Pending approvals routed here, counted on the unit id recorded at
   *  assignment time — never on the name, which two units can share. */
  open_tasks: number;
  members: OrgMember[];
  digital_employees: OrgDigitalEmployee[];
}

export interface AssignmentRule {
  id: string;
  name: string;
  priority: number;
  match_type: string | null;
  match_source: string | null;
  match_related_table: string | null;
  target_unit_id: string;
  strategy: AssignStrategy;
  is_active: boolean;
}

export interface AssignablePerson {
  user_id: string;
  full_name: string | null;
  role: string;
}

/** What a unit may contain, mirroring the trigger in mig 587. The UI offers
 *  only legal children so the founder never meets a database error for a shape
 *  the form let them choose. */
export const ALLOWED_CHILDREN: Record<UnitKind, UnitKind[]> = {
  location: ['location', 'branch', 'department'],
  branch: ['branch', 'department'],
  department: ['team'],
  team: ['team'],
};

export const KIND_LABEL: Record<UnitKind, string> = {
  location: 'Location',
  branch: 'Branch',
  department: 'Department',
  team: 'Team',
};

export async function loadOrgTree(): Promise<OrgUnit[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('list_org_tree', { p_tenant_id: tid });
  if (error) raise('loadOrgTree', error);
  return (data ?? []) as OrgUnit[];
}

export async function createUnit(input: {
  parentId: string | null; kind: UnitKind; name: string; code?: string;
}): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase.from('org_units').insert({
    tenant_id: tid,
    parent_id: input.parentId,
    kind: input.kind,
    name: input.name.trim(),
    code: input.code?.trim() || null,
  });
  if (error) raise('createUnit', error);
}

export async function renameUnit(unitId: string, name: string): Promise<void> {
  const { error } = await supabase.from('org_units').update({ name: name.trim() }).eq('id', unitId);
  if (error) raise('renameUnit', error);
}

/** Units are deactivated, never deleted. A unit id is recorded on every task it
 *  ever routed (`assigned_via`), and deleting it would erase the answer to
 *  "why did this land on me?" for work already decided. */
export async function setUnitActive(unitId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from('org_units').update({ is_active: isActive }).eq('id', unitId);
  if (error) raise('setUnitActive', error);
}

export async function addMember(
  unitId: string, userId: string, roleInUnit: 'member' | 'lead',
): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase.from('org_unit_members').upsert(
    { tenant_id: tid, org_unit_id: unitId, user_id: userId, role_in_unit: roleInUnit, is_active: true },
    { onConflict: 'org_unit_id,user_id' },
  );
  if (error) raise('addMember', error);
}

export async function setMemberRole(
  unitId: string, userId: string, roleInUnit: 'member' | 'lead',
): Promise<void> {
  const { error } = await supabase.from('org_unit_members')
    .update({ role_in_unit: roleInUnit })
    .eq('org_unit_id', unitId).eq('user_id', userId);
  if (error) raise('setMemberRole', error);
}

export async function removeMember(unitId: string, userId: string): Promise<void> {
  const { error } = await supabase.from('org_unit_members')
    .delete().eq('org_unit_id', unitId).eq('user_id', userId);
  if (error) raise('removeMember', error);
}

export async function listAssignablePeople(): Promise<AssignablePerson[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, full_name, role')
    .eq('tenant_id', tid)
    .eq('is_active', true)
    .not('user_id', 'is', null)
    .order('full_name', { ascending: true });
  if (error) raise('listAssignablePeople', error);
  return (data ?? []) as AssignablePerson[];
}

/** Digital employees available to place — the whole active roster, so one can
 *  be moved into a department it is not in yet. */
export async function listDigitalEmployees(): Promise<OrgDigitalEmployee[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('digital_employees')
    .select('id, name, display_title, trust_level, status, org_unit_id')
    .eq('tenant_id', tid)
    .eq('status', 'active')
    .order('name', { ascending: true });
  if (error) raise('listDigitalEmployees', error);
  return ((data ?? []) as Record<string, unknown>[]).map((d) => ({
    de_id: d.id as string,
    name: d.name as string,
    title: (d.display_title as string | null) ?? null,
    trust_level: (d.trust_level as string | null) ?? null,
    status: d.status as string,
  }));
}

/** Move a digital employee between departments. `department` follows the unit
 *  by trigger — it is a derived name, never written directly. */
export async function setDeOrgUnit(deId: string, orgUnitId: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_de_org_unit', {
    p_de_id: deId, p_org_unit_id: orgUnitId,
  });
  if (error) raise('setDeOrgUnit', error);
}

export async function listAssignmentRules(): Promise<AssignmentRule[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('work_assignment_rules')
    .select('id, name, priority, match_type, match_source, match_related_table, target_unit_id, strategy, is_active')
    .eq('tenant_id', tid)
    .order('priority', { ascending: true });
  if (error) raise('listAssignmentRules', error);
  return (data ?? []) as AssignmentRule[];
}

export async function saveRule(rule: Partial<AssignmentRule> & { name: string; target_unit_id: string }): Promise<void> {
  const tid = await requireTenantId();
  const row = {
    tenant_id: tid,
    name: rule.name.trim(),
    priority: rule.priority ?? 100,
    match_type: rule.match_type || null,
    match_source: rule.match_source || null,
    match_related_table: rule.match_related_table || null,
    target_unit_id: rule.target_unit_id,
    strategy: rule.strategy ?? 'lead_then_round_robin',
    is_active: rule.is_active ?? true,
  };
  const { error } = rule.id
    ? await supabase.from('work_assignment_rules').update(row).eq('id', rule.id)
    : await supabase.from('work_assignment_rules').insert(row);
  if (error) raise('saveRule', error);
}

export async function setRuleActive(ruleId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from('work_assignment_rules')
    .update({ is_active: isActive }).eq('id', ruleId);
  if (error) raise('setRuleActive', error);
}

export async function deleteRule(ruleId: string): Promise<void> {
  const { error } = await supabase.from('work_assignment_rules').delete().eq('id', ruleId);
  if (error) raise('deleteRule', error);
}

/** Re-run routing over everything still unowned. Safe to press repeatedly:
 *  the router leaves an already-assigned task alone unless forced. */
export async function reassignUnowned(): Promise<{ assigned: number; unroutable: number }> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('human_tasks')
    .select('id')
    .eq('tenant_id', tid)
    .eq('status', 'pending')
    .is('assigned_user_id', null);
  if (error) raise('reassignUnowned', error);

  let assigned = 0, unroutable = 0;
  for (const row of (data ?? []) as { id: string }[]) {
    const { data: res, error: rpcErr } = await supabase.rpc('assign_human_task', { p_task_id: row.id });
    // .rpc() RESOLVES on a Postgres error rather than rejecting, so the error
    // must be read explicitly — a silent failure here would report every task
    // as routed. See _shared/rpcSafety.ts for the same trap server-side.
    if (rpcErr || !(res as { ok?: boolean } | null)?.ok) unroutable++;
    else assigned++;
  }
  return { assigned, unroutable };
}

// ── Approval authority (mig 593) ───────────────────────────────────────────
// Who may SIGN what, as opposed to who may SEE it. Until 593 those were the
// same question: anyone who could open an approval could grant it, whatever it
// was and whatever it was worth.
//
// ⚠ THE PERMISSIVE DEFAULT IS LOAD-BEARING. A workspace with no rows here
// behaves exactly as it did before — everyone who can see an item may still
// decide it. Adding the FIRST rule is the moment limits begin to apply, and it
// applies them to everyone at once. The UI says so before you save one.

export interface ApprovalAuthority {
  id: string;
  org_unit_id: string | null;
  role: string | null;
  user_id: string | null;
  category: string | null;
  max_amount_cents: number | null;
  second_approver_above_cents: number | null;
  note: string | null;
  is_active: boolean;
}

/** The categories a task can actually carry — action categories where an
 *  action approval exists, task types otherwise. Offered as a list so a rule
 *  cannot be written against a category that will never appear. */
export const AUTHORITY_CATEGORIES: { value: string; label: string }[] = [
  { value: '', label: 'Any kind of work' },
  { value: 'erp_financials', label: 'Finance & accounting' },
  { value: 'billing', label: 'Billing' },
  { value: 'crm', label: 'CRM changes' },
  { value: 'helpdesk', label: 'Helpdesk' },
  { value: 'ads', label: 'Advertising' },
  { value: 'social', label: 'Social posting' },
  { value: 'platform_admin', label: 'Platform administration' },
  { value: 'escalation', label: 'Escalations' },
  { value: 'review_gate', label: 'Review gates' },
  { value: 'trust_promotion', label: 'Trust promotions' },
];

export async function listApprovalAuthority(): Promise<ApprovalAuthority[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('approval_authority')
    .select('id, org_unit_id, role, user_id, category, max_amount_cents, second_approver_above_cents, note, is_active')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: true });
  if (error) raise('listApprovalAuthority', error);
  return (data ?? []) as ApprovalAuthority[];
}

export async function saveApprovalAuthority(row: Partial<ApprovalAuthority>): Promise<void> {
  const tid = await requireTenantId();
  const payload = {
    tenant_id: tid,
    org_unit_id: row.org_unit_id || null,
    role: row.role || null,
    user_id: row.user_id || null,
    category: row.category || null,
    max_amount_cents: row.max_amount_cents ?? null,
    second_approver_above_cents: row.second_approver_above_cents ?? null,
    note: row.note?.trim() || null,
    is_active: row.is_active ?? true,
  };
  const { error } = row.id
    ? await supabase.from('approval_authority').update(payload).eq('id', row.id)
    : await supabase.from('approval_authority').insert(payload);
  if (error) raise('saveApprovalAuthority', error);
}

export async function deleteApprovalAuthority(id: string): Promise<void> {
  const { error } = await supabase.from('approval_authority').delete().eq('id', id);
  if (error) raise('deleteApprovalAuthority', error);
}

/** Who currently holds pending work, so a queue that is not draining reads as
 *  "these three people are underwater" instead of "the queue is big". */
export interface OwnerLoad {
  user_id: string | null;
  name: string;
  pending: number;
  oldest_days: number;
}

export async function loadOwnerLoad(): Promise<OwnerLoad[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('human_tasks')
    .select('assigned_user_id, created_at')
    .eq('tenant_id', tid)
    .eq('status', 'pending');
  if (error) raise('loadOwnerLoad', error);

  const people = await listAssignablePeople();
  const byId = new Map(people.map((p) => [p.user_id, p.full_name]));
  const acc = new Map<string, { n: number; oldest: number }>();
  const now = Date.now();
  for (const r of (data ?? []) as { assigned_user_id: string | null; created_at: string }[]) {
    const key = r.assigned_user_id ?? '';
    const age = Math.floor((now - new Date(r.created_at).getTime()) / 86_400_000);
    const cur = acc.get(key) ?? { n: 0, oldest: 0 };
    acc.set(key, { n: cur.n + 1, oldest: Math.max(cur.oldest, age) });
  }
  return [...acc.entries()]
    .map(([id, v]) => ({
      user_id: id || null,
      // A profile can exist with no full_name — real, and seen in live data.
      // Showing a blank row would read as a bug in the routing rather than a
      // gap in the person's record.
      name: id ? (byId.get(id) || 'Unnamed user') : 'Nobody — unrouted',
      pending: v.n,
      oldest_days: v.oldest,
    }))
    .sort((a, b) => b.pending - a.pending);
}
