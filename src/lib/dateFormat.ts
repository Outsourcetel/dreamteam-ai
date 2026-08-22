// ═══════════════════════════════════════════════════════════════════════════
// ONE clock for the whole UI.
//
// Eight hand-rolled relative-time helpers existed before this file — `ago`,
// `relativeTime`, `relTime`, `timeAgo`, `fmtAgo`, `fmtRel`, `fmtSince`,
// `formatWhen` — plus eight copies of one absolute format string. They did not
// merely differ in wording, which would have been a style problem. They
// disagreed about the same instant:
//
//   · connectorApi.fmtSince rounded at every step where the other seven
//     floored, so 90 minutes read "2 hr ago" on Connected Systems and "1h ago"
//     everywhere else — a sync reported an hour later than it happened.
//   · the same function printed `${Math.round(hrs/24)} day${hrs < 48 ? '' : 's'}`,
//     taking the number from one expression and the plural from another, so 36
//     hours rendered "2 day".
//   · EmployeeFilePage.relTime had no under-a-minute branch, so a
//     ten-second-old event rendered "0m ago".
//
// The variants below are DELIBERATE — a dense inbox row wants "2h", a phone
// card wants "2 hours ago", a knowledge shelf wants "3mo". What is not
// deliberate is eight answers to "when does an hour become a day", so every
// variant shares `elapsed()` and differs only in wording.
//
// ⚠ Bad input renders `—`, never "Invalid Date" or "NaN ago". Callers that
// want a different placeholder pass one; nobody has to remember a guard.
// ═══════════════════════════════════════════════════════════════════════════

const MIN = 60, HOUR = 3600, DAY = 86400;

export interface FormatOpts {
  /** What to render for null/undefined/unparseable input. Default '—'. */
  empty?: string;
  /** Past this many days, show the DATE instead of a relative count.
   *  Several surfaces did this deliberately — "3 Mar" is more use than
   *  "172d ago" on an ingestion queue or a platform console — and it is an
   *  option rather than a fifth variant so there stays exactly one place that
   *  decides when a day has passed. */
  absoluteAfterDays?: number;
}

/** True when the caller asked for an absolute date and we are past it. */
function pastCutoff(s: number, o: FormatOpts): boolean {
  return o.absoluteAfterDays !== undefined && s >= o.absoluteAfterDays * DAY;
}

/** Seconds since `iso`, floored at zero, or null if it is not a date.
 *  A future timestamp clamps to 0 rather than counting backwards: clock skew
 *  between the browser and the database is normal and "in -3 minutes" is not
 *  a thing to show anyone. */
function elapsed(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 1000);
}

/** The standard relative time: `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function timeAgo(iso: string | null | undefined, o: FormatOpts = {}): string {
  const s = elapsed(iso);
  if (s === null) return o.empty ?? '—';
  if (pastCutoff(s, o)) return fmtDate(iso);
  if (s < MIN) return 'just now';
  if (s < HOUR) return `${Math.floor(s / MIN)}m ago`;
  if (s < DAY) return `${Math.floor(s / HOUR)}h ago`;
  return `${Math.floor(s / DAY)}d ago`;
}

/** Long form, for surfaces with room: `2 hours ago`, `1 day ago`.
 *  The plural is computed from the number actually shown — see the 36-hour
 *  case in the header. */
export function timeAgoLong(iso: string | null | undefined, o: FormatOpts = {}): string {
  const s = elapsed(iso);
  if (s === null) return o.empty ?? '—';
  if (pastCutoff(s, o)) return fmtDate(iso);
  if (s < MIN) return 'just now';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (s < HOUR) return unit(Math.floor(s / MIN), 'minute');
  if (s < DAY) return unit(Math.floor(s / HOUR), 'hour');
  return unit(Math.floor(s / DAY), 'day');
}

/** Compact, for dense rows: `now`, `5m`, `3h`, `2d`. */
export function timeAgoCompact(iso: string | null | undefined, o: FormatOpts = {}): string {
  const s = elapsed(iso);
  if (s === null) return o.empty ?? '—';
  if (pastCutoff(s, o)) return fmtDate(iso);
  if (s < MIN) return 'now';
  if (s < HOUR) return `${Math.floor(s / MIN)}m`;
  if (s < DAY) return `${Math.floor(s / HOUR)}h`;
  return `${Math.floor(s / DAY)}d`;
}

/** How long something has been going on, with no "ago": `5 minutes`,
 *  `2 hours`, `3 days`. For "Waiting 5 minutes" and the like, where the
 *  sentence supplies the tense. Under a minute reads "less than a minute"
 *  rather than "0 minutes". */
export function duration(iso: string | null | undefined, o: FormatOpts = {}): string {
  const s = elapsed(iso);
  if (s === null) return o.empty ?? '—';
  if (s < MIN) return 'less than a minute';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (s < HOUR) return unit(Math.floor(s / MIN), 'minute');
  if (s < DAY) return unit(Math.floor(s / HOUR), 'hour');
  return unit(Math.floor(s / DAY), 'day');
}

/** Freshness buckets, for "how old is this knowledge": `today`, `12d`, `3mo`,
 *  `2y`. Months are 30 days and years 365 — this is a shelf label, not an
 *  accounting period, and anyone who needs the real date has fmtDate. */
export function staleness(iso: string | null | undefined, o: FormatOpts = {}): string {
  const s = elapsed(iso);
  if (s === null) return o.empty ?? '—';
  const days = Math.floor(s / DAY);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** The absolute timestamp this app uses everywhere: `Mar 4, 3:30 PM`.
 *  Eight files each wrote this exact option bag by hand. */
export function fmtDateTime(iso: string | null | undefined, o: FormatOpts = {}): string {
  if (!iso) return o.empty ?? '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return o.empty ?? '—';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The same timestamp WITH the year: `Mar 4, 2026, 3:30 PM`. Two surfaces
 *  need it — a proving-ground run and the platform demand log — because both
 *  show records old enough that "Mar 4" is ambiguous. */
export function fmtDateTimeYear(iso: string | null | undefined, o: FormatOpts = {}): string {
  if (!iso) return o.empty ?? '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return o.empty ?? '—';
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Date only: `Mar 4, 2026`. */
export function fmtDate(iso: string | null | undefined, o: FormatOpts = {}): string {
  if (!iso) return o.empty ?? '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return o.empty ?? '—';
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
