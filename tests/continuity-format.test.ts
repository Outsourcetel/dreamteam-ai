// ============================================================
// Unit tests for the pure Commercial Continuity format helpers.
// No DB, no network — just the calc logic (motion labels + the
// null-safe day math the Portfolio/Command Center rely on).
// ============================================================
import { describe, it, expect } from 'vitest';
import { motionLabel, daysUntil } from '../src/lib/continuityFormat';
import { daysUntil as daysUntilFromOnboarding } from '../src/lib/onboardingApi';

describe('motionLabel', () => {
  it('maps every motion to a human label', () => {
    expect(motionLabel('renew')).toBe('Renew');
    expect(motionLabel('switch_supplier')).toBe('Switch supplier');
    expect(motionLabel('early_renew')).toBe('Early renew');
    expect(motionLabel('allow_expiry')).toBe('Allow expiry');
  });
  it('falls back to the raw value for an unknown motion', () => {
    expect(motionLabel('something_new')).toBe('something_new');
  });
});

describe('daysUntil', () => {
  // Anchor to the same UTC calendar basis daysUntil uses, so the test is
  // timezone- and DST-independent.
  const shift = (days: number) => {
    const n = new Date();
    const base = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) + days * 86_400_000;
    return new Date(base).toISOString().slice(0, 10);
  };

  it('returns null for null/empty/invalid input', () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil(undefined)).toBeNull();
    expect(daysUntil('')).toBeNull();
    expect(daysUntil('not-a-date')).toBeNull();
  });
  it('is 0 for today', () => {
    expect(daysUntil(shift(0))).toBe(0);
  });
  it('is positive for a future date', () => {
    expect(daysUntil(shift(30))).toBe(30);
  });
  it('is negative (overdue) for a past date', () => {
    expect(daysUntil(shift(-8))).toBe(-8);
  });
});

describe('there is exactly ONE daysUntil', () => {
  // Until 2026-08-22 there were two, and they did not agree. onboardingApi's
  // parsed `s + 'T00:00:00'` in LOCAL time and differenced it against
  // Date.now() — an instant, not a midnight — then ceil'd. continuityFormat's
  // anchors both endpoints to UTC calendar midnight and rounds.
  //
  // They diverge by a whole day whenever the local calendar date differs from
  // the UTC one (any user east of UTC in their morning, west of it in their
  // evening) and across a DST boundary, where a naive millisecond difference is
  // not a whole number of days at all. That flipped the "Go-lives in 14d" tile
  // on CustomerOnboardingLive and the <=60-day notice filter on
  // CommercialContinuityPage — two counts a person acts on.
  //
  // The old tests could not have caught it: they only ever imported one of the
  // two. This asserts REFERENCE IDENTITY, which no reimplementation can satisfy
  // — copying the correct body into onboardingApi would still fail here, and
  // should, because two copies drift.
  it('onboardingApi re-exports it rather than reimplementing it', () => {
    expect(daysUntilFromOnboarding).toBe(daysUntil);
  });

  it('and the surviving one is the UTC-anchored version', () => {
    // A local-time implementation cannot be exactly 0 for "today" at every hour
    // of the day; a UTC-anchored one is, by construction.
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString().slice(0, 10);
    expect(daysUntilFromOnboarding(todayUtc)).toBe(0);
  });
});
