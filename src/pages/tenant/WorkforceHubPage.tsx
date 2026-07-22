import type { Page } from '../../types';
import { InHubContext } from '../../components/ui';
import { TabBar } from '../../design/primitives';
import WorkforceDEsPage from './WorkforceDEsPage';
import DEActivityPage from './ops/DEActivityPage';
import { PerformancePage } from './intelligence/IntelligencePages';
import ProvingGroundPage from './intelligence/ProvingGroundPage';
import SelfLearningPage from './intelligence/SelfLearningPage';
import OutcomeStatement from '../../components/OutcomeStatement';

// Workforce hub — the employee lifecycle as ONE destination (north-star IA):
// who they are (Roster), what they're doing right now (At Work), how they're
// performing, how they're tested (Proving Ground) and how they get better
// (Self-Learning). Tabs stay real Page keys so old URLs deep-link via URLSync.
// Design System v1 pilot surface — composes from src/design primitives.
const TABS: { key: Page; label: string }[] = [
  { key: 'workforce_des', label: 'Roster' },
  { key: 'ops_de_activity', label: 'At Work' },
  { key: 'outcomes', label: 'Value' },
  { key: 'intelligence_performance', label: 'Performance' },
  { key: 'intelligence_evals', label: 'Proving Ground' },
  { key: 'intelligence_learning', label: 'Self-Learning' },
];

const WorkforceHubPage = ({ tab, setPage }: { tab: Page; setPage: (p: Page) => void }) => (
  <div className="text-dt-body">
    <div className="px-6 pt-8">
      <h1 className="text-2xl font-semibold text-dt-title">Workforce</h1>
      <p className="text-sm text-dt-support mt-1 max-w-2xl">
        Your digital employees — who they are, what they're working on right now, how they perform, and how they get better.
      </p>
      <div className="mt-5">
        <TabBar tabs={TABS} active={tab} onSelect={setPage} />
      </div>
    </div>
    <InHubContext.Provider value={true}>
      {tab === 'workforce_des' && <WorkforceDEsPage setPage={setPage} />}
      {tab === 'ops_de_activity' && <DEActivityPage setPage={setPage} />}
      {tab === 'outcomes' && <OutcomeStatement setPage={setPage} />}
      {tab === 'intelligence_performance' && <PerformancePage setPage={setPage} />}
      {tab === 'intelligence_evals' && <ProvingGroundPage setPage={setPage} />}
      {tab === 'intelligence_learning' && <SelfLearningPage setPage={setPage} />}
    </InHubContext.Provider>
  </div>
);

export default WorkforceHubPage;
