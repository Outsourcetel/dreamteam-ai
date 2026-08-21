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
import { describe, it, expect } from 'vitest';
import {
  extractPolicyEvidence, isThinTrustEvidence, humanDecidedCount,
} from '../src/lib/trustPromotionPresentation';
import type { TrustPromotionEvidence } from '../src/lib/trustPromotionPresentation';

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
