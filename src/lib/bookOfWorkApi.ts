// The Book of Work — how a Digital Employee derives its own queue (EXEC 0.1).
//
// A human employee doesn't wait to be handed tickets — they look at the systems
// they work in and pull their own work: renewals coming due, accounts whose
// health dipped, a number that crossed a line, the calendar. These watchers are
// exactly that, per DE. The 5-minute engine (migration 213) evaluates them in
// pure SQL and opens a case (an objective the de-work loop then works) for each
// new match — never twice for the same occurrence.
import { supabase } from '../supabase';
import { requireTenantId } from './liveShared';

export type WatcherKind = 'inbox' | 'date_horizon' | 'state_condition' | 'metric_threshold' | 'schedule';

export interface WorkWatcher {
  id: string;
  de_id: string;
  kind: WatcherKind;
  label: string;
  description: string;
  config: Record<string, unknown>;
  active: boolean;
  last_run_at: string | null;
  last_match_count: number;
  next_fire_at: string | null;
  created_at: string;
}

/** Plain-language description of what each kind does, for the picker. */
export const WATCHER_KIND_META: Record<WatcherKind, { label: string; hint: string }> = {
  date_horizon:     { label: 'A date is approaching', hint: 'e.g. a renewal date coming up in 90 / 60 / 30 days' },
  state_condition:  { label: 'A record is in a state', hint: 'e.g. an account whose health score drops below 60' },
  metric_threshold: { label: 'A number crosses a line', hint: "e.g. one of this employee's KPIs goes above/below a value" },
  schedule:         { label: 'On a regular schedule', hint: 'e.g. review the whole book every week' },
  inbox:            { label: 'New item arrives', hint: 'a new ticket/record in a connected system (handled by the live poller)' },
};

export async function listWatchers(deId: string): Promise<WorkWatcher[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.from('work_watchers').select('*')
    .eq('tenant_id', tid).eq('de_id', deId).order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as WorkWatcher[];
}

export async function createWatcher(input: {
  deId: string; kind: WatcherKind; label: string; description?: string; config: Record<string, unknown>;
}): Promise<WorkWatcher> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from('work_watchers').insert({
    tenant_id: tid, de_id: input.deId, kind: input.kind,
    label: input.label.trim(), description: input.description ?? '', config: input.config,
    created_by: user?.id ?? null,
  }).select('*').single();
  if (error) throw new Error(friendly(error.message));
  return data as WorkWatcher;
}

export async function setWatcherActive(id: string, active: boolean): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase.from('work_watchers').update({ active }).eq('id', id).eq('tenant_id', tid);
  if (error) throw new Error(error.message);
}

export async function deleteWatcher(id: string): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase.from('work_watchers').delete().eq('id', id).eq('tenant_id', tid);
  if (error) throw new Error(error.message);
}

/** Turn a saved watcher's config back into one plain-language sentence. */
export function describeWatcher(w: WorkWatcher): string {
  const c = w.config;
  if (w.kind === 'date_horizon') {
    const h = Array.isArray(c.horizons_days) ? (c.horizons_days as number[]).join(' / ') : '90 / 60 / 30';
    return `Opens a case ${h} days before each account's renewal date`;
  }
  if (w.kind === 'state_condition') {
    const op = { lt: 'below', lte: 'at or below', gt: 'above', gte: 'at or above', eq: 'equal to', neq: 'not' }[String(c.op)] ?? String(c.op);
    return `Opens a case when an account's ${c.field} is ${op} ${c.value}`;
  }
  if (w.kind === 'metric_threshold') {
    return `Opens a case when the "${c.metric_key}" KPI goes ${c.op === 'gt' ? 'above' : 'below'} ${c.value}`;
  }
  if (w.kind === 'schedule') {
    const m = Number(c.interval_minutes) || 0;
    const label = m % 10080 === 0 ? `${m / 10080} week(s)` : m % 1440 === 0 ? `${m / 1440} day(s)` : `${Math.round(m / 60)} hour(s)`;
    return `Opens a recurring case every ${label}`;
  }
  return 'New items in a connected system open a case (handled by the live poller)';
}

function friendly(raw: string): string {
  // Surface the SQL validation messages as-is — they're already plain.
  const m = raw.match(/(date_horizon|state_condition|metric_threshold|schedule)[^"]*/);
  return m ? m[0] : raw;
}
