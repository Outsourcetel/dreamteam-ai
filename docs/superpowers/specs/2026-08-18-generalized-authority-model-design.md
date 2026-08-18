# Generalized authority model — design

**Date:** 2026-08-18
**Origin:** docs/54 item 2, "the generalized authority model"
**Status:** design agreed, not started

---

## 1. The problem, measured

docs/54 states that approval limits are "a category ACL, not a money limiter". That is
true, but the reason is more precise than the write-up implies, and the precision changes
what to build.

Measured on production, 2026-08-18:

| | |
|---|---|
| Human tasks | **466** (406 pending) |
| …carrying a **category** | **466 — 100%** |
| …carrying an **amount** | **3 — 0.6%** |
| Workspaces with active approval authority | **18** |
| Authority rows declaring a money limit | **115** |
| `action_executions` | 187, **0** carrying an amount |
| `de_autonomy` rows with `max_amount_cents` | **0 of 25** |

**Nothing ignores money.** `decide_human_task` calls `task_approval_facts(task_id)`
specifically to obtain `(category, amount_cents)` and passes both to
`has_approval_authority`, which checks both limbs. `decide_action_execution` separately
enforces a `require_approval_over_cents` guardrail *and* additive daily/monthly spend
caps. `run_dunning_sweep` already passes a real `inv.outstanding_cents`.

The category limb binds on 100% of approvals. The money limb binds on 0.6%. **115
declared money limits are correct and unreachable**, because `task_approval_facts` cannot
derive an amount for 99.4% of tasks.

The root cause is one clause:

```sql
if p_amount_cents is null or (v_autonomy.max_amount_cents is not null and ...)
```

**A missing measure passes.** Absence is treated as permission. This is the direct
counter-example to the law docs/54 states: *a limit works only when the path it governs
emits its measure automatically.*

### The second problem: two models

| | Humans | Digital employees |
|---|---|---|
| Storage | `approval_authority` | `de_autonomy` + `guardrail_rules` |
| Vocabulary | category, amount, second-approver-above, org unit | enabled, max_amount, min_confidence, spend caps |
| Evaluated by | `decide_human_task` | `decide_action_execution` |
| Resolution | user → role → org unit (recursive) | specific key → category → generic |

No shared concept of "may this actor do this thing at this size". A person's limit cannot
be expressed for an employee; an employee's spend cap has no human equivalent. Item 17
(escalation *direction* — sideways to skill vs upward to authority) is a third face of the
same gap: "upward to authority" only means something if authority is one ladder.

---

## 2. Decisions taken

Four, on the record, 2026-08-18:

1. **Scope: authority over more than money.** Extend what authority can bind on, rather
   than only repairing the money limb.
2. **Dimensions: all four** — blast radius, reversibility, confidence, time/rate.
3. **Missing measure: FAIL CLOSED.** If a rule needs a measure the path did not emit, the
   action gets a human. Absence is risk, not permission.
4. **Combination: STRICTEST WINS.** Every applicable rule is evaluated; the most cautious
   outcome is taken. No rule can relax another.

(3) and (4) together give the property that makes this safe to adopt: **adding a rule can
only ever tighten.** A customer can write one without auditing the rest.

### Where the dimensions stand today

Not greenfield — the vocabulary exists in three different states:

| Dimension | State |
|---|---|
| Destructive | **Live** — 78 of 187 executions marked; the gate reads it |
| Confidence | **Live** — 20 of 25 autonomy rows set `min_confidence` |
| Discount % | **Decorative** — `max_discount_pct` has zero enforcement readers; `string_agg`'d into a prompt |
| Reversibility | **Declared, never exercised** — `rollback_of` / `rollback_receipt` exist, 0 rollbacks ever |
| Idempotent | **Populated but inert** — 1 of 187 |
| Blast radius | **Does not exist** |

---

## 3. Architecture

### 3.1 The measure envelope

Every governed path describes what it is about to do, in comparable terms:

```
{ amount_cents, subject_count, reversible, confidence }
```

`rate_per_hour` and time-of-day are **not supplied**. They are derived at evaluation from
`now()` and a per-period ledger — the pattern spend caps already prove.

### 3.2 Measures are persisted, not just passed

A `measures jsonb` column on `action_executions` and on `human_tasks`, written by whoever
creates the row.

This is what makes the audit real. Today zero executions carry an amount, so **no past
decision can be re-checked against what was known when it was made.** `task_approval_facts`
stops deriving and becomes a reader of this field.

### 3.3 `authority_rules`

One table replacing the split vocabulary.

| Column | Meaning |
|---|---|
| `tenant_id` | workspace |
| `actor_kind` / `actor_id` | `role` \| `user` \| `org_unit` \| `de` \| `all` |
| `category` | category, or NULL for all |
| `dimension` | `amount_cents` \| `subject_count` \| `reversible` \| `confidence` \| `rate_per_hour` |
| `comparator` / `threshold` | the test |
| `outcome` | `require_human` \| `require_second_approver` \| `deny` |
| `is_active`, `created_by`, timestamps | |

`dimension` is constrained against a **reader registry** (§5).

**Dimensions are typed, and the comparator set follows the type.** Left implicit this
would be an invitation to store `reversible <= 5`:

| Dimension | Type | Comparators |
|---|---|---|
| `amount_cents` | integer | `>` `>=` |
| `subject_count` | integer | `>` `>=` |
| `rate_per_hour` | integer (derived) | `>` `>=` |
| `confidence` | integer 0–100 | `<` `<=` |
| `reversible` | boolean | `is` |

The registry carries the type, and the rule writer validates the comparator against it —
the same shape as mig 758's `source_config` validation, and for the same reason: an
unvalidated combination does not error, it quietly measures the wrong thing.

### 3.4 `evaluate_authority(tenant, actor, category, measures) → jsonb`

The single evaluator both gates call.

1. Collect every applicable rule (actor matches directly, by role, or by org-unit
   ancestry; category matches or is NULL).
2. **A rule whose dimension is absent from `measures` returns `require_human`, reason
   `unmeasured`.**
3. Otherwise evaluate. **Strictest outcome wins:** `deny` > `require_second_approver` >
   `require_human` > `allow`.
4. Return the outcome **plus every rule that fired and why**, so a decision explains itself.

`decide_action_execution` calls it with the employee as actor. `decide_human_task` calls it
with the person. Same function, same measures, same answer.

### 3.5 The rollout property

Fail-closed only bites when an applicable **rule** needs a missing measure. **A workspace
with no authority rules sees no behaviour change at all.** The permissive default that
`has_approval_authority` already implements — no rows declared means allowed — is
preserved. Removing it is how every queue on the platform freezes at once.

---

## 4. Data flow

**An employee acting:**

```
measures = { amount_cents: 45000, subject_count: 1, reversible: true, confidence: 82 }
  → decide_action_execution(...)      existing guardrails + destructive floor, unchanged
  → evaluate_authority(tenant, ('de', de_id), 'erp_financials', measures)
  → allow | require_human | require_second_approver | deny, with reasons
  → the execution row is written WITH its measures
```

**A person approving:**

```
decide_human_task(task_id, 'approved')
  → reads human_tasks.measures        (no derivation)
  → evaluate_authority(tenant, ('user', auth.uid()), category, measures)
  → require_second_approver → first approval recorded, task stays pending (existing behaviour)
```

Rejections remain ungated, as today: declining is the conservative direction, and a rule
that stops someone saying "no" is a way of forcing things through.

---

## 5. Design constraints

Each of these is a failure this codebase has already paid for. They are constraints, not
suggestions.

- **No `is null or` fail-open.** The reason 115 limits bind on 0.6% of approvals. Absence
  is handled once, at the evaluator, and it escalates.
- **One evaluator.** A certify probe asserts exactly one function evaluates authority. Two
  paths measuring separately diverge — mig 755 had to unpick precisely that between
  `list_de_trust_surface` and `decide_action_execution`.
- **Every dimension must be shown to both allow and block.** A dimension that has only
  ever allowed is untested. A gate that cannot fail is theatre.
- **A dimension may not be declarable until a reader exists for it.** Enforced by a CHECK
  against a reader registry. This is what stops the next `max_discount_pct` — a rule type
  that exists, is configurable, and is enforced by asking a model nicely.
- **The evaluator must not be bypassable by `service_role`**, which carries no tenant
  claim. A guard that fails open under service_role is not a guard.
- **Measures are computed by the path, never accepted from a browser.** A measure the
  actor can choose is not a measure. `subject_count` in particular.
- **Old readers are deleted in the same migration that translates their rows** — never
  left running alongside.

---

## 6. Migration of existing rows

Nothing is rebuilt; rows are translated.

| Today | Becomes |
|---|---|
| `approval_authority.max_amount_cents` (115 rows) | actor = role/user/org-unit, dim `amount_cents`, outcome `require_human` |
| `.second_approver_above_cents` | second rule, outcome `require_second_approver` |
| `de_autonomy.max_amount_cents` | same shape, actor = `de` |
| `guardrail_rules.require_approval_over_cents` | same shape, actor = `all` |
| spend caps (`spend_cap_daily_cents`, `spend_cap_monthly_cents`) | **stay as they are.** They own a working ledger. They become `rate` rules later, deliberately, not as part of this cutover. |

---

## 7. Verification

- **Differential before removal.** For every one of the 151 authority rows and 25 autonomy
  rows, old decision == new decision on the same inputs — **with the comparison count and
  the count of non-trivial evaluations reported**, because zero differences from zero
  comparisons looks identical to a clean result.
- **Inversion per dimension.** Each of the five demonstrated allowing *and* blocking.
- **Fail-closed proof.** A rule needing a measure the path does not emit returns
  `require_human`, reason `unmeasured`.
- **Every migration dry-run** in an always-aborting transaction before any apply, with the
  builder refusing to emit if a `commit;` survives.
- **Probes added to certify:** exactly one authority evaluator; no `authority_rules` row
  references a dimension with no registered reader.

---

## 8. Sequencing

Multi-session. Each step lands and is verified before the next begins.

1. **The evaluator and `authority_rules`, inert.** Nothing calls it. Fully tested in
   isolation, including fail-closed and strictest-wins.
2. **Cut over `decide_human_task`.** Translate the 151 `approval_authority` rows, prove the
   differential, delete the old reader in the same migration.
3. **Cut over `decide_action_execution`.** Same pattern for `de_autonomy` and the
   `require_approval_over_cents` guardrail.
4. **Dimensions, one at a time.** For each: the reader first, then the registry entry, then
   the paths that emit it, then the rule type becomes declarable. `subject_count` first —
   it is the one that prevents an incident rather than a mistake.

**The first implementation plan covers STEP 1 ONLY** — the evaluator and `authority_rules`,
inert, with nothing calling them. Steps 2–4 each get their own plan, written after the
preceding step has landed and been verified. A single plan spanning all four would be
guessing at the shape of step 3 before step 2 has been measured, which is how the
`de_kpi_status_internal` extraction produced a shadowed parameter that a plausible-looking
probe then failed to catch.

---

## 9. Out of scope

- **Unifying storage.** Humans and employees keep their own tables; only *judgement* is
  shared. Unified storage was considered and deliberately not chosen.
- **Delegation, expiry, out-of-office.** Real gaps — a queue stalls on one person's absence
  — but a separate design.
- **Escalation direction (docs/54 item 17).** This design is its prerequisite: "escalate
  upward to authority" needs one authority ladder to be meaningful. It should be designed
  after step 2, not folded in here.
- **`max_discount_pct`.** It stays decorative until someone builds a reader. This design
  makes that explicit rather than fixing it in passing.
