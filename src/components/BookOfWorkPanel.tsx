// The Book of Work — a DE's self-derived queue (EXEC 0.1).
//
// This is where a non-technical admin tells a Digital Employee HOW to find its
// own work, the way you'd brief a new hire: "watch the renewal dates", "flag
// accounts whose health drops", "review the book every week". Each watcher the
// 5-minute engine matches opens a case the employee then works.
import { useIsTenantAdmin } from '../lib/useRoleGate';
import { useCallback, useEffect, useState } from 'react';
import {
  listWatchers, createWatcher, updateWatcher, setWatcherActive, deleteWatcher, describeWatcher,
  WATCHER_KIND_META, type WorkWatcher, type WatcherKind,
} from '../lib/bookOfWorkApi';
import {
  RESPONSE_UNITS, KIND_TAKES_RESPONSE_WINDOW, readResponseWindow, responseWindowHasPassed,
  isoToLocal, buildWindow, type ResponseUnit as RwUnit,
} from '../lib/responseWindow';

const CONFIGURABLE: WatcherKind[] = ['date_horizon', 'state_condition', 'metric_threshold', 'schedule'];

// Ledger-1 (docs/16): the ENGINE has been source-generalized since migs
// 220/226 — this form just never exposed it, silently defaulting every
// watcher to customer_accounts.renewal_date. The registry mirrors the live
// validate_work_watcher whitelist exactly.
const DATE_SOURCES: { key: string; label: string; fields: { key: string; label: string }[] }[] = [
  { key: 'customer_accounts', label: 'accounts', fields: [{ key: 'renewal_date', label: 'renewal date' }] },
  { key: 'opportunities', label: 'pipeline opportunities', fields: [{ key: 'close_date', label: 'close date' }] },
  {
    key: 'commercial_agreements', label: 'agreements', fields: [
      { key: 'renewal_date', label: 'renewal date' }, { key: 'notice_deadline', label: 'notice deadline' },
      { key: 'warranty_expiry', label: 'warranty expiry' }, { key: 'next_reorder_date', label: 'next reorder date' },
      { key: 'cancellation_deadline', label: 'cancellation deadline' },
      { key: 'pricing_notice_deadline', label: 'pricing notice deadline' }, { key: 'replacement_date', label: 'replacement date' },
    ],
  },
];
const STATE_SOURCES: { key: string; label: string; fields: { key: string; label: string }[] }[] = [
  {
    key: 'customer_accounts', label: 'account', fields: [
      { key: 'health_score', label: 'health score' }, { key: 'status', label: 'status' },
      { key: 'arr_cents', label: 'ARR (cents)' }, { key: 'tier', label: 'tier' },
    ],
  },
  {
    key: 'opportunities', label: 'opportunity', fields: [
      { key: 'stage', label: 'stage' }, { key: 'amount_cents', label: 'amount (cents)' },
    ],
  },
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

/**
 * The service standard, in whichever unit the operator actually thinks in.
 * Minutes and hours matter as much as days: a support-shaped condition is
 * answered in minutes, and a recurring sweep in hours — a whole-day granularity
 * cannot express either.
 */
function ResponseWindowFields({
  unit, amount, date, onUnit, onAmount, onDate,
}: {
  unit: RwUnit; amount: string; date: string;
  onUnit: (u: RwUnit) => void; onAmount: (v: string) => void; onDate: (v: string) => void;
}) {
  const stale = unit === 'date' && !!date && new Date(date).getTime() < Date.now();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-dt-support flex-wrap">
        <span>Handle it</span>
        {unit === 'date' ? (
          <>
            <span>by</span>
            <input type="datetime-local" value={date} onChange={e => onDate(e.target.value)}
              className="bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5" />
          </>
        ) : (
          <>
            <span>within</span>
            <input type="number" min={1} value={amount} onChange={e => onAmount(e.target.value)} placeholder="4"
              className="w-20 bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5" />
          </>
        )}
        <select value={unit} onChange={e => onUnit(e.target.value as RwUnit)}
          className="bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5">
          {RESPONSE_UNITS.map(u => <option key={u.key} value={u.key}>{u.label}</option>)}
          <option value="date">— by a specific date</option>
        </select>
      </div>
      {stale ? (
        <p className="text-[11px] text-dt-warn">
          That date has already passed — every new case would open overdue.
        </p>
      ) : (
        <p className="text-[11px] text-dt-faint">
          Leave blank if no one has set a standard yet. Cases then carry no deadline, rather than an invented one.
        </p>
      )}
    </div>
  );
}

export default function BookOfWorkPanel({ deId }: { deId: string }) {
  // work_watchers is owner/admin in RLS — and RLS is where this one lives,
  // because these are direct table writes with no function in front of
  // them. Two of the three (toggle, delete) do not read the result back,
  // so a refusal would have arrived as a successful-looking no-op.
  const canEditWatchers = useIsTenantAdmin();
  const [watchers, setWatchers] = useState<WorkWatcher[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  // Draft form state.
  const [kind, setKind] = useState<WatcherKind>('date_horizon');
  const [label, setLabel] = useState('');
  const [horizons, setHorizons] = useState('90, 60, 30');
  const [dateSource, setDateSource] = useState('customer_accounts');
  const [dateField, setDateField] = useState('renewal_date');
  const [stateSource, setStateSource] = useState('customer_accounts');
  const [field, setField] = useState('health_score');
  const [op, setOp] = useState('lt');
  const [value, setValue] = useState('');
  const [metricKey, setMetricKey] = useState('');
  const [metricOp, setMetricOp] = useState<'gt' | 'lt'>('gt');
  const [intervalMin, setIntervalMin] = useState(10080);
  const [rwUnit, setRwUnit] = useState<RwUnit>('days');
  const [rwAmount, setRwAmount] = useState('');
  const [rwDate, setRwDate] = useState('');

  // Inline edit of a saved watcher's response time. Everything else about a
  // watcher is still create-and-delete; this is the one field the founder asked
  // to be able to change, and deleting a watcher to change it would throw away
  // its match history and re-open every case it had already seen.
  const [editing, setEditing] = useState<string | null>(null);
  const [edUnit, setEdUnit] = useState<RwUnit>('days');
  const [edAmount, setEdAmount] = useState('');
  const [edDate, setEdDate] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try { setWatchers(await listWatchers(deId)); }
    catch (e) { setError((e as Error).message); }
  }, [deId]);
  useEffect(() => { void load(); }, [load]);

  const resetForm = () => { setLabel(''); setHorizons('90, 60, 30'); setField('health_score'); setOp('lt'); setValue(''); setMetricKey(''); setMetricOp('gt'); setIntervalMin(10080); setRwUnit('days'); setRwAmount(''); setRwDate(''); };

  const submit = async () => {
    if (!label.trim()) return;
    let config: Record<string, unknown> = {};
    if (kind === 'date_horizon') {
      const days = horizons.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
      config = { source: dateSource, date_field: dateField, horizons_days: days.length ? days : [90, 60, 30] };
    } else if (kind === 'state_condition') {
      if (!value.trim()) { setError('Give the value to compare against.'); return; }
      config = { source: stateSource, field, op, value: value.trim() };
    } else if (kind === 'metric_threshold') {
      if (!metricKey.trim() || !value.trim()) { setError('Give the KPI key and the value.'); return; }
      config = { metric_key: metricKey.trim(), op: metricOp, value: value.trim() };
    } else if (kind === 'schedule') {
      config = { interval_minutes: intervalMin };
    }
    if (KIND_TAKES_RESPONSE_WINDOW(kind)) {
      const rw = buildWindow(rwUnit, rwAmount, rwDate);
      if (rw === 'invalid') {
        setError(rwUnit === 'date' ? 'That deadline is not a real date.' : 'Give a whole number above zero for the response time.');
        return;
      }
      // Left off on purpose = no standard declared. The goal then carries no
      // deadline, which is honest — rather than a made-up one.
      if (rw) config.response_window = rw;
    }
    setBusy(true); setError(null);
    try {
      await createWatcher({ deId, kind, label, config });
      setAdding(false); resetForm(); await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const beginEdit = (w: WorkWatcher) => {
    const rw = readResponseWindow(w.config);
    setEditing(w.id); setError(null);
    if (rw?.unit === 'date') { setEdUnit('date'); setEdDate(isoToLocal(rw.at)); setEdAmount(''); }
    else if (rw) { setEdUnit(rw.unit); setEdAmount(String(rw.amount)); setEdDate(''); }
    else { setEdUnit('days'); setEdAmount(''); setEdDate(''); }
  };

  const saveWindow = async (w: WorkWatcher) => {
    const rw = buildWindow(edUnit, edAmount, edDate);
    if (rw === 'invalid') {
      setError(edUnit === 'date' ? 'That deadline is not a real date.' : 'Give a whole number above zero for the response time.');
      return;
    }
    // Clearing it removes the key rather than storing a zero — "no standard
    // declared" has to stay distinguishable from "declared as nothing".
    const next = { ...w.config };
    if (rw) next.response_window = rw; else delete next.response_window;
    setBusy(true); setError(null);
    try { await updateWatcher(w.id, { config: next }); setEditing(null); await load(); }
    catch (e) { setError((e as Error).message); }
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
          <button disabled={!canEditWatchers} onClick={() => { setAdding(true); setError(null); }}
            className="ml-auto text-[11px] text-dt-accent-text hover:underline">+ Add a way to find work</button>
        )}
      </div>
      <p className="text-[11px] text-dt-faint mb-2">
        Brief this employee the way you'd brief a new hire: what to watch for so it pulls its own work, instead of waiting to be handed a task.
      </p>
      {error && <p className="text-xs text-dt-danger mb-2">{error}</p>}

      {adding && (
        <div className="mb-3 rounded-lg border border-dt-border-strong bg-dt-inset p-3 space-y-2">
          <select value={kind} onChange={e => setKind(e.target.value as WatcherKind)}
            className="w-full bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-dt-accent">
            {CONFIGURABLE.map(k => <option key={k} value={k}>{WATCHER_KIND_META[k].label} — {WATCHER_KIND_META[k].hint}</option>)}
          </select>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Name this (e.g. Upcoming renewals)"
            className="w-full bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-dt-accent" />

          {kind === 'date_horizon' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-dt-support flex-wrap">
                <span>Watch</span>
                <select value={dateSource} onChange={e => {
                  const src = e.target.value; setDateSource(src);
                  setDateField(DATE_SOURCES.find(s => s.key === src)?.fields[0].key ?? 'renewal_date');
                }} className="bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5">
                  {DATE_SOURCES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <span>by their</span>
                <select value={dateField} onChange={e => setDateField(e.target.value)} className="bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5">
                  {(DATE_SOURCES.find(s => s.key === dateSource)?.fields ?? []).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </div>
              <label className="block text-[11px] text-dt-muted">
                Open a case this many days before that date:
                <input value={horizons} onChange={e => setHorizons(e.target.value)} placeholder="90, 60, 30"
                  className="mt-1 w-full bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-dt-accent" />
              </label>
            </div>
          )}
          {kind === 'state_condition' && (
            <div className="flex items-center gap-2 text-xs text-dt-support flex-wrap">
              <span>When an</span>
              <select value={stateSource} onChange={e => {
                const src = e.target.value; setStateSource(src);
                setField(STATE_SOURCES.find(s => s.key === src)?.fields[0].key ?? 'health_score');
              }} className="bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5">
                {STATE_SOURCES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <span>has</span>
              <select value={field} onChange={e => setField(e.target.value)} className="bg-dt-card border border-dt-border-strong text-dt-body rounded-lg px-2 py-1.5">
                {(STATE_SOURCES.find(s => s.key === stateSource)?.fields ?? []).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
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

          {KIND_TAKES_RESPONSE_WINDOW(kind) && (
            <div className="pt-1 border-t border-dt-border">
              <ResponseWindowFields
                unit={rwUnit} amount={rwAmount} date={rwDate}
                onUnit={setRwUnit} onAmount={setRwAmount} onDate={setRwDate} />
            </div>
          )}
          {kind === 'date_horizon' && (
            <p className="text-[11px] text-dt-faint pt-1 border-t border-dt-border">
              This kind already has its deadline — the date it counts down to.
            </p>
          )}

          <div className="flex items-center gap-2">
            <button onClick={() => void submit()} disabled={busy || !canEditWatchers || !label.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-dt-accent-strong hover:bg-dt-accent-hover text-white disabled:opacity-40">
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
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${w.active ? 'bg-dt-ok-soft text-dt-ok' : 'bg-dt-panel text-dt-support'}`}>
                  {w.active ? 'watching' : 'paused'}
                </span>
                <span className="text-sm text-dt-body">{w.label}</span>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  {KIND_TAKES_RESPONSE_WINDOW(w.kind) && editing !== w.id && (
                    <button onClick={() => beginEdit(w)} disabled={busy || !canEditWatchers}
                      className="text-[10px] text-dt-muted hover:text-dt-accent-text">response time</button>
                  )}
                  <button onClick={() => void run(() => setWatcherActive(w.id, !w.active))} disabled={busy || !canEditWatchers}
                    className="text-[10px] text-dt-muted hover:text-dt-warn">{w.active ? 'pause' : 'resume'}</button>
                  <button onClick={() => void run(() => deleteWatcher(w.id))} disabled={busy || !canEditWatchers}
                    className="text-[10px] text-dt-faint hover:text-dt-danger">remove</button>
                </div>
              </div>
              <p className="text-xs text-dt-support mt-1">{describeWatcher(w)}</p>
              {responseWindowHasPassed(readResponseWindow(w.config)) && editing !== w.id && (
                <p className="text-[11px] text-dt-warn mt-0.5">
                  Its deadline has passed — every new case opens overdue until this is changed.
                </p>
              )}
              {editing === w.id && (
                <div className="mt-2 rounded-lg border border-dt-border-strong bg-dt-inset p-2.5 space-y-2">
                  <ResponseWindowFields
                    unit={edUnit} amount={edAmount} date={edDate}
                    onUnit={setEdUnit} onAmount={setEdAmount} onDate={setEdDate} />
                  <div className="flex items-center gap-2">
                    <button onClick={() => void saveWindow(w)} disabled={busy || !canEditWatchers}
                      className="text-xs px-3 py-1 rounded-lg bg-dt-accent-strong hover:bg-dt-accent-hover text-white disabled:opacity-40">
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={() => { setEditing(null); setError(null); }}
                      className="text-xs text-dt-muted hover:text-dt-support">Cancel</button>
                  </div>
                </div>
              )}
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
