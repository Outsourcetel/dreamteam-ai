import type { Page } from '../../../types';
import { InHubContext } from '../../../components/ui';
import KnowledgeLibraryPage from './KnowledgeLibraryPage';
import KnowledgeIngestionPage from './KnowledgeIngestionPage';
import KnowledgeGapsPage from './KnowledgeGapsPage';
import KnowledgeQualityPage from './KnowledgeQualityPage';

// Knowledge hub — the four knowledge surfaces as tabs of ONE nav destination
// (north-star IA: Knowledge is one concept, not four sidebar items). Tabs stay
// real Page keys so the old /knowledge/* URLs keep deep-linking via URLSync.
const TABS: { page: Page; label: string }[] = [
  { page: 'knowledge_library', label: 'Library' },
  { page: 'knowledge_ingestion', label: 'Sources & Ingestion' },
  { page: 'knowledge_gaps', label: 'Gap Detection' },
  { page: 'knowledge_quality', label: 'Quality & Coverage' },
];

const KnowledgeHubPage = ({ tab, setPage }: { tab: Page; setPage: (p: Page) => void }) => (
  <div className="text-slate-200">
    <div className="max-w-6xl mx-auto px-6 pt-8">
      <h1 className="text-2xl font-semibold text-white">Knowledge</h1>
      <p className="text-sm text-slate-400 mt-1 max-w-2xl">
        Everything your digital employees know — what's in it, where it comes from, what's missing, and how good it is.
      </p>
      <div className="flex gap-1 mt-5 border-b border-slate-700/60 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.page} onClick={() => setPage(t.page)}
            className={`shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.page ? 'border-indigo-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
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

export default KnowledgeHubPage;
