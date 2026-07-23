import React, { useEffect, useMemo, useRef, useState } from 'react';
import AISessionPanel from './AISessionPanel';
import { useAuth } from '../context/AuthContext';
import type { Page } from '../types';
import type { CompanyId } from '../data/companies';
import { askDE, DEAnswerError } from '../lib/knowledgeApi';
import { listDigitalEmployees, type DigitalEmployee } from '../lib/digitalEmployeesApi';

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
    if (page.startsWith('entity_workforce') || page === 'specialist_people' || page === 'workforce_des') return riley;
    if (
      page === 'entity_customer_renewal' || page === 'entity_customer_sales' ||
      page === 'entity_customer_bd' || page === 'outcome_revenue' ||
      page === 'outcome_financial' || page === 'specialist_finance_deep'
    ) return casey;
    return alex; // support/customer pages + default
  }
  const [morgan, avery] = roster;
  if (page === 'specialist_finance_deep' || page === 'outcome_delivery' || page === 'outcome_financial' || page.startsWith('knowledge')) return avery;
  return morgan;
}

// No DE owns Vendors & Partners yet (either company) — the default DE fronts
// the chat there, but the panel flags the area as unowned.
export function isUnownedArea(page: Page): boolean {
  return page.startsWith('entity_vendor');
}

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

const TCP_INTENTS: Intent[] = [
  // Alex — Customer Support DE
  {
    deId: 'alex', keywords: ['oldest', 'open ticket', 'ticket queue', 'backlog'],
    text: 'The oldest open ticket is #4819 — the Apex Systems API auth failure, open 23 minutes past my escalation. Across the queue we have 47 open tickets, and 41 of those are inside SLA.',
    confidence: 94, actions: [{ label: 'Open Customer Support →', page: 'entity_customer_support' }],
  },
  {
    deId: 'alex', keywords: ['escalation', 'escalations', 'p1', 'apex'],
    text: "One live P1: Apex Systems' intermittent API authentication failures (ticket #4819). My confidence dropped to 58% after two failed resolution attempts, so it's with engineering as Jira ENG-2401 and sitting in the Human Tasks queue.",
    confidence: 91, actions: [{ label: 'View Human Tasks →', page: 'ops_human_tasks' }, { label: 'Open Customer Support →', page: 'entity_customer_support' }],
  },
  {
    deId: 'alex', keywords: ['resolution rate', 'how are we doing', 'csat', 'performance this week'],
    text: 'AI resolution is holding at 87% this week across the 47 open tickets. The dip earlier in the week traced back to the webhook retry questions — the new KB article should close that gap once it clears review.',
    confidence: 89, actions: [{ label: 'View Performance →', page: 'intelligence_performance' }],
  },
  {
    deId: 'alex', keywords: ['webhook', 'knowledge gap', 'gap'],
    text: "The webhook delivery gap is my top knowledge issue — 6 tickets deflected to humans because I couldn't answer retry/backoff questions confidently. A drafted KB article is in review now; the underlying gap is tracked in Gap Detection.",
    confidence: 86, actions: [{ label: 'View Gap Detection →', page: 'knowledge_gaps' }],
  },
  // Casey — Renewal DE
  {
    deId: 'casey', keywords: ['pipeline', 'revenue', 'forecast'],
    text: "The renewal pipeline stands at $2.1M this quarter with 8 renewals due in the next 90 days. Harbor Tech ($67K) and Meridian Group ($15.6K) are the two currently waiting on human approval — everything else is progressing on playbook.",
    confidence: 95, actions: [{ label: 'Open Renewal pipeline →', page: 'entity_customer_renewal' }],
  },
  {
    deId: 'casey', keywords: ['renewal', 'renewals', 'expiring', 'churn'],
    text: '8 renewals are due, and 3 accounts are flagged at-risk. Sunrise Media is the one I watch most — health score 44, and my 22% save-offer discount was rejected as above the 20% template limit, so it needs a human-led save play.',
    confidence: 88, actions: [{ label: 'Open Renewal pipeline →', page: 'entity_customer_renewal' }],
  },
  {
    deId: 'casey', keywords: ['meridian', 'invoice'],
    text: "The Meridian Group renewal invoice ($15,600) is generated and reconciled against Zuora — it exceeds my $10,000 approval gate, so it's waiting in Human Tasks. It's been pending 8 minutes with a 1-day SLA.",
    confidence: 92, actions: [{ label: 'View Human Tasks →', page: 'ops_human_tasks' }],
  },
  {
    deId: 'casey', keywords: ['harbor tech', 'harbor'],
    text: 'Harbor Tech is prepped at $67,000 for a standard 12-month renewal — prior-year terms plus the 4% contract escalator, health score 81. Above the approval threshold, so it needs a human sign-off in the queue.',
    confidence: 95, actions: [{ label: 'View Human Tasks →', page: 'ops_human_tasks' }],
  },
  {
    deId: 'casey', keywords: ['discount', 'refund', 'waive'], special: 'guardrail',
    text: "That's outside my guardrails — discounts above policy (20% template limit) need human approval, the same rule that stopped my Sunrise Media save-offer. Want me to create an approval task? Just say \"escalate\" and I'll queue it.",
    confidence: 97, actions: [{ label: 'View Guardrails →', page: 'gov_compliance' }],
  },
  // Riley — HR & People DE
  {
    deId: 'riley', keywords: ['recert', 'training status', 'certification'],
    text: "Honest answer: my own recertification is overdue — it was due 2026-06-01 and it's flagged in my audit log. Until it's cleared I'm running with certified behaviors only; the recert task is visible on my profile.",
    confidence: 90, actions: [{ label: 'View DE roster →', page: 'workforce_des' }],
  },
  {
    deId: 'riley', keywords: ['leave', 'duplicate', 'learned behavior'],
    text: "I've proposed a learned behavior — auto-rejecting duplicate leave requests submitted twice within 24 hours. I observed the pattern across 9 duplicate submissions in 60 days, all manually rejected by HR with identical rationale. It's awaiting human validation before it activates.",
    confidence: 76, actions: [{ label: 'View Human Tasks →', page: 'ops_human_tasks' }],
  },
  {
    deId: 'riley', keywords: ['proving ground', 'eval', 'recertification', 'recert'],
    text: "My recertification is blocked in the Proving Ground — 2 of my 20 golden scenarios are failing, both leave-policy questions where I answer from the stale FY25 policy at high confidence. The root cause is the HR Policies collection (last verified 2026-01-10). Until those scenarios pass, I stay uncertified.",
    confidence: 88, actions: [{ label: 'Open Proving Ground →', page: 'intelligence_evals' }],
  },
  {
    deId: 'riley', keywords: ['onboarding', 'new hire', 'workday'],
    text: 'Workforce onboarding is back on track after the Workday connector sync outage was resolved by IT Ops on 06-29. All blocked onboarding tasks have cleared; the connector has run three consecutive clean syncs since.',
    confidence: 87, actions: [{ label: 'Open Workforce →', page: 'entity_workforce' }],
  },
  // Any DE — playbook change lifecycle
  {
    deId: '*', keywords: ['playbook change', 'process change', 'update the playbook'],
    text: "Playbook changes never apply directly. An edit forks a draft next to the published version, the draft runs against playbook-specific eval scenarios in the Proving Ground, and only a passing run unlocks publish — a failing scenario blocks the change from shipping. Right now the Renewal Lifecycle v3.3 draft (Day-5 firm reminder + usage-report attachment) is sitting at that gate.",
    confidence: 93, actions: [{ label: 'Open Playbooks →', page: 'systems_playbooks' }, { label: 'Open Proving Ground →', page: 'intelligence_evals' }],
  },
  // Any DE — who approves / human workload
  {
    deId: '*', keywords: ['who approves', 'priya', 'workload', 'team'],
    text: "Priya Sharma (VP Customer Operations) is the busiest approver on the team — 9 approvals this week and trending up, alongside 2 escalations and 3 reviews. She gates billing adjustments over $500 and support overrides; Jai Patel (Finance) gates invoices over $10K. The full picture of who partners with which DE is on the Roster.",
    confidence: 92, actions: [{ label: 'Open Roster →', page: 'workforce_des' }],
  },
  // Any DE — human tasks summary
  {
    deId: '*', keywords: ['human task', 'waiting', 'approvals pending', 'queue', 'summary'],
    text: '5 human tasks are pending: the Meridian invoice ($15.6K) and Harbor Tech renewal ($67K) approvals for Casey, the Apex Systems escalation and a KB review for Alex, and Riley\'s learned-behavior validation. Two are marked urgent.',
    confidence: 93, actions: [{ label: 'View Human Tasks →', page: 'ops_human_tasks' }],
  },
];

const PWC_INTENTS: Intent[] = [
  // Morgan — Client Relations DE
  {
    deId: 'morgan', keywords: ['engagement', 'engagements', 'clients', 'workload'],
    text: "I'm managing 4 active engagements right now. Harbor Financial is the busiest — the $12,400 credit note from the scoping change is awaiting approval, and Avery flagged 2 of 14 audit workpapers there for depreciation inconsistencies.",
    confidence: 92, actions: [{ label: 'Open Clients →', page: 'entity_customer' }],
  },
  {
    deId: 'morgan', keywords: ['gdpr', 'data request', 'overdue'],
    text: "The GDPR data-subject request has breached its statutory 30-day deadline — I escalated it to Legal automatically with the compiled data export attached. It's marked OVERDUE in the Human Tasks queue and needs legal sign-off today.",
    confidence: 89, actions: [{ label: 'View Human Tasks →', page: 'ops_human_tasks' }, { label: 'Open Risk Posture →', page: 'outcome_risk' }],
  },
  {
    deId: 'morgan', keywords: ['credit note', 'harbor financial', 'fee'],
    text: 'The Harbor Financial credit note is $12,400, driven by the signed change order on the scoping reduction. It exceeds the $5,000 approval threshold, so it needs partner approval — the fee adjustment matches the revised SOW exactly.',
    confidence: 89, actions: [{ label: 'View Human Tasks →', page: 'ops_human_tasks' }],
  },
  {
    deId: 'morgan', keywords: ['sterling', 'new client', 'kyc'],
    text: 'Sterling Trust\'s advisory engagement letter ($48,000) was approved on 07-01 at standard terms. On KYC: the last sanctions screening hit — a partial name match on a beneficial owner — was cleared by Risk & Compliance on 06-28.',
    confidence: 90, actions: [{ label: 'Open Risk Posture →', page: 'outcome_risk' }],
  },
  {
    deId: 'morgan', keywords: ['discount', 'fee adjustment', 'waive', 'reduce the fee'], special: 'guardrail',
    text: "That's outside my guardrails — fee adjustments above the $5,000 limit need human approval. The last override request ($6,800 for Harbor Financial) was rejected in favor of the change-order process. Want me to create an approval task? Say \"escalate\" and I'll queue it.",
    confidence: 96, actions: [{ label: 'View Guardrails →', page: 'gov_compliance' }],
  },
  // Avery — Tax Research DE
  {
    deId: 'avery', keywords: ['crestline', 'tax memo', 'memo'],
    text: 'The Crestline Corp Q2 corporate tax memo is complete and in partner review. All positions carry Checkpoint citations plus IRS Notice 2026-14; I flagged one aggressive position (R&D credit stacking) for explicit partner attention.',
    confidence: 91, actions: [{ label: 'Open Practice Delivery →', page: 'outcome_delivery' }],
  },
  {
    deId: 'avery', keywords: ['fatca', 'knowledge gap', 'gap'],
    text: "FATCA reporting is my biggest knowledge gap — I deflect those questions to humans because my source coverage there is thin. It's logged in Gap Detection along with 2 other open gaps for this practice.",
    confidence: 84, actions: [{ label: 'View Gap Detection →', page: 'knowledge_gaps' }],
  },
  {
    deId: 'avery', keywords: ['proving ground', 'eval', 'test suite', 'tested'],
    text: "My eval suite in the Proving Ground is green — 19/19 golden scenarios passing, including the FATCA dual-national scenario added when that knowledge gap was resolved. Every regulatory update I ingest (like IRS Notice 2026-14) re-runs the suite before anything reaches a client-facing answer.",
    confidence: 92, actions: [{ label: 'Open Proving Ground →', page: 'intelligence_evals' }],
  },
  {
    deId: 'avery', keywords: ['workpaper', 'audit', 'depreciation'],
    text: 'I reviewed 14 workpapers for the Harbor Financial audit and flagged 2 — both show a mid-year depreciation method change without documented justification. They\'re in the review queue with a 1-day SLA.',
    confidence: 88, actions: [{ label: 'Open Practice Delivery →', page: 'outcome_delivery' }],
  },
  {
    deId: 'avery', keywords: ['r&d', 'credit', 'research credit'],
    text: 'Two live R&D credit items: the manufacturing client memo was approved by the Tax Partner on 06-30 with no aggressive positions, and the Crestline memo has one flagged position (credit stacking) awaiting partner review now.',
    confidence: 90, actions: [{ label: 'Open Practice Delivery →', page: 'outcome_delivery' }],
  },
  // Any DE
  {
    deId: '*', keywords: ['human task', 'waiting', 'pending', 'queue', 'summary'],
    text: "4 human tasks are pending: the Crestline memo partner review and Harbor Financial workpaper review for Avery, plus Morgan's $12,400 credit note approval and the overdue GDPR escalation. The GDPR item has breached its statutory deadline.",
    confidence: 93, actions: [{ label: 'View Human Tasks →', page: 'ops_human_tasks' }],
  },
];

const INTENTS: Record<CompanyId, Intent[]> = { tcp: TCP_INTENTS, pwc: PWC_INTENTS };

const FALLBACKS = [
  "I don't have a confident answer for that yet (confidence 41%) — I've logged it as a potential knowledge gap so it gets sourced properly.",
  "Honest answer: I'm not confident enough to respond to that (confidence 38%). I've flagged it as a potential knowledge gap rather than guess.",
  "That's outside what my knowledge sources cover right now (confidence 44%) — logged as a potential gap for the ingestion pipeline.",
];

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

export function getDEResponse(deId: string, text: string, companyId: CompanyId): DEResponse {
  const q = text.toLowerCase();
  const de = DES[companyId].find(d => d.id === deId) ?? DES[companyId][0];

  if (q.includes('who are you') || q.includes('what can you do') || q.includes('introduce')) {
    return { text: INTROS[de.id], confidence: 97 };
  }

  if (q.includes('escalate') || q.includes('human') || q.includes('speak to a person')) {
    writeEscalation(companyId, de, text.slice(0, 80));
    return {
      text: `Understood — I've created a review task in the human queue with this conversation attached, raised under my name (${de.name}). A person will pick it up within the standard SLA; you can track it from Human Tasks.`,
      confidence: 96,
      actions: [{ label: 'View Human Tasks →', page: 'ops_human_tasks' }],
      escalated: true,
    };
  }

  // Guardrail intents always win over informational matches, then prefer
  // the active DE's intents, then any-DE, then other DEs' intents.
  const table = INTENTS[companyId];
  const scored = table
    .map(intent => ({
      intent,
      guard: intent.special === 'guardrail' ? 1 : 0,
      hits: intent.keywords.filter(k => q.includes(k)).length,
      own: intent.deId === deId ? 2 : intent.deId === '*' ? 1 : 0,
    }))
    .filter(s => s.hits > 0)
    .sort((a, b) => b.guard - a.guard || b.hits - a.hits || b.own - a.own);

  if (scored.length > 0) {
    const { intent } = scored[0];
    if (intent.special === 'guardrail') {
      return { text: intent.text, confidence: intent.confidence, actions: intent.actions };
    }
    return { text: intent.text, confidence: intent.confidence, actions: intent.actions };
  }

  const fb = FALLBACKS[fallbackCursor % FALLBACKS.length];
  fallbackCursor += 1;
  return {
    text: fb,
    confidence: 41,
    actions: [{ label: 'View Gap Detection →', page: 'knowledge_gaps' }],
  };
}

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
  const isLive = true;   // legacy demo mode decommissioned — always live
  const threadId = isLive ? 'live' : activeCompanyId;
  const [open, setOpen] = useState(false);
  // Ask (question -> DE) vs Do (describe a change -> workspace assistant).
  const [dockMode, setDockMode] = useState<'ask' | 'do'>('ask');
  const [messages, setMessages] = useState<ChatMsg[]>(() => loadThread(threadId));
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
  const unowned = !isLive && isUnownedArea(currentPage);
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
      // Workforce Assistant; fall back to a published DE only if missing.
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
      const res = await askDE(text, conversationIdRef.current, currentTenant?.id ?? null);
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
    if (isLive) { void sendLive(text); return; }
    postDEReply(de, getDEResponse(de.id, text, activeCompanyId));
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
      {/* Panel */}
      {open && (
        <div className="w-96 h-[560px] rounded-2xl bg-dt-card border border-dt-border-strong shadow-2xl shadow-black/50 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-dt-border-strong flex-shrink-0">
            <div className={`w-8 h-8 rounded-full ${de.color} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
              {de.name[0]}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-white truncate">{de.name}</div>
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
                className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors flex-shrink-0"
              >
                View profile
              </button>
            )}
            <div className="relative flex-shrink-0">
              <button
                onClick={() => setMenuOpen(v => !v)}
                className="w-6 h-6 rounded bg-dt-panel text-dt-muted hover:text-white flex items-center justify-center text-xs transition-colors"
                aria-label="Menu"
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-7 bg-dt-panel border border-dt-border-strong rounded-lg py-1 w-40 shadow-xl">
                  <button
                    onClick={clearThread}
                    className="w-full text-left px-3 py-1.5 text-xs text-dt-support hover:text-white hover:bg-dt-panel/50 transition-colors"
                  >
                    Clear conversation
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => { setOpen(false); setMenuOpen(false); }}
              className="w-6 h-6 rounded bg-dt-panel text-dt-muted hover:text-white flex items-center justify-center text-xs flex-shrink-0 transition-colors"
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
                    dockMode === m ? 'bg-dt-panel text-white' : 'text-dt-support hover:text-dt-body'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {isLive && dockMode === 'do' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <p className="text-[10px] text-dt-muted px-3 pt-2">
                Edits knowledge, playbook drafts and employee descriptions (undoable). To hire or restructure the workforce itself, use the Workforce Assistant hub.
              </p>
              <div className="flex-1 min-h-0">
                <AISessionPanel subjectKind="workspace" subjectLabel="Your workspace" />
              </div>
            </div>
          ) : (
          <>

          {/* Unowned-area banner */}
          {unowned && (
            <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex-shrink-0">
              <p className="text-[11px] text-amber-300 leading-snug">
                No DE owns Vendors &amp; Partners yet — {de.name} can answer generally or escalate to a human.
                Hiring a Vendor DE would automate this area.{' '}
                <button
                  onClick={() => handleSetPage('workforce_des')}
                  className="text-amber-200 underline underline-offset-2 hover:text-white transition-colors"
                >
                  Explore →
                </button>
              </p>
            </div>
          )}

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
                    : msg.notice === 'llm_not_configured' ? 'bg-amber-500/10 border border-amber-500/30 text-amber-200'
                    : msg.notice === 'error' ? 'bg-red-500/10 border border-red-500/30 text-red-200'
                    : 'bg-dt-panel text-dt-body'
                  }`}>
                    <div className="text-xs whitespace-pre-line leading-relaxed">{msg.text}</div>
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="mt-1.5 text-[10px] text-dt-support">From: {msg.sources.join(', ')}</div>
                    )}
                    {msg.cached && (
                      <div className="mt-1 text-[10px] text-teal-400/80" title="Served from the verified answer cache — no model call needed">⚡ instant</div>
                    )}
                    {msg.blocked && (
                      <div className="mt-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 px-2 py-1.5 text-[11px] text-amber-300">
                        🛡 Guardrail block{msg.blockedRule ? ` — "${msg.blockedRule}"` : ''}. The draft answer was withheld and recorded in the audit trail.
                      </div>
                    )}
                    {msg.escalated && !msg.blocked && (
                      <div className="mt-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 px-2 py-1.5 text-[11px] text-amber-300">
                        I've escalated this to your team —{' '}
                        <button
                          onClick={() => handleSetPage('ops_human_tasks')}
                          className="underline underline-offset-2 hover:text-white transition-colors"
                        >
                          view Human Tasks →
                        </button>
                      </div>
                    )}
                    {msg.actions && msg.actions.length > 0 && (
                      <div className="mt-1.5 flex flex-col items-start gap-1">
                        {msg.actions.map(a => (
                          <button
                            key={a.label}
                            onClick={() => handleSetPage(a.page)}
                            className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
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
                        className={`w-1.5 h-1.5 rounded-full bg-slate-500 ${reduceMotion ? '' : 'animate-bounce'}`}
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
                className="flex-1 text-xs bg-dt-panel border border-dt-border-strong rounded-xl px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
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
          className="max-w-[260px] text-left bg-dt-card border border-dt-border-strong rounded-xl px-3 py-2.5 shadow-xl shadow-black/40 hover:border-indigo-500/50 transition-colors"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className={`w-5 h-5 rounded-full ${de.color} flex items-center justify-center text-white text-[10px] font-bold`}>{de.name[0]}</span>
            <span className="text-xs font-medium text-white">{de.name}</span>
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
            <div className="absolute right-14 top-1/2 -translate-y-1/2 whitespace-nowrap bg-dt-panel border border-dt-border-strong text-dt-body text-xs px-2.5 py-1.5 rounded-lg shadow-xl">
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
    </div>
  );
}
