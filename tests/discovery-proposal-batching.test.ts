// discovery-proposal-batching.test.ts — proves the Task 2 screen's batching
// rule is enforced in CODE, not just followed by convention in the page
// component. (.superpowers/sdd/2026-08-13-discovery-proposals-and-creation,
// Task 2: "a screen that is short where that is safe".)
//
// §11b (docs/superpowers/specs/2026-08-12-discovery-interview-design.md) is
// unambiguous: guardrail and trust_rule NEVER batch, full stop. If someone
// later "simplifies" src/lib/discoveryProposalPresentation.ts's
// batchModeFor by collapsing its two-set check into a single default, or a
// seventh proposal kind is added to PROPOSAL_KINDS without a decision about
// where it batches, this file is what goes red — not a design review that
// might not happen.
//
// Each block below states the exact data that would turn it red, per the
// "name the data that turns it red" standard this programme holds itself to.
import { describe, it, expect } from 'vitest';
import {
  PROPOSAL_KINDS, SECTION_ORDER, batchModeFor, cardCopyFor, guardrailLiteral,
  formatCap, humanizeToken, humanizeSystem, whatAcceptingWrites, trustRuleBlockReason,
} from '../src/lib/discoveryProposalPresentation';
import type { ProposalKind } from '../src/lib/discoveryProposalPresentation';

describe('batchModeFor — the single gate the page renders through', () => {
  it('guardrail never batches — RED if this ever returns anything but "never"', () => {
    expect(batchModeFor('guardrail')).toBe('never');
  });

  it('trust_rule never batches — RED if this ever returns anything but "never" (§11b: "the only proposal that removes a human")', () => {
    expect(batchModeFor('trust_rule')).toBe('never');
  });

  it('employee batches by department, not accept-all — RED if it ever returns "accept_all" (would put a hire behind a bulk-accept checkbox)', () => {
    expect(batchModeFor('employee')).toBe('department');
  });

  it('the three low-stakes kinds get accept-all — RED if any of these regresses to "never" (would make the screen unusably long for ~40 items) or "department" (they have no department)', () => {
    expect(batchModeFor('conversation_type')).toBe('accept_all');
    expect(batchModeFor('procedure')).toBe('accept_all');
    expect(batchModeFor('connector')).toBe('accept_all');
  });

  it('every one of the 6 real kinds resolves to a real mode — RED if PROPOSAL_KINDS and the two batching sets ever drift apart (a 7th kind added to one and not the other)', () => {
    const modes = PROPOSAL_KINDS.map((k) => batchModeFor(k));
    expect(modes).toHaveLength(6);
    for (const m of modes) expect(['never', 'department', 'accept_all']).toContain(m);
  });

  it('SECTION_ORDER is a permutation of PROPOSAL_KINDS — RED if a kind is dropped from the render order (silently hides a whole category from the screen)', () => {
    expect([...SECTION_ORDER].sort()).toEqual([...PROPOSAL_KINDS].sort());
  });
});

describe('guardrailLiteral — the enforceable literal, verbatim', () => {
  it('a pattern renders as "matches: X" — RED if the pattern text is altered or dropped', () => {
    expect(guardrailLiteral({ rule: 'No refund promises', pattern: 'refund|chargeback', threshold: null }))
      .toBe('matches: refund|chargeback');
  });

  it('a threshold with no pattern renders as "over $X" — RED if it silently invents a pattern-shaped string instead', () => {
    expect(guardrailLiteral({ rule: 'Escalate large refunds', pattern: null, threshold: 10000 }))
      .toBe('over $10,000');
  });

  it('neither present is reported honestly, not hidden — RED if this returns an empty string a card could render blank', () => {
    expect(guardrailLiteral({ rule: 'Be careful', pattern: null, threshold: null }))
      .toBe('no literal recorded yet');
  });
});

describe('formatCap — dollar vs confidence, keyed on the real action_category split', () => {
  it('answer_dock / answer_widget read as confidence — RED if a dollar sign appears instead', () => {
    expect(formatCap('answer_dock', 90)).toBe('90% confidence');
    expect(formatCap('answer_widget', '75')).toBe('75% confidence');
  });

  it('every other action_category reads as a dollar amount — RED if this shows a bare number with no currency, unpredictable to a reader', () => {
    expect(formatCap('erp_financials', 10000)).toBe('$10,000');
    expect(formatCap('action:erp_financials', '$10,000')).toBe('$10,000');
  });

  it('a non-numeric cap is reported, not silently coerced to $0 or NaN — RED if this crashes or prints "$NaN"', () => {
    expect(formatCap('erp_financials', 'whatever seems reasonable')).toBe('whatever seems reasonable');
  });
});

describe('humanizeToken / humanizeSystem — display only, never compared against', () => {
  it('strips the action_category namespace prefix — RED if "action:erp_financials" renders with the prefix still attached', () => {
    expect(humanizeToken('action:erp_financials')).toBe('Erp Financials');
    expect(humanizeToken('writeback:crm')).toBe('Crm');
    expect(humanizeToken('answer_dock')).toBe('Answer Dock');
  });

  it('a known connector category gets its short label — RED if this falls back to the raw key for a category CATEGORY_SHORT actually knows', () => {
    expect(humanizeSystem('erp_financials')).toBe('ERP / Financials');
  });

  it('an unknown category degrades to a humanized token rather than throwing — RED if this throws or returns the raw underscored string', () => {
    expect(humanizeSystem('mcp_stripe_refunds')).toBe('Mcp Stripe Refunds');
  });
});

describe('cardCopyFor — every kind carries its literal on the card, not just in the Drawer', () => {
  const noOwners = new Map<string, string>();

  it('conversation_type: label is on the title, owner (or its absence) is on the meta — RED if the owner_ref is silently dropped', () => {
    const withOwner = cardCopyFor('conversation_type', { label: 'Billing question', owner_ref: 'archetype:billing_ar' },
      new Map([['billing_ar', 'Morgan']]));
    expect(withOwner.title).toContain('Billing question');
    expect(withOwner.meta).toBe('Routes to: Morgan');

    const noOwner = cardCopyFor('conversation_type', { label: 'Billing question', owner_ref: 'unassigned' }, noOwners);
    expect(noOwner.meta).toMatch(/no owner/i);
  });

  it('connector: provider + what it reads/writes + the credential note — RED if reads/writes are missing from meta', () => {
    const copy = cardCopyFor('connector', {
      provider_key: 'hubspot', label: 'HubSpot', reads: ['deals'], writes: ['notes'],
    }, noOwners);
    expect(copy.title).toBe('Connect HubSpot');
    expect(copy.meta).toBe('HubSpot · reads deals, writes notes');
    expect(copy.detail).toMatch(/credential/i);
  });

  it('employee: systems it can touch are on the card, humanized — RED if this shows raw category keys instead of readable labels', () => {
    const copy = cardCopyFor('employee', { name: 'Billing & AR', systems: ['erp_financials', 'billing'] }, noOwners);
    expect(copy.meta).toBe('Systems: ERP / Financials, Billing');
    expect(copy.detail).toMatch(/supervised/i);
    expect(copy.detail).toMatch(/SOP/i);
  });

  it('guardrail: the rule sentence is the title, verbatim — RED if it gets paraphrased or truncated', () => {
    const copy = cardCopyFor('guardrail', { rule: 'Never promise a refund over the phone', pattern: 'refund|chargeback' }, noOwners);
    expect(copy.title).toBe('Never promise a refund over the phone');
    expect(copy.meta).toBe('matches: refund|chargeback');
  });

  it('trust_rule: employee + category + cap, all three, on the meta line — RED if any one of the three is missing', () => {
    const copy = cardCopyFor('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 },
      new Map([['billing_ar', 'Morgan']]));
    expect(copy.meta).toBe('Morgan · Erp Financials · up to $10,000');
    expect(copy.title).toContain('Morgan');
    expect(copy.title).toContain('$10,000');
  });
});

describe('whatAcceptingWrites — every kind states what its acceptance creates', () => {
  it('all 6 kinds return a non-empty, distinct sentence — RED if two kinds accidentally share one generic sentence', () => {
    const sentences = PROPOSAL_KINDS.map((k) => whatAcceptingWrites(k));
    for (const s of sentences) expect(s.length).toBeGreaterThan(10);
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});

describe('trustRuleBlockReason — §11b requirement 4: blocked with a reason, never hidden', () => {
  it('no matching employee proposed at all — RED if this returns null (would let a trust rule for nobody through as decidable)', () => {
    const reason = trustRuleBlockReason('archetype:sdr', []);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/no employee/i);
  });

  it('employee proposed but still pending — RED if this returns null (the trust rule would render fully decidable before its employee is real)', () => {
    const reason = trustRuleBlockReason('archetype:billing_ar', [
      { payload: { archetype_key: 'billing_ar', name: 'Morgan' }, state: 'pending' },
    ]);
    expect(reason).not.toBeNull();
    expect(reason).toContain('Morgan');
    expect(reason).toMatch(/until you accept/i);
  });

  it('employee actually accepted — RED if this still returns a block reason (would permanently hide a decidable trust rule, the opposite failure)', () => {
    const reason = trustRuleBlockReason('archetype:billing_ar', [
      { payload: { archetype_key: 'billing_ar', name: 'Morgan' }, state: 'accepted' },
    ]);
    expect(reason).toBeNull();
  });

  it('a de_ref with no "archetype:" prefix is still matched on the bare key — RED if the prefix-stripping regresses', () => {
    const reason = trustRuleBlockReason('billing_ar', [
      { payload: { archetype_key: 'billing_ar', name: 'Morgan' }, state: 'accepted' },
    ]);
    expect(reason).toBeNull();
  });
});
