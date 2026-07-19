/**
 * Amendment Orchestration API
 *
 * Unified interface for amending Digital Employees, Playbooks, and Specialists.
 * Routes to existing backend machinery: entity-amend, playbook-amend, de-improve.
 */

import { supabase } from '../supabase'

// ── Types ─────────────────────────────────────────────────────────

export type EntityKind = 'de' | 'playbook' | 'specialist'
export type AmendmentTrigger = 'performance' | 'failure' | 'user_feedback' | 'manual'

export interface AmendmentRequest {
  entity_kind: EntityKind
  entity_id: string
  problem?: string // user's plain-language description
  trigger?: AmendmentTrigger
  context?: Record<string, unknown> // optional entity-specific evidence
}

export interface AmendmentProposal {
  amendment_id: string
  entity_kind: EntityKind
  entity_id: string
  current_state: Record<string, unknown> // snapshot at proposal time
  proposed_state: Record<string, unknown> // what changes
  rationale: string // plain-language reasoning
  redline: Array<{
    field: string
    old: string
    new: string
    note?: string
  }>
  evidence?: {
    replay_status?: 'not_tested' | 'passed' | 'failed'
    replay_score_before?: number
    replay_score_after?: number
    golden_set_impact?: string
  }
  human_task_id: string | null
  status: 'proposed' | 'approved' | 'rejected' | 'applied'
  created_at: string
  created_by: string
}

export interface PendingAmendment {
  amendment_id: string
  entity_kind: EntityKind
  entity_id: string
  entity_name: string
  problem: string
  status: 'proposed' | 'approved'
  created_at: string
  created_by: string
}

// ── Request Amendment ─────────────────────────────────────────────

export async function requestAmendment(req: AmendmentRequest): Promise<AmendmentProposal | null> {
  try {
    const { data, error } = await supabase.rpc('request_amendment', {
      p_entity_kind: req.entity_kind,
      p_entity_id: req.entity_id,
      p_problem: req.problem || null,
      p_trigger: req.trigger || 'manual',
      p_context: req.context || null,
    })

    if (error) throw error
    return data as AmendmentProposal
  } catch (e) {
    console.error('Failed to request amendment:', e)
    return null
  }
}

// ── List Pending Amendments ────────────────────────────────────────

export async function listPendingAmendments(
  entity_kind: EntityKind,
  entity_id?: string,
  status?: 'proposed' | 'approved'
): Promise<PendingAmendment[]> {
  try {
    const { data, error } = await supabase.rpc('list_pending_amendments', {
      p_entity_kind: entity_kind,
      p_entity_id: entity_id || null,
      p_status: status || null,
    })

    if (error) throw error
    return data as PendingAmendment[]
  } catch (e) {
    console.error('Failed to list pending amendments:', e)
    return []
  }
}

// ── Get Amendment Detail ───────────────────────────────────────────

export async function getAmendmentDetail(amendment_id: string): Promise<AmendmentProposal | null> {
  try {
    const { data, error } = await supabase.rpc('get_amendment_detail', {
      p_amendment_id: amendment_id,
    })

    if (error) throw error
    return data as AmendmentProposal
  } catch (e) {
    console.error('Failed to get amendment detail:', e)
    return null
  }
}

// ── Approve Amendment ─────────────────────────────────────────────

export async function approveAmendment(amendment_id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase.rpc('approve_amendment', {
      p_amendment_id: amendment_id,
    })

    if (error) throw error
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('Failed to approve amendment:', e)
    return { ok: false, error: msg }
  }
}

// ── Reject Amendment ──────────────────────────────────────────────

export async function rejectAmendment(amendment_id: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase.rpc('reject_amendment', {
      p_amendment_id: amendment_id,
      p_reason: reason || null,
    })

    if (error) throw error
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('Failed to reject amendment:', e)
    return { ok: false, error: msg }
  }
}

// ── Get Amendment History ─────────────────────────────────────────

export async function getAmendmentHistory(
  entity_kind: EntityKind,
  entity_id: string
): Promise<AmendmentProposal[]> {
  try {
    const { data, error } = await supabase.rpc('get_amendment_history', {
      p_entity_kind: entity_kind,
      p_entity_id: entity_id,
    })

    if (error) throw error
    return data as AmendmentProposal[]
  } catch (e) {
    console.error('Failed to get amendment history:', e)
    return []
  }
}
