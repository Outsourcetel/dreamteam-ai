import type { Page } from '../../types';
import { InHubContext } from '../../components/ui';
import { TabBar } from '../../design/primitives';
import { canAccessPage } from '../../lib/navAccess';
import { useAuth } from '../../context/AuthContext';
// Straight to the live roster. WorkforceDEsPage.tsx was a two-line wrapper
// around this, sitting on top of 1,346 lines of demo-era components — a
// 17-tab DE profile, an org view, a human profile — that NOTHING rendered.
// Deleted 2026-08-07. An imported component is not a rendered one, and a
// redesign aimed at that file would have changed a page no user can reach.
import LiveWorkforceDEs from './LiveWorkforceDEs';
import DEActivityPage from './ops/DEActivityPage';
import { PerformancePage } from './intelligence/IntelligencePages';
import ProvingGroundPage from './intelligence/ProvingGroundPage';
import SelfLearningPage from './intelligence/SelfLearningPage';
import OutcomeStatement from '../../components/OutcomeStatement';

// ════════════════════════════════════════════════════════════════════════════
// Workforce hub — SIX TABS BECOME THREE (design handoff 04).
//
// The six were six answers to one question asked six ways: who they are, what
// they are doing, what it was worth, how they perform, how they are tested,
// how they improve. An owner does not hold six of those in their head. They
// hold three — is my team working, was it worth it, is it getting better.
//
//   Team                Roster + At Work
//   Results             Value + Performance
//   Training & testing  Proving Ground + Self-Learning
//
// ⚠⚠ THE PAIRS DO NOT SHARE AN ACCESS TIER, AND THE HANDOFF DOES NOT SAY SO.
//
//   workforce_des           ALL_TENANT     ops_de_activity          MANAGE
//   outcomes                ALL_TENANT     intelligence_performance MANAGE
//   intelligence_evals      MANAGE         intelligence_learning    MANAGE
//
// Two of the three pairs put an all-tenant page and a manager-only page in one
// tab. Rendering both halves unconditionally would have shown every role the
// live activity feed and the performance analysis that navAccess deliberately
// withholds — a permissions regression introduced by a visual refactor, which
// is the quietest kind.
//
// So each half is gated on its OWN key. A tenant_user opening Team gets the
// roster and nothing else; a manager gets both. The tab appears when ANY of
// its members is reachable.
//
// ⚠ ALL SIX PAGE KEYS STILL RESOLVE — URLSync, deep links, the Sidebar and
// canAccessPage all key off the original six. Collapsing them would re-grade
// half the hub by accident.
//
// ⚠ This merges the NAVIGATION, not the data. Folding At Work's activity into
// the roster's rows is the EmployeeCard work in 04, and it needs per-employee
// metrics the roster does not fetch today — "Not enough data yet" on every row
// is that gap showing, not a bug.
// ════════════════════════════════════════════════════════════════════════════

const GROUPS: { key: Page; label: string; members: Page[] }[] = [
  { key: 'workforce_des', label: 'Team', members: ['workforce_des', 'ops_de_activity'] },
  { key: 'outcomes', label: 'Results', members: ['outcomes', 'intelligence_performance'] },
  { key: 'intelligence_evals', label: 'Training & testing', members: ['intelligence_evals', 'intelligence_learning'] },
];

/** Which of the three a given key belongs to. Falls back to Team so an unknown
 *  key lands somewhere real rather than on a blank hub. */
const groupOf = (tab: Page) => GROUPS.find(g => g.members.includes(tab)) ?? GROUPS[0];

const WorkforceHubPage = ({ tab, setPage }: { tab: Page; setPage: (p: Page) => void }) => {
  const { authedUser } = useAuth();
  const role = (authedUser?.role ?? 'tenant_user') as Parameters<typeof canAccessPage>[0];
  const layer = authedUser?.layer as Parameters<typeof canAccessPage>[2];
  const deRelations = (authedUser as { deRelations?: unknown } | null)?.deRelations as Parameters<typeof canAccessPage>[3];
  const may = (p: Page) => canAccessPage(role, p, layer, deRelations);

  const active = groupOf(tab);
  const tabs = GROUPS.filter(g => g.members.some(may)).map(({ key, label }) => ({ key, label }));

  return (
    <div className="text-dt-body">
      <div className="px-6 pt-8">
        <h1 className="text-2xl font-semibold text-dt-title">Workforce</h1>
        <p className="text-sm text-dt-support mt-1 max-w-2xl">
          Your digital employees — who they are, what they're working on right now, how they perform, and how they get better.
        </p>
        <div className="mt-5">
          {/* active.key, not tab — arriving on ops_de_activity should light up
              Team rather than lighting up nothing. */}
          <TabBar tabs={tabs} active={active.key} onSelect={setPage} />
        </div>
      </div>
      <InHubContext.Provider value={true}>
        {active.key === 'workforce_des' && (
          <>
            {may('workforce_des') && <LiveWorkforceDEs setPage={setPage} />}
            {may('ops_de_activity') && <DEActivityPage setPage={setPage} />}
          </>
        )}
        {active.key === 'outcomes' && (
          <>
            {may('outcomes') && <OutcomeStatement setPage={setPage} />}
            {may('intelligence_performance') && <PerformancePage setPage={setPage} />}
          </>
        )}
        {active.key === 'intelligence_evals' && (
          <>
            {may('intelligence_evals') && <ProvingGroundPage setPage={setPage} />}
            {may('intelligence_learning') && <SelfLearningPage setPage={setPage} />}
          </>
        )}
      </InHubContext.Provider>
    </div>
  );
};

export default WorkforceHubPage;
