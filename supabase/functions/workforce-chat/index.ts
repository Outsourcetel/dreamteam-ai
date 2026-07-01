/**
 * workforce-chat Edge Function
 *
 * HOW TO DEPLOY (5 minutes, no terminal needed):
 * 1. Go to your Supabase dashboard → Edge Functions → New Function
 * 2. Name it: workforce-chat
 * 3. Paste this entire file
 * 4. Go to Project Settings → Edge Functions → Secrets
 * 5. Add secret: ANTHROPIC_API_KEY = <your key from console.anthropic.com>
 * 6. Click Deploy — done. The Customer Portal chat is now powered by Claude.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CONFIDENCE_THRESHOLD = 0.55;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { message, tenantId, conversationId } = await req.json();

    if (!message || !tenantId) {
      return new Response(JSON.stringify({ error: 'message and tenantId required' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ── Step 1: Retrieve relevant KB articles (full-text search) ──
    const { data: articles } = await supabase.rpc('search_knowledge', {
      p_tenant_id: tenantId,
      p_query: message,
      p_limit: 5,
    });

    const context = articles && articles.length > 0
      ? articles.map((a: { title: string; body: string }) =>
          `[Article: ${a.title}]\n${a.body}`
        ).join('\n\n---\n\n')
      : 'No relevant knowledge base articles found.';

    // ── Step 2: Call Anthropic ──
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) {
      // Graceful fallback: return rule-based response if key not set
      return new Response(JSON.stringify({
        response: 'I\'m here to help! Could you give me a bit more detail so I can find the right answer for you?',
        confidence: 0.4,
        requires_approval: false,
        kb_articles_used: 0,
        source: 'fallback',
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const systemPrompt = `You are a helpful Digital Employee for a business. Your job is to answer customer questions accurately using the knowledge base provided.

Rules:
- Answer only from the knowledge base context provided. Do not invent information.
- If the knowledge base does not contain the answer, say so honestly and offer to escalate.
- Be concise and friendly. Maximum 3 sentences unless the question requires more detail.
- After your answer, output a JSON block on its own line: {"confidence": <0.0-1.0>}
  where confidence reflects how well the knowledge base covered the question.
  0.9+ = fully answered from KB, 0.7 = partially covered, below 0.55 = unsure / should escalate.

Knowledge Base Context:
${context}`;

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!anthropicResponse.ok) {
      throw new Error(`Anthropic API error: ${anthropicResponse.status}`);
    }

    const anthropicData = await anthropicResponse.json();
    const rawText: string = anthropicData.content?.[0]?.text ?? '';

    // ── Step 3: Parse confidence from the model's output ──
    let confidence = 0.7;
    let responseText = rawText;

    const jsonMatch = rawText.match(/\{"confidence":\s*([\d.]+)\}/);
    if (jsonMatch) {
      confidence = parseFloat(jsonMatch[1]);
      responseText = rawText.replace(jsonMatch[0], '').trim();
    }

    const requiresApproval = confidence < CONFIDENCE_THRESHOLD;

    // ── Step 4: Store message in conversation log ──
    if (conversationId) {
      await supabase.from('conversation_messages').insert({
        conversation_id: conversationId,
        tenant_id: tenantId,
        role: 'assistant',
        content: responseText,
        confidence_score: confidence,
        requires_approval: requiresApproval,
        kb_articles_used: articles?.length ?? 0,
      }).throwOnError().catch(() => {}); // non-fatal if table doesn't exist yet
    }

    return new Response(JSON.stringify({
      response: responseText,
      confidence,
      requires_approval: requiresApproval,
      kb_articles_used: articles?.length ?? 0,
      source: 'claude',
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('workforce-chat error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
