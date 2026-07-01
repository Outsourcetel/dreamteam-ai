/**
 * de-execute Edge Function — Digital Employee Execution Engine
 *
 * POST /functions/v1/de-execute
 * Body: { tenant_id, de_id?, message, conversation_id? }
 *
 * Secrets / platform_config keys:
 *   ANTHROPIC_API_KEY  — required (powers Anthropic models)
 *   OPENAI_API_KEY     — required for OpenAI models + semantic search embeddings
 *   GOOGLE_AI_KEY      — required for Google Gemini models
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Embedding (OpenAI only — best-in-class, always use for KB search) ─────────
async function embedText(text: string, apiKey: string): Promise<number[] | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text.slice(0, 8000), model: 'text-embedding-3-small' }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.embedding ?? null;
  } catch { return null; }
}

// ── Provider call functions ────────────────────────────────────────────────────

async function callAnthropic(
  systemPrompt: string, userMessage: string, modelId: string, apiKey: string
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    text: data.content?.[0]?.text ?? '',
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

async function callOpenAI(
  systemPrompt: string, userMessage: string, modelId: string, apiKey: string
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 600,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

async function callGoogle(
  systemPrompt: string, userMessage: string, modelId: string, apiKey: string
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 600 },
    }),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { tenant_id, de_id, message, conversation_id } = await req.json();
    if (!tenant_id || !message) throw new Error('tenant_id and message are required');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ── Load API keys: env secrets first, fall back to platform_config ────────
    let anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? null;
    let openaiKey    = Deno.env.get('OPENAI_API_KEY')    ?? null;
    let googleKey    = Deno.env.get('GOOGLE_AI_KEY')     ?? null;

    if (!anthropicKey || !openaiKey || !googleKey) {
      const { data: configs } = await supabase
        .from('platform_config')
        .select('key, value')
        .in('key', ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_KEY']);
      if (configs) {
        for (const row of configs) {
          if (row.key === 'ANTHROPIC_API_KEY' && !anthropicKey) anthropicKey = row.value;
          if (row.key === 'OPENAI_API_KEY'    && !openaiKey)    openaiKey    = row.value;
          if (row.key === 'GOOGLE_AI_KEY'     && !googleKey)    googleKey    = row.value;
        }
      }
    }

    // ── Check tenant token budget ─────────────────────────────────────────────
    const { data: tenantRow } = await supabase
      .from('tenants')
      .select('monthly_token_budget')
      .eq('id', tenant_id)
      .single();

    const budget: number = tenantRow?.monthly_token_budget ?? 100000;
    const yearMonth = new Date().toISOString().slice(0, 7);

    const { data: usageRow } = await supabase
      .from('tenant_ai_usage')
      .select('tokens_used')
      .eq('tenant_id', tenant_id)
      .eq('year_month', yearMonth)
      .single();

    const currentUsage = usageRow?.tokens_used ?? 0;

    if (budget > 0 && currentUsage >= budget) {
      return new Response(JSON.stringify({
        response: 'This workspace has reached its monthly AI token limit. Please contact your administrator.',
        confidence: 0, threshold: 75, status: 'escalated',
        sources: [], chunks_found: 0, search_mode: 'fulltext',
        de_name: 'Digital Employee', budget_exceeded: true,
        tokens_used: currentUsage, budget,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // ── Load DE configuration ─────────────────────────────────────────────────
    let de: Record<string, unknown> = {
      name: 'Digital Employee',
      description: 'A helpful AI assistant',
      confidence_threshold: 75,
      trust_level: 'supervised',
      capabilities: [], responsibilities: [], department: '',
      model_provider: 'anthropic',
      model_id: 'claude-haiku-4-5-20251001',
    };

    if (de_id) {
      const { data } = await supabase.from('digital_employees').select('*').eq('id', de_id).single();
      if (data) de = data as Record<string, unknown>;
    }

    const threshold     = (de.confidence_threshold as number) ?? 75;
    const modelProvider = (de.model_provider as string) ?? 'anthropic';
    const modelId       = (de.model_id as string) ?? 'claude-haiku-4-5-20251001';

    // Validate we have the right key for this provider
    const providerKey = modelProvider === 'openai' ? openaiKey
                      : modelProvider === 'google'  ? googleKey
                      : anthropicKey;

    if (!providerKey) {
      throw new Error(
        `${modelProvider.charAt(0).toUpperCase() + modelProvider.slice(1)} API key not configured — add it in Settings → AI Engine`
      );
    }

    // ── Retrieve relevant knowledge ───────────────────────────────────────────
    let context = '';
    let sources: { title: string; similarity: number }[] = [];
    let chunksFound = 0;
    let searchMode = 'fulltext';

    // Semantic search always uses OpenAI embeddings (best quality) regardless of DE model
    if (openaiKey) {
      const queryEmbedding = await embedText(message, openaiKey);
      if (queryEmbedding) {
        const { data: chunks } = await supabase.rpc('match_knowledge_chunks', {
          query_embedding: queryEmbedding,
          match_tenant_id: tenant_id,
          match_threshold: 0.4,
          match_count: 6,
        });
        if (chunks && chunks.length > 0) {
          searchMode = 'semantic';
          chunksFound = chunks.length;
          sources = chunks.map((c: { title: string; similarity: number }) => ({
            title: c.title, similarity: Math.round(c.similarity * 100),
          }));
          context = chunks
            .map((c: { title: string; content: string }) => `[${c.title}]\n${c.content}`)
            .join('\n\n---\n\n');
        }
      }
    }

    if (!context) {
      const { data: articles } = await supabase.rpc('search_knowledge', {
        p_tenant_id: tenant_id, p_query: message, p_limit: 5,
      });
      if (articles && articles.length > 0) {
        chunksFound = articles.length;
        sources = articles.map((a: { title: string; similarity: number }) => ({
          title: a.title, similarity: Math.round((a.similarity ?? 0.5) * 100),
        }));
        context = articles
          .map((a: { title: string; body: string }) => `[${a.title}]\n${a.body?.slice(0, 800)}`)
          .join('\n\n---\n\n');
      }
    }

    if (!context) context = 'No relevant knowledge found in the knowledge base for this query.';

    // ── Build system prompt ───────────────────────────────────────────────────
    const caps  = (de.capabilities as string[])?.join(', ') || 'general assistance';
    const resps = (de.responsibilities as string[])?.join('; ') || '';

    const systemPrompt = `You are ${de.name}, a Digital Employee at this organisation.
${de.description ? `Role: ${de.description}` : ''}
${de.department  ? `Department: ${de.department}` : ''}
${caps  ? `Capabilities: ${caps}` : ''}
${resps ? `Responsibilities: ${resps}` : ''}

Answer questions using ONLY the knowledge base provided below. Never invent information.
If the answer is not in the knowledge base, say so and offer to escalate to a human.
Be concise and professional. After your answer, on a new line output this JSON:
{"confidence": <0–100>}
where confidence reflects how well the KB covered the question (90-100 = fully answered, below 50 = not in KB).

KNOWLEDGE BASE:
${context}`;

    // ── Call the DE's configured model ────────────────────────────────────────
    let rawText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    if (modelProvider === 'openai') {
      const result = await callOpenAI(systemPrompt, message, modelId, providerKey);
      rawText = result.text; inputTokens = result.inputTokens; outputTokens = result.outputTokens;
    } else if (modelProvider === 'google') {
      const result = await callGoogle(systemPrompt, message, modelId, providerKey);
      rawText = result.text; inputTokens = result.inputTokens; outputTokens = result.outputTokens;
    } else {
      const result = await callAnthropic(systemPrompt, message, modelId, providerKey);
      rawText = result.text; inputTokens = result.inputTokens; outputTokens = result.outputTokens;
    }

    // ── Parse confidence from output ──────────────────────────────────────────
    let confidence = chunksFound > 0 ? 70 : 30;
    let responseText = rawText;

    const jsonMatch = rawText.match(/\{"confidence":\s*(\d+(?:\.\d+)?)\}/);
    if (jsonMatch) {
      confidence = parseFloat(jsonMatch[1]);
      responseText = rawText.replace(jsonMatch[0], '').trim();
    }

    confidence = Math.min(100, Math.max(0, Math.round(confidence)));
    const needsApproval = confidence < threshold;

    // ── Log token usage ───────────────────────────────────────────────────────
    const tokensUsed = inputTokens + outputTokens;
    if (tokensUsed > 0) {
      await supabase.rpc('increment_tenant_token_usage', {
        p_tenant_id: tenant_id, p_year_month: yearMonth, p_tokens: tokensUsed,
      }).catch(() => {});
    }

    // ── Create agent_action if below confidence threshold ─────────────────────
    if (needsApproval) {
      await supabase.from('agent_actions').insert({
        tenant_id, de_id: de_id ?? null,
        agent_name: de.name,
        action_type: 'response_review',
        description: `Low-confidence response (${confidence}%) to: "${(message as string).slice(0, 120)}"`,
        status: 'pending',
        confidence_score: confidence / 100,
        requires_approval: true,
        payload: { message, proposed_response: responseText, sources_found: chunksFound, search_mode: searchMode },
      });
    }

    // ── Log to conversation ───────────────────────────────────────────────────
    if (conversation_id) {
      await supabase.from('conversation_messages').insert({
        conversation_id, tenant_id, role: 'assistant',
        content: responseText, confidence_score: confidence / 100,
        requires_approval: needsApproval, kb_articles_used: chunksFound,
      }).throwOnError().catch(() => {});
    }

    return new Response(JSON.stringify({
      response: responseText,
      confidence, threshold,
      status: needsApproval ? 'escalated' : 'answered',
      sources, chunks_found: chunksFound, search_mode: searchMode,
      de_name: de.name,
      model_provider: modelProvider, model_id: modelId,
      tokens_used: tokensUsed,
      budget_remaining: budget > 0 ? budget - currentUsage - tokensUsed : null,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('de-execute error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
