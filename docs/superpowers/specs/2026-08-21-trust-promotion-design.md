# Trust Promotion — how a digital employee earns a looser limit

**Status:** design, approved 2026-08-21. Not built.
**Founder decisions:** four, recorded verbatim in §2.
**Depends on:** the generalized authority model (`2026-08-18-generalized-authority-model-design.md`), which is mid-cutover — see §7.

---

## 1. The problem, measured

Ninety trust policies existed on 2026-08-18. Sixty-six exist today. **Not one has ever
been above level 0**, and level 0 is the level at which the ladder grants nothing.

That is not a dormant feature. It is a closed loop:

> no autonomy → every action escalates → the review queue grows → nobody reviews →
> the evidence promotion requires never accrues → no autonomy

Measured 2026-08-21 on production:

| | |
|---|---|
| trust policies | 66 |
| policies above level 0 | **0** |
| policies **eligible right now** | **3** |
| promotions ever granted | **0** |
| reviews awaiting a decision, one workspace | **208** |
| actions executed, last 7 days | 2 |
| conversations, last 7 days | **0** |

The evidence function already says so in its own words. Asked why a policy needing three
human samples does not qualify:

> `0 decided review(s) + 0 corroborated refusal(s) (needs 3) — 208 awaiting a decision`

The employees have done the work. Nobody has decided on it. Migration 815 added
`pending_reviews` to the evidence payload for exactly this reason — its comment reads
*"the difference between 'this employee has shown nothing' and 'nobody has looked at what
it showed'"*.

### 1.1 What already exists, and works

This design **extends** machinery rather than replacing it. Do not rebuild:

- `trust_evidence_for(trust_policies)` reads `criteria` **per policy**, so per-DE variation
  is already structural: `window_days`, `min_eval_samples`, `min_eval_pass_rate`,
  `min_human_samples`, `min_human_approval_rate`, `max_guardrail_blocks`. All 66 policies
  carry criteria, and the bars already differ — 27 policies need 25 eval samples, 37 need
  none.
- Migration 819 counts **corroborated refusals** — an employee correctly declining
  something, verified by the system. The concept of corroboration exists; only the
  positive half is missing.
- `apply_trust_promotion` grants a step: evidence, a human task, a non-self approver.
- `detect_trust_widening_patterns` → `raise_trust_widening_proposals` →
  `de_governance_sweep_internal` → cron `de-governance-sweep-daily` (`45 6 * * *`) already
  looks for eligible policies daily.

### 1.2 The three defects that stop it working

Found while measuring, not inferred. Each must be fixed for any of this to function.

1. **Eligibility never becomes a request, because the proposal path asks for something
   stronger than the eligibility bar.** ⚠ **CORRECTED 2026-08-21, after this spec was
   first written and before any code was planned against it. The original claim here —
   "one open request freezes a whole group" — was WRONG, and the correction matters
   because it changes what gets built.**

   What I asserted: `detect_trust_widening_patterns` excludes a group when any proposal in
   it is open, so one unanswered promotion suppresses the rest.

   What is true: that clause is scoped `tenant_id + de_id + action_category`, and the
   eligible policies are on **different employees** — so it cannot be what silences them.
   Verified by reading the clause and comparing `de_id`s.

   The real cause. Eligibility and proposability are two different tests and nothing
   bridges them:

   - `trust_evidence_for` says eligible when the **criteria** are met. Two policies
     qualify today precisely because their criteria need `min_human_samples: 0`.
   - `detect_trust_widening_patterns` proposes only where there is a **pattern of approved,
     landed, un-rolled-back actions** to point at — it groups by
     `(tenant, de, action_definition)` over that history.

   With 2 actions executed in the last 7 days and 208 reviews undecided, no such history
   exists. Measured: `detect_trust_widening_patterns('5bb802e1-…')` returns **0
   candidates** while 2 policies report `eligible: true`.

   So a policy can be eligible forever and never be asked about. The detector is not
   broken — it answers "has this employee repeatedly done this and been approved?", which
   is a fine question and a *different* one from "does this employee meet its bar?".
   `request_trust_promotion` exists and takes the direct path, but nothing calls it on
   eligibility.

   **What this changes in the build:** the task is not to relax a blocking clause. It is
   to give eligibility its own route to a request — and to decide deliberately whether an
   eligible-but-patternless policy should raise one, which is a founder question the
   original framing hid.
2. **The not-your-own-request safeguard is vacuous on the automatic path.**
   `apply_trust_promotion` guards with `if v_policy.requested_by is not null and
   auth.uid() = v_policy.requested_by`. `raise_trust_widening_proposals` sets
   `requested_by = NULL`, so the guard short-circuits and any approver qualifies.
   Confirmed: all three eligible policies read `requested_by IS NULL`.
3. **`action_execute` has no gradation.** `trust_level_settings` returns, for that
   category, `enabled: true, max_amount_cents: null, min_confidence: null` at **every**
   level. Levels 1, 2 and 3 are identical and unlimited. All three currently-eligible
   policies are `action_execute`, so approving that first step would not loosen a limit —
   it would remove it. `trust_policies.ladder` is the per-policy override for this and is
   NULL on all 66.

---

## 2. Founder decisions

Recorded verbatim, 2026-08-21. These are settled and are not to be re-litigated.

| # | Question | Decision |
|---|---|---|
| 1 | What counts as proof an employee earned a looser limit? | **Human approvals OR system-corroborated correctness** |
| 2 | Where do an employee's corroboration signals come from? | **The role archetype declares them** |
| 3 | Does autonomy increase without a person saying yes? | **Never — a human always approves the step** |
| 4 | Where does the ladder — what each step grants — come from? | **The archetype declares it, same as the evidence** |

Standing constraints this design inherits:

- **Never hardcode a department.** The platform must not branch on Billing vs Support.
  Roles declare; the platform reads.
- **Authority decisions belong to the founder**, not to an agent and not to a model.
- **A gate that cannot fail is theatre.** Every threshold must be demonstrated both
  allowing and blocking.

---

## 3. Architecture

### 3.1 The role archetype is the single place a role's trust is defined

`role_archetypes` already carries `autonomy_templates`, which
`instantiate_role_archetype_internal` reads at hire to write `de_autonomy` rows. Two
declarations join it:

- **`trust_signals`** — what the system can check without a human clicking, per action
  category. A Billing role might declare that an invoice reconciled against the ledger; a
  Support role that a conversation closed with no complaint and no reversal.
- **`trust_ladder`** — what each step grants, per action category. Billing might read
  £500 → £2,000 → £10,000. Support might read confidence 90 → 80 → 70.

Both are inherited at hire, alongside the dials, by the writer that already runs there.

**A role that declares no ladder cannot be promoted.** That is the fix for defect 3: the
unlimited default stops being reachable because promotion requires a declared ladder, not
because a central default was patched. A role must say what a step means before an
employee in it can take one.

### 3.2 Evidence accrues two ways

`trust_evidence_for` gains a second positive source beside decided human reviews:
**corroborated correctness**, counted from the signals the archetype declared, over the
same `window_days`, feeding the same `min_human_samples` / `min_human_approval_rate`
counters that exist today.

This is deliberately symmetric with migration 819's corroborated *refusals*. A refusal the
system can verify already counts; a success the system can verify now counts too.

The criteria JSON, the thresholds, the evidence card and the eligibility calculation are
otherwise unchanged.

> ⚠ **Read this before implementing: machine evidence satisfies a counter named "human".**
> Verified in the shipped function — `v_h_corrob` is summed into the human sample count
> today, so a policy requiring `min_human_samples: 3` can already be satisfied with zero
> human decisions, by corroborated refusals alone. This design widens that, it does not
> introduce it.
>
> Two consequences, both deliberate, both easy to implement wrongly:
>
> 1. **The counter's name is now misleading and must not be trusted as documentation.**
>    It counts *reviewed-or-corroborated* evidence. Do not add a second machine-only
>    counter beside it — two counters measuring one thing is how this repo has produced
>    divergence before. Correct the label where it surfaces to a customer instead.
> 2. **This does not weaken decision 3.** A human still approves every *step*. What
>    corroboration removes is the requirement that a human individually decide each piece
>    of *evidence* before the step can be requested. The person still says yes to the
>    promotion; they no longer have to say yes to 208 reviews first.
>
> If that trade is wrong, the fix is a separate `min_decided_by_human` floor in `criteria`
> — an explicit "at least N of these must be a person" — not a redefinition of the
> existing counter. That option is named here and deliberately NOT taken, because the
> founder's ruling was OR, not AND.

### 3.3 A human grants every step

Unchanged from today, and re-stated because it is the point: eligibility raises a request
carrying its evidence; a person approves it. `apply_trust_promotion` remains the only
writer of `current_level`.

What changes is that the request **arrives** (defect 1), the approver bar **means
something** (defect 2), and the evidence is **on the card** rather than inside a function
nobody surfaces.

---

## 4. What varies per DE, and what does not

| Varies, declared by the archetype | Fixed, platform-wide |
|---|---|
| Which signals corroborate correctness | That corroboration counts at all |
| What each step grants | That a human approves every step |
| The ceiling (`max_level`, hard-capped at 3) | That absence of a declared ladder blocks promotion |
| Thresholds, via existing per-policy `criteria` | The shape of the evidence payload |

Two employees in the same role share a definition. That is the intent: the role is the
unit a customer reasons about when hiring.

---

## 5. Verification

The bar this repo holds, applied here:

- **Every threshold demonstrated both ways.** For each declared signal, one case that
  corroborates and one that does not. A signal that has only ever passed is untested.
- **Drive the promotion, do not read it.** Three migrations shipped `withdraw_human_task`
  green while it raised on every call, because every assertion read `pg_get_functiondef`
  and matched text. Promote a real policy in an aborting transaction and read the level back.
- **Replay the three eligible policies.** After the group-blocking fix, all three must
  raise a request. Today two are silent — that is the control.
- **Prove the approver bar fires.** Set `requested_by`, attempt self-approval, watch it
  refuse. Today it cannot refuse anything.
- **Count the comparisons.** Every probe states its denominator.

---

## 6. Out of scope

- **Demotion.** `trust_demote` exists and is untouched here.
- **The 208 undecided reviews.** Corroboration relieves the dependency on human decisions;
  it does not clear the backlog. Migration 778 made that queue legible and de-duplicating;
  clearing it is separate work.
- **Widening the reason-code vocabulary** (settled separately in migration 799).
- **The authority evaluator cutover** — see §7.

---

## 7. Interaction with the authority model, and the risk in it

`evaluate_authority` (migrations 768–772, 783) is now called by `decide_action_execution`
and `decide_human_task` — the two RPCs the product routes through — and
`authority_rules` holds **zero rows**. With no matching rule it falls through to
`v_worst`'s default and **allows**. It is wired and inert.

That design's own migration table says `de_autonomy.max_amount_cents` becomes an authority
rule during its cutover. `trust_apply_level` is what writes that column. **So the ladder
feeds the evaluator**, and this design must not assume it owns the enforcement path.

⚠ **The sequencing risk, stated plainly:** if the authority cutover lands while promotion
is being built, the meaning of a granted step moves from `de_autonomy` to
`authority_rules` underneath it. The two must agree on where a granted limit lives before
either ships. The authority design mentions the trust ladder **zero times** — verified by
grep across it — so this seam has not been agreed by anyone yet, and agreeing it is a
prerequisite, not a detail.

---

## 8. The decision this design front-loads

**The first role to declare a ladder decides what "level 1" means for every employee ever
hired into it.** That is a larger commitment than it appears, it is made once, and it is
made before any employee in that role has done any work.

This is deliberate — it is the same shape as `autonomy_templates`, which already decides
what an employee may do at hire. But it deserves a real review per role rather than a
default copied between them, and the first three roles to get one should be chosen by the
founder rather than by whichever employee happens to become eligible first.
