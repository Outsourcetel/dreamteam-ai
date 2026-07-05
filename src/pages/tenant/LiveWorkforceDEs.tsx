import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import type { Page } from '../../types';
import { CustomerApiError, fmtMoneyK } from '../../lib/customerApi';
import { getApprovalThresholdCents } from '../../lib/guardrailApi';
import {
  listAutonomy, upsertAutonomy, getApprovalEvidence,
  AUTONOMY_ACTION_META,
} from '../../lib/autonomyApi';
import type { DEAutonomy, AutonomyActionType, ApprovalEvidence } from '../../lib/autonomyApi';
import {
  listTrustPolicies, seedTrustPolicies, computeTrustEvidence, requestTrustPromotion,
  listTrustHistory, trustLevelSettings, TRUST_LEVEL_LABELS,
} from '../../lib/trustApi';
import type { TrustPolicy, TrustEvidence, TrustHistoryEvent, TrustCategory } from '../../lib/trustApi';
import { appendAuditEvent } from '../../lib/guardrailApi';
import { LiveLoadingSkeleton, MissingTablesNotice } from '../../components/LiveDataStates';

// ============================================================
// Workforce — LIVE mode (R5): the first live DE-profile surface.
// One real DE (Alex — Customer Support DE) + the Trust dial panel:
// per-action autonomy thresholds stored in de_autonomy, with an
// evidence line computed from the immutable audit trail.
//
// COMPOSITION RULE (mirrors generateInvoice / playbook-execute):
// autonomy NARROWS within guardrails, never overrides them — an
// invoice auto-sends only when it passes BOTH the guardrail approval
// threshold AND the trust-dial max. Raising the dial can never
// authorize something a guardrail forbids.
// ============================================================

const ACTION_ORDER: AutonomyActionType[] = ['invoice_auto_send', 'answer_dock', 'answer_widget'];

interface RowDraft { enabled: boolean; amount: string; confidence: string }

function draftFrom(a: DEAutonomy | undefined): RowDraft {
  return {
    enabled: a?.enabled ?? false,
    amount: a?.max_amount_cents != null ? String(Math.round(a.max_amount_cents / 100)) : '',
    confidence: a?.min_confidence != null ? String(a.min_confidence) : '',
  };
}

export default function LiveWorkforceDEs({ setPage }: { setPage: (p: Page) => void }) {
  const { liveTenantName } = useAuth();
  const [rows, setRows] = useState<Record<string, DEAutonomy>>({});
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [evidence, setEvidence] = useState<ApprovalEvidence | null>(null);
  const [thresholdCents, setThresholdCents] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // Earned trust
  const [policies, setPolicies] = useState<Record<string, TrustPolicy>>({});
  const [trustEvidence, setTrustEvidence] = useState<Record<string, TrustEvidence>>({});
  const [trustHistory, setTrustHistory] = useState<TrustHistoryEvent[]>([]);
  const [trustError, setTrustError] = useState<string | null>(null);
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [requestedId, setRequestedId] = useState<string | null>(null);

  const refreshTrust = useCallback(async () => {
    try {
      let list = await listTrustPolicies();
      if (list.length === 0) list = await seedTrustPolicies();
      const byCat: Record<string, TrustPolicy> = {};
      for (const p of list) byCat[p.action_category] = p;
      setPolicies(byCat);
      const ev: Record<string, TrustEvidence> = {};
      await Promise.all(list.map(async p => {
        try { ev[p.action_category] = await computeTrustEvidence(p.action_category, p.de_id); } catch { /* per-card */ }
      }));
      setTrustEvidence(ev);
      try { setTrustHistory(await listTrustHistory(8)); } catch { setTrustHistory([]); }
      setTrustError(null);
    } catch (err) {
      setTrustError((err as Error)?.message || 'Failed to load earned trust.');
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, thr] = await Promise.all([listAutonomy(), getApprovalThresholdCents()]);
      const byType: Record<string, DEAutonomy> = {};
      for (const a of list) byType[a.action_type] = a;
      setRows(byType);
      setThresholdCents(thr.cents);
      setDrafts(Object.fromEntries(ACTION_ORDER.map(t => [t, draftFrom(byType[t])])));
      setMissingTables(false);
      try { setEvidence(await getApprovalEvidence()); } catch { setEvidence(null); }
      void refreshTrust();
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load the trust dial.');
    } finally {
      setLoading(false);
    }
  }, [refreshTrust]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Does a dial setting exceed what's been EARNED for its category? */
  const exceedsEarned = useCallback((type: AutonomyActionType, enabled: boolean, maxCents: number | null, minConf: number | null): boolean => {
    const policy = policies[type];
    if (!policy || !enabled) return false;
    const earned = trustLevelSettings(type as TrustCategory, policy.current_level);
    if (!earned.enabled) return true;
    if (earned.max_amount_cents !== null && (maxCents ?? Infinity) > earned.max_amount_cents) return true;
    if (earned.min_confidence !== null && (minConf ?? 0) < earned.min_confidence) return true;
    return false;
  }, [policies]);

  const requestPromotion = async (policy: TrustPolicy) => {
    setRequestingId(policy.id);
    setTrustError(null);
    try {
      await requestTrustPromotion(policy.id);
      setRequestedId(policy.id);
      setTimeout(() => setRequestedId(k => (k === policy.id ? null : k)), 4000);
      await refreshTrust();
    } catch (err) {
      setTrustError((err as Error)?.message || 'Promotion request failed.');
    } finally {
      setRequestingId(null);
    }
  };

  const save = async (type: AutonomyActionType) => {
    const d = drafts[type];
    if (!d) return;
    setSavingKey(type);
    setError(null);
    try {
      const meta = AUTONOMY_ACTION_META[type];
      const row = await upsertAutonomy(type, {
        enabled: d.enabled,
        max_amount_cents: meta.unit === 'amount' && d.amount.trim() !== ''
          ? Math.max(0, Math.round(Number(d.amount) || 0)) * 100 : null,
        min_confidence: meta.unit === 'confidence' && d.confidence.trim() !== ''
          ? Math.max(0, Math.min(100, Math.round(Number(d.confidence) || 0))) : null,
      });
      // Manual raise above the earned level → recorded as an override so
      // the earned path stays the celebrated one (still guardrail-capped).
      if (exceedsEarned(type, row.enabled, row.max_amount_cents, row.min_confidence)) {
        try {
          await appendAuditEvent({
            actor: 'You', actor_type: 'human', category: 'config_change',
            action: `Manual trust override — ${meta.label} set above the earned level`,
            detail: {
              kind: 'trust_manual_override', action_category: type,
              earned_level: policies[type]?.current_level ?? 0,
              enabled: row.enabled, max_amount_cents: row.max_amount_cents, min_confidence: row.min_confidence,
              composition: 'autonomy_narrows_within_guardrails',
            },
          });
        } catch { /* audit best-effort; upsert already audited */ }
      }
      setRows(prev => ({ ...prev, [type]: row }));
      setDrafts(prev => ({ ...prev, [type]: draftFrom(row) }));
      setSavedKey(type);
      setTimeout(() => setSavedKey(k => (k === type ? null : k)), 2500);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to save.');
    } finally {
      setSavingKey(null);
    }
  };

  const evidenceLine = evidence && evidence.total > 0
    ? `${evidence.total} invoice approval${evidence.total === 1 ? '' : 's'} on record, ${evidence.approved} approved unchanged (${evidence.approvedPct}%)${evidence.approvedPct >= 80 ? ' — consider raising the limit' : ''}`
    : 'No invoice approvals on record yet — evidence accrues as the DE routes invoices through the human gate.';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Digital Employees</h1>
        <p className="text-slate-400 text-sm mt-1">
          {liveTenantName || 'Your company'} · Live DE profile — per-action autonomy is configured on the trust dial below
        </p>
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : (
        <div className="max-w-3xl space-y-6">
          {/* DE card */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold text-xl">A</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <h2 className="text-base font-semibold text-white">Alex</h2>
                  <span className="text-xs text-slate-400">Customer Support DE</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">active</span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Answers from your knowledge library, escalates below confidence, runs the renewal playbook inside guardrails.
                </p>
              </div>
            </div>
          </div>

          {/* Trust dial */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
            <div className="mb-1 flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold text-white">Trust dial</h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">per-action autonomy</span>
            </div>
            <p className="text-xs text-slate-500 mb-1">
              Autonomy narrows <em>within</em> guardrails — it never overrides them. An invoice auto-sends only when it passes
              both the {thresholdCents !== null ? fmtMoneyK(thresholdCents) : 'guardrail'} approval threshold <em>and</em> the trust-dial limit.
            </p>
            <p className="text-xs text-slate-400 mb-5">
              Evidence: <span className="text-slate-300">{evidenceLine}</span>
            </p>

            <div className="space-y-4">
              {ACTION_ORDER.map(type => {
                const meta = AUTONOMY_ACTION_META[type];
                const d = drafts[type] ?? { enabled: false, amount: '', confidence: '' };
                return (
                  <div key={type} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-slate-200 font-medium">{meta.label}</span>
                          {rows[type] && exceedsEarned(type, rows[type].enabled, rows[type].max_amount_cents, rows[type].min_confidence) && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300" title="This dial is set above the level the DE has earned from evidence. Still capped by guardrails.">
                              Manual override
                            </span>
                          )}
                          {meta.dormant && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500" title="Stored now; enforced when the DE brain is activated (R1)">
                              dormant until activation
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1">{meta.description}</p>
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={d.enabled}
                          onChange={e => setDrafts(prev => ({ ...prev, [type]: { ...d, enabled: e.target.checked } }))}
                          className="accent-indigo-500"
                        />
                        <span className="text-xs text-slate-400">{d.enabled ? 'Enabled' : 'Off'}</span>
                      </label>
                    </div>
                    <div className="mt-3 flex items-center gap-3 flex-wrap">
                      {meta.unit === 'amount' ? (
                        <label className="flex items-center gap-2 text-xs text-slate-400">
                          Max amount $
                          <input
                            type="number" min={0} value={d.amount} placeholder="e.g. 5000"
                            onChange={e => setDrafts(prev => ({ ...prev, [type]: { ...d, amount: e.target.value } }))}
                            className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                          />
                        </label>
                      ) : (
                        <label className="flex items-center gap-2 text-xs text-slate-400">
                          Min confidence %
                          <input
                            type="number" min={0} max={100} value={d.confidence} placeholder="e.g. 75"
                            onChange={e => setDrafts(prev => ({ ...prev, [type]: { ...d, confidence: e.target.value } }))}
                            className="w-20 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                          />
                        </label>
                      )}
                      <button
                        onClick={() => void save(type)}
                        disabled={savingKey !== null}
                        className="text-xs px-3 py-1.5 rounded-lg border text-indigo-300 border-indigo-800/50 hover:border-indigo-500 disabled:opacity-50 transition-all"
                      >
                        {savingKey === type ? 'Saving…' : savedKey === type ? 'Saved ✓' : 'Save'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="mt-4 text-[11px] text-slate-500">
              Every change is recorded as a config_change event on the immutable audit trail.{' '}
              <button onClick={() => setPage('gov_audit')} className="text-indigo-400 hover:text-indigo-300 transition-colors">
                View Audit Trail →
              </button>
            </p>
          </div>

          {/* Earned Trust */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
            <div className="mb-1 flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold text-white">Earned trust</h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">promote slow · demote fast</span>
            </div>
            <p className="text-xs text-slate-500 mb-5">
              Alex earns wider autonomy from measured evidence — evaluation results, human review outcomes, and a clean guardrail record.
              A teammate approves each step up; any regression drops the level automatically. Guardrails always cap what's possible.
            </p>

            {trustError && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{trustError}</div>}

            <div className="space-y-4">
              {ACTION_ORDER.map(type => {
                const policy = policies[type];
                const ev = trustEvidence[type];
                if (!policy) return null;
                const meta = AUTONOMY_ACTION_META[type];
                return (
                  <div key={type} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-slate-200 font-medium">{meta.label}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">
                            {TRUST_LEVEL_LABELS[policy.current_level] ?? `Level ${policy.current_level}`}
                          </span>
                          {ev?.eligible && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">Eligible for promotion</span>
                          )}
                          {policy.pending_task_id && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">Awaiting approval</span>
                          )}
                        </div>
                      </div>
                      {ev && !ev.at_max_level && (
                        <button
                          onClick={() => void requestPromotion(policy)}
                          disabled={!ev.eligible || requestingId !== null || policy.pending_task_id !== null}
                          className="text-xs px-3 py-1.5 rounded-lg border text-emerald-300 border-emerald-800/50 hover:border-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex-shrink-0"
                          title={ev.eligible ? 'Sends a promotion request to Human Tasks — a teammate approves it' : 'Evidence has not yet met every criterion'}
                        >
                          {requestingId === policy.id ? 'Requesting…' : requestedId === policy.id ? 'Requested ✓' : `Request promotion to ${TRUST_LEVEL_LABELS[policy.target_level]}`}
                        </button>
                      )}
                    </div>

                    {ev ? (
                      <div className="mt-3 space-y-2">
                        {ev.criteria.map(c => {
                          const pct = c.required > 0 ? Math.min(100, Math.round((Number(c.actual) / Number(c.required)) * 100)) : 100;
                          const inverse = c.key === 'guardrail_blocks';
                          return (
                            <div key={c.key} className="flex items-center gap-3">
                              <div className="w-44 flex-shrink-0 text-[11px] text-slate-400">{c.label}</div>
                              <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${c.met ? 'bg-emerald-500' : 'bg-slate-600'}`}
                                  style={{ width: `${inverse ? (c.met ? 100 : 100) : pct}%`, opacity: inverse && !c.met ? 0.3 : 1 }}
                                />
                              </div>
                              <div className={`w-56 flex-shrink-0 text-[11px] ${c.met ? 'text-emerald-400' : 'text-slate-500'}`} title={c.detail}>
                                {c.met ? '✓ ' : ''}{c.detail}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="mt-3 text-[11px] text-slate-500">Evidence not available yet.</p>
                    )}
                  </div>
                );
              })}
            </div>

            {trustHistory.length > 0 && (
              <div className="mt-5">
                <h4 className="text-xs font-semibold text-slate-300 mb-2">Promotion history</h4>
                <ul className="space-y-1.5">
                  {trustHistory.map(h => (
                    <li key={h.id} className="text-[11px] text-slate-500 flex items-start gap-2">
                      <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        h.kind === 'trust_promoted' ? 'bg-emerald-500' :
                        h.kind === 'trust_demoted' ? 'bg-rose-500' :
                        h.kind === 'trust_manual_override' ? 'bg-amber-500' : 'bg-slate-600'
                      }`} />
                      <span className="flex-1">{h.action}</span>
                      <span className="flex-shrink-0 text-slate-600">{new Date(h.created_at).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="mt-4 text-[11px] text-slate-500">
              Evidence is computed on the server from the Proving Ground, human reviews, and the guardrail record — never asserted by the browser.
              Promotions and demotions are recorded on the immutable audit trail.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
