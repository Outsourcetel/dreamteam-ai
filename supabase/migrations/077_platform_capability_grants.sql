-- ============================================================
-- Migration 077: platform team roster + granular capability grants.
--
-- Today every platform action is gated by exactly one check —
-- is_platform_admin() — "is this any kind of platform account at
-- all." The 3 role labels (platform_super_admin / platform_support /
-- platform_billing) are cosmetic: nothing anywhere reads them to
-- permit or deny a specific action. A platform_billing invitee today
-- can silently remote-access any tenant's live workspace and invite
-- more super-admins.
--
-- This migration is ADDITIVE ONLY — it changes zero existing
-- behavior. It ships the capability catalog, the resolution function,
-- and every new RPC needed to see/manage the platform team and their
-- per-capability grants. The ~16 existing is_platform_admin()-gated
-- call sites are cut over to the new check in migration 078, a
-- separate, independently-verifiable step.
--
-- Design mirrors data_access_grants (029) — default-deny, specific-
-- beats-general, one resolve function, all writes through guarded
-- RPCs — with one deliberate difference: roles here already grant a
-- lot by default (see the role-default table inside
-- resolve_platform_capability), so an override must be able to
-- explicitly DENY a capability a role would otherwise carry, not just
-- ADD one. `effect` is 'grant' or 'deny', not just presence=grant.
--
-- RLS follows platform_invites' stricter pattern (052), not
-- data_access_grants' tenant-visible one: zero direct client access,
-- even SELECT — this table literally defines who can do what across
-- every tenant, more sensitive than any one tenant's own grants.
-- ============================================================

-- ============================================================
-- 1. platform_capability_grants
-- ============================================================
create table if not exists platform_capability_grants (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(user_id) on delete cascade,
  capability   text not null check (capability in (
                 'tenants.view', 'tenants.manage', 'tenants.provision',
                 'remote_access.use', 'remote_access.audit',
                 'team.manage', 'billing.manage', 'support.cross_tenant')),
  effect       text not null check (effect in ('grant', 'deny')),
  granted_by   uuid references profiles(user_id),
  note         text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, capability)
);

create index if not exists idx_platform_capability_grants_user on platform_capability_grants(user_id);

alter table platform_capability_grants enable row level security;
alter table platform_capability_grants force row level security;

drop policy if exists platform_capability_grants_deny_all on platform_capability_grants;
create policy platform_capability_grants_deny_all on platform_capability_grants
  for all using (false) with check (false);
revoke all on table platform_capability_grants from anon, authenticated;

drop trigger if exists platform_capability_grants_updated_at on platform_capability_grants;
create trigger platform_capability_grants_updated_at
  before update on platform_capability_grants
  for each row execute function update_updated_at();

comment on table platform_capability_grants is
  'Per-person, per-capability overrides on top of the role-default table baked into resolve_platform_capability(). effect=grant adds a capability a role would not otherwise carry; effect=deny removes one it would. No direct client access at all -- every read/write goes through the guarded RPCs below.';

-- ============================================================
-- 2. resolve_platform_capability — THE enforcement primitive.
-- Explicit override (either direction) wins; else role default;
-- else deny. Inactive or non-platform accounts always deny.
-- ============================================================
create or replace function public.resolve_platform_capability(p_user_id uuid, p_capability text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_layer  text;
  v_role   text;
  v_active boolean;
  v_override text;
  v_role_default boolean;
begin
  select layer, role, coalesce(is_active, true) into v_layer, v_role, v_active
  from profiles where user_id = p_user_id;

  if v_layer is distinct from 'platform' or not coalesce(v_active, false) then
    return false;
  end if;

  select effect into v_override
  from platform_capability_grants
  where user_id = p_user_id and capability = p_capability;

  if v_override = 'grant' then return true; end if;
  if v_override = 'deny' then return false; end if;

  -- Role defaults — the fallback when no explicit override exists.
  -- platform_super_admin: everything (matches today's real behavior
  -- exactly, since is_platform_admin() has never differentiated).
  -- platform_support: what a support function actually needs —
  -- remote access to help a customer, cross-tenant task visibility,
  -- tenant/audit visibility — not tenant/team/billing control.
  -- platform_billing: visibility + LLM-provider-key control — not
  -- remote access or team power.
  v_role_default := case v_role
    when 'platform_super_admin' then true
    when 'platform_support' then p_capability in
      ('tenants.view', 'remote_access.use', 'remote_access.audit', 'support.cross_tenant')
    when 'platform_billing' then p_capability in
      ('tenants.view', 'remote_access.audit', 'billing.manage')
    else false
  end;

  return coalesce(v_role_default, false);
end;
$function$;

revoke all on function public.resolve_platform_capability(uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_platform_capability(uuid, text) to authenticated, service_role;

-- ============================================================
-- 3. Self-lockout guard — a shared helper. Counts active platform
-- accounts OTHER than p_exclude_user_id that currently resolve the
-- given capability (default 'team.manage'). Applying "must be >= 1"
-- as a precondition on every write that could reduce p_exclude_user_id's
-- OWN standing is safe unconditionally: if the target never held the
-- capability, excluding them from the count changes nothing, so the
-- check simply passes; if they did hold it, the check correctly
-- refuses to let the count of everyone ELSE hit zero.
-- ============================================================
create or replace function public.platform_capability_remaining_holders(p_exclude_user_id uuid, p_capability text default 'team.manage')
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
  select count(*)::integer
  from profiles p
  where p.layer = 'platform' and coalesce(p.is_active, true)
    and p.user_id <> p_exclude_user_id
    and resolve_platform_capability(p.user_id, p_capability);
$function$;

revoke all on function public.platform_capability_remaining_holders(uuid, text) from public, anon, authenticated;
grant execute on function public.platform_capability_remaining_holders(uuid, text) to authenticated, service_role;

-- ============================================================
-- 4. list_platform_team — the active roster, not just pending
-- invites. Joins profiles to auth.users for email/last_sign_in_at —
-- the same shape of SECURITY DEFINER -> auth.users read already
-- proven live in this codebase (hook_before_user_created, migration
-- 060). Gated on team.manage, not the coarse is_platform_admin() —
-- this is a brand-new function so there is no bootstrapping issue
-- (viewing the roster never required a prior grant to exist).
-- ============================================================
create or replace function public.list_platform_team()
returns table (
  user_id uuid, full_name text, email text, role text,
  is_active boolean, created_at timestamptz, last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not resolve_platform_capability(auth.uid(), 'team.manage') then
    raise exception 'only a platform team manager may view the platform roster';
  end if;
  return query
    select p.user_id, p.full_name, u.email::text, p.role, coalesce(p.is_active, true),
           p.created_at, u.last_sign_in_at
    from profiles p
    join auth.users u on u.id = p.user_id
    where p.layer = 'platform'
    order by p.created_at asc;
end;
$function$;

revoke all on function public.list_platform_team() from public, anon, authenticated;
grant execute on function public.list_platform_team() to authenticated;

-- ============================================================
-- 5. update_platform_team_role — mirrors update_team_member_role
-- (065)'s shape exactly, mirror-imaged: 065 already blocks granting
-- any platform-tier role through the TENANT RPC; this blocks granting
-- any tenant-tier role through the PLATFORM RPC. Self-targeting is
-- blocked entirely (mirrors 065's "use a different flow" pattern) —
-- nobody edits their own row through these RPCs, full stop.
-- ============================================================
create or replace function public.update_platform_team_role(p_target_user_id uuid, p_new_role text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_target_layer text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not resolve_platform_capability(auth.uid(), 'team.manage') then
    raise exception 'only a platform team manager may change a teammate''s role';
  end if;
  if auth.uid() = p_target_user_id then
    raise exception 'you cannot change your own role here';
  end if;
  if p_new_role not in ('platform_super_admin', 'platform_support', 'platform_billing') then
    raise exception 'unrecognized platform role: %', p_new_role;
  end if;

  select layer into v_target_layer from profiles where user_id = p_target_user_id;
  if v_target_layer is distinct from 'platform' then
    raise exception 'that account is not a platform team member';
  end if;

  if platform_capability_remaining_holders(p_target_user_id, 'team.manage') = 0 then
    raise exception 'this change would leave zero active platform accounts able to manage the team -- at least one must always remain';
  end if;

  update profiles set role = p_new_role where user_id = p_target_user_id;

  return jsonb_build_object('ok', true, 'user_id', p_target_user_id, 'role', p_new_role);
end;
$function$;

revoke all on function public.update_platform_team_role(uuid, text) from public, anon, authenticated;
grant execute on function public.update_platform_team_role(uuid, text) to authenticated;

-- ============================================================
-- 6. set_platform_team_active — the "revoke access" mechanism.
-- Soft-deactivate, not hard delete: platform accounts accumulate real
-- history (platform_access_events, audit trails, capability grants)
-- that a hard delete would orphan or be blocked by FKs on -- same
-- reasoning remove_team_member (065) documents for tenant teammates,
-- applying even more strongly here.
-- ============================================================
create or replace function public.set_platform_team_active(p_target_user_id uuid, p_is_active boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_target_layer text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not resolve_platform_capability(auth.uid(), 'team.manage') then
    raise exception 'only a platform team manager may change a teammate''s active status';
  end if;
  if auth.uid() = p_target_user_id then
    raise exception 'you cannot change your own active status here';
  end if;

  select layer into v_target_layer from profiles where user_id = p_target_user_id;
  if v_target_layer is distinct from 'platform' then
    raise exception 'that account is not a platform team member';
  end if;

  if not p_is_active and platform_capability_remaining_holders(p_target_user_id, 'team.manage') = 0 then
    raise exception 'this change would leave zero active platform accounts able to manage the team -- at least one must always remain';
  end if;

  update profiles set is_active = p_is_active where user_id = p_target_user_id;

  return jsonb_build_object('ok', true, 'user_id', p_target_user_id, 'is_active', p_is_active);
end;
$function$;

revoke all on function public.set_platform_team_active(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_platform_team_active(uuid, boolean) to authenticated;

-- ============================================================
-- 7. list_platform_capability_grants — powers the per-person grant
-- editor. Optionally filtered to one user.
-- ============================================================
create or replace function public.list_platform_capability_grants(p_target_user_id uuid default null)
returns setof platform_capability_grants
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not resolve_platform_capability(auth.uid(), 'team.manage') then
    raise exception 'only a platform team manager may view capability grants';
  end if;
  if p_target_user_id is not null then
    return query select * from platform_capability_grants where user_id = p_target_user_id order by capability;
  end if;
  return query select * from platform_capability_grants order by user_id, capability;
end;
$function$;

revoke all on function public.list_platform_capability_grants(uuid) from public, anon, authenticated;
grant execute on function public.list_platform_capability_grants(uuid) to authenticated;

-- ============================================================
-- 8. set_platform_capability_grant / revoke_platform_capability_grant
-- ============================================================
create or replace function public.set_platform_capability_grant(
  p_target_user_id uuid, p_capability text, p_effect text, p_note text default ''
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_target_layer text;
  v_grant platform_capability_grants;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not resolve_platform_capability(auth.uid(), 'team.manage') then
    raise exception 'only a platform team manager may change a teammate''s permissions';
  end if;
  if auth.uid() = p_target_user_id then
    raise exception 'you cannot change your own permissions here';
  end if;
  if p_effect not in ('grant', 'deny') then
    raise exception 'effect must be grant or deny';
  end if;
  if p_capability not in (
    'tenants.view', 'tenants.manage', 'tenants.provision',
    'remote_access.use', 'remote_access.audit',
    'team.manage', 'billing.manage', 'support.cross_tenant'
  ) then
    raise exception 'unrecognized capability: %', p_capability;
  end if;

  select layer into v_target_layer from profiles where user_id = p_target_user_id;
  if v_target_layer is distinct from 'platform' then
    raise exception 'that account is not a platform team member';
  end if;

  if p_capability = 'team.manage' and p_effect = 'deny'
     and platform_capability_remaining_holders(p_target_user_id, 'team.manage') = 0 then
    raise exception 'this change would leave zero active platform accounts able to manage the team -- at least one must always remain';
  end if;

  insert into platform_capability_grants (user_id, capability, effect, granted_by, note)
  values (p_target_user_id, p_capability, p_effect, auth.uid(), coalesce(p_note, ''))
  on conflict (user_id, capability) do update
    set effect = excluded.effect, granted_by = excluded.granted_by,
        note = excluded.note, updated_at = now()
  returning * into v_grant;

  return jsonb_build_object('ok', true, 'grant', to_jsonb(v_grant));
end;
$function$;

revoke all on function public.set_platform_capability_grant(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.set_platform_capability_grant(uuid, text, text, text) to authenticated;

create or replace function public.revoke_platform_capability_grant(p_target_user_id uuid, p_capability text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_target_layer text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not resolve_platform_capability(auth.uid(), 'team.manage') then
    raise exception 'only a platform team manager may change a teammate''s permissions';
  end if;
  if auth.uid() = p_target_user_id then
    raise exception 'you cannot change your own permissions here';
  end if;

  select layer into v_target_layer from profiles where user_id = p_target_user_id;
  if v_target_layer is distinct from 'platform' then
    raise exception 'that account is not a platform team member';
  end if;

  if p_capability = 'team.manage'
     and platform_capability_remaining_holders(p_target_user_id, 'team.manage') = 0 then
    raise exception 'this change would leave zero active platform accounts able to manage the team -- at least one must always remain';
  end if;

  delete from platform_capability_grants where user_id = p_target_user_id and capability = p_capability;

  return jsonb_build_object('ok', true, 'user_id', p_target_user_id, 'capability', p_capability, 'reverted_to_role_default', true);
end;
$function$;

revoke all on function public.revoke_platform_capability_grant(uuid, text) from public, anon, authenticated;
grant execute on function public.revoke_platform_capability_grant(uuid, text) to authenticated;

-- ============================================================
-- 9. Backfill — preserve real behavior for any EXISTING
-- platform_support/platform_billing account (there are none in
-- production today, both real platform accounts are
-- platform_super_admin, so this is a no-op now) so that if one
-- exists by the time migration 078 cuts existing RPCs over to the
-- narrower role defaults, their access does not silently shrink.
-- Explicit grant rows, not a role change -- they keep exactly what
-- is_platform_admin() has always given every platform account.
-- ============================================================
do $$
declare
  v_user record;
  v_cap text;
  v_all_caps text[] := array[
    'tenants.view', 'tenants.manage', 'tenants.provision',
    'remote_access.use', 'remote_access.audit',
    'team.manage', 'billing.manage', 'support.cross_tenant'
  ];
begin
  for v_user in
    select user_id from profiles
    where layer = 'platform' and role in ('platform_support', 'platform_billing')
  loop
    foreach v_cap in array v_all_caps loop
      insert into platform_capability_grants (user_id, capability, effect, granted_by, note)
      values (v_user.user_id, v_cap, 'grant', null,
              'backfilled at capability-system rollout -- preserves pre-existing all-access behavior; safe to tighten per-person after review')
      on conflict (user_id, capability) do nothing;
    end loop;
  end loop;
end $$;
