---
title: Approvals & Drafts — your human command queue
category: Tasks & Approvals
feature: Human Tasks
audience: admin
difficulty: beginner
tags: [approvals, drafts, human tasks, review, escalation, override, action approval]
---

# Approvals & Drafts — your human command queue

## What it is
**Approvals & Drafts** (labelled that in the sidebar, titled **Human Tasks** on the page) is the single queue where every decision a Digital Employee needs a human to make lands — approvals, reviews, escalations, overrides, drafted replies awaiting sign-off, and checklists. It's your command desk over the AI workforce.

## Why it matters
Trust-before-automation is the whole point: a DE can prepare a renewal invoice, draft a customer reply, or flag an at-risk account, but a person stays in control of anything that leaves the building or crosses a threshold. This queue is where that control happens, with the DE's reasoning shown so you can decide quickly and confidently.

## Before you start
- This is a **live-workspace** queue backed by real tasks. A new workspace shows an honest empty state: *"No human tasks yet"* — tasks appear when a DE actually needs a decision (e.g. approving a renewal invoice over a threshold).
- The sidebar shows a **pending** badge (e.g. "3 pending") so you know when something's waiting.

## Step by step
1. Open **Approvals & Drafts** from the sidebar.
2. Read the stats strip: **Pending**, **Stalled work**, **Decided**, and **Approval rate**.
3. Filter the list with the chips — **All**, **Approvals**, **Reviews**, **Escalations**, **Overrides**, **Feedback**, **Checklists** — or toggle **⏱ Stalled work only** to see items that have gone quiet past their threshold.
4. Click a task to open its detail panel: its **Source** (Digital Employee, DE chat, or Staleness watchdog), when it was raised, and any linked record.
5. Decide. For most tasks that's **Approve** or **Reject**. For a drafted outbound action you'll see the full draft first (see below). For a **checklist**, tick every item, then **Mark complete**.

## Options & settings — task types
Each task carries a type badge:
- **APPROVAL** — a DE crossed a gate (e.g. an invoice above a set amount) and needs sign-off.
- **REVIEW** — a DE produced something (like a drafted KB article) that needs a human read before it's used.
- **ESCALATION** — the DE couldn't resolve it confidently, or the customer asked for a human. Escalations raised from the DE chat dock are tagged **via DE chat** and carry the transcript.
- **OVERRIDE** — the DE is asking to exceed a rule (e.g. a discount above the template limit).
- **ACTION** — a drafted outbound action, like a customer reply. See the draft flow below.
- **CHECKLIST** — a set of items to tick off; the Approve button stays disabled until all are done.
- Plus **FEEDBACK**, **INQUIRY**, and **KNOWLEDGE** items surfaced for a human.

## Reviewing a drafted reply (action approval)
When a DE has drafted something to send, selecting the task loads the **full draft** — not a truncated preview. The panel shows **what will be sent / changed on approval**: the action, a summary, and the complete draft body. The approve button reads **Approve & send** or **Approve & execute** so it's unmistakable that clicking it acts in the outside world. Nothing goes out until you approve.

## The Stalled work badge
A background watchdog flags items that have gone quiet too long — even if *nothing* happened rather than a DE raising them. Warning-tier items show **⏱ STALLED**; past the breach threshold they show **⏱ STALLED · OVERDUE** in red. Use the **Stalled work only** toggle to triage them.

## Tips & best practices
- Clear **red / overdue** and **escalation** items first — those are time-sensitive or customer-facing.
- Read the DE's **reasoning and confidence** in the detail panel before approving; that's exactly what it's there for.
- Every decision is timestamped and recorded — approving a renewal invoice, for instance, sends it to the customer, so treat approve as a real send.

## Troubleshooting
- **"No human tasks yet."** Genuinely nothing is waiting — expected for a new workspace. The empty state links you to Renewal & Expansion to generate real work.
- **Stalled badges are missing.** The staleness watchdog is a best-effort overlay; if its migration isn't applied the task list still works, just without the badges.
- **I can't approve a checklist.** Tick every item first — the button is intentionally disabled until the checklist is complete.

## Related articles
- [human-in-the-loop](human-in-the-loop.md)
- [activity-log](activity-log.md)
- [../company-data/customer-pipelines](../company-data/customer-pipelines.md)
