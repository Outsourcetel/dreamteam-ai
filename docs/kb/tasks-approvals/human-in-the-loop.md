---
title: How draft-for-approval and escalation keep a human in control
category: Tasks & Approvals
feature: Human-in-the-loop
audience: admin
difficulty: intermediate
tags: [human in the loop, draft for approval, escalation, guardrail, trust, gated action]
---

# How draft-for-approval and escalation keep a human in control

## What it is
"Human-in-the-loop" is the principle — and the machinery — that keeps a person in control before anything consequential leaves the building. A Digital Employee can do the work, but two mechanisms make sure it doesn't act unchecked: **draft-for-approval** (the DE prepares, a human approves before it sends) and **escalation** (the DE hands off when it isn't sure or a rule says stop).

## Why it matters
Autonomy without control is how AI causes damage. DreamTeam's design is trust-before-automation: a DE earns the right to act, and until it has, or when the stakes are high, a human reviews first. This is what lets you put a Digital Employee in front of real customers and real money without holding your breath.

## Before you start
- Both mechanisms feed the **Approvals & Drafts** queue — that's where the human step actually happens.
- What gets gated versus auto-sent depends on the DE's **trust level** and your **guardrails**. Raising trust or adjusting guardrails changes where the line sits.

## How it works

### Draft-for-approval (outbound actions)
1. A DE prepares an action that affects the outside world — most commonly a customer reply, but also things like a renewal invoice.
2. Instead of sending, it records the action as a **gated execution** and raises an **ACTION** task in Approvals & Drafts.
3. You open the task and see the **full draft** and a clear statement of **what will be sent / changed on approval**.
4. You approve (the button reads **Approve & send** or **Approve & execute**) — and only then does it go out — or you reject it. In **DE at Work**, the same item reads **Would act — awaiting approval** until you decide.

### Escalation (handing off)
A DE escalates instead of guessing when:
- its **confidence** falls below the escalation threshold,
- a **guardrail** blocks the action it wanted to take, or
- the customer explicitly asks for a human (escalations raised from the DE chat dock arrive tagged **via DE chat**, with the full transcript attached).

Escalations land as **ESCALATION** tasks in Approvals & Drafts, and high-**frustration** inquiries are routed to a human automatically.

## Options & settings
- **Trust level** governs how much a DE may do on its own. A lower-trust DE drafts and defers more; a higher-trust one is cleared to act on more. See the Trust dial in the DE's profile.
- **Guardrails** are the hard rules — thresholds, prohibited actions, required reviews. When one fires, the DE's decision shows as **Blocked by guardrail** and, where relevant, becomes an **OVERRIDE** request for a human.
- **Approval gates** are the amount/threshold triggers (e.g. an invoice above a set value) that force a human sign-off regardless of trust.

## Tips & best practices
- Start new DEs **low-trust** so more work is drafted for approval, watch them in **DE at Work**, then raise trust as they prove themselves.
- Treat **repeated overrides** as a signal (Insights will surface them as *config drift*): either the rule is too tight, or the DE is being pushed to do something it shouldn't.
- Remember that **approve means act** — approving a drafted reply sends it, and approving a renewal invoice sends it to the customer. The queue tells you so at the point of decision.

## Troubleshooting
- **A DE acted without my approval.** Check its trust level and guardrails — a high-trust DE with no gate on that action type is cleared to auto-execute. Lower the trust or add a guardrail to force review.
- **An escalation has no owner.** Escalations track an SLA in the queue but are resolved by the receiving team or in the linked work surface; the queue is the tracker, not always the place of resolution.
- **The draft I approved didn't send.** Confirm the action's connector is actually connected — a "No access — blocked" outcome in DE at Work means the target system isn't wired up.

## Related articles
- [approvals-and-drafts](approvals-and-drafts.md)
- [activity-log](activity-log.md)
- [../digital-employees/trust-dial](../digital-employees/trust-dial.md)
- [../governance/guardrails-and-compliance](../governance/guardrails-and-compliance.md)
