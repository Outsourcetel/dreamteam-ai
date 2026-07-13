---
title: Trust & Architecture — how DreamTeam is built, honestly
category: Governance
feature: Trust & Architecture
audience: admin
difficulty: intermediate
tags: [trust, architecture, data flow, tenant isolation, subprocessors, data residency, security review, limitations]
---

## What it is

**Trust & Architecture** is an honest, plain-language map of how DreamTeam is built: where your data goes, what protects it, and — deliberately — what has *not* been hardened yet. Every claim on the page is labeled with one of three states so you can tell fact from plan:

- **Live** — verified in production.
- **Designed** — the mechanism exists, but a hardening step is still pending.
- **Roadmap** — planned, not built.

Find it under **Governance → Trust & Architecture**. The same content shows in demo and live mode, because it describes the platform itself.

## Why it matters

A security reviewer should hear a product's limits from the vendor first, not discover them later. This page is written to be handed to a skeptic: it states what's real, what's designed, and what's missing, each with a named next step and nothing hidden behind marketing language. There's a **Copy as text** button to paste the whole summary into a questionnaire or email.

## The architecture in three layers

DreamTeam is a browser app on top of a secured backend on top of AI inference and your own systems:

- **Browser (React app)** — the tenant console and the embeddable end-user widget. It holds only a public key and the signed-in user's session token — never the master service credential, never an AI-engine key, never your connected-system credentials.
- **Backend (Auth · Database · Edge Functions)** — row-level security on every workspace table, membership-guarded database functions, and edge functions that hold the secrets and do the privileged work.
- **External** — the AI model (reached server-side only) and your systems of record via connectors. The frontend never talks to the AI provider or your systems directly.

## What happens to one question, end to end

The page walks through a single question:

1. **The browser sends** the question text plus the user's session token (or a publishable key on the public widget). Nothing else leaves the browser.
2. **The edge function scopes it** — verifies the token, resolves the caller's workspace, and retrieves **only that workspace's** knowledge. A semantic answer cache is checked first, so a repeat question needn't call the model.
3. **It's sent to the AI provider** — the retrieved knowledge chunks (capped in size), the workspace name, and the question, inside a grounded-only prompt that requires cited sources and a confidence score. No credentials, no customer records, no cross-workspace data.
4. **The provider retains nothing for training** — under the commercial API terms, inputs and outputs are not used to train models. The provider is listed as a subprocessor.
5. **After the answer** — the guardrail check runs, low confidence or a requested escalation creates a real Human Task, the conversation is stored in your workspace's records, and a hash-chained audit event is appended.

**Honest activation state:** the pipeline is deployed, but the AI step is dormant until an engine key is configured — it returns an explicit "not configured" state rather than an answer. Auth, workspace scoping, retrieval, caching, guardrail machinery, and audit all run today.

## Tenant isolation (Live)

Your workspace's data is separated from every other workspace's:

- **Row-level security on every workspace table** scopes reads and writes to your workspace only.
- **Membership-guarded functions** re-check workspace membership before acting.
- **The master credential lives only inside edge functions** — never in the browser.
- **Your end customers are traffic, not seats** — they never get accounts; they reach a Digital Employee only through the keyed widget.

## Audit integrity (Live)

The audit trail is append-only and hash-chained, enforced in the database and verifiable on demand. See [the-audit-trail](the-audit-trail.md) for the full explanation and the **Verify chain** button.

## Systems of record and data modes

DreamTeam never replaces a system of record — your help desk stays the ticket system, your billing system stays the billing system. DreamTeam is the work layer on top; its permanent, proprietary data is the **judgment layer** (the audit chain, playbook runs, guardrail decisions, approvals). Connectors work in sync (a keyed working cache), read-through (fetched at action time, nothing stored but the audit event), and gated write-back modes. Connector credentials are stored with **zero client access** — no browser path can read or write them.

## Subprocessors & data residency

The page lists every subprocessor and exactly what data it touches — the hosting provider (all workspace data), the frontend host (no workspace data at rest), the AI provider (retrieved knowledge chunks plus the question, per request, not used for training), and the source-code host (no workspace data). Data residency is a single US region in v1; region selection is Roadmap.

## What hasn't been done yet (stated deliberately)

The page carries a candid limitations table — each gap with its current state and its named hardening step. Highlights as of this writing:

- **RBAC enforcement** — roles exist, but the full permission matrix is not yet enforced on the server per role.
- **SSO / SAML and SCIM** — not built (an enterprise-tier trigger).
- **Connector secret encryption** — stored in a server-only table today; envelope encryption via a key-management service is the named next step.
- **Guardrail answer check** — case-insensitive pattern matching in v1; an AI-judge check is the planned upgrade.
- **Penetration test** and **SOC 2** — not yet done; the audit chain and this page are the groundwork.
- **AI activation** — the model pipeline is deployed but dormant until an engine key is set.

A standing rule closes the page: real customer data is supported only in the live, RLS-backed production track — never in demo surfaces.

## Tips & best practices

- Read this page **before** a security review, and use **Copy as text** to drop the summary straight into a questionnaire.
- Pair it with a live **Verify chain** on the [audit trail](the-audit-trail.md) — a passing integrity check is a simple, strong demonstration.
- Treat the **Designed** and **Roadmap** labels as your roadmap conversation with a prospect: each gap has a named next step you can speak to.

## Related articles

- [governance-overview](governance-overview.md)
- [the-audit-trail](the-audit-trail.md)
- [security-and-access](security-and-access.md)
- [identity-and-credentials](identity-and-credentials.md)
