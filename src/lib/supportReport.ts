// ── Support History report (handoff 06 §D) — the PURE half ────────────────
// Everything here is React-free and Supabase-free so vitest can pin it
// (tests/support-report.test.ts). The component in
// src/pages/tenant/support/SupportHistoryReport.tsx is layout only.
//
// ⚠ The close time is last_message_at, NOT created_at, and NOT a resolved_at
// column — de_conversations has none (verified against the live schema,
// 2026-08-10). The spec chose last_message_at deliberately: a reopened
// conversation counts where it actually closed.
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

export function applyReportFilters(
  rows: SupportConversation[],
  f: ReportFilters,
  /** de_id → team_id, from workforce_team_members */
  deTeams: Map<string, string>,
  now: Date,
): SupportConversation[] {
  const q = (f.search ?? '').trim().toLowerCase();
  return rows.filter(c => {
    if (!inDateRange(c, f, now)) return false;
    if (f.topic && c.category !== f.topic) return false;
    if (f.teamId && (!c.de_id || deTeams.get(c.de_id) !== f.teamId)) return false;
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
