---
title: Guardrails — blocking topics, phrases, and actions
category: Governance
feature: Compliance & Guardrails
audience: admin
difficulty: intermediate
tags: [guardrails, compliance, blocked phrase, blocked topic, approval threshold, discount cap, escalation, scope]
---

## What it is

A **guardrail** is a rule that constrains what your Digital Employees are allowed to say or do. Guardrails are enforced by the platform, not by the model's good intentions — when a Digital Employee's draft answer trips a blocking rule, the answer is **withheld** and the work is **escalated to a human** instead of reaching your customer.

You manage guardrails on the **Governance → Compliance & Guardrails** page.

## Why it matters

An AI worker that is helpful 99% of the time can still cause real damage in the 1%: promising a refund you can't honor, giving legal or medical advice, quoting a competitor's price, or committing to an SLA you don't offer. Guardrails put hard limits around those cases so a single bad answer never leaves the building. Every guardrail change — and every block — is also recorded in the [audit trail](the-audit-trail.md), so you can prove the controls were in place.

## Before you start

- You need a workspace owner or admin role to add or change guardrails.
- Guardrails scoped to a **department** need at least one Digital Employee with that department set on its profile. If your roster has no departments yet, scope to a specific employee (or the whole workspace) instead.

## The types of guardrail

The page supports several rule types, each doing a different job:

- **Blocked phrase** — answers *containing* these phrases are withheld and escalated. Good for exact wording you never want said (e.g. `guarantee`, `we promise`, `legally binding`).
- **Blocked topic** — answers *matching* this topic are withheld and escalated. Good for whole subject areas, like legal advice.
- **Approval threshold** — invoices above a dollar amount route to Human Tasks instead of sending automatically. This replaces the built-in high-value gate on renewal invoices.
- **Discount cap** — the maximum discount a Digital Employee may apply without human approval.
- **Frustration signal** — phrases that score a customer's frustration; enough matches force a human hand-off regardless of how confident the answer was.

Each rule also carries a **severity**: **Blocking** (the answer or action is stopped) or **Warning** (recorded, but not stopped). Only blocking rules withhold an answer.

## Scope — who a rule applies to

Every rule applies to a chosen scope, so you can restrict one team without gagging another:

- **Whole workspace** — applies to every Digital Employee.
- **A department** — applies only to Digital Employees in the department you pick.
- **One employee** — applies only to the single Digital Employee you choose.

(A fourth scope, **playbook**, exists for rules attached to a specific automated playbook run.) When a Digital Employee generates an answer, the platform checks the workspace rules **plus** any department or employee rules that match that specific worker. A general, unscoped question is checked against workspace rules only.

## What happens when an answer trips a guardrail

For a blocking phrase or topic rule, the moment a draft answer matches:

1. The answer is **never shown** to the customer — they receive a safe fallback: *"I can't help with that — it's outside my guardrails. I've escalated to a human."*
2. A **Human Task** is created, carrying the blocked draft and the name of the rule it tripped, so a person can take over.
3. An **activity event** and an **immutable audit event** (category *guardrail block*) are recorded, noting which rule fired and the question.

This same check runs in both the tenant console chat and the public end-user widget.

## Step by step — install the starter set

1. Open **Governance → Compliance & Guardrails**.
2. If you have no rules yet, click **Install starter guardrails**. This adds a sensible starting set: a $10,000 invoice-approval threshold, blocked legal-commitment phrases, a blocked legal-advice topic, and a 20% discount cap.
3. Review the rules in the table. Use the **Active** toggle to turn any of them on or off.

## Step by step — add a custom rule

1. On the Compliance & Guardrails page, click **+ Add rule**.
2. Enter the **Rule** in plain English (e.g. *"Never quote competitor pricing"*).
3. Choose the **Type** and **Severity**.
4. Under **Applies to**, choose Whole workspace, A department, or One employee — and pick the target if needed.
5. For a phrase/topic/frustration rule, enter the **Patterns**, separating alternatives with a vertical bar: `guarantee|we promise|legally binding`. For an approval threshold or discount cap, enter the number instead.
6. Click **Add rule**. It takes effect immediately and the change is audited.

## Options & settings

- **Version** — each rule tracks a version number that increments as you edit it, so its history is visible.
- **Active toggle** — deactivate a rule without deleting it; it stops being enforced but stays on record.
- **Pattern matching** — the answer check is case-insensitive pattern matching (v1). It is deliberately simple and fast, not an AI judge. See the honest note below.

## Tips & best practices

- Prefer **specific phrases** over broad topics to start — they produce fewer surprise blocks while you learn how your Digital Employees phrase things.
- Use **employee scope** for rules that only make sense for one role (e.g. a Finance worker's fee-adjustment cap).
- After adding a rule, watch the [audit trail](the-audit-trail.md) for guardrail-block events to confirm it is catching what you expect — and nothing you don't.

## Troubleshooting

- **A rule isn't blocking anything.** Check that its severity is **Blocking** (Warning rules don't withhold), that it's **Active**, and that its **scope** actually covers the Digital Employee answering.
- **A department scope has no options.** No Digital Employee has that department set yet. Set a department on a DE's profile, or scope to a specific employee.
- **Honest limit:** the answer check is pattern matching, not semantic understanding. A cleverly reworded answer could slip past a narrow phrase list. The named next step is an LLM-based judge; for now, prefer several phrasings in your pattern list.
- **Honest limit:** the guardrail *answer* check runs in the AI answering path, which is fully active only once the AI engine key is configured. The **approval-threshold** guardrail on invoices is enforced today regardless.

## Related articles

- [governance-overview](governance-overview.md)
- [the-audit-trail](the-audit-trail.md)
- [trust-and-architecture](trust-and-architecture.md)
- [data-access-controls](data-access-controls.md)
