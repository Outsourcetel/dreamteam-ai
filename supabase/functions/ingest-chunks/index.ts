/**
 * ingest-chunks — chunk + embed a knowledge_doc into knowledge_doc_chunks.
 *
 * Input:  { doc_id }
 * Auth:   caller JWT (same pattern as de-answer) — tenant resolved from profile,
 *         and the doc must belong to that tenant.
 * Embeds: Supabase.ai.Session('gte-small') — free, local to the edge runtime,
 *         384 dimensions. If unavailable, chunks are stored with null
 *         embeddings (keyword retrieval still works) and embedded = 0.
 * Output: { doc_id, chunks, embedded }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const CHUNK_SIZE = 1500;   // chars
const CHUNK_OVERLAP = 200; // chars

/** Split on paragraph, then sentence boundaries; ~1500 chars with ~200 overlap. */
export function chunkText(text: string): string[] {
  const clean = (text || '').trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      // Prefer paragraph break, then sentence end, then space — searched from the back.
      const para = window.lastIndexOf('\n\n');
      const sentence = Math.max(
        window.lastIndexOf('. '), window.lastIndexOf('.\n'),
        window.lastIndexOf('! '), window.lastIndexOf('? '),
      );
      const space = window.lastIndexOf(' ');
      const cut = para > CHUNK_SIZE * 0.4 ? para
        : sentence > CHUNK_SIZE * 0.4 ? sentence + 1
        : space > CHUNK_SIZE * 0.4 ? space
        : window.length;
      end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { doc_id } = await req.json();
    if (!doc_id || typeof doc_id !== 'string') return json({ error: 'doc_id required' }, 400);

    // ── Auth: resolve the caller from their JWT ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

    const { data: profile } = await admin
      .from('profiles').select('tenant_id').eq('user_id', userData.user.id).single();
    const tenantId: string | null = profile?.tenant_id ?? null;
    if (!tenantId) return json({ error: 'no_tenant' }, 403);

    // ── Fetch the doc (must belong to the caller's tenant) ──
    const { data: doc, error: docErr } = await admin
      .from('knowledge_docs')
      .select('id, tenant_id, account_id, title, content')
      .eq('id', doc_id)
      .eq('tenant_id', tenantId)
      .single();
    if (docErr || !doc) return json({ error: 'doc_not_found' }, 404);

    const chunks = chunkText(`${doc.title}\n\n${doc.content}`);

    // ── Embed via free edge AI (gte-small, 384 dims); degrade gracefully ──
    let embeddings: (number[] | null)[] = chunks.map(() => null);
    let embedded = 0;
    try {
      // deno-lint-ignore no-explicit-any
      const SupabaseAI = (globalThis as any).Supabase?.ai;
      if (SupabaseAI) {
        const session = new SupabaseAI.Session('gte-small');
        embeddings = await Promise.all(chunks.map(async (c) => {
          try {
            const out = await session.run(c, { mean_pool: true, normalize: true });
            const vec = Array.from(out as Iterable<number>);
            return vec.length === 384 ? vec : null;
          } catch { return null; }
        }));
        embedded = embeddings.filter((e) => e !== null).length;
      }
    } catch (e) {
      console.error('gte-small embedding unavailable:', e);
    }

    // ── Replace old chunks for the doc ──
    await admin.from('knowledge_doc_chunks').delete().eq('doc_id', doc.id);
    if (chunks.length > 0) {
      const rows = chunks.map((content, i) => ({
        tenant_id: tenantId,
        account_id: doc.account_id ?? null,
        doc_id: doc.id,
        chunk_index: i,
        content,
        embedding: embeddings[i],
      }));
      const { error: insErr } = await admin.from('knowledge_doc_chunks').insert(rows);
      if (insErr) return json({ error: insErr.message }, 500);
    }

    return json({ doc_id: doc.id, chunks: chunks.length, embedded });
  } catch (err) {
    console.error('ingest-chunks error:', err);
    return json({ error: String(err) }, 500);
  }
});
