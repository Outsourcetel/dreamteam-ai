---
title: Managing Digital Employee Changes — Versioning, Ownership, Pausing, and Retiring
category: Digital Employees
feature: Workforce / Governance
audience: admin
difficulty: advanced
tags: [governance, config version, ownership transfer, pause, retire, audit]
---

# Managing Digital Employee Changes

## What it is
The governance controls for an existing Digital Employee: editing and **versioning** its configuration, **transferring ownership**, and **pausing** or **retiring** it. These live in the **Governance** panel (and the **Lifecycle** panel) on the employee's profile.

## Why it matters
A Digital Employee is an accountable member of your workforce, so changing one is a governed act, not a quiet edit. Every configuration change is versioned and audited, ownership is explicit, and stopping an employee — temporarily or permanently — has real teeth: **a paused or retired employee stops answering and stops working.**

## Before you start
Most of these actions require **workspace owner or admin** rights, enforced on the server.

## Editing and versioning configuration
In the **Governance** panel, the header shows the current **config version** (e.g. *config v3*).

1. Click **Edit configuration** to change the employee's name, persona name, description, department, confidence threshold, or default approval requirement.
2. Save. The **config version increments only when something genuinely changed**.
3. Click **View config history** to see every change on record — the operation, who made it, and when.

Note that a few things are deliberately **not** editable here: **trust level** (governed by the evidence-based promotion flow) and **status / lifecycle stage** (governed by the lifecycle and retirement controls). This keeps those on their proper governed paths.

## Transferring ownership
Every employee has an **owner** — the person accountable for it.

1. In the Governance panel, next to **Owner**, click **Transfer**.
2. Choose a **new owner** from your active team members and add an optional note explaining why.
3. Confirm.

Transfer is recorded as a narrative audited event, not just a column change.

## Pausing and resuming
Use pause when you need to stop an employee immediately — for investigation, or because something looks wrong. In the **Lifecycle** panel:

1. Enter a **pause reason** (required) and click **Pause**.
2. To bring it back, enter a **resume note** on what was investigated or remediated (required) and click **Resume**.

What pausing actually does (it has teeth):

- The employee **stops polling its inbox, stops answering, and stops running playbooks**.
- If someone explicitly asks a paused employee a question, it's an honest refusal — not a silent swap to another employee.
- Its **trust level, grants, and configuration are retained** — it's paused pending investigation, not stripped. Resuming returns it to the stage it paused from.
- Because it stops owning its inbox, its **team backup or the specialist desk covers** in the meantime.

## Retiring an employee
Retirement is **terminal** — a retired employee cannot be reactivated. In the Governance panel, click **Retire**:

1. The platform first **checks for open dependencies** and shows exactly what's blocking, if anything: open conversations, pending approvals, playbook assignments, and active charter bindings.
2. If there are blockers, retirement is **refused on the server** (not just discouraged) until you resolve them — the modal lists each one.
3. Enter a **reason** (required) and confirm.

What retirement does:

- The employee's configuration **locks read-only** and its full history is **retained** (the row is never deleted).
- Like pausing, a retired employee **stops answering and stops working**.

## Tips & best practices
- **Pause before you retire** if you're unsure — pause is reversible and retains everything; retirement is not.
- Write meaningful pause reasons and resume notes. They're your investigation record on the audit trail.
- Resolve the listed dependencies (reassign playbooks, clear pending approvals) before retiring, rather than forcing it — you can't.

## Troubleshooting
- **"Cannot retire yet — resolve first"** — open dependencies remain; the modal lists exactly which. Clear them, then retry.
- **A paused employee isn't answering** — that's expected. Resume it (with a note) to bring it back.
- **Can't edit a retired employee** — retirement locks configuration read-only by design; it's terminal.

## Related articles
- the-de-lifecycle
- the-trust-dial
- the-specialist-desk
- de-health-and-development
