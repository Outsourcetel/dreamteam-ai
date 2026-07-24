-- 324_model_pricing_dated_aliases.sql
-- ============================================================================
-- COST ATTRIBUTION FIX — usage logged against a DATED model id is priced at ZERO.
--
-- ai_model_pricing holds base ids ('claude-haiku-4-5'), but de_token_usage records
-- whatever id the call actually used — including dated snapshots
-- ('claude-haiku-4-5-20251001'). Six separate cost functions
-- (migs 094/131/148/163/176/181) all do:
--     left join ai_model_pricing pr on pr.model_id = u.model_id
-- so an unmatched id yields NULL, and every one of them wraps it in
-- coalesce(...,0). The row therefore contributes EXACTLY ZERO cost.
--
-- Live impact on the Outsourcetel tenant when found: 177 of 302 usage rows
-- (59%) unmatched → counted as free. Cost is UNDER-stated, which is the
-- dangerous direction: it makes cost-per-resolution and every ROI figure look
-- better than reality.
--
-- Fixing the six join sites would mean reproducing six live functions — high
-- regression risk for an arithmetic bug. Instead this repairs the DATA, which
-- corrects all six at once with no code change: for every model id that appears
-- in usage but has no price row, insert an alias priced from its BASE model
-- (the id with a trailing -YYYYMMDD snapshot suffix removed) when that base is
-- priced. Idempotent; safe to re-run. GLOBAL.
--
-- NOTE (honest, not fixed here): this heals ids seen SO FAR. A brand-new dated
-- id still lands unpriced until this runs again. The durable fix is to normalise
-- at write time in record_de_token_usage, or to make the joins prefix-aware —
-- both touch live paths and are deliberately deferred to their own pass. The
-- reconciliation query at the end makes any new drift visible.
-- ============================================================================

INSERT INTO ai_model_pricing (model_id, input_price_per_million, output_price_per_million)
SELECT DISTINCT u.model_id, base.input_price_per_million, base.output_price_per_million
  FROM de_token_usage u
  JOIN ai_model_pricing base
    ON base.model_id = regexp_replace(u.model_id, '-[0-9]{8}$', '')
 WHERE u.model_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ai_model_pricing p WHERE p.model_id = u.model_id)
ON CONFLICT (model_id) DO NOTHING;

-- Reconciliation: any usage id still unpriced after this is genuine drift worth
-- seeing (a model nobody has priced at all), not a snapshot-suffix mismatch.
DO $$
DECLARE v_left int;
BEGIN
  SELECT count(DISTINCT u.model_id) INTO v_left
    FROM de_token_usage u
   WHERE u.model_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ai_model_pricing p WHERE p.model_id = u.model_id);
  IF v_left > 0 THEN
    RAISE NOTICE 'model pricing: % model id(s) still unpriced — their usage is costed at ZERO', v_left;
  END IF;
END $$;
