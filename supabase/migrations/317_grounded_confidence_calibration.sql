-- 317_grounded_confidence_calibration.sql
-- ============================================================================
-- §5 GROUNDED CONFIDENCE (schema + flags). Additive + INERT.
--
-- Today the DE's answer confidence is model SELF-REPORTED (de-answer asks the
-- model for it) and escalation / cache / — after GI-9 — the cert floor all trust
-- it blindly. A model can be confidently wrong. This lands the schema for a
-- GROUNDED signal derived from real retrieval support (distance / coverage /
-- corroboration, all already computed by hybrid_match_knowledge and free to
-- reuse). Thin/irrelevant KB → LOW confidence → escalate.
--
-- INERTNESS (mirrors GI-8, two-tier + fails closed on deploy order):
--   • Global master platform_config['grounded_confidence.enabled'] — seed NO row
--     (absent = OFF), so migration-before-function ordering can never fail open.
--   • Mode platform_config['grounded_confidence.mode'] — 'shadow' (default when
--     enabled) computes + LOGS the grounded value but NEVER changes behavior;
--     'blended' acts on min(self,grounded); 'grounded' advanced/not-recommended.
--   • Per-tenant feature_registry.grounded_confidence — seeded FALSE (must, as
--     is_feature_enabled_internal FAILS OPEN on unknown keys).
--   • Enforce precondition: a grounded_confidence_validation row per tenant —
--     blended/grounded is INERT without it, so shadow-first is unskippable (a
--     row can't honestly exist before shadow produced observations to review).
-- This migration changes NO behavior on apply. GLOBAL.
-- ============================================================================

-- (a) Per-tenant participation flag — seeded FALSE (fails-open guard).
INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('grounded_confidence',
        'Grounded answer confidence',
        'Compute answer confidence from real retrieval support (distance/coverage/corroboration) instead of trusting the model self-report. Default OFF; shadow-logs before it ever drives escalation. Enable per workspace.',
        false, 'governance')
ON CONFLICT (key) DO NOTHING;
DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM feature_registry WHERE key = 'grounded_confidence') THEN
    RAISE EXCEPTION 'grounded_confidence feature_registry row missing after seed';
  END IF;
END $assert$;

-- (b) Global master + mode live in platform_config; we seed NO rows (absent = OFF).

-- (c) Shadow observation log — both self + grounded confidence per answer, so a
--     pilot compares escalation rates on real traffic BEFORE grounded drives anything.
CREATE TABLE IF NOT EXISTS grounded_confidence_shadow_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id                 uuid,
  conversation_id       uuid,
  resolved_mode         text NOT NULL,
  is_synthetic          boolean NOT NULL DEFAULT false,   -- service/dispatch (cert/eval) — excluded from analysis AND blend
  source                text NOT NULL DEFAULT 'generate',
  self_confidence       int,
  grounded_confidence   int,
  effective_confidence  int,
  confidence_floor      int,
  self_would_escalate   boolean,
  grounded_would_escalate boolean,
  effective_escalated   boolean,
  retrieval             jsonb,
  question_preview      text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE grounded_confidence_shadow_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS grounded_confidence_shadow_tenant_read ON grounded_confidence_shadow_log;
CREATE POLICY grounded_confidence_shadow_tenant_read ON grounded_confidence_shadow_log
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
CREATE INDEX IF NOT EXISTS grounded_confidence_shadow_tenant_idx
  ON grounded_confidence_shadow_log (tenant_id, created_at DESC);

-- (d) Enforce precondition — mandatory shadow gate. blended/grounded is inert for
--     a tenant unless a row here exists; floors_rebaselined records that the cert +
--     per-DE confidence floors were re-checked against the grounded distribution
--     (else previously-passing DEs could fail re-cert on the confidence gate alone).
CREATE TABLE IF NOT EXISTS grounded_confidence_validation (
  tenant_id             uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  validated_at          timestamptz NOT NULL DEFAULT now(),
  validated_by          text,
  observations_reviewed int,
  floors_rebaselined    boolean NOT NULL DEFAULT false,
  notes                 text
);
ALTER TABLE grounded_confidence_validation ENABLE ROW LEVEL SECURITY;
-- RLS on + no policy = service-role only (founder-set via db-query, like GI-8 config).

NOTIFY pgrst, 'reload schema';
