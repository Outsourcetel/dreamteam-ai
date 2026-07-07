-- Remote Access currently only renders the banner and audit trail: the
-- platform owner's own auth_tenant_id() stays NULL while remote-accessing
-- a tenant (platform accounts have no tenant_id by design), so every one of
-- the 52 RLS policies built on auth_tenant_id() = tenant_id silently denies
-- them the tenant's real rows, and every Live*.tsx page falls back to demo
-- data instead. auth_tenant_id() is the single choke point those policies
-- share, so extending it here (rather than touching 52 policies individually)
-- makes Remote Access see real tenant data everywhere at once, consistently,
-- the moment a session is active — and lose it the moment the session ends.
--
-- The fallback only ever fires for an account whose own profile has no
-- tenant_id (structurally: platform-layer accounts), and only matches a
-- platform_access_events row that start_platform_remote_access itself wrote
-- after checking is_platform_admin() — so this cannot be reached by a
-- regular tenant user. Bounded to the last 12 hours as defense-in-depth
-- against a session nobody ever explicitly ended.
create or replace function public.auth_tenant_id()
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(
    (select tenant_id from public.profiles where user_id = auth.uid() limit 1),
    (
      select e.tenant_id
      from public.platform_access_events e
      where e.operator_user_id = auth.uid()
        and e.event = 'start'
        and e.created_at > now() - interval '12 hours'
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
