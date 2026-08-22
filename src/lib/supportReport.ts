// ── Support History report (handoff 06 §D) — the PURE half ────────────────
// Everything here is React-free and Supabase-free so vitest can pin it
// (tests/support-report.test.ts). The component in
// src/pages/tenant/support/SupportHistoryReport.tsx is layout only.
//
// ⚠ The close time is last_message_at, NOT created_at, and NOT a resolved_at
// column — de_conversations has none (verified against the live schema,
// 2026-08-10). The spec chose last_message_at deliberately: a reopened
// conversation counts where it actually closed.
import { csvRow } from './csv';
import type { SupportConversation } from './supportInboxApi';

export type DatePresetKey = 'today' | '7d' | '30d' | '90d' | 'year' | 'custom';
export const DATE_PRESETS: Array<{ key: DatePresetKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'year', label: 'This year' },
];

export interface ReportFilters {
  preset: DatePresetKey;
  /** custom range, YYYY-MM-DD, both ends inclusive */
  from?: string;
  to?: string;
  topic?: string;
  teamId?: string;
  /** The HUMAN manager (de_assignments relation='manager') of the DE that
   *  handled it — the docs/29 reporting line, NOT is_supervisor, which marks
   *  a DE as the tenant's question-router and has zero rows besides. The
   *  handoff's SRC note pointed at the wrong source; the mock's "Manager:
   *  Priya Sharma" is a person, and this is where people manage DEs. */
  managerId?: string;
  /** 'de:<id>' | 'user:<id>' */
  handledBy?: string;
  channel?: string;
  rated?: 'rated' | 'unrated';
  search?: string;
}

export function closeTimeOf(c: SupportConversation): string {
  return c.last_message_at ?? c.created_at;
}

const DAY = 86_400_000;

export function inDateRange(
  c: SupportConversation,
  f: Pick<ReportFilters, 'preset' | 'from' | 'to'>,
  now: Date,
): boolean {
  const t = new Date(closeTimeOf(c)).getTime();
  if (f.preset === 'custom') {
    if (f.from && t < new Date(`${f.from}T00:00:00Z`).getTime()) return false;
    if (f.to && t > new Date(`${f.to}T23:59:59.999Z`).getTime()) return false;
    return true;
  }
  const n = now.getTime();
  switch (f.preset) {
    case 'today': {
      const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
      return t >= start.getTime();
    }
    case '7d': return t >= n - 7 * DAY;
    case '30d': return t >= n - 30 * DAY;
    case '90d': return t >= n - 90 * DAY;
    case 'year': return new Date(t).getUTCFullYear() === now.getUTCFullYear();
  }
}

export interface ReportMaps {
  /** de_id → team_id, from workforce_team_members */
  deTeams: Map<string, string>;
  /** de_id → manager user_ids, from de_assignments relation='manager' */
  deManagers?: Map<string, string[]>;
}

export function applyReportFilters(
  rows: SupportConversation[],
  f: ReportFilters,
  maps: ReportMaps,
  now: Date,
): SupportConversation[] {
  const q = (f.search ?? '').trim().toLowerCase();
  return rows.filter(c => {
    if (!inDateRange(c, f, now)) return false;
    if (f.topic && c.category !== f.topic) return false;
    if (f.teamId && (!c.de_id || maps.deTeams.get(c.de_id) !== f.teamId)) return false;
    if (f.managerId && (!c.de_id || !(maps.deManagers?.get(c.de_id) ?? []).includes(f.managerId))) return false;
    if (f.handledBy) {
      const [kind, id] = f.handledBy.split(':');
      if (kind === 'de' && c.de_id !== id) return false;
      if (kind === 'user' && c.owner_user_id !== id) return false;
    }
    if (f.channel && c.channel !== f.channel) return false;
    if (f.rated === 'rated' && c.csat_score == null) return false;
    if (f.rated === 'unrated' && c.csat_score != null) return false;
    if (q && !`${c.subject ?? ''} ${c.handoff_summary ?? ''} ${c.end_user_name ?? ''} ${c.account_external_ref ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export interface ReportSummary {
  closed: number;
  /** % closed with no human owner ever attached — null when closed = 0. */
  deAlonePct: number | null;
  avgRating: number | null;
  ratedCount: number;
  avgCloseMs: number | null;
}

// ⚠ NULL, NEVER NaN. This renders on day one over FOUR resolved
// conversations, zero of them rated (measured 2026-08-10). An empty set must
// read "no data yet", not "NaN% · NaN ★".
export function summariseReport(rows: SupportConversation[]): ReportSummary {
  if (rows.length === 0) return { closed: 0, deAlonePct: null, avgRating: null, ratedCount: 0, avgCloseMs: null };
  const rated = rows.filter(r => r.csat_score != null);
  const durations = rows
    .map(r => new Date(closeTimeOf(r)).getTime() - new Date(r.created_at).getTime())
    .filter(ms => Number.isFinite(ms) && ms >= 0);
  return {
    closed: rows.length,
    deAlonePct: Math.round((rows.filter(r => r.owner_user_id == null).length / rows.length) * 100),
    avgRating: rated.length ? Math.round((rated.reduce((s, r) => s + (r.csat_score as number), 0) / rated.length) * 10) / 10 : null,
    ratedCount: rated.length,
    avgCloseMs: durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : null,
  };
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ⚠ WAS a local `csvCell` that quoted correctly (RFC 4180) and did NOTHING
// about formula injection — and `end_user_name` and `subject` are text the end
// user typed. It now shares src/lib/csv.ts with the audit-trail export, so
// there is one answer to "is our CSV safe to open" instead of two.

/** The table, as a file. Columns mirror the on-screen table exactly —
 *  a CSV that disagrees with the screen it came from is a support ticket. */
export function reportToCsv(
  rows: SupportConversation[],
  names: { deName: (id: string | null) => string; userName: (id: string | null) => string },
): string {
  const header = 'Customer,What it was about,Handled by,Topic,Closed,Rating';
  const lines = rows.map(c => {
    const de = names.deName(c.de_id);
    const user = names.userName(c.owner_user_id);
    const handled = de && user ? `${de} → ${user}` : de || user || '—';
    return csvRow([
      c.end_user_name ?? c.account_external_ref ?? '—',
      c.subject ?? c.handoff_summary ?? '—',
      handled,
      c.category ?? '—',
      new Date(closeTimeOf(c)).toISOString(),
      c.csat_score != null ? `${c.csat_score} ★` : 'not rated',
    ]);
  });
  return [header, ...lines].join('\r\n');
}

export interface SavedReportView { name: string; filters: ReportFilters }
const VIEWS_V = 1;

/** ⚠ Saved on THIS DEVICE. The spec's per-user table is flagged "new data
 *  required" and the migration surface belongs to another active session
 *  today — localStorage is the honest interim, and the UI says so. Same
 *  guards as the hire wizard's SavedHire: versioned, corrupt-safe. */
export function readSavedViews(storeKey: string): SavedReportView[] {
  try {
    const raw = localStorage.getItem(storeKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { v: number; views: SavedReportView[] };
    if (parsed?.v !== VIEWS_V || !Array.isArray(parsed.views)) return [];
    return parsed.views;
  } catch { return []; }
}

export function writeSavedViews(storeKey: string, views: SavedReportView[]): void {
  try { localStorage.setItem(storeKey, JSON.stringify({ v: VIEWS_V, views })); }
  catch { /* quota/private browsing — the report works without saved views */ }
}
