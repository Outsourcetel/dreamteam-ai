# Discovery Interview — design

**Date:** 2026-08-12 · **Status:** approved in brainstorm, not yet planned or built
**Origin:** founder item 1 of the first-user review — see `docs/54-first-user-feedback-hudson.md`
**Next step:** implementation plan via `superpowers:writing-plans`

---

## 1. The problem

A new company signs up, answers two questions (organisation name, industry), and is handed a
workspace someone else designed: four digital employees it did not ask for, two playbooks shaped
for a telecom support desk, and seven guardrails lifted verbatim from a demo tenant. The industry
answer is written to `tenants.industry` and read by **no seeding code at all**.

Stage A already removed the wrong things (migration 723 — a new tenant now gets one employee plus
Ada). This design replaces them with the right thing: **a plain-English interview that asks a
company about its business and returns draft recommendations it approves** — digital employees,
procedures, systems to connect, guardrails, trust rules and conversation types.

The founder's framing: *"allow them to talk to us as plain English templates and we specifically
ask questions to understand their requirements … and then recommend draft DEs and Playbooks and
Guardrail rules, system connectors/MCPs vs going out there with senseless defaults."*

## 2. Decisions on the record

Taken during the 2026-08-12 brainstorm. Do not re-litigate.

1. **One flow, replacing both existing surfaces.** `CompanySetupPage` (the first-login wizard) and
   `OnboardingArchitectPage` (`/setup/quick-start`) are both retired. A third surface would make
   the problem worse.
2. **⚠ HARD CONSTRAINT: the Workspace Assistant and its chatbot are untouched.** Verified
   satisfiable — neither retired page, nor `onboardingArchitectApi`, nor `onboarding-assist`
   references it; `is_workforce_assistant` is read only by `DEChatDock.tsx`, `de-answer`,
   `workforce-chat`, `provision-workforce-assistants`, `certify.mjs` and `provision.mjs`, none of
   which this work touches. **Enforced by a test (§9), not by anyone's memory.**
3. **Ada is retired.** Setup is a feature, not a colleague. A new tenant gets exactly one employee.
   **Scope of "retired": the trigger stops creating her, so no NEW tenant gets one.** What to do
   about the 17 existing tenants that already have her is deliberately left open — see §10.
4. **Two phases, but the first is complete in coverage.** Founder's qualification, verbatim:
   *"I don't want to lose the depth of the interview or getting side tracked because customer got
   focused on one thing and forgot other critical pieces."* Few questions, whole surface.
5. **Approach C — checklist-driven conversation.** A fixed spine decides *what* must be covered;
   the conversation decides *how*. Rejected: an open `ai-session` chat (coverage merely hoped for,
   wanders — the named failure mode) and a step wizard (coverage guaranteed but it is a form, and
   cannot follow up).
6. **Systems get a memory** (§6) — carried inside Stage D, not deferred.
7. **Anything can be parked** (§7), and `parked` is a different state from `skipped`.

## 3. The spine

**Dimensions are not questions.** The spine is what must be *known*, not what must be *asked*. One
question can close three dimensions — *"walk me through what happens from someone first contacting
you to you actually getting paid"* covers 2, 3 and 6. The model's job is to cover the spine in as
few questions as it can, not to march down it. This is what makes "short" and "complete" compatible.

**The requirement is coverage, not a question count.** "~6–10 questions" appears below as an
expectation to design toward, never as a limit to enforce: no dimension may be dropped to hit a
number, and a verbose customer may legitimately close the spine in four. The only hard rule is that
every dimension ends in one of the four states in §7 — never silently unaddressed.

| # | Dimension (`key`) | Produces |
|---|---|---|
| 1 | `what_we_do` | industry, vocabulary, pipeline stages |
| 2 | `how_customers_reach_us` | support / front-desk roles, channels, **conversation types** |
| 3 | `money_in` | billing-AR, collections, renewal roles + overdue procedures |
| 4 | `money_out` | accounting / FP&A roles, **approval limits** |
| 5 | `winning_business` | SDR, BDR, marketing, ads, SEO, social roles |
| 6 | `after_the_sale` | onboarding, success, renewal roles |
| 7 | `repetitive_work` | **procedures / SOPs** — the highest-value signal |
| 8 | `systems_of_record` | **connectors / MCPs**, matched to each role's required categories |
| 9 | `must_never_happen` | **guardrails**, compliance packs (e.g. HIPAA) |
| 10 | `who_signs_off` | **trust rules**, autonomy limits, escalation |
| 11 | `who_is_who` | org units, owners, escalation targets |
| 12 | `what_good_looks_like` | KPIs, performance contract |

**Dimensions 9 and 10 are the ones a customer never volunteers.** Nobody opens with what they must
never do. They are exactly what the sidetrack protection exists for: if skipped, the proposal says
the workspace has no limits set rather than quietly shipping one with none.

**Three dimensions can be understood but not staffed.** There is no procurement, legal or QA
archetype among the 15 that exist. Honest output: *"we heard this, we cannot staff it yet"*,
recorded as a capability gap — never a role invented with no SOP, watchers or guardrails behind it.

## 4. Architecture

**Built new**

| Component | Purpose |
|---|---|
| `discovery_dimensions` | The spine **as seeded rows, not a hardcoded array.** Adding procurement later is an INSERT plus an archetype — no redeploy of the interview. |
| `discovery_sessions` | One per attempt: transcript, coverage map, status, resume point. |
| `discovery_proposals` | The drafts, tied to a session. |
| `connector_providers` | The systems memory (§6). |
| `discovery-interview` edge fn | Drives the spine, extracts structure, picks the next question, calls the existing drafters. |
| Interview + proposal UI | Replaces both retired pages. |

**Reused unchanged** — `entity-draft` (employee config + clarifying questions) · `playbook-draft`
(prose → typed steps validated against the real engine validator, with `playbook_gaps`) ·
`compile-trust-plan` (prose → draft ladders + `guardrail_suggestions` + honest `unmapped`;
validates against the live `validate_trust_ladder` with reject-and-retry — **the best-built
precedent in the codebase, copy its shape**) · `role_archetypes` including `setup_questions` ·
`install_role_kit` · `required_connector_categories`.

**Retired** — `CompanySetupPage`, `OnboardingArchitectPage`, `onboarding-assist`, Ada's DE and her
`provision_onboarding_architect_trg` trigger (mig 143).

**Moved, and each is a defect if forgotten**

- `onboarding-assist/index.ts:57` matches Ada **by literal name** and returns HTTP 409
  `no_architect` without her. Retiring her while that function still lives breaks it — which is why
  the function and the DE are retired **in the same step** (§11 step 7), never separately.
- Ada's trigger is the **sole creator of the `platform_admin` connector** (all 17 non-demo tenants
  have exactly one). This is admin plumbing and moves into baseline provisioning.
- ⚠ certify's `workspace-admin-has-an-owner` is guarded by
  `exists(connector … category='platform_admin')` — once Ada is gone it would **pass vacuously**.
  Fix regardless of this work.
- `GettingStartedGuide.tsx:37` excludes Ada **by name** and calls her "the hero of step 1".
- `proposeTailoredSetup` (`hireApi.ts:215`) is **regex, not LLM**, keyed on fields only
  `renewal_manager` fully carries; it returns all-nulls for most roles. Superseded by the
  interview — delete rather than maintain.

**Capability gaps are derived, never hand-maintained.** A dimension declares
`serves_archetypes text[]`. If none resolve to something installable, the interview reports the gap
automatically. The day a procurement archetype ships, that dimension starts proposing with **no
change to the interview**. Side benefit: the gap list is a **demand sensor** — *"eleven companies
described procurement work we could not staff"* is evidence for what to build next, collected
rather than guessed.

**One deliberate departure from Ada.** Her proposals went into `action_executions`, the same queue
as operational approvals, and **19 of 26 are still undecided, 5 expired**. Setup approval belongs
*in the setup flow*, not an ops queue. Governance comes from the writers, not the queue: every
accepted proposal goes through the same validated, audited function a human would have used.

## 5. The arc

```
First login
  │
  ├─ PHASE 1 — spine conversation (~6-10 questions, 12 dimensions)
  │    answer → extract → mark dimensions → pick next question
  │    ends when the spine is covered, or the customer parks/stops
  │
  ├─ PROPOSAL SCREEN — two columns, equal visual weight
  │    WHAT WE RECOMMEND            WHAT WE DIDN'T HEAR
  │    employees, procedures,        · nothing about what must never go wrong
  │    systems, guardrails,          · nobody owns collections
  │    trust rules                   · procurement — cannot staff yet
  │
  ├─ accept / decline / PARK, item by item
  │
  ├─ PHASE 2 — only for accepted roles, their own 4-8 setup_questions
  │
  └─ creation through the ordinary validated writers
```

**How each artifact becomes real**

- **Employees** — `entity-draft` → `install_role_kit`, which brings the SOP, watchers, guardrails
  and KPIs. The path that already works from the hire wizard.
- **Procedures** — `playbook-draft` → `playbook_definitions` **as `draft`, never `published`.**
  Nothing runs until a human publishes it.
- **Guardrails and trust** — `compile-trust-plan` → `addGuardrailRule` / `set_trust_ladder`.
- **Systems** — see §6.
- **Conversation types** — proposed against the existing taxonomy; note mig 671 concluded the fix
  there is *not* "add keywords", so this proposes topics, it does not re-engineer triage.

**An accepted role whose system is not connected is a half-built employee** — it exists and its
procedures cannot touch anything. Visible on the employee from day one, not discovered later.

## 6. Systems memory

`connectors.status` today allows only `connected | error | disconnected` — there is **no state for
"prepared, waiting on you"**, which is precisely what this needs. Add `pending_credentials`.

**`connector_providers`** — one row per known system: `provider_key`, label, `category`,
**`aliases text[]`** (so "Xero", "xero accounting", "we do our books in zero" all resolve),
`auth_kind` (`oauth | api_key | basic`), which credential is needed and where in that product to
find it, default base URL, exposed objects, and which action categories it unlocks.

**Done on the customer's behalf, with approval:** match free text to a provider · create the
`connectors` row already named, categorised and pointed at the right base URL, at
`pending_credentials` · bind the accepted employee's access grant · state the one credential to
fetch and where · after they authenticate, discover objects, propose the field mapping, propose
which actions to switch on — each approved, none silent.

**⚠ Never done on their behalf: entering credentials or completing OAuth.** Not a technical limit —
it is the customer's security boundary and stays theirs.

**Two structural wins.** `TOP_PROVIDERS` has no entry for ads, social or web analytics, so **4 of
15 archetypes** demand a category with nothing to suggest; the catalog is where that is fixed once,
in data. And the provider list stops being a ~75-entry TypeScript array hand-synced against a
76-value database CHECK — a drift waiting to happen.

## 7. Park, resume, failure

**Four dimension states, because `parked` and `skipped` are not the same thing.**

| State | Means | Behaviour |
|---|---|---|
| `heard` | covered | done |
| `parked` | "ask me later" | **comes back** |
| `skipped` | "not relevant to us" | **stops asking** |
| `not_heard` | never reached | shows as a gap |

Collapsing them would either nag people who declined, or silently bin things they meant to return
to. Proposals carry the same states: `pending / accepted / declined / parked`. The whole interview
parks too; resume lands at the same point with accepted items still standing.

**⚠ The risk, named.** This product already has an unintended parking problem — 19 of Ada's
proposals undecided, 5 expired, and the review programme's conclusion was that **human decisions
are the bottleneck**. *A park button that drops things into an invisible pile is that same failure
with better manners.* Park is only acceptable with a visible home: a setup card on the workspace
showing what is parked, with a direct way back in. **No nagging job in v1** — this codebase has
real alerting traps (`raise_ops_alert` dedups on kind globally), and an unread notification is not
a decision. Follows the support park/snooze precedent, which is proven working.

**Other failure modes.** Abandonment mid-interview keeps what was accepted and records the gaps —
partial is a legitimate end state, not an error. A failed or nonsense model turn costs one
question, not the session, because the spine is the source of truth for coverage. A dimension that
cannot be staffed is recorded as a capability gap.

## 8. Data model sketch

```
discovery_dimensions   key PK · ordinal · title · guidance · serves_archetypes text[]
                       · produces text[] · required boolean · active boolean
discovery_sessions     id · tenant_id · status(running|proposed|accepted|parked|abandoned)
                       · coverage jsonb {dim_key: {state, evidence, at}}
                       · transcript jsonb · resume_hint · created_by · timestamps
discovery_proposals    id · session_id · tenant_id · kind(employee|procedure|connector|
                         guardrail|trust_rule|conversation_type)
                       · payload jsonb · rationale text · source_dimension
                       · state(pending|accepted|declined|parked) · decided_by · decided_at
                       · created_object_id (set on accept)
connector_providers    provider_key PK · label · category · aliases text[] · auth_kind
                       · credential_hint · credential_where · default_base_url
                       · exposed_objects jsonb · unlocks_action_categories text[] · active
connectors             + status 'pending_credentials' (CHECK widened)
```

RLS tenant-scoped throughout; writes owner/admin only. Every function gets EXECUTE revoked from
`public`, `anon`, `authenticated` and granted explicitly, with `has_function_privilege` asserted in
both directions — per migrations 610/630/722 doctrine.

## 9. Verification

**The sidetrack test is the one that matters.** A fixture transcript discussing nothing but support
tickets must end with `money_in`, `must_never_happen` and `who_signs_off` marked `not_heard`, and
the proposal must surface all three. *If that test cannot fail, this feature does not work.*

- **Invert every pin.** Per dimension, one transcript that covers it and one that does not — 24
  comparisons, and **the comparison count is reported**, because zero findings from zero
  comparisons looks exactly like a clean result.
- **Park ≠ skip, proven.** One transcript parks and resumes (must be asked again); one skips (must
  not be).
- **Nothing live unreviewed.** Procedures land `draft` never `published`; guardrails go through the
  audited writer; no connector reaches `connected` without customer-supplied credentials.
- **Extensibility as a test, not a claim.** Remove an archetype → its dimension must automatically
  report unstaffable. Proves the procurement path before procurement exists.
- **The Workspace Assistant constraint, enforced by machinery.** Assert the interview never writes
  to a DE with `is_workforce_assistant = true`.

All of it runs in `certify`, and each check is **mutation-tested** the way this repo already does
(`certify:mutation`) — broken deliberately, confirmed red. A gate that has never fired is not a gate.

## 10. Out of scope

Approval-limit generalisation (item 2), Your Data / Customers object types (item 3), the escalation
taxonomy (item 17), certification purpose (item 19), and the Stage C consolidations (items 9, 12,
13, 18). The interview *proposes* trust rules and guardrails using today's model; it does not
redesign that model.

Retiring Ada for the **17 existing tenants** is a separate decision — the founder's standing choice
on the starter employees was *new tenants only*, and the same question applies here. Not assumed.

## 11. Rollout ordering

1. `connector_providers` + `pending_credentials` state (independent, useful alone).
2. Move `platform_admin` connector creation into baseline provisioning; fix the vacuous certify
   check. **Both before Ada is retired.**
3. Spine tables + seed the 12 dimensions.
4. `discovery-interview` edge function + phase 1.
5. Proposal screen + accept/decline/park.
6. Phase 2 (`setup_questions` for accepted roles) + creation via validated writers.
7. Retire the two pages, `onboarding-assist`, Ada's trigger, and `proposeTailoredSetup`.
8. Certify checks + mutation tests.

Steps 1–2 are safe to ship before the interview exists. Step 7 is the only irreversible one and
comes last, after the replacement is proven.
