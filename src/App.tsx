import React, { useEffect } from 'react';
import { BrowserRouter, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Sidebar } from './components';
import LoginPage from './pages/LoginPage';
import OnboardingWizard from './pages/OnboardingWizard';
import PlatformConsolePage from './pages/platform/PlatformConsolePage';
import DashboardPage from './pages/tenant/DashboardPage';
import AgentWorkforcePage from './pages/tenant/AgentWorkforcePage';
import KnowledgeHubPage from './pages/tenant/KnowledgeHubPage';
import KnowledgeDataPage from './pages/tenant/KnowledgeDataPage';
import CustomerPortalPage from './pages/tenant/CustomerPortalPage';
import InsightEnginePage from './pages/tenant/InsightEnginePage';
import SwarmPage from './pages/tenant/SwarmPage';
import SecurityPage from './pages/tenant/SecurityPage';
import IntegrationsPage from './pages/tenant/IntegrationsPage';
import DataConnectorsPage from './pages/tenant/DataConnectorsPage';
import SettingsPage from './pages/tenant/SettingsPage';
import FinanceControlTowerPage from './pages/tenant/FinanceControlTowerPage';
import RevenueWorkspacePage from './pages/tenant/RevenueWorkspacePage';
import HRWorkspacePage from './pages/tenant/HRWorkspacePage';
import AuditLogPage from './pages/tenant/AuditLogPage';
import UserManagementPage from './pages/tenant/UserManagementPage';
import CSWorkspacePage from './pages/tenant/CSWorkspacePage';
import ImplementationWorkspacePage from './pages/tenant/ImplementationWorkspacePage';
import ConnectorMarketplacePage from './pages/tenant/ConnectorMarketplacePage';
import ControlFabricPage from './pages/tenant/ControlFabricPage';
import CapabilitiesPage from './pages/tenant/CapabilitiesPage';
import IntelligencePlatformPage from './pages/tenant/IntelligencePlatformPage';
import PlaybooksPage from './pages/tenant/PlaybooksPage';
import ApprovalsPage from './pages/tenant/ApprovalsPage';
import EndUserChatPage from './pages/portal/EndUserChatPage';
import type { Page, PlatformPage } from './types';

// ── URL ↔ Page mapping ──────────────────────────────────────────
const PAGE_TO_URL: Record<string, string> = {
  platform_home:          '/platform',
  platform_tenants:       '/platform/tenants',
  platform_tenant_detail: '/platform/tenant-detail',
  platform_remote_access: '/platform/remote-access',
  platform_health:        '/platform/health',
  platform_revenue:       '/platform/revenue',
  dashboard:              '/dashboard',
  agents:                 '/agents',
  swarm:                  '/swarm',
  insight:                '/insight',
  finance:                '/finance',
  revenue:                '/revenue',
  hr:                     '/hr',
  cs:                     '/customer-success',
  implementation:         '/implementation',
  marketplace:            '/marketplace',
  control_fabric:         '/control-fabric',
  capabilities:           '/capabilities',
  intelligence:           '/intelligence',
  audit_log:              '/audit-log',
  admin_approvals:        '/approvals',
  users:                  '/users',
  playbooks:              '/playbooks',
  security:               '/security',
  integrations:           '/integrations',
  connectors:             '/connectors',
  settings:               '/settings',
  hub_overview:           '/knowledge/overview',
  hub_articles:           '/knowledge/articles',
  hub_ingestion:          '/knowledge/ingestion',
  hub_training:           '/knowledge/training',
  hub_analytics:          '/knowledge/analytics',
  knowledge_data:         '/knowledge/data',
  knowledge_taxonomy:     '/knowledge/taxonomy',
  knowledge_connectors:   '/knowledge/connectors',
  knowledge_files:        '/knowledge/files',
  portal_overview:        '/portal/overview',
  portal_conversations:   '/portal/conversations',
  portal_actions:         '/portal/actions',
  portal_approvals:       '/portal/approvals',
  portal_tickets:         '/portal/tickets',
  portal_escalations:     '/portal/escalations',
  portal_settings:        '/portal/settings',
  eu_chat:                '/chat',
  eu_actions:             '/my-actions',
  eu_tickets:             '/my-tickets',
};

const URL_TO_PAGE: Record<string, Page> = Object.fromEntries(
  Object.entries(PAGE_TO_URL).map(([page, url]) => [url, page as Page])
);

// Syncs the auth-context page state with the browser URL bidirectionally.
// This lets every existing component keep calling setPage('portal_conversations')
// while the browser URL stays updated and the back button works.
function URLSync() {
  const { currentPage, handleSetPage } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Page state → URL
  useEffect(() => {
    const target = PAGE_TO_URL[currentPage];
    if (target && location.pathname !== target) {
      navigate(target, { replace: true });
    }
  }, [currentPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // URL → page state (browser back/forward, direct links)
  useEffect(() => {
    const page = URL_TO_PAGE[location.pathname];
    if (page && page !== currentPage) {
      handleSetPage(page);
    }
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ── Main authenticated shell ────────────────────────────────────
function AppShell() {
  const {
    authedUser,
    currentPage,
    sidebarCollapsed,
    godModeSession,
    showOnboarding,
    dbTenants,
    dbArticles,
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
  } = useAuth();

  if (!authedUser) return <LoginPage onLogin={handleLogin} />;

  const commonProps = {
    user: authedUser,
    tenant: currentTenant,
    page: currentPage,
    setPage: handleSetPage,
    accentColor: currentTenant?.accentColor,
  };

  const renderPage = () => {
    if (isDTUser)
      return (
        <PlatformConsolePage
          page={currentPage as PlatformPage}
          setPage={handleSetPage}
          user={authedUser}
          dbTenants={dbTenants}
        />
      );
    switch (currentPage) {
      case 'dashboard':
        return <DashboardPage {...commonProps} dbStats={dbStats} />;
      case 'agents':
        return <AgentWorkforcePage {...commonProps} />;
      case 'swarm':
        return <SwarmPage tenant={currentTenant} />;
      case 'insight':
        return <InsightEnginePage {...commonProps} />;
      case 'security':
        return <SecurityPage {...commonProps} />;
      case 'integrations':
        return <IntegrationsPage {...commonProps} />;
      case 'connectors':
        return <DataConnectorsPage {...commonProps} />;
      case 'settings':
        return <SettingsPage {...commonProps} />;
      case 'knowledge_data':
      case 'knowledge_taxonomy':
      case 'knowledge_connectors':
      case 'knowledge_files':
        return <KnowledgeDataPage {...commonProps} />;
      case 'hub_overview':
      case 'hub_articles':
      case 'hub_ingestion':
      case 'hub_training':
      case 'hub_analytics':
        return <KnowledgeHubPage dbArticles={dbArticles} {...commonProps} subPage={currentPage as any} />;
      case 'portal_overview':
      case 'portal_conversations':
      case 'portal_actions':
      case 'portal_approvals':
      case 'portal_tickets':
      case 'portal_settings':
      case 'portal_escalations':
        return <CustomerPortalPage {...commonProps} subPage={currentPage as any} />;
      case 'admin_approvals':
        return <ApprovalsPage {...commonProps} />;
      case 'eu_chat':
        return <EndUserChatPage {...commonProps} />;
      case 'finance':
        return <FinanceControlTowerPage {...commonProps} />;
      case 'revenue':
        return <RevenueWorkspacePage {...commonProps} />;
      case 'hr':
        return <HRWorkspacePage {...commonProps} />;
      case 'cs':
        return <CSWorkspacePage {...commonProps} />;
      case 'implementation':
        return <ImplementationWorkspacePage {...commonProps} />;
      case 'marketplace':
        return <ConnectorMarketplacePage {...commonProps} />;
      case 'control_fabric':
        return <ControlFabricPage />;
      case 'capabilities':
        return <CapabilitiesPage />;
      case 'intelligence':
        return <IntelligencePlatformPage />;
      case 'playbooks':
        return <PlaybooksPage {...commonProps} />;
      case 'audit_log':
        return <AuditLogPage {...commonProps} />;
      case 'users':
        return <UserManagementPage {...commonProps} />;
      default:
        return <DashboardPage {...commonProps} />;
    }
  };

  return (
    <>
      <URLSync />
      <div className="flex h-screen bg-slate-950 overflow-hidden">
        {showOnboarding && isTenantUser && (
          <OnboardingWizard
            onComplete={() => {
              try { if (authedUser?.id) localStorage.setItem('dt_onboarded_' + authedUser.id, '1'); } catch (e) {}
              setShowOnboarding(false);
            }}
            tenant={currentTenant}
            user={authedUser}
          />
        )}
        <Sidebar
          page={currentPage}
          setPage={handleSetPage}
          user={authedUser}
          tenant={currentTenant}
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
          godModeActive={!!godModeSession}
          exitGodMode={() => setGodModeSession(null)}
          onLogout={handleLogout}
        />
        <main className="flex-1 flex flex-col overflow-hidden">
          {godModeSession && (
            <div className="bg-amber-500/10 border-b border-amber-500/30 px-6 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-amber-400 text-sm">!</span>
                <span className="text-xs text-amber-300">
                  Support Access — viewing {godModeSession.tenant.name} as{' '}
                  {godModeSession.operator.name}
                </span>
              </div>
              <button
                onClick={() => setGodModeSession(null)}
                className="text-xs text-amber-500 hover:text-amber-300 underline transition-all"
              >
                Exit Support Session
              </button>
            </div>
          )}
          {renderPage()}
        </main>
      </div>
    </>
  );
}

// ── Root ────────────────────────────────────────────────────────
function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
