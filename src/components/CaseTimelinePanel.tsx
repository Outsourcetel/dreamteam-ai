// "Waiting on" — the cases a Digital Employee has paused mid-motion (EXEC 0.2).
//
// When a DE runs a multi-week motion (a renewal, a dunning ladder) it pauses
// each case between steps — waiting for a date or a reply — and resumes when the
// continuation is due. This shows what it's parked on, so a human can see the
// employee is mid-motion (not idle) and step in if needed.
import React, { useCallback, useEffect, useState } from 'react';
import {
  listPendingContinuations, cancelContinuation, whenLabel, type CaseContinuation,
} from '../lib/caseTimelineApi';

export default function CaseTimelinePanel({ deId }: { deId: string }) {
  const [items, setItems] = useState<CaseContinuation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setItems(await listPendingContinuations(deId)); }
    catch (e) { setError((e as Error).message); }
  }, [deId]);
  useEffect(() => { void load(); }, [load]);

  const cancel = async (id: string) => {
    setBusy(true); setError(null);
    try { await cancelContinuation(id); await load(); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  if (items !== null && items.length === 0) return null; // nothing parked — stay quiet

  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Waiting on — cases paused mid-motion</p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      {items === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-2">
          {items.map((c) => (
            <div key={c.id} className="bg-slate-900/50 rounded-lg px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
                  {c.awaiting_ref ? 'awaiting reply' : c.kind === 'wait' ? 'waiting' : 'follow-up'}
                </span>
                <span className="text-sm text-slate-200 flex-1">{c.objective_title}</span>
                <span className="text-[11px] text-slate-500">{whenLabel(c.fire_at)}</span>
                <button onClick={() => void cancel(c.id)} disabled={busy}
                  className="text-[10px] text-slate-600 hover:text-rose-300 shrink-0">cancel</button>
              </div>
              {c.instruction && <p className="text-xs text-slate-400 mt-1">Then: {c.instruction}</p>}
              <p className="text-[10px] text-slate-600 mt-0.5">Resumes {new Date(c.fire_at).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
