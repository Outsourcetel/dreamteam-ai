import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../../components/ui';
import { Button, Chip, Banner, FilterBar, INPUT_CLS, SELECT_CLS } from '../../../design/primitives';

import { TOPIC_LABEL } from './supportTopics';
import { isParked, parkedLabel, parkPresets } from '../../../lib/supportPark';
import SupportHistoryReport from './SupportHistoryReport';
import { listDigitalEmployees } from '../../../lib/digitalEmployeesApi';
import { supabase } from '../../../supabase';
import { useAuth } from '../../../context/AuthContext';
import {
  listSupportConversations, getConversationThread, claimConversation, sendHumanReply,
  approveDraft, setConversationState, subscribeSupport,
  sendEmailReply, approveEmailDraft, handoffBackToDe, getDeDisplayName,
  listConversationChecks, type ConversationCheck,
  parkConversation, unparkConversation,
  type SupportConversation, type SupportMessage,
} from '../../../lib/supportInboxApi';
import type { Page } from '../../../types';
import { timeAgoCompact, fmtDateTime } from '../../../lib/dateFormat';

// The support inbox — the human side of the unified conversation=ticket.
// Live (Supabase Realtime): new customer messages, DE drafts and escalations
// appear without a refresh. Humans take over, approve/edit the DE's drafts,
// reply, and resolve — all on the same thread the customer is watching.

// One 12px chip carrying the status, in the shared tone vocabulary. Was four
// separate text-[10px] pills per row — status, channel, language, priority,
// verified — competing for the same eye at a size the design system does not
// allow anywhere. Everything but the status moves to a plain-text line.
const STATUS_META: Record<SupportConversation['status'], { label: string; tone: 'ok' | 'warn' | 'info' | 'neutral' }> = {
  needs_human: { label: 'Needs you', tone: 'warn' },
  ai_handling: { label: 'Being handled', tone: 'ok' },
  human_owned: { label: 'Yours', tone: 'info' },
  resolved: { label: 'Closed', tone: 'neutral' },
};
type Tab = 'needs_human' | 'mine' | 'open' | 'resolved';
const TABS: { key: Tab; label: string }[] = [
  { key: 'needs_human', label: 'Needs you' },
  { key: 'mine', label: 'Mine' },
  { key: 'open', label: 'Open now' },
  { key: 'resolved', label: 'History' },
];
// Five tabs became four (handoff 06). `internal` — questions asked through the
// in-app assistant dock — was its own tab, which meant a colleague's escalated
// question was only ever visible to someone who thought to look in a tab
// labelled for the plumbing rather than the person. It folds into Open now,
// and the channel line says "in-app" so the distinction survives where it is
// actually useful: on the row. ⚠ These still must not be fetched out of the
// list; being invisible entirely is the older, worse bug this replaced.
const channelLabel = (c: SupportConversation) => c.channel === 'dock' ? 'in-app' : c.channel;

// One line of plain text from a message body. DE replies are markdown, so a
// preview that doesn't strip it renders "**Change something**" — the emphasis
// markers become noise in exactly the place with the least room for it.
const previewOf = (raw?: string) => (raw ?? '')
  .replace(/^\[[^\]]*\]\s*/, '')             // the internal [channel · …] prefix
  .replace(/```[\s\S]*?```/g, ' ')           // fenced code blocks
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images → their text
  .replace(/[*_`>#]+/g, '')                  // emphasis, inline code, quotes, headings
  .replace(/\s+/g, ' ')
  .trim();

// ⚠ 164 of 173 conversations in this workspace have NO name and NO subject —
// every question asked through the in-app dock records neither. Under the old
// `subject || end_user_name || 'Conversation'` title they all rendered as the
// single word "Conversation", which is why the preview line above is not a
// nicety: it is the only thing telling 164 rows apart. Where even that fails,
// say what the row IS rather than the word "Conversation" again.
const titleOf = (c: SupportConversation) =>
  c.end_user_name || c.subject || (c.channel === 'dock' ? 'A colleague asked' : 'Unnamed customer');

const fmtTime = (iso: string | null) => fmtDateTime(iso, { empty: '' });
// Relative time for the list — "now / 5m / 3h / 2d", falling back to a date
// beyond a week. Ops scan recency, not clock times.
const fmtRel = (iso: string | null) => timeAgoCompact(iso, { empty: '', absoluteAfterDays: 7 });

export default function SupportInboxPage({ setPage: _setPage, embedded }: { setPage: (p: Page) => void; embedded?: boolean }) {
  const { authedUser } = useAuth();
  const myId = authedUser?.id ?? null;
  const [convs, setConvs] = useState<SupportConversation[]>([]);
  const [tab, setTab] = useState<Tab>('needs_human');
  const [topic, setTopic] = useState('');
  const [search, setSearch] = useState('');
  // Names/teams for the History report's "Handled by" and Team facets —
  // loaded once, only when History first opens, so the working tabs pay
  // nothing for them.
  const [deNames, setDeNames] = useState<Map<string, string>>(new Map());
  const [userNames, setUserNames] = useState<Map<string, string>>(new Map());
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [deTeams, setDeTeams] = useState<Map<string, string>>(new Map());
  const [deManagers, setDeManagers] = useState<Map<string, string[]>>(new Map());
  const [selId, setSelId] = useState<string | null>(null);
  const [thread, setThread] = useState<SupportMessage[]>([]);
  const [checks, setChecks] = useState<ConversationCheck[]>([]);
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
  // G3 hand-back: return the thread to its DE with an optional lesson note.
  const [handback, setHandback] = useState(false);
  const [handbackNote, setHandbackNote] = useState('');
  const [deName, setDeName] = useState('the DE');
  const [notice, setNotice] = useState<string | null>(null);
  const selRef = useRef<string | null>(null);
  selRef.current = selId;

  const loadConvs = useCallback(async () => {
    try { setConvs(await listSupportConversations('all')); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    try { setThread(await getConversationThread(id)); } catch { /* keep old */ }
    // Checks ride along with the thread. Failure → empty panel, never fake.
    try { setChecks(await listConversationChecks(id)); } catch { setChecks([]); }
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

  // Names for "Handled by" and the report table. Employees come from the same
  // roster call the workforce pages use. Human names come from a direct
  // profiles read that a tenant_user may not be allowed (RLS) — that failure
  // is EXPECTED and non-fatal: the report renders "a teammate" instead of a
  // name rather than erroring or, worse, hiding the row.
  useEffect(() => {
    if (tab !== 'resolved' || deNames.size > 0) return;
    void (async () => {
      try {
        const des = await listDigitalEmployees(true);
        setDeNames(new Map(des.map(d => [d.id, d.persona_name || d.name])));
      } catch { /* roster read failed — ids render as 'An employee' */ }
      try {
        const { data } = await supabase.from('workforce_teams').select('id, name');
        setTeams((data ?? []) as Array<{ id: string; name: string }>);
        const { data: members } = await supabase.from('workforce_team_members').select('team_id, de_id');
        const { data: mgrs } = await supabase.from('de_assignments').select('de_id, user_id').eq('relation', 'manager');
        const mm = new Map<string, string[]>();
        for (const r of (mgrs ?? []) as Array<{ de_id: string; user_id: string }>) mm.set(r.de_id, [...(mm.get(r.de_id) ?? []), r.user_id]);
        setDeManagers(mm);
        setDeTeams(new Map(((members ?? []) as Array<{ team_id: string; de_id: string }>).map(m => [m.de_id, m.team_id])));
      } catch { /* teams facet simply does not appear */ }
      try {
        const { data } = await supabase.from('profiles').select('user_id, full_name');
        setUserNames(new Map(((data ?? []) as Array<{ user_id: string; full_name: string | null }>).map(p => [p.user_id, p.full_name ?? ''])));
      } catch { /* names fall back to 'a teammate' */ }
    })();
  }, [tab, deNames.size]);

  // Only the topics that actually occur — see the note by the FilterBar.
  const topics = Array.from(new Set(convs.map(c => c.category).filter((c): c is string => !!c))).sort();

  const q = search.trim().toLowerCase();
  const filtered = convs.filter(c => {
    if (topic && c.category !== topic) return false;
    if (q && !`${c.subject ?? ''} ${c.end_user_name ?? ''} ${c.account_external_ref ?? ''}`.toLowerCase().includes(q)) return false;
    // Escalations are channel-agnostic: if a DE says it needs a human, a
    // human must see it whether it came from a customer or the app dock.
    if (tab === 'needs_human') return c.status === 'needs_human';
    if (tab === 'mine') return c.owner_user_id === myId && c.status !== 'resolved';
    // History and Open now both carry internal (dock) threads, tagged by
    // channel rather than quarantined in a tab of their own.
    if (tab === 'resolved') return c.status === 'resolved';
    return c.status !== 'resolved';
  });
  // Park (mig 669): parked threads leave the working flow of Mine and sit on
  // their own shelf below it. Recomputed every render — the existing 30s tick
  // is what brings a timed park back on screen with no reload and no sweep.
  const parkedMine = tab === 'mine' ? filtered.filter(c => isParked(c, new Date())) : [];
  const activeRows = tab === 'mine' ? filtered.filter(c => !isParked(c, new Date())) : filtered;

  const sel = convs.find(c => c.id === selId) ?? null;
  const pendingDraft = thread.find(m => m.delivery === 'draft_pending');
  const isEmail = sel?.channel === 'email';

  useEffect(() => {
    setHandback(false); setHandbackNote(''); setNotice(null);
    if (!sel?.de_id) { setDeName('the DE'); return; }
    let cancelled = false;
    void getDeDisplayName(sel.de_id).then(n => { if (!cancelled) setDeName(n); });
    return () => { cancelled = true; };
  }, [selId, sel?.de_id]);
  const counts = {
    needs_human: convs.filter(c => c.status === 'needs_human').length,
    mine: convs.filter(c => c.owner_user_id === myId && c.status !== 'resolved').length,
    // What the workforce is carrying without you. The queue showed only what
    // was wrong with it; the point of the desk is that most of it never
    // reaches a person, and that was the one number nowhere on the screen.
    // Deliberately not attributed to a named DE — several answer this inbox.
    handled: convs.filter(c => c.status === 'ai_handling').length,
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); if (selId) await loadThread(selId); await loadConvs(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  // Clear the reply box only AFTER the send succeeds — clearing first
  // loses the agent's typed message on a failed send.
  // Email conversations deliver for real (send-email-reply / send-outbound);
  // chat channels keep the thread-row path the customer already polls.
  const doSend = () => {
    const t = reply.trim(); if (!t || !selId) return;
    void run(async () => {
      if (isEmail) await sendEmailReply(selId, t); else await sendHumanReply(selId, t);
      setReply('');
    });
  };
  const doApprove = (id: string, edited?: string) => {
    setEditDraftId(null); setNotice(null);
    if (isEmail && selId) {
      void run(async () => {
        const res = await approveEmailDraft(selId, id, edited);
        if (!res.sent) setNotice(res.detail || 'Approved, but the email could not be sent yet — the draft is saved.');
      });
    } else {
      void run(() => approveDraft(id, edited));
    }
  };
  const doHandback = () => {
    if (!selId) return;
    void run(async () => {
      await handoffBackToDe(selId, handbackNote);
      setHandback(false); setHandbackNote('');
    });
  };

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden bg-dt-page">
      <div className={`relative px-6 flex items-start justify-between gap-4 ${embedded ? 'pt-3' : 'pt-6'}`}>
        {!embedded && <PageHeader title="Support inbox" subtitle="Live customer conversations — take over, approve a draft, reply, resolve." />}
        {embedded && (
          <p className="text-sm text-dt-support">
            {loading ? ' '
              : counts.needs_human > 0
                ? <><span className="text-dt-body font-medium">{counts.needs_human} {counts.needs_human === 1 ? 'conversation needs' : 'conversations need'} you.</span>
                    {counts.handled > 0 && ` Your digital employees are handling ${counts.handled} more.`}</>
              : counts.handled > 0 ? `Nothing needs you. Your digital employees are handling ${counts.handled}.`
              : 'Nothing waiting.'}
          </p>
        )}
        <Chip tone="ok" dot pulse title="New messages and escalations appear here without a refresh">Live</Chip>
      </div>
      {error && <div className="mx-6 mb-2 text-xs text-dt-danger">{error}</div>}
      {/* ⚠ THE FACET IS "TOPIC", NOT "PRODUCT". Handoff 06 drew this axis as
          Product and its own SRC note says "Product = category". The data says
          otherwise: the 165 triage rules across 15 workspaces set `billing`,
          `access`, `security`, `how_to`, `complaint`, `general`, `data`,
          `legal`, `outage`, `safety`, `feature_request` — every one of them a
          subject, none a product line. Labelling it Product would have told an
          owner they were filtering to a product called Billing when they were
          filtering to conversations ABOUT billing.
          Options are built from the categories PRESENT, never the 11
          configured: measured 2026-08-09, only `general` (115) and `how_to`
          (49) are ever assigned, so a hardcoded list would have offered nine
          filters that always return nothing. */}
      {/* The tab strip lives ABOVE the layout split now: History replaces the
          whole split view with a report, and a strip buried inside the list
          column would vanish with it — leaving no way back. */}
      <div className="px-6 pb-3">
        <div className="flex items-center gap-1 flex-wrap">
          {TABS.map(t => {
            const n = t.key === 'needs_human' ? counts.needs_human : t.key === 'mine' ? counts.mine : 0;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`text-xs px-2.5 py-1.5 rounded-lg transition-colors ${tab === t.key ? 'bg-dt-accent-strong text-white' : 'text-dt-support hover:text-dt-body hover:bg-dt-inset'}`}>
                {t.label}{n > 0 ? ` ${n}` : ''}
              </button>
            );
          })}
        </div>
      </div>
      {tab !== 'resolved' && (convs.length > 0 || search.trim() !== '') && (
        <div className="px-6 pb-3">
          <FilterBar
            facets={topics.length > 0 ? (
              <select value={topic} aria-label="Filter by topic" className={SELECT_CLS}
                onChange={e => setTopic(e.target.value)}>
                <option value="">Any topic</option>
                {topics.map(t => <option key={t} value={t}>{TOPIC_LABEL[t] ?? t.replace(/_/g, ' ')}</option>)}
              </select>
            ) : undefined}
            search={
              <input value={search} onChange={e => setSearch(e.target.value)}
                aria-label="Search conversations"
                placeholder="Search a customer or subject…" className={INPUT_CLS} />
            }
            views={(topic || search.trim()) ? (
              <Button kind="ghost" size="sm" onClick={() => { setTopic(''); setSearch(''); }}>Clear</Button>
            ) : undefined}
          />
        </div>
      )}
      {/* History is a REPORT over closed work (handoff 06 §D) — full width,
          no thread pane; a closed conversation is a record, not a workspace. */}
      {tab === 'resolved' ? (
        <div className="relative flex-1 overflow-hidden px-6 pb-6 flex">
          <SupportHistoryReport
            rows={convs.filter(c => c.status === 'resolved')}
            deNames={deNames} userNames={userNames} teams={teams} deTeams={deTeams} deManagers={deManagers}
            storeKey={`dt.supportviews.${authedUser?.tenantId ?? 'none'}.${authedUser?.id ?? 'anon'}`}
          />
        </div>
      ) : (
      <div className="relative flex-1 flex overflow-hidden px-6 pb-6 gap-4">
        {/* Left: conversation list */}
        <div className="w-[340px] flex-shrink-0 flex flex-col rounded-xl border border-dt-border bg-dt-card overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {loading ? <p className="text-xs text-dt-muted p-4 text-center">Loading…</p>
              : filtered.length === 0 ? <p className="text-xs text-dt-muted p-6 text-center">
                  {/* ⚠ A FILTER MUST NOT BE ABLE TO SAY "all clear". Without
                      this branch, narrowing to a topic with no matches told
                      the reader "that's everything waiting on you" — an
                      all-clear produced by their own filter, on a queue that
                      might be full. */}
                  {(topic || search.trim())
                    ? 'Nothing matches that filter. Clear it to see the rest.'
                    : tab === 'needs_human' ? "That's everything waiting on you."
                    : tab === 'mine' ? "Nothing is yours right now."
                    : 'No open conversations.'}
                </p>
              : activeRows.map(c => {
                const meta = STATUS_META[c.status];
                const active = selId === c.id;
                const preview = previewOf(c.last_message?.[0]?.content);
                return (
                  <button key={c.id} onClick={() => setSelId(c.id)}
                    className={`relative w-full text-left px-3 py-2.5 border-b border-dt-border transition-colors ${active ? 'bg-dt-inset' : 'hover:bg-dt-inset'}`}>
                    {active && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-dt-accent-strong" />}
                    {/* WHO, then WHAT THEY SAID. The old row led with `subject`,
                        which chat channels never set, so live conversations all
                        read "Conversation" and had to be opened to be triaged. */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-dt-body font-medium truncate flex-1">{titleOf(c)}</span>
                      <span className="text-xs text-dt-muted flex-shrink-0">{fmtRel(c.last_message_at)}</span>
                    </div>
                    {preview && <p className="text-xs text-dt-support truncate mt-0.5">{preview}</p>}
                    <div className="flex items-center gap-2 mt-1.5">
                      <Chip tone={meta.tone}>{meta.label}</Chip>
                      {/* Channel, language, priority and identity used to be
                          three more pills each fighting the status for the same
                          glance. They are facts about the row, not states of it. */}
                      <span className="text-xs text-dt-muted truncate">
                        {[channelLabel(c),
                          c.identity_verified ? 'verified' : null,
                          c.priority !== 'normal' ? c.priority : null,
                          c.detected_language && c.detected_language !== 'English' ? c.detected_language : null,
                        ].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                  </button>
                );
              })}
            {/* The shelf (mig 669). Anything you park comes back at the time
                you chose — or the moment they reply — via the 30s tick. */}
            {parkedMine.length > 0 && (
              <>
                <p className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-wide text-dt-muted">Parked</p>
                {parkedMine.map(c => (
                  <div key={c.id} className={`relative w-full px-3 py-2.5 border-b border-dt-border ${selId === c.id ? 'bg-dt-inset' : ''}`}>
                    <button onClick={() => setSelId(c.id)} className="w-full text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-dt-support font-medium truncate flex-1">{titleOf(c)}</span>
                        <span className="text-xs text-dt-muted flex-shrink-0">{parkedLabel(c)}</span>
                      </div>
                      {previewOf(c.last_message?.[0]?.content) && (
                        <p className="text-xs text-dt-faint truncate mt-0.5">{previewOf(c.last_message?.[0]?.content)}</p>
                      )}
                    </button>
                    <button disabled={busy} onClick={() => void run(() => unparkConversation(c.id))}
                      className="mt-1 text-xs text-dt-accent-text hover:underline disabled:opacity-50">
                      Bring it back now
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Right: thread */}
        <div className="flex-1 flex flex-col rounded-xl border border-dt-border bg-dt-card overflow-hidden min-w-0">
          {!sel ? (
            <div className="flex-1 flex items-center justify-center text-sm text-dt-muted">Select a conversation.</div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-dt-border">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-dt-title truncate">{titleOf(sel)}</span>
                  <Chip tone={STATUS_META[sel.status].tone}>{STATUS_META[sel.status].label}</Chip>
                  <div className="ml-auto flex items-center gap-2">
                    {sel.status !== 'human_owned' && sel.status !== 'resolved' && (
                      <Button kind="primary" size="sm" disabled={busy} onClick={() => void run(() => claimConversation(sel.id))}>I'll take this</Button>
                    )}
                    {(sel.status === 'human_owned' || sel.status === 'needs_human') && sel.de_id && (
                      <Button size="sm" disabled={busy} onClick={() => setHandback(h => !h)}>Hand back to {deName}</Button>
                    )}
                    {/* Park (mig 669): an OWNER's shelf, so it only appears on
                        your own open thread — the RPC enforces the same rule. */}
                    {sel.owner_user_id === myId && sel.status === 'human_owned' && (
                      isParked(sel, new Date())
                        ? <Button size="sm" disabled={busy}
                            onClick={() => void run(() => unparkConversation(sel.id))}>Bring it back now</Button>
                        : <select aria-label="Park until" value="" disabled={busy} className={`${SELECT_CLS} !py-1.5 text-xs`}
                            onChange={e => {
                              const p = parkPresets(new Date()).find(x => x.key === e.target.value);
                              if (p) void run(() => parkConversation(sel.id, p.until));
                            }}>
                            <option value="" disabled>Park until…</option>
                            {parkPresets(new Date()).map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                          </select>
                    )}
                    {sel.status !== 'resolved'
                      ? <Button size="sm" disabled={busy} onClick={() => void run(() => setConversationState(sel.id, { status: 'resolved' }))}>Mark done</Button>
                      : <Button size="sm" disabled={busy} onClick={() => void run(() => setConversationState(sel.id, { status: 'human_owned' }))}>Reopen</Button>}
                  </div>
                </div>
                <p className="text-xs text-dt-muted mt-1">
                  {[sel.account_external_ref ? `account ${sel.account_external_ref}` : null,
                    channelLabel(sel),
                    sel.identity_verified ? 'identity verified' : null,
                  ].filter(Boolean).join(' · ')}
                </p>
                {sel.handoff_summary && (
                  <Banner tone="warn" className="mt-2">
                    <span className="font-medium">{deName} stopped and asked for you.</span> {sel.handoff_summary}
                  </Banner>
                )}
                {/* What the DE verified BEFORE handing off (mig 667) — the
                    reason the human can trust the draft without re-doing the
                    work. Rows exist only for checks that RAN; conversations
                    escalated before the feature simply show nothing, never a
                    fabricated ✓. */}
                {checks.length > 0 && (
                  <div className="mt-2 rounded-xl border border-dt-border bg-dt-inset p-3">
                    <p className="text-xs font-medium text-dt-muted mb-1.5">What {deName} already checked</p>
                    <ul className="space-y-1">
                      {checks.map(c => (
                        <li key={c.id} className="flex items-start gap-2 text-xs">
                          <span aria-hidden className={c.ok ? 'text-dt-ok' : 'text-dt-danger'}>{c.ok ? '✓' : '✕'}</span>
                          <span className="text-dt-body">{c.label}{c.detail ? <span className="text-dt-muted"> — {c.detail}</span> : null}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {notice && <Banner tone="warn" className="mt-2">{notice}</Banner>}
                {handback && (
                  <div className="mt-2 rounded-xl border border-dt-border-strong bg-dt-inset p-3">
                    <p className="text-xs text-dt-support mb-2">
                      Hand this back to <span className="text-dt-body font-medium">{deName}</span>. Anything you write here, {deName} remembers on the customer's next message.
                    </p>
                    <textarea value={handbackNote} onChange={e => setHandbackNote(e.target.value)} rows={2}
                      placeholder={`Optional — e.g. "Customer is on the legacy plan; offer the loyalty discount before any refund talk."`}
                      className={INPUT_CLS} />
                    <div className="flex gap-2 mt-2">
                      <Button kind="primary" size="sm" disabled={busy} onClick={doHandback}>Hand back{handbackNote.trim() ? ' with the note' : ''}</Button>
                      <Button size="sm" onClick={() => setHandback(false)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5">
                {thread.map(m => {
                  const isCustomer = m.role === 'user';
                  const isDraft = m.delivery === 'draft_pending';
                  return (
                    <div key={m.id} className={`max-w-[80%] ${isCustomer ? 'self-start' : 'self-end'}`}>
                      <div className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                        isCustomer ? 'bg-dt-inset text-dt-body border border-dt-border rounded-tl-sm'
                        : isDraft ? 'bg-dt-warn-soft text-dt-warn border border-dt-warn-border rounded-tr-sm'
                        : 'bg-dt-accent-strong text-white rounded-tr-sm'
                      }`}>
                        {/* Strip the internal [channel · …] prefix from the customer message for display */}
                        {isCustomer ? m.content.replace(/^\[[^\]]*\]\s*/, '') : m.content}
                      </div>
                      <div className={`text-xs text-dt-muted mt-0.5 ${isCustomer ? 'text-left' : 'text-right'}`}>
                        {isDraft ? `${deName} wrote this — nothing is sent until you say so · ` : ''}{fmtTime(m.created_at)}
                      </div>
                      {isDraft && (
                        editDraftId === m.id ? (
                          <div className="mt-1.5">
                            <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3} className={INPUT_CLS} />
                            <div className="flex gap-2 mt-1.5">
                              <Button kind="primary" size="sm" disabled={busy} onClick={() => doApprove(m.id, editText)}>Send it</Button>
                              <Button size="sm" onClick={() => setEditDraftId(null)}>Cancel</Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2 mt-1.5 justify-end">
                            <Button kind="primary" size="sm" disabled={busy} onClick={() => doApprove(m.id)}>Send it</Button>
                            <Button size="sm" onClick={() => { setEditDraftId(m.id); setEditText(m.content); }}>Change the wording</Button>
                          </div>
                        )
                      )}
                    </div>
                  );
                })}
                {pendingDraft && (
                  <p className="self-center text-xs text-dt-muted mt-1">
                    {isEmail ? 'Nothing has been emailed yet — approving sends this reply to the customer.' : 'The customer sees a holding message until you approve or reply.'}
                  </p>
                )}
                <div ref={threadEndRef} />
              </div>

              <div className="border-t border-dt-border p-3">
                <div className="flex items-end gap-2">
                  <textarea value={reply} onChange={e => setReply(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } }}
                    placeholder={sel.status === 'resolved' ? 'Reopen to reply…'
                      : sel.channel === 'dock' ? 'Reply to your colleague…'
                      : `Write to ${sel.end_user_name || 'the customer'}…`}
                    disabled={sel.status === 'resolved' || busy} rows={1}
                    className={`${INPUT_CLS} flex-1 resize-none max-h-32 disabled:opacity-50`} />
                  <Button kind="primary" className="flex-shrink-0" disabled={!reply.trim() || busy || sel.status === 'resolved'} onClick={doSend}>Send</Button>
                </div>
                <p className="text-xs text-dt-muted mt-1.5">
                  {isEmail ? `Sent as an email reply to ${sel.end_user_name || 'the customer'}. If you reply, this becomes yours and ${deName} steps back.`
                    : sel.channel === 'dock' ? `Your colleague sees this in their assistant thread. If you reply, this becomes yours and ${deName} steps back.`
                    : `Your reply goes straight to the customer. If you reply, this becomes yours and ${deName} steps back.`}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
