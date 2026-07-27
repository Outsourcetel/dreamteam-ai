import React, { useState, useEffect, useCallback } from 'react';
import { listAutonomy, setAutonomyDial, AUTONOMY_ACTION_META } from '../lib/autonomyApi';
import type { DEAutonomy, AutonomyActionType } from '../lib/autonomyApi';
import { listTrustPolicies, listTrustHistory, trustLevelName } from '../lib/trustApi';
import type { TrustPolicy, TrustHistoryEvent } from '../lib/trustApi';
import { Chip, EmptyState } from '../design/primitives';

// ════════════════════════════════════════════════════════════════════
// Workforce trust defaults — the Settings home (docs/31 Q7, founder ask
// 2026-07-27). Workspace-default dial rows (de_id NULL) used to be
// editable only from inside one arbitrary employee's file; they live
// here now, next to the tenant-wide promotion history. Per-employee
// trust stays on each employee's file — nothing per-DE is shown here.
//
// Reads are the existing idioms: de_autonomy via the RLS-governed
// listAutonomy() read, trust_policies via listTrustPolicies(), history
// from the immutable audit trail. Writes go through the same
// set_de_autonomy RPC every dial uses (deId = null → workspace-wide).
// Tab access is owner/admin (navAccess SETTINGS_TAB_ACCESS.trust),
// matching the database gate on workspace-wide trust writes.
// ════════════════════════════════════════════════════════════════════

/** The three engine-recognized dials every workspace has, shown even before
 *  a row exists so a default can be set without hunting for an entry point. */
const CANONICAL_KEYS: AutonomyActionType[] = ['invoice_auto_send', 'answer_dock', 'answer_widget'];

interface DialDraft { enabled: boolean; amount: string; confidence: string }

function labelFor(key: string): string {
  const meta = AUTONOMY_ACTION_META[key as AutonomyActionType];
  if (meta) return meta.label;
  if (key.startsWith('action:')) {
    const cat = key.slice('action:'.length).replace(/_/g, ' ');
    return `${cat.charAt(0).toUpperCase()}${cat.slice(1)} actions`;
  }
  return key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

/** Which numeric field a key's enforcement reads (mirrors the server's
 *  measured flags: answer channels read a confidence floor; everything
 *  else on the dial reads an amount cap). Display/edit routing only. */
const usesConfidence = (key: string) => key === 'answer_dock' || key === 'answer_widget';

export default function WorkforceTrustDefaults() {
  const [rows, setRows] = useState<DEAutonomy[] | null>(null);
  const [policies, setPolicies] = useState<TrustPolicy[] | null>(null);
  const [history, setHistory] = useState<TrustHistoryEvent[] | null>(null);
  const [dialError, setDialError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DialDraft>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Each block loads independently — a failure renders as its own honest
    // error + absence, never as an empty-but-fine claim.
    try {
      const all = await listAutonomy();
      const workspace = all.filter(a => a.de_id === null && a.source_category === null);
      setRows(workspace);
      const byKey = Object.fromEntries(workspace.map(a => [a.action_type as string, a]));
      const keys = Array.from(new Set<string>([...CANONICAL_KEYS, ...workspace.map(a => a.action_type as string)]));
      setDrafts(Object.fromEntries(keys.map(k => {
        const a = byKey[k];
        return [k, {
          enabled: a?.enabled ?? false,
          amount: a?.max_amount_cents != null ? String(Math.round(a.max_amount_cents / 100)) : '',
          confidence: a?.min_confidence != null ? String(a.min_confidence) : '',
        }];
      })));
      setDialError(null);
    } catch (err) {
      setRows(null);
      setDialError((err as Error)?.message || 'Failed to load the workspace dials.');
    }
    try {
      setPolicies((await listTrustPolicies()).filter(p => p.de_id === null));
      setPolicyError(null);
    } catch (err) {
      setPolicies(null);
      setPolicyError((err as Error)?.message || 'Failed to load the workspace trust policies.');
    }
    try {
      setHistory(await listTrustHistory(20));
      setHistoryError(null);
    } catch (err) {
      setHistory(null);
      setHistoryError((err as Error)?.message || 'Failed to load the promotion history.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async (key: string) => {
    const d = drafts[key];
    if (!d) return;
    setSavingKey(key);
    setDialError(null);
    try {
      await setAutonomyDial(key, labelFor(key), {
        enabled: d.enabled,
        max_amount_cents: !usesConfidence(key) && d.amount.trim() !== ''
          ? Math.max(0, Math.round(Number(d.amount) || 0)) * 100 : null,
        min_confidence: usesConfidence(key) && d.confidence.trim() !== ''
          ? Math.max(0, Math.min(100, Math.round(Number(d.confidence) || 0))) : null,
      }, null);
      await refresh();
      setSavedKey(key);
      setTimeout(() => setSavedKey(k => (k === key ? null : k)), 2500);
    } catch (err) {
      setDialError((err as Error)?.message || 'Failed to save.');
    } finally {
      setSavingKey(null);
    }
  };

  const workspaceKeys = rows === null
    ? []
    : Array.from(new Set<string>([...CANONICAL_KEYS, ...rows.map(a => a.action_type as string)]));
  const rowByKey = Object.fromEntries((rows ?? []).map(a => [a.action_type as string, a]));

  return (
    <div className="max-w-3xl space-y-4">
      <div className="bg-dt-card border border-dt-border rounded-xl p-5">
        <div className="mb-1 flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-white">Workforce trust defaults</h2>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">workspace-wide</span>
        </div>
        <p className="text-xs text-dt-muted mb-1">
          These dials are the shared defaults — an employee without a personal override follows them.
          <span className="text-dt-support"> Per-employee trust lives on each employee's file</span> (Workforce →
          the employee → Trust &amp; Autonomy); nothing per-employee is edited here.
        </p>
        <p className="text-[11px] text-dt-muted mb-4">
          Autonomy narrows within guardrails — a default here never overrides a guardrail, a destructive
          gate or a spend cap. Every change lands on the immutable audit trail.
        </p>

        {dialError && <div className="mb-3 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{dialError}</div>}

        {rows === null ? (
          !dialError && <p className="text-xs text-dt-muted">Loading workspace dials…</p>
        ) : (
          <div className="space-y-3">
            {workspaceKeys.map(key => {
              const d = drafts[key] ?? { enabled: false, amount: '', confidence: '' };
              const existing = rowByKey[key];
              const meta = AUTONOMY_ACTION_META[key as AutonomyActionType];
              return (
                <div key={key} className="rounded-xl border border-dt-border bg-dt-inset p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-dt-body font-medium">{labelFor(key)}</span>
                        {!existing && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted"
                            title="No workspace row exists yet — saving creates one.">
                            not set
                          </span>
                        )}
                      </div>
                      {meta && <p className="text-[11px] text-dt-muted mt-1">{meta.description}</p>}
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <input type="checkbox" checked={d.enabled}
                        onChange={e => setDrafts(prev => ({ ...prev, [key]: { ...d, enabled: e.target.checked } }))}
                        className="accent-indigo-500" />
                      <span className="text-xs text-dt-support">{d.enabled ? 'Enabled' : 'Off'}</span>
                    </label>
                  </div>
                  <div className="mt-3 flex items-center gap-3 flex-wrap">
                    {usesConfidence(key) ? (
                      <label className="flex items-center gap-2 text-xs text-dt-support">
                        Min confidence %
                        <input type="number" min={0} max={100} value={d.confidence} placeholder="e.g. 75"
                          onChange={e => setDrafts(prev => ({ ...prev, [key]: { ...d, confidence: e.target.value } }))}
                          className="w-20 bg-dt-card border border-dt-border-strong rounded-lg px-2 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none" />
                      </label>
                    ) : (
                      <label className="flex items-center gap-2 text-xs text-dt-support">
                        Max amount $
                        <input type="number" min={0} value={d.amount} placeholder="e.g. 5000"
                          onChange={e => setDrafts(prev => ({ ...prev, [key]: { ...d, amount: e.target.value } }))}
                          className="w-28 bg-dt-card border border-dt-border-strong rounded-lg px-2 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none" />
                      </label>
                    )}
                    <button onClick={() => void save(key)} disabled={savingKey !== null}
                      className="text-xs px-3 py-1.5 rounded-lg border text-indigo-300 border-indigo-800/50 hover:border-indigo-500 disabled:opacity-50 transition-all">
                      {savingKey === key ? 'Saving…' : savedKey === key ? 'Saved ✓' : 'Save'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="bg-dt-card border border-dt-border rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-1">Workspace-wide earned trust</h2>
        <p className="text-[11px] text-dt-muted mb-3">
          Ladder policies with no owning employee — their promotions move the workspace defaults above,
          not any single employee's badge. Each employee's own ladder is on their file.
        </p>
        {policyError && <div className="mb-3 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{policyError}</div>}
        {policies === null ? (
          !policyError && <p className="text-xs text-dt-muted">Loading policies…</p>
        ) : policies.length === 0 ? (
          <EmptyState icon="🪜" headline="No workspace-wide trust policies">
            Every trust policy in this workspace is scoped to a specific employee.
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {policies.map(p => (
              <div key={p.id} className="flex items-center gap-3 rounded-xl border border-dt-border bg-dt-inset px-4 py-2.5 flex-wrap">
                <span className="text-sm text-dt-body font-medium flex-1 min-w-0 truncate">
                  {p.display_name || labelFor(p.action_category)}
                </span>
                <Chip tone="accent">{trustLevelName(p, p.current_level)}</Chip>
                {p.ladder && p.ladder.length > 0
                  ? <Chip tone="info">custom ladder · {p.ladder.length} level{p.ladder.length === 1 ? '' : 's'}</Chip>
                  : <span className="text-[10px] text-dt-muted">built-in levels</span>}
                {p.pending_task_id && <Chip tone="warn">Awaiting approval</Chip>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-dt-card border border-dt-border rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-1">Promotion history</h2>
        <p className="text-[11px] text-dt-muted mb-3">
          Tenant-wide promotions, demotions and manual overrides, from the immutable audit trail.
        </p>
        {historyError && <div className="mb-3 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{historyError}</div>}
        {history === null ? (
          !historyError && <p className="text-xs text-dt-muted">Loading history…</p>
        ) : history.length === 0 ? (
          <p className="text-xs text-dt-muted">No promotions or demotions recorded yet — trust moves only on evidence, approved by a person.</p>
        ) : (
          <ul className="space-y-1.5">
            {history.map(h => (
              <li key={h.id} className="text-[11px] text-dt-muted flex items-start gap-2">
                <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  h.kind === 'trust_promoted' ? 'bg-emerald-500' :
                  h.kind === 'trust_demoted' ? 'bg-rose-500' :
                  h.kind === 'trust_manual_override' ? 'bg-amber-500' : 'bg-slate-600'
                }`} />
                <span className="flex-1">{h.action}</span>
                <span className="flex-shrink-0 text-dt-faint">{new Date(h.created_at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
