import React, { useEffect } from 'react';
import { BrowserRouter, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Sidebar } from './components';
import DEChatDock from './components/DEChatDock';
import LoginPage from './pages/LoginPage';
import PlatformConsolePage from './pages/platform/PlatformConsolePage';
import DashboardPage from './pages/tenant/DashboardPage';
import KnowledgeLibraryPage from './pages/tenant/knowledge/KnowledgeLibraryPage';
import KnowledgeIngestionPage from './pages/tenant/knowledge/KnowledgeIngestionPage';
import KnowledgeGapsPage from './pages/tenant/knowledge/KnowledgeGapsPage';
import KnowledgeQualityPage from './pages/tenant/knowledge/KnowledgeQualityPage';
import SettingsPage from './pages/tenant/SettingsPage';
import CompliancePage from './pages/tenant/governance/CompliancePage';
import AuditTrailPage from './pages/tenant/governance/AuditTrailPage';
import SecurityAccessPage from './pages/tenant/governance/SecurityAccessPage';
import UserManagementPage from './pages/tenant/UserManagementPage';
import EndUserChatPage from './pages/portal/EndUserChatPage';
import ConnectorsPage from './pages/tenant/systems/ConnectorsPage';
import PlaybooksPage from './pages/tenant/systems/PlaybooksPage';
import HumanTasksPage from './pages/tenant/ops/HumanTasksPage';
import ActivityPage from './pages/tenant/ops/ActivityPage';
import { PerformancePage, InsightsPage } from './pages/tenant/intelligence/IntelligencePages';
import SelfLearningPage from './pages/tenant/intelligence/SelfLearningPage';
import ProvingGroundPage from './pages/tenant/intelligence/ProvingGroundPage';
import SpecialistsPage from './pages/tenant/SpecialistsPage';
import CompanySetupPage from './pages/tenant/CompanySetupPage';
import WorkforceDEsPage from './pages/tenant/WorkforceDEsPage';
import CustomerOverviewPage from './pages/tenant/entity/CustomerOverviewPage';
import CustomerSupportPage from './pages/tenant/entity/CustomerSupportPage';
import CustomerRenewalPage from './pages/tenant/entity/CustomerRenewalPage';
import CustomerOnboardingPage from './pages/tenant/entity/CustomerOnboardingPage';
import { CustomerBDPage, CustomerSalesPage, CustomerSuccessPage } from './pages/tenant/entity/CustomerJourneyStubs';
import { VendorOverviewPage, VendorSourcingPage, VendorContractsPage, VendorManagementPage } from './pages/tenant/entity/VendorPages';
import { WorkforceOverviewPage, WorkforceTalentPage, WorkforceOnboardingPage, WorkforceDevelopmentPage, WorkforcePayrollPage } from './pages/tenant/entity/WorkforcePages';
import { OutcomeRevenuePage, OutcomeDeliveryPage, OutcomeFinancialPage, OutcomeRiskPage } from './pages/tenant/outcome/OutcomePages';
import type { Page, PlatformPage } from './types';

// ── URL ↔ Page mapping ──────────────────────────────────────────
const PAGE_TO_URL: Record<string, string> = {
  platform_home:          '/platform',
  platform_tenants:       '/platform/tenants',
  platform_remote_access: '/platform/remote-access',
  platform_health:        '/platform/health',
  platform_revenue:       '/platform/revenue',
  dashboard:              '/dashboard',
  users:                  '/users',
  settings:               '/settings',
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
  intelligence_learning:    '/intelligence/learning',
  intelligence_evals:       '/intelligence/proving-ground',
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

// ── Main authenticated shell ────────────────────────────────────
function AppShell() {
  const {
    authedUser,
    currentPage,
    sidebarCollapsed,
    godModeSession,
    dbTenants,
    dbStats,
    currentTenant,
    isDTUser,
    isTenantUser,
    handleLogin,
    handleLogout,
    handleSetPage,
    setSidebarCollapsed,
    setGodModeSession,
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
      case 'settings':
        return <SettingsPage {...commonProps} />;
      case 'eu_chat':
        return <EndUserChatPage {...commonProps} />;
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
        return <VendorOverviewPage setPage={handleSetPage} />;
      case 'entity_vendor_sourcing':
        return <VendorSourcingPage setPage={handleSetPage} />;
      case 'entity_vendor_contracts':
        return <VendorContractsPage setPage={handleSetPage} />;
      case 'entity_vendor_management':
        return <VendorManagementPage setPage={handleSetPage} />;
      case 'entity_workforce':
        return <WorkforceOverviewPage setPage={handleSetPage} />;
      case 'entity_workforce_talent':
        return <WorkforceTalentPage setPage={handleSetPage} />;
      case 'entity_workforce_onboarding':
        return <WorkforceOnboardingPage setPage={handleSetPage} />;
      case 'entity_workforce_development':
        return <WorkforceDevelopmentPage setPage={handleSetPage} />;
      case 'entity_workforce_payroll':
        return <WorkforcePayrollPage setPage={handleSetPage} />;
      // ── Outcome pages ─────────────────────────────────────────
      case 'outcome_revenue':
        return <OutcomeRevenuePage setPage={handleSetPage} />;
      case 'outcome_delivery':
        return <OutcomeDeliveryPage setPage={handleSetPage} />;
      case 'outcome_financial':
        return <OutcomeFinancialPage setPage={handleSetPage} />;
      case 'outcome_risk':
        return <OutcomeRiskPage setPage={handleSetPage} />;
      // ── Specialist pages ──────────────────────────────────────
      case 'specialist_technical':
        return <SpecialistsPage domain="technical" setPage={handleSetPage} />;
      case 'specialist_legal':
        return <SpecialistsPage domain="legal" setPage={handleSetPage} />;
      case 'specialist_finance_deep':
        return <SpecialistsPage domain="finance_deep" setPage={handleSetPage} />;
      case 'specialist_people':
        return <SpecialistsPage domain="people" setPage={handleSetPage} />;
      // ── Workforce ─────────────────────────────────────────────
      case 'workforce_des':
        return <WorkforceDEsPage setPage={handleSetPage} />;
      // ── Knowledge ─────────────────────────────────────────────
      case 'knowledge_library':
        return <KnowledgeLibraryPage />;
      case 'knowledge_ingestion':
        return <KnowledgeIngestionPage />;
      case 'knowledge_gaps':
        return <KnowledgeGapsPage />;
      case 'knowledge_quality':
        return <KnowledgeQualityPage />;
      // ── Systems ───────────────────────────────────────────────
      case 'systems_connectors':
        return <ConnectorsPage setPage={handleSetPage} />;
      case 'systems_playbooks':
        return <PlaybooksPage setPage={handleSetPage} />;
      // ── Operations ────────────────────────────────────────────
      case 'ops_human_tasks':
        return <HumanTasksPage setPage={handleSetPage} />;
      case 'ops_activity':
        return <ActivityPage setPage={handleSetPage} />;
      // ── Intelligence ──────────────────────────────────────────
      case 'intelligence_performance':
        return <PerformancePage setPage={handleSetPage} />;
      case 'intelligence_learning':
        return <SelfLearningPage setPage={handleSetPage} />;
      case 'intelligence_evals':
        return <ProvingGroundPage setPage={handleSetPage} />;
      case 'intelligence_insights':
        return <InsightsPage setPage={handleSetPage} />;
      // ── Governance ────────────────────────────────────────────
      case 'gov_compliance':
        return <CompliancePage setPage={handleSetPage} />;
      case 'gov_audit':
        return <AuditTrailPage setPage={handleSetPage} />;
      case 'gov_security':
        return <SecurityAccessPage />;
      case 'company_setup':
        return <CompanySetupPage setPage={handleSetPage} />;
      default:
        return <DashboardPage {...commonProps} />;
    }
  };

  return (
    <>
      <URLSync />
      <div className="flex h-screen bg-slate-950 overflow-hidden">
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
        {authedUser && !isDTUser && <DEChatDock />}
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
