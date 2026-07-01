-- Agent Actions: records every action a Digital Employee wants to take,
-- pending human approval when requires_approval = true.
CREATE TABLE IF NOT EXISTS agent_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id   uuid,
  de_id             uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  agent_name        text NOT NULL,
  action_type       text NOT NULL,
  description       text,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','executed','failed')),
  confidence_score  numeric(4,3),
  requires_approval boolean NOT NULL DEFAULT true,
  approved_by       text,
  approved_at       timestamptz,
  payload           jsonb,
  result            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_actions_tenant ON agent_actions
  FOR ALL
  USING (
    tenant_id = (
      SELECT tenant_id FROM profiles WHERE user_id = auth.uid() LIMIT 1
    )
  );

SELECT create_update_trigger('agent_actions');
