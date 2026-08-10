// ── Park & snooze (mig 669, handoff 06 §C) — the PURE half ─────────────────
// Parked is a VIEW-STATE, never a status: computed from two columns at read
// time so no background sweep exists to die silently. The inbox re-evaluates
// on its existing 30s tick, which is how a timed park returns by itself.
//
//   parked ⟺ snoozed_at set
//            AND no message newer than the park   (a reply returns it)
//            AND (no until, or until still ahead) (the clock returns it)
//
// ⚠ The runtime invariant this depends on: park_support_conversation NEVER
// touches last_message_at. "Until they reply" works precisely because a park
// never looks like a message.
import type { SupportConversation } from './supportInboxApi';

export function isParked(c: SupportConversation, now: Date): boolean {
  if (!c.snoozed_at) return false;
  if (c.last_message_at && new Date(c.last_message_at).getTime() > new Date(c.snoozed_at).getTime()) return false;
  if (c.snoozed_until && new Date(c.snoozed_until).getTime() <= now.getTime()) return false;
  return true;
}

/** "back Mon, 12 Aug, 09:00" for a timed park; the honest phrase otherwise. */
export function parkedLabel(c: SupportConversation): string {
  if (!c.snoozed_until) return 'until they reply';
  const d = new Date(c.snoozed_until);
  return `back ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export interface ParkPreset { key: 'later_today' | 'tomorrow' | 'monday' | 'on_reply'; label: string; until: Date | null }

/** The spec's menu, computed from `now` so tests can pin it. All UTC-based —
 *  the label a user reads comes from toLocale* on the stored instant, so the
 *  wall-clock they see always matches what will happen. */
export function parkPresets(now: Date): ParkPreset[] {
  const at = (base: Date, addDays: number, hour: number): Date => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + addDays);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  };
  // 17:00 today — unless that is already behind us, in which case the honest
  // nearest thing is tomorrow morning, never a time in the past.
  const laterToday = at(now, 0, 17).getTime() > now.getTime() ? at(now, 0, 17) : at(now, 1, 9);
  // Next Monday 09:00, always strictly ahead (from a Monday, that is +7).
  const daysToMonday = ((8 - now.getUTCDay()) % 7) || 7;
  return [
    { key: 'later_today', label: 'Later today (17:00)', until: laterToday },
    { key: 'tomorrow',    label: 'Tomorrow morning',    until: at(now, 1, 9) },
    { key: 'monday',      label: 'Monday',              until: at(now, daysToMonday, 9) },
    { key: 'on_reply',    label: 'When they reply',     until: null },
  ];
}
