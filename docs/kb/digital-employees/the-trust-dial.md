---
title: The Trust Dial and Earned Trust
category: Digital Employees
feature: Workforce / Trust
audience: admin
difficulty: advanced
tags: [trust dial, autonomy, earned trust, promotion, demotion, guardrails]
---

# The Trust Dial and Earned Trust

## What it is
Two related controls at the bottom of every employee's profile:

- **Trust dial** — per-action autonomy you set directly (how far this employee is allowed to act without a human).
- **Earned trust** — an evidence-based ladder your workspace climbs as the DE proves itself, gated by a human at each step up.

## Why it matters
Autonomy is how much you let a Digital Employee do on its own. Too little and it's just a suggestion box; too much and it acts beyond what it's proven. The trust system lets you dial in autonomy per action, and — separately — earn wider autonomy from real measured evidence. The governing principle is **promote slow, demote fast**.

## The one rule that overrides everything
**Autonomy narrows within guardrails — it never overrides them.** Raising the dial can never authorize something a guardrail forbids. For example, an invoice auto-sends only when it passes **both** the guardrail approval threshold **and** the trust-dial limit. Guardrails always cap what's possible.

## The trust dial (per-action autonomy)
The dial has one card per action type:

- **Auto-send renewal invoices** — invoices at or under an amount you set send without a human gate (still within the guardrail approval threshold).
- **Answer in the dock unaided** — the minimum confidence for the employee to answer in the workspace dock without escalating.
- **Answer end-users via widget** — the minimum confidence for widget answers to end-users.

For each card you set **Enabled/Off** plus either a **max amount** or a **min confidence**, then click **Save**.

**Personal vs workspace default.** Each card shows a badge: **Personal** means the value is set for this employee specifically; **Workspace default** means the employee follows the shared workspace-wide setting. Set a value here and it applies to this employee only; leave a card untouched and the employee inherits the workspace default.

Some cards are marked **dormant until activation** — their value is stored now and enforced once the employee's answering brain is switched on.

Every dial change is recorded as a config-change event on the immutable audit trail.

## Earned trust (the promotion ladder)
The **Earned trust** panel is where autonomy is *earned* rather than simply set. Each action category has a level:

- **Human-gated (Level 0)** → **Level 1** → **Level 2** → **Level 3**

Each level widens what the dial can reach. For invoices: Level 1 up to $1,000, Level 2 up to $5,000, Level 3 up to $10,000. For answering: Level 1 confidence ≥ 90, Level 2 ≥ 75, Level 3 ≥ 60.

### How trust is earned
The panel shows the evidence for each category as progress bars, computed on the server from three real sources over a rolling window (30 days by default):

- **Evaluation results** — the Proving Ground pass rate (needs enough samples at a high pass rate).
- **Human review outcomes** — the approval rate on work the employee routed through the human gate.
- **A clean guardrail record** — no guardrail blocks in the window.

When every criterion is met, an **Eligible for promotion** badge appears and you can click **Request promotion to [next level]**. That sends a request to Human Tasks for a **teammate to approve** — the server re-verifies the evidence is still eligible at approval time and blocks self-approval before moving the dial up one level.

### Demotion is automatic
There's no human gate on the way down. A regression — a failed evaluation run below the floor, or a guardrail block — **drops the level automatically and immediately** (never below baseline), records the demotion on the audit trail, and creates an informational notice. That's "demote fast."

## Per-DE vs workspace, honestly
The **trust dial** is per employee: a value you set applies to that employee only, falling back to the workspace default otherwise. The **earned-progression ladder** is still **workspace-wide today**, not yet per employee — the personal dial can be set below or above it, but the ladder itself tracks evidence for the whole workspace. The panel states this plainly.

## What higher trust unlocks
Higher earned levels raise the ceiling the dial can be set to — larger auto-send amounts, lower confidence floors for answering unaided. It never removes guardrails or the approval gates; it widens the band of autonomy *inside* them.

## Tips & best practices
- Let trust be **earned** where you can — the earned path is the celebrated one and comes with an evidence trail. A manual dial raise above the earned level is allowed but is flagged as a **Manual override** (and is still guardrail-capped).
- Watch the Incidents panel: guardrail blocks and demotions land there and directly affect eligibility.

## Troubleshooting
- **Promotion request rejected** — the server recomputed evidence and the criteria aren't met; the progress bars show which.
- **"Manual override" badge** — you set the dial above the level the employee has earned. Still capped by guardrails; consider earning the level instead.

## Related articles
- how-a-de-answers-questions
- the-de-lifecycle
- de-at-work-activity
- managing-de-lifecycle-changes
