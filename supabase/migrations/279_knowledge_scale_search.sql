-- 279_knowledge_scale_search.sql
-- ============================================================================
-- KNOWLEDGE PHASE 1 — the scale keystone (founder: "support any requirements at
-- large scale"). Designed + adversarially verified (wf_0cad73f1-1e5). Two scale
-- time-bombs in the Library today:
--   (a) it fetches EVERY doc with full content (.select('*')) into the browser;
--   (b) chunk-status is a grouped COUNT over the whole knowledge_doc_chunks table
--       on every render (millions of rows at scale).
-- This migration kills both: (1) denormalized chunk_count/embedded_count on
-- knowledge_docs, maintained incrementally (O(1) per chunk change) by a trigger
-- so no reader ever aggregates chunks; (2) search_knowledge_docs — a paginated,
-- faceted, server-side search over the EXISTING search_tsv (mig 046) that returns
-- a 200-char preview, never full content. GLOBAL, additive.
-- ============================================================================

-- ── 1. Denormalized chunk counts (readers never aggregate chunks again) ─────
ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS chunk_count    int NOT NULL DEFAULT 0;
ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS embedded_count int NOT NULL DEFAULT 0;

-- one-time backfill from the current chunk table
UPDATE knowledge_docs d SET
  chunk_count    = coalesce(c.n, 0),
  embedded_count = coalesce(c.e, 0)
FROM (SELECT doc_id, count(*) AS n, count(embedding) AS e
        FROM knowledge_doc_chunks GROUP BY doc_id) c
WHERE c.doc_id = d.id;

-- incremental maintenance — O(1) per chunk INSERT/UPDATE/DELETE, self-consistent
-- with the backfill baseline. The embed pipeline (embedding null → vector) hits
-- the UPDATE branch and bumps embedded_count; no edge change needed.
CREATE OR REPLACE FUNCTION public.maintain_doc_chunk_counts()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE knowledge_docs SET
      chunk_count    = coalesce(chunk_count, 0) + 1,
      embedded_count = coalesce(embedded_count, 0) + (CASE WHEN NEW.embedding IS NOT NULL THEN 1 ELSE 0 END)
     WHERE id = NEW.doc_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE knowledge_docs SET
      chunk_count    = greatest(coalesce(chunk_count, 0) - 1, 0),
      embedded_count = greatest(coalesce(embedded_count, 0) - (CASE WHEN OLD.embedding IS NOT NULL THEN 1 ELSE 0 END), 0)
     WHERE id = OLD.doc_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (OLD.embedding IS NULL) IS DISTINCT FROM (NEW.embedding IS NULL) THEN
      UPDATE knowledge_docs SET
        embedded_count = greatest(coalesce(embedded_count, 0) + (CASE WHEN NEW.embedding IS NOT NULL THEN 1 ELSE -1 END), 0)
       WHERE id = NEW.doc_id;
    END IF;
    IF NEW.doc_id IS DISTINCT FROM OLD.doc_id THEN
      UPDATE knowledge_docs SET chunk_count = greatest(coalesce(chunk_count, 0) - 1, 0) WHERE id = OLD.doc_id;
      UPDATE knowledge_docs SET chunk_count = coalesce(chunk_count, 0) + 1 WHERE id = NEW.doc_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_maintain_doc_chunk_counts ON knowledge_doc_chunks;
CREATE TRIGGER trg_maintain_doc_chunk_counts
  AFTER INSERT OR UPDATE OR DELETE ON knowledge_doc_chunks
  FOR EACH ROW EXECUTE FUNCTION public.maintain_doc_chunk_counts();

-- ── 2. Server-side faceted, paginated search (never ships full content) ─────
-- Reads the existing search_tsv (mig 046) for full-text; facets on tags/source/
-- visibility; returns a preview + the denormalized counts + a window total so
-- the client can page without ever loading the corpus. Tenant-scoped via
-- auth_tenant_id() under SECURITY DEFINER (bypasses RLS but hard-filters tenant).
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
  total_count bigint)
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
