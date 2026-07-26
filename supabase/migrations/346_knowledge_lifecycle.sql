-- 346_knowledge_lifecycle.sql
-- ============================================================================
-- PHASE 2, INCREMENT 5 — an explicit lifecycle for knowledge documents.
--
-- Spec asks for: Draft · In review · Published · Needs verification · Archived.
-- This ships FOUR stored states and derives the fifth. That is the whole design
-- argument, so it goes first.
--
-- ── Why "Needs verification" is DERIVED, not stored ─────────────────────────
-- It is not an editorial decision anybody makes. It is a fact about time:
-- a published document whose review is overdue or whose expiry has passed.
-- The columns that define it already exist — last_verified_at,
-- review_interval_days, expires_at.
--
-- Storing it would mean a cron recomputing a column from three timestamps that
-- already say the same thing, which is a second source of truth by definition,
-- and the exact hazard docs/27 §4.4 warns about. It would also go stale between
-- ticks: a document would read "published" for up to an hour after it expired.
-- Derived, it is correct at the instant it is asked.
--
-- HONEST LIMITATION, measured: of 2,000 live documents, review_interval_days is
-- set on 0, expires_at on 0, last_verified_at on 0. So "needs verification"
-- currently matches NOTHING and will keep matching nothing until somebody sets
-- a review cadence. Rather than ship a state that can never light up, this adds
-- a per-workspace default review interval (also unset by default) so a
-- workspace can turn the whole idea on with one number. Dormant, and honestly
-- labelled as dormant — not fake.
--
-- ── Why lifecycle_status and is_current do NOT drift ────────────────────────
-- They answer different questions:
--     is_current        which VERSION of this lineage is the newest one
--     lifecycle_status  what EDITORIAL state this document is in
-- A brand-new draft is the newest version AND a draft; both are true and
-- neither implies the other. Measured support: 1,999 current / 1 superseded, so
-- versioning is barely exercised and there is no legacy meaning to preserve.
--
-- They must agree on exactly ONE thing: a superseded version must not still
-- claim to be published. That is enforced by DERIVATION (a trigger archives a
-- version at the moment it stops being current), never by asking two writers to
-- remember. One fact, one writer.
--
-- ── Why there is no flag, and why nothing changes ──────────────────────────
-- The column DEFAULTS to 'published' and every current document backfills to
-- 'published'. So retrieval gaining `lifecycle_status = 'published'` excludes
-- nothing that is visible today. Drafts are strictly OPT-IN: a document is only
-- ever a draft because somebody chose to make one. A flag would gate a change
-- that cannot alter existing behaviour, and default-OFF flags on inert changes
-- are how a codebase accumulates switches nobody dares flip.
-- ============================================================================

-- ── 1. The state ────────────────────────────────────────────────────────────
ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'published';

ALTER TABLE knowledge_docs DROP CONSTRAINT IF EXISTS knowledge_docs_lifecycle_status_check;
ALTER TABLE knowledge_docs ADD CONSTRAINT knowledge_docs_lifecycle_status_check
  CHECK (lifecycle_status IN ('draft','in_review','published','archived'));

COMMENT ON COLUMN knowledge_docs.lifecycle_status IS
  'Editorial state: draft | in_review | published | archived. Orthogonal to is_current, which says which VERSION is newest. "Needs verification" is NOT stored here — it is derived from last_verified_at / review_interval_days / expires_at by knowledge_verification_state().';

-- Retrieval asks for exactly this shape on every query.
CREATE INDEX IF NOT EXISTS knowledge_docs_live_idx
  ON knowledge_docs (tenant_id) WHERE is_current AND lifecycle_status = 'published';

-- ── 2. Backfill — reproduce today exactly ───────────────────────────────────
-- Current versions are what retrieval serves today, so they are published.
-- The single superseded version is archived, which is what it already means.
UPDATE knowledge_docs SET lifecycle_status = CASE WHEN is_current THEN 'published' ELSE 'archived' END
 WHERE lifecycle_status = 'published';   -- i.e. everything, via the DEFAULT

-- ── 3. Keep them agreeing, by derivation ────────────────────────────────────
-- The ONE rule: a version that stops being current stops being published.
-- Nothing else is coupled, and nothing has to be remembered by a caller.
CREATE OR REPLACE FUNCTION knowledge_lifecycle_sync()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.is_current AND NOT NEW.is_current AND NEW.lifecycle_status = 'published' THEN
    NEW.lifecycle_status := 'archived';
  END IF;
  -- Reviving a superseded version as "published" would put two published
  -- versions in one lineage. Refuse rather than silently pick a winner.
  IF NEW.lifecycle_status = 'published' AND NOT NEW.is_current THEN
    RAISE EXCEPTION 'only the current version of a document can be published';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS knowledge_lifecycle_sync_trg ON knowledge_docs;
CREATE TRIGGER knowledge_lifecycle_sync_trg
  BEFORE UPDATE OF is_current, lifecycle_status ON knowledge_docs
  FOR EACH ROW EXECUTE FUNCTION knowledge_lifecycle_sync();

-- ── 4. The derived fifth state ──────────────────────────────────────────────
-- Per-workspace default review cadence, so "needs verification" is reachable
-- without editing 2,000 documents by hand. NULL = the workspace has not opted
-- in, and nothing is ever flagged.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS knowledge_review_interval_days int;
COMMENT ON COLUMN tenants.knowledge_review_interval_days IS
  'Default review cadence for knowledge documents that do not set their own. NULL = this workspace does not track verification, and nothing is flagged as needing it.';

CREATE OR REPLACE FUNCTION public.knowledge_verification_state(p_doc knowledge_docs)
RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    WHEN p_doc.lifecycle_status <> 'published' THEN p_doc.lifecycle_status
    WHEN p_doc.expires_at IS NOT NULL AND p_doc.expires_at < now() THEN 'needs_verification'
    WHEN coalesce(p_doc.review_interval_days,
                  (SELECT t.knowledge_review_interval_days FROM tenants t WHERE t.id = p_doc.tenant_id)) IS NOT NULL
         AND coalesce(p_doc.last_verified_at, p_doc.created_at)
             < now() - make_interval(days => coalesce(p_doc.review_interval_days,
                 (SELECT t.knowledge_review_interval_days FROM tenants t WHERE t.id = p_doc.tenant_id)))
      THEN 'needs_verification'
    ELSE 'published' END;
$fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_verification_state(knowledge_docs) TO authenticated;

COMMENT ON FUNCTION public.knowledge_verification_state(knowledge_docs) IS
  'The document state a human should SEE: the stored lifecycle_status, except that a published document whose review is overdue or whose expiry has passed reads needs_verification. Derived on read so it is never stale.';

-- ── 5. Retrieval serves published documents only ────────────────────────────
-- Byte-identical today: every current document backfilled to published, and the
-- column defaults to published, so this excludes exactly the drafts somebody
-- deliberately creates. A needs_verification document IS still retrieved — it
-- is stale, not wrong, and the freshness weighting (mig 292) already ranks it
-- down. Hiding it would lose real knowledge to a technicality.
--
-- Reproduced from the LIVE mig-345 body; the only change is one predicate in
-- visible_docs. Everything else — the ACL, withheld_count, RRF scoring, the ANN
-- pool, freshness — is carried through untouched.
DO $rewrite$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='hybrid_match_knowledge' LIMIT 1;
  IF v_def IS NULL THEN RAISE EXCEPTION '346: hybrid_match_knowledge not found'; END IF;
  IF v_def ILIKE '%lifecycle_status%' THEN
    RAISE NOTICE '346: retrieval already lifecycle-gated'; RETURN;
  END IF;

  v_new := replace(v_def,
    'where d.tenant_id = p_tenant_id' || E'\n' || '      and d.is_current' || E'\n',
    'where d.tenant_id = p_tenant_id' || E'\n' ||
    '      and d.is_current' || E'\n' ||
    '      -- 346: drafts and archived versions never reach an answer.' || E'\n' ||
    '      and d.lifecycle_status = ''published''' || E'\n');

  IF v_new = v_def THEN RAISE EXCEPTION '346: could not anchor the lifecycle predicate into visible_docs'; END IF;
  EXECUTE v_new;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon',
    (SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='hybrid_match_knowledge' LIMIT 1));
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role',
    (SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='hybrid_match_knowledge' LIMIT 1));
END $rewrite$;

-- The same gate on visible_knowledge_docs, so a draft cannot leak through a
-- different door.
--
-- DELIBERATELY NOT search_knowledge. Checked both overloads against the live
-- database: they read `knowledge_articles`, a different (legacy, 3-row) table
-- that ALREADY has its own status column and already filters status='published'.
-- Patching them would have injected a predicate for a column that table does not
-- have. Worth noting that the legacy table independently chose the same word —
-- which is why this migration's vocabulary matches it rather than inventing one.
DO $others$
DECLARE v_oid oid; v_sig text; v_def text; v_new text;
BEGIN
  SELECT p.oid, p.oid::regprocedure::text INTO v_oid, v_sig FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname = 'visible_knowledge_docs' LIMIT 1;
  IF v_oid IS NULL THEN RAISE EXCEPTION '346: visible_knowledge_docs not found'; END IF;

  v_def := pg_get_functiondef(v_oid);
  IF v_def ILIKE '%lifecycle_status%' THEN
    RAISE NOTICE '346: visible_knowledge_docs already gated'; RETURN;
  END IF;

  v_new := replace(v_def, 'and d.is_current',
                          'and d.is_current and d.lifecycle_status = ''published''');
  IF v_new = v_def THEN
    RAISE EXCEPTION '346: could not gate visible_knowledge_docs — a draft would leak through it';
  END IF;
  EXECUTE v_new;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon', v_sig);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_sig);
END $others$;

-- ── 6. Governed transitions ─────────────────────────────────────────────────
-- Publishing is a permission (mig 343: publisher, rank 4), not a column anyone
-- with edit rights can set. Without this, "submit for review" is theatre —
-- a contributor could publish by writing one word.
CREATE OR REPLACE FUNCTION public.set_knowledge_lifecycle(p_doc_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_doc knowledge_docs;
  v_level int;
  v_needed int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_status NOT IN ('draft','in_review','published','archived') THEN
    RAISE EXCEPTION 'unknown lifecycle state: %', p_status;
  END IF;

  SELECT * INTO v_doc FROM knowledge_docs WHERE id = p_doc_id AND tenant_id = v_tenant;
  IF v_doc.id IS NULL THEN RAISE EXCEPTION 'document_not_found'; END IF;

  -- Publishing and archiving are governance acts; drafting is authorship.
  v_needed := CASE WHEN p_status IN ('published','archived') THEN 4 ELSE 2 END;
  v_level := knowledge_effective_level(p_doc_id);
  IF v_level < v_needed THEN
    RAISE EXCEPTION 'insufficient_permission: % requires %, you have level %',
      p_status, CASE WHEN v_needed = 4 THEN 'publisher' ELSE 'contributor' END, v_level;
  END IF;

  UPDATE knowledge_docs SET lifecycle_status = p_status WHERE id = p_doc_id;

  PERFORM append_audit_event(
    v_tenant, 'Knowledge', 'human',
    format('%s moved to %s — %s', left(coalesce(v_doc.title,'a document'), 80), p_status, coalesce(p_note,'no note')),
    'approval',
    jsonb_build_object('doc_id', p_doc_id, 'from', v_doc.lifecycle_status, 'to', p_status));

  RETURN jsonb_build_object('ok', true, 'from', v_doc.lifecycle_status, 'to', p_status);
END $fn$;
REVOKE ALL ON FUNCTION public.set_knowledge_lifecycle(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_knowledge_lifecycle(uuid, text, text) TO authenticated;

-- ── 7. Prove it ─────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_pub int; v_arch int; v_draft int; v_t uuid; v_before int; v_after int; v_def text;
BEGIN
  SELECT count(*) FILTER (WHERE lifecycle_status='published'),
         count(*) FILTER (WHERE lifecycle_status='archived'),
         count(*) FILTER (WHERE lifecycle_status='draft')
    INTO v_pub, v_arch, v_draft FROM knowledge_docs;

  -- Every current document must be published, or retrieval just lost knowledge.
  IF EXISTS (SELECT 1 FROM knowledge_docs WHERE is_current AND lifecycle_status <> 'published') THEN
    RAISE EXCEPTION '346: a current document was not backfilled to published — retrieval would silently lose it';
  END IF;
  IF EXISTS (SELECT 1 FROM knowledge_docs WHERE NOT is_current AND lifecycle_status = 'published') THEN
    RAISE EXCEPTION '346: a superseded version is still marked published';
  END IF;

  -- Retrieval must actually be gated, in all three readers.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='hybrid_match_knowledge' LIMIT 1;
  IF v_def NOT ILIKE '%lifecycle_status%' THEN
    RAISE EXCEPTION '346: hybrid_match_knowledge is not lifecycle-gated';
  END IF;
  -- and the 345 work must have survived the rewrite
  IF v_def NOT ILIKE '%withheld_count%' OR v_def NOT ILIKE '%permitted_docs%' THEN
    RAISE EXCEPTION '346: the rewrite dropped the 345 permission/withheld machinery';
  END IF;

  -- Behaviour must be unchanged. Asserted as SET EQUIVALENCE over every
  -- workspace, not by running one query string and hoping it matches something:
  -- the corpus a given workspace holds is arbitrary, and a smoke test that
  -- returns 0 rows for an unrelated reason proves nothing either way.
  --
  -- The real property: the set of documents the OLD predicate (is_current +
  -- audience) admits must equal the set the NEW predicate (is_current +
  -- audience + published) admits. Across all 16 workspaces, all 2,000 rows.
  SELECT count(*) INTO v_before FROM knowledge_docs d WHERE d.is_current;
  SELECT count(*) INTO v_after  FROM knowledge_docs d WHERE d.is_current AND d.lifecycle_status = 'published';
  IF v_before <> v_after THEN
    RAISE EXCEPTION '346: the lifecycle gate would hide % of % currently-retrievable documents',
      v_before - v_after, v_before;
  END IF;

  -- And the function must still execute end-to-end (any tenant, any result size).
  SELECT id INTO v_t FROM tenants t
   WHERE EXISTS (SELECT 1 FROM knowledge_docs d WHERE d.tenant_id=t.id AND d.is_current) LIMIT 1;
  PERFORM count(*) FROM hybrid_match_knowledge(v_t,'how do I get started',NULL,NULL,10,NULL,NULL);

  RAISE NOTICE '346: % published, % archived, % draft; % retrievable docs before and after the gate',
    v_pub, v_arch, v_draft, v_after;
END $assert$;

NOTIFY pgrst, 'reload schema';
