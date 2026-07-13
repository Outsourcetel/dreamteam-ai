---
title: Governance and the Control Fabric — how DreamTeam keeps AI safe
category: Governance
feature: Governance
audience: admin
difficulty: beginner
tags: [governance, control fabric, guardrails, audit, grounding, trust, safe ai, compliance]
---

## What it is

Governance is the part of DreamTeam AI that turns a capable AI worker into one you can actually trust with real work. It is not a single screen — it is a set of controls that wrap around everything your Digital Employees do. Together we call it the **Control Fabric**.

The Control Fabric rests on three ideas:

- **Grounding** — a Digital Employee answers only from the knowledge you gave it, cites its sources, and scores its own confidence. It does not invent facts.
- **Guardrails** — rules you set can withhold an answer, block an action, or force a human review before anything reaches a customer.
- **Audit** — every answer, escalation, approval, guardrail block, and configuration change is written to an immutable, tamper-evident log.

## Why it matters

Most "AI assistant" products are a text box bolted onto an app. The risk lives everywhere: the model can make things up, say something it shouldn't, take an action nobody approved, and leave no record of what happened.

DreamTeam is built the opposite way. A Digital Employee starts locked down and earns latitude. When it is unsure, it escalates to a person. When it trips a rule, the answer is withheld and a human is notified. And no matter what happens, there is a permanent record you can hand to an auditor, a customer, or your own security team.

If your business is in a regulated or trust-sensitive industry — finance, healthcare, legal, professional services — this is the difference between "we tried an AI tool" and "we put AI to work under controls we can prove."

## The Governance section, screen by screen

You will find all of these under **Governance** in the left sidebar:

- **Compliance & Guardrails** — the rules that block topics, phrases, and actions, and force approvals over money thresholds. See [guardrails](guardrails.md).
- **Audit Trail** — the immutable, hash-chained record of everything that happened, with a one-click integrity check. See [the-audit-trail](the-audit-trail.md).
- **Security & Access** — your team, their roles, MFA, API keys, session timeout, and network controls. See [security-and-access](security-and-access.md).
- **Data Access** — which Digital Employee may touch which connected system, and how deeply. Default-deny. See [data-access-controls](data-access-controls.md).
- **Identity & Credentials** — a read-only inventory of every digital worker, every system it can reach, and whether a live credential is stored. See [identity-and-credentials](identity-and-credentials.md).
- **Trust & Architecture** — an honest, labeled map of how the platform is built, where your data goes, and what has and hasn't been hardened yet. See [trust-and-architecture](trust-and-architecture.md).

## How the three layers work together

A single customer question passes through all three parts of the Control Fabric:

1. **Grounded answer.** The Digital Employee retrieves only your workspace's knowledge, drafts an answer, cites the sources, and scores its confidence.
2. **Guardrail check.** Before the answer is shown, it is checked against your blocking rules. If it matches one — say a blocked legal-commitment phrase — the answer is **withheld**, a human task is created, and the customer sees a safe fallback message instead.
3. **Escalation on low confidence.** If confidence is below the escalation threshold (or the model asks for help), the work becomes a Human Task rather than standing on its own.
4. **Audit.** Whatever the outcome — resolved, escalated, or blocked — a record is appended to the immutable audit trail.

The **Trust dial** sits alongside this: it decides how much a Digital Employee may do on its own. Crucially, autonomy narrows *within* guardrails and can never override them. An invoice only auto-sends when it passes **both** the guardrail threshold **and** the trust dial's limit.

## Tips & best practices

- Start by installing the **starter guardrails** on the Compliance & Guardrails page — a sensible default set you can then tune.
- Keep new Digital Employees on a low trust level until you have watched them work and reviewed their audit trail.
- Treat the **Data Access** matrix as your blast-radius control: a support worker should not be able to reach financial systems, and default-deny makes that the starting point.
- Read **Trust & Architecture** before a security review — it is written to be handed to a skeptic, gaps and all.

## Related articles

- [guardrails](guardrails.md)
- [the-audit-trail](the-audit-trail.md)
- [security-and-access](security-and-access.md)
- [data-access-controls](data-access-controls.md)
- [identity-and-credentials](identity-and-credentials.md)
- [trust-and-architecture](trust-and-architecture.md)
