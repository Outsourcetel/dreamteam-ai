import { supabase } from '../supabase';
import { invokeEdge } from './invokeEdge';

/**
 * The optional AI commentary that sits beside a performance verdict — never
 * instead of it (founder decision, Stage C; migration 767; edge function
 * review-narrate).
 *
 * Nothing here can change a verdict, and that is structural rather than
 * careful: the only write path is the edge function, whose only write is
 * set_review_narrative(), which names three narrative columns and mentions no
 * verdict. Migration 767 asserts at apply time that exactly one routine in the
 * database writes ai_narrative.
 */

export interface ReviewNarrativeSettings {
  /** null de_id = the workspace default; non-null = an override for one employee. */
  de_id: string | null;
  enabled: boolean;
  instructions: string | null;
  updated_at: string;
}

/** Both rows that could apply to an employee: the workspace default and this
 *  employee's override, if either exists. The caller resolves specific-first —
 *  the server-side resolver is service_role only, because it is the edge
 *  function's business, not the browser's. */
export async function listReviewNarrativeSettings(deId: string): Promise<{
  workspace: ReviewNarrativeSettings | null;
  employee: ReviewNarrativeSettings | null;
  /** What actually applies to this employee — the override if present. */
  effective: ReviewNarrativeSettings | null;
}> {
  const { data, error } = await supabase
    .from('de_review_narrative_settings')
    .select('de_id, enabled, instructions, updated_at')
    .or(`de_id.eq.${deId},de_id.is.null`);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ReviewNarrativeSettings[];
  const workspace = rows.find(r => r.de_id === null) ?? null;
  const employee = rows.find(r => r.de_id === deId) ?? null;
  return { workspace, employee, effective: employee ?? workspace };
}

/** Owner/admin only — the RPC checks the role, and checks that any employee
 *  named actually belongs to this workspace. */
export async function setReviewNarrativeSettings(args: {
  enabled: boolean;
  instructions?: string | null;
  /** omit or null to set the WORKSPACE default */
  deId?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('set_review_narrative_settings', {
    p_enabled: args.enabled,
    p_instructions: args.instructions ?? null,
    p_de_id: args.deId ?? null,
  });
  if (error) throw new Error(error.message);
}

export interface NarrateResult {
  ok: boolean;
  cached: boolean;
  narrative: string;
  model: string;
  at?: string;
}

/**
 * Generate (or return the cached) commentary for one review.
 *
 * On demand, not on every review run: 127 employees times any cadence would
 * bill a model call per employee per period for prose nobody may open. The
 * result is stored on the row, so this is once per review unless forced.
 */
export async function narrateReview(reviewId: string, force = false): Promise<NarrateResult> {
  const { data, error } = await invokeEdge<NarrateResult>('review-narrate', {
    body: { review_id: reviewId, force },
  });
  // invokeEdge already turns the function's own refusal into the message —
  // 'narrative_disabled' and 'no_ai_engine' arrive as readable sentences.
  if (error) throw new Error(error.message);
  if (!data?.ok || !data.narrative) throw new Error('The commentary came back empty.');
  return data;
}
