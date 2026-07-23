-- 294_knowledge_conflict_tables.sql
-- ============================================================================
-- KNOWLEDGE PHASE 5 — WS9 (1/3): conflict/duplicate detection TABLES. Purely
-- additive and fully INERT — no trigger, no cron, nothing writes to these yet
-- (the enqueue trigger + drain ship later, gated behind a default-OFF flag).
--
-- Two tables:
--   knowledge_conflict_probe_queue — new/changed chunks awaiting a neighbour probe
--     (drained in bounded batches; index-served by the pending partial index).
--   knowledge_conflicts — persisted findings a human reviews (pick authoritative /
--     merge / dismiss). Canonicalized chunk_a<chunk_b so a pair is stored once.
--
-- Writes go ONLY through SECURITY DEFINER RPCs (mig 296) — RLS is SELECT-only.
-- Also adds the missing CHECK (authority BETWEEN 0 AND 100) on knowledge_docs so
-- the resolve-time authority nudge (mig 296) can never drive a doc's ranking
-- weight out of range (all rows are currently 0 → the constraint adds cleanly).
-- GLOBAL, additive.
-- ============================================================================

-- Bound the retrieval-score authority lever before anything can nudge it.
ALTER TABLE knowledge_docs
  ADD CONSTRAINT knowledge_docs_authority_range CHECK (authority BETWEEN 0 AND 100);

CREATE TABLE IF NOT EXISTS knowledge_conflict_probe_queue (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chunk_id     uuid NOT NULL REFERENCES knowledge_doc_chunks(id) ON DELETE CASCADE,
  doc_id       uuid NOT NULL,
  content_hash text,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  probed_at    timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, chunk_id)
);
-- Drain reads the pending head: WHERE probed_at IS NULL ORDER BY enqueued_at.
CREATE INDEX IF NOT EXISTS kcpq_pending_idx ON knowledge_conflict_probe_queue (enqueued_at)
  WHERE probed_at IS NULL;

CREATE TABLE IF NOT EXISTS knowledge_conflicts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- chunk ids are plain uuid (not FK): chunks churn on re-ingest and the supersede
  -- path (mig 297) retires stale findings; doc ids are FK so a deleted doc's
  -- findings vanish with it.
  chunk_a_id          uuid NOT NULL,
  doc_a_id            uuid NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  chunk_b_id          uuid NOT NULL,
  doc_b_id            uuid NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  relation            text NOT NULL CHECK (relation IN ('near_duplicate', 'potential_conflict')),
  cosine_distance     real NOT NULL,
  signal              jsonb NOT NULL DEFAULT '{}',   -- what fired (numbers differ / polarity / LLM rationale)
  confidence          real,
  status              text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'resolved_pick_a', 'resolved_pick_b', 'merged', 'dismissed', 'superseded')),
  authoritative_doc_id uuid REFERENCES knowledge_docs(id) ON DELETE SET NULL,
  detected_at         timestamptz NOT NULL DEFAULT now(),
  decided_by          uuid,
  decided_at          timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Canonical (chunk_a_id < chunk_b_id) so a pair is stored once per relation.
  UNIQUE (tenant_id, chunk_a_id, chunk_b_id, relation)
);
-- Review list read.
CREATE INDEX IF NOT EXISTS kc_queue_idx ON knowledge_conflicts (tenant_id, status, detected_at DESC);
-- Supersede-support: retiring findings by a re-ingested chunk id must be two index
-- probes, never a cross-tenant seq scan on the hot ingest path (adversary fix).
CREATE INDEX IF NOT EXISTS kc_chunk_a_idx ON knowledge_conflicts (tenant_id, chunk_a_id);
CREATE INDEX IF NOT EXISTS kc_chunk_b_idx ON knowledge_conflicts (tenant_id, chunk_b_id);

DROP TRIGGER IF EXISTS trg_knowledge_conflicts_updated_at ON knowledge_conflicts;
CREATE TRIGGER trg_knowledge_conflicts_updated_at BEFORE UPDATE ON knowledge_conflicts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: tenant members can READ their findings; all writes go through the mig-296
-- SECURITY DEFINER RPCs (no insert/update/delete policy exists on purpose).
ALTER TABLE knowledge_conflict_probe_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_conflicts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kcpq_select ON knowledge_conflict_probe_queue;
CREATE POLICY kcpq_select ON knowledge_conflict_probe_queue FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS kc_select ON knowledge_conflicts;
CREATE POLICY kc_select ON knowledge_conflicts FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM profiles WHERE user_id = auth.uid()));

NOTIFY pgrst, 'reload schema';
