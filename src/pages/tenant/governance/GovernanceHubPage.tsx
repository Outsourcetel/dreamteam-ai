import type { Page } from '../../../types';
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

const GovernanceHubPage = ({ tab, setPage }: { tab: Page; setPage: (p: Page) => void }) => (
  <div className="text-slate-200">
    <div className="max-w-6xl mx-auto px-6 pt-8">
      <h1 className="text-2xl font-semibold text-white">Governance</h1>
      <p className="text-sm text-slate-400 mt-1 max-w-2xl">
        The control room — the rules your workforce can never cross, the record of everything it did, and who can reach what.
      </p>
      <div className="flex gap-1 mt-5 border-b border-slate-700/60 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.page} onClick={() => setPage(t.page)}
            className={`shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.page ? 'border-indigo-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
    {tab === 'gov_compliance' && <CompliancePage setPage={setPage} />}
    {tab === 'gov_audit' && <AuditTrailPage setPage={setPage} />}
    {tab === 'gov_security' && <SecurityAccessPage />}
    {tab === 'gov_data_access' && <DataAccessPage />}
    {tab === 'gov_identity_inventory' && <IdentityInventoryPage />}
    {tab === 'gov_trust' && <TrustArchitecturePage />}
  </div>
);

export default GovernanceHubPage;
