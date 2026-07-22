import type { Page } from '../../../types';
import SupportInboxPage from './SupportInboxPage';
import SupportCommandCenterPage from './SupportCommandCenterPage';
import SupportTriageRulesPage from './SupportTriageRulesPage';

// Support hub — one destination for the whole support operation (north-star
// IA). The INBOX is primary: it's the floor where you watch the DE answer and
// step in. The old Command Center becomes the Overview tab; triage rules ride
// along as config. Tabs stay real Page keys so old /support/* URLs deep-link.
const TABS: { page: Page; label: string }[] = [
  { page: 'support_inbox', label: 'Inbox' },
  { page: 'support_command_center', label: 'Overview' },
  { page: 'support_triage_rules', label: 'Triage rules' },
];

const SupportHubPage = ({ tab, setPage }: { tab: Page; setPage: (p: Page) => void }) => (
  <div className="flex-1 flex flex-col overflow-hidden bg-slate-900 text-slate-200">
    <div className="shrink-0 px-6 pt-8">
      <h1 className="text-2xl font-semibold text-white">Support</h1>
      <p className="text-sm text-slate-400 mt-1 max-w-2xl">
        Your support operation in one place — live conversations first, the numbers and the rules behind them one tab away.
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
    {tab === 'support_inbox' && <SupportInboxPage setPage={setPage} embedded />}
    {tab === 'support_command_center' && <SupportCommandCenterPage setPage={setPage} embedded />}
    {tab === 'support_triage_rules' && <SupportTriageRulesPage setPage={setPage} embedded />}
  </div>
);

export default SupportHubPage;
