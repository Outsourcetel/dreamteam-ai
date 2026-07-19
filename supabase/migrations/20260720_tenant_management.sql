-- ════════════════════════════════════════════════════════════════
-- TENANT MANAGEMENT: Features, Billing, Usage, Cost Tracking
-- ════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════
-- 1. TENANT PROFILE ENHANCEMENT
-- ════════════════════════════════════════════════════════════════

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS admin_name TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS admin_email TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_email TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_contact_name TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS adoption_score NUMERIC(5,2) DEFAULT 0;

-- ════════════════════════════════════════════════════════════════
-- 2. TENANT FEATURE TOGGLES (Per-tenant feature configuration)
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenant_feature_toggles (
  toggle_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,

  -- Core features
  sophie_config_enabled BOOLEAN DEFAULT true,
  amendment_journeys_enabled BOOLEAN DEFAULT true,
  metrics_tracking_enabled BOOLEAN DEFAULT true,
  reply_mode_enabled BOOLEAN DEFAULT true,
  hosted_chat_enabled BOOLEAN DEFAULT true,

  -- Advanced features
  amendment_replay_testing BOOLEAN DEFAULT false,
  trust_adaptive_execution BOOLEAN DEFAULT false,
  playbook_mining BOOLEAN DEFAULT false,

  -- Cost controls
  monthly_cost_limit NUMERIC(10,2) DEFAULT NULL,
  soft_limit_alert_percent NUMERIC(5,2) DEFAULT 80,
  hard_limit_behavior TEXT DEFAULT 'alert' CHECK (hard_limit_behavior IN ('alert', 'soft_block', 'hard_block')),

  -- Usage limits
  max_de_count INT DEFAULT NULL,
  max_monthly_responses INT DEFAULT NULL,
  max_monthly_amendments INT DEFAULT NULL,

  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);

CREATE INDEX idx_tenant_toggles_tenant ON tenant_feature_toggles(tenant_id);

-- Enable RLS
ALTER TABLE tenant_feature_toggles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can view all toggles" ON tenant_feature_toggles FOR SELECT
  USING (is_platform_admin());

CREATE POLICY "Platform admins can update toggles" ON tenant_feature_toggles FOR UPDATE
  USING (is_platform_admin());

-- ════════════════════════════════════════════════════════════════
-- 3. TENANT BILLING CONFIG
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenant_billing_config (
  config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,

  -- Feature pricing (monthly base)
  sophie_config_cost NUMERIC(10,2) DEFAULT 100,
  amendment_journeys_cost NUMERIC(10,2) DEFAULT 50,
  metrics_tracking_cost NUMERIC(10,2) DEFAULT 75,
  reply_mode_cost NUMERIC(10,2) DEFAULT 150,
  hosted_chat_cost NUMERIC(10,2) DEFAULT 200,

  -- Advanced feature pricing
  replay_testing_cost NUMERIC(10,2) DEFAULT 100,
  trust_adaptive_cost NUMERIC(10,2) DEFAULT 200,
  playbook_mining_cost NUMERIC(10,2) DEFAULT 150,

  -- Usage-based pricing
  cost_per_1k_responses NUMERIC(10,4) DEFAULT 0.50,
  cost_per_amendment NUMERIC(10,2) DEFAULT 5,
  cost_per_de NUMERIC(10,2) DEFAULT 20,

  -- Billing settings
  billing_cycle_day INT DEFAULT 1,
  billing_email TEXT,
  payment_method TEXT DEFAULT 'invoice',
  auto_pay_enabled BOOLEAN DEFAULT false,

  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_billing_config_tenant ON tenant_billing_config(tenant_id);

ALTER TABLE tenant_billing_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can view all billing" ON tenant_billing_config FOR SELECT
  USING (is_platform_admin());

CREATE POLICY "Platform admins can update billing" ON tenant_billing_config FOR UPDATE
  USING (is_platform_admin());

-- ════════════════════════════════════════════════════════════════
-- 4. TENANT USAGE METRICS (Real-time tracking)
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenant_usage_metrics (
  metric_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Feature adoption
  de_using_sophie_config INT DEFAULT 0,
  de_using_amendments INT DEFAULT 0,
  de_using_metrics INT DEFAULT 0,
  de_using_reply_mode INT DEFAULT 0,

  -- Usage counters (current month)
  total_responses_this_month INT DEFAULT 0,
  total_drafts_submitted INT DEFAULT 0,
  total_amendments_created INT DEFAULT 0,
  total_amendments_adopted INT DEFAULT 0,

  -- Performance metrics
  avg_response_confidence NUMERIC(5,2) DEFAULT 0,
  avg_escalation_rate NUMERIC(5,2) DEFAULT 0,
  avg_amendment_confidence_delta NUMERIC(5,2) DEFAULT 0,

  -- Adoption score calculation
  adoption_score NUMERIC(5,2) DEFAULT 0,

  -- Timing
  month_year VARCHAR(7) NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),

  UNIQUE(tenant_id, month_year)
);

CREATE INDEX idx_usage_metrics_tenant_month ON tenant_usage_metrics(tenant_id, month_year);

ALTER TABLE tenant_usage_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can view all metrics" ON tenant_usage_metrics FOR SELECT
  USING (is_platform_admin());

-- ════════════════════════════════════════════════════════════════
-- 5. TENANT COST TRACKING (Monthly billing records)
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenant_cost_tracking (
  cost_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Month and status
  billing_month VARCHAR(7) NOT NULL,
  status TEXT DEFAULT 'estimated' CHECK (status IN ('estimated', 'calculated', 'billed', 'paid')),

  -- Feature costs (base monthly)
  sophie_config_charge NUMERIC(10,2) DEFAULT 0,
  amendment_journeys_charge NUMERIC(10,2) DEFAULT 0,
  metrics_tracking_charge NUMERIC(10,2) DEFAULT 0,
  reply_mode_charge NUMERIC(10,2) DEFAULT 0,
  hosted_chat_charge NUMERIC(10,2) DEFAULT 0,

  -- Advanced feature costs
  replay_testing_charge NUMERIC(10,2) DEFAULT 0,
  trust_adaptive_charge NUMERIC(10,2) DEFAULT 0,
  playbook_mining_charge NUMERIC(10,2) DEFAULT 0,

  -- Usage-based costs
  response_usage_cost NUMERIC(10,2) DEFAULT 0,
  amendment_usage_cost NUMERIC(10,2) DEFAULT 0,
  de_count_cost NUMERIC(10,2) DEFAULT 0,

  -- Totals
  subtotal NUMERIC(10,2) DEFAULT 0,
  discount_percent NUMERIC(5,2) DEFAULT 0,
  discount_amount NUMERIC(10,2) DEFAULT 0,
  total_cost NUMERIC(10,2) DEFAULT 0,

  -- Budget tracking
  monthly_budget NUMERIC(10,2) DEFAULT NULL,
  budget_exceeded_percent NUMERIC(5,2) DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  billed_at TIMESTAMP DEFAULT NULL,
  paid_at TIMESTAMP DEFAULT NULL,

  UNIQUE(tenant_id, billing_month)
);

CREATE INDEX idx_cost_tracking_tenant_month ON tenant_cost_tracking(tenant_id, billing_month);
CREATE INDEX idx_cost_tracking_status ON tenant_cost_tracking(status);

ALTER TABLE tenant_cost_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can view all costs" ON tenant_cost_tracking FOR SELECT
  USING (is_platform_admin());

-- ════════════════════════════════════════════════════════════════
-- 6. RPC: Get Tenant Details (Profile + Features + Billing)
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_tenant_details(p_tenant_id UUID)
RETURNS json AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN (
    SELECT json_build_object(
      'tenant_id', t.id,
      'name', t.name,
      'slug', t.slug,
      'status', t.status,
      'plan', t.plan,
      'industry', t.industry,
      'admin_name', t.admin_name,
      'admin_email', t.admin_email,
      'billing_email', t.billing_email,
      'contact_name', t.billing_contact_name,
      'adoption_score', t.adoption_score,
      'created_at', t.created_at::text,
      'features', json_build_object(
        'sophie_config_enabled', COALESCE(tft.sophie_config_enabled, true),
        'amendment_journeys_enabled', COALESCE(tft.amendment_journeys_enabled, true),
        'metrics_tracking_enabled', COALESCE(tft.metrics_tracking_enabled, true),
        'reply_mode_enabled', COALESCE(tft.reply_mode_enabled, true),
        'hosted_chat_enabled', COALESCE(tft.hosted_chat_enabled, true),
        'replay_testing', COALESCE(tft.amendment_replay_testing, false),
        'trust_adaptive', COALESCE(tft.trust_adaptive_execution, false),
        'playbook_mining', COALESCE(tft.playbook_mining, false)
      ),
      'limits', json_build_object(
        'monthly_cost_limit', tft.monthly_cost_limit,
        'soft_limit_alert_percent', tft.soft_limit_alert_percent,
        'hard_limit_behavior', tft.hard_limit_behavior,
        'max_de_count', tft.max_de_count,
        'max_monthly_responses', tft.max_monthly_responses,
        'max_monthly_amendments', tft.max_monthly_amendments
      ),
      'billing', json_build_object(
        'sophie_config_cost', COALESCE(tbc.sophie_config_cost, 100),
        'amendment_cost', COALESCE(tbc.amendment_journeys_cost, 50),
        'metrics_cost', COALESCE(tbc.metrics_tracking_cost, 75),
        'reply_mode_cost', COALESCE(tbc.reply_mode_cost, 150),
        'hosted_chat_cost', COALESCE(tbc.hosted_chat_cost, 200),
        'cost_per_1k_responses', COALESCE(tbc.cost_per_1k_responses, 0.50),
        'cost_per_amendment', COALESCE(tbc.cost_per_amendment, 5),
        'cost_per_de', COALESCE(tbc.cost_per_de, 20)
      ),
      'usage', json_build_object(
        'de_using_sophie_config', COALESCE(tum.de_using_sophie_config, 0),
        'de_using_amendments', COALESCE(tum.de_using_amendments, 0),
        'total_responses_this_month', COALESCE(tum.total_responses_this_month, 0),
        'total_amendments_created', COALESCE(tum.total_amendments_created, 0),
        'avg_response_confidence', COALESCE(tum.avg_response_confidence, 0),
        'adoption_score', COALESCE(tum.adoption_score, 0)
      )
    )
    FROM tenants t
    LEFT JOIN tenant_feature_toggles tft ON tft.tenant_id = t.id
    LEFT JOIN tenant_billing_config tbc ON tbc.tenant_id = t.id
    LEFT JOIN tenant_usage_metrics tum ON tum.tenant_id = t.id
      AND tum.month_year = to_char(now(), 'YYYY-MM')
    WHERE t.id = p_tenant_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- 7. RPC: Update Tenant Features
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_tenant_features(
  p_tenant_id UUID,
  p_features JSONB
)
RETURNS json AS $$
DECLARE
  v_user_id UUID;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  v_user_id := auth.uid();

  INSERT INTO tenant_feature_toggles (
    tenant_id, sophie_config_enabled, amendment_journeys_enabled,
    metrics_tracking_enabled, reply_mode_enabled, hosted_chat_enabled,
    amendment_replay_testing, trust_adaptive_execution, playbook_mining,
    updated_by
  ) VALUES (
    p_tenant_id,
    COALESCE(p_features->>'sophie_config_enabled', 'true')::boolean,
    COALESCE(p_features->>'amendment_journeys_enabled', 'true')::boolean,
    COALESCE(p_features->>'metrics_tracking_enabled', 'true')::boolean,
    COALESCE(p_features->>'reply_mode_enabled', 'true')::boolean,
    COALESCE(p_features->>'hosted_chat_enabled', 'true')::boolean,
    COALESCE(p_features->>'replay_testing', 'false')::boolean,
    COALESCE(p_features->>'trust_adaptive', 'false')::boolean,
    COALESCE(p_features->>'playbook_mining', 'false')::boolean,
    v_user_id
  )
  ON CONFLICT (tenant_id)
  DO UPDATE SET
    sophie_config_enabled = EXCLUDED.sophie_config_enabled,
    amendment_journeys_enabled = EXCLUDED.amendment_journeys_enabled,
    metrics_tracking_enabled = EXCLUDED.metrics_tracking_enabled,
    reply_mode_enabled = EXCLUDED.reply_mode_enabled,
    hosted_chat_enabled = EXCLUDED.hosted_chat_enabled,
    amendment_replay_testing = EXCLUDED.amendment_replay_testing,
    trust_adaptive_execution = EXCLUDED.trust_adaptive_execution,
    playbook_mining = EXCLUDED.playbook_mining,
    updated_at = now(),
    updated_by = v_user_id;

  RETURN json_build_object('ok', true, 'updated_at', now()::text);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- 8. RPC: Update Billing Config
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_tenant_billing(
  p_tenant_id UUID,
  p_billing_config JSONB
)
RETURNS json AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  INSERT INTO tenant_billing_config (
    tenant_id, sophie_config_cost, amendment_journeys_cost,
    metrics_tracking_cost, reply_mode_cost, hosted_chat_cost,
    cost_per_1k_responses, cost_per_amendment, cost_per_de,
    billing_email, payment_method
  ) VALUES (
    p_tenant_id,
    COALESCE((p_billing_config->>'sophie_config_cost')::numeric, 100),
    COALESCE((p_billing_config->>'amendment_cost')::numeric, 50),
    COALESCE((p_billing_config->>'metrics_cost')::numeric, 75),
    COALESCE((p_billing_config->>'reply_mode_cost')::numeric, 150),
    COALESCE((p_billing_config->>'hosted_chat_cost')::numeric, 200),
    COALESCE((p_billing_config->>'cost_per_1k_responses')::numeric, 0.50),
    COALESCE((p_billing_config->>'cost_per_amendment')::numeric, 5),
    COALESCE((p_billing_config->>'cost_per_de')::numeric, 20),
    p_billing_config->>'billing_email',
    COALESCE(p_billing_config->>'payment_method', 'invoice')
  )
  ON CONFLICT (tenant_id)
  DO UPDATE SET
    sophie_config_cost = EXCLUDED.sophie_config_cost,
    amendment_journeys_cost = EXCLUDED.amendment_journeys_cost,
    metrics_tracking_cost = EXCLUDED.metrics_tracking_cost,
    reply_mode_cost = EXCLUDED.reply_mode_cost,
    hosted_chat_cost = EXCLUDED.hosted_chat_cost,
    cost_per_1k_responses = EXCLUDED.cost_per_1k_responses,
    cost_per_amendment = EXCLUDED.cost_per_amendment,
    cost_per_de = EXCLUDED.cost_per_de,
    billing_email = EXCLUDED.billing_email,
    payment_method = EXCLUDED.payment_method,
    updated_at = now();

  RETURN json_build_object('ok', true, 'updated_at', now()::text);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- 9. RPC: Calculate Monthly Cost
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION calculate_tenant_monthly_cost(p_tenant_id UUID)
RETURNS json AS $$
DECLARE
  v_features_cost NUMERIC(10,2) := 0;
  v_usage_cost NUMERIC(10,2) := 0;
  v_total_cost NUMERIC(10,2) := 0;
  v_month_year VARCHAR(7) := to_char(now(), 'YYYY-MM');
  v_responses INT;
  v_amendments INT;
  v_de_count INT;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Get current month metrics
  SELECT
    COALESCE(total_responses_this_month, 0),
    COALESCE(total_amendments_created, 0)
  INTO v_responses, v_amendments
  FROM tenant_usage_metrics
  WHERE tenant_id = p_tenant_id AND month_year = v_month_year;

  -- Get DE count
  SELECT COUNT(*) INTO v_de_count
  FROM digital_employees
  WHERE tenant_id = p_tenant_id;

  -- Calculate feature costs (assuming all enabled)
  SELECT
    COALESCE(sophie_config_cost, 100) +
    COALESCE(amendment_journeys_cost, 50) +
    COALESCE(metrics_tracking_cost, 75) +
    COALESCE(reply_mode_cost, 150) +
    COALESCE(hosted_chat_cost, 200)
  INTO v_features_cost
  FROM tenant_billing_config
  WHERE tenant_id = p_tenant_id;

  -- Calculate usage costs
  SELECT
    (v_responses::numeric / 1000) * COALESCE(cost_per_1k_responses, 0.50) +
    (v_amendments::numeric) * COALESCE(cost_per_amendment, 5) +
    (v_de_count::numeric) * COALESCE(cost_per_de, 20)
  INTO v_usage_cost
  FROM tenant_billing_config
  WHERE tenant_id = p_tenant_id;

  v_total_cost := COALESCE(v_features_cost, 0) + COALESCE(v_usage_cost, 0);

  -- Insert or update cost tracking
  INSERT INTO tenant_cost_tracking (
    tenant_id, billing_month, status,
    sophie_config_charge, amendment_journeys_charge, metrics_tracking_charge,
    reply_mode_charge, hosted_chat_charge, response_usage_cost,
    amendment_usage_cost, de_count_cost, subtotal, total_cost
  ) VALUES (
    p_tenant_id, v_month_year, 'estimated',
    100, 50, 75, 150, 200,
    (v_responses::numeric / 1000) * 0.50,
    (v_amendments::numeric) * 5,
    (v_de_count::numeric) * 20,
    v_features_cost, v_total_cost
  )
  ON CONFLICT (tenant_id, billing_month)
  DO UPDATE SET
    total_cost = EXCLUDED.total_cost,
    response_usage_cost = EXCLUDED.response_usage_cost,
    amendment_usage_cost = EXCLUDED.amendment_usage_cost,
    de_count_cost = EXCLUDED.de_count_cost,
    updated_at = now();

  RETURN json_build_object(
    'tenant_id', p_tenant_id,
    'month', v_month_year,
    'features_cost', ROUND(v_features_cost, 2),
    'usage_cost', ROUND(v_usage_cost, 2),
    'responses', v_responses,
    'amendments', v_amendments,
    'de_count', v_de_count,
    'total_cost', ROUND(v_total_cost, 2)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- 10. RPC: Get All Tenants with Summary (Platform Console List)
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_all_tenants_with_summary()
RETURNS json AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN json_agg(
    json_build_object(
      'tenant_id', t.id,
      'name', t.name,
      'slug', t.slug,
      'status', t.status,
      'plan', t.plan,
      'industry', t.industry,
      'admin_email', t.admin_email,
      'adoption_score', COALESCE(t.adoption_score, 0),
      'de_count', de_cnt.count,
      'active_features', active_features.count,
      'monthly_cost', COALESCE(ROUND(tct.total_cost, 2), 0),
      'cost_vs_budget', CASE
        WHEN tft.monthly_cost_limit IS NOT NULL
        THEN ROUND(100 * tct.total_cost / tft.monthly_cost_limit, 1)
        ELSE NULL
      END,
      'created_at', t.created_at::text
    )
  )
  FROM tenants t
  LEFT JOIN tenant_feature_toggles tft ON tft.tenant_id = t.id
  LEFT JOIN tenant_cost_tracking tct ON tct.tenant_id = t.id
    AND tct.billing_month = to_char(now(), 'YYYY-MM')
  LEFT JOIN LATERAL (
    SELECT COUNT(*) as count FROM digital_employees
    WHERE tenant_id = t.id
  ) de_cnt ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) as count FROM tenant_feature_toggles
    WHERE tenant_id = t.id
    AND (sophie_config_enabled OR amendment_journeys_enabled OR metrics_tracking_enabled
      OR reply_mode_enabled OR hosted_chat_enabled)
  ) active_features ON true
  ORDER BY t.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- PERMISSIONS
-- ════════════════════════════════════════════════════════════════

GRANT SELECT ON tenant_feature_toggles TO authenticated;
GRANT SELECT ON tenant_billing_config TO authenticated;
GRANT SELECT ON tenant_usage_metrics TO authenticated;
GRANT SELECT ON tenant_cost_tracking TO authenticated;

GRANT EXECUTE ON FUNCTION get_tenant_details TO authenticated;
GRANT EXECUTE ON FUNCTION update_tenant_features TO authenticated;
GRANT EXECUTE ON FUNCTION update_tenant_billing TO authenticated;
GRANT EXECUTE ON FUNCTION calculate_tenant_monthly_cost TO authenticated;
GRANT EXECUTE ON FUNCTION get_all_tenants_with_summary TO authenticated;
