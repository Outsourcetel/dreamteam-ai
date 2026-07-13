---
title: Playbook step types explained
category: Playbooks
feature: Playbook Builder
audience: admin
difficulty: intermediate
tags: [playbooks, steps, primitives, connector action, agentic, decision]
---

# Playbook step types explained

## What it is
Every playbook is built from a fixed vocabulary of typed steps ("primitives"). Each one does exactly one thing, and the server enforces what each is allowed to do. This article describes every step available in the builder, grouped the way the **+ Add step** buttons group them: **Do something**, **Guide & explain**, and **Flow control**.

## Do something

**Check account** — Loads the target record (its name, value, renewal date, and your custom fields) into the run so later steps can reference them as `{{account.name}}` or `{{party.YOUR_FIELD}}`. Place it before any step that needs those fields — it no longer has to be step 1.

**Generate invoice** — Creates a renewal invoice, either for the account's own value or a fixed amount you set. It runs the guardrail-plus-trust-dial composition automatically: an over-limit amount routes to human approval; within limits it's sent. At most one Generate invoice step per playbook. This is a human gate.

**Human approval** — An explicit gate: it creates a Human Task and pauses the run until a person approves. If a prior invoice was already auto-approved within limits, this step skips itself. You give it a task-title template. At most one per playbook, and it must come after Generate invoice.

**Guardrail check** — An explicit re-check point. It re-evaluates the invoice approval threshold and records the comparison in the audit chain. It never pauses the run — it's there to make the check visible and provable.

**Connector action** — Runs any registered action against a connected system, chosen from your Action Library (helpdesk, CRM, ERP/finance, and more — not just one vendor). Each action's parameters become templated inputs you fill in. Every action passes the same access grants, guardrails, and trust dial as anywhere else on the platform; a destructive action always routes to a human regardless of the trust dial. If there's no connected system for the action's category, the step records as skipped and the run continues (honest degradation).

**Update record** — A whitelisted status change only. It can flip an invoice to `sent`/`paid`, or a support ticket to `open`/`pending`/`resolved`/`escalated`. The target comes from the run's context. It cannot set any other field.

**Log activity** — Writes one line to the activity feed, using a message template (for example, "Playbook completed for {{account.name}}"). Useful for leaving a human-readable trace.

**Consult specialist** — Asks a configured Specialist (for example Technical, Legal, Finance, People, or the employee's own auto-assigned one) a templated question, server-side, and records it in the consultation log. You set a minimum confidence floor and choose what happens below it: escalate to a human, or continue. If the specialist's reasoning brain isn't activated (no AI key), the step records as skipped honestly rather than pretending.

**Agentic step** — Hands the step to a bounded reasoning loop instead of a fixed script: you give a goal, and the DE decides how to reach it using the tools it's been granted. Every action it takes still passes through the same access grants, guardrails, and trust dial as a Connector action. Dormant until the reasoning brain is activated. See [agentic-steps](agentic-steps.md).

**Check knowledge** — Looks something up in your knowledge base — the same search a DE answer uses, scoped to this playbook's employee — and decides what happens on a miss: continue, escalate to a human, or stop the run. What it finds is read into the run for later Agentic or Consult steps, and a Decision can branch on whether anything was found. See [using-variables-in-steps](using-variables-in-steps.md).

**Start onboarding** — Creates a real onboarding project for the run's account, from a published onboarding template version you pick. If the template version was deleted/unpublished, or there's no account in context, the step records as skipped and the run continues.

**Complete** — Marks the run completed. This is the required final step; every playbook ends with exactly one.

## Guide & explain

**Instruction** — Explains something to whoever reads or runs the playbook: a title plus markdown body, with images or video embedded right in the step. Instruction text is also gathered into the run's working context, feeding later Consult specialist / Agentic steps once their reasoning brain is active.

**Read reference** — Gives the employee documents or links to read into its working context before it acts: a knowledge-base document, a public web page URL, or an uploaded text/markdown/JSON file (up to 5 references). Later Agentic / Consult steps receive this material. PDF extraction is not built yet — text, markdown, and web pages only. Scoped knowledge docs are only readable by an employee they're scoped to.

**Checklist** — A list of items a human must tick off. It creates a Human Task and pauses the run until every item is confirmed. This is a human gate.

## Flow control

**Decision** — Branches the playbook based on an earlier step's result. You pick a prior step and a comparison (equals, does not equal, contains, is greater than, is less than, or exists), and add **Then** and **Else** steps that render indented underneath. Decisions can only look at earlier steps, and nesting is one level deep. Only guide/explain and simple work steps can go inside a branch (no invoice, no human gate, no complete).

**Wait** — Pauses the run for a set number of minutes, then continues automatically (checked every 5 minutes).

**Run another playbook** — Runs a published playbook as a child of this one. The child inherits this playbook's access — it can never do more than the parent is allowed to. Only published playbooks can be picked, and cycles (A calls B, B calls A) are rejected.

**Emit event** — Fires one of your trigger events. Any playbook wired to that event starts on the next dispatch cycle — this is how you chain playbooks by event. An unknown event records the step as skipped and the run continues.

## Tips & best practices
- Reach for **Check knowledge** or **Read reference** before an **Agentic step** or **Consult specialist**, so the reasoning step has the material it needs.
- Prefer **Connector action** with a registered action over the older single-vendor forms — it goes through the full access-grant and guardrail pipeline.
- A step that "degrades honestly" (skips because a dependency isn't connected) is a feature: the run continues and the audit trail says exactly why the step was skipped.

## Troubleshooting
- **A step won't let me place it after Human approval.** Only a limited set may follow a gate (guardrail check, connector action, update record, log activity, instruction, decision, checklist, wait, run-another-playbook, consult specialist, complete). This keeps the resume path server-authoritative.
- **My connector action step keeps skipping.** There's no connected, active system in that action's category. Connect one, or expect the honest skip.

## Related articles
- [using-variables-in-steps](using-variables-in-steps.md)
- [agentic-steps](agentic-steps.md)
- [per-step-rules-and-guardrails](per-step-rules-and-guardrails.md)
- [human-approval-and-escalation-in-playbooks](human-approval-and-escalation-in-playbooks.md)
