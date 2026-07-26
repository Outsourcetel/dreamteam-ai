-- 334_platform_knowledge_shelf.sql
-- ============================================================================
-- THE PLATFORM KNOWLEDGE SHELF — schema + retrieval. Ships INERT and PAUSED.
--
-- Plan of record: docs/26. Design hardened by a 17-agent adversarial review
-- (31 critical/high findings). The two live cross-tenant defects that review
-- surfaced were fixed first and separately, in mig 333.
--
-- ── Why SEPARATE TABLES rather than a flag on knowledge_docs ────────────────
-- Three shapes were designed and attacked. The flag-on-the-existing-table shape
-- FAILS for reasons that are properties of this codebase, not opinions:
--
--   * knowledge_docs RLS is `with check (tenant_id = auth_tenant_id())` — it
--     constrains tenant_id and NOTHING else, so any authenticated member could
--     PATCH `visibility` to 'platform' over PostgREST.
--   * A fourth disjunct in hybrid_match_knowledge's visibility OR widens branch
--     2 (the knowledge_doc_scopes branch) by construction — that branch tests
--     neither d.visibility nor s.tenant_id.
--   * get_knowledge_coverage_demand CALLS hybrid_match_knowledge from SQL. Any
--     widening there changes what a customer is told they are MISSING.
--   * compute_de_lifecycle_readiness uses EXISTS, not count — a shelf exposed as
--     visibility='tenant' would have silently satisfied the has-knowledge and
--     has-embedded-knowledge certification gates for EVERY DE in EVERY
--     workspace, and the numbers would have looked untouched.
--
-- A "platform tenant" row was likewise rejected: it inherits every tenant→tenant
-- bug class, including the two just fixed in 333.
--
-- Separate tables leave hybrid_match_knowledge at a ZERO DIFF. That is the
-- keystone: no ranking regression to argue, and all 27 verified tenant metric
-- readers are provably untouched because they filter on a tenant_id column
-- these tables do not have.
--
-- ── Inertness ───────────────────────────────────────────────────────────────
-- Ships with paused = true and zero documents. platform_match_knowledge returns
-- immediately while paused, and returns nothing while empty. Nothing reads it
-- yet — the de-answer fan-in is a separate migration. GLOBAL.
-- ============================================================================

-- ── 334.1 Tables. No tenant_id column anywhere, by design. ──────────────────
CREATE TABLE IF NOT EXISTS platform_knowledge_docs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title               text NOT NULL,
  content             text NOT NULL DEFAULT '',
  topic               text,
  tags                text[] NOT NULL DEFAULT '{}',
  authority           int NOT NULL DEFAULT 0,
  is_current          boolean NOT NULL DEFAULT true,
  version             int NOT NULL DEFAULT 1,
  previous_version_id uuid REFERENCES platform_knowledge_docs(id),
  -- Provenance: which change taught the platform this. Feeds the
  -- self-maintaining loop (docs/26 part 3) and the "why does it know that?"
  -- answer a customer gets from the shelf.
  source_migration    text,
  source_commit       text,
  source_doc_path     text,
  last_verified_at    timestamptz,
  review_interval_days int,
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  search_tsv          tsvector GENERATED ALWAYS AS
                        (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))) STORED
);

CREATE TABLE IF NOT EXISTS platform_knowledge_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The ONLY foreign key. knowledge_doc_chunks carries independent tenant_id and
  -- doc_id FKs with nothing asserting they agree; that divergence class cannot
  -- exist here because there is no second key to diverge from.
  doc_id          uuid NOT NULL REFERENCES platform_knowledge_docs(id) ON DELETE CASCADE,
  chunk_index     int NOT NULL DEFAULT 0,
  content         text NOT NULL,
  embedding       vector(384),          -- gte-small, same as knowledge_doc_chunks
  reembed_pending boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_knowledge_docs_tsv_idx   ON platform_knowledge_docs USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS platform_knowledge_chunks_doc_idx ON platform_knowledge_chunks (doc_id);
CREATE INDEX IF NOT EXISTS platform_knowledge_chunks_hnsw_idx
  ON platform_knowledge_chunks USING hnsw (embedding vector_cosine_ops);

-- The kill switch is its OWN table, deliberately NOT platform_config:
-- platform_config_set (mig 087) writes only the Vault secret_id and never
-- `value`, which is why knowledge.freshness_weighting_paused and
-- knowledge.reembed_paused are already dead brakes. Do not add a third.
CREATE TABLE IF NOT EXISTS platform_knowledge_shelf_state (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  paused     boolean NOT NULL DEFAULT true,      -- SHIPS PAUSED
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_knowledge_shelf_state (singleton, paused) VALUES (true, true)
  ON CONFLICT (singleton) DO NOTHING;

-- Citation counting for shelf docs. record_knowledge_citations gates its writes
-- on d.tenant_id = p_tenant_id, so shelf ids passed to it match nothing and are
-- dropped WITHOUT an error — nothing would look broken. This is the parallel.
-- No tenant_id and no query text: counting usage must not become a channel.
CREATE TABLE IF NOT EXISTS platform_knowledge_usage_daily (
  doc_id      uuid NOT NULL REFERENCES platform_knowledge_docs(id) ON DELETE CASCADE,
  usage_date  date NOT NULL DEFAULT current_date,
  cited_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_id, usage_date)
);

CREATE TABLE IF NOT EXISTS platform_knowledge_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor       text,
  op          text NOT NULL,
  table_name  text NOT NULL,
  row_id      uuid,
  before      jsonb,
  after       jsonb
);

-- ── 334.2 Reachability: none. No table surface for any client role. ─────────
-- Verbatim the platform_capability_grants pattern (mig 077). Deliberately NOT a
-- USING(true) SELECT policy — that is exactly what mig 330 had to delete from
-- skill_catalog, where a broad policy silently defeated a scoped sibling.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_knowledge_docs','platform_knowledge_chunks',
                           'platform_knowledge_usage_daily','platform_knowledge_shelf_state',
                           'platform_knowledge_audit']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_deny_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (false) WITH CHECK (false)', t || '_deny_all', t);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM public, anon, authenticated', t);
  END LOOP;
END $rls$;

-- ── 334.3 Every write audited at TRIGGER level, so no writer can bypass it ──
-- append_audit_event takes tenant_id as its first argument and cannot record a
-- tenantless write, so this is its own ledger rather than a reuse.
CREATE OR REPLACE FUNCTION platform_knowledge_audit_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  INSERT INTO platform_knowledge_audit (actor, op, table_name, row_id, before, after)
  VALUES (
    coalesce(auth.uid()::text, nullif(current_setting('request.jwt.claims', true), ''), 'server'),
    TG_OP, TG_TABLE_NAME,
    coalesce((CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END), NULL),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - 'search_tsv' - 'embedding' END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) - 'search_tsv' - 'embedding' END);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $fn$;

DROP TRIGGER IF EXISTS platform_knowledge_docs_audit ON platform_knowledge_docs;
CREATE TRIGGER platform_knowledge_docs_audit
  AFTER INSERT OR UPDATE OR DELETE ON platform_knowledge_docs
  FOR EACH ROW EXECUTE FUNCTION platform_knowledge_audit_trg();

DROP TRIGGER IF EXISTS platform_knowledge_chunks_audit ON platform_knowledge_chunks;
CREATE TRIGGER platform_knowledge_chunks_audit
  AFTER INSERT OR UPDATE OR DELETE ON platform_knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION platform_knowledge_audit_trg();

-- ── 334.4 Retrieval. NO tenant parameter. NO subject parameter. ─────────────
-- There is no argument any caller could supply that names a corpus, so this
-- function cannot be turned into an arbitrary cross-tenant read. That is the
-- isolation argument in one sentence.
CREATE OR REPLACE FUNCTION public.platform_match_knowledge(
  p_query_text text,
  p_query_embedding vector DEFAULT NULL,
  p_match_count integer DEFAULT 3,
  p_max_distance double precision DEFAULT 0.25)
RETURNS TABLE (chunk_id uuid, doc_id uuid, doc_title text, content text,
               lexical_rank integer, semantic_rank integer,
               distance double precision, score double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_paused boolean;
BEGIN
  -- Defence in depth; the mig 330 idiom. The grant below is the real control.
  IF coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'anon' THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT paused INTO v_paused FROM platform_knowledge_shelf_state WHERE singleton;
  IF coalesce(v_paused, true) THEN RETURN; END IF;   -- fail CLOSED: missing row = paused

  RETURN QUERY
  WITH visible_shelf_docs AS (      -- the single choke point; BOTH branches join it
    SELECT d.id, d.title, coalesce(d.authority, 0) AS authority, d.search_tsv
      FROM platform_knowledge_docs d
     WHERE d.is_current AND d.published_at IS NOT NULL
  ),
  lexical AS (
    SELECT vd.id AS doc_id,
           (row_number() OVER (ORDER BY ts_rank(vd.search_tsv,
              websearch_to_tsquery('english', p_query_text)) DESC))::int AS lexical_rank
      FROM visible_shelf_docs vd
     WHERE p_query_text IS NOT NULL AND length(trim(p_query_text)) > 0
       AND vd.search_tsv @@ websearch_to_tsquery('english', p_query_text)
  ),
  ann AS (
    SELECT c.id AS chunk_id, c.doc_id, c.content, (c.embedding <=> p_query_embedding) AS distance
      FROM platform_knowledge_chunks c
     WHERE c.embedding IS NOT NULL AND p_query_embedding IS NOT NULL
     ORDER BY c.embedding <=> p_query_embedding
     LIMIT 200
  ),
  semantic AS (
    SELECT a.chunk_id, a.doc_id, a.content, a.distance::float AS distance,
           (row_number() OVER (ORDER BY a.distance ASC))::int AS semantic_rank
      FROM ann a JOIN visible_shelf_docs vd ON vd.id = a.doc_id
     WHERE a.distance <= p_max_distance
  ),
  candidates AS (
    SELECT s.chunk_id, s.doc_id, s.content, s.distance, s.semantic_rank FROM semantic s
    UNION
    SELECT gen_random_uuid(), vd.id,
           (SELECT d2.content FROM platform_knowledge_docs d2 WHERE d2.id = vd.id),
           NULL::float, NULL::int
      FROM visible_shelf_docs vd JOIN lexical l ON l.doc_id = vd.id
     WHERE NOT EXISTS (SELECT 1 FROM semantic s2 WHERE s2.doc_id = vd.id)
  )
  SELECT c.chunk_id, c.doc_id, vd.title, c.content, l.lexical_rank, c.semantic_rank, c.distance,
         (coalesce(1.0 / (60 + l.lexical_rank), 0.0)
          + coalesce(1.0 / (60 + c.semantic_rank), 0.0)
          + (coalesce(vd.authority, 0) * 0.002))::double precision AS score
    FROM candidates c
    JOIN visible_shelf_docs vd ON vd.id = c.doc_id
    LEFT JOIN lexical l ON l.doc_id = c.doc_id
   WHERE l.lexical_rank IS NOT NULL OR c.semantic_rank IS NOT NULL
   ORDER BY score DESC
   LIMIT p_match_count;
END $fn$;

-- ── 334.5 Citation capture for shelf docs (no tenant parameter) ─────────────
CREATE OR REPLACE FUNCTION public.record_platform_knowledge_citations(p_doc_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF p_doc_ids IS NULL OR array_length(p_doc_ids, 1) IS NULL THEN RETURN; END IF;
  INSERT INTO platform_knowledge_usage_daily (doc_id, usage_date, cited_count)
  SELECT d.id, current_date, 1
    FROM platform_knowledge_docs d
   WHERE d.id = ANY(p_doc_ids)
  ON CONFLICT (doc_id, usage_date)
  DO UPDATE SET cited_count = platform_knowledge_usage_daily.cited_count + 1;
END $fn$;

-- ── 334.6 Operator visibility, so reembed_pending is never an orphan column ─
CREATE OR REPLACE FUNCTION public.get_platform_shelf_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT jsonb_build_object(
    'paused',           (SELECT paused FROM platform_knowledge_shelf_state WHERE singleton),
    'docs_total',       (SELECT count(*) FROM platform_knowledge_docs),
    'docs_published',   (SELECT count(*) FROM platform_knowledge_docs WHERE is_current AND published_at IS NOT NULL),
    'chunks_total',     (SELECT count(*) FROM platform_knowledge_chunks),
    'chunks_embedded',  (SELECT count(*) FROM platform_knowledge_chunks WHERE embedding IS NOT NULL),
    'reembed_pending',  (SELECT count(*) FROM platform_knowledge_chunks WHERE reembed_pending),
    'citations_30d',    (SELECT coalesce(sum(cited_count), 0) FROM platform_knowledge_usage_daily
                          WHERE usage_date > current_date - 30));
$fn$;

-- Service-role only. The de-answer fan-in and the shelf UI both go through
-- edge functions; no browser role needs any of these directly.
REVOKE ALL ON FUNCTION public.platform_match_knowledge(text, vector, integer, double precision) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_platform_knowledge_citations(uuid[]) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_platform_shelf_status() FROM public, anon;

-- ── 334.7 Prove it ships inert and unreachable ──────────────────────────────
DO $assert$
DECLARE v_paused boolean; v_docs int; v_open int; v_grants int;
BEGIN
  SELECT paused INTO v_paused FROM platform_knowledge_shelf_state WHERE singleton;
  IF NOT coalesce(v_paused, false) THEN RAISE EXCEPTION '334: shelf did not ship paused'; END IF;

  SELECT count(*) INTO v_docs FROM platform_knowledge_docs;
  IF v_docs <> 0 THEN RAISE EXCEPTION '334: shelf did not ship empty'; END IF;

  -- No permissive policy may exist on any shelf table.
  SELECT count(*) INTO v_open
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname LIKE 'platform_knowledge%'
     AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') <> 'false';
  IF v_open > 0 THEN RAISE EXCEPTION '334: % non-deny policy on a shelf table', v_open; END IF;

  -- No client role may hold any table privilege.
  SELECT count(*) INTO v_grants
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name LIKE 'platform_knowledge%'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_grants > 0 THEN RAISE EXCEPTION '334: % client grant(s) on shelf tables', v_grants; END IF;

  IF has_function_privilege('authenticated', 'public.platform_match_knowledge(text, vector, integer, double precision)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.platform_match_knowledge(text, vector, integer, double precision)', 'EXECUTE')
  THEN RAISE EXCEPTION '334: platform_match_knowledge is reachable by a client role'; END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
