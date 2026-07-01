-- 010: CSAT ratings on conversations + notifications queue
-- Run: supabase db push OR via Management API

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS csat_score       smallint   CHECK (csat_score IN (1, -1)),
  ADD COLUMN IF NOT EXISTS csat_submitted_at timestamptz;

-- Notification queue for alerts (escalations, budget warnings, etc.)
CREATE TABLE IF NOT EXISTS notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type          text NOT NULL,                   -- 'escalation_alert' | 'budget_warning' | 'csat_negative'
  status        text NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed'
  payload       jsonb NOT NULL DEFAULT '{}',
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_tenant_status ON notifications(tenant_id, status);
CREATE INDEX IF NOT EXISTS notifications_created_at ON notifications(created_at DESC);

-- RLS: service role only — no client access to raw notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_service_only ON notifications
  USING (false) WITH CHECK (false);
