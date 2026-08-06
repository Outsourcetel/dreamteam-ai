import React, { useState, useEffect, useCallback } from 'react';
import { AUTONOMY_ACTION_META } from '../lib/autonomyApi';
import type { AutonomyActionType } from '../lib/autonomyApi';
import { listTrustPolicies, listTrustHistory, trustLevelName } from '../lib/trustApi';
import type { TrustPolicy, TrustHistoryEvent } from '../lib/trustApi';
import { Chip, EmptyState } from '../design/primitives';
import type { Page } from '../types';

// ════════════════════════════════════════════════════════════════════
// Workforce trust — the Settings home.
//
// ⚠ THIS PAGE NO LONGER EDITS DIALS. It used to hold three workspace-wide
// dials (invoice_auto_send, answer_dock, answer_widget) that applied to every
// employee — a fixed list, one of them invoice-specific, describing a Support
// or Marketing employee in billing terms whatever its actual job.
//
// Migration 618 removed the workspace tier outright: every rule now names the
// employee it governs, the dial set is DERIVED from the systems each employee
// can actually reach, and set_de_autonomy REFUSES a write with no employee. So
// the old editor could not save anything even if it were kept.
//
// What remains here is genuinely workspace-level and still true: ladder
// policies owned by no employee, and the tenant-wide promotion history.
// Per-employee rules live on Workforce → the employee → Trust & Autonomy.
// ════════════════════════════════════════════════════════════════════

function labelFor(key: string): string {
  const meta = AUTONOMY_ACTION_META[key as AutonomyActionType];
  if (meta) return meta.label;
  if (key.startsWith('action:')) {
    const cat = key.slice('action:'.length).replace(/_/g, ' ');
    return `${cat.charAt(0).toUpperCase()}${cat.slice(1)} actions`;
  }
  return key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

export default function WorkforceTrustDefaults({ setPage }: { setPage?: (p: Page) => void } = {}) {
  const [policies, setPolicies] = useState<TrustPolicy[] | null>(null);
  const [history, setHistory] = useState<TrustHistoryEvent[] | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Each block loads independently — a failure renders as its own honest
    // error + absence, never as an empty-but-fine claim.
    //
    // The workspace-dial read that used to open this function is gone with the
    // editor: migration 618 deleted the workspace tier, so listAutonomy() would
    // now always return an empty set here and the panel would render an empty
    // table that looked merely unconfigured rather than deliberately removed.
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

  // The save handler that lived here wrote a rule with de_id = null. Since
  // migration 618 that is a hard error ("a rule must name the employee it
  // governs"), so keeping it would have meant a button that throws.

  return (
    <div className="max-w-3xl space-y-4">
      {/* ⚠ THE WORKSPACE DIAL EDITOR THAT USED TO BE HERE IS GONE.
          Migration 618 removed the workspace tier entirely and
          set_de_autonomy now REFUSES a write that names no employee, so this
          editor could not save anything — it would throw on every click.

          It was also the surface the founder called out: a fixed list of
          three dials, one of them invoice-specific, describing every
          employee in billing-and-answering terms whatever its actual job. */}
      <div className="bg-dt-card border border-dt-border rounded-xl p-5">
        <div className="mb-1 flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-white">What each employee may do on its own</h2>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">per employee</span>
        </div>
        <p className="text-xs text-dt-muted mb-2">
          There are no workspace-wide dials any more. Every rule names the employee it governs,
          because a Finance employee reaching nine systems and a Growth employee reaching two
          should not be held to one blanket setting.
        </p>
        <p className="text-xs text-dt-support mb-3">
          Open <strong>Workforce → the employee → Trust &amp; Autonomy</strong>. Each employee shows one
          dial per system it can actually reach, and a rule can be narrowed further to a single
          playbook. Where no rule is set the employee does nothing automatically — it prepares the
          work and a person decides.
        </p>
        {setPage && (
          <button onClick={() => setPage('workforce_des')}
            className="text-xs px-3 py-1.5 rounded-lg bg-dt-panel hover:bg-dt-border text-dt-support transition-colors">
            Open the workforce →
          </button>
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
