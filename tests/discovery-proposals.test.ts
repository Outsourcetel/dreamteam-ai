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
  applyFillToDraft,
  vocabularyOrUndefined,
  FILL_WHITELIST,
  ROLE_ARCHETYPE_COLUMNS,
  ROLE_ARCHETYPE_SELECT,
  type ProposalDraft,
  type DiscoveryDimensionForProposals,
  type ArchetypeLike,
  type ProviderCatalogRow,
  type EvidenceSource,
} from '../supabase/functions/_shared/discoveryProposals.ts';

// ── A valid employee payload ────────────────────────────────────────────────
// Since 2026-08-15 an employee payload needs FIVE things, not two: a name,
// the systems it can touch, the evidence text of the dimension(s) that
// nominated it, a fit_reason, and a VERBATIM evidence_quote out of that
// evidence. Wherever a test below needs "a valid employee" rather than to
// exercise one specific refusal, it spreads this and overrides the one field
// under test — so adding a sixth requirement later breaks one constant, not
// fifteen assertions.
const VALID_EMPLOYEE: Record<string, unknown> = {
  name: 'Morgan',
  systems: ['Invoices (AR) (read/write)'],
  evidence: 'we invoice monthly out of Xero and chase overdue accounts weekly',
  evidence_quote: 'chase overdue accounts weekly',
  fit_reason: 'They invoice monthly and chase overdue accounts by hand every week.',
};

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
  it('accepts an employee proposal that names its systems (and grounds why it fits)', () => {
    expect(() => validatePayload('employee', VALID_EMPLOYEE)).not.toThrow();
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

  it('writes nothing at all for a genuinely pure kind (connector — defensive, not reachable via the real emission path)', () => {
    const merged = applyModelFill('connector', { provider_key: 'xero', reads: ['erp_financials records'] }, { provider_key: 'INJECTED', reads: ['anything'] });
    expect(merged.provider_key).toBe('xero');
    expect(merged.reads).toEqual(['erp_financials records']);
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
// serves_archetypes copied from the LIVE public.discovery_dimensions rows,
// read 2026-08-15 — the width of these lists IS the defect's raw material
// (winning_business nominates six roles the moment the dimension is heard),
// so trimming them for tidiness would test a spine that does not exist.
// ⚠ ORDER MATTERS AND MIRRORS THE LIVE ORDINALS. winning_business is ordinal
// 5 and systems_of_record is ordinal 9, so winning_business wins the dedupe
// for every archetype they share — which is precisely the shape BLOCKER 1
// (2026-08-15 review) fires on. Re-ordering these two makes the R1 block
// below prove the opposite of what it says it proves.
const DIMS: DiscoveryDimensionForProposals[] = [
  { key: 'what_we_do', title: 'What the business does', serves_archetypes: [], produces: [] },
  { key: 'how_customers_reach_us', title: 'How customers reach us', serves_archetypes: ['front_desk', 'support_agent', 'it_helpdesk'], produces: [] },
  { key: 'winning_business', title: 'How we win business', serves_archetypes: ['sdr', 'bdr', 'marketing', 'google_ads', 'seo', 'social_media'], produces: [] },
  { key: 'money_in', title: 'How money comes in', serves_archetypes: ['billing_ar'], produces: [] },
  { key: 'money_out', title: 'Where money goes out', serves_archetypes: ['accounting'], produces: [] },
  // Live serves_archetypes verbatim (ordinal 9, the widest list on the whole
  // spine at 13 entries). Four of them — cs_manager, renewal_manager,
  // onboarding, fpa — deliberately do NOT appear in ARCHETYPES below, so this
  // fixture also keeps exercising the "names an archetype key that does not
  // resolve" path with real data rather than an invented `no_such_archetype`.
  {
    key: 'systems_of_record', title: 'Where the record lives',
    serves_archetypes: ['bdr', 'sdr', 'cs_manager', 'renewal_manager', 'accounting', 'billing_ar', 'onboarding', 'support_agent', 'it_helpdesk', 'seo', 'fpa', 'google_ads', 'social_media'],
    produces: [],
  },
  { key: 'the_workforce_itself', title: 'The workforce itself', serves_archetypes: ['planned_hr'], produces: [] },
  { key: 'must_never_happen', title: 'What must never happen', serves_archetypes: [], produces: [] },
  { key: 'who_signs_off', title: 'Who signs off', serves_archetypes: [], produces: [] },
];

// ⚠ COPIED FROM THE LIVE public.role_archetypes ROWS, read 2026-08-15 — key,
// name, domain, description, required_connector_categories AND
// system_templates all verbatim. The last two matter most: BLOCKER 2
// (task-3-contract.md §7) is precisely that they DISAGREE, so a fixture that
// invented a tidy agreement between them could not catch the bug. front_desk
// is kept exactly as live because it is the sharpest case — the card used to
// name `knowledge_base`, a system the employee never gets, and omit `crm`,
// the one it does. The live-spine describe block at the bottom of this file
// crosses these fixtures against the real rows.
const ARCHETYPES: ArchetypeLike[] = [
  {
    key: 'front_desk', name: 'Front Desk Receptionist', domain: 'reception',
    description: 'The first point of contact: greets, answers common questions, captures complete messages and leads, and books or routes people to the right place — text channels today, voice-ready by design.',
    required_connector_categories: ['knowledge_base'],
    system_templates: [{ system_key: 'crm', label: 'CRM / booking system', can_read: true, can_write: false, binding_kind: 'connector' }],
  },
  {
    key: 'support_agent', name: 'Support Agent', domain: 'customer_support',
    description: 'Answers customer questions grounded in the knowledge base, escalates what it cannot resolve, and logs every interaction.',
    required_connector_categories: ['helpdesk', 'knowledge_base'],
    system_templates: [{ system_key: 'helpdesk', label: 'Help desk / ticketing', can_read: true, can_write: false, binding_kind: 'connector' }],
  },
  {
    key: 'it_helpdesk', name: 'IT Helpdesk Technician', domain: 'it_support',
    description: 'Triages and resolves IT issues from approved runbooks, manages the ticket lifecycle end to end, and escalates by severity — the MSP-ready internal help desk.',
    required_connector_categories: ['helpdesk', 'knowledge_base'],
    system_templates: [{ system_key: 'helpdesk', label: 'Help desk / PSA ticketing', can_read: true, can_write: false, binding_kind: 'connector' }],
  },
  {
    key: 'billing_ar', name: 'Billing & AR Specialist', domain: 'Finance Operations',
    description: 'Works accounts receivable: sweeps for overdue invoices, runs the dunning motion, keeps the invoice record current, and proposes status changes and outreach for human approval. Never moves money on its own.',
    required_connector_categories: ['erp_financials'],
    system_templates: [{ system_key: 'invoices', label: 'Invoices (AR)', can_read: true, can_write: true, source_table: 'invoices' }],
  },
  {
    key: 'accounting', name: 'Accounting Specialist', domain: 'Accounting',
    description: 'Reviews the general ledger: reconciles entries, checks the books against source records, and produces a reconciliation memo for human review. Never posts, adjusts, or closes the books itself.',
    required_connector_categories: ['erp_financials'],
    system_templates: [{ system_key: 'ledger', label: 'General ledger', can_read: true, can_write: false, source_table: 'journal_entries' }],
  },
  {
    key: 'sdr', name: 'Sales Development Rep', domain: 'Sales',
    description: 'Works the opportunity pipeline: picks up new and approaching-close opportunities, advances them per the sales SOP, keeps the pipeline record current, and proposes stage changes and outreach for human approval.',
    required_connector_categories: ['crm'],
    system_templates: [{ system_key: 'pipeline', label: 'Opportunity pipeline', can_read: true, can_write: true, source_table: 'opportunities' }],
  },
  {
    key: 'bdr', name: 'Business Development Rep', domain: 'Sales',
    description: 'Develops target accounts and new markets: researches strategic prospects, runs account-based outreach as drafts, creates opportunities, and hands qualified interest to Sales — within a boundary the organization sets against SDR.',
    required_connector_categories: ['crm'],
    system_templates: [{ system_key: 'pipeline', label: 'Opportunity pipeline', can_read: true, can_write: true, source_table: 'opportunities' }],
  },
  {
    key: 'marketing', name: 'Marketing Specialist', domain: 'Marketing',
    description: 'Plans and coordinates marketing: campaign planning, messaging and segmentation, content coordination, and attribution/reporting. Coordinates with SEO and Google Ads without duplicating their specialist execution; never publishes or sends external content without approval.',
    required_connector_categories: ['social'],
    system_templates: [{ system_key: 'social', label: 'Social platform', can_read: true, can_write: false, binding_kind: 'connector' }],
  },
  {
    key: 'google_ads', name: 'Google Ads Specialist', domain: 'Marketing',
    description: 'Manages paid search analysis and proposals: campaign planning, keywords and negatives, ad copy, bid and budget proposals, conversion-tracking validation, and performance/anomaly monitoring. Never increases spend or launches campaigns without approval — it operates under strong financial and brand controls.',
    required_connector_categories: ['ads'],
    system_templates: [{ system_key: 'ads', label: 'Ads platform', can_read: true, can_write: false, binding_kind: 'connector' }],
  },
  {
    key: 'seo', name: 'SEO Specialist', domain: 'Marketing',
    description: 'Analyses search opportunity and technical SEO: keyword and content-gap research, technical and on-page recommendations, internal linking, and search-performance analysis. Recommends changes — it never modifies a production site without configured permission and approval.',
    required_connector_categories: ['web_analytics'],
    system_templates: [{ system_key: 'web_analytics', label: 'Search analytics', can_read: true, can_write: false, binding_kind: 'connector' }],
  },
  {
    key: 'social_media', name: 'Social Media Manager', domain: 'Marketing',
    description: 'Runs day-to-day social: plans and drafts posts on brand, monitors comments and mentions, drafts replies, and reports on engagement. Everything that would appear in public — a post, a reply, a boost — is prepared as a draft and published only by a person.',
    required_connector_categories: ['social'],
    system_templates: [{ system_key: 'social', label: 'Social platform', can_read: true, can_write: false, binding_kind: 'connector' }],
  },
];

/** The archetype's own words, exactly as discovery-interview/index.ts's
 *  emitProposals builds them from the live row, so check (b) is exercised
 *  here the same way it is in production rather than with the option
 *  omitted. */
function selfTextFor(key: string): string | undefined {
  const a = ARCHETYPES.find((x) => x.key === key);
  return a ? [a.name, a.description ?? '', ...(a.responsibilities ?? [])].join(' ') : undefined;
}

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

describe('proposalsFrom — employee (a CANDIDATE set, not an answer)', () => {
  // INVERTED on 2026-08-15, not deleted. This test used to assert that a
  // heard dimension "derives a complete, self-validating employee draft" —
  // and it was green, and it was the bug: every archetype the dimension
  // served became a proposal the moment the dimension was marked heard,
  // whatever the customer had actually said. What is asserted now is the
  // opposite half of the same fact: the candidate set is still derived
  // identically (that is deliberate — narrowing it here would mean
  // hardcoding which roles suit which industry), and every candidate is now
  // REFUSED by the same validatePayload until a model grounds it.
  //
  // Red if: an employee draft ever again passes validatePayload straight out
  // of proposalsFrom, or needs_model_fill goes back to false.
  it('derives every candidate from serves_archetypes and marks each as needing a model', () => {
    const drafts = proposalsFrom(DIMS, {
      how_customers_reach_us: { state: 'heard', evidence: 'they call and email; calls go to the front desk' },
    }, ARCHETYPES);
    const employees = drafts.filter((d) => d.kind === 'employee');
    // The candidate set is unchanged and still the full live list.
    expect(employees.map((d) => d.payload.archetype_key).sort()).toEqual(['front_desk', 'it_helpdesk', 'support_agent']);
    for (const d of employees) {
      expect(d.needs_model_fill).toBe(true);
      expect(d.payload.fit_reason).toBeNull();
      // The dimension's evidence travels with the draft — the fit-reason
      // check has nothing to ground against otherwise.
      expect(d.payload.evidence).toBe('they call and email; calls go to the front desk');
      expect(() => validatePayload('employee', d.payload, { archetypeSelfText: selfTextFor(String(d.payload.archetype_key)) }))
        .toThrow(/fit_reason|consent/i);
    }
  });

  // BLOCKER 2 (task-3-contract.md §7), the exact live disagreement it named.
  // Red if: `systems` goes back to required_connector_categories — front_desk
  // would then name knowledge_base, a system install_role_systems never binds
  // for it, and omit crm, the one it does.
  it('builds systems from system_templates (what the writer binds), never required_connector_categories', () => {
    const drafts = proposalsFrom(DIMS, {
      how_customers_reach_us: { state: 'heard', evidence: 'they call and email; calls go to the front desk' },
    }, ARCHETYPES);
    const frontDesk = drafts.find((d) => d.kind === 'employee' && d.payload.archetype_key === 'front_desk');
    expect(frontDesk).toBeTruthy();
    const systems = frontDesk!.payload.systems as string[];
    // Premise check, so this cannot pass vacuously: the fixture really does
    // carry the disagreeing pair, exactly as the live row does.
    expect(ARCHETYPES.find((a) => a.key === 'front_desk')!.required_connector_categories).toEqual(['knowledge_base']);
    expect(systems.join(' ')).toMatch(/crm|CRM/i);
    expect(systems.join(' ')).not.toMatch(/knowledge_base/);

    // The structured half carries the identity and the two booleans, so
    // nothing downstream has to parse display prose to learn them.
    expect(frontDesk!.payload.system_access).toEqual([
      { system_key: 'crm', label: 'CRM / booking system', can_read: true, can_write: false, binding_kind: 'connector' },
    ]);
  });

  // Red if: the read/write reach stops appearing on the card string. §11b
  // makes tool reach a card fact; a read-only binding and a writing one are
  // not the same promise, and the customer is being asked to consent to one
  // of them specifically.
  it('says on the card whether each system is read-only or writing', () => {
    const drafts = proposalsFrom(DIMS, {
      how_customers_reach_us: { state: 'heard', evidence: 'they call and email; calls go to the front desk' },
      money_in: { state: 'heard', evidence: 'we invoice monthly out of Xero, net 30' },
    }, ARCHETYPES);
    const frontDesk = drafts.find((d) => d.payload.archetype_key === 'front_desk');
    const billing = drafts.find((d) => d.payload.archetype_key === 'billing_ar');
    // front_desk's crm binding is can_write:false live; billing_ar's invoices
    // binding is can_write:true. Red if both render the same way.
    expect(frontDesk!.payload.systems).toEqual(['CRM / booking system (read only)']);
    expect(billing!.payload.systems).toEqual(['Invoices (AR) (read/write)']);
  });

  // Red if: an archetype with no system_templates silently falls back to
  // required_connector_categories (the bug) or emits an empty-but-passing
  // card. The right answer is a refusal — validatePayload's "does not say
  // what systems it can touch" check has to still MEAN something after
  // BLOCKER 2's fix, and this is what proves it can still fire.
  it('refuses an employee whose archetype carries no system_templates at all', () => {
    const orphan: ArchetypeLike[] = [
      { key: 'billing_ar', name: 'Billing & AR Specialist', domain: 'Finance Operations', required_connector_categories: ['erp_financials'] },
    ];
    const drafts = proposalsFrom(DIMS, { money_in: { state: 'heard', evidence: 'we invoice monthly out of Xero, net 30' } }, orphan);
    const employee = drafts.find((d) => d.kind === 'employee');
    expect(employee).toBeTruthy();
    expect(employee!.payload.systems).toEqual([]);
    expect(() => validatePayload('employee', employee!.payload)).toThrow(/system|touch|access/i);
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
    const billing = drafts.filter((d) => d.kind === 'employee' && d.payload.archetype_key === 'billing_ar');
    expect(billing).toHaveLength(1);
    // ⚠ R1 (BLOCKER 1 of the 2026-08-15 review). This test used to stop at
    // the count above, and that is exactly why the suite was blind: the
    // dedupe was correct, and the thing it silently threw away — the LATER
    // dimensions' evidence — was what the model and the gate were then judged
    // against. Red if the surviving card carries only the first dimension's
    // sentence again.
    expect((billing[0].payload.evidence_sources as EvidenceSource[]).map((s) => s.evidence)).toEqual([
      'we invoice monthly out of Xero, net 30',
      'AP reconciled monthly alongside the bank',
    ]);
    // ...and a quote from EITHER sentence grounds it.
    for (const quote of ['we invoice monthly out of Xero', 'AP reconciled monthly alongside the bank']) {
      expect(() => validatePayload('employee', {
        ...billing[0].payload,
        evidence_quote: quote,
        fit_reason: 'Money owed is tracked by hand in two places and reconciled once a month.',
      }), quote).not.toThrow();
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// THE OVER-PROPOSAL DEFECT — found by the first real interview, 2026-08-15
//
// An employee proposal was emitted for EVERY entry in a dimension's
// serves_archetypes the moment that dimension was marked 'heard'. The
// evidence text was read on the line above (for the rationale, and for
// matchProvider) and then ignored for archetype selection. A 40-person
// commercial cleaning firm who said "most leads come from existing clients
// recommending us" and "nothing's in a CRM, it's Dan's spreadsheet" was
// offered 15 employees out of 22 proposals — SEO, Google Ads, social media,
// an SDR, a BDR and an IT helpdesk among them.
//
// ⚠ EVERY BLOCK BELOW FIRES IN BOTH DIRECTIONS, on purpose. A filter that
// drops everything passes a one-sided suite exactly as happily as a correct
// one does, and under-proposal — a firm that genuinely runs Google Ads never
// being offered a Google Ads role — is the failure nobody would report.
// ═══════════════════════════════════════════════════════════════════════════

/** The real cleaning-firm answer, from the run that found the defect —
 *  ⚠ IN THE SHAPE PRODUCTION ACTUALLY PRODUCES.
 *
 *  This constant used to be BOTH sentences concatenated into ONE
 *  winning_business evidence value. Production cannot produce that: they came
 *  from two different dimensions, and coverage holds one evidence string PER
 *  DIMENSION. That single-string fixture is exactly why the whole suite was
 *  blind to BLOCKER 1 (2026-08-15 review) — with both sentences in one entry,
 *  every archetype was judged against both, which is the fixed behaviour, not
 *  the shipped one. Never re-merge them. */
const CLEANING_WINNING = 'most leads come from existing clients recommending us';
const CLEANING_SYSTEMS = "nothing's in a CRM, it's Dan's spreadsheet";

/** The two coverage entries, separate, as record_dimension_state writes them. */
const CLEANING_FIRM_COVERAGE = {
  winning_business: { state: 'heard' as const, evidence: CLEANING_WINNING },
  systems_of_record: { state: 'heard' as const, evidence: CLEANING_SYSTEMS },
};

/** THE DEPLOYED PIPELINE, not a re-implementation of it. Every step below is
 *  the same exported function discovery-interview/index.ts's emitProposals
 *  calls, in the same order:
 *    proposalsFrom  → the candidate drafts
 *    applyFillToDraft → the model's response, under FILL_WHITELIST, refused
 *                       wholesale when it cannot prove which draft it is for
 *    validatePayload  → keep or refuse
 *  In particular the model's response is mapped back by ARRAY INDEX over the
 *  needs-fill list, exactly as index.ts does, so "the model named a key that
 *  was never a candidate" is exercised through the real mechanism rather
 *  than through a friendlier one this helper invented.
 *  A candidate with no entry in `fills` is the model DECLINING it — the
 *  documented correct answer, not a test shortcut.
 *
 *  ⚠ `stampIdentity` (default true) makes this helper behave like a COMPLIANT
 *  model: the deployed prompt asks the model to copy `idx`, `kind` and (for
 *  an employee) `archetype_key` back on every answer, and BLOCKER 2's check
 *  compares them. A fill in `fills` may override either by naming its own —
 *  that is how the mismatch cases below are built. Set it false to simulate a
 *  model that omits the identity fields entirely. */
function runEmployeePipeline(
  coverage: Parameters<typeof proposalsFrom>[1],
  fills: Record<string, Record<string, unknown>>,
  options: { stampIdentity?: boolean } = {},
): {
  survivors: string[]; refusals: string[]; candidates: string[];
  employees: ProposalDraft[]; discarded: string[];
} {
  const stamp = options.stampIdentity !== false;
  const drafts = proposalsFrom(DIMS, coverage, ARCHETYPES);
  const needsFill = drafts.filter((d) => d.needs_model_fill);
  const byIdx = new Map<number, Record<string, unknown>>();
  needsFill.forEach((d, idx) => {
    if (d.kind !== 'employee') return;
    const fill = fills[String(d.payload.archetype_key)];
    if (!fill) return;
    byIdx.set(idx, stamp
      ? { kind: 'employee', archetype_key: String(d.payload.archetype_key), ...fill }
      : fill);
  });
  const discarded: string[] = [];
  for (let i = 0; i < needsFill.length; i++) {
    const fill = byIdx.get(i);
    if (!fill) continue;
    const problem = applyFillToDraft(needsFill[i], fill);
    if (problem) discarded.push(`${String(needsFill[i].payload.archetype_key ?? needsFill[i].source_dimension)}: ${problem}`);
  }
  const employees = drafts.filter((d) => d.kind === 'employee');
  const survivors: string[] = [];
  const refusals: string[] = [];
  for (const d of employees) {
    const key = String(d.payload.archetype_key);
    try {
      validatePayload('employee', d.payload, { archetypeSelfText: selfTextFor(key) });
      survivors.push(key);
    } catch (e) {
      refusals.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { survivors, refusals, candidates: employees.map((d) => String(d.payload.archetype_key)), employees, discarded };
}

describe('OVER-PROPOSAL — the bug: a heard dimension must not staff its whole archetype list', () => {
  // Red if: any role the model did not ground survives. Before this fix all
  // six survived, always, for every business on earth.
  it('the real cleaning-firm evidence yields ONLY the roles the model could ground', () => {
    const { survivors, candidates, refusals } = runEmployeePipeline(
      CLEANING_FIRM_COVERAGE,
      {
        // grounded — a verbatim span of the customer's own sentence, plus a
        // paraphrase of what it means
        sdr: {
          evidence_quote: 'come from existing clients recommending us',
          fit_reason: 'Leads arrive as referrals from existing clients and sit in a spreadsheet, not a CRM, so nobody follows them up.',
        },
        bdr: {
          evidence_quote: 'existing clients recommending us',
          fit_reason: 'Growth is entirely word-of-mouth from existing clients, so new accounts are never developed deliberately.',
        },
        // answered, but with boilerplate and no quote — the model failing to
        // decline must NOT be a way through
        seo: { fit_reason: 'This role would help the business grow and reach more people online.' },
        google_ads: { fit_reason: 'Paid search campaigns, keywords and ad copy would be planned and monitored.' },
        // marketing, social_media, accounting, billing_ar, support_agent and
        // it_helpdesk: omitted entirely — the documented way to decline
      },
    );
    // Vacuity guard: the candidate set really is the wide one, and it is
    // WIDER than it used to be here, because the production shape has the
    // second sentence under systems_of_record (13 archetypes, ordinal 9)
    // rather than merged into winning_business. If this ever shrank, "seo did
    // not survive" would prove nothing.
    expect(candidates.sort()).toEqual([
      'accounting', 'bdr', 'billing_ar', 'google_ads', 'it_helpdesk',
      'marketing', 'sdr', 'seo', 'social_media', 'support_agent',
    ]);
    expect(survivors.sort()).toEqual(['bdr', 'sdr']);
    expect(refusals).toHaveLength(8);
    // Named individually, because these are the ones a commercial cleaning
    // firm would find absurd on their screen.
    for (const wrong of ['seo', 'google_ads', 'social_media', 'it_helpdesk']) {
      expect(survivors, `${wrong} must not survive the cleaning-firm evidence`).not.toContain(wrong);
    }
  });

  // Red if: the boilerplate answers above were dropped for some incidental
  // reason (a typo in the fill key, say) rather than by the grounding check.
  // A refusal for the wrong reason is not the feature.
  it('refuses the boilerplate answers specifically for supplying no quote from the customer', () => {
    const { refusals } = runEmployeePipeline(
      CLEANING_FIRM_COVERAGE,
      { seo: { fit_reason: 'This role would help the business grow and reach more people online.' } },
    );
    const seoRefusal = refusals.find((r) => r.startsWith('seo:'));
    expect(seoRefusal).toMatch(/carries no evidence_quote/);
  });

  // ⚠ R3, THE VERDICT'S I3 CASES. All three of these were MEASURED PASSING
  // against the old content-word overlap check, on the defect report's own
  // sentence, because the stop-word list dropped "customer(s)" but not
  // "client(s)"/"lead(s)"/"firm(s)". Pure boilerplate, passing the gate
  // written to stop boilerplate. Red if any of them ever passes again.
  it('refuses the three boilerplate sentences the old overlap check let through', () => {
    const cases: Array<[string, string, string]> = [
      ['seo', 'This role would be a valuable addition for clients like these.', CLEANING_WINNING],
      ['seo', 'Every growing firm eventually needs somebody owning leads properly.', CLEANING_WINNING],
      ['it_helpdesk', 'Any firm with clients this size benefits from dedicated cover.', CLEANING_SYSTEMS],
    ];
    for (const [archetype, boilerplate, evidence] of cases) {
      expect(() => validatePayload(
        'employee',
        { ...VALID_EMPLOYEE, evidence, evidence_quote: undefined, fit_reason: boilerplate },
        { archetypeSelfText: selfTextFor(archetype) },
      ), boilerplate).toThrow(/carries no evidence_quote/);
    }
  });
});

describe('UNDER-PROPOSAL — the inverse bug, and the one nobody would report', () => {
  // A filter that drops everything passes the block above perfectly. This is
  // what stops that. Red if: a business that plainly runs these functions
  // stops being offered the roles for them.
  it('a firm that says it runs Google Ads and uses an SEO agency is still offered both', () => {
    const { survivors, candidates } = runEmployeePipeline(
      { winning_business: { state: 'heard', evidence: 'we run Google Ads ourselves and an agency does our SEO' } },
      {
        google_ads: {
          evidence_quote: 'we run Google Ads ourselves',
          fit_reason: 'They run Google Ads themselves today and nobody is watching the spend.',
        },
        seo: {
          evidence_quote: 'an agency does our SEO',
          fit_reason: 'An outside agency handles their search work, so it is already happening off the books.',
        },
      },
    );
    expect(candidates).toHaveLength(6);
    // The COUNT, not just the absence of the wrong ones — asserting only
    // "sdr did not survive" would be green on a filter that drops all six.
    expect(survivors).toHaveLength(2);
    expect(survivors.sort()).toEqual(['google_ads', 'seo']);
  });

  // Red if: the length/word floor in check (a) creeps up until terse but
  // genuinely grounded answers start failing.
  it('a short but genuinely grounded reason still passes — the floor is against stubs, not brevity', () => {
    expect(() => validatePayload('employee', {
      ...VALID_EMPLOYEE,
      evidence: 'we run Google Ads ourselves and an agency does our SEO',
      evidence_quote: 'we run Google Ads ourselves',
      fit_reason: 'They run Google Ads in-house today.',
    })).not.toThrow();
  });

  // ⚠ R3, THE VERDICT'S I2 CASES — three MEASURED FALSE REFUSALS under the
  // old content-word overlap check, all of them correct inferences, and the
  // first is the Front Desk hire for a 40-person cleaning firm. The old check
  // rewarded verbatim word-borrowing and punished synonyms, which is the
  // exact opposite of what the fill prompt asks for. fit_reason is now free
  // to paraphrase; the verbatim burden moved to evidence_quote, where it can
  // be met exactly. Red if paraphrase ever starts failing again.
  it('accepts the three legitimate paraphrases the old check refused', () => {
    const cases: Array<{ archetype: string; evidence: string; quote: string; fit: string }> = [
      {
        archetype: 'front_desk',
        evidence: 'Most of our jobs come in over the phone.',
        quote: 'our jobs come in over the phone',
        fit: 'Calls are the only intake route and nobody picks up after hours.',
      },
      {
        archetype: 'accounting',
        evidence: 'We do all our own books in a spreadsheet.',
        quote: 'all our own books in a spreadsheet',
        fit: 'They keep the ledger by hand, so reconciliation is never done.',
      },
      {
        archetype: 'billing_ar',
        evidence: 'Everything is on paper.',
        quote: 'Everything is on paper',
        fit: 'Records are not digital yet, which makes chasing anything manual.',
      },
    ];
    for (const c of cases) {
      expect(() => validatePayload(
        'employee',
        { ...VALID_EMPLOYEE, evidence: c.evidence, evidence_quote: c.quote, fit_reason: c.fit },
        { archetypeSelfText: selfTextFor(c.archetype) },
      ), c.fit).not.toThrow();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1 — EVIDENCE IS THE UNION, NEVER THE FIRST DIMENSION'S
// (BLOCKER 1 of the 2026-08-15 adversarial review.)
//
// `seenArchetypes` is first-wins, which is CORRECT as a dedupe — one card per
// role. But the winning dimension also used to decide the single `evidence`
// string that both the fill prompt and the grounding check consumed, so every
// later dimension naming the same archetype contributed nothing. Measured
// live the same day: 14 of the 15 active archetypes are nominated by more
// than one dimension (renewal_manager by five; google_ads / seo / sdr / bdr /
// social_media by winning_business at ordinal 5 AND systems_of_record at
// ordinal 9). So a customer saying "we do run Google Ads" under
// systems_of_record had google_ads judged against winning_business's "leads
// come from referrals" — refused BY CONSTRUCTION, no model output able to
// rescue it.
// ═══════════════════════════════════════════════════════════════════════════

describe('R1 — a deduped draft carries EVERY nominating dimension\'s evidence', () => {
  const TWO_DIMENSIONS = {
    winning_business: { state: 'heard' as const, evidence: 'most leads come from existing clients recommending us' },
    systems_of_record: { state: 'heard' as const, evidence: 'we do run Google Ads and pay an SEO agency' },
  };

  // Red if: the draft carries only winning_business's sentence again. This is
  // the assertion the pre-existing dedupe test could not make — it counted
  // the cards and never looked at what they were judged against.
  it('one card, both sentences: evidence_sources names each dimension in ordinal order', () => {
    const drafts = proposalsFrom(DIMS, TWO_DIMENSIONS, ARCHETYPES);
    const googleAds = drafts.filter((d) => d.kind === 'employee' && d.payload.archetype_key === 'google_ads');
    // Still exactly ONE card — the dedupe itself was never the bug.
    expect(googleAds).toHaveLength(1);
    const sources = googleAds[0].payload.evidence_sources as EvidenceSource[];
    expect(sources.map((s) => s.dimension)).toEqual(['winning_business', 'systems_of_record']);
    expect(sources.map((s) => s.evidence)).toEqual([
      'most leads come from existing clients recommending us',
      'we do run Google Ads and pay an SEO agency',
    ]);
    // and the rationale keeps both, so the Drawer shows the customer
    // everything that nominated the role, not just the winner of a dedupe.
    expect(googleAds[0].rationale).toContain('most leads come from existing clients recommending us');
    expect(googleAds[0].rationale).toContain('we do run Google Ads and pay an SEO agency');
  });

  // THE VERDICT'S OWN CASE, END TO END. Red if google_ads is refused: that is
  // the shipped behaviour, and it refuses a role the customer named out loud.
  it('THE GOOGLE ADS CASE: a role named under the LATER dimension now survives', () => {
    const { survivors, candidates, employees } = runEmployeePipeline(TWO_DIMENSIONS, {
      google_ads: {
        evidence_quote: 'we do run Google Ads',
        fit_reason: 'They already run Google Ads themselves and nobody is watching the spend.',
      },
    });
    expect(candidates).toContain('google_ads');
    expect(survivors, 'the customer said "we do run Google Ads" — the role must be offered').toContain('google_ads');
    // COUNTS, not just the one absence: everything else was declined, so the
    // union did not turn into "propose everything".
    expect(survivors).toHaveLength(1);
    expect(candidates.length).toBeGreaterThan(1);
    // R1's source_dimension decision: the draft names the dimension whose
    // sentence the model actually quoted, not the one that won the dedupe.
    const card = employees.find((d) => d.payload.archetype_key === 'google_ads')!;
    expect(card.source_dimension).toBe('systems_of_record');
  });

  // The mirror case from the verdict, on the money side: billing_ar binds
  // money_in, and the one sentence that justifies a Billing & AR Specialist
  // arrives under a later dimension. Red if that sentence is invisible again.
  it('THE BILLING CASE: the later dimension\'s sentence is what grounds the role', () => {
    const dims: DiscoveryDimensionForProposals[] = [
      { key: 'money_in', title: 'How money comes in', serves_archetypes: ['billing_ar'], produces: [] },
      { key: 'repetitive_work', title: 'The repetitive work', serves_archetypes: ['billing_ar'], produces: [] },
    ];
    const drafts = proposalsFrom(dims, {
      money_in: { state: 'heard', evidence: 'clients pay by bank transfer' },
      repetitive_work: { state: 'heard', evidence: 'chasing unpaid invoices eats a day a week' },
    }, ARCHETYPES);
    const billing = drafts.filter((d) => d.kind === 'employee');
    expect(billing).toHaveLength(1);
    const problem = applyFillToDraft(billing[0], {
      kind: 'employee',
      archetype_key: 'billing_ar',
      evidence_quote: 'chasing unpaid invoices eats a day a week',
      fit_reason: 'A full day every week goes on running down money that is already owed.',
    });
    expect(problem, 'a compliant fill must be applied').toBeNull();
    expect(() => validatePayload('employee', billing[0].payload, { archetypeSelfText: selfTextFor('billing_ar') })).not.toThrow();
    expect(billing[0].source_dimension).toBe('repetitive_work');
  });

  // ⚠ THE INVERSE, and the one that stops the union becoming a free-for-all.
  // The union is PER ARCHETYPE, not global: a role may only be grounded in
  // sentences from dimensions that actually nominated IT. marketing is
  // nominated by winning_business alone (measured live: the only
  // single-dimension archetype of the 15), so a fill quoting
  // systems_of_record's sentence must be refused even though that sentence
  // was genuinely said in this interview. Red if any dimension's evidence can
  // ground any role.
  it('a role nominated by ONE dimension cannot be grounded in another dimension\'s sentence', () => {
    const { survivors, refusals } = runEmployeePipeline(TWO_DIMENSIONS, {
      marketing: {
        evidence_quote: 'we do run Google Ads',   // real, said — but not to a dimension that nominates marketing
        fit_reason: 'Somebody has to own the paid channels they are already spending on.',
      },
    });
    expect(survivors).not.toContain('marketing');
    expect(refusals.find((r) => r.startsWith('marketing:'))).toMatch(/not a verbatim span/);
    // Vacuity guard: marketing WAS a candidate, so this is a refusal and not
    // an absence.
    const { candidates } = runEmployeePipeline(TWO_DIMENSIONS, {});
    expect(candidates).toContain('marketing');
  });

  // Red if: a quote that only exists ACROSS the join of two sentences is
  // accepted. `evidence` is joined for display; the check consults the
  // sources one at a time precisely so a straddling span is not "something
  // the customer said".
  it('a span straddling two dimensions\' sentences is not something the customer said', () => {
    const drafts = proposalsFrom(DIMS, TWO_DIMENSIONS, ARCHETYPES);
    const seo = drafts.find((d) => d.kind === 'employee' && d.payload.archetype_key === 'seo')!;
    // Built from the END of source 1 and the START of source 2 — present in
    // the joined `evidence` string only if the joiner were a plain space.
    applyFillToDraft(seo, {
      kind: 'employee', archetype_key: 'seo',
      evidence_quote: 'recommending us we do run Google Ads',
      fit_reason: 'Search is already being paid for by an outside agency nobody reviews.',
    });
    expect(() => validatePayload('employee', seo.payload, { archetypeSelfText: selfTextFor('seo') }))
      .toThrow(/not a verbatim span/);
  });
});

describe('the candidate set is a CEILING — a model can narrow it, never widen it', () => {
  // Red if: any path exists from a model response to a NEW draft. This is
  // meant to be structurally impossible, not merely discouraged — there is
  // no code that turns a fill into a draft, and this is the assertion that
  // notices if one appears.
  it('a fill naming an archetype that was never a candidate produces nothing', () => {
    const { survivors, candidates, employees } = runEmployeePipeline(
      { winning_business: { state: 'heard', evidence: CLEANING_WINNING } },
      {
        // renewal_manager is nominated by money_in / money_out /
        // after_the_sale / repetitive_work / systems_of_record — never by
        // winning_business, and no dimension but winning_business is heard.
        renewal_manager: { fit_reason: 'Existing clients recommend them, so renewals are where the leads come from.' },
        front_desk: { fit_reason: 'Existing clients call the office directly and someone has to pick up the spreadsheet.' },
      },
    );
    expect(candidates).not.toContain('renewal_manager');
    expect(candidates).not.toContain('front_desk');
    expect(survivors).not.toContain('renewal_manager');
    expect(survivors).not.toContain('front_desk');
    expect(employees.map((d) => d.payload.archetype_key)).not.toContain('renewal_manager');
    // Vacuity guard: the pipeline did run and did produce candidates — an
    // empty result would satisfy every assertion above for the wrong reason.
    expect(candidates).toHaveLength(6);
  });

  // THE WHITELIST IS THE MECHANISM. Red if a third key is ever added to
  // FILL_WHITELIST.employee — every one of the assertions below stops being
  // guaranteed the moment it is. `evidence_sources` in particular must never
  // join it: a model that could edit the customer's sentences could make any
  // quote verbatim.
  it('FILL_WHITELIST.employee is exactly ["fit_reason", "evidence_quote"], and nothing else', () => {
    expect(FILL_WHITELIST.employee).toEqual(['fit_reason', 'evidence_quote']);
  });

  it('a fill cannot rename the role, move its department, widen its tool reach or edit the evidence', () => {
    const drafts = proposalsFrom(DIMS, { winning_business: { state: 'heard', evidence: CLEANING_WINNING } }, ARCHETYPES);
    const sdr = drafts.find((d) => d.kind === 'employee' && d.payload.archetype_key === 'sdr')!;
    const problem = applyFillToDraft(sdr, {
      kind: 'employee',
      archetype_key: 'sdr',                       // correct — the identity check passes
      evidence_quote: 'existing clients recommending us',
      fit_reason: 'Leads arrive as referrals from existing clients and sit in a spreadsheet, not a CRM.',
      name: 'Chief Growth Officer',               // must NOT rename the role
      job: 'Chief Growth Officer',
      department: 'Executive',                    // must NOT move it
      systems: ['everything (read/write)'],       // must NOT widen tool reach
      system_access: [{ system_key: 'everything', can_write: true }],
      starts_supervised: false,                   // must NOT lift supervision
      evidence: 'we spend forty thousand a month on Google Ads',        // must NOT rewrite what the customer said
      evidence_sources: [{ dimension: 'winning_business', title: 'x', evidence: 'anything the model likes' }],
    });
    expect(problem).toBeNull();
    expect(sdr.payload.name).toBe('Sales Development Rep');
    expect(sdr.payload.job).toBe('Sales Development Rep');
    expect(sdr.payload.department).toBe('Sales');
    expect(sdr.payload.archetype_key).toBe('sdr');
    expect(sdr.payload.systems).toEqual(['Opportunity pipeline (read/write)']);
    expect(sdr.payload.system_access).toEqual([
      { system_key: 'pipeline', label: 'Opportunity pipeline', can_read: true, can_write: true, binding_kind: 'internal_table' },
    ]);
    expect(sdr.payload.starts_supervised).toBe(true);
    expect(sdr.payload.evidence).toBe(CLEANING_WINNING);
    expect(sdr.payload.evidence_sources).toEqual([
      { dimension: 'winning_business', title: 'How we win business', evidence: CLEANING_WINNING },
    ]);
    // and the two whitelisted keys DID land — a whitelist that blocks
    // everything is not a whitelist, it is an outage.
    expect(sdr.payload.fit_reason).toMatch(/referrals from existing clients/);
    expect(sdr.payload.evidence_quote).toBe('existing clients recommending us');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R2 — A FILL MUST PROVE IT IS FOR THE DRAFT IT LANDS ON
// (BLOCKER 2 of the 2026-08-15 adversarial review.)
//
// Fills were matched to drafts by ARRAY INDEX only. The items sent to the
// model already carry archetype_key; the response's was never compared.
// MEASURED: an SDR argument applied to the SEO draft passed every check, and
// because the whitelist correctly refuses to write archetype_key, the card
// rendered a specific, customer-grounded SDR sentence under "SEO Specialist".
// The whitelist made the mismatch INVISIBLE rather than harmless.
// ═══════════════════════════════════════════════════════════════════════════

describe('R2 — a fill carrying the wrong archetype_key is refused wholesale', () => {
  const oneDim = { winning_business: { state: 'heard' as const, evidence: CLEANING_WINNING } };

  // THE VERDICT'S MEASURED PAYLOAD, verbatim. Red if it ever lands again.
  it('an SDR argument does not land on the SEO card', () => {
    const drafts = proposalsFrom(DIMS, oneDim, ARCHETYPES);
    const seo = drafts.find((d) => d.kind === 'employee' && d.payload.archetype_key === 'seo')!;
    const problem = applyFillToDraft(seo, {
      kind: 'employee',
      archetype_key: 'sdr',
      evidence_quote: 'existing clients recommending us',
      fit_reason: 'Leads from existing clients sit in a spreadsheet with nobody following them up.',
    });
    // The DAMAGE is asserted first, deliberately: under the defect this
    // reads back "expected 'Leads from existing clients sit in a spreadsheet
    // with nobody following them up.' to be null" — the SDR sentence, sitting
    // on the SEO card, which is the whole finding. NOTHING may be written:
    // not the fit_reason, not the quote, not the rationale. A partially-
    // applied refusal would be the same defect wearing a smaller hat.
    expect(seo.payload.fit_reason).toBeNull();
    expect(seo.payload.evidence_quote).toBeNull();
    expect(seo.rationale).not.toMatch(/spreadsheet with nobody/);
    expect(problem).toMatch(/written for archetype "sdr" but landed on "seo"/);
    expect(() => validatePayload('employee', seo.payload, { archetypeSelfText: selfTextFor('seo') }))
      .toThrow(/carries no fit_reason/);
  });

  // The ACCEPT direction, in the same shape — a check that refuses everything
  // passes the case above just as happily.
  it('the SAME argument on the card it was written for is applied', () => {
    const drafts = proposalsFrom(DIMS, oneDim, ARCHETYPES);
    const sdr = drafts.find((d) => d.kind === 'employee' && d.payload.archetype_key === 'sdr')!;
    const problem = applyFillToDraft(sdr, {
      kind: 'employee',
      archetype_key: 'sdr',
      evidence_quote: 'existing clients recommending us',
      fit_reason: 'Leads from existing clients sit in a spreadsheet with nobody following them up.',
    });
    expect(problem).toBeNull();
    expect(sdr.payload.fit_reason).toMatch(/spreadsheet with nobody/);
    expect(() => validatePayload('employee', sdr.payload, { archetypeSelfText: selfTextFor('sdr') })).not.toThrow();
  });

  // ⚠ THE ABSENT-FIELD DECISION, PINNED. Models omit fields. Silently
  // trusting the index in that case re-opens the whole hole, so an employee
  // fill with no archetype_key is DISCARDED — which is a decline, the
  // documented default for this kind, counted and logged. See
  // fillIdentityProblem's header for the full argument. Red if a keyless
  // employee fill is ever applied on the strength of its array position.
  it('an employee fill with NO archetype_key is discarded, not trusted by position', () => {
    const { survivors, discarded, refusals } = runEmployeePipeline(
      oneDim,
      {
        sdr: {
          evidence_quote: 'existing clients recommending us',
          fit_reason: 'Leads arrive as referrals and sit in a spreadsheet nobody works.',
        },
      },
      { stampIdentity: false },
    );
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatch(/carries no archetype_key/);
    expect(survivors).toEqual([]);
    expect(refusals.find((r) => r.startsWith('sdr:'))).toMatch(/carries no fit_reason/);
  });

  // Red if: a mismatched `kind` is trusted. Cheaper than the archetype case
  // and it fires for every kind, employee or not.
  it('a fill whose kind does not match the draft is refused for every kind', () => {
    const drafts = proposalsFrom(DIMS, {
      must_never_happen: { state: 'heard', evidence: 'never promise a refund without a manager sign-off' },
    }, ARCHETYPES);
    const guardrail = drafts.find((d) => d.kind === 'guardrail')!;
    const problem = applyFillToDraft(guardrail, { kind: 'procedure', pattern: 'refund|chargeback' });
    expect(guardrail.payload.pattern, 'a procedure answer must not become this guardrail\'s enforceable literal').toBeNull();
    expect(problem).toMatch(/names kind "procedure" but landed on a guardrail draft/);
  });

  // ⚠ THE OTHER KINDS' DECISION, PINNED TOO: `dimension` is CHECKED when
  // present and NOT REQUIRED when absent. Both halves asserted, because
  // either alone reads like an accident.
  it('a structural fill naming the wrong dimension is refused; naming none is still applied', () => {
    const drafts = proposalsFrom(DIMS, {
      money_in: { state: 'heard', evidence: 'invoices unpaid past 30 days get chased weekly by Finance' },
    }, ARCHETYPES);
    const procedure = drafts.find((d) => d.kind === 'procedure')!;
    const problem = applyFillToDraft(procedure, { dimension: 'repetitive_work', name: 'Dunning', trigger: 'x', steps: ['y'] });
    expect(procedure.payload.name, 'a repetitive_work answer must not become the money_in procedure').toBeNull();
    expect(problem).toMatch(/names dimension "repetitive_work"/);
    // ...and naming NO dimension is still applied — the decision pinned, both
    // halves, because either alone reads like an accident.
    expect(applyFillToDraft(procedure, { name: 'Dunning', trigger: 'invoice 7 days overdue', steps: ['send a reminder'] }))
      .toBeNull();
    expect(procedure.payload.name).toBe('Dunning');
  });
});

describe('the employee grounding gate, check by check — with its limits stated', () => {
  const EV = CLEANING_WINNING;
  const QUOTE = 'existing clients recommending us';

  // (a) Red if: a stub is accepted as a reason.
  it('refuses a stub', () => {
    for (const stub of ['', 'Fits.', 'Good fit', 'yes', 'Sales Development Rep']) {
      expect(() => validatePayload('employee', { ...VALID_EMPLOYEE, evidence: EV, evidence_quote: QUOTE, fit_reason: stub }))
        .toThrow(/fit_reason|consent/i);
    }
  });

  // (a) has to be REACHABLE, not merely present — the 2026-08-15 review
  // measured that replacing it with `if (false)` left the suite green,
  // because every stub above was caught by a LATER check first. These two are
  // refused by (a) ALONE: both carry a perfectly valid verbatim quote and a
  // word beyond the role's own vocabulary, so nothing else fires. Red if (a)
  // is ever deleted or weakened.
  it('check (a) fires alone on a terse answer that would otherwise pass everything', () => {
    for (const terse of ['Xero invoicing here.', 'Referrals drive leads.']) {
      expect(() => validatePayload('employee', {
        ...VALID_EMPLOYEE,
        evidence: 'we invoice monthly out of Xero, net 30',
        evidence_quote: 'we invoice monthly out of Xero',
        fit_reason: terse,
      }), terse).toThrow(/is a stub, not a reason/);
    }
  });

  // (b) Red if: the role describing itself counts as evidence about the
  // business. "A Support Agent handles support tickets" is true of every
  // business that has ever existed.
  it('refuses a reason built only from the role\'s own name and description', () => {
    expect(() => validatePayload(
      'employee',
      {
        ...VALID_EMPLOYEE, name: 'Support Agent', evidence: EV, evidence_quote: QUOTE,
        fit_reason: 'Support Agent answers customer questions grounded in the knowledge base.',
      },
      { archetypeSelfText: selfTextFor('support_agent') },
    )).toThrow(/only restates the role's own name and description/);
  });

  // (b) NARROWS rather than switches off with no archetypeSelfText — the
  // same contract validDeRefs and validActionCategories follow. Red if
  // omitting the option ever means "skip the check".
  //
  // ⚠ HONEST NOTE ON A WEAKENING. This case used to read "Billing AR
  // Specialist works Finance Operations billing." and was caught because
  // "works" sat in FIT_REASON_STOP_WORDS. That list is deleted (see
  // contentWords' header — an exact quote check needs no vocabulary, and a
  // word list that must be maintained to stay correct is a maintenance trap),
  // so (b) is now measurably MORE PERMISSIVE: one common filler word beyond
  // the role's own vocabulary now clears it. The sentence below carries none,
  // so (b) still fires — but the weakening is real and is stated here rather
  // than hidden behind a green tick.
  it('still catches pure self-restatement from the payload alone when no live archetype text is supplied', () => {
    expect(() => validatePayload('employee', {
      ...VALID_EMPLOYEE,
      name: 'Billing & AR Specialist',
      department: 'Finance Operations',
      evidence: EV,
      evidence_quote: QUOTE,
      fit_reason: 'Billing AR Specialist billing for Finance Operations billing.',
    })).toThrow(/only restates the role's own name and description/);
  });

  // (c) THE REPLACEMENT FOR THE OVERLAP HEURISTIC. Red if a fabricated quote
  // is accepted. THIS is what kills the 15-of-22: a model cannot invent the
  // customer's words and pass, however plausible the sentence it writes.
  it('refuses a FABRICATED evidence_quote even when the fit_reason quotes the evidence perfectly', () => {
    expect(() => validatePayload('employee', {
      ...VALID_EMPLOYEE,
      evidence: EV,
      // Reads exactly like something a cleaning firm might say. It is not
      // something THIS one said.
      evidence_quote: 'we spend about two thousand a month on search ads',
      // ...and the fit_reason is a flawless quotation of the real evidence,
      // which is precisely what PASSED the old overlap check for every
      // candidate at once, SEO included.
      fit_reason: 'Because most leads come from existing clients recommending us, nobody owns new demand.',
    })).toThrow(/not a verbatim span/);
  });

  // Red if: the floor on a quote disappears and "the" starts qualifying as
  // the customer's own words. Both halves of the floor, separately.
  it('refuses a quote too small to mean anything — under 3 words, or under 12 characters', () => {
    expect(() => validatePayload('employee', { ...VALID_EMPLOYEE, evidence: EV, evidence_quote: 'existing clients' }))
      .toThrow(/too small a fragment/);                                  // 2 words
    expect(() => validatePayload('employee', {
      ...VALID_EMPLOYEE, evidence: 'we do all our own books', evidence_quote: 'we do all',
    })).toThrow(/too small a fragment/);                                 // 3 words, 9 characters
  });

  // The ACCEPT direction — the quote is EXACT, but only on whitespace, case
  // and the Unicode typographic confusables. Red if it silently loosens into
  // anything fuzzier, and red if a faithful transcription with curly
  // apostrophes is refused.
  it('accepts a verbatim quote across whitespace, case and curly-apostrophe differences', () => {
    for (const quote of [
      "nothing's in a CRM",
      "  Nothing's   in a CRM ",
      'nothing’s in a CRM',
    ]) {
      expect(() => validatePayload('employee', {
        ...VALID_EMPLOYEE,
        evidence: CLEANING_SYSTEMS,
        evidence_quote: quote,
        fit_reason: 'Their whole pipeline lives in one person’s file with no system behind it.',
      }), quote).not.toThrow();
    }
    // ...and NOT on anything fuzzier: a synonym is not a quote.
    expect(() => validatePayload('employee', {
      ...VALID_EMPLOYEE,
      evidence: CLEANING_SYSTEMS,
      evidence_quote: 'nothing is in a CRM',
      fit_reason: 'Their whole pipeline lives in one person’s file with no system behind it.',
    })).toThrow(/not a verbatim span/);
  });

  // Red if: a dimension somehow marked heard with no evidence text lets a
  // fit_reason through unchecked. With nothing to quote from, "cannot ground"
  // is the honest answer — this must fail CLOSED, and must name the REAL
  // cause rather than blaming the model for a missing quote it could not
  // possibly have supplied.
  it('refuses when the nominating dimension recorded no evidence text at all', () => {
    expect(() => validatePayload('employee', {
      ...VALID_EMPLOYEE,
      evidence: '',
      evidence_quote: '',
      fit_reason: 'Referrals from existing clients are how their leads arrive today.',
    })).toThrow(/recorded no evidence text/);
  });

  // ⚠ THE LIMIT, ASSERTED RATHER THAN LEFT AS A CLAIM IN A COMMENT — and it
  // is a DIFFERENT limit from the one the old overlap check had. A verbatim
  // quote proves the model did not invent the customer's words. It does NOT
  // prove the role fits: the same true sentence can be quoted under a role it
  // supports and under one it does not, and nothing lexical can separate
  // those. Written down as a test so nobody reads the gate as stronger than
  // it is, and so this goes red the day someone believes they have closed it
  // and has not. What actually narrows the set is the fill prompt's
  // decline-by-default instruction; what catches a bad narrowing is the
  // customer reading this quote on the card.
  it('KNOWN LIMIT: a real quote under the WRONG role still passes the mechanical gate', () => {
    expect(() => validatePayload(
      'employee',
      {
        ...VALID_EMPLOYEE,
        name: 'SEO Specialist',
        evidence: CLEANING_WINNING,
        evidence_quote: 'come from existing clients recommending us',
        fit_reason: 'Word of mouth is their only channel, so there is nothing bringing in strangers.',
      },
      { archetypeSelfText: selfTextFor('seo') },
    )).not.toThrow();
  });
});

describe('no model, or budget exceeded — employees are refused, never emitted unfiltered', () => {
  // This is the branch discovery-interview/index.ts takes when
  // hasLLMProvider is false or check_tenant_ai_budget blocks:
  // fillProposalLiterals is never called at all, so NO draft is filled.
  // Red if: an unfilled employee draft ever reaches the survivor list —
  // that is the original defect returning through the failure path.
  it('every candidate is refused and counted when no fill runs at all', () => {
    const { survivors, refusals, candidates } = runEmployeePipeline(CLEANING_FIRM_COVERAGE, {});
    expect(candidates).toHaveLength(10);  // vacuity guard: there WERE candidates to lose
    expect(survivors).toEqual([]);
    expect(refusals).toHaveLength(10);    // counted, not silently dropped
    for (const r of refusals) expect(r).toMatch(/carries no fit_reason/);
  });
});

describe('the rationale says why THAT role fits, not why the dimension was heard', () => {
  // Before this fix every employee card derived from one dimension carried a
  // byte-identical rationale: `Heard evidence for "How we win business":
  // <evidence>` — six cards, one sentence. Red if two surviving cards from
  // the same dimension ever share a rationale again.
  it('two survivors from the same dimension carry different rationales, both keeping the evidence trail', () => {
    const { employees, survivors } = runEmployeePipeline(
      { winning_business: { state: 'heard', evidence: CLEANING_WINNING } },
      {
        sdr: {
          evidence_quote: 'existing clients recommending us',
          fit_reason: 'Leads arrive as referrals from existing clients and sit in a spreadsheet, not a CRM.',
        },
        bdr: {
          evidence_quote: 'come from existing clients recommending us',
          fit_reason: 'Growth is entirely word-of-mouth from existing clients, so new accounts are never developed.',
        },
      },
    );
    expect(survivors.sort()).toEqual(['bdr', 'sdr']);
    const rationales = employees
      .filter((d) => survivors.includes(String(d.payload.archetype_key)))
      .map((d) => d.rationale);
    expect(new Set(rationales).size).toBe(2);
    for (const r of rationales) {
      // the fit reason leads...
      expect(r).toMatch(/^(Leads arrive|Growth is entirely)/);
      // ...and the audit trail back to the customer's own words survives
      expect(r).toContain(CLEANING_WINNING);
    }
  });

  // R1: the rationale keeps EVERY nominating dimension's sentence, so the
  // Drawer shows the customer everything that put this role in front of them.
  // Red if the union narrows to the quoted source when source_dimension does.
  it('a role nominated by two dimensions keeps both sentences in its rationale', () => {
    const { employees, survivors } = runEmployeePipeline(
      {
        winning_business: { state: 'heard', evidence: CLEANING_WINNING },
        systems_of_record: { state: 'heard', evidence: 'we do run Google Ads and pay an SEO agency' },
      },
      {
        google_ads: {
          evidence_quote: 'we do run Google Ads',
          fit_reason: 'They already run Google Ads themselves and nobody is watching the spend.',
        },
      },
    );
    expect(survivors).toEqual(['google_ads']);
    const card = employees.find((d) => d.payload.archetype_key === 'google_ads')!;
    expect(card.rationale).toContain(CLEANING_WINNING);
    expect(card.rationale).toContain('we do run Google Ads and pay an SEO agency');
    expect(card.rationale).toMatch(/^They already run Google Ads/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R5 — the SELECT is pinned by the constant the deployed code builds it from
//
// IMPORTANT 1 of the 2026-08-15 review, PROVEN BY MUTATION: reverting
// discovery-interview/index.ts's role_archetypes SELECT to the pre-BLOCKER-2
// column list AND disabling one check left the suite 92/92 GREEN, while in
// production every employee would have been refused for "does not say what
// systems it can touch" and the log would read exactly like a correctly-
// narrowing interview. No test imports index.ts and tsconfig excludes
// supabase/functions, so a literal column list there is pinned by nothing —
// and the literal copy that used to sit in the live probe below pinned
// nothing either: two adjacent literals are deletable in one diff.
// ═══════════════════════════════════════════════════════════════════════════

describe('R5 — the role_archetypes column list lives in exactly one place', () => {
  // Red if: a column is dropped from (or quietly added to) the constant the
  // deployed SELECT is built from. This is an exact list on purpose — a
  // `toContain` per column would stay green on a list that grew silently.
  it('pins the exact columns emitProposals reads', () => {
    expect([...ROLE_ARCHETYPE_COLUMNS]).toEqual([
      'key',
      'name',
      'domain',
      'description',
      'responsibilities',
      'required_connector_categories',
      'system_templates',
    ]);
    // The SELECT string is DERIVED, never typed twice.
    expect(ROLE_ARCHETYPE_SELECT).toBe(ROLE_ARCHETYPE_COLUMNS.join(', '));
  });

  // The semantic half: the mutation the review actually performed. Drop
  // system_templates and every employee card loses its systems, which
  // validatePayload refuses — the failure mode that read as an ordinary
  // interview. Red if the constant ever stops carrying what the derivation
  // needs, whatever the exact list above happens to say.
  it('a draft derived from ONLY these columns names the systems it can touch', () => {
    const projected = ARCHETYPES.map((a) => {
      const row: Record<string, unknown> = {};
      for (const col of ROLE_ARCHETYPE_COLUMNS) row[col] = (a as unknown as Record<string, unknown>)[col];
      return row as unknown as ArchetypeLike;
    });
    const drafts = proposalsFrom(DIMS, { winning_business: { state: 'heard', evidence: CLEANING_WINNING } }, projected);
    const employees = drafts.filter((d) => d.kind === 'employee');
    expect(employees.length).toBeGreaterThan(0);   // vacuity guard
    for (const d of employees) {
      expect((d.payload.systems as string[]).length, `${d.payload.archetype_key} must name a system`).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R6 — an empty survivor set must not kill every trust rule
//
// IMPORTANT 5, measured: emitProposals built validDeRefs as a bare
// `new Set(...)`, and an EMPTY Set is TRUTHY. A session where zero employees
// survived therefore refused EVERY trust_rule as "does not match any employee
// actually proposed this session" — including a cap the customer had
// volunteered out loud, on a dimension that has nothing to do with which
// roles fit. The action_category path next to it already degraded correctly.
// ═══════════════════════════════════════════════════════════════════════════

describe('R6 — knowing nothing narrows the check; it does not refuse everything', () => {
  // Red if vocabularyOrUndefined ever returns an empty Set — the exact value
  // whose truthiness caused the defect.
  it('an empty vocabulary degrades to undefined, never to an empty Set', () => {
    expect(vocabularyOrUndefined([])).toBeUndefined();
    expect(vocabularyOrUndefined(['', '   '])).toBeUndefined();
    expect(vocabularyOrUndefined(['archetype:accounting'])).toEqual(new Set(['archetype:accounting']));
  });

  // THE CUSTOMER'S VOLUNTEERED CAP, through emitProposals' own two-pass
  // shape. Red if a trust rule dies because no employee survived.
  it('with ZERO surviving employees, a volunteered cap still survives', () => {
    const survivingEmployeeKeys: string[] = [];   // the measured case: nothing was groundable
    const validDeRefs = vocabularyOrUndefined(survivingEmployeeKeys.map((k) => `archetype:${k}`));
    expect(() => validatePayload(
      'trust_rule',
      { de_ref: 'archetype:accounting', action_category: 'action_execute', cap: 500 },
      { validDeRefs, validActionCategories: vocabularyOrUndefined(['action_execute', 'answer_dock']) },
    )).not.toThrow();
  });

  // The other direction, so this is a narrowing and not a hole: once
  // employees DO survive, membership is enforced again.
  it('once employees survive, a de_ref outside that set is refused again', () => {
    const validDeRefs = vocabularyOrUndefined(['billing_ar'].map((k) => `archetype:${k}`));
    expect(() => validatePayload(
      'trust_rule',
      { de_ref: 'archetype:accounting', action_category: 'action_execute', cap: 500 },
      { validDeRefs },
    )).toThrow(/does not match any employee actually proposed/);
  });

  // ...and the shape checks are still live in the degraded case — narrowing
  // is not skipping. Red if "unassigned" gets through when the set is empty.
  it('the degraded path still refuses "unassigned" and free text', () => {
    const validDeRefs = vocabularyOrUndefined([]);
    for (const bad of ['unassigned', 'the accounting team']) {
      expect(() => validatePayload(
        'trust_rule',
        { de_ref: bad, action_category: 'action_execute', cap: 500 },
        { validDeRefs },
      ), bad).toThrow(/reference/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// END TO END — A REAL INTERVIEW STILL PRODUCES A SCREEN
//
// ⚠ THE FAILURE THIS BLOCK EXISTS FOR. Every other block above proves the
// filter REFUSES things, and a filter that drops everything passes all of
// them perfectly. This one runs a plausible small-business interview across
// five dimensions and asserts the EXACT SURVIVING COUNT OF EVERY KIND —
// employees, connectors, procedure, guardrail and trust rule — through the
// same two-pass structure emitProposals uses, validDeRefs and all. Red if any
// count moves in either direction: an outage and an over-proposal are both
// this test going red, which is the point.
// ═══════════════════════════════════════════════════════════════════════════
describe('end to end — a realistic interview survives, and the counts say so', () => {
  it('five heard dimensions produce 9 decidable proposals across all five kinds', () => {
    const coverage = {
      winning_business: { state: 'heard' as const, evidence: 'we run Google Ads ourselves and an agency does our SEO' },
      money_in: { state: 'heard' as const, evidence: 'we invoice monthly out of Xero, net 30, and chase overdue accounts weekly' },
      systems_of_record: { state: 'heard' as const, evidence: 'everything lives in HubSpot, and support tickets come in by email' },
      must_never_happen: { state: 'heard' as const, evidence: 'never promise a refund without a manager sign-off' },
      who_signs_off: { state: 'heard' as const, evidence: 'journal entries over ten thousand need a second approver' },
    };
    const drafts = proposalsFrom(DIMS, coverage, ARCHETYPES, { providerCatalog: CATALOG });

    // What a compliant model returns: four roles grounded in a verbatim span
    // of a dimension that actually nominated them, six declined by omission,
    // and every structural literal filled. Identity fields copied back, as the
    // deployed prompt demands.
    const fills: Record<string, Record<string, unknown>> = {
      'employee:google_ads': {
        kind: 'employee', archetype_key: 'google_ads',
        evidence_quote: 'we run Google Ads ourselves',
        fit_reason: 'They already run Google Ads themselves and nobody is watching the spend.',
      },
      'employee:seo': {
        kind: 'employee', archetype_key: 'seo',
        evidence_quote: 'an agency does our SEO',
        fit_reason: 'An outside agency already does their search work, so nobody in-house reviews it.',
      },
      'employee:billing_ar': {
        kind: 'employee', archetype_key: 'billing_ar',
        evidence_quote: 'chase overdue accounts weekly',
        fit_reason: 'A day a week goes on running down invoices that are already overdue.',
      },
      'employee:support_agent': {
        kind: 'employee', archetype_key: 'support_agent',
        evidence_quote: 'support tickets come in by email',
        fit_reason: 'Tickets arrive in a shared mailbox with no queue behind them.',
      },
      'procedure:money_in': {
        kind: 'procedure', dimension: 'money_in',
        name: 'Chase overdue invoices', trigger: 'invoice 30 days past due',
        steps: ['send a reminder email', 'escalate to Finance'],
      },
      'guardrail:must_never_happen': { kind: 'guardrail', dimension: 'must_never_happen', pattern: 'refund|chargeback' },
      'trust_rule:who_signs_off': {
        kind: 'trust_rule', dimension: 'who_signs_off',
        de_ref: 'archetype:billing_ar', action_category: 'action_execute', cap: 10000,
        above_cap: 'Anything larger goes to the owner.',
      },
    };
    for (const d of drafts.filter((x) => x.needs_model_fill)) {
      const key = d.kind === 'employee' ? `employee:${String(d.payload.archetype_key)}` : `${d.kind}:${d.source_dimension}`;
      const fill = fills[key];
      if (fill) expect(applyFillToDraft(d, fill), key).toBeNull();
    }

    // emitProposals' own two passes: employees first, because the trust rule's
    // de_ref check is bounded by which of them SURVIVED.
    const kept: Record<string, string[]> = {};
    const refused: string[] = [];
    const keep = (d: ProposalDraft, opts: Parameters<typeof validatePayload>[2]) => {
      try {
        validatePayload(d.kind, d.payload, opts);
        (kept[d.kind] ??= []).push(String(d.payload.archetype_key ?? d.payload.provider_key ?? d.source_dimension));
        return true;
      } catch (e) { refused.push(`${d.kind}: ${e instanceof Error ? e.message : String(e)}`); return false; }
    };
    const survivingEmployeeKeys: string[] = [];
    for (const d of drafts.filter((x) => x.kind === 'employee')) {
      const key = String(d.payload.archetype_key);
      if (keep(d, { archetypeSelfText: selfTextFor(key) })) survivingEmployeeKeys.push(key);
    }
    const validDeRefs = vocabularyOrUndefined(survivingEmployeeKeys.map((k) => `archetype:${k}`));
    for (const d of drafts.filter((x) => x.kind !== 'employee')) {
      keep(d, { validDeRefs, validActionCategories: vocabularyOrUndefined(['action_execute', 'answer_dock']) });
    }

    // THE COUNTS. Candidates first, so nothing here is vacuous.
    expect(drafts.filter((d) => d.kind === 'employee')).toHaveLength(10);
    expect(kept.employee?.sort()).toEqual(['billing_ar', 'google_ads', 'seo', 'support_agent']);
    expect(kept.connector?.sort()).toEqual(['hubspot', 'xero']);
    expect(kept.procedure).toEqual(['money_in']);
    expect(kept.guardrail).toEqual(['must_never_happen']);
    expect(kept.trust_rule).toEqual(['who_signs_off']);
    const proposed = Object.values(kept).reduce((n, xs) => n + xs.length, 0);
    expect(proposed, 'a screen with nine things on it, not an empty one').toBe(9);
    expect(refused, 'exactly the six roles the model declined').toHaveLength(6);
    for (const r of refused) expect(r).toMatch(/^employee: .*carries no fit_reason/);
    // ...and the roles a customer running ads and invoicing out of Xero would
    // find absurd are the ones that went.
    for (const wrong of ['sdr', 'bdr', 'social_media', 'it_helpdesk', 'accounting', 'marketing']) {
      expect(kept.employee, `${wrong} must not be on the screen`).not.toContain(wrong);
    }
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

describe('proposalsFrom — conversation_type is NOT emitted (2026-08-15)', () => {
  // This test used to assert the OPPOSITE — that a heard
  // how_customers_reach_us derives "a complete, self-validating
  // conversation_type draft". It was inverted, not deleted, on 2026-08-15,
  // and the inversion is the point: a kind with no writer and no target
  // table must not reach a customer's screen wearing an accept button.
  //
  // Red if: the emitter comes back WITHOUT its writer. The kind returns in
  // the follow-up task carrying a real payload (match_pattern +
  // set_category) that writes support_triage_rules — the live topic axis on
  // de_conversations.category. When that lands, this test is rewritten to
  // assert the NEW payload shape. Until then, re-adding the old emitter
  // makes this go red on the same run that
  // scripts/discovery-proposal-check.mjs goes red on the row it produces.
  it('emits NO conversation_type draft for a heard how_customers_reach_us', () => {
    const drafts = proposalsFrom(DIMS, {
      how_customers_reach_us: { state: 'heard', evidence: 'they call and email' },
    }, ARCHETYPES);
    expect(drafts.filter((d) => d.kind === 'conversation_type')).toHaveLength(0);
    // ⚠ Vacuity guard. Asserting only an absence would also pass on a
    // proposalsFrom that emits nothing at all for any input, which is not
    // what was changed. That dimension still produces its employee drafts.
    expect(drafts.filter((d) => d.kind === 'employee').length).toBeGreaterThan(0);
  });

  // The KIND itself is untouched — validatePayload still knows its shape, so
  // the follow-up task re-enables an emitter rather than rebuilding a kind.
  // Red if: someone "cleans up" conversation_type out of the validator while
  // the emitter is off, which would make the return a much bigger change
  // than the ruling describes.
  it('still validates a conversation_type payload — the kind is dormant, not deleted', () => {
    expect(() => validatePayload('conversation_type', { label: 'Billing question', owner_ref: 'archetype:billing_ar' })).not.toThrow();
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
    // ⚠ THE COLUMN LIST IS NOT TYPED HERE. It is ROLE_ARCHETYPE_SELECT, the
    // same constant discovery-interview/index.ts builds its own SELECT from —
    // IMPORTANT 1 of the 2026-08-15 review. This line used to hold a SECOND
    // LITERAL COPY of the list, which pinned nothing at all: two adjacent
    // literals are deletable in one diff, and the review proved it by
    // reverting the deployed SELECT with the whole suite still green. A probe
    // reading the old column list would derive an empty `systems` for every
    // role and "prove" the fix by refusing everything.
    const archRows = await runQuery<ArchetypeLike & { required_connector_categories: string[] }>(
      `select ${ROLE_ARCHETYPE_SELECT} from public.role_archetypes where status = 'active'`,
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
    // INVERTED 2026-08-15: a candidate is a candidate, not a proposal. Raw
    // out of proposalsFrom it must now be REFUSED for having no fit_reason.
    expect(() => validatePayload('employee', employee!.payload)).toThrow(/fit_reason|consent/i);

    const connector = drafts.find((d) => d.kind === 'connector' && d.payload.provider_key === 'xero');
    expect(connector, 'xero connector draft must be present — "out of Xero" is an exact-label match').toBeTruthy();
    expect(() => validatePayload('connector', connector!.payload)).not.toThrow();

    // BLOCKER 2, against the REAL rows rather than the fixture copies at the
    // top of this file. Every live active archetype carries at least one
    // system_templates entry (checked live 2026-08-15: all 15 do), so every
    // employee candidate must name a real system — and front_desk in
    // particular must name what install_role_systems actually binds for it.
    for (const d of drafts.filter((x) => x.kind === 'employee')) {
      expect((d.payload.systems as string[]).length, `${d.payload.archetype_key} must name at least one system`).toBeGreaterThan(0);
    }
    const liveFrontDesk = drafts.find((d) => d.kind === 'employee' && d.payload.archetype_key === 'front_desk');
    if (liveFrontDesk) {
      const rcc = archRows.find((a) => a.key === 'front_desk')?.required_connector_categories ?? [];
      // Vacuity guard: this probe only proves something while the live rows
      // still DISAGREE. If required_connector_categories is ever corrected to
      // match system_templates, this assertion stops distinguishing the two
      // and must be rewritten rather than deleted.
      if (!rcc.includes('knowledge_base')) {
        throw new Error(`vacuity guard: live front_desk.required_connector_categories is now ${JSON.stringify(rcc)} — the column this card must NOT read no longer says knowledge_base, so this probe proves nothing. Rewrite it, do not delete it.`);
      }
      const systemsText = (liveFrontDesk.payload.systems as string[]).join(' ');
      expect(systemsText.toLowerCase(), 'front_desk must name the crm binding install_role_systems actually creates').toContain('crm');
      expect(systemsText, 'front_desk must NOT name knowledge_base — no writer ever binds it for this role').not.toContain('knowledge_base');
    }

    // R1 against the REAL spine: billing_ar is nominated by money_in,
    // repetitive_work AND systems_of_record live today, so a card built from
    // a session that heard more than one of them must carry more than one
    // sentence. Vacuity-guarded rather than assumed, because the live
    // serves_archetypes lists are the thing under test.
    const billingDims = dimRows.filter((d) => d.serves_archetypes.includes('billing_ar')).map((d) => d.key);
    if (billingDims.length < 2) {
      throw new Error(`vacuity guard: billing_ar is nominated by ${billingDims.length} live dimension(s) — the union has nothing to union. Rewrite this probe, do not delete it.`);
    }
    const multiCoverage: Record<string, { state: 'heard'; evidence: string }> = {};
    for (const key of billingDims) multiCoverage[key] = { state: 'heard', evidence: `sentence recorded under ${key}` };
    const multiDrafts = proposalsFrom(dimRows, multiCoverage, archRows);
    const multiBilling = multiDrafts.filter((d) => d.kind === 'employee' && d.payload.archetype_key === 'billing_ar');
    expect(multiBilling, 'still exactly one card per role').toHaveLength(1);
    expect((multiBilling[0].payload.evidence_sources as EvidenceSource[]).map((s) => s.dimension).sort())
      .toEqual([...billingDims].sort());
    console.log(`R1 live: billing_ar nominated by ${billingDims.length} dimension(s) — ${billingDims.join(', ')} — one card carrying all of them`);
    // The LAST dimension's sentence grounds it, which is the case the shipped
    // code refused by construction.
    const lastKey = billingDims[billingDims.length - 1];
    expect(() => validatePayload('employee', {
      ...multiBilling[0].payload,
      evidence_quote: `sentence recorded under ${lastKey}`,
      fit_reason: 'Chasing money already owed is eating a day of somebody\'s week here.',
    })).not.toThrow();

    // And once a model grounds one, the SAME gate accepts it — one gate,
    // both paths, exactly as for guardrail/procedure/trust_rule.
    const grounded = {
      ...employee!.payload,
      evidence_quote: 'chase overdue accounts weekly',
      fit_reason: 'They invoice monthly out of Xero and chase what is owed by hand every week.',
    };
    expect(() => validatePayload('employee', grounded)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FIX WAVE 2 (2026-08-15) — four defects the second adversarial lens
// measured, all one layer ABOVE the code the first fix wave repaired.
//
// Each test below was watched failing against the code as it stood before
// its fix; the red output is recorded in the commit message. They are
// grouped here rather than folded into the blocks above because they are
// about what the CARD claims and what the CHECK tolerates, not about which
// roles survive.
// ─────────────────────────────────────────────────────────────────────────
describe('discovery proposals — the quote check tolerates the model, and the card cannot crop a negation', () => {
  const NOTE = "we do run google ads and pay an seo agency, but nothing's in a crm";
  const base = {
    name: 'Paid Search Specialist',
    job: 'Paid Search Specialist',
    department: 'marketing',
    archetype_key: 'google_ads',
    systems: ['Ad accounts (read only)'],
    starts_supervised: true,
    sends_nothing: true,
    comes_with_published_sop: true,
    evidence: NOTE,
    evidence_sources: [{ dimension: 'systems_of_record', title: 'Where the record lives', evidence: NOTE }],
    fit_reason: 'They are already spending on paid search with nobody watching the budget.',
  };

  // BLOCKER 3. A model asked for a quotation wraps it and terminates it —
  // and the card then renders it inside quotation marks of its own, which
  // makes wrapping the MORE natural output, not the less. Every one of these
  // was a role the recorded note supported, dropped silently to console.error.
  const tolerated: ReadonlyArray<readonly [string, string]> = [
    ['bare span', 'we do run google ads'],
    ['straight double quotes', '"we do run google ads"'],
    ['curly double quotes', '\u201cwe do run google ads\u201d'],
    ['single quotes', "'we do run google ads'"],
    ['terminating full stop', 'we do run google ads.'],
    ['trailing comma', 'we do run google ads,'],
    ['quoted AND terminated', '"we do run google ads."'],
    ['leading/trailing space', '   we do run google ads   '],
  ];
  for (const [label, quote] of tolerated) {
    it(`accepts a quote the model delimited — ${label}`, () => {
      expect(() => validatePayload('employee', { ...base, evidence_quote: quote })).not.toThrow();
    });
  }

  // ⚠ THE INVERSION. Stripping the model's delimiters must not become
  // "match approximately". If these stop being refused, the check has been
  // loosened rather than made tolerant, and it no longer proves the fill
  // model did not write the words itself.
  const stillRefused: ReadonlyArray<readonly [string, string]> = [
    ['a span stitched across a gap', 'we do run google ads ... in a crm'],
    ['an ellipsis join', 'we do run google ads \u2026 pay an seo agency for it'],
    ['words the note never contained', 'we spend heavily on paid search'],
    ['a tidied-up paraphrase', 'we do run Google Ads campaigns'],
    ['inner punctuation removed', 'we do run google ads and pay an seo agency but nothings in a crm'],
  ];
  for (const [label, quote] of stillRefused) {
    it(`still refuses ${label}`, () => {
      expect(() => validatePayload('employee', { ...base, evidence_quote: quote })).toThrow(/not a verbatim span/);
    });
  }

  it('strips only ONE symmetric pair, so a nested quotation stays part of the span', () => {
    const note = 'the site manager said "we never chase them" and left it there';
    const p = {
      ...base,
      evidence: note,
      evidence_sources: [{ dimension: 'money_in', title: 'How money comes in', evidence: note }],
    };
    // The customer's own quotation marks are INSIDE the span and must survive.
    expect(() => validatePayload('employee', { ...p, evidence_quote: 'said "we never chase them" and left it' })).not.toThrow();
  });
});

describe('discovery proposals — the card shows the whole recorded note, not the span', () => {
  // BLOCKER 4, measured: nothing requires a substring to preserve the meaning
  // of the sentence it came from. All three of these PASS the gate — they are
  // genuinely verbatim — so the gate is not where this is caught. The card is.
  const cropped: ReadonlyArray<readonly [string, string, string]> = [
    ['negated', "we don't run google ads at all, it's all word of mouth", 'run google ads at all'],
    ['done by someone else', 'we never chase overdue invoices, the owner does it himself', 'chase overdue invoices'],
    ['explicitly deferred', 'if we ever grow we might need someone to manage social media, not now', 'need someone to manage social media'],
  ];

  for (const [label, note, quote] of cropped) {
    it(`the gate cannot catch a ${label} span — this is why the card must not show the span alone`, () => {
      const payload = {
        name: 'Role', job: 'Role', department: 'x', archetype_key: 'google_ads',
        systems: ['Ad accounts (read only)'],
        starts_supervised: true, sends_nothing: true, comes_with_published_sop: true,
        evidence: note,
        evidence_sources: [{ dimension: 'systems_of_record', title: 'Where the record lives', evidence: note }],
        evidence_quote: quote,
        fit_reason: 'There is paid activity here that nobody is currently accountable for.',
      };
      // Documents the limit rather than asserting a behaviour we do not have:
      // the span IS verbatim, so validatePayload accepts it, and the module
      // header says so in as many words.
      expect(() => validatePayload('employee', payload)).not.toThrow();
    });
  }
});
