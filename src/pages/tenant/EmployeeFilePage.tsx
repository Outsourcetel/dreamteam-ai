import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../components/useDialog';
import { useCanOpenPage } from '../../lib/useRoleGate';
import type { Page } from '../../types';
import { listDigitalEmployees, type DigitalEmployee } from '../../lib/digitalEmployeesApi';
import { listDeHealth, DE_HEALTH_LABELS, type DEHealth } from '../../lib/deHealthApi';
import { getDeWorkItems, getDeObjectives, saveObjective, countDeOutputs, getObjectiveWakes, type WorkItemRow, type ObjectiveRow, type ObjectiveWakeRow } from '../../lib/deWorkbenchApi';
import { getWorkforceBoard, listMissions, type WorkforceBoardRow } from '../../lib/missionApi';
import { fmtWhen } from '../../components/WorkforceBoard';
import { listDEActivity, type DEActivityRow, type InquiryDecisionKind } from '../../lib/deActivityApi';
import {
  getDePerformanceMetrics, getDeInquiryMetrics, getDeCostMetricsRanged, getDeCsatMetrics, getDeActionMetrics,
  getOutcomeMetering, getDeWorkMetrics, getDeContractMetrics,
  type DePerformanceMetrics, type DeInquiryMetrics, type DeCostMetrics, type DeCsatMetrics, type DeActionMetrics,
  type DeWorkMetrics, type DeContractMetric,
} from '../../lib/api';
import { useLocation, useNavigate } from 'react-router-dom';
import { useIsTenantAdmin } from '../../lib/useRoleGate';
import { useEmployeeFileDeId, EMPLOYEE_FILE_PATH } from '../../lib/employeeFileRoute';
import {
  getDeExecutionLog, getDeExperience, getDeAgenticRuns, getAgenticRunMessages,
  getDeRoleContext, getDeWorkProduct,
  type DeRun, type DeExperience, type AgenticRun, type AgenticMessage,
  type RoleContext, type WorkProduct,
} from '../../lib/employeeRecordApi';
import { CATEGORY_LABELS, CATEGORY_SHORT, type SystemCategory } from '../../lib/categoryContracts';
import DeWorkbenchPanel from './DeWorkbench';
import CaseTimelinePanel from '../../components/CaseTimelinePanel';
import DeliverablesPanel from '../../components/DeliverablesPanel';
import MissionPanel from '../../components/MissionPanel';
import OperatingModelPanel from '../../components/OperatingModelPanel';
import {
  DeProfileSections, DeIncidentsPanel,
  DeKpisPanel, DeEconomicsPanel, DeDevelopmentPanel, DeReviewsPanel, DeSkillsPanel,
} from './EmployeeFileSections';
import {
  Button, Chip, PanelCard, StatTile, EmptyState, TabBar, Banner, TimelineStep, FilterBar, SELECT_CLS, type Tone,
} from '../../design/primitives';
import { say, DE_STATUS } from '../../design/statusVocabulary';
import {
  listRoleArchetypes, applyRoleKitToEmployee,
  type RoleArchetype, type AppliedRoleKit,
} from '../../lib/hireApi';
import { presentError } from '../../lib/presentError';

// ═══════════════════════════════════════════════════════════════
// Employee File — ONE page per Digital Employee, with a URL other
// surfaces can link to (/workforce/employee?de=<id>&tab=<key>). The
// front door to "watch this employee work": Work (live queue +
// objectives + deliverables), Performance (the same outcome RPCs as
// the Performance tab, scoped to one DE), and the full Workbench
// (memory / reasoning / replay), which was previously buried four
// clicks deep in the roster detail panel.
// ═══════════════════════════════════════════════════════════════

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const TRUST_TONE: Record<string, Tone> = { supervised: 'warn', established: 'info', trusted: 'accent', autonomous: 'ok' };
const WORK_TONE: Record<string, { tone: Tone; pulse?: boolean }> = {
  running: { tone: 'info', pulse: true }, queued: { tone: 'neutral' }, waiting_human: { tone: 'warn' },
  done: { tone: 'ok' }, failed: { tone: 'danger' }, cancelled: { tone: 'neutral' },
};
/** ONE time-window vocabulary for the whole file. Both the Performance tab and
 *  the Work tab's decision feed offer a window; two arrays saying the same
 *  thing is how six pages ended up with six disagreeing STATUS_METAs. */
const RANGES: { label: string; days: number | null }[] = [
  { label: '7 days', days: 7 }, { label: '30 days', days: 30 }, { label: '90 days', days: 90 }, { label: 'All time', days: null },
];
/** How far back the decision feed reads. Was a hard 10 with no scroll, no
 *  pagination and no way to see the eleventh. The busiest employee on the
 *  platform has 26 runs, so 50 clears real history with room; the list scrolls
 *  rather than growing the page, and says so when it hits the cap. */
const ACTIVITY_LIMIT = 50;
/** Label for `evidence_run_decisions.source_category`.
 *  ⚠ This is the SYSTEM a decision touched, never a topic — evidence_runs
 *  carries no topic column at all. 'support' is not a connector category, so it
 *  falls through CATEGORY_SHORT and is humanised here rather than shown raw. */
const systemLabel = (c: string): string =>
  CATEGORY_SHORT[c as SystemCategory] ?? c.replace(/_/g, ' ').replace(/^./, m => m.toUpperCase());

const DECISION_CHIP: Record<InquiryDecisionKind, { label: string; tone: Tone }> = {
  would_auto_send: { label: 'Would auto-send', tone: 'ok' },
  needs_review: { label: 'Needs review', tone: 'warn' },
  blocked_guardrail: { label: 'Blocked by guardrail', tone: 'danger' },
  skipped_no_access: { label: 'No access', tone: 'danger' },
  would_act: { label: 'Would act — awaiting approval', tone: 'warn' },
  acted: { label: 'Acted', tone: 'ok' },
};

// One employee, ONE page (founder structural fix 2026-07-22): the old
// in-roster profile panel merged into this file — its sections render via
// DeProfileSections so nothing exists in two places anymore.
// docs/31 Q2+Q4 merge ("organize by tense"): Today was renamed Work — the live
// queue IS the work — and the old Work tab (the lifetime ledger) moved to the
// top of Record. 'today' stays the internal key so nothing that ever pointed
// here breaks; the label is what the founder sees.
// docs/31 steps 7-8: 'capabilities' merged into 'profile' (one setup tab) and
// 'development' dissolved into 'performance' (targets beside actuals). The
// old keys survive only as ?tab= aliases below — never as tabs.
type FileTab = 'today' | 'operating' | 'record' | 'performance' | 'workbench'
  | 'profile' | 'trust' | 'governance';
// ════════════════════════════════════════════════════════════════════════
// EIGHT TABS BECOME FOUR (design handoff 05).
//
// Eight tabs on one person is a filing system, not a record. An owner asks
// four things about an employee: what is it doing, is it any good, how does
// it work, and what has it been through.
//
//   Work           today + workbench
//   Performance    performance
//   How it works   operating + profile + trust
//   Record         record + governance
//
// ⚠ ALL EIGHT KEYS STILL RESOLVE. ?tab= deep links are handed out by the
// roster, by the Command Centre and by RecordTab's own openTab() — and
// TAB_ALIASES already exists because stale links were landing nowhere once
// before. Collapsing the keys would break the same thing a second time.
//
// ⚠ The handoff also lists a "Specialist tools" tab, "appears only when
// is_specialist". There is no such tab and no such column: the specialist
// role was retired in migration 611 and its surface removed. Nothing to do.
const TAB_GROUPS: { key: FileTab; label: string; members: FileTab[] }[] = [
  { key: 'today', label: 'Work', members: ['today', 'workbench'] },
  { key: 'performance', label: 'Performance', members: ['performance'] },
  { key: 'operating', label: 'How it works', members: ['operating', 'profile', 'trust'] },
  { key: 'record', label: 'Record', members: ['record', 'governance'] },
];
const FILE_TABS = TAB_GROUPS.map(({ key, label }) => ({ key, label }));
/** Which of the four a key belongs to — falls back to Work so an unknown
 *  ?tab= lands on something real rather than a page with no content. */
const groupOf = (t: FileTab) => TAB_GROUPS.find(g => g.members.includes(t)) ?? TAB_GROUPS[0];
// Stale deep links keep landing somewhere sensible — aliases, not errors.
const TAB_ALIASES: Record<string, FileTab> = { capabilities: 'profile', development: 'performance' };

// ── Work — what this employee is doing right now ──────────────────
// (was "Today" — renamed in the docs/31 merge; the internal key stays 'today'.)
// Absorbs the Workbench→Work pieces that existed nowhere else: the objectives
// EDITOR (the Done button is the only brake on an objective waking forever)
// and the deliverables reader. Queue rows carry result summaries and errors,
// as the Workbench rendering did. The DE population is bimodal (queue-driven
// vs answer-driven), so every panel collapses rather than stacks when empty.

/** Plain-language label for a stalled goal.
 *
 *  Mapped over ALL THREE flag values so an unhandled one can never render raw,
 *  even though the sweep currently only writes two of them. Every label is
 *  tone 'warn' — the loop is alive, a person has to intervene. */
function attentionLabel(o: ObjectiveRow): string {
  const since = o.attention_since ? fmtWhen(o.attention_since) : null;
  switch (o.attention_flag) {
    // wake_count is a LIFETIME counter, so this says "woke N times" — never
    // "N notes", which would be false for every goal older than the wake store.
    case 'wake_spin': return `Woke ${o.wake_count} times, nothing moved`;
    case 'waiting_too_long': return since ? `Waiting on you since ${since}` : 'Waiting on you';
    case 'stalled': return since ? `Stalled since ${since}` : 'Stalled';
    // Distinct from 'stalled' on purpose: nothing here is going to start moving
    // on its own. A step failed, so every step behind it is dead too, and
    // somebody has to decide whether to retry it, change the approach or drop
    // the goal. The reason sits on the failed step itself.
    case 'steps_failed': return since ? `A step failed — stuck since ${since}` : 'A step failed — cannot continue';
    default: return 'Needs you';
  }
}

/** The employee's own account of where a goal got to, newest first.
 *
 *  Deliberately NOT a new primitive — TimelineStep already exists for exactly
 *  this shape. The empty state is load-bearing: recording only began with the
 *  wake store, so an older goal legitimately has no entries, and saying
 *  "nothing happened" would be a fresh lie on the screen built to end one. */
function ObjectiveCheckIns({ objectiveId }: { objectiveId: string }) {
  const [rows, setRows] = useState<ObjectiveWakeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getObjectiveWakes(objectiveId)
      .then(r => { if (!cancelled) setRows(r); })
      .catch(e => { if (!cancelled) setError((e as Error)?.message || 'Could not load check-ins.'); });
    return () => { cancelled = true; };
  }, [objectiveId]);

  if (error) return <Banner tone="danger" className="ml-3">{error}</Banner>;
  if (rows === null) return <p className="text-[11px] text-dt-faint ml-3">Loading check-ins…</p>;
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-dt-muted ml-3">
        No check-ins recorded yet — this goal has been running since before check-in
        recording began, so its earlier passes were not written down.
      </p>
    );
  }
  return (
    <ol className="space-y-2 ml-3 mt-1">
      {rows.map(w => (
        <TimelineStep
          key={w.id}
          n={w.wake_no}
          action={w.note || (w.assessment ? `Assessed: ${w.assessment}` : 'No note recorded for this check-in.')}
          detail={`${w.assessment ?? 'in progress'} · ${w.done_item_count} done / ${w.open_item_count} open`}
          at={w.concluded_at ?? w.started_at}
        />
      ))}
    </ol>
  );
}

function WorkTab({ de, setPage }: { de: DigitalEmployee; setPage: (p: Page) => void }) {
  // Two links off this tab point at pages narrower than the Employee File
  // itself, which is ALL_TENANT — approvals is APPROVALS-tier, the activity
  // cockpit is MANAGE. Offered to everyone, they did nothing for most people.
  const canOpenApprovals = useCanOpenPage('ops_human_tasks');
  const canOpenActivity = useCanOpenPage('ops_de_activity');
  // upsert_de_objective is owner/admin; the Employee File is ALL_TENANT.
  // Reading what an employee is working towards is for everyone; setting it
  // is not. The list stays; the Add/Edit/Done controls go.
  const canManage = useIsTenantAdmin();
  const [work, setWork] = useState<WorkItemRow[] | null>(null);
  const [objectives, setObjectives] = useState<ObjectiveRow[]>([]);
  const [activity, setActivity] = useState<DEActivityRow[]>([]);
  const [board, setBoard] = useState<WorkforceBoardRow | null>(null);
  const [missionCount, setMissionCount] = useState<number | null>(null);
  const [missionOpen, setMissionOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Objectives editor state (moved here from the deleted Workbench→Work).
  const [objOpen, setObjOpen] = useState(false);
  const [objEditId, setObjEditId] = useState<string | null>(null);
  const [objTitle, setObjTitle] = useState('');
  const [objPriority, setObjPriority] = useState(3);
  const [objSaving, setObjSaving] = useState(false);
  // Progressive disclosure: the check-in log answers "why is it stuck" exactly
  // where the flag is shown, without making every row taller.
  const [wakesOpen, setWakesOpen] = useState<Record<string, boolean>>({});
  // Decision-feed filters. The default is ALL TIME on purpose: the two busiest
  // employees on the platform (26 and 15 runs) have nothing inside 30 days, so
  // a 30-day default would open this panel empty for exactly the employees with
  // the most to show. Narrowing is the reader's choice, never the page's.
  const [activityDays, setActivityDays] = useState<number | null>(null);
  const [activitySystem, setActivitySystem] = useState('');
  const [activityLoading, setActivityLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getDeWorkItems(de.id), getDeObjectives(de.id)])
      .then(([w, o]) => {
        if (cancelled) return;
        setWork(w);
        setObjectives(o.filter(x => ['open', 'in_progress', 'blocked'].includes(x.status)));
      })
      .catch(e => { if (!cancelled) { setError((e as Error).message); setWork([]); } });
    // The same board read the whole-workforce view uses, scoped to this DE —
    // one truth for "what happens next", no second codepath (docs/17 C2).
    getWorkforceBoard(de.id)
      .then(r => { if (!cancelled) setBoard(r.board[0] ?? null); })
      .catch(() => { /* the panel simply doesn't render */ });
    // Missions stay folded until one exists (0 platform-wide today) — but the
    // panel is the only creation door on this page, so it collapses to a
    // one-line invitation instead of vanishing.
    listMissions(de.id)
      .then(r => { if (!cancelled) setMissionCount(r.missions.length); })
      .catch(() => { if (!cancelled) setMissionCount(0); });
    return () => { cancelled = true; };
  }, [de.id]);

  // Own effect, because the date window is a QUERY parameter — see
  // listDEActivity: filtering a fetched page client-side would report an empty
  // week whenever the newest rows are older than the window.
  useEffect(() => {
    let cancelled = false;
    setActivityLoading(true);
    listDEActivity(ACTIVITY_LIMIT, de.id, activityDays)
      .then(a => {
        if (cancelled) return;
        setActivity(a);
        // A system chosen in a wider window may not exist in a narrower one.
        // Left set, it would strand the panel on an empty list behind a select
        // showing a value that is no longer one of its options.
        setActivitySystem(s => (s && !a.some(r => r.decision?.source_category === s) ? '' : s));
      })
      .catch(e => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setActivityLoading(false); });
    return () => { cancelled = true; };
  }, [de.id, activityDays]);

  const refreshObjectives = async () =>
    setObjectives((await getDeObjectives(de.id)).filter(x => ['open', 'in_progress', 'blocked'].includes(x.status)));

  const handleSaveObjective = async () => {
    if (!objTitle.trim()) return;
    setObjSaving(true); setError(null);
    try {
      await saveObjective({ deId: de.id, title: objTitle.trim(), id: objEditId ?? undefined, priority: objPriority });
      await refreshObjectives();
      setObjOpen(false); setObjEditId(null); setObjTitle('');
    } catch (err) { setError((err as Error).message); }
    setObjSaving(false);
  };

  const handleCloseObjective = async (o: ObjectiveRow) => {
    setError(null);
    try {
      await saveObjective({ deId: de.id, id: o.id, title: o.title, priority: o.priority, status: 'achieved' });
      await refreshObjectives();
    } catch (err) { setError((err as Error).message); }
  };

  if (work === null) return <p className="text-sm text-dt-muted py-8 text-center">Loading live work…</p>;

  const inMotion = work.filter(w => ['running', 'queued', 'waiting_human'].includes(w.status));
  const recent = work.filter(w => !['running', 'queued', 'waiting_human'].includes(w.status)).slice(0, 5);
  const name = de.persona_name ?? de.name;

  // "0 completed" is not the same as "nothing happened". Work is chained: an item
  // that needs a person parks at waiting_human and everything depending on it stays
  // queued — correctly, but invisibly. Riley sat like this for 2.2 days showing only
  // a zero. Say plainly that the employee is blocked ON YOU, and for how long.
  const awaitingYou = work.filter(w => w.status === 'waiting_human');
  const blockedIds = new Set(awaitingYou.map(w => w.id));
  const blockedBehind = work.filter(w => w.status === 'queued' && w.depends_on && blockedIds.has(w.depends_on));
  const oldestWaitMs = awaitingYou.length
    ? Date.now() - Math.min(...awaitingYou.map(w => new Date(w.created_at).getTime()))
    : 0;
  const waitDays = Math.floor(oldestWaitMs / 86_400_000);
  const waitHours = Math.floor(oldestWaitMs / 3_600_000);
  const waitedFor = waitDays >= 1 ? `${waitDays} day${waitDays === 1 ? '' : 's'}`
    : waitHours >= 1 ? `${waitHours} hour${waitHours === 1 ? '' : 's'}` : 'under an hour';

  // ⚠ A SECOND, DIFFERENT source of "waiting on you": board.waiting_on_you is
  // pending `human_tasks`, while awaitingYou above is de_work_items parked at
  // waiting_human. They are not the same rows and mostly do not overlap — of
  // the 17 live employees with a pending human task, ELEVEN have no
  // waiting_human work item at all (verified 2026-08-12). Dropping this count
  // when the "Next up" card stopped rendering it would have deleted the only
  // per-employee sighting of the approvals queue from this tab, so the banner
  // that already owns "you are the bottleneck" carries it instead.
  const pendingDecisions = board?.waiting_on_you ?? 0;

  // Feed filters are client-side ONLY for the system facet (it lives on the
  // decision, not the run); the date window is applied in the query.
  const activitySystems = [...new Set(
    activity.map(r => r.decision?.source_category).filter((c): c is string => !!c),
  )].sort();
  const shownActivity = activitySystem
    ? activity.filter(r => r.decision?.source_category === activitySystem)
    : activity;
  const activityFiltered = activityDays !== null || !!activitySystem;

  return (
    <div className="space-y-5">
      {error && <Banner tone="danger">{error}</Banner>}

      {(awaitingYou.length > 0 || pendingDecisions > 0) && (
        <Banner tone="warn">
          <span className="font-semibold">{name} is waiting on you.</span>{' '}
          {awaitingYou.length > 0 && (
            <>
              {awaitingYou.length} queued task{awaitingYou.length === 1 ? '' : 's'} need{awaitingYou.length === 1 ? 's' : ''} a person
              {blockedBehind.length > 0 && <> — and {blockedBehind.length} more {blockedBehind.length === 1 ? 'is' : 'are'} queued behind {blockedBehind.length === 1 ? 'it' : 'them'}</>}
              . Longest wait: {waitedFor}.{' '}
            </>
          )}
          {/* Counted separately and worded separately, because it IS separate:
              escalations, action approvals, inquiry reviews and checklists, not
              queue items. Saying "tasks" for both would merge two numbers that
              never had the same denominator. */}
          {pendingDecisions > 0 && (
            <>{pendingDecisions} item{pendingDecisions === 1 ? '' : 's'} {pendingDecisions === 1 ? 'is' : 'are'} waiting for your decision in the approvals queue.{' '}</>
          )}
          {canOpenApprovals && <button onClick={() => setPage('ops_human_tasks' as Page)} className="underline hover:text-dt-body">Review approvals →</button>}
        </Banner>
      )}

      {(missionCount ?? 0) > 0 || missionOpen ? (
        <MissionPanel de={de} />
      ) : missionCount !== null && (
        <button onClick={() => setMissionOpen(true)}
          className="w-full text-left rounded-xl border border-dashed border-dt-border px-4 py-2.5 text-xs text-dt-muted hover:border-dt-border-strong hover:text-dt-support transition-colors">
          🎯 No missions running. Give {name} a one-sentence order — it reads it back as a plan you approve before anything starts.
        </button>
      )}

      {/* ⚠ Gated on next_up ALONE. It used to render for listens_live or
          waiting_on_you too, which produced a card headed "Next up" whose body
          read "Nothing on the schedule" — 11 of 107 live employees saw exactly
          that, every one of them triggered by a pending human task rather than
          by anything scheduled. Both of those facts now render where they are
          true: the approvals count in the banner above, the live-inbox line in
          "Working right now" below.
          "by when", not "in order": next_up is a union over work items, case
          waits, watcher fire times and objective wakes ORDERED BY TIME. It is a
          schedule. "In order" reads as a priority ranking, which it never was. */}
      {board && board.next_up.length > 0 && (
        <PanelCard title="Next up — by when">
          <div className="divide-y divide-dt-border">
            {board.next_up.map((n, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <span className="text-sm">{({ work_item: '📋', case_wait: '⏸', watcher: '👁', objective_wake: '🔁' } as Record<string, string>)[n.kind] ?? '•'}</span>
                <p className="text-sm text-dt-body flex-1 truncate">{n.title}</p>
                <span className="text-xs text-dt-muted whitespace-nowrap">{fmtWhen(n.when)}</span>
              </div>
            ))}
          </div>
        </PanelCard>
      )}

      <PanelCard title="Working right now" badge={inMotion.length > 0 ? <Chip tone="info" dot pulse>{inMotion.length} in motion</Chip> : undefined}>
        {inMotion.length === 0 ? (
          <EmptyState icon="🌙" headline="Nothing in motion at this moment">
            {name} picks up work from watchers, playbook triggers, and the support inbox — new items appear here the moment one starts.
          </EmptyState>
        ) : (
          <div className="divide-y divide-dt-border">
            {inMotion.map(w => {
              const t = WORK_TONE[w.status] ?? { tone: 'neutral' as Tone };
              return (
                <div key={w.id} className="flex items-center gap-3 py-2.5">
                  <Chip tone={t.tone} dot pulse={t.pulse}>{w.status.replace(/_/g, ' ')}</Chip>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-dt-body truncate">{w.title}</p>
                    <p className="text-xs text-dt-muted">{w.kind.replace(/_/g, ' ')} · scheduled {fmt(w.scheduled_for)}{w.attempts > 1 ? ` · attempt ${w.attempts}` : ''}</p>
                    {w.result?.summary ? <p className="text-xs text-dt-support mt-0.5 truncate">{String(w.result.summary).slice(0, 240)}</p> : null}
                  </div>
                  {w.last_error && <span className="text-xs text-dt-danger truncate max-w-[16rem]">{w.last_error}</span>}
                </div>
              );
            })}
          </div>
        )}
        {/* Moved out of "Next up" (it has no scheduled time, so it never
            belonged on a schedule): an active inbox watcher IS work happening
            right now, and it is the honest answer to an otherwise empty panel
            for an employee that only ever listens. */}
        {board?.listens_live && (
          <p className="text-xs text-dt-support mt-3">Plus continuous: listening to the live support inbox in real time.</p>
        )}
      </PanelCard>

      <CaseTimelinePanel deId={de.id} />

      {/* Objectives — the EDITOR, not a read-only list (moved from the deleted
          Workbench→Work). The Done button is the only brake on an objective
          waking forever, so it lives on the everyday surface. */}
      <PanelCard title="Open objectives"
        actions={!canManage ? undefined : <Button kind="ghost" size="sm" onClick={() => { setObjOpen(true); setObjEditId(null); setObjTitle(''); setObjPriority(3); }}>+ Set an objective</Button>}>
        {objOpen && canManage && (
          <div className="mb-3 rounded-lg border border-dt-border-strong bg-dt-inset p-3 space-y-2">
            <input value={objTitle} onChange={e => setObjTitle(e.target.value)} autoFocus
              placeholder="What should this employee be working towards?"
              className="w-full bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-dt-accent" />
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-dt-muted">Priority</label>
              <select value={objPriority} onChange={e => setObjPriority(Number(e.target.value))}
                className="bg-dt-card border border-dt-border-strong text-dt-support text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-dt-accent">
                {[1, 2, 3, 4, 5].map(p => <option key={p} value={p}>P{p}{p === 1 ? ' (highest)' : p === 5 ? ' (lowest)' : ''}</option>)}
              </select>
              <button onClick={() => void handleSaveObjective()} disabled={objSaving || !objTitle.trim()}
                className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-dt-accent-strong hover:bg-dt-accent-hover text-white disabled:opacity-40">
                {objSaving ? 'Saving…' : objEditId ? 'Save changes' : 'Add objective'}
              </button>
              <button onClick={() => setObjOpen(false)} className="text-xs text-dt-muted hover:text-dt-support">Cancel</button>
            </div>
          </div>
        )}
        {objectives.length === 0 && !objOpen ? (
          <p className="text-sm text-dt-muted">No objectives set — an objective is a goal {name} keeps pushing forward on a beat until you mark it Done.</p>
        ) : (
          <div className="space-y-2">
            {objectives.map(o => (
              <div key={o.id} className="space-y-1">
                <div className="flex items-center gap-3">
                  {/* Tone semantics are fixed (docs/design-system.md): danger =
                      blocked, warn = needs a human. This row used to render a
                      blocked goal as warn while the board rendered the same fact
                      as danger — with a stall chip alongside, warn had to mean
                      exactly one thing, so the drifted one is corrected here. */}
                  <Chip tone={o.status === 'blocked' ? 'danger' : o.status === 'in_progress' ? 'info' : 'neutral'}>{o.status.replace(/_/g, ' ')}</Chip>
                  {o.attention_flag && (
                    <Chip tone="warn">{attentionLabel(o)}</Chip>
                  )}
                  <span className="text-sm text-dt-body flex-1">{o.title}</span>
                  <span className="text-[11px] text-dt-faint">P{o.priority}{o.due_at ? ` · due ${fmt(o.due_at)}` : ''}</span>
                  {o.attention_flag && (
                    <button onClick={() => setWakesOpen(w => ({ ...w, [o.id]: !w[o.id] }))}
                      className="text-[10px] text-dt-faint hover:text-dt-warn">
                      {wakesOpen[o.id] ? 'Hide check-ins' : 'Why?'}
                    </button>
                  )}
                  {canManage && (
                    <>
                      <button onClick={() => { setObjOpen(true); setObjEditId(o.id); setObjTitle(o.title); setObjPriority(o.priority || 3); }}
                        className="text-[10px] text-dt-faint hover:text-dt-accent-text">Edit</button>
                      {/* This list is already filtered to open | in_progress | blocked
                          (the statuses de_objectives can actually hold while live), so
                          every row gets the Done brake. */}
                      <button onClick={() => void handleCloseObjective(o)}
                        className="text-[10px] text-dt-faint hover:text-dt-ok">Done</button>
                    </>
                  )}
                </div>
                {o.attention_flag && wakesOpen[o.id] && <ObjectiveCheckIns objectiveId={o.id} />}
              </div>
            ))}
          </div>
        )}
      </PanelCard>

      <DeliverablesPanel deId={de.id} />

      <PanelCard
        title="Recent decisions & answers"
        actions={canOpenActivity ? <Button kind="ghost" size="sm" onClick={() => setPage('ops_de_activity')}>Open the At Work cockpit →</Button> : undefined}
      >
        {/* The bar appears once there is anything to narrow, and STAYS while a
            filter is on — otherwise a filter that empties the list takes its own
            Clear button away with it. */}
        {(activity.length > 0 || activityFiltered) && (
          <FilterBar
            className="mb-3"
            presets={<>
              {RANGES.map(r => (
                <button key={r.label} onClick={() => setActivityDays(r.days)} aria-pressed={activityDays === r.days}>
                  <Chip tone={activityDays === r.days ? 'accent' : 'neutral'}>{r.label}</Chip>
                </button>
              ))}
            </>}
            /* ⚠ "System", never "Topic". evidence_runs has no topic column;
               source_category records WHICH SYSTEM the decision touched (CRM,
               ERP, the support desk). Labelling it a topic would invent a
               meaning the data has never carried. Options come from the values
               PRESENT in these rows, so the facet self-enables. */
            facets={activitySystems.length > 1 ? (
              <select value={activitySystem} aria-label="Filter by the system the decision touched"
                className={SELECT_CLS} onChange={e => setActivitySystem(e.target.value)}>
                <option value="">Any system</option>
                {activitySystems.map(c => <option key={c} value={c}>{systemLabel(c)}</option>)}
              </select>
            ) : undefined}
            views={activityFiltered ? (
              <Button kind="ghost" size="sm" onClick={() => { setActivityDays(null); setActivitySystem(''); }}>Clear</Button>
            ) : undefined}
          />
        )}
        {activityLoading ? (
          <p className="text-sm text-dt-muted py-6 text-center">Loading decisions…</p>
        ) : shownActivity.length === 0 ? (
          activityFiltered ? (
            // NOT "no recorded decisions yet" — that would blame the employee
            // for a window the reader chose.
            <EmptyState icon="🔍" headline="Nothing recorded inside these filters"
              action={<Button kind="secondary" size="sm" onClick={() => { setActivityDays(null); setActivitySystem(''); }}>Show all time</Button>}>
              {name} has no decisions in the selected window{activitySystem ? ` for ${systemLabel(activitySystem)}` : ''}. Widen the range to look further back.
            </EmptyState>
          ) : (
            <EmptyState icon="🗒️" headline="No recorded decisions yet">
              Every answer and action {name} takes lands here with its evidence trail — knowledge used, systems consulted, and the decision that came out.
            </EmptyState>
          )
        ) : (
          <>
            {/* Scrolls inside the card instead of stretching the page. Rows are
                flex, not a table, so only the vertical axis is constrained —
                nothing here can clip a column. */}
            <div className="max-h-96 overflow-y-auto divide-y divide-dt-border pr-1">
              {shownActivity.map(r => {
                const d = r.decision ? DECISION_CHIP[r.decision.decision] : null;
                const cat = r.decision?.source_category;
                return (
                  <div key={r.evidence_run.id} className="flex items-center gap-3 py-2.5">
                    <span className="text-xs text-dt-muted w-28 shrink-0">{fmt(r.evidence_run.created_at)}</span>
                    <p className="text-sm text-dt-body truncate flex-1">{r.evidence_run.inquiry}</p>
                    {cat && <span className="text-[11px] text-dt-muted shrink-0">{systemLabel(cat)}</span>}
                    {d ? <Chip tone={d.tone}>{d.label}</Chip> : <Chip tone="neutral">no decision</Chip>}
                  </div>
                );
              })}
            </div>
            {/* Say what is on screen and what is not. A capped list that stays
                silent about its cap reads as the whole history. */}
            <p className="text-[11px] text-dt-muted mt-2">
              {activitySystem ? `${shownActivity.length} of ${activity.length} shown` : `${shownActivity.length} shown`}
              {activityDays === null ? ', all time' : `, last ${activityDays} days`}
              {activity.length >= ACTIVITY_LIMIT && ` — the newest ${ACTIVITY_LIMIT} only; narrow the window or open the cockpit to see further back`}.
            </p>
          </>
        )}
      </PanelCard>

      {/* Not "Recently finished": since mig 493 this panel also carries
          cancelled work — including the items the old runtime recorded as
          completed when the employee had actually stopped to ask a question.
          Each row states its own status; the heading must not contradict them. */}
      {recent.length > 0 && (
        <PanelCard title="Recently closed">
          <div className="divide-y divide-dt-border">
            {recent.map(w => (
              <div key={w.id} className="py-2">
                <div className="flex items-center gap-3">
                  <Chip tone={(WORK_TONE[w.status] ?? { tone: 'neutral' as Tone }).tone}>{w.status.replace(/_/g, ' ')}</Chip>
                  <p className="text-sm text-dt-support truncate flex-1">{w.title}</p>
                  <span className="text-xs text-dt-muted">{fmt(w.created_at)}</span>
                </div>
                {/* Richer rows (from the Workbench rendering): what came out, or
                    what went wrong — a bare status told you neither. */}
                {w.result?.summary ? <p className="text-xs text-dt-support mt-1 pl-1">{String(w.result.summary).slice(0, 240)}</p> : null}
                {w.last_error ? <p className="text-xs text-rose-400/80 mt-1 pl-1">{w.last_error}</p> : null}
              </div>
            ))}
          </div>
        </PanelCard>
      )}
    </div>
  );
}

// ── Performance — the Performance tab's numbers, for ONE employee ─
// (RANGES — the shared time-window vocabulary — is declared at the top of the
// file: the Work tab's decision feed offers the same four windows.)

function PerformanceTab({ de, tenantId }: { de: DigitalEmployee; tenantId: string }) {
  const [range, setRange] = useState<number | null>(30);
  const [loading, setLoading] = useState(true);
  const [perf, setPerf] = useState<DePerformanceMetrics | null>(null);
  const [inquiry, setInquiry] = useState<DeInquiryMetrics | null>(null);
  const [cost, setCost] = useState<DeCostMetrics | null>(null);
  const [csat, setCsat] = useState<DeCsatMetrics | null>(null);
  const [actions, setActions] = useState<DeActionMetrics | null>(null);
  const [resolutions, setResolutions] = useState<{ resolutions: number; escalations: number } | null>(null);
  const [outputs, setOutputs] = useState<{ items_done: number; deliverables: number } | null>(null);
  const [work, setWork] = useState<DeWorkMetrics | null>(null);
  const [contract, setContract] = useState<DeContractMetric[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getDePerformanceMetrics(tenantId),
      getDeInquiryMetrics(tenantId, range),
      getDeCostMetricsRanged(tenantId, range),
      getDeCsatMetrics(tenantId),
      getDeActionMetrics(tenantId, range),
      getOutcomeMetering(tenantId, range),
      countDeOutputs(de.id, range).catch(() => ({ items_done: 0, deliverables: 0 })),
      getDeWorkMetrics(tenantId),
      getDeContractMetrics(tenantId, de.id),
    ]).then(([m, iq, c, s, a, om, outs, wk, ct]) => {
      if (cancelled) return;
      setPerf(m.find(x => x.de_id === de.id) ?? null);
      setWork(wk.find(x => x.de_id === de.id) ?? null);
      setContract(ct);
      setInquiry(iq.find(x => x.de_id === de.id) ?? null);
      setCost(c.find(x => x.de_id === de.id) ?? null);
      setCsat(s.find(x => x.de_id === de.id) ?? null);
      setActions(a.find(x => x.de_id === de.id) ?? null);
      const mine = om?.by_de.find(x => x.de_id === de.id);
      setResolutions(mine ? { resolutions: mine.resolutions, escalations: mine.escalations } : null);
      setOutputs(outs);
    }).catch((e) => {
      // A rejecting metric RPC must not hang the tab on "Loading…" forever.
      if (!cancelled) console.error('performance metrics load failed', e);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tenantId, de.id, range]);

  if (loading) return <p className="text-sm text-dt-muted py-8 text-center">Loading performance…</p>;

  const nothing = !perf && !inquiry && !cost && !csat && !actions && !resolutions
    && !(outputs && (outputs.items_done > 0 || outputs.deliverables > 0));

  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);

  return (
    <div className="space-y-5">
      {/* docs/31 Q9 + step 8: expectation and result finally share a screen —
          targets (Goals & KPIs, once marooned on the Development tab) render
          ABOVE the actuals they are targets for. */}
      <DeKpisPanel de={de} />

      <div className="flex items-center gap-1">
        <span className="text-[11px] uppercase tracking-wide text-dt-muted mr-2">Time window</span>
        {RANGES.map(r => (
          <button key={r.label} onClick={() => setRange(r.days)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${range === r.days ? 'border-dt-accent bg-dt-accent-soft text-dt-accent-text' : 'border-dt-border text-dt-support hover:border-dt-border-strong'}`}>
            {r.label}
          </button>
        ))}
      </div>

      {nothing ? (
        <EmptyState icon="📊" headline="No performance history in this window yet">
          Numbers appear after {de.persona_name ?? de.name} handles real inquiries and actions — try "All time", or come back once work has flowed through.
        </EmptyState>
      ) : (
      <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Resolutions delivered" value={String(resolutions?.resolutions ?? 0)}
          sub={resolutions ? `${resolutions.escalations} handed to your team` : undefined} tone="ok" />
        <StatTile label="Inquiries handled" value={String(inquiry?.total_decisions ?? 0)} tone="accent" />
        <StatTile label="Resolution" value={pct(inquiry?.resolution_rate)} tone="ok" />
        <StatTile label="Confidence" value={pct(inquiry?.avg_confidence)} tone="info" />
        <StatTile label="Escalation" value={pct(inquiry?.escalation_rate)} tone={inquiry && inquiry.escalation_rate > 20 ? 'warn' : 'neutral'} />
        <StatTile label="Work items completed" value={String(outputs?.items_done ?? 0)} sub={outputs?.deliverables ? `${outputs.deliverables} document(s) produced` : undefined} tone="accent" />
        <StatTile label="Actions executed" value={String(actions?.executed ?? 0)} sub={actions ? `${actions.sent_to_human} sent to a human` : undefined} tone="ok" />
        <StatTile label="AI cost" value={cost ? `$${cost.total_cost_usd.toFixed(2)}` : '$0.00'} sub={cost ? `${cost.total_calls} calls` : undefined} tone="neutral" />
      </div>

      {/* What good work MEANS for this role (mig 502, founder decision D3).
          Sits above the generic work counts because it is the scorecard; the
          counts below are the raw activity behind it. Rendered only for an
          employee whose role has a contract — 94 of 116 employees platform-wide
          have no archetype, and a generic scorecard for them would be invented. */}
      {contract.length > 0 && (
        <PanelCard title={`What good work means for ${de.name}`}>
          <div className="space-y-3">
            {(['primary', 'secondary'] as const).map(tier => {
              const rows = contract.filter(m => m.tier === tier);
              if (rows.length === 0) return null;
              return (
                <div key={tier}>
                  <p className="text-[10px] uppercase tracking-wide text-dt-faint mb-1.5">{tier}</p>
                  <div className="space-y-1.5">
                    {rows.map(m => (
                      <div key={m.metric_key} className="flex items-baseline gap-3">
                        <span className="text-sm text-dt-body flex-1">{m.label}</span>
                        {m.measurable ? (
                          <span className="text-sm font-semibold text-dt-title">
                            {m.unit === 'cents' ? `$${Math.round((m.value ?? 0) / 100).toLocaleString('en-US')}`
                              : m.unit === 'percent' ? `${m.value}%`
                              : String(m.value ?? 0)}
                            {m.target !== null && <span className="text-[11px] text-dt-faint font-normal"> / target {m.unit === 'percent' ? `${m.target}%` : m.target}</span>}
                          </span>
                        ) : (
                          // Never a number here. A zero would say the employee
                          // failed at something nothing has ever attempted.
                          <Chip tone="neutral">Not measured</Chip>
                        )}
                      </div>
                    ))}
                    {rows.filter(m => !m.measurable).map(m => (
                      <p key={`${m.metric_key}-why`} className="text-[11px] text-dt-muted pl-1">
                        {m.label}: {m.unmeasurable_because}
                      </p>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </PanelCard>
      )}

      {/* Work-shaped performance (mig 499/500). The tiles above are computed
          over answered inquiries — a queue employee produces none of that
          evidence, which is why its Resolution and Escalation read "not
          measured" since mig 491. These are its OWN numbers, kept separate on
          purpose: a renewal case and a support conversation share no
          denominator, and blending them moves a support employee's rate with
          zero change in its behaviour. Rendered only when there IS work. */}
      {work && (work.items_completed + work.items_cancelled + work.escalations_raised + work.goals_needing_attention) > 0 && (
        <PanelCard title="Work this employee runs">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile label="Work completed" value={String(work.items_completed)}
              sub={work.items_cancelled > 0 ? `${work.items_cancelled} cancelled` : undefined} tone="ok" />
            <StatTile label="Raised to a person" value={String(work.escalations_raised)}
              sub={work.escalations_unanswered > 0 ? `${work.escalations_unanswered} still unanswered` : 'all answered'}
              tone={work.escalations_unanswered > 0 ? 'warn' : 'neutral'} />
            <StatTile label="Escalation" value={pct(work.escalation_rate)}
              tone={work.escalation_rate !== null && work.escalation_rate > 50 ? 'warn' : 'neutral'} />
            <StatTile label="Goals needing you" value={String(work.goals_needing_attention)}
              sub={work.oldest_unanswered_hours ? `oldest wait ${Math.round(work.oldest_unanswered_hours)}h` : undefined}
              tone={work.goals_needing_attention > 0 ? 'warn' : 'neutral'} />
          </div>
        </PanelCard>
      )}

      <div className="grid md:grid-cols-3 gap-3">
        <PanelCard title="Autonomy">
          <p className="text-2xl font-semibold text-dt-title">{pct(actions?.autonomy_rate)}</p>
          <p className="text-xs text-dt-support mt-1">of executed actions ran without a human — the rest waited at the approval gate ({actions?.approved_after_gate ?? 0} approved, {actions?.rejected ?? 0} rejected, {actions?.blocked ?? 0} blocked).</p>
        </PanelCard>
        <PanelCard title="Customer satisfaction">
          <p className="text-2xl font-semibold text-dt-title">{csat && csat.total_ratings > 0 ? `${Math.round(csat.csat_pct)}%` : '—'}</p>
          <p className="text-xs text-dt-support mt-1">{csat && csat.total_ratings > 0 ? `${csat.positive_ratings} positive of ${csat.total_ratings} ratings (all time).` : 'No ratings collected yet.'}</p>
        </PanelCard>
        <PanelCard title="Quality flags">
          <p className="text-2xl font-semibold text-dt-title">{perf?.blocked_guardrail_count ?? 0}</p>
          <p className="text-xs text-dt-support mt-1">guardrail blocks all-time · error rate {pct(perf?.error_rate)} · {perf?.high_frustration_count ?? 0} high-frustration conversations.</p>
        </PanelCard>
      </div>
      </>
      )}

      {/* Economics — what this output actually cost, and what it saved
          against baselines the workspace typed in (never invented). */}
      <DeEconomicsPanel de={de} />

      {/* Growth — the dissolved Development tab (docs/31 step 8). The
          development-plan card leads: it was the tab's only actionable card
          and it led from the back for weeks. Then reviews, then skills.
          (Exam-based certification lives on Trust & Autonomy — it is what
          mechanically gates autonomy.) */}
      <div className="pt-1">
        <h2 className="text-sm font-semibold text-dt-title mb-3">Growth</h2>
        <div className="space-y-5">
          <DeDevelopmentPanel de={de} />
          <DeReviewsPanel de={de} />
          <DeSkillsPanel de={de} />
        </div>
      </div>
    </div>
  );
}

// ── Lifetime ledger — output BY ROLE, the head of the Record ──────
// (was the tab called "Work" — it never showed the work queue, it showed the
// lifetime output ledger; docs/31 moved it here, past tense with past tense.)
// Resolves the employee's domain from the system categories it operates
// (generic — not a hardcoded department) and shows what it has actually
// produced, framed in that domain's language. A finance DE shows payment
// reminders and reconciliations; a support DE shows cases. Same component,
// zero per-vertical code — driven by the category-contract layer.
// ⚠ The per-action auto-executed vs human-approved split rendered here is the
// ONLY surface of that governance number anywhere — it must stay visible.
const domainLabel = (c: string): string => CATEGORY_LABELS[c as SystemCategory] ?? c.replace(/_/g, ' ');
const domainShort = (c: string): string => CATEGORY_SHORT[c as SystemCategory] ?? c.replace(/_/g, ' ');

// ── Role template — give an existing employee its Book of Work + SOP ──
// Until migration 553 a role kit could only be installed at hire time, so
// every employee hired before that has no watchers, no SOP and no role
// guardrails, and the only remedy was hiring a replacement. This applies one
// in place. Re-roling an employee that already has a template changes what it
// watches and what it may do, so that path asks first.
function RoleTemplatePanel({
  de, role, onApplied,
}: { de: DigitalEmployee; role: RoleContext | null; onApplied: () => void }) {
  const { confirm, confirmUI } = useConfirm();
  const [open, setOpen] = useState(false);
  const [kits, setKits] = useState<RoleArchetype[] | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<AppliedRoleKit | null>(null);

  const current = role?.archetype_key ?? null;

  useEffect(() => {
    if (!open || kits !== null) return;
    listRoleArchetypes().then(setKits).catch(() => setKits([]));
  }, [open, kits]);

  const apply = async () => {
    if (!choice) return;
    setBusy(true); setError(null);
    try {
      // Re-roling is confirmed here rather than passed blindly: the server
      // refuses without it, and the operator should know why.
      const rerole = !!current && current !== choice;
      if (rerole && !await confirm({
        title: `Change what ${de.persona_name ?? de.name} does?`,
        message: <>They are set up as a <span className="text-dt-body font-medium">{role?.archetype_name ?? current}</span> today.
          A different template changes what they watch and what they are allowed to do.
          Work they have already done is kept.</>,
        confirmLabel: 'Change the role',
        tone: 'primary',
      })) { setBusy(false); return; }
      const res = await applyRoleKitToEmployee(de.id, choice, rerole);
      setDone(res); setOpen(false); onApplied();
    } catch (e) {
      setError(presentError(e, 'Could not apply that role template.'));
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="mt-3 rounded-xl border border-dt-ok-border bg-dt-ok-soft px-3 py-2 text-xs text-dt-ok">
        Applied the {done.archetypeName} template — {done.watchersCreated} watcher{done.watchersCreated === 1 ? '' : 's'},
        {' '}{done.guardrailsCreated} role guardrail{done.guardrailsCreated === 1 ? '' : 's'},
        {' '}{done.systemsInstalled} connected system{done.systemsInstalled === 1 ? '' : 's'}
        {done.sopPlaybookId ? ', and its SOP is published' : ''}.
        {done.watchersSkipped > 0 && (
          <span className="block mt-1 text-dt-muted">
            {done.watchersSkipped} watcher template{done.watchersSkipped === 1 ? '' : 's'} could not be installed and
            {' '}{done.watchersSkipped === 1 ? 'was' : 'were'} skipped — the rest of the kit is in place.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3">
      {!open ? (
        <div className="flex items-center gap-2 flex-wrap">
          {!current && (
            <p className="text-xs text-dt-muted flex-1 min-w-[16rem]">
              No role template applied — this employee has no Book of Work watchers, no standard operating
              procedure and no role guardrails.
            </p>
          )}
          <Button kind="secondary" size="sm" onClick={() => setOpen(true)}>
            {current ? 'Change role template' : 'Apply a role template'}
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-dt-border bg-dt-inset p-3 space-y-2">
          <p className="text-xs text-dt-support">
            A role template installs this employee's Book of Work watchers, a published SOP it follows,
            and the guardrails for that role. Existing work is never deleted.
          </p>
          {kits === null ? (
            <p className="text-xs text-dt-muted">Loading templates…</p>
          ) : (
            <select
              value={choice}
              onChange={e => setChoice(e.target.value)}
              className="bg-dt-card border border-dt-border rounded-lg px-3 py-1.5 text-xs text-dt-support focus:outline-none focus:border-dt-accent w-full"
            >
              <option value="">Choose a role…</option>
              {kits.map(k => (
                <option key={k.key} value={k.key}>
                  {k.name}{k.domain ? ` — ${k.domain}` : ''}{k.key === current ? ' (current)' : ''}
                </option>
              ))}
            </select>
          )}
          {choice && kits && (
            <p className="text-[11px] text-dt-muted">{kits.find(k => k.key === choice)?.description}</p>
          )}
          {error && <p className="text-xs text-dt-danger">{error}</p>}
          <div className="flex items-center gap-2">
            <Button kind="primary" size="sm" onClick={() => void apply()} disabled={!choice || busy}>
              {busy ? 'Applying…' : 'Apply'}
            </Button>
            <Button kind="ghost" size="sm" onClick={() => { setOpen(false); setError(null); }}>Cancel</Button>
          </div>
        </div>
      )}
      {confirmUI}
    </div>
  );
}

function LifetimeLedger({ de, setPage }: { de: DigitalEmployee; setPage: (p: Page) => void }) {
  const [role, setRole] = useState<RoleContext | null>(null);
  const [wp, setWp] = useState<WorkProduct | null>(null);
  const [reloadRole, setReloadRole] = useState(0);
  const name = de.persona_name ?? de.name;

  useEffect(() => {
    let cancelled = false;
    getDeRoleContext(de.id).then(r => !cancelled && setRole(r)).catch(() => !cancelled && setRole(null));
    getDeWorkProduct(de.id).then(w => !cancelled && setWp(w)).catch(() => !cancelled && setWp(null));
    return () => { cancelled = true; };
  }, [de.id, reloadRole]);

  // The employee's operating domains: certified archetype categories first,
  // else the categories it's granted. Falls back to department text.
  const domains: string[] = (role?.archetype_categories?.length ? role.archetype_categories
    : role?.domains ?? []).filter(Boolean);
  const roleName = role?.archetype_name ?? role?.archetype_domain ?? role?.department ?? de.department ?? 'Generalist';
  // Data-driven, not a hardcoded category list: this employee handles
  // conversations iff it actually has any.
  const isConversational = (wp?.conversations.total ?? 0) > 0;

  // Group the action work-product by domain category.
  const byCategory = new Map<string, WorkProduct['actions']>();
  (wp?.actions ?? []).forEach(a => {
    const k = a.category ?? 'other';
    if (!byCategory.has(k)) byCategory.set(k, []);
    byCategory.get(k)!.push(a);
  });
  const catKeys = [...byCategory.keys()].filter(k => k !== 'platform_admin').sort();
  const adminActions = byCategory.get('platform_admin') ?? [];

  return (
    <div className="space-y-5">
      {/* Role header — who this employee is and what it operates */}
      <div className="rounded-2xl border border-dt-border bg-dt-card p-5">
        <p className="text-[11px] uppercase tracking-wide text-dt-muted">Role</p>
        <p className="text-lg font-semibold text-dt-title mt-0.5">{roleName}</p>
        {domains.length > 0 ? (
          <p className="text-xs text-dt-support mt-1">
            Operates: {domains.map(d => domainShort(d)).join(' · ')}
          </p>
        ) : (
          <p className="text-xs text-dt-muted mt-1">No connected systems granted yet — this employee's domain is set by what you give it access to.</p>
        )}
        <RoleTemplatePanel de={de} role={role} onApplied={() => setReloadRole(n => n + 1)} />
      </div>

      {role === null && wp === null
        ? <p className="text-sm text-dt-muted py-8 text-center">Loading this employee's work…</p>
        : (
        <>
          {/* Conversational work-product (support / CRM / product) */}
          {isConversational && wp && (
            <PanelCard title="Cases & conversations">
              <p className="text-xs text-dt-muted mb-3 -mt-1">The customer conversations {name} has handled.</p>
              {wp.conversations.total === 0
                ? <p className="text-sm text-dt-muted py-4 text-center">No conversations handled yet.</p>
                : (
                  <div className="flex flex-wrap gap-4">
                    <StatTile label="Handled" value={String(wp.conversations.total)} />
                    <StatTile label="Resolved" value={String(wp.conversations.resolved)} />
                    <StatTile label="Open" value={String(wp.conversations.open)} />
                    <button onClick={() => setPage('support_inbox')} className="self-center text-xs text-dt-accent-text hover:underline ml-auto">Open in the inbox →</button>
                  </div>
                )}
            </PanelCard>
          )}

          {/* Domain action work-product — grouped by category, labeled generically */}
          {catKeys.length === 0 && adminActions.length === 0 && !isConversational ? (
            <div className="rounded-xl border border-dashed border-dt-border px-4 py-6 text-center">
              <p className="text-sm text-dt-support">{name} hasn't produced domain work-product yet.</p>
              <p className="text-xs text-dt-muted mt-1">As it acts on its connected systems, everything it does appears here — grouped and labeled by the kind of work.</p>
            </div>
          ) : (
            <>
              {catKeys.map(cat => (
                <PanelCard key={cat} title={domainLabel(cat)}>
                  <div className="space-y-1.5">
                    {byCategory.get(cat)!.map((a, i) => (
                      <div key={i} className="flex items-center gap-3 text-sm">
                        <span className="flex-1 text-dt-body">{a.label}</span>
                        <span className="text-xs text-dt-muted whitespace-nowrap">
                          {a.auto_n > 0 && <span className="text-dt-support">{a.auto_n} auto</span>}
                          {a.auto_n > 0 && a.gated_n > 0 && ' · '}
                          {a.gated_n > 0 && <span>{a.gated_n} approved</span>}
                        </span>
                        <span className="w-10 text-right text-sm font-semibold text-dt-title tabular-nums">{a.n}</span>
                      </div>
                    ))}
                  </div>
                </PanelCard>
              ))}
              {/* Platform actions (running DreamTeam itself) shown last + labeled honestly */}
              {adminActions.length > 0 && (
                <PanelCard title="Workforce administration">
                  <p className="text-xs text-dt-muted mb-3 -mt-1">Actions {name} took to set up or run the workforce itself — all human-approved.</p>
                  <div className="space-y-1.5">
                    {adminActions.map((a, i) => (
                      <div key={i} className="flex items-center gap-3 text-sm">
                        <span className="flex-1 text-dt-body">{a.label}</span>
                        <span className="w-10 text-right text-sm font-semibold text-dt-title tabular-nums">{a.n}</span>
                      </div>
                    ))}
                  </div>
                </PanelCard>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Record — the living employment record (Tier-1 surfacing) ──────
// Three datasets the file was sitting on but never showed: evidence-earned
// skills, the run-by-run execution log (which model served each answer —
// the failover, per reply), and the lived-experience ledger.
const relTime = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const isFallbackModel = (m: string | null) => !!m && /bedrock|anthropic\.|openai|gpt|gemini|google/i.test(m);

// Humanize an agentic transcript turn (raw Anthropic content blocks) into
// readable lines — mirrors the Workbench Reasoning humanizer. Never dumps raw
// JSON, thinking signatures, or tool_use ids at the reader.
type TurnLine = { kind: 'thought' | 'action' | 'result' | 'say' | 'error'; text: string };
function humanizeTurn(role: string, content: unknown): TurnLine[] {
  let blocks: unknown = content;
  if (typeof content === 'string') {
    const s = content.trim();
    if (s.startsWith('[') || s.startsWith('{')) { try { blocks = JSON.parse(s); } catch { return [{ kind: 'say', text: s }]; } }
    else return [{ kind: role === 'user' ? 'say' : 'say', text: s }];
  }
  if (!Array.isArray(blocks)) return [];
  const out: TurnLine[] = [];
  for (const b of blocks as Array<Record<string, unknown>>) {
    const t = b?.type;
    if (t === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ kind: 'say', text: b.text.trim() });
    else if (t === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) out.push({ kind: 'thought', text: b.thinking.trim() });
    else if (t === 'tool_use' && typeof b.name === 'string') out.push({ kind: 'action', text: `Called ${String(b.name).replace(/^platform_admin__/, '').replace(/_/g, ' ')}` });
    else if (t === 'tool_result') {
      const isErr = b.is_error === true;
      const c = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map(x => x?.text ?? '').join(' ') : '';
      out.push({ kind: isErr ? 'error' : 'result', text: (isErr ? '' : 'Result: ') + String(c).slice(0, 300) });
    }
  }
  return out;
}
const TURN_STYLE: Record<TurnLine['kind'], string> = {
  thought: 'text-dt-muted italic', action: 'text-dt-accent-text', result: 'text-dt-support',
  say: 'text-dt-body', error: 'text-rose-400',
};
const TURN_TAG: Record<TurnLine['kind'], string> = {
  thought: 'thought', action: 'did', result: 'saw', say: 'said', error: '⚠',
};

// One autonomous run, expandable to its turn-by-turn reasoning transcript.
function AgenticRunRow({ run }: { run: AgenticRun }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<AgenticMessage[] | null>(null);
  const toggle = () => {
    const next = !open; setOpen(next);
    if (next && msgs === null) getAgenticRunMessages(run.id).then(setMsgs).catch(() => setMsgs([]));
  };
  const statusTone: Tone = run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'danger'
    : run.status.startsWith('blocked') ? 'warn' : 'info';
  return (
    <div className="rounded-xl border border-dt-border bg-dt-card">
      <button onClick={toggle} className="w-full text-left px-3.5 py-2.5 flex items-start gap-2">
        <span className={`mt-0.5 text-dt-muted transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-dt-body">{run.goal ?? 'Autonomous task'}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Chip tone={statusTone}>{run.status.replace(/_/g, ' ')}</Chip>
            {run.iteration_count > 0 && <span className="text-[10px] text-dt-muted">{run.iteration_count} step{run.iteration_count === 1 ? '' : 's'}</span>}
            {run.cost_used_cents > 0 && <span className="text-[10px] text-dt-muted">${(run.cost_used_cents / 100).toFixed(2)}</span>}
            <span className="text-[10px] text-dt-faint ml-auto">{relTime(run.created_at)}</span>
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-dt-border px-3.5 py-2.5">
          {msgs === null ? <p className="text-xs text-dt-muted py-2">Loading transcript…</p>
            : msgs.length === 0 ? <p className="text-xs text-dt-muted py-2">No transcript recorded for this run.</p>
            : (
              <div className="space-y-1.5">
                {msgs.flatMap(m => humanizeTurn(m.role, m.content).map((line, li) => (
                  <div key={`${m.id}-${li}`} className="flex gap-2 text-xs">
                    <span className="w-12 shrink-0 text-[10px] text-dt-faint uppercase tracking-wide pt-0.5">{TURN_TAG[line.kind]}</span>
                    <span className={`flex-1 whitespace-pre-wrap break-words ${TURN_STYLE[line.kind]}`}>{line.text}</span>
                  </div>
                )))}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function RecordTab({ de, setPage, openTab }: { de: DigitalEmployee; setPage: (p: Page) => void; openTab: (t: FileTab) => void }) {
  const [runs, setRuns] = useState<DeRun[] | null>(null);
  const [exp, setExp] = useState<DeExperience[] | null>(null);
  const [agentic, setAgentic] = useState<AgenticRun[] | null>(null);
  // Minimal read for the "Answers to" chip — the full Responsible people
  // panel moved to Governance (docs/31 step 9); the record keeps only the
  // one-line answer to "who do I ask about this one?".
  const [primaryName, setPrimaryName] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getDeExecutionLog(de.id, 25).then(r => !cancelled && setRuns(r)).catch(() => !cancelled && setRuns([]));
    getDeExperience(de.id, 40).then(e => !cancelled && setExp(e)).catch(() => !cancelled && setExp([]));
    getDeAgenticRuns(de.id, 15).then(a => !cancelled && setAgentic(a)).catch(() => !cancelled && setAgentic([]));
    import('../../supabase').then(({ supabase }) =>
      supabase.rpc('list_de_assignments', { p_de_id: de.id }).then(({ data, error }) => {
        if (cancelled) return;
        // An error must not render as "Nobody assigned" — that is a claim,
        // not a fallback. On error the chip simply does not appear.
        if (error) return;
        const rows = (data ?? []) as Array<{ relation: string; full_name: string | null; email: string | null }>;
        const p = rows.find(r => r.relation === 'primary');
        setPrimaryName(p ? (p.full_name || p.email || 'Unnamed person') : null);
      })
    ).catch(() => { /* chip stays hidden on failure */ });
    return () => { cancelled = true; };
  }, [de.id]);

  const name = de.persona_name ?? de.name;

  return (
    <div className="space-y-5">
      {/* Skills, KPIs and development live on the Performance tab — the
          Record tab is the evidence of work done. */}

      {/* Who answers for this employee — compact chip; managed on Governance. */}
      {primaryName !== undefined && (
        <button onClick={() => openTab('governance')}
          className="inline-flex items-center gap-2 rounded-full border border-dt-border bg-dt-card px-3 py-1.5 text-xs hover:border-dt-border-strong transition-colors"
          title="Responsible people are managed on the Governance tab">
          <span className="text-dt-muted">Answers to:</span>
          {primaryName
            ? <span className="text-dt-body font-medium">{primaryName}</span>
            : <span className="text-dt-warn">Nobody assigned</span>}
          <span className="text-dt-faint">→ Governance</span>
        </button>
      )}

      {/* The lifetime output ledger opens the record: who this employee is by
          role, and everything it has produced (the old "Work" tab, rehomed). */}
      <LifetimeLedger de={de} setPage={setPage} />

      {/* Autonomous runs — watch it reason through a multi-step task. Always
          rendered: vanishing at zero runs hid that the capability exists. */}
      <PanelCard title="Autonomous runs — how it reasoned through a task">
        <p className="text-xs text-dt-muted mb-3 -mt-1">When {name} works a multi-step goal on its own, every turn of its reasoning and tool use is recorded. Expand any run to read the transcript.</p>
        {agentic === null ? <p className="text-sm text-dt-muted py-6 text-center">Loading runs…</p>
          : agentic.length === 0 ? <p className="text-sm text-dt-muted py-6 text-center">No autonomous runs yet — they appear here the first time {name} works a multi-step goal on its own.</p>
          : (
            <div className="space-y-2">
              {agentic.map(r => <AgenticRunRow key={r.id} run={r} />)}
            </div>
          )}
      </PanelCard>

      {/* Execution log — how each run was actually served */}
      <PanelCard title="Execution log — every answer, and how it was served">
        <p className="text-xs text-dt-muted mb-3 -mt-1">The model that served each run, latency, tokens, confidence, and whether it went to a human. This is the failover made visible, one reply at a time.</p>
        {runs === null ? <p className="text-sm text-dt-muted py-6 text-center">Loading runs…</p>
          : runs.length === 0 ? <p className="text-sm text-dt-muted py-6 text-center">No traced runs yet — they appear here as {name} answers and works.</p>
          : (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs min-w-[560px]">
                <thead>
                  <tr className="text-dt-muted text-left border-b border-dt-border">
                    <th className="py-1.5 pl-1 font-medium">When</th>
                    <th className="py-1.5 font-medium">Work</th>
                    <th className="py-1.5 font-medium">Served by</th>
                    <th className="py-1.5 font-medium text-right">Latency</th>
                    <th className="py-1.5 font-medium text-right">Tokens</th>
                    <th className="py-1.5 font-medium text-right">Conf.</th>
                    <th className="py-1.5 pr-1 font-medium text-right">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r, i) => (
                    <tr key={i} className="border-b border-dt-border">
                      <td className="py-1.5 pl-1 text-dt-support whitespace-nowrap">{relTime(r.started_at)}</td>
                      <td className="py-1.5 text-dt-body">{r.name === 'chat de-answer' ? 'Answered a question' : r.name === 'invoke_agent de-work' ? `Worked a task${r.turns ? ` (${r.turns} steps)` : ''}` : r.name}</td>
                      <td className="py-1.5">
                        {r.model
                          ? <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono ${isFallbackModel(r.model) ? 'bg-dt-accent-soft text-dt-accent-text' : 'bg-dt-inset text-dt-support'}`}>{r.model.replace(/^(us\.)?anthropic\./, '').replace(/-v1:0$/, '')}</span>
                          : <span className="text-dt-faint">—</span>}
                      </td>
                      <td className="py-1.5 text-right text-dt-support whitespace-nowrap">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                      <td className="py-1.5 text-right text-dt-support">{(r.input_tokens ?? 0) + (r.output_tokens ?? 0) || '—'}</td>
                      <td className="py-1.5 text-right text-dt-support">{r.confidence != null ? `${r.confidence}%` : '—'}</td>
                      <td className="py-1.5 pr-1 text-right">
                        {r.escalated ? <Chip tone="warn">escalated</Chip>
                          : r.work_status === 'done' ? <Chip tone="ok">done</Chip>
                          : r.confidence != null ? <Chip tone="ok">answered</Chip>
                          : <span className="text-dt-faint text-[10px]">{r.work_status ?? '—'}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </PanelCard>

      {/* Experience ledger — what the employee has done and learned */}
      <PanelCard title="Experience — what this employee has done">
        <p className="text-xs text-dt-muted mb-3 -mt-1">Each entry is a real action or decision, kept with a link back to the evidence that produced it. This is the record that makes an employee worth keeping — and impossible to export.</p>
        {exp === null ? <p className="text-sm text-dt-muted py-6 text-center">Loading…</p>
          : exp.length === 0 ? (
            <div className="rounded-xl border border-dashed border-dt-border px-4 py-6 text-center">
              <p className="text-sm text-dt-support">{name} hasn't logged real-world experience yet.</p>
              <p className="text-xs text-dt-muted mt-1">Experience accrues as {name} executes actions on connected systems — each success or human-gated decision is recorded here with its evidence. It fills as the work happens.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {exp.map(e => {
                const f = e.fact_summary ?? {};
                return (
                  <div key={e.id} className="relative pl-4 border-l-2 border-dt-border">
                    <span className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-dt-accent" />
                    <div className="flex items-center gap-2 flex-wrap">
                      {e.category && <Chip tone="neutral">{e.category.replace(/_/g, ' ')}</Chip>}
                      {e.from_action && <span className="text-[10px] text-dt-muted">from an action it took</span>}
                      {e.from_evidence && <span className="text-[10px] text-dt-muted">from an evidence run</span>}
                      <span className="text-[10px] text-dt-faint ml-auto">{relTime(e.created_at)}</span>
                    </div>
                    {f.what_happened && <p className="text-xs text-dt-body mt-1">{f.what_happened}</p>}
                    <div className="flex items-center gap-3 mt-0.5 text-[11px]">
                      {f.decision_made && <span className="text-dt-support">{f.decision_made}</span>}
                      {f.outcome && <span className="text-dt-muted">· {f.outcome}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </PanelCard>

      {/* Incidents — the disciplinary half of the employment record (moved in
          from the Governance section; the records-gate banner has always
          pointed at "Record → Incidents", and now that is true). */}
      <DeIncidentsPanel de={de} setPage={setPage} />
    </div>
  );
}

// ── The page ──────────────────────────────────────────────────────

export default function EmployeeFilePage({ setPage }: { setPage: (p: Page) => void }) {
  const deId = useEmployeeFileDeId();
  const location = useLocation();
  const navigate = useNavigate();
  const { currentTenant } = useAuth();
  const [des, setDes] = useState<DigitalEmployee[] | null>(null);
  const [health, setHealth] = useState<DEHealth | null>(null);
  // mig 258 records gate — why this employee's autonomy is clamped, if it is.
  const [gate, setGate] = useState<{ gated: boolean; reasons: string[] } | null>(null);
  // ?tab= deep link (docs/32 report 03): read ONCE on mount alongside ?de=,
  // whitelisted against the tab set — never trust the URL to open a section.
  // An unknown or denied key falls back to the default (Work).
  const [tab, setTab] = useState<FileTab>(() => {
    const raw = new URLSearchParams(location.search).get('tab');
    const t = raw ? (TAB_ALIASES[raw] ?? raw) : null;
    // ⚠ WHITELIST AGAINST THE MEMBERS, NOT THE FOUR GROUP KEYS. FILE_TABS is
    // now the four visible groups, so checking it here rejected every link to
    // a key that became a member — ?tab=trust, ?tab=profile, ?tab=governance,
    // ?tab=workbench — and silently dropped them all onto Work. That is the
    // exact "stale links landing nowhere" TAB_ALIASES exists to prevent, and
    // the collapse to four reintroduced it one comment below the warning.
    return t && TAB_GROUPS.some(g => g.members.includes(t as FileTab)) ? (t as FileTab) : 'today';
  });
  // Tab clicks mirror into ?tab= with replace (no back-button tab history).
  // Same-tick navigate + URLSync's pathname-only reconciliation means the
  // query is never stripped (the employeeFileRoute pattern).
  const selectTab = (k: FileTab) => {
    setTab(k);
    const params = new URLSearchParams(location.search);
    params.set('tab', k);
    navigate(`${EMPLOYEE_FILE_PATH}?${params.toString()}`, { replace: true });
  };
  const onDeUpdated = (updated: DigitalEmployee) =>
    setDes(prev => (prev ?? []).map(d => (d.id === updated.id ? updated : d)));

  useEffect(() => {
    let cancelled = false;
    // Include retired/archived so their file links (from timelines, records, etc.) still open.
    listDigitalEmployees(true).then(d => { if (!cancelled) setDes(d); }).catch(() => { if (!cancelled) setDes([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!deId) return;
    let cancelled = false;
    listDeHealth().then(h => { if (!cancelled) setHealth(h.find(x => x.de_id === deId) ?? null); }).catch(() => undefined);
    import('../../supabase').then(({ supabase }) =>
      supabase.rpc('get_de_gate_status', { p_de_id: deId }).then(({ data }) => {
        if (!cancelled && data?.ok) setGate({ gated: !!data.gated, reasons: (data.reasons ?? []) as string[] });
      })
    ).catch(() => undefined);
    return () => { cancelled = true; };
  }, [deId]);

  if (des === null) return <div className="p-6"><p className="text-sm text-dt-muted py-8 text-center">Loading employee…</p></div>;

  const de = deId ? des.find(d => d.id === deId) : undefined;
  if (!de) {
    return (
      <div className="p-6">
        <EmptyState icon="🪪" headline="No employee selected"
          action={<Button kind="primary" onClick={() => setPage('workforce_des')}>Open the roster</Button>}>
          This page shows one digital employee's file — reach it from the Roster, Performance, or Command Centre by clicking an employee.
        </EmptyState>
      </div>
    );
  }

  const name = de.persona_name ?? de.name;
  const healthMeta = health ? DE_HEALTH_LABELS[health.state] : null;
  const activeTab: FileTab = tab;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div>
        <Button kind="ghost" size="sm" onClick={() => setPage('workforce_des')}>← Workforce roster</Button>
      </div>

      <div className="flex items-start gap-4 flex-wrap">
        <div className="w-14 h-14 rounded-2xl bg-dt-accent-soft border border-dt-border flex items-center justify-center text-2xl shrink-0">
          {de.icon ?? name.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold text-dt-title truncate">{name}</h1>
          <p className="text-sm text-dt-support mt-0.5">{de.name !== name ? `${de.name} · ` : ''}{de.department} · {de.category}</p>
          <p className="text-xs text-dt-muted mt-1 max-w-2xl">{de.description}</p>
          {/* docs/17 C6 — the dossier line (Reznikov design language, dt tokens). */}
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-dt-muted mt-2">
            FILE {de.id.slice(0, 8)}{de.department ? ` · ${de.department}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {(() => { const w = say(DE_STATUS, de.status); return <Chip tone={w.tone} dot pulse={de.status === 'active'} title={w.means}>{w.label}</Chip>; })()}
          <Chip tone={TRUST_TONE[de.trust_level] ?? 'neutral'}>{de.trust_level}</Chip>
          {healthMeta && <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${healthMeta.color}`}>{healthMeta.label}</span>}
          {gate?.gated && <Chip tone="warn">records gate</Chip>}
        </div>
      </div>

      {/* mig 258 — the records gate, explained where the record lives. */}
      {gate?.gated && (
        <div className="rounded-xl border border-dt-warn-border bg-dt-warn-soft px-4 py-3">
          <p className="text-xs font-medium text-dt-warn">
            Autonomy is gated by {name}'s employment record — every answer and action is routed to a human until it's resolved.
          </p>
          <ul className="mt-1 text-xs text-dt-warn space-y-0.5">
            {gate.reasons.map(r => (
              <li key={r}>
                · {r === 'stale_certification' ? 'Certification is stale — the configuration changed after the last exam. Re-run the certification exam to refresh it.'
                  : r === 'failed_certification' ? 'The last certification exam was failed. A passing exam restores autonomy.'
                  : r === 'expired_certification' ? 'A governance certification has expired. Re-issue or re-certify to restore autonomy.'
                  : r === 'open_critical_incident' ? 'An open critical incident is on this employee’s record. Review and close it (Record → Incidents) to restore autonomy.'
                  : r === 'degraded_metrics' ? 'Recent run error rate is elevated (over the last 56 days). Autonomy restores automatically as new runs succeed.'
                  : r === 'metrics_check_unavailable' ? 'The performance check could not run; autonomy is paused conservatively until it recovers.'
                  : r}
              </li>
            ))}
          </ul>
        </div>
      )}

      <TabBar
        tabs={FILE_TABS}
        active={groupOf(activeTab).key} onSelect={selectTab} />

      {groupOf(activeTab).key === 'today' && (
        <>
          <WorkTab de={de} setPage={setPage} />
          <DeWorkbenchPanel deId={de.id} />
        </>
      )}
      {groupOf(activeTab).key === 'performance' && (currentTenant?.id
        ? <PerformanceTab de={de} tenantId={currentTenant.id} />
        : <p className="text-sm text-dt-muted py-8 text-center">Performance needs a live workspace.</p>)}
      {groupOf(activeTab).key === 'operating' && (
        <>
          <OperatingModelPanel de={de} setPage={setPage} />
          <DeProfileSections de={de} section="profile" setPage={setPage} onUpdated={onDeUpdated} />
          <DeProfileSections de={de} section="trust" setPage={setPage} onUpdated={onDeUpdated} />
        </>
      )}
      {groupOf(activeTab).key === 'record' && (
        <>
          <RecordTab de={de} setPage={setPage} openTab={selectTab} />
          <DeProfileSections de={de} section="governance" setPage={setPage} onUpdated={onDeUpdated} />
        </>
      )}
    </div>
  );
}
