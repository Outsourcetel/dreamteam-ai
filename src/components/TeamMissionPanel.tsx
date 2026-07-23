import React, { useCallback, useEffect, useState } from 'react';
import {
  listTeamMissions, createTeamMission, compileMission, listArchetypeTargets,
  type MissionRow, type MissionTargetSpec,
} from '../lib/missionApi';
import { PlanDrawer, MissionRowView } from './MissionPanel';
import { Banner, Button, EmptyState, INPUT_CLS, PanelCard } from '../design/primitives';

// Cross-DE (team) missions (T2.4): give ONE order to a whole role, and the
// engine routes each case to the right team member. Backend rejects any
// out-of-tenant receiver at creation; approve() shows the routing split and
// records anyone left unrouted — nothing silently disappears.

const humanizeArchetype = (k: string) =>
  k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

export default function TeamMissionPanel() {
  const [directive, setDirective] = useState('');
  const [archetypes, setArchetypes] = useState<{ archetype_key: string; count: number }[]>([]);
  const [target, setTarget] = useState<string>('');
  const [missions, setMissions] = useState<MissionRow[] | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<MissionRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([listArchetypeTargets(), listTeamMissions()]);
      setArchetypes(t);
      if (!target && t.length) setTarget(t[0].archetype_key);
      setNotReady(r.notReady); setMissions(r.missions);
    } catch (e) { setError((e as Error).message); setMissions([]); }
  }, [target]);
  useEffect(() => { void load(); }, [load]);

  const give = async () => {
    if (directive.trim().length < 8) { setError('Say a little more — a mission needs at least a full sentence.'); return; }
    if (!target) { setError('Pick which team should take this on.'); return; }
    setBusy(true); setError(null);
    try {
      const spec: MissionTargetSpec = { kind: 'archetype', archetype_key: target, routing: 'auto' };
      const id = await createTeamMission(spec, directive.trim());
      setDirective('');
      await load();
      const r = await compileMission(id);
      if (!r.ok) setError(r.impossible ? `The team says it can't: ${r.impossible}` : (r.error ?? 'Compile failed — the mission is saved as a draft.'));
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  if (notReady) return null;  // migration 274 not applied — stay quiet on the board

  return (
    <PanelCard title="Give the whole team an order">
      <div className="flex flex-wrap gap-2 items-start">
        <select value={target} onChange={e => setTarget(e.target.value)} className={`${INPUT_CLS} w-auto`}>
          {archetypes.length === 0 && <option value="">No role teams yet</option>}
          {archetypes.map(a => (
            <option key={a.archetype_key} value={a.archetype_key}>
              The whole {humanizeArchetype(a.archetype_key)} team ({a.count})
            </option>
          ))}
        </select>
        <textarea rows={2} value={directive} onChange={e => setDirective(e.target.value)}
          placeholder={`e.g. "Chase every account with a renewal closing this quarter"`}
          className={`${INPUT_CLS} resize-none flex-1 min-w-[16rem]`} />
        <Button kind="primary" disabled={busy || !directive.trim() || !target} onClick={() => void give()}>
          {busy ? 'Working…' : 'Compile team plan'}
        </Button>
      </div>
      <p className="text-xs text-dt-muted mt-1.5">
        The team reads your order back as a plan — who takes each case, the procedure, the cost — and nothing starts until you approve it. Each member works under its own guardrails.
      </p>
      {error && <div className="mt-2"><Banner tone="danger">{error}</Banner></div>}
      <div className="mt-3 divide-y divide-dt-border">
        {missions === null ? (
          <p className="text-xs text-dt-muted py-3">Loading team missions…</p>
        ) : missions.length === 0 ? (
          <EmptyState icon="👥" headline="No team missions yet">
            Give a whole role one order above — the cases fan out across everyone who holds that role.
          </EmptyState>
        ) : (
          missions.map(m => <MissionRowView key={m.id} m={m} onChanged={() => void load()} onReview={setReview} />)
        )}
      </div>
      {review && <PlanDrawer mission={review} onClose={() => setReview(null)} onApproved={() => void load()} />}
    </PanelCard>
  );
}
