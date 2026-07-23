-- 302_conflict_backlog_uuid_fix.sql
-- ============================================================================
-- FIX: enqueue_conflict_backlog (mig 296) computed its keyset watermark with
-- max(id) — but id is uuid and Postgres has NO max(uuid) aggregate, so the RPC
-- errored at runtime ("function max(uuid) does not exist"). uuid supports ordering
-- (< >), just not the max aggregate, so take the last id via ORDER BY id DESC
-- LIMIT 1 instead. Behavior otherwise unchanged. GLOBAL, additive.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enqueue_conflict_backlog(
  p_tenant_id uuid, p_limit int DEFAULT 500, p_after_chunk_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int; v_last uuid;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT (p_tenant_id = auth_tenant_id()
              AND auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin'])) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF NOT is_feature_enabled_internal(p_tenant_id, 'knowledge_conflict_detection') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'detection_disabled');
  END IF;
  WITH batch AS (
    SELECT c.id, c.doc_id, c.tenant_id, c.content_hash
    FROM knowledge_doc_chunks c
    WHERE c.tenant_id = p_tenant_id AND c.embedding IS NOT NULL
      AND (p_after_chunk_id IS NULL OR c.id > p_after_chunk_id)
    ORDER BY c.id
    LIMIT least(greatest(coalesce(p_limit, 500), 1), 2000)
  ), ins AS (
    INSERT INTO knowledge_conflict_probe_queue (tenant_id, chunk_id, doc_id, content_hash)
    SELECT b.tenant_id, b.id, b.doc_id, b.content_hash FROM batch b
    ON CONFLICT (tenant_id, chunk_id) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins),
         (SELECT b.id FROM batch b ORDER BY b.id DESC LIMIT 1)   -- keyset watermark (no max(uuid))
    INTO v_n, v_last;
  RETURN jsonb_build_object('ok', true, 'seeded', coalesce(v_n, 0), 'last_chunk_id', v_last);
END $$;
REVOKE ALL ON FUNCTION public.enqueue_conflict_backlog(uuid, int, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.enqueue_conflict_backlog(uuid, int, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
