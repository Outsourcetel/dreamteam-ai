# Prototype → Production Boundary

**Purpose:** DreamTeam AI is a **design-validation prototype with a production track underway**. This document is the single source of truth for what is demo-only, what carries forward to the enterprise product, and what is now live. Read this before building or selling anything.

_Last updated: 2026-07-03_

---

## 0. Production track status — Customer section (P1 + P2 SHIPPED)

The Customer entity section is now a **real product** for real tenants, backed by Supabase:

**P1 — data layer (done):**
- Schema: `supabase/migrations/011_customer_entity.sql` — `customer_accounts`, `support_tickets`, `renewal_invoices`, `human_tasks`, `activity_events`. All tenant-scoped with RLS (profiles → tenant_id lookup), money in cents, `updated_at` triggers, tenant indexes. **Must be applied via Supabase SQL Editor** — the frontend degrades gracefully (provisioning notice) if it hasn't been.
- API layer: `src/lib/customerApi.ts` — typed CRUD, invoice generation with a $10K human approval gate, `decideHumanTask` (persists decided_by, flips gated invoices to `sent`, appends activity), CSV import with a robust client-side parser (`parseCsv`).
- Mode switching: `src/lib/dataMode.ts` + AuthContext — tenants other than the demo tenant (`a0000000-…0001`) or the dev demo login are **live**; the Sidebar company picker shows the real tenant as the primary workspace with TCP/PWC under a "Demo companies" divider so live users can still explore the demo story.
- Live pages: Command Centre (real KPIs + activity feed), Customer Success (real accounts + Add/Import), Support (real tickets table + stats), Renewal & Expansion (real invoices, gated generation), Human Tasks (real approve/reject persisted to DB). Import modal: `src/components/ImportCustomersModal.tsx` (Accounts/Tickets tabs, paste or file, auto column mapping, per-row error report).

**P2 — real DE pipeline (done):**
- Schema: `supabase/migrations/012_knowledge_docs.sql` — `knowledge_docs`, `de_conversations`, `de_messages`, RLS same pattern as 011. Applied and verified.
- Brain: `supabase/functions/de-answer/index.ts` (deployed) — resolves tenant from the caller's JWT, retrieves the tenant's `knowledge_docs` by keyword overlap (top 3, ~6K char cap), calls Claude (`claude-sonnet-5`) with a grounded-only system prompt returning strict JSON `{answer, confidence, sources, needs_escalation}`, persists the conversation, and **auto-escalates** (real `human_tasks` row + `activity_events`) when confidence < 60 or the model asks for escalation.
- Knowledge upload: Knowledge → Library in live mode is the tenant's real `knowledge_docs` (add/paste, .txt/.md upload, edit, delete) — `src/lib/knowledgeApi.ts`, `src/pages/tenant/knowledge/LiveKnowledgeLibrary.tsx`. Demo mode keeps the seeded 4D library.
- Chat: `DEChatDock` in live mode fronts the real DE (Alex, Customer Support DE) — real confidence chip, "From: <doc titles>" sources line, true escalation banner linking to Human Tasks. Demo mode keeps the scripted intents.
- **Activation:** the pipeline is deployed but dormant until the `ANTHROPIC_API_KEY` Edge Function secret is set — see `docs/ACTIVATE-DE.md`. Until then the dock shows an honest "DE brain not yet activated" notice.

**P2.5 — scale foundation (done):** account dimension (4-level tenancy), pgvector chunk retrieval with free edge embeddings, semantic answer cache, usage metrics, end-user widget surface (widget keys + public widget-ask + embeddable widget.js). See SCALING-ARCHITECTURE.md.

**P3 — COMMITTED SCOPE: the Workforce Engine.** Answering questions is a Support DE's first duty — but what separates a Digital Employee from a chatbot is the employee machinery around it. Nothing ships in production P3 that a chatbot competitor could also claim. The minimum set:
1. **Guardrail enforcement in the real path** — tenant-configurable rules checked against every DE output/action; BLOCKED events recorded. (Control Fabric made real.)
2. **One real playbook executed end-to-end** — renewal flow: trigger → generate invoice → guardrail check → human gate → send → record. The DE *does work*, not just answers.
3. **Real immutable audit events** for both.
Deferred behind these: more channels, more integrations, retrieval polish.

**Still design-preview even in live mode:** Business Development, Sales, Onboarding stages of the Customer journey; Vendors & Partners; Workforce entity; Outcomes pages; Knowledge/Intelligence/Governance sections; the Customer overview journey-stage stats.

## 1. What this codebase IS today

A polished frontend prototype used to:
- Validate the entity/outcome operating model with real prospects (TCP Software, PWC demo companies)
- Close product design decisions cheaply before they get expensive
- Serve as the visual and interaction spec for the production build

The demo companies remain **not production**. Real customer data is supported only in the Customer-section live pages listed above, for real tenants, behind RLS.

## 2. Demo-only (will be REPLACED, do not invest in hardening)

| Piece | Why it's disposable |
|---|---|
| `src/data/companies.ts`, all page seed data | Hardcoded demo numbers; replaced by real APIs |
| localStorage persistence (health configs, DE profiles, thresholds) | Browser-only, per-device; replaced by tenant DB |
| Company switcher (TCP/PWC) | Demo device; production = one tenant per org, real tenancy |
| Rule-based "agent brain" (keyword scorer + FT search) | Replaced by real LLM orchestration layer |
| Remaining legacy pages awaiting Phase-4 migration (CustomerPortal, FinanceControlTower, ImplementationWorkspace, DataConnectors, Playbooks, Approvals, KnowledgeHub/Data, AuditLog, Security) | Content migrates into new pages, then files are deleted |
| Mock auth users / demo tenants | Replaced by full Supabase (or successor) auth + RBAC |

## 3. Production-intent (KEEPS its value — protect and refine)

| Asset | Where it lives |
|---|---|
| **Domain model** — DE, Guardrails (industry template + customer overrides + per-DE restrictions), Human-Loop touchpoints, Knowledge taxonomy (Entity × Audience × Type × Confidence), gap-detection → resolution loop, configurable self-learning with validation gates | Memory docs + implemented shapes in `WorkforceDEsPage`, `DashboardPage` types |
| **Information architecture** — entity/outcome navigation, legacy-department mapping for transition, Command Centre layout | `Sidebar.tsx`, `App.tsx` routing, `DashboardPage.tsx` |
| **UI components and visual system** — dark theme, card/table/badge patterns, 10-tab DE profile | `src/pages/tenant/*`, `src/components/*` |
| **Architecture doc** — 10 service layers, service boundaries, tenant-isolation and vendor-independence rules | Project memory (`architecture.md`) |
| **TypeScript interfaces** for DE profile, guardrails, human loop, health config | `WorkforceDEsPage.tsx`, `DashboardPage.tsx` — extract to `src/types` during production build |

## 4. Gate criteria — when to start the production track

Start the production build when **all** of these are true:

1. **Product model is stable** — Phases 4–7 complete and the entity/outcome + DE profile design has survived at least 3 real prospect walkthroughs without structural change requests.
2. **A committed design partner exists** — at least one customer with a signed pilot (or strong LOI) willing to run real data through the system.
3. **The core loop is specified end-to-end on paper** — for one concrete use case (e.g. support ticket resolution): data in → DE acts → guardrails checked → human gate → audit written. No unresolved "TBD" in that chain.
4. **Budget/runway supports a 4–6 month backend build** — multi-tenant schema, API layer, LLM orchestration, audit infrastructure, security review.

## 5. Production build — what gets built fresh (not migrated)

- Multi-tenant Postgres schema with row-level security; **no cross-tenant access, ever**
- API layer between UI and data (UI never queries tables directly)
- LLM orchestration: provider-abstracted, confidence scoring, fallback routing
- Immutable audit log (append-only), guardrail versioning
- Real ingestion pipeline (embeddings, chunking, citations)
- Observability, rate limiting, SSO/SCIM, pen-test before first real tenant

The frontend is **rewired to real APIs, not rewritten**. Estimated reuse: most of the UI, ~all of the domain model, none of the data layer.

## 6. Rules until then

- New features go into the prototype fast and cheap — do not gold-plate demo code
- Never present the prototype as production-ready to a customer; it's a design preview
- Any real customer data requires the production track — no exceptions
- Keep this document updated when the boundary moves
