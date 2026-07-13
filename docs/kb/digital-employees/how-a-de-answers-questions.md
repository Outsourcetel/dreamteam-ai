---
title: How a Digital Employee Answers Questions
category: Digital Employees
feature: Workforce / Answering
audience: admin
difficulty: intermediate
tags: [answers, grounded, confidence, escalation, guardrails, citations, hallucination]
---

# How a Digital Employee Answers Questions

## What it is
How a Digital Employee produces an answer — from your knowledge only, with a confidence score, escalating to a human when it isn't sure or when a guardrail blocks it.

## Why it matters
This is the core of why a DE is trustworthy where a generic chatbot isn't. It answers **only** from the knowledge you've given it, tells you how confident it is, and hands off to a human rather than guessing. It won't make things up.

## The answering flow, step by step
When someone asks a Digital Employee a question (in the workspace dock or the public widget), this happens:

1. **Identity is resolved.** The employee answers as its configured self — its name, title, purpose, and responsibilities are written into its instructions. A **paused or retired** employee never answers (see below).
2. **The verified answer cache is checked.** If this exact question was answered well before, the stored answer is returned instantly, cited. The cache only holds near-identical repeats — it never serves a neighbouring but different question.
3. **Knowledge is retrieved.** The platform searches the documents this employee is allowed to see — everything company-wide plus anything scoped specifically to it — using a combined keyword-and-meaning search. If there are **no knowledge documents at all**, the employee says so honestly and asks you to add some, rather than inventing an answer.
4. **The model answers from those documents only.** The instruction is explicit: answer only from the provided documents, and if they don't contain the answer, say so plainly and set confidence low. The employee returns an **answer**, a **confidence** score (0–100), the **sources** it used, and whether it needs escalation.
5. **Guardrails check the answer.** Before anything is shown, the answer text is checked against your blocking guardrails. If it matches one, the answer is **withheld**, the customer sees a safe message, and it's escalated to a human.
6. **Escalation is decided.** The employee escalates if it asked to, or if its confidence is below the escalation threshold. Otherwise it answers.
7. **Everything is recorded.** The answer, its confidence, and whether it escalated are written to the conversation, to the activity feed, and to the immutable audit trail — attributed to the employee by name.

## Confidence and escalation
- **Confidence** reflects how well your documents actually support the answer — high when the documents clearly cover it, low when they don't.
- The platform **escalates to a human** when confidence falls **below 60%**, or when the model itself flags that it needs escalation. An escalation creates a human task with the draft answer attached, so a person can take over.
- You can make escalation stricter per employee in the **Escalation rules** panel: set a **frustration threshold** (an upset customer always gets a human) and **always-escalate topics** (certain phrases route to a human no matter how confident the employee is). Guardrails always outrank these; the confidence floor lives on the trust dial.

## Why it won't make things up
- It answers **only** from the retrieved documents, and is told never to invent facts.
- When the documents don't support an answer, it says so and sets confidence low — which triggers escalation.
- Blocking guardrails can withhold an answer entirely and route it to a human.
- Answers built from documents scoped to one employee are never re-served to a different employee from the shared cache.

## The honest "not activated" state
A Digital Employee's answering brain runs on an AI engine key. If none is configured, the employee returns an honest **"brain not activated"** state rather than a fake answer — the retrieval and evidence still run and are recorded. There's also a per-workspace AI budget: if it's exceeded, answering pauses rather than overspending.

## Paused and retired employees don't answer
A **paused** or **retired** employee is never the answering persona. If someone explicitly asks for one, that's an honest refusal ("this employee is paused and cannot answer"), not a silent swap. When no specific employee is requested, the platform picks the next eligible one.

## Tips & best practices
- If answers are low-confidence, the fix is usually **knowledge, not the model** — add or scope the documents that cover the question.
- Use **always-escalate topics** for anything sensitive (refunds, contracts) so those always reach a human regardless of confidence.

## Troubleshooting
- **"I don't have any knowledge documents yet"** — add documents in **Knowledge → Library** and make sure they're scoped so this employee can see them.
- **Answer was blocked** — a blocking guardrail matched the draft; it was withheld and escalated. Review it in Human Tasks and check the guardrail rule.

## Related articles
- configuring-what-a-de-knows-and-does
- the-trust-dial
- de-at-work-activity
- the-specialist-desk
