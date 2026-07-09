-- Migration 107: category + specialist-type taxonomy — from hardcoded
-- enums to extensible data.
--
-- Founder's instruction (2026-07-09, in the same conversation that
-- produced the Wave 0 roadmap): "the Operational Domains could scale
-- to 50 or 100 so do not hardcode it such that we can not scale it
-- later." Two concrete offenders found on audit, both fixed here.
--
-- ============================================================
-- PART A — specialist_profiles.key: 4 hardcoded values, one per tenant.
-- ============================================================
-- The CHECK constraint (technical/legal/finance/people) is pure
-- validation — no downstream logic depends on the value SET being
-- exactly these 4 (consult_specialist/resolve_inquiry look up by
-- whatever key string is passed, they don't branch on which of the
-- 4 it is). Dropping the CHECK is sufficient: a tenant can now name
-- its own specialist type (e.g. 'compliance', 'hr') with zero
-- migration. unique(tenant_id, key) is KEPT — it's load-bearing for
-- consult_specialist's key-based lookup (ambiguous otherwise), not
-- itself a scaling limit: a tenant wanting two flavors of "legal"
-- creates two differently-keyed rows (e.g. 'legal_contracts',
-- 'legal_employment'), the same way departments already work.
-- ============================================================
alter table specialist_profiles drop constraint if exists specialist_profiles_key_check;

-- ============================================================
-- PART B — the system-category value list: NOT one enum, it was
-- copy-pasted as an inline CHECK across 9 separate tables (found on
-- audit: connectors, de_autonomy, trust_policies, adapter_templates,
-- data_access_grants, evidence_run_decisions, action_definitions,
-- work_item_framing, de_experience). Adding a 10th category meant
-- editing 9 constraints. Converts the LIST to one central,
-- platform-managed reference table; every dependent column becomes
-- a real FK against it instead of its own copy of the array.
--
-- HONEST SCOPE LIMIT: this converts the VALUE LIST, not the category
-- CONTRACT (which canonical objects/ops each category supports —
-- src/lib/categoryContracts.ts / supabase/functions/_shared/
-- categoryContracts.ts). A genuinely NEW category still needs its
-- contract defined in code before it does anything functional — same
-- trade-off already agreed this session for action shapes: the LIST
-- of what exists becomes data, the CONTRACT of what it can do stays
-- reviewed code. Making contracts themselves data-driven is a
-- separate, larger piece of work, not bundled in here.
-- ============================================================
create table if not exists system_categories (
  key         text primary key,
  label       text not null,
  description text not null default '',
  created_by  uuid,
  created_at  timestamptz not null default now()
);

insert into system_categories (key, label, description) values
  ('crm', 'CRM', 'Customer relationship management'),
  ('helpdesk', 'Helpdesk', 'Support ticketing'),
  ('knowledge_base', 'Knowledge Base', 'External knowledge/documentation systems'),
  ('erp_financials', 'ERP / Financials', 'Enterprise resource planning, general ledger'),
  ('billing', 'Billing', 'Invoicing and payments'),
  ('payroll_hcm', 'Payroll / HCM', 'Payroll and human capital management'),
  ('pos', 'POS', 'Point of sale'),
  ('product_system', 'Product System', 'The customer''s own product/application'),
  ('other', 'Other', 'Anything not covered by a named category')
on conflict (key) do nothing;

alter table system_categories enable row level security;

drop policy if exists system_categories_read on system_categories;
create policy system_categories_read on system_categories
  for select
  using (true);  -- every authenticated user needs this for dropdowns; no tenant secret in it

drop policy if exists system_categories_platform_write on system_categories;
create policy system_categories_platform_write on system_categories
  for all
  using (is_platform_admin())
  with check (is_platform_admin());

-- CREATE TABLE inherits this project's default schema privileges,
-- which include a stray `anon` grant with full arwdDxtm — caught live
-- via relacl inspection immediately after applying. RLS's
-- is_platform_admin() policy would have blocked anon writes either
-- way, but the base grant itself was wrong and is revoked explicitly,
-- same discipline as migration 105's own live-caught grant fix.
revoke all on system_categories from anon;
revoke all on system_categories from public;
revoke all on system_categories from authenticated;
grant select, insert, update, delete on system_categories to authenticated;
grant select on system_categories to service_role;

-- Swap each of the 9 dependent columns from its own inline CHECK to a
-- real FK against the new table. All 9 already only contain values
-- from the current 9-row seed, so this is a zero-data-risk swap.
alter table connectors drop constraint if exists connectors_category_check;
alter table connectors add constraint connectors_category_fkey
  foreign key (category) references system_categories(key);

alter table de_autonomy drop constraint if exists de_autonomy_source_category_check;
alter table de_autonomy add constraint de_autonomy_source_category_fkey
  foreign key (source_category) references system_categories(key);

alter table trust_policies drop constraint if exists trust_policies_source_category_check;
alter table trust_policies add constraint trust_policies_source_category_fkey
  foreign key (source_category) references system_categories(key);

alter table adapter_templates drop constraint if exists adapter_templates_category_check;
alter table adapter_templates add constraint adapter_templates_category_fkey
  foreign key (category) references system_categories(key);

alter table data_access_grants drop constraint if exists data_access_grants_resource_category_check;
alter table data_access_grants add constraint data_access_grants_resource_category_fkey
  foreign key (resource_category) references system_categories(key);

alter table evidence_run_decisions drop constraint if exists evidence_run_decisions_source_category_check;
alter table evidence_run_decisions add constraint evidence_run_decisions_source_category_fkey
  foreign key (source_category) references system_categories(key);

alter table action_definitions drop constraint if exists action_definitions_category_check;
alter table action_definitions add constraint action_definitions_category_fkey
  foreign key (category) references system_categories(key);

alter table work_item_framing drop constraint if exists work_item_framing_category_check;
alter table work_item_framing add constraint work_item_framing_category_fkey
  foreign key (category) references system_categories(key);

alter table de_experience drop constraint if exists de_experience_category_check;
alter table de_experience add constraint de_experience_category_fkey
  foreign key (category) references system_categories(key);
