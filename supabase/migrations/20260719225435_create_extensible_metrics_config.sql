-- Migration: Create extensible metrics and configuration tables
-- Purpose: Support customer-defined metrics and configuration schemas

-- 1. customer_metrics table
CREATE TABLE IF NOT EXISTS customer_metrics (
  metric_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('percentage', 'count', 'duration', 'score')),
  description TEXT,
  unit TEXT,
  calculation_rule TEXT NOT NULL,
  query_template TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  thresholds JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES auth.users(id),
  UNIQUE(tenant_id, key)
);

CREATE INDEX idx_customer_metrics_tenant ON customer_metrics(tenant_id);
CREATE INDEX idx_customer_metrics_tags ON customer_metrics USING GIN(tags);

-- 2. de_config_schemas table
CREATE TABLE IF NOT EXISTS de_config_schemas (
  schema_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('de', 'playbook', 'specialist')),
  entity_id UUID,
  name TEXT NOT NULL,
  fields JSONB NOT NULL DEFAULT '[]',
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, entity_kind, entity_id)
);

CREATE INDEX idx_de_config_schemas_tenant ON de_config_schemas(tenant_id);
CREATE INDEX idx_de_config_schemas_entity ON de_config_schemas(entity_kind, entity_id);

-- 3. de_config table
CREATE TABLE IF NOT EXISTS de_config (
  config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('de', 'playbook', 'specialist')),
  entity_id UUID NOT NULL,
  schema_id UUID REFERENCES de_config_schemas(schema_id),
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID NOT NULL REFERENCES auth.users(id),
  UNIQUE(tenant_id, entity_kind, entity_id)
);

CREATE INDEX idx_de_config_tenant ON de_config(tenant_id);
CREATE INDEX idx_de_config_entity ON de_config(entity_kind, entity_id);

-- 4. de_config_audit_log table
CREATE TABLE IF NOT EXISTS de_config_audit_log (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  field_name TEXT,
  old_value JSONB,
  new_value JSONB,
  changed_by UUID NOT NULL REFERENCES auth.users(id),
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  details TEXT
);

CREATE INDEX idx_de_config_audit_log_tenant ON de_config_audit_log(tenant_id);
CREATE INDEX idx_de_config_audit_log_entity ON de_config_audit_log(entity_kind, entity_id);
CREATE INDEX idx_de_config_audit_log_timestamp ON de_config_audit_log(changed_at DESC);

-- 5. Trigger for audit trail on de_config updates
CREATE OR REPLACE FUNCTION audit_de_config_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Log entire update
    INSERT INTO de_config_audit_log (
      tenant_id, entity_kind, entity_id, action, changed_by, details
    ) VALUES (
      NEW.tenant_id, NEW.entity_kind, NEW.entity_id, 'update',
      NEW.updated_by, 'Configuration updated'
    );
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO de_config_audit_log (
      tenant_id, entity_kind, entity_id, action, changed_by, details
    ) VALUES (
      OLD.tenant_id, OLD.entity_kind, OLD.entity_id, 'delete',
      auth.uid(), 'Configuration deleted'
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_de_config_audit ON de_config;
CREATE TRIGGER tr_de_config_audit AFTER UPDATE OR DELETE ON de_config
FOR EACH ROW EXECUTE FUNCTION audit_de_config_changes();

-- 6. RLS Policies for multi-tenant isolation
ALTER TABLE customer_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE de_config_schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE de_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE de_config_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_metrics_tenant_isolation ON customer_metrics
  FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY de_config_schemas_tenant_isolation ON de_config_schemas
  FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY de_config_tenant_isolation ON de_config
  FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY de_config_audit_log_tenant_isolation ON de_config_audit_log
  FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
