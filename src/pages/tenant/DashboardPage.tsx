import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { COMPANY_SUMMARY } from '../../data/companies';
import { computeRoi, roiK } from '../../data/roi';
import { computeLiveCounts } from '../../components/Sidebar';
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
  return <DemoDashboardPage {...props} />;
}

function DemoDashboardPage({
  setPage,
  tenant,
  user,
  page,
  accentColor,
  dbStats,
}: {
  setPage: (p: Page) => void;
  tenant?: any;
  user?: any;
  page?: Page;
  accentColor?: string;
  dbStats?: any;
}) {
  const { activeCompanyId, activeCompany } = useAuth();
  const data = COMPANY_DATA[activeCompanyId];
  const summary = COMPANY_SUMMARY[activeCompanyId];

  // Live overlays — task decisions + chat escalations, refreshed on dt-state-changed.
  const readDecisions = (): Record<string, string> => {
    try {
      const stored = localStorage.getItem(`dt_ops_tasks_${activeCompanyId}`);
      if (stored) return JSON.parse(stored) as Record<string, string>;
    } catch { /* noop */ }
    return {};
  };
  const [decisions, setDecisions] = useState<Record<string, string>>(readDecisions);
  const [chatEscs, setChatEscs] = useState<ChatEscalation[]>(() => loadChatEscalations(activeCompanyId));

  useEffect(() => {
    const refresh = () => {
      setDecisions(readDecisions());
      setChatEscs(loadChatEscalations(activeCompanyId));
    };
    refresh();
    window.addEventListener('dt-state-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('dt-state-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [activeCompanyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = computeLiveCounts(activeCompanyId);
  const pendingChatEscs = chatEscs.filter(e => e.status === 'pending');

  const [healthConfig, setHealthConfig] = useState<HealthConfig>(DEFAULT_HEALTH_CONFIG);
  const [showHealthConfig, setShowHealthConfig] = useState(false);
  const [lastUpdated] = useState(new Date());
  const [draftConfig, setDraftConfig] = useState<HealthConfig>(DEFAULT_HEALTH_CONFIG);
  const [healthConfigSavedToast, setHealthConfigSavedToast] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(`dt_health_config_${activeCompanyId}`);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as HealthConfig;
        setHealthConfig(parsed);
        setDraftConfig(parsed);
      } catch {}
    } else {
      setHealthConfig(DEFAULT_HEALTH_CONFIG);
      setDraftConfig(DEFAULT_HEALTH_CONFIG);
    }
  }, [activeCompanyId]);

  const openHealthConfig = () => {
    setDraftConfig(healthConfig);
    setShowHealthConfig(true);
  };

  const saveHealthConfig = (cfg: HealthConfig) => {
    setHealthConfig(cfg);
    localStorage.setItem(`dt_health_config_${activeCompanyId}`, JSON.stringify(cfg));
    setShowHealthConfig(false);
    setHealthConfigSavedToast(true);
    setTimeout(() => setHealthConfigSavedToast(false), 2500);
  };

  const resetHealthConfig = () => {
    setDraftConfig(DEFAULT_HEALTH_CONFIG);
  };

  // staleness_* are day counts (0-365 is a sane range); every other field is a
  // percentage (0-100). Guards against NaN (empty input) and out-of-range
  // values that would otherwise silently corrupt the stored config with no
  // warning shown to the user.
  const HEALTH_CONFIG_MAX: Record<keyof HealthConfig, number> = {
    confidence_amber: 100, confidence_red: 100,
    escalation_amber: 100, escalation_red: 100,
    staleness_amber: 365, staleness_red: 365,
    error_rate_amber: 100, error_rate_red: 100,
  };
  const updateDraft = (key: keyof HealthConfig, val: number) => {
    if (Number.isNaN(val)) return;
    const clamped = Math.max(0, Math.min(HEALTH_CONFIG_MAX[key], Math.round(val)));
    setDraftConfig(prev => ({ ...prev, [key]: clamped }));
  };

  const formatTime = (d: Date) => {
    const now = new Date();
    const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
    if (diff < 60) return 'just now';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const entityList: EntityData[] = [data.entities.customer, data.entities.vendor, data.entities.workforce];

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-dt-page">
      {healthConfigSavedToast && (
        <div className="fixed top-4 right-4 z-50 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-medium shadow-lg">
          Health thresholds saved ✓
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">

        {/* Top bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-white">{activeCompany.name}</h1>
            <span
              className="px-2 py-0.5 rounded text-[10px] font-bold text-white"
              style={{ backgroundColor: activeCompany.badgeColor }}
            >
              {activeCompany.badge}
            </span>
            <span className="text-xs text-dt-muted">{activeCompany.industry}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-dt-muted">Updated: {formatTime(lastUpdated)}</span>
            <button
              onClick={openHealthConfig}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dt-panel text-dt-support hover:bg-dt-panel hover:text-white text-xs transition-colors"
            >
              <span>⚙</span> Health Config
            </button>
            <button
              onClick={() => window.location.reload()}
              className="w-8 h-8 rounded-lg bg-dt-panel text-dt-support hover:text-white flex items-center justify-center text-sm transition-colors"
            >
              ↻
            </button>
          </div>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-5 gap-3">
          {([
            { icon: '⚡', value: `${summary.desActive}/${summary.desTotal}`, label: 'DEs Active', navPage: 'workforce_des' as Page, alert: false },
            { icon: '✋', value: `${live.humanTasks} pending`, label: 'Human Tasks', navPage: 'ops_human_tasks' as Page, alert: false },
            { icon: '◈', value: `${summary.aiResolution}%`, label: 'AI Resolution', navPage: 'intelligence_performance' as Page, alert: false },
            { icon: '△', value: `${live.kbGaps} detected`, label: 'KB Gaps', navPage: 'knowledge_gaps' as Page, alert: false },
            { icon: '⚑', value: String(summary.alerts), label: 'Alerts', navPage: 'outcome_risk' as Page, alert: summary.alerts > 0 },
          ] as const).map((kpi) => (
            <button
              key={kpi.label}
              onClick={() => setPage(kpi.navPage)}
              className={`bg-dt-card border rounded-xl p-4 text-left cursor-pointer hover:border-dt-border-strong transition-all ${
                kpi.alert ? 'border-amber-500/40 hover:border-amber-500/60' : 'border-dt-border'
              }`}
            >
              <div className={`text-base mb-2 ${kpi.alert ? 'text-amber-400' : 'text-dt-support'}`}>{kpi.icon}</div>
              <div className={`text-xl font-bold mb-0.5 ${kpi.alert ? 'text-amber-300' : 'text-white'}`}>{kpi.value}</div>
              <div className="text-xs text-dt-muted">{kpi.label}</div>
            </button>
          ))}
        </div>

        {/* Value rollup — derived from Performance page numbers (src/data/roi.ts) */}
        {(() => {
          const roi = computeRoi(activeCompanyId);
          return (
            <button
              onClick={() => setPage('intelligence_performance')}
              title={roi.formula}
              className="w-full -mt-3 bg-dt-card border border-emerald-500/25 hover:border-emerald-500/50 rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap text-left transition-all"
            >
              <span className="text-[9px] font-bold tracking-widest text-emerald-400 uppercase flex-shrink-0">Value this month</span>
              <span className="text-sm text-dt-body">
                {roi.tasks.toLocaleString()} tasks · ~{roiK(roi.humanCost)} equivalent human cost · {roiK(roi.deCost)} DE cost —{' '}
                <span className="text-emerald-300 font-semibold">{roi.savingsPct}% savings (~{roiK(roi.savings)})</span>
              </span>
              <span className="text-[11px] text-dt-muted ml-auto flex-shrink-0">
                estimate vs human baseline · how is this calculated? →
              </span>
            </button>
          );
        })()}

        {/* Entities */}
        <div>
          <div className="text-[9px] font-bold tracking-widest text-dt-faint uppercase mb-3">
            WHO WE SERVE
          </div>
          <div className="grid grid-cols-3 gap-4">
            {entityList.map((entity) => (
              <div
                key={entity.label}
                className="bg-dt-card border border-dt-border rounded-xl p-4 flex flex-col gap-3"
              >
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-dt-support text-sm">{entity.icon}</span>
                    <span className="text-sm font-semibold text-white">{entity.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${healthDot(entity.health)}`} />
                      <span className={`text-[10px] font-medium ${healthLabelColor(entity.health)}`}>{healthLabel(entity.health)}</span>
                    </div>
                    <button
                      onClick={() => setPage(entity.subPage)}
                      className="w-6 h-6 rounded-md bg-dt-panel text-dt-support hover:text-white hover:bg-dt-panel flex items-center justify-center text-xs transition-colors"
                    >
                      →
                    </button>
                  </div>
                </div>

                {/* DEs */}
                <div className="text-xs text-dt-support">
                  <span className="text-dt-faint text-[10px]">DEs: </span>
                  {entity.des.length === 0
                    ? <span className="text-dt-faint italic">none assigned</span>
                    : entity.des.length <= 3
                      ? entity.des.join(' · ')
                      : `${entity.des.slice(0, 3).join(' · ')} +${entity.des.length - 3} more`
                  }
                </div>

                {/* Metric + human tasks */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage(entity.metricPage)}
                    className="flex-1 text-xs text-indigo-300 hover:text-indigo-200 bg-indigo-500/10 hover:bg-indigo-500/15 rounded-lg px-2 py-1.5 text-left transition-colors"
                  >
                    {entity.metric} ↗
                  </button>
                  {entity.humanTasks > 0 && (
                    <button
                      onClick={() => setPage('ops_human_tasks')}
                      className="text-xs text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg px-2 py-1.5 whitespace-nowrap transition-colors"
                    >
                      {entity.humanTasks} Human Tasks
                    </button>
                  )}
                </div>

                {/* Legacy departments */}
                <div>
                  <div className="h-px bg-dt-panel mb-2" />
                  <div className="text-[10px] text-dt-faint mb-1.5">Legacy departments</div>
                  <div className="flex flex-wrap gap-1">
                    {entity.legacy.map(dept => (
                      <span key={dept} className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted">
                        {dept}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Outcomes */}
        <div>
          <div className="text-[9px] font-bold tracking-widest text-dt-faint uppercase mb-3">
            OUTCOMES — what we achieve
          </div>
          <div className="grid grid-cols-4 gap-4">
            {(Object.values(data.outcomes) as OutcomeData[]).map((outcome) => (
              <button
                key={outcome.label}
                onClick={() => setPage(outcome.page)}
                className={`bg-dt-card border rounded-xl p-4 text-left flex flex-col gap-3 hover:border-dt-border-strong transition-all ${
                  outcome.alerts && outcome.alerts > 0 ? 'border-amber-500/30 hover:border-amber-500/50' : 'border-dt-border'
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm ${trendColor(outcome.trend)}`}>{outcome.icon}</span>
                    <span className="text-xs font-semibold text-white leading-tight">{outcome.label}</span>
                  </div>
                  <span className="text-dt-faint text-xs">↗</span>
                </div>

                {/* Metric */}
                <div>
                  <div className="text-sm font-medium text-white mb-1">{outcome.metric}</div>
                  <div className={`flex items-center gap-1 text-xs ${trendColor(outcome.trend)}`}>
                    <span>{trendIcon(outcome.trend)}</span>
                    <span>{trendLabel(outcome.trend)}</span>
                  </div>
                </div>

                {/* Legacy departments */}
                <div>
                  <div className="h-px bg-dt-panel mb-2" />
                  <div className="text-[10px] text-dt-faint mb-1">Legacy departments</div>
                  <div className="flex flex-wrap gap-1">
                    {outcome.legacy.map(dept => (
                      <span key={dept} className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted">
                        {dept}
                      </span>
                    ))}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Bottom row — Human Tasks + Live Activity */}
        <div className="grid grid-cols-5 gap-4">

          {/* Human Tasks (60%) */}
          <div className="col-span-3 bg-dt-card border border-dt-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[9px] font-bold tracking-widest text-dt-faint uppercase">
                HUMAN TASKS — {live.humanTasks} pending
              </span>
              <button
                onClick={() => setPage('ops_human_tasks')}
                className="text-xs text-dt-muted hover:text-dt-support transition-colors"
              >
                View all →
              </button>
            </div>
            <div className="space-y-1">
              {/* Header */}
              <div className="grid grid-cols-[100px_1fr_60px_50px_24px] gap-2 px-2 pb-1">
                <span className="text-[9px] text-dt-faint uppercase tracking-wider">Type</span>
                <span className="text-[9px] text-dt-faint uppercase tracking-wider">Title</span>
                <span className="text-[9px] text-dt-faint uppercase tracking-wider">DE</span>
                <span className="text-[9px] text-dt-faint uppercase tracking-wider">Age</span>
                <span />
              </div>
              {/* Chat-dock escalations (pending) surface at the top of the queue */}
              {pendingChatEscs.map((esc) => (
                <div
                  key={esc.id}
                  className="grid grid-cols-[100px_1fr_60px_50px_24px] gap-2 items-center px-2 py-2 rounded-lg transition-colors hover:bg-dt-panel"
                >
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded w-fit ${taskBadgeStyle('review_gate')}`}>
                    {taskBadgeLabel('review_gate')}
                  </span>
                  <div className="min-w-0 flex items-center gap-1.5">
                    <span className="text-xs text-dt-body truncate">{esc.title}</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300 flex-shrink-0">via DE chat</span>
                  </div>
                  <span className="text-xs text-dt-support truncate">{esc.de}</span>
                  <span className="text-xs text-dt-muted">{chatEscalationAge(esc.createdAt)}</span>
                  <button
                    onClick={() => setPage('ops_human_tasks')}
                    className="w-6 h-6 rounded bg-dt-panel text-dt-muted hover:text-white flex items-center justify-center text-xs transition-colors"
                  >
                    →
                  </button>
                </div>
              ))}
              {data.tasks.map((task) => {
                const decided = decisions[task.id];
                return (
                <div
                  key={task.id}
                  className={`grid grid-cols-[100px_1fr_60px_50px_24px] gap-2 items-center px-2 py-2 rounded-lg transition-colors ${
                    decided ? 'opacity-60 hover:opacity-100 hover:bg-dt-panel' : task.urgent ? 'bg-amber-500/8' : 'hover:bg-dt-panel'
                  }`}
                >
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded w-fit ${taskBadgeStyle(task.type)}`}>
                    {taskBadgeLabel(task.type)}
                  </span>
                  <div className="min-w-0 flex items-center gap-1.5">
                    <div className="min-w-0">
                      <div className="text-xs text-dt-body truncate">{task.title}</div>
                      {task.detail && <div className="text-[10px] text-dt-muted">{task.detail}</div>}
                    </div>
                    {decided === 'approved' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 flex-shrink-0">Approved</span>
                    )}
                    {decided === 'rejected' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 flex-shrink-0">Rejected</span>
                    )}
                  </div>
                  <span className="text-xs text-dt-support truncate">{task.de}</span>
                  <span className="text-xs text-dt-muted">{task.age}</span>
                  <button
                    onClick={() => setPage('ops_human_tasks')}
                    className="w-6 h-6 rounded bg-dt-panel text-dt-muted hover:text-white flex items-center justify-center text-xs transition-colors"
                  >
                    →
                  </button>
                </div>
                );
              })}
            </div>
          </div>

          {/* Live Activity (40%) */}
          <div className="col-span-2 bg-dt-card border border-dt-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[9px] font-bold tracking-widest text-dt-faint uppercase">LIVE ACTIVITY</span>
              <button
                onClick={() => setPage('ops_activity')}
                className="text-xs text-dt-muted hover:text-dt-support transition-colors"
              >
                View log →
              </button>
            </div>
            <div className="space-y-1">
              {data.activity.map((item, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2.5 px-2 py-2 rounded-lg border-l-2 ${activityBorderColor(item.type)} hover:bg-dt-panel transition-colors`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${activityDotColor(item.type)}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-dt-support leading-tight truncate">{item.text}</div>
                    <div className="text-[10px] text-dt-faint mt-0.5">{item.time}</div>
                  </div>
                  {item.confidence !== undefined && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support flex-shrink-0">
                      {item.confidence}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>

      {/* Health Config slide-over */}
      {showHealthConfig && (
        <>
          <div
            className="fixed inset-0 z-40 bg-dt-inset"
            onClick={() => setShowHealthConfig(false)}
          />
          <div className="fixed right-0 top-0 bottom-0 z-50 w-80 bg-dt-card border-l border-dt-border flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-dt-border">
              <h2 className="text-sm font-semibold text-white">Configure DE Health Thresholds</h2>
              <button
                onClick={() => setShowHealthConfig(false)}
                className="w-7 h-7 rounded-lg bg-dt-panel text-dt-support hover:text-white flex items-center justify-center text-xs transition-colors"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              <p className="text-xs text-dt-support leading-relaxed">
                These thresholds determine when a DE shows as Active, Degraded, or At Risk.
              </p>

              {/* Confidence Score */}
              <div>
                <div className="text-xs font-semibold text-dt-support mb-3">Confidence Score</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-dt-support">Amber below</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.confidence_amber}
                        onChange={e => updateDraft('confidence_amber', Number(e.target.value))}
                        min={0} max={100}
                        className="w-16 text-right bg-dt-panel border border-dt-border-strong rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-dt-muted">%</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-dt-support">Red below</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.confidence_red}
                        onChange={e => updateDraft('confidence_red', Number(e.target.value))}
                        min={0} max={100}
                        className="w-16 text-right bg-dt-panel border border-dt-border-strong rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-dt-muted">%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Escalation Rate */}
              <div>
                <div className="text-xs font-semibold text-dt-support mb-3">Escalation Rate</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-dt-support">Amber above</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.escalation_amber}
                        onChange={e => updateDraft('escalation_amber', Number(e.target.value))}
                        min={0} max={100}
                        className="w-16 text-right bg-dt-panel border border-dt-border-strong rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-dt-muted">%</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-dt-support">Red above</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.escalation_red}
                        onChange={e => updateDraft('escalation_red', Number(e.target.value))}
                        min={0} max={100}
                        className="w-16 text-right bg-dt-panel border border-dt-border-strong rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-dt-muted">%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Knowledge Staleness */}
              <div>
                <div className="text-xs font-semibold text-dt-support mb-3">Knowledge Staleness</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-dt-support">Amber after</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.staleness_amber}
                        onChange={e => updateDraft('staleness_amber', Number(e.target.value))}
                        min={0} max={365}
                        className="w-16 text-right bg-dt-panel border border-dt-border-strong rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-dt-muted">days</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-dt-support">Red after</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.staleness_red}
                        onChange={e => updateDraft('staleness_red', Number(e.target.value))}
                        min={0} max={365}
                        className="w-16 text-right bg-dt-panel border border-dt-border-strong rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-dt-muted">days</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Error Rate */}
              <div>
                <div className="text-xs font-semibold text-dt-support mb-3">Error Rate</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-dt-support">Amber above</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.error_rate_amber}
                        onChange={e => updateDraft('error_rate_amber', Number(e.target.value))}
                        min={0} max={100}
                        className="w-16 text-right bg-dt-panel border border-dt-border-strong rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-dt-muted">%</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-dt-support">Red above</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.error_rate_red}
                        onChange={e => updateDraft('error_rate_red', Number(e.target.value))}
                        min={0} max={100}
                        className="w-16 text-right bg-dt-panel border border-dt-border-strong rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-dt-muted">%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-5 border-t border-dt-border flex gap-3">
              <button
                onClick={resetHealthConfig}
                className="flex-1 px-3 py-2 rounded-lg bg-dt-panel text-dt-support hover:bg-dt-panel text-xs transition-colors"
              >
                Reset to defaults
              </button>
              <button
                onClick={() => saveHealthConfig(draftConfig)}
                className="flex-1 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
              >
                Save changes
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
