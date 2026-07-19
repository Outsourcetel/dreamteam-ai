-- ═══════════════════════════════════════════════════════════════
-- 191 — Playbook 3.0 Wave 8: a P&L per procedure
--
-- Every playbook can now report its business ledger from REAL data:
-- runs/completions from playbook_runs, AI cost from the agentic step
-- ledger (cost_used_cents), and human-work value from the tenant's own
-- workforce baselines (action_minutes × the hourly rate implied by
-- avg_fte_cost_monthly_usd). No baseline configured → minutes only,
-- honestly null dollars. Tenant-scoped via the caller's membership.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.get_playbook_economics(p_definition_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_tenant uuid; v_runs int; v_completed int; v_failed int;
  v_cost numeric; v_minutes numeric; v_value numeric;
  v_bl workforce_baselines;
begin
  select tenant_id into v_tenant from playbook_definitions where id = p_definition_id;
  if v_tenant is null then return jsonb_build_object('error', 'not_found'); end if;
  if auth.uid() is not null and not exists (
    select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;

  select count(*), count(*) filter (where status = 'completed'), count(*) filter (where status = 'failed')
    into v_runs, v_completed, v_failed
  from playbook_runs where definition_id = p_definition_id;

  select coalesce(sum(a.cost_used_cents), 0) into v_cost
  from agentic_step_runs a
  join playbook_runs r on r.id = a.playbook_run_id
  where r.definition_id = p_definition_id;

  select * into v_bl from workforce_baselines where tenant_id = v_tenant;
  v_minutes := v_completed * coalesce(v_bl.action_minutes, 15);
  -- hourly rate implied by the tenant's own monthly FTE cost (160 h/month)
  v_value := case when v_bl.avg_fte_cost_monthly_usd is not null and v_bl.avg_fte_cost_monthly_usd > 0
    then round((v_minutes / 60.0) * (v_bl.avg_fte_cost_monthly_usd / 160.0), 2) else null end;

  return jsonb_build_object(
    'runs', v_runs, 'completed', v_completed, 'failed', v_failed,
    'completion_pct', case when v_runs > 0 then round(100.0 * v_completed / v_runs, 1) else null end,
    'ai_cost_cents', round(v_cost, 1),
    'human_minutes_saved', round(v_minutes, 0),
    'est_value_usd', v_value,
    'baseline_configured', v_bl.tenant_id is not null
  );
end; $function$;
revoke all on function public.get_playbook_economics(uuid) from public, anon;
grant execute on function public.get_playbook_economics(uuid) to authenticated, service_role;
