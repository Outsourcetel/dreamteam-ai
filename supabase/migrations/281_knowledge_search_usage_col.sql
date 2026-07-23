-- 281_knowledge_search_usage_col.sql
-- Surface the WS2 citation signal (mig 280) in the Library search so captured
-- usage isn't written-never-read: search_knowledge_docs now also returns
-- citation_count + last_cited_at. Return shape changes, so DROP + recreate the
-- mig-279 function verbatim + two columns. GLOBAL, additive.

DROP FUNCTION IF EXISTS public.search_knowledge_docs(text, text[], text, text, boolean, int, int);

CREATE OR REPLACE FUNCTION public.search_knowledge_docs(
  p_query        text    DEFAULT NULL,
  p_tags         text[]  DEFAULT NULL,
  p_source       text    DEFAULT NULL,
  p_visibility   text    DEFAULT NULL,
  p_current_only boolean DEFAULT true,
  p_limit        int     DEFAULT 50,
  p_offset       int     DEFAULT 0)
RETURNS TABLE (
  id uuid, title text, preview text, tags text[], source text, visibility text,
  share_archetype_key text, authority int, last_verified_at timestamptz,
  is_current boolean, chunk_count int, embedded_count int, updated_at timestamptz,
  citation_count int, last_cited_at timestamptz, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.auth_tenant_id();
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
BEGIN
  IF v_tenant IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH filtered AS (
    SELECT d.* FROM knowledge_docs d
     WHERE d.tenant_id = v_tenant
       AND (NOT p_current_only OR d.is_current)
       AND (p_source     IS NULL OR d.source = p_source)
       AND (p_visibility IS NULL OR d.visibility = p_visibility)
       AND (p_tags       IS NULL OR d.tags && p_tags)
       AND (v_q IS NULL OR d.search_tsv @@ websearch_to_tsquery('english', v_q))
  ), counted AS (SELECT count(*) AS n FROM filtered)
  SELECT f.id, f.title, left(coalesce(f.content, ''), 200) AS preview, f.tags, f.source, f.visibility,
         f.share_archetype_key, f.authority, f.last_verified_at, f.is_current,
         coalesce(f.chunk_count, 0), coalesce(f.embedded_count, 0), f.updated_at,
         coalesce(f.citation_count, 0), f.last_cited_at,
         (SELECT n FROM counted) AS total_count
    FROM filtered f
   ORDER BY
     CASE WHEN v_q IS NULL THEN 0 ELSE ts_rank(f.search_tsv, websearch_to_tsquery('english', v_q)) END DESC,
     f.updated_at DESC
   LIMIT greatest(1, least(200, coalesce(p_limit, 50)))
  OFFSET greatest(0, coalesce(p_offset, 0));
END $$;
REVOKE ALL ON FUNCTION public.search_knowledge_docs(text, text[], text, text, boolean, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.search_knowledge_docs(text, text[], text, text, boolean, int, int) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
