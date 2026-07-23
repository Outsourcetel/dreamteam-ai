import React, { useEffect, useState } from 'react';
import { PageHeader, th, td } from '../../../components/ui';
import { ConfidenceBar } from './KnowledgeLibraryPage';
import { CustomerApiError } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
import { ConfirmDeleteModal } from '../../../components';
import {
  listKnowledgeDocs, getKnowledgeDocCitationStats, markKnowledgeDocVerified, deleteKnowledgeDoc,
  listDocScopes, listScopeSubjects, getKnowledgeCoverageDemand, getKnowledgeOverview,
} from '../../../lib/knowledgeApi';
import type { KnowledgeDoc, KnowledgeDocCitationStats, ScopeSubject, CoverageDemand } from '../../../lib/knowledgeApi';

// ============================================================
// Quality & Coverage — everything on this page is REAL: per-tag
// coverage per Digital Employee, document freshness, and confidence
// calibration against actual human feedback on cited answers.
// ============================================================

const heatClsLive = (v: number) =>
  v >= 90 ? 'bg-emerald-500/25 text-emerald-300'
  : v >= 80 ? 'bg-emerald-500/10 text-emerald-400'
  : v >= 70 ? 'bg-amber-500/15 text-amber-300'
  : 'bg-red-500/15 text-red-300';

function freshnessDays(doc: KnowledgeDoc): number {
  const anchor = doc.last_verified_at ?? doc.created_at;
  return Math.floor((Date.now() - new Date(anchor).getTime()) / (1000 * 60 * 60 * 24));
}

// WS10 coverage-vs-demand helpers.
const fmtAgo = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
};
const COVERAGE_BADGE: Record<string, { cls: string; label: string }> = {
  covered: { cls: 'bg-emerald-500/20 text-emerald-300', label: 'Covered' },
  weak: { cls: 'bg-amber-500/20 text-amber-300', label: 'Thin' },
  none: { cls: 'bg-red-500/20 text-red-300', label: 'No coverage' },
  unknown: { cls: 'bg-dt-page text-dt-faint border border-dt-border', label: '—' },
};
const CoverageBadge = ({ state }: { state: CoverageDemand['top_gaps'][number]['coverage_state'] }) => {
  const b = COVERAGE_BADGE[state] ?? COVERAGE_BADGE.unknown;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${b.cls}`}>{b.label}</span>;
};

function LiveKnowledgeQuality() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [citationStats, setCitationStats] = useState<Record<string, KnowledgeDocCitationStats>>({});
  const [scopes, setScopes] = useState<Record<string, { kind: 'de' | 'specialist'; id: string }[]>>({});
  const [subjects, setSubjects] = useState<ScopeSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<KnowledgeDoc | null>(null);
  // WS10: coverage-vs-demand (never-cited total sourced from the overview, since
  // the RPC returns only the LIST to avoid an O(corpus) count each load).
  const [coverage, setCoverage] = useState<CoverageDemand | null>(null);
  const [neverCitedTotal, setNeverCitedTotal] = useState<number | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, cs, sc, subj, cov, ovr] = await Promise.all([
        listKnowledgeDocs(), getKnowledgeDocCitationStats(), listDocScopes(), listScopeSubjects(),
        getKnowledgeCoverageDemand(), getKnowledgeOverview(),
      ]);
      setDocs(d);
      setCitationStats(cs);
      setScopes(sc);
      setSubjects(subj);
      setCoverage(cov);
      setNeverCitedTotal(ovr?.never_cited ?? null);
      setMissingTables(false);
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load knowledge quality data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const reverify = async (doc: KnowledgeDoc) => {
    setBusyId(doc.id);
    try {
      await markKnowledgeDocVerified(doc.id);
      setToast(`"${doc.title}" marked verified today.`);
      await refresh();
    } catch (err) {
      setToast(`Couldn't mark verified: ${(err as Error)?.message ?? 'unknown error'}`);
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async (doc: KnowledgeDoc) => {
    await deleteKnowledgeDoc(doc.id);
    setToast(`"${doc.title}" deleted.`);
    setConfirmDelete(null);
    await refresh();
  };

  const deDes = subjects.filter(s => s.kind === 'de');
  const tags = Array.from(new Set(docs.flatMap(d => d.tags ?? []))).sort();

  // Coverage: for a given tag + DE, % of that tag's docs visible to
  // that DE — a doc with no scope row is tenant-wide (visible to
  // every DE); a doc with scope rows is only visible to those listed.
  const coverageFor = (tag: string, deId: string): number | null => {
    const inTag = docs.filter(d => (d.tags ?? []).includes(tag));
    if (inTag.length === 0) return null;
    const visible = inTag.filter(d => {
      const s = scopes[d.id];
      return !s || s.length === 0 || s.some(x => x.kind === 'de' && x.id === deId);
    });
    return Math.round((visible.length / inTag.length) * 100);
  };

  const buckets = [
    { label: '0–30d', test: (d: number) => d <= 30, cls: 'bg-emerald-400' },
    { label: '31–60d', test: (d: number) => d > 30 && d <= 60, cls: 'bg-sky-400' },
    { label: '61–90d', test: (d: number) => d > 60 && d <= 90, cls: 'bg-amber-400' },
    { label: '>90d stale', test: (d: number) => d > 90, cls: 'bg-red-400' },
  ].map(b => ({ ...b, count: docs.filter(d => b.test(freshnessDays(d))).length }));
  const maxBucket = Math.max(...buckets.map(b => b.count), 1);

  const staleQueue = docs.filter(d => freshnessDays(d) > 90).sort((a, b) => freshnessDays(b) - freshnessDays(a));

  // Real confidence-calibration list: docs that have actually been
  // cited, with a meaningful mismatch between the DE's average
  // confidence and how humans rated those answers.
  const calibration = docs
    .map(d => ({ doc: d, stats: citationStats[d.id] }))
    .filter((x): x is { doc: KnowledgeDoc; stats: KnowledgeDocCitationStats } => !!x.stats && x.stats.citation_count > 0 && x.stats.avg_confidence !== null)
    .map(x => {
      const { stats } = x;
      const feedbackTotal = stats.accurate_count + stats.needs_improvement_count;
      let delta: 'over' | 'under' | null = null;
      if (feedbackTotal > 0) {
        const accurateRate = stats.accurate_count / feedbackTotal;
        if (stats.avg_confidence! >= 70 && accurateRate < 0.6) delta = 'over';
        else if (stats.avg_confidence! < 70 && accurateRate >= 0.8) delta = 'under';
      }
      return { ...x, delta, feedbackTotal };
    })
    .filter(x => x.delta !== null)
    .sort((a, b) => b.stats.citation_count - a.stats.citation_count)
    .slice(0, 8);

  return (
    <div className="p-6 relative">
      <PageHeader title="Quality & Coverage" subtitle="Real coverage per Digital Employee, real document freshness, and real confidence calibration against human feedback." />

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : docs.length === 0 ? (
        <LiveEmptyState
          icon="✓"
          title="No knowledge documents yet"
          body="Once documents exist in the knowledge base, this page shows real coverage per Digital Employee, freshness, and how well each document's answers hold up against human feedback."
        />
      ) : (
        <>
          {/* Coverage matrix */}
          <div className="rounded-2xl border border-dt-border bg-dt-card overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-dt-border">
              <h3 className="text-sm font-semibold text-white">Coverage matrix</h3>
              <p className="text-xs text-dt-muted mt-0.5">Real per-tag visibility — a tag's documents may be tenant-wide or scoped to specific Digital Employees.</p>
            </div>
            {tags.length === 0 || deDes.length === 0 ? (
              <p className="p-6 text-sm text-dt-muted text-center">
                {tags.length === 0 ? 'No documents are tagged yet — tags become "collections" here.' : 'No Digital Employees to show coverage for yet.'}
              </p>
            ) : (
              <table className="w-full text-sm text-dt-support">
                <thead className="bg-dt-card border-b border-dt-border">
                  <tr>
                    <th className={th}>Tag</th>
                    {deDes.map(d => <th key={d.id} className={`${th} text-center`}>{d.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {tags.map(tag => (
                    <tr key={tag} className="border-b border-dt-border">
                      <td className={`${td} text-white`}>{tag}</td>
                      {deDes.map(d => {
                        const val = coverageFor(tag, d.id);
                        return (
                          <td key={d.id} className={`${td} text-center`}>
                            {val === null
                              ? <span className="text-dt-faint">—</span>
                              : <span className={`inline-block min-w-[3rem] text-xs font-medium px-2 py-1 rounded-lg ${heatClsLive(val)}`}>{val}%</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* WS10: Coverage vs demand — what employees couldn't answer, against
              what knowledge actually gets used. Omitted if the RPC isn't live. */}
          {coverage && (
            <div className="rounded-2xl border border-dt-border bg-dt-card overflow-hidden mb-6">
              <div className="px-4 py-3 border-b border-dt-border flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">Coverage vs demand</h3>
                  <p className="text-xs text-dt-muted mt-0.5">What your employees needed but couldn’t answer, set against what your knowledge actually gets cited for.</p>
                </div>
                {coverage.trend.length > 0 && (
                  <span className="text-[11px] text-dt-muted whitespace-nowrap">
                    {coverage.trend.reduce((s, t) => s + t.citations, 0)} citations · last 30d
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-dt-border">
                {/* High-demand topics + coverage verdict */}
                <div className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-semibold text-dt-support uppercase tracking-wide">High-demand topics</h4>
                    {!coverage.probe_enabled && <span className="text-[10px] text-dt-faint" title="Enable the coverage probe to compute live covered/thin/none verdicts per gap.">coverage probe off</span>}
                  </div>
                  {coverage.top_gaps.length === 0 ? (
                    <p className="text-xs text-dt-muted">No open knowledge gaps — employees are finding the answers they need.</p>
                  ) : (
                    <div className="space-y-2">
                      {coverage.top_gaps.slice(0, 8).map(g => (
                        <div key={g.id} className="flex items-start justify-between gap-2 bg-dt-page rounded-lg p-2.5 border border-dt-border">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-white truncate">{g.category || g.reviewer_summary || 'Unlabeled gap'}</p>
                            <p className="text-[11px] text-dt-muted mt-0.5">
                              {g.member_count ?? 0} occurrence{g.member_count === 1 ? '' : 's'}{g.severity_score != null ? ` · severity ${Math.round(g.severity_score)}` : ''}
                            </p>
                          </div>
                          <CoverageBadge state={g.coverage_state} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* Coverage leaders + not-yet-cited */}
                <div className="p-4 space-y-4">
                  <div>
                    <h4 className="text-xs font-semibold text-dt-support uppercase tracking-wide mb-2">Coverage leaders</h4>
                    {coverage.most_cited.length === 0 ? (
                      <p className="text-xs text-dt-muted">No documents have been cited in answers yet.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {coverage.most_cited.slice(0, 5).map(d => (
                          <div key={d.id} className="flex items-center justify-between gap-2">
                            <span className="text-xs text-dt-body truncate">{d.title}</span>
                            <span className="text-[11px] text-emerald-300 flex-shrink-0">{d.citation_count}×</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-semibold text-dt-support uppercase tracking-wide">Not yet cited</h4>
                      {neverCitedTotal != null && <span className="text-[10px] text-dt-faint">{neverCitedTotal} total</span>}
                    </div>
                    {coverage.never_cited.length === 0 ? (
                      <p className="text-xs text-dt-muted">Every established document has been cited at least once.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {coverage.never_cited.slice(0, 5).map(d => (
                          <div key={d.id} className="flex items-center justify-between gap-2">
                            <span className="text-xs text-dt-body truncate">{d.title}</span>
                            <span className="text-[11px] text-dt-faint flex-shrink-0" title={`Added ${new Date(d.updated_at).toLocaleDateString()}`}>{fmtAgo(d.updated_at)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
            {/* Freshness histogram */}
            <div className="rounded-2xl border border-dt-border bg-dt-card p-5">
              <h3 className="text-sm font-semibold text-white mb-1">Freshness</h3>
              <p className="text-xs text-dt-muted mb-4">Documents by time since last verification (or creation, if never verified).</p>
              <div className="flex items-end gap-4 h-36">
                {buckets.map(b => (
                  <div key={b.label} className="flex-1 flex flex-col items-center justify-end h-full">
                    <span className="text-xs font-bold text-white mb-1">{b.count}</span>
                    <div className={`w-full rounded-t-lg ${b.cls}`} style={{ height: `${Math.max((b.count / maxBucket) * 100, 4)}%` }} />
                    <span className={`text-[10px] mt-2 ${b.label.includes('stale') ? 'text-red-400' : 'text-dt-muted'}`}>{b.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Confidence calibration */}
            <div className="rounded-2xl border border-dt-border bg-dt-card p-5">
              <h3 className="text-sm font-semibold text-white mb-1">Confidence calibration</h3>
              <p className="text-xs text-dt-muted mb-4">Real cited documents where DE confidence disagreed with human feedback.</p>
              {calibration.length === 0 ? (
                <p className="text-xs text-dt-muted">No documents have enough citations and feedback yet to compare confidence against outcomes.</p>
              ) : (
                <div className="space-y-3">
                  {calibration.map(({ doc, stats, delta }) => (
                    <div key={doc.id} className="bg-dt-page rounded-xl p-3 border border-dt-border">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium text-white">{doc.title}</p>
                          <p className="text-[11px] text-dt-support mt-1">
                            Cited {stats.citation_count} time{stats.citation_count === 1 ? '' : 's'} · {stats.accurate_count} rated accurate, {stats.needs_improvement_count} rated needs-improvement
                          </p>
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${delta === 'over' ? 'bg-red-500/20 text-red-400' : 'bg-sky-500/20 text-sky-400'}`}>
                          {delta === 'over' ? 'Overconfident' : 'Underconfident'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-2">
                        <ConfidenceBar value={Math.round(stats.avg_confidence ?? 0)} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Stale queue */}
          <div className="rounded-2xl border border-dt-border bg-dt-card overflow-hidden">
            <div className="px-4 py-3 border-b border-dt-border flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">Stale queue</h3>
                <p className="text-xs text-dt-muted mt-0.5">Documents unverified for more than 90 days.</p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${staleQueue.length > 0 ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                {staleQueue.length} pending
              </span>
            </div>
            {staleQueue.length === 0 ? (
              <p className="p-6 text-sm text-dt-muted text-center">Nothing stale — all documents verified (or created) within 90 days.</p>
            ) : (
              <table className="w-full text-sm text-dt-support">
                <thead className="bg-dt-card border-b border-dt-border">
                  <tr>
                    <th className={th}>Document</th>
                    <th className={th}>Tags</th>
                    <th className={th}>Last verified</th>
                    <th className={th}>Citations</th>
                    <th className={`${th} text-right`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {staleQueue.map(d => {
                    const stats = citationStats[d.id];
                    return (
                      <tr key={d.id} className="border-b border-dt-border">
                        <td className={`${td} text-white font-medium`}>{d.title}</td>
                        <td className={`${td} text-xs text-dt-support`}>{(d.tags ?? []).join(', ') || '—'}</td>
                        <td className={`${td} text-xs text-red-400`}>
                          {d.last_verified_at ? new Date(d.last_verified_at).toLocaleDateString() : 'never'} ({freshnessDays(d)}d)
                        </td>
                        <td className={`${td} text-xs text-dt-support`}>{stats?.citation_count ?? 0}</td>
                        <td className={`${td} text-right`}>
                          <div className="flex gap-2 justify-end">
                            <button
                              disabled={busyId === d.id}
                              onClick={() => void reverify(d)}
                              className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white">
                              {busyId === d.id ? '…' : 'Re-verify'}
                            </button>
                            <button onClick={() => setConfirmDelete(d)} className="text-xs px-2.5 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:border-red-500/50 hover:text-red-400">
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          title="Delete document"
          message={`Delete "${confirmDelete.title}"? This removes it from the knowledge base permanently — DEs will no longer be able to cite it.`}
          onConfirm={() => doDelete(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-dt-panel border border-emerald-500/40 text-sm text-dt-title rounded-xl px-4 py-3 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

export default function KnowledgeQualityPage() {
  return <LiveKnowledgeQuality />;
}
