/**
 * de-answer — the real Customer Support DE brain (production track P2).
 *
 * Flow: auth (caller JWT) → resolve tenant → retrieve knowledge_docs by
 * keyword overlap → Claude (claude-sonnet-5) answers ONLY from those docs,
 * returning strict JSON {answer, confidence, sources, needs_escalation} →
 * persist conversation → auto-escalate to human_tasks when confidence < 60
 * or the model asks for escalation → activity_events entry either way.
 *
 * If ANTHROPIC_API_KEY is not set, returns {error:'llm_not_configured'}
 * (HTTP 200) so the frontend can show an honest "brain not activated" state.
 *
 * HOW TO DEPLOY (if not deployed via Management API):
 *   npx supabase functions deploy de-answer --project-ref rfsvmhcqeiyrxivbmpel
 * or Dashboard → Edge Functions → New Function → name "de-answer" → paste this file.
 * Activate the brain: Project Settings → Edge Functions → Secrets →
 *   ANTHROPIC_API_KEY = <key from console.anthropic.com>
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { embedText } from '../_shared/knowledgeEmbed.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const ESCALATION_THRESHOLD = 60; // confidence below this → human task
const MAX_CONTEXT_CHARS = 6000;
const MODEL = 'claude-sonnet-5';
const CACHE_MAX_DISTANCE = 0.15; // cosine distance for semantic cache hits

// ── Simple keyword-overlap retrieval (last-resort fallback only, when
// hybrid_match_knowledge returns nothing at all — e.g. truly empty KB) ──
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in',
  'on', 'for', 'with', 'my', 'i', 'me', 'can', 'you', 'your', 'do', 'does', 'how', 'what',
  'why', 'when', 'where', 'please', 'need', 'want', 'help', 'about', 'it', 'this', 'that',
]);

function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

interface KDoc { id: string; title: string; content: string; tags: string[]; visibility?: string }

function rankDocs(question: string, docs: KDoc[]): KDoc[] {
  const qTokens = [...new Set(tokenize(question))];
  if (qTokens.length === 0) return docs.slice(0, 3);
  const scored = docs.map((d) => {
    const title = tokenize(d.title);
    const body = tokenize(d.content);
    const tags = (d.tags || []).flatMap((t) => tokenize(t));
    let score = 0;
    for (const q of qTokens) {
      if (title.includes(q)) score += 3;
      if (tags.includes(q)) score += 2;
      score += Math.min(3, body.filter((w) => w === q).length);
    }
    return { d, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.d);
}

// ── Guardrail check (P3, honest v1: case-insensitive pattern match) ──
// Patterns are '|'-separated substrings/regex fragments. Blocking rules
// (blocked_phrase / blocked_topic) that match the ANSWER text block it.
interface GuardrailRule { id: string; rule: string; rule_type: string; pattern: string | null; applies_to: string }

// deno-lint-ignore no-explicit-any
async function checkAnswerGuardrails(admin: any, tenantId: string, answer: string): Promise<GuardrailRule | null> {
  try {
    const { data: rules } = await admin
      .from('guardrail_rules')
      .select('id, rule, rule_type, pattern, applies_to')
      .eq('tenant_id', tenantId)
      .eq('active', true)
      .eq('severity', 'blocking')
      .in('rule_type', ['blocked_phrase', 'blocked_topic']);
    if (!Array.isArray(rules)) return null;
    const text = answer.toLowerCase();
    for (const r of rules as GuardrailRule[]) {
      if (!r.pattern) continue;
      for (const frag of r.pattern.split('|').map((p) => p.trim().toLowerCase()).filter(Boolean)) {
        let hit = false;
        try { hit = new RegExp(frag, 'i').test(answer); } catch { hit = text.includes(frag); }
        if (hit) return r;
      }
    }
    return null;
  } catch (e) {
    console.error('guardrail check failed (fail-open):', e);
    return null;
  }
}

const GUARDRAIL_BLOCK_MESSAGE =
  "I can't help with that — it's outside my guardrails. I've escalated to a human.";

// Append to the tenant's immutable hash-chained audit log (best effort).
// deno-lint-ignore no-explicit-any
async function auditEvent(admin: any, tenantId: string, actor: string, actorType: string, action: string, category: string, detail: Record<string, unknown>) {
  const { error } = await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId, p_actor: actor, p_actor_type: actorType,
    p_action: action, p_category: category, p_detail: detail,
  });
  if (error) console.error('append_audit_event:', error.message);
}

// ── Robust JSON parse of model output ──
interface DEAnswer { answer: string; confidence: number; sources: string[]; needs_escalation: boolean }

function parseModelJson(raw: string): DEAnswer {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const p = JSON.parse(text.slice(start, end + 1));
      return {
        answer: typeof p.answer === 'string' ? p.answer : raw.trim(),
        confidence: Math.max(0, Math.min(100, Math.round(Number(p.confidence)) || 0)),
        sources: Array.isArray(p.sources) ? p.sources.map(String) : [],
        needs_escalation: !!p.needs_escalation,
      };
    } catch { /* fall through */ }
  }
  return { answer: raw.trim(), confidence: 50, sources: [], needs_escalation: false };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { question, conversation_id, de_id } = await req.json();
    if (!question || typeof question !== 'string') {
      return json({ error: 'question required' }, 400);
    }

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
      .from('profiles')
      .select('tenant_id')
      .eq('user_id', userData.user.id)
      .single();
    const tenantId: string | null = profile?.tenant_id ?? null;
    if (!tenantId) return json({ error: 'no_tenant' }, 403);

    const { data: tenant } = await admin
      .from('tenants').select('name').eq('id', tenantId).single();
    const tenantName = tenant?.name ?? 'your company';

    // ── KNOWLEDGE SCOPES (migration 030): resolve the answering DE
    // subject. Optional body.de_id (must be in-tenant); default = the
    // tenant's first DE (the 025/029 fallback pattern). Retrieval RPCs
    // filter scoped docs server-side by this subject.
    let subjectDeId: string | null = null;
    if (typeof de_id === 'string' && de_id) {
      const { data: reqDe } = await admin.from('digital_employees')
        .select('id').eq('id', de_id).eq('tenant_id', tenantId).maybeSingle();
      if (!reqDe) return json({ error: 'de_not_in_tenant' }, 403);
      subjectDeId = reqDe.id;
    } else {
      const { data: firstDe } = await admin.from('digital_employees')
        .select('id').eq('tenant_id', tenantId)
        .order('created_at', { ascending: true }).limit(1).maybeSingle();
      subjectDeId = firstDe?.id ?? null;
    }

    // ── Conversation (create if needed) + persist the user message ──
    let convId: string | null = typeof conversation_id === 'string' ? conversation_id : null;
    if (!convId) {
      const { data: conv } = await admin
        .from('de_conversations')
        .insert({ tenant_id: tenantId, channel: 'dock' })
        .select('id').single();
      convId = conv?.id ?? null;
    }
    if (convId) {
      await admin.from('de_messages').insert({
        tenant_id: tenantId, conversation_id: convId, role: 'user', content: question,
      });
    }

    const bump = (metric: string, delta = 1) =>
      admin.rpc('increment_metric_tenant', { p_tenant_id: tenantId, p_metric: metric, p_delta: delta })
        .then(({ error }) => { if (error) console.error('increment_metric_tenant:', error.message); });

    await bump('inquiries');

    // ── Semantic answer cache (checked BEFORE any LLM call) ──
    const qEmbedding = await embedText(question);
    if (qEmbedding) {
      const { data: cacheRows } = await admin.rpc('match_cached_answer', {
        p_tenant_id: tenantId,
        p_account_id: null,
        p_query_embedding: qEmbedding,
        p_max_distance: CACHE_MAX_DISTANCE,
      });
      const hit = Array.isArray(cacheRows) ? cacheRows[0] : null;
      if (hit) {
        await admin.rpc('increment_metric_tenant', { p_tenant_id: tenantId, p_metric: 'cache_hits', p_delta: 1 });
        // hits++ (best-effort read-modify-write; exactness not required)
        const { data: row } = await admin.from('answer_cache').select('hits').eq('id', hit.id).single();
        await admin.from('answer_cache').update({ hits: (row?.hits ?? 0) + 1 }).eq('id', hit.id);
        const sources: string[] = Array.isArray(hit.sources) ? hit.sources.map(String) : [];
        if (convId) {
          await admin.from('de_messages').insert({
            tenant_id: tenantId, conversation_id: convId, role: 'assistant',
            content: hit.answer, confidence: hit.confidence, escalated: false,
          });
        }
        await admin.from('activity_events').insert({
          tenant_id: tenantId, actor: 'Alex', actor_type: 'de', event_type: 'resolved',
          text: `Answered a chat question instantly from the verified answer cache`,
          confidence: hit.confidence,
        });
        return json({
          conversation_id: convId, answer: hit.answer, confidence: hit.confidence,
          sources, needs_escalation: false, cached: true,
        });
      }
    }

    // ── Retrieval — subject-aware (scoped docs only for listed subjects) ──
    const { data: docs } = await admin.rpc('visible_knowledge_docs', {
      p_tenant_id: tenantId,
      p_subject_kind: subjectDeId ? 'de' : null,
      p_subject_id: subjectDeId,
    });

    if (!docs || docs.length === 0) {
      const answer = "I don't have any knowledge documents yet — upload some in Knowledge → Library and I'll answer from them.";
      if (convId) {
        await admin.from('de_messages').insert({
          tenant_id: tenantId, conversation_id: convId, role: 'assistant',
          content: answer, confidence: 0, escalated: false,
        });
      }
      return json({
        conversation_id: convId, answer, confidence: 0, sources: [],
        needs_escalation: false, no_docs: true,
      });
    }

    // Hybrid retrieval (migration 046): lexical (ts_rank) + semantic
    // (gte-small/pgvector) fused via Reciprocal Rank Fusion — ONE shared
    // RPC used by every knowledge consumer (de-answer, widget-ask,
    // specialist-consult). qEmbedding may be null (Supabase.ai
    // unavailable); the RPC degrades gracefully to lexical-only ranking
    // in that case rather than returning nothing.
    let used = 0;
    const contextParts: string[] = [];
    // Answers derived from SCOPED docs must never enter the tenant-wide
    // answer cache (a later caller could be a different subject).
    let scopedContentUsed = false;
    const { data: chunks, error: matchErr } = await admin.rpc('hybrid_match_knowledge', {
      p_tenant_id: tenantId,
      p_query_text: question,
      p_account_id: null,
      p_query_embedding: qEmbedding,
      p_match_count: 5,
      p_subject_kind: subjectDeId ? 'de' : null,
      p_subject_id: subjectDeId,
    });
    if (matchErr) console.error('hybrid_match_knowledge:', matchErr.message);
    if (Array.isArray(chunks) && chunks.length > 0) {
      for (const c of chunks) {
        const budget = MAX_CONTEXT_CHARS - used;
        if (budget <= 0) break;
        const body = String(c.content ?? '').slice(0, budget);
        const title = c.doc_title ?? 'Knowledge document';
        contextParts.push(`[Document: ${title}]\n${body}`);
        used += body.length + title.length;
        if (c.visibility === 'scoped') scopedContentUsed = true;
      }
    }
    // Last-resort fallback: hybrid RPC failed outright (e.g. transient
    // error) rather than legitimately finding nothing — keyword overlap
    // over the full visible doc set so a real question is never dropped
    // purely because the RPC call itself errored.
    if (contextParts.length === 0 && matchErr) {
      const top = rankDocs(question, docs as KDoc[]);
      for (const d of top) {
        const budget = MAX_CONTEXT_CHARS - used;
        if (budget <= 0) break;
        const body = d.content.slice(0, budget);
        contextParts.push(`[Document: ${d.title}]\n${body}`);
        used += body.length + d.title.length;
        if (d.visibility === 'scoped') scopedContentUsed = true;
      }
    }
    const context = contextParts.length > 0
      ? contextParts.join('\n\n---\n\n')
      : 'No documents matched the question.';

    // ── Claude ──
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) {
      return json({ error: 'llm_not_configured', conversation_id: convId });
    }

    const system = `You are Alex, a Customer Support Digital Employee for ${tenantName}. Answer ONLY from the provided knowledge documents. If the documents don't contain the answer, say so plainly and set confidence low. Always output JSON: {"answer": string, "confidence": 0-100, "sources": [doc titles used], "needs_escalation": boolean}. Confidence reflects how well the documents support the answer. Never invent facts.

Knowledge documents:
${context}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: question }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('Anthropic error', res.status, detail);
      return json({ error: 'llm_error', status: res.status, conversation_id: convId }, 502);
    }
    const data = await res.json();
    const raw: string = data.content?.[0]?.text ?? '';
    const parsed = parseModelJson(raw);
    await bump('llm_calls');

    // ── Guardrail check on the answer text (P3 — blocks + escalates) ──
    const blockedBy = await checkAnswerGuardrails(admin, tenantId, parsed.answer);
    if (blockedBy) {
      const truncated = question.length > 60 ? question.slice(0, 60) + '…' : question;
      if (convId) {
        await admin.from('de_messages').insert({
          tenant_id: tenantId, conversation_id: convId, role: 'assistant',
          content: GUARDRAIL_BLOCK_MESSAGE, confidence: 0, escalated: true,
        });
      }
      await admin.from('human_tasks').insert({
        tenant_id: tenantId,
        type: 'escalation',
        source: 'de',
        title: `Guardrail block — ${truncated}`,
        detail: `Alex's draft answer was blocked by guardrail "${blockedBy.rule}". Draft (confidence ${parsed.confidence}%): ${parsed.answer}`,
        related_table: convId ? 'de_conversations' : null,
        related_id: convId,
      });
      await admin.from('activity_events').insert({
        tenant_id: tenantId, actor: 'Alex', actor_type: 'de', event_type: 'escalated',
        text: `Answer BLOCKED by guardrail "${blockedBy.rule}" — escalated to human review`,
        confidence: parsed.confidence,
      });
      await auditEvent(admin, tenantId, 'Alex', 'de',
        `BLOCKED — chat answer matched guardrail "${blockedBy.rule}" and was withheld; escalated to human`,
        'guardrail_block',
        { rule_id: blockedBy.id, rule: blockedBy.rule, rule_type: blockedBy.rule_type, question: truncated });
      return json({
        conversation_id: convId,
        blocked: true,
        rule: blockedBy.rule,
        answer: GUARDRAIL_BLOCK_MESSAGE,
        confidence: 0,
        sources: [],
        needs_escalation: true,
      });
    }

    const escalate = parsed.needs_escalation || parsed.confidence < ESCALATION_THRESHOLD;

    // ── Semantic cache write (only good, non-escalated answers; never
    // answers built from scoped docs — the cache is tenant-wide) ──
    if (qEmbedding && !escalate && !scopedContentUsed) {
      await admin.from('answer_cache').insert({
        tenant_id: tenantId,
        account_id: null,
        question,
        question_embedding: qEmbedding,
        answer: parsed.answer,
        confidence: parsed.confidence,
        sources: parsed.sources,
      });
    }

    // ── Persist assistant message ──
    if (convId) {
      await admin.from('de_messages').insert({
        tenant_id: tenantId, conversation_id: convId, role: 'assistant',
        content: parsed.answer, confidence: parsed.confidence, escalated: escalate,
      });
    }

    // ── Escalation + activity ──
    if (escalate) {
      await bump('escalations');
      const truncated = question.length > 60 ? question.slice(0, 60) + '…' : question;
      await admin.from('human_tasks').insert({
        tenant_id: tenantId,
        type: 'escalation',
        source: 'de',
        title: `Chat escalation — ${truncated}`,
        detail: `Alex's draft answer (confidence ${parsed.confidence}%): ${parsed.answer}`,
        related_table: convId ? 'de_conversations' : null,
        related_id: convId,
      });
      await admin.from('activity_events').insert({
        tenant_id: tenantId, actor: 'Alex', actor_type: 'de', event_type: 'escalated',
        text: `Chat question escalated to human review — "${truncated}"`,
        confidence: parsed.confidence,
      });
      await auditEvent(admin, tenantId, 'Alex', 'de',
        `Chat question escalated to human review — "${truncated}"`,
        'escalated', { confidence: parsed.confidence, conversation_id: convId });
    } else {
      await admin.from('activity_events').insert({
        tenant_id: tenantId, actor: 'Alex', actor_type: 'de', event_type: 'resolved',
        text: `Answered a chat question from knowledge docs (${parsed.sources.join(', ') || 'no sources cited'})`,
        confidence: parsed.confidence,
      });
      await auditEvent(admin, tenantId, 'Alex', 'de',
        `Resolved a chat question from knowledge docs (${parsed.sources.join(', ') || 'no sources cited'})`,
        'resolved', { confidence: parsed.confidence, conversation_id: convId });
    }

    return json({
      conversation_id: convId,
      answer: parsed.answer,
      confidence: parsed.confidence,
      sources: parsed.sources,
      needs_escalation: escalate,
    });
  } catch (err) {
    console.error('de-answer error:', err);
    return json({ error: String(err) }, 500);
  }
});
