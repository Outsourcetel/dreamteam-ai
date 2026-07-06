/**
 * knowledgeEmbed — shared free edge embeddings (gte-small, 384 dims) used
 * by every knowledge consumer (de-answer, widget-ask, specialist-consult).
 *
 * Previously copy-pasted verbatim into de-answer and specialist-consult
 * independently (found during the 046 hybrid-retrieval consolidation);
 * widget-ask never had its own copy at all, which meant it silently ran
 * keyword-only retrieval despite its header comment claiming to mirror
 * de-answer's pipeline. Centralizing here so every consumer has the same
 * capability and any future embedding-model change happens in one place.
 *
 * Returns null (never throws) when Supabase.ai isn't available in this
 * runtime or the model output isn't the expected 384-dim vector — callers
 * must treat a null embedding as "fall back to lexical-only" rather than
 * as an error; hybrid_match_knowledge (migration 046) is designed to
 * degrade gracefully to pure lexical ranking when p_query_embedding is null.
 */
export async function embedText(text: string): Promise<number[] | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const SupabaseAI = (globalThis as any).Supabase?.ai;
    if (!SupabaseAI) return null;
    const session = new SupabaseAI.Session('gte-small');
    const out = await session.run(text, { mean_pool: true, normalize: true });
    const vec = Array.from(out as Iterable<number>);
    return vec.length === 384 ? vec : null;
  } catch (e) {
    console.error('embedText (gte-small) failed:', e);
    return null;
  }
}
