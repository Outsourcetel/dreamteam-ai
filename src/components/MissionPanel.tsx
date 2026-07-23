import React, { useCallback, useEffect, useState } from 'react';
import type { DigitalEmployee } from '../lib/digitalEmployeesApi';
import {
  listMissions, createMission, compileMission, approveMission, setMissionState, missionProgress,
  type MissionRow, type MissionProgress,
} from '../lib/missionApi';
import { Banner, Button, Chip, Drawer, EmptyState, Field, INPUT_CLS, PanelCard, type Tone } from '../design/primitives';

// Mission Delegation UI (docs/14): the directive box, the plan-approval
// drawer (plan gate: ALWAYS), and the per-mission console. Soft budget:
// estimates are shown and warned about, never enforced here — the tenant
// AI budget remains the hard ceiling.

const STATUS_CHIP: Record<string, { label: string; tone: Tone; pulse?: boolean }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  compiling: { label: 'Compiling…', tone: 'info', pulse: true },
  awaiting_approval: { label: 'Plan ready — review', tone: 'warn' },
  approved: { label: 'Approved', tone: 'info' },
  running: { label: 'Running', tone: 'info', pulse: true },
  paused: { label: 'Paused', tone: 'warn' },
  done: { label: 'Done', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Needs attention', tone: 'danger' },
};

export function PlanDrawer({ mission, onClose, onApproved }: {
  mission: MissionRow; onClose: () => void; onApproved: () => void;
}) {
  const plan = mission.compiled_plan;
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!plan) return null;

  const approve = async () => {
    setBusy(true); setError(null);
    try { await approveMission(mission.id, [...excluded]); onApproved(); onClose(); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const sample = plan.scope_preview?.sample ?? [];
  const count = plan.scope_preview?.count ?? (plan.shape === 'project' ? 1 : 0);
  return (
    <Drawer title="Mission plan — approve before anything moves" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">Your order</p>
          <p className="text-dt-body">{mission.directive_text}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">How it was understood</p>
          <p className="text-dt-body">{plan.interpretation}</p>
          <div className="mt-1.5 flex gap-2">
            <Chip tone="accent">{plan.shape}</Chip>
            {plan.playbook_key && <Chip tone="info">playbook: {plan.playbook_key}</Chip>}
          </div>
        </div>
        {plan.shape === 'batch' && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">
              Scope — {count} {plan.scope_preview?.entity_kind?.replace(/_/g, ' ')}(s)
              {plan.dedup && plan.dedup.count > 0 ? ` · ${plan.dedup.count} skipped (already in motion)` : ''}
            </p>
            <div className="rounded-lg border border-dt-border divide-y divide-dt-border max-h-56 overflow-y-auto">
              {sample.map(s => (
                <label key={s.ref} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-dt-panel">
                  <input type="checkbox" checked={!excluded.has(s.ref)}
                    onChange={() => setExcluded(prev => { const n = new Set(prev); if (n.has(s.ref)) n.delete(s.ref); else n.add(s.ref); return n; })} />
                  <span className="text-dt-body truncate">{s.label}</span>
                </label>
              ))}
            </div>
            {count > sample.length && (
              <p className="text-xs text-dt-muted mt-1">Showing the first {sample.length} of {count} — unticking here excludes those; the rest run as scoped.</p>
            )}
          </div>
        )}
        {plan.shape === 'project' && plan.subject && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">Subject</p>
            <p className="text-dt-body">{plan.subject}</p>
          </div>
        )}
        {plan.shape === 'standing' && plan.standing && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">
              Recurring — {plan.standing.cadence_words}
            </p>
            <div className="rounded-lg border border-dt-border divide-y divide-dt-border">
              {plan.standing.watchers.map((w, i) => (
                <div key={i} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Chip tone="info">{w.kind.replace(/_/g, ' ')}</Chip>
                    <span className="text-dt-body font-medium">{w.label}</span>
                  </div>
                  {w.description && <p className="text-xs text-dt-support mt-0.5">{w.description}</p>}
                  <p className="text-xs text-dt-muted mt-0.5">
                    {w.in_scope_count >= 0 ? `About ${w.in_scope_count} match this right now.` : 'Fires on its own schedule.'}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-dt-muted mt-1">This installs standing watchers — they keep opening cases on their own until you pause or cancel the mission.</p>
          </div>
        )}
        {plan.team && plan.routing_preview && (
          <div className="rounded-lg bg-dt-inset px-3 py-2">
            <p className="text-dt-body">
              Team mission — cases fan out across <span className="font-medium">{plan.routing_preview.candidate_count}</span> employee(s)
              {plan.routing_preview.candidate_count === 0 ? ' — none are eligible yet, so nothing will start.' : ', each working under their own guardrails.'}
            </p>
          </div>
        )}
        <div>
          <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">Procedure</p>
          <p className="text-dt-support leading-relaxed">{plan.procedure_summary}</p>
        </div>
        {(plan.gates ?? []).length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">Will stop at your desk</p>
            <div className="space-y-1">
              {(plan.gates ?? []).map((g, i) => <div key={i} className="flex items-center gap-2"><Chip tone="warn">gate</Chip><span className="text-dt-support">{g}</span></div>)}
            </div>
          </div>
        )}
        <div className="rounded-lg bg-dt-inset px-3 py-2">
          <p className="text-dt-body">Estimated AI cost: <span className="font-medium">${(mission.est_cost_usd ?? 0).toFixed(2)}</span> for {plan.est_cases ?? count} case(s)</p>
          <p className="text-xs text-dt-muted mt-0.5">Soft estimate — you'll be warned if actual spend passes it; your workspace AI budget remains the hard stop.</p>
        </div>
        {(plan.notes ?? []).length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">The employee's notes</p>
            <ul className="list-disc pl-5 text-dt-support space-y-0.5">{(plan.notes ?? []).map((n, i) => <li key={i}>{n}</li>)}</ul>
          </div>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="flex gap-2 pt-1">
          <Button kind="primary" disabled={busy} onClick={() => void approve()}>
            {busy ? 'Starting…'
              : plan.shape === 'standing' ? `Approve — install ${plan.standing?.watchers.length ?? 0} watcher(s)`
              : plan.shape === 'project' ? 'Approve — start the project'
              : `Approve — start ${Math.max(count - excluded.size - (plan.dedup?.count ?? 0), 0)} case(s)`}
          </Button>
          <Button kind="ghost" onClick={onClose}>Not yet</Button>
        </div>
      </div>
    </Drawer>
  );
}

export function MissionRowView({ m, onChanged, onReview }: { m: MissionRow; onChanged: () => void; onReview: (m: MissionRow) => void }) {
  const [progress, setProgress] = useState<MissionProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chip = STATUS_CHIP[m.status] ?? { label: m.status, tone: 'neutral' as Tone };

  useEffect(() => {
    if (!['running', 'paused', 'done'].includes(m.status)) return;
    let cancelled = false;
    void missionProgress(m.id).then(p => { if (!cancelled) setProgress(p); });
    return () => { cancelled = true; };
  }, [m.id, m.status]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); onChanged(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-3 flex-wrap">
        <Chip tone={chip.tone} dot pulse={chip.pulse}>{chip.label}</Chip>
        <p className="text-sm text-dt-body flex-1 min-w-[12rem] truncate">{m.directive_text}</p>
        {m.status === 'awaiting_approval' && <Button kind="primary" size="sm" onClick={() => onReview(m)}>Review plan</Button>}
        {['draft', 'failed'].includes(m.status) && (
          <Button kind="secondary" size="sm" disabled={busy} onClick={() => void act(async () => {
            const r = await compileMission(m.id);
            if (!r.ok) throw new Error(r.impossible ? `The employee says it can't: ${r.impossible}` : (r.error ?? 'Compile failed.'));
          })}>{busy ? 'Compiling…' : 'Compile plan'}</Button>
        )}
        {['running', 'paused'].includes(m.status) && (
          <>
            <Button kind="ghost" size="sm" disabled={busy}
              onClick={() => void act(() => setMissionState(m.id, m.status === 'paused' ? 'resume' : 'pause'))}>
              {m.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button kind="danger" size="sm" disabled={busy} onClick={() => void act(() => setMissionState(m.id, 'cancel'))}>Cancel</Button>
          </>
        )}
      </div>
      {progress && progress.total > 0 && (
        <div className="mt-1.5 flex items-center gap-2 pl-1">
          <div className="flex-1 max-w-xs bg-dt-inset rounded-full h-1.5">
            <div className="h-1.5 rounded-full bg-dt-accent" style={{ width: `${Math.round(100 * progress.achieved / progress.total)}%` }} />
          </div>
          <span className="text-xs text-dt-muted">
            {progress.achieved}/{progress.total} done · {progress.active} in motion{progress.blocked > 0 ? ` · ${progress.blocked} blocked` : ''}
          </span>
        </div>
      )}
      {m.report && (m.report.per_de || m.report.unrouted) && (Object.keys(m.report.per_de ?? {}).length > 0 || (m.report.unrouted?.length ?? 0) > 0) && (
        <p className="text-xs text-dt-muted mt-1 pl-1">
          {Object.keys(m.report.per_de ?? {}).length > 0 && `Fanned across ${Object.keys(m.report.per_de ?? {}).length} employee(s).`}
          {(m.report.unrouted?.length ?? 0) > 0 && ` ${m.report.unrouted!.length} left unrouted (no eligible employee).`}
        </p>
      )}
      {m.error && <p className="text-xs text-dt-danger mt-1 pl-1">{m.error}</p>}
      {error && <p className="text-xs text-dt-danger mt-1 pl-1">{error}</p>}
    </div>
  );
}

// docs/17 C4 — the five cross-department standing missions the market already
// buys as static playbooks (conducting.ai's orchestrators), shipped here as
// one-click directives. A template only FILLS THE ORDER BOX: the mission still
// compiles to a plan and waits at the founder gate like any other (docs/14).
const MISSION_TEMPLATES: Array<{ key: string; label: string; directive: string }> = [
  {
    key: 'customer_save', label: 'Customer Save',
    directive: 'Every week, find accounts whose health has turned at-risk, assess why, and prepare a save plan for my review before any outreach.',
  },
  {
    key: 'lead_lifecycle', label: 'Inbound Lead Lifecycle',
    directive: 'Work every open opportunity with no activity in the last 7 days: assess its stage, draft the next follow-up for my approval, and flag any that look stalled.',
  },
  {
    key: 'voc_loop', label: 'Voice of Customer',
    directive: 'Each month, review what customers asked and complained about, cluster the themes, and produce a voice-of-customer report with the top issues and suggested fixes.',
  },
  {
    key: 'exec_report', label: 'Monthly Exec Report',
    directive: 'At the start of each month, produce an executive report of workforce outcomes — resolutions, renewals touched, escalations, and spend — as a deliverable I can share.',
  },
  {
    key: 'incident_comms', label: 'Incident → Customer Comms',
    directive: 'When an incident affects customers, draft holding communications for each affected account and route every message to me for approval before anything is sent.',
  },
];

export default function MissionPanel({ de }: { de: DigitalEmployee }) {
  const [directive, setDirective] = useState('');
  const [missions, setMissions] = useState<MissionRow[] | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<MissionRow | null>(null);
  const name = de.persona_name ?? de.name;

  const load = useCallback(async () => {
    try {
      const r = await listMissions(de.id);
      setNotReady(r.notReady); setMissions(r.missions);
    } catch (e) { setError((e as Error).message); setMissions([]); }
  }, [de.id]);
  useEffect(() => { void load(); }, [load]);

  const give = async () => {
    if (directive.trim().length < 8) { setError('Say a little more — a mission needs at least a full sentence.'); return; }
    setBusy(true); setError(null);
    try {
      const id = await createMission(de.id, directive.trim());
      setDirective('');
      await load();
      const r = await compileMission(id);
      if (!r.ok) setError(r.impossible ? `${name} says it can't: ${r.impossible}` : (r.error ?? 'Compile failed — the mission is saved as a draft.'));
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <PanelCard title={`Missions — tell ${name} what to do`}>
      {notReady ? (
        <Banner tone="warn">The mission rail isn't applied to this workspace yet (migration 248 pending). The design is in docs/14.</Banner>
      ) : (
        <>
          <div className="flex gap-2 items-start">
            <textarea rows={2} value={directive} onChange={e => setDirective(e.target.value)}
              placeholder={`e.g. "Run renewals for every account with an agreement ending this quarter"`}
              className={`${INPUT_CLS} resize-none flex-1`} />
            <Button kind="primary" disabled={busy || !directive.trim()} onClick={() => void give()}>
              {busy ? 'Working…' : 'Compile mission plan'}
            </Button>
          </div>
          <p className="text-xs text-dt-muted mt-1.5">
            {name} reads your order back as a plan — scope, procedure, cost — and nothing starts until you approve it.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-dt-muted mr-1">Start from a standing template:</span>
            {MISSION_TEMPLATES.map(t => (
              <button key={t.key} onClick={() => setDirective(t.directive)}
                title={t.directive}
                className="text-xs px-2.5 py-1 rounded-full border border-dt-border-strong text-dt-support hover:border-indigo-500 hover:text-white transition-colors">
                {t.label}
              </button>
            ))}
          </div>
          {error && <div className="mt-2"><Banner tone="danger">{error}</Banner></div>}
          <div className="mt-3 divide-y divide-dt-border">
            {missions === null ? (
              <p className="text-xs text-dt-muted py-3">Loading missions…</p>
            ) : missions.length === 0 ? (
              <EmptyState icon="🎯" headline="No missions yet">
                Give {name} a one-sentence order above — batches ("run renewals for Q3"), projects ("implement the books for client X"), or recurring cadences.
              </EmptyState>
            ) : (
              missions.map(m => <MissionRowView key={m.id} m={m} onChanged={() => void load()} onReview={setReview} />)
            )}
          </div>
        </>
      )}
      {review && <PlanDrawer mission={review} onClose={() => setReview(null)} onApproved={() => void load()} />}
    </PanelCard>
  );
}
