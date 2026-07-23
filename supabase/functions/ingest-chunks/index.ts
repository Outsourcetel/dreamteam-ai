/**
 * ingest-chunks — chunk + embed a knowledge_doc into knowledge_doc_chunks.
 *
 * Input:  { doc_id, tenant_id? }
 * Auth:   caller JWT (same pattern as de-answer) — tenant resolved from profile,
 *         and the doc must belong to that tenant. ALSO accepts the
 *         x-dispatch-secret header or the service-role key directly
 *         (same dual pattern as knowledge-gap-detect) with an explicit
 *         tenant_id — this is what lets automated/connector-driven
 *         ingestion (e.g. the TCP community corpus load, DE-A2) chunk
 *         and embed without a human's browser session.
 * Embeds: Supabase.ai.Session('gte-small') — free, local to the edge runtime,
 *         384 dimensions. If unavailable, chunks are stored with null
 *         embeddings (keyword retrieval still works) and embedded = 0.
 * Output: { doc_id, chunks, embedded }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { contentHash } from '../_shared/contentHash.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
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
    const { doc_id, tenant_id: assertedTenantId } = await req.json();
    if (!doc_id || typeof doc_id !== 'string') return json({ error: 'doc_id required' }, 400);

    // ── Auth: service/dispatch caller with an explicit tenant, or a
    // user JWT (tenant resolved from their profile) ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
    const isServiceRole = jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const isDispatchCron = dispatchSecret !== '' && headerSecret === dispatchSecret;

    let tenantId: string | null = null;
    if (isServiceRole || isDispatchCron) {
      // Automated caller — must name the tenant explicitly, and it must
      // be a real one (the doc's own tenant_id is re-checked below).
      if (typeof assertedTenantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(assertedTenantId)) {
        return json({ error: 'tenant_id required for service calls' }, 400);
      }
      tenantId = assertedTenantId;
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

      const { data: profile } = await admin
        .from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
      tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, assertedTenantId);
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // ── Fetch the doc (must belong to the caller's tenant) ──
    const { data: doc, error: docErr } = await admin
      .from('knowledge_docs')
      .select('id, tenant_id, account_id, title, content, content_hash')
      .eq('id', doc_id)
      .eq('tenant_id', tenantId)
      .single();
    if (docErr || !doc) return json({ error: 'doc_not_found' }, 404);

    // ── Store chunks FIRST, embed in bounded batches after ──
    //
    // Embedding is resumable by design: a single invocation embedding a
    // whole large doc exceeds the edge worker's compute budget
    // (WORKER_RESOURCE_LIMIT — confirmed live on an ~11K-char doc during
    // the DE-A2 corpus load, even with strictly sequential embedding).
    // So each call (1) chunks + stores immediately with null embeddings
    // unless the chunks already exist, then (2) embeds at most
    // EMBED_BATCH of the doc's still-null chunks, and (3) reports
    // `remaining` so the caller loops until it hits 0. Retrieval
    // degrades gracefully meanwhile: lexical search sees the doc at
    // once; semantic search picks chunks up as their embeddings land.
    const EMBED_BATCH = 4;

    const { count: existingCount } = await admin
      .from('knowledge_doc_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('doc_id', doc.id);

    // WS8 STEP 1 (mig 286): re-chunk iff the NORMALIZED content changed. This
    // fixes BOTH failure modes at once — an unchanged re-ingest becomes a no-op
    // (was: re-embed storm on connectors), and an EDITED doc actually re-chunks
    // (was: `if (!existingCount)` kept stale chunks forever on any edit).
    const newHash = await contentHash(`${doc.title}\n\n${doc.content}`);
    const unchanged = doc.content_hash === newHash && (existingCount ?? 0) > 0;
    let totalChunks = existingCount ?? 0;
    if (!unchanged) {
      const chunks = chunkText(`${doc.title}\n\n${doc.content}`);
      await admin.from('knowledge_doc_chunks').delete().eq('doc_id', doc.id);
      if (chunks.length > 0) {
        const rows = chunks.map((content, i) => ({
          tenant_id: tenantId,
          account_id: doc.account_id ?? null,
          doc_id: doc.id,
          chunk_index: i,
          content,
          embedding: null,
        }));
        const { error: insErr } = await admin.from('knowledge_doc_chunks').insert(rows);
        if (insErr) return json({ error: insErr.message }, 500);
      }
      // Stamp the doc hash so the next ingest of unchanged content skips.
      await admin.from('knowledge_docs').update({ content_hash: newHash }).eq('id', doc.id);
      totalChunks = chunks.length;
    }

    let embeddedThisCall = 0;
    try {
      // deno-lint-ignore no-explicit-any
      const SupabaseAI = (globalThis as any).Supabase?.ai;
      if (SupabaseAI) {
        const { data: pending } = await admin
          .from('knowledge_doc_chunks')
          .select('id, content')
          .eq('doc_id', doc.id)
          .is('embedding', null)
          .order('chunk_index', { ascending: true })
          .limit(EMBED_BATCH);
        const session = new SupabaseAI.Session('gte-small');
        for (const c of (pending ?? []) as { id: string; content: string }[]) {
          try {
            const out = await session.run(c.content, { mean_pool: true, normalize: true });
            const vec = Array.from(out as Iterable<number>);
            if (vec.length === 384) {
              const { error: updErr } = await admin
                .from('knowledge_doc_chunks').update({ embedding: vec }).eq('id', c.id);
              if (!updErr) embeddedThisCall++;
            }
          } catch { /* leave null; a later call picks it up */ }
        }
      }
    } catch (e) {
      console.error('gte-small embedding unavailable:', e);
    }

    const { count: stillNull } = await admin
      .from('knowledge_doc_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('doc_id', doc.id)
      .is('embedding', null);

    return json({
      doc_id: doc.id,
      chunks: totalChunks,
      embedded: embeddedThisCall,
      remaining: stillNull ?? 0,
    });
  } catch (err) {
    console.error('ingest-chunks error:', err);
    return json({ error: String(err) }, 500);
  }
});
