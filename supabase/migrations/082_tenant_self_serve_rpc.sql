-- ============================================================
-- Migration 082: set_tenant_self_serve — fixes a real, silently-broken
-- write path, not a dummy-data issue but the same class of bug found
-- during the "clean the platform console" pass (081) and flagged then,
-- not fixed. Closing it now because the founder asked for every
-- control on this page to be genuinely wired before going live.
--
-- setTenantSelfServe (src/lib/api.ts) does a direct client `.update()`
-- on `tenants.allow_self_serve_subtenants`. `tenants` carries exactly
-- one RLS policy (tn_sel, SELECT only, confirmed live via pg_policy)
-- -- there has never been an UPDATE policy on this table. Supabase
-- does not surface an error when RLS silently matches zero rows for
-- an UPDATE; the client call returns success with an empty result,
-- so `setTenantSelfServe` returned `true` and the toggle visually
-- flipped in the UI while nothing was ever written. Same shape, same
-- fix, as set_tenant_status (081): a guarded SECURITY DEFINER RPC.
-- ============================================================
create or replace function public.set_tenant_self_serve(p_tenant_id uuid, p_allow boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_found boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
    raise exception 'only a platform team member with tenant-management access may change this setting';
  end if;
  if p_tenant_id = v_demo_tenant_id then
    raise exception 'the demo tenant''s settings cannot be changed';
  end if;

  select true into v_found from tenants where id = p_tenant_id;
  if not found then
    raise exception 'tenant not found';
  end if;

  update tenants set allow_self_serve_subtenants = p_allow, updated_at = now() where id = p_tenant_id;

  return jsonb_build_object('ok', true, 'tenant_id', p_tenant_id, 'allow_self_serve_subtenants', p_allow);
end;
$function$;

revoke all on function public.set_tenant_self_serve(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_tenant_self_serve(uuid, boolean) to authenticated;
