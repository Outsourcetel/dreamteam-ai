# Scaling Architecture — Documents at 100K+, Inquiries at 100K+/mo, End Users in Millions

_Companion to [PROTOTYPE-PRODUCTION-BOUNDARY.md](PROTOTYPE-PRODUCTION-BOUNDARY.md). Written 2026-07-03. This is the design answer to: "TCP has 30,000 business customers whose employees all use TCP's support function — how does DreamTeam handle that?"_

## The four-level tenancy model (the core design decision)

Current shape (P1/P2): **Platform → Tenant** (row-level security on `tenant_id`).
Required shape: **Platform → Tenant (TCP) → Account (each of TCP's 30,000 business customers) → End User (that business's employees — millions)**.

Rules that fall out of this:
1. **End users are traffic, not seats.** They never get Supabase auth accounts. They reach DEs through an embedded widget/API in the tenant's own product, authenticated by a short-lived signed token the tenant's backend issues ("employee of account #4821"). Pricing follows: tenants pay for DEs + volume, never per end user.
2. **Knowledge gets an `account_id` dimension.** Tenant-global knowledge (product docs) + per-account overlays (that business's plan, settings, negotiated terms). Retrieval filters account-first, falls back to tenant-global. This is the existing Entity × Audience × Type model extended one level — a query filter, not a re-architecture.
3. **Tickets/conversations/tasks likewise carry `account_id`** so at-risk detection, escalation routing, and analytics roll up per business customer.

## Layer-by-layer scale plan

| Layer | Today (P1/P2) | Holds until | Upgrade path |
|---|---|---|---|
| **Retrieval** | keyword overlap, top-3 docs | ~50 docs/tenant | **P2.5:** chunking (~500 tokens) + pgvector embeddings + HNSW index (already enabled in Supabase). Good to ~1M chunks. Beyond: partitioning or dedicated vector store behind our own retrieval interface (interface already ours — swap is contained). |
| **Ingestion** | synchronous paste/upload | dozens of docs | Background queue: upload returns immediately; workers chunk/embed/dedupe. Re-embed on knowledge update. |
| **Inquiry path** | synchronous edge-function call | low thousands/day | Queue-first: inquiries enqueue, workers process. Adds rate limiting, retries, graceful degradation. Supabase is not the queue at scale — dedicated queue (e.g. SQS/Redis-stream class) in production infra. |
| **LLM cost** | one Sonnet call per question | pilot economics | **Semantic cache** (same-question-different-words served from verified cached answers; invalidated on knowledge change — typically 40–70% deflection in support). **Model tiering** (Haiku classifies/routes; Sonnet answers hard ones). **Anthropic prompt caching** for the repeated knowledge context. Target: blended cost per inquiry falls an order of magnitude. |
| **Identity** | Supabase auth (admin seats) | pilots | Tenant-issued JWT for end users (tenant backend signs; our edge verifies against tenant's registered public key). Widget SDK + REST API surface. |
| **Database** | Supabase Postgres, RLS | pilots → low-thousands of accounts | Postgres partitioning by tenant for hot tables (tickets, messages, activity); read replicas for analytics; then portable to managed PG/K8s per Layer 10 of the architecture (designed portable from day one). |
| **Observability** | none | pilots | Per-tenant metrics: queries, deflection rate, confidence distribution, cost per inquiry, queue depth. Required before any tenant at real volume. |

## Sequencing (build triggers, not dates)

1. **P2.5 — pgvector retrieval**: ✅ **SHIPPED** (migration 013). `knowledge_doc_chunks` (384-dim, HNSW) + `ingest-chunks` edge function (chunk ~1500 chars / 200 overlap, paragraph/sentence-aware). Embeddings are **free** — Supabase edge runtime's built-in `gte-small` model, no external API. `de-answer` retrieves vector-first via `match_doc_chunks` RPC (SECURITY DEFINER, tenant-guarded, account-first ranking) and falls back to keyword overlap when no embedded chunks exist. (Legacy 006 `knowledge_chunks` — 1536-dim, article-based — left untouched for the old article path.)
2. **Account dimension (schema-only now)**: ✅ **SHIPPED** (migration 013). `customer_accounts` **reused** as the Tenant → Account level (it already is the tenant's customer list) — added `external_ref` + `tier`. Nullable `account_id` added to knowledge_docs, de_conversations, de_messages, activity_events, human_tasks (tickets/invoices already had it), all indexed. Retrieval scoping: account-matched rows rank above tenant-global (null account_id) rows.
3. **End-user widget + tenant-token auth**: trigger = first design partner who wants their customers/employees asking questions (this is TCP's actual use case — likely early).
4. **Queue + semantic cache + tiering**: semantic cache ✅ **SHIPPED** (schema + read/write path, migration 013): `answer_cache` (384-dim HNSW), `match_cached_answer` RPC (distance < 0.15, account-first), invalidation via DB trigger on any knowledge_docs change, `hits` counter, `cached: true` "⚡ instant" chip in the chat dock. Cache **writes** stay dormant until an LLM key exists (writes happen only after a successful LLM answer). Queue + model tiering still pending their trigger.
5. **Observability groundwork**: ✅ **SHIPPED** (migration 013). `usage_metrics` (tenant × day × metric) with SECURITY DEFINER write RPCs (`increment_metric` for authenticated callers, `increment_metric_tenant` service-role-only); `de-answer` records inquiries / cache_hits / escalations / llm_calls; the Performance page shows a live-mode "Live usage (this month)" strip.
6. **Partitioning/replicas/K8s**: trigger = measured, not speculative. The 10-layer architecture keeps business logic portable.

## What we deliberately do NOT do
- No LangChain/LangGraph — orchestration (Workforce Engine: routing, gates, guardrails, audit) is our own plain code and our core IP; LLM calls stay behind our thin provider-neutral interface.
- No per-end-user accounts, ever.
- No premature infra: every row in the table above has a trigger; nothing is built on speculation.

## The Systems-of-Record principle (founder doctrine, 2026-07-04)

**DreamTeam never replaces a system of record — it sits on top of all of them.** Zendesk stays the ticket SoR, Zuora stays billing, Workday stays HR. DreamTeam is the work layer: Digital Employees acting across those systems within grounded rules, SOPs, protocols, playbooks, workflows, checkpoints, approvals, and confidence thresholds — to minimize human effort.

Two data modes, chosen per use case:
1. **Ingest mode** — pull → store → sort → learn → understand → update → upgrade → guardrail → secure. Used where persistent understanding compounds value: knowledge docs, embeddings, learned behaviors, gap detection.
2. **Pass-through mode** — access the SoR at action time for context/data/knowledge, act on it, store **nothing but the audit record**. Used where storing would merely duplicate the SoR.

Consequences:
- Our live tables (`customer_accounts`, `support_tickets`, `renewal_invoices`) are a **working cache / action workspace**, never a competing record. When connectors go live, sync direction is SoR → cache for context, and actions write **back into the SoR** (invoice generated IN Zuora; ticket updated IN Zendesk), with our side keeping the decision trail.
- Our permanent, proprietary data is the **judgment layer** no SoR has: audit chain, playbook runs, guardrail decisions, approvals, confidence records, learned knowledge. That is the IP.
- Connector design (future): each connector declares per-object mode — `sync` (cached, TTL/webhook-refreshed) or `read_through` (fetched at action time, never persisted) — and per-action write-back bindings. Credentials scoped per DE per system, per the existing DE Systems model.
