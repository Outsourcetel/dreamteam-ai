-- 299_knowledge_conflict_automation.sql
-- ============================================================================
-- KNOWLEDGE PHASE 5 — WS9 automation: make detection run on its own, INERT until
-- a workspace opts into the default-OFF flag knowledge_conflict_detection.
--   • enqueue trigger — AFTER INSERT/UPDATE OF content,embedding on chunks, flag-
--     gated, enqueues the changed chunk once it has an embedding, and supersedes
--     its stale open findings (tenant-scoped, index-served — no cross-tenant scan).
--   • drain cron — every 3 min invoke_conflict_probe_drain(); no-ops while the
--     queue is empty (i.e. for every tenant that hasn't opted in).
--   • get_knowledge_conflict_status — {enabled, open_count} so the UI shows an
--     honest "not enabled" vs "none found" state.
-- Validated end-to-end on one tenant before this shipped. GLOBAL, additive.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enqueue_conflict_probe()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Fire only for an embedded chunk whose content/embedding meaningfully changed,
  -- and only for tenants that opted in (default-OFF flag → inert for everyone else).
  IF NEW.embedding IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.embedding IS NULL OR NEW.content_hash IS DISTINCT FROM OLD.content_hash)
     AND is_feature_enabled_internal(NEW.tenant_id, 'knowledge_conflict_detection') THEN
    INSERT INTO knowledge_conflict_probe_queue (tenant_id, chunk_id, doc_id, content_hash)
    VALUES (NEW.tenant_id, NEW.id, NEW.doc_id, NEW.content_hash)
    ON CONFLICT (tenant_id, chunk_id) DO UPDATE
      SET content_hash = EXCLUDED.content_hash, enqueued_at = now(), probed_at = NULL, attempts = 0;
    -- A changed chunk invalidates its prior open findings.
    UPDATE knowledge_conflicts SET status = 'superseded'
     WHERE tenant_id = NEW.tenant_id AND status = 'open' AND NEW.id IN (chunk_a_id, chunk_b_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enqueue_conflict_probe ON knowledge_doc_chunks;
CREATE TRIGGER trg_enqueue_conflict_probe
  AFTER INSERT OR UPDATE OF content, embedding ON knowledge_doc_chunks
  FOR EACH ROW EXECUTE FUNCTION enqueue_conflict_probe();

-- UI status: is detection on for this tenant, and how many open findings.
CREATE OR REPLACE FUNCTION public.get_knowledge_conflict_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'ok', true,
    'enabled', is_feature_enabled_internal(auth_tenant_id(), 'knowledge_conflict_detection'),
    'open_count', (SELECT count(*) FROM knowledge_conflicts
                    WHERE tenant_id = auth_tenant_id() AND status = 'open'));
$$;
REVOKE ALL ON FUNCTION public.get_knowledge_conflict_status() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_knowledge_conflict_status() TO authenticated, service_role;

-- Every 3 minutes; self-limiting (empty queue when no tenant opted in → no-op).
SELECT cron.schedule('knowledge-conflict-probe-drain', '*/3 * * * *', 'select invoke_conflict_probe_drain()');

NOTIFY pgrst, 'reload schema';
