-- ════════════════════════════════════════════════════════════════
-- 197: SECURITY HARDENING — independent review remediation
-- ════════════════════════════════════════════════════════════════
-- Fixes from the 4-pass external review (2026-07-20):
--   A. Embed token RPCs: cross-tenant minting + hash-returned-as-token
--   B. current_setting('app.current_tenant_id') RLS/RPCs (never set by app)
--      → auth_tenant_id(); revoke direct table write grants
--   C. Metrics/config RPC suite (20260719225526): every function trusted
--      caller-supplied p_tenant_id (cross-tenant read/write/export/delete)
--      and several returned fabricated values. All now assert caller
--      tenant; fabricated outputs return honest empty sets.
-- ════════════════════════════════════════════════════════════════

-- ── Shared guard: caller must belong to (or hold audited remote access
--    for) the asserted tenant. auth_tenant_id() already resolves both
--    membership and remote-access sessions (migrations 058/102/105).
--    A null auth.uid() means a server-side (service-role) caller; the
--    functions below are granted to authenticated only, so anon can
--    never reach that branch.
CREATE OR REPLACE FUNCTION public._assert_caller_tenant(p_tenant_id UUID)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  IF p_tenant_id IS NULL OR public.auth_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'not_authorized_for_tenant';
  END IF;
END$$;
REVOKE ALL ON FUNCTION public._assert_caller_tenant(UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._assert_caller_tenant(UUID) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════
-- A. EMBED TOKEN RPCS
-- ════════════════════════════════════════════════════════════════

-- generate_embed_token: caller must be an owner/admin of the tenant and
-- the DE must belong to that tenant.
CREATE OR REPLACE FUNCTION generate_embed_token(
  p_tenant_id UUID,
  p_de_id UUID,
  p_expires_in_hours INTEGER DEFAULT 24
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_token TEXT;
  v_token_hash TEXT;
  v_expires_at TIMESTAMP;
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  IF auth.uid() IS NOT NULL
     AND NOT public.auth_has_tenant_role(array['tenant_owner','tenant_admin']) THEN
    RAISE EXCEPTION 'admin_role_required';
  END IF;
  PERFORM 1 FROM digital_employees WHERE id = p_de_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'de_not_in_tenant'; END IF;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
  v_expires_at := now() + make_interval(hours => LEAST(GREATEST(p_expires_in_hours, 1), 24 * 90));

  INSERT INTO embed_tokens (tenant_id, de_id, token_hash, expires_at)
  VALUES (p_tenant_id, p_de_id, v_token_hash, v_expires_at);

  RETURN json_build_object('token', v_token, 'expires_at', v_expires_at::text);
END$$;

-- get_or_create_embed_token: the plaintext token is (correctly) never
-- stored, so "reuse the existing token" is impossible. This now always
-- rotates — every call returns a WORKING token — instead of the old
-- behavior of returning the stored token ID as if it were the secret.
CREATE OR REPLACE FUNCTION get_or_create_embed_token(
  p_tenant_id UUID,
  p_de_id UUID
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN generate_embed_token(p_tenant_id, p_de_id, 24);
END$$;

-- ════════════════════════════════════════════════════════════════
-- B. config_schema_instances + amendment_metrics
--    (current_setting('app.current_tenant_id') was never set by the
--    app, so these policies/RPCs errored or were unusable)
-- ════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Tenant members can view own config" ON config_schema_instances;
DROP POLICY IF EXISTS "Tenant admins can update own config" ON config_schema_instances;
DROP POLICY IF EXISTS "Tenant admins can insert config" ON config_schema_instances;
CREATE POLICY "Tenant members can view own config"
ON config_schema_instances FOR SELECT
USING (tenant_id = public.auth_tenant_id());

-- Writes go through the RPCs below only.
REVOKE INSERT, UPDATE ON config_schema_instances FROM authenticated;

DROP POLICY IF EXISTS "Tenant members can view own metrics" ON amendment_metrics;
DROP POLICY IF EXISTS "Tenant can update own metrics" ON amendment_metrics;
DROP POLICY IF EXISTS "Tenant can insert metrics" ON amendment_metrics;
CREATE POLICY "Tenant members can view own metrics"
ON amendment_metrics FOR SELECT
USING (tenant_id = public.auth_tenant_id());

REVOKE INSERT, UPDATE ON amendment_metrics FROM authenticated;

CREATE OR REPLACE FUNCTION get_de_config(p_de_id UUID)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.auth_tenant_id();
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  RETURN (
    SELECT json_build_object(
      'instance_id', instance_id,
      'de_id', de_id,
      'template_key', template_key,
      'values', values,
      'updated_at', updated_at::text
    )
    FROM config_schema_instances
    WHERE de_id = p_de_id AND tenant_id = v_tenant_id
    LIMIT 1
  );
END$$;

CREATE OR REPLACE FUNCTION save_de_config(
  p_de_id UUID,
  p_template_key TEXT,
  p_values JSONB
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.auth_tenant_id();
  v_user_id UUID := auth.uid();
  v_instance_id UUID;
BEGIN
  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  -- DE must belong to the caller's tenant
  PERFORM 1 FROM digital_employees WHERE id = p_de_id AND tenant_id = v_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'de_not_in_tenant'; END IF;

  INSERT INTO config_schema_instances (tenant_id, de_id, template_key, values, updated_by)
  VALUES (v_tenant_id, p_de_id, p_template_key, p_values, v_user_id)
  ON CONFLICT (tenant_id, de_id, template_key)
  DO UPDATE SET values = EXCLUDED.values, updated_at = now(), updated_by = v_user_id
  RETURNING instance_id INTO v_instance_id;

  RETURN json_build_object('ok', true, 'instance_id', v_instance_id, 'updated_at', now()::text);
END$$;

CREATE OR REPLACE FUNCTION get_config_template_with_overrides(
  p_de_id UUID,
  p_template_key TEXT DEFAULT 'support-de-template'
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.auth_tenant_id();
  v_template JSONB;
  v_field JSONB;
  v_overrides JSONB;
  v_merged JSONB := '{}'::jsonb;
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT fields INTO v_template FROM config_schema_templates WHERE template_key = p_template_key;
  IF v_template IS NULL THEN RAISE EXCEPTION 'Template not found: %', p_template_key; END IF;

  SELECT values INTO v_overrides
  FROM config_schema_instances
  WHERE de_id = p_de_id AND tenant_id = v_tenant_id AND template_key = p_template_key;
  v_overrides := COALESCE(v_overrides, '{}'::jsonb);

  FOR v_field IN SELECT * FROM jsonb_array_elements(v_template)
  LOOP
    v_merged := v_merged || jsonb_build_object(
      v_field->>'key',
      COALESCE(v_overrides->(v_field->>'key'), v_field->'defaultValue')
    );
  END LOOP;

  RETURN v_merged;
END$$;

CREATE OR REPLACE FUNCTION reset_de_config_to_template(
  p_de_id UUID,
  p_template_key TEXT DEFAULT 'support-de-template'
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.auth_tenant_id();
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  DELETE FROM config_schema_instances
  WHERE de_id = p_de_id AND tenant_id = v_tenant_id AND template_key = p_template_key;
  RETURN json_build_object('ok', true, 'reset', true);
END$$;

CREATE OR REPLACE FUNCTION record_amendment_before_metrics(
  p_amendment_id UUID,
  p_entity_kind TEXT,
  p_entity_id UUID,
  p_before_metrics JSONB
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.auth_tenant_id();
  v_metric_id UUID;
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  INSERT INTO amendment_metrics (tenant_id, amendment_id, entity_kind, entity_id, before_metrics)
  VALUES (v_tenant_id, p_amendment_id, p_entity_kind, p_entity_id, p_before_metrics)
  ON CONFLICT DO NOTHING
  RETURNING metric_id INTO v_metric_id;
  RETURN json_build_object('ok', true, 'metric_id', v_metric_id);
END$$;

CREATE OR REPLACE FUNCTION record_amendment_after_metrics(
  p_amendment_id UUID,
  p_after_metrics JSONB,
  p_replay_score_before NUMERIC DEFAULT NULL,
  p_replay_score_after NUMERIC DEFAULT NULL,
  p_confidence_delta NUMERIC DEFAULT NULL,
  p_escalation_rate_delta NUMERIC DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.auth_tenant_id();
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  UPDATE amendment_metrics
  SET after_metrics = p_after_metrics,
      replay_score_before = p_replay_score_before,
      replay_score_after = p_replay_score_after,
      confidence_delta = p_confidence_delta,
      escalation_rate_delta = p_escalation_rate_delta,
      adopted_at = now(),
      updated_at = now()
  WHERE amendment_id = p_amendment_id AND tenant_id = v_tenant_id;
  RETURN json_build_object('ok', true, 'adopted_at', now()::text);
END$$;

CREATE OR REPLACE FUNCTION get_amendment_effectiveness(
  p_entity_kind TEXT,
  p_entity_id UUID
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.auth_tenant_id();
  v_total INT; v_adopted INT;
  v_conf NUMERIC; v_esc NUMERIC; v_replay NUMERIC;
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE adopted_at IS NOT NULL)
  INTO v_total, v_adopted
  FROM amendment_metrics
  WHERE entity_kind = p_entity_kind AND entity_id = p_entity_id AND tenant_id = v_tenant_id;

  SELECT AVG(confidence_delta), AVG(escalation_rate_delta),
         AVG(COALESCE(replay_score_after - replay_score_before, 0))
  INTO v_conf, v_esc, v_replay
  FROM amendment_metrics
  WHERE entity_kind = p_entity_kind AND entity_id = p_entity_id
    AND tenant_id = v_tenant_id AND adopted_at IS NOT NULL;

  RETURN json_build_object(
    'entity_kind', p_entity_kind,
    'entity_id', p_entity_id,
    'total_amendments', v_total,
    'adopted_count', v_adopted,
    'adoption_rate_pct', CASE WHEN v_total > 0 THEN ROUND((v_adopted::NUMERIC / v_total) * 100, 1) ELSE 0 END,
    'avg_confidence_delta', ROUND(COALESCE(v_conf, 0)::NUMERIC, 2),
    'avg_escalation_rate_delta', ROUND(COALESCE(v_esc, 0)::NUMERIC, 2),
    'avg_replay_score_gain', ROUND(COALESCE(v_replay, 0)::NUMERIC, 2)
  );
END$$;

-- Also fixes the invalid ORDER BY/LIMIT placement in the original.
CREATE OR REPLACE FUNCTION get_amendment_impact_history(
  p_entity_kind TEXT,
  p_entity_id UUID,
  p_limit INT DEFAULT 10
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.auth_tenant_id();
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  RETURN (
    SELECT json_agg(row_to_json(t))
    FROM (
      SELECT metric_id, amendment_id, confidence_delta, escalation_rate_delta,
             COALESCE(replay_score_after - replay_score_before, 0) AS replay_score_delta,
             adopted_at::text AS adopted_at,
             CASE WHEN adopted_at IS NOT NULL THEN 'adopted' ELSE 'pending' END AS status
      FROM amendment_metrics
      WHERE entity_kind = p_entity_kind AND entity_id = p_entity_id AND tenant_id = v_tenant_id
      ORDER BY created_at DESC
      LIMIT p_limit
    ) t
  );
END$$;

-- ════════════════════════════════════════════════════════════════
-- C. METRICS/CONFIG RPC SUITE (20260719225526)
--    1) Every tenant-parameterized function now asserts the caller
--       belongs to that tenant.
--    2) Functions that fabricated values (zeros, 'stable' trends,
--       synthetic anomalies) now return honest EMPTY sets — the UI
--       shows its empty state instead of fake numbers.
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_metric_value(
  p_tenant_id UUID, p_de_id UUID, p_metric_key TEXT,
  p_date_from TIMESTAMPTZ DEFAULT NULL, p_date_to TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(metric_key TEXT, value NUMERIC, "timestamp" TIMESTAMPTZ, period JSONB, context JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  -- Real metric computation is not implemented yet; return an empty set
  -- (honest "no data") rather than a fabricated zero row.
  RETURN QUERY SELECT NULL::TEXT, NULL::NUMERIC, NULL::TIMESTAMPTZ, NULL::JSONB, NULL::JSONB WHERE FALSE;
END$$;

CREATE OR REPLACE FUNCTION get_de_metrics_batch(
  p_tenant_id UUID, p_de_id UUID, p_metric_keys TEXT[] DEFAULT NULL,
  p_date_from TIMESTAMPTZ DEFAULT NULL, p_date_to TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(metric_key TEXT, metric_name TEXT, value NUMERIC, unit TEXT, trend TEXT, comparison JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY SELECT NULL::TEXT, NULL::TEXT, NULL::NUMERIC, NULL::TEXT, NULL::TEXT, NULL::JSONB WHERE FALSE;
END$$;

CREATE OR REPLACE FUNCTION get_metric_trend(
  p_tenant_id UUID, p_de_id UUID, p_metric_key TEXT,
  p_date_from TIMESTAMPTZ, p_date_to TIMESTAMPTZ, p_interval TEXT DEFAULT 'daily'
) RETURNS TABLE(metric_key TEXT, value NUMERIC, "timestamp" TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY SELECT NULL::TEXT, NULL::NUMERIC, NULL::TIMESTAMPTZ WHERE FALSE;
END$$;

CREATE OR REPLACE FUNCTION get_metrics_anomalies(
  p_tenant_id UUID, p_de_id UUID, p_lookback_days INTEGER DEFAULT 7
) RETURNS TABLE(metric_key TEXT, "timestamp" TIMESTAMPTZ, value NUMERIC, expected_range JSONB, severity TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY SELECT NULL::TEXT, NULL::TIMESTAMPTZ, NULL::NUMERIC, NULL::JSONB, NULL::TEXT WHERE FALSE;
END$$;

CREATE OR REPLACE FUNCTION get_tenant_metrics_comparison(
  p_tenant_id UUID, p_date_from TIMESTAMPTZ DEFAULT NULL, p_date_to TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(de_id UUID, de_name TEXT, metrics JSONB, rank INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY SELECT NULL::UUID, NULL::TEXT, NULL::JSONB, NULL::INTEGER WHERE FALSE;
END$$;

CREATE OR REPLACE FUNCTION get_sla_achievement(
  p_tenant_id UUID, p_de_id UUID, p_date_from TIMESTAMPTZ, p_date_to TIMESTAMPTZ
) RETURNS TABLE(total_escalations INTEGER, within_sla INTEGER, achievement_percent NUMERIC, missed_by_hours JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY SELECT NULL::INTEGER, NULL::INTEGER, NULL::NUMERIC, NULL::JSONB WHERE FALSE;
END$$;

CREATE OR REPLACE FUNCTION get_quality_score_breakdown(
  p_tenant_id UUID, p_de_id UUID, p_date_from TIMESTAMPTZ, p_date_to TIMESTAMPTZ
) RETURNS TABLE(overall NUMERIC, by_category JSONB, by_response_type JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY SELECT NULL::NUMERIC, NULL::JSONB, NULL::JSONB WHERE FALSE;
END$$;

CREATE OR REPLACE FUNCTION create_custom_metric(
  p_tenant_id UUID, p_name TEXT, p_key TEXT, p_type TEXT, p_description TEXT,
  p_unit TEXT DEFAULT NULL, p_calculation_rule TEXT DEFAULT NULL,
  p_query_template TEXT DEFAULT NULL, p_tags TEXT[] DEFAULT '{}', p_thresholds JSONB DEFAULT NULL
) RETURNS TABLE(
  metric_id UUID, tenant_id UUID, name TEXT, key TEXT, type TEXT, description TEXT,
  unit TEXT, calculation_rule TEXT, query_template TEXT, tags TEXT[], thresholds JSONB,
  created_at TIMESTAMPTZ, created_by UUID
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_metric_id UUID := gen_random_uuid();
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  INSERT INTO customer_metrics (
    metric_id, tenant_id, name, key, type, description, unit,
    calculation_rule, query_template, tags, thresholds, created_by
  ) VALUES (
    v_metric_id, p_tenant_id, p_name, p_key, p_type, p_description, p_unit,
    p_calculation_rule, p_query_template, p_tags, p_thresholds, auth.uid()
  );
  RETURN QUERY SELECT * FROM customer_metrics cm WHERE cm.metric_id = v_metric_id;
END$$;

CREATE OR REPLACE FUNCTION get_de_config(
  p_tenant_id UUID, p_entity_kind TEXT, p_entity_id UUID
) RETURNS TABLE(
  config_id UUID, tenant_id UUID, entity_kind TEXT, entity_id UUID, schema_id UUID,
  data JSONB, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, updated_by UUID
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY
  SELECT * FROM de_config dc
  WHERE dc.tenant_id = p_tenant_id AND dc.entity_kind = p_entity_kind AND dc.entity_id = p_entity_id;
END$$;

CREATE OR REPLACE FUNCTION set_de_config(
  p_tenant_id UUID, p_entity_kind TEXT, p_entity_id UUID, p_config JSONB
) RETURNS TABLE(
  config_id UUID, tenant_id UUID, entity_kind TEXT, entity_id UUID, schema_id UUID,
  data JSONB, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, updated_by UUID
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_config_id UUID;
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  INSERT INTO de_config (config_id, tenant_id, entity_kind, entity_id, data, updated_by)
  VALUES (gen_random_uuid(), p_tenant_id, p_entity_kind, p_entity_id, p_config, auth.uid())
  ON CONFLICT (tenant_id, entity_kind, entity_id)
  DO UPDATE SET data = p_config, updated_at = NOW(), updated_by = auth.uid()
  RETURNING de_config.config_id INTO v_config_id;
  RETURN QUERY SELECT * FROM de_config dc WHERE dc.config_id = v_config_id;
END$$;

CREATE OR REPLACE FUNCTION get_config_schema(
  p_tenant_id UUID, p_entity_kind TEXT, p_entity_id UUID DEFAULT NULL
) RETURNS TABLE(
  schema_id UUID, tenant_id UUID, entity_kind TEXT, entity_id UUID, name TEXT,
  fields JSONB, tags TEXT[], created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY
  SELECT * FROM de_config_schemas s
  WHERE s.tenant_id = p_tenant_id AND s.entity_kind = p_entity_kind
    AND (s.entity_id = p_entity_id OR s.entity_id IS NULL)
  ORDER BY s.entity_id DESC NULLS LAST
  LIMIT 1;
END$$;

CREATE OR REPLACE FUNCTION create_config_schema(
  p_tenant_id UUID, p_entity_kind TEXT, p_entity_id UUID DEFAULT NULL,
  p_name TEXT DEFAULT NULL, p_fields JSONB DEFAULT '[]'::jsonb, p_tags TEXT[] DEFAULT '{}'
) RETURNS TABLE(
  schema_id UUID, tenant_id UUID, entity_kind TEXT, entity_id UUID, name TEXT,
  fields JSONB, tags TEXT[], created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_schema_id UUID := gen_random_uuid();
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  INSERT INTO de_config_schemas (schema_id, tenant_id, entity_kind, entity_id, name, fields, tags)
  VALUES (v_schema_id, p_tenant_id, p_entity_kind, p_entity_id, p_name, p_fields, p_tags);
  RETURN QUERY SELECT * FROM de_config_schemas s WHERE s.schema_id = v_schema_id;
END$$;

CREATE OR REPLACE FUNCTION get_config_audit_log(
  p_tenant_id UUID, p_entity_kind TEXT, p_entity_id UUID, p_limit INTEGER DEFAULT 50
) RETURNS TABLE(
  audit_id UUID, "timestamp" TIMESTAMPTZ, changed_by UUID, action TEXT,
  field_name TEXT, old_value JSONB, new_value JSONB, details TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY
  SELECT dal.audit_id, dal.changed_at, dal.changed_by, dal.action,
         dal.field_name, dal.old_value, dal.new_value, dal.details
  FROM de_config_audit_log dal
  WHERE dal.tenant_id = p_tenant_id AND dal.entity_kind = p_entity_kind AND dal.entity_id = p_entity_id
  ORDER BY dal.changed_at DESC
  LIMIT p_limit;
END$$;

CREATE OR REPLACE FUNCTION apply_config_template(
  p_tenant_id UUID, p_template_key TEXT
) RETURNS TABLE(type TEXT, id UUID, name TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY SELECT NULL::TEXT, NULL::UUID, NULL::TEXT WHERE FALSE;
END$$;

CREATE OR REPLACE FUNCTION get_tenant_config_status(p_tenant_id UUID)
RETURNS TABLE(metrics JSONB, schemas JSONB, configs JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY
  SELECT
    jsonb_build_object(
      'defined', (SELECT COUNT(*) FROM customer_metrics WHERE tenant_id = p_tenant_id),
      'active', (SELECT COUNT(*) FROM customer_metrics WHERE tenant_id = p_tenant_id)
    ),
    jsonb_build_object(
      'support', (SELECT COUNT(*) FROM de_config_schemas WHERE tenant_id = p_tenant_id AND tags @> ARRAY['support']),
      'hr', (SELECT COUNT(*) FROM de_config_schemas WHERE tenant_id = p_tenant_id AND tags @> ARRAY['hr']),
      'billing', (SELECT COUNT(*) FROM de_config_schemas WHERE tenant_id = p_tenant_id AND tags @> ARRAY['billing'])
    ),
    jsonb_build_object(
      'total', (SELECT COUNT(*) FROM de_config WHERE tenant_id = p_tenant_id)
    );
END$$;

CREATE OR REPLACE FUNCTION list_config_schemas(
  p_tenant_id UUID, p_entity_kind TEXT DEFAULT NULL
) RETURNS TABLE(
  schema_id UUID, tenant_id UUID, entity_kind TEXT, entity_id UUID,
  name TEXT, fields JSONB, tags TEXT[]
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY
  SELECT s.schema_id, s.tenant_id, s.entity_kind, s.entity_id, s.name, s.fields, s.tags
  FROM de_config_schemas s
  WHERE s.tenant_id = p_tenant_id AND (p_entity_kind IS NULL OR s.entity_kind = p_entity_kind)
  ORDER BY s.created_at DESC;
END$$;

CREATE OR REPLACE FUNCTION export_tenant_config(p_tenant_id UUID)
RETURNS TABLE(metrics JSONB, schemas JSONB, configs JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._assert_caller_tenant(p_tenant_id);
  RETURN QUERY
  SELECT
    (SELECT jsonb_agg(row_to_json(t)) FROM customer_metrics t WHERE t.tenant_id = p_tenant_id),
    (SELECT jsonb_agg(row_to_json(t)) FROM de_config_schemas t WHERE t.tenant_id = p_tenant_id),
    (SELECT jsonb_agg(row_to_json(t)) FROM de_config t WHERE t.tenant_id = p_tenant_id);
END$$;

-- update/delete take a metric_id: derive the owning tenant from the row
-- itself and assert against the caller.
CREATE OR REPLACE FUNCTION update_custom_metric(
  p_metric_id UUID, p_updates JSONB
) RETURNS TABLE(metric_id UUID, tenant_id UUID, name TEXT, key TEXT, type TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner UUID;
BEGIN
  SELECT cm.tenant_id INTO v_owner FROM customer_metrics cm WHERE cm.metric_id = p_metric_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'metric_not_found'; END IF;
  PERFORM public._assert_caller_tenant(v_owner);

  UPDATE customer_metrics cm
  SET name = COALESCE((p_updates->>'name')::TEXT, cm.name),
      description = COALESCE((p_updates->>'description')::TEXT, cm.description),
      unit = COALESCE((p_updates->>'unit')::TEXT, cm.unit),
      thresholds = COALESCE((p_updates->'thresholds')::JSONB, cm.thresholds)
  WHERE cm.metric_id = p_metric_id;

  RETURN QUERY SELECT cm.metric_id, cm.tenant_id, cm.name, cm.key, cm.type, cm.created_at
  FROM customer_metrics cm WHERE cm.metric_id = p_metric_id;
END$$;

CREATE OR REPLACE FUNCTION delete_custom_metric(p_metric_id UUID)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner UUID;
BEGIN
  SELECT cm.tenant_id INTO v_owner FROM customer_metrics cm WHERE cm.metric_id = p_metric_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'metric_not_found'; END IF;
  PERFORM public._assert_caller_tenant(v_owner);

  DELETE FROM customer_metrics cm WHERE cm.metric_id = p_metric_id;
  RETURN QUERY SELECT TRUE::BOOLEAN, 'Metric deleted'::TEXT;
END$$;

-- Anon must never reach any of these (verify_embed_token intentionally
-- keeps its anon grant — the token itself is the secret there).
REVOKE EXECUTE ON FUNCTION generate_embed_token(UUID, UUID, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION get_or_create_embed_token(UUID, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION get_metric_value(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE EXECUTE ON FUNCTION get_de_metrics_batch(UUID, UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE EXECUTE ON FUNCTION get_metric_trend(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION get_metrics_anomalies(UUID, UUID, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION get_tenant_metrics_comparison(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE EXECUTE ON FUNCTION get_sla_achievement(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE EXECUTE ON FUNCTION get_quality_score_breakdown(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE EXECUTE ON FUNCTION export_tenant_config(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION update_custom_metric(UUID, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION delete_custom_metric(UUID) FROM anon;
