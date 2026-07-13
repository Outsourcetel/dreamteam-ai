---
title: Reading the Performance dashboard
category: Performance & Outcomes
feature: Performance Analytics
audience: admin
difficulty: beginner
tags: [performance, resolution rate, confidence, escalation, error rate, cost, tokens, CSAT]
---

# Reading the Performance dashboard

## What it is
**Performance** (in the sidebar under your workforce views, labelled **Performance**) is the org-level scorecard for your Digital Employees. It shows, per DE, how much work they handled, how well they handled it, what it trended toward, and what it cost — all from real activity, not estimates.

## Why it matters
This is where you answer "are my Digital Employees actually good at their jobs, and is it worth it?" Every number is a live, tenant-scoped count from your own DEs' decisions, so you can spot a DE that's slipping, catch a rising escalation rate before it becomes a backlog, and see the real AI cost behind the work.

## Before you start
- You need at least one Digital Employee. With none, the page says plainly: *"No Digital Employees yet — add one under Workforce to start seeing real performance data here."*
- Numbers only appear once a DE has actually handled inquiries. A brand-new DE shows *"No real activity recorded yet"* until it does real work.

## Step by step
1. Open **Performance** from the sidebar.
2. The header tells you the scope — how many DEs and how many inquiries were handled this period.
3. Read the **Live usage (this month)** strip at the top: real counters recorded per inquiry — **Inquiries**, **Cache hits**, **Escalations**, and **LLM calls**.
4. If any AI spend has been recorded, the **Real AI usage cost** banner shows total dollars across all LLM calls this period.
5. Read each DE's scorecard (see below).
6. Scroll to **Customer satisfaction (CSAT)** at the bottom for real thumbs-up/down ratings per DE.

## Options & settings
Each per-DE scorecard shows:

- **Resolution rate** — the headline number: the share of inquiries the DE resolved without escalating. Colour-coded green (≥85%), amber (≥70%), or red below that.
- **Trend sparkline** — a small week-by-week line of the resolution rate so you can see direction at a glance (labelled, e.g., "6-week trend").
- **Confidence** — the DE's average self-assessed confidence in its answers.
- **Escalation** — the share of inquiries handed to a human. Lower is better; it turns amber above 12% and red above 20%.
- **Error rate** — the share of decisions that failed. Amber above 4%, red above 10%.
- **Frustration** — the average detected customer-frustration score. High-frustration inquiries are auto-escalated to a human, and the card notes how many were.
- **Inquiries this period** and **cost per call** — volume and the real dollar cost per LLM call for that DE.

The **Customer satisfaction (CSAT)** panel lists each DE's satisfaction percentage and how many ratings it's based on. It reads *"No ratings submitted yet"* until customers actually rate answers.

## Tips & best practices
- Watch the **trend sparkline**, not just today's number. A DE sitting at 79% but climbing is healthier than one at 85% and falling.
- A rising **escalation rate** with a falling **resolution rate** usually points at a knowledge gap — check **Insights** and **Knowledge → Gap Detection**.
- **Cost per call** lets you compare a cheap, high-volume Support DE against an expensive, specialist one honestly. The dashboard deliberately does **not** invent a "human cost saved" figure here — that comparison lives on **Outcomes**, and only once you've set your workforce baselines.
- Use **Profile →** on any card to jump to that DE's full profile.

## Troubleshooting
- **All cards say "No real activity recorded yet."** The DEs exist but haven't handled real inquiries. Send some work their way, or use **DE at Work** to simulate an inquiry.
- **The cost banner is missing.** It only appears once real token usage has been recorded. No calls yet means no cost line — that's honest, not a bug.
- **CSAT is empty.** Ratings come from the thumbs up/down on the support widget and portal chat. Until customers use it, there's nothing to show. See [measuring-csat](measuring-csat.md).

## Related articles
- [outcomes](outcomes.md)
- [insights](insights.md)
- [measuring-csat](measuring-csat.md)
- [proving-ground-evals](proving-ground-evals.md)
