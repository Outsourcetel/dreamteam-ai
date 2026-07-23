-- 273_standing_missions.sql
-- ============================================================================
-- STANDING MISSIONS become installable (T2.4). Today an approved shape='standing'
-- mission hard-fails ('standing_not_installable_yet', de-mission/index.ts:210-215).
-- Now it INSTALLS one or more mig-272 work_watchers tagged with mission_id; the
-- existing global run_work_watchers cron fires them; opened cases trace back to
-- the mission; and pause/resume/cancel control the installed watchers.
--
-- Designed via design→adversarial-verify (workflow wf_4af5f606-fb6). The
-- adversary's fixes are folded in:
--   #1 ATOMIC install RPC — a partial multi-watcher install can't leave orphan
--      live watchers firing (all-or-nothing inside one function).
--   #2 SINGLE-SOURCE validator — validate_watcher_config() is extracted from the
--      mig-272 trigger; the trigger becomes a thin wrapper, so preview == install
--      == cron enforce ONE rule set (no retyped-validator drift, the 048/059 trap).
--   #3 MANDATORY scope-count preview — preview_watcher_spec() so a standing mission
--      shows "about N cases open now", never a blind est_cost=0 case-spawner.
--   #5 ROLE/DOMAIN scoping enforced by the validator (require_domain_grant path),
--      so a manager can't point any DE at any source.
--   #6 LIFECYCLE — pause/resume flip active WITHOUT re-running catalog validation
--      (active-only short-circuit in the trigger, so catalog drift can't RAISE on
--      a pure pause); cancel DELETES the mission's watchers FIRST, then abandons.
-- (#4 carry playbook_key onto the watcher config = edge-fn concern; the passthrough
--  key is ignored by the validator here and recorded on the watcher.)
-- GLOBAL to all tenants. Additive. Reproduces validate_work_watcher and
-- set_de_mission_state FROM LIVE (mig 272 / mig 248 bodies) before editing.
-- ============================================================================

-- ── 1. Link installed watchers to the mission that installed them ───────────
ALTER TABLE work_watchers ADD COLUMN IF NOT EXISTS mission_id uuid
  REFERENCES de_missions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS work_watchers_mission_idx
  ON work_watchers (mission_id) WHERE mission_id IS NOT NULL;
-- Hard idempotency backstop: re-approving a mission can't double-install a label.
CREATE UNIQUE INDEX IF NOT EXISTS work_watchers_mission_label_uidx
  ON work_watchers (mission_id, label) WHERE mission_id IS NOT NULL;

-- ── 2. Single-source validator (fixes #2) ───────────────────────────────────
-- Pure decision logic extracted from the LIVE validate_work_watcher() trigger
-- (mig 272), INCLUDING the require_domain_grant guard. Returns NULL when the
-- config is valid, else a plain-language reason. Used by the compile preview,
-- the atomic install RPC, and the trigger wrapper — one rule set everywhere.
CREATE OR REPLACE FUNCTION public.validate_watcher_config(
  p_kind text, p_config jsonb, p_tenant_id uuid, p_de_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c    jsonb := coalesce(p_config, '{}'::jsonb);
  src  text  := coalesce(p_config->>'source', 'customer_accounts');
  s    watch_source_catalog;
  f    watch_source_fields;
  v_op text := coalesce(c->>'op', '');
  v_datef text;
  v_grant_ok boolean;
BEGIN
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
END $$;
REVOKE ALL ON FUNCTION public.validate_watcher_config(text, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_watcher_config(text, jsonb, uuid, uuid) TO authenticated, service_role;

-- ── 3. Trigger wrapper: same rule set + active-only short-circuit (fixes #6) ─
-- Reproduces the mig-272 write-time guard as a thin wrapper. A pure
-- activate/deactivate (mission pause/resume flips only `active`) must NOT
-- re-validate against the catalog — the catalog may have drifted since install
-- and we would wrongly RAISE and block the pause.
CREATE OR REPLACE FUNCTION public.validate_work_watcher()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_err text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.config IS NOT DISTINCT FROM OLD.config
     AND NEW.kind   IS NOT DISTINCT FROM OLD.kind THEN
    RETURN NEW;  -- only active/next_fire_at/bookkeeping changed → no re-validation
  END IF;
  v_err := public.validate_watcher_config(NEW.kind, NEW.config, NEW.tenant_id, NEW.de_id);
  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION '%', v_err;
  END IF;
  RETURN NEW;
END $$;
-- trigger trg_validate_work_watcher (BEFORE INSERT OR UPDATE) already binds this.

-- ── 4. Scope-count preview (fixes #3) ───────────────────────────────────────
-- Read-only COUNT of entities currently in scope for a watcher spec, so the
-- founder sees the real fan-out size before approving a standing mission.
-- Reuses the catalog predicate builders the runner uses (%I-quoted catalog
-- identifiers, USING-bound values). Returns -1 when a per-entity count doesn't
-- apply (metric_threshold / schedule / legacy source).
CREATE OR REPLACE FUNCTION public.preview_watcher_spec(
  p_kind text, p_config jsonb, p_tenant_id uuid)
RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c   jsonb := coalesce(p_config, '{}'::jsonb);
  src text  := coalesce(p_config->>'source', 'customer_accounts');
  s   watch_source_catalog;
  v_field text; v_op text; v_vt text; v_cast text; v_datef text;
  v_where text; v_sql text; v_cnt int; v_maxh int;
BEGIN
  SELECT * INTO s FROM watch_source_catalog
   WHERE source_key = src AND active AND NOT legacy_bespoke;
  IF s.source_key IS NULL THEN RETURN -1; END IF;

  IF p_kind = 'state_condition' THEN
    v_field := c->>'field'; v_op := c->>'op';
    SELECT value_type INTO v_vt FROM watch_source_fields
      WHERE source_key = src AND role = 'state' AND column_name = v_field
        AND v_op = ANY (allowed_ops);
    IF v_vt IS NULL THEN RETURN -1; END IF;
    v_cast := CASE WHEN v_vt = 'numeric' THEN '::numeric' ELSE '' END;
    v_where := format('%I = $1', s.tenant_column) || build_base_predicates(s.base_predicates)
               || format(' AND %I %s $2%s', v_field, sql_op(v_op), v_cast);
    v_sql := format('SELECT count(*) FROM %I t WHERE %s', s.table_name, v_where);
    EXECUTE v_sql INTO v_cnt USING p_tenant_id, (c->>'value');
    RETURN v_cnt;

  ELSIF p_kind = 'date_horizon' THEN
    v_datef := coalesce(c->>'date_field',
                 (SELECT column_name FROM watch_source_fields
                   WHERE source_key = src AND role = 'date' ORDER BY column_name LIMIT 1));
    IF v_datef IS NULL OR NOT EXISTS (
         SELECT 1 FROM watch_source_fields
          WHERE source_key = src AND role = 'date' AND column_name = v_datef) THEN
      RETURN -1;
    END IF;
    SELECT max(h) INTO v_maxh FROM (
      SELECT (jsonb_array_elements_text(coalesce(c->'horizons_days', s.default_horizons)))::int AS h) hs;
    IF v_maxh IS NULL THEN v_maxh := 90; END IF;
    v_where := format('%I = $1', s.tenant_column) || build_base_predicates(s.base_predicates)
               || format(' AND %I IS NOT NULL AND %I >= current_date AND %I <= current_date + $2::int',
                         v_datef, v_datef, v_datef);
    v_sql := format('SELECT count(*) FROM %I t WHERE %s', s.table_name, v_where);
    EXECUTE v_sql INTO v_cnt USING p_tenant_id, v_maxh;
    RETURN v_cnt;

  ELSE
    RETURN -1;  -- metric_threshold / schedule: not a per-entity fan-out
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.preview_watcher_spec(text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_watcher_spec(text, jsonb, uuid) TO authenticated, service_role;

-- ── 5. Case attribution WITHOUT touching the 333-line runner ────────────────
-- Every run_work_watchers arm already writes plan->>'watcher_id'. A BEFORE-INSERT
-- trigger on de_objectives copies the opening watcher's mission_id onto the case,
-- generically across every current and future arm — so we never reproduce/edit
-- the large runner body just for attribution.
CREATE OR REPLACE FUNCTION public.stamp_objective_mission_from_watcher()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_mid uuid; v_wid text;
BEGIN
  IF NEW.mission_id IS NULL AND jsonb_typeof(NEW.plan) = 'object' THEN
    v_wid := NEW.plan->>'watcher_id';
    IF v_wid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT mission_id INTO v_mid FROM work_watchers
        WHERE id = v_wid::uuid AND tenant_id = NEW.tenant_id;
      IF v_mid IS NOT NULL THEN NEW.mission_id := v_mid; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_stamp_objective_mission ON de_objectives;
CREATE TRIGGER trg_stamp_objective_mission BEFORE INSERT ON de_objectives
  FOR EACH ROW EXECUTE FUNCTION public.stamp_objective_mission_from_watcher();

-- ── 6. Atomic install RPC (fixes #1) ────────────────────────────────────────
-- Service-role only (the de-mission edge fn, which has already authorized the
-- founder, is the sole caller). Installs ALL watchers in ONE transaction so any
-- bad spec (validator RAISE or unique violation) rolls back the whole install —
-- no orphan live watchers. Idempotent per (mission_id, label).
CREATE OR REPLACE FUNCTION public.install_standing_watchers(
  p_mission_id uuid, p_specs jsonb, p_approved_by uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_de uuid; v_status text;
  spec jsonb; v_installed int := 0; v_err text;
  v_label text; v_kind text; v_cfg jsonb;
BEGIN
  SELECT tenant_id, de_id, status INTO v_tenant, v_de, v_status
    FROM de_missions WHERE id = p_mission_id FOR UPDATE;
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_status <> 'awaiting_approval' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_awaiting_approval', 'status', v_status);
  END IF;
  IF jsonb_typeof(p_specs) <> 'array' OR jsonb_array_length(p_specs) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_specs');
  END IF;

  FOR spec IN SELECT * FROM jsonb_array_elements(p_specs) LOOP
    v_kind  := spec->>'kind';
    v_label := left(coalesce(spec->>'label', ''), 200);
    v_cfg   := coalesce(spec->'config', '{}'::jsonb);
    IF v_label = '' THEN RAISE EXCEPTION 'A standing watcher is missing its label.'; END IF;
    v_err := public.validate_watcher_config(v_kind, v_cfg, v_tenant, v_de);
    IF v_err IS NOT NULL THEN RAISE EXCEPTION '%', v_err; END IF;
    IF EXISTS (SELECT 1 FROM work_watchers
                WHERE mission_id = p_mission_id AND label = v_label) THEN
      CONTINUE;  -- idempotent: already installed on a prior approve attempt
    END IF;
    INSERT INTO work_watchers
      (tenant_id, de_id, kind, label, description, config, active, mission_id)
    VALUES
      (v_tenant, v_de, v_kind, v_label,
       left(coalesce(spec->>'description', ''), 500), v_cfg, true, p_mission_id);
    v_installed := v_installed + 1;
  END LOOP;

  UPDATE de_missions
     SET status = 'running', approved_by = p_approved_by,
         approved_at = now(), updated_at = now()
   WHERE id = p_mission_id;
  RETURN jsonb_build_object('ok', true, 'installed', v_installed);
END $$;
REVOKE ALL ON FUNCTION public.install_standing_watchers(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.install_standing_watchers(uuid, jsonb, uuid) TO service_role;

-- ── 7. Lifecycle: mission state also drives its installed watchers (fixes #6) ─
-- Reproduced FROM LIVE (mig 248 body) + watcher control. Batch/project missions
-- own no mission-linked watchers, so the extra statements touch 0 rows for them.
CREATE OR REPLACE FUNCTION public.set_de_mission_state(p_mission_id uuid, p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_status text; v_next text;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL OR NOT public.auth_has_tenant_role(
       ARRAY['tenant_owner','tenant_admin','tenant_manager']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  SELECT status INTO v_status FROM de_missions
   WHERE id = p_mission_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  v_next := CASE
    WHEN p_action = 'pause'  AND v_status IN ('approved','running') THEN 'paused'
    WHEN p_action = 'resume' AND v_status = 'paused'                THEN 'running'
    WHEN p_action = 'cancel' AND v_status IN ('draft','awaiting_approval',
                                              'approved','running','paused')
                                                                    THEN 'cancelled'
    ELSE NULL END;
  IF v_next IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
                              'from', v_status, 'action', p_action);
  END IF;
  UPDATE de_missions SET status = v_next, updated_at = now(),
         finished_at = CASE WHEN v_next = 'cancelled' THEN now() ELSE finished_at END
   WHERE id = p_mission_id;

  IF v_next = 'paused' THEN
    UPDATE work_watchers SET active = false, updated_at = now()
     WHERE mission_id = p_mission_id AND tenant_id = v_tenant;
  ELSIF v_next = 'running' AND p_action = 'resume' THEN
    UPDATE work_watchers SET active = true, updated_at = now()
     WHERE mission_id = p_mission_id AND tenant_id = v_tenant;
  ELSIF v_next = 'cancelled' THEN
    -- stop future ticks FIRST (matches cascade-cleans work_watcher_matches),
    -- then unwind queued/open work — same order the adversary asked for.
    DELETE FROM work_watchers
     WHERE mission_id = p_mission_id AND tenant_id = v_tenant;
    UPDATE de_work_items w SET status = 'cancelled', updated_at = now()
      FROM de_objectives o
     WHERE w.objective_id = o.id AND o.mission_id = p_mission_id
       AND w.tenant_id = v_tenant AND w.status = 'queued';
    UPDATE de_objectives SET status = 'abandoned', updated_at = now()
     WHERE mission_id = p_mission_id AND status IN ('open','in_progress','blocked');
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_next);
END $$;
REVOKE ALL ON FUNCTION public.set_de_mission_state(uuid, text) FROM anon;

NOTIFY pgrst, 'reload schema';
