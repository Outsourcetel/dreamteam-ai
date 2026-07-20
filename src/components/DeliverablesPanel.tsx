// Deliverables — documents a DE produced for human review (EXEC 0.4).
// A renewal account review, an FP&A variance summary, a QBR prep pack: the
// "prepare it for a person" half of the job. Read-only; expand to read.
import React, { useCallback, useEffect, useState } from 'react';
import { listDeliverables, type Deliverable } from '../lib/commsApi';

export default function DeliverablesPanel({ deId }: { deId: string }) {
  const [items, setItems] = useState<Deliverable[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setItems(await listDeliverables(deId)); }
    catch (e) { setError((e as Error).message); }
  }, [deId]);
  useEffect(() => { void load(); }, [load]);

  if (items !== null && items.length === 0) return null; // nothing produced — stay quiet

  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Deliverables — documents produced for review</p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      {items === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-2">
          {items.map((d) => (
            <div key={d.id} className="bg-slate-900/50 rounded-lg px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">{d.kind}</span>
                <span className="text-sm text-slate-200 flex-1">{d.title}</span>
                <span className="text-[11px] text-slate-600">{new Date(d.created_at).toLocaleDateString()}</span>
                <button onClick={() => setOpen(open === d.id ? null : d.id)}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300 shrink-0">{open === d.id ? 'hide' : 'read'}</button>
              </div>
              {open === d.id && (
                <pre className="mt-2 text-xs text-slate-300 whitespace-pre-wrap font-sans bg-slate-950/50 rounded-lg p-3 max-h-80 overflow-y-auto">{d.content}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
