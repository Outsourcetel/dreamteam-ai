# 34 — The approval step should teach the workforce

**Status:** specification note, 2026-07-27. Founder-requested. Nothing built.
**Origin:** requested immediately after the first scoped-user approval succeeded
in production (Ali Subhani, `relation=manager`, approving a Technical Support
task through the newly reachable approvals queue).

> "An approver should be able to approve it with some edits, or reject it with
> reasons, so there is a learning memory in both cases."

---

## 1. The gap, measured

`human_tasks` has **no column for a decision reason or an edit**:

```
id, tenant_id, type, title, detail, source, related_table, related_id,
status, decided_by, decided_at, created_at, updated_at, account_id,
checklist_state, sla_due_at, assigned_role, assigned_user_id, priority,
handoff_summary, de_id
```

`decideHumanTask` (`src/lib/customerApi.ts`) writes exactly three of them:
`status`, `decided_by`, `decided_at`. **A decision produces a binary and nothing
else.**

This is the **highest-volume human-judgment surface in the product** — 137
pending tasks in one workspace, 118 of them visible to a single scoped user —
and it is the one path that captures neither rationale nor correction.

Every human judgment made there today is discarded the moment it is made.

## 2. ⚠ The capability already exists — wire it, do not build it

The vocabulary and the shapes are already in this codebase. The generic path is
the one that skipped them.

**Edit-on-approve already ships**, for drafts:
- `approve_draft(p_draft_id, p_edited_content, p_notes)`
- `approve_draft_reply(p_message_id, p_edited_content)`

**Reject-with-reason ships in ~15 functions**, all `(uuid, text)`:
`reject_draft`, `reject_learned_behavior`, `reject_knowledge_revision`,
`retire_digital_employee`, `pause_digital_employee`, `close_opportunity_lost`,
`trust_demote`, `reject_subtenant_request`, and others.

**The learning sinks are already built AND already read** — nothing new is
needed downstream:
- `de_memory_write` — already used by `handoff_back_to_de` to write a human's
  note into the employee's memory, which de-answer recalls on the next turn in
  that thread. This is the closest existing analogue to what is being asked for.
- `submit_evidence_feedback` — already COMPOSES a knowledge revision from a
  negative verdict and raises it for approval.
- `knowledge_gap_clusters` (with `recurred_after_fix` / `recurrence_count` for
  fix durability), `workforce_entity_amendments`.

So the work is: add two fields to the generic path, and connect them to sinks
that already exist and already have readers.

## 3. Design guidance, including where I would push back

**a. The EDIT is the valuable half — not the reason.**
An approve-with-edits yields an `(original, corrected)` pair: precisely what the
employee got wrong, written by the person best placed to know, at the moment of
work, at zero marginal cost. That is a supervised training signal and it is
strictly better than any rating, thumbs or score. **If only one half ships, ship
edits.**

**b. ⚠ Free-text-only reasons will decay to "ok" and "no".**
A mandatory free-text box on a 118-item queue produces noise, not signal — and
this project has shipped a written-never-read surface before (`ops_alerts` had
no reader for four days; the standing rule from that incident is *grep for a
READER before calling anything shipped*).

Structure it: a small **closed set of reason codes** — wrong facts / wrong tone /
missing context / not permitted / customer-specific / other — with **optional**
free text. Codes aggregate; sentences do not. *"37% of rejections this month
were wrong-tone, all on one employee"* is actionable. 118 sentences are a
backlog nobody reads.

**c. Approvals must write too, not only rejections.**
A clean approve-with-no-edits is itself signal: confirmation the answer was
right, and the denominator that makes a rejection rate mean anything. Silent
approvals leave quality unmeasurable.

**d. Audit it, with a constraint-legal category.**
Per migration 429: a decision that changes what an employee does belongs in the
audit chain. `audit_events_category_check` permits `approval`, which is the
correct value here. **Check `pg_constraint` before using any category** — a spec
that proposed `'governance'` would have raised inside `append_audit_event` and
aborted the caller, because `p_category` is not normalised.

**e. It must carry the group-B guard shape.**
`decideHumanTask` is a **direct UPDATE** on `human_tasks`, not an RPC — which is
exactly why it escaped all 48 wave-2 function guards and required migration
452's restrictive write policy. If this becomes an RPC (likely, to carry status,
edit and reason atomically), it must guard on the task's DE via `can_access_de`
and **refuse explicitly** — raising or returning an error envelope per its own
contract, never filtering. See `docs/30` §B.

## 4. Why this is worth doing now rather than later

The governance moat is the locked wedge (`docs/24`). Today the product can prove
a human *approved* something. It cannot yet prove **what the human knew, changed,
or objected to** — which is the difference between an audit trail and a learning
system, and it is the first question a governance-first buyer asks after "who
approved it".

It is also the cheapest learning signal available: it requires no new human
effort, because the approver is already reading the item and already deciding.
The only thing missing is capturing what they were going to do anyway.

## 5. Verified context this builds on

All confirmed in production, 2026-07-27, with predictions written before each
check:

- Sarah Mitchell (`primary`) — sees **1 of 15** employees, **118 of 137** tasks
- Ali Subhani (`manager`) — reaches the approvals queue after the navAccess
  assignment-axis change, also sees **118**
- Ali's approval **succeeded** — migration 452's restrictive write policy on
  `human_tasks` bounds without blocking

So the surface this extends is live, scoped and verified. What remains unproven
across the wave is the **refusal** path — that a group-B actor says *no* — which
no successful action can demonstrate.
