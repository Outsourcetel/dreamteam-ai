import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { PanelCard, Button, Banner, Chip } from '../design/primitives';

// Tune the review-minutes model (mig 691/698): the human-cost line in the
// benchmark report is MODELED — your decided review tasks × these minutes per
// decision type. The platform ships deliberately-LOW defaults (an honest
// floor); this card lets the founder replace any of them with their own
// number. Effective values always come back FROM THE SERVER after a save —
// the card never renders what the browser hoped.

const TYPE_LABELS: Record<string, string> = {
  action_approval: 'Approve an action',
  approval_gate: 'Decide an approval gate',
  escalation: 'Handle an escalation',
  inquiry_review: 'Review an answer draft',
  review_gate: 'Decide a review gate',
  knowledge_revision: 'Review a knowledge change',
  trust_promotion: 'Decide a trust promotion',
  trust_demotion_notice: 'Acknowledge a demotion notice',
  checklist: 'Tick a checklist item',
  override: 'Handle an override',
  training_feedback: 'Give training feedback',
};

interface RowState {
  taskType: string;
  defaultMinutes: number;
  effectiveMinutes: number;
  overridden: boolean;
  draft: string;          // the input's text while editing
  saving: boolean;
}

export default function ReviewMinutesCard() {
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = async () => {
    setProblem(null);
    // RLS returns the platform defaults (tenant_id NULL) plus this
    // workspace's own overrides — nothing else.
    const { data, error } = await supabase
      .from('review_time_standards')
      .select('tenant_id, task_type, minutes')
      .order('task_type');
    if (error) { setProblem(`Could not load the review minutes: ${error.message}`); return; }
    const defaults = new Map<string, number>();
    const overrides = new Map<string, number>();
    for (const r of data ?? []) {
      if (r.tenant_id === null) defaults.set(r.task_type, Number(r.minutes));
      else overrides.set(r.task_type, Number(r.minutes));
    }
    const next: RowState[] = Object.keys(TYPE_LABELS)
      .filter(t => defaults.has(t) || overrides.has(t))
      .map(t => {
        const eff = overrides.get(t) ?? defaults.get(t)!;
        return {
          taskType: t, defaultMinutes: defaults.get(t) ?? eff,
          effectiveMinutes: eff, overridden: overrides.has(t),
          draft: String(eff), saving: false,
        };
      });
    setRows(next);
  };

  useEffect(() => { void load(); }, []);

  const patchRow = (t: string, patch: Partial<RowState>) =>
    setRows(rs => (rs ?? []).map(r => (r.taskType === t ? { ...r, ...patch } : r)));

  /** ⚠ .rpc() RESOLVES on a Postgres error, and these RPCs refuse in their
   *  payload — classify BOTH, never report a refusal as a save. */
  const call = async (fn: 'set_review_minutes' | 'clear_review_minutes', args: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(error.message);
    const r = data as { ok?: boolean; error?: string; detail?: string; effective_minutes?: number } | null;
    if (!r?.ok) {
      throw new Error(r?.error === 'not_permitted'
        ? 'only owners and admins can tune the review minutes'
        : `${r?.error ?? 'unknown refusal'}${r?.detail ? ` — ${r.detail}` : ''}`);
    }
    return Number(r.effective_minutes);
  };

  const save = async (row: RowState) => {
    const n = Number(row.draft);
    if (!Number.isFinite(n) || n <= 0 || n > 60) {
      setProblem('Minutes must be a number greater than 0 and at most 60.'); return;
    }
    patchRow(row.taskType, { saving: true }); setProblem(null);
    try {
      const eff = await call('set_review_minutes', { p_task_type: row.taskType, p_minutes: n });
      patchRow(row.taskType, { effectiveMinutes: eff, draft: String(eff), overridden: true, saving: false });
    } catch (e) {
      patchRow(row.taskType, { saving: false });
      setProblem(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const reset = async (row: RowState) => {
    patchRow(row.taskType, { saving: true }); setProblem(null);
    try {
      const eff = await call('clear_review_minutes', { p_task_type: row.taskType });
      patchRow(row.taskType, { effectiveMinutes: eff, draft: String(eff), overridden: false, saving: false });
    } catch (e) {
      patchRow(row.taskType, { saving: false });
      setProblem(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <PanelCard title="Review minutes" badge={<Chip tone="accent">modeled cost</Chip>}>
      <p className="text-xs text-dt-muted mb-3 max-w-2xl">
        The human-review cost in the benchmark report is <strong>modeled</strong>: your decided review
        tasks × these minutes per decision type. Defaults are deliberately low — an honest floor.
        Replace any of them with how long these decisions really take you.
      </p>

      {problem && <Banner tone="danger" className="mb-3">{problem}</Banner>}

      {rows === null ? (
        <p className="text-xs text-dt-support">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-dt-support">No review-minute standards found — the platform defaults have not been seeded yet.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map(row => {
            const dirty = Number(row.draft) !== row.effectiveMinutes;
            return (
              <div key={row.taskType} className="flex items-center gap-3 rounded-lg border border-dt-border bg-dt-inset px-3 py-1.5">
                <span className="text-xs text-dt-body flex-1">{TYPE_LABELS[row.taskType]}</span>
                {row.overridden
                  ? <Chip tone="info">yours</Chip>
                  : <Chip tone="neutral">default {row.defaultMinutes}</Chip>}
                <input
                  type="number" min={0.5} max={60} step={0.5} value={row.draft}
                  aria-label={`Minutes for: ${TYPE_LABELS[row.taskType]}`}
                  onChange={e => patchRow(row.taskType, { draft: e.target.value })}
                  className="w-20 rounded-lg border border-dt-border-strong bg-dt-surface px-2 py-1 text-xs text-dt-body text-right" />
                <span className="text-[11px] text-dt-muted w-8">min</span>
                <Button kind="primary" size="sm" disabled={row.saving || !dirty} onClick={() => void save(row)}>
                  {row.saving ? 'Saving…' : 'Save'}
                </Button>
                <Button kind="ghost" size="sm" disabled={row.saving || !row.overridden} onClick={() => void reset(row)}>
                  Reset
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </PanelCard>
  );
}
