// ============================================================
// Data Access Grants (migration 029) — client API.
//
// Default-deny: a machine subject (a Digital Employee or a
// Specialist) can only touch a connected system it holds a grant
// for. Grants form a CUMULATIVE ladder — one row per subject ×
// resource holds the MAX level:
//   search (1) → read (2) → ingest (3) → write_back (4)
// A connector-specific grant beats a category grant; no grant = deny.
// All writes go through the audited SECURITY DEFINER RPCs
// (set_access_grant / revoke_access_grant) — never direct table
// writes. Enforcement is SERVER-SIDE in the edge functions; this
// file only reads state and calls the RPCs.
// ============================================================
import { supabase } from '../supabase';
import { raise, requireTenantId } from './liveShared';
import type { SystemCategory } from './categoryContracts';

export type SubjectKind = 'de' | 'specialist';
export type ResourceKind = 'connector' | 'category';
export type AccessPermission = 'search' | 'read' | 'ingest' | 'write_back';
export type PermissionChoice = AccessPermission | 'none';

export const PERMISSION_LEVELS: Record<AccessPermission, number> = {
  search: 1, read: 2, ingest: 3, write_back: 4,
};

export const PERMISSION_LABELS: Record<PermissionChoice, string> = {
  none: 'None',
  search: 'Search',
  read: 'Read',
  ingest: 'Ingest',
  write_back: 'Write-back',
};

/** Plain-language tooltips — each level INCLUDES everything below it. */
export const PERMISSION_EXPLAIN: Record<PermissionChoice, string> = {
  none: 'No access — every request to this system is refused (this is the default for everything).',
  search: 'Search: can find matching records — titles and short snippets only; cannot open them.',
  read: 'Read: search, plus open individual records to see their content.',
  ingest: 'Ingest: read, plus sync content into DreamTeam knowledge (a stored working copy).',
  write_back: 'Write-back: everything above, plus writing into the system — still human-approved through the existing gates. A grant is necessary, never sufficient, for a write.',
};

export interface AccessGrant {
  id: string;
  tenant_id: string;
  subject_kind: SubjectKind;
  subject_id: string;
  resource_kind: ResourceKind;
  resource_id: string | null;
  resource_category: SystemCategory | null;
  permission: AccessPermission;
  granted_by: string | null;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface AccessSubject {
  kind: SubjectKind;
  id: string;
  name: string;
  detail: string; // e.g. DE category or specialist key
}

export interface AccessDenialEvent {
  id: string;
  actor: string;
  action: string;
  created_at: string;
  detail: {
    subject_kind?: string;
    subject_id?: string;
    connector_id?: string;
    connector_label?: string;
    op?: string;
    needed?: string;
    has?: string | null;
  };
}

// ── Reads ─────────────────────────────────────────────────────────

export async function listAccessGrants(): Promise<AccessGrant[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('data_access_grants')
    .select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: true });
  if (error) raise('listAccessGrants', error);
  return (data ?? []) as AccessGrant[];
}

/** Matrix rows: the tenant's DEs + specialist profiles. */
export async function listAccessSubjects(): Promise<AccessSubject[]> {
  const tid = await requireTenantId();
  const [des, specs] = await Promise.all([
    supabase.from('digital_employees').select('id, name, category, status').eq('tenant_id', tid).order('created_at'),
    supabase.from('specialist_profiles').select('id, name, key, status').eq('tenant_id', tid).order('created_at'),
  ]);
  if (des.error) raise('listAccessSubjects.des', des.error);
  if (specs.error) raise('listAccessSubjects.specs', specs.error);
  return [
    ...(des.data ?? []).map((d) => ({
      kind: 'de' as const, id: d.id as string, name: d.name as string,
      detail: `Digital Employee · ${d.category}`,
    })),
    ...(specs.data ?? []).map((s) => ({
      kind: 'specialist' as const, id: s.id as string, name: s.name as string,
      detail: `Specialist · ${s.key}`,
    })),
  ];
}

/** Recent access denials from the audit chain (access_control /
 *  data_access_denied) — the friction admins should see. */
export async function listRecentDenials(limit = 20): Promise<AccessDenialEvent[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('audit_events')
    .select('id, actor, action, detail, created_at')
    .eq('tenant_id', tid)
    .eq('category', 'access_control')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) raise('listRecentDenials', error);
  return ((data ?? []) as AccessDenialEvent[])
    .filter((e) => (e.detail as { kind?: string })?.kind === 'data_access_denied')
    .slice(0, limit);
}

// ── Writes (audited RPCs only) ────────────────────────────────────

export interface GrantTarget {
  resource_kind: ResourceKind;
  resource_id?: string | null;       // when resource_kind = 'connector'
  resource_category?: string | null; // when resource_kind = 'category'
}

export async function setAccessGrant(
  subject: { kind: SubjectKind; id: string },
  target: GrantTarget,
  permission: AccessPermission,
  note = '',
): Promise<void> {
  const { data, error } = await supabase.rpc('set_access_grant', {
    p_subject_kind: subject.kind,
    p_subject_id: subject.id,
    p_resource_kind: target.resource_kind,
    p_resource_id: target.resource_id ?? null,
    p_resource_category: target.resource_category ?? null,
    p_permission: permission,
    p_note: note,
  });
  if (error) raise('setAccessGrant', error);
  const res = data as { ok?: boolean; error?: string; detail?: string } | null;
  if (!res?.ok) throw new Error(res?.detail ?? res?.error ?? 'set_access_grant failed');
}

export async function revokeAccessGrant(
  subject: { kind: SubjectKind; id: string },
  target: GrantTarget,
): Promise<void> {
  const { data, error } = await supabase.rpc('revoke_access_grant', {
    p_subject_kind: subject.kind,
    p_subject_id: subject.id,
    p_resource_kind: target.resource_kind,
    p_resource_id: target.resource_id ?? null,
    p_resource_category: target.resource_category ?? null,
  });
  if (error) raise('revokeAccessGrant', error);
  const res = data as { ok?: boolean; error?: string; detail?: string } | null;
  if (!res?.ok) throw new Error(res?.detail ?? res?.error ?? 'revoke_access_grant failed');
}

/** Find the effective grant for a subject × connector the way the
 *  server resolves it: connector-specific first, then category. */
export function effectiveGrant(
  grants: AccessGrant[], subject: AccessSubject,
  connectorId: string, connectorCategory: string,
): { permission: AccessPermission | null; via: 'connector' | 'category' | null } {
  const mine = grants.filter((g) => g.subject_kind === subject.kind && g.subject_id === subject.id);
  const specific = mine.find((g) => g.resource_kind === 'connector' && g.resource_id === connectorId);
  if (specific) return { permission: specific.permission, via: 'connector' };
  const cat = mine.find((g) => g.resource_kind === 'category' && g.resource_category === connectorCategory);
  if (cat) return { permission: cat.permission, via: 'category' };
  return { permission: null, via: null };
}
