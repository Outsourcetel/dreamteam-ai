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
