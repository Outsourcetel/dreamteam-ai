-- ============================================================
-- Migration 026: Multi-system Connector Hub + Evidence Pipeline
--
-- Answers the founder's challenge: a technical DE must be able to
-- reach a customer's real systems — product API, Confluence, Jira,
-- Salesforce, Intercom, Zendesk — check account configuration, find
-- knowledge, verify against past support conversations, THEN answer.
--
-- Changes:
--   connectors      — provider set widened (salesforce, confluence,
--                     jira, intercom, generic_rest, sharepoint kept
--                     honest as not_implemented), plus:
--       role        — what the system IS to the business
--                     (product_system | crm | support_desk |
--                      knowledge_base | other) → the evidence
--                     pipeline routes steps by role
--       access_mode — the customer's storage choice at the
--                     CONNECTOR level: 'ingest' (sync allowed) or
--                     'fetch_only' (server-side REFUSES sync; we
--                     look at your data to answer, we never store it)
--       config      — provider-specific shape, e.g. generic_rest
--                     endpoint templates (how a customer's own
--                     product API connects with zero code)
--   knowledge_docs  — source gains 'connector' + external_ref so
--                     synced articles/pages upsert idempotently
--   evidence_runs   — one row per resolved inquiry: every step,
--                     honest outcomes (ok / skipped_not_connected /
--                     failed), citations, confidence inputs. The
--                     PASS-THROUGH COMPROMISE, documented: for
--                     fetch-only systems we persist ONLY citation
--                     metadata (title, ref, url, snippet ≤200 chars),
--                     never full payloads.
--   audit_events    — category 'evidence_step' added
-- ============================================================

-- ── connectors: widen provider set ──
alter table connectors drop constraint if exists connectors_provider_check;
alter table connectors add constraint connectors_provider_check
  check (provider in (
    'zendesk', 'salesforce', 'confluence', 'jira', 'intercom',
    'generic_rest', 'sharepoint'
  ));

-- ── connectors: role, access_mode, config ──
alter table connectors add column if not exists role text not null default 'other';
alter table connectors drop constraint if exists connectors_role_check;
alter table connectors add constraint connectors_role_check
  check (role in ('product_system', 'crm', 'support_desk', 'knowledge_base', 'other'));

alter table connectors add column if not exists access_mode text not null default 'ingest';
alter table connectors drop constraint if exists connectors_access_mode_check;
alter table connectors add constraint connectors_access_mode_check
  check (access_mode in ('ingest', 'fetch_only'));

alter table connectors add column if not exists config jsonb not null default '{}'::jsonb;

-- ── knowledge_docs: connector-sourced docs upsert by external_ref ──
alter table knowledge_docs drop constraint if exists knowledge_docs_source_check;
alter table knowledge_docs add constraint knowledge_docs_source_check
  check (source in ('upload', 'paste', 'connector'));
alter table knowledge_docs add column if not exists external_ref text;

create unique index if not exists knowledge_docs_source_ref_uniq
  on knowledge_docs(tenant_id, source, external_ref)
  where external_ref is not null;

-- ============================================================
-- TABLE: evidence_runs — the full trail of one resolved inquiry.
-- steps jsonb: [{ kind: account_context|knowledge_search|history_check|
--   mcp_tool|compose, system, query, outcome: ok|skipped_not_connected|
--   failed, summary, item_count, latency_ms,
--   citations: [{system, ref, title, url, snippet}] }]
-- Pass-through compromise: fetch-only citations carry metadata +
-- snippet ≤200 chars ONLY — full payloads are never persisted.
-- ============================================================
create table if not exists evidence_runs (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  de_id              uuid,
  specialist_id      uuid references specialist_profiles(id) on delete set null,
  inquiry            text not null,
  account_ref        text,
  status             text not null default 'running'
                       check (status in ('running', 'complete', 'failed')),
  steps              jsonb not null default '[]'::jsonb,
  confidence_inputs  jsonb not null default '{}'::jsonb,
  answer_status      text not null default 'llm_not_configured'
                       check (answer_status in ('llm_not_configured', 'answered', 'blocked', 'error')),
  answer             text,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create index if not exists evidence_runs_tenant_idx on evidence_runs(tenant_id, created_at desc);

alter table evidence_runs enable row level security;

drop policy if exists "evidence_runs_tenant_select" on evidence_runs;
create policy "evidence_runs_tenant_select" on evidence_runs
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes only via the service role (specialist-consult edge function)

-- ── audit_events: add evidence_step category ──
alter table audit_events drop constraint if exists audit_events_category_check;
alter table audit_events add constraint audit_events_category_check
  check (category in (
    'resolved', 'escalated', 'approval', 'guardrail_check', 'guardrail_block',
    'config_change', 'playbook_step', 'invoice',
    'connector_sync', 'connector_action', 'evidence_step'
  ));
