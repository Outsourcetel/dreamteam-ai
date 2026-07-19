import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.20.0";

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
});

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

interface WorkforceChatRequest {
  tenant_id: string;
  user_id: string;
  conversation_id?: string;
  message: string;
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const payload: WorkforceChatRequest = await req.json();
    const { tenant_id, user_id, conversation_id, message } = payload;

    if (!tenant_id || !user_id || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get or create conversation
    let convId = conversation_id;
    let conversationMessages: any[] = [];
    let conversationTopic = "hire"; // default

    if (!convId) {
      // Determine topic from first message (simple heuristic)
      const msgLower = message.toLowerCase();
      if (msgLower.includes("improve") || msgLower.includes("amend")) {
        conversationTopic = "improve";
      } else if (msgLower.includes("monitor") || msgLower.includes("performance")) {
        conversationTopic = "monitor";
      } else if (msgLower.includes("retire") || msgLower.includes("remove")) {
        conversationTopic = "retire";
      }

      // Create new conversation
      const { data: newConv, error: convError } = await supabase
        .from("workforce_conversations")
        .insert({
          tenant_id,
          user_id,
          de_id: await getWorkforceAssistantId(tenant_id),
          topic: conversationTopic,
          messages: [],
        })
        .select("conversation_id, messages")
        .single();

      if (convError || !newConv) {
        throw new Error(`Failed to create conversation: ${convError?.message}`);
      }

      convId = newConv.conversation_id;
      conversationMessages = newConv.messages || [];
    } else {
      // Load existing conversation
      const { data: existingConv, error: loadError } = await supabase
        .from("workforce_conversations")
        .select("messages, topic")
        .eq("conversation_id", convId)
        .single();

      if (loadError || !existingConv) {
        throw new Error(`Failed to load conversation: ${loadError?.message}`);
      }

      conversationMessages = existingConv.messages || [];
      conversationTopic = existingConv.topic;
    }

    // Add user message to conversation history
    conversationMessages.push({
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    });

    // Get product knowledge base for system context
    const { data: knowledge, error: knowledgeError } = await supabase
      .from("de_product_knowledge")
      .select("content, topic, subtopic")
      .limit(10);

    if (knowledgeError) {
      console.warn("Failed to load product knowledge:", knowledgeError);
    }

    const knowledgeContext = knowledge
      ? knowledge.map((k) => `[${k.topic}/${k.subtopic}]: ${k.content}`).join("\n\n")
      : "";

    // Build system prompt for Workforce Assistant
    const systemPrompt = `You are the Workforce Assistant for ${tenant_id}, a trusted advisor helping manage and improve their digital workforce.

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

When suggesting a DE hire:
- Ask about the role, responsibilities, and success metrics
- Recommend a starting playbook from available templates
- Suggest appropriate guardrails based on the role and industry
- Recommend an initial trust dial level (shadow/co-pilot/live)

When suggesting improvements:
- Provide specific metrics (CSAT, escalation, cost)
- Recommend amendment changes with rationale
- Offer to run replay tests to validate the change
- Get explicit approval before applying

Remember: You're helping humans build and manage their digital workforce, not replacing them. Every decision goes through human review.`;

    // Call Claude Opus to generate response
    const messages = conversationMessages.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    }));

    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2000,
      system: systemPrompt,
      messages,
    });

    const assistantMessage =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Add assistant response to conversation history
    conversationMessages.push({
      role: "assistant",
      content: assistantMessage,
      timestamp: new Date().toISOString(),
    });

    // Update conversation with new messages
    const { error: updateError } = await supabase
      .from("workforce_conversations")
      .update({
        messages: conversationMessages,
        updated_at: new Date().toISOString(),
      })
      .eq("conversation_id", convId);

    if (updateError) {
      throw new Error(`Failed to save conversation: ${updateError.message}`);
    }

    return new Response(
      JSON.stringify({
        conversation_id: convId,
        message: assistantMessage,
        topic: conversationTopic,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in workforce-chat:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Internal server error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});

async function getWorkforceAssistantId(tenantId: string): Promise<string> {
  const { data, error } = await supabase
    .from("digital_employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("is_workforce_assistant", true)
    .single();

  if (error || !data) {
    throw new Error(`Workforce Assistant not found for tenant: ${tenantId}`);
  }

  return data.id;
}
