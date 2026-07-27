/**
 * PlatformShelfPanel — "What your Workspace Assistant knows".
 *
 * DreamTeam's own product documentation is stored ONCE, outside every tenant,
 * and read by the Workspace Assistant in every workspace (migs 334/336). This
 * is the customer's window onto it.
 *
 * ── Two design rules, both load-bearing ─────────────────────────────────────
 * 1. COLLAPSED BY DEFAULT, and never mixed into the tenant's own library. Their
 *    document counts, quality scores, gap detection, freshness and re-embed
 *    queues are all computed from `knowledge_docs` — a table these rows are not
 *    in — so nothing here can move a single number on their pages. Rendering it
 *    as one quiet row rather than a section keeps that true visually as well as
 *    technically.
 * 2. FRAMED AS AN AUDIT, not as filing. The heading is deliberately not
 *    "DreamTeam docs": it is what the ASSISTANT knows. That turns someone
 *    else's content in my library into an answer to "why did it tell me that?",
 *    which is the governance posture this product sells.
 *
 * Read-only by construction, not by convention: the shelf tables carry deny-all
 * policies and no client grants, and the only two functions a browser can call
 * are SELECTs.
 */
import React, { useEffect, useState } from 'react'
import {
  listPlatformShelf, getPlatformShelfDoc, getPlatformShelfStatus,
  type ShelfDoc, type ShelfStatus,
} from '../lib/knowledgeApi'

export default function PlatformShelfPanel({ tenantQuery }: { tenantQuery?: string }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<ShelfStatus | null>(null)
  const [docs, setDocs] = useState<ShelfDoc[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState<{ title: string; content: string; path: string | null } | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  // Status only, on mount — one cheap call so the collapsed row can state a
  // real number instead of a promise.
  useEffect(() => {
    getPlatformShelfStatus()
      .then(s => setStatus(s))
      .catch(() => setUnavailable(true))
  }, [])

  // Contents load only when opened. A customer who never expands this pays
  // nothing for it.
  useEffect(() => {
    if (!open) return
    setLoading(true)
    listPlatformShelf(q, 200)
      .then(setDocs)
      .catch(() => setUnavailable(true))
      .finally(() => setLoading(false))
  }, [open, q])

  // Cross-over: if the customer's own library search also matches shelf docs,
  // say so in one line. Discoverable on demand, never mixed into their results.
  const [crossover, setCrossover] = useState(0)
  useEffect(() => {
    const term = (tenantQuery ?? '').trim()
    if (!term || open) { setCrossover(0); return }
    let cancelled = false
    listPlatformShelf(term, 50)
      .then(r => { if (!cancelled) setCrossover(r.length) })
      .catch(() => { if (!cancelled) setCrossover(0) })
    return () => { cancelled = true }
  }, [tenantQuery, open])

  if (unavailable || !status || status.paused || status.docs_published === 0) return null

  const openDoc = async (id: string) => {
    try {
      const d = await getPlatformShelfDoc(id)
      if (d) setReading({ title: d.title, content: d.content, path: d.source_doc_path })
    } catch { /* the list stays usable */ }
  }

  return (
    <>
      {/* The cross-over line — shown only while the tenant is searching their
          own library and the shelf also has hits. */}
      {crossover > 0 && (
        <button onClick={() => { setQ(tenantQuery ?? ''); setOpen(true) }}
          className="w-full text-left text-[11px] text-dt-muted hover:text-dt-body mb-2 px-1">
          Also {crossover} {crossover === 1 ? 'match' : 'matches'} in the DreamTeam product guide →
        </button>
      )}

      <div className="rounded-2xl border border-dt-border bg-dt-page/40 overflow-hidden mt-6">
        {/* One quiet row. Not a tab, not a section header. */}
        <button
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-dt-card/40 transition-colors">
          <span className={`text-dt-muted text-[10px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
          <span className="text-xs text-dt-body">DreamTeam product guide</span>
          <span className="text-[11px] text-dt-muted">· {status.docs_published} articles</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-card text-dt-muted border border-dt-border">read-only</span>
          <span className="text-[11px] text-dt-muted ml-auto hidden sm:inline">maintained by DreamTeam</span>
        </button>

        {open && (
          <div className="border-t border-dt-border p-4">
            <div className="mb-3">
              <h4 className="text-sm font-semibold text-white">What your Workspace Assistant knows</h4>
              <p className="text-[11px] text-dt-muted mt-0.5 max-w-2xl">
                Your Workspace Assistant is taught from these {status.docs_published} articles about how
                DreamTeam works. They are not part of your knowledge base — they do not appear in your
                library, are not counted in your document totals, and do not affect your quality or gap
                scores. They are here so you can see exactly what your assistant was told.
              </p>
            </div>

            <input
              type="text" value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search the product guide…"
              className="w-full mb-3 bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />

            {loading && <p className="text-[11px] text-dt-muted">Loading…</p>}
            {!loading && docs.length === 0 && (
              <p className="text-[11px] text-dt-muted">No articles match that.</p>
            )}

            <div className="space-y-1 max-h-[28rem] overflow-y-auto">
              {docs.map(d => (
                <button key={d.id} onClick={() => void openDoc(d.id)}
                  className="w-full text-left rounded-lg border border-dt-border bg-dt-card px-3 py-2 hover:border-indigo-500/60 transition-colors">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-dt-body">{d.title}</span>
                    {/* Every row says whose it is. */}
                    <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-500/10 text-indigo-300">provided</span>
                    {d.cited_30d > 0 && (
                      <span className="text-[10px] text-dt-muted ml-auto">
                        used {d.cited_30d}× in 30d
                      </span>
                    )}
                  </div>
                  {d.source_doc_path && (
                    <div className="text-[10px] text-dt-muted font-mono truncate mt-0.5">{d.source_doc_path}</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Reader. Read-only: no edit, no delete, no re-embed anywhere. */}
      {reading && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
             onClick={() => setReading(null)}>
          <div className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-2xl border border-dt-border bg-dt-card p-5"
               onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-1">
              <h3 className="text-base font-semibold text-white">{reading.title}</h3>
              <button onClick={() => setReading(null)} className="text-dt-muted hover:text-white text-sm">✕</button>
            </div>
            <div className="text-[10px] text-dt-muted mb-3">
              Provided by DreamTeam · read-only{reading.path ? ` · ${reading.path}` : ''}
            </div>
            <pre className="text-xs text-dt-body whitespace-pre-wrap font-sans leading-relaxed">{reading.content}</pre>
          </div>
        </div>
      )}
    </>
  )
}
