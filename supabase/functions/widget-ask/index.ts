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
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
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
import { buildTurns, parseCustomerState, stateSignals, CUSTOMER_STATE_SPEC, type CustomerState, type Turn } from '../_shared/conversation.ts';
import { findBlockingMatch } from '../_shared/guardrailMatch.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';
import { budgetBlocked, rpcLoud } from '../_shared/rpcSafety.ts';
import { rankDocs, parseAnswerEnvelope } from '../_shared/answerEnvelope.ts';
import { checkAnswerGuardrails, loadBlockingRules, matchBlockingRule, GUARDRAIL_RESOLVER_ERROR } from '../_shared/answerGuardrails.ts';
import { classifyAndRoute, chooseAnswerer, triageColumns, NEVER_FRONTS_CUSTOMER_CHAT, type RoutedTopic } from '../_shared/topicRouting.ts';

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

interface KDoc { id: string; title: string; content: string; tags: string[] }

// ── Guardrail check (blocks + escalates; the DE's rules, not the channel's) ──
interface GuardrailRule { id: string; rule: string; rule_type: string; pattern: string | null; applies_to: string }

const GUARDRAIL_BLOCK_MESSAGE = "I can't help with that — it's outside my guardrails. I've passed it to a human on the team.";

// deno-lint-ignore no-explicit-any
async function auditEvent(admin: any, tenantId: string, actor: string, actorType: string, action: string, category: string, detail: Record<string, unknown>) {
  const { error } = await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId, p_actor: actor, p_actor_type: actorType, p_action: action, p_category: category, p_detail: detail,
  });
  if (error) console.error('append_audit_event:', error.message);
}

interface DEAnswer { answer: string; confidence: number; sources: string[]; needs_escalation: boolean; language: string | null; customer_state?: unknown }

// ── "What Sophie already checked" (mig 667, handoff 06 §A) ──────────────────
// At every escalation exit, retain what the DE verified BEFORE handing off,
// so the human stops re-doing the work to trust the draft. Rules of the rows:
//   · a row asserts a check that RAN — identity is only written when a
//     verification was actually attempted (userHash present), never a fake ✗
//     for tenants with no identity system configured;
//   · best-effort and never load-bearing: a failed insert logs and the reply
//     still goes out — but never silently (the .rpc-sweep rule).
type ConvCheck = { kind: 'knowledge' | 'identity' | 'guardrail' | 'escalation_rule' | 'confidence' | 'connector'; ok: boolean; label: string; detail?: string };
// deno-lint-ignore no-explicit-any
async function recordChecks(admin: any, tenantId: string, convId: string | null, deId: string | null, checks: ConvCheck[]): Promise<void> {
  if (!convId || checks.length === 0) return;
  try {
    const { error } = await admin.from('conversation_checks').insert(checks.map((c) => ({
      tenant_id: tenantId, conversation_id: convId, de_id: deId,
      kind: c.kind, ok: c.ok, label: c.label.slice(0, 200), detail: c.detail?.slice(0, 500) ?? null,
    })));
    if (error) console.error('conversation_checks insert:', error.message);
  } catch (e) { console.error('conversation_checks insert:', String(e)); }
}
const knowledgeChecks = (srcs: string[]): ConvCheck[] =>
  srcs.slice(0, 8).map((t) => ({ kind: 'knowledge', ok: true, label: `Read: ${t}` }));
const identityCheck = (v: { verified?: boolean } | null): ConvCheck[] =>
  v === null ? [] : [v.verified
    ? { kind: 'identity', ok: true, label: 'Caller identity verified' }
    : { kind: 'identity', ok: false, label: 'Caller identity could not be verified' }];

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

    // ── THE THREAD, RESOLVED BEFORE THE EMPLOYEE (mig 760 FIX ROUND, R1) ─────
    // This ownership check used to sit at :354 — SIXTY-SEVEN LINES AFTER the
    // classification at :287 — so `routed` was computed on every turn and the
    // reuse check came too late to stop it. A supplied conversation_id must
    // belong to THIS widget key's tenant (external review 2026-07-20, P1-6);
    // that is unchanged. What is new is that the row's `de_id` is read WITH it,
    // because on a thread that already exists the row is who answers.
    //
    // ⚠ NOTHING RETURNS BETWEEN THE SUSPENSION GATE ABOVE AND THE OLD POSITION
    // OF THIS CHECK, so a caller sees the same 404 in the same order it saw
    // yesterday. What changes is that a reused thread no longer pays for a
    // classification whose answer it must not use.
    let existingConv: { id: string; de_id: string | null } | null = null;
    if (conversationId) {
      const { data: owned } = await admin
        .from('de_conversations')
        .select('id, de_id')
        .eq('id', conversationId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!owned) return json({ error: 'conversation_not_found' }, 404);
      existingConv = { id: String(owned.id), de_id: (owned.de_id as string | null) ?? null };
    }

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

    // ⚠⚠ mig 760: A CONVERSATION TOPIC DECIDES WHO ANSWERS. The question is
    // classified BEFORE the conversation row exists, and that ONE result is used
    // for both the routing and the four triage columns stamped at insert.
    //
    // ⚠ THE TEXT IS `question` AND NOTHING ELSE. Below, the first message is
    // stored as `[${channel} · ${endUserTag}] ${question}` and the conversation
    // subject is the question's first 120 characters — and the trigger used to
    // classify subject + content together. classify_support_text matches BARE
    // SUBSTRINGS, so an end user at an account called "Fireside Media" asking
    // about invoice payment terms classified Safety/urgent/sev1 because `fire`
    // is in the Safety pattern and Safety sits at rule_order 10 (proven live
    // 2026-08-18). A company NAME must not decide who answers.
    //
    // ⚠⚠ PRECEDENCE — an explicitly BOUND KEY (mig 323) > the THREAD'S RECORDED
    // OWNER > the TOPIC OWNER > today's fallback. A customer who pointed this
    // widget key at one employee said something more specific than a triage
    // rule does, so the binding still wins.
    //
    // ⚠⚠⚠ AND A REUSED THREAD IS NOT CLASSIFIED AT ALL. public/widget.js:144
    // sends conversation_id on EVERY turn, so before this fix turn 2 of an open
    // widget thread was re-classified and could be answered, charged and
    // escalated by a different employee while de_conversations.de_id still
    // named the first. The row is the answer; asking the classifier for a
    // second opinion on a decision already recorded is what created the gap.
    const routed: RoutedTopic = existingConv
      ? { triage: null, owner: null }
      : await classifyAndRoute(admin, tenantId, question, channel);

    // The employee this thread already belongs to, held to the SAME bar the
    // front desk holds everyone to — a conversation whose employee has since
    // been paused, retired, archived or un-published must still be answered,
    // and it is answered by today's fallback, never by a classification.
    let threadOwner: { id: string; external_reply_mode: string | null } | null = null;
    if (existingConv?.de_id) {
      const { data: recorded } = await admin.from('digital_employees')
        .select('id, external_reply_mode, lifecycle_status')
        .eq('id', existingConv.de_id).eq('tenant_id', tenantId).maybeSingle();
      if (recorded && !NEVER_FRONTS_CUSTOMER_CHAT.includes(String(recorded.lifecycle_status))) {
        threadOwner = { id: String(recorded.id), external_reply_mode: recorded.external_reply_mode ?? null };
      }
    }

    const picked = chooseAnswerer({
      named: boundDe ? { id: String(boundDe.id), external_reply_mode: boundDe.external_reply_mode ?? null } : null,
      thread: threadOwner,
      topic: routed.owner,
      // ⚠ THE `auto` BRANCH HAS NEVER SELECTED ANYTHING — external_reply_mode
      // is 'draft' on all 109 employees across all 18 tenants, so `?? frontDes[0]`
      // resolves every time. It is left exactly as it was: this migration is
      // additive, and "no match behaves as today" has to mean the branch that
      // actually runs.
      fallback: ((f) => (f ? { id: String(f.id), external_reply_mode: f.external_reply_mode ?? null } : null))(
        (frontDes ?? []).find((d) => d.external_reply_mode === 'auto') ?? (frontDes ?? [])[0] ?? null,
      ),
    });
    const firstDe = picked.who;
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

    // What the CACHE requires of an answer, deliberately decoupled from what
    // DELIVERY requires. With the autonomy dial off the floor is 101 — a
    // delivery policy ("a person reviews every reply"), not a claim that a 95%
    // grounded answer is bad. The write conditions used `conf >=
    // confidenceFloor`, so on every dial-off tenant (today: all of them) the
    // cache could never be written, which is why the live hit rate was ZERO —
    // the comment above the write already said "Draft-mode is a DELIVERY
    // policy, not answer quality" while the floor coupling did the opposite.
    // A tenant that set a REAL floor (<=100) keeps it as the quality bar, so a
    // stricter operator stays stricter; dial-off falls back to the platform
    // default. Delivery is untouched: a cached answer still drafts for
    // approval, it just costs zero LLM calls the second time someone asks.
    const cacheQualityBar = confidenceFloor <= 100
      ? Math.max(ESCALATION_THRESHOLD, confidenceFloor)
      : ESCALATION_THRESHOLD;

    const endUserTag = [displayName, accountRef ? `account ${accountRef}` : null].filter(Boolean).join(' · ');

    // ── Conversation (create with lifecycle fields, or reuse) ──
    // Validated and READ above, where it had to be: the row's de_id is what
    // chose the employee, so the tenant check that used to live here now
    // happens before anything depends on the answer. One lookup, one source of
    // truth — two copies of "is this thread ours" is how the classification and
    // the reuse check came to disagree about whether a thread was new.
    let convId: string | null = existingConv?.id ?? null;
    let isNewConv = false;
    if (!convId) {
      isNewConv = true;
      const { data: conv, error: convErr } = await admin.from('de_conversations').insert({
        tenant_id: tenantId, channel, de_id: subjectDeId, status: 'ai_handling',
        subject: question.trim().slice(0, 120),
        account_external_ref: accountRef, end_user_ref: endUserRef, end_user_name: displayName,
        last_message_at: nowIso(),
        // ⚠ mig 760: ALL FOUR TRIAGE COLUMNS, TOGETHER OR NOT AT ALL.
        // trg_triage_support_conversation returns early on `category IS NOT
        // NULL`, so stamping only the category here would leave severity NULL
        // and priority stuck at its 'normal' default forever. `{}` when there
        // is nothing to stamp, which leaves the trigger to do exactly what it
        // does today.
        ...triageColumns(routed.triage),
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
        await recordChecks(admin, tenantId, convId, subjectDeId, [
          ...identityCheck(identityVerdict),
          { kind: 'escalation_rule', ok: false, label: 'Stopped: the conversation reached its length limit' },
        ]);
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

    // ── The thread this turn belongs to (mig 325) ──────────────────────
    // de_messages was written on every turn and never read back, so every turn
    // was a cold open — the employee could not resolve "that one", could not
    // tell a first complaint from a fourth, and re-explained itself forever.
    // Always ends with the current question; length 1 = first turn.
    const turns: Turn[] = await buildTurns(admin, tenantId, convId, question, persona.contextTurns);
    const isFollowUp = turns.length > 1;

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
      const regexHit = await checkAnswerGuardrails(admin, tenantId, ans, deId, 'widget-ask');
      if (regexHit) return regexHit;
      if (!semGate.enabled) return null;
      const rules = await loadBlockingRulesForJudge(admin, tenantId, deId);
      if (rules === null) return GUARDRAIL_RESOLVER_ERROR;   // fail closed
      return (await semanticGuardrailScreen(admin, { tenantId, deId, surface: 'answer', content: ans, blockingRules: rules, mode: semGate.mode! })) as GuardrailRule | null;
    };
    const finalizeCore = async (ans: string, conf: number, srcs: string[], lang: string | null, cached: boolean, state: CustomerState = { mood: null, intensity: null }): Promise<Record<string, unknown>> => {
      // ── Evidence decision (docs/31 pre-start #4, mig 442): every widget
      // answer records a decision via record_inquiry_decision — the single
      // writer that also opens the Experience ledger. external_ref prefers the
      // customer ACCOUNT the widget session carries, so widget experience
      // attaches to the account (docs/31 Q1 "Experience door a"). widget-ask
      // has no replay mode; if one is ever added, mirror de-answer's guard.
      const recordDecision = async (opts: { decision: string; conf: number; srcs: string[]; blocked?: boolean; guardrailRuleId?: string | null; taskId?: string | null; note: string }) => {
        try {
          const { data: er } = await admin.from('evidence_runs').insert({
            tenant_id: tenantId, de_id: subjectDeId, inquiry: String(question ?? '').slice(0, 2000),
            account_ref: accountRef ?? (convId ? `conversation:${convId}` : null),
            status: 'complete', steps: [], answer_status: opts.blocked ? 'blocked' : 'answered',
            answer: ans.slice(0, 4000),
            confidence_inputs: { knowledge_hits: opts.srcs.length },
          }).select('id').single();
          if (er?.id) {
            await admin.rpc('record_inquiry_decision', {
              p_tenant_id: tenantId, p_evidence_run_id: er.id, p_connector_id: null,
              p_external_ref: accountRef ?? endUserRef ?? (convId ? `conversation:${convId}` : null),
              p_source: 'live_channel', p_decision: opts.decision,
              p_confidence: opts.conf, p_guardrail_rule_id: opts.guardrailRuleId ?? null,
              p_trust_level: null, p_reasoning: opts.note,
              p_inquiry_title: String(question ?? '').slice(0, 120),
              p_source_category: 'support',
              p_frustration_score: state.intensity,
              p_existing_human_task_id: opts.taskId ?? null,
            });
          }
        } catch (e) { console.error('evidence decision (widget):', e); }
      };
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
        if (convId) await rpcLoud(admin, 'record_billable_outcome', { p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId, p_kind: 'escalation', p_source: 'widget' });
        await recordDecision({ decision: 'blocked_guardrail', conf, srcs: [], blocked: true, guardrailRuleId: blockedBy.id, note: `Answer blocked by guardrail "${blockedBy.rule}" and withheld; escalated to human.` });
        await recordChecks(admin, tenantId, convId, subjectDeId, [
          ...knowledgeChecks(srcs),
          ...identityCheck(identityVerdict),
          { kind: 'guardrail', ok: false, label: `Blocked by the guardrail: ${blockedBy.rule}` },
        ]);
        return { conversation_id: convId, blocked: true, rule: blockedBy.rule, answer: GUARDRAIL_BLOCK_MESSAGE, confidence: 0, sources: [], needs_escalation: true, status: 'needs_human', delivery: 'blocked', language: lang };
      }

      const lowConf = conf < confidenceFloor;
      // Post-answer: re-evaluate with confidence known so conditions on
      // confidence (not just text) can fire.
      if (!escalationRuleHit) {
        const post = evaluateEscalation(escRuleset, { message_text: String(question ?? ''), confidence: conf, ...stateSignals(state) });
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
          await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: ans, confidence: conf, escalated: true, delivery: 'draft_pending', lang, confidence_dimensions: (state.mood || state.intensity !== null) ? { customer_state: state } : null });
          await admin.from('de_conversations').update({ status: 'needs_human', handoff_summary: handoffSummary, detected_language: lang, last_message_at: nowIso() }).eq('id', convId);
        }
        const { data: escTask } = await admin.from('human_tasks').insert({ tenant_id: tenantId, de_id: subjectDeId, type: 'escalation', source: 'de', title: `${(lowConf || escalationRuleHit) ? 'Escalation' : 'Reply to approve'} (${channel} · ${who}) — ${truncatedQ}`, detail: handoffSummary, related_table: convId ? 'de_conversations' : null, related_id: convId }).select('id').single();
        await admin.from('activity_events').insert({ tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'escalated', text: `${channel} question from ${who} → ${(lowConf || escalationRuleHit) ? 'escalated' : 'draft awaiting approval'} — "${truncatedQ}"`, confidence: conf });
        await auditEvent(admin, tenantId, persona.name, 'de', `${channel} question from ${who} → ${escalationRuleHit ? `escalated (${escalationRuleHit})` : lowConf ? 'escalated (low confidence)' : 'draft awaiting human approval'}`, 'escalated', { confidence: conf, conversation_id: convId, channel, mode: replyMode });
        // (The mig-252 "gap bridge" that lived here never once succeeded — FK
        // violation on source_category, swallowed. Superseded by recordDecision
        // via record_inquiry_decision — mig 442.)
        // Outcome metering (#15): human takes over — FREE.
        if (convId) await rpcLoud(admin, 'record_billable_outcome', { p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId, p_kind: 'escalation', p_source: 'widget' });
        await recordDecision({
          decision: (lowConf || escalationRuleHit) ? 'needs_review' : 'would_auto_send',
          conf, srcs, taskId: escTask?.id ?? null,
          note: `${channel} answer ${(lowConf || escalationRuleHit) ? `escalated${escalationRuleHit ? ` (${escalationRuleHit})` : ' (low confidence)'}` : 'held as a draft for human approval'} at ${conf}% confidence with ${srcs.length} knowledge source(s).`,
        });
        // The single reason THIS conversation stopped, in priority order — a
        // founder rule outranks low confidence outranks standing draft mode.
        const stopReason: ConvCheck = escalationRuleHit
          ? { kind: 'escalation_rule', ok: false, label: `Stopped by the rule: ${escalationRuleHit}` }
          : lowConf
            // ⚠ confidenceFloor > 100 is the dial-off SENTINEL (261: dial
            // disabled → floor 101 → nothing auto-sends). The live proof
            // printed "below the 101% send threshold" — an impossible number
            // leaking an implementation trick into a human's panel. Say what
            // is actually true in each case instead.
            ? (confidenceFloor > 100
              ? { kind: 'confidence', ok: false, label: `Confidence ${conf}% — this employee isn't allowed to send replies on its own yet` }
              : { kind: 'confidence', ok: false, label: `Confidence ${conf}% — below the ${confidenceFloor}% send threshold` })
            : { kind: 'escalation_rule', ok: false, label: 'Held for approval: every reply from this employee is reviewed before it sends' };
        await recordChecks(admin, tenantId, convId, subjectDeId, [
          ...knowledgeChecks(srcs),
          ...identityCheck(identityVerdict),
          stopReason,
        ]);
        // The customer sees a holding message — never the un-approved draft.
        const holding = lowConf
          ? "Thanks for your patience — I'm bringing a teammate in to make sure you get this right."
          : "Thanks! A team member is reviewing your request and will reply here shortly.";
        return { conversation_id: convId, answer: holding, confidence: conf, sources: [], needs_escalation: true, status: 'needs_human', delivery: 'draft_pending', language: lang };
      }

      // Auto-send: confident, guardrail-clean, DE trusted to reply on its own.
      let messageId: string | null = null;
      if (convId) {
        const { data: ins } = await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: ans, confidence: conf, escalated: false, delivery: 'sent', lang, confidence_dimensions: (state.mood || state.intensity !== null) ? { customer_state: state } : null }).select('id').single();
        messageId = ins?.id ?? null;
        await admin.from('de_conversations').update({ status: 'ai_handling', detected_language: lang, last_message_at: nowIso() }).eq('id', convId);
      }
      await admin.from('activity_events').insert({ tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'resolved', text: `Answered a ${channel} question${endUserTag ? ` from ${endUserTag}` : ''}${cached ? ' (from cache)' : ''} (${srcs.join(', ') || 'no sources cited'})`, confidence: conf });
      await auditEvent(admin, tenantId, persona.name, 'de', `Resolved a ${channel} question${endUserTag ? ` from ${endUserTag}` : ''}${cached ? ' from cache' : ''}`, 'resolved', { confidence: conf, conversation_id: convId, channel, cached });
      // Outcome metering (#15): an auto-sent, guardrail-clean answer is the
      // billable RESOLUTION (per-conversation idempotent, escalations free).
      if (convId) await rpcLoud(admin, 'record_billable_outcome', { p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId, p_kind: 'resolution', p_source: 'widget' });
      // T2.3: persist a durable memory for the VERIFIED caller (no-op unless this
      // turn was verified). The Q&A pair is the remembered interaction.
      await rememberIdentity(admin, {
        tenantId, deId: subjectDeId, embedding: qEmbedding, verdict: identityVerdict,
        content: `Q: ${question.trim().slice(0, 300)}\nA: ${ans.slice(0, 500)}`,
        kind: 'episodic', salience: 0.5, source: 'de',   // de_memory CHECK: kind∈{episodic,semantic,fact,preference}, source∈{de,human,system,ingestion}
      });
      await recordDecision({ decision: 'acted', conf, srcs, note: `${channel} answer auto-sent at ${conf}% confidence with ${srcs.length} knowledge source(s)${cached ? ' (from cache)' : ''}.` });
      return { conversation_id: convId, message_id: messageId, answer: ans, confidence: conf, sources: srcs, needs_escalation: false, status: 'ai_handling', delivery: 'sent', language: lang, cached, identity_verified: identityVerdict?.verified ?? false };
    };
    const finalize = async (ans: string, conf: number, srcs: string[], lang: string | null, cached: boolean, state?: CustomerState) =>
      json(await finalizeCore(ans, conf, srcs, lang, cached, state));

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
    // Cold opens ONLY (see de-answer for the full reasoning): a follow-up's
    // meaning lives in the thread, not in its own words — "how much is that?"
    // or "thanks, that helped" embed to whatever they superficially resemble,
    // and serving a stored FAQ answer to them is a correctness bug. Most
    // conversations are one question, so the dedup economics survive.
    if (qEmbedding && !isFollowUp && !looksNonEnglish(question) && !identityVerdict?.verified) {
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
      // ⚠ THIS BRANCH USED TO END THE STORY (register B-5 / F-5). It answered
      // the customer honestly — "still setting up my knowledge base" — and then
      // told NOBODY: escalated:false, no human task, no event, conversation left
      // 'ai_handling' so no inbox surfaced it. A workspace that had not finished
      // loading its knowledge lost every question asked of it, silently, and the
      // customer was the only party who knew they had asked.
      //
      // The holding reply stays: it is true, and saying nothing is worse. What
      // changes is that the workspace now hears about it, through the same
      // escalation path a low-confidence answer or a guardrail block uses.
      const answer = "I don't have anything to answer from yet — the team is still setting up my knowledge base. Please check back soon.";
      if (convId) {
        await admin.from('de_messages').insert({ tenant_id: tenantId, conversation_id: convId, role: 'assistant', content: answer, confidence: 0, escalated: true, delivery: 'sent' });
        await admin.from('de_conversations').update({
          status: 'needs_human',
          handoff_summary: `Asked before this workspace had any knowledge to answer from: ${truncatedQ}`,
          last_message_at: nowIso(),
        }).eq('id', convId);
      }
      await admin.from('human_tasks').insert({
        tenant_id: tenantId, de_id: subjectDeId, type: 'escalation', source: 'de',
        title: `No knowledge to answer from (${channel} · ${who}) — ${truncatedQ}`,
        detail: `A customer asked before this workspace had any knowledge loaded, so ${persona.name} could not answer. `
          + `They were told the knowledge base is still being set up. Load a document that covers this and reply, `
          + `or answer them directly from here.`,
        related_table: convId ? 'de_conversations' : null, related_id: convId,
      });
      await admin.from('activity_events').insert({
        tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'escalated',
        text: `${channel} question from ${who} → escalated (no knowledge loaded yet) — "${truncatedQ}"`, confidence: 0,
      });
      await auditEvent(admin, tenantId, persona.name, 'de',
        `${channel} question could not be answered — this workspace has no knowledge documents visible to this employee; escalated`,
        'escalated', { conversation_id: convId, channel, question: truncatedQ, reason: 'no_knowledge_documents' });
      return json({ conversation_id: convId, answer, confidence: 0, sources: [], needs_escalation: true, no_docs: true, status: 'needs_human' });
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
    const { data: budgetCheck, error: budgetCheckErr } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
    if (budgetBlocked(budgetCheckErr, budgetCheck)) return json({ error: 'ai_budget_exceeded', conversation_id: convId });

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
      ? await loadBlockingRules(admin, tenantId, subjectDeId, 'widget-ask:stream') : [];
    // If screening rules can't load, do NOT stream unscreened — fall through to the
    // buffered path, whose checkAnswerGuardrails fails closed (blocks + escalates).
    if (body.stream === true && replyMode === 'auto' && !escalationRuleHit && anthropicKey && !semGate.enabled && !gcActive && streamRules !== null) {
      const blockingRules = streamRules;
      const HOLD_BACK = Math.max(120, ...blockingRules.map((r) => (r.pattern ?? '').length));
      const META = '###META###';

      // Prose-first protocol: plain-text answer, then META marker + JSON tail.
      const streamInstructionBlock = `${persona.preamble} ${audience}

Every factual claim you make comes ONLY from the provided knowledge documents. If the documents don't contain the answer, say so plainly and report low confidence in the metadata. Never invent facts. That constraint is on FACTS, not on how you talk: not every message is a factual question. A greeting, a thank-you, a joke, an apology, small talk, venting, or a one-word follow-up is a conversational turn — answer it as yourself from the thread you are in, with no document needed; set sources to [] and confidence to 100, because a pleasantry is not a knowledge gap. You are given the recent conversation: use it. Resolve "it", "that one", "the other thing" against what was already said instead of asking them to repeat it, and don't re-explain something you have already explained in this thread. Detect the language of the user's message and write your ENTIRE answer in that same language.

Write the answer as plain text — NOT as JSON; prior assistant turns are shown to you as plain text too. Then, on a new final line, output exactly ${META} immediately followed by a JSON object: {"confidence": 0-100, "sources": [doc titles used], "needs_escalation": boolean, "language": string, ${CUSTOMER_STATE_SPEC}}. "language" is the language you wrote the answer in (e.g. "English", "Spanish"). Confidence reflects how well the documents support the answer. Decide needs_escalation on whether a human is genuinely needed (someone blocked, going in circles, or angry usually is), never on whether documents happened to match.`;

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
          messages: turns,
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
              if (convId) await rpcLoud(admin, 'record_billable_outcome', { p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId, p_kind: 'escalation', p_source: 'widget' });
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
              let state: CustomerState = { mood: null, intensity: null };
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
                    state = parseCustomerState(meta.customer_state);
                  }
                } catch { /* keep defaults */ }
              }

              // Metering moved to the finally below so it records on EVERY exit
              // path (clean, mid-stream block, or stream error) — audit: spend up to
              // a mid-stream block or error was previously never charged.

              // Cache write — same policy + language tag as the JSON path.
              // Never cache an answer shaped by a caller's identity memory (it
              // could carry their private data into the tenant-wide cache).
              if (qEmbedding && !isFollowUp && !identityMemoryContext && conf >= cacheQualityBar && !escalationRuleHit && !needsEsc) {
                const blockedBy = await checkAnswerGuardrails(admin, tenantId, answerText, subjectDeId, 'widget-ask');
                if (!blockedBy) {
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
              const payload = await finalizeCore(answerText, conf, srcs, lang, false, state);
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
    const instructionBlock = `${persona.preamble} ${audience}

Every factual claim you make comes ONLY from the provided knowledge documents. If the documents don't contain the answer, say so plainly and set confidence low. Never invent facts. That constraint is on FACTS, not on how you talk: not every message is a factual question. A greeting, a thank-you, a joke, an apology, small talk, venting, or a one-word follow-up is a conversational turn — answer it as yourself from the thread you are in, with no document needed; set sources to [] and confidence to 100, because a pleasantry is not a knowledge gap. You are given the recent conversation: use it. Resolve "it", "that one", "the other thing" against what was already said instead of asking them to repeat it, and don't re-explain something you have already explained in this thread. Detect the language of the user's message and write your ENTIRE answer in that same language.

Always output JSON: {"answer": string, "confidence": 0-100, "sources": [doc titles used], "needs_escalation": boolean, "language": string, ${CUSTOMER_STATE_SPEC}}. Prior assistant turns are shown to you as plain text; your reply is still the JSON envelope, and "answer" holds exactly what the person should read — no JSON, no preamble, no labels. "language" is the language you wrote the answer in (e.g. "English", "Spanish"). Confidence reflects how well the documents support the answer. Decide needs_escalation on whether a human is genuinely needed (someone blocked, going in circles, or angry usually is), never on whether documents happened to match.`;

    const res = await llmMessages(admin, {
      model, max_tokens: 1024,
      system: [
        { type: 'text', text: instructionBlock, cache_control: { type: 'ephemeral' } },
        // Injection firewall (#9): same marking as the streaming path.
        { type: 'text', text: `Knowledge documents:\n${wrapUntrusted(context, 'knowledge-documents')}${identityMemoryContext}${FIREWALL_RULES}` },
      ],
      messages: turns,
    }, 'widget-ask');
    if (!res.ok) {
      const detail = await res.text();
      console.error('Anthropic error', res.status, detail);
      return json({ error: 'llm_error', status: res.status, conversation_id: convId }, 502);
    }
    const data = await res.json();
    const raw: string = (data.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '';
    const parsed = parseAnswerEnvelope(raw);
    const customerState = parseCustomerState(parsed.customer_state);

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
    // Never cache a follow-up: its answer was shaped by turns the next asker
    // will not have (same reasoning as the cache read above).
    if (qEmbedding && !isFollowUp && !identityMemoryContext && parsed.confidence >= cacheQualityBar && !escalationRuleHit && !parsed.needs_escalation) {
      const blockedBy = await checkAnswerGuardrails(admin, tenantId, parsed.answer, subjectDeId, 'widget-ask');
      if (!blockedBy) {
        await admin.from('answer_cache').insert({
          tenant_id: tenantId, account_id: null, de_id: subjectDeId, question,
          question_embedding: qEmbedding, answer: parsed.answer, confidence: parsed.confidence, sources: parsed.sources,
          // Tag the ANSWER's language (model-reported) so the language gate
          // in match_cached_answer can keep languages apart (migration 164).
          language: parsed.language ?? 'English',
        });
      }
    }

    return await finalize(parsed.answer, parsed.confidence, parsed.sources, parsed.language, false, customerState);
  } catch (err) {
    console.error('widget-ask error:', err);
    await reportEdgeError('widget-ask', err, {});
    return json({ error: String(err) }, 500);
  }
});
