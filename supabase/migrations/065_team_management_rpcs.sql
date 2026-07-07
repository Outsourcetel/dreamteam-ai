-- Migration 065: gap 7 from the 2026-07-07 adversarial pass. "Manage my
-- team" (src/lib/useUsers.ts's updateRole/toggleStatus/remove) was found
-- to be entirely non-functional for managing anyone OTHER than yourself:
-- every mutation was a raw table write against another user's profiles
-- row, but no RLS policy has ever allowed that (only "own profile" and
-- "platform admin manages all" policies exist). The UI's optimistic
-- update made this look like it worked; nothing ever actually changed.
--
-- Real SECURITY DEFINER RPCs, one per action, each requiring the caller
-- to be tenant_owner/tenant_admin, active, and in the SAME tenant as the
-- target. Per the founder's explicit direction: the tenant_owner is
-- untouchable through these -- can't be role-changed, deactivated, or
-- removed by an admin -- but ownership itself is transferable via a
-- dedicated function only the CURRENT owner can call.
-- =====================================================================

create or replace function public.update_team_member_role(p_target_user_id uuid, p_new_role text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_tenant uuid;
  v_caller_role text;
  v_target_tenant uuid;
  v_target_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if auth.uid() = p_target_user_id then
    raise exception 'use a different flow to change your own role';
  end if;
  if p_new_role in ('tenant_owner', 'dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing', 'platform_super_admin', 'platform_support', 'platform_billing') then
    raise exception 'use transfer_tenant_ownership to hand off ownership; this function cannot grant owner or platform-tier roles';
  end if;

  select tenant_id, role into v_caller_tenant, v_caller_role
  from profiles where user_id = auth.uid() and coalesce(is_active, true) = true;
  if v_caller_tenant is null or v_caller_role not in ('tenant_owner', 'tenant_admin') then
    raise exception 'only workspace owners/admins can change a teammate''s role';
  end if;

  select tenant_id, role into v_target_tenant, v_target_role
  from profiles where user_id = p_target_user_id;
  if v_target_tenant is null or v_target_tenant is distinct from v_caller_tenant then
    raise exception 'that person is not a member of this workspace';
  end if;
  if v_target_role = 'tenant_owner' then
    raise exception 'the workspace owner''s role can only be changed by transferring ownership';
  end if;

  update profiles set role = p_new_role where user_id = p_target_user_id;

  perform append_audit_event_internal(
    v_caller_tenant, 'You', 'human',
    format('Team member role changed to %s', p_new_role),
    'config_change',
    jsonb_build_object('kind', 'team_role_change', 'target_user_id', p_target_user_id, 'new_role', p_new_role)
  );

  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.set_team_member_status(p_target_user_id uuid, p_is_active boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_tenant uuid;
  v_caller_role text;
  v_target_tenant uuid;
  v_target_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if auth.uid() = p_target_user_id then
    raise exception 'you cannot change your own active status here';
  end if;

  select tenant_id, role into v_caller_tenant, v_caller_role
  from profiles where user_id = auth.uid() and coalesce(is_active, true) = true;
  if v_caller_tenant is null or v_caller_role not in ('tenant_owner', 'tenant_admin') then
    raise exception 'only workspace owners/admins can change a teammate''s status';
  end if;

  select tenant_id, role into v_target_tenant, v_target_role
  from profiles where user_id = p_target_user_id;
  if v_target_tenant is null or v_target_tenant is distinct from v_caller_tenant then
    raise exception 'that person is not a member of this workspace';
  end if;
  if v_target_role = 'tenant_owner' then
    raise exception 'the workspace owner cannot be deactivated';
  end if;

  update profiles set is_active = p_is_active where user_id = p_target_user_id;

  perform append_audit_event_internal(
    v_caller_tenant, 'You', 'human',
    case when p_is_active then 'Team member reactivated' else 'Team member deactivated' end,
    'config_change',
    jsonb_build_object('kind', 'team_status_change', 'target_user_id', p_target_user_id, 'is_active', p_is_active)
  );

  return jsonb_build_object('ok', true);
end;
$function$;

-- Soft-remove, not a hard delete: a real team member accumulates real
-- history (assigned human_tasks, resolved tickets, audit_events actor
-- references) that a hard DELETE would either orphan or be blocked by
-- FK constraints on, the same shape of problem hit cleaning up disposable
-- test accounts earlier today. Deactivates permanently and clears
-- tenant_id so they no longer appear as a member or consume a seat,
-- while every historical record naming them stays intact.
create or replace function public.remove_team_member(p_target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_tenant uuid;
  v_caller_role text;
  v_target_tenant uuid;
  v_target_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if auth.uid() = p_target_user_id then
    raise exception 'you cannot remove yourself here';
  end if;

  select tenant_id, role into v_caller_tenant, v_caller_role
  from profiles where user_id = auth.uid() and coalesce(is_active, true) = true;
  if v_caller_tenant is null or v_caller_role not in ('tenant_owner', 'tenant_admin') then
    raise exception 'only workspace owners/admins can remove a teammate';
  end if;

  select tenant_id, role into v_target_tenant, v_target_role
  from profiles where user_id = p_target_user_id;
  if v_target_tenant is null or v_target_tenant is distinct from v_caller_tenant then
    raise exception 'that person is not a member of this workspace';
  end if;
  if v_target_role = 'tenant_owner' then
    raise exception 'the workspace owner cannot be removed -- transfer ownership first';
  end if;

  update profiles set is_active = false, tenant_id = null where user_id = p_target_user_id;

  perform append_audit_event_internal(
    v_caller_tenant, 'You', 'human',
    'Team member removed',
    'config_change',
    jsonb_build_object('kind', 'team_member_removed', 'target_user_id', p_target_user_id)
  );

  return jsonb_build_object('ok', true);
end;
$function$;

-- Only the CURRENT owner can initiate a transfer -- not an admin acting
-- on the owner's behalf, which would be a privilege-escalation path in
-- disguise. New owner must already be an active member of the same
-- tenant. The old owner becomes tenant_admin, not removed or demoted
-- further -- they keep full operational access, just not the owner seat.
create or replace function public.transfer_tenant_ownership(p_new_owner_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_tenant uuid;
  v_caller_role text;
  v_target_tenant uuid;
  v_target_active boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if auth.uid() = p_new_owner_user_id then
    raise exception 'you are already the owner';
  end if;

  select tenant_id, role into v_caller_tenant, v_caller_role
  from profiles where user_id = auth.uid() and coalesce(is_active, true) = true;
  if v_caller_tenant is null or v_caller_role <> 'tenant_owner' then
    raise exception 'only the current workspace owner can transfer ownership';
  end if;

  select tenant_id, coalesce(is_active, true) into v_target_tenant, v_target_active
  from profiles where user_id = p_new_owner_user_id;
  if v_target_tenant is null or v_target_tenant is distinct from v_caller_tenant then
    raise exception 'the new owner must already be a member of this workspace';
  end if;
  if not v_target_active then
    raise exception 'the new owner must be an active team member';
  end if;

  update profiles set role = 'tenant_admin' where user_id = auth.uid();
  update profiles set role = 'tenant_owner' where user_id = p_new_owner_user_id;

  perform append_audit_event_internal(
    v_caller_tenant, 'You', 'human',
    'Workspace ownership transferred',
    'config_change',
    jsonb_build_object('kind', 'ownership_transfer', 'previous_owner', auth.uid(), 'new_owner', p_new_owner_user_id)
  );

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.update_team_member_role(uuid, text) from public, anon;
revoke all on function public.set_team_member_status(uuid, boolean) from public, anon;
revoke all on function public.remove_team_member(uuid) from public, anon;
revoke all on function public.transfer_tenant_ownership(uuid) from public, anon;
grant execute on function public.update_team_member_role(uuid, text) to authenticated;
grant execute on function public.set_team_member_status(uuid, boolean) to authenticated;
grant execute on function public.remove_team_member(uuid) to authenticated;
grant execute on function public.transfer_tenant_ownership(uuid) to authenticated;

-- Department isn't a privilege-bearing field (unlike role/status), so this
-- one doesn't need the owner-immutability guard -- just membership + an
-- admin-tier caller, consistent with the others.
create or replace function public.update_team_member_department(p_target_user_id uuid, p_department text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_tenant uuid;
  v_caller_role text;
  v_target_tenant uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select tenant_id, role into v_caller_tenant, v_caller_role
  from profiles where user_id = auth.uid() and coalesce(is_active, true) = true;
  if v_caller_tenant is null or v_caller_role not in ('tenant_owner', 'tenant_admin') then
    raise exception 'only workspace owners/admins can change a teammate''s department';
  end if;

  select tenant_id into v_target_tenant from profiles where user_id = p_target_user_id;
  if v_target_tenant is null or v_target_tenant is distinct from v_caller_tenant then
    raise exception 'that person is not a member of this workspace';
  end if;

  update profiles set department = p_department where user_id = p_target_user_id;

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.update_team_member_department(uuid, text) from public, anon;
grant execute on function public.update_team_member_department(uuid, text) to authenticated;
