import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../supabase';
import {
  fetchTenants,
  fetchTenantById,
  fetchDashboardStats,
  fetchMyProfile,
  DBTenant,
} from '../lib/api';
import type { AuthUser, Tenant, Page } from '../types';
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
      };
      setAuthedUser(au);
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
        const profile = await fetchMyProfile();
        if (_cleanup) return;
        const tid = (profile?.tenant_id ?? authedUser.tenantId) as string | undefined;
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

  const isDTUser = !!(authedUser && ['dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing'].includes(authedUser.role));
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
    if (['dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing'].includes(u.role)) {
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
    if (canAccessPage(authedUser.role, p)) setCurrentPage(p);
  };

  const refreshTenant = async () => {
    const tid = authedUser?.tenantId ?? dbCurrentTenant?.id;
    if (!tid) return;
    const t = await fetchTenantById(tid);
    setDbCurrentTenant(t);
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
