-- ============================================================
-- Migration 081: set_tenant_status — closes the dead "Suspend" button
-- on the platform console's Tenant Management page, found during the
-- "clean the platform console of dummy data" pass (2026-07-08). The
-- button had no handler at all; nothing to fix at the frontend layer
-- until a real backend path existed.
--
-- Not a direct client `.update()` on tenants: that table has no
-- UPDATE RLS policy for this column (setTenantSelfServe, added in the
-- platform-permissions build, already carries this same silent-no-op
-- risk — documented, not yet fixed, in project memory). A guarded
-- SECURITY DEFINER RPC is the correct shape, matching every other
-- platform write path in this codebase.
--
-- Gated on tenants.manage (the same capability that already covers
-- approve/reject/feature-flag actions on a tenant) rather than a new
-- capability -- suspending is squarely "manage this tenant," not a
-- separate concern.
-- ============================================================
create or replace function public.set_tenant_status(p_tenant_id uuid, p_status text)
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
    raise exception 'only a platform team member with tenant-management access may change a tenant''s status';
  end if;
  if p_status not in ('active', 'trial', 'suspended') then
    raise exception 'unrecognized tenant status: %', p_status;
  end if;
  if p_tenant_id = v_demo_tenant_id then
    raise exception 'the demo tenant''s status cannot be changed';
  end if;

  select true into v_found from tenants where id = p_tenant_id;
  if not found then
    raise exception 'tenant not found';
  end if;

  update tenants set status = p_status, updated_at = now() where id = p_tenant_id;

  return jsonb_build_object('ok', true, 'tenant_id', p_tenant_id, 'status', p_status);
end;
$function$;

revoke all on function public.set_tenant_status(uuid, text) from public, anon, authenticated;
grant execute on function public.set_tenant_status(uuid, text) to authenticated;

-- ============================================================
-- platform_connector_health_summary — same cleanup pass. The old
-- platform_health page was 100% hardcoded fake uptime/latency/incident
-- numbers for six "services," none of which are actually monitored.
-- The one real, already-tracked signal in this codebase is connector
-- health (connectors.status/last_ok_at/last_error_at/
-- consecutive_failures, migration 027) -- but connectors' RLS is
-- strictly tenant-scoped (auth_tenant_id(), migration 064), so a
-- platform account (no tenant membership) sees zero rows through the
-- ordinary client query. This is the platform-wide read, gated on
-- tenants.view like every other cross-tenant visibility RPC.
-- ============================================================
create or replace function public.platform_connector_health_summary()
returns table(
  tenant_id uuid,
  tenant_name text,
  connector_id uuid,
  display_name text,
  provider text,
  status text,
  last_ok_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  consecutive_failures integer
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not resolve_platform_capability(auth.uid(), 'tenants.view') then
    raise exception 'only a platform team member with tenant visibility may view connector health';
  end if;

  return query
  select c.tenant_id, t.name, c.id, c.display_name, c.provider, c.status,
         c.last_ok_at, c.last_error_at, c.last_error, c.consecutive_failures
  from connectors c
  join tenants t on t.id = c.tenant_id
  order by c.consecutive_failures desc, c.status, t.name;
end;
$function$;

revoke all on function public.platform_connector_health_summary() from public, anon, authenticated;
grant execute on function public.platform_connector_health_summary() to authenticated;
