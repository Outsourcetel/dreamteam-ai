---
title: Data Access controls — which Digital Employee can touch which system
category: Governance
feature: Data Access
audience: admin
difficulty: intermediate
tags: [data access, default deny, permissions, grants, connectors, categories, least privilege, write-back]
---

## What it is

The **Data Access** page is the access matrix for your digital workforce: it decides which Digital Employee or Specialist may reach which connected system, and how deeply. It is **default-deny** — with no grant, every request to a connected system is refused. Nothing is open until you open it.

Find it under **Governance → Data Access**.

## Why it matters

Connected systems are tenant-wide by default: without this layer, any Digital Employee's work could touch any connected system — a support worker could reach your financials. Data Access closes that. It is your **blast-radius control**: it decides, per worker, what data even *exists* for them to touch. And because the check runs on the **server, on every call**, it can't be bypassed from the browser.

## The permission ladder

Permissions are cumulative — each level includes everything below it:

- **None** — no access. This is the default for everything.
- **Search** — can find matching records, but not open them.
- **Read** — can open and fetch individual records.
- **Ingest** — can sync content from the system into DreamTeam knowledge.
- **Write-back** — can write back to the system.

A grant is **necessary but never sufficient** for a write: write-back grants don't skip approvals. An actual write still passes through the existing human gates and trust-dial machinery — the grant only decides whether the request may exist at all.

## Two layers: category defaults and per-system overrides

Access is resolved exactly the way the server resolves it, in two layers:

1. **Category defaults** — "this worker may read any helpdesk system." A category default applies to every connected system of that kind, both the ones you have now and any you connect later. Financial, billing, and payroll categories are marked sensitive and are **never granted by default**.
2. **Per-system overrides** — a setting on one specific connected system that **beats** the category default for that system. Choosing **Inherit** falls back to the category default (or to no access if none is set).

Specific always beats general: a per-system setting wins over a category default.

## Step by step — grant access

1. Open **Governance → Data Access**.
2. In the **Category defaults** table, find the Digital Employee or Specialist row and the category column.
3. Pick a permission level from the dropdown (None, Search, Read, Ingest, Write-back). The change saves immediately and is recorded in the audit trail.
4. To override one specific system, scroll to **Connected systems — per-system overrides** and set that system's cell. Leave it on **Inherit** to keep using the category default.

Every change shows a confirmation line noting exactly what changed and that it was audited.

## Recent denials

The **Recent denials** panel lists requests that were refused, with the system, the operation, and what permission was needed versus what the worker had. Use it as a guide: if a Digital Employee keeps hitting a wall it genuinely needs, grant it here — if it doesn't need it, the wall is doing its job. Every denial is also written to the [audit trail](the-audit-trail.md).

## What this covers — and doesn't (honest)

The page states its limits plainly:

- **Covered:** every machine-driven call to a connected system — the evidence pipeline, playbook connector steps, and write-backs — is checked server-side on every request.
- **Humans are separate:** your own clicks in the connector wizard (test, health check, dry run) are governed by workspace roles, not this matrix.
- **Internal knowledge is workspace-wide (v1):** documents you upload to DreamTeam knowledge are readable by every Digital Employee and Specialist. Per-worker knowledge scopes are a named upgrade, not yet shipped.
- **Write-back grants don't skip approvals:** a write still goes through the human gates; the grant only decides whether the request is allowed to exist.

## Tips & best practices

- Grant the **lowest** level that does the job. A worker that only needs to answer from a system needs **Read**, not Write-back.
- Keep sensitive categories (financials, billing, payroll) locked to the few workers that truly need them — they start denied for a reason.
- Prefer **category defaults** for broad, future-proof rules ("support workers may read any helpdesk"), and reserve **per-system overrides** for exceptions.
- Review **Recent denials** after connecting a new system to catch legitimate work that's being blocked.

## Troubleshooting

- **"This is a live-workspace feature."** Data Access governs real connected systems, so it only applies in a live workspace — demo companies have no real systems to govern.
- **"No systems connected yet."** Connect one under **Systems → Connectors** and it appears in the per-system overrides table.
- **A grant seems ignored.** Check for a per-system override — it beats the category default. And remember a write still needs its human approval regardless of the grant.

## Related articles

- [governance-overview](governance-overview.md)
- [identity-and-credentials](identity-and-credentials.md)
- [guardrails](guardrails.md)
- [trust-and-architecture](trust-and-architecture.md)
