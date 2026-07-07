-- Migration 064: gap 6 from the 2026-07-07 adversarial pass -- several
-- tenant-scoped tables and RPCs had no role check beyond tenant
-- membership, meaning any employee (not just an owner/admin) could edit
-- compliance guardrails, a Digital Employee's autonomy/trust dial,
-- connected external systems, or publish an onboarding template.
--
-- Matches the exact read/write-split pattern already established for
-- workspaces/departments/capabilities/digital_employees (migrations
-- 002/037, re-confirmed live before writing this): an unrestricted
-- `_tenant_read` SELECT policy, plus a role-gated `_tenant_write` ALL
-- policy that (per Postgres RLS semantics) only actually narrows
-- INSERT/UPDATE/DELETE, since SELECT is separately covered by the always-
-- more-permissive read policy.
--
-- Deliberately NOT touched here (per the founder's own explicit split):
--   human_tasks -- gets completed/approved by whoever it's assigned to,
--     often a regular employee; a blanket role gate would break normal
--     task completion. Needs an assignment-aware check, its own future
--     piece of work, not a role-tier gate.
--   apply_trust_promotion, close_opportunity_won/lost,
--     resolve_onboarding_signoff -- day-to-day work a manager or rep would
--     reasonably do themselves (closing your own deal, approving a
--     trust bump you're overseeing, signing off an onboarding item).
--     Left as tenant-membership-only.
-- =====================================================================

-- guardrail_rules: compliance/safety config -- owner/admin only.
drop policy if exists guardrail_rules_tenant_isolation on public.guardrail_rules;

create policy guardrail_rules_tenant_read on public.guardrail_rules
  for select
  using (tenant_id = auth_tenant_id());

create policy guardrail_rules_tenant_write on public.guardrail_rules
  for all
  using (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin'])
    )
  );

-- de_autonomy: the trust dial itself -- controls how much a Digital
-- Employee can do unsupervised. Owner/admin only.
drop policy if exists de_autonomy_tenant_isolation on public.de_autonomy;

create policy de_autonomy_tenant_read on public.de_autonomy
  for select
  using (tenant_id = auth_tenant_id());

create policy de_autonomy_tenant_write on public.de_autonomy
  for all
  using (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin'])
    )
  );

-- connectors: connecting external systems is credentials-adjacent.
-- Owner/admin only.
drop policy if exists connectors_tenant_isolation on public.connectors;

create policy connectors_tenant_read on public.connectors
  for select
  using (tenant_id = auth_tenant_id());

create policy connectors_tenant_write on public.connectors
  for all
  using (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin'])
    )
  );

-- playbook_definitions: operational, not credentials/compliance --
-- owner/admin/manager, matching departments/capabilities' broader tier.
drop policy if exists playbook_definitions_tenant_isolation on public.playbook_definitions;

create policy playbook_definitions_tenant_read on public.playbook_definitions
  for select
  using (tenant_id = auth_tenant_id());

create policy playbook_definitions_tenant_write on public.playbook_definitions
  for all
  using (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin', 'tenant_manager'])
    )
  );

-- publish_onboarding_template: owner/admin only (matches the same tier as
-- connectors/guardrails -- publishing changes what every new customer
-- experiences).
create or replace function public.publish_onboarding_template(p_template_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tpl     onboarding_templates;
  v_errors  text[];
  v_version integer;
  v_vid     uuid;
begin
  select * into v_tpl from onboarding_templates where id = p_template_id;
  if not found then
    return jsonb_build_object('error', 'template_not_found');
  end if;
  if not exists (
    select 1 from profiles
    where user_id = auth.uid() and tenant_id = v_tpl.tenant_id and coalesce(is_active, true) = true
      and role = any (array['tenant_owner', 'tenant_admin'])
  ) then
    raise exception 'only workspace owners/admins can publish an onboarding template';
  end if;

  v_errors := validate_onboarding_items(v_tpl.items);
  if array_length(v_errors, 1) is not null then
    return jsonb_build_object('errors', to_jsonb(v_errors));
  end if;

  v_version := v_tpl.version + 1;
  insert into onboarding_template_versions (template_id, tenant_id, version, name, description, items, published_by)
  values (v_tpl.id, v_tpl.tenant_id, v_version, v_tpl.name, v_tpl.description, v_tpl.items, auth.uid())
  returning id into v_vid;

  update onboarding_templates
    set version = v_version, status = 'published'
    where id = v_tpl.id;

  perform append_audit_event_internal(
    v_tpl.tenant_id, 'You', 'human',
    format('Onboarding template published — %s v%s (%s items)', v_tpl.name, v_version, jsonb_array_length(v_tpl.items)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_template_publish', 'template_id', v_tpl.id,
                       'version_id', v_vid, 'version', v_version,
                       'item_count', jsonb_array_length(v_tpl.items)));

  return jsonb_build_object('version_id', v_vid, 'version', v_version);
end;
$function$;

-- set_connector_secret / purge_connector_secret: owner/admin only,
-- matching the connectors table's own new write gate above.
create or replace function public.set_connector_secret(p_connector_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where c.id = p_connector_id and p.user_id = auth.uid() and coalesce(p.is_active, true) = true
      and p.role = any (array['tenant_owner', 'tenant_admin'])
  ) then
    raise exception 'only workspace owners/admins can set a connector''s credential';
  end if;

  insert into connector_secrets (connector_id, secret)
  values (p_connector_id, p_secret)
  on conflict (connector_id) do update
    set secret = excluded.secret, updated_at = now();
end;
$function$;

create or replace function public.purge_connector_secret(p_connector_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where c.id = p_connector_id and p.user_id = auth.uid() and coalesce(p.is_active, true) = true
      and p.role = any (array['tenant_owner', 'tenant_admin'])
  ) then
    raise exception 'only workspace owners/admins can remove a connector''s credential';
  end if;

  delete from connector_secrets where connector_id = p_connector_id;
end;
$function$;
