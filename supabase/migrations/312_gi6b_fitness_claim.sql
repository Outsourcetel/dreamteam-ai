-- 312_gi6b_fitness_claim.sql
-- ============================================================================
-- GI-6b (driver support) — atomic claim so two cron ticks never double-fire the
-- expensive back-to-back replay for the same amendment.
--
-- mig 310's UNIQUE(amendment_id) makes the WRITE idempotent, but not the WORK:
-- without a claim, two ticks could each run ~20 LLM calls before one loses the
-- upsert. This inserts the honest NULL/NULL "in-flight / measured-no-result"
-- row FIRST (mirroring de-improve's 409-on-existing-row in-flight guard); the
-- driver proceeds only when it wins the claim. Any amendment that already has an
-- amendment_metrics row (claimed, succeeded, or failed) is never re-selected —
-- so the NULL/NULL row doubles as the fail-closed record. v1 = no auto-retry
-- (a stuck NULL/NULL is honest and never fabricates a delta). GLOBAL.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_amendment_for_fitness(
  p_tenant_id uuid, p_amendment_id uuid, p_entity_kind text, p_entity_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO amendment_metrics (tenant_id, amendment_id, entity_kind, entity_id,
      before_metrics, replay_score_before, replay_score_after, adopted_at)
  VALUES (p_tenant_id, p_amendment_id, p_entity_kind, p_entity_id,
      '{}'::jsonb, null, null, now())
  ON CONFLICT (amendment_id) DO NOTHING
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('claimed', v_id IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION public.claim_amendment_for_fitness(uuid, uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_amendment_for_fitness(uuid, uuid, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
