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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { embedText } from '../_shared/knowledgeEmbed.ts';
import { hasLLMProvider, llmMessages } from '../_shared/llm.ts';
import { resolveDePersona, type DePersonaOverrides } from '../_shared/dePersona.ts';
import { semanticGate, loadBlockingRulesForJudge, semanticGuardrailScreen } from '../_shared/guardrailJudge.ts';
import { groundedConfidence } from '../_shared/groundedConfidence.ts';
import { resolveDeModel, DEFAULT_MODEL } from '../_shared/deModel.ts';
import { loadTenantGate, TENANT_SUSPENDED_BODY } from '../_shared/tenantStatus.ts';
import { wrapUntrusted, FIREWALL_RULES } from '../_shared/injectionSafety.ts';
import { recordSpan } from '../_shared/otel.ts';
import { evaluateEscalation, type EscRuleset } from '../_shared/escalation.ts';
import { buildTurns, parseCustomerState, stateSignals, CUSTOMER_STATE_SPEC } from '../_shared/conversation.ts';
import { findBlockingMatch } from '../_shared/guardrailMatch.ts';
import { adjudicateRegexHit, type AdjHit } from '../_shared/guardrailAdjudicator.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';
import { budgetBlocked } from '../_shared/rpcSafety.ts';
import { rankDocs, parseAnswerEnvelope } from '../_shared/answerEnvelope.ts';
import { checkAnswerGuardrails, GUARDRAIL_RESOLVER_ERROR } from '../_shared/answerGuardrails.ts';
import { classifyAndRoute, chooseAnswerer, triageColumns, type Answerer, type RoutedTopic } from '../_shared/topicRouting.ts';
import { serviceCaller } from '../_shared/serviceCaller.ts';

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

interface KDoc { id: string; title: string; content: string; tags: string[]; visibility?: string }

// ══════════════════════════════════════════════════════════════════════════
// THE "I HAVE NO DOCUMENTS" RECOVERY PATH
//
// WHY, from production rather than theory: of 16 workspaces only the founder's
// ever reached first value, and BOTH genuine outside signups died at exactly
// this branch with zero knowledge documents — "acs" (2026-07-24) and "Harbor
// Peak Consulting" (2026-07-06). The acs evaluator asked four real support
// questions in twenty seconds (de_messages 14:54:45 → 14:55:05) and got the
// same sentence four times: "I don't have any knowledge documents yet — upload
// some in Knowledge → Library and I'll answer from them." Then they left.
//
// That sentence was HONEST and it was a DEAD END: it named a location instead
// of offering an action, it offered to do nothing, and repeating it verbatim
// burned four separate chances to recover the user. Refusing to answer without
// documents is the whole point of this product and does not change here. What
// changes is that the refusal now carries a way out.
// ══════════════════════════════════════════════════════════════════════════

/**
 * The machine-readable half of a no-documents reply. The prose asks for a
 * website address; this is what lets the UI put a real input right under the
 * message instead of sending the person off to find a page.
 *
 * Consumer contract (frontend + de-orchestrate pass-through):
 *   kind      Discriminant — switch on it. More kinds may be added later, so an
 *             unrecognised kind MUST degrade to rendering `answer` alone.
 *   prompt    One line to show above the input, in the employee's voice.
 *   cta       Button label.
 *   fn        Edge function to POST to, body { url, max_pages }.
 *   max_pages Suggested crawl budget only — site-import owns the real cap and
 *             clamps; never treat this as a promise about how much it read.
 *   attempt   1 = first time this workspace has hit the wall in the last
 *             NO_DOCS_WINDOW_HOURS, 2 = second, 3+ = it has been said enough
 *             times that the UI should stop being subtle about it.
 *   fallback  The other way in, for a business whose knowledge is not on a
 *             website at all.
 */
interface RecoveryHint {
  kind: 'import_site';
  prompt: string;
  cta: string;
  fn: 'site-import';
  max_pages: number;
  attempt: number;
  fallback: { kind: 'upload_document'; prompt: string };
}

/** How far back a previous "I have nothing to read" reply still counts as a
 *  repeat. One sitting, not forever: a workspace that comes back next week and
 *  asks its first question deserves the full offer again, not the third-strike
 *  wording. */
const NO_DOCS_WINDOW_HOURS = 24;

/** Suggested crawl budget handed to the UI. Enough to cover a small business's
 *  entire help/policy surface; site-import clamps to its own maximum. */
const NO_DOCS_SUGGESTED_MAX_PAGES = 40;

/**
 * How many times this workspace has ALREADY been told there is nothing to
 * answer from, inside the window.
 *
 * ⚠ SCOPE IS TENANT-WIDE, NOT CONVERSATION-SCOPED, and that is the entire
 * point. The four identical replies that lost the acs signup landed in FOUR
 * DIFFERENT conversations — verified live: 5dba1e03…, f0dffa05…, 157ad24d…,
 * 787c431a…, all channel 'dock', all the same employee, all inside 20 seconds.
 * The dock opens a fresh conversation per question whenever the caller sends no
 * conversation_id (see the de_conversations insert below), so a
 * per-conversation check would have caught ZERO of those repeats. It is also
 * the right scope for the human: the person hears every employee, so a second
 * employee re-reading them the same offer is still a repeat.
 *
 * Counts the marker written by this branch (confidence_dimensions->>no_docs),
 * not the message text — the wording escalates, so matching on prose would
 * stop recognising its own history the moment someone edits a sentence.
 * Historical rows (including the four acs ones) carry no marker and are
 * invisible here; this is forward-looking by construction.
 *
 * Fails to 0 — a counting hiccup should hand out the friendly first-time offer,
 * never accuse someone of asking repeatedly.
 */
// deno-lint-ignore no-explicit-any
async function countPriorNoDocsReplies(admin: any, tenantId: string): Promise<number> {
  try {
    const since = new Date(Date.now() - NO_DOCS_WINDOW_HOURS * 3600_000).toISOString();
    const { count, error } = await admin
      .from('de_messages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)                          // de_messages_tenant_idx
      .eq('role', 'assistant')
      .eq('confidence_dimensions->>no_docs', 'true')
      .gte('created_at', since);
    if (error) { console.error('countPriorNoDocsReplies:', error.message); return 0; }
    return Number(count) || 0;
  } catch (e) {
    console.error('countPriorNoDocsReplies:', String(e));
    return 0;
  }
}

/** Longest echo of the person's own question we will quote back. Long enough to
 *  prove we read it, short enough that it cannot become a payload. */
const ECHO_MAX_CHARS = 96;

/**
 * A short, NON-FABRICATING reflection of what was actually asked — their words,
 * never a paraphrase, because a paraphrase of a question we cannot answer is
 * already a small invention.
 *
 * ⚠ The stripped characters are not cosmetic. This string is stored as an
 * ASSISTANT message, and buildTurns (_shared/conversation.ts) replays assistant
 * messages back into a LATER turn's prompt — so a verbatim echo is a route for
 * attacker-supplied text to arrive wearing the employee's own voice. Brackets,
 * angle brackets, braces and backticks are what a forged turn or a fake system
 * block is built out of; the double quote is what would break out of the quotes
 * we wrap this in. Stripped, flattened to one line and capped at
 * ECHO_MAX_CHARS, there is nothing left to forge with. (Same threat model as
 * _shared/injectionSafety.ts, which wraps untrusted DOCUMENT text before it
 * reaches a model.) Apostrophes are deliberately kept — "don't" must not become
 * "dont", or the echo reads like a bug.
 */
function echoQuestion(raw: string): string {
  const flat = String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["\[\]<>{}`\\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (flat.length < 12) return '';            // "hi" / "test" — nothing worth reflecting
  if (flat.length <= ECHO_MAX_CHARS) return flat;
  const cut = flat.slice(0, ECHO_MAX_CHARS);
  const sp = cut.lastIndexOf(' ');
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[,;:.\-–—]+$/, '') + '…';
}

/** The employee's own framing of who it is, so the refusal reads as a new
 *  colleague who has not been briefed rather than a 404. display_title is an
 *  EMPTY STRING on most rows (verified live: 116/116 non-null, nearly all ''),
 *  so it is tested for content, not for null; department is the real fallback
 *  and is sometimes snake_case ('customer_support'), which reads badly quoted
 *  verbatim. */
function briefingClause(displayTitle: string | null, department: string | null): string {
  const title = String(displayTitle ?? '').trim();
  if (title) return `I'm the ${title} here, but nobody has briefed me`;
  const dept = String(department ?? '').trim().replace(/[_-]+/g, ' ');
  if (dept) return `I'm here for ${dept}, but nobody has briefed me`;
  return `Nobody has briefed me yet`;
}

/**
 * What the employee says when it has nothing to answer from.
 *
 * Escalates by attempt, because saying the identical thing four times is what
 * actually lost the acs signup. First time: acknowledge the question, explain
 * the real problem, offer the import. Second: name the repetition and be blunt
 * that this does not fix itself. Third and beyond: stop re-explaining — short,
 * not chirpy, not apologetic-in-a-loop.
 */
function noDocsAnswer(attempt: number, echo: string, briefing: string): string {
  const about = echo ? ` about "${echo}"` : '';
  if (attempt <= 1) {
    return [
      `I can't answer that yet — and I'd rather say so than guess at it.`,
      ``,
      `${briefing}: this workspace has no knowledge documents at all, so anything I told you${about} would be something I made up.`,
      ``,
      `Give me your website address and I'll read it — help pages, policies, FAQs, whatever is there — and come back able to answer this properly. It takes a couple of minutes. If what I need lives in a document instead of on your site, send me that.`,
    ].join('\n');
  }
  if (attempt === 2) {
    return [
      `Same wall as your last question. I still have nothing to read, so I can't answer this one${about} either.`,
      ``,
      `This doesn't sort itself out — I only know what I'm given. Your website address is the fastest fix: I'll read the site and come back useful. A single document works too.`,
    ].join('\n');
  }
  return [
    `Still nothing to answer from — that's ${attempt} questions I've had to turn down, including this one${about}.`,
    ``,
    `Nothing changes until knowledge lands. Your website address, or one document. Either one, and I can actually do this job.`,
  ].join('\n');
}

/** The offer, in the same voice as the prose above it, escalating with it. */
function noDocsRecovery(attempt: number): RecoveryHint {
  return {
    kind: 'import_site',
    prompt: attempt <= 1
      ? `Paste your website address and I'll read it now.`
      : `Still the fastest fix — paste your website address and I'll read it.`,
    cta: attempt <= 1 ? 'Read my website' : 'Read my website now',
    fn: 'site-import',
    max_pages: NO_DOCS_SUGGESTED_MAX_PAGES,
    attempt,
    fallback: { kind: 'upload_document', prompt: 'Or send me a document instead' },
  };
}

// ── Guardrail check (P3, honest v1: case-insensitive pattern match) ──
// Patterns are '|'-separated substrings/regex fragments. Blocking rules
// (blocked_phrase / blocked_topic) that match the ANSWER text block it.
interface GuardrailRule { id: string; rule: string; rule_type: string; pattern: string | null; applies_to: string }

// GI-8: the full answer screen = deterministic regex FIRST (cheap, always runs),
// then the semantic judge (augments, never replaces) only when regex is clean and
// the tenant has the flag on. Fail-closed: a rules-fetch failure routes to a human.
// deno-lint-ignore no-explicit-any
async function screenAnswer(
  admin: any, tenantId: string, answer: string, deId: string | null,
  // onClear is request-scoped ON PURPOSE. A module-scope flag would leak
  // across requests in a warm isolate and suppress caching for later,
  // unrelated answers.
  ctx: { question: string; actor: string; conversationId: string | null; replay: boolean; onClear?: () => void },
): Promise<GuardrailRule | null> {
  const regexHit = await checkAnswerGuardrails(admin, tenantId, answer, deId, 'de-answer');
  if (regexHit) {
    // GI-10: the deterministic filter has recall but no precision. Ask whether
    // this answer ENACTS the prohibited act or DESCRIBES the control against
    // it. Inert unless five independent things are true (see the adjudicator);
    // every failure path returns the block unchanged.
    const adj = await adjudicateRegexHit(admin, {
      tenantId, deId, conversationId: ctx.conversationId, actor: ctx.actor,
      question: ctx.question, content: answer, hit: regexHit as AdjHit, replay: ctx.replay,
    });
    if (adj.outcome === 'blocked') return adj.hit as GuardrailRule;
    ctx.onClear?.();
    // CLEARED → fall through. Deliberately NOT `return null`: a cleared answer
    // still gets the full GI-8 clean-branch screen, so tripping a regex can
    // never leave an answer LESS screened than never tripping one.
  }
  const gate = await semanticGate(admin, tenantId);
  if (!gate.enabled) return null;
  const rules = await loadBlockingRulesForJudge(admin, tenantId, deId);
  if (rules === null) return GUARDRAIL_RESOLVER_ERROR;   // can't prove screening ran → fail closed
  return (await semanticGuardrailScreen(admin, { tenantId, deId, surface: 'answer', content: answer, blockingRules: rules, mode: gate.mode! })) as GuardrailRule | null;
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
// ── "What Sophie already checked" (mig 667, handoff 06 §A) ──────────────────
// Same contract as widget-ask's copy: a row asserts a check that RAN; inserts
// are best-effort and never block the answer, but never fail silently. No
// identity rows on this path — the internal/dock channel has no widget
// identity system, so an identity check never runs here.
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
interface DEAnswer { answer: string; confidence: number; sources: string[]; needs_escalation: boolean; customer_state?: unknown }

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
    // Where a NEW thread is filed. Still an ALLOW-LIST, not a passthrough, so a
    // caller can never invent a channel and slip a thread out of (or into) the
    // Support Inbox. Anything unrecognised stays 'dock' exactly as before.
    //
    // 'portal' joins 'exam' because the customer portal used to keep its own
    // conversation store entirely: runPortalTurn wrote `conversations` +
    // `messages` while every other channel wrote here. A customer who chatted
    // through the portal was therefore invisible to the Support Inbox, to
    // triage and to escalation — and submit_csat, which updates
    // de_conversations, could never find the row, so every thumbs-up in the
    // portal failed silently. The inbox already accepts 'portal'
    // (supportInboxApi filters widget|hosted|portal|email|dock); it simply
    // never received one.
    const convChannel = reqBody.channel === 'exam' ? 'exam'
      : reqBody.channel === 'portal' ? 'portal'
      : 'dock';
    // Declared here, beside what it derives from, because BOTH the escalate
    // and resolved branches need it — the first version scoped it inside the
    // escalate branch and the resolved branch silently kept writing.
    const isExam = convChannel === 'exam';
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
    const isServiceRole = serviceCaller(jwt).service;
    const isDispatchCron = dispatchSecret !== '' && headerSecret === dispatchSecret;

    let tenantId: string | null = null;
    // 345: the human this answer is FOR. Retrieval narrows to what they are
    // permitted to see, so a person cannot read a locked Space by asking an
    // employee to read it to them. Stays null for service/cron callers.
    let actingUserId: string | null = null;
    if (isServiceRole || isDispatchCron) {
      const asserted = (typeof tenant_id === 'string' && /^[0-9a-f-]{36}$/i.test(tenant_id)) ? tenant_id : null;
      if (!asserted) return json({ error: 'tenant_id required for service calls' }, 400);
      tenantId = asserted;
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

      actingUserId = userData.user.id;

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
    // mig 760 — declared out here because the INSERT below needs the same
    // object the routing decision was made from. One classification, one answer.
    let routed: RoutedTopic = { triage: null, owner: null };
    // Today's fallback, resolved through ONE function because the fix gave it a
    // second caller. Note it does NOT exclude 'designed', unlike widget-ask and
    // email-inbound — that difference predates migration 760 and is left alone,
    // because "no match behaves exactly as today" means exactly this query.
    // classify_support_text applies the STRICTER set to a topic owner, so
    // routing can only ever hand back somebody this fallback would also have
    // accepted.
    const oldestEligibleDe = async (): Promise<string | null> => {
      const { data: firstDe } = await admin.from('digital_employees')
        .select('id').eq('tenant_id', tenantId)
        .not('lifecycle_status', 'in', '(paused,retired,archived)')
        .order('created_at', { ascending: true }).limit(1).maybeSingle();
      return firstDe?.id ?? null;
    };
    const callerNamedDe = typeof de_id === 'string' && !!de_id;
    if (callerNamedDe) {
      const { data: reqDe } = await admin.from('digital_employees')
        .select('id, lifecycle_status').eq('id', de_id).eq('tenant_id', tenantId).maybeSingle();
      if (!reqDe) return json({ error: 'de_not_in_tenant' }, 403);
      if (['paused', 'retired', 'archived'].includes(String(reqDe.lifecycle_status))) {
        return json({ error: 'de_not_available', detail: `This employee is ${reqDe.lifecycle_status} and cannot answer.` }, 409);
      }
      subjectDeId = reqDe.id;
    }

    // ── THE THREAD, RESOLVED BEFORE THE EMPLOYEE (mig 760 FIX ROUND, R1) ─────
    // This read used to live at :597 — SEVENTY LINES AFTER the routing call —
    // which is how classification came to fire on every turn of an open thread.
    // It is hoisted here because a conversation that already exists ANSWERS THE
    // QUESTION the routing was being asked: `de_conversations.de_id` is the
    // employee this thread belongs to.
    //
    // ⚠ IT SITS AFTER THE de_not_in_tenant / de_not_available REFUSALS ON
    // PURPOSE. A caller that sends both a bad de_id and a bad conversation_id
    // gets the same status it got yesterday; hoisting the whole thing above
    // them would have silently swapped a 403 for a 404.
    //
    // ⚠ REPLAY: unchanged and still null — a dry run never adopts, creates or
    // writes a conversation, and every convId-guarded write downstream stays
    // disarmed.
    let existingConv: { id: string; de_id: string | null } | null = null;
    if (!replayMode && typeof conversation_id === 'string' && conversation_id) {
      // Caller-supplied thread: must be a UUID the caller's tenant owns —
      // otherwise messages/outcomes would attach to a foreign or nonexistent
      // conversation ref.
      if (!/^[0-9a-f-]{36}$/i.test(conversation_id)) {
        return json({ error: 'invalid_conversation_id' }, 400);
      }
      const { data: owned } = await admin.from('de_conversations')
        .select('id, de_id').eq('id', conversation_id).eq('tenant_id', tenantId).maybeSingle();
      if (!owned) return json({ error: 'conversation_not_found' }, 404);
      existingConv = { id: String(owned.id), de_id: (owned.de_id as string | null) ?? null };
    }

    if (!callerNamedDe) {
      // ⚠⚠ mig 760: A CONVERSATION TOPIC DECIDES WHO ANSWERS — HERE, AND ONLY
      // HERE ON THIS PATH. This branch runs when THE CALLER NAMED NOBODY, which
      // is the only case where a topic has any business choosing: the dock
      // passes an explicit de_id (knowledgeApi.ts:640, DEChatDock.tsx:355 — the
      // Workspace Assistant), and de-orchestrate passes `de_id: chosen`. An
      // employee somebody named always wins.
      //
      // ⚠⚠⚠ AND ONLY ON A THREAD THAT DOES NOT EXIST YET. A reused thread is
      // NOT classified — not "classified and then ignored", not classified at
      // all — because the answer is already recorded on the row. Before this
      // fix the portal's second turn re-ran the classifier and could hand the
      // conversation to a different employee while de_conversations.de_id still
      // named the first: the answer, the token spend, the billable outcome, the
      // human task and the eval check all moved, and the seven readers that
      // count by de_id did not. EndUserChatPage.tsx:190 and :259 pass a stored
      // conversationId with de_id null on every turn after the first, so this
      // was live-reachable, not theoretical.
      //
      // ⚠ AND ONLY ON A TRIAGED CHANNEL. classifyAndRoute returns nothing for
      // `exam`, which trg_triage_support_conversation also refuses — migration
      // 671 took exams out of the support taxonomy deliberately, and routing a
      // channel the platform will not label would be a second taxonomy with no
      // screen behind it. What actually reaches the new code is `portal`.
      //
      // ⚠ THIS FUNCTION MADE 446 OF THE 460 CONVERSATIONS ON THIS PLATFORM.
      // Leaving it out because "widget-ask and email-inbound are the two insert
      // sites" would have been two paths with one counted.
      if (!replayMode && !existingConv) {
        routed = await classifyAndRoute(admin, tenantId, question, convChannel);
      }

      // ⚠ AND WHEN THE RECORDED OWNER HAS GONE. A thread whose de_id is NULL,
      // or names somebody since paused/retired/archived, still has to be
      // answered — so it falls to TODAY'S FALLBACK, and never to a
      // classification. "Conversations that are already open keep the person
      // they have" cannot mean "and if that person left, a triage rule may
      // reassign the thread": that is the same mid-thread move, arriving one
      // roster change later. Same eligibility set as the explicit-de_id branch
      // above, so the two cannot drift.
      let threadOwner: Answerer | null = null;
      if (existingConv?.de_id) {
        const { data: recorded } = await admin.from('digital_employees')
          .select('id, lifecycle_status, external_reply_mode')
          .eq('id', existingConv.de_id).eq('tenant_id', tenantId).maybeSingle();
        if (recorded && !['paused', 'retired', 'archived'].includes(String(recorded.lifecycle_status))) {
          threadOwner = { id: String(recorded.id), external_reply_mode: recorded.external_reply_mode ?? null };
        }
      }

      const fallbackId = await oldestEligibleDe();
      const pick = chooseAnswerer({
        // `named` is null here by construction — the branch above owns that
        // case, refusals included. Passed explicitly so the precedence reads
        // the same in all four callers rather than being implied by an if.
        named: null,
        thread: threadOwner,
        topic: routed.owner,
        fallback: fallbackId ? { id: fallbackId, external_reply_mode: null } : null,
      });
      subjectDeId = pick.who?.id ?? null;
    }
    // Resolved once, used twice: the no-docs deflection below must not fire for
    // an employee that can answer from the platform product guide, and the shelf
    // fan-in further down needs the same fact.
    let isWorkforceAssistant = false;
    // display_title/department ride along on a query that already runs — the
    // no-documents reply below introduces itself by role, and paying a second
    // round trip for two columns on the same row would be silly.
    let deDisplayTitle: string | null = null;
    let deDepartment: string | null = null;
    if (subjectDeId) {
      const { data: waRow } = await admin.from('digital_employees')
        .select('is_workforce_assistant, display_title, department').eq('id', subjectDeId).eq('tenant_id', tenantId).maybeSingle();
      isWorkforceAssistant = waRow?.is_workforce_assistant === true;
      deDisplayTitle = waRow?.display_title ?? null;
      deDepartment = waRow?.department ?? null;
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
      if (existingConv) {
        // Validated and READ above, where it had to be — the row's de_id is
        // what chose the employee. One lookup, one source of truth; the second
        // copy of this check that used to live here is exactly how the two
        // halves came to disagree about whether a thread was new.
        convId = existingConv.id;
      } else {
        // A certification exam runs the REAL pipeline on purpose — replay mode
        // would skip the platform knowledge shelf, the grounded-confidence gate
        // and the pre-send auditor, so a replayed exam would grade a weaker
        // pipeline than the one serving customers. The answers are therefore
        // real, and so are their threads. What they are NOT is customer
        // conversations, so they get their own channel and stay out of the
        // Support Inbox rather than being suppressed or deleted.
        const { data: conv } = await admin
          .from('de_conversations')
          // ⚠ mig 760: ALL FOUR TRIAGE COLUMNS, together or not at all —
          // trg_triage_support_conversation returns early on a non-null
          // category and would leave severity NULL. `{}` for `exam`, for a
          // caller who named an employee (nothing was classified), and for any
          // classification failure — which is byte-for-byte today's insert.
          .insert({ tenant_id: tenantId, channel: convChannel, de_id: subjectDeId, ...triageColumns(routed.triage) })
          .select('id').single();
        convId = conv?.id ?? null;
      }
      if (convId) {
        await admin.from('de_messages').insert({
          tenant_id: tenantId, conversation_id: convId, role: 'user', content: question,
        });
      }
    }

    // ── The thread this turn belongs to (mig 325) ──────────────────────────
    // de_messages was written on every turn and never read back, so every turn
    // was a cold open. Always ends with the current question; length 1 means
    // "first message of the conversation" (or history disabled).
    const turns = await buildTurns(admin, tenantId, convId, question, persona.contextTurns);
    const isFollowUp = turns.length > 1;

    const bump = (metric: string, delta = 1) =>
      admin.rpc('increment_metric_tenant', { p_tenant_id: tenantId, p_metric: metric, p_delta: delta })
        .then(({ error }) => { if (error) console.error('increment_metric_tenant:', error.message); });

    if (!replayMode) await bump('inquiries');

    // GI-10: set when an adjudication cleared a block during THIS request. A
    // cleared answer is DELIVERED but never written to the tenant-wide cache —
    // the relaxation stays bound to the request it was judged for, so flipping
    // the kill switch can never produce a block storm from cached content.
    let adjudicatedClear = false;
    const noteClear = () => { adjudicatedClear = true; };

    // ── Semantic answer cache (checked BEFORE any LLM call) ──
    // Cold opens ONLY. A follow-up's meaning lives in the thread, not in its
    // own words: "how much is that?" or "the other one" or "thanks, that
    // helped" embed to whatever they superficially resemble, and serving a
    // stored FAQ answer to them is a correctness bug, not just a tone one.
    // Most conversations are single-question, so the FAQ dedup economics —
    // the reason the cache exists — are essentially preserved.
    const qEmbedding = await embedText(question);
    // A near-verbatim entry can be FOUND yet not SERVED (the floor gate below).
    // The write must know that, or a dial-off tenant asking the same question
    // repeatedly would insert a duplicate row per ask.
    let cacheAlreadyCovered = false;
    if (qEmbedding && !replayMode && !isFollowUp) {
      const { data: cacheRows } = await admin.rpc('match_cached_answer', {
        p_tenant_id: tenantId,
        p_account_id: null,
        p_query_embedding: qEmbedding,
        p_max_distance: CACHE_MAX_DISTANCE,
        p_de_id: subjectDeId,   // DE-scope the cache (no cross-DE hits)
      });
      const hit = Array.isArray(cacheRows) ? cacheRows[0] : null;
      cacheAlreadyCovered = !!hit;
      if (hit) {
        // Re-screen the cached answer against CURRENT guardrails + confidence floor
        // + message escalation before serving — a rule added, floor raised, or
        // escalation matched AFTER caching must not be silently evaded (audit). If
        // it no longer clears the gate, skip the cache and take the full generate+gate path.
        const cachedBlocked = await screenAnswer(admin, tenantId, hit.answer, subjectDeId,
          { question, actor: persona.name, conversationId: convId, replay: replayMode, onClear: noteClear });
        // A cached row can predate the guard that would have stopped it being
        // written — one such row (a bare "...", confidence 98) was being served
        // instantly to every asker and failed the same exam question on every
        // run. Re-screening checks guardrails and the floor; neither asks
        // whether there is an answer at all. Refuse it and regenerate.
        const cachedHasContent = /[a-z0-9]/i.test(String(hit.answer ?? ''));
        if (!cachedHasContent) {
          console.warn(`[de-answer] refusing a degenerate cached answer (${String(hit.answer ?? '').length} chars) — regenerating`);
        }
        if (cachedHasContent && !cachedBlocked && Number(hit.confidence) >= confidenceFloor && !escalationRuleHit) {
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
        // Third writer of the same event, and the one that only showed up
        // once the answer cache started working: a repeat exam question now
        // hits the cache instead of the model. Same rule — an exam answer is
        // not business activity, however it was produced.
        if (!isExam) {
          await admin.from('activity_events').insert({
            tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'resolved',
            text: `Answered a chat question instantly from the verified answer cache`,
            confidence: hit.confidence,
          });
        }
        // Outcome metering (#15): a delivered cached answer is a resolution.
        // 682: same rule as the activity event above — an exam answer is not
        // business activity, and it must never bill.
        if (convId) {
          await admin.rpc('record_billable_outcome', {
            p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId,
            p_kind: 'resolution', p_source: 'chat', p_origin: isExam ? 'exercise' : 'production',
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

    // A brand-new workspace has no documents of its own — and that is EXACTLY
    // the customer the Workforce Assistant exists to help. This deflection used
    // to fire before the platform-shelf fan-in 50 lines below, so the product
    // expert told a new customer to go upload documentation about the product.
    // The Assistant now falls through and answers from the shelf.
    if ((!docs || docs.length === 0) && !isWorkforceAssistant) {
      // See the recovery-path block at the top of this file for the production
      // evidence. The refusal to answer is unchanged and unconditional — no
      // documents still means no facts, and no answer is invented here. What is
      // new: the employee acknowledges what was asked, says why it cannot help
      // YET, offers the one action that fixes it, and does not say the same
      // thing twice in a row.
      const attempt = (await countPriorNoDocsReplies(admin, tenantId)) + 1;
      const answer = noDocsAnswer(attempt, echoQuestion(question),
        briefingClause(deDisplayTitle, deDepartment));
      const recovery = noDocsRecovery(attempt);
      if (convId) {
        await admin.from('de_messages').insert({
          tenant_id: tenantId, conversation_id: convId, role: 'assistant',
          content: answer, confidence: 0, escalated: false,
          // The marker countPriorNoDocsReplies reads back. confidence_dimensions
          // is already used as a free-form per-message bag on this path (it
          // carries customer_state further down, and in widget-ask), and it has
          // no frontend reader — so this adds a queryable fact without moving
          // anything else. REPLAY never reaches here: convId is null in a dry
          // run, so a replay can neither write the marker nor inflate `attempt`
          // for a real customer.
          confidence_dimensions: { no_docs: true, attempt },
        });
      }
      return json({
        conversation_id: convId, answer, confidence: 0, sources: [],
        // no_docs is KEPT verbatim — src/lib/knowledgeApi.ts:623 and
        // widgetChatApi.ts already read it. `recovery` is purely additive.
        needs_escalation: false, no_docs: true, recovery,
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
      p_acting_user: actingUserId,
    });
    if (matchErr) console.error('hybrid_match_knowledge:', matchErr.message);
    // 345 / docs-27 §7a. Filter-before-rank is right for security and corrosive
    // for intelligence on its own: a narrowed corpus is invisible to the model,
    // so it answers thinly AND sounds certain. The retrieval RPC reports how
    // much it held back; the employee is told, and tells the person.
    const withheldCount = Number(
      (Array.isArray(chunks) && chunks.length > 0 ? chunks[0]?.withheld_count : 0) ?? 0);
    if (withheldCount > 0) {
      const note = `[Retrieval note] ${withheldCount} document${withheldCount === 1 ? '' : 's'} that matched this question ` +
        `were withheld because this person is not permitted to see them. Answer from what you have, and say plainly ` +
        `that there may be material here you are not permitted to show them. Do not guess at the contents, and do not ` +
        `imply your answer is complete.`;
      contextParts.push(note);
      used += note.length;
    }
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
    // ── 335: the platform knowledge shelf ────────────────────────────────
    // A SECOND, separate retrieval against tenant-less tables. The tenant call
    // above is completely untouched — same RPC, same arguments, same ranking —
    // which is why no tenant metric or coverage number moves.
    //
    // Only the platform-provided Workforce Assistant reads it, and the gate is
    // a property of the EMPLOYEE (is_workforce_assistant), never a caller
    // argument: platform_match_knowledge takes no tenant, subject or filter
    // parameter at all, so there is nothing to pass that could name a corpus.
    //
    // One-directional by construction: platform knowledge can reach a tenant's
    // answer, and nothing here can ever write tenant content into the shelf.
    const platformDocIds = new Set<string>();
    if (subjectDeId && !replayMode) {
      try {
        if (isWorkforceAssistant) {
          const { data: shelf, error: shelfErr } = await admin.rpc('platform_match_knowledge', {
            p_query_text: question,
            p_query_embedding: qEmbedding,
            p_match_count: 3,
          });
          // Fail SOFT: the shelf is additive. If it is paused, empty or errors,
          // the employee simply answers from the tenant's own knowledge.
          if (shelfErr) console.error('platform_match_knowledge:', shelfErr.message);
          if (Array.isArray(shelf)) {
            for (const c of shelf) {
              const budget = MAX_CONTEXT_CHARS - used;
              if (budget <= 0) break;
              const body = String(c.content ?? '').slice(0, budget);
              const title = c.doc_title ?? 'DreamTeam product guide';
              // Labelled distinctly so the model can tell the customer's own
              // material from the platform's, and attribute correctly.
              contextParts.push(`[DreamTeam product guide: ${title}]\n${body}`);
              used += body.length + title.length;
              if (c.doc_id) platformDocIds.add(String(c.doc_id));
            }
          }
        }
      } catch (e) {
        console.error('platform shelf (answering without it):', String(e));
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
    // Shelf citations go to their OWN recorder. record_knowledge_citations
    // gates both its writes on d.tenant_id = p_tenant_id, so a shelf id passed
    // there matches nothing and is dropped WITHOUT an error — the tenant docs in
    // the same answer would still count and nothing would look broken.
    if (!candidateKnowledge && platformDocIds.size > 0) {
      admin.rpc('record_platform_knowledge_citations', { p_doc_ids: [...platformDocIds] })
        .then(({ error }: { error: { message: string } | null }) => {
          if (error) console.error('record_platform_knowledge_citations:', error.message);
        });
    }
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

    const { data: budgetCheck, error: budgetCheckErr } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
    if (budgetBlocked(budgetCheckErr, budgetCheck)) {
      return json({ error: 'ai_budget_exceeded', conversation_id: convId });
    }

    // ── Recall durable memory for this conversation (muscle #4, mig 155) ──
    let memoryContext = '';
    if (subjectDeId && convId) {
      const { data: mems } = await admin.rpc('de_memory_search_internal', {
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
    const system = `${persona.preamble}

Every factual claim you make comes ONLY from the provided knowledge documents. If the documents don't contain the answer, say so plainly and set confidence low. Never invent facts. That constraint is on FACTS, not on how you talk: not every message is a factual question. A greeting, a thank-you, a joke, an apology, small talk, venting, or a one-word follow-up is a conversational turn — answer it as yourself from the thread you are in, with no document needed; set sources to [] and confidence to 100, because a pleasantry is not a knowledge gap. You are given the recent conversation: use it. Resolve "it", "that one", "the other thing" against what was already said instead of asking them to repeat it, and don't re-explain something you have already explained in this thread.

Always output JSON: {"answer": string, "confidence": 0-100, "sources": [doc titles used], "needs_escalation": boolean, ${CUSTOMER_STATE_SPEC}}. Prior assistant turns are shown to you as plain text; your reply is still the JSON envelope, and "answer" holds exactly what the person should read — no JSON, no preamble, no labels. Confidence reflects how well the documents support the answer. Decide needs_escalation on whether a human is genuinely needed (someone blocked, going in circles, or angry usually is), never on whether documents happened to match.

Knowledge documents:
${wrapUntrusted(context, 'knowledge-documents')}${memoryContext}${FIREWALL_RULES}`;

    const model = subjectDeId ? await resolveDeModel(admin, tenantId, subjectDeId) : DEFAULT_MODEL;
    const res = await llmMessages(admin, {
      model,
      // 1024 truncated long JSON envelopes mid-string (the replay-path
      // parse leak); parseAnswerEnvelope salvages truncation too, but not
      // truncating in the first place is the real fix.
      max_tokens: 1536,
      ...(replayTemperature !== undefined ? { temperature: replayTemperature } : {}),
      system,
      messages: turns,
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
    const parsed = parseAnswerEnvelope(raw);

    // The model ran out of room. stop_reason was never read here, so a reply
    // the model was still writing when it hit the ceiling was delivered as a
    // finished answer — the salvage path recovers the partial text and nothing
    // downstream knew it was partial. An answer that stops mid-thought is not a
    // low-confidence answer, it is an incomplete one: route it to a human.
    // (This is NOT what caused the mid-sentence truncation traced to an
    // unescaped quote — that was a parsing defect at ~110 tokens. This closes
    // the separate, genuine case.)
    if (data.stop_reason === 'max_tokens') {
      console.warn(`[de-answer] generation hit max_tokens — answer is incomplete, escalating (${parsed.answer.length} chars recovered)`);
      parsed.needs_escalation = true;
      parsed.confidence = Math.min(parsed.confidence, 40);
    }

    // §5: GROUNDED CONFIDENCE. Compute confidence from real retrieval support
    // (distance/coverage/corroboration — already retrieved, free) and shadow-log it
    // next to the model self-report. Only when a tenant has explicitly enforced AND
    // been validated do we BLEND it as min(self, grounded) so a confidently-wrong
    // answer can't skip escalation. Master switch absent => self_reported => ZERO
    // change. Generate path only; fail-open (any error leaves parsed untouched).
    // Escalation-policy state (set only when the grounded gate is enforcing).
    let groundedPolicyActive = false, fabricationRisk = false, genuinelyUnsure = false;
    const SELF_REPORT_HARD_FLOOR = 40;   // "the model is genuinely lost", not "slightly below the send bar"
    if (!replayMode) {
      try {
        const { data: gcMasterRow } = await admin.from('platform_config').select('value').eq('key', 'grounded_confidence.enabled').maybeSingle();
        if (String(gcMasterRow?.value ?? '') === 'true') {
          const [gcModeRow, gcFlag, gcVal] = await Promise.all([
            admin.from('platform_config').select('value').eq('key', 'grounded_confidence.mode').maybeSingle(),
            admin.rpc('is_feature_enabled_internal', { p_tenant_id: tenantId, p_feature_key: 'grounded_confidence' }),
            admin.from('grounded_confidence_validation').select('tenant_id').eq('tenant_id', tenantId).maybeSingle(),
          ]);
          if (gcFlag.data === true) {
            const isSynthetic = isServiceRole || isDispatchCron;
            const gcMode = String(gcModeRow.data?.value ?? '') || 'shadow';
            // blended/grounded require a validation row (shadow-first, unskippable)
            // AND exclude synthetic (cert/eval) traffic so cert floors stay calibrated.
            const gcEnforce = (gcMode === 'blended' || gcMode === 'grounded') && !!gcVal.data && !isSynthetic;
            const gc = groundedConfidence(Array.isArray(chunks) ? (chunks as Array<Record<string, number | null>>) : [], {
              embeddingAvailable: qEmbedding !== null && !matchErr,
              sourcesCited: parsed.sources.length,
            });
            const self = parsed.confidence;
            const groundedVal = gc.value;
            const willBlend = gcEnforce && gc.expected && groundedVal !== null;
            const effective = willBlend ? Math.min(self, groundedVal) : self;
            admin.from('grounded_confidence_shadow_log').insert({
              tenant_id: tenantId, de_id: subjectDeId, conversation_id: convId ?? null,
              resolved_mode: gcEnforce ? gcMode : 'shadow', is_synthetic: isSynthetic, source: 'generate',
              self_confidence: self, grounded_confidence: groundedVal, effective_confidence: effective,
              confidence_floor: confidenceFloor,
              self_would_escalate: self < confidenceFloor,
              grounded_would_escalate: groundedVal !== null && groundedVal < confidenceFloor,
              effective_escalated: effective < confidenceFloor,
              retrieval: gc.inputs ? { ...gc.inputs, reason: gc.reason } : { reason: gc.reason },
              question_preview: String(question ?? '').slice(0, 160),
            }).then(({ error }: { error: { message: string } | null }) => { if (error) console.error('gc shadow log:', error.message); });
            if (willBlend) {
              parsed.confidence = effective;   // recorded value stays conservative (min)
              // ESCALATION POLICY (the two gates, separated). A single noisy number
              // was doing two different jobs. Measured on live traffic: self-report
              // swings +/-10 on identical content, while grounded is deterministic;
              // across 63 observations the signals agreed 92% of the time, and the
              // disagreements ran 3:1 toward escalating GOOD answers.
              //   • FABRICATION gate (hard): grounded below the floor means the KB
              //     did not support this answer — always escalate. This is new
              //     protection that self-report alone never provided.
              //   • UNCERTAINTY gate (soft): the model's own number only escalates
              //     when it is genuinely low, not merely below the send threshold —
              //     a well-grounded answer is no longer withheld because the model
              //     happened to say 62 instead of 70 about material it nailed.
              // needs_escalation and founder escalation rules are untouched: if the
              // model explicitly asks for a human, it gets one.
              groundedPolicyActive = true;
              fabricationRisk = groundedVal < confidenceFloor;
              genuinelyUnsure = self < SELF_REPORT_HARD_FLOOR;
            }
          }
        }
      } catch (e) { console.error('grounded confidence:', e); }   // fail-open to self-report
    }
    await bump('llm_calls');
    if (subjectDeId) {
      admin.rpc('record_de_token_usage', {
        p_tenant_id: tenantId, p_de_id: subjectDeId, p_model_id: model,
        p_input_tokens: data.usage?.input_tokens ?? 0, p_output_tokens: data.usage?.output_tokens ?? 0,
        p_origin: isExam ? 'exercise' : 'production',   // 682: exam spend is budget-real but not a business cost metric
      }).then(({ error }: { error: unknown }) => { if (error) console.error('record_de_token_usage:', error); });
    }

    // ── Guardrail check on the answer text (P3 — blocks + escalates) ──
    // The check itself runs in EVERY mode — guardrails always win, and a
    // replay must honestly report that the answer would have been blocked.
    // The PERSISTENCE (message, human task, activity, audit, metering) is
    // real-traffic-only: a dry run must never open a real escalation.
    const blockedBy = await screenAnswer(admin, tenantId, parsed.answer, subjectDeId,
      { question, actor: persona.name, conversationId: convId, replay: replayMode, onClear: noteClear });
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
          origin: isExam ? 'exercise' : 'production',   // 682: deciding an exam escalation is not trust evidence
          title: `Guardrail block — ${truncated}`,
          detail: `${persona.name}'s draft answer was blocked by guardrail "${blockedBy.rule}". Draft (confidence ${parsed.confidence}%): ${parsed.answer}`,
          related_table: convId ? 'de_conversations' : null,
          related_id: convId,
        });
        await recordChecks(admin, tenantId, convId, subjectDeId, [
          ...knowledgeChecks(parsed.sources),
          { kind: 'guardrail', ok: false, label: `Blocked by the guardrail: ${blockedBy.rule}` },
        ]);
        await admin.from('activity_events').insert({
          tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'escalated',
          text: `Answer BLOCKED by guardrail "${blockedBy.rule}" — escalated to human review`,
          confidence: parsed.confidence,
        });
        await auditEvent(admin, tenantId, persona.name, 'de',
          `BLOCKED — chat answer matched guardrail "${blockedBy.rule}" and was withheld; escalated to human`,
          'guardrail_block',
          { rule_id: blockedBy.id, rule: blockedBy.rule, rule_type: blockedBy.rule_type, question: truncated,
            origin: isExam ? 'exercise' : 'production' });   // 682: an exam-provoked block is the control being tested
        // Outcome metering (#15): a guardrail block hands off to a human —
        // metered FREE, and it belongs in the benchmark's denominator
        // (consistent with widget-ask; without this, chat blocks silently
        // inflated the honest resolution rate).
        if (convId) {
          await admin.rpc('record_billable_outcome', {
            p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId,
            p_kind: 'escalation', p_source: 'chat', p_origin: isExam ? 'exercise' : 'production',   // 682
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
        // Evidence decision for the block (docs/31 #4, mig 442) — feeds
        // blocked_guardrail_count in get_de_performance_metrics.
        try {
          const { data: er } = await admin.from('evidence_runs').insert({
            tenant_id: tenantId, de_id: subjectDeId, inquiry: question.slice(0, 2000),
            account_ref: convId ? `conversation:${convId}` : null,
            status: 'complete', steps: [], answer_status: 'blocked',
            confidence_inputs: { knowledge_hits: 0 },
            origin: isExam ? 'exercise' : 'production',   // 682
          }).select('id').single();
          if (er?.id) {
            await admin.rpc('record_inquiry_decision', {
              p_tenant_id: tenantId, p_evidence_run_id: er.id, p_connector_id: null,
              p_external_ref: convId ? `conversation:${convId}` : null,
              p_source: 'live_channel', p_decision: 'blocked_guardrail',
              p_confidence: parsed.confidence, p_guardrail_rule_id: blockedBy.id,
              p_trust_level: null,
              p_reasoning: `Chat answer blocked by guardrail "${blockedBy.rule}" and withheld; escalated to human.`,
              p_inquiry_title: question.slice(0, 120),
              p_source_category: 'support', p_frustration_score: null,
              p_existing_human_task_id: null,
            });
          }
        } catch (e) { console.error('evidence decision (chat block):', e); }
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

    // Post-answer: re-evaluate now that confidence AND the employee's read of
    // the person are known, so conditions on confidence/sentiment (not just
    // text) can finally fire. `sentiment`/`sentiment_label` were catalogued
    // signals that no caller had ever supplied until now.
    const customerState = parseCustomerState((parsed as { customer_state?: unknown }).customer_state);
    if (!escalationRuleHit) {
      const post = evaluateEscalation(escRuleset, {
        message_text: String(question ?? ''), confidence: parsed.confidence, ...stateSignals(customerState),
      });
      if (post.escalate) escalationRuleHit = post.rule ?? 'escalation rule';
    }
    // The model asking for a human, and founder escalation rules, ALWAYS win.
    // Beyond that: when the grounded gate is enforcing, the two jobs are separated
    // (fabrication vs uncertainty — see the policy note above). Otherwise the
    // original single self-report threshold applies, unchanged.
    let escalate = parsed.needs_escalation || escalationRuleHit !== null || (
      groundedPolicyActive
        ? (fabricationRisk || genuinelyUnsure)
        : parsed.confidence < confidenceFloor
    );

    // ── Pre-send Quality Auditor (opt-in per DE) ── an answer that WOULD be
    // auto-sent is independently judged for grounding + correctness first.
    // Inert unless the DE opts in (pre_send_audit_enabled); fail-closed WHEN
    // ENABLED (audit unavailable → route to a human rather than auto-send). It
    // reuses the existing escalation path below by only ever setting escalate.
    // ── Per-employee answer safeguards (migrations 554-556) ──
    // ONE read for both controls below. This was read twice, and both reads
    // were wrong the same way: get_de_config is SET-RETURNING, so PostgREST
    // returns an ARRAY and `.data` on it is undefined no matter what is stored.
    // Proven over the live HTTP path, not assumed.
    let deCfg: Record<string, unknown> | null = null;
    if (!replayMode && subjectDeId) {
      try {
        const { data: cfgRows, error: cfgErr } = await admin.rpc('get_de_config', {
          p_tenant_id: tenantId, p_entity_kind: 'de', p_entity_id: subjectDeId,
        });
        // .rpc() RESOLVES on a Postgres error — it does not throw. The unchecked
        // `error` is how both controls stayed dark from the day they shipped:
        // the surrounding catch was never once reached, so nothing was logged
        // and a returned {data:null} read as "nobody switched this on".
        if (cfgErr) console.error('answer safeguards: config unreadable →', cfgErr.message);
        deCfg = (cfgRows?.[0]?.data ?? null) as Record<string, unknown> | null;
      } catch (e) { console.error('answer safeguards: config read threw →', e); }
    }

    // Why the auditor stopped it, kept for the checks panel below — the
    // verdict itself is otherwise gone by the time the escalation is filed.
    let auditorReason: string | null = null;
    if (!replayMode && !escalate && subjectDeId) {
      const auditEnabled = deCfg?.pre_send_audit_enabled === true;
      if (auditEnabled) {
        try {
          const verdict = await preSendAudit(admin, tenantId, subjectDeId, question, parsed.answer);
          if (!verdict.clean) {
            escalate = true;
            auditorReason = verdict.reason;
            await auditEvent(admin, tenantId, persona.name, 'de',
              `Pre-send quality audit routed an answer to a human — ${verdict.reason}`,
              'evidence_step', { kind: 'pre_send_audit', conversation_id: convId, confidence: parsed.confidence });
          }
        } catch (e) {
          escalate = true; // enabled but the audit itself failed → fail closed
          auditorReason = 'the independent quality check could not run, so the answer goes to a person';
          console.error('pre-send audit failed closed → escalate:', e);
          await auditEvent(admin, tenantId, persona.name, 'de',
            'Pre-send quality audit unavailable — routed the answer to a human',
            'evidence_step', { kind: 'pre_send_audit_error', conversation_id: convId });
        }
      }
    }

    // ── Semantic cache write (only good answers; never answers built from
    // scoped docs — the cache is tenant-wide; never a follow-up, whose answer
    // was shaped by turns the next asker won't have) ──
    //
    // Cache-worthiness is a QUALITY judgement, deliberately decoupled from the
    // DELIVERY decision. The old condition was `!escalate`, and `escalate`
    // includes `confidence < confidenceFloor` — which is 101 when the autonomy
    // dial is off. So on every dial-off tenant nothing was ever cached, the
    // live hit rate was zero, and each repeat question paid full price. The
    // REAL disqualifiers stay: the model asking for a human, a founder
    // escalation rule, fabrication risk, genuine uncertainty, a guardrail
    // adjudication — each is a statement about the ANSWER. The floor is a
    // statement about who reviews it, and reviews are unaffected: a held reply
    // is still held; the cache just remembers what it cost to produce.
    const cacheQualityBar = confidenceFloor <= 100
      ? Math.max(ESCALATION_THRESHOLD, confidenceFloor)
      : ESCALATION_THRESHOLD;
    // …and it has to actually BE an answer. Every disqualifier above is about
    // judgement or confidence; none of them asks whether there is any content.
    // A reply of "..." carrying a self-reported 98 sailed past all of them and
    // was cached, which is how ONE bad generation became a permanent wrong
    // answer served instantly to every future asker.
    const hasContent = /[a-z0-9]/i.test(String(parsed.answer ?? '')) && String(parsed.answer).trim().length >= 20;
    const cacheworthy = hasContent && !parsed.needs_escalation && !escalationRuleHit
      && !fabricationRisk && !genuinelyUnsure
      && parsed.confidence >= cacheQualityBar;
    if (qEmbedding && cacheworthy && !cacheAlreadyCovered && !scopedContentUsed && !replayMode && !isFollowUp && !adjudicatedClear) {
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
    // confidence_dimensions carries the employee's read of the person on the
    // turn it applied to, so the transcript a human reviews shows WHY a reply
    // was shaped (or escalated) the way it was — the same read governance saw.
    if (convId) {
      await admin.from('de_messages').insert({
        tenant_id: tenantId, conversation_id: convId, role: 'assistant',
        content: parsed.answer, confidence: parsed.confidence, escalated: escalate,
        confidence_dimensions: (customerState.mood || customerState.intensity !== null)
          ? { customer_state: customerState } : null,
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
        await admin.rpc('de_memory_write_internal', {
          p_tenant_id: tenantId, p_de_id: subjectDeId,
          p_content: `Customer asked: "${question}" — I answered: ${parsed.answer.slice(0, 500)}`,
          p_embedding: memEmb, p_subject_kind: 'conversation', p_subject_ref: convId,
          p_kind: 'episodic', p_salience: Math.min(1, parsed.confidence / 100), p_source: 'de',
        });
      } catch (e) { console.error('de_memory_write:', e); }
    }

    // Outcome metering (#15): resolution bills per tenant pricing;
    // escalation meters FREE. Idempotent per conversation; never in replay.
    // 682: never billable from an exam either — the origin stamp forces it.
    if (!replayMode && convId) {
      await admin.rpc('record_billable_outcome', {
        p_tenant_id: tenantId, p_de_id: subjectDeId, p_conversation_id: convId,
        p_kind: escalate ? 'escalation' : 'resolution', p_source: 'chat',
        p_origin: isExam ? 'exercise' : 'production',
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
          'dreamteam.turns_in_context': turns.length,
          'dreamteam.customer_mood': customerState.mood,
          'dreamteam.customer_intensity': customerState.intensity,
        },
      });
    }

    // ── Reply-mode: hold a finished answer until a person approves it ──
    // This lands in human_tasks — the SAME queue escalations use here and the
    // same one widget-ask files external replies into. It deliberately does NOT
    // use draft_responses: that table has no screen that can approve anything,
    // so an answer parked there waits until it expires and the employee simply
    // goes quiet. Like the pre-send auditor above, this only ever SETS escalate,
    // so there is one road to a human instead of three.
    //
    // A real escalation wins. If the answer was already going to a person for
    // low confidence or a matched rule, that is what it is — relabelling it
    // "waiting for approval" would hide a failure behind a routine review.
    let heldForApproval = false;
    if (!replayMode && !escalate && subjectDeId &&
        (deCfg?.reply_mode_enabled === true || deCfg?.preapproval_strategy === 'all')) {
      escalate = true;
      heldForApproval = true;
    }

    // ── Escalation + activity ── (business writes skipped in replay; one
    // audit line keeps dry runs visible in the trail, never silent)
    let escTaskId: string | null = null;
    if (replayMode) {
      await auditEvent(admin, tenantId, persona.name, 'de',
        `REPLAY (dry run) — answered "${question.length > 60 ? question.slice(0, 60) + '…' : question}" with zero business side effects${candidateKnowledge ? ' (candidate knowledge injected)' : ''}`,
        'evidence_step', { kind: 'replay_run', confidence: parsed.confidence, would_escalate: escalate, candidate: candidateKnowledge.length > 0 });
    } else if (escalate) {
      // A held reply is NOT an escalation. The employee answered perfectly well
      // and a person simply has to sign it off. Counting it here would inflate
      // the escalation rate and make a DE that is working exactly as configured
      // look like one that keeps failing.
      if (!heldForApproval) await bump('escalations');
      const truncated = question.length > 60 ? question.slice(0, 60) + '…' : question;
      // An EXAM answer that escalates does not need a person. Nobody reviews a
      // test question, and every exam run was filing one task per escalated
      // answer — all 74 pending escalations on the HQ tenant were exam answers,
      // created in a single day. The audit and activity trail below still
      // record what happened; what is withdrawn is the CLAIM ON A HUMAN.
      // (Third surface of the same root cause: migration 570 took exams out of
      // the Inbox, 571 out of the performance metric, this out of the queue.)
      const { data: escTask } = isExam ? { data: null } : await admin.from('human_tasks').insert({
        tenant_id: tenantId,
        de_id: subjectDeId,
        type: 'escalation',
        source: 'de',
        // Same two-word distinction widget-ask draws for external replies, so
        // one queue reads consistently whichever channel filled it.
        title: heldForApproval
          ? `Reply to approve — ${truncated}`
          : `Chat escalation — ${truncated}`,
        detail: heldForApproval
          ? `${persona.name} has an answer ready and is waiting for approval before it goes back (confidence ${parsed.confidence}%): ${parsed.answer}`
          : `${escalationRuleHit ? `Matched ${escalationRuleHit}. ` : ''}${persona.name}'s draft answer (confidence ${parsed.confidence}%): ${parsed.answer}`,
        related_table: convId ? 'de_conversations' : null,
        related_id: convId,
      }).select('id').single();
      escTaskId = escTask?.id ?? null;
      // The checks panel (mig 667). ⚠ NOT for exams: an exam files no claim
      // on a human (the 570/571/572 lineage), and evidence rows exist for the
      // person reading the panel — a run nobody reviews must not write them.
      // One stop-reason row, in the order the escalation actually composes:
      // a founder rule outranks the model's own self-stop outranks the
      // auditor outranks the grounded/confidence gate outranks draft mode.
      if (!isExam) {
        const stopReason: ConvCheck = escalationRuleHit
          ? { kind: 'escalation_rule', ok: false, label: `Stopped by the rule: ${escalationRuleHit}` }
          : parsed.needs_escalation
            ? { kind: 'escalation_rule', ok: false, label: `${persona.name} asked for a human on this one` }
            : auditorReason
              ? { kind: 'guardrail', ok: false, label: 'Independent pre-send check routed it to a person', detail: auditorReason }
              : (groundedPolicyActive && fabricationRisk)
                ? { kind: 'confidence', ok: false, label: "The knowledge base can't back this answer — not sending it unverified" }
                : heldForApproval
                  ? { kind: 'escalation_rule', ok: false, label: 'Held for approval: every reply from this employee is reviewed before it sends' }
                  : (confidenceFloor > 100
                    ? { kind: 'confidence', ok: false, label: `Confidence ${parsed.confidence}% — this employee isn't allowed to send replies on its own yet` }
                    : { kind: 'confidence', ok: false, label: `Confidence ${parsed.confidence}% — below the ${confidenceFloor}% send threshold` });
        await recordChecks(admin, tenantId, convId, subjectDeId, [
          ...knowledgeChecks(parsed.sources),
          stopReason,
        ]);
      }
      // Same split for the activity feed: it answers "what did my workforce do
      // for the business today", and a fire drill does not belong in the
      // incident log — 74 of today's 78 events were exam escalations. The
      // auditEvent below is the COMPLIANCE trail and still records every exam,
      // so nothing is lost, it is just filed where it belongs.
      if (!isExam) {
        await admin.from('activity_events').insert({
          tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'escalated',
          text: heldForApproval
            ? `Answer held for approval — "${truncated}"`
            : `Chat question escalated to human review — "${truncated}"`,
          confidence: parsed.confidence,
        });
      }
      // (The mig-252 "gap bridge" that lived here never once succeeded — its
      // direct insert violated the source_category FK and the catch swallowed
      // it. Superseded by the unconditional recorder below, which routes
      // through record_inquiry_decision — mig 442.)
      await auditEvent(admin, tenantId, persona.name, 'de',
        heldForApproval
          ? `Answer held for approval before sending — "${truncated}"`
          : `Chat question escalated to human review — "${truncated}"`,
        'escalated', { confidence: parsed.confidence, conversation_id: convId, held_for_approval: heldForApproval });
    } else {
      // Same rule as the escalated branch: an exam answer is not business
      // activity. Without this the feed just fills with 'resolved' instead of
      // 'escalated' — 16 per run — and the fix would have MOVED the noise
      // rather than removed it. The auditEvent below still records every one.
      if (!isExam) {
        await admin.from('activity_events').insert({
          tenant_id: tenantId, actor: persona.name, actor_type: 'de', event_type: 'resolved',
          text: `Answered a chat question from knowledge docs (${parsed.sources.join(', ') || 'no sources cited'})`,
          confidence: parsed.confidence,
        });
      }
      await auditEvent(admin, tenantId, persona.name, 'de',
        `Resolved a chat question from knowledge docs (${parsed.sources.join(', ') || 'no sources cited'})`,
        'resolved', { confidence: parsed.confidence, conversation_id: convId });
    }

    // (Reply-mode used to live here, writing a draft_responses row AFTER the
    // answer had already been recorded as resolved. It now runs BEFORE the
    // escalation block above and files a human task instead — one queue, and
    // one that somebody can actually act on.)

    // ── Evidence decision (docs/31 pre-start #4, mig 442): EVERY live answer
    // records a decision via record_inquiry_decision — the single writer that
    // also opens the Experience ledger and feeds get_de_performance_metrics +
    // the development detector. Awaited (floating promises are dropped at
    // isolate teardown — see the memory-write note above). Never in replay.
    if (!replayMode) {
      try {
        const { data: er } = await admin.from('evidence_runs').insert({
          tenant_id: tenantId, de_id: subjectDeId, inquiry: question.slice(0, 2000),
          account_ref: convId ? `conversation:${convId}` : null,
          status: 'complete', steps: [], answer_status: 'answered',
          answer: parsed.answer.slice(0, 4000),
          confidence_inputs: { knowledge_hits: parsed.sources.length },
          origin: isExam ? 'exercise' : 'production',   // 682: the activity feed shows work, not exams
        }).select('id').single();
        if (er?.id) {
          await admin.rpc('record_inquiry_decision', {
            p_tenant_id: tenantId, p_evidence_run_id: er.id, p_connector_id: null,
            p_external_ref: convId ? `conversation:${convId}` : null,
            p_source: 'live_channel',
            // A held reply IS 'needs_review' — it is waiting on a person. The
            // old 'would_auto_send' described a hypothetical; this describes
            // what actually happened.
            p_decision: escalate ? 'needs_review' : 'acted',
            p_confidence: parsed.confidence, p_guardrail_rule_id: null, p_trust_level: null,
            p_reasoning: `Chat answer ${heldForApproval ? 'held for approval before sending' : escalate ? `escalated to human review${escalationRuleHit ? ` (${escalationRuleHit})` : ''}` : 'sent'} at ${parsed.confidence}% confidence with ${parsed.sources.length} knowledge source(s).`,
            p_inquiry_title: question.slice(0, 120),
            p_source_category: 'support',
            p_frustration_score: customerState.intensity,
            p_existing_human_task_id: escTaskId,
          });
        }
      } catch (e) { console.error('evidence decision (chat):', e); }
    }

    return json({
      conversation_id: convId,
      answer: parsed.answer,
      confidence: parsed.confidence,
      sources: parsed.sources,
      needs_escalation: escalate,
      // Both true when an answer is waiting on a person, but they mean
      // different things: held_for_approval says the employee succeeded and is
      // waiting for a signature, not that it could not cope.
      held_for_approval: heldForApproval,
      de_id: subjectDeId, de_name: persona.name,
    });
  } catch (err) {
    console.error('de-answer error:', err);
    await reportEdgeError('de-answer', err, {});
    return json({ error: String(err) }, 500);
  }
});
