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

/** A connector category ("erp_financials") to the same short label
 *  src/lib/categoryContracts.ts's CATEGORY_SHORT already uses elsewhere in
 *  the app — duplicated here (not imported) to keep this module's only
 *  dependency being plain data, no risk of pulling in anything with I/O.
 *  Falls back to humanizeToken for anything outside the known set (an
 *  employee's required_connector_categories can legitimately name a
 *  provider-specific category this table doesn't know about). */
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
  if (CATEGORY_SHORT_LOCAL[firstWord]) return `${CATEGORY_SHORT_LOCAL[firstWord]}${rest}`;
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
 *  employee by "archetype:<key>" rather than carrying a name of their own. */
export function cardCopyFor(
  kind: ProposalKind,
  payload: Record<string, unknown>,
  employeeNameByArchetype: ReadonlyMap<string, string>,
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
      const systems = strArray(payload.systems).map(humanizeSystem);
      return {
        title: `Add ${name} to your team`,
        detail: 'Comes with a published SOP. Starts supervised, drafts everything, sends nothing until you say so.',
        meta: systems.length ? `Systems: ${systems.join(', ')}` : 'No systems requested yet.',
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

/** What accepting a proposal of this kind actually creates — the Drawer's
 *  "what accepting writes" line. Deliberately plain, not a repeat of the
 *  card's own detail sentence.
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
export function whatAcceptingWrites(kind: ProposalKind, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'employee': return 'Creates a digital employee — draft, supervised — with its SOP and requested systems attached.';
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
