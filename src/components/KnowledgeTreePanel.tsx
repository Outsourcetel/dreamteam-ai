import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Chip, EmptyState, Banner, Modal, Field, INPUT_CLS } from '../design/primitives';
import {
  listKnowledgeTree, createKnowledgeSpace, createChildCollection,
  renameKnowledgeCollection, archiveKnowledgeCollection, knowledgeUnfiledCount,
  type KnowledgeTreeNode,
} from '../lib/knowledgeApi';

/**
 * Selection sentinel for "documents filed in no collection". Not a real
 * collection id, because these documents are defined by belonging to none.
 * The parent maps it to searchKnowledgeDocs({ unfiled: true }).
 */
export const UNFILED_ID = '__unfiled__';

// ============================================================
// The Library's left panel — where knowledge lives.
//
// Selecting a node filters the document list SERVER-SIDE (search_knowledge_docs
// takes p_collection_id), so this scales past 100k documents without the
// browser ever holding the corpus.
//
// Counts come off the ancestry closure, so a Space shows everything BENEATH it,
// not just what is filed directly on it — clicking a folder and seeing "3" when
// it contains 300 is the kind of small lie that stops people trusting a tree.
//
// Actions are shown from my_level, which the server computes per node. A
// control that appears and then errors is worse than one that was never there.
// ============================================================

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Bumped by the parent after an ingest/move so counts refresh. */
  refreshKey?: number;
}

export default function KnowledgeTreePanel({ selectedId, onSelect, refreshKey }: Props) {
  const [nodes, setNodes] = useState<KnowledgeTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ mode: 'space' | 'child' | 'rename'; node?: KnowledgeTreeNode } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Documents belonging to no collection. Counted in the workspace total and
  // reachable from nothing, which is why the tree's arithmetic disagreed with
  // itself — 50 + 0 + 0 + 0 under a heading that said 76.
  const [unfiled, setUnfiled] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, u] = await Promise.all([listKnowledgeTree(false), knowledgeUnfiledCount()]);
      setNodes(t);
      setUnfiled(u);
      setError(null);
      // Open every Space on first load: a collapsed tree of empty folders looks
      // like nothing is there.
      setExpanded(prev => (prev.size === 0 ? new Set(t.filter(n => n.is_space).map(n => n.id)) : prev));
    } catch (e) {
      setError((e as Error)?.message || 'Could not load your knowledge structure.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, KnowledgeTreeNode[]>();
    for (const n of nodes) {
      const k = n.parent_id;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(n);
    }
    return m;
  }, [nodes]);

  // The workspace total must equal what the tree can actually reach: every
  // space's closure count PLUS the documents filed nowhere. Previously this
  // summed only the spaces while the heading claimed to be everything, so a
  // library with unfiled documents displayed a total no row could account for.
  const spaceDocs = useMemo(
    () => nodes.filter(n => n.is_space).reduce((a, n) => a + Number(n.doc_count || 0), 0),
    [nodes],
  );
  const totalDocs = spaceDocs + unfiled;

  const toggle = (id: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const canCreateSpace = nodes.some(n => n.my_level >= 5) || nodes.length === 0;

  const renderNode = (n: KnowledgeTreeNode, depth: number): React.ReactNode => {
    const kids = childrenOf.get(n.id) ?? [];
    const isOpen = expanded.has(n.id);
    const selected = selectedId === n.id;
    const canManage = n.my_level >= 5;

    return (
      <li key={n.id}>
        <div
          className={`group flex items-center gap-1 rounded-lg pr-1 transition-colors ${
            selected ? 'bg-dt-accent-soft' : 'hover:bg-dt-panel'}`}
          style={{ paddingLeft: `${depth * 12}px` }}
        >
          <button
            onClick={() => kids.length > 0 && toggle(n.id)}
            className={`w-4 shrink-0 text-[10px] ${kids.length ? 'text-dt-support hover:text-dt-body' : 'text-transparent'}`}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            tabIndex={kids.length ? 0 : -1}
          >
            {kids.length ? (isOpen ? '▾' : '▸') : '·'}
          </button>

          <button
            onClick={() => onSelect(selected ? null : n.id)}
            className="flex-1 min-w-0 text-left py-1.5"
            aria-pressed={selected}
          >
            <span className={`text-sm truncate ${selected ? 'text-dt-accent-text font-medium' : 'text-dt-body'}`}>
              {n.name}
            </span>
            {n.is_restricted && <span className="ml-1.5 text-[10px] text-dt-accent-text" title="Restricted space">●</span>}
          </button>

          <span className="text-[11px] text-dt-muted tabular-nums shrink-0">{n.doc_count}</span>

          {canManage && (
            <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center">
              {n.depth < 3 && (
                <button onClick={() => setDialog({ mode: 'child', node: n })}
                  title="Add a collection inside" className="px-1 text-dt-faint hover:text-dt-body text-xs">+</button>
              )}
              <button onClick={() => setDialog({ mode: 'rename', node: n })}
                title="Rename" className="px-1 text-dt-faint hover:text-dt-body text-xs">✎</button>
              <button
                title="Archive"
                className="px-1 text-dt-faint hover:text-dt-danger text-xs"
                onClick={async () => {
                  try {
                    const r = await archiveKnowledgeCollection(n.id, true);
                    // Archiving is not deleting, and people assume it is.
                    setNotice(
                      r.documents_kept > 0
                        ? `"${n.name}" archived. Its ${r.documents_kept} document${r.documents_kept === 1 ? '' : 's'} are kept and still searchable.`
                        : `"${n.name}" archived.`);
                    if (selectedId === n.id) onSelect(null);
                    await load();
                  } catch (e) { setNotice((e as Error)?.message || 'Could not archive that.'); }
                }}
              >×</button>
            </span>
          )}
        </div>

        {isOpen && kids.length > 0 && (
          <ul>{kids.map(k => renderNode(k, depth + 1))}</ul>
        )}
      </li>
    );
  };

  const spaces = childrenOf.get(null) ?? [];

  return (
    <div className="rounded-xl border border-dt-border bg-dt-card">
      <div className="px-4 py-3 border-b border-dt-border flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-dt-title">Where knowledge lives</h3>
        {canCreateSpace && (
          <Button kind="ghost" size="sm" onClick={() => setDialog({ mode: 'space' })}>+ Space</Button>
        )}
      </div>

      <div className="px-2 py-2">
        {notice && <Banner tone="info" className="mb-2">{notice}</Banner>}

        {loading ? (
          <div className="space-y-1.5 px-2 py-1" aria-busy="true">
            {[0, 1, 2, 3].map(i => <div key={i} className="h-7 rounded bg-dt-panel animate-pulse" />)}
          </div>
        ) : error ? (
          <Banner tone="danger">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs">{error}</span>
              <Button size="sm" onClick={() => void load()}>Retry</Button>
            </div>
          </Banner>
        ) : spaces.length === 0 ? (
          <div className="px-2 py-3">
            <EmptyState headline="No spaces yet">
              A space is a shelf — Support, HR, Finance. Create one, then file documents into it
              so people and employees can find them by topic.
            </EmptyState>
          </div>
        ) : (
          <>
            <button
              onClick={() => onSelect(null)}
              className={`w-full text-left rounded-lg px-3 py-1.5 mb-1 transition-colors ${
                selectedId === null ? 'bg-dt-accent-soft text-dt-accent-text font-medium' : 'text-dt-body hover:bg-dt-panel'}`}
            >
              <span className="text-sm">All knowledge</span>
              <span className="float-right text-[11px] text-dt-muted tabular-nums">{totalDocs}</span>
            </button>
            <ul>{spaces.map(s => renderNode(s, 0))}</ul>

            {/* Documents belonging to no space. Shown ONLY when there are some —
                an empty row here would be the same clutter as the empty folders
                it sits beneath. Amber because it is a state to resolve, not a
                place to file things. */}
            {unfiled > 0 && (
              <button
                onClick={() => onSelect(selectedId === UNFILED_ID ? null : UNFILED_ID)}
                aria-pressed={selectedId === UNFILED_ID}
                className={`w-full text-left rounded-lg px-3 py-1.5 mt-1 transition-colors ${
                  selectedId === UNFILED_ID
                    ? 'bg-dt-warn-soft text-dt-warn font-medium'
                    : 'text-dt-support hover:bg-dt-panel'}`}
                title="These documents are searchable, but they are not in any space"
              >
                <span className="text-sm">Not in a space</span>
                <span className="float-right text-[11px] tabular-nums text-amber-400/80">{unfiled}</span>
              </button>
            )}
          </>
        )}
      </div>

      {dialog && (
        <TreeDialog
          mode={dialog.mode}
          node={dialog.node}
          onClose={() => setDialog(null)}
          onDone={async (msg) => { setDialog(null); setNotice(msg); await load(); }}
        />
      )}
    </div>
  );
}

function TreeDialog({ mode, node, onClose, onDone }: {
  mode: 'space' | 'child' | 'rename';
  node?: KnowledgeTreeNode;
  onClose: () => void;
  onDone: (msg: string) => Promise<void>;
}) {
  const [name, setName] = useState(mode === 'rename' ? (node?.name ?? '') : '');
  const [desc, setDesc] = useState(mode === 'rename' ? (node?.description ?? '') : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const title = mode === 'space' ? 'New space'
    : mode === 'child' ? `New collection in "${node?.name}"`
    : `Rename "${node?.name}"`;

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true); setErr(null);
    try {
      if (mode === 'space') {
        await createKnowledgeSpace(name.trim(), desc.trim() || null);
        await onDone(`Created the space "${name.trim()}".`);
      } else if (mode === 'child' && node) {
        await createChildCollection(node.id, name.trim(), desc.trim() || null);
        await onDone(`Added "${name.trim()}" inside ${node.name}.`);
      } else if (node) {
        await renameKnowledgeCollection(node.id, name.trim(), desc.trim() || null);
        await onDone('Renamed.');
      }
    } catch (e) {
      setErr((e as Error)?.message || 'Could not save that.');
    } finally { setSaving(false); }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        {err && <Banner tone="danger">{err}</Banner>}
        <Field label="Name">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} className={INPUT_CLS}
            placeholder={mode === 'space' ? 'Customer Support' : 'Refunds'}
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) void submit(); }} />
        </Field>
        <Field label="Description" hint="Optional.">
          <input value={desc} onChange={e => setDesc(e.target.value)} className={INPUT_CLS} />
        </Field>
        {mode === 'child' && (
          <p className="text-xs text-dt-support">
            Collections can be nested three levels deep — a space, a collection inside it,
            and one more level under that.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={saving || !name.trim()} onClick={() => void submit()}>
            {saving ? 'Saving…' : mode === 'rename' ? 'Rename' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Lifecycle chip for the document list — mig 346's state made visible. */
export function LifecycleChip({ status, verification }: { status: string; verification?: string }) {
  if (verification === 'needs_verification') return <Chip tone="warn">Needs review</Chip>;
  switch (status) {
    case 'draft':     return <Chip tone="neutral">Draft</Chip>;
    case 'in_review': return <Chip tone="info">In review</Chip>;
    case 'archived':  return <Chip tone="neutral">Archived</Chip>;
    default:          return <Chip tone="ok">Published</Chip>;
  }
}
