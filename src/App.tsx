import React, { useEffect } from 'react';
import { BrowserRouter, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Sidebar } from './components';
import LoginPage from './pages/LoginPage';
import OnboardingWizard from './pages/OnboardingWizard';
import PlatformConsolePage from './pages/platform/PlatformConsolePage';
import DashboardPage from './pages/tenant/DashboardPage';
import KnowledgeHubPage from './pages/tenant/KnowledgeHubPage';
import KnowledgeDataPage from './pages/tenant/KnowledgeDataPage';
import SecurityPage from './pages/tenant/SecurityPage';
import DataConnectorsPage from './pages/tenant/DataConnectorsPage';
import SettingsPage from './pages/tenant/SettingsPage';
import FinanceControlTowerPage from './pages/tenant/FinanceControlTowerPage';
import AuditLogPage from './pages/tenant/AuditLogPage';
import UserManagementPage from './pages/tenant/UserManagementPage';
import PlaybooksPage from './pages/tenant/PlaybooksPage';
import ApprovalsPage from './pages/tenant/ApprovalsPage';
import EndUserChatPage from './pages/portal/EndUserChatPage';
import WorkforceDEsPage from './pages/tenant/WorkforceDEsPage';
import CustomerOverviewPage from './pages/tenant/entity/CustomerOverviewPage';
import CustomerSupportPage from './pages/tenant/entity/CustomerSupportPage';
import CustomerRenewalPage from './pages/tenant/entity/CustomerRenewalPage';
import CustomerOnboardingPage from './pages/tenant/entity/CustomerOnboardingPage';
import { CustomerBDPage, CustomerSalesPage, CustomerSuccessPage } from './pages/tenant/entity/CustomerJourneyStubs';
import type { Page, PlatformPage } from './types';

// ── URL ↔ Page mapping ──────────────────────────────────────────
const PAGE_TO_URL: Record<string, string> = {
  platform_home:          '/platform',
  platform_tenants:       '/platform/tenants',
  platform_remote_access: '/platform/remote-access',
  platform_health:        '/platform/health',
  platform_revenue:       '/platform/revenue',
  dashboard:              '/dashboard',
  finance:                '/finance',
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
  hub_ingestion:          '/knowledge/hub-ingestion',
  hub_training:           '/knowledge/training',
  hub_analytics:          '/knowledge/analytics',
  knowledge_data:         '/knowledge/data',
  knowledge_taxonomy:     '/knowledge/taxonomy',
  knowledge_connectors:   '/knowledge/connectors',
  knowledge_files:        '/knowledge/files',
  hub_review:             '/knowledge/review',
  admin_overview:         '/security/overview',
  admin_rbac:             '/security/rbac',
  admin_audit:            '/security/audit',
  admin_compliance:       '/security/compliance',
  eu_chat:                '/chat',
  // Entities
  entity_customer:            '/customer',
  entity_customer_bd:         '/customer/bd',
  entity_customer_sales:      '/customer/sales',
  entity_customer_onboarding: '/customer/onboarding',
  entity_customer_support:    '/customer/support',
  entity_customer_success:    '/customer/success',
  entity_customer_renewal:    '/customer/renewal',
  entity_vendor:              '/vendor',
  entity_vendor_sourcing:     '/vendor/sourcing',
  entity_vendor_contracts:    '/vendor/contracts',
  entity_vendor_management:   '/vendor/management',
  entity_workforce:           '/workforce-entity',
  entity_workforce_talent:    '/workforce-entity/talent',
  entity_workforce_onboarding:'/workforce-entity/onboarding',
  entity_workforce_development:'/workforce-entity/development',
  entity_workforce_payroll:   '/workforce-entity/payroll',
  // Outcomes
  outcome_revenue:    '/outcomes/revenue',
  outcome_delivery:   '/outcomes/delivery',
  outcome_financial:  '/outcomes/financial',
  outcome_risk:       '/outcomes/risk',
  // Specialist
  specialist_technical:    '/specialist/technical',
  specialist_legal:        '/specialist/legal',
  specialist_finance_deep: '/specialist/finance',
  specialist_people:       '/specialist/people',
  // Workforce (DEs)
  workforce_des:       '/workforce/des',
  // Knowledge
  knowledge_library:   '/knowledge/library',
  knowledge_ingestion: '/knowledge/ingestion',
  knowledge_gaps:      '/knowledge/gaps',
  knowledge_quality:   '/knowledge/quality',
  // Systems
  systems_connectors: '/systems/connectors',
  systems_playbooks:  '/systems/playbooks',
  // Operations
  ops_human_tasks: '/ops/tasks',
  ops_activity:    '/ops/activity',
  // Intelligence
  intelligence_performance: '/intelligence/performance',
  intelligence_insights:    '/intelligence/insights',
  // Governance
  gov_compliance: '/governance/compliance',
  gov_audit:      '/governance/audit',
  gov_security:   '/governance/security',
  // Setup
  company_setup:  '/setup',
};

const URL_TO_PAGE: Record<string, Page> = Object.fromEntries(
  Object.entries(PAGE_TO_URL).map(([page, url]) => [url, page as Page])
);

// Syncs the auth-context page state with the browser URL bidirectionally.
// This lets every existing component keep calling setPage('entity_customer_support')
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

// ── Placeholder page for new routes ────────────────────────────
function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-slate-950 text-center p-8">
      <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-xl mb-4">◈</div>
      <h2 className="text-lg font-semibold text-slate-200 mb-2">{title}</h2>
      <p className="text-sm text-slate-500 max-w-sm">{description}</p>
    </div>
  );
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
      case 'security':
      case 'admin_overview':
      case 'admin_rbac':
      case 'admin_audit':
      case 'admin_compliance':
        return <SecurityPage {...commonProps} />;
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
      case 'hub_review':
      case 'hub_ingestion':
      case 'hub_training':
      case 'hub_analytics':
        return <KnowledgeHubPage dbArticles={dbArticles} {...commonProps} subPage={currentPage as any} />;
      case 'admin_approvals':
        return <ApprovalsPage {...commonProps} />;
      case 'eu_chat':
        return <EndUserChatPage {...commonProps} />;
      case 'finance':
        return <FinanceControlTowerPage {...commonProps} />;
      case 'playbooks':
        return <PlaybooksPage {...commonProps} />;
      case 'audit_log':
        return <AuditLogPage {...commonProps} />;
      case 'users':
        return <UserManagementPage {...commonProps} />;
      // ── Entity pages ──────────────────────────────────────────
      case 'entity_customer':
        return <CustomerOverviewPage setPage={handleSetPage} />;
      case 'entity_customer_bd':
        return <CustomerBDPage setPage={handleSetPage} />;
      case 'entity_customer_sales':
        return <CustomerSalesPage setPage={handleSetPage} />;
      case 'entity_customer_onboarding':
        return <CustomerOnboardingPage setPage={handleSetPage} />;
      case 'entity_customer_support':
        return <CustomerSupportPage setPage={handleSetPage} />;
      case 'entity_customer_success':
        return <CustomerSuccessPage setPage={handleSetPage} />;
      case 'entity_customer_renewal':
        return <CustomerRenewalPage setPage={handleSetPage} />;
      case 'entity_vendor':
      case 'entity_vendor_sourcing':
      case 'entity_vendor_contracts':
      case 'entity_vendor_management':
        return <PlaceholderPage title="Vendors & Partners" description="Supplier sourcing, contract management, and relationship oversight." />;
      case 'entity_workforce':
      case 'entity_workforce_talent':
      case 'entity_workforce_onboarding':
      case 'entity_workforce_development':
      case 'entity_workforce_payroll':
        return <PlaceholderPage title="Workforce" description="Talent acquisition, onboarding, performance, and payroll management." />;
      // ── Outcome pages ─────────────────────────────────────────
      case 'outcome_revenue':
        return <PlaceholderPage title="Revenue & Growth" description="Pipeline health, conversion rates, retention metrics, and expansion revenue." />;
      case 'outcome_delivery':
        return <PlaceholderPage title="Product & Engineering" description="Roadmap, development, release management, and incident response." />;
      case 'outcome_financial':
        return <PlaceholderPage title="Financial Health" description="AP/AR, cash flow, budgeting, revenue recognition, and financial reporting." />;
      case 'outcome_risk':
        return <PlaceholderPage title="Risk & Compliance" description="Regulatory compliance, risk assessment, and guardrail management." />;
      // ── Specialist pages ──────────────────────────────────────
      case 'specialist_technical':
      case 'specialist_legal':
      case 'specialist_finance_deep':
      case 'specialist_people':
        return <PlaceholderPage title="Specialist Function" description="Deep-domain expertise called on demand by primary Customer DEs." />;
      // ── Workforce ─────────────────────────────────────────────
      case 'workforce_des':
        return <WorkforceDEsPage setPage={handleSetPage} />;
      // ── Knowledge ─────────────────────────────────────────────
      case 'knowledge_library':
        return <PlaceholderPage title="Knowledge Library" description="All knowledge organised by entity, audience, type, and confidence level." />;
      case 'knowledge_ingestion':
        return <PlaceholderPage title="Ingestion & Sources" description="Connect knowledge sources, ingest documents, and configure processing." />;
      case 'knowledge_gaps':
        return <PlaceholderPage title="Gap Detection" description="Real-time gap signals from DE queries and human escalations. Internal Resolution Agent drafts articles from historical solutions." />;
      case 'knowledge_quality':
        return <PlaceholderPage title="Quality & Coverage" description="Knowledge freshness, confidence calibration, and coverage per DE role." />;
      // ── Systems ───────────────────────────────────────────────
      case 'systems_connectors':
        return <PlaceholderPage title="Connectors" description="All system integrations, bound to specific DEs with data access configuration." />;
      case 'systems_playbooks':
        return <PlaceholderPage title="Playbooks" description="Workflow library: Process, Response, Escalation, Cross-function, Crisis, and Scheduled playbooks." />;
      // ── Operations ────────────────────────────────────────────
      case 'ops_human_tasks':
        return <PlaceholderPage title="Human Tasks" description="Approval gates, review gates, escalations, overrides, and training feedback awaiting human action." />;
      case 'ops_activity':
        return <PlaceholderPage title="Activity Log" description="Every DE action logged — filterable by entity, DE, action type, and outcome." />;
      // ── Intelligence ──────────────────────────────────────────
      case 'intelligence_performance':
        return <PlaceholderPage title="Performance Analytics" description="DE resolution rates, accuracy, CSAT, escalation rates, and cost efficiency." />;
      case 'intelligence_insights':
        return <PlaceholderPage title="Business Insights" description="Anomaly detection, trend analysis, gap reports, and retraining recommendations." />;
      // ── Governance ────────────────────────────────────────────
      case 'gov_compliance':
        return <PlaceholderPage title="Compliance & Guardrails" description="Industry compliance templates, organisational guardrails, and DE-level restrictions." />;
      case 'gov_audit':
        return <PlaceholderPage title="Audit Trail" description="Immutable log of all DE actions, human approvals, and system events." />;
      case 'gov_security':
        return <PlaceholderPage title="Security & Access" description="Platform RBAC, SSO, API keys, and session management." />;
      case 'company_setup':
        return <PlaceholderPage title="Company Setup" description="Configure your industry, activate functions, and set up your first Digital Employees." />;
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
