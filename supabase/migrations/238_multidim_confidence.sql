-- 238_multidim_confidence.sql
-- ============================================================================
-- Support hardening — MULTI-DIMENSIONAL confidence (READY-SCAFFOLDING).
--
-- Built at founder request, eyes-open: this is the durable schema + a
-- deterministic helper, NOT yet an active feature. A single confidence number
-- hides that an answer can be well-classified but weakly-resolved. The real
-- feature is the DE EMITTING per-dimension confidence, which is a change to the
-- de-answer path and (for the LLM-scored dims) needs Anthropic credits to
-- exercise. This ships the part that's safe + testable now so that change is a
-- one-line store when credits are available:
--
--   • de_messages.confidence_dimensions — where the dims land, per answer.
--   • compute_confidence_dimensions() — a DETERMINISTIC mapping from signals the
--     answer path already has (base confidence, whether it cited sources,
--     whether the customer was identified, whether an action was ready). So the
--     non-LLM dims (grounding / identity / action-readiness) are meaningful even
--     before richer LLM-scored dims (via eval-judge) are wired.
--
-- INERT until de-answer calls it — no behavior change on apply. Additive. GLOBAL.
-- ============================================================================

ALTER TABLE de_messages ADD COLUMN IF NOT EXISTS confidence_dimensions jsonb;

-- Deterministic dims from what the answer path already knows. Each input is
-- nullable; a null input drops that dimension (jsonb_strip_nulls) rather than
-- inventing a score. 'knowledge' mirrors the existing single confidence.
CREATE OR REPLACE FUNCTION public.compute_confidence_dimensions(
  p_base_confidence   int,
  p_has_sources       boolean DEFAULT NULL,
  p_identity_verified boolean DEFAULT NULL,
  p_action_ready      boolean DEFAULT NULL
) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'knowledge', greatest(0, least(100, coalesce(p_base_confidence, 0))),
    'grounding', case when p_has_sources is null then null when p_has_sources then 90 else 30 end,
    'identity',  case when p_identity_verified is null then null when p_identity_verified then 90 else 40 end,
    'action',    case when p_action_ready is null then null when p_action_ready then 80 else null end
  ));
$$;
REVOKE ALL ON FUNCTION public.compute_confidence_dimensions(int, boolean, boolean, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.compute_confidence_dimensions(int, boolean, boolean, boolean) TO authenticated, service_role;
