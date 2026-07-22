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
  resolved: { label: 'Resolved', cls: 'bg-dt-panel text-dt-support border-dt-border-strong' },
};
type Tab = 'needs_human' | 'mine' | 'open' | 'internal' | 'resolved';
const TABS: { key: Tab; label: string }[] = [
  { key: 'needs_human', label: 'Needs a human' },
  { key: 'mine', label: 'Mine' },
  { key: 'open', label: 'All open' },
  // Questions asked through the in-app assistant dock. Previously these
  // were fetched-out entirely, so a DE could be asked seven questions and
  // no human had any surface to see or take them over.
  { key: 'internal', label: 'Internal' },
  { key: 'resolved', label: 'Resolved' },
];
const CUSTOMER_CHANNELS = ['widget', 'hosted', 'portal', 'email'];

const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
// Relative time for the list — "now / 5m / 3h / 2d", falling back to a date
// beyond a week. Ops scan recency, not clock times.
const fmtRel = (iso: string | null) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export default function SupportInboxPage({ setPage: _setPage, embedded }: { setPage: (p: Page) => void; embedded?: boolean }) {
  const { authedUser } = useAuth();
  const myId = authedUser?.id ?? null;
  const [convs, setConvs] = useState<SupportConversation[]>([]);
  const [tab, setTab] = useState<Tab>('needs_human');
  const [selId, setSelId] = useState<string | null>(null);
  const [thread, setThread] = useState<SupportMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  // Keep the thread pinned to the newest message, and re-render every 30s
  // so the relative timestamps ("5m") stay honest while the tab sits open.
  const threadEndRef = React.useRef<HTMLDivElement | null>(null);
  const [, setClockTick] = useState(0);
  useEffect(() => { const iv = setInterval(() => setClockTick(t => t + 1), 30000); return () => clearInterval(iv); }, []);
  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [thread.length]);
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

  const isCustomer = (c: SupportConversation) => CUSTOMER_CHANNELS.includes(c.channel);
  const filtered = convs.filter(c => {
    // Escalations are channel-agnostic: if a DE says it needs a human, a
    // human must see it whether it came from a customer or the app dock.
    if (tab === 'needs_human') return c.status === 'needs_human';
    if (tab === 'internal') return !isCustomer(c);
    if (tab === 'mine') return c.owner_user_id === myId && c.status !== 'resolved';
    if (tab === 'resolved') return c.status === 'resolved' && isCustomer(c);
    return c.status !== 'resolved' && isCustomer(c); // open = customer tickets
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

  // Clear the reply box only AFTER the send succeeds — clearing first
  // loses the agent's typed message on a failed send.
  const doSend = () => {
    const t = reply.trim(); if (!t || !selId) return;
    void run(async () => { await sendHumanReply(selId, t); setReply(''); });
  };
  const doApprove = (id: string, edited?: string) => { setEditDraftId(null); void run(() => approveDraft(id, edited)); };

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden bg-dt-page">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(circle_at_20%_-40%,rgba(99,102,241,0.18),transparent_60%)]" />
      <div className={`relative px-6 flex items-start justify-between gap-4 ${embedded ? 'pt-3' : 'pt-6'}`}>
        {!embedded && <PageHeader title="Support inbox" subtitle="Live customer conversations — take over, approve a draft, reply, resolve." />}
        {embedded && <div />}
        <span className="mt-1 flex-shrink-0 inline-flex items-center gap-2 text-[11px] font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-full px-3 py-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.7)] animate-pulse" /> Live · Realtime
        </span>
      </div>
      {error && <div className="mx-6 mb-2 text-xs text-rose-400">{error}</div>}
      <div className="relative flex-1 flex overflow-hidden px-6 pb-6 gap-4">
        {/* Left: conversation list */}
        <div className="w-[340px] flex-shrink-0 flex flex-col rounded-2xl border border-white/10 bg-dt-panel backdrop-blur-xl overflow-hidden shadow-[0_10px_40px_-20px_rgba(0,0,0,0.8)]">
          <div className="flex items-center gap-1 p-2 border-b border-white/10 flex-wrap">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`relative text-xs px-2.5 py-1.5 rounded-lg transition-all ${tab === t.key ? 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-[0_4px_16px_-4px_rgba(99,102,241,0.7)]' : 'text-dt-support hover:text-dt-body hover:bg-white/5'}`}>
                {t.label}{t.key === 'needs_human' && counts.needs_human > 0 ? ` (${counts.needs_human})` : t.key === 'mine' && counts.mine > 0 ? ` (${counts.mine})` : ''}
                {t.key === 'needs_human' && counts.needs_human > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_8px_2px_rgba(251,191,36,0.6)] animate-pulse" />
                )}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? <p className="text-xs text-dt-muted p-4 text-center">Loading…</p>
              : filtered.length === 0 ? <p className="text-xs text-dt-muted p-6 text-center">Nothing here right now.</p>
              : filtered.map(c => {
                const meta = STATUS_META[c.status];
                const active = selId === c.id;
                return (
                  <button key={c.id} onClick={() => setSelId(c.id)}
                    className={`relative w-full text-left px-3 py-2.5 border-b border-white/5 transition-all ${active ? 'bg-gradient-to-r from-indigo-500/15 to-transparent' : 'hover:bg-white/[0.03]'}`}>
                    {active && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-indigo-400 to-violet-500" />}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-dt-body font-medium truncate flex-1">{c.subject || c.end_user_name || 'Conversation'}</span>
                      <span className="text-[10px] text-dt-muted flex-shrink-0">{fmtRel(c.last_message_at)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-dt-panel text-dt-support">{c.channel}</span>
                      {c.detected_language && c.detected_language !== 'English' && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-dt-panel text-dt-support">{c.detected_language}</span>}
                      {c.priority !== 'normal' && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-rose-500/15 text-rose-300">{c.priority}</span>}
                    </div>
                  </button>
                );
              })}
          </div>
        </div>

        {/* Right: thread */}
        <div className="flex-1 flex flex-col rounded-2xl border border-white/10 bg-dt-panel backdrop-blur-xl overflow-hidden min-w-0 shadow-[0_10px_40px_-20px_rgba(0,0,0,0.8)]">
          {!sel ? (
            <div className="flex-1 flex items-center justify-center text-sm text-dt-muted">Select a conversation.</div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-dt-border">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-white truncate">{sel.subject || 'Conversation'}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${STATUS_META[sel.status].cls}`}>{STATUS_META[sel.status].label}</span>
                  <div className="ml-auto flex items-center gap-2">
                    {sel.status !== 'human_owned' && sel.status !== 'resolved' && (
                      <button disabled={busy} onClick={() => void run(() => claimConversation(sel.id))} className="text-xs px-3 py-1.5 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 hover:brightness-110 text-white shadow-[0_4px_16px_-4px_rgba(99,102,241,0.7)] disabled:opacity-50 transition-all">Take over</button>
                    )}
                    {sel.status !== 'resolved'
                      ? <button disabled={busy} onClick={() => void run(() => setConversationState(sel.id, { status: 'resolved' }))} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:border-emerald-500 disabled:opacity-50">Resolve</button>
                      : <button disabled={busy} onClick={() => void run(() => setConversationState(sel.id, { status: 'human_owned' }))} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support disabled:opacity-50">Reopen</button>}
                  </div>
                </div>
                <p className="text-[11px] text-dt-muted mt-1">
                  {[sel.end_user_name, sel.account_external_ref ? `account ${sel.account_external_ref}` : null, sel.channel].filter(Boolean).join(' · ')}
                </p>
                {sel.handoff_summary && <p className="text-[11px] text-amber-300/80 mt-1.5 bg-amber-500/5 border border-amber-500/20 rounded-lg px-2.5 py-1.5">Handoff: {sel.handoff_summary}</p>}
              </div>

              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5">
                {thread.map(m => {
                  const isCustomer = m.role === 'user';
                  const isDraft = m.delivery === 'draft_pending';
                  return (
                    <div key={m.id} className={`max-w-[80%] ${isCustomer ? 'self-start' : 'self-end'}`}>
                      <div className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                        isCustomer ? 'bg-white/[0.06] text-dt-title border border-white/10 rounded-tl-sm'
                        : isDraft ? 'bg-amber-500/10 text-amber-100 border border-amber-500/40 rounded-tr-sm'
                        : 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white rounded-tr-sm shadow-[0_4px_18px_-6px_rgba(99,102,241,0.7)]'
                      }`}>
                        {/* Strip the internal [channel · …] prefix from the customer message for display */}
                        {isCustomer ? m.content.replace(/^\[[^\]]*\]\s*/, '') : m.content}
                      </div>
                      <div className={`text-[10px] text-dt-muted mt-0.5 ${isCustomer ? 'text-left' : 'text-right'}`}>
                        {isDraft ? 'Draft — awaiting your approval · ' : ''}{fmtTime(m.created_at)}
                      </div>
                      {isDraft && (
                        editDraftId === m.id ? (
                          <div className="mt-1.5">
                            <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3}
                              className="w-full text-sm bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-title focus:outline-none focus:border-indigo-500" />
                            <div className="flex gap-2 mt-1">
                              <button disabled={busy} onClick={() => doApprove(m.id, editText)} className="text-xs px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">Approve edited</button>
                              <button onClick={() => setEditDraftId(null)} className="text-xs px-3 py-1 rounded-lg border border-dt-border-strong text-dt-support">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2 mt-1 justify-end">
                            <button disabled={busy} onClick={() => doApprove(m.id)} className="text-xs px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">Approve &amp; send</button>
                            <button onClick={() => { setEditDraftId(m.id); setEditText(m.content); }} className="text-xs px-3 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-muted">Edit</button>
                          </div>
                        )
                      )}
                    </div>
                  );
                })}
                {pendingDraft && <p className="self-center text-[11px] text-dt-muted mt-1">The customer sees a holding message until you approve or reply.</p>}
                <div ref={threadEndRef} />
              </div>

              <div className="border-t border-dt-border p-3">
                <div className="flex items-end gap-2">
                  <textarea value={reply} onChange={e => setReply(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } }}
                    placeholder={sel.status === 'resolved' ? 'Reopen to reply…' : 'Reply to the customer…'}
                    disabled={sel.status === 'resolved' || busy} rows={1}
                    className="flex-1 resize-none max-h-32 text-sm bg-dt-page border border-dt-border-strong rounded-xl px-3 py-2 text-dt-title placeholder-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
                  <button disabled={!reply.trim() || busy || sel.status === 'resolved'} onClick={doSend}
                    className="flex-shrink-0 text-sm px-4 py-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 hover:brightness-110 text-white shadow-[0_4px_16px_-4px_rgba(99,102,241,0.7)] disabled:opacity-40 disabled:shadow-none transition-all">Send</button>
                </div>
                <p className="text-[10px] text-dt-muted mt-1.5">Your reply goes straight to the customer. This conversation becomes yours.</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
