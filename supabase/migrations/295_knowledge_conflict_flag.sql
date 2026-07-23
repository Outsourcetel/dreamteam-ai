-- 295_knowledge_conflict_flag.sql
-- ============================================================================
-- KNOWLEDGE PHASE 5 — WS9 (2/3): the default-OFF feature flag that makes conflict
-- detection INERT by construction, plus the tunable thresholds + kill-switch key.
-- Still ZERO behavior — nothing reads these until the RPCs (mig 296) and the
-- enqueue trigger / drain (deferred, behind the 1-tenant validation gate) ship.
--
-- knowledge_conflict_detection (default OFF) gates BOTH the future enqueue trigger
-- and the drain's per-tenant fair-share list, so with no opt-in the probe queue is
-- empty and every future drain tick no-ops (the mig-291 reembed doctrine).
--
-- platform_config keys (plain TEXT column) are read at runtime with safe defaults
-- if absent — seeding them here just makes them discoverable/tunable without a
-- redeploy. 'knowledge.conflict_paused' is the independent kill-switch (absent or
-- anything but true/1/t = not paused). GLOBAL, additive.
-- ============================================================================

INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('knowledge_conflict_detection', 'Conflict & duplicate detection',
        'Detect near-duplicate and contradicting knowledge for human review. Default OFF — enable per workspace after validating on one tenant.',
        false, 'quality')
ON CONFLICT (key) DO NOTHING;

-- Tunable thresholds + kill-switch (text values; consumers coalesce to these defaults).
INSERT INTO platform_config (key, value) VALUES
  ('knowledge.conflict_paused',              'false'),  -- kill-switch: true/1/t => drain no-ops
  ('knowledge.conflict.near_dup_max',        '0.05'),   -- <= this cosine distance => near_duplicate (no LLM)
  ('knowledge.conflict.candidate_max',       '0.18'),   -- near_dup_max < d <= this => LLM-adjudication candidate
  ('knowledge.conflict.k_neighbors',         '5'),      -- top-k neighbours probed per changed chunk
  ('knowledge.conflict.candidates_per_chunk','3'),      -- max candidates adjudicated per chunk
  ('knowledge.conflict.max_chunks_per_tick', '10'),     -- drain batch size
  ('knowledge.conflict.max_llm_per_tick',    '20'),     -- hard LLM-call cap per tick
  ('knowledge.conflict.min_confidence',      '0.6')     -- min LLM confidence to persist a potential_conflict
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
