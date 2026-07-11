-- DE-C5: Workforce Economics (constitution §12) — the final task of
-- the Human-as-DE program.
--
-- §12.3 writes this codebase's own doctrine into the constitution:
-- "avg_human_task_time_minutes ... is configured by the Organisation,
-- not invented by the platform" and "Organisations that have not
-- configured [it] see a 'configure to calculate' prompt rather than a
-- platform-generated estimate." This migration implements exactly
-- that: FTE Equivalent and ROI exist ONLY downstream of baselines the
-- tenant types in. Nothing here ever estimates a human's time or cost.
--
-- Formulas (verbatim from §12.3–12.4):
--   fte_equivalent = (tasks × avg_human_task_time_minutes)
--                    / standard_working_minutes_per_period
--                    (9,600 min/month, prorated to the window)
--   roi = ((fte_equivalent × avg_human_fte_cost) − de_cost) / de_cost
--
-- Task types = the three units of work this platform REALLY counts:
--   inquiry_handled       → evidence-run decisions (inbox triage)
--   action_executed       → executed registry actions
--   conversation_answered → widget/chat conversations
-- Each has its own minutes baseline (§12.3 "each Capability type
-- should have its own"); an unconfigured type is EXCLUDED from the
-- math and named in the output — partial honesty beats silent
-- inclusion. avg_fte_cost is defined as MONTHLY fully-loaded cost
-- (the §12.4 formula needs a period cost; the column name says so).
--
-- NOT built: per-DE AI budgets (§12.5 — tenant-level budget
-- enforcement is already real, migration 100; per-DE allocation has
-- no UI/demand yet) and the §12.6 executive report suite (the
-- economics function is the data layer it would read from).

-- ────────────────────────────────────────────────────────────────
-- 1. The tenant-configured baselines — one row per tenant, every
--    field nullable (null = unconfigured, never defaulted).
-- ────────────────────────────────────────────────────────────────
create table if not exists workforce_baselines (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  avg_fte_cost_monthly_usd numeric check (avg_fte_cost_monthly_usd is null or avg_fte_cost_monthly_usd > 0),
  inquiry_minutes numeric check (inquiry_minutes is null or inquiry_minutes > 0),
  action_minutes numeric check (action_minutes is null or action_minutes > 0),
  conversation_minutes numeric check (conversation_minutes is null or conversation_minutes > 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

alter table workforce_baselines enable row level security;
drop policy if exists workforce_baselines_tenant_select on workforce_baselines;
create policy workforce_baselines_tenant_select on workforce_baselines
  for select to authenticated using (tenant_id = auth_tenant_id());

create or replace function set_workforce_baselines(
  p_avg_fte_cost_monthly_usd numeric default null,
  p_inquiry_minutes numeric default null,
  p_action_minutes numeric default null,
  p_conversation_minutes numeric default null
)
returns workforce_baselines
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_row workforce_baselines;
  v_actor text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can set workforce baselines';
  end if;
  if p_avg_fte_cost_monthly_usd is not null and p_avg_fte_cost_monthly_usd <= 0 then raise exception 'FTE cost must be positive'; end if;
  if p_inquiry_minutes is not null and p_inquiry_minutes <= 0 then raise exception 'minutes must be positive'; end if;
  if p_action_minutes is not null and p_action_minutes <= 0 then raise exception 'minutes must be positive'; end if;
  if p_conversation_minutes is not null and p_conversation_minutes <= 0 then raise exception 'minutes must be positive'; end if;

  insert into workforce_baselines (tenant_id, avg_fte_cost_monthly_usd, inquiry_minutes, action_minutes, conversation_minutes, updated_by)
  values (v_tenant, p_avg_fte_cost_monthly_usd, p_inquiry_minutes, p_action_minutes, p_conversation_minutes, auth.uid())
  on conflict (tenant_id) do update set
    avg_fte_cost_monthly_usd = excluded.avg_fte_cost_monthly_usd,
    inquiry_minutes = excluded.inquiry_minutes,
    action_minutes = excluded.action_minutes,
    conversation_minutes = excluded.conversation_minutes,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into v_row;

  select full_name into v_actor from profiles where user_id = auth.uid();
  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('Workforce baselines set — FTE cost %s/mo; minutes per task: inquiry %s, action %s, conversation %s (nulls = unconfigured)',
      coalesce('$' || p_avg_fte_cost_monthly_usd::text, '—'),
      coalesce(p_inquiry_minutes::text, '—'), coalesce(p_action_minutes::text, '—'), coalesce(p_conversation_minutes::text, '—')),
    'config_change',
    jsonb_build_object('kind', 'workforce_baselines_set',
      'avg_fte_cost_monthly_usd', p_avg_fte_cost_monthly_usd, 'inquiry_minutes', p_inquiry_minutes,
      'action_minutes', p_action_minutes, 'conversation_minutes', p_conversation_minutes)
  );
  return v_row;
end;
$$;

revoke all on function set_workforce_baselines(numeric, numeric, numeric, numeric) from public, anon;
grant execute on function set_workforce_baselines(numeric, numeric, numeric, numeric) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 2. The economics computation — real counts × configured baselines,
--    real AI cost, §12 formulas. p_de_id null = whole workforce.
--    Unconfigured pieces come back NULL with the missing baselines
--    named ('configure to calculate', §12.3 verbatim).
-- ────────────────────────────────────────────────────────────────
create or replace function get_de_economics(p_tenant_id uuid, p_de_id uuid default null, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  b workforce_baselines;
  v_inquiries bigint;
  v_actions bigint;
  v_conversations bigint;
  v_de_cost numeric;
  v_human_minutes numeric := 0;
  v_counted boolean := false;
  v_missing text[] := '{}';
  v_fte numeric;
  v_human_cost numeric;
  v_roi numeric;
  v_savings numeric;
  v_std_minutes numeric;
begin
  if p_days < 1 or p_days > 365 then raise exception 'window must be 1-365 days'; end if;
  -- Same trusted-server/human gate as get_de_performance_metrics.
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if not (is_platform_admin()
            or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)) then
      raise exception 'not authorized to view this workspace''s economics';
    end if;
  end if;

  select * into b from workforce_baselines where tenant_id = p_tenant_id;

  -- Real work counts, windowed.
  select count(*) into v_inquiries
  from evidence_run_decisions d join evidence_runs er on er.id = d.evidence_run_id
  where er.tenant_id = p_tenant_id and er.de_id is not null
    and (p_de_id is null or er.de_id = p_de_id)
    and d.created_at > now() - make_interval(days => p_days);

  select count(*) into v_actions
  from action_executions
  where tenant_id = p_tenant_id and subject_kind = 'de' and mode = 'execute'
    and decision in ('auto_executed', 'executed_after_approval')
    and (p_de_id is null or subject_id = p_de_id)
    and created_at > now() - make_interval(days => p_days);

  select count(*) into v_conversations
  from de_conversations
  where tenant_id = p_tenant_id and de_id is not null
    and (p_de_id is null or de_id = p_de_id)
    and created_at > now() - make_interval(days => p_days);

  -- Real AI cost, windowed (same pricing join as get_de_cost_metrics).
  select coalesce(round(sum(
      (u.input_tokens::numeric / 1000000) * coalesce(pr.input_price_per_million, 3.00)
      + (u.output_tokens::numeric / 1000000) * coalesce(pr.output_price_per_million, 15.00)
    ), 4), 0) into v_de_cost
  from de_token_usage u
  left join ai_model_pricing pr on pr.model_id = u.model_id
  where u.tenant_id = p_tenant_id
    and (p_de_id is null or u.de_id = p_de_id)
    and u.created_at > now() - make_interval(days => p_days);

  -- Human-minutes over CONFIGURED task types only.
  if b.inquiry_minutes is not null then
    v_human_minutes := v_human_minutes + v_inquiries * b.inquiry_minutes; v_counted := true;
  elsif v_inquiries > 0 then v_missing := array_append(v_missing, 'inquiry_minutes'); end if;

  if b.action_minutes is not null then
    v_human_minutes := v_human_minutes + v_actions * b.action_minutes; v_counted := true;
  elsif v_actions > 0 then v_missing := array_append(v_missing, 'action_minutes'); end if;

  if b.conversation_minutes is not null then
    v_human_minutes := v_human_minutes + v_conversations * b.conversation_minutes; v_counted := true;
  elsif v_conversations > 0 then v_missing := array_append(v_missing, 'conversation_minutes'); end if;

  -- §12.3: 9,600 standard working minutes per month, prorated.
  v_std_minutes := 9600.0 * p_days / 30.0;
  if v_counted then
    v_fte := round(v_human_minutes / v_std_minutes, 3);
    if b.avg_fte_cost_monthly_usd is not null then
      v_human_cost := round(v_fte * b.avg_fte_cost_monthly_usd * p_days / 30.0, 2);
      v_savings := round(v_human_cost - v_de_cost, 2);
      if v_de_cost > 0 then
        v_roi := round((v_human_cost - v_de_cost) / v_de_cost, 1);
      end if;
    else
      v_missing := array_append(v_missing, 'avg_fte_cost_monthly_usd');
    end if;
  end if;

  return jsonb_build_object(
    'window_days', p_days,
    'counts', jsonb_build_object(
      'inquiries_handled', v_inquiries, 'actions_executed', v_actions, 'conversations_answered', v_conversations),
    'baselines', jsonb_build_object(
      'inquiry_minutes', b.inquiry_minutes, 'action_minutes', b.action_minutes,
      'conversation_minutes', b.conversation_minutes, 'avg_fte_cost_monthly_usd', b.avg_fte_cost_monthly_usd),
    'hours_saved', case when v_counted then round(v_human_minutes / 60.0, 1) end,
    'fte_equivalent', v_fte,
    'de_cost_usd', v_de_cost,
    'human_cost_equivalent_usd', v_human_cost,
    'monthly_saving_usd', case when v_savings is not null then round(v_savings * 30.0 / p_days, 2) end,
    'roi_ratio', v_roi,
    'unconfigured', to_jsonb(v_missing),
    'configured', v_counted and b.avg_fte_cost_monthly_usd is not null and array_length(v_missing, 1) is null
  );
end;
$$;

revoke all on function get_de_economics(uuid, uuid, integer) from public, anon;
grant execute on function get_de_economics(uuid, uuid, integer) to authenticated, service_role;
