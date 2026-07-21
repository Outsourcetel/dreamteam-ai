-- 226_continuity_engine_and_kit.sql
-- ============================================================================
-- EXEC-2c (part 2) — teach the SAME employee to work the commercial world.
--
-- Mig 225 added the spine (agreements + typed case facet on de_objectives).
-- This migration makes the renewal_manager actually USE it, IN PLACE:
--
--   1. The Book of Work learns a THIRD date_horizon source — commercial_agreements
--      — with a CONFIGURABLE date_field. This is the whole point: a case can open
--      off the notice_deadline, the warranty_expiry, or the next_reorder_date, not
--      just one renewal date. Each opened case is stamped with its MOTION (renew /
--      reorder / replace / renegotiate …) via a continuity_cases facet.
--
--   2. renewal_manager's SOP + watchers are UPGRADED in place (same archetype key,
--      same employee) to be motion-aware and agreement-aware.
--
-- EXTEND-DON'T-KILL GUARANTEE: the customer_accounts and opportunities branches of
-- run_work_watchers/validate_work_watcher are reproduced byte-for-byte from the
-- current (mig 220) definition; only a commercial_agreements branch is ADDED. No
-- other desk (CS, SDR, Billing, Accounting) changes. read_de_system and
-- propose_system_writeback are deliberately untouched (they carry Billing/Accounting
-- wiring); the case's own gated write-back registry ships separately in mig 227.
-- GLOBAL — every tenant.
-- ============================================================================

-- 1. Validator: allow commercial_agreements as a date_horizon source ----------
--    (customer_accounts + opportunities clauses identical to mig 220.)
CREATE OR REPLACE FUNCTION public.validate_work_watcher()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c jsonb := NEW.config; src text := coalesce(NEW.config->>'source','customer_accounts');
BEGIN
  IF NEW.kind = 'date_horizon' THEN
    IF src NOT IN ('customer_accounts','opportunities','commercial_agreements') THEN
      RAISE EXCEPTION 'date_horizon supports source customer_accounts, opportunities or commercial_agreements';
    END IF;
    IF src = 'customer_accounts' AND coalesce(c->>'date_field','renewal_date') <> 'renewal_date' THEN
      RAISE EXCEPTION 'date_horizon on customer_accounts supports date_field renewal_date only';
    END IF;
    IF src = 'opportunities' AND coalesce(c->>'date_field','close_date') <> 'close_date' THEN
      RAISE EXCEPTION 'date_horizon on opportunities supports date_field close_date only';
    END IF;
    IF src = 'commercial_agreements' AND coalesce(c->>'date_field','renewal_date') NOT IN
         ('renewal_date','notice_deadline','warranty_expiry','next_reorder_date',
          'cancellation_deadline','pricing_notice_deadline','replacement_date') THEN
      RAISE EXCEPTION 'date_horizon on commercial_agreements date_field must be one of renewal_date, notice_deadline, warranty_expiry, next_reorder_date, cancellation_deadline, pricing_notice_deadline, replacement_date';
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

-- 2. Runner: ADD a commercial_agreements date_horizon branch -------------------
--    Every pre-existing branch is byte-for-byte the mig 220 logic.
CREATE OR REPLACE FUNCTION public.run_work_watchers(p_tenant_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  w work_watchers; v_new integer; v_total integer := 0; v_watchers integer := 0;
  v_obj_id uuid; v_inserted boolean; r record; v_h integer; v_occ text;
  v_title text; v_de_name text; v_src text; v_date_field text; v_motion text;
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

    -- ── NEW: date_horizon on commercial_agreements (configurable date_field) ──
    -- Opens a de_objectives case AND its typed continuity_cases facet, stamped
    -- with the motion (explicit config override, else derived from the date_field).
    ELSIF w.kind = 'date_horizon' AND v_src = 'commercial_agreements' THEN
      v_date_field := coalesce(w.config->>'date_field','renewal_date');
      FOR r IN
        SELECT sub.* FROM (
          SELECT a.id, coalesce(a.counterparty_name, a.title) AS name, a.account_id, a.party_side,
                 a.baseline_value_cents, a.status, a.agreement_type,
                 (CASE v_date_field
                    WHEN 'renewal_date'            THEN a.renewal_date
                    WHEN 'notice_deadline'         THEN a.notice_deadline
                    WHEN 'warranty_expiry'         THEN a.warranty_expiry
                    WHEN 'next_reorder_date'       THEN a.next_reorder_date
                    WHEN 'cancellation_deadline'   THEN a.cancellation_deadline
                    WHEN 'pricing_notice_deadline' THEN a.pricing_notice_deadline
                    WHEN 'replacement_date'        THEN a.replacement_date
                    ELSE a.renewal_date END) AS target_date
          FROM commercial_agreements a
          WHERE a.tenant_id = w.tenant_id
            AND (w.config->'status_filter' IS NULL OR a.status IN (SELECT jsonb_array_elements_text(w.config->'status_filter')))
        ) sub
        WHERE sub.target_date IS NOT NULL AND sub.target_date >= current_date
      LOOP
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days','[90,60,30]'::jsonb)))::int AS h) hs WHERE h >= (r.target_date - current_date);
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := r.id::text || '|' || v_date_field || '|' || r.target_date::text || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;

        v_motion := coalesce(nullif(w.config->>'motion',''),
          CASE v_date_field
            WHEN 'renewal_date'            THEN 'renew'
            WHEN 'notice_deadline'         THEN 'renew'
            WHEN 'warranty_expiry'         THEN 'replace'
            WHEN 'next_reorder_date'       THEN 'reorder'
            WHEN 'replacement_date'        THEN 'replace'
            WHEN 'cancellation_deadline'   THEN 'renew'
            WHEN 'pricing_notice_deadline' THEN 'renegotiate'
            ELSE 'renew' END);

        v_title := w.label || ' — ' || r.name || ' (' || v_h || '-day, ' || v_date_field || ' ' || to_char(r.target_date, 'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' — ' || v_motion || ' motion. The ' || replace(v_date_field,'_',' ')
            || ' is ' || r.target_date::text || ' (' || (r.target_date - current_date) || ' days out). Work the ' || v_h || '-day motion per the playbook.',
          'commercial_agreement', r.id::text, 'open', v_h, r.target_date::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'horizon_days',v_h,'motion',v_motion,'date_field',v_date_field,
            'subject', jsonb_build_object('name', r.name, 'agreement_type', r.agreement_type, 'party_side', r.party_side,
              'target_date', r.target_date, 'baseline_value_cents', r.baseline_value_cents))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;

        -- The typed facet: exactly one per case, driven off the SAME objective.
        INSERT INTO continuity_cases (objective_id, tenant_id, de_id, agreement_id, account_id, motion, stage_key, party_side, baseline_cents)
        VALUES (v_obj_id, w.tenant_id, w.de_id, r.id, r.account_id, v_motion, 'discovered', coalesce(r.party_side,'sell'), r.baseline_value_cents)
        ON CONFLICT (objective_id) DO NOTHING;
        INSERT INTO continuity_case_events (tenant_id, objective_id, to_stage, motion, actor_kind, summary, detail)
        VALUES (w.tenant_id, v_obj_id, 'discovered', v_motion, 'system',
          'Case opened by Book of Work — ' || v_motion || ' on ' || r.name || ' (' || replace(v_date_field,'_',' ') || ')',
          jsonb_build_object('watcher_id', w.id, 'date_field', v_date_field, 'horizon_days', v_h));
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

    -- ── metric_threshold (unchanged from mig 220) ──
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

    -- ── schedule (unchanged from mig 220) ──
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

-- 3. Upgrade the renewal_manager kit IN PLACE (same archetype key) ------------
-- Broadens the SOP to be motion-aware and ADDS an agreement notice-window
-- watcher. The two existing watchers (customer_accounts renewal_date + health)
-- are preserved verbatim so re-stamping never duplicates them.
UPDATE role_archetypes SET
  description = 'Works commercial continuity end-to-end — customer renewals and vendor agreements alike. Watches renewal, notice, warranty and reorder dates; opens a case with the right motion (renew, reorder, replace, renegotiate…); follows the continuity SOP; keeps the record current; and proposes money and contract decisions for human approval.',
  responsibilities = ARRAY[
    'Watch renewal, notice, warranty and reorder dates across agreements and accounts',
    'Open a continuity case with the correct motion and assess its risk',
    'Keep the account and agreement record current with activities and next steps',
    'Propose status changes and customer or vendor outreach for human approval',
    'Escalate high-value, contentious, or non-standard cases to the owner'],
  sop_playbook = jsonb_build_object(
    'name','Commercial Continuity SOP',
    'description','Standard operating procedure for working any commercial-continuity case — renewal, extension, reorder, replacement, renegotiation or termination — from early warning through outcome.',
    'steps', jsonb_build_array(
      jsonb_build_object('key','instruction','label','Understand the case and its motion','params',jsonb_build_object('body_md','Read the case: what is the motion (renew, extend, reorder, replace, renegotiate, terminate…), which agreement or account is it about, and which date triggered it (renewal, notice, warranty or reorder)? Pull the baseline value, the relevant dates, status, and recent activity before acting. Never assume facts you cannot see on the record — if key details are missing, escalate for a human to supply them rather than guessing.')),
      jsonb_build_object('key','instruction','label','Assess continuity risk','params',jsonb_build_object('body_md','Judge risk from what the record shows: an approaching notice deadline, a low health score or at-risk status, no reply to outreach, dropping usage, or an asset at end-of-life. Weigh the value and days-to-deadline to set urgency — high-value or under-30-day cases come first. Remember a notice deadline is not the end date; act before the window closes.')),
      jsonb_build_object('key','checklist','label','Run the motion','params',jsonb_build_object('items', jsonb_build_array(
        'Confirm the motion and the driving date, and which horizon applies (90/60/30 day)',
        'Log the current continuity status as an activity on the record',
        'Set a clear next step with a date',
        'If the case is at risk, high-value or non-standard, flag it for the owner',
        'Prepare any customer or vendor outreach as a draft for human approval — do not send email yourself'))),
      jsonb_build_object('key','instruction','label','Stay within your authority','params',jsonb_build_object('body_md','You may log activity, set next steps, and propose a status or stage change — every change is submitted for human approval, never applied silently. You may NOT commit to discounts, pricing, contract terms, terminations, refunds or supplier switches; those are always proposed to a human. Never invent contact details, prices, dates, or record facts.')),
      jsonb_build_object('key','instruction','label','Close the loop','params',jsonb_build_object('body_md','The case is not done until the record reflects it. Write back the outcome and the next touch date, and if you are blocked waiting on a person or a reply, schedule a follow-up rather than leaving the case open-ended.'))
    )
  ),
  watcher_templates = jsonb_build_array(
    -- existing two — preserved verbatim (matched by kind+label on re-stamp)
    jsonb_build_object('kind','date_horizon','label','Renewal approaching (90/60/30 day)','description','Open a renewal case as each notice window is reached.','config',jsonb_build_object('horizons_days', jsonb_build_array(90,60,30),'status_filter', jsonb_build_array('active','at_risk'))),
    jsonb_build_object('kind','state_condition','label','Account health dropped below 50','description','Open a save case when an account turns at-risk by health.','config',jsonb_build_object('field','health_score','op','lt','value',50)),
    -- NEW — agreement notice-window watcher (motion-aware, independent date)
    jsonb_build_object('kind','date_horizon','label','Contract notice window approaching (90/60/30 day)','description','Open a renewal case off an agreement''s notice deadline — before the window closes.','config',jsonb_build_object('source','commercial_agreements','date_field','notice_deadline','motion','renew','horizons_days', jsonb_build_array(90,60,30),'status_filter', jsonb_build_array('active','pending')))
  )
WHERE key = 'renewal_manager';

-- 4. Re-stamp existing renewal DEs so they pick up the new watcher ------------
-- install_role_kit is idempotent: it skips the two watchers already present
-- (by kind+label) and inserts only the new agreement watcher; it also re-publishes
-- the upgraded SOP. Same pattern mig 221 used to roll desks onto live DEs.
DO $$
DECLARE d record;
BEGIN
  FOR d IN
    SELECT de.id FROM digital_employees de
    JOIN role_archetypes ra ON ra.key = 'renewal_manager'
    WHERE EXISTS (
      SELECT 1 FROM work_watchers ww
      WHERE ww.de_id = de.id AND ww.label = 'Renewal approaching (90/60/30 day)')
  LOOP
    BEGIN
      PERFORM public.install_role_kit(d.id, 'renewal_manager');
    EXCEPTION WHEN OTHERS THEN
      -- never fail the migration on one DE; the archetype is upgraded regardless
      RAISE NOTICE 'install_role_kit skipped for DE %: %', d.id, SQLERRM;
    END;
  END LOOP;
END $$;
