-- Migration 091: Security & Access page rebuild, part 3 — real session
-- policy. The page's "Session Policy" card (timeout dropdown, MFA-required
-- toggle) wrote to localStorage only -- nothing was ever read by anything
-- else, and "Re-auth for sensitive areas: Always on" was hardcoded
-- (Remote Access does require AAL2, migration 061, but that's platform-
-- side only; there is no equivalent tenant-side enforcement, so this
-- migration doesn't claim one -- the frontend copy is corrected instead).
--
-- Real enforcement built on top of this table:
--   - timeout_minutes: client-side inactivity auto-signout (AuthContext).
--   - mfa_required: blocks a real tenant user from the app until they
--     enroll a verified TOTP factor, reusing the same supabase.auth.mfa.*
--     system migration 061/MfaEnrollmentPanel already wired up.
-- Both are honest, real behavior -- not a UI mockup with better props.
-- =====================================================================

create table if not exists tenant_session_policies (
  tenant_id      uuid primary key references tenants(id) on delete cascade,
  timeout_minutes integer not null default 480,
  mfa_required   boolean not null default false,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references profiles(user_id)
);

alter table tenant_session_policies enable row level security;

-- No direct client access -- security config, same posture as
-- tenant_api_keys/platform_capability_grants. Every read/write below.
drop policy if exists tenant_session_policies_no_direct_access on tenant_session_policies;
create policy tenant_session_policies_no_direct_access on tenant_session_policies
  for all using (false) with check (false);

-- ── get_tenant_session_policy ──
-- Any member of the tenant (or a platform admin) can read -- every
-- signed-in user needs to know their own tenant's timeout/MFA
-- requirement to have it enforced for themselves. Returns the default
-- row shape (480min, mfa not required) when nothing's been set yet.
create or replace function public.get_tenant_session_policy(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row tenant_session_policies;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s session policy';
  end if;

  select * into v_row from tenant_session_policies where tenant_id = p_tenant_id;
  if v_row.tenant_id is null then
    return jsonb_build_object('timeout_minutes', 480, 'mfa_required', false);
  end if;
  return jsonb_build_object('timeout_minutes', v_row.timeout_minutes, 'mfa_required', v_row.mfa_required);
end;
$function$;

revoke all on function public.get_tenant_session_policy(uuid) from public, anon;
grant execute on function public.get_tenant_session_policy(uuid) to authenticated;

-- ── set_tenant_session_policy ──
create or replace function public.set_tenant_session_policy(p_tenant_id uuid, p_timeout_minutes integer, p_mfa_required boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (
      select 1 from profiles p
      where p.user_id = auth.uid() and p.tenant_id = p_tenant_id
        and coalesce(p.is_active, true) = true
        and p.role in ('tenant_owner', 'tenant_admin')
    )
  ) then
    raise exception 'only workspace owners/admins can change the session policy';
  end if;
  if p_timeout_minutes not in (60, 240, 480, 1440) then
    raise exception 'timeout_minutes must be one of 60, 240, 480, 1440';
  end if;

  insert into tenant_session_policies (tenant_id, timeout_minutes, mfa_required, updated_by)
  values (p_tenant_id, p_timeout_minutes, p_mfa_required, auth.uid())
  on conflict (tenant_id) do update
    set timeout_minutes = excluded.timeout_minutes,
        mfa_required = excluded.mfa_required,
        updated_at = now(),
        updated_by = excluded.updated_by;

  perform append_audit_event_internal(
    p_tenant_id, 'You', 'human',
    format('Session policy updated: %s min timeout, MFA %s', p_timeout_minutes, case when p_mfa_required then 'required' else 'optional' end),
    'config_change',
    jsonb_build_object('kind', 'session_policy_updated', 'timeout_minutes', p_timeout_minutes, 'mfa_required', p_mfa_required)
  );

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.set_tenant_session_policy(uuid, integer, boolean) from public, anon;
grant execute on function public.set_tenant_session_policy(uuid, integer, boolean) to authenticated;
