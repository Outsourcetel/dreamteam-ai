# Support History Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build handoff 06 §D — the closed-work report view (date presets, honest facets, summary stats, the report table, pagination, CSV export, saved views) — so the History tab stops being a bare list and "my work / closed work / escalated work" each have a clear view.

**Architecture:** All filter/summary/CSV logic lives in a new pure module `src/lib/supportReport.ts`, unit-tested in vitest with no React or Supabase imports (same pattern as `role-cannot.test.ts`). A new `SupportHistoryReport.tsx` component renders it, swapped in full-width when the History tab is active. Zero API changes: every needed column is already in `CONV_COLS`; names resolve page-side from `listDigitalEmployees()` plus a tolerant `profiles` read with a fallback. Saved views are localStorage (versioned, tenant+user-scoped, same guards as the hire wizard's `SavedHire`) because the spec flags a per-user table as *new data required* and the parallel session owns the migration surface right now.

**Tech Stack:** React 18 + TS, Tailwind `dt-*` tokens, existing primitives (`FilterBar`, `SELECT_CLS`, `INPUT_CLS`, `StatTile`, `TableScroll`, `TH`, `TD`, `Chip`, `Button`), vitest.

## Global Constraints

- Design system is LAW: compose from `src/design/primitives.tsx`; no raw `slate-*`/hex/inline styles in new code; 12px type floor; `node scripts/design-drift.mjs` counts must not go up.
- **Facet options come from values PRESENT in the data, never from a configured list** (decided 2026-08-09, `project_support_topic_axis`): the Rating facet renders only when ≥1 conversation is rated (currently 0) — a component conditional (`anyRated`), self-enabling when the first csat lands. The spec's **Manager facet is out of scope** (see the final section): zero supervisors are set, so it could never render, and building an invisible control is unverifiable.
- **A filter must never be able to say "all clear"** — every filtered empty state names the filter.
- The "Product" axis is **Topic** (`category`) — decided, do not re-introduce a product column.
- Time-to-close = `last_message_at − created_at`; the close date is `last_message_at`. There is **no `resolved_at` column** (verified 2026-08-10); the spec itself says filter on `last_message_at`.
- Frontend-only: no migrations, no edge functions, nothing deployed server-side (parallel session owns that surface).
- Verified data shape (2026-08-10): 455 `de_conversations`, 4 resolved, 0 rated, 2 teams / 2 memberships (`workforce_teams` + `workforce_team_members.de_id`), 0 supervisors. The report must look correct at N=4 and at N=10,000.

---

### Task 1: Pure report logic — date presets + facet filtering

**Files:**
- Create: `src/lib/supportReport.ts`
- Test: `tests/support-report.test.ts`

**Interfaces:**
- Consumes: `SupportConversation` type from `src/lib/supportInboxApi.ts` (fields used: `id, status, channel, category, subject, handoff_summary, end_user_name, account_external_ref, de_id, owner_user_id, csat_score, created_at, last_message_at`).
- Produces (later tasks rely on these exact names):
  - `type DatePresetKey = 'today' | '7d' | '30d' | '90d' | 'year' | 'custom'`
  - `const DATE_PRESETS: Array<{ key: DatePresetKey; label: string }>` (custom excluded from the array — it appears when the range inputs are used)
  - `interface ReportFilters { preset: DatePresetKey; from?: string; to?: string; topic?: string; teamId?: string; handledBy?: string; channel?: string; rated?: 'rated' | 'unrated'; search?: string }`
  - `function closeTimeOf(c: SupportConversation): string` (last_message_at ?? created_at)
  - `function inDateRange(c, filters, now: Date): boolean`
  - `function applyReportFilters(rows: SupportConversation[], f: ReportFilters, deTeams: Map<string, string>, now: Date): SupportConversation[]` — `deTeams` maps `de_id → team_id`; `handledBy` values are `de:<id>` or `user:<id>`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/support-report.test.ts
import { describe, it, expect } from 'vitest';
import {
  DATE_PRESETS, inDateRange, applyReportFilters, closeTimeOf,
} from '../src/lib/supportReport';
import type { SupportConversation } from '../src/lib/supportInboxApi';

// Minimal honest row builder — only the fields the report reads.
export function conv(over: Partial<SupportConversation>): SupportConversation {
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/support-report.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/supportReport'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/supportReport.ts
// ── Support History report (handoff 06 §D) — the PURE half ────────────────
// Everything here is React-free and Supabase-free so vitest can pin it.
// ⚠ The close time is last_message_at, NOT created_at, and NOT a resolved_at
// column — de_conversations has none (verified 2026-08-10). The spec chose
// last_message_at deliberately: a reopened conversation counts where it
// actually closed.
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

export function inDateRange(c: SupportConversation, f: Pick<ReportFilters, 'preset' | 'from' | 'to'>, now: Date): boolean {
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
  rows: SupportConversation[], f: ReportFilters,
  deTeams: Map<string, string>, now: Date,
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/support-report.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/lib/supportReport.ts tests/support-report.test.ts
git commit -m "feat(support): report filters — date presets and facets, pure and pinned"
```

---

### Task 2: Summary stats + duration formatting

**Files:**
- Modify: `src/lib/supportReport.ts` (append)
- Test: `tests/support-report.test.ts` (append)

**Interfaces:**
- Produces:
  - `interface ReportSummary { closed: number; deAlonePct: number | null; avgRating: number | null; ratedCount: number; avgCloseMs: number | null }`
  - `function summariseReport(rows: SupportConversation[]): ReportSummary`
  - `function formatDuration(ms: number | null): string` — `2h 10m` / `18m` / `3d 4h` / `'—'` for null

- [ ] **Step 1: Write the failing tests (append to the same file)**

```ts
import { summariseReport, formatDuration } from '../src/lib/supportReport';

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
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/support-report.test.ts`
Expected: FAIL — `summariseReport is not a function` (existing tests still pass)

- [ ] **Step 3: Implement (append to supportReport.ts)**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/support-report.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/lib/supportReport.ts tests/support-report.test.ts
git commit -m "feat(support): report summary stats — null-honest at N=0"
```

---

### Task 3: CSV export + saved views (localStorage)

**Files:**
- Modify: `src/lib/supportReport.ts` (append)
- Test: `tests/support-report.test.ts` (append)

**Interfaces:**
- Produces:
  - `function reportToCsv(rows: SupportConversation[], names: { deName: (id: string | null) => string; userName: (id: string | null) => string }): string`
  - `interface SavedReportView { name: string; filters: ReportFilters }`
  - `function readSavedViews(storeKey: string): SavedReportView[]`
  - `function writeSavedViews(storeKey: string, views: SavedReportView[]): void`
- Consumes: `closeTimeOf`, `ReportFilters` from Task 1.

- [ ] **Step 1: Write the failing tests (append)**

```ts
import { reportToCsv, readSavedViews, writeSavedViews } from '../src/lib/supportReport';

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
  it('round-trips, and reads [] on corrupt json rather than throwing', () => {
    const KEY = 'dt.test.reportviews';
    writeSavedViews(KEY, [{ name: 'Billing, 30 days', filters: { preset: '30d', topic: 'billing' } }]);
    expect(readSavedViews(KEY)[0].name).toBe('Billing, 30 days');
    localStorage.setItem(KEY, '{not json');
    expect(readSavedViews(KEY)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/support-report.test.ts`
Expected: FAIL — `reportToCsv is not a function`. If `localStorage` is undefined in the vitest node environment, add to the saved-views describe block: `// @vitest-environment jsdom` at the top of the file is NOT wanted (the rest is pure node) — instead stub it in the describe:
```ts
// node has no localStorage; a 10-line in-memory stand-in keeps this file env-free
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
```

- [ ] **Step 3: Implement (append to supportReport.ts)**

```ts
const csvCell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

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
    return [
      csvCell(c.end_user_name ?? c.account_external_ref ?? '—'),
      csvCell(c.subject ?? c.handoff_summary ?? '—'),
      csvCell(handled),
      csvCell(c.category ?? '—'),
      csvCell(new Date(closeTimeOf(c)).toISOString()),
      c.csat_score != null ? `${c.csat_score} ★` : 'not rated',
    ].join(',');
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/support-report.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/lib/supportReport.ts tests/support-report.test.ts
git commit -m "feat(support): report CSV + device-local saved views"
```

---

### Task 4: The report component

**Files:**
- Create: `src/pages/tenant/support/SupportHistoryReport.tsx`

**Interfaces:**
- Consumes: everything Tasks 1–3 produced, plus primitives `FilterBar, SELECT_CLS, INPUT_CLS, Chip, Button, StatTile, TableScroll, TH, TD` and `TOPIC_LABEL` — imported from `./supportTopics`, a new module Task 5 creates by MOVING the const out of SupportInboxPage.tsx (one definition, two consumers; importing from the page itself would be a cycle).
- Produces: `default function SupportHistoryReport(props: { rows: SupportConversation[]; deNames: Map<string, string>; userNames: Map<string, string>; teams: Array<{ id: string; name: string }>; deTeams: Map<string, string>; storeKey: string })`

- [ ] **Step 1: Write the component**

```tsx
// src/pages/tenant/support/SupportHistoryReport.tsx
// ── History as a REPORT (handoff 06 §D), not a bare list ──────────────────
// Closed conversations never appear in a working view; this is where they
// answer questions: what closed, who closed it, how fast, how well rated.
// All logic is in src/lib/supportReport.ts (pure, vitest-pinned) — this file
// is layout only.
import { useMemo, useState } from 'react';
import {
  FilterBar, SELECT_CLS, INPUT_CLS, Chip, Button, StatTile, TableScroll, TH, TD,
} from '../../../design/primitives';
import type { SupportConversation } from '../../../lib/supportInboxApi';
import {
  DATE_PRESETS, applyReportFilters, summariseReport, formatDuration,
  reportToCsv, readSavedViews, writeSavedViews, closeTimeOf,
} from '../../../lib/supportReport';
import type { ReportFilters, SavedReportView } from '../../../lib/supportReport';
import { TOPIC_LABEL } from './supportTopics';

const PAGE_SIZE = 25;

export default function SupportHistoryReport({ rows, deNames, userNames, teams, deTeams, storeKey }: {
  rows: SupportConversation[];
  deNames: Map<string, string>;
  userNames: Map<string, string>;
  teams: Array<{ id: string; name: string }>;
  deTeams: Map<string, string>;
  storeKey: string;
}) {
  const [filters, setFilters] = useState<ReportFilters>({ preset: '30d' });
  const [page, setPage] = useState(0);
  const [views, setViews] = useState<SavedReportView[]>(() => readSavedViews(storeKey));
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState('');

  const set = (patch: Partial<ReportFilters>) => { setPage(0); setFilters(f => ({ ...f, ...patch })); };

  // Facet options from values PRESENT — a facet offering nine options that
  // always return nothing is the FilterBar lesson all over again.
  const topics = useMemo(() => Array.from(new Set(rows.map(r => r.category).filter((c): c is string => !!c))).sort(), [rows]);
  const channels = useMemo(() => Array.from(new Set(rows.map(r => r.channel))).sort(), [rows]);
  const handlers = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    for (const id of new Set(rows.map(r => r.de_id).filter((x): x is string => !!x)))
      out.push({ value: `de:${id}`, label: deNames.get(id) ?? 'An employee' });
    for (const id of new Set(rows.map(r => r.owner_user_id).filter((x): x is string => !!x)))
      out.push({ value: `user:${id}`, label: userNames.get(id) ?? 'A teammate' });
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [rows, deNames, userNames]);
  const anyRated = useMemo(() => rows.some(r => r.csat_score != null), [rows]);
  const teamsPresent = useMemo(() => teams.filter(t => rows.some(r => r.de_id && deTeams.get(r.de_id) === t.id)), [teams, rows, deTeams]);

  const filtered = useMemo(() => applyReportFilters(rows, filters, deTeams, new Date()), [rows, filters, deTeams]);
  const summary = useMemo(() => summariseReport(filtered), [filtered]);
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const filtersActive = !!(filters.topic || filters.teamId || filters.handledBy || filters.channel || filters.rated || filters.search?.trim() || filters.preset === 'custom');

  const exportCsv = () => {
    const csv = reportToCsv(filtered, {
      deName: id => (id && deNames.get(id)) || '',
      userName: id => (id && userNames.get(id)) || '',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `support-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const saveView = () => {
    const name = viewName.trim();
    if (!name) return;
    const next = [...views.filter(v => v.name !== name), { name, filters }];
    setViews(next); writeSavedViews(storeKey, next); setNaming(false); setViewName('');
  };

  return (
    <div className="flex-1 min-w-0 space-y-4 overflow-y-auto pb-6">
      {/* Saved views — device-local; the label says so, honestly. */}
      <div className="flex items-center gap-2 flex-wrap">
        {views.map(v => (
          <button key={v.name} onClick={() => { setPage(0); setFilters(v.filters); }}
            className="text-xs px-2.5 py-1 rounded-full border border-dt-border bg-dt-card text-dt-support hover:border-dt-border-strong">
            {v.name}
          </button>
        ))}
        {views.length > 0 && (
          <button onClick={() => { setViews([]); writeSavedViews(storeKey, []); }}
            className="text-xs text-dt-faint hover:text-dt-support" title="Removes the saved shortcuts, not any conversations.">
            clear saved
          </button>
        )}
        {naming ? (
          <span className="flex items-center gap-1.5">
            <input value={viewName} onChange={e => setViewName(e.target.value)} placeholder="Name this view"
              aria-label="Name this view" className={`${INPUT_CLS} !w-44 !py-1 text-xs`} autoFocus
              onKeyDown={e => { if (e.key === 'Enter') saveView(); if (e.key === 'Escape') setNaming(false); }} />
            <Button size="sm" onClick={saveView}>Save</Button>
          </span>
        ) : (
          <Button kind="ghost" size="sm" onClick={() => setNaming(true)}
            title="Saved on this device — shortcuts to a set of filters, not shared with the team yet.">
            + Save this view
          </Button>
        )}
      </div>

      <FilterBar
        presets={<>
          {DATE_PRESETS.map(p => (
            <Chip key={p.key} tone={filters.preset === p.key ? 'accent' : 'neutral'}>
              <button onClick={() => set({ preset: p.key, from: undefined, to: undefined })}>{p.label}</button>
            </Chip>
          ))}
          <input type="date" value={filters.from ?? ''} aria-label="Closed from"
            onChange={e => set({ preset: 'custom', from: e.target.value || undefined })} className={`${SELECT_CLS} !py-1.5 text-xs`} />
          <span className="text-dt-faint text-xs">→</span>
          <input type="date" value={filters.to ?? ''} aria-label="Closed up to"
            onChange={e => set({ preset: 'custom', to: e.target.value || undefined })} className={`${SELECT_CLS} !py-1.5 text-xs`} />
        </>}
        facets={<>
          {topics.length > 0 && (
            <select value={filters.topic ?? ''} aria-label="Filter by topic" className={SELECT_CLS}
              onChange={e => set({ topic: e.target.value || undefined })}>
              <option value="">Any topic</option>
              {topics.map(t => <option key={t} value={t}>{TOPIC_LABEL[t] ?? t.replace(/_/g, ' ')}</option>)}
            </select>
          )}
          {teamsPresent.length > 0 && (
            <select value={filters.teamId ?? ''} aria-label="Filter by team" className={SELECT_CLS}
              onChange={e => set({ teamId: e.target.value || undefined })}>
              <option value="">Any team</option>
              {teamsPresent.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          {handlers.length > 0 && (
            <select value={filters.handledBy ?? ''} aria-label="Filter by who handled it" className={SELECT_CLS}
              onChange={e => set({ handledBy: e.target.value || undefined })}>
              <option value="">Handled by anyone</option>
              {handlers.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
            </select>
          )}
          {channels.length > 1 && (
            <select value={filters.channel ?? ''} aria-label="Filter by channel" className={SELECT_CLS}
              onChange={e => set({ channel: e.target.value || undefined })}>
              <option value="">Any channel</option>
              {channels.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {/* Rating facet appears only once anything IS rated (0 today) —
              it self-enables when the first csat lands. */}
          {anyRated && (
            <select value={filters.rated ?? ''} aria-label="Filter by rating" className={SELECT_CLS}
              onChange={e => set({ rated: (e.target.value || undefined) as ReportFilters['rated'] })}>
              <option value="">Rated or not</option>
              <option value="rated">Rated</option>
              <option value="unrated">Not rated</option>
            </select>
          )}
        </>}
        search={
          <input value={filters.search ?? ''} aria-label="Search closed conversations"
            onChange={e => set({ search: e.target.value })}
            placeholder="Find a customer, or a word in the subject…" className={INPUT_CLS} />
        }
        views={<>
          {filtersActive && <Button kind="ghost" size="sm" onClick={() => setFilters({ preset: '30d' })}>Clear all</Button>}
          <Button size="sm" onClick={exportCsv} disabled={filtered.length === 0}>Export CSV</Button>
        </>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="closed" value={String(summary.closed)} />
        <StatTile label="closed without a person" value={summary.deAlonePct != null ? `${summary.deAlonePct}%` : '—'} />
        <StatTile label={summary.ratedCount > 0 ? `average rating (${summary.ratedCount} rated)` : 'average rating'}
          value={summary.avgRating != null ? `${summary.avgRating} ★` : 'none rated yet'} />
        <StatTile label="average time to close" value={formatDuration(summary.avgCloseMs)} />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-dt-muted p-6 text-center">
          {filtersActive
            ? 'Nothing closed matches that filter. Clear it to see the rest.'
            : 'Nothing has been closed in this period yet.'}
        </p>
      ) : (
        <TableScroll>
          <table className="w-full">
            <thead><tr className="border-b border-dt-border">
              <th className={TH}>Customer</th><th className={TH}>What it was about</th>
              <th className={TH}>Handled by</th><th className={TH}>Topic</th>
              <th className={TH}>Closed</th><th className={TH}>Rating</th>
            </tr></thead>
            <tbody className="divide-y divide-dt-border">
              {pageRows.map(c => {
                const de = c.de_id ? deNames.get(c.de_id) : undefined;
                const user = c.owner_user_id ? (userNames.get(c.owner_user_id) ?? 'a teammate') : undefined;
                return (
                  <tr key={c.id}>
                    <td className={TD}>{c.end_user_name ?? c.account_external_ref ?? '—'}</td>
                    <td className={`${TD} max-w-[28rem]`}><span className="line-clamp-1">{c.subject ?? c.handoff_summary ?? '—'}</span></td>
                    <td className={TD}>{de && user ? <>{de} <span className="text-dt-faint">→</span> {user}</> : de ?? user ?? '—'}</td>
                    <td className={TD}>{c.category ? (TOPIC_LABEL[c.category] ?? c.category.replace(/_/g, ' ')) : '—'}</td>
                    <td className={`${TD} whitespace-nowrap`}>{new Date(closeTimeOf(c)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</td>
                    <td className={`${TD} whitespace-nowrap`}>{c.csat_score != null ? `${c.csat_score} ★` : <span className="text-dt-faint">not rated</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}

      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-dt-muted">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <span className="flex gap-2">
            <Button size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button>
            <Button size="sm" disabled={(page + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(p => p + 1)}>Next</Button>
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL only on the missing `./supportTopics` import (created in Task 5). If other errors appear, fix them now.

- [ ] **Step 3: Commit (with Task 5's first step, which unblocks the import)** — hold the commit until Task 5 Step 2.

---

### Task 5: Wire-in — TOPIC_LABEL extraction, name maps, full-width swap

**Files:**
- Create: `src/pages/tenant/support/supportTopics.ts`
- Modify: `src/pages/tenant/support/SupportInboxPage.tsx`

**Interfaces:**
- Produces: `export const TOPIC_LABEL: Record<string, string>` in `supportTopics.ts` (moved verbatim from SupportInboxPage.tsx, which now imports it — one definition, two consumers).
- Consumes: `SupportHistoryReport` (Task 4), `listDigitalEmployees` from `src/lib/digitalEmployeesApi`, `useAuth` (already imported in the page).

- [ ] **Step 1: Extract TOPIC_LABEL**

Create `src/pages/tenant/support/supportTopics.ts` containing the existing `TOPIC_LABEL` const (cut from SupportInboxPage.tsx, comment included); update SupportInboxPage.tsx to `import { TOPIC_LABEL } from './supportTopics';`.

- [ ] **Step 2: Typecheck + commit Tasks 4+5-so-far**

Run: `npx tsc --noEmit` — Expected: PASS.
```bash
git add src/pages/tenant/support/SupportHistoryReport.tsx src/pages/tenant/support/supportTopics.ts src/pages/tenant/support/SupportInboxPage.tsx
git commit -m "feat(support): the History report component (handoff 06 §D)"
```

- [ ] **Step 3: Load the name maps and teams in SupportInboxPage**

In `SupportInboxPage.tsx`, alongside existing state:

```tsx
const [deNames, setDeNames] = useState<Map<string, string>>(new Map());
const [userNames, setUserNames] = useState<Map<string, string>>(new Map());
const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
const [deTeams, setDeTeams] = useState<Map<string, string>>(new Map());
```

One effect, fired only when the History tab first opens (`tab === 'resolved'`), so the three extra reads cost nothing on the working tabs:

```tsx
// Names for "Handled by" and the report table. Employees come from the same
// roster call the workforce pages use. Human names come from a direct
// profiles read that a tenant_user may not be allowed (RLS) — that failure
// is EXPECTED and non-fatal: the report renders "a teammate" instead of a
// name rather than erroring or, worse, hiding the row.
useEffect(() => {
  if (tab !== 'resolved' || deNames.size > 0) return;
  void (async () => {
    try {
      const des = await listDigitalEmployees(true);
      setDeNames(new Map(des.map(d => [d.id, d.persona_name || d.name])));
    } catch { /* roster read failed — ids render as 'An employee' */ }
    try {
      const { data } = await supabase.from('workforce_teams').select('id, name');
      setTeams((data ?? []) as Array<{ id: string; name: string }>);
      const { data: members } = await supabase.from('workforce_team_members').select('team_id, de_id');
      setDeTeams(new Map(((members ?? []) as Array<{ team_id: string; de_id: string }>).map(m => [m.de_id, m.team_id])));
    } catch { /* teams facet simply does not appear */ }
    try {
      const { data } = await supabase.from('profiles').select('user_id, full_name');
      setUserNames(new Map(((data ?? []) as Array<{ user_id: string; full_name: string | null }>).map(p => [p.user_id, p.full_name ?? ''])));
    } catch { /* names fall back to 'a teammate' */ }
  })();
}, [tab, deNames.size]);
```

(Imports to add: `listDigitalEmployees` from `'../../../lib/digitalEmployeesApi'`; `supabase` from `'../../../supabase'`; `SupportHistoryReport` from `'./SupportHistoryReport'`; `useAuth` is already there — reuse `authedUser` for the store key.)

- [ ] **Step 4: Swap the History tab to the report, full width**

The current layout renders the split view (list + thread) for every tab. Change the body so `tab === 'resolved'` renders the report instead — the tab strip stays, the split view goes:

```tsx
{tab === 'resolved' ? (
  <div className="relative flex-1 overflow-hidden px-6 pb-6">
    <SupportHistoryReport
      rows={convs.filter(c => c.status === 'resolved')}
      deNames={deNames} userNames={userNames} teams={teams} deTeams={deTeams}
      storeKey={`dt.supportviews.${authedUser?.tenantId ?? 'none'}.${authedUser?.id ?? 'anon'}`}
    />
  </div>
) : (
  /* existing split-view div, unchanged */
)}
```

Also move the tab strip OUT of the left column so it stays visible above the report (it currently lives inside the 340px list column): render the `TABS.map(...)` strip in a row above the conditional, delete it from inside the list column, and keep the existing topic/search FilterBar rendering only for the non-resolved tabs (`tab !== 'resolved' &&` around the existing bar — the report has its own richer bar; two stacked filter bars on one tab would be noise).

- [ ] **Step 5: Typecheck + run all support tests**

Run: `npx tsc --noEmit && npx vitest run tests/support-report.test.ts`
Expected: PASS.

- [ ] **Step 6: Full check suite**

Run: `node scripts/design-drift.mjs && node scripts/audit-role-gates.mjs && npm run build`
Expected: drift 0 regressions (the report is all primitives), role-gates 0 ungated, build clean.

- [ ] **Step 7: Commit**

```bash
git add src/pages/tenant/support/
git commit -m "feat(support): History becomes the closed-work report — wired, full width"
```

---

### Task 6: Browser verification + honest close-out

**Files:** none (verification only)

- [ ] **Step 1: Signed-out smoke** — `preview_start`, navigate `/support/inbox`, confirm no console errors on boot (signed-out lands on sign-in; that is expected and says nothing about the report).
- [ ] **Step 2: State plainly in the final report**: the report rendering with real rows, the facet self-enabling, and CSV download are **not verified live** (needs a signed-in session; production has 4 resolved conversations to look at). The pure logic IS verified — every filter, stat, and CSV rule has a pinned test.
- [ ] **Step 3: Fetch origin, confirm no divergence, push only after the founder says so.**

## Explicitly out of scope (spec's own "new data required" flags — each needs a migration, and the migration surface belongs to the parallel session today)

- **The Manager facet** — §D draws it, but zero supervisors are set (`is_supervisor=true` count is 0, measured 2026-08-10), so the facet could never render and its wiring could never be verified. Build it the day a supervisor exists; the `handledBy` filter shape already accommodates it.
- Park/snooze (`snoozed_until` + sweep job + auto-close interval) — §C.
- "What Sophie already checked" tool-call retention — §A.
- Whose-turn derivation and response-window chips on Mine — §C (needs `SupportMessage.role` join per row; worth its own pass).
- A shared per-user saved-views **table** — views ship device-local now; the UI copy says so.
