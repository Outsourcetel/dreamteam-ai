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
 *  formatBareNumber's header). This is a closed inference, not a guess:
 *  public.guardrail_rules.rule_type (src/lib/guardrailApi.ts) has exactly
 *  four values, and the two that carry a threshold at all
 *  (require_approval_over_cents, max_discount_pct) are BOTH approval gates —
 *  there is no threshold-bearing BLOCKING rule_type in the whole union. So
 *  "this payload has a valid threshold and no valid pattern" reliably means
 *  "approval gate", regardless of which specific rule_type Task 3 eventually
 *  assigns it. findBlockingMatch (supabase/functions/_shared/
 *  guardrailMatch.ts) is pattern-only — nothing in this codebase blocks
 *  outbound text on a bare number. */
export type GuardrailKind = 'pattern' | 'threshold' | 'none';
export function guardrailKindOf(payload: Record<string, unknown>): GuardrailKind {
  const patternRaw = str(payload.pattern);
  if (patternRaw && looksLikeEnforceablePattern(patternRaw)) return 'pattern';
  if (isNumericLiteral(payload.threshold)) return 'threshold';
  return 'none';
}

/** guardrail's enforceable literal, verbatim per §11b — but "verbatim" means
 *  exactly what's on the payload, never a unit invented to make it read
 *  nicer. A pattern renders as "matches: X" ONLY when it re-passes
 *  looksLikeEnforceablePattern here (Task 1's validatePayload does not null
 *  out a prose pattern sitting beside a valid threshold — see the header
 *  above). A threshold renders as a bare, grouped number with no currency
 *  or percent sign, because the payload carries no unit to be honest about. */
export function guardrailLiteral(payload: Record<string, unknown>): string {
  switch (guardrailKindOf(payload)) {
    case 'pattern': return `matches: ${str(payload.pattern)}`;
    case 'threshold': return `threshold: ${formatBareNumber(payload.threshold)}`;
    case 'none': return 'no literal recorded yet';
  }
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
 *  data — kind + payload + an employee-name lookup for the two kinds
 *  (conversation_type's owner_ref, trust_rule's de_ref) that reference an
 *  employee by "archetype:<key>" rather than carrying a name of their own.
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
    case 'conversation_type': {
      const label = str(payload.label) || 'New topic';
      const ownerRef = str(payload.owner_ref);
      const ownerName = ownerRef && ownerRef !== 'unassigned' ? employeeNameByArchetype.get(archetypeOf(ownerRef)) : undefined;
      return {
        title: `Track "${label}" as a conversation topic`,
        detail: 'Conversations get tagged and routed under this topic from now on.',
        meta: ownerName ? `Routes to: ${ownerName}` : 'No owner yet — you can assign one when you publish.',
        nudge: 'You can rename or reassign this topic later.',
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

    case 'procedure': {
      const name = str(payload.name) || 'this procedure';
      const trigger = str(payload.trigger) || 'a trigger you will confirm';
      return {
        title: `Draft the "${name}" procedure`,
        detail: 'This becomes a draft — nothing runs until you publish it.',
        meta: `Trigger: ${trigger}`,
        nudge: 'Every step is editable before you publish it.',
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
      // number. A threshold-only guardrail is an approval gate, not a
      // block — guardrailKindOf's own header explains why that's a safe
      // inference even without a rule_type field on the payload.
      const kindOfRule = guardrailKindOf(payload);
      const detail = kindOfRule === 'pattern'
        ? 'Anything matching this is blocked before it reaches a customer.'
        : kindOfRule === 'threshold'
          ? 'Above this, it needs your approval before it goes ahead.'
          : 'This guardrail has no enforceable literal yet.';
      return {
        title: rule,
        detail,
        meta: guardrailLiteral(payload),
        nudge: 'You can edit or remove this rule later in Governance.',
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
      const aboveCap = str(payload.above_cap);
      return {
        title: `Let ${who} act on its own up to ${cap}`,
        detail: aboveCap || 'Above this, it stops and asks you first.',
        meta: `${who} · ${humanizeToken(actionCategory) || 'unnamed category'} · up to ${cap}`,
        nudge: 'You can lower or raise this cap later in Trust settings.',
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
    case 'procedure': return 'Creates a draft procedure definition. It will not run until you publish it.';
    case 'conversation_type': return 'Adds this as a routable conversation topic.';
    case 'guardrail': {
      const kindOfRule = guardrailKindOf(payload);
      if (kindOfRule === 'pattern') return 'Creates a guardrail that blocks anything matching this pattern before it reaches a customer.';
      if (kindOfRule === 'threshold') return 'Creates a guardrail that requires your approval above this threshold — nothing about it stops a message from going out.';
      return 'Creates a guardrail rule — it has no enforceable literal yet, so it will not do anything until one is added.';
    }
    case 'trust_rule': return 'Creates or raises this employee’s trust policy, up to the stated cap.';
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
