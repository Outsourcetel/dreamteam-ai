-- Migration 009: DE intelligence config — task type, tiered escalation

ALTER TABLE digital_employees
  ADD COLUMN IF NOT EXISTS task_type           text NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS escalation_model_id text NOT NULL DEFAULT 'claude-sonnet-5',
  ADD COLUMN IF NOT EXISTS escalation_threshold integer NOT NULL DEFAULT 60;
