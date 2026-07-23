-- 290_knowledge_bulk_reembed.sql
-- ============================================================================
-- KNOWLEDGE PHASE 4 — WS7 Class-B: forced bulk re-embed (re-index), default-OFF.
-- Design improvement over the vetted delete→shadow-swap plan: re-embed chunks
-- IN PLACE — the drain recomputes each chunk's embedding and OVERWRITES it, so a
-- doc's vector is only ever replaced, never blanked. This sidesteps all three of
-- the adversary's criticals by construction (no keyword-only gap, no
-- embedded_content_hash stale-signal to get wrong, no one-time backfill). It is
-- the correct semantic for a forced re-index (content is unchanged — the ingest
-- path already re-chunks on edit via mig 286; this only refreshes embeddings,
-- e.g. after an embedding-model change).
--
-- INERT until opt-in: bulk_reembed_docs is gated on the default-OFF feature flag
-- knowledge_reembed, so nothing can be enqueued (and the drain has nothing to do)
-- until a workspace turns it on. A platform_config kill-switch pauses the drain.
-- GLOBAL, additive.
-- ============================================================================

ALTER TABLE knowledge_doc_chunks ADD COLUMN IF NOT EXISTS reembed_pending boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS kdc_reembed_pending_idx ON knowledge_doc_chunks (tenant_id) WHERE reembed_pending;

INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('knowledge_reembed', 'Bulk re-embed',
        'Allow forcing a re-index (re-embed) of selected documents. Default OFF — turn on per workspace when you need it.',
        false, 'ingestion')
ON CONFLICT (key) DO NOTHING;

-- Enqueue: mark the selected docs' chunks for in-place re-embed. Gated on the
-- default-OFF flag, capped, tenant-verified (foreign doc_id silently skipped).
CREATE OR REPLACE FUNCTION public.bulk_reembed_docs(p_doc_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id(); v_n int;
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  IF NOT public.is_feature_enabled_internal(v_tenant, 'knowledge_reembed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reembed_disabled'); END IF;
  IF p_doc_ids IS NULL OR array_length(p_doc_ids, 1) IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_docs'); END IF;
  IF array_length(p_doc_ids, 1) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'too_many', 'cap', 500); END IF;
  UPDATE knowledge_doc_chunks SET reembed_pending = true
   WHERE doc_id = ANY(p_doc_ids) AND tenant_id = v_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'chunks_queued', v_n);
END $$;
REVOKE ALL ON FUNCTION public.bulk_reembed_docs(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.bulk_reembed_docs(uuid[]) TO authenticated, service_role;

-- Backlog read for the UI: whether the workspace has re-embed enabled (so the UI
-- only offers the action where it's on) and how many chunks are still waiting.
CREATE OR REPLACE FUNCTION public.get_reembed_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'ok', true,
    'enabled', public.is_feature_enabled_internal(public.auth_tenant_id(), 'knowledge_reembed'),
    'pending', (SELECT count(*) FROM knowledge_doc_chunks
                 WHERE tenant_id = public.auth_tenant_id() AND reembed_pending));
$$;
REVOKE ALL ON FUNCTION public.get_reembed_status() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_reembed_status() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
