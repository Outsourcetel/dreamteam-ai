-- 773_a_response_is_a_reply_not_an_action.sql
-- ============================================================================
-- Register C-11 (docs/63): the per-employee summary a human reads to judge how
-- an employee is doing reported ZERO responses for the only employee doing any
-- work.
--
--   Technical Support, outsourcetel-hq, last 30 days
--     reported responses_this_month : 0
--     actual assistant replies      : 161
--     actual conversations          : 159
--     eval judgements on its work   : 111, passing 91% (docs/58)
--
-- ── The defect ─────────────────────────────────────────────────────────────
-- `responses_this_month` counted rows in action_executions:
--
--   WHERE subject_kind = 'de' AND subject_id = p_de_id AND mode = 'execute'
--
-- That is a correct count of EXECUTED ACTIONS. It is not a count of responses.
-- A support employee's work is replies, and replies do not create
-- action_executions rows — so the field was measuring a different kind of work
-- and presenting the answer under the word "responses".
--
-- Worth stating because it is the shape that hid it: the number was correct on
-- five of six active employees. Those five genuinely have zero of everything,
-- so a broken counter and a true zero are indistinguishable there. It was wrong
-- on 1 of the 1 rows capable of testing it — which is the worst possible shape,
-- because the dashboard looked 5/6 healthy.
--
-- ── Why count replies here and not both ────────────────────────────────────
-- Executed actions are already reported, correctly, by get_de_action_metrics —
-- an organ docs/51 audited and found HONEST. Summing the two into one field
-- would put two kinds of work behind one word and risk double-counting an
-- action that also produced a reply. The field is named "responses", so it
-- counts responses; actions keep their own metric.
--
-- ── Deliberately NOT changed ───────────────────────────────────────────────
-- avg_csat, escalation_rate and resolution_rate remain hard NULL. They are not
-- computed and returning NULL says exactly that. A null is an honest absence; a
-- wrong number is not, and only the wrong number is in scope here. Computing
-- them properly (de_conversations.csat_score exists) is a separate change.
-- ============================================================================

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
  SELECT COALESCE(COUNT(*), 0) INTO v_responses_this_month
  FROM de_messages m JOIN de_conversations c ON c.id = m.conversation_id
  WHERE c.de_id = p_de_id AND m.role = 'assistant'
    AND m.created_at > now() - (p_time_window_days || ' days')::interval;

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
$function$

;
