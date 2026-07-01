-- Migration 007: AI usage tracking and platform config

-- Platform-level config (API keys, global settings) — service role only
CREATE TABLE IF NOT EXISTS platform_config (
  key   text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- No RLS — only accessible via service role key from edge functions
-- Anon/authenticated roles cannot read this table

-- Add monthly token budget to tenants (default 100k tokens/month per tenant)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS monthly_token_budget integer NOT NULL DEFAULT 100000;

-- Track actual token usage per tenant per calendar month
CREATE TABLE IF NOT EXISTS tenant_ai_usage (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  year_month  text NOT NULL,  -- e.g. '2026-07'
  tokens_used integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, year_month)
);

ALTER TABLE tenant_ai_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON tenant_ai_usage
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Upsert token usage atomically (called from de-execute edge function)
CREATE OR REPLACE FUNCTION increment_tenant_token_usage(
  p_tenant_id  uuid,
  p_year_month text,
  p_tokens     integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO tenant_ai_usage (tenant_id, year_month, tokens_used, updated_at)
  VALUES (p_tenant_id, p_year_month, p_tokens, now())
  ON CONFLICT (tenant_id, year_month)
  DO UPDATE SET
    tokens_used = tenant_ai_usage.tokens_used + EXCLUDED.tokens_used,
    updated_at  = now();
END;
$$;
