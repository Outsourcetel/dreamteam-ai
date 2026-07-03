# Prototype → Production Boundary

**Purpose:** DreamTeam AI is currently a **design-validation prototype**. This document is the single source of truth for what is demo-only, what carries forward to the enterprise product, and what has to be true before we start the production build. Read this before building or selling anything.

_Last updated: 2026-07-03_

---

## 1. What this codebase IS today

A polished frontend prototype used to:
- Validate the entity/outcome operating model with real prospects (TCP Software, PWC demo companies)
- Close product design decisions cheaply before they get expensive
- Serve as the visual and interaction spec for the production build

It is **not** a production system. Do not onboard a paying customer's real data onto it.

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
