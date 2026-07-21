-- 220_pipeline_desk_sdr.sql
-- ============================================================================
-- EXEC-2b (SDR) — the PIPELINE desk. Renewal + CS work the account desk
-- (customer_accounts); a sales role works the OPPORTUNITIES pipeline. The
-- Book-of-Work engine and the write-back registry only spoke customer_accounts,
-- so this extends BOTH to a second desk — opportunities — without touching the
-- proven account path. Then seeds an SDR archetype kit on top.
--
-- Same safety spine as the account desk: whitelisted ops, server-composed +
-- frozen payloads, destructive writes (a stage change) always gated through
-- decide_action_execution, grounded + audited.
-- GLOBAL — every tenant.
-- ============================================================================

-- 1. Validator: allow the opportunities source on date_horizon + state_condition
CREATE OR REPLACE FUNCTION public.validate_work_watcher()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c jsonb := NEW.config; src text := coalesce(NEW.config->>'source','customer_accounts');
BEGIN
  IF NEW.kind = 'date_horizon' THEN
    IF src NOT IN ('customer_accounts','opportunities') THEN
      RAISE EXCEPTION 'date_horizon supports source customer_accounts or opportunities';
    END IF;
    IF src = 'customer_accounts' AND coalesce(c->>'date_field','renewal_date') <> 'renewal_date' THEN
      RAISE EXCEPTION 'date_horizon on customer_accounts supports date_field renewal_date only';
    END IF;
    IF src = 'opportunities' AND coalesce(c->>'date_field','close_date') <> 'close_date' THEN
      RAISE EXCEPTION 'date_horizon on opportunities supports date_field close_date only';
    END IF;
  ELSIF NEW.kind = 'state_condition' THEN
    IF src NOT IN ('customer_accounts','opportunities') THEN
      RAISE EXCEPTION 'state_condition supports source customer_accounts or opportunities';
    END IF;
    IF src = 'customer_accounts' AND NOT (c->>'field' IN ('health_score','status','arr_cents','tier')) THEN
      RAISE EXCEPTION 'state_condition on customer_accounts field must be one of health_score, status, arr_cents, tier';
    END IF;
    IF src = 'opportunities' AND NOT (c->>'field' IN ('stage','amount_cents')) THEN
      RAISE EXCEPTION 'state_condition on opportunities field must be one of stage, amount_cents';
    END IF;
    IF NOT (coalesce(c->>'op','') IN ('lt','lte','gt','gte','eq','neq')) THEN
      RAISE EXCEPTION 'state_condition op must be lt|lte|gt|gte|eq|neq';
    END IF;
    IF c->>'value' IS NULL THEN RAISE EXCEPTION 'state_condition value is required'; END IF;
  ELSIF NEW.kind = 'metric_threshold' THEN
    IF c->>'metric_key' IS NULL THEN RAISE EXCEPTION 'metric_threshold metric_key is required'; END IF;
    IF NOT (coalesce(c->>'op','') IN ('lt','gt')) THEN RAISE EXCEPTION 'metric_threshold op must be lt|gt'; END IF;
    IF c->>'value' IS NULL THEN RAISE EXCEPTION 'metric_threshold value is required'; END IF;
  ELSIF NEW.kind = 'schedule' THEN
    IF coalesce((c->>'interval_minutes')::int, 0) < 60 THEN RAISE EXCEPTION 'schedule interval_minutes must be >= 60'; END IF;
  END IF;
  RETURN NEW;
END; $$;

-- 2. Runner: add opportunities branches to date_horizon + state_condition.
--    Account branches are byte-for-byte the proven mig-213 logic.
CREATE OR REPLACE FUNCTION public.run_work_watchers(p_tenant_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  w work_watchers; v_new integer; v_total integer := 0; v_watchers integer := 0;
  v_obj_id uuid; v_inserted boolean; r record; v_h integer; v_occ text;
  v_title text; v_de_name text; v_src text;
BEGIN
  FOR w IN SELECT * FROM work_watchers WHERE active AND kind <> 'inbox'
      AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id) ORDER BY created_at
  LOOP
    v_new := 0; v_watchers := v_watchers + 1;
    v_src := coalesce(w.config->>'source','customer_accounts');
    SELECT coalesce(persona_name, name) INTO v_de_name FROM digital_employees WHERE id = w.de_id;

    -- ── date_horizon ──
    IF w.kind = 'date_horizon' AND v_src = 'customer_accounts' THEN
      FOR r IN
        SELECT ca.id, ca.name, ca.renewal_date, ca.arr_cents, ca.health_score,
               (ca.renewal_date - current_date) AS days_left
        FROM customer_accounts ca
        WHERE ca.tenant_id = w.tenant_id AND ca.renewal_date IS NOT NULL AND ca.renewal_date >= current_date
          AND (w.config->'status_filter' IS NULL OR ca.status IN (SELECT jsonb_array_elements_text(w.config->'status_filter')))
      LOOP
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days','[90,60,30]'::jsonb)))::int AS h) hs WHERE h >= r.days_left;
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := r.id::text || '|' || r.renewal_date::text || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name || ' (' || v_h || '-day checkpoint, renews ' || to_char(r.renewal_date, 'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' renews on ' || r.renewal_date::text || ' (' || r.days_left || ' days out). Work the ' || v_h || '-day motion per the playbook.',
          'customer_account', r.id::text, 'open', v_h, r.renewal_date::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'horizon_days',v_h,
            'subject', jsonb_build_object('name', r.name, 'renewal_date', r.renewal_date, 'arr_cents', r.arr_cents, 'health_score', r.health_score))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    ELSIF w.kind = 'date_horizon' AND v_src = 'opportunities' THEN
      FOR r IN
        SELECT o.id, coalesce(o.name, o.company_name, 'opportunity') AS name, o.close_date, o.amount_cents, o.stage,
               (o.close_date - current_date) AS days_left
        FROM opportunities o
        WHERE o.tenant_id = w.tenant_id AND o.close_date IS NOT NULL AND o.close_date >= current_date AND o.closed_at IS NULL
          AND (w.config->'stage_filter' IS NULL OR o.stage IN (SELECT jsonb_array_elements_text(w.config->'stage_filter')))
      LOOP
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days','[30,14,7]'::jsonb)))::int AS h) hs WHERE h >= r.days_left;
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := r.id::text || '|' || r.close_date::text || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name || ' (' || v_h || '-day, closes ' || to_char(r.close_date, 'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: opportunity ' || r.name || ' is in stage "' || coalesce(r.stage,'?') || '" and closes on ' || r.close_date::text || ' (' || r.days_left || ' days out). Advance it per the playbook.',
          'opportunity', r.id::text, 'open', v_h, r.close_date::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'horizon_days',v_h,
            'subject', jsonb_build_object('name', r.name, 'close_date', r.close_date, 'amount_cents', r.amount_cents, 'stage', r.stage))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    -- ── state_condition ──
    ELSIF w.kind = 'state_condition' AND v_src = 'customer_accounts' THEN
      FOR r IN
        SELECT ca.id, ca.name, ca.health_score, ca.status, ca.arr_cents, ca.tier
        FROM customer_accounts ca WHERE ca.tenant_id = w.tenant_id
          AND CASE w.config->>'field'
                WHEN 'health_score' THEN CASE w.config->>'op'
                    WHEN 'lt' THEN ca.health_score < (w.config->>'value')::numeric WHEN 'lte' THEN ca.health_score <= (w.config->>'value')::numeric
                    WHEN 'gt' THEN ca.health_score > (w.config->>'value')::numeric WHEN 'gte' THEN ca.health_score >= (w.config->>'value')::numeric
                    WHEN 'eq' THEN ca.health_score = (w.config->>'value')::numeric ELSE ca.health_score <> (w.config->>'value')::numeric END
                WHEN 'arr_cents' THEN CASE w.config->>'op'
                    WHEN 'lt' THEN ca.arr_cents < (w.config->>'value')::numeric WHEN 'lte' THEN ca.arr_cents <= (w.config->>'value')::numeric
                    WHEN 'gt' THEN ca.arr_cents > (w.config->>'value')::numeric WHEN 'gte' THEN ca.arr_cents >= (w.config->>'value')::numeric
                    WHEN 'eq' THEN ca.arr_cents = (w.config->>'value')::numeric ELSE ca.arr_cents <> (w.config->>'value')::numeric END
                WHEN 'status' THEN CASE w.config->>'op' WHEN 'eq' THEN ca.status = w.config->>'value' ELSE ca.status <> w.config->>'value' END
                WHEN 'tier' THEN CASE w.config->>'op' WHEN 'eq' THEN ca.tier = w.config->>'value' ELSE ca.tier <> w.config->>'value' END
                ELSE false END
      LOOP
        v_occ := r.id::text || '|' || (w.config->>'field') || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name;
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' matched "' || (w.config->>'field') || ' ' || (w.config->>'op') || ' ' || (w.config->>'value') || '". Assess and work per the playbook.',
          'customer_account', r.id::text, 'open', 2,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'condition', w.config,
            'subject', jsonb_build_object('name', r.name, 'health_score', r.health_score, 'status', r.status))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    ELSIF w.kind = 'state_condition' AND v_src = 'opportunities' THEN
      FOR r IN
        SELECT o.id, coalesce(o.name, o.company_name, 'opportunity') AS name, o.stage, o.amount_cents, o.close_date
        FROM opportunities o WHERE o.tenant_id = w.tenant_id AND o.closed_at IS NULL
          AND CASE w.config->>'field'
                WHEN 'amount_cents' THEN CASE w.config->>'op'
                    WHEN 'lt' THEN o.amount_cents < (w.config->>'value')::numeric WHEN 'lte' THEN o.amount_cents <= (w.config->>'value')::numeric
                    WHEN 'gt' THEN o.amount_cents > (w.config->>'value')::numeric WHEN 'gte' THEN o.amount_cents >= (w.config->>'value')::numeric
                    WHEN 'eq' THEN o.amount_cents = (w.config->>'value')::numeric ELSE o.amount_cents <> (w.config->>'value')::numeric END
                WHEN 'stage' THEN CASE w.config->>'op' WHEN 'eq' THEN o.stage = w.config->>'value' ELSE o.stage <> w.config->>'value' END
                ELSE false END
      LOOP
        v_occ := r.id::text || '|' || (w.config->>'field') || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name;
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: opportunity ' || r.name || ' matched "' || (w.config->>'field') || ' ' || (w.config->>'op') || ' ' || (w.config->>'value') || '". Advance it per the playbook.',
          'opportunity', r.id::text, 'open', 2,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'condition', w.config,
            'subject', jsonb_build_object('name', r.name, 'stage', r.stage, 'amount_cents', r.amount_cents, 'close_date', r.close_date))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    -- ── metric_threshold (unchanged) ──
    ELSIF w.kind = 'metric_threshold' THEN
      SELECT k.metric_key AS mkey, k.value, k.as_of INTO r
      FROM de_kpi_readings k WHERE k.tenant_id = w.tenant_id AND k.de_id = w.de_id AND k.metric_key = w.config->>'metric_key'
      ORDER BY k.as_of DESC, k.created_at DESC LIMIT 1;
      IF r.mkey IS NOT NULL AND ((w.config->>'op' = 'lt' AND r.value < (w.config->>'value')::numeric) OR (w.config->>'op' = 'gt' AND r.value > (w.config->>'value')::numeric)) THEN
        v_occ := r.mkey || '|' || r.as_of::text || '|' || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.mkey, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted THEN
          INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
          VALUES (w.tenant_id, w.de_id, left(w.label || ' — ' || r.mkey || ' at ' || r.value, 200),
            'Opened by the Book of Work: metric "' || r.mkey || '" read ' || r.value || ' on ' || r.as_of || ', crossing the ' || (w.config->>'op') || ' ' || (w.config->>'value') || ' line. Investigate per the playbook.',
            'metric', r.mkey, 'open', 2,
            jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'reading', jsonb_build_object('metric_key', r.mkey, 'value', r.value, 'as_of', r.as_of))
          ) RETURNING id INTO v_obj_id;
          UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
          v_new := v_new + 1;
        END IF;
      END IF;

    -- ── schedule (unchanged) ──
    ELSIF w.kind = 'schedule' THEN
      IF w.next_fire_at IS NULL THEN
        UPDATE work_watchers SET next_fire_at = now() + make_interval(mins => (w.config->>'interval_minutes')::int) WHERE id = w.id;
      ELSIF now() >= w.next_fire_at THEN
        v_occ := to_char(w.next_fire_at, 'YYYY-MM-DD"T"HH24:MI');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, 'schedule', v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted THEN
          INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
          VALUES (w.tenant_id, w.de_id, left(w.label, 200),
            'Opened by the Book of Work on schedule (' || coalesce(w.description, w.label) || '). Run the recurring motion per the playbook.',
            'schedule', v_occ, 'open', 3, jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'fired_at', now())
          ) RETURNING id INTO v_obj_id;
          UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
          v_new := v_new + 1;
        END IF;
        UPDATE work_watchers SET next_fire_at = now() + make_interval(mins => (w.config->>'interval_minutes')::int) WHERE id = w.id;
      END IF;
    END IF;

    UPDATE work_watchers SET last_run_at = now(), last_match_count = v_new WHERE id = w.id;
    v_total := v_total + v_new;
    IF v_new > 0 THEN
      BEGIN PERFORM append_audit_event_internal(w.tenant_id, coalesce(v_de_name, 'DE'), 'de',
          coalesce(v_de_name, 'DE') || ' found ' || v_new || ' new work item(s) via Book of Work watcher "' || w.label || '"',
          'playbook_step', jsonb_build_object('kind','book_of_work','watcher_id', w.id, 'watcher_kind', w.kind, 'new_cases', v_new));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'watchers_run', v_watchers, 'cases_opened', v_total);
END; $$;

-- 3. Pipeline write-back registry (mirror of the account registry, mig 215) ---
CREATE TABLE IF NOT EXISTS opportunity_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  de_id uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  objective_id uuid REFERENCES de_objectives(id) ON DELETE SET NULL,
  kind text NOT NULL, summary text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opportunity_activities_opp ON opportunity_activities(opportunity_id, created_at DESC);
ALTER TABLE opportunity_activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS opportunity_activities_tenant_read ON opportunity_activities;
CREATE POLICY opportunity_activities_tenant_read ON opportunity_activities FOR SELECT USING (tenant_id = public.auth_tenant_id());

CREATE TABLE IF NOT EXISTS opportunity_writeback_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  objective_id uuid REFERENCES de_objectives(id) ON DELETE SET NULL,
  op text NOT NULL CHECK (op IN ('log_activity','set_next_step','update_stage')),
  composed jsonb NOT NULL, request_summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','auto_applied','applied','rejected','failed')),
  task_id uuid, result jsonb, created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_opp_writeback_task ON opportunity_writeback_requests(task_id) WHERE task_id IS NOT NULL;
ALTER TABLE opportunity_writeback_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS opp_writeback_tenant_read ON opportunity_writeback_requests;
CREATE POLICY opp_writeback_tenant_read ON opportunity_writeback_requests FOR SELECT USING (tenant_id = public.auth_tenant_id());

CREATE OR REPLACE FUNCTION public.apply_opportunity_writeback_internal(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r opportunity_writeback_requests; v_before text; v_act uuid;
BEGIN
  SELECT * INTO r FROM opportunity_writeback_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF r.status NOT IN ('pending_approval') THEN RETURN jsonb_build_object('ok', false, 'error', 'not_pending', 'status', r.status); END IF;

  IF r.op = 'log_activity' THEN
    INSERT INTO opportunity_activities (tenant_id, opportunity_id, de_id, objective_id, kind, summary, detail)
    VALUES (r.tenant_id, r.opportunity_id, r.de_id, r.objective_id, 'activity_logged', r.composed->>'summary',
            jsonb_build_object('activity_kind', r.composed->>'activity_kind')) RETURNING id INTO v_act;
  ELSIF r.op = 'set_next_step' THEN
    INSERT INTO opportunity_activities (tenant_id, opportunity_id, de_id, objective_id, kind, summary, detail)
    VALUES (r.tenant_id, r.opportunity_id, r.de_id, r.objective_id, 'next_step_set',
            'Next step: ' || (r.composed->>'next_step'), r.composed) RETURNING id INTO v_act;
  ELSIF r.op = 'update_stage' THEN
    SELECT stage INTO v_before FROM opportunities WHERE id = r.opportunity_id AND tenant_id = r.tenant_id;
    UPDATE opportunities SET stage = r.composed->>'to_stage', updated_at = now(),
           stage_history = coalesce(stage_history,'[]'::jsonb) || jsonb_build_object('from', v_before, 'to', r.composed->>'to_stage', 'at', now())
     WHERE id = r.opportunity_id AND tenant_id = r.tenant_id;
    INSERT INTO opportunity_activities (tenant_id, opportunity_id, de_id, objective_id, kind, summary, detail)
    VALUES (r.tenant_id, r.opportunity_id, r.de_id, r.objective_id, 'stage_changed',
            'Stage ' || coalesce(v_before,'?') || ' → ' || (r.composed->>'to_stage'),
            jsonb_build_object('from', v_before, 'to', r.composed->>'to_stage')) RETURNING id INTO v_act;
  END IF;

  UPDATE opportunity_writeback_requests SET status = 'applied', applied_at = now(), result = jsonb_build_object('activity_id', v_act) WHERE id = p_request_id;
  RETURN jsonb_build_object('ok', true, 'activity_id', v_act);
END; $$;

CREATE OR REPLACE FUNCTION public.propose_opportunity_writeback(
  p_de_id uuid, p_objective_id uuid, p_opportunity_id uuid, p_op text, p_params jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_de_name text; v_opp_name text;
  v_destructive boolean; v_label text; v_composed jsonb; v_summary text;
  v_req uuid; v_task uuid; v_decision jsonb;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_op NOT IN ('log_activity','set_next_step','update_stage') THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_op'); END IF;

  SELECT tenant_id, coalesce(persona_name, name) INTO v_tenant, v_de_name FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member'); END IF;

  SELECT coalesce(name, company_name, 'opportunity') INTO v_opp_name FROM opportunities WHERE id = p_opportunity_id AND tenant_id = v_tenant;
  IF v_opp_name IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'opportunity_not_in_tenant'); END IF;

  IF p_op = 'log_activity' THEN
    IF coalesce(p_params->>'summary','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'summary_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('summary', left(p_params->>'summary', 2000), 'activity_kind', coalesce(nullif(left(p_params->>'activity_kind',40),''),'note'));
    v_label := 'Log an activity'; v_summary := 'Log activity on ' || v_opp_name || ': ' || left(p_params->>'summary', 120);
  ELSIF p_op = 'set_next_step' THEN
    IF coalesce(p_params->>'next_step','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'next_step_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('next_step', left(p_params->>'next_step', 500), 'next_step_date', nullif(p_params->>'next_step_date',''));
    v_label := 'Set the next step'; v_summary := 'Set next step on ' || v_opp_name || ': ' || left(p_params->>'next_step', 120);
  ELSIF p_op = 'update_stage' THEN
    -- Anti-hallucination: the target stage must be a REAL configured pipeline stage.
    IF NOT EXISTS (SELECT 1 FROM tenant_pipeline_stages s WHERE s.tenant_id = v_tenant AND s.stage_key = p_params->>'to_stage') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_stage', 'detail', 'to_stage must be an existing pipeline stage_key');
    END IF;
    v_destructive := true;
    v_composed := jsonb_build_object('to_stage', p_params->>'to_stage');
    v_label := 'Change opportunity stage'; v_summary := 'Move ' || v_opp_name || ' to stage "' || (p_params->>'to_stage') || '"';
  END IF;

  SELECT public.decide_action_execution(v_tenant, v_label, 'crm', v_destructive, p_de_id) INTO v_decision;

  INSERT INTO opportunity_writeback_requests (tenant_id, de_id, opportunity_id, objective_id, op, composed, request_summary, status, created_by)
  VALUES (v_tenant, p_de_id, p_opportunity_id, p_objective_id, p_op, v_composed, v_summary, 'pending_approval', auth.uid())
  RETURNING id INTO v_req;

  IF (v_decision->>'decision') = 'auto_executed' THEN
    PERFORM public.apply_opportunity_writeback_internal(v_req);
    UPDATE opportunity_writeback_requests SET status = 'auto_applied', decided_at = now() WHERE id = v_req AND status = 'applied';
    BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de', 'Pipeline write-back APPLIED — ' || v_summary, 'connector_action',
      jsonb_build_object('kind','opportunity_writeback','op',p_op,'request_id',v_req,'opportunity_id',p_opportunity_id,'auto',true));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('ok', true, 'gated', false, 'applied', true, 'request_id', v_req);
  END IF;

  INSERT INTO human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
  VALUES (v_tenant, 'action_approval', 'Approve pipeline write-back — ' || v_label || ' (' || v_opp_name || ')',
          (v_decision->>'reasoning') || ' Preview: ' || v_summary, 'de', 'opportunity_writeback_requests', v_req, 'pending')
  RETURNING id INTO v_task;
  UPDATE opportunity_writeback_requests SET task_id = v_task WHERE id = v_req;

  BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de', 'Pipeline write-back GATED — ' || v_summary || ': ' || (v_decision->>'reasoning'), 'approval',
    jsonb_build_object('kind','opportunity_writeback_gated','op',p_op,'request_id',v_req,'task_id',v_task,'decision',v_decision->>'decision'));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'gated', true, 'task_id', v_task, 'request_id', v_req, 'reasoning', v_decision->>'reasoning');
END; $$;

CREATE OR REPLACE FUNCTION public.resolve_opportunity_writeback(p_task_id uuid, p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r opportunity_writeback_requests; v_res jsonb;
BEGIN
  SELECT * INTO r FROM opportunity_writeback_requests WHERE task_id = p_task_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_request_for_task'); END IF;
  IF r.status <> 'pending_approval' THEN RETURN jsonb_build_object('ok', true, 'already', r.status); END IF;
  IF p_decision = 'approved' THEN
    v_res := public.apply_opportunity_writeback_internal(r.id);
    UPDATE opportunity_writeback_requests SET decided_at = now() WHERE id = r.id;
    BEGIN PERFORM append_audit_event_internal(r.tenant_id, 'You', 'human', 'Pipeline write-back APPROVED + applied — ' || r.request_summary, 'connector_action',
      jsonb_build_object('kind','opportunity_writeback','op',r.op,'request_id',r.id,'approved',true));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('ok', true, 'applied', true);
  ELSE
    UPDATE opportunity_writeback_requests SET status = 'rejected', decided_at = now() WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'applied', false);
  END IF;
END; $$;

REVOKE ALL ON FUNCTION public.propose_opportunity_writeback(uuid,uuid,uuid,text,jsonb) FROM public;
REVOKE ALL ON FUNCTION public.apply_opportunity_writeback_internal(uuid) FROM public;
REVOKE ALL ON FUNCTION public.resolve_opportunity_writeback(uuid,text) FROM public;
GRANT EXECUTE ON FUNCTION public.propose_opportunity_writeback(uuid,uuid,uuid,text,jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_opportunity_writeback(uuid,text) TO authenticated, service_role;

-- 4. SDR archetype kit (pipeline desk) ---------------------------------------
INSERT INTO role_archetypes
  (key, name, domain, description, persona_preamble, responsibilities,
   required_capabilities, required_connector_categories, recommended_model,
   compliance_pack_keys, knowledge_scaffold, eval_category, pass_threshold_pct, status,
   sop_playbook, watcher_templates, guardrail_templates)
VALUES (
  'sdr', 'Sales Development Rep', 'Sales',
  'Works the opportunity pipeline: picks up new and approaching-close opportunities, advances them per the sales SOP, keeps the pipeline record current, and proposes stage changes and outreach for human approval.',
  'You are a sales development rep. You keep the pipeline moving — grounded in the opportunity record, disciplined about next steps, honest about what you do not know, and always proposing stage changes, pricing, and outreach to a human.',
  ARRAY['Pick up new and approaching-close opportunities','Qualify and advance opportunities per the sales motion','Keep the pipeline record current with activities and next steps','Propose stage changes and outreach for human approval','Escalate stalled or high-value deals to the owner'],
  ARRAY['pipeline_management','communication','write_back'],
  ARRAY['crm'],
  'claude-sonnet-5',
  ARRAY[]::text[],
  '{"topics":["Your pipeline stages and what each means","Your qualification criteria","How pricing and discounts get approved"]}'::jsonb,
  'procedure', 80, 'active',
  jsonb_build_object(
    'name','Sales Development SOP',
    'description','Standard operating procedure for advancing an opportunity through the pipeline.',
    'steps', jsonb_build_array(
      jsonb_build_object('key','instruction','label','Understand the opportunity','params',jsonb_build_object('body_md','Pull the opportunity name, stage, amount, close date, and recent activity before acting. Never assume facts you cannot see on the record — if key details are missing, escalate for a human to supply them rather than guessing.')),
      jsonb_build_object('key','instruction','label','Assess where it stands','params',jsonb_build_object('body_md','Judge whether the opportunity is progressing or stalling: is it moving between stages, is the close date near, is there recent activity? Weigh the amount and days-to-close to set urgency.')),
      jsonb_build_object('key','checklist','label','Run the pipeline motion','params',jsonb_build_object('items', jsonb_build_array('Confirm the stage and close date','Log the current status as an activity on the opportunity','Set a clear next step with a date','Prepare any prospect outreach as a draft for human approval — do not send email yourself','If a stage change is warranted, propose it for human approval','If the deal is stalled or high-value, flag the owner'))),
      jsonb_build_object('key','instruction','label','Stay within your authority','params',jsonb_build_object('body_md','You may log activity, set next steps, and propose an opportunity stage change — every change is submitted for human approval, never applied silently. You may NOT commit to discounts, pricing, or contract terms; those are always proposed to a human. Never invent amounts, close dates, or prospect facts.')),
      jsonb_build_object('key','instruction','label','Close the loop','params',jsonb_build_object('body_md','The job is not done until the pipeline record reflects it. Write back the activity and the next step, and if you are waiting on the prospect, schedule a follow-up rather than letting the deal go cold.'))
    )
  ),
  jsonb_build_array(
    jsonb_build_object('kind','date_horizon','label','Opportunity closing soon (30/14/7 day)','description','Pick up an opportunity as its close date approaches.','config',jsonb_build_object('source','opportunities','date_field','close_date','horizons_days', jsonb_build_array(30,14,7))),
    jsonb_build_object('kind','state_condition','label','New opportunity to work','description','Pick up an opportunity that enters the new stage.','config',jsonb_build_object('source','opportunities','field','stage','op','eq','value','new'))
  ),
  jsonb_build_array(
    jsonb_build_object('rule','Discounts require human approval','rule_type','max_discount_pct','threshold','0','severity','blocking'),
    jsonb_build_object('rule','No pricing, discount, or contract commitments in writing','rule_type','blocked_phrase','pattern','we can offer|discount of|reduce the price|special pricing|waive the|lock in the rate|new price will be|best and final','severity','blocking'),
    jsonb_build_object('rule','Deals over $25,000 require human approval','rule_type','require_approval_over_cents','threshold','2500000','severity','blocking')
  )
)
ON CONFLICT (key) DO UPDATE SET
  sop_playbook = excluded.sop_playbook, watcher_templates = excluded.watcher_templates,
  guardrail_templates = excluded.guardrail_templates, persona_preamble = excluded.persona_preamble,
  responsibilities = excluded.responsibilities, status = 'active';
