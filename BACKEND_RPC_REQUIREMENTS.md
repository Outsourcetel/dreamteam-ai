# Backend RPC Stubs — Extensible Architecture

## Architecture Principles

1. **Tenant Extensibility**: Every customer defines their own metrics, configuration schemas, and validation rules
2. **No Hardcoding**: Framework doesn't assume Support domain or specific metrics
3. **Domain Templates**: Built-in templates for Support, Billing, HR; customers extend as needed
4. **Generic Query Layer**: Single `get_metric_value()` works for ANY metric, not hardcoded 8

## Database Schema Changes Required

### 1. customer_metrics table

Stores customer-defined metrics (not hardcoded in frontend).

```sql
CREATE TABLE customer_metrics (
  metric_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE, -- fcr, csat, ttr_median, escalation_rate, etc.
  type TEXT NOT NULL, -- percentage, count, duration, score
  description TEXT,
  unit TEXT, -- %, minutes, hours, /5, etc.
  calculation_rule TEXT NOT NULL, -- SQL or LLM rule
  query_template TEXT NOT NULL, -- parameterized SQL query
  tags TEXT[] DEFAULT '{}', -- ["support", "de-performance"]
  thresholds JSONB, -- {warning: 80, critical: 60}
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES auth.users(id),
  UNIQUE(tenant_id, key)
);
```

### 2. de_config_schemas table

Stores customer-defined configuration schemas (Support, HR, Billing, Operations, etc.).

```sql
CREATE TABLE de_config_schemas (
  schema_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  entity_kind TEXT NOT NULL, -- de, playbook, specialist
  entity_id UUID, -- if NULL, applies to all of entity_kind
  name TEXT NOT NULL,
  fields JSONB NOT NULL, -- array of ConfigFieldSchema
  tags TEXT[] DEFAULT '{}', -- ["support", "configuration"]
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, entity_kind, entity_id)
);
```

### 3. de_config table

Stores actual configuration values for each DE/playbook/specialist (generic JSON).

```sql
CREATE TABLE de_config (
  config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  entity_kind TEXT NOT NULL, -- de, playbook, specialist
  entity_id UUID NOT NULL,
  schema_id UUID REFERENCES de_config_schemas(schema_id),
  data JSONB NOT NULL, -- actual config values
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID NOT NULL REFERENCES auth.users(id),
  UNIQUE(tenant_id, entity_kind, entity_id),
  CONSTRAINT fk_entity CHECK (
    (entity_kind = 'de' AND entity_id IN (SELECT id FROM digital_employees WHERE tenant_id = de_config.tenant_id))
    OR (entity_kind = 'playbook' AND entity_id IN (SELECT id FROM playbook_definitions WHERE tenant_id = de_config.tenant_id))
    OR (entity_kind = 'specialist' AND entity_id IN (SELECT id FROM specialist_profiles WHERE tenant_id = de_config.tenant_id))
  )
);
```

## RPC Functions Required (20 total)

### Metrics Framework (8 functions)

#### 1. get_metric_value(p_tenant_id, p_de_id, p_metric_key, p_date_from?, p_date_to?)

Get single metric value for a DE in a time period.

Returns: `{ metric_key, value, timestamp, period: {from, to}, context }`

**Logic**:
- Look up metric definition from `customer_metrics` table
- Execute query_template parameterized with DE ID, date range
- Calculate based on calculation_rule (SQL or LLM)
- Return typed MetricValue

#### 2. get_de_metrics_batch(p_tenant_id, p_de_id, p_metric_keys?, p_date_from?, p_date_to?)

Get multiple metrics for a DE (with optional trend/comparison).

Returns: `Array<{ metric_key, metric_name, value, unit, trend, comparison }>`

**Logic**:
- Fetch all metrics OR filter by p_metric_keys
- For each metric, call get_metric_value()
- Compute trend: compare against previous period
- Compute comparison: current vs average
- Return typed MetricQueryResult array

#### 3. get_metric_trend(p_tenant_id, p_de_id, p_metric_key, p_date_from, p_date_to, p_interval)

Get metric over time (hourly/daily/weekly).

Returns: `Array<{ metric_key, value, timestamp }>`

**Logic**:
- Look up metric definition
- Bucket query results by interval
- Return time-series data for charting

#### 4. get_metrics_anomalies(p_tenant_id, p_de_id, p_lookback_days)

Detect anomalies in recent metrics (outliers).

Returns: `Array<{ metric_key, timestamp, value, expected_range, severity }>`

**Logic**:
- Fetch metric history for lookback period
- Calculate mean, std dev
- Flag values > 2.5 std devs as anomalies
- Return with severity (low/medium/high)

#### 5. get_tenant_metrics_comparison(p_tenant_id, p_date_from?, p_date_to?)

Compare all DEs in tenant (rankings, benchmarks).

Returns: `Array<{ de_id, de_name, metrics: {fcr, csat, ttr_median, ...}, rank }>`

**Logic**:
- Get default tenant metrics OR use specified metrics
- For each DE, fetch metrics
- Rank DEs by each metric
- Return comparable scorecard

#### 6. get_sla_achievement(p_tenant_id, p_de_id, p_date_from, p_date_to)

Compute SLA achievement (%within SLA).

Returns: `{ total_escalations, within_sla, achievement_percent, missed_by_hours: [{escalation_id, hours_missed}] }`

**Logic**:
- Look up escalation_rules config for DE
- For each escalation rule, get SLA
- Count escalations within/outside SLA
- Compute achievement %

#### 7. get_quality_score_breakdown(p_tenant_id, p_de_id, p_date_from, p_date_to)

Quality score by category/response type.

Returns: `{ overall, by_category: {name: {accurate, total, percent}}, by_response_type: {...} }`

**Logic**:
- Fetch quality ratings grouped by category
- Group by response type (refund, apology, data, etc.)
- Calculate per-group % accurate
- Return hierarchical breakdown

#### 8. create_custom_metric(p_tenant_id, p_name, p_key, p_type, p_description, p_unit, p_calculation_rule, p_query_template, p_tags, p_thresholds?)

Create a new custom metric for tenant.

Returns: `CustomMetric`

**Logic**:
- Validate metric_key is unique for tenant
- Validate query_template syntax
- Insert into customer_metrics
- Return created metric with ID

### Configuration Framework (12 functions)

#### 9. get_de_config(p_tenant_id, p_entity_kind, p_entity_id)

Get configuration instance for DE/playbook/specialist.

Returns: `{ config_id, tenant_id, entity_kind, entity_id, schema_id, data, created_at, updated_at, updated_by }`

**Logic**:
- Look up de_config row
- Return data (generic JSON, validated against schema_id)
- Return null if not found

#### 10. set_de_config(p_tenant_id, p_entity_kind, p_entity_id, p_config)

Set/update configuration for entity.

Returns: `DEConfigInstance`

**Logic**:
- Look up schema for entity_kind (or use DEFAULT if none)
- Validate p_config against schema (required fields, types, constraints)
- Return validation errors if invalid
- Upsert into de_config table
- Log audit entry (who changed what, when)
- Return updated config with audit info

#### 11. get_config_schema(p_tenant_id, p_entity_kind, p_entity_id?)

Get configuration schema (what fields are expected).

Returns: `{ schema_id, tenant_id, entity_kind, entity_id, name, fields: [...], tags, created_at, updated_at }`

**Logic**:
- Look up de_config_schemas for tenant
- If p_entity_id provided, check entity-specific schema first, fallback to entity_kind default
- If no schema found, use built-in template (METRIC_TEMPLATES or CONFIG_TEMPLATES)
- Return schema with fields (including UI hints)

#### 12. create_config_schema(p_tenant_id, p_entity_kind, p_entity_id?, p_name, p_fields, p_tags?)

Create custom configuration schema for tenant.

Returns: `DEConfigSchema`

**Logic**:
- Validate fields structure (each field has key, name, type, validation)
- Validate no field key collisions
- Insert into de_config_schemas
- Return created schema

#### 13. update_config_schema(p_schema_id, p_updates)

Update configuration schema (add/remove/modify fields).

Returns: `DEConfigSchema`

**Logic**:
- Fetch schema
- Merge p_updates into fields array
- Validate new schema structure
- Update de_config_schemas
- Return updated schema

#### 14. delete_config_schema(p_schema_id)

Delete configuration schema (and any instances using it?).

Returns: `{ok: boolean}`

**Logic**:
- Check if schema is in use (any de_config rows reference it)
- If in use, return error OR cascade delete config instances
- Delete from de_config_schemas

#### 15. list_config_schemas(p_tenant_id, p_entity_kind?)

List all configuration schemas for tenant.

Returns: `Array<DEConfigSchema>`

**Logic**:
- Query de_config_schemas filtered by tenant
- If p_entity_kind provided, filter by entity_kind
- Return array ordered by created_at

#### 16. validate_config(p_config, p_schema_id)

Validate configuration data against schema.

Returns: `{ valid: boolean, errors: [{field, message}] }`

**Logic**:
- Look up schema
- For each field:
  - Check required
  - Check type
  - Check validation rules (min/max/pattern)
- Return errors if any validation fails
- Return {valid: true} if all pass

#### 17. get_config_audit_log(p_tenant_id, p_entity_kind, p_entity_id, p_limit)

Get audit trail of configuration changes.

Returns: `Array<{ timestamp, changed_by, action, field, old_value, new_value, details }>`

**Logic**:
- Query audit table (on UPDATE de_config, write to audit_log)
- Filter by entity_kind, entity_id
- Order by timestamp DESC
- Return limited to p_limit rows

#### 18. apply_config_template(p_tenant_id, p_template_key)

Apply built-in template (support, billing, hr) to tenant.

Returns: `Array<CustomMetric> ∪ Array<DEConfigSchema>`

**Logic**:
- Look up built-in template (METRIC_TEMPLATES or CONFIG_TEMPLATES)
- For each metric in template, create_custom_metric()
- For each schema in template, create_config_schema()
- Return created objects

#### 19. get_tenant_config_status(p_tenant_id)

Get overview of tenant's configuration state.

Returns: `{ metrics: {defined: N, active: N}, schemas: {support: N, hr: N, billing: N}, de_configs: {incomplete: [...], missing_required: [...]} }`

**Logic**:
- Count custom metrics
- Count config schemas per entity_kind
- Check which DEs have missing required config fields
- Return status summary

#### 20. export_tenant_config(p_tenant_id)

Export all tenant configuration (for backup/migration).

Returns: `{ metrics: [...], schemas: [...], configs: [...] }`

**Logic**:
- Query all customer_metrics for tenant
- Query all de_config_schemas
- Query all de_config instances
- Return as importable bundle

## Amendment Framework (6 functions — already exist)

- request_amendment(entity_kind, entity_id, problem, trigger, context)
- list_pending_amendments(entity_kind, entity_id?, status?)
- get_amendment_detail(amendment_id)
- approve_amendment(amendment_id)
- reject_amendment(amendment_id, reason?)
- get_amendment_history(entity_kind, entity_id)

## Validation & Hooks

**Pre-insert Validations**:
- customer_metrics: query_template must be parseable SQL
- de_config_schemas: each field must have key, name, type
- de_config: data must pass validation against schema

**Post-update Hooks**:
- de_config UPDATE: write audit log entry
- customer_metrics CREATE: notify frontend (metrics list changed)
- de_config_schemas UPDATE: invalidate cached schemas

**RLS** (Row-Level Security):

```sql
-- customer_metrics: tenant isolation
CREATE POLICY "tenant_metrics" ON customer_metrics
  FOR ALL USING (tenant_id = current_tenant_id());

-- de_config_schemas: tenant isolation
CREATE POLICY "tenant_schemas" ON de_config_schemas
  FOR ALL USING (tenant_id = current_tenant_id());

-- de_config: tenant isolation + entity access
CREATE POLICY "tenant_config" ON de_config
  FOR ALL USING (
    tenant_id = current_tenant_id()
    AND can_access_entity(entity_kind, entity_id)
  );
```

## Testing Strategy

1. **Unit**: validate_config() with various schemas
2. **Integration**: create_config_schema() + get_config_schema() + set_de_config() flow
3. **Multi-tenant**: verify RLS isolation
4. **Extensibility**: create custom metric, fetch it, verify calculation

## Error Handling

- 400: Validation failed (invalid schema, config doesn't match schema, bad query_template)
- 403: Tenant isolation violated (accessing another tenant's config)
- 404: Schema/config not found
- 409: Duplicate key (metric_key or schema already exists for tenant)
