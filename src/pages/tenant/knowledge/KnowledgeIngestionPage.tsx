import React, { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';
import { K_TYPES } from './KnowledgeLibraryPage';
import type { KEntity, KAudience, KType } from './KnowledgeLibraryPage';
import type { Page } from '../../../types';
import { CustomerApiError } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
import {
  listConnectors, connectorHealth, hubSync, PROVIDERS,
} from '../../../lib/connectorApi';
import type { Connector } from '../../../lib/connectorApi';
import { listKnowledgeDocs, listChunkStatus, createKnowledgeDoc, ingestDocChunks } from '../../../lib/knowledgeApi';
import type { KnowledgeDoc } from '../../../lib/knowledgeApi';

// ============================================================
// Ingestion & Sources — connected sources, processing pipeline,
// human review queue. Sources reconciled with the DE system
// access lists (Confluence/Zendesk for TCP, SharePoint/Thomson
// Reuters for PWC).
// ============================================================

interface Source {
  name: string;
  kind: string;
  status: 'connected' | 'error' | 'disconnected';
  docs: number;
  lastSync: string;
  note?: string;
}

const SOURCES: Record<CompanyId, Source[]> = {
  tcp: [
    { name: 'Confluence', kind: 'Wiki', status: 'connected', docs: 2340, lastSync: '15 min ago' },
    { name: 'Zendesk macros', kind: 'Support', status: 'connected', docs: 156, lastSync: '32 min ago' },
    { name: 'Google Drive', kind: 'Files', status: 'error', docs: 89, lastSync: '2 days ago', note: 'Pending re-authorization — OAuth token expired' },
    { name: 'Notion', kind: 'Wiki', status: 'disconnected', docs: 0, lastSync: '—', note: 'Not connected' },
  ],
  pwc: [
    { name: 'SharePoint', kind: 'Document Mgmt', status: 'connected', docs: 4120, lastSync: '20 min ago' },
    { name: 'Thomson Reuters feed', kind: 'Tax Research', status: 'connected', docs: 1875, lastSync: '1 hr ago' },
    { name: 'Internal memo archive', kind: 'Files', status: 'connected', docs: 640, lastSync: '3 hrs ago' },
  ],
};

interface ReviewItem {
  id: string;
  title: string;
  source: string;
  entity: KEntity;
  audience: KAudience;
  type: KType;
  confidence: number;
}

const REVIEW_SEED: Record<CompanyId, ReviewItem[]> = {
  tcp: [
    { id: 'r1', title: 'SAML assertion troubleshooting notes', source: 'Confluence', entity: 'Customer', audience: 'Customer DEs', type: 'Procedural', confidence: 81 },
    { id: 'r2', title: 'Q2 release notes — reporting module', source: 'Confluence', entity: 'Customer', audience: 'All DEs', type: 'Reference', confidence: 92 },
    { id: 'r3', title: 'Macro: refund request first response', source: 'Zendesk macros', entity: 'Customer', audience: 'Customer DEs', type: 'Training', confidence: 76 },
    { id: 'r4', title: 'Remote work equipment policy', source: 'Google Drive', entity: 'Workforce', audience: 'Specialist DEs', type: 'Regulatory', confidence: 68 },
    { id: 'r5', title: 'Competitor feature comparison — Q2', source: 'Google Drive', entity: 'Customer', audience: 'Humans only', type: 'Competitive', confidence: 73 },
  ],
  pwc: [
    { id: 'r1', title: 'Rev. Proc. 2026-23 summary', source: 'Thomson Reuters feed', entity: 'Customer', audience: 'Specialist DEs', type: 'Regulatory', confidence: 88 },
    { id: 'r2', title: 'Engagement risk scoring worksheet', source: 'SharePoint', entity: 'Customer', audience: 'Customer DEs', type: 'Institutional', confidence: 79 },
    { id: 'r3', title: 'Memo: transfer pricing documentation', source: 'Internal memo archive', entity: 'Customer', audience: 'Specialist DEs', type: 'Institutional', confidence: 84 },
    { id: 'r4', title: 'Client data handling addendum', source: 'SharePoint', entity: 'Customer', audience: 'Humans only', type: 'Customer (PII)', confidence: 71 },
  ],
};

const PIPELINE_BASE: Record<CompanyId, { stage: string; desc: string; count: number }[]> = {
  tcp: [
    { stage: 'Ingest', desc: 'Pulled from sources', count: 38 },
    { stage: 'Chunk', desc: 'Split & embedded', count: 22 },
    { stage: 'Classify', desc: 'Auto-tag Entity × Audience × Type', count: 14 },
    { stage: 'Confidence', desc: 'Scoring vs. corpus', count: 9 },
    { stage: 'Review', desc: 'Awaiting human review', count: 5 },
    { stage: 'Live', desc: 'Published this week', count: 12 },
  ],
  pwc: [
    { stage: 'Ingest', desc: 'Pulled from sources', count: 51 },
    { stage: 'Chunk', desc: 'Split & embedded', count: 30 },
    { stage: 'Classify', desc: 'Auto-tag Entity × Audience × Type', count: 11 },
    { stage: 'Confidence', desc: 'Scoring vs. corpus', count: 7 },
    { stage: 'Review', desc: 'Awaiting human review', count: 4 },
    { stage: 'Live', desc: 'Published this week', count: 9 },
  ],
};

const statusStyle: Record<Source['status'], { dot: string; label: string; text: string }> = {
  connected: { dot: 'bg-emerald-400', label: 'Connected', text: 'text-emerald-400' },
  error: { dot: 'bg-red-400', label: 'Error', text: 'text-red-400' },
  disconnected: { dot: 'bg-slate-600', label: 'Disconnected', text: 'text-dt-muted' },
};

type ReviewState = Record<string, { decision?: 'approved' | 'rejected'; entity: KEntity; audience: KAudience; type: KType }>;

const DemoKnowledgeIngestionPage = () => {
  const { activeCompanyId } = useAuth();
  const companyId = activeCompanyId as CompanyId;
  const sources = SOURCES[companyId];
  const seed = REVIEW_SEED[companyId];
  const lsKey = `dt_kb_review_${companyId}`;

  const [review, setReview] = useState<ReviewState>(() => {
    try {
      const s = localStorage.getItem(lsKey);
      if (s) return JSON.parse(s);
    } catch { /* noop */ }
    return Object.fromEntries(seed.map(r => [r.id, { entity: r.entity, audience: r.audience, type: r.type }]));
  });
  const [uploaded, setUploaded] = useState<string[]>([]);

  const save = (next: ReviewState) => {
    setReview(next);
    try { localStorage.setItem(lsKey, JSON.stringify(next)); } catch { /* noop */ }
  };
  const patch = (id: string, p: Partial<ReviewState[string]>) => {
    const cur = review[id] ?? { entity: 'Customer' as KEntity, audience: 'All DEs' as KAudience, type: 'Reference' as KType };
    save({ ...review, [id]: { ...cur, ...p } });
  };

  const pending = seed.filter(r => !review[r.id]?.decision);
  const decided = seed.length - pending.length;
  const pipeline = PIPELINE_BASE[companyId].map(s =>
    s.stage === 'Review' ? { ...s, count: Math.max(0, s.count - decided) + uploaded.length * 0 }
    : s.stage === 'Live' ? { ...s, count: s.count + seed.filter(r => review[r.id]?.decision === 'approved').length }
    : s.stage === 'Ingest' ? { ...s, count: s.count + uploaded.length }
    : s
  );

  const handleUpload = () => {
    setUploaded(u => [...u, `Uploaded document ${u.length + 1}.pdf`]);
  };

  return (
    <div className="p-6">
      <PageHeader title="Ingestion & Sources" subtitle="Connect knowledge sources — every document is auto-tagged Entity × Audience × Type, scored, and human-reviewed before going live." />

      {/* Connected sources */}
      <div className="rounded-2xl border border-dt-border bg-dt-card overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-dt-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Connected sources</h3>
          <span className="text-xs text-dt-muted">{sources.filter(s => s.status === 'connected').length} of {sources.length} healthy</span>
        </div>
        <table className="w-full text-sm text-dt-support">
          <thead className="bg-dt-card border-b border-dt-border">
            <tr>
              <th className={th}>Source</th>
              <th className={th}>Kind</th>
              <th className={th}>Status</th>
              <th className={th}>Docs synced</th>
              <th className={th}>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {sources.map(s => {
              const st = statusStyle[s.status];
              return (
                <tr key={s.name} className="border-b border-dt-border">
                  <td className={`${td} text-white font-medium`}>{s.name}</td>
                  <td className={`${td} text-xs text-dt-support`}>{s.kind}</td>
                  <td className={td}>
                    <span className={`flex items-center gap-1.5 text-xs ${st.text}`}>
                      <span className={`w-2 h-2 rounded-full ${st.dot}`} />{st.label}
                    </span>
                    {s.note && <p className="text-[11px] text-dt-muted mt-0.5">{s.note}</p>}
                  </td>
                  <td className={td}>{s.docs > 0 ? s.docs.toLocaleString() : '—'}</td>
                  <td className={`${td} text-xs text-dt-support`}>{s.lastSync}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pipeline */}
      <div className="rounded-2xl border border-dt-border bg-dt-card p-5 mb-6">
        <h3 className="text-sm font-semibold text-white mb-4">Processing pipeline</h3>
        <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
          {pipeline.map((s, i) => (
            <React.Fragment key={s.stage}>
              <div className={`flex-1 min-w-[110px] rounded-xl border p-3 ${s.stage === 'Live' ? 'border-emerald-500/30 bg-emerald-500/5' : s.stage === 'Review' ? 'border-amber-500/30 bg-amber-500/5' : 'border-dt-border bg-dt-page'}`}>
                <p className={`text-xs font-semibold ${s.stage === 'Live' ? 'text-emerald-400' : s.stage === 'Review' ? 'text-amber-400' : 'text-dt-support'}`}>{s.stage}</p>
                <p className="text-xl font-bold text-white mt-1">{s.count}</p>
                <p className="text-[10px] text-dt-muted mt-0.5 leading-tight">{s.desc}</p>
              </div>
              {i < pipeline.length - 1 && <span className="self-center text-dt-faint">→</span>}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Review queue */}
        <div className="xl:col-span-2 rounded-2xl border border-dt-border bg-dt-card overflow-hidden">
          <div className="px-4 py-3 border-b border-dt-border flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Human review queue</h3>
            <span className="text-xs text-dt-muted">{pending.length} awaiting review</span>
          </div>
          <div className="divide-y divide-slate-700/60">
            {seed.map(r => {
              const st = review[r.id];
              const decision = st?.decision;
              return (
                <div key={r.id} className={`p-4 ${decision ? 'opacity-60' : ''}`}>
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <p className="text-sm font-medium text-white">{r.title}</p>
                      <p className="text-xs text-dt-muted mt-0.5">from {r.source} · auto-confidence {r.confidence}%</p>
                    </div>
                    {decision ? (
                      <span className={`text-xs px-2 py-1 rounded-full ${decision === 'approved' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                        {decision === 'approved' ? 'Approved — publishing' : 'Rejected'}
                      </span>
                    ) : (
                      <div className="flex gap-2 flex-shrink-0">
                        <button onClick={() => patch(r.id, { decision: 'approved' })} className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white">Approve</button>
                        <button onClick={() => patch(r.id, { decision: 'rejected' })} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:border-red-500/50 hover:text-red-400">Reject</button>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {([
                      { label: 'Entity', value: st?.entity ?? r.entity, opts: ['Customer', 'Vendor', 'Workforce'], key: 'entity' as const },
                      { label: 'Audience', value: st?.audience ?? r.audience, opts: ['All DEs', 'Customer DEs', 'Specialist DEs', 'Humans only'], key: 'audience' as const },
                      { label: 'Type', value: st?.type ?? r.type, opts: [...K_TYPES], key: 'type' as const },
                    ]).map(f => (
                      <label key={f.label} className="flex items-center gap-1.5">
                        <span className="text-[10px] uppercase tracking-wide text-dt-muted">{f.label}</span>
                        <select
                          disabled={!!decision}
                          value={f.value}
                          onChange={e => patch(r.id, { [f.key]: e.target.value } as any)}
                          className="bg-dt-page border border-dt-border rounded-lg px-2 py-1 text-xs text-dt-body focus:outline-none focus:border-dt-border-strong disabled:opacity-60">
                          {f.opts.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Upload dropzone */}
        <div className="space-y-4">
          <button
            onClick={handleUpload}
            className="w-full rounded-2xl border-2 border-dashed border-dt-border-strong hover:border-indigo-500/50 bg-dt-panel p-8 text-center transition-colors group">
            <div className="w-10 h-10 mx-auto rounded-xl bg-dt-panel group-hover:bg-indigo-500/20 flex items-center justify-center text-lg mb-3 transition-colors">↑</div>
            <p className="text-sm font-medium text-dt-body">Drop files to ingest</p>
            <p className="text-xs text-dt-muted mt-1">PDF, DOCX, MD, HTML — auto-classified into the pipeline</p>
          </button>
          {uploaded.length > 0 && (
            <div className="rounded-2xl border border-dt-border bg-dt-card p-4">
              <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">Just added</p>
              <div className="space-y-2">
                {uploaded.map(u => (
                  <div key={u} className="flex items-center justify-between bg-dt-page rounded-lg px-3 py-2">
                    <span className="text-xs text-dt-support">{u}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400">Ingesting…</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// LIVE mode — real connectors (migrations 017/026/027/028) feeding
// real knowledge_docs. "Ingest" (connector sync → knowledge_docs),
// "Chunk"/"Embed" (same chunking/embedding path as the Knowledge
// Library's manual ingest) are all real. There is NO real "Classify"/
// "Confidence"/"Review" stage or Entity×Audience×Type auto-tagging
// backend — the demo's human-review queue has nothing to bind to, so
// rather than invent a classification/approval system that doesn't
// exist, this page is honest that a synced document goes straight
// into the knowledge base with no review gate today.
// ============================================================

const HEALTH_META: Record<string, { label: string; dot: string; text: string }> = {
  healthy: { label: 'Healthy', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  degraded: { label: 'Degraded', dot: 'bg-amber-400', text: 'text-amber-400' },
  down: { label: 'Down', dot: 'bg-red-400', text: 'text-red-400' },
  never_connected: { label: 'Never connected', dot: 'bg-slate-600', text: 'text-dt-muted' },
};

function LiveKnowledgeIngestion({ setPage }: { setPage: (p: Page) => void }) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [chunkStatus, setChunkStatus] = useState<Record<string, { chunks: number; embedded: number }>>({});
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addContent, setAddContent] = useState('');
  const [adding, setAdding] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, d, cs] = await Promise.all([listConnectors(), listKnowledgeDocs(), listChunkStatus()]);
      setConnectors(c);
      setDocs(d);
      setChunkStatus(cs);
      setMissingTables(false);
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load ingestion data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const doSync = async (c: Connector) => {
    setSyncingId(c.id);
    try {
      const r = await hubSync(c.id);
      if (r.ok) {
        setToast(`${c.display_name || c.provider}: ${r.upserted ?? 0} doc(s) synced, ${r.chunked ?? 0} chunks, ${r.embedded ?? 0} embedded.`);
      } else {
        setToast(`${c.display_name || c.provider}: sync failed — ${r.detail ?? r.error ?? 'unknown error'}`);
      }
      await refresh();
    } catch (err) {
      setToast(`Sync failed: ${(err as Error)?.message ?? 'unknown error'}`);
    } finally {
      setSyncingId(null);
    }
  };

  const addDoc = async () => {
    if (!addTitle.trim() || !addContent.trim()) return;
    setAdding(true);
    try {
      const doc = await createKnowledgeDoc({ title: addTitle.trim(), content: addContent.trim(), source: 'paste', tags: [] });
      await ingestDocChunks(doc.id);
      setToast(`"${doc.title}" added and indexed.`);
      setAddTitle('');
      setAddContent('');
      setAddOpen(false);
      await refresh();
    } catch (err) {
      setToast(`Couldn't add document: ${(err as Error)?.message ?? 'unknown error'}`);
    } finally {
      setAdding(false);
    }
  };

  const connectorDocs = docs.filter(d => d.source === 'connector');
  const connectorDocIds = new Set(connectorDocs.map(d => d.id));
  let chunkedCount = 0, embeddedCount = 0;
  for (const id of connectorDocIds) {
    const s = chunkStatus[id];
    if (s) { chunkedCount += s.chunks; embeddedCount += s.embedded; }
  }
  const healthyCount = connectors.filter(c => connectorHealth(c) === 'healthy').length;

  const pipeline = [
    { stage: 'Sources', desc: 'Connected & healthy', count: healthyCount, total: connectors.length },
    { stage: 'Ingested', desc: 'Documents synced in', count: connectorDocs.length },
    { stage: 'Chunked', desc: 'Split for retrieval', count: chunkedCount },
    { stage: 'Embedded', desc: 'Indexed for search', count: embeddedCount },
  ];

  return (
    <div className="p-6 relative">
      <PageHeader title="Ingestion & Sources" subtitle="Real connector syncs pull external content into the knowledge base — chunked and indexed automatically." />

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : connectors.length === 0 ? (
        <LiveEmptyState
          icon="⟷"
          title="No sources connected yet"
          body="Connect a system like Zendesk, Confluence, or Salesforce to pull its content into the knowledge base automatically. You can also add a document directly below."
          primaryLabel="Go to Connectors"
          onPrimary={() => setPage('systems_connectors')}
        />
      ) : (
        <>
          {/* Pipeline */}
          <div className="rounded-2xl border border-dt-border bg-dt-card p-5 mb-6">
            <h3 className="text-sm font-semibold text-white mb-4">Processing pipeline</h3>
            <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
              {pipeline.map((s, i) => (
                <React.Fragment key={s.stage}>
                  <div className="flex-1 min-w-[110px] rounded-xl border border-dt-border bg-dt-page p-3">
                    <p className="text-xs font-semibold text-dt-support">{s.stage}</p>
                    <p className="text-xl font-bold text-white mt-1">{s.count}{s.total !== undefined ? <span className="text-sm text-dt-muted"> / {s.total}</span> : null}</p>
                    <p className="text-[10px] text-dt-muted mt-0.5 leading-tight">{s.desc}</p>
                  </div>
                  {i < pipeline.length - 1 && <span className="self-center text-dt-faint flex-shrink-0">→</span>}
                </React.Fragment>
              ))}
            </div>
            <p className="text-[11px] text-dt-muted mt-3">
              Synced documents go straight into the knowledge base — there's no draft/review gate on connector-sourced content today. You can still edit or remove any document from the Knowledge Library.
            </p>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Connected sources */}
            <div className="xl:col-span-2 rounded-2xl border border-dt-border bg-dt-card overflow-hidden">
              <div className="px-4 py-3 border-b border-dt-border flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Connected sources</h3>
                <span className="text-xs text-dt-muted">{healthyCount} of {connectors.length} healthy</span>
              </div>
              <table className="w-full text-sm text-dt-support">
                <thead className="bg-dt-card border-b border-dt-border">
                  <tr>
                    <th className={th}>Source</th>
                    <th className={th}>Status</th>
                    <th className={th}>Docs synced</th>
                    <th className={th}>Last sync</th>
                    <th className={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {connectors.map(c => {
                    const health = connectorHealth(c);
                    const st = HEALTH_META[health];
                    const meta = PROVIDERS[c.provider];
                    const canSync = meta?.knowledgeSync && c.access_mode !== 'fetch_only';
                    const docsForThisConnector = connectorDocs.filter(d => (d.tags ?? []).includes(`connector:${c.provider}`)).length;
                    return (
                      <tr key={c.id} className="border-b border-dt-border">
                        <td className={`${td} text-white font-medium`}>
                          {c.display_name || meta?.label || c.provider}
                          <p className="text-[11px] text-dt-muted font-normal">{meta?.label ?? c.provider}</p>
                        </td>
                        <td className={td}>
                          <span className={`flex items-center gap-1.5 text-xs ${st.text}`}>
                            <span className={`w-2 h-2 rounded-full ${st.dot}`} />{st.label}
                          </span>
                          {c.last_error && <p className="text-[11px] text-dt-muted mt-0.5 max-w-xs truncate" title={c.last_error}>{c.last_error}</p>}
                        </td>
                        <td className={td}>{docsForThisConnector.toLocaleString()}</td>
                        <td className={`${td} text-xs text-dt-support`}>{c.last_sync_at ? new Date(c.last_sync_at).toLocaleString() : 'never'}</td>
                        <td className={td}>
                          {canSync ? (
                            <button
                              disabled={syncingId === c.id}
                              onClick={() => void doSync(c)}
                              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white">
                              {syncingId === c.id ? 'Syncing…' : 'Sync now'}
                            </button>
                          ) : (
                            <span className="text-[11px] text-dt-faint" title={c.access_mode === 'fetch_only' ? "This source is fetch-only — content is looked up live, never stored" : "This provider doesn't support knowledge sync"}>
                              {c.access_mode === 'fetch_only' ? 'fetch-only' : 'no sync'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Quick-add a document */}
            <div className="space-y-4">
              {!addOpen ? (
                <button
                  onClick={() => setAddOpen(true)}
                  className="w-full rounded-2xl border-2 border-dashed border-dt-border-strong hover:border-indigo-500/50 bg-dt-panel p-8 text-center transition-colors group">
                  <div className="w-10 h-10 mx-auto rounded-xl bg-dt-panel group-hover:bg-indigo-500/20 flex items-center justify-center text-lg mb-3 transition-colors">↑</div>
                  <p className="text-sm font-medium text-dt-body">Add a document</p>
                  <p className="text-xs text-dt-muted mt-1">Paste text directly — it's chunked and indexed immediately</p>
                </button>
              ) : (
                <div className="rounded-2xl border border-dt-border bg-dt-card p-4 space-y-2">
                  <input
                    value={addTitle}
                    onChange={e => setAddTitle(e.target.value)}
                    placeholder="Document title"
                    className="w-full bg-dt-page border border-dt-border rounded-lg px-3 py-2 text-sm text-dt-body focus:outline-none focus:border-dt-border-strong" />
                  <textarea
                    value={addContent}
                    onChange={e => setAddContent(e.target.value)}
                    placeholder="Paste the document content…"
                    rows={6}
                    className="w-full bg-dt-page border border-dt-border rounded-lg px-3 py-2 text-sm text-dt-body focus:outline-none focus:border-dt-border-strong resize-none" />
                  <div className="flex gap-2">
                    <button
                      disabled={adding || !addTitle.trim() || !addContent.trim()}
                      onClick={() => void addDoc()}
                      className="flex-1 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white">
                      {adding ? 'Adding…' : 'Add & index'}
                    </button>
                    <button onClick={() => { setAddOpen(false); setAddTitle(''); setAddContent(''); }} className="text-xs px-3 py-2 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <button onClick={() => setPage('systems_connectors')} className="w-full text-xs text-indigo-400 hover:text-indigo-300 transition-colors text-center">
                Manage connectors →
              </button>
            </div>
          </div>
        </>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-dt-panel border border-emerald-500/40 text-sm text-dt-title rounded-xl px-4 py-3 shadow-xl max-w-md">
          {toast}
        </div>
      )}
    </div>
  );
}

export default function KnowledgeIngestionPage({ setPage }: { setPage?: (p: Page) => void }) {
  return <LiveKnowledgeIngestion setPage={setPage ?? (() => {})} />;
  return <DemoKnowledgeIngestionPage />;
}
