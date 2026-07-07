-- Migration 061: gap 4 from the 2026-07-07 adversarial pass -- "no second
-- factor on the platform owner's own account." Remote Access is the
-- single highest-privilege action on the platform (full read, and on most
-- tables write, access into any tenant's real data) -- this requires a
-- verified two-factor code for that action specifically, rather than
-- gating every ordinary sign-in.
--
-- PROGRESSIVE enforcement, deliberately: this only requires AAL2 (a
-- verified MFA factor this session) once the calling account actually has
-- at least one verified TOTP factor enrolled. Nobody had a way to enroll
-- one before this migration shipped (no real enrollment UI existed --
-- confirmed by reading the frontend, the "MFA" shown on the Security &
-- Access page was hardcoded demo data with zero connection to Supabase's
-- real MFA system). Enforcing AAL2 unconditionally today would have
-- locked every platform admin, including the founder, out of Remote
-- Access entirely with no way back in. Once an account enrolls a real
-- factor (via the new enrollment screen shipped alongside this
-- migration), this check activates automatically for that account.
-- =====================================================================

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
  if not is_platform_admin() then
    raise exception 'only a platform admin may start a remote access session';
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
