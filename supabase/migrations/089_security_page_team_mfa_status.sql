-- Migration 089: Security & Access page rebuild, part 1 — real team MFA
-- status. The page's "Human Users" table has always shown a hardcoded
-- HUMAN_USERS mock list with a fake per-row "MFA: Enabled/Missing" badge,
-- with zero connection to Supabase's real MFA system. Real two-factor
-- enrollment already exists (supabase.auth.mfa.*, auth.mfa_factors,
-- migration 061's MfaEnrollmentPanel) but that panel only ever shows a
-- user their OWN status — there was no way for a workspace owner/admin to
-- see the team's real MFA posture. This is the missing piece: a
-- SECURITY DEFINER read of auth.mfa_factors across the caller's own team,
-- gated identically to the other team-management RPCs (migration 065).
--
-- Both RPCs below take an explicit p_tenant_id rather than deriving the
-- tenant purely from the caller's own profile: found live, during this
-- same build, that a platform admin viewing a tenant through Remote
-- Access has no profiles row in that tenant at all (platform accounts
-- have no tenant membership by design), so an auth.uid()-only lookup can
-- never resolve anything for them. is_platform_admin() is the bypass,
-- matching platform_connector_health_summary()'s (migration 081) already-
-- established shape for "platform admin can read across any tenant."
-- =====================================================================

drop function if exists public.list_team_mfa_status();

create or replace function public.list_team_mfa_status(p_tenant_id uuid)
returns table(user_id uuid, mfa_verified boolean)
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
    raise exception 'only workspace owners/admins can view team MFA status';
  end if;

  return query
    select p.user_id,
      exists(
        select 1 from auth.mfa_factors f
        where f.user_id = p.user_id and f.status = 'verified'
      ) as mfa_verified
    from profiles p
    where p.tenant_id = p_tenant_id;
end;
$function$;

revoke all on function public.list_team_mfa_status(uuid) from public, anon;
grant execute on function public.list_team_mfa_status(uuid) to authenticated;

-- ── list_team_members_full ──
-- Found while building this: profiles has NO email column at all (real
-- schema check, not the assumption `useUsers.ts` was written under) --
-- every `row.email` read there has always evaluated to '', silently
-- breaking email display, search-by-email, AND the "reset password" admin
-- action (sendPasswordReset('') on an empty string) on the one existing
-- consumer, UserManagementPage.tsx. Real email lives on auth.users.
-- Matches the existing (surprisingly permissive) "Tenant admins view
-- tenant profiles" RLS policy, whose actual qual is just tenant
-- membership with no role check -- so the non-platform-admin branch here
-- is membership-gated only, not owner/admin-restricted, to avoid
-- narrowing who can see the roster versus today's real behavior.
drop function if exists public.list_team_members_full();

create or replace function public.list_team_members_full(p_tenant_id uuid)
returns table(
  user_id uuid, full_name text, email text, role text, department text,
  is_active boolean, last_seen_at timestamptz, created_at timestamptz, invited_by text
)
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
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s team';
  end if;

  return query
    select p.user_id, p.full_name, u.email::text, p.role, p.department,
      coalesce(p.is_active, true), p.last_seen_at, p.created_at, p.invited_by
    from profiles p
    join auth.users u on u.id = p.user_id
    where p.tenant_id = p_tenant_id;
end;
$function$;

revoke all on function public.list_team_members_full(uuid) from public, anon;
grant execute on function public.list_team_members_full(uuid) to authenticated;
