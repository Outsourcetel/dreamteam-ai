-- Migration 008: Per-DE model provider and model ID

ALTER TABLE digital_employees
  ADD COLUMN IF NOT EXISTS model_provider text NOT NULL DEFAULT 'anthropic',
  ADD COLUMN IF NOT EXISTS model_id       text NOT NULL DEFAULT 'claude-haiku-4-5-20251001';
