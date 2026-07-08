-- ============================================================
-- Migration 084: cap set_tenant_monthly_budget — found during a
-- pre-launch readiness review (2026-07-08), reported by a business-
-- analyst audit agent as a real, currently-live gap: the RPC shipped
-- in migration 083 checked p_budget >= 0 but had NO UPPER BOUND. Any
-- tenant_owner/tenant_admin could self-serve raise their own monthly
-- token budget to an arbitrary value through the product's own
-- Settings UI (src/pages/tenant/SettingsPage.tsx, Usage & Budgets
-- tab) — with zero billing/plan enforcement anywhere in this
-- codebase (confirmed separately in the same review), that budget is
-- a direct, self-service path to unbounded real AI-provider cost
-- exposure (Anthropic/OpenAI/Google API spend) with no revenue behind
-- it whatsoever.
--
-- This is a stopgap guardrail, not the real fix -- the real fix is
-- billing/plan-based enforcement, which doesn't exist yet and is a
-- business decision, not a migration. A flat ceiling (100x the
-- default 100,000/month budget, i.e. generous enough that no
-- legitimate customer hits it by accident) closes the "can run this
-- up to a billion tokens with one API call" version of the problem
-- today, cheaply, while the real fix is designed.
-- ============================================================
create or replace function public.set_tenant_monthly_budget(p_tenant_id uuid, p_budget integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_max_self_serve_budget constant integer := 10000000; -- 100x the 100k default; revisit once real plan-based billing exists
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

    -- Self-serve (non-platform-admin) callers are capped. A platform
    -- admin (tenants.manage) can still set a higher budget by hand for
    -- a legitimate enterprise customer who genuinely needs more.
    if p_budget > v_max_self_serve_budget then
      raise exception 'requested budget exceeds the self-serve limit (%); contact DreamTeam AI to raise it', v_max_self_serve_budget;
    end if;
  end if;

  update tenants set monthly_token_budget = p_budget, updated_at = now() where id = p_tenant_id;

  return jsonb_build_object('ok', true, 'tenant_id', p_tenant_id, 'monthly_token_budget', p_budget);
end;
$function$;

revoke all on function public.set_tenant_monthly_budget(uuid, integer) from public, anon, authenticated;
grant execute on function public.set_tenant_monthly_budget(uuid, integer) to authenticated;
