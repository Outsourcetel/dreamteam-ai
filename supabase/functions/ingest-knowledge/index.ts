/**
 * ingest-knowledge Edge Function
 *
 * Takes a knowledge article's text, chunks it, generates OpenAI embeddings,
 * and stores the chunks in knowledge_chunks for semantic retrieval.
 *
 * POST /functions/v1/ingest-knowledge
 * Body: { tenant_id, content, title, article_id?, source_type?, source_url? }
 *
 * Secrets required (Supabase Dashboard → Project Settings → Edge Functions → Secrets):
 *   OPENAI_API_KEY — from platform.openai.com/api-keys
 *
 * Returns: { success, chunks_created, mode: 'embeddings' | 'text-only' }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CHUNK_SIZE = 600;  // characters per chunk
const CHUNK_OVERLAP = 80;

function chunkText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(start + CHUNK_SIZE, cleaned.length);
    const chunk = cleaned.slice(start, end).trim();
    if (chunk.length > 30) chunks.push(chunk);
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

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
    const { tenant_id, content, title, article_id, source_type = 'manual', source_url } = await req.json();

    if (!tenant_id || !content) {
      return new Response(JSON.stringify({ error: 'tenant_id and content are required' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? null;
    const chunks = chunkText(content);
    let chunksCreated = 0;
    let mode: 'embeddings' | 'text-only' = openaiKey ? 'embeddings' : 'text-only';

    // Delete previous chunks for this article if re-ingesting
    if (article_id) {
      await supabase.from('knowledge_chunks').delete().eq('article_id', article_id);
    }

    for (let i = 0; i < chunks.length; i++) {
      const embedding = openaiKey ? await embedText(chunks[i], openaiKey) : null;
      if (openaiKey && !embedding) mode = 'text-only'; // embedding failed, degrade gracefully

      const { error } = await supabase.from('knowledge_chunks').insert({
        tenant_id,
        article_id: article_id ?? null,
        title: title ?? '',
        content: chunks[i],
        embedding: embedding ?? null,
        source_type,
        source_url: source_url ?? null,
        chunk_index: i,
        metadata: { total_chunks: chunks.length, chars: chunks[i].length },
      });

      if (!error) chunksCreated++;
    }

    return new Response(JSON.stringify({ success: true, chunks_created: chunksCreated, mode }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
