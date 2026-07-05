-- ============================================================
-- Migration 028: Declarative Adapter Framework
--
-- Connecting ANY REST system becomes CONFIGURATION (data), not code.
-- An adapter_template declares the auth RECIPE, the base-URL shape
-- (with per-connector variables), and how each canonical category op
-- maps to an HTTP call + where results live in the response.
-- Secret VALUES never live in templates — they stay in
-- connector_secrets (service-role-only, unchanged).
--
-- Changes:
--   adapter_templates — platform-scope rows are the shared library
--       (seeded below, readable by all authenticated); tenant-scope
--       rows are a tenant's own custom systems (tenant-scoped RLS).
--       Writes ONLY via SECURITY DEFINER RPCs with membership guard.
--   connectors.provider gains 'template'; connectors.template_id FK.
--   RPCs: save_adapter_template (structural validation; the full
--       TS validator also runs client-side on save and server-side
--       on every execute), publish_adapter_template.
--   Seeds: 7 platform templates (Freshdesk, HubSpot, Gorgias,
--       Chargebee, BambooHR, Square, Xero) — COMMUNITY TEMPLATES,
--       shaped to the providers' public API docs, honestly marked
--       untested-until-connected.
-- ============================================================

-- ── connectors: new provider + template FK ──
alter table connectors drop constraint if exists connectors_provider_check;
alter table connectors add constraint connectors_provider_check
  check (provider in (
    'zendesk', 'salesforce', 'confluence', 'jira', 'intercom',
    'generic_rest', 'sharepoint', 'template'
  ));

-- ── adapter_templates ──
create table if not exists adapter_templates (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null default 'tenant' check (scope in ('platform', 'tenant')),
  tenant_id    uuid references tenants(id) on delete cascade,
  name         text not null,
  description  text not null default '',
  category     text not null check (category in (
    'crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing',
    'payroll_hcm', 'pos', 'product_system', 'other'
  )),
  status       text not null default 'draft' check (status in ('draft', 'published')),
  definition   jsonb not null default '{}'::jsonb,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint adapter_templates_scope_tenant check (
    (scope = 'platform' and tenant_id is null) or (scope = 'tenant' and tenant_id is not null)
  )
);

alter table connectors add column if not exists template_id uuid references adapter_templates(id) on delete set null;

create index if not exists adapter_templates_tenant_idx on adapter_templates(tenant_id, created_at desc);

drop trigger if exists adapter_templates_updated_at on adapter_templates;
create trigger adapter_templates_updated_at
  before update on adapter_templates
  for each row execute function update_updated_at();

alter table adapter_templates enable row level security;

-- platform rows: readable by every authenticated user; tenant rows: members only
drop policy if exists "adapter_templates_select" on adapter_templates;
create policy "adapter_templates_select" on adapter_templates
  for select using (
    scope = 'platform'
    or tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  );
-- deliberately NO insert/update/delete policies: writes go through the RPCs.

-- ── save_adapter_template — the only tenant-facing write path ──
-- Structural validation lives here (category legality of every bound
-- op, required response paths, auth recipe shape). The richer
-- plain-language validator (TS, shared module) also runs on save in
-- the client AND on every execute in the hub.
create or replace function save_adapter_template(
  p_name        text,
  p_description text,
  p_category    text,
  p_definition  jsonb,
  p_id          uuid default null,
  p_tenant_id   uuid default null   -- service-role only; members use their own tenant
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_id uuid;
  v_op record;
  v_legal jsonb := '{
    "crm":            ["search_accounts","get_account","search_conversations","search_opportunities"],
    "helpdesk":       ["search_tickets","get_ticket","search_articles"],
    "knowledge_base": ["search_articles","get_article"],
    "erp_financials": ["search_invoices","get_invoice"],
    "billing":        ["get_subscription","search_invoices"],
    "payroll_hcm":    ["get_employee","search_time_off"],
    "pos":            ["search_orders","get_order"],
    "product_system": ["get_record","search_records"],
    "other":          ["get_record","search_records"]
  }'::jsonb;  -- mirrors categoryContracts.ts CATEGORY_OPS (keep in sync)
  v_auth_type text;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    v_tenant := p_tenant_id;
  else
    select tenant_id into v_tenant from profiles where user_id = auth.uid();
  end if;
  if v_tenant is null then
    raise exception 'no tenant — sign in as a workspace member (or pass p_tenant_id with the service role)';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'template needs a name';
  end if;
  if not (v_legal ? p_category) then
    raise exception 'unknown category "%"', p_category;
  end if;

  -- structural definition checks
  v_auth_type := p_definition #>> '{auth,type}';
  if v_auth_type is null or v_auth_type not in ('api_key_header','bearer','basic','oauth2_client_credentials','none') then
    raise exception 'definition.auth.type must be one of api_key_header, bearer, basic, oauth2_client_credentials, none';
  end if;
  if v_auth_type = 'api_key_header' and coalesce(p_definition #>> '{auth,header_name}', '') = '' then
    raise exception 'API-key auth needs auth.header_name (which header carries the key)';
  end if;
  if v_auth_type = 'oauth2_client_credentials' and coalesce(p_definition #>> '{auth,token_url}', '') = '' then
    raise exception 'OAuth2 client-credentials auth needs auth.token_url';
  end if;
  if coalesce(p_definition ->> 'base_url_template', '') !~ '^https?://' then
    raise exception 'definition.base_url_template must be a full URL starting with https://';
  end if;
  if p_definition -> 'ops' is null or p_definition -> 'ops' = '{}'::jsonb then
    raise exception 'bind at least one operation (definition.ops is empty)';
  end if;
  for v_op in select key, value from jsonb_each(p_definition -> 'ops') loop
    if not (v_legal -> p_category) ? v_op.key then
      raise exception '"%" is not a legal operation for the % category — legal ops: %',
        v_op.key, p_category, (select string_agg(x, ', ') from jsonb_array_elements_text(v_legal -> p_category) x);
    end if;
    if v_op.value #> '{response,items_path}' is null then
      raise exception 'operation "%": response.items_path is required — where in the response do the results live? Use "" if the response root is the list', v_op.key;
    end if;
    if coalesce(v_op.value #>> '{response,id_path}', '') = '' then
      raise exception 'operation "%": response.id_path is required (which field is the record id?)', v_op.key;
    end if;
    if coalesce(v_op.value #>> '{response,title_path}', '') = '' then
      raise exception 'operation "%": response.title_path is required (which field is the title?)', v_op.key;
    end if;
    if coalesce(v_op.value ->> 'method', '') not in ('GET','POST') then
      raise exception 'operation "%": method must be GET or POST', v_op.key;
    end if;
    if coalesce(v_op.value ->> 'path_template', '') !~ '^/' then
      raise exception 'operation "%": path_template must start with "/"', v_op.key;
    end if;
  end loop;
  if coalesce(p_definition #>> '{test_op,op}', '') = '' then
    raise exception 'definition.test_op is required — which operation proves the connection works?';
  end if;
  if p_definition -> 'ops' -> (p_definition #>> '{test_op,op}') is null then
    raise exception 'test_op "%" is not one of the bound operations', p_definition #>> '{test_op,op}';
  end if;

  if p_id is not null then
    update adapter_templates
      set name = trim(p_name), description = coalesce(p_description, ''),
          category = p_category, definition = p_definition
      where id = p_id and scope = 'tenant' and tenant_id = v_tenant
      returning id into v_id;
    if v_id is null then
      raise exception 'template not found in your workspace (platform templates cannot be edited — save a copy instead)';
    end if;
  else
    insert into adapter_templates (scope, tenant_id, name, description, category, definition, created_by)
    values ('tenant', v_tenant, trim(p_name), coalesce(p_description, ''), p_category, p_definition, auth.uid())
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

revoke all on function save_adapter_template(text, text, text, jsonb, uuid, uuid) from public;
grant execute on function save_adapter_template(text, text, text, jsonb, uuid, uuid) to authenticated, service_role;

-- ── publish_adapter_template ──
create or replace function publish_adapter_template(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from adapter_templates t
    join profiles p on p.tenant_id = t.tenant_id
    where t.id = p_id and t.scope = 'tenant' and p.user_id = auth.uid()
  ) then
    raise exception 'not a member of this template''s workspace';
  end if;
  update adapter_templates set status = 'published' where id = p_id;
end;
$$;

revoke all on function publish_adapter_template(uuid) from public;
grant execute on function publish_adapter_template(uuid) to authenticated, service_role;

-- ============================================================
-- SEED: platform template library — COMMUNITY TEMPLATES.
-- Shaped to each provider's documented public REST API; honestly
-- marked untested-until-connected in every description. Idempotent
-- (insert only when a platform template of the same name is absent).
-- ============================================================
insert into adapter_templates (scope, tenant_id, name, description, category, status, definition)
select 'platform', null, s.name, s.description, s.category, 'published', s.definition::jsonb
from (values
  ('Freshdesk', 'Community template — shaped to the Freshdesk public API v2 docs. Untested until connected: verify against your account. Basic auth: username = your Freshdesk API key, password = X.', 'helpdesk', '{
    "auth": {"type": "basic", "extra_headers": {"Accept": "application/json"}},
    "base_url_template": "https://{subdomain}.freshdesk.com/api/v2",
    "variables": [{"key": "subdomain", "label": "Freshdesk subdomain", "help": "The first part of your Freshdesk URL: {subdomain}.freshdesk.com"}],
    "ops": {
      "search_tickets": {"method": "GET", "path_template": "/search/tickets", "query_params": {"query": "\"subject:''{query}''\""}, "response": {"items_path": "results", "id_path": "id", "title_path": "subject", "snippet_path": "description_text"}},
      "get_ticket": {"method": "GET", "path_template": "/tickets/{ref}", "single_item": true, "response": {"items_path": "", "id_path": "id", "title_path": "subject", "snippet_path": "description_text"}}
    },
    "test_op": {"op": "get_ticket", "params": {"ref": "1"}}
  }'),
  ('HubSpot', 'Community template — shaped to the HubSpot CRM v3 public API docs (private-app Bearer token). Untested until connected: verify against your account.', 'crm', '{
    "auth": {"type": "bearer"},
    "base_url_template": "https://api.hubapi.com",
    "variables": [],
    "ops": {
      "search_accounts": {"method": "POST", "path_template": "/crm/v3/objects/companies/search", "body_template": {"query": "{query}", "limit": 10, "properties": ["name", "domain", "description"]}, "response": {"items_path": "results", "id_path": "id", "title_path": "properties.name", "snippet_path": "properties.domain"}},
      "get_account": {"method": "GET", "path_template": "/crm/v3/objects/companies/{ref}", "query_params": {"properties": "name,domain,description"}, "single_item": true, "response": {"items_path": "", "id_path": "id", "title_path": "properties.name", "snippet_path": "properties.domain"}},
      "search_opportunities": {"method": "POST", "path_template": "/crm/v3/objects/deals/search", "body_template": {"query": "{query}", "limit": 10, "properties": ["dealname", "dealstage", "amount"]}, "response": {"items_path": "results", "id_path": "id", "title_path": "properties.dealname", "snippet_path": "properties.dealstage"}}
    },
    "test_op": {"op": "search_accounts", "params": {"query": "a"}}
  }'),
  ('Gorgias', 'Community template — shaped to the Gorgias public REST API docs. Untested until connected: verify against your account. Basic auth: username = your Gorgias login email, password = your API key.', 'helpdesk', '{
    "auth": {"type": "basic", "extra_headers": {"Accept": "application/json"}},
    "base_url_template": "https://{subdomain}.gorgias.com/api",
    "variables": [{"key": "subdomain", "label": "Gorgias subdomain", "help": "The first part of your Gorgias URL: {subdomain}.gorgias.com"}],
    "ops": {
      "search_tickets": {"method": "POST", "path_template": "/search", "body_template": {"query": "{query}", "type": "ticket", "size": 10}, "response": {"items_path": "data", "id_path": "id", "title_path": "subject", "snippet_path": "excerpt"}},
      "get_ticket": {"method": "GET", "path_template": "/tickets/{ref}", "single_item": true, "response": {"items_path": "", "id_path": "id", "title_path": "subject", "snippet_path": "status"}}
    },
    "test_op": {"op": "search_tickets", "params": {"query": "order"}}
  }'),
  ('Chargebee', 'Community template — shaped to the Chargebee API v2 docs. Untested until connected: verify against your account. Basic auth: username = your Chargebee API key, password left blank. Note: invoice lookup is by exact invoice id (Chargebee has no full-text invoice search).', 'billing', '{
    "auth": {"type": "basic"},
    "base_url_template": "https://{site}.chargebee.com/api/v2",
    "variables": [{"key": "site", "label": "Chargebee site name", "help": "The first part of your Chargebee URL: {site}.chargebee.com"}],
    "ops": {
      "search_invoices": {"method": "GET", "path_template": "/invoices", "query_params": {"limit": "10", "id[is]": "{query}"}, "response": {"items_path": "list", "id_path": "invoice.id", "title_path": "invoice.id", "snippet_path": "invoice.status"}},
      "get_subscription": {"method": "GET", "path_template": "/subscriptions/{ref}", "single_item": true, "response": {"items_path": "", "id_path": "subscription.id", "title_path": "subscription.id", "snippet_path": "subscription.status"}}
    },
    "test_op": {"op": "search_invoices", "params": {"query": ""}}
  }'),
  ('BambooHR', 'Community template — shaped to the BambooHR public API docs. Untested until connected: verify against your account. Basic auth: username = your BambooHR API key, password = x. Time-off search takes an employee id as the search words.', 'payroll_hcm', '{
    "auth": {"type": "basic", "extra_headers": {"Accept": "application/json"}},
    "base_url_template": "https://api.bamboohr.com/api/gateway.php/{subdomain}/v1",
    "variables": [{"key": "subdomain", "label": "BambooHR subdomain", "help": "The first part of your BambooHR URL: {subdomain}.bamboohr.com"}],
    "ops": {
      "get_employee": {"method": "GET", "path_template": "/employees/{ref}", "query_params": {"fields": "displayName,jobTitle,workEmail"}, "single_item": true, "response": {"items_path": "", "id_path": "id", "title_path": "displayName", "snippet_path": "jobTitle"}},
      "search_time_off": {"method": "GET", "path_template": "/time_off/requests/", "query_params": {"employeeId": "{query}"}, "response": {"items_path": "", "id_path": "id", "title_path": "name", "snippet_path": "type.name"}}
    },
    "test_op": {"op": "get_employee", "params": {"ref": "0"}}
  }'),
  ('Square', 'Community template — shaped to the Square Orders API docs (Bearer access token). Untested until connected: verify against your account. Needs your location id; order search filters within that location.', 'pos', '{
    "auth": {"type": "bearer", "extra_headers": {"Square-Version": "2024-01-18"}},
    "base_url_template": "https://connect.squareup.com/v2",
    "variables": [{"key": "location_id", "label": "Square location ID", "help": "Squareup dashboard → Locations → the location''s id (starts with L…)"}],
    "ops": {
      "search_orders": {"method": "POST", "path_template": "/orders/search", "body_template": {"location_ids": ["{location_id}"], "limit": 10, "query": {"filter": {"customer_filter": {"customer_ids": ["{query}"]}}}}, "response": {"items_path": "orders", "id_path": "id", "title_path": "id", "snippet_path": "state"}},
      "get_order": {"method": "GET", "path_template": "/orders/{ref}", "single_item": true, "response": {"items_path": "order", "id_path": "id", "title_path": "id", "snippet_path": "state"}}
    },
    "test_op": {"op": "search_orders", "params": {"query": ""}}
  }'),
  ('Xero', 'Community template — shaped to the Xero Accounting API docs using a Custom Connection (OAuth2 client credentials). Untested until connected: verify against your account. Invoice search filters by contact name.', 'erp_financials', '{
    "auth": {"type": "oauth2_client_credentials", "token_url": "https://identity.xero.com/connect/token", "extra_headers": {"Accept": "application/json"}},
    "base_url_template": "https://api.xero.com",
    "variables": [],
    "ops": {
      "search_invoices": {"method": "GET", "path_template": "/api.xro/2.0/Invoices", "query_params": {"where": "Contact.Name.Contains(\"{query}\")", "page": "1"}, "response": {"items_path": "Invoices", "id_path": "InvoiceID", "title_path": "InvoiceNumber", "snippet_path": "Status"}},
      "get_invoice": {"method": "GET", "path_template": "/api.xro/2.0/Invoices/{ref}", "response": {"items_path": "Invoices", "id_path": "InvoiceID", "title_path": "InvoiceNumber", "snippet_path": "Status"}}
    },
    "test_op": {"op": "search_invoices", "params": {"query": "a"}}
  }')
) as s(name, description, category, definition)
where not exists (
  select 1 from adapter_templates t where t.scope = 'platform' and t.name = s.name
);
