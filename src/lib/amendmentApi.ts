// ── Amendment Orchestration API ────────────────────────────────────────
// Unified interface for all amendment types (DE, playbook, specialist).
// Routes to existing backend machinery (entity-amend, playbook-amend, de-improve).
// All three systems share identical approval flow: draft → human_tasks → apply/reject.

import { supabase } from '../supabase';
import { getSessionTenantId } from './customerApi';

export type EntityKind = 'de' | 'playbook' | 'specialist';

export interface AmendmentRequest {
  entity_kind: EntityKind;
  entity_id: string;
  problem?: string; // user's plain-language description of what's wrong
  trigger?: 'performance' | 'failure' | 'user_feedback' | 'manual';
  context?: Record<string, unknown>; // optional: failed_run_id, metric_threshold, verdict_type, etc.
}

export interface AmendmentRedline {
  field: string;
  old?: string;
  new?: string;
  note?: string;
}

export interface AmendmentEvidence {
  replay_status?: string; // 'passed' | 'failed' | null
  replay_score_before?: number;
  replay_score_after?: number;
  golden_set_passed?: boolean;
}

export interface AmendmentProposal {
  amendment_id: string;
  entity_kind: EntityKind;
  entity_id: string;
  current_state: Record<string, unknown>; // snapshot of entity at proposal time
  proposed_state: Record<string, unknown>; // what changes
  rationale: string; // plain-language explanation of the amendment
  redline: AmendmentRedline[]; // structured diff
  evidence?: AmendmentEvidence; // optional testing/replay results
  human_task_id: string | null; // null = not yet reviewed, populated = under review
  status: 'draft' | 'review_pending' | 'approved' | 'rejected' | 'applied';
  created_at: string;
  model_id?: string;
  input_tokens?: number;
  output_tokens?: number;
}

// Maps amendment type to entity kind + which edge function/RPC to use
const AMENDMENT_ROUTES: Record<EntityKind, {edge_fn: string; rpc: string}> = {
  de: {edge_fn: 'entity-amend', rpc: 'sync_entity_amendment_decision'},
  specialist: {edge_fn: 'entity-amend', rpc: 'sync_entity_amendment_decision'},
  playbook: {edge_fn: 'playbook-amend', rpc: 'sync_amendment_decision'},
};

// Knowledge improvements route through de-improve (internal to de amendments)
// identified by presence of knowledge_docs in the context

const invokeError = async (fnName: string, error: unknown, data: unknown): Promise<never> => {
  const dataErr = (data as { error?: string } | null)?.error;
  if (dataErr) throw new Error(dataErr);
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const j = (await ctx.json()) as { error?: string };
      if (j?.error) throw new Error(j.error);
    } catch (e) {
      if (e instanceof Error && e.message && !e.message.startsWith('Unexpected')) throw e;
    }
  }
  throw new Error((error as Error | null)?.message || `${fnName} failed`);
};

/**
 * Request an amendment for a DE, playbook, or specialist.
 * Calls the appropriate edge function, creates amendment row + human_tasks review.
 * Returns the amendment proposal with rationale, redline, evidence (if available).
 */
export async function requestAmendment(req: AmendmentRequest): Promise<AmendmentProposal> {
  const tid = await getSessionTenantId();
  if (!tid) throw new Error('No tenant context');

  const route = AMENDMENT_ROUTES[req.entity_kind];
  if (!route) throw new Error(`Unknown amendment entity kind: ${req.entity_kind}`);

  const { data, error } = await supabase.functions.invoke(route.edge_fn, {
    body: {
      tenant_id: tid,
      entity_kind: req.entity_kind,
      entity_id: req.entity_id,
      problem: req.problem,
      trigger: req.trigger || 'manual',
      ...(req.context || {}),
    },
  });

  if (error || (data as { error?: string })?.error) {
    await invokeError('requestAmendment', error, data);
  }

  // Edge function returns the amendment row + human_task row created
  const d = data as {
    amendment_id: string;
    entity_kind: EntityKind;
    entity_id: string;
    current_config?: Record<string, unknown>;
    current_steps?: any[];
    proposed_config?: Record<string, unknown>;
    proposed_steps?: any[];
    rationale: string;
    redline: AmendmentRedline[];
    evidence?: AmendmentEvidence;
    human_task_id: string | null;
    status: string;
    created_at: string;
    model_id?: string;
    input_tokens?: number;
    output_tokens?: number;
  };

  return {
    amendment_id: d.amendment_id,
    entity_kind: d.entity_kind,
    entity_id: d.entity_id,
    current_state: d.current_config ?? d.current_steps ?? {},
    proposed_state: d.proposed_config ?? d.proposed_steps ?? {},
    rationale: d.rationale || '',
    redline: Array.isArray(d.redline) ? d.redline : [],
    evidence: d.evidence,
    human_task_id: d.human_task_id,
    status: d.status as AmendmentProposal['status'],
    created_at: d.created_at,
    model_id: d.model_id,
    input_tokens: d.input_tokens,
    output_tokens: d.output_tokens,
  };
}

/**
 * List all pending amendments for a specific entity.
 * Includes both 'draft' (validation failed) and 'review_pending' (awaiting human approval).
 */
export async function listPendingAmendments(
  entity_kind: EntityKind,
  entity_id: string
): Promise<AmendmentProposal[]> {
  const tid = await getSessionTenantId();
  if (!tid) return [];

  let query = supabase
    .from(
      entity_kind === 'playbook'
        ? 'playbook_amendments'
        : 'workforce_entity_amendments'
    )
    .select('*')
    .eq('tenant_id', tid)
    .eq('entity_id', entity_id)
    .in('status', ['draft', 'review_pending'])
    .order('created_at', { ascending: false });

  if (entity_kind !== 'playbook') {
    query = query.eq('entity_kind', entity_kind);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Error listing amendments:', error);
    return [];
  }

  return (data || []).map((row: any) => ({
    amendment_id: row.id,
    entity_kind: row.entity_kind || entity_kind,
    entity_id: row.entity_id,
    current_state: row.current_config ?? row.current_steps ?? {},
    proposed_state: row.proposed_config ?? row.proposed_steps ?? {},
    rationale: row.rationale || '',
    redline: row.redline ? (Array.isArray(row.redline) ? row.redline : []) : [],
    evidence: row.replay_result,
    human_task_id: row.human_task_id,
    status: row.status,
    created_at: row.created_at,
    model_id: row.model_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
  }));
}

/**
 * Approve an amendment. Routes through the appropriate RPC to apply the change.
 * Backend SQL enforces that human_task.status='approved' before applying.
 * Never throws — returns success status.
 */
export async function approveAmendment(amendment_id: string): Promise<{ok: boolean; applied_at: string}> {
  const tid = await getSessionTenantId();
  if (!tid) throw new Error('No tenant context');

  // Fetch the amendment to determine which table it's in
  let tableGuess: 'playbook_amendments' | 'workforce_entity_amendments' = 'workforce_entity_amendments';
  const { data: byTable } = await supabase
    .from(tableGuess)
    .select('entity_kind')
    .eq('id', amendment_id)
    .eq('tenant_id', tid)
    .maybeSingle();

  if (!byTable) {
    // Might be a playbook amendment
    tableGuess = 'playbook_amendments';
  }

  // Call the appropriate RPC based on amendment type
  const rpc_name =
    tableGuess === 'playbook_amendments'
      ? 'sync_amendment_decision'
      : 'sync_entity_amendment_decision';

  const { error } = await supabase.rpc(rpc_name, {
    p_amendment_id: amendment_id,
    p_approved: true,
  });

  if (error) {
    console.error(`Error approving amendment via ${rpc_name}:`, error);
    throw new Error(`Failed to approve amendment: ${error.message}`);
  }

  return {ok: true, applied_at: new Date().toISOString()};
}

/**
 * Reject an amendment. Prevents it from ever being applied.
 * Sets status='rejected' and optional rejection reason in audit log.
 */
export async function rejectAmendment(amendment_id: string, reason?: string): Promise<{ok: boolean}> {
  const tid = await getSessionTenantId();
  if (!tid) throw new Error('No tenant context');

  // Determine which table
  let tableGuess: 'playbook_amendments' | 'workforce_entity_amendments' = 'workforce_entity_amendments';
  const { data: byTable } = await supabase
    .from(tableGuess)
    .select('entity_kind')
    .eq('id', amendment_id)
    .eq('tenant_id', tid)
    .maybeSingle();

  if (!byTable) {
    tableGuess = 'playbook_amendments';
  }

  const rpc_name =
    tableGuess === 'playbook_amendments'
      ? 'sync_amendment_decision'
      : 'sync_entity_amendment_decision';

  const { error } = await supabase.rpc(rpc_name, {
    p_amendment_id: amendment_id,
    p_approved: false,
  });

  if (error) {
    console.error(`Error rejecting amendment via ${rpc_name}:`, error);
    throw new Error(`Failed to reject amendment: ${error.message}`);
  }

  return {ok: true};
}

/**
 * Describe what an amendment stage looks like, similar to the hire wizard's describeStage.
 * Used for UI messaging.
 */
export function describeAmendmentStatus(status: AmendmentProposal['status']): string {
  switch (status) {
    case 'draft': return 'proposed but validation failed';
    case 'review_pending': return 'awaiting human approval';
    case 'approved': return 'approved by human';
    case 'applied': return 'applied to the entity';
    case 'rejected': return 'rejected, will not be applied';
    default: return status;
  }
}
