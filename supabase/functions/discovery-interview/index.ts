/**
 * discovery-interview — Task 3 of the discovery interview engine plan
 * (.superpowers/sdd/2026-08-13-discovery-interview-engine): the ENGINE that
 * drives a plain-English conversation across the SPINE (Task 1: fourteen
 * seeded public.discovery_dimensions) using the MEMORY (Task 2:
 * public.discovery_sessions.coverage, start_discovery_session,
 * record_dimension_state).
 *
 * THE FOUNDER'S REQUIREMENT, VERBATIM — everything below serves it: "I don't
 * want to lose the depth of the interview or getting side tracked because
 * customer got focused on one thing and forgot other critical pieces."
 *
 * THE GATE. Every model turn's extraction passes through coverageAfter
 * (supabase/functions/_shared/discoveryCoverage.ts) before anything is
 * persisted — the model PROPOSES which dimensions it heard evidence for,
 * this function DISPOSES: validates every dimension key and state against
 * the real spine, throws on a typo rather than silently minting a new
 * dimension, and the caller (below) never trusts an extraction that fails
 * that gate. Same shape as de-mission's validateScope and
 * compile-trust-plan's live-validator pass — copied deliberately, per the
 * task instructions ("the best-built precedent in this codebase").
 *
 * THE SPINE CANNOT BE LEFT. The next question this function returns always
 * targets a dimension that is still 'not_heard' or 'parked' — never
 * whatever the model or the customer brought up unprompted. The model's own
 * `next_question` proposal is used ONLY when it names a dimension genuinely
 * still owed after this turn's extraction; otherwise a deterministic
 * fallback question (fallbackQuestionText, also used for the very first
 * question at 'start') takes over. `done` is likewise computed ONLY from the
 * real coverage ledger (nothing left not_heard or parked) — the model's own
 * "done" opinion in its JSON response is read nowhere below; see the
 * comment at its one appearance in the prompt schema.
 *
 * WHERE coverageAfter ACTUALLY LIVES. This file imports it (and stillOwed)
 * from ../_shared/discoveryCoverage.ts and re-exports both below, so they
 * remain real, documented exports of this deployed function. Direct import
 * of THIS file from vitest is not possible under Node's ESM loader (it
 * rejects the https: scheme this file's own serve()/createClient() imports
 * use, unconditionally, before any of this file's code runs) — proven
 * empirically and explained in full in
 * tests/discovery-sidetrack.test.ts's header, which is why that test
 * imports coverageAfter from the _shared module directly instead.
 *
 * VAGUE ANSWERS AND MONOLOGUES — the two failure modes this prompt is
 * written against (task instructions, verbatim: "state to yourself what a
 * model would do with a customer who answers everything with one vague
 * sentence, and what it would do with one who monologues about a single
 * topic"):
 *   - A vague answer ("we help customers") must never be marked 'heard' —
 *     buildInterviewSystem() tells the model to apply each dimension's own
 *     guidance text literally as the heard/not-heard bar (that guidance
 *     already states, per dimension, exactly what "vague" looks like — see
 *     migration 734's own worked examples) and to ask ONE sharper,
 *     concrete follow-up before ever parking a dimension that stays vague.
 *   - A monologue on one topic must not stall the interview — the system
 *     prompt instructs the model to extract everything the answer supports
 *     across EVERY still-owed dimension at once (a rambling answer often
 *     touches several) and to redirect once a topic is genuinely covered.
 *     That instruction is a SOFT rail (the model can ignore it); the HARD
 *     rail is server-side: next_question.dimension is only ever honored
 *     when it is still in the owed set computed AFTER this turn's
 *     extraction, so even a model that keeps proposing an already-heard
 *     dimension is overridden by the deterministic fallback. Two layers,
 *     because the prompt is advisory and the gate is not.
 *
 * Consumes: discovery_dimensions, discovery_sessions, start_discovery_session,
 * record_dimension_state, _shared/llm.ts (via _shared/modelCall.ts, the
 * entity-draft/compile-trust-plan pattern).
 * Produces: POST { action:'start', tenant_id } -> { session_id, question }
 *           POST { action:'answer', session_id, text } -> { question|null, coverage, done }
 *           POST { action:'end', session_id, status?, resume_hint? }
 *             -> { session_id, status, coverage, owed, done:true }
 *
 * WHY 'end' EXISTS. `done` is computed from the ledger — nothing owed — and
 * 'parked' is owed forever by design ("ask me later" must come back). So an
 * interview in which the customer parks even one dimension can never reach
 * done:true on its own. Task 3 Step 6 says done is true when nothing is owed
 * "or THE CALLER STOPS", and spec §7 says abandonment mid-interview is "a
 * legitimate end state, not an error" — until migration 739 there was no
 * caller-stops path at all, discovery_sessions.status never left 'running',
 * and the 409 `session_not_running` guard below was unreachable code. 'end'
 * is that path: it moves the session to 'parked' or 'abandoned' through
 * end_discovery_session and reports the gaps honestly, and it does not touch
 * the coverage ledger — what was heard stays heard, what was never asked
 * stays visibly unasked.
 *
 * Never writes digital_employees, guardrail_rules, playbook_definitions or
 * connectors rows.
 *
 * NO PROPOSALS ARE WRITTEN HERE, AND THE REASON IS DEFERRAL, NOT ABSENCE.
 * Task 3 Step 6's constraints say, verbatim: "Proposals go to
 * discovery_proposals with state='pending'." An earlier version of this
 * comment claimed Step 6 "never mentions generating a proposal" — that was
 * simply false, and a justification that misquotes its own source is worse
 * than no justification, because the next reader believes it. The real
 * reason: generating proposals is a second model concern (what to BUILD from
 * what was heard) with its own prompt, its own validation and its own
 * accept/decline surface, and the surface is explicitly Plan 3b. Writing
 * pending rows here that nothing can yet read, decide or expire would
 * recreate exactly the invisible pile the spec's §7 warns about — 19 of Ada's
 * proposals still undecided. So: deliberately deferred to the plan that
 * builds the screen which acts on them, and the coverage ledger this function
 * does write is the complete input that plan needs.
 *
 * Nothing here reads or writes a digital_employees row with
 * is_workforce_assistant = true — nothing here touches digital_employees at
 * all. Not deployed by this task (deployment ships with the UI, Plan 3b).
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { hasLLMProvider } from '../_shared/llm.ts';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { wrapUntrusted, FIREWALL_RULES } from '../_shared/injectionSafety.ts';
import { loadTenantGate, TENANT_SUSPENDED_BODY } from '../_shared/tenantStatus.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';
import { budgetBlocked, rpcOrThrow } from '../_shared/rpcSafety.ts';
import { makeCallModelText } from '../_shared/modelCall.ts';
import {
  coverageAfter,
  stillOwed,
  type DiscoveryCoverageMap,
  type DiscoveryExtraction,
} from '../_shared/discoveryCoverage.ts';
import {
  proposalsFrom,
  validatePayload,
  isUnusedTopicSlot,
  applyFillToDraft,
  vocabularyOrUndefined,
  ROLE_ARCHETYPE_SELECT,
  type ArchetypeLike,
  type ProviderCatalogRow,
  type ProposalDraft,
  type ValidatePayloadOptions,
  type EvidenceSource,
} from '../_shared/discoveryProposals.ts';

// Re-exported so this remains a real, documented export of the deployed
// function — see the file header for why tests reach it via the _shared
// module directly instead of through this one.
export { coverageAfter, stillOwed };

const callModel = makeCallModelText('discovery-interview', 1536, { temperature: 0.4 });
const callFillModel = makeCallModelText('discovery-interview-fill', 1024, { temperature: 0.2 });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (error: string, detail: string, s: number) => json({ ok: false, error, detail }, s);

const MAX_ANSWER_CHARS = 4000;
const MAX_TRANSCRIPT_TURNS_STORED = 80;
const MAX_TRANSCRIPT_TURNS_TO_MODEL = 24;

interface DimensionRow {
  key: string; ordinal: number; title: string; guidance: string;
  // Read only by emitProposals (Task 1) — everything else in this file only
  // ever touches key/ordinal/title/guidance.
  serves_archetypes: string[];
}
interface TranscriptTurn { role: 'user' | 'assistant'; text: string; at: string }

function parseJson(t: string): Record<string, unknown> | null {
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** Customer-facing, generic across any dimension — guidance itself is
 *  written FOR THE MODEL (it says things like "mark heard only once…"), so
 *  this never quotes it directly; it just names the topic and invites an
 *  open answer. Used both for the very first question at 'start' and as the
 *  hard fallback whenever the model's own next_question does not survive
 *  validation. */
function fallbackQuestionText(dim: DimensionRow): string {
  return `Let's talk about ${dim.title.toLowerCase()}. Tell me about it in your own words — what's actually going on there today?`;
}

function buildInterviewSystem(): string {
  return [
    'You are conducting a plain-English discovery interview for a new business customer, so a governed AI workforce product can be configured around real facts about their business rather than guesses.',
    '',
    'THE RULE THAT MATTERS MOST: a customer may fixate on one topic — support tickets, one big account, whatever is on their mind today — for many turns in a row. Do not let that happen. Read their latest answer together with the recent conversation, extract everything it actually supports across EVERY still-owed dimension it touches (a rambling answer often gives real evidence for more than one at once), then move the conversation forward. Never ask a second follow-up about a dimension already marked heard. Your next_question.dimension MUST be chosen from the STILL-OWED DIMENSIONS list given to you below — never a dimension outside that list, and never simply whatever the customer brought up unprompted.',
    '',
    'HANDLING A VAGUE ANSWER: each still-owed dimension below carries its own guidance describing, with concrete worked examples, exactly what counts as covered versus a vague restatement of the topic (e.g. "we help customers" is never covered; a specific, concrete fact is). Apply that bar literally. Do NOT mark a dimension "heard" just because the customer said something on-topic — and never invent detail they did not actually give. If an answer is vague or generic: (a) leave that dimension OUT of extraction (no change — it stays open) and ask ONE sharper, concrete follow-up on the SAME dimension (a specific example, a number, a named system, a named person), or (b) if you have already asked about it more than once and it is still vague, extract it as "parked" — never "heard" — and move to a different still-owed dimension instead of asking a third time.',
    '',
    'EXTRACTION: for every still-owed dimension the customer\'s LATEST answer genuinely gives real evidence for, emit one entry: {"dimension": <a key from STILL-OWED DIMENSIONS>, "state": "heard"|"parked"|"skipped", "evidence": <the concrete fact, your own words, under 300 characters>}. "skipped" is only for a dimension the customer explicitly says does not apply to their business (never assume this from silence). "parked" is for "ask me later" or a second still-vague answer, as above. Omit a dimension entirely when you have no real update for it this turn — omitting means "no change", never "heard".',
    '',
    'EVIDENCE IS NOT OPTIONAL, AND THIS ONE IS ENFORCED. "heard" and "skipped" both CLOSE a dimension permanently — the interview will never ask about it again. The platform REJECTS your entire turn, unread, if any "heard" or "skipped" entry has an empty or missing "evidence": it is not downgraded for you, the whole extraction is thrown away and you are asked again. So never close a dimension you cannot quote a concrete fact for. If the customer has not given you one, the correct move is to omit the dimension (no change) or "parked" — which needs no evidence, because it closes nothing.',
    '',
    'Return ONLY JSON, nothing else:',
    '{"extraction": [{"dimension": string, "state": "heard"|"parked"|"skipped", "evidence": string}],',
    ' "next_question": {"dimension": string, "text": string} | null,',
    ' "done": boolean}',
    'next_question.dimension MUST be one of the still-owed keys given to you, deliberately chosen — redirect once a dimension is genuinely covered, do not default back to the one the customer was just asked about unless it is still open. Set next_question to null only if you believe this turn\'s extraction covers every still-owed dimension. "done" is your own opinion for logging only — the platform decides authoritatively from the real coverage ledger, never from this field, so getting it wrong changes nothing except that the platform will supply its own next question instead of yours.',
    FIREWALL_RULES,
  ].join('\n');
}

function coerceExtraction(raw: unknown): DiscoveryExtraction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .slice(0, 20)
    .map((x) => ({
      dimension: String(x.dimension ?? ''),
      state: String(x.state ?? ''),
      // Only a genuine STRING counts as evidence. `String(x.evidence)` would
      // have turned `{}` into "[object Object]" and `0` into "0" — both
      // non-empty, both of which would then satisfy coverageAfter's grounds
      // check and close a dimension on nothing. Anything that is not a
      // string becomes null here, and null is exactly what the gate refuses
      // for a terminal state. (coverageAfter is independently strict about
      // this too — it reads a non-string evidence as absent — so the two
      // agree rather than one relying on the other.)
      evidence: typeof x.evidence === 'string' ? x.evidence.slice(0, 500) : null,
    }));
}

type ValidationResult =
  | { ok: true; coverage: DiscoveryCoverageMap }
  | { ok: false; error: string };

/** THE GATE. Every extraction passes through coverageAfter before anything
 *  is persisted — an unknown dimension or state throws, and this function
 *  turns that throw into an honest, retryable validation result rather than
 *  letting it crash the request. */
function validateExtraction(
  dimensions: readonly DimensionRow[],
  priorCoverage: DiscoveryCoverageMap,
  rawExtraction: unknown,
): ValidationResult {
  const extraction = coerceExtraction(rawExtraction);
  try {
    return { ok: true, coverage: coverageAfter(dimensions, priorCoverage, extraction) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Proposal emission — Task 1 of the discovery-proposals-and-creation plan
// (.superpowers/sdd/2026-08-13-discovery-proposals-and-creation).
// proposalsFrom/validatePayload (_shared/discoveryProposals.ts) are pure —
// this is the glue that gives them the live data they need and, for the
// four kinds a pure function cannot finish (employee/guardrail/procedure/
// trust_rule — see that module's header), the one model call that fills in
// the literal §11b says must be on the card before either path is allowed
// through the SAME validatePayload gate.
//
// ⚠ employee joined that list on 2026-08-15. It is NOT a new filter step: a
// candidate whose fit_reason the model cannot ground fails the same
// validatePayload every other incomplete payload fails, and is counted and
// logged on the same line. See discoveryProposals.ts's "EMPLOYEE IS
// MODEL-FILLED" for the defect that moved it.
//
// Writes ONLY to discovery_proposals, state='pending'. Never creates a
// digital_employees, playbook_definitions, guardrail_rules, connectors or
// trust_policies row — that is Task 3. Never reads or writes a
// digital_employees row at all, so is_workforce_assistant is not just
// respected, it is never in scope.
// ============================================================================

/** Best-effort model fill for the four kinds proposalsFrom cannot finish on
 *  its own. Hands each draft to `applyFillToDraft`
 *  (_shared/discoveryProposals.ts) — REVIEW ROUND 1,
 *  Important 3: that function, not this one, owns the per-kind whitelist,
 *  so the same rule is enforced whether a caller reaches it from here or
 *  from a test. This function NEVER marks a draft valid; validatePayload
 *  (run by the caller, on every draft, pure and model-filled alike, with the
 *  same live-namespace options this function is given) is what decides
 *  that. A model that returns nothing usable, times out, or the workspace
 *  having no AI engine configured, all fail the SAME way: the draft's
 *  payload stays incomplete and validatePayload refuses it downstream. That
 *  refusal is never treated as an error here — a partially-heard interview
 *  producing fewer decidable proposals than dimensions it covered is a
 *  legitimate outcome, not a bug. */
async function fillProposalLiterals(
  admin: SupabaseClient,
  drafts: readonly ProposalDraft[],
  employeeArchetypeKeys: readonly string[],
  validActionCategories: readonly string[],
  archetypeByKey: ReadonlyMap<string, ArchetypeLike>,
): Promise<void> {
  if (drafts.length === 0) return;

  const items = drafts.map((d, idx) => {
    const base: Record<string, unknown> = {
      idx,
      kind: d.kind,
      dimension: d.source_dimension,
      evidence: typeof d.payload.evidence === 'string' && d.payload.evidence
        ? d.payload.evidence
        : d.rationale,
    };
    if (d.kind !== 'employee') return base;
    // The role's OWN words, read LIVE from public.role_archetypes by the
    // caller — never a hardcoded description here, and never a hardcoded
    // notion of which roles suit which industry. The model gets the role and
    // the customer's sentence, and is asked to say whether the second
    // supports the first.
    const archetypeKey = String(d.payload.archetype_key ?? '');
    const arch = archetypeByKey.get(archetypeKey);
    // BLOCKER 1 (2026-08-15 review): the model sees EVERY heard dimension's
    // sentence for this role, not just the first one's. Sent as separate
    // entries rather than one joined string precisely because
    // `evidence_quote` must be verbatim from ONE of them — a model shown a
    // joined blob would reasonably quote across the seam and be refused for
    // it. Measured defect this closes: "we do run Google Ads" recorded under
    // systems_of_record (ordinal 9) was invisible to google_ads, which bound
    // winning_business (ordinal 5) and its "leads come from referrals".
    const sources = (Array.isArray(d.payload.evidence_sources) ? d.payload.evidence_sources : []) as EvidenceSource[];
    // ⚠ `evidence` IS DELETED FROM THE EMPLOYEE ITEM, and that is the whole
    // point of the two lines above. `base.evidence` is the ' · '-joined union
    // of every source. Leaving it in place meant each employee item carried
    // BOTH — a field literally named `evidence` holding the joined blob, and
    // `evidence_sources` holding the separate spans — so the comment above
    // described a design the object contradicted three lines later. A model
    // that quotes from the obvious field is refused for straddling the seam,
    // silently, counted only in `refused`.
    const { evidence: _joined, ...employeeBase } = base;
    return {
      ...employeeBase,
      archetype_key: archetypeKey,
      role_name: arch?.name ?? String(d.payload.name ?? ''),
      role_description: arch?.description ?? '',
      role_responsibilities: arch?.responsibilities ?? [],
      evidence_sources: sources.map((s) => ({ topic: s.title, said: s.evidence })),
    };
  });

  // REVIEW ROUND 1, Important 1: no more "unassigned" as an offered answer —
  // instructing a model to emit a placeholder that the gate then has to
  // catch was fighting itself. The omission instruction already given for
  // every other unsupported field now covers de_ref too.
  // REVIEW ROUND 1, Important 2: action_category is constrained to the REAL,
  // LIVE namespace (read from public.trust_policies by the caller — see
  // emitProposals below), not free text — an invented category would
  // produce a trust rule that enforces nothing.
  const system = [
    'You are extracting the ONE concrete, enforceable detail a business owner needs before they can approve a draft recommendation — never inventing a fact the evidence does not support.',
    '',
    'You are given several DRAFT items. For each, return exactly the fields listed for its "kind":',
    '',
    // ── employee ──────────────────────────────────────────────────────────
    // THE DEFAULT IS TO DECLINE, said in the prompt in those words, because
    // the candidate list handed to the model is deliberately the WIDEST the
    // answer may be, not a shortlist: it is every role the topic could
    // conceivably involve (winning_business alone nominates six, including
    // SEO, Google Ads and social media). A model that treats the list as a
    // recommendation reproduces exactly the defect this exists to fix, so
    // "most of these will not fit" and "omitting is the correct answer" are
    // stated outright rather than implied.
    '"employee": return BOTH of these two fields, or neither:',
    '  - "evidence_quote" — a span copied EXACTLY, character for character, from ONE of that item\'s "evidence_sources[].said" strings. At least 3 words. Do not tidy it, do not fix its grammar, do not merge words from two different entries, do not join two parts with an ellipsis, do not paraphrase it. The platform checks it verbatim against those strings and refuses the whole item if it does not match, so an approximate quote costs you the item.',
    '  - Choose a span that still means what the sentence meant. If the recorded note says they do NOT do something, or want it only later, that is a reason to DECLINE the item — never a span to quote out of its negation.',
    '  - "fit_reason" — ONE short sentence, IN YOUR OWN WORDS, saying what that quoted fact makes true about this business that is worth paying this role to handle. Paraphrase freely here; this one is not checked verbatim.',
    'THE DEFAULT FOR AN EMPLOYEE ITEM IS TO DECLINE, and declining is done by OMITTING both fields (or returning null for them). The roles you are shown are not a shortlist: they are every role the interview topic could conceivably involve, for any business in any industry. Most of them will NOT fit the business in front of you. If nothing the customer said clearly supports hiring this specific role for this specific business, OMIT them. That is the CORRECT answer and the platform will simply not offer the role — it is not a failure, you are not being marked on how many you fill in, and filling one in on thin evidence is a worse outcome than leaving it empty, because the customer will believe the recommendation came from what they told us. The quote goes on the card in front of them: if you would be embarrassed to have this customer read that sentence next to that job title, decline.',
    'Do NOT restate the role\'s own name, description or responsibilities back at us ("a Support Agent handles support tickets") — that is true of every business on earth and therefore says nothing about this one. Do not write generic value claims ("this role would help the business grow"). If the only thing you can write is generic, the honest answer is to omit both fields.',
    '',
    '"guardrail": return "pattern" (a short "|"-separated list of the literal words or phrases the rule matches, lowercase, e.g. "refund|chargeback|free month" — at most a handful of tokens, never a sentence) OR "threshold" (a bare number, no words) — whichever the evidence actually supports. Never both, never neither if the evidence gives you anything concrete to work with.',
    '"procedure": return "name" (a short title), "trigger" (the concrete event or schedule that starts it, in the evidence\'s own terms) and "steps" (an ordered array of 2 to 6 short, concrete steps the evidence actually implies).',
    `"trust_rule": return "de_ref" — the single best match from this session's proposed employees, one of ${JSON.stringify(employeeArchetypeKeys)}, formatted EXACTLY as "archetype:<key>". If none of those employees plausibly owns this approval, OMIT de_ref entirely (and therefore the whole item) — never write "unassigned" or invent a reference. Also return "action_category" chosen EXACTLY from this workspace's real category list: ${JSON.stringify(validActionCategories)} — if none of them fits, OMIT action_category rather than inventing a new one. Also return "cap" (a bare number — the literal amount or threshold named in the evidence, no words) and "above_cap" (one short sentence: what happens above it).`,
    '',
    'If an item\'s evidence genuinely does not support a real value for a required field, OMIT that field rather than guessing — an omitted field means the platform will correctly decline to show that item to the customer, which is the safe outcome, not a failure.',
    '',
    // BLOCKER 2 (2026-08-15 review): the response used to be matched to
    // drafts by array index ALONE. An answer written for item 4 landing on
    // item 7 passed every check and rendered as a specific, customer-grounded
    // sentence under the wrong job title. The model must now say which item
    // each answer is for, in fields the platform can compare — and for an
    // employee it is REQUIRED, because that is the kind where a mismatch is
    // invisible on the card.
    'Return ONLY a JSON array, one object per item, each carrying "idx" AND "kind" copied EXACTLY from that input item — and, for an "employee" item, "archetype_key" copied exactly too — plus only the fields described above for that item\'s kind. Nothing else — no prose, no markdown fences.',
    'The platform matches your answers back to the items by those copied fields. An employee answer with no "archetype_key", or one whose copied value does not match the item it lands on, is DISCARDED WHOLESALE — so copy them, and never move an answer from one item to another.',
    FIREWALL_RULES,
  ].join('\n');

  const userMsg = `DRAFT ITEMS:\n${wrapUntrusted(JSON.stringify(items), 'proposal-fill-items')}`;

  // The fill is ONE call covering every draft, and a truncated JSON array
  // silently drops its tail — which, now that employee is a filled kind,
  // would read as "the model declined the last N roles" rather than as the
  // truncation it is. A real interview can carry 15+ employee candidates, so
  // the budget scales with the item count instead of sitting at the 1024
  // default that was sized when at most a handful of structural drafts ever
  // reached here.
  const fillMaxTokens = Math.min(4096, Math.max(1024, 256 + drafts.length * 160));

  let parsed: unknown[] | null = null;
  try {
    const res = await callFillModel(admin, system, [{ role: 'user', content: userMsg }], fillMaxTokens);
    if ('error' in res) {
      console.error(`[discovery-interview] proposal-fill model call failed: ${res.error}`);
    } else {
      // parseJson (above) expects a top-level JSON OBJECT; the model is
      // asked for a bare array here, so match the array directly instead.
      const m = res.text.match(/\[[\s\S]*\]/);
      parsed = m ? (JSON.parse(m[0]) as unknown[]) : null;
    }
  } catch (e) {
    console.error(`[discovery-interview] proposal-fill response unusable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed) return; // every draft stays incomplete -> validatePayload will refuse each, honestly

  const byIdx = new Map<number, Record<string, unknown>>();
  for (const raw of parsed) {
    if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).idx === 'number') {
      byIdx.set((raw as Record<string, unknown>).idx as number, raw as Record<string, unknown>);
    }
  }

  for (let i = 0; i < drafts.length; i++) {
    const fill = byIdx.get(i);
    // No fill for this item is the model DECLINING it, and for an employee
    // that is the documented correct answer, not an error: the payload stays
    // incomplete and validatePayload refuses it downstream, counted as
    // `refused` by the caller exactly like a guardrail with no pattern.
    if (!fill) continue;
    // REVIEW ROUND 1, Important 3: whitelist, not a blind merge — enforced
    // by applyFillToDraft/applyModelFill (_shared/discoveryProposals.ts),
    // tested directly there against an adversarial fill object.
    // BLOCKER 2 (2026-08-15): the index lookup is no longer the ONLY thing
    // deciding which draft an answer belongs to. applyFillToDraft refuses a
    // fill that cannot prove it was written for this draft and returns the
    // reason — see fillIdentityProblem for what "prove" means per kind and
    // why employee is the strict one. A refused fill leaves the draft
    // incomplete, so it is refused downstream by the same validatePayload as
    // every other unfinished payload: still no second drop path, and the
    // reason is logged here rather than swallowed.
    const problem = applyFillToDraft(drafts[i], fill);
    if (problem) {
      console.error(`[discovery-interview] model fill discarded (${drafts[i].kind}, source_dimension=${drafts[i].source_dimension}): ${problem}`);
    }
  }
}

/** Fetches the live archetype and provider catalogs, derives every proposal
 *  draft, fills the three model-dependent kinds, refuses (drops, logs) any
 *  payload that still fails validatePayload — pure or model-filled alike,
 *  same gate — and inserts the survivors into discovery_proposals as
 *  state='pending'. Returns honest counts; never partial-writes a payload
 *  that failed validation.
 *
 *  IDEMPOTENCY, IN TWO LAYERS. The cheap read below ("does this session
 *  already have proposals?") closes the normal case without doing any work.
 *  It is NOT airtight against two concurrent requests for the same session
 *  racing it, so migration 740 added the constraint that is:
 *
 *      unique (session_id, kind, identity_key)
 *
 *  where identity_key is a generated column resolving per kind — the
 *  archetype_key for an employee, the provider_key for a connector, the
 *  source_dimension for everything else. That is why the write below is an
 *  upsert with ignoreDuplicates rather than an insert: under a race the
 *  loser must skip the rows that already exist, not fail the whole batch.
 *
 *  ⚠ The conflict target is NOT (session_id, kind, source_dimension). One
 *  dimension proposes many employees — serves_archetypes has 13 entries in
 *  one place — so keying on the dimension would silently drop every employee
 *  after the first. Migration 740's probe 2 fires exactly that case. */
/** Why the model fill did or did not run — IMPORTANT 6 (2026-08-15 review).
 *
 *  THE DEFECT: emitProposals checks check_tenant_ai_budget before filling,
 *  but the 'end' action never checks it before calling emitProposals, while
 *  'answer' returns 429. So an over-budget workspace that ends an interview
 *  loses EVERY employee, guardrail, procedure and trust rule — all four
 *  model-filled kinds refused at once, connectors alone surviving — and the
 *  only trace was a console.error and a `refused` integer that reads exactly
 *  like a correctly-narrowing interview. Before employee became model-filled,
 *  employees survived that path because they were pure, so this path got
 *  strictly worse in the same change.
 *
 *  WHY NOT A 429 ON 'end' TOO, argued rather than assumed: 'end' is the
 *  caller-stops path (migration 739). Its own work — end_discovery_session,
 *  the honest coverage/owed report — costs no AI at all, and it is the ONLY
 *  way a session leaves 'running'. A 429 there would strand the customer's
 *  session open indefinitely and give them no way to record that they
 *  stopped, to fix a budget problem they cannot act on from that screen. That
 *  trades a recoverable loss (proposals, which the interview can produce
 *  again) for an unrecoverable one (a session nobody can close). So 'end'
 *  still ends.
 *
 *  WHAT CHANGES: the outcome stops being silent. This field rides back in the
 *  'end'/'answer' response next to the counts, so "this workspace is over its
 *  AI budget" is distinguishable from "the customer's own words supported
 *  nothing" — which is the distinction the refusal design depends on and the
 *  one an integer alone cannot carry.
 *
 *  ⚠ 'skipped_ai_budget' and 'skipped_no_llm' both mean the loss is REAL and
 *  NOT retried: emitProposals' idempotency guard means a second 'end' on the
 *  same session proposes nothing. The caller is told so it can say so. */
type ModelFillOutcome = 'not_needed' | 'ran' | 'skipped_no_llm' | 'skipped_ai_budget';

interface EmitProposalsResult {
  proposed: number;
  refused: number;
  /** ⚠ 754/FIX ROUND: conversation_type is the ONE kind that emits a fixed
   *  CEILING of blank shapes (TOPIC_SLOTS = 10) from a single dimension rather
   *  than one shape per derived candidate. A customer who names three topics
   *  leaves seven of those never written into, and counting them in `refused`
   *  made the screen say "we dropped 7 drafts because we could not point at
   *  something you said" about seven things that were never drafted from
   *  anything. They are counted HERE instead — separately, so the drop is
   *  auditable rather than silent, and so no customer-facing sentence adds them
   *  to a loss. See isUnusedTopicSlot for the argument and the measurements. */
  unused_topic_slots: number;
  skipped_already_proposed: boolean;
  model_fill: ModelFillOutcome;
}

async function emitProposals(
  admin: SupabaseClient,
  tenantId: string,
  sessionId: string,
  dimensions: readonly DimensionRow[],
  coverage: DiscoveryCoverageMap,
): Promise<EmitProposalsResult> {
  const { count: existing } = await admin
    .from('discovery_proposals')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId);
  if ((existing ?? 0) > 0) {
    return { proposed: 0, refused: 0, unused_topic_slots: 0, skipped_already_proposed: true, model_fill: 'not_needed' };
  }

  // REVIEW ROUND 1, Important 2: read the REAL, live action_category
  // namespace once per emission — never hardcoded here. Global (no tenant
  // filter), same justification as role_archetypes/connector_providers
  // above: this is a schema-level VOCABULARY (set_trust_ladder keys
  // enforcement off this exact column), not per-tenant data, and a brand
  // new tenant undergoing its first discovery interview has ZERO rows of
  // its own in trust_policies — scoping this to the current tenant would
  // make the whitelist empty and silently block every trust_rule proposal
  // for exactly the customers this feature exists for.
  const [archResult, catalogResult, categoryResult] = await Promise.all([
    // ⚠ THE COLUMN LIST IS NOT WRITTEN HERE. It is ROLE_ARCHETYPE_SELECT,
    // exported from _shared/discoveryProposals.ts and asserted by
    // tests/discovery-proposals.test.ts — IMPORTANT 1 of the 2026-08-15
    // review, PROVEN BY MUTATION: reverting this SELECT to the pre-BLOCKER-2
    // list left the whole suite green while, in production, every employee
    // would have been refused for "does not say what systems it can touch"
    // and the log line would have read exactly like a correctly-narrowing
    // interview. No test can import this file (Node's ESM loader rejects its
    // https: imports) and tsconfig excludes supabase/functions, so a literal
    // list here is pinned by nothing whatsoever. See that constant's own
    // header for why each column is load-bearing.
    admin.from('role_archetypes')
      .select(ROLE_ARCHETYPE_SELECT)
      .eq('status', 'active'),
    admin.from('connector_providers').select('provider_key, label, category, aliases').eq('active', true),
    admin.from('trust_policies').select('action_category').limit(5000),
  ]);
  if (archResult.error) console.error(`[discovery-interview] role_archetypes fetch failed (proceeding without): ${archResult.error.message}`);
  if (catalogResult.error) console.error(`[discovery-interview] connector_providers fetch failed (proceeding without): ${catalogResult.error.message}`);
  if (categoryResult.error) console.error(`[discovery-interview] trust_policies category fetch failed (proceeding without a namespace check): ${categoryResult.error.message}`);
  const archetypes = (archResult.data ?? []) as ArchetypeLike[];
  const archetypeByKey = new Map(archetypes.map((a) => [a.key, a] as const));
  /** The archetype's OWN vocabulary, for fitReasonProblem check (b) — a
   *  fit_reason made only of these words is the role describing itself,
   *  which is true for every business and so evidence about none. Built from
   *  the live row, never from a table in code. */
  const archetypeSelfText = (key: string): string | undefined => {
    const a = archetypeByKey.get(key);
    if (!a) return undefined;
    return [a.name, a.description ?? '', ...(a.responsibilities ?? [])].join(' ');
  };
  const providerCatalog = (catalogResult.data ?? []) as ProviderCatalogRow[];
  const validActionCategories = new Set(
    ((categoryResult.data ?? []) as Array<{ action_category: string | null }>)
      .map((r) => (typeof r.action_category === 'string' ? r.action_category.trim() : ''))
      .filter((c) => c.length > 0),
  );
  // Empty is a real, if rare, platform state (e.g. a freshly bootstrapped
  // environment with zero trust_policies rows anywhere) — treated as "we
  // cannot determine the real namespace", not "nothing is valid", the same
  // fallback validatePayload already takes when this option is omitted
  // entirely. Enforcing membership against a known-empty set would refuse
  // every trust_rule outright, which is a worse failure than not checking.
  // ⚠ vocabularyOrUndefined, not an inline `.size > 0` ternary, because the
  // de_ref set below needs the IDENTICAL degradation and had the opposite
  // one — see IMPORTANT 5 and that function's own header.
  const validActionCategoriesOrUndefined = vocabularyOrUndefined(validActionCategories);

  const drafts = proposalsFrom(dimensions, coverage, archetypes, { providerCatalog });
  if (drafts.length === 0) return { proposed: 0, refused: 0, unused_topic_slots: 0, skipped_already_proposed: false, model_fill: 'not_needed' };

  // The employee CANDIDATES — every one of which may still be declined by
  // the fill below. This list is what the fill prompt offers a trust_rule's
  // de_ref, because the prompt is written before any validation has run; the
  // de_ref MEMBERSHIP check further down uses the narrower SURVIVOR set
  // instead, so a trust rule naming an employee the interview ended up not
  // offering is refused rather than left pointing at nothing.
  const employeeArchetypeKeys = drafts
    .filter((d) => d.kind === 'employee')
    .map((d) => String(d.payload.archetype_key));

  const needsFill = drafts.filter((d) => d.needs_model_fill);
  let modelFill: ModelFillOutcome = 'not_needed';
  if (needsFill.length > 0) {
    // NO MODEL, OR BUDGET EXCEEDED → every model-dependent draft stays
    // incomplete and is refused below. For employee that is the SAFE
    // direction, not a silent loss: offering all six of winning_business's
    // roles unfiltered is precisely the defect this path exists to stop. It
    // is also close to unreachable in practice — the interview's own 'start'
    // action returns 503 llm_not_configured before a session can exist
    // (see the `action === 'start'` block below), so a covered interview
    // without a provider means the key was removed mid-interview.
    if (!(await hasLLMProvider(admin, tenantId))) {
      modelFill = 'skipped_no_llm';
      console.error(`[discovery-interview] skipping model-fill for ${needsFill.length} proposal(s): no AI engine configured for this workspace`);
    } else {
      const { data: budget, error: budgetErr } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
      if (budgetBlocked(budgetErr, budget)) {
        // IMPORTANT 6 — see ModelFillOutcome's header. Reported back to the
        // caller, not only logged: every model-filled kind is about to be
        // refused for a reason that has nothing to do with what the customer
        // said, and an integer count cannot carry that difference.
        modelFill = 'skipped_ai_budget';
        console.error(`[discovery-interview] skipping model-fill for ${needsFill.length} proposal(s): AI budget exceeded — every employee, guardrail, procedure and trust rule in this session will now be refused for want of its literal, and this session will not be re-proposed`);
      } else {
        modelFill = 'ran';
        await fillProposalLiterals(admin, needsFill, employeeArchetypeKeys, [...validActionCategories], archetypeByKey);
      }
    }
  }

  const rows: Record<string, unknown>[] = [];
  let refused = 0;
  let unusedTopicSlots = 0;
  const keepOrRefuse = (d: ProposalDraft, options: ValidatePayloadOptions): boolean => {
    try {
      validatePayload(d.kind, d.payload, options);
      rows.push({
        session_id: sessionId,
        tenant_id: tenantId,
        kind: d.kind,
        payload: d.payload,
        rationale: d.rationale,
        source_dimension: d.source_dimension,
        state: 'pending',
      });
      return true;
    } catch (e) {
      // ⚠⚠ AN UNUSED SLOT IS NOT A REFUSAL, and this is the ONE place the two
      // are told apart. conversation_type emits TOPIC_SLOTS blank shapes from
      // one dimension — a ceiling, not a derivation — so a customer who names
      // three topics leaves seven shapes the model never wrote a word into.
      // Counting those as refusals made outcomeReport say "we dropped 7 drafts
      // because we could not point at something you said to justify them" about
      // seven things that were never drafted from anything, and `refused` is a
      // number the customer reads as a quality signal.
      // It is COUNTED, not skipped: a second drop path that increments nothing
      // is exactly how a filter stops being auditable. isUnusedTopicSlot is
      // deliberately narrow — any slot the model touched at all is a real
      // refusal below, on the same path as everything else.
      if (isUnusedTopicSlot(d.kind, d.payload)) {
        unusedTopicSlots++;
        console.error(`[discovery-interview] conversation_type slot UNUSED, not refused (source_dimension=${d.source_dimension}): the customer named fewer topics than the ceiling of blank slots this dimension emits, so nothing was ever drafted into this one. Counted in unused_topic_slots.`);
        return false;
      }
      refused++;
      // Named, not silent: the refusal IS the feature (§11b) — a guardrail
      // with no pattern, a trust rule with no cap, an employee the customer's
      // own words do not support, is unapprovable, and dropping it here
      // rather than writing it incomplete is correct behaviour, not a bug to
      // fix by loosening validatePayload. ⚠ An employee refusal is now the
      // ORDINARY case, not an anomaly: the candidate list is every role the
      // topic could involve, and most will not fit. It is logged at the same
      // level through the same path deliberately — a second, quieter drop
      // path is exactly how a filter stops being auditable.
      console.error(`[discovery-interview] proposal refused, not persisted (${d.kind}, source_dimension=${d.source_dimension}): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  // PASS 1 — employees, because pass 2's trust_rule de_ref check needs to
  // know which of them actually survived.
  const survivingEmployeeKeys: string[] = [];
  for (const d of drafts) {
    if (d.kind !== 'employee') continue;
    const key = String(d.payload.archetype_key ?? '');
    if (keepOrRefuse(d, { archetypeSelfText: archetypeSelfText(key) })) survivingEmployeeKeys.push(key);
  }
  // REVIEW ROUND 1, Important 1: the exact "archetype:<key>" references a
  // trust_rule's de_ref is allowed to name THIS session — nothing else
  // exists yet for it to point at (Task 1 creates no rows besides these
  // proposals), so an employee not proposed this round is not a real
  // reference either. Since 2026-08-15 "proposed this round" means SURVIVED
  // validation, not merely "was a candidate": a trust rule handing autonomy
  // to a role the customer is never offered is not something a person can
  // approve.
  //
  // ⚠ IMPORTANT 5 (2026-08-15 review), measured: this used to be a bare
  // `new Set(...)`, and an EMPTY Set is TRUTHY. A session where zero
  // employees survived therefore refused EVERY trust_rule — including a cap
  // the customer had volunteered out loud, on a dimension that has nothing
  // to do with which roles fit. Now it degrades to `undefined` exactly as
  // validActionCategories above does: validatePayload falls back to its
  // shape checks, which still refuse "unassigned" and free text. Narrowing
  // when we know nothing is honest; refusing everything is not.
  const validDeRefs = vocabularyOrUndefined(survivingEmployeeKeys.map((k) => `archetype:${k}`));

  // PASS 2 — everything else.
  for (const d of drafts) {
    if (d.kind === 'employee') continue;
    keepOrRefuse(d, { validActionCategories: validActionCategoriesOrUndefined, validDeRefs });
  }

  if (rows.length > 0) {
    const { error: insErr } = await admin
      .from('discovery_proposals')
      .upsert(rows, { onConflict: 'session_id,kind,identity_key', ignoreDuplicates: true });
    if (insErr) throw new Error(`discovery_proposals upsert failed: ${insErr.message}`);
  }

  return { proposed: rows.length, refused, unused_topic_slots: unusedTopicSlots, skipped_already_proposed: false, model_fill: modelFill };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('method_not_allowed', 'POST only', 405);

  let tenantId: string | null = null;
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');
    if (action !== 'start' && action !== 'answer' && action !== 'end') {
      return fail('bad_request', "action must be 'start', 'answer' or 'end'", 400);
    }

    // ── auth: user JWT (tenant resolved from profile) or service/dispatch
    // with an explicit tenant_id — the entity-draft pattern. Discovery is a
    // setup-time action any tenant member can run for their own workspace,
    // not a manager-only mutation like compile-trust-plan's trust ladders. ──
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if ((dispatch && req.headers.get('x-dispatch-secret') === dispatch) || bearer === svc) {
      tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : null;
      if (!tenantId) return fail('bad_request', 'tenant_id required for service/dispatch calls', 400);
    } else {
      const { data: u } = await admin.auth.getUser(bearer);
      if (!u?.user) return fail('unauthorized', 'user JWT required', 401);
      const { data: prof } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', u.user.id).maybeSingle();
      tenantId = await resolveTenantWithRemoteAccess(admin, u.user.id, prof?.tenant_id, prof?.layer, body?.tenant_id);
      if (!tenantId) return fail('no_tenant', 'no tenant resolved for this user', 403);
    }

    const gate = await loadTenantGate(admin, tenantId);
    if (gate.suspended) return json({ ok: false, ...TENANT_SUSPENDED_BODY }, 402);

    const { data: dimRows, error: dimErr } = await admin
      .from('discovery_dimensions')
      .select('key, ordinal, title, guidance, serves_archetypes')
      .eq('active', true)
      .order('ordinal', { ascending: true });
    if (dimErr) return fail('dimensions_unavailable', dimErr.message, 500);
    const dimensions = (dimRows ?? []) as DimensionRow[];
    if (dimensions.length === 0) return fail('no_dimensions', 'no active discovery dimensions are configured', 500);
    const dimByKey = new Map(dimensions.map((d) => [d.key, d]));

    // ── action: start ──────────────────────────────────────────────────
    if (action === 'start') {
      // No model call happens in this action (the opening question is
      // deterministic — see fallbackQuestionText), but every turn after
      // this one needs the AI engine, so fail BEFORE creating a session
      // rather than leaving a stray row an interview can never continue.
      if (!(await hasLLMProvider(admin, tenantId))) {
        return fail('llm_not_configured', 'no AI engine key configured for this workspace yet (Settings → AI Engine) — the interview needs it for every turn after this one', 503);
      }

      const sessionId = await rpcOrThrow<string>(admin, 'start_discovery_session', { p_tenant_id: tenantId });

      const opening = `Hi! I'd like to get to know your business so we can set things up right. ${fallbackQuestionText(dimensions[0])}`;
      const openingTurn: TranscriptTurn = { role: 'assistant', text: opening, at: new Date().toISOString() };
      // Best-effort side record, same contract as rpcLoud: a failure here
      // must not cost the customer their session_id/opening question (the
      // next 'answer' call still works off whatever transcript actually
      // persisted), but it must be LOGGED, never silently swallowed.
      const { error: transcriptErr } = await admin.from('discovery_sessions').update({ transcript: [openingTurn] }).eq('id', sessionId);
      if (transcriptErr) console.error(`[discovery-interview] opening transcript write failed (best-effort, continuing): ${transcriptErr.message}`);

      return json({ session_id: sessionId, question: opening });
    }

    // ── actions: answer + end — both act on one existing session ───────
    const sessionId = String(body.session_id ?? '').trim();
    if (!sessionId) return fail('bad_request', 'session_id required', 400);

    // Cross-tenant perimeter: the session must belong to the TENANT WE
    // RESOLVED, not merely exist — a bare session_id is never treated as
    // its own authorization (the exact "tenant-id param IS authorisation"
    // pattern this codebase has had to re-fence more than once).
    const { data: session, error: sessErr } = await admin
      .from('discovery_sessions')
      .select('id, status, coverage, transcript')
      .eq('id', sessionId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (sessErr) return fail('session_unavailable', sessErr.message, 500);
    if (!session) return fail('session_not_found', 'no such discovery session in this workspace', 404);

    // ── action: end ────────────────────────────────────────────────────
    // The caller-stops path (migration 739). No model call, no coverage
    // write: this says the CONVERSATION is over, never that anything more
    // was heard in it. The gaps are reported from the same ledger, through
    // the same stillOwed the turn loop uses — there is deliberately no
    // second definition of "what is still owed" anywhere, in SQL or here.
    if (action === 'end') {
      const endStatus = String(body.status ?? 'parked').trim();
      if (endStatus !== 'parked' && endStatus !== 'abandoned') {
        return fail('bad_request', "status must be 'parked' (the customer means to come back) or 'abandoned' (they do not)", 400);
      }
      const resumeHint = body.resume_hint != null ? String(body.resume_hint).trim().slice(0, 500) : null;
      // Already ended into the SAME state: idempotent, the RPC no-ops and
      // the honest report below is still worth returning. Ended into a
      // DIFFERENT one: refused here rather than deep inside the RPC, so the
      // caller gets a 409 it can act on instead of a 500.
      if (session.status !== 'running' && session.status !== endStatus) {
        return fail('session_not_running', `this session is '${session.status}', not running — it cannot be ended as '${endStatus}'`, 409);
      }
      // Captured BEFORE the RPC transitions status, so proposal emission
      // below only fires on a REAL running->ended transition, never on an
      // idempotent retry of an already-ended session (which would otherwise
      // try to propose a second time for the same session).
      const wasRunning = session.status === 'running';

      const result = await rpcOrThrow<Record<string, unknown>>(admin, 'end_discovery_session', {
        p_session_id: sessionId,
        p_tenant_id: tenantId,
        p_status: endStatus,
        p_resume_hint: resumeHint,
      });

      const endCoverage = coverageAfter(dimensions, (session.coverage ?? {}) as DiscoveryCoverageMap, []);
      const owed = stillOwed(endCoverage);

      // Proposal emission (Task 1: .superpowers/sdd/2026-08-13-discovery-
      // proposals-and-creation). "Abandonment mid-interview keeps what was
      // accepted and records the gaps — partial is a legitimate end state,
      // not an error" (spec §7): whatever WAS heard before the customer
      // stopped still gets proposed, even though owed_count > 0. Only
      // 'heard' dimensions ever produce anything — see
      // discoveryProposals.ts's hard rule — so a mostly-unheard interview
      // simply proposes little or nothing, honestly.
      // ⚠ IMPORTANT 6 (2026-08-15 review): there is deliberately NO budget
      // gate in front of this call, and no 429 on this action. See
      // ModelFillOutcome's header for the argument — briefly: 'end' is the
      // only way a session leaves 'running', its own work costs no AI, and
      // stranding a session open is a worse loss than losing proposals the
      // interview can produce again. The over-budget outcome is instead made
      // VISIBLE, in `proposals.model_fill` below.
      const proposals: EmitProposalsResult = wasRunning
        ? await emitProposals(admin, tenantId, sessionId, dimensions, endCoverage)
        : { proposed: 0, refused: 0, unused_topic_slots: 0, skipped_already_proposed: true, model_fill: 'not_needed' };

      return json({
        session_id: sessionId,
        status: endStatus,
        previous_status: result?.previous_status ?? session.status,
        resume_hint: result?.resume_hint ?? resumeHint,
        coverage: endCoverage,
        // The honest half: what this interview is ending WITHOUT. Named
        // explicitly rather than left for the reader to derive from
        // coverage, because "we stopped" and "we stopped with nine of
        // fourteen never asked" are different facts.
        owed,
        owed_count: owed.length,
        proposals,
        done: true,
      });
    }

    // ── action: answer ─────────────────────────────────────────────────
    const text = String(body.text ?? '').trim().slice(0, MAX_ANSWER_CHARS);
    if (!text) return fail('bad_request', "text required — the customer's answer", 400);
    if (session.status !== 'running') {
      return fail('session_not_running', `this session is '${session.status}', not running — it cannot take another answer`, 409);
    }

    if (!(await hasLLMProvider(admin, tenantId))) {
      return fail('llm_not_configured', 'no AI engine key configured for this workspace (Settings → AI Engine)', 503);
    }
    const { data: budget, error: budgetErr } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
    if (budgetBlocked(budgetErr, budget)) return fail('ai_budget_exceeded', 'this workspace has reached its AI budget', 429);

    // Baselined through the SAME gate every extraction goes through, with an
    // empty extraction. This is not a no-op: coverageAfter(dimensions, raw,
    // []) returns a COMPLETE map keyed by every CURRENTLY active dimension,
    // defaulting anything raw is missing to not_heard. Without this, a
    // dimension added to discovery_dimensions after this session started
    // (start_discovery_session cannot have seeded it) would be simply absent
    // from the raw coverage object, stillOwed would never see it as owed,
    // and the interview would fail OPEN — declaring itself done having asked
    // about that dimension exactly never. Cannot fire today
    // (start_discovery_session seeds every active dimension at turn zero),
    // but it is the wrong direction to fail in against exactly the drift the
    // live-spine test in discovery-sidetrack.test.ts exists to catch, so the
    // baseline runs unconditionally rather than depending on that always
    // holding true in the future.
    const rawCoverage = (session.coverage ?? {}) as DiscoveryCoverageMap;
    const priorCoverage = coverageAfter(dimensions, rawCoverage, []);
    const owedKeysBefore = new Set(stillOwed(priorCoverage));
    const owedDims = dimensions.filter((d) => owedKeysBefore.has(d.key));

    // Defensive, not expected in normal use: if a prior turn already closed
    // every dimension, answer honestly without spending a model call rather
    // than crash on an empty owed set.
    if (owedDims.length === 0) {
      return json({ question: null, coverage: priorCoverage, done: true });
    }

    const priorTranscript = (Array.isArray(session.transcript) ? session.transcript : []) as TranscriptTurn[];
    const transcriptForModel = priorTranscript
      .slice(-MAX_TRANSCRIPT_TURNS_TO_MODEL)
      .map((t) => `${t.role === 'user' ? 'CUSTOMER' : 'INTERVIEWER'}: ${t.text}`)
      .join('\n');

    const system = buildInterviewSystem();
    const owedForPrompt = owedDims.map((d) => ({ key: d.key, title: d.title, guidance: d.guidance }));
    const buildUserMsg = (correction?: string): string =>
      `${owedDims.length} of ${dimensions.length} topics remain open — pace yourself accordingly (do not spend several turns on one when this many are still waiting).\n\n`
      + `STILL-OWED DIMENSIONS (the ONLY legal targets for next_question.dimension — platform-authored, trusted):\n${JSON.stringify(owedForPrompt)}\n\n`
      + `CONVERSATION SO FAR:\n${wrapUntrusted(transcriptForModel, 'interview-transcript')}\n\n`
      + `THE CUSTOMER'S LATEST ANSWER:\n${wrapUntrusted(text, 'customer-latest-answer')}`
      + (correction ? `\n\n${correction}` : '');

    let totalIn = 0, totalOut = 0;

    async function attempt(correction?: string): Promise<{ parsed: Record<string, unknown> | null; failReason: string | null }> {
      const c = await callModel(admin, system, [{ role: 'user', content: buildUserMsg(correction) }], 1536);
      if ('error' in c) return { parsed: null, failReason: `model call failed: ${c.error}` };
      totalIn += c.inTok; totalOut += c.outTok;
      const p = parseJson(c.text);
      if (!p) return { parsed: null, failReason: 'model did not return valid JSON' };
      return { parsed: p, failReason: null };
    }

    let { parsed, failReason } = await attempt();
    let validation: ValidationResult = parsed
      ? validateExtraction(dimensions, priorCoverage, parsed.extraction)
      : { ok: false, error: failReason ?? 'no parseable model response' };

    // Exactly ONE retry total, whichever failure class fired — unparseable
    // JSON or a spine-violating extraction both cost one question, never
    // the session (task instructions, verbatim).
    if (!validation.ok) {
      const correction = failReason
        ? 'Your previous reply was not valid JSON. Return ONLY the JSON object described above, nothing else.'
        : `Your previous extraction was rejected: ${validation.error}. Every "dimension" you name MUST be one of the exact keys in STILL-OWED DIMENSIONS above. Every "state" must be exactly "heard", "parked" or "skipped" — "not_heard" is never something you may claim. Every "heard" and every "skipped" MUST carry a non-empty "evidence" quoting the concrete fact the customer actually gave; if you cannot point to one, do not include that dimension at all (omitting it means "no change", which is always safe) or use "parked". Return the corrected, complete JSON object, nothing else.`;
      const retry = await attempt(correction);
      parsed = retry.parsed;
      failReason = retry.failReason;
      validation = parsed
        ? validateExtraction(dimensions, priorCoverage, parsed.extraction)
        : { ok: false, error: failReason ?? 'no parseable model response' };
    }

    // Give up gracefully: mark nothing, carry prior coverage forward
    // unchanged. The customer's raw answer is still saved to the
    // transcript below, so nothing said is lost — only credited.
    const newCoverage: DiscoveryCoverageMap = validation.ok ? validation.coverage : priorCoverage;

    // Persist ONLY what actually changed this turn. record_dimension_state
    // is a CLAIM the customer's answer is recorded — a failure here must
    // stop the response, never be swallowed (rpcOrThrow, not rpcLoud; see
    // _shared/rpcSafety.ts's own header on why .rpc() resolving on error is
    // exactly the trap this avoids).
    const changedKeys = Object.keys(newCoverage).filter((k) => {
      const before = priorCoverage[k];
      const after = newCoverage[k];
      return !before || before.state !== after.state || (before.evidence ?? null) !== (after.evidence ?? null);
    });
    for (const key of changedKeys) {
      const entry = newCoverage[key];
      await rpcOrThrow(admin, 'record_dimension_state', {
        p_session_id: sessionId, p_dimension: key, p_state: entry.state, p_evidence: entry.evidence,
      });
    }

    const owedAfter = stillOwed(newCoverage);
    const done = owedAfter.length === 0; // computed from the real ledger — never from parsed.done

    // next_question: the model PROPOSES, this function DISPOSES. Used only
    // when it names a dimension genuinely still owed AFTER this turn's
    // extraction — the hard version of "the model cannot leave the spine";
    // the prompt only asks nicely, this is what actually enforces it.
    let questionText: string | null = null;
    if (!done) {
      const proposedRaw = parsed && typeof parsed.next_question === 'object' ? parsed.next_question as Record<string, unknown> | null : null;
      const proposedDim = proposedRaw ? String(proposedRaw.dimension ?? '') : '';
      const proposedText = proposedRaw ? String(proposedRaw.text ?? '').trim().slice(0, 600) : '';
      questionText = proposedText && owedAfter.includes(proposedDim)
        ? proposedText
        : fallbackQuestionText(dimByKey.get(owedAfter[0])!);
    }

    // Transcript: appended separately from the per-dimension coverage
    // writes above (which already went through record_dimension_state) —
    // this is the ONLY place discovery_sessions.transcript is written.
    const now = new Date().toISOString();
    const newTranscript: TranscriptTurn[] = [
      ...priorTranscript,
      { role: 'user', text, at: now },
      ...(questionText ? [{ role: 'assistant' as const, text: questionText, at: now }] : []),
    ].slice(-MAX_TRANSCRIPT_TURNS_STORED);
    // Best-effort side record, same contract as rpcLoud: the coverage state
    // that actually gates the interview was already durably persisted above
    // via record_dimension_state (rpcOrThrow — a real failure there already
    // aborted the request). A failure writing the transcript costs future
    // conversational context, never the ledger, but must still be logged.
    const { error: transcriptErr } = await admin.from('discovery_sessions').update({ transcript: newTranscript }).eq('id', sessionId);
    if (transcriptErr) console.error(`[discovery-interview] transcript write failed (best-effort, continuing): ${transcriptErr.message}`);

    // Proposal emission (Task 1: .superpowers/sdd/2026-08-13-discovery-
    // proposals-and-creation) — natural completion. Reached only the FIRST
    // turn the spine closes: any LATER 'answer' call on this session hits
    // the owedDims.length === 0 early-return above and never reaches here,
    // so this fires exactly once per session on this path (emitProposals'
    // own existing-rows check is the second, independent guard — see its
    // header — in case this session is later also ended via the 'end'
    // action, or this turn is retried after a partial failure).
    const proposals = done
      ? await emitProposals(admin, tenantId, sessionId, dimensions, newCoverage)
      : null;

    return json({
      question: questionText,
      coverage: newCoverage,
      done,
      ...(proposals ? { proposals } : {}),
      usage: { input_tokens: totalIn, output_tokens: totalOut },
    });
  } catch (err) {
    console.error('discovery-interview error:', String(err));
    await reportEdgeError('discovery-interview', err, {}, tenantId);
    return fail('internal_error', String(err), 500);
  }
});
