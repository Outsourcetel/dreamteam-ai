-- Migration 105: Remote Access could not write to any of the 13 tables
-- (nor call 3 RPCs) that migration 064 put behind an intra-tenant role
-- gate. Confirmed live while trying to publish a playbook via the
-- Playbook Builder UI under Remote Access into Acme Telecom: the insert
-- 42501'd with "new row violates row-level security policy for table
-- playbook_definitions".
--
-- Root cause: migration 064 (and the tables/functions that later copied
-- its shape -- agentic_step_policies/070, de_learning_policies/103,
-- knowledge_gap_policies/070) added, on top of the existing
-- `tenant_id = auth_tenant_id()` clause, a SECOND clause requiring the
-- caller's own `profiles` row (found via bare `auth.uid()`) to carry an
-- elevated role:
--
--   exists (select 1 from profiles
--           where user_id = auth.uid() and role = any(array[...]))
--
-- auth_tenant_id() (058) already resolves correctly under Remote Access
-- via its platform_access_events fallback branch -- that part was never
-- broken. But this second, role-specific clause bypasses auth_tenant_id()
-- entirely and looks the operator up directly: a platform admin's own
-- profile has no tenant_id/role in the tenant being visited, so the
-- EXISTS is always false for them, regardless of session state.
--
-- This was very likely an unintended regression, not a deliberate
-- decision to lock Remote Access out: every one of these tables already
-- carries `trg_remote_access_audit` (migrations 062-063), whose own
-- log_remote_access_write() trigger function is written entirely around
-- the premise that a platform admin's direct writes to these exact
-- tables are expected and need auditing. Migration 064 shipped afterward
-- and nobody connected the two.
--
-- Fix: a single choke-point function mirroring auth_tenant_id()'s own
-- two-branch shape (own profile OR an active, audited Remote Access
-- session), reused everywhere the inline EXISTS check appeared. A role
-- clause always appears ANDed with a tenant_id/auth_tenant_id() match in
-- every affected policy, so auth_has_tenant_role() only needs to answer
-- "does the caller hold one of these roles in whichever tenant is
-- already resolved" -- the row-level tenant scoping is handled by the
-- other half of the AND, exactly as it was before this fix.
--
-- Deliberately NOT touched: the ~20 other functions with a similar
-- inline profiles/role/auth.uid() shape found via a broader live scan
-- (team management, tenant API keys, IP allowlist, session policy,
-- monthly budget, access grants, tenant ownership transfer). Those are
-- tenant-security-tier administrative actions that migrations 077-078
-- deliberately moved onto their own, more narrowly-scoped
-- platform_capability_grants system rather than blanket owner/admin
-- parity -- folding them into this helper would quietly re-widen exactly
-- what that system was built to scope down. That's a separate, explicit
-- design decision, not a bug of this shape.
-- =====================================================================

create or replace function public.auth_has_tenant_role(required_roles text[])
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select
    exists (
      select 1 from public.profiles
      where user_id = auth.uid() and coalesce(is_active, true) = true
        and role = any(required_roles)
    )
    or
    public.resolve_remote_access_tenant(auth.uid(), public.auth_tenant_id()) is not null;
$function$;

-- CREATE FUNCTION grants PUBLIC execute by default; a fresh function
-- (unlike the create-or-replace calls below on pre-existing functions,
-- which keep whatever grants they already had) needs this revoked
-- explicitly. Caught live: proacl showed a bare `=X/postgres` entry
-- (PUBLIC) plus anon after the initial apply of this migration.
revoke all on function public.auth_has_tenant_role(text[]) from public;
revoke all on function public.auth_has_tenant_role(text[]) from anon;
grant execute on function public.auth_has_tenant_role(text[]) to authenticated, service_role;

-- ── agentic_step_policies (073) ─────────────────────────────────────
drop policy if exists agentic_step_policies_tenant_write on public.agentic_step_policies;
create policy agentic_step_policies_tenant_write on public.agentic_step_policies
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']))
  with check (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

-- ── capabilities (002/064) ──────────────────────────────────────────
drop policy if exists capabilities_tenant_write on public.capabilities;
create policy capabilities_tenant_write on public.capabilities
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager']));

-- ── connectors (064) ────────────────────────────────────────────────
drop policy if exists connectors_tenant_write on public.connectors;
create policy connectors_tenant_write on public.connectors
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

-- ── conversations (037) ─────────────────────────────────────────────
drop policy if exists "Tenant agents manage conversations" on public.conversations;
create policy "Tenant agents manage conversations" on public.conversations
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_admin', 'tenant_manager', 'agent']));

-- ── de_autonomy (064) ───────────────────────────────────────────────
drop policy if exists de_autonomy_tenant_write on public.de_autonomy;
create policy de_autonomy_tenant_write on public.de_autonomy
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

-- ── de_learning_policies (103) ──────────────────────────────────────
drop policy if exists de_learning_policies_tenant_write on public.de_learning_policies;
create policy de_learning_policies_tenant_write on public.de_learning_policies
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']))
  with check (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

-- ── departments (002/064) ───────────────────────────────────────────
drop policy if exists departments_tenant_write on public.departments;
create policy departments_tenant_write on public.departments
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager']));

-- ── digital_employees (037/064) ─────────────────────────────────────
drop policy if exists de_tenant_admin_write on public.digital_employees;
create policy de_tenant_admin_write on public.digital_employees
  for insert
  with check (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

drop policy if exists de_tenant_admin_update on public.digital_employees;
create policy de_tenant_admin_update on public.digital_employees
  for update
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']))
  with check (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

drop policy if exists de_tenant_admin_delete on public.digital_employees;
create policy de_tenant_admin_delete on public.digital_employees
  for delete
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

-- ── guardrail_rules (064) ───────────────────────────────────────────
drop policy if exists guardrail_rules_tenant_write on public.guardrail_rules;
create policy guardrail_rules_tenant_write on public.guardrail_rules
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

-- ── knowledge_articles ──────────────────────────────────────────────
drop policy if exists "Tenant staff manage articles" on public.knowledge_articles;
create policy "Tenant staff manage articles" on public.knowledge_articles
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_admin', 'tenant_manager', 'agent']));

-- ── knowledge_gap_policies (070) ────────────────────────────────────
drop policy if exists knowledge_gap_policies_tenant_write on public.knowledge_gap_policies;
create policy knowledge_gap_policies_tenant_write on public.knowledge_gap_policies
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']))
  with check (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

-- ── messages ────────────────────────────────────────────────────────
drop policy if exists "Tenant agents insert messages" on public.messages;
create policy "Tenant agents insert messages" on public.messages
  for insert
  with check (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_admin', 'tenant_manager', 'agent']));

-- ── playbook_definitions (064) -- the bug that surfaced all of this ──
drop policy if exists playbook_definitions_tenant_write on public.playbook_definitions;
create policy playbook_definitions_tenant_write on public.playbook_definitions
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager']));

-- ── tenant_activity_log (066) -- a SELECT policy, not a write, but the
-- identical bug shape: a platform admin couldn't even READ a tenant's
-- own activity log via Remote Access. ─────────────────────────────────
drop policy if exists tenant_activity_log_select on public.tenant_activity_log;
create policy tenant_activity_log_select on public.tenant_activity_log
  for select
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

-- ── workspaces (002/064) ────────────────────────────────────────────
drop policy if exists workspaces_tenant_write on public.workspaces;
create policy workspaces_tenant_write on public.workspaces
  for all
  using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

-- ============================================================
-- The 3 RPCs migration 064 introduced alongside the tables above, with
-- the identical inline check, tied to a specific row's tenant rather
-- than the caller's own -- rewritten to compare that row's tenant
-- against auth_tenant_id() (remote-access-aware) instead of joining
-- straight to the caller's own profiles row.
-- ============================================================

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
  if not (v_tpl.tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin'])) then
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

create or replace function public.set_connector_secret(p_connector_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from connectors where id = p_connector_id;
  if v_tenant is null then
    raise exception 'connector not found';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not (v_tenant = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']))
  then
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
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from connectors where id = p_connector_id;
  if v_tenant is null then
    raise exception 'connector not found';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not (v_tenant = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin']))
  then
    raise exception 'only workspace owners/admins can remove a connector''s credential';
  end if;

  delete from connector_secrets where connector_id = p_connector_id;
end;
$function$;
