-- 515_one_meaning_per_field_and_real_deadlines.sql
-- ============================================================================
-- Two defects in run_work_watchers, both surfaced by making the queue order by
-- urgency (mig 514).
--
-- ── 1. ONE COLUMN, TWO NUMBERING SYSTEMS ───────────────────────────────────
-- de_objectives.priority is a 1-5 urgency scale everywhere except the
-- date-horizon branches, which wrote the HORIZON DAYS into it: a 30-day
-- checkpoint got priority 30, a 90-day one got 90. So the tenant holds values
-- 2, 3, 30, 60 and 90 in a single field meaning two different things, and any
-- consumer sorting ascending puts every routine daily sweep (3) ahead of every
-- contract notice checkpoint (30). Migration 514 had to refuse to sort on it at
-- all, with an assert to stop anyone doing so later.
--
-- Now rescaled onto the one scale, keeping the meaning the horizon carried:
-- closer deadline = more urgent. <=14 days -> 1, <=30 -> 2, <=60 -> 3, else 4.
-- Existing rows are backfilled by the same rule, derived from the horizon the
-- watcher recorded in plan->>'horizon_days' — not guessed from the title.
--
-- ── 2. MOST GOALS HAD NO DEADLINE ──────────────────────────────────────────
-- The date-horizon branches always set due_at (the real watched date). The
-- state-condition branches — health dropped, account turned at-risk — never
-- did: the column was not even in their INSERT. So the most time-sensitive work
-- in the book, a customer going bad, sorted as though it could wait forever.
--
-- Fixed WITHOUT inventing a date. A response window is a SERVICE STANDARD the
-- role declares, in the same place it already declares its guardrails, SOP and
-- KPIs — not a number the system makes up. If a watcher carries no
-- response_days, due_at stays NULL, which is the honest answer for "nobody has
-- said how quickly this should be handled".
--
-- THE DEFAULTS SEEDED BELOW ARE A JUDGMENT AND ARE MEANT TO BE CHANGED:
--   an account turning at-risk        -> respond within 3 days
--   health dropping below a threshold -> respond within 5 days
-- They are visible on the role and on every watcher, and editable per tenant.
--
-- Reproduced from the LIVE definition (mig 377). PRESERVED: the per-watcher
-- EXCEPTION ... CONTINUE wrapper (one bad watcher must never kill the tick),
-- every occurrence_key format (changing one re-opens every historical case),
-- ON CONFLICT (objective_id) DO NOTHING, and tenant_is_operational.
-- ============================================================================

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
          case when (w.config->>'response_days') ~ '^[0-9]+$'
               then now() + make_interval(days => (w.config->>'response_days')::int)
               else null end,
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
          case when (w.config->>'response_days') ~ '^[0-9]+$'
               then now() + make_interval(days => (w.config->>'response_days')::int)
               else null end,
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
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
        VALUES (w.tenant_id, w.de_id, left(w.label || ' — ' || v_label,200),
          'Opened by the Book of Work: ' || v_label || ' matched "' || v_field || ' ' || v_op || ' ' || (w.config->>'value') || '". Assess and work per the playbook.',
          v_cat.entity_kind, v_id, 'open', 2,
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

notify pgrst, 'reload schema';

-- ── declare the response standards on the roles ─────────────────────────────
update public.role_archetypes a
   set watcher_templates = (
     select jsonb_agg(
       case when t->>'kind' = 'state_condition' and not (t->'config' ? 'response_days')
            then jsonb_set(t, '{config,response_days}',
                   to_jsonb(case when coalesce(t->'config'->>'field','') = 'status' then 3 else 5 end))
            else t end)
       from jsonb_array_elements(a.watcher_templates) t)
 where a.watcher_templates is not null
   and jsonb_typeof(a.watcher_templates) = 'array'
   and exists (select 1 from jsonb_array_elements(a.watcher_templates) t where t->>'kind' = 'state_condition');

-- ...and on the watchers already live in every tenant, or the standard would
-- only reach employees hired from here on.
update public.work_watchers w
   set config = jsonb_set(w.config, '{response_days}',
         to_jsonb(case when coalesce(w.config->>'field','') = 'status' then 3 else 5 end))
 where w.kind = 'state_condition'
   and not (w.config ? 'response_days');

-- ── backfill the polluted priorities ────────────────────────────────────────
-- Derived from the horizon the watcher itself recorded, never guessed.
update public.de_objectives o
   set priority = case
         when (o.plan->>'horizon_days')::int <= 14 then 1
         when (o.plan->>'horizon_days')::int <= 30 then 2
         when (o.plan->>'horizon_days')::int <= 60 then 3
         else 4 end
 where o.plan ? 'horizon_days'
   and (o.plan->>'horizon_days') ~ '^[0-9]+$'
   and o.priority > 5;

do $a$
declare v_def text; n_bad int; n_std int; n_due int;
begin
  v_def := pg_get_functiondef('public.run_work_watchers(uuid)'::regprocedure);
  if v_def ilike '%''open'', v_h,%' then
    raise exception '515: a date-horizon branch still writes horizon days into priority';
  end if;
  if v_def not ilike '%response_days%' then
    raise exception '515: state-condition goals still cannot carry a deadline';
  end if;
  -- The load-bearing guards must have survived the recreate.
  if v_def not ilike '%CONTINUE%' then raise exception '515: lost the per-watcher exception wrapper'; end if;
  if v_def not ilike '%occurrence_key%' then raise exception '515: lost occurrence dedupe'; end if;
  if v_def not ilike '%tenant_is_operational%' then raise exception '515: lost the mig-430 dormancy guard'; end if;

  -- No goal may still carry a horizon-shaped priority.
  select count(*) into n_bad from de_objectives where priority > 5;
  if n_bad > 0 then
    raise exception '515: % goals still hold a horizon value in the priority column', n_bad;
  end if;

  select count(*) into n_std from work_watchers where kind = 'state_condition' and config ? 'response_days';
  select count(*) into n_due from de_objectives
   where tenant_id = (select id from tenants where slug = 'outsourcetel-hq')
     and status in ('open','in_progress') and due_at is not null;
  raise notice '515: priority is one scale again; % state watchers carry a declared response window; % open goals now have a deadline', n_std, n_due;
end $a$;
