/**
 * conflict-probe-drain — WS9 conflict/duplicate detection worker (Knowledge P5).
 *
 * Drains knowledge_conflict_probe_queue in bounded batches. For each new/changed
 * chunk it runs ONE index-backed HNSW top-k neighbour probe (probe_chunk_neighbors,
 * SET LOCAL iterative_scan) against its OWN tenant, then classifies each neighbour:
 *   • distance <= near_dup_max            -> record near_duplicate (no LLM)
 *   • near_dup_max < distance <= cand_max -> candidate:
 *        run a cheap TS lexical pre-filter (numeric / negation-polarity mismatch on
 *        shared terms); if a signal fires OR distance is in the high-suspicion band,
 *        spend ONE bounded LLM adjudication (strict JSON: duplicate|conflict|
 *        complementary|unrelated). Persist ONLY conflict/duplicate above min_confidence.
 * Cost scales with the CHANGE rate, not corpus size. LLM calls are hard-capped per tick.
 * WS9 is READ-ONLY on the corpus — it never touches hybrid_match_knowledge; a human
 * resolves findings (and only then a clamped authority nudge lands).
 *
 * INERT until opt-in: only chunks of tenants with the default-OFF flag
 * knowledge_conflict_detection ever get enqueued, so with no opt-in the queue is
 * empty and every tick no-ops. Kill-switch: platform_config 'knowledge.conflict_paused'.
 *
 * Auth: service-role key or x-dispatch-secret (same dual pattern as reembed-drain).
 *
 * POST { tenant_id?, limit? }  ->  { processed, findings, llm_calls, remaining, done }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { llmMessages } from '../_shared/llm.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Config read (platform_config.value is a plain TEXT column).
async function cfgNum(admin: SupabaseClient, key: string, dflt: number): Promise<number> {
  try {
    const { data } = await admin.from('platform_config').select('value').eq('key', key).maybeSingle();
    const v = Number((data?.value ?? '').toString().trim());
    return Number.isFinite(v) ? v : dflt;
  } catch { return dflt; }
}

// ── Cheap lexical pre-filter: does spending an LLM call look worthwhile? ──
const NUM_RE = /\$?\d[\d,]*(?:\.\d+)?%?/g;
const NEG_RE = /\b(not|no|never|cannot|can't|don't|doesn't|won't|shouldn't|prohibited|forbidden|ineligible|disallowed|denied|excluded|without)\b/i;
const norm = (s: string) => s.toLowerCase();
function numSet(s: string): Set<string> {
  return new Set((s.match(NUM_RE) ?? []).map((x) => x.replace(/[$,%]/g, '')));
}
function keywords(s: string): Set<string> {
  return new Set((norm(s).match(/[a-z]{5,}/g) ?? []));
}
function shareKeyword(a: string, b: string): boolean {
  const ka = keywords(a); for (const w of keywords(b)) if (ka.has(w)) return true; return false;
}
function lexicalSignals(a: string, b: string): string[] {
  const out: string[] = [];
  if (!shareKeyword(a, b)) return out;                  // different topics → no signal
  const na = numSet(a), nb = numSet(b);
  if (na.size && nb.size) {
    let differ = false; for (const x of na) if (!nb.has(x)) { differ = true; break; }
    if (!differ) for (const x of nb) if (!na.has(x)) { differ = true; break; }
    if (differ) out.push('numbers differ');
  }
  if (NEG_RE.test(a) !== NEG_RE.test(b)) out.push('polarity differs');
  return out;
}

// ── Bounded LLM adjudication (shared failover client, strict JSON) ──
async function adjudicate(admin: SupabaseClient, aText: string, bText: string):
  Promise<{ relation: string; confidence: number; rationale: string } | null> {
  const system = 'You compare two text snippets from ONE company knowledge base. Decide their relationship and reply with STRICT JSON only, no prose. Schema: {"relation":"duplicate"|"conflict"|"complementary"|"unrelated","confidence":0-1,"rationale":"<=200 chars"}. "conflict" = they contradict on a fact, number, date, or policy. "duplicate" = same information restated. "complementary" = same topic, compatible, additive. "unrelated" = different topics.';
  const user = `SNIPPET A:\n${aText.slice(0, 1500)}\n\nSNIPPET B:\n${bText.slice(0, 1500)}`;
  let res: Response;
  try {
    res = await llmMessages(admin, { model: 'claude-sonnet-5', max_tokens: 300, system, messages: [{ role: 'user', content: user }] }, 'conflict-adjudicate');
  } catch { return null; }
  if (!res.ok) return null;
  const d = await res.json();
  const text = (d.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    const relation = String(parsed.relation ?? '').toLowerCase();
    const confidence = Number(parsed.confidence);
    if (!['duplicate', 'conflict', 'complementary', 'unrelated'].includes(relation)) return null;
    return { relation, confidence: Number.isFinite(confidence) ? confidence : 0, rationale: String(parsed.rationale ?? '').slice(0, 240) };
  } catch { return null; }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!((dispatch && req.headers.get('x-dispatch-secret') === dispatch) || bearer === svc)) {
      return json({ error: 'unauthorized' }, 401);
    }

    // Kill-switch first.
    try {
      const { data: pause } = await admin.from('platform_config').select('value').eq('key', 'knowledge.conflict_paused').maybeSingle();
      const v = (pause?.value ?? '').toString().trim();
      if (v === 'true' || v === '1' || v === 't') return json({ ok: true, paused: true, processed: 0, findings: 0, llm_calls: 0, remaining: 0, done: false });
    } catch { /* absent → not paused */ }

    const body = await req.json().catch(() => ({})) as { tenant_id?: string; limit?: number };
    const nearDup = await cfgNum(admin, 'knowledge.conflict.near_dup_max', 0.05);
    const candMax = await cfgNum(admin, 'knowledge.conflict.candidate_max', 0.18);
    const kNeighbors = Math.round(await cfgNum(admin, 'knowledge.conflict.k_neighbors', 5));
    const perChunk = Math.round(await cfgNum(admin, 'knowledge.conflict.candidates_per_chunk', 3));
    const maxChunks = Math.min(Math.round(Number(body.limit) || await cfgNum(admin, 'knowledge.conflict.max_chunks_per_tick', 10)), 50);
    const maxLlm = Math.round(await cfgNum(admin, 'knowledge.conflict.max_llm_per_tick', 20));
    const minConf = await cfgNum(admin, 'knowledge.conflict.min_confidence', 0.6);
    const highSuspicion = Math.min(0.10, candMax);   // always LLM-check very-close candidates

    // Pull the next pending batch.
    let q = admin.from('knowledge_conflict_probe_queue').select('id, tenant_id, chunk_id, doc_id')
      .is('probed_at', null).order('enqueued_at', { ascending: true }).limit(maxChunks);
    if (body.tenant_id) q = q.eq('tenant_id', body.tenant_id);
    const { data: queued, error: qErr } = await q;
    if (qErr) return json({ error: qErr.message }, 500);

    let processed = 0, findings = 0, llmCalls = 0;
    const seen = new Set<string>();   // canonical pair keys handled this tick

    for (const row of (queued ?? []) as { id: number; tenant_id: string; chunk_id: string; doc_id: string }[]) {
      // Source chunk content.
      const { data: src } = await admin.from('knowledge_doc_chunks').select('content').eq('id', row.chunk_id).maybeSingle();
      const srcContent: string = src?.content ?? '';
      if (srcContent) {
        const { data: neighbors } = await admin.rpc('probe_chunk_neighbors', {
          p_tenant_id: row.tenant_id, p_chunk_id: row.chunk_id, p_doc_id: row.doc_id, p_k: kNeighbors,
        });
        let adjudicatedForChunk = 0;
        for (const n of (neighbors ?? []) as { neighbor_chunk_id: string; neighbor_doc_id: string; neighbor_content: string; distance: number }[]) {
          const pairKey = [row.chunk_id, n.neighbor_chunk_id].sort().join('|');
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          const dist = Number(n.distance);
          if (dist <= nearDup) {
            // Near-duplicate: no LLM needed.
            await admin.rpc('record_knowledge_conflict', {
              p_tenant_id: row.tenant_id, p_chunk_a: row.chunk_id, p_doc_a: row.doc_id,
              p_chunk_b: n.neighbor_chunk_id, p_doc_b: n.neighbor_doc_id,
              p_relation: 'near_duplicate', p_distance: dist, p_signal: { source: 'distance' }, p_confidence: 1 - dist,
            });
            findings++;
          } else if (dist <= candMax) {
            const signals = lexicalSignals(srcContent, n.neighbor_content ?? '');
            const worthLlm = signals.length > 0 || dist <= highSuspicion;
            if (!worthLlm) continue;
            if (llmCalls >= maxLlm || adjudicatedForChunk >= perChunk) continue;   // budget guard
            llmCalls++; adjudicatedForChunk++;
            const verdict = await adjudicate(admin, srcContent, n.neighbor_content ?? '');
            if (verdict && (verdict.relation === 'conflict' || verdict.relation === 'duplicate') && verdict.confidence >= minConf) {
              await admin.rpc('record_knowledge_conflict', {
                p_tenant_id: row.tenant_id, p_chunk_a: row.chunk_id, p_doc_a: row.doc_id,
                p_chunk_b: n.neighbor_chunk_id, p_doc_b: n.neighbor_doc_id,
                p_relation: verdict.relation === 'conflict' ? 'potential_conflict' : 'near_duplicate',
                p_distance: dist,
                p_signal: { source: 'llm', lexical: signals, rationale: verdict.rationale },
                p_confidence: verdict.confidence,
              });
              findings++;
            }
          }
        }
      }
      // Mark done regardless (empty/failed probes shouldn't wedge the queue head).
      await admin.from('knowledge_conflict_probe_queue').update({ probed_at: new Date().toISOString(), attempts: 1 }).eq('id', row.id);
      processed++;
      if (llmCalls >= maxLlm) break;   // stop the tick once the LLM budget is spent
    }

    let rq = admin.from('knowledge_conflict_probe_queue').select('id', { count: 'exact', head: true }).is('probed_at', null);
    if (body.tenant_id) rq = rq.eq('tenant_id', body.tenant_id);
    const { count: remaining } = await rq;

    return json({ ok: true, processed, findings, llm_calls: llmCalls, remaining: remaining ?? 0, done: (remaining ?? 0) === 0 });
  } catch (err) {
    console.error('conflict-probe-drain error:', String(err));
    return json({ error: String(err) }, 500);
  }
});
