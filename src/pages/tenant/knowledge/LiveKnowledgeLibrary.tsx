import React, { useEffect, useRef, useState } from 'react';
import { ConfirmDeleteModal } from '../../../components';
import { PageHeader, th, td } from '../../../components/ui';
import {
  KnowledgeDoc, listKnowledgeDocs, createKnowledgeDoc,
  updateKnowledgeDoc, deleteKnowledgeDoc,
  DocChunkStatus, listChunkStatus, ingestDocChunks,
  ScopeSubject, listScopeSubjects, listDocScopes, setDocScope,
  KnowledgeRevisionRequest, listKnowledgeRevisionRequests, resolveKnowledgeRevision,
  extractPdf, extractUrl, listDocVersions,
} from '../../../lib/knowledgeApi';
import { CustomerApiError } from '../../../lib/customerApi';
import { getEvalGate, auditEvalGateOverride, EvalGate } from '../../../lib/evalApi';
import type { Page } from '../../../types';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../../components/LiveDataStates';
import AISessionPanel from '../../../components/AISessionPanel';

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
  const [removeTarget, setRemoveTarget] = useState<KnowledgeDoc | null>(null);
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
  // Ledger-3: version-history viewer over the stored previous_version_id chain.
  const [versionsFor, setVersionsFor] = useState<KnowledgeDoc | null>(null);
  const [versions, setVersions] = useState<KnowledgeDoc[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // PDF/URL ingestion (removes the text-only wall).
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [showUrl, setShowUrl] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  // Knowledge Feedback Loop (migration 032): pending revision requests
  // drafted from evidence-run feedback, awaiting human approve/reject.
  const [revisions, setRevisions] = useState<KnowledgeRevisionRequest[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [decidingRevisionId, setDecidingRevisionId] = useState<string | null>(null);
  const [expandedRevisionId, setExpandedRevisionId] = useState<string | null>(null);

  /** Runs `publish` directly when the gate is clear; otherwise opens the
   *  override dialog. `docTitle` is used for the audit entry on override. */
  // Ledger-2 (mig 253): the gate is now DB-ENFORCED — the override path
  // threads a flag so call sites tag the doc 'eval-gate-override', which the
  // server trigger honors (the audit entry already records the override).
  const withEvalGate = async (docTitle: string, publish: (override?: boolean) => Promise<void>) => {
    const gate = await getEvalGate();
    if (gate?.status === 'failed') {
      setGateConfirm({
        gate,
        proceed: () => {
          setGateConfirm(null);
          void auditEvalGateOverride(gate, docTitle);
          void publish(true);
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

  const loadRevisions = async () => {
    setRevisionsLoading(true);
    try { setRevisions(await listKnowledgeRevisionRequests('pending_approval')); }
    catch { /* non-fatal — panel just shows empty */ }
    finally { setRevisionsLoading(false); }
  };

  useEffect(() => { void load(); void loadRevisions(); }, []);

  const decideRevision = async (r: KnowledgeRevisionRequest, decision: 'approved' | 'rejected') => {
    setDecidingRevisionId(r.id);
    setError(null);
    try {
      const res = await resolveKnowledgeRevision(r.id, decision);
      if (res && res.ok === false) throw new Error(res.error ?? 'Could not decide revision');
      await loadRevisions();
      if (decision === 'approved') await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDecidingRevisionId(null);
    }
  };

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
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted">Keyword only</span>;
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
    const roleShared = doc.visibility === 'role';
    const roleLabel = (doc.share_archetype_key ?? '').replace(/_/g, ' ');
    const label = roleShared ? `Role · ${roleLabel || 'shared'}` : scoped ? `Scoped · ${n}` : 'All digital employees';
    const title = roleShared
      ? `Only ${roleLabel || 'same-role'} employees retrieve this document (role-shared learning) — click to change`
      : scoped
        ? 'Only the selected team members use this document when answering — click to change'
        : 'All digital employees and specialists use this document — click to limit it';
    const tone = roleShared
      ? 'bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25'
      : scoped
        ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
        : 'bg-dt-panel text-dt-support hover:bg-dt-panel';
    return (
      <button
        onClick={() => openScope(doc)}
        title={title}
        className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${tone}`}
      >
        {label}
      </button>
    );
  };

  const save = async () => {
    if (!editor || !editor.title.trim() || !editor.content.trim() || saving) return;
    await withEvalGate(editor.title.trim(), doSave);
  };

  const doSave = async (override?: boolean) => {
    if (!editor || saving) return;
    setSaving(true);
    setError(null);
    const tags = editor.tags.split(',').map(t => t.trim()).filter(Boolean);
    if (override) tags.push('eval-gate-override');
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
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    const title = file.name.replace(/\.(txt|md|markdown|pdf)$/i, '');
    await withEvalGate(title, async (override?: boolean) => {
      try {
        setBusyMsg(isPdf ? `Extracting text from ${file.name}…` : null);
        // PDF → server-side text extraction; text/markdown read in-browser.
        const text = isPdf ? (await extractPdf(file)).text : await file.text();
        const created = await createKnowledgeDoc({ title, content: text, source: 'upload', tags: override ? ['eval-gate-override'] : [] });
        await load();
        index(created.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally { setBusyMsg(null); }
    });
  };

  const importUrl = async () => {
    const url = urlInput.trim();
    if (!/^https?:\/\//i.test(url)) { setError('Enter a full http(s) URL.'); return; }
    setError(null);
    await withEvalGate(url, async (override?: boolean) => {
      try {
        setBusyMsg(`Reading ${url}…`);
        const { title, text } = await extractUrl(url);
        const created = await createKnowledgeDoc({ title, content: text, source: 'upload', tags: override ? ['eval-gate-override'] : [] });
        setUrlInput(''); setShowUrl(false);
        await load();
        index(created.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally { setBusyMsg(null); }
    });
  };

  if (missingTables) {
    return (
      <div className="p-6">
        <PageHeader title="Knowledge Library" subtitle="The documents your digital employees answer from." />
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5 max-w-xl">
          <p className="text-sm text-amber-300 font-medium mb-1">Workspace still provisioning</p>
          <p className="text-xs text-dt-support">
            The knowledge tables haven't been created yet (migration 012). Apply
            <code className="mx-1 text-dt-support">supabase/migrations/012_knowledge_docs.sql</code>
            in the Supabase SQL Editor, then reload.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader title="Knowledge Library" subtitle="These documents are the only thing your digital employees answer from — keep them current." />

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
          className="text-sm px-4 py-2 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong transition-colors"
        >
          Upload file
        </button>
        <button
          onClick={() => setShowUrl(v => !v)}
          className="text-sm px-4 py-2 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong transition-colors"
        >
          Import from URL
        </button>
        <button
          onClick={() => setShowAi(v => !v)}
          className="text-sm px-4 py-2 rounded-lg border border-indigo-500/40 text-indigo-300 hover:border-indigo-400 transition-colors"
        >
          ✨ Edit with AI
        </button>
        <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf" className="hidden" onChange={onFile} />
        {busyMsg && <span className="text-xs text-indigo-300">{busyMsg}</span>}
        <span className="text-xs text-dt-muted ml-auto">{docs.length} document{docs.length === 1 ? '' : 's'}</span>
      </div>

      {/* W4-E slice 1 (docs/16): the ✨ spine reaches the page where users
          actually manage knowledge — same AISessionPanel the roster and
          builder use; knowledge.create/edit auto-apply with 120h undo. */}
      {showAi && (
        <div className="mb-4">
          <AISessionPanel subjectKind="workspace" subjectLabel="Knowledge Library"
            examples={['Add an article explaining our refund policy for annual plans', 'Fix the pricing article — the Pro tier is now $49', 'Explain what our employees answer from']}
            onChanged={() => void load()} />
        </div>
      )}

      {showUrl && (
        <div className="flex items-center gap-2 mb-4 rounded-xl border border-dt-border bg-dt-card px-3 py-2">
          <input value={urlInput} onChange={e => setUrlInput(e.target.value)}
            placeholder="https://help.yourcompany.com/article/…"
            className="flex-1 bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body placeholder:text-dt-faint focus:outline-none focus:border-indigo-500"
            onKeyDown={e => { if (e.key === 'Enter') void importUrl(); }} />
          <button onClick={() => void importUrl()} disabled={!!busyMsg || !urlInput.trim()}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white">
            Fetch & add
          </button>
          <button onClick={() => { setShowUrl(false); setUrlInput(''); }} className="text-xs px-2 py-1.5 text-dt-muted hover:text-dt-support">✕</button>
        </div>
      )}

      {/* Table / empty state */}
      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : docs.length === 0 ? (
        <LiveEmptyState
          icon="◎"
          title="Add your first document"
          body="Paste your FAQs, upload a PDF / text / markdown file, or import a help-center URL. Your Digital Employees will only answer what these documents support."
          primaryLabel="+ Add your first document"
          onPrimary={() => setEditor({ ...emptyEditor })}
        />
      ) : (
        <div className="rounded-2xl border border-dt-border bg-dt-card overflow-hidden">
          <table className="w-full text-sm text-dt-support">
            <thead className="bg-dt-card border-b border-dt-border">
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
                <tr key={d.id} className="border-b border-dt-border hover:bg-dt-panel transition-colors">
                  <td className={`${td} text-white font-medium`}>{d.title}</td>
                  <td className={`${td} text-xs text-dt-support max-w-xs`}>
                    <span className="line-clamp-2">{d.content.slice(0, 140)}{d.content.length > 140 ? '…' : ''}</span>
                  </td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-1">
                      {d.tags.length === 0 && <span className="text-xs text-dt-faint">—</span>}
                      {d.tags.map(t => (
                        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">{t}</span>
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
                  <td className={`${td} text-xs text-dt-support`}>{fmtDate(d.updated_at)}</td>
                  <td className={td}>
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setEditor({ id: d.id, title: d.title, content: d.content, tags: d.tags.join(', ') })}
                        className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => { setVersionsFor(d); void listDocVersions(d.id).then(setVersions); }}
                        className="text-xs text-dt-support hover:text-dt-body transition-colors"
                      >
                        History
                      </button>
                      <button
                        onClick={() => setRemoveTarget(d)}
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

      {/* Knowledge Revisions — human-gated updates drafted from evidence
          feedback (migration 032). Diff-like view: current doc content
          vs. the server-assembled proposed content, plus the evidence
          run + reviewer note that triggered the draft. */}
      {(revisions.length > 0 || revisionsLoading) && (
        <div className="mt-6 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5">
          <h3 className="text-sm font-semibold text-white mb-1">Knowledge Revisions — pending your approval</h3>
          <p className="text-[11px] text-dt-muted mb-3">
            Drafted automatically when a reviewer marked resolved-inquiry evidence "needs improvement" or "inaccurate."
            Nothing changes in the knowledge base until you approve here.
          </p>
          {revisionsLoading ? (
            <LiveLoadingSkeleton rows={2} />
          ) : (
            <div className="space-y-2">
              {revisions.map((r) => {
                const currentDoc = docs.find(d => d.id === r.source_doc_id);
                const expanded = expandedRevisionId === r.id;
                return (
                  <div key={r.id} className="rounded-xl border border-dt-border bg-dt-inset">
                    <button
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
                      onClick={() => setExpandedRevisionId(expanded ? null : r.id)}
                    >
                      <span className="text-xs text-white font-medium flex-1 truncate">{r.proposed_title}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${r.source_doc_id ? 'bg-indigo-500/20 text-indigo-300' : 'bg-teal-500/20 text-teal-300'}`}>
                        {r.source_doc_id ? 'Edit to existing doc' : 'New doc proposed'}
                      </span>
                      <span className="text-[10px] text-dt-muted whitespace-nowrap">{fmtDate(r.created_at)}</span>
                    </button>
                    {expanded && (
                      <div className="px-3 pb-3 space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="rounded-lg border border-dt-border bg-dt-card/60 p-3">
                            <p className="text-[10px] font-medium text-dt-muted uppercase tracking-wider mb-1">Current</p>
                            <p className="text-xs text-dt-support whitespace-pre-wrap max-h-48 overflow-y-auto">
                              {currentDoc ? currentDoc.content : '(no existing document — this proposes a brand-new one)'}
                            </p>
                          </div>
                          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                            <p className="text-[10px] font-medium text-emerald-400 uppercase tracking-wider mb-1">Proposed</p>
                            <p className="text-xs text-dt-body whitespace-pre-wrap max-h-48 overflow-y-auto">{r.proposed_body_md}</p>
                          </div>
                        </div>
                        <p className="text-[10px] text-dt-muted">
                          Triggered by evidence run <span className="text-dt-support">{r.evidence_run_id}</span> · drafted server-side from the current document, the evidence run's gaps, and the reviewer's note — never free-form model text.
                        </p>
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => void decideRevision(r, 'rejected')}
                            disabled={decidingRevisionId === r.id}
                            className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:border-red-500/60 hover:text-red-300 disabled:opacity-40 transition-colors"
                          >
                            {decidingRevisionId === r.id ? 'Working…' : 'Reject'}
                          </button>
                          <button
                            onClick={() => void decideRevision(r, 'approved')}
                            disabled={decidingRevisionId === r.id}
                            className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white transition-colors"
                          >
                            {decidingRevisionId === r.id ? 'Working…' : 'Approve & apply'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Editor modal */}
      {editor && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-6" onClick={() => !saving && setEditor(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div onClick={e => e.stopPropagation()} className="relative w-full max-w-2xl bg-dt-card border border-dt-border-strong rounded-2xl p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white mb-4">{editor.id ? 'Edit document' : 'Add document'}</h2>
            <label className="block text-xs text-dt-muted mb-1">Title</label>
            <input
              value={editor.title}
              onChange={e => setEditor({ ...editor, title: e.target.value })}
              placeholder="e.g. Refund policy"
              className="w-full mb-3 text-sm bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
            />
            <label className="block text-xs text-dt-muted mb-1">Content (plain text or Markdown)</label>
            <textarea
              value={editor.content}
              onChange={e => setEditor({ ...editor, content: e.target.value })}
              rows={10}
              placeholder="Paste the document content your employees should answer from…"
              className="w-full mb-3 text-sm bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-y"
            />
            <label className="block text-xs text-dt-muted mb-1">Tags (comma-separated, optional)</label>
            <input
              value={editor.tags}
              onChange={e => setEditor({ ...editor, tags: e.target.value })}
              placeholder="billing, refunds"
              className="w-full mb-5 text-sm bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditor(null)}
                disabled={saving}
                className="text-sm px-4 py-2 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong disabled:opacity-40 transition-colors"
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
          <div onClick={e => e.stopPropagation()} className="relative w-full max-w-md bg-dt-card border border-dt-border-strong rounded-2xl p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white mb-1">Who can use this document?</h2>
            <p className="text-xs text-dt-muted mb-4">
              “{scopeDoc.title}” — by default every digital employee and specialist answers from it.
              Select team members to limit it: <span className="text-dt-support">only selected team members
              will use this document when answering.</span> Leave everything unticked for everyone.
            </p>
            {subjects.length === 0 ? (
              <p className="text-sm text-dt-muted mb-4">No digital employees or specialists in this workspace yet.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto mb-4 space-y-1">
                {subjects.map(s => {
                  const k = skey(s);
                  const checked = scopeSel.has(k);
                  return (
                    <label key={k} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dt-panel/60 cursor-pointer">
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
                      <span className="text-sm text-dt-body">{s.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ml-auto ${s.kind === 'de' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-teal-500/15 text-teal-300'}`}>
                        {s.kind === 'de' ? 'Digital Employee' : 'Specialist'}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-dt-faint mb-4">
              Changes are enforced when answering (server-side) and recorded in the audit trail.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setScopeDoc(null)}
                disabled={scopeSaving}
                className="text-sm px-4 py-2 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong disabled:opacity-40 transition-colors"
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
      {versionsFor && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" onClick={() => { setVersionsFor(null); setVersions(null); }}>
          <div className="w-full max-w-xl bg-dt-page border-l border-dt-border h-full overflow-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Version history</h2>
                <p className="text-xs text-dt-muted mt-0.5">{versionsFor.title} — newest first; every revision is an immutable new version.</p>
              </div>
              <button onClick={() => { setVersionsFor(null); setVersions(null); }} className="text-dt-support hover:text-white text-sm">✕</button>
            </div>
            {versions === null ? (
              <p className="text-xs text-dt-muted">Loading versions…</p>
            ) : versions.length <= 1 ? (
              <p className="text-sm text-dt-muted">Only one version exists — history grows as revisions are approved.</p>
            ) : (
              <div className="space-y-3">
                {versions.map((v, i) => (
                  <div key={v.id} className="rounded-xl border border-dt-border bg-dt-card p-4">
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${i === 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-dt-panel text-dt-muted'}`}>
                        {i === 0 ? 'current' : `v-${i}`}
                      </span>
                      <span className="text-sm font-medium text-dt-title">{v.title}</span>
                      <span className="text-[11px] text-dt-faint ml-auto">{fmtDate(v.created_at)}</span>
                    </div>
                    <p className="text-xs text-dt-support whitespace-pre-wrap max-h-32 overflow-y-auto">{v.content.slice(0, 600)}{v.content.length > 600 ? '…' : ''}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {gateConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" onClick={() => setGateConfirm(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div onClick={e => e.stopPropagation()} className="relative w-full max-w-md bg-dt-card border border-red-500/40 rounded-2xl p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white mb-2">Publishing gated by the Proving Ground</h2>
            <p className="text-sm text-dt-support mb-1">
              Last eval run failed ({gateConfirm.gate.passed}/{gateConfirm.gate.total} passed). Publishing may worsen answers.
            </p>
            <p className="text-xs text-dt-muted mb-5">
              Publishing anyway is allowed but recorded in the audit trail. Recommended: review the failing questions first.
            </p>
            <div className="flex justify-end gap-2">
              {setPage && (
                <button
                  onClick={() => { setGateConfirm(null); setPage('intelligence_evals'); }}
                  className="text-sm px-4 py-2 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong transition-colors mr-auto"
                >
                  View Proving Ground
                </button>
              )}
              <button
                onClick={() => setGateConfirm(null)}
                className="text-sm px-4 py-2 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong transition-colors"
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
      {removeTarget && (
        <ConfirmDeleteModal
          title="Delete document"
          message={`Delete "${removeTarget.title}"? This can't be undone.`}
          confirmLabel="Delete"
          onClose={() => setRemoveTarget(null)}
          onConfirm={async () => { await remove(removeTarget.id); setRemoveTarget(null); }}
        />
      )}
    </div>
  );
};

export default LiveKnowledgeLibrary;
