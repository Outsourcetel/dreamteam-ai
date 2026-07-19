/**
 * de-training-capture — records human training feedback for a DE.
 *
 * Rewritten per the 2026-07-20 external review: the original only checked
 * that an Authorization header EXISTED (never validated it), used the anon
 * client, recorded approved_by: "system", and mutated the DE charter
 * directly — bypassing the amendment/governance system.
 *
 * Now: the JWT is validated, the DE must belong to the caller's tenant,
 * approved_by is the real user id, and charter changes are NOT applied
 * here — corrections flow through the amendment system (entity-amend),
 * which is the only governed write path for DE behavior.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveTenantWithRemoteAccess } from "../_shared/resolveTenant.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const payload = await req.json().catch(() => ({}));
    const { de_id, conversation_id, human_decision, de_suggestion, feedback_type, correction_detail, replay_test } = payload;

    if (!de_id || !human_decision || !feedback_type) {
      return json({ error: "de_id, human_decision and feedback_type required" }, 400);
    }
    if (!["approval", "correction", "suggestion"].includes(feedback_type)) {
      return json({ error: "invalid feedback_type" }, 400);
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ── Auth: validate the JWT, resolve the caller's tenant ──
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const userId = userData.user.id;

    // The DE decides which tenant this is about; the caller must belong to it.
    const { data: de } = await admin
      .from("digital_employees")
      .select("id, tenant_id, name, status")
      .eq("id", de_id)
      .maybeSingle();
    if (!de) return json({ error: "de_not_found" }, 404);

    const { data: prof } = await admin
      .from("profiles").select("tenant_id, layer").eq("user_id", userId).maybeSingle();
    const resolvedTenant = await resolveTenantWithRemoteAccess(admin, userId, prof?.tenant_id, prof?.layer, de.tenant_id);
    if (resolvedTenant !== de.tenant_id) return json({ error: "forbidden" }, 403);

    // ── Record feedback (attributed to the real user) ──
    const { data: feedback, error: feedbackError } = await admin
      .from("de_training_feedback")
      .insert({
        de_id,
        conversation_id,
        human_decision,
        de_suggestion,
        feedback_type,
        correction_detail,
        approved_by: userId,
        replay_tested: replay_test || false,
      })
      .select("feedback_id")
      .single();
    if (feedbackError) throw new Error(`Failed to save training feedback: ${feedbackError.message}`);

    // Charter changes are deliberately NOT applied here. Corrections that
    // should change DE behavior go through the amendment system
    // (entity-amend → human review → apply), never a direct write.
    const shouldPromote = await checkStagePromotionEligibility(admin, de_id);

    return json({
      feedback_id: feedback.feedback_id,
      de_id,
      de_name: de.name,
      feedback_type,
      applied_to_charter: false,
      should_promote_stage: shouldPromote,
      message: `Training feedback recorded.${shouldPromote ? " DE may be ready for next stage." : ""}`,
    });
  } catch (error) {
    console.error("de-training-capture error:", error instanceof Error ? error.message : "error");
    return json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
  }
});

async function checkStagePromotionEligibility(admin: ReturnType<typeof createClient>, deId: string): Promise<boolean> {
  const { data: stageData } = await admin
    .from("de_deployment_stages")
    .select("stage, stage_metrics")
    .eq("de_id", deId)
    .maybeSingle();
  if (!stageData) return false;

  const currentStage = stageData.stage;
  const metrics = stageData.stage_metrics || {};

  const promotionCriteria: Record<string, Record<string, number>> = {
    shadow: { csat: 85, escalation_rate: 10, sample_size: 20 },
    "co-pilot": { csat: 90, escalation_rate: 5, sample_size: 50 },
    live: { csat: 92, escalation_rate: 3, sample_size: 100 },
  };
  if (!(currentStage in promotionCriteria)) return false;

  const criteria = promotionCriteria[currentStage];
  return (
    (metrics.csat || 0) >= criteria.csat &&
    (metrics.escalation_rate || 100) <= criteria.escalation_rate &&
    (metrics.sample_size || 0) >= criteria.sample_size
  );
}
