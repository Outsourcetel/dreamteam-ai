-- ============================================================
-- Migration 100: real AI usage budget enforcement. Closes the
-- go-live readiness finding: tenants.monthly_token_budget (and the
-- 10M self-serve ceiling from migration 084) bounds what a tenant can
-- SET, but nothing anywhere ever reads it before spending real AI
-- provider cost. Confirmed via direct research: token counts are only
-- recorded in de_token_usage (094, this session) — the older
-- tenant_ai_usage table (007) is completely unwritten, and
-- usage_metrics (013) tracks call counts, not tokens. Neither of
-- those two is suitable for a budget check; de_token_usage is.
--
-- Period definition: calendar-month-to-date, matching the existing
-- "Monthly Tokens" UI convention in src/lib/usageApi.ts
-- (date_trunc('month', now()) forward) — not inventing a new period.
-- ============================================================

create or replace function public.get_tenant_token_usage_this_month(p_tenant_id uuid)
returns bigint
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(sum(input_tokens + output_tokens), 0)
  from de_token_usage
  where tenant_id = p_tenant_id
    and created_at >= date_trunc('month', now());
$function$;

revoke all on function public.get_tenant_token_usage_this_month(uuid) from public, anon, authenticated;
grant execute on function public.get_tenant_token_usage_this_month(uuid) to service_role;

-- check_tenant_ai_budget — the actual enforcement gate. Called by
-- every edge function right before it spends real AI-provider cost.
-- A null/zero monthly_token_budget is treated as "not yet configured"
-- and fails open (allowed) rather than silently blocking every tenant
-- that predates this column being populated — same fail-open posture
-- this codebase already uses for other best-effort gates (e.g.
-- is_feature_enabled_internal's unknown-key case).
create or replace function public.check_tenant_ai_budget(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_budget integer;
  v_used   bigint;
begin
  select monthly_token_budget into v_budget from tenants where id = p_tenant_id;
  if v_budget is null or v_budget <= 0 then
    return jsonb_build_object('allowed', true, 'used', 0, 'budget', v_budget);
  end if;

  v_used := get_tenant_token_usage_this_month(p_tenant_id);

  return jsonb_build_object('allowed', v_used < v_budget, 'used', v_used, 'budget', v_budget);
end;
$function$;

revoke all on function public.check_tenant_ai_budget(uuid) from public, anon, authenticated;
grant execute on function public.check_tenant_ai_budget(uuid) to service_role;

-- spec_consultations.status gains 'blocked_budget' — same "dormant-
-- honest" pattern this table already uses for 'blocked_llm' (no API
-- key), now for the enforcement case above (over budget).
alter table spec_consultations drop constraint if exists spec_consultations_status_check;
alter table spec_consultations add constraint spec_consultations_status_check
  check (status in ('answered', 'blocked_llm', 'blocked_budget', 'escalated', 'error'));
