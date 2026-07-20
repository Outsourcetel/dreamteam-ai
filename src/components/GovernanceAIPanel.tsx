// The conversational "Set up with AI" panel for governance (Part 2).
//
// A non-technical user describes a limit in plain words ("don't let it promise
// refunds we can't honour") and the assistant turns it into a guardrail
// PROPOSAL. It cannot switch a guardrail on itself — every proposal it records
// appears just below, in the live guardrails panel, for a person to approve or
// dismiss. This panel drives the conversation; onProposed() tells the host to
// reload the pending list.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  sendGovernanceMessage, findLatestGovernanceSession,
} from '../lib/governanceAiApi';
import type { GuardrailScope } from '../lib/guardrailApi';
import { loadSessionMessages } from '../lib/aiSessionApi';
import { renderLite } from './chat/ChatCore';

interface Turn { role: 'user' | 'assistant'; content: string; proposed: Array<{ what: string; why: string }> }

interface Props {
  scope: GuardrailScope;
  scopeRef: string | null;
  entityLabel: string;
  /** Called after any turn that recorded a proposal, so the host reloads the pending list. */
  onProposed?: () => void;
  onClose?: () => void;
}

const EXAMPLES: Record<GuardrailScope, string[]> = {
  workspace: [
    'Never let anyone promise a refund we might not honour.',
    'Anything over $500 should need a person to sign off.',
    "Don't discuss our competitors by name.",
  ],
  employee: [
    'This one should hand over to a human the moment a customer sounds angry.',
    "Don't let it give any legal or tax advice.",
    'Cap any discount it offers at 15%.',
  ],
  department: [
    'Nobody in this team should quote delivery dates we can\'t guarantee.',
    'Require sign-off on anything over $1,000 here.',
  ],
  playbook: [
    'This process should never ask for a card number.',
    'Stop and get approval before issuing any credit.',
  ],
};

export default function GovernanceAIPanel({ scope, scopeRef, entityLabel, onProposed, onClose }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sid = await findLatestGovernanceSession(scope, scopeRef);
        if (cancelled || !sid) return;
        const msgs = await loadSessionMessages(sid);
        if (cancelled) return;
        setSessionId(sid);
        setTurns(msgs.map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
          proposed: m.meta?.proposed ?? [],
        })));
      } catch { /* start fresh on a failed resume */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [scope, scopeRef]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns, busy]);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput(''); setError(null);
    setTurns((t) => [...t, { role: 'user', content: message, proposed: [] }]);
    setBusy(true);
    try {
      const res = await sendGovernanceMessage({ scope, scopeRef, message, sessionId });
      setSessionId(res.session_id);
      setTurns((t) => [...t, { role: 'assistant', content: res.reply, proposed: res.proposed }]);
      if (res.proposed.length) onProposed?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, scope, scopeRef, sessionId, onProposed]);

  const starters = EXAMPLES[scope] ?? EXAMPLES.workspace;

  return (
    <div className="flex flex-col h-[28rem] bg-slate-900 border border-slate-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800/60">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">Set up guardrails with AI</div>
          <div className="text-xs text-slate-400 truncate">for {entityLabel}</div>
        </div>
        {onClose && <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white text-lg leading-none px-2">×</button>}
      </div>

      <div className="px-4 py-2 text-[11px] text-amber-200 bg-amber-900/25 border-b border-amber-800/40">
        The assistant proposes changes — it can't switch a guardrail on or off. You approve each one below.
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        {loading ? (
          <div className="text-slate-500 text-xs">Loading…</div>
        ) : turns.length === 0 ? (
          <div className="space-y-3">
            <p className="text-slate-400">Describe a limit in your own words. I'll turn it into a guardrail for you to approve.</p>
            <div className="space-y-2">
              {starters.map((ex) => (
                <button key={ex} onClick={() => send(ex)}
                  className="block w-full text-left text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded px-3 py-2">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'flex justify-end' : ''}>
              <div className={t.role === 'user'
                ? 'bg-slate-700 text-white rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap'
                : 'text-slate-200 whitespace-pre-wrap max-w-[95%]'}>
                {t.role === 'assistant' ? renderLite(t.content) : t.content}
                {t.proposed.map((p, j) => (
                  <div key={j} className="mt-2 text-xs rounded border border-indigo-800/60 bg-indigo-900/20 px-3 py-2 text-indigo-100">
                    <div className="font-medium">Proposed — approve it below</div>
                    <div className="mt-1">{p.what}</div>
                    {p.why && <div className="mt-1 text-indigo-200/60">{p.why}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
        {busy && <div className="text-slate-500 text-xs">Working on it…</div>}
        {error && <div className="text-xs rounded border border-red-800/60 bg-red-900/25 px-3 py-2 text-red-200">{error}</div>}
        <div ref={endRef} />
      </div>

      <div className="border-t border-slate-700 p-3">
        <div className="flex gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            rows={2} placeholder="Describe a limit you want in place…"
            className="flex-1 resize-none bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-slate-500" />
          <button onClick={() => void send(input)} disabled={busy || !input.trim()}
            className="self-end px-4 py-2 text-sm rounded bg-slate-100 text-slate-900 font-medium hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
