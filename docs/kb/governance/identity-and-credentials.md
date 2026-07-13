---
title: Identity & Credentials — the security review inventory
category: Governance
feature: Identity & Credentials
audience: admin
difficulty: intermediate
tags: [identity, credentials, inventory, security review, access grants, connector health, trust level, audit]
---

## What it is

**Identity & Credentials** is a single, read-only inventory that answers the first question a security reviewer or auditor asks: *"Which digital worker holds which live credential and grant, across every connected system?"* For each Digital Employee and Specialist, it lists every connected system that worker can reach, what it can do there, whether a credential is stored, and how healthy the connection is.

It is **reporting only** — it never changes access, and it **never shows a secret value**. It only reports *whether* a credential is stored (a yes/no), not the credential itself.

Find it under **Governance → Identity & Credentials**.

## Why it matters

Access rules, connector credentials, and earned trust levels live in different parts of the product. When someone asks "what can our AI workforce actually touch, and with what keys?", you don't want to piece the answer together from three screens. This page is that answer, cross-referenced and on one screen — exactly what you hand to a security-conscious prospect or an auditor.

## What the summary tells you

Four figures sit at the top:

- **Identities** — the number of Digital Employees plus Specialists.
- **Active grants across all systems** — how many system-access grants exist in total.
- **Systems with a stored credential** — how many connections actually hold a secret.
- **Currently failing connections** — connections that are erroring, highlighted if any exist.

## What each identity card shows

Expand a Digital Employee or Specialist to see every system it can touch. For each system:

- **What it can do** — in plain language ("can read", "can ingest into knowledge", "can write to"), and whether that came from a **system-specific grant** or a **category default**.
- **Connection health** — Healthy (with the last successful check time), Failing (with a consecutive-failure count), Not connected, or Never checked.
- **Credential** — **Credential stored** or **No stored credential**. The value is never displayed.
- **Trust level** — a plain sentence describing the earned trust for this system: level 0 always requires human approval; higher levels may let non-destructive actions auto-execute, while destructive actions always require human approval (a platform floor).
- **Possible actions** — for write-back systems, the specific actions that could be invoked if a write is triggered, with destructive ones flagged with a warning marker.

## What this view covers — and doesn't (honest)

The page documents its own scope:

- **Covered:** every grant from Data Access, cross-referenced with real connector health, the earned trust level, and the actions each identity could invoke.
- **Never shown:** the actual credential or secret value. This page reports only whether one is stored — matching how credentials are held platform-wide (server-side only, with no path for the browser to read them at all).
- **Trust level shown is per action-category**, not per individual action — the same dial that governs whether that identity's writes on a system can ever auto-execute.
- **To change access:** use **Governance → Data Access**. This page makes no changes.

## Tips & best practices

- Use this page to **spot over-provisioned workers** — an identity with write-back on a system it never needs to write to is a grant worth trimming in Data Access.
- Check the **Currently failing connections** figure regularly; a failing credential is both a reliability and a hygiene issue.
- Bring this page (or its figures) to a **security questionnaire** — "no secret value is ever shown, credentials are server-side only" is a strong, verifiable statement.

## Troubleshooting

- **"This is a live-workspace feature."** The inventory reports on real connected systems, so it only applies in a live workspace. Demo companies have no real systems to report on.
- **An identity shows "No access anywhere."** That worker holds no grant on any connected system yet — grant access in [data-access-controls](data-access-controls.md) if it needs any.
- **A credential shows as stored but the connection is failing.** The secret exists but isn't working (expired, rotated, or revoked at the source). Re-connect the system under **Systems → Connectors**.

## Related articles

- [governance-overview](governance-overview.md)
- [data-access-controls](data-access-controls.md)
- [security-and-access](security-and-access.md)
- [trust-and-architecture](trust-and-architecture.md)
