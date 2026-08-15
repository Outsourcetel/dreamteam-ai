# Discovery Proposals and Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a covered interview into draft recommendations a company can decide on, and create only what it accepts — through the writers a human would have used.

**Architecture:** The engine emits typed rows into `discovery_proposals`; a screen renders them as `DecisionCard`s batched by stakes; accepting one calls the ordinary validated writer for that kind. Nothing is created until it is accepted, and nothing is created by a path a human could not have taken.

**Tech Stack:** Postgres (Supabase), Deno edge functions, React + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-discovery-interview-design.md` — read **§11b (short proposals)** first, it is the design law for this plan, then §5 (the arc), §7 (park), §12 (handoff).

## Scope: §11 steps 5–6

- ✅ here: proposal **generation** · the proposal screen · accept / decline / **park** · creation through validated writers · phase two (`setup_questions` for accepted roles) · certify coverage.
- ❌ **Plan 4** (§11 step 7): retiring `CompanySetupPage`, `OnboardingArchitectPage`, `onboarding-assist`, Ada, `proposeTailoredSetup`. Also the first-login route change — this plan adds a route, it does not take over the entry point.

## ⚠ INHERITED WORK THIS PLAN MUST NAME

Plan 3's scope line claimed `discovery_proposals` "(written, not acted on) ✅ here". **Nothing writes them.** Every task in that plan passed review and that deliverable is unmet — so **proposal generation is Task 1 here**, and it is a second model-driven component with its own validation problem, not a screen detail. Budget for it accordingly.

Also inherited, from Plan 3's ledger:
- **`discovery_capability_gaps.customer_message` is authored, tested, load-bearing — and nothing reads it.** Founder Ruling A item 2 has had zero surfaces since it shipped. This plan gives it one (Task 2).
- **No server-side per-dimension ask counter.** The vague-answer parking rule relies on the model recalling a prior ask from a 24-turn transcript window.
- **`discovery_sessions.status`** now has `end_discovery_session` (migration 739), so completion is writable — but read completion from the coverage ledger via `stillOwed`, never from `status`.

## ⚠ THE ORDERING CONSTRAINT — measured, and it decides the screen's sequence

`set_trust_ladder(p_policy_id, …)` takes a **policy id** and raises `trust policy not found` if the row does not exist. **None of `install_role_kit`, `install_role_systems` or `instantiate_role_archetype` creates one.** Only `provision_starter_de_internal` (the starter-DE path, now default-off), `seed_trust_policies` and `seed_de_trust_policy` do.

Live today: **90 policies across 41 of 107 non-retired employees — 66 have none.**

So a trust-rule proposal **cannot be applied to a freshly-accepted employee** without a policy row existing first. Task 3 must call `seed_de_trust_policy` (or equivalent) for the accepted employee before `set_trust_ladder`, and must fail loudly rather than silently skipping if it cannot. **This also means trust rules cannot be decided before their employee is accepted** — that is a real sequence in the UI, not a preference.

## Global Constraints

- **Never pick a migration number.** Claim it only with `npm run migrate:next -- <slug>`. **Commit before applying** — and note the guard now refuses a *modified* tracked file too, so `git status --short` must be clean at apply time.
- Every function: EXECUTE revoked from `public`, `anon`, `authenticated`, granted explicitly, asserted with `has_function_privilege` in BOTH directions using the full signature form.
- Every migration ends with a `do $$` that RAISES and **can actually fail**. ⚠ Nine instances of the check-that-cannot-fail trap in five days. For every check, name the data that turns it red; if you cannot, it is theatre.
- **The pairing rule.** Report counts compared, not only findings. Zero examined is itself a violation.
- **⚠ The Workspace Assistant and its chatbot are untouched.** Nothing may read or write a `digital_employees` row with `is_workforce_assistant = true`.
- **Creation happens ONLY through the ordinary validated writers** — `install_role_kit`, `playbook-draft`→`playbook_definitions`, `addGuardrailRule`, `set_trust_ladder`, a `connectors` row at `pending_credentials`. No new creation engine. If a writer refuses, the proposal stays `pending` and says why.
- Follow `docs/design-system.md`. `DecisionCard` and `Drawer` are existing primitives — use them, do not invent.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/functions/discovery-interview/index.ts` (modify) | emit proposals at interview end |
| `supabase/functions/_shared/discoveryProposals.ts` (create) | pure: coverage + dimensions → typed proposals; per-kind payload validation |
| `supabase/migrations/<n>_*.sql` (create) | `accept_discovery_proposal` / `decide_discovery_proposal` RPCs |
| `src/pages/tenant/DiscoveryProposalsPage.tsx` (create) | the screen |
| `src/lib/discoveryApi.ts` (create) | client calls |
| `tests/discovery-proposals.test.ts` (create) | payload contracts, batching rules, ordering constraint |
| `scripts/discovery-spine-check.mjs` (modify) | extend the certify section |

---

## Task 1: Proposals a person could actually decide on

**Files:** create `supabase/functions/_shared/discoveryProposals.ts`; modify `supabase/functions/discovery-interview/index.ts`; create `tests/discovery-proposals.test.ts`

**Interfaces:**
- Consumes: `coverageAfter`/`stillOwed` from `_shared/discoveryCoverage.ts`; `discovery_dimensions.produces`; `role_archetypes`.
- Produces: `export function proposalsFrom(dimensions, coverage, archetypes): ProposalDraft[]` — pure, testable without a model — and a `validatePayload(kind, payload)` that **refuses** an incomplete payload rather than emitting a card a person cannot decide on.

- [ ] **Step 1: Write the failing test — the payload contract per kind**

Per §11b, each kind's card must carry enough to *predict what changes without you*. Encode that as refusals, not suggestions:

```typescript
import { describe, it, expect } from 'vitest';
import { validatePayload } from '../supabase/functions/_shared/discoveryProposals.ts';

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
```

- [ ] **Step 2: Run it, confirm it fails because the module does not exist.** Paste the output.

- [ ] **Step 3: Implement `validatePayload`, then `proposalsFrom`**

`proposalsFrom` reads each dimension's `produces` and the coverage evidence and emits drafts. **Only `heard` dimensions may produce proposals** — a `skipped`, `parked` or `not_heard` dimension proposes nothing, because there is no evidence to base it on.

- [ ] **Step 4: Emit at interview end, into `discovery_proposals` with `state='pending'`**

⚠ Generation must not create anything else. No DE, playbook, guardrail or connector row. Proposals only.

- [ ] **Step 5: Typecheck, run, commit.** Report real counts.

---

## Task 2: A screen that is short where that is safe

**Files:** create `src/pages/tenant/DiscoveryProposalsPage.tsx`, `src/lib/discoveryApi.ts`; add a route.

**Interfaces:** Consumes `discovery_proposals`, `discovery_capability_gaps`. Produces the screen; **no decision writes yet** — Task 3 adds those.

- [ ] **Step 1: Read `docs/design-system.md` and the existing `DecisionCard`/`Drawer` before writing anything.** Both exist. Do not invent a card.

- [ ] **Step 2: Build the card per §11b's contract**

Title in plain English · one sentence of consequence · **the enforceable literal in `meta`** (`matches: refund|chargeback`, `over $10,000`, `HubSpot · reads deals, writes notes`) · the one thing changeable later. ~25 words plus one literal. A `Drawer` carries rationale, `source_dimension`, the transcript sentence it came from, and what accepting writes. **One disclosure level, never two.**

- [ ] **Step 3: Batch by stakes — and honour the two that never batch**

- Low-stakes (`conversation_type`, `procedure`, `connector`) → "accept all N" with per-item unchecking. Their second gate (publish / credential) is the real consent.
- `employee` → batch by department, every card individually visible.
- ⚠ **`guardrail` and `trust_rule` NEVER batch.** Guardrails because comparing across rules is the task disclosure ruins; trust rules because they are the only proposal that removes a human.
- ⚠ **No all-at-once accept anywhere.** §11b: that is the EULA shape that gets accepted blind.

- [ ] **Step 4: The capability-gap message**

Render `discovery_capability_gaps.customer_message` **below the last batch, as `Banner tone="info"` with no action control.** It cannot be approved, declined or parked — that is the point. ⚠ Do **not** use the two-column layout in spec §5; §11b corrects it.

- [ ] **Step 5: Trust rules appear only after their employee is accepted** — per the ordering constraint above. Until then, show them as blocked with the reason, not hidden.

- [ ] **Step 6: Typecheck, `node scripts/design-drift.mjs`, commit.**

---

## Task 3: Deciding, and creating only what was accepted

> **AMENDED 2026-08-15** after a ten-agent investigation produced
> `.superpowers/sdd/2026-08-13-discovery-proposals-and-creation/task-3-contract.md`.
> **Read the contract before writing any of this task.** Three things below
> contradict what this plan originally said, and the contract is right each time.

**Files:** create the migrations (prerequisite columns, then the RPC); modify the page,
`discoveryApi.ts`, `discoveryProposals.ts` and `discoveryProposalPresentation.ts`.

**Interfaces:** Produces
`decide_discovery_proposal(p_proposal_id uuid, p_decision text, p_note text default null, p_created_object_id uuid default null)`
returning **`jsonb`** — `accepted | declined | parked` — **`authenticated` only**, audited.

### Three corrections to this plan's own text

1. **"A single RPC calling the ordinary writer" is unsatisfiable.** Three of six kinds have
   no SQL writer: `guardrail` and `connector` are client TS inserts under RLS, `procedure`
   is an edge function and `pg_net` is fire-and-forget. **One RPC, two accept paths** —
   Path A (SQL-native: `employee`, `trust_rule`) and Path B (the browser calls the ordinary
   writer as the human under RLS, then the RPC stamps `p_created_object_id`). This is the
   shape already shipped at `src/lib/governanceAiApi.ts:111-153`.
2. **Not "service_role or owner/admin" — `authenticated` only.** Under `service_role`
   `auth.uid()` is null, and `instantiate_role_archetype` / `install_role_kit` guard with
   `auth.uid() is not null and not exists(…)`, so they **skip the authority check rather
   than fail it**. Four safety mechanisms fail open at once and the accept leaves no
   identity in the audit trail.
3. **Return `jsonb`, never a composite.** PostgREST serialises a NULL composite as all-NULL
   columns, so `if (!data)` never fires — the defect that logged one approval three times.

### Founder rulings, 2026-08-15

| Blocker | Ruling |
|---|---|
| `trust_rule` enforces nothing (90 policies, 0 ladders, 0 above level 0) | **Ship it, and say what it truly does.** The card states plainly that it sets the limit the employee will follow once it has earned trust, and that nothing changes today. |
| `conversation_type` has no table, no router, and a label that is always the interview's own question heading | **Fix it properly — make topics real.** Scope carved out below; do not ship the current no-op card. |
| Guardrail thresholds carry no unit; cents vs percent | **Ship patterns now, hold thresholds.** Pattern guardrails accept as `blocked_phrase`; a threshold-only payload is refused with a visible reason. |

### Build order (risk-ordered — see contract §9)

- [ ] **Step 0: Prerequisite migration.** `last_error`, `last_error_at`, `attempts` on
  `discovery_proposals` — Step 3 below is *impossible* without them, since the table has
  12 columns and nowhere to put a reason. Plus the `identity_key` generated column and its
  unique index, so a re-emitted proposal cannot produce a duplicate card. Table holds 0 rows.

- [ ] **Step 1: Write the failing tests** — park is not decline; a declined proposal creates nothing; an accepted one records `created_object_id`.

- [ ] **Step 2: The RPC.** Three zones, one transaction, exactly one sub-block (contract §3).
  The Zone-2 compare-and-swap (`where … state='pending' returning`) **is** the double-click
  guard. Accepting routes to the ordinary validated writer for the kind. ⚠ **For `trust_rule`,
  ensure a `trust_policies` row exists first** (`seed_de_trust_policy`) and **raise loudly if
  it cannot be created** — do not silently skip, and do not invent a second trust-writing path.
  Both trust writes share one sub-block: split them and a `validate_trust_ladder` refusal
  leaves an unconsented level-0 row that *shadows* the workspace row and silently narrows behaviour.

- [ ] **Step 3: A writer that refuses must leave the proposal `pending` with the reason visible.** A proposal that silently fails to become a thing is the worst outcome available here.

- [ ] **Step 4: Verification block** — a rolled-back probe proving accept creates exactly one object and records its id; decline creates nothing; park leaves it decidable. ⚠ Each refusal must be fired against data an *earlier* constraint would otherwise catch first — a check intercepted by a prior constraint proves nothing.

- [ ] **Step 5: Commit before applying** (`git status --short` clean), apply, re-run tests.

### Per-kind order, and what each is gated on

| # | Kind | Path | Gate |
|---|---|---|---|
| 1 | `connector` | B | none — build first. Smallest blast radius; the object genuinely cannot act. ⚠ **Do not write a `data_access_grants` row** — that grant is what arms the pollers past the status filter, and withholding it is what makes "you still enter the credential" true. |
| 2 | `guardrail` | B | pattern-bearing only, as `blocked_phrase`. Leave `compliance_pack_key` NULL or the row becomes un-retirable. |
| 3 | `employee` | A | **Fix the card first**: it reads `required_connector_categories`, the writer binds `system_templates`, and they disagree for every archetype sampled. Also weaken or gate "comes with a published SOP" — 0 of 15 archetypes produce a `playbook_versions` snapshot. |
| 4 | `procedure` | B | **Verify an LLM provider resolves in production before building.** With none, every accept returns `503 llm_not_configured`. |
| 5 | `trust_rule` | A | Last. Honest card copy per the ruling above. Resolve `de_ref` from the sibling employee proposal's `created_object_id`, never by `archetype_key` lookup (not unique per tenant). ⚠ `answer_dock` inverts the unit — `min_confidence` 0-100, not cents. |
| — | `conversation_type` | — | Carved out to Task 3c below. Do **not** ship the current accept control; its three presentation strings promise routing that does not exist. |

---

## Task 3c: Make conversation topics real

The founder ruled that topics should become a real thing rather than be dropped. This is a
genuine feature and is scoped separately so it cannot silently delay the five kinds above.

- [ ] **Step 1:** Establish what already exists for classifying conversations — the support
  topic axis, migration 671's channel split, the escalation taxonomy, and whether any
  playbook or knowledge row carries a joinable category. *(research in flight)*
- [ ] **Step 2:** Design and approve the topic model before building. It must have a reader
  at runtime — a topic nothing consults is the same no-op card in a new table.
- [ ] **Step 3:** Until it lands, remove the accept control from the `conversation_type` card
  and correct the three false strings at `discoveryProposalPresentation.ts:286,287,400`.

---

## Task 4: Phase two — the questions that already exist

**Files:** modify the page and the edge function.

- [ ] **Step 1:** For each **accepted** employee, ask that archetype's own `setup_questions` (4–8 each, 93 across 15 archetypes). ⚠ Only for accepted roles — that is the whole point of deferring them.
- [ ] **Step 2:** Answers land on the created employee through the existing configuration path, not a new one.
- [ ] **Step 3:** Tests, typecheck, commit.

---

## Task 5: Prove it can fail

**Files:** modify `scripts/discovery-spine-check.mjs`, `scripts/certify.mjs`, `scripts/certify-mutation-test.mjs`.

- [ ] **Step 1:** Extend the `discovery-spine` section: no `discovery_proposals` row in a terminal state without a `decided_by`/`decided_at`; no `accepted` row without a `created_object_id`; every `kind` value is one the writers can route.
- [ ] **Step 2:** Mutation fixtures for each, following the `provider-catalog` / `discovery-spine` shape — fixtures must import the **same** function certify calls.
- [ ] **Step 3:** Report counts. Zero examined is a violation. Report your section's result specifically; `certify:fast` is red for pre-existing reasons (`ring0-probes`, `migration-ledger`) — confirm those are unchanged.
- [ ] **Step 4:** Commit.

---

## Done when

- A covered interview produces proposals a person can decide on, each carrying the facts §11b requires for its kind.
- Guardrails and trust rules cannot be batch-accepted; nothing can be accepted all at once.
- The capability-gap message has a surface and cannot be actioned.
- Accepting creates through the ordinary validated writers only, and a refusal is visible rather than silent.
- Every new certify assertion has been seen to go red.
- No `digital_employees` row with `is_workforce_assistant = true` was read or written.
