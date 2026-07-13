---
title: The Digital Employee Lifecycle
category: Digital Employees
feature: Workforce / Lifecycle
audience: admin
difficulty: intermediate
tags: [lifecycle, stages, readiness criteria, advance, certify, governance gate]
---

# The Digital Employee Lifecycle

## What it is
Every Digital Employee moves through a chain of stages from setup to live work. The stage is not just a label — it's a **governance gate**. Proactive work (picking up inbox items, taking actions, running playbooks) is only allowed once an employee reaches an operational stage, and each step forward is checked against real criteria.

## Why it matters
The lifecycle stops a half-configured employee from acting on real work. It forces the setup to happen in the right order — identity, then access and knowledge, then testing, then a human sign-off — and it records every transition so you can see exactly when and why an employee went live.

## The eight stages
The forward chain is:

**Designed → Configured → Trained → Tested → Certified → Published → Assigned → Active**

Beyond the chain, an employee can also be **Improving** (an operational state while a development item is open), **Paused**, or **Retired**.

You see all of this in the **Lifecycle** panel on the profile: a stage ladder with completed stages ticked, the current stage highlighted, the criteria for the next stage, and a log of recent transitions.

## The readiness criteria for each stage
Each stage has exactly one predecessor and one set of entry criteria. Every criterion is a real signal in your workspace — nothing is fabricated. To reach:

- **Configured** — *Identity complete*: a name, a description, a department or workspace, and at least one responsibility.
- **Trained** — *Control Fabric grant* (at least one system-access grant), *knowledge in scope* (knowledge this employee can see), and *active guardrails* (active workspace guardrails).
- **Tested** — *Knowledge embedded*: the knowledge in scope is actually searchable (embedded), so answers can cite it.
- **Certified** — *Golden Q&A passed*: the latest golden Q&A evaluation run passed. (The suite is workspace-level today.)
- **Published** — *Certified by a human*: a named workspace owner or admin recorded certification.
- **Assigned** — *Has a work channel*: a searchable system grant (an inbox) or an active site widget key.
- **Active** — *First live execution*: at least one real piece of attributed work on record.

## How to advance an employee
1. Open the employee's profile and find the **Lifecycle** panel.
2. Under **To reach [next stage]**, check the criteria list — met criteria show a green tick, unmet ones an open circle. The **Advance** button stays disabled until every criterion is met.
3. Click **Advance to [stage]**.

Only **workspace owners and admins** can advance an employee's lifecycle, and the check is enforced on the server — you can't skip a stage or advance with criteria unmet.

### Certification is a human checkpoint
Advancing to **Certified** is special: you must type a **certification note** stating what you reviewed. The note and your identity are recorded — this step can't be automated away.

### Active happens on its own
The last step, **Assigned → Active**, is the one transition decided by observed fact rather than a human click. Once an assigned employee logs its first real execution, the platform activates it automatically (checked every 5 minutes) and records why.

## What each stage allows
- **Reactive Q&A** (the chat dock and the public widget) works from pre-launch stages — this is the platform's sandbox / proving ground, and it's already protected by guardrails, confidence thresholds, and escalation.
- **Proactive work** (inbox polling, claiming items, taking actions, running playbooks) requires **Assigned**, **Active**, or **Improving** — strictly. A pre-launch employee will not pick up real inbox work.

## Tips & best practices
- Follow the criteria in order — each stage's requirements build on the last.
- If **Advance** is greyed out, read the criteria list: it tells you exactly what's missing (e.g. no active guardrails, or knowledge not yet embedded).
- Write a real certification note. It's your audit record of what a human actually checked before this employee went live.

## Troubleshooting
- **"Entry criteria are not met yet"** — one or more criteria for the target stage are still open; the panel shows which.
- **Can't advance a paused employee** — resume it first (paused employees have their own controls).
- **Certify button disabled** — you haven't entered a certification note; it's required.

## Related articles
- creating-a-digital-employee
- configuring-what-a-de-knows-and-does
- the-trust-dial
- managing-de-lifecycle-changes
