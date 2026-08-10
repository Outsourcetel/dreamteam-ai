// ── History as a REPORT (handoff 06 §D), not a bare list ──────────────────
// Closed conversations never appear in a working view; this is where they
// answer questions: what closed, who closed it, how fast, how well rated.
// All logic is in src/lib/supportReport.ts (pure, vitest-pinned) — this file
// is layout only.
//
// Facet options come from values PRESENT in the rows, never a configured
// list (the FilterBar lesson, decided 2026-08-09): the Rating facet appears
// only once anything IS rated (0 today), and the Manager facet once a
// manager-assigned DE has closed work — both self-enable as data arrives.
// ⚠ Manager = de_assignments relation='manager' (the docs/29 reporting
// line), NOT is_supervisor: that column marks a DE as the tenant's
// question-router, holds zero rows, and the handoff's SRC note pointing at
// it is why this facet once looked unbuildable.
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

export default function SupportHistoryReport({ rows, deNames, userNames, teams, deTeams, deManagers, storeKey }: {
  rows: SupportConversation[];
  deNames: Map<string, string>;
  userNames: Map<string, string>;
  teams: Array<{ id: string; name: string }>;
  deTeams: Map<string, string>;
  /** de_id → manager user_ids (de_assignments relation='manager'). */
  deManagers: Map<string, string[]>;
  storeKey: string;
}) {
  const [filters, setFilters] = useState<ReportFilters>({ preset: '30d' });
  const [page, setPage] = useState(0);
  const [views, setViews] = useState<SavedReportView[]>(() => readSavedViews(storeKey));
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState('');

  const set = (patch: Partial<ReportFilters>) => { setPage(0); setFilters(f => ({ ...f, ...patch })); };

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
  const teamsPresent = useMemo(
    () => teams.filter(t => rows.some(r => r.de_id && deTeams.get(r.de_id) === t.id)),
    [teams, rows, deTeams],
  );

  const managersPresent = useMemo(() => {
    const ids = new Set<string>();
    for (const r of rows) for (const m of (r.de_id && deManagers.get(r.de_id)) || []) ids.add(m);
    return [...ids].map(id => ({ id, label: userNames.get(id) || 'A manager' })).sort((a, b) => a.label.localeCompare(b.label));
  }, [rows, deManagers, userNames]);

  const filtered = useMemo(() => applyReportFilters(rows, filters, { deTeams, deManagers }, new Date()), [rows, filters, deTeams, deManagers]);
  const summary = useMemo(() => summariseReport(filtered), [filtered]);
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const filtersActive = !!(filters.topic || filters.teamId || filters.managerId || filters.handledBy || filters.channel
    || filters.rated || filters.search?.trim() || filters.preset === 'custom');

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
      {/* Saved views — device-local; the tooltip says so, honestly. */}
      <div className="flex items-center gap-2 flex-wrap">
        {views.map(v => (
          <button key={v.name} onClick={() => { setPage(0); setFilters(v.filters); }}
            className="text-xs px-2.5 py-1 rounded-full border border-dt-border bg-dt-card text-dt-support hover:border-dt-border-strong">
            {v.name}
          </button>
        ))}
        {views.length > 0 && (
          <button onClick={() => { setViews([]); writeSavedViews(storeKey, []); }}
            className="text-xs text-dt-faint hover:text-dt-support"
            title="Removes the saved shortcuts, not any conversations.">
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
            title="Saved on this device — a shortcut to a set of filters, not shared with the team yet.">
            + Save this view
          </Button>
        )}
      </div>

      <FilterBar
        presets={<>
          {DATE_PRESETS.map(p => (
            <button key={p.key} onClick={() => set({ preset: p.key, from: undefined, to: undefined })}>
              <Chip tone={filters.preset === p.key ? 'accent' : 'neutral'}>{p.label}</Chip>
            </button>
          ))}
          <input type="date" value={filters.from ?? ''} aria-label="Closed from"
            onChange={e => set({ preset: 'custom', from: e.target.value || undefined })}
            className={`${SELECT_CLS} !py-1.5 text-xs`} />
          <span className="text-dt-faint text-xs" aria-hidden>→</span>
          <input type="date" value={filters.to ?? ''} aria-label="Closed up to"
            onChange={e => set({ preset: 'custom', to: e.target.value || undefined })}
            className={`${SELECT_CLS} !py-1.5 text-xs`} />
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
          {/* Manager = the docs/29 reporting line (de_assignments), NOT
              is_supervisor — that marks a DE as the tenant's question-router
              and holds zero rows besides. Present-values rule as everywhere:
              the facet appears once a manager-assigned DE has closed work. */}
          {managersPresent.length > 0 && (
            <select value={filters.managerId ?? ''} aria-label="Filter by manager" className={SELECT_CLS}
              onChange={e => set({ managerId: e.target.value || undefined })}>
              <option value="">Any manager</option>
              {managersPresent.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
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
          {/* ⚠ A filter must never be able to say "all clear". */}
          {filtersActive
            ? 'Nothing closed matches that filter. Clear it to see the rest.'
            : 'Nothing has been closed in this period yet.'}
        </p>
      ) : (
        <TableScroll>
          <table className="w-full">
            <thead>
              <tr className="border-b border-dt-border">
                <th className={TH}>Customer</th>
                <th className={TH}>What it was about</th>
                <th className={TH}>Handled by</th>
                <th className={TH}>Topic</th>
                <th className={TH}>Closed</th>
                <th className={TH}>Rating</th>
              </tr>
            </thead>
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
