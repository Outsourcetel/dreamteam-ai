// escalation-headline.test.ts — migration 778's headline rule, TS side.
//
// ⚠ WHY THIS FILE EXISTS AT ALL, given the rule also lives in SQL.
//
// The rule has two implementations by necessity: SQL runs it on the fallback
// path and ran it over the 42 rows already in the queue; TS runs it in de-work
// so `escalate_to_human` never passes a null title in the first place. Two
// implementations of one rule is exactly the shape that drifts.
//
// So they are pinned to THE SAME SEVEN FIXTURES. The SQL copies live in
// migration 778's PROBE 1 with identical expected strings; these are the TS
// copies. Change the rule on one side and one of the two goes red.
//
// ⚠ AND THE FIXTURES CARRY THEIR OWN INVERSION. Each one also records what
// split_part(detail, '.', 1) — the obvious rule, the one that shipped a
// headline reading "Ledger does not balance (debits PKR 322k vs" — does with
// the same input. A fixture where the two rules AGREE proves nothing about
// either, so `mustDiffer` is asserted in both directions rather than left as
// a comment. This is the same discipline as the SQL probe: count the
// comparisons, not just the findings.
//
// Every string below is real production text, read from human_tasks.detail on
// outsourcetel-hq on 2026-08-19.
import { describe, expect, it } from 'vitest';
import { escalationHeadline, escalationTitle } from '../supabase/functions/_shared/escalation.ts';

/** The rule that shipped the broken headlines, kept here as the control. */
function splitPartRule(s: string): string {
  return s.split('.')[0];
}

interface Fixture { name: string; input: string; want: string; mustDiffer: boolean }

const FIXTURES: Fixture[] = [
  {
    name: 'a decimal comparison is never cut at "vs."',
    input:
      'Ledger does not balance (debits PKR 322k vs. credits PKR 439.3k = shortfall of PKR 117.3k); journal entry data is incomplete (24 entries stated but only 10 partial rows provided).',
    want:
      'Ledger does not balance (debits PKR 322k vs. credits PKR 439.3k = shortfall of PKR 117.3k); journal entry data is…',
    mustDiffer: true,
  },
  {
    name: 'a clean first sentence is used whole, without its full stop',
    input:
      'Two invoices are 38–42 days overdue totalling $85,000. Both require final-notice emails with 10-day cure window before collections referral.',
    want: 'Two invoices are 38–42 days overdue totalling $85,000',
    mustDiffer: false,
  },
  {
    name: 'quotes and em dashes survive a sentence cut',
    input:
      'Cannot read book: "Onboarding projects not yet live" — no source is connected. This is not the same as an empty book.',
    want: 'Cannot read book: "Onboarding projects not yet live" — no source is connected',
    mustDiffer: false,
  },
  {
    name: 'a short detail with no terminator is returned unchanged',
    input: 'Unable to access a critical data source required to open the onboarding book',
    want: 'Unable to access a critical data source required to open the onboarding book',
    mustDiffer: false,
  },
  {
    name: 'a currency amount with cents is never cut at its decimal point',
    input:
      'Two invoices are significantly overdue (47 and 43 days past due date) and both exceed the $10,000.00 escalation threshold. Both require approval.',
    want:
      'Two invoices are significantly overdue (47 and 43 days past due date) and both exceed the $10,000.00 escalation…',
    mustDiffer: true,
  },
  {
    name: '"vs." mid-sentence does not end the sentence',
    input:
      'Customer is asking for general platform overview and positioning — specifically concerned about quality vs. cost ("another cheap agent?"). This is not a product-specific support issue.',
    want:
      'Customer is asking for general platform overview and positioning — specifically concerned about quality vs. cost…',
    mustDiffer: true,
  },
  {
    name: 'a terminator after a closing bracket still ends the sentence',
    input:
      'Journal entries do not balance (Debits PKR 322,000 vs. Credits PKR 439,300; imbalance of PKR 117,300). Additionally, entries are dated in 2027.',
    want: 'Journal entries do not balance (Debits PKR 322,000 vs. Credits PKR 439,300; imbalance of PKR 117,300)',
    mustDiffer: true,
  },
];

describe('escalationHeadline — the seven fixtures migration 778 pins in SQL', () => {
  let compared = 0;

  for (const f of FIXTURES) {
    it(f.name, () => {
      expect(escalationHeadline(f.input, 120)).toBe(f.want);
      compared++;
    });

    it(`${f.name} — the fixture still discriminates against split_part`, () => {
      const split = splitPartRule(f.input);
      const rule = escalationHeadline(f.input, 120);
      if (f.mustDiffer) {
        // The whole reason the rule exists. If these ever agree, the fixture
        // has stopped testing anything and must not pass quietly.
        expect(split).not.toBe(rule);
      } else {
        expect(split).toBe(rule);
      }
      compared++;
    });
  }

  it('compared every fixture in both directions', () => {
    // THE DENOMINATOR. Zero failures from zero comparisons looks exactly like
    // a clean result; this is what makes the difference visible.
    expect(FIXTURES.length).toBe(7);
    expect(compared).toBe(FIXTURES.length * 2);
  });
});

describe('escalationHeadline — the edges', () => {
  it('returns null when there is nothing to derive from', () => {
    expect(escalationHeadline(null)).toBeNull();
    expect(escalationHeadline(undefined)).toBeNull();
    expect(escalationHeadline('')).toBeNull();
    expect(escalationHeadline('    ')).toBeNull();
    expect(escalationHeadline('\n\t  \n')).toBeNull();
  });

  it('never returns more than the budget plus its ellipsis', () => {
    const long = 'word '.repeat(400).trim();
    const out = escalationHeadline(long, 120)!;
    expect(out.length).toBeLessThanOrEqual(121);
    expect(out.endsWith('…')).toBe(true);
    // and the cut landed on a word boundary, not inside "word"
    expect(out.slice(0, -1).trim().endsWith('word')).toBe(true);
  });

  it('collapses newlines and runs of whitespace, because a title is one line', () => {
    expect(escalationHeadline('Journal entries\n\n  cannot   be\tread by anyone here')).toBe(
      'Journal entries cannot be read by anyone here',
    );
  });

  it('cuts a single unbroken word rather than returning nothing', () => {
    const out = escalationHeadline('x'.repeat(400), 120)!;
    expect(out.length).toBe(121);
  });

  it('drops a dangling list marker left at the cut', () => {
    const out = escalationHeadline(
      'Four critical data gaps prevent closure of the FP&A position and they are as follows here: (1) all 24 journal entries misdated to 2027; (2) one invoice missing',
      120,
    )!;
    expect(out.endsWith('(1)…')).toBe(false);
    expect(out.endsWith('(2)…')).toBe(false);
  });

  it('honours a floor and a ceiling on the budget rather than trusting the caller', () => {
    // A caller asking for a 5-character headline gets 24, not a stub.
    expect(escalationHeadline('Journal entries cannot be read for this month at all', 5)!.length)
      .toBeGreaterThan(20);
    // and one asking for 5000 is clamped, so the title can never exceed the
    // 300-char column clamp open_de_escalation applies.
    expect(escalationHeadline('word '.repeat(400).trim(), 5000)!.length).toBeLessThanOrEqual(301);
  });

  it('does not invent a sentence break inside an abbreviation', () => {
    // "No." and "e.g." are the two-and-under cases the >= 3 alphanumeric rule
    // exists for. Neither may terminate the headline.
    expect(escalationHeadline('Invoice No. 4471 is overdue and needs a decision from finance today'))
      .toBe('Invoice No. 4471 is overdue and needs a decision from finance today');
    expect(escalationHeadline('Several fields are missing, e.g. the customer contact email address'))
      .toBe('Several fields are missing, e.g. the customer contact email address');
  });
});

/** ── 778 Q2: KEEP THE NAME, ADD THE PROBLEM ──────────────────────────────
 *
 *  The five rows this covers are real. Read from human_tasks on
 *  outsourcetel-hq on 2026-08-19, they read:
 *
 *      Needs a decision — Grant Plastics Ltd.
 *      Needs a decision — West View Software Ltd.
 *      Needs a decision — Palmer Productions Ltd. — SaaS onboarding
 *      Needs a decision — Grant Plastics Ltd. — SaaS onboarding
 *      Needs a decision — Grant Plastics Ltd. — SaaS onboarding v5
 *
 *  Every one names the customer and none says what the ask is. They were
 *  missed by the first sweep because it asked `like '%needs a decision%'`
 *  case-sensitively and this arm title-cases the N — 42 became 47 the moment
 *  the same sweep was run `ilike`.
 *
 *  The SQL twin of these assertions is migration 778's PROBE 10 (arm-B
 *  control) and PROBE 11 (ladder rung 2 with an entity).
 */
describe('escalationTitle — the entityName arm of de-work:1301', () => {
  const REASONS: Array<{ entity: string; reason: string; want: string }> = [
    {
      entity: 'Grant Plastics Ltd.',
      reason:
        'No executive sponsor or day-to-day contact is recorded for Grant Plastics Ltd. Cannot proceed with at-risk check-in without identifying who holds the relationship.',
      want:
        'Grant Plastics Ltd. — No executive sponsor or day-to-day contact is recorded for Grant Plastics Ltd',
    },
    {
      entity: 'West View Software Ltd.',
      reason:
        'No contacts are recorded for West View Software Ltd. in either the executive_sponsor or day_to_day role. Cannot proceed with relationship identification without real contact data.',
      want:
        'West View Software Ltd. — No contacts are recorded for West View Software Ltd',
    },
    {
      entity: 'Palmer Productions Ltd. — SaaS onboarding',
      reason:
        'Cannot proceed with onboarding plan without contact information. No day-to-day contact, economic buyer, or exec sponsor is recorded for Palmer Productions Ltd.',
      want:
        'Palmer Productions Ltd. — SaaS onboarding — Cannot proceed with onboarding plan without contact information',
    },
  ];

  for (const r of REASONS) {
    it(`keeps "${r.entity}" AND states the problem`, () => {
      const out = escalationTitle(r.entity, r.reason)!;
      expect(out).toBe(r.want);
      // BOTH HALVES, asserted separately. A rebuild that kept only the problem
      // would look like a win until somebody asked which customer it was about.
      expect(out).toContain(r.entity.split(' — ')[0]);
      expect(out.length).toBeGreaterThan(r.entity.length + 3);
    });
  }

  it('never produces the sentence the whole migration exists to remove', () => {
    for (const r of REASONS) {
      expect(escalationTitle(r.entity, r.reason)!.toLowerCase()).not.toContain('needs a decision');
    }
    expect((escalationTitle('Grant Plastics Ltd.', '') ?? '').toLowerCase())
      .not.toContain('needs a decision');
    expect((escalationTitle(null, '') ?? '').toLowerCase()).not.toContain('needs a decision');
  });

  it('with no entity it is exactly the headline — the null arm is unchanged', () => {
    const reason = 'Two invoices are 38–42 days overdue totalling $85,000. Both require final-notice emails.';
    expect(escalationTitle(null, reason)).toBe(escalationHeadline(reason, 120));
    expect(escalationTitle('   ', reason)).toBe(escalationHeadline(reason, 120));
  });

  it('with no reason it still KEEPS THE NAME rather than dropping to nothing', () => {
    expect(escalationTitle('Grant Plastics Ltd.', '')).toBe('Grant Plastics Ltd.');
    expect(escalationTitle('Grant Plastics Ltd.', null)).toBe('Grant Plastics Ltd.');
    expect(escalationTitle('  Grant Plastics Ltd.  ', '   ')).toBe('Grant Plastics Ltd.');
  });

  it('returns null only when it has neither, so SQL can name the work item', () => {
    expect(escalationTitle(null, null)).toBeNull();
    expect(escalationTitle('', '')).toBeNull();
    expect(escalationTitle('   ', '  \n ')).toBeNull();
  });

  it('does NOT drop the prefix just because the headline mentions the entity', () => {
    // The tempting shortcut, refused on purpose: it is the one rule that can
    // silently produce a title with no customer on it. Redundancy is the
    // price, and it is cheaper than a lost name.
    const out = escalationTitle('Grant Plastics Ltd.', 'Grant Plastics Ltd. has no recorded requirements at all here.')!;
    expect(out.startsWith('Grant Plastics Ltd. — ')).toBe(true);
  });
});

/** ── 778 Q2: the case-sensitivity defect that hid those five rows ────────
 *  Not a test of the helper — a test of the SWEEP. The lesson generalises
 *  past this migration: a case-sensitive match for a phrase another branch
 *  capitalises cannot find it, and the count difference is the only thing
 *  that makes the gap visible.
 */
describe('the sweep that missed five rows', () => {
  const LIVE_TITLES = [
    'Accounting DE needs a decision',
    'Billing & Invoicing DE needs a decision',
    'Needs a decision — Grant Plastics Ltd.',
    'Needs a decision — West View Software Ltd.',
    'Needs a decision — Palmer Productions Ltd. — SaaS onboarding',
    'Approve the refund for Grant Plastics before Friday',
  ];

  it('case-sensitive finds fewer than case-insensitive, and the gap is arm two', () => {
    const cs = LIVE_TITLES.filter((t) => t.includes('needs a decision')).length;
    const ci = LIVE_TITLES.filter((t) => t.toLowerCase().includes('needs a decision')).length;
    expect(cs).toBe(2);
    expect(ci).toBe(5);
    // the assertion that matters: the two sweeps DISAGREE. If they ever stop
    // disagreeing, this fixture no longer demonstrates the defect.
    expect(ci).toBeGreaterThan(cs);
  });
});
