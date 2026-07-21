// ============================================================
// Commercial Continuity — pure presentation/format helpers.
// Deliberately dependency-free (no supabase, no DOM) so the calc logic is
// unit-testable in isolation and reusable anywhere. Re-exported by continuityApi.
// ============================================================

export type ContinuityMotion =
  | 'renew' | 'extend' | 'early_renew' | 'reorder' | 'replenish' | 'replace'
  | 'upgrade' | 'downgrade' | 'expand' | 'contract' | 'consolidate' | 'split'
  | 'renegotiate' | 'pause' | 'terminate' | 'allow_expiry' | 'switch_supplier';

const MOTION_LABELS: Record<ContinuityMotion, string> = {
  renew: 'Renew', extend: 'Extend', early_renew: 'Early renew', reorder: 'Reorder',
  replenish: 'Replenish', replace: 'Replace', upgrade: 'Upgrade', downgrade: 'Downgrade',
  expand: 'Expand', contract: 'Contract', consolidate: 'Consolidate', split: 'Split',
  renegotiate: 'Renegotiate', pause: 'Pause', terminate: 'Terminate',
  allow_expiry: 'Allow expiry', switch_supplier: 'Switch supplier',
};

export function motionLabel(m: ContinuityMotion | string): string {
  return MOTION_LABELS[m as ContinuityMotion] ?? m;
}

/**
 * Whole days until a YYYY-MM-DD date (null-safe). Negative = overdue, 0 = today.
 * Both endpoints are anchored to UTC calendar midnight, so the difference is an
 * exact multiple of a day — immune to daylight-saving skew (a naive local-time
 * millisecond diff is off by one across a DST boundary).
 */
export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}
