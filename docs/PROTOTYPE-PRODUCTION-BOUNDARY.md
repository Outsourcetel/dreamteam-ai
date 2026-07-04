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

**P3 — the Workforce Engine (SHIPPED):** What separates a Digital Employee from a chatbot is the employee machinery around it. All three commitments are live:
1. **Guardrail enforcement in the real path** — `guardrail_rules` (migration 015), managed in Compliance & Guardrails live mode ("Install starter guardrails" for empty tenants). Enforced NOW in the non-LLM path: `generateInvoice`/`decideHumanTask` read the tenant's `require_approval_over_cents` rule (fallback $10K) and record a `guardrail_check` audit event either way. Enforced in the LLM path: `de-answer` and `widget-ask` check every generated answer against active blocking `blocked_phrase`/`blocked_topic` rules — matches are withheld, replaced with a safe message, escalated to Human Tasks, and recorded as `guardrail_block`. *Honest notes:* the answer check is simple case-insensitive pattern matching (v1 — no LLM judge), and it executes only when `ANTHROPIC_API_KEY` is set (deployed dormant until then, same as the P2 brain).
2. **One real playbook end-to-end** — `renewal_v1` (`playbook_runs` + `src/lib/playbookApi.ts`): check account → generate invoice → guardrail check → human gate → send → record. Gated runs pause (`waiting_approval` + `waiting_task_id`); deciding the Human Task resumes (approve → sent + cadence Day-0 + complete) or cancels (reject) the run. Run/steps UI on Renewal & Expansion; run history on Playbooks live mode. *Honest note:* orchestration was client-side v1 — **superseded by R4 below (server-side executor shipped)**.
3. **Real immutable audit events** — `audit_events`: INSERT-only (no update/delete RLS policies **plus** a trigger raising on UPDATE/DELETE, verified against a direct superuser attempt), hash-chained (`hash = sha256(prev_hash‖tenant‖action‖detail‖created_at)`) inside the SECURITY DEFINER RPC `append_audit_event` with a per-tenant advisory lock. `verify_audit_chain` recomputes the whole chain server-side — surfaced as the "Verify chain" button on the Audit Trail live page. Writers: invoice generation, approvals, guardrail config changes, DE resolutions/escalations/blocks, every playbook step.
Deferred behind these: more channels, more integrations, retrieval polish, LLM-judge guardrails.

**R4 — server-side playbook executor (SHIPPED):** orchestration is now **server-authoritative**. The `playbook-execute` edge function (deployed) runs every renewal_v1 step with the service role — guardrail threshold + trust-dial composition, invoice, human gate, hash-chained audit events — so runs survive closed tabs. Idempotent: advancing a run whose gate task is undecided is a no-op; completed/cancelled runs are never re-executed. Human-gate resume is server-side too: `resume_playbook_on_task` (migration 016, SECURITY DEFINER) does the whole resume in SQL (status flips, invoice → sent + cadence Day-0, audit events); `decideHumanTask` calls the RPC, with an edge-function `advance` fallback if the migration is missing. `src/lib/playbookApi.ts` is now a thin start/observe/cancel client; the run panel shows a "server-run" chip. Verified end-to-end via curl: start → waiting_approval → task approved → run completed, audit chain grown and intact.

**R5 — trust dial v1 (SHIPPED):** `de_autonomy` (migration 016) stores per-tenant, per-action autonomy: `invoice_auto_send` (max amount), `answer_dock` / `answer_widget` (confidence floors, dormant until R1 activation). **Composition rule: autonomy narrows within guardrails, never overrides them** — an invoice auto-sends only when it passes BOTH the guardrail approval threshold AND (no autonomy row OR enabled with amount ≤ its max). Enforced now in `generateInvoice` and the playbook-execute gate; auto-sends under the dial are labelled "auto-approved under trust dial (≤ $X)" in the step timeline and the audit event records the autonomy rule id. First live DE-profile surface: Workforce → Digital Employees live mode shows Alex + the trust dial panel (`src/pages/tenant/LiveWorkforceDEs.tsx`) with an evidence line computed from approval audit events; every dial change appends a `config_change` audit event.

**R6 — tenant playbook builder (SHIPPED):** tenants build their own playbooks from a **typed step-primitive registry** (documented in `supabase/functions/playbook-execute/index.ts`): `check_account`, `generate_invoice` (runs the full R5 guardrail + trust-dial composition), `human_approval` (explicit gate — skipped when the invoice auto-approved within limits, mirroring renewal_v1), `guardrail_check` (audited re-check point), `connector_action` (Zendesk write-back with **honest degradation** — no connector/target → recorded `skipped`, run continues), `update_record` (whitelisted status flips only), `log_activity`, `complete`. Templates `{{account.name}}` / `{{invoice.amount}}` / `{{run.id}}` render from run context. Schema: migration 019 — `playbook_definitions` (draft→published→archived, tenant RLS) + `playbook_versions` (**immutable publish snapshots**; runs bind to a snapshot version, never the live draft); `playbook_runs` gained `definition_id`/`definition_version`/`context`. Publishing goes through the edge function's `publish` action: server-side validation with structured errors (unknown primitive, bad params, >20 steps, step-ordering rules, human_approval-after-generate_invoice, post-gate primitive restrictions) → version bump + snapshot + `config_change` audit. **Resume split (honest):** `resume_playbook_on_task` (replaced in 019) advances post-gate steps natively in SQL (guardrail_check/update_record/log_activity/complete — zero HTTP); a post-gate `connector_action` parks the run in `resume_pending` and the edge `advance` (fired by decideHumanTask) finishes it. Builder UI on Playbooks live mode (`src/pages/tenant/systems/LivePlaybookBuilder.tsx`): step editor with per-primitive param forms, live validation (client mirror; server is the authority), reorder, template help, publish, run-with-account picker, per-run step timelines. Legacy `renewal_v1` path untouched — regression-verified via curl alongside the full definition E2E: publish → gated run → SQL resume (parked `resume_pending`) → HTTP advance → completed with connector step honestly `skipped`, audit chain intact. *Honest notes:* manual trigger only (`schedule`/`event` reserved); one invoice + one gate per playbook in v1; `update_record` whitelist is invoice/ticket status only.

**R2 — Systems-of-Record connector layer v1 (SHIPPED):** the SoR doctrine made real (see SCALING-ARCHITECTURE.md §Systems-of-Record).
- Schema: `supabase/migrations/017_connectors.sql` — `connectors` (tenant-scoped, RLS), `connector_secrets` (**service-role-only**: RLS enabled with zero authenticated policies; written only via the `set_connector_secret`/`purge_connector_secret` SECURITY DEFINER RPCs, never readable from the client), `connector_objects` (per-object mode `sync` vs `read_through` + interval + enable), `connector_actions` (write-back registry). `support_tickets` gained `external_ref` + `source` (unique on tenant+source+external_ref) so synced tickets are a keyed working cache. `audit_events` categories extended with `connector_sync`/`connector_action`.
- Zendesk connector v1: `supabase/functions/connector-zendesk` (deployed) — `test` (auth check), `sync_tickets` (incremental pull → upsert into `support_tickets`, **300-ticket cap per run**, status/priority mapping documented in-source, account match via requester-org `external_ref`), `read_ticket` (read-through: fetched live, returned, **nothing persisted except the audit event**), `write_back` (`add_internal_note`/`update_status` PUT back into Zendesk, gated by the action registry, audited).
- UI: Connectors page live mode (`LiveConnectorsPage.tsx`) — connect flow (Test & Save), per-object mode table, write-back toggles, Sync now, read-through demo, disconnect (credential purge). Support page shows a "Zendesk" source chip on synced tickets.
- *Honest notes:* v1 is Zendesk only (Zuora/Salesforce/Workday are catalog placeholders); tokens sit in a service-role-only table — Vault/KMS encryption is the hardening step; write-back ops are note+status only; per-DE credential scoping and webhook/TTL auto-refresh are next; verified to the credential boundary (real Zendesk trial needed for end-to-end proof).

**R3 — live Proving Ground v1 (SHIPPED):** golden Q&A eval suites run against the REAL DE. Schema: `supabase/migrations/018_proving_ground.sql` — `golden_qa` (question, expected_fragments text[], min_confidence, category, active; tenant RLS), `eval_runs` (tenant-read RLS; writes only via the runner's service role), `eval_gate` view (latest finished run per tenant, security_invoker). Runner: `supabase/functions/eval-run` (deployed, JWT-authed) — loads the tenant's active questions (hard cap 50, sequential + 250ms delay: cost-bounded), calls the deployed `de-answer` over HTTP **forwarding the caller's JWT** (tenant scoping stays honest — verified end-to-end), grades pass = all expected fragments present (case-insensitive) AND confidence ≥ floor, writes progress after each question, appends an audit event (`config_change` + `detail.kind='eval_run'`). If de-answer returns `llm_not_configured` the run finishes as **`blocked_llm`** — verified live against the demo tenant (runner reached the real LLM gate and stopped honestly). Publish gate: `getEvalGate()` in `src/lib/evalApi.ts`; LiveKnowledgeLibrary checks it before create/upload — a failing latest run opens an override dialog ("Publish anyway" is audited as `eval_gate_override`, with a link to the Proving Ground). UI: Proving Ground live mode (`LiveProvingGround.tsx`) — suite editor, starter-suite generator (5 template questions from knowledge doc titles — honest client-side v1, editable), live-polled run results, run history, gate banner. *Honest notes:* grader v1 is fragment matching + confidence calibration (LLM-judge grading is the upgrade); the publish gate is client-side soft (server-side hard gate in ingest-chunks is the hardening step); runs are dormant (`blocked_llm`) until the ANTHROPIC_API_KEY lands.

**Still design-preview even in live mode:** Business Development, Sales, Onboarding stages of the Customer journey; Vendors & Partners; Workforce entity; Outcomes pages; Knowledge gaps/Intelligence sections; the Customer overview journey-stage stats. (Compliance & Guardrails, Audit Trail, and Playbooks now have real live modes.)

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
