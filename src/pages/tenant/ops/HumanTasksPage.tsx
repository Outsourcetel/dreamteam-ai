import React, { useState, useEffect } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { useIsTenantManager } from '../../../lib/useRoleGate';
import { PageHeader } from '../../../components/ui';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { loadChatEscalations, setChatEscalationStatus, chatEscalationAge } from '../../../lib/chatEscalations';
import type { GatedExecutionPreview } from '../../../lib/connectorApi';
import { listHumanTasks, decideHumanTask, withdrawHumanTask, withdrawHumanTasks, previewDecideHumanTasks, decideHumanTasks, listDecisionGroups, toggleChecklistItem, listOpenStalenessEscalations, CustomerApiError, setImprovementPublishScope, getImprovementRoleInfo, getImprovementProposal, getImprovementReviewSignals, DECISION_REASON_CODES, getBlockedWorkForTask, rerouteEscalation, retryAnswerableBlockers, getPendingConversationDraft } from '../../../lib/customerApi';
import type { BlockedWork, PendingConversationDraft } from '../../../lib/customerApi';
import type { DecisionPreview, DecisionGroup } from '../../../lib/customerApi';
import type { DecisionCapture, DecisionReasonCode } from '../../../lib/customerApi';
import type { DBHumanTask, StalenessEscalation } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
// Design system is law (docs/design-system.md): the blocked-work panel uses
// Chip and INPUT_CLS rather than another hand-rolled badge/input, which the
// drift detector counts and fails on.
import { Chip, INPUT_CLS, TabBar, Button, DecisionCard } from '../../../design/primitives';
import { listDigitalEmployees } from '../../../lib/digitalEmployeesApi';
import { listAssignablePeople } from '../../../lib/orgApi';
// Advisory briefs (mig 705): rail-computed evidence + risk rank per pending
// approval. ⛔ ADVISORY ONLY — nothing from this import may pre-select,
// pre-fill or trigger a decision; the decide path below is untouched.
import { listApprovalBriefs, briefSortKey, BRIEF_CHIP } from '../../../lib/approvalBriefsApi';
import type { ApprovalBrief } from '../../../lib/approvalBriefsApi';
// Task 6 (trust-promotion program, 2026-08-21): "the evidence is on the card,
// and thin evidence says so". getTrustPolicyById reads the pending_evidence
// snapshot a trust_promotion task points at; trustPromotionPresentation turns
// it into copy without ever touching supabase itself (pure, unit-tested —
// tests/trust-promotion.test.ts).
import { getTrustPolicyById } from '../../../lib/trustApi';
import type { TrustPolicy } from '../../../lib/trustApi';
import { trustPromotionCardCopy, isThinTrustEvidence, extractPolicyEvidence, detailIsRedundantBesideCard } from '../../../lib/trustPromotionPresentation';

// ── Types ─────────────────────────────────────────────────────────

type TaskType = 'approval_gate' | 'review_gate' | 'escalation' | 'override' | 'training_feedback' | 'trust_promotion' | 'trust_demotion_notice' | 'checklist' | 'knowledge_revision' | 'inquiry_review' | 'action_approval';
type TaskStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'expired';

interface OpsTask {
  id: string;
  type: TaskType;
  title: string;
  de: string;
  detail: string;
  age: string;
  urgent: boolean;
  status: TaskStatus;
  context: string;
  reasoning: string;
  confidence?: number;
  relatedPage: Page;
  relatedLabel: string;
  slaRemaining: string;   // for pending tasks
  resolvedBy?: string;    // for historical tasks
  resolvedAt?: string;
  viaChat?: boolean;      // raised from the DE chat dock
}

// ── Seed data — pending rows mirror DashboardPage task seeds EXACTLY ─

const TCP_TASKS: OpsTask[] = [
  {
    id: 't1', type: 'approval_gate', title: 'Invoice approval — Meridian Group', de: 'Casey', detail: '$15,600', age: '8 min', urgent: true, status: 'pending',
    context: 'Casey generated the renewal invoice for Meridian Group ($15,600). Amount exceeds the $10,000 approval-gate threshold for the Renewal DE.',
    reasoning: 'Contract terms match the signed renewal order. Subscription and overage amounts reconciled against Zuora. No discount applied.',
    confidence: 92, relatedPage: 'entity_customer_renewal', relatedLabel: 'Renewal & Expansion', slaRemaining: '23h 52m of 1-day SLA',
  },
  {
    id: 't2', type: 'escalation', title: 'Complex bug — API auth failure', de: 'Alex', detail: 'Apex Systems', age: '23 min', urgent: true, status: 'pending',
    context: 'Alex escalated ticket #4819 — intermittent API authentication failures affecting Apex Systems. Reproduction steps and environment details attached.',
    reasoning: 'Confidence fell to 58%, below the 55% escalation threshold after two failed resolution attempts. Linked Jira issue ENG-2401 created.',
    confidence: 58, relatedPage: 'entity_customer_support', relatedLabel: 'Customer Support', slaRemaining: '1d 23h of 2-day SLA',
  },
  {
    id: 't3', type: 'review_gate', title: 'KB article review — Rate limiting guide', de: 'Alex', detail: '', age: '1 hr', urgent: false, status: 'pending',
    context: 'Alex drafted a knowledge-base article "Rate limiting guide" from the resolved gap "API rate limit tiers after upgrade". Awaiting human review before publication.',
    reasoning: 'Draft compiled from Jira ENG-2380 (authoritative tier table) and ticket #4688. All figures cited from engineering sources.',
    confidence: 88, relatedPage: 'knowledge_gaps', relatedLabel: 'Knowledge Gaps', slaRemaining: '23h of 1-day SLA',
  },
  {
    id: 't4', type: 'approval_gate', title: 'Contract renewal — Harbor Tech', de: 'Casey', detail: '$67,000', age: '2 hrs', urgent: false, status: 'pending',
    context: 'Casey prepared the Harbor Tech renewal at $67,000 with standard 12-month terms. Above the $10,000 approval threshold.',
    reasoning: 'Health score 81 (healthy). No discount requested. Terms identical to prior year plus 4% uplift per contract escalator.',
    confidence: 95, relatedPage: 'entity_customer_renewal', relatedLabel: 'Renewal & Expansion', slaRemaining: '22h of 1-day SLA',
  },
  {
    id: 't5', type: 'training_feedback', title: 'DE response flagged for review', de: 'Riley', detail: '', age: '3 hrs', urgent: false, status: 'pending',
    context: 'Riley proposed a learned behavior awaiting human validation: "When leave request is submitted by same employee twice in 24 hrs, auto-reject duplicate." All learned behaviors require human approval before activation.',
    reasoning: 'Pattern observed across 9 duplicate leave submissions in the last 60 days, each manually rejected by HR with identical rationale.',
    confidence: 76, relatedPage: 'workforce_des', relatedLabel: "Riley's profile — Audit & Memory", slaRemaining: '4d 21h of 5-day SLA',
  },
  // ── Historical ──
  {
    id: 'h1', type: 'approval_gate', title: 'Invoice approval — Northwind Labs', de: 'Casey', detail: '$22,400', age: '1 day', urgent: false, status: 'approved',
    context: 'Renewal invoice for Northwind Labs.', reasoning: 'Amounts reconciled against Zuora subscription.', confidence: 94,
    relatedPage: 'entity_customer_renewal', relatedLabel: 'Renewal & Expansion', slaRemaining: '—', resolvedBy: 'J. Patel (Finance)', resolvedAt: '2026-07-02 15:40',
  },
  {
    id: 'h2', type: 'review_gate', title: 'KB article review — Webhook retry logic', de: 'Alex', detail: '', age: '2 days', urgent: false, status: 'approved',
    context: 'Draft article covering webhook delivery retries, backoff, and replay.', reasoning: 'Compiled from L2 tickets and ENG-2214 spec.', confidence: 90,
    relatedPage: 'knowledge_gaps', relatedLabel: 'Knowledge Gaps', slaRemaining: '—', resolvedBy: 'M. Osei (Support Lead)', resolvedAt: '2026-07-01 11:20',
  },
  {
    id: 'h3', type: 'override', title: 'Discount override — Sunrise Media renewal', de: 'Casey', detail: '22% requested', age: '3 days', urgent: false, status: 'rejected',
    context: 'Casey requested an override to offer 22% discount, above the 20% template limit.', reasoning: 'At-risk account with health score 44; save-offer economics justified per playbook.', confidence: 71,
    relatedPage: 'gov_compliance', relatedLabel: 'Compliance & Guardrails', slaRemaining: '—', resolvedBy: 'VP Sales', resolvedAt: '2026-06-30 09:15',
  },
  {
    id: 'h4', type: 'escalation', title: 'Workday connector failure — sync outage', de: 'Riley', detail: '', age: '4 days', urgent: false, status: 'completed',
    context: 'Repeated Workday sync timeouts blocked onboarding tasks.', reasoning: 'Three consecutive failures triggered the error-rate escalation rule.',
    relatedPage: 'systems_connectors', relatedLabel: 'Connectors', slaRemaining: '—', resolvedBy: 'IT Ops', resolvedAt: '2026-06-29 16:05',
  },
  {
    id: 'h5', type: 'training_feedback', title: 'Response tone feedback — billing replies', de: 'Alex', detail: '', age: '6 days', urgent: false, status: 'completed',
    context: 'Customer flagged an overly terse billing response; routed to the training team.', reasoning: 'CSAT comment triggered the training-feedback touchpoint.',
    relatedPage: 'workforce_des', relatedLabel: "Alex's profile", slaRemaining: '—', resolvedBy: 'Training Team', resolvedAt: '2026-06-27 10:30',
  },
];

const PWC_TASKS: OpsTask[] = [
  {
    id: 't1', type: 'review_gate', title: 'Partner review — Crestline tax memo Q2', de: 'Avery', detail: '', age: '14 min', urgent: true, status: 'pending',
    context: 'Avery completed the Q2 corporate tax memo for Crestline Corp. All memos require partner review before client delivery.',
    reasoning: 'Positions supported by Checkpoint citations and IRS Notice 2026-14. One aggressive position flagged for partner attention (R&D credit stacking).',
    confidence: 91, relatedPage: 'outcome_delivery', relatedLabel: 'Practice Delivery', slaRemaining: '23h 46m of 1-day SLA',
  },
  {
    id: 't2', type: 'approval_gate', title: 'Credit note approval', de: 'Morgan', detail: '$12,400', age: '1 hr', urgent: false, status: 'pending',
    context: 'Morgan prepared a $12,400 credit note following a scoping change on the Harbor Financial engagement. Above the $5,000 approval threshold.',
    reasoning: 'Scope reduction documented in the signed change order. Fee adjustment matches the revised statement of work.',
    confidence: 89, relatedPage: 'outcome_financial', relatedLabel: 'Financial Health', slaRemaining: '23h of 1-day SLA',
  },
  {
    id: 't3', type: 'escalation', title: 'GDPR data request — response overdue', de: 'Morgan', detail: '', age: '2 hrs', urgent: true, status: 'pending',
    context: 'A client data-subject request has passed its statutory deadline. Morgan escalated to Legal with the compiled data export ready for review.',
    reasoning: 'Statutory 30-day window breached; escalation rule fired automatically. Response draft attached, awaiting legal sign-off.',
    relatedPage: 'outcome_risk', relatedLabel: 'Risk Posture', slaRemaining: 'OVERDUE — statutory deadline passed',
  },
  {
    id: 't4', type: 'review_gate', title: 'Audit workpaper review — Harbor Financial', de: 'Avery', detail: '', age: '3 hrs', urgent: false, status: 'pending',
    context: 'Avery reviewed 14 workpapers for the Harbor Financial audit; 2 flagged with inconsistent depreciation schedules for human review.',
    reasoning: 'Depreciation method changed mid-year without documented justification in 2 of 14 workpapers.',
    confidence: 88, relatedPage: 'outcome_delivery', relatedLabel: 'Practice Delivery', slaRemaining: '21h of 1-day SLA',
  },
  // ── Historical ──
  {
    id: 'h1', type: 'approval_gate', title: 'Engagement letter — Sterling Trust advisory', de: 'Morgan', detail: '$48,000', age: '2 days', urgent: false, status: 'approved',
    context: 'New advisory engagement letter for Sterling Trust.', reasoning: 'Standard terms; fees within partner-approved rate card.', confidence: 93,
    relatedPage: 'entity_customer', relatedLabel: 'Clients', slaRemaining: '—', resolvedBy: 'Engagement Partner', resolvedAt: '2026-07-01 14:20',
  },
  {
    id: 'h2', type: 'review_gate', title: 'Tax memo — R&D credit analysis', de: 'Avery', detail: '', age: '3 days', urgent: false, status: 'approved',
    context: 'R&D credit memo for a manufacturing client.', reasoning: 'All positions cited; no aggressive positions taken.', confidence: 94,
    relatedPage: 'outcome_delivery', relatedLabel: 'Practice Delivery', slaRemaining: '—', resolvedBy: 'Tax Partner', resolvedAt: '2026-06-30 16:45',
  },
  {
    id: 'h3', type: 'escalation', title: 'KYC screening hit — new client entity', de: 'Morgan', detail: '', age: '5 days', urgent: false, status: 'completed',
    context: 'Sanctions screening returned a partial name match on a beneficial owner.', reasoning: 'Any screening hit routes to Risk & Compliance per playbook.',
    relatedPage: 'outcome_risk', relatedLabel: 'Risk Posture', slaRemaining: '—', resolvedBy: 'Risk & Compliance', resolvedAt: '2026-06-28 11:10',
  },
  {
    id: 'h4', type: 'override', title: 'Fee adjustment override — Harbor Financial', de: 'Morgan', detail: '$6,800 requested', age: '8 days', urgent: false, status: 'rejected',
    context: 'Fee adjustment above the $5,000 limit requested for scope creep absorption.', reasoning: 'Client relationship value cited; however change-order process required instead.', confidence: 64,
    relatedPage: 'gov_compliance', relatedLabel: 'Compliance & Guardrails', slaRemaining: '—', resolvedBy: 'Managing Partner', resolvedAt: '2026-06-25 09:30',
  },
];

const SEED_TASKS: Record<CompanyId, OpsTask[]> = { tcp: TCP_TASKS, pwc: PWC_TASKS };

// ── Badges — same palette as DashboardPage ────────────────────────

function taskBadgeStyle(type: TaskType): string {
  if (type === 'approval_gate') return 'bg-dt-accent-soft text-dt-accent-text';
  if (type === 'review_gate') return 'bg-dt-info-soft text-dt-info';
  if (type === 'escalation') return 'bg-dt-danger-soft text-dt-danger';
  if (type === 'override') return 'bg-dt-warn-soft text-dt-warn';
  if (type === 'trust_promotion') return 'bg-dt-ok-soft text-dt-ok';
  if (type === 'trust_demotion_notice') return 'bg-dt-danger-soft text-dt-danger';
  if (type === 'checklist') return 'bg-teal-600 text-teal-100';
  if (type === 'knowledge_revision') return 'bg-dt-warn-soft text-dt-warn';
  if (type === 'inquiry_review') return 'bg-dt-info-soft text-dt-info';
  if (type === 'action_approval') return 'bg-fuchsia-600 text-fuchsia-100';
  return 'bg-dt-border-strong text-dt-support';
}

function taskBadgeLabel(type: TaskType): string {
  if (type === 'approval_gate') return 'APPROVAL';
  if (type === 'review_gate') return 'REVIEW';
  if (type === 'escalation') return 'ESCALATION';
  if (type === 'override') return 'OVERRIDE';
  if (type === 'trust_promotion') return 'TRUST ▲';
  if (type === 'trust_demotion_notice') return 'TRUST ▼';
  if (type === 'checklist') return 'CHECKLIST';
  if (type === 'knowledge_revision') return 'KNOWLEDGE';
  if (type === 'inquiry_review') return 'INQUIRY';
  if (type === 'action_approval') return 'ACTION';
  return 'FEEDBACK';
}

function statusBadge(status: TaskStatus) {
  const styles: Record<TaskStatus, string> = {
    pending: 'bg-amber-500/15 text-amber-400',
    approved: 'bg-emerald-500/15 text-emerald-400',
    rejected: 'bg-red-500/15 text-red-400',
    completed: 'bg-dt-border-strong text-dt-support',
    // Approved, but never carried out, and now voided (migration 642). Not a
    // rejection — nobody said no — so it must not wear the rejection colour.
    expired: 'bg-dt-border-strong text-dt-support',
  };
  const labels: Record<TaskStatus, string> = {
    pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
    completed: 'Completed', expired: 'Expired — never ran',
  };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${styles[status]}`}>{labels[status]}</span>;
}

// Stalled-work badge (migration 042 watchdog) — a plain-language, tier-
// aware chip distinguishing "this task exists because a Digital
// Employee raised it" from "this task exists because NOTHING happened
// for too long and the watchdog noticed." Same badge regardless of
// which target_kind (onboarding project or a pending review/approval
// task) triggered it — the tier is what matters to a human glancing
// at the queue, not the underlying table.
function stalledBadge(tier: StalenessEscalation['tier']) {
  if (tier === 'breach') {
    return <Chip tone="danger" title="Past the breach threshold — this has gone stale for longer than policy allows.">Nothing has happened in too long</Chip>;
  }
  return <Chip tone="warn" title="Past the warning threshold — nothing has happened on this in a while.">Gone quiet</Chip>;
}

/** N4 (founder decision, block 4): ONE queue, work blockers first.
 *
 *  125 of this workspace's 175 pending items are support-chat escalations. An
 *  undifferentiated merge buries the 45 work blockers — and those are the ones
 *  where an answer restarts frozen work, because since mig 483 a decision on
 *  them actually moves the work item. Nothing is hidden; the queue simply opens
 *  where the consequence is. */
type Scope = 'work' | 'chat' | 'all';
// A phone call is a conversation. Callback tasks (mig 577) belong beside chat
// escalations rather than under "Everything" — landing only there would have
// left a caller who was PROMISED a callback invisible on the tab people
// actually open, which is the defect mig 577 exists to fix.
const CONVERSATION_TABLES = ['de_conversations', 'voice_messages'];
// ⚠ "Work that's stuck" is the CATCH-ALL, not a second allow-list.
//
// Both scopes used to be allow-lists, so anything whose related_table was in
// neither — or null — appeared ONLY under "Both". Measured on the founder's
// workspace: 32 stuck + 1 question, but 38 in total. FIVE approvals reachable
// only by clicking the third tab, in a queue whose own comment two lines up
// promises "nothing is hidden".
//
// An allow-list on both sides means every future table type silently joins
// them. The two views ask "is my workforce stuck?" and "did somebody ask a
// question?", and anything that is not a question IS stuck work — so that side
// takes everything left over and the counts always reconcile.
const inScope = (t: DBHumanTask, s: Scope) =>
  s === 'all' ? true
    : s === 'chat' ? CONVERSATION_TABLES.includes(String(t.related_table ?? ''))
    : !CONVERSATION_TABLES.includes(String(t.related_table ?? ''));

const FILTERS: { id: TaskType | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'approval_gate', label: 'Approvals' },
  { id: 'review_gate', label: 'Reviews' },
  { id: 'escalation', label: 'Escalations' },
  { id: 'override', label: 'Overrides' },
  { id: 'training_feedback', label: 'Feedback' },
  { id: 'checklist', label: 'Checklists' },
];

// ── LIVE mode: real human_tasks from Supabase ─────────────────────

function taskAge(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'}`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function LiveHumanTasks({ setPage }: { setPage: (p: Page) => void }) {
  const [tasks, setTasks] = useState<DBHumanTask[]>([]);
  // Advisory briefs keyed by task id. An empty map means "no advice", never
  // "safe" — the queue renders identically without them.
  const [briefs, setBriefs] = useState<Map<string, ApprovalBrief>>(new Map());
  const [staleness, setStaleness] = useState<Map<string, StalenessEscalation>>(new Map());
  // Owner names. assigned_user_id holds a user id; without this map the queue
  // would show a uuid or nothing at all, which is how a populated column still
  // reads as "unassigned" to the person working it.
  const [peopleById, setPeopleById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ⚠ WHAT THE DECISION ACTUALLY CAUSED (F-6). Approving a gated reply now
  // genuinely sends it (mig 721), so this page must be able to say when it
  // did NOT. `ok` false renders the same amber a refusal does — a send that
  // silently failed is not a quieter kind of success.
  const [outcome, setOutcome] = useState<{ text: string; ok: boolean } | null>(null);
  // The gated reply waiting on the selected task's conversation, so the
  // button can promise a send only when there is one to send.
  const [replyDraft, setReplyDraft] = useState<PendingConversationDraft | null | undefined>(null);
  const [filter, setFilter] = useState<TaskType | 'all'>('all');
  // Opens on work, per N4. Chat is one click away, never hidden.
  const [scope, setScope] = useState<Scope>('work');
  const [stalledOnly, setStalledOnly] = useState(false);
  // WHAT STILL NEEDS YOU vs what is already settled. This page listed pending,
  // approved, rejected and completed in one undifferentiated column, so the
  // handful of decisions actually waiting were buried in everything ever
  // decided. Defaults to 'needs_you' because that is why anyone opens this page;
  // the decided history is one click away, not gone.
  const [decision, setDecision] = useState<'needs_you' | 'decided' | 'all'>('needs_you');
  // Whose queue. 408 of 412 pending tasks carry an assigned_user_id, so this
  // is a real axis and not a mostly-empty one — measured before it was built.
  // 'all' rather than defaulting to the viewer: a manager opening this page to
  // see what their team is sitting on should not have to find the control
  // first.
  const [owner, setOwner] = useState<string>('all');
  // Bulk withdraw. Ids rather than tasks: the list re-fetches after every
  // decision, and holding stale task objects across that would withdraw a
  // snapshot rather than what is on screen.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [withdrawing, setWithdrawing] = useState(false);
  // Batch decide (mig 795). The preview is held separately from the commit
  // on purpose: seeing what will refuse BEFORE approving 45 things is the
  // whole point, and a single button that previews-then-commits would take
  // that choice away.
  const [batchPreview, setBatchPreview] = useState<DecisionPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [batchDeciding, setBatchDeciding] = useState(false);
  // What is stranded behind the queue (mig 800). Loaded once alongside the
  // tasks: it answers 'which of these 413 restarts an employee', which the
  // task rows themselves cannot say.
  const [groups, setGroups] = useState<DecisionGroup[]>([]);
  // A preview describes ONE selection. Change the selection and it is stale,
  // so it goes — showing '23 will go through' next to a different 23 would be
  // worse than showing nothing.
  useEffect(() => { setBatchPreview(null); }, [picked]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [gatedExec, setGatedExec] = useState<GatedExecutionPreview | null>(null);
  // Task 6: the trust policy a pending trust_promotion task points at, and
  // the employee it names (de_id resolved separately — human_tasks carries
  // no de_id for this type; only related_table/related_id, to trust_policies).
  // Raw data only, same discipline as gatedExec — the card copy is derived
  // inline below, next to gatedDraft, rather than stored.
  // ⚠ FIX ROUND 2 (coordinator review): tri-state, not a resolved value plus
  // a separate boolean. `undefined` = still looking (the ONLY state on
  // first paint, and the state a reset lands on before its own fetch has had
  // a chance to run) · `null` = checked, no policy linked · an object =
  // found. A `TrustPolicy | null` initialised to `null` cannot be told apart
  // from "checked, genuinely nothing" — which is exactly the gap that let
  // Approve render enabled, for one real frame, beside a false "No trust
  // policy is linked" notice. Same fix as gatedReply's `draft` two hundred
  // lines below, which already uses this exact three-state shape for the
  // same reason (its own comment: "`undefined` = still looking").
  const [trustPolicy, setTrustPolicy] = useState<TrustPolicy | null | undefined>(undefined);
  const [trustEmployeeName, setTrustEmployeeName] = useState<string | null>(null);
  const [trustLoadError, setTrustLoadError] = useState<string | null>(null);
  const [impRole, setImpRole] = useState<{ archetype: string; peers: number } | null>(null);
  const [impScope, setImpScope] = useState<'de' | 'role'>('de');
  // Entity-guard signals (fix-pass 2026-07-28): a proposal naming a live
  // entity of this workspace may be the self-denial class — the KB missing
  // documentation, not the answer being wrong. Loud banner + quiet chip.
  const [impSignals, setImpSignals] = useState<{ entityMatch: { name: string; kind: string } | null; outcomeKind: 'kb_missing' | 'wrong_answer' | null } | null>(null);
  // docs/34: a rejection must say why. Held here rather than in the decide()
  // call so the picker can appear inline before the decision is committed —
  // asking after the fact is how you get "ok" and "no".
  const [rejecting, setRejecting] = useState(false);
  const [reasonCode, setReasonCode] = useState<DecisionReasonCode | ''>('');
  const [reasonNote, setReasonNote] = useState('');
  // The typed answer that RESUMES the blocked work. mig 483 appends
  // decision_note into the work item's payload.detail, which is the exact
  // field the next run reads — so this box is the only channel by which a
  // human's guidance reaches a stalled employee. Before it existed, an
  // approval carried no words at all and the employee resumed knowing nothing
  // more than that someone had said yes.
  const [instruction, setInstruction] = useState('');
  const [blocked, setBlocked] = useState<BlockedWork | null>(null);
  // N4's third disposition (mig 504).
  const [rerouting, setRerouting] = useState(false);
  const [rerouteTo, setRerouteTo] = useState('');
  const [rerouteNote, setRerouteNote] = useState('');
  const [colleagues, setColleagues] = useState<{ id: string; name: string }[]>([]);
  const [retrying, setRetrying] = useState(false);
  // Matches retry_answerable_blockers' own gate: owner, admin, manager.
  const canRetryBlockers = useIsTenantManager();
  const [retryNote, setRetryNote] = useState<string | null>(null);
  // docs/34 — approve WITH EDITS. The correction is the valuable half of the
  // learning loop: it produces an (original, corrected) pair written by the
  // person who knows, at the moment of work. Held as the proposal actually
  // being published (`proposal`) plus the approver's working copy (`editText`)
  // so the before-half is exact rather than reconstructed from the task blob.
  const [proposal, setProposal] = useState<{ title: string; content: string } | null>(null);
  const [editText, setEditText] = useState('');
  const [editing, setEditing] = useState(false);
  // The gated-action twin of the same request (built in the branch stream):
  // an action_approval's draft (params.body/note) is the exact text the
  // approved re-entry executes, so editing it corrects BOTH what gets sent
  // and the learning pair. Separate state from the improvement editor above
  // — that one commits through the main Approve button; this one brings its
  // own approve control and hides the main row while open.
  const [draftEditing, setDraftEditing] = useState(false);
  const [draftEditText, setDraftEditText] = useState('');
  const [draftReasonCode, setDraftReasonCode] = useState<DecisionReasonCode | ''>('');
  const [draftNote, setDraftNote] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await listHumanTasks());
      setMissingTables(false);
      // Best-effort: the "Stalled work" badge is a nice-to-have overlay,
      // not core task-list functionality — a workspace that hasn't
      // applied migration 042 yet (or any transient error) should still
      // show the task list, just without the stalled badges.
      try { setStaleness(await listOpenStalenessEscalations()); } catch { /* noop */ }
      // Best-effort for the same reason: the queue is fully usable without the
      // impact strip, and a workspace that has not applied mig 800 should not
      // lose its task list over a missing RPC.
      try { setGroups(await listDecisionGroups()); } catch { /* the queue works without it */ }
      // Advisory overlay. The server recomputes every brief on this call, so
      // what renders is current — a failure just means no advice today.
      try { setBriefs(await listApprovalBriefs()); } catch { /* the queue works without briefs */ }
      try {
        const ppl = await listAssignablePeople();
        setPeopleById(new Map(ppl.map(p => [p.user_id, p.full_name || 'Unnamed user'])));
      } catch { /* the queue is still usable without owner names */ }
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load tasks.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A human approving a gated action (e.g. a customer-visible reply)
  // must see the FULL draft, not the truncated task detail — load the
  // linked execution whenever an action_approval task is selected.
  useEffect(() => {
    setGatedExec(null);
    const sel = tasks.find(t => t.id === selectedId);
    if (!sel || sel.type !== 'action_approval') return;
    let cancelled = false;
    void import('../../../lib/connectorApi').then(({ getGatedExecutionForTask }) =>
      getGatedExecutionForTask(sel.id).then(exec => { if (!cancelled) setGatedExec(exec); })
    ).catch(() => { /* draft panel is an overlay — task still decidable */ });
    return () => { cancelled = true; };
  }, [selectedId, tasks]);

  // Task 6: "the evidence is on the card, and thin evidence says so". A
  // trust_promotion task's own row carries no evidence — it lives on the
  // linked trust_policies row (related_table = 'trust_policies', related_id =
  // policy id), so an approver had to leave this page to find it. Load it
  // whenever a trust_promotion task is selected, same pattern as gatedExec.
  useEffect(() => {
    setTrustPolicy(undefined); setTrustEmployeeName(null); setTrustLoadError(null);
    const sel = tasks.find(t => t.id === selectedId);
    if (!sel || sel.type !== 'trust_promotion' || !sel.related_id) return;
    let cancelled = false;
    void getTrustPolicyById(sel.related_id)
      .then(async policy => {
        if (cancelled) return;
        setTrustPolicy(policy);
        // human_tasks carries no de_id for this type (confirmed against the
        // writers that raise it — neither sets the column), so the employee
        // name comes from the policy's own de_id, resolved separately. A
        // tenant-scoped policy (de_id null) names no single employee — the
        // card falls back to naming the workspace instead.
        if (policy?.de_id) {
          try {
            const des = await listDigitalEmployees(true); // include retired — still the right name
            if (!cancelled) {
              const de = des.find(d => d.id === policy.de_id);
              setTrustEmployeeName(de ? (de.persona_name || de.name) : null);
            }
          } catch { /* falls back to the workspace phrasing below */ }
        }
      })
      .catch(err => {
        if (cancelled) return;
        setTrustLoadError((err as Error)?.message || 'Could not load the evidence behind this request.');
        // Settle OUT of "loading" on a failure too — a network hiccup must
        // not leave Approve disabled forever. The error message says why the
        // evidence panel is empty; the decision itself stays available.
        setTrustPolicy(null);
      });
    return () => { cancelled = true; };
  }, [selectedId, tasks]);

  // Close the rejection picker when the selection moves. Without this, picking
  // "wrong tone" on one task and then clicking another leaves the code armed
  // against a task it was never about — a wrong reason is worse than none,
  // because it aggregates.
  useEffect(() => {
    setRejecting(false); setReasonCode(''); setReasonNote('');
    setDraftEditing(false); setDraftEditText(''); setDraftReasonCode(''); setDraftNote('');
    setInstruction('');   // same discipline: an answer typed for one blocker must never carry to another
    setRerouting(false); setRerouteTo(''); setRerouteNote('');
  }, [selectedId]);


  // The proposed article behind a self-improvement review, so approving with a
  // correction publishes the CORRECTION. Same reset discipline as the reason
  // picker above: carrying one task's edit onto another would publish text the
  // approver never read against work they never saw.
  useEffect(() => {
    setProposal(null); setEditText(''); setEditing(false);
    const sel = tasks.find(t => t.id === selectedId);
    if (!sel || sel.related_table !== 'de_improvements' || !sel.related_id || sel.status !== 'pending') return;
    let cancelled = false;
    void getImprovementProposal(sel.related_id).then(p => {
      if (cancelled || !p) return;
      setProposal(p); setEditText(p.content);
    }).catch(() => { /* editor stays hidden; the task is still decidable as-is */ });
    return () => { cancelled = true; };
  }, [selectedId, tasks]);

  // T2.2: for a self-improvement review, offer publishing the verified fix to
  // the whole role (all same-archetype employees), not just this DE.
  useEffect(() => {
    setImpRole(null); setImpScope('de');
    const sel = tasks.find(t => t.id === selectedId);
    if (!sel || sel.related_table !== 'de_improvements' || !sel.related_id || sel.status !== 'pending') return;
    let cancelled = false;
    void getImprovementRoleInfo(sel.related_id).then(info => { if (!cancelled) setImpRole(info); }).catch(() => { /* toggle just stays hidden */ });
    return () => { cancelled = true; };
  }, [selectedId, tasks]);

  // Entity-guard signals for the selected proposal. Shown for PENDING and
  // decided tasks alike — a decided task's premise can still be questioned.
  useEffect(() => {
    setImpSignals(null);
    const sel = tasks.find(t => t.id === selectedId);
    if (!sel || sel.related_table !== 'de_improvements' || !sel.related_id) return;
    let cancelled = false;
    void getImprovementReviewSignals(sel.related_id).then(s => { if (!cancelled) setImpSignals(s); }).catch(() => { /* signals stay hidden — absence means untagged, not safe */ });
    return () => { cancelled = true; };
  }, [selectedId, tasks]);

  const doRetry = async () => {
    setRetrying(true); setRetryNote(null); setError(null);
    try {
      const res = await retryAnswerableBlockers();
      await refresh();
      // Say what happened either way — a silent no-op reads as a broken button.
      setRetryNote(res.retried > 0
        ? `Retried ${res.retried} blocker${res.retried === 1 ? '' : 's'}. They will either finish on their own or come back with a sharper question.`
        : 'Nothing to retry — everything left in this queue has already had a fair attempt and needs a person.');
    } catch (err) {
      setError((err as Error)?.message || 'Could not retry these blockers.');
    } finally {
      setRetrying(false);
    }
  };

  const doReroute = async () => {
    if (!selected || !rerouteTo || !rerouteNote.trim()) return;
    setDeciding(true); setError(null);
    try {
      const res = await rerouteEscalation(selected.id, rerouteTo, rerouteNote.trim());
      setRerouting(false); setRerouteTo(''); setRerouteNote('');
      await refresh();
      // Say what actually happened, including what it unfroze — a silent
      // success here would leave the operator guessing what moved.
      setError(null);
      if (res.dependants_freed) {
        console.info(`Rerouted to ${res.to_name}; ${res.dependants_freed} step(s) freed.`);
      }
    } catch (err) {
      setError((err as Error)?.message || 'Could not reroute this blocker.');
    } finally {
      setDeciding(false);
    }
  };

  const decide = async (task: DBHumanTask, decision: 'approved' | 'rejected', capture?: DecisionCapture) => {
    setDeciding(true);
    setOutcome(null);
    try {
      // Set the publish scope BEFORE approval (apply_improvement reads it).
      if (task.related_table === 'de_improvements' && decision === 'approved' && impScope === 'role' && task.related_id) {
        await setImprovementPublishScope(task.related_id, 'role');
      }
      // An approval carries an edit only when the text ACTUALLY changed.
      // Sending an identical pair would violate the database's
      // actually_changed check and, worse, log a correction that was never
      // made — inflating the training set with noise. An explicit `capture`
      // (the gated-draft editor below) takes precedence; the proposal
      // fallback serves the improvement editor, which commits through this
      // main path.
      const corrected = proposal !== null && editText.trim() !== proposal.content.trim();
      const { decision_outcome: o } = await decideHumanTask(task, decision, capture ?? (decision === 'rejected'
        // A rejection on a BLOCKER cancels the work and its dependants
        // (mig 483), so the reason is not just a label — it is the record of
        // why that work stopped. Carry the typed note either way.
        ? { reasonCode: reasonCode as DecisionReasonCode, note: reasonNote.trim() || undefined }
        : corrected
          ? { edit: { before: proposal!.content, after: editText } }
          // The answer that resumes the work. Only sent when the approver
          // actually typed one — an empty note would overwrite nothing but
          // also teach nothing.
          : instruction.trim()
            ? { note: instruction.trim() }
            : undefined));
      // ⚠ QUOTE THE ROW, NEVER THE ABSENCE OF AN ERROR (F-6). Silence was this
      // page's only success message, which is honest when the approval carried
      // no outward consequence — but "approved and NOT sent" has to be said
      // out loud, and so does an approval that did not transition at all.
      if (!o.decided) setOutcome({ text: o.detail ?? 'Nothing changed.', ok: false });
      else if (decision === 'approved' && o.consequence !== 'none') {
        setOutcome(o.delivered
          ? { text: 'Approved — and it has gone out.', ok: true }
          : { text: o.detail ?? 'Approved, but nothing was sent.', ok: false });
      }
      setRejecting(false); setReasonCode(''); setReasonNote(''); setInstruction('');
      setEditing(false);
      setDraftEditing(false); setDraftEditText(''); setDraftReasonCode(''); setDraftNote('');
      await refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to record decision.');
    } finally {
      setDeciding(false);
    }
  };

  // An "edit" that changed nothing is a plain approval — a pair with equal
  // halves is noise, the same judgment the corpus makes at the database
  // (de_learning_edits_actually_changed_check).
  const approveDraftWithEdits = (task: DBHumanTask, draftText: string) => {
    if (draftEditText.trim() === draftText.trim()) return decide(task, 'approved');
    return decide(task, 'approved', {
      reasonCode: draftReasonCode || undefined,
      note: draftNote.trim() || undefined,
      edit: { before: draftText, after: draftEditText },
    });
  };

  const toggleItem = async (task: DBHumanTask, idx: number, done: boolean) => {
    try {
      const state = await toggleChecklistItem(task.id, idx, done);
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, checklist_state: state } : t));
    } catch (err) {
      setError((err as Error)?.message || 'Failed to update checklist item.');
    }
  };

  const pending = tasks.filter(t => t.status === 'pending');
  // ⚠ WITHDRAWALS ARE NOT JUDGEMENTS (mig 790). A withdrawn task is
  // status='rejected' + disposition='cancelled'. Counting it here would let
  // clearing 300 testing artefacts drive the approval rate toward zero and
  // present that as a quality signal about the workforce. The rate answers
  // "of the things you actually ruled on, how many did you say yes to" — so
  // the things you never ruled on are excluded from BOTH halves of it.
  const wasJudged = (t: DBHumanTask) => t.status !== 'pending' && t.disposition !== 'cancelled';
  const decidedCount = tasks.filter(wasJudged).length;
  const approvedCount = tasks.filter(t => wasJudged(t) && t.status === 'approved').length;
  const approvalRate = decidedCount > 0 ? Math.round((approvedCount / decidedCount) * 100) : 0;
  const isWithdrawn = (t: DBHumanTask) => t.status !== 'pending' && t.disposition === 'cancelled';
  // Owner buckets, counted on what the other filters already allow so the
  // number on a chip is a number you can click to.
  const ownerName = (t: DBHumanTask) =>
    t.assigned_user_id ? (peopleById.get(t.assigned_user_id) ?? 'Unnamed user') : 'Nobody yet';
  const ownerKey = (t: DBHumanTask) => t.assigned_user_id ?? 'unassigned';
  // Withdraw. Deliberately NOT routed through the decide handler above: that
  // one runs a dozen side-effect hooks because approving owes something, and
  // a withdrawal owes nothing. Reusing it would make "remove this from my
  // list" the most side-effecting button on the page.
  // ── Batch decide (mig 795) ───────────────────────────────────────────────
  // Two steps, deliberately. The preview runs the REAL decision per task and
  // rolls it back, so what it reports is what the rules actually say — not a
  // second opinion about them that could drift.
  const doPreview = async (ids: string[]) => {
    if (ids.length === 0 || previewing) return;
    setPreviewing(true);
    setBatchPreview(null);
    try {
      setBatchPreview(await previewDecideHumanTasks(ids, 'approved'));
    } catch (e) {
      setOutcome({ text: e instanceof Error ? e.message : 'Could not preview.', ok: false });
    } finally {
      setPreviewing(false);
    }
  };

  const doBatchApprove = async (ids: string[]) => {
    if (ids.length === 0 || batchDeciding) return;
    setBatchDeciding(true);
    try {
      // ⚠ EVERY selected id is sent, including the ones the preview said would
      // refuse. The preview describes the state of play a moment ago; the RPC
      // re-runs every guard now. Filtering to the "safe" subset here would be
      // building on a snapshot and would quietly hide a task that has since
      // become approvable.
      const r = await decideHumanTasks(ids, 'approved', null, 'Approved in a batch from the queue');
      setPicked(new Set());
      setBatchPreview(null);
      if (ids.includes(selectedId ?? '')) setSelectedId(null);
      setOutcome(r.failed.length
        ? { text: `Approved ${r.decided}. ${r.failed.length} refused — ${r.failed[0].error}`, ok: false }
        : { text: `Approved ${r.decided} ${r.decided === 1 ? 'task' : 'tasks'}.`, ok: true });
      await refresh();
    } catch (e) {
      setOutcome({ text: e instanceof Error ? e.message : 'Could not approve.', ok: false });
    } finally {
      setBatchDeciding(false);
    }
  };

  const doWithdraw = async (ids: string[]) => {
    if (ids.length === 0 || withdrawing) return;
    setWithdrawing(true);
    try {
      const r = await withdrawHumanTasks(ids, 'Withdrawn from the queue by the owner');
      setPicked(new Set());
      if (ids.includes(selectedId ?? '')) setSelectedId(null);
      // ⚠ A PARTIAL RESULT IS REPORTED AS PARTIAL. The RPC withdraws each task
      // in its own subtransaction, so "8 of 10" is a real outcome — saying
      // "withdrawn" here would leave two on screen with no explanation.
      setOutcome(r.failed.length
        ? { text: `Withdrew ${r.withdrawn}. ${r.failed.length} could not be — ${r.failed[0].error}.`, ok: false }
        : { text: `Withdrew ${r.withdrawn} ${r.withdrawn === 1 ? 'task' : 'tasks'}. Nothing was sent or actioned.`, ok: true });
      await refresh();
    } catch (e) {
      setOutcome({ text: e instanceof Error ? e.message : 'Could not withdraw.', ok: false });
    } finally {
      setWithdrawing(false);
    }
  };

  const stalledCount = pending.filter(t => staleness.has(t.id)).length;
  const matchesDecision = (t: DBHumanTask) =>
    decision === 'all' ? true : decision === 'needs_you' ? t.status === 'pending' : t.status !== 'pending';
  // ⚠ FIX ROUND 2 (coordinator review, item 4 — do only the small half; the
  // server-side wiring is spawned separately, not here). decide_human_tasks
  // -> decide_human_task carries NO trust references at all — apply_trust_
  // promotion is invoked only from decideHumanTask's client hook #4, which
  // the batch RPC never runs. So batch-approving a trust_promotion closes the
  // task as approved, leaves pending_task_id pointing at a dead task, writes
  // no audit event, and PROMOTES NOBODY — while the UI reports success. The
  // only route to approving one must stay the card. Checked: the "stranded
  // work" quick-select buttons (mig 800) cannot smuggle one in either —
  // list_decision_groups joins de_work_items by related_table, trust_
  // promotion's related_table is trust_policies, so its strands/gates_work
  // are always 0 and the .filter(g => g.strands > 0) below never renders a
  // button for it. Checkbox and select-all are the only two live paths.
  const batchSelectable = (t: DBHumanTask) => t.status === 'pending' && t.type !== 'trust_promotion';
  // Owner buckets, counted on what the other filters already allow — a count
  // on a chip should be a count you can click to. Declared after
  // matchesDecision on purpose: this runs immediately, and a const arrow
  // function read before its declaration is a TDZ crash, not a hoist.
  const ownerBuckets = (() => {
    const m = new Map<string, { key: string; name: string; count: number }>();
    for (const t of tasks) {
      if (!inScope(t, scope) || !matchesDecision(t)) continue;
      const k = ownerKey(t);
      const e = m.get(k) ?? { key: k, name: ownerName(t), count: 0 };
      e.count += 1;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  })();
  const visible = tasks.filter(t =>
    inScope(t, scope)
    && matchesDecision(t)
    && (filter === 'all' || t.type === filter)
    && (owner === 'all' || ownerKey(t) === owner)
    && (!stalledOnly || staleness.has(t.id)))
    // Risk-ranked (mig 705): the safest approvals first — the one-glance
    // clears — the risky ones last but wearing a danger chip. Tasks without a
    // brief (every non-approval type, and everything already decided) keep
    // their existing order in between; sort() is stable, so ties preserve the
    // created_at ordering the query returned.
    .sort((a, b) =>
      briefSortKey(a.status === 'pending' ? briefs.get(a.id) : undefined)
      - briefSortKey(b.status === 'pending' ? briefs.get(b.id) : undefined));
  const scopeCount = (s: Scope) => tasks.filter(t => t.status === 'pending' && inScope(t, s)).length;
  // Counts for the decision control, narrowed by the scope already chosen — a
  // count that ignores the other filters tells you a number you cannot click to.
  const inScopeTasks = tasks.filter(t => inScope(t, scope));
  const needsYouCount = inScopeTasks.filter(t => t.status === 'pending').length;
  const decidedInScope = inScopeTasks.filter(t => t.status !== 'pending').length;
  const selected = tasks.find(t => t.id === selectedId) ?? null;

  // What this escalation is actually holding up. Escalations only started
  // carrying the back-link in mig 483 (older ones were backfilled in 484), so
  // this stays null for the ones that never had a decidable record — shown as
  // nothing rather than as a guess.
  // Who this could be handed to. RLS + can_access_de already scope this list to
  // the employees the viewer may reach, and mig 504 re-checks the target
  // server-side — so an unreachable employee can never be chosen, nor smuggled.
  useEffect(() => {
    let live = true;
    void listDigitalEmployees()
      .then(rows => {
        if (!live) return;
        setColleagues(rows
          .filter(d => d.id !== selected?.de_id)
          .map(d => ({ id: d.id, name: d.persona_name || d.name })));
      })
      .catch(() => { /* the reroute option simply does not appear */ });
    return () => { live = false; };
  }, [selected?.de_id]);

  useEffect(() => {
    let live = true;
    setBlocked(null);
    if (!selected || selected.related_table !== 'de_work_items') return;
    void getBlockedWorkForTask(selected)
      .then((b) => { if (live) setBlocked(b); })
      .catch(() => { /* additive panel — never block a decision on it */ });
    return () => { live = false; };
  }, [selectedId, selected]);

  // The gated reply this approval will actually deliver (mig 721). Loaded so
  // the button can promise a send only when there is one — F-6 was a button
  // that promised one on every task in the queue.
  const selectedConvId = selected?.related_table === 'de_conversations' && selected.status === 'pending'
    ? selected.related_id : null;
  useEffect(() => {
    if (!selectedConvId) { setReplyDraft(null); return; }
    let live = true;
    setReplyDraft(undefined);
    void getPendingConversationDraft(selectedConvId)
      .then(d => { if (live) setReplyDraft(d); })
      .catch(() => { if (live) setReplyDraft(null); });
    return () => { live = false; };
  }, [selectedConvId]);

  const selectedStale = selected ? staleness.get(selected.id) ?? null : null;
  // Same precedence as the Full-draft display below — the text the approver
  // sees is exactly the text their edit replaces.
  const gatedDraft = gatedExec ? (gatedExec.params.body || gatedExec.params.note || '') : '';

  // Task 6: derived from the raw trustPolicy/trustEmployeeName state above,
  // same discipline as gatedDraft — computed on render rather than stored, so
  // there is only one place (the effect) that can leave it stale.
  // extractPolicyEvidence handles BOTH shapes pending_evidence is shipped in
  // today (see its own header) — a policy with no readable criteria at all
  // (neither shape matched) renders as an explicit "no evidence snapshot"
  // notice below, never as a silent zero.
  const trustEvidence = trustPolicy ? extractPolicyEvidence(trustPolicy.pending_evidence) : null;
  const trustCopy = (trustPolicy && trustEvidence) ? trustPromotionCardCopy({
    employeeName: trustEmployeeName || 'This workspace',
    category: trustPolicy.action_category,
    currentLevel: trustPolicy.current_level,
    targetLevel: trustPolicy.target_level,
    evidence: trustEvidence,
    ladder: trustPolicy.ladder ?? null,
  }) : null;
  const trustThin = trustEvidence ? isThinTrustEvidence(trustEvidence) : false;
  // ⚠ FIX ROUND 2: still checking, tri-state — see trustPolicy's own comment.
  // Consulted by Approve's disabled= below: approving a trust_promotion task
  // before this settles is deciding having seen nothing, on the exact pane
  // the evidence block sits in.
  const trustLoading = selected?.type === 'trust_promotion' && trustPolicy === undefined;
  // ⚠ FINAL REVIEW (2026-08-21): the raw task.detail is rendered ABOVE the
  // evidence card, and for a criteria-shaped request it is the SQL-composed
  // sentence the card supersedes — the same evidence in two voices, the first
  // of which promises a cap the ladder does not grant. Suppressed only when
  // BOTH are true: the card actually rendered (trustCopy is non-null, so a
  // load error, an unlinked policy or an unreadable snapshot all still show
  // the detail), and the evidence carries no cited decisions. The rule lives
  // in the shared module so mobile cannot drift from it — see
  // detailIsRedundantBesideCard's own header for why a pattern-shaped
  // proposal keeps its detail (the receipts are only there).
  const trustDetailRedundant = selected?.type === 'trust_promotion'
    && !!trustCopy
    && detailIsRedundantBesideCard(trustPolicy?.pending_evidence);

  return (
    <div className="p-6">
      <PageHeader
        title="Waiting on you"
        subtitle="Your employees have stopped on each of these and can't continue until you decide."
      />

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-dt-danger">{error}</div>}

      {/* What the last decision actually caused, read back out of the database.
          Amber whenever the consequence did not land — a send that silently
          failed is not a quieter kind of success (F-6). */}
      {outcome && (
        <div className={`mb-4 rounded-xl border px-4 py-3 text-xs ${
          outcome.ok
            ? 'border-emerald-800/50 bg-emerald-500/10 text-dt-ok'
            : 'border-amber-700/50 bg-amber-500/10 text-dt-warn'}`}>
          {outcome.text}
        </div>
      )}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : tasks.length === 0 ? (
        <LiveEmptyState
          icon="✋"
          title="Nothing is waiting on you"
          body="When a Digital Employee needs a human decision — like approving a renewal invoice over $10K — it shows up here."
          primaryLabel="Go to Renewal & Expansion"
          onPrimary={() => setPage('entity_customer_renewal')}
        />
      ) : (
        <>
          {/* Stats strip */}
          <div className="grid grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Pending', value: String(pending.length), color: pending.length > 0 ? 'text-dt-warn' : 'text-dt-ok' },
              { label: 'Stalled work', value: String(stalledCount), color: stalledCount > 0 ? 'text-dt-warn' : 'text-dt-ok' },
              { label: 'Decided', value: String(decidedCount), color: 'text-dt-title' },
              { label: 'Approval rate', value: `${approvalRate}%`, color: 'text-dt-title' },
            ].map(s => (
              <div key={s.label} className="bg-dt-card border border-dt-border rounded-xl p-4">
                <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">{s.label}</p>
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>

          {/* mig 513. Most of a stalled queue is not work for a person: it is
              questions the employee asked before it had the tools, frozen at
              that moment. Measured here: 45 of 61 predated the capability that
              answers them. Retrying cleared 31 in one pass — one completed
              itself ("receivables books are clear"), one came back with a
              sharper question naming exactly what was missing. */}
          {/* ⚠ This page is APPROVALS tier, so an `approver` opens it — that is
              the whole point of the role. But retry_answerable_blockers is
              owner/admin/manager, so the button below would refuse them with a
              bare 'insufficient_role'. Hidden rather than disabled: retrying is
              a bulk housekeeping action, not part of an approver's job, and the
              paragraph beside it exists only to introduce the button. Deciding
              a task stays available to them — decide_human_task refuses with a
              reason that teaches, which is a working control, not a dead one. */}
          {scope !== 'chat' && canRetryBlockers && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-dt-border bg-dt-inset px-4 py-2.5">
              <p className="text-[13px] text-dt-muted">
                Some of these were raised before the employee had what it asked for. Retrying lets them try again
                — they either finish, or come back with a sharper question.
              </p>
              <button
                onClick={() => void doRetry()}
                disabled={retrying}
                className="shrink-0 rounded-lg border border-dt-border-strong px-3 py-1.5 text-xs font-medium text-dt-body transition-colors hover:text-dt-title disabled:opacity-50">
                {retrying ? 'Retrying…' : 'Retry what they can now answer'}
              </button>
            </div>
          )}
          {retryNote && <p className="mb-3 text-[12px] text-dt-support">{retryNote}</p>}

          {/* N4: one queue, opened on the work. TabBar rather than another
              hand-rolled pill strip — the design system names it as the filter
              primitive and the existing strip below is pre-existing drift. */}
          <div className="mb-4">
            <TabBar<Scope>
              tabs={[
                { key: 'work', label: "Work that's stuck", badge: scopeCount('work') > 0 ? <Chip tone="warn">{scopeCount('work')}</Chip> : undefined },
                { key: 'chat', label: 'Questions people asked', badge: scopeCount('chat') > 0 ? <Chip tone="neutral">{scopeCount('chat')}</Chip> : undefined },
                { key: 'all', label: 'Both', badge: scopeCount('all') > 0 ? <Chip tone="neutral">{scopeCount('all')}</Chip> : undefined },
              ]}
              active={scope}
              onSelect={setScope}
            />
          </div>

          {/* Waiting on you, or already settled. The primary cut — everything
              below narrows within it. */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {([
              { id: 'needs_you' as const, label: 'Needs a decision', count: needsYouCount },
              { id: 'decided' as const, label: 'Already decided', count: decidedInScope },
              { id: 'all' as const, label: 'All', count: inScopeTasks.length },
            ]).map(d => (
              <button
                key={d.id}
                onClick={() => setDecision(d.id)}
                aria-pressed={decision === d.id}
                className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  decision === d.id
                    ? (d.id === 'needs_you'
                        ? 'bg-dt-warn-soft text-dt-warn border border-dt-warn-border'
                        : 'bg-indigo-600 text-white border border-indigo-600')
                    : 'bg-dt-card border border-dt-border text-dt-support hover:text-dt-body'}`}
              >
                {d.label}
                <span className={`ml-1.5 tabular-nums ${decision === d.id ? 'opacity-80' : 'text-dt-faint'}`}>{d.count}</span>
              </button>
            ))}
          </div>

          {/* Whose queue this is. The scope row asks WHAT kind of thing is
              waiting; this asks WHO it is waiting on — the question a manager
              actually opens this page with, and the one the founder asked for:
              "a task approval list by owner so there is a clean way of
              sorting". A select rather than a pill strip because the owner
              list grows with the team while the scope list never will. */}
          {ownerBuckets.length > 1 && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <label htmlFor="owner-filter" className="text-xs text-dt-support">Waiting on</label>
              <select
                id="owner-filter"
                className={INPUT_CLS + ' w-auto text-xs py-1.5'}
                value={owner}
                onChange={e => { setOwner(e.target.value); setPicked(new Set()); }}
              >
                <option value="all">Everyone ({ownerBuckets.reduce((n, o) => n + o.count, 0)})</option>
                {ownerBuckets.map(o => (
                  <option key={o.key} value={o.key}>{o.name} ({o.count})</option>
                ))}
              </select>
              {owner !== 'all' && (
                <button onClick={() => setOwner('all')} className="text-xs text-dt-faint hover:text-dt-body underline">
                  clear
                </button>
              )}
            </div>
          )}

          {/* Bulk withdraw. The founder's words were "an option to delete a
              task otherwise the list gets too long", and the length is the
              complaint — so the control is built for many, not for one.
              ⚠ It withdraws, it does not delete: the row survives, marked
              cancelled, and never counts toward the approval rate. */}
          {/* ── What is stranded behind this queue (mig 800) ─────────────────
              An employee with nothing claimable looks idle. It usually is not:
              claim_de_work_items will not touch a step until its predecessor
              is done, so ONE unanswered question freezes the whole chain
              behind it. This says which decisions restart an employee, and
              how many steps each one releases — counted through the chain,
              not just the next step. */}
          {groups.some(g => g.strands > 0) && (
            <div className="mb-3 rounded-xl border border-dt-border bg-dt-card p-4">
              <div className="text-dt-body font-medium mb-2">
                {groups.reduce((n, g) => n + Number(g.strands || 0), 0)} steps of work are waiting on{' '}
                {groups.reduce((n, g) => n + Number(g.gates_work || 0), 0)} of these decisions
              </div>
              <div className="flex flex-wrap gap-2">
                {groups.filter(g => g.strands > 0).slice(0, 6).map(g => (
                  <button
                    key={`${g.task_type}-${g.de_id ?? 'none'}`}
                    onClick={() => { setPicked(new Set(g.task_ids)); setBatchPreview(null); }}
                    className="text-left rounded-xl border border-dt-border px-3 py-2 hover:border-dt-accent"
                  >
                    <div className="text-dt-body">{g.de_name ?? 'Unassigned'}</div>
                    <div className="text-dt-faint">
                      {g.pending} {g.task_type.replace(/_/g, ' ')}
                      {g.oldest_days > 0 && ` · oldest ${g.oldest_days}d`}
                    </div>
                    <div className="text-dt-support">frees {g.strands} steps</div>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-dt-faint">
                Selecting one picks its decisions below, so you can check and approve them together.
                Groups that free nothing are not shown here — they are still in the list.
              </p>
            </div>
          )}

          {visible.some(t => t.status === 'pending') && (
            <div className="flex items-center gap-3 mb-3 flex-wrap text-xs">
              <button
                onClick={() => {
                  // FIX ROUND 2: trust_promotion excluded — see the per-row
                  // checkbox comment below for why.
                  const ids = visible.filter(batchSelectable).map(t => t.id);
                  setPicked(picked.size === ids.length ? new Set() : new Set(ids));
                }}
                className="text-dt-support hover:text-dt-body underline"
              >
                {picked.size === visible.filter(batchSelectable).length && picked.size > 0
                  ? 'Clear selection'
                  : `Select all ${visible.filter(batchSelectable).length} shown`}
              </button>
              {picked.size > 0 && (
                <>
                  <span className="text-dt-faint">{picked.size} selected</span>
                  {/* Preview first. Approving 45 things without being told which
                      two will refuse is the behaviour this replaces. */}
                  {!batchPreview && (
                    <Button
                      kind="secondary"
                      size="sm"
                      disabled={previewing}
                      onClick={() => void doPreview([...picked])}
                    >
                      {previewing ? 'Checking…' : `Check what approving ${picked.size} would do`}
                    </Button>
                  )}
                  <Button
                    kind="secondary"
                    size="sm"
                    disabled={withdrawing}
                    onClick={() => void doWithdraw([...picked])}
                  >
                    {withdrawing ? 'Withdrawing…' : `Withdraw ${picked.size} from the queue`}
                  </Button>
                  <span className="text-dt-faint">Removes them without approving or sending anything.</span>
                </>
              )}
              {picked.size > 0 && batchPreview && (
                <div className="w-full mt-2 rounded-xl border border-dt-border bg-dt-card p-4">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-dt-body font-medium">
                      {batchPreview.would_succeed} will go through
                      {batchPreview.would_refuse > 0 && `, ${batchPreview.would_refuse} will refuse`}.
                    </span>
                    <Button
                      kind="primary"
                      size="sm"
                      disabled={batchDeciding || batchPreview.would_succeed === 0}
                      onClick={() => void doBatchApprove([...picked])}
                    >
                      {batchDeciding ? 'Approving…' : `Approve ${picked.size}`}
                    </Button>
                    <button
                      onClick={() => setBatchPreview(null)}
                      className="text-dt-support hover:text-dt-body underline"
                    >
                      Cancel
                    </button>
                  </div>
                  {batchPreview.would_refuse > 0 && (
                    <ul className="mt-2 space-y-1">
                      {batchPreview.refusals.slice(0, 5).map(r => (
                        <li key={r.id} className="text-dt-faint">
                          <span className="text-dt-support">{r.title}</span> — {r.why}
                        </li>
                      ))}
                      {batchPreview.refusals.length > 5 && (
                        <li className="text-dt-faint">
                          …and {batchPreview.refusals.length - 5} more.
                        </li>
                      )}
                    </ul>
                  )}
                  <p className="mt-2 text-dt-faint">
                    This is the real decision run against each task and rolled back, not a guess.
                    All {picked.size} are still sent when you approve — the checks run again, so
                    anything that changed in the meantime is caught rather than assumed.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ⚠ WITHDRAWING AN ESCALATION DOES NOT CLEAR IT, and a person who
              withdraws 29 of them and watches them return within the hour will
              conclude this button is broken. It isn't: reconcile_blocked_goals
              and de_stall_sweep_internal both dedupe on status='pending', so a
              withdrawn escalation stops matching and the next sweep — every 30
              minutes — raises it again.
              That is correct behaviour, because an escalation is a live readout
              of work that is still stuck, not a message you can dismiss. The
              thing that clears it is deciding what the work is waiting on.
              Withdrawal is for the residue: dead approvals, testing artefacts,
              asks whose underlying record is gone. */}
          {picked.size > 0 && visible.some(t => picked.has(t.id) && t.type === 'escalation') && (
            <div className="mb-3 rounded-lg border border-dt-warn-border bg-dt-warn-soft px-3 py-2 text-xs text-dt-warn">
              {visible.filter(t => picked.has(t.id) && t.type === 'escalation').length} of these are escalations.
              Withdrawing one does not unblock the work behind it, and the next sweep will raise it again
              within 30 minutes. To clear them for good, decide what the work is waiting on.
            </div>
          )}

          {/* One control, not seven. The six type chips that used to sit here
              were the human_tasks taxonomy — Approvals, Reviews, Escalations,
              Overrides, Feedback, Checklists — and an owner does not think in
              those. The scope row above is the split that matters: is my
              workforce stuck, or did somebody ask a question? */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            {filter !== 'all' && (
              <button
                onClick={() => setFilter('all')}
                className="px-3 py-1.5 rounded-full text-xs bg-dt-accent-soft border border-dt-accent-border text-dt-accent-text hover:brightness-110 transition-colors">
                {FILTERS.find(f => f.id === filter)?.label ?? filter} · clear ✕
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={() => setStalledOnly(v => !v)}
              className={`px-3 py-1.5 rounded-full text-xs transition-colors ${stalledOnly ? 'bg-dt-warn-soft text-dt-warn border border-dt-warn-border' : 'bg-dt-card border border-dt-border text-dt-support hover:text-dt-body'}`}
            >
              Gone quiet only{stalledCount > 0 ? ` (${stalledCount})` : ''}
            </button>
          </div>

          <div className="grid grid-cols-5 gap-4">
            {/* Task list */}
            <div className={`${selected ? 'col-span-3' : 'col-span-5'} space-y-1.5`}>
              {visible.length === 0 && (
                <div className="text-center py-10 border border-dashed border-dt-border rounded-xl">
                  {/* Say which of the three situations this is. "No tasks match
                      the current filter" was true for all of them and useful for
                      none — an empty inbox and a filter hiding everything read
                      identically. */}
                  <p className="text-dt-muted text-sm">
                    {stalledOnly
                      ? 'No stalled work right now — nothing has gone quiet past its threshold.'
                      : decision === 'needs_you'
                        ? (decidedInScope > 0
                            ? 'Nothing is waiting on you here. Everything in this view has been decided.'
                            : 'Nothing is waiting on you here.')
                        : decision === 'decided'
                          ? 'Nothing has been decided here yet.'
                          : 'No tasks match the current filter.'}
                  </p>
                  {decision === 'needs_you' && decidedInScope > 0 && (
                    <button
                      onClick={() => setDecision('decided')}
                      className="mt-2 text-xs text-dt-accent-text hover:underline"
                    >
                      See the {decidedInScope} already decided
                    </button>
                  )}
                </div>
              )}
              {/* ── One decision per card (handoff 08) ──────────────────
                  Was a four-column grid whose first column was a 9px all-caps
                  type badge and whose detail ran at 10px — the two smallest
                  things on the page carrying the two most important facts.

                  ⚠ THE CARD DOES NOT DECIDE. Approving and rejecting live in
                  the detail panel beside it, because rejecting REQUIRES a
                  reason and that flow already exists there, complete with the
                  real reasonCode list. Duplicating a decision path to get an
                  inline button is how the two disagree later. The card's job
                  is to make the queue readable and open the right one. */}
              {visible.map(task => {
                const stale = staleness.get(task.id);
                // Advisory only. The chip and the sentence below never touch
                // the decide path — the card's own comment says why the card
                // does not decide, and the brief does not change that.
                const brief = task.status === 'pending' ? briefs.get(task.id) : undefined;
                const assignee = task.assigned_user_id
                  ? (peopleById.get(task.assigned_user_id) ?? 'Unnamed user') + (task.assigned_role ? ` · ${task.assigned_role}` : '')
                  : task.status === 'pending' ? "nobody's job yet" : null;
                return (
                  <div key={task.id} className="flex items-start gap-2">
                    {/* Only pending rows are selectable — withdrawing something
                        already decided is not a thing, and offering the box
                        would imply it is.
                        ⚠ FIX ROUND 2: trust_promotion is EXCLUDED even while
                        pending. Batch-approving it does not run apply_trust_
                        promotion (that hook lives only in the single-task
                        decide path) — a batch approve would close the task,
                        strand trust_policies.pending_task_id, write no audit
                        event, and promote nobody, while the toast says
                        "Approved 1 task." Shown disabled with why, not
                        omitted — a gap where a control should be reads as a
                        bug, not a boundary. */}
                    {task.status === 'pending' && task.type === 'trust_promotion' ? (
                      <input
                        type="checkbox"
                        disabled
                        title="Trust promotions can't be batch-approved — the batch path skips the check that actually moves the dial. Decide it from its own card."
                        className="mt-5 shrink-0 cursor-not-allowed opacity-40"
                        aria-label={`"${task.title}" cannot be batch-approved — decide it from its own card`}
                      />
                    ) : batchSelectable(task) && (
                      <input
                        type="checkbox"
                        className="mt-5 shrink-0 accent-dt-accent"
                        checked={picked.has(task.id)}
                        aria-label={`Select "${task.title}" for withdrawal`}
                        onChange={() => setPicked(prev => {
                          const next = new Set(prev);
                          if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
                          return next;
                        })}
                      />
                    )}
                  <div
                    className={`flex-1 min-w-0 rounded-xl transition-shadow ${selectedId === task.id ? 'ring-2 ring-dt-accent' : ''} ${task.status !== 'pending' ? 'opacity-70 hover:opacity-100' : ''}`}
                  >
                    <DecisionCard
                      tone={stale ? (stale.tier === 'breach' ? 'danger' : 'warn') : task.status !== 'pending' ? 'neutral' : 'warn'}
                      title={task.title}
                      stale={stale ? (stale.tier === 'breach' ? 'Nothing has happened in too long' : 'Gone quiet') : undefined}
                      detail={task.detail ? <span className="line-clamp-2">{task.detail}</span> : undefined}
                      /* "Waiting 2 hours · Marcus · renewal invoice" — how long,
                         whose job, and which kind, in one readable line instead
                         of a badge column and two 10px rows. */
                      meta={[`Waiting ${taskAge(task.created_at)}`, assignee, taskBadgeLabel(task.type).toLowerCase()]
                        .filter(Boolean).join(' · ')}
                      actions={
                        <>
                          <Button kind={task.status === 'pending' ? 'primary' : 'secondary'} size="sm"
                            onClick={() => setSelectedId(task.id)}>
                            {task.status === 'pending' ? 'Decide this' : 'Open it'}
                          </Button>
                          {/* A withdrawal is stored as a rejection (mig 790),
                              so without this chip the queue would report
                              "Rejected" for something nobody ruled on. */}
                          {isWithdrawn(task)
                            ? <Chip tone="neutral">Withdrawn</Chip>
                            : task.status !== 'pending' && statusBadge(task.status as TaskStatus)}
                          {task.status === 'pending' && (
                            <button
                              onClick={() => void doWithdraw([task.id])}
                              disabled={withdrawing}
                              className="text-xs text-dt-faint hover:text-dt-body underline disabled:opacity-50"
                            >
                              Withdraw
                            </button>
                          )}
                          {task.first_approver_id && <Chip tone="info">One of two approved</Chip>}
                          {brief && <Chip tone={BRIEF_CHIP[brief.risk].tone}>{BRIEF_CHIP[brief.risk].label}</Chip>}
                        </>
                      }
                      /* The advisory sentence, in the slot DecisionCard names
                         for exactly this ("you have approved every Meridian
                         renewal…"). Labeled as advice; it decides nothing. */
                      nudge={brief ? `Advisory: ${brief.headline}` : undefined}
                    />
                  </div>
                  </div>
                );
              })}
            </div>

            {/* Detail panel.
                It is sticky, so page scroll moves the LIST beside it and never
                the panel itself. With h-fit and no max height, anything taller
                than the viewport was simply unreachable — which the reject form
                (docs/34) made blocking rather than cosmetic: the reason codes
                rendered half-visible and the confirm control sat below the
                bottom edge with no way to scroll to it. The panel needs its own
                scroll container, not just a height cap. */}
            {selected && (
              <div className="col-span-2 bg-dt-card border border-dt-border rounded-2xl p-5 sticky top-0 max-h-[calc(100vh-3rem)] overflow-y-auto">
                <div className="flex items-center justify-between mb-3">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${taskBadgeStyle(selected.type)}`}>{taskBadgeLabel(selected.type)}</span>
                  <button onClick={() => setSelectedId(null)} className="w-6 h-6 rounded bg-dt-panel text-dt-muted hover:text-dt-body flex items-center justify-center text-xs">×</button>
                </div>
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <h3 className="text-sm font-semibold text-dt-title">{selected.title}</h3>
                  {selectedStale && stalledBadge(selectedStale.tier)}
                </div>
                {/* ⚠ whitespace-pre-wrap is LOAD-BEARING, not styling. An
                    escalation folded into this task appends its account here
                    behind a blank line (mig 778's "— also reported <date>:").
                    Without pre-wrap those separate reports collapse into one
                    run-on paragraph — the words are still reachable, but the
                    boundary between two different reports is not, which is
                    most of what makes the second one findable. */}
                {selected.detail && !trustDetailRedundant && <p className="text-xs text-dt-support mb-3 whitespace-pre-wrap">{selected.detail}</p>}
                {/* ⚠ READ IT BEFORE YOU SEND IT. `detail` carries the draft cut
                    to 240 characters; approving now delivers the WHOLE thing,
                    so the whole thing is what the approver sees. */}
                {replyDraft && (
                  <div className="mb-3 rounded-lg border border-dt-border bg-dt-page px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-wide text-dt-faint mb-1.5">
                      {replyDraft.deliverable
                        ? 'The reply that will be sent to the customer'
                        : `The reply waiting on this ${replyDraft.channel} conversation — approving will NOT send it`}
                    </p>
                    <p className="text-xs text-dt-body whitespace-pre-wrap">{replyDraft.content}</p>
                    {!replyDraft.deliverable && (
                      <p className="mt-2 text-[11px] text-dt-warn">
                        This {replyDraft.channel} conversation is delivered by the outbound
                        queue. Send it from the Support inbox.
                      </p>
                    )}
                  </div>
                )}
                {selectedStale && (
                  <div className={`mb-3 rounded-lg px-3 py-2 text-[11px] ${selectedStale.tier === 'breach' ? 'bg-dt-danger-soft border border-dt-danger-border text-dt-danger' : 'bg-dt-warn-soft border border-dt-warn-border text-dt-warn'}`}>
                    Raised automatically by the staleness watchdog — nothing happened on this for too long, so a human is being asked to look at it.
                    {selectedStale.tier === 'breach' && ' This is now past the breach threshold.'}
                  </div>
                )}

                <div className="space-y-3 text-xs">
                  <div className="flex items-center justify-between bg-dt-page rounded-lg px-3 py-2">
                    <span className="text-dt-muted">Source</span>
                    <span className="text-dt-support">{selected.source === 'de' ? 'Digital Employee' : selected.source === 'chat' ? 'DE chat' : selectedStale ? 'Staleness watchdog' : 'System'}</span>
                  </div>
                  <div className="flex items-center justify-between bg-dt-page rounded-lg px-3 py-2">
                    <span className="text-dt-muted">Raised</span>
                    <span className="text-dt-support">{taskAge(selected.created_at)} ago</span>
                  </div>
                  {selected.related_table === 'renewal_invoices' && (
                    <div className="flex items-center justify-between bg-dt-page rounded-lg px-3 py-2">
                      <span className="text-dt-muted">Related</span>
                      <button onClick={() => setPage('entity_customer_renewal')} className="text-dt-accent-text hover:underline transition-colors">Renewal &amp; Expansion →</button>
                    </div>
                  )}
                  {selected.related_table === 'knowledge_revision_requests' && (
                    <div className="flex items-center justify-between bg-dt-page rounded-lg px-3 py-2">
                      <span className="text-dt-muted">Related</span>
                      <button onClick={() => setPage('knowledge_library')} className="text-dt-accent-text hover:underline transition-colors">Knowledge Library → Revisions →</button>
                    </div>
                  )}
                  {selected.status !== 'pending' && (
                    <div className="flex items-center justify-between bg-dt-page rounded-lg px-3 py-2">
                      <span className="text-dt-muted">Decided</span>
                      <span className="text-dt-support">{selected.decided_at ? new Date(selected.decided_at).toLocaleString() : '—'}</span>
                    </div>
                  )}
                </div>

                {/* The decision capture, read back (docs/34). A reason or an edit
                    that is written but never shown anywhere is the written-never-
                    read failure this project has shipped once already — this
                    panel is the capture's first reader. */}
                {selected.status !== 'pending' && (selected.decision_reason_code || selected.decision_note || selected.decision_edit) && (
                  <div className="mt-4 bg-dt-page border border-dt-border rounded-lg px-3 py-2.5">
                    <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1.5">
                      {selected.status === 'rejected' ? 'Why it was rejected' : 'Approved with corrections'}
                    </p>
                    {selected.decision_reason_code && (
                      <span className="inline-block rounded-md border border-dt-border bg-dt-card px-2 py-0.5 text-[11px] text-dt-support">
                        {DECISION_REASON_CODES.find(rc => rc.code === selected.decision_reason_code)?.label ?? selected.decision_reason_code}
                      </span>
                    )}
                    {selected.decision_note && (
                      <p className="mt-1.5 text-xs text-dt-support whitespace-pre-wrap">{selected.decision_note}</p>
                    )}
                    {selected.decision_edit && typeof selected.decision_edit.before === 'string' && typeof selected.decision_edit.after === 'string' && (
                      <div className="mt-2 space-y-2 text-xs">
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-dt-muted mb-0.5">The employee&apos;s original</p>
                          <p className="whitespace-pre-wrap text-dt-muted">{selected.decision_edit.before}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-dt-muted mb-0.5">The approver&apos;s version — what went out</p>
                          <p className="whitespace-pre-wrap text-dt-support">{selected.decision_edit.after}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selected.type === 'action_approval' && gatedExec && (
                  <div className="mt-4">
                    <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1.5">
                      {gatedExec.destructive ? 'What will be sent / changed on approval' : 'What will happen on approval'}
                    </p>
                    <div className="bg-dt-page border border-dt-border rounded-lg px-3 py-2 text-xs text-dt-support">
                      <p className="font-medium text-dt-body mb-1">{gatedExec.action_label}</p>
                      {gatedExec.request_summary && <p className="text-dt-support mb-2">{gatedExec.request_summary}</p>}
                      {gatedDraft && (
                        <div className="border-t border-dt-border pt-2 mt-1">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-[10px] uppercase tracking-wide text-dt-muted">Full draft</p>
                            {selected.status === 'pending' && !draftEditing && (
                              <button
                                onClick={() => { setDraftEditing(true); setDraftEditText(gatedDraft); setRejecting(false); setReasonCode(''); setReasonNote(''); }}
                                className="text-[10px] text-dt-accent-text hover:underline transition-colors">
                                ✎ Edit before approving
                              </button>
                            )}
                          </div>
                          {draftEditing ? (
                            <textarea
                              value={draftEditText} onChange={e => setDraftEditText(e.target.value)}
                              rows={Math.min(12, Math.max(4, gatedDraft.split('\n').length + 1))}
                              className="w-full rounded-md border border-dt-border bg-dt-inset px-2 py-1.5 text-xs text-dt-body focus:outline-none focus:border-indigo-500"
                            />
                          ) : (
                            <p className="whitespace-pre-wrap text-dt-support">{gatedDraft}</p>
                          )}
                        </div>
                      )}
                    </div>
                    {/* docs/34 approve-WITH-EDITS — mirror of the reject form below,
                        sharing its closed reason vocabulary so edits and rejections
                        aggregate together. The code is OPTIONAL here: the (before,
                        after) pair is already the signal, and forcing a code on
                        every correction would slow the queue for noise. The edited
                        text is what actually gets sent AND what lands in
                        decision_edit — never one without the other. */}
                    {draftEditing && selected.status === 'pending' && (
                      <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3">
                        <p className="text-xs font-medium text-dt-body mb-2">
                          What was wrong with it? <span className="text-dt-muted font-normal">(optional — it&apos;s what the employee learns from)</span>
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {DECISION_REASON_CODES.map(rc => (
                            <button key={rc.code} onClick={() => setDraftReasonCode(c => c === rc.code ? '' : rc.code)}
                              className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                                draftReasonCode === rc.code
                                  ? 'border-dt-ok bg-dt-ok-soft text-dt-ok'
                                  : 'border-dt-border text-dt-muted hover:text-dt-body'}`}>
                              {rc.label}
                            </button>
                          ))}
                        </div>
                        <textarea
                          value={draftNote} onChange={e => setDraftNote(e.target.value)}
                          rows={2}
                          placeholder={draftReasonCode === 'other'
                            ? 'Required — what was wrong?'
                            : 'Optional: anything that would help this employee next time'}
                          className="mt-2 w-full rounded-md border border-dt-border bg-dt-inset px-2 py-1.5 text-xs text-dt-body placeholder:text-dt-muted"
                        />
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => void approveDraftWithEdits(selected, gatedDraft)}
                            disabled={deciding || !draftEditText.trim() || (draftReasonCode === 'other' && !draftNote.trim())}
                            title={!draftEditText.trim() ? 'The draft cannot be empty'
                              : draftReasonCode === 'other' && !draftNote.trim() ? 'Other needs a note' : undefined}
                            className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 transition-colors">
                            {deciding ? '…'
                              : draftEditText.trim() === gatedDraft.trim() ? (gatedExec.destructive ? 'Approve & send' : 'Approve & execute')
                              : (gatedExec.destructive ? 'Approve edited & send' : 'Approve edited & execute')}
                          </button>
                          <button onClick={() => { setDraftEditing(false); setDraftEditText(''); setDraftReasonCode(''); setDraftNote(''); }}
                            disabled={deciding}
                            className="rounded-md border border-dt-border text-dt-muted hover:text-dt-body text-xs px-3 py-1.5 transition-colors">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Task 6 (trust-promotion program, 2026-08-21): "the evidence
                    is on the card, and thin evidence says so". Read straight
                    off the linked policy's pending_evidence snapshot — the
                    same numbers trust_evidence_for computed when this request
                    was raised — so deciding is a read, not an investigation.
                    ⚠ Thin evidence is RAISED, not suppressed (founder ruling):
                    this block never hides a no-history request, it says so —
                    both in the sentence and in the chip beside it. */}
                {selected.type === 'trust_promotion' && (
                  <div className="mt-4 bg-dt-page border border-dt-border rounded-lg px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <p className="text-[11px] uppercase tracking-wide text-dt-muted">
                        Evidence behind this request
                      </p>
                      {trustThin && <Chip tone="warn">Thin evidence</Chip>}
                    </div>
                    {trustLoading ? (
                      <p className="text-xs text-dt-support">Loading the evidence behind this request…</p>
                    ) : trustLoadError ? (
                      <p className="text-xs text-dt-warn">{trustLoadError}</p>
                    ) : !trustPolicy ? (
                      <p className="text-xs text-dt-support">No trust policy is linked to this request — approving would change nothing.</p>
                    ) : !trustCopy ? (
                      <p className="text-xs text-dt-support">This request carries no readable evidence snapshot.</p>
                    ) : (
                      <>
                        <p className="text-xs text-dt-body mb-1.5">{trustCopy.detail}</p>
                        <p className="text-[11px] text-dt-muted">{trustCopy.meta}</p>
                      </>
                    )}
                  </div>
                )}

                {/* The advisory brief (mig 705). Every line is SQL-derived
                    evidence — precedent, landed history, amount vs this
                    workspace's dials, standing. Clearly labeled advice; it
                    does not pre-select anything and the decide controls below
                    are exactly as they were without it. */}
                {selected.status === 'pending' && briefs.get(selected.id) && (() => {
                  const brief = briefs.get(selected.id)!;
                  return (
                    <div className="mt-4 bg-dt-page border border-dt-border rounded-lg px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <p className="text-[11px] uppercase tracking-wide text-dt-muted">
                          Advisory — from this workspace&apos;s own history
                        </p>
                        <Chip tone={BRIEF_CHIP[brief.risk].tone}>{BRIEF_CHIP[brief.risk].label}</Chip>
                      </div>
                      <p className="text-xs text-dt-body mb-2">{brief.headline}</p>
                      <ul className="space-y-1">
                        {brief.evidence.map((line, i) => (
                          <li key={i} className="flex gap-1.5 text-[11px] text-dt-support">
                            <span className="text-dt-faint shrink-0">•</span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2 text-[10px] text-dt-faint">
                        Advice, not a decision — the choice below stays entirely yours.
                      </p>
                    </div>
                  );
                })()}

                {selected.type === 'checklist' && selected.status === 'pending' && (
                  <div className="mt-4 space-y-1.5">
                    {(selected.checklist_state ?? []).map((item, idx) => (
                      <label key={idx} className="flex items-start gap-2 text-xs text-dt-support bg-dt-page rounded-lg px-3 py-2 cursor-pointer">
                        <input type="checkbox" checked={item.done} className="mt-0.5 accent-teal-500"
                          onChange={e => void toggleItem(selected, idx, e.target.checked)} />
                        <span className={item.done ? 'line-through text-dt-muted' : ''}>{item.text}</span>
                      </label>
                    ))}
                  </div>
                )}

                {/* Entity-guard (fix-pass 2026-07-28): the self-denial class.
                    LOUD on entity match — groundedness scoring rewards denial
                    when the KB is incomplete, so the reviewer must be told the
                    premise may be broken, not the answer. */}
                {selected.related_table === 'de_improvements' && impSignals?.entityMatch && (
                  <div className="mt-4 rounded-lg border-2 border-amber-500/60 bg-amber-500/10 px-3 py-2.5">
                    <p className="text-xs font-bold text-dt-warn mb-1">⚠ Check the premise before the answer</p>
                    <p className="text-[11px] text-dt-warn">
                      This proposes rules about &lsquo;{impSignals.entityMatch.name}&rsquo; — an active {impSignals.entityMatch.kind === 'digital_employee' ? 'digital employee' : impSignals.entityMatch.kind} in this workspace.
                      The knowledge base may be MISSING documentation rather than the answer being wrong.
                      If this article teaches an employee to deny something that actually exists, reject it and add the missing documentation instead.
                    </p>
                  </div>
                )}
                {selected.related_table === 'de_improvements' && impSignals?.outcomeKind === 'kb_missing' && (
                  <div className="mt-2">
                    <span className="inline-block text-[10px] px-2 py-0.5 rounded-full bg-dt-panel border border-dt-border text-dt-muted" title="The question that triggered this fix found zero knowledge-base hits — the KB had nothing to say, rather than saying something wrong.">
                      no KB coverage found
                    </span>
                  </div>
                )}
                {selected.related_table === 'de_improvements' && selected.status === 'pending' && impRole && impRole.peers > 0 && (
                  <div className="mt-4 bg-dt-page border border-dt-border rounded-lg px-3 py-2.5">
                    <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1.5">Who learns from this</p>
                    <label className="flex items-center gap-2 text-xs text-dt-support mb-1 cursor-pointer">
                      <input type="radio" name="impscope" checked={impScope === 'de'} onChange={() => setImpScope('de')} />
                      Just this employee
                    </label>
                    <label className="flex items-center gap-2 text-xs text-dt-support cursor-pointer">
                      <input type="radio" name="impscope" checked={impScope === 'role'} onChange={() => setImpScope('role')} />
                      All {impRole.peers + 1} {impRole.archetype} employees
                    </label>
                    {impScope === 'role' && (
                      <p className="mt-1.5 text-[11px] text-dt-warn">Shared with the whole role — confirm this fix contains no customer-specific detail.</p>
                    )}
                  </div>
                )}
                {/* docs/34 — approve WITH EDITS (mig 474). This is the exact
                    text apply_improvement publishes, not the task's prose blob,
                    so a correction here is what reaches the knowledge base and
                    what gets stored as the (before, after) training pair. */}
                {selected.status === 'pending' && proposal && (
                  <div className="mt-4 bg-dt-page border border-dt-border rounded-lg px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] uppercase tracking-wide text-dt-muted">Proposed article</p>
                      {!editing && (
                        <button onClick={() => setEditing(true)}
                          className="text-[11px] text-dt-accent hover:underline">
                          Correct it before approving
                        </button>
                      )}
                    </div>
                    {editing ? (
                      <>
                        <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={10}
                          className="mt-2 w-full rounded-md bg-dt-card border border-dt-border px-2 py-1.5 text-xs text-dt-body" />
                        <p className="mt-1 text-[11px] text-dt-muted">
                          {editText.trim() === proposal.content.trim()
                            ? 'Unchanged — approving publishes the original.'
                            : 'Edited — approving publishes YOUR version and records the correction so this employee learns from it.'}
                        </p>
                      </>
                    ) : (
                      <p className="mt-1.5 text-xs text-dt-support whitespace-pre-wrap line-clamp-6">{proposal.content}</p>
                    )}
                  </div>
                )}
                {/* Hidden while the gated-draft edit form is open — that form's
                    own approve button is the only one there, so a typed
                    correction can never be lost to a reflex click on the plain
                    Approve. (The improvement editor above is the opposite: it
                    commits THROUGH this row, whose label says so.) */}
                {/* What this decision actually moves. An approver used to see a
                    title and a paragraph; the work being held — and everything
                    queued behind it — was invisible, which is how four
                    rejections froze sixteen dependent steps unnoticed. */}
                {selected.status === 'pending' && blocked && (
                  <div className="mt-4 rounded-lg border border-dt-border bg-dt-inset px-4 py-3">
                    <p className="text-[10px] uppercase tracking-wide text-dt-faint mb-1.5">Work this is holding up</p>
                    <p className="text-sm text-dt-body">{blocked.title}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <Chip tone={blocked.status === 'waiting_human' ? 'warn' : 'neutral'}>{blocked.status.replace(/_/g, ' ')}</Chip>
                      {blocked.waitingSince && (
                        <span className="text-[11px] text-dt-muted">
                          waiting {Math.max(0, Math.round((Date.now() - new Date(blocked.waitingSince).getTime()) / 3.6e6))}h
                        </span>
                      )}
                      {blocked.queuedBehind > 0 && (
                        <Chip tone="danger">{blocked.queuedBehind} step{blocked.queuedBehind === 1 ? '' : 's'} frozen behind it</Chip>
                      )}
                    </div>
                    {blocked.question && (
                      <div className="mt-3">
                        <p className="text-[10px] uppercase tracking-wide text-dt-faint mb-1">What it asked</p>
                        <p className="text-[13px] text-dt-muted whitespace-pre-wrap">{blocked.question.slice(0, 1200)}</p>
                      </div>
                    )}
                  </div>
                )}
                {/* The answer that resumes the work (mig 483 appends it to the
                    exact field the next run reads). Optional — approving alone
                    still unfreezes the task — but this is the only way to say
                    HOW to proceed, so it sits above the button, not behind a
                    disclosure. */}
                {selected.status === 'pending' && !draftEditing && !rejecting && blocked && (
                  <div className="mt-3">
                    <label htmlFor="dt-instruction" className="block text-xs font-medium text-dt-body mb-1.5">
                      Your answer to the employee <span className="text-dt-faint font-normal">— optional, but it is what tells them how to proceed</span>
                    </label>
                    <textarea
                      id="dt-instruction"
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      rows={3}
                      placeholder="e.g. Use the contract record in Commercial Continuity; price the renewal with the 7% contractual increase."
                      className={INPUT_CLS}
                    />
                  </div>
                )}
                {selected.status === 'pending' && !draftEditing && (
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => void decide(selected, 'approved')}
                      disabled={deciding || trustLoading || (selected.type === 'checklist' && !(selected.checklist_state ?? []).every(i => i.done))}
                      title={selected.type === 'checklist' && !(selected.checklist_state ?? []).every(i => i.done) ? 'Tick every item before completing this checklist'
                        // Fix round 2: same pane the evidence block renders
                        // in — approving before it settles is deciding a
                        // trust promotion having seen nothing.
                        : trustLoading ? 'Still loading the evidence behind this request'
                        : undefined}
                      className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2 transition-colors">
                      {deciding ? '…'
                        : trustLoading ? 'Checking…'
                        : selected.type === 'checklist' ? 'Mark complete'
                        : selected.type === 'action_approval' && gatedExec?.destructive ? 'Approve & send'
                        : selected.type === 'action_approval' ? 'Approve & execute'
                        // A gated reply now really goes to the customer on
                        // approve (mig 721), so the button says so — and only
                        // when there is one, on a channel that can carry it.
                        : replyDraft?.deliverable ? 'Approve & send the reply'
                        // Say what the button will actually publish. An approver
                        // who corrected the text should not have to trust that
                        // the edit was picked up.
                        : proposal && editText.trim() !== proposal.content.trim() ? 'Approve with your edit'
                        : 'Approve'}
                    </button>
                    <button onClick={() => setRejecting(true)} disabled={deciding}
                      className="flex-1 rounded-lg bg-red-600/30 hover:bg-red-600/50 disabled:opacity-50 text-red-400 border border-red-500/30 text-sm font-medium py-2 transition-colors">
                      Reject
                    </button>
                  </div>
                )}
                {/* N4's third disposition. Offered only on a work blocker —
                    rerouting a chat escalation has no work to move. */}
                {selected.status === 'pending' && !draftEditing && !rejecting && blocked && colleagues.length > 0 && (
                  <div className="mt-2">
                    {!rerouting ? (
                      <button onClick={() => setRerouting(true)} disabled={deciding}
                        className="text-[11px] text-dt-faint hover:text-dt-accent-text">
                        …or hand this to a different employee
                      </button>
                    ) : (
                      <div className="rounded-lg border border-dt-border bg-dt-inset p-3">
                        <p className="text-xs font-medium text-dt-body mb-2">Who should own this instead?</p>
                        <select value={rerouteTo} onChange={(e) => setRerouteTo(e.target.value)} className={INPUT_CLS}>
                          <option value="">Choose an employee…</option>
                          {colleagues.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <textarea value={rerouteNote} onChange={(e) => setRerouteNote(e.target.value)} rows={2}
                          placeholder="Required — why does it belong with them?"
                          className={`${INPUT_CLS} mt-2`} />
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => void doReroute()}
                            disabled={deciding || !rerouteTo || !rerouteNote.trim()}
                            className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2 transition-colors">
                            Hand it over
                          </button>
                          <button onClick={() => { setRerouting(false); setRerouteTo(''); setRerouteNote(''); }}
                            className="rounded-lg border border-dt-border text-dt-support text-sm px-3 transition-colors hover:text-dt-body">
                            Cancel
                          </button>
                        </div>
                        <p className="text-[11px] text-dt-muted mt-2">
                          The step closes with your reason, they get it as their own task, and anything queued behind it stays runnable.
                        </p>
                      </div>
                    )}
                  </div>
                )}
                {/* docs/34 — a rejection must say why. Closed codes rather than a
                    free-text box: on a queue this size free text decays to "ok"
                    and "no", and codes aggregate ("wrong_tone, 12 times, one
                    employee") where sentences do not. Asked BEFORE the decision
                    commits, because asking afterwards is how you get noise. */}
                {selected.status === 'pending' && rejecting && (
                  <div className="mt-3 rounded-lg border border-red-500/30 bg-red-950/20 p-3">
                    <p className="text-xs font-medium text-dt-body mb-2">Why is this being rejected?</p>
                    <div className="flex flex-wrap gap-1.5">
                      {DECISION_REASON_CODES.map(rc => (
                        <button key={rc.code} onClick={() => setReasonCode(rc.code)}
                          className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                            reasonCode === rc.code
                              ? 'border-dt-danger bg-dt-danger-soft text-dt-danger'
                              : 'border-dt-border text-dt-muted hover:text-dt-body'}`}>
                          {rc.label}
                        </button>
                      ))}
                    </div>
                    <textarea
                      value={reasonNote} onChange={e => setReasonNote(e.target.value)}
                      rows={2}
                      placeholder={reasonCode === 'other'
                        ? 'Required — what was wrong?'
                        : 'Optional: anything that would help this employee next time'}
                      className="mt-2 w-full rounded-md border border-dt-border bg-dt-inset px-2 py-1.5 text-xs text-dt-body placeholder:text-dt-muted"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => void decide(selected, 'rejected')}
                        disabled={deciding || !reasonCode || (reasonCode === 'other' && !reasonNote.trim())}
                        title={!reasonCode ? 'Pick a reason first'
                          : reasonCode === 'other' && !reasonNote.trim() ? 'Other needs a note' : undefined}
                        className="rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 transition-colors">
                        {deciding ? '…' : 'Confirm rejection'}
                      </button>
                      <button onClick={() => { setRejecting(false); setReasonCode(''); setReasonNote(''); }}
                        disabled={deciding}
                        className="rounded-md border border-dt-border text-dt-muted hover:text-dt-body text-xs px-3 py-1.5 transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {selected.related_table === 'renewal_invoices' && selected.status === 'pending' && (
                  <p className="mt-3 text-[11px] text-dt-muted">Approving sends the invoice to the customer.</p>
                )}
                <p className="mt-3 text-[11px] text-dt-faint">Decisions are timestamped and recorded in the activity log.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function HumanTasksPage({ setPage }: { setPage: (p: Page) => void }) {
  return <LiveHumanTasks setPage={setPage} />;
}

