import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../../components/ui';
import { useAuth } from '../../../context/AuthContext';
import {
  listSupportConversations, getConversationThread, claimConversation, sendHumanReply,
  approveDraft, setConversationState, subscribeSupport,
  type SupportConversation, type SupportMessage,
} from '../../../lib/supportInboxApi';
import type { Page } from '../../../types';

// The support inbox — the human side of the unified conversation=ticket.
// Live (Supabase Realtime): new customer messages, DE drafts and escalations
// appear without a refresh. Humans take over, approve/edit the DE's drafts,
// reply, and resolve — all on the same thread the customer is watching.

const STATUS_META: Record<SupportConversation['status'], { label: string; cls: string }> = {
  needs_human: { label: 'Needs a human', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  ai_handling: { label: 'AI handling', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  human_owned: { label: 'You own it', cls: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' },
  resolved: { label: 'Resolved', cls: 'bg-slate-700 text-slate-300 border-slate-600' },
};
type Tab = 'needs_human' | 'mine' | 'open' | 'resolved';
const TABS: { key: Tab; label: string }[] = [
  { key: 'needs_human', label: 'Needs a human' },
  { key: 'mine', label: 'Mine' },
  { key: 'open', label: 'All open' },
  { key: 'resolved', label: 'Resolved' },
];

const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

export default function SupportInboxPage({ setPage: _setPage }: { setPage: (p: Page) => void }) {
  const { authedUser } = useAuth();
  const myId = authedUser?.id ?? null;
  const [convs, setConvs] = useState<SupportConversation[]>([]);
  const [tab, setTab] = useState<Tab>('needs_human');
  const [selId, setSelId] = useState<string | null>(null);
  const [thread, setThread] = useState<SupportMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [editDraftId, setEditDraftId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const selRef = useRef<string | null>(null);
  selRef.current = selId;

  const loadConvs = useCallback(async () => {
    try { setConvs(await listSupportConversations('all')); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    try { setThread(await getConversationThread(id)); } catch { /* keep old */ }
  }, []);

  useEffect(() => { void loadConvs(); }, [loadConvs]);

  // Live: any conversation/message change → refresh the list and the open thread.
  useEffect(() => {
    const unsub = subscribeSupport(() => {
      void loadConvs();
      if (selRef.current) void loadThread(selRef.current);
    });
    return unsub;
  }, [loadConvs, loadThread]);

  useEffect(() => { if (selId) void loadThread(selId); }, [selId, loadThread]);

  const filtered = convs.filter(c => {
    if (tab === 'needs_human') return c.status === 'needs_human';
    if (tab === 'mine') return c.owner_user_id === myId && c.status !== 'resolved';
    if (tab === 'resolved') return c.status === 'resolved';
    return c.status !== 'resolved'; // open
  });
  const sel = convs.find(c => c.id === selId) ?? null;
  const pendingDraft = thread.find(m => m.delivery === 'draft_pending');
  const counts = {
    needs_human: convs.filter(c => c.status === 'needs_human').length,
    mine: convs.filter(c => c.owner_user_id === myId && c.status !== 'resolved').length,
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); if (selId) await loadThread(selId); await loadConvs(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const doSend = () => { const t = reply.trim(); if (!t || !selId) return; setReply(''); void run(() => sendHumanReply(selId, t)); };
  const doApprove = (id: string, edited?: string) => { setEditDraftId(null); void run(() => approveDraft(id, edited)); };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-900">
      <div className="px-6 pt-6">
        <PageHeader title="Support inbox" subtitle="Live customer conversations — take over, approve a draft, reply, resolve." />
      </div>
      {error && <div className="mx-6 mb-2 text-xs text-rose-400">{error}</div>}
      <div className="flex-1 flex overflow-hidden px-6 pb-6 gap-4">
        {/* Left: conversation list */}
        <div className="w-[340px] flex-shrink-0 flex flex-col rounded-xl border border-slate-700 bg-slate-800/40 overflow-hidden">
          <div className="flex items-center gap-1 p-2 border-b border-slate-700 flex-wrap">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${tab === t.key ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                {t.label}{t.key === 'needs_human' && counts.needs_human > 0 ? ` (${counts.needs_human})` : t.key === 'mine' && counts.mine > 0 ? ` (${counts.mine})` : ''}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? <p className="text-xs text-slate-500 p-4 text-center">Loading…</p>
              : filtered.length === 0 ? <p className="text-xs text-slate-500 p-6 text-center">Nothing here right now.</p>
              : filtered.map(c => {
                const meta = STATUS_META[c.status];
                return (
                  <button key={c.id} onClick={() => setSelId(c.id)}
                    className={`w-full text-left px-3 py-2.5 border-b border-slate-800 hover:bg-slate-800/70 transition-colors ${selId === c.id ? 'bg-slate-800' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-200 font-medium truncate flex-1">{c.subject || c.end_user_name || 'Conversation'}</span>
                      <span className="text-[10px] text-slate-500 flex-shrink-0">{fmtTime(c.last_message_at)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400">{c.channel}</span>
                      {c.detected_language && c.detected_language !== 'English' && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400">{c.detected_language}</span>}
                      {c.priority !== 'normal' && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-rose-500/15 text-rose-300">{c.priority}</span>}
                    </div>
                  </button>
                );
              })}
          </div>
        </div>

        {/* Right: thread */}
        <div className="flex-1 flex flex-col rounded-xl border border-slate-700 bg-slate-800/40 overflow-hidden min-w-0">
          {!sel ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-500">Select a conversation.</div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-slate-700">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-white truncate">{sel.subject || 'Conversation'}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${STATUS_META[sel.status].cls}`}>{STATUS_META[sel.status].label}</span>
                  <div className="ml-auto flex items-center gap-2">
                    {sel.status !== 'human_owned' && sel.status !== 'resolved' && (
                      <button disabled={busy} onClick={() => void run(() => claimConversation(sel.id))} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">Take over</button>
                    )}
                    {sel.status !== 'resolved'
                      ? <button disabled={busy} onClick={() => void run(() => setConversationState(sel.id, { status: 'resolved' }))} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:border-emerald-500 disabled:opacity-50">Resolve</button>
                      : <button disabled={busy} onClick={() => void run(() => setConversationState(sel.id, { status: 'human_owned' }))} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 disabled:opacity-50">Reopen</button>}
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  {[sel.end_user_name, sel.account_external_ref ? `account ${sel.account_external_ref}` : null, sel.channel].filter(Boolean).join(' · ')}
                </p>
                {sel.handoff_summary && <p className="text-[11px] text-amber-300/80 mt-1.5 bg-amber-500/5 border border-amber-500/20 rounded-lg px-2.5 py-1.5">Handoff: {sel.handoff_summary}</p>}
              </div>

              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5">
                {thread.filter(m => m.delivery !== 'blocked' || true).map(m => {
                  const isCustomer = m.role === 'user';
                  const isDraft = m.delivery === 'draft_pending';
                  return (
                    <div key={m.id} className={`max-w-[80%] ${isCustomer ? 'self-start' : 'self-end'}`}>
                      <div className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                        isCustomer ? 'bg-slate-700 text-slate-100 rounded-tl-sm'
                        : isDraft ? 'bg-amber-500/10 text-amber-100 border border-amber-500/40 rounded-tr-sm'
                        : 'bg-indigo-600 text-white rounded-tr-sm'
                      }`}>
                        {/* Strip the internal [channel · …] prefix from the customer message for display */}
                        {isCustomer ? m.content.replace(/^\[[^\]]*\]\s*/, '') : m.content}
                      </div>
                      <div className={`text-[10px] text-slate-500 mt-0.5 ${isCustomer ? 'text-left' : 'text-right'}`}>
                        {isDraft ? 'Draft — awaiting your approval · ' : ''}{fmtTime(m.created_at)}
                      </div>
                      {isDraft && (
                        editDraftId === m.id ? (
                          <div className="mt-1.5">
                            <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3}
                              className="w-full text-sm bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500" />
                            <div className="flex gap-2 mt-1">
                              <button disabled={busy} onClick={() => doApprove(m.id, editText)} className="text-xs px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">Approve edited</button>
                              <button onClick={() => setEditDraftId(null)} className="text-xs px-3 py-1 rounded-lg border border-slate-600 text-slate-400">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2 mt-1 justify-end">
                            <button disabled={busy} onClick={() => doApprove(m.id)} className="text-xs px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">Approve &amp; send</button>
                            <button onClick={() => { setEditDraftId(m.id); setEditText(m.content); }} className="text-xs px-3 py-1 rounded-lg border border-slate-600 text-slate-300 hover:border-slate-400">Edit</button>
                          </div>
                        )
                      )}
                    </div>
                  );
                })}
                {pendingDraft && <p className="self-center text-[11px] text-slate-500 mt-1">The customer sees a holding message until you approve or reply.</p>}
              </div>

              <div className="border-t border-slate-700 p-3">
                <div className="flex items-end gap-2">
                  <textarea value={reply} onChange={e => setReply(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } }}
                    placeholder={sel.status === 'resolved' ? 'Reopen to reply…' : 'Reply to the customer…'}
                    disabled={sel.status === 'resolved' || busy} rows={1}
                    className="flex-1 resize-none max-h-32 text-sm bg-slate-900 border border-slate-600 rounded-xl px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
                  <button disabled={!reply.trim() || busy || sel.status === 'resolved'} onClick={doSend}
                    className="flex-shrink-0 text-sm px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">Send</button>
                </div>
                <p className="text-[10px] text-slate-500 mt-1.5">Your reply goes straight to the customer. This conversation becomes yours.</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
