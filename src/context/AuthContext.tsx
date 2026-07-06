import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../supabase';
import {
  fetchTenants,
  fetchTenantById,
  fetchDashboardStats,
  fetchMyProfile,
  DBTenant,
} from '../lib/api';
import type { AuthUser, Tenant, Page, UserRole } from '../types';
import { canAccessPage } from '../lib/mockData';
import { COMPANIES_LOOKUP } from '../data/companies';
import type { CompanyProfile, CompanyId } from '../data/companies';

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
  handleLogin: (u: AuthUser) => void;
  handleLogout: () => Promise<void>;
  handleSetPage: (p: Page) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setGodModeSession: (s: GodModeSession | null) => void;
  refreshTenant: () => Promise<void>;
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
  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [dbCurrentTenant, setDbCurrentTenant] = useState<DBTenant | null>(null);

  // Tri-state, not boolean: undefined = not resolved yet (still loading, or
  // no session), true = a real profile row was fetched and it genuinely has
  // no tenant_id (needs the org-setup screen), false = has a tenant, OR the
  // profile fetch itself failed/ambiguous (never force setup on a transient
  // error — that would be its own kind of false positive).
  const [profileHasNoTenant, setProfileHasNoTenant] = useState<boolean | undefined>(undefined);

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
        const profile = await fetchMyProfile();
        if (!active) return;
        buildFromProfile(sess.user, profile);
      } catch (e) { /* no session: stay on login */ }
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') { setAuthedUser(null); setCurrentPage('dashboard'); }
    });
    return () => { active = false; if (sub && sub.subscription) sub.subscription.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load DB data when user changes
  useEffect(() => {
    let _cleanup = false;
    void (async () => {
      try {
        if (!authedUser) {
          setDbTenants([]); setDbStats(null);
          return;
        }
        // The dev-only demo login never touches Supabase and always carries
        // its own synthetic tenantId — never route it through the org-setup
        // check.
        if (authedUser.id === 'dev-demo-user') {
          setProfileHasNoTenant(false);
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
          if (!_cleanup) setDbTenants(t);
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
    })();
    return () => { _cleanup = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authedUser?.id]);

  const isDTUser = !!(authedUser && (['dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing'].includes(authedUser.role) || authedUser.layer === 'platform'));
  const isTenantUser = !!(authedUser && ['tenant_owner', 'tenant_admin', 'tenant_manager', 'tenant_user'].includes(authedUser.role));

  const activeCompany: CompanyProfile = COMPANIES_LOOKUP[activeCompanyId];

  // ── Live vs demo mode ────────────────────────────────────────────
  // Demo when: dev demo login, no tenant, non-UUID tenant, or the seeded
  // demo tenant UUID. Live tenants can still opt into the demo story.
  const userTenantId = authedUser?.tenantId as string | undefined;
  const isLiveTenant = !!(
    authedUser &&
    authedUser.id !== 'dev-demo-user' &&
    userTenantId &&
    UUID_RE.test(userTenantId) &&
    userTenantId.toLowerCase() !== DEMO_TENANT_ID
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
        }
      : undefined);

  const handleLogin = (u: AuthUser) => {
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
    setDbStats(null);
    setDbCurrentTenant(null);
  };

  return (
    <AuthContext.Provider value={{
      authedUser,
      currentPage,
      sidebarCollapsed,
      godModeSession,
      dbTenants,
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
      handleLogin,
      handleLogout,
      handleSetPage,
      setSidebarCollapsed,
      setGodModeSession,
      refreshTenant,
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
