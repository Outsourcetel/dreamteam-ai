/**
 * deModel — resolves which Claude model a Digital Employee answers with
 * (Wave 1.2, migration 132). The per-DE `model_id` column has existed
 * since migration 001 and was consumed ONLY by agentic-step-execute;
 * the three customer-answer paths (de-answer, widget-ask,
 * specialist-consult) were pinned to a code constant. This helper is
 * the one place the fallback default lives.
 *
 * The allow-list is the platform-managed ai_model_pricing table (the
 * profile UI only offers models priced there, so cost tracking stays
 * real). Read-side we only sanity-check the shape and fail open to the
 * default — a stale or mistyped model_id must degrade to the platform
 * default, never break a live answer path.
 */
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const DEFAULT_MODEL = 'claude-sonnet-5';

export async function resolveDeModel(
  admin: SupabaseClient, tenantId: string, deId: string | null,
): Promise<string> {
  if (!deId) return DEFAULT_MODEL;
  try {
    const { data } = await admin
      .from('digital_employees')
      .select('model_id')
      .eq('id', deId).eq('tenant_id', tenantId).maybeSingle();
    const m = data?.model_id ? String(data.model_id) : '';
    return m.startsWith('claude-') ? m : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}
