---
title: The "DE at Work" Activity View
category: Digital Employees
feature: Workforce / DE at Work
audience: admin
difficulty: intermediate
tags: [DE at work, activity, proactive triage, evidence, reasoning, simulate]
---

# The "DE at Work" Activity View

## What it is
**DE at Work** is a live queue showing your Digital Employees noticing, evaluating, and acting on work across every connected system — with the **evidence and reasoning** behind each decision, not just a status dot.

## Why it matters
It's the window into what your employees are actually doing on their own. Instead of a spinner, you see each item the employee picked up, what it decided, why, and — when it acted — a receipt of what really happened. This is how you supervise proactive work with real visibility.

## Before you start
Open **DE at Work** from the navigation. If you see a "Workspace still provisioning" notice, the underlying tables aren't applied yet. The queue watches every connected category, so you'll only see real runs once employees have systems connected and are at an operational lifecycle stage.

## What you see
Each card in the queue represents one run and shows:

- The **inquiry** or item the employee evaluated.
- A **category** chip (which connected system category it came from).
- A **source** chip: *Human-invoked*, *Automatic — noticed on its own*, or *Simulation (demo/test)*.
- A **decision** chip:
  - **Would auto-send** — it would send an answer automatically.
  - **Needs review** — it routed the item to a human.
  - **Blocked by guardrail** — a guardrail stopped it.
  - **No access** — it lacked a grant to act.
  - **Would act — awaiting approval** — it intends to take an action, pending approval.
  - **Acted** — it really did something in the outside world (styled distinctly, because this is real).
- A **confidence** chip.
- **Why** — the employee's plain-language reasoning for the decision, and a note if a human review task was created.
- When it acted: a **receipt** of what actually happened (or what the action will do, if awaiting approval).
- **Show evidence steps** — expand to see how the employee gathered evidence, step by step: account configuration, knowledge, past cases in an external system, its own prior experience, MCP tools, and the final evidence bundle. Systems that aren't connected are skipped honestly, never faked.

## The honest limits
This is stated plainly on the page:

- **"Would auto-send"** and **"would act"** record **intent only**.
- A decision only becomes **"Acted"** when a registered action exists for that item's category *and* the trust and guardrail rules clear it for real execution.

So the queue distinguishes cleanly between an employee *deciding* it would do something and it *actually* doing it.

## How it updates
- The page **refreshes every 8 seconds** on its own; the timestamp shows the last update.
- Automatic triage of real work runs **every 5 minutes** via the platform's dispatch schedule.

## Simulate an incoming inquiry
To watch the mechanism run immediately without waiting for real data, type an example inquiry into **Simulate an incoming inquiry** and click the button. Simulations are clearly tagged as such — both on the card and in the audit trail — and are never conflated with real automatic triage. It's a demo and test aid.

## Tips & best practices
- Read the **Why** on "Needs review" and "Blocked by guardrail" cards — that's where you learn whether the employee is reasoning soundly or where knowledge/guardrails need adjusting.
- Use the simulator when onboarding a new employee to see how it triages before real volume arrives.

## Troubleshooting
- **No runs yet** — resolve an inquiry from the Technical Specialist, or simulate one. Real automatic runs need connected systems and an operational employee.
- **Everything says "No access"** — the employee lacks the required grant on that system category; grant it under **Governance → Data Access**.

## Related articles
- how-a-de-answers-questions
- the-trust-dial
- the-specialist-desk
- the-de-lifecycle
