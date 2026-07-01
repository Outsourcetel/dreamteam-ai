/**
 * de-execute Edge Function — Digital Employee Execution Engine
 *
 * The core runtime. Given a DE and an incoming message:
 *  1. Loads DE configuration (persona, confidence threshold, capabilities)
 *  2. Retrieves relevant knowledge (vector search if embeddings exist, else full-text)
 *  3. Calls Claude claude-haiku to generate a response
 *  4. Checks confidence against the DE's threshold
 *  5. If confident → returns response
 *     If not → creates an agent_action for human review and returns escalated status
 *
 * POST /functions/v1/de-execute
 * Body: { tenant_id, de_id?, message, conversation_id? }
 *
 * Secrets required:
 *   ANTHROPIC_API_KEY — from console.anthropic.com
 *   OPENAI_API_KEY    — optional; enables semantic search if knowledge_chunks have embeddings
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { tenant_id, de_id, message, conversation_id } = await req.json();
    if (!tenant_id || !message) throw new Error('tenant_id and message are required');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not configured');
    const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? null;

    // ── 1. Load DE configuration ───────────────────────────────────────────────
    let de: Record<string, unknown> = {
      name: 'Digital Employee',
      description: 'A helpful AI assistant',
      confidence_threshold: 75,
      trust_level: 'supervised',
      capabilities: [],
      responsibilities: [],
      department: '',
    };

    if (de_id) {
      const { data } = await supabase.from('digital_employees').select('*').eq('id', de_id).single();
      if (data) de = data as Record<string, unknown>;
    }

    const threshold = (de.confidence_threshold as number) ?? 75;

    // ── 2. Retrieve relevant knowledge ────────────────────────────────────────
    let context = '';
    let sources: { title: string; similarity: number }[] = [];
    let chunksFound = 0;
    let searchMode = 'fulltext';

    // Try semantic search first if OpenAI key is available
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
            title: c.title,
            similarity: Math.round(c.similarity * 100),
          }));
          context = chunks
            .map((c: { title: string; content: string }) => `[${c.title}]\n${c.content}`)
            .join('\n\n---\n\n');
        }
      }
    }

    // Fall back to full-text search
    if (!context) {
      const { data: articles } = await supabase.rpc('search_knowledge', {
        p_tenant_id: tenant_id,
        p_query: message,
        p_limit: 5,
      });

      if (articles && articles.length > 0) {
        chunksFound = articles.length;
        sources = articles.map((a: { title: string; similarity: number }) => ({
          title: a.title,
          similarity: Math.round((a.similarity ?? 0.5) * 100),
        }));
        context = articles
          .map((a: { title: string; body: string }) => `[${a.title}]\n${a.body?.slice(0, 800)}`)
          .join('\n\n---\n\n');
      }
    }

    if (!context) {
      context = 'No relevant knowledge found in the knowledge base for this query.';
    }

    // ── 3. Build DE persona prompt ─────────────────────────────────────────────
    const caps = (de.capabilities as string[])?.join(', ') || 'general assistance';
    const resps = (de.responsibilities as string[])?.join('; ') || '';

    const systemPrompt = `You are ${de.name}, a Digital Employee at this organisation.
${de.description ? `Role: ${de.description}` : ''}
${de.department ? `Department: ${de.department}` : ''}
${caps ? `Capabilities: ${caps}` : ''}
${resps ? `Responsibilities: ${resps}` : ''}

You answer questions and handle requests using ONLY the knowledge base provided below.
Rules:
- Answer only from the knowledge base. Never invent information.
- If the answer is not in the knowledge base, say so clearly and offer to escalate to a human.
- Be concise, professional, and helpful. Maximum 3–4 sentences unless more detail is genuinely needed.
- After your answer, on a new line output this JSON (nothing else on that line):
  {"confidence": <0–100>}
  where confidence reflects how well the knowledge base covered the question:
  90–100 = fully answered from KB, 70–89 = mostly covered, 50–69 = partially covered, below 50 = unsure or not in KB.

KNOWLEDGE BASE:
${context}`;

    // ── 4. Call Claude claude-haiku ────────────────────────────────────────────
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      throw new Error(`Anthropic error ${anthropicRes.status}: ${errBody}`);
    }

    const anthropicData = await anthropicRes.json();
    const rawText: string = anthropicData.content?.[0]?.text ?? '';

    // ── 5. Parse confidence from model output ──────────────────────────────────
    let confidence = chunksFound > 0 ? 70 : 30; // default based on KB hit
    let responseText = rawText;

    const jsonMatch = rawText.match(/\{"confidence":\s*(\d+(?:\.\d+)?)\}/);
    if (jsonMatch) {
      confidence = parseFloat(jsonMatch[1]);
      responseText = rawText.replace(jsonMatch[0], '').trim();
    }

    confidence = Math.min(100, Math.max(0, Math.round(confidence)));
    const needsApproval = confidence < threshold;

    // ── 6. Create agent_action if below threshold ──────────────────────────────
    if (needsApproval) {
      await supabase.from('agent_actions').insert({
        tenant_id,
        de_id: de_id ?? null,
        agent_name: de.name,
        action_type: 'response_review',
        description: `Low-confidence response (${confidence}%) to: "${(message as string).slice(0, 120)}"`,
        status: 'pending',
        confidence_score: confidence / 100,
        requires_approval: true,
        payload: {
          message,
          proposed_response: responseText,
          sources_found: chunksFound,
          search_mode: searchMode,
        },
      });
    }

    // ── 7. Log message to conversation if provided ─────────────────────────────
    if (conversation_id) {
      await supabase.from('conversation_messages').insert({
        conversation_id,
        tenant_id,
        role: 'assistant',
        content: responseText,
        confidence_score: confidence / 100,
        requires_approval: needsApproval,
        kb_articles_used: chunksFound,
      }).throwOnError().catch(() => {}); // non-fatal
    }

    return new Response(JSON.stringify({
      response: responseText,
      confidence,
      threshold,
      status: needsApproval ? 'escalated' : 'answered',
      sources,
      chunks_found: chunksFound,
      search_mode: searchMode,
      de_name: de.name,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('de-execute error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
