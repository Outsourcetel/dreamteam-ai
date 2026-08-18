import { supabase } from '../supabase';
import { invokeEdge } from './invokeEdge';

// =====================================================
// TYPES â mirror the Supabase schema
// =====================================================
export interface DBTenant {
  id: string;
  name: string;
  slug: string;
  plan: 'starter' | 'growth' | 'enterprise';
  status: 'active' | 'suspended' | 'trial';
  industry?: string;
  accent_color?: string;
  logo_url?: string;
  vocabulary?: Record<string, string>;  // Wave 4 tenant relabeling layer
  settings?: Record<string, unknown>;
  monthly_token_budget?: number;
  parent_tenant_id?: string | null;
  allow_self_serve_subtenants?: boolean;
  trial_ends_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface DBProfile {
  id: string;
  user_id: string;
  tenant_id?: string;
  full_name?: string;
  avatar?: string;
  role: string;
  layer: 'platform' | 'tenant';
  is_active: boolean;
  last_seen_at?: string;
  created_at: string;
}

interface DBKnowledgeArticle {
  id: string;
  tenant_id: string;
  title: string;
  body: string;
  summary?: string;
  status: 'draft' | 'review' | 'published' | 'archived';
  audience: 'internal' | 'customer' | 'both';
  category?: string;
  tags?: string[];
  product?: string;
  module?: string;
  quality_score: number;
  freshness_score: number;
  view_count: number;
  helpful_count: number;
  not_helpful_count: number;
  created_by?: string;
  published_at?: string;
  created_at: string;
  updated_at: string;
}

interface DBConversation {
  id: string;
  tenant_id: string;
  channel: 'chat' | 'email' | 'phone' | 'api';
  status: 'open' | 'pending' | 'resolved' | 'escalated' | 'closed';
  subject?: string;
  customer_name?: string;
  customer_email?: string;
  assigned_to?: string;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'urgent';
  confidence_score?: number;
  resolution_type?: string;
  tags?: string[];
  opened_at: string;
  resolved_at?: string;
  created_at: string;
}

interface DBMessage {
  id: string;
  conversation_id: string;
  tenant_id: string;
  role: 'user' | 'agent' | 'ai' | 'system';
  content: string;
  confidence_score?: number;
  sources?: unknown[];
  requires_approval: boolean;
  created_at: string;
}

// =====================================================
// TENANT QUERIES
// =====================================================
// Routed through a SECURITY DEFINER RPC (migration 083), not a direct
// client update — tenants has exactly one RLS policy (SELECT only), so a
// direct `.update()` here was a silent no-op: a customer editing their org
// name/industry/brand color in Settings would see "Saved" while nothing
// was ever written. Gated server-side on tenant_owner/tenant_admin of
// that tenant (or a platform account with tenants.manage).
export const updateTenant = async (
  id: string,
  updates: Partial<Pick<DBTenant, 'name' | 'industry' | 'accent_color'>> & { vocabulary?: Record<string, string> }
): Promise<boolean> => {
  const { data, error } = await supabase.rpc('update_tenant_general_settings', {
    p_tenant_id: id,
    p_name: updates.name ?? null,
    p_industry: updates.industry ?? null,
    p_accent_color: updates.accent_color ?? null,
    // Wave 4: vocabulary applied only when provided (server keeps existing otherwise).
    p_vocabulary: updates.vocabulary ?? null,
  });
  if (error) { console.error('updateTenant:', error.message); return false; }
  return !!(data as { ok?: boolean })?.ok;
};

export const fetchTenants = async (): Promise<DBTenant[]> => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { console.error('fetchTenants:', error.message); return []; }
  return data ?? [];
};

export const fetchTenantById = async (id: string): Promise<DBTenant | null> => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', id)
    .single();
  if (error) { console.error('fetchTenantById:', error.message); return null; }
  return data;
};

// =====================================================
// PROFILE QUERIES
// =====================================================
export const fetchMyProfile = async (): Promise<DBProfile | null> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .single();
  if (error) { console.error('fetchMyProfile:', error.message); return null; }
  return data;
};

/**
 * The relations this person holds on ANY digital employee — the ASSIGNMENT
 * axis of docs/29, read from de_assignments (migration 385).
 *
 * Used by canAccessPage to open pages the ROLE axis alone would deny: a person
 * who is `tenant_user` by role and `manager` by relation is accountable for
 * that employee and should reach its approvals queue. Before this, the nav
 * only understood roles, so the two axes disagreed and the reporting line lost.
 *
 * Returns distinct relation names, not rows — nav asks "does this person
 * manage ANY employee", never "which one". Which employee is a question the
 * database answers, through can_access_de on every read and write.
 *
 * Failure returns [] rather than throwing. This function only ever WIDENS
 * navigation, so a failed load degrades to the role tier alone — the previous
 * behaviour — instead of locking someone out of pages they can legitimately
 * use. RLS on de_assignments already limits the rows to the caller's tenant.
 */
export const fetchMyDeRelations = async (): Promise<Array<'primary' | 'manager' | 'executive'>> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('de_assignments')
    .select('relation')
    .eq('user_id', user.id);
  if (error) { console.error('fetchMyDeRelations:', error.message); return []; }
  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ relation: string }>) {
    if (row?.relation) seen.add(row.relation);
  }
  return Array.from(seen).filter(
    (r): r is 'primary' | 'manager' | 'executive' =>
      r === 'primary' || r === 'manager' || r === 'executive',
  );
};

export interface CompleteSignupResult {
  ok: boolean;
  tenant_id?: string;
  slug?: string;
  name?: string;
  error?: string;
  detail?: string;
}

// Provisions a real tenant for the currently-authenticated caller and links
// it to their own profile. Runs server-side via a SECURITY DEFINER RPC
// (migration 049) — this is the ONLY correct place tenant creation happens;
// see LoginPage.tsx and AuthContext.tsx for why the old client-side
// `tenants` insert at signup time never worked.
export const completeSignup = async (orgName: string, industry: string): Promise<CompleteSignupResult> => {
  const { data, error } = await supabase.rpc('complete_signup', {
    p_org_name: orgName,
    p_industry: industry,
  });
  if (error) return { ok: false, error: 'rpc_error', detail: error.message };
  return data as CompleteSignupResult;
};

// =====================================================================
// TENANT HIERARCHY (migration 050) — parent/child tenants, provisioning
// workflow, feature flags. See supabase/migrations/050_tenant_hierarchy.sql
// for the full schema and security model.
// =====================================================================
export interface TenantAncestryRow { tenant_id: string; depth: number }

export interface RequestSubtenantResult {
  ok: boolean;
  path?: 'self_serve' | 'pending_platform_approval';
  tenant_id?: string;
  slug?: string;
  request_id?: string;
  error?: string;
}

export interface TenantProvisioningRequest {
  id: string;
  requested_by_user_id: string;
  proposed_parent_tenant_id: string | null;
  proposed_name: string;
  proposed_industry: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  decided_at: string | null;
  rejection_reason: string | null;
  created_tenant_id: string | null;
  created_at: string;
}

export interface FeatureRegistryEntry {
  key: string;
  label: string;
  description: string | null;
  default_enabled: boolean;
  category: string | null;
}

export interface TenantFeatureOverride {
  tenant_id: string;
  feature_key: string;
  enabled: boolean;
  note: string | null;
  updated_at: string;
}

// Request a sub-tenant under p_parent_tenant_id. Immediate creation if the
// parent has allow_self_serve_subtenants=true and the caller is its
// owner/admin; otherwise routes to the platform for approval.
export const requestSubtenant = async (
  parentTenantId: string | null,
  name: string,
  industry?: string
): Promise<RequestSubtenantResult> => {
  const { data, error } = await supabase.rpc('request_subtenant', {
    p_parent_tenant_id: parentTenantId,
    p_name: name,
    p_industry: industry ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return data as RequestSubtenantResult;
};

export const fetchPendingProvisioningRequests = async (): Promise<TenantProvisioningRequest[]> => {
  const { data, error } = await supabase
    .from('tenant_provisioning_requests')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) { console.error('fetchPendingProvisioningRequests:', error.message); return []; }
  return data ?? [];
};

export const approveSubtenantRequest = async (requestId: string): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('approve_subtenant_request', { p_request_id: requestId });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean };
};

export const rejectSubtenantRequest = async (requestId: string, reason: string): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('reject_subtenant_request', { p_request_id: requestId, p_reason: reason });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean };
};

// Routed through a SECURITY DEFINER RPC (migration 082), not a direct
// client update — tenants has exactly one RLS policy (SELECT only), so a
// direct `.update()` here was a silent no-op: RLS blocked every row, but
// Supabase returns success rather than an error, so the toggle visually
// flipped in the UI while nothing was ever written. Gated on tenants.manage.
export const setTenantSelfServe = async (tenantId: string, allow: boolean): Promise<boolean> => {
  const { data, error } = await supabase.rpc('set_tenant_self_serve', { p_tenant_id: tenantId, p_allow: allow });
  if (error) { console.error('setTenantSelfServe:', error.message); return false; }
  return !!(data as { ok?: boolean })?.ok;
};

// Suspend/reactivate a tenant. Routed through a SECURITY DEFINER RPC
// (migration 081), not a direct client update — tenants has no UPDATE RLS
// policy for this column, same reason setTenantSelfServe above needed the
// identical fix (migration 082). Gated on tenants.manage.
export const setTenantStatus = async (
  tenantId: string,
  status: 'active' | 'trial' | 'suspended'
): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('set_tenant_status', { p_tenant_id: tenantId, p_status: status });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; error?: string };
};

// Changes plan and resets the token budget to that plan's standard default
// (migration 086) — platform-admin only. There was previously no way at all
// to change a tenant's plan; every signup path hardcoded 'starter' forever.
export const setTenantPlan = async (
  tenantId: string,
  plan: 'starter' | 'growth' | 'enterprise'
): Promise<{ ok: boolean; error?: string; monthly_token_budget?: number }> => {
  const { data, error } = await supabase.rpc('set_tenant_plan', { p_tenant_id: tenantId, p_plan: plan });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; error?: string; monthly_token_budget?: number };
};

// Permanently delete a tenant (migration 194) — platform-admin only.
// The RPC enforces the hard rails server-side: the tenant must already be
// suspended, the demo tenant is protected, you cannot delete your own
// tenant, sub-tenants must be cleared first, and confirmSlug must match the
// tenant's slug exactly. Everything the tenant owns cascades away.
export const deleteTenant = async (
  tenantId: string,
  confirmSlug: string
): Promise<{ ok: boolean; error?: string; name?: string }> => {
  const { data, error } = await supabase.rpc('delete_tenant', { p_tenant_id: tenantId, p_confirm_slug: confirmSlug });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; error?: string; name?: string };
};

export interface PlatformConnectorHealthRow {
  tenant_id: string;
  tenant_name: string;
  connector_id: string;
  display_name: string;
  provider: string;
  /** ⚠ FOUR values, not three. `pending_credentials` has been legal since
   *  migration 728 and this union said otherwise until 2026-08-15 — and tsc
   *  could not catch the gap, because the RPC returns `status text` and the
   *  fetcher below casts the whole array with `as`. A cast is a promise the
   *  compiler believes; it does not check it. The live
   *  `platform_connector_health_summary` body (read from pg_get_functiondef)
   *  selects `c.status` with NO status filter at all, so every value the
   *  connectors_status_check admits reaches this page verbatim.
   *
   *  Kept in step with src/lib/connectorApi.ts's ConnectorStatus. If a sixth
   *  status is ever added, widen BOTH — and note that PlatformConsolePage's
   *  classifier deliberately treats an unrecognised value as unknown rather
   *  than healthy, so the page degrades to "we don't know" instead of green. */
  status: 'connected' | 'error' | 'disconnected' | 'pending_credentials';
  last_ok_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

export const fetchPlatformConnectorHealth = async (): Promise<PlatformConnectorHealthRow[]> => {
  const { data, error } = await supabase.rpc('platform_connector_health_summary');
  if (error) { console.error('fetchPlatformConnectorHealth:', error.message); return []; }
  return (data as PlatformConnectorHealthRow[]) ?? [];
};

export const fetchTenantDescendants = async (tenantId: string): Promise<TenantAncestryRow[]> => {
  const { data, error } = await supabase.rpc('tenant_descendants', { p_tenant_id: tenantId });
  if (error) { console.error('fetchTenantDescendants:', error.message); return []; }
  return (data ?? []) as TenantAncestryRow[];
};

export const fetchFeatureRegistry = async (): Promise<FeatureRegistryEntry[]> => {
  const { data, error } = await supabase
    .from('feature_registry')
    .select('*')
    .order('category', { ascending: true });
  if (error) { console.error('fetchFeatureRegistry:', error.message); return []; }
  return data ?? [];
};

export const fetchTenantFeatureOverrides = async (tenantId: string): Promise<TenantFeatureOverride[]> => {
  const { data, error } = await supabase
    .from('tenant_feature_overrides')
    .select('*')
    .eq('tenant_id', tenantId);
  if (error) { console.error('fetchTenantFeatureOverrides:', error.message); return []; }
  return data ?? [];
};

export const setTenantFeatureOverride = async (
  tenantId: string,
  featureKey: string,
  enabled: boolean,
  note?: string
): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('set_tenant_feature_override', {
    p_tenant_id: tenantId,
    p_feature_key: featureKey,
    p_enabled: enabled,
    p_note: note ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean };
};

// =====================================================================
// PLATFORM-OWNER SECURITY (migration 052) — account-status check,
// owner-controlled team invitations, remote-access audit trail.
// =====================================================================
export interface AccountStatus {
  found: boolean;
  is_active?: boolean;
  role?: string;
  layer?: 'platform' | 'tenant';
  tenant_id?: string | null;
}

// Authoritative "am I still allowed in" check, straight from the DB, not
// a cached profile row — used to catch a deactivated account (is_active
// = false) immediately, both at session-restore and mid-session.
export const checkMyAccountStatus = async (): Promise<AccountStatus | null> => {
  const { data, error } = await supabase.rpc('my_account_status');
  if (error) { console.error('checkMyAccountStatus:', error.message); return null; }
  return data as AccountStatus;
};

export type PlatformInviteRole = 'platform_support' | 'platform_billing' | 'platform_super_admin';

export const PLATFORM_INVITE_ROLE_LABELS: Record<PlatformInviteRole, string> = {
  platform_support: 'Support',
  platform_billing: 'Billing',
  platform_super_admin: 'Full platform access',
};

export interface PlatformInvite {
  id: string;
  email: string;
  role: PlatformInviteRole;
  status: 'pending' | 'redeemed' | 'revoked';
  invite_code: string;
  invited_by: string | null;
  created_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
}

export const invitePlatformTeamMember = async (
  email: string,
  role: PlatformInviteRole
): Promise<{ ok: boolean; invite_code?: string; email?: string; role?: string; error?: string }> => {
  const { data, error } = await supabase.rpc('invite_platform_team_member', { p_email: email, p_role: role });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; invite_code?: string; email?: string; role?: string };
};

export const listPlatformInvites = async (): Promise<PlatformInvite[]> => {
  const { data, error } = await supabase.rpc('list_platform_invites');
  if (error) { console.error('listPlatformInvites:', error.message); return []; }
  return (data ?? []) as PlatformInvite[];
};

export const revokePlatformInvite = async (inviteId: string): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('revoke_platform_invite', { p_invite_id: inviteId });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean };
};

export const redeemPlatformInvite = async (
  inviteCode: string
): Promise<{ ok: boolean; role?: string; layer?: string; error?: string }> => {
  const { data, error } = await supabase.rpc('redeem_platform_invite', { p_invite_code: inviteCode });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; role?: string; layer?: string };
};

// =====================================================================
// PLATFORM CAPABILITY GRANTS (migration 077) — the active team roster
// (not just pending invites) and per-person, per-capability overrides
// on top of the 3 role-label defaults. Mirrors the shape of the
// invite functions above; every RPC is server-gated on the caller
// actually holding 'team.manage', not just being any platform admin.
// =====================================================================
export type PlatformCapability =
  | 'tenants.view' | 'tenants.manage' | 'tenants.provision'
  | 'remote_access.use' | 'remote_access.audit'
  | 'team.manage' | 'billing.manage' | 'support.cross_tenant';

export const PLATFORM_CAPABILITY_LABELS: Record<PlatformCapability, string> = {
  'tenants.view': 'View tenants',
  'tenants.manage': 'Manage tenants (approve requests, toggle feature flags)',
  'tenants.provision': 'Create new tenants',
  'remote_access.use': 'Remote-access a tenant workspace',
  'remote_access.audit': 'View Remote Access session logs',
  'team.manage': 'Manage the platform team (invite, edit roles, revoke access, set permissions)',
  'billing.manage': 'Manage platform-wide LLM provider keys',
  'support.cross_tenant': 'Cross-tenant support visibility',
};

export const PLATFORM_CAPABILITIES: PlatformCapability[] = [
  'tenants.view', 'tenants.manage', 'tenants.provision',
  'remote_access.use', 'remote_access.audit',
  'team.manage', 'billing.manage', 'support.cross_tenant',
];

export interface PlatformTeamMember {
  user_id: string;
  full_name: string | null;
  email: string;
  role: PlatformInviteRole;
  is_active: boolean;
  created_at: string;
  last_sign_in_at: string | null;
}

export const listPlatformTeam = async (): Promise<{ ok: boolean; members: PlatformTeamMember[]; error?: string }> => {
  const { data, error } = await supabase.rpc('list_platform_team');
  if (error) return { ok: false, members: [], error: error.message };
  return { ok: true, members: (data ?? []) as PlatformTeamMember[] };
};

export const updatePlatformTeamRole = async (
  userId: string, newRole: PlatformInviteRole
): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('update_platform_team_role', { p_target_user_id: userId, p_new_role: newRole });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean };
};

export const setPlatformTeamActive = async (
  userId: string, isActive: boolean
): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('set_platform_team_active', { p_target_user_id: userId, p_is_active: isActive });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean };
};

export interface PlatformCapabilityGrant {
  id: string;
  user_id: string;
  capability: PlatformCapability;
  effect: 'grant' | 'deny';
  granted_by: string | null;
  note: string;
  created_at: string;
  updated_at: string;
}

export const listPlatformCapabilityGrants = async (userId?: string): Promise<{ ok: boolean; grants: PlatformCapabilityGrant[]; error?: string }> => {
  const { data, error } = await supabase.rpc('list_platform_capability_grants', { p_target_user_id: userId ?? null });
  if (error) return { ok: false, grants: [], error: error.message };
  return { ok: true, grants: (data ?? []) as PlatformCapabilityGrant[] };
};

export const setPlatformCapabilityGrant = async (
  userId: string, capability: PlatformCapability, effect: 'grant' | 'deny', note?: string
): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('set_platform_capability_grant', {
    p_target_user_id: userId, p_capability: capability, p_effect: effect, p_note: note ?? '',
  });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean };
};

export const revokePlatformCapabilityGrant = async (
  userId: string, capability: PlatformCapability
): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('revoke_platform_capability_grant', { p_target_user_id: userId, p_capability: capability });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean };
};

/**
 * Sends a password-reset email to the given address — the same call
 * LoginPage's "Forgot password?" makes, reused here for an admin
 * triggering a reset on someone else's behalf (a team roster). Never
 * sees or sets the password directly — Supabase emails the person a
 * link, and they choose their own new password from there. Requires
 * no elevated privilege to call (same as the self-service flow), so
 * this is safe to expose to anyone who can already see a roster.
 */
export const sendPasswordReset = async (email: string): Promise<{ ok: boolean; error?: string }> => {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
};

export interface RemoteAccessStartResult {
  ok: boolean;
  session_key?: string;
  tenant_id?: string;
  tenant_name?: string;
  error?: string;
}

export const startPlatformRemoteAccess = async (tenantId: string): Promise<RemoteAccessStartResult> => {
  const { data, error } = await supabase.rpc('start_platform_remote_access', { p_tenant_id: tenantId });
  if (error) return { ok: false, error: error.message };
  return data as RemoteAccessStartResult;
};

export const endPlatformRemoteAccess = async (sessionKey: string): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('end_platform_remote_access', { p_session_key: sessionKey });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean };
};

// =====================================================
// KNOWLEDGE ARTICLE QUERIES
// =====================================================
// =====================================================


// =====================================================
// PLATFORM CONFIG (API keys stored in DB, platform-admin only)
// platform_config holds platform-wide secrets (LLM provider keys, email
// provider keys, per-tenant alert emails). RLS is deny-all for
// anon/authenticated (service_role only) as of the security audit — the
// table previously had RLS disabled entirely with default anon/authenticated
// grants, meaning anyone with the public anon key could read every secret
// in it with zero authentication (confirmed live during the audit). These
// helpers now go through SECURITY DEFINER RPCs that internally re-check
// is_platform_admin() before touching the table, rather than hitting
// platform_config directly from the client.
// =====================================================
export const savePlatformConfig = async (entries: Record<string, string>): Promise<boolean> => {
  const { error } = await supabase.rpc('platform_config_set', { p_entries: entries });
  if (error) { console.error('savePlatformConfig:', error.message); return false; }
  return true;
};

export const hasPlatformConfigKey = async (key: string): Promise<boolean> => {
  const { data, error } = await supabase.rpc('platform_config_has_key', { p_key: key });
  if (error) return false;
  return !!data;
};

// =====================================================
// PER-WORKSPACE MODEL KEYS (mig 541)
// =====================================================
// platform_config is global — one ANTHROPIC_API_KEY row for the whole platform,
// writable only by a platform admin. So the "enter your key" field on a tenant's
// Settings page could not work for the tenant, and when a platform admin used it
// the key applied to everyone. These go to the workspace's own credential.
export type LlmKeyMode = 'byo' | 'platform';
export interface TenantLlmKeyStatus {
  mode: LlmKeyMode;
  keys: Array<{ provider_key: string; status: 'untested' | 'working' | 'failing'; last_verified_at: string | null; last_error: string | null }>;
}

export const getTenantLlmKeyStatus = async (tenantId: string): Promise<TenantLlmKeyStatus | null> => {
  const { data, error } = await supabase.rpc('tenant_llm_key_status', { p_tenant_id: tenantId });
  if (error) { console.error('getTenantLlmKeyStatus:', error.message); return null; }
  const r = data as { ok?: boolean; mode?: LlmKeyMode; keys?: TenantLlmKeyStatus['keys'] } | null;
  if (!r?.ok) return null;
  return { mode: r.mode ?? 'platform', keys: r.keys ?? [] };
};

/** Returns null on success, or a message to show the operator. */
export const saveTenantLlmKey = async (tenantId: string, providerKey: string, value: string): Promise<string | null> => {
  const { data, error } = await supabase.rpc('set_tenant_llm_key', {
    p_tenant_id: tenantId, p_provider_key: providerKey, p_value: value,
  });
  if (error) return error.message;
  const r = data as { ok?: boolean; error?: string } | null;
  return r?.ok ? null : (r?.error ?? 'Could not save that key.');
};

export const clearTenantLlmKey = async (tenantId: string, providerKey: string): Promise<string | null> => {
  const { error } = await supabase.rpc('clear_tenant_llm_key', {
    p_tenant_id: tenantId, p_provider_key: providerKey,
  });
  return error ? error.message : null;
};

/** Which account pays for a workspace's model calls. Platform staff only.
 *
 *  ⚠ WAS a direct `from('tenants').update(...)`, which never worked for ANYONE:
 *  `tenants` has RLS with only a SELECT policy, so the write matched zero rows —
 *  and PostgREST reports zero rows as SUCCESS, not an error. It returned null
 *  (meaning "no error"), the caller believed it, and nothing changed. Migration
 *  633 added the RPC; the capability check lives inside it. */
export const setTenantLlmKeyMode = async (tenantId: string, mode: LlmKeyMode): Promise<string | null> => {
  const { data, error } = await supabase.rpc('set_tenant_llm_key_mode', {
    p_tenant_id: tenantId, p_mode: mode,
  });
  if (error) return error.message;
  // A Postgres error resolves rather than throws on .rpc(); an ok:false body is
  // the other way this can fail quietly.
  const r = data as { ok?: boolean; error?: string } | null;
  if (r && r.ok === false) return r.error ?? 'Could not change which account pays.';
  return null;
};

// =====================================================
// TENANT AI USAGE
// =====================================================
export interface TenantUsage {
  tenant_id: string;
  year_month: string;
  tokens_used: number;
}

export const fetchAllTenantsUsage = async (): Promise<TenantUsage[]> => {
  const yearMonth = new Date().toISOString().slice(0, 7);
  const { data, error } = await supabase
    .from('tenant_ai_usage')
    .select('tenant_id, year_month, tokens_used')
    .eq('year_month', yearMonth);
  if (error) { console.error('fetchAllTenantsUsage:', error.message); return []; }
  return data ?? [];
};

// Routed through a SECURITY DEFINER RPC (migration 083), capped for
// self-serve callers (migration 084) — same silent-no-op fix as
// updateTenant above, plus a ceiling so a tenant can't self-serve an
// unbounded AI-usage budget with no billing behind it.
export const updateTenantBudget = async (
  tenantId: string,
  monthlyTokenBudget: number
): Promise<{ ok: boolean; error?: string }> => {
  const { data, error } = await supabase.rpc('set_tenant_monthly_budget', {
    p_tenant_id: tenantId,
    p_budget: monthlyTokenBudget,
  });
  if (error) { console.error('updateTenantBudget:', error.message); return { ok: false, error: error.message }; }
  return { ok: !!(data as { ok?: boolean })?.ok };
};

// =====================================================


// ============================================================
// CSAT
// ============================================================

// Was a direct .update() against a `conversations` table that has never
// existed (migration 010's own mismatch) -- every real call has silently
// failed since this was written. Fixed at the source (migration 095):
// the real table is de_conversations, now reachable only via submit_csat.
export const submitCSAT = async (
  conversationId: string,
  tenantId: string,
  score: 1 | -1,
): Promise<boolean> => {
  const { error } = await supabase.rpc('submit_csat', {
    p_conversation_id: conversationId, p_tenant_id: tenantId, p_score: score,
  });
  if (error) console.error('submitCSAT:', error.message);
  return !error;
};

// ============================================================
// SECURITY & ACCESS — real team MFA status (migration 089)
// ============================================================

export interface TeamMfaStatusRow { user_id: string; mfa_verified: boolean }

// Owner/admin (of that tenant) or a platform admin (Remote Access) only --
// server-enforced; the RPC throws rather than returning partial data.
export const listTeamMfaStatus = async (tenantId: string): Promise<TeamMfaStatusRow[]> => {
  const { data, error } = await supabase.rpc('list_team_mfa_status', { p_tenant_id: tenantId });
  if (error) { console.error('listTeamMfaStatus:', error.message); return []; }
  return (data ?? []) as TeamMfaStatusRow[];
};

// ============================================================
// SECURITY & ACCESS — real API keys (migration 090)
// ============================================================

export interface TenantApiKey {
  id: string; name: string; display_hint: string; scopes: string[];
  created_at: string; last_used_at: string | null; revoked_at: string | null;
}

export const listTenantApiKeys = async (tenantId: string): Promise<TenantApiKey[]> => {
  const { data, error } = await supabase.rpc('list_tenant_api_keys', { p_tenant_id: tenantId });
  if (error) { console.error('listTenantApiKeys:', error.message); return []; }
  return (data ?? []) as TenantApiKey[];
};

// Returns the raw key exactly once -- the caller must show and let the
// user copy it immediately; it is never retrievable again after this call.
export const createTenantApiKey = async (
  tenantId: string, name: string, scopes: string[],
): Promise<{ ok: true; rawKey: string } | { ok: false; error: string }> => {
  const { data, error } = await supabase.rpc('create_tenant_api_key', {
    p_tenant_id: tenantId, p_name: name, p_scopes: scopes,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, rawKey: (data as { raw_key: string }).raw_key };
};

export const revokeTenantApiKey = async (keyId: string): Promise<{ ok: boolean; error?: string }> => {
  const { error } = await supabase.rpc('revoke_tenant_api_key', { p_key_id: keyId });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
};

// ============================================================
// SECURITY & ACCESS — real session policy (migration 091)
// ============================================================

export interface TenantSessionPolicy { timeout_minutes: number; mfa_required: boolean }

export const getTenantSessionPolicy = async (tenantId: string): Promise<TenantSessionPolicy | null> => {
  const { data, error } = await supabase.rpc('get_tenant_session_policy', { p_tenant_id: tenantId });
  if (error) { console.error('getTenantSessionPolicy:', error.message); return null; }
  return data as TenantSessionPolicy;
};

export const setTenantSessionPolicy = async (
  tenantId: string, timeoutMinutes: number, mfaRequired: boolean,
): Promise<{ ok: boolean; error?: string }> => {
  const { error } = await supabase.rpc('set_tenant_session_policy', {
    p_tenant_id: tenantId, p_timeout_minutes: timeoutMinutes, p_mfa_required: mfaRequired,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
};

// ============================================================
// SECURITY & ACCESS — real IP allowlist (migration 092)
// ============================================================

export interface TenantIpAllowlistEntry { id: string; ip_range: string; label: string }
export interface TenantIpAllowlist { enabled: boolean; entries: TenantIpAllowlistEntry[] }

export const getTenantIpAllowlist = async (tenantId: string): Promise<TenantIpAllowlist> => {
  const { data, error } = await supabase.rpc('get_tenant_ip_allowlist', { p_tenant_id: tenantId });
  if (error) { console.error('getTenantIpAllowlist:', error.message); return { enabled: false, entries: [] }; }
  return data as TenantIpAllowlist;
};

export const setTenantIpAllowlistEnabled = async (
  tenantId: string, enabled: boolean,
): Promise<{ ok: boolean; error?: string }> => {
  const { error } = await supabase.rpc('set_tenant_ip_allowlist_enabled', { p_tenant_id: tenantId, p_enabled: enabled });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
};

export const addTenantIpAllowlistEntry = async (
  tenantId: string, ipRange: string, label: string,
): Promise<{ ok: boolean; error?: string }> => {
  const { error } = await supabase.rpc('add_tenant_ip_allowlist_entry', {
    p_tenant_id: tenantId, p_ip_range: ipRange, p_label: label,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
};

export const removeTenantIpAllowlistEntry = async (entryId: string): Promise<{ ok: boolean; error?: string }> => {
  const { error } = await supabase.rpc('remove_tenant_ip_allowlist_entry', { p_entry_id: entryId });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
};

// Client-side IP-allowlist check (see check-ip-allowlist edge function's
// own header comment for why this isn't Vercel Edge Middleware). Fails
// open on any error -- a network hiccup must never look like a lockout.
export const checkMyIpAllowed = async (): Promise<boolean> => {
  try {
    const { data, error } = await invokeEdge('check-ip-allowlist', { method: 'POST' });
    if (error) { console.error('checkMyIpAllowed:', error.message); return true; }
    return (data as { allowed: boolean })?.allowed !== false;
  } catch (e) {
    console.error('checkMyIpAllowed:', e);
    return true;
  }
};

// ============================================================
// PERFORMANCE & INSIGHTS — real per-DE metrics (migrations 093-096)
// ============================================================

export interface DePerformanceMetrics {
  // mig 491: the five RATES are null when the platform never measured them —
  // an employee with no evidence used to display "0% escalation" while holding
  // nine real escalations. The COUNTS stay non-null: a zero there is a true
  // measurement. Render null as "not measured", never as a number.
  de_id: string; de_name: string; total_decisions: number; resolution_rate: number | null;
  avg_confidence: number | null; escalation_rate: number | null; blocked_guardrail_count: number;
  total_runs: number; error_rate: number | null;
  avg_frustration_score: number | null; high_frustration_count: number;
  trend: { week: string; decisions: number; resolution_rate: number; avg_confidence: number }[];
}

/** Work-shaped performance (mig 499/500) — the queue employee's own numbers.
 *
 *  Deliberately SEPARATE from DePerformanceMetrics rather than merged into it.
 *  Those metrics are computed over answered inquiries; a renewal case and a
 *  support conversation share no denominator, and blending them would push a
 *  support employee's escalation rate around with zero change in its behaviour.
 *  Rates are null when there is no denominator — never 0. */
export interface DeWorkMetrics {
  de_id: string; de_name: string; archetype_key: string | null;
  items_completed: number; items_cancelled: number; items_waiting_human: number;
  escalations_raised: number; escalations_answered: number; escalations_unanswered: number;
  escalation_rate: number | null; oldest_unanswered_hours: number | null;
  goals_open: number; goals_blocked: number; goals_needing_attention: number;
  attention_oldest_since: string | null;
  wakes_recorded: number; wakes_concluded_blocked: number;
}

/** What good work means for THIS employee's role (mig 502, founder decision D3).
 *
 *  Each metric carries `measurable` and, when false, a plain-language reason.
 *  That is the point rather than a detail: most of the renewal contract cannot
 *  be computed yet — no renewal has ever been closed in this platform — and
 *  rendering 0% would tell a manager the employee missed every renewal. Never
 *  render a value when measurable is false; render the reason. */
export interface DeContractMetric {
  metric_key: string; tier: 'primary' | 'secondary'; label: string;
  unit: 'cents' | 'percent' | 'count' | 'unknown';
  value: number | null; target: number | null;
  measurable: boolean; unmeasurable_because: string | null;
}

export const getDeContractMetrics = async (tenantId: string, deId: string): Promise<DeContractMetric[]> => {
  const { data, error } = await supabase.rpc('get_de_contract_metrics', { p_tenant_id: tenantId, p_de_id: deId });
  if (error) { console.error('getDeContractMetrics:', error.message); return []; }
  return (data ?? []) as DeContractMetric[];
};

export const getDeWorkMetrics = async (tenantId: string, weeks = 26): Promise<DeWorkMetrics[]> => {
  const { data, error } = await supabase.rpc('get_de_work_metrics', { p_tenant_id: tenantId, p_weeks: weeks });
  if (error) { console.error('getDeWorkMetrics:', error.message); return []; }
  return (data ?? []) as DeWorkMetrics[];
};

export const getDePerformanceMetrics = async (tenantId: string): Promise<DePerformanceMetrics[]> => {
  const { data, error } = await supabase.rpc('get_de_performance_metrics', { p_tenant_id: tenantId });
  if (error) { console.error('getDePerformanceMetrics:', error.message); return []; }
  return (data ?? []) as DePerformanceMetrics[];
};

export interface DeCostMetrics {
  de_id: string; total_calls: number; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number;
}

export const getDeCostMetrics = async (tenantId: string): Promise<DeCostMetrics[]> => {
  const { data, error } = await supabase.rpc('get_de_cost_metrics', { p_tenant_id: tenantId });
  if (error) { console.error('getDeCostMetrics:', error.message); return []; }
  return (data ?? []) as DeCostMetrics[];
};

export interface DeCsatMetrics { de_id: string; total_ratings: number; positive_ratings: number; csat_pct: number }

export const getDeCsatMetrics = async (tenantId: string): Promise<DeCsatMetrics[]> => {
  const { data, error } = await supabase.rpc('get_de_csat_metrics', { p_tenant_id: tenantId });
  if (error) { console.error('getDeCsatMetrics:', error.message); return []; }
  return (data ?? []) as DeCsatMetrics[];
};

// The "doing" half of Performance — real actions each DE took in
// connected systems (action_executions), not just its answer quality.
export interface DeActionMetrics {
  de_id: string;
  total_events: number;
  executed: number;         // really happened (auto + approved)
  auto_executed: number;    // without a human
  approved_after_gate: number;
  sent_to_human: number;    // routed for approval (the gate load)
  blocked: number;          // guardrail / access-denied
  rejected: number;
  failed: number;
  autonomy_rate: number | null; // % of executed done without a human
}

// days: number of days to window (null = all time).
export const getDeActionMetrics = async (tenantId: string, days: number | null = null): Promise<DeActionMetrics[]> => {
  const { data, error } = await supabase.rpc('get_de_action_metrics', { p_tenant_id: tenantId, p_days: days });
  if (error) { console.error('getDeActionMetrics:', error.message); return []; }
  return (data ?? []) as DeActionMetrics[];
};

// Windowed inquiry counts + answer quality (the answering half), used by
// the Performance/Insights date-range selector. Distinct from the evolved
// (all-time) get_de_performance_metrics, which still serves the trend.
export interface DeInquiryMetrics {
  de_id: string; total_decisions: number; resolution_rate: number; avg_confidence: number; escalation_rate: number;
}
export const getDeInquiryMetrics = async (tenantId: string, days: number | null = null): Promise<DeInquiryMetrics[]> => {
  const { data, error } = await supabase.rpc('get_de_inquiry_metrics', { p_tenant_id: tenantId, p_days: days });
  if (error) { console.error('getDeInquiryMetrics:', error.message); return []; }
  return (data ?? []) as DeInquiryMetrics[];
};

// Outcome-priced metering (mig 175): what the workforce RESOLVED and what
// that's worth at the tenant's per-resolution price; escalations are free.
export interface OutcomeMetering {
  totals: { resolutions: number; escalations: number; billable_amount_cents: number };
  by_de: Array<{ de_id: string | null; name: string; resolutions: number; escalations: number; amount_cents: number }>;
  by_day: Array<{ day: string; resolutions: number; escalations: number }>;
  price_per_resolution_cents: number;
}
export const getOutcomeMetering = async (tenantId: string, days: number | null = 30): Promise<OutcomeMetering | null> => {
  const from = days == null ? new Date(0).toISOString() : new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase.rpc('get_outcome_metering', { p_tenant_id: tenantId, p_from: from, p_to: new Date().toISOString() });
  if (error) { console.error('getOutcomeMetering:', error.message); return null; }
  return (data ?? null) as OutcomeMetering | null;
};

// Honest benchmark report (mig 176): all-traffic denominators, judged
// quality, submitted-only CSAT, real cost — definitions embedded in payload.
export interface BenchmarkReport {
  window_days: number;
  outcomes: { resolutions: number; escalations: number; resolution_rate_pct: number | null };
  judged_quality: { graded: number; pass_rate_pct: number | null; avg_score: number | null };
  csat: { ratings: number; positive_pct: number | null };
  cost: { ai_spend_cents: number; cost_per_resolution_cents: number | null };
  capability: { status: string; passed?: number; total?: number; avg_score?: number; mode?: string; ran_at?: string };
  definitions: Record<string, string>;
}
export const getBenchmarkReport = async (tenantId: string, days: number | null = 30): Promise<BenchmarkReport | null> => {
  const { data, error } = await supabase.rpc('get_benchmark_report', { p_tenant_id: tenantId, p_days: days ?? 365 });
  if (error) { console.error('getBenchmarkReport:', error.message); return null; }
  return (data ?? null) as BenchmarkReport | null;
};

// Windowed AI cost — same shape as getDeCostMetrics but time-bounded.
export const getDeCostMetricsRanged = async (tenantId: string, days: number | null = null): Promise<DeCostMetrics[]> => {
  const { data, error } = await supabase.rpc('get_de_cost_metrics_ranged', { p_tenant_id: tenantId, p_days: days });
  if (error) { console.error('getDeCostMetricsRanged:', error.message); return []; }
  return (data ?? []) as DeCostMetrics[];
};

export interface DeGuardrailActivity {
  de_id: string | null; de_name: string | null; gated_count: number; blocked_count: number;
  tenant_total_events: number; tenant_attributed_events: number;
}

export const getDeGuardrailActivity = async (tenantId: string): Promise<DeGuardrailActivity[]> => {
  const { data, error } = await supabase.rpc('get_de_guardrail_activity', { p_tenant_id: tenantId, p_days: 30 });
  if (error) { console.error('getDeGuardrailActivity:', error.message); return []; }
  return (data ?? []) as DeGuardrailActivity[];
};

export interface RecentEvalFailure {
  id: string; trigger: string; total: number; passed: number; failed: number;
  started_at: string; finished_at: string | null;
}

export const getRecentEvalFailures = async (tenantId: string): Promise<RecentEvalFailure[]> => {
  const { data, error } = await supabase.rpc('get_recent_eval_failures', { p_tenant_id: tenantId, p_limit: 5 });
  if (error) { console.error('getRecentEvalFailures:', error.message); return []; }
  return (data ?? []) as RecentEvalFailure[];
};

// =====================================================
// PLATFORM TENANT OVERVIEW (migration 200) — admin identity,
// real DE/user counts, last activity per tenant, keyed by id.
// =====================================================
export interface TenantOverviewRow {
  tenant_id: string;
  admin_name: string | null;
  admin_email: string | null;
  de_count: number;
  user_count: number;
  last_activity: string | null;
}

export const fetchPlatformTenantOverview = async (): Promise<Record<string, TenantOverviewRow>> => {
  const { data, error } = await supabase.rpc('get_platform_tenant_overview');
  if (error) { console.error('fetchPlatformTenantOverview:', error.message); return {}; }
  const rows = (data ?? []) as TenantOverviewRow[];
  return Object.fromEntries(rows.map((r) => [r.tenant_id, r]));
};

/** Outbound-dispatch and scheduled-job health for a window (platform admin only —
 *  get_dispatch_health raises for anyone else).
 *
 *  This reader exists because the function did not have one (register C-2). It
 *  was written in migration 366 and then read by nothing, which is the exact
 *  reason two failures in this review went unseen for days: the reconcile job
 *  failing 48 times a day, and a connector retried 6,700 times against a dead
 *  endpoint. Both are counted here, and nobody was counting. */
export interface DispatchHealth {
  window_hours: number;
  http_total: number;
  http_failed: number;
  http_timed_out: number;
  cron_runs: number;
  cron_failed: number;
  worst_error: string | null;
  last_failure_at: string | null;
}

export const fetchDispatchHealth = async (hours = 24): Promise<DispatchHealth | null> => {
  const { data, error } = await supabase.rpc('get_dispatch_health', { p_hours: hours });
  if (error) { console.error('fetchDispatchHealth:', error.message); return null; }
  const row = (data ?? [])[0] as DispatchHealth | undefined;
  return row ?? null;
};
