# 45 — Certification scoreboard

**A living ledger, not a report.** Every row is an invariant with a probe that
re-runs on demand. A report is a photograph and rots (the DR doc said "no
backups" for weeks after backups existed); this re-derives its verdict from the
live system every time `npm run certify` runs.

- **Baseline:** tag `review-baseline-20260809` @ `bc86388`, census in
  `supabase/baseline/review-baseline.json`. Diff against it to see what moved.
- **Run:** `npm run certify` (full, ~3 min) · `npm run certify:fast` (~60 s) ·
  `npm run certify:mutation` (proves the probes can fail).
- **Re-pin, deliberately only:** `--pin-allowlist` after an intended perimeter
  change · `--pin-edge` after fixing edge-function type errors, to lock the gain
  in. Both ratchets move one way; re-pinning after an *accidental* change
  blesses it.
- **Status vocabulary:** **PROVEN** — a probe asserts it and the probe is
  mutation-tested to fail when violated. **UNPROVEN** — believed, no standing
  probe yet. **FALSIFIED** — a probe found it broken (fix in flight).

Effort follows blast radius: **Ring 0** (must never happen) → **Ring 1** (costs
money/reputation) → **Ring 2** (costs correctness) → **Ring 3** (polish).

---

## Ring 0 — must never happen

| # | Invariant | Status | Probe |
|---|---|---|---|
| R0.1 | Every `public` table has RLS enabled | **PROVEN** | `certify` › rls-on-every-public-table |
| R0.2 | No cross-tenant WRITE reachable by a client role | **PROVEN (fixed today)** | `knowledge-acl-invariants` + perimeter allowlist |
| R0.3 | Nothing that speaks in public is auto-executable (destructive floor) | **PROVEN** | `certify` › no-unattended-public-speech |
| R0.4 | Money moves only through `amount_cents` (else every money gate disarms) | **PROVEN** | `certify` › money-param-is-amount_cents |
| R0.5 | The approvals guard (`app.allow_task_decision`) has no new setter | **PROVEN** | `certify` › guard-bypass-setters-pinned |
| R0.6 | The audit hash-chain is intact for outsourcetel-hq | **PROVEN** | `certify` › audit-chain-verifies-hq |
| R0.7 | The `anon`/`authenticated` EXECUTE surface equals the pinned allowlist | **PROVEN** | `certify` › execute-perimeter |
| R0.8 | Tenant isolation on READ, probed with real ids across all RPCs | **FALSIFIED — every found instance closed; class NARROWED, residue named** | migs 662 (27 revoked) + 663 (`can_access_de`, read *and* write) + 664 (4 more); `certify` › secdef-caller-tenant-ratchet. Residue: 28 fail-open-on-NULL guards, reachable today only by a tenantless account |
| R0.9 | No employee is offered an action its role may not use | **PROVEN** | `certify` › role-restricted-actions-stay-restricted |
| R0.10 | …and the role that *may* use them can actually reach them | **PROVEN** | `certify` › workspace-admin-has-an-owner |

## Ring 1 — costs money or reputation

| # | Invariant | Status | Probe |
|---|---|---|---|
| R1.1 | Every active template action is actually bound (approve → something runs) | **PROVEN** | `certify` › active-template-actions-are-bound |
| R1.2 | No template ships a silent-success op (search w/o query, list w/ query, get w/o ref, frozen date, stale test_op) | **PROVEN** | `certify` › template-op-contract-classes |
| R1.3 | The two shared contracts (browser/edge) never drift | **PROVEN** | `contract-parity` |
| R1.4 | No writer reports failure inside an HTTP 200 unchecked | **PARTIAL** | TikTok `success_when` proven; general sweep owed |
| R1.5 | No NEW unpinned-`search_path` SECURITY DEFINER function (9 legacy accepted) | **PROVEN (ratchet)** | `certify` › secdef-search-path-ratchet |
| R1.6 | Schema backup rebuilds production exactly | **PROVEN** | `npm run restore:drill` |
| R1.7 | **Data** restore loads back and the app works | **UNPROVEN** | owed — never drilled |
| R1.8 | Supabase managed physical restore works | **UNPROVEN** | cannot drill without a 2nd project (founder call) |
| R1.9 | Migrations replay from zero on an empty DB | **PARTIAL** | baseline rebuilds FK chain; full 656-replay not proven |

## Ring 2 — costs correctness

| # | Invariant | Status | Probe |
|---|---|---|---|
| R2.1 | Migration ledger matches the repo (no DRIFTED/ORPHANED) | **PROVEN** | `certify` › migration-ledger |
| R2.2 | Role-gated UI: every control's gate matches its RPC+RLS | **PROVEN** | `npm run audit:role-gates` |
| R2.3 | No silent `{ok:false}`/HTTP-200 refusal dropped at a call site | **PROVEN** | `npm run audit:silent-refusals` |
| R2.4 | Design system: no token/drift regression | **PROVEN** | `scripts/design-drift.mjs` |
| R2.7 | Every edge function type-checks, and can only improve | **PROVEN (ratchet)** | `certify` › edge-typecheck |
| R2.8 | A new onboarding project opens exactly one grounded case | **PROVEN (live)** | run below — 3 ticks gave 1, 0, 0 |
| R2.5 | The core loop closes end-to-end (hire→…→trust) | **PROVEN** | `npm run golden-path`, 10/10 — inside `certify` |
| R2.6 | Dev can actually run the product (no silent drift) | **PROVEN** | `npm run dev:sync:check` + golden-path in `certify` |

---

## The Golden Path, and what it found on its first run

`npm run golden-path` is the product as an **executable trace**: signup → hire →
equip → intake → escalate → **human decides** → gate → evidence → trust. Every
step asserts an *observable consequence*, not a return code. It runs against dev
through the real public signup path — never a forged `auth.users` row.

**RESOLVED 2026-08-09 — the loop now closes, 10/10, and is wired into
`certify`.** The two verdicts that matter come back right: a destructive action
for an untrusted employee resolves `human_gated_destructive`, and a *safe*
action does **not** hit the destructive floor (`human_gated_trust`). A gate that
refuses everything is as broken as one that permits everything; both halves are
proven, on a live database, through the real public signup path.

The rest of this section is kept as the record of what was wrong, because the
*shape* of it recurs.

**Original result: 2 of 10 steps proven. 8 CANNOT BE PROVEN — not because the
product was broken, but because the dev project could not run the product.**

| | dev | production | gap |
|---|---|---|---|
| routines | 779 | 881 | **−102** |
| tables | 266 | 284 | **−18** |
| policies | 350 | 387 | **−37** |
| **migration ledger rows** | **0** | 657 | **dev tracks nothing** |

Concretely, dev cannot:

- **Hire.** `role_archetypes` is **empty**. The product's first step is
  impossible there, so nothing downstream can run.
- **Escalate.** `open_de_escalation` **does not exist** — the human seam, which
  is the entire product thesis, cannot be exercised.
- **Prove the guardrail.** Dev carries **two** overloads of
  `decide_action_execution` (a 4-arg legacy and a 7-arg), production has one
  8-arg version *with `p_content`* — the parameter the guardrail scan reads. The
  duplicate-overload trap that caused a cron outage in migration 562 is sitting
  in the test environment right now.

**Why this matters more than any single bug.** There is currently **no
environment anywhere in which the core loop can be verified before it reaches
customers.** The behavioural tests that pass are running against a system 102
routines behind production, and dev has *no ledger*, so the drift is invisible
and unbounded — nothing would ever have reported it. `certify` is green because
its Ring-0 probes read production directly; the *write paths* have no
pre-production proof at all.

### How it was closed — and four things an "idempotent" schema file cannot do

`npm run dev:sync` converges dev on production **non-destructively** (dev's 185
users and 190 test tenants survive; `full_schema.sql` explicitly cannot restore
accounts, so a drop-and-rebuild would have destroyed them permanently).

The file *is* genuinely idempotent — 284 `CREATE TABLE IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS` before every create, FKs
wrapped in `duplicate_object`-swallowing `DO` blocks — and it **still could not
converge dev on its own**. Worth remembering, because the instinct is to trust it:

1. **Columns on tables that already exist.** 70 missing across 16 tables,
   including `human_tasks.disposition` and 19 columns of `profiles`.
2. **CHECK constraints on tables that already exist.** Dev still enforced the
   pre-574 category list and *rejected every ads/social template*. A stale CHECK
   is worse than a missing column — it actively refuses rows that are valid
   upstream. Re-added `NOT VALID` so historical test data doesn't block the rule.
3. **Constraints production has RETIRED.** The file can create and replace; it
   can never *remove*. 24 dropped, including the one above.
4. **Return-type changes.** `CREATE OR REPLACE` cannot widen a `RETURNS TABLE`.

And the sync itself briefly **recreated the migration-562 trap**: applying
production's definitions over older dev copies with *different argument lists*
left both, so `decide_action_execution` had three overloads and every call
failed `42725 is not unique`. **A sync that adds without removing manufactures
ambiguity.**

Dev now carries a migration ledger (657 rows) and `migrate:status --dev` reports
zero drift. The golden path runs inside `certify`, so if dev falls behind again
the loop stops closing and the bar goes red — which is how this should have been
caught the first time.

## Onboarding, run for real — and the thing it revealed

**2026-08-09.** A project was created in `outsourcetel-hq` through the real
`create_onboarding_project` RPC (never a raw INSERT — provisioning tested by raw
insert proves nothing about the path a customer travels). Then the watcher tick
was run three times.

| | |
|---|---|
| Ticks | **1 case, then 0, then 0** |
| Case | assigned to Onboarding DE, due in 3 days, `entity_kind=onboarding_project` |
| Cases for that project | **1** |
| `action_executions` | **186, unchanged** — nothing executed |
| Approved-action driver | still inert, 0 due |

The case arrived **grounded**, which is the part that used to be impossible —
rendered by the shipped helpers against the real row:

> Onboarding project record on file — Palmer Productions Ltd. — SaaS onboarding:
> … **target golive 2026-09-15 (in 37 days)**, progress pct 0, items state
> [key kickoff_call, status pending | key data_export_received, status pending |
> … | key go_live, status pending].

All ten checklist steps, by name and state, plus the go-live date carrying its
distance from today (computed in code, never left to the model).

Then `de-work-run-5min` picked it up unaided and compiled the published
procedure into five work items: *assess where onboarding stands · find who to
chase · record the status · prepare the status update · hand it to a person.*

### ⚠ The machinery is right and the job is wrong

Those five steps are **assess, chase, report**. Not one of them configures
anything in a customer's system. The `onboarding` archetype describes a
**customer-success coordinator**, not the implementation agent the product
thesis needs — the employee that logs into the customer's product and sets it
up. The plumbing is now proven; it is compiling the wrong procedure.

Rewriting that archetype is the next real piece of work, and no amount of
further wiring substitutes for it.

## The spine — is there a product?

| Metric | Value | Note |
|---|---|---|
| **Approve-clean rate** | **UNMEASURABLE — n=1, needs 20** | `npm run benchmark`. Two reasons, neither "the metric is broken" — see below. |
| Escalation (30d) | 151 escalated / 149 resolved | `activity_events`; ~50% — the dominant *cost*, and the real efficiency metric |
| Completion (30d) | 641 created / 22 decided | the completion gap, unchanged |

### Why the spine number is still unknown — and it is not the metric's fault

**1. No draft has ever been decided.** Of 32 decided `human_tasks`, **20 were
`action_approval`** — a yes/no gate on an action, which has *no text to edit*.
Counting those as "approved clean" would inflate the rate with decisions that
contained no draft at all, which is the easiest way to make this number lie. The
harness therefore counts only draft-shaped work — and **62 of those
(58 `inquiry_review` + 4 `knowledge_revision`) are sitting PENDING**.

> The rate is not broken. It is **unsampled**. Decide ~20 drafts and it appears.

**2. The support path destroys its own denominator.** `approve_draft_reply`
overwrites `de_messages.delivery` from `draft_pending` to `sent`, so a message
that *was* a draft is indistinguishable from one that never was. 905 sent, zero
recoverable as approved-untouched; only the **2 edits** survive in
`de_learning_edits`. A metric whose numerator is recorded and whose denominator
is erased can only ever look bad, and cannot be trusted in either direction.
**Fix is a product change** — stop erasing the fact that a draft existed —
deliberately flagged rather than quietly patched.

**Two rules the harness will not break.** It measures the *work*, never an exam
(a metric that scores the test instead of the job always closes its own loop and
always looks good — this codebase has been bitten by exactly that). And it
**refuses to publish a rate below n=20**: three samples is not 67%, it is noise
wearing a percentage sign, and a number in a slide deck outlives every caveat
attached to it.

Samples accumulate in `benchmark_samples` (migration 637), one row per run, so
the curve survives changes to the underlying tables. A curve you can recompute
retroactively is a curve you can talk yourself into. `npm run benchmark:history`.

---

## What today's Ring-0 pass already found and fixed

- **Six cross-tenant write holes** (mig 636). `upsert_external_ticket/contact/
  opportunity/ar_record`, `resolve_external_account`, `install_role_watchers` —
  all SECURITY DEFINER, all `authenticated`-executable, all taking the target
  tenant as a *parameter*. Any signed-up user could write into any workspace.
  Same class as mig 610; created in 607/608 and missed. Revoked; ingest
  (service-role) unaffected. **This is the review paying for itself on day one.**
- **A drifted + an orphaned migration** — the 580↔581 collision left the ledger
  inconsistent and a restored-then-re-deleted file orphaned. Reconciled.
- **22 employees across 12 workspaces could hire staff** (mig 643). Marketing,
  Accounting, Business Development and Technical Support were all handed
  `create_digital_employee` and `hire_from_archetype`, because tools are scoped
  by **connector**, never by **role**. This is a permission bug, not a cluttered
  menu: `decide_action_execution` gates destructive/trust/budget but never asks
  *whether this employee may do this*, so **the offer list IS the authorisation
  boundary**. Restricting alone would have been worse than the hole — 11 of 12
  workspaces would have been left administrable by *nobody*, since only one
  Workspace Assistant had the grant. Both halves shipped, both probed.
- **6 approvals nobody carried out** (mig 642), expired append-only before a
  scheduled executor could fire month-old decisions. I first reported **16** —
  the linkage column `resolves_task_id` was unpopulated before August, so
  completed work read as pending. Settled by evidence *outside* the ledger: the
  employees those approvals would have created already existed, created on the
  exact approval dates.
- **27 cross-tenant READ holes** (mig 662) — R0.8, the last Ring-0 invariant
  still `UNPROVEN`, is **falsified**. The narrowing: 629 routines reachable by
  `authenticated` → 464 `SECURITY DEFINER` (RLS does not apply to them) → 364
  taking a uuid from the caller → **69 that never derive the caller's own
  tenant**. All 69 bodies were read: 41 safe, 1 unresolved, 27 leaking. Twelve
  went to independent reviewers briefed to *refute*; **all twelve refutations
  failed**, several reporting the finding understated. Any signed-in user of any
  workspace could read another's published SOP text (`get_de_briefing`), its
  open invoices with customer names and amounts (`dunning_position`), its whole
  org chart (`list_org_tree_core`), who may approve what
  (`has_approval_authority`) — and `link_agreements_to_accounts` was a
  cross-tenant **write**. Always the same mechanism: the tenant id arrives as a
  parameter and is never compared to the caller's, so **the parameter IS the
  authorisation**.
  The fix cost nothing because every call site of all 28 is `admin.rpc`
  (service_role) or another `SECURITY DEFINER` routine — *not one* is called
  from the browser. The grant was the Supabase default nobody revoked. The one
  exception, `list_consultable_for_de`, is genuinely called by the Employee File
  page and got the `can_access_de` guard instead, raising rather than returning
  an empty list. Safe to revoke only because **nothing evaluates these as the
  caller** — checked via `pg_depend`, not grep, with `auth_tenant_id` as a
  negative control (it correctly reported 292 dependent policies).
  Perimeter 629 → **602**, exactly the 27, nothing else moved.
  ⚠ **The sieve was crude.** A body that mentions `auth.uid()` only for logging,
  or one keyed on a tenant *slug* rather than a uuid, would have been missed.
  This closes what was found; it does not prove the class empty. The ratchet is
  what stops it growing back.

  ### ⚠⚠⚠ …and the adversarial pass on 662 proved that warning right

  An independent pass was run against the migration itself: four agents attacking
  the sentence that justified the revoke, four hunting the classes the sieve
  could not see. **No breakage was found** — 61 edge clients enumerated, all 18
  calls to the 27 traced to a service_role binding through their parameters; 0
  RLS/view/index/trigger/default dependents; 0 SECURITY INVOKER callers out of
  37 caller pairs; 0 browser paths. It was proven *live* rather than inferred:
  under `set role authenticated` a revoked routine now returns
  `ERROR 42501 permission denied`, while a `SECURITY DEFINER` wrapper still calls
  that same revoked routine successfully. Both clauses of the justification hold.

  But three findings land **against work done in this same pass**, and they
  matter more than the 27:

  - **`can_access_de` is not tenant-sufficient — and 662 leaned on it.** Its
    third disjunct, `auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin',
    'tenant_manager'])`, **never references `p_de_id` and compares no
    `tenant_id`**. So any owner/admin/manager passes the check for a digital
    employee in *any other workspace*. Verified directly: 17 privileged
    non-platform profiles, **1,758 (user, foreign-tenant DE) pairs** admitted,
    one profile per user so the branch is genuinely crossing a boundary.
    It stands in front of **72** authenticated-reachable functions; 45 also pin
    `auth_tenant_id` and 11 are platform-admin gated, but **16 rely on it
    alone** — and those include *write* verbs: `approve_learned_behavior`,
    `reject_learned_behavior`, `apply_improvement`, `send_human_reply`,
    `claim_support_conversation`, `set_support_conversation_state`,
    `enqueue_de_work_item`, `handoff_back_to_de`, `request_trust_promotion`.
    Inherited, not introduced — before 662 `list_consultable_for_de` had no
    guard at all — but **it is the exact branch this migration's safety rests
    on**, so the guard half of 662 is incomplete.
  - **3 of the 41 "read and cleared" are not clear.** `submit_csat`,
    `validate_watcher_config` and `platform_capability_remaining_holders` carry
    no caller derivation and are reachable by `authenticated`. They are in the
    ratchet's exemption list, which means **the gate is currently exempting three
    real violations**. An allowlist is a claim, and this one was partly wrong.
  - **The "mentions a guard but is not guarded by it" class is real.**
    `get_workforce_trust_metrics` (HIGH — another tenant's whole governance
    posture), `get_identity_inventory`, `get_de_cost_metrics`,
    `assign_human_task` all *contain* a guard helper, which is precisely why the
    sieve excluded them. Two claims from the sweep died under refutation
    (`list_platform_shelf`, `get_de_guardrail_activity`) — a review's errors are
    evidence about the review.

  Also surfaced, outside R0.8's read scope: the `eval_gate` **view** is
  `anon`-readable and spans 3 tenants, and `net.http_post/get/delete` are
  `anon`-executable (an outbound-request primitive from inside the database).

  **R0.8 therefore reverts to open.** 27 instances are closed and gated; the
  *class* is not. Saying otherwise would be the "gate that cannot fail" failure
  in prose form.

  ### Then migs 663 and 664 closed the root cause — and the residue is named

  **663 — the ticket you could write yourself.** `can_access_de`'s privileged
  branch never named the employee, so any owner/admin/manager passed for an
  employee in any workspace. Pinning that branch *alone would have changed
  nothing*: branch 4 trusts `de_assignments`, `authenticated` holds INSERT on
  that table, and its write policy checked the row's own tenant and the caller's
  role but never the **employee's** tenant — no correlating constraint, no
  trigger. Any of the 16 privileged users could issue themselves a ticket naming
  a foreign employee. The RPC `set_de_assignment` already carried the exact
  missing check, commented *"closed at the point of write, not left to the
  reader"* — the RPC closed it, the table did not, and branch 4 reads the table.
  663 fixes the read **and** the write. Replayed on live rows before applying:
  **2,229 → 354** admitted pairs, **1,875 cross-tenant closed, 0 own-tenant
  lost, 0 gained**, platform staff and ordinary members unchanged.
  Remote access cannot break: `resolve_remote_access_tenant` requires
  `layer='platform'`, which is exactly `is_platform_admin()` one disjunct
  *earlier* — remote access never used the branch that changed.
  ⚠ Exactly one account loses access: a `tenant_owner` whose workspace was
  **deleted**. `profiles.tenant_id` is `ON DELETE SET NULL`, so **every future
  workspace deletion manufactures another active owner belonging to nowhere**,
  and until 663 each one reached the entire estate.

  **664 — a guard that skips is not a guard.** Revoked `submit_csat` (a
  cross-tenant *write* onto a performance metric; safe because 0 of 455
  conversations have ever carried a score and `anon` never held it) and
  `platform_capability_remaining_holders`. Added a membership guard to
  `get_workforce_trust_metrics` — membership only, no role gate, because
  ordinary members read that panel today. Made `assign_human_task` refuse
  instead of skip.
  ⚠ `validate_watcher_config` looks identical to the two revoked and **must not
  be revoked**: `trg_validate_work_watcher` → `validate_work_watcher` is
  SECURITY INVOKER, so the admin doing the INSERT needs EXECUTE. `pg_depend`
  does not show this — the dependency is one hop deeper than a direct
  reference. It stays exempt, now with that reason written beside it.

  #### ⚠ What is still open, stated plainly

  - **28 functions guard with `if auth_tenant_id() is not null and …`**, which
    *skips* the check rather than failing it. Three siblings use the correct
    idiom (naming `service_role` explicitly). None is `anon`-reachable, so today
    the only caller who benefits is the tenantless account above — which makes
    **deactivating that profile the cheapest mitigation**, and fixing the 28 the
    durable one. `resolve_action_execution_for_task` is the same seam spelled
    differently: `x NOT IN (subquery)` yields NULL, not TRUE, when the subquery
    returns a NULL.
  - ~~**`eval_gate`** is a view readable by `anon`~~ — **CLOSED, mig 665.** It
    was not theoretical: fetched from the open internet with nothing but the
    public anon key, it returned three tenants' UUIDs and their exam records
    (`passed 16/16`, `failed 0/2`, `failed 19/20`). **A view is a SECURITY
    DEFINER function in table clothing** — it runs as its OWNER unless
    `security_invoker = true`, and this one is owned by a BYPASSRLS role, so the
    policy `eval_runs_tenant_read USING (tenant_id = auth_tenant_id())` was
    never *consulted*. Proof that only the view leaked: anon fetching the base
    table gets `42501 permission denied for function auth_tenant_id`, because
    there the policy does fire. Two sibling views already set the flag; this was
    the only one that did not, and across every view in `public` owned by a
    BYPASSRLS role reading an RLS table, it was **the only offender**. After the
    fix, the same anon request returns `permission denied for view eval_gate`.
  - **`net.http_post` — latent, and NOT fixable by us.** Every `net` function
    and both its tables are granted to PUBLIC (the queue *is* the pipe: the
    worker sends whatever is written to it). But schema `net` is not exposed
    through PostgREST — probed, not assumed: `Accept-Profile: net` → **406**.
    ⚠ **A `REVOKE` cannot fix this**: `net` is owned by `supabase_admin` and a
    revoke running as `postgres` is a **silent no-op** — I proved that in a
    rolled-back transaction where the privilege was still present *after* the
    revoke, with no error raised. (My first reading of that test was wrong: I
    took "no error" for "it worked". A no-op revoke does not error.)
    So the only thing between PUBLIC's grant and a live SSRF primitive is a
    **project-config setting with no representation in the database** — which
    means no SQL probe can ever see it. `certify` › **`net-not-exposed`** now
    asks the REST API directly, as the anonymous internet, and goes red the day
    that config changes. It has no separate control request *on purpose*: the
    first version used a public view as its control, mig 665 revoked anon's
    access to that view, and the probe silently disarmed itself. The status code
    is the evidence — 406 closed, 200 exposed, anything else skips **loudly**.
  - **`get_de_cost_metrics`** shows per-employee spend for every employee in the
    caller's own workspace rather than only those they are responsible for.
    Intra-tenant over-sharing, not a tenancy breach — and narrowing it changes
    what people see, so it is a product call.
  - **Dev is not a mirror.** It flags 15 routines in the leaky shape that
    production closed long ago, while its `schema_migrations` *claims* the
    migration that closed them is applied. Dev cannot currently be trusted to
    rehearse a security change.

Every probe above is **mutation-tested** (`certify:mutation`): each was shown to
return rows when its violation is injected and none when it is not. A gate that
cannot fail is theater, and this codebase has shipped that before.
