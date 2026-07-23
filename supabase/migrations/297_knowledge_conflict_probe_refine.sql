-- 297_knowledge_conflict_probe_refine.sql
-- ============================================================================
-- KNOWLEDGE PHASE 5 — WS9 automation prep: refine probe_chunk_neighbors to
-- SELF-SERVE the query embedding by chunk id, instead of receiving a vector arg
-- from the drain worker. Cleaner (no 384-float vector serialized over the wire)
-- and removes a whole failure class (text→vector cast of an rpc arg). Signature
-- changes, so DROP + CREATE. Still service_role-only + inert. GLOBAL, additive.
-- ============================================================================

DROP FUNCTION IF EXISTS public.probe_chunk_neighbors(uuid, uuid, uuid, vector, int);

CREATE OR REPLACE FUNCTION public.probe_chunk_neighbors(
  p_tenant_id uuid, p_chunk_id uuid, p_doc_id uuid, p_k int DEFAULT 5)
RETURNS TABLE(neighbor_chunk_id uuid, neighbor_doc_id uuid, neighbor_content text, distance real)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emb vector;
BEGIN
  -- Only the drain worker (service role / dispatch) may probe — it trusts p_tenant_id.
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'probe_chunk_neighbors: service role only'; END IF;
  SELECT embedding INTO v_emb FROM knowledge_doc_chunks WHERE id = p_chunk_id AND tenant_id = p_tenant_id;
  IF v_emb IS NULL THEN RETURN; END IF;
  -- Keep walking the HNSW index until k tenant/doc-matched rows are found (pgvector
  -- >= 0.8) so a small tenant's neighbours aren't dropped by the post-filter.
  SET LOCAL hnsw.iterative_scan = 'relaxed_order';
  RETURN QUERY
  SELECT c.id, c.doc_id, c.content, (c.embedding <=> v_emb)::real AS distance
  FROM knowledge_doc_chunks c
  JOIN knowledge_docs d ON d.id = c.doc_id AND d.is_current
  WHERE c.tenant_id = p_tenant_id
    AND c.id <> p_chunk_id
    AND c.doc_id <> p_doc_id            -- ignore intra-doc chunk overlap
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> v_emb
  LIMIT greatest(1, least(p_k, 20));
END $$;
REVOKE ALL ON FUNCTION public.probe_chunk_neighbors(uuid, uuid, uuid, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.probe_chunk_neighbors(uuid, uuid, uuid, int) TO service_role;

NOTIFY pgrst, 'reload schema';
