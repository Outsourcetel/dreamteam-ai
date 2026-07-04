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
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load the trust dial.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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
        </div>
      )}
    </div>
  );
}
