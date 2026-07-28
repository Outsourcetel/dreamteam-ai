-- 518_a_response_window_you_can_actually_set.sql
-- ============================================================================
-- Migration 515 gave a watcher a response window, but only as WHOLE DAYS
-- (config->>'response_days'). That is too coarse to be a real service standard:
-- a support-shaped condition is answered in minutes, an at-risk account in
-- hours, and some work is due by a fixed calendar date that has nothing to do
-- with when the case opened.
--
-- A response window is now set in MINUTES, HOURS, DAYS, or as a SPECIFIC DATE:
--
--   {"response_window": {"unit": "minutes", "amount": 30}}
--   {"response_window": {"unit": "hours",   "amount": 4}}
--   {"response_window": {"unit": "days",    "amount": 3}}
--   {"response_window": {"unit": "date",    "at": "2026-08-15T17:00:00+05:00"}}
--
-- Amount and unit are stored exactly as the operator declared them. "4 hours"
-- is NOT silently normalised to 240 minutes, so it reads back as what was
-- meant. A specific date is absolute — the same instant for every case the
-- watcher opens, which is what "everything reviewed before the audit" means.
--
-- ── WHAT 515 MISSED ────────────────────────────────────────────────────────
-- 515 patched two state_condition branches and asserted it expected two. Two
-- was simply what it had found — the function actually has NINE objective
-- INSERTs, and THREE still stamped no deadline at all:
--   · state_condition on any source other than accounts/opportunities
--   · metric_threshold  (a KPI crossing a line)
--   · schedule          (every recurring sweep)
-- All four goals in this tenant that still lacked a deadline were schedule
-- sweeps. This migration counts the branches from the function body and refuses
-- to apply if any INSERT is left without the column.
--
-- ── ONE IMPLEMENTATION, NOT SIX ────────────────────────────────────────────
-- response_window_due_at(config, from) is the single place a deadline is
-- computed, and every branch calls it — including the two 515 had computed
-- inline. Six copies of one rule is how the priority column ended up meaning
-- two different things.
--
-- ── REFUSED ON PURPOSE ─────────────────────────────────────────────────────
-- A date_horizon watcher may NOT carry a response window: it already has a
-- deadline, the date it counts down to, and two competing deadlines have no
-- honest resolution. The validator says so in plain language.
--
-- ── DEFAULTS ARE DERIVED, NOT INVENTED ─────────────────────────────────────
-- Existing response_days values are carried across unchanged as {days, N}.
-- Schedule watchers had no window at all and now get one derived from THEIR OWN
-- cadence — a daily sweep is due within a day, a weekly within a week — on the
-- reasoning that a recurring sweep should be finished before the next one
-- opens. Nothing here is a number the system made up about your business.
--
-- Reproduced from the LIVE definitions. PRESERVED: the per-watcher EXCEPTION
-- ... CONTINUE wrapper, every occurrence_key format, ON CONFLICT DO NOTHING,
-- tenant_is_operational (mig 430), and every existing validator rule.
-- ============================================================================

-- ── take the table before the cron does ─────────────────────────────────────
-- First attempt at this migration DEADLOCKED against the live 5-minute watcher
-- tick, which updates last_run_at / next_fire_at on the very rows rewritten
-- below. Claiming the table up front makes a cycle impossible: the tick either
-- finishes before this starts, or waits for it. The whole migration is one
-- transaction and takes well under a second, so the tick is never starved.
SET LOCAL lock_timeout = '30s';
LOCK TABLE public.work_watchers IN SHARE ROW EXCLUSIVE MODE;

-- ── the one place a deadline is computed ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.response_window_due_at(p_config jsonb, p_from timestamptz)
 RETURNS timestamptz
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $fn$
DECLARE w jsonb; u text; a text;
BEGIN
  w := p_config -> 'response_window';
  IF w IS NOT NULL AND jsonb_typeof(w) = 'object' THEN
    u := w->>'unit'; a := w->>'amount';

    -- A specific calendar instant: absolute, identical for every case this
    -- watcher opens. If it has already passed, the case opens overdue — which
    -- is the honest reading, because by the declared standard it IS late.
    IF u = 'date' THEN
      BEGIN
        RETURN (w->>'at')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
      END;

    -- A duration, measured from the moment the case opened.
    ELSIF u IN ('minutes','hours','days') AND a ~ '^[0-9]{1,9}$' AND a::int > 0 THEN
      RETURN CASE u
        WHEN 'minutes' THEN p_from + make_interval(mins  => least(a::int, 5256000))
        WHEN 'hours'   THEN p_from + make_interval(hours => least(a::int, 87600))
        ELSE                p_from + make_interval(days  => least(a::int, 3650))
      END;
    END IF;
    RETURN NULL;
  END IF;

  -- Legacy shape from mig 515. Nothing outside migrations ever read it, and the
  -- rewrite below clears it, but a tenant restored from an older dump must not
  -- silently lose its declared standard.
  IF (p_config->>'response_days') ~ '^[0-9]{1,9}$' AND (p_config->>'response_days')::int > 0 THEN
    RETURN p_from + make_interval(days => least((p_config->>'response_days')::int, 3650));
  END IF;

  RETURN NULL;
END $fn$;

COMMENT ON FUNCTION public.response_window_due_at(jsonb, timestamptz) IS
  'The single place a response window becomes a deadline. Reads config->response_window as {unit: minutes|hours|days, amount: N} or {unit: date, at: <timestamp>}. Returns NULL when no standard has been declared — never a guessed date.';

CREATE OR REPLACE FUNCTION public.run_work_watchers(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  w work_watchers; v_new integer; v_total integer := 0; v_watchers integer := 0;
  v_obj_id uuid; v_inserted boolean; r record; v_h integer; v_occ text;
  v_title text; v_de_name text; v_src text; v_date_field text; v_motion text;
  v_cat watch_source_catalog; v_row jsonb; v_id text; v_where text; v_sql text;
  v_field text; v_op text; v_vt text; v_cast text; v_datef text; v_label text; v_subject jsonb; v_cap int;
BEGIN
  FOR w IN SELECT * FROM work_watchers WHERE active AND kind <> 'inbox'
      AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id)
      AND tenant_is_operational(tenant_id) ORDER BY created_at
  LOOP
    v_new := 0; v_watchers := v_watchers + 1;
    v_src := coalesce(w.config->>'source','customer_accounts');
    SELECT coalesce(persona_name, name) INTO v_de_name FROM digital_employees WHERE id = w.de_id;

    BEGIN
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
          'customer_account', r.id::text, 'open', (case when v_h <= 14 then 1 when v_h <= 30 then 2 when v_h <= 60 then 3 else 4 end), r.renewal_date::timestamptz,
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
          'opportunity', r.id::text, 'open', (case when v_h <= 14 then 1 when v_h <= 30 then 2 when v_h <= 60 then 3 else 4 end), r.close_date::timestamptz,
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
          'commercial_agreement', r.id::text, 'open', (case when v_h <= 14 then 1 when v_h <= 30 then 2 when v_h <= 60 then 3 else 4 end), r.target_date::timestamptz,
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


    -- GENERIC date_horizon (catalog-driven; any non-legacy source)
    ELSIF w.kind = 'date_horizon' THEN
      SELECT * INTO v_cat FROM watch_source_catalog WHERE source_key = v_src AND active AND NOT legacy_bespoke;
      IF v_cat.source_key IS NULL THEN CONTINUE; END IF;
      v_datef := coalesce(w.config->>'date_field',
                   (SELECT column_name FROM watch_source_fields WHERE source_key = v_src AND role='date' ORDER BY column_name LIMIT 1));
      IF v_datef IS NULL OR NOT EXISTS (SELECT 1 FROM watch_source_fields WHERE source_key=v_src AND role='date' AND column_name=v_datef) THEN CONTINUE; END IF;
      v_cap := least(coalesce((w.config->>'max_per_run')::int, 1000), 1000);
      v_where := format('%I = $1 AND %I IS NOT NULL AND %I >= current_date', v_cat.tenant_column, v_datef, v_datef)
                 || build_base_predicates(v_cat.base_predicates)
                 || format(' AND ($2::text[] IS NULL OR %I = ANY($2))', v_cat.status_column);
      v_sql := format('SELECT %I::text AS _id, to_jsonb(t.*) AS _row FROM %I t WHERE %s ORDER BY %I LIMIT %s',
                      v_cat.id_column, v_cat.table_name, v_where, v_datef, v_cap);
      FOR r IN EXECUTE v_sql USING w.tenant_id,
                 CASE WHEN w.config ? 'status_filter' THEN ARRAY(SELECT jsonb_array_elements_text(w.config->'status_filter')) ELSE NULL::text[] END
      LOOP
        v_row := r._row; v_id := r._id;
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days', v_cat.default_horizons)))::int AS h) hs WHERE h >= ((v_row->>v_datef)::date - current_date);
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := v_id || '|' || v_datef || '|' || (v_row->>v_datef) || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, v_id, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_label := watcher_label(v_cat.label_columns, v_row, v_cat.entity_kind, v_id);
        v_subject := jsonb_object_agg_subset(v_row, v_cat.subject_columns);
        v_title := w.label || ' — ' || v_label || ' (' || v_h || '-day, ' || replace(v_datef,'_',' ') || ' ' || to_char((v_row->>v_datef)::date,'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title,200),
          'Opened by the Book of Work: ' || v_label || ' — ' || replace(v_datef,'_',' ') || ' is ' || (v_row->>v_datef) || ' (' || (((v_row->>v_datef)::date - current_date)) || ' days out). Work the ' || v_h || '-day motion per the playbook.',
          v_cat.entity_kind, v_id, 'open', (case when v_h <= 14 then 1 when v_h <= 30 then 2 when v_h <= 60 then 3 else 4 end), (v_row->>v_datef)::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'watch_source',v_src,'date_field',v_datef,'horizon_days',v_h,'subject', v_subject))
        RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id=v_obj_id WHERE watcher_id=w.id AND occurrence_key=v_occ;
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
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' matched "' || (w.config->>'field') || ' ' || (w.config->>'op') || ' ' || (w.config->>'value') || '". Assess and work per the playbook.',
          'customer_account', r.id::text, 'open', 2,
          response_window_due_at(w.config, now()),
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
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: opportunity ' || r.name || ' matched "' || (w.config->>'field') || ' ' || (w.config->>'op') || ' ' || (w.config->>'value') || '". Advance it per the playbook.',
          'opportunity', r.id::text, 'open', 2,
          response_window_due_at(w.config, now()),
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'condition', w.config,
            'subject', jsonb_build_object('name', r.name, 'stage', r.stage, 'amount_cents', r.amount_cents, 'close_date', r.close_date))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;


    -- GENERIC state_condition (catalog-driven; any non-legacy source)
    ELSIF w.kind = 'state_condition' THEN
      SELECT * INTO v_cat FROM watch_source_catalog WHERE source_key = v_src AND active AND NOT legacy_bespoke;
      IF v_cat.source_key IS NULL THEN CONTINUE; END IF;
      v_field := w.config->>'field'; v_op := w.config->>'op';
      SELECT value_type INTO v_vt FROM watch_source_fields WHERE source_key=v_src AND role='state' AND column_name=v_field AND v_op = ANY (allowed_ops);
      IF v_vt IS NULL THEN CONTINUE; END IF;
      v_cast := CASE WHEN v_vt = 'numeric' THEN '::numeric' ELSE '' END;
      v_where := format('%I = $1', v_cat.tenant_column) || build_base_predicates(v_cat.base_predicates)
                 || format(' AND %I %s $2%s', v_field, sql_op(v_op), v_cast)
                 || format(' AND NOT EXISTS (SELECT 1 FROM work_watcher_matches m WHERE m.watcher_id = $3 AND m.subject_ref = t.%I::text)', v_cat.id_column);
      v_sql := format('SELECT %I::text AS _id, to_jsonb(t.*) AS _row FROM %I t WHERE %s', v_cat.id_column, v_cat.table_name, v_where);
      FOR r IN EXECUTE v_sql USING w.tenant_id, (w.config->>'value'), w.id
      LOOP
        v_row := r._row; v_id := r._id;
        v_occ := v_id || '|' || v_field || v_op || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, v_id, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_label := watcher_label(v_cat.label_columns, v_row, v_cat.entity_kind, v_id);
        v_subject := jsonb_object_agg_subset(v_row, v_cat.subject_columns);
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(w.label || ' — ' || v_label,200),
          'Opened by the Book of Work: ' || v_label || ' matched "' || v_field || ' ' || v_op || ' ' || (w.config->>'value') || '". Assess and work per the playbook.',
          v_cat.entity_kind, v_id, 'open', 2,
          response_window_due_at(w.config, now()),
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'watch_source',v_src,'condition',w.config,'subject', v_subject))
        RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id=v_obj_id WHERE watcher_id=w.id AND occurrence_key=v_occ;
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
          INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
          VALUES (w.tenant_id, w.de_id, left(w.label || ' — ' || r.mkey || ' at ' || r.value, 200),
            'Opened by the Book of Work: metric "' || r.mkey || '" read ' || r.value || ' on ' || r.as_of || ', crossing the ' || (w.config->>'op') || ' ' || (w.config->>'value') || ' line. Investigate per the playbook.',
            'metric', r.mkey, 'open', 2,
            response_window_due_at(w.config, now()),
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
          INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
          VALUES (w.tenant_id, w.de_id, left(w.label, 200),
            'Opened by the Book of Work on schedule (' || coalesce(w.description, w.label) || '). Run the recurring motion per the playbook.',
            'schedule', v_occ, 'open', 3, response_window_due_at(w.config, now()), jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'fired_at', now())
          ) RETURNING id INTO v_obj_id;
          UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
          v_new := v_new + 1;
        END IF;
        UPDATE work_watchers SET next_fire_at = now() + make_interval(mins => (w.config->>'interval_minutes')::int) WHERE id = w.id;
      END IF;
    END IF;
    EXCEPTION WHEN OTHERS THEN
      BEGIN PERFORM append_audit_event_internal(w.tenant_id, 'system', 'system',
        'Book of Work watcher "' || w.label || '" errored and was skipped this tick', 'playbook_step',
        jsonb_build_object('kind','book_of_work_error','watcher_id', w.id, 'error', SQLERRM));
      EXCEPTION WHEN OTHERS THEN NULL; END;
      CONTINUE;
    END;

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
END; $function$
;

CREATE OR REPLACE FUNCTION public.validate_watcher_config(p_kind text, p_config jsonb, p_tenant_id uuid, p_de_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c    jsonb := coalesce(p_config, '{}'::jsonb);
  src  text  := coalesce(p_config->>'source', 'customer_accounts');
  s    watch_source_catalog;
  f    watch_source_fields;
  v_op text := coalesce(c->>'op', '');
  v_datef text;
  v_grant_ok boolean;
  v_rw jsonb; v_ru text; v_ra text;
BEGIN
  -- ── the response window: a DECLARED service standard ──────────────────────
  -- Settable on any watcher that opens a case from a condition, in minutes,
  -- hours, days, or as a specific calendar date. Refused at write time when
  -- malformed, because a typo would otherwise silently mean "no deadline" —
  -- which reads identically to "nobody has declared one", and telling those two
  -- apart is the entire point of the field.
  IF c ? 'response_window' THEN
    v_rw := c->'response_window';
    IF jsonb_typeof(v_rw) <> 'object' THEN
      RETURN 'Set a response window as an amount and a unit, or as a specific date.';
    END IF;
    v_ru := v_rw->>'unit'; v_ra := v_rw->>'amount';

    -- A date watcher already HAS a deadline: the date it counts down to. A
    -- second one would compete with it, and there is no honest way to say which
    -- of two deadlines is the real one.
    IF p_kind = 'date_horizon' THEN
      RETURN 'This watcher already has a deadline — the date it counts down to.';
    END IF;

    IF v_ru = 'date' THEN
      IF v_rw->>'at' IS NULL THEN
        RETURN 'Pick the date this has to be handled by.';
      END IF;
      BEGIN
        PERFORM (v_rw->>'at')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        RETURN 'That deadline is not a real date.';
      END;
    ELSIF v_ru IN ('minutes','hours','days') THEN
      IF v_ra IS NULL OR v_ra !~ '^[0-9]{1,9}$' OR v_ra::bigint < 1 THEN
        RETURN format('Respond within how many %s? Give a whole number above zero.', v_ru);
      END IF;
      IF (v_ru = 'minutes' AND v_ra::bigint > 5256000)
      OR (v_ru = 'hours'   AND v_ra::bigint > 87600)
      OR (v_ru = 'days'    AND v_ra::bigint > 3650) THEN
        RETURN 'A response window longer than ten years is not a deadline.';
      END IF;
    ELSE
      RETURN 'A response window is set in minutes, hours, days, or by a specific date.';
    END IF;
  END IF;

  IF p_kind IN ('date_horizon','state_condition') THEN
    SELECT * INTO s FROM watch_source_catalog WHERE source_key = src AND active;
    IF s.source_key IS NULL THEN
      RETURN format('There is no watchable source called "%s" here.', src);
    END IF;
    IF NOT (p_kind = ANY (s.supports_kinds)) THEN
      RETURN format('"%s" can''t be watched by %s.', src, replace(p_kind, '_', ' '));
    END IF;

    IF p_kind = 'date_horizon' THEN
      v_datef := coalesce(c->>'date_field',
                   (SELECT column_name FROM watch_source_fields
                     WHERE source_key = src AND role = 'date' ORDER BY column_name LIMIT 1));
      IF v_datef IS NULL OR NOT EXISTS (
           SELECT 1 FROM watch_source_fields
            WHERE source_key = src AND role = 'date' AND column_name = v_datef) THEN
        RETURN format('"%s" isn''t a date we can count down to on %s.',
                      coalesce(c->>'date_field', '(none)'), src);
      END IF;
      IF c ? 'horizons_days' AND jsonb_typeof(c->'horizons_days') <> 'array' THEN
        RETURN 'Reminder windows must be a list like [90, 60, 30].';
      END IF;

    ELSE  -- state_condition
      SELECT * INTO f FROM watch_source_fields
        WHERE source_key = src AND role = 'state' AND column_name = c->>'field';
      IF f.column_name IS NULL THEN
        RETURN format('"%s" isn''t a state we can watch on %s.',
                      coalesce(c->>'field', '(none)'), src);
      END IF;
      IF NOT (v_op = ANY (f.allowed_ops)) THEN
        RETURN format('"%s" can''t be compared with "%s".', f.column_name, v_op);
      END IF;
      IF c->>'value' IS NULL THEN RETURN 'This condition needs a value.'; END IF;
      IF f.value_type = 'numeric' AND (c->>'value') !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        RETURN format('"%s" needs a number.', f.column_name);
      END IF;
    END IF;

    IF s.require_domain_grant THEN
      SELECT EXISTS (SELECT 1 FROM data_access_grants g
                      WHERE g.tenant_id = p_tenant_id AND g.subject_kind = 'de'
                        AND g.subject_id = p_de_id
                        AND g.resource_category = s.domain_category)
        INTO v_grant_ok;
      IF NOT v_grant_ok THEN
        RETURN format('This employee isn''t cleared to work %s.',
                      coalesce(s.domain_category, src));
      END IF;
    END IF;

  ELSIF p_kind = 'metric_threshold' THEN
    IF c->>'metric_key' IS NULL THEN RETURN 'A metric watcher needs a metric.'; END IF;
    IF NOT (v_op IN ('lt','gt'))  THEN RETURN 'A metric watcher uses above/below only.'; END IF;
    IF c->>'value' IS NULL        THEN RETURN 'A metric watcher needs a threshold.'; END IF;
  ELSIF p_kind = 'schedule' THEN
    IF coalesce((c->>'interval_minutes')::int, 0) < 60 THEN
      RETURN 'A recurring schedule must run at least hourly.';
    END IF;
  ELSE
    RETURN format('"%s" isn''t an installable watcher kind.', p_kind);
  END IF;
  RETURN NULL;
END $function$
;

notify pgrst, 'reload schema';

-- ── carry the declared standards across, unchanged in meaning ───────────────
UPDATE public.work_watchers
   SET config = (config - 'response_days'::text)
              || jsonb_build_object('response_window',
                   jsonb_build_object('unit', 'days', 'amount', (config->>'response_days')::int))
 WHERE config ? 'response_days'
   AND (config->>'response_days') ~ '^[0-9]{1,9}$'
   AND (config->>'response_days')::int > 0;

UPDATE public.role_archetypes a
   SET watcher_templates = (
     SELECT jsonb_agg(
       CASE WHEN t->'config' ? 'response_days'
             AND (t->'config'->>'response_days') ~ '^[0-9]{1,9}$'
            -- The inner parens are load-bearing: binary '-' binds TIGHTER than
            -- '->' in Postgres, so without them this reads as
            -- t -> ('config' - 'response_days') and dies parsing "config" as JSON.
            THEN jsonb_set(t, '{config}'::text[],
                   ((t->'config') - 'response_days'::text)
                   || jsonb_build_object('response_window',
                        jsonb_build_object('unit','days','amount',(t->'config'->>'response_days')::int)))
            ELSE t END)
       FROM jsonb_array_elements(a.watcher_templates) t)
 WHERE a.watcher_templates IS NOT NULL
   AND jsonb_typeof(a.watcher_templates) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.watcher_templates) t
                WHERE t->'config' ? 'response_days');

-- ── a recurring sweep is due before the next one opens ──────────────────────
-- Derived from the watcher's OWN cadence, normalised to the largest exact unit
-- so it reads back as "1 day" rather than "1440 minutes".
UPDATE public.work_watchers
   SET config = config || jsonb_build_object('response_window',
         CASE WHEN (config->>'interval_minutes')::int % 1440 = 0
                THEN jsonb_build_object('unit','days',   'amount',(config->>'interval_minutes')::int / 1440)
              WHEN (config->>'interval_minutes')::int % 60 = 0
                THEN jsonb_build_object('unit','hours',  'amount',(config->>'interval_minutes')::int / 60)
              ELSE jsonb_build_object('unit','minutes','amount',(config->>'interval_minutes')::int)
         END)
 WHERE kind = 'schedule'
   AND NOT (config ? 'response_window')
   AND (config->>'interval_minutes') ~ '^[0-9]{1,9}$'
   AND (config->>'interval_minutes')::int > 0;

UPDATE public.role_archetypes a
   SET watcher_templates = (
     SELECT jsonb_agg(
       CASE WHEN t->>'kind' = 'schedule'
             AND NOT (t->'config' ? 'response_window')
             AND (t->'config'->>'interval_minutes') ~ '^[0-9]{1,9}$'
            THEN jsonb_set(t, '{config,response_window}',
                   CASE WHEN (t->'config'->>'interval_minutes')::int % 1440 = 0
                          THEN jsonb_build_object('unit','days', 'amount',(t->'config'->>'interval_minutes')::int / 1440)
                        WHEN (t->'config'->>'interval_minutes')::int % 60 = 0
                          THEN jsonb_build_object('unit','hours','amount',(t->'config'->>'interval_minutes')::int / 60)
                        ELSE jsonb_build_object('unit','minutes','amount',(t->'config'->>'interval_minutes')::int)
                   END)
            ELSE t END)
       FROM jsonb_array_elements(a.watcher_templates) t)
 WHERE a.watcher_templates IS NOT NULL
   AND jsonb_typeof(a.watcher_templates) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.watcher_templates) t WHERE t->>'kind' = 'schedule');

DO $a$
DECLARE v_def text; n int; v_due timestamptz; v_base timestamptz := '2026-01-01 00:00:00+00';
BEGIN
  -- ── the helper computes each unit correctly ───────────────────────────────
  -- Would these pass if the helper were a no-op returning NULL? No — each
  -- asserts an exact instant. Would they pass if every unit were treated as
  -- days? No — 90 minutes and 90 days land 129,510 minutes apart.
  IF response_window_due_at('{"response_window":{"unit":"minutes","amount":90}}'::jsonb, v_base)
     <> v_base + interval '90 minutes' THEN RAISE EXCEPTION '517: minutes are not honoured'; END IF;
  IF response_window_due_at('{"response_window":{"unit":"hours","amount":4}}'::jsonb, v_base)
     <> v_base + interval '4 hours'   THEN RAISE EXCEPTION '517: hours are not honoured'; END IF;
  IF response_window_due_at('{"response_window":{"unit":"days","amount":3}}'::jsonb, v_base)
     <> v_base + interval '3 days'    THEN RAISE EXCEPTION '517: days are not honoured'; END IF;
  IF response_window_due_at('{"response_window":{"unit":"date","at":"2026-08-15T17:00:00+00"}}'::jsonb, v_base)
     <> '2026-08-15 17:00:00+00'::timestamptz THEN RAISE EXCEPTION '517: a specific date is not honoured'; END IF;
  -- A fixed date must NOT drift with when the case opened.
  IF response_window_due_at('{"response_window":{"unit":"date","at":"2026-08-15T17:00:00+00"}}'::jsonb, now())
     <> '2026-08-15 17:00:00+00'::timestamptz THEN RAISE EXCEPTION '517: a fixed date moved with the case'; END IF;
  -- Nothing declared, or garbage declared, must be NULL — never a guess.
  IF response_window_due_at('{}'::jsonb, v_base) IS NOT NULL
     THEN RAISE EXCEPTION '517: an undeclared window invented a deadline'; END IF;
  IF response_window_due_at('{"response_window":{"unit":"date","at":"not a date"}}'::jsonb, v_base) IS NOT NULL
     THEN RAISE EXCEPTION '517: a malformed date invented a deadline'; END IF;
  IF response_window_due_at('{"response_window":{"unit":"hours","amount":0}}'::jsonb, v_base) IS NOT NULL
     THEN RAISE EXCEPTION '517: a zero window invented a deadline'; END IF;
  IF response_window_due_at('{"response_days":5}'::jsonb, v_base) <> v_base + interval '5 days'
     THEN RAISE EXCEPTION '517: the legacy shape stopped being honoured'; END IF;

  -- ── the validator refuses what it should ──────────────────────────────────
  IF validate_watcher_config('schedule', '{"interval_minutes":1440,"response_window":{"unit":"fortnights","amount":2}}'::jsonb, NULL, NULL) IS NULL
     THEN RAISE EXCEPTION '517: an unknown unit was accepted'; END IF;
  IF validate_watcher_config('schedule', '{"interval_minutes":1440,"response_window":{"unit":"hours","amount":-3}}'::jsonb, NULL, NULL) IS NULL
     THEN RAISE EXCEPTION '517: a negative window was accepted'; END IF;
  IF validate_watcher_config('schedule', '{"interval_minutes":1440,"response_window":{"unit":"date","at":"soon"}}'::jsonb, NULL, NULL) IS NULL
     THEN RAISE EXCEPTION '517: a nonsense date was accepted'; END IF;
  IF validate_watcher_config('date_horizon', '{"response_window":{"unit":"hours","amount":4}}'::jsonb, NULL, NULL) IS NULL
     THEN RAISE EXCEPTION '517: a date watcher was allowed a competing deadline'; END IF;
  -- ...and still ACCEPTS a good one, or the checks above would pass vacuously.
  IF validate_watcher_config('schedule', '{"interval_minutes":1440,"response_window":{"unit":"hours","amount":6}}'::jsonb, NULL, NULL) IS NOT NULL
     THEN RAISE EXCEPTION '517: a valid response window was refused: %',
       validate_watcher_config('schedule', '{"interval_minutes":1440,"response_window":{"unit":"hours","amount":6}}'::jsonb, NULL, NULL); END IF;

  -- ── the engine kept everything that was load-bearing ──────────────────────
  v_def := pg_get_functiondef('public.run_work_watchers(uuid)'::regprocedure);
  IF v_def NOT ILIKE '%response_window_due_at%' THEN RAISE EXCEPTION '517: the engine does not use the helper'; END IF;
  IF v_def ILIKE '%response_days%'              THEN RAISE EXCEPTION '517: an inline legacy deadline survived in the engine'; END IF;
  IF v_def NOT ILIKE '%CONTINUE%'               THEN RAISE EXCEPTION '517: lost the per-watcher exception wrapper'; END IF;
  IF v_def NOT ILIKE '%occurrence_key%'         THEN RAISE EXCEPTION '517: lost occurrence dedupe'; END IF;
  IF v_def NOT ILIKE '%tenant_is_operational%'  THEN RAISE EXCEPTION '517: lost the mig-430 dormancy guard'; END IF;
  -- EVERY objective INSERT must carry the deadline column. This is the check
  -- 515 should have had: it counts, rather than trusting a number I guessed.
  SELECT count(*) INTO n FROM regexp_matches(v_def, 'INSERT INTO de_objectives \(([^)]*)\)', 'g') m
   WHERE m[1] NOT LIKE '%due_at%';
  IF n > 0 THEN RAISE EXCEPTION '517: % objective INSERT(s) still stamp no deadline', n; END IF;

  -- ── nothing was left behind ───────────────────────────────────────────────
  SELECT count(*) INTO n FROM work_watchers WHERE config ? 'response_days';
  IF n > 0 THEN RAISE EXCEPTION '517: % watcher(s) still carry the old response_days key', n; END IF;
  SELECT count(*) INTO n FROM work_watchers WHERE kind <> 'date_horizon' AND NOT (config ? 'response_window');
  IF n > 0 THEN RAISE EXCEPTION '517: % non-date watcher(s) still declare no response window', n; END IF;

  SELECT count(*) INTO n FROM work_watchers WHERE config ? 'response_window';
  RAISE NOTICE '517: % watcher(s) carry a response window settable in minutes, hours, days or by date', n;
END $a$;
