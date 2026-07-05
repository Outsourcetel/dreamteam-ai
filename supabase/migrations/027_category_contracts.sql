-- ============================================================
-- Migration 027: Category Contracts + Connector Health
--
-- The app now talks in system CATEGORIES (canonical objects and
-- operations); provider adapters translate. This is the layer that
-- keeps consumers (evidence pipeline, playbooks) provider-agnostic:
-- "ask the CRM for the account" instead of "call Salesforce".
--
-- Changes:
--   connectors.category  — what KIND of system this is; replaces the
--       v1 'role' field in all code. Role values migrate:
--         crm→crm, support_desk→helpdesk, knowledge_base→knowledge_base,
--         product_system→product_system, other→other.
--       The old 'role' column is KEPT (deprecated, unused by new code)
--       so any in-flight deployment keeps working during rollout; it
--       is documented for removal in a later migration.
--   connectors.field_map — jsonb {canonical_field: customer_field}
--       applied at normalization time (e.g. {"title":"name"} means the
--       canonical title comes from the source record's "name" field).
--   connector health (call-driven — no cron; scheduled checks arrive
--   with the first paying tenant):
--       last_ok_at, last_error_at, consecutive_failures
--       (+ existing last_error text). Health status is COMPUTED in the
--       shared categoryContracts module: never_connected / healthy /
--       degraded (1-2 consecutive failures) / down (3+).
-- ============================================================

-- ── connectors.category ──
alter table connectors add column if not exists category text not null default 'other';

-- Backfill from role (idempotent; only touches rows still at default)
update connectors set category = case role
  when 'crm'            then 'crm'
  when 'support_desk'   then 'helpdesk'
  when 'knowledge_base' then 'knowledge_base'
  when 'product_system' then 'product_system'
  else 'other'
end
where category = 'other' and role is not null and role <> 'other';

alter table connectors drop constraint if exists connectors_category_check;
alter table connectors add constraint connectors_category_check
  check (category in (
    'crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing',
    'payroll_hcm', 'pos', 'product_system', 'other'
  ));

comment on column connectors.role is
  'DEPRECATED since migration 027 — superseded by category. Kept for rollout safety; remove in a later migration.';

-- ── field mapping (customer field → canonical field) ──
alter table connectors add column if not exists field_map jsonb not null default '{}'::jsonb;

-- ── call-driven health ──
alter table connectors add column if not exists last_ok_at timestamptz;
alter table connectors add column if not exists last_error_at timestamptz;
alter table connectors add column if not exists consecutive_failures integer not null default 0;
