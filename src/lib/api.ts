import { supabase } from '../supabase';

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
  settings?: Record<string, unknown>;
  monthly_token_budget?: number;
  parent_tenant_id?: string | null;
  allow_self_serve_subtenants?: boolean;
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
  updates: Partial<Pick<DBTenant, 'name' | 'industry' | 'accent_color'>>
): Promise<boolean> => {
  const { data, error } = await supabase.rpc('update_tenant_general_settings', {
    p_tenant_id: id,
    p_name: updates.name ?? null,
    p_industry: updates.industry ?? null,
    p_accent_color: updates.accent_color ?? null,
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

export interface PlatformConnectorHealthRow {
  tenant_id: string;
  tenant_name: string;
  connector_id: string;
  display_name: string;
  provider: string;
  status: 'connected' | 'error' | 'disconnected';
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
// CONVERSATION QUERIES
// =====================================================
const createConversation = async (
  conv: Partial<DBConversation> & { tenant_id: string; channel: DBConversation['channel'] }
): Promise<DBConversation | null> => {
  const { data, error } = await supabase
    .from('conversations')
    .insert(conv)
    .select()
    .single();
  if (error) { console.error('createConversation:', error.message); return null; }
  return data;
};

const addMessage = async (
  msg: Omit<DBMessage, 'id' | 'created_at'>
): Promise<DBMessage | null> => {
  const { data, error } = await supabase
    .from('messages')
    .insert(msg)
    .select()
    .single();
  if (error) { console.error('addMessage:', error.message); return null; }
  return data;
};

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
// DASHBOARD STATS
// =====================================================
export const fetchDashboardStats = async (tenantId: string) => {
  const [convResult, kbResult, actionResult] = await Promise.all([
    supabase.from('conversations').select('status, sentiment, channel').eq('tenant_id', tenantId),
    supabase.from('knowledge_articles').select('status').eq('tenant_id', tenantId),
    supabase.from('agent_actions').select('status, requires_approval').eq('tenant_id', tenantId),
  ]);

  const convs = convResult.data ?? [];
  const articles = kbResult.data ?? [];
  const actions = actionResult.data ?? [];

  return {
    totalConversations: convs.length,
    openConversations: convs.filter(c => c.status === 'open').length,
    resolvedConversations: convs.filter(c => c.status === 'resolved').length,
    totalArticles: articles.length,
    publishedArticles: articles.filter(a => a.status === 'published').length,
    pendingApprovals: actions.filter(a => a.requires_approval && a.status === 'pending').length,
    autoResolved: convs.filter(c => c.status === 'resolved').length,
    channelBreakdown: {
      chat: convs.filter(c => c.channel === 'chat').length,
      email: convs.filter(c => c.channel === 'email').length,
      phone: convs.filter(c => c.channel === 'phone').length,
    },
    sentimentBreakdown: {
      positive: convs.filter(c => c.sentiment === 'positive').length,
      neutral: convs.filter(c => c.sentiment === 'neutral').length,
      negative: convs.filter(c => c.sentiment === 'negative').length,
    },
  };
};

// =====================================================
// AGENT BRAIN (Option A: zero-cost, rule-based + KB retrieval)
// Swap-in point for an LLM later: replace draftAgentAction's
// retrieval/compose block with an Edge Function call.
// =====================================================

interface AgentDraft {
  agentName: string;
  actionType: string;
  description: string;
  answer: string;
  confidence: number; // 0..1
  sources: { id: string; title: string }[];
  requiresApproval: boolean;
}

const STOPWORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','to','of','in',
  'on','for','with','my','i','me','can','you','your','do','does','how','what',
  'why','when','where','please','need','want','help','about','it','this','that',
]);

const tokenize = (s: string): string[] =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

// Score a query against an article by token overlap across title/tags/body.
const scoreArticle = (queryTokens: string[], a: DBKnowledgeArticle): number => {
  if (queryTokens.length === 0) return 0;
  const title = tokenize(a.title);
  const tags = (a.tags || []).flatMap((t) => tokenize(t));
  const body = tokenize(a.body).slice(0, 400);
  let hits = 0;
  let weighted = 0;
  for (const q of queryTokens) {
    if (title.includes(q)) { weighted += 3; hits++; }
    else if (tags.includes(q)) { weighted += 2; hits++; }
    else if (body.includes(q)) { weighted += 1; hits++; }
  }
  const coverage = hits / queryTokens.length; // how much of the query we matched
  const density = weighted / (queryTokens.length * 3); // normalized strength
  return Math.min(1, coverage * 0.6 + density * 0.4);
};

// Draft a proposed agent action by retrieving from the tenant KB.
//
// NOTE: this previously tried a `workforce-chat` Edge Function first (an
// unauthenticated, service-role-backed function that trusted a
// client-supplied tenantId with zero verification — a live cross-tenant
// data-leak vector if ever deployed). It was never actually deployed, but
// kept the vulnerable source file and this call site around as a landmine.
// Removed as part of the pre-launch security audit.
//
// CONSOLIDATED (found live during a founder product-demo walkthrough): this
// used to query the LEGACY knowledge_articles table via the search_knowledge
// RPC — pure Postgres full-text search, no semantic understanding, and a
// completely separate system from the one the real production DE pipeline
// (de-answer / widget-ask / specialist-consult) actually uses. On the live
// demo, knowledge_articles held exactly 3 rows total, all for a different
// tenant — the tenant being demoed had ZERO rows there, so every question
// correctly (but uselessly) escalated. This now calls hybrid_match_knowledge
// (migration 046) — the SAME shared retrieval RPC every other consumer uses,
// over the real knowledge_docs/knowledge_doc_chunks tables — combining
// lexical (ts_rank) and semantic (gte-small embeddings) signal via
// Reciprocal Rank Fusion. The browser cannot compute a gte-small embedding
// itself (that model only runs inside the Supabase.ai edge runtime), so
// p_query_embedding is omitted here and the RPC gracefully degrades to
// lexical-only ranking for this call site — still a real improvement over
// the old path (same production doc set, not a dead duplicate table), and
// still paraphrase-robust wherever a semantic-capable caller (de-answer,
// widget-ask, specialist-consult) already answered the same question and
// left embedded chunks behind. Only the RETRIEVAL changed — the
// confidence-gating/escalation logic below (auditAnswer, runPortalTurn) is
// untouched.
const draftAgentAction = async (
  tenantId: string,
  query: string,
  audience: 'customer' | 'internal' = 'customer',
  conversationId?: string | null,
  kbCategories?: string[]   // optional KB category filter for DE scoping (currently unused by hybrid_match_knowledge; retained for signature compat)
): Promise<AgentDraft> => {
  const APPROVAL_THRESHOLD = 0.55; // below => route to human approval
  const { data: rpcRows, error: searchErr } = await supabase.rpc('hybrid_match_knowledge', {
    p_tenant_id: tenantId,
    p_query_text: query,
    p_account_id: null,
    p_query_embedding: null, // browser can't run gte-small; lexical-only for this caller
    p_match_count: 3,
    p_subject_kind: null,
    p_subject_id: null,
  })
  if (searchErr) console.error('hybrid_match_knowledge:', searchErr.message)
  const rows: any[] = rpcRows || []
  const qTokens = tokenize(query)
  // Map RPC rows (doc_id/doc_title/content) to the article shape the rest of
  // this function expects, then derive a calibrated 0..1 confidence from
  // token overlap. RRF `score` is a small fused number (each component is
  // 1/(60+rank), max ~0.033 combined) — not itself a 0..1 confidence, so it
  // is only used to preserve fusion order, same role `rank` (ts_rank) played
  // before; the token-overlap score is still the primary confidence signal.
  const ranked = rows.map((r: any) => ({
    a: { id: r.doc_id, title: r.doc_title, summary: undefined, body: r.content || '',
         audience: audience, tags: [] } as Partial<DBKnowledgeArticle> as DBKnowledgeArticle,
    score: scoreArticle(qTokens, { title: r.doc_title, body: r.content, tags: [] } as DBKnowledgeArticle),
    rrfScore: Number(r.score) || 0,
  }))
  // Keep RPC (RRF) order; if token scoring found nothing, fall back to a
  // scaled RRF score (comparable role to the old ts_rank fallback).
  const anyTokenMatch = ranked.some((r) => r.score > 0)

  const top = ranked[0]
  const confidence = top ? (anyTokenMatch ? Math.round(top.score * 100) / 100
                                          : Math.min(1, Math.round(top.rrfScore * 30 * 100) / 100)) : 0
  const sources = ranked.map((r) => ({ id: r.a.id, title: r.a.title }));

  let answer: string;
  if (top && confidence >= 0.25) {
    const summary = top.a.summary || top.a.body.slice(0, 280);
    answer = summary + (ranked.length > 1 ? '' : '');
  } else {
    answer =
      'I could not find a confident answer in the knowledge base for this request. ' +
      'Routing to a human teammate for review.';
  }

  const requiresApproval = confidence < APPROVAL_THRESHOLD;
  const agentName =
    audience === 'customer' ? 'Support Agent' : 'Internal Assist Agent';
  const actionType = requiresApproval ? 'draft' : 'send';
  const description =
    (top ? `Drafted reply citing "${top.a.title}"` : 'No KB match found') +
    ` (confidence ${Math.round(confidence * 100)}%)`;

  return {
    agentName,
    actionType,
    description,
    answer,
    confidence,
    sources,
    requiresApproval,
  };
};

/* ===================== CUSTOMER PORTAL: ANSWER + AUDIT + ESCALATION ===================== */
interface PortalSource { id: string; title: string; }
interface PortalTurnResult {
  conversationId: string | null;
  answer: string;
  confidence: number;            // 0..1
  sources: PortalSource[];
  agentName: string;
  auditVerdict: 'passed' | 'review' | 'failed';
  auditNote: string;
  escalated: boolean;
  escalationId: string | null;
  escalationReason: string | null;
}

/* Bot audit review: a second-pass validator that runs BEFORE the answer is shown to the
   customer. It checks that the drafted answer is grounded (has sources), confident enough,
   and not the no-answer fallback. Deterministic + zero-cost; swap for an LLM critic later. */
const auditAnswer = (draft: AgentDraft): { verdict: 'passed' | 'review' | 'failed'; note: string; reason: string | null } => {
  const noAnswer = /could not find a confident answer/i.test(draft.answer || '');
  if (noAnswer || (draft.sources || []).length === 0) {
    return { verdict: 'failed', note: 'No grounded source found in the knowledge base; answer is not supported.', reason: 'no_answer' };
  }
  if (draft.confidence < 0.55) {
    return { verdict: 'failed', note: 'Confidence ' + Math.round(draft.confidence * 100) + '% is below the 55% auto-answer threshold.', reason: 'low_confidence' };
  }
  if (draft.confidence < 0.75) {
    return { verdict: 'review', note: 'Answer cites ' + draft.sources.length + ' source(s) but moderate confidence (' + Math.round(draft.confidence * 100) + '%); shown with a caution flag.', reason: null };
  }
  return { verdict: 'passed', note: 'Grounded in ' + draft.sources.length + ' source(s) at ' + Math.round(draft.confidence * 100) + '% confidence.', reason: null };
};

/* Full portal turn: retrieve -> audit -> persist -> auto-escalate on failure. */
export const runPortalTurn = async (
  tenantId: string, query: string,
  opts: { conversationId?: string | null; customerName?: string } = {}
): Promise<PortalTurnResult> => {
  const draft = await draftAgentAction(tenantId, query, 'customer');
  const audit = auditAnswer(draft);
  const escalate = audit.verdict === 'failed';

  // 1) conversation (reuse existing or create)
  let conversationId = opts.conversationId || null;
  if (!conversationId) {
    const conv = await createConversation({
      tenant_id: tenantId, channel: 'chat',
      status: escalate ? 'pending' : 'open',
      subject: query.slice(0, 120),
      customer_name: opts.customerName || 'Web Visitor',
      confidence_score: draft.confidence,
    } as any);
    conversationId = (conv && (conv as any).id) || null;
  }

  // 2) persist the customer message + the audited agent answer
  if (conversationId) {
    await addMessage({ conversation_id: conversationId, tenant_id: tenantId, role: 'user', content: query, requires_approval: false } as any);
    await addMessage({
      conversation_id: conversationId, tenant_id: tenantId, role: 'agent',
      content: draft.answer, confidence_score: draft.confidence,
      requires_approval: escalate, sources: draft.sources,
      audit_verdict: audit.verdict, audit_note: audit.note,
    } as any);
  }

  // 3) auto-escalate to a human when the audit fails
  let escalationId: string | null = null;
  if (escalate && conversationId) {
    const { data, error } = await supabase.from('escalations').insert({
      tenant_id: tenantId, conversation_id: conversationId,
      reason: audit.reason || 'low_confidence', question: query,
      draft_answer: draft.answer, confidence: draft.confidence, status: 'open',
    }).select().single();
    if (error) { console.error('runPortalTurn escalate:', error.message); }
    else { escalationId = (data as any).id; }
  }

  return {
    conversationId, answer: draft.answer, confidence: draft.confidence,
    sources: draft.sources, agentName: draft.agentName,
    auditVerdict: audit.verdict, auditNote: audit.note,
    escalated: escalate, escalationId, escalationReason: audit.reason,
  };
};

/* Manual escalation triggered by the customer or agent (always-available path). */

// ----- human escalation inbox: claim + resolve (staff-facing, RLS-gated) -----
// Resolve an escalation: post the human reply into the conversation as an agent message,
// flip the escalation to resolved and re-open/resolve the linked conversation.

// ============================================================
// CONVERSATION MANAGEMENT (admin take-over + resolve)
// ============================================================

// ============================================================
// CSAT
// ============================================================

export const submitCSAT = async (
  conversationId: string,
  tenantId: string,
  score: 1 | -1,
): Promise<boolean> => {
  const { error } = await supabase
    .from('conversations')
    .update({ csat_score: score, csat_submitted_at: new Date().toISOString() })
    .eq('id', conversationId)
    .eq('tenant_id', tenantId);
  if (error) console.error('submitCSAT:', error.message);
  return !error;
};

