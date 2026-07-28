# 39 — Founder decisions: the execution program

**Date:** 2026-07-28
**Decides:** all eight new decisions from docs/38 (N1-N8) and the five still-open
decisions from docs/37 (D1, D3, D4, D5, D6, D7 — D2 superseded by N1).
**Status:** FOUNDER-LOCKED. Build waves may proceed against these without re-asking.

---

## Wave 1 — gates the first build (decided)

**N1 — Working data source: INTERNAL BOOK FIRST.**
Wire the Renewal DE to the agreements already inside the platform (the grounded
desk, 3-5 days). A real CRM connector becomes a later expansion, not a
prerequisite. *This supersedes docs/37's D2*, which called "connect the CRM/ERP"
the highest-leverage action — docs/38 proved the book is internal and the DE is one
missing code branch from reading it.

**N3 — Completion semantics: NEEDS-INPUT + SHADOW GATE.**
A text-only model reply becomes `needs_input` and routes to a person as a question;
it is never stamped `done`. The definition-of-done checker turns on in **shadow
mode** (logs what it would block) until calibrated, then flips to enforce.

**N4 — Escalations: ONE SURFACE, REJECT = AN ANSWER.**
Merge the Approvals inbox and Workbench Exceptions into a single queue. Every
decision on a blocker must resolve to a recorded disposition — answer, cancel with
reason, or reroute — and that ruling flows back into the DE's work so it resumes.
Silent rejection becomes structurally impossible.

**N6 — Stall budgets: TIGHTER.**
Work waiting on a human **24 hours** → automatic re-escalation with the deadline
attached. **12 wakes** with zero progress → ops alarm plus a flag on the workforce
board. Recurring daily jobs inherit yesterday's stuck objective instead of minting a
duplicate. (Founder chose tighter than the recommended 48h/24-wake default —
appropriate while trust is being established.)

## Wave 2+ — scope and policy (decided)

**N2 — External write scope: STAGED, record → notify → money.**
Build write capability in trust order: (1) the DE's own record and CRM stage/notes,
(2) customer-facing notices, (3) anything touching invoices or money — each with its
own approval gate. Money arrives last.

**N5 — Communications: NOT YET.**
No email go-live at this time. The internal renewal motion ships without channels;
DE work stops at "draft prepared and priced" and a human carries it out of the
building.

**N8 + reconciliation — Renewal pricing: FULL CYCLE, HUMAN DELIVERS.**
The founder chose full-cycle including invoicing (N8), then — with channels deferred
under N5 — resolved the collision: **the DE computes the uplift, drafts the notice,
and creates the invoice record; a person delivers both.** The $8,400 Lakeshore uplift
is captured and the internal record is complete, with every outbound touch human
until channels open. Note the interaction with N2: the invoice-creation half sits in
the *last* write stage, so it lands after record and notify capability.

**N7 — Approvals ledger: BLOCK + INVESTIGATE.**
Add a database guard so approvals can only be decided through the proper path
(recording who, when, why); make deletion of undecided approvals impossible; and
**identify what performed the 23-task backstage sweep before designing around it**
(actor currently unknown — the investigation is a prerequisite, not a follow-up).

## Carried from docs/37 (decided)

**D1 — Uncertified active employees: PROVISIONAL.**
Queue DEs (Renewal, Ledger, Onboarding, Account Success) are marked provisional —
visible on their file, still working — and certified properly once per-role exams
exist. No employee is credited with a certification it never earned.

**D3 — What good work means (renewal): OUTCOME-WEIGHTED.**
Primary metrics: revenue retained, renewals closed on time. Secondary: notice
deadlines never missed, uplift captured where contractual, cases recorded at close.
This is what the performance tab and KPI catalog rows must compute.

**D4 — Trust dial (renewal): RECORDS ALONE, MONEY APPROVED.**
The DE may update its own case record and log activity unattended. Anything
customer-facing or financial — notices, quotes, invoices — requires a person.
Consistent with its `supervised` trust level and N2's staged order.

**D5 — Improvement remedies: BROADER FIXES, HUMAN-APPROVED.**
The learning loop may propose configuration changes, procedure edits, connector
requests, and knowledge articles — each still requiring approval before taking
effect. The proposal surface widens; the governance gate does not move.

**D6 — Eval-gate scope: PER-ROLE GATES.**
Each role's improvements are gated by that role's own exam. A support failure no
longer freezes renewal or accounting learning. Requires per-role exams, which the
simulation-certification work needs regardless.

**D7 — The 18 standing exceptions: FIX THE PATH, THEN RULE.**
Ship the human-answer return path first (build item 2), then rule on all 18 and
watch the work actually resume. Ruling before the plumbing exists would repeat
July 22, when four decisions changed nothing.

**D2 — SUPERSEDED by N1** (see above).

---

## Resulting build order

| Wave | Items | Gated by |
|---|---|---|
| **1** | Grounded desk (keystone) · human-answer return path · completion integrity (shadow) · wake loop with intervention authority + 24h/12-wake budgets | N1, N3, N4, N6 — all decided |
| **1b** | Approvals-ledger guard + backstage-writer investigation | N7 — investigation first |
| **2** | Work memory spine · per-archetype performance + KPIs (outcome-weighted) · renewal trust dial · provisional certification labels | D3, D4, D1 |
| **3** | Executable procedures · per-role exams → per-role eval gates · broader improvement remedies | D6, D5 |
| **4** | External writes staged record → notify → money; invoice creation lands here | N2, N8 |
| **Deferred** | Email/channel go-live | N5 — revisit when the founder chooses |

## Consequences accepted, stated plainly

- With N5 deferred, **no renewal notice reaches a customer** in waves 1-3; the DE's
  best outcome is a priced, drafted notice and a created invoice awaiting a human.
- The Aug 15 Lakeshore notice deadline **will not be worked by the machine** unless
  wave 1 lands and its exception is ruled before then (18 days from this decision).
- Under D1, provisional status becomes **visible on employee files** — an honest
  downgrade of what those files claim today.
- Under N3's shadow mode, existing hollow "done" work stays displayed as done until
  the gate flips to enforce; the flip is a separate, deliberate act.

---

*Decisions recorded from the founder's answers on 2026-07-28. Evidence for every
question: docs/38 (execution layer) and docs/37 (measurement organs).*
