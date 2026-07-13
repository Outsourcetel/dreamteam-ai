---
title: Configuring What a Digital Employee Knows and Does
category: Digital Employees
feature: Workforce / DE Profile
audience: admin
difficulty: intermediate
tags: [knowledge scope, data access, control fabric, responsibilities, playbooks, grants]
---

# Configuring What a Digital Employee Knows and Does

## What it is
Setting the three things that define an employee's actual scope: the **knowledge** it can read, the **systems** it can touch, and the **responsibilities and playbooks** that describe what it does.

## Why it matters
A Digital Employee is only as capable — and only as safe — as what you deliberately give it. Nothing is implicit. A DE reads no scoped knowledge, touches no system, and runs no playbook until you grant it. This is the Control Fabric: a grant is **necessary but never sufficient** — guardrails and approval gates still apply on top of everything you allow.

## Before you start
- You need **owner or admin** rights for most of these changes.
- Have your knowledge documents and connectors already set up (see the Knowledge and Connectors sections of the help center).

## Knowledge scoping
Every employee automatically reads every **company-wide** document. On top of that, you can scope specific documents to specific employees.

- The **Knowledge scope** panel on the profile shows how many documents are scoped specifically to this employee.
- You manage scoping from the **Knowledge Library**, using each document's **"Who can use this"** setting — not from the DE profile. The profile panel is a status summary and links you there.

When the employee answers a question, retrieval is subject-aware: it searches company-wide documents plus the documents scoped to that employee, and nothing else.

## System access (the Control Fabric)
The **What this employee can touch** panel shows the employee's data-access grants — which connectors or categories it can reach, and at what permission level (for example *search* vs *write-back*).

- By default a new employee has **no system access** — it can't search, read, or act on any connected system.
- Grants are managed centrally under **Governance → Data Access**, not on the profile (the profile panel is read-only and links you there).
- Permission levels matter for the lifecycle and for proactive work: an employee needs at least a **searchable** grant on a system before it can own that inbox.

Remember the composition rule: a grant lets an employee *attempt* an action, but guardrails and the trust dial still decide whether it actually goes through.

## Responsibilities
Open the **Identity & Purpose** panel to set the employee's **responsibilities** — one per line, in plain language (e.g. *Answer customer product questions*, *Draft ticket replies for approval*). These do real work:

- They're written into the employee's working instructions and shape how it answers.
- At least one responsibility is required to advance the employee past the **Configured** lifecycle stage.

Also here: **display title**, **purpose statement**, and **primary business outcome**, all of which feed the employee's answering identity.

## Playbooks (its operating charter)
The **How this DE operates** panel is the employee's operating charter — the playbooks it runs and in what order.

1. Click **+ Assign a playbook** and pick a **published** playbook.
2. Use the **↑ / ↓** arrows to set priority — when more than one active playbook matches the same trigger, the **lowest-numbered** priority runs first.
3. Use **pause** / **resume** to toggle an assignment, or **remove** to unassign it (it stops running for this employee immediately).

A DE only runs playbooks it's directly assigned. If you have no published playbooks yet, build one in **Playbooks** first.

## Tips & best practices
- Grant knowledge and access in the smallest scope that lets the employee do its job. You can widen later.
- Keep responsibilities concrete and outcome-focused — they double as the employee's instructions.
- Assign playbooks only after the employee has the knowledge and access those playbooks assume.

## Troubleshooting
- **Employee can't answer from a document** — check the document's "Who can use this" scope in the Knowledge Library, and confirm the knowledge is embedded (searchable). The lifecycle's **Tested** criterion checks exactly this.
- **Employee isn't picking up inbox work** — it needs a searchable grant on that system *and* an operational lifecycle stage (Assigned or beyond).

## Related articles
- the-de-profile-page
- the-de-lifecycle
- how-a-de-answers-questions
- the-specialist-desk
