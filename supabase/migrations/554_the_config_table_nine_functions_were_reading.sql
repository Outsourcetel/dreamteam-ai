-- 554 — the config table nine live functions were reading, and which did not exist.
--
-- `get_de_config(p_tenant_id, p_entity_kind, p_entity_id)` has been live and
-- ALWAYS THROWING `42P01: relation "de_config" does not exist`. Proven by calling
-- it, not by reading code. Its table was defined in
-- 20260719225435_create_extensible_metrics_config.sql, which never ran; the
-- FUNCTION exists anyway because 197_security_hardening_review.sql recreated it.
-- The function outlived a table it never had.
--
-- WHY IT MATTERED. Two governance controls in supabase/functions/de-answer read
-- it, and both wrap the call in a catch that treats failure as "feature off":
--   L1362 reply-mode / pre-approval — every chat answer sends with NO human
--         review. `draft_responses` has 0 rows, ever.
--   L1215 pre-send quality auditor — written to FAIL CLOSED when enabled, but
--         the ENABLEMENT READ fails open, so it can never be enabled.
-- A fail-closed control behind a fail-open enablement read is invisible: no
-- alert, no surfaced error, and it merely looks "not configured".
--
-- SHAPE IS DERIVED FROM THE LIVE FUNCTIONS, NOT FROM THE 2026-07-19 FILE.
-- get_de_config and get_config_schema both do `SELECT *` against a RETURNS TABLE
-- list, so COLUMN ORDER IS PART OF THE CONTRACT — a mismatch raises "structure of
-- query does not match function result type". The 2026-07-19 order happens to be
-- right and is preserved deliberately, not copied casually.
--
-- TWO THINGS FROM THAT FILE ARE DELIBERATELY NOT COPIED:
--   1. `updated_by UUID NOT NULL REFERENCES auth.users(id)`. set_de_config
--      inserts auth.uid(), which is NULL for the service role, cron and psql —
--      every server-side write would have failed the NOT NULL. Same for the audit
--      trigger's changed_by, which would have made the trigger break the UPDATE
--      that fired it. Both are nullable here.
--   2. RLS policies keyed on `current_setting('app.current_tenant_id')`. Nothing
--      in this codebase sets that GUC, and the un-guarded current_setting RAISES
--      when unset. This codebase gates on auth_tenant_id()/profiles. These tables
--      are reached ONLY through SECURITY DEFINER functions that already call
--      _assert_caller_tenant, so the correct posture is RLS on with NO policy
--      plus an explicit REVOKE — deny direct access, allow the vetted path.
--
-- NOT IN SCOPE: customer_metrics is also missing, so export_tenant_config and
-- get_tenant_config_status stay broken. Both have ZERO callers and belong to the
-- customer-defined-metrics feature, which is a separate question. Said plainly
-- rather than quietly widened.

BEGIN;

-- ── 1. de_config_schemas ────────────────────────────────────────────────────
-- Order per get_config_schema's RETURNS TABLE(schema_id, tenant_id, entity_kind,
-- entity_id, name, fields, tags, created_at, updated_at).
-- entity_id stays NULLABLE: get_config_schema matches `entity_id = p OR entity_id
-- IS NULL`, i.e. a tenant-wide schema with per-entity overrides.
CREATE TABLE IF NOT EXISTS de_config_schemas (
  schema_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('de', 'playbook', 'specialist')),
  entity_id   UUID,
  name        TEXT NOT NULL,
  fields      JSONB NOT NULL DEFAULT '[]',
  tags        TEXT[] DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, entity_kind, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_de_config_schemas_tenant ON de_config_schemas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_de_config_schemas_entity ON de_config_schemas(entity_kind, entity_id);

-- ── 2. de_config ────────────────────────────────────────────────────────────
-- Order per get_de_config's RETURNS TABLE(config_id, tenant_id, entity_kind,
-- entity_id, schema_id, data, created_at, updated_at, updated_by).
-- entity_id is NOT NULL on purpose: set_de_config does ON CONFLICT
-- (tenant_id, entity_kind, entity_id), and NULLs are distinct in a unique index,
-- so a nullable entity_id would silently accumulate duplicate rows and
-- get_de_config would start returning more than one — with the caller taking an
-- arbitrary one.
CREATE TABLE IF NOT EXISTS de_config (
  config_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('de', 'playbook', 'specialist')),
  entity_id   UUID NOT NULL,
  schema_id   UUID REFERENCES de_config_schemas(schema_id) ON DELETE SET NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Named, not anonymous: set_de_config has to target this constraint BY NAME.
  -- See the set_de_config fix below for why the column-list form cannot work.
  CONSTRAINT de_config_entity_uniq UNIQUE (tenant_id, entity_kind, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_de_config_tenant ON de_config(tenant_id);
CREATE INDEX IF NOT EXISTS idx_de_config_entity ON de_config(entity_kind, entity_id);

-- ── 3. de_config_audit_log ──────────────────────────────────────────────────
-- get_config_audit_log selects named columns (not *), so order is free here; the
-- NAMES are the contract: audit_id, changed_at, changed_by, action, field_name,
-- old_value, new_value, details + tenant_id/entity_kind/entity_id for the filter.
CREATE TABLE IF NOT EXISTS de_config_audit_log (
  audit_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  field_name  TEXT,
  old_value   JSONB,
  new_value   JSONB,
  changed_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ DEFAULT NOW(),
  details     TEXT
);
CREATE INDEX IF NOT EXISTS idx_de_config_audit_tenant ON de_config_audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_de_config_audit_entity ON de_config_audit_log(entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS idx_de_config_audit_changed ON de_config_audit_log(changed_at DESC);

-- ── 4. Change history ───────────────────────────────────────────────────────
-- Who changed a DE's governance settings, and when. For a product whose claim is
-- governed autonomy, "reply-mode was switched off on Tuesday" must be answerable.
-- HONEST NOTE: get_config_audit_log currently has no UI caller. This is written
-- so the history EXISTS from the first write rather than starting whenever a
-- screen finally reads it — but it is not yet surfaced to anyone.
CREATE OR REPLACE FUNCTION audit_de_config_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO de_config_audit_log (tenant_id, entity_kind, entity_id, action,
                                     new_value, changed_by, details)
    VALUES (NEW.tenant_id, NEW.entity_kind, NEW.entity_id, 'create',
            NEW.data, NEW.updated_by, 'Configuration created');
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only log a real change; set_de_config rewrites the row on every save.
    IF NEW.data IS DISTINCT FROM OLD.data THEN
      INSERT INTO de_config_audit_log (tenant_id, entity_kind, entity_id, action,
                                       old_value, new_value, changed_by, details)
      VALUES (NEW.tenant_id, NEW.entity_kind, NEW.entity_id, 'update',
              OLD.data, NEW.data, NEW.updated_by, 'Configuration updated');
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO de_config_audit_log (tenant_id, entity_kind, entity_id, action,
                                     old_value, changed_by, details)
    VALUES (OLD.tenant_id, OLD.entity_kind, OLD.entity_id, 'delete',
            OLD.data, auth.uid(), 'Configuration deleted');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS tr_de_config_audit ON de_config;
CREATE TRIGGER tr_de_config_audit
  AFTER INSERT OR UPDATE OR DELETE ON de_config
  FOR EACH ROW EXECUTE FUNCTION audit_de_config_changes();

-- ── 4b. set_de_config could never have worked, table or no table ────────────
-- Found by the assert below, which is the only reason it was found at all.
--
-- The function declares RETURNS TABLE(config_id, tenant_id, entity_kind, ...).
-- In PL/pgSQL those output columns are also VARIABLES in the body. So this line:
--
--     ON CONFLICT (tenant_id, entity_kind, entity_id)
--
-- raises `42702: column reference "tenant_id" is ambiguous` — it could mean the
-- OUT variable or the column. Creating the missing table would NOT have fixed
-- the writer; it would only have moved the error. Had this migration shipped
-- with no behavioural probe, "the config store is restored" would have been a
-- false green, and the reply-mode switch still would not have turned on.
--
-- The conflict TARGET cannot be alias-qualified in PostgreSQL, and renaming the
-- OUT columns would change the JSON keys PostgREST returns — de-answer reads
-- `.data`, so that contract must not move. Targeting the constraint BY NAME
-- sidesteps the ambiguity without touching the signature.
--
-- CREATE OR REPLACE, never DROP+CREATE: dropping a function RESETS ITS GRANTS,
-- and silently re-widening a governance writer is exactly the kind of accident
-- this migration exists to clean up. Body otherwise reproduced verbatim from the
-- LIVE definition (pg_get_functiondef), not from any repo file.
CREATE OR REPLACE FUNCTION public.set_de_config(
  p_tenant_id uuid, p_entity_kind text, p_entity_id uuid, p_config jsonb)
RETURNS TABLE(config_id uuid, tenant_id uuid, entity_kind text, entity_id uuid,
              schema_id uuid, data jsonb, created_at timestamp with time zone,
              updated_at timestamp with time zone, updated_by uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_config_id UUID;
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  INSERT INTO de_config (config_id, tenant_id, entity_kind, entity_id, data, updated_by)
  VALUES (gen_random_uuid(), p_tenant_id, p_entity_kind, p_entity_id, p_config, auth.uid())
  ON CONFLICT ON CONSTRAINT de_config_entity_uniq
  DO UPDATE SET data = p_config, updated_at = NOW(), updated_by = auth.uid()
  RETURNING de_config.config_id INTO v_config_id;
  RETURN QUERY SELECT * FROM de_config dc WHERE dc.config_id = v_config_id;
END$function$;

-- ── 5. Access ───────────────────────────────────────────────────────────────
-- RLS on with NO policy = deny-all for every role except the owner. The
-- SECURITY DEFINER readers/writers run as owner and already call
-- _assert_caller_tenant, so the vetted path keeps working while direct
-- PostgREST access is closed. `authenticated` is the internet: anyone who can
-- sign up holds it, so it must not reach a table of governance settings.
ALTER TABLE de_config_schemas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE de_config           ENABLE ROW LEVEL SECURITY;
ALTER TABLE de_config_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON de_config_schemas   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON de_config           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON de_config_audit_log FROM PUBLIC, anon, authenticated;

-- ── 6. Behavioural asserts ──────────────────────────────────────────────────
-- Both questions, asked honestly:
--   Would these pass if the feature were broken? No — a wrong column ORDER makes
--   get_de_config raise "structure of query does not match function result type";
--   a missing UNIQUE makes set_de_config's ON CONFLICT raise outright.
--   Would these pass if the change were a no-op? No — with no tables, every one
--   of these calls raises 42P01, which is exactly today's production state.
-- The probe writes real rows through the REAL functions and then rolls itself
-- back, so it proves the path end-to-end and leaves nothing behind.
DO $probe$
DECLARE
  v_tenant UUID;
  v_entity UUID := gen_random_uuid();   -- fresh target: cannot collide with data
  v_rows   INT;
  v_val    TEXT;
  v_audit  INT;
BEGIN
  SELECT id INTO v_tenant FROM tenants ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'ASSERT SETUP FAILED: no tenant exists to probe with';
  END IF;

  BEGIN
    -- A1: the writer works at all (this is what throws 42P01 today).
    PERFORM set_de_config(v_tenant, 'de', v_entity,
                          '{"reply_mode_enabled": true}'::jsonb);

    -- A2: the reader returns EXACTLY ONE row, and the value survives the trip.
    -- Reaching this line at all proves the column order matches the contract.
    SELECT count(*), max(data->>'reply_mode_enabled')
      INTO v_rows, v_val
      FROM get_de_config(v_tenant, 'de', v_entity);
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'A2 FAILED: get_de_config returned % rows, expected exactly 1', v_rows;
    END IF;
    IF v_val IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'A2 FAILED: reply_mode_enabled read back as %, expected true', v_val;
    END IF;

    -- A3: a second save UPDATES rather than duplicating. If the UNIQUE were
    -- missing this would be 2 rows and the gate would read an arbitrary one.
    PERFORM set_de_config(v_tenant, 'de', v_entity,
                          '{"reply_mode_enabled": false, "pre_send_audit_enabled": true}'::jsonb);
    SELECT count(*), max(data->>'pre_send_audit_enabled')
      INTO v_rows, v_val
      FROM get_de_config(v_tenant, 'de', v_entity);
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'A3 FAILED: after re-save get_de_config returned % rows, expected 1', v_rows;
    END IF;
    IF v_val IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'A3 FAILED: second write did not land (pre_send_audit_enabled=%)', v_val;
    END IF;

    -- A4: the change is on the record — one create + one update.
    SELECT count(*) INTO v_audit
      FROM get_config_audit_log(v_tenant, 'de', v_entity, 50);
    IF v_audit <> 2 THEN
      RAISE EXCEPTION 'A4 FAILED: expected 2 audit rows (create+update), got %', v_audit;
    END IF;

    -- A5: the schema table the FK points at is real and reachable.
    PERFORM create_config_schema(v_tenant, 'de', v_entity, 'probe schema',
                                 '[]'::jsonb, ARRAY['probe']);
    SELECT count(*) INTO v_rows FROM get_config_schema(v_tenant, 'de', v_entity);
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'A5 FAILED: get_config_schema returned % rows, expected 1', v_rows;
    END IF;

    RAISE EXCEPTION 'assert_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'assert_probe_rollback' THEN RAISE; END IF;
  END;

  RAISE NOTICE '554 asserts passed: set/get/audit/schema all work; probe rolled back.';
END
$probe$;

COMMIT;
