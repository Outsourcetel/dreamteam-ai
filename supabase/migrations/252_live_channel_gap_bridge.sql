-- 252_live_channel_gap_bridge.sql
-- ============================================================================
-- W4-D (docs/16, Knowledge audit gap #1): the self-healing knowledge loop
-- was blind to the two highest-volume channels — de-answer (dock) and
-- widget-ask never wrote evidence rows, so their misses could never become
-- gap clusters or quality-calibration signals. The edge functions now write
-- a minimal evidence_run (+ needs_review decision) whenever a LIVE-channel
-- answer escalates with ZERO knowledge hits. This migration just widens the
-- source vocabulary so those rows are honestly labeled, never conflated
-- with the autonomous triage pipe.
-- ============================================================================
ALTER TABLE evidence_run_decisions DROP CONSTRAINT IF EXISTS evidence_run_decisions_source_check;
ALTER TABLE evidence_run_decisions ADD CONSTRAINT evidence_run_decisions_source_check
  CHECK (source IN ('manual', 'proactive_trigger', 'manual_simulation', 'live_channel'));

NOTIFY pgrst, 'reload schema';
