-- 622 — a rate needs a denominator worth dividing by.
--
-- 621 shipped and immediately produced this for outsourcetel-hq:
--
--     "incident_rate_per_100": 700.0
--
-- Arithmetically correct — 28 incidents over 4 performed actions — and
-- completely useless. A governance panel that opens with 700% teaches the
-- reader to distrust every other number on it, which is worse than showing
-- nothing.
--
-- ⚠ AND MY OWN COMMENT IN 621 WAS WRONG. It said "this workspace has 180 action
-- executions and 31 human decisions". Those were PLATFORM-WIDE totals; the
-- function is tenant-scoped, and outsourcetel-hq holds 12 executions. The 180
-- lives mostly in the acme-telecom demo tenant (137). Measuring one surface and
-- describing it as another — the same error these audits keep finding, made in
-- the migration that adds the measurements.
--
-- Two changes:
--   1. Every rate now carries a MINIMUM SAMPLE. Below it the rate is null and a
--      companion flag says why, so the UI prints "not enough yet" instead of a
--      number nobody should act on.
--   2. Incident rate is per performed action, which is the wrong denominator
--      when incidents are mostly raised by things that never became actions.
--      It now reports the COUNT plainly and only offers a rate when there is a
--      real base to divide by.

begin;

create or replace function get_workforce_trust_metrics(
  p_tenant_id uuid default null, p_days integer default 30
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := coalesce(p_tenant_id, auth_tenant_id());
  v_since  timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  -- A rate on fewer events than this is noise dressed as a measurement.
  c_min_actions   constant int := 10;
  c_min_decisions constant int := 5;
  v_ran        int;  v_auto     int;  v_gated   int;
  v_blocked    int;  v_failed   int;  v_reversed int;
  v_reversed_ever int;
  v_decided    int;  v_unchanged int; v_edited  int;  v_rejected int;
  v_median_s   numeric; v_snap int;
  v_employees  int;  v_with_rule int; v_incidents int;
  v_considered int;   -- everything the gate ruled on: performed + gated + blocked
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

  v_considered := v_ran + v_gated + v_blocked;

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

  select count(distinct de_id) into v_with_rule
  from de_autonomy where tenant_id = v_tenant and de_id is not null;

  select count(*) into v_incidents
  from de_incidents where tenant_id = v_tenant and occurred_at >= v_since;

  return jsonb_build_object(
    'window_days', greatest(coalesce(p_days, 30), 1),
    'as_of', now(),

    -- ⚠ Sample gates. The UI reads these FIRST and says "not enough yet"
    -- rather than printing a rate built on three events.
    'min_actions_for_a_rate', c_min_actions,
    'min_decisions_for_a_rate', c_min_decisions,
    -- ⚠ TWO DENOMINATORS, TWO FLAGS. Rates about how work was DECIDED divide by
    -- everything the gate ruled on (performed + gated + blocked); rates about
    -- what the workforce DID divide by what was actually performed. Here that
    -- is 12 vs 4 — one flag would have told the UI the wrong story, and my own
    -- first assertion in this migration got it wrong for exactly that reason.
    'enough_considered', (v_considered >= c_min_actions),
    'enough_performed', (v_ran >= c_min_actions),
    'enough_decisions', (v_decided >= c_min_decisions),

    'actions_considered', v_considered,
    'actions_performed', v_ran,
    'autonomy_rate', case when v_ran >= c_min_actions
      then round((v_auto::numeric / v_ran) * 100, 1) end,
    'actions_autonomous', v_auto,

    'decisions', v_decided,
    'decisions_unchanged', v_unchanged,
    'decisions_edited', v_edited,
    'decisions_rejected', v_rejected,
    'acceptance_rate', case when v_decided >= c_min_decisions
      then round((v_unchanged::numeric / v_decided) * 100, 1) end,
    'edit_rate', case when v_decided >= c_min_decisions
      then round((v_edited::numeric / v_decided) * 100, 1) end,
    'reject_rate', case when v_decided >= c_min_decisions
      then round((v_rejected::numeric / v_decided) * 100, 1) end,

    'median_seconds_to_decide', case when v_decided > 0 then round(coalesce(v_median_s, 0)) end,
    'decided_under_a_minute', v_snap,
    'rubber_stamp_risk', (v_decided >= c_min_decisions and coalesce(v_median_s, 999999) < 60),

    'guardrail_blocks', v_blocked,
    'guardrail_block_rate', case when v_considered >= c_min_actions
      then round((v_blocked::numeric / v_considered) * 100, 1) end,
    'human_gated', v_gated,
    'failures', v_failed,

    -- Recorded, never exercised. The flag is what stops a 0% reading as proof.
    'interventions', v_reversed,
    'intervention_rate', case when v_ran >= c_min_actions
      then round((v_reversed::numeric / v_ran) * 100, 1) end,
    'intervention_ever_recorded', (v_reversed_ever > 0),

    -- ⚠ COUNT, not a rate by default. Incidents are raised by conversations,
    -- evaluations and gates as well as by actions, so dividing them by actions
    -- performed produced 700% here. A rate only when the base is real.
    'incidents', v_incidents,
    'incident_rate_per_100_actions', case when v_ran >= c_min_actions
      then round((v_incidents::numeric / v_ran) * 100, 1) end,

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
  v_a uuid := (select id from tenants where slug = 'acme-telecom');
  v_m jsonb;
begin
  if v_t is null then raise notice 'no workspace to verify against'; return; end if;

  -- The workspace that triggered this: too few actions, so no rate at all.
  v_m := get_workforce_trust_metrics(v_t, 3650);
  if (v_m->>'incident_rate_per_100_actions') is not null then
    raise exception 'a rate was published on % performed action(s) — the sample gate did not hold',
      v_m->>'actions_performed';
  end if;
  -- 4 performed but 12 considered: the PERFORMED gate must be shut and the
  -- CONSIDERED gate open. This assertion failed on the first run by checking a
  -- single flag, which is what surfaced that one flag was not enough.
  if (v_m->'enough_performed')::boolean is not false then
    raise exception 'enough_performed should be false on % performed action(s)', v_m->>'actions_performed';
  end if;
  if (v_m->'enough_considered')::boolean is not true then
    raise exception 'enough_considered should be true on % considered', v_m->>'actions_considered';
  end if;
  if (v_m->>'incidents')::int = 0 then
    raise exception 'the incident COUNT should still be reported even when its rate is withheld';
  end if;

  -- A workspace with real volume must still produce rates.
  if v_a is not null then
    v_m := get_workforce_trust_metrics(v_a, 3650);
    if (v_m->>'actions_considered')::int >= 10 and (v_m->>'autonomy_rate') is null then
      raise exception 'a workspace with % actions produced no autonomy rate', v_m->>'actions_considered';
    end if;
    raise notice 'high-volume workspace: % actions considered, autonomy %%%, acceptance %%%',
      v_m->>'actions_considered', v_m->>'autonomy_rate', v_m->>'acceptance_rate';
  end if;

  raise notice 'sample gates hold: counts always shown, rates only on a real base';
end;
$verify$;

commit;
