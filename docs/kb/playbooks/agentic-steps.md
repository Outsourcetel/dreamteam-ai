---
title: Agentic steps
category: Playbooks
feature: Playbook Builder
audience: admin
difficulty: advanced
tags: [playbooks, agentic, reasoning, tool use, safety, budget]
---

# Agentic steps

## What it is
An **Agentic step** hands one step of a playbook to a bounded, tool-using reasoning loop instead of a fixed script. You give it a **goal**, and the Digital Employee decides for itself what to do to reach that goal — search knowledge, take an action in a connected system, or ask a human — observes the result, and decides again, until it declares the goal done or hits a hard limit.

It's the one place in a playbook where the DE genuinely adapts rather than following a pre-authored sequence.

## Why it matters
Most steps are deterministic — do exactly this, then that. That's ideal when you know the procedure. But some tasks can't be fully scripted ahead of time: the right next move depends on what the previous move turned up. An agentic step gives you that flexibility *inside* a governed run, without giving up any of the platform's safety controls.

## Before you start
- The agentic step is **dormant until the reasoning brain is activated** (an AI engine key is configured for the workspace). Until then, the step records honestly as skipped — the plumbing runs, but no reasoning happens.
- Give the DE the access and knowledge it needs first: grant it the connector actions it should be allowed to use, and consider a **Check knowledge** or **Read reference** step earlier in the playbook to hand it the right material.

## Step by step
1. In the builder, under **Do something**, click **+ Agentic step**.
2. In the **Goal** field, describe what this step should accomplish. Template variables are supported (for example, "Resolve the billing question for {{account.name}} using our refund policy").
3. Order it after any **Check knowledge**, **Read reference**, or **Instruction** steps whose material it should use — that context is passed into the loop as reference material.
4. Save and publish as usual.

## How the loop works
Given the goal, the DE works in turns. On each turn it can:

- **Search knowledge** — look in your knowledge base for relevant information.
- **Take an action** in a connected system — but only actions it's been granted, and every one goes through the exact same pipeline as a deterministic **Connector action** step.
- **Ask a human** — create a task for a person. This does **not** pause the loop; the task is for visibility, and the DE keeps working the goal as best it can.
- **Mark the goal complete** — the only way the loop ends. It must explicitly declare done (with a short summary), so "finished" is always an intentional, auditable decision.

## Safety bounds
An agentic step is deliberately fenced in. The guarantees:

- **Same guardrails as everything else.** Every action the loop takes routes through the identical access-grant, guardrail, and trust-dial pipeline a normal Connector action uses. The loop is a smarter *caller* of that pipeline — it adds no new powers. Destructive-always-gates, guardrails-always-win, and trust-narrows-within-guardrails all still apply automatically.
- **Actions that need approval don't stop the loop.** If an action is gated for human review, the loop is told it's pending and keeps reasoning — it doesn't wait for the outcome, just as a deterministic connector step behaves.
- **Hard stops, checked before every turn.** The loop is bounded by a maximum number of iterations, a token budget, a cost budget, and a "no progress" limit that trips if it repeats the same action without moving forward. Each is an independently enforced ceiling. There's also an absolute backstop on total turns even if a budget is misconfigured, plus the workspace's overall AI budget.
- **Termination is explicit.** The loop only ends when the DE calls "mark goal complete" — never by silently trailing off.
- **Everything is recorded.** The run row, each message, token/cost usage, and start/end are all persisted, and audit events are appended, so an agentic step is as provable as any other.

These budgets are a workspace-level policy (defaults apply if none is set), not part of the step you write — the step just says what to accomplish.

## When to use it (and when not to)
Use an agentic step when:

- The path to the goal genuinely depends on intermediate findings.
- You want the DE to combine knowledge lookup and connected-system actions to resolve something.

Prefer deterministic steps when:

- You already know the exact sequence — a fixed script is more predictable and cheaper.
- The task is a single lookup or a single known action (use **Check knowledge** or **Connector action** directly).

## Tips & best practices
- Write a **specific, bounded goal.** "Draft a renewal summary for {{account.name}} from our latest pricing doc" beats "handle the renewal."
- Feed it context. A **Read reference** or **Check knowledge** step right before hands the loop exactly the material it should rely on.
- Grant only the actions it should use — the loop can only act through the access the DE has.
- Test with a **Dry-run preview** first, and watch real runs in the timeline before trusting it unattended.

## Troubleshooting
- **The step keeps recording as skipped.** The reasoning brain isn't activated for the workspace (no AI key). This is honest dormancy, not a bug.
- **The run ended with "max iterations" / "budget exceeded" / "no progress."** A safety ceiling did its job. Tighten the goal, add reference material, or review the workspace agentic-step policy.
- **It created a human task but didn't wait.** That's by design — "ask a human" is for visibility; the loop continues working the goal.

## Related articles
- [step-types-explained](step-types-explained.md)
- [using-variables-in-steps](using-variables-in-steps.md)
- [human-approval-and-escalation-in-playbooks](human-approval-and-escalation-in-playbooks.md)
- [per-step-rules-and-guardrails](per-step-rules-and-guardrails.md)
