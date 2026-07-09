-- Migration 116: 9 functions never adopted auth_tenant_id() (058/105).
--
-- Found live, same-day, from a real founder bug report ("closing an
-- opportunity or assigning a playbook says no account attached")
-- while testing a brand-new tenant. Reproduced the root cause exactly:
-- close_opportunity_won/lost do a raw
--   select tenant_id from profiles where user_id = auth.uid()
-- instead of the shared auth_tenant_id() helper this session built in
-- migration 058/105 specifically so a platform admin's OWN profile
-- (tenant_id always null — platform admins aren't tenant members) can
-- still resolve a tenant while inside an active Remote Access session,
-- by falling back to the most recent platform_access_events 'start'
-- row. Migration 105 swept 15 RLS policies + 3 functions onto this
-- pattern — but these 9 were never part of that sweep, because they
-- aren't RLS policies, they're PL/pgSQL functions with their own
-- inline tenant-resolution logic that was simply never revisited.
--
-- A platform admin mid-Remote-Access-session calling any of these 9
-- gets 'no tenant for caller' — a raw Postgres exception a non-
-- technical user very plausibly relays as "no account attached."
-- Confirmed via a live grep for every function containing this exact
-- vulnerable shape: close_opportunity_lost, close_opportunity_won,
-- compute_tenant_health, create_onboarding_project,
-- get_identity_inventory, increment_metric,
-- install_starter_onboarding_template, save_adapter_template,
-- seed_trust_policies.
--
-- Fix, applied identically to all 9: keep the existing is_active
-- check (preserves the specific "account is deactivated" message),
-- but resolve the tenant itself via auth_tenant_id() instead of a
-- raw profiles lookup. Three of the nine (create_onboarding_project,
-- get_identity_inventory, save_adapter_template) already have a
-- service_role branch for edge-function callers — that branch is
-- untouched; only the AUTHENTICATED-caller branch (which Remote
-- Access hits, since it's a normal JWT, not service_role) is fixed.
-- Every other line of business logic, every error message, every
-- signature is byte-for-byte unchanged.
-- ============================================================

create or replace function close_opportunity_lost(p_opp uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_opp    opportunities;
  v_tenant uuid;
  v_is_active boolean;
begin
  select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_is_active is false then raise exception 'account is deactivated'; end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'no tenant for caller'; end if;
  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('error', 'lost_reason_required');
  end if;
  select * into v_opp from opportunities where id = p_opp and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'opportunity_not_found'); end if;
  if v_opp.stage in ('won', 'lost') then return jsonb_build_object('error', 'already_closed'); end if;

  perform set_config('dreamteam.opp_close', 'on', true);
  update opportunities set stage = 'lost', lost_reason = trim(p_reason) where id = v_opp.id;
  perform set_config('dreamteam.opp_close', '', true);

  return jsonb_build_object('closed', true);
end;
$function$;

create or replace function close_opportunity_won(p_opp uuid, p_account_id uuid default null, p_create_onboarding boolean default false, p_template_version uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_opp       opportunities;
  v_tenant    uuid;
  v_is_active boolean;
  v_acct_id   uuid;
  v_acct_name text;
  v_proj      jsonb;
  v_proj_id   uuid;
begin
  select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_is_active is false then raise exception 'account is deactivated'; end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'no tenant for caller'; end if;

  select * into v_opp from opportunities where id = p_opp and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'opportunity_not_found'); end if;
  if v_opp.stage in ('won', 'lost') then return jsonb_build_object('error', 'already_closed'); end if;

  v_acct_id := coalesce(p_account_id, v_opp.account_id);
  if v_acct_id is not null then
    select name into v_acct_name from customer_accounts where id = v_acct_id and tenant_id = v_tenant;
    if v_acct_name is null then return jsonb_build_object('error', 'account_not_found'); end if;
  else
    v_acct_name := coalesce(nullif(trim(v_opp.company_name), ''), v_opp.name);
    insert into customer_accounts (tenant_id, name, arr_cents, health_score, status, notes)
    values (v_tenant, v_acct_name, coalesce(v_opp.amount_cents, 0), 70, 'active',
            format('Created from won opportunity "%s"', v_opp.name))
    returning id into v_acct_id;
    insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
    values (v_tenant, v_acct_id, 'You', 'human', 'config_change',
            format('Account created from won opportunity — %s', v_acct_name));
  end if;

  perform set_config('dreamteam.opp_close', 'on', true);
  update opportunities set stage = 'won', account_id = v_acct_id where id = v_opp.id;
  perform set_config('dreamteam.opp_close', '', true);

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('Won → lifecycle handoff — %s: account "%s"%s', v_opp.name, v_acct_name,
           case when p_create_onboarding then ' + onboarding kickoff' else '' end),
    'config_change',
    jsonb_build_object('kind', 'opportunity_won_handoff', 'opportunity_id', v_opp.id,
                       'account_id', v_acct_id, 'created_account', v_opp.account_id is null and p_account_id is null,
                       'create_onboarding', p_create_onboarding));

  if p_create_onboarding and p_template_version is not null then
    v_proj := create_onboarding_project(v_acct_id, p_template_version, null, null);
    v_proj_id := (v_proj->>'project_id')::uuid;
    if v_proj->>'error' is not null then
      return jsonb_build_object('account_id', v_acct_id, 'onboarding_error', v_proj->>'error');
    end if;
  end if;

  return jsonb_build_object('account_id', v_acct_id, 'project_id', v_proj_id);
end;
$function$;

create or replace function compute_tenant_health(p_force boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
  v_last   timestamptz;
  v_n      integer := 0;
  v_flips  integer := 0;
  v_acct   record;
  v_res    jsonb;
begin
  select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_is_active is false then raise exception 'account is deactivated'; end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'no tenant for caller'; end if;

  insert into health_score_config (tenant_id) values (v_tenant)
  on conflict (tenant_id) do nothing;

  select last_computed_at into v_last from health_score_config where tenant_id = v_tenant;
  if not p_force and v_last is not null and v_last > now() - interval '1 hour' then
    return jsonb_build_object('computed', 0, 'skipped', true, 'last_computed_at', v_last);
  end if;

  for v_acct in select id from customer_accounts where tenant_id = v_tenant and status <> 'churned' loop
    v_res := compute_account_health_core(v_acct.id);
    v_n := v_n + 1;
    if coalesce((v_res->>'status_changed')::boolean, false) then v_flips := v_flips + 1; end if;
  end loop;

  update health_score_config set last_computed_at = now() where tenant_id = v_tenant;
  return jsonb_build_object('computed', v_n, 'status_flips', v_flips, 'skipped', false);
end;
$function$;

create or replace function create_onboarding_project(p_account_id uuid, p_version_id uuid, p_name text default null, p_target date default null, p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant  uuid;
  v_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_is_active boolean;
  v_acct    customer_accounts;
  v_ver     onboarding_template_versions;
  v_state   jsonb;
  v_proj_id uuid;
  v_name    text;
  v_created_by uuid;
begin
  if v_is_service then
    if p_tenant_id is null then
      return jsonb_build_object('error', 'tenant_id_required_for_service_call');
    end if;
    v_tenant := p_tenant_id;
    v_created_by := null;
  else
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() limit 1;
    if v_is_active is false then raise exception 'account is deactivated'; end if;
    v_tenant := auth_tenant_id();
    if v_tenant is null then raise exception 'no tenant for caller'; end if;
    v_created_by := auth.uid();
  end if;

  select * into v_acct from customer_accounts where id = p_account_id and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'account_not_found'); end if;

  select * into v_ver from onboarding_template_versions where id = p_version_id and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'template_version_not_found'); end if;

  select jsonb_agg(jsonb_build_object(
    'key', i->>'key', 'status', 'pending', 'assignee', null, 'note', ''))
    into v_state
  from jsonb_array_elements(v_ver.items) i;

  v_name := coalesce(nullif(trim(p_name), ''), format('%s — %s', v_acct.name, v_ver.name));

  insert into onboarding_projects (tenant_id, account_id, template_version_id, name, target_golive, items_state, created_by)
  values (v_tenant, p_account_id, p_version_id, v_name, p_target, coalesce(v_state, '[]'::jsonb), v_created_by)
  returning id into v_proj_id;

  perform append_audit_event_internal(
    v_tenant, case when v_is_service then 'Playbook DE' else 'You' end, case when v_is_service then 'de' else 'human' end,
    format('Onboarding project created — %s (%s v%s, %s items)', v_name, v_ver.name, v_ver.version, jsonb_array_length(v_ver.items)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_project_create', 'project_id', v_proj_id,
                       'account_id', p_account_id, 'version_id', p_version_id));

  insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
  values (v_tenant, p_account_id, case when v_is_service then 'Playbook DE' else 'You' end, case when v_is_service then 'de' else 'human' end, 'config_change',
          format('Onboarding started — %s', v_acct.name));

  return jsonb_build_object('project_id', v_proj_id);
end;
$function$;

create or replace function get_identity_inventory(p_tenant_id uuid)
returns table(subject_kind text, subject_id uuid, subject_name text, subject_label text, subject_role text, subject_status text, connector_id uuid, connector_name text, connector_provider text, connector_category text, connector_status text, connector_last_ok_at timestamptz, connector_last_error_at timestamptz, connector_consecutive_failures integer, has_stored_credential boolean, permission text, permission_via text, trust_current_level integer, trust_target_level integer, autonomy_enabled boolean, possible_actions jsonb)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller_tenant uuid;
  v_is_service    boolean := coalesce(auth.role(), '') = 'service_role';
  v_is_active     boolean;
begin
  if not v_is_service then
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid();
    if v_is_active is false then
      raise exception 'account is deactivated';
    end if;
    v_caller_tenant := auth_tenant_id();
    if v_caller_tenant is null then
      raise exception 'not authenticated or no tenant membership';
    end if;
    if v_caller_tenant is distinct from p_tenant_id then
      raise exception 'not a member of this tenant';
    end if;
  end if;

  if not is_feature_enabled_internal(p_tenant_id, 'identity_credential_inventory') then
    return;
  end if;

  return query
  with subjects as (
    select 'de'::text as subject_kind, d.id as subject_id, d.name as subject_name,
           coalesce(d.persona_name, d.name) as subject_label,
           coalesce(nullif(d.department, ''), d.category) as subject_role,
           d.status as subject_status
    from digital_employees d
    where d.tenant_id = p_tenant_id
    union all
    select 'specialist'::text, s.id, s.name, s.name, s.key, s.status
    from specialist_profiles s
    where s.tenant_id = p_tenant_id
  ),
  grants_resolved as (
    select g.subject_kind, g.subject_id, c.id as connector_id, g.permission, 'category'::text as via,
           g.resource_category as eff_category
    from data_access_grants g
    join connectors c on c.tenant_id = g.tenant_id and c.category = g.resource_category
    where g.tenant_id = p_tenant_id and g.resource_kind = 'category'
    union all
    select g.subject_kind, g.subject_id, g.resource_id as connector_id, g.permission, 'connector'::text as via,
           c.category as eff_category
    from data_access_grants g
    join connectors c on c.id = g.resource_id and c.tenant_id = p_tenant_id
    where g.tenant_id = p_tenant_id and g.resource_kind = 'connector'
  ),
  grants_final as (
    select distinct on (gr.subject_kind, gr.subject_id, gr.connector_id)
      gr.subject_kind, gr.subject_id, gr.connector_id, gr.permission, gr.via, gr.eff_category
    from grants_resolved gr
    order by gr.subject_kind, gr.subject_id, gr.connector_id,
             (gr.via = 'connector') desc
  ),
  secrets as (
    select cs.connector_id as secret_connector_id, true as has_secret from connector_secrets cs
  ),
  trust as (
    select tp.de_id, tp.source_category, tp.current_level, tp.target_level
    from trust_policies tp
    where tp.tenant_id = p_tenant_id and tp.action_category = 'action_execute'
  ),
  autonomy as (
    select da.source_category, da.enabled
    from de_autonomy da
    where da.tenant_id = p_tenant_id and da.action_type = 'action_execute'
  ),
  actions_by_category as (
    select ad.category,
           jsonb_agg(jsonb_build_object(
             'action_key', ad.action_key, 'label', ad.label,
             'destructive', coalesce((ad.risk->>'destructive')::boolean, true)
           ) order by ad.label) as actions
    from action_definitions ad
    where ad.status = 'active' and (ad.scope = 'platform' or ad.tenant_id = p_tenant_id)
    group by ad.category
  )
  select
    s.subject_kind, s.subject_id, s.subject_name, s.subject_label, s.subject_role, s.subject_status,
    c.id, c.display_name, c.provider, c.category, c.status,
    c.last_ok_at, c.last_error_at, c.consecutive_failures,
    coalesce(sec.has_secret, false),
    gf.permission, gf.via,
    coalesce(
      (select tr.current_level from trust tr where tr.de_id = s.subject_id and tr.source_category = c.category),
      (select tr.current_level from trust tr where tr.de_id = s.subject_id and tr.source_category is null and s.subject_kind = 'de')
    ),
    coalesce(
      (select tr.target_level from trust tr where tr.de_id = s.subject_id and tr.source_category = c.category),
      (select tr.target_level from trust tr where tr.de_id = s.subject_id and tr.source_category is null and s.subject_kind = 'de')
    ),
    coalesce(
      (select au.enabled from autonomy au where au.source_category = c.category),
      (select au.enabled from autonomy au where au.source_category is null)
    ),
    coalesce(abc.actions, '[]'::jsonb)
  from subjects s
  left join grants_final gf on gf.subject_kind = s.subject_kind and gf.subject_id = s.subject_id
  left join connectors c on c.id = gf.connector_id
  left join secrets sec on sec.secret_connector_id = c.id
  left join actions_by_category abc on abc.category = c.category
  order by s.subject_kind, s.subject_name, c.category, c.display_name;
end;
$function$;

create or replace function increment_metric(p_metric text, p_delta bigint default 1)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
begin
  select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_is_active is false then raise exception 'account is deactivated'; end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'no tenant for caller'; end if;
  insert into usage_metrics (tenant_id, day, metric, value)
    values (v_tenant, current_date, p_metric, p_delta)
    on conflict (tenant_id, day, metric)
    do update set value = usage_metrics.value + excluded.value;
end;
$function$;

create or replace function install_starter_onboarding_template()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
  v_tpl_id uuid;
  v_pub    jsonb;
  v_items  jsonb := '[
    {"key":"kickoff_call","label":"Kickoff call held","phase":"kickoff","owner_type":"human","requires_signoff":false,"description":"Intro call: goals, timeline, points of contact."},
    {"key":"data_export_received","label":"Data export received from customer","phase":"data","owner_type":"either","requires_signoff":false,"description":"Customer sends their employee/location export (CSV or spreadsheet)."},
    {"key":"employees_imported","label":"Employees imported","phase":"data","owner_type":"de","requires_signoff":false,"description":"Employee records loaded and normalized in the platform."},
    {"key":"locations_configured","label":"Locations configured","phase":"config","owner_type":"de","requires_signoff":false,"description":"Sites, time zones, and operating hours set up."},
    {"key":"settings_review","label":"Account settings reviewed","phase":"config","owner_type":"human","requires_signoff":true,"description":"Human sign-off on core account configuration."},
    {"key":"leave_rules_configured","label":"Leave rules configured","phase":"config","owner_type":"either","requires_signoff":true,"description":"Accrual, carryover, and approval chains — needs human sign-off."},
    {"key":"test_scenario_run","label":"Test scenario run","phase":"validation","owner_type":"de","requires_signoff":false,"description":"End-to-end test with sample data."},
    {"key":"uat_approved","label":"UAT approved by customer","phase":"validation","owner_type":"human","requires_signoff":true,"description":"Customer confirms acceptance testing passed."},
    {"key":"training_session","label":"Training session delivered","phase":"golive","owner_type":"human","requires_signoff":false,"description":"Admin + end-user training completed."},
    {"key":"go_live","label":"Go-live","phase":"golive","owner_type":"human","requires_signoff":true,"description":"Production cutover — final human sign-off."}
  ]'::jsonb;
begin
  select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_is_active is false then
    raise exception 'account is deactivated';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then
    raise exception 'no tenant for caller';
  end if;

  select id into v_tpl_id from onboarding_templates
    where tenant_id = v_tenant and name = 'SaaS onboarding — starter' limit 1;
  if v_tpl_id is not null then
    return jsonb_build_object('template_id', v_tpl_id, 'already_installed', true);
  end if;

  insert into onboarding_templates (tenant_id, name, description, items)
  values (v_tenant, 'SaaS onboarding — starter',
          '10-step implementation checklist: kickoff → data → config → validation → go-live. Sign-off gates on settings, leave rules, UAT, and go-live.',
          v_items)
  returning id into v_tpl_id;

  v_pub := publish_onboarding_template(v_tpl_id);
  return jsonb_build_object('template_id', v_tpl_id, 'already_installed', false) || v_pub;
end;
$function$;

create or replace function save_adapter_template(p_name text, p_description text, p_category text, p_definition jsonb, p_id uuid default null, p_tenant_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
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
  }'::jsonb;
  v_auth_type text;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    v_tenant := p_tenant_id;
  else
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid();
    if v_is_active is false then
      raise exception 'account is deactivated';
    end if;
    v_tenant := auth_tenant_id();
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
$function$;

create or replace function seed_trust_policies()
returns setof trust_policies
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
begin
  select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_is_active is false then
    raise exception 'account is deactivated';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then
    raise exception 'no tenant for the current session';
  end if;
  if v_tenant = 'a0000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'demo tenant uses the demo story — earned trust is a live-tenant feature';
  end if;

  insert into trust_policies (tenant_id, de_id, action_category, criteria)
  values
    (v_tenant, null, 'invoice_auto_send', '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":25,"min_human_approval_rate":0.9,"min_human_samples":5,"max_guardrail_blocks":0}'::jsonb),
    (v_tenant, null, 'answer_dock',       '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":25,"min_human_approval_rate":0.9,"min_human_samples":0,"max_guardrail_blocks":0}'::jsonb),
    (v_tenant, null, 'answer_widget',     '{"window_days":30,"min_eval_pass_rate":0.95,"min_eval_samples":40,"min_human_approval_rate":0.9,"min_human_samples":0,"max_guardrail_blocks":0}'::jsonb)
  on conflict (tenant_id, action_category, coalesce(source_category, ''), coalesce(de_id::text, '')) do nothing;

  return query select * from trust_policies where tenant_id = v_tenant order by action_category;
end;
$function$;

-- Grants unchanged (every signature above is identical to its live
-- predecessor) — re-affirmed defensively for all 9, matching this
-- session's grant-hygiene discipline.
revoke all on function close_opportunity_lost(uuid, text) from public;
revoke all on function close_opportunity_lost(uuid, text) from anon;
grant execute on function close_opportunity_lost(uuid, text) to authenticated, service_role;

revoke all on function close_opportunity_won(uuid, uuid, boolean, uuid) from public;
revoke all on function close_opportunity_won(uuid, uuid, boolean, uuid) from anon;
grant execute on function close_opportunity_won(uuid, uuid, boolean, uuid) to authenticated, service_role;

revoke all on function compute_tenant_health(boolean) from public;
revoke all on function compute_tenant_health(boolean) from anon;
grant execute on function compute_tenant_health(boolean) to authenticated, service_role;

revoke all on function create_onboarding_project(uuid, uuid, text, date, uuid) from public;
revoke all on function create_onboarding_project(uuid, uuid, text, date, uuid) from anon;
grant execute on function create_onboarding_project(uuid, uuid, text, date, uuid) to authenticated, service_role;

revoke all on function get_identity_inventory(uuid) from public;
revoke all on function get_identity_inventory(uuid) from anon;
grant execute on function get_identity_inventory(uuid) to authenticated, service_role;

revoke all on function increment_metric(text, bigint) from public;
revoke all on function increment_metric(text, bigint) from anon;
grant execute on function increment_metric(text, bigint) to authenticated, service_role;

revoke all on function install_starter_onboarding_template() from public;
revoke all on function install_starter_onboarding_template() from anon;
grant execute on function install_starter_onboarding_template() to authenticated, service_role;

revoke all on function save_adapter_template(text, text, text, jsonb, uuid, uuid) from public;
revoke all on function save_adapter_template(text, text, text, jsonb, uuid, uuid) from anon;
grant execute on function save_adapter_template(text, text, text, jsonb, uuid, uuid) to authenticated, service_role;

revoke all on function seed_trust_policies() from public;
revoke all on function seed_trust_policies() from anon;
grant execute on function seed_trust_policies() to authenticated, service_role;
