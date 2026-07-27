import type { Page } from '../../../types';
import { canAccessPage } from '../../../lib/navAccess';
import { useAuth } from '../../../context/AuthContext';
import { InHubContext } from '../../../components/ui';
import CompliancePage from './CompliancePage';
import AuditTrailPage from './AuditTrailPage';
import SecurityAccessPage from './SecurityAccessPage';
import DataAccessPage from './DataAccessPage';
import IdentityInventoryPage from './IdentityInventoryPage';
import TrustArchitecturePage from './TrustArchitecturePage';

// Governance hub — the whole control story as ONE destination (north-star IA):
// what the rules are, what happened, who can get in, what data is reachable,
// which identities exist, and how the architecture earns trust. Tabs stay real
// Page keys so old /governance/* URLs deep-link via URLSync.
const TABS: { page: Page; label: string }[] = [
  { page: 'gov_compliance', label: 'Compliance & Guardrails' },
  { page: 'gov_audit', label: 'Audit Trail' },
  { page: 'gov_security', label: 'Security & Access' },
  { page: 'gov_data_access', label: 'Data Access' },
  { page: 'gov_identity_inventory', label: 'Identity & Credentials' },
  { page: 'gov_trust', label: 'Trust & Architecture' },
];

const GovernanceHubPage = ({ tab, setPage }: { tab: Page; setPage: (p: Page) => void }) => {
  // Tabs are permission-filtered. They were not: TABS.map rendered all six to
  // everybody, while the tabs sit at DIFFERENT tiers — Security & Access is
  // ADMIN, Trust & Architecture is platform-staff-only, the rest are MANAGE.
  // A manager saw a Security & Access tab, clicked it, and nothing happened,
  // because handleSetPage blocks the navigation. A control that looks live and
  // does nothing is worse than one that is absent: it reads as a broken product
  // rather than as a boundary.
  const { authedUser } = useAuth();
  const role = (authedUser?.role ?? 'read_only') as Parameters<typeof canAccessPage>[0];
  const tabs = TABS.filter(t => canAccessPage(role, t.page, authedUser?.layer));
  return (
  <div className="text-dt-body">
    <div className="px-6 pt-8">
      <h1 className="text-2xl font-semibold text-white">Governance</h1>
      <p className="text-sm text-dt-support mt-1 max-w-2xl">
        The control room — the rules your workforce can never cross, the record of everything it did, and who can reach what.
      </p>
      <div className="flex gap-1 mt-5 border-b border-dt-border overflow-x-auto scrollbar-none">
        {tabs.map(t => (
          <button key={t.page} onClick={() => setPage(t.page)}
            className={`shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.page ? 'border-indigo-500 text-white' : 'border-transparent text-dt-support hover:text-dt-body'}`}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
    <InHubContext.Provider value={true}>
      {tab === 'gov_compliance' && <CompliancePage setPage={setPage} />}
      {tab === 'gov_audit' && <AuditTrailPage setPage={setPage} />}
      {tab === 'gov_security' && <SecurityAccessPage />}
      {tab === 'gov_data_access' && <DataAccessPage />}
      {tab === 'gov_identity_inventory' && <IdentityInventoryPage />}
      {tab === 'gov_trust' && <TrustArchitecturePage />}
    </InHubContext.Provider>
    </div>
  );
};

export default GovernanceHubPage;
