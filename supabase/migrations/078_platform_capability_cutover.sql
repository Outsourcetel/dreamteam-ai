-- ============================================================
-- Migration 078: cutover — flip real, single-purpose platform gates
-- from the coarse is_platform_admin() check to the specific capability
-- resolve_platform_capability() now requires (migration 077). Each
-- section below is independently reasoned about and reversible; is_
-- platform_admin() itself is untouched and stays correct as the "is
-- this a platform account at all" existence check elsewhere.
--
-- SCOPE NOTE, decided by re-reading every current call site live
-- (not trusting a prior summary): three sites originally thought to
-- be in scope are deliberately NOT touched here:
--   - caller_has_tenant_relationship() (050) — a deeply shared helper
--     behind many unrelated tenant-hierarchy functions, where
--     is_platform_admin() is one of three legitimate-relationship
--     branches (own tenant membership, ancestor tenant membership,
--     platform admin). Narrowing it needs its own audit of every
--     caller first; left on the coarse check for now.
--   - get_identity_inventory() — read its CURRENT (059) definition:
--     it no longer references is_platform_admin() at all, already
--     tightened to a service-role-only bypass. Nothing to flip.
--   - the tenant "self-serve sub-tenants" toggle (src/lib/api.ts's
--     setTenantSelfServe) — it does a direct client .update() on
--     tenants, and tenants has no UPDATE RLS policy at all (only the
--     tn_sel SELECT policy exists). This write has been silently
--     RLS-blocked all along — a genuinely dead capability, same
--     shape as the "+ Provision Tenant"/"Suspend" dead buttons
--     already out of scope per the plan. Not wiring it here.
-- ============================================================

-- ── team.manage: invite / list / revoke platform teammates ──
create or replace function invite_platform_team_member(p_email text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_invite platform_invites;
begin
  if not resolve_platform_capability(auth.uid(), 'team.manage') then
    raise exception 'only a platform team manager may invite a platform team member';
  end if;

  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'a valid email address is required';
  end if;

  if p_role not in ('platform_support', 'platform_billing', 'platform_super_admin') then
    raise exception 'unrecognized platform role: %', p_role;
  end if;

  update platform_invites
  set status = 'revoked'
  where lower(email) = v_email and status = 'pending';

  insert into platform_invites (email, role, invited_by)
  values (v_email, p_role, auth.uid())
  returning * into v_invite;

  return jsonb_build_object(
    'ok', true,
    'invite_id', v_invite.id,
    'invite_code', v_invite.invite_code,
    'email', v_invite.email,
    'role', v_invite.role
  );
end;
$function$;

create or replace function list_platform_invites()
returns setof platform_invites
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not resolve_platform_capability(auth.uid(), 'team.manage') then
    raise exception 'only a platform team manager may view platform invites';
  end if;
  return query select * from platform_invites order by created_at desc;
end;
$function$;

create or replace function revoke_platform_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_invite platform_invites;
begin
  if not resolve_platform_capability(auth.uid(), 'team.manage') then
    raise exception 'only a platform team manager may revoke a platform invite';
  end if;

  select * into v_invite from platform_invites where id = p_invite_id for update;
  if not found then
    raise exception 'invite not found';
  end if;
  if v_invite.status <> 'pending' then
    raise exception 'this invite is already % and cannot be revoked', v_invite.status;
  end if;

  update platform_invites set status = 'revoked' where id = p_invite_id;

  return jsonb_build_object('ok', true, 'invite_id', p_invite_id, 'status', 'revoked');
end;
$function$;

-- ── tenants.view: visibility over the tenant list, provisioning
-- requests, and feature-flag overrides ──
drop policy if exists tn_sel on tenants;
create policy tn_sel on tenants
  for select
  using (id = auth_tenant_id() or resolve_platform_capability(auth.uid(), 'tenants.view'));

drop policy if exists tpr_select on tenant_provisioning_requests;
create policy tpr_select on tenant_provisioning_requests
  for select
  using (
    requested_by_user_id = auth.uid()
    or resolve_platform_capability(auth.uid(), 'tenants.view')
    or exists (
      select 1 from profiles pr
      where pr.user_id = auth.uid() and pr.tenant_id = tenant_provisioning_requests.proposed_parent_tenant_id
    )
  );

drop policy if exists tfo_select on tenant_feature_overrides;
create policy tfo_select on tenant_feature_overrides
  for select
  using (
    resolve_platform_capability(auth.uid(), 'tenants.view')
    or exists (select 1 from profiles pr where pr.user_id = auth.uid() and pr.tenant_id = tenant_feature_overrides.tenant_id)
  );

create or replace function public.is_feature_enabled(p_tenant_id uuid, p_feature_key text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_override boolean;
  v_default  boolean;
begin
  if not (
    resolve_platform_capability(auth.uid(), 'tenants.view')
    or exists (select 1 from profiles pr where pr.user_id = auth.uid() and pr.tenant_id = p_tenant_id and coalesce(pr.is_active, true) = true)
  ) then
    raise exception 'not authorized to check feature flags for this tenant';
  end if;

  select enabled into v_override from tenant_feature_overrides
  where tenant_id = p_tenant_id and feature_key = p_feature_key;
  if found then
    return v_override;
  end if;

  select default_enabled into v_default from feature_registry where key = p_feature_key;
  if not found then
    raise exception 'unknown feature key: %', p_feature_key;
  end if;
  return v_default;
end;
$function$;

-- ── tenants.manage: approve/reject provisioning requests, toggle
-- feature flags ──
create or replace function approve_subtenant_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req      tenant_provisioning_requests;
  v_slug     text;
  v_base_slug text;
  v_suffix   int := 0;
  v_tenant   tenants;
  v_requester_tenant uuid;
begin
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
    raise exception 'only a platform team member with tenant management access may approve a tenant provisioning request';
  end if;

  select * into v_req from tenant_provisioning_requests where id = p_request_id for update;
  if not found then
    raise exception 'provisioning request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'this request has already been decided (status=%)', v_req.status;
  end if;

  v_base_slug := lower(regexp_replace(btrim(v_req.proposed_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := trim(both '-' from v_base_slug);
  if coalesce(v_base_slug, '') = '' then
    v_base_slug := 'org';
  end if;
  v_slug := v_base_slug;
  while exists (select 1 from tenants where slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix::text;
  end loop;

  insert into tenants (name, slug, industry, plan, status, settings, parent_tenant_id)
  values (v_req.proposed_name, v_slug, nullif(btrim(coalesce(v_req.proposed_industry, '')), ''), 'starter', 'trial', '{}'::jsonb, v_req.proposed_parent_tenant_id)
  returning * into v_tenant;

  update tenant_provisioning_requests
  set status = 'approved', reviewed_by = auth.uid(), decided_at = now(), created_tenant_id = v_tenant.id
  where id = p_request_id;

  select tenant_id into v_requester_tenant from profiles where user_id = v_req.requested_by_user_id;
  if v_requester_tenant is null then
    update profiles
    set tenant_id = v_tenant.id, role = 'tenant_owner', updated_at = now()
    where user_id = v_req.requested_by_user_id and tenant_id is null;
  end if;

  if v_req.proposed_parent_tenant_id is not null and exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_req.proposed_parent_tenant_id
  ) then
    perform append_audit_event(
      v_req.proposed_parent_tenant_id, 'Platform admin', 'human',
      format('Sub-tenant "%s" approved and created (request %s, new tenant id %s)', v_tenant.name, p_request_id, v_tenant.id),
      'config_change',
      jsonb_build_object('kind', 'tenant_provisioning_approved', 'request_id', p_request_id,
        'tenant_id', v_tenant.id, 'parent_tenant_id', v_req.proposed_parent_tenant_id,
        'approved_by', auth.uid(), 'requested_by', v_req.requested_by_user_id)
    );
  end if;

  return jsonb_build_object('ok', true, 'tenant_id', v_tenant.id, 'slug', v_tenant.slug);
end;
$function$;

create or replace function reject_subtenant_request(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req tenant_provisioning_requests;
begin
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
    raise exception 'only a platform team member with tenant management access may reject a tenant provisioning request';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a rejection reason is required';
  end if;

  select * into v_req from tenant_provisioning_requests where id = p_request_id for update;
  if not found then
    raise exception 'provisioning request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'this request has already been decided (status=%)', v_req.status;
  end if;

  update tenant_provisioning_requests
  set status = 'rejected', reviewed_by = auth.uid(), decided_at = now(), rejection_reason = btrim(p_reason)
  where id = p_request_id;

  if v_req.proposed_parent_tenant_id is not null and exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_req.proposed_parent_tenant_id
  ) then
    perform append_audit_event(
      v_req.proposed_parent_tenant_id, 'Platform admin', 'human',
      format('Sub-tenant request "%s" rejected — %s', v_req.proposed_name, btrim(p_reason)),
      'config_change',
      jsonb_build_object('kind', 'tenant_provisioning_rejected', 'request_id', p_request_id,
        'proposed_name', v_req.proposed_name, 'reason', btrim(p_reason), 'rejected_by', auth.uid(),
        'requested_by', v_req.requested_by_user_id)
    );
  end if;

  return jsonb_build_object('ok', true, 'rejected', true, 'reason', btrim(p_reason));
end;
$function$;

create or replace function public.set_tenant_feature_override(p_tenant_id uuid, p_feature_key text, p_enabled boolean, p_note text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
    raise exception 'only a platform team member with tenant management access may set a tenant feature override';
  end if;

  if not exists (select 1 from feature_registry where key = p_feature_key) then
    raise exception 'unknown feature key: %', p_feature_key;
  end if;

  insert into tenant_feature_overrides (tenant_id, feature_key, enabled, set_by, note, updated_at)
  values (p_tenant_id, p_feature_key, p_enabled, auth.uid(), p_note, now())
  on conflict (tenant_id, feature_key)
  do update set enabled = excluded.enabled, set_by = excluded.set_by, note = excluded.note, updated_at = now();

  perform reconcile_tenant_feature(p_tenant_id, p_feature_key, p_enabled);

  if exists (select 1 from profiles where user_id = auth.uid() and tenant_id = p_tenant_id) then
    perform append_audit_event(
      p_tenant_id, 'Platform admin', 'human',
      format('Feature "%s" set to %s for this tenant', p_feature_key, case when p_enabled then 'ON' else 'OFF' end),
      'config_change',
      jsonb_build_object('kind', 'tenant_feature_override_set', 'feature_key', p_feature_key,
        'enabled', p_enabled, 'set_by', auth.uid(), 'note', p_note)
    );
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

-- ── tenants.provision: create a brand-new top-level tenant directly ──
create or replace function request_subtenant(p_parent_tenant_id uuid, p_name text, p_industry text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user       uuid := auth.uid();
  v_role       text;
  v_caller_tenant uuid;
  v_is_active  boolean;
  v_parent     tenants;
  v_is_platform boolean := resolve_platform_capability(auth.uid(), 'tenants.provision');
  v_slug       text;
  v_base_slug  text;
  v_suffix     int := 0;
  v_tenant     tenants;
  v_request_id uuid;
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'proposed tenant name is required';
  end if;

  if p_parent_tenant_id is null then
    if not v_is_platform then
      raise exception 'only a platform admin with tenant-provisioning access may create a new top-level tenant';
    end if;
  else
    if p_parent_tenant_id = v_demo_tenant_id then
      raise exception 'the demo tenant cannot be used as a parent tenant';
    end if;

    select * into v_parent from tenants where id = p_parent_tenant_id;
    if not found then
      raise exception 'parent tenant not found';
    end if;

    select role, tenant_id, coalesce(is_active, true) into v_role, v_caller_tenant, v_is_active from profiles where user_id = v_user;

    if not v_is_platform then
      if v_caller_tenant is distinct from p_parent_tenant_id or v_role not in ('tenant_owner', 'tenant_admin') then
        raise exception 'only an owner or admin of the parent tenant may request a sub-tenant';
      end if;
      if not v_is_active then
        raise exception 'account is deactivated';
      end if;
    end if;
  end if;

  if v_is_platform or (p_parent_tenant_id is not null and v_parent.allow_self_serve_subtenants) then
    v_base_slug := lower(regexp_replace(btrim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
    v_base_slug := trim(both '-' from v_base_slug);
    if coalesce(v_base_slug, '') = '' then
      v_base_slug := 'org';
    end if;
    v_slug := v_base_slug;
    while exists (select 1 from tenants where slug = v_slug) loop
      v_suffix := v_suffix + 1;
      v_slug := v_base_slug || '-' || v_suffix::text;
    end loop;

    insert into tenants (name, slug, industry, plan, status, settings, parent_tenant_id)
    values (btrim(p_name), v_slug, nullif(btrim(coalesce(p_industry, '')), ''), 'starter', 'trial', '{}'::jsonb, p_parent_tenant_id)
    returning * into v_tenant;

    insert into tenant_provisioning_requests
      (requested_by_user_id, proposed_parent_tenant_id, proposed_name, proposed_industry, status, reviewed_by, decided_at, created_tenant_id)
    values
      (v_user, p_parent_tenant_id, btrim(p_name), p_industry, 'approved', v_user, now(), v_tenant.id)
    returning id into v_request_id;

    return jsonb_build_object('ok', true, 'path', 'self_serve', 'tenant_id', v_tenant.id, 'slug', v_tenant.slug, 'request_id', v_request_id);
  end if;

  insert into tenant_provisioning_requests
    (requested_by_user_id, proposed_parent_tenant_id, proposed_name, proposed_industry, status)
  values
    (v_user, p_parent_tenant_id, btrim(p_name), p_industry, 'pending')
  returning id into v_request_id;

  return jsonb_build_object('ok', true, 'path', 'pending_platform_approval', 'request_id', v_request_id);
end;
$function$;

-- ── remote_access.use: start/end a Remote Access session ──
create or replace function public.start_platform_remote_access(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_session uuid := gen_random_uuid();
  v_operator_name text;
  v_tenant tenants;
begin
  if not resolve_platform_capability(auth.uid(), 'remote_access.use') then
    raise exception 'only a platform team member with remote access may start a remote access session';
  end if;

  if exists (select 1 from auth.mfa_factors where user_id = auth.uid() and status = 'verified') then
    if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
      raise exception 'Please verify your two-factor authentication code to use Remote Access.';
    end if;
  end if;

  select * into v_tenant from tenants where id = p_tenant_id;
  if not found then
    raise exception 'tenant not found';
  end if;

  select full_name into v_operator_name from profiles where user_id = auth.uid();

  insert into platform_access_events (tenant_id, operator_user_id, operator_name, event, session_key, detail)
  values (p_tenant_id, auth.uid(), coalesce(v_operator_name, 'Platform admin'), 'start', v_session,
    jsonb_build_object('tenant_name', v_tenant.name));

  return jsonb_build_object('ok', true, 'session_key', v_session, 'tenant_id', p_tenant_id, 'tenant_name', v_tenant.name);
end;
$function$;

create or replace function public.end_platform_remote_access(p_session_key uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_start platform_access_events;
begin
  if not resolve_platform_capability(auth.uid(), 'remote_access.use') then
    raise exception 'only a platform team member with remote access may end a remote access session';
  end if;

  select * into v_start from platform_access_events
  where session_key = p_session_key and event = 'start' and operator_user_id = auth.uid()
  order by created_at desc limit 1;

  if not found then
    raise exception 'no matching remote access session found to end';
  end if;

  if exists (select 1 from platform_access_events where session_key = p_session_key and event = 'end') then
    raise exception 'this remote access session has already been ended';
  end if;

  insert into platform_access_events (tenant_id, operator_user_id, operator_name, event, session_key, detail)
  values (v_start.tenant_id, auth.uid(), v_start.operator_name, 'end', p_session_key,
    jsonb_build_object('duration_seconds', extract(epoch from (now() - v_start.created_at))));

  return jsonb_build_object('ok', true, 'session_key', p_session_key);
end;
$function$;

-- ── remote_access.audit: read the session log + write-audit log ──
drop policy if exists platform_access_events_select on platform_access_events;
create policy platform_access_events_select on platform_access_events
  for select using (resolve_platform_capability(auth.uid(), 'remote_access.audit'));

drop policy if exists remote_access_write_log_select on public.remote_access_write_log;
create policy remote_access_write_log_select on public.remote_access_write_log
  for select using (resolve_platform_capability(auth.uid(), 'remote_access.audit'));

-- ── billing.manage: platform-wide LLM provider API keys ──
create or replace function platform_config_set(p_entries jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  k text;
  v text;
begin
  if not resolve_platform_capability(auth.uid(), 'billing.manage') then
    raise exception 'not authorized';
  end if;

  for k, v in select * from jsonb_each_text(p_entries)
  loop
    insert into platform_config (key, value, updated_at)
    values (k, v, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end loop;

  return true;
end;
$$;

create or replace function platform_config_has_key(p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not resolve_platform_capability(auth.uid(), 'billing.manage') then
    raise exception 'not authorized';
  end if;
  return exists (select 1 from platform_config where key = p_key);
end;
$$;

-- ── Grant hygiene, found by this migration's own verification pass ──
-- platform_config_has_key and is_platform_admin both carried a stray
-- anon EXECUTE grant that pre-dates this migration: their origin
-- migrations only ever ran `revoke all ... from PUBLIC`, which does
-- NOT strip a grant made directly to a named role like anon (the
-- same PUBLIC-vs-named-role gotcha this project's own history has
-- hit before — migration 048's "exhaustive secdef sweep"). The
-- internal is_platform_admin()/resolve_platform_capability() checks
-- inside both functions mean anon could never actually read anything
-- through them (an unauthenticated caller has no profile row, so the
-- check always fails) — but the grant itself should never have been
-- there, and is fixed here since these are exactly the two functions
-- this migration already touches. A much broader sweep (150+ other
-- functions across the schema carry the same stray anon grant,
-- unrelated to this session's work) is a separate, larger finding —
-- flagged, not fixed here, to avoid scope creep into functions this
-- migration has no reason to touch or re-verify.
revoke all on function platform_config_set(jsonb) from anon;
revoke all on function platform_config_has_key(text) from anon;
revoke all on function is_platform_admin() from anon;

-- ── support.cross_tenant: resolve a gated action-execution task across
-- tenant boundaries (used when helping resolve a human_task not in the
-- caller's own tenant) ──
create or replace function public.resolve_action_execution_for_task(p_task_id uuid)
returns action_executions
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_task_tenant uuid;
  v_row action_executions;
begin
  select tenant_id into v_task_tenant from human_tasks where id = p_task_id;
  if v_task_tenant is null then
    return null;
  end if;
  if auth.uid() is not null
     and v_task_tenant not in (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true)
     and not resolve_platform_capability(auth.uid(), 'support.cross_tenant') then
    raise exception 'tenant access denied';
  end if;
  select ae.* into v_row from action_executions ae
    where ae.task_id = p_task_id and ae.tenant_id = v_task_tenant
    order by ae.created_at desc limit 1;
  return v_row;
end;
$function$;
