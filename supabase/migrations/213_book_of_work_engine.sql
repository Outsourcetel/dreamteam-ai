-- 213_book_of_work_engine.sql
-- ============================================================================
-- EXEC Phase 0.1 — the Book-of-Work engine.
--
-- "Treat a DE like a human, not a bot": a human employee DERIVES their own
-- queue from the systems they work in — renewals coming due, accounts whose
-- health dipped, a metric crossing a line, month-end arriving. Support was the
-- only role whose work arrives by itself (a ticket lands); every other role
-- needs this engine.
--
-- Model: a tenant configures WATCHERS for a DE. Five kinds:
--   inbox            — new item appears in a connected system. Already served
--                      by the proactive poller (migration 036); registered here
--                      only so a DE's book of work is complete in one place.
--   date_horizon     — a date field is approaching (renewal in 90/60/30 days).
--   state_condition  — a record is in an actionable state (health < 60).
--   metric_threshold — a KPI reading crossed a line.
--   schedule         — the calendar says so (recurring work).
--
-- Every match opens a CASE — a row in de_objectives, the work engine the
-- de-work loop already wakes (cadence, plans, next_wake_at). No new case
-- container: watchers feed the existing spine. A ledger (work_watcher_matches)
-- makes every firing idempotent — the same occurrence never opens two cases.
--
-- Evaluation is PURE SQL on a 5-minute pg_cron tick — zero LLM cost to notice
-- work. The DE spends reasoning tokens only when it WORKS a case.
--
-- v1 sources are internal (customer_accounts, de_kpi_readings). Watching
-- external systems' record state arrives with the per-category write phases.
-- GLOBAL — every tenant, dormant until a watcher is created.
-- ============================================================================

-- ── Watchers ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_watchers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id            uuid NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('inbox','date_horizon','state_condition','metric_threshold','schedule')),
  label            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  active           boolean NOT NULL DEFAULT true,
  next_fire_at     timestamptz,            -- schedule kind only
  last_run_at      timestamptz,
  last_match_count integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_watchers_active ON work_watchers(tenant_id, active) WHERE active;

ALTER TABLE work_watchers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_watchers_tenant_read ON work_watchers;
CREATE POLICY work_watchers_tenant_read ON work_watchers
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- Owners/admins manage the book of work (same gate as guardrails/grants).
DROP POLICY IF EXISTS work_watchers_admin_write ON work_watchers;
CREATE POLICY work_watchers_admin_write ON work_watchers
  FOR ALL USING (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']))
  WITH CHECK (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']));

-- ── Idempotency ledger — one occurrence, one case, forever ──────────────────
CREATE TABLE IF NOT EXISTS work_watcher_matches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  watcher_id     uuid NOT NULL REFERENCES work_watchers(id) ON DELETE CASCADE,
  subject_ref    text NOT NULL,
  occurrence_key text NOT NULL,
  objective_id   uuid REFERENCES de_objectives(id) ON DELETE SET NULL,
  matched_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (watcher_id, occurrence_key)
);
ALTER TABLE work_watcher_matches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_watcher_matches_tenant_read ON work_watcher_matches;
CREATE POLICY work_watcher_matches_tenant_read ON work_watcher_matches
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- No tenant write policy: only the runner (service context) writes matches.

-- ── Config validation — garbage configs fail at save, not at 3am ────────────
CREATE OR REPLACE FUNCTION public.validate_work_watcher()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c jsonb := NEW.config;
BEGIN
  IF NEW.kind = 'date_horizon' THEN
    IF coalesce(c->>'source','customer_accounts') <> 'customer_accounts' THEN
      RAISE EXCEPTION 'date_horizon v1 supports source customer_accounts only';
    END IF;
    IF coalesce(c->>'date_field','renewal_date') <> 'renewal_date' THEN
      RAISE EXCEPTION 'date_horizon v1 supports date_field renewal_date only';
    END IF;
  ELSIF NEW.kind = 'state_condition' THEN
    IF coalesce(c->>'source','customer_accounts') <> 'customer_accounts' THEN
      RAISE EXCEPTION 'state_condition v1 supports source customer_accounts only';
    END IF;
    IF c->>'field' IS NULL OR NOT (c->>'field' IN ('health_score','status','arr_cents','tier')) THEN
      RAISE EXCEPTION 'state_condition field must be one of health_score, status, arr_cents, tier';
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
    IF coalesce((c->>'interval_minutes')::int, 0) < 60 THEN
      RAISE EXCEPTION 'schedule interval_minutes must be at least 60';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_validate_work_watcher ON work_watchers;
CREATE TRIGGER trg_validate_work_watcher BEFORE INSERT OR UPDATE ON work_watchers
  FOR EACH ROW EXECUTE FUNCTION public.validate_work_watcher();

-- ── The runner — pure SQL, called by pg_cron every 5 minutes ────────────────
CREATE OR REPLACE FUNCTION public.run_work_watchers(p_tenant_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  w          work_watchers;
  v_new      integer;
  v_total    integer := 0;
  v_watchers integer := 0;
  v_obj_id   uuid;
  v_inserted boolean;
  r          record;
  v_h        integer;
  v_days     integer;
  v_occ      text;
  v_title    text;
  v_de_name  text;
BEGIN
  FOR w IN
    SELECT * FROM work_watchers
    WHERE active AND kind <> 'inbox'
      AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id)
    ORDER BY created_at
  LOOP
    v_new := 0;
    v_watchers := v_watchers + 1;
    SELECT coalesce(persona_name, name) INTO v_de_name FROM digital_employees WHERE id = w.de_id;

    -- ── date_horizon: fire the TIGHTEST crossed horizon per (record, date) ──
    IF w.kind = 'date_horizon' THEN
      FOR r IN
        SELECT ca.id, ca.name, ca.renewal_date, ca.arr_cents, ca.health_score,
               (ca.renewal_date - current_date) AS days_left
        FROM customer_accounts ca
        WHERE ca.tenant_id = w.tenant_id
          AND ca.renewal_date IS NOT NULL
          AND ca.renewal_date >= current_date
          AND (w.config->'status_filter' IS NULL
               OR ca.status IN (SELECT jsonb_array_elements_text(w.config->'status_filter')))
      LOOP
        -- smallest configured horizon that days_left fits inside
        SELECT min(h) INTO v_h
        FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days','[90,60,30]'::jsonb)))::int AS h) hs
        WHERE h >= r.days_left;
        IF v_h IS NULL THEN CONTINUE; END IF;

        v_occ := r.id::text || '|' || r.renewal_date::text || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ)
        ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF NOT v_inserted THEN CONTINUE; END IF;

        v_title := w.label || ' — ' || r.name || ' (' || v_h || '-day checkpoint, renews ' || to_char(r.renewal_date, 'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (
          w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' renews on ' || r.renewal_date::text
            || ' (' || r.days_left || ' days out). Work the ' || v_h || '-day motion per the playbook.',
          'customer_account', r.id::text, 'open', v_h, r.renewal_date::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'horizon_days',v_h,
            'subject', jsonb_build_object('name', r.name, 'renewal_date', r.renewal_date, 'arr_cents', r.arr_cents, 'health_score', r.health_score))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    -- ── state_condition: fire once per record entering the state ──
    ELSIF w.kind = 'state_condition' THEN
      FOR r IN
        SELECT ca.id, ca.name, ca.health_score, ca.status, ca.arr_cents, ca.tier
        FROM customer_accounts ca
        WHERE ca.tenant_id = w.tenant_id
          AND CASE w.config->>'field'
                WHEN 'health_score' THEN
                  CASE w.config->>'op'
                    WHEN 'lt'  THEN ca.health_score <  (w.config->>'value')::numeric
                    WHEN 'lte' THEN ca.health_score <= (w.config->>'value')::numeric
                    WHEN 'gt'  THEN ca.health_score >  (w.config->>'value')::numeric
                    WHEN 'gte' THEN ca.health_score >= (w.config->>'value')::numeric
                    WHEN 'eq'  THEN ca.health_score =  (w.config->>'value')::numeric
                    ELSE ca.health_score <> (w.config->>'value')::numeric END
                WHEN 'arr_cents' THEN
                  CASE w.config->>'op'
                    WHEN 'lt'  THEN ca.arr_cents <  (w.config->>'value')::numeric
                    WHEN 'lte' THEN ca.arr_cents <= (w.config->>'value')::numeric
                    WHEN 'gt'  THEN ca.arr_cents >  (w.config->>'value')::numeric
                    WHEN 'gte' THEN ca.arr_cents >= (w.config->>'value')::numeric
                    WHEN 'eq'  THEN ca.arr_cents =  (w.config->>'value')::numeric
                    ELSE ca.arr_cents <> (w.config->>'value')::numeric END
                WHEN 'status' THEN
                  CASE w.config->>'op' WHEN 'eq' THEN ca.status = w.config->>'value' ELSE ca.status <> w.config->>'value' END
                WHEN 'tier' THEN
                  CASE w.config->>'op' WHEN 'eq' THEN ca.tier = w.config->>'value' ELSE ca.tier <> w.config->>'value' END
                ELSE false END
      LOOP
        v_occ := r.id::text || '|' || (w.config->>'field') || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ)
        ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF NOT v_inserted THEN CONTINUE; END IF;

        v_title := w.label || ' — ' || r.name;
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
        VALUES (
          w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' matched "' || (w.config->>'field') || ' '
            || (w.config->>'op') || ' ' || (w.config->>'value') || '". Assess and work per the playbook.',
          'customer_account', r.id::text, 'open', 2,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,
            'condition', w.config, 'subject', jsonb_build_object('name', r.name, 'health_score', r.health_score, 'status', r.status))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    -- ── metric_threshold: latest KPI reading for THIS DE crossed the line ──
    ELSIF w.kind = 'metric_threshold' THEN
      SELECT k.metric_key AS mkey, k.value, k.as_of INTO r
      FROM de_kpi_readings k
      WHERE k.tenant_id = w.tenant_id AND k.de_id = w.de_id AND k.metric_key = w.config->>'metric_key'
      ORDER BY k.as_of DESC, k.created_at DESC LIMIT 1;
      IF r.mkey IS NOT NULL AND (
           (w.config->>'op' = 'lt' AND r.value < (w.config->>'value')::numeric)
        OR (w.config->>'op' = 'gt' AND r.value > (w.config->>'value')::numeric)
      ) THEN
        v_occ := r.mkey || '|' || r.as_of::text || '|' || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.mkey, v_occ)
        ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted THEN
          INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
          VALUES (
            w.tenant_id, w.de_id, left(w.label || ' — ' || r.mkey || ' at ' || r.value, 200),
            'Opened by the Book of Work: metric "' || r.mkey || '" read ' || r.value || ' on ' || r.as_of
              || ', crossing the ' || (w.config->>'op') || ' ' || (w.config->>'value') || ' line. Investigate per the playbook.',
            'metric', r.mkey, 'open', 2,
            jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'reading',
              jsonb_build_object('metric_key', r.mkey, 'value', r.value, 'as_of', r.as_of))
          ) RETURNING id INTO v_obj_id;
          UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
          v_new := v_new + 1;
        END IF;
      END IF;

    -- ── schedule: the calendar says so ──
    ELSIF w.kind = 'schedule' THEN
      IF w.next_fire_at IS NULL THEN
        UPDATE work_watchers SET next_fire_at = now() + make_interval(mins => (w.config->>'interval_minutes')::int)
        WHERE id = w.id;
      ELSIF now() >= w.next_fire_at THEN
        v_occ := to_char(w.next_fire_at, 'YYYY-MM-DD"T"HH24:MI');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, 'schedule', v_occ)
        ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted THEN
          INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
          VALUES (
            w.tenant_id, w.de_id, left(w.label, 200),
            'Opened by the Book of Work on schedule (' || coalesce(w.description, w.label) || '). Run the recurring motion per the playbook.',
            'schedule', v_occ, 'open', 3,
            jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'fired_at', now())
          ) RETURNING id INTO v_obj_id;
          UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
          v_new := v_new + 1;
        END IF;
        UPDATE work_watchers SET next_fire_at = now() + make_interval(mins => (w.config->>'interval_minutes')::int)
        WHERE id = w.id;
      END IF;
    END IF;

    UPDATE work_watchers SET last_run_at = now(), last_match_count = v_new WHERE id = w.id;
    v_total := v_total + v_new;

    IF v_new > 0 THEN
      BEGIN
        PERFORM append_audit_event_internal(
          w.tenant_id, coalesce(v_de_name, 'DE'), 'de',
          coalesce(v_de_name, 'DE') || ' found ' || v_new || ' new work item(s) via Book of Work watcher "' || w.label || '"',
          'playbook_step',
          jsonb_build_object('kind','book_of_work','watcher_id', w.id, 'watcher_kind', w.kind, 'new_cases', v_new));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'watchers_run', v_watchers, 'cases_opened', v_total);
END; $$;

REVOKE ALL ON FUNCTION public.run_work_watchers(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.run_work_watchers(uuid) TO service_role;

-- ── The tick — every 5 minutes, pure SQL, upserts by job name (idempotent) ──
SELECT cron.schedule('work-watchers-tick', '*/5 * * * *', 'select public.run_work_watchers()');
