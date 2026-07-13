---
title: Core concepts every admin should know
category: Getting Started
feature: Product Overview
audience: admin
difficulty: beginner
tags: [glossary, digital employee, connector, knowledge base, playbook, guardrail, trust, escalation, control fabric]
---

## What it is

A short glossary of the terms you will meet everywhere in DreamTeam AI. Learn these once and the rest of the product reads easily.

## Why it matters

DreamTeam organizes itself around the **Digital Employee**, not around your data. Almost every screen is really answering one of five questions about an employee: what it knows, what it can touch, how it works, who supervises it, and what it has done. These terms name those pieces.

## The concepts

**Digital Employee (DE)**
An AI worker you hire, configure, and supervise. Each DE has a name, a department, a purpose, and its own knowledge, permissions, and trust level. A DE answers questions and — where you allow it — prepares or carries out work. It is *not* the same as the underlying AI model: the model is the engine; the DE is the employee you shape around it. DEs live in the **Roster** (Digital Employees section).

**Connector**
A link to one of your existing systems — a help desk, CRM, billing tool, or knowledge source. A connector is how a DE reads from or acts on a system of record without replacing it. Connectors need your own system credentials, so they are a guided setup step rather than something provisioned for you automatically.

**Knowledge Base**
The documents and sources your DEs answer from — help articles, policies, product docs, ingested PDFs and pages. A DE answers *only* from knowledge it can see, and cites what it used. If the knowledge base has nothing relevant, the DE says so rather than inventing an answer. Managed under the **Knowledge** section (Library, Ingestion & Sources, Gap Detection, Quality & Coverage).

**Playbook**
A repeatable, step-by-step procedure a DE follows for a defined task — for example, handling a specific kind of request end to end. Built in the **Playbook Builder** (Playbooks section). Playbooks let a DE do more than answer: they let it *work* a process consistently, with rules on individual steps.

**Guardrail**
An enforceable rule that constrains what a DE may say or do. Guardrails are real matching rules, not policy statements — for example, a blocked phrase like *refund*, a blocked topic, a frustration signal, or an approval threshold on high-value actions. When a guardrail is triggered, the DE's output is withheld and the item is escalated to a human. Managed under **Governance → Compliance & Guardrails**.

**Trust level**
How much a Digital Employee is allowed to do on its own before a human must approve. Trust is earned from evidence — "promote slow, demote fast." A DE with low trust drafts work for your approval; a DE with higher trust can act within its limits. Set per employee, with a workspace-wide default.

**Escalation**
The hand-off from a DE to a human. It happens automatically when a DE's confidence in an answer is low, when a guardrail is triggered, or when a rule says a topic always needs a person. Escalated items land in **My Tasks → Approvals & Drafts** for someone on your team to review.

**Control Fabric**
The umbrella term for the three things that make a DE governable: **grounding** (it answers only from your knowledge, and cites it), **guardrails** (rules that block or route sensitive work), and **audit** (a durable record of everything that happened). The Control Fabric is what separates DreamTeam from a plain AI chatbot — it is the layer that lets you trust the workforce with real tasks.

## Tips & best practices

- Start by getting the **Knowledge Base** right — a DE is only as good as what it can read.
- Keep new DEs at a **low trust level** and review their drafts until they have earned confidence.
- Treat **guardrails** as your safety net: a rule that never triggers costs nothing, and one that does can save a customer relationship.

## Related articles

- [what-is-dreamteam-ai](what-is-dreamteam-ai.md)
- [navigating-the-app](navigating-the-app.md)
- [company-setup-wizard](company-setup-wizard.md)
