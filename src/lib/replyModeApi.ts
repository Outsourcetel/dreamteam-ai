/**
 * Reply Mode API
 *
 * Manages draft response approval flow.
 * DE generates draft → human reviews → approves/rejects → sends or escalates.
 */

import { supabase } from '../supabase'

export interface DraftResponse {
  draft_id: string
  de_id: string
  conversation_id: string
  user_question: string
  draft_content: string
  confidence?: number
  sources?: Array<{ title: string; url: string }>
  created_at: string
  expires_at: string
}

export interface DraftApproval {
  draft_id: string
  approved_by: string
  approved_at: string
  edited_content?: string
  notes?: string
}

export interface DraftRejection {
  draft_id: string
  rejected_by: string
  rejected_at: string
  reason: string
}

/**
 * Submit DE-generated draft for human review
 */
export async function submitDraft(
  de_id: string,
  conversation_id: string,
  user_question: string,
  draft_content: string,
  options?: {
    confidence?: number
    sources?: Array<{ title: string; url: string }>
    review_timeout_minutes?: number
  }
): Promise<DraftResponse> {
  try {
    const { data, error } = await supabase.rpc('submit_draft_for_review', {
      p_de_id: de_id,
      p_conversation_id: conversation_id,
      p_user_question: user_question,
      p_draft_content: draft_content,
      p_confidence: options?.confidence,
      p_sources: options?.sources,
      p_review_timeout_minutes: options?.review_timeout_minutes || 30,
    })

    if (error) throw error
    return data as DraftResponse
  } catch (e) {
    console.error('Failed to submit draft:', e)
    throw e
  }
}

/**
 * Get pending draft for review
 */
export async function getPendingDraft(draft_id: string): Promise<DraftResponse | null> {
  try {
    const { data, error } = await supabase.rpc('get_pending_draft', {
      p_draft_id: draft_id,
    })

    if (error) throw error
    return data as DraftResponse
  } catch (e) {
    console.error('Failed to get pending draft:', e)
    return null
  }
}

/**
 * Get all pending drafts for a DE
 */
export async function getPendingDraftsForDE(de_id: string): Promise<DraftResponse[]> {
  try {
    const { data, error } = await supabase.rpc('get_pending_drafts_for_de', {
      p_de_id: de_id,
    })

    if (error) throw error
    return (data || []) as DraftResponse[]
  } catch (e) {
    console.error('Failed to get pending drafts:', e)
    return []
  }
}

/**
 * Approve draft (optionally with edits)
 */
export async function approveDraft(
  draft_id: string,
  options?: {
    edited_content?: string
    notes?: string
  }
): Promise<{ ok: boolean }> {
  try {
    const { error } = await supabase.rpc('approve_draft', {
      p_draft_id: draft_id,
      p_edited_content: options?.edited_content,
      p_notes: options?.notes,
    })

    if (error) throw error
    return { ok: true }
  } catch (e) {
    console.error('Failed to approve draft:', e)
    throw e
  }
}

/**
 * Reject draft with reason (escalates instead)
 */
export async function rejectDraft(draft_id: string, reason: string): Promise<{ ok: boolean }> {
  try {
    const { error } = await supabase.rpc('reject_draft', {
      p_draft_id: draft_id,
      p_reason: reason,
    })

    if (error) throw error
    return { ok: true }
  } catch (e) {
    console.error('Failed to reject draft:', e)
    throw e
  }
}
