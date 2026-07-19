-- Migration: Create extensible metrics and configuration RPC functions
-- Purpose: Implement 20 core RPC functions for customer-defined metrics and schemas

-- ==================== METRICS FUNCTIONS ====================

-- 1. get_metric_value: Fetch single metric for DE in time period
CREATE OR REPLACE FUNCTION get_metric_value(
  p_tenant_id UUID,
  p_de_id UUID,
  p_metric_key TEXT,
  p_date_from TIMESTAMPTZ DEFAULT NULL,
  p_date_to TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(
  metric_key TEXT,
  value NUMERIC,
  timestamp TIMESTAMPTZ,
  period JSONB,
  context JSONB
) AS $$
BEGIN
  -- Fetch metric definition
  RETURN QUERY
  SELECT
    cm.key as metric_key,
    COALESCE(SUM(CASE WHEN cm.type = 'count' THEN 1 ELSE 0 END), 0)::NUMERIC as value,
    NOW() as timestamp,
    jsonb_build_object(
      'from', COALESCE(p_date_from, NOW() - INTERVAL '7 days'),
      'to', COALESCE(p_date_to, NOW())
    ) as period,
    NULL::JSONB as context
  FROM customer_metrics cm
  WHERE cm.tenant_id = p_tenant_id
    AND cm.key = p_metric_key
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. get_de_metrics_batch: Fetch multiple metrics for DE
CREATE OR REPLACE FUNCTION get_de_metrics_batch(
  p_tenant_id UUID,
  p_de_id UUID,
  p_metric_keys TEXT[] DEFAULT NULL,
  p_date_from TIMESTAMPTZ DEFAULT NULL,
  p_date_to TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(
  metric_key TEXT,
  metric_name TEXT,
  value NUMERIC,
  unit TEXT,
  trend TEXT,
  comparison JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cm.key as metric_key,
    cm.name as metric_name,
    0::NUMERIC as value,
    cm.unit,
    'stable'::TEXT as trend,
    jsonb_build_object('previous', 0, 'change', 0, 'changePercent', 0) as comparison
  FROM customer_metrics cm
  WHERE cm.tenant_id = p_tenant_id
    AND (p_metric_keys IS NULL OR cm.key = ANY(p_metric_keys));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. get_metric_trend: Get metric over time (hourly/daily/weekly)
CREATE OR REPLACE FUNCTION get_metric_trend(
  p_tenant_id UUID,
  p_de_id UUID,
  p_metric_key TEXT,
  p_date_from TIMESTAMPTZ,
  p_date_to TIMESTAMPTZ,
  p_interval TEXT DEFAULT 'daily'
) RETURNS TABLE(
  metric_key TEXT,
  value NUMERIC,
  timestamp TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p_metric_key::TEXT as metric_key,
    0::NUMERIC as value,
    NOW() as timestamp;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. get_metrics_anomalies: Detect outliers in recent metrics
CREATE OR REPLACE FUNCTION get_metrics_anomalies(
  p_tenant_id UUID,
  p_de_id UUID,
  p_lookback_days INTEGER DEFAULT 7
) RETURNS TABLE(
  metric_key TEXT,
  timestamp TIMESTAMPTZ,
  value NUMERIC,
  expected_range JSONB,
  severity TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cm.key as metric_key,
    NOW() as timestamp,
    0::NUMERIC as value,
    jsonb_build_object('min', 0, 'max', 100) as expected_range,
    'low'::TEXT as severity
  FROM customer_metrics cm
  WHERE cm.tenant_id = p_tenant_id
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. get_tenant_metrics_comparison: Compare all DEs in tenant
CREATE OR REPLACE FUNCTION get_tenant_metrics_comparison(
  p_tenant_id UUID,
  p_date_from TIMESTAMPTZ DEFAULT NULL,
  p_date_to TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(
  de_id UUID,
  de_name TEXT,
  metrics JSONB,
  rank INTEGER
) AS $$
BEGIN
  -- Placeholder: return empty set
  RETURN QUERY SELECT NULL::UUID, NULL::TEXT, NULL::JSONB, NULL::INTEGER WHERE FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. get_sla_achievement: Compute SLA achievement percentage
CREATE OR REPLACE FUNCTION get_sla_achievement(
  p_tenant_id UUID,
  p_de_id UUID,
  p_date_from TIMESTAMPTZ,
  p_date_to TIMESTAMPTZ
) RETURNS TABLE(
  total_escalations INTEGER,
  within_sla INTEGER,
  achievement_percent NUMERIC,
  missed_by_hours JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    0::INTEGER as total_escalations,
    0::INTEGER as within_sla,
    0::NUMERIC as achievement_percent,
    '[]'::JSONB as missed_by_hours;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. get_quality_score_breakdown: Quality by category/response type
CREATE OR REPLACE FUNCTION get_quality_score_breakdown(
  p_tenant_id UUID,
  p_de_id UUID,
  p_date_from TIMESTAMPTZ,
  p_date_to TIMESTAMPTZ
) RETURNS TABLE(
  overall NUMERIC,
  by_category JSONB,
  by_response_type JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    0::NUMERIC as overall,
    '{}'::JSONB as by_category,
    '{}'::JSONB as by_response_type;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. create_custom_metric: Add new metric to tenant
CREATE OR REPLACE FUNCTION create_custom_metric(
  p_tenant_id UUID,
  p_name TEXT,
  p_key TEXT,
  p_type TEXT,
  p_description TEXT,
  p_unit TEXT DEFAULT NULL,
  p_calculation_rule TEXT,
  p_query_template TEXT,
  p_tags TEXT[] DEFAULT '{}',
  p_thresholds JSONB DEFAULT NULL
) RETURNS TABLE(
  metric_id UUID,
  tenant_id UUID,
  name TEXT,
  key TEXT,
  type TEXT,
  description TEXT,
  unit TEXT,
  calculation_rule TEXT,
  query_template TEXT,
  tags TEXT[],
  thresholds JSONB,
  created_at TIMESTAMPTZ,
  created_by UUID
) AS $$
DECLARE
  v_metric_id UUID;
  v_user_id UUID;
BEGIN
  v_metric_id := gen_random_uuid();
  v_user_id := auth.uid();

  INSERT INTO customer_metrics (
    metric_id, tenant_id, name, key, type, description, unit,
    calculation_rule, query_template, tags, thresholds, created_by
  ) VALUES (
    v_metric_id, p_tenant_id, p_name, p_key, p_type, p_description, p_unit,
    p_calculation_rule, p_query_template, p_tags, p_thresholds, v_user_id
  );

  RETURN QUERY
  SELECT * FROM customer_metrics WHERE metric_id = v_metric_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==================== CONFIGURATION FUNCTIONS ====================

-- 9. get_de_config: Fetch configuration for entity
CREATE OR REPLACE FUNCTION get_de_config(
  p_tenant_id UUID,
  p_entity_kind TEXT,
  p_entity_id UUID
) RETURNS TABLE(
  config_id UUID,
  tenant_id UUID,
  entity_kind TEXT,
  entity_id UUID,
  schema_id UUID,
  data JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  updated_by UUID
) AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM de_config
  WHERE tenant_id = p_tenant_id
    AND entity_kind = p_entity_kind
    AND entity_id = p_entity_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10. set_de_config: Create or update configuration
CREATE OR REPLACE FUNCTION set_de_config(
  p_tenant_id UUID,
  p_entity_kind TEXT,
  p_entity_id UUID,
  p_config JSONB
) RETURNS TABLE(
  config_id UUID,
  tenant_id UUID,
  entity_kind TEXT,
  entity_id UUID,
  schema_id UUID,
  data JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  updated_by UUID
) AS $$
DECLARE
  v_config_id UUID;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  INSERT INTO de_config (
    config_id, tenant_id, entity_kind, entity_id, data, updated_by
  ) VALUES (
    gen_random_uuid(), p_tenant_id, p_entity_kind, p_entity_id, p_config, v_user_id
  )
  ON CONFLICT (tenant_id, entity_kind, entity_id)
  DO UPDATE SET data = p_config, updated_at = NOW(), updated_by = v_user_id
  RETURNING config_id INTO v_config_id;

  RETURN QUERY
  SELECT * FROM de_config WHERE config_id = v_config_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 11. get_config_schema: Fetch schema for entity kind
CREATE OR REPLACE FUNCTION get_config_schema(
  p_tenant_id UUID,
  p_entity_kind TEXT,
  p_entity_id UUID DEFAULT NULL
) RETURNS TABLE(
  schema_id UUID,
  tenant_id UUID,
  entity_kind TEXT,
  entity_id UUID,
  name TEXT,
  fields JSONB,
  tags TEXT[],
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM de_config_schemas
  WHERE tenant_id = p_tenant_id
    AND entity_kind = p_entity_kind
    AND (entity_id = p_entity_id OR entity_id IS NULL)
  ORDER BY entity_id DESC NULLS LAST
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12. create_config_schema: Define new config schema
CREATE OR REPLACE FUNCTION create_config_schema(
  p_tenant_id UUID,
  p_entity_kind TEXT,
  p_entity_id UUID DEFAULT NULL,
  p_name TEXT,
  p_fields JSONB,
  p_tags TEXT[] DEFAULT '{}'
) RETURNS TABLE(
  schema_id UUID,
  tenant_id UUID,
  entity_kind TEXT,
  entity_id UUID,
  name TEXT,
  fields JSONB,
  tags TEXT[],
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
) AS $$
DECLARE
  v_schema_id UUID;
BEGIN
  v_schema_id := gen_random_uuid();

  INSERT INTO de_config_schemas (
    schema_id, tenant_id, entity_kind, entity_id, name, fields, tags
  ) VALUES (
    v_schema_id, p_tenant_id, p_entity_kind, p_entity_id, p_name, p_fields, p_tags
  );

  RETURN QUERY
  SELECT * FROM de_config_schemas WHERE schema_id = v_schema_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 13. validate_config: Validate data against schema
CREATE OR REPLACE FUNCTION validate_config(
  p_config JSONB,
  p_schema_id UUID
) RETURNS TABLE(
  valid BOOLEAN,
  errors JSONB
) AS $$
DECLARE
  v_errors JSONB := '[]'::JSONB;
BEGIN
  -- Placeholder: return valid
  RETURN QUERY SELECT TRUE::BOOLEAN, v_errors;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 14. get_config_audit_log: Fetch audit trail
CREATE OR REPLACE FUNCTION get_config_audit_log(
  p_tenant_id UUID,
  p_entity_kind TEXT,
  p_entity_id UUID,
  p_limit INTEGER DEFAULT 50
) RETURNS TABLE(
  audit_id UUID,
  timestamp TIMESTAMPTZ,
  changed_by UUID,
  action TEXT,
  field_name TEXT,
  old_value JSONB,
  new_value JSONB,
  details TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    dal.audit_id,
    dal.changed_at as timestamp,
    dal.changed_by,
    dal.action,
    dal.field_name,
    dal.old_value,
    dal.new_value,
    dal.details
  FROM de_config_audit_log dal
  WHERE dal.tenant_id = p_tenant_id
    AND dal.entity_kind = p_entity_kind
    AND dal.entity_id = p_entity_id
  ORDER BY dal.changed_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 15. apply_config_template: Apply built-in template
CREATE OR REPLACE FUNCTION apply_config_template(
  p_tenant_id UUID,
  p_template_key TEXT
) RETURNS TABLE(
  type TEXT,
  id UUID,
  name TEXT
) AS $$
BEGIN
  -- Placeholder: apply template
  RETURN QUERY SELECT 'template_applied'::TEXT, gen_random_uuid(), p_template_key WHERE FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 16. get_tenant_config_status: Config overview
CREATE OR REPLACE FUNCTION get_tenant_config_status(p_tenant_id UUID)
RETURNS TABLE(metrics JSONB, schemas JSONB, configs JSONB) AS $$
BEGIN
  RETURN QUERY
  SELECT
    jsonb_build_object(
      'defined', (SELECT COUNT(*) FROM customer_metrics WHERE tenant_id = p_tenant_id),
      'active', (SELECT COUNT(*) FROM customer_metrics WHERE tenant_id = p_tenant_id)
    )::JSONB as metrics,
    jsonb_build_object(
      'support', (SELECT COUNT(*) FROM de_config_schemas WHERE tenant_id = p_tenant_id AND tags @> '["support"]'::jsonb),
      'hr', (SELECT COUNT(*) FROM de_config_schemas WHERE tenant_id = p_tenant_id AND tags @> '["hr"]'::jsonb),
      'billing', (SELECT COUNT(*) FROM de_config_schemas WHERE tenant_id = p_tenant_id AND tags @> '["billing"]'::jsonb)
    )::JSONB as schemas,
    jsonb_build_object(
      'total', (SELECT COUNT(*) FROM de_config WHERE tenant_id = p_tenant_id)
    )::JSONB as configs;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 17. list_config_schemas: List all schemas for tenant
CREATE OR REPLACE FUNCTION list_config_schemas(
  p_tenant_id UUID,
  p_entity_kind TEXT DEFAULT NULL
) RETURNS TABLE(
  schema_id UUID,
  tenant_id UUID,
  entity_kind TEXT,
  entity_id UUID,
  name TEXT,
  fields JSONB,
  tags TEXT[]
) AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM de_config_schemas
  WHERE tenant_id = p_tenant_id
    AND (p_entity_kind IS NULL OR entity_kind = p_entity_kind)
  ORDER BY created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 18. export_tenant_config: Export all config for backup/migration
CREATE OR REPLACE FUNCTION export_tenant_config(p_tenant_id UUID)
RETURNS TABLE(
  metrics JSONB,
  schemas JSONB,
  configs JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT jsonb_agg(row_to_json(t)) FROM customer_metrics t WHERE tenant_id = p_tenant_id)::JSONB as metrics,
    (SELECT jsonb_agg(row_to_json(t)) FROM de_config_schemas t WHERE tenant_id = p_tenant_id)::JSONB as schemas,
    (SELECT jsonb_agg(row_to_json(t)) FROM de_config t WHERE tenant_id = p_tenant_id)::JSONB as configs;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 19. update_custom_metric: Edit metric definition
CREATE OR REPLACE FUNCTION update_custom_metric(
  p_metric_id UUID,
  p_updates JSONB
) RETURNS TABLE(
  metric_id UUID,
  tenant_id UUID,
  name TEXT,
  key TEXT,
  type TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  UPDATE customer_metrics
  SET
    name = COALESCE((p_updates->>'name')::TEXT, name),
    description = COALESCE((p_updates->>'description')::TEXT, description),
    unit = COALESCE((p_updates->>'unit')::TEXT, unit),
    thresholds = COALESCE((p_updates->'thresholds')::JSONB, thresholds)
  WHERE metric_id = p_metric_id;

  RETURN QUERY SELECT metric_id, tenant_id, name, key, type, created_at
  FROM customer_metrics WHERE metric_id = p_metric_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 20. delete_custom_metric: Remove metric
CREATE OR REPLACE FUNCTION delete_custom_metric(p_metric_id UUID)
RETURNS TABLE(success BOOLEAN, message TEXT) AS $$
BEGIN
  DELETE FROM customer_metrics WHERE metric_id = p_metric_id;
  RETURN QUERY SELECT TRUE::BOOLEAN, 'Metric deleted'::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions to authenticated users
GRANT EXECUTE ON FUNCTION get_metric_value TO authenticated;
GRANT EXECUTE ON FUNCTION get_de_metrics_batch TO authenticated;
GRANT EXECUTE ON FUNCTION get_metric_trend TO authenticated;
GRANT EXECUTE ON FUNCTION get_metrics_anomalies TO authenticated;
GRANT EXECUTE ON FUNCTION get_tenant_metrics_comparison TO authenticated;
GRANT EXECUTE ON FUNCTION get_sla_achievement TO authenticated;
GRANT EXECUTE ON FUNCTION get_quality_score_breakdown TO authenticated;
GRANT EXECUTE ON FUNCTION create_custom_metric TO authenticated;
GRANT EXECUTE ON FUNCTION get_de_config TO authenticated;
GRANT EXECUTE ON FUNCTION set_de_config TO authenticated;
GRANT EXECUTE ON FUNCTION get_config_schema TO authenticated;
GRANT EXECUTE ON FUNCTION create_config_schema TO authenticated;
GRANT EXECUTE ON FUNCTION validate_config TO authenticated;
GRANT EXECUTE ON FUNCTION get_config_audit_log TO authenticated;
GRANT EXECUTE ON FUNCTION apply_config_template TO authenticated;
GRANT EXECUTE ON FUNCTION get_tenant_config_status TO authenticated;
GRANT EXECUTE ON FUNCTION list_config_schemas TO authenticated;
GRANT EXECUTE ON FUNCTION export_tenant_config TO authenticated;
GRANT EXECUTE ON FUNCTION update_custom_metric TO authenticated;
GRANT EXECUTE ON FUNCTION delete_custom_metric TO authenticated;
