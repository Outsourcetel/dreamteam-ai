import { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { fetchMonthlyUsage, MonthlyUsage } from '../../../lib/usageApi';
import { PageHeader } from '../../../components/ui';
import type { Page } from '../../../types';
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


// ⚠ Two seeded blocks were DELETED 2026-08-22, both zero-reader:
//   BENCHMARK   invented per-tenant resolution/confidence/escalation numbers.
//   InsightKind/Insight/TCP_INSIGHTS/PWC_INSIGHTS/INSIGHTS/KIND_META
//               ~95 lines of invented "intelligence" — named anomalies,
//               retraining recommendations and config-drift claims with
//               invented percentages, each linking to a real governance page.
// The live pages read real metrics; a fabricated insight that deep-links into
// Compliance is a claim about the tenant's own governance. Recoverable at 571868e.

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
        <span className="text-[10px] font-bold tracking-widest text-indigo-400 uppercase">Live usage (this month)</span>
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
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${value === o.days ? 'bg-dt-accent-strong text-white' : 'text-dt-support hover:text-dt-body'}`}
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
      <div className={`text-2xl font-bold tabular-nums ${tone ?? 'text-dt-title'}`}>{value}</div>
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
          tone={totalSentHuman > 0 ? 'text-dt-warn' : 'text-dt-body'} sub="approvals routed to people" />
        <StatTile label="AI cost" value={`$${totalCostUsd.toFixed(2)}`} sub={`${totalCalls.toLocaleString()} model calls`} />
      </div>

      {/* Outcome metering (#15): per-resolution value, escalations free.
          Shown only once real outcomes exist — no fabricated revenue. */}
      {metering && (metering.totals.resolutions > 0 || metering.totals.escalations > 0) && (
        <div className="bg-dt-card border border-dt-border rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <p className="text-sm font-semibold text-dt-title">Outcome value</p>
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
              <p className="text-2xl font-semibold text-dt-title">${(metering.totals.billable_amount_cents / 100).toFixed(2)}</p>
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
          {totalBlocked > 0 && <span><span className="text-dt-danger font-medium">{totalBlocked}</span> action{totalBlocked === 1 ? '' : 's'} blocked by a guardrail or access rule</span>}
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
                    <span className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-dt-accent-border flex items-center justify-center text-indigo-400 font-semibold">{(de.persona_name ?? de.name)[0]}</span>
                    <div>
                      <p className="text-sm font-semibold text-dt-title">{de.persona_name ?? de.name}</p>
                      <p className="text-[11px] text-dt-muted">{de.persona_name ? de.name : (de.description || de.category)}</p>
                    </div>
                  </div>
                  {/* A performance roster row lands on the file's Performance tab. */}
                  <button onClick={() => openFile(de.id, 'performance')} className="text-xs text-dt-muted hover:text-dt-accent-text transition-colors">Employee File →</button>
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
                            { label: 'Sent to human', value: a.sent_to_human, color: a.sent_to_human > 0 ? 'text-dt-warn' : 'text-dt-support' },
                            { label: 'Blocked', value: a.blocked + a.failed, color: (a.blocked + a.failed) > 0 ? 'text-dt-danger' : 'text-dt-support' },
                          ].map(x => (
                            <div key={x.label} className="bg-dt-page rounded-lg px-2 py-2 text-center">
                              <p className={`text-sm font-semibold tabular-nums ${x.color}`}>{x.value}</p>
                              <p className="text-[10px] text-dt-muted uppercase tracking-wide">{x.label}</p>
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
                            <p className="text-[10px] text-dt-muted uppercase tracking-wide">{x.label}</p>
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
          <PageHeader title="What needs your attention" subtitle="Worked out from what your employees actually did — not a survey, not an estimate." />
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
          title="What needs your attention"
          subtitle="Worked out from what your employees actually did — not a survey, not an estimate."
        />
        <RangeSelector value={range} onChange={setRange} />
      </div>

      {/* Honest benchmark (#11, mig 176): every number computed over ALL
          traffic from raw rows; definitions travel with the payload.
          Rendered only when there is real measured work. */}
      {benchmark && (benchmark.outcomes.resolutions + benchmark.outcomes.escalations > 0 || benchmark.judged_quality.graded > 0) && (
        <div className="bg-dt-card border border-dt-border rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <p className="text-sm font-semibold text-dt-title">Benchmark — honest numbers</p>
            <p className="text-[11px] text-dt-muted">all traffic counted, nothing cherry-picked · recountable from raw data</p>
          </div>
          {/* ── THE DEFINITIONS WERE IN TOOLTIPS ────────────────────────────
              get_benchmark_report ships a written definition for every number
              — and they are the most careful sentences in the product:
              "every escalation, hand-off, and guardrail block counts in the
              denominator. Nothing is excluded", "Never inferred or imputed".
              All four were reachable only by hovering an 11px caption, which
              on a touch screen means not at all. A metric whose definition
              nobody can read is a metric nobody can trust, and these are the
              numbers a customer would ask us to defend. They are on the page
              now, at the same size as everything else. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <p className="text-2xl font-semibold text-emerald-400">{benchmark.outcomes.resolution_rate_pct != null ? `${benchmark.outcomes.resolution_rate_pct}%` : '—'}</p>
              <p className="text-xs font-medium text-dt-body mt-0.5">closed without a human</p>
              <p className="text-xs text-dt-muted mt-1">{benchmark.definitions.resolution_rate_pct}</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-dt-body">{benchmark.judged_quality.pass_rate_pct != null ? `${benchmark.judged_quality.pass_rate_pct}%` : '—'}</p>
              <p className="text-xs font-medium text-dt-body mt-0.5">
                answers judged good · {benchmark.judged_quality.graded} graded
              </p>
              <p className="text-xs text-dt-muted mt-1">{benchmark.definitions.judged_quality}</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-dt-body">{benchmark.csat.positive_pct != null ? `${benchmark.csat.positive_pct}%` : '—'}</p>
              <p className="text-xs font-medium text-dt-body mt-0.5">
                customers happy · {benchmark.csat.ratings} rating{benchmark.csat.ratings === 1 ? '' : 's'}
              </p>
              <p className="text-xs text-dt-muted mt-1">{benchmark.definitions.csat}</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-dt-title">{benchmark.cost.cost_per_resolution_cents != null ? `$${(benchmark.cost.cost_per_resolution_cents / 100).toFixed(2)}` : '—'}</p>
              <p className="text-xs font-medium text-dt-body mt-0.5">per thing resolved</p>
              <p className="text-xs text-dt-muted mt-1">{benchmark.definitions.cost_per_resolution_cents}</p>
            </div>
          </div>
          {benchmark.capability.status !== 'no_simulation_yet' && (
            <p className="text-xs text-dt-muted mt-3 pt-3 border-t border-dt-border">
              {/* ⚠ `status` was printed raw beside a score — an owner reading
                  "· passing" is fine, but "· needs_improvement" is a column
                  value, not a sentence. Said in words, or not at all. */}
              Latest certification-grade simulation: {benchmark.capability.passed} of {benchmark.capability.total} passed
              {benchmark.capability.avg_score != null ? `, averaging ${Math.round(Number(benchmark.capability.avg_score))}` : ''}.
              {' '}{benchmark.definitions.capability}
            </p>
          )}
        </div>
      )}

      {trendCards.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {trendCards.map(t => (
            <div key={t.name} className="bg-dt-card border border-dt-border rounded-xl p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-dt-title">{t.name}</p>
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
        <LiveEmptyState icon="◎" title="Nothing needs attention right now" body="Your workforce is running clean for this period — nothing failed, nothing is piling up, and nothing was overridden." />
      ) : (
        <div className="space-y-3">
          {/* Failed actions — the most urgent operational signal */}
          {actionFailures.map(f => (
            <div key={`fail-${f.de_id}`} className={`rounded-xl border p-4 ${f.severity === 'high' ? 'border-red-500/30 bg-red-500/5' : 'border-amber-500/25 bg-amber-500/5'}`}>
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-dt-danger-soft text-dt-danger">ACTION FAILED</span>
                <span className="text-sm font-medium text-dt-title">{f.name}: {f.failed} action{f.failed === 1 ? '' : 's'} failed</span>
                <span className={`ml-auto text-[10px] uppercase px-1.5 py-0.5 rounded ${f.severity === 'high' ? 'bg-dt-danger-soft text-dt-danger' : 'bg-dt-warn-soft text-dt-warn'}`}>{f.severity}</span>
              </div>
              <p className="text-xs text-dt-support leading-relaxed">
                In the last 30 days. This usually means a connected system rejected the request — often expired credentials or a downstream error. Check the connector.
              </p>
              <button onClick={() => setPage('systems_connectors')} className="text-xs text-dt-accent-text hover:underline transition-colors mt-2">Open Connectors →</button>
            </div>
          ))}

          {/* Approval bottleneck — a trust-dial opportunity, not a problem */}
          {approvalBottlenecks.map(b => (
            <div key={`bottleneck-${b.de_id}`} className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-dt-ok-soft text-dt-ok">OPPORTUNITY</span>
                <span className="text-sm font-medium text-dt-title">{b.name} routed {b.sent} action{b.sent === 1 ? '' : 's'} for approval</span>
              </div>
              <p className="text-xs text-dt-support leading-relaxed">
                {b.autonomy != null ? `Only ${b.autonomy}% of its actions ran without a human. ` : 'It needs a person for most actions. '}
                If your team keeps approving these, raise {b.name}'s trust dial to clear the queue — guardrails still cap what it can do.
              </p>
              <button onClick={() => openFile(b.de_id, 'trust')} className="text-xs text-dt-accent-text hover:underline transition-colors mt-2">Open {b.name}'s Employee File →</button>
            </div>
          ))}

          {anomalies.map(a => (
            <div key={a.deName} className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-dt-danger-soft text-dt-danger">ANOMALY</span>
                <span className="text-sm font-medium text-dt-title">{a.deName} escalation rate spiked</span>
              </div>
              <p className="text-xs text-dt-support leading-relaxed">{a.detail}</p>
            </div>
          ))}

          {guardrails.map((g, i) => (
            <div key={g.de_id ?? `tenant-${i}`} className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-dt-warn-soft text-dt-warn">CONFIG DRIFT</span>
                <span className="text-sm font-medium text-dt-title">
                  {g.de_name ? `${g.de_name}: ${g.gated_count + g.blocked_count} guardrail event(s)` : 'Guardrail activity recorded'}
                </span>
              </div>
              <p className="text-xs text-dt-support leading-relaxed">
                {g.de_name
                  ? `${g.gated_count} gated, ${g.blocked_count} blocked in the last 30 days.`
                  : `${g.tenant_total_events} guardrail event(s) recorded tenant-wide, but none could be matched to a currently-named Digital Employee (likely renamed since).`}
              </p>
              <button onClick={() => setPage('gov_compliance')} className="text-xs text-dt-accent-text hover:underline transition-colors mt-2">
                Open Compliance & Guardrails →
              </button>
            </div>
          ))}

          {evalFailures.map(e => (
            <div key={e.id} className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-dt-info-soft text-dt-info">PROVING GROUND</span>
                <span className="text-sm font-medium text-dt-title">{e.failed} of {e.total} scenarios failed</span>
              </div>
              <p className="text-xs text-dt-support leading-relaxed">
                {e.trigger} eval run on {new Date(e.started_at).toLocaleDateString()} — {e.passed} passed, {e.failed} failed.
                Tenant-wide (Proving Ground runs aren't yet attributed to one Digital Employee).
              </p>
              <button onClick={() => setPage('intelligence_evals')} className="text-xs text-dt-accent-text hover:underline transition-colors mt-2">
                Open Proving Ground →
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
