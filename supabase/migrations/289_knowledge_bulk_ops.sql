-- 289_knowledge_bulk_ops.sql
-- ============================================================================
-- KNOWLEDGE PHASE 4 — WS7 (Class-A): bulk maintenance over the mig-279 server-side
-- search. Multi-select a set of docs and tag / add-to-collection / mark-verified /
-- delete them in one call. All genuinely set-based (single statement), idempotent,
-- tenant-verified (a foreign doc_id is silently filtered, never mutated), and
-- CAPPED so no op can run away. Class-B bulk re-embed (queue + drain + shadow-swap)
-- is a separate, riskier follow-on — this slice has ZERO re-embed cost risk.
--
-- Delete note (adversary): the vetted plan suppressed the mig-279 per-chunk count
-- trigger via session_replication_role='replica' — but that ALSO disables the FK
-- ON DELETE CASCADE, orphaning chunks. Instead we cap bulk delete at 500 docs so
-- the trigger's cost stays bounded (~thousands of ops, sub-second) and the cascade
-- works normally. Larger deletes batch client-side.
-- GLOBAL, additive.
-- ============================================================================

-- Bulk add a tag to each doc's tag set (idempotent — dedups).
CREATE OR REPLACE FUNCTION public.bulk_add_doc_tag(p_doc_ids uuid[], p_tag text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id(); v_n int; v_tag text := btrim(coalesce(p_tag, ''));
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  IF p_doc_ids IS NULL OR array_length(p_doc_ids, 1) IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_docs'); END IF;
  IF array_length(p_doc_ids, 1) > 1000 THEN RETURN jsonb_build_object('ok', false, 'error', 'too_many'); END IF;
  IF v_tag = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'empty_tag'); END IF;
  UPDATE knowledge_docs
     SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(coalesce(tags, '{}') || ARRAY[v_tag]) t),
         updated_at = now()
   WHERE id = ANY(p_doc_ids) AND tenant_id = v_tenant AND NOT (coalesce(tags, '{}') @> ARRAY[v_tag]);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'updated', v_n);
END $$;
REVOKE ALL ON FUNCTION public.bulk_add_doc_tag(uuid[], text) FROM anon;
GRANT EXECUTE ON FUNCTION public.bulk_add_doc_tag(uuid[], text) TO authenticated, service_role;

-- Bulk add docs to a collection (verifies the collection is same-tenant).
CREATE OR REPLACE FUNCTION public.bulk_assign_collection(p_doc_ids uuid[], p_collection_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id(); v_n int;
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  IF p_doc_ids IS NULL OR array_length(p_doc_ids, 1) IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_docs'); END IF;
  IF array_length(p_doc_ids, 1) > 1000 THEN RETURN jsonb_build_object('ok', false, 'error', 'too_many'); END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE id = p_collection_id AND tenant_id = v_tenant) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'collection_not_found');
  END IF;
  INSERT INTO knowledge_doc_collections (tenant_id, doc_id, collection_id)
  SELECT v_tenant, d.id, p_collection_id FROM knowledge_docs d
   WHERE d.id = ANY(p_doc_ids) AND d.tenant_id = v_tenant
  ON CONFLICT (doc_id, collection_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'added', v_n);
END $$;
REVOKE ALL ON FUNCTION public.bulk_assign_collection(uuid[], uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.bulk_assign_collection(uuid[], uuid) TO authenticated, service_role;

-- Bulk mark verified today (stamps last_verified_at).
CREATE OR REPLACE FUNCTION public.bulk_mark_verified(p_doc_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id(); v_n int;
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  IF p_doc_ids IS NULL OR array_length(p_doc_ids, 1) IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_docs'); END IF;
  IF array_length(p_doc_ids, 1) > 1000 THEN RETURN jsonb_build_object('ok', false, 'error', 'too_many'); END IF;
  UPDATE knowledge_docs SET last_verified_at = now()
   WHERE id = ANY(p_doc_ids) AND tenant_id = v_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'verified', v_n);
END $$;
REVOKE ALL ON FUNCTION public.bulk_mark_verified(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.bulk_mark_verified(uuid[]) TO authenticated, service_role;

-- Bulk delete (hard). Capped at 500 so the mig-279 per-chunk count trigger cost
-- stays bounded and the FK cascade runs normally (no trigger suppression).
CREATE OR REPLACE FUNCTION public.bulk_delete_docs(p_doc_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id(); v_n int;
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  IF p_doc_ids IS NULL OR array_length(p_doc_ids, 1) IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_docs'); END IF;
  IF array_length(p_doc_ids, 1) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'too_many', 'cap', 500); END IF;
  DELETE FROM knowledge_docs WHERE id = ANY(p_doc_ids) AND tenant_id = v_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'deleted', v_n);
END $$;
REVOKE ALL ON FUNCTION public.bulk_delete_docs(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.bulk_delete_docs(uuid[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
