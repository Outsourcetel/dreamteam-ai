---
title: Acting on Insights — anomalies, guardrail drift, and eval failures
category: Performance & Outcomes
feature: Business Insights
audience: admin
difficulty: intermediate
tags: [insights, anomaly, config drift, guardrail, eval failure, signals, monitoring]
---

# Acting on Insights — anomalies, guardrail drift, and eval failures

## What it is
**Insights** (labelled **Insights** in the sidebar) is your workforce's early-warning feed. Instead of making you read every chart, it surfaces the handful of real signals that actually need attention — escalation spikes, guardrail activity, and Proving Ground failures — each with a link to the page where you fix it.

## Why it matters
Problems in an AI workforce rarely announce themselves. A DE slowly gets worse; a guardrail gets overridden a few too many times; an eval quietly starts failing. Insights watches for those patterns from real data so you notice in days, not at quarter-end.

## Before you start
- Insights is computed live. Every card comes from real signals — there's no seeded or illustrative content on the live page.
- With a healthy, quiet workspace you'll see an honest empty state: *"No anomalies, guardrail overrides, or Proving Ground failures in this period — nothing needs attention right now."* That's a good result, not a missing feature.

## Step by step
1. Open **Insights** from the sidebar.
2. Scan the **trend cards** at the top — one per DE, showing the change in resolution rate over the tracked weeks (green up, red down).
3. Work through the signal feed beneath. Each card is tagged by type and links to where you act.
4. Click the card's action button (e.g. **Open Compliance & Guardrails →** or **Open Proving Ground →**) to go straight to the fix.

## Options & settings — the three signal types

- **ANOMALY** (red) — a genuine week-over-week jump. Insights compares this week's escalation rate against the trailing average of prior weeks in the same real trend data, and flags a DE whose escalations spiked. The card states the exact numbers, e.g. *"Escalation rate 34% the week of [date], up from a 19% trailing average."*
- **CONFIG DRIFT** (amber) — real guardrail activity in the last 30 days: how many actions were **gated** versus **blocked** for a given DE. Repeated overrides are the classic sign that a rule is either too tight or being routinely worked around. Links to **Compliance & Guardrails**.
- **PROVING GROUND** (blue) — a recent eval run that had failures, showing how many of how many scenarios failed and when. Links to **Proving Ground**. (Eval runs aren't yet attributed to a single DE, so these are tenant-wide.)

## Tips & best practices
- Start with **red anomaly** cards — a real escalation spike usually traces back to an open knowledge gap or a broken connector. Fix the cause, and resolution recovers.
- Recurring **config drift** is a decision, not just an alert: either loosen the rule (if every override is being approved anyway) or tighten the playbook that keeps hitting it.
- A **Proving Ground** signal means your DE's exam started failing — treat it as a release blocker and open Proving Ground to see which questions broke.
- Check Insights on a regular cadence (weekly is plenty). It's designed to be short: if it's empty, you're done.

## Troubleshooting
- **Insights is empty but I expected signals.** Anomaly detection needs at least two weeks of trend data to compare; guardrail and eval signals only appear when those events actually happened. A quiet, new, or healthy workspace legitimately shows nothing.
- **A guardrail card says activity "couldn't be matched to a currently-named Digital Employee."** The events are real but came from a DE that's since been renamed — they're still counted, just not attributed.

## Related articles
- [performance-dashboard](performance-dashboard.md)
- [outcomes](outcomes.md)
- [proving-ground-evals](proving-ground-evals.md)
- [../governance/guardrails-and-compliance](../governance/guardrails-and-compliance.md)
