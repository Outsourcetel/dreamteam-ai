-- 283_knowledge_overview.sql
-- KNOWLEDGE PHASE 2 — WS4: the Hub overview. The Hub was a data-less tab-router;
-- this gives it a corpus-level "state of your knowledge" read in ONE call,
-- reusing the Phase-1 denormalized signals (chunk/embed counts, citation_count,
-- last_verified_at) + gaps + the review queue. Tenant-scoped SECURITY DEFINER.
-- GLOBAL, additive.

CREATE OR REPLACE FUNCTION public.get_knowledge_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id(); v_out jsonb;
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;

  WITH d AS (
    SELECT * FROM knowledge_docs WHERE tenant_id = v_tenant AND is_current
  )
  SELECT jsonb_build_object(
    'ok', true,
    'total_docs',       (SELECT count(*) FROM d),
    'indexed_docs',     (SELECT count(*) FROM d WHERE embedded_count > 0),
    'keyword_only',     (SELECT count(*) FROM d WHERE embedded_count = 0),
    'stale_docs',       (SELECT count(*) FROM d WHERE last_verified_at IS NULL OR last_verified_at < now() - interval '90 days'),
    'role_shared',      (SELECT count(*) FROM d WHERE visibility = 'role'),
    'scoped',           (SELECT count(*) FROM d WHERE visibility = 'scoped'),
    'total_citations',  (SELECT coalesce(sum(citation_count), 0) FROM d),
    'cited_docs',       (SELECT count(*) FROM d WHERE citation_count > 0),
    'never_cited',      (SELECT count(*) FROM d WHERE citation_count = 0),
    'last_updated_at',  (SELECT max(updated_at) FROM d),
    'open_gaps',        (SELECT count(*) FROM knowledge_gap_clusters WHERE tenant_id = v_tenant AND status = 'open'),
    'pending_reviews',  (SELECT count(*) FROM de_improvements WHERE tenant_id = v_tenant AND status = 'review_pending')
                        + (SELECT count(*) FROM knowledge_revision_requests WHERE tenant_id = v_tenant AND status = 'pending_approval'),
    'top_cited', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT id, title, citation_count FROM d WHERE citation_count > 0
         ORDER BY citation_count DESC, updated_at DESC LIMIT 5) x), '[]'::jsonb),
    'recent', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT id, title, updated_at, embedded_count > 0 AS indexed FROM d
         ORDER BY updated_at DESC LIMIT 5) x), '[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.get_knowledge_overview() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_knowledge_overview() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
