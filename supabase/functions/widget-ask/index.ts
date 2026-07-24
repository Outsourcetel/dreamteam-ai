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
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { embedText } from '../_shared/knowledgeEmbed.ts';
import { getAIKey } from '../_shared/aiKeys.ts';
import { hasLLMProvider, llmMessages } from '../_shared/llm.ts';
import { durableRateLimited, clientIp } from '../_shared/rateLimit.ts';
import { resolveDePersona } from '../_shared/dePersona.ts';
import { resolveDeModel, DEFAULT_MODEL } from '../_shared/deModel.ts';
import { loadTenantGate, TENANT_SUSPENDED_BODY } from '../_shared/tenantStatus.ts';
import { wrapUntrusted, FIREWALL_RULES } from '../_shared/injectionSafety.ts';
import { semanticGate, loadBlockingRulesForJudge, semanticGuardrailScreen } from '../_shared/guardrailJudge.ts';
import { groundedConfidence } from '../_shared/groundedConfidence.ts';
import { evaluateEscalation, type EscRuleset } from '../_shared/escalation.ts';
import { recallIdentityMemory, rememberIdentity, type IdentityVerdict } from '../_shared/identityMemory.ts';

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

// Pure matcher — shared by the JSON path, the streaming flush loop, and the
// final re-check so all three apply IDENTICAL blocking logic.
function matchBlockingRule(blocking: GuardrailRule[], answer: string): GuardrailRule | null {
  const text = answer.toLowerCase();
  for (const r of blocking) {
    if (!r.pattern) continue;
    for (const frag of r.pattern.split('|').map((p) => p.trim().toLowerCase()).filter(Boolean)) {
      let hit = false;
      try { hit = new RegExp(frag, 'i').test(answer); } catch { hit = text.includes(frag); }
      if (hit) return r;
    }
  }
  return null;
}

// deno-lint-ignore no-explicit-any
// Returns the blocking rule set, or NULL when the resolver itself failed (so
// callers can fail CLOSED — we can't prove an answer was screened).
async function loadBlockingRules(admin: any, tenantId: string, deId: string | null): Promise<GuardrailRule[] | null> {
  try {
    const { data: rules } = await admin.rpc('guardrail_rules_for_de', {
      p_tenant_id: tenantId, p_de_id: deId, p_rule_types: ['blocked_phrase', 'blocked_topic'],
    });
    if (!Array.isArray(rules)) return null;   // screening didn't run → fail closed
    return (rules as Array<GuardrailRule & { severity?: string }>).filter((r) => r.severity === 'blocking');
  } catch (e) {
    // Production-readiness audit: was fail-OPEN (returned [] → answer released).
    // Now fail-CLOSED (null → caller withholds + escalates); incident still logged.
    console.error('guardrail check failed (fail-closed → escalating):', e);
    try {
      await admin.from('de_incidents').insert({
        tenant_id: tenantId, de_id: deId, kind: 'guardrail_block', severity: 'critical',
        title: 'Guardrail check FAILED — widget answer withheld and escalated (fail-closed)',
        detail: { error: String((e as Error)?.message ?? e).slice(0, 400), path: 'widget-ask' },
        source_table: 'guardrail_rules', source_id: null, occurred_at: new Date().toISOString(),
      });
    } catch { /* best-effort */ }
    return null;
  }
}

// Fail-CLOSED sentinel: resolver error/unavailable → treat as blocked → escalate.
const GUARDRAIL_RESOLVER_ERROR: GuardrailRule = { id: '__resolver_error__', rule: 'answer screening unavailable', rule_type: 'resolver_error', pattern: null, applies_to: 'answer' };

// deno-lint-ignore no-explicit-any
async function checkAnswerGuardrails(admin: any, tenantId: string, answer: string, deId: string | null): Promise<GuardrailRule | null> {
  const blocking = await loadBlockingRules(admin, tenantId, deId);
  if (blocking === null) return GUARDRAIL_RESOLVER_ERROR;   // can't prove screening ran → block + escalate
  return matchBlockingRule(blocking, answer);
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
async function translateForRetrieval(admin: SupabaseClient, q: string, model: string): Promise<string> {
  try {
    const res = await llmMessages(admin, {
      model, max_tokens: 200,
      system: 'Translate the user message to English for use as a search query. Output ONLY the translation — no quotes, no notes.',
      messages: [{ role: 'user', content: q }],
    }, 'widget-ask:translate');
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
    const userHash = typeof body.user_hash === 'string' ? body.user_hash : null;   // T2.3 identity proof (widget HMAC)
    // This one endpoint serves both the embeddable widget and the hosted page.
    const channel = body.channel === 'hosted' ? 'hosted' : 'widget';
    const nowIso = () => new Date().toISOString();

    // ── Resolve tenant from publishable key ──
    const keyHash = await sha256Hex(widgetKey.trim());
    const { data: keyRow } = await admin.from('widget_keys').select('id, tenant_id, de_id').eq('key_hash', keyHash).eq('active', true).maybeSingle();
    if (!keyRow) return json({ error: 'invalid_widget_key' }, 401);
    const tenantId: string = keyRow.tenant_id;
    // mig 323: this key may name the employee that answers it. Without it the
    // front-DE heuristic below picks the OLDEST eligible DE, which is how a
    // customer chat ends up with an arbitrary employee instead of the intended one.
    const keyBoundDeId: string | null = (keyRow as { de_id?: string | null }).de_id ?? null;

    // In-memory check = free first line; the durable DB counter is the
    // authoritative limit (survives isolate recycling + deploys) with a
    // tighter per-IP bucket to stop single-source floods (mig 198).
    if (rateLimited(keyRow.id)) return json({ error: 'rate_limited' }, 429);
    if (await durableRateLimited(admin, `widget:${keyRow.id}`, RATE_LIMIT_PER_MIN)) {
      return json({ error: 'rate_limited' }, 429);
    }
    const ip = clientIp(req);
    if (ip && (await durableRateLimited(admin, `widget:${keyRow.id}:${ip}`, 30))) {
      return json({ error: 'rate_limited' }, 429);
    }

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
    // Front DE for the public widget: a DE explicitly set to auto-answer
    // customers outranks draft-mode internal DEs, and 'designed' (never
    // published) DEs never front customer chat. Falls back to the oldest
    // eligible DE — same behavior as before for tenants with one DE.
    const { data: frontDes } = await admin.from('digital_employees')
      .select('id, external_reply_mode, lifecycle_status, created_at').eq('tenant_id', tenantId)
      .not('lifecycle_status', 'in', '(paused,retired,archived,designed)')
      .order('created_at', { ascending: true }).limit(20);
    // mig 323: an explicit key→employee binding WINS. It is only honoured when
    // that employee is still eligible (not paused/retired/archived/designed), so a
    // retired DE can never keep fronting customer chat; otherwise fall back to the
    // old heuristic, which keeps every pre-existing key behaving exactly as before.
    const boundDe = keyBoundDeId ? (frontDes ?? []).find((d) => d.id === keyBoundDeId) ?? null : null;
    const firstDe = boundDe ?? (frontDes ?? []).find((d) => d.external_reply_mode === 'auto') ?? (frontDes ?? [])[0] ?? null;
    const subjectDeId: string | null = firstDe?.id ?? null;
    // Per-DE send mode — DE config, the channel just reads it.
    const replyMode: 'draft' | 'auto' = firstDe?.external_reply_mode === 'auto' ? 'auto' : 'draft';
    const persona = await resolveDePersona(admin, tenantId, subjectDeId, tenantName);

    // Wave-1 activation (truth audit 2026-07-22, docs/15): the founder-set
    // trust-dial floor (answer_widget) and escalation rules now govern this
    // LIVE channel — previously only the autonomous triage path read them
    // and this path ran a hardcoded threshold.
    let confidenceFloor: number = ESCALATION_THRESHOLD;
    let escalationRuleHit: string | null = null;
    let escRuleset: EscRuleset = {};   // mig 262: generic condition ruleset
    try {
      const [dialRes, escRes, rowsRes] = await Promise.all([
        admin.rpc('resolve_de_autonomy', { p_tenant_id: tenantId, p_action_type: 'answer_widget', p_de_id: subjectDeId, p_source_category: null }),
        admin.rpc('resolve_de_escalation', { p_tenant_id: tenantId, p_de_id: subjectDeId }),
        admin.from('de_escalation_rules').select('custom_rules, de_id').eq('tenant_id', tenantId),
      ]);
      const dial = Array.isArray(dialRes.data) ? dialRes.data[0] : dialRes.data;
      if (dial?.enabled === false) confidenceFloor = 101;                 // dial off → every reply goes to a human
      else if (typeof dial?.min_confidence === 'number') confidenceFloor = dial.min_confidence;
      const esc = Array.isArray(escRes.data) ? escRes.data[0] : escRes.data;
      const rows = (rowsRes.data ?? []).filter((r) => r.de_id === subjectDeId || r.de_id === null);
      escRuleset = {
        frustration_threshold: esc?.frustration_threshold ?? null,
        always_escalate_topics: (esc?.always_escalate_topics ?? []) as string[],
        de_rules: rows.filter((r) => r.de_id === subjectDeId).flatMap((r) => Array.isArray(r.custom_rules) ? r.custom_rules : []),
        tenant_rules: rows.filter((r) => r.de_id === null).flatMap((r) => Array.isArray(r.custom_rules) ? r.custom_rules : []),
      };
      // Pre-answer: topics + text conditions (the message is all we have yet).
      const pre = evaluateEscalation(escRuleset, { message_text: String(question ?? '') });
      if (pre.escalate) escalationRuleHit = pre.rule ?? 'escalation rule';
    } catch { /* resolver hiccup → keep the prior default behavior */ }

    const endUserTag = [displayName, accountRef ? `account ${accountRef}` : null].filter(Boolean).join(' · ');

    // ── Conversation (create with lifecycle fields, or reuse) ──
    // A supplied conversation_id must belong to THIS widget key's tenant —
    // otherwise a leaked/guessed UUID lets an attacker append messages into
    // another tenant's conversation (external review 2026-07-20, P1-6).
    let convId: string | null = conversationId;
    if (convId) {
      const { data: owned } = await admin
        .from('de_conversations')
        .select('id')
        .eq('id', convId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!owned) return json({ error: 'conversation_not_found' }, 404);
    }
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

    // ── T2.3: per-turn identity verification (widget HMAC, migs 275-277). The
    // returned verdict — NOT the stored de_conversations row — is the sole gate
    // for cross-conversation memory this request (a reused convId or forged
    // caller must never inherit a verified thread's identity). No secret
    // configured / bad hash / blank ref / identity_conflict → {verified:false}. ──
    let identityVerdict: IdentityVerdict | null = null;
    if (convId && userHash) {
      try {
        const { data: vr } = await admin.rpc('verify_and_bind_widget_identity', {
          p_widget_key_id: keyRow.id, p_conversation_id: convId,
          p_end_user_ref: endUserRef, p_account_ref: accountRef, p_user_hash: userHash,
        });
        identityVerdict = (vr ?? null) as IdentityVerdict | null;
      } catch (e) { console.error('verify_and_bind_widget_identity:', String(e)); }
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
    // finalizeCore returns the response PAYLOAD (not a Response) so the
    // streaming path can run the identical pipeline and emit it as an SSE
    // `final`/`blocked` event; finalize() wraps it for the JSON path.
    // GI-8: resolve the semantic gate ONCE — used by finalizeCore's screen AND to
    // force a semantic-enabled tenant off the token-stream (the judge cannot run
    // per-token, so it must clear before the first byte → buffer instead).
    const semGate = await semanticGate(admin, tenantId);
    // §5 grounded confidence — resolve gating ONCE (master read short-circuits when
    // off). Used to blend min(self, grounded) into the answer's confidence, and to
    // force a participating tenant off the token-stream: in enforce the grounded
    // value must clear BEFORE any bytes reach the customer, which only the buffered
    // path can guarantee (same reasoning as the semantic guardrail above).
    let gcActive = false, gcEnforce = false, gcMode = 'shadow';
    try {
      const { data: gcMasterRow } = await admin.from('platform_config').select('value').eq('key', 'grounded_confidence.enabled').maybeSingle();
      if (String((gcMasterRow as { value?: string } | null)?.value ?? '') === 'true') {
        const [gcModeRow, gcFlag, gcVal] = await Promise.all([
          admin.from('platform_config').select('value').eq('key', 'grounded_confidence.mode').maybeSingle(),
          admin.rpc('is_feature_enabled_internal', { p_tenant_id: tenantId, p_feature_key: 'grounded_confidence' }),
          admin.from('grounded_confidence_validation').select('tenant_id').eq('tenant_id', tenantId).maybeSingle(),
        ]);
        if (gcFlag.data === true) {
          gcActive = true;
          gcMode = String((gcModeRow.data as { value?: string } | null)?.value ?? '') || 'shadow';
          gcEnforce = (gcMode === 'blended' || gcMode === 'grounded') && !!gcVal.data;
        }
      }
    } catch (e) { console.error('grounded confidence gate:', e); }   // fail-open to self-report
    // deno-lint-ignore no-explicit-any
    const screenAnswer = async (ans: string, deId: string | null): Promise<GuardrailRule | null> => {
      const regexHit = await checkAnswerGuardrails(admin, tenantId, ans, deId);
      if (regexHit) return regexHit;
      if (!semGate.enabled) return null;
      const rules = await loadBlockingRulesForJudge(admin, tenantId, deId);
      if (rules === null) return GUARDRAIL_RESOLVER_ERROR;   // fail closed
      return (await semanticGuardrailScreen(admin, { tenantId, deId, surface: 'answer', content: ans, blockingRules: rules, mode: semGate.mode! })) as GuardrailRule | null;
    };
    const finalizeCore = async (ans: string, conf: number, srcs: string[], lang: string | null, cached: boolean): Promise<Record<string, unknown>> => {
      // Guardrail — regex first-pass then the semantic judge; the DE's rules always
      // win, even on cached answers. Fail-closed.
      const blockedBy = await screenAnswer(ans, subjectDeId);
      if (blockedBy) {
        if (convId) {
          await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: GUARDRAIL_BLOCK_MESSAGE, confidence: 0, escalated: true, delivery: 'blocked', lang });
          await admin.from('de_conversations').update({ status: 'needs_human', handoff_summary: `Guardrail "${blockedBy.rule}" blocked a reply to: ${truncatedQ}`, detected_language: lang, last_message_at: nowIso() }).eq('id', convId);
        }
        await admin.from('human_tasks').insert({ tenant_id: tenantId, type: 'escalation', source: 'de', title: `Guardrail block (${channel} · ${who}) — ${truncatedQ}`, detail: `Answer blocked by guardrail "${blockedBy.rule}". Draft (conf ${conf}%): ${ans}`, related_table: convId ? 'de_conversations' : null, related_id: convId });
        await auditEvent(admin, tenantId, persona.name, 'de', `BLOCKED — ${channel} answer matched guardrail "${blockedBy.rule}"; withheld + escalated`, 'guardrail_block', { rule_id: blockedBy.id, rule: blockedBy.rule, question: truncatedQ, channel });
        // Outcome metering (#15): a guardrail block hands off to a human — FREE.
        if (convId) await admin.rpc('record_billable_outcome', { p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId, p_kind: 'escalation', p_source: 'widget' });
        return { conversation_id: convId, blocked: true, rule: blockedBy.rule, answer: GUARDRAIL_BLOCK_MESSAGE, confidence: 0, sources: [], needs_escalation: true, status: 'needs_human', delivery: 'blocked', language: lang };
      }

      const lowConf = conf < confidenceFloor;
      // Post-answer: re-evaluate with confidence known so conditions on
      // confidence (not just text) can fire.
      if (!escalationRuleHit) {
        const post = evaluateEscalation(escRuleset, { message_text: String(question ?? ''), confidence: conf });
        if (post.escalate) escalationRuleHit = post.rule ?? 'escalation rule';
      }
      // A human is needed when the DE isn't confident (escalation), when a
      // founder-set escalation rule matches the question, OR when this DE is
      // in draft mode (every external reply is human-approved).
      if (lowConf || escalationRuleHit !== null || replyMode === 'draft') {
        const ruleNote = escalationRuleHit ? ` Matched ${escalationRuleHit}.` : '';
        const handoffSummary = `Customer${accountName ? ` at ${accountName}` : ''} asked: ${truncatedQ}.${ruleNote} ${persona.name}'s draft (conf ${conf}%): ${ans.slice(0, 240)}`;
        if (convId) {
          // Store the real draft (NOT delivered to the customer) for the human to approve/edit.
          await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: ans, confidence: conf, escalated: true, delivery: 'draft_pending', lang });
          await admin.from('de_conversations').update({ status: 'needs_human', handoff_summary: handoffSummary, detected_language: lang, last_message_at: nowIso() }).eq('id', convId);
        }
        await admin.from('human_tasks').insert({ tenant_id: tenantId, de_id: subjectDeId, type: 'escalation', source: 'de', title: `${(lowConf || escalationRuleHit) ? 'Escalation' : 'Reply to approve'} (${channel} · ${who}) — ${truncatedQ}`, detail: handoffSummary, related_table: convId ? 'de_conversations' : null, related_id: convId });
        await admin.from('activity_events').insert({ tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'escalated', text: `${channel} question from ${who} → ${(lowConf || escalationRuleHit) ? 'escalated' : 'draft awaiting approval'} — "${truncatedQ}"`, confidence: conf });
        await auditEvent(admin, tenantId, persona.name, 'de', `${channel} question from ${who} → ${escalationRuleHit ? `escalated (${escalationRuleHit})` : lowConf ? 'escalated (low confidence)' : 'draft awaiting human approval'}`, 'escalated', { confidence: conf, conversation_id: convId, channel, mode: replyMode });
        // W4-D (docs/16, mig 252): a widget miss with no knowledge grounding
        // now feeds the self-healing gap loop (previously blind to this channel).
        if (lowConf && srcs.length === 0) {
          try {
            const { data: er } = await admin.from('evidence_runs').insert({
              tenant_id: tenantId, de_id: subjectDeId, inquiry: String(question ?? '').slice(0, 2000),
              status: 'complete', steps: [], answer_status: 'answered',
              confidence_inputs: { knowledge_hits: 0 },
            }).select('id').single();
            if (er?.id) {
              await admin.from('evidence_run_decisions').insert({
                tenant_id: tenantId, evidence_run_id: er.id, source: 'live_channel',
                decision: 'needs_review', confidence: conf, source_category: 'support',
              });
            }
          } catch (e) { console.error('gap bridge (widget):', e); }
        }
        // Outcome metering (#15): human takes over — FREE.
        if (convId) await admin.rpc('record_billable_outcome', { p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId, p_kind: 'escalation', p_source: 'widget' });
        // The customer sees a holding message — never the un-approved draft.
        const holding = lowConf
          ? "Thanks for your patience — I'm bringing a teammate in to make sure you get this right."
          : "Thanks! A team member is reviewing your request and will reply here shortly.";
        return { conversation_id: convId, answer: holding, confidence: conf, sources: [], needs_escalation: true, status: 'needs_human', delivery: 'draft_pending', language: lang };
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
      // Outcome metering (#15): an auto-sent, guardrail-clean answer is the
      // billable RESOLUTION (per-conversation idempotent, escalations free).
      if (convId) await admin.rpc('record_billable_outcome', { p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId, p_kind: 'resolution', p_source: 'widget' });
      // T2.3: persist a durable memory for the VERIFIED caller (no-op unless this
      // turn was verified). The Q&A pair is the remembered interaction.
      await rememberIdentity(admin, {
        tenantId, deId: subjectDeId, embedding: qEmbedding, verdict: identityVerdict,
        content: `Q: ${question.trim().slice(0, 300)}\nA: ${ans.slice(0, 500)}`,
        kind: 'episodic', salience: 0.5, source: 'de',   // de_memory CHECK: kind∈{episodic,semantic,fact,preference}, source∈{de,human,system,ingestion}
      });
      return { conversation_id: convId, message_id: messageId, answer: ans, confidence: conf, sources: srcs, needs_escalation: false, status: 'ai_handling', delivery: 'sent', language: lang, cached, identity_verified: identityVerdict?.verified ?? false };
    };
    const finalize = async (ans: string, conf: number, srcs: string[], lang: string | null, cached: boolean) =>
      json(await finalizeCore(ans, conf, srcs, lang, cached));

    // ── Cost governor #1: semantic answer cache (BEFORE any LLM call) ──
    // Language guard (bug found live 2026-07-17): gte-small embeddings are
    // multilingual enough that a Spanish-cached answer matched an ENGLISH
    // phrasing of the same question. English askers now match only
    // English/legacy rows (RPC default, migration 164); non-English askers
    // skip the cache entirely — we can cheaply detect "not English" but not
    // WHICH language without a model call, and serving Spanish cache to a
    // French asker is the same bug. They just pay the normal LLM path.
    const qEmbedding = await embedText(question);
    // A VERIFIED caller skips the tenant-wide (account_id:null) cache entirely:
    // their answer may be personalized by recalled identity memory, so it must
    // neither be served from nor written to the shared cache (cross-caller leak).
    if (qEmbedding && !looksNonEnglish(question) && !identityVerdict?.verified) {
      const { data: cacheRows } = await admin.rpc('match_cached_answer', {
        p_tenant_id: tenantId, p_account_id: null, p_query_embedding: qEmbedding, p_max_distance: CACHE_MAX_DISTANCE, p_de_id: subjectDeId,
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

    // anthropicKey now serves ONLY the SSE streaming path (the provider
    // chain is buffered); hasLLM gates everything else via the shared client.
    const anthropicKey = await getAIKey(admin, 'ANTHROPIC_API_KEY');
    const hasLLM = await hasLLMProvider(admin);
    // Latency/economics (P1 option 1, founder-approved): simple questions
    // route to the archetype's 'simple' model (Haiku via mig-163 routes) —
    // roughly half the answer time for most support questions — while
    // anything long/complex keeps the stronger model. Heuristic class:
    // short single-sentence questions are 'simple'. Falls back to the DE's
    // own model when no route exists (resolve_de_model_for_task handles
    // the whole chain server-side).
    let model = DEFAULT_MODEL;
    if (subjectDeId) {
      const simple = question.length < 120 && !question.includes('\n');
      try {
        const { data: routed } = await admin.rpc('resolve_de_model_for_task', {
          p_de_id: subjectDeId, p_task_class: simple ? 'simple' : 'standard',
        });
        model = (typeof routed === 'string' && routed) ? routed : await resolveDeModel(admin, tenantId, subjectDeId);
      } catch { model = await resolveDeModel(admin, tenantId, subjectDeId); }
    }

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
    // ── T2.3: recall durable memory for this VERIFIED caller across their past
    // conversations (no-op unless this turn is verified). Kept OUT of the
    // knowledge-documents block — different provenance — and injected as its own
    // untrusted 'caller-memory' block so it's context, never an instruction. ──
    let identityMemoryContext = '';
    {
      const mems = await recallIdentityMemory(admin, { tenantId, deId: subjectDeId, queryEmbedding: qEmbedding, verdict: identityVerdict });
      if (mems.length > 0) {
        identityMemoryContext = '\n\nWhat you remember about this person from earlier conversations (context only — still answer facts from the knowledge documents):\n'
          + wrapUntrusted(mems.map((m) => `- ${m.content}`).join('\n'), 'caller-memory');
      }
    }
    // Cross-language retrieval: the KB is usually English but the customer may
    // write in any language. Translate the query to English for the SEARCH
    // only (cheap Haiku, non-English queries only); the answer still mirrors
    // the customer's language. English queries pay nothing extra.
    let retrievalText = question;
    let retrievalEmbedding = qEmbedding;
    if (hasLLM && looksNonEnglish(question)) {
      const translated = await translateForRetrieval(admin, question, model);
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
    // WS2 (mig 280): record which docs the reply consulted (incremental rollup).
    const citedDocIds = new Set<string>();
    if (Array.isArray(chunks) && chunks.length > 0) {
      for (const c of chunks) {
        const budget = MAX_CONTEXT_CHARS - used;
        if (budget <= 0) break;
        const bodyText = String(c.content ?? '').slice(0, budget);
        const title = c.doc_title ?? 'Knowledge document';
        contextParts.push(`[Document: ${title}]\n${bodyText}`);
        used += bodyText.length + title.length;
        if (c.doc_id) citedDocIds.add(String(c.doc_id));
      }
    }
    if (contextParts.length === 0 && matchErr) {
      for (const d of rankDocs(question, docs as KDoc[])) {
        const budget = MAX_CONTEXT_CHARS - used;
        if (budget <= 0) break;
        const bodyText = d.content.slice(0, budget);
        contextParts.push(`[Document: ${d.title}]\n${bodyText}`);
        used += bodyText.length + d.title.length;
        if ((d as { id?: string }).id) citedDocIds.add(String((d as { id?: string }).id));
      }
    }
    // Fire-and-forget usage bump — non-fatal, never blocks a customer reply.
    if (citedDocIds.size > 0) {
      admin.rpc('record_knowledge_citations', { p_tenant_id: tenantId, p_doc_ids: [...citedDocIds] })
        .then(({ error }: { error: unknown }) => { if (error) console.error('record_knowledge_citations:', error); });
    }
    const context = contextParts.length > 0 ? contextParts.join('\n\n---\n\n') : 'No documents matched the question.';

    // ── LLM (cost governor #2: budget ceiling; #3: prompt-cached persona) ──
    if (!hasLLM) return json({ error: 'llm_not_configured', conversation_id: convId });
    const { data: budgetCheck } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
    if (budgetCheck && budgetCheck.allowed === false) return json({ error: 'ai_budget_exceeded', conversation_id: convId });

    const audience = accountName
      ? `You are answering an end user (${displayName || 'an employee'}) at customer account "${accountName}".`
      : `You are answering an end user${displayName ? ` (${displayName})` : ''} of a business customer.`;

    // ══════════════════════════════════════════════════════════════
    // STREAMING PATH (SSE) — opt-in via body.stream, AUTO-SEND DEs only.
    // Draft-mode DEs NEVER stream (the customer must only ever see the
    // holding message, enforced by the replyMode gate in finalizeCore),
    // and every earlier return (cache hit, turn cap, no_docs, errors)
    // already answered on the JSON path — which stays byte-for-byte
    // unchanged for widget.js v2.
    //
    // Protocol emitted:
    //   `event: delta`   {text}                — complete sentences only
    //   `event: blocked` {…same payload as the JSON blocked result}
    //   `event: final`   {…same payload as the JSON success result}
    //   `event: error`   {error}               — client falls back to JSON
    // Safety: blocking rules fetched ONCE at stream start; before EVERY
    // flush the FULL accumulated text is re-checked (zero chunk-boundary
    // risk); a hold-back of max(120, longest blocking pattern) chars plus
    // a ###META### partial-prefix guard means no complete blocked span —
    // and no metadata fragment — is ever emitted to the customer.
    // ══════════════════════════════════════════════════════════════
    // A founder escalation-rule match must never stream to the customer —
    // fall through to the non-streaming path, which routes it to a human.
    // Streaming needs the direct Anthropic key (SSE passthrough); without it
    // the request falls through to the buffered path and the provider chain.
    // GI-8: a semantic-enabled tenant (shadow OR enforce) must NOT token-stream — the
    // judge has to clear BEFORE the first byte, which only the buffered finalizeCore
    // path can guarantee. !semGate.enabled forces those tenants to buffer.
    const streamRules = (body.stream === true && replyMode === 'auto' && !escalationRuleHit && anthropicKey && !semGate.enabled && !gcActive)
      ? await loadBlockingRules(admin, tenantId, subjectDeId) : [];
    // If screening rules can't load, do NOT stream unscreened — fall through to the
    // buffered path, whose checkAnswerGuardrails fails closed (blocks + escalates).
    if (body.stream === true && replyMode === 'auto' && !escalationRuleHit && anthropicKey && !semGate.enabled && !gcActive && streamRules !== null) {
      const blockingRules = streamRules;
      const HOLD_BACK = Math.max(120, ...blockingRules.map((r) => (r.pattern ?? '').length));
      const META = '###META###';

      // Prose-first protocol: plain-text answer, then META marker + JSON tail.
      const streamInstructionBlock = `${persona.preamble} ${audience} Answer ONLY from the provided knowledge documents. If the documents don't contain the answer, say so plainly and report low confidence in the metadata. Detect the language of the user's message and write your ENTIRE answer in that same language. Write the answer as plain text — NOT as JSON. Then, on a new final line, output exactly ${META} immediately followed by a JSON object: {"confidence": 0-100, "sources": [doc titles used], "needs_escalation": boolean, "language": string}. "language" is the language you wrote the answer in (e.g. "English", "Spanish"). Confidence reflects how well the documents support the answer. Never invent facts. If the message is conversational rather than a question — a greeting, thanks, an apology, small talk, or an expression of frustration — reply naturally and briefly in your own voice without needing a document: set sources to [] and confidence to 100, because a pleasantry is not a knowledge gap. Decide needs_escalation on whether a human is genuinely needed (an upset or blocked customer usually is), never on whether documents happened to match.`;

      const llmRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 1024, stream: true,
          system: [
            { type: 'text', text: streamInstructionBlock, cache_control: { type: 'ephemeral' } },
            // Injection firewall (#9): doc content is marked untrusted +
            // breakout-neutralized; the standing rules sit OUTSIDE the block.
            { type: 'text', text: `Knowledge documents:\n${wrapUntrusted(context, 'knowledge-documents')}${identityMemoryContext}${FIREWALL_RULES}` },
          ],
          messages: [{ role: 'user', content: question }],
        }),
      });
      if (!llmRes.ok || !llmRes.body) {
        // Primary couldn't serve the stream — fall through to the buffered
        // path below, which walks the full provider chain (Bedrock →
        // optional cross-vendor) instead of dead-ending the widget.
        const detail = await llmRes.text().catch(() => '');
        console.error('Anthropic error (stream) — falling back to buffered chain', llmRes.status, detail);
      } else {
      const upstream = llmRes.body.getReader();
      const encoder = new TextEncoder();

      const sse = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: string, data: unknown) => {
            try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* stream closed */ }
          };

          (async () => {
            let acc = '';        // full raw model output so far
            let flushed = 0;     // chars of acc already emitted as deltas
            let usageIn = 0, usageOut = 0;
            let blocked = false;

            // Longest suffix of s that is a (partial) prefix of META.
            const partialMetaLen = (s: string): number => {
              const max = Math.min(META.length - 1, s.length);
              for (let n = max; n > 0; n--) if (s.endsWith(META.slice(0, n))) return n;
              return 0;
            };

            // Mirror of the non-streaming blocked path in finalizeCore().
            const doBlock = async (rule: GuardrailRule) => {
              const mi = acc.indexOf(META);
              const partial = (mi >= 0 ? acc.slice(0, mi) : acc).trim();
              if (convId) {
                await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: GUARDRAIL_BLOCK_MESSAGE, confidence: 0, escalated: true, delivery: 'blocked', lang: null });
                await admin.from('de_conversations').update({ status: 'needs_human', handoff_summary: `Guardrail "${rule.rule}" blocked a reply to: ${truncatedQ}`, detected_language: null, last_message_at: nowIso() }).eq('id', convId);
              }
              await admin.from('human_tasks').insert({ tenant_id: tenantId, type: 'escalation', source: 'de', title: `Guardrail block (${channel} · ${who}) — ${truncatedQ}`, detail: `Answer blocked by guardrail "${rule.rule}" mid-stream. Partial draft: ${partial}`, related_table: convId ? 'de_conversations' : null, related_id: convId });
              await auditEvent(admin, tenantId, persona.name, 'de', `BLOCKED — ${channel} answer matched guardrail "${rule.rule}"; withheld + escalated`, 'guardrail_block', { rule_id: rule.id, rule: rule.rule, question: truncatedQ, channel });
              // Count the streamed block as an escalation outcome (audit: mid-stream
              // blocks were missing from the resolution-rate denominator).
              if (convId) await admin.rpc('record_billable_outcome', { p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId, p_kind: 'escalation', p_source: 'widget' });
              emit('blocked', { conversation_id: convId, blocked: true, rule: rule.rule, answer: GUARDRAIL_BLOCK_MESSAGE, confidence: 0, sources: [], needs_escalation: true, status: 'needs_human', delivery: 'blocked', language: null });
            };

            // Flush complete sentences only — never past the hold-back or a
            // (partial) META marker; guardrail-check the FULL text first.
            const tryFlush = async (): Promise<boolean> => {
              const metaIdx = acc.indexOf(META);
              const visibleEnd = metaIdx >= 0 ? metaIdx : acc.length - partialMetaLen(acc);
              const limit = Math.min(visibleEnd, acc.length - HOLD_BACK);
              if (limit <= flushed) return false;
              const win = acc.slice(flushed, limit);
              let cut = -1;
              const re = /[.?!](?=[\s\n])/g;
              let m: RegExpExecArray | null;
              while ((m = re.exec(win)) !== null) cut = m.index + 1;
              if (cut <= 0) return false;
              const rule = matchBlockingRule(blockingRules, metaIdx >= 0 ? acc.slice(0, metaIdx) : acc);
              if (rule) { await doBlock(rule); return true; }
              emit('delta', { text: acc.slice(flushed, flushed + cut) });
              flushed += cut;
              return false;
            };

            try {
              const decoder = new TextDecoder();
              let lineBuf = '';
              readLoop:
              while (true) {
                const { done, value } = await upstream.read();
                if (done) break;
                lineBuf += decoder.decode(value, { stream: true });
                const lines = lineBuf.split('\n');
                lineBuf = lines.pop() ?? '';
                for (const rawLine of lines) {
                  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                  if (!line.startsWith('data:')) continue;
                  const payload = line.slice(5).trim();
                  if (!payload) continue;
                  // deno-lint-ignore no-explicit-any
                  let ev: any;
                  try { ev = JSON.parse(payload); } catch { continue; }
                  if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                    acc += String(ev.delta.text ?? '');
                    if (await tryFlush()) { blocked = true; break readLoop; }
                  } else if (ev.type === 'message_start') {
                    usageIn = ev.message?.usage?.input_tokens ?? 0;
                  } else if (ev.type === 'message_delta') {
                    if (ev.usage?.output_tokens != null) usageOut = ev.usage.output_tokens;
                  }
                }
              }

              if (blocked) {
                try { await upstream.cancel(); } catch { /* already done */ }
                controller.close();
                return;
              }

              // ── Clean completion: parse the META tail (tolerate absence) ──
              const metaIdx = acc.indexOf(META);
              const answerText = (metaIdx >= 0 ? acc.slice(0, metaIdx) : acc).trim();
              let conf = 50; let srcs: string[] = []; let needsEsc = false; let lang: string | null = null;
              if (metaIdx >= 0) {
                try {
                  const tail = acc.slice(metaIdx + META.length);
                  const s = tail.indexOf('{'), e2 = tail.lastIndexOf('}');
                  if (s >= 0 && e2 > s) {
                    const meta = JSON.parse(tail.slice(s, e2 + 1));
                    conf = Math.max(0, Math.min(100, Math.round(Number(meta.confidence)) || 0));
                    srcs = Array.isArray(meta.sources) ? meta.sources.map(String) : [];
                    needsEsc = !!meta.needs_escalation;
                    lang = typeof meta.language === 'string' && meta.language.trim() ? meta.language.trim() : null;
                  }
                } catch { /* keep defaults */ }
              }

              // Metering moved to the finally below so it records on EVERY exit
              // path (clean, mid-stream block, or stream error) — audit: spend up to
              // a mid-stream block or error was previously never charged.

              // Cache write — same policy + language tag as the JSON path.
              // Never cache an answer shaped by a caller's identity memory (it
              // could carry their private data into the tenant-wide cache).
              if (qEmbedding && !identityMemoryContext && conf >= confidenceFloor && !escalationRuleHit && !needsEsc) {
                const clean = await checkAnswerGuardrails(admin, tenantId, answerText, subjectDeId);
                if (!clean) {
                  await admin.from('answer_cache').insert({
                    tenant_id: tenantId, account_id: null, de_id: subjectDeId, question,
                    question_embedding: qEmbedding, answer: answerText, confidence: conf, sources: srcs,
                    language: lang ?? 'English',
                  });
                }
              }

              // Full post-answer pipeline (final guardrail re-check catches
              // anything that arrived after the last flush check, escalation
              // threshold, persist, activity/audit) — IDENTICAL to JSON path.
              const payload = await finalizeCore(answerText, conf, srcs, lang, false);
              emit(payload.blocked ? 'blocked' : 'final', payload);
              controller.close();
            } catch (err) {
              console.error('widget-ask stream error:', err);
              try { await upstream.cancel(); } catch { /* noop */ }
              emit('error', { error: 'stream_failed', conversation_id: convId });
              try { controller.close(); } catch { /* already closed */ }
            } finally {
              // Charge token usage on EVERY exit path — clean, mid-stream block, or
              // error — so real LLM spend always counts against the budget (audit).
              if (subjectDeId && (usageIn > 0 || usageOut > 0)) {
                admin.rpc('record_de_token_usage', {
                  p_tenant_id: tenantId, p_de_id: subjectDeId, p_model_id: model,
                  p_input_tokens: usageIn, p_output_tokens: usageOut,
                }).then(({ error }: { error: unknown }) => { if (error) console.error('record_de_token_usage:', error); });
              }
            }
          })();
        },
        cancel() { upstream.cancel().catch(() => { /* noop */ }); },
      });

      return new Response(sse, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
      });
      } // end streaming-served else
    }

    // The persona + fixed instructions are stable across turns → prompt-cached.
    const instructionBlock = `${persona.preamble} ${audience} Answer ONLY from the provided knowledge documents. If the documents don't contain the answer, say so plainly and set confidence low. Detect the language of the user's message and write your ENTIRE answer in that same language. Always output JSON: {"answer": string, "confidence": 0-100, "sources": [doc titles used], "needs_escalation": boolean, "language": string}. "language" is the language you wrote the answer in (e.g. "English", "Spanish"). Confidence reflects how well the documents support the answer. Never invent facts. If the message is conversational rather than a question — a greeting, thanks, an apology, small talk, or an expression of frustration — reply naturally and briefly in your own voice without needing a document: set sources to [] and confidence to 100, because a pleasantry is not a knowledge gap. Decide needs_escalation on whether a human is genuinely needed (an upset or blocked customer usually is), never on whether documents happened to match.`;

    const res = await llmMessages(admin, {
      model, max_tokens: 1024,
      system: [
        { type: 'text', text: instructionBlock, cache_control: { type: 'ephemeral' } },
        // Injection firewall (#9): same marking as the streaming path.
        { type: 'text', text: `Knowledge documents:\n${wrapUntrusted(context, 'knowledge-documents')}${identityMemoryContext}${FIREWALL_RULES}` },
      ],
      messages: [{ role: 'user', content: question }],
    }, 'widget-ask');
    if (!res.ok) {
      const detail = await res.text();
      console.error('Anthropic error', res.status, detail);
      return json({ error: 'llm_error', status: res.status, conversation_id: convId }, 502);
    }
    const data = await res.json();
    const raw: string = (data.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '';
    const parsed = parseModelJson(raw);

    // §5 GROUNDED CONFIDENCE on the PUBLIC channel. Same contract as de-answer:
    // shadow-log grounded-vs-self, and blend only as min(self, grounded) under
    // master+flag+mode+validation-row. A participating tenant is already forced off
    // the token-stream above, so in enforce this clears before any byte is sent.
    // One mutation upstream of the floor/escalation/cache gates. Fail-open on error.
    if (gcActive) {
      try {
        const gc = groundedConfidence(Array.isArray(chunks) ? (chunks as Array<Record<string, number | null>>) : [], {
          embeddingAvailable: retrievalEmbedding !== null && !matchErr,
          sourcesCited: parsed.sources.length,
        });
        const self = parsed.confidence;
        const groundedVal = gc.value;
        const willBlend = gcEnforce && gc.expected && groundedVal !== null;
        const effective = willBlend ? Math.min(self, groundedVal) : self;
        admin.from('grounded_confidence_shadow_log').insert({
          tenant_id: tenantId, de_id: subjectDeId, conversation_id: convId ?? null,
          resolved_mode: gcEnforce ? gcMode : 'shadow', is_synthetic: false, source: 'widget',
          self_confidence: self, grounded_confidence: groundedVal, effective_confidence: effective,
          confidence_floor: confidenceFloor,
          self_would_escalate: self < confidenceFloor,
          grounded_would_escalate: groundedVal !== null && groundedVal < confidenceFloor,
          effective_escalated: effective < confidenceFloor,
          retrieval: gc.inputs ? { ...gc.inputs, reason: gc.reason } : { reason: gc.reason },
          question_preview: String(question ?? '').slice(0, 160),
        }).then(({ error }: { error: { message: string } | null }) => { if (error) console.error('gc shadow log:', error.message); });
        if (willBlend) parsed.confidence = effective;
      } catch (e) { console.error('grounded confidence:', e); }
    }
    if (subjectDeId) {
      admin.rpc('record_de_token_usage', {
        p_tenant_id: tenantId, p_de_id: subjectDeId, p_model_id: model,
        p_input_tokens: data.usage?.input_tokens ?? 0, p_output_tokens: data.usage?.output_tokens ?? 0,
      }).then(({ error }: { error: unknown }) => { if (error) console.error('record_de_token_usage:', error); });
    }

    // Cache write: only confident, guardrail-clean answers (a later repeat is
    // deflected at $0). Draft-mode is a DELIVERY policy, not answer quality —
    // so we still cache the answer; the gate in finalize() decides delivery.
    if (qEmbedding && !identityMemoryContext && parsed.confidence >= confidenceFloor && !escalationRuleHit && !parsed.needs_escalation) {
      const clean = await checkAnswerGuardrails(admin, tenantId, parsed.answer, subjectDeId);
      if (!clean) {
        await admin.from('answer_cache').insert({
          tenant_id: tenantId, account_id: null, de_id: subjectDeId, question,
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
