import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { timeAgo, timeAgoLong, timeAgoCompact, duration, staleness, fmtDateTime, fmtDateTimeYear, fmtDate } from '../src/lib/dateFormat';

// ═══════════════════════════════════════════════════════════════════════════
// EIGHT hand-rolled relative-time helpers existed before this module, and they
// disagreed about the same instant. The cases below are the disagreements,
// kept as tests so the consolidation cannot quietly reintroduce one.
// ═══════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-08-22T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('the elapsed bucket is FLOORED, never rounded', () => {
  // connectorApi.fmtSince used Math.round at every step. At 90 minutes it said
  // "2 hr ago" while the other seven said "1h ago" — the Connected Systems
  // page reported a sync an hour later than it happened.
  it('90 minutes is one hour, not two', () => {
    expect(timeAgo(ago(90 * MIN))).toBe('1h ago');
    expect(timeAgoLong(ago(90 * MIN))).toBe('1 hour ago');
    expect(timeAgoCompact(ago(90 * MIN))).toBe('1h');
  });
  it('59 minutes is still minutes', () => {
    expect(timeAgo(ago(59 * MIN))).toBe('59m ago');
  });
  it('23h59m is still hours', () => {
    expect(timeAgo(ago(24 * HOUR - MIN))).toBe('23h ago');
  });
});

describe('plurals are computed from the number shown', () => {
  // fmtSince printed `${Math.round(hrs / 24)} day${hrs < 48 ? '' : 's'}`, so at
  // 36 hours it rendered "2 day" — the count came from one expression and the
  // plural from another.
  it('36 hours never renders as "2 day"', () => {
    expect(timeAgoLong(ago(36 * HOUR))).toBe('1 day ago');
  });
  it('two days is plural, one day is not', () => {
    expect(timeAgoLong(ago(DAY))).toBe('1 day ago');
    expect(timeAgoLong(ago(2 * DAY))).toBe('2 days ago');
    expect(timeAgoLong(ago(HOUR))).toBe('1 hour ago');
    expect(timeAgoLong(ago(2 * HOUR))).toBe('2 hours ago');
  });
});

describe('the under-a-minute case', () => {
  // EmployeeFilePage.relTime had no "just now" branch, so a ten-second-old
  // event rendered "0m ago".
  it('ten seconds is never "0m ago"', () => {
    expect(timeAgo(ago(10_000))).toBe('just now');
    expect(timeAgoLong(ago(10_000))).toBe('just now');
    expect(timeAgoCompact(ago(10_000))).toBe('now');
  });
});

describe('a future timestamp does not render as negative', () => {
  it('clamps to zero', () => {
    expect(timeAgo(new Date(NOW.getTime() + HOUR).toISOString())).toBe('just now');
  });
});

describe('bad input is a dash, never "Invalid Date" or "NaN"', () => {
  for (const bad of [null, undefined, '', 'not-a-date']) {
    it(`${JSON.stringify(bad)} renders the placeholder`, () => {
      expect(timeAgo(bad)).toBe('—');
      expect(timeAgoLong(bad)).toBe('—');
      expect(timeAgoCompact(bad)).toBe('—');
      expect(staleness(bad)).toBe('—');
      expect(fmtDateTime(bad)).toBe('—');
      expect(fmtDate(bad)).toBe('—');
    });
  }
  it('honours a caller-supplied placeholder', () => {
    expect(timeAgo(null, { empty: 'never' })).toBe('never');
    expect(fmtDateTime(null, { empty: '' })).toBe('');
  });
});

describe('duration — elapsed time with no tense', () => {
  it('reads as a length, not a moment', () => {
    expect(duration(ago(5 * MIN))).toBe('5 minutes');
    expect(duration(ago(HOUR))).toBe('1 hour');
    expect(duration(ago(3 * DAY))).toBe('3 days');
  });
  it('under a minute is never "0 minutes"', () => {
    expect(duration(ago(10_000))).toBe('less than a minute');
  });
  it('floors like every other variant — 90 minutes is one hour', () => {
    expect(duration(ago(90 * MIN))).toBe('1 hour');
  });
  it('bad input is the placeholder', () => {
    expect(duration(null)).toBe('—');
  });
});

describe('staleness buckets (knowledge freshness)', () => {
  it('under a day is "today"', () => expect(staleness(ago(5 * HOUR))).toBe('today'));
  it('days up to a month', () => expect(staleness(ago(12 * DAY))).toBe('12d'));
  it('months up to a year', () => expect(staleness(ago(95 * DAY))).toBe('3mo'));
  it('then years', () => expect(staleness(ago(800 * DAY))).toBe('2y'));
});

describe('the absolute formats are one string, not eight', () => {
  it('fmtDateTime and fmtDate produce a stable, locale-independent shape', () => {
    // Asserted structurally rather than by literal, because the test runner's
    // locale is not the user's. The point of the assertion is that BOTH
    // helpers went through Intl with the same options, not what en-US emits.
    expect(fmtDateTime('2026-03-04T15:30:00Z')).toMatch(/\d/);
    expect(fmtDate('2026-03-04T15:30:00Z')).toMatch(/\d/);
    expect(fmtDateTime('2026-03-04T15:30:00Z')).not.toBe(fmtDate('2026-03-04T15:30:00Z'));
  });
  it('fmtDateTimeYear carries the year and fmtDateTime does not', () => {
    expect(fmtDateTimeYear('2026-03-04T15:30:00Z')).toContain('2026');
    expect(fmtDateTime('2026-03-04T15:30:00Z')).not.toContain('2026');
  });
  it('every absolute format honours the empty placeholder', () => {
    expect(fmtDateTimeYear(null)).toBe('—');
    expect(fmtDateTimeYear('nonsense')).toBe('—');
    expect(fmtDateTimeYear(null, { empty: '' })).toBe('');
  });
});

// ── The guard cannot become a no-op ───────────────────────────────────────
describe('every exported formatter is covered above', () => {
  it('names them, so adding a ninth without a test is visible here', async () => {
    const mod = await import('../src/lib/dateFormat');
    const fns = Object.keys(mod).filter(k => typeof (mod as Record<string, unknown>)[k] === 'function');
    expect(fns.sort()).toEqual(
      ['duration', 'fmtDate', 'fmtDateTime', 'fmtDateTimeYear', 'staleness', 'timeAgo', 'timeAgoCompact', 'timeAgoLong'],
    );
  });
});

describe('absoluteAfterDays — the deliberate fallback to a real date', () => {
  it('is off unless asked for', () => {
    expect(timeAgo(ago(400 * DAY))).toBe('400d ago');
  });
  it('switches to the date once the cutoff is reached', () => {
    const out = timeAgo(ago(9 * DAY), { absoluteAfterDays: 7 });
    expect(out).toBe(fmtDate(ago(9 * DAY)));
    expect(out).not.toMatch(/ago/);
  });
  it('does not switch a moment before the cutoff', () => {
    expect(timeAgo(ago(7 * DAY - MIN), { absoluteAfterDays: 7 })).toBe('6d ago');
  });
  it('applies to every relative variant, so the threshold has one home', () => {
    const iso = ago(30 * DAY), d = fmtDate(iso);
    expect(timeAgo(iso, { absoluteAfterDays: 7 })).toBe(d);
    expect(timeAgoLong(iso, { absoluteAfterDays: 7 })).toBe(d);
    expect(timeAgoCompact(iso, { absoluteAfterDays: 7 })).toBe(d);
  });
});
