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

**NOT STARTED — all 25 confirmed still unguarded as of 2026-07-27**, verified by
reading live definitions after group A landed. A guard here is not a filter: it
is `IF NOT can_access_de(<the row's de_id>) THEN RAISE` *after* resolving the
row and *before* mutating it. Filtering an actor silently turns "you may not do
this" into "nothing happened", which is worse than either.

| group | functions |
|---|---|
| Drafts & replies | `approve_draft`, `approve_draft_reply`, `edit_outbound_draft`, `sync_outbound_draft_status`, `send_human_reply` |
| Support flow | `claim_support_conversation`, `set_support_conversation_state`, `handoff_back_to_de` |
| Missions & work | `create_de_mission`, `create_de_team_mission`, `set_de_mission_state`, `enqueue_de_work_item` |
| Write-back proposals | `propose_account_writeback`, `propose_invoice_writeback`, `propose_opportunity_writeback`, `propose_continuity_writeback` |
| Learning & trust | `approve_learned_behavior`, `reject_learned_behavior`, `apply_improvement`, `request_trust_promotion` |
| Onboarding & evidence | `resolve_onboarding_signoff`, `update_onboarding_item`, `submit_evidence_feedback` |
| Browser operator | `create_browser_operation`, `propose_browser_task` |

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
