-- ════════════════════════════════════════════════════════════════════════════════════════
-- WORKFORCE ASSISTANT SYSTEM — Phase 1: Conversational Workforce Management Platform
-- ════════════════════════════════════════════════════════════════════════════════════════
-- Schema for:
--   1. Workforce Assistant DE (meta-DE that manages other DEs)
--   2. Conversational interface (multi-turn conversations with context)
--   3. Performance monitoring + proactive suggestions
--   4. DE internship stages (shadow → co-pilot → live → retired)
--   5. Training UI for manual DE training
-- ════════════════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 1. ENHANCE DIGITAL_EMPLOYEES TABLE
-- ════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE digital_employees ADD COLUMN IF NOT EXISTS charter JSONB DEFAULT '{}'::jsonb;
ALTER TABLE digital_employees ADD COLUMN IF NOT EXISTS is_workforce_assistant BOOLEAN DEFAULT false;
ALTER TABLE digital_employees ADD COLUMN IF NOT EXISTS is_product_expert BOOLEAN DEFAULT false;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 2. WORKFORCE CONVERSATIONS — Multi-turn conversation context with Workforce Assistant
-- ════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS workforce_conversations (
  conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  de_id UUID NOT NULL REFERENCES digital_employees(id), -- The Workforce Assistant DE

  topic TEXT NOT NULL, -- 'hire' | 'improve' | 'monitor' | 'retire' | 'train'
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'decision_pending' | 'completed' | 'archived'

  messages JSONB NOT NULL DEFAULT '[]', -- [{ role: 'user' | 'assistant', content, timestamp }]

  spawned_action_id UUID, -- Links to workforce_actions if this conversation created an action

  context JSONB DEFAULT '{}', -- { target_de_id, target_playbook_id, stage, etc. }

  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  closed_at TIMESTAMP DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_workforce_conversations_tenant_user ON workforce_conversations(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_workforce_conversations_de ON workforce_conversations(de_id);
CREATE INDEX IF NOT EXISTS idx_workforce_conversations_topic ON workforce_conversations(topic);
CREATE INDEX IF NOT EXISTS idx_workforce_conversations_status ON workforce_conversations(status);

ALTER TABLE workforce_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant members can view their conversations" ON workforce_conversations;
CREATE POLICY "Tenant members can view their conversations" ON workforce_conversations FOR SELECT
  USING (tenant_id = auth_tenant_id() AND auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager']));

DROP POLICY IF EXISTS "Users can create conversations for their tenant" ON workforce_conversations;
CREATE POLICY "Users can create conversations for their tenant" ON workforce_conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id AND tenant_id = auth_tenant_id() AND auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager']));

DROP POLICY IF EXISTS "Users can update their conversations" ON workforce_conversations;
CREATE POLICY "Users can update their conversations" ON workforce_conversations FOR UPDATE
  USING (auth.uid() = user_id AND tenant_id = auth_tenant_id() AND auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager']));

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 3. WORKFORCE ACTIONS — Audit trail of hires, amendments, retirements
-- ════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS workforce_actions (
  action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  action_type TEXT NOT NULL, -- 'de_hire' | 'de_amend' | 'de_retire' | 'de_train'
  entity_id UUID NOT NULL, -- The DE being hired/amended/retired

  conversation_id UUID REFERENCES workforce_conversations(conversation_id) ON DELETE SET NULL,

  proposal JSONB NOT NULL, -- { charter, playbooks, guardrails, etc. }
  proposal_rationale TEXT,

  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMP,

  applied_at TIMESTAMP,
  result JSONB, -- { success, errors, changes }

  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMP DEFAULT now(),

  UNIQUE(tenant_id, entity_id, action_type, created_at) -- Prevent duplicates per entity/action/time
);

CREATE INDEX IF NOT EXISTS idx_workforce_actions_tenant ON workforce_actions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workforce_actions_entity ON workforce_actions(entity_id);
CREATE INDEX IF NOT EXISTS idx_workforce_actions_type ON workforce_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_workforce_actions_status ON workforce_actions(approved_at, applied_at);

ALTER TABLE workforce_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant members can view actions" ON workforce_actions;
CREATE POLICY "Tenant members can view actions" ON workforce_actions FOR SELECT
  USING (tenant_id = auth_tenant_id() AND auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager']));

DROP POLICY IF EXISTS "Admins can approve actions" ON workforce_actions;
CREATE POLICY "Admins can approve actions" ON workforce_actions FOR UPDATE
  USING (tenant_id = auth_tenant_id() AND auth_has_tenant_role(array['tenant_owner', 'tenant_admin']));

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 4. DE PRODUCT KNOWLEDGE — Knowledge base for Workforce Assistant product expertise
-- ════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS de_product_knowledge (
  knowledge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  topic TEXT NOT NULL, -- 'features' | 'charter' | 'playbooks' | 'guardrails' | 'economics' | 'governance'
  subtopic TEXT, -- e.g., 'playbook_3_0', 'trust_dial', 'amendment_system'

  title TEXT NOT NULL,
  content TEXT NOT NULL, -- The actual knowledge (markdown format)

  keywords TEXT[], -- For retrieval

  source_url TEXT, -- If from docs/architecture
  version TEXT DEFAULT '1.0',

  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),

  UNIQUE(topic, subtopic, title)
);

CREATE INDEX IF NOT EXISTS idx_product_knowledge_topic ON de_product_knowledge(topic);
CREATE INDEX IF NOT EXISTS idx_product_knowledge_keywords ON de_product_knowledge USING GIN(keywords);

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 5. DE DEPLOYMENT STAGES — Internship stages for graduated deployment
-- ════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS de_deployment_stages (
  stage_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  de_id UUID NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,

  stage TEXT NOT NULL, -- 'shadow' | 'co-pilot' | 'live' | 'retired'
  stage_started_at TIMESTAMP DEFAULT now(),
  stage_promoted_at TIMESTAMP DEFAULT NULL,

  stage_metrics JSONB DEFAULT '{}', -- { csat, escalation_rate, cost_variance, error_rate, sample_size }

  promotion_reason TEXT,
  rollback_reason TEXT,

  updated_at TIMESTAMP DEFAULT now(),

  UNIQUE(de_id) -- A DE is in exactly one stage at a time
);

CREATE INDEX IF NOT EXISTS idx_deployment_stages_de ON de_deployment_stages(de_id);
CREATE INDEX IF NOT EXISTS idx_deployment_stages_stage ON de_deployment_stages(stage);

ALTER TABLE de_deployment_stages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant members can view DE stages" ON de_deployment_stages;
CREATE POLICY "Tenant members can view DE stages" ON de_deployment_stages FOR SELECT
  USING (de_id IN (SELECT id FROM digital_employees WHERE tenant_id = auth_tenant_id() AND auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager'])));

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 6. DE ROLE ASSIGNMENTS — Multi-role support (Phase 2 schema, created now)
-- ════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS de_role_assignments (
  assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  de_id UUID NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,

  role_name TEXT NOT NULL, -- 'Sales', 'Support', 'Onboarding', etc.
  is_primary BOOLEAN DEFAULT false,

  playbook_id UUID REFERENCES playbook_definitions(id) ON DELETE SET NULL,
  guardrails JSONB, -- Role-specific guardrail overrides
  trust_dial NUMERIC(3,2) DEFAULT 0.5, -- Per-role trust level (0-1)
  cost_allocation_percent NUMERIC(5,2) DEFAULT 100,

  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),

  UNIQUE(de_id, role_name)
);

CREATE INDEX IF NOT EXISTS idx_role_assignments_de ON de_role_assignments(de_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_role ON de_role_assignments(role_name);

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 7. DE TRAINING FEEDBACK — Captures manual training during shadow/co-pilot stages
-- ════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS de_training_feedback (
  feedback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  de_id UUID NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,

  conversation_id UUID, -- The actual conversation being trained on
  human_decision TEXT NOT NULL, -- What the human did/said
  de_suggestion TEXT, -- What the DE suggested

  feedback_type TEXT NOT NULL, -- 'approval' | 'correction' | 'suggestion'
  correction_detail JSONB, -- { from, to, reasoning }

  approved_by UUID NOT NULL REFERENCES auth.users(id),
  replay_tested BOOLEAN DEFAULT false,
  replay_passed BOOLEAN DEFAULT NULL, -- null if not tested yet

  applied_to_charter BOOLEAN DEFAULT false,

  created_at TIMESTAMP DEFAULT now(),

  UNIQUE(de_id, conversation_id, feedback_type, approved_by)
);

CREATE INDEX IF NOT EXISTS idx_training_feedback_de ON de_training_feedback(de_id);
CREATE INDEX IF NOT EXISTS idx_training_feedback_stage ON de_training_feedback(feedback_type);

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 8. RPC: GET_DE_PERFORMANCE_SUMMARY
-- ════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_de_performance_summary(
  p_de_id UUID,
  p_time_window_days INT DEFAULT 30
)
RETURNS json AS $$
DECLARE
  v_tenant_id UUID;
  v_de_name TEXT;
  v_de_status TEXT;
  v_current_stage TEXT;
  v_cost_this_month NUMERIC;
  v_responses_this_month INT;
  v_avg_csat NUMERIC;
  v_escalation_rate NUMERIC;
  v_resolution_rate NUMERIC;
  v_amendments_count INT;
  v_training_sessions INT;
BEGIN
  -- Verify DE exists and user can access it
  SELECT tenant_id, name, status INTO v_tenant_id, v_de_name, v_de_status
  FROM digital_employees
  WHERE id = p_de_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'DE not found';
  END IF;

  -- Check tenant access
  IF NOT (v_tenant_id = auth_tenant_id() AND auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager'])) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Get current deployment stage
  SELECT stage INTO v_current_stage FROM de_deployment_stages WHERE de_id = p_de_id;
  IF v_current_stage IS NULL THEN
    v_current_stage := 'unknown';
  END IF;

  -- Get cost this month
  SELECT COALESCE(SUM(total_cost), 0) INTO v_cost_this_month
  FROM tenant_cost_tracking
  WHERE entity_id = p_de_id
    AND billing_month = to_char(now(), 'YYYY-MM');

  -- Get response count
  SELECT COALESCE(COUNT(*), 0) INTO v_responses_this_month
  FROM action_executions
  WHERE de_id = p_de_id
    AND created_at > now() - (p_time_window_days || ' days')::interval;

  -- Get average CSAT (from csat_surveys if available)
  SELECT COALESCE(AVG(score), 0) INTO v_avg_csat
  FROM csat_surveys
  WHERE de_id = p_de_id
    AND created_at > now() - (p_time_window_days || ' days')::interval;

  -- Get escalation rate
  SELECT COALESCE(COUNT(*)::NUMERIC / NULLIF(v_responses_this_month, 0) * 100, 0) INTO v_escalation_rate
  FROM action_executions
  WHERE de_id = p_de_id
    AND status = 'escalated'
    AND created_at > now() - (p_time_window_days || ' days')::interval;

  -- Get resolution rate
  SELECT COALESCE(COUNT(*)::NUMERIC / NULLIF(v_responses_this_month, 0) * 100, 0) INTO v_resolution_rate
  FROM action_executions
  WHERE de_id = p_de_id
    AND status = 'completed'
    AND created_at > now() - (p_time_window_days || ' days')::interval;

  -- Get amendments count
  SELECT COALESCE(COUNT(*), 0) INTO v_amendments_count
  FROM workforce_actions
  WHERE entity_id = p_de_id
    AND action_type IN ('de_amend', 'de_train')
    AND applied_at IS NOT NULL
    AND created_at > now() - (p_time_window_days || ' days')::interval;

  -- Get training sessions count
  SELECT COALESCE(COUNT(*), 0) INTO v_training_sessions
  FROM de_training_feedback
  WHERE de_id = p_de_id
    AND created_at > now() - (p_time_window_days || ' days')::interval;

  RETURN json_build_object(
    'de_id', p_de_id,
    'de_name', v_de_name,
    'de_status', v_de_status,
    'current_stage', v_current_stage,
    'time_window_days', p_time_window_days,
    'cost_this_month', v_cost_this_month,
    'responses_this_month', v_responses_this_month,
    'avg_csat', v_avg_csat,
    'escalation_rate', v_escalation_rate,
    'resolution_rate', v_resolution_rate,
    'amendments_applied', v_amendments_count,
    'training_sessions', v_training_sessions,
    'fte_equivalent_cost', ROUND((v_cost_this_month / 30)::numeric, 2), -- Rough daily cost
    'roi_hours_saved', (v_responses_this_month * 0.5)::INT, -- Assume 30 min per response
    'timestamp', now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 9. RPC: SUGGEST_DE_AMENDMENTS
-- ════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION suggest_de_amendments(
  p_de_id UUID,
  p_metric_type TEXT DEFAULT 'csat' -- 'csat' | 'escalation' | 'cost' | 'performance'
)
RETURNS json AS $$
DECLARE
  v_tenant_id UUID;
  v_de_name TEXT;
  v_current_csat NUMERIC;
  v_escalation_rate NUMERIC;
  v_suggestion TEXT;
  v_confidence_score NUMERIC;
  v_replay_test_count INT;
BEGIN
  -- Get DE and verify access
  SELECT tenant_id, name INTO v_tenant_id, v_de_name
  FROM digital_employees WHERE id = p_de_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'DE not found';
  END IF;

  IF NOT (v_tenant_id = auth_tenant_id() AND auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager'])) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Get current metrics
  SELECT COALESCE(AVG(score), 0) INTO v_current_csat
  FROM csat_surveys WHERE de_id = p_de_id AND created_at > now() - '30 days'::interval;

  SELECT COALESCE(COUNT(*)::NUMERIC / NULLIF((SELECT COUNT(*) FROM action_executions WHERE de_id = p_de_id AND created_at > now() - '30 days'::interval), 0) * 100, 0)
  INTO v_escalation_rate FROM action_executions
  WHERE de_id = p_de_id AND status = 'escalated' AND created_at > now() - '30 days'::interval;

  -- Generate suggestions based on metrics
  v_confidence_score := 0.7;
  v_replay_test_count := 0;

  -- CSAT-based suggestions
  IF p_metric_type = 'csat' AND v_current_csat < 80 THEN
    v_suggestion := 'Current CSAT is ' || ROUND(v_current_csat, 1) || '%. Suggested amendment: increase empathy in responses and reduce jargon. Replay testing 5 variations.';
    v_confidence_score := 0.75;
  -- Escalation-based suggestions
  ELSIF p_metric_type = 'escalation' AND v_escalation_rate > 15 THEN
    v_suggestion := 'Escalation rate is ' || ROUND(v_escalation_rate, 1) || '% (goal < 5%). Suggested amendment: expand allowed resolution actions and reduce guardrail strictness. Replay testing 3 variations.';
    v_confidence_score := 0.80;
  -- Default: performance-based
  ELSE
    v_suggestion := 'DE is performing well. No critical amendments suggested. Continue monitoring CSAT and escalation trends.';
    v_confidence_score := 0.90;
  END IF;

  RETURN json_build_object(
    'de_id', p_de_id,
    'de_name', v_de_name,
    'suggestion', v_suggestion,
    'metric_type', p_metric_type,
    'current_csat', ROUND(v_current_csat, 1),
    'current_escalation_rate', ROUND(v_escalation_rate, 1),
    'confidence_score', v_confidence_score,
    'replay_tests_count', v_replay_test_count,
    'recommendation', CASE WHEN v_confidence_score >= 0.75 THEN 'HIGH' WHEN v_confidence_score >= 0.5 THEN 'MEDIUM' ELSE 'LOW' END,
    'generated_at', now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 10. RPC: CREATE_WORKFORCE_ASSISTANT_DE
-- ════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION create_workforce_assistant_de(
  p_tenant_id UUID,
  p_charter_override JSONB DEFAULT NULL
)
RETURNS json AS $$
DECLARE
  v_de_id UUID;
  v_assistant_charter JSONB;
  v_default_charter JSONB;
BEGIN
  -- Verify user is tenant admin
  IF NOT (p_tenant_id = auth_tenant_id() AND auth_has_tenant_role(array['tenant_owner', 'tenant_admin'])) THEN
    RAISE EXCEPTION 'Unauthorized: must be tenant admin';
  END IF;

  -- Check if Workforce Assistant already exists for this tenant
  SELECT id INTO v_de_id FROM digital_employees
  WHERE tenant_id = p_tenant_id AND is_workforce_assistant = true;

  IF v_de_id IS NOT NULL THEN
    RETURN json_build_object('success', false, 'error', 'Workforce Assistant already exists for this tenant');
  END IF;

  -- Build default charter
  v_default_charter := jsonb_build_object(
    'name', 'Workforce Assistant',
    'persona', 'You are a trusted advisor helping this organization hire, improve, and manage their digital workforce. You are an expert on the DreamTeamAI platform, including all features, patterns, and best practices.',
    'responsibilities', jsonb_build_array(
      'Help hire new DEs by understanding role requirements',
      'Suggest improvements to underperforming DEs based on metrics',
      'Monitor team performance and provide insights',
      'Help retire DEs and transition knowledge',
      'Train new tenants on DreamTeamAI features',
      'Recommend playbook patterns and guardrails'
    ),
    'guardrails', jsonb_build_array(
      'Never auto-approve DE changes without explicit user consent',
      'Always show evidence (CSAT, escalation, cost impact) for recommendations',
      'Prioritize user success over automation',
      'Escalate ambiguous decisions to the tenant admin'
    )
  );

  -- Override if provided
  IF p_charter_override IS NOT NULL THEN
    v_assistant_charter := v_default_charter || p_charter_override;
  ELSE
    v_assistant_charter := v_default_charter;
  END IF;

  -- Create the Workforce Assistant DE
  INSERT INTO digital_employees (
    tenant_id,
    name,
    status,
    charter,
    is_workforce_assistant,
    is_product_expert,
    created_by
  ) VALUES (
    p_tenant_id,
    'Workforce Assistant',
    'active',
    v_assistant_charter,
    true,
    true,
    auth.uid()
  ) RETURNING id INTO v_de_id;

  -- Create initial deployment stage (live)
  INSERT INTO de_deployment_stages (de_id, stage)
  VALUES (v_de_id, 'live');

  RETURN json_build_object(
    'success', true,
    'de_id', v_de_id,
    'message', 'Workforce Assistant provisioned successfully',
    'charter', v_assistant_charter
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 11. SEED PRODUCT KNOWLEDGE BASE
-- ════════════════════════════════════════════════════════════════════════════════════════

INSERT INTO de_product_knowledge (topic, subtopic, title, content, keywords) VALUES
('features', 'playbook_3_0', 'Playbook 3.0: Living Procedures',
'Playbooks are living procedures that improve themselves. Key features:
- Compiler: validates steps and knowledge bindings at draft time
- Deep Study: embeds relevant knowledge chunks into each step
- Judgment runtime: blocking gates ensure DE decisions are grounded in approved knowledge
- Living Document: annotations, redlines, and amendment tracking
- Self-amendment: playbooks propose their own improvements based on performance
- Conversation mining: learns from actual customer conversations',
ARRAY['playbook', 'living', 'amendment', 'self-improving']),

('features', 'amendment_system', 'Amendment System: Propose → Test → Approve → Apply',
'Every DE improvement goes through the amendment flow:
1. Propose: user or system suggests a change (to charter, playbook, guardrails)
2. Test: counterfactual replay testing validates the change against golden set
3. Approve: human reviews redline and replay results, then approves
4. Apply: amendment is applied to live DE or saved as draft
The amendment system tracks all changes for audit and rollback.',
ARRAY['amendment', 'replay', 'testing', 'approval']),

('features', 'trust_dial', 'Trust Dial: Graduated Autonomy',
'Every DE has a trust level (0-1) that determines its decision-making scope:
- 0.0-0.3: Shadow mode (shadows human decisions, no autonomous action)
- 0.3-0.6: Co-pilot mode (drafts responses, human approves before sending)
- 0.6-0.9: Live mode (autonomous with guardrails, human reviews after)
- 0.9-1.0: Autonomous (full autonomy, exceptions escalate)
Trust dial adjusts based on performance metrics (CSAT, escalation rate, cost).',
ARRAY['trust', 'autonomy', 'governance', 'dial']),

('features', 'guardrails', 'Guardrails: Constitutional Rules',
'Guardrails are explicit rules that govern DE behavior:
- Scope: workspace, department, DE, playbook, role
- Types: action guardrails (what DE can do), knowledge guardrails (what DE can reference), judgment rules (how DE decides)
- Enforcement: UN-TOGGLEABLE (cannot be disabled via feature flag; must be amended through review process)
- Feedback: violations are logged and trigger escalation',
ARRAY['guardrails', 'governance', 'rules', 'safety']),

('features', 'de_internship_stages', 'DE Internship Stages: Graduated Deployment',
'DEs progress through 4 stages:
1. Shadow: DE shadows human decisions, drafts responses for review
2. Co-pilot: DE suggests responses, human approves before sending
3. Live: DE sends responses autonomously, human reviews after
4. Retired: DE is no longer active (knowledge archived)
Each stage has configurable metrics for auto-promotion (e.g., CSAT > 90%, escalation < 5%).',
ARRAY['deployment', 'stages', 'training', 'internship']),

('governance', 'de_constitution', 'Digital Workforce Constitution: 10 Principles',
'DEs are employees with constitutional rights and duties:
1. Identity: explicit charter and profile
2. Responsibilities: enumerated and measurable
3. Judgment: decisions must be explainable and grounded
4. Learning: DEs improve through amendments and training
5. Accountability: all actions are audited and traceable
6. Escalation: ambiguous cases escalate to humans
7. Governance: guardrails are constitutional law (UN-TOGGLEABLE)
8. Economics: ROI and cost are tracked per DE
9. Retirement: graceful knowledge transfer and archival
10. Trust: autonomy is earned through performance',
ARRAY['constitution', 'principles', 'governance', 'DE']),

('economics', 'de_roi_calculation', 'DE ROI: Hours Saved + Quality Impact',
'Every DE is evaluated on ROI:
- Cost: base (monthly fee) + usage (per response, per amendment, per role)
- Benefit: hours saved (estimated from response volume) + quality improvement (CSAT delta vs human avg)
- ROI = (Benefit - Cost) / Cost
- Example: Support DE handles 200 tickets/month @ 30 min each = 100 hours saved = $2000 value. Cost $500/month. ROI = 300%',
ARRAY['ROI', 'economics', 'cost', 'benefit']),

('onboarding', 'new_tenant_setup', 'New Tenant Setup: 3 Steps',
'When a new tenant signs up:
1. Provision: create tenant record, provision Workforce Assistant, load platform knowledge
2. Onboarding: Workforce Assistant guides tenant through hiring first DE (conversational)
3. Live: Tenant can immediately hire, monitor, and improve DEs through chat interface',
ARRAY['onboarding', 'new tenant', 'setup', 'provisioning'])
ON CONFLICT (topic, subtopic, title) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 12. GRANT RLS PERMISSIONS
-- ════════════════════════════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE ON workforce_conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON workforce_actions TO authenticated;
GRANT SELECT ON de_product_knowledge TO authenticated;
GRANT SELECT, UPDATE ON de_deployment_stages TO authenticated;
GRANT SELECT, INSERT ON de_training_feedback TO authenticated;
GRANT SELECT ON de_role_assignments TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- DONE — Vercel Pro deployment with agentic capabilities enabled
-- ════════════════════════════════════════════════════════════════════════════════════════
