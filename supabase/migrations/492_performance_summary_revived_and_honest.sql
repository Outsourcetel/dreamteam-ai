-- 492_performance_summary_revived_and_honest.sql
-- ============================================================================
-- docs/37 Move 0, second site — and worse than a lie.
--
-- get_de_performance_summary feeds the workforce performance panel
-- (WorkforceChatHubPage.tsx:295 -> PerformanceDashboard). It selects FROM
-- csat_surveys, and csat_surveys DOES NOT EXIST in any schema. The function
-- raises at runtime, getPerformanceSummary catches it and returns null, and the
-- panel silently renders nothing. It has never worked. That is not a fabricated
-- number — it is a dead organ that fails quietly, the failure an audit is least
-- likely to catch, because nothing on screen is WRONG; there is simply nothing.
--
--   1. The csat_surveys SELECT becomes an explicit NULL — this REVIVES the
--      function, and NULL is the truth: there is no survey source.
--   2/3. escalation_rate and resolution_rate stop being COALESCEd to 0. The
--      NULLIF(responses,0) guard underneath was already correct, so the honest
--      NULL was being computed and thrown away.
--
-- Counts untouched: cost, responses, amendments, training. Zero IS zero.
-- Spliced from the LIVE definition, one-hit anchors (body is CRLF).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_de_performance_summary(p_de_id uuid, p_time_window_days integer DEFAULT 30)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tenant_id UUID;
  v_de_name TEXT;
  v_de_status TEXT;
  v_current_stage TEXT;
  v_cost_this_month NUMERIC;
  v_responses_this_month INT;
  v_avg_csat NUMERIC;
  v_escalation_rate NUMERIC;
  v_resolution_rate NUMERIC;
  v_amendments_count INT;
  v_training_sessions INT;
BEGIN
  SELECT tenant_id, name, status INTO v_tenant_id, v_de_name, v_de_status
  FROM digital_employees WHERE id = p_de_id;

  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'DE not found'; END IF;
  IF NOT (v_tenant_id = auth_tenant_id() AND auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager'])) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT stage INTO v_current_stage FROM de_deployment_stages WHERE de_id = p_de_id;
  IF v_current_stage IS NULL THEN v_current_stage := 'unknown'; END IF;

  SELECT COALESCE(SUM(total_cost), 0) INTO v_cost_this_month FROM tenant_cost_tracking
  WHERE entity_id = p_de_id AND billing_month = to_char(now(), 'YYYY-MM');

  SELECT COALESCE(COUNT(*), 0) INTO v_responses_this_month FROM action_executions
  WHERE de_id = p_de_id AND created_at > now() - (p_time_window_days || ' days')::interval;

  -- mig 492: the survey table this used to read DOES NOT EXIST in any
    -- schema, which made the whole function raise at runtime — so the panel it
    -- feeds never rendered; the client swallowed the error. Satisfaction has no
    -- survey source in this platform today, so the honest value is NULL.
    v_avg_csat := NULL;

  SELECT COUNT(*)::NUMERIC / NULLIF(v_responses_this_month, 0) * 100 INTO v_escalation_rate
  FROM action_executions WHERE de_id = p_de_id AND status = 'escalated' AND created_at > now() - (p_time_window_days || ' days')::interval;

  SELECT COUNT(*)::NUMERIC / NULLIF(v_responses_this_month, 0) * 100 INTO v_resolution_rate
  FROM action_executions WHERE de_id = p_de_id AND status = 'completed' AND created_at > now() - (p_time_window_days || ' days')::interval;

  SELECT COALESCE(COUNT(*), 0) INTO v_amendments_count FROM workforce_actions
  WHERE entity_id = p_de_id AND action_type IN ('de_amend', 'de_train') AND applied_at IS NOT NULL AND created_at > now() - (p_time_window_days || ' days')::interval;

  SELECT COALESCE(COUNT(*), 0) INTO v_training_sessions FROM de_training_feedback
  WHERE de_id = p_de_id AND created_at > now() - (p_time_window_days || ' days')::interval;

  RETURN json_build_object('de_id', p_de_id, 'de_name', v_de_name, 'de_status', v_de_status, 'current_stage', v_current_stage, 'time_window_days', p_time_window_days, 'cost_this_month', v_cost_this_month, 'responses_this_month', v_responses_this_month, 'avg_csat', v_avg_csat, 'escalation_rate', v_escalation_rate, 'resolution_rate', v_resolution_rate, 'amendments_applied', v_amendments_count, 'training_sessions', v_training_sessions, 'fte_equivalent_cost', ROUND((v_cost_this_month / 30)::numeric, 2), 'roi_hours_saved', (v_responses_this_month * 0.5)::INT, 'timestamp', now());
END;
$function$
;

notify pgrst, 'reload schema';

do $a$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.get_de_performance_summary(uuid,integer)'::regprocedure);
  if v_def ilike '%csat_surveys%' then
    raise exception '492: still reads a table that does not exist';
  end if;
  if v_def ilike '%* 100, 0) INTO v_escalation_rate%' or v_def ilike '%* 100, 0) INTO v_resolution_rate%' then
    raise exception '492: a rate is still coalesced to zero';
  end if;
  if v_def not ilike '%COALESCE(SUM(total_cost), 0)%' then
    raise exception '492: a true count was turned into null — over-applied';
  end if;
  if exists (select 1 from information_schema.tables where table_name = 'csat_surveys') then
    raise exception '492: csat_surveys now EXISTS — re-point the function instead of nulling';
  end if;
  raise notice '492: performance summary revived';
end $a$;
