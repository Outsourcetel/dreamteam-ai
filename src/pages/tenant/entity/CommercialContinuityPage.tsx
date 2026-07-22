import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import {
  listAgreements, listContinuityCases, listStages, listCaseEvents, proposeContinuityWriteback,
  fmtMoneyK, motionLabel, daysUntil, CustomerApiError,
} from '../../../lib/continuityApi';
import type {
  CommercialAgreement, ContinuityCase, ContinuityStage, ContinuityCaseEvent,
} from '../../../lib/continuityApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';

// ============================================================
// Commercial Continuity — the renewal EMPLOYEE's full desk (EXEC-2c).
// One employee (renewal_manager, upgraded in place) working every motion —
// renewals, reorders, warranties, vendor contracts — off independent dates.
// Read views over migs 225/226; case actions go through the mig-227 gated
// write-back (propose → gate → auto-apply or human approval). No demo data.
// ============================================================

type Tab = 'command' | 'portfolio' | 'cases';

const RISK_CLS: Record<string, string> = {
  critical: 'text-rose-400', high: 'text-amber-300', medium: 'text-dt-support', low: 'text-emerald-400',
};

function dateChip(dateStr: string | null): { label: string; cls: string } {
  const d = daysUntil(dateStr);
  if (dateStr === null || d === null) return { label: '—', cls: 'text-dt-faint' };
  if (d < 0) return { label: `${Math.abs(d)}d overdue`, cls: 'text-rose-400' };
  if (d <= 14) return { label: `in ${d}d`, cls: 'text-amber-300' };
  if (d <= 60) return { label: `in ${d}d`, cls: 'text-indigo-300' };
  return { label: `in ${d}d`, cls: 'text-dt-support' };
}

function StatCard({ label, value, sub, color = 'text-white' }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-dt-card border border-dt-border rounded-xl p-4">
      <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-dt-muted mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Case detail drawer — overview, timeline, and gated actions ─────────
function CaseDrawer({
  kase, stages, onClose, onChanged, notify,
}: {
  kase: ContinuityCase;
  stages: ContinuityStage[];
  onClose: () => void;
  onChanged: () => void;
  notify: (msg: string) => void;
}) {
  const [events, setEvents] = useState<ContinuityCaseEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [toStage, setToStage] = useState('');
  const [activity, setActivity] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshEvents = useCallback(async () => {
    setLoadingEvents(true);
    try { setEvents(await listCaseEvents(kase.objective_id)); } catch { /* tolerate */ }
    finally { setLoadingEvents(false); }
  }, [kase.objective_id]);
  useEffect(() => { void refreshEvents(); }, [refreshEvents]);

  const canAct = !!kase.de_id;

  const act = async (op: 'log_activity' | 'set_next_step' | 'advance_stage', params: Record<string, string>) => {
    if (!kase.de_id) { notify('This case has no assigned employee — cannot act.'); return; }
    setBusy(true);
    try {
      const res = await proposeContinuityWriteback(kase.de_id, kase.objective_id, op, params);
      notify(res.gated
        ? `Sent for approval — routed to Human Tasks (${res.reasoning?.slice(0, 80) || 'gated'})`
        : `Applied — the case record is updated`);
      setActivity(''); setNextStep(''); setToStage('');
      await refreshEvents();
      onChanged();
    } catch (err) {
      notify((err as Error)?.message || 'Action failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-xl bg-dt-page border-l border-dt-border h-full overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4 gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 uppercase tracking-wide">{motionLabel(kase.motion)}</span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-dt-panel text-dt-support">{kase.party_side === 'buy' ? 'Vendor' : 'Customer'}</span>
              {kase.risk_level && <span className={`text-[10px] px-2 py-0.5 rounded bg-dt-card ${RISK_CLS[kase.risk_level]}`}>{kase.risk_level} risk</span>}
            </div>
            <h2 className="text-lg font-semibold text-white">{kase.title || kase.counterparty_name || 'Continuity case'}</h2>
            <p className="text-xs text-dt-muted mt-0.5">
              {kase.counterparty_name || '—'}{kase.agreement_type ? ` · ${kase.agreement_type.replace(/_/g, ' ')}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-dt-support hover:text-white text-sm">✕</button>
        </div>

        {/* Overview */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          <StatCard label="Stage" value={kase.stage_key ? kase.stage_key.replace(/_/g, ' ') : '—'} />
          <StatCard label="Baseline" value={kase.baseline_cents != null ? fmtMoneyK(kase.baseline_cents) : '—'} />
          <StatCard label="Readiness" value={kase.readiness_score != null ? `${kase.readiness_score}%` : '—'} />
        </div>

        {/* Gated actions */}
        <div className="rounded-xl border border-dt-border bg-dt-card p-4 mb-5">
          <h3 className="text-sm font-semibold text-white mb-1">Work the case</h3>
          <p className="text-[11px] text-dt-muted mb-3">
            Every action runs through the approval gate — money and stage changes route to Human Tasks; safe logs may auto-apply. Nothing is written directly.
          </p>
          {!canAct && <p className="text-xs text-amber-300 mb-3">No employee is assigned to this case, so actions are disabled.</p>}
          <div className="space-y-3">
            {/* Advance stage */}
            <div className="flex gap-2">
              <select value={toStage} onChange={e => setToStage(e.target.value)} disabled={!canAct || busy}
                className="flex-1 bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body disabled:opacity-50">
                <option value="">Advance to stage…</option>
                {stages.map(s => <option key={s.stage_key} value={s.stage_key}>{s.label}</option>)}
              </select>
              <button onClick={() => toStage && act('advance_stage', { to_stage: toStage })} disabled={!canAct || busy || !toStage}
                className="text-xs px-3 py-1.5 rounded-lg border text-amber-300 border-amber-800/50 hover:border-amber-500 disabled:opacity-40 transition-all whitespace-nowrap">
                Advance →
              </button>
            </div>
            {/* Log activity */}
            <div className="flex gap-2">
              <input value={activity} onChange={e => setActivity(e.target.value)} disabled={!canAct || busy} placeholder="Log an activity…"
                className="flex-1 bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body disabled:opacity-50" />
              <button onClick={() => activity.trim() && act('log_activity', { summary: activity.trim() })} disabled={!canAct || busy || !activity.trim()}
                className="text-xs px-3 py-1.5 rounded-lg border text-dt-support border-dt-border-strong hover:border-slate-400 disabled:opacity-40 transition-all">
                Log
              </button>
            </div>
            {/* Set next step */}
            <div className="flex gap-2">
              <input value={nextStep} onChange={e => setNextStep(e.target.value)} disabled={!canAct || busy} placeholder="Set the next step…"
                className="flex-1 bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body disabled:opacity-50" />
              <button onClick={() => nextStep.trim() && act('set_next_step', { next_step: nextStep.trim() })} disabled={!canAct || busy || !nextStep.trim()}
                className="text-xs px-3 py-1.5 rounded-lg border text-dt-support border-dt-border-strong hover:border-slate-400 disabled:opacity-40 transition-all">
                Set
              </button>
            </div>
          </div>
        </div>

        {/* Timeline */}
        <h3 className="text-sm font-semibold text-white mb-2">Case timeline</h3>
        {loadingEvents ? (
          <p className="text-xs text-dt-muted">Loading…</p>
        ) : events.length === 0 ? (
          <p className="text-xs text-dt-muted">No activity yet.</p>
        ) : (
          <ol className="space-y-2">
            {events.map(e => (
              <li key={e.id} className="flex items-start gap-2 text-xs">
                <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${e.to_stage ? 'bg-amber-400' : 'bg-slate-500'}`} />
                <div className="min-w-0">
                  <p className="text-dt-body">{e.summary}</p>
                  <p className="text-[10px] text-dt-muted">{e.actor_kind} · {new Date(e.created_at).toLocaleString()}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

const CommercialContinuityPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { liveTenantName } = useAuth();
  const [tab, setTab] = useState<Tab>('command');
  const [agreements, setAgreements] = useState<CommercialAgreement[]>([]);
  const [cases, setCases] = useState<ContinuityCase[]>([]);
  const [stages, setStages] = useState<ContinuityStage[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ContinuityCase | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<'renewal_date' | 'notice_deadline' | 'baseline_value_cents'>('renewal_date');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [a, c, s] = await Promise.all([listAgreements(), listContinuityCases(), listStages()]);
      setAgreements(a); setCases(c); setStages(s); setMissing(false);
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissing(true);
      else setError((err as Error)?.message || 'Failed to load commercial continuity.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onChange = () => void refresh();
    window.addEventListener('dt-state-changed', onChange);
    return () => window.removeEventListener('dt-state-changed', onChange);
  }, [refresh]);

  // ── Command Center metrics ──
  const metrics = useMemo(() => {
    const renewable = agreements.reduce((s, a) => s + (a.baseline_value_cents || 0), 0);
    const noticeSoon = agreements.filter(a => { const d = daysUntil(a.notice_deadline); return d !== null && d >= 0 && d <= 60; });
    const atRisk = cases.filter(c => c.risk_level === 'high' || c.risk_level === 'critical');
    const atRiskValue = atRisk.reduce((s, c) => s + (c.baseline_cents || 0), 0);
    const byMotion = cases.reduce<Record<string, number>>((m, c) => { m[c.motion] = (m[c.motion] || 0) + 1; return m; }, {});
    return { renewable, noticeSoon, atRisk, atRiskValue, byMotion };
  }, [agreements, cases]);

  const sortedAgreements = useMemo(() => {
    const copy = [...agreements];
    copy.sort((a, b) => {
      if (sortKey === 'baseline_value_cents') return (b.baseline_value_cents || 0) - (a.baseline_value_cents || 0);
      const av = a[sortKey], bv = b[sortKey];
      if (!av) return 1; if (!bv) return -1;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    return copy;
  }, [agreements, sortKey]);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Commercial Continuity</h1>
        <p className="text-dt-support text-sm mt-1">
          {liveTenantName || 'Your company'} · One employee working every motion — renewals, reorders, warranties and vendor contracts — off each agreement's own dates. Money and stage changes are always human-gated.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-dt-border">
        {([['command', 'Command Center'], ['portfolio', 'Portfolio'], ['cases', 'Case Workspace']] as [Tab, string][]).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === id ? 'border-indigo-500 text-white' : 'border-transparent text-dt-support hover:text-dt-body'}`}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={5} />
      ) : missing ? (
        <MissingTablesNotice />
      ) : agreements.length === 0 && cases.length === 0 ? (
        <LiveEmptyState
          icon="⟳"
          title="No commercial agreements yet"
          body="Add agreements (customer or vendor) with their renewal, notice, warranty or reorder dates. The renewal employee opens a case with the right motion as each date approaches."
          primaryLabel="Go to Renewal & Expansion"
          onPrimary={() => setPage('entity_customer_renewal')}
        />
      ) : (
        <>
          {/* ── Command Center ── */}
          {tab === 'command' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard label="Renewable value" value={fmtMoneyK(metrics.renewable)} sub={`${agreements.length} agreement(s)`} />
                <StatCard label="Open cases" value={String(cases.length)} sub="live continuity work" color="text-indigo-300" />
                <StatCard label="Notice deadlines ≤60d" value={String(metrics.noticeSoon.length)} sub="act before the window closes" color={metrics.noticeSoon.length ? 'text-amber-300' : 'text-emerald-300'} />
                <StatCard label="At-risk value" value={fmtMoneyK(metrics.atRiskValue)} sub={`${metrics.atRisk.length} case(s)`} color={metrics.atRisk.length ? 'text-rose-400' : 'text-emerald-300'} />
              </div>
              <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
                <h3 className="text-sm font-semibold text-white mb-3">Cases by motion</h3>
                {Object.keys(metrics.byMotion).length === 0 ? (
                  <p className="text-xs text-dt-muted">No open cases yet — they open automatically as agreement dates approach.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(metrics.byMotion).sort((a, b) => b[1] - a[1]).map(([m, n]) => (
                      <span key={m} className="text-xs px-3 py-1.5 rounded-lg bg-dt-card border border-dt-border text-dt-support">
                        {motionLabel(m as ContinuityCase['motion'])} <span className="text-white font-semibold ml-1">{n}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Portfolio ── */}
          {tab === 'portfolio' && (
            <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <h3 className="text-base font-semibold text-white">Agreement portfolio</h3>
                <div className="flex items-center gap-2 text-xs text-dt-support">
                  <span>Sort by</span>
                  <select value={sortKey} onChange={e => setSortKey(e.target.value as typeof sortKey)}
                    className="bg-dt-page border border-dt-border-strong rounded-lg px-2 py-1 text-dt-body">
                    <option value="renewal_date">Renewal date</option>
                    <option value="notice_deadline">Notice deadline</option>
                    <option value="baseline_value_cents">Value</option>
                  </select>
                </div>
              </div>
              {agreements.length === 0 ? (
                <p className="text-xs text-dt-muted">No agreements yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-dt-border">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-dt-border text-left">
                        {['Counterparty', 'Side', 'Type', 'Status', 'Value', 'Renewal', 'Notice deadline'].map(h => (
                          <th key={h} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-dt-muted font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedAgreements.map((a, i) => {
                        const rc = dateChip(a.renewal_date), nc = dateChip(a.notice_deadline);
                        return (
                          <tr key={a.id} className={`border-b border-dt-border hover:bg-dt-panel transition-colors ${i === sortedAgreements.length - 1 ? 'border-b-0' : ''}`}>
                            <td className="py-3 px-4 font-medium text-white">{a.counterparty_name}</td>
                            <td className="py-3 px-4"><span className="text-[10px] px-2 py-0.5 rounded bg-dt-panel text-dt-support">{a.party_side === 'buy' ? 'Vendor' : 'Customer'}</span></td>
                            <td className="py-3 px-4 text-dt-support">{a.agreement_type.replace(/_/g, ' ')}</td>
                            <td className="py-3 px-4 text-dt-support text-xs">{a.status}</td>
                            <td className="py-3 px-4 text-dt-support">{a.baseline_value_cents != null ? fmtMoneyK(a.baseline_value_cents) : '—'}</td>
                            <td className="py-3 px-4 whitespace-nowrap"><span className={`text-xs ${rc.cls}`}>{a.renewal_date || '—'}{a.renewal_date ? ` · ${rc.label}` : ''}</span></td>
                            <td className="py-3 px-4 whitespace-nowrap"><span className={`text-xs ${nc.cls}`}>{a.notice_deadline || '—'}{a.notice_deadline ? ` · ${nc.label}` : ''}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Case Workspace ── */}
          {tab === 'cases' && (
            <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
              <h3 className="text-base font-semibold text-white mb-1">Continuity cases</h3>
              <p className="text-xs text-dt-muted mb-4">Open a case to work it — advance the stage, log activity, or set the next step. Every action runs through the approval gate.</p>
              {cases.length === 0 ? (
                <p className="text-xs text-dt-muted">No open cases yet — they open automatically as agreement dates approach.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-dt-border">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-dt-border text-left">
                        {['Case', 'Motion', 'Counterparty', 'Stage', 'Baseline', 'Risk', ''].map(h => (
                          <th key={h} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-dt-muted font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {cases.map((c, i) => (
                        <tr key={c.objective_id} className={`border-b border-dt-border hover:bg-dt-panel transition-colors cursor-pointer ${i === cases.length - 1 ? 'border-b-0' : ''}`} onClick={() => setSelected(c)}>
                          <td className="py-3 px-4 font-medium text-white max-w-xs truncate">{c.title || '—'}</td>
                          <td className="py-3 px-4"><span className="text-[10px] px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300">{motionLabel(c.motion)}</span></td>
                          <td className="py-3 px-4 text-dt-support">{c.counterparty_name || '—'}</td>
                          <td className="py-3 px-4 text-dt-support text-xs">{c.stage_key ? c.stage_key.replace(/_/g, ' ') : '—'}</td>
                          <td className="py-3 px-4 text-dt-support">{c.baseline_cents != null ? fmtMoneyK(c.baseline_cents) : '—'}</td>
                          <td className="py-3 px-4 text-xs">{c.risk_level ? <span className={RISK_CLS[c.risk_level]}>{c.risk_level}</span> : <span className="text-dt-faint">—</span>}</td>
                          <td className="py-3 px-4 text-right"><span className="text-xs text-indigo-400">Open →</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {selected && (
        <CaseDrawer kase={selected} stages={stages} onClose={() => setSelected(null)}
          onChanged={() => void refresh()} notify={notify} />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-[100] px-4 py-3 rounded-xl border shadow-xl text-sm font-medium bg-dt-card/95 border-dt-border-strong text-dt-body max-w-sm">
          {toast}
        </div>
      )}
    </div>
  );
};

export default CommercialContinuityPage;
