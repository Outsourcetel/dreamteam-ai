// trustPromotionPresentation.ts — pure card copy for the trust-promotion
// review surface (.superpowers/sdd/2026-08-21-trust-promotion, Task 6: "the
// evidence is on the card, and thin evidence says so").
//
// PURE ON PURPOSE, same discipline as src/lib/discoveryProposalPresentation.ts:
// no supabase import, no I/O — the thin-evidence rule is provable with a unit
// test (tests/trust-promotion.test.ts), not just readable in a 1600-line page
// component. Ladder-level fallback names are re-declared rather than imported
// from trustApi.ts for the same reason that file gives for its own
// re-declarations — kept in sync by hand; four labels is a small mirror.
//
// ── THE DEFECT THIS FIXES ───────────────────────────────────────────────────
// trust_evidence_for's (migration 819) `human_approval_rate` criterion computes
// its RATE over (decided reviews + corroborated refusals — plus corroborated
// successes once migration 832 applies), but its DETAIL TEXT only ever speaks
// of decided reviews. A policy with real corroborated evidence and zero
// decided-by-a-human reviews therefore reads "no reviews decided" beside a
// non-zero rate. 832's own header names this and rules it stays unfixed at
// the source: "the spec's answer is to correct the LABEL where it surfaces to
// a customer, which is Task 6's surface, not a second redefinition here." This
// module is that surface. The counter (819/832) is untouched.
//
// ── THIN EVIDENCE IS RAISED, NOT SUPPRESSED ─────────────────────────────────
// Founder ruling, 2026-08-21 (migration 828's own header): an eligible policy
// raises a promotion request even with NO approved-action history, and the
// request must carry how thin the evidence is. This module's job is never to
// hide a no-history request — only to say plainly that it is one.
//
// ── WHAT "THIN" MEANS HERE ──────────────────────────────────────────────────
// Zero on every source that can back a promotion: no corroborated success
// (mig 832), no corroborated refusal (mig 819), and no human-decided review.
// The decided-human count is NOT a top-level key on the evidence payload — the
// live `trust_evidence_for` return only ever carries it inside `criteria[]`
// under key 'human_samples', and that figure already SUMS decided reviews with
// corroborated refusals (and successes, post-832) — see 819/832's own SQL.
// Subtracting the two corroborated counts back out below is what keeps a
// policy with one corroborated refusal and zero decided reviews from being
// counted as "two pieces of evidence" instead of one.
//
// ── A CAUTION CARRIED INTO THIS COPY ────────────────────────────────────────
// A review of the corroborated-success counter (migration 832 fix round 1)
// found it could be inflated by a verification that verified nothing before
// that fix landed. This module states COUNTS, never a confidence claim about
// them — "N corroborated successes", not "N proven successes" or "strong
// evidence". Describe what was counted, not how trustworthy it is.

export interface TrustPromotionCriterion {
  key: string;
  actual: number;
  required: number;
  met: boolean;
  label?: string;
  detail?: string;
}

export interface TrustPromotionEvidence {
  /** Migration 832, not applied everywhere yet — absent (not zero) until it
   *  is. Never assumed present. */
  corroborated_successes?: number;
  /** Migration 819. */
  corroborated_refusals?: number;
  /** Migration 815 — reviews sitting undecided, no verdict either way. Not
   *  evidence for or against; it is why a sample size might still be low. */
  pending_reviews?: number;
  criteria: TrustPromotionCriterion[];
  /** The server's own eligibility verdict, when the caller has it. Display
   *  only — this module never re-derives eligibility. */
  eligible?: boolean;
}

/** A manager-authored ladder level (mirrors trustApi.ts's TrustLadderLevel,
 *  re-declared rather than imported — see the file header). */
export interface TrustPromotionLadderLevel {
  level: number;
  name: string;
  mode: string;
}

export interface TrustPromotionCardInput {
  employeeName: string;
  /** The policy's action_category, e.g. 'action_execute'. Never branched on
   *  by value — only ever formatted for display. */
  category: string;
  currentLevel: number;
  targetLevel: number;
  evidence: TrustPromotionEvidence;
  /** The policy's own ladder, when it has a custom one. null/absent means the
   *  engine's built-in level rewards — this module does not know those (they
   *  are policy-live knowledge, not presentation knowledge), so it names the
   *  level generically instead of guessing at settings it cannot see. */
  ladder?: TrustPromotionLadderLevel[] | null;
}

export interface TrustPromotionCardCopy {
  title: string;
  detail: string;
  meta: string;
}

/** trust_policies.pending_evidence is a jsonb snapshot taken when a promotion
 *  request was raised — but its SHAPE depends on which already-shipped writer
 *  raised it:
 *    - request_trust_promotion (migration 025 — the "Request promotion"
 *      button on an employee's file) stores trust_evidence_for()'s return
 *      value directly: criteria, eligible, the corroborated_ counts and
 *      pending_reviews all sit at the TOP level.
 *    - raise_trust_widening_proposals (migration 710 — the repeated-approval
 *      pattern detector) wraps it: {dial, pattern, policy_evidence}, with the
 *      same trust_evidence_for()-shaped object nested under policy_evidence.
 *  Verified against the one trust_promotion request live in production on
 *  2026-08-21 — it is the pattern-wrapped shape. Reading only the flat shape
 *  would not error here; it would silently find no top-level `criteria` and
 *  render that request as having no evidence behind it at all, which is
 *  exactly the defect this task exists to fix, just relocated to this reader.
 *  Returns null for anything that is neither — absence renders as absence
 *  (the call site's job), never as a guessed-at zero. */
export function extractPolicyEvidence(pendingEvidence: unknown): TrustPromotionEvidence | null {
  if (!pendingEvidence || typeof pendingEvidence !== 'object') return null;
  const top = pendingEvidence as Record<string, unknown>;
  const flat = Array.isArray(top.criteria) ? top
    : (top.policy_evidence && typeof top.policy_evidence === 'object')
      ? top.policy_evidence as Record<string, unknown>
      : null;
  if (!flat || !Array.isArray(flat.criteria)) return null;
  return {
    corroborated_successes: typeof flat.corroborated_successes === 'number' ? flat.corroborated_successes : undefined,
    corroborated_refusals: typeof flat.corroborated_refusals === 'number' ? flat.corroborated_refusals : undefined,
    pending_reviews: typeof flat.pending_reviews === 'number' ? flat.pending_reviews : undefined,
    criteria: flat.criteria as TrustPromotionCriterion[],
    eligible: typeof flat.eligible === 'boolean' ? flat.eligible : undefined,
  };
}

// Legacy level names (trustApi.ts's TRUST_LEVEL_LABELS) — level 0 is always
// the implicit human-gated floor and is never itself a stored ladder entry.
const LEVEL_FALLBACK = ['Human-gated', 'Level 1', 'Level 2', 'Level 3'];

// Plain-language mirror of trustApi.ts's TRUST_LADDER_MODE_LABELS, phrased as
// what the step GRANTS rather than as a settings-editor option label.
const MODE_GRANT: Record<string, string> = {
  draft: 'still drafts for a human to approve',
  act_with_approval: 'prepares the action — a person confirms first',
  act_within_limits: 'acts on its own, within limits',
  act: 'acts on its own',
};

function levelName(ladder: TrustPromotionLadderLevel[] | null | undefined, level: number): string {
  const entry = ladder?.find(e => e.level === level);
  const name = entry?.name?.trim();
  return name || LEVEL_FALLBACK[level] || `Level ${level}`;
}

/** "What the step grants" — the target level's name plus, when a custom
 *  ladder names its mode, a plain-language clause for what that mode allows.
 *  Falls back to the level name alone when nothing more specific is knowable
 *  (the common case today: most live policies carry no custom ladder). */
function whatItGrants(ladder: TrustPromotionLadderLevel[] | null | undefined, targetLevel: number): string {
  const name = levelName(ladder, targetLevel);
  const entry = ladder?.find(e => e.level === targetLevel);
  const grant = entry?.mode ? MODE_GRANT[entry.mode] : undefined;
  return grant ? `${name} — ${grant}` : name;
}

function categoryLabel(category: string): string {
  return category.replace(/_/g, ' ').trim() || category;
}

function findCriterion(criteria: TrustPromotionCriterion[], key: string): TrustPromotionCriterion | undefined {
  return criteria.find(c => c.key === key);
}

/** The pure decided-by-a-human count, backed out of criteria['human_samples'].
 *  See the file header for why this is a subtraction rather than a straight
 *  read: the stored figure already includes both corroborated arms. */
function humanDecidedCount(evidence: TrustPromotionEvidence): number {
  const criteria = Array.isArray(evidence.criteria) ? evidence.criteria : [];
  const samples = findCriterion(criteria, 'human_samples')?.actual ?? 0;
  const successes = evidence.corroborated_successes ?? 0;
  const refusals = evidence.corroborated_refusals ?? 0;
  return Math.max(0, samples - successes - refusals);
}

/** Zero on every source that can back a promotion — see the file header for
 *  exactly what "thin" means and why it is computed this way. Exported so the
 *  surface that renders this card can show its own "thin evidence" indicator
 *  (a Chip, say) without re-parsing prose for the words this module chose. */
export function isThinTrustEvidence(evidence: TrustPromotionEvidence): boolean {
  const successes = evidence.corroborated_successes ?? 0;
  const refusals = evidence.corroborated_refusals ?? 0;
  return successes + refusals + humanDecidedCount(evidence) === 0;
}

// Regular '+s' is wrong for at least one word this module actually uses
// ("success" -> "successs") — an explicit plural form beats a heuristic that
// has to special-case English exceptions one at a time.
function plural(n: number, singular: string, pluralForm: string = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** The card copy for one pending trust_promotion task. Server-computed
 *  numbers only — this module asserts nothing about eligibility or about
 *  whether the evidence is "good enough"; it states what was counted and,
 *  when nothing was, says so plainly instead of rendering the same shape a
 *  well-earned request would wear. */
export function trustPromotionCardCopy(input: TrustPromotionCardInput): TrustPromotionCardCopy {
  const { employeeName, category, currentLevel, targetLevel, evidence, ladder } = input;
  const criteria = Array.isArray(evidence.criteria) ? evidence.criteria : [];
  const successes = evidence.corroborated_successes ?? 0;
  const refusals = evidence.corroborated_refusals ?? 0;
  const pending = evidence.pending_reviews ?? 0;
  const decided = humanDecidedCount(evidence);

  const fromName = levelName(ladder, currentLevel);
  const grant = whatItGrants(ladder, targetLevel);
  const catLabel = categoryLabel(category);

  const title = `Trust promotion — ${employeeName}: ${catLabel} from ${fromName} to ${grant}`;

  const sentences: string[] = [
    `${employeeName} would move ${catLabel} from ${fromName} to ${grant}.`,
  ];

  if (isThinTrustEvidence(evidence)) {
    // Founder ruling: raised, not suppressed — but the card must say so.
    sentences.push(
      pending > 0
        ? `There are no approved actions to date behind this request — ${plural(pending, 'review')} still waiting on a decision.`
        : 'There are no approved actions to date behind this request, and nothing is waiting on a decision either.'
    );
  } else {
    const parts: string[] = [];
    if (decided > 0) parts.push(plural(decided, 'human-decided review'));
    if (refusals > 0) parts.push(plural(refusals, 'system-corroborated refusal'));
    if (successes > 0) parts.push(plural(successes, 'system-corroborated success', 'system-corroborated successes'));
    let countSentence = `The count behind this: ${parts.join(', ')}.`;
    if (pending > 0) countSentence += ` ${plural(pending, 'more review')} still waiting on a decision.`;
    sentences.push(countSentence);
  }

  const detail = sentences.join(' ');

  const metCount = criteria.filter(c => c.met).length;
  const meta = criteria.length > 0
    ? `${metCount} of ${criteria.length} criteria met`
    : 'No criteria recorded';

  return { title, detail, meta };
}
