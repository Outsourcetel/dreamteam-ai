# 48 — Triage of the 64 pending tasks (outsourcetel-hq, 2026-08-09)

**Nothing here was decided.** Deciding a task requires a signed-in person, which
is the correct gate. This classifies them so the queue can be cleared in a
handful of actions instead of sixty-four, and every verdict was checked against
**current system state**, not against the ticket.

**64 = 59 escalations + 4 action approvals + 1 knowledge revision.** They
collapse to **six root causes**, and only **one** is a genuine question waiting
on you.

---

## The one real decision

**8 tasks · Account Success DE · Grant Plastics and West View Software.**

`customer_account_contacts` holds **zero rows for every account in the
workspace**. Not a retrieval bug — the table is empty, the ERPNext sync ran today
(last OK 18:30) and brought nothing because the source has nothing. The employee
was telling the truth and correctly refused to invent a name.

> **Who is the human being at each of these two companies?**

- **(a) Put them in ERPNext** — best: the sync pulls the contact into the book
  *and* onto the invoice, so this clears **and** the overdue-invoice reminders
  start reaching a person.
- **(b) Type them into DreamTeam** — faster, but dunning reads the address off
  the invoice, so those approvals still reach nobody.
- **(c) Archive the accounts** — both show 0 ARR, no CSM, no renewal date. The
  money is still owed either way.

⚠ **A real bug alongside it:** no writer sets a contact's `role`, and the
employee asks for `executive_sponsor` while the CHECK vocabulary says
`exec_sponsor`. Add contacts and it can still re-escalate with the same words.

---

## Already fixed — the queue is echoing a stored status

**~24 tasks · Accounting DE and Onboarding DE.**

Both said "no source is connected". Both sources are now connected and full:
**48 balanced journal entries** (debit = credit, imbalance 0.00; 24 this month),
`ledger-sync-hourly` **17 runs, zero failures**, and `get_de_worklists` now
returns `book_is_empty = false` — not NULL.

**So why are they still pending?** `reviewObjective`
(`de-work/index.ts:319-345`) builds its entire picture from stored
`de_work_items` rows — status, title, age — and **never re-reads the book**. A
step frozen at `waiting_human` is never re-attempted. An escalation raised at
12:50 said *"waiting for human action for 13 hours"* — **eleven hours after the
data landed.**

That is the project's recurring trap in a new costume: *a stored marker read as
current truth.*

---

## Already done, and the ledger didn't notice

**22 tasks · two invoices · $85,000.**
`ACC-SINV-2026-00006` (Grant Plastics, 34 days) and `ACC-SINV-2026-00008`
(West View, 30 days).

Four payment reminders against these invoices were **approved by a human and
actually executed** — twice on Aug 4, twice on Aug 5. The cadence linkage never
advanced, so the employee keeps proposing the same reminder. The 18 escalations
and 4 approvals are **one commercial decision, asked repeatedly**.

The decision is still yours: escalate to formal dunning, or stop chasing.

---

## Not questions at all — machinery

**39 tasks.**

**One malformed task.** The model wrote its `mark_done` call as *prose* instead
of a tool call. `de-work/index.ts:1475` decides "the employee asked a question"
purely from `tool_use.length === 0` and never inspects the text — so a **finished
job was filed as a question**, and the work item stuck at `waiting_human` pinned
its goal `blocked` forever. The receivables book *was* opened; the figures are
corroborated by an independent memory row.

**38 "Goal blocked" — 18 objectives.** The per-wake duplicate was fixed this
morning (`5c771fd`) and is **proven live**: on 2026-08-09 the runtime refreshed
15 existing tasks and inserted **0** duplicates. That converted *quadratic*
growth into *linear*. It did not stop it:

- **20 stale superseded copies** remain — frozen pre-fix snapshots, safe to close.
- **~3 new per day** still accrue, because the dedupe keys on the *objective id*
  while the recurring drivers mint a **new objective every day**.
- `reconcile_blocked_goals` runs **48×/day and has cleared nothing** — it abstains
  whenever `n_waiting > 0`, and all 18 objectives have exactly one stuck item.

Left alone: ~85 pending in a week. Without this morning's fix it would have been
~248.

---

## What to do

**You (2 actions):** name a contact for Grant Plastics and West View — in
ERPNext if you can. Decide whether the $85k gets formal dunning.

**Safe to close without reading (21):** the 20 superseded duplicates and the 1
malformed task. Neither contains a question.

**Code, in dependency order — this is what stops it refilling:**

1. **Re-measure, don't echo.** `reviewObjective` must re-read the book before
   reporting a goal blocked. Without this, fixing a blocker never clears its
   queue.
2. **Parse a tool call out of prose** before treating it as a question — a
   finished step must not become a permanent blocker.
3. **Give `reconcile_blocked_goals` an age ceiling**, or teach it to distinguish
   "waiting on a human who has been asked" from "waiting forever".
4. **Key the dedupe on the recurring driver**, not the objective id.

Items 1 and 4 are what turn the queue from self-refilling into finite.
