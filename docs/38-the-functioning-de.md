# 38 — The Functioning DE: what the execution layer actually does

**Date:** 2026-07-28
**Charge (founder, verbatim):** "This maybe good for a demo DE but not a functioning DE."
**Relationship to docs/37:** docs/37 proved the OS cannot honestly *see* work (the
measurement organs). This audit asks the harder question the founder's charge poses:
can a DE actually *do* work? Method: six walks of the live runtime (the wake loop, the
action surface, playbooks-as-procedures, work product & memory, the unblock loop, the
communication channels), a literal 30-day trace of the tenant's soonest real renewal
under today's code, a capability bar built from the platform's *own kit promise*, and
an adversarial critique that independently re-ran every load-bearing number and read
every load-bearing live function definition. Verdict of the critique:
**stands-with-corrections** — and the corrections *tighten* the case.

**Verdict: the founder is right, in a precise and repairable sense.** Every station of
a knowledge worker's day exists in this codebase as genuine, governed machinery — and
not one station's exit connects to the next. The runtime can demonstrate any single
step on seeded data and cannot complete any two consecutive steps on real data. This
is not a thin veneer; it is **a workforce with working organs and severed nerves.**

---

## The numbers (all proven live, all independently re-verified)

- **1,556 objective wakes at hq have produced 6 written assessments** (0.39%) — all
  six saying the same thing: "blocked, no access to real data." The counter climbed
  by 8 *during the audit itself*; every one a no-op.
- **The Renewal DE has made ZERO LLM calls since July 22** — six days of "working"
  with no thinking at all — while its wake counter climbed to 120. The silence is
  structural, not an outage: the tenant made 301 successful LLM calls in the same
  window through the chat path.
- **33 of 33 work items ever marked "done" at hq are questions addressed to nobody.**
  A text-only model reply is stamped done by code (de-work:824-827); all 33 summaries
  are exactly 500 characters — the truncation signature of that path. The
  definition-of-done gate built to stop exactly this is disabled platform-wide.
- **The platform has never executed one action against a real external business
  system in its entire life.** All 137 completed "external" execution rows POSTed to
  jsonplaceholder.typicode.com — a fake echo API; the registry's only "Send a payment
  reminder" action binds to a template literally named "JSONPlaceholder
  (verification)". The two real-provider attempts (Zendesk) died at the approval gate.
- **The platform has never sent or received a single email, for any tenant, ever.**
  0 outbound drafts platform-wide; no tenant has a from-address (a 5-minute setup no
  code path ever asked anyone to perform); `draft_outreach` has 0 calls by any DE in
  history; the "reply arrived" primitive (`resolve_case_await`) has 0 runtime callers
  — so the platform's own tool promise "if the reply comes first, the chase is
  cancelled automatically" is structurally unfulfillable.
- **The mission rail — our declared keystone since docs/14 — has never been used**:
  `de_missions` has 0 rows across every tenant ever. hq's lifetime playbook history:
  8 runs, 0 completed. The renewal SOP is 0-of-5 executable steps (all prose).
- **Humans' only recorded work decision was a void.** All 4 of the Renewal DE's
  escalations were bulk-rejected in one backstage microsecond (decided_by NULL — a
  sweep that hit 23 tasks, actor unidentified). Rejection changed nothing: the
  escalation rows carry no link to the work they block, every resume hook lives in a
  browser click handler the bulk write bypassed, and the one *designed* unblock
  (`decide_de_exception`, mig 443) has **0 uses in 18 opportunities across all
  tenants ever**. `waiting_human` is terminal in practice; six days later the 4 items
  still block 16 dependents.
- **Measured against the platform's own kit promise: 2 of 13 minimum week-one
  capabilities exist-proven.** The split is exact: everything a screenshot can show
  (notice a renewal, open the case, write a plan, articulate an escalation, run the
  approval choreography) exists and is proven; everything after the screenshot (read
  the record, name the contact, feel the deadline, produce and deliver the notice,
  hear the reply, remember yesterday, recover from a stall) is partial, unproven, or
  absent.

## The 30-day trace: Lakeshore Analytics, $120,000/yr, notice deadline Aug 15

The tenant's soonest real renewal. Auto-renews Sep 14 with a contractual 7% uplift —
**$8,400 that no code path anywhere reads.** Under today's code, verified link by link:

The machinery's honest arc already ran — and froze on July 22. The watcher correctly
opened the case, stamped name/value/deadline into the objective's own plan JSON, and
opened the continuity desk row. The planner decomposed a credible 5-step SOP-aligned
renewal motion. Then step 1 — *"Pull and verify the Lakeshore Analytics contract
record"* — hit the wall: **de-work builds a grounded desk only for `customer_account`
and `opportunity` cases; a `commercial_agreement` case gets no record context and no
reading tool** (de-work:603-634) — even though the full row sits in the tenant's own
`commercial_agreements` table and the key facts sit *in the objective's plan JSON,
written by our own watcher and read by nothing*. The DE escalated, verbatim: *"Cannot
locate Lakeshore Analytics contract record… I need access to the actual contract
record system"* — correctly diagnosing its own blindness, citing its SOP and the
Aug 15 deadline. A human rejected that plea into the void described above. Since
then: ~18 wake increments a day, zero work, zero spend, zero alarms.

**Aug 15 will pass in silence.** Nothing at runtime compares any date to now() — no
prompt contains today's date (the DE's one deliverable shipped "Assessment Date:
[Current]"), and a passed deadline permanently exits the watcher's view
(`target_date >= current_date`). The machine will wake the "notice_deadline Aug 15"
case hourly on Aug 16 with exactly the calm of Jul 28. **End state Aug 27:** wake
count ~119 → ~660; every other byte identical. The renewal's fate rides entirely on
the auto-renew clause and the customer's silence; if the customer cancels, the first
the tenant hears of it is from the customer.

## The layer model — what exists vs. what's severed

| Layer | Exists (proven) | Severed |
|---|---|---|
| **Perceive: the case** | Watcher→case-opening correct end-to-end | Work-time record access: no desk branch for the case's own table; kit's registered table empty while real agreements sit unregistered; no contact store (0 rows) |
| **Perceive: time** | 90/60/30-day pre-deadline noticing | No prompt knows today's date; nothing compares deadlines to now() after case-open; passed deadlines exit view forever; no stall/deadline detector |
| **Execute procedures** | Genuine 20-primitive server-side interpreter with gates and resume machinery | Kit SOPs are 83% prose (renewal: 0-of-5 executable); missions compile to prose and never start the named playbook; resume welded to a browser click |
| **Act externally** | Full gate choreography fired 4× live (platform-admin self-builder actions only) | Zero real external executions ever; the category-op vocabulary is read-only *by contract* (every op is search/get); update-stage/create-invoice/send-notice exist in no adapter |
| **Produce artifacts** | `produce_deliverable` wrote one genuine 2,166-char assessment when handed data | Text-only reply = "done" (33/33); def-of-done gate off; no pricing computation exists anywhere; 0 deliverables in the six real work days |
| **Communicate** | Chat real (205 conversations, support); full email pipeline exists as dormant-honest code | Zero traffic ever; no from-address anywhere; inbound would route every reply to the front support DE, not the owning DE; sent drafts create no thread a reply could join |
| **Remember** | Chat path auto-wrote 44 memories; embedding round-trips work | The work loop wrote 0 durable memories in its entire work week; step N never sees step N−1; the wake note is *discarded* (`conclude_objective_wake` drops p_note); recurring jobs re-ask yesterday's questions verbatim |
| **Get unblocked** | Escalation *asking* is the DE's strongest proven skill — specific, SOP-cited, deadline-aware | The return half: no back-link, write-only approvals surface, frontend-only resume glue, `blocked` objectives unrevivable, the designed unblock never used |

## The build program (execution layer — ranked, sized, deduped against docs/37)

1. **The grounded desk (KEYSTONE, 3-5 days).** Carry the record the platform already
   found into the work loop: an entity_kind-generic desk (commercial_agreement first)
   injecting the fields the watcher already stamped into `plan.subject`, a read tool
   for the case's actual table, DE-side continuity write-back, fixed kit system
   registration. Proven upside: the one time the DE was handed a record snapshot, it
   produced its only genuine deliverable. Re-scopes docs/37's D2: for the current
   book the "CRM" is *inside* the platform, one code branch away.
2. **Server-side human-answer return path (4-7 days).** Escalations carry
   related_id; every resume hook moves out of the React client; rejection resolves to
   a recorded disposition, never a silent no-op; `blocked` objectives revivable;
   backfill the 4 frozen items and rule the 18 pending exceptions. Unblocks 20 of the
   DE's 25 items today. Ship in the same wave as (1) — unblocking without record
   reach yields articulate begging, proven by Meridian.
3. **Completion integrity (3-5 days).** Text-only reply → needs_input routed to a
   human, never "done"; def-of-done gate on (shadow first); stop the 500-char
   truncation; pass step N−1's result into step N.
4. **A wake loop with intervention authority (~1 week).** Review-anyway past an age
   threshold with power to requeue/cancel/re-escalate; persist the wake note (the
   same store Move 1 of docs/37 needs — build once, feed both); wake-count alarm;
   recurring jobs inherit yesterday's diagnosis.
5. **Communication activation (~1 week + 1 day config).** From-address + provider
   config, first real send in platform history, inbound routing by owning DE,
   sends create the thread replies join, reply wakes the waiting case; seed contacts.
   docs/37 does not touch channels at all.
6. **Work memory spine (~1 week).** Auto-write outcomes and wake conclusions to
   memory; inject them into the next prompt; recall relevance threshold; today's date
   in every prompt.
7. **Executable procedures (1-2 weeks).** Author kit SOPs in the executable subset
   (the interpreter is genuine and idle); missions actually start the named playbook;
   cron reconciler for orphaned gated runs.
8. **Real external reach (weeks — the honest big one).** One live business connector
   with credentials, plus the write vocabulary that today exists *nowhere* (update
   stage, create/send invoice, send notice) with its authority model and receipts.
   docs/37's Move 4 (enforce required connectors) is one line of gate code; **this is
   the capability that line demands** — enforcement without it just blocks every hire.

Items 1-7 ship the *internal* renewal motion without item 8.

## New founder decisions (N1-N8)

1. **N1 (revises docs/37 D2):** run the renewal motion on the internal book first
   (days) and treat the CRM connector as later expansion — or hold the motion hostage
   to the connector (weeks + docs/32 D1-D5 still undecided). Recommend: internal first.
2. **N2:** write-authority scope — which external writes may *ever* exist, in what
   order, under which gates. Platform policy, not backlog.
3. **N3:** completion semantics — what does a text-only reply become, and does the
   def-of-done gate ship in shadow or enforce mode (enforcement reclassifies existing
   "done" work as hollow on live screens).
4. **N4:** one escalation surface, and "reject" must mean a recorded disposition
   (cancel-with-reason / answer / reroute) — today it is a proven black hole.
5. **N5:** communications go-live — authorize a from-address + inbound domain for hq
   and the first real send in platform history; replies route to the owning DE.
6. **N6:** stall budgets — how long may an item wait before auto re-escalation; how
   many wakes before an alarm. Business policy the runtime currently has no opinion
   on (475 silent wakes on one DE).
7. **N7:** backstage-write ban — both real human decisions ever recorded at hq were
   direct bulk UPDATEs bypassing the decide path (23 tasks in one untraced stroke).
   Prohibit or trigger-guard direct writes to human_tasks.
8. **N8:** auto-renew economics — untouched, Lakeshore renews itself Sep 14 and the
   contractual $8,400 uplift is captured by nothing. Is uplift pricing/invoicing
   inside the renewal motion's definition of done?

## What the critique caught — kept visible on purpose

- **A stale-evidence claim, struck:** one walk framed an invalid LLM key as the
  current blocker; the 401s ended July 22 and the key has worked since. The Renewal
  DE's silence is purely structural — do not budget a key fix as the unblock.
- **A wrong-table zero, corrected — and it uncovered a governance finding:** "never
  filed a write-back proposal" was false; the DE filed **9 gated write-back proposals**
  on test day July 21. Their approval tasks have since been **hard-deleted while
  undecided**, leaving dangling task_ids in the decision trace. For a platform whose
  moat is *governed* workforce, the approval ledger itself is erasable — new,
  unexamined, and serious.
- **Regrades toward strictness:** `decide_de_exception` is EXISTS-UNPROVEN (read as
  correct, never once observed to resume anything); every PERCEIVE "proven" fired
  only against the seeded book (all 3 agreements carry seed markers; one live
  objective's "renews Aug 10" customer is a dangling UUID over an empty table — test
  data deleted out from under live objectives); the approve→execute round trip has a
  demonstrated **double-execution** (one approval executed twice, 07-13 and 07-20)
  and has never completed exactly-once with a surviving artifact.
- **What this audit did not do:** no reaper exists for `de_work_items` stuck in
  'running' after a mid-loop crash (latent, same terminal-state family); the
  backstage bulk-writer's identity was never established (N7's design depends on it);
  the Technical Support DE was never used as the control case (its chat path *does*
  function end-to-end in production — the sharpest proof that the answer-shaped path
  works while the work-shaped path is severed); cross-tenant generality of the
  wake-spin was not measured; loop economics (528 plan-error rows over ~2 days with
  no circuit breaker and no ops alert) got a footnote, not a program item. Credit
  where due: the claim/wake loop is race-safe by design (SKIP LOCKED, idempotency
  keys, claim guards — verified in live defs), one of the few week-one properties
  that passes.

---

*Full walks, the 30-day trace, the 20-capability bar, synthesis, and critique are
preserved in the session archive. Every founder-facing number above was re-run
independently by the adversarial critic against live production on 2026-07-28.*
