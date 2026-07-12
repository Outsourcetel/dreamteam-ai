import React, { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { useDataMode } from '../../../lib/dataMode';
import { fetchMonthlyUsage, MonthlyUsage } from '../../../lib/usageApi';
import { PageHeader } from '../../../components/ui';
import { COMPANY_SUMMARY } from '../../../data/companies';
import { computeRoi, roiK } from '../../../data/roi';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import {
  getDePerformanceMetrics, getDeCostMetrics, getDeCsatMetrics,
  getDeGuardrailActivity, getRecentEvalFailures,
  type DePerformanceMetrics, type DeCostMetrics, type DeCsatMetrics,
  type DeGuardrailActivity, type RecentEvalFailure,
} from '../../../lib/api';
import { listDigitalEmployees, type DigitalEmployee } from '../../../lib/digitalEmployeesApi';

// ── Shared per-DE metrics (numbers from WorkforceDEsPage) ─────────

interface DEMetrics {
  name: string;
  role: string;
  resolutionRate: number;
  confidence: number;
  escalationRate: number;
  errorRate: number;
  tasksThisMonth: number;
  trend: number[];       // resolution trend for sparkline
  costPerTask: string;
  humanBaseline: string;
}

const TCP_METRICS: DEMetrics[] = [
  { name: 'Alex', role: 'Customer Support DE', resolutionRate: 88, confidence: 91, escalationRate: 12, errorRate: 2, tasksThisMonth: 847, trend: [82, 84, 83, 86, 87, 88], costPerTask: '$1.40', humanBaseline: '$14.20' },
  { name: 'Casey', role: 'Renewal DE', resolutionRate: 92, confidence: 88, escalationRate: 8, errorRate: 1, tasksThisMonth: 312, trend: [88, 89, 91, 90, 92, 92], costPerTask: '$2.10', humanBaseline: '$31.50' },
  { name: 'Riley', role: 'HR & People DE', resolutionRate: 79, confidence: 83, escalationRate: 14, errorRate: 4, tasksThisMonth: 178, trend: [84, 83, 81, 80, 79, 79], costPerTask: '$1.85', humanBaseline: '$18.70' },
];

const PWC_METRICS: DEMetrics[] = [
  { name: 'Morgan', role: 'Client Relations DE', resolutionRate: 85, confidence: 87, escalationRate: 10, errorRate: 2, tasksThisMonth: 241, trend: [80, 82, 83, 84, 85, 85], costPerTask: '$2.60', humanBaseline: '$42.00' },
  { name: 'Avery', role: 'Tax Research DE', resolutionRate: 82, confidence: 91, escalationRate: 16, errorRate: 1, tasksThisMonth: 94, trend: [78, 79, 80, 81, 82, 82], costPerTask: '$6.80', humanBaseline: '$185.00' },
];

const METRICS: Record<CompanyId, DEMetrics[]> = { tcp: TCP_METRICS, pwc: PWC_METRICS };

// Company benchmark — same wording as WorkforceDEsPage TabPerformance
const BENCHMARK: Record<CompanyId, { resolution: number; confidence: number; escalation: number }> = {
  tcp: { resolution: 84, confidence: 88, escalation: 11 },
  pwc: { resolution: 83, confidence: 89, escalation: 13 },
};

// ── Sparkline (inline SVG) ────────────────────────────────────────

function Sparkline({ data, color = '#818cf8' }: { data: number[]; color?: string }) {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 90, h = 24;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 4) - 2}`).join(' ');
  return (
    <svg width={w} height={h} className="flex-shrink-0">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function metricColor(kind: 'resolution' | 'confidence' | 'escalation' | 'error' | 'frustration', val: number): string {
  if (kind === 'resolution') return val >= 85 ? 'text-emerald-400' : val >= 70 ? 'text-amber-400' : 'text-red-400';
  if (kind === 'confidence') return val >= 80 ? 'text-emerald-400' : val >= 60 ? 'text-amber-400' : 'text-red-400';
  if (kind === 'escalation') return val > 20 ? 'text-red-400' : val > 12 ? 'text-amber-400' : 'text-emerald-400';
  if (kind === 'frustration') return val >= 50 ? 'text-red-400' : val >= 25 ? 'text-amber-400' : 'text-emerald-400';
  return val > 10 ? 'text-red-400' : val > 4 ? 'text-amber-400' : 'text-emerald-400';
}

// ── Live usage strip (real usage_metrics, live tenants only) ──────

function LiveUsageStrip() {
  const [usage, setUsage] = useState<MonthlyUsage | null>(null);
  useEffect(() => {
    fetchMonthlyUsage().then(setUsage).catch(() => setUsage(null));
  }, []);
  if (!usage) return null;
  const items = [
    { label: 'Inquiries', value: usage.inquiries },
    { label: 'Cache hits', value: usage.cache_hits },
    { label: 'Escalations', value: usage.escalations },
    { label: 'LLM calls', value: usage.llm_calls },
  ];
  return (
    <div className="bg-slate-900 border border-indigo-500/25 rounded-xl px-4 py-3 mb-4">
      <div className="flex items-center gap-4 flex-wrap">
        <span className="text-[9px] font-bold tracking-widest text-indigo-400 uppercase">Live usage (this month)</span>
        {items.map(m => (
          <span key={m.label} className="text-xs text-slate-400">
            {m.label} <span className="text-slate-200 font-semibold">{m.value.toLocaleString()}</span>
          </span>
        ))}
      </div>
      <p className="text-[11px] text-slate-500 mt-1">
        Real counters from your Digital Employee — recorded per inquiry by the answering service.
      </p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Performance
// ══════════════════════════════════════════════════════════════════

export function PerformancePage({ setPage }: { setPage: (p: Page) => void }) {
  const dataMode = useDataMode();
  const { currentTenant } = useAuth();
  if (dataMode === 'live' && currentTenant?.id) {
    return <LivePerformancePage tenantId={currentTenant.id} setPage={setPage} />;
  }
  return <DemoPerformancePage setPage={setPage} />;
}

function DemoPerformancePage({ setPage }: { setPage: (p: Page) => void }) {
  const { activeCompanyId } = useAuth();
  const dataMode = useDataMode();
  const des = METRICS[activeCompanyId];
  const bench = BENCHMARK[activeCompanyId];
  const summary = COMPANY_SUMMARY[activeCompanyId];

  const totalTasks = des.reduce((s, d) => s + d.tasksThisMonth, 0);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Performance Analytics"
        subtitle={`Org-level Digital Employee analytics — ${des.length} DEs · ${totalTasks.toLocaleString()} tasks this month · ${summary.aiResolution}% AI resolution`}
      />

      {/* Live usage counters — real usage_metrics, live tenants only */}
      {dataMode === 'live' && <LiveUsageStrip />}

      {/* Monthly value summary — same derivation as the dashboard bar (src/data/roi.ts) */}
      {(() => {
        const roi = computeRoi(activeCompanyId);
        return (
          <div className="bg-slate-900 border border-emerald-500/25 rounded-xl px-4 py-3 mb-4" title={roi.formula}>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[9px] font-bold tracking-widest text-emerald-400 uppercase">Monthly value summary</span>
              <span className="text-sm text-slate-200">
                {roi.tasks.toLocaleString()} tasks · ~{roiK(roi.humanCost)} equivalent human cost · {roiK(roi.deCost)} DE cost —{' '}
                <span className="text-emerald-300 font-semibold">{roi.savingsPct}% savings (~{roiK(roi.savings)})</span>
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Estimate vs human baseline: sum over each DE of tasks × cost-per-task, against the same tasks at the per-DE human baseline shown below. No precision beyond what this page already asserts.
            </p>
          </div>
        );
      })()}

      {/* Company benchmark row — reuses WorkforceDEsPage wording */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 flex items-center gap-4 flex-wrap mb-6">
        <span className="text-xs text-slate-500">Company average:</span>
        <span className="text-xs text-slate-400">Resolution <span className="text-slate-200">{bench.resolution}%</span></span>
        <span className="text-slate-700">|</span>
        <span className="text-xs text-slate-400">Confidence <span className="text-slate-200">{bench.confidence}%</span></span>
        <span className="text-slate-700">|</span>
        <span className="text-xs text-slate-400">Escalation <span className="text-slate-200">{bench.escalation}%</span></span>
        <span className="text-slate-700">|</span>
        <span className="text-xs text-slate-400">AI Resolution (org) <span className="text-slate-200">{summary.aiResolution}%</span></span>
      </div>

      {/* Per-DE scorecards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {des.map(de => (
          <div key={de.name} className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold">{de.name[0]}</span>
                <div>
                  <p className="text-sm font-semibold text-white">{de.name}</p>
                  <p className="text-[11px] text-slate-500">{de.role}</p>
                </div>
              </div>
              <button onClick={() => setPage('workforce_des')} className="text-xs text-slate-500 hover:text-indigo-300 transition-colors">Profile →</button>
            </div>

            <div className="flex items-center justify-between mb-4">
              <div>
                <p className={`text-2xl font-bold ${metricColor('resolution', de.resolutionRate)}`}>{de.resolutionRate}%</p>
                <p className="text-[10px] text-slate-500 uppercase tracking-wide">Resolution rate</p>
              </div>
              <div className="text-right">
                <Sparkline data={de.trend} />
                <p className="text-[10px] text-slate-600 mt-0.5">6-month trend</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Confidence', value: `${de.confidence}%`, color: metricColor('confidence', de.confidence) },
                { label: 'Escalation', value: `${de.escalationRate}%`, color: metricColor('escalation', de.escalationRate) },
                { label: 'Error rate', value: `${de.errorRate}%`, color: metricColor('error', de.errorRate) },
              ].map(m => (
                <div key={m.label} className="bg-slate-950 rounded-lg px-2 py-2 text-center">
                  <p className={`text-sm font-semibold ${m.color}`}>{m.value}</p>
                  <p className="text-[9px] text-slate-500 uppercase tracking-wide">{m.label}</p>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500 bg-slate-950 rounded-lg px-3 py-2">
              <span>{de.tasksThisMonth} tasks this month</span>
              <span className="text-slate-300">{de.costPerTask} / task</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Cost efficiency */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-white mb-1">Cost efficiency</h3>
          <p className="text-xs text-slate-500 mb-4">$ per resolved task vs human baseline</p>
          <div className="space-y-3">
            {des.map(de => {
              const deCost = parseFloat(de.costPerTask.replace('$', ''));
              const humanCost = parseFloat(de.humanBaseline.replace('$', ''));
              const pct = Math.round((deCost / humanCost) * 100);
              return (
                <div key={de.name}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-slate-300">{de.name}</span>
                    <span className="text-slate-400">
                      <span className="text-emerald-400 font-medium">{de.costPerTask}</span>
                      <span className="text-slate-600"> vs </span>
                      <span className="text-slate-400">{de.humanBaseline} human baseline</span>
                    </span>
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.max(pct, 3)}%` }} />
                  </div>
                  <p className="text-[10px] text-slate-600 mt-0.5">{100 - pct}% cheaper than the human baseline for this work</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* CSAT proxy */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-white mb-1">CSAT proxy</h3>
          <p className="text-xs text-slate-500 mb-4">Derived from thumbs-up ratio, reopen rate, and escalation outcomes</p>
          <div className="space-y-2">
            {des.map((de, i) => {
              const csat = [4.6, 4.4, 4.1, 4.5, 4.7][i] ?? 4.3;
              return (
                <div key={de.name} className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2.5">
                  <span className="text-xs text-slate-300">{de.name}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-amber-400 text-xs">{'★'.repeat(Math.round(csat))}{'☆'.repeat(5 - Math.round(csat))}</span>
                    <span className="text-sm font-medium text-white">{csat.toFixed(1)}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-600 mt-3">Proxy only — connect a survey source in Connectors for direct CSAT.</p>
        </div>
      </div>
    </div>
  );
}

// ── Real Performance page (live tenants) — migrations 093-095 ──
function LivePerformancePage({ tenantId, setPage }: { tenantId: string; setPage: (p: Page) => void }) {
  const [des, setDes] = useState<DigitalEmployee[]>([]);
  const [metrics, setMetrics] = useState<DePerformanceMetrics[]>([]);
  const [cost, setCost] = useState<DeCostMetrics[]>([]);
  const [csat, setCsat] = useState<DeCsatMetrics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listDigitalEmployees(),
      getDePerformanceMetrics(tenantId),
      getDeCostMetrics(tenantId),
      getDeCsatMetrics(tenantId),
    ]).then(([d, m, c, s]) => {
      if (cancelled) return;
      setDes(d);
      setMetrics(m);
      setCost(c);
      setCsat(s);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tenantId]);

  const metricsByDe = new Map(metrics.map(m => [m.de_id, m]));
  const costByDe = new Map(cost.map(c => [c.de_id, c]));
  const csatByDe = new Map(csat.map(c => [c.de_id, c]));

  const totalDecisions = metrics.reduce((s, m) => s + m.total_decisions, 0);
  const totalCostUsd = cost.reduce((s, c) => s + c.total_cost_usd, 0);

  if (loading) {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageHeader title="Performance Analytics" subtitle="Loading real Digital Employee activity…" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Performance Analytics"
        subtitle={`${des.length} DE${des.length === 1 ? '' : 's'} · ${totalDecisions.toLocaleString()} inquiries handled this period`}
      />

      <LiveUsageStrip />

      {totalCostUsd > 0 && (
        <div className="bg-slate-900 border border-emerald-500/25 rounded-xl px-4 py-3 mb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[9px] font-bold tracking-widest text-emerald-400 uppercase">Real AI usage cost</span>
            <span className="text-sm text-slate-200">
              ${totalCostUsd.toFixed(2)} across {cost.reduce((s, c) => s + c.total_calls, 0).toLocaleString()} LLM calls this period
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Computed from real token usage on every completion — no assumed human-cost comparison, since there's no real baseline to compare against yet.
          </p>
        </div>
      )}

      {des.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-sm text-slate-500">
          No Digital Employees yet — add one under Workforce to start seeing real performance data here.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          {des.map(de => {
            const m = metricsByDe.get(de.id);
            const c = costByDe.get(de.id);
            const trend = m?.trend ?? [];
            const trendValues = trend.map(t => t.resolution_rate);
            return (
              <div key={de.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold">{de.name[0]}</span>
                    <div>
                      <p className="text-sm font-semibold text-white">{de.name}</p>
                      <p className="text-[11px] text-slate-500">{de.description || de.category}</p>
                    </div>
                  </div>
                  <button onClick={() => setPage('workforce_des')} className="text-xs text-slate-500 hover:text-indigo-300 transition-colors">Profile →</button>
                </div>

                {!m || m.total_decisions === 0 ? (
                  <p className="text-xs text-slate-600 py-4 text-center">No real activity recorded yet.</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <p className={`text-2xl font-bold ${metricColor('resolution', m.resolution_rate)}`}>{m.resolution_rate}%</p>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wide">Resolution rate</p>
                      </div>
                      {trendValues.length > 1 && (
                        <div className="text-right">
                          <Sparkline data={trendValues} />
                          <p className="text-[10px] text-slate-600 mt-0.5">{trend.length}-week trend</p>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                      {[
                        { label: 'Confidence', value: `${m.avg_confidence}%`, color: metricColor('confidence', m.avg_confidence) },
                        { label: 'Escalation', value: `${m.escalation_rate}%`, color: metricColor('escalation', m.escalation_rate) },
                        { label: 'Error rate', value: `${m.error_rate}%`, color: metricColor('error', m.error_rate) },
                        { label: 'Frustration', value: `${m.avg_frustration_score}%`, color: metricColor('frustration', m.avg_frustration_score) },
                      ].map(x => (
                        <div key={x.label} className="bg-slate-950 rounded-lg px-2 py-2 text-center">
                          <p className={`text-sm font-semibold ${x.color}`}>{x.value}</p>
                          <p className="text-[9px] text-slate-500 uppercase tracking-wide">{x.label}</p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500 bg-slate-950 rounded-lg px-3 py-2">
                      <span>{m.total_decisions} inquiries this period{m.high_frustration_count > 0 ? ` · ${m.high_frustration_count} auto-escalated for frustration` : ''}</span>
                      {c && c.total_calls > 0 && (
                        <span className="text-slate-300">${(c.total_cost_usd / c.total_calls).toFixed(4)} / call</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-white mb-1">Customer satisfaction (CSAT)</h3>
        <p className="text-xs text-slate-500 mb-4">Real thumbs-up/down from the support widget and portal chat</p>
        {csat.length === 0 ? (
          <p className="text-xs text-slate-600">No ratings submitted yet.</p>
        ) : (
          <div className="space-y-2">
            {csat.map(c => {
              const de = des.find(d => d.id === c.de_id);
              return (
                <div key={c.de_id} className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2.5">
                  <span className="text-xs text-slate-300">{de?.name ?? 'Unknown DE'}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">{c.total_ratings} rating{c.total_ratings === 1 ? '' : 's'}</span>
                    <span className={`text-sm font-medium ${c.csat_pct >= 70 ? 'text-emerald-400' : c.csat_pct >= 40 ? 'text-amber-400' : 'text-red-400'}`}>{c.csat_pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Insights
// ══════════════════════════════════════════════════════════════════

type InsightKind = 'anomaly' | 'retraining' | 'config_drift' | 'trend';

interface Insight {
  kind: InsightKind;
  title: string;
  detail: string;
  page: Page;
  pageLabel: string;
  severity: 'high' | 'medium' | 'low';
}

const TCP_INSIGHTS: Insight[] = [
  {
    kind: 'anomaly', severity: 'high',
    title: 'Alex escalation rate +40% WoW on billing topics',
    detail: 'Correlates with open knowledge gap "Multi-currency invoicing" — 11 queries missed this week. Resolving the gap is projected to recover ~6 points of resolution rate.',
    page: 'knowledge_gaps', pageLabel: 'Open Gap Detection',
  },
  {
    kind: 'anomaly', severity: 'medium',
    title: 'Riley resolution rate declining 5 points over 6 months',
    detail: '84% → 79% since January. Trend correlates with the overdue recertification (due 2026-06-01) and the recurring Workday connector errors.',
    page: 'workforce_des', pageLabel: "Open Riley's profile",
  },
  {
    kind: 'retraining', severity: 'high',
    title: 'Riley recertification overdue — schedule now',
    detail: 'Recert was due 2026-06-01. Two training modules are incomplete (Workday HRIS Fundamentals 65%, GDPR & Employee Data 40%).',
    page: 'workforce_des', pageLabel: 'Open Digital Employees',
  },
  {
    kind: 'retraining', severity: 'medium',
    title: 'Alex: PII Handling module at 78% — completion recommended',
    detail: 'Completing "PII Handling & GDPR Basics" before the SOC 2 checkpoint (Jul 20) strengthens the audit evidence package.',
    page: 'workforce_des', pageLabel: 'Open Digital Employees',
  },
  {
    kind: 'config_drift', severity: 'medium',
    title: 'Casey discount override used 6× this month',
    detail: 'The 20% discount ceiling was overridden six times, all approved. Consider raising the template limit to 22% to remove approval friction — or tightening the save-offer playbook.',
    page: 'gov_compliance', pageLabel: 'Open Compliance & Guardrails',
  },
  {
    kind: 'anomaly', severity: 'low',
    title: 'Workday connector error rate above threshold',
    detail: '3 sync failures in 24 hrs blocked onboarding automations. Riley error rate (4%) is approaching the 5% amber threshold.',
    page: 'systems_connectors', pageLabel: 'Open Connectors',
  },
];

const PWC_INSIGHTS: Insight[] = [
  {
    kind: 'anomaly', severity: 'high',
    title: 'GDPR request breached statutory SLA',
    detail: 'One data-subject request passed the 30-day window before escalation. Recommend lowering the escalation trigger from day 24 to day 20.',
    page: 'outcome_risk', pageLabel: 'Open Risk Posture',
  },
  {
    kind: 'anomaly', severity: 'medium',
    title: 'Avery escalation rate 16% — highest in the org',
    detail: 'Driven by the "FATCA filing for dual-nationals" knowledge gap and the mandatory partner-review policy. Gap resolution is in progress.',
    page: 'knowledge_gaps', pageLabel: 'Open Gap Detection',
  },
  {
    kind: 'retraining', severity: 'medium',
    title: 'Avery: International Tax module at 72%',
    detail: 'Completing FATCA/FBAR training is projected to cut dual-national escalations by half.',
    page: 'workforce_des', pageLabel: 'Open Digital Employees',
  },
  {
    kind: 'config_drift', severity: 'low',
    title: 'Morgan review-gate threshold raised twice this quarter',
    detail: '70% → 72% by Risk & Compliance. Monitor whether partner review volume stays manageable; a third raise should go through governance review.',
    page: 'gov_compliance', pageLabel: 'Open Compliance & Guardrails',
  },
];

const INSIGHTS: Record<CompanyId, Insight[]> = { tcp: TCP_INSIGHTS, pwc: PWC_INSIGHTS };

const KIND_META: Record<InsightKind, { label: string; cls: string }> = {
  anomaly: { label: 'ANOMALY', cls: 'bg-red-500/15 text-red-300' },
  retraining: { label: 'RETRAINING', cls: 'bg-blue-500/15 text-blue-300' },
  config_drift: { label: 'CONFIG DRIFT', cls: 'bg-amber-500/15 text-amber-300' },
  trend: { label: 'TREND', cls: 'bg-indigo-500/15 text-indigo-300' },
};

export function InsightsPage({ setPage }: { setPage: (p: Page) => void }) {
  const dataMode = useDataMode();
  const { currentTenant } = useAuth();
  if (dataMode === 'live' && currentTenant?.id) {
    return <LiveInsightsPage tenantId={currentTenant.id} setPage={setPage} />;
  }
  return <DemoInsightsPage setPage={setPage} />;
}

function DemoInsightsPage({ setPage }: { setPage: (p: Page) => void }) {
  const { activeCompanyId } = useAuth();
  const insights = INSIGHTS[activeCompanyId];
  const des = METRICS[activeCompanyId];

  const trendCards = des.map(de => {
    const delta = de.trend[de.trend.length - 1] - de.trend[0];
    return { name: de.name, delta, trend: de.trend };
  });

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Business Insights"
        subtitle="Anomaly detection, retraining recommendations, and configuration-drift signals across the DE workforce"
      />

      {/* Trend cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {trendCards.map(t => (
          <div key={t.name} className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white">{t.name}</p>
              <p className={`text-xs ${t.delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {t.delta >= 0 ? '↑' : '↓'} {Math.abs(t.delta)} pts resolution · 6 months
              </p>
            </div>
            <Sparkline data={t.trend} color={t.delta >= 0 ? '#34d399' : '#f87171'} />
          </div>
        ))}
      </div>

      {/* Insight feed */}
      <div className="space-y-3">
        {insights.map(ins => (
          <div
            key={ins.title}
            className={`rounded-xl border p-4 ${
              ins.severity === 'high' ? 'border-red-500/30 bg-red-500/5'
              : ins.severity === 'medium' ? 'border-amber-500/25 bg-amber-500/5'
              : 'border-slate-800 bg-slate-900'
            }`}
          >
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${KIND_META[ins.kind]?.cls}`}>{KIND_META[ins.kind]?.label ?? ins.kind}</span>
              <span className="text-sm font-medium text-white">{ins.title}</span>
              <span className={`ml-auto text-[10px] uppercase px-1.5 py-0.5 rounded ${
                ins.severity === 'high' ? 'bg-red-500/15 text-red-300' : ins.severity === 'medium' ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-800 text-slate-400'
              }`}>{ins.severity}</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed mb-2">{ins.detail}</p>
            <button onClick={() => setPage(ins.page)} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              {ins.pageLabel} →
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Real Insights page (live tenants) — migration 096 ──
// Anomaly: computed here from get_de_performance_metrics' real weekly
// trend (no separate RPC needed). Config-drift + eval-failure: real
// signals from migration 096, replacing invented narrative text.
function LiveInsightsPage({ tenantId, setPage }: { tenantId: string; setPage: (p: Page) => void }) {
  const [des, setDes] = useState<DigitalEmployee[]>([]);
  const [metrics, setMetrics] = useState<DePerformanceMetrics[]>([]);
  const [guardrails, setGuardrails] = useState<DeGuardrailActivity[]>([]);
  const [evalFailures, setEvalFailures] = useState<RecentEvalFailure[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listDigitalEmployees(),
      getDePerformanceMetrics(tenantId),
      getDeGuardrailActivity(tenantId),
      getRecentEvalFailures(tenantId),
    ]).then(([d, m, g, e]) => {
      if (cancelled) return;
      setDes(d); setMetrics(m); setGuardrails(g); setEvalFailures(e);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tenantId]);

  // Anomaly: this week's escalation rate vs. the trailing average of
  // prior weeks in the same real trend data get_de_performance_metrics
  // already returns — a genuine week-over-week comparison, not invented text.
  const anomalies = metrics.flatMap(m => {
    if (m.trend.length < 2) return [];
    const latest = m.trend[m.trend.length - 1];
    const prior = m.trend.slice(0, -1);
    const priorAvgEscalation = prior.reduce((s, t) => s + (100 - t.resolution_rate), 0) / prior.length;
    const latestEscalation = 100 - latest.resolution_rate;
    const delta = latestEscalation - priorAvgEscalation;
    if (delta < 15) return [];
    return [{
      deName: m.de_name,
      detail: `Escalation rate ${latestEscalation.toFixed(0)}% the week of ${latest.week}, up from a ${priorAvgEscalation.toFixed(0)}% trailing average.`,
    }];
  });

  const trendCards = metrics.filter(m => m.trend.length > 1).map(m => {
    const delta = m.trend[m.trend.length - 1].resolution_rate - m.trend[0].resolution_rate;
    return { name: m.de_name, delta, trend: m.trend.map(t => t.resolution_rate) };
  });

  if (loading) {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageHeader title="Business Insights" subtitle="Loading real signals…" />
      </div>
    );
  }

  const hasAnySignal = anomalies.length > 0 || guardrails.length > 0 || evalFailures.length > 0;

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Business Insights"
        subtitle="Real anomaly, guardrail, and Proving Ground signals from your Digital Employee workforce"
      />

      {trendCards.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {trendCards.map(t => (
            <div key={t.name} className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-white">{t.name}</p>
                <p className={`text-xs ${t.delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {t.delta >= 0 ? '↑' : '↓'} {Math.abs(t.delta).toFixed(0)} pts resolution rate
                </p>
              </div>
              <Sparkline data={t.trend} color={t.delta >= 0 ? '#34d399' : '#f87171'} />
            </div>
          ))}
        </div>
      )}

      {!hasAnySignal ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-sm text-slate-500">
          No anomalies, guardrail overrides, or Proving Ground failures in this period — nothing needs attention right now.
        </div>
      ) : (
        <div className="space-y-3">
          {anomalies.map(a => (
            <div key={a.deName} className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">ANOMALY</span>
                <span className="text-sm font-medium text-white">{a.deName} escalation rate spiked</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">{a.detail}</p>
            </div>
          ))}

          {guardrails.map((g, i) => (
            <div key={g.de_id ?? `tenant-${i}`} className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">CONFIG DRIFT</span>
                <span className="text-sm font-medium text-white">
                  {g.de_name ? `${g.de_name}: ${g.gated_count + g.blocked_count} guardrail event(s)` : 'Guardrail activity recorded'}
                </span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                {g.de_name
                  ? `${g.gated_count} gated, ${g.blocked_count} blocked in the last 30 days.`
                  : `${g.tenant_total_events} guardrail event(s) recorded tenant-wide, but none could be matched to a currently-named Digital Employee (likely renamed since).`}
              </p>
              <button onClick={() => setPage('gov_compliance')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors mt-2">
                Open Compliance & Guardrails →
              </button>
            </div>
          ))}

          {evalFailures.map(e => (
            <div key={e.id} className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300">PROVING GROUND</span>
                <span className="text-sm font-medium text-white">{e.failed} of {e.total} scenarios failed</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                {e.trigger} eval run on {new Date(e.started_at).toLocaleDateString()} — {e.passed} passed, {e.failed} failed.
                Tenant-wide (Proving Ground runs aren't yet attributed to one Digital Employee).
              </p>
              <button onClick={() => setPage('intelligence_evals')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors mt-2">
                Open Proving Ground →
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
