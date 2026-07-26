-- 331_features_global_default.sql
-- ============================================================================
-- Make every feature the Outsourcetel workspace runs the DEFAULT for every
-- tenant — existing and future. Founder decision, 2026-07-25.
--
-- MECHANISM MATTERS. The right lever is feature_registry.default_enabled, NOT a
-- per-tenant override row. is_feature_enabled_internal resolves
-- tenant_feature_overrides first and falls back to the registry default, so
-- flipping the default covers every tenant that exists AND every tenant created
-- from now on, with no provisioning step to forget. This is the standing
-- "always live to all tenants" rule: features ship global via the baseline,
-- never tenant-scoped.
--
-- The eight per-tenant override rows that pinned these ON for outsourcetel-hq
-- are then DELETED. They are now redundant, and leaving them would mean two
-- sources of truth — the failure mode where someone later flips a default and
-- one workspace silently keeps the old value.
--
-- APPLIED AFTER migration 330 ON PURPOSE. 330 closed the anon cross-tenant path
-- (26 SECURITY DEFINER RPCs where an unauthenticated caller passed the tenant
-- guard because anon, like the service role, has a NULL auth.uid()). Widening
-- features to every tenant before closing that would have widened the blast
-- radius of the hole at the same time.
--
-- WHAT EACH ONE ACTUALLY DOES WHEN ON — verified, not assumed:
--   knowledge_ann_retrieval        ANN index for retrieval. Ranking/perf only.
--   knowledge_freshness_weighting  Recency weighting in ranking. No new spend.
--   knowledge_conflict_detection   Finds contradictory docs. Compute bounded by
--                                  the knowledge.conflict.* caps in platform_config.
--   knowledge_coverage_probe       Analytics. Has its own pause switch.
--   knowledge_reembed              PERMITS a bulk re-embed; does not start one.
--                                  reembed-drain stays inert until a human
--                                  triggers a run, so this costs nothing by itself.
--   grounded_confidence            Turns on SHADOW LOGGING of grounded-vs-self
--                                  confidence. Blending into escalation is gated
--                                  SEPARATELY by a per-tenant row in
--                                  grounded_confidence_validation — only
--                                  outsourcetel-hq has one, so no other tenant's
--                                  escalation behaviour changes.
--   guardrail_adjudication         GI-10. Still inert per tenant until one of
--                                  their admins opts a SPECIFIC rule in via
--                                  set_rule_adjudicable, and the platform mode is
--                                  'shadow', which records but never releases.
--   computer_use                   Browser Operator. The genuine autonomy
--                                  expansion in this set: it lets a tenant's DEs
--                                  drive a real browser, with real per-session
--                                  cost. Raised as the highest-blast-radius item
--                                  and enabled on the founder's explicit decision.
--
-- Suspended tenants are unaffected in practice — the tenant status gate stops
-- their traffic before any feature flag is read. GLOBAL.
-- ============================================================================

UPDATE feature_registry
   SET default_enabled = true
 WHERE key IN (
   'knowledge_ann_retrieval',
   'knowledge_freshness_weighting',
   'knowledge_conflict_detection',
   'knowledge_coverage_probe',
   'knowledge_reembed',
   'grounded_confidence',
   'guardrail_adjudication',
   'computer_use'
 );

-- Drop the now-redundant per-tenant pins so the registry default is the single
-- source of truth. Only removes rows that AGREE with the new default (enabled),
-- so an intentional per-tenant OFF is never silently flipped on.
DELETE FROM tenant_feature_overrides
 WHERE enabled = true
   AND feature_key IN (
     'knowledge_ann_retrieval',
     'knowledge_freshness_weighting',
     'knowledge_conflict_detection',
     'knowledge_coverage_probe',
     'knowledge_reembed',
     'grounded_confidence',
     'guardrail_adjudication',
     'computer_use'
   );

DO $assert$
DECLARE v_off int; v_left int; v_sample boolean;
BEGIN
  SELECT count(*) INTO v_off FROM feature_registry
   WHERE key IN ('knowledge_ann_retrieval','knowledge_freshness_weighting',
                 'knowledge_conflict_detection','knowledge_coverage_probe',
                 'knowledge_reembed','grounded_confidence',
                 'guardrail_adjudication','computer_use')
     AND default_enabled IS DISTINCT FROM true;
  IF v_off > 0 THEN RAISE EXCEPTION '331: % of the 8 features did not flip', v_off; END IF;

  SELECT count(*) INTO v_left FROM tenant_feature_overrides
   WHERE enabled = true
     AND feature_key IN ('knowledge_ann_retrieval','knowledge_freshness_weighting',
                         'knowledge_conflict_detection','knowledge_coverage_probe',
                         'knowledge_reembed','grounded_confidence',
                         'guardrail_adjudication','computer_use');
  IF v_left > 0 THEN RAISE EXCEPTION '331: % redundant override rows remain', v_left; END IF;

  -- Prove resolution for a tenant that never had an override.
  SELECT public.is_feature_enabled_internal(
           (SELECT id FROM tenants WHERE slug = 'gusto'), 'knowledge_conflict_detection')
    INTO v_sample;
  IF NOT coalesce(v_sample, false) THEN
    RAISE EXCEPTION '331: a tenant with no override does not resolve the new default';
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
