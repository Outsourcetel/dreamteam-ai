-- 348_repair_updated_at.sql
-- ============================================================================
-- REPAIR OF DAMAGE CAUSED BY MIGRATION 346. Mine, not inherited.
--
-- ── What I did ──────────────────────────────────────────────────────────────
-- 346 backfilled lifecycle_status with a single statement over every row:
--     UPDATE knowledge_docs SET lifecycle_status = CASE ... END WHERE ...
-- knowledge_docs carries a BEFORE UPDATE trigger, knowledge_docs_updated_at ->
-- update_updated_at(), which unconditionally sets new.updated_at = now(). So
-- all 2,000 documents across all 16 workspaces were stamped as edited at the
-- moment that migration ran.
--
-- I guarded exactly this in 347 — that migration disables the trigger around
-- its content_hash backfill and re-enables it after — and did not think of it
-- one migration earlier. Measured after the fact: distinct_update_seconds = 1
-- across the entire corpus, which is the signature of a bulk update.
--
-- ── What it actually cost ───────────────────────────────────────────────────
-- Measured rather than assumed:
--   · knowledge_freshness_weighting is default_enabled = true with zero
--     overrides, so it is ON for all 16 workspaces and does feed ranking.
--     The term is weight * exp(-ln2 * age_days / halflife) with weight 0.0007
--     and halflife 180. Documents aged 6-21 days scored ~0.000665; at age zero
--     they score 0.0007. That is a shift of ~0.000035 against RRF base scores
--     of ~0.0164 — roughly 0.2% of one rank position, applied near-uniformly to
--     every document. Ranking impact: real, negligible, and not differential.
--   · knowledge_verification_state (346) derives from
--     coalesce(last_verified_at, created_at) — created_at, deliberately, not
--     updated_at. So the derived lifecycle state is UNAFFECTED.
--   · 25 answer_cache rows were invalidated. They regenerate on demand.
--   · The genuine loss is informational: "last edited" now reads as today for
--     documents nobody has touched since they were imported.
--
-- ── Why this repair, and what it can and cannot restore ────────────────────
-- The prior values are gone; no audit row captured them (log_tenant_activity
-- short-circuits when auth.uid() is null, which is the case for the migration
-- runner). So this is a RECONSTRUCTION, not an undo, and it is stated as one.
--
-- updated_at is set back to created_at. Justification: the corpus was imported
-- between 2026-07-05 and 2026-07-20, exactly ONE document in 2,000 has a
-- previous_version_id, and nothing else suggests hand-editing. "This document
-- has not been edited since it was created" is true for approximately all of
-- them; "every document in your workspace was edited this afternoon" is false
-- for all of them. This cannot lose information that the bulk update had not
-- already destroyed.
--
-- The triggers are held off this time, which is the whole lesson.
-- ============================================================================

DO $repair$
DECLARE v_before int; v_after int; v_distinct_before int;
BEGIN
  SELECT count(DISTINCT date_trunc('second', updated_at)) INTO v_distinct_before FROM knowledge_docs;
  SELECT count(*) INTO v_before FROM knowledge_docs WHERE updated_at > created_at + interval '1 second';

  -- Only repair if the damage signature is actually present. If someone has
  -- since made real edits, this must not flatten them.
  IF v_distinct_before > 3 THEN
    RAISE NOTICE '348: % distinct update timestamps — corpus looks organic, refusing to rewrite', v_distinct_before;
    RETURN;
  END IF;

  ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_updated_at;
  ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_invalidate_cache;

  UPDATE knowledge_docs SET updated_at = created_at
   WHERE updated_at > created_at + interval '1 second';
  GET DIAGNOSTICS v_after = ROW_COUNT;

  ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_updated_at;
  ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_invalidate_cache;

  RAISE NOTICE '348: restored updated_at on % of % stamped documents', v_after, v_before;
END $repair$;

-- ── Prove the repair, and that the triggers are back ───────────────────────
DO $assert$
DECLARE v_stamped int; v_spread int; v_enabled int;
BEGIN
  SELECT count(*) INTO v_stamped FROM knowledge_docs
   WHERE updated_at > created_at + interval '1 second';
  SELECT count(DISTINCT date_trunc('day', updated_at)) INTO v_spread FROM knowledge_docs;

  IF v_stamped > 0 THEN
    RAISE EXCEPTION '348: % documents still carry the bulk-update stamp', v_stamped;
  END IF;
  IF v_spread < 2 THEN
    RAISE EXCEPTION '348: updated_at is still collapsed to a single day — repair did not take';
  END IF;

  -- Re-enabling matters more than the repair: a permanently disabled
  -- updated_at trigger would silently stop tracking real edits forever.
  SELECT count(*) INTO v_enabled FROM pg_trigger
   WHERE tgrelid = 'public.knowledge_docs'::regclass
     AND tgname IN ('knowledge_docs_updated_at','knowledge_docs_invalidate_cache')
     AND tgenabled <> 'D';
  IF v_enabled <> 2 THEN
    RAISE EXCEPTION '348: only % of 2 side-effect triggers are enabled — edits would stop being tracked', v_enabled;
  END IF;

  RAISE NOTICE '348: updated_at restored across % distinct days; both triggers live', v_spread;
END $assert$;

NOTIFY pgrst, 'reload schema';
