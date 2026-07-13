---
title: The Audit Trail — an immutable, tamper-evident record
category: Governance
feature: Audit Trail
audience: admin
difficulty: intermediate
tags: [audit trail, hash chain, immutable, tamper evident, compliance, chain integrity, verify chain, activity log]
---

## What it is

The **Audit Trail** is a permanent, append-only record of everything that happens in your workspace: every Digital Employee answer, escalation, human approval, guardrail check and block, invoice, playbook step, connector sync and action, and configuration change. Records can only be **added** — never edited, never deleted, not even by an administrator.

Each record is cryptographically linked to the one before it in a **hash chain**, so any attempt to alter or remove a past record is detectable. You can verify the whole chain with one click.

Find it under **Governance → Audit Trail**.

## Why it matters

"Trust us, the AI did the right thing" is not an answer an auditor, a regulator, or a security-conscious customer will accept. A tamper-evident audit trail is proof. It lets you show exactly what a Digital Employee did, when, on whose behalf, and what the outcome was — and prove the record hasn't been quietly rewritten after the fact. It is the groundwork for compliance regimes like SOC 2.

## What gets recorded

Every meaningful event is written to the trail with an actor (a Digital Employee, a human, or the system), a category, a description, and a timestamp. Categories you'll see include:

- **Resolved** and **Escalated** — Digital Employees answering or handing off.
- **Approval** — a human approving a task, invoice, or renewal term.
- **Guardrail check** and **Guardrail block** — a rule being evaluated, and a rule stopping an answer.
- **Config change** — a guardrail edited, access changed, or similar.
- **Invoice**, **Playbook step**, **Connector sync**, **Connector action**, **Evidence step**, **Data access**.

Guardrail blocks are highlighted in red so they stand out at a glance.

## How integrity is guaranteed

Two mechanisms work together:

- **Append-only, enforced in the database.** There are no update or delete permissions on the audit records, and a database safeguard raises an error on any attempt to change or remove one — verified even against a direct database-superuser attempt. Records can only be appended.
- **A hash chain.** When a record is written, the system computes a fingerprint: `hash = sha256(previous hash + tenant + action + detail + timestamp)`. Because each record's fingerprint includes the previous record's fingerprint, the records form a chain. Change any past record and every fingerprint after it stops matching. The computation runs inside the database, in order, under a per-workspace lock so two events can't collide.

## Step by step — verify the chain

1. Open **Governance → Audit Trail**.
2. Click **Verify chain** (top right of the event list).
3. The database recomputes every record's fingerprint, in order, server-side, and reports the result:
   - **Chain intact** — all records were recomputed and verified. The **Chain integrity** stat shows *Intact* with the number checked.
   - **Chain BROKEN** — it names the first record where the chain fails. This should be impossible unless the database was tampered with directly.

Verification happens on the server, not in your browser, so the result reflects the real stored data.

## Step by step — find a specific event

1. Use the **category** dropdown to narrow to, say, only guardrail blocks or only approvals.
2. Use the **actor** dropdown to focus on one Digital Employee or person.
3. The list shows the latest 200 events, newest first, each with its chain position (`#`) and the first characters of its hash.

## The Team activity log

Above the main trail, workspace **owners and admins** see a **Team activity log**: a separate record of every change *your own team* made across the platform — who changed what, in which area, and which fields changed. Click any row to see the before-and-after values. This complements the audit trail: the audit trail is about what Digital Employees and the system did; the team activity log is about what your human staff did. Both are visible only to owners and admins.

## Options & settings

- **Filters** — category and actor, to slice the stream.
- **Chain position and hash** — hover a record's green badge to see its full hash and the previous hash it chains from.
- In demo mode, the page also offers a CSV export and date filters for the sample data; the live trail focuses on the real, verifiable event stream.

## Tips & best practices

- Run **Verify chain** before any compliance review or customer security questionnaire — a clean result is a strong, simple thing to show.
- Filter to **Guardrail block** periodically to see what your guardrails are actually catching.
- Remember the trail is **append-only by design**: if something looks wrong, you correct it going forward with a new action (which is itself recorded), never by editing history.

## Troubleshooting

- **"No audit events yet."** Nothing auditable has happened in this workspace yet. Have a Digital Employee resolve or escalate something (for example on the Renewal & Expansion page) and the records begin.
- **Chain reports BROKEN.** This indicates direct database tampering, which the normal application cannot do. Treat it as a serious security event and contact support.

## Related articles

- [governance-overview](governance-overview.md)
- [guardrails](guardrails.md)
- [trust-and-architecture](trust-and-architecture.md)
- [security-and-access](security-and-access.md)
