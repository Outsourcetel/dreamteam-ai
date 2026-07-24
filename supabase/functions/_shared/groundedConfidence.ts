/**
 * groundedConfidence — §5: derive answer confidence from REAL retrieval support
 * instead of trusting the model's self-report. hybrid_match_knowledge already
 * returns per-chunk distance / score / lexical_rank / semantic_rank (free — the
 * retrieval already ran); this turns them into a 0-100 grounded confidence.
 *
 * Fail directions (the load-bearing honesty):
 *   - no-KB-needed (chit-chat / computed; no chunks, no citations) → value=null
 *     (indeterminate → self-report stands; do NOT punish a legit no-retrieval answer).
 *   - INFRA outage (embeddings unavailable / retrieval errored) → value=null
 *     (fail-OPEN: an outage must not mass-escalate; that's worse than self-report).
 *   - THIN / irrelevant retrieval → LOW (≤50) → escalates. This is the real signal.
 *   - cited sources but retrieval returned nothing → 0 (a fabricated citation).
 * The whole body is wrapped so it can NEVER throw into the answer path.
 *
 * Constants are shadow-only starting anchors (tune per tenant before enforce).
 */
export interface RetrievalChunk {
  distance?: number | null;
  score?: number | null;
  lexical_rank?: number | null;
  semantic_rank?: number | null;
}
export interface GroundedResult {
  value: number | null;      // null = indeterminate (no blend); 0-100 otherwise
  expected: boolean;         // was KB support expected for this answer?
  reason: string;
  inputs?: Record<string, unknown>;
}

const D_FULL = 0.12;    // cosine distance at which distance-support saturates (mig 301 bands covered paraphrase 0.068-0.199)
const D_ZERO = 0.30;    // distance at/above which distance-support is 0
const D_STRONG = 0.15;  // a chunk this close counts as a strong corroborator
const SCORE_FULL = 0.030; // RRF score at which corroboration saturates

export function groundedConfidence(
  chunks: RetrievalChunk[],
  opts: { embeddingAvailable: boolean; sourcesCited: number },
): GroundedResult {
  try {
    const n = Array.isArray(chunks) ? chunks.length : 0;
    const expected = n > 0 || (opts.sourcesCited ?? 0) > 0;
    // 1. No KB expected — chit-chat / computed answer. Don't punish.
    if (!expected) return { value: null, expected: false, reason: 'no_kb_expected' };
    // 2. INFRA — embeddings/retrieval unavailable. Fail OPEN (indeterminate), above
    //    the empty-retrieval branch so an outage is never scored as fabrication.
    if (!opts.embeddingAvailable) return { value: null, expected: true, reason: 'embeddings_unavailable' };
    // 3. Embeddings ran but retrieval empty while the model cited sources → fabricated.
    if (n === 0) return { value: 0, expected: true, reason: 'sources_without_retrieval', inputs: { candidates: 0, sourcesCited: opts.sourcesCited } };

    const dists = chunks
      .map((c) => (typeof c.distance === 'number' && Number.isFinite(c.distance) ? c.distance : null))
      .filter((d): d is number => d !== null);

    // 4. Nothing cleared the semantic cutoff — keyword coincidence only. Cap ≤50 (escalates).
    if (dists.length === 0) {
      const lexRanks = chunks
        .map((c) => (typeof c.lexical_rank === 'number' ? c.lexical_rank : null))
        .filter((r): r is number => r !== null);
      const lexTop = lexRanks.length ? Math.min(...lexRanks) : 1;
      const value = Math.max(0, Math.min(50, Math.round(45 - 3 * (lexTop - 1))));
      return { value, expected: true, reason: 'lexical_only', inputs: { lexTop, candidates: n } };
    }

    // 5. Graded — distance + coverage + corroboration.
    const dBest = Math.min(...dists);
    const distScore = Math.max(0, Math.min(100, (100 * (D_ZERO - dBest)) / (D_ZERO - D_FULL)));
    const nStrong = chunks.filter((c) =>
      (typeof c.distance === 'number' && c.distance <= D_STRONG) ||
      (c.lexical_rank != null && c.semantic_rank != null)
    ).length;
    const covScore = (dBest <= D_STRONG && nStrong >= 1) ? 100 : 100 * Math.min(1, nStrong / 2);
    const topScore = Math.max(...chunks.map((c) => (typeof c.score === 'number' && Number.isFinite(c.score) ? c.score : 0)));
    const corrScore = 100 * Math.max(0, Math.min(1, topScore / SCORE_FULL));
    const value = Math.max(0, Math.min(100, Math.round(0.60 * distScore + 0.25 * covScore + 0.15 * corrScore)));
    return {
      value, expected: true, reason: 'graded',
      inputs: { dBest: Math.round(dBest * 1000) / 1000, nStrong, topScore: Math.round(topScore * 10000) / 10000, candidates: n },
    };
  } catch (e) {
    // Never throw into the answer path — indeterminate (self-report stands).
    return { value: null, expected: true, reason: `error:${String((e as Error)?.message ?? e).slice(0, 60)}` };
  }
}
