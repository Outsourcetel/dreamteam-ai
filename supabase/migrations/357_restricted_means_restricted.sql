-- 357_restricted_means_restricted.sql
-- ============================================================================
-- Two defects found attacking my own mig-356 permissions UI. One is a bypass;
-- the other is the product telling a customer something untrue about security,
-- which is worse.
--
-- ── A. The lock has no lock ────────────────────────────────────────────────
-- 356 put set_space_restricted() behind knowledge_manager (rank 5). Measured
-- against the live catalog: knowledge_collections still carries mig 284's
--     knowledge_collections_rw  FOR ALL  USING (tenant_id = auth_tenant_id())
-- and `authenticated` holds UPDATE on the table. So any member of the workspace
-- could simply
--     PATCH /knowledge_collections?id=eq.<space>   {"is_restricted": false}
-- and unlock a restricted space — no manager level, no audit event. The RPC was
-- a front door beside an open window, exactly like the lifecycle hole in 349.
-- Same fix as 344: the FOR ALL policy is REPLACED, not supplemented, because
-- Postgres ORs permissive policies and a sibling would have been decoration.
--
-- Creating and deleting collections moves to rank 5 too. That is not a
-- tightening I invented: the specified ladder says knowledge_manager is the
-- level that "manages spaces, collections, owners, lifecycle and permissions".
-- All 19 current users hold an admin role, so nobody loses anything today.
--
-- ── B. The UI was making a promise the system did not keep ────────────────
-- The "Restricted" preset tells the operator: "Only the people and groups you
-- name. Employees won't use it to answer anyone else."
--
-- That was FALSE. Measured: knowledge_acl_retrieval is default_enabled = false
-- with zero tenant overrides. Restricting a space stopped HUMANS reading those
-- documents (mig 344's RLS) and did nothing to retrieval, because every
-- retrieval caller is an edge function on service_role — which bypasses RLS
-- entirely. A customer could lock their HR space, be told employees would not
-- answer from it, and have a Digital Employee quote it to the next person who
-- asked. A false security claim shown in the product is the worst class of bug
-- this codebase can ship, and it was mine.
--
-- Two things make the sentence true:
--
--   1. The flag ships ON. Provably inert today: retrieval only narrows for a
--      caller with an identified acting user, every existing person holds a
--      workspace-wide grant from mig 343's backfill, and zero spaces are
--      restricted. It starts mattering the moment somebody restricts one —
--      which is precisely when they were promised it would.
--
--   2. A restricted Space is excluded when there is NO identified person.
--      Autonomous missions and the public customer widget pass no acting user,
--      so under (1) alone they would still have answered from restricted
--      material — "restricted from logged-in humans only", which is not what
--      anybody means by the word. Now: restricted material never leaves the
--      room without a named person who is allowed in it.
-- ============================================================================

-- ── A. Command-scoped policies on knowledge_collections ────────────────────
DROP POLICY IF EXISTS knowledge_collections_rw ON knowledge_collections;

CREATE POLICY knowledge_collections_select ON knowledge_collections
  FOR SELECT USING (tenant_id = auth_tenant_id());

CREATE POLICY knowledge_collections_insert ON knowledge_collections
  FOR INSERT WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (is_platform_admin() OR knowledge_my_admin_level(NULL) >= 5));

CREATE POLICY knowledge_collections_update ON knowledge_collections
  FOR UPDATE USING (
    tenant_id = auth_tenant_id()
    AND (is_platform_admin() OR knowledge_my_admin_level(NULL) >= 5))
  WITH CHECK (tenant_id = auth_tenant_id());

CREATE POLICY knowledge_collections_delete ON knowledge_collections
  FOR DELETE USING (
    tenant_id = auth_tenant_id()
    AND (is_platform_admin() OR knowledge_my_admin_level(NULL) >= 5));

-- ── B1. Restricted material does not answer an unidentified asker ─────────
-- Reproduced from the live mig-346 body; the ONLY change is the first line of
-- permitted_docs. The ACL predicate, withheld_count, RRF scoring, the ANN pool,
-- freshness and the lifecycle gate are all carried through untouched.
DO $rewrite$
DECLARE v_def text; v_new text; v_sig text;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.oid::regprocedure::text INTO v_def, v_sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='hybrid_match_knowledge' LIMIT 1;
  IF v_def IS NULL THEN RAISE EXCEPTION '357: hybrid_match_knowledge not found'; END IF;
  IF v_def ILIKE '%357:%' THEN RAISE NOTICE '357: retrieval already patched'; RETURN; END IF;

  v_new := replace(v_def,
    '    select vd.* from visible_docs vd' || E'\n' ||
    '    where (not v_acl_on)',
    '    select vd.* from visible_docs vd' || E'\n' ||
    '    where' || E'\n' ||
    '      -- 357: a restricted Space never leaves the room. With nobody named' || E'\n' ||
    '      -- (autonomous work, public widget) its documents are excluded' || E'\n' ||
    '      -- outright, so "restricted" does not quietly mean "restricted from' || E'\n' ||
    '      -- logged-in humans only".' || E'\n' ||
    '      (v_actor is not null or vd.restricted_space_id is null)' || E'\n' ||
    '      and ((not v_acl_on)');

  IF v_new = v_def THEN RAISE EXCEPTION '357: could not anchor the restricted-space rule'; END IF;
  -- close the extra paren opened above, on the branch that ends permitted_docs
  v_new := replace(v_new,
    '                               where p.doc_id = vd.id and p.collection_id = g.resource_id))))' || E'\n' ||
    '  ),',
    '                               where p.doc_id = vd.id and p.collection_id = g.resource_id)))))' || E'\n' ||
    '  ),');

  EXECUTE v_new;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon', v_sig);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_sig);
END $rewrite$;

-- ── B2. The flag ships on, so the sentence in the UI is true ──────────────
UPDATE feature_registry
   SET default_enabled = true,
       description = 'Digital Employees answer a person only from documents that person is permitted to see, and say so when material was withheld. Restricted spaces are never used to answer an unidentified asker.'
 WHERE key = 'knowledge_acl_retrieval';

-- ── Prove it ───────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_def text; v_all int; v_t uuid; v_space uuid; v_doc uuid;
  v_before uuid[]; v_after uuid[]; v_flag boolean;
BEGIN
  -- A: no FOR ALL policy may survive on knowledge_collections.
  SELECT count(*) INTO v_all FROM pg_policies
   WHERE tablename='knowledge_collections' AND cmd='ALL';
  IF v_all > 0 THEN
    RAISE EXCEPTION '357: a FOR ALL policy still exists on knowledge_collections — it OR-defeats the new ones';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename='knowledge_collections') <> 4 THEN
    RAISE EXCEPTION '357: expected 4 command-scoped policies on knowledge_collections';
  END IF;

  -- B: the flag is on and the rule is in the body.
  SELECT default_enabled INTO v_flag FROM feature_registry WHERE key='knowledge_acl_retrieval';
  IF NOT v_flag THEN RAISE EXCEPTION '357: the retrieval flag is still off — the UI claim stays false'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='hybrid_match_knowledge' LIMIT 1;
  IF v_def !~ 'v_actor is not null or vd\.restricted_space_id is null' THEN
    RAISE EXCEPTION '357: the restricted-space rule is not in retrieval';
  END IF;
  IF v_def NOT ILIKE '%withheld_count%' OR v_def NOT ILIKE '%lifecycle_status%' THEN
    RAISE EXCEPTION '357: the rewrite dropped the 345/346 machinery';
  END IF;

  -- Behaviour must be unchanged TODAY (zero restricted spaces), then change the
  -- moment a space is restricted. Both halves measured on a real tenant.
  SELECT pr.tenant_id INTO v_t FROM profiles pr
   WHERE coalesce(pr.is_active,true) AND pr.layer='tenant' AND pr.tenant_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM knowledge_docs d WHERE d.tenant_id=pr.tenant_id AND d.is_current) LIMIT 1;

  SELECT array_agg(DISTINCT doc_id) INTO v_before
    FROM hybrid_match_knowledge(v_t,'how do I get started',NULL,NULL,10,NULL,NULL);
  IF coalesce(array_length(v_before,1),0) = 0 THEN
    RAISE EXCEPTION '357: retrieval returned nothing for the anonymous path — regression';
  END IF;

  SELECT id INTO v_space FROM knowledge_collections WHERE tenant_id=v_t AND is_space LIMIT 1;
  v_doc := v_before[1];
  INSERT INTO knowledge_doc_collections (tenant_id, doc_id, collection_id) VALUES (v_t, v_doc, v_space);
  UPDATE knowledge_collections SET is_restricted = true WHERE id = v_space;

  SELECT array_agg(DISTINCT doc_id) INTO v_after
    FROM hybrid_match_knowledge(v_t,'how do I get started',NULL,NULL,10,NULL,NULL);
  IF v_doc = ANY(coalesce(v_after, ARRAY[]::uuid[])) THEN
    RAISE EXCEPTION '357: a restricted document was still served to an unidentified asker — the UI promise is still false';
  END IF;

  UPDATE knowledge_collections SET is_restricted = false WHERE id = v_space;
  DELETE FROM knowledge_doc_collections WHERE doc_id = v_doc AND collection_id = v_space;

  RAISE NOTICE '357: collections locked to knowledge managers; restricted spaces never answer an unidentified asker';
END $assert$;

NOTIFY pgrst, 'reload schema';
