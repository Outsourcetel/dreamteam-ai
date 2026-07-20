-- ════════════════════════════════════════════════════════════════
-- 205: TENANT-EXTENSIBLE ROLE CONFIGURATION (Wave 2)
-- ════════════════════════════════════════════════════════════════
-- Founder feedback: "Skills/KPIs hardcoded", "Escalation Rules + trust
-- dial must be custom". They were not merely hardcoded in the UI — they
-- were locked at the database boundary:
--
--   de_kpis.metric_key       CHECK over exactly 7 platform metrics
--   skill_catalog            5 global rows, NO tenant_id at all
--   skill_catalog.category   CHECK over 5 categories
--   de_certifications.cert_type CHECK over 3 types
--   de_escalation_rules      one threshold + a topic list, nothing named
--
-- So no tenant could express a KPI, skill, or escalation rule that
-- matters to their business. This converts each closed enum into a
-- reference table carrying global rows (tenant_id IS NULL, available to
-- everyone) plus per-tenant rows — the same pattern already used for
-- specialist categories in Wave 0.2.
--
-- HONESTY CONSTRAINT that shapes the design:
-- the 7 built-in KPIs are COMPUTED from telemetry. A tenant-defined KPI
-- has no computation path, so offering one that silently shows blank
-- forever would be worse than not offering it. Every catalog entry
-- therefore declares source='computed' (platform derives it) or
-- source='manual' (a human records readings), and manual metrics get a
-- real place to store those readings.
-- ════════════════════════════════════════════════════════════════

-- ── 1. KPI metric catalog ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS kpi_metric_catalog (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = built-in
  metric_key  text NOT NULL,
  label       text NOT NULL,
  description text,
  direction   text NOT NULL DEFAULT 'higher' CHECK (direction IN ('higher','lower')),
  unit        text,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('computed','manual')),
  sort_order  int NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- NULLs never compare equal, so global and per-tenant uniqueness need
-- two partial indexes rather than one constraint.
CREATE UNIQUE INDEX IF NOT EXISTS kpi_metric_catalog_global_key
  ON kpi_metric_catalog (metric_key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS kpi_metric_catalog_tenant_key
  ON kpi_metric_catalog (tenant_id, metric_key) WHERE tenant_id IS NOT NULL;

INSERT INTO kpi_metric_catalog (tenant_id, metric_key, label, direction, unit, source, sort_order)
VALUES
  (NULL, 'resolution_rate',        'Resolution rate',        'higher', '%',     'computed', 10),
  (NULL, 'avg_confidence',         'Average confidence',     'higher', '%',     'computed', 20),
  (NULL, 'escalation_rate',        'Escalation rate',        'lower',  '%',     'computed', 30),
  (NULL, 'error_rate',             'Error rate',             'lower',  '%',     'computed', 40),
  (NULL, 'csat_pct',               'Positive CSAT',          'higher', '%',     'computed', 50),
  (NULL, 'high_frustration_count', 'High-frustration cases', 'lower',  'cases', 'computed', 60),
  (NULL, 'total_decisions',        'Decisions handled',      'higher', 'count', 'computed', 70)
ON CONFLICT DO NOTHING;

ALTER TABLE kpi_metric_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read global and own kpi metrics" ON kpi_metric_catalog;
CREATE POLICY "read global and own kpi metrics" ON kpi_metric_catalog
  FOR SELECT USING (tenant_id IS NULL OR tenant_id = public.auth_tenant_id());

-- ── 2. Readings for manual metrics ──────────────────────────────
CREATE TABLE IF NOT EXISTS de_kpi_readings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id       uuid NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  metric_key  text NOT NULL,
  value       numeric NOT NULL,
  as_of       date NOT NULL DEFAULT current_date,
  recorded_by uuid REFERENCES auth.users(id),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS de_kpi_readings_latest
  ON de_kpi_readings (de_id, metric_key, as_of DESC);

ALTER TABLE de_kpi_readings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant reads kpi readings" ON de_kpi_readings;
CREATE POLICY "tenant reads kpi readings" ON de_kpi_readings
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

-- ── 3. Replace the metric_key CHECK with catalog validation ─────
ALTER TABLE de_kpis DROP CONSTRAINT IF EXISTS de_kpis_metric_key_check;

CREATE OR REPLACE FUNCTION public.assert_kpi_metric_known()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kpi_metric_catalog c
     WHERE c.metric_key = NEW.metric_key
       AND (c.tenant_id IS NULL OR c.tenant_id = NEW.tenant_id)
  ) THEN
    RAISE EXCEPTION 'unknown_metric_key: % — add it to your KPI catalog first', NEW.metric_key;
  END IF;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS de_kpis_metric_known ON de_kpis;
CREATE TRIGGER de_kpis_metric_known
  BEFORE INSERT OR UPDATE OF metric_key ON de_kpis
  FOR EACH ROW EXECUTE FUNCTION public.assert_kpi_metric_known();

-- ── 4. Skills: per-tenant entries + open categories ─────────────
-- skill_catalog's PRIMARY KEY is skill_key itself, and de_skills.skill_key
-- carries a FOREIGN KEY to it. Repointing that PK so two tenants could each
-- own the key 'refunds' would mean dropping and rebuilding a foreign key
-- over live skill-assessment data — not worth the risk here.
--
-- Instead the stored key stays globally unique by namespacing tenant rows
-- ('t<8 hex>_<key>', applied inside upsert_tenant_skill). Two tenants can
-- both create a skill they call "refunds"; neither can see or collide with
-- the other's row, and the FK is untouched. Users only ever see `name`.
ALTER TABLE skill_catalog ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE skill_catalog DROP CONSTRAINT IF EXISTS skill_catalog_category_check;

CREATE TABLE IF NOT EXISTS skill_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = built-in
  key        text NOT NULL,
  label      text NOT NULL,
  sort_order int NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_categories_global_key
  ON skill_categories (key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS skill_categories_tenant_key
  ON skill_categories (tenant_id, key) WHERE tenant_id IS NOT NULL;

INSERT INTO skill_categories (tenant_id, key, label, sort_order) VALUES
  (NULL, 'domain', 'Domain', 10), (NULL, 'process', 'Process', 20),
  (NULL, 'communication', 'Communication', 30), (NULL, 'analytical', 'Analytical', 40),
  (NULL, 'integration', 'Integration', 50)
ON CONFLICT DO NOTHING;

ALTER TABLE skill_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read global and own skill categories" ON skill_categories;
CREATE POLICY "read global and own skill categories" ON skill_categories
  FOR SELECT USING (tenant_id IS NULL OR tenant_id = public.auth_tenant_id());

-- skill_catalog had no RLS because it was a fixed global list; now that it
-- carries tenant rows it needs the same global-or-mine rule.
ALTER TABLE skill_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read global and own skills" ON skill_catalog;
CREATE POLICY "read global and own skills" ON skill_catalog
  FOR SELECT USING (tenant_id IS NULL OR tenant_id = public.auth_tenant_id());

-- ── 5. Certification types ──────────────────────────────────────
ALTER TABLE de_certifications DROP CONSTRAINT IF EXISTS de_certifications_cert_type_check;

CREATE TABLE IF NOT EXISTS certification_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = built-in
  key        text NOT NULL,
  label      text NOT NULL,
  description text,
  sort_order int NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX IF NOT EXISTS certification_types_global_key
  ON certification_types (key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS certification_types_tenant_key
  ON certification_types (tenant_id, key) WHERE tenant_id IS NOT NULL;

INSERT INTO certification_types (tenant_id, key, label, description, sort_order) VALUES
  (NULL, 'workspace',  'Workspace',  'Cleared to operate in this workspace', 10),
  (NULL, 'compliance', 'Compliance', 'Meets a regulatory or policy requirement', 20),
  (NULL, 'capability', 'Capability', 'Proven competent at a specific capability', 30)
ON CONFLICT DO NOTHING;

ALTER TABLE certification_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read global and own cert types" ON certification_types;
CREATE POLICY "read global and own cert types" ON certification_types
  FOR SELECT USING (tenant_id IS NULL OR tenant_id = public.auth_tenant_id());

-- ── 6. Named, custom escalation rules ───────────────────────────
-- Shape: [{"name":..., "when":..., "action":"escalate"|"require_approval", "enabled":bool}]
-- The existing frustration_threshold / always_escalate_topics keep working;
-- this adds the tenant's own named conditions alongside them.
ALTER TABLE de_escalation_rules ADD COLUMN IF NOT EXISTS custom_rules jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The table models one rule row per DE but never enforced it, so the upsert
-- below had no conflict target. Table is empty today, so this is safe.
CREATE UNIQUE INDEX IF NOT EXISTS de_escalation_rules_de_id_key
  ON de_escalation_rules (de_id);

-- ── 7. KPI status: computed metrics OR latest manual reading ────
-- Also collapses the original triple-repeated CASE expression into one
-- jsonb lookup — same results, one place to change.
CREATE OR REPLACE FUNCTION public.get_de_kpi_status(p_de_id uuid)
RETURNS TABLE(kpi_id uuid, name text, metric_key text, target numeric, direction text, current numeric, met boolean, sample bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant uuid;
  m record;
  v_csat numeric;
  v_csat_n bigint;
  v_vals jsonb;
  v_samples jsonb;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then return; end if;
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth_tenant_id() is distinct from v_tenant then
      raise exception 'not a member of this workspace';
    end if;
  end if;

  select * into m from get_de_performance_metrics(v_tenant, 13) where de_id = p_de_id;

  select round(100.0 * count(*) filter (where csat_score = 1) / nullif(count(*) filter (where csat_submitted_at is not null), 0), 1),
         count(*) filter (where csat_submitted_at is not null)
    into v_csat, v_csat_n
  from de_conversations where tenant_id = v_tenant and de_id = p_de_id;

  v_vals := jsonb_strip_nulls(jsonb_build_object(
    'resolution_rate',        case when coalesce(m.total_decisions, 0) >= 1 then m.resolution_rate end,
    'avg_confidence',         case when coalesce(m.total_decisions, 0) >= 1 then m.avg_confidence end,
    'escalation_rate',        case when coalesce(m.total_decisions, 0) >= 1 then m.escalation_rate end,
    'error_rate',             case when coalesce(m.total_runs, 0) >= 1 then m.error_rate end,
    'csat_pct',               v_csat,
    'high_frustration_count', case when coalesce(m.total_decisions, 0) >= 1 then m.high_frustration_count::numeric end,
    'total_decisions',        coalesce(m.total_decisions, 0)::numeric
  ));
  v_samples := jsonb_build_object('csat_pct', v_csat_n);

  return query
  select k.id, k.name, k.metric_key, k.target, k.direction,
         cur.v,
         case when cur.v is null then null
              when k.direction = 'higher' then cur.v >= k.target
              else cur.v <= k.target end,
         coalesce((v_samples->>k.metric_key)::bigint, r.n, coalesce(m.total_decisions, 0))
  from de_kpis k
  -- Latest manual reading, used when the platform does not compute this metric.
  left join lateral (
    select d.value, count(*) over () as n
      from de_kpi_readings d
     where d.de_id = k.de_id and d.metric_key = k.metric_key
     order by d.as_of desc, d.created_at desc
     limit 1
  ) r on true
  cross join lateral (
    select coalesce((v_vals->>k.metric_key)::numeric, r.value) as v
  ) cur
  where k.de_id = p_de_id
  order by k.created_at;
end;
$function$;

-- ── 8. Write paths ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_kpi_metric(
  p_metric_key text, p_label text, p_direction text DEFAULT 'higher',
  p_unit text DEFAULT NULL, p_description text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := auth_tenant_id(); v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN RAISE EXCEPTION 'insufficient_role'; END IF;
  IF p_metric_key !~ '^[a-z0-9_]{2,60}$' THEN
    RAISE EXCEPTION 'metric_key must be lowercase letters, numbers and underscores';
  END IF;
  -- A tenant may not shadow a built-in key; that would silently change
  -- which value the computed lookup returns.
  IF EXISTS (SELECT 1 FROM kpi_metric_catalog WHERE tenant_id IS NULL AND metric_key = p_metric_key) THEN
    RAISE EXCEPTION 'metric_key_reserved: % is a built-in metric', p_metric_key;
  END IF;

  INSERT INTO kpi_metric_catalog (tenant_id, metric_key, label, direction, unit, description, source)
  VALUES (v_tenant, p_metric_key, p_label, coalesce(p_direction,'higher'), p_unit, p_description, 'manual')
  ON CONFLICT (tenant_id, metric_key) WHERE tenant_id IS NOT NULL
  DO UPDATE SET label = excluded.label, direction = excluded.direction,
                unit = excluded.unit, description = excluded.description
  RETURNING id INTO v_id;
  RETURN v_id;
END$$;

CREATE OR REPLACE FUNCTION public.record_kpi_reading(
  p_de_id uuid, p_metric_key text, p_value numeric,
  p_as_of date DEFAULT current_date, p_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := auth_tenant_id(); v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM digital_employees WHERE id = p_de_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'de_not_found';
  END IF;
  INSERT INTO de_kpi_readings (tenant_id, de_id, metric_key, value, as_of, recorded_by, note)
  VALUES (v_tenant, p_de_id, p_metric_key, p_value, coalesce(p_as_of, current_date), auth.uid(), p_note)
  RETURNING id INTO v_id;
  RETURN v_id;
END$$;

-- Returns the STORED (namespaced) key — that is what de_skills references.
CREATE OR REPLACE FUNCTION public.upsert_tenant_skill(
  p_skill_key text, p_name text, p_category text,
  p_description text DEFAULT NULL, p_signal_label text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := auth_tenant_id(); v_key text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN RAISE EXCEPTION 'insufficient_role'; END IF;
  IF p_skill_key !~ '^[a-z0-9_]{2,60}$' THEN
    RAISE EXCEPTION 'skill_key must be lowercase letters, numbers and underscores';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM skill_categories WHERE key = p_category AND (tenant_id IS NULL OR tenant_id = v_tenant)
  ) THEN
    RAISE EXCEPTION 'unknown_skill_category: %', p_category;
  END IF;

  -- Namespaced so one tenant's "refunds" never collides with another's.
  v_key := 't' || substr(replace(v_tenant::text, '-', ''), 1, 8) || '_' || p_skill_key;

  -- description / signal_label are NOT NULL on this table; fall back to the
  -- name rather than making the caller supply boilerplate.
  INSERT INTO skill_catalog (tenant_id, skill_key, name, category, description, signal_label, higher_is_better, min_sample, sort_order)
  VALUES (v_tenant, v_key, p_name, p_category,
          coalesce(nullif(p_description, ''), p_name),
          coalesce(nullif(p_signal_label, ''), 'Assessed from work signals'),
          true, 5, 500)
  ON CONFLICT (skill_key) DO UPDATE
    SET name = excluded.name, category = excluded.category,
        description = excluded.description, signal_label = excluded.signal_label
    WHERE skill_catalog.tenant_id = v_tenant;   -- never overwrite a built-in
  RETURN v_key;
END$$;

CREATE OR REPLACE FUNCTION public.set_de_custom_escalation_rules(p_de_id uuid, p_rules jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN RAISE EXCEPTION 'insufficient_role'; END IF;
  IF NOT EXISTS (SELECT 1 FROM digital_employees WHERE id = p_de_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'de_not_found';
  END IF;
  IF jsonb_typeof(p_rules) <> 'array' THEN RAISE EXCEPTION 'rules_must_be_an_array'; END IF;

  INSERT INTO de_escalation_rules (tenant_id, de_id, custom_rules, updated_by, updated_at)
  VALUES (v_tenant, p_de_id, p_rules, auth.uid(), now())
  ON CONFLICT (de_id) DO UPDATE
    SET custom_rules = excluded.custom_rules, updated_by = excluded.updated_by, updated_at = now();

  PERFORM append_audit_event(
    v_tenant, 'Workspace', 'human', 'Escalation rules updated', 'config_change',
    jsonb_build_object('de_id', p_de_id, 'rule_count', jsonb_array_length(p_rules))
  );
  RETURN jsonb_build_object('ok', true, 'rule_count', jsonb_array_length(p_rules));
END$$;

-- ── 9. Effective catalogs for the UI (global + this tenant) ─────
CREATE OR REPLACE FUNCTION public.list_kpi_metrics()
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.sort_order, x.label), '[]'::json) FROM (
    SELECT metric_key, label, description, direction, unit, source, sort_order,
           (tenant_id IS NOT NULL) AS is_custom
      FROM kpi_metric_catalog
     WHERE tenant_id IS NULL OR tenant_id = auth_tenant_id()
  ) x;
$$;

CREATE OR REPLACE FUNCTION public.list_skill_categories()
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.sort_order, x.label), '[]'::json) FROM (
    SELECT key, label, sort_order, (tenant_id IS NOT NULL) AS is_custom
      FROM skill_categories
     WHERE tenant_id IS NULL OR tenant_id = auth_tenant_id()
  ) x;
$$;

CREATE OR REPLACE FUNCTION public.list_certification_types()
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.sort_order, x.label), '[]'::json) FROM (
    SELECT key, label, description, sort_order, (tenant_id IS NOT NULL) AS is_custom
      FROM certification_types
     WHERE tenant_id IS NULL OR tenant_id = auth_tenant_id()
  ) x;
$$;

-- ── 10. Grants ──────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.upsert_kpi_metric(text, text, text, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.record_kpi_reading(uuid, text, numeric, date, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.upsert_tenant_skill(text, text, text, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.set_de_custom_escalation_rules(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_kpi_metric(text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_kpi_reading(uuid, text, numeric, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_tenant_skill(text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_de_custom_escalation_rules(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_kpi_metrics() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_skill_categories() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_certification_types() TO authenticated, service_role;
GRANT SELECT ON kpi_metric_catalog, skill_categories, certification_types, de_kpi_readings TO authenticated;
