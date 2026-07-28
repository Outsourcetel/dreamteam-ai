// ============================================================
// The response window — how fast work a watcher opens has to be
// handled. Pure logic only: no DB, no network, no React, so it
// can be unit-tested the way continuityFormat is.
//
// This is the client-side mirror of the SQL function
// response_window_due_at (migration 518). The two must agree on
// what a declared standard means; the SQL side is authoritative
// for the actual deadline, this side is for entering and reading
// one back.
// ============================================================

/**
 * Either a duration measured from the moment the case opens, or one fixed
 * calendar instant that is the same for every case the watcher opens.
 *
 * The amount and unit are stored exactly as declared — "4 hours" is never
 * normalised to 240 minutes, so it reads back as what was meant.
 */
export type ResponseWindow =
  | { unit: 'minutes' | 'hours' | 'days'; amount: number }
  | { unit: 'date'; at: string };

export type ResponseUnit = 'minutes' | 'hours' | 'days' | 'date';

export const RESPONSE_UNITS = [
  { key: 'minutes' as const, label: 'minutes' },
  { key: 'hours' as const, label: 'hours' },
  { key: 'days' as const, label: 'days' },
];

/**
 * A date watcher's deadline IS the date it counts down to — a renewal, a notice
 * period. A second deadline would compete with it and there is no honest way to
 * say which one is real, so the SQL validator refuses it and so does the form.
 */
export const KIND_TAKES_RESPONSE_WINDOW = (kind: string): boolean =>
  kind === 'state_condition' || kind === 'metric_threshold' || kind === 'schedule';

/** Read a stored window, returning null for absent OR malformed — both mean "no standard". */
export function readResponseWindow(config: Record<string, unknown> | null | undefined): ResponseWindow | null {
  const rw = config?.response_window as Record<string, unknown> | undefined;
  if (!rw || typeof rw !== 'object') return null;
  if (rw.unit === 'date') return typeof rw.at === 'string' && !Number.isNaN(new Date(rw.at).getTime())
    ? { unit: 'date', at: rw.at } : null;
  const n = Number(rw.amount);
  if (!['minutes', 'hours', 'days'].includes(String(rw.unit)) || !Number.isFinite(n) || n < 1) return null;
  return { unit: rw.unit as 'minutes' | 'hours' | 'days', amount: Math.floor(n) };
}

/** One phrase, in the operator's own units. */
export function describeResponseWindow(rw: ResponseWindow | null): string {
  if (!rw) return 'No response time set';
  if (rw.unit === 'date') {
    const d = new Date(rw.at);
    return Number.isNaN(d.getTime()) ? 'By a specific date' : `By ${d.toLocaleString()}`;
  }
  const unit = rw.amount === 1 ? rw.unit.replace(/s$/, '') : rw.unit;
  return `Within ${rw.amount} ${unit}`;
}

/** True when a fixed deadline has already gone by — every new case would open overdue. */
export function responseWindowHasPassed(rw: ResponseWindow | null, now: number = Date.now()): boolean {
  if (!rw || rw.unit !== 'date') return false;
  const d = new Date(rw.at);
  return !Number.isNaN(d.getTime()) && d.getTime() < now;
}

// <input type="datetime-local"> speaks local wall-clock with no zone. The Date
// constructor reads it in the browser's zone, so toISOString() gives the right
// INSTANT — which is what must be stored, because there is no tenant timezone
// anywhere to interpret a bare date against later.
export function localToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isoToLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Turn form state into a window. Three outcomes, and the difference matters:
 *   null      — nothing entered. No standard declared; the goal gets no
 *               deadline, which is honest rather than a guess.
 *   'invalid' — something entered but unusable. Must be reported, never
 *               silently treated as "no standard".
 *   a window  — good.
 */
export function buildWindow(unit: ResponseUnit, amount: string, dateLocal: string): ResponseWindow | null | 'invalid' {
  if (unit === 'date') {
    if (!dateLocal) return null;
    const iso = localToIso(dateLocal);
    return iso ? { unit: 'date', at: iso } : 'invalid';
  }
  if (!amount.trim()) return null;
  const n = Number(amount);
  return Number.isInteger(n) && n > 0 ? { unit, amount: n } : 'invalid';
}
