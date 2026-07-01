import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../supabase';
import {
  fetchTenants,
  fetchTenantById,
  fetchKnowledgeArticles,
  fetchConversations,
  fetchDashboardStats,
  fetchMyProfile,
  DBTenant,
  DBKnowledgeArticle,
  DBConversation,
} from '../lib/api';
import type { AuthUser, Tenant, Page } from '../types';
import { canAccessPage } from '../lib/mockData';

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

interface AuthContextValue {
  authedUser: AuthUser | null;
  currentPage: Page;
  sidebarCollapsed: boolean;
  godModeSession: GodModeSession | null;
  showOnboarding: boolean;
  dbTenants: DBTenant[];
  dbArticles: DBKnowledgeArticle[];
  dbConversations: DBConversation[];
  dbStats: DbStats | null;
  currentTenant: Tenant | undefined;
  isDTUser: boolean;
  isTenantUser: boolean;
  handleLogin: (u: AuthUser) => void;
  handleLogout: () => Promise<void>;
  handleSetPage: (p: Page) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setGodModeSession: (s: GodModeSession | null) => void;
  setShowOnboarding: (v: boolean) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authedUser, setAuthedUser] = useState<AuthUser | null>(null);
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [godModeSession, setGodModeSession] = useState<GodModeSession | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const [dbTenants, setDbTenants] = useState<DBTenant[]>([]);
  const [dbArticles, setDbArticles] = useState<DBKnowledgeArticle[]>([]);
  const [dbConversations, setDbConversations] = useState<DBConversation[]>([]);
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
      setCurrentPage(isPlatform ? 'platform_home' : 'dashboard');
      if (!isPlatform) {
        try { if (!(au.id && localStorage.getItem('dt_onboarded_' + au.id))) setShowOnboarding(true); } catch (e) {}
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
          setDbTenants([]); setDbArticles([]); setDbConversations([]); setDbStats(null);
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
          const [a, c, s, t] = await Promise.all([
            fetchKnowledgeArticles(tid),
            fetchConversations(tid),
            fetchDashboardStats(tid),
            fetchTenantById(tid),
          ]);
          if (!_cleanup) {
            setDbArticles(a);
            setDbConversations(c);
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
      setCurrentPage('dashboard');
      try { if (!(u && u.id && localStorage.getItem('dt_onboarded_' + u.id))) setShowOnboarding(true); } catch (e) { setShowOnboarding(true); }
    }
  };

  const handleSetPage = (p: Page) => {
    if (!authedUser) return;
    if (canAccessPage(authedUser.role, p)) setCurrentPage(p);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setAuthedUser(null as any);
    setCurrentPage('dashboard');
    setDbTenants([]);
    setDbArticles([]);
    setDbConversations([]);
    setDbStats(null);
    setDbCurrentTenant(null);
  };

  return (
    <AuthContext.Provider value={{
      authedUser,
      currentPage,
      sidebarCollapsed,
      godModeSession,
      showOnboarding,
      dbTenants,
      dbArticles,
      dbConversations,
      dbStats,
      currentTenant,
      isDTUser,
      isTenantUser,
      handleLogin,
      handleLogout,
      handleSetPage,
      setSidebarCollapsed,
      setGodModeSession,
      setShowOnboarding,
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
