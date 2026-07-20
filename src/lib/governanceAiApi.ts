// AI-assisted governance (Governance rebuild, Part 2).
//
// A non-technical user talks to the Workspace Assistant to set up safety
// guardrails. The assistant can ONLY record a pending proposal — it has no
// path that writes a live guardrail. A person approves each proposal here,
// and approval creates the real rule through the SAME audited path used by
// hand (addGuardrailRule / updateGuardrailRule under RLS). So the assistant
// suggests; a human clicks.
import { supabase } from '../supabase';
import { requireTenantId } from './liveShared';
import {
  addGuardrailRule, updateGuardrailRule, listGuardrailRules,
  type GuardrailScope, type GuardrailRuleType,
} from './guardrailApi';

export type ProposalAction = 'add' | 'pause' | 'resume' | 'edit';

export interface GovernanceProposal {
  id: string;
  scope: GuardrailScope;
  scope_ref: string | null;
  action: ProposalAction;
  rule_type: GuardrailRuleType | null;
  rule_name: string | null;
  pattern: string | null;
  threshold: number | null;
  severity: 'blocking' | 'warning' | null;
  target_rule_id: string | null;
  rationale: string;
  status: 'pending' | 'approved' | 'dismissed';
  created_at: string;
}

export interface GovernanceTurn {
  session_id: string;
  reply: string;
  /** Human-readable proposal summaries the assistant recorded this turn. */
  proposed: Array<{ what: string; why: string }>;
}

function friendly(raw: string): string {
  if (raw.includes('llm_not_configured')) return 'The AI engine is not connected yet. Add an API key in Settings → AI Engine.';
  if (raw.includes('ai_budget_exceeded')) return 'This workspace has used its AI budget for the month. Raise the limit in Settings to carry on.';
  if (raw.includes('not_authorized')) return 'Only a workspace owner or admin can approve a guardrail change.';
  if (raw.includes('already_decided')) return 'That proposal has already been approved or dismissed.';
  return raw;
}

/** Talk to the governance assistant. Omit sessionId to start fresh. */
export async function sendGovernanceMessage(args: {
  scope: GuardrailScope;
  scopeRef: string | null;
  message: string;
  sessionId?: string | null;
}): Promise<GovernanceTurn> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.functions.invoke('ai-session', {
    body: {
      subject_kind: 'governance',
      gov_scope: args.scope,
      gov_scope_ref: args.scopeRef,
      message: args.message,
      session_id: args.sessionId ?? null,
      tenant_id: tid,
    },
  });
  const payloadError = (data as { error?: string } | null)?.error;
  if (error || payloadError) throw new Error(friendly(payloadError || error?.message || 'The assistant could not be reached.'));
  const d = data as GovernanceTurn;
  return {
    session_id: d.session_id,
    reply: d.reply ?? '',
    proposed: Array.isArray(d.proposed) ? d.proposed : [],
  };
}

/** Resume the latest governance conversation for a scope. */
export async function findLatestGovernanceSession(scope: GuardrailScope, scopeRef: string | null): Promise<string | null> {
  const tid = await requireTenantId();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return null;
  const isUuid = !!scopeRef && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scopeRef);
  let q = supabase.from('ai_sessions').select('id')
    .eq('tenant_id', tid).eq('user_id', auth.user.id)
    .eq('subject_kind', 'governance').eq('status', 'active')
    .order('updated_at', { ascending: false }).limit(1);
  q = isUuid ? q.eq('subject_id', scopeRef) : q.is('subject_id', null);
  const { data } = await q;
  return data?.[0]?.id ?? null;
}

/** Pending proposals for a scope — what the assistant is waiting on a human for. */
export async function listPendingProposals(scope: GuardrailScope, scopeRef: string | null): Promise<GovernanceProposal[]> {
  const tid = await requireTenantId();
  let q = supabase.from('governance_proposals').select('*')
    .eq('tenant_id', tid).eq('status', 'pending').eq('scope', scope)
    .order('created_at', { ascending: false });
  q = scopeRef ? q.eq('scope_ref', scopeRef) : q.is('scope_ref', null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as GovernanceProposal[];
}

/**
 * Approve a proposal. This is where the guardrail actually changes — through
 * the ordinary audited path, run as the logged-in human. The assistant never
 * reaches this code. After the rule is created/updated we stamp the proposal
 * approved and link the rule it produced.
 */
export async function approveProposal(p: GovernanceProposal): Promise<void> {
  let appliedRuleId: string | null = null;

  if (p.action === 'add') {
    const rule = await addGuardrailRule({
      rule: p.rule_name || 'Guardrail',
      rule_type: (p.rule_type || 'blocked_phrase') as GuardrailRuleType,
      pattern: p.pattern,
      threshold: p.threshold,
      severity: p.severity || 'blocking',
      scope: p.scope,
      scope_ref: p.scope_ref,
      applies_to: 'all',
      active: true,
    });
    appliedRuleId = rule.id;
  } else if (p.action === 'pause' || p.action === 'resume' || p.action === 'edit') {
    if (!p.target_rule_id) throw new Error('This proposal points at a rule that no longer exists.');
    // Reload the target so updateGuardrailRule has the current version.
    const all = await listGuardrailRules();
    const target = all.find((r) => r.id === p.target_rule_id);
    if (!target) throw new Error('This proposal points at a rule that no longer exists.');
    if (p.action === 'pause') await updateGuardrailRule(target, { active: false });
    else if (p.action === 'resume') await updateGuardrailRule(target, { active: true });
    else {
      await updateGuardrailRule(target, {
        rule: p.rule_name || target.rule,
        pattern: p.pattern ?? target.pattern,
        threshold: p.threshold ?? target.threshold,
        severity: p.severity || target.severity,
      });
    }
    appliedRuleId = p.target_rule_id;
  }

  const { data, error } = await supabase.rpc('governance_decide_proposal', {
    p_proposal_id: p.id, p_decision: 'approved', p_applied_rule_id: appliedRuleId,
  });
  // The rule change already happened (the important part); a failure to stamp
  // the proposal is surfaced but does not undo the guardrail.
  const res = data as { ok?: boolean; error?: string } | null;
  if (error || res?.ok === false) throw new Error(friendly(error?.message || res?.error || 'Could not record the approval.'));
}

export async function dismissProposal(id: string): Promise<void> {
  const { data, error } = await supabase.rpc('governance_decide_proposal', {
    p_proposal_id: id, p_decision: 'dismissed', p_applied_rule_id: null,
  });
  const res = data as { ok?: boolean; error?: string } | null;
  if (error || res?.ok === false) throw new Error(friendly(error?.message || res?.error || 'Could not dismiss the proposal.'));
}
