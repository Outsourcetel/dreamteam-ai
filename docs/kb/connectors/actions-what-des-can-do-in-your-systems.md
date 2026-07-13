---
title: Actions — what a DE can do in your systems
category: Connectors
feature: Connectors — Actions & write-back
audience: admin
difficulty: advanced
tags: [actions, write-back, destructive, preview, execute, approval, guardrails, trust]
---

# Actions — what a DE can do in your systems

## What it is
Beyond reading, a connector can let a Digital Employee **act** in a system — for example **add an internal note** to a ticket, **update a ticket's status**, **post a reply**, **add tags**, or **post a message**. Each action writes back into your system of record, and each one is governed before it runs.

## Why it matters
Reading answers questions; acting closes the loop. But writing into a live system is where trust matters most. DreamTeam makes actions **explicit, previewable, and governed**: you choose which actions are enabled, risky ones always require a human, and every execution leaves a plain-language receipt in the audit trail.

## How actions are governed
When a DE tries to run an action, DreamTeam applies three checks in order:

1. **Access check** — the connector must permit write-back for that action.
2. **Destructive-always-gates** — if the action is flagged **destructive**, it *always* pauses for human approval, no matter how trusted the DE is. This check runs first and unconditionally.
3. **Guardrails, then trust** — your guardrail rules can block or gate an action; within what's allowed, the DE's trust level decides whether it auto-executes or waits for approval.

An action that's gated becomes a **human task** with the full request attached — for a reply, that includes the exact text the customer would see — so a person approves the real thing, not a summary.

## Preview vs execute
- **Preview** renders the exact request (method, URL, and body) and a plain-language **receipt preview** — *without calling the external system*. It has no side effects beyond a lightweight traceability record. Use it to see precisely what would happen.
- **Execute** runs the governance checks above and, when allowed (auto-executed by a trusted DE, or after a human approves the gated task), actually calls the system and returns a **receipt** describing what was done — for example *"Added an internal note to ticket #1234 (not visible to the customer)"* or *"Posted a public reply on ticket #1234 — the customer will see it."*

## Risk flags travel with every action
Each action carries two honest annotations:
- **Destructive** — has an outward or hard-to-undo effect (a public reply is destructive; an internal note is not). Destructive actions always require approval.
- **Idempotent** — safe to repeat without piling up side effects (adding tags in an append-safe way is idempotent).

These flags let the interface state honestly whether an action *"always requires approval"* or *"currently auto-executes once trusted."*

## Enabling actions (Zendesk example)
For Zendesk, the connector card shows a **Write-back actions — into the system of record** row. Each action (for example **Add internal note**, **Update ticket status**) is a toggle you switch **on** or **off**. A disabled action is refused with *"This write-back action is disabled in the registry."* Registered actions for other providers are governed the same way through the generalized action layer.

## Step by step — see and control what a DE can do
1. Open **Connectors** and find the connector card.
2. For Zendesk, review the **Write-back actions** toggles and enable only the ones you want the DE to perform.
3. Set your **Guardrails** (in Governance) to block or require approval for anything sensitive — guardrails always win over trust.
4. When a DE proposes a destructive or gated action, approve or reject it in **Approvals / Human tasks**, where you can read the full draft before deciding.
5. Review executed actions and their receipts in the **Audit Trail**.

## Tips & best practices
- Enable the least you need. An internal note is low-risk; a public reply is customer-facing — keep it gated until you trust the DE's drafts.
- Use **preview** to sanity-check a new action's exact request before letting it run.
- Lean on **guardrails** for hard rules (e.g. "no unilateral refund promises") — they hold regardless of trust level.
- Raise a DE's trust gradually; "promote slow, demote fast." Trust only ever narrows *within* what guardrails and the destructive flag already allow.

## Troubleshooting
- **Action didn't run, became a task instead** — it's destructive or your guardrails/trust gated it. Approve it in Human tasks.
- **"This write-back action is disabled in the registry."** — enable the action's toggle on the connector card.
- **"No native execution path"** for an action — that action isn't implemented for this provider yet.
- **Nothing changed in my system** — check you ran **execute**, not **preview** (preview never calls the system).

## Related articles
- connecting-your-first-system
- custom-api-connector
- fetch-vs-ingest-modes
- how-credentials-are-kept-safe
