import type { Page } from '../../../types';
import { TabBar } from '../../../design/primitives';
import SupportInboxPage from './SupportInboxPage';
import SupportCommandCenterPage from './SupportCommandCenterPage';
import SupportTriageRulesPage from './SupportTriageRulesPage';

// Support hub — one destination for the whole support operation (north-star
// IA). The INBOX is primary: it's the floor where you watch the DE answer and
// step in. The old Command Center becomes the Overview tab; triage rules ride
// along as config. Tabs stay real Page keys so old /support/* URLs deep-link.
// Design System v1 pilot surface — composes from src/design primitives.
const TABS: { key: Page; label: string }[] = [
  { key: 'support_inbox', label: 'Inbox' },
  { key: 'support_command_center', label: 'Overview' },
  { key: 'support_triage_rules', label: 'Triage rules' },
];

const SupportHubPage = ({ tab, setPage }: { tab: Page; setPage: (p: Page) => void }) => (
  <div className="flex-1 flex flex-col overflow-hidden bg-dt-page text-dt-body">
    <div className="shrink-0 px-6 pt-8">
      <h1 className="text-2xl font-semibold text-dt-title">Support</h1>
      <p className="text-sm text-dt-support mt-1 max-w-2xl">
        Your support operation in one place — live conversations first, the numbers and the rules behind them one tab away.
      </p>
      <div className="mt-5">
        <TabBar tabs={TABS} active={tab} onSelect={setPage} />
      </div>
    </div>
    {tab === 'support_inbox' && <SupportInboxPage setPage={setPage} embedded />}
    {tab === 'support_command_center' && <SupportCommandCenterPage setPage={setPage} embedded />}
    {tab === 'support_triage_rules' && <SupportTriageRulesPage setPage={setPage} embedded />}
  </div>
);

export default SupportHubPage;
