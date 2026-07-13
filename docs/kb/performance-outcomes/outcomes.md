---
title: The Outcomes report — what your workforce actually delivered
category: Performance & Outcomes
feature: Outcomes
audience: admin
difficulty: intermediate
tags: [outcomes, ROI, business value, delivery, risk posture, KPIs, economics, FTE]
---

# The Outcomes report — what your workforce actually delivered

## What it is
**Outcomes** is the single, consolidated results report for your live workspace. It rolls up everything your Digital Employees did into four business lenses — **Business value**, **Delivery**, **Risk posture**, and **Work in flight** — using only real, tenant-scoped data. Where there isn't yet evidence for a number, it shows a dash rather than a guess.

## Why it matters
Performance tells you how *good* each DE is. Outcomes tells you what that *added up to* for the business: hours saved, cost, ROI, which teams are hitting their targets, and where risk is building. It's the page you'd take into a leadership review.

## Before you start
- Outcomes is a **live-workspace** surface. In a demo workspace it shows a short note and keeps the per-area preview pages instead.
- The counts and AI cost are real from day one. The money lenses — savings, ROI, FTE equivalent — need you to set your **workforce baselines** first (see below). Until then those tiles honestly show a dash.

## Step by step
1. Open **Outcomes** from the sidebar.
2. Read the four sections top to bottom; each is described below.
3. If you see the amber note *"Savings and ROI need your workforce baselines…"*, click **configure them on the workforce page** and set the baseline figures. Counts and AI cost above stay real regardless.
4. Use the **Work in flight** tiles at the bottom to click straight through into the relevant Company Data pipeline.

## Options & settings — the four lenses

### 1. Business value (last 30 days)
The economic rollup:
- **Work handled** — inquiries + actions + conversations, with the breakdown beneath.
- **Hours saved** and **FTE equivalent** — derived from your configured baselines.
- **AI cost** — real dollars spent on the DEs this period, plus the all-time total.
- **Monthly saving** and **ROI** — the DE cost measured against the equivalent human cost. Shown green when positive; shown as a dash until baselines exist.

### 2. Delivery (grouped by department)
A table of every active DE grouped by their **department** — the same grouping your guardrail scoping uses. For each DE you see **Health**, **Decisions**, **Resolution**, **Confidence**, **CSAT**, and **KPIs met**. KPI targets are the ones registered on each employee's profile; if none are set, the row reads *"No KPI targets set yet — add them on each employee's profile."*

### 3. Risk posture (last 30 days)
Four risk tiles:
- **Guardrail interventions** — how many actions your rules gated or blocked.
- **High-frustration inquiries** — how many were routed to a human.
- **Employees needing attention** — DEs flagged degraded, low-confidence, high-cost, or with an active incident (named individually).
- **Eval regressions** — recent Proving Ground runs that had failures, listed line by line.

### 4. Work in flight
Live counts pulled straight from your business records — **Open pipeline**, **Onboarding projects**, **Open tickets**, **At-risk accounts**, **Renewals due** — each a button that drills into the matching Company Data pipeline.

## Tips & best practices
- **Set your baselines early.** Without them, the most persuasive numbers (savings, ROI, FTE) stay blank. They live on the workforce page and take a minute.
- The **Delivery** grouping follows each DE's department field. Keep departments tidy and this report organises itself.
- Treat **Employees needing attention** and **Eval regressions** as your weekly to-do list — both link out to where you can act.

## Troubleshooting
- **Savings / ROI / FTE show "—".** Baselines aren't set. That's the honest default, not an error — configure them on the workforce page.
- **A DE is missing from Delivery.** Retired and archived DEs are excluded by design; only active employees appear.
- **Guardrail count doesn't map to a named DE.** Events from a since-renamed DE are still counted tenant-wide; they just can't be attributed to a current name.

## Related articles
- [performance-dashboard](performance-dashboard.md)
- [insights](insights.md)
- [proving-ground-evals](proving-ground-evals.md)
- [../company-data/customer-pipelines](../company-data/customer-pipelines.md)
