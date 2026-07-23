import React, { useEffect, useRef, useState } from 'react';
import { PageHeader, th, td } from '../../../components/ui';
import type { Page } from '../../../types';
import { CustomerApiError } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
import {
  listConnectors, connectorHealth, hubSync, PROVIDERS,
} from '../../../lib/connectorApi';
import type { Connector } from '../../../lib/connectorApi';
import { listKnowledgeDocs, listChunkStatus, createKnowledgeDoc, ingestDocChunks, extractPdf, extractUrl } from '../../../lib/knowledgeApi';
import type { KnowledgeDoc } from '../../../lib/knowledgeApi';

// ============================================================
// Ingestion & Sources — connected sources, processing pipeline,
// human review queue. Sources reconciled with the DE system
// access lists (Confluence/Zendesk for TCP, SharePoint/Thomson
// Reuters for PWC).
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
  // WS8: the tab named "Ingestion" can finally ingest PDF/URL/dropped files
  // (reusing extract-document), not just pasted text.
  const [urlInput, setUrlInput] = useState('');
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) e.target.value = '';
    if (!file) return;
    setAddOpen(true); setBusyMsg(`Reading ${file.name}…`);
    try {
      const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      const res = isPdf ? await extractPdf(file) : { title: file.name.replace(/\.[^.]+$/, ''), text: await file.text(), chars: 0 };
      setAddTitle(prev => prev || res.title || file.name);
      setAddContent(res.text);
    } catch (err) { setToast(`Couldn't read the file: ${(err as Error)?.message ?? 'unknown error'}`); }
    finally { setBusyMsg(null); }
  };
  const importUrl = async () => {
    if (!urlInput.trim()) return;
    setAddOpen(true); setBusyMsg('Fetching the page…');
    try {
      const res = await extractUrl(urlInput.trim());
      setAddTitle(prev => prev || res.title || urlInput.trim());
      setAddContent(res.text);
      setUrlInput('');
    } catch (err) { setToast(`Couldn't import the URL: ${(err as Error)?.message ?? 'unknown error'}`); }
    finally { setBusyMsg(null); }
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
              <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown" className="hidden"
                onChange={e => void onFile(e)}
                onDragOver={e => e.preventDefault()} />
              {!addOpen ? (
                <div
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && fileRef.current) { const dt = new DataTransfer(); dt.items.add(f); fileRef.current.files = dt.files; void onFile({ target: fileRef.current } as unknown as React.ChangeEvent<HTMLInputElement>); } }}
                  className="w-full rounded-2xl border-2 border-dashed border-dt-border-strong hover:border-indigo-500/50 bg-dt-panel p-8 text-center transition-colors">
                  <div className="w-10 h-10 mx-auto rounded-xl bg-dt-panel flex items-center justify-center text-lg mb-3">↑</div>
                  <p className="text-sm font-medium text-dt-body">Add a document</p>
                  <p className="text-xs text-dt-muted mt-1">Drop a PDF / text file here, or:</p>
                  <div className="flex flex-wrap items-center justify-center gap-2 mt-3">
                    <button onClick={() => fileRef.current?.click()} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:border-indigo-500">Upload file</button>
                    <button onClick={() => setAddOpen(true)} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:border-indigo-500">Paste text</button>
                  </div>
                  <div className="flex items-center gap-2 mt-3 max-w-md mx-auto">
                    <input value={urlInput} onChange={e => setUrlInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void importUrl(); }}
                      placeholder="…or paste a help-center URL" onClick={e => e.stopPropagation()}
                      className="flex-1 bg-dt-page border border-dt-border rounded-lg px-3 py-1.5 text-xs text-dt-body focus:outline-none focus:border-indigo-500" />
                    <button onClick={() => void importUrl()} disabled={!urlInput.trim() || !!busyMsg} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white">Import</button>
                  </div>
                  {busyMsg && <p className="text-xs text-indigo-300 mt-2">{busyMsg}</p>}
                </div>
              ) : (
                <div className="rounded-2xl border border-dt-border bg-dt-card p-4 space-y-2">
                  <div className="flex gap-2">
                    <button onClick={() => fileRef.current?.click()} className="text-xs px-2.5 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:border-indigo-500">Upload file</button>
                    <input value={urlInput} onChange={e => setUrlInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void importUrl(); }}
                      placeholder="…or import a URL" className="flex-1 bg-dt-page border border-dt-border rounded-lg px-2 py-1 text-xs text-dt-body focus:outline-none focus:border-indigo-500" />
                    <button onClick={() => void importUrl()} disabled={!urlInput.trim() || !!busyMsg} className="text-xs px-2.5 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:border-indigo-500 disabled:opacity-50">Import</button>
                  </div>
                  {busyMsg && <p className="text-xs text-indigo-300">{busyMsg}</p>}
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
}
