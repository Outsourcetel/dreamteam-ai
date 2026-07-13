---
title: Self-Learning — turning human corrections into improvements
category: Knowledge
feature: Self-Learning
audience: admin
difficulty: advanced
tags: [self-learning, corrections, overcaution, guardrails, human-review, patterns]
---

# Self-Learning — turning human corrections into improvements

## What it is
The **Self-Learning** page watches for places where a person keeps correcting or overriding the same kind of decision a Digital Employee made, groups those into a **pattern**, and proposes a concrete policy change for you to review. It learns from what your team actually does, not from a survey or a manual "tell us what went wrong" form.

## Why it matters
Every time a human steps in to fix a DE's decision, that's a signal. One correction is noise; the same correction happening over and over is a pattern worth acting on. Self-Learning surfaces those patterns and proposes a real, enforceable change — so your DEs get measurably better instead of repeating the same mistake.

## The two kinds of pattern
Self-Learning distinguishes two opposite problems, and never mixes them in one pattern:

- **Correction** — a human repeatedly **rejected** the DE's answer, meaning the DE was **wrong**. Approving the proposal creates a **new guardrail rule** that blocks that kind of answer going forward.
- **Overcaution** — a human repeatedly **approved** something the DE flagged for review, meaning the DE was **needlessly cautious** against the same rule. Approving the proposal **loosens or removes** that specific guardrail rule.

## How it works
This runs **automatically, roughly every 5 minutes**, and mirrors the Gap Detection loop:

1. **Signal.** It reads real review decisions from your Human Tasks queue — where a human rejected (correction) or approved (overcaution) a DE decision.
2. **Clustering.** Similar decisions are grouped by meaning into a pattern for a single DE.
3. **Promotion.** Once a pattern crosses your configured minimum size within the time window, it's promoted to a **proposal** awaiting review.
4. **Human review.** You approve or reject. Approving applies the guardrail change immediately.
5. **Recurrence check.** If a resolved pattern starts recurring, it reopens with higher severity — the fix may not have held.

## What you'll see on the page
Open the **Self-Learning** page. A strip shows the loop: **Pattern detected → Proposed for review → Resolved**, with a note of how many patterns are corrections versus overcautions.

The table lists each pattern with the representative decision, the affected **DE**, the **Verdict** (Correction or Overcaution), the number of **Members**, a **Severity**, and a **Status** (Open, Proposed — awaiting review, or Resolved).

## Step by step — review a proposal
1. Click a pattern to open its detail panel.
2. Read **Signal — the decisions behind this pattern**: the real decisions that make up the cluster.
3. Read **Proposed change**:
   - For a **Correction**, it proposes a new guardrail rule with a suggested pattern to block. **Edit the pattern** in the box before approving so it's neither too broad nor too narrow.
   - For an **Overcaution**, it names the existing rule that's proven too strict. Approving without changes deactivates it — or you can type a narrower pattern to tighten it instead of removing it.
4. Click **Approve** or **Reject**.
   - **Approve** applies the guardrail change **immediately, for every Digital Employee** — there's no retraining delay.
   - **Reject** reopens the pattern to keep accumulating for the next pass.

## Honest empty state
A new or lightly-used workspace shows **"No learned-behavior patterns yet."** This is expected: the feature depends on real human review decisions accumulating over time. Until your team has corrected or overridden enough similar DE decisions, there's nothing to cluster — and the page won't invent anything to look busier than it is.

## Tips & best practices
- Always review the proposed pattern before approving — a guardrail that's too broad can block legitimate answers.
- Prefer **narrowing** an overcautious rule to deleting it outright, unless you're sure the rule is wrong.
- Watch resolved patterns for recurrence. A pattern that comes back means the change didn't address the real cause.
- Self-Learning changes your **guardrails**, which is why every change is human-gated and takes effect platform-wide.

## Troubleshooting
- **Nothing appears even though DEs make mistakes** — patterns only form from *human review decisions* in the Human Tasks queue. If those aren't being made, there's no signal to learn from.
- **A pattern shows Open, not Proposed** — it hasn't yet reached the minimum cluster size; the panel shows how many more similar decisions are needed.
- **An approved change had an unexpected effect** — review the guardrail it created or loosened on the Guardrails page and adjust the pattern.

## Related articles
- gap-detection
- quality-and-coverage
- how-knowledge-powers-your-des
