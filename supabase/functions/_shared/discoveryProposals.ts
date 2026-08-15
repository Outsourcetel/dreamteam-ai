// discoveryProposals.ts — turning heard evidence into cards a person can
// actually decide on (.superpowers/sdd/2026-08-13-discovery-proposals-and-
// creation, Task 1: "proposals a person could actually decide on").
//
// discoveryCoverage.ts answers "what did the interview hear, per dimension".
// This module answers the next question: "what does that turn into, and
// what has to be on the card before a human can say yes, no, or not yet".
//
// THE HARD RULE, first because it is the one this whole programme exists to
// protect. Only a dimension actually marked 'heard' may produce a proposal.
// 'parked', 'skipped' and 'not_heard' all mean either there is no evidence to
// build from, or the customer explicitly said "not now" / "not relevant" —
// inventing a proposal from either is exactly the failure
// discovery_dimensions.guidance's "silence is not coverage" language
// (migrations 734/735) was written against, one layer further downstream.
// See proposalsFrom's very first check, below.
//
// THE SPLIT — flagged in this plan's progress.md PRE-FLIGHT note before this
// task started, with the resolution given, not re-opened here:
//
//   PURE (proposalsFrom derives a COMPLETE, self-validating payload, no
//   model call, no I/O):
//     connector         — from matchProvider() over the dimension's evidence
//                          text against the live connector_providers catalog
//     conversation_type — ⚠ NOT EMITTED. Removed 2026-08-15; returns with a
//                          real payload (match_pattern + set_category) and a
//                          real writer (support_triage_rules) in the
//                          follow-up task. See DIMENSION_STRUCTURAL_KINDS.
//
//   NOT PURE — proposalsFrom emits the SHAPE only, with needs_model_fill:
//   true and a payload that is DELIBERATELY incomplete. A model fills the
//   missing literal elsewhere (discovery-interview/index.ts, at interview
//   end), and the exact same validatePayload below is the only gate either
//   path's output ever passes through before it reaches discovery_proposals:
//     employee   — needs a fit_reason (see "EMPLOYEE IS MODEL-FILLED" below)
//     guardrail  — needs a pattern or a threshold (§11b, verbatim: "you
//                  cannot consent to a block you cannot predict")
//     procedure  — needs a trigger and at least one step
//     trust_rule — needs a cap — §11b: "the only kind where no card is short
//                  enough — it is the one proposal that removes a human"
//
// ── EMPLOYEE IS MODEL-FILLED — 2026-08-15, and why ────────────────────────
// Until this date `employee` sat in the PURE column above, and the defect
// that put it here was found by the first real interview run: a proposal was
// emitted for EVERY entry in a dimension's serves_archetypes the moment that
// dimension was marked 'heard'. The evidence text was read on the line above
// (for the rationale string, and for matchProvider) and then ignored for
// archetype selection. Measured live 2026-08-15:
//     winning_business.serves_archetypes
//       = [sdr, bdr, marketing, google_ads, seo, social_media]
//     how_customers_reach_us.serves_archetypes
//       = [front_desk, support_agent, it_helpdesk]
// A 40-person commercial cleaning firm who said "most leads come from
// existing clients recommending us" and "nothing's in a CRM, it's Dan's
// spreadsheet" was offered 15 employees out of 22 proposals, including SEO,
// Google Ads, social media, an SDR, a BDR and an IT helpdesk. That is
// founder-feedback item #1 (a new tenant getting 4 default DEs and 2
// wrong-industry playbooks) reincarnated one layer up — and worse, because
// it wears the interview's authority: the customer believes these were
// derived from what they said.
//
// THE FIX KEEPS THE DERIVATION AND ONLY NARROWS IT. The candidate set is
// still exactly `serves_archetypes` minus `planned_` minus unresolved keys,
// deduped across the call. A model may only DECLINE a candidate; it can
// never ADD one, and that is structural rather than instructed:
// FILL_WHITELIST['employee'] is `['fit_reason', 'evidence_quote']` and
// nothing else, so name, job, department, archetype_key, systems and
// system_access are unreachable from a model response. Declining is
// expressed by omitting fit_reason, which makes validatePayload throw, which
// emitProposals already catches, counts and logs as `refused` — the SAME
// path a guardrail with no pattern takes. There is deliberately no second
// drop path, no filter step and no keep/drop flag.
//
// ⚠ NO PER-DIMENSION OR PER-INDUSTRY TABLE WAS ADDED, and none may be. The
// grounding check below is mechanical and generic (see
// employeeGroundingProblem). It knows nothing about cleaning firms,
// marketing, or which roles suit which trade.
//
// ── WHAT THE GROUNDING CHECK ACTUALLY PROVES — read this before trusting it
// (FIX WAVE, 2026-08-15, adversarial review "employee-relevance-verdict")
//
// The first version of this check compared CONTENT WORDS between the model's
// fit_reason and the customer's evidence. Measured, it was wrong in both
// directions at once:
//   TOO LOOSE — a fit_reason that merely quotes the evidence back passed for
//     EVERY candidate simultaneously, including an SEO Specialist for a
//     commercial cleaning firm. That is the original defect, surviving the
//     gate written to stop it.
//   TOO STRICT — legitimate paraphrase, which the fill prompt explicitly
//     asks for, was refused on vocabulary mismatch. Three measured cases,
//     including the Front Desk hire for a firm whose jobs "come in over the
//     phone".
// It has been replaced by an EXACT check on a SEPARATE field, and the honest
// statement of what that buys is:
//
//   `evidence_quote` must be a VERBATIM span of one of the NOTES RECORDED
//   under the topics that nominated this role (whitespace/case/typographic
//   folding, and stripping the model's own wrapping quotes and terminating
//   punctuation — nothing fuzzier).
//
//   ⚠⚠ SAY WHAT THAT IS, NOT WHAT IT SOUNDS LIKE. Those notes are NOT a
//   transcript. `coverage[dim].evidence` is written by the INTERVIEW model,
//   whose extraction prompt asks for "the concrete fact, YOUR OWN WORDS,
//   under 300 characters". So the haystack is already a paraphrase, and this
//   check proves exactly one thing: THE FILL MODEL DID NOT INVENT WORDS THE
//   INTERVIEW MODEL RECORDED. The customer may never have said them in that
//   form. An earlier version of this block claimed "sentences this customer
//   actually said" and the card said `You told us: "…"` — a machine's
//   paraphrase in quotation marks, attributed to a named human, on the one
//   fact the design nominates as its backstop.
//
//   IT DOES NOT PROVE THE ROLE FITS. No lexical check can: the same true
//   sentence can be quoted under a role it supports and under one it does
//   not, and nothing mechanical can tell those two apart. Nor does a
//   substring have to preserve its sentence's meaning — "run Google Ads at
//   all" is a verbatim span of "we don't run Google Ads at all". That is why
//   the card renders the WHOLE recorded note rather than the span alone.
//
//   THE FILTER IS THE MODEL'S DECLINE-BY-DEFAULT INSTRUCTION
//   (discovery-interview/index.ts's fill prompt: "THE DEFAULT FOR AN
//   EMPLOYEE ITEM IS TO DECLINE"). This module's checks are a FLOOR under
//   that instruction — they refuse boilerplate, stubs, self-description and
//   fabricated quotes — not a substitute for it.
//
//   THE BACKSTOP IS THE HUMAN. The whole recorded note — not the span — is
//   put on the card (src/lib/discoveryProposalPresentation.ts), labelled as
//   what was recorded under that topic rather than as something the customer
//   said, precisely so they read it next to the role being sold on it and can
//   say "that is not why I said that". Showing the span alone would let a
//   cropped negation past the one check that is supposed to catch it. A gate
//   that cannot judge relevance and a card that hides or edits its evidence
//   would be the theatre this repo keeps finding; the card is the half that
//   makes the refusal honest.
//
// `fit_reason` is deliberately left free to PARAPHRASE — it keeps only the
// stub floor and the not-merely-the-role's-own-description check. The word
// list the old overlap check needed (FIT_REASON_STOP_WORDS) is deleted, not
// extended: a correctness check that must be hand-maintained as English
// changes is a maintenance trap, and an exact substring test needs no
// vocabulary at all.
//
// ── EVIDENCE IS THE UNION, NEVER THE FIRST DIMENSION'S ────────────────────
// (FIX WAVE, 2026-08-15 — BLOCKER 1 of the same review.)
//
// One archetype is nominated by several dimensions. Measured live today over
// public.discovery_dimensions.serves_archetypes, non-`planned_` only:
//     renewal_manager  5  money_in, money_out, after_the_sale,
//                         repetitive_work, systems_of_record
//     accounting       4  money_in, money_out, repetitive_work,
//                         systems_of_record
//     billing_ar / fpa 3  each
//     google_ads / seo / sdr / bdr / social_media / support_agent /
//     it_helpdesk / cs_manager / onboarding / front_desk   2 each
//     marketing        1  (the ONLY single-dimension archetype of the 15)
//
// The dedupe below is first-wins and CORRECT as a dedupe — a role belongs on
// one card, not four. But until this fix the winning dimension also decided
// the single `evidence` string that both the fill prompt and the grounding
// check consumed, so every LATER dimension naming that archetype contributed
// nothing. Measured consequence: a customer who says "we do run Google Ads"
// under systems_of_record (ordinal 9) had google_ads judged against
// winning_business's (ordinal 5) "leads come from referrals" — refused BY
// CONSTRUCTION, with no model output able to rescue it. The mirror case:
// "chasing unpaid invoices eats a day a week" (repetitive_work) is the one
// sentence that justifies a Billing & AR Specialist, and billing_ar binds
// money_in's "clients pay by bank transfer" instead.
//
// So a draft now carries `evidence_sources` — one entry per HEARD dimension
// that nominated it, in ordinal order — and BOTH the prompt and the checks
// are grounded on all of them. `evidence` remains on the payload as the
// joined, human-readable union; it is display and back-compat only, and the
// verbatim check consults the SOURCES individually, so a span straddling two
// dimensions' sentences can never read as something the customer said.
//
// `source_dimension` names the dimension whose evidence the model ACTUALLY
// LEANT ON, when that is knowable: `evidence_quote` is a verbatim span, so
// if it lands inside exactly one source, applyFillToDraft re-points
// source_dimension at that source. Ambiguous (the span appears in more than
// one) or absent, it stays the first heard dimension — today's behaviour.
// The rationale keeps EVERY source either way: the Drawer's "Source" answers
// "which sentence sold this role", and "What you told us" must still show
// everything that nominated it.
//
// validatePayload is what makes that split honest rather than a loophole: a
// model-filled payload still missing its literal is refused exactly as a
// hand-built incomplete one would be. Never weaken it to let model output
// through unchecked — the refusal IS the feature.
//
// ZERO DENO-ONLY IMPORTS, same discipline as discoveryCoverage.ts and for
// the identical reason: this file must be importable both by vitest
// (tests/discovery-proposals.test.ts) and by discovery-interview/index.ts
// under Deno at deploy time. That is also why matchProvider is a SELF-
// CONTAINED reimplementation here rather than an import of
// src/lib/connectorApi.ts — that module's top-level `import { supabase }
// from '../supabase'` calls createClient(...) against
// import.meta.env.VITE_* at MODULE LOAD TIME (src/supabase.ts), which does
// not exist under Deno and would crash the deployed function the instant it
// tried to import this one. The 75-row PROVIDERS catalog itself is NOT
// duplicated — it stays exactly once, in public.connector_providers, read
// live by the caller and passed in as `providerCatalog`. Only the small,
// pure MATCHING algorithm is duplicated, and tests/discovery-proposals.test
// .ts's "matchProvider — duplicated on purpose, drift-guarded here" describe
// block is what keeps that duplication honest: it imports the real
// src/lib/connectorApi.ts matchProvider (a real vitest-only import — vitest
// runs on Vite, which resolves import.meta.env fine) and asserts identical
// output across a battery of cases. If the algorithms ever disagree, that
// test goes red; nothing here silently drifts.
//
// Never writes anything. Never reads or touches digital_employees at all
// (so is_workforce_assistant is trivially never touched) — proposalsFrom is
// pure data-in/data-out, and the only I/O this whole module performs is none.
// ============================================================

import type { DiscoveryCoverageMap } from './discoveryCoverage.ts';

export type ProposalKind =
  | 'employee' | 'procedure' | 'connector' | 'guardrail' | 'trust_rule' | 'conversation_type';

/** The exact six kinds discovery_proposals.kind's CHECK constraint accepts
 *  (migration 737). Kept here, not re-derived, so an unknown kind is refused
 *  by name rather than silently treated as "no rule for this one". */
export const PROPOSAL_KINDS: readonly ProposalKind[] =
  ['employee', 'procedure', 'connector', 'guardrail', 'trust_rule', 'conversation_type'];

const KNOWN_KINDS: ReadonlySet<string> = new Set(PROPOSAL_KINDS);

/** Anything shaped like a discovery_dimensions row — only the fields this
 *  module reads are required, the same minimal-surface pattern
 *  discoveryCoverage.ts's DiscoveryDimensionLike already uses here, so a
 *  fixture and a live DB row are equally valid without an index signature
 *  forcing every caller's row type to declare one. */
export interface DiscoveryDimensionForProposals {
  key: string;
  title: string;
  serves_archetypes: readonly string[];
  produces?: readonly string[];
}

/** One entry of role_archetypes.system_templates — the jsonb ARRAY
 *  install_role_systems iterates to create de_connected_systems rows. Every
 *  field is optional here because the live rows are not uniform: measured
 *  2026-08-15, connector-bound entries carry `binding_kind: 'connector'`
 *  while internal-table entries carry `source_table`/`read_fields`/
 *  `write_registry` and NO binding_kind at all (install_role_systems
 *  coalesces the missing value to 'internal_table', and so does this
 *  module — see systemsFromTemplates). */
export interface SystemTemplateLike {
  system_key?: string;
  label?: string;
  can_read?: boolean;
  can_write?: boolean;
  binding_kind?: string;
  [k: string]: unknown;
}

/** Anything shaped like a role_archetypes row — only what an employee card
 *  needs.
 *
 *  ⚠ `system_templates`, NOT `required_connector_categories`, is what the
 *  card's `systems` list is built from — BLOCKER 2 of task-3-contract.md §7.
 *  §11b makes "the systems it will be able to touch" a required card fact on
 *  the explicit grounds that "tool reach belongs on the card, not behind a
 *  link", and the card was reading a column the writer never touches.
 *  install_role_systems (live pg_proc, read 2026-08-15) iterates
 *  `a.system_templates` and inserts de_connected_systems rows from
 *  `system_key`/`label`/`binding_kind`/`can_read`/`can_write`; it does not
 *  read required_connector_categories at all. Measured live, the two
 *  disagree on most archetypes:
 *      front_desk  card said 'knowledge_base'  writer binds 'crm'
 *      sdr         card said 'crm'             writer binds 'pipeline'
 *      fpa         card said 'erp_financials'  writer binds 'receivables',
 *                                              'payables', 'payments'
 *  front_desk is not a near-miss: the card named a system the employee never
 *  gets and omitted the one it does.
 *
 *  required_connector_categories is KEPT on this interface (it is still real
 *  data, and connector-category matching may want it later) but nothing in
 *  this module reads it any more.
 *
 *  description/responsibilities are the archetype's OWN words. They are not
 *  card copy — they are what the fit-reason grounding check measures a model
 *  fill AGAINST (see fitReasonProblem check (b): a role describing itself is
 *  true of every business and therefore evidence of nothing). */
export interface ArchetypeLike {
  key: string;
  name: string;
  domain: string;
  description?: string | null;
  responsibilities?: readonly string[] | null;
  required_connector_categories?: readonly string[];
  system_templates?: readonly SystemTemplateLike[] | null;
}

/** The EXACT columns a caller must read from public.role_archetypes for this
 *  module to produce a valid employee card. Exported, and built into the
 *  deployed SELECT (discovery-interview/index.ts's emitProposals) rather than
 *  re-typed there — IMPORTANT 1 of the 2026-08-15 review, proven by mutation
 *  and not inferred: reverting that SELECT to the pre-BLOCKER-2 column list
 *  AND disabling a check at the same time left the whole suite GREEN, while
 *  in production every single employee would have been refused for "does not
 *  say what systems it can touch" and the log would have read exactly like a
 *  correctly-narrowing interview. No test imports index.ts (Node's ESM loader
 *  rejects its https: imports) and tsconfig's `include` is `["src"]`, so
 *  supabase/functions is not typechecked either — a literal column list there
 *  is pinned by nothing at all.
 *
 *  Why each column is load-bearing, so a future reader can tell a real
 *  requirement from cargo:
 *    key / name / domain          — the card's identity, job and department.
 *    system_templates             — the ONLY source of `systems`; what
 *                                   install_role_systems actually binds.
 *                                   Missing it ⇒ every employee refused.
 *    description / responsibilities — the archetype's own words, which the
 *                                   not-merely-self check measures a model
 *                                   fill against, and which the fill prompt
 *                                   shows the model. Missing them ⇒ the check
 *                                   narrows to name/job/department and the
 *                                   model is asked about a role it cannot
 *                                   read.
 *    required_connector_categories — NOT read by this module any more (see
 *                                   ArchetypeLike's own note). Kept in the
 *                                   SELECT because the live-spine test's
 *                                   vacuity guard asserts it still DISAGREES
 *                                   with system_templates; drop it and that
 *                                   guard silently stops proving anything.
 *
 *  ⚠ tests/discovery-proposals.test.ts asserts this constant AND builds its
 *  live probe query from it. Mutating the list turns that test red; it must
 *  never be re-typed as a second literal next to a copy of the query. */
export const ROLE_ARCHETYPE_COLUMNS: readonly string[] = [
  'key',
  'name',
  'domain',
  'description',
  'responsibilities',
  'required_connector_categories',
  'system_templates',
];

/** The same list as a PostgREST/SQL select list. One join, one source. */
export const ROLE_ARCHETYPE_SELECT: string = ROLE_ARCHETYPE_COLUMNS.join(', ');

/** Mirrors src/lib/connectorApi.ts's ProviderCatalogRow exactly (same field
 *  names) so a caller can pass rows straight off `select provider_key,
 *  label, category, aliases from connector_providers` without reshaping. */
export interface ProviderCatalogRow {
  provider_key: string;
  label: string;
  category: string;
  aliases: readonly string[];
}

export interface ProviderMatch {
  provider_key: string;
  matched_on: string;
  confidence: 'exact' | 'alias' | 'partial';
}

/** One HEARD dimension's contribution to an archetype's evidence. Travels on
 *  the employee payload as `evidence_sources`, one entry per dimension that
 *  nominated the role — see the module header's "EVIDENCE IS THE UNION".
 *  Never model-writable (FILL_WHITELIST does not name it). */
export interface EvidenceSource {
  /** discovery_dimensions.key — what source_dimension may be re-pointed at. */
  dimension: string;
  /** discovery_dimensions.title — card/rationale copy, never compared on. */
  title: string;
  /** The dimension's own recorded evidence text. May be '' for a dimension
   *  marked heard before coverageAfter's grounds check existed; an empty
   *  source is kept (so the draft is still emitted and still visibly refused)
   *  but is never offered as something a quote can match. */
  evidence: string;
}

export interface ProposalDraft {
  kind: ProposalKind;
  /** For a pure kind (connector): complete and guaranteed to pass
   *  validatePayload(kind, payload) as emitted — proven by
   *  tests/discovery-proposals.test.ts's own "derives a complete,
   *  self-validating ... draft" case, not merely asserted here.
   *  For a model-filled kind (employee/guardrail/procedure/trust_rule):
   *  deliberately incomplete, and WILL be refused by validatePayload until a
   *  model fills in the missing literal. Never write an incomplete payload
   *  straight to discovery_proposals. */
  payload: Record<string, unknown>;
  rationale: string;
  source_dimension: string;
  /** true for employee/guardrail/procedure/trust_rule — see the module
   *  header's "THE SPLIT". Never true for a pure kind. */
  needs_model_fill: boolean;
}

// ── matchProvider — duplicated from src/lib/connectorApi.ts, see the module
// header for exactly why, and tests/discovery-proposals.test.ts for the
// drift guard that keeps the duplication honest. Kept byte-for-byte
// equivalent in BEHAVIOUR (not necessarily formatting) to the original. ──

/** Space-padded, punctuation-flattened, so `includes()` is a word-boundary
 *  test. Case is deliberately NOT touched here — the two passes in
 *  matchProvider below want different answers about it. */
function padForWordMatch(s: string): string {
  return ` ${s.replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** Resolve free text ("we run everything through xero") to known providers.
 *
 *  Deliberately conservative: it matches on WORD BOUNDARIES only, and
 *  returns an empty array rather than a best guess — proposalsFrom acts on
 *  what this returns (a connector proposal, and later, once accepted, an
 *  employee's access grant), so a false positive is worse than a miss. A
 *  miss just means the interview asks one more question.
 *
 *  Two passes, and the second is why an ordinary-word product name still
 *  resolves:
 *   1. ALIASES, case-insensitively. connector_providers.aliases is already
 *      filtered against AMBIGUOUS_ALIASES at seed time (migration 729), so
 *      nothing reaching this function's `catalog` argument is a bare
 *      English word.
 *   2. The EXACT LABEL, case-SENSITIVELY. "we use Close" is a proper noun
 *      and resolves; "we close deals" is a verb and does not. Sentence-
 *      initial capitals are lowered first, because a capital at the start
 *      of a sentence is grammar, not a product name.
 */
export function matchProvider(text: string, catalog: readonly ProviderCatalogRow[]): ProviderMatch[] {
  const cased = padForWordMatch(
    text.replace(/(^|[.!?\n]\s*)([A-Z])/g, (_m, pre: string, c: string) => pre + c.toLowerCase()),
  );
  const lower = cased.toLowerCase();
  const hits = new Map<string, ProviderMatch>();

  const record = (row: ProviderCatalogRow, matchedOn: string, confidence: ProviderMatch['confidence']) => {
    const existing = hits.get(row.provider_key);
    if (!existing || (existing.confidence !== 'exact' && confidence === 'exact')) {
      hits.set(row.provider_key, { provider_key: row.provider_key, matched_on: matchedOn, confidence });
    }
  };

  for (const row of catalog) {
    for (const alias of row.aliases) {
      const needle = padForWordMatch(alias).toLowerCase();
      if (needle.trim() === '') continue;
      if (!lower.includes(needle)) continue;
      record(row, alias,
        alias.toLowerCase() === row.label.toLowerCase() ? 'exact'
          : alias === row.provider_key ? 'exact' : 'alias');
    }
    const label = padForWordMatch(row.label);
    if (label.trim() !== '' && cased.includes(label)) record(row, row.label, 'exact');
  }
  return [...hits.values()];
}

// ── validatePayload — the single gate for both the pure and the model-filled
// path. Every branch states, in its own thrown message, the words the
// contract test regexes look for, so a failing check here fails LOUD and
// specific rather than "invalid payload". ──

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** REVIEW ROUND 1, minor 2: the prior version counted a bare NUMBER as valid
 *  array content, so `systems: [42]` (a bare number, not a real system name)
 *  passed validatePayload's employee check. And it filtered by `str(x)`,
 *  which silently reads an OBJECT entry as nothing at all — `steps: [{...}]`
 *  counted as zero steps with no explanation. Every array this module checks
 *  (reads/writes/steps/systems) is a list of short, human-readable NAMES —
 *  none of the four kinds ever legitimately holds a bare number or a nested
 *  object — so this now accepts genuine non-empty strings only. An
 *  object-shaped "step" is correctly treated the same as an absent one: it
 *  is not something a person can read on a card, so refusing it (rather than
 *  silently dropping it and moving on) is the right outcome, not a
 *  regression. */
function nonEmptyStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

/** A "cap"/"threshold" style value MUST be a real number (REVIEW ROUND 1,
 *  minor 1: `threshold: 'as appropriate'` and `cap: 'whatever seems
 *  reasonable'` both passed the old string-truthiness check — a sentence is
 *  not a number). A model-typed numeric STRING ("10000", "$10,000") is
 *  tolerated — that is still a literal a human can read and predict against,
 *  merely formatted as text — but genuine prose is not. 0 is deliberately a
 *  valid cap, so this is never a truthiness check. */
function isNumericLiteral(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const t = v.trim().replace(/^\$/, '').replace(/,/g, '').replace(/%$/, '');
    if (!t) return false;
    return /^-?\d+(\.\d+)?$/.test(t);
  }
  return false;
}

/** Words a genuine ENFORCEABLE pattern ("refund|chargeback", "free month")
 *  does not contain — a rule described in prose ("anything the customer
 *  might find upsetting") does. Belt-and-braces alongside the length/word-
 *  count check below, not the sole defence — a short sentence with none of
 *  these words would still be caught by word count or trailing punctuation. */
const PATTERN_PROSE_WORDS = /\b(the|and|might|could|should|would|whatever|anything|something|appropriate|reasonable|seems|find|please|kindly|customer|customers)\b/i;

/** REVIEW ROUND 1, minor 1, verbatim: "a pattern that is a sentence is not a
 *  pattern." The prompt (discovery-interview/index.ts) asks for "a short
 *  '|'-separated list of literal words/phrases" — this is that bar, checked
 *  on the OUTPUT side too rather than trusted from the instruction alone:
 *  short (<=5 whitespace-delimited tokens; "refund|chargeback|free month" is
 *  2), no trailing sentence punctuation, none of the prose words above. */
function looksLikeEnforceablePattern(v: string): boolean {
  const t = v.trim();
  if (!t || t.length > 120) return false;
  if (/[.!?]$/.test(t)) return false;
  if (t.split(/\s+/).filter(Boolean).length > 5) return false;
  if (PATTERN_PROSE_WORDS.test(t)) return false;
  return true;
}

// ── employeeGroundingProblem — the employee analogue of
// looksLikeEnforceablePattern
//
// ⚠ READ THE MODULE HEADER'S "WHAT THE GROUNDING CHECK ACTUALLY PROVES"
// BEFORE CHANGING ANYTHING BELOW. In one line, because it is the line people
// get wrong: the exact quote proves the model did not INVENT the customer's
// words. It does NOT prove the role FITS, and no lexical check can. The
// filter is the fill prompt's decline-by-default instruction; this is the
// floor under it, and the customer reading their own sentence on the card is
// the backstop.

/** Substantive words of a piece of text: lowercased, punctuation-flattened,
 *  length >= 4, and a single trailing plural "s" stripped so
 *  "clients"/"client" count as the same word. "ss" endings are left alone
 *  ("business" must not become "busines"). No real stemming —
 *  "recommending" and "recommendations" do NOT unify, and that is a known
 *  miss, not an oversight.
 *
 *  ⚠ THERE IS NO STOP-WORD LIST ANY MORE, deliberately. FIT_REASON_STOP_WORDS
 *  existed to make the old fit_reason/evidence OVERLAP check mean something,
 *  and that check is gone (module header). The review's I3 measured the list
 *  asymmetric on the defect's own vocabulary — it dropped "customer(s)" but
 *  not "client(s)"/"lead(s)"/"job(s)"/"firm(s)" — and the fix is not to add
 *  five more words: a correctness check that has to be hand-maintained as
 *  English changes will drift again the next time nobody is looking.
 *  ⚠ THE HONEST COST, stated rather than buried: this makes check (b) below
 *  strictly MORE PERMISSIVE than it was. A fit_reason that restates the role
 *  and adds one common filler word ("works", "helps", "today") now clears
 *  (b) where the list used to catch it. (b) was never the load-bearing check
 *  and is not now; the verbatim quote is. */
function contentWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (raw.length < 4) continue;
    out.add(raw.endsWith('s') && !raw.endsWith('ss') && raw.length - 1 >= 4 ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Fold ONLY what a faithful transcription may legitimately differ on:
 *  case, whitespace runs, and the Unicode typographic confusables for the
 *  ASCII quote/apostrophe/hyphen. Nothing semantic — no stemming, no
 *  punctuation stripping, no synonym anything. The three confusable classes
 *  are a CLOSED set fixed by Unicode, not a vocabulary that grows, and
 *  without them a model that renders "nothing's" with U+2019 while the
 *  transcript holds U+0027 would have a perfectly honest quote refused. */
function normalizeForQuote(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** THE MODEL'S OWN DELIMITERS ARE NOT PART OF THE QUOTE, and stripping them is
 *  not the same thing as matching fuzzily.
 *
 *  Measured, every one of these REFUSED before this function existed, against
 *  evidence that genuinely contained the span:
 *
 *      "we do run Google Ads"     (straight quotes kept)   REFUSED
 *      “we do run Google Ads”     (curly quotes kept)      REFUSED
 *      we do run Google Ads.      (terminating full stop)  REFUSED
 *      we do run Google Ads,      (trailing comma)         REFUSED
 *
 *  Wrapping a span in quotation marks and ending it with a full stop are the
 *  two most natural things a model does when it is asked for a quotation — and
 *  more so here, because the card then renders the value inside quotation marks
 *  of its own. Every refusal above is a role the customer's own words supported,
 *  dropped silently and logged nowhere a person looks. That is the
 *  under-proposal failure, which is strictly harder to notice than the
 *  over-proposal one this whole change exists to fix.
 *
 *  ⚠ WHY THIS IS STILL EXACT. It removes characters the MODEL added around the
 *  span; it never edits the span, never edits the haystack, and never matches
 *  approximately. One symmetric pair of wrapping quotes, then trailing
 *  sentence punctuation — nothing else. An ellipsis in the middle is still
 *  REFUSED, because a span stitched across a gap is a different sentence from
 *  the one the customer said; the fill prompt says so explicitly rather than
 *  leaving the model to discover it through a silent drop. */
function stripQuoteDelimiters(s: string): string {
  let out = s.trim();
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['«', '»'], ['„', '“'],
  ];
  for (const [open, close] of pairs) {
    if (out.length > open.length + close.length && out.startsWith(open) && out.endsWith(close)) {
      out = out.slice(open.length, out.length - close.length).trim();
      break; // ONE pair only — nested quotes may be the customer's own.
    }
  }
  return out.replace(/[.,;:!?]+$/, '').trim();
}

/** THE FLOOR ON A QUOTE, and how it was chosen. A quote has to be big enough
 *  to carry a fact, or "the" would clear a verbatim test against almost any
 *  sentence and prove nothing at all.
 *
 *  12 characters AND 3 words, measured on the normalised span. Both, because
 *  either alone is trivially gamed ("nevertheless" is 12 characters of
 *  nothing; "in a the" is 3 words of nothing).
 *
 *  Calibrated against the shortest REAL facts in the measured corpus rather
 *  than picked round: "it's Dan's spreadsheet" (3 words / 22 chars), "we do
 *  run Google Ads" (5 / 20), "Everything is on paper" (4 / 22), "clients pay
 *  by bank transfer" (5 / 28). The floor sits just under the smallest of
 *  those so a terse-but-real quote still passes, while "in a CRM" (3 words /
 *  8 chars) and "spreadsheet" (1 word) do not.
 *
 *  ⚠ It is a FLOOR, not a proof: a 3-word span can still be a meaningless
 *  fragment of a real sentence ("come from existing"). What it guarantees is
 *  only that the model did not write the words itself. */
const QUOTE_MIN_CHARS = 12;
const QUOTE_MIN_WORDS = 3;

/** Every evidence string this payload may be checked against, as SEPARATE
 *  strings — one per heard dimension that nominated the role. Checking them
 *  individually rather than joined is what stops a "quote" that straddles two
 *  dimensions' sentences from reading as something the customer ever said.
 *
 *  Falls back to the single `evidence` string when `evidence_sources` is
 *  absent, so a hand-built payload (a unit test, a future caller) is still
 *  checkable — the same narrow-never-skip contract the options on
 *  ValidatePayloadOptions follow. Empty strings are dropped: an empty
 *  evidence text is not something a quote can be verbatim FROM. */
function evidenceStrings(payload: Record<string, unknown>): string[] {
  const sources = Array.isArray(payload.evidence_sources) ? payload.evidence_sources : [];
  const out: string[] = [];
  for (const raw of sources) {
    if (!raw || typeof raw !== 'object') continue;
    const e = str((raw as Record<string, unknown>).evidence);
    if (e) out.push(e);
  }
  if (out.length > 0) return out;
  const single = str(payload.evidence);
  return single ? [single] : [];
}

/** Returns a human-readable reason this employee payload is not grounded, or
 *  null when it passes every check. Split out from validatePayload so the
 *  checks can be read (and tested) one at a time.
 *
 *  (a) A REAL SENTENCE, NOT A STUB — at least 30 characters and at least 5
 *      whitespace tokens. The bar is a judgment call, justified like this: a
 *      grounded reason has to carry three things at once — the customer's
 *      own fact, this role, and the link between them. The shortest sentence
 *      that does all three in the design's own worked examples ("They run
 *      Google Ads in-house today") is 34 characters and 6 words. 30/5 sits
 *      just below that so terse-but-real grounding still passes, while
 *      "Good fit.", "yes", "Fits well" and a bare role name do not. There is
 *      deliberately no UPPER bound: refusing a long answer would be a new
 *      failure mode this fix was not asked to add, and the prompt asks for
 *      one sentence.
 *
 *  (b) NOT THE ROLE DESCRIBING ITSELF — at least one substantive word of the
 *      fit_reason must NOT appear in the archetype's own vocabulary (its
 *      name, and — when the caller can supply it — its live description and
 *      responsibilities). "A Support Agent handles support tickets" is true
 *      for every business that has ever existed, so as evidence about THIS
 *      business it is worth exactly nothing.
 *      ⚠ This check NARROWS rather than switches off when archetypeSelfText
 *      is omitted (the vocabulary is then just what is on the payload:
 *      name/job/department) — the same "narrow, never skip" contract
 *      validDeRefs and validActionCategories already follow.
 *      ⚠ See contentWords: (b) is measurably weaker than it was, because the
 *      stop-word list it leant on is gone.
 *
 *  (c) THE CUSTOMER'S OWN WORDS, VERBATIM — `evidence_quote` must appear, as
 *      an exact span (whitespace/case/typographic folding only), inside ONE
 *      of the sentences the heard dimensions actually recorded. fit_reason
 *      itself is free to paraphrase; the quote is what makes the paraphrase
 *      answerable.
 *      ⚠ No evidence text at all is a REFUSAL, not a skip, and is reported
 *      BEFORE the missing-quote message so the log names the real cause. A
 *      dimension can reach 'heard' with an empty evidence string only through
 *      data written before coverageAfter's grounds check existed; with
 *      nothing to quote from, failing closed is the right direction. */
function employeeGroundingProblem(
  payload: Record<string, unknown>,
  archetypeSelfText: string,
): string | null {
  const t = str(payload.fit_reason);
  if (!t) {
    return 'carries no fit_reason — the interview evidence was not shown to support hiring this role, and a role nobody can say why they need is not something a person can consent to';
  }
  if (t.length < 30 || t.split(/\s+/).filter(Boolean).length < 5) {
    return `fit_reason "${t}" is a stub, not a reason — it has to name the thing this customer actually said`;
  }
  const selfVocabulary = `${str(payload.name)} ${str(payload.job)} ${str(payload.department)} ${archetypeSelfText}`;
  const fitWords = contentWords(t);
  const selfWords = contentWords(selfVocabulary);
  if ([...fitWords].every((w) => selfWords.has(w))) {
    return `fit_reason "${t}" only restates the role's own name and description — that is true of every business, so it is evidence about none`;
  }
  const evidences = evidenceStrings(payload);
  if (evidences.length === 0) {
    return `fit_reason "${t}" cannot be grounded — the dimension(s) that nominated this role recorded no evidence text to check it against`;
  }
  const quote = str(payload.evidence_quote);
  if (!quote) {
    return 'carries no evidence_quote — a role is only offered on the strength of a span of the note recorded under the topic that nominated it, and without one there is nothing for the customer to read back and disagree with';
  }
  // ⚠ THE MODEL'S OWN DELIMITERS COME OFF THE NEEDLE FIRST — see
  // stripQuoteDelimiters. Wrapping quotes and a terminating full stop were
  // each measured refusing a span the recorded note genuinely contained.
  const needle = normalizeForQuote(stripQuoteDelimiters(quote));
  if (!evidences.some((e) => normalizeForQuote(e).includes(needle))) {
    // ⚠ WORDING MATTERS HERE AND IT USED TO BE WRONG. This said "not a verbatim
    // part of anything the customer said". It is not checked against anything
    // the customer said: `coverage[dim].evidence` is written by the INTERVIEW
    // model, which the extraction prompt instructs to record "the concrete
    // fact, YOUR OWN WORDS, under 300 characters". So the haystack is a
    // paraphrase, and all this proves is that the FILL model did not invent
    // words the INTERVIEW model recorded. That is worth having and it is not
    // what the old sentence claimed.
    return `evidence_quote "${quote}" is not a verbatim span of the note recorded under the topic(s) that nominated this role — the fill model wrote those words itself, and a role sold on invented evidence is exactly what this gate exists to refuse`;
  }
  if (needle.length < QUOTE_MIN_CHARS || needle.split(' ').filter(Boolean).length < QUOTE_MIN_WORDS) {
    return `evidence_quote "${quote}" is too small a fragment to mean anything — it has to be at least ${QUOTE_MIN_WORDS} words and ${QUOTE_MIN_CHARS} characters of the recorded note`;
  }
  return null;
}

/** Third argument to validatePayload. Every entry is a LIVE, EXTERNAL
 *  vocabulary this module has no business hardcoding — see the module header
 *  addendum below ("REVIEW ROUND 1, Importants 1 and 2") for why. Omitted
 *  entirely (the default), the corresponding check narrows to what CAN be
 *  verified with no external data — never widens to "skip the check" for
 *  de_ref (see the trust_rule case), because "unassigned" is refusable on
 *  shape alone. */
export interface ValidatePayloadOptions {
  /** The real, live set of public.trust_policies.action_category values —
   *  e.g. "action:erp_financials", "action_execute", "answer_dock",
   *  "writeback:crm" — READ from the database, never hand-maintained here.
   *  Omitted: action_category is checked for presence only (a category was
   *  named), not namespace membership, because there is nothing to check it
   *  against — see discovery-interview/index.ts's emitProposals, which
   *  always fetches and passes the real set in the deployed path. */
  validActionCategories?: Iterable<string>;
  /** The exact "archetype:<key>" references this SESSION's own employee
   *  proposals actually produced. Omitted: de_ref is still refused if it is
   *  the literal "unassigned" or does not match the archetype:<key> SHAPE at
   *  all — narrower than true membership, but closes the exact defect this
   *  option exists for even when a caller (e.g. a standalone unit test)
   *  cannot supply the real set. */
  validDeRefs?: Iterable<string>;
  /** EMPLOYEE ONLY — the archetype's own words, read live from
   *  public.role_archetypes (name + description + responsibilities), used by
   *  employeeGroundingProblem check (b). Omitted: check (b) narrows to the
   *  vocabulary already on the payload (name/job/department) rather than
   *  switching off, same contract as the two options above. */
  archetypeSelfText?: string;
}

/**
 * vocabularyOrUndefined — THE "NARROW, NEVER REFUSE EVERYTHING" DEGRADATION,
 * in one place so both live vocabularies degrade identically.
 *
 * IMPORTANT 5 of the 2026-08-15 review, measured: emitProposals built
 * `validDeRefs` as a bare `new Set(...)`, and an empty Set is TRUTHY — so a
 * session in which zero employees survived validation refused EVERY
 * trust_rule as "does not match any employee actually proposed this
 * session", including a cap the customer had volunteered out loud. The
 * action_category path next to it already degraded correctly, with a comment
 * explaining that refusing everything is worse than not checking; the de_ref
 * path did the opposite, undocumented and untested.
 *
 * Returns `undefined` — the "we could not determine the real vocabulary"
 * signal validatePayload's options already understand — rather than an empty
 * Set. validatePayload then falls back to its SHAPE checks, which are
 * narrower than real membership but still refuse "unassigned", free text and
 * anything not shaped like a reference at all. Narrowing is honest; refusing
 * everything because we know nothing is not.
 *
 * ⚠ This is deliberately NOT `options.validDeRefs ?? undefined` at the call
 * site: `?? undefined` does nothing to an empty Set. The bug is that empty
 * and absent look identical to a truthiness test and mean opposite things.
 */
export function vocabularyOrUndefined(values: Iterable<string>): Set<string> | undefined {
  const set = new Set<string>();
  for (const v of values) {
    const t = str(v);
    if (t) set.add(t);
  }
  return set.size > 0 ? set : undefined;
}

/**
 * validatePayload — throws with a specific, greppable reason on any payload
 * that does not carry what §11b says a person needs to decide on for that
 * kind. Never returns a value; a payload that passes simply does not throw.
 *
 * THIS IS THE GATE FOR BOTH PATHS. Called on a pure ProposalDraft's payload
 * as emitted by proposalsFrom (must never throw — proven in the test suite)
 * and, separately, on a model-filled guardrail/procedure/trust_rule payload
 * before either is ever inserted into discovery_proposals
 * (discovery-interview/index.ts). Do not special-case a model-filled payload
 * to skip a check a hand-built one would face — an incomplete card is
 * incomplete regardless of who almost finished it.
 *
 * REVIEW ROUND 1, Important 1 — a trust_rule used to reach 'pending' naming
 * no real employee: `{de_ref: 'unassigned', action_category: 'refunds', cap:
 * 500}` passed, and fillProposalLiterals' own prompt told the model to write
 * exactly that literal when no employee fit. §11b calls trust_rule "the one
 * proposal that removes a human" — one naming nobody is not something a
 * person can approve. Fixed two ways, both required: the prompt no longer
 * offers "unassigned" as an answer (it says to OMIT de_ref instead, same as
 * every other "cannot support a real answer" case already in that prompt),
 * and validatePayload now independently refuses de_ref unless it is a real
 * reference — see the trust_rule case below.
 *
 * REVIEW ROUND 1, Important 2 — action_category was free text, but
 * set_trust_ladder enforces confidence-gating keyed EXACTLY off that column
 * (`v_uses_conf := action_category in ('answer_dock','answer_widget')`), and
 * the live namespace is a small, specific set
 * ('action:erp_financials','action_execute','answer_dock','writeback:crm',
 * ...) — never free text. An invented category like 'refunds' would have
 * produced a trust rule a customer approves, that gets written, and that
 * enforces NOTHING — the exact "looks governed and is not" artefact this
 * whole programme exists to catch. Fixed via `options.validActionCategories`
 * below: the caller (discovery-interview/index.ts) reads the real, live,
 * DISTINCT values from public.trust_policies and passes them in — never
 * hardcoded here, for the same reason connector_providers isn't hardcoded
 * either (a second copy of a list that already exists in the database is a
 * drift waiting to happen, per this repo's own TOP_PROVIDERS lesson).
 */
export function validatePayload(
  kind: ProposalKind,
  payload: Record<string, unknown>,
  options: ValidatePayloadOptions = {},
): void {
  if (!KNOWN_KINDS.has(kind)) {
    throw new Error(`validatePayload: unknown proposal kind "${String(kind)}" — must be one of ${PROPOSAL_KINDS.join(', ')}`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error(`validatePayload: ${kind} proposal has no payload to decide on`);
  }

  switch (kind) {
    case 'conversation_type': {
      // §11b: "label + owner — one line. A label acts on nothing." Demanding
      // more here is the theatre the design doc explicitly warns against.
      if (!str(payload.label)) {
        throw new Error('validatePayload: conversation_type proposal has no label');
      }
      if (!str(payload.owner_ref)) {
        throw new Error('validatePayload: conversation_type proposal names no owner — a topic nobody owns is not something a person can decide to route');
      }
      return;
    }

    case 'connector': {
      // §11b: "provider + what it reads/writes + 'you still enter the
      // credential'". The credential step is the SECOND gate, not the only
      // one — what it can touch has to be on THIS card.
      if (!str(payload.provider_key)) {
        throw new Error('validatePayload: connector proposal names no provider');
      }
      const reads = nonEmptyStringArray(payload.reads);
      const writes = nonEmptyStringArray(payload.writes);
      if (reads.length === 0 && writes.length === 0) {
        throw new Error(
          `validatePayload: connector proposal for "${str(payload.provider_key)}" names nothing it reads or writes — the credential step is the second gate, but what it can touch has to be on the card first`,
        );
      }
      return;
    }

    case 'procedure': {
      // §11b: "name + trigger + 'draft; runs only when you publish'".
      const name = str(payload.name);
      if (!name) {
        throw new Error('validatePayload: procedure proposal has no name');
      }
      if (!str(payload.trigger)) {
        throw new Error(`validatePayload: procedure "${name}" has no trigger — when it runs is not decidable without one`);
      }
      if (nonEmptyStringArray(payload.steps).length === 0) {
        throw new Error(`validatePayload: procedure "${name}" has no steps — an empty draft is nothing a person can review, approve or decline`);
      }
      return;
    }

    case 'employee': {
      // §11b: "the systems it will be able to touch ... tool reach belongs
      // on the card, not behind a link."
      const name = str(payload.name);
      if (!name) {
        throw new Error('validatePayload: employee proposal has no name');
      }
      // Still a genuine check after BLOCKER 2's fix, and arguably a stronger
      // one: `systems` is now derived from system_templates (what
      // install_role_systems actually binds), so an archetype whose
      // system_templates is null or empty produces an employee draft that is
      // REFUSED here rather than one carrying a category the writer never
      // touches. Measured live 2026-08-15, all 15 active archetypes carry at
      // least one template, so this refuses nothing today — it is the
      // direction to fail in if one ever regresses.
      if (nonEmptyStringArray(payload.systems).length === 0) {
        throw new Error(
          `validatePayload: employee "${name}" does not say what systems it can touch — tool reach belongs on the card, not behind a link, and no access at all is not a fact anyone can consent to`,
        );
      }
      // THE DROP MECHANISM for an over-proposed role — see the module
      // header's "EMPLOYEE IS MODEL-FILLED". This is not a second path: it
      // is the same refusal a guardrail with no pattern gets, and
      // emitProposals already catches, counts and logs it.
      const problem = employeeGroundingProblem(payload, options.archetypeSelfText ?? '');
      if (problem) {
        throw new Error(`validatePayload: employee "${name}" ${problem}`);
      }
      return;
    }

    case 'guardrail': {
      // §11b, verbatim: "the rule sentence and its literal pattern or
      // threshold, verbatim ... you cannot consent to a block you cannot
      // predict." REVIEW ROUND 1, minor 1: a pattern that reads as a
      // sentence ("anything the customer might find upsetting") is not an
      // enforceable literal any more than a missing one is — checked by
      // looksLikeEnforceablePattern, not just presence. threshold must be a
      // real number (isNumericLiteral), not prose ("as appropriate").
      const rule = str(payload.rule);
      if (!rule) {
        throw new Error('validatePayload: guardrail proposal has no rule sentence');
      }
      const patternRaw = str(payload.pattern);
      const pattern = patternRaw && looksLikeEnforceablePattern(patternRaw) ? patternRaw : '';
      const hasThreshold = isNumericLiteral(payload.threshold);
      if (!pattern && !hasThreshold) {
        throw new Error(
          `validatePayload: guardrail "${rule}" carries no literal pattern or threshold — you cannot consent to a block you cannot predict`,
        );
      }
      return;
    }

    case 'trust_rule': {
      // §11b: "employee + action category + the dollar/confidence cap + what
      // happens above it ... the only kind where no card is short enough —
      // it is the one proposal that removes a human."
      const deRef = str(payload.de_ref);
      if (!deRef) {
        throw new Error('validatePayload: trust_rule proposal names no employee (de_ref)');
      }
      const actionCategory = str(payload.action_category);
      if (!actionCategory) {
        throw new Error('validatePayload: trust_rule proposal names no action_category');
      }
      // Cap checked BEFORE the de_ref/action_category namespace checks below
      // on purpose: a payload missing ONLY a cap must fail on exactly that,
      // not on an incidental shape issue elsewhere in the same payload —
      // pinned by tests/discovery-proposals.test.ts's Step-1 contract case
      // ({de_ref: 'x', action_category: 'crm', level: 2}), which uses a
      // deliberately informal de_ref and must still fail on the cap.
      if (!isNumericLiteral(payload.cap)) {
        throw new Error(
          `validatePayload: trust_rule for "${actionCategory}" carries no cap — an amount, confidence value or threshold — this is the one proposal that removes a human, and no cap is no decision`,
        );
      }
      // REVIEW ROUND 1, Important 1. Real membership when the caller can
      // supply it (the deployed path always can — see emitProposals);
      // otherwise refuse the literal placeholder the old prompt used to
      // request, and anything not shaped like a real reference at all.
      if (options.validDeRefs) {
        const known = options.validDeRefs instanceof Set ? options.validDeRefs : new Set(options.validDeRefs);
        if (!known.has(deRef)) {
          throw new Error(
            `validatePayload: trust_rule de_ref "${deRef}" does not match any employee actually proposed this session — an invented or unresolved reference is not something a person can approve autonomy for`,
          );
        }
      } else if (deRef.toLowerCase() === 'unassigned' || !/^archetype:[a-z0-9_]+$/i.test(deRef)) {
        throw new Error(
          `validatePayload: trust_rule de_ref "${deRef}" is not a real employee reference — "unassigned" or free text is not something a person can approve autonomy for`,
        );
      }
      // REVIEW ROUND 1, Important 2. Real namespace membership when the
      // caller can supply it — see the module header addendum above for why
      // an invented category ("refunds") is worse than a missing one: it
      // enforces nothing while looking exactly like something that does.
      if (options.validActionCategories) {
        const known = options.validActionCategories instanceof Set
          ? options.validActionCategories
          : new Set(options.validActionCategories);
        if (!known.has(actionCategory)) {
          throw new Error(
            `validatePayload: trust_rule action_category "${actionCategory}" is not a real action category in this workspace's live namespace (checked against ${known.size} value(s)) — an invented category is written but enforces nothing`,
          );
        }
      }
      return;
    }
  }
}

// ── applyModelFill — REVIEW ROUND 1, Important 3 ────────────────────────────
// The old merge (`for (const [k,v] of Object.entries(fill)) payload[k] = v`,
// in discovery-interview/index.ts) had no per-kind limit, so a model's raw
// response — derived from customer-authored text, defended by
// wrapUntrusted/FIREWALL_RULES but not something this module should trust
// blindly on top of that — could overwrite `rule` itself (breaking §11b's
// "verbatim" guarantee on the rule sentence) or inject arbitrary keys
// (`severity`, `level`, anything) into the jsonb Task 3 will build real rows
// from. Moved here, as a PURE function, specifically so it is testable
// without a model: tests/discovery-proposals.test.ts feeds it an
// adversarial `fill` object and asserts the whitelist held.

/** The kinds a model fill runs for at all. `employee` joined the three on
 *  2026-08-15 — see the module header's "EMPLOYEE IS MODEL-FILLED". */
export type FilledKind = 'employee' | 'guardrail' | 'procedure' | 'trust_rule';

const FILLED_KINDS: ReadonlySet<string> = new Set<FilledKind>(['employee', 'guardrail', 'procedure', 'trust_rule']);

/** Exactly which keys a model fill is allowed to write, per kind. Everything
 *  else in a model's response is discarded before it ever touches a draft's
 *  payload — never widened to "whatever the model sent".
 *
 *  ⚠ `employee: ['fit_reason', 'evidence_quote']` IS THE WHOLE LIST, and that
 *  is the load-bearing half of the over-proposal fix. name, job, department,
 *  archetype_key, systems, system_access, evidence and evidence_sources stay
 *  purely derived, so a model cannot rename a role, move it to another
 *  department, point it at a different archetype, widen its tool reach, or —
 *  and this one is why `evidence_sources` must never join this list — edit
 *  the customer's own sentences into something its quote would match. It may
 *  supply the sentence saying why this candidate fits and the verbatim span
 *  of the customer's words it rests on, or omit them, which is how it
 *  declines. Adding a third key here re-opens exactly what this list closes.
 *
 *  ⚠ `archetype_key` is NOT whitelisted and must never be: a fill that names
 *  a different role is REFUSED WHOLESALE by applyFillToDraft (see
 *  fillIdentityProblem), never written. Whitelisting it would silently
 *  repoint the card instead. */
export const FILL_WHITELIST: Readonly<Record<FilledKind, readonly string[]>> = {
  employee: ['fit_reason', 'evidence_quote'],
  guardrail: ['pattern', 'threshold'],
  procedure: ['name', 'trigger', 'steps'],
  trust_rule: ['de_ref', 'action_category', 'cap', 'above_cap'],
};

/**
 * applyModelFill — merge a model's raw fill response into a draft's payload,
 * keeping ONLY the FILL_WHITELIST-ed keys for that kind. Pure: returns a NEW
 * object, never mutates `payload` or `fill`. `null`/`undefined` values in
 * `fill` are treated as "the model had nothing" and are not written (the
 * same "omit rather than guess" contract the fill prompt is given). A kind
 * with no whitelist entry (connector and conversation_type never reach a
 * model at all) writes nothing at all — defensive, not reachable via the
 * real emission path today.
 */
export function applyModelFill(
  kind: ProposalKind,
  payload: Record<string, unknown>,
  fill: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = FILLED_KINDS.has(kind) ? FILL_WHITELIST[kind as FilledKind] : [];
  const next: Record<string, unknown> = { ...payload };
  for (const key of allowed) {
    const v = fill[key];
    if (v !== undefined && v !== null) next[key] = v;
  }
  return next;
}

/**
 * fillIdentityProblem — DOES THIS FILL PROVE IT WAS WRITTEN FOR THIS DRAFT?
 *
 * BLOCKER 2 of the 2026-08-15 review. fillProposalLiterals matches a model's
 * response objects to drafts by ARRAY INDEX and nothing else. The items sent
 * to the model already carry `kind`, `dimension` and (for employees)
 * `archetype_key`; the response's copies were never compared. Measured:
 * applying `{fit_reason: 'Leads from existing clients sit in a spreadsheet
 * with nobody following them up.', archetype_key: 'sdr'}` to the SEO draft
 * passed every check, and because the whitelist correctly refuses to write
 * archetype_key, `payload.archetype_key` stayed `seo` — so the card rendered
 * an SDR argument, specific and customer-grounded, under SEO Specialist. The
 * mismatch was INVISIBLE rather than harmless. Models do misindex 20-item
 * JSON arrays.
 *
 * Returns the reason to refuse the fill outright, or null to apply it.
 *
 * ── THE ABSENT-FIELD DECISION, made explicitly because silently trusting
 * the index re-opens the whole hole ──
 *
 *   EMPLOYEE: `archetype_key` is REQUIRED. A fill without it is refused
 *   (which is a DECLINE, the documented default for this kind, not an
 *   error). Justified by asymmetry, not by neatness:
 *     - the mismatch is invisible on this kind specifically, because every
 *       identifying field on the card is derived and the only model-written
 *       fields are prose;
 *     - a real interview sends 13-15 employee items in one array, which is
 *       exactly where misindexing happens;
 *     - the cost of demanding it is UNDER-proposal, which is the safe
 *       direction, is counted in `refused`, and is logged per draft;
 *     - the model is told to copy it, in the same sentence that tells it to
 *       copy `idx`, which it already does reliably enough for the index
 *       mapping to work at all.
 *
 *   GUARDRAIL / PROCEDURE / TRUST_RULE: `kind` and `dimension` are checked
 *   WHEN PRESENT and not required. Checked, because they share the index
 *   defect. Not required, because they do not share its invisibility: every
 *   field a model writes on these kinds IS the card (a guardrail's pattern
 *   sits next to the customer's own rule sentence, which is derived — a
 *   mis-landed pattern visibly contradicts it), there are at most five such
 *   drafts in a whole interview rather than fifteen, and IMPORTANT 5 of the
 *   same review is the standing warning against making a missing field cost
 *   the customer a cap they volunteered out loud.
 */
export function fillIdentityProblem(draft: ProposalDraft, fill: Record<string, unknown>): string | null {
  const kindGot = str(fill.kind);
  if (kindGot && kindGot !== draft.kind) {
    return `fill names kind "${kindGot}" but landed on a ${draft.kind} draft — the model's answers are out of step with the items it was sent`;
  }
  if (draft.kind === 'employee') {
    const want = str(draft.payload.archetype_key);
    const got = str(fill.archetype_key);
    if (!got) {
      return `fill carries no archetype_key, so nothing proves it was written for "${want}" rather than for another role in the same list`;
    }
    if (got !== want) {
      return `fill was written for archetype "${got}" but landed on "${want}" — an argument for one role must never be shown under another`;
    }
    return null;
  }
  const dimGot = str(fill.dimension);
  if (dimGot && dimGot !== draft.source_dimension) {
    return `fill names dimension "${dimGot}" but landed on the ${draft.kind} draft from "${draft.source_dimension}"`;
  }
  return null;
}

/**
 * applyFillToDraft — the ONE place a model fill meets a draft, so that the
 * deployed path (discovery-interview/index.ts's fillProposalLiterals) and
 * the test suite exercise the same code rather than two that happen to
 * agree. Mutates `draft` in place, deliberately: fillProposalLiterals holds
 * references into the caller's array, so returning a new object would drop
 * the fill on the floor.
 *
 * Returns null when the fill was applied, or the reason it was REFUSED
 * WHOLESALE (fillIdentityProblem). A refused fill leaves the draft exactly
 * as it was — incomplete — so it is then refused downstream by the same
 * validatePayload every other incomplete payload meets. There is still no
 * second drop path; the caller logs the reason and moves on.
 *
 * Three things happen, and only these three:
 *   1. payload = applyModelFill(...) — whitelist enforced, nothing else.
 *   2. EMPLOYEE ONLY: source_dimension is re-pointed at the dimension whose
 *      sentence the model ACTUALLY QUOTED, when the quote lands inside
 *      exactly one source. See the module header's "EVIDENCE IS THE UNION" —
 *      before this, a role nominated by four dimensions always reported the
 *      first, which was frequently not the one that justified it. Ambiguous
 *      (span present in more than one source) or unquoted, it stays as
 *      emitted. This runs BEFORE validation on purpose: an invented quote
 *      matches no source, so it changes nothing and the draft is refused
 *      anyway.
 *   3. EMPLOYEE ONLY: a surviving fit_reason is carried onto the RATIONALE.
 *      Before this, every employee card derived from one dimension carried a
 *      byte-identical string — `Heard evidence for "How we win business":
 *      <evidence>` — six cards, one sentence, none of them saying why THAT
 *      role. The evidence stays, ALL of it, from every dimension that
 *      nominated the role (it is the audit trail back to what the customer
 *      actually said); the fit reason leads, because that is the part that
 *      differs per card.
 */
export function applyFillToDraft(draft: ProposalDraft, fill: Record<string, unknown>): string | null {
  const identityProblem = fillIdentityProblem(draft, fill);
  if (identityProblem) return identityProblem;
  draft.payload = applyModelFill(draft.kind, draft.payload, fill);
  if (draft.kind === 'employee') {
    const quote = str(draft.payload.evidence_quote);
    if (quote) {
      const needle = normalizeForQuote(quote);
      const matches = (Array.isArray(draft.payload.evidence_sources) ? draft.payload.evidence_sources : [])
        .filter((raw): raw is EvidenceSource => !!raw && typeof raw === 'object'
          && typeof (raw as EvidenceSource).dimension === 'string'
          && typeof (raw as EvidenceSource).evidence === 'string')
        .filter((s) => s.evidence !== '' && normalizeForQuote(s.evidence).includes(needle));
      if (matches.length === 1) draft.source_dimension = matches[0].dimension;
    }
    const fit = str(draft.payload.fit_reason);
    if (fit) draft.rationale = `${fit} — ${draft.rationale}`;
  }
  return null;
}

// ── proposalsFrom — pure. See the module header for the full split. ────────

/** BLOCKER 2 (task-3-contract.md §7): the card's `systems` list, built from
 *  what install_role_systems ACTUALLY BINDS — role_archetypes.system_templates
 *  — not from required_connector_categories, which no writer reads.
 *
 *  Returns two parallel views of the same fact, on purpose:
 *   - `systems`: plain strings, because that is what §11b's card promise is
 *     made of and what validatePayload's "does not say what systems it can
 *     touch" check counts. Each entry is the template's own `label` (better
 *     card copy than a bare category key: "CRM / booking system", not "crm")
 *     followed by the READ/WRITE reach in parentheses. The reach is on the
 *     string rather than only in the structured field below because a
 *     read-only binding and a writing one are not the same promise, and the
 *     card renderer must not have to know a second field exists to tell them
 *     apart.
 *   - `system_access`: the same entries structured, keeping `system_key`
 *     (the identity de_connected_systems is keyed on) and the two booleans
 *     separately, so anything downstream reads a fact instead of parsing
 *     display prose.
 *
 *  The can_read/can_write defaults MIRROR install_role_systems' own
 *  coalesces (read defaults true, write defaults false, binding_kind
 *  defaults 'internal_table') so the card states what the writer will do,
 *  not what a stricter or looser reading would assume. */
function systemsFromTemplates(arch: ArchetypeLike): { systems: string[]; access: Record<string, unknown>[] } {
  const systems: string[] = [];
  const access: Record<string, unknown>[] = [];
  const templates = Array.isArray(arch.system_templates) ? arch.system_templates : [];
  for (const raw of templates) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    const systemKey = str(t.system_key);
    if (!systemKey) continue;
    const label = str(t.label) || systemKey;
    const canRead = t.can_read === undefined || t.can_read === null ? true : t.can_read === true;
    const canWrite = t.can_write === true;
    const reach = canWrite ? (canRead ? 'read/write' : 'write only') : (canRead ? 'read only' : 'no access');
    systems.push(`${label} (${reach})`);
    access.push({
      system_key: systemKey,
      label,
      can_read: canRead,
      can_write: canWrite,
      binding_kind: str(t.binding_kind) || 'internal_table',
    });
  }
  return { systems, access };
}

export interface ProposalsFromOptions {
  /** Live public.connector_providers rows. Omit (or pass []) to skip
   *  connector derivation entirely — proposalsFrom never throws for a
   *  missing catalog, it simply proposes no connectors, exactly like
   *  matchProvider itself returning [] for an empty catalog. */
  providerCatalog?: readonly ProviderCatalogRow[];
}

/** Which STRUCTURAL kinds (conversation_type / procedure / guardrail /
 *  trust_rule) a given dimension can produce, keyed by dimension `key` —
 *  NOT by parsing discovery_dimensions.produces' free-form prose, which is
 *  written for a human reader and is not a stable machine contract (its
 *  wording has already changed twice, migrations 733→734→735, without the
 *  underlying dimension keys moving). `employee` and `connector` are
 *  deliberately absent from this table: both are derived generically for
 *  ANY dimension from serves_archetypes / matched evidence respectively,
 *  never from a hardcoded per-dimension list — the same "never hand-
 *  maintain what can be derived" discipline discovery_capability_gaps
 *  itself is built on (migration 733's own header).
 *
 *  Mapped from the spine's own design (docs/superpowers/specs/2026-08-12-
 *  discovery-interview-design.md §3 and the 14-dimension guidance text,
 *  migration 734):
 *   - how_customers_reach_us WAS mapped here (it is the one dimension whose
 *     own produces list is about channels/routing for customer contact),
 *     and is deliberately mapped to nothing today — see the ⚠ note below.
 *   - must_never_happen (734, ordinal 11) is the SOLE guardrail source —
 *     "capture the hard lines ... these become guardrails rather than
 *     judgment calls".
 *   - who_signs_off (734, ordinal 12) is the SOLE trust_rule source —
 *     "the actual dollar thresholds and approval chains that gate action
 *     ... recurs almost verbatim across nearly every role" — i.e. it is
 *     where every approval number in the whole interview is meant to
 *     surface, including money_out's, so money_out itself does not double
 *     as a second trust_rule source.
 *   - money_in / how_work_gets_delivered / repetitive_work each name a
 *     concrete recurring procedure in their own `produces` text
 *     (overdue-invoice procedure; dispatch/scheduling procedure;
 *     close-cadence / dunning-cadence / renewal-cadence procedure).
 *  Dimensions not listed here produce no structural kind — what_we_do
 *  (vocabulary only), winning_business / after_the_sale / money_out /
 *  systems_of_record / the_workforce_itself (employee/connector only, via
 *  the generic paths above), and who_is_who / what_good_looks_like (org
 *  contacts and KPI targets — §11b lists both under "Safely deferred",
 *  no proposal kind among the six fits either).
 *
 *  ⚠ `how_customers_reach_us` PRODUCES NOTHING STRUCTURAL TODAY, and its
 *  absence from this table is a deliberate, dated decision — not an
 *  oversight, and not a removal of the kind.
 *  Until 2026-08-15 this table read `how_customers_reach_us:
 *  ['conversation_type']` and the loop below emitted a complete draft whose
 *  payload was `{ label: dim.title, owner_ref }`. Two measured facts killed
 *  it: `dim.title` for this dimension is literally "How customers reach us"
 *  — the interview's own question heading — so every tenant, every session,
 *  produced the SAME card; and there is no `conversation_types` table, no
 *  writer, and nothing that routes on the label, so accepting it could only
 *  ever have been a no-op wearing an accept button.
 *  ⚠ The topic axis it was pretending to be IS REAL and IS LIVE: it is
 *  `de_conversations.category`, driven by `support_triage_rules`
 *  (match_pattern -> set_category), tenant-editable with full CRUD UI. The
 *  founder's 2026-08-15 ruling is that the interview will write REAL triage
 *  rules, and `conversation_type` returns here WITH THAT PAYLOAD
 *  (match_pattern + set_category) AND WITH ITS WRITER — the follow-up task,
 *  not this one. Do NOT re-add the key here without that writer: a card that
 *  offers a decision no writer can carry out is the thing this whole module
 *  exists to refuse. The kind stays in ProposalKind, in
 *  discovery_proposals_kind_check and in the presentation module precisely so
 *  it can come back whole.
 *  Standing rule, unchanged: a kind absent from scripts/discovery-proposal-
 *  check.mjs's KIND_ROUTES makes certify go RED on any row carrying it, and
 *  that stays true for conversation_type. The fix was always to stop the
 *  emitter, never to add a route. */
const DIMENSION_STRUCTURAL_KINDS: Readonly<Record<string, readonly ProposalKind[]>> = {
  money_in: ['procedure'],
  how_work_gets_delivered: ['procedure'],
  repetitive_work: ['procedure'],
  must_never_happen: ['guardrail'],
  who_signs_off: ['trust_rule'],
};

/**
 * proposalsFrom — pure, no model call, no I/O.
 *
 * Reads each dimension's coverage entry and, for every dimension actually
 * marked 'heard' (the hard rule — see the module header), emits zero or more
 * ProposalDraft objects:
 *   - one CANDIDATE 'employee' draft per real (non-`planned_`) archetype the
 *     dimension serves, deduplicated by archetype key across the WHOLE call
 *     (several dimensions commonly name the same archetype — measured live,
 *     renewal_manager is named by five and 14 of the 15 active archetypes by
 *     more than one — and a person should see that role proposed once, not
 *     five times). ⚠ THE DEDUPE IS ON THE CARD, NOT ON THE EVIDENCE: the one
 *     surviving draft carries `evidence_sources`, every nominating
 *     dimension's sentence, because judging a role against only the first
 *     dimension's evidence refuses roles the customer named out loud (module
 *     header, "EVIDENCE IS THE UNION"). ⚠ CANDIDATE, not proposal: this set is the widest the
 *     answer may be, never the answer. Each draft is emitted with
 *     needs_model_fill: true and fit_reason: null, and is REFUSED by
 *     validatePayload unless a model grounds it in the dimension's own
 *     evidence — see the module header's "EMPLOYEE IS MODEL-FILLED". This
 *     derivation stays deliberately generic and deliberately wide, because
 *     narrowing it here would mean hardcoding which roles suit which
 *     industry, which is the one thing this module must never do;
 *   - zero or more 'connector' drafts from matchProvider() over the
 *     dimension's evidence text, deduplicated by provider_key across the
 *     whole call the same way;
 *   - the dimension's own structural kind(s) from DIMENSION_STRUCTURAL_KINDS,
 *     if any — procedure/guardrail/trust_rule, all emitted as an
 *     intentionally incomplete SHAPE with needs_model_fill: true (see the
 *     module header's "THE SPLIT"). ⚠ conversation_type used to be the one
 *     structural kind emitted COMPLETE; it is emitted not at all as of
 *     2026-08-15 — see DIMENSION_STRUCTURAL_KINDS' header.
 *
 * A dimension key present in `dimensions` but absent from
 * DIMENSION_STRUCTURAL_KINDS simply contributes no structural draft — this
 * is not an error, most of the fourteen dimensions are employee/connector-
 * only or produce nothing proposal-shaped at all (what_we_do; who_is_who;
 * what_good_looks_like).
 */
export function proposalsFrom(
  dimensions: readonly DiscoveryDimensionForProposals[],
  coverage: DiscoveryCoverageMap,
  archetypes: readonly ArchetypeLike[],
  options: ProposalsFromOptions = {},
): ProposalDraft[] {
  const providerCatalog = options.providerCatalog ?? [];
  const archetypeByKey = new Map(archetypes.map((a) => [a.key, a] as const));
  const drafts: ProposalDraft[] = [];
  const seenArchetypes = new Set<string>();
  const seenProviders = new Set<string>();

  // ── PRE-PASS: EVERY heard dimension's evidence, per archetype ────────────
  // BLOCKER 1 of the 2026-08-15 review — see the module header's "EVIDENCE IS
  // THE UNION, NEVER THE FIRST DIMENSION'S" for the measurement. This runs
  // ahead of the emission loop rather than accumulating inside it so that the
  // draft emitted at an archetype's FIRST nominating dimension already
  // carries the evidence of its LAST one. Same iteration order and the same
  // three filters as the employee arm below (heard / not planned_ / resolves
  // against `archetypes`), so the two can never disagree about which
  // dimensions nominated what.
  const archetypeSources = new Map<string, EvidenceSource[]>();
  for (const dim of dimensions) {
    const entry = coverage[dim.key];
    if (!entry || entry.state !== 'heard') continue;
    const dimEvidence = str(entry.evidence);
    for (const archKey of dim.serves_archetypes) {
      if (archKey.startsWith('planned_')) continue;
      if (!archetypeByKey.has(archKey)) continue;
      const list = archetypeSources.get(archKey);
      const source: EvidenceSource = { dimension: dim.key, title: dim.title, evidence: dimEvidence };
      if (list) list.push(source);
      else archetypeSources.set(archKey, [source]);
    }
  }

  for (const dim of dimensions) {
    const entry = coverage[dim.key];
    // THE HARD RULE. 'parked' has no evidence to close on by construction
    // (coverageAfter never requires it); 'skipped' is an explicit "not
    // relevant"; 'not_heard' is simply never reached. None of the three is
    // grounds for a proposal — inventing one from silence is the exact
    // failure the whole discovery programme exists to prevent, one layer
    // downstream of coverageAfter's own "silence is not coverage" gate.
    if (!entry || entry.state !== 'heard') continue;
    const evidence = str(entry.evidence);
    const evidenceLine = evidence || '(marked heard with no evidence text recorded)';

    // ---- employee: purely derived from serves_archetypes -----------------
    // Generic over EVERY dimension — never a hardcoded per-dimension list —
    // per the DE genericity discipline this codebase already holds itself
    // to elsewhere (never hardcode a department).
    for (const archKey of dim.serves_archetypes) {
      // A `planned_` archetype names a capability this product cannot staff
      // yet (migration 734's founder-specified escape hatch) — that is
      // discovery_capability_gaps' job to surface, never an invented role
      // here.
      if (archKey.startsWith('planned_')) continue;
      if (seenArchetypes.has(archKey)) continue;
      const arch = archetypeByKey.get(archKey);
      // A dimension may name an archetype key that does not resolve against
      // the archetypes actually passed in (stale data, or a caller passing
      // a partial list) — never invent a role for it.
      if (!arch) continue;
      seenArchetypes.add(archKey);
      const { systems, access } = systemsFromTemplates(arch);
      // Never empty: this dimension is heard, it nominated archKey, and it
      // resolved — so the pre-pass above put at least this dimension in the
      // list. The `??` is a type narrowing, not a fallback with a story.
      const sources = archetypeSources.get(archKey)
        ?? [{ dimension: dim.key, title: dim.title, evidence }];
      drafts.push({
        kind: 'employee',
        payload: {
          name: arch.name,
          job: arch.name,
          department: arch.domain,
          archetype_key: arch.key,
          systems,
          system_access: access,
          // DELIBERATELY NULL. A model fills these or the card is refused —
          // see the module header's "EMPLOYEE IS MODEL-FILLED".
          fit_reason: null,
          evidence_quote: null,
          // EVERY heard dimension that nominated this role, in ordinal
          // order — the module header's "EVIDENCE IS THE UNION". This is
          // what employeeGroundingProblem checks the model's verbatim quote
          // against, one source at a time, and validatePayload only ever
          // sees a payload.
          evidence_sources: sources,
          // The same fact joined for display and for any older reader that
          // still expects a single string. ⚠ NEVER the substring target for
          // the quote check — `evidence_sources` is, precisely so a span
          // straddling two dimensions' sentences cannot read as one thing
          // the customer said. The separator is chosen to make that visible.
          evidence: sources.map((s) => s.evidence).filter(Boolean).join(' · '),
          starts_supervised: true,
          sends_nothing: true,
          comes_with_published_sop: true,
        },
        rationale: sources
          .map((s) => `Heard evidence for "${s.title}": ${s.evidence || '(marked heard with no evidence text recorded)'}`)
          .join(' · '),
        // The first heard dimension that nominated the role. Re-pointed at
        // whichever source the model actually quoted, when that is knowable
        // — applyFillToDraft, and the module header's own note on it.
        source_dimension: sources[0].dimension,
        needs_model_fill: true,
      });
    }

    // ---- connector: purely derived via matchProvider ----------------------
    // Generic over EVERY dimension's evidence, same reasoning as above.
    if (evidence && providerCatalog.length) {
      for (const match of matchProvider(evidence, providerCatalog)) {
        if (seenProviders.has(match.provider_key)) continue;
        const row = providerCatalog.find((p) => p.provider_key === match.provider_key);
        if (!row) continue; // defensive: matchProvider only ever returns keys from the catalog it was given
        seenProviders.add(match.provider_key);
        drafts.push({
          kind: 'connector',
          payload: {
            provider_key: row.provider_key,
            label: row.label,
            category: row.category,
            matched_on: match.matched_on,
            confidence: match.confidence,
            // Category is real, structured data on the catalog row — a
            // system-level statement of what it touches, derivable with no
            // model. Field-level mapping (which objects, which actions) is
            // explicitly deferred by §11b ("connector field mappings and
            // action enablement") to after acceptance.
            reads: [`${row.category} records`],
            writes: [],
            credential_note: 'You still enter the credential yourself.',
          },
          rationale: `"${row.label}" matched (${match.confidence}, on "${match.matched_on}") in evidence for "${dim.title}": ${evidenceLine}`,
          source_dimension: dim.key,
          needs_model_fill: false,
        });
      }
    }

    // ---- this dimension's own structural kind(s) --------------------------
    // ⚠ There is deliberately NO `conversation_type` arm here. It was removed
    // on 2026-08-15 together with the DIMENSION_STRUCTURAL_KINDS entry that
    // reached it — see that table's header for the measured reasons and for
    // the exact shape it returns in with (match_pattern + set_category,
    // writing support_triage_rules). Re-adding this arm without that writer
    // puts an un-routable card in front of a customer and turns
    // scripts/discovery-proposal-check.mjs red on the first real interview.
    for (const kind of DIMENSION_STRUCTURAL_KINDS[dim.key] ?? []) {
      if (kind === 'procedure') {
        drafts.push({
          kind: 'procedure',
          payload: {
            name: null,
            trigger: null,
            steps: [],
            evidence,
            note: 'draft; runs only when you publish',
          },
          rationale: `Heard evidence for "${dim.title}": ${evidenceLine}`,
          source_dimension: dim.key,
          needs_model_fill: true,
        });
      } else if (kind === 'guardrail') {
        drafts.push({
          kind: 'guardrail',
          payload: {
            rule: evidence || dim.title,
            pattern: null,
            threshold: null,
            severity: 'blocking',
          },
          rationale: `Heard evidence for "${dim.title}": ${evidenceLine}`,
          source_dimension: dim.key,
          needs_model_fill: true,
        });
      } else if (kind === 'trust_rule') {
        drafts.push({
          kind: 'trust_rule',
          payload: {
            de_ref: null,
            action_category: null,
            cap: null,
            evidence,
          },
          rationale: `Heard evidence for "${dim.title}": ${evidenceLine}`,
          source_dimension: dim.key,
          needs_model_fill: true,
        });
      }
    }
  }

  return drafts;
}
