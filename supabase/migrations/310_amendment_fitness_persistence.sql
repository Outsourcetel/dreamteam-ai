-- 310_amendment_fitness_persistence.sql
-- ============================================================================
-- GI-6b (persistence layer) — the write path for honest amendment fitness.
--
-- The atomic back-to-back replay (current vs proposed persona over one fixed
-- ordered golden set, pass-count delta) needs a place to land its result. The
-- existing writer record_amendment_after_metrics (mig 197/20260720) is FAIL-OPEN
-- under the only caller that can drive it: it resolves the tenant from
-- current_setting('app.current_tenant_id'), which is NEVER set for a
-- service-role/dispatch worker → the UPDATE matches zero rows and the feature is
-- silently dead on arrival (adversarial-review finding).
--
-- This migration adds the driver-safe persistence layer only (no answer-path,
-- no digest reproduction). It is INERT until the AREA-B measurement driver calls
-- record_amendment_fitness. GLOBAL.
--
-- Three parts:
--   1. UNIQUE(amendment_id) so the measurement is idempotent (a re-run updates,
--      never duplicates). Table is empty in prod (fitness has never been
--      recorded) so the constraint adds cleanly.
--   2. Re-assert the auth_tenant_id() RLS on amendment_metrics as the HIGHEST
--      migration — mig 197 fixed the GUC RLS, but on a fresh sorted replay
--      "197_" sorts BEFORE "20260720_", so 20260720's GUC policies would win and
--      break reads. Reproduced verbatim from mig 197:101-108.
--   3. record_amendment_fitness — a single explicit-tenant SECURITY DEFINER
--      UPSERT (no GUC), service_role only. Writes both scores atomically
--      (the measurement is one back-to-back run, not two time-separated captures).
--      NULL scores are allowed and honest: a row with NULL before/after records
--      "measured, no valid result" and is auto-excluded from the digest's
--      avg(after-before) WHERE both-not-null — so it never fabricates a delta.
-- ============================================================================

-- 1. Idempotency key -----------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'amendment_metrics' AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) ILIKE '%amendment_id%'
  ) THEN
    ALTER TABLE amendment_metrics ADD CONSTRAINT amendment_metrics_amendment_id_key UNIQUE (amendment_id);
  END IF;
END $$;

-- 2. Re-assert GUC-free RLS as the highest migration (defeat the sort hazard) --
-- Verbatim from mig 197:101-108 — the live, correct auth_tenant_id() version.
DROP POLICY IF EXISTS "Tenant members can view own metrics" ON amendment_metrics;
DROP POLICY IF EXISTS "Tenant can update own metrics" ON amendment_metrics;
DROP POLICY IF EXISTS "Tenant can insert metrics" ON amendment_metrics;
CREATE POLICY "Tenant members can view own metrics"
ON amendment_metrics FOR SELECT
USING (tenant_id = public.auth_tenant_id());
-- Writes go through the SECURITY DEFINER writers only.
REVOKE INSERT, UPDATE ON amendment_metrics FROM authenticated;

-- 3. Explicit-tenant, driver-safe atomic writer --------------------------------
CREATE OR REPLACE FUNCTION public.record_amendment_fitness(
  p_tenant_id      uuid,
  p_amendment_id   uuid,
  p_entity_kind    text,
  p_entity_id      uuid,
  p_before_metrics jsonb,
  p_after_metrics  jsonb,
  p_score_before   numeric,
  p_score_after    numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO amendment_metrics (
    tenant_id, amendment_id, entity_kind, entity_id,
    before_metrics, after_metrics, replay_score_before, replay_score_after, adopted_at
  )
  VALUES (
    p_tenant_id, p_amendment_id, p_entity_kind, p_entity_id,
    coalesce(p_before_metrics, '{}'::jsonb), p_after_metrics, p_score_before, p_score_after, now()
  )
  ON CONFLICT (amendment_id) DO UPDATE SET
    before_metrics      = coalesce(excluded.before_metrics, amendment_metrics.before_metrics),
    after_metrics       = excluded.after_metrics,
    replay_score_before = excluded.replay_score_before,
    replay_score_after  = excluded.replay_score_after,
    adopted_at          = now(),
    updated_at          = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.record_amendment_fitness(uuid, uuid, text, uuid, jsonb, jsonb, numeric, numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_amendment_fitness(uuid, uuid, text, uuid, jsonb, jsonb, numeric, numeric) TO service_role;

NOTIFY pgrst, 'reload schema';
