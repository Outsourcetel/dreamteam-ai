---
title: Proving Ground — grading a Digital Employee with golden Q&A
category: Performance & Outcomes
feature: Proving Ground
audience: admin
difficulty: intermediate
tags: [proving ground, evals, golden qa, certification, publish gate, confidence floor]
---

# Proving Ground — grading a Digital Employee with golden Q&A

## What it is
**Proving Ground** is your Digital Employee's exam. You write **golden questions** — questions you already know the right answer to — and Proving Ground asks them to the *live* DE, then grades each answer. A passing run certifies the DE; a failing run gates knowledge publishing until it's fixed.

## Why it matters
It's the difference between hoping your DE is right and *proving* it. Because the questions run against the real answer path (the same one customers hit), a passing run is genuine evidence — not a simulation. And because a failed run blocks publishing, it stops a bad knowledge change from reaching customers.

## Before you start
- You need at least one **active** golden question to run an eval (there's a cap of 50 per run).
- Grading needs the DE's "brain" (the AI engine key) to be active. If it isn't, runs finish honestly as **Blocked — brain dormant**: the suite reached the live DE and stopped at the AI gate. Nothing is faked. See [../settings-billing/ai-engine-keys](../settings-billing/ai-engine-keys.md).
- Generating the starter suite needs at least one document in **Knowledge → Library**.

## Step by step
1. Open **Proving Ground** from the sidebar.
2. Build your suite:
   - Click **Generate 5 starter questions** to seed honest, fully-editable templates from your knowledge document titles, or
   - Click **+ Add question** / **Write my own** to author one yourself.
3. For each question set: the **Question** (asked to the live DE), the **Expected fragments** (comma-separated — the answer must contain *all* of them, case-insensitive), the **Confidence floor** (a slider, 0–100%), and a **Category**.
4. Toggle questions **Active** / **Off** to control what's included.
5. Click **Run evals (N)** — N is the active count. The run asks the live DE each question and grades it in real time.
6. Read the **Latest run** panel: each question shows **PASS** or **FAIL**, the DE's confidence, a snippet of its actual answer, and the grading reason.
7. Review **Run history** below for past runs; click **Detail** on any row to expand its results.

## Options & settings
- **Expected fragments** — the grader (v1) checks that the DE's answer contains every fragment, case-insensitively. Keep them short and load-bearing (e.g. `30 days`, `full refund`), not whole sentences.
- **Confidence floor** — the answer must *also* clear this confidence level to pass. Use it to fail answers that are technically right but hedged.
- **Category** — tag each question as **knowledge**, **procedure**, **guardrail**, **escalation**, or **calibration** so a suite can cover more than just facts.

## How a pass certifies a DE (the publish gate)
The result of the last run becomes a **gate**:
- **Passed** — the DE is certified against your suite; publishing proceeds normally.
- **Failed** — a red banner appears (*"Publishing gated — last eval run failed X/Y"*). Knowledge publishes will ask for an explicit override until a run passes. Fix the failing answers or update the suite, then re-run.
- **Blocked — brain dormant** — the suite is ready and will grade automatically once the AI engine key is set.

## Tips & best practices
- Seed with **Generate 5 starter questions**, then edit them into real exam questions — the generated ones are honest placeholders, not graded truth.
- Add a **guardrail** question (e.g. something the DE should *refuse*) and an **escalation** question so you're testing judgment, not just recall.
- Re-run after any significant knowledge change. Insights will also surface a failing run as a **Proving Ground** signal.

## Troubleshooting
- **"No active golden questions."** Add some (or generate the starter suite) and make sure they're toggled **Active**.
- **Run shows "Blocked — brain dormant."** The AI engine key isn't set — grading can't execute. The run genuinely reached the live DE; nothing was simulated.
- **"Workspace still provisioning."** The eval tables haven't been created yet for this workspace; apply the Proving Ground migration and reload.
- **Honest limits:** the grader is fragment-matching + confidence (LLM-judge grading is a planned upgrade), and the publish gate is currently a client-side soft gate (a server-side hard gate is a planned hardening step).

## Related articles
- [insights](insights.md)
- [../knowledge/library](../knowledge/library.md)
- [performance-dashboard](performance-dashboard.md)
