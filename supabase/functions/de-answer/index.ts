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
import { hasLLMProvider, llmMessages } from '../_shared/llm.ts';
import { resolveDePersona, type DePersonaOverrides } from '../_shared/dePersona.ts';
import { resolveDeModel, DEFAULT_MODEL } from '../_shared/deModel.ts';
import { loadTenantGate, TENANT_SUSPENDED_BODY } from '../_shared/tenantStatus.ts';
import { wrapUntrusted, FIREWALL_RULES } from '../_shared/injectionSafety.ts';
import { recordSpan } from '../_shared/otel.ts';
import { evaluateEscalation, type EscRuleset } from '../_shared/escalation.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// GI-6b: a proposed persona for DRY-RUN measurement only. Whitelists exactly the
// three fields that are both resolveDePersona-visible AND 'de'-amendment-editable
// (mig 211). Drops non-strings, empties, and unknown keys; clamps length to match
// entity-amend's field cap. Returns null when nothing usable remains — and a null
// override is byte-identical to a normal answer. Presence forces replay mode
// (below), so a candidate persona can NEVER touch a real customer-facing answer.
function sanitizeCandidatePersona(v: unknown): DePersonaOverrides | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const out: DePersonaOverrides = {};
  let any = false;
  for (const k of ['persona_name', 'description', 'purpose_statement'] as const) {
    const raw = src[k];
    if (typeof raw === 'string') {
      const s = raw.trim().slice(0, 2000);
      if (s) { out[k] = s; any = true; }
    }
  }
  return any ? out : null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const ESCALATION_THRESHOLD = 60; // confidence below this → human task
const MAX_CONTEXT_CHARS = 6000;
// Model resolves per-DE (Wave 1.2, _shared/deModel.ts); DEFAULT_MODEL
// is the fallback when the DE has no model_id configured.
// Cosine distance for semantic cache hits. 0.05 = near-verbatim repeats
// only. The previous 0.15 sat exactly at the collision boundary between
// DIFFERENT questions in the same product domain (measured live on Acme:
// distinct support questions bottom out at 0.152 pairwise) — the golden
// QA suite's first run caught the cache serving the trade-shift answer
// to "how do I view schedules" and 5 other crossed pairs at confidence
// 95. The cache exists for the 400th phrasing of the SAME question, not
// for its topical neighbors.
const CACHE_MAX_DISTANCE = 0.05;

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

// Fail-CLOSED sentinel: if the guardrail resolver itself errors (or returns no
// rule set) we cannot PROVE the answer was screened, so we treat it as blocked
// and route to a human rather than release an unscreened reply during a transient
// DB blip (production-readiness audit — the old behavior failed open).
const GUARDRAIL_RESOLVER_ERROR: GuardrailRule = { id: '__resolver_error__', rule: 'answer screening unavailable', rule_type: 'resolver_error', pattern: null, applies_to: 'answer' };

// deno-lint-ignore no-explicit-any
async function checkAnswerGuardrails(admin: any, tenantId: string, answer: string, deId: string | null): Promise<GuardrailRule | null> {
  try {
    // Scope-aware (Wave 2a): the resolver returns workspace rules plus any
    // department/employee-scoped rules for this DE. A null DE → workspace only.
    const { data: rules } = await admin
      .rpc('guardrail_rules_for_de', {
        p_tenant_id: tenantId,
        p_de_id: deId,
        p_rule_types: ['blocked_phrase', 'blocked_topic'],
      });
    if (!Array.isArray(rules)) return GUARDRAIL_RESOLVER_ERROR;   // screening didn't run → fail closed
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
    // Wave-1 (truth audit 2026-07-22): fail-open stays (availability), but it
    // is no longer SILENT — a durable incident lands on the employee's record
    // so a broken guardrail resolver can't hide.
    console.error('guardrail check failed (fail-closed → escalating):', e);
    try {
      await admin.from('de_incidents').insert({
        tenant_id: tenantId, de_id: deId, kind: 'guardrail_block', severity: 'critical',
        title: 'Guardrail check FAILED — answer withheld and escalated (fail-closed)',
        detail: { error: String((e as Error)?.message ?? e).slice(0, 400), path: 'de-answer' },
        source_table: 'guardrail_rules', source_id: null, occurred_at: new Date().toISOString(),
      });
    } catch { /* best-effort */ }
    return GUARDRAIL_RESOLVER_ERROR;   // can't prove screening ran → route to a human
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

// ── Pre-send Quality Auditor (opt-in Support hardening) ──
// Before an answer is AUTO-SENT (not already escalating), the certified
// eval-judge independently verifies it is grounded in the DE's own knowledge
// and factually correct — the pre-send hallucination / unsupported-claim check
// the live path otherwise lacks (guardrail-regex + confidence only). This can
// ONLY make the DE more cautious: a fail / weak-grounding verdict routes the
// answer to a human, never the reverse. Reuses eval-judge server-to-server via
// the dispatch secret, so there is no second, divergent judge to keep in sync.
// deno-lint-ignore no-explicit-any
async function preSendAudit(admin: any, tenantId: string, deId: string | null, question: string, answer: string): Promise<{ clean: boolean; reason: string }> {
  const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
  const { data, error } = await admin.functions.invoke('eval-judge', {
    body: { tenant_id: tenantId, de_id: deId, question, answer },
    headers: dispatch ? { 'x-dispatch-secret': dispatch } : {},
  });
  if (error) throw error;
  const d = (data ?? {}) as { verdict?: string; dimensions?: Record<string, unknown>; rationale?: string; error?: string };
  if (d.error) throw new Error(d.error);
  const verdict = String(d.verdict ?? 'partial');
  const grounded = Number(d.dimensions?.grounded ?? 0);
  const correct = Number(d.dimensions?.correct ?? 0);
  const clean = verdict !== 'fail' && grounded >= 60 && correct >= 60;
  return {
    clean,
    reason: clean ? '' : `${verdict} (grounded ${grounded}, correct ${correct})${d.rationale ? ' — ' + d.rationale : ''}`.slice(0, 300),
  };
}

// ── Robust JSON parse of model output ──
interface DEAnswer { answer: string; confidence: number; sources: string[]; needs_escalation: boolean }

// Salvage the "answer" string field from MALFORMED or TRUNCATED JSON —
// manual scan with escape handling, tolerating a missing closing quote
// (the max_tokens-truncation case). Returns clean prose or null.
function extractAnswerField(text: string): string | null {
  const m = text.match(/"answer"\s*:\s*"/);
  if (!m || m.index === undefined) return null;
  let i = m.index + m[0].length;
  let out = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const n = text[i + 1];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === '"') out += '"';
      else if (n === '\\') out += '\\';
      else if (n === 'u') {
        const cp = parseInt(text.slice(i + 2, i + 6), 16);
        if (!Number.isNaN(cp)) out += String.fromCharCode(cp);
        i += 4;
      } else out += n ?? '';
      i += 2;
    } else if (c === '"') break;   // clean close; truncation just runs out
    else { out += c; i += 1; }
  }
  const trimmed = out.trim();
  return trimmed.length >= 3 ? trimmed : null;
}

function parseModelJson(raw: string, depth = 0): DEAnswer {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const p = JSON.parse(text.slice(start, end + 1));
      let answer = typeof p.answer === 'string' ? p.answer : raw.trim();
      // Nested envelope (model quoted its own JSON): unwrap ONE level.
      if (depth === 0 && answer.trimStart().startsWith('{') && answer.includes('"answer"')) {
        answer = parseModelJson(answer, 1).answer;
      }
      return {
        answer,
        confidence: Math.max(0, Math.min(100, Math.round(Number(p.confidence)) || 0)),
        sources: Array.isArray(p.sources) ? p.sources.map(String) : [],
        needs_escalation: !!p.needs_escalation,
      };
    } catch { /* fall through to salvage */ }
  }
  // Malformed/TRUNCATED JSON (e.g. max_tokens cut the envelope mid-string,
  // the replay-path bug that leaked raw JSON to the judge): salvage the
  // answer text + whatever scalar fields survive, never return the wreckage.
  const salvaged = extractAnswerField(text);
  if (salvaged) {
    const conf = text.match(/"confidence"\s*:\s*(\d{1,3})/);
    return {
      answer: salvaged,
      confidence: conf ? Math.max(0, Math.min(100, parseInt(conf[1], 10))) : 50,
      sources: [],
      needs_escalation: /"needs_escalation"\s*:\s*true/.test(text),
    };
  }
  return { answer: raw.trim(), confidence: 50, sources: [], needs_escalation: false };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const reqBody = await req.json();
    const { question, conversation_id, de_id, tenant_id, candidate_knowledge, candidate_persona } = reqBody;
    if (!question || typeof question !== 'string') {
      return json({ error: 'question required' }, 400);
    }
    // Replay mode (Frontier-20 #5/#6): a DRY-RUN answer. Suppressed: every
    // BUSINESS side effect — conversation/message rows, cache read+write,
    // inquiry metric, memory, escalation tasks, activity, outcome metering,
    // spans. NOT suppressed (deliberately): llm_calls + token-usage
    // recording — real spend occurred and must stay budget-metered, or
    // replays would be an unmetered-spend hole. Each replay also writes one
    // audit event so dry runs are visible in the audit trail, never silent.
    const candidateKnowledge = typeof candidate_knowledge === 'string' ? candidate_knowledge.trim() : '';
    // GI-6b: a proposed-persona counterfactual (amendment fitness measurement).
    // Its PRESENCE forces replay mode below, so every business side effect is
    // suppressed — the candidate persona only shapes this dry-run's preamble and
    // can never leak into a real customer answer.
    const candidatePersona = sanitizeCandidatePersona(candidate_persona);
    // replay === true forces replay semantics even with no candidate
    // knowledge (question-only counterfactuals in the Replay Lab).
    const replayMode = candidateKnowledge.length > 0 || candidatePersona !== null || reqBody.replay === true;
    // GI-6b: a caller may pin temperature ONLY on the dry-run/measurement path
    // (fitness replay needs T=0 for a stable pass-count delta). A live customer
    // answer can NEVER be temperature-overridden — the replayMode gate guarantees it.
    const replayTemperature = replayMode && typeof reqBody.temperature === 'number' && Number.isFinite(reqBody.temperature)
      ? Math.max(0, Math.min(1, reqBody.temperature)) : undefined;
    const spanStart = new Date().toISOString();   // OTel (#13)

    // ── Auth: service/dispatch caller with an explicit tenant (what
    // lets eval-run drive the suite headless — same dual pattern as
    // ingest-chunks/knowledge-gap-detect), or a user JWT ──
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
      const asserted = (typeof tenant_id === 'string' && /^[0-9a-f-]{36}$/i.test(tenant_id)) ? tenant_id : null;
      if (!asserted) return json({ error: 'tenant_id required for service calls' }, 400);
      tenantId = asserted;
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

      const { data: profile } = await admin
        .from('profiles')
        .select('tenant_id')
        .eq('user_id', userData.user.id)
        .single();
      tenantId = profile?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // ── Trial/suspension gate (teeth for expire_trials): a suspended
    // workspace does no paid AI work — refuse BEFORE any conversation
    // write or LLM spend. ──
    const gate = await loadTenantGate(admin, tenantId);
    if (gate.suspended) return json(TENANT_SUSPENDED_BODY, 402);
    const tenantName = gate.name;

    // ── KNOWLEDGE SCOPES (migration 030): resolve the answering DE
    // subject. Optional body.de_id (must be in-tenant); default = the
    // tenant's first DE (the 025/029 fallback pattern). Retrieval RPCs
    // filter scoped docs server-side by this subject.
    // Lifecycle eligibility (DE-B4, migration 126): a paused or
    // retired employee never answers. An explicitly requested DE in
    // one of those stages is an honest refusal, not a silent swap;
    // the auto-resolved fallback picks the next eligible one.
    let subjectDeId: string | null = null;
    if (typeof de_id === 'string' && de_id) {
      const { data: reqDe } = await admin.from('digital_employees')
        .select('id, lifecycle_status').eq('id', de_id).eq('tenant_id', tenantId).maybeSingle();
      if (!reqDe) return json({ error: 'de_not_in_tenant' }, 403);
      if (['paused', 'retired', 'archived'].includes(String(reqDe.lifecycle_status))) {
        return json({ error: 'de_not_available', detail: `This employee is ${reqDe.lifecycle_status} and cannot answer.` }, 409);
      }
      subjectDeId = reqDe.id;
    } else {
      const { data: firstDe } = await admin.from('digital_employees')
        .select('id').eq('tenant_id', tenantId)
        .not('lifecycle_status', 'in', '(paused,retired,archived)')
        .order('created_at', { ascending: true }).limit(1).maybeSingle();
      subjectDeId = firstDe?.id ?? null;
    }
    const persona = await resolveDePersona(admin, tenantId, subjectDeId, tenantName, candidatePersona);

    // Wave-1 activation (truth audit 2026-07-22, docs/15): the founder-set
    // trust-dial floor (answer_dock) and escalation rules now govern this
    // LIVE channel — previously only the autonomous triage path read them
    // and this path ran a hardcoded threshold.
    let confidenceFloor: number = ESCALATION_THRESHOLD;
    let escalationRuleHit: string | null = null;
    let escRuleset: EscRuleset = {};   // mig 262: the generic condition ruleset
    try {
      const [dialRes, escRes, rowsRes] = await Promise.all([
        admin.rpc('resolve_de_autonomy', { p_tenant_id: tenantId, p_action_type: 'answer_dock', p_de_id: subjectDeId, p_source_category: null }),
        admin.rpc('resolve_de_escalation', { p_tenant_id: tenantId, p_de_id: subjectDeId }),
        admin.from('de_escalation_rules').select('custom_rules, de_id').eq('tenant_id', tenantId),
      ]);
      const dial = Array.isArray(dialRes.data) ? dialRes.data[0] : dialRes.data;
      if (dial?.enabled === false) confidenceFloor = 101;                 // dial off → every answer goes to a human
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

    // ── Conversation (create if needed) + persist the user message ──
    // REPLAY: no conversation is ever created, adopted, or written to — a
    // dry run must not leave rows in the live Support Inbox or inject
    // counterfactual turns into a real transcript (convId stays null, which
    // also disarms every convId-guarded write downstream).
    let convId: string | null = null;
    if (!replayMode) {
      if (typeof conversation_id === 'string' && conversation_id) {
        // Caller-supplied thread: must be a UUID the caller's tenant owns —
        // otherwise messages/outcomes would attach to a foreign or
        // nonexistent conversation ref.
        if (!/^[0-9a-f-]{36}$/i.test(conversation_id)) {
          return json({ error: 'invalid_conversation_id' }, 400);
        }
        const { data: owned } = await admin.from('de_conversations')
          .select('id').eq('id', conversation_id).eq('tenant_id', tenantId).maybeSingle();
        if (!owned) return json({ error: 'conversation_not_found' }, 404);
        convId = conversation_id;
      } else {
        const { data: conv } = await admin
          .from('de_conversations')
          .insert({ tenant_id: tenantId, channel: 'dock', de_id: subjectDeId })
          .select('id').single();
        convId = conv?.id ?? null;
      }
      if (convId) {
        await admin.from('de_messages').insert({
          tenant_id: tenantId, conversation_id: convId, role: 'user', content: question,
        });
      }
    }

    const bump = (metric: string, delta = 1) =>
      admin.rpc('increment_metric_tenant', { p_tenant_id: tenantId, p_metric: metric, p_delta: delta })
        .then(({ error }) => { if (error) console.error('increment_metric_tenant:', error.message); });

    if (!replayMode) await bump('inquiries');

    // ── Semantic answer cache (checked BEFORE any LLM call) ──
    const qEmbedding = await embedText(question);
    if (qEmbedding && !replayMode) {
      const { data: cacheRows } = await admin.rpc('match_cached_answer', {
        p_tenant_id: tenantId,
        p_account_id: null,
        p_query_embedding: qEmbedding,
        p_max_distance: CACHE_MAX_DISTANCE,
        p_de_id: subjectDeId,   // DE-scope the cache (no cross-DE hits)
      });
      const hit = Array.isArray(cacheRows) ? cacheRows[0] : null;
      if (hit) {
        // Re-screen the cached answer against CURRENT guardrails + confidence floor
        // + message escalation before serving — a rule added, floor raised, or
        // escalation matched AFTER caching must not be silently evaded (audit). If
        // it no longer clears the gate, skip the cache and take the full generate+gate path.
        const cachedBlocked = await checkAnswerGuardrails(admin, tenantId, hit.answer, subjectDeId);
        if (!cachedBlocked && Number(hit.confidence) >= confidenceFloor && !escalationRuleHit) {
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
          tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'resolved',
          text: `Answered a chat question instantly from the verified answer cache`,
          confidence: hit.confidence,
        });
        // Outcome metering (#15): a delivered cached answer is a resolution.
        if (convId) {
          await admin.rpc('record_billable_outcome', {
            p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId,
            p_kind: 'resolution', p_source: 'chat',
          });
        }
        return json({
          conversation_id: convId, answer: hit.answer, confidence: hit.confidence,
          sources, needs_escalation: false, cached: true,
          de_id: subjectDeId, de_name: persona.name,
        });
        }   // cached answer cleared the gate; otherwise fall through to full path
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
        de_id: subjectDeId, de_name: persona.name,
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
    // WS2 (mig 280): record which docs this answer consulted, as an incremental
    // rollup — "is my knowledge working" analytics without a read-time scan.
    const citedDocIds = new Set<string>();
    if (Array.isArray(chunks) && chunks.length > 0) {
      for (const c of chunks) {
        const budget = MAX_CONTEXT_CHARS - used;
        if (budget <= 0) break;
        const body = String(c.content ?? '').slice(0, budget);
        const title = c.doc_title ?? 'Knowledge document';
        contextParts.push(`[Document: ${title}]\n${body}`);
        used += body.length + title.length;
        if (c.visibility === 'scoped') scopedContentUsed = true;
        if (c.doc_id) citedDocIds.add(String(c.doc_id));
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
        if ((d as { id?: string }).id) citedDocIds.add(String((d as { id?: string }).id));
      }
    }
    // Fire-and-forget: bump the WS2 usage counters for the docs consulted (skip
    // the replay dry-run, whose "citations" would be a candidate patch, not the
    // live corpus). Non-fatal — analytics must never block an answer.
    if (!candidateKnowledge && citedDocIds.size > 0) {
      admin.rpc('record_knowledge_citations', { p_tenant_id: tenantId, p_doc_ids: [...citedDocIds] })
        .then(({ error }: { error: unknown }) => { if (error) console.error('record_knowledge_citations:', error); });
    }
    // Replay: the proposed patch leads the context (highest priority) and is
    // clearly labelled as a candidate so the model treats it as authoritative
    // reference for this dry run.
    if (candidateKnowledge) {
      contextParts.unshift(`[Candidate knowledge under review — proposed fix, not yet published]\n${candidateKnowledge.slice(0, 4000)}`);
    }
    const context = contextParts.length > 0
      ? contextParts.join('\n\n---\n\n')
      : 'No documents matched the question.';

    // ── Claude ──
    if (!(await hasLLMProvider(admin))) {
      return json({ error: 'llm_not_configured', conversation_id: convId });
    }

    const { data: budgetCheck } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
    if (budgetCheck && budgetCheck.allowed === false) {
      return json({ error: 'ai_budget_exceeded', conversation_id: convId });
    }

    // ── Recall durable memory for this conversation (muscle #4, mig 155) ──
    let memoryContext = '';
    if (subjectDeId && convId) {
      const { data: mems } = await admin.rpc('de_memory_search', {
        p_tenant_id: tenantId, p_de_id: subjectDeId, p_query_embedding: qEmbedding,
        p_subject_kind: 'conversation', p_subject_ref: convId, p_match_count: 5,
      });
      if (Array.isArray(mems) && mems.length > 0) {
        // The framing line is PLATFORM-authored instruction and must sit
        // OUTSIDE the untrusted block (FIREWALL_RULES tells the model block
        // content is never instructions); only the recalled items are data.
        memoryContext = '\n\nWhat you remember from earlier in this conversation (context only — still answer facts from the knowledge documents):\n'
          + wrapUntrusted(mems.map((m: { content: string }) => `- ${m.content}`).join('\n'), 'conversation-memory');
      }
    }

    // Injection firewall (#9): document/memory content is tenant- or
    // web-sourced — marked untrusted, breakout-neutralized, and covered by
    // the standing FIREWALL_RULES the payload can never edit.
    const system = `${persona.preamble} Answer ONLY from the provided knowledge documents. If the documents don't contain the answer, say so plainly and set confidence low. Always output JSON: {"answer": string, "confidence": 0-100, "sources": [doc titles used], "needs_escalation": boolean}. Confidence reflects how well the documents support the answer. Never invent facts.

Knowledge documents:
${wrapUntrusted(context, 'knowledge-documents')}${memoryContext}${FIREWALL_RULES}`;

    const model = subjectDeId ? await resolveDeModel(admin, tenantId, subjectDeId) : DEFAULT_MODEL;
    const res = await llmMessages(admin, {
      model,
      // 1024 truncated long JSON envelopes mid-string (the replay-path
      // parse leak); parseModelJson now salvages truncation too, but not
      // truncating in the first place is the real fix.
      max_tokens: 1536,
      ...(replayTemperature !== undefined ? { temperature: replayTemperature } : {}),
      system,
      messages: [{ role: 'user', content: question }],
    }, 'de-answer');
    if (!res.ok) {
      const detail = await res.text();
      console.error('Anthropic error', res.status, detail);
      return json({ error: 'llm_error', status: res.status, conversation_id: convId }, 502);
    }
    const data = await res.json();
    // Claude 5 models can emit a 'thinking' block before the text block —
    // take the first block that is actually text (see widget-ask, DE-A2).
    const raw: string = (data.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '';
    const parsed = parseModelJson(raw);
    await bump('llm_calls');
    if (subjectDeId) {
      admin.rpc('record_de_token_usage', {
        p_tenant_id: tenantId, p_de_id: subjectDeId, p_model_id: model,
        p_input_tokens: data.usage?.input_tokens ?? 0, p_output_tokens: data.usage?.output_tokens ?? 0,
      }).then(({ error }: { error: unknown }) => { if (error) console.error('record_de_token_usage:', error); });
    }

    // ── Guardrail check on the answer text (P3 — blocks + escalates) ──
    // The check itself runs in EVERY mode — guardrails always win, and a
    // replay must honestly report that the answer would have been blocked.
    // The PERSISTENCE (message, human task, activity, audit, metering) is
    // real-traffic-only: a dry run must never open a real escalation.
    const blockedBy = await checkAnswerGuardrails(admin, tenantId, parsed.answer, subjectDeId);
    if (blockedBy) {
      const truncated = question.length > 60 ? question.slice(0, 60) + '…' : question;
      if (!replayMode) {
        if (convId) {
          await admin.from('de_messages').insert({
            tenant_id: tenantId, conversation_id: convId, role: 'assistant',
            content: GUARDRAIL_BLOCK_MESSAGE, confidence: 0, escalated: true,
          });
        }
        await admin.from('human_tasks').insert({
          tenant_id: tenantId,
          de_id: subjectDeId,
          type: 'escalation',
          source: 'de',
          title: `Guardrail block — ${truncated}`,
          detail: `${persona.name}'s draft answer was blocked by guardrail "${blockedBy.rule}". Draft (confidence ${parsed.confidence}%): ${parsed.answer}`,
          related_table: convId ? 'de_conversations' : null,
          related_id: convId,
        });
        await admin.from('activity_events').insert({
          tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'escalated',
          text: `Answer BLOCKED by guardrail "${blockedBy.rule}" — escalated to human review`,
          confidence: parsed.confidence,
        });
        await auditEvent(admin, tenantId, persona.name, 'de',
          `BLOCKED — chat answer matched guardrail "${blockedBy.rule}" and was withheld; escalated to human`,
          'guardrail_block',
          { rule_id: blockedBy.id, rule: blockedBy.rule, rule_type: blockedBy.rule_type, question: truncated });
        // Outcome metering (#15): a guardrail block hands off to a human —
        // metered FREE, and it belongs in the benchmark's denominator
        // (consistent with widget-ask; without this, chat blocks silently
        // inflated the honest resolution rate).
        if (convId) {
          await admin.rpc('record_billable_outcome', {
            p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId,
            p_kind: 'escalation', p_source: 'chat',
          });
        }
        await recordSpan(admin, {
          tenant_id: tenantId, name: 'chat de-answer', kind: 'agent', started_at: spanStart,
          attributes: {
            'gen_ai.operation.name': 'chat', 'gen_ai.system': 'anthropic',
            'gen_ai.request.model': model,
            'gen_ai.usage.input_tokens': data.usage?.input_tokens ?? 0,
            'gen_ai.usage.output_tokens': data.usage?.output_tokens ?? 0,
            'dreamteam.de_id': subjectDeId, 'dreamteam.guardrail_blocked': true,
            'dreamteam.conversation_id': convId,
          },
        });
      }
      return json({
        conversation_id: convId,
        blocked: true,
        rule: blockedBy.rule,
        answer: GUARDRAIL_BLOCK_MESSAGE,
        confidence: 0,
        sources: [],
        needs_escalation: true,
        de_id: subjectDeId, de_name: persona.name,
      });
    }

    // Post-answer: re-evaluate now that confidence is known, so conditions on
    // confidence/sentiment (not just text) can fire.
    if (!escalationRuleHit) {
      const post = evaluateEscalation(escRuleset, { message_text: String(question ?? ''), confidence: parsed.confidence });
      if (post.escalate) escalationRuleHit = post.rule ?? 'escalation rule';
    }
    let escalate = parsed.needs_escalation || parsed.confidence < confidenceFloor || escalationRuleHit !== null;

    // ── Pre-send Quality Auditor (opt-in per DE) ── an answer that WOULD be
    // auto-sent is independently judged for grounding + correctness first.
    // Inert unless the DE opts in (pre_send_audit_enabled); fail-closed WHEN
    // ENABLED (audit unavailable → route to a human rather than auto-send). It
    // reuses the existing escalation path below by only ever setting escalate.
    if (!replayMode && !escalate && subjectDeId) {
      let auditEnabled = false;
      try {
        const { data: acfg } = await admin.rpc('get_de_config', {
          p_tenant_id: tenantId, p_entity_kind: 'de', p_entity_id: subjectDeId,
        });
        auditEnabled = acfg?.data?.pre_send_audit_enabled === true;
      } catch { /* config unreadable → treat as not opted in; never disrupt DEs that didn't enable it */ }
      if (auditEnabled) {
        try {
          const verdict = await preSendAudit(admin, tenantId, subjectDeId, question, parsed.answer);
          if (!verdict.clean) {
            escalate = true;
            await auditEvent(admin, tenantId, persona.name, 'de',
              `Pre-send quality audit routed an answer to a human — ${verdict.reason}`,
              'evidence_step', { kind: 'pre_send_audit', conversation_id: convId, confidence: parsed.confidence });
          }
        } catch (e) {
          escalate = true; // enabled but the audit itself failed → fail closed
          console.error('pre-send audit failed closed → escalate:', e);
          await auditEvent(admin, tenantId, persona.name, 'de',
            'Pre-send quality audit unavailable — routed the answer to a human',
            'evidence_step', { kind: 'pre_send_audit_error', conversation_id: convId });
        }
      }
    }

    // ── Semantic cache write (only good, non-escalated answers; never
    // answers built from scoped docs — the cache is tenant-wide) ──
    if (qEmbedding && !escalate && !scopedContentUsed && !replayMode) {
      await admin.from('answer_cache').insert({
        tenant_id: tenantId,
        account_id: null,
        de_id: subjectDeId,   // DE-scope the cache (no cross-DE hits)
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

    // ── Remember this exchange (muscle #4), conversation-scoped, so the
    // DE recalls it on the next turn. Awaited (not fire-and-forget): the
    // edge isolate can be torn down the moment we return, cutting off a
    // floating promise, so a bare .then() write is silently dropped. Only
    // good, non-escalated answers are worth remembering. ──
    if (subjectDeId && convId && !escalate && !replayMode) {
      try {
        const memEmb = await embedText(`Q: ${question}\nA: ${parsed.answer}`.slice(0, 2000));
        await admin.rpc('de_memory_write', {
          p_tenant_id: tenantId, p_de_id: subjectDeId,
          p_content: `Customer asked: "${question}" — I answered: ${parsed.answer.slice(0, 500)}`,
          p_embedding: memEmb, p_subject_kind: 'conversation', p_subject_ref: convId,
          p_kind: 'episodic', p_salience: Math.min(1, parsed.confidence / 100), p_source: 'de',
        });
      } catch (e) { console.error('de_memory_write:', e); }
    }

    // Outcome metering (#15): resolution bills per tenant pricing;
    // escalation meters FREE. Idempotent per conversation; never in replay.
    if (!replayMode && convId) {
      await admin.rpc('record_billable_outcome', {
        p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId,
        p_kind: escalate ? 'escalation' : 'resolution', p_source: 'chat',
      });
    }

    // OTel GenAI span (#13, mig 177) — best-effort, never in replay.
    if (!replayMode) {
      await recordSpan(admin, {
        tenant_id: tenantId, name: 'chat de-answer', kind: 'agent', started_at: spanStart,
        attributes: {
          'gen_ai.operation.name': 'chat', 'gen_ai.system': 'anthropic',
          'gen_ai.request.model': model,
          'gen_ai.usage.input_tokens': data.usage?.input_tokens ?? 0,
          'gen_ai.usage.output_tokens': data.usage?.output_tokens ?? 0,
          'dreamteam.de_id': subjectDeId, 'dreamteam.confidence': parsed.confidence,
          'dreamteam.escalated': escalate, 'dreamteam.conversation_id': convId,
        },
      });
    }

    // ── Escalation + activity ── (business writes skipped in replay; one
    // audit line keeps dry runs visible in the trail, never silent)
    if (replayMode) {
      await auditEvent(admin, tenantId, persona.name, 'de',
        `REPLAY (dry run) — answered "${question.length > 60 ? question.slice(0, 60) + '…' : question}" with zero business side effects${candidateKnowledge ? ' (candidate knowledge injected)' : ''}`,
        'evidence_step', { kind: 'replay_run', confidence: parsed.confidence, would_escalate: escalate, candidate: candidateKnowledge.length > 0 });
    } else if (escalate) {
      await bump('escalations');
      const truncated = question.length > 60 ? question.slice(0, 60) + '…' : question;
      await admin.from('human_tasks').insert({
        tenant_id: tenantId,
        de_id: subjectDeId,
        type: 'escalation',
        source: 'de',
        title: `Chat escalation — ${truncated}`,
        detail: `${escalationRuleHit ? `Matched ${escalationRuleHit}. ` : ''}${persona.name}'s draft answer (confidence ${parsed.confidence}%): ${parsed.answer}`,
        related_table: convId ? 'de_conversations' : null,
        related_id: convId,
      });
      await admin.from('activity_events').insert({
        tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'escalated',
        text: `Chat question escalated to human review — "${truncated}"`,
        confidence: parsed.confidence,
      });
      // W4-D (docs/16, mig 252): a live-channel miss with no knowledge
      // grounding now feeds the self-healing loop — a minimal evidence row
      // makes this question clusterable by the gap detector, which was
      // previously blind to chat entirely.
      if (parsed.sources.length === 0) {
        try {
          const { data: er } = await admin.from('evidence_runs').insert({
            tenant_id: tenantId, de_id: subjectDeId, inquiry: question.slice(0, 2000),
            status: 'complete', steps: [], answer_status: 'answered',
            confidence_inputs: { knowledge_hits: 0 },
          }).select('id').single();
          if (er?.id) {
            await admin.from('evidence_run_decisions').insert({
              tenant_id: tenantId, evidence_run_id: er.id, source: 'live_channel',
              decision: 'needs_review', confidence: parsed.confidence, source_category: 'support',
            });
          }
        } catch (e) { console.error('gap bridge (chat):', e); }
      }
      await auditEvent(admin, tenantId, persona.name, 'de',
        `Chat question escalated to human review — "${truncated}"`,
        'escalated', { confidence: parsed.confidence, conversation_id: convId });
    } else {
      await admin.from('activity_events').insert({
        tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'resolved',
        text: `Answered a chat question from knowledge docs (${parsed.sources.join(', ') || 'no sources cited'})`,
        confidence: parsed.confidence,
      });
      await auditEvent(admin, tenantId, persona.name, 'de',
        `Resolved a chat question from knowledge docs (${parsed.sources.join(', ') || 'no sources cited'})`,
        'resolved', { confidence: parsed.confidence, conversation_id: convId });
    }

    // ── Reply-Mode: Draft approval flow ──
    // If reply_mode_enabled, submit draft for human review instead of sending directly.
    // Check configuration for this DE; if set, create draft_responses row and return draft_id.
    let draftId: string | null = null;
    if (!replayMode && !escalate && subjectDeId && convId) {
      try {
        const { data: config } = await admin.rpc('get_de_config', {
          p_tenant_id: tenantId, p_entity_kind: 'de', p_entity_id: subjectDeId,
        });
        const replyModeEnabled = config?.data?.reply_mode_enabled === true ||
                                 config?.data?.preapproval_strategy === 'all';
        if (replyModeEnabled) {
          const { data: draftResp } = await admin.rpc('submit_draft_for_review', {
            p_de_id: subjectDeId, p_conversation_id: convId,
            p_user_question: question, p_draft_content: parsed.answer,
            p_confidence: parsed.confidence / 100, p_sources: parsed.sources.map(s => ({ title: s, url: '' })),
          });
          if (draftResp?.draft_id) {
            draftId = draftResp.draft_id;
            // Record audit event for draft submission
            await auditEvent(admin, tenantId, persona.name, 'de',
              `Draft submitted for human review (${parsed.confidence}% confidence) — "${question.slice(0, 60)}"`,
              'draft_submitted', { draft_id: draftId, confidence: parsed.confidence, conversation_id: convId });
          }
        }
      } catch (e) {
        console.error('reply-mode draft submission failed (continue with normal flow):', e);
      }
    }

    return json({
      conversation_id: convId,
      answer: parsed.answer,
      confidence: parsed.confidence,
      sources: parsed.sources,
      needs_escalation: escalate,
      draft_id: draftId, // included if reply-mode submitted
      de_id: subjectDeId, de_name: persona.name,
    });
  } catch (err) {
    console.error('de-answer error:', err);
    return json({ error: String(err) }, 500);
  }
});
