/**
 * de-execute — Digital Employee Execution Engine
 *
 * Intelligence layers:
 *   1. Intent routing   — when no de_id: Gemini Flash classifies query → picks best DE
 *   2. Task-type model  — each DE declares task_type → auto-selects best model for that job
 *   3. Tiered escalation — primary model tries first; if confidence < escalation_threshold
 *                          the escalation model retries; only creates approval if both fail
 *
 * POST body: { tenant_id, de_id?, message, conversation_id? }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Task-type → best model mapping (mirrors src/lib/models.ts) ────────────────
const TASK_MODELS: Record<string, { provider: string; modelId: string; escalationModelId: string }> = {
  chat:           { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', escalationModelId: 'claude-sonnet-5' },
  summarisation:  { provider: 'google',    modelId: 'gemini-1.5-pro',            escalationModelId: 'claude-sonnet-5' },
  compliance:     { provider: 'anthropic', modelId: 'claude-opus-4-8',           escalationModelId: 'claude-opus-4-8' },
  reasoning:      { provider: 'anthropic', modelId: 'claude-sonnet-5',           escalationModelId: 'claude-opus-4-8' },
  data_analysis:  { provider: 'openai',    modelId: 'gpt-4o',                    escalationModelId: 'claude-sonnet-5' },
  drafting:       { provider: 'anthropic', modelId: 'claude-sonnet-5',           escalationModelId: 'claude-opus-4-8' },
  classification: { provider: 'google',    modelId: 'gemini-1.5-flash',          escalationModelId: 'claude-haiku-4-5-20251001' },
};

// ── Provider call functions ────────────────────────────────────────────────────

async function callAnthropic(system: string, user: string, model: string, key: string) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 600, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return { text: d.content?.[0]?.text ?? '', inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 };
}

async function callOpenAI(system: string, user: string, model: string, key: string) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return { text: d.choices?.[0]?.message?.content ?? '', inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0 };
}

async function callGoogle(system: string, user: string, model: string, key: string) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 600 },
    }),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return {
    text: d.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
    inputTokens: d.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: d.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function callModel(system: string, user: string, provider: string, modelId: string, keys: Record<string, string | null>) {
  const key = keys[provider];
  if (!key) throw new Error(`${provider} API key not configured — add it in Settings → AI Engine`);
  if (provider === 'openai') return callOpenAI(system, user, modelId, key);
  if (provider === 'google') return callGoogle(system, user, modelId, key);
  return callAnthropic(system, user, modelId, key);
}

// ── Embed (OpenAI only — best quality, used regardless of DE model) ───────────
async function embedText(text: string, key: string): Promise<number[] | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text.slice(0, 8000), model: 'text-embedding-3-small' }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.data?.[0]?.embedding ?? null;
  } catch { return null; }
}

// ── Parse confidence from raw model output ────────────────────────────────────
function parseConfidence(raw: string, fallback: number): { confidence: number; text: string } {
  const m = raw.match(/\{"confidence":\s*(\d+(?:\.\d+)?)\}/);
  if (!m) return { confidence: fallback, text: raw.trim() };
  return {
    confidence: Math.min(100, Math.max(0, Math.round(parseFloat(m[1])))),
    text: raw.replace(m[0], '').trim(),
  };
}

// ── Layer 1: Intent routing — pick best DE when none specified ─────────────────
async function routeIntent(
  message: string,
  des: Array<{ id: string; name: string; description: string; task_type: string }>,
  keys: Record<string, string | null>,
): Promise<string | null> {
  if (des.length === 0) return null;
  if (des.length === 1) return des[0].id;

  const googleKey = keys['google'];
  const anthropicKey = keys['anthropic'];
  const routerKey = googleKey ?? anthropicKey;
  const routerProvider = googleKey ? 'google' : 'anthropic';
  const routerModel = googleKey ? 'gemini-1.5-flash' : 'claude-haiku-4-5-20251001';
  if (!routerKey) return des[0].id;

  const deList = des.map(d => `- ID: ${d.id} | Name: ${d.name} | Type: ${d.task_type} | ${d.description}`).join('\n');
  const system = `You are an intent router. Given a user message and a list of Digital Employees, return ONLY the ID of the best matching Digital Employee. No explanation, no other text — just the ID string.`;
  const user = `Digital Employees:\n${deList}\n\nUser message: "${message}"\n\nReturn the ID of the best matching Digital Employee:`;

  try {
    const result = await callModel(system, user, routerProvider, routerModel, keys);
    const id = result.text.trim().replace(/['"]/g, '');
    const match = des.find(d => d.id === id);
    return match?.id ?? des[0].id;
  } catch {
    return des[0].id;
  }
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

    // ── Load API keys ─────────────────────────────────────────────────────────
    const keys: Record<string, string | null> = {
      anthropic: Deno.env.get('ANTHROPIC_API_KEY') ?? null,
      openai:    Deno.env.get('OPENAI_API_KEY')    ?? null,
      google:    Deno.env.get('GOOGLE_AI_KEY')     ?? null,
    };

    const missingKeys = Object.keys(keys).filter(k => !keys[k]);
    if (missingKeys.length > 0) {
      const { data: configs } = await supabase
        .from('platform_config')
        .select('key, value')
        .in('key', ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_KEY']);
      if (configs) {
        for (const row of configs) {
          if (row.key === 'ANTHROPIC_API_KEY' && !keys.anthropic) keys.anthropic = row.value;
          if (row.key === 'OPENAI_API_KEY'    && !keys.openai)    keys.openai    = row.value;
          if (row.key === 'GOOGLE_AI_KEY'     && !keys.google)    keys.google    = row.value;
        }
      }
    }

    // ── Check tenant token budget ─────────────────────────────────────────────
    const { data: tenantRow } = await supabase
      .from('tenants').select('monthly_token_budget').eq('id', tenant_id).single();
    const budget: number = tenantRow?.monthly_token_budget ?? 100000;
    const yearMonth = new Date().toISOString().slice(0, 7);
    const { data: usageRow } = await supabase
      .from('tenant_ai_usage').select('tokens_used').eq('tenant_id', tenant_id).eq('year_month', yearMonth).single();
    const currentUsage = usageRow?.tokens_used ?? 0;

    if (budget > 0 && currentUsage >= budget) {
      return new Response(JSON.stringify({
        response: 'This workspace has reached its monthly AI token limit. Please contact your administrator.',
        confidence: 0, threshold: 75, status: 'escalated',
        sources: [], chunks_found: 0, search_mode: 'fulltext',
        de_name: 'Digital Employee', budget_exceeded: true,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // ── Layer 1: Intent routing — resolve DE when not specified ───────────────
    let resolvedDeId = de_id ?? null;
    let routedBy: string | null = null;

    if (!resolvedDeId) {
      const { data: activeDEs } = await supabase
        .from('digital_employees')
        .select('id, name, description, task_type')
        .eq('tenant_id', tenant_id)
        .eq('status', 'active');

      if (activeDEs && activeDEs.length > 0) {
        resolvedDeId = await routeIntent(message, activeDEs, keys);
        routedBy = 'intent_router';
      }
    }

    // ── Load DE config ────────────────────────────────────────────────────────
    let de: Record<string, unknown> = {
      name: 'Digital Employee',
      description: 'A helpful AI assistant',
      confidence_threshold: 75,
      task_type: 'chat',
      model_provider: 'anthropic',
      model_id: 'claude-haiku-4-5-20251001',
      escalation_model_id: 'claude-sonnet-5',
      escalation_threshold: 60,
      capabilities: [], responsibilities: [], department: '',
    };

    if (resolvedDeId) {
      const { data } = await supabase.from('digital_employees').select('*').eq('id', resolvedDeId).single();
      if (data) de = data as Record<string, unknown>;
    }

    const confidenceThreshold = (de.confidence_threshold as number) ?? 75;
    const escalationThreshold = (de.escalation_threshold as number) ?? 60;
    const taskType = (de.task_type as string) ?? 'chat';

    // ── Layer 2: Task-type model selection ────────────────────────────────────
    // If DE has a non-default model configured, respect it.
    // Otherwise, auto-select best model for the task type.
    const taskDefaults = TASK_MODELS[taskType] ?? TASK_MODELS['chat'];
    const isDefaultModel = (de.model_id as string) === 'claude-haiku-4-5-20251001'
      && (de.model_provider as string) === 'anthropic';

    const primaryProvider = isDefaultModel ? taskDefaults.provider : (de.model_provider as string);
    const primaryModelId  = isDefaultModel ? taskDefaults.modelId  : (de.model_id as string);

    // Escalation model: DE config wins if set, else task defaults
    const escalationModelId = ((de.escalation_model_id as string) !== 'claude-sonnet-5' || !isDefaultModel)
      ? (de.escalation_model_id as string) ?? taskDefaults.escalationModelId
      : taskDefaults.escalationModelId;

    // ── Retrieve relevant knowledge ───────────────────────────────────────────
    let context = '';
    let sources: { title: string; similarity: number }[] = [];
    let chunksFound = 0;
    let searchMode = 'fulltext';
    let totalTokens = 0;

    if (keys.openai) {
      const embedding = await embedText(message, keys.openai);
      if (embedding) {
        const { data: chunks } = await supabase.rpc('match_knowledge_chunks', {
          query_embedding: embedding, match_tenant_id: tenant_id, match_threshold: 0.4, match_count: 6,
        });
        if (chunks?.length > 0) {
          searchMode = 'semantic'; chunksFound = chunks.length;
          sources = chunks.map((c: { title: string; similarity: number }) => ({ title: c.title, similarity: Math.round(c.similarity * 100) }));
          context = chunks.map((c: { title: string; content: string }) => `[${c.title}]\n${c.content}`).join('\n\n---\n\n');
        }
      }
    }

    if (!context) {
      const { data: articles } = await supabase.rpc('search_knowledge', { p_tenant_id: tenant_id, p_query: message, p_limit: 5 });
      if (articles?.length > 0) {
        chunksFound = articles.length;
        sources = articles.map((a: { title: string; similarity: number }) => ({ title: a.title, similarity: Math.round((a.similarity ?? 0.5) * 100) }));
        context = articles.map((a: { title: string; body: string }) => `[${a.title}]\n${a.body?.slice(0, 800)}`).join('\n\n---\n\n');
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

Answer using ONLY the knowledge base below. Never invent information.
If the answer is not in the KB, say so and offer to escalate.
Be concise and professional. After your answer add this JSON on a new line:
{"confidence": <0–100>}
(90-100 = fully answered from KB, below 50 = not in KB)

KNOWLEDGE BASE:
${context}`;

    // ── Layer 3: Tiered escalation ─────────────────────────────────────────────
    // Attempt 1: primary model (fast + cheap)
    const attempt1 = await callModel(systemPrompt, message, primaryProvider, primaryModelId, keys);
    totalTokens += attempt1.inputTokens + attempt1.outputTokens;
    const parsed1 = parseConfidence(attempt1.text, chunksFound > 0 ? 70 : 30);

    let finalText       = parsed1.text;
    let finalConfidence = parsed1.confidence;
    let escalated       = false;
    let modelUsed       = { provider: primaryProvider, modelId: primaryModelId, attempt: 1 };

    // Attempt 2: escalation model if primary is uncertain but not hopeless
    if (parsed1.confidence < escalationThreshold && parsed1.confidence > 20 && escalationModelId !== primaryModelId) {
      try {
        // Escalation model gets a richer prompt since the primary attempt struggled
        const escalationPrompt = `${systemPrompt}

Note: A faster model attempted this query and was only ${parsed1.confidence}% confident. Please provide a more thorough answer.`;
        const providerForEscalation = Object.keys(TASK_MODELS).reduce(
          (found, key) => {
            const m = Object.values(TASK_MODELS).find(v => v.modelId === escalationModelId || v.escalationModelId === escalationModelId);
            return m ? (escalationModelId === m.escalationModelId ? (key === 'compliance' ? 'anthropic' : m.provider) : m.provider) : found;
          }, primaryProvider
        );
        // Determine provider for escalation model by checking which API it belongs to
        const escProvider = escalationModelId.startsWith('claude') ? 'anthropic'
          : escalationModelId.startsWith('gpt') || escalationModelId.startsWith('o1') ? 'openai'
          : 'google';

        const attempt2 = await callModel(escalationPrompt, message, escProvider, escalationModelId, keys);
        totalTokens += attempt2.inputTokens + attempt2.outputTokens;
        const parsed2 = parseConfidence(attempt2.text, parsed1.confidence);

        // Use escalation response if it's more confident
        if (parsed2.confidence > parsed1.confidence) {
          finalText       = parsed2.text;
          finalConfidence = parsed2.confidence;
          modelUsed       = { provider: escProvider, modelId: escalationModelId, attempt: 2 };
          escalated       = true;
        }
      } catch (err) {
        console.warn('Escalation model failed, using primary result:', err);
      }
    }

    const needsApproval = finalConfidence < confidenceThreshold;

    // ── Log token usage ───────────────────────────────────────────────────────
    if (totalTokens > 0) {
      await supabase.rpc('increment_tenant_token_usage', {
        p_tenant_id: tenant_id, p_year_month: yearMonth, p_tokens: totalTokens,
      }).catch(() => {});
    }

    // ── Create approval request if below threshold ────────────────────────────
    if (needsApproval) {
      await supabase.from('agent_actions').insert({
        tenant_id, de_id: resolvedDeId ?? null,
        agent_name: de.name,
        action_type: 'response_review',
        description: `Low-confidence response (${finalConfidence}%) to: "${(message as string).slice(0, 120)}"`,
        status: 'pending', confidence_score: finalConfidence / 100, requires_approval: true,
        payload: {
          message, proposed_response: finalText, sources_found: chunksFound,
          search_mode: searchMode, model_used: modelUsed, escalated,
        },
      });
    }

    // ── Log to conversation ───────────────────────────────────────────────────
    if (conversation_id) {
      await supabase.from('conversation_messages').insert({
        conversation_id, tenant_id, role: 'assistant', content: finalText,
        confidence_score: finalConfidence / 100, requires_approval: needsApproval,
        kb_articles_used: chunksFound,
      }).throwOnError().catch(() => {});
    }

    return new Response(JSON.stringify({
      response: finalText,
      confidence: finalConfidence,
      threshold: confidenceThreshold,
      status: needsApproval ? 'escalated' : 'answered',
      sources, chunks_found: chunksFound, search_mode: searchMode,
      de_name: de.name,
      model_used: modelUsed,
      escalated,
      routed_by: routedBy,
      task_type: taskType,
      tokens_used: totalTokens,
      budget_remaining: budget > 0 ? budget - currentUsage - totalTokens : null,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('de-execute error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
