import { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useVocabulary } from '../../lib/vocabulary';
import type { Page } from '../../types';
import GettingStartedGuide from '../../components/GettingStartedGuide';
import OpsAlertsBanner from '../../components/OpsAlertsBanner';
import TeamMissionPanel from '../../components/TeamMissionPanel';
import { StatTile, PanelCard, Chip, Button, EmptyState, DecisionCard, SetupChecklist } from '../../design/primitives';
import {
  listAccounts, listTickets, listHumanTasks, listActivity,
  fmtMoneyK, CustomerApiError,
} from '../../lib/customerApi';
import type { CustomerAccount, SupportTicket, DBHumanTask, ActivityEvent } from '../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveErrorNotice } from '../../components/LiveDataStates';
import { getActiveWorkAcrossDes, countDeOutputs, type ActiveWorkRow } from '../../lib/deWorkbenchApi';
import { getDeInquiryMetrics, getDeActionMetrics, getDeCostMetricsRanged, getOutcomeMetering } from '../../lib/api';
import { summariseWork, type WorkSummary } from '../../lib/workSummary';
import { listDigitalEmployees, type DigitalEmployee } from '../../lib/digitalEmployeesApi';
import { useOpenEmployeeFile } from '../../lib/employeeFileRoute';
import { presentError } from '../../lib/presentError';

// ⚠ The preview command centre's scaffolding was DELETED 2026-08-22, all
// verified zero-reader by `tsc --noUnusedLocals`:
//
//   HealthConfig/DEFAULT_HEALTH_CONFIG   thresholds for a health badge the
//        live page does not render. The live thresholds live in the DB.
//   EntityData/OutcomeData/TaskItem/ActivityItem   the four seeded row
//        shapes. Live rows come typed from customerApi.
//   healthDot/healthLabel/healthLabelColor, trendIcon/trendLabel/trendColor
//        colour+word maps for those seeded rows. Zero call sites.
//   EntityHealth/OutcomeTrend            their union types, now unreferenced.
//
// Also removed: `getPendingKnowledgeGapCount()`, which sat in the BLOCKING
// Promise.all and whose result was stored in state and never rendered — a
// round-trip per dashboard load that bought nothing and could fail the whole
// page for a number nobody could see. And `renewalsDue`, computed and never
// shown. Neither is displayed anywhere on this screen; if the front page
// should carry a gap or renewal count, that is a tile to design, not a
// variable to keep warm. `listInvoices()` went with renewalsDue — it was
// that variable's only reader, so the dashboard was fetching every invoice
// on load to compute a number it never showed. Recoverable at 571868e.
//
// ⚠ TaskType/ActivityType below are NOT part of that — taskBadgeStyle,
// taskBadgeLabel, activityDotColor and activityBorderColor all still read
// them for live rows.

type TaskType = 'approval_gate' | 'review_gate' | 'escalation' | 'override' | 'training_feedback' | 'trust_promotion' | 'trust_demotion_notice' | 'checklist' | 'knowledge_revision' | 'inquiry_review' | 'action_approval';
type ActivityType = 'resolved' | 'escalated' | 'kb_gap' | 'error';


// ── Helpers ──────────────────────────────────────────────────────

function taskBadgeStyle(type: TaskType): string {
  if (type === 'approval_gate') return 'bg-dt-accent-soft text-dt-accent-text';
  if (type === 'review_gate') return 'bg-dt-info-soft text-dt-info';
  if (type === 'escalation') return 'bg-dt-danger-soft text-dt-danger';
  if (type === 'override') return 'bg-dt-warn-soft text-dt-warn';
  if (type === 'knowledge_revision') return 'bg-dt-warn-soft text-dt-warn';
  if (type === 'inquiry_review') return 'bg-dt-info-soft text-dt-info';
  // fuchsia: non-core hue, same task-type identity already sanctioned in doc
  // §7 for the identical 'action_approval' badge in HumanTasksPage.tsx —
  // reused here for consistency, made opaque.
  if (type === 'action_approval') return 'bg-fuchsia-600 text-fuchsia-100';
  return 'bg-dt-border-strong text-dt-title';
}

function taskBadgeLabel(type: TaskType): string {
  if (type === 'approval_gate') return 'APPROVAL';
  if (type === 'review_gate') return 'REVIEW';
  if (type === 'escalation') return 'ESCALATION';
  if (type === 'override') return 'OVERRIDE';
  if (type === 'knowledge_revision') return 'KNOWLEDGE';
  if (type === 'inquiry_review') return 'INQUIRY';
  if (type === 'action_approval') return 'ACTION';
  return 'FEEDBACK';
}

function activityDotColor(type: ActivityType): string {
  if (type === 'resolved') return 'bg-emerald-400';
  if (type === 'escalated') return 'bg-amber-400';
  if (type === 'kb_gap') return 'bg-blue-400';
  return 'bg-red-400';
}

function activityBorderColor(type: ActivityType): string {
  if (type === 'resolved') return 'border-l-emerald-500';
  if (type === 'escalated') return 'border-l-amber-500';
  if (type === 'kb_gap') return 'border-l-blue-500';
  return 'border-l-red-500';
}

// ── LIVE dashboard: KPIs and cards computed from real data ───────

function liveActivityAge(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function LiveDashboard({ setPage }: { setPage: (p: Page) => void }) {
  const { liveTenantName, currentTenant, authedUser } = useAuth();
  const vocab = useVocabulary();
  const openFile = useOpenEmployeeFile(setPage);
  const [working, setWorking] = useState<ActiveWorkRow[]>([]);
  const [workforce, setWorkforce] = useState<DigitalEmployee[]>([]);
  // The same four sources, summarised by the same function, as the roster
  // and the Results tab. The front page must not tell a different story
  // from the page it links to.
  const [work, setWork] = useState<Record<string, WorkSummary>>({});
  const [accounts, setAccounts] = useState<CustomerAccount[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [tasks, setTasks] = useState<DBHumanTask[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [a, t, h, ev] = await Promise.all([
          listAccounts(), listTickets(), listHumanTasks(), listActivity(10),
        ]);
        if (cancelled) return;
        setAccounts(a); setTickets(t); setTasks(h); setActivity(ev);
        setMissingTables(false);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof CustomerApiError && err.missingTables) {
          setMissingTables(true);
        } else {
          console.error('LiveDashboard:', err);
          setLoadError(presentError(err, 'Something went wrong loading your dashboard.'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [retryTick]);

  // "Working now" strip — separate, best-effort load so a hiccup here can
  // never take down the whole dashboard.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([getActiveWorkAcrossDes(), listDigitalEmployees()])
      .then(async ([w, d]) => {
        if (cancelled) return;
        setWorking(w); setWorkforce(d);
        const tid = currentTenant?.id ?? null;
        if (!tid) return;
        // Supplementary: a failure here costs the headline sentence, not the page.
        const [inq, act, cost, om] = await Promise.all([
          getDeInquiryMetrics(tid, 30), getDeActionMetrics(tid, 30),
          getDeCostMetricsRanged(tid, 30), getOutcomeMetering(tid, 30),
        ]);
        const iBy = new Map(inq.map(x => [x.de_id, x]));
        const aBy = new Map(act.map(x => [x.de_id, x]));
        const cBy = new Map(cost.map(x => [x.de_id, x]));
        const mBy = new Map((om?.by_de ?? []).map(x => [x.de_id, x]));
        const ids = new Set([...iBy.keys(), ...aBy.keys(), ...cBy.keys(), ...mBy.keys(), ...d.map(x => x.id)]);
        const outs = new Map<string, { items_done?: number; deliverables?: number }>();
        await Promise.all([...ids].map(async id => { try { outs.set(id, await countDeOutputs(id, 30)); } catch { /* per-employee */ } }));
        if (cancelled) return;
        const next: Record<string, WorkSummary> = {};
        for (const id of ids) next[id] = summariseWork({ inquiry: iBy.get(id), action: aBy.get(id), cost: cBy.get(id), metering: mBy.get(id), outputs: outs.get(id) });
        setWork(next);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [retryTick, currentTenant?.id]);

  const openTickets = tickets.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const atRisk = accounts.filter(a => a.status === 'at_risk' || a.health_score < 45).length;
  const pendingTasks = tasks.filter(t => t.status === 'pending').length;
  const arrCents = accounts.reduce((s, a) => s + a.arr_cents, 0);

  // What the workforce actually did, from the same four sources the roster
  // and the Results tab read. Totals only — per-employee lives on the roster.
  // ⚠ SCOPED TO THE CURRENT WORKFORCE, not to every id the metrics mention.
  // Summing Object.values(work) counts RETIRED employees too — they keep
  // their history — and the front page then said 272 where the Results tab
  // said 267. Two screens, same window, different total, five apart. Found
  // only by reading one and then the other.
  const totals = workforce.reduce(
    (t, de) => {
      const w = work[de.id];
      return w ? { work: t.work + w.work, resolutions: t.resolutions + w.resolutions, handedOff: t.handedOff + w.handedOff } : t;
    },
    { work: 0, resolutions: 0, handedOff: 0 },
  );
  const hasWorkforce = workforce.length > 0;
  const hasWork = totals.work > 0;

  const activityEventToType = (e: ActivityEvent): ActivityType =>
    e.event_type === 'resolved' || e.event_type === 'approval' ? 'resolved'
    : e.event_type === 'escalated' ? 'escalated'
    : e.event_type === 'kb_gap' ? 'kb_gap'
    : e.event_type === 'error' ? 'error'
    : 'kb_gap';

  return (
    <div className="p-6 flex flex-col gap-6 text-dt-body">

        {/* Operational alerts. Renders nothing when there are none — this is
            above the fold precisely because the alert it exists to show
            ("digital employees have stopped answering") went unread for four
            days while sitting in a table no screen displayed. */}
        <OpsAlertsBanner />

        {/* Top bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-dt-title">{liveTenantName || 'Your company'}</h1>
            <Chip tone="ok" dot pulse>LIVE</Chip>
            <span className="text-xs text-dt-muted">Real workspace data</span>
          </div>
          <Button kind="ghost" size="sm" onClick={() => window.location.reload()} aria-label="Refresh">↻</Button>
        </div>

        {/* Always-available getting-started guide (dismissible, reopenable) */}
        <GettingStartedGuide setPage={setPage} tenantId={currentTenant?.id} />

        {loading ? (
          <LiveLoadingSkeleton rows={6} />
        ) : loadError ? (
          <LiveErrorNotice message={loadError} onRetry={() => setRetryTick((n) => n + 1)} />
        ) : missingTables ? (
          <MissingTablesNotice />
        ) : (
          <>
            {/* The answer to the page's one question, in a sentence. */}
            {!hasWorkforce ? (
              <SetupChecklist
                title={`Welcome${authedUser?.name ? ', ' + authedUser.name.split(' ')[0] : ''}`}
                why="You don't have anyone working yet. Three steps and someone can be answering your customers today."
                items={[
                  { label: 'Hire your first digital employee — describe the job in plain English' },
                  { label: 'Teach them about your business — point us at your website and we read it' },
                  { label: 'Put them on your website — one line of code' },
                ]}
                action={<Button kind="primary" size="sm" onClick={() => setPage('workforce_des')}>Hire your first employee</Button>}
                estimate="about 2 minutes to start"
              />
            ) : (
              <div>
                <p className="text-[17px] text-dt-title font-semibold">
                  {hasWork
                    ? `Your team handled ${totals.work} piece${totals.work === 1 ? '' : 's'} of work in the last 30 days${
                        totals.handedOff > 0 ? ` and brought ${totals.handedOff} to you` : ' without needing you once'}.`
                    : 'Your team has not recorded any work in the last 30 days.'}
                </p>
                {hasWork && (
                  <div className="grid grid-cols-dt-kpis gap-dt mt-3">
                    <StatTile label="handled, 30 days" value={totals.work} />
                    {totals.resolutions > 0 && <StatTile label="finished without you" value={totals.resolutions} tone="ok" />}
                    {totals.handedOff > 0 && <StatTile label="came to you" value={totals.handedOff} tone="warn" />}
                  </div>
                )}
              </div>
            )}

            {/* ── Waiting on you — at the TOP, and actionable ──────────────
                Pending approvals used to appear twice: as a number in a tile
                and as a table at the bottom, and neither could be acted on.
                One block now, first thing, with the decision on the row. */}
            {pendingTasks === 0 ? (
              <PanelCard>
                <div className="flex items-center gap-3">
                  <span className="text-dt-ok text-lg" aria-hidden>✓</span>
                  <div>
                    <p className="text-[15px] font-semibold text-dt-title">Nothing needs you right now</p>
                    <p className="text-[13px] text-dt-support mt-0.5">Everyone is working. Anything that stops will appear here.</p>
                  </div>
                </div>
              </PanelCard>
            ) : (
              <PanelCard
                title={`${pendingTasks} thing${pendingTasks === 1 ? '' : 's'} waiting on your decision`}
                actions={<Button kind="primary" size="sm" onClick={() => setPage('ops_human_tasks')}>Review all {pendingTasks}</Button>}>
                <div className="space-y-3">
                  {tasks.filter(t => t.status === 'pending').slice(0, 3).map(task => (
                    <DecisionCard
                      key={task.id}
                      title={task.title}
                      detail={task.detail ? <span className="line-clamp-3">{task.detail}</span> : undefined}
                      meta={`Waiting ${liveActivityAge(task.created_at).replace(' ago', '')} · ${taskBadgeLabel(task.type)}`}
                      actions={<Button kind="secondary" size="sm" onClick={() => setPage('ops_human_tasks')}>Open it</Button>}
                    />
                  ))}
                  {pendingTasks > 3 && (
                    <p className="text-[13px] text-dt-muted">and {pendingTasks - 3} more.</p>
                  )}
                </div>
              </PanelCard>
            )}

            {/* Working now — the live per-employee strip: who is mid-task,
                one click into their Employee File (Phase B legibility). */}
            <PanelCard title="Working now"
              badge={working.length > 0 ? <Chip tone="info" dot pulse>{working.length} active</Chip> : undefined}
              actions={<Button kind="ghost" size="sm" onClick={() => setPage('ops_de_activity')}>See everyone →</Button>}>
              {working.length === 0 ? (
                <p className="text-xs text-dt-muted">
                  No employee is mid-task at this second. Watchers, playbook triggers, and the support inbox start work
                  automatically — the moment something is running, it shows up here with a link to that employee's file.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {[...new Set(working.map(w => w.de_id))].map(deId => {
                    const de = workforce.find(d => d.id === deId);
                    const items = working.filter(w => w.de_id === deId);
                    const running = items.filter(i => i.status === 'running').length;
                    const waiting = items.filter(i => i.status === 'waiting_human').length;
                    const name = de?.persona_name ?? de?.name ?? 'Employee';
                    return (
                      <button key={deId} onClick={() => openFile(deId)}
                        className="text-left rounded-xl border border-dt-border bg-dt-page p-3 hover:border-dt-border-strong transition-colors">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="w-7 h-7 rounded-lg bg-dt-accent-soft flex items-center justify-center text-sm">{de?.icon ?? name.charAt(0)}</span>
                          <span className="text-sm font-medium text-dt-title truncate">{name}</span>
                          {running > 0 && <Chip tone="info" dot pulse>{running} running</Chip>}
                          {waiting > 0 && <Chip tone="warn">{waiting} waiting on you</Chip>}
                        </div>
                        <p className="text-xs text-dt-support truncate">{items[0].title}</p>
                      </button>
                    );
                  })}
                </div>
              )}
            </PanelCard>

            {/* Missions front door (founder decision #1, 2026-08-10): orders are
                given HERE, so mission creation lives here — docs/31 found the
                fully-wired mission engine had 0 uses ever because creation was
                buried inside individual employee files. Same panel as the DE
                Activity board; per-employee missions stay on each file. */}
            <TeamMissionPanel />

            {/* Customer entity card */}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-dt-muted mb-3">
                Who we serve
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-xl border border-dt-border bg-dt-card p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-dt-support text-sm">◎</span>
                      <span className="text-sm font-semibold text-dt-title">{vocab.party_singular} Lifecycle</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Chip tone={atRisk > 0 ? 'warn' : 'ok'} dot>{atRisk > 0 ? 'Attention' : 'Healthy'}</Chip>
                      <button
                        onClick={() => setPage('entity_customer')} aria-label={`Open ${vocab.party_singular} Lifecycle`}
                        className="w-6 h-6 rounded-md bg-dt-panel text-dt-support hover:text-dt-title hover:bg-dt-inset flex items-center justify-center text-xs transition-colors"
                      >
                        →
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-dt-support">
                    <span className="text-dt-muted text-[10px]">{vocab.value_metric} under management: </span>
                    <span className="text-dt-body font-medium">{fmtMoneyK(arrCents)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPage('entity_customer_support')}
                      className="flex-1 text-xs text-dt-accent-text hover:brightness-110 bg-dt-accent-soft rounded-lg px-2 py-1.5 text-left transition-colors"
                    >
                      {openTickets} open ticket{openTickets === 1 ? '' : 's'} ↗
                    </button>
                    {pendingTasks > 0 && (
                      <button
                        onClick={() => setPage('ops_human_tasks')}
                        className="text-xs text-dt-warn bg-dt-warn-soft hover:brightness-110 rounded-lg px-2 py-1.5 whitespace-nowrap transition-colors"
                      >
                        {pendingTasks} waiting on you
                      </button>
                    )}
                  </div>
                </div>

              </div>
            </div>

            {/* Bottom row — Human Tasks + Live Activity */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <PanelCard className="lg:col-span-3" title={`Human tasks — ${pendingTasks} pending`}
                actions={<Button kind="ghost" size="sm" onClick={() => setPage('ops_human_tasks')}>View all →</Button>}>
                {tasks.length === 0 ? (
                  <EmptyState headline="No tasks yet">DE decisions requiring a human will show up here.</EmptyState>
                ) : (
                  <div className="space-y-1">
                    {tasks.slice(0, 6).map(task => (
                      <div key={task.id} className="grid grid-cols-[100px_1fr_60px_24px] gap-2 items-center px-2 py-2 rounded-lg hover:bg-dt-panel transition-colors">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded w-fit ${taskBadgeStyle(task.type)}`}>
                          {taskBadgeLabel(task.type)}
                        </span>
                        <div className="min-w-0 flex items-center gap-1.5">
                          <div className="min-w-0">
                            <div className="text-xs text-dt-body truncate">{task.title}</div>
                            {task.detail && <div className="text-[10px] text-dt-muted">{task.detail}</div>}
                          </div>
                          {task.status === 'approved' && <Chip tone="ok" className="flex-shrink-0">Approved</Chip>}
                          {task.status === 'rejected' && <Chip tone="danger" className="flex-shrink-0">Rejected</Chip>}
                        </div>
                        <span className="text-xs text-dt-muted">{liveActivityAge(task.created_at).replace(' ago', '')}</span>
                        <button
                          onClick={() => setPage('ops_human_tasks')} aria-label="Open human tasks"
                          className="w-6 h-6 rounded bg-dt-panel text-dt-muted hover:text-dt-title flex items-center justify-center text-xs transition-colors"
                        >
                          →
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </PanelCard>

              <PanelCard className="lg:col-span-2" title="Live activity">
                {activity.length === 0 ? (
                  <EmptyState headline="No activity yet." />
                ) : (
                  <div className="space-y-1">
                    {activity.map(item => {
                      const t = activityEventToType(item);
                      return (
                        <div
                          key={item.id}
                          className={`flex items-start gap-2.5 px-2 py-2 rounded-lg border-l-2 ${activityBorderColor(t)} hover:bg-dt-panel transition-colors`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${activityDotColor(t)}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-dt-body leading-snug">{item.text}</div>
                            <div className="text-xs text-dt-muted mt-0.5">{item.actor} · {liveActivityAge(item.created_at)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </PanelCard>
            </div>
          </>
        )}
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────

export default function DashboardPage(props: {
  setPage: (p: Page) => void;
  tenant?: any;
  user?: any;
  page?: Page;
  accentColor?: string;
}) {
  return <LiveDashboard setPage={props.setPage} />;
}

