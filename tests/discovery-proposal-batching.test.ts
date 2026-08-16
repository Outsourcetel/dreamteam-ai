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
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  PROPOSAL_KINDS, SECTION_ORDER, batchModeFor, cardCopyFor, guardrailLiteral, guardrailKindOf,
  formatCap, formatBareNumber, humanizeToken, humanizeSystem, humanizeConnectorTouch,
  whatAcceptingWrites, trustRuleBlockReason, itemsForBatchMode, needsAcceptConfirmation,
  __looksLikeEnforceablePattern_forDriftTestOnly as looksLikeEnforceablePattern,
} from '../src/lib/discoveryProposalPresentation';
import type { ProposalKind } from '../src/lib/discoveryProposalPresentation';
// The REAL implementation this file's copy must never drift from — same
// "duplicated on purpose, drift-guarded here" pattern Task 1's own test file
// uses for matchProvider (tests/discovery-proposals.test.ts). A real import
// of a supabase/functions/_shared module is legal under vitest (Vite
// resolves it fine); it is Deno that cannot load anything importing
// import.meta.env, which is why the frontend copy exists at all.
import { validatePayload as realValidatePayload } from '../supabase/functions/_shared/discoveryProposals.ts';

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

describe('guardrailLiteral — the enforceable literal, verbatim (fix round 1, Critical 1)', () => {
  it('a pattern renders as "matches: X" — RED if the pattern text is altered or dropped', () => {
    expect(guardrailLiteral({ rule: 'No refund promises', pattern: 'refund|chargeback', threshold: null }))
      .toBe('matches: refund|chargeback');
  });

  it('a threshold with no pattern renders as a BARE number, no invented currency — RED if a "$" ever appears here', () => {
    // The review's own two failing examples, both fixed by removing the
    // fabricated dollar sign rather than only one of them:
    //  - a 20%-discount cap used to render "$20"
    //  - a require_approval_over_cents value of 100000 (= $1,000, in
    //    CENTS) used to render "$100,000" — a hundredfold error
    expect(guardrailLiteral({ rule: 'Max 20% discount without VP approval', pattern: null, threshold: 20 }))
      .toBe('threshold: 20');
    expect(guardrailLiteral({ rule: 'Invoices over $10,000 need approval', pattern: null, threshold: 100000 }))
      .toBe('threshold: 100,000');
  });

  it('neither present is reported honestly, not hidden — RED if this returns an empty string a card could render blank', () => {
    expect(guardrailLiteral({ rule: 'Be careful', pattern: null, threshold: null }))
      .toBe('no literal recorded yet');
  });

  it('a PROSE pattern beside a valid threshold falls back to the threshold, never renders the prose as the literal — RED if "matches: ..." appears here', () => {
    // The exact live-reachable shape the review flagged: Task 1's
    // validatePayload accepts a guardrail whose pattern fails
    // looksLikeEnforceablePattern as long as threshold is a valid number —
    // it does not null out the invalid pattern first. A card that then
    // treats ANY truthy payload.pattern as the literal renders un-consentable
    // prose as if it were enforceable.
    const payload = { rule: 'Do not upset customers', pattern: 'anything the customer might find upsetting', threshold: 10000 };
    // Prove the premise first: Task 1's real validatePayload actually
    // accepts this payload (via the threshold), so this is not a
    // hypothetical shape — it is exactly what can reach discovery_proposals.
    expect(() => realValidatePayload('guardrail', payload)).not.toThrow();
    expect(guardrailLiteral(payload)).toBe('threshold: 10,000');
    expect(guardrailLiteral(payload)).not.toMatch(/matches:/);
  });
});

describe('guardrailKindOf — pattern vs threshold vs none, the fact whatAcceptingWrites/cardCopyFor branch on', () => {
  it('a real pattern is "pattern" — RED if a valid enforceable pattern is ever misread as "threshold" or "none"', () => {
    expect(guardrailKindOf({ pattern: 'refund|chargeback', threshold: null })).toBe('pattern');
  });
  it('a prose "pattern" with a valid threshold is "threshold", not "pattern" — RED if this ever returns "pattern" for prose', () => {
    expect(guardrailKindOf({ pattern: 'anything the customer might find upsetting', threshold: 10000 })).toBe('threshold');
  });
  it('neither is "none" — RED if this silently reports "pattern" or "threshold" for an empty payload', () => {
    expect(guardrailKindOf({ pattern: null, threshold: null })).toBe('none');
  });
});

describe('looksLikeEnforceablePattern — drift-guarded against the real Task 1 behaviour', () => {
  // Task 1's copy (supabase/functions/_shared/discoveryProposals.ts) does not
  // export looksLikeEnforceablePattern directly, so the oracle here is its
  // OWN exported validatePayload: for a fixed valid rule and threshold=null,
  // whether validatePayload throws is entirely a function of whether the
  // pattern is enforceable. If the two implementations of
  // looksLikeEnforceablePattern ever disagree, this test goes red on
  // whichever case it disagrees on — not a hypothetical, an actual behaviour
  // comparison against the real Deno-deployed module.
  const cases: Array<[string, boolean]> = [
    ['refund|chargeback', true],
    ['refund|chargeback|free month', true],
    ['anything the customer might find upsetting', false],
    ['Do not upset customers.', false],           // trailing punctuation
    ['a b c d e f g h', false],                    // over 5 tokens
    ['', false],
  ];
  it('agrees with the real validatePayload on every case — RED on the first disagreement', () => {
    for (const [pattern, expected] of cases) {
      const local = looksLikeEnforceablePattern(pattern);
      expect(local, `local looksLikeEnforceablePattern("${pattern}")`).toBe(expected);
      if (!pattern) continue; // empty pattern + null threshold throws for a DIFFERENT reason (no literal at all) — not what's under test here
      const realAccepts = (() => {
        try { realValidatePayload('guardrail', { rule: 'x', pattern, threshold: null }); return true; }
        catch { return false; }
      })();
      expect(realAccepts, `real validatePayload accepts pattern "${pattern}"`).toBe(expected);
    }
  });
});

describe('formatBareNumber — no invented unit, ever', () => {
  it('groups digits for legibility but never adds a currency or percent sign — RED if "$" or "%" ever appears', () => {
    expect(formatBareNumber(100000)).toBe('100,000');
    expect(formatBareNumber(20)).toBe('20');
    expect(formatBareNumber('10000')).toBe('10,000');
  });
  it('a non-numeric value is reported honestly rather than crashing or printing "NaN" — RED on either failure mode', () => {
    expect(formatBareNumber('whatever seems reasonable')).toBe('whatever seems reasonable');
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

describe('humanizeConnectorTouch — fix round 1, Important ("connector literals leak snake_case")', () => {
  it('the exact live shape Task 1 emits — "<category> records" — is humanized, RED if "erp_financials" leaks through raw', () => {
    expect(humanizeConnectorTouch('erp_financials records')).toBe('ERP / Financials records');
    expect(humanizeConnectorTouch('helpdesk records')).toBe('Helpdesk records');
  });
  it('an unknown underscored shape still degrades to Title Case rather than leaking snake_case — RED if an underscore ever survives', () => {
    expect(humanizeConnectorTouch('mcp_stripe_refunds')).not.toMatch(/_/);
  });
  it('a plain English word (spec §11b\'s own illustrative "deals"/"notes") passes through unchanged — RED if this breaks that shape when it does occur', () => {
    expect(humanizeConnectorTouch('deals')).toBe('deals');
    expect(humanizeConnectorTouch('notes')).toBe('notes');
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

  it('connector: the REAL Task 1 payload shape is humanized, not left as snake_case — RED if "erp_financials" appears verbatim in meta (fix round 1, Important)', () => {
    // supabase/functions/_shared/discoveryProposals.ts's proposalsFrom emits
    // reads exactly as [`${row.category} records`] — this is that shape, not
    // the spec's hypothetical "deals"/"notes" illustration.
    const copy = cardCopyFor('connector', {
      provider_key: 'erpnext', label: 'ERPNext', reads: ['erp_financials records'], writes: [],
    }, noOwners);
    expect(copy.meta).toBe('ERPNext · reads ERP / Financials records');
    expect(copy.meta).not.toMatch(/erp_financials/);
  });

  // ⚠ M1 of the 2026-08-15 review. This test used to feed CATEGORY KEYS
  // ("erp_financials") and assert they were humanized — but since BLOCKER 2,
  // Task 1 does not emit category keys here at all. It emits finished display
  // strings built from role_archetypes.system_templates: a label plus the
  // read/write reach in parentheses. Running humanizeSystem over those
  // title-cased every word, so the live shape rendered as "Invoices (AR)
  // (Read/Write)". The fixture below is the REAL payload shape, copied from
  // proposalsFrom's own output, and the assertion is that it is left alone.
  // Red if title-casing ever comes back.
  it('employee: systems are the REAL system_templates strings, rendered verbatim — RED if "(read/write)" is title-cased', () => {
    const copy = cardCopyFor('employee', {
      name: 'Billing & AR Specialist',
      systems: ['Invoices (AR) (read/write)', 'CRM / booking system (read only)'],
    }, noOwners);
    expect(copy.meta).toBe('Systems: Invoices (AR) (read/write), CRM / booking system (read only)');
    expect(copy.meta).not.toMatch(/\(Read\/Write\)/);
    expect(copy.meta).not.toMatch(/\(Read Only\)/);
    expect(copy.detail).toMatch(/supervised/i);
    expect(copy.detail).toMatch(/SOP/i);
  });

  // ⚠ R4 — §11b, "put the fact on the card". evidence_quote is the
  // customer's own sentence, checked VERBATIM against the transcript by
  // supabase/functions/_shared/discoveryProposals.ts, and it is the entire
  // reason this role is being offered rather than one of the other fourteen.
  // The mechanical gate can prove the model did not invent those words; it
  // cannot prove the role fits, and its own header says so. The person
  // reading their own sentence next to the job title is the only thing that
  // can — so hiding it in the Details drawer would leave the judgement to the
  // half of the system that is admittedly incapable of making it.
  // RED if either the quote or the fit_reason falls off the card.
  it('employee: the customer\'s own quoted words are ON THE CARD, next to the fit reason', () => {
    const copy = cardCopyFor('employee', {
      name: 'Google Ads Specialist',
      systems: ['Ads platform (read only)'],
      evidence_quote: 'we do run Google Ads',
      fit_reason: 'They already run Google Ads themselves and nobody is watching the spend.',
    }, noOwners);
    expect(copy.meta).toContain('we do run Google Ads');
    expect(copy.meta).toContain('Systems: Ads platform (read only)');
    expect(copy.detail).toContain('They already run Google Ads themselves');
    // the consequence sentence survives alongside it — the quote must not
    // push "starts supervised, sends nothing" off the card
    expect(copy.detail).toMatch(/supervised/i);
    expect(copy.detail).toMatch(/sends nothing/i);
  });

  // The degraded shape still renders honestly — RED if a payload with no
  // quote (an older row, or a hand-built one) renders an empty quotation.
  it('employee: a card with no quote falls back to the generic sentence, never an empty quotation', () => {
    const copy = cardCopyFor('employee', { name: 'Billing & AR Specialist', systems: ['Invoices (AR) (read/write)'] }, noOwners);
    expect(copy.meta).toBe('Systems: Invoices (AR) (read/write)');
    expect(copy.meta).not.toContain('“');
    expect(copy.detail).toMatch(/^Comes with a published SOP/);
  });

  it('guardrail: the rule sentence is the title, verbatim — RED if it gets paraphrased or truncated', () => {
    const copy = cardCopyFor('guardrail', { rule: 'Never promise a refund over the phone', pattern: 'refund|chargeback' }, noOwners);
    expect(copy.title).toBe('Never promise a refund over the phone');
    expect(copy.meta).toBe('matches: refund|chargeback');
  });

  it('guardrail with a PATTERN claims blocking — RED if the "blocked" sentence disappears for the one case where it is actually true', () => {
    const copy = cardCopyFor('guardrail', { rule: 'Never promise a refund over the phone', pattern: 'refund|chargeback' }, noOwners);
    expect(copy.detail).toMatch(/blocked/i);
  });

  it('guardrail with only a THRESHOLD claims approval, NEVER blocking — RED if "blocked" appears here (fix round 1, Critical 2)', () => {
    // findBlockingMatch (supabase/functions/_shared/guardrailMatch.ts) is
    // pattern-only. A threshold-only guardrail (max_discount_pct /
    // require_approval_over_cents in src/lib/guardrailApi.ts's real
    // GuardrailRuleType union) is an approval gate — nothing "matches" a
    // number, so nothing about it blocks outbound text.
    const copy = cardCopyFor('guardrail', { rule: 'Max 20% discount without VP approval', pattern: null, threshold: 20 }, noOwners);
    expect(copy.detail).not.toMatch(/blocked/i);
    expect(copy.detail).toMatch(/approval/i);
  });

  it('trust_rule: employee + category + cap, all three, on the meta line — RED if any one of the three is missing', () => {
    const copy = cardCopyFor('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 },
      new Map([['billing_ar', 'Morgan']]));
    expect(copy.meta).toBe('Morgan · Erp Financials · up to $10,000');
    expect(copy.title).toContain('Morgan');
    expect(copy.title).toContain('$10,000');
  });

  it('trust_rule: above_cap, when the model supplied one, is on the CARD (not just the drawer) — RED if it never appears (fix round 1, minor)', () => {
    const copy = cardCopyFor('trust_rule', {
      de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000,
      above_cap: 'Above $10,000 it goes to Finance for sign-off.',
    }, new Map([['billing_ar', 'Morgan']]));
    expect(copy.detail).toBe('Above $10,000 it goes to Finance for sign-off.');
  });

  it('trust_rule: with no above_cap supplied, a generic honest fallback is used — RED if this renders empty', () => {
    const copy = cardCopyFor('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 },
      new Map([['billing_ar', 'Morgan']]));
    expect(copy.detail.length).toBeGreaterThan(5);
  });
});

describe('whatAcceptingWrites — every kind states what its acceptance creates', () => {
  const EMPTY: Record<string, unknown> = {};

  it('all 6 kinds return a non-empty, distinct sentence — RED if two kinds accidentally share one generic sentence', () => {
    const sentences = PROPOSAL_KINDS.map((k) => whatAcceptingWrites(k, EMPTY));
    for (const s of sentences) expect(s.length).toBeGreaterThan(10);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('guardrail branches on pattern vs threshold, same as the card — RED if "enforced" appears for a threshold-only guardrail (fix round 1, Critical 2)', () => {
    const patternSentence = whatAcceptingWrites('guardrail', { pattern: 'refund|chargeback', threshold: null });
    const thresholdSentence = whatAcceptingWrites('guardrail', { pattern: null, threshold: 20 });
    expect(patternSentence).toMatch(/block/i);
    expect(thresholdSentence).not.toMatch(/block/i);
    expect(thresholdSentence).toMatch(/approval/i);
    expect(patternSentence).not.toBe(thresholdSentence);
  });

  // ── migration 747: the hire says what it switches on for the WHOLE workspace ──
  //
  // instantiate_role_archetype auto-attaches its archetype's mandatory
  // compliance packs, which materialise guardrail_rules with applies_to='all'
  // and severity='blocking'. Measured live 2026-08-16: 7 of 15 active
  // archetypes carry one, 2 rules each. None of it reached the card, so a
  // customer accepted blocking rules covering every employee they had never
  // been shown.
  describe('employee — the compliance pack a hire attaches', () => {
    const PACK = { pack_key: 'financial_controls', name: 'Financial Controls', rule_count: 2, already_attached: false };

    it('names the pack and counts the blocking rules — RED if accepting can attach workspace-wide blocking rules the card never mentions', () => {
      const s = whatAcceptingWrites('employee', {}, { compliancePacks: [PACK] });
      expect(s).toContain('Financial Controls');
      expect(s).toMatch(/2 blocking rules/);
      expect(s).toMatch(/every employee/i);
    });

    it('a pack the workspace ALREADY has adds no new rules — RED if the card claims 2 more blocking rules for an accept that creates none', () => {
      const s = whatAcceptingWrites('employee', {}, { compliancePacks: [{ ...PACK, already_attached: true }] });
      expect(s).toMatch(/already has/i);
      expect(s).not.toMatch(/2 blocking rules/);
    });

    it('an archetype with no pack says so — RED if silence has to be read as "none"', () => {
      const s = whatAcceptingWrites('employee', {}, { compliancePacks: [] });
      expect(s).toMatch(/no compliance pack/i);
    });

    // ⚠ THE ONE THAT MATTERS MOST. `undefined` means the lookup has not come
    // back. Treating it as "there are none" is the `?? 0` defect this codebase
    // keeps paying for: the card would confidently confirm the absence of a
    // control it never looked for.
    it('an unestablished lookup says it has not been checked — RED if not-yet-known is rendered as none', () => {
      const s = whatAcceptingWrites('employee', {});
      expect(s).toMatch(/not been checked/i);
      expect(s).not.toMatch(/no compliance pack/i);
    });

    it('the four states produce four different sentences — RED if two of them collapse into one', () => {
      const sentences = [
        whatAcceptingWrites('employee', {}),
        whatAcceptingWrites('employee', {}, { compliancePacks: [] }),
        whatAcceptingWrites('employee', {}, { compliancePacks: [PACK] }),
        whatAcceptingWrites('employee', {}, { compliancePacks: [{ ...PACK, already_attached: true }] }),
      ];
      expect(new Set(sentences).size).toBe(4);
    });

    // ══════════════════════════════════════════════════════════════════
    // ⚠⚠ THE DISCLOSURE HAS TO BE WHERE THE DECISION IS.
    //
    // Every test above proves whatAcceptingWrites says the right thing — and
    // whatAcceptingWrites renders ONLY inside the Details drawer
    // (DiscoveryProposalsPage.tsx). Accept sits on the CARD FACE and used to
    // fire on one click with no confirmation. So all of it could be true and a
    // customer could still hire an employee, switch on two workspace-wide
    // blocking rules, and never have the sentence rendered on their screen.
    // Measured: 4 of 18 workspaces held a pack, 14 exposed on the first such
    // hire. These cases are about the card and the confirm gate.
    // ══════════════════════════════════════════════════════════════════
    describe('the card face — cardCopyFor carries the pack, not just the drawer', () => {
      const noOwners = new Map<string, string>();

      it('names the pack and counts the rules ON THE CARD — RED if the whole disclosure is behind "Details" while Accept is not', () => {
        const copy = cardCopyFor('employee', { name: 'Accounts Payable Clerk' }, noOwners, { compliancePacks: [PACK] });
        expect(copy.detail).toContain('Financial Controls');
        expect(copy.detail).toMatch(/2 blocking rules/);
        expect(copy.detail).toMatch(/every employee/i);
      });

      it('says WHOSE employees — RED if the card lets a workspace-wide rule read as a rule about this one hire', () => {
        const copy = cardCopyFor('employee', { name: 'Accounts Payable Clerk' }, noOwners, { compliancePacks: [PACK] });
        expect(copy.detail).toMatch(/not just this one/i);
      });

      it('a pack already on claims no new rules — RED if the card overclaims on a second finance hire', () => {
        const copy = cardCopyFor('employee', { name: 'Second Clerk' }, noOwners,
          { compliancePacks: [{ ...PACK, already_attached: true }] });
        expect(copy.detail).toMatch(/already has on/i);
        expect(copy.detail).not.toMatch(/2 blocking rules/);
      });

      it('an unestablished lookup says so on the card — RED if not-yet-known renders as silence, which reads as "there is none"', () => {
        const copy = cardCopyFor('employee', { name: 'Someone' }, noOwners);
        expect(copy.detail).toMatch(/not been checked yet/i);
      });

      it('an archetype with NO pack adds nothing to the card — RED if the card starts narrating non-events (and the not-checked branch is what keeps this silence honest)', () => {
        const withNone = cardCopyFor('employee', { name: 'Someone' }, noOwners, { compliancePacks: [] });
        const unknown = cardCopyFor('employee', { name: 'Someone' }, noOwners);
        expect(withNone.detail).not.toMatch(/compliance pack/i);
        expect(withNone.detail).not.toBe(unknown.detail);
      });

      it('no other kind grows a pack clause — RED if a connector card starts talking about compliance packs', () => {
        for (const k of PROPOSAL_KINDS) {
          if (k === 'employee') continue;
          const copy = cardCopyFor(k, { rule: 'r', pattern: 'x', label: 'l', name: 'n' }, noOwners,
            { compliancePacks: [PACK] });
          expect(copy.detail).not.toMatch(/compliance pack/i);
        }
      });
    });

    describe('needsAcceptConfirmation — the gate between one click and a hire', () => {
      it('a NEW pack with rules asks first — RED if Accept fires straight through on the one decision that switches on blocking rules', () => {
        expect(needsAcceptConfirmation('employee', { compliancePacks: [PACK] })).toBe(true);
      });

      it('an unestablished lookup asks first — RED if "we could not check" is treated as "there is nothing to disclose"', () => {
        expect(needsAcceptConfirmation('employee')).toBe(true);
        expect(needsAcceptConfirmation('employee', {})).toBe(true);
      });

      it('a pack already on goes straight through — RED if every accept gets a confirmation, because one nobody can avoid is one nobody reads', () => {
        expect(needsAcceptConfirmation('employee', { compliancePacks: [{ ...PACK, already_attached: true }] })).toBe(false);
      });

      it('an archetype with no pack goes straight through', () => {
        expect(needsAcceptConfirmation('employee', { compliancePacks: [] })).toBe(false);
      });

      it('a pack carrying ZERO rules goes straight through — RED if the gate fires on a pack that changes nothing', () => {
        expect(needsAcceptConfirmation('employee', { compliancePacks: [{ ...PACK, rule_count: 0 }] })).toBe(false);
      });

      it('one fresh pack among several already-attached ones still asks — RED if the check reads only the first pack', () => {
        expect(needsAcceptConfirmation('employee', {
          compliancePacks: [{ ...PACK, already_attached: true }, { ...PACK, pack_key: 'tcpa_dnc', name: 'TCPA / DNC' }],
        })).toBe(true);
      });

      it('never fires for a kind that attaches no pack — RED if a connector accept grows a modal it has nothing to say in', () => {
        for (const k of PROPOSAL_KINDS) {
          if (k === 'employee') continue;
          expect(needsAcceptConfirmation(k, { compliancePacks: [PACK] })).toBe(false);
        }
      });
    });

    // ⚠⚠ THE GATE IS NOT THE WIRING, AND THIS PROGRAMME HAS PAID FOR THAT
    // DISTINCTION BEFORE. Everything above proves compliancePackCardClause and
    // needsAcceptConfirmation return the right answers. None of it proves the
    // page ASKS them — and the defect being fixed here was precisely that: the
    // disclosure function was correct, complete, well-tested, and rendered only
    // inside a drawer nobody had to open, while the Accept button next to it
    // called runDecision directly. A pure-function suite that is entirely green
    // is exactly what that looked like from in here.
    //
    // So this reads the page. It is a coarse instrument and it is deliberately
    // coarse: it does not care how the wiring is written, only that a card's
    // Accept cannot reach runDecision without the gate being consulted first.
    describe('the page actually asks — DiscoveryProposalsPage wiring', () => {
      const page = readFileSync('src/pages/tenant/DiscoveryProposalsPage.tsx', 'utf8');

      /** The Accept handler's OWN BODY, not the whole file.
       *
       *  ⚠⚠ THIS EXTRACTION IS THE POINT, AND IT IS HERE BECAUSE THE TWO TESTS
       *  IT REPLACES WERE PROVEN UNABLE TO FAIL — against a bypass that was
       *  briefly REAL ON DISK, not a hypothetical one:
       *
       *      onClick={() => {
       *        void needsAcceptConfirmation(p.kind, acceptContextFor(p));  // discarded
       *        void runDecision(p, 'accepted', null);                      // unconditional
       *      }}
       *
       *  Every accept goes straight through and the confirm modal is dead
       *  code. Both old tests stayed green, and so did the other 69:
       *    · `toMatch(/needsAcceptConfirmation.*\n?.*setAcceptTarget/s)` — the
       *      `s` flag makes `.` match newlines, so `.*` spans the ENTIRE FILE.
       *      The call at the card and the `setAcceptTarget(null)` in the
       *      modal's onClose, 300 lines apart and unrelated, satisfied it.
       *    · `not.toMatch(/onClick=\{\(\)\s*=>\s*void runDecision/)` — pinned
       *      one exact spelling. A braced block body never matches it.
       *  A test that reads the whole file cannot tell a gate from two
       *  statements that happen to mention it. */
      const acceptHandlerBody = (() => {
        const at = page.indexOf("{busy.has(p.id) ? 'Setting up…' : 'Accept'}");
        if (at === -1) return null;
        const open = page.lastIndexOf('onClick={', at);
        if (open === -1) return null;
        // Walk braces from the arrow body so nested blocks are included whole.
        let depth = 0; let i = page.indexOf('{', open + 'onClick='.length);
        const start = i;
        for (; i < page.length; i++) {
          if (page[i] === '{') depth++;
          else if (page[i] === '}') { depth--; if (depth === 0) break; }
        }
        return page.slice(start, i + 1);
      })();

      it('the Accept handler exists and could be isolated — RED if the card stops being findable, which would make every assertion below vacuous', () => {
        expect(acceptHandlerBody, 'could not locate the card Accept onClick body — the assertions below would silently pass over nothing').toBeTruthy();
        expect(acceptHandlerBody!.length).toBeGreaterThan(20);
      });

      it('Accept is GATED, not merely gate-adjacent — RED if the confirmation result is computed and discarded', () => {
        const body = acceptHandlerBody!;
        // The decision must BRANCH on the gate, and the true side must open
        // the confirmation. `[^;]*` rather than `[^)]*` because the condition
        // contains a nested call — acceptContextFor(p) — so a paren-excluding
        // span stops inside it. (That was a real mistake in the first draft of
        // this test, and the test failing on the CORRECT handler is how it was
        // found: an assertion that cannot be wrong about the good case cannot
        // be trusted about the bad one.) A semicolon still bounds it to this
        // one statement.
        expect(body, 'the handler does not branch on needsAcceptConfirmation').toMatch(
          /if\s*\([^;]*needsAcceptConfirmation[^;]*\)/,
        );
        expect(body, 'the true branch does not open the confirmation').toMatch(
          /if\s*\([^;]*needsAcceptConfirmation[^;]*\)\s*setAcceptTarget/,
        );
        // ...and reach the decision ONLY through else.
        expect(body, "runDecision('accepted') is reachable without passing the gate").toMatch(
          /else[\s\S]*runDecision\(\s*p,\s*'accepted'/,
        );
        // And the result must never be thrown away — this is the exact bypass.
        expect(body, 'needsAcceptConfirmation is called and its answer discarded').not.toMatch(
          /void\s+needsAcceptConfirmation/,
        );
      });

      it('there is exactly ONE way to accept from a card — RED if a second, ungated call is added anywhere on the page', () => {
        // Counting, not spelling. Any bypass ADDS an occurrence, whatever
        // shape it takes, and the batch path uses acceptProposal rather than
        // this call so it does not inflate the count.
        const accepts = page.match(/runDecision\(\s*p,\s*'accepted'/g) ?? [];
        expect(accepts, `expected exactly one runDecision(p,'accepted') on the page, found ${accepts.length}`).toHaveLength(1);
        expect(acceptHandlerBody!).toContain("runDecision(p, 'accepted'");
      });

      it('the card copy is built WITH the pack context — RED if cardCopyFor loses its fourth argument and the clause silently disappears from every card', () => {
        expect(page).toMatch(/cardCopyFor\(p\.kind,\s*p\.payload,\s*employeeNameByArchetype,\s*acceptContextFor\(p\)\)/);
      });

      it('the confirmation renders the same sentence the drawer does — RED if the two disclosures become two different claims about one hire', () => {
        // whatAcceptingWrites must appear at least twice: once in the confirm,
        // once in the drawer, both fed by acceptContextFor.
        expect(page.match(/whatAcceptingWrites\(/g) ?? []).toHaveLength(2);
        expect(page.match(/acceptContextFor\(/g) ?? []).not.toHaveLength(0);
      });
    });
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

describe('itemsForBatchMode — fix round 1, Important ("batching is structural for the value, conventional for the wiring")', () => {
  const items: Array<{ kind: ProposalKind; id: string }> = [
    { kind: 'guardrail', id: 'g1' },
    { kind: 'guardrail', id: 'g2' },
    { kind: 'trust_rule', id: 't1' },
    { kind: 'employee', id: 'e1' },
    { kind: 'connector', id: 'c1' },
  ];

  it('THE EXACT BYPASS THE REVIEW NAMED — calling the accept-all path for guardrail returns nothing, not the two guardrail items — RED if this ever returns g1/g2', () => {
    // Before this fix, the page's renderAcceptAllSection(kind) trusted
    // whatever kind it was called with. A single mis-typed
    // renderAcceptAllSection('guardrail') would have rendered these two
    // guardrails inside a bulk "Accept all" checkbox batch with every
    // existing test (which only ever checked batchModeFor in isolation)
    // still green. This is that exact call, one level down from the React
    // component so it's provable without a DOM.
    expect(itemsForBatchMode('guardrail', 'accept_all', items)).toEqual([]);
  });

  it('the same bypass for trust_rule via "department" mode also returns nothing — RED if t1 appears', () => {
    expect(itemsForBatchMode('trust_rule', 'department', items)).toEqual([]);
  });

  it('correct usage still works — RED if this now ALSO returns nothing (the guard must not become a wall)', () => {
    expect(itemsForBatchMode('guardrail', 'never', items).map((i) => i.id)).toEqual(['g1', 'g2']);
    expect(itemsForBatchMode('trust_rule', 'never', items).map((i) => i.id)).toEqual(['t1']);
    expect(itemsForBatchMode('employee', 'department', items).map((i) => i.id)).toEqual(['e1']);
    expect(itemsForBatchMode('connector', 'accept_all', items).map((i) => i.id)).toEqual(['c1']);
  });

  it('even with the right mode, only that kind is returned from a mixed list — RED if a guardrail leaks into an employee department section', () => {
    expect(itemsForBatchMode('employee', 'department', items)).not.toContainEqual(expect.objectContaining({ kind: 'guardrail' }));
  });

  // ── migration 746: employee accepts went LIVE ────────────────────────────
  // §11b's batching rule and the accept gate are two different things, and
  // until 746 nothing distinguished them for 'employee' because the kind could
  // not be accepted at all — an "Accept all N selected" button for a kind whose
  // controls were disabled was not a hazard anyone could reach.
  //
  // It is reachable now. renderAcceptAllSection is the ONLY renderer that draws
  // a bulk-accept control, it calls acceptSelected on everything checked, and
  // its confirmation sentence is written about connectors ("each waiting for
  // your credential"). An employee reaching it would be bulk-hired — real
  // people on the payroll, each with an SOP, watchers and guardrails — behind
  // one click, with a confirmation about credentials. §11b puts employees in a
  // DEPARTMENT batch precisely because that is a grouping device and not a
  // bulk-decide one: every card keeps its own Accept.
  //
  // So this is the same bypass as the guardrail case above, asserted for the
  // kind that just gained the ability to be harmed by it. RED if e1 appears.
  it('employee cannot be dragged into a bulk-accept batch now that hiring is LIVE — RED if e1 appears', () => {
    expect(itemsForBatchMode('employee', 'accept_all', items)).toEqual([]);
  });

  it('...and its real mode is still department, which draws no bulk-accept control at all — RED if batchModeFor(employee) moves', () => {
    expect(batchModeFor('employee')).toBe('department');
    // The two kinds §11b says may never batch, restated here so that "employee
    // is a department batch" cannot be read as "batching got looser".
    expect(batchModeFor('guardrail')).toBe('never');
    expect(batchModeFor('trust_rule')).toBe('never');
  });
});
