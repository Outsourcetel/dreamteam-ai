-- 293_knowledge_coverage_demand.sql
-- ============================================================================
-- KNOWLEDGE PHASE 5 — WS10: coverage-vs-demand analytics (read-only, additive).
--
-- One SECURITY-DEFINER read RPC, get_knowledge_coverage_demand, that joins the
-- DEMAND signal (knowledge_gap_clusters — what employees couldn't answer) against
-- the COVERAGE signal (denormalized citation_count + usage_daily rollup — what
-- knowledge is actually used) so a workspace sees:
--   (a) top-demand gaps + whether the corpus even has near knowledge for them,
--   (b) never-cited docs (dead weight / not-yet-cited),
--   (c) coverage leaders (most-cited), (d) a citation trend.
--
-- Everything reads EXISTING denormalized counts + rollup + gap clusters — NO
-- unbounded scans and NOT the mig-101 read-time unnest.
--
-- The ONLY non-trivial cost is section (a)'s per-gap coverage probe, which REUSES
-- the proven tenant-guarded hybrid_match_knowledge (NOT a hand-rolled filtered-KNN
-- that recall-collapses at multi-tenant scale). Because it runs on every Quality
-- page load, it is gated default-OFF behind its own feature flag
-- knowledge_coverage_probe + a kill-switch; when off, (a) still returns the gaps
-- with coverage_state='unknown' and (b)/(c)/(d) are unaffected. GLOBAL, additive.
-- ============================================================================

-- Index-serve the two per-page list queries (plain CREATE INDEX — trivial lock at
-- current scale; CONCURRENTLY is the at-scale choice if these ever get large).
CREATE INDEX IF NOT EXISTS idx_kdocs_never_cited ON knowledge_docs (tenant_id, updated_at ASC)
  WHERE is_current AND citation_count = 0;
CREATE INDEX IF NOT EXISTS idx_kdocs_top_cited ON knowledge_docs (tenant_id, citation_count DESC)
  WHERE is_current AND citation_count > 0;

-- Coverage probe is opt-in (expensive-behavior default-OFF rule) + kill-switch.
INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('knowledge_coverage_probe', 'Coverage probe',
        'Compute live "is this demand covered?" verdicts on the Quality page by probing the corpus per gap. Default OFF — the rest of the analytics work without it.',
        false, 'analytics')
ON CONFLICT (key) DO NOTHING;
-- platform_config.value is a plain text column; 'false' = not paused.
INSERT INTO platform_config (key, value) VALUES ('knowledge.coverage_probe_paused', 'false')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_knowledge_coverage_demand(
  p_days int DEFAULT 30, p_gap_limit int DEFAULT 20, p_list_limit int DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_probe_on boolean := false;
  v_cfg text;
  v_gap_limit int := least(greatest(coalesce(p_gap_limit, 20), 1), 50);
  v_list_limit int := least(greatest(coalesce(p_list_limit, 10), 1), 50);
  v_days int := least(greatest(coalesce(p_days, 30), 1), 365);
  v_top_gaps jsonb; v_never jsonb; v_most jsonb; v_trend jsonb;
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;

  -- Probe gate: feature flag ON and not paused.
  IF is_feature_enabled_internal(v_tenant, 'knowledge_coverage_probe') THEN
    SELECT (value #>> '{}') INTO v_cfg FROM platform_config WHERE key = 'knowledge.coverage_probe_paused';
    v_probe_on := coalesce(v_cfg, '') NOT IN ('true', '1', 't');
  END IF;

  -- (a) TOP-DEMAND GAPS. When the probe is on, reuse hybrid_match_knowledge per
  -- gap (its inquiry + embedding) and derive coverage_state from whether a CITED
  -- doc chunk sits near. When off, coverage_state='unknown' (no probe cost).
  IF v_probe_on THEN
    SELECT jsonb_agg(row_to_json(x)) INTO v_top_gaps FROM (
      SELECT g.id, g.category, g.severity_score, g.member_count, g.reviewer_summary, g.status,
             cov.nearest_cited_dist,
             CASE
               WHEN NOT coalesce(cov.has_cited, false) THEN 'none'
               WHEN cov.nearest_cited_dist IS NULL THEN 'weak'            -- cited doc matched lexically only
               WHEN cov.nearest_cited_dist <= 0.25 THEN 'covered'
               WHEN cov.nearest_cited_dist <= 0.35 THEN 'weak'
               ELSE 'none'
             END AS coverage_state
      FROM knowledge_gap_clusters g
      JOIN evidence_runs er ON er.id = g.representative_run_id AND er.tenant_id = v_tenant
      LEFT JOIN LATERAL (
        SELECT bool_or(coalesce(d.citation_count, 0) > 0) AS has_cited,
               min(h.distance) FILTER (WHERE coalesce(d.citation_count, 0) > 0) AS nearest_cited_dist
        FROM hybrid_match_knowledge(v_tenant, er.inquiry, NULL, er.inquiry_embedding, 20, NULL, NULL, 0.35) h
        JOIN knowledge_docs d ON d.id = h.doc_id
      ) cov ON true
      WHERE g.tenant_id = v_tenant AND g.status = 'open' AND er.inquiry_embedding IS NOT NULL
      ORDER BY g.severity_score DESC NULLS LAST, g.member_count DESC
      LIMIT v_gap_limit
    ) x;
  ELSE
    SELECT jsonb_agg(row_to_json(x)) INTO v_top_gaps FROM (
      SELECT g.id, g.category, g.severity_score, g.member_count, g.reviewer_summary, g.status,
             NULL::float AS nearest_cited_dist, 'unknown'::text AS coverage_state
      FROM knowledge_gap_clusters g
      WHERE g.tenant_id = v_tenant AND g.status = 'open'
      ORDER BY g.severity_score DESC NULLS LAST, g.member_count DESC
      LIMIT v_gap_limit
    ) x;
  END IF;

  -- (b) NEVER-CITED LIST (oldest-uncited first; 14-day grace so a fresh import
  -- isn't labeled dead weight). Total count comes from get_knowledge_overview
  -- client-side (never_cited is the common case → don't O(corpus)-count here).
  SELECT jsonb_agg(row_to_json(x)) INTO v_never FROM (
    SELECT d.id, d.title, d.updated_at, d.last_verified_at
    FROM knowledge_docs d
    WHERE d.tenant_id = v_tenant AND d.is_current AND coalesce(d.citation_count, 0) = 0
      AND d.created_at < now() - interval '14 days'
    ORDER BY d.updated_at ASC
    LIMIT v_list_limit
  ) x;

  -- (c) COVERAGE LEADERS (most-cited).
  SELECT jsonb_agg(row_to_json(x)) INTO v_most FROM (
    SELECT d.id, d.title, d.citation_count, d.last_cited_at
    FROM knowledge_docs d
    WHERE d.tenant_id = v_tenant AND d.is_current AND coalesce(d.citation_count, 0) > 0
    ORDER BY d.citation_count DESC
    LIMIT v_list_limit
  ) x;

  -- (d) CITATION TREND from the usage rollup.
  SELECT jsonb_agg(row_to_json(x)) INTO v_trend FROM (
    SELECT u.usage_date, sum(u.cited_count)::int AS citations, count(DISTINCT u.doc_id)::int AS docs_cited
    FROM knowledge_doc_usage_daily u
    WHERE u.tenant_id = v_tenant AND u.usage_date >= (now()::date - v_days)
    GROUP BY u.usage_date ORDER BY u.usage_date
  ) x;

  RETURN jsonb_build_object('ok', true, 'probe_enabled', v_probe_on,
    'top_gaps', coalesce(v_top_gaps, '[]'::jsonb),
    'never_cited', coalesce(v_never, '[]'::jsonb),
    'most_cited', coalesce(v_most, '[]'::jsonb),
    'trend', coalesce(v_trend, '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.get_knowledge_coverage_demand(int, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_knowledge_coverage_demand(int, int, int) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
