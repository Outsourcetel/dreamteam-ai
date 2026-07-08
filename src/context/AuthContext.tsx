import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../supabase';
import {
  fetchTenants,
  fetchTenantById,
  fetchDashboardStats,
  fetchMyProfile,
  DBTenant,
} from '../lib/api';
import { checkMyAccountStatus, startPlatformRemoteAccess, endPlatformRemoteAccess } from '../lib/api';
import type { AuthUser, Tenant, Page, UserRole } from '../types';
import { canAccessPage } from '../lib/mockData';
import { COMPANIES_LOOKUP } from '../data/companies';
import type { CompanyProfile, CompanyId } from '../data/companies';
import { setGodModeTenantIdOverride } from '../lib/customerApi';

interface DbStats {
  totalConversations: number;
  openConversations: number;
  resolvedConversations: number;
  totalArticles: number;
  publishedArticles: number;
  pendingApprovals: number;
  autoResolved: number;
  channelBreakdown: { chat: number; email: number; phone: number };
  sentimentBreakdown: { positive: number; neutral: number; negative: number };
}

interface GodModeSession {
  tenant: Tenant;
  operator: AuthUser;
  /** platform_access_events.session_key for this Remote Access session —
   *  ties the start/end audit pair together server-side. */
  sessionKey: string;
}

export type { CompanyProfile, CompanyId } from '../data/companies';

// The seeded demo tenant in Supabase. Users on this tenant (or the local dev
// demo login) see the TCP/PWC demo story; every other tenant is a LIVE tenant.
export const DEMO_TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DataMode = 'demo' | 'live';

interface AuthContextValue {
  authedUser: AuthUser | null;
  currentPage: Page;
  sidebarCollapsed: boolean;
  godModeSession: GodModeSession | null;
  dbTenants: DBTenant[];
  /** true once the platform-scoped tenants fetch has completed (success or
   *  empty) at least once — lets the platform console tell "still loading"
   *  apart from "genuinely zero tenants" instead of guessing from length. */
  dbTenantsLoaded: boolean;
  dbStats: DbStats | null;
  currentTenant: Tenant | undefined;
  isDTUser: boolean;
  isTenantUser: boolean;
  activeCompanyId: CompanyId;
  setActiveCompanyId: (id: CompanyId) => void;
  activeCompany: CompanyProfile;
  /** true when the logged-in user's tenant is a real (non-demo) tenant */
  isLiveTenant: boolean;
  /** live tenants can still explore the TCP/PWC demo story */
  viewingDemo: boolean;
  setViewingDemo: (v: boolean) => void;
  /** 'live' → Customer-section pages read real Supabase data; 'demo' → seed data */
  dataMode: DataMode;
  liveTenantName: string | null;
  /**
   * true when a genuinely authenticated, confirmed user's profile has no
   * tenant_id yet (signup's tenant-provisioning step never ran or hasn't
   * completed). This must route to the "set up your organization" screen,
   * NEVER silently fall through to demo mode. Always false for the
   * dev-demo-user login path.
   */
  needsOrgSetup: boolean;
  /** Called by the org-setup screen once complete_signup succeeds, to
   *  re-pull the profile/tenant and clear needsOrgSetup. */
  completeOrgSetup: (tenantId: string) => Promise<void>;
  /**
   * Non-null right after a session was force-ended because the account's
   * profile.is_active is false — either caught at session-restore/sign-in,
   * or mid-session via the periodic resync check. LoginPage shows this as
   * a clear message ("This account has been deactivated") rather than
   * silently landing back on the sign-in form. Cleared on the next login
   * attempt.
   */
  deactivatedMessage: string | null;
  clearDeactivatedMessage: () => void;
  /**
   * True from the moment Supabase's client detects a password-recovery
   * link in the URL (the PASSWORD_RECOVERY auth event — fired when
   * someone clicks a "reset your password" email, self-requested via
   * LoginPage or admin-triggered from a team roster) until they set a
   * new password. Checked in App.tsx BEFORE the normal authedUser gate,
   * since Supabase's recovery link establishes a real signed-in session
   * — without this flag, the person would land straight in their normal
   * workspace instead of being asked to set a new password first.
   */
  passwordRecoveryActive: boolean;
  /** Sets the new password on the recovery session and clears
   *  passwordRecoveryActive on success. */
  completePasswordRecovery: (newPassword: string) => Promise<{ ok: boolean; error?: string }>;
  handleLogin: (u: AuthUser) => Promise<void>;
  handleLogout: () => Promise<void>;
  handleSetPage: (p: Page) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setGodModeSession: (s: GodModeSession | null) => void;
  refreshTenant: () => Promise<void>;
  /**
   * Remote Access ("god-mode"), platform-owner-only: starts a durably
   * audited session against p_tenant_id (platform_access_events, via the
   * start_platform_remote_access RPC — gated by is_platform_admin() at
   * the DB layer, so this is unreachable by any tenant-layer user even if
   * the UI entry point were somehow bypassed). Returns true on success.
   */
  enterRemoteAccess: (tenant: Tenant) => Promise<{ ok: boolean; error?: string }>;
  /** Ends the current Remote Access session (audited: an 'end' event
   *  paired to the same session_key) and returns to Platform Console. */
  exitRemoteAccess: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authedUser, setAuthedUser] = useState<AuthUser | null>(null);
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [godModeSession, setGodModeSession] = useState<GodModeSession | null>(null);
  const [activeCompanyId, setActiveCompanyId] = useState<CompanyId>('tcp');
  const [viewingDemo, setViewingDemo] = useState(false);

  const [dbTenants, setDbTenants] = useState<DBTenant[]>([]);
  const [dbTenantsLoaded, setDbTenantsLoaded] = useState(false);
  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [dbCurrentTenant, setDbCurrentTenant] = useState<DBTenant | null>(null);

  // Keeps the shared "Live" API libs (customerApi.ts + everything built on
  // its requireTenantId()) in sync with which tenant a platform admin is
  // currently viewing via Remote Access -- see setGodModeTenantIdOverride's
  // own comment for why this is needed at all.
  useEffect(() => {
    setGodModeTenantIdOverride(godModeSession?.tenant?.id ?? null);
  }, [godModeSession]);

  // Tri-state, not boolean: undefined = not resolved yet (still loading, or
  // no session), true = a real profile row was fetched and it genuinely has
  // no tenant_id (needs the org-setup screen), false = has a tenant, OR the
  // profile fetch itself failed/ambiguous (never force setup on a transient
  // error — that would be its own kind of false positive).
  const [profileHasNoTenant, setProfileHasNoTenant] = useState<boolean | undefined>(undefined);
  const [deactivatedMessage, setDeactivatedMessage] = useState<string | null>(null);
  const clearDeactivatedMessage = () => setDeactivatedMessage(null);
  const [passwordRecoveryActive, setPasswordRecoveryActive] = useState(false);

  const completePasswordRecovery = async (newPassword: string): Promise<{ ok: boolean; error?: string }> => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return { ok: false, error: error.message };
    setPasswordRecoveryActive(false);
    return { ok: true };
  };

  // Force-ends the current session because the account has been
  // deactivated (profile.is_active === false). Signs out of Supabase,
  // clears local auth state, and surfaces a clear message on the login
  // screen instead of silently leaving the user on a stale session.
  // Sweeps every dt_-prefixed localStorage key rather than hand-listing
  // each one -- a blanket prefix sweep automatically covers keys future
  // features add, without needing to remember to update an enumerated
  // list each time. On a shared device, these otherwise survive sign-out
  // and can leak fragments of the previous user's local UI state
  // (roster selection, governance/security preferences, chat threads)
  // into the next login before their own data loads.
  const clearLocalTenantState = () => {
    try {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith('dt_'));
      keys.forEach((k) => localStorage.removeItem(k));
    } catch { /* noop */ }
  };

  const forceSignOutDeactivated = async () => {
    try { await supabase.auth.signOut(); } catch { /* noop */ }
    setAuthedUser(null);
    setDbTenants([]);
    setDbTenantsLoaded(false);
    setDbStats(null);
    setDbCurrentTenant(null);
    setGodModeSession(null);
    setCurrentPage('dashboard');
    setDeactivatedMessage('This account has been deactivated. Contact your platform owner if you believe this is a mistake.');
    clearLocalTenantState();
  };

  // Restore Supabase session on load
  useEffect(() => {
    let active = true;
    const buildFromProfile = (sessionUser: any, profile: any) => {
      const layer = profile && profile.layer ? profile.layer : 'tenant';
      const role = (profile && profile.role) ? profile.role : (sessionUser.user_metadata && sessionUser.user_metadata.role) || 'tenant_user';
      const au: AuthUser = {
        id: sessionUser.id,
        name: (profile && profile.full_name) || (sessionUser.user_metadata && sessionUser.user_metadata.full_name) || sessionUser.email || 'User',
        email: sessionUser.email || '',
        role: role,
        tenantId: (profile && profile.tenant_id) || (sessionUser.user_metadata && sessionUser.user_metadata.tenant_id) || undefined,
        avatar: (profile && profile.avatar) || undefined,
        layer: layer as 'platform' | 'tenant' | 'end_user',
      };
      setAuthedUser(au);
      // Only a genuine, successfully-fetched profile row with a null
      // tenant_id counts as "needs setup" — see profileHasNoTenant comment.
      setProfileHasNoTenant(!!profile && !profile.tenant_id);
      const isPlatform = ['dt_super_admin','dt_god_access','dt_support','dt_billing'].includes(au.role) || layer === 'platform';
      if (isPlatform) {
        setCurrentPage('platform_home');
      } else {
        // First login for this tenant user → land on Company Setup once.
        let firstLogin = false;
        try {
          if (au.id && !localStorage.getItem('dt_onboarded_' + au.id)) {
            firstLogin = true;
            localStorage.setItem('dt_onboarded_' + au.id, '1');
          }
        } catch (e) {}
        setCurrentPage(firstLogin ? 'company_setup' : 'dashboard');
      }
    };
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const sess = data && data.session;
        if (!active || !sess || !sess.user) return;
        // Authoritative deactivation check BEFORE trusting anything else
        // about this session. A stale session for a since-deactivated
        // account must never be allowed to "restore" — is_active is
        // enforced here, not just at the point of fresh sign-in.
        const status = await checkMyAccountStatus();
        if (!active) return;
        if (status && status.found && status.is_active === false) {
          await forceSignOutDeactivated();
          return;
        }
        const profile = await fetchMyProfile();
        if (!active) return;
        buildFromProfile(sess.user, profile);
      } catch (e) { /* no session: stay on login */ }
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') { setAuthedUser(null); setCurrentPage('dashboard'); }
      // Fires when the URL carries a password-recovery link's tokens
      // (self-requested via "Forgot password?" or an admin-triggered
      // reset from a team roster). Takes priority over whatever the
      // normal session-restore effect above does with this same
      // session — see passwordRecoveryActive's doc comment.
      else if (event === 'PASSWORD_RECOVERY') { setPasswordRecoveryActive(true); }
    });
    return () => { active = false; if (sub && sub.subscription) sub.subscription.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load DB data when user changes, AND periodically resync (role/layer/
  // tenant/is_active) for an already-logged-in session. The periodic tick
  // is what makes deactivation take effect mid-session, not just at the
  // next fresh login — see is_active enforcement notes above.
  useEffect(() => {
    let _cleanup = false;
    const syncProfile = async () => {
      try {
        if (!authedUser) {
          setDbTenants([]); setDbTenantsLoaded(false); setDbStats(null);
          return;
        }
        // The dev-only demo login never touches Supabase and always carries
        // its own synthetic tenantId — never route it through the org-setup
        // or deactivation check.
        if (authedUser.id === 'dev-demo-user') {
          setProfileHasNoTenant(false);
          return;
        }
        // Authoritative deactivation check on every resync tick — this is
        // what force-ends an ALREADY-LOGGED-IN session promptly if the
        // account gets deactivated while the user is still using the app,
        // not just at the next fresh sign-in.
        const status = await checkMyAccountStatus();
        if (_cleanup) return;
        if (status && status.found && status.is_active === false) {
          await forceSignOutDeactivated();
          return;
        }
        const profile = await fetchMyProfile();
        if (_cleanup) return;
        setProfileHasNoTenant(!!profile && !profile.tenant_id);
        const tid = (profile?.tenant_id ?? authedUser.tenantId) as string | undefined;
        // authedUser.tenantId is seeded from Supabase Auth user_metadata at
        // sign-IN time (see LoginPage's handleLogin), which is only ever set
        // once at signUp and never updated afterward. profiles.tenant_id is
        // the source of truth and can change later (e.g. exactly the
        // complete_signup / org-setup flow this tenant-id mismatch would
        // otherwise silently defeat: a user signs in, profile now has a real
        // tenant_id, but authedUser.tenantId is still stale/null, so
        // isLiveTenant would wrongly compute false and they'd see the demo
        // dashboard instead of their own data). Keep authedUser in sync.
        if (profile?.tenant_id && profile.tenant_id !== authedUser.tenantId) {
          setAuthedUser(prev => (prev ? { ...prev, tenantId: profile.tenant_id } : prev));
        }
        // Same staleness problem as tenantId above, for role/layer: a direct
        // sign-in seeds these from Supabase Auth user_metadata (set once at
        // signup, e.g. LoginPage's handleLogin), not the live profiles row.
        // A platform account created/promoted after signup (or whose
        // metadata was simply never populated — true of every seed account
        // in this project) would otherwise never be recognized as platform
        // by isDTUser/canAccessPage, which read authedUser.role/.layer, not
        // the database directly. Keep both in sync with the source of truth.
        if (profile?.role && profile.role !== authedUser.role) {
          setAuthedUser(prev => (prev ? { ...prev, role: profile.role as UserRole } : prev));
        }
        if (profile?.layer && profile.layer !== authedUser.layer) {
          setAuthedUser(prev => (prev ? { ...prev, layer: profile.layer } : prev));
        }
        if (profile?.layer === 'platform') {
          const t = await fetchTenants();
          if (!_cleanup) { setDbTenants(t); setDbTenantsLoaded(true); }
          // A fresh direct sign-in (LoginPage's handleLogin) decides the
          // initial page from the STALE metadata-seeded layer, which is
          // 'tenant' for every account whose signup metadata never said
          // otherwise — true of every platform account in this project,
          // since none of them signed up through the normal tenant flow.
          // That leaves currentPage stuck at 'dashboard' even after this
          // effect corrects authedUser.layer to 'platform' a moment later,
          // and PlatformConsolePage has no case for 'dashboard' — it falls
          // through to a bare, contentless placeholder. Redirect to the
          // real Overview once, only if we're not already on a genuine
          // platform page (never clobber active navigation).
          if (!_cleanup) {
            setCurrentPage(prev => (prev.toString().startsWith('platform_') ? prev : 'platform_home'));
          }
        }
        if (tid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid)) {
          const [s, t] = await Promise.all([
            fetchDashboardStats(tid),
            fetchTenantById(tid),
          ]);
          if (!_cleanup) {
            setDbStats(s as any);
            setDbCurrentTenant(t);
          }
        }
      } catch(e) { console.error('[DT] data load:', e); }
    };
    void syncProfile();
    // Re-check every 60s so a deactivation applied by the platform owner
    // (or a tenant admin toggling a team member off) takes effect for an
    // already-open session promptly, not just on the next fresh login.
    const intervalId = setInterval(() => { void syncProfile(); }, 60000);
    return () => { _cleanup = true; clearInterval(intervalId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authedUser?.id]);

  const isDTUser = !!(authedUser && (['dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing'].includes(authedUser.role) || authedUser.layer === 'platform'));
  const isTenantUser = !!(authedUser && ['tenant_owner', 'tenant_admin', 'tenant_manager', 'tenant_user'].includes(authedUser.role));

  const activeCompany: CompanyProfile = COMPANIES_LOOKUP[activeCompanyId];

  // ── Live vs demo mode ────────────────────────────────────────────
  // Demo when: dev demo login, no tenant, non-UUID tenant, or the seeded
  // demo tenant UUID. Live tenants can still opt into the demo story.
  // A platform admin inside a Remote Access session is always "live" too --
  // godModeSession carries a real tenant's data (see currentTenant below),
  // but the operator's OWN authedUser.tenantId is null (platform accounts
  // have no tenant membership by design), so without this the whole app
  // would render Remote Access as demo mode. This was the exact bug behind
  // "Remote Access lands on the demo dashboard" — the session's tenant was
  // real, isLiveTenant just never looked at it.
  const userTenantId = authedUser?.tenantId as string | undefined;
  const isLiveTenant = !!(
    godModeSession ||
    (authedUser &&
      authedUser.id !== 'dev-demo-user' &&
      userTenantId &&
      UUID_RE.test(userTenantId) &&
      userTenantId.toLowerCase() !== DEMO_TENANT_ID)
  );
  const dataMode: DataMode = isLiveTenant && !viewingDemo ? 'live' : 'demo';
  const liveTenantName = isLiveTenant ? (dbCurrentTenant?.name ?? authedUser?.name ?? null) : null;

  // ── Needs org setup (post-signup recovery) ───────────────────────
  // A real, confirmed, authenticated TENANT user whose profile genuinely
  // has no tenant_id must see the "set up your organization" screen —
  // never the demo dashboard. Explicitly excludes the dev-demo-user login
  // path (never has a real profile row) AND platform-layer accounts, which
  // are SUPPOSED to have no tenant_id by design (a platform admin operates
  // above every tenant, not inside one) — without this exclusion, every
  // platform account would be wrongly routed into org setup forever.
  const needsOrgSetup = !!(
    authedUser &&
    authedUser.id !== 'dev-demo-user' &&
    authedUser.layer !== 'platform' &&
    profileHasNoTenant === true
  );

  // Build a Tenant UI object from the DB record, falling back to the
  // god-mode override if a DT support agent is operating on behalf of a tenant.
  const currentTenant: Tenant | undefined =
    godModeSession?.tenant ||
    (dbCurrentTenant
      ? {
          id:           dbCurrentTenant.id,
          name:         dbCurrentTenant.name,
          slug:         dbCurrentTenant.slug,
          primaryColor: dbCurrentTenant.accent_color ?? '#6366f1',
          accentColor:  dbCurrentTenant.accent_color ?? '#6366f1',
          plan:         dbCurrentTenant.plan,
          status:       dbCurrentTenant.status,
          industry:     dbCurrentTenant.industry ?? '',
          contactEmail: '',
          agentsActive: 0,
          usersCount:   0,
          monthlyTokens: 0,
          tokenLimit:   5000000,
          createdAt:    dbCurrentTenant.created_at,
          trialEndsAt:  dbCurrentTenant.trial_ends_at ?? null,
        }
      : undefined);

  const handleLogin = async (u: AuthUser) => {
    // Direct sign-in path: LoginPage builds `u` from Supabase Auth
    // user_metadata (set once at signup), which has no idea about a
    // later profiles.is_active = false toggle. Check the authoritative
    // status BEFORE ever setting authedUser — a deactivated account must
    // never get even a flash of an authenticated session. The dev-only
    // demo login never touches Supabase and is exempt.
    if (u.id !== 'dev-demo-user') {
      const status = await checkMyAccountStatus();
      if (status && status.found && status.is_active === false) {
        await forceSignOutDeactivated();
        return;
      }
    }
    setAuthedUser(u);
    if (['dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing'].includes(u.role) || u.layer === 'platform') {
      setCurrentPage('platform_home');
    } else {
      let firstLogin = false;
      try {
        if (u && u.id && !localStorage.getItem('dt_onboarded_' + u.id)) {
          firstLogin = true;
          localStorage.setItem('dt_onboarded_' + u.id, '1');
        }
      } catch (e) {}
      setCurrentPage(firstLogin ? 'company_setup' : 'dashboard');
    }
  };

  const handleSetPage = (p: Page) => {
    if (!authedUser) return;
    if (canAccessPage(authedUser.role, p, authedUser.layer)) setCurrentPage(p);
  };

  const refreshTenant = async () => {
    const tid = authedUser?.tenantId ?? dbCurrentTenant?.id;
    if (!tid) return;
    const t = await fetchTenantById(tid);
    setDbCurrentTenant(t);
  };

  // Remote Access ("god-mode"): the platform owner enters a real tenant's
  // workspace. Calls the DB-gated RPC first (is_platform_admin() enforced
  // server-side, so this is unreachable for any tenant-layer caller) which
  // writes a durable platform_access_events 'start' row and hands back a
  // session_key; only then do we flip the local godModeSession state that
  // drives the amber banner and currentTenant override.
  const enterRemoteAccess = async (tenant: Tenant): Promise<{ ok: boolean; error?: string }> => {
    if (!authedUser) return { ok: false, error: 'Not signed in.' };
    const res = await startPlatformRemoteAccess(tenant.id);
    if (!res.ok || !res.session_key) {
      console.error('[DT] enterRemoteAccess failed:', res.error);
      return { ok: false, error: res.error || 'Could not start Remote Access. Please try again.' };
    }
    setGodModeSession({ tenant, operator: authedUser, sessionKey: res.session_key });
    // currentPage may be a platform-only page (e.g. 'platform_remote_access')
    // that the tenant-side page switch has no case for. Land somewhere real.
    setCurrentPage('dashboard');
    return { ok: true };
  };

  // Ends the current Remote Access session: writes the paired 'end'
  // platform_access_events row (audited duration), then clears local
  // state and returns to Platform Console.
  const exitRemoteAccess = async () => {
    const sessionKey = godModeSession?.sessionKey;
    setGodModeSession(null);
    if (sessionKey) {
      const res = await endPlatformRemoteAccess(sessionKey);
      if (!res.ok) console.error('[DT] exitRemoteAccess audit failed:', res.error);
    }
  };

  // Called by the org-setup screen right after complete_signup() succeeds.
  // Re-pulls the (now-linked) profile and tenant, clears needsOrgSetup, and
  // lands the user on their brand-new, empty live dashboard.
  const completeOrgSetup = async (tenantId: string) => {
    setProfileHasNoTenant(false);
    setAuthedUser(prev => (prev ? { ...prev, tenantId } : prev));
    const t = await fetchTenantById(tenantId);
    setDbCurrentTenant(t);
    setCurrentPage('dashboard');
  };

  const handleLogout = async () => {
    // Clear the customerApi tenant cache so the next login re-resolves it.
    try { (await import('../lib/customerApi')).clearTenantCache(); } catch { /* noop */ }
    await supabase.auth.signOut();
    setViewingDemo(false);
    setAuthedUser(null as any);
    setCurrentPage('dashboard');
    setDbTenants([]);
    setDbTenantsLoaded(false);
    setDbStats(null);
    setDbCurrentTenant(null);
    setGodModeSession(null);
    clearLocalTenantState();
  };

  return (
    <AuthContext.Provider value={{
      authedUser,
      currentPage,
      sidebarCollapsed,
      godModeSession,
      dbTenants,
      dbTenantsLoaded,
      dbStats,
      currentTenant,
      isDTUser,
      isTenantUser,
      activeCompanyId,
      setActiveCompanyId,
      activeCompany,
      isLiveTenant,
      viewingDemo,
      setViewingDemo,
      dataMode,
      liveTenantName,
      needsOrgSetup,
      completeOrgSetup,
      deactivatedMessage,
      clearDeactivatedMessage,
      passwordRecoveryActive,
      completePasswordRecovery,
      handleLogin,
      handleLogout,
      handleSetPage,
      setSidebarCollapsed,
      setGodModeSession,
      refreshTenant,
      enterRemoteAccess,
      exitRemoteAccess,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
