// The conversational "Edit with AI" panel (Wave 1).
//
// One component behind every AI editing surface — a playbook, a digital
// employee, or the workspace dock — so a non-technical user describes what
// is wrong in plain words instead of hunting through forms.
//
// Two things make it trustworthy rather than magic:
//   • every change it applies shows up as an undo chip with a live
//     countdown, so nothing happens that cannot be walked back;
//   • anything it is NOT allowed to do comes back as a visible proposal
//     saying a person must approve it, instead of silently failing.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  sendSessionMessage, findLatestSession, loadSessionMessages, undoChange, hoursRemaining,
  type SubjectKind, type AppliedChange, type ProposedChange,
} from '../lib/aiSessionApi';
import { renderLite } from './chat/ChatCore';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  applied: AppliedChange[];
  proposed: ProposedChange[];
}

interface Props {
  subjectKind: SubjectKind;
  subjectId?: string | null;
  /** What the user is editing, e.g. 'Product Support DE'. Used in the header and the empty state. */
  subjectLabel: string;
  /** Shown as clickable starters when the conversation is empty. */
  examples?: string[];
  /** Called after any change is applied or undone, so the host page can refetch. */
  onChanged?: () => void;
  onClose?: () => void;
}

const DEFAULT_EXAMPLES: Record<SubjectKind, string[]> = {
  de: [
    'It escalates far too often — it should try harder before handing over.',
    'Its description is out of date, we no longer do onsite installs.',
    'Give it a friendlier name that customers will recognise.',
  ],
  playbook: [
    "The first step asks for an account number, but customers never have it — ask for their email instead.",
    'Add a step that checks the order status before offering a refund.',
    'This step asks for information we should not be collecting.',
  ],
  workspace: [
    'Write up our business hours so the team stops answering it by hand.',
    'Our refund policy changed to 60 days — update whatever mentions 30.',
    'What do my digital employees actually do right now?',
  ],
};

export default function AISessionPanel({
  subjectKind, subjectId, subjectLabel, examples, onChanged, onClose,
}: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undone, setUndone] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  // Resume the last conversation about this subject, so closing and
  // reopening the panel does not throw away context.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sid = await findLatestSession(subjectKind, subjectId);
        if (cancelled) return;
        if (sid) {
          const msgs = await loadSessionMessages(sid);
          if (cancelled) return;
          setSessionId(sid);
          setTurns(msgs.map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
            applied: m.meta?.applied ?? [],
            proposed: m.meta?.proposed ?? [],
          })));
        }
      } catch {
        // A failed resume is not worth blocking on — start fresh.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [subjectKind, subjectId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns, busy]);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setError(null);
    setTurns((t) => [...t, { role: 'user', content: message, applied: [], proposed: [] }]);
    setBusy(true);
    try {
      const res = await sendSessionMessage({ subjectKind, subjectId, message, sessionId });
      setSessionId(res.session_id);
      setReadOnly(!res.can_auto_apply);
      setTurns((t) => [...t, {
        role: 'assistant', content: res.reply, applied: res.applied, proposed: res.proposed,
      }]);
      if (res.applied.length) onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, sessionId, subjectKind, subjectId, onChanged]);

  const handleUndo = useCallback(async (changeId: string) => {
    setUndoing(changeId);
    setError(null);
    try {
      await undoChange(changeId);
      setUndone((s) => new Set(s).add(changeId));
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUndoing(null);
    }
  }, [onChanged]);

  const starters = examples ?? DEFAULT_EXAMPLES[subjectKind];

  return (
    <div className="flex flex-col h-full bg-dt-page border border-dt-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dt-border bg-dt-card">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">Edit with AI</div>
          <div className="text-xs text-dt-support truncate">{subjectLabel}</div>
        </div>
        {onClose && (
          <button onClick={onClose} aria-label="Close"
            className="text-dt-support hover:text-white text-lg leading-none px-2">×</button>
        )}
      </div>

      {readOnly && (
        <div className="px-4 py-2 text-xs text-amber-200 bg-amber-900/30 border-b border-amber-800/50">
          This is a remote support session, so changes can be suggested but not applied. Apply them from your own login.
        </div>
      )}

      {/* Thread */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        {loading ? (
          <div className="text-dt-muted text-xs">Loading…</div>
        ) : turns.length === 0 ? (
          <div className="space-y-3">
            <p className="text-dt-support">
              Describe what is wrong in your own words and I will change it. Anything I change, you can undo for 120 hours.
            </p>
            <div className="space-y-2">
              {starters.map((ex) => (
                <button key={ex} onClick={() => send(ex)}
                  className="block w-full text-left text-xs text-dt-support bg-dt-card hover:bg-dt-panel border border-dt-border rounded px-3 py-2">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'flex justify-end' : ''}>
              <div className={t.role === 'user'
                ? 'bg-dt-panel text-white rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap'
                : 'text-dt-body whitespace-pre-wrap max-w-[95%]'}>
                {t.role === 'assistant' ? renderLite(t.content) : t.content}

                {/* What it actually did — each undoable */}
                {t.applied.map((c) => {
                  const isUndone = undone.has(c.change_id);
                  const hrs = hoursRemaining(c.undoable_until);
                  return (
                    <div key={c.change_id}
                      className={`mt-2 flex items-start gap-2 text-xs rounded border px-3 py-2 ${
                        isUndone ? 'bg-dt-card border-dt-border text-dt-muted'
                                 : 'bg-teal-900/25 border-teal-800/60 text-teal-100'}`}>
                      <span className="mt-0.5">{isUndone ? '↩' : '✓'}</span>
                      <span className="flex-1">
                        {c.summary}
                        {!isUndone && (
                          <span className="block text-teal-300/60 mt-0.5">
                            Undo available for {hrs} more hour{hrs === 1 ? '' : 's'}
                          </span>
                        )}
                      </span>
                      {!isUndone && (
                        <button onClick={() => handleUndo(c.change_id)} disabled={undoing === c.change_id}
                          className="text-teal-300 hover:text-white underline disabled:opacity-50 shrink-0">
                          {undoing === c.change_id ? 'Undoing…' : 'Undo'}
                        </button>
                      )}
                    </div>
                  );
                })}

                {/* What it deliberately would not do on its own */}
                {t.proposed.map((p, j) => (
                  <div key={j} className="mt-2 text-xs rounded border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-amber-100">
                    <div className="font-medium">Needs a person to approve</div>
                    <div className="mt-1">{p.what}</div>
                    <div className="mt-1 text-amber-200/60">{p.why}</div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
        {busy && <div className="text-dt-muted text-xs">Working on it…</div>}
        {error && (
          <div className="text-xs rounded border border-red-800/60 bg-red-900/25 px-3 py-2 text-red-200">{error}</div>
        )}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-dt-border p-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); }
            }}
            rows={2}
            placeholder="Describe what you want changed…"
            className="flex-1 resize-none bg-dt-card border border-dt-border rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-slate-500"
          />
          <button
            onClick={() => void send(input)}
            disabled={busy || !input.trim()}
            className="self-end px-4 py-2 text-sm rounded bg-dt-accent-strong hover:bg-dt-accent-hover text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
