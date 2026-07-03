import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { COMPANY_SUMMARY } from '../../data/companies';
import { computeLiveCounts } from '../../components/Sidebar';
import type { Page } from '../../types';

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
type TaskType = 'approval_gate' | 'review_gate' | 'escalation' | 'override' | 'training_feedback';
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
        label: 'Customer', icon: '◎',
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
        label: 'Workforce', icon: '◉',
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
      risk: { label: 'Risk & Compliance', icon: '⚑', metric: '2 compliance alerts', trend: 'alert', page: 'outcome_risk', legacy: ['Legal', 'Security', 'Compliance'], alerts: 2 },
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
        label: 'Workforce', icon: '◉',
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
      risk: { label: 'Risk & Compliance', icon: '⚑', metric: '2 compliance alerts', trend: 'alert', page: 'outcome_risk', legacy: ['Risk & Compliance', 'Legal', 'Quality'], alerts: 2 },
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
  return 'text-slate-500';
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
  if (trend === 'stable') return 'text-slate-400';
  if (trend === 'warn') return 'text-amber-400';
  return 'text-red-400';
}

function taskBadgeStyle(type: TaskType): string {
  if (type === 'approval_gate') return 'bg-indigo-500/20 text-indigo-300';
  if (type === 'review_gate') return 'bg-blue-500/20 text-blue-300';
  if (type === 'escalation') return 'bg-red-500/20 text-red-300';
  if (type === 'override') return 'bg-amber-500/20 text-amber-300';
  return 'bg-slate-700 text-slate-400';
}

function taskBadgeLabel(type: TaskType): string {
  if (type === 'approval_gate') return 'APPROVAL';
  if (type === 'review_gate') return 'REVIEW';
  if (type === 'escalation') return 'ESCALATION';
  if (type === 'override') return 'OVERRIDE';
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

// ── Component ────────────────────────────────────────────────────

export default function DashboardPage({
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
  const live = computeLiveCounts(activeCompanyId);

  const [healthConfig, setHealthConfig] = useState<HealthConfig>(DEFAULT_HEALTH_CONFIG);
  const [showHealthConfig, setShowHealthConfig] = useState(false);
  const [lastUpdated] = useState(new Date());
  const [draftConfig, setDraftConfig] = useState<HealthConfig>(DEFAULT_HEALTH_CONFIG);

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
  };

  const resetHealthConfig = () => {
    setDraftConfig(DEFAULT_HEALTH_CONFIG);
  };

  const updateDraft = (key: keyof HealthConfig, val: number) => {
    setDraftConfig(prev => ({ ...prev, [key]: val }));
  };

  const formatTime = (d: Date) => {
    const now = new Date();
    const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
    if (diff < 60) return 'just now';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const entityList: EntityData[] = [data.entities.customer, data.entities.vendor, data.entities.workforce];

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-950">
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
            <span className="text-xs text-slate-500">{activeCompany.industry}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Updated: {formatTime(lastUpdated)}</span>
            <button
              onClick={openHealthConfig}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white text-xs transition-colors"
            >
              <span>⚙</span> Health Config
            </button>
            <button
              onClick={() => window.location.reload()}
              className="w-8 h-8 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center text-sm transition-colors"
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
              className={`bg-slate-900 border rounded-xl p-4 text-left cursor-pointer hover:border-slate-700 transition-all ${
                kpi.alert ? 'border-amber-500/40 hover:border-amber-500/60' : 'border-slate-800'
              }`}
            >
              <div className={`text-base mb-2 ${kpi.alert ? 'text-amber-400' : 'text-slate-400'}`}>{kpi.icon}</div>
              <div className={`text-xl font-bold mb-0.5 ${kpi.alert ? 'text-amber-300' : 'text-white'}`}>{kpi.value}</div>
              <div className="text-xs text-slate-500">{kpi.label}</div>
            </button>
          ))}
        </div>

        {/* Entities */}
        <div>
          <div className="text-[9px] font-bold tracking-widest text-slate-600 uppercase mb-3">
            ENTITIES — what we serve
          </div>
          <div className="grid grid-cols-3 gap-4">
            {entityList.map((entity) => (
              <div
                key={entity.label}
                className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-3"
              >
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 text-sm">{entity.icon}</span>
                    <span className="text-sm font-semibold text-white">{entity.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${healthDot(entity.health)}`} />
                      <span className={`text-[10px] font-medium ${healthLabelColor(entity.health)}`}>{healthLabel(entity.health)}</span>
                    </div>
                    <button
                      onClick={() => setPage(entity.subPage)}
                      className="w-6 h-6 rounded-md bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 flex items-center justify-center text-xs transition-colors"
                    >
                      →
                    </button>
                  </div>
                </div>

                {/* DEs */}
                <div className="text-xs text-slate-400">
                  <span className="text-slate-600 text-[10px]">DEs: </span>
                  {entity.des.length === 0
                    ? <span className="text-slate-600 italic">none assigned</span>
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
                  <div className="h-px bg-slate-800 mb-2" />
                  <div className="text-[10px] text-slate-600 mb-1.5">Legacy departments</div>
                  <div className="flex flex-wrap gap-1">
                    {entity.legacy.map(dept => (
                      <span key={dept} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">
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
          <div className="text-[9px] font-bold tracking-widest text-slate-600 uppercase mb-3">
            OUTCOMES — what we achieve
          </div>
          <div className="grid grid-cols-4 gap-4">
            {(Object.values(data.outcomes) as OutcomeData[]).map((outcome) => (
              <button
                key={outcome.label}
                onClick={() => setPage(outcome.page)}
                className={`bg-slate-900 border rounded-xl p-4 text-left flex flex-col gap-3 hover:border-slate-700 transition-all ${
                  outcome.alerts && outcome.alerts > 0 ? 'border-amber-500/30 hover:border-amber-500/50' : 'border-slate-800'
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm ${trendColor(outcome.trend)}`}>{outcome.icon}</span>
                    <span className="text-xs font-semibold text-white leading-tight">{outcome.label}</span>
                  </div>
                  <span className="text-slate-600 text-xs">↗</span>
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
                  <div className="h-px bg-slate-800 mb-2" />
                  <div className="text-[10px] text-slate-600 mb-1">Legacy departments</div>
                  <div className="flex flex-wrap gap-1">
                    {outcome.legacy.map(dept => (
                      <span key={dept} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">
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
          <div className="col-span-3 bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[9px] font-bold tracking-widest text-slate-600 uppercase">
                HUMAN TASKS — {live.humanTasks} pending
              </span>
              <button
                onClick={() => setPage('ops_human_tasks')}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                View all →
              </button>
            </div>
            <div className="space-y-1">
              {/* Header */}
              <div className="grid grid-cols-[100px_1fr_60px_50px_24px] gap-2 px-2 pb-1">
                <span className="text-[9px] text-slate-600 uppercase tracking-wider">Type</span>
                <span className="text-[9px] text-slate-600 uppercase tracking-wider">Title</span>
                <span className="text-[9px] text-slate-600 uppercase tracking-wider">DE</span>
                <span className="text-[9px] text-slate-600 uppercase tracking-wider">Age</span>
                <span />
              </div>
              {data.tasks.map((task) => (
                <div
                  key={task.id}
                  className={`grid grid-cols-[100px_1fr_60px_50px_24px] gap-2 items-center px-2 py-2 rounded-lg transition-colors ${
                    task.urgent ? 'bg-amber-500/8' : 'hover:bg-slate-800/50'
                  }`}
                >
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded w-fit ${taskBadgeStyle(task.type)}`}>
                    {taskBadgeLabel(task.type)}
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs text-slate-200 truncate">{task.title}</div>
                    {task.detail && <div className="text-[10px] text-slate-500">{task.detail}</div>}
                  </div>
                  <span className="text-xs text-slate-400 truncate">{task.de}</span>
                  <span className="text-xs text-slate-500">{task.age}</span>
                  <button
                    onClick={() => setPage('ops_human_tasks')}
                    className="w-6 h-6 rounded bg-slate-800 text-slate-500 hover:text-white flex items-center justify-center text-xs transition-colors"
                  >
                    →
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Live Activity (40%) */}
          <div className="col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[9px] font-bold tracking-widest text-slate-600 uppercase">LIVE ACTIVITY</span>
              <button
                onClick={() => setPage('ops_activity')}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                View log →
              </button>
            </div>
            <div className="space-y-1">
              {data.activity.map((item, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2.5 px-2 py-2 rounded-lg border-l-2 ${activityBorderColor(item.type)} hover:bg-slate-800/40 transition-colors`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${activityDotColor(item.type)}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-300 leading-tight truncate">{item.text}</div>
                    <div className="text-[10px] text-slate-600 mt-0.5">{item.time}</div>
                  </div>
                  {item.confidence !== undefined && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 flex-shrink-0">
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
            className="fixed inset-0 z-40 bg-slate-950/60"
            onClick={() => setShowHealthConfig(false)}
          />
          <div className="fixed right-0 top-0 bottom-0 z-50 w-80 bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-slate-800">
              <h2 className="text-sm font-semibold text-white">Configure DE Health Thresholds</h2>
              <button
                onClick={() => setShowHealthConfig(false)}
                className="w-7 h-7 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center text-xs transition-colors"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              <p className="text-xs text-slate-400 leading-relaxed">
                These thresholds determine when a DE shows as Active, Degraded, or At Risk.
              </p>

              {/* Confidence Score */}
              <div>
                <div className="text-xs font-semibold text-slate-300 mb-3">Confidence Score</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-400">Amber below</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.confidence_amber}
                        onChange={e => updateDraft('confidence_amber', Number(e.target.value))}
                        className="w-16 text-right bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-slate-500">%</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-400">Red below</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.confidence_red}
                        onChange={e => updateDraft('confidence_red', Number(e.target.value))}
                        className="w-16 text-right bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-slate-500">%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Escalation Rate */}
              <div>
                <div className="text-xs font-semibold text-slate-300 mb-3">Escalation Rate</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-400">Amber above</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.escalation_amber}
                        onChange={e => updateDraft('escalation_amber', Number(e.target.value))}
                        className="w-16 text-right bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-slate-500">%</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-400">Red above</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.escalation_red}
                        onChange={e => updateDraft('escalation_red', Number(e.target.value))}
                        className="w-16 text-right bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-slate-500">%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Knowledge Staleness */}
              <div>
                <div className="text-xs font-semibold text-slate-300 mb-3">Knowledge Staleness</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-400">Amber after</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.staleness_amber}
                        onChange={e => updateDraft('staleness_amber', Number(e.target.value))}
                        className="w-16 text-right bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-slate-500">days</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-400">Red after</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.staleness_red}
                        onChange={e => updateDraft('staleness_red', Number(e.target.value))}
                        className="w-16 text-right bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-slate-500">days</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Error Rate */}
              <div>
                <div className="text-xs font-semibold text-slate-300 mb-3">Error Rate</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-400">Amber above</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.error_rate_amber}
                        onChange={e => updateDraft('error_rate_amber', Number(e.target.value))}
                        className="w-16 text-right bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-slate-500">%</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-400">Red above</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={draftConfig.error_rate_red}
                        onChange={e => updateDraft('error_rate_red', Number(e.target.value))}
                        className="w-16 text-right bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-slate-500"
                      />
                      <span className="text-xs text-slate-500">%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-5 border-t border-slate-800 flex gap-3">
              <button
                onClick={resetHealthConfig}
                className="flex-1 px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs transition-colors"
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
