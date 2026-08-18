// discoveryProposalPresentation.ts — pure card copy + batching rules for the
// discovery proposal screen (.superpowers/sdd/2026-08-13-discovery-proposals-
// and-creation, Task 2: "a screen that is short where that is safe").
//
// PURE ON PURPOSE, same discipline as supabase/functions/_shared/
// discoveryProposals.ts (Task 1): no supabase import, no I/O, so the rule
// that decides "does this kind ever get an Accept-all button" is provable
// with a unit test, not just readable in a switch statement inside a 1000-
// line page component. tests/discovery-proposal-batching.test.ts is that
// test — see its own header for exactly what would turn it red.
//
// ProposalKind/PROPOSAL_KINDS are DELIBERATELY re-declared here rather than
// imported from supabase/functions/_shared/discoveryProposals.ts — the same
// "cannot import across the supabase/ boundary cleanly" reason
// src/lib/categoryContracts.ts's own header already documents for its mirror
// of supabase/functions/_shared/categoryContracts.ts. Kept in sync by hand;
// six kinds is a smaller surface than that mirror already is.
//
// §11b (docs/superpowers/specs/2026-08-12-discovery-interview-design.md) is
// the design law this file encodes:
//   - guardrail and trust_rule NEVER batch — comparing guardrails across
//     rules is the disclosure the task exists to protect, and a trust_rule
//     is the one proposal that removes a human.
//   - conversation_type / procedure / connector are low-stakes enough that
//     their SECOND gate (publish / credential) is the real consent, so they
//     get "accept all N" with per-item unchecking.
//     ⚠ RE-EXAMINED FOR conversation_type ON 2026-08-18, because migration 754
//     gave that kind a real writer and the old justification named a "SECOND
//     gate" it does not have — there is no publish step and no credential for a
//     triage rule. accept_all is KEPT, on a different and stronger argument:
//     an accepted topic CHANGES NO DECISION. It writes a label the inbox filter
//     and the History report count by; it blocks nothing (unlike a guardrail),
//     removes no human (unlike a trust rule), grants no access (unlike a
//     connector), creates no colleague (unlike an employee), and does not
//     choose who answers — de_conversations.de_id is stamped when the
//     conversation row is inserted, before the first message exists. It is also
//     the ONE kind that routinely arrives ten at a time, which is the case this
//     mode exists for, and every one of the ten is individually removable in
//     Support › Triage rules afterwards. If a future change ever lets a topic
//     set priority, severity or ownership, this decision has to be re-made:
//     those DO change what happens to traffic. createTriageRuleFromProposal
//     therefore writes the column defaults for priority and severity and takes
//     neither from the payload.
//   - employee batches by department, but every card stays individually
//     visible — batching here is a GROUPING device, never a bulk-decide one.
// ============================================================

export type ProposalKind =
  | 'employee' | 'procedure' | 'connector' | 'guardrail' | 'trust_rule' | 'conversation_type';

export const PROPOSAL_KINDS: readonly ProposalKind[] =
  ['employee', 'procedure', 'connector', 'guardrail', 'trust_rule', 'conversation_type'];

export type ProposalState = 'pending' | 'accepted' | 'declined' | 'parked';

/** How a kind is presented on the screen. Nothing renders a batch control
 *  for a kind this function doesn't say to — the page component switches on
 *  this return value rather than re-deriving the rule inline, so the "never
 *  batch" guarantee lives in exactly one place. */
export type BatchMode = 'never' | 'department' | 'accept_all';

const NEVER_BATCH: ReadonlySet<ProposalKind> = new Set(['guardrail', 'trust_rule']);
const DEPARTMENT_BATCH: ReadonlySet<ProposalKind> = new Set(['employee']);

/** The single gate every section renderer calls. Exhaustive over
 *  PROPOSAL_KINDS by construction (the switch below has no default branch
 *  that could accidentally batch an unrecognised kind — see the test file's
 *  "every kind resolves" case, which fails loudly instead of falling
 *  through if a seventh kind is ever added here and forgotten there). */
export function batchModeFor(kind: ProposalKind): BatchMode {
  if (NEVER_BATCH.has(kind)) return 'never';
  if (DEPARTMENT_BATCH.has(kind)) return 'department';
  return 'accept_all';
}

export const KIND_LABELS: Record<ProposalKind, string> = {
  employee: 'People to hire',
  guardrail: 'Guardrails',
  trust_rule: 'Trust rules',
  connector: 'Systems to connect',
  procedure: 'Procedures',
  conversation_type: 'Conversation topics',
};

/** Reading order (docs/superpowers/sdd task-2-report.md explains the
 *  choice): employees first (who is involved), then the two kinds that
 *  never batch — guardrails and trust rules — read with full attention
 *  before any "accept all" fatigue, then the three low-stakes batches. */
export const SECTION_ORDER: readonly ProposalKind[] =
  ['employee', 'guardrail', 'trust_rule', 'connector', 'procedure', 'conversation_type'];

/**
 * The sentence under an "Accept N selected" heading.
 *
 * ⚠⚠ THIS USED TO BE ONE LITERAL FOR ALL THREE accept_all KINDS, and it said:
 * "The real consent step for X comes later — publishing a procedure, or
 * entering a credential for a connector." For a conversation topic there IS NO
 * LATER STEP. That is the same false promise migration 754 identified on the
 * card face ("you can assign one when you publish") and removed — re-made one
 * level up, over a whole section, where it covers ten cards at once instead of
 * one. A topic accept writes a live triage rule: classify_support_text reads
 * every active rule in the workspace on the first user message of every support
 * conversation, so there is nothing between the click and the traffic.
 *
 * It is a FUNCTION over the kind, not a record with a fallback, for the reason
 * batchModeFor's header gives: a default branch is how a seventh kind inherits
 * a promise nobody made for it. A kind with no entry gets a sentence that
 * claims nothing beyond what the checkbox does.
 *
 * PURE, so it is pinned by a unit test rather than by grepping a page.
 */
export function acceptAllSectionBlurb(kind: ProposalKind): string {
  switch (kind) {
    case 'connector':
      return 'Accepting one records the system and nothing more — you still enter the credential yourself, under Systems, before anything can read or write. Uncheck anything you don\'t want proposed at all.';
    case 'procedure':
      return 'Accepting one writes a draft under Playbooks and runs nothing: publishing it is the step that lets it run, and that is a separate decision. Uncheck anything you don\'t want proposed at all.';
    case 'conversation_type':
      return 'There is no later step for these. Accepting one adds a triage rule straight away, and new conversations using those words are filed under that topic from then on — it changes who answers nothing, it sits behind your built-in categories like Safety and Security, and you can reword or remove any of them under Support › Triage rules. Uncheck anything you don\'t want.';
    default:
      return 'Uncheck anything you don\'t want proposed at all.';
  }
}

// ── small string helpers, same shape as discoveryProposals.ts's own ────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}
function isNumericLiteral(v: unknown): v is number | string {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const t = v.trim().replace(/^\$/, '').replace(/,/g, '').replace(/%$/, '');
    return t.length > 0 && /^-?\d+(\.\d+)?$/.test(t);
  }
  return false;
}
function numericLiteral(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim().replace(/^\$/, '').replace(/,/g, '').replace(/%$/, '');
    const n = Number(t);
    return Number.isFinite(n) && t.length > 0 ? n : null;
  }
  return null;
}

/** "action:erp_financials" / "writeback:crm" / "answer_dock" → "Erp
 *  Financials" / "Crm" / "Answer Dock". Display only — never compared
 *  against, never stored (same discipline as statusVocabulary.ts). */
export function humanizeToken(raw: string): string {
  const t = raw.replace(/^action:/, '').replace(/^writeback:/, '').replace(/[_:]+/g, ' ').trim();
  if (!t) return raw;
  return t.replace(/\b\w/g, (c) => c.toUpperCase());
}

const CATEGORY_SHORT_LOCAL: Record<string, string> = {
  crm: 'CRM', helpdesk: 'Helpdesk', knowledge_base: 'Knowledge base',
  erp_financials: 'ERP / Financials', billing: 'Billing',
  payroll_hcm: 'Payroll / HCM', pos: 'Point of sale',
  product_system: 'Product system',
  ads: 'Ads', social: 'Social', web_analytics: 'Web analytics',
  other: 'Other',
};

/** A CONNECTOR CATEGORY KEY ("erp_financials") to the same short label
 *  src/lib/categoryContracts.ts's CATEGORY_SHORT already uses elsewhere in
 *  the app — duplicated here (not imported) to keep this module's only
 *  dependency being plain data, no risk of pulling in anything with I/O.
 *  Falls back to humanizeToken for anything outside the known set.
 *
 *  ⚠ CATEGORY KEYS ONLY. M1 of the 2026-08-15 review: this used to be mapped
 *  over an employee payload's `systems`, and the doc comment above still
 *  described those as "an employee's required_connector_categories" long
 *  after BLOCKER 2 rebuilt them from role_archetypes.system_templates. They
 *  are no longer category keys — they are finished display strings carrying
 *  the reach in parentheses ("Invoices (AR) (read/write)"), and humanizeToken
 *  title-cases every word, so the card rendered "Invoices (AR) (Read/Write)".
 *  A stale doc comment is how that survived review: it said the input was
 *  something it had stopped being. Employee systems are now rendered
 *  verbatim; the only caller left is humanizeConnectorTouch below, on a
 *  genuine category token. */
export function humanizeSystem(key: string): string {
  return CATEGORY_SHORT_LOCAL[key] ?? humanizeToken(key);
}

/** Fix round 1 (review, Important — "connector literals leak snake_case").
 *  Task 1 (supabase/functions/_shared/discoveryProposals.ts) emits a
 *  connector's `reads` as exactly `${row.category} records` — e.g.
 *  "erp_financials records", "helpdesk records". Humanizes the leading
 *  category token via the same short labels employee systems already use
 *  (so "erp_financials records" and an employee's "ERP / Financials" read
 *  as the same system), and falls back to Title Case for any other
 *  underscored shape a future payload might carry, rather than ever
 *  leaving a raw snake_case token on a card. A string with no leading
 *  known category and no underscore (e.g. a literal object name like
 *  "deals") passes through unchanged — this is what makes spec §11b's own
 *  illustrative "reads deals, writes notes" still render correctly if a
 *  future payload shape ever produces it, without that illustration being
 *  treated as proof today's shape needs no humanizing. */
export function humanizeConnectorTouch(raw: string): string {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(' ');
  const firstWord = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
  if (CATEGORY_SHORT_LOCAL[firstWord]) return `${humanizeSystem(firstWord)}${rest}`;
  return /_/.test(trimmed) ? humanizeToken(trimmed) : trimmed;
}

/** "10000" / 10000 / "$10,000" → "$10,000". answer_dock/answer_widget are
 *  the two action categories set_trust_ladder confidence-gates instead of
 *  dollar-gating (src/lib/trustApi.ts's own trustLevelSettings encodes the
 *  same split) — so a cap on either reads as a confidence percentage, not
 *  money. ONLY for trust_rule's cap, which carries a real actionCategory to
 *  decide the unit from — see the header note on guardrailLiteral below for
 *  why a guardrail's threshold must NOT go through this function. */
export function formatCap(actionCategory: string, cap: unknown): string {
  const n = numericLiteral(cap);
  if (n === null) return str(cap) || 'no cap recorded';
  const usesConfidence = actionCategory === 'answer_dock' || actionCategory === 'answer_widget';
  if (usesConfidence) return `${n}% confidence`;
  return `$${n.toLocaleString('en-US')}`;
}

/** A bare number, grouped for legibility, with NO invented unit — "100000"
 *  → "100,000", never "$100,000". A guardrail's threshold carries no unit
 *  field anywhere in Task 1's payload (its FILL_WHITELIST is only
 *  `pattern`/`threshold` — no `rule_type`, no currency, no percent), so a
 *  20%-discount threshold of 20 and a require_approval_over_cents threshold
 *  of 100000 are BOTH just the bare number 20 / 100000 on the wire. Fix
 *  round 1 (review): the previous version ran every guardrail threshold
 *  through formatCap('', threshold), which always fell into formatCap's
 *  dollar branch (an empty actionCategory is never 'answer_dock'/
 *  'answer_widget') — rendering a 20%-discount cap as "$20" and a
 *  100,000-CENTS approval threshold as "$100,000", a hundred-fold error.
 *  §11b: "you cannot consent to a block you cannot predict" — a wrong unit
 *  is not a smaller version of that failure, it IS that failure. */
export function formatBareNumber(v: unknown): string {
  const n = numericLiteral(v);
  if (n === null) return str(v) || 'no threshold recorded';
  return n.toLocaleString('en-US');
}

// ── looksLikeEnforceablePattern — duplicated on purpose ─────────────────────
// Byte-for-byte behaviourally identical to supabase/functions/_shared/
// discoveryProposals.ts's own copy, same "cannot import across the
// supabase/ boundary" reason as matchProvider's duplication in that file
// (its own header explains why: that module must load under both Vite and
// Deno, and re-declaring six kinds' worth of small pure logic here is a
// smaller surface than pulling in a Deno-shaped module tree). Kept honest
// by tests/discovery-proposal-batching.test.ts's drift-guard case, which
// imports the REAL one from supabase/functions/_shared/discoveryProposals.ts
// (legal under vitest, same as Task 1's own drift guard for matchProvider)
// and asserts identical output across a battery of cases.
//
// Fix round 1 (review, Critical 1 second half): the previous guardrailLiteral
// treated ANY truthy payload.pattern as the enforceable literal. But Task 1's
// validatePayload accepts a guardrail whose pattern fails this exact check
// as long as threshold is a valid number — pattern is never nulled out in
// that case, so a persisted row can carry a PROSE pattern
// ("anything the customer might find upsetting") sitting right next to a
// valid numeric threshold. Rendering that prose as "matches: ..." presents
// exactly the un-consentable literal §11b's guardrail row warns against.
const PATTERN_PROSE_WORDS = /\b(the|and|might|could|should|would|whatever|anything|something|appropriate|reasonable|seems|find|please|kindly|customer|customers)\b/i;
function looksLikeEnforceablePattern(v: string): boolean {
  const t = v.trim();
  if (!t || t.length > 120) return false;
  if (/[.!?]$/.test(t)) return false;
  if (t.split(/\s+/).filter(Boolean).length > 5) return false;
  if (PATTERN_PROSE_WORDS.test(t)) return false;
  return true;
}
export { looksLikeEnforceablePattern as __looksLikeEnforceablePattern_forDriftTestOnly };

/** Which of the two real guardrail behaviours this payload actually
 *  describes, derived from what's PRESENT and VALID on the payload — never
 *  from a rule_type field, because Task 1 never collects one (see
 *  formatBareNumber's header).
 *
 *  ⚠ CORRECTED 2026-08-17 (migration 751). This comment used to say
 *  "public.guardrail_rules.rule_type has exactly four values". It does not, and
 *  it had not for some time: the LIVE CHECK constraint
 *  (guardrail_rules_rule_type_check, read from pg_constraint) admits NINE —
 *  blocked_topic, blocked_phrase, require_approval_over_cents,
 *  max_discount_pct, frustration_signal, require_computed_number,
 *  require_citation, spend_cap_daily_cents, spend_cap_monthly_cents. The union
 *  in src/lib/guardrailApi.ts is a subset the browser happens to write, not the
 *  vocabulary. What survives the correction is the part that mattered:
 *  findBlockingMatch (supabase/functions/_shared/guardrailMatch.ts) is
 *  PATTERN-ONLY, so nothing in this codebase blocks outbound text on a bare
 *  number, whichever of the nine a threshold ended up as.
 *
 *  What the writer actually does with each answer is now settled and narrow
 *  (see guardrailAcceptability): 'pattern' is written as `blocked_phrase`;
 *  'threshold' and 'none' are refused. */
export type GuardrailKind = 'pattern' | 'threshold' | 'none';
export function guardrailKindOf(payload: Record<string, unknown>): GuardrailKind {
  const patternRaw = str(payload.pattern);
  if (patternRaw && looksLikeEnforceablePattern(patternRaw)) return 'pattern';
  if (isNumericLiteral(payload.threshold)) return 'threshold';
  return 'none';
}

/** CAN THIS GUARDRAIL BE SWITCHED ON AT ALL — the ONE gate, shared by the card
 *  copy and by the accept writer.
 *
 *  ⚠ IT IS ONE FUNCTION BECAUSE IT USED TO BE A SENTENCE. Before migration 751
 *  the card said, for a threshold-only guardrail, "Above this, it needs your
 *  approval before it goes ahead" — a promise, in the present tense, about
 *  something no accept path existed to do. The founder's ruling of 2026-08-15
 *  (patterns now, thresholds held) makes that sentence false in a new way:
 *  accepting one is REFUSED. A card that keeps promising an approval gate while
 *  the button behind it declines is worse than the original overclaim, because
 *  the customer now has evidence the screen is lying to them.
 *
 *  So the card's consequence sentence, the drawer's "what accepting writes",
 *  and discoveryApi's decision whether to create a rule at all are all read from
 *  HERE. `reason` is written for a business owner and is deliberately close to
 *  the wording decide_discovery_proposal itself raises — the RPC is what writes
 *  the refusal onto the row (migration 740's last_error), and a card that
 *  predicted the refusal in different words than the one it then displays reads
 *  like two different systems disagreeing.
 *
 *  ⚠ WHAT THIS IS NOT: it is not the authority. The RPC re-derives all of it in
 *  SQL, including its own copy of looksLikeEnforceablePattern, and refuses
 *  independently — because the browser is not a safe place to keep a promise.
 *
 *  ⚠ A FLAT SHAPE, NOT A DISCRIMINATED UNION, and that is a fact about this
 *  repo rather than a preference: tsconfig.json sets `"strict": false`, and
 *  with strictNullChecks off TypeScript will not narrow `{ok:true;pattern} |
 *  {ok:false;reason}` on `gate.ok` — every read of `.reason` errors. Both
 *  fields are therefore always present, and their emptiness is the contract:
 *  `pattern` is '' when !ok, `reason` is '' when ok. */
export interface GuardrailAcceptability {
  /** Can a rule be created from this payload today? */
  ok: boolean;
  /** The literal to write as `guardrail_rules.pattern`, trimmed. '' when !ok. */
  pattern: string;
  /** Why not, in a sentence for a business owner. '' when ok. */
  reason: string;
}

/** ── THE CONSENTED LITERAL IS COMPILED AS A REGULAR EXPRESSION ──────────────
 *  matchPattern (supabase/functions/_shared/guardrailMatch.ts:65-79) does
 *  `text.match(new RegExp(pattern, 'i'))` and only falls back to literal
 *  fragment matching when that compilation THROWS. Its header rests the safety
 *  argument on an audit of 85 HAND-AUTHORED patterns.
 *
 *  ⚠ CORRECTED 2026-08-17. This paragraph used to say migration 751 "is the
 *  FIRST path that lets a MODEL-authored literal reach that compiler". That was
 *  false about the code and true only about the data. `approveProposal`
 *  (src/lib/governanceAiApi.ts) has always passed `governance_proposals.pattern`
 *  — a column the Workspace Assistant writes — straight into `addGuardrailRule`
 *  with no screen of any kind: not this one, not the empty-alternative one, not
 *  even looksLikeEnforceablePattern. A human clicks Approve, but the bytes are
 *  the model's, and "refund|" through that door mutes every outbound message on
 *  all four enforcement paths exactly as it would through this one. It had never
 *  been used — `governance_proposals` holds 0 rows, measured 2026-08-17 — which
 *  is why the sentence read as true.
 *
 *  So the screen no longer lives only on this gate: it lives on
 *  `addGuardrailRule`, the writer every door goes through, and this gate calls
 *  the same function (`screenGuardrailPattern`) so the card's refusal sentence
 *  and the writer's refusal sentence are one expression.
 *
 *  Replicated in node against the real matcher — every one of these passes
 *  looksLikeEnforceablePattern above:
 *
 *    "$500 off"     on "we can do $500 off for you"  -> null, BLOCKS NOTHING
 *    "(free) month" on "have a (free) month"         -> null, BLOCKS NOTHING
 *    "3.5% fee"     on "our 3x5% fee applies"        -> matches, BLOCKS WIDER
 *    "refund|"      on "we will ship it tomorrow"    -> "",   BLOCKS EVERYTHING
 *
 *  The last one is the worst: an empty alternative compiles to a regex that
 *  matches the empty string, matchPattern returns '' and findBlockingMatch
 *  tests `!== null`, so one trailing pipe withholds EVERY outbound message on
 *  all four enforcement paths.
 *
 *  ⚠ THE SCREEN IS HERE, NOT IN THE MATCHER, and that is the decision. Changing
 *  matchPattern would change enforcement for the 85 live hand-authored rules,
 *  including the one that legitimately uses grouping — a different migration
 *  with a different argument. Screening at the acceptance gate narrows only what
 *  a customer can be asked to consent to, and narrows it to the shape where the
 *  compiled regex and a plain reading of the words agree. §11b is about being
 *  able to PREDICT the block; a card that instead disclosed "this may match more
 *  or less than it says" would satisfy nothing.
 *
 *  ⚠ NOT folded into looksLikeEnforceablePattern. That predicate answers "is
 *  this a literal rather than prose", it has two other copies, and Task 1's
 *  validatePayload uses it at EMISSION — tightening it there would DROP the
 *  proposal instead of showing the customer a card that says why it cannot be
 *  switched on. The literal still reaches the card (guardrailLiteral renders
 *  "matches: $500 off" as before); only the accept refuses.
 *
 *  Mirrored in SQL in migration 751's guardrail branch, character for
 *  character, and pinned against it by
 *  tests/discovery-proposal-batching.test.ts. */
const PATTERN_REGEX_METACHARS = /[\\^$.?*+(){}[\]]/;
const PATTERN_NOT_METACHAR_G = /[^\\^$.?*+(){}[\]]/g;
const PATTERN_EMPTY_ALTERNATIVE = /(^\||\|\||\|$)/;

/** ⚠ FIVE CODE POINTS THAT ARE WHITESPACE TO POSTGRES AND ARE NOT WHITESPACE TO
 *  JAVASCRIPT, AND THE DIFFERENCE IS ON THE UNSAFE SIDE OF THE ONE INVARIANT.
 *
 *  U+001C U+001D U+001E U+001F (the C0 file/group/record/unit separators) and
 *  U+0085 (NEL) are all matched by Postgres's `\s` and by none of JS's `\s`,
 *  `.trim()` or the explicit btrim set migration 751 uses. Measured against the
 *  live database, not assumed:
 *
 *      select array_length(regexp_split_to_array('a'||chr(28)||'b','\s+'),1)  -> 2
 *      /\s/.test('\u001c')                                              -> false
 *
 *  So `a<US>b<US>c<US>d<US>e<US>f` is ONE word to looksLikeEnforceablePattern
 *  and SIX to `array_length(regexp_split_to_array(v_pattern,'\s+'),1) <= 5`; a
 *  LEADING U+0085 additionally produces an empty leading element Postgres counts
 *  and JS's `.filter(Boolean)` drops, turning five JS tokens into six. Run
 *  against LIVE POSTGRES, that class produced TEN patterns the client accepted
 *  and the database refused — and because the client INSERTS FIRST, every one of
 *  them leaves a live, blocking, workspace-wide rule behind a proposal that can
 *  never be stamped and re-refuses on every retry.
 *
 *  ⚠ REFUSED OUTRIGHT RATHER THAN COUNTED DIFFERENTLY, and that is the choice.
 *  Mirroring Postgres's word-splitting in JS would mean re-deriving its ctype in
 *  the browser — a fourth transcription of a database behaviour, which is the
 *  exact failure this whole area keeps paying for. Refusing the characters makes
 *  the client STRICTER than the database on the entire class, which is the only
 *  safe direction, and it costs nothing real: they are C0 control characters and
 *  a line separator, 0 of the 168 live active patterned rules carry one, and 0
 *  of the 20 industry templates do (both measured 2026-08-17).
 *
 *  ⚠ THE DATABASE IS DELIBERATELY LEFT LOOSER. Adding the same refusal to the
 *  SQL would be SQL-stricter drift for the window in which only one copy has
 *  shipped, and SQL-looser is the arm that is safe by construction: the client
 *  refuses first and creates nothing. */
const PATTERN_PG_ONLY_WHITESPACE = /[\u001c\u001d\u001e\u001f\u0085]/;

/** Which screen refused, so a caller can apply them separately.
 *  `'metachar'` is the one a HAND-AUTHORED pattern is let through — see
 *  `addGuardrailRule`'s header for the measured reason and the count.
 *  `'empty_alternative'` and `'pg_only_whitespace'` are refused for every
 *  provenance: 0 live rules and 0 shipped templates carry either, neither is
 *  ever intentional, and each one on its own is a silent outage. */
export type PatternScreenFailure = 'metachar' | 'empty_alternative' | 'pg_only_whitespace';

/** ⚠ THE SCREENS THAT RUN NO MATTER WHO WROTE THE BYTES, named HERE rather than
 *  at the writer. When this set lived as an inline condition at the writer
 *  (`provenance === 'model_authored' || screen.failure === 'empty_alternative'`)
 *  it was one expression away from being wrong, and it was wrong: see
 *  `screenGuardrailPattern` on why reporting only the FIRST failure let
 *  `"refund.|"` through a hand-authored door. */
export const UNIVERSAL_PATTERN_SCREENS: readonly PatternScreenFailure[] =
  ['empty_alternative', 'pg_only_whitespace'];

export interface PatternScreen {
  ok: boolean;
  /** The FIRST screen that refused — what the card copy quotes. `null` when ok. */
  failure: PatternScreenFailure | null;
  /** Why, in a sentence for a business owner. '' when ok. */
  reason: string;
  /** ⚠ EVERY SCREEN THAT REFUSED, EACH WITH ITS OWN SENTENCE — and this field
   *  exists because returning only the first one was a live hole.
   *
   *  `"refund.|"` and `"$500 off|"` trip BOTH the metacharacter screen and the
   *  empty-alternative screen. The single `failure` field reported `'metachar'`,
   *  the writer's hand-authored branch skips the metacharacter screen by design
   *  (13 of 20 industry templates use regex deliberately), and so a literal that
   *  compiles to a regex matching the EMPTY STRING was accepted through the
   *  ordinary Add dialog — muting every outbound message on all four enforcement
   *  paths. A caller that must apply the universal screens has to be able to see
   *  them even when a provenance-exempt one fired first. */
  failures: Array<{ failure: PatternScreenFailure; reason: string }>;
}

/** ⚠ THE SCREEN ITSELF, AS ONE FUNCTION, BECAUSE IT IS ON THE WRITER NOW.
 *
 *  It used to be two `if` blocks inside `guardrailAcceptability` — i.e. on ONE
 *  caller, the discovery accept path — while `approveProposal` handed the same
 *  compiler a model-authored pattern through `addGuardrailRule` with nothing in
 *  front of it at all. `addGuardrailRule` now calls this, so a door that is
 *  added later gets the screen without anybody remembering to add it, and this
 *  gate calls it too so the sentence on the card is the sentence the writer
 *  would raise.
 *
 *  Flat shape, not a discriminated union, for the same `"strict": false` reason
 *  GuardrailAcceptability states. */
export function screenGuardrailPattern(literal: string): PatternScreen {
  // ⚠ EVERY SCREEN RUNS, AND ALL OF THEM ARE REPORTED. This used to be three
  // early returns, so only the first failure was ever visible — and the writer's
  // hand-authored branch, which is allowed to skip the metacharacter screen,
  // therefore skipped the EMPTY-ALTERNATIVE screen too whenever both fired.
  // `"refund.|"` typed into the ordinary Add dialog was accepted: `.` reported
  // first, `metachar` is provenance-exempt, and the trailing `|` compiles to a
  // regex matching the empty string. `failures` is the list a caller filters;
  // `failure`/`reason` stay the first one, because the card quotes one sentence.
  const failures: Array<{ failure: PatternScreenFailure; reason: string }> = [];
  if (PATTERN_REGEX_METACHARS.test(literal)) {
    failures.push({
      failure: 'metachar',
      reason: `This one cannot be switched on as written: "${literal}" contains ${literal.replace(PATTERN_NOT_METACHAR_G, '')} — a blocking rule is read as a search expression, so those characters mean something other than themselves and it would block something other than the words shown here. A phrase of plain words, with "|" between alternatives, is one we can promise.`,
    });
  }
  if (PATTERN_EMPTY_ALTERNATIVE.test(literal)) {
    failures.push({
      failure: 'empty_alternative',
      reason: `This one cannot be switched on as written: "${literal}" has a "|" with nothing beside it, and a rule written that way matches every message rather than these words — every answer this workspace sends would be withheld.`,
    });
  }
  if (PATTERN_PG_ONLY_WHITESPACE.test(literal)) {
    failures.push({
      failure: 'pg_only_whitespace',
      // No literal is quoted back here, deliberately: the offending characters
      // are invisible, so printing the phrase would show the reader something
      // that looks exactly like what they typed and explain nothing.
      reason: 'This one cannot be switched on as written: it contains an invisible separator character that different parts of the system count differently, so the rule that got saved would not be the rule that was checked. Retyping the phrase as plain words fixes it.',
    });
  }
  const first = failures[0];
  return {
    ok: failures.length === 0,
    failure: first ? first.failure : null,
    reason: first ? first.reason : '',
    failures,
  };
}

export function guardrailAcceptability(payload: Record<string, unknown>): GuardrailAcceptability {
  switch (guardrailKindOf(payload)) {
    case 'pattern': {
      const literal = str(payload.pattern);
      const screen = screenGuardrailPattern(literal);
      if (!screen.ok) return { ok: false, pattern: '', reason: screen.reason };
      return { ok: true, pattern: literal, reason: '' };
    }
    case 'threshold':
      return {
        ok: false,
        pattern: '',
        reason: `This one is a bare number with no unit, so it cannot be switched on yet: ${formatBareNumber(payload.threshold)} could be that many dollars or that many per cent, and those are two different rules. We would rather ask than guess by a factor of a hundred.`,
      };
    case 'none':
      return {
        ok: false,
        pattern: '',
        reason: 'This one has no phrase to match on, and a blocking rule only stops the exact words it is given — so there is nothing here to switch on yet.',
      };
  }
}

/** guardrail's enforceable literal, verbatim per §11b — but "verbatim" means
 *  exactly what's on the payload, never a unit invented to make it read
 *  nicer. A pattern renders as "matches: X" ONLY when it re-passes
 *  looksLikeEnforceablePattern here (Task 1's validatePayload does not null
 *  out a prose pattern sitting beside a valid threshold — see the header
 *  above). A threshold renders as a bare, grouped number with no currency
 *  or percent sign, because the payload carries no unit to be honest about.
 *
 *  ⚠ "matches:" IS A PROMISE, AND IT USED TO SURVIVE THE REFUSAL. This function
 *  keyed on guardrailKindOf alone, which never consults the two screens, so a
 *  card for "$500 off" rendered
 *
 *      meta   : matches: $500 off
 *      detail : This one cannot be switched on as written: "$500 off" contains $ …
 *
 *  — the promise and its withdrawal, side by side, about the same four words.
 *  That is the same defect shape whatAcceptingWrites already had fixed once
 *  ("Creates a guardrail that requires your approval…" → "Creates nothing").
 *  §11b requires the literal to be SHOWN; it does not require the word
 *  "matches", and a refused literal has not been promised anything. So a
 *  screened-out pattern renders as "phrase as written: X" — the four words are
 *  still on the card verbatim, which is what makes "we could not act on this"
 *  checkable, and nothing next to them claims they will be matched. */
export function guardrailLiteral(payload: Record<string, unknown>): string {
  switch (guardrailKindOf(payload)) {
    case 'pattern': {
      const literal = str(payload.pattern);
      return screenGuardrailPattern(literal).ok
        ? `matches: ${literal}`
        : `phrase as written: ${literal}`;
    }
    case 'threshold': return `threshold: ${formatBareNumber(payload.threshold)}`;
    case 'none': return 'no literal recorded yet';
  }
}

// ── procedure: the composed SOP text, and the gate the card shares ────────
// (migration 752)

/** The steps a procedure payload really carries: trimmed, blanks dropped.
 *
 *  ⚠ NOT `strArray`. That one filters on `x.trim().length > 0` and then keeps
 *  the UNTRIMMED string, which is right for display and wrong here: every one
 *  of these goes into the composed SOP text, and that text is compared BYTE FOR
 *  BYTE by decide_discovery_proposal against what the drafter recorded it was
 *  given. A step arriving as "  Send the reminder" would be written into
 *  `sop_text` with its padding by this side and trimmed away by the SQL side,
 *  and the accept would then refuse a perfectly correct draft — permanently,
 *  with the draft sitting in the workspace. */
function trimmedSteps(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * THE SOP TEXT A PROCEDURE PROPOSAL COMPOSES TO — the string sent to the
 * `playbook-draft` edge function, and this kind's CONSENTED LITERAL.
 *
 * ⚠ IT EXISTS TWICE, and the second copy is SQL, inside
 * decide_discovery_proposal's `procedure` branch (migration 752). That branch
 * re-composes this text from the payload and requires a `playbook_studies` row
 * whose `sop_text` matches it byte for byte, because `key` and `name` — the
 * other two things it checks — are both written by this browser, and a function
 * that verified only those would be verifying the caller's own claims.
 *
 * ⚠ AND THE DRIFT IS ASYMMETRIC, exactly as 751's pattern predicate is. The
 * ordering is: this gate runs, the browser DRAFTS (a model call and a real
 * row), and only then is the RPC called.
 *   · SQL looser than this — safe; the client refused first and drafted nothing.
 *   · SQL stricter than this — the draft exists, the stamp refuses, and every
 *     retry re-finds the same draft and re-refuses. Milder than 751's stuck
 *     guardrail (an inert draft, not a live blocking rule) but the same shape.
 * tests/discovery-proposal-batching.test.ts pins the two against each other.
 *
 * Deliberately dull: three fixed labels, one bullet per step, no conditional
 * shape. Every branch would be a way for the two copies to disagree.
 */
export function sopTextForProcedure(payload: Record<string, unknown>): string {
  const name = str(payload.name);
  const trigger = str(payload.trigger);
  const steps = trimmedSteps(payload.steps);
  if (!name || !trigger || steps.length === 0) return '';
  return `${name}\n\nRuns when: ${trigger}\n\nSteps:\n${steps.map((s) => `- ${s}`).join('\n')}`;
}

export interface ProcedureAcceptability {
  /** Can a draft be made from this payload today? */
  ok: boolean;
  /** The composed SOP text to send the drafter. '' when !ok. */
  sopText: string;
  /** The name the draft must carry, trimmed and verbatim. '' when !ok. */
  name: string;
  /** Why not, in a sentence for a business owner. '' when ok. */
  reason: string;
}

/** playbook-draft's own floor, restated where a person can be told about it
 *  before anything is spent:
 *    supabase/functions/playbook-draft/index.ts:364
 *    if (!recompileDefId && sopText.length < 40) return json({ error: … }, 400)
 *  and its ceiling, MAX_SOP_CHARS, which it applies by SLICING — so a longer
 *  text would be stored truncated and the byte-for-byte provenance check would
 *  never match. Refusing above it here is the strict-client direction, which is
 *  the safe one. */
const SOP_MIN_CHARS = 40;
const SOP_MAX_CHARS = 24_000;

/**
 * THE ONE GATE for a procedure — read by the card copy AND by the accept
 * writer, for the reason guardrailAcceptability's header gives: "what this
 * button will do" and "what the card says it will do" have to be one
 * expression rather than two that agree today.
 *
 * Everything it refuses, decide_discovery_proposal refuses too, in its own
 * words and onto `discovery_proposals.last_error` — so the reason is still on
 * the card tomorrow rather than only in this tab's React state.
 */
export function procedureAcceptability(payload: Record<string, unknown>): ProcedureAcceptability {
  const no = (reason: string): ProcedureAcceptability => ({ ok: false, sopText: '', name: '', reason });
  const name = str(payload.name);
  if (!name) {
    return no('This one does not say what the procedure is called yet, so there is nothing to draft it as.');
  }
  if (!str(payload.trigger)) {
    return no(`This one does not say when "${name}" should run, and that is the first thing a procedure needs.`);
  }
  if (trimmedSteps(payload.steps).length === 0) {
    return no(`This one has no steps written down for "${name}", so there is nothing to draft from.`);
  }
  const sopText = sopTextForProcedure(payload);
  if (sopText.length < SOP_MIN_CHARS) {
    return no(`There is not enough written down about "${name}" to draft from — a sentence or two more about what happens, and when, is enough.`);
  }
  if (sopText.length > SOP_MAX_CHARS) {
    return no(`What was recorded for "${name}" is longer than the drafter can take in one go. Shortening it to the essential steps will let this through.`);
  }
  return { ok: true, sopText, name, reason: '' };
}

/** Can this conversation_type payload become a real triage rule, and if not,
 *  why — in words a business owner can act on.
 *
 *  ⚠ ONE GATE, READ BY BOTH THE CARD AND THE WRITER, for the reason
 *  guardrailAcceptability's header gives: a copy that says "this will be set up"
 *  next to a writer that refuses is the disagreement §11b exists to prevent.
 *  acceptConversationTopicProposal calls this before it writes anything, and
 *  whatAcceptingWrites calls it to decide which sentence to print.
 *
 *  ⚠ THE SQL BRANCH IS THE STRICTER OF THE TWO AND THAT IS DELIBERATE — but
 *  ONLY where being stricter is free. On Path B the browser INSERTS the rule
 *  between the two gates, so a server stricter than this one would leave a live
 *  triage rule behind a proposal that reverts to pending and re-refuses forever
 *  — exactly the trap migration 751 documents for guardrails. So every
 *  predicate here mirrors the SQL one character for character: the token shape
 *  (^[a-z0-9]+(_[a-z0-9]+)*$, <= 40), the non-empty pattern, and the
 *  empty-alternative refusal. The rule_order band is NOT checked here because
 *  this side CHOOSES it rather than receiving it. */
export interface TopicAcceptability {
  ok: boolean;
  label: string;
  category: string;
  pattern: string;
  reason: string;
}
export function topicAcceptability(payload: Record<string, unknown>): TopicAcceptability {
  const label = str(payload.label);
  const category = str(payload.set_category);
  const pattern = str(payload.match_pattern);
  const no = (reason: string): TopicAcceptability => ({ ok: false, label, category, pattern, reason });

  if (!label) {
    return no('This one does not say what the topic is called, so there is nothing to show you in your triage rules.');
  }
  if (!category) {
    return no(`This one does not say what to file "${label}" conversations under, so nothing would be labelled.`);
  }
  if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(category) || category.length > 40) {
    return no(`We cannot file conversations under "${category}" — a topic you can sort and count by has to be plain lower-case words joined by underscores, like "delivery_delay".`);
  }
  // ⚠ A MISSING PATTERN IS A CATCH-ALL, NOT AN EMPTY RULE. classify_support_text
  // returns IMMEDIATELY on the first rule with no pattern; every workspace
  // already has exactly one of those, and a second would swallow the rest.
  if (!pattern) {
    return no(`This one has no words to look for, and a topic rule with no words catches every conversation rather than the ones about "${label}".`);
  }
  if (/(^\||\|\||\|$)/.test(pattern)) {
    return no(`The words to look for on this one — "${pattern}" — have a "|" with nothing beside it, so the card would be showing you a phrase that is never looked at.`);
  }
  return { ok: true, label, category, pattern, reason: '' };
}

// ── card copy ────────────────────────────────────────────────────────────

export interface ProposalCardCopy {
  title: string;
  /** One sentence of consequence — what accepting actually changes. */
  detail: string;
  /** The enforceable literal — the one fact §11b says a card cannot omit. */
  meta: string;
  /** "The one thing changeable later" — reduces the felt weight of a
   *  decision that IS in fact editable afterward, without pretending the
   *  decision itself is reversible before it's made. */
  nudge?: string;
}

/** The one function every card in the screen calls for its copy. Takes only
 *  data — kind + payload + an employee-name lookup for the ONE kind
 *  (trust_rule's de_ref) that references an employee by "archetype:<key>"
 *  rather than carrying a name of their own. ⚠ It was TWO until migration 754:
 *  conversation_type carried an `owner_ref` and the card rendered "Routes to:
 *  <name>". Nothing routes on a topic — de_conversations.de_id is stamped when
 *  the conversation row is inserted, before any message exists — so the field
 *  and the sentence are both gone rather than made optional.
 *
 *  ⚠ `context` IS THE CONSENT, AND IT IS ON THE CARD BECAUSE ACCEPT IS ON THE
 *  CARD. Until this parameter existed, the entire compliance-pack disclosure
 *  lived in whatAcceptingWrites, which renders ONLY inside the Details drawer —
 *  while Accept sat on the card face and fired with no confirmation at all. One
 *  click hired an employee and switched on two workspace-wide BLOCKING rules
 *  with the sentence never rendered on screen. §11b already requires this card
 *  to carry the systems the role will touch; rules that apply to EVERY employee
 *  in the workspace are not a smaller fact than that. Optional, because it
 *  arrives from an async lookup and the card must render before it does — and
 *  compliancePackCardClause SAYS "not checked yet" rather than treating
 *  not-yet-arrived as "there is none". */
export function cardCopyFor(
  kind: ProposalKind,
  payload: Record<string, unknown>,
  employeeNameByArchetype: ReadonlyMap<string, string>,
  context?: AcceptContext,
): ProposalCardCopy {
  const archetypeOf = (ref: string) => (ref.startsWith('archetype:') ? ref.slice('archetype:'.length) : ref);

  switch (kind) {
    // ⚠⚠ 754: FOUR SENTENCES WERE ON THIS CARD AND THREE OF THEM DESCRIBED
    // BEHAVIOUR THAT DOES NOT EXIST. Checked one at a time against live code:
    //
    //  1. "Conversations get tagged and routed under this topic from now on."
    //     TAGGED is true — trg_triage_support_conversation writes
    //     de_conversations.category from classify_support_text on the first user
    //     message. ROUTED IS FALSE. de_id is stamped when the conversation row
    //     is INSERTED (widget-ask/index.ts:338, email-inbound/index.ts:190),
    //     before any message exists, so the employee is chosen before the topic
    //     is known — and no reader of de_conversations.category selects an
    //     employee (enumerated 2026-08-17: three SQL functions name both and all
    //     three read action_definitions.category or group by channel; the client
    //     readers are four filters and a label).
    //  2. "Routes to: <employee>" — FALSE for the same reason, and worse,
    //     because it names a specific person the topic will supposedly reach.
    //     `owner_ref` is gone from the payload entirely (validatePayload, 754):
    //     a required field whose only job was to satisfy a promise the platform
    //     does not keep.
    //  3. "you can assign one when you publish" — FALSE TWICE. There is no
    //     publish step for a triage rule and no owner to assign.
    //  4. "You can rename or reassign this topic later." RENAME is true — the
    //     triage-rules editor has full CRUD. REASSIGN is not a thing.
    //
    // What replaces them is what the accept actually does, including the part
    // the customer would otherwise discover by surprise: this rule is consulted
    // AFTER the built-in categories. classify_support_text returns on the FIRST
    // match ordered by rule_order, the workspace's eleven baseline rules occupy
    // 10..100 and 9999, and an accepted topic is confined to 200..9998 — so
    // "someone is hurt" stays Safety even if the words also match a topic the
    // customer named. `rulesAhead` comes from the accept's own counter, so the
    // card and the audit line cannot drift.
    case 'conversation_type': {
      const label = str(payload.label) || 'New topic';
      const category = str(payload.set_category);
      const pattern = str(payload.match_pattern);
      return {
        title: `File "${label}" as its own conversation topic`,
        detail: 'Support conversations mentioning these words get labelled with this topic, so you can filter and count them. It does not change who answers them.',
        meta: pattern
          ? `Looks for: ${pattern.split('|').map((p) => p.trim()).filter(Boolean).join(' · ')}${category ? ` → filed as "${category}"` : ''}`
          : 'No words to look for yet',
        nudge: 'Runs after your built-in categories like Safety and Security, so those still win. You can rename it, change the words or remove it in Triage rules.',
      };
    }

    case 'connector': {
      const label = str(payload.label) || str(payload.provider_key) || 'this system';
      // Fix round 1 (review, Important): Task 1 emits reads as
      // "<category> records" (e.g. "erp_financials records") — a raw
      // category token, not English. humanizeConnectorTouch turns the
      // KNOWN-category cases into "ERP / Financials records" and degrades
      // any other underscored shape to Title Case rather than leaking
      // snake_case onto the card.
      const reads = strArray(payload.reads).map(humanizeConnectorTouch);
      const writes = strArray(payload.writes).map(humanizeConnectorTouch);
      const touches = [reads.length ? `reads ${reads.join(', ')}` : null, writes.length ? `writes ${writes.join(', ')}` : null]
        .filter(Boolean).join(', ');
      return {
        title: `Connect ${label}`,
        detail: 'We set it up ready to go — you still enter the credential yourself.',
        meta: `${label} · ${touches || 'nothing configured yet'}`,
        nudge: 'You can turn on more of what it can read or write once it is connected.',
      };
    }

    // ⚠ 752: FOUR CLAIMS WERE ON THIS CARD AND TWO OF THEM WERE NOT TRUE.
    // Checked one at a time against what the accept actually produces:
    //
    //  1. `Draft the "<name>" procedure` — WAS FALSE, and is true now only
    //     because the accept was built to make it so. playbook-draft:622 takes
    //     `compiled.name` — the COMPILING model's own title — in preference to
    //     what it was asked for, so the card named one procedure and the
    //     customer would have got one called something else. The writer now
    //     re-stamps the payload's name and the RPC refuses any row where it did
    //     not take.
    //  2. "nothing runs until you publish it" — TRUE, and measured rather than
    //     assumed. Every path that RUNS a definition filters on `published` —
    //     eight gates across five callers, enumerated in migration 752's header:
    //     playbook-execute:2428, :655 and :2952, de-work:215, de-mission:108,
    //     dispatch_due_triggers twice (the scheduler, which starts a run with
    //     nobody clicking) and emit_tenant_event. Three paths READ a definition
    //     without that filter — the Builder's preview, `validate`, and
    //     playbook-amend — and none of them runs one. This is the sentence the
    //     whole kind rests on and it holds end to end.
    //  3. `Trigger: <trigger>` — WAS MISLEADING, and this is the one the review
    //     of this card found. It read as a property of the thing being made.
    //     It is not: playbook-draft writes `trigger_type: 'manual'` on every
    //     draft it creates, so the customer's sentence survives only as PROSE
    //     inside the SOP text the compiler reads. Nothing schedules it and
    //     nothing fires it. It now says whose words they are and that setting
    //     the trigger is part of publishing — "when you said it should run",
    //     not "when it will run".
    //  4. "Every step is editable before you publish it" — TRUE but INCOMPLETE,
    //     and the missing half is the one a person would want. The steps on the
    //     draft are NOT the sentences on this card: playbook-draft compiles
    //     them into the engine's typed primitives with a model, and it may
    //     merge, split or reorder them. A card promising editable steps without
    //     saying a model wrote them invites someone to skim a draft they
    //     believe is a transcription of their own words.
    case 'procedure': {
      const gate = procedureAcceptability(payload);
      if (!gate.ok) {
        const name = str(payload.name);
        return {
          title: name ? `Draft the "${name}" procedure` : 'A procedure we could not draft yet',
          detail: `${gate.reason} Accepting it records that against this recommendation and leaves it here for you.`,
          meta: str(payload.trigger) ? `When you said it should run: ${str(payload.trigger)}` : 'Nothing recorded about when it runs',
          nudge: 'Nothing is created, and nothing is lost — it stays on this screen.',
        };
      }
      return {
        title: `Draft the "${gate.name}" procedure`,
        detail: 'We write it up as a draft you can read over. Nothing runs until you publish it.',
        meta: `When you said it should run: ${str(payload.trigger)}`,
        nudge: 'The steps are drafted from your words, not copied from them — read them over, change anything, and set the trigger when you publish.',
      };
    }

    case 'employee': {
      const name = str(payload.name) || 'This role';
      // M1 (2026-08-15 review): NOT humanizeSystem'd. Since BLOCKER 2 these
      // are finished display strings built from role_archetypes
      // .system_templates — label + reach — not category keys, and
      // title-casing them turned "Invoices (AR) (read/write)" into
      // "Invoices (AR) (Read/Write)".
      const systems = strArray(payload.systems);
      // §11b, and the reason this fix wave exists: PUT THE FACT ON THE CARD.
      // The note recorded under the topic that nominated this role is the
      // entire reason it is being offered rather than one of the other
      // fourteen. The mechanical gate can prove the fill model did not invent
      // those words; it CANNOT prove the role fits. The person reading the
      // note next to the job title is the only thing that can, so hiding it
      // behind the Details drawer would leave the judgement to the half of the
      // system that is admittedly incapable of making it. fit_reason leads the
      // detail line for the same reason: before this, every card from one
      // dimension carried the identical generic sentence.
      //
      // ⚠⚠ TWO THINGS THIS DELIBERATELY DOES NOT DO, both measured defects.
      //
      // 1. IT DOES NOT SAY "You told us". `coverage[dim].evidence` is written
      //    by the INTERVIEW model — its extraction prompt asks for "the
      //    concrete fact, YOUR OWN WORDS, under 300 characters" — so it is a
      //    paraphrase, not a transcription. Putting a machine's summary inside
      //    quotation marks and attributing it to the person reading the card
      //    is the strongest available version of "looks governed and is not",
      //    and it is worst precisely here, on the fact the design nominates as
      //    the backstop. "What we recorded under <topic>" is what actually
      //    happened, so that is what it says.
      //
      // 2. IT DOES NOT SHOW THE QUOTED SPAN ALONE. Nothing requires the span
      //    to preserve the meaning of the sentence it came from, and a
      //    substring can invert it. Measured, all three passed the gate:
      //      recorded: "we don't run Google Ads at all, it's all word of mouth"
      //      quoted:   "run Google Ads at all"           -> offers Google Ads
      //      recorded: "we never chase overdue invoices, the owner does it"
      //      quoted:   "chase overdue invoices"          -> offers Billing & AR
      //      recorded: "if we ever grow we might need someone on social, not now"
      //      quoted:   "need someone to manage social media" -> offers Social
      //    That survives a customer's judgement, because they recognise words
      //    they really did say and cannot see the "don't" that was cropped off.
      //    So the WHOLE recorded note goes on the card and the span is marked
      //    inside it. The backstop only works if the negation is still visible.
      const fit = str(payload.fit_reason);
      const quote = str(payload.evidence_quote);
      const sources = Array.isArray(payload.evidence_sources)
        ? (payload.evidence_sources as Array<Record<string, unknown>>)
        : [];
      // The source the span was taken from, if it can be identified; else the
      // first. Matching is a plain case-insensitive containment test — the
      // same relationship the gate enforced, not a second, looser one.
      const needle = quote.toLowerCase();
      const cited = sources.find((s) => str(s.evidence).toLowerCase().includes(needle)) ?? sources[0];
      const citedTopic = cited ? str(cited.title) : '';
      const citedNote = cited ? str(cited.evidence) : '';
      const heard = citedNote
        ? `What we recorded under ${citedTopic || 'this topic'}: ${citedNote}`
        : quote
          ? `What we recorded: ${quote}`
          : null;
      return {
        title: `Add ${name} to your team`,
        detail: (fit
          ? `${fit} Starts supervised, drafts everything, sends nothing until you say so.`
          : 'Comes with a published SOP. Starts supervised, drafts everything, sends nothing until you say so.')
          // ⚠ THE PACK CLAUSE IS PART OF THE CONSEQUENCE SENTENCE, not an
          // extra line. `detail` is "one sentence of consequence — what
          // accepting actually changes", and switching on blocking rules for
          // every employee in the workspace is the largest thing accepting this
          // card changes. It is deliberately SHORT here (the full sentence,
          // with what happens later and where to remove it, is
          // whatAcceptingWrites, which the drawer and the accept confirmation
          // both render) — §11b's card budget is one disclosure level, not no
          // disclosure.
          + compliancePackCardClause(context),
        meta: [
          heard,
          systems.length ? `Systems: ${systems.join(', ')}` : 'No systems requested yet.',
        ].filter(Boolean).join(' · '),
        nudge: 'You can add or remove systems any time after hiring.',
      };
    }

    case 'guardrail': {
      const rule = str(payload.rule) || 'New guardrail';
      // Fix round 1 (review, Critical 2): the old detail sentence
      // ("Anything matching this is blocked before it reaches a customer")
      // was hardcoded for every guardrail, but it is only true for a
      // PATTERN rule — findBlockingMatch (guardrailMatch.ts) is pattern-
      // only, and nothing in this codebase blocks outbound text on a bare
      // number.
      //
      // ⚠ AND THE SECOND HALF WAS STILL WRONG, until migration 751. "Above
      // this, it needs your approval before it goes ahead" described an
      // approval gate this product does not build from a discovery proposal —
      // and now actively REFUSES to. `detail` is "one sentence of consequence:
      // what accepting actually changes", and for a threshold guardrail the
      // honest answer is "nothing, and here is why". guardrailAcceptability is
      // the one gate; discoveryApi's accept writer reads the same function, so
      // the sentence on the card and the behaviour of the button behind it
      // cannot come apart.
      const gate = guardrailAcceptability(payload);
      return {
        title: rule,
        detail: gate.ok
          ? 'Anything matching this is blocked before it reaches a customer, for every employee in this workspace.'
          : `${gate.reason} Accepting it will say so and change nothing.`,
        // The literal stays on the card either way — §11b requires the
        // threshold be shown VERBATIM even though it is the reason we are
        // refusing, because "we could not act on this" is only checkable
        // against the thing we could not act on.
        meta: guardrailLiteral(payload),
        // ⚠ No nudge on the refused branch. "You can edit or remove this rule
        // later" describes a rule that will not exist.
        nudge: gate.ok ? 'You can remove this rule later in Compliance & Guardrails.' : undefined,
      };
    }

    case 'trust_rule': {
      const deRef = str(payload.de_ref);
      const employeeName = deRef ? employeeNameByArchetype.get(archetypeOf(deRef)) : undefined;
      const who = employeeName ?? 'This employee';
      const actionCategory = str(payload.action_category);
      const cap = formatCap(actionCategory, payload.cap);
      // §11b's own table lists "what happens above it" as part of the
      // CARD, not the drawer, for this one kind — trust_rule is explicitly
      // exempted from the short-card budget ("the only kind where no card
      // is short enough"). Fix round 1 (review minor): above_cap was
      // collected by the model fill and never shown anywhere — this is
      // where it belongs, verbatim, falling back to a generic sentence
      // only when the model didn't supply one.
      //
      // ⚠⚠ REWRITTEN BY MIGRATION 753, AND EVERY WORD OF THE OLD COPY WAS
      // FALSE ABOUT WHAT ACCEPTING DOES. It read:
      //
      //   title:  "Let <who> act on its own up to <cap>"
      //   detail: <above_cap> or "Above this, it stops and asks you first."
      //   nudge:  "You can lower or raise this cap later in Trust settings."
      //
      // Measured live 2026-08-17: 90 trust_policies rows across 17 tenants, 0
      // above level 0, 0 carrying a ladder — and `trust_ladder_settings`, the
      // only consumer of that column, returns {enabled:false} for any level <= 0
      // BEFORE it looks at a ladder at all. So nothing this accept writes lets
      // anybody act on their own, nothing stops anything above the number, and
      // the cap is not stored anywhere Trust settings would show it. Three
      // sentences, three claims, none of them true.
      //
      // ⚠ AND `above_cap` IS NOT A PROMISE. It is the customer's own description
      // of what they expect to happen above the limit, kept on the card because
      // §11b requires "what happens above it" to be VISIBLE — but it is
      // attributed rather than asserted, because nothing this accept writes
      // makes it happen. Rendering their sentence as the product's behaviour is
      // exactly the overclaim this file has already been rewritten twice to
      // remove.
      //
      // ⚠⚠ FIX ROUND 2 — THE REPLACEMENT COPY WAS FALSE TOO, IN THE OPPOSITE
      // DIRECTION, AND ON THIS KIND THAT IS THE WORSE ONE. It said "${who} still
      // brings everything to you" and "everything still comes to you for
      // approval". Those are claims about THE EMPLOYEE'S SUPERVISION, and this
      // accept does not control that. `de_autonomy` — the table every
      // enforcement path reads through resolve_de_autonomy — has SEVEN writers,
      // enumerated live from pg_proc on 2026-08-17:
      //   deprovision_starter_de_internal, instantiate_role_archetype_internal,
      //   provision_starter_de_internal, provision_workforce_assistant_internal,
      //   retire_digital_employee, set_de_autonomy, trust_apply_level
      // and only the LAST is downstream of a trust level. An archetype carrying
      // `autonomy_templates` has its dials written AT HIRE by
      // instantiate_role_archetype_internal, before any trust card renders:
      // `renewal_manager` carries [{action_type:'action_execute',
      // source_category:'crm', enabled:true}], measured live.
      // Corroborated on live rows, outside any transaction: the Renewal DE
      // (40d688eb…, tenant 5bb802e1…) has max current_level 0 across its trust
      // policies AND digital_employees.trust_level = 'supervised', and
      // resolve_de_autonomy(tenant,'action_execute',de,'crm').enabled is TRUE
      // today. So "level 0" says NOTHING about supervision, and the supervised
      // badge does not rescue the sentence either.
      //
      // 751's defect was copy that OVERCLAIMED enforcement. This was copy that
      // UNDERCLAIMED autonomy the employee already had — on the one kind whose
      // entire purpose is oversight, which is the worse direction. So the copy
      // below says ONLY what the accept controls: the limit is recorded, the
      // trust setting it opens sits at level 0, and level 0 of the ladder is
      // off. Nothing about what else this employee may already be allowed to do.
      // tests/discovery-proposal-batching.test.ts pins the absent claim.
      const aboveCap = str(payload.above_cap);
      // ⚠ FIX ROUND 3 (a): THE CARD MUST NOT PROMISE TO RECORD WHAT THE SERVER
      // WILL REFUSE. 753's branch refuses a confidence cap over 100 —
      // `if v_tr_unit = 'confidence' and v_tr_cap_n::numeric > 100 then raise`
      // — because validate_trust_ladder admits 0-100 and "500% confidence" is
      // consent to a setting that cannot exist. Without this arm the card
      // rendered "Note Sam's limit for this: 500% confidence" beside "this
      // records the limit you stated", and the accept then refused: a sentence
      // that is false for that payload, which is the standard this file holds
      // itself to everywhere else (guardrailAcceptability does exactly this).
      //
      // ⚠ THE BOUND IS DUPLICATED AND MUST NOT DRIFT. `> 100`, and the
      // confidence/dollar split is formatCap's own (answer_dock and
      // answer_widget confidence-gate; everything else dollar-gates) so there
      // is ONE definition of the unit on this side, not two. The SQL is the
      // authority: this arm only decides what the card SAYS, never what gets
      // written — nothing is written from the browser on this kind at all
      // (Path A), so a drift here can mislead a reader but can never create a
      // row the server would have refused.
      const capN = numericLiteral(payload.cap);
      const capUnacceptable = (actionCategory === 'answer_dock' || actionCategory === 'answer_widget')
        && capN !== null && capN > 100;
      if (capUnacceptable) {
        return {
          title: `Check ${who}’s limit for this: ${cap}`,
          detail: `This one cannot be recorded as written. Confidence runs from 0 to 100, so ${cap} is not a setting that could ever exist — accepting it will say so and record nothing. Nothing changes either way.`
            + (aboveCap ? ` You said: “${aboveCap}”` : ''),
          meta: `${who} · ${humanizeToken(actionCategory) || 'unnamed category'} · ${cap} · cannot be recorded`,
          nudge: `Re-run this part of the interview, or set the limit yourself under ${who}’s Trust settings.`,
        };
      }
      return {
        title: `Note ${who}’s limit for this: ${cap}`,
        // ⚠ FIX ROUND 3 (b): "recorded ALONGSIDE", not "recorded against". The
        // accept deliberately writes NO limit into the trust setting — the
        // drawer says so in as many words — and "the trust setting it is
        // recorded against" reads as though the number lives there. Paired
        // with the nudge pointing at Trust settings, where 753's header says
        // the cap is NOT surfaced, a reader would go looking for their $500
        // on a screen that does not show it.
        //
        // ⚠ FIX ROUND 3 (c): THE DAILY TIMER IS ON THE CARD FACE NOW, not only
        // in the drawer. `needsAcceptConfirmation` is employee-only, so Accept
        // on this card calls runDecision directly — the drawer is optional
        // reading for a decision one click away, which is the exact defect
        // this file already names and fixed once for the employee kind. §11b
        // exempts trust_rule from the short-card budget ("the only kind where
        // no card is short enough"), so there is room. It is a real
        // consequence of accepting: the policy row this opens is what
        // detect_trust_widening_patterns lateral-joins, and
        // de-governance-sweep-daily runs 45 6 * * *. A human still approves.
        detail: `Nothing changes today — this records the limit you stated and switches nothing on. The number is kept alongside this recommendation and in your audit trail, not written into the setting. The trust setting it opens sits at level 0 of ${who}’s trust ladder, and level 0 is off: the ladder grants nothing there. Moving it off level 0 is a separate, deliberate decision — one you make, or one you approve when this workspace asks: from now on a daily check can put a promotion for this employee in front of you once it has built up a record.`
          + (aboveCap ? ` You said: “${aboveCap}”` : ''),
        meta: `${who} · ${humanizeToken(actionCategory) || 'unnamed category'} · ${cap} · nothing changes today`,
        // ⚠ "the setting", not "this". The antecedent of "this" was the CAP in
        // the title, and the cap is exactly what Trust settings does not yet
        // show next to the ladder editor — migration 753's header says so out
        // loud under "WHAT IS NOT SHIPPED HERE". The success flash already said
        // "the setting"; this is the same word.
        nudge: `You’ll find the setting under ${who}’s Trust settings, at level 0 — off, and granting nothing while it stays there.`,
      };
    }
  }
}

/** A compliance pack an employee proposal's archetype would switch on.
 *
 *  `rule_count` is the number of BLOCKING rules in the shared catalogue for
 *  that pack; `already_attached` is whether this workspace already holds it,
 *  which is the difference between "accepting adds two blocking rules" and
 *  "accepting adds none, they are already on". */
export interface AcceptCompliancePack {
  pack_key: string;
  name: string;
  rule_count: number;
  already_attached: boolean;
}

/** Facts the drawer knows that the proposal payload does not carry. Optional
 *  by construction: the page loads them asynchronously, and a card must be able
 *  to render before they arrive — but see compliancePackSentence for why
 *  "haven't arrived" is SAID rather than rendered as "there are none". */
export interface AcceptContext {
  /** 'employee' only. `undefined` means NOT YET ESTABLISHED. An empty array
   *  means established and there are none — a distinction this file already
   *  pays for elsewhere (`?? 0` on systems_installed manufactures a fact). */
  compliancePacks?: readonly AcceptCompliancePack[];
}

/** ⚠ THE SENTENCE THE HIRE NEVER SAID.
 *
 *  instantiate_role_archetype auto-attaches its archetype's mandatory
 *  compliance packs, which materialise as guardrail_rules with
 *  applies_to='all' and severity='blocking' — WORKSPACE-WIDE controls on every
 *  employee, not just the one being hired. Measured 2026-08-16: 7 of 15 active
 *  archetypes carry one. None of that appeared on the card, in a counter, or in
 *  the audit detail, so a customer accepted blocking rules they were never
 *  shown. That is the same §11b principle the guardrail card already follows:
 *  you cannot consent to a rule nobody told you about.
 *
 *  Three branches, and the first one is the point:
 *   · undefined       — not established yet. SAID, never silently treated as
 *                       "none": a card that stays quiet about a pack it simply
 *                       hasn't looked up reads exactly like a card confirming
 *                       there is no pack.
 *   · [] or all known — established, nothing to add.
 *   · already on      — the pack exists here already, so accepting adds NO new
 *                       blocking rules. Claiming two would be the overclaim
 *                       this function was rewritten once already to remove. */
function compliancePackSentence(context?: AcceptContext): string {
  const packs = context?.compliancePacks;
  if (packs === undefined) return ' Whether this role also switches on a compliance pack has not been checked yet.';
  if (packs.length === 0) return ' It switches on no compliance pack, so no new workspace-wide rules.';

  const names = packs.map((p) => p.name || p.pack_key).join(' and ');
  const fresh = packs.filter((p) => !p.already_attached);
  const newRules = fresh.reduce((n, p) => n + p.rule_count, 0);

  if (fresh.length === 0 || newRules === 0) {
    return ` It also requires the ${names} compliance pack, which this workspace already has on — so accepting adds no new blocking rules.`;
  }
  return ` It also switches on the ${names} compliance pack: ${newRules} blocking rule${newRules === 1 ? '' : 's'} that appl${newRules === 1 ? 'ies' : 'y'} to every employee in this workspace, not just this one. You can take the pack off later in Compliance & Guardrails.`;
}

/** ⚠ THE SAME FACT, CARD-SIZED. compliancePackSentence is the full disclosure
 *  and belongs where there is room for it — the Details drawer and the accept
 *  confirmation. This is the clause that goes on the card face, next to the
 *  button that fires, because that is where the decision is taken.
 *
 *  Four branches, and two of them are silence-with-a-reason:
 *   · undefined  — not established. SAID. A card that is quiet about a pack it
 *                  simply has not looked up reads exactly like a card
 *                  confirming there is no pack, and the two are opposite facts.
 *   · []         — established, there is none. SILENT, deliberately: nothing
 *                  happened, and a card that narrates non-events is a card
 *                  nobody finishes reading. The undefined branch above is what
 *                  keeps this silence honest.
 *   · already on — named, with the fact that accepting adds nothing. Claiming
 *                  new blocking rules here would be the overclaim this file
 *                  refuses everywhere else.
 *   · fresh      — named, counted, and scoped: EVERY employee, not just this
 *                  one. That last word is the whole disclosure. */
export function compliancePackCardClause(context?: AcceptContext): string {
  const packs = context?.compliancePacks;
  if (packs === undefined) return ' Whether it also switches on a compliance pack has not been checked yet.';
  if (packs.length === 0) return '';

  const names = packs.map((p) => p.name || p.pack_key).join(' and ');
  const fresh = packs.filter((p) => !p.already_attached);
  const newRules = fresh.reduce((n, p) => n + p.rule_count, 0);

  if (fresh.length === 0 || newRules === 0) {
    return ` Needs the ${names} compliance pack, which this workspace already has on.`;
  }
  return ` It also switches on the ${names} compliance pack — ${newRules} blocking rule${newRules === 1 ? '' : 's'} that appl${newRules === 1 ? 'ies' : 'y'} to every employee in this workspace, not just this one.`;
}

/** Does accepting THIS proposal need a confirmation step before it fires?
 *
 *  ⚠ THE ARGUMENT FOR HAVING ONE AT ALL. Decline and Park already collect a
 *  sentence in a modal; Accept — the only one of the three that creates an
 *  employee AND switches on workspace-wide blocking rules, and the only one
 *  that cannot be undone from this screen — had none. That asymmetry is
 *  backwards. The card clause makes the deck honest at a glance; a confirm is
 *  what makes the irreversible half deliberate, and the two do different jobs.
 *
 *  ⚠ AND THE ARGUMENT FOR NOT HAVING ONE ALWAYS, which matters just as much: a
 *  confirmation on every accept is trained away inside a week, and then it is
 *  worse than nothing because it looks like a control. This returns true ONLY
 *  when there is something the customer has not already got — a pack this
 *  workspace does not hold, carrying at least one rule — or when we could not
 *  establish whether there is (undefined), because "we did not check" is not a
 *  reason to skip the step. A second finance hire into a workspace that already
 *  has financial_controls attaches nothing new and goes straight through. */
export function needsAcceptConfirmation(kind: ProposalKind, context?: AcceptContext): boolean {
  if (kind !== 'employee') return false;
  const packs = context?.compliancePacks;
  if (packs === undefined) return true;
  return packs.some((p) => !p.already_attached && p.rule_count > 0);
}

/** What accepting a proposal of this kind actually creates — the Drawer's
 *  "what accepting writes" line, and the body of the accept confirmation.
 *  Deliberately plain, not a repeat of the card's own detail sentence.
 *
 *  `payload` is required (fix round 1, Critical 2): the old single-string
 *  version claimed "Creates an ENFORCED guardrail rule with this exact
 *  pattern OR threshold" for every guardrail — the same overclaim as the
 *  card's detail sentence, and false for the same reason: a threshold-only
 *  guardrail is an approval gate, never something findBlockingMatch
 *  enforces. Every other kind's sentence is unconditional on payload
 *  content, so this parameter is unused for them — kept required anyway so
 *  a future kind that DOES need to branch can't be added without a payload
 *  already in scope. */
export function whatAcceptingWrites(
  kind: ProposalKind,
  payload: Record<string, unknown>,
  context?: AcceptContext,
): string {
  switch (kind) {
    case 'employee': return `Creates a digital employee — draft, supervised — with its SOP and requested systems attached.${compliancePackSentence(context)}`;
    case 'connector': return 'Creates a connector record for this system, waiting on your credential.';
    // ⚠ 752: this said "Creates a draft procedure definition. It will not run
    // until you publish it." Both halves are true and it left out the two facts
    // a person would actually want before pressing the button: that a MODEL
    // writes the draft (this is the only accept on this screen that spends the
    // workspace's AI budget), and where the thing it makes turns up. The
    // sentence a drawer shows before a button fires has to be the sentence that
    // turns out to be true — and "creates a definition" is not the whole of
    // what happens here.
    case 'procedure': {
      const gate = procedureAcceptability(payload);
      if (!gate.ok) {
        return `Creates nothing. ${gate.reason} Accepting it records that reason against this recommendation and leaves it here for you.`;
      }
      return 'Sends what you described to the drafter, which writes it up as a DRAFT procedure under Playbooks — a model does the writing, so this uses some of your AI budget. Nothing runs it: a draft is not published, and only publishing makes it live. You can read it, change it, or archive it.';
    }
    // ⚠ 754: this read "Adds this as a routable conversation topic." It added
    // NOTHING — there was no writer at all until migration 754 — and "routable"
    // was false besides. Now it adds a real row and the sentence says which one,
    // what looks at it, and the two things it does not do.
    case 'conversation_type': {
      const gate = topicAcceptability(payload);
      if (!gate.ok) {
        return `Creates nothing. ${gate.reason} Accepting it records that reason against this recommendation and leaves it here for you.`;
      }
      return `Adds a triage rule under Support › Triage rules. From then on, a support conversation whose first message contains any of those words is labelled "${gate.category}", which is what the inbox topic filter and the History report count by. It does NOT decide who answers — the digital employee is chosen when the conversation starts, before the first message arrives — and it is consulted AFTER your built-in categories, so Safety, Security and the rest still win where the words overlap. You can edit or delete it there at any time.`;
    }
    case 'guardrail': {
      // ⚠ 751: the threshold branch used to say "Creates a guardrail that
      // requires your approval above this threshold". It creates NOTHING —
      // decide_discovery_proposal refuses it, in words, and leaves the card
      // where it is. Two measured reasons, both in that migration's header: the
      // number has no unit (require_approval_over_cents reads CENTS,
      // max_discount_pct reads PERCENT, and a payload that carries neither
      // makes "10,000" a hundred-fold guess), and max_discount_pct has no
      // enforcement path at all — its only readers interpolate it into a
      // prompt. The sentence a drawer shows before a button fires has to be the
      // sentence that turns out to be true.
      const gate = guardrailAcceptability(payload);
      if (gate.ok) return 'Adds a blocking rule to this workspace: anything matching this pattern is withheld before it reaches a customer, for every employee, not just one. You can take it off again in Compliance & Guardrails.';
      return `Creates nothing. ${gate.reason} Accepting it records that reason against this recommendation and leaves it here for you.`;
    }
    // ⚠ 753: this said "Creates or raises this employee's trust policy, up to
    // the stated cap." Two false halves. It RAISES nothing — the accept refuses
    // outright if the policy is already above level 0 — and "up to the stated
    // cap" describes a limit the policy row does not store and nothing enforces.
    // The sentence a drawer shows before a button fires has to be the sentence
    // that turns out to be true, and this one is the whole of what happens.
    //
    // ⚠⚠ FIX ROUND 2, TWO CORRECTIONS, both for sentences that were false about
    // things OUTSIDE this accept:
    //  · "which is where it already effectively sits: everything it does still
    //    comes to you for approval" — a claim about the employee's supervision
    //    that level 0 does not support. de_autonomy has seven writers and only
    //    trust_apply_level is downstream of a trust level; an archetype with
    //    `autonomy_templates` has an ENABLED dial written at hire. See the
    //    enumeration and the live corroboration on the card copy above.
    //  · "Making it live is a separate decision you take later in Trust
    //    settings" named only ONE of the two routes off level 0. The other is a
    //    trust promotion, and it can arrive without the customer asking for it:
    //    detect_trust_widening_patterns -> raise_trust_widening_proposals ->
    //    de_governance_sweep_internal, on cron `de-governance-sweep-daily`
    //    (45 6 * * *, active) — which INSERTs a pending trust_promotion task.
    //    A human still decides it, so the sentence stays "a separate decision",
    //    but it is not one the customer necessarily starts.
    case 'trust_rule': return 'Opens this employee’s trust setting for this kind of work at level 0 — or finds the one already sitting there — and level 0 is the level at which the trust ladder is off and grants nothing. It writes NO limit into that setting, on purpose: the number you agreed to is recorded against this recommendation and in your audit trail, not switched on. Making it live is a separate decision either way: you set the ladder yourself under Trust settings, or you approve a trust promotion — which needs its own evidence and its own approval, and which this workspace can put in front of you on its own once this employee has built up a record. Accepting this changes nothing about what this employee is allowed to do today.';
  }
}

/** THE structural gate for the page's three section renderers (fix round 1,
 *  Important — "batching is structural for the value, conventional for the
 *  wiring"). Before this, batchModeFor(kind) was correct, but nothing
 *  stopped a renderer from being CALLED with the wrong kind — a single
 *  mis-typed `renderAcceptAllSection('guardrail')` would have rendered a
 *  guardrail inside a bulk-accept batch with every existing test still
 *  green, because batchModeFor itself was never wrong; it was just never
 *  consulted at the render call site.
 *
 *  Every renderer must fetch its items through THIS function, never by
 *  filtering `proposals` directly — when `mode` does not match the kind's
 *  real batchModeFor, it returns an EMPTY array regardless of what `items`
 *  contains, so the mis-wired call renders nothing rather than the wrong
 *  thing. tests/discovery-proposal-batching.test.ts proves the exact
 *  scenario the review named: `itemsForBatchMode('guardrail', 'accept_all',
 *  <real guardrail items>)` must return `[]`. */
export function itemsForBatchMode<T extends { kind: ProposalKind }>(
  kind: ProposalKind,
  mode: BatchMode,
  items: readonly T[],
): readonly T[] {
  if (batchModeFor(kind) !== mode) return [];
  return items.filter((i) => i.kind === kind);
}

/** §11b requirement 4: a trust_rule proposal may not be decided before the
 *  employee it names has actually been accepted — set_trust_ladder raises
 *  an EXISTING trust_policies row, and nothing in the hire path creates one
 *  ahead of acceptance (progress.md's ordering-constraint note; live
 *  measured 66 of 107 employees carry none). Returns null when the trust
 *  rule is decidable right now; otherwise the exact reason to show, never a
 *  hidden card.
 *
 *  Three distinguishable outcomes, not two — the difference between "you
 *  haven't said yes yet" and "nobody proposed this employee at all" is real
 *  information for whoever's reading the card. */
export function trustRuleBlockReason(
  deRef: string,
  employeeProposals: readonly { payload: Record<string, unknown>; state: string }[],
): string | null {
  const key = deRef.startsWith('archetype:') ? deRef.slice('archetype:'.length) : deRef;
  const match = employeeProposals.find((e) => str(e.payload.archetype_key) === key);
  if (!match) {
    return `Blocked — no employee matching "${key || deRef}" was proposed this session.`;
  }
  if (match.state === 'accepted') return null;
  const name = str(match.payload.name) || key;
  return `Blocked until you accept ${name} — a trust rule cannot exist without the employee it governs.`;
}
