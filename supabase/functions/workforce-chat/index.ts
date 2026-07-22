/**
 * workforce-chat — conversational Workforce Assistant (hire / improve /
 * monitor / retire) for signed-in tenant users.
 *
 * Rewritten per the 2026-07-20 external review: the original trusted
 * body-supplied tenant_id/user_id with an anon client (both insecure and
 * RLS-broken). Now:
 *   - identity comes from the caller's JWT (body user_id is ignored)
 *   - tenant is resolved via profile membership + audited remote access
 *   - conversations are loaded/written tenant- and user-scoped
 *   - AI budget is checked BEFORE the model call; token usage is awaited
 *   - product-knowledge context is injection-wrapped (untrusted content)
 *   - model comes from the shared per-DE registry, not a hardcoded id
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hasLLMProvider, llmMessages } from "../_shared/llm.ts";
import { resolveTenantWithRemoteAccess } from "../_shared/resolveTenant.ts";
import { wrapUntrusted, FIREWALL_RULES } from "../_shared/injectionSafety.ts";
import { resolveDeModel } from "../_shared/deModel.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MAX_MESSAGE_CHARS = 8_000;
const MAX_HISTORY_MESSAGES = 40;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, conversation_id } = body;
    const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE_CHARS) : "";
    if (!tenant_id || !message) return json({ error: "tenant_id and message required" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ── Auth: identity comes from the JWT, never the body ──
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const userId = userData.user.id;

    const { data: prof } = await admin
      .from("profiles").select("tenant_id, layer").eq("user_id", userId).maybeSingle();
    const resolvedTenant = await resolveTenantWithRemoteAccess(admin, userId, prof?.tenant_id, prof?.layer, tenant_id);
    if (resolvedTenant !== tenant_id) return json({ error: "forbidden" }, 403);

    // ── AI budget gate before any model spend ──
    const { data: budget } = await admin.rpc("check_tenant_ai_budget", { p_tenant_id: tenant_id });
    if (budget && budget.allowed === false) return json({ error: "ai_budget_exceeded" }, 429);

    // ── Workforce Assistant DE for this tenant ──
    const { data: assistant } = await admin
      .from("digital_employees")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("is_workforce_assistant", true)
      .maybeSingle();
    if (!assistant) return json({ error: "workforce_assistant_not_provisioned" }, 404);

    // ── Conversation: create, or load one owned by this tenant + user ──
    let convId: string | null = conversation_id ?? null;
    let conversationMessages: Array<{ role: string; content: string; timestamp?: string }> = [];
    let conversationTopic = "hire";

    if (convId) {
      const { data: existingConv } = await admin
        .from("workforce_conversations")
        .select("messages, topic")
        .eq("conversation_id", convId)
        .eq("tenant_id", tenant_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!existingConv) return json({ error: "conversation_not_found" }, 404);
      conversationMessages = existingConv.messages || [];
      conversationTopic = existingConv.topic;
    } else {
      const msgLower = message.toLowerCase();
      if (msgLower.includes("improve") || msgLower.includes("amend")) conversationTopic = "improve";
      else if (msgLower.includes("monitor") || msgLower.includes("performance")) conversationTopic = "monitor";
      else if (msgLower.includes("retire") || msgLower.includes("remove")) conversationTopic = "retire";

      const { data: newConv, error: convError } = await admin
        .from("workforce_conversations")
        .insert({ tenant_id, user_id: userId, de_id: assistant.id, topic: conversationTopic, messages: [] })
        .select("conversation_id")
        .single();
      if (convError || !newConv) throw new Error(`Failed to create conversation: ${convError?.message}`);
      convId = newConv.conversation_id;
    }

    conversationMessages.push({ role: "user", content: message, timestamp: new Date().toISOString() });

    // ── Product knowledge (untrusted content → injection-wrapped) ──
    const { data: knowledge } = await admin
      .from("de_product_knowledge")
      .select("content, topic, subtopic")
      .limit(10);
    const knowledgeContext = (knowledge ?? [])
      .map((k) => wrapUntrusted(`[${k.topic}/${k.subtopic}]: ${k.content}`, "product-knowledge"))
      .join("\n\n");

    const systemPrompt = `You are the Workforce Assistant, a trusted advisor helping this organization manage and improve their digital workforce.

Your responsibilities:
1. Help hire new DEs by asking clarifying questions about role, responsibilities, and success metrics
2. Suggest improvements to underperforming DEs based on CSAT, escalation rates, and cost trends
3. Monitor team performance and provide insights
4. Help retire DEs and transition knowledge
5. Train new tenants on DreamTeamAI features and best practices
6. Recommend playbook patterns and guardrail configurations

IMPORTANT RULES:
- Never auto-approve DE changes without explicit user consent. Always ask for confirmation.
- Always show evidence (CSAT scores, escalation rates, cost impact) for recommendations.
- Prioritize user success over automation.
- When uncertain, escalate to the tenant admin.
- All recommendations must be grounded in the DreamTeamAI platform features and patterns.

You have access to the following DreamTeamAI platform knowledge:
${knowledgeContext}

Current conversation topic: ${conversationTopic}

Remember: You're helping humans build and manage their digital workforce, not replacing them. Every decision goes through human review.

${FIREWALL_RULES}`;

    // ── Model call (shared registry model, timeout, awaited metering) ──
    if (!(await hasLLMProvider(admin))) return json({ error: "ai_not_configured" }, 503);
    const model = await resolveDeModel(admin, tenant_id, assistant.id);

    const history = conversationMessages.slice(-MAX_HISTORY_MESSAGES).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

    // (The old direct call carried a 60s AbortSignal; the shared client owns
    // transport now — provider errors advance the chain instead of hanging.)
    const res = await llmMessages(admin, { model, max_tokens: 2000, system: systemPrompt, messages: history }, "workforce-chat");
    if (!res.ok) {
      console.error("workforce-chat llm_error status", res.status);
      return json({ error: "llm_error" }, 502);
    }
    const data = await res.json();
    const assistantMessage: string =
      (data.content ?? []).find((b: { type?: string }) => b.type === "text")?.text ?? "";

    // Await metering so spend is never undercounted by isolate teardown.
    const { error: meterErr } = await admin.rpc("record_de_token_usage", {
      p_tenant_id: tenant_id,
      p_de_id: assistant.id,
      p_model_id: model,
      p_input_tokens: data.usage?.input_tokens ?? 0,
      p_output_tokens: data.usage?.output_tokens ?? 0,
    });
    if (meterErr) console.error("record_de_token_usage:", meterErr.message);

    conversationMessages.push({ role: "assistant", content: assistantMessage, timestamp: new Date().toISOString() });

    const { error: updateError } = await admin
      .from("workforce_conversations")
      .update({ messages: conversationMessages, updated_at: new Date().toISOString() })
      .eq("conversation_id", convId)
      .eq("tenant_id", tenant_id);
    if (updateError) throw new Error(`Failed to save conversation: ${updateError.message}`);

    return json({ conversation_id: convId, message: assistantMessage, topic: conversationTopic });
  } catch (error) {
    console.error("workforce-chat error:", error instanceof Error ? error.message : "error");
    return json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
  }
});
