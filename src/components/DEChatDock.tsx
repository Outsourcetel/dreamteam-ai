import React, { useEffect, useMemo, useRef, useState } from 'react';
import AISessionPanel from './AISessionPanel';
import { useAuth } from '../context/AuthContext';
import { useCanOpenPage } from '../lib/useRoleGate';
import type { Page } from '../types';
import type { CompanyId } from '../data/companies';
import { askDE, DEAnswerError, createKnowledgeDoc, extractPdf, ingestDocChunks } from '../lib/knowledgeApi';
import { listDigitalEmployees, type DigitalEmployee } from '../lib/digitalEmployeesApi';
import ImportSiteModal from './ImportSiteModal';

// ============================================================
// "Ask your DE" global chat dock — context-aware DE routing,
// scripted answers with confidence + action links, escalation
// to an approval queue, and gap-logging fallback.
// ============================================================

// ── DE roster (mirrors WorkforceDEsPage) ──────────────────────────

export interface DockDE {
  id: string;
  name: string;
  role: string;
  color: string; // avatar bg
}

const DES: Record<CompanyId, DockDE[]> = {
  tcp: [
    { id: 'alex', name: 'Alex', role: 'Customer Support DE', color: 'bg-indigo-600' },
    { id: 'casey', name: 'Casey', role: 'Renewal DE', color: 'bg-violet-600' },
    { id: 'riley', name: 'Riley', role: 'HR & People DE', color: 'bg-sky-600' },
  ],
  pwc: [
    { id: 'morgan', name: 'Morgan', role: 'Client Relations DE', color: 'bg-sky-600' },
    { id: 'avery', name: 'Avery', role: 'Tax Research DE', color: 'bg-teal-600' },
  ],
};

// ── Context-aware DE routing ──────────────────────────────────────

export function deForPage(page: Page, companyId: CompanyId): DockDE {
  const roster = DES[companyId];
  if (companyId === 'tcp') {
    const [alex, casey, riley] = roster;
    // ⚠ `page.startsWith('entity_workforce')` also stood here. The nine
    // entity_workforce_* / entity_vendor_* pages were closed 2026-08-20 and are
    // no longer `Page` values, so that arm could only ever have matched a string
    // that no longer exists — see src/types/index.ts.
    if (page === 'workforce_des') return riley;
    if (
      page === 'entity_customer_renewal' || page === 'entity_customer_sales' ||
      page === 'entity_customer_bd' || page === 'outcome_revenue' ||
      page === 'outcome_financial'
    ) return casey;
    return alex; // support/customer pages + default
  }
  const [morgan, avery] = roster;
  if (page === 'outcome_delivery' || page === 'outcome_financial' || page.startsWith('knowledge')) return avery;
  return morgan;
}

// ⚠ `isUnownedArea(page)` stood here and answered exactly one question — "is
// this one of the four entity_vendor_* pages?" — so the dock could offer to
// hire a Vendor DE. Those pages were closed 2026-08-20 (src/types/index.ts) and
// with them the only input that could return true, which would have left a
// predicate that cannot fire and a banner that cannot render. Both are gone
// rather than left as furniture.

// ── Messages & persistence ────────────────────────────────────────

interface ChatAction { label: string; page: Page }

interface ChatMsg {
  id: string;
  role: 'user' | 'de' | 'system';
  deId?: string;
  text: string;
  confidence?: number;
  actions?: ChatAction[];
  time: string;
  /** live mode: doc titles the answer was grounded in */
  sources?: string[];
  /** live mode: a real human_tasks escalation row was created */
  escalated?: boolean;
  /** live mode: honest error banners */
  notice?: 'llm_not_configured' | 'error';
  /** live mode: answer served from the semantic answer cache */
  cached?: boolean;
  /** live mode: answer withheld by a tenant guardrail rule (P3) */
  blocked?: boolean;
  /** live mode: the guardrail rule text that blocked the answer */
  blockedRule?: string;
  /**
   * live mode: the employee has no knowledge and is offering to fix that here.
   * The reply copy is an IMPERATIVE ("paste your website address and I'll read
   * it"), so this must render a real control. Without one the user answers in
   * chat, nothing is learned, and the next reply says "nothing changes until
   * knowledge lands" — worse than the flat message it replaced.
   */
  recovery?: {
    kind: 'import_site'; cta?: string; prompt?: string;
    /** the server's second offer on the same reply — a document instead of a
     *  site. Dropping it re-opens funnel census #3; render a control. */
    fallback?: { kind: 'upload_document'; prompt?: string };
  };
}

// ── LIVE mode (real tenant): the dock fronts the de-answer edge
//    function — real Claude answers grounded in knowledge_docs. ──
//
// The dock's displayed identity is the REAL configured Digital
// Employee (Wave 1.3, "make the role real") — not a fixed "Alex".
// GENERIC_LIVE_DE is only the honest placeholder shown before either
// (a) the on-mount roster fetch resolves the tenant's first DE, or
// (b) the first de-answer response names the actual answering DE —
// whichever lands first. A brand-new tenant with zero DEs yet
// legitimately keeps this generic label; that's not a bug.
const GENERIC_LIVE_DE: DockDE = { id: 'de', name: 'your Digital Employee', role: 'Digital Employee', color: 'bg-indigo-600' };

const LIVE_SUGGESTIONS = [
  'What do you know about our refund policy?',
  'How do I contact support escalation?',
  'What products or services do we document?',
];

const threadKey = (c: string) => `dt_chat_thread_${c}`;
const escKey = (c: CompanyId) => `dt_chat_escalations_${c}`;

function loadThread(companyId: string): ChatMsg[] {
  try {
    const raw = localStorage.getItem(threadKey(companyId));
    if (raw) return JSON.parse(raw) as ChatMsg[];
  } catch { /* noop */ }
  return [];
}

function saveThread(companyId: string, msgs: ChatMsg[]) {
  try {
    localStorage.setItem(threadKey(companyId), JSON.stringify(msgs.slice(-50)));
  } catch { /* noop */ }
}

function writeEscalation(companyId: CompanyId, de: DockDE, summary: string) {
  // dt_ops_tasks_${companyId} stores a decisions overlay (Record<taskId, status>)
  // for seeded tasks only — appending a new task there isn't shape-compatible.
  // Escalations from chat live in their own list instead.
  try {
    const raw = localStorage.getItem(escKey(companyId));
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    list.push({
      id: `chat-esc-${Date.now()}`,
      type: 'review_gate',
      title: `Chat escalation — ${summary}`,
      de: de.name,
      createdAt: new Date().toISOString(),
      status: 'pending',
      source: 'de_chat_dock',
    });
    localStorage.setItem(escKey(companyId), JSON.stringify(list));
    window.dispatchEvent(new Event('dt-state-changed'));
  } catch { /* noop */ }
}

// ── The scripted "brain" ──────────────────────────────────────────

interface Intent {
  deId: string;
  keywords: string[];
  text: string;
  confidence: number;
  actions?: ChatAction[];
  special?: 'escalate' | 'guardrail';
}


const INTROS: Record<string, string> = {
  alex: "I'm Alex, your Customer Support DE. I work the support queue — 47 open tickets right now — resolve what I can autonomously, and escalate anything below my confidence threshold. Ask me about tickets, escalations, or resolution rates.",
  casey: "I'm Casey, your Renewal DE. I run the $2.1M renewal pipeline — 8 renewals due — generate invoices, and prep contracts. Anything above my $10K approval gate goes to a human. Ask me about renewals, at-risk accounts, or invoices.",
  riley: "I'm Riley, your HR & People DE. I handle workforce onboarding, leave requests, and people processes. Full transparency: my own recertification is currently overdue. Ask me about onboarding, learned behaviors, or the Workday sync.",
  morgan: "I'm Morgan, your Client Relations DE. I manage 4 active engagements — letters, fees, credit notes, and client communications, with everything above $5K gated to a partner. Ask me about engagements, the GDPR request, or fees.",
  avery: "I'm Avery, your Tax Research DE. I draft cited tax memos and review audit workpapers — every memo goes through partner review before delivery. Ask me about the Crestline memo, workpapers, or my FATCA knowledge gap.",
};

export interface DEResponse {
  text: string;
  confidence: number;
  actions?: ChatAction[];
  escalated?: boolean;
}

let fallbackCursor = 0;

// ── Suggestion chips ──────────────────────────────────────────────

const SUGGESTIONS: Record<string, string[]> = {
  alex: ["What's the oldest open ticket?", 'Any escalations right now?', "How's our resolution rate this week?"],
  casey: ["How's the renewal pipeline?", "What's blocking the Meridian invoice?", 'Which accounts are at risk?'],
  riley: ["What's your training status?", 'Any onboarding issues?', 'What learned behaviors are pending?'],
  morgan: ['How are my engagements?', "What's the status of the GDPR request?", 'Any approvals waiting on me?'],
  avery: ['Is the Crestline memo done?', 'Any workpaper issues?', 'What knowledge gaps do you have?'],
};

// ── Component ─────────────────────────────────────────────────────

const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const uid = () => `m${Date.now()}${Math.floor(Math.random() * 1e4)}`;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function DEChatDock() {
  const { currentPage, activeCompanyId, handleSetPage, currentTenant } = useAuth();
  // The dock follows a DE anywhere, so this offer reaches every role — and
  // Human Tasks is APPROVALS-tier. Without this the escalation notice hands a
  // read_only user a link that silently does nothing.
  const canOpenTasks = useCanOpenPage('ops_human_tasks');
  const isLive = true;   // legacy demo mode decommissioned — always live
  const threadId = isLive ? 'live' : activeCompanyId;
  const [open, setOpen] = useState(false);
  // Ask (question -> DE) vs Do (describe a change -> workspace assistant).
  const [dockMode, setDockMode] = useState<'ask' | 'do'>('ask');
  const [messages, setMessages] = useState<ChatMsg[]>(() => loadThread(threadId));
  // Opened from the in-chat recovery CTA when the employee has no knowledge.
  const [showImportSite, setShowImportSite] = useState(false);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [pulse, setPulse] = useState(() => {
    try { return !sessionStorage.getItem('dt_chat_pulsed'); } catch { return true; }
  });
  const endRef = useRef<HTMLDivElement>(null);
  const lastDeIdRef = useRef<string | null>(null);
  const reduceMotion = useMemo(prefersReducedMotion, []);

  const [liveDe, setLiveDe] = useState<DockDE>(GENERIC_LIVE_DE);
  const de = isLive ? liveDe : deForPage(currentPage, activeCompanyId);
  const conversationIdRef = useRef<string | null>(null);

  // Resolve the real answering DE's identity up front (same "tenant's
  // first DE" fallback de-answer itself uses when no de_id is passed)
  // so the header doesn't sit on the generic placeholder until the
  // first message round-trips. The de-answer response (sendLive,
  // below) is still the source of truth and overwrites this on reply.
  useEffect(() => {
    if (!isLive) return;
    let cancelled = false;
    listDigitalEmployees().then((des) => {
      if (cancelled || des.length === 0) return;
      // The global dock is the WORKSPACE assistant — the DE that knows the
      // DreamTeam platform and can help you run it. It is NOT whichever
      // business DE happens to be oldest: routing every question to (say)
      // the Finance DE is why this dock used to answer as "Morgan"
      // regardless of what was asked. Every tenant is provisioned a
      // Workspace Assistant; fall back to a published DE only if missing.
      const rows = des as Array<DigitalEmployee & { is_workforce_assistant?: boolean }>;
      const assistant =
        rows.find((d) => d.is_workforce_assistant) ??
        rows.find((d) => !['designed', 'paused', 'retired', 'archived'].includes(String(d.lifecycle_status))) ??
        rows[0];
      setLiveDe({
        id: assistant.id,
        name: assistant.is_workforce_assistant
          ? 'Workspace Assistant'
          : (assistant.persona_name || assistant.name || GENERIC_LIVE_DE.name),
        role: assistant.is_workforce_assistant
          ? 'Knows your workspace & the platform'
          : (assistant.department ? `${assistant.department} Digital Employee` : 'Digital Employee'),
        color: GENERIC_LIVE_DE.color,
      });
    }).catch(() => { /* honest fallback: keep the generic placeholder */ });
    return () => { cancelled = true; };
  }, [isLive]);

  // Company/mode switch → load that thread.
  useEffect(() => {
    setMessages(loadThread(threadId));
    lastDeIdRef.current = null;
  }, [threadId]);

  // Persist thread.
  useEffect(() => {
    saveThread(threadId, messages);
  }, [messages, threadId]);

  // Pulse only briefly on first render per session.
  useEffect(() => {
    try { sessionStorage.setItem('dt_chat_pulsed', '1'); } catch { /* noop */ }
    const t = window.setTimeout(() => setPulse(false), 6000);
    return () => window.clearTimeout(t);
  }, []);

  // DE handoff line when navigating across ownership while open.
  useEffect(() => {
    if (!open) return;
    if (lastDeIdRef.current && lastDeIdRef.current !== de.id) {
      setMessages(prev => [...prev, {
        id: uid(), role: 'system',
        text: `— ${de.name} joined the conversation (owns this area) —`,
        time: nowTime(),
      }]);
    }
    lastDeIdRef.current = de.id;
  }, [de.id, open]);

  // Unread nudge — once per session, 25s after load, while closed.
  useEffect(() => {
    let shown = false;
    try { shown = !!sessionStorage.getItem('dt_chat_nudged'); } catch { /* noop */ }
    if (shown || open || isLive) return;
    const t = window.setTimeout(() => {
      try { sessionStorage.setItem('dt_chat_nudged', '1'); } catch { /* noop */ }
      setNudge(true);
    }, 25000);
    return () => window.clearTimeout(t);
  }, [open]);

  // Nudge is transient: auto-dismiss after 10s, and dismiss on navigation.
  useEffect(() => {
    if (!nudge) return;
    const t = window.setTimeout(() => setNudge(false), 10000);
    return () => window.clearTimeout(t);
  }, [nudge]);

  const nudgePageRef = useRef(currentPage);
  useEffect(() => {
    if (currentPage !== nudgePageRef.current) {
      nudgePageRef.current = currentPage;
      setNudge(false);
    }
  }, [currentPage]);

  // Autoscroll.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [messages, typing, reduceMotion]);

  const postDEReply = (deNow: DockDE, resp: DEResponse) => {
    setTyping(true);
    const delay = reduceMotion ? 100 : 700 + Math.floor(Math.random() * 500);
    window.setTimeout(() => {
      setTyping(false);
      setMessages(prev => [...prev, {
        id: uid(), role: 'de', deId: deNow.id, text: resp.text,
        confidence: resp.confidence, actions: resp.actions, time: nowTime(),
      }]);
    }, delay);
  };

  // Live mode: real DE turn via the de-answer edge function.
  const sendLive = async (text: string) => {
    setTyping(true);
    try {
      // Ask the employee we are actually SHOWING in the header. liveDe is set
      // from the Workspace Assistant just above; not passing it is what made the
      // header say "Workspace Assistant" while a different employee answered.
      const res = await askDE(text, conversationIdRef.current, currentTenant?.id ?? null, liveDe?.id ?? null);
      if (res.conversation_id) conversationIdRef.current = res.conversation_id;
      // de-answer is the source of truth for who actually answered —
      // overwrite the on-mount guess (or confirm it) every reply.
      if (res.de_name) {
        setLiveDe(prev => ({ ...prev, id: res.de_id || prev.id, name: res.de_name! }));
      }
      setMessages(prev => [...prev, {
        id: uid(), role: 'de', deId: res.de_id || de.id,
        text: res.answer,
        confidence: res.confidence,
        sources: res.sources,
        escalated: res.needs_escalation,
        cached: res.cached,
        blocked: res.blocked,
        blockedRule: res.blocked_rule,
        recovery: res.recovery,
        time: nowTime(),
      }]);
    } catch (err) {
      if (err instanceof DEAnswerError && err.code === 'llm_not_configured') {
        setMessages(prev => [...prev, {
          id: uid(), role: 'de', deId: de.id, notice: 'llm_not_configured',
          text: 'DE brain not yet activated — an admin needs to add the Anthropic API key (Supabase → Edge Function secrets → ANTHROPIC_API_KEY). Until then I can\'t answer from your knowledge documents.',
          time: nowTime(),
        }]);
      } else {
        setMessages(prev => [...prev, {
          id: uid(), role: 'de', deId: de.id, notice: 'error',
          text: 'I couldn\'t reach my answering service just now — that\'s a network or server issue on our side, not your question. Please try again in a moment.',
          time: nowTime(),
        }]);
      }
    } finally {
      setTyping(false);
    }
  };

  const send = (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || typing) return;
    setInput('');
    setMessages(prev => [...prev, { id: uid(), role: 'user', text, time: nowTime() }]);
    // Always the real employee. The scripted answer bank that used to sit
    // behind an `isLive` check is gone — it invented customer finances.
    void sendLive(text);
  };

  // The upload_document fallback control (funnel census #3): the employee
  // asked for a document — this reads it, files it as knowledge through the
  // SAME create+ingest path the library uses, and closes the loop in the
  // thread, mirroring the site-import beat below.
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const uploadDocIntoThread = async (file: File) => {
    setUploadingDoc(true);
    try {
      let title = file.name;
      let text = '';
      if (/\.pdf$/i.test(file.name)) {
        const ex = await extractPdf(file);
        title = ex.title || file.name; text = ex.text;
      } else if (/\.(txt|md|markdown)$/i.test(file.name)) {
        text = await file.text();
      } else {
        setMessages(prev => [...prev, { id: uid(), role: 'system', text: 'I can read text, markdown and PDF files — that format would land as unreadable garbage, so I did not save it.', time: nowTime() }]);
        return;
      }
      if (!text.trim()) {
        setMessages(prev => [...prev, { id: uid(), role: 'system', text: 'Nothing readable in that file — try a different one, or paste your website address instead.', time: nowTime() }]);
        return;
      }
      const doc = await createKnowledgeDoc({ title, content: text, source: 'upload', tags: [] });
      await ingestDocChunks(doc.id);
      setMessages(prev => [...prev, {
        id: uid(), role: 'system',
        text: `Read “${title}” and added it to my knowledge. Ask me again and I'll answer from it.`,
        time: nowTime(),
      }]);
    } catch (err) {
      setMessages(prev => [...prev, { id: uid(), role: 'system', text: `I couldn't read that document (${(err as Error).message}). Try again, or paste your website address instead.`, time: nowTime() }]);
    } finally {
      setUploadingDoc(false);
    }
  };

  const openFromNudge = () => {
    setNudge(false);
    setOpen(true);
    lastDeIdRef.current = de.id;
    const humanTasks = activeCompanyId === 'tcp' ? 5 : 4;
    setMessages(prev => [...prev, {
      id: uid(), role: 'de', deId: de.id,
      text: `${humanTasks} human tasks are waiting — want a summary? Just ask "what's waiting" and I'll walk you through the queue.`,
      confidence: 93,
      actions: [{ label: 'View Human Tasks →', page: 'ops_human_tasks' }],
      time: nowTime(),
    }]);
  };

  const clearThread = () => {
    setMessages([]);
    setMenuOpen(false);
    conversationIdRef.current = null;
    try { localStorage.removeItem(threadKey(threadId)); } catch { /* noop */ }
  };

  const deById = (id?: string): DockDE =>
    DES[activeCompanyId].find(d => d.id === id) ?? de;

  return (
    <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-3">
      {/* Panel.
          OPAQUE, deliberately. --dt-card carries a 40% alpha, which is right
          for a card sitting ON the canvas, because what shows through is the
          canvas. This dock is `fixed` and floats over whatever the page
          happens to be showing, so that same token let tables and body text
          bleed through the conversation. --dt-page is the only fully opaque
          surface of the four — panel and card are both 40%, inset is 60% —
          and it stays opaque under tenant branding too (src/design/
          branding.ts). The strong border and shadow are what separate the
          dock from the canvas; the fill was never doing that job.
          (Alphas stated in words, not hex: certify's design-drift ratchet
          counts raw hex in source and does not strip comments — by design,
          so examples cannot hide there either.) */}
      {open && (
        <div className="w-96 h-[560px] rounded-2xl bg-dt-page border border-dt-border-strong shadow-2xl shadow-black/50 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-dt-border-strong flex-shrink-0">
            <div className={`w-8 h-8 rounded-full ${de.color} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
              {de.name[0]}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-dt-title truncate">{de.name}</div>
              <div className="flex items-center gap-1.5 text-xs text-dt-support truncate">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
                {de.role}
              </div>
              {isLive && (
                <div className="text-[10px] text-dt-muted truncate">Answers grounded in your knowledge documents</div>
              )}
            </div>
            {!isLive && (
              <button
                onClick={() => { setOpen(false); handleSetPage('workforce_des'); }}
                className="text-[11px] text-dt-accent-text hover:underline transition-colors flex-shrink-0"
              >
                View profile
              </button>
            )}
            <div className="relative flex-shrink-0">
              <button
                onClick={() => setMenuOpen(v => !v)}
                className="w-6 h-6 rounded bg-dt-panel text-dt-muted hover:text-dt-body flex items-center justify-center text-xs transition-colors"
                aria-label="Menu"
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-7 bg-dt-page border border-dt-border-strong rounded-lg py-1 w-40 shadow-xl">
                  <button
                    onClick={clearThread}
                    className="w-full text-left px-3 py-1.5 text-xs text-dt-support hover:text-dt-body hover:bg-dt-panel transition-colors"
                  >
                    Clear conversation
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => { setOpen(false); setMenuOpen(false); }}
              className="w-6 h-6 rounded bg-dt-panel text-dt-muted hover:text-dt-body flex items-center justify-center text-xs flex-shrink-0 transition-colors"
              aria-label="Minimize"
            >
              ×
            </button>
          </div>

          {/* Ask vs Change. The dock used to only ANSWER questions; the
              assistant tab lets someone change the workspace by describing
              what they want, with a 120-hour undo on anything it does. */}
          {isLive && (
            <div className="flex gap-1 px-3 py-2 border-b border-dt-border-strong flex-shrink-0">
              {([['ask', 'Ask a question'], ['do', 'Change something']] as const).map(([m, label]) => (
                <button key={m} onClick={() => setDockMode(m)}
                  className={`flex-1 text-[11px] px-2 py-1.5 rounded-lg transition-colors ${
                    dockMode === m ? 'bg-dt-panel text-dt-title' : 'text-dt-support hover:text-dt-body'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {isLive && dockMode === 'do' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <p className="text-[10px] text-dt-muted px-3 pt-2">
                Edits knowledge, playbook drafts and employee descriptions (undoable). To hire or restructure the workforce itself, use the workforce hub.
              </p>
              <div className="flex-1 min-h-0">
                <AISessionPanel subjectKind="workspace" subjectLabel="Your workspace" />
              </div>
            </div>
          ) : (
          <>

          {/* ⚠ The "No DE owns Vendors & Partners yet" banner rendered here,
              gated on isUnownedArea(currentPage). It went with the vendor
              pages on 2026-08-20 — see the note above deForPage. */}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && !typing && (
              <div className="text-center pt-8">
                <div className={`w-12 h-12 rounded-full ${de.color} mx-auto flex items-center justify-center text-white text-lg font-bold mb-3`}>
                  {de.name[0]}
                </div>
                <p className="text-sm text-dt-support font-medium">Ask {de.name} anything</p>
                <p className="text-xs text-dt-muted mt-1">
                  {isLive ? `${de.role} · answers grounded in your knowledge documents` : `${de.role} · answers from live workspace data`}
                </p>
              </div>
            )}
            {messages.map(msg => {
              if (msg.role === 'system') {
                return (
                  <div key={msg.id} className="text-center text-[11px] text-dt-muted py-1">{msg.text}</div>
                );
              }
              const msgDe = deById(msg.deId);
              return (
                <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'de' && (
                    <div className={`w-6 h-6 rounded-full ${msgDe.color} flex items-center justify-center text-white text-xs flex-shrink-0 mt-0.5`}>
                      {msgDe.name[0]}
                    </div>
                  )}
                  <div className={`max-w-[85%] rounded-xl px-3 py-2 ${
                    msg.role === 'user' ? 'bg-indigo-600 text-white'
                    : msg.notice === 'llm_not_configured' ? 'bg-dt-warn-soft border border-dt-warn-border text-dt-warn'
                    : msg.notice === 'error' ? 'bg-dt-danger-soft border border-dt-danger-border text-dt-danger'
                    : 'bg-dt-panel text-dt-body'
                  }`}>
                    <div className="text-xs whitespace-pre-line leading-relaxed">{msg.text}</div>
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="mt-1.5 text-[10px] text-dt-support">From: {msg.sources.join(', ')}</div>
                    )}
                    {msg.cached && (
                      <div className="mt-1 text-[10px] text-teal-400/80" title="Served from the verified answer cache — no model call needed">⚡ instant</div>
                    )}
                    {msg.recovery?.kind === 'import_site' && (
                      // The employee just asked for a website address. This is the
                      // control that honours it. Both real signups reached this
                      // exact moment and left, because there was nothing here.
                      <button
                        type="button"
                        onClick={() => setShowImportSite(true)}
                        className="mt-2 w-full rounded-lg border border-dt-accent-border bg-dt-accent-soft px-3 py-2 text-[11px] font-medium text-dt-accent-text transition-colors hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-dt-accent"
                      >
                        {msg.recovery.cta || 'Read my website'}
                      </button>
                    )}
                    {msg.recovery?.fallback?.kind === 'upload_document' && (
                      // The server has ALWAYS sent this second offer with the
                      // reply — the client dropped it and the DE's own prose
                      // asked for a document nobody could hand over (funnel
                      // census #3). This is the control that honours it.
                      <label className="mt-1.5 block w-full cursor-pointer rounded-lg border border-dt-border-strong bg-dt-panel px-3 py-2 text-center text-[11px] font-medium text-dt-support transition-colors hover:text-dt-body hover:border-indigo-500/40">
                        {uploadingDoc ? 'Reading your document…' : (msg.recovery.fallback.prompt || 'Or send me a document instead')}
                        <input
                          type="file"
                          accept=".txt,.md,.markdown,.pdf"
                          className="hidden"
                          disabled={uploadingDoc}
                          onChange={e => { const f = e.target.files?.[0]; if (f) void uploadDocIntoThread(f); e.target.value = ''; }}
                        />
                      </label>
                    )}
                    {msg.blocked && (
                      <div className="mt-1.5 rounded-lg bg-dt-warn-soft border border-dt-warn-border px-2 py-1.5 text-[11px] text-dt-warn">
                        🛡 Guardrail block{msg.blockedRule ? ` — "${msg.blockedRule}"` : ''}. The draft answer was withheld and recorded in the audit trail.
                      </div>
                    )}
                    {msg.escalated && !msg.blocked && (
                      <div className="mt-1.5 rounded-lg bg-dt-warn-soft border border-dt-warn-border px-2 py-1.5 text-[11px] text-dt-warn">
                        I've escalated this to your team —{' '}
                        {canOpenTasks && <button
                          onClick={() => handleSetPage('ops_human_tasks')}
                          className="underline underline-offset-2 hover:brightness-110 transition-colors"
                        >
                          view Human Tasks →
                        </button>}
                      </div>
                    )}
                    {msg.actions && msg.actions.length > 0 && (
                      <div className="mt-1.5 flex flex-col items-start gap-1">
                        {msg.actions.map(a => (
                          <button
                            key={a.label}
                            onClick={() => handleSetPage(a.page)}
                            className="text-[11px] text-dt-accent-text hover:underline transition-colors"
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className={`flex items-center gap-2 mt-1 text-[10px] ${msg.role === 'user' ? 'text-indigo-200' : 'text-dt-muted'}`}>
                      <span>{msg.time}</span>
                      {msg.role === 'de' && msg.confidence !== undefined && (
                        <span className={`px-1 py-px rounded ${msg.confidence >= 75 ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                          {msg.confidence}%
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {typing && (
              <div className="flex gap-2 justify-start">
                <div className={`w-6 h-6 rounded-full ${de.color} flex items-center justify-center text-white text-xs flex-shrink-0 mt-0.5`}>
                  {de.name[0]}
                </div>
                <div className="bg-dt-panel rounded-xl px-3 py-3">
                  <div className="flex gap-1 items-center">
                    {[0, 150, 300].map(delay => (
                      <div
                        key={delay}
                        className={`w-1.5 h-1.5 rounded-full bg-dt-border-strong ${reduceMotion ? '' : 'animate-bounce'}`}
                        style={reduceMotion ? undefined : { animationDelay: `${delay}ms` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {/* Suggestion chips (empty thread only) */}
          {messages.length === 0 && !typing && (
            <div className="px-3 py-2 border-t border-dt-border-strong flex gap-1 flex-wrap flex-shrink-0">
              {(isLive ? LIVE_SUGGESTIONS : SUGGESTIONS[de.id] ?? []).map(s => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-xs px-2 py-1 rounded-lg bg-dt-panel hover:bg-dt-panel text-dt-support border border-dt-border-strong transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className={`px-3 pb-3 flex-shrink-0 ${messages.length > 0 || typing ? 'pt-3 border-t border-dt-border-strong' : 'pt-1'}`}>
            <div className="flex gap-2">
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={`Ask ${de.name} anything...`}
                className="flex-1 text-xs bg-dt-panel border border-dt-border-strong rounded-xl px-3 py-2 text-dt-body placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
              />
              <button
                onClick={() => send()}
                disabled={!input.trim() || typing}
                className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs transition-colors"
                aria-label="Send"
              >
                →
              </button>
            </div>
          </div>

          </>
          )}
        </div>
      )}

      {/* Unread nudge bubble */}
      {!open && nudge && (
        <button
          onClick={openFromNudge}
          className="max-w-[260px] text-left bg-dt-page border border-dt-border-strong rounded-xl px-3 py-2.5 shadow-xl shadow-black/40 hover:border-indigo-500/50 transition-colors"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className={`w-5 h-5 rounded-full ${de.color} flex items-center justify-center text-white text-[10px] font-bold`}>{de.name[0]}</span>
            <span className="text-xs font-medium text-dt-title">{de.name}</span>
          </div>
          <p className="text-[11px] text-dt-support leading-snug">
            {activeCompanyId === 'tcp' ? 5 : 4} human tasks are waiting — want a summary?
          </p>
        </button>
      )}

      {/* Launcher */}
      {!open && (
        <div
          className="relative"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {hovered && (
            <div className="absolute right-14 top-1/2 -translate-y-1/2 whitespace-nowrap bg-dt-page border border-dt-border-strong text-dt-body text-xs px-2.5 py-1.5 rounded-lg shadow-xl">
              Ask {de.name}
            </div>
          )}
          <button
            onClick={() => { setOpen(true); setNudge(false); lastDeIdRef.current = de.id; }}
            className={`relative w-12 h-12 rounded-full ${de.color} hover:brightness-110 text-white text-base font-bold shadow-lg shadow-indigo-950/50 flex items-center justify-center transition-all ${pulse && !reduceMotion ? 'animate-pulse' : ''}`}
            aria-label={`Ask ${de.name}`}
          >
            {de.name[0]}
            <span className="absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-dt-page" />
          </button>
        </div>
      )}

      {showImportSite && (
        <ImportSiteModal
          onClose={() => setShowImportSite(false)}
          onImported={(count) => {
            setShowImportSite(false);
            // Close the loop in the thread itself. The employee asked for the
            // website, the user gave it, and this is the employee coming back
            // able to work — the beat that was missing when both real signups
            // reached this point and left.
            setMessages(prev => [...prev, {
              id: uid(), role: 'system',
              text: count > 0
                ? `Read your website — ${count} page${count === 1 ? '' : 's'} added. Ask me again and I'll answer from them.`
                : 'Nothing could be read from that address. Try a different page, or add a document directly.',
              time: nowTime(),
            }]);
          }}
        />
      )}
    </div>
  );
}
