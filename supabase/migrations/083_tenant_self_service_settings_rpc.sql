-- ============================================================
-- Migration 083: fixes two more instances of the same silently-broken
-- write pattern already fixed twice on the platform-console side
-- (081, 082) -- this time on the CUSTOMER-FACING side, found by an
-- audit dispatched specifically because the founder asked for every
-- control touching `tenants` to be confirmed genuinely wired before
-- going live with paying customers.
--
-- `updateTenant` and `updateTenantBudget` (src/lib/api.ts) do direct
-- client `.update()` calls against `tenants`, which carries exactly
-- one RLS policy (tn_sel, SELECT only -- confirmed live via pg_policy,
-- same check run for 081/082). Both are called from the tenant-facing
-- Settings page (src/pages/tenant/SettingsPage.tsx): "General" (org
-- name/industry/brand color) and "Usage & Budgets" (monthly token
-- budget). A paying tenant editing either would see a "Saved" status
-- while nothing was ever written -- the exact landmine already found
-- and fixed on the admin side.
--
-- Unlike 081/082 (platform-console-only, gated on a platform
-- capability), these are genuinely tenant self-service: the caller is
-- editing THEIR OWN tenant. Gated on tenant_owner/tenant_admin of that
-- tenant (mirrors connectors_tenant_write's role gate, migration 064)
-- OR a platform account with tenants.manage, mirroring the dual-path
-- shape request_subtenant already established (self-serve when
-- entitled, platform-admin override otherwise). SettingsPage.tsx today
-- has zero client-side role gating on the Save button -- this RPC is
-- the actual authorization boundary; a non-owner/admin now gets a
-- clear rejection instead of a silent no-op, which is strictly better
-- even before any frontend polish.
-- ============================================================
create or replace function public.update_tenant_general_settings(
  p_tenant_id uuid,
  p_name text,
  p_industry text,
  p_accent_color text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_caller_tenant uuid;
  v_role text;
  v_is_active boolean;
  v_is_platform boolean := resolve_platform_capability(auth.uid(), 'tenants.manage');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_tenant_id = v_demo_tenant_id then
    raise exception 'the demo tenant''s settings cannot be changed';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'organization name is required';
  end if;

  if not v_is_platform then
    select tenant_id, role, coalesce(is_active, true) into v_caller_tenant, v_role, v_is_active
    from profiles where user_id = auth.uid();

    if v_caller_tenant is distinct from p_tenant_id or v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only an owner or admin of this organization may change these settings';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
  end if;

  update tenants
  set name = btrim(p_name), industry = nullif(btrim(coalesce(p_industry, '')), ''),
      accent_color = p_accent_color, updated_at = now()
  where id = p_tenant_id;

  return jsonb_build_object('ok', true, 'tenant_id', p_tenant_id);
end;
$function$;

revoke all on function public.update_tenant_general_settings(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.update_tenant_general_settings(uuid, text, text, text) to authenticated;

create or replace function public.set_tenant_monthly_budget(p_tenant_id uuid, p_budget integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_caller_tenant uuid;
  v_role text;
  v_is_active boolean;
  v_is_platform boolean := resolve_platform_capability(auth.uid(), 'tenants.manage');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_tenant_id = v_demo_tenant_id then
    raise exception 'the demo tenant''s budget cannot be changed';
  end if;
  if p_budget is null or p_budget < 0 then
    raise exception 'budget must be a non-negative number';
  end if;

  if not v_is_platform then
    select tenant_id, role, coalesce(is_active, true) into v_caller_tenant, v_role, v_is_active
    from profiles where user_id = auth.uid();

    if v_caller_tenant is distinct from p_tenant_id or v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only an owner or admin of this organization may change the token budget';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
  end if;

  update tenants set monthly_token_budget = p_budget, updated_at = now() where id = p_tenant_id;

  return jsonb_build_object('ok', true, 'tenant_id', p_tenant_id, 'monthly_token_budget', p_budget);
end;
$function$;

revoke all on function public.set_tenant_monthly_budget(uuid, integer) from public, anon, authenticated;
grant execute on function public.set_tenant_monthly_budget(uuid, integer) to authenticated;
