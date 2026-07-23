import React, { useState, useEffect } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader } from '../../../components/ui';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { loadChatEscalations, setChatEscalationStatus, chatEscalationAge } from '../../../lib/chatEscalations';
import type { GatedExecutionPreview } from '../../../lib/connectorApi';
import { listHumanTasks, decideHumanTask, toggleChecklistItem, listOpenStalenessEscalations, CustomerApiError } from '../../../lib/customerApi';
import type { DBHumanTask, StalenessEscalation } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';

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
  const [stalledOnly, setStalledOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [gatedExec, setGatedExec] = useState<GatedExecutionPreview | null>(null);

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

  const decide = async (task: DBHumanTask, decision: 'approved' | 'rejected') => {
    setDeciding(true);
    try {
      await decideHumanTask(task, decision);
      await refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to record decision.');
    } finally {
      setDeciding(false);
    }
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
  const visible = tasks.filter(t => (filter === 'all' || t.type === filter) && (!stalledOnly || staleness.has(t.id)));
  const selected = tasks.find(t => t.id === selectedId) ?? null;
  const selectedStale = selected ? staleness.get(selected.id) ?? null : null;

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

            {/* Detail panel */}
            {selected && (
              <div className="col-span-2 bg-dt-card border border-dt-border rounded-2xl p-5 h-fit sticky top-0">
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

                {selected.type === 'action_approval' && gatedExec && (
                  <div className="mt-4">
                    <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1.5">
                      {gatedExec.destructive ? 'What will be sent / changed on approval' : 'What will happen on approval'}
                    </p>
                    <div className="bg-dt-page border border-dt-border rounded-lg px-3 py-2 text-xs text-dt-support">
                      <p className="font-medium text-dt-body mb-1">{gatedExec.action_label}</p>
                      {gatedExec.request_summary && <p className="text-dt-support mb-2">{gatedExec.request_summary}</p>}
                      {(gatedExec.params.body || gatedExec.params.note) && (
                        <div className="border-t border-dt-border pt-2 mt-1">
                          <p className="text-[10px] uppercase tracking-wide text-dt-muted mb-1">Full draft</p>
                          <p className="whitespace-pre-wrap text-dt-support">{gatedExec.params.body || gatedExec.params.note}</p>
                        </div>
                      )}
                    </div>
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

                {selected.status === 'pending' && (
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
                        : 'Approve'}
                    </button>
                    <button onClick={() => void decide(selected, 'rejected')} disabled={deciding}
                      className="flex-1 rounded-lg bg-red-600/30 hover:bg-red-600/50 disabled:opacity-50 text-red-400 border border-red-500/30 text-sm font-medium py-2 transition-colors">
                      Reject
                    </button>
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

