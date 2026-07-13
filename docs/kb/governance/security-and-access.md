---
title: Security & Access — team, roles, MFA, API keys, and network controls
category: Governance
feature: Security & Access
audience: admin
difficulty: intermediate
tags: [security, access, roles, rbac, mfa, api keys, session policy, ip allowlist, sso, saml, sub-accounts]
---

## What it is

The **Security & Access** page is where you manage the human side of your workspace: who your team members are, what each role can do, whether they use multi-factor authentication, the API keys that programs use to reach your data, how long a session lasts, and which networks may sign in.

Find it under **Governance → Security & Access**.

## Why it matters

Digital Employees are governed by guardrails and data-access grants. The *people* who configure them need controls too. This page is where you keep the human perimeter tight — least-privilege roles, enforced MFA, revocable API keys, and a network allowlist — so that access to your AI workforce is as controlled as the workforce itself.

## Before you start

- Most controls here — MFA status, API keys, the IP allowlist, saving the session policy — require a **workspace owner or admin** role. Other members can view the page but not change these.
- The permission matrix and human-user list are visible to your team; sensitive panels show an "owner/admin only" note when you lack the role.

## Roles & Permissions

The **Roles & Permissions** matrix shows every built-in role and the permission areas each one carries. Roles include **Owner**, **Admin**, **Manager**, **Knowledge manager**, **Approver**, **User**, and **Read-only**. A check mark means that role has that permission area.

This matrix is a **reference to what the platform enforces**, not an independently editable table — the roles map to real access-control policy in the backend. There is no per-workspace custom role builder today; you assign people to these built-in roles (full member management lives on the **Users** page).

## Human Users

The **Human Users** panel lists your real team members — name, email, role, MFA status, and last active. MFA status shows **Enabled** or **Missing** for each person (visible to owners/admins), so you can see at a glance who still needs to enroll a second factor.

## SSO / SAML — honest status

SSO / SAML is **not available yet** on this workspace. The identity system behind DreamTeam has native SAML 2.0 support, but it requires a paid plan of the underlying auth provider; the current workspace is on a plan that doesn't include SSO. The page states this plainly. Once the underlying project is upgraded, SSO can be enabled with no rebuild. SCIM user provisioning is also on the roadmap, not built.

## Session Policy

The **Session Policy** panel sets two real, enforced controls:

- **Session timeout (inactivity)** — 1h, 4h, 8h, or 24h. After this much inactivity a user is automatically signed out.
- **MFA required** — when on, the app is blocked until a human user enrolls a second factor.

Both are enforced in the app's sign-in flow. A note explains that **re-authentication for sensitive areas** is not yet enforced for regular workspace actions (platform-level Remote Access already requires a verified 2FA code).

## API Keys

API keys let external programs read (and, with the right scope, write) workspace data. On the **API Keys** panel (owner/admin only):

1. Click **+ Create key**.
2. Give it a **Name** (e.g. *Analytics export*).
3. Choose one or more **Scopes**: `read:analytics`, `read:knowledge`, `read:conversations`, `write:knowledge`.
4. Click **Create key**. The full key is shown **once** — copy it immediately; for security it is stored only as a hash and can never be retrieved again.

To retire a key, click **Revoke**. Anything using it stops working immediately, and revocation can't be undone.

## IP Allowlist

The **IP Allowlist** restricts sign-in to approved network ranges (owner/admin only):

1. Toggle the allowlist **on**.
2. Add at least one range in CIDR form (e.g. `192.168.1.0/24`) with an optional label (e.g. *Office WiFi*).
3. While disabled, all networks are allowed.

The allowlist is checked **once per session at sign-in**, not on every request — the page says so directly. Add a range you're currently on before enabling, so you don't lock yourself out.

## Manage Sub-Accounts

Owners/admins of an eligible workspace see a **Manage Sub-Accounts** panel to create a smaller, isolated workspace under your account — useful for agencies serving their own customers. Depending on whether self-serve is enabled for you, the request either creates the sub-account immediately or is submitted to DreamTeam AI for approval. Your data stays separate from the sub-account's.

## Tips & best practices

- Turn on **MFA required** and set a sensible **session timeout** as one of your first governance steps.
- Give each integration its **own** narrowly-scoped API key, so you can revoke one without disrupting the others.
- Enable the **IP allowlist** only after adding your current network — and keep a break-glass admin who can reach support if you're ever locked out.
- Assign the **least** role that lets someone do their job; reserve Owner/Admin for the few who truly need it.

## Troubleshooting

- **A panel says "owner/admin only."** You're signed in with a role that can't manage that control. Ask a workspace owner or admin.
- **The IP allowlist won't stay enabled.** You must add at least one range first; an enabled allowlist with no ranges shows a warning.
- **Honest note:** the RBAC matrix, session policy, and IP allowlist are surfaced here; the underlying enforcement maturity is documented candidly on the [trust-and-architecture](trust-and-architecture.md) page — read it before a security review.

## Related articles

- [governance-overview](governance-overview.md)
- [data-access-controls](data-access-controls.md)
- [identity-and-credentials](identity-and-credentials.md)
- [trust-and-architecture](trust-and-architecture.md)
