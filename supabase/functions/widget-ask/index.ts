/**
 * widget-ask — PUBLIC end-user chat endpoint for the embeddable widget AND
 * the hosted help-center page. End users are traffic, not seats: no Supabase
 * auth; a publishable widget key (sha256-matched against widget_keys) is the auth.
 *
 * THIS IS INFRASTRUCTURE. Every judgment — grounding, guardrails, confidence,
 * escalation, persona, language, send-vs-draft — belongs to the DE + the
 * Control Fabric. This function contains ZERO canned intelligence: it routes
 * the customer's message to the governed pipeline and PRESENTS what the DE
 * decides. Phase-1 additions are all channel/cost behaviour:
 *   - Cost governor: cache-first (deflects repeat questions at $0 tokens),
 *     per-DE model (Haiku-able), prompt-cached persona, context cap, a
 *     per-conversation turn cap, and the existing tenant AI-budget ceiling.
 *   - Auto-language: the DE detects the customer's language and mirrors it.
 *   - Per-DE send mode (external_reply_mode): 'auto' delivers a confident,
 *     guardrail-clean answer; 'draft' stores it for human approval and shows
 *     the customer a holding message — nothing un-vetted ever reaches them.
 *   - Unified conversation=ticket lifecycle (ai_handling → needs_human → …).
 *
 * Deployed verify_jwt=false. If ANTHROPIC_API_KEY is unset returns
 * {error:'llm_not_configured'} (HTTP 200).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { embedText } from '../_shared/knowledgeEmbed.ts';
import { getAIKey } from '../_shared/aiKeys.ts';
import { resolveDePersona } from '../_shared/dePersona.ts';
import { resolveDeModel, DEFAULT_MODEL } from '../_shared/deModel.ts';
import { loadTenantGate, TENANT_SUSPENDED_BODY } from '../_shared/tenantStatus.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const ESCALATION_THRESHOLD = 60;
const MAX_CONTEXT_CHARS = 6000;
const CACHE_MAX_DISTANCE = 0.05;            // near-verbatim repeats only (mirrors de-answer)
const MAX_MESSAGES_PER_CONVERSATION = 40;   // ~20 turns — cost + abuse guard
const RATE_LIMIT_PER_MIN = 100;

// Per-isolate sliding window: keyId -> timestamps (ms) of recent requests.
const rateWindows = new Map<string, number[]>();
function rateLimited(keyId: string): boolean {
  const now = Date.now();
  const win = (rateWindows.get(keyId) ?? []).filter((t) => now - t < 60_000);
  win.push(now);
  rateWindows.set(keyId, win);
  return win.length > RATE_LIMIT_PER_MIN;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Keyword-overlap retrieval (last-resort fallback only) ──
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in',
  'on', 'for', 'with', 'my', 'i', 'me', 'can', 'you', 'your', 'do', 'does', 'how', 'what',
  'why', 'when', 'where', 'please', 'need', 'want', 'help', 'about', 'it', 'this', 'that',
]);
function tokenize(s: string): string[] {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}
interface KDoc { id: string; title: string; content: string; tags: string[] }
function rankDocs(question: string, docs: KDoc[]): KDoc[] {
  const qTokens = [...new Set(tokenize(question))];
  if (qTokens.length === 0) return docs.slice(0, 3);
  return docs.map((d) => {
    const title = tokenize(d.title), body = tokenize(d.content);
    const tags = (d.tags || []).flatMap((t) => tokenize(t));
    let score = 0;
    for (const q of qTokens) {
      if (title.includes(q)) score += 3;
      if (tags.includes(q)) score += 2;
      score += Math.min(3, body.filter((w) => w === q).length);
    }
    return { d, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((s) => s.d);
}

// ── Guardrail check (blocks + escalates; the DE's rules, not the channel's) ──
interface GuardrailRule { id: string; rule: string; rule_type: string; pattern: string | null; applies_to: string }
// deno-lint-ignore no-explicit-any
async function checkAnswerGuardrails(admin: any, tenantId: string, answer: string, deId: string | null): Promise<GuardrailRule | null> {
  try {
    const { data: rules } = await admin.rpc('guardrail_rules_for_de', {
      p_tenant_id: tenantId, p_de_id: deId, p_rule_types: ['blocked_phrase', 'blocked_topic'],
    });
    if (!Array.isArray(rules)) return null;
    const blocking = (rules as Array<GuardrailRule & { severity?: string }>).filter((r) => r.severity === 'blocking');
    const text = answer.toLowerCase();
    for (const r of blocking as GuardrailRule[]) {
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

const GUARDRAIL_BLOCK_MESSAGE = "I can't help with that — it's outside my guardrails. I've passed it to a human on the team.";

// deno-lint-ignore no-explicit-any
async function auditEvent(admin: any, tenantId: string, actor: string, actorType: string, action: string, category: string, detail: Record<string, unknown>) {
  const { error } = await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId, p_actor: actor, p_actor_type: actorType, p_action: action, p_category: category, p_detail: detail,
  });
  if (error) console.error('append_audit_event:', error.message);
}

interface DEAnswer { answer: string; confidence: number; sources: string[]; needs_escalation: boolean; language: string | null }
function parseModelJson(raw: string): DEAnswer {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const p = JSON.parse(text.slice(start, end + 1));
      return {
        answer: typeof p.answer === 'string' ? p.answer : raw.trim(),
        confidence: Math.max(0, Math.min(100, Math.round(Number(p.confidence)) || 0)),
        sources: Array.isArray(p.sources) ? p.sources.map(String) : [],
        needs_escalation: !!p.needs_escalation,
        language: typeof p.language === 'string' && p.language.trim() ? p.language.trim() : null,
      };
    } catch { /* fall through */ }
  }
  return { answer: raw.trim(), confidence: 50, sources: [], needs_escalation: false, language: null };
}

// Cheap heuristic: does the query look non-English? (char script + a few
// common function words). Used only to decide whether to spend a tiny
// translation call — English queries never pay for it.
function looksNonEnglish(q: string): boolean {
  const letters = q.match(/\p{L}/gu) || [];
  if (letters.length === 0) return false;
  const nonAscii = letters.filter((c) => c.charCodeAt(0) > 127).length;
  if (nonAscii / letters.length > 0.2) return true;
  return /[¿¡]|\b(que|cómo|dónde|cuál|para|hola|gracias|merci|bonjour|comment|où|wie|wo|hallo|danke|você|como|obrigado)\b/i.test(q);
}

// Translate a query to English for RETRIEVAL only (Haiku — cheapest).
// The answer model still gets the original question and mirrors its language.
async function translateForRetrieval(apiKey: string, q: string, model: string): Promise<string> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 200,
        system: 'Translate the user message to English for use as a search query. Output ONLY the translation — no quotes, no notes.',
        messages: [{ role: 'user', content: q }],
      }),
    });
    if (!res.ok) return q;
    const d = await res.json();
    const t = String((d.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '').trim();
    return t || q;
  } catch { return q; }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const widgetKey = body.widget_key;
    if (!widgetKey || typeof widgetKey !== 'string') return json({ error: 'widget_key required' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ── CSAT submission (unchanged; reuses the widget-key auth path) ──
    if (body.action === 'csat') {
      const csatKeyHash = await sha256Hex(widgetKey.trim());
      const { data: csatKeyRow } = await admin.from('widget_keys').select('id, tenant_id').eq('key_hash', csatKeyHash).eq('active', true).maybeSingle();
      if (!csatKeyRow) return json({ error: 'invalid_widget_key' }, 401);
      const csatConvId = typeof body.conversation_id === 'string' ? body.conversation_id : null;
      const csatScore = body.score === 1 || body.score === -1 ? body.score : null;
      if (!csatConvId || csatScore === null) return json({ error: 'conversation_id and score (1 or -1) required' }, 400);
      const { error: csatErr } = await admin.from('de_conversations')
        .update({ csat_score: csatScore, csat_submitted_at: new Date().toISOString() })
        .eq('id', csatConvId).eq('tenant_id', csatKeyRow.tenant_id);
      if (csatErr) return json({ error: 'csat_submit_failed' }, 500);
      return json({ ok: true });
    }

    // ── Poll: the customer widget fetches DELIVERED assistant messages so
    // approved drafts + human (inbox) replies reach it live. Returns all
    // sent assistant messages; the client dedupes by id. ──
    if (body.action === 'poll') {
      const pHash = await sha256Hex(widgetKey.trim());
      const { data: pKey } = await admin.from('widget_keys').select('tenant_id').eq('key_hash', pHash).eq('active', true).maybeSingle();
      if (!pKey) return json({ error: 'invalid_widget_key' }, 401);
      const pConv = typeof body.conversation_id === 'string' ? body.conversation_id : null;
      if (!pConv) return json({ error: 'conversation_id required' }, 400);
      const { data: conv } = await admin.from('de_conversations').select('id, status').eq('id', pConv).eq('tenant_id', pKey.tenant_id).maybeSingle();
      if (!conv) return json({ error: 'conversation_not_found' }, 404);
      const { data: msgs } = await admin.from('de_messages')
        .select('id, content, created_at')
        .eq('conversation_id', pConv).eq('tenant_id', pKey.tenant_id)
        .eq('role', 'assistant').eq('delivery', 'sent')
        .order('created_at', { ascending: true }).limit(50);
      return json({ status: conv.status, messages: (msgs ?? []).map((m: { id: string; content: string; created_at: string }) => ({ id: m.id, content: m.content, created_at: m.created_at })) });
    }

    const question = body.question;
    if (!question || typeof question !== 'string' || !question.trim()) return json({ error: 'question required' }, 400);
    const accountRef = typeof body.account_ref === 'string' ? body.account_ref : null;
    const endUserRef = typeof body.end_user_ref === 'string' ? body.end_user_ref : null;
    const displayName = typeof body.display_name === 'string' ? body.display_name : null;
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : null;
    // This one endpoint serves both the embeddable widget and the hosted page.
    const channel = body.channel === 'hosted' ? 'hosted' : 'widget';
    const nowIso = () => new Date().toISOString();

    // ── Resolve tenant from publishable key ──
    const keyHash = await sha256Hex(widgetKey.trim());
    const { data: keyRow } = await admin.from('widget_keys').select('id, tenant_id').eq('key_hash', keyHash).eq('active', true).maybeSingle();
    if (!keyRow) return json({ error: 'invalid_widget_key' }, 401);
    const tenantId: string = keyRow.tenant_id;

    if (rateLimited(keyRow.id)) return json({ error: 'rate_limited' }, 429);

    try {
      const { data: cur } = await admin.from('widget_keys').select('request_count').eq('id', keyRow.id).single();
      await admin.from('widget_keys').update({ last_used_at: nowIso(), request_count: (cur?.request_count ?? 0) + 1 }).eq('id', keyRow.id);
    } catch { /* non-fatal */ }

    // ── Upsert end-user session ──
    try {
      const { data: existing } = await admin.from('end_user_sessions').select('id')
        .eq('tenant_id', tenantId).eq('account_external_ref', accountRef ?? '').eq('end_user_ref', endUserRef ?? '').maybeSingle();
      if (existing) {
        await admin.from('end_user_sessions').update({ last_seen_at: nowIso(), display_name: displayName ?? undefined }).eq('id', existing.id);
      } else {
        await admin.from('end_user_sessions').insert({ tenant_id: tenantId, account_external_ref: accountRef ?? '', end_user_ref: endUserRef ?? '', display_name: displayName });
      }
    } catch (e) { console.error('session upsert failed (non-fatal)', e); }

    // ── Resolve account by external_ref (tolerate missing column) ──
    let accountName: string | null = null;
    if (accountRef) {
      const { data: acct, error: acctErr } = await admin.from('customer_accounts').select('id, name').eq('tenant_id', tenantId).eq('external_ref', accountRef).maybeSingle();
      if (acctErr) console.warn('account resolve skipped:', acctErr.message);
      else if (acct) accountName = acct.name;
    }

    // ── Trial/suspension gate ──
    const gate = await loadTenantGate(admin, tenantId);
    if (gate.suspended) return json(TENANT_SUSPENDED_BODY, 402);
    const tenantName = gate.name;

    // ── Resolve the answering DE (first eligible) + persona ──
    const { data: firstDe } = await admin.from('digital_employees')
      .select('id, external_reply_mode').eq('tenant_id', tenantId)
      .not('lifecycle_status', 'in', '(paused,retired,archived)')
      .order('created_at', { ascending: true }).limit(1).maybeSingle();
    const subjectDeId: string | null = firstDe?.id ?? null;
    // Per-DE send mode — DE config, the channel just reads it.
    const replyMode: 'draft' | 'auto' = firstDe?.external_reply_mode === 'auto' ? 'auto' : 'draft';
    const persona = await resolveDePersona(admin, tenantId, subjectDeId, tenantName);

    const endUserTag = [displayName, accountRef ? `account ${accountRef}` : null].filter(Boolean).join(' · ');

    // ── Conversation (create with lifecycle fields, or reuse) ──
    let convId: string | null = conversationId;
    let isNewConv = false;
    if (!convId) {
      isNewConv = true;
      const { data: conv, error: convErr } = await admin.from('de_conversations').insert({
        tenant_id: tenantId, channel, de_id: subjectDeId, status: 'ai_handling',
        subject: question.trim().slice(0, 120),
        account_external_ref: accountRef, end_user_ref: endUserRef, end_user_name: displayName,
        last_message_at: nowIso(),
      }).select('id').single();
      if (convErr) console.error('conversation create failed', convErr.message);
      convId = conv?.id ?? null;
    }

    // ── Turn cap: very long threads hand off to a human (cost + abuse guard) ──
    if (convId && !isNewConv) {
      const { count } = await admin.from('de_messages').select('id', { count: 'exact', head: true }).eq('conversation_id', convId);
      if ((count ?? 0) >= MAX_MESSAGES_PER_CONVERSATION) {
        const handoff = "We've covered a lot here — let me bring in a teammate so you get the best help.";
        await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'user', content: `[${channel}] ${question}` });
        await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: handoff, confidence: 0, escalated: true, delivery: 'sent' });
        await admin.from('de_conversations').update({ status: 'needs_human', last_message_at: nowIso() }).eq('id', convId);
        return json({ conversation_id: convId, answer: handoff, confidence: 0, sources: [], needs_escalation: true, status: 'needs_human' });
      }
    }

    if (convId) {
      await admin.from('de_messages').insert({
        tenant_id: tenantId, conversation_id: convId, role: 'user',
        content: endUserTag ? `[${channel} · ${endUserTag}] ${question}` : `[${channel}] ${question}`,
      });
      await admin.from('de_conversations').update({ last_message_at: nowIso() }).eq('id', convId).eq('tenant_id', tenantId);
    }

    // ══════════════════════════════════════════════════════════════
    // finalize(): guardrail → per-DE send gate → persist → payload.
    // Shared by the cache-hit path and the freshly-generated path, so
    // both respect the DE's guardrails and draft/auto-send mode.
    // ══════════════════════════════════════════════════════════════
    const truncatedQ = question.length > 60 ? question.slice(0, 60) + '…' : question;
    const who = endUserTag || 'end user';
    const finalize = async (ans: string, conf: number, srcs: string[], lang: string | null, cached: boolean) => {
      // Guardrail — the DE's rules always win, even on cached answers.
      const blockedBy = await checkAnswerGuardrails(admin, tenantId, ans, subjectDeId);
      if (blockedBy) {
        if (convId) {
          await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: GUARDRAIL_BLOCK_MESSAGE, confidence: 0, escalated: true, delivery: 'blocked', lang });
          await admin.from('de_conversations').update({ status: 'needs_human', handoff_summary: `Guardrail "${blockedBy.rule}" blocked a reply to: ${truncatedQ}`, detected_language: lang, last_message_at: nowIso() }).eq('id', convId);
        }
        await admin.from('human_tasks').insert({ tenant_id: tenantId, type: 'escalation', source: 'de', title: `Guardrail block (${channel} · ${who}) — ${truncatedQ}`, detail: `Answer blocked by guardrail "${blockedBy.rule}". Draft (conf ${conf}%): ${ans}`, related_table: convId ? 'de_conversations' : null, related_id: convId });
        await auditEvent(admin, tenantId, persona.name, 'de', `BLOCKED — ${channel} answer matched guardrail "${blockedBy.rule}"; withheld + escalated`, 'guardrail_block', { rule_id: blockedBy.id, rule: blockedBy.rule, question: truncatedQ, channel });
        return json({ conversation_id: convId, blocked: true, rule: blockedBy.rule, answer: GUARDRAIL_BLOCK_MESSAGE, confidence: 0, sources: [], needs_escalation: true, status: 'needs_human', delivery: 'blocked', language: lang });
      }

      const lowConf = conf < ESCALATION_THRESHOLD;
      // A human is needed when the DE isn't confident (escalation) OR when
      // this DE is in draft mode (every external reply is human-approved).
      if (lowConf || replyMode === 'draft') {
        const handoffSummary = `Customer${accountName ? ` at ${accountName}` : ''} asked: ${truncatedQ}. ${persona.name}'s draft (conf ${conf}%): ${ans.slice(0, 240)}`;
        if (convId) {
          // Store the real draft (NOT delivered to the customer) for the human to approve/edit.
          await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: ans, confidence: conf, escalated: true, delivery: 'draft_pending', lang });
          await admin.from('de_conversations').update({ status: 'needs_human', handoff_summary: handoffSummary, detected_language: lang, last_message_at: nowIso() }).eq('id', convId);
        }
        await admin.from('human_tasks').insert({ tenant_id: tenantId, type: 'escalation', source: 'de', title: `${lowConf ? 'Escalation' : 'Reply to approve'} (${channel} · ${who}) — ${truncatedQ}`, detail: handoffSummary, related_table: convId ? 'de_conversations' : null, related_id: convId });
        await admin.from('activity_events').insert({ tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'escalated', text: `${channel} question from ${who} → ${lowConf ? 'escalated' : 'draft awaiting approval'} — "${truncatedQ}"`, confidence: conf });
        await auditEvent(admin, tenantId, persona.name, 'de', `${channel} question from ${who} → ${lowConf ? 'escalated (low confidence)' : 'draft awaiting human approval'}`, 'escalated', { confidence: conf, conversation_id: convId, channel, mode: replyMode });
        // The customer sees a holding message — never the un-approved draft.
        const holding = lowConf
          ? "Thanks for your patience — I'm bringing a teammate in to make sure you get this right."
          : "Thanks! A team member is reviewing your request and will reply here shortly.";
        return json({ conversation_id: convId, answer: holding, confidence: conf, sources: [], needs_escalation: true, status: 'needs_human', delivery: 'draft_pending', language: lang });
      }

      // Auto-send: confident, guardrail-clean, DE trusted to reply on its own.
      let messageId: string | null = null;
      if (convId) {
        const { data: ins } = await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: ans, confidence: conf, escalated: false, delivery: 'sent', lang }).select('id').single();
        messageId = ins?.id ?? null;
        await admin.from('de_conversations').update({ status: 'ai_handling', detected_language: lang, last_message_at: nowIso() }).eq('id', convId);
      }
      await admin.from('activity_events').insert({ tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'resolved', text: `Answered a ${channel} question${endUserTag ? ` from ${endUserTag}` : ''}${cached ? ' (from cache)' : ''} (${srcs.join(', ') || 'no sources cited'})`, confidence: conf });
      await auditEvent(admin, tenantId, persona.name, 'de', `Resolved a ${channel} question${endUserTag ? ` from ${endUserTag}` : ''}${cached ? ' from cache' : ''}`, 'resolved', { confidence: conf, conversation_id: convId, channel, cached });
      return json({ conversation_id: convId, message_id: messageId, answer: ans, confidence: conf, sources: srcs, needs_escalation: false, status: 'ai_handling', delivery: 'sent', language: lang, cached });
    };

    // ── Cost governor #1: semantic answer cache (BEFORE any LLM call) ──
    // Language guard (bug found live 2026-07-17): gte-small embeddings are
    // multilingual enough that a Spanish-cached answer matched an ENGLISH
    // phrasing of the same question. English askers now match only
    // English/legacy rows (RPC default, migration 164); non-English askers
    // skip the cache entirely — we can cheaply detect "not English" but not
    // WHICH language without a model call, and serving Spanish cache to a
    // French asker is the same bug. They just pay the normal LLM path.
    const qEmbedding = await embedText(question);
    if (qEmbedding && !looksNonEnglish(question)) {
      const { data: cacheRows } = await admin.rpc('match_cached_answer', {
        p_tenant_id: tenantId, p_account_id: null, p_query_embedding: qEmbedding, p_max_distance: CACHE_MAX_DISTANCE,
      });
      const hit = Array.isArray(cacheRows) ? cacheRows[0] : null;
      if (hit) {
        await admin.rpc('increment_metric_tenant', { p_tenant_id: tenantId, p_metric: 'cache_hits', p_delta: 1 });
        const { data: row } = await admin.from('answer_cache').select('hits').eq('id', hit.id).single();
        await admin.from('answer_cache').update({ hits: (row?.hits ?? 0) + 1 }).eq('id', hit.id);
        const srcs: string[] = Array.isArray(hit.sources) ? hit.sources.map(String) : [];
        return await finalize(hit.answer, hit.confidence, srcs, null, true);
      }
    }

    const anthropicKey = await getAIKey(admin, 'ANTHROPIC_API_KEY');
    const model = subjectDeId ? await resolveDeModel(admin, tenantId, subjectDeId) : DEFAULT_MODEL;

    // ── Retrieval (knowledge scopes honoured inside the RPC) ──
    const { data: docs } = await admin.rpc('visible_knowledge_docs', {
      p_tenant_id: tenantId, p_subject_kind: subjectDeId ? 'de' : null, p_subject_id: subjectDeId,
    });
    if (!docs || docs.length === 0) {
      const answer = "I don't have anything to answer from yet — the team is still setting up my knowledge base. Please check back soon.";
      if (convId) await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: answer, confidence: 0, escalated: false, delivery: 'sent' });
      return json({ conversation_id: convId, answer, confidence: 0, sources: [], needs_escalation: false, no_docs: true, status: 'ai_handling' });
    }

    let used = 0;
    const contextParts: string[] = [];
    // Cross-language retrieval: the KB is usually English but the customer may
    // write in any language. Translate the query to English for the SEARCH
    // only (cheap Haiku, non-English queries only); the answer still mirrors
    // the customer's language. English queries pay nothing extra.
    let retrievalText = question;
    let retrievalEmbedding = qEmbedding;
    if (anthropicKey && looksNonEnglish(question)) {
      const translated = await translateForRetrieval(anthropicKey, question, model);
      if (translated && translated !== question) {
        retrievalText = translated;
        retrievalEmbedding = await embedText(translated);
      }
    }
    const { data: chunks, error: matchErr } = await admin.rpc('hybrid_match_knowledge', {
      p_tenant_id: tenantId, p_query_text: retrievalText, p_account_id: null, p_query_embedding: retrievalEmbedding,
      p_match_count: 5, p_subject_kind: subjectDeId ? 'de' : null, p_subject_id: subjectDeId,
    });
    if (matchErr) console.error('hybrid_match_knowledge:', matchErr.message);
    if (Array.isArray(chunks) && chunks.length > 0) {
      for (const c of chunks) {
        const budget = MAX_CONTEXT_CHARS - used;
        if (budget <= 0) break;
        const bodyText = String(c.content ?? '').slice(0, budget);
        const title = c.doc_title ?? 'Knowledge document';
        contextParts.push(`[Document: ${title}]\n${bodyText}`);
        used += bodyText.length + title.length;
      }
    }
    if (contextParts.length === 0 && matchErr) {
      for (const d of rankDocs(question, docs as KDoc[])) {
        const budget = MAX_CONTEXT_CHARS - used;
        if (budget <= 0) break;
        const bodyText = d.content.slice(0, budget);
        contextParts.push(`[Document: ${d.title}]\n${bodyText}`);
        used += bodyText.length + d.title.length;
      }
    }
    const context = contextParts.length > 0 ? contextParts.join('\n\n---\n\n') : 'No documents matched the question.';

    // ── LLM (cost governor #2: budget ceiling; #3: prompt-cached persona) ──
    // anthropicKey was resolved above (also used for cross-language retrieval).
    if (!anthropicKey) return json({ error: 'llm_not_configured', conversation_id: convId });
    const { data: budgetCheck } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
    if (budgetCheck && budgetCheck.allowed === false) return json({ error: 'ai_budget_exceeded', conversation_id: convId });

    const audience = accountName
      ? `You are answering an end user (${displayName || 'an employee'}) at customer account "${accountName}".`
      : `You are answering an end user${displayName ? ` (${displayName})` : ''} of a business customer.`;
    // The persona + fixed instructions are stable across turns → prompt-cached.
    const instructionBlock = `${persona.preamble} ${audience} Answer ONLY from the provided knowledge documents. If the documents don't contain the answer, say so plainly and set confidence low. Detect the language of the user's message and write your ENTIRE answer in that same language. Always output JSON: {"answer": string, "confidence": 0-100, "sources": [doc titles used], "needs_escalation": boolean, "language": string}. "language" is the language you wrote the answer in (e.g. "English", "Spanish"). Confidence reflects how well the documents support the answer. Never invent facts.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 1024,
        system: [
          { type: 'text', text: instructionBlock, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `Knowledge documents:\n${context}` },
        ],
        messages: [{ role: 'user', content: question }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('Anthropic error', res.status, detail);
      return json({ error: 'llm_error', status: res.status, conversation_id: convId }, 502);
    }
    const data = await res.json();
    const raw: string = (data.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '';
    const parsed = parseModelJson(raw);
    if (subjectDeId) {
      admin.rpc('record_de_token_usage', {
        p_tenant_id: tenantId, p_de_id: subjectDeId, p_model_id: model,
        p_input_tokens: data.usage?.input_tokens ?? 0, p_output_tokens: data.usage?.output_tokens ?? 0,
      }).then(({ error }: { error: unknown }) => { if (error) console.error('record_de_token_usage:', error); });
    }

    // Cache write: only confident, guardrail-clean answers (a later repeat is
    // deflected at $0). Draft-mode is a DELIVERY policy, not answer quality —
    // so we still cache the answer; the gate in finalize() decides delivery.
    if (qEmbedding && parsed.confidence >= ESCALATION_THRESHOLD && !parsed.needs_escalation) {
      const clean = await checkAnswerGuardrails(admin, tenantId, parsed.answer, subjectDeId);
      if (!clean) {
        await admin.from('answer_cache').insert({
          tenant_id: tenantId, account_id: null, question,
          question_embedding: qEmbedding, answer: parsed.answer, confidence: parsed.confidence, sources: parsed.sources,
          // Tag the ANSWER's language (model-reported) so the language gate
          // in match_cached_answer can keep languages apart (migration 164).
          language: parsed.language ?? 'English',
        });
      }
    }

    return await finalize(parsed.answer, parsed.confidence, parsed.sources, parsed.language, false);
  } catch (err) {
    console.error('widget-ask error:', err);
    return json({ error: String(err) }, 500);
  }
});
