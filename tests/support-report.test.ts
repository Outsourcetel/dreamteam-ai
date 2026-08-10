// ============================================================
// Support History report (handoff 06 §D) — the pure logic, pinned.
//
// WHY: this report renders on day one over FOUR resolved conversations,
// zero rated (measured 2026-08-10), and must be equally correct at 10,000.
// Every filter, stat and CSV rule is asserted here BEFORE the UI exists,
// because a report that quietly miscounts closed work is worse than no
// report — it becomes the number the founder repeats.
//
// ⚠ `import type` ONLY from supportInboxApi: a value import would drag the
// supabase client (and its env requirements) into node and kill the suite.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  DATE_PRESETS, inDateRange, applyReportFilters, closeTimeOf,
  summariseReport, formatDuration,
  reportToCsv, readSavedViews, writeSavedViews,
} from '../src/lib/supportReport';
import type { SupportConversation } from '../src/lib/supportInboxApi';

// Minimal honest row builder — only the fields the report reads.
function conv(over: Partial<SupportConversation>): SupportConversation {
  return {
    id: over.id ?? 'c1', channel: 'widget', status: 'resolved', priority: 'normal',
    category: null, subject: null, detected_language: null, handoff_summary: null,
    end_user_name: null, account_external_ref: null, owner_user_id: null,
    csat_score: null, de_id: null, last_message_at: '2026-08-05T10:00:00Z',
    created_at: '2026-08-05T08:00:00Z', identity_verified: null,
    last_message: undefined,
    ...over,
  } as SupportConversation;
}

const NOW = new Date('2026-08-10T12:00:00Z');

describe('date presets (close time = last_message_at, per the spec)', () => {
  it('exposes exactly today/7d/30d/90d/year — custom is not a chip', () => {
    expect(DATE_PRESETS.map(p => p.key)).toEqual(['today', '7d', '30d', '90d', 'year']);
  });
  it('7d includes a conversation closed 5 days ago and excludes 9 days ago', () => {
    const five = conv({ last_message_at: '2026-08-05T10:00:00Z' });
    const nine = conv({ last_message_at: '2026-08-01T10:00:00Z' });
    expect(inDateRange(five, { preset: '7d' }, NOW)).toBe(true);
    expect(inDateRange(nine, { preset: '7d' }, NOW)).toBe(false);
  });
  it('falls back to created_at when last_message_at is null', () => {
    const c = conv({ last_message_at: null, created_at: '2026-08-09T10:00:00Z' });
    expect(closeTimeOf(c)).toBe('2026-08-09T10:00:00Z');
    expect(inDateRange(c, { preset: '7d' }, NOW)).toBe(true);
  });
  it('custom range is inclusive of both ends', () => {
    const c = conv({ last_message_at: '2026-08-05T10:00:00Z' });
    expect(inDateRange(c, { preset: 'custom', from: '2026-08-05', to: '2026-08-05' }, NOW)).toBe(true);
    expect(inDateRange(c, { preset: 'custom', from: '2026-08-06', to: '2026-08-07' }, NOW)).toBe(false);
  });
});

describe('applyReportFilters', () => {
  const rows = [
    conv({ id: 'a', category: 'billing', de_id: 'de1', owner_user_id: null, channel: 'email', csat_score: 5 }),
    conv({ id: 'b', category: 'how_to', de_id: 'de2', owner_user_id: 'u1', channel: 'widget' }),
    conv({ id: 'c', category: 'billing', de_id: 'de2', owner_user_id: null, channel: 'widget', subject: 'VAT receipt for June' }),
  ];
  const teams = new Map([['de1', 'team-billing'], ['de2', 'team-general']]);

  it('topic narrows to matching category', () => {
    expect(applyReportFilters(rows, { preset: '30d', topic: 'billing' }, teams, NOW).map(r => r.id)).toEqual(['a', 'c']);
  });
  it('team follows the de → team map', () => {
    expect(applyReportFilters(rows, { preset: '30d', teamId: 'team-general' }, teams, NOW).map(r => r.id)).toEqual(['b', 'c']);
  });
  it('handledBy de:<id> matches the employee, user:<id> the human owner', () => {
    expect(applyReportFilters(rows, { preset: '30d', handledBy: 'de:de2' }, teams, NOW).map(r => r.id)).toEqual(['b', 'c']);
    expect(applyReportFilters(rows, { preset: '30d', handledBy: 'user:u1' }, teams, NOW).map(r => r.id)).toEqual(['b']);
  });
  it('rated/unrated buckets split on csat presence', () => {
    expect(applyReportFilters(rows, { preset: '30d', rated: 'rated' }, teams, NOW).map(r => r.id)).toEqual(['a']);
    expect(applyReportFilters(rows, { preset: '30d', rated: 'unrated' }, teams, NOW).map(r => r.id)).toEqual(['b', 'c']);
  });
  it('search hits subject text', () => {
    expect(applyReportFilters(rows, { preset: '30d', search: 'vat' }, teams, NOW).map(r => r.id)).toEqual(['c']);
  });
});

describe('summariseReport — honest at N=0 and N=4', () => {
  it('returns nulls, never NaN, on an empty set', () => {
    const s = summariseReport([]);
    expect(s.closed).toBe(0);
    expect(s.deAlonePct).toBeNull();
    expect(s.avgRating).toBeNull();
    expect(s.avgCloseMs).toBeNull();
  });
  it('deAlonePct counts owner_user_id null as the employee closing alone', () => {
    const s = summariseReport([
      conv({ owner_user_id: null }), conv({ owner_user_id: null }),
      conv({ owner_user_id: 'u1' }), conv({ owner_user_id: 'u2' }),
    ]);
    expect(s.deAlonePct).toBe(50);
  });
  it('avgRating averages only the rated, and reports how many that was', () => {
    const s = summariseReport([conv({ csat_score: 5 }), conv({ csat_score: 4 }), conv({})]);
    expect(s.avgRating).toBe(4.5);
    expect(s.ratedCount).toBe(2);
  });
  it('avgCloseMs is last_message_at − created_at', () => {
    const s = summariseReport([conv({ created_at: '2026-08-05T08:00:00Z', last_message_at: '2026-08-05T10:10:00Z' })]);
    expect(s.avgCloseMs).toBe(2 * 3_600_000 + 10 * 60_000);
  });
});

describe('formatDuration', () => {
  it('renders hours+minutes, bare minutes, days+hours, and — for null', () => {
    expect(formatDuration(2 * 3_600_000 + 10 * 60_000)).toBe('2h 10m');
    expect(formatDuration(18 * 60_000)).toBe('18m');
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('reportToCsv', () => {
  const names = { deName: (id: string | null) => (id === 'de1' ? 'Sophie' : ''), userName: (id: string | null) => (id === 'u1' ? 'Bilal' : '') };
  it('escapes quotes, commas and newlines; handoff renders as "Sophie → Bilal"', () => {
    const csv = reportToCsv([
      conv({ end_user_name: 'Dana "D" W', subject: 'a,b\nc', de_id: 'de1', owner_user_id: 'u1', csat_score: 5 }),
    ], names);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Customer,What it was about,Handled by,Topic,Closed,Rating');
    expect(lines[1]).toContain('"Dana ""D"" W"');
    expect(lines[1]).toContain('"a,b\nc"');
    expect(lines[1]).toContain('Sophie → Bilal');
  });
  it('unrated renders as "not rated", never an empty cell', () => {
    expect(reportToCsv([conv({})], names)).toContain('not rated');
  });
});

describe('saved views (localStorage)', () => {
  // node has no localStorage; a 10-line in-memory stand-in keeps this file env-free
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage ??= {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  it('round-trips, and reads [] on corrupt json rather than throwing', () => {
    const KEY = 'dt.test.reportviews';
    writeSavedViews(KEY, [{ name: 'Billing, 30 days', filters: { preset: '30d', topic: 'billing' } }]);
    expect(readSavedViews(KEY)[0].name).toBe('Billing, 30 days');
    localStorage.setItem(KEY, '{not json');
    expect(readSavedViews(KEY)).toEqual([]);
  });
});

// ── Park & snooze (mig 669) — read-time semantics, no sweep to rot ──────────
import { isParked, parkedLabel, parkPresets } from '../src/lib/supportPark';

describe('isParked — the mig-669 view-state', () => {
  const base = { snoozed_at: '2026-08-10T08:00:00Z', last_message_at: '2026-08-10T07:00:00Z' };
  it('timed park holds until the clock passes, then returns BY ITSELF', () => {
    const c = conv({ ...base, snoozed_until: '2026-08-12T09:00:00Z' });
    expect(isParked(c, new Date('2026-08-11T00:00:00Z'))).toBe(true);
    expect(isParked(c, new Date('2026-08-12T09:00:01Z'))).toBe(false);
  });
  it('"until they reply" (null until) stays parked on the clock alone', () => {
    const c = conv({ ...base, snoozed_until: null });
    expect(isParked(c, new Date('2026-09-01T00:00:00Z'))).toBe(true);
  });
  it('a NEW inbound message returns it — the park never bumps last_message_at, a reply does', () => {
    const c = conv({ ...base, snoozed_until: null, last_message_at: '2026-08-10T09:00:00Z' });
    expect(isParked(c, new Date('2026-08-10T10:00:00Z'))).toBe(false);
  });
  it('never parked without snoozed_at', () => {
    expect(isParked(conv({ snoozed_at: null, snoozed_until: '2026-09-01T00:00:00Z' }), new Date())).toBe(false);
  });
});

describe('parkedLabel', () => {
  it('says the return time for a timed park and the honest phrase for reply-parks', () => {
    expect(parkedLabel(conv({ snoozed_at: '2026-08-10T08:00:00Z', snoozed_until: null }))).toBe('until they reply');
    expect(parkedLabel(conv({ snoozed_at: '2026-08-10T08:00:00Z', snoozed_until: '2026-08-12T09:00:00Z' })))
      .toMatch(/back /);
  });
});

describe('parkPresets — computed from now, never hardcoded dates', () => {
  it('later-today lands at 17:00 today, tomorrow at 09:00, monday on a Monday 09:00', () => {
    const now = new Date('2026-08-10T10:00:00Z');   // a Monday
    const p = Object.fromEntries(parkPresets(now).map(x => [x.key, x]));
    expect(p.later_today.until?.toISOString()).toBe('2026-08-10T17:00:00.000Z');
    expect(p.tomorrow.until?.toISOString()).toBe('2026-08-11T09:00:00.000Z');
    expect(p.monday.until?.getUTCDay()).toBe(1);
    expect(p.monday.until!.getTime()).toBeGreaterThan(now.getTime());
    expect(p.on_reply.until).toBeNull();
  });
  it('later-today after 17:00 falls forward to tomorrow 09:00 rather than the past', () => {
    const p = Object.fromEntries(parkPresets(new Date('2026-08-10T18:30:00Z')).map(x => [x.key, x]));
    expect(p.later_today.until?.toISOString()).toBe('2026-08-11T09:00:00.000Z');
  });
});
