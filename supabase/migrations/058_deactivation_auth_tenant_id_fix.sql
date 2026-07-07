-- Migration 058: is_active was never enforced for ordinary tenant users at
-- the RLS layer -- confirmed live: a deactivated account's still-valid JWT
-- could read AND write real tenant data through any RLS policy that never
-- checks the flag (which is all of them; zero policies reference is_active
-- today). Migration 056 closed this for the platform-admin tier only, by
-- folding the check into is_platform_admin() -- the one function that
-- tier's checks already funneled through.
--
-- auth_tenant_id() is the equivalent shared choke-point for ordinary tenant
-- users: the vast majority of tenant-scoped RLS policies resolve access via
-- `tenant_id = auth_tenant_id()`. Folding the is_active check in here closes
-- the gap for all of them at once, the same way is_platform_admin() did for
-- the platform tier.
--
-- Both COALESCE branches get the check:
--   - The ordinary-user branch: a deactivated user's own tenant_id now
--     resolves to NULL instead of their real tenant, so they match no rows
--     on `tenant_id = auth_tenant_id()` anywhere.
--   - The remote-access-session branch: without this, a platform admin
--     deactivated *while* a session is still open (rather than before
--     starting one, which migration 056 already blocks) would keep access
--     until the 12-hour window lapses. Added defense-in-depth so
--     deactivation takes effect immediately even mid-session.
--
-- A small number of RPCs check tenant/role membership via their own direct
-- `select ... from profiles where user_id = auth.uid()` instead of calling
-- this function -- those are NOT fixed by this migration and are being
-- swept separately, function by function, with live verification for each.
-- =====================================================================

create or replace function public.auth_tenant_id()
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(
    (
      select tenant_id from public.profiles
      where user_id = auth.uid() and coalesce(is_active, true) = true
      limit 1
    ),
    (
      select e.tenant_id
      from public.platform_access_events e
      where e.operator_user_id = auth.uid()
        and e.event = 'start'
        and e.created_at > now() - interval '12 hours'
        and exists (
          select 1 from public.profiles p
          where p.user_id = auth.uid() and coalesce(p.is_active, true) = true
        )
        and e.id = (
          select e2.id
          from public.platform_access_events e2
          where e2.operator_user_id = auth.uid()
          order by e2.created_at desc
          limit 1
        )
      limit 1
    )
  );
$function$;
