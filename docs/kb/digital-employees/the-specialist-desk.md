---
title: The Specialist Desk
category: Digital Employees
feature: Workforce / Specialists
audience: admin
difficulty: intermediate
tags: [specialists, technical, legal, finance, people, consultation, DE-to-DE]
---

# The Specialist Desk

## What it is
Specialists are consulted **on demand** by your primary Digital Employees when a task exceeds their depth — like consultants in a general-practitioner / specialist model. Instead of every DE carrying deep-domain knowledge, they consult a specialist.

## Why it matters
It keeps your everyday employees focused and lets deep expertise live in one well-configured place. When a primary DE hits the edge of its knowledge on a deep question, it consults the specialist, and the specialist's grounded, cited answer is merged back into the primary DE's response — the customer never sees the handoff, but the audit trail records it in full.

## The four desks
There are four specialist domains:

- **Technical** — engineering depth: API internals, architecture, debugging.
- **Legal** — contract terms, data-processing agreements, liability language.
- **Finance** — revenue recognition, tax treatment, complex billing.
- **People** — employment policy edge cases, compensation, compliance-sensitive HR.

The **Technical Specialist** is the fully live, proven install. The other three reuse the exact same framework — it's configuration, not new machinery — and currently show a "Configure coming — install pattern proven on Technical" card that points you to the Technical Specialist to see the shape of it.

## Setting up the Technical Specialist
On the **Technical Specialist** page:

1. **Install** it — this seeds a tenant-editable **charter** (answer only from configured sources, cite everything, escalate below the confidence floor).
2. Add **Sources**, each with an **access mode** your company allows:
   - **Ingest** — stores content in DreamTeam.
   - **Fetch-only** — reads live and never persists.
   - **Reference** — registers and cites, no storage.
   Source types include knowledge (tag-scoped docs), connected systems, MCP servers, reference links, and a media library.
3. Use **Resolve an inquiry** to run the evidence pipeline — the specialist gathers evidence in order (account configuration, your knowledge, past cases, its own prior experience), skipping unconnected systems honestly.
4. The **Consultation console** answers questions from those sources; the **Scribe** queue handles any write-back to an external system — and every Scribe write is **always human-gated**.

## Assigning specialists to an employee
On a Digital Employee's profile, the **Specialists** panel sets which desks that employee consults:

- **Primary** — consulted first when the employee needs help beyond its own knowledge.
- **Secondary** — the fallback if the primary is paused.

Playbook "Consult specialist" steps set to **auto** resolve through this assignment.

## Bounded DE-to-DE consultation
Separately, a Digital Employee can ask **another Digital Employee** one scoped question — a deliberately **bounded, single-hop** handoff. You manage this in the **Consultations** section of the profile's Governance panel:

- Click **+ Grant a consultation**, choose the **target employee** and a **category**.
- The answer comes from the **target employee's own access** — it never widens the asking employee's permissions.
- This is an explicit **allow-list** (owner/admin configured): a requester can consult a target only where an active grant exists. It's not open delegation — no chains, no fan-out, no synthesis across multiple employees.

Every DE-to-DE consultation is recorded as its own distinct event on the audit trail.

## Tips & best practices
- Point everyday employees at a specialist rather than trying to load every employee with deep-domain knowledge.
- Set a **secondary** specialist so consultations still resolve when the primary is paused.
- Use DE-to-DE consultation for the case where one employee legitimately shouldn't have another's access but occasionally needs one scoped answer from it (e.g. Support asking Finance a billing question) — instead of widening the first employee's grants.

## Troubleshooting
- **A specialist can't answer** — it only answers from the sources you connected; check its Sources and access modes. Below the confidence floor, it escalates to a human expert.
- **Consultation grant not working** — confirm it's **active** and that the target employee actually has access on that category (the grant uses the target's access, not the requester's).

## Related articles
- configuring-what-a-de-knows-and-does
- how-a-de-answers-questions
- managing-de-lifecycle-changes
- de-at-work-activity
