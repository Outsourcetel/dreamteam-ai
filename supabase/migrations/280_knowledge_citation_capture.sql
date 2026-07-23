-- 280_knowledge_citation_capture.sql
-- ============================================================================
-- KNOWLEDGE PHASE 1 — WS2: citation capture (the "is my knowledge working" loop).
-- Today only specialist-consult records which docs it cited; de-answer and
-- widget-ask retrieve knowledge but never record it, so Quality + analytics are
-- data-starved. This captures, at WRITE time, which docs each answer consulted —
-- as an INCREMENTAL daily rollup + a denormalized per-doc total. The adversary's
-- #1 rule (wf_0cad73f1-1e5): ship citations WITH the counter, never citations
-- alone — reads must never unnest the whole evidence_runs.steps table (mig 101 is
-- an unbounded full-scan). GLOBAL, additive.
-- ============================================================================

-- ── 1. Per-doc denormalized totals (Library / Quality read these directly) ──
ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS citation_count int NOT NULL DEFAULT 0;
ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS last_cited_at timestamptz;

-- ── 2. Daily rollup (the analytics source for P5 usage/coverage) ────────────
CREATE TABLE IF NOT EXISTS knowledge_doc_usage_daily (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doc_id      uuid NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  usage_date  date NOT NULL DEFAULT current_date,
  cited_count int  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, doc_id, usage_date)
);
CREATE INDEX IF NOT EXISTS knowledge_doc_usage_daily_tenant_date_idx
  ON knowledge_doc_usage_daily (tenant_id, usage_date DESC);

ALTER TABLE knowledge_doc_usage_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_doc_usage_daily_read ON knowledge_doc_usage_daily;
CREATE POLICY knowledge_doc_usage_daily_read ON knowledge_doc_usage_daily
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- No client write policy — writes go only through record_knowledge_citations.

-- ── 3. The write path (service-role only; edge fns call it) ─────────────────
-- One call = one consultation event: +1 per distinct doc that informed the
-- answer, both on today's rollup row and the per-doc total. Tenant-verified so a
-- stray/foreign doc_id can never increment another tenant's counts. Distinct
-- docs (knowledge_docs.id is unique) ⇒ no duplicate ON CONFLICT key in one call.
CREATE OR REPLACE FUNCTION public.record_knowledge_citations(p_tenant_id uuid, p_doc_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_doc_ids IS NULL OR array_length(p_doc_ids, 1) IS NULL THEN RETURN; END IF;

  INSERT INTO knowledge_doc_usage_daily (tenant_id, doc_id, usage_date, cited_count)
  SELECT d.tenant_id, d.id, current_date, 1
    FROM knowledge_docs d
   WHERE d.id = ANY (p_doc_ids) AND d.tenant_id = p_tenant_id
  ON CONFLICT (tenant_id, doc_id, usage_date)
  DO UPDATE SET cited_count = knowledge_doc_usage_daily.cited_count + 1;

  UPDATE knowledge_docs
     SET citation_count = coalesce(citation_count, 0) + 1, last_cited_at = now()
   WHERE id = ANY (p_doc_ids) AND tenant_id = p_tenant_id;
END $$;
REVOKE ALL ON FUNCTION public.record_knowledge_citations(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_knowledge_citations(uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';
