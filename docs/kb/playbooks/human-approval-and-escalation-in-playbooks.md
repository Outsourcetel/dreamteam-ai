---
title: Human approval and escalation in playbooks
category: Playbooks
feature: Playbook Builder
audience: admin
difficulty: intermediate
tags: [playbooks, human approval, gates, escalation, human tasks, checklist]
---

# Human approval and escalation in playbooks

## What it is
Some playbook steps are **human gates** — the run pauses and waits for a person before it can go on. Other situations cause a step to **escalate** — the run creates a task for a human to look at. Both are how a playbook keeps a person in the loop instead of acting unilaterally.

## Why it matters
The whole point of a controlled procedure is that the machine does the routine parts and a human owns the judgment calls. Gates and escalations are where that hand-off happens, and every one of them is recorded so you can prove the human was involved.

## The human gate steps
Three steps pause a run for a person:

- **Human approval** — an explicit approval gate. It creates a Human Task with the title you templated (for example "Playbook approval — {{account.name}}") and pauses the run until someone approves. A playbook can have at most one, and it must come after a **Generate invoice** step, because it gates that invoice.
- **Checklist** — a list of items a person must tick off. It creates a Human Task and pauses until every item is confirmed.
- **Generate invoice** — creates a renewal invoice and runs the guardrail-plus-trust-dial check. If the amount is over the limit for the DE, it routes to human approval automatically.

In the builder, gate steps are highlighted amber and marked **Human Gate** with a 🤝 icon, so you can see at a glance where a playbook will pause.

## How approval flows through a run
1. The run reaches a gate step.
2. The server creates a **Human Task** and sets the run's status to "waiting on human." The run does not advance.
3. A person opens the task (in Approvals / Human Tasks) and approves it.
4. On approval, the server resumes the run — on the server, not in your browser — and carries on through the remaining steps.
5. The run finishes at **Complete**, and the whole timeline, including who approved and when, is in the audit trail.

Because resumption is server-side, a paused run survives closed tabs and picks up exactly where it left off when the human acts.

## The "skip if already approved" behavior
If a **Generate invoice** step was auto-approved because it was within the trust/guardrail limits, a following explicit **Human approval** step recognizes that and **skips itself** — you don't get asked to approve something the guardrails already cleared. If the invoice was gated (over limit), the Human approval step does its job and pauses.

## Draft-for-approval (outbound)
When a playbook would send something outward, the platform's convention is to draft it for a person to approve rather than send it unilaterally. Approval gates are how that lands inside a playbook: the run prepares the work and pauses at the gate, and a human gives the final go-ahead. Nothing outbound commits while the run sits at the gate.

## When a step escalates instead of gating
Several steps can escalate — create a task for a human — based on what happens at run time:

- **Check knowledge** with on-miss set to **Escalate to a human** creates a task when nothing is found (you can instead choose Continue anyway or Stop the run).
- **Consult specialist** with **Below floor → escalate** creates a task when the specialist's confidence is under your minimum (you can instead choose Continue).
- A **per-step rule** set to **escalate to a human** stops the run and raises a task when its pattern matches (see [per-step-rules-and-guardrails](per-step-rules-and-guardrails.md)).
- Inside an **Agentic step**, the reasoning loop can call an "ask a human" tool, and any action it takes that requires approval is routed to a human — without pausing the loop (see [agentic-steps](agentic-steps.md)).

An escalation creates visibility and a task to act on; a gate actually pauses the run. Some situations do both (a rule violation stops the run *and* escalates).

## Tips & best practices
- Place a **Human approval** gate right before anything you'd want to eyeball — an invoice, a status change with consequences, an outbound action.
- Use a clear, templated task title so approvers know what they're looking at (include `{{account.name}}`).
- For a knowledge or specialist step, choose **Continue** only when a miss or low confidence is genuinely safe to proceed on; otherwise escalate.
- Remember only a limited set of steps may run *after* a Human approval gate — the builder enforces this.

## Troubleshooting
- **My run is stuck on "waiting on human."** That's a gate doing its job. Find the Human Task in Approvals and act on it; the run resumes automatically.
- **My Human approval step got skipped.** The invoice before it was auto-approved within limits, so there was nothing to gate. That's expected.
- **The builder won't let me add Human approval.** It must come after a Generate invoice step, and there can be only one.

## Related articles
- [step-types-explained](step-types-explained.md)
- [per-step-rules-and-guardrails](per-step-rules-and-guardrails.md)
- [agentic-steps](agentic-steps.md)
- [what-are-playbooks](what-are-playbooks.md)
