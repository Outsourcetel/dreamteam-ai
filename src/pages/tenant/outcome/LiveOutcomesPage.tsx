import React, { useState, useEffect } from 'react';
import { PageHeader, th, td } from '../../../components/ui';
import type { Page } from '../../../types';
import { useAuth } from '../../../context/AuthContext';
import { useDataMode } from '../../../lib/dataMode';
import { supabase } from '../../../supabase';
import { listDigitalEmployees } from '../../../lib/digitalEmployeesApi';
import type { DigitalEmployee } from '../../../lib/digitalEmployeesApi';
import {
  getDePerformanceMetrics, getDeCsatMetrics, getDeCostMetrics,
  getDeGuardrailActivity, getRecentEvalFailures,
} from '../../../lib/api';
import type {
  DePerformanceMetrics, DeCsatMetrics, DeCostMetrics, DeGuardrailActivity, RecentEvalFailure,
} from '../../../lib/api';
import { fetchLiveNavCounts } from '../../../components/Sidebar';
import { LiveLoadingSkeleton } from '../../../components/LiveDataStates';

// ══════════════════════════════════════════════════════════════════
// Wave 3 — Outcomes: THE single real reporting surface for live
// tenants. Composes the already-real metric spine (economics, per-DE
// performance/CSAT/KPIs, health, guardrail activity, eval failures)
// plus the served-workload counts, with drill-ins to Company Data.
// Replaces the four never-real demo Outcome pages. Every number here
// is a real tenant-scoped query — no fabrication, honest nulls.
// ══════════════════════════════════════════════════════════════════

interface Economics {
  window_days: number;
  counts: { inquiries_handled: number; actions_executed: number; conversations_answered: number };
  hours_saved: number | null;
  fte_equivalent: number | null;
  de_cost_usd: number | null;
  human_cost_equivalent_usd: number | null;
  monthly_saving_usd: number | null;
  roi_ratio: number | null;
  unconfigured: string[];
  configured: boolean;
}

interface DeHealthRow {
  de_id: string; de_name: string; state: string;
  signals: Record<string, unknown>;
  total_decisions: number; avg_confidence: number | null; escalation_rate: number | null;
  error_rate: number | null; recent_guardrail_blocks: number;
  cost_this_period_usd: number | null; cost_per_task_usd: number | null;
}

interface KpiStatusRow {
  kpi_id: string; name: string; metric_key: string; target: number;
  direction: string; current: number | null; met: boolean | null; sample: number;
}

const HEALTH_STYLE: Record<string, string> = {
  healthy: 'bg-emerald-500/15 text-emerald-300',
  improving: 'bg-sky-500/15 text-sky-300',
  insufficient_data: 'bg-slate-700/40 text-slate-400',
  degraded: 'bg-rose-500/15 text-rose-300',
  low_confidence: 'bg-amber-500/15 text-amber-300',
  high_cost: 'bg-amber-500/15 text-amber-300',
  incident_active: 'bg-rose-500/15 text-rose-300',
  retired: 'bg-slate-800 text-slate-500',
};

const fmtUsd = (n: number | null | undefined) =>
  n == null ? '—' : `$${Math.round(n).toLocaleString()}`;
const fmtPct = (n: number | null | undefined, digits = 0) =>
  n == null ? '—' : `${Number(n).toFixed(digits)}%`;

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${tone ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

function LiveOutcomes({ tenantId, setPage }: { tenantId: string; setPage: (p: Page) => void }) {
  const [loading, setLoading] = useState(true);
  const [des, setDes] = useState<DigitalEmployee[]>([]);
  const [econ, setEcon] = useState<Economics | null>(null);
  const [perf, setPerf] = useState<DePerformanceMetrics[]>([]);
  const [csat, setCsat] = useState<DeCsatMetrics[]>([]);
  const [cost, setCost] = useState<DeCostMetrics[]>([]);
  const [health, setHealth] = useState<DeHealthRow[]>([]);
  const [guardrail, setGuardrail] = useState<DeGuardrailActivity[]>([]);
  const [evalFails, setEvalFails] = useState<RecentEvalFailure[]>([]);
  const [kpisByDe, setKpisByDe] = useState<Map<string, KpiStatusRow[]>>(new Map());
  const [workload, setWorkload] = useState<{ salesPipeline: number; onboardingActive: number; supportTickets: number; atRiskAccounts: number; renewalsDue: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [d, p, c, co, g, ef, counts, econRes, healthRes] = await Promise.all([
        listDigitalEmployees().catch(() => [] as DigitalEmployee[]),
        getDePerformanceMetrics(tenantId),
        getDeCsatMetrics(tenantId),
        getDeCostMetrics(tenantId),
        getDeGuardrailActivity(tenantId),
        getRecentEvalFailures(tenantId),
        fetchLiveNavCounts(),
        supabase.rpc('get_de_economics', { p_tenant_id: tenantId, p_de_id: null, p_days: 30 }),
        supabase.rpc('list_de_health', { p_tenant_id: tenantId }),
      ]);
      if (cancelled) return;
      setDes(d); setPerf(p); setCsat(c); setCost(co); setGuardrail(g); setEvalFails(ef);
      setWorkload(counts);
      if (!econRes.error) setEcon(econRes.data as Economics);
      if (!healthRes.error) setHealth((healthRes.data ?? []) as DeHealthRow[]);
      // Per-DE KPI status (registered targets vs live values) — roster-sized.
      const kpiEntries = await Promise.all(d.map(async (de) => {
        const { data } = await supabase.rpc('get_de_kpi_status', { p_de_id: de.id });
        return [de.id, (data ?? []) as KpiStatusRow[]] as const;
      }));
      if (cancelled) return;
      setKpisByDe(new Map(kpiEntries));
      setLoading(false);
    })().catch((e) => { console.error('LiveOutcomes:', e); if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId]);

  if (loading) {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageHeader title="Outcomes" subtitle="Rolling up real Digital Employee results…" />
        <LiveLoadingSkeleton rows={6} />
      </div>
    );
  }

  const perfByDe = new Map(perf.map(m => [m.de_id, m]));
  const csatByDe = new Map(csat.map(m => [m.de_id, m]));
  const healthByDe = new Map(health.map(h => [h.de_id, h]));
  const totalCostUsd = cost.reduce((s, x) => s + Number(x.total_cost_usd ?? 0), 0);

  // Delivery grouping: department (free-text on the DE) → 'General' fallback.
  const activeDes = des.filter(d => !['retired', 'archived'].includes(String((d as unknown as { lifecycle_status?: string }).lifecycle_status ?? '')));
  const byDept = new Map<string, DigitalEmployee[]>();
  for (const de of activeDes) {
    const dept = (de.department || '').trim() || 'General';
    byDept.set(dept, [...(byDept.get(dept) ?? []), de]);
  }
  const departments = [...byDept.keys()].sort();

  // KPI rollup across the roster.
  const allKpis = [...kpisByDe.values()].flat();
  const kpisMet = allKpis.filter(k => k.met === true).length;
  const kpisMissed = allKpis.filter(k => k.met === false).length;

  // Risk rollup.
  const guardrailSummary = guardrail.find(g => g.de_id === null) ?? guardrail[0];
  const tenantGuardrailEvents = guardrailSummary?.tenant_total_events ?? guardrail.reduce((s, g) => s + g.gated_count + g.blocked_count, 0);
  const highFrustration = perf.reduce((s, m) => s + Number(m.high_frustration_count ?? 0), 0);
  const unhealthy = health.filter(h => ['degraded', 'low_confidence', 'high_cost', 'incident_active'].includes(h.state));

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Outcomes"
        subtitle="What your digital workforce actually delivered — every number is live tenant data, nulls shown honestly until there's evidence"
      />

      {/* ── 1. Business value (economics, 30 days) ── */}
      <div className="mb-6">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Business value · last 30 days</p>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <Tile label="Work handled" value={String((econ?.counts.inquiries_handled ?? 0) + (econ?.counts.actions_executed ?? 0) + (econ?.counts.conversations_answered ?? 0))}
            sub={`${econ?.counts.inquiries_handled ?? 0} inquiries · ${econ?.counts.actions_executed ?? 0} actions · ${econ?.counts.conversations_answered ?? 0} conversations`} />
          <Tile label="Hours saved" value={econ?.hours_saved == null ? '—' : `${Math.round(Number(econ.hours_saved))}h`} />
          <Tile label="FTE equivalent" value={econ?.fte_equivalent == null ? '—' : Number(econ.fte_equivalent).toFixed(2)} />
          <Tile label="AI cost" value={fmtUsd(econ?.de_cost_usd)} sub={`all-time total ${fmtUsd(totalCostUsd)}`} />
          <Tile label="Monthly saving" value={fmtUsd(econ?.monthly_saving_usd)} tone={econ?.monthly_saving_usd != null && econ.monthly_saving_usd > 0 ? 'text-emerald-300' : undefined} />
          <Tile label="ROI" value={econ?.roi_ratio == null ? '—' : `${Number(econ.roi_ratio).toFixed(1)}×`} tone={econ?.roi_ratio != null && econ.roi_ratio > 0 ? 'text-emerald-300' : undefined} />
        </div>
        {econ && !econ.configured && (
          <p className="mt-2 text-[11px] text-amber-400/90">
            Savings and ROI need your workforce baselines ({econ.unconfigured.join(', ') || 'not set'}) —{' '}
            <button onClick={() => setPage('workforce_des')} className="underline underline-offset-2 hover:text-amber-300">configure them on the workforce page</button>.
            Counts and AI cost above are real regardless.
          </p>
        )}
      </div>

      {/* ── 2. Delivery, by department ── */}
      <div className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <h3 className="text-sm font-semibold text-white">Delivery</h3>
          <span className="text-[11px] text-slate-500">{kpisMet + kpisMissed > 0 ? `${kpisMet}/${kpisMet + kpisMissed} KPI targets met` : 'No KPI targets set yet — add them on each employee\'s profile'}</span>
        </div>
        <p className="text-[11px] text-slate-500 mb-3">Grouped by department — the same grouping guardrail scoping uses.</p>
        {activeDes.length === 0 ? (
          <p className="text-xs text-slate-500">No Digital Employees yet.</p>
        ) : departments.map(dept => (
          <div key={dept} className="mb-4 last:mb-0">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">{dept}</p>
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-left">
                    {['Employee', 'Health', 'Decisions', 'Resolution', 'Confidence', 'CSAT', 'KPIs'].map(h => <th key={h} className={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {(byDept.get(dept) ?? []).map(de => {
                    const m = perfByDe.get(de.id);
                    const cs = csatByDe.get(de.id);
                    const h = healthByDe.get(de.id);
                    const kpis = kpisByDe.get(de.id) ?? [];
                    const met = kpis.filter(k => k.met === true).length;
                    const judged = kpis.filter(k => k.met !== null).length;
                    return (
                      <tr key={de.id} className="border-b border-slate-800/60 last:border-b-0">
                        <td className={`${td} text-slate-200 text-xs`}>{de.name}</td>
                        <td className={td}>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${HEALTH_STYLE[h?.state ?? ''] ?? 'bg-slate-800 text-slate-400'}`}>
                            {(h?.state ?? 'unknown').split('_').join(' ')}
                          </span>
                        </td>
                        <td className={`${td} text-xs text-slate-300 font-mono`}>{m?.total_decisions ?? 0}</td>
                        <td className={`${td} text-xs text-slate-300 font-mono`}>{m && m.total_decisions > 0 ? fmtPct(m.resolution_rate) : '—'}</td>
                        <td className={`${td} text-xs text-slate-300 font-mono`}>{m && m.total_decisions > 0 ? fmtPct(m.avg_confidence) : '—'}</td>
                        <td className={`${td} text-xs text-slate-300 font-mono`}>{cs && cs.total_ratings > 0 ? `${fmtPct(cs.csat_pct)} (${cs.total_ratings})` : '—'}</td>
                        <td className={`${td} text-xs font-mono ${judged > 0 && met === judged ? 'text-emerald-300' : judged > 0 && met < judged ? 'text-amber-300' : 'text-slate-500'}`}>
                          {kpis.length === 0 ? '—' : `${met}/${judged}${kpis.length > judged ? ` (+${kpis.length - judged} no data)` : ''}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {/* ── 3. Risk posture (30 days) ── */}
      <div className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Risk posture · last 30 days</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <Tile label="Guardrail interventions" value={String(tenantGuardrailEvents)} sub="gated or blocked by your rules" />
          <Tile label="High-frustration inquiries" value={String(highFrustration)} sub="routed to a human" />
          <Tile label="Employees needing attention" value={String(unhealthy.length)} tone={unhealthy.length > 0 ? 'text-amber-300' : 'text-emerald-300'}
            sub={unhealthy.length > 0 ? unhealthy.map(h => h.de_name).join(', ') : 'all healthy or building evidence'} />
          <Tile label="Eval regressions" value={String(evalFails.length)} sub={evalFails.length > 0 ? 'recent runs with failures' : 'no failing eval runs'} />
        </div>
        {evalFails.length > 0 && (
          <div className="text-[11px] text-slate-400 space-y-1">
            {evalFails.map(f => (
              <p key={f.id}>✗ {f.trigger} — {f.failed}/{f.total} scenario(s) failed · {new Date(f.started_at).toLocaleDateString()}</p>
            ))}
          </div>
        )}
      </div>

      {/* ── 4. Work in your pipeline (drill into Company Data) ── */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <h3 className="text-sm font-semibold text-white mb-1">Work in flight</h3>
        <p className="text-[11px] text-slate-500 mb-3">Live counts from your business records — click through for the detail.</p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {([
            { label: 'Open pipeline', value: workload?.salesPipeline ?? 0, page: 'entity_customer_sales' as Page },
            { label: 'Onboarding projects', value: workload?.onboardingActive ?? 0, page: 'entity_customer_onboarding' as Page },
            { label: 'Open tickets', value: workload?.supportTickets ?? 0, page: 'entity_customer_support' as Page },
            { label: 'At-risk accounts', value: workload?.atRiskAccounts ?? 0, page: 'entity_customer_success' as Page },
            { label: 'Renewals due', value: workload?.renewalsDue ?? 0, page: 'entity_customer_renewal' as Page },
          ]).map(t => (
            <button key={t.label} onClick={() => setPage(t.page)}
              className="bg-slate-900 border border-slate-800 hover:border-slate-600 rounded-xl p-4 text-left transition-colors">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{t.label}</p>
              <p className="text-xl font-bold text-white">{t.value}</p>
              <p className="text-[10px] text-indigo-400 mt-1">Open →</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Wrapper: live tenants get the real Outcomes rollup; demo mode never
 *  routes here (the demo nav keeps its original Outcome pages). */
export default function OutcomesPage({ setPage }: { setPage: (p: Page) => void }) {
  const dataMode = useDataMode();
  const { currentTenant } = useAuth();
  if (dataMode === 'live' && currentTenant?.id) {
    return <LiveOutcomes tenantId={currentTenant.id} setPage={setPage} />;
  }
  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader title="Outcomes" subtitle="The consolidated Outcomes report is a live-workspace surface — demo workspaces keep the per-area preview pages." />
    </div>
  );
}
