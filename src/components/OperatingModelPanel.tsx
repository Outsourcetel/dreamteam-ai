import React, { useEffect, useState } from 'react';
import type { DigitalEmployee } from '../lib/digitalEmployeesApi';
import { getOperatingModel, type OperatingModel } from '../lib/missionApi';
import { Banner, Chip, PanelCard, type Tone } from '../design/primitives';

// "How I operate" — the composed operating-model read (audit gap #1): the
// employee's job as one legible page. No new state anywhere; this renders
// get_de_operating_model(), the same truth the mission compiler reads.

const KIND_META: Record<string, { label: string; tone: Tone }> = {
  schedule: { label: 'on a schedule', tone: 'info' },
  date_horizon: { label: 'watching dates', tone: 'accent' },
  state_condition: { label: 'watching state', tone: 'accent' },
  metric_threshold: { label: 'watching metrics', tone: 'accent' },
  // Deliberately outside the 5-min scheduler: the live inbox poller handles
  // these continuously (the engine's `kind <> 'inbox'` skip is intentional
  // dedup, not a dead path — operating-model audit defect resolved as
  // by-design, now labeled honestly).
  inbox: { label: 'live inbox — always listening', tone: 'ok' },
};

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;

export default function OperatingModelPanel({ de }: { de: DigitalEmployee }) {
  const [model, setModel] = useState<OperatingModel | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const name = de.persona_name ?? de.name;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getOperatingModel(de.id)
      .then(r => { if (!cancelled) { setNotReady(r.notReady); setModel(r.model); } })
      .catch(e => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [de.id]);

  if (loading) return <p className="text-sm text-dt-muted py-8 text-center">Reading {name}'s operating model…</p>;
  if (notReady) return <Banner tone="warn">The operating-model read isn't applied yet (migration 248 pending).</Banner>;
  if (error) return <Banner tone="danger">{error}</Banner>;
  if (!model) return <Banner tone="warn">Could not load the operating model.</Banner>;

  const active = model.work_sources.filter(w => w.active);
  const inactive = model.work_sources.filter(w => !w.active);

  return (
    <div className="space-y-5">
      <PanelCard title="Where my work comes from"
        badge={<Chip tone={active.length > 0 ? 'ok' : 'neutral'}>{active.length} active source{active.length === 1 ? '' : 's'}</Chip>}>
        {model.work_sources.length === 0 ? (
          <p className="text-sm text-dt-muted">
            No standing work sources yet — {name} only works when spoken to (chat, missions, or manual playbook runs).
            Install a role kit or add watchers to give it a standing beat.
          </p>
        ) : (
          <div className="divide-y divide-dt-border">
            {[...active, ...inactive].map((w, i) => {
              const k = KIND_META[w.kind] ?? { label: w.kind, tone: 'neutral' as Tone };
              return (
                <div key={i} className="py-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Chip tone={w.active ? k.tone : 'neutral'}>{k.label}</Chip>
                    <span className={`text-sm ${w.active ? 'text-dt-body' : 'text-dt-muted line-through'}`}>{w.label}</span>
                  </div>
                  {w.description && <p className="text-xs text-dt-support mt-1">{w.description}</p>}
                  <p className="text-xs text-dt-muted mt-0.5">
                    {w.kind === 'inbox'
                      ? 'continuous — handled by the live inbox poller in real time, not the 5-minute scheduler'
                      : `${fmt(w.next_fire_at) ? `next check ${fmt(w.next_fire_at)}` : 'no next check scheduled'}${fmt(w.last_run_at) ? ` · last ran ${fmt(w.last_run_at)}` : ' · has not run yet'}${typeof w.last_match_count === 'number' ? ` · found ${w.last_match_count} last time` : ''}`}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </PanelCard>

      <PanelCard title="How I do the work" badge={<Chip tone="info">{model.playbooks.length} published SOP/playbook{model.playbooks.length === 1 ? '' : 's'}</Chip>}>
        {model.playbooks.length === 0 ? (
          <p className="text-sm text-dt-muted">No published playbook is bound to {name} yet — its answers rely on knowledge and judgment alone.</p>
        ) : (
          <div className="divide-y divide-dt-border">
            {model.playbooks.map(p => (
              <div key={p.key} className="flex items-center gap-3 py-2">
                <span className="text-sm text-dt-body flex-1">{p.name}</span>
                <span className="text-xs text-dt-muted">v{p.version} · {p.steps} steps</span>
                <Chip tone="ok">published</Chip>
              </div>
            ))}
          </div>
        )}
      </PanelCard>

      <div className="grid md:grid-cols-2 gap-3">
        <PanelCard title="On my plate">
          <p className="text-2xl font-semibold text-dt-title">{model.open_objectives}</p>
          <p className="text-xs text-dt-support mt-1">open objective{model.open_objectives === 1 ? '' : 's'} in the work queue right now.</p>
        </PanelCard>
        <PanelCard title="Waiting on you">
          <p className="text-2xl font-semibold text-dt-title">{model.waiting_on_human}</p>
          <p className="text-xs text-dt-support mt-1">item{model.waiting_on_human === 1 ? '' : 's'} at your approval desk from this employee.</p>
        </PanelCard>
      </div>
    </div>
  );
}
