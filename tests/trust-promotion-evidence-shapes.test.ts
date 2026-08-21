// trust-promotion-evidence-shapes.test.ts — pins the three functions
// tests/trust-promotion.test.ts never exercises directly: extractPolicyEvidence
// (the shape-normalizer), isThinTrustEvidence, and humanDecidedCount.
//
// Fix round 2 (coordinator review, 2026-08-21): "the reviewer confirmed the
// behaviour by executing the module; the repository will not catch a
// regression." §2 of the task-6 report calls extractPolicyEvidence's
// shape-detection "the most consequential decision in the change" — a reader
// that only understood the flat shape would have rendered the one live
// production request as having no evidence at all. That decision had zero
// test coverage before this file. Every arm below was run against a
// deliberately broken copy of the corresponding logic and observed to fail
// for the RIGHT reason before being kept (see the inversion notes inline) —
// a checker that cannot fail is theatre.
//
// ── FINAL WHOLE-FEATURE REVIEW (2026-08-21) — two gaps closed here ──────────
// 1. trustPromotionCardCopy had exactly TWO assertions in the whole suite
//    (tests/trust-promotion.test.ts), both on `.detail`, both on fixtures
//    carrying no window_days, no computed_at and no ladder. So `.title`,
//    `.meta`, the "in the last N days" qualifier, the "(as measured on …)"
//    date and the entire ladder path were unpinned — on the very code fix
//    round 2 added to stop the card stating falsehoods. Pinned below,
//    table-driven, in the file that already has the right fixtures.
// 2. detailIsRedundantBesideCard is new, decides whether a whole paragraph of
//    evidence is shown or hidden on two surfaces, and had no coverage at all.
import { describe, it, expect } from 'vitest';
import {
  extractPolicyEvidence, isThinTrustEvidence, humanDecidedCount,
  trustPromotionCardCopy, detailIsRedundantBesideCard,
} from '../src/lib/trustPromotionPresentation';
import type {
  TrustPromotionEvidence, TrustPromotionCardInput, TrustPromotionLadderLevel,
} from '../src/lib/trustPromotionPresentation';

// The REAL pending_evidence blob for the one trust_promotion request live in
// production (tenant 5bb802e1), queried read-only on 2026-08-21 — see
// task-6-report.md §2. Kept verbatim so a real-world regression shows up here
// first, not in the ops queue.
const MORGAN_PENDING_EVIDENCE = {
  dial: {
    current_level: 0, proposed_level: 1,
    current_settings: { enabled: false, min_confidence: null, max_amount_cents: null },
    proposed_settings: { enabled: true, min_confidence: null, max_amount_cents: null },
  },
  pattern: {
    reset_at: null,
    decisions: [
      { receipt: 'Logged a dunning note on invoice ACC-SINV-2026-00008 in ERPNext (comment 0tqku9lgls).', task_id: 'c0701141-5d0c-4e7c-b2c6-1942f1462fb9', decided_at: '2026-08-04T10:29:49.998875+00:00', decided_by: '84471299-b9e7-4577-8427-9076d3175024', decided_by_name: 'Outsourcetel Owner' },
    ],
    action_key: 'send_payment_reminder', n_approved: 4, window_days: 30,
    action_definition_id: '00003ef9-96d6-416e-9b21-3ea7301e83e6',
  },
  policy_evidence: {
    criteria: [
      { key: 'eval_pass_rate', met: true, label: 'Evaluation pass rate', actual: 0, detail: '0 of 0 answered questions passed in the last 30 days', required: 0.9 },
      { key: 'eval_samples', met: true, label: 'Evaluation sample size', actual: 0, detail: '0 evaluated answers (needs 0)', required: 0 },
      { key: 'human_approval_rate', met: true, label: 'Human approval rate', actual: 1, detail: '4 of 4 human reviews approved in the last 30 days', required: 0.9 },
      { key: 'human_samples', met: true, label: 'Human review sample size', actual: 4, detail: '4 decided reviews (needs 3)', required: 3 },
      { key: 'guardrail_blocks', met: true, label: 'Guardrail blocks', actual: 0, detail: '0 guardrail blocks in the last 30 days (max 0)', required: 0 },
    ],
    eligible: true, policy_id: '0c7282de-d170-466e-ad4b-d5ea90ecac3d',
    computed_at: '2026-08-11T23:25:38.715843+00:00', window_days: 30,
    at_max_level: false, target_level: 1, current_level: 0, action_category: 'action_execute',
  },
};

// A synthetic but realistic flat payload — what request_trust_promotion
// (migration 025) and open_trust_promotion_request (migration 828, not yet
// applied) write: trust_evidence_for()'s return, unwrapped.
const FLAT_PENDING_EVIDENCE = {
  policy_id: 'p1', action_category: 'action_execute', current_level: 0, target_level: 1,
  window_days: 30, pending_reviews: 2, corroborated_refusals: 1, corroborated_successes: 0,
  criteria: [{ key: 'human_samples', label: 'x', detail: 'x', actual: 5, required: 3, met: true }],
  eligible: true, at_max_level: false, computed_at: '2026-08-20T00:00:00Z',
};

describe('extractPolicyEvidence — the shape-normalizer, table-driven', () => {
  const cases: Array<[string, unknown, 'null' | 'flat' | 'wrapped']> = [
    ['null', null, 'null'],
    ['undefined', undefined, 'null'],
    ['empty object', {}, 'null'],
    ['a bare string (not an object at all)', 'not an object', 'null'],
    ['a bare number', 42, 'null'],
    ['an array (typeof === "object" in JS, but has no .criteria)', [1, 2, 3], 'null'],
    ['an object with neither criteria nor policy_evidence', { dial: { current_level: 0 } }, 'null'],
    ['policy_evidence present but not an object', { policy_evidence: 'nope' }, 'null'],
    ['policy_evidence present but carries no criteria', { policy_evidence: { eligible: true } }, 'null'],
    ['the flat shape (request_trust_promotion / migration 828)', FLAT_PENDING_EVIDENCE, 'flat'],
    ['the pattern-wrapped shape (raise_trust_widening_proposals, migration 710)', MORGAN_PENDING_EVIDENCE, 'wrapped'],
  ];

  for (const [label, input, kind] of cases) {
    it(`${label} -> ${kind === 'null' ? 'null' : 'a readable TrustPromotionEvidence'}`, () => {
      const result = extractPolicyEvidence(input);
      if (kind === 'null') {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        expect(Array.isArray(result!.criteria)).toBe(true);
        expect(result!.criteria.length).toBeGreaterThan(0);
      }
    });
  }

  it('reads the flat shape\'s fields exactly, including window_days/computed_at (fix round 2)', () => {
    const ev = extractPolicyEvidence(FLAT_PENDING_EVIDENCE)!;
    expect(ev.pending_reviews).toBe(2);
    expect(ev.corroborated_refusals).toBe(1);
    expect(ev.corroborated_successes).toBe(0);
    expect(ev.eligible).toBe(true);
    expect(ev.window_days).toBe(30);
    expect(ev.computed_at).toBe('2026-08-20T00:00:00Z');
    expect(ev.criteria[0].actual).toBe(5);
  });

  it('reads the wrapped shape\'s nested policy_evidence exactly, not the pattern sibling', () => {
    // ⛔ INVERSION RUN: with the policy_evidence fallback removed (reverting
    // to `Array.isArray(top.criteria) ? top : null`), this arm goes from a
    // 5-item criteria array to `result === null` — confirmed red before this
    // arm was kept, per the "most consequential decision" the report names.
    const ev = extractPolicyEvidence(MORGAN_PENDING_EVIDENCE)!;
    expect(ev.criteria.length).toBe(5);
    expect(ev.criteria.find(c => c.key === 'human_samples')?.actual).toBe(4);
    expect(ev.window_days).toBe(30);
    expect(ev.computed_at).toBe('2026-08-11T23:25:38.715843+00:00');
    // The wrapped shape's policy_evidence carries no corroborated_/pending_
    // keys at all (it predates migrations 815/819) — must read as absent
    // (undefined), never fabricated as 0-and-indistinguishable-from-real-zero
    // at this layer (isThinTrustEvidence's ?? 0 default is a SEPARATE,
    // later step).
    expect(ev.corroborated_refusals).toBeUndefined();
    expect(ev.pending_reviews).toBeUndefined();
  });

  it('prefers a top-level criteria array over policy_evidence when (hypothetically) both are present', () => {
    // Not a shape either real writer produces — pins the PRECEDENCE the
    // implementation actually has, so a future refactor cannot silently flip
    // it without a test noticing.
    const both = {
      criteria: [{ key: 'human_samples', actual: 99, required: 1, met: true }],
      policy_evidence: { criteria: [{ key: 'human_samples', actual: 1, required: 1, met: true }] },
    };
    const ev = extractPolicyEvidence(both)!;
    expect(ev.criteria[0].actual).toBe(99);
  });
});

describe('humanDecidedCount — the subtraction, table-driven', () => {
  const cases: Array<[string, TrustPromotionEvidence, number]> = [
    ['zero samples, zero corroborated', { criteria: [{ key: 'human_samples', actual: 0, required: 3, met: false }] }, 0],
    ['Morgan — 4 decided, no corroborated fields on this pre-819 snapshot', { criteria: [{ key: 'human_samples', actual: 4, required: 3, met: true }] }, 4],
    ['819\'s own worked example — one corroborated refusal, zero decided', { criteria: [{ key: 'human_samples', actual: 1, required: 5, met: false }], corroborated_refusals: 1 }, 0],
    ['a genuine mix — subtraction must actually subtract, not pass through', { criteria: [{ key: 'human_samples', actual: 10, required: 3, met: true }], corroborated_successes: 2, corroborated_refusals: 3 }, 5],
    ['the brief\'s own inconsistent fixture — must clamp at 0, never go negative', { criteria: [{ key: 'human_samples', actual: 5, required: 3, met: true }], corroborated_successes: 12, corroborated_refusals: 3 }, 0],
    ['no human_samples criterion in the array at all', { criteria: [{ key: 'guardrail_blocks', actual: 0, required: 0, met: true }] }, 0],
    ['empty criteria array', { criteria: [] }, 0],
  ];

  for (const [label, evidence, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      // ⛔ INVERSION RUN: with the subtraction replaced by a straight
      // `samples` passthrough (dropping "- successes - refusals"), the
      // "genuine mix" and "819 worked example" and "brief's inconsistent
      // fixture" rows all went red (10, 1 and 5 respectively, not 5, 0 and
      // 0) — confirmed before this table was kept.
      expect(humanDecidedCount(evidence)).toBe(expected);
    });
  }
});

describe('isThinTrustEvidence — table-driven, including the case the whole task exists for', () => {
  const cases: Array<[string, TrustPromotionEvidence, boolean]> = [
    ['everything genuinely zero — the no-history case', {
      corroborated_successes: 0, corroborated_refusals: 0,
      criteria: [{ key: 'human_samples', actual: 0, required: 3, met: false }],
    }, true],
    ['Morgan — real, substantial evidence (extracted from the real production payload)', extractPolicyEvidence(MORGAN_PENDING_EVIDENCE)!, false],
    ['one corroborated refusal, zero decided reviews — 819\'s own example: real evidence, not thin', {
      corroborated_refusals: 1, criteria: [{ key: 'human_samples', actual: 1, required: 5, met: false }],
    }, false],
    ['successes only', {
      corroborated_successes: 3, criteria: [{ key: 'human_samples', actual: 3, required: 3, met: true }],
    }, false],
    ['no human_samples criterion AND no corroborated fields at all', {
      criteria: [{ key: 'guardrail_blocks', actual: 0, required: 0, met: true }],
    }, true],
    ['the brief\'s own "does not say thin" fixture, verbatim', {
      corroborated_successes: 12, corroborated_refusals: 3, pending_reviews: 0,
      criteria: [{ key: 'human_samples', actual: 5, required: 3, met: true }],
    }, false],
  ];

  for (const [label, evidence, expected] of cases) {
    it(`${label} -> ${expected ? 'THIN' : 'not thin'}`, () => {
      // ⛔ INVERSION RUN: flipping the comparison from `=== 0` to `!== 0`
      // turned every row in this table red (each expectation is the exact
      // opposite of what the inverted code returns) — the gate genuinely
      // discriminates, it does not just happen to agree with one fixture.
      expect(isThinTrustEvidence(evidence)).toBe(expected);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// trustPromotionCardCopy — the parts nothing pinned before.
// ─────────────────────────────────────────────────────────────────────────────

/** A ladder as trust_policies.ladder stores one — level, name, mode. */
const LADDER: TrustPromotionLadderLevel[] = [
  { level: 1, name: 'Assisted', mode: 'act_with_approval' },
  { level: 2, name: 'Supervised', mode: 'act_within_limits' },
];

/** Real evidence, dated and windowed — the shape the live payload has. */
const DATED: TrustPromotionEvidence = {
  corroborated_successes: 0, corroborated_refusals: 1, pending_reviews: 2,
  window_days: 30, computed_at: '2026-08-11T23:25:38.715843+00:00',
  criteria: [
    { key: 'human_samples', actual: 4, required: 3, met: true },
    { key: 'guardrail_blocks', actual: 0, required: 0, met: true },
    { key: 'eval_pass_rate', actual: 0.5, required: 0.9, met: false },
  ],
};

/** The same numbers with the two fix-round-2 fields ABSENT — the shape every
 *  pre-existing fixture had, and the one that must degrade to no qualifier and
 *  no date rather than to "undefined". */
const UNDATED: TrustPromotionEvidence = {
  corroborated_successes: 0, corroborated_refusals: 1, pending_reviews: 2,
  criteria: DATED.criteria,
};

const cardInput = (over: Partial<TrustPromotionCardInput> = {}): TrustPromotionCardInput => ({
  employeeName: 'Morgan', category: 'action_execute',
  currentLevel: 0, targetLevel: 1, evidence: DATED, ...over,
});

describe('trustPromotionCardCopy — title, meta, window qualifier and ladder, table-driven', () => {
  // ⛔ INVERSION RUNS, all four executed against this file before the table
  //    was kept, with the measured failure counts out of 56:
  //      * title loses its `from X to Y` half            -> 5 failed
  //      * windowPhrase reverted to an unconditional
  //        " to date" (the pre-fix-round-2 overclaim)    -> 7 failed
  //      * meta drops the `(as measured on …)` clause    -> 8 failed
  //      * formatDate loses its Number.isNaN guard       -> 10 failed
  //    Each red set is distinct, and none of them is the whole table — the
  //    rows discriminate rather than all keying on one string.
  const cases: Array<[string, TrustPromotionCardInput, RegExp | string, 'title' | 'detail' | 'meta', boolean]> = [
    // ── title ──────────────────────────────────────────────────────────────
    ['title names the employee, the category and BOTH level names',
      cardInput(), 'Trust promotion — Morgan: action execute from Human-gated to Level 1', 'title', true],
    ['title uses the LADDER own names when the policy carries one',
      cardInput({ ladder: LADDER, currentLevel: 1, targetLevel: 2 }),
      'Trust promotion — Morgan: action execute from Assisted to Supervised — acts on its own, within limits', 'title', true],
    ['a ladder level with no matching entry falls back to the generic name, never to "undefined"',
      cardInput({ ladder: LADDER, currentLevel: 2, targetLevel: 3 }),
      'Trust promotion — Morgan: action execute from Supervised to Level 3', 'title', true],
    ['an unknown mode string names the level without inventing a grant clause',
      cardInput({ ladder: [{ level: 1, name: 'Trial', mode: 'not_a_mode' }] }),
      'Trust promotion — Morgan: action execute from Human-gated to Trial', 'title', true],
    // ── the window qualifier ───────────────────────────────────────────────
    ['a dated payload scopes its counts to the window',
      cardInput(), /In the last 30 days: /, 'detail', true],
    ['an UNDATED payload states the counts without claiming a window',
      // 3, not 4: human_samples already SUMS the corroborated arms, so the
      // decided-by-a-human count is 4 - 0 successes - 1 refusal. Pinned here
      // because this table's first draft asserted 1 and went red — the
      // subtraction is exactly the kind of arithmetic a copy change breaks.
      cardInput({ evidence: UNDATED }), 'The count behind this: 3 human-decided reviews, 1 system-corroborated refusal.', 'detail', true],
    ['an undated payload never renders the words "in the last"',
      cardInput({ evidence: UNDATED }), /in the last/i, 'detail', false],
    ['an undated payload never renders "undefined"',
      cardInput({ evidence: UNDATED }), /undefined/, 'detail', false],
    ['the thin branch carries the qualifier too when the window is known',
      cardInput({ evidence: { corroborated_successes: 0, corroborated_refusals: 0, pending_reviews: 0, window_days: 14,
                              criteria: [{ key: 'human_samples', actual: 0, required: 3, met: false }] } }),
      'There are no approved actions in the last 14 days behind this request', 'detail', true],
    ['the thin branch WITHOUT a window makes no absolute "to date" claim',
      cardInput({ evidence: { corroborated_successes: 0, corroborated_refusals: 0, pending_reviews: 0,
                              criteria: [{ key: 'human_samples', actual: 0, required: 3, met: false }] } }),
      /to date/i, 'detail', false],
    // ── meta: the count AND the date ───────────────────────────────────────
    ['meta counts met criteria out of the total and dates the snapshot',
      cardInput(), '2 of 3 criteria met (as measured on 2026-08-11)', 'meta', true],
    ['meta omits the date entirely when computed_at is absent — never "on undefined"',
      cardInput({ evidence: UNDATED }), 'as measured on', 'meta', false],
    ['meta omits the date when computed_at is unparsable rather than rendering NaN',
      cardInput({ evidence: { ...DATED, computed_at: 'not-a-date' } }), 'as measured on', 'meta', false],
    ['meta still counts the criteria when the date is unusable',
      cardInput({ evidence: { ...DATED, computed_at: 'not-a-date' } }), '2 of 3 criteria met', 'meta', true],
    ['meta says so plainly when there are no criteria at all',
      cardInput({ evidence: { criteria: [] } }), 'No criteria recorded', 'meta', true],
  ];

  for (const [label, input, expected, field, shouldMatch] of cases) {
    it(label, () => {
      const value = trustPromotionCardCopy(input)[field];
      if (typeof expected === 'string') {
        if (shouldMatch) expect(value).toContain(expected);
        else expect(value).not.toContain(expected);
      } else if (shouldMatch) {
        expect(value).toMatch(expected);
      } else {
        expect(value).not.toMatch(expected);
      }
    });
  }

  it('renders the REAL production payload end to end — title, detail and meta together', () => {
    // Morgan's wrapped shape, through the normalizer, exactly as a surface
    // does it. Pins the whole pipeline rather than three isolated functions,
    // and is the only arm here whose expected strings come from real data.
    const ev = extractPolicyEvidence(MORGAN_PENDING_EVIDENCE)!;
    const copy = trustPromotionCardCopy({
      employeeName: 'Morgan', category: 'action_execute',
      currentLevel: 0, targetLevel: 1, evidence: ev, ladder: null,
    });
    expect(copy.title).toBe('Trust promotion — Morgan: action execute from Human-gated to Level 1');
    expect(copy.detail).toContain('In the last 30 days: 4 human-decided reviews.');
    expect(copy.meta).toBe('5 of 5 criteria met (as measured on 2026-08-11)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detailIsRedundantBesideCard — whether the raw human_tasks.detail still has
// something to say once the curated card has rendered. Getting this wrong in
// the TRUE direction deletes the pattern detector's citation list (dates,
// approvers, landed receipts) from both surfaces, and nothing else carries it.
// ─────────────────────────────────────────────────────────────────────────────
describe('detailIsRedundantBesideCard — table-driven, and it fails toward showing MORE', () => {
  // ⛔ INVERSION RUN: replacing the body with a bare
  // `return !!pendingEvidence` — the blunt "hide it for this task type"
  // shortcut the final review offered as an option — turned 19 of the 56
  // assertions in this file red, including every row whose whole point is
  // that the pattern detector's receipts must survive.
  //
  // ⚠ THIS TABLE ALREADY CAUGHT ONE REAL DEFECT IN THE CODE IT PINS. The
  // first implementation guarded with `top.pattern && typeof top.pattern ===
  // 'object'`, so `{pattern: 'nope', criteria: [...]}` fell through into the
  // HIDE branch — the one direction that deletes evidence. The row below is
  // the row that went red; the guard is now a bare presence test.
  const cases: Array<[string, unknown, boolean]> = [
    ['the pattern-wrapped shape — the receipts live ONLY in the raw detail',
      MORGAN_PENDING_EVIDENCE, false],
    ['the flat criteria shape (mig 828 and mig 025) — the card says everything the detail says',
      FLAT_PENDING_EVIDENCE, true],
    ['a bare pattern key with no policy_evidence still keeps its detail',
      { pattern: { decisions: [] } }, false],
    ['pattern present ALONGSIDE top-level criteria still keeps its detail',
      { pattern: { n_approved: 3 }, criteria: [{ key: 'human_samples', actual: 3, required: 3, met: true }] }, false],
    ['pattern present but not an object — unrecognised, so show the detail',
      { pattern: 'nope', criteria: [] }, false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['a bare string', 'not an object', false],
    ['a bare number', 42, false],
    ['an array', [1, 2, 3], false],
    ['an empty object — no criteria to render, so the detail is all there is', {}, false],
    ['criteria present but not an array', { criteria: 'nope' }, false],
    ['an empty criteria array still counts as the flat shape the card renders',
      { criteria: [] }, true],
  ];

  for (const [label, input, expected] of cases) {
    it(`${label} -> ${expected ? 'hide the raw detail' : 'KEEP the raw detail'}`, () => {
      expect(detailIsRedundantBesideCard(input)).toBe(expected);
    });
  }
});
