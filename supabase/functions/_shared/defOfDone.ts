/**
 * defOfDone — §3 definition-of-done gate + assess-and-log (shared by the terminal writers).
 *
 * A run/objective may be marked "done" ONLY when its required side-effecting actions
 * actually executed — not on the model's say-so. Each terminal writer calls
 * assessAndLog before it writes a terminal 'achieved'/'completed'/'done'; in SHADOW
 * it logs the verdict and never changes behavior, in ENFORCE it withholds a false done.
 * Enforce NEVER grants a done — it only withholds one. Two-tier flag, default OFF.
 */
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
// deno-lint-ignore no-explicit-any
type Admin = SupabaseClient | any;

export async function defOfDoneGate(admin: Admin, tenantId: string): Promise<{ enabled: boolean; mode?: 'shadow' | 'enforce' }> {
  try {
    const { data: master } = await admin.from('platform_config').select('value').eq('key', 'definition_of_done.enabled').maybeSingle();
    if (String(master?.value ?? '') !== 'true') return { enabled: false };
    const { data: on } = await admin.rpc('is_feature_enabled_internal', { p_tenant_id: tenantId, p_feature_key: 'definition_of_done' });
    if (on !== true) return { enabled: false };
    const { data: modeRow } = await admin.from('platform_config').select('value').eq('key', 'definition_of_done.mode').maybeSingle();
    return { enabled: true, mode: String(modeRow?.value ?? '') === 'enforce' ? 'enforce' : 'shadow' };
  } catch {
    return { enabled: false };   // flag axis fails to current behavior
  }
}

/**
 * Assess a terminal, log the verdict (shadow AND enforce), return whether to WITHHOLD.
 * withhold is true ONLY in enforce mode when the terminal is NOT verified — and it
 * fails CLOSED: a null/errored assess in enforce mode withholds (verified !== true).
 */
export async function assessAndLog(
  admin: Admin, tenantId: string, writer: string, scope: string, scopeId: string,
  objectiveId: string | null, gate: { enabled: boolean; mode?: 'shadow' | 'enforce' },
): Promise<{ withhold: boolean; verdict: Record<string, unknown> }> {
  if (!gate.enabled) return { withhold: false, verdict: {} };
  const enforce = gate.mode === 'enforce';
  try {
    const { data: verdict } = await admin.rpc('assess_definition_of_done', {
      p_tenant_id: tenantId, p_scope: scope, p_scope_id: scopeId, p_objective_id: objectiveId,
    });
    const verified = (verdict as { verified?: boolean } | null)?.verified === true;
    await admin.from('definition_of_done_log').insert({
      tenant_id: tenantId, writer, scope, scope_id: scopeId, objective_id: objectiveId,
      verdict: verdict ?? { error: 'assess_null' }, would_withhold: !verified, enforced: enforce,
    }).then(() => {}).catch(() => {});
    return { withhold: enforce && !verified, verdict: (verdict ?? {}) as Record<string, unknown> };
  } catch (e) {
    // assess threw → fail CLOSED in enforce (withhold), never in shadow.
    try {
      await admin.from('definition_of_done_log').insert({
        tenant_id: tenantId, writer, scope, scope_id: scopeId, objective_id: objectiveId,
        verdict: { error: String((e as Error)?.message ?? e).slice(0, 200) }, would_withhold: true, enforced: enforce,
      }).then(() => {}).catch(() => {});
    } catch { /* best-effort */ }
    return { withhold: enforce, verdict: { error: 'assess_threw' } };
  }
}
