-- 284_knowledge_taxonomy.sql
-- ============================================================================
-- KNOWLEDGE PHASE 3 — WS5: taxonomy for a large corpus. Today there are no
-- collections/folders and tags are freeform comma strings. This adds:
--   * knowledge_collections (named, hierarchical) — tenant-member managed
--   * knowledge_tags catalog (governed tags: description + colour)
--   * knowledge_doc_collections m2m junction with tenant_id DENORMALIZED so RLS
--     is a direct tenant_id predicate, never a doc join (adversary scale fix)
--   * assign/unassign RPCs that verify BOTH doc + collection belong to the tenant
--   * a collection facet on search_knowledge_docs
-- GLOBAL, additive. Mirrors the knowledge_docs RLS (tenant_id = auth_tenant_id()).
-- ============================================================================

-- ── 1. Collections (hierarchy) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES knowledge_collections(id) ON DELETE SET NULL,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_collections_tenant_idx ON knowledge_collections (tenant_id);
ALTER TABLE knowledge_collections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_collections_rw ON knowledge_collections;
CREATE POLICY knowledge_collections_rw ON knowledge_collections
  FOR ALL USING (tenant_id = public.auth_tenant_id()) WITH CHECK (tenant_id = public.auth_tenant_id());

-- ── 2. Governed tag catalog (tags stay knowledge_docs.tags[]; this adds meta) ─
CREATE TABLE IF NOT EXISTS knowledge_tags (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tag         text NOT NULL,
  description text,
  color       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tag)
);
ALTER TABLE knowledge_tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_tags_rw ON knowledge_tags;
CREATE POLICY knowledge_tags_rw ON knowledge_tags
  FOR ALL USING (tenant_id = public.auth_tenant_id()) WITH CHECK (tenant_id = public.auth_tenant_id());

-- ── 3. Doc↔collection junction (tenant_id DENORMALIZED) ─────────────────────
CREATE TABLE IF NOT EXISTS knowledge_doc_collections (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doc_id        uuid NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, collection_id)
);
CREATE INDEX IF NOT EXISTS knowledge_doc_collections_col_idx ON knowledge_doc_collections (tenant_id, collection_id);
ALTER TABLE knowledge_doc_collections ENABLE ROW LEVEL SECURITY;
-- Direct-predicate RLS on the denormalized tenant_id (no doc join at scale).
DROP POLICY IF EXISTS knowledge_doc_collections_read ON knowledge_doc_collections;
CREATE POLICY knowledge_doc_collections_read ON knowledge_doc_collections
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- Writes go through the RPCs below (they verify both sides' tenant).

-- ── 4. Assign / unassign (verify BOTH doc + collection belong to the tenant) ─
CREATE OR REPLACE FUNCTION public.assign_doc_collection(p_doc_id uuid, p_collection_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE id = p_doc_id AND tenant_id = v_tenant)
    THEN RETURN jsonb_build_object('ok', false, 'error', 'doc_not_found'); END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE id = p_collection_id AND tenant_id = v_tenant)
    THEN RETURN jsonb_build_object('ok', false, 'error', 'collection_not_found'); END IF;
  INSERT INTO knowledge_doc_collections (tenant_id, doc_id, collection_id)
  VALUES (v_tenant, p_doc_id, p_collection_id)
  ON CONFLICT (doc_id, collection_id) DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.assign_doc_collection(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_doc_collection(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unassign_doc_collection(p_doc_id uuid, p_collection_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  DELETE FROM knowledge_doc_collections
   WHERE tenant_id = v_tenant AND doc_id = p_doc_id AND collection_id = p_collection_id;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.unassign_doc_collection(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.unassign_doc_collection(uuid, uuid) TO authenticated, service_role;

-- Per-collection doc counts (for the Library rail), tenant-scoped.
CREATE OR REPLACE FUNCTION public.list_knowledge_collections()
RETURNS TABLE (id uuid, parent_id uuid, name text, description text, doc_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.parent_id, c.name, c.description,
         (SELECT count(*) FROM knowledge_doc_collections dc WHERE dc.collection_id = c.id) AS doc_count
    FROM knowledge_collections c
   WHERE c.tenant_id = public.auth_tenant_id()
   ORDER BY c.name;
$$;
REVOKE ALL ON FUNCTION public.list_knowledge_collections() FROM anon;
GRANT EXECUTE ON FUNCTION public.list_knowledge_collections() TO authenticated, service_role;

-- ── 5. search_knowledge_docs gains a collection facet (DROP + recreate) ─────
DROP FUNCTION IF EXISTS public.search_knowledge_docs(text, text[], text, text, boolean, int, int);
CREATE OR REPLACE FUNCTION public.search_knowledge_docs(
  p_query         text    DEFAULT NULL,
  p_tags          text[]  DEFAULT NULL,
  p_source        text    DEFAULT NULL,
  p_visibility    text    DEFAULT NULL,
  p_collection_id uuid    DEFAULT NULL,
  p_current_only  boolean DEFAULT true,
  p_limit         int     DEFAULT 50,
  p_offset        int     DEFAULT 0)
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
       AND (p_collection_id IS NULL OR EXISTS (
              SELECT 1 FROM knowledge_doc_collections dc
               WHERE dc.doc_id = d.id AND dc.collection_id = p_collection_id))
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
REVOKE ALL ON FUNCTION public.search_knowledge_docs(text, text[], text, text, uuid, boolean, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.search_knowledge_docs(text, text[], text, text, uuid, boolean, int, int) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
