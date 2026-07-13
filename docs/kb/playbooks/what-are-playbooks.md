---
title: What are playbooks?
category: Playbooks
feature: Playbook Builder
audience: admin
difficulty: beginner
tags: [playbooks, procedures, automation, digital employee, audit]
---

# What are playbooks?

## What it is
A playbook is a repeatable, auditable procedure that a Digital Employee (DE) follows step by step. Instead of letting the DE improvise every time, you write down the exact sequence — check this record, look this up, take that action, pause for a human here — once, and the DE runs it the same way on every case. Every step it takes is recorded in the audit trail.

You build playbooks on the **Playbooks** page from a fixed set of typed steps, validate them, and publish them. Published playbooks run on our servers, so a run keeps going even if you close your browser.

## Why it matters
Free-form answers are perfect for questions ("What's our refund policy?"). But real work is usually a *procedure* — a renewal, an onboarding, a triage, a follow-up — with an order, decision points, and moments where a person must sign off. A playbook gives you three things a free-form answer can't:

- **Consistency** — the same steps in the same order, every time, for every account.
- **Control** — guardrails, human approval gates, and the per-DE trust dial are enforced on every step by the server, not left to the DE's judgment.
- **Auditability** — each step appends a hash-chained audit event, so you can prove exactly what happened and why.

## When to use a playbook vs. letting the DE answer freely
Use a **playbook** when the task is:

- A defined procedure with a clear sequence (renewal follow-up, refund handling, ticket triage, onboarding kickoff).
- Something that must pause for human approval at a specific point.
- Something that writes back to a connected system, generates an invoice, or takes any real-world action.
- Something you need to run identically across many accounts, or on a schedule / trigger.

Let the DE **answer freely** when the task is:

- A one-off question with no fixed procedure.
- Retrieval and explanation, where you just want a grounded, cited answer.
- Exploratory work where the right next step genuinely depends on the situation. (If you want that flexibility *inside* a controlled run, see the **Agentic step** — it hands one step to a reasoning loop while keeping every guardrail in place.)

## What a playbook is made of
Every playbook is an ordered list of up to 20 steps. Steps come in three groups in the builder:

- **Do something** — load an account, check knowledge, read a reference, run a connector action, consult a specialist, run an agentic step, generate an invoice, log activity, and more.
- **Guide & explain** — instruction blocks (with images or video) and checklists a human ticks off.
- **Flow control** — decisions that branch the run, waits, running another playbook, and emitting events.

The last step is always **Complete**. Some steps are *human gates* — they pause the run until a person acts.

## How a run works
1. You publish the playbook. Publishing takes an immutable snapshot (a version).
2. A run starts — manually (you pick an account and click **Run**), on a **schedule**, or from an **event trigger**.
3. The server executes the snapshot step by step, applying guardrails and the trust dial to any real action.
4. If a step is a human gate, the run pauses and creates a Human Task. When the person approves, the run resumes on the server.
5. When the last step completes, the run is marked completed. The full timeline is visible in **Runs**.

## Related articles
- [building-your-first-playbook](building-your-first-playbook.md)
- [step-types-explained](step-types-explained.md)
- [human-approval-and-escalation-in-playbooks](human-approval-and-escalation-in-playbooks.md)
- [testing-and-publishing-a-playbook](testing-and-publishing-a-playbook.md)
