-- 315_gi8_semantic_guardrail.sql
-- ============================================================================
-- GI-8 — SEMANTIC guardrail judge (schema + flags). Additive + INERT.
--
-- Today guardrail + compliance matching is keyword-era: decide_action_execution
-- and de-answer/widget-ask match guardrail_rules.pattern as regex/substring, so a
-- paraphrased PHI disclosure / TCPA / SoD violation slips through. This lands the
-- schema for a SEMANTIC second pass (an LLM judge) that AUGMENTS — never replaces
-- — the cheap deterministic regex first-pass on both the answer and action paths.
--
-- INERTNESS (two-tier, fails closed):
--   • Global master platform_config['semantic_guardrail.enabled'] — we seed NO
--     row, so it is absent = OFF. Nothing runs until a founder sets it 'true'.
--   • Per-tenant feature_registry.semantic_guardrail — seeded FALSE (must be,
--     because is_feature_enabled_internal FAILS OPEN on an unknown key).
--   • Mode platform_config['semantic_guardrail.mode'] — absent/'shadow' = observe
--     only (judge runs, logs, never blocks); 'enforce' = fail-closed blocking.
-- This migration changes NO behavior on apply. GLOBAL.
-- ============================================================================

-- (a) Per-tenant staging flag — seeded FALSE (is_feature_enabled_internal fails
--     open on unknown keys, so the row MUST exist and be false).
INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('semantic_guardrail',
        'Semantic guardrail judge',
        'AI second-pass that catches paraphrased violations of blocking guardrail & compliance-pack rules after the regex first-pass. Default OFF; fail-closed. Enable per workspace.',
        false, 'governance')
ON CONFLICT (key) DO NOTHING;

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM feature_registry WHERE key = 'semantic_guardrail') THEN
    RAISE EXCEPTION 'semantic_guardrail feature_registry row missing after seed';
  END IF;
END $assert$;

-- (b) Judge verdict cache — keyed on content + ruleset fingerprint so any rule
--     edit / pack attach (which bumps updated_at) instantly invalidates. NEVER
--     caches an 'error' verdict (availability must recover when budget/provider does).
CREATE TABLE IF NOT EXISTS semantic_guardrail_cache (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_scope            text NOT NULL,                 -- coalesce(de_id::text,'*')
  surface             text NOT NULL CHECK (surface IN ('answer','action')),
  content_sha256      text NOT NULL,
  ruleset_fingerprint text NOT NULL,
  verdict             text NOT NULL CHECK (verdict IN ('clean','violation')),
  rule_id             uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  UNIQUE (tenant_id, de_scope, surface, content_sha256, ruleset_fingerprint)
);
ALTER TABLE semantic_guardrail_cache ENABLE ROW LEVEL SECURITY;
-- RLS on + no policies = service-role only (the judge runs service-side).

-- (c) Shadow observation log — lets a pilot measure catch-rate + false-positive
--     rate BEFORE any tenant flips to enforce.
CREATE TABLE IF NOT EXISTS semantic_guardrail_shadow_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id           uuid,
  surface         text NOT NULL,
  verdict         text NOT NULL,                     -- clean | violation | error
  rule_id         uuid,
  rationale       text,
  content_preview text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE semantic_guardrail_shadow_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS semantic_guardrail_shadow_tenant_read ON semantic_guardrail_shadow_log;
CREATE POLICY semantic_guardrail_shadow_tenant_read ON semantic_guardrail_shadow_log
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
CREATE INDEX IF NOT EXISTS semantic_guardrail_shadow_tenant_idx
  ON semantic_guardrail_shadow_log (tenant_id, created_at DESC);

-- (d) Optional semantic-policy text — additive, nullable. The regex matcher NEVER
--     reads it; the judge falls back to each rule's existing natural-language
--     `rule` text when this is null (so PHI/TCPA/SoD work with zero backfill).
ALTER TABLE guardrail_rules ADD COLUMN IF NOT EXISTS semantic_policy text;
ALTER TABLE compliance_pack_rules ADD COLUMN IF NOT EXISTS semantic_policy text;

NOTIFY pgrst, 'reload schema';
