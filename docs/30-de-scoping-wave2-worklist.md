# 30 — DE Scoping Wave 2: the SECURITY DEFINER bypass

**Status:** **Group A COMPLETE (13/13), migrations 387–402, applied and verified
against live definitions 2026-07-27. Group B (25 actors) NOT STARTED.**
**Follows:** `29-permissions-and-de-reporting-line.md` §7, migration 386 (Wave 1).

> **Group A is code, not behaviour.** Every claim below is a claim about what
> the function bodies now contain, verified by re-reading `pg_get_functiondef`
> after each migration. None of it has been observed from a scoped user's
> session, because no such user exists — see "How to know it worked".

---

## The finding

Migration 386 put restrictive RLS policies on seven work-surface tables so they
follow their digital employee. **Those policies are bypassed on every RPC path.**

RLS does not apply inside a `SECURITY DEFINER` function. Measured on production:

> **46 SECURITY DEFINER functions, all executable by `authenticated`, read the
> seven Wave 1 tables. NONE of them calls `can_access_de()`.**

So today a scoped user would get correct results from a direct table read and
unscoped results from any RPC — and the product reads almost everything through
RPCs. **DE scoping is real in the schema and decorative in practice until this
list is worked through.** That is stated plainly here so nobody reads "Wave 1
complete" as "scoping works".

Nothing is currently exposed: no live workspace has anybody below manager, and
`can_access_de()` returns true for owner, admin and manager. This is a gap that
opens the day somebody is given a scoped role — which is exactly when it would
be least welcome to discover.

---

## Two different problems, two different fixes

The 46 split by what they do, and the fix differs.

### A. Readers — they return lists (the leak surface)

These return DE-attached rows to whoever calls them. Unscoped, a `tenant_user`
assigned to one DE sees every DE's data.

**Fix:** add `AND can_access_de(de_id)` to the query, or `WHERE
can_access_de(...)` on the returned set.

| function | reads | migration | guards | note |
|---|---|---|---|---|
| `get_workforce_board` | human_tasks + de_work_items | 387 | 1 | gate on the outer employee filter |
| `get_de_csat_metrics` | de_conversations | 388 | 1 | per-employee list; wired to `api.ts:1100` |
| `get_workforce_learning_digest` | human_tasks + de_conversations + de_work_items | 389, **400** | 4 | incl. the `ramp` roster |
| `get_benchmark_report` | de_conversations | 390, **401** | 5 | one per source read |
| `get_de_economics` | de_conversations | 391, **402** | 4 | ROI numbers narrow with scope |
| `get_de_operating_model` | human_tasks + de_work_items | 392 | 1 | denial reports as `not_found` |
| `get_de_work_product` | de_conversations | 393 | 1 | denial reports as `de_not_found` |
| `get_de_kpi_status` | de_conversations | 394 | 1 | membership check kept alongside |
| `get_pending_draft` | draft_responses | 395 | 1 | ⚠ see follow-ups |
| `get_pending_drafts_for_de` | draft_responses | 396 | 1 | ⚠ see follow-ups |
| `list_browser_operator` | human_tasks | 397 | 1 | runtimes left workspace-wide |
| `analytics_de_workload` | de_work_items | 398 | 2 | ⚠ also closed a cross-tenant hole |
| `check_de_retirement_readiness` | human_tasks + de_conversations | 399 | 1 | **no behavioural change** — see below |

**24 guards across 13 functions.** One function per migration, each asserting
its own guard count landed or raising. A failed assertion rolls the patch back:
the management-API path runs each migration in one implicit transaction, proven
when 397's first attempt failed its own position check and left the function
unmodified.

### What the group-A pass changed that was NOT DE scoping

1. **`analytics_de_workload` had a cross-tenant hole** (closed in 398). It is
   `SECURITY DEFINER`, granted to `authenticated`, takes `p_tenant_id` as a
   PARAMETER and never compared it to the caller's workspace — no auth check of
   any kind. Any signed-in user could read any tenant's objective and work-item
   counts. **`can_access_de` alone would not have closed it:** owner/admin/
   manager pass `can_access_de` for *any* uuid, because they pass on role before
   the assignment lookup. The tenant pin had to go in too. It has **zero
   callers** — recommend dropping it outright.
2. **`check_de_retirement_readiness` was never actually exposed.** It is already
   gated to `tenant_owner`/`tenant_admin`, both of whom pass `can_access_de`
   unconditionally. 399 adds the guard as defence in depth and changes no
   behaviour. Counted as guarded, not as a hole closed.

### The null-`de_id` question — answered consistently, NOT settled

Migration 386's seven policies all read `(de_id IS NULL) OR can_access_de(de_id)`
— an unattributed row is workspace-visible. Migrations 389/390/391 first shipped
a bare `can_access_de(de_id)`, which is **false** for a scoped user on a null
`de_id`. That made the RPC path stricter than the table's own policy: the same
"one predicate in two places" failure `29` names as the reason `can_access_de`
exists. Migrations **400–402** align the RPCs to the policy.

This matters at production scale, not in theory: **`human_tasks.de_id` is NULL
on 760 of 924 rows (82%)**. `de_conversations` has 14 such rows;
`de_work_items`, `draft_responses` and `computer_use_tasks` have none
(`NOT NULL`).

⚠ **Open founder question:** *should* an unattributed row be workspace-visible?
Wave 1 says yes and everything now agrees with Wave 1, which is the prerequisite
for changing the answer in one place. Nobody is affected today — every live user
is owner, admin or manager.

### Follow-ups found in passing, deliberately NOT bundled in

Neither is a DE-scoping bug; both are on functions group A touched, and both are
recorded rather than fixed so a scoping migration stays a scoping migration.

- **`anon` holds EXECUTE on `get_pending_draft` and `get_pending_drafts_for_de`.**
  Signup is live, so `anon` is the internet. They fail closed twice over — the
  only other guard is `current_setting('app.current_tenant_id')`, which *raises*
  when unset, and `can_access_de` is false for `anon` on every branch — so this
  is not urgent. It is still the class migration 330 closed. Both have zero
  callers.
- **Neither function sets `search_path`**, on a `SECURITY DEFINER` body. Every
  comparable function in this codebase pins it. The guards added in 395/396 are
  schema-qualified for exactly this reason, and both migrations assert it.

### B. Actors — they change one identified row

The risk is different: not "sees too much" but "acts on a DE they are not
responsible for". A scoped user who learns a row id could approve a draft or
send a reply for somebody else's employee.

**Fix:** a guard at the top — `IF NOT can_access_de(<the row's de_id>) THEN
RAISE EXCEPTION ...` — after resolving the row, before mutating it.

**✅ COMPLETE — 22 of 22 (migs 403–424), verified against live definitions.
The honest split: 17 closed a real gap, 5 are defence in depth. And it is 22
actors, not the 25 first listed — three were misclassified.** A guard here is
not a filter:
it is `IF NOT can_access_de(<the row's de_id>) THEN RAISE` *after* resolving the
row and *before* mutating it. Filtering an actor silently turns "you may not do
this" into "nothing happened", which is worse than either. Every guard raises
the same greppable error, `not_responsible_for_de`.

### ⚠ It is 22, not 25 — three were misclassified

Verified, each by reading the live definition or the schema rather than the
list:

| function | why it is not a group-B actor |
|---|---|
| `sync_outbound_draft_status` | `RETURNS trigger`, attached to 1 trigger. PostgREST does not expose trigger functions as RPCs, so it is not user-callable and has no caller context to check. → **group C** |
| `resolve_onboarding_signoff` | acts on `onboarding_projects`, which has **no `de_id` and no DE-shaped column at all** — it is `account_id` → `customer_accounts`. Customer onboarding, no digital employee anywhere in the data path. The one live onboarding `human_task` has a NULL `de_id`. → **not DE-scoped** |
| `update_onboarding_item` | same table, same reason. → **not DE-scoped** |

There is nothing for `can_access_de()` to test in the onboarding pair: no
employee is involved. Guarding them would have meant inventing a relationship
the schema does not have. They still deserve a look — they are `SECURITY
DEFINER` and client-reachable — but on the *workspace* axis, which they already
check, not this one.

This is the reverse of the risk the group-C section warns about: **verify before
*guarding*, as well as before skipping.**

### Done (migs 403–409)

| function | migration | resolves de via | null-tolerant? |
|---|---|---|---|
| `approve_draft` | 403 | `draft_responses.de_id` (NOT NULL) | no — null means no such draft |
| `approve_draft_reply` | 404 | `de_conversations` (de_messages has no `de_id`) | yes |
| `edit_outbound_draft` | 405 | extends the existing `outbound_drafts` lookup | no — `de_id` is NOT NULL |
| `send_human_reply` | 406 | `de_conversations` | yes |
| `claim_support_conversation` | 407 | `de_conversations` | yes |
| `set_support_conversation_state` | 408 | `de_conversations` | yes |
| `handoff_back_to_de` | 409 | already resolved `v_de` | no — body rejects a null `v_de` first |
| `propose_invoice_writeback` | 410 | `p_de_id` param | no — `de_not_found` proves it resolves |
| `propose_account_writeback` | 411 | `p_de_id` param | no — same |
| `propose_opportunity_writeback` | 412 | `p_de_id` param | no — same |
| `propose_continuity_writeback` | 413 | `p_de_id` param | no — same |
| `create_browser_operation` | 414 | `p_de_id` param | n/a — defence in depth |
| `propose_browser_task` | 415 | `p_de_id` param | n/a — defence in depth |
| `approve_learned_behavior` | 416 | `de_learned_behavior_clusters` (NOT NULL) | no |
| `reject_learned_behavior` | 417 | same table | no |
| `apply_improvement` | 418 | `de_improvements` (NOT NULL) | no |
| `request_trust_promotion` | 419 | `trust_policies` (**NULLABLE**) | **yes** |
| `enqueue_de_work_item` | 420 | `p_de_id` param | n/a — mirrors the null-uid bypass |
| `create_de_mission` | 421 | `p_de_id` param | n/a — defence in depth |
| `create_de_team_mission` | 422 | `target_spec` ×3 modes | n/a — defence in depth |
| `set_de_mission_state` | 423 | `de_missions` (**NULLABLE**) | **yes** — defence in depth |
| `submit_evidence_feedback` | 424 | `evidence_runs` (**NULLABLE**, 73% null) | **yes** |

### `submit_evidence_feedback` (424) — the last actor, and the widest null case

A verdict of `needs_improvement` or `inaccurate` does not just record an
opinion: it **composes a knowledge revision** — reading the doc the run cited,
appending the reviewer's note and the recorded evidence gaps — and raises a
`knowledge_revision` task for approval. Same shape as learning & trust: the harm
is not the row it writes, it is what the employee ends up knowing.

**`evidence_runs.de_id` is NULL on 149 of 203 rows — 73%.** Every other
null-tolerant guard in this wave covered an edge case; this one covers most of
the table. The plain form would have refused feedback on nearly three quarters
of all evidence runs for a scoped user while the readers beside it show them.

`evidence_runs.specialist_de_id` is deliberately **not** guarded: the run is the
work of `de_id`, and being consulted does not transfer ownership of the verdict.

### Missions & work: one real gap, three defence in depth

`create_de_mission`, `create_de_team_mission` and `set_de_mission_state` are all
gated to manager+, so 421–423 change nothing (same standing as 399/414/415).

**`enqueue_de_work_item` (420) was the real one.** Its only check was workspace
membership — *no role gate at all* — so any authenticated member could queue
work for any employee. That is the function that puts work into an employee's
queue.

**Its guard deliberately copies the `auth.uid() IS NOT NULL` bypass**, the shape
the perimeter work flags as dangerous. Justified and verified, not assumed:
`de-work` calls this through a service-role client whose JWT has no `sub`, so
`auth.uid()` is NULL on that path and a bare guard would raise inside the worker
and stop the autonomy loop; **no database function calls it** (checked across
every plpgsql body), so the edge function is the only machine caller; and **anon
does not hold EXECUTE**, so the banned combination (anon-executable AND
fail-open on a null uid) does not arise. Migration 420 **fails if anon ever
holds EXECUTE**, so the premise is checked rather than trusted, and its smoke
test proves the guard is bypassed for a NULL-uid caller — i.e. that `de-work`
still works.

`create_de_team_mission` needed **three** guards, one per targeting mode
(explicit id list / supervisor / archetype), asserted individually by name so a
missing branch is named rather than merely counted.

### ⚠ KNOWN GAP left open in 423 — team missions are not scoped

`de_missions.de_id` is NULL for every **team** mission (targeting lives in
`target_spec`), so 423's guard is null-tolerant and **passes on team missions
without walking `target_spec`**. A scoped user could therefore cancel a team
mission targeting employees they do not own — and cancel is the broadest
destructive act in group B: it deletes the mission's watchers, cancels every
queued work item under its objectives, and abandons the objectives.

Not closed here because doing it properly means resolving all three targeting
modes inside a live cancel path — one of them late-bound — which is a bigger
change than a scoping wave should make. **Inert today:** manager+ only, and
`de_missions` has 0 rows in production. Recorded as the follow-up.

Related, from 422: an **archetype** mission is checked against the set as it
stands *at creation*; the set is re-resolved at dispatch, so an employee hired
into that archetype afterwards is included without ever having been checked.
That is a limitation of scoping a late-bound target, not a fixable predicate.

### Learning & trust: what these change is what an employee *becomes*

Everything before this sub-group changes what an employee *did once*. These
change what it knows or what it is allowed to do without asking, and the change
persists into every future task.

`request_trust_promotion` is the sharpest: it does not grant the promotion — a
human still approves the task — but an unscoped caller could put an employee
they have no relationship with in front of an approver, evidence pre-assembled,
their own name on the request. That is how a rubber-stamp happens.

**Four functions, two guard shapes, decided per column — not copied.** Three
have a `NOT NULL` `de_id` and take the plain form. `trust_policies.de_id` is
**nullable**, and 8 of the 38 live policies are workspace-level, so 419 uses the
null-tolerant form. The sibling functions would have suggested the plain form;
checking the column beat inferring from the neighbours.

### ⚠ Two reach findings — the guard bounds the approver, not the blast radius

Both are design questions, not scoping bugs, so they are recorded rather than
changed. Changing either would alter what the feature does, which is not this
wave's business.

1. **`approve_learned_behavior` creates a WORKSPACE-WIDE guardrail rule.**
   Measured: `guardrail_rules.scope` is `NOT NULL DEFAULT 'workspace'` and the
   INSERT does not set it. So a behaviour learned from *one* employee becomes a
   rule binding *every* employee. The other branch is sharper — given no
   override it runs `update guardrail_rules set active = false`, and **155 of
   the 171 live rules are workspace-scoped**, so approving a "too strict"
   verdict can switch off a guardrail protecting the whole workforce. After 416
   the caller must be responsible for the employee the cluster came from; the
   rule they create or disable still reaches everyone. *Open question: should a
   learned behaviour publish at `scope = 'employee'` by default? The column
   already supports it and 16 rules use it.*
2. **`apply_improvement` can publish at ROLE scope.** With
   `publish_scope = 'role'` the doc goes to every employee of that archetype —
   the activity event says "shared with all &lt;archetype&gt; employees". Unlike (1)
   this is a deliberate human-chosen field (T2.2), not an unset default, so it
   is noted rather than flagged.

### ⚠ "Refuse, never filter" — the mechanism is per contract, not always RAISE

The first seven actors raise. The four write-backs do **not**, and that is
deliberate. They communicate every failure through an `{ok:false, error:...}`
envelope — `bad_op`, `de_not_found`, `not_tenant_member`,
`invoice_not_in_tenant`. Raising there would break every caller's error handling
for no security gain, so the guard returns `not_responsible_for_de` in the same
envelope, sitting directly beside `not_tenant_member`.

That is still an explicit refusal the caller can see and handle — the thing
group B forbids is a *silent* filter, not the RAISE keyword specifically. The
error **code** is identical across all of group B so it stays greppable and the
frontend has one string to handle.

### Why the write-back four are the sharpest end of group B

Everything else in group B moves rows inside DreamTeam. These propose changes to
a **customer's system of record**, and they do not always stop for a human: when
`decide_action_execution` returns `auto_executed` the write is applied
immediately via `apply_*_writeback_internal`. Unscoped, a person assigned to one
employee could trigger a write into billing, a CRM account, a pipeline deal or a
renewal case on behalf of an employee they have no relationship with — and where
the trust dial permits auto-execution, with nobody in the loop at all.

Verified per function, from live definitions: guard present exactly once, after
the tenant check, and **before** the gate, the request insert, and the
auto-apply. The existing anti-hallucination guarantees (closed status enums,
configured-stage lookups) are asserted to have survived each rewrite — losing
one of those would be a worse regression than the gap being closed.

⚠ Cosmetic only: migration 410 injected `function''s` into a `--` comment inside
the body (an over-escaped apostrophe). No functional effect; left alone rather
than churn a live security function for a typo. 411–413 avoid apostrophes.

### ⚠ The browser-operator two were NOT holes — this list overstated them

`create_browser_operation` (414) and `propose_browser_task` (415) were already
gated to `tenant_owner` / `tenant_admin` / `tenant_manager`, and `can_access_de()`
passes all three **unconditionally**, before the assignment lookup is reached.
**Every caller who could reach them already satisfied the check being added, so
neither migration changes any behaviour.** A scoped user could not reach either
one. The browser-operator surface a scoped user *could* reach was the reader
`list_browser_operator`, closed in migration 397.

They were applied anyway for two reasons — not to finish the list. A task here
carries a `credential_policy` that can be `vault_injected`, meaning the runtime
is handed a real stored credential for a customer system; if browser operations
are ever opened below manager, the guard must already be in place. And leaving
the rule in the role gate alone writes it in two places, which is the mistake
the knowledge ACL taught.

Both migrations assert the **manager+ role gate survived the rewrite**. That is
the critical assertion in each file: trading the real gate for the redundant
guard would have *widened* access from manager+ to any assigned user, while
reading like a security improvement in a diff.

`check_de_retirement_readiness` (399, group A) has exactly the same standing.
**Running total of genuine group-B gaps closed: 11 of 13 guarded.**

### The counter that makes these claims checkable

Throughout the wave, "how many guards does this body have" is measured by
counting occurrences of `can_access_de` in the live definition. That only works
if no injected **comment** contains the token — migration 414 first failed its
own assertion for exactly that reason (comment + call = 2). The comments in 414
and 415 were reworded rather than loosening the counter, because the invariant
*occurrences == real calls* is what the independent verification depends on.
Verified across all 13: `token_count = call_count` everywhere, no contamination.

**Null-tolerance is per-function, decided by the column, not copied.** Where the
`de_id` is nullable the guard is `IF v_de IS NOT NULL AND NOT can_access_de(...)`
— the exact negation of the migration-386 policy `(de_id IS NULL OR
can_access_de(de_id))`, so an actor is never stricter than the reader beside it.
Where the column is `NOT NULL`, or the body has already rejected a null, the
plain form is used; adding null-tolerance there would be dead code implying a
case the function has excluded.

### ⚠ Two mechanical traps, both hit and both worth inheriting

1. **Line endings are mixed in this database.** `pg_get_functiondef` returns each
   body as it was created, and the migrations that created these did not agree.
   `approve_draft` is CRLF; the group-A bodies were LF. A multi-line anchor
   written with plain `\n` matched **zero** times and the migration correctly
   refused rather than guessing. Every multi-line anchor from 403 on is composed
   against the EOL actually found in the body. Single-line anchors are immune,
   which is why group A never hit it.
2. **Position assertions are easy to write inverted.** Two migrations (406, 409)
   failed their own order check because the pass case was written as the raise
   case via an `IF ... THEN NULL; ELSE RAISE` shape. Both rolled back cleanly.
   State the *failure* condition directly and never use that shape.

### ⚠ Standing finding: 13 of the 35 guarded functions are `anon`-executable

Surfaced repeatedly through the wave and consolidated here, because it is a
different axis from DE scoping and no migration in 387–424 changed it:

`approve_draft`, `approve_draft_reply`, `claim_support_conversation`,
`create_de_mission`, `create_de_team_mission`, `get_pending_draft`,
`get_pending_drafts_for_de`, `propose_account_writeback`,
`propose_continuity_writeback`, `propose_opportunity_writeback`,
`send_human_reply`, `set_de_mission_state`, `set_support_conversation_state`.

**Eleven of those are actors.** Signup is live, so `anon` is the internet. They
fail closed today — every one has a tenant or role check that `anon` cannot
satisfy, and `knowledge-acl-invariants` (21/21) enforces that none is both
`anon`-executable *and* fail-open on a null uid. So this is debt, not an open
door. It is still the class migration 330 closed, on functions that mutate.

Recommended follow-up: `REVOKE ALL ON ROUTINE <sig> FROM PUBLIC, anon` for the
lot, using the mig-365 criterion (no `src/` call site ⇒ safe, because edge
functions use the service-role key which bypasses GRANTs). Not done here —
revoking is a separate decision from scoping and deserves its own migration.

### What is left outside these two groups

37 `SECURITY DEFINER` functions still read a Wave-1 table without a guard. That
number sounds worse than it is; broken down:

- **3** are `RETURNS trigger` — not RPC-reachable.
- **27** are neither triggers nor `authenticated`-executable — service-role and
  internal paths only.
- **7** are client-reachable, and **all seven are already accounted for**:
  five are group C (`_assert_conv_member`, `assess_definition_of_done`,
  `dispatch_de_work_internal`, `resolve_action_execution_for_task`,
  `submit_csat`) and two are the reclassified onboarding pair.

So there is no undiscovered surface hiding behind the 46 this document started
from. The next real work is group C.

⚠ Two group-C members — `_assert_conv_member` and `dispatch_de_work_internal` —
are **`anon`-executable**. That is precisely what "verify before skipping"
was written for.

### Remaining (0 — group B complete)

| group | functions |
|---|---|
| ~~Drafts & replies~~ | ✅ all done (403–406); `sync_outbound_draft_status` reclassified to C |
| ~~Support flow~~ | ✅ all done (407–409) |
| ~~Missions & work~~ | ✅ all done (420–423) — 1 real gap, 3 defence in depth |
| ~~Write-back proposals~~ | ✅ all done (410–413) |
| ~~Learning & trust~~ | ✅ all done (416–419) |
| ~~Onboarding & evidence~~ | ✅ `submit_evidence_feedback` done (424); the two onboarding fns **reclassified — no `de_id` exists**, see above |
| ~~Browser operator~~ | ✅ all done (414–415) — both defence in depth, see note above |

### C. Internal — reached by triggers or the service role, not by users

Left alone deliberately. Adding a caller check to something the service role
invokes would break the workers: `can_access_de()` returns true for
`service_role`, but these have no user context to check in the first place.

`_assert_conv_member`, `trg_support_sentiment`,
`trg_triage_support_conversation`, `dispatch_de_work_internal`,
`guard_computer_use_transition`, `resolve_action_execution_for_task`,
`assess_definition_of_done`, `submit_csat`

**Verify before skipping.** "Internal" is an assumption about how each is
called; anything in this group that turns out to be user-callable belongs in A
or B.

---

## How to do this safely

1. **Reproduce from live.** `pg_get_functiondef` → targeted edit → `EXECUTE`.
   These functions have been amended repeatedly; pasting a body from an old
   migration silently reverts that work. That is how migration 377 undid the
   export pager.
2. **One group per migration**, with assertions naming the functions changed —
   not one migration for all 46.
3. **Assert the guard survived.** A rewrite that drops a check fails open and
   looks fine.
4. **Do not add a caller check to group C** without first proving it is
   user-callable.

## How to know it worked

None of this is provable from a migration. `can_access_de()` returns false for
the `postgres` role a migration runs as — it has no workspace identity — so a
migration asserting on visibility measures the runner, not a user. That mistake
was made and caught in 386.

The real test needs **an invited `tenant_user` assigned to exactly one DE**.
Then: the roster shows one employee, the approvals queue shows only its tasks,
and every function in group B refuses a row belonging to another DE.

Until that user exists, every claim in this area is a claim about code, not
about behaviour.

**That user still does not exist.** Group A's 24 guards were verified by
re-reading `pg_get_functiondef` from production after each migration and
counting them — which proves the text is in the deployed bodies and proves
nothing about what anybody sees. The migrations run as `postgres`, which is a
member of no workspace, so their runtime smoke tests could only check that each
function still answers in contract (the correct answer for `postgres` being an
empty board, a `not_permitted`, or the function's own auth gate firing).

What would settle it, in order:
1. Invite a `tenant_user`, assign them `primary` on exactly one DE.
2. Sign in as them and read the roster, the Employee File and the approvals
   queue. Expect one employee.
3. Check the null-`de_id` consequence deliberately — with 82% of `human_tasks`
   unattributed, the approvals queue is the place the answer to the open
   question above will first be visible.
4. Only then is any part of this "scoping works" rather than "scoping is
   written down".
