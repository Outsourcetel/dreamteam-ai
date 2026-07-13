---
title: A Tour of the Digital Employee Profile
category: Digital Employees
feature: Workforce / DE Profile
audience: admin
difficulty: beginner
tags: [DE profile, identity, health, performance, incidents, panels]
---

# A Tour of the Digital Employee Profile

## What it is
The profile is the single page where you configure and inspect one Digital Employee. Open it by clicking any employee in the Roster. It's a scrolling page of panels, each one covering a different part of the employee's setup, behaviour, and record.

## Why it matters
Everything about one employee lives here in one place — its identity, what it knows, what it can touch, how it's performing, and every governance control. You don't hop between pages to manage a single DE.

## Before you start
Open **Digital Employees**, then click the employee you want. The header shows its name, department, and a **← All Digital Employees** link to go back. Some panels (Performance, Incidents, KPIs) only show data once the employee has actually done work — an empty state there is honest, not a bug.

## The panels, top to bottom

**Identity card** — the employee's avatar, persona name and role label, live **status**, a **health** badge, and its description.

**Identity & Purpose** — the employee's working identity: **display title**, **purpose statement**, **primary business outcome**, and **responsibilities** (one per line). These are fed straight into every answer the employee gives. It also holds standard workforce-record fields (**employee code**, **location**, **cost center**) for org bookkeeping — those are not fed into answers. Changes take effect on the next answer.

**Profile fields** — your workspace's own custom employee-record fields (e.g. Region), defined once and shown on every profile.

**Lifecycle** — the governance gate: the employee's current stage, the criteria to reach the next one, and pause/resume controls. See *the-de-lifecycle*.

**Availability** — *Always on* or *Business hours* (with timezone, hours, and days). Off-schedule, the employee stops picking up inbox work and its team backup or a specialist covers; reactive Q&A stays available.

**AI Engine** — which Claude model this employee thinks with, with per-model pricing.

**How this DE operates (operating charter)** — the playbooks assigned to this employee, in priority order. See *configuring-what-a-de-knows-and-does*.

**Performance** — real per-employee metrics computed from its own decisions: **Resolution**, **Confidence**, **Escalation**, and **Error rate**, plus how many inquiries it handled this period.

**Knowledge scope** — how many documents are scoped specifically to this employee, on top of everything company-wide it can read.

**What this employee can touch** — its system-access grants via the Control Fabric (which connectors/categories, at what permission). Managed centrally under **Governance → Data Access**.

**Specialists** — this employee's **primary** and **secondary** consult desks (see *the-specialist-desk*).

**Escalation rules** — when the employee hands work to a human regardless of confidence: a **frustration threshold** and **always-escalate topics**, personal to this employee or inherited from the workspace default.

**Incidents** — a durable record of guardrail blocks, automatic trust demotions, failed evaluation runs, and human-rejected actions attributed to this employee, each reviewable with a resolution note.

**Skills** — evidence-assessed proficiency across five platform skills (Domain, Process, Communication, Analytical, Integration), measured from real 30-day evidence. Level 5 (Expert) is human-awarded, so automatic assessment tops out at Advanced.

**Goals & KPIs** — targets you set against metrics the platform actually measures; current values are computed live, never invented.

**Economics** — real work counts and AI cost always show; hours saved, FTE-equivalent, and ROI appear only once you configure the human baselines (they're never estimated).

**Certifications & Reviews** — expiring certifications issued by a named person, plus quarterly performance reviews with honest verdicts.

**Development** — evidence-grounded development items proposed from real performance data, or added manually. See *de-health-and-development*.

**Governance** — configuration editing and versioning, owner and ownership transfer, retirement, and bounded DE-to-DE consultations. See *managing-de-lifecycle-changes*.

**Trust dial** and **Earned trust** — per-action autonomy for this employee, and the evidence-based promotion ladder. See *the-trust-dial*.

## Tips & best practices
- Work top to bottom the first time you set up a DE: Identity → Lifecycle → Availability → AI Engine → access and playbooks. That mirrors the order the lifecycle criteria unlock in.
- The **Incidents** and **Governance** panels are your accountability trail — check them before you raise an employee's trust or move it to a new owner.

## Related articles
- understanding-digital-employees
- configuring-what-a-de-knows-and-does
- the-de-lifecycle
- the-trust-dial
- de-health-and-development
- managing-de-lifecycle-changes
