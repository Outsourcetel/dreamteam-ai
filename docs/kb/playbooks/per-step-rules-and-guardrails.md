---
title: Per-step rules and guardrails in playbooks
category: Playbooks
feature: Playbook Builder
audience: admin
difficulty: intermediate
tags: [playbooks, rules, guardrails, on-violation, escalate, governance]
---

# Per-step rules and guardrails in playbooks

## What it is
A **per-step rule** is an optional assertion you attach to a single step: a pattern to look for in that step's recorded outcome, and what to do if it matches. It's an extra, playbook-author-defined check that sits on top of your workspace's global **guardrails** — it never replaces them.

## Why it matters
Global guardrails protect the whole workspace ("no unilateral refund promises," an invoice approval threshold, and so on) and are enforced everywhere. A per-step rule is narrower: it lets the person building one playbook add a targeted safety net at one specific step — "if this step's result contains X, stop and get a human." It's the difference between a company-wide policy and a note-to-self on one step of one procedure.

## Before you start
- You need edit access to the playbook in the builder.
- Decide what text in the step's outcome should trip the rule, and whether a violation should escalate or stop the run.

## Step by step

### Attaching a rule to a step
1. Open the playbook in the builder and find the step.
2. Under that step, click **+ Add a rule to this step**.
3. In **pattern**, enter the text or pattern to look for. Separate alternatives with a vertical bar `|` — the rule matches if any fragment is found.
4. Choose the on-violation behavior:
   - **→ escalate to a human** — the run stops and a Human Task is created for review.
   - **→ stop the run** — the run stops, with no task created.
5. To remove it later, click **remove** on the rule row.

Rules can be attached to most steps (not the Decision step or the final Complete step).

## How a rule is evaluated
When the run advances past a step that has a rule, the server checks that step's recorded outcome — its detail text and any recorded output — against your pattern. Each `|`-separated fragment is tried (as a case-insensitive match). If any fragment matches:

- The step is marked **failed** and its detail notes which fragment matched.
- The run is stopped.
- If you chose **escalate**, a Human Task titled "Playbook step rule violated" is created.
- A **guardrail_block** audit event is recorded, so the stop is provable.

If nothing matches, the run continues normally.

## How this differs from global guardrails
| | Per-step rule | Global guardrail |
|---|---|---|
| Scope | One step of one playbook | The whole workspace, everywhere |
| Who sets it | The playbook author, in the builder | Governance / admin, in Guardrails |
| What it checks | That one step's recorded outcome | Actions and content across the platform |
| Can it be skipped? | It's an *extra* assertion you opt into | Always enforced — guardrails always win |

The key principle: **guardrails always win.** A per-step rule adds an assertion; it can never loosen or override what a global guardrail already blocks. Even if a step's rule would let something through, the workspace guardrails still apply on top.

## Tips & best practices
- Keep patterns specific. An over-broad pattern will stop runs you meant to allow.
- Use `|` to cover a few phrasings of the same risky outcome in one rule.
- Prefer **escalate** when a human might reasonably approve the situation; use **stop** only when a match should always halt everything.
- Rules read the step's *recorded outcome text*, so write them against what the step actually reports (visible in a Dry-run preview or a real run's timeline).

## Troubleshooting
- **My rule never fires.** Check that the pattern actually appears in the step's recorded detail — run a Dry-run preview and read the step's detail line to see the real wording.
- **A run stopped unexpectedly.** Open the run timeline; a rule-stopped step is marked failed with "STEP RULE VIOLATED (matched …)" so you can see which fragment tripped it.
- **I need this check everywhere, not just here.** That's a job for a global guardrail, not a per-step rule — set it up in Governance.

## Related articles
- [step-types-explained](step-types-explained.md)
- [human-approval-and-escalation-in-playbooks](human-approval-and-escalation-in-playbooks.md)
- [agentic-steps](agentic-steps.md)
