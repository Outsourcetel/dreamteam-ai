// ============================================================
// Unit tests for the pure Commercial Continuity format helpers.
// No DB, no network — just the calc logic (motion labels + the
// null-safe day math the Portfolio/Command Center rely on).
// ============================================================
import { describe, it, expect } from 'vitest';
import { motionLabel, daysUntil } from '../src/lib/continuityFormat';

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
