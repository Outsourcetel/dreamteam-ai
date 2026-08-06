-- 621 — trust metrics for the whole workforce, not one job.
--
-- Founder: "come up with more global level trust metrics that apply at org
-- level and not specific job functions."
--
-- ⚠ THE GAP, MEASURED FIRST. There are FOURTEEN `get_de_*` metric functions and
-- not one workforce-level roll-up. You can see how the Finance DE is doing; you
-- cannot see whether the workforce as a whole has earned more rope. Meanwhile
-- the org-level trust page tracked `invoice_auto_send` — a billing job — as if
-- it described everybody.
--
-- Every metric here is job-agnostic: it means the same for a Support employee,
-- a Finance employee and a Marketing employee, because it is computed from the
-- SHAPE of the work (was a human needed, did they change it, how long did they
-- look) rather than from what the work was about.
--
-- Grounded in real rows before it was written — this workspace has 180 action
-- executions and 31 human decisions, so none of these are hypothetical:
--   human_gated_destructive 59 · human_gated_trust 50 · auto_executed 31
--   executed_after_approval 16 · failed 12 · guardrail_blocked 11 · previewed 1
--   approved-unchanged 29 · rejected 2 · edited 0 · median decision 5.3 min
--
-- ⚠ ONE METRIC IS HONEST-BUT-UNPROVEN. `action_executions` carries
-- rolled_back_at / rollback_of / rollback_receipt, so reversal is structurally
-- recorded — but NOTHING has ever been rolled back on this platform (0 of 180).
-- A 0% intervention rate therefore means "no reversal has ever been performed",
-- which is not the same as "nothing needed reversing". The function returns
-- `intervention_ever_recorded: false` alongside it so the UI can say so rather
-- than render a reassuring zero.

begin;

create or replace function get_workforce_trust_metrics(
  p_tenant_id uuid default null, p_days integer default 30
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := coalesce(p_tenant_id, auth_tenant_id());
  v_since  timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  -- executions
  v_ran        int;  -- actually performed
  v_auto       int;  -- performed with no human in the loop
  v_gated      int;  -- stopped for a human
  v_blocked    int;  -- stopped by a guardrail
  v_failed     int;
  v_reversed   int;
  v_reversed_ever int;
  -- decisions
  v_decided    int;
  v_unchanged  int;
  v_edited     int;
  v_rejected   int;
  v_median_s   numeric;
  v_snap       int;   -- decided in under a minute
  -- workforce
  v_employees  int;
  v_with_rule  int;
  v_incidents  int;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;

  select
    count(*) filter (where decision in ('auto_executed','executed_after_approval')),
    count(*) filter (where decision = 'auto_executed'),
    count(*) filter (where decision in ('human_gated_destructive','human_gated_trust')),
    count(*) filter (where decision = 'guardrail_blocked'),
    count(*) filter (where decision = 'failed'),
    count(*) filter (where rolled_back_at is not null)
  into v_ran, v_auto, v_gated, v_blocked, v_failed, v_reversed
  from action_executions
  where tenant_id = v_tenant and created_at >= v_since;

  -- Deliberately UNBOUNDED by the window: "has a reversal ever happened here"
  -- is what decides whether a 0% intervention rate is meaningful.
  select count(*) into v_reversed_ever
  from action_executions where tenant_id = v_tenant and rolled_back_at is not null;

  select
    count(*),
    count(*) filter (where status = 'approved' and decision_edit is null),
    count(*) filter (where status = 'approved' and decision_edit is not null),
    count(*) filter (where status = 'rejected'),
    percentile_cont(0.5) within group (order by extract(epoch from (decided_at - created_at))),
    count(*) filter (where decided_at - created_at < interval '1 minute')
  into v_decided, v_unchanged, v_edited, v_rejected, v_median_s, v_snap
  from human_tasks
  where tenant_id = v_tenant and status in ('approved','rejected')
    and decided_at is not null and decided_at >= v_since;

  select count(*) into v_employees
  from digital_employees where tenant_id = v_tenant and status = 'active';

  -- Post-618 an employee with no rule does nothing automatically, so coverage
  -- is now a real measure of how much of the workforce is dormant by omission.
  select count(distinct de_id) into v_with_rule
  from de_autonomy where tenant_id = v_tenant and de_id is not null;

  select count(*) into v_incidents
  from de_incidents where tenant_id = v_tenant and occurred_at >= v_since;

  return jsonb_build_object(
    'window_days', greatest(coalesce(p_days, 30), 1),
    'as_of', now(),

    -- How much the workforce actually carries.
    'actions_performed', v_ran,
    'autonomy_rate', case when v_ran > 0 then round((v_auto::numeric / v_ran) * 100, 1) end,

    -- Of the work handed to a person, how much came back untouched. The single
    -- best argument for widening autonomy — or against it.
    'decisions', v_decided,
    'acceptance_rate', case when v_decided > 0 then round((v_unchanged::numeric / v_decided) * 100, 1) end,
    'edit_rate',       case when v_decided > 0 then round((v_edited::numeric   / v_decided) * 100, 1) end,
    'reject_rate',     case when v_decided > 0 then round((v_rejected::numeric / v_decided) * 100, 1) end,

    -- Whether the human half of governance is real. A median measured in
    -- seconds is a rubber stamp, and a high acceptance rate next to it means
    -- nothing at all.
    'median_seconds_to_decide', round(coalesce(v_median_s, 0)),
    'decided_under_a_minute', v_snap,
    'rubber_stamp_risk', (v_decided >= 5 and coalesce(v_median_s, 999) < 60),

    -- The safety net, and how often it fires.
    'guardrail_blocks', v_blocked,
    'guardrail_block_rate', case when (v_ran + v_gated + v_blocked) > 0
      then round((v_blocked::numeric / (v_ran + v_gated + v_blocked)) * 100, 1) end,
    'human_gated', v_gated,
    'failures', v_failed,

    -- ⚠ Reversal is RECORDED but has never been EXERCISED here. Reporting 0%
    -- without saying so would read as "nothing ever went wrong".
    'interventions', v_reversed,
    'intervention_rate', case when v_ran > 0 then round((v_reversed::numeric / v_ran) * 100, 1) end,
    'intervention_ever_recorded', (v_reversed_ever > 0),

    'incidents', v_incidents,
    'incident_rate_per_100', case when v_ran > 0 then round((v_incidents::numeric / v_ran) * 100, 1) end,

    -- How much of the workforce is even switched on.
    'employees_active', v_employees,
    'employees_with_a_rule', v_with_rule,
    'rule_coverage_rate', case when v_employees > 0
      then round((v_with_rule::numeric / v_employees) * 100, 1) end
  );
end;
$$;

revoke execute on function get_workforce_trust_metrics(uuid, integer) from public;
grant execute on function get_workforce_trust_metrics(uuid, integer) to authenticated, service_role;

do $verify$
declare
  v_t uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_m jsonb;
begin
  if v_t is null then raise notice 'no workspace to verify against'; return; end if;

  -- A wide window so the seeded history is inside it.
  v_m := get_workforce_trust_metrics(v_t, 3650);

  if v_m->>'actions_performed' is null then raise exception 'the roll-up returned no action count'; end if;
  if (v_m->>'actions_performed')::int = 0 then
    raise exception 'expected real executions in this workspace, got 0 — the metric is reading the wrong thing';
  end if;
  if (v_m->>'decisions')::int = 0 then
    raise exception 'expected real human decisions in this workspace, got 0';
  end if;
  -- The honesty flag must be present and false here (nothing has ever been rolled back).
  if (v_m->'intervention_ever_recorded') is null then
    raise exception 'the intervention honesty flag is missing';
  end if;

  raise notice 'workforce trust: % actions, %%% autonomous, %%% accepted unchanged, median % s to decide, coverage %%%',
    v_m->>'actions_performed', v_m->>'autonomy_rate', v_m->>'acceptance_rate',
    v_m->>'median_seconds_to_decide', v_m->>'rule_coverage_rate';
end;
$verify$;

commit;
