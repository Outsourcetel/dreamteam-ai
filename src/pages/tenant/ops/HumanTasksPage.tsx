import React, { useState, useEffect } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader } from '../../../components/ui';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { loadChatEscalations, setChatEscalationStatus, chatEscalationAge } from '../../../lib/chatEscalations';
import type { GatedExecutionPreview } from '../../../lib/connectorApi';
import { listHumanTasks, decideHumanTask, toggleChecklistItem, listOpenStalenessEscalations, CustomerApiError, setImprovementPublishScope, getImprovementRoleInfo, getImprovementProposal, getImprovementReviewSignals, DECISION_REASON_CODES, getBlockedWorkForTask, rerouteEscalation, retryAnswerableBlockers } from '../../../lib/customerApi';
import type { BlockedWork } from '../../../lib/customerApi';
import type { DecisionCapture, DecisionReasonCode } from '../../../lib/customerApi';
import type { DBHumanTask, StalenessEscalation } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
// Design system is law (docs/design-system.md): the blocked-work panel uses
// Chip and INPUT_CLS rather than another hand-rolled badge/input, which the
// drift detector counts and fails on.
import { Chip, INPUT_CLS, TabBar } from '../../../design/primitives';
import { listDigitalEmployees } from '../../../lib/digitalEmployeesApi';

// ── Types ─────────────────────────────────────────────────────────

type TaskType = 'approval_gate' | 'review_gate' | 'escalation' | 'override' | 'training_feedback' | 'trust_promotion' | 'trust_demotion_notice' | 'checklist' | 'knowledge_revision' | 'inquiry_review' | 'action_approval';
type TaskStatus = 'pending' | 'approved' | 'rejected' | 'completed';

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
  if (type === 'approval_gate') return 'bg-indigo-500/20 text-indigo-300';
  if (type === 'review_gate') return 'bg-blue-500/20 text-blue-300';
  if (type === 'escalation') return 'bg-red-500/20 text-red-300';
  if (type === 'override') return 'bg-amber-500/20 text-amber-300';
  if (type === 'trust_promotion') return 'bg-emerald-500/20 text-emerald-300';
  if (type === 'trust_demotion_notice') return 'bg-rose-500/20 text-rose-300';
  if (type === 'checklist') return 'bg-teal-500/20 text-teal-300';
  if (type === 'knowledge_revision') return 'bg-amber-500/20 text-amber-300';
  if (type === 'inquiry_review') return 'bg-sky-500/20 text-sky-300';
  if (type === 'action_approval') return 'bg-fuchsia-500/20 text-fuchsia-300';
  return 'bg-slate-600 text-dt-support';
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
    completed: 'bg-slate-600 text-dt-support',
  };
  const labels: Record<TaskStatus, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', completed: 'Completed' };
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
    return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/40" title="Past the breach threshold — this has gone stale for longer than policy allows.">⏱ STALLED · OVERDUE</span>;
  }
  return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/15 text-orange-300 border border-orange-500/30" title="Past the warning threshold — nothing has happened on this in a while.">⏱ STALLED</span>;
}

/** N4 (founder decision, block 4): ONE queue, work blockers first.
 *
 *  125 of this workspace's 175 pending items are support-chat escalations. An
 *  undifferentiated merge buries the 45 work blockers — and those are the ones
 *  where an answer restarts frozen work, because since mig 483 a decision on
 *  them actually moves the work item. Nothing is hidden; the queue simply opens
 *  where the consequence is. */
type Scope = 'work' | 'chat' | 'all';
const WORK_TABLES = ['de_work_items', 'de_objectives'];
const inScope = (t: DBHumanTask, s: Scope) =>
  s === 'all' ? true
    : s === 'work' ? WORK_TABLES.includes(String(t.related_table ?? ''))
    : String(t.related_table ?? '') === 'de_conversations';

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
  const [staleness, setStaleness] = useState<Map<string, StalenessEscalation>>(new Map());
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskType | 'all'>('all');
  // Opens on work, per N4. Chat is one click away, never hidden.
  const [scope, setScope] = useState<Scope>('work');
  const [stalledOnly, setStalledOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [gatedExec, setGatedExec] = useState<GatedExecutionPreview | null>(null);
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
      await decideHumanTask(task, decision, capture ?? (decision === 'rejected'
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
  const decidedCount = tasks.filter(t => t.status !== 'pending').length;
  const approvedCount = tasks.filter(t => t.status === 'approved').length;
  const approvalRate = decidedCount > 0 ? Math.round((approvedCount / decidedCount) * 100) : 0;
  const stalledCount = pending.filter(t => staleness.has(t.id)).length;
  const visible = tasks.filter(t => inScope(t, scope) && (filter === 'all' || t.type === filter) && (!stalledOnly || staleness.has(t.id)));
  const scopeCount = (s: Scope) => tasks.filter(t => t.status === 'pending' && inScope(t, s)).length;
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
  const selectedStale = selected ? staleness.get(selected.id) ?? null : null;
  // Same precedence as the Full-draft display below — the text the approver
  // sees is exactly the text their edit replaces.
  const gatedDraft = gatedExec ? (gatedExec.params.body || gatedExec.params.note || '') : '';

  return (
    <div className="p-6">
      <PageHeader
        title="Human Tasks"
        subtitle="The human command queue — approvals, reviews, escalations, and overrides raised by your Digital Employees"
      />

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : tasks.length === 0 ? (
        <LiveEmptyState
          icon="✋"
          title="No human tasks yet"
          body="When a Digital Employee needs a human decision — like approving a renewal invoice over $10K — it shows up here."
          primaryLabel="Go to Renewal & Expansion"
          onPrimary={() => setPage('entity_customer_renewal')}
        />
      ) : (
        <>
          {/* Stats strip */}
          <div className="grid grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Pending', value: String(pending.length), color: pending.length > 0 ? 'text-amber-300' : 'text-emerald-300' },
              { label: 'Stalled work', value: String(stalledCount), color: stalledCount > 0 ? 'text-orange-300' : 'text-emerald-300' },
              { label: 'Decided', value: String(decidedCount), color: 'text-white' },
              { label: 'Approval rate', value: `${approvalRate}%`, color: 'text-white' },
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
          {scope !== 'chat' && (
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
                { key: 'work', label: 'Blocking work', badge: scopeCount('work') > 0 ? <Chip tone="warn">{scopeCount('work')}</Chip> : undefined },
                { key: 'chat', label: 'From conversations', badge: scopeCount('chat') > 0 ? <Chip tone="neutral">{scopeCount('chat')}</Chip> : undefined },
                { key: 'all', label: 'Everything', badge: scopeCount('all') > 0 ? <Chip tone="neutral">{scopeCount('all')}</Chip> : undefined },
              ]}
              active={scope}
              onSelect={setScope}
            />
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            {FILTERS.map(f => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`px-3 py-1.5 rounded-full text-xs transition-colors ${filter === f.id ? 'bg-indigo-600 text-white' : 'bg-dt-card border border-dt-border text-dt-support hover:text-dt-body'}`}
              >
                {f.label}
              </button>
            ))}
            <div className="flex-1" />
            <button
              onClick={() => setStalledOnly(v => !v)}
              className={`px-3 py-1.5 rounded-full text-xs transition-colors ${stalledOnly ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40' : 'bg-dt-card border border-dt-border text-dt-support hover:text-dt-body'}`}
            >
              ⏱ Stalled work only{stalledCount > 0 ? ` (${stalledCount})` : ''}
            </button>
          </div>

          <div className="grid grid-cols-5 gap-4">
            {/* Task list */}
            <div className={`${selected ? 'col-span-3' : 'col-span-5'} space-y-1.5`}>
              {visible.length === 0 && (
                <div className="text-center py-10 border border-dashed border-dt-border rounded-xl">
                  <p className="text-dt-muted text-sm">
                    {stalledOnly ? 'No stalled work right now — nothing has gone quiet past its threshold.' : 'No tasks match the current filter.'}
                  </p>
                </div>
              )}
              {visible.map(task => {
                const stale = staleness.get(task.id);
                return (
                <button
                  key={task.id}
                  onClick={() => setSelectedId(task.id)}
                  className={`w-full text-left grid grid-cols-[100px_1fr_70px_80px] gap-2 items-center px-3 py-2.5 rounded-xl border transition-colors ${
                    selectedId === task.id ? 'border-indigo-500/50 bg-dt-panel/60'
                    : stale ? (stale.tier === 'breach' ? 'border-red-500/30 bg-red-500/5 hover:bg-red-500/10' : 'border-orange-500/25 bg-orange-500/5 hover:bg-orange-500/10')
                    : task.status !== 'pending' ? 'border-dt-border bg-dt-card opacity-70 hover:opacity-100'
                    : 'border-dt-border bg-dt-card hover:bg-dt-panel'
                  }`}
                >
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded w-fit ${taskBadgeStyle(task.type)}`}>
                    {taskBadgeLabel(task.type)}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs text-dt-body truncate">{task.title}</span>
                      {stale && stalledBadge(stale.tier)}
                    </div>
                    {task.detail && <span className="text-[10px] text-dt-muted">{task.detail}</span>}
                  </div>
                  <span className="text-xs text-dt-muted">{taskAge(task.created_at)}</span>
                  <span className="justify-self-end">{statusBadge(task.status as TaskStatus)}</span>
                </button>
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
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${taskBadgeStyle(selected.type)}`}>{taskBadgeLabel(selected.type)}</span>
                  <button onClick={() => setSelectedId(null)} className="w-6 h-6 rounded bg-dt-panel text-dt-muted hover:text-white flex items-center justify-center text-xs">×</button>
                </div>
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <h3 className="text-sm font-semibold text-white">{selected.title}</h3>
                  {selectedStale && stalledBadge(selectedStale.tier)}
                </div>
                {selected.detail && <p className="text-xs text-dt-support mb-3">{selected.detail}</p>}
                {selectedStale && (
                  <div className={`mb-3 rounded-lg px-3 py-2 text-[11px] ${selectedStale.tier === 'breach' ? 'bg-red-500/10 border border-red-500/30 text-red-200' : 'bg-orange-500/10 border border-orange-500/30 text-orange-200'}`}>
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
                      <button onClick={() => setPage('entity_customer_renewal')} className="text-indigo-400 hover:text-indigo-300 transition-colors">Renewal &amp; Expansion →</button>
                    </div>
                  )}
                  {selected.related_table === 'knowledge_revision_requests' && (
                    <div className="flex items-center justify-between bg-dt-page rounded-lg px-3 py-2">
                      <span className="text-dt-muted">Related</span>
                      <button onClick={() => setPage('knowledge_library')} className="text-indigo-400 hover:text-indigo-300 transition-colors">Knowledge Library → Revisions →</button>
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
                                className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors">
                                ✎ Edit before approving
                              </button>
                            )}
                          </div>
                          {draftEditing ? (
                            <textarea
                              value={draftEditText} onChange={e => setDraftEditText(e.target.value)}
                              rows={Math.min(12, Math.max(4, gatedDraft.split('\n').length + 1))}
                              className="w-full rounded-md border border-dt-border bg-dt-bg px-2 py-1.5 text-xs text-dt-text focus:outline-none focus:border-indigo-500"
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
                        <p className="text-xs font-medium text-dt-text mb-2">
                          What was wrong with it? <span className="text-dt-muted font-normal">(optional — it&apos;s what the employee learns from)</span>
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {DECISION_REASON_CODES.map(rc => (
                            <button key={rc.code} onClick={() => setDraftReasonCode(c => c === rc.code ? '' : rc.code)}
                              className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                                draftReasonCode === rc.code
                                  ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200'
                                  : 'border-dt-border text-dt-muted hover:text-dt-text'}`}>
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
                          className="mt-2 w-full rounded-md border border-dt-border bg-dt-bg px-2 py-1.5 text-xs text-dt-text placeholder:text-dt-muted"
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
                            className="rounded-md border border-dt-border text-dt-muted hover:text-dt-text text-xs px-3 py-1.5 transition-colors">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

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
                    <p className="text-xs font-bold text-amber-300 mb-1">⚠ Check the premise before the answer</p>
                    <p className="text-[11px] text-amber-200/90">
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
                      <p className="mt-1.5 text-[11px] text-amber-300">Shared with the whole role — confirm this fix contains no customer-specific detail.</p>
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
                          className="mt-2 w-full rounded-md bg-dt-card border border-dt-border px-2 py-1.5 text-xs text-dt-text" />
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
                    <label htmlFor="dt-instruction" className="block text-xs font-medium text-dt-text mb-1.5">
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
                      disabled={deciding || (selected.type === 'checklist' && !(selected.checklist_state ?? []).every(i => i.done))}
                      title={selected.type === 'checklist' && !(selected.checklist_state ?? []).every(i => i.done) ? 'Tick every item before completing this checklist' : undefined}
                      className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2 transition-colors">
                      {deciding ? '…'
                        : selected.type === 'checklist' ? 'Mark complete'
                        : selected.type === 'action_approval' && gatedExec?.destructive ? 'Approve & send'
                        : selected.type === 'action_approval' ? 'Approve & execute'
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
                        className="text-[11px] text-dt-faint hover:text-indigo-300">
                        …or hand this to a different employee
                      </button>
                    ) : (
                      <div className="rounded-lg border border-dt-border bg-dt-inset p-3">
                        <p className="text-xs font-medium text-dt-text mb-2">Who should own this instead?</p>
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
                    <p className="text-xs font-medium text-dt-text mb-2">Why is this being rejected?</p>
                    <div className="flex flex-wrap gap-1.5">
                      {DECISION_REASON_CODES.map(rc => (
                        <button key={rc.code} onClick={() => setReasonCode(rc.code)}
                          className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                            reasonCode === rc.code
                              ? 'border-red-400 bg-red-500/20 text-red-200'
                              : 'border-dt-border text-dt-muted hover:text-dt-text'}`}>
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
                      className="mt-2 w-full rounded-md border border-dt-border bg-dt-bg px-2 py-1.5 text-xs text-dt-text placeholder:text-dt-muted"
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
                        className="rounded-md border border-dt-border text-dt-muted hover:text-dt-text text-xs px-3 py-1.5 transition-colors">
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

