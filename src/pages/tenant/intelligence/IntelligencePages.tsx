import React, { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { fetchMonthlyUsage, MonthlyUsage } from '../../../lib/usageApi';
import { PageHeader } from '../../../components/ui';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import {
  getDePerformanceMetrics, getDeCsatMetrics, getDeActionMetrics, getOutcomeMetering, getBenchmarkReport,
  getDeInquiryMetrics, getDeCostMetricsRanged,
  getDeGuardrailActivity, getRecentEvalFailures,
  type DePerformanceMetrics, type DeCostMetrics, type DeCsatMetrics, type DeActionMetrics,
  type DeInquiryMetrics, type DeGuardrailActivity, type RecentEvalFailure,
  type OutcomeMetering, type BenchmarkReport,
} from '../../../lib/api';
import { listDigitalEmployees, type DigitalEmployee } from '../../../lib/digitalEmployeesApi';
import { useOpenEmployeeFile } from '../../../lib/employeeFileRoute';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../../components/LiveDataStates';

// ── Shared per-DE metrics (numbers from WorkforceDEsPage) ─────────

interface DEMetrics {
  name: string;
  role: string;
  resolutionRate: number;
  confidence: number;
  escalationRate: number;
  errorRate: number;
  tasksThisMonth: number;   // inquiries handled
  actionsTaken: number;     // real actions completed
  autoActions: number;      // of those, done without a human
  sentToHuman: number;      // routed for approval
  blockedActions: number;   // stopped by guardrail/access
  trend: number[];          // resolution trend for sparkline
  costPerTask: string;
  humanBaseline: string;
}

const TCP_METRICS: DEMetrics[] = [
  { name: 'Alex', role: 'Customer Support DE', resolutionRate: 88, confidence: 91, escalationRate: 12, errorRate: 2, tasksThisMonth: 847, actionsTaken: 612, autoActions: 548, sentToHuman: 64, blockedActions: 4, trend: [82, 84, 83, 86, 87, 88], costPerTask: '$1.40', humanBaseline: '$14.20' },
  { name: 'Casey', role: 'Renewal DE', resolutionRate: 92, confidence: 88, escalationRate: 8, errorRate: 1, tasksThisMonth: 312, actionsTaken: 236, autoActions: 176, sentToHuman: 60, blockedActions: 2, trend: [88, 89, 91, 90, 92, 92], costPerTask: '$2.10', humanBaseline: '$31.50' },
  { name: 'Riley', role: 'HR & People DE', resolutionRate: 79, confidence: 83, escalationRate: 14, errorRate: 4, tasksThisMonth: 178, actionsTaken: 94, autoActions: 58, sentToHuman: 36, blockedActions: 3, trend: [84, 83, 81, 80, 79, 79], costPerTask: '$1.85', humanBaseline: '$18.70' },
];

const PWC_METRICS: DEMetrics[] = [
  { name: 'Morgan', role: 'Client Relations DE', resolutionRate: 85, confidence: 87, escalationRate: 10, errorRate: 2, tasksThisMonth: 241, actionsTaken: 152, autoActions: 116, sentToHuman: 36, blockedActions: 1, trend: [80, 82, 83, 84, 85, 85], costPerTask: '$2.60', humanBaseline: '$42.00' },
  { name: 'Avery', role: 'Tax Research DE', resolutionRate: 82, confidence: 91, escalationRate: 16, errorRate: 1, tasksThisMonth: 94, actionsTaken: 41, autoActions: 22, sentToHuman: 19, blockedActions: 0, trend: [78, 79, 80, 81, 82, 82], costPerTask: '$6.80', humanBaseline: '$185.00' },
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
    <div className="bg-dt-card border border-indigo-500/25 rounded-xl px-4 py-3 mb-4">
      <div className="flex items-center gap-4 flex-wrap">
        <span className="text-[9px] font-bold tracking-widest text-indigo-400 uppercase">Live usage (this month)</span>
        {items.map(m => (
          <span key={m.label} className="text-xs text-dt-support">
            {m.label} <span className="text-dt-body font-semibold">{m.value.toLocaleString()}</span>
          </span>
        ))}
      </div>
      <p className="text-[11px] text-dt-muted mt-1">
        Real counters from your Digital Employee — recorded per inquiry by the answering service.
      </p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Performance
// ══════════════════════════════════════════════════════════════════

export function PerformancePage({ setPage }: { setPage: (p: Page) => void }) {
  const { currentTenant } = useAuth();
  if (currentTenant?.id) {
    return <LivePerformancePage tenantId={currentTenant.id} setPage={setPage} />;
  }
}


// ── Real Performance page (live tenants) — migrations 093-095 ──
const RANGE_OPTIONS: { label: string; days: number | null }[] = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All time', days: null },
];
function RangeSelector({ value, onChange }: { value: number | null; onChange: (d: number | null) => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-dt-card border border-dt-border rounded-lg p-0.5">
      {RANGE_OPTIONS.map(o => (
        <button
          key={o.label}
          onClick={() => onChange(o.days)}
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${value === o.days ? 'bg-indigo-600 text-white' : 'text-dt-support hover:text-dt-body'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-dt-card border border-dt-border rounded-xl px-4 py-3">
      <div className={`text-2xl font-bold tabular-nums ${tone ?? 'text-white'}`}>{value}</div>
      <div className="text-[11px] text-dt-support mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-dt-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function LivePerformancePage({ tenantId, setPage }: { tenantId: string; setPage: (p: Page) => void }) {
  const openFile = useOpenEmployeeFile(setPage);
  const [des, setDes] = useState<DigitalEmployee[]>([]);
  const [metrics, setMetrics] = useState<DePerformanceMetrics[]>([]); // all-time — trend + frustration only
  const [inquiry, setInquiry] = useState<DeInquiryMetrics[]>([]);     // windowed counts + quality
  const [cost, setCost] = useState<DeCostMetrics[]>([]);              // windowed cost
  const [csat, setCsat] = useState<DeCsatMetrics[]>([]);             // all-time satisfaction
  const [actions, setActions] = useState<DeActionMetrics[]>([]);      // windowed actions
  const [metering, setMetering] = useState<OutcomeMetering | null>(null); // windowed outcome value
  const [range, setRange] = useState<number | null>(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listDigitalEmployees(),
      getDePerformanceMetrics(tenantId),
      getDeInquiryMetrics(tenantId, range),
      getDeCostMetricsRanged(tenantId, range),
      getDeCsatMetrics(tenantId),
      getDeActionMetrics(tenantId, range),
      getOutcomeMetering(tenantId, range),
    ]).then(([d, m, iq, c, s, a, om]) => {
      if (cancelled) return;
      setDes(d); setMetrics(m); setInquiry(iq); setCost(c); setCsat(s); setActions(a); setMetering(om);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tenantId, range]);

  const metricsByDe = new Map(metrics.map(m => [m.de_id, m]));
  const inquiryByDe = new Map(inquiry.map(i => [i.de_id, i]));
  const costByDe = new Map(cost.map(c => [c.de_id, c]));
  const csatByDe = new Map(csat.map(c => [c.de_id, c]));
  const actionByDe = new Map(actions.map(a => [a.de_id, a]));

  // Workforce-level outcome roll-ups — every count reflects the range.
  const totalInquiries = inquiry.reduce((s, i) => s + i.total_decisions, 0);
  const totalExecuted = actions.reduce((s, a) => s + a.executed, 0);
  const totalAuto = actions.reduce((s, a) => s + a.auto_executed, 0);
  const totalSentHuman = actions.reduce((s, a) => s + a.sent_to_human, 0);
  const totalBlocked = actions.reduce((s, a) => s + a.blocked, 0);
  const totalFailed = actions.reduce((s, a) => s + a.failed, 0);
  const workforceAutonomy = totalExecuted > 0 ? Math.round(100 * totalAuto / totalExecuted) : null;
  const totalCostUsd = cost.reduce((s, c) => s + c.total_cost_usd, 0);
  const totalCalls = cost.reduce((s, c) => s + c.total_calls, 0);
  const anyActivity = totalInquiries > 0 || actions.some(a => a.total_events > 0);

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <PageHeader title="Performance" subtitle="What your workforce got done" />
          <RangeSelector value={range} onChange={setRange} />
        </div>
        <LiveLoadingSkeleton rows={4} />
      </div>
    );
  }

  const rangeLabel = RANGE_OPTIONS.find(o => o.days === range)?.label ?? '30 days';

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <PageHeader
          title="Performance"
          subtitle={`${des.length} Digital Employee${des.length === 1 ? '' : 's'} · what your workforce got done · ${rangeLabel === 'All time' ? 'all time' : `last ${rangeLabel}`}`}
        />
        <RangeSelector value={range} onChange={setRange} />
      </div>

      <LiveUsageStrip />

      {/* Outcome roll-up — the headline is throughput and autonomy, not
          abstract AI-health scores. Every number is real. */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <StatTile label="Inquiries handled" value={totalInquiries.toLocaleString()} sub="questions answered" />
        <StatTile label="Actions taken" value={totalExecuted.toLocaleString()} tone="text-emerald-400"
          sub={`${totalAuto} on their own · ${Math.max(0, totalExecuted - totalAuto)} after approval`} />
        <StatTile label="Autonomy" value={workforceAutonomy != null ? `${workforceAutonomy}%` : '—'}
          tone={workforceAutonomy != null && workforceAutonomy >= 60 ? 'text-emerald-400' : 'text-dt-body'}
          sub="of actions, done without a human" />
        <StatTile label="Sent to your team" value={totalSentHuman.toLocaleString()}
          tone={totalSentHuman > 0 ? 'text-amber-300' : 'text-dt-body'} sub="approvals routed to people" />
        <StatTile label="AI cost" value={`$${totalCostUsd.toFixed(2)}`} sub={`${totalCalls.toLocaleString()} model calls`} />
      </div>

      {/* Outcome metering (#15): per-resolution value, escalations free.
          Shown only once real outcomes exist — no fabricated revenue. */}
      {metering && (metering.totals.resolutions > 0 || metering.totals.escalations > 0) && (
        <div className="bg-dt-card border border-dt-border rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <p className="text-sm font-semibold text-white">Outcome value</p>
            <p className="text-[11px] text-dt-muted">metered at ${(metering.price_per_resolution_cents / 100).toFixed(2)} per resolution · escalations to your team are free</p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-2xl font-semibold text-emerald-400">{metering.totals.resolutions.toLocaleString()}</p>
              <p className="text-[11px] text-dt-muted mt-0.5">resolutions delivered</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-dt-body">{metering.totals.escalations.toLocaleString()}</p>
              <p className="text-[11px] text-dt-muted mt-0.5">handed to your team (free)</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-white">${(metering.totals.billable_amount_cents / 100).toFixed(2)}</p>
              <p className="text-[11px] text-dt-muted mt-0.5">metered value this period</p>
            </div>
          </div>
          {metering.by_de.length > 1 && (
            <div className="mt-3 pt-3 border-t border-dt-border space-y-1">
              {metering.by_de.slice(0, 6).map((d, i) => (
                <div key={d.de_id ?? i} className="flex items-center gap-3 text-xs">
                  <span className="text-dt-support flex-1 truncate">{d.name}</span>
                  <span className="text-dt-muted">{d.resolutions} resolved · {d.escalations} handed off</span>
                  <span className="text-dt-body font-medium w-16 text-right">${(d.amount_cents / 100).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(totalBlocked > 0 || totalFailed > 0) && (
        <div className="bg-dt-card border border-dt-border rounded-xl px-4 py-2.5 mb-6 text-xs text-dt-support flex items-center gap-4 flex-wrap">
          <span className="text-dt-muted">Safety net this period:</span>
          {totalBlocked > 0 && <span><span className="text-rose-300 font-medium">{totalBlocked}</span> action{totalBlocked === 1 ? '' : 's'} blocked by a guardrail or access rule</span>}
          {totalFailed > 0 && <span><span className="text-red-400 font-medium">{totalFailed}</span> failed and recorded honestly</span>}
        </div>
      )}

      {des.length === 0 ? (
        <LiveEmptyState icon="◎" title="No Digital Employees yet" body="Add one under Workforce to start seeing real performance here." />
      ) : !anyActivity ? (
        <LiveEmptyState
          icon="◎"
          title="No activity yet"
          body="Your employees are set up, but haven't handled real work yet. Activity appears here as they answer inquiries and take actions."
          primaryLabel="Watch DE at Work"
          onPrimary={() => setPage('ops_de_activity')}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {des.map(de => {
            const m = metricsByDe.get(de.id);   // all-time — trend only
            const iq = inquiryByDe.get(de.id);  // windowed counts + quality
            const a = actionByDe.get(de.id);
            const c = costByDe.get(de.id);
            const s = csatByDe.get(de.id);
            const trend = m?.trend ?? [];
            const trendValues = trend.map(t => t.resolution_rate);
            const inquiriesHandled = iq?.total_decisions ?? 0;
            const hasActivity = inquiriesHandled > 0 || (a && a.total_events > 0);
            const acted = a?.executed ?? 0;
            return (
              <div key={de.id} className="bg-dt-card border border-dt-border rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold">{(de.persona_name ?? de.name)[0]}</span>
                    <div>
                      <p className="text-sm font-semibold text-white">{de.persona_name ?? de.name}</p>
                      <p className="text-[11px] text-dt-muted">{de.persona_name ? de.name : (de.description || de.category)}</p>
                    </div>
                  </div>
                  <button onClick={() => openFile(de.id)} className="text-xs text-dt-muted hover:text-indigo-300 transition-colors">Employee File →</button>
                </div>

                {!hasActivity ? (
                  <p className="text-xs text-dt-faint py-4 text-center">No activity recorded yet.</p>
                ) : (
                  <>
                    {/* What it DID — the headline */}
                    <div className="flex items-end justify-between mb-3">
                      <div>
                        <p className="text-3xl font-bold text-emerald-400 tabular-nums">{acted}</p>
                        <p className="text-[10px] text-dt-muted uppercase tracking-wide">actions taken</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-semibold text-dt-body tabular-nums">{inquiriesHandled}</p>
                        <p className="text-[10px] text-dt-muted uppercase tracking-wide">inquiries handled</p>
                      </div>
                      {trendValues.length > 1 && (
                        <div className="text-right">
                          <Sparkline data={trendValues} />
                          <p className="text-[10px] text-dt-faint mt-0.5">{trend.length}-wk trend</p>
                        </div>
                      )}
                    </div>

                    {/* Work breakdown from real action_executions */}
                    {a && a.total_events > 0 && (
                      <>
                        <div className="grid grid-cols-4 gap-2 mb-2">
                          {[
                            { label: 'On its own', value: a.auto_executed, color: 'text-emerald-400' },
                            { label: 'After approval', value: a.approved_after_gate, color: 'text-dt-body' },
                            { label: 'Sent to human', value: a.sent_to_human, color: a.sent_to_human > 0 ? 'text-amber-300' : 'text-dt-support' },
                            { label: 'Blocked', value: a.blocked + a.failed, color: (a.blocked + a.failed) > 0 ? 'text-rose-300' : 'text-dt-support' },
                          ].map(x => (
                            <div key={x.label} className="bg-dt-page rounded-lg px-2 py-2 text-center">
                              <p className={`text-sm font-semibold tabular-nums ${x.color}`}>{x.value}</p>
                              <p className="text-[9px] text-dt-muted uppercase tracking-wide">{x.label}</p>
                            </div>
                          ))}
                        </div>
                        {a.autonomy_rate != null && (
                          <div className="mb-3">
                            <div className="flex items-center justify-between text-[10px] text-dt-muted mb-1">
                              <span>Autonomy — done without a human</span>
                              <span className="text-dt-support font-medium">{a.autonomy_rate}%</span>
                            </div>
                            <div className="h-1.5 rounded-full bg-dt-page overflow-hidden">
                              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${a.autonomy_rate}%` }} />
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {/* Quality — the second dimension, not the headline */}
                    <div className="border-t border-dt-border pt-3">
                      <p className="text-[10px] text-dt-muted uppercase tracking-wide mb-2">Answer quality</p>
                      <div className="grid grid-cols-3 gap-2">
                        {iq && iq.total_decisions > 0 ? [
                          { label: 'Resolution', value: `${iq.resolution_rate}%`, color: metricColor('resolution', iq.resolution_rate) },
                          { label: 'Confidence', value: `${iq.avg_confidence}%`, color: metricColor('confidence', iq.avg_confidence) },
                          { label: 'CSAT (all-time)', value: s && s.total_ratings > 0 ? `${s.csat_pct}%` : '—', color: s && s.total_ratings > 0 ? (s.csat_pct >= 70 ? 'text-emerald-400' : s.csat_pct >= 40 ? 'text-amber-400' : 'text-red-400') : 'text-dt-muted' },
                        ].map(x => (
                          <div key={x.label} className="bg-dt-page rounded-lg px-2 py-2 text-center">
                            <p className={`text-sm font-semibold ${x.color}`}>{x.value}</p>
                            <p className="text-[9px] text-dt-muted uppercase tracking-wide">{x.label}</p>
                          </div>
                        )) : (
                          <p className="col-span-3 text-[11px] text-dt-faint text-center py-1">This employee acts but hasn't answered inquiries yet.</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[11px] text-dt-muted bg-dt-page rounded-lg px-3 py-2">
                      <span>{m?.high_frustration_count ? `${m.high_frustration_count} auto-escalated for frustration` : `${a?.total_events ?? 0} action event(s) logged`}</span>
                      {c && c.total_calls > 0 && (
                        <span className="text-dt-support">${(c.total_cost_usd / c.total_calls).toFixed(4)} / call</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Insights
// ══════════════════════════════════════════════════════════════════

type InsightKind = 'anomaly' | 'retraining' | 'config_drift' | 'trend' | 'action_failed' | 'opportunity';

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
    kind: 'action_failed', severity: 'high',
    title: 'Riley: 3 Workday actions failed this week',
    detail: 'All three onboarding record-updates were rejected by Workday — the connector token has likely expired. Reconnect it to unblock the queue.',
    page: 'systems_connectors', pageLabel: 'Open Connectors',
  },
  {
    kind: 'opportunity', severity: 'low',
    title: 'Casey routed 60 renewals for approval',
    detail: 'Only 75% of Casey\'s actions ran without a human, and your team approved nearly all of them unchanged. Raise Casey\'s trust dial to clear the queue — guardrails still cap what it can do.',
    page: 'workforce_des', pageLabel: 'Open Digital Employees',
  },
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
    kind: 'opportunity', severity: 'low',
    title: 'Avery routed 19 filings for partner review',
    detail: 'About half of Avery\'s actions needed a human. That\'s expected for tax work — but if certain filing types are always approved, scope a narrower auto-approve rule for just those.',
    page: 'workforce_des', pageLabel: 'Open Digital Employees',
  },
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
  action_failed: { label: 'ACTION FAILED', cls: 'bg-red-500/15 text-red-300' },
  opportunity: { label: 'OPPORTUNITY', cls: 'bg-emerald-500/15 text-emerald-300' },
};

export function InsightsPage({ setPage }: { setPage: (p: Page) => void }) {
  const { currentTenant } = useAuth();
  if (currentTenant?.id) {
    return <LiveInsightsPage tenantId={currentTenant.id} setPage={setPage} />;
  }
}

function LiveInsightsPage({ tenantId, setPage }: { tenantId: string; setPage: (p: Page) => void }) {
  const openFile = useOpenEmployeeFile(setPage);
  const [des, setDes] = useState<DigitalEmployee[]>([]);
  const [metrics, setMetrics] = useState<DePerformanceMetrics[]>([]);
  const [guardrails, setGuardrails] = useState<DeGuardrailActivity[]>([]);
  const [evalFailures, setEvalFailures] = useState<RecentEvalFailure[]>([]);
  const [actions, setActions] = useState<DeActionMetrics[]>([]);
  const [benchmark, setBenchmark] = useState<BenchmarkReport | null>(null);
  const [range, setRange] = useState<number | null>(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listDigitalEmployees(),
      getDePerformanceMetrics(tenantId),
      getDeGuardrailActivity(tenantId),
      getRecentEvalFailures(tenantId),
      getDeActionMetrics(tenantId, range),
      getBenchmarkReport(tenantId, range),
    ]).then(([d, m, g, e, a, b]) => {
      if (cancelled) return;
      setDes(d); setMetrics(m); setGuardrails(g); setEvalFailures(e); setActions(a); setBenchmark(b);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tenantId, range]);

  const nameFor = (id: string) => { const d = des.find(x => x.id === id); return d ? (d.persona_name ?? d.name) : 'A Digital Employee'; };

  // Practical, action-derived insights — each names a concrete next step.
  // FAILED ACTIONS = an operational alarm (usually a broken connector).
  const actionFailures = actions
    .filter(a => a.failed > 0)
    .map(a => ({ de_id: a.de_id, name: nameFor(a.de_id), failed: a.failed, severity: a.failed >= 3 ? 'high' : 'medium' as const }));

  // Lots routed for approval + low autonomy = a trust-dial opportunity:
  // if the team keeps approving, raising the dial clears the queue.
  const approvalBottlenecks = actions
    .filter(a => a.sent_to_human >= 3 && (a.autonomy_rate == null || a.autonomy_rate < 50))
    .map(a => ({ de_id: a.de_id, name: nameFor(a.de_id), sent: a.sent_to_human, executed: a.executed, autonomy: a.autonomy_rate }));

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
      <div className="p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <PageHeader title="Business Insights" subtitle="What needs your attention, and what to do about it" />
          <RangeSelector value={range} onChange={setRange} />
        </div>
        <LiveLoadingSkeleton rows={4} />
      </div>
    );
  }

  const hasAnySignal = anomalies.length > 0 || guardrails.length > 0 || evalFailures.length > 0
    || actionFailures.length > 0 || approvalBottlenecks.length > 0;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <PageHeader
          title="Business Insights"
          subtitle="What needs your attention, and what to do about it — from real workforce activity"
        />
        <RangeSelector value={range} onChange={setRange} />
      </div>

      {/* Honest benchmark (#11, mig 176): every number computed over ALL
          traffic from raw rows; definitions travel with the payload.
          Rendered only when there is real measured work. */}
      {benchmark && (benchmark.outcomes.resolutions + benchmark.outcomes.escalations > 0 || benchmark.judged_quality.graded > 0) && (
        <div className="bg-dt-card border border-dt-border rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <p className="text-sm font-semibold text-white">Benchmark — honest numbers</p>
            <p className="text-[11px] text-dt-muted">all traffic counted, nothing cherry-picked · recountable from raw data</p>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <p className="text-2xl font-semibold text-emerald-400">{benchmark.outcomes.resolution_rate_pct != null ? `${benchmark.outcomes.resolution_rate_pct}%` : '—'}</p>
              <p className="text-[11px] text-dt-muted mt-0.5" title={benchmark.definitions.resolution_rate_pct}>resolution rate — every escalation & block counts in the denominator</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-dt-body">{benchmark.judged_quality.pass_rate_pct != null ? `${benchmark.judged_quality.pass_rate_pct}%` : '—'}</p>
              <p className="text-[11px] text-dt-muted mt-0.5" title={benchmark.definitions.judged_quality}>judged quality · {benchmark.judged_quality.graded} answer{benchmark.judged_quality.graded === 1 ? '' : 's'} graded by an independent AI judge</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-dt-body">{benchmark.csat.positive_pct != null ? `${benchmark.csat.positive_pct}%` : '—'}</p>
              <p className="text-[11px] text-dt-muted mt-0.5" title={benchmark.definitions.csat}>CSAT positive · {benchmark.csat.ratings} submitted rating{benchmark.csat.ratings === 1 ? '' : 's'} (never inferred)</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-white">{benchmark.cost.cost_per_resolution_cents != null ? `$${(benchmark.cost.cost_per_resolution_cents / 100).toFixed(2)}` : '—'}</p>
              <p className="text-[11px] text-dt-muted mt-0.5" title={benchmark.definitions.cost_per_resolution_cents}>real AI cost per resolution</p>
            </div>
          </div>
          {benchmark.capability.status !== 'no_simulation_yet' && (
            <p className="text-[11px] text-dt-muted mt-3 pt-3 border-t border-dt-border">
              Latest certification-grade simulation: {benchmark.capability.passed}/{benchmark.capability.total} passed
              {benchmark.capability.avg_score != null ? ` · avg score ${Math.round(Number(benchmark.capability.avg_score))}` : ''} · {benchmark.capability.status}
            </p>
          )}
        </div>
      )}

      {trendCards.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {trendCards.map(t => (
            <div key={t.name} className="bg-dt-card border border-dt-border rounded-xl p-4 flex items-center justify-between">
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
        <LiveEmptyState icon="◎" title="Nothing needs attention right now" body="No failed actions, approval backlogs, escalation spikes, guardrail overrides, or Proving Ground failures in this period." />
      ) : (
        <div className="space-y-3">
          {/* Failed actions — the most urgent operational signal */}
          {actionFailures.map(f => (
            <div key={`fail-${f.de_id}`} className={`rounded-xl border p-4 ${f.severity === 'high' ? 'border-red-500/30 bg-red-500/5' : 'border-amber-500/25 bg-amber-500/5'}`}>
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">ACTION FAILED</span>
                <span className="text-sm font-medium text-white">{f.name}: {f.failed} action{f.failed === 1 ? '' : 's'} failed</span>
                <span className={`ml-auto text-[10px] uppercase px-1.5 py-0.5 rounded ${f.severity === 'high' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'}`}>{f.severity}</span>
              </div>
              <p className="text-xs text-dt-support leading-relaxed">
                In the last 30 days. This usually means a connected system rejected the request — often expired credentials or a downstream error. Check the connector.
              </p>
              <button onClick={() => setPage('systems_connectors')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors mt-2">Open Connectors →</button>
            </div>
          ))}

          {/* Approval bottleneck — a trust-dial opportunity, not a problem */}
          {approvalBottlenecks.map(b => (
            <div key={`bottleneck-${b.de_id}`} className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">OPPORTUNITY</span>
                <span className="text-sm font-medium text-white">{b.name} routed {b.sent} action{b.sent === 1 ? '' : 's'} for approval</span>
              </div>
              <p className="text-xs text-dt-support leading-relaxed">
                {b.autonomy != null ? `Only ${b.autonomy}% of its actions ran without a human. ` : 'It needs a person for most actions. '}
                If your team keeps approving these, raise {b.name}'s trust dial to clear the queue — guardrails still cap what it can do.
              </p>
              <button onClick={() => openFile(b.de_id)} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors mt-2">Open {b.name}'s Employee File →</button>
            </div>
          ))}

          {anomalies.map(a => (
            <div key={a.deName} className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">ANOMALY</span>
                <span className="text-sm font-medium text-white">{a.deName} escalation rate spiked</span>
              </div>
              <p className="text-xs text-dt-support leading-relaxed">{a.detail}</p>
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
              <p className="text-xs text-dt-support leading-relaxed">
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
              <p className="text-xs text-dt-support leading-relaxed">
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
