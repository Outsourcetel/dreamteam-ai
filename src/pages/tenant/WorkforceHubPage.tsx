import type { Page } from '../../types';
import WorkforceDEsPage from './WorkforceDEsPage';
import DEActivityPage from './ops/DEActivityPage';
import { PerformancePage } from './intelligence/IntelligencePages';
import ProvingGroundPage from './intelligence/ProvingGroundPage';
import SelfLearningPage from './intelligence/SelfLearningPage';

// Workforce hub — the employee lifecycle as ONE destination (north-star IA):
// who they are (Roster), what they're doing right now (At Work), how they're
// performing, how they're tested (Proving Ground) and how they get better
// (Self-Learning). Tabs stay real Page keys so old URLs deep-link via URLSync.
const TABS: { page: Page; label: string }[] = [
  { page: 'workforce_des', label: 'Roster' },
  { page: 'ops_de_activity', label: 'At Work' },
  { page: 'intelligence_performance', label: 'Performance' },
  { page: 'intelligence_evals', label: 'Proving Ground' },
  { page: 'intelligence_learning', label: 'Self-Learning' },
];

const WorkforceHubPage = ({ tab, setPage }: { tab: Page; setPage: (p: Page) => void }) => (
  <div className="text-slate-200">
    <div className="max-w-6xl mx-auto px-6 pt-8">
      <h1 className="text-2xl font-semibold text-white">Workforce</h1>
      <p className="text-sm text-slate-400 mt-1 max-w-2xl">
        Your digital employees — who they are, what they're working on right now, how they perform, and how they get better.
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
    {tab === 'workforce_des' && <WorkforceDEsPage setPage={setPage} />}
    {tab === 'ops_de_activity' && <DEActivityPage setPage={setPage} />}
    {tab === 'intelligence_performance' && <PerformancePage setPage={setPage} />}
    {tab === 'intelligence_evals' && <ProvingGroundPage setPage={setPage} />}
    {tab === 'intelligence_learning' && <SelfLearningPage setPage={setPage} />}
  </div>
);

export default WorkforceHubPage;
