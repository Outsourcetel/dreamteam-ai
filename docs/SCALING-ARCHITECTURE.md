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

1. **P2.5 — pgvector retrieval**: trigger = a pilot tenant exceeds ~50 documents or keyword retrieval visibly misses. (~1 migration + ingest step + query change.)
2. **Account dimension (schema-only now)**: add nullable `account_id` columns + FK to a new `accounts-of-tenant` table in the NEXT migration touching these tables — retrofitting the column later across millions of rows is the expensive version. UI can ignore it until needed.
3. **End-user widget + tenant-token auth**: trigger = first design partner who wants their customers/employees asking questions (this is TCP's actual use case — likely early).
4. **Queue + semantic cache + tiering**: trigger = any tenant crossing ~1K inquiries/day or LLM spend mattering.
5. **Partitioning/replicas/K8s**: trigger = measured, not speculative. The 10-layer architecture keeps business logic portable.

## What we deliberately do NOT do
- No LangChain/LangGraph — orchestration (Workforce Engine: routing, gates, guardrails, audit) is our own plain code and our core IP; LLM calls stay behind our thin provider-neutral interface.
- No per-end-user accounts, ever.
- No premature infra: every row in the table above has a trigger; nothing is built on speculation.
