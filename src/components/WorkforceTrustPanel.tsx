import React, { useCallback, useEffect, useState } from 'react';
import {
  getWorkforceTrustMetrics, getWorkforcePosture,
  pauseWorkforceAutonomy, resumeWorkforceAutonomy,
} from '../lib/trustApi';
import type { WorkforceTrustMetrics, WorkforcePosture } from '../lib/trustApi';
import { PanelCard, StatTile, Banner, Button, Chip, Field, INPUT_CLS } from '../design/primitives';
import { useAuth } from '../context/AuthContext';

// ════════════════════════════════════════════════════════════════════
// Workforce trust — the ORG-level view (migrations 621/622 + 624/625).
//
// Every number here is job-agnostic. It is computed from the SHAPE of the work
// — was a human needed, did they change it, how long did they look — never from
// what the work was about, so a Support employee and a Finance employee are
// measured identically. Per-employee rules live on each employee's own file.
//
// ⚠ THREE HONESTY RULES THIS PANEL MUST KEEP:
//  1. A rate below its minimum sample is NOT shown. The server returns null and
//     a flag; printing 700% (which the first version did, from 28 incidents
//     over 4 actions) teaches the reader to distrust every other number.
//  2. A 0% intervention rate is only meaningful if a reversal has ever been
//     performed. It never has here, so we say that instead of showing a
//     reassuring zero.
//  3. A high acceptance rate next to a seconds-long median decision is not
//     trust, it is a rubber stamp — and is called out as such.
// ════════════════════════════════════════════════════════════════════

const WINDOWS = [7, 30, 90] as const;

function humanDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = seconds / 60;
  if (m < 90) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)} h` : `${Math.round(h / 24)} days`;
}

/** A rate, or an honest reason there isn't one yet. */
function Rate({ value, enough, need, have, unit = '%' }: {
  value: number | null; enough: boolean; need: number; have: number; unit?: string;
}) {
  if (value !== null) return <>{value}{unit}</>;
  return (
    <span className="text-dt-muted text-base font-normal">
      not yet · {have}/{need}
    </span>
  );
}

export default function WorkforceTrustPanel({ setPage }: { setPage?: (p: string) => void }) {
  const { authedUser, isDTUser } = useAuth();
  const canStop = isDTUser || ['tenant_owner', 'tenant_admin', 'tenant_manager'].includes(authedUser?.role ?? '');
  const canResume = isDTUser || ['tenant_owner', 'tenant_admin'].includes(authedUser?.role ?? '');

  const [days, setDays] = useState<number>(30);
  const [m, setM] = useState<WorkforceTrustMetrics | null>(null);
  const [posture, setPosture] = useState<WorkforcePosture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [metrics, p] = await Promise.all([getWorkforceTrustMetrics(days), getWorkforcePosture()]);
      setM(metrics); setPosture(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const stop = async () => {
    if (!reason.trim()) { setError('Say why — a stop nobody can review later is not a control.'); return; }
    setBusy(true); setError(null);
    try { await pauseWorkforceAutonomy(reason.trim()); setReason(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const start = async () => {
    setBusy(true); setError(null);
    try { await resumeWorkforceAutonomy(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const paused = posture?.autonomy_paused === true;
  const byBreaker = paused && !!posture?.breaker_tripped_at;

  return (
    <div className="max-w-4xl space-y-4">
      {error && <Banner tone="danger">{error}</Banner>}

      {/* ── The stop button. First, because when it matters nothing else does ── */}
      <PanelCard
        title="Autonomy across the whole workforce"
        badge={paused ? <Chip tone="danger">STOPPED</Chip> : <Chip tone="ok">Running</Chip>}
      >
        {paused ? (
          <>
            <Banner tone={byBreaker ? 'danger' : 'warn'} className="mb-3">
              {byBreaker
                ? <>Stopped <strong>automatically</strong> by the circuit breaker — {posture?.breaker_tripped_why}</>
                : <>Stopped by a person — {posture?.paused_reason}</>}
              {posture?.paused_at && <> ({new Date(posture.paused_at).toLocaleString()})</>}
            </Banner>
            <p className="text-xs text-dt-support mb-3">
              Nothing runs on its own anywhere in this workspace. Employees still prepare work and
              still answer; every action goes to a person until you restart.
            </p>
            {canResume
              ? <Button size="sm" disabled={busy} onClick={() => void start()}>
                  {busy ? 'Restarting…' : 'Restart the workforce'}
                </Button>
              : <p className="text-[11px] text-dt-faint">Only an owner or admin can restart.</p>}
          </>
        ) : (
          <>
            <p className="text-xs text-dt-support mb-3">
              Employees act within the rules set on their own files. Stopping here overrides all of
              them at once — every action goes to a person until you restart. The circuit breaker
              does the same automatically if incidents or guardrail blocks spike.
            </p>
            {canStop ? (
              <div className="flex items-end gap-2 flex-wrap">
                <Field label="Why are you stopping it?">
                  <input className={`${INPUT_CLS} !py-1.5 !text-xs min-w-[280px]`} value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. investigating a bad invoice run" />
                </Field>
                <Button kind="danger" size="sm" disabled={busy || !reason.trim()} onClick={() => void stop()}>
                  {busy ? 'Stopping…' : 'Stop all autonomy'}
                </Button>
              </div>
            ) : (
              <p className="text-[11px] text-dt-faint">Only an owner, admin or manager can stop the workforce.</p>
            )}
          </>
        )}
      </PanelCard>

      {/* ── The measures ── */}
      <PanelCard
        title="How much this workforce has earned"
        badge={
          <div className="flex gap-1">
            {WINDOWS.map((d) => (
              <button key={d} onClick={() => setDays(d)}
                className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                  days === d ? 'bg-dt-accent-soft text-dt-accent-text' : 'text-dt-muted hover:text-dt-support'}`}>
                {d}d
              </button>
            ))}
          </div>
        }
      >
        {m === null ? (
          <p className="text-xs text-dt-muted">Loading…</p>
        ) : (
          <>
            <p className="text-xs text-dt-support mb-3">
              These describe the workforce as a whole, not any one job. Each is computed from how the
              work was handled — whether a person was needed, whether they changed it, how long they
              looked — so every employee is measured the same way.
            </p>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
              <StatTile
                label="Done without a person"
                value={<Rate value={m.autonomy_rate} enough={m.enough_performed}
                             need={m.min_actions_for_a_rate} have={m.actions_performed} />}
                sub={`${m.actions_autonomous} of ${m.actions_performed} performed`}
                tone={m.autonomy_rate !== null && m.autonomy_rate > 0 ? 'ok' : 'neutral'}
              />
              <StatTile
                label="Approved unchanged"
                value={<Rate value={m.acceptance_rate} enough={m.enough_decisions}
                             need={m.min_decisions_for_a_rate} have={m.decisions} />}
                sub={`${m.decisions_unchanged} kept · ${m.decisions_edited} edited · ${m.decisions_rejected} rejected`}
                tone={m.acceptance_rate !== null && m.acceptance_rate >= 80 ? 'ok' : 'warn'}
              />
              <StatTile
                label="Time to decide"
                value={humanDuration(m.median_seconds_to_decide)}
                sub={m.rubber_stamp_risk ? 'too fast to be a real check' : `${m.decisions} decision${m.decisions === 1 ? '' : 's'}, median`}
                tone={m.rubber_stamp_risk ? 'danger' : 'neutral'}
              />
              <StatTile
                label="Employees with a rule"
                value={m.rule_coverage_rate === null ? '—' : `${m.rule_coverage_rate}%`}
                sub={`${m.employees_with_a_rule} of ${m.employees_active} — the rest do nothing on their own`}
                tone={m.rule_coverage_rate !== null && m.rule_coverage_rate < 50 ? 'warn' : 'neutral'}
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <StatTile
                label="Guardrail blocks"
                value={<Rate value={m.guardrail_block_rate} enough={m.enough_considered}
                             need={m.min_actions_for_a_rate} have={m.actions_considered} />}
                sub={`${m.guardrail_blocks} caught of ${m.actions_considered} judged`}
                tone={m.guardrail_block_rate !== null && m.guardrail_block_rate > 20 ? 'warn' : 'neutral'}
              />
              <StatTile label="Sent to a person" value={m.human_gated}
                sub="stopped for approval" tone="neutral" />
              <StatTile label="Incidents" value={m.incidents}
                sub={m.incident_rate_per_100_actions !== null
                  ? `${m.incident_rate_per_100_actions} per 100 actions`
                  : 'count only — too few actions for a rate'}
                tone={m.incidents > 0 ? 'warn' : 'neutral'} />
              <StatTile label="Reversed after the fact" value={m.interventions}
                sub={m.intervention_ever_recorded ? 'human undid the work' : 'never used here'}
                tone="neutral" />
            </div>

            {/* ⚠ The three honesty notes. Each exists because the number above it
                can be read as good news when it is not. */}
            {m.rubber_stamp_risk && (
              <Banner tone="danger" className="mt-3">
                <strong>Those approvals are not really checks.</strong> {m.decided_under_a_minute} of {m.decisions} were
                decided in under a minute. A high “approved unchanged” next to this measures how fast people
                click, not how well the workforce performs.
              </Banner>
            )}
            {!m.intervention_ever_recorded && (
              <Banner tone="info" className="mt-3">
                No work has ever been reversed here — so “{m.interventions} reversed” means the undo path has
                never been used, <strong>not</strong> that nothing needed undoing. Treat it as unmeasured.
              </Banner>
            )}
            {!m.enough_performed && (
              <Banner tone="warn" className="mt-3">
                Only {m.actions_performed} action{m.actions_performed === 1 ? '' : 's'} were actually performed in this
                window, so rates that divide by them are withheld rather than shown on a sample too small to mean
                anything. Counts are still exact.
              </Banner>
            )}

            <p className="mt-3 text-[10px] text-dt-faint">
              Window: last {m.window_days} days · as of {new Date(m.as_of).toLocaleString()} ·
              rates need at least {m.min_actions_for_a_rate} actions or {m.min_decisions_for_a_rate} decisions.
            </p>
          </>
        )}
      </PanelCard>
    </div>
  );
}
