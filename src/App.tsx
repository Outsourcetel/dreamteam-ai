import React, { useEffect, useRef } from 'react';
import { BrowserRouter, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Sidebar, MfaEnrollmentPanel } from './components';
import DEChatDock from './components/DEChatDock';
import PageErrorBoundary from './components/PageErrorBoundary';
import LoginPage from './pages/LoginPage';
import ResetPasswordScreen from './pages/ResetPasswordScreen';
import HostedChatPage from './pages/chat/HostedChatPage';
import OrgSetupScreen from './pages/OrgSetupScreen';
import PlatformInviteRedeemPage from './pages/PlatformInviteRedeemPage';
import TermsOfServicePage from './pages/legal/TermsOfServicePage';
import PrivacyPolicyPage from './pages/legal/PrivacyPolicyPage';
import PlatformConsolePage from './pages/platform/PlatformConsolePage';
import MyAccountBadge from './pages/platform/MyAccountBadge';
import DashboardPage from './pages/tenant/DashboardPage';
import KnowledgeLibraryPage from './pages/tenant/knowledge/KnowledgeLibraryPage';
import KnowledgeIngestionPage from './pages/tenant/knowledge/KnowledgeIngestionPage';
import KnowledgeGapsPage from './pages/tenant/knowledge/KnowledgeGapsPage';
import KnowledgeQualityPage from './pages/tenant/knowledge/KnowledgeQualityPage';
import SettingsPage from './pages/tenant/SettingsPage';
import CompliancePage from './pages/tenant/governance/CompliancePage';
import AuditTrailPage from './pages/tenant/governance/AuditTrailPage';
import SecurityAccessPage from './pages/tenant/governance/SecurityAccessPage';
import TrustArchitecturePage from './pages/tenant/governance/TrustArchitecturePage';
import DataAccessPage from './pages/tenant/governance/DataAccessPage';
import IdentityInventoryPage from './pages/tenant/governance/IdentityInventoryPage';
import UserManagementPage from './pages/tenant/UserManagementPage';
import EndUserChatPage from './pages/portal/EndUserChatPage';
import ConnectorsPage from './pages/tenant/systems/ConnectorsPage';
import PlaybooksPage from './pages/tenant/systems/PlaybooksPage';
import HumanTasksPage from './pages/tenant/ops/HumanTasksPage';
import ActivityPage from './pages/tenant/ops/ActivityPage';
import DEActivityPage from './pages/tenant/ops/DEActivityPage';
import SupportInboxPage from './pages/tenant/support/SupportInboxPage';
import { PerformancePage, InsightsPage } from './pages/tenant/intelligence/IntelligencePages';
import SelfLearningPage from './pages/tenant/intelligence/SelfLearningPage';
import ProvingGroundPage from './pages/tenant/intelligence/ProvingGroundPage';
import SpecialistsPage from './pages/tenant/SpecialistsPage';
import CompanySetupPage from './pages/tenant/CompanySetupPage';
import OnboardingArchitectPage from './pages/tenant/OnboardingArchitectPage';
import WorkforceDEsPage from './pages/tenant/WorkforceDEsPage';
import { WorkforceChatHubPage } from './pages/tenant/WorkforceChatHubPage';
import CustomerOverviewPage from './pages/tenant/entity/CustomerOverviewPage';
import CustomerSupportPage from './pages/tenant/entity/CustomerSupportPage';
import CustomerRenewalPage from './pages/tenant/entity/CustomerRenewalPage';
import CustomerOnboardingPage from './pages/tenant/entity/CustomerOnboardingPage';
import CustomerOnboardingLive from './pages/tenant/entity/CustomerOnboardingLive';
import { EmbedPage } from './pages/EmbedPage';
import { useDataMode } from './lib/dataMode';
import { CustomerBDPage, CustomerSalesPage, CustomerSuccessPage } from './pages/tenant/entity/CustomerJourneyStubs';
import { VendorOverviewPage, VendorSourcingPage, VendorContractsPage, VendorManagementPage } from './pages/tenant/entity/VendorPages';
import { WorkforceOverviewPage, WorkforceTalentPage, WorkforceOnboardingPage, WorkforceDevelopmentPage, WorkforcePayrollPage } from './pages/tenant/entity/WorkforcePages';
import { OutcomeRevenuePage, OutcomeDeliveryPage, OutcomeFinancialPage, OutcomeRiskPage } from './pages/tenant/outcome/OutcomePages';
import OutcomesPage from './pages/tenant/outcome/LiveOutcomesPage';
import type { Page, PlatformPage } from './types';

// Live tenants get the real onboarding workspace (migration 022);
// demo companies keep the co-pilot design preview.
const CustomerOnboardingRoute = ({ setPage }: { setPage?: (p: Page) => void }) => {
  const dataMode = useDataMode();
  if (dataMode === 'live') return <CustomerOnboardingLive setPage={setPage} />;
  return <CustomerOnboardingPage setPage={setPage} />;
};

// ── URL ↔ Page mapping ──────────────────────────────────────────
// Record<Page, string> (not Record<string, string>) so adding a new Page
// without a URL mapping is a compile error, not a silently-dead nav link —
// an unmapped page used to make URLSync bounce every click straight back.
const PAGE_TO_URL: Record<Page, string> = {
  platform_home:                '/platform',
  platform_tenants:             '/platform/tenants',
  platform_team:                '/platform/team',
  platform_security:            '/platform/security',
  platform_health:              '/platform/health',
  platform_revenue:             '/platform/revenue',
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
  outcomes:           '/outcomes',
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
  workforce_chat:      '/workforce/chat',
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
  ops_de_activity: '/ops/de-activity',
  support_inbox: '/support/inbox',
  // Intelligence
  intelligence_performance: '/intelligence/performance',
  intelligence_learning:    '/intelligence/learning',
  intelligence_evals:       '/intelligence/proving-ground',
  intelligence_insights:    '/intelligence/insights',
  // Governance
  gov_compliance: '/governance/compliance',
  gov_audit:      '/governance/audit',
  gov_security:   '/governance/security',
  gov_trust:      '/governance/trust',
  gov_data_access: '/governance/data-access',
  gov_identity_inventory: '/governance/identity-credentials',
  // Setup
  company_setup:  '/setup',
  onboarding_architect: '/setup/quick-start',
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

  // Two separate effects (one per direction) that each call the OTHER
  // side's setter can cascade under fast/overlapping updates — e.g.
  // enterRemoteAccess flips currentPage while other context state is
  // also settling, and each direction's effect can retrigger the other
  // enough times in one tick to trip React's "Maximum update depth
  // exceeded" safety check. This ref makes each direction a no-op if
  // it would just be reacting to the sync IT ITSELF already performed
  // last time, so the two directions can never bounce off each other
  // regardless of timing.
  const lastSynced = useRef<{ page: string; pathname: string } | null>(null);

  useEffect(() => {
    if (lastSynced.current?.page === currentPage && lastSynced.current?.pathname === location.pathname) {
      return;
    }

    const target = PAGE_TO_URL[currentPage];
    if (target && location.pathname !== target) {
      lastSynced.current = { page: currentPage, pathname: target };
      navigate(target, { replace: true });
      return;
    }

    // Only adopt the URL's page when the PATHNAME is what changed (deep
    // link on first mount, browser back/forward). Without this guard, a
    // page-state change to any page whose URL mapping is missing (or maps
    // to the current pathname) fell through to here and got instantly
    // reverted to the URL's page — the click "did nothing". That exact
    // regression shipped twice (platform_team, platform_security).
    const pathnameChanged = lastSynced.current === null
      || lastSynced.current.pathname !== location.pathname;
    const page = URL_TO_PAGE[location.pathname];
    if (pathnameChanged && page && page !== currentPage) {
      lastSynced.current = { page, pathname: location.pathname };
      handleSetPage(page);
      return;
    }

    lastSynced.current = { page: currentPage, pathname: location.pathname };
  }, [currentPage, location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ── Platform Console top nav ─────────────────────────────────────
// PlatformConsolePage has no navigation of its own, and the regular
// tenant Sidebar (Command Centre, Customer Lifecycle, ...) makes no sense
// for a platform-layer user — it was rendering unconditionally alongside
// Platform Console with no way to reach anything but the Overview page.
// This is the whole navigation surface for platform-layer accounts.
const PLATFORM_TABS: { page: PlatformPage; label: string }[] = [
  { page: 'platform_home', label: 'Overview' },
  { page: 'platform_tenants', label: 'Tenants & Remote Access' },
  { page: 'platform_team', label: 'Team & Permissions' },
  { page: 'platform_health', label: 'System Health' },
  { page: 'platform_revenue', label: 'Revenue' },
  { page: 'platform_security', label: 'Security' },
];

// Two rows instead of one: the badge previously fought the tabs for
// horizontal space in a single flex row, which is what forced a
// browser scrollbar to appear on anything but a wide window. Splitting
// them means the tab row can wrap onto a second line on its own —
// nothing is ever hidden behind a scrollbar, and the badge never moves.
function PlatformNavTabs({ page, setPage }: { page: PlatformPage; setPage: (p: Page) => void }) {
  return (
    <div className="border-b border-slate-700 bg-slate-900">
      <div className="flex items-center justify-between pl-6 pr-4 pt-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-indigo-600 flex items-center justify-center text-white text-[10px] font-bold">DT</div>
          <span className="text-xs font-semibold text-slate-400 tracking-wide">Platform Console</span>
        </div>
        <MyAccountBadge />
      </div>
      <div className="flex items-center flex-wrap gap-1 px-6 pt-2">
        {PLATFORM_TABS.map((t) => (
          <button
            key={t.page}
            onClick={() => setPage(t.page)}
            className={`px-3.5 py-2 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap ${
              page === t.page
                ? 'bg-slate-800 text-white border border-slate-700 border-b-slate-800 -mb-px'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
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
    viewingDemo,
    dbTenants,
    dbTenantsLoaded,
    dbStats,
    currentTenant,
    isDTUser,
    isTenantUser,
    needsOrgSetup,
    mfaGateBlocking,
    handleLogin,
    handleLogout,
    handleSetPage,
    setSidebarCollapsed,
    exitRemoteAccess,
    deactivatedMessage,
    clearDeactivatedMessage,
    passwordRecoveryActive,
    completePasswordRecovery,
  } = useAuth();
  const location = useLocation();
  const dataMode = useDataMode();

  // Platform-invite redemption: a small, self-contained entry point that
  // must work whether or not the visitor is logged in yet (the redeem
  // page itself handles both cases) — intercepted here, before both the
  // "not logged in" and "needs org setup" gates below, so it never gets
  // swallowed by either.
  if (location.pathname === '/platform/redeem') {
    const code = new URLSearchParams(location.search).get('code') || '';
    return <PlatformInviteRedeemPage code={code} />;
  }

  // Terms/Privacy must be reachable whether or not the visitor is signed
  // in — intercepted here for the same reason as /platform/redeem above.
  if (location.pathname === '/terms') return <TermsOfServicePage onBack={() => window.history.back()} />;
  if (location.pathname === '/privacy') return <PrivacyPolicyPage onBack={() => window.history.back()} />;

  // Public hosted support chat (/chat?k=<widget key>) — a customer-facing
  // surface, so it must render before any auth gate. The widget key is the
  // auth (same as the embeddable widget); no app session required.
  if (location.pathname === '/chat') return <HostedChatPage />;

  // Public embed widget (/embed?tenant_id=...&de_id=...&token=...) — iframe
  // for customer websites. Authenticates via JWT token in query params.
  if (location.pathname === '/embed') return <EmbedPage />;

  // Password recovery (self-requested or admin-triggered) establishes a
  // real signed-in session via the emailed link — this must take
  // priority over the normal authedUser routing below, or the person
  // would land straight in their workspace instead of setting a new
  // password first.
  if (passwordRecoveryActive) {
    return <ResetPasswordScreen onComplete={completePasswordRecovery} />;
  }

  if (!authedUser) return (
    <LoginPage
      onLogin={handleLogin}
      deactivatedMessage={deactivatedMessage}
      clearDeactivatedMessage={clearDeactivatedMessage}
    />
  );

  // A real, confirmed user with no tenant yet must land here — never
  // silently fall through to the demo dashboard. See AuthContext's
  // needsOrgSetup and OrgSetupScreen for the full reasoning.
  if (needsOrgSetup) return <OrgSetupScreen />;

  // Real enforcement of the tenant's own session policy (migration 091,
  // Security & Access page): if the workspace requires MFA and this real
  // tenant user hasn't enrolled a verified factor, block the app behind
  // the same enrollment screen already used for Remote Access's own
  // AAL2 requirement (never true for a platform admin — see
  // mfaGateBlocking's own comment in AuthContext).
  if (mfaGateBlocking) {
    return (
      <div className="flex-1 flex flex-col h-screen bg-slate-900">
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-6 py-3 text-sm text-amber-300">
          Your workspace requires two-factor authentication before you can continue.
        </div>
        <MfaEnrollmentPanel />
      </div>
    );
  }

  const commonProps = {
    user: authedUser,
    tenant: currentTenant,
    page: currentPage,
    setPage: handleSetPage,
    accentColor: currentTenant?.accentColor,
  };

  const renderPage = () => {
    // A platform owner inside an active Remote Access session must see the
    // TENANT's real workspace, not Platform Console — godModeSession being
    // set is exactly that state. Without this check, isDTUser stays true
    // for the whole session (it reflects the platform owner's own account,
    // not what they're currently looking at) and Remote Access would show
    // its banner over... Platform Console, never the tenant's own pages.
    // viewingDemo lets a platform operator step INTO a demo company
    // experience (Console → "Open demo"); without this escape the console
    // wrapper swallows every page and the demo dead-ends on a blank view.
    if (isDTUser && !godModeSession && !viewingDemo)
      return (
        <div className="flex-1 flex flex-col overflow-hidden">
          <PlatformNavTabs page={currentPage as PlatformPage} setPage={handleSetPage} />
          <PlatformConsolePage
            page={currentPage as PlatformPage}
            setPage={handleSetPage}
            user={authedUser}
            dbTenants={dbTenants}
            dbTenantsLoaded={dbTenantsLoaded}
          />
        </div>
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
        return <CustomerOnboardingRoute setPage={handleSetPage} />;
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
      // Wave 3: live tenants get the single consolidated Outcomes page;
      // the 4 legacy keys keep working (deep links) — in live mode they
      // render the same consolidated page, in demo the original previews.
      case 'outcomes':
        return <OutcomesPage setPage={handleSetPage} />;
      case 'outcome_revenue':
        return dataMode === 'live' ? <OutcomesPage setPage={handleSetPage} /> : <OutcomeRevenuePage setPage={handleSetPage} />;
      case 'outcome_delivery':
        return dataMode === 'live' ? <OutcomesPage setPage={handleSetPage} /> : <OutcomeDeliveryPage setPage={handleSetPage} />;
      case 'outcome_financial':
        return dataMode === 'live' ? <OutcomesPage setPage={handleSetPage} /> : <OutcomeFinancialPage setPage={handleSetPage} />;
      case 'outcome_risk':
        return dataMode === 'live' ? <OutcomesPage setPage={handleSetPage} /> : <OutcomeRiskPage setPage={handleSetPage} />;
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
      case 'workforce_chat':
        return <WorkforceChatHubPage />;
      // ── Knowledge ─────────────────────────────────────────────
      case 'knowledge_library':
        return <KnowledgeLibraryPage setPage={handleSetPage} />;
      case 'knowledge_ingestion':
        return <KnowledgeIngestionPage setPage={handleSetPage} />;
      case 'knowledge_gaps':
        return <KnowledgeGapsPage setPage={handleSetPage} />;
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
      case 'ops_de_activity':
        return <DEActivityPage setPage={handleSetPage} />;
      case 'support_inbox':
        return <SupportInboxPage setPage={handleSetPage} />;
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
      case 'gov_trust':
        return <TrustArchitecturePage />;
      case 'gov_data_access':
        return <DataAccessPage />;
      case 'gov_identity_inventory':
        return <IdentityInventoryPage />;
      case 'company_setup':
        return <CompanySetupPage setPage={handleSetPage} />;
      case 'onboarding_architect':
        return <OnboardingArchitectPage setPage={handleSetPage} />;
      default:
        return <DashboardPage {...commonProps} />;
    }
  };

  return (
    <>
      <URLSync />
      <div className="flex h-screen bg-slate-900 overflow-hidden">
        {(!isDTUser || godModeSession) && (
          <Sidebar
            page={currentPage}
            setPage={handleSetPage}
            user={authedUser}
            tenant={currentTenant}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
            godModeActive={!!godModeSession}
            exitGodMode={() => { void exitRemoteAccess(); }}
            onLogout={handleLogout}
          />
        )}
        <main className="flex-1 flex flex-col overflow-hidden">
          {godModeSession && (
            <div className="bg-amber-500/10 border-b border-amber-500/30 px-6 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-amber-400 text-sm">!</span>
                <span className="text-xs text-amber-300">
                  Remote Access — viewing {godModeSession.tenant.name} as{' '}
                  {godModeSession.operator.name}
                </span>
              </div>
              <button
                onClick={() => { void exitRemoteAccess(); }}
                className="text-xs text-amber-500 hover:text-amber-300 underline transition-all"
              >
                Exit Remote Access
              </button>
            </div>
          )}
          <PageErrorBoundary key={currentPage}>
            {renderPage()}
          </PageErrorBoundary>
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
