-- 708 — a number we don't know shows as UNKNOWN, never as a guess.
--
-- docs/51 offender #3 (founder-approved fix list, item 3). Three
-- founder-visible "time saved" numbers were manufactured by constants the
-- platform invented, in direct violation of its own §12.3 doctrine (mig 131:
-- baselines are "configured by the Organisation, not invented by the
-- platform"; unconfigured ⇒ NULL):
--
--   1. get_workforce_economics:  human_minutes_saved = completed runs ×
--      coalesce(action_minutes, 15) — a platform-invented 15-minute default
--      for every tenant that never typed a baseline in (i.e. every real one).
--      Live: acme-telecom showed "705 minutes saved", hq "240", from nothing.
--   2. get_playbook_economics:   the same coalesce(…, 15) per playbook —
--      LivePlaybookBuilder renders "~240 min of human work covered" for a
--      tenant with no baseline on file.
--   3. get_de_performance_summary: roi_hours_saved = action_executions
--      count × 0.5h — every row, including human_gated rows that never
--      executed and the second row of every approved action, booked as 30
--      minutes of saved human time.
--
-- Rule shipped here: minutes/hours appear ONLY multiplied by a baseline the
-- tenant itself configured. Otherwise the JSON carries null and the UI says
-- so. Founder-visible numbers WILL blank on unconfigured tenants — that is
-- the intended outcome, not a regression.
--
-- ⚠ Verified while porting (drift from docs/51): get_de_performance_summary
-- could not actually RUN — its reads name columns that do not exist on this
-- schema (action_executions.de_id, action_executions.status,
-- tenant_cost_tracking.entity_id; 42703 at first execution, proven live), so
-- the panel it feeds has been silently blank and the ×0.5h lie was written
-- but unreachable. It is rebuilt below on columns that exist, with the same
-- honest-NULL discipline, so the panel returns HONEST instead of nothing:
-- real counts, real AI spend, and roi_hours_saved = null until a measured
-- basis exists.

BEGIN;

-- ── 1. Whole-workforce economics ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_workforce_economics(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_de_count int; v_pb_runs int; v_pb_done int; v_minutes numeric; v_ai numeric; v_value numeric; v_bl workforce_baselines;
begin
  if auth.uid() is not null and not exists (select 1 from profiles p where p.user_id=auth.uid() and (p.layer='platform' or p.tenant_id=p_tenant_id)) then raise exception 'not authorized'; end if;
  select count(*) into v_de_count from digital_employees where tenant_id=p_tenant_id and lifecycle_status not in ('retired','archived');
  select count(*), count(*) filter (where r.status='completed') into v_pb_runs, v_pb_done from playbook_runs r join playbook_definitions d on d.id=r.definition_id where d.tenant_id=p_tenant_id;
  select coalesce(sum(a.cost_used_cents),0) into v_ai from agentic_step_runs a where a.tenant_id=p_tenant_id;
  select * into v_bl from workforce_baselines where tenant_id=p_tenant_id;
  -- mig 708 (§12.3): minutes exist only as (runs × the tenant's OWN
  -- action_minutes). The old coalesce(action_minutes, 15) was a
  -- platform-invented number wearing the tenant's clothes — for every
  -- unconfigured tenant, i.e. every real one. Unknown renders as null.
  v_minutes := case when v_bl.action_minutes is not null then v_pb_done * v_bl.action_minutes end;
  v_value := case when v_minutes is not null and v_bl.avg_fte_cost_monthly_usd is not null and v_bl.avg_fte_cost_monthly_usd>0 then round((v_minutes/60.0)*(v_bl.avg_fte_cost_monthly_usd/160.0),2) else null end;
  return jsonb_build_object(
    'digital_employees',v_de_count,'playbook_runs',v_pb_runs,'playbook_completed',v_pb_done,
    'ai_cost_usd',round(v_ai/100.0,2),
    'human_minutes_saved',case when v_minutes is not null then round(v_minutes,0) end,
    'est_value_usd',v_value,
    'baseline_configured',v_bl.tenant_id is not null,
    'action_minutes_configured',v_bl.action_minutes is not null);
end; $function$;

REVOKE ALL ON FUNCTION public.get_workforce_economics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_workforce_economics(uuid) TO authenticated, service_role;

-- ── 2. Per-playbook economics ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_playbook_economics(p_definition_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- mig 708 (§12.3): same rule as get_workforce_economics — the header of the
  -- 191 original called the dollars honest while the minutes on screen came
  -- from coalesce(action_minutes, 15), a number no tenant ever typed. Minutes
  -- now exist only when the tenant's own baseline does.
  v_minutes := case when v_bl.action_minutes is not null then v_completed * v_bl.action_minutes end;
  -- hourly rate implied by the tenant's own monthly FTE cost (160 h/month)
  v_value := case when v_minutes is not null and v_bl.avg_fte_cost_monthly_usd is not null and v_bl.avg_fte_cost_monthly_usd > 0
    then round((v_minutes / 60.0) * (v_bl.avg_fte_cost_monthly_usd / 160.0), 2) else null end;

  return jsonb_build_object(
    'runs', v_runs, 'completed', v_completed, 'failed', v_failed,
    'completion_pct', case when v_runs > 0 then round(100.0 * v_completed / v_runs, 1) else null end,
    'ai_cost_cents', round(v_cost, 1),
    'human_minutes_saved', case when v_minutes is not null then round(v_minutes, 0) end,
    'est_value_usd', v_value,
    'baseline_configured', v_bl.tenant_id is not null,
    'action_minutes_configured', v_bl.action_minutes is not null
  );
end; $function$;

REVOKE ALL ON FUNCTION public.get_playbook_economics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_playbook_economics(uuid) TO authenticated, service_role;

-- ── 3. Per-DE performance summary (rebuilt on columns that exist) ───────────
CREATE OR REPLACE FUNCTION public.get_de_performance_summary(p_de_id uuid, p_time_window_days integer DEFAULT 30)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID;
  v_de_name TEXT;
  v_de_status TEXT;
  v_current_stage TEXT;
  v_cost_this_month NUMERIC;
  v_responses_this_month INT;
  v_amendments_count INT;
  v_training_sessions INT;
BEGIN
  SELECT tenant_id, name, status INTO v_tenant_id, v_de_name, v_de_status
  FROM digital_employees WHERE id = p_de_id;

  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'DE not found'; END IF;
  -- Trusted-server gate, same shape as get_de_performance_metrics (571/454):
  -- pg_cron and server scripts carry no JWT; humans need a management role in
  -- the employee's own workspace.
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    IF NOT (v_tenant_id = auth_tenant_id() AND auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;
  END IF;

  SELECT stage INTO v_current_stage FROM de_deployment_stages WHERE de_id = p_de_id;
  IF v_current_stage IS NULL THEN v_current_stage := 'unknown'; END IF;

  -- Real AI spend this calendar month (de_token_usage × published pricing —
  -- the platform's actual cost source). The old read named
  -- tenant_cost_tracking.entity_id, a column that does not exist (42703), so
  -- this function has never returned since the rebuild — the panel was blank.
  SELECT coalesce(round(sum(
      (u.input_tokens::numeric / 1000000) * coalesce(pr.input_price_per_million, 3.00)
      + (u.output_tokens::numeric / 1000000) * coalesce(pr.output_price_per_million, 15.00)
    ), 2), 0) INTO v_cost_this_month
  FROM de_token_usage u
  LEFT JOIN ai_model_pricing pr ON pr.model_id = u.model_id
  WHERE u.de_id = p_de_id AND u.created_at >= date_trunc('month', now());

  -- A real count of real rows (subject_kind/subject_id are the actual
  -- columns; the old read named action_executions.de_id, which never existed
  -- here). A genuine zero is a true measurement and stays 0.
  SELECT COALESCE(COUNT(*), 0) INTO v_responses_this_month FROM action_executions
  WHERE subject_kind = 'de' AND subject_id = p_de_id AND mode = 'execute'
    AND created_at > now() - (p_time_window_days || ' days')::interval;

  SELECT COALESCE(COUNT(*), 0) INTO v_amendments_count FROM workforce_actions
  WHERE entity_id = p_de_id AND action_type IN ('de_amend', 'de_train') AND applied_at IS NOT NULL AND created_at > now() - (p_time_window_days || ' days')::interval;

  SELECT COALESCE(COUNT(*), 0) INTO v_training_sessions FROM de_training_feedback
  WHERE de_id = p_de_id AND created_at > now() - (p_time_window_days || ' days')::interval;

  RETURN json_build_object(
    'de_id', p_de_id, 'de_name', v_de_name, 'de_status', v_de_status,
    'current_stage', v_current_stage, 'time_window_days', p_time_window_days,
    'cost_this_month', v_cost_this_month,
    'responses_this_month', v_responses_this_month,
    -- mig 492: satisfaction has no survey source in this platform; the honest
    -- value is NULL, and the client renders "Not measured".
    'avg_csat', NULL,
    -- mig 708: these two used to read action_executions.status, a column that
    -- has never existed here. Answering escalation/resolution rates live in
    -- get_de_performance_metrics (exam-filtered, 571); this action panel has
    -- no measured source for them, and an unmeasured rate is NULL, not 0.
    'escalation_rate', NULL,
    'resolution_rate', NULL,
    'amendments_applied', v_amendments_count,
    'training_sessions', v_training_sessions,
    -- Real spend averaged per day of the month — the client labels it as AI
    -- spend, not as an FTE claim. (Key name kept for interface compatibility.)
    'fte_equivalent_cost', ROUND((v_cost_this_month / 30)::numeric, 2),
    -- mig 708 (§12.3): the old value was count × 0.5h — a platform-invented
    -- half-hour booked for every row, including human-gated rows that never
    -- executed and the second row of every approved action. Hours saved
    -- appear ONLY from a tenant-typed baseline (get_de_economics does that
    -- job); this panel has none, so the honest value is unknown.
    'roi_hours_saved', NULL,
    'timestamp', now());
END;
$function$;

REVOKE ALL ON FUNCTION public.get_de_performance_summary(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_de_performance_summary(uuid, integer) TO authenticated, service_role;

-- ── Asserts ─────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_n int;
  v_tenant uuid; v_def uuid; v_de uuid;
  v_out jsonb; v_expect numeric;
  v_arms text := '';
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- S1 (always): one signature each.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
   WHERE nsp.nspname = 'public' AND p.proname IN ('get_workforce_economics', 'get_playbook_economics', 'get_de_performance_summary');
  IF v_n <> 3 THEN RAISE EXCEPTION 'S1 FAILED: % signatures across the 3 functions (want 3)', v_n; END IF;

  -- S2 (always): perimeter.
  IF has_function_privilege('anon', 'public.get_workforce_economics(uuid)', 'execute')
     OR has_function_privilege('anon', 'public.get_playbook_economics(uuid)', 'execute')
     OR has_function_privilege('anon', 'public.get_de_performance_summary(uuid, integer)', 'execute') THEN
    RAISE EXCEPTION 'S2 FAILED: anon can execute an economics reader';
  END IF;
  IF NOT (has_function_privilege('authenticated', 'public.get_workforce_economics(uuid)', 'execute')
     AND has_function_privilege('authenticated', 'public.get_playbook_economics(uuid)', 'execute')
     AND has_function_privilege('authenticated', 'public.get_de_performance_summary(uuid, integer)', 'execute')) THEN
    RAISE EXCEPTION 'S2 FAILED: authenticated lost EXECUTE — the founder surfaces go blank the wrong way';
  END IF;

  -- D1: a tenant with completed runs and NO configured action_minutes must
  -- read null minutes and null value — never 15-a-run.
  SELECT d.tenant_id INTO v_tenant
    FROM playbook_runs r JOIN playbook_definitions d ON d.id = r.definition_id
   WHERE r.status = 'completed'
     AND NOT EXISTS (SELECT 1 FROM workforce_baselines b
                      WHERE b.tenant_id = d.tenant_id AND b.action_minutes IS NOT NULL)
   GROUP BY d.tenant_id ORDER BY count(*) DESC LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    v_out := public.get_workforce_economics(v_tenant);
    IF (v_out->>'human_minutes_saved') IS NOT NULL OR (v_out->>'est_value_usd') IS NOT NULL THEN
      RAISE EXCEPTION 'D1 FAILED: unconfigured tenant still shows minutes=% value=% — the invented default survives',
        v_out->>'human_minutes_saved', v_out->>'est_value_usd';
    END IF;
    IF (v_out->>'playbook_completed')::int < 1 THEN
      RAISE EXCEPTION 'D1 FAILED: the real counts vanished with the fake minutes';
    END IF;
    v_arms := v_arms || format(' D1(done=%s, minutes=null)', v_out->>'playbook_completed');
  ELSE
    v_arms := v_arms || ' D1(SKIPPED: no unconfigured tenant with completed runs)';
  END IF;

  -- D2: a tenant WITH its own action_minutes keeps its measured number —
  -- deleting the guess must not delete the configured truth.
  SELECT b.tenant_id INTO v_tenant
    FROM workforce_baselines b
   WHERE b.action_minutes IS NOT NULL
     AND EXISTS (SELECT 1 FROM playbook_runs r JOIN playbook_definitions d ON d.id = r.definition_id
                  WHERE d.tenant_id = b.tenant_id AND r.status = 'completed')
   LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    SELECT count(*) * max(b.action_minutes) INTO v_expect
      FROM playbook_runs r
      JOIN playbook_definitions d ON d.id = r.definition_id
      JOIN workforce_baselines b ON b.tenant_id = d.tenant_id
     WHERE d.tenant_id = v_tenant AND r.status = 'completed';
    v_out := public.get_workforce_economics(v_tenant);
    IF (v_out->>'human_minutes_saved')::numeric IS DISTINCT FROM round(v_expect, 0) THEN
      RAISE EXCEPTION 'D2 FAILED: configured tenant shows % minutes, recount says %', v_out->>'human_minutes_saved', round(v_expect, 0);
    END IF;
    v_arms := v_arms || format(' D2(configured minutes=%s)', v_out->>'human_minutes_saved');
  ELSE
    v_arms := v_arms || ' D2(SKIPPED: no configured tenant with completed runs)';
  END IF;

  -- D3: per-playbook, an unconfigured tenant's definition reads null minutes.
  SELECT d.id INTO v_def
    FROM playbook_definitions d
    JOIN playbook_runs r ON r.definition_id = d.id AND r.status = 'completed'
   WHERE NOT EXISTS (SELECT 1 FROM workforce_baselines b
                      WHERE b.tenant_id = d.tenant_id AND b.action_minutes IS NOT NULL)
   GROUP BY d.id ORDER BY count(*) DESC LIMIT 1;
  IF v_def IS NOT NULL THEN
    v_out := public.get_playbook_economics(v_def);
    IF (v_out->>'human_minutes_saved') IS NOT NULL THEN
      RAISE EXCEPTION 'D3 FAILED: per-playbook minutes still invented: %', v_out->>'human_minutes_saved';
    END IF;
    v_arms := v_arms || ' D3(playbook minutes=null)';
  ELSE
    v_arms := v_arms || ' D3(SKIPPED)';
  END IF;

  -- D4: get_de_performance_summary RETURNS (it could not, since the rebuild
  -- — 42703 on action_executions.de_id), counts real rows, and refuses to
  -- invent hours.
  SELECT subject_id INTO v_de FROM action_executions
   WHERE subject_kind = 'de' AND subject_id IS NOT NULL
   GROUP BY subject_id ORDER BY count(*) DESC LIMIT 1;
  IF v_de IS NULL THEN
    SELECT id INTO v_de FROM digital_employees LIMIT 1;
  END IF;
  IF v_de IS NOT NULL THEN
    v_out := public.get_de_performance_summary(v_de, 30)::jsonb;
    IF (v_out->>'roi_hours_saved') IS NOT NULL THEN
      RAISE EXCEPTION 'D4 FAILED: roi_hours_saved=% — the ×0.5h guess survives', v_out->>'roi_hours_saved';
    END IF;
    SELECT count(*) INTO v_n FROM action_executions
     WHERE subject_kind = 'de' AND subject_id = v_de AND mode = 'execute'
       AND created_at > now() - interval '30 days';
    IF (v_out->>'responses_this_month')::int IS DISTINCT FROM v_n THEN
      RAISE EXCEPTION 'D4 FAILED: responses_this_month=% but recount=%', v_out->>'responses_this_month', v_n;
    END IF;
    v_arms := v_arms || format(' D4(returns; responses=%s; roi=null)', v_n);
  ELSE
    v_arms := v_arms || ' D4(SKIPPED: no digital employees at all)';
  END IF;

  RAISE NOTICE '708 asserts passed:%', v_arms;
END
$probe$;

COMMIT;
