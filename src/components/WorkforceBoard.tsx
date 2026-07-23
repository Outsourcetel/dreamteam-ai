import React, { useEffect, useState } from 'react';
import { getWorkforceBoard, type WorkforceBoardRow } from '../lib/missionApi';
import { useOpenEmployeeFile } from '../lib/employeeFileRoute';
import TeamMissionPanel from './TeamMissionPanel';
import { Banner, Chip, PanelCard, type Tone } from '../design/primitives';
import type { Page } from '../types';

// The workforce board (docs/17 C2) — every employee's now / next / blocked
// on one card, whether or not it has a live work row this second. This is
// the read the operating-model audit proved missing (gap #2) and the one
// conducting.ai ships as a static drawing; ours is live telemetry.

const NEXT_ICON: Record<string, string> = {
  work_item: '📋', case_wait: '⏸', watcher: '👁', objective_wake: '🔁',
};

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return 'when its turn comes';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 60_000) return 'due now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h} h`;
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function WorkforceBoard({ setPage }: { setPage: (p: Page) => void }) {
  const openFile = useOpenEmployeeFile(setPage);
  const [rows, setRows] = useState<WorkforceBoardRow[] | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missionsUsed, setMissionsUsed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getWorkforceBoard()
        .then(r => { if (!cancelled) { setNotReady(r.notReady); setRows(r.board); } })
        .catch(e => { if (!cancelled) setError((e as Error).message); });
    load();
    const t = setInterval(load, 30_000);
    // Maturity phase signal (docs/17 C5): missions used = the workspace has
    // reached orchestration. Derived from real usage, never self-declared.
    import('../supabase').then(({ supabase }) =>
      supabase.from('de_missions').select('id', { count: 'exact', head: true })
        .then(({ count }) => { if (!cancelled) setMissionsUsed((count ?? 0) > 0); }))
      .catch(() => { /* chip simply doesn't render */ });
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (notReady || error) return error ? <Banner tone="danger">{error}</Banner> : null;
  if (rows === null) {
    return (
      <PanelCard title="The board — whole workforce">
        <p className="text-sm text-dt-muted py-4 text-center">Reading the workforce…</p>
      </PanelCard>
    );
  }

  const totalWaiting = rows.reduce((s, r) => s + r.waiting_on_you, 0);
  const anyOperating = rows.some(r => r.done_today > 0 || r.next_up.length > 0 || r.now != null || r.listens_live);
  const phase = missionsUsed
    ? { n: 3, label: 'Phase 3 · Orchestrated', hint: 'You give standing missions; employees plan and fan out under your gates.' }
    : anyOperating
      ? { n: 2, label: 'Phase 2 · Supervised autonomy', hint: 'Employees work on their own schedules under approval gates. Give a standing mission to reach Phase 3.' }
      : { n: 1, label: 'Phase 1 · Assisted', hint: 'Employees answer when spoken to. Install a role kit or add watchers to reach Phase 2.' };

  return (
    <div className="space-y-4">
    <PanelCard
      title="The board — whole workforce"
      badge={
        <span className="inline-flex items-center gap-1.5">
          {missionsUsed !== null && <span title={phase.hint}><Chip tone={phase.n === 3 ? 'accent' : 'info'}>{phase.label}</Chip></span>}
          {totalWaiting > 0
            ? <Chip tone="warn">{totalWaiting} item{totalWaiting === 1 ? '' : 's'} wait on you</Chip>
            : <Chip tone="ok">nothing waits on you</Chip>}
        </span>
      }
    >
      <p className="text-xs text-dt-support mb-3">
        Every employee — what it's doing now, what happens next and when, and where you're the bottleneck.
        Click a row to open the employee's file.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-dt-muted border-b border-dt-border">
              <th className="py-2 pr-3 font-medium">Employee</th>
              <th className="py-2 pr-3 font-medium">Now</th>
              <th className="py-2 pr-3 font-medium">Next up</th>
              <th className="py-2 pr-3 font-medium">Blocked</th>
              <th className="py-2 font-medium text-right">Done today</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dt-border">
            {rows.map(r => {
              const next = r.next_up[0];
              const paused = r.lifecycle_status !== 'active';
              return (
                <tr key={r.de_id} onClick={() => openFile(r.de_id)}
                  className="cursor-pointer hover:bg-dt-panel/60 transition-colors">
                  <td className="py-2.5 pr-3">
                    <span className={`font-medium ${paused ? 'text-dt-muted' : 'text-dt-body'}`}>{r.persona_name ?? r.name}</span>
                    {r.department && <span className="text-xs text-dt-muted ml-2">{r.department}</span>}
                    {paused && <Chip tone="neutral">{r.lifecycle_status}</Chip>}
                  </td>
                  <td className="py-2.5 pr-3">
                    {r.now
                      ? <span className="inline-flex items-center gap-2"><Chip tone={'info' as Tone} dot pulse>working</Chip><span className="text-dt-body truncate max-w-[16rem] inline-block align-middle">{r.now.title}</span></span>
                      : r.listens_live
                        ? <span className="text-dt-support text-xs">listening to the live inbox</span>
                        : <span className="text-dt-muted text-xs">idle</span>}
                  </td>
                  <td className="py-2.5 pr-3">
                    {next
                      ? <span className="text-dt-body">{NEXT_ICON[next.kind] ?? '•'} <span className="truncate max-w-[18rem] inline-block align-middle">{next.title}</span> <span className="text-xs text-dt-muted">· {fmtWhen(next.when)}</span></span>
                      : <span className="text-dt-muted text-xs">nothing scheduled — works when spoken to</span>}
                  </td>
                  <td className="py-2.5 pr-3">
                    {r.waiting_on_you > 0 && <Chip tone="warn">waits on you ×{r.waiting_on_you}</Chip>}
                    {r.blocked_objectives > 0 && <Chip tone="danger">{r.blocked_objectives} blocked</Chip>}
                    {r.waiting_on_you === 0 && r.blocked_objectives === 0 && <span className="text-dt-muted text-xs">—</span>}
                  </td>
                  <td className="py-2.5 text-right text-dt-body">{r.done_today > 0 ? r.done_today : <span className="text-dt-muted text-xs">0</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </PanelCard>
    <TeamMissionPanel />
    </div>
  );
}
