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
  ├─ PHASE 1 — spine conversation (~6-10 questions, 14 dimensions)
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
3. Spine tables + seed the 14 dimensions.
4. `discovery-interview` edge function + phase 1.
5. Proposal screen + accept/decline/park.
6. Phase 2 (`setup_questions` for accepted roles) + creation via validated writers.
7. Retire the two pages, `onboarding-assist`, Ada's trigger, and `proposeTailoredSetup`.
8. Certify checks + mutation tests.

Steps 1–2 are safe to ship before the interview exists. Step 7 is the only irreversible one and
comes last, after the replacement is proven.

---

## 11b. SHORT PROPOSALS — researched 2026-08-13, founder asked "will be nice if we can give short proposals"

**The premise needed correcting first. Ada's cards were ALREADY short** — title plus four
key-value lines. Length was never why 19 of her 26 proposals went undecided; migration 737's own
header names the cause (they went into the ops queue). Her real defects were different: no decline
control, no cost, no statement of *what the thing will be able to do*, `approve` firing
immediately, and `params.outline` dumping unbounded prose into a card.

**So the goal is not "shorter". It is: shorter where that is safe, and never shorter where it is
not.**

### The evidence, and where it is contested

- **Choice overload is weaker than the folklore.** Scheibehenne, Greifeneder & Todd (2010, *JCR*
  37:409-425; 63 conditions, N≈5,036) found a **mean effect near zero**. Chernev, Böckenholt &
  Goodman (2015) recovered it only under four moderators: set complexity, task difficulty,
  preference uncertainty, decision goal. **Discovery proposals hit all four — so overload is real
  HERE, but item count is the wrong lever.**
- **Decision fatigue is the contested one.** Danziger et al. (2011) is undercut by
  Weinshall-Margel & Shapard (non-random case ordering) and Glöckner (2016, implausible d≈1.96).
  Do not design around it.
- **The well-evidenced failure is habituation from volume**, and it is severe: drug-interaction
  alert override ≈**90%**; Chrome SSL warning click-through **70.2%**; **74%** skip the policy via
  clickwrap; only **3%** understood Android permissions. ⚠ Most pointed of all — Böhme & Köpsell
  (CHI 2010): **the more a dialog looks like a EULA, the more blindly it is accepted.**
- Layered disclosure is regulator-sanctioned (WP29 WP260rev01 requires purpose, identity and rights
  in the *first* layer). But NN/g is clear that hiding content diminishes awareness of it and is
  **wrong when users must compare across items** — which is exactly guardrails and trust rules.

### THE LINE — irreversibility × blast radius, and it moves by kind

The card must carry every fact needed to **predict what changes without you**.

| Kind | On the card | Why |
|---|---|---|
| `conversation_type` | label + owner — one line | a label acts on nothing |
| `connector` | provider + what it reads/writes + "you still enter the credential" | the credential step **is** the second gate |
| `procedure` | name + trigger + "draft; runs only when you publish" | publish is the real gate |
| `employee` | name + job + **the systems it will be able to touch** + "starts supervised, drafts everything, sends nothing" + "comes with a published SOP" | tool reach belongs on the card, not behind a link |
| `guardrail` | the rule sentence **and its literal pattern or threshold, verbatim** | ⚠ **you cannot consent to a block you cannot predict** |
| `trust_rule` | employee + action category + the dollar/confidence cap + what happens above it | ⚠ **the only kind where no card is short enough** — it is the one proposal that removes a human |

### Shape, granularity, and the gap message

**Card shape:** reuse `DecisionCard` unchanged (it already has the right five slots) — title in plain
English · one sentence of consequence · the enforceable literal in `meta` (`matches: refund|chargeback`,
`over $10,000`, `HubSpot · reads deals, writes notes`) · Accept/Decline/Park · the one thing changeable
later. ~25 words plus one literal. A `Drawer` carries rationale, `source_dimension`, the transcript
sentence it came from, and what accepting writes. **One disclosure level, never two.**

**Granularity — batch by kind, ordered by stakes:**
- **All-at-once is refused** — it is the EULA shape Böhme & Köpsell showed gets accepted blind.
- **Item-by-item for ~40 items is also refused** — it manufactures the volume that produces
  90%-override habituation, and it is what cost Ada 19 decisions.
- Low-stakes kinds (`conversation_type`, `procedure`-as-draft, `connector`-at-`pending_credentials`)
  → "accept all N" with per-item unchecking, **because their second gate is the real consent.**
- `employee` → batch by department, every card individually visible.
- ⚠ **`guardrail` and `trust_rule` never batch** — guardrails because comparison across rules is
  the task disclosure ruins; trust rules because they are the only proposal that removes a human.

⚠ **CORRECTION TO §5:** the two-column "WHAT WE RECOMMEND / WHAT WE DIDN'T HEAR" layout is **wrong**
for the capability-gap message. Equal visual weight makes a non-decision compete with decisions.
Put `discovery_capability_gaps.customer_message` **below the last batch as a `Banner tone="info"`
with no action control** — it cannot be approved, declined or parked, so it cannot join the queue.

**Safely deferred** (each has a later unavoidable gate): connector field mappings and action
enablement · playbook step bodies · the archetype's own `setup_questions` (Phase 2 by design) ·
watcher configs · KPI targets · escalation contacts.
**NOT deferrable:** a guardrail's pattern/threshold, an employee's system access, a trust rule's cap
— *accepting them is the last human moment.*

### Volume, and one open question

Worst case ≈**80** proposals; a real SMB answering all 14 dimensions honestly lands at **30–45**.
Design for 40, survive 80.

⚠ **UNRESOLVED, and it changes the ordering:** does a `trust_rule` proposal *create* a
`trust_policies` row, or *edit* one `install_role_kit` already made? `set_trust_ladder` mutates an
existing row keyed on `(de_id, action_category)`. If it edits, trust rules cannot be proposed until
their employee is accepted — which constrains the whole screen's sequence. Settle this before
building the proposal screen.

---

## 12. START HERE — handoff for Plan 3 (written 2026-08-13)

Steps 1–2 of §11 are **DONE and live**. This section is what a session with no prior context needs.

### Already shipped

| Plan | Migrations | What it gave you |
|---|---|---|
| 1 — systems memory (`docs/superpowers/plans/2026-08-12-systems-memory.md`) | 727, 728, 729 | `connector_providers` (75 rows, seeded FROM the `PROVIDERS` constant by `scripts/gen-provider-seed.mjs`, drift-guarded both ways in certify) · `connectors.status = 'pending_credentials'` · `matchProvider()` in `src/lib/connectorApi.ts` · ads/social/web_analytics gaps closed |
| 2 — Ada prerequisites (`docs/superpowers/plans/2026-08-13-ada-prerequisites.md`) | 730, 731, 732 | `provision_platform_admin_connector_internal()` called on **all three** tenant-creation paths · EXECUTE grants asserted 12 ways · `workspace-admin-has-an-owner` de-vacuumed, with a denominator and a mutation fixture |

Both plans' full ledgers, with every deferred minor and parked ruling, are in
`.superpowers/sdd/2026-08-12-systems-memory/progress.md` and
`.superpowers/sdd/2026-08-13-ada-prerequisites/progress.md`. **Read them before planning** — they
record five separate instances of the check-that-cannot-fail trap found in three days.

### Recommended scope split for what remains

§11 steps 3–8 are too much for one plan. Split at the irreversible seam:

- **Plan 3 — the interview.** Spine tables + seed · `discovery-interview` edge fn + phase 1 ·
  proposal screen with accept/decline/park · phase 2 via `setup_questions` · creation through the
  validated writers. Works end to end when done; nothing is destroyed.
- **Plan 4 — the retirement.** Retire `CompanySetupPage`, `OnboardingArchitectPage`,
  `onboarding-assist`, Ada, and `proposeTailoredSetup`; land the certify checks. **Only after
  Plan 3 is proven.**

### Carried decisions and gotchas — do not rediscover these

- ⚠ **Retiring Ada is a ONE-ROW UPDATE**, not a trigger deletion. `feature_registry` already has
  `onboarding_architect` (`default_enabled = true`) and `provision_onboarding_architect` reads it,
  returning `{skipped: flag_off}`. Same reversible mechanism as the starter employees.
- ⚠ **Three things must ship in the SAME step as that flip**, because they only bite at
  retirement: `onboarding-assist/index.ts:57` matches Ada by **literal name** and 409s without her;
  `GettingStartedGuide.tsx:37` excludes her by name and calls her "the hero of step 1";
  `proposeTailoredSetup` (`hireApi.ts:215`) is regex-not-LLM and the interview supersedes it.
- ⚠ **`matchProvider` trades lowercase recall.** "We use Slack" resolves; "we use slack" does not,
  for the 16 providers named after ordinary words. A stop-list plus a case-sensitive exact-label
  pass was the fix for a Critical where *"we close deals on monday and the team meets in front of
  the box"* returned four providers, all labelled `confidence: 'exact'`. **Decide this before the
  interview consumes it.**
- ⚠ **`dreamteam` is in `connectors_provider_check` but deliberately NOT in the catalog** (17 live
  rows use it). Catalog membership would force it into `PROVIDERS`, which the customer-facing
  connector picker renders.
- `request_subtenant`'s self-serve branch still does **not** run full baseline, so those subtenants
  get no starter guardrails, approval limits or onboarding template. Pre-existing; named, left.
- **Test a pure function against the real seeded data, not only its fixture.** Both per-task
  reviews passed the matcher; only the whole-branch review crossed Task 3's algorithm with Task 1's
  data and found the Critical.

### Known red, needing owners (none caused by this programme)

`certify` is NOT CERTIFIED on two sections: `ring0-probes` (2 `no-pending-approval`, 1
`onboarding-bindings`) and `migration-ledger` (**ORPHANED 715/717 — production has applied
migrations whose files the repo no longer holds**, which is the reverse-direction drift and the
more serious of the two). Also open: `tests/tenant-isolation.test.ts` fails in teardown only.
