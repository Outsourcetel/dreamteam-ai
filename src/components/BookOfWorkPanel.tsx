// The Book of Work — a DE's self-derived queue (EXEC 0.1).
//
// This is where a non-technical admin tells a Digital Employee HOW to find its
// own work, the way you'd brief a new hire: "watch the renewal dates", "flag
// accounts whose health drops", "review the book every week". Each watcher the
// 5-minute engine matches opens a case the employee then works.
import React, { useCallback, useEffect, useState } from 'react';
import {
  listWatchers, createWatcher, setWatcherActive, deleteWatcher, describeWatcher,
  WATCHER_KIND_META, type WorkWatcher, type WatcherKind,
} from '../lib/bookOfWorkApi';

const CONFIGURABLE: WatcherKind[] = ['date_horizon', 'state_condition', 'metric_threshold', 'schedule'];
const STATE_FIELDS = [
  { key: 'health_score', label: 'health score' },
  { key: 'status', label: 'status' },
  { key: 'arr_cents', label: 'ARR (cents)' },
  { key: 'tier', label: 'tier' },
];
const NUMERIC_OPS = [
  { key: 'lt', label: 'is below' }, { key: 'lte', label: 'is at or below' },
  { key: 'gt', label: 'is above' }, { key: 'gte', label: 'is at or above' },
  { key: 'eq', label: 'equals' }, { key: 'neq', label: 'is not' },
];
const SCHEDULE_INTERVALS = [
  { minutes: 1440, label: 'Every day' }, { minutes: 10080, label: 'Every week' },
  { minutes: 20160, label: 'Every 2 weeks' }, { minutes: 43200, label: 'Every ~month' },
];

export default function BookOfWorkPanel({ deId }: { deId: string }) {
  const [watchers, setWatchers] = useState<WorkWatcher[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  // Draft form state.
  const [kind, setKind] = useState<WatcherKind>('date_horizon');
  const [label, setLabel] = useState('');
  const [horizons, setHorizons] = useState('90, 60, 30');
  const [field, setField] = useState('health_score');
  const [op, setOp] = useState('lt');
  const [value, setValue] = useState('');
  const [metricKey, setMetricKey] = useState('');
  const [metricOp, setMetricOp] = useState<'gt' | 'lt'>('gt');
  const [intervalMin, setIntervalMin] = useState(10080);

  const load = useCallback(async () => {
    setError(null);
    try { setWatchers(await listWatchers(deId)); }
    catch (e) { setError((e as Error).message); }
  }, [deId]);
  useEffect(() => { void load(); }, [load]);

  const resetForm = () => { setLabel(''); setHorizons('90, 60, 30'); setField('health_score'); setOp('lt'); setValue(''); setMetricKey(''); setMetricOp('gt'); setIntervalMin(10080); };

  const submit = async () => {
    if (!label.trim()) return;
    let config: Record<string, unknown> = {};
    if (kind === 'date_horizon') {
      const days = horizons.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
      config = { horizons_days: days.length ? days : [90, 60, 30] };
    } else if (kind === 'state_condition') {
      if (!value.trim()) { setError('Give the value to compare against.'); return; }
      config = { field, op, value: value.trim() };
    } else if (kind === 'metric_threshold') {
      if (!metricKey.trim() || !value.trim()) { setError('Give the KPI key and the value.'); return; }
      config = { metric_key: metricKey.trim(), op: metricOp, value: value.trim() };
    } else if (kind === 'schedule') {
      config = { interval_minutes: intervalMin };
    }
    setBusy(true); setError(null);
    try {
      await createWatcher({ deId, kind, label, config });
      setAdding(false); resetForm(); await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <p className="text-[11px] uppercase tracking-wide text-dt-muted">Book of Work — how it finds its own work</p>
        {!adding && (
          <button onClick={() => { setAdding(true); setError(null); }}
            className="ml-auto text-[11px] text-indigo-400 hover:text-indigo-300">+ Add a way to find work</button>
        )}
      </div>
      <p className="text-[11px] text-dt-faint mb-2">
        Brief this employee the way you'd brief a new hire: what to watch for so it pulls its own work, instead of waiting to be handed a task.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      {adding && (
        <div className="mb-3 rounded-lg border border-dt-border-strong bg-dt-page/70 p-3 space-y-2">
          <select value={kind} onChange={e => setKind(e.target.value as WatcherKind)}
            className="w-full bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
            {CONFIGURABLE.map(k => <option key={k} value={k}>{WATCHER_KIND_META[k].label} — {WATCHER_KIND_META[k].hint}</option>)}
          </select>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Name this (e.g. Upcoming renewals)"
            className="w-full bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />

          {kind === 'date_horizon' && (
            <label className="block text-[11px] text-dt-muted">
              Open a case this many days before each account's renewal date:
              <input value={horizons} onChange={e => setHorizons(e.target.value)} placeholder="90, 60, 30"
                className="mt-1 w-full bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            </label>
          )}
          {kind === 'state_condition' && (
            <div className="flex items-center gap-2 text-xs text-dt-support flex-wrap">
              <span>When an account's</span>
              <select value={field} onChange={e => setField(e.target.value)} className="bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5">
                {STATE_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
              <select value={op} onChange={e => setOp(e.target.value)} className="bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5">
                {NUMERIC_OPS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <input value={value} onChange={e => setValue(e.target.value)} placeholder="60"
                className="w-24 bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5" />
            </div>
          )}
          {kind === 'metric_threshold' && (
            <div className="flex items-center gap-2 text-xs text-dt-support flex-wrap">
              <span>When KPI</span>
              <input value={metricKey} onChange={e => setMetricKey(e.target.value)} placeholder="metric key"
                className="w-32 bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5" />
              <select value={metricOp} onChange={e => setMetricOp(e.target.value as 'gt' | 'lt')} className="bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5">
                <option value="gt">goes above</option><option value="lt">goes below</option>
              </select>
              <input value={value} onChange={e => setValue(e.target.value)} placeholder="value"
                className="w-24 bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5" />
            </div>
          )}
          {kind === 'schedule' && (
            <select value={intervalMin} onChange={e => setIntervalMin(Number(e.target.value))}
              className="w-full bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-2 py-1.5">
              {SCHEDULE_INTERVALS.map(s => <option key={s.minutes} value={s.minutes}>{s.label}</option>)}
            </select>
          )}

          <div className="flex items-center gap-2">
            <button onClick={() => void submit()} disabled={busy || !label.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
              {busy ? 'Saving…' : 'Add'}
            </button>
            <button onClick={() => { setAdding(false); resetForm(); setError(null); }} className="text-xs text-dt-muted hover:text-dt-support">Cancel</button>
          </div>
        </div>
      )}

      {watchers === null ? (
        <p className="text-xs text-dt-muted">Loading…</p>
      ) : watchers.length === 0 && !adding ? (
        <div className="rounded-lg border border-dashed border-dt-border px-4 py-3 text-xs text-dt-muted">
          This employee has no way to find its own work yet — it only acts when handed a task. Add a watcher to make it self-driven.
        </div>
      ) : (
        <div className="space-y-2">
          {(watchers ?? []).map(w => (
            <div key={w.id} className={`bg-dt-inset rounded-lg px-4 py-2.5 ${w.active ? '' : 'opacity-55'}`}>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${w.active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-dt-panel text-dt-support'}`}>
                  {w.active ? 'watching' : 'paused'}
                </span>
                <span className="text-sm text-dt-body">{w.label}</span>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <button onClick={() => void run(() => setWatcherActive(w.id, !w.active))} disabled={busy}
                    className="text-[10px] text-dt-muted hover:text-amber-300">{w.active ? 'pause' : 'resume'}</button>
                  <button onClick={() => void run(() => deleteWatcher(w.id))} disabled={busy}
                    className="text-[10px] text-dt-faint hover:text-rose-300">remove</button>
                </div>
              </div>
              <p className="text-xs text-dt-support mt-1">{describeWatcher(w)}</p>
              {w.last_run_at && (
                <p className="text-[10px] text-dt-faint mt-0.5">
                  Last checked {new Date(w.last_run_at).toLocaleString()}{w.last_match_count > 0 ? ` · opened ${w.last_match_count} case(s)` : ''}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
