import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useVocabulary } from '../../lib/vocabulary';
import { loadChatEscalations, chatEscalationAge } from '../../lib/chatEscalations';
import type { ChatEscalation } from '../../lib/chatEscalations';
import type { Page } from '../../types';
import GettingStartedGuide from '../../components/GettingStartedGuide';
import { StatTile, PanelCard, Chip, Button, EmptyState } from '../../design/primitives';
import {
  listAccounts, listTickets, listInvoices, listHumanTasks, listActivity,
  getPendingKnowledgeGapCount, fmtMoneyK, CustomerApiError,
} from '../../lib/customerApi';
import type { CustomerAccount, SupportTicket, RenewalInvoice, DBHumanTask, ActivityEvent } from '../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveErrorNotice } from '../../components/LiveDataStates';
import { getActiveWorkAcrossDes, type ActiveWorkRow } from '../../lib/deWorkbenchApi';
import { listDigitalEmployees, type DigitalEmployee } from '../../lib/digitalEmployeesApi';
import { useOpenEmployeeFile } from '../../lib/employeeFileRoute';

// ── Health config ────────────────────────────────────────────────

interface HealthConfig {
  confidence_amber: number;
  confidence_red: number;
  escalation_amber: number;
  escalation_red: number;
  staleness_amber: number;
  staleness_red: number;
  error_rate_amber: number;
  error_rate_red: number;
}

const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  confidence_amber: 70,
  confidence_red: 50,
  escalation_amber: 20,
  escalation_red: 35,
  staleness_amber: 30,
  staleness_red: 60,
  error_rate_amber: 5,
  error_rate_red: 15,
};

// ── Company seed data ────────────────────────────────────────────

type EntityHealth = 'active' | 'degraded' | 'at_risk' | 'offline';
type OutcomeTrend = 'up' | 'stable' | 'warn' | 'alert';
type TaskType = 'approval_gate' | 'review_gate' | 'escalation' | 'override' | 'training_feedback' | 'trust_promotion' | 'trust_demotion_notice' | 'checklist' | 'knowledge_revision' | 'inquiry_review' | 'action_approval';
type ActivityType = 'resolved' | 'escalated' | 'kb_gap' | 'error';

interface EntityData {
  label: string;
  icon: string;
  des: string[];
  metric: string;
  metricPage: Page;
  health: EntityHealth;
  humanTasks: number;
  legacy: string[];
  subPage: Page;
}

interface OutcomeData {
  label: string;
  icon: string;
  metric: string;
  trend: OutcomeTrend;
  page: Page;
  legacy: string[];
  alerts?: number;
}

interface TaskItem {
  id: string;
  type: TaskType;
  title: string;
  de: string;
  detail: string;
  age: string;
  urgent: boolean;
}

interface ActivityItem {
  type: ActivityType;
  time: string;
  text: string;
  confidence?: number;
}

interface CompanyData {
  entities: {
    customer: EntityData;
    vendor: EntityData;
    workforce: EntityData;
  };
  outcomes: {
    revenue: OutcomeData;
    delivery: OutcomeData;
    financial: OutcomeData;
    risk: OutcomeData;
  };
  tasks: TaskItem[];
  activity: ActivityItem[];
}

const COMPANY_DATA: Record<'tcp' | 'pwc', CompanyData> = {
  tcp: {
    entities: {
      customer: {
        label: 'Customer Lifecycle', icon: '◎',
        des: ['Alex', 'Casey'],
        metric: '47 open tickets', metricPage: 'entity_customer_support',
        health: 'active', humanTasks: 4,
        legacy: ['Customer Support', 'Sales', 'Customer Success', 'Account Mgmt'],
        subPage: 'entity_customer',
      },
      vendor: {
        label: 'Vendors & Partners', icon: '◈',
        des: [],
        metric: 'No DE assigned', metricPage: 'entity_vendor',
        health: 'degraded', humanTasks: 0,
        legacy: ['Procurement', 'Vendor Management'],
        subPage: 'entity_vendor',
      },
      workforce: {
        label: 'Our People', icon: '◉',
        des: ['Riley'],
        metric: '2 open roles', metricPage: 'entity_workforce_talent',
        health: 'active', humanTasks: 1,
        legacy: ['Human Resources', 'People & Culture'],
        subPage: 'entity_workforce',
      },
    },
    outcomes: {
      revenue: { label: 'Revenue & Growth', icon: '↑', metric: '$2.1M pipeline', trend: 'up', page: 'outcome_revenue', legacy: ['Sales', 'Marketing'] },
      delivery: { label: 'Product & Engineering', icon: '◧', metric: '3 releases planned', trend: 'stable', page: 'outcome_delivery', legacy: ['Engineering', 'Product', 'QA'] },
      financial: { label: 'Financial Health', icon: '$', metric: '$248K AR outstanding', trend: 'warn', page: 'outcome_financial', legacy: ['Finance', 'Accounting'] },
      risk: { label: 'Risk Posture', icon: '◬', metric: '2 compliance alerts', trend: 'alert', page: 'outcome_risk', legacy: ['Legal', 'Security', 'Compliance'], alerts: 2 },
    },
    tasks: [
      { id: 't1', type: 'approval_gate', title: 'Invoice approval — Meridian Group', de: 'Casey', detail: '$15,600', age: '8 min', urgent: true },
      { id: 't2', type: 'escalation', title: 'Complex bug — API auth failure', de: 'Alex', detail: 'Apex Systems', age: '23 min', urgent: true },
      { id: 't3', type: 'review_gate', title: 'KB article review — Rate limiting guide', de: 'Alex', detail: '', age: '1 hr', urgent: false },
      { id: 't4', type: 'approval_gate', title: 'Contract renewal — Harbor Tech', de: 'Casey', detail: '$67,000', age: '2 hrs', urgent: false },
      { id: 't5', type: 'training_feedback', title: 'DE response flagged for review', de: 'Riley', detail: '', age: '3 hrs', urgent: false },
    ],
    activity: [
      { type: 'resolved', time: '2 min ago', text: 'Alex resolved — "How do I reset 2FA?"', confidence: 94 },
      { type: 'escalated', time: '8 min ago', text: 'Alex escalated — API auth bug to L2', confidence: 58 },
      { type: 'kb_gap', time: '15 min ago', text: 'Gap detected — "Webhook retry logic" (23 queries)' },
      { type: 'resolved', time: '22 min ago', text: 'Casey sent renewal invoice — Harbor Tech $67K' },
      { type: 'resolved', time: '31 min ago', text: 'Riley completed onboarding checklist — new hire #4' },
      { type: 'escalated', time: '45 min ago', text: 'Casey flagged at-risk — Apex Systems (health: 34)', confidence: 34 },
      { type: 'resolved', time: '1 hr ago', text: 'Alex resolved 3 tickets — billing questions', confidence: 91 },
      { type: 'error', time: '2 hrs ago', text: 'Riley: Workday connector timeout — retrying' },
    ],
  },
  pwc: {
    entities: {
      customer: {
        label: 'Clients', icon: '◎',
        des: ['Morgan'],
        metric: '4 active engagements', metricPage: 'entity_customer',
        health: 'active', humanTasks: 2,
        legacy: ['Client Relations', 'Business Development', 'Client Services'],
        subPage: 'entity_customer',
      },
      vendor: {
        label: 'Vendors & Partners', icon: '◈',
        des: [],
        metric: '2 vendors under review', metricPage: 'entity_vendor',
        health: 'active', humanTasks: 0,
        legacy: ['Procurement'],
        subPage: 'entity_vendor',
      },
      workforce: {
        label: 'Our People', icon: '◉',
        des: [],
        metric: '1 role open', metricPage: 'entity_workforce_talent',
        health: 'active', humanTasks: 0,
        legacy: ['Human Resources'],
        subPage: 'entity_workforce',
      },
    },
    outcomes: {
      revenue: { label: 'Revenue & Growth', icon: '↑', metric: '$4.2M fees in progress', trend: 'up', page: 'outcome_revenue', legacy: ['Business Development', 'Engagement Mgmt'] },
      delivery: { label: 'Practice Delivery', icon: '◧', metric: '2 filings due Jul 15', trend: 'warn', page: 'outcome_delivery', legacy: ['Tax', 'Audit', 'Advisory'] },
      financial: { label: 'Financial Health', icon: '$', metric: '$890K WIP unbilled', trend: 'stable', page: 'outcome_financial', legacy: ['Finance', 'Billing & Collections'] },
      risk: { label: 'Risk Posture', icon: '◬', metric: '2 compliance alerts', trend: 'alert', page: 'outcome_risk', legacy: ['Risk & Compliance', 'Legal', 'Quality'], alerts: 2 },
    },
    tasks: [
      { id: 't1', type: 'review_gate', title: 'Partner review — Crestline tax memo Q2', de: 'Avery', detail: '', age: '14 min', urgent: true },
      { id: 't2', type: 'approval_gate', title: 'Credit note approval', de: 'Morgan', detail: '$12,400', age: '1 hr', urgent: false },
      { id: 't3', type: 'escalation', title: 'GDPR data request — response overdue', de: 'Morgan', detail: '', age: '2 hrs', urgent: true },
      { id: 't4', type: 'review_gate', title: 'Audit workpaper review — Harbor Financial', de: 'Avery', detail: '', age: '3 hrs', urgent: false },
    ],
    activity: [
      { type: 'resolved', time: '5 min ago', text: 'Avery completed tax research — Q2 corp memo', confidence: 91 },
      { type: 'escalated', time: '14 min ago', text: 'Avery escalated memo to partner review' },
      { type: 'kb_gap', time: '30 min ago', text: 'Gap detected — "FATCA filing for dual-nationals"' },
      { type: 'resolved', time: '45 min ago', text: 'Morgan completed KYC — new client onboarding' },
      { type: 'resolved', time: '1 hr ago', text: 'Avery reviewed 14 workpapers — Harbor Financial', confidence: 88 },
      { type: 'error', time: '2 hrs ago', text: 'GDPR response overdue — escalated to human' },
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────────

function healthDot(health: EntityHealth): string {
  if (health === 'active') return 'bg-emerald-400';
  if (health === 'degraded') return 'bg-amber-400';
  if (health === 'at_risk') return 'bg-red-400';
  return 'bg-slate-600';
}

function healthLabel(health: EntityHealth): string {
  if (health === 'active') return 'Active';
  if (health === 'degraded') return 'Degraded';
  if (health === 'at_risk') return 'At Risk';
  return 'Offline';
}

function healthLabelColor(health: EntityHealth): string {
  if (health === 'active') return 'text-emerald-400';
  if (health === 'degraded') return 'text-amber-400';
  if (health === 'at_risk') return 'text-red-400';
  return 'text-dt-muted';
}

function trendIcon(trend: OutcomeTrend): string {
  if (trend === 'up') return '↑';
  if (trend === 'stable') return '→';
  if (trend === 'warn') return '↓';
  return '⚠';
}

function trendLabel(trend: OutcomeTrend): string {
  if (trend === 'up') return 'Trending up';
  if (trend === 'stable') return 'Stable';
  if (trend === 'warn') return 'Needs attention';
  return 'Alert';
}

function trendColor(trend: OutcomeTrend): string {
  if (trend === 'up') return 'text-emerald-400';
  if (trend === 'stable') return 'text-dt-support';
  if (trend === 'warn') return 'text-amber-400';
  return 'text-red-400';
}

function taskBadgeStyle(type: TaskType): string {
  if (type === 'approval_gate') return 'bg-indigo-500/20 text-indigo-300';
  if (type === 'review_gate') return 'bg-blue-500/20 text-blue-300';
  if (type === 'escalation') return 'bg-red-500/20 text-red-300';
  if (type === 'override') return 'bg-amber-500/20 text-amber-300';
  if (type === 'knowledge_revision') return 'bg-amber-500/20 text-amber-300';
  if (type === 'inquiry_review') return 'bg-sky-500/20 text-sky-300';
  if (type === 'action_approval') return 'bg-fuchsia-500/20 text-fuchsia-300';
  return 'bg-slate-600 text-dt-support';
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
  const { liveTenantName, currentTenant } = useAuth();
  const vocab = useVocabulary();
  const openFile = useOpenEmployeeFile(setPage);
  const [working, setWorking] = useState<ActiveWorkRow[]>([]);
  const [workforce, setWorkforce] = useState<DigitalEmployee[]>([]);
  const [accounts, setAccounts] = useState<CustomerAccount[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [invoices, setInvoices] = useState<RenewalInvoice[]>([]);
  const [tasks, setTasks] = useState<DBHumanTask[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [knowledgeGaps, setKnowledgeGaps] = useState(0);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [a, t, i, h, ev, kg] = await Promise.all([
          listAccounts(), listTickets(), listInvoices(), listHumanTasks(), listActivity(10),
          getPendingKnowledgeGapCount(),
        ]);
        if (cancelled) return;
        setAccounts(a); setTickets(t); setInvoices(i); setTasks(h); setActivity(ev);
        setKnowledgeGaps(kg);
        setMissingTables(false);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof CustomerApiError && err.missingTables) {
          setMissingTables(true);
        } else {
          console.error('LiveDashboard:', err);
          setLoadError(err instanceof Error ? err.message : 'Something went wrong loading your dashboard.');
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
      .then(([w, d]) => { if (!cancelled) { setWorking(w); setWorkforce(d); } })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [retryTick]);

  const openTickets = tickets.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const atRisk = accounts.filter(a => a.status === 'at_risk' || a.health_score < 45).length;
  const pendingTasks = tasks.filter(t => t.status === 'pending').length;
  const renewalsDue = invoices.filter(i => i.status !== 'paid').length;
  const arrCents = accounts.reduce((s, a) => s + a.arr_cents, 0);

  const kpis = [
    { icon: '◎', value: String(accounts.length), label: vocab.party_plural, navPage: 'entity_customer_success' as Page, alert: false },
    { icon: '💬', value: String(openTickets), label: 'Open Tickets', navPage: 'entity_customer_support' as Page, alert: false },
    { icon: '✋', value: `${pendingTasks} pending`, label: 'Human Tasks', navPage: 'ops_human_tasks' as Page, alert: pendingTasks > 0 },
    { icon: '↻', value: String(renewalsDue), label: `${vocab.renewal_label}s Open`, navPage: 'entity_customer_renewal' as Page, alert: false },
    { icon: '⚑', value: String(atRisk), label: `At-Risk ${vocab.party_plural}`, navPage: 'entity_customer_success' as Page, alert: atRisk > 0 },
    { icon: '📚', value: `${knowledgeGaps} detected`, label: 'Knowledge Gaps', navPage: 'ops_human_tasks' as Page, alert: knowledgeGaps > 0 },
  ];

  const activityEventToType = (e: ActivityEvent): ActivityType =>
    e.event_type === 'resolved' || e.event_type === 'approval' ? 'resolved'
    : e.event_type === 'escalated' ? 'escalated'
    : e.event_type === 'kb_gap' ? 'kb_gap'
    : e.event_type === 'error' ? 'error'
    : 'kb_gap';

  return (
    <div className="p-6 flex flex-col gap-6 text-dt-body">

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
            {/* KPI row — StatTiles, responsive (2/3/6 across widths) */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              {kpis.map((kpi) => (
                <StatTile key={kpi.label} icon={kpi.icon} label={kpi.label} value={kpi.value}
                  tone={kpi.alert ? 'warn' : undefined} onClick={() => setPage(kpi.navPage)} />
              ))}
            </div>

            {/* Working now — the live per-employee strip: who is mid-task,
                one click into their Employee File (Phase B legibility). */}
            <PanelCard title="Working now"
              badge={working.length > 0 ? <Chip tone="info" dot pulse>{working.length} active</Chip> : undefined}
              actions={<Button kind="ghost" size="sm" onClick={() => setPage('ops_de_activity')}>At Work cockpit →</Button>}>
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
                      <span className="text-sm font-semibold text-dt-title">Customer Lifecycle</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Chip tone={atRisk > 0 ? 'warn' : 'ok'} dot>{atRisk > 0 ? 'Attention' : 'Healthy'}</Chip>
                      <button
                        onClick={() => setPage('entity_customer')} aria-label="Open Customer Lifecycle"
                        className="w-6 h-6 rounded-md bg-dt-panel text-dt-support hover:text-dt-title hover:bg-dt-inset flex items-center justify-center text-xs transition-colors"
                      >
                        →
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-dt-support">
                    <span className="text-dt-muted text-[10px]">ARR under management: </span>
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
                        {pendingTasks} Human Tasks
                      </button>
                    )}
                  </div>
                </div>

                {/* Placeholder entities until they enter the production track */}
                {[
                  { label: 'Vendors & Partners', icon: '◈', page: 'entity_vendor' as Page },
                  { label: 'Our People', icon: '◉', page: 'entity_workforce' as Page },
                ].map(e => (
                  <div key={e.label} className="rounded-xl border border-dt-border bg-dt-card p-4 flex flex-col gap-3 opacity-70">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-dt-support text-sm">{e.icon}</span>
                        <span className="text-sm font-semibold text-dt-title">{e.label}</span>
                      </div>
                      <button
                        onClick={() => setPage(e.page)} aria-label={`Open ${e.label}`}
                        className="w-6 h-6 rounded-md bg-dt-panel text-dt-support hover:text-dt-title hover:bg-dt-inset flex items-center justify-center text-xs transition-colors"
                      >
                        →
                      </button>
                    </div>
                    <div className="text-xs text-dt-faint italic">Not yet on the production track</div>
                  </div>
                ))}
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
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded w-fit ${taskBadgeStyle(task.type)}`}>
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
                            <div className="text-xs text-dt-support leading-tight">{item.text}</div>
                            <div className="text-[10px] text-dt-faint mt-0.5">{item.actor} · {liveActivityAge(item.created_at)}</div>
                          </div>
                          {item.confidence != null && (
                            <Chip tone="neutral" className="flex-shrink-0">{item.confidence}%</Chip>
                          )}
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
  dbStats?: any;
}) {
  return <LiveDashboard setPage={props.setPage} />;
}

