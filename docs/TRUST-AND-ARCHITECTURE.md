# DreamTeam AI — Trust & Architecture

_Canonical security-review document. Last updated 2026-07-04. Companion to [PROTOTYPE-PRODUCTION-BOUNDARY.md](PROTOTYPE-PRODUCTION-BOUNDARY.md) (the honest status ledger), [SCALING-ARCHITECTURE.md](SCALING-ARCHITECTURE.md), and [ROADMAP.md](ROADMAP.md)._

**How to read this document.** Every claim carries one of three labels:
- **Live** — implemented and verified in the deployed system; traceable to a specific migration or edge function.
- **Designed** — the spec/mechanism exists, production hardening is pending.
- **Roadmap** — planned, not built. We say so plainly.

When in doubt, we downgrade the label. This document is only useful to a reviewer if it never overclaims.

---

## 1. Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│  Browser — React SPA (Vercel-hosted static assets)           │
│  Tenant console + embeddable end-user widget                 │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTPS (Supabase JWT / publishable widget key)
┌───────────────▼──────────────────────────────────────────────┐
│  Supabase (single project, US region)                        │
│  ├─ Auth        — tenant admin/manager/user seats            │
│  ├─ Postgres    — RLS on every tenant table; SECURITY        │
│  │                DEFINER RPCs with membership guards        │
│  └─ Edge Fns    — de-answer, widget-ask, playbook-execute,   │
│                   connector-zendesk, eval-run, ingest-chunks │
└──────┬──────────────────────────────┬────────────────────────┘
       │ HTTPS (API key, server-side) │ HTTPS (tenant credentials,
┌──────▼───────────────┐      ┌───────▼──────────────────────┐
│  Anthropic API       │      │  Tenant systems of record    │
│  (Claude — answers)  │      │  (Zendesk connector v1)      │
└──────────────────────┘      └──────────────────────────────┘
```

The frontend never talks to Anthropic or to a tenant's systems of record directly. All model calls and connector calls happen inside Supabase Edge Functions using server-held secrets.

### Data flow for one question ("What's our refund policy?")

1. **Browser → edge function.** The question text plus the caller's Supabase JWT (or, on the public widget, a publishable widget key). Nothing else leaves the browser.
2. **Inside `de-answer`** (Live — `supabase/functions/de-answer/index.ts`): the JWT is verified, the caller's tenant is resolved via their `profiles` row, and retrieval runs **only over that tenant's** `knowledge_docs`/`knowledge_doc_chunks` (vector-first via a tenant-guarded SECURITY DEFINER RPC, keyword fallback). A semantic answer cache is checked first — a cache hit never calls the model at all.
3. **What is sent to Anthropic:** the retrieved knowledge chunks (~6K character cap), the tenant's display name, and the question — inside a grounded-only system prompt that instructs the model to answer exclusively from those documents and return structured JSON with a confidence score. No credentials, no customer records, no cross-tenant data, no conversation history beyond the current question.
4. **What Anthropic retains:** per Anthropic's commercial API terms, API inputs and outputs are not used to train models. Anthropic is a subprocessor (see §7).
5. **After the model responds:** the answer is checked against the tenant's blocking guardrail rules; low confidence (<60) or a model-requested escalation creates a real Human Task; the conversation is persisted in the tenant's rows; a hash-chained audit event is appended.

**Current activation state (honest):** the full pipeline above is deployed but **dormant** — the `ANTHROPIC_API_KEY` edge secret is not yet set, so the LLM step returns an honest `llm_not_configured` state instead of an answer. Label for the LLM-dependent path: **Live (pending activation)**. Everything before and after the model call (auth, tenant scoping, retrieval, cache, guardrail machinery, audit) is deployed and exercised now.

## 2. Tenant isolation — **Live**

- **Row-level security on every tenant table.** Every live table (`customer_accounts`, `support_tickets`, `renewal_invoices`, `human_tasks`, `activity_events`, `knowledge_docs`, `de_conversations`, `de_messages`, `guardrail_rules`, `audit_events`, `playbook_runs`, `playbook_definitions`, `connectors`, …) carries a policy of the form `tenant_id in (select tenant_id from profiles where user_id = auth.uid())` for both read and write (migrations 011–019).
- **SECURITY DEFINER RPCs carry explicit membership guards.** Functions such as `append_audit_event`, `verify_audit_chain`, `set_connector_secret`, and `resume_playbook_on_task` re-check that the caller belongs to the target tenant before acting (or require the service role).
- **The service role exists only inside edge functions.** The browser holds only the anon key + user JWT; edge functions resolve the tenant from the JWT and scope every query to it.
- End users (a tenant's customers) are **traffic, not seats**: they never get auth accounts and reach the DE only through the widget surface (§6).

## 3. Data modes & the Systems-of-Record principle

DreamTeam never replaces a system of record — Zendesk stays the ticket SoR, billing stays in the billing system. DreamTeam is the work layer on top. Two modes, declared per connector object (migration 017):

- **Sync (ingest)** — a keyed working cache (`support_tickets` with `source` + `external_ref`, unique per tenant+source+ref), refreshed incrementally. **Live** (Zendesk v1).
- **Read-through (pass-through)** — fetched from the SoR at action time, returned, and **nothing persisted except the audit event**. **Live** (Zendesk `read_ticket`).
- **Write-back** — actions land back in the SoR (internal note, status update), gated by a per-connector action registry and audited. **Live** to the credential boundary (verified with structured auth-failure against Zendesk's API; full end-to-end proof awaits a real Zendesk workspace).

**Connector credentials:** stored in `connector_secrets` — RLS enabled with **zero policies for authenticated users**, so tenant JWTs can neither read nor write it; writes go only through `set_connector_secret`/`purge_connector_secret` (SECURITY DEFINER with membership guards); reads happen only server-side via the service role. **Live.** Envelope encryption of the stored secret via Vault/KMS: **Designed** (the named hardening step). Per-DE credential scoping: **Roadmap**.

## 4. Audit integrity — **Live**

- `audit_events` is **INSERT-only**: no UPDATE/DELETE RLS policies exist, **and** a trigger raises an exception on any UPDATE or DELETE — verified against a direct superuser attempt (migration 015).
- Every event is **hash-chained**: `hash = sha256(prev_hash ‖ tenant ‖ action ‖ detail ‖ created_at)`, computed inside the `append_audit_event` SECURITY DEFINER RPC under a per-tenant advisory lock (no forks, no gaps).
- `verify_audit_chain` recomputes the entire chain **server-side** and reports the first broken link, if any — surfaced as the "Verify chain" button on the live Audit Trail page.
- Writers today: invoice generation, approvals, guardrail config changes, guardrail blocks, DE resolutions/escalations, every playbook step, connector syncs/actions, eval runs, trust-dial changes.

## 5. AI safety controls

- **Grounded-only answering** — the DE answers exclusively from the tenant's own knowledge documents; the system prompt forbids invention and the model must cite source doc titles. **Live (pending activation).**
- **Confidence scoring + escalation** — every answer carries a 0–100 confidence; below 60 (or on model request) the answer escalates to a real Human Task instead of standing alone. **Live (pending activation).**
- **Guardrail answer checks** — tenant-configured blocking rules (`blocked_phrase`/`blocked_topic`) are checked against every generated answer in both `de-answer` and `widget-ask`; matches are withheld, replaced with a safe message, escalated, and audited as `guardrail_block`. **Live (pending activation) — honest scope: v1 is case-insensitive pattern matching, not an LLM judge.** Guardrail enforcement in the non-LLM path (invoice approval thresholds) is **Live and active today**.
- **Eval suites (Proving Ground)** — golden Q&A suites run against the real deployed DE and grade fragment-match + confidence calibration; knowledge publishes are gated on the latest run. **Live (pending activation) — honest scope: the publish gate is client-side and soft (overridable, override audited); the server-side hard gate is the named hardening step. Grader v1 is fragment matching.**
- **Trust dial (autonomy thresholds)** — per-tenant, per-action autonomy that **narrows within guardrails and never overrides them**: an invoice auto-sends only if it passes BOTH the guardrail threshold AND the dial's limit. Enforced now in invoice generation and the server-side playbook executor. **Live.** Answer-confidence floors per channel: stored and configurable now, wired into the answer path at activation (**Designed** until then).
- **Server-authoritative playbooks** — all playbook orchestration (steps, gates, resume) runs server-side in the `playbook-execute` edge function; published playbook definitions are immutable snapshots validated server-side. **Live.**

## 6. Identity & access

- **Tenant seats:** Supabase Auth (email/password today). RBAC roles (owner/admin/manager/user) with a permission matrix surfaced on the Security & Access page; MFA enrollment status surfaced per user. **Live** for auth + tenant mapping; **honest note:** the RBAC matrix and session-policy/IP-allowlist controls on that page are currently design-preview (demo data / local persistence), not enforced server-side. SSO/SAML + SCIM: **Roadmap**.
- **End-user widget:** publishable widget keys are stored **hashed (sha256) at rest** — plaintext shown once at generation, never stored (migration 014). The public `widget-ask` endpoint resolves the tenant by key hash. **Live.** Signed tenant-issued JWTs for end-user identity (tenant's backend signs, we verify): **Roadmap** (trigger: first embedded pilot).

## 7. Subprocessors & data residency

| Subprocessor | Role | Data touched |
|---|---|---|
| Supabase (US region) | Auth, Postgres, edge functions, secrets | All tenant data |
| Vercel | Static frontend hosting | No tenant data at rest |
| Anthropic | LLM inference (commercial API — inputs/outputs not used for training) | Retrieved knowledge chunks + question, per request |
| GitHub | Source code hosting | No tenant data |

Data residency: single US region in v1. Region selection: **Roadmap**.

## 8. Known limitations & hardening roadmap

We list these deliberately — a reviewer should hear them from us first.

| Gap | Current state | Hardening step |
|---|---|---|
| Widget rate limiting | Per-isolate in-memory sliding window (100/min/key) — resets on cold start, not shared across isolates | Shared counter (table/Redis-class) before real volume |
| Connector secret encryption | Service-role-only table (no client access path) | Vault/KMS envelope encryption |
| Guardrail answer check | Pattern matching v1 | LLM-judge check (after activation economics) |
| Eval publish gate | Client-side, soft (override audited) | Server-side hard gate in the ingest path |
| Penetration test | Not yet performed | Scheduled before first tenant with real production data at volume |
| SOC 2 | Not started | Roadmap; this document and the audit chain are the groundwork |
| RBAC enforcement | Roles exist; fine-grained permission matrix not enforced server-side | Policy enforcement per role |
| SSO/SAML, SCIM | Not built | Roadmap (enterprise tier trigger) |
| LLM activation | Pipeline deployed dormant (no ANTHROPIC_API_KEY set) | R1 activation + full E2E re-test |

**The standing rule** (from PROTOTYPE-PRODUCTION-BOUNDARY.md): real customer data is supported only in the live, RLS-backed production track described above — never in the demo surfaces.
