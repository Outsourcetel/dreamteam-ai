-- ════════════════════════════════════════════════════════════════
-- STREAM 2: Amendment Metrics & Deep Review
-- Tracks amendment adoption, impact, and ROI
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS amendment_metrics (
  metric_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amendment_id UUID NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('de', 'playbook', 'specialist')),
  entity_id UUID NOT NULL,
  before_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_metrics JSONB DEFAULT NULL,
  replay_score_before NUMERIC(5,2) DEFAULT NULL,
  replay_score_after NUMERIC(5,2) DEFAULT NULL,
  confidence_delta NUMERIC(5,2) DEFAULT NULL,
  escalation_rate_delta NUMERIC(5,2) DEFAULT NULL,
  adopted_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX idx_amendment_metrics_tenant_amendment ON amendment_metrics(tenant_id, amendment_id);
CREATE INDEX idx_amendment_metrics_entity ON amendment_metrics(tenant_id, entity_kind, entity_id);
CREATE INDEX idx_amendment_metrics_adopted ON amendment_metrics(tenant_id, adopted_at);

-- Enable RLS
ALTER TABLE amendment_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view own metrics"
ON amendment_metrics FOR SELECT
USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY "Tenant can update own metrics"
ON amendment_metrics FOR UPDATE
USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY "Tenant can insert metrics"
ON amendment_metrics FOR INSERT
WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ════════════════════════════════════════════════════════════════
-- RPC: Record Amendment Metrics (Before Approval)
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION record_amendment_before_metrics(
  p_amendment_id UUID,
  p_entity_kind TEXT,
  p_entity_id UUID,
  p_before_metrics JSONB
)
RETURNS json AS $$
DECLARE
  v_tenant_id UUID;
  v_metric_id UUID;
BEGIN
  v_tenant_id := current_setting('app.current_tenant_id')::uuid;

  INSERT INTO amendment_metrics (
    tenant_id, amendment_id, entity_kind, entity_id, before_metrics
  )
  VALUES (v_tenant_id, p_amendment_id, p_entity_kind, p_entity_id, p_before_metrics)
  ON CONFLICT DO NOTHING
  RETURNING metric_id INTO v_metric_id;

  RETURN json_build_object(
    'ok', true,
    'metric_id', v_metric_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Record Amendment Metrics (After Adoption)
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION record_amendment_after_metrics(
  p_amendment_id UUID,
  p_after_metrics JSONB,
  p_replay_score_before NUMERIC DEFAULT NULL,
  p_replay_score_after NUMERIC DEFAULT NULL,
  p_confidence_delta NUMERIC DEFAULT NULL,
  p_escalation_rate_delta NUMERIC DEFAULT NULL
)
RETURNS json AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  v_tenant_id := current_setting('app.current_tenant_id')::uuid;

  UPDATE amendment_metrics
  SET
    after_metrics = p_after_metrics,
    replay_score_before = p_replay_score_before,
    replay_score_after = p_replay_score_after,
    confidence_delta = p_confidence_delta,
    escalation_rate_delta = p_escalation_rate_delta,
    adopted_at = now(),
    updated_at = now()
  WHERE amendment_id = p_amendment_id
    AND tenant_id = v_tenant_id;

  RETURN json_build_object('ok', true, 'adopted_at', now()::text);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Get Amendment Effectiveness Summary
-- Returns adoption %, success metrics, impact estimates
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_amendment_effectiveness(
  p_entity_kind TEXT,
  p_entity_id UUID
)
RETURNS json AS $$
DECLARE
  v_tenant_id UUID;
  v_total_amendments INT;
  v_adopted_amendments INT;
  v_adoption_rate NUMERIC;
  v_avg_confidence_delta NUMERIC;
  v_avg_escalation_delta NUMERIC;
  v_avg_replay_gain NUMERIC;
BEGIN
  v_tenant_id := current_setting('app.current_tenant_id')::uuid;

  -- Count total and adopted amendments
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE adopted_at IS NOT NULL)
  INTO v_total_amendments, v_adopted_amendments
  FROM amendment_metrics
  WHERE entity_kind = p_entity_kind
    AND entity_id = p_entity_id
    AND tenant_id = v_tenant_id;

  -- Calculate adoption rate
  v_adoption_rate := CASE
    WHEN v_total_amendments > 0
    THEN ROUND((v_adopted_amendments::NUMERIC / v_total_amendments) * 100, 1)
    ELSE 0
  END;

  -- Calculate average metrics for adopted amendments
  SELECT
    AVG(confidence_delta),
    AVG(escalation_rate_delta),
    AVG(COALESCE(replay_score_after - replay_score_before, 0))
  INTO v_avg_confidence_delta, v_avg_escalation_delta, v_avg_replay_gain
  FROM amendment_metrics
  WHERE entity_kind = p_entity_kind
    AND entity_id = p_entity_id
    AND tenant_id = v_tenant_id
    AND adopted_at IS NOT NULL;

  RETURN json_build_object(
    'entity_kind', p_entity_kind,
    'entity_id', p_entity_id,
    'total_amendments', v_total_amendments,
    'adopted_count', v_adopted_amendments,
    'adoption_rate_pct', v_adoption_rate,
    'avg_confidence_delta', ROUND(COALESCE(v_avg_confidence_delta, 0)::NUMERIC, 2),
    'avg_escalation_rate_delta', ROUND(COALESCE(v_avg_escalation_delta, 0)::NUMERIC, 2),
    'avg_replay_score_gain', ROUND(COALESCE(v_avg_replay_gain, 0)::NUMERIC, 2)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Get Amendment Impact History (for UI display)
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_amendment_impact_history(
  p_entity_kind TEXT,
  p_entity_id UUID,
  p_limit INT DEFAULT 10
)
RETURNS json AS $$
BEGIN
  RETURN json_agg(
    json_build_object(
      'metric_id', metric_id,
      'amendment_id', amendment_id,
      'confidence_delta', confidence_delta,
      'escalation_rate_delta', escalation_rate_delta,
      'replay_score_delta', COALESCE(replay_score_after - replay_score_before, 0),
      'adopted_at', adopted_at::text,
      'status', CASE WHEN adopted_at IS NOT NULL THEN 'adopted' ELSE 'pending' END
    )
  ) FILTER (WHERE metric_id IS NOT NULL)
  FROM amendment_metrics
  WHERE entity_kind = p_entity_kind
    AND entity_id = p_entity_id
    AND tenant_id = current_setting('app.current_tenant_id')::uuid
  ORDER BY created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- PERMISSIONS
-- ════════════════════════════════════════════════════════════════

GRANT SELECT ON amendment_metrics TO authenticated;
GRANT INSERT, UPDATE ON amendment_metrics TO authenticated;
GRANT EXECUTE ON FUNCTION record_amendment_before_metrics TO authenticated;
GRANT EXECUTE ON FUNCTION record_amendment_after_metrics TO authenticated;
GRANT EXECUTE ON FUNCTION get_amendment_effectiveness TO authenticated;
GRANT EXECUTE ON FUNCTION get_amendment_impact_history TO authenticated;
