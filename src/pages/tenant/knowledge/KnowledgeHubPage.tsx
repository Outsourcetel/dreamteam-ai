import React, { useEffect, useState } from 'react';
import type { Page } from '../../../types';
import { InHubContext } from '../../../components/ui';
import KnowledgeLibraryPage from './KnowledgeLibraryPage';
import KnowledgeIngestionPage from './KnowledgeIngestionPage';
import KnowledgeGapsPage from './KnowledgeGapsPage';
import KnowledgeQualityPage from './KnowledgeQualityPage';
import { getKnowledgeOverview, type KnowledgeOverview } from '../../../lib/knowledgeApi';

// Knowledge hub — the four knowledge surfaces as tabs of ONE nav destination
// (north-star IA: Knowledge is one concept, not four sidebar items). Tabs stay
// real Page keys so the old /knowledge/* URLs keep deep-linking via URLSync.
// Phase-2 WS4: a corpus-level "state of your knowledge" strip (mig 283) turns the
// header into a real command surface — every tile is a live count that jumps to
// the tab where you act on it.
const TABS: { page: Page; label: string }[] = [
  { page: 'knowledge_library', label: 'Library' },
  { page: 'knowledge_ingestion', label: 'Sources & Ingestion' },
  { page: 'knowledge_gaps', label: 'Gap Detection' },
  { page: 'knowledge_quality', label: 'Quality & Coverage' },
];

function OverviewStrip({ ov, setPage }: { ov: KnowledgeOverview; setPage: (p: Page) => void }) {
  const pct = ov.total_docs > 0 ? Math.round(100 * ov.indexed_docs / ov.total_docs) : 0;
  const Tile = ({ label, value, sub, tone, page }: {
    label: string; value: number; sub: string; tone?: string; page?: Page;
  }) => (
    <button onClick={page ? () => setPage(page) : undefined} disabled={!page}
      className={`text-left rounded-xl border border-dt-border bg-dt-card px-4 py-3 transition-colors ${
        page ? 'hover:border-indigo-500/50 cursor-pointer' : 'cursor-default'}`}>
      <div className="text-[11px] uppercase tracking-wide text-dt-muted">{label}</div>
      <div className={`text-xl font-semibold ${tone ?? 'text-white'}`}>{value.toLocaleString()}</div>
      <div className="text-[11px] text-dt-muted mt-0.5">{sub}</div>
    </button>
  );
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mt-4">
      <Tile label="Documents" value={ov.total_docs} sub={`${pct}% indexed for semantic search`} page="knowledge_library" />
      <Tile label="Answered from" value={ov.total_citations} sub={`${ov.cited_docs} of ${ov.total_docs} docs used`} />
      <Tile label="Open gaps" value={ov.open_gaps} tone={ov.open_gaps > 0 ? 'text-amber-300' : 'text-white'} sub="questions not answered well" page="knowledge_gaps" />
      <Tile label="Pending reviews" value={ov.pending_reviews} tone={ov.pending_reviews > 0 ? 'text-indigo-300' : 'text-white'} sub="knowledge fixes awaiting you" page="knowledge_library" />
      <Tile label="Needs re-verify" value={ov.stale_docs} tone={ov.stale_docs > 0 ? 'text-amber-300' : 'text-white'} sub="not confirmed in 90 days" page="knowledge_quality" />
    </div>
  );
}

const KnowledgeHubPage = ({ tab, setPage }: { tab: Page; setPage: (p: Page) => void }) => {
  const [ov, setOv] = useState<KnowledgeOverview | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getKnowledgeOverview().then(o => { if (!cancelled) setOv(o); });
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="text-dt-body">
      <div className="px-6 pt-8">
        <h1 className="text-2xl font-semibold text-white">Knowledge</h1>
        <p className="text-sm text-dt-support mt-1 max-w-2xl">
          Everything your digital employees know — what's in it, where it comes from, what's missing, and how good it is.
        </p>
        {ov && ov.total_docs > 0 && <OverviewStrip ov={ov} setPage={setPage} />}
        <div className="flex gap-1 mt-5 border-b border-dt-border overflow-x-auto scrollbar-none">
          {TABS.map(t => (
            <button key={t.page} onClick={() => setPage(t.page)}
              className={`shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.page ? 'border-indigo-500 text-white' : 'border-transparent text-dt-support hover:text-dt-body'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <InHubContext.Provider value={true}>
        {tab === 'knowledge_library' && <KnowledgeLibraryPage setPage={setPage} />}
        {tab === 'knowledge_ingestion' && <KnowledgeIngestionPage setPage={setPage} />}
        {tab === 'knowledge_gaps' && <KnowledgeGapsPage setPage={setPage} />}
        {tab === 'knowledge_quality' && <KnowledgeQualityPage />}
      </InHubContext.Provider>
    </div>
  );
};

export default KnowledgeHubPage;
