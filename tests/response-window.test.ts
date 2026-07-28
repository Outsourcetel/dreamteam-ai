// ============================================================
// Unit tests for the response window — the service standard an
// operator declares on a watcher ("respond within 4 hours", "by
// 15 August"). No DB, no network: this is the entry/display side
// of the rule whose authoritative half is the SQL function
// response_window_due_at (migration 518).
//
// The distinction these tests exist to protect: NOTHING DECLARED
// and DECLARED BUT UNUSABLE are different answers. Collapsing
// them is how a typo silently becomes "no deadline".
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  readResponseWindow, describeResponseWindow, responseWindowHasPassed,
  localToIso, isoToLocal, buildWindow, KIND_TAKES_RESPONSE_WINDOW,
} from '../src/lib/responseWindow';

describe('readResponseWindow', () => {
  it('reads each duration unit back exactly as declared', () => {
    expect(readResponseWindow({ response_window: { unit: 'minutes', amount: 30 } })).toEqual({ unit: 'minutes', amount: 30 });
    expect(readResponseWindow({ response_window: { unit: 'hours', amount: 4 } })).toEqual({ unit: 'hours', amount: 4 });
    expect(readResponseWindow({ response_window: { unit: 'days', amount: 3 } })).toEqual({ unit: 'days', amount: 3 });
  });

  it('does NOT normalise hours into minutes', () => {
    // 4 hours must never read back as 240 minutes — the operator's own units
    // are what they will look for when checking the standard later.
    const rw = readResponseWindow({ response_window: { unit: 'hours', amount: 4 } });
    expect(rw).toEqual({ unit: 'hours', amount: 4 });
    expect(describeResponseWindow(rw)).toBe('Within 4 hours');
  });

  it('reads a fixed date', () => {
    expect(readResponseWindow({ response_window: { unit: 'date', at: '2026-08-15T17:00:00.000Z' } }))
      .toEqual({ unit: 'date', at: '2026-08-15T17:00:00.000Z' });
  });

  it('returns null for absent, malformed, zero and negative windows', () => {
    expect(readResponseWindow({})).toBeNull();
    expect(readResponseWindow(null)).toBeNull();
    expect(readResponseWindow({ response_window: 'soon' as unknown as Record<string, unknown> })).toBeNull();
    expect(readResponseWindow({ response_window: { unit: 'fortnights', amount: 2 } })).toBeNull();
    expect(readResponseWindow({ response_window: { unit: 'hours', amount: 0 } })).toBeNull();
    expect(readResponseWindow({ response_window: { unit: 'hours', amount: -3 } })).toBeNull();
    expect(readResponseWindow({ response_window: { unit: 'date', at: 'whenever' } })).toBeNull();
  });

  it('ignores the retired response_days shape rather than half-reading it', () => {
    // The SQL helper still honours it for restored-from-old-dump safety, but
    // the client must not pretend a legacy key is a declared window.
    expect(readResponseWindow({ response_days: 5 })).toBeNull();
  });
});

describe('describeResponseWindow', () => {
  it('says plainly when nothing has been declared', () => {
    expect(describeResponseWindow(null)).toBe('No response time set');
  });
  it('singularises a window of one', () => {
    expect(describeResponseWindow({ unit: 'days', amount: 1 })).toBe('Within 1 day');
    expect(describeResponseWindow({ unit: 'hours', amount: 1 })).toBe('Within 1 hour');
    expect(describeResponseWindow({ unit: 'minutes', amount: 2 })).toBe('Within 2 minutes');
  });
});

describe('responseWindowHasPassed', () => {
  const now = Date.parse('2026-07-28T09:00:00.000Z');
  it('flags a fixed date already gone by', () => {
    expect(responseWindowHasPassed({ unit: 'date', at: '2026-07-01T00:00:00.000Z' }, now)).toBe(true);
  });
  it('does not flag a future date', () => {
    expect(responseWindowHasPassed({ unit: 'date', at: '2026-08-15T17:00:00.000Z' }, now)).toBe(false);
  });
  it('never flags a duration — a duration cannot be stale', () => {
    expect(responseWindowHasPassed({ unit: 'hours', amount: 4 }, now)).toBe(false);
    expect(responseWindowHasPassed(null, now)).toBe(false);
  });
});

describe('local <-> ISO round trip', () => {
  it('preserves the instant through a full round trip', () => {
    // datetime-local carries no zone; the pair must agree on the browser's.
    const local = '2026-08-15T17:00';
    const iso = localToIso(local);
    expect(iso).not.toBeNull();
    expect(isoToLocal(iso as string)).toBe(local);
  });
  it('rejects unparseable input instead of inventing an instant', () => {
    expect(localToIso('not a date')).toBeNull();
    expect(localToIso('')).toBeNull();
    expect(isoToLocal('rubbish')).toBe('');
  });
});

describe('buildWindow', () => {
  it('distinguishes "nothing entered" from "entered but unusable"', () => {
    // This is the distinction the whole feature rests on.
    expect(buildWindow('hours', '', '')).toBeNull();       // no standard declared
    expect(buildWindow('hours', 'abc', '')).toBe('invalid'); // must be reported
    expect(buildWindow('date', '', '')).toBeNull();
    expect(buildWindow('date', '', 'not a date')).toBe('invalid');
  });
  it('rejects zero, negative and fractional amounts', () => {
    expect(buildWindow('hours', '0', '')).toBe('invalid');
    expect(buildWindow('hours', '-3', '')).toBe('invalid');
    expect(buildWindow('hours', '1.5', '')).toBe('invalid');
  });
  it('builds each unit', () => {
    expect(buildWindow('minutes', '30', '')).toEqual({ unit: 'minutes', amount: 30 });
    expect(buildWindow('days', '3', '')).toEqual({ unit: 'days', amount: 3 });
    const d = buildWindow('date', '', '2026-08-15T17:00');
    expect(d).toHaveProperty('unit', 'date');
  });
});

describe('KIND_TAKES_RESPONSE_WINDOW', () => {
  it('refuses a date watcher, which already has its deadline', () => {
    expect(KIND_TAKES_RESPONSE_WINDOW('date_horizon')).toBe(false);
  });
  it('allows the kinds whose cases would otherwise have no deadline at all', () => {
    expect(KIND_TAKES_RESPONSE_WINDOW('state_condition')).toBe(true);
    expect(KIND_TAKES_RESPONSE_WINDOW('metric_threshold')).toBe(true);
    expect(KIND_TAKES_RESPONSE_WINDOW('schedule')).toBe(true);
  });
});
