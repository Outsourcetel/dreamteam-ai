-- ════════════════════════════════════════════════════════════════
-- STREAM 1: Sophie Configuration UI
-- config_schema_instances: Per-tenant customization of Support DE
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS config_schema_instances (
  instance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id UUID NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL REFERENCES config_schema_templates(template_key),
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id),
  UNIQUE(tenant_id, de_id, template_key)
);

CREATE INDEX idx_config_instances_tenant_de ON config_schema_instances(tenant_id, de_id);
CREATE INDEX idx_config_instances_template ON config_schema_instances(template_key);

-- Enable RLS
ALTER TABLE config_schema_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view own config"
ON config_schema_instances FOR SELECT
USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY "Tenant admins can update own config"
ON config_schema_instances FOR UPDATE
USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY "Tenant admins can insert config"
ON config_schema_instances FOR INSERT
WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ════════════════════════════════════════════════════════════════
-- RPC: Get DE Configuration
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_de_config(p_de_id UUID)
RETURNS json AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  v_tenant_id := current_setting('app.current_tenant_id')::uuid;

  RETURN (
    SELECT json_build_object(
      'instance_id', instance_id,
      'de_id', de_id,
      'template_key', template_key,
      'values', values,
      'updated_at', updated_at::text
    )
    FROM config_schema_instances
    WHERE de_id = p_de_id
      AND tenant_id = v_tenant_id
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Save DE Configuration
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION save_de_config(
  p_de_id UUID,
  p_template_key TEXT,
  p_values JSONB
)
RETURNS json AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id UUID;
  v_instance_id UUID;
BEGIN
  v_tenant_id := current_setting('app.current_tenant_id')::uuid;
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  INSERT INTO config_schema_instances (tenant_id, de_id, template_key, values, updated_by)
  VALUES (v_tenant_id, p_de_id, p_template_key, p_values, v_user_id)
  ON CONFLICT (tenant_id, de_id, template_key)
  DO UPDATE SET
    values = EXCLUDED.values,
    updated_at = now(),
    updated_by = v_user_id
  RETURNING instance_id INTO v_instance_id;

  RETURN json_build_object(
    'ok', true,
    'instance_id', v_instance_id,
    'updated_at', now()::text
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Get Config Template (with defaults)
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_config_template_with_overrides(
  p_de_id UUID,
  p_template_key TEXT DEFAULT 'support-de-template'
)
RETURNS json AS $$
DECLARE
  v_tenant_id UUID;
  v_template JSONB;
  v_overrides JSONB;
  v_merged JSONB;
BEGIN
  v_tenant_id := current_setting('app.current_tenant_id')::uuid;

  -- Get template schema
  SELECT fields INTO v_template
  FROM config_schema_templates
  WHERE template_key = p_template_key;

  IF v_template IS NULL THEN
    RAISE EXCEPTION 'Template not found: %', p_template_key;
  END IF;

  -- Get tenant overrides
  SELECT values INTO v_overrides
  FROM config_schema_instances
  WHERE de_id = p_de_id
    AND tenant_id = v_tenant_id
    AND template_key = p_template_key;

  v_overrides := COALESCE(v_overrides, '{}'::jsonb);

  -- Build merged config: template defaults + tenant overrides
  v_merged := jsonb_build_object();

  FOR v_template IN
    SELECT * FROM jsonb_array_elements(v_template)
  LOOP
    v_merged := v_merged || jsonb_build_object(
      v_template->>'key',
      COALESCE(
        v_overrides->(v_template->>'key'),
        v_template->'defaultValue',
        v_template->'defaultValue'
      )
    );
  END LOOP;

  RETURN v_merged;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Reset Config to Template Defaults
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reset_de_config_to_template(
  p_de_id UUID,
  p_template_key TEXT DEFAULT 'support-de-template'
)
RETURNS json AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  v_tenant_id := current_setting('app.current_tenant_id')::uuid;

  DELETE FROM config_schema_instances
  WHERE de_id = p_de_id
    AND tenant_id = v_tenant_id
    AND template_key = p_template_key;

  RETURN json_build_object('ok', true, 'reset', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- PERMISSIONS
-- ════════════════════════════════════════════════════════════════

GRANT SELECT ON config_schema_instances TO authenticated;
GRANT INSERT, UPDATE ON config_schema_instances TO authenticated;
GRANT EXECUTE ON FUNCTION get_de_config TO authenticated;
GRANT EXECUTE ON FUNCTION save_de_config TO authenticated;
GRANT EXECUTE ON FUNCTION get_config_template_with_overrides TO authenticated;
GRANT EXECUTE ON FUNCTION reset_de_config_to_template TO authenticated;
