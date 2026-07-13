---
title: The Activity Log and DE at Work — what your DEs did
category: Tasks & Approvals
feature: Activity
audience: admin
difficulty: beginner
tags: [activity log, DE at work, evidence, reasoning, audit, timeline]
---

# The Activity Log and DE at Work — what your DEs did

## What it is
There are two running records of DE activity in the app, and it's worth knowing which is which:
- **DE at Work** — the *live, real* per-employee stream showing each thing a Digital Employee noticed, evaluated, and did, with the reasoning behind every decision.
- **Activity Log** — an org-wide event stream. For a live workspace this org-wide feed is still a design preview; the real, live view of what your DEs are doing is **DE at Work**.

## Why it matters
You shouldn't have to take a Digital Employee's word for it. These views show the actual evidence and reasoning behind each decision — which knowledge it searched, which systems it checked, whether it acted or only intended to — so "the AI did something" becomes "here's exactly what it did and why."

## Before you start
- **DE at Work** is live and real. **Activity Log** (org-wide) in a live workspace shows an honest notice — *"This org-wide feed isn't built yet"* — and points you to DE at Work and the Audit Trail instead.
- For the immutable compliance record (who changed what, guardrail blocks), use the **Audit Trail** under Governance — that's the permanent record; DE at Work is the operational one.

## Step by step (DE at Work)
1. Open **DE at Work** from the sidebar.
2. The feed lists recent runs, newest first, and refreshes automatically every 8 seconds. Automatic triage across connected systems also runs on a schedule in the background.
3. Read each card: the inquiry, when it happened, the source category, and the DE's decision.
4. Click **Show evidence step(s) ▼** to expand the reasoning trail — account context, knowledge search, past-case checks, prior experience, tools used, and the final evidence bundle, each with an outcome (OK, skipped, failed, or blocked).
5. To watch the mechanism run on demand, type an inquiry into **Simulate an incoming inquiry** and run it — simulations are clearly tagged **SIMULATION — not a real ticket**.

## Options & settings — reading a decision
Each run shows the DE's decision as a chip:
- **Would auto-send** / **Would act — awaiting approval** — the DE decided what to do but is recording *intent* only.
- **Acted** — something genuinely happened in the outside world (styled solid green), with a **Receipt — what actually happened**.
- **Needs review** — routed to a human (a linked task appears in Approvals & Drafts).
- **Blocked by guardrail** / **No access** — a rule or a missing connection stopped it.

Each card also carries the source — **Human-invoked**, **Automatic — noticed on its own**, or **Simulation** — and the DE's confidence.

## Tips & best practices
- Use **DE at Work** to build trust in a new DE: watch a few real runs, expand the evidence, and confirm the reasoning is sound before you raise its trust level.
- The distinction between **"would act"** and **"Acted"** is deliberate — intent only becomes a real action when a registered action exists for that category and the trust/guardrail rules clear it. Don't read "would auto-send" as "sent."
- For anything you need as a formal, tamper-evident record, go to the **Audit Trail**, not this operational stream.

## Troubleshooting
- **Activity Log says it "isn't built yet."** That's the honest state of the org-wide feed in a live workspace. Open **DE at Work** for real per-employee activity, or the **Audit Trail** for the compliance record.
- **DE at Work is empty.** No evidence runs yet — resolve an inquiry from the Specialist Desk, or simulate one with the box at the top.
- **"Workspace still provisioning."** The proactive-triage tables aren't created for this workspace yet; apply the pending migration and reload.

## Related articles
- [approvals-and-drafts](approvals-and-drafts.md)
- [human-in-the-loop](human-in-the-loop.md)
- [../governance/audit-trail](../governance/audit-trail.md)
