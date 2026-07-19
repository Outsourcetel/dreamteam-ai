import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

interface TrainingFeedback {
  de_id: string;
  conversation_id?: string;
  human_decision: string;
  de_suggestion?: string;
  feedback_type: "approval" | "correction" | "suggestion";
  correction_detail?: {
    from: string;
    to: string;
    reasoning?: string;
  };
  replay_test?: boolean;
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const payload: TrainingFeedback = await req.json();
    const {
      de_id,
      conversation_id,
      human_decision,
      de_suggestion,
      feedback_type,
      correction_detail,
      replay_test,
    } = payload;

    if (!de_id || !human_decision || !feedback_type) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get current user from auth context (passed via JWT header)
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing authentication" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // Verify DE exists and get tenant info
    const { data: de, error: deError } = await supabase
      .from("digital_employees")
      .select("id, tenant_id, name, status")
      .eq("id", de_id)
      .single();

    if (deError || !de) {
      throw new Error(`DE not found: ${de_id}`);
    }

    // Record training feedback
    const { data: feedback, error: feedbackError } = await supabase
      .from("de_training_feedback")
      .insert({
        de_id,
        conversation_id,
        human_decision,
        de_suggestion,
        feedback_type,
        correction_detail,
        approved_by: "system", // In real implementation, extract from JWT
        replay_tested: replay_test || false,
      })
      .select("feedback_id")
      .single();

    if (feedbackError) {
      throw new Error(`Failed to save training feedback: ${feedbackError.message}`);
    }

    // If this is a correction and replayed successfully, consider applying to charter
    let applied_to_charter = false;
    if (feedback_type === "correction" && correction_detail && replay_test) {
      // Get DE's current charter
      const { data: deData, error: charterError } = await supabase
        .from("digital_employees")
        .select("charter")
        .eq("id", de_id)
        .single();

      if (!charterError && deData?.charter) {
        // Apply correction to charter (simplified version)
        // In production, this would run through the amendment system
        const updatedCharter = {
          ...deData.charter,
          training_feedback: deData.charter.training_feedback || [],
          last_training_update: new Date().toISOString(),
        };

        const { error: updateError } = await supabase
          .from("digital_employees")
          .update({ charter: updatedCharter })
          .eq("id", de_id);

        if (!updateError) {
          applied_to_charter = true;

          // Update training feedback record
          await supabase
            .from("de_training_feedback")
            .update({ applied_to_charter: true })
            .eq("feedback_id", feedback.feedback_id);
        }
      }
    }

    // Check if DE should be promoted to next stage
    const shouldPromote = await checkStagePromotionEligibility(de_id);

    return new Response(
      JSON.stringify({
        feedback_id: feedback.feedback_id,
        de_id,
        de_name: de.name,
        feedback_type,
        applied_to_charter,
        should_promote_stage: shouldPromote,
        message: `Training feedback recorded. ${applied_to_charter ? "Charter updated." : ""} ${shouldPromote ? "DE may be ready for next stage." : ""}`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in de-training-capture:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Internal server error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});

async function checkStagePromotionEligibility(deId: string): Promise<boolean> {
  // Get current stage
  const { data: stageData, error: stageError } = await supabase
    .from("de_deployment_stages")
    .select("stage, stage_metrics")
    .eq("de_id", deId)
    .single();

  if (stageError || !stageData) {
    return false;
  }

  const currentStage = stageData.stage;
  const metrics = stageData.stage_metrics || {};

  // Define promotion criteria per stage
  const promotionCriteria: Record<string, Record<string, number>> = {
    shadow: { csat: 85, escalation_rate: 10, sample_size: 20 },
    "co-pilot": { csat: 90, escalation_rate: 5, sample_size: 50 },
    live: { csat: 92, escalation_rate: 3, sample_size: 100 },
  };

  if (!(currentStage in promotionCriteria)) {
    return false; // retired stage doesn't promote
  }

  const criteria = promotionCriteria[currentStage];

  // Check if metrics meet promotion criteria
  const meetsCSAT = (metrics.csat || 0) >= criteria.csat;
  const meetsEscalation = (metrics.escalation_rate || 100) <= criteria.escalation_rate;
  const hasSampleSize = (metrics.sample_size || 0) >= criteria.sample_size;

  return meetsCSAT && meetsEscalation && hasSampleSize;
}
