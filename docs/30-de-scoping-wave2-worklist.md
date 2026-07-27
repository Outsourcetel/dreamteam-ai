# 30 — DE Scoping Wave 2: the SECURITY DEFINER bypass

**Status:** verified worklist, 2026-07-27. Nothing here is fixed yet.
**Follows:** `29-permissions-and-de-reporting-line.md` §7, migration 386 (Wave 1).

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

| function | reads |
|---|---|
| `get_workforce_board` | human_tasks + de_work_items |
| `get_workforce_learning_digest` | human_tasks + de_conversations + de_work_items |
| `get_de_operating_model` | human_tasks + de_work_items |
| `analytics_de_workload` | de_work_items |
| `get_de_work_product` | de_conversations |
| `get_de_economics` | de_conversations |
| `get_de_csat_metrics` | de_conversations |
| `get_de_kpi_status` | de_conversations |
| `get_benchmark_report` | de_conversations |
| `get_pending_draft` | draft_responses |
| `get_pending_drafts_for_de` | draft_responses |
| `list_browser_operator` | human_tasks |
| `check_de_retirement_readiness` | human_tasks + de_conversations |

⚠ `get_workforce_board` is the highest priority: it is the roster everybody
lands on, and it aggregates across every DE by design.

### B. Actors — they change one identified row

The risk is different: not "sees too much" but "acts on a DE they are not
responsible for". A scoped user who learns a row id could approve a draft or
send a reply for somebody else's employee.

**Fix:** a guard at the top — `IF NOT can_access_de(<the row's de_id>) THEN
RAISE EXCEPTION ...` — after resolving the row, before mutating it.

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
