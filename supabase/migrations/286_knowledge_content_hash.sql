-- 286_knowledge_content_hash.sql
-- ============================================================================
-- KNOWLEDGE PHASE 4 — WS8 STEP 1 (storm-killer foundation). The re-embed storm
-- has two roots the adversary verified in code:
--   * connector-hub ingestDoc UNCONDITIONALLY deletes + re-embeds every chunk on
--     EVERY sync (the recurring cost),
--   * ingest-chunks NEVER re-chunks an edited doc (`if (!existingCount)`), so an
--     edit silently keeps STALE chunks (the inverse bug).
-- A doc-level content_hash over NORMALIZED content fixes BOTH: an unchanged
-- re-ingest becomes ~1 SELECT (skip), a real edit re-chunks. Columns are left
-- NULL (self-healing: the first post-deploy ingest of each doc recomputes +
-- stores the hash — no massive UPDATE). The chunk-level column is for WS7
-- incremental re-embed. Additive; columns inherit the tables' existing RLS.
-- ============================================================================

ALTER TABLE knowledge_docs       ADD COLUMN IF NOT EXISTS content_hash text; -- sha256(normalize(title\n\ncontent)); NULL => treat as changed
ALTER TABLE knowledge_doc_chunks ADD COLUMN IF NOT EXISTS content_hash text; -- sha256(normalize(chunk)); for WS7 incremental re-embed/dedup
CREATE INDEX IF NOT EXISTS kdc_doc_hash_idx ON knowledge_doc_chunks (doc_id, content_hash);

NOTIFY pgrst, 'reload schema';
