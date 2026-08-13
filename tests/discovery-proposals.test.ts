// ============================================================
// PROPOSALS A PERSON COULD ACTUALLY DECIDE ON
// (.superpowers/sdd/2026-08-13-discovery-proposals-and-creation, Task 1)
//
// discoveryCoverage.ts answers "what did the interview hear". This module
// answers the next question: "what does that turn into, and what does a
// human have to be shown before they can say yes". Two functions:
//
//   proposalsFrom(dimensions, coverage, archetypes, options) — PURE, no model
//   call, no I/O. Reads discovery_dimensions.serves_archetypes and each
//   dimension's recorded evidence and emits ProposalDraft objects.
//
//   validatePayload(kind, payload) — the single gate BOTH the pure path and
//   a later model-filled path go through. It REFUSES a payload that does not
//   carry the literal §11b says a person needs to decide on, rather than
//   producing something a person cannot consent to.
//
// ── THE SPLIT, AND WHY IT IS NOT RE-DECIDED HERE ──
// task-1-brief.md specifies proposalsFrom as pure and testable without a
// model. That is true for three of the six kinds and not the other three —
// flagged in progress.md's PRE-FLIGHT note before this task started, with the
// resolution given, not re-opened:
//   PURE (this file derives the full, valid payload with no model):
//     employee        — from a dimension's serves_archetypes + role_archetypes
//     connector       — from matchProvider() over the dimension's evidence text
//     conversation_type — label (the dimension) + owner (the archetype it serves)
//   NOT PURE (this file emits the SHAPE only; a model fills the literal
//   elsewhere, in discovery-interview/index.ts, before it is ever persisted):
//     guardrail  — needs a pattern or threshold (§11b: "you cannot consent to
//                  a block you cannot predict")
//     procedure  — needs a trigger and at least one step
//     trust_rule — needs a cap (§11b: "the only kind where no card is short
//                  enough — it is the one proposal that removes a human")
// validatePayload is what makes the split honest rather than a loophole: a
// model-filled payload that still lacks its literal is refused exactly as a
// hand-built incomplete one would be. Proven below (describe block "the
// split is enforced, not just documented").
//
// ── HARD RULE, tested first because it is the one the whole programme exists
// to protect: only a `heard` dimension may produce anything. parked/skipped/
// not_heard have either no evidence or an explicit "not now" — inventing a
// proposal from either is the exact failure discovery_dimensions.guidance's
// "silence is not coverage" language (migrations 734/735) was written
// against, one layer further downstream.
//
// Every describe block below states, in a comment, the data that would turn
// each assertion red — per the standard: a check that cannot fail is theatre.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';
import {
  proposalsFrom,
  validatePayload,
  matchProvider,
  applyModelFill,
  type ProposalDraft,
  type DiscoveryDimensionForProposals,
  type ArchetypeLike,
  type ProviderCatalogRow,
} from '../supabase/functions/_shared/discoveryProposals.ts';

// ── Step 1's exact snippet, verbatim from task-1-brief.md ──────────────────
describe('a proposal must be decidable', () => {
  it('refuses a guardrail with no pattern or threshold', () => {
    // §11b: "you cannot consent to a block you cannot predict."
    expect(() => validatePayload('guardrail', { rule: 'No refund promises', rule_type: 'blocked_phrase', severity: 'blocking' }))
      .toThrow(/pattern|threshold/i);
  });

  it('refuses an employee proposal that does not say what it can touch', () => {
    expect(() => validatePayload('employee', { name: 'Morgan', department: 'Finance', archetype_key: 'billing_ar' }))
      .toThrow(/system|touch|access/i);
  });

  it('refuses a trust rule with no cap', () => {
    // The one kind that removes a human. No cap = no decision.
    expect(() => validatePayload('trust_rule', { de_ref: 'x', action_category: 'crm', level: 2 }))
      .toThrow(/cap|threshold|amount|confidence/i);
  });

  it('accepts a conversation type with just a label and an owner', () => {
    // A label acts on nothing. Demanding more here is theatre.
    expect(() => validatePayload('conversation_type', { label: 'Billing question', owner_ref: 'de:x' })).not.toThrow();
  });
});

// ── validatePayload, the rest of the contract ───────────────────────────────
describe('validatePayload — every kind, both directions', () => {
  // Red if: validatePayload ever accepts an unrecognised kind silently
  // instead of refusing it — a typo'd kind must not slide through as "no
  // rule for this, so nothing to check".
  it('refuses an unknown kind outright', () => {
    expect(() => validatePayload('sandwich' as never, { anything: true })).toThrow(/kind/i);
  });

  // Red if: a connector payload with no reads and no writes is accepted —
  // §11b: "what it reads/writes" is on the card, the credential step is the
  // SECOND gate, not the only one.
  it('refuses a connector that names nothing it reads or writes', () => {
    expect(() => validatePayload('connector', { provider_key: 'xero', label: 'Xero', category: 'erp_financials', reads: [], writes: [] }))
      .toThrow(/read|writ/i);
  });
  it('accepts a connector that names what it reads', () => {
    expect(() => validatePayload('connector', { provider_key: 'xero', label: 'Xero', category: 'erp_financials', reads: ['erp_financials records'], writes: [] }))
      .not.toThrow();
  });

  // Red if: a procedure with no trigger, or no steps, is accepted — a draft
  // that runs "sometimes, somehow" is not something a person can approve or
  // decline.
  it('refuses a procedure with no trigger', () => {
    expect(() => validatePayload('procedure', { name: 'Dunning', steps: ['send reminder'] }))
      .toThrow(/trigger/i);
  });
  it('refuses a procedure with no steps', () => {
    expect(() => validatePayload('procedure', { name: 'Dunning', trigger: 'invoice 7 days overdue', steps: [] }))
      .toThrow(/step/i);
  });
  it('accepts a procedure with a trigger and at least one step', () => {
    expect(() => validatePayload('procedure', { name: 'Dunning', trigger: 'invoice 7 days overdue', steps: ['send reminder email'] }))
      .not.toThrow();
  });

  // Red if: a guardrail with an empty-string pattern (not merely absent) is
  // accepted — whitespace is not a literal either.
  it('refuses a guardrail whose pattern is only whitespace', () => {
    expect(() => validatePayload('guardrail', { rule: 'No refund promises', pattern: '   ' }))
      .toThrow(/pattern|threshold/i);
  });
  it('accepts a guardrail with a real pattern', () => {
    expect(() => validatePayload('guardrail', { rule: 'No refund promises', pattern: 'refund|chargeback' }))
      .not.toThrow();
  });
  it('accepts a guardrail with a numeric threshold and no pattern', () => {
    expect(() => validatePayload('guardrail', { rule: 'Approval required over ten thousand', threshold: 10000 }))
      .not.toThrow();
  });

  // Red if: an employee payload with an empty systems array (present but
  // empty) is accepted — "present but empty" must fail the same as "absent".
  it('refuses an employee proposal whose systems array is empty', () => {
    expect(() => validatePayload('employee', { name: 'Morgan', systems: [] }))
      .toThrow(/system|touch|access/i);
  });
  it('accepts an employee proposal that names its systems', () => {
    expect(() => validatePayload('employee', { name: 'Morgan', systems: ['erp_financials'] }))
      .not.toThrow();
  });

  // Red if: a trust_rule missing de_ref or action_category is accepted even
  // though it has a cap — the card needs the employee and the category too,
  // not just the number.
  it('refuses a trust rule with a cap but no employee named', () => {
    expect(() => validatePayload('trust_rule', { action_category: 'crm', cap: 500 }))
      .toThrow(/employee|de_ref/i);
  });
  it('accepts a trust rule with employee, category and cap all present', () => {
    expect(() => validatePayload('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 }))
      .not.toThrow();
  });

  // Red if: a conversation_type with a label but no owner is accepted — an
  // unowned conversation type routes to nobody.
  it('refuses a conversation type with no owner', () => {
    expect(() => validatePayload('conversation_type', { label: 'Billing question' }))
      .toThrow(/owner/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REVIEW ROUND 1 fixes (3 Importants + 2 minors accepted; drift guard
// widened for the 3rd minor — see task-1-report.md "Fix round 1").
// ═══════════════════════════════════════════════════════════════════════════

describe('REVIEW ROUND 1, Important 1 — a trust rule cannot reach pending naming no real employee', () => {
  // THE EXACT PAYLOAD THE REVIEW FLAGGED, reproduced verbatim: this used to
  // pass, and fillProposalLiterals' own prompt told the model to write
  // exactly "unassigned" when no employee fit. Red if this ever stops
  // throwing again.
  it('refuses the exact payload the review flagged: de_ref "unassigned"', () => {
    expect(() => validatePayload('trust_rule', { de_ref: 'unassigned', action_category: 'refunds', cap: 500 }))
      .toThrow(/employee|reference|unassigned/i);
  });

  // Red if: any free-text de_ref ("the accounting team", a name with no
  // "archetype:" prefix) is accepted as a real reference.
  it('refuses a de_ref that is prose, not a reference', () => {
    expect(() => validatePayload('trust_rule', { de_ref: 'the accounting team', action_category: 'erp_financials', cap: 500 }))
      .toThrow(/reference/i);
  });

  // Red if: a correctly-shaped de_ref is refused when no membership check
  // was even requested (options omitted) — the shape check alone must be
  // enough to let a well-formed reference through.
  it('accepts a well-shaped de_ref when no membership set was supplied', () => {
    expect(() => validatePayload('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 500 }))
      .not.toThrow();
  });

  // The deployed path (discovery-interview/index.ts's emitProposals) always
  // supplies validDeRefs — the exact "archetype:<key>" set THIS session's own
  // employee proposals produced. Red if: a de_ref outside that real set
  // still passes once the set is supplied, or a de_ref inside it is refused.
  it('refuses a de_ref not among this session\'s real employee proposals', () => {
    expect(() => validatePayload(
      'trust_rule',
      { de_ref: 'archetype:sdr', action_category: 'erp_financials', cap: 500 },
      { validDeRefs: ['archetype:billing_ar', 'archetype:accounting'] },
    )).toThrow(/employee|reference/i);
  });
  it('accepts a de_ref that IS among this session\'s real employee proposals', () => {
    expect(() => validatePayload(
      'trust_rule',
      { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 500 },
      { validDeRefs: ['archetype:billing_ar', 'archetype:accounting'] },
    )).not.toThrow();
  });
});

describe('REVIEW ROUND 1, Important 2 — action_category constrained to the live namespace', () => {
  const LIVE_NAMESPACE = ['action:erp_financials', 'action_execute', 'answer_dock', 'answer_widget', 'writeback:crm'];

  // THE EXACT DANGER THE REVIEW NAMED: an invented category like 'refunds'
  // would be written and would enforce NOTHING, because set_trust_ladder
  // keys enforcement off this exact column against a small real set. Red if
  // this payload — real employee, real cap, INVENTED category — ever passes
  // when the real namespace is supplied.
  it('refuses an invented action_category once the real namespace is known', () => {
    expect(() => validatePayload(
      'trust_rule',
      { de_ref: 'archetype:billing_ar', action_category: 'refunds', cap: 500 },
      { validActionCategories: LIVE_NAMESPACE },
    )).toThrow(/action_category|category/i);
  });

  it('accepts a real, live action_category', () => {
    expect(() => validatePayload(
      'trust_rule',
      { de_ref: 'archetype:billing_ar', action_category: 'action:erp_financials', cap: 500 },
      { validActionCategories: LIVE_NAMESPACE },
    )).not.toThrow();
  });

  // Documented, not silently relied on: when the caller does NOT supply the
  // real namespace (e.g. a standalone caller with no database access),
  // validatePayload cannot fabricate one to check against, so an invented
  // category is not caught by THIS check alone — it still needs a real
  // de_ref to get this far. The deployed path (discovery-interview/
  // index.ts's emitProposals) always fetches and supplies the real set —
  // proven below, against the ACTUAL live public.trust_policies namespace,
  // not a hardcoded stand-in for it.
  it('honestly does not check namespace membership when no real set is supplied', () => {
    expect(() => validatePayload(
      'trust_rule',
      { de_ref: 'archetype:billing_ar', action_category: 'refunds', cap: 500 },
    )).not.toThrow();
  });
});

const runLiveNamespace = adminTokenAvailable() ? describe : describe.skip;
runLiveNamespace('REVIEW ROUND 1, Important 2 — grounded against the REAL live trust_policies namespace', () => {
  it('refuses an invented category and accepts a real one, both checked against the live database', async () => {
    const rows = await runQuery<{ action_category: string }>(
      'select distinct action_category from public.trust_policies where action_category is not null',
    );
    const liveCategories = rows.map((r) => r.action_category);
    // Vacuity guard: red if the live namespace has shrunk to nothing, or if
    // 'refunds' (the review's own example of an invented category) has
    // somehow become real — either would make this probe prove nothing.
    if (liveCategories.length === 0) {
      throw new Error('vacuity guard: public.trust_policies has no action_category values — cannot prove the namespace check against nothing');
    }
    if (liveCategories.includes('refunds')) {
      throw new Error('vacuity guard: "refunds" is now a real live action_category — pick a different invented example');
    }
    console.log(`checked against ${liveCategories.length} real live action_category value(s): ${liveCategories.join(', ')}`);

    expect(() => validatePayload(
      'trust_rule',
      { de_ref: 'archetype:billing_ar', action_category: 'refunds', cap: 500 },
      { validActionCategories: liveCategories },
    )).toThrow(/action_category|category/i);

    expect(() => validatePayload(
      'trust_rule',
      { de_ref: 'archetype:billing_ar', action_category: liveCategories[0], cap: 500 },
      { validActionCategories: liveCategories },
    )).not.toThrow();
  });
});

describe('REVIEW ROUND 1, Important 3 — applyModelFill whitelists per kind', () => {
  // THE EXACT DANGER THE REVIEW NAMED: a model response that tries to
  // overwrite `rule` itself (breaking §11b's "verbatim" requirement) or
  // inject arbitrary keys. Red if either survives into the merged payload.
  it('refuses to let a guardrail fill overwrite `rule` or inject unrelated keys', () => {
    const payload = { rule: 'No refund promises', pattern: null, threshold: null, severity: 'blocking' };
    const adversarialFill = {
      rule: 'Actually, refunds are always fine',   // must NOT overwrite the verbatim rule sentence
      pattern: 'refund|chargeback',                 // whitelisted — must survive
      severity: 'advisory',                          // NOT whitelisted for guardrail fill — must be dropped
      level: 5,                                       // NOT whitelisted at all — must be dropped
    };
    const merged = applyModelFill('guardrail', payload, adversarialFill);
    expect(merged.rule).toBe('No refund promises');
    expect(merged.pattern).toBe('refund|chargeback');
    expect(merged.severity).toBe('blocking'); // unchanged from the original payload, not the fill's 'advisory'
    expect(merged.level).toBeUndefined();
  });

  it('refuses to let a trust_rule fill inject keys outside its whitelist', () => {
    const payload = { de_ref: null, action_category: null, cap: null, evidence: 'approvals over 10k need sign-off' };
    const adversarialFill = {
      de_ref: 'archetype:accounting',
      action_category: 'action:erp_financials',
      cap: 10000,
      above_cap: 'a second approver is required',
      evidence: 'INJECTED — this should never overwrite the real evidence field',
      created_object_id: '00000000-0000-0000-0000-000000000000', // NOT whitelisted — must be dropped
    };
    const merged = applyModelFill('trust_rule', payload, adversarialFill);
    expect(merged.de_ref).toBe('archetype:accounting');
    expect(merged.action_category).toBe('action:erp_financials');
    expect(merged.cap).toBe(10000);
    expect(merged.above_cap).toBe('a second approver is required');
    expect(merged.evidence).toBe('approvals over 10k need sign-off'); // NOT overwritten
    expect(merged.created_object_id).toBeUndefined();
  });

  it('writes nothing at all for a pure kind (defensive — not reachable via the real emission path)', () => {
    const merged = applyModelFill('employee', { name: 'Morgan', systems: ['erp_financials'] }, { name: 'INJECTED', systems: ['anything'] });
    expect(merged.name).toBe('Morgan');
    expect(merged.systems).toEqual(['erp_financials']);
  });

  it('never mutates the original payload or fill objects (pure)', () => {
    const payload = { rule: 'No refunds', pattern: null };
    const fill = { pattern: 'refund|chargeback' };
    const merged = applyModelFill('guardrail', payload, fill);
    expect(payload.pattern).toBeNull();
    expect(merged).not.toBe(payload);
  });
});

describe('REVIEW ROUND 1, minor 1 — prose no longer passes where a literal is required', () => {
  // Red if: a threshold or cap that is plainly prose ("as appropriate",
  // "whatever seems reasonable") is accepted as a literal a person could
  // predict against.
  it('refuses a guardrail threshold that is prose, not a number', () => {
    expect(() => validatePayload('guardrail', { rule: 'Approval required', threshold: 'as appropriate' }))
      .toThrow(/pattern|threshold/i);
  });
  it('refuses a trust_rule cap that is prose, not a number', () => {
    expect(() => validatePayload('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 'whatever seems reasonable' }))
      .toThrow(/cap|threshold|amount|confidence/i);
  });
  it('accepts a numeric-looking string cap ("$10,000") — still a real literal, just formatted as text', () => {
    expect(() => validatePayload('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: '$10,000' }))
      .not.toThrow();
  });

  // THE EXACT PAYLOAD THE REVIEW FLAGGED, reproduced verbatim: "A pattern
  // that is a sentence is not a pattern."
  it('refuses a guardrail pattern that reads as a sentence', () => {
    expect(() => validatePayload('guardrail', { rule: 'Do not upset customers', pattern: 'anything the customer might find upsetting' }))
      .toThrow(/pattern|threshold/i);
  });
  it('still accepts a short, real, multi-word pattern', () => {
    expect(() => validatePayload('guardrail', { rule: 'No refund promises', pattern: 'refund|chargeback|free month' }))
      .not.toThrow();
  });
});

describe('REVIEW ROUND 1, minor 2 — array-content predicate no longer fooled either direction', () => {
  // THE EXACT PAYLOAD THE REVIEW FLAGGED: a bare number is not a real system
  // name. Red if `systems: [42]` is ever again treated as "employee names a
  // system it can touch".
  it('refuses an employee whose systems array holds only a bare number', () => {
    expect(() => validatePayload('employee', { name: 'Morgan', systems: [42] }))
      .toThrow(/system|touch|access/i);
  });
  // THE EXACT PAYLOAD THE REVIEW FLAGGED: an object-shaped step is not a
  // string a person can read on a card — it must be refused (not silently
  // dropped and forgotten), same as zero steps.
  it('refuses a procedure whose steps array holds only an object, not a string', () => {
    expect(() => validatePayload('procedure', { name: 'Dunning', trigger: 'invoice overdue', steps: [{ text: 'send a reminder' }] }))
      .toThrow(/step/i);
  });
  it('still accepts a real array of plain-string steps', () => {
    expect(() => validatePayload('procedure', { name: 'Dunning', trigger: 'invoice overdue', steps: ['send a reminder email', 'escalate to Finance'] }))
      .not.toThrow();
  });
});

// ── proposalsFrom — the hard rule ───────────────────────────────────────────
const DIMS: DiscoveryDimensionForProposals[] = [
  { key: 'what_we_do', title: 'What the business does', serves_archetypes: [], produces: [] },
  { key: 'how_customers_reach_us', title: 'How customers reach us', serves_archetypes: ['front_desk', 'support_agent'], produces: [] },
  { key: 'money_in', title: 'How money comes in', serves_archetypes: ['billing_ar'], produces: [] },
  { key: 'money_out', title: 'Where money goes out', serves_archetypes: ['accounting'], produces: [] },
  { key: 'the_workforce_itself', title: 'The workforce itself', serves_archetypes: ['planned_hr'], produces: [] },
  { key: 'must_never_happen', title: 'What must never happen', serves_archetypes: [], produces: [] },
  { key: 'who_signs_off', title: 'Who signs off', serves_archetypes: [], produces: [] },
];

const ARCHETYPES: ArchetypeLike[] = [
  { key: 'front_desk', name: 'Front Desk Receptionist', domain: 'reception', required_connector_categories: ['knowledge_base'] },
  { key: 'support_agent', name: 'Support Agent', domain: 'customer_support', required_connector_categories: ['helpdesk', 'knowledge_base'] },
  { key: 'billing_ar', name: 'Billing & AR Specialist', domain: 'Finance Operations', required_connector_categories: ['erp_financials'] },
  { key: 'accounting', name: 'Accounting Specialist', domain: 'Accounting', required_connector_categories: ['erp_financials'] },
];

const CATALOG: ProviderCatalogRow[] = [
  { provider_key: 'xero', label: 'Xero', category: 'erp_financials', aliases: ['xero'] },
  { provider_key: 'hubspot', label: 'HubSpot', category: 'crm', aliases: ['hubspot', 'hub spot'] },
];

describe('proposalsFrom — only heard dimensions ever produce anything', () => {
  // Red if: a proposal is emitted with source_dimension 'money_out' (parked),
  // 'must_never_happen' (skipped) or 'who_signs_off' (not_heard) — none of
  // those three carry evidence a proposal could be built from.
  it('proposes nothing for parked, skipped or not_heard dimensions', () => {
    const coverage = {
      what_we_do: { state: 'heard' as const, evidence: 'we run a two-location dental practice' },
      how_customers_reach_us: { state: 'heard' as const, evidence: 'phone and email; calls go to the front desk' },
      money_in: { state: 'parked' as const, evidence: null },
      money_out: { state: 'parked' as const, evidence: null },
      the_workforce_itself: { state: 'skipped' as const, evidence: 'we outsource payroll, not our problem' },
      must_never_happen: { state: 'skipped' as const, evidence: 'nothing off limits was ever named' },
      who_signs_off: { state: 'not_heard' as const, evidence: null },
    };
    const drafts = proposalsFrom(DIMS, coverage, ARCHETYPES);
    const sources = new Set(drafts.map((d) => d.source_dimension));
    expect(sources.has('money_in')).toBe(false);
    expect(sources.has('money_out')).toBe(false);
    expect(sources.has('the_workforce_itself')).toBe(false);
    expect(sources.has('must_never_happen')).toBe(false);
    expect(sources.has('who_signs_off')).toBe(false);
    // and it DID propose something for the two heard dimensions — a suite
    // that asserts only absence, with nothing ever present, would pass on a
    // function that proposes nothing for ANY input.
    expect(sources.has('how_customers_reach_us')).toBe(true);
  });

  // Red if: a dimension entirely absent from the coverage map (never even
  // seeded) is treated as heard rather than skipped over silently.
  it('proposes nothing for a dimension missing from the coverage map entirely', () => {
    const drafts = proposalsFrom(DIMS, {}, ARCHETYPES);
    expect(drafts).toEqual([]);
  });

  // Red if: what_we_do (serves_archetypes: [], no structural kind mapped)
  // being heard produces a phantom proposal — it is pure vocabulary, never a
  // role or a card by itself.
  it('produces nothing at all for what_we_do even when heard', () => {
    const drafts = proposalsFrom(DIMS, {
      what_we_do: { state: 'heard', evidence: 'a two-location dental practice' },
    }, ARCHETYPES);
    expect(drafts).toEqual([]);
  });
});

describe('proposalsFrom — employee (pure, no model)', () => {
  // Red if: an employee draft is missing name/department/systems, or the
  // systems list is empty despite the archetype naming a real category —
  // either would fail validatePayload downstream.
  it('derives a complete, self-validating employee draft from serves_archetypes', () => {
    const drafts = proposalsFrom(DIMS, {
      how_customers_reach_us: { state: 'heard', evidence: 'they call and email; calls go to the front desk' },
    }, ARCHETYPES);
    const employees = drafts.filter((d) => d.kind === 'employee');
    expect(employees.map((d) => d.payload.archetype_key).sort()).toEqual(['front_desk', 'support_agent']);
    for (const d of employees) {
      expect(d.needs_model_fill).toBe(false);
      expect(() => validatePayload('employee', d.payload)).not.toThrow();
    }
  });

  // Red if: the_workforce_itself (serves_archetypes: ['planned_hr']) heard
  // produces an "employee" proposal for a role that does not exist yet — a
  // capability gap must never be silently staffed.
  it('never proposes an employee for a planned_ (unstaffable) archetype', () => {
    const drafts = proposalsFrom(DIMS, {
      the_workforce_itself: { state: 'heard', evidence: 'we run payroll through Gusto biweekly' },
    }, ARCHETYPES);
    expect(drafts.filter((d) => d.kind === 'employee')).toEqual([]);
  });

  // Red if: an archetype is proposed twice because two different heard
  // dimensions both name it (billing_ar-like overlap) — this must dedupe to
  // exactly one card per archetype, or the "40 items, batch by kind" design
  // in §11b starts from an inflated count.
  it('proposes each archetype at most once even when multiple dimensions name it', () => {
    const dims: DiscoveryDimensionForProposals[] = [
      { key: 'money_in', title: 'How money comes in', serves_archetypes: ['billing_ar'], produces: [] },
      { key: 'money_out', title: 'Where money goes out', serves_archetypes: ['billing_ar'], produces: [] },
    ];
    const drafts = proposalsFrom(dims, {
      money_in: { state: 'heard', evidence: 'we invoice monthly out of Xero, net 30' },
      money_out: { state: 'heard', evidence: 'AP reconciled monthly alongside the bank' },
    }, ARCHETYPES);
    expect(drafts.filter((d) => d.kind === 'employee' && d.payload.archetype_key === 'billing_ar')).toHaveLength(1);
  });

  // Red if: a dimension names an archetype key that does not exist in the
  // archetypes list passed in (a stale/typo'd serves_archetypes value) and
  // the function invents a role for it anyway instead of silently skipping.
  it('never invents an employee for an archetype key that does not resolve', () => {
    const dims: DiscoveryDimensionForProposals[] = [
      { key: 'money_in', title: 'How money comes in', serves_archetypes: ['no_such_archetype'], produces: [] },
    ];
    const drafts = proposalsFrom(dims, { money_in: { state: 'heard', evidence: 'evidence text' } }, ARCHETYPES);
    expect(drafts.filter((d) => d.kind === 'employee')).toEqual([]);
  });
});

describe('proposalsFrom — connector (pure, via matchProvider)', () => {
  // Red if: a connector draft is emitted with no provider_key, or with
  // reads/writes both empty (matchProvider matched, but the derivation
  // forgot to attach what it reads) — either fails validatePayload.
  it('derives a complete, self-validating connector draft from matched evidence', () => {
    const drafts = proposalsFrom(DIMS, {
      money_in: { state: 'heard', evidence: 'we invoice monthly out of Xero, net 30' },
    }, ARCHETYPES, { providerCatalog: CATALOG });
    const connectors = drafts.filter((d) => d.kind === 'connector');
    expect(connectors.map((d) => d.payload.provider_key)).toEqual(['xero']);
    expect(connectors[0].needs_model_fill).toBe(false);
    expect(() => validatePayload('connector', connectors[0].payload)).not.toThrow();
  });

  // Red if: evidence naming no known provider still produces a connector
  // draft (a hallucinated match) instead of proposing nothing.
  it('proposes no connector when nothing in the evidence matches the catalog', () => {
    const drafts = proposalsFrom(DIMS, {
      money_in: { state: 'heard', evidence: 'we invoice out of a system nobody named' },
    }, ARCHETYPES, { providerCatalog: CATALOG });
    expect(drafts.filter((d) => d.kind === 'connector')).toEqual([]);
  });

  // Red if: the same provider mentioned in two different heard dimensions'
  // evidence produces two separate connector drafts instead of one.
  it('proposes each matched provider at most once across the whole session', () => {
    const dims: DiscoveryDimensionForProposals[] = [
      { key: 'money_in', title: 'How money comes in', serves_archetypes: [], produces: [] },
      { key: 'money_out', title: 'Where money goes out', serves_archetypes: [], produces: [] },
    ];
    const drafts = proposalsFrom(dims, {
      money_in: { state: 'heard', evidence: 'we invoice out of Xero' },
      money_out: { state: 'heard', evidence: 'AP is also reconciled in Xero' },
    }, ARCHETYPES, { providerCatalog: CATALOG });
    expect(drafts.filter((d) => d.kind === 'connector')).toHaveLength(1);
  });
});

describe('proposalsFrom — conversation_type (pure)', () => {
  // Red if: the label or owner_ref is missing/empty on a heard
  // how_customers_reach_us dimension.
  it('derives a complete, self-validating conversation_type draft', () => {
    const drafts = proposalsFrom(DIMS, {
      how_customers_reach_us: { state: 'heard', evidence: 'they call and email' },
    }, ARCHETYPES);
    const ct = drafts.filter((d) => d.kind === 'conversation_type');
    expect(ct).toHaveLength(1);
    expect(ct[0].needs_model_fill).toBe(false);
    expect(() => validatePayload('conversation_type', ct[0].payload)).not.toThrow();
  });
});

// ── The split is enforced, not just documented ──────────────────────────────
describe('the split is enforced, not just documented', () => {
  // Red if: proposalsFrom's own guardrail/procedure/trust_rule shapes
  // silently pass validatePayload without a model ever touching them — that
  // would mean the "refusal is the feature" guarantee is fiction, and a card
  // with no predictable literal could reach a person.
  it('marks guardrail/procedure/trust_rule drafts as needing a model, and their raw shape fails validatePayload', () => {
    const drafts = proposalsFrom(DIMS, {
      must_never_happen: { state: 'heard', evidence: 'never promise a refund without a manager sign-off' },
      who_signs_off: { state: 'heard', evidence: 'journal entries over ten thousand need a second approver' },
      money_in: { state: 'heard', evidence: 'we invoice monthly, and chase overdue accounts every week' },
    }, ARCHETYPES);

    const guardrail = drafts.find((d) => d.kind === 'guardrail');
    const trust = drafts.find((d) => d.kind === 'trust_rule');
    expect(guardrail, 'must_never_happen must propose a guardrail shape').toBeTruthy();
    expect(trust, 'who_signs_off must propose a trust_rule shape').toBeTruthy();
    expect(guardrail!.needs_model_fill).toBe(true);
    expect(trust!.needs_model_fill).toBe(true);
    // guardrail's raw shape already carries `rule` (the evidence sentence
    // itself needs no model), so it fails EXACTLY on the missing literal —
    // the sharpest possible proof of the split.
    expect(() => validatePayload('guardrail', guardrail!.payload)).toThrow(/pattern|threshold/i);
    // trust_rule's raw shape is missing de_ref/action_category too (the
    // model has to attribute the evidence to a specific employee and
    // category — proposalsFrom cannot know which), so the raw shape throws
    // on the FIRST missing field, whichever that is — still proving it
    // cannot pass validatePayload unfilled.
    expect(() => validatePayload('trust_rule', trust!.payload)).toThrow();
    // Filling only de_ref/action_category (still no cap) must fail on
    // EXACTLY the literal — proving the cap check is real and reachable,
    // not shadowed by the earlier ones.
    const partiallyFilledTrust = { ...trust!.payload, de_ref: 'archetype:accounting', action_category: 'erp_financials' };
    expect(() => validatePayload('trust_rule', partiallyFilledTrust)).toThrow(/cap|threshold|amount|confidence/i);

    // and once a model (simulated here) fills every missing literal, the
    // exact same validatePayload gate accepts it — proving one gate serves
    // both paths, not two.
    const filledGuardrail = { ...guardrail!.payload, pattern: 'refund|chargeback' };
    const filledTrust = { ...trust!.payload, de_ref: 'archetype:accounting', action_category: 'erp_financials', cap: 10000 };
    expect(() => validatePayload('guardrail', filledGuardrail)).not.toThrow();
    expect(() => validatePayload('trust_rule', filledTrust)).not.toThrow();
  });

  // Red if: a heard money_in dimension does NOT propose a procedure shape at
  // all, silently dropping "overdue-invoice procedure" (734's own stated
  // product of this dimension) from the pipeline.
  it('money_in proposes a procedure shape that needs a model before it validates', () => {
    const drafts = proposalsFrom(DIMS, {
      money_in: { state: 'heard', evidence: 'invoices unpaid past 30 days get chased weekly by Finance' },
    }, ARCHETYPES);
    const procedure = drafts.find((d) => d.kind === 'procedure');
    expect(procedure).toBeTruthy();
    expect(procedure!.needs_model_fill).toBe(true);
    // Raw shape is missing name/trigger/steps all at once — throws on
    // whichever comes first, still proving it cannot pass unfilled.
    expect(() => validatePayload('procedure', procedure!.payload)).toThrow();
    // Filling name + trigger (still zero steps) must fail on EXACTLY the
    // steps check.
    const noSteps = { ...procedure!.payload, name: 'Dunning', trigger: 'invoice 7 days overdue' };
    expect(() => validatePayload('procedure', noSteps)).toThrow(/step/i);
    // And the fully model-filled version passes the same gate.
    const filled = { ...noSteps, steps: ['send a reminder email'] };
    expect(() => validatePayload('procedure', filled)).not.toThrow();
  });
});

// ── matchProvider — drift guard against src/lib/connectorApi.ts ────────────
// discoveryProposals.ts cannot import src/lib/connectorApi.ts directly: that
// module's top-level `import { supabase } from '../supabase'` calls
// createClient(...) against import.meta.env.VITE_* at MODULE LOAD TIME, which
// is exactly the shape discoveryCoverage.ts's own header documents as fatal
// under Deno (no import.meta.env there) — it would break the deployed
// discovery-interview function the moment it tried to import this module.
// So the matching ALGORITHM (not the 75-row PROVIDERS catalog, which stays
// exactly once, in the database) is duplicated, deliberately, in
// discoveryProposals.ts. This test is what keeps that duplication honest:
// red if the two implementations ever disagree on a single case below.
describe('matchProvider — duplicated on purpose, drift-guarded here', () => {
  const catalog: ProviderCatalogRow[] = [
    { provider_key: 'xero', label: 'Xero', category: 'erp_financials', aliases: ['xero', 'zero', 'books'] },
    { provider_key: 'hubspot', label: 'HubSpot', category: 'crm', aliases: ['hubspot', 'hub spot'] },
    { provider_key: 'close', label: 'Close', category: 'crm', aliases: [] },
  ];
  const cases = [
    'we use HubSpot',
    'we invoice out of Xero, net 30',
    'we close deals on monday and the team meets in front of the box',
    'We use Close for our pipeline',
    'nothing here matches anything',
    '',
  ];

  it('agrees with src/lib/connectorApi.ts matchProvider on every case', async () => {
    const real = await import('../src/lib/connectorApi');
    for (const text of cases) {
      // REVIEW ROUND 1, minor 3: compare the FULL match object our own
      // payload actually uses (matched_on too, not just provider_key +
      // confidence) — red if the two implementations ever disagree on WHICH
      // alias/label text triggered the match, even if they agree on the
      // provider and confidence.
      const ours = matchProvider(text, catalog).map((m) => `${m.provider_key}:${m.confidence}:${m.matched_on}`).sort();
      const theirs = real.matchProvider(text, catalog).map((m) => `${m.provider_key}:${m.confidence}:${m.matched_on}`).sort();
      expect(ours, `mismatch on "${text}"`).toEqual(theirs);
    }
  });
});

// REVIEW ROUND 1, minor 3 (accepted — cheap via the existing runQuery
// helper): the drift guard above proves the two implementations agree on a
// 3-row fixture. This widens it to the REAL, live 75-row catalog — the one
// difference that matters most (AMBIGUOUS_ALIASES filtering, which only
// bites with the full alias set) is invisible on a 3-row fixture and would
// not be invisible here.
runLiveNamespace('matchProvider — duplicated on purpose, drift-guarded against the LIVE 75-row catalog', () => {
  it('agrees with src/lib/connectorApi.ts matchProvider against the real, live provider_providers catalog', async () => {
    const real = await import('../src/lib/connectorApi');
    const liveCatalog = await runQuery<ProviderCatalogRow>(
      'select provider_key, label, category, aliases from public.connector_providers where active',
    );
    if (liveCatalog.length < 50) {
      throw new Error(`vacuity guard: only ${liveCatalog.length} live catalog row(s) — expected 50+, this probe would not exercise the full alias set`);
    }
    const liveCases = [
      'we use HubSpot',
      'we invoice out of Xero, net 30',
      'we close deals on monday and the team meets in front of the box',
      'tickets go through Zendesk, and we run payroll in Gusto',
      'we track everything in a spreadsheet, nothing fancier',
      'We use Stripe for billing and Slack for the team',
      'we use slack', // lowercase — AMBIGUOUS_ALIASES trades this recall away, on purpose
    ];
    let totalMatches = 0;
    for (const text of liveCases) {
      const ours = matchProvider(text, liveCatalog).map((m) => `${m.provider_key}:${m.confidence}:${m.matched_on}`).sort();
      const theirs = real.matchProvider(text, liveCatalog).map((m) => `${m.provider_key}:${m.confidence}:${m.matched_on}`).sort();
      expect(ours, `mismatch on "${text}" against the live catalog`).toEqual(theirs);
      totalMatches += ours.length;
    }
    console.log(`drift guard: ${liveCases.length} case(s) against ${liveCatalog.length} live catalog row(s), ${totalMatches} total match(es), zero disagreements`);
  });
});

// ── Grounded against the real, live spine — not only fixtures ──────────────
// The programme's own ledger (design doc §12, "carried decisions and
// gotchas"): "Test a pure function against the real seeded data, not only
// its fixture." Both per-task reviews on the systems-memory plan passed the
// matcher against fixtures alone; only crossing it against the whole-branch
// live data caught a Critical. Guarded by adminTokenAvailable() so the suite
// still runs offline via the fixtures above — this arm is additive, not a
// replacement.
const run = adminTokenAvailable() ? describe : describe.skip;

run('proposalsFrom against the real, live spine', () => {
  it('produces self-validating employee and connector drafts from the real 14 dimensions, 15 archetypes and provider catalog', async () => {
    const dimRows = await runQuery<{ key: string; title: string; serves_archetypes: string[]; produces: string[] }>(
      'select key, title, serves_archetypes, produces from public.discovery_dimensions where active order by ordinal',
    );
    const archRows = await runQuery<{ key: string; name: string; domain: string; required_connector_categories: string[] }>(
      "select key, name, domain, required_connector_categories from public.role_archetypes where status = 'active'",
    );
    const catalogRows = await runQuery<ProviderCatalogRow>(
      'select provider_key, label, category, aliases from public.connector_providers where active',
    );
    // Vacuity guard: red if the live spine has drifted away from the shape
    // these assertions assume (a live provider named "xero", a live
    // archetype "billing_ar" serving money_in).
    if (!dimRows.some((d) => d.key === 'money_in' && d.serves_archetypes.includes('billing_ar'))
        || !catalogRows.some((p) => p.provider_key === 'xero')) {
      throw new Error('vacuity guard: money_in/billing_ar or the xero catalog row no longer match this probe\'s assumptions — update the probe, do not delete it');
    }

    const coverage = {
      money_in: { state: 'heard' as const, evidence: 'we invoice monthly out of Xero, net 30, and chase overdue accounts weekly' },
      how_customers_reach_us: { state: 'heard' as const, evidence: 'customers call and email; calls go to the front desk' },
    };
    const drafts = proposalsFrom(dimRows, coverage, archRows, { providerCatalog: catalogRows });
    expect(drafts.length).toBeGreaterThan(0);
    console.log(`grounded run: ${drafts.length} draft(s) from ${dimRows.length} real dimensions / ${archRows.length} real archetypes / ${catalogRows.length} real providers`);

    const employee = drafts.find((d) => d.kind === 'employee' && d.payload.archetype_key === 'billing_ar');
    expect(employee, 'billing_ar employee draft must be present for a heard money_in').toBeTruthy();
    expect(() => validatePayload('employee', employee!.payload)).not.toThrow();

    const connector = drafts.find((d) => d.kind === 'connector' && d.payload.provider_key === 'xero');
    expect(connector, 'xero connector draft must be present — "out of Xero" is an exact-label match').toBeTruthy();
    expect(() => validatePayload('connector', connector!.payload)).not.toThrow();

    // Every real archetype today carries at least one required_connector_category
    // (checked live 2026-08-13: all 15 do) — so EVERY employee draft this
    // function ever emits from the real catalog must self-validate. Red if
    // any archetype regresses to an empty categories array without this
    // catching it.
    for (const d of drafts.filter((x) => x.kind === 'employee')) {
      expect(() => validatePayload('employee', d.payload)).not.toThrow();
    }
  });
});
