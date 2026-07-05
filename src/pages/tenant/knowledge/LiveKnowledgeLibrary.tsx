import React, { useEffect, useRef, useState } from 'react';
import { PageHeader, th, td } from '../../../components/ui';
import {
  KnowledgeDoc, listKnowledgeDocs, createKnowledgeDoc,
  updateKnowledgeDoc, deleteKnowledgeDoc,
  DocChunkStatus, listChunkStatus, ingestDocChunks,
  ScopeSubject, listScopeSubjects, listDocScopes, setDocScope,
} from '../../../lib/knowledgeApi';
import { CustomerApiError } from '../../../lib/customerApi';
import { getEvalGate, auditEvalGateOverride, EvalGate } from '../../../lib/evalApi';
import type { Page } from '../../../types';

// ============================================================
// Live Knowledge Library — the tenant's real knowledge_docs.
// These documents are the ONLY thing Alex (Customer Support DE)
// answers from, so the page is honest about that relationship.
// ============================================================

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

interface EditorState {
  id: string | null; // null = new doc
  title: string;
  content: string;
  tags: string; // comma-separated in the input
}

const emptyEditor: EditorState = { id: null, title: '', content: '', tags: '' };

const LiveKnowledgeLibrary = ({ setPage }: { setPage?: (p: Page) => void }) => {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingTables, setMissingTables] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [chunkStatus, setChunkStatus] = useState<Record<string, DocChunkStatus>>({});
  const [indexingIds, setIndexingIds] = useState<Set<string>>(new Set());
  // Per-DE knowledge scopes (migration 030)
  const [subjects, setSubjects] = useState<ScopeSubject[]>([]);
  const [docScopes, setDocScopes] = useState<Record<string, { kind: 'de' | 'specialist'; id: string }[]>>({});
  const [scopeDoc, setScopeDoc] = useState<KnowledgeDoc | null>(null); // doc whose scope modal is open
  const [scopeSel, setScopeSel] = useState<Set<string>>(new Set());   // "kind:id" keys
  const [scopeSaving, setScopeSaving] = useState(false);
  // Eval gate (R3): when the tenant's latest finished eval run FAILED,
  // publishes ask for an explicit, audited override. Client-side soft
  // gate v1 — the server-side hard gate is the hardening step.
  const [gateConfirm, setGateConfirm] = useState<{ gate: EvalGate; proceed: () => void } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Runs `publish` directly when the gate is clear; otherwise opens the
   *  override dialog. `docTitle` is used for the audit entry on override. */
  const withEvalGate = async (docTitle: string, publish: () => Promise<void>) => {
    const gate = await getEvalGate();
    if (gate?.status === 'failed') {
      setGateConfirm({
        gate,
        proceed: () => {
          setGateConfirm(null);
          void auditEvalGateOverride(gate, docTitle);
          void publish();
        },
      });
      return;
    }
    await publish();
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setDocs(await listKnowledgeDocs());
      setChunkStatus(await listChunkStatus());
      setDocScopes(await listDocScopes());
      try { setSubjects(await listScopeSubjects()); } catch { /* non-fatal — scoping UI disabled */ }
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  // Fire-and-forget: chunk + embed a doc via the ingest-chunks edge
  // function so Alex retrieves it semantically. Failure is non-fatal —
  // the doc still works with keyword retrieval ("Keyword only" badge).
  const index = (docId: string) => {
    setIndexingIds(prev => new Set(prev).add(docId));
    ingestDocChunks(docId)
      .then(status => setChunkStatus(prev => ({ ...prev, [docId]: status })))
      .catch(err => console.error('ingestDocChunks:', err))
      .finally(() => setIndexingIds(prev => {
        const next = new Set(prev);
        next.delete(docId);
        return next;
      }));
  };

  const IndexBadge = ({ docId }: { docId: string }) => {
    const s = chunkStatus[docId];
    if (indexingIds.has(docId)) {
      return <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">Indexing…</span>;
    }
    if (s && s.embedded > 0) {
      return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">Indexed · {s.chunks} chunk{s.chunks === 1 ? '' : 's'}</span>;
    }
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">Keyword only</span>;
  };

  // ── Scope modal (Who can use this) ──
  const skey = (s: { kind: string; id: string }) => `${s.kind}:${s.id}`;

  const openScope = (doc: KnowledgeDoc) => {
    setScopeDoc(doc);
    setScopeSel(new Set((docScopes[doc.id] ?? []).map(skey)));
  };

  const saveScope = async () => {
    if (!scopeDoc || scopeSaving) return;
    setScopeSaving(true);
    setError(null);
    try {
      const chosen = subjects.filter(s => scopeSel.has(skey(s))).map(s => ({ kind: s.kind, id: s.id }));
      await setDocScope(scopeDoc.id, chosen);
      setScopeDoc(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScopeSaving(false);
    }
  };

  const ScopeBadge = ({ doc }: { doc: KnowledgeDoc }) => {
    const n = (docScopes[doc.id] ?? []).length;
    const scoped = doc.visibility === 'scoped' && n > 0;
    return (
      <button
        onClick={() => openScope(doc)}
        title={scoped
          ? 'Only the selected team members use this document when answering — click to change'
          : 'All digital employees and specialists use this document — click to limit it'}
        className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${scoped
          ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
          : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
      >
        {scoped ? `Scoped · ${n}` : 'All digital employees'}
      </button>
    );
  };

  const save = async () => {
    if (!editor || !editor.title.trim() || !editor.content.trim() || saving) return;
    await withEvalGate(editor.title.trim(), doSave);
  };

  const doSave = async () => {
    if (!editor || saving) return;
    setSaving(true);
    setError(null);
    const tags = editor.tags.split(',').map(t => t.trim()).filter(Boolean);
    try {
      let docId: string;
      if (editor.id) {
        const updated = await updateKnowledgeDoc(editor.id, { title: editor.title.trim(), content: editor.content, tags });
        docId = updated.id;
      } else {
        const created = await createKnowledgeDoc({ title: editor.title.trim(), content: editor.content, source: 'paste', tags });
        docId = created.id;
      }
      setEditor(null);
      await load();
      index(docId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setDeletingId(id);
    setError(null);
    try {
      await deleteKnowledgeDoc(id);
      setDocs(prev => prev.filter(d => d.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    const title = file.name.replace(/\.(txt|md|markdown)$/i, '');
    await withEvalGate(title, async () => {
      try {
        const text = await file.text();
        const created = await createKnowledgeDoc({ title, content: text, source: 'upload', tags: [] });
        await load();
        index(created.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  if (missingTables) {
    return (
      <div className="flex-1 overflow-y-auto bg-slate-950 p-6">
        <PageHeader title="Knowledge Library" subtitle="The documents Alex answers from." />
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5 max-w-xl">
          <p className="text-sm text-amber-300 font-medium mb-1">Workspace still provisioning</p>
          <p className="text-xs text-slate-400">
            The knowledge tables haven't been created yet (migration 012). Apply
            <code className="mx-1 text-slate-300">supabase/migrations/012_knowledge_docs.sql</code>
            in the Supabase SQL Editor, then reload.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-6">
      <PageHeader title="Knowledge Library" subtitle="These documents are the only thing Alex answers from — keep them current." />

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4 text-xs text-red-300">{error}</div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => setEditor({ ...emptyEditor })}
          className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
        >
          + Add document
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="text-sm px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-colors"
        >
          Upload .txt / .md
        </button>
        <input ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" className="hidden" onChange={onFile} />
        <span className="text-xs text-slate-500 ml-auto">{docs.length} document{docs.length === 1 ? '' : 's'}</span>
      </div>

      {/* Table / empty state */}
      {loading ? (
        <p className="text-sm text-slate-500 py-8 text-center">Loading documents…</p>
      ) : docs.length === 0 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-10 text-center">
          <p className="text-sm text-slate-300 font-medium mb-1">Alex answers from these documents — add your first</p>
          <p className="text-xs text-slate-500 mb-4">Paste your FAQs, policies, product docs, or upload .txt/.md files. Alex will only answer what these documents support.</p>
          <button
            onClick={() => setEditor({ ...emptyEditor })}
            className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            + Add your first document
          </button>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden">
          <table className="w-full text-sm text-slate-300">
            <thead className="bg-slate-900 border-b border-slate-800">
              <tr>
                <th className={th}>Title</th>
                <th className={th}>Preview</th>
                <th className={th}>Tags</th>
                <th className={th}>Source</th>
                <th className={th}>Retrieval</th>
                <th className={th}>Who can use this</th>
                <th className={th}>Updated</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {docs.map(d => (
                <tr key={d.id} className="border-b border-slate-800/60 hover:bg-slate-800/40 transition-colors">
                  <td className={`${td} text-white font-medium`}>{d.title}</td>
                  <td className={`${td} text-xs text-slate-400 max-w-xs`}>
                    <span className="line-clamp-2">{d.content.slice(0, 140)}{d.content.length > 140 ? '…' : ''}</span>
                  </td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-1">
                      {d.tags.length === 0 && <span className="text-xs text-slate-600">—</span>}
                      {d.tags.map(t => (
                        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{t}</span>
                      ))}
                    </div>
                  </td>
                  <td className={td}>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${d.source === 'upload' ? 'bg-teal-500/20 text-teal-400' : 'bg-indigo-500/20 text-indigo-400'}`}>
                      {d.source}
                    </span>
                  </td>
                  <td className={td}><IndexBadge docId={d.id} /></td>
                  <td className={td}><ScopeBadge doc={d} /></td>
                  <td className={`${td} text-xs text-slate-400`}>{fmtDate(d.updated_at)}</td>
                  <td className={td}>
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setEditor({ id: d.id, title: d.title, content: d.content, tags: d.tags.join(', ') })}
                        className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => void remove(d.id)}
                        disabled={deletingId === d.id}
                        className="text-xs text-red-400/80 hover:text-red-300 disabled:opacity-40 transition-colors"
                      >
                        {deletingId === d.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Editor modal */}
      {editor && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-6" onClick={() => !saving && setEditor(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div onClick={e => e.stopPropagation()} className="relative w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white mb-4">{editor.id ? 'Edit document' : 'Add document'}</h2>
            <label className="block text-xs text-slate-500 mb-1">Title</label>
            <input
              value={editor.title}
              onChange={e => setEditor({ ...editor, title: e.target.value })}
              placeholder="e.g. Refund policy"
              className="w-full mb-3 text-sm bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
            />
            <label className="block text-xs text-slate-500 mb-1">Content (plain text or Markdown)</label>
            <textarea
              value={editor.content}
              onChange={e => setEditor({ ...editor, content: e.target.value })}
              rows={10}
              placeholder="Paste the document content Alex should answer from…"
              className="w-full mb-3 text-sm bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-y"
            />
            <label className="block text-xs text-slate-500 mb-1">Tags (comma-separated, optional)</label>
            <input
              value={editor.tags}
              onChange={e => setEditor({ ...editor, tags: e.target.value })}
              placeholder="billing, refunds"
              className="w-full mb-5 text-sm bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditor(null)}
                disabled={saving}
                className="text-sm px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 disabled:opacity-40 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void save()}
                disabled={saving || !editor.title.trim() || !editor.content.trim()}
                className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition-colors"
              >
                {saving ? 'Saving…' : editor.id ? 'Save changes' : 'Add document'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scope modal — Who can use this document (migration 030) */}
      {scopeDoc && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-6" onClick={() => !scopeSaving && setScopeDoc(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div onClick={e => e.stopPropagation()} className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white mb-1">Who can use this document?</h2>
            <p className="text-xs text-slate-500 mb-4">
              “{scopeDoc.title}” — by default every digital employee and specialist answers from it.
              Select team members to limit it: <span className="text-slate-400">only selected team members
              will use this document when answering.</span> Leave everything unticked for everyone.
            </p>
            {subjects.length === 0 ? (
              <p className="text-sm text-slate-500 mb-4">No digital employees or specialists in this workspace yet.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto mb-4 space-y-1">
                {subjects.map(s => {
                  const k = skey(s);
                  const checked = scopeSel.has(k);
                  return (
                    <label key={k} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-800/60 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setScopeSel(prev => {
                          const next = new Set(prev);
                          if (next.has(k)) next.delete(k); else next.add(k);
                          return next;
                        })}
                        className="accent-indigo-500"
                      />
                      <span className="text-sm text-slate-200">{s.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ml-auto ${s.kind === 'de' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-teal-500/15 text-teal-300'}`}>
                        {s.kind === 'de' ? 'Digital Employee' : 'Specialist'}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-slate-600 mb-4">
              Changes are enforced when answering (server-side) and recorded in the audit trail.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setScopeDoc(null)}
                disabled={scopeSaving}
                className="text-sm px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 disabled:opacity-40 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveScope()}
                disabled={scopeSaving}
                className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition-colors"
              >
                {scopeSaving ? 'Saving…' : scopeSel.size > 0 ? `Limit to ${scopeSel.size} selected` : 'Allow everyone'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Eval gate override dialog (R3) */}
      {gateConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" onClick={() => setGateConfirm(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div onClick={e => e.stopPropagation()} className="relative w-full max-w-md bg-slate-900 border border-red-500/40 rounded-2xl p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white mb-2">Publishing gated by the Proving Ground</h2>
            <p className="text-sm text-slate-300 mb-1">
              Last eval run failed ({gateConfirm.gate.passed}/{gateConfirm.gate.total} passed). Publishing may worsen answers.
            </p>
            <p className="text-xs text-slate-500 mb-5">
              Publishing anyway is allowed but recorded in the audit trail. Recommended: review the failing questions first.
            </p>
            <div className="flex justify-end gap-2">
              {setPage && (
                <button
                  onClick={() => { setGateConfirm(null); setPage('intelligence_evals'); }}
                  className="text-sm px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-colors mr-auto"
                >
                  View Proving Ground
                </button>
              )}
              <button
                onClick={() => setGateConfirm(null)}
                className="text-sm px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={gateConfirm.proceed}
                className="text-sm px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors"
              >
                Publish anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LiveKnowledgeLibrary;
