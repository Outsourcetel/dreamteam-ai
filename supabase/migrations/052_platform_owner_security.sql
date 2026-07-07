-- Migration 052: Platform-owner security model
-- =====================================================================
-- Founder's own words: "no one else, other than authorized by me as team
-- member, ever has access to this platform... an easy way to remote
-- access those tenants." Three things, all under one theme -- owner-
-- controlled access, nothing implicit:
--
--   1. profiles.is_active enforcement. Confirmed live before this
--      migration: is_active is set by UserManagementPage's toggleStatus
--      but NEVER CHECKED by any RLS policy or RPC -- deactivating a team
--      member did nothing at the database level (the actual enforcement
--      for THIS migration is added client-side in AuthContext.tsx/
--      LoginPage.tsx, since is_active must gate session restore/sign-in,
--      which is app logic, not a query RLS can intercept). What this
--      migration adds at the DB layer is a guarded read-your-own-active-
--      state RPC so the client can always get a fresh, authoritative
--      answer straight from the source of truth rather than trusting a
--      stale cached profile row picked up before deactivation.
--
--   2. platform_invites: an owner-controlled way to grant platform-layer
--      access without ever making platform signup self-serve. Mirrors the
--      tenant_provisioning_requests pattern (migration 050): a request/
--      grant table + guarded SECURITY DEFINER RPCs, zero direct table
--      writes from the client.
--
--   3. platform_access_events: durable audit trail for god-mode / Remote
--      Access sessions (entering another tenant's workspace as the
--      platform owner). This is new -- unlike platform_config_set or the
--      tenant-hierarchy RPCs (migration 050), which record their own
--      state as the durable record with no tenant-scoped audit event,
--      remote tenant access is sensitive enough that the founder
--      explicitly asked for "every god-mode session is audited". Since
--      append_audit_event is strictly tenant-membership-gated (a platform
--      admin viewing tenant X's audit trail could see it, but the ability
--      to WRITE to audit_events under a tenant they don't belong to is
--      exactly the tenant-audit-forgery risk that table's design
--      correctly denies), remote-access events get their own dedicated,
--      platform-scoped, append-only table instead of being forced into
--      audit_events or audit_logs.

-- =====================================================================
-- SECTION 1: is_active -- authoritative read RPC
-- =====================================================================
-- Client-side, AuthContext calls this instead of trusting a cached
-- profile row so a deactivated user is caught immediately, even mid
-- session (the resync-effect tick). SECURITY DEFINER only so it can be
-- called cheaply as "check myself" without needing a profiles SELECT
-- policy change; it only ever returns the CALLER's own is_active/layer/
-- role/tenant_id, never anyone else's.
create or replace function my_account_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_profile profiles;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into v_profile from profiles where user_id = auth.uid();
  if not found then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true,
    'is_active', coalesce(v_profile.is_active, true),
    'role', v_profile.role,
    'layer', v_profile.layer,
    'tenant_id', v_profile.tenant_id
  );
end;
$function$;

revoke all on function my_account_status() from public, anon, authenticated;
grant execute on function my_account_status() to authenticated;

-- =====================================================================
-- SECTION 2: platform_invites -- owner-controlled team invitations
-- =====================================================================
create table if not exists platform_invites (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  role         text not null check (role in ('platform_support', 'platform_billing', 'platform_super_admin')),
  status       text not null default 'pending' check (status in ('pending', 'redeemed', 'revoked')),
  invite_code  text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by   uuid references profiles(user_id),
  created_at   timestamptz not null default now(),
  redeemed_at  timestamptz,
  redeemed_by  uuid references profiles(user_id)
);

create index if not exists idx_platform_invites_status on platform_invites(status);
create index if not exists idx_platform_invites_email on platform_invites(lower(email));

comment on table platform_invites is
  'Owner-controlled grants of platform-layer access. The ONLY way to become a platform-layer account other than a direct database write. invite_code is a bearer credential for platform access -- treated with the same care as everything else security-critical in this project (unguessable random token, single-use, revocable, no anon/PUBLIC access to the table or the RPCs below).';

alter table platform_invites enable row level security;
alter table platform_invites force row level security;

-- No direct client access to the table at all -- not even SELECT. A
-- pending invite's code is a bearer credential; exposing the row (even
-- read-only) to arbitrary authenticated users would leak invite_code to
-- anyone who queries the table. All reads/writes go through the guarded
-- RPCs below, which return only what the caller is entitled to see
-- (the platform admin sees the full list incl. codes; a redeemer never
-- sees the table directly at all -- they submit a code they already
-- have and get back a success/failure result, never a code listing).
drop policy if exists platform_invites_deny_all on platform_invites;
create policy platform_invites_deny_all on platform_invites
  for all using (false) with check (false);
revoke all on table platform_invites from anon, authenticated;

-- ---------------------------------------------------------------
-- invite_platform_team_member: platform-admin only. Creates the invite
-- and returns its code so the owner can copy/share it directly -- email
-- delivery is not depended on here (Resend domain verification pending
-- as of this migration; see final report). Explicit is_platform_admin()
-- check, no bare-parameter trust.
-- ---------------------------------------------------------------
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
  if not is_platform_admin() then
    raise exception 'only a platform admin may invite a platform team member';
  end if;

  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'a valid email address is required';
  end if;

  if p_role not in ('platform_support', 'platform_billing', 'platform_super_admin') then
    raise exception 'unrecognized platform role: %', p_role;
  end if;

  -- Revoke any still-pending invite for the same email first -- only one
  -- live invite per email at a time, avoids confusion over which code is
  -- the "real" one.
  update platform_invites
  set status = 'revoked'
  where lower(email) = v_email and status = 'pending';

  insert into platform_invites (email, role, invited_by)
  values (v_email, p_role, auth.uid())
  returning * into v_invite;

  -- Platform-only action: no tenant to audit under (append_audit_event
  -- requires tenant membership, and this action has none). The invite
  -- row itself -- invited_by/created_at/status transitions -- is the
  -- durable record, same precedent as platform_config_set (migration
  -- 038) and the tenant-hierarchy platform-admin actions (migration 050).
  return jsonb_build_object(
    'ok', true,
    'invite_id', v_invite.id,
    'invite_code', v_invite.invite_code,
    'email', v_invite.email,
    'role', v_invite.role
  );
end;
$function$;

revoke all on function invite_platform_team_member(text, text) from public, anon, authenticated;
grant execute on function invite_platform_team_member(text, text) to authenticated;

-- ---------------------------------------------------------------
-- list_platform_invites: platform-admin only. Returns the full list
-- (including codes for still-pending ones, so the owner can copy/share)
-- so the Platform Console can render a pending/redeemed/revoked list.
-- ---------------------------------------------------------------
create or replace function list_platform_invites()
returns setof platform_invites
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not is_platform_admin() then
    raise exception 'only a platform admin may view platform invites';
  end if;
  return query select * from platform_invites order by created_at desc;
end;
$function$;

revoke all on function list_platform_invites() from public, anon, authenticated;
grant execute on function list_platform_invites() to authenticated;

-- ---------------------------------------------------------------
-- revoke_platform_invite: platform-admin only. Kills an unused invite
-- link before redemption.
-- ---------------------------------------------------------------
create or replace function revoke_platform_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_invite platform_invites;
begin
  if not is_platform_admin() then
    raise exception 'only a platform admin may revoke a platform invite';
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

revoke all on function revoke_platform_invite(uuid) from public, anon, authenticated;
grant execute on function revoke_platform_invite(uuid) to authenticated;

-- ---------------------------------------------------------------
-- redeem_platform_invite: callable by any authenticated user (they must
-- already have a real Supabase auth account/profile -- if they don't
-- have one yet, they sign up normally via the existing tenant signup
-- flow first, confirm their email, then redeem; this RPC does not create
-- accounts, it only promotes an EXISTING profile row to platform layer).
-- Airtight by design: explicit status check, single-use (status flips to
-- 'redeemed' in the same statement that reads it, guarded by FOR UPDATE
-- to close the race window), no anon/PUBLIC grant.
-- ---------------------------------------------------------------
create or replace function redeem_platform_invite(p_invite_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_code text := btrim(coalesce(p_invite_code, ''));
  v_invite platform_invites;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  if v_code = '' then
    raise exception 'an invite code is required';
  end if;

  select * into v_invite from platform_invites where invite_code = v_code for update;
  if not found then
    raise exception 'invite code not recognized';
  end if;

  if v_invite.status = 'redeemed' then
    raise exception 'this invite has already been redeemed';
  end if;
  if v_invite.status = 'revoked' then
    raise exception 'this invite has been revoked';
  end if;

  if not exists (select 1 from profiles where user_id = v_user) then
    raise exception 'no profile found for this account -- sign up normally first, confirm your email, then redeem this invite';
  end if;

  update profiles
  set layer = 'platform', role = v_invite.role, tenant_id = null, updated_at = now()
  where user_id = v_user;

  update platform_invites
  set status = 'redeemed', redeemed_at = now(), redeemed_by = v_user
  where id = v_invite.id;

  return jsonb_build_object('ok', true, 'role', v_invite.role, 'layer', 'platform');
end;
$function$;

revoke all on function redeem_platform_invite(text) from public, anon, authenticated;
grant execute on function redeem_platform_invite(text) to authenticated;

-- =====================================================================
-- SECTION 3: platform_access_events -- durable audit for Remote Access
-- (god-mode) sessions. Every session start/end is recorded here,
-- platform-admin-readable only.
-- =====================================================================
create table if not exists platform_access_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  operator_user_id uuid references profiles(user_id),
  operator_name   text,
  event           text not null check (event in ('start', 'end')),
  session_key     uuid not null,
  created_at      timestamptz not null default now(),
  detail          jsonb not null default '{}'::jsonb
);

create index if not exists idx_platform_access_events_tenant on platform_access_events(tenant_id);
create index if not exists idx_platform_access_events_session on platform_access_events(session_key);

comment on table platform_access_events is
  'Durable, append-only record of every Remote Access ("god-mode") session a platform admin starts against a tenant workspace. session_key ties a start/end pair together. Platform-admin readable only -- a tenant does not get direct table access here (they see the ordinary tenant-scoped audit_events entries the operator''s actions generate while in their workspace, same as any other actor).';

alter table platform_access_events enable row level security;
alter table platform_access_events force row level security;

drop policy if exists platform_access_events_select on platform_access_events;
create policy platform_access_events_select on platform_access_events
  for select using (is_platform_admin());
revoke all on table platform_access_events from anon, authenticated;
grant select on table platform_access_events to authenticated;
-- (select grant is harmless on its own -- the RLS policy above is the
-- real gate; a non-platform authenticated caller gets zero rows.)

-- ---------------------------------------------------------------
-- start_platform_remote_access: platform-admin only. Call when entering
-- a tenant workspace. Returns a session_key the client holds for the
-- duration of the session and passes back to end_platform_remote_access.
-- ---------------------------------------------------------------
create or replace function start_platform_remote_access(p_tenant_id uuid)
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
  if not is_platform_admin() then
    raise exception 'only a platform admin may start a remote access session';
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

revoke all on function start_platform_remote_access(uuid) from public, anon, authenticated;
grant execute on function start_platform_remote_access(uuid) to authenticated;

-- ---------------------------------------------------------------
-- end_platform_remote_access: platform-admin only. Call on exit (button
-- click, or ideally also on tab-close/timeout in a future iteration).
-- ---------------------------------------------------------------
create or replace function end_platform_remote_access(p_session_key uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_start platform_access_events;
begin
  if not is_platform_admin() then
    raise exception 'only a platform admin may end a remote access session';
  end if;

  select * into v_start from platform_access_events
  where session_key = p_session_key and event = 'start'
  order by created_at desc limit 1;

  if not found then
    raise exception 'no matching remote access session found to end';
  end if;

  insert into platform_access_events (tenant_id, operator_user_id, operator_name, event, session_key, detail)
  values (v_start.tenant_id, auth.uid(), v_start.operator_name, 'end', p_session_key,
    jsonb_build_object('duration_seconds', extract(epoch from (now() - v_start.created_at))));

  return jsonb_build_object('ok', true, 'session_key', p_session_key);
end;
$function$;

revoke all on function end_platform_remote_access(uuid) from public, anon, authenticated;
grant execute on function end_platform_remote_access(uuid) to authenticated;

-- =====================================================================
-- Grant-check evidence (paste actual results in the final report): every
-- new SECURITY DEFINER function above must show zero rows for
-- anon/PUBLIC grantees.
--   select routine_name, grantee from information_schema.routine_privileges
--   where grantee in ('anon','PUBLIC')
--   and routine_name in (
--     'my_account_status','invite_platform_team_member','list_platform_invites',
--     'revoke_platform_invite','redeem_platform_invite',
--     'start_platform_remote_access','end_platform_remote_access'
--   );
-- =====================================================================
