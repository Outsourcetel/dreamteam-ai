-- 360_close_closure_enumeration.sql
-- ============================================================================
-- Close the last hole from the mig-356 attack: the ancestry closure and the
-- filing junction were readable tenant-wide, so any member could enumerate
-- which documents sit inside a restricted Space.
--
--   knowledge_doc_access_paths_read   FOR SELECT USING (tenant_id = auth_tenant_id())
--   knowledge_doc_collections_read    FOR SELECT USING (tenant_id = auth_tenant_id())
--
-- No content leaks — these tables hold ids and depths, nothing else. What leaks
-- is the SHAPE of a locked room: that it exists, how many documents are in it,
-- and which ids they are. For an HR or legal space that is still information
-- the customer thinks they locked away, and it was the enumeration step of the
-- attack chain 359 broke the second half of.
--
-- ── Why the obvious fix does not work ──────────────────────────────────────
-- The natural policy is "you may see a path row if you may see its document":
--     USING (knowledge_effective_level(doc_id) >= 1)
-- That RECURSES. knowledge_docs_acl_select contains an EXISTS over
-- knowledge_doc_access_paths (verified live: 1 policy on knowledge_docs
-- references the closure), so reading a document consults the closure, and
-- reading the closure would consult the document. Postgres raises 42P17.
--
-- A SECURITY DEFINER wrapper technically escapes the loop, but it puts a full
-- effective-level computation inside a subquery that the knowledge_docs policy
-- runs per candidate row — reintroducing exactly the per-row cost mig 344
-- measured at 27x slower and deliberately designed out.
--
-- ── What this does instead ─────────────────────────────────────────────────
-- The secret is not "who can read this document" — it is "is this room locked,
-- and am I allowed in it". So the policy asks that, and only that:
--
--     visible unless the row's collection is a RESTRICTED Space
--     that the caller holds no grant on.
--
-- It reads knowledge_collections and knowledge_access_grants. Neither of them
-- references knowledge_doc_access_paths, so the cycle cannot form — that is a
-- structural property, not a hope, and the assertion below proves the planner
-- agrees by actually running a query under the authenticated role.
--
-- Membership of an OPEN space stays visible, which is correct: everyone can
-- read those documents anyway, so their filing was never a secret.
-- ============================================================================

-- Shared predicate, so the two policies cannot drift apart later.
CREATE OR REPLACE FUNCTION public.knowledge_collection_is_hidden_from_caller(p_collection_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  -- True when this collection is a locked room the caller has no key to.
  -- Deliberately does NOT consult knowledge_docs or the closure: that is what
  -- keeps this usable inside an RLS policy on the closure itself.
  SELECT EXISTS (
    SELECT 1 FROM knowledge_collections c
     WHERE c.id = p_collection_id
       AND c.is_space
       AND c.is_restricted
       AND NOT public.is_platform_admin()
       AND NOT EXISTS (
         SELECT 1 FROM knowledge_access_grants g
          WHERE g.tenant_id = c.tenant_id
            AND g.resource_type = 'collection'
            AND g.resource_id = c.id
            AND public.knowledge_grant_matches_caller(g)));
$fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_collection_is_hidden_from_caller(uuid) TO authenticated;

-- ── The two policies ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS knowledge_doc_access_paths_read ON knowledge_doc_access_paths;
CREATE POLICY knowledge_doc_access_paths_read ON knowledge_doc_access_paths
  FOR SELECT USING (
    tenant_id = auth_tenant_id()
    AND NOT public.knowledge_collection_is_hidden_from_caller(collection_id));

DROP POLICY IF EXISTS knowledge_doc_collections_read ON knowledge_doc_collections;
CREATE POLICY knowledge_doc_collections_read ON knowledge_doc_collections
  FOR SELECT USING (
    tenant_id = auth_tenant_id()
    AND NOT public.knowledge_collection_is_hidden_from_caller(collection_id));

-- The predicate probes grants by (tenant, resource_type, resource_id); mig 343's
-- lookup index already covers that, but the collection PK lookup is the hot one.
CREATE INDEX IF NOT EXISTS knowledge_collections_restricted_space_idx
  ON knowledge_collections (id) WHERE is_space AND is_restricted;

-- ── Prove it: no recursion, and the leak is actually closed ────────────────
DO $assert$
DECLARE
  v_t uuid; v_space uuid; v_doc uuid; v_n int; v_hidden boolean;
BEGIN
  -- 1. THE RECURSION TEST. Run real queries under the `authenticated` role so
  --    the planner builds the policy expressions for both tables. auth.uid()
  --    stays NULL — no identity is forged, and the values do not matter: a
  --    policy cycle raises 42P17 at plan time regardless of what it returns.
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM count(*) FROM knowledge_docs;
    PERFORM count(*) FROM knowledge_doc_access_paths;
    PERFORM count(*) FROM knowledge_doc_collections;
  EXCEPTION
    WHEN sqlstate '42P17' THEN
      RESET ROLE;
      RAISE EXCEPTION '360: infinite recursion between the knowledge_docs policy and the closure policy';
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE EXCEPTION '360: authenticated lost the privilege it needs to evaluate the knowledge_docs policy';
  END;
  RESET ROLE;

  -- 2. The predicate must actually hide a locked room, and only a locked room.
  SELECT id INTO v_t FROM tenants ORDER BY created_at LIMIT 1;
  SELECT id INTO v_space FROM knowledge_collections WHERE tenant_id=v_t AND is_space LIMIT 1;

  SELECT public.knowledge_collection_is_hidden_from_caller(v_space) INTO v_hidden;
  IF v_hidden THEN
    RAISE EXCEPTION '360: an OPEN space is being hidden — filing of readable documents would disappear';
  END IF;

  UPDATE knowledge_collections SET is_restricted = true WHERE id = v_space;
  SELECT public.knowledge_collection_is_hidden_from_caller(v_space) INTO v_hidden;
  UPDATE knowledge_collections SET is_restricted = false WHERE id = v_space;
  -- is_platform_admin() is false for this runner (auth.uid() NULL), so a
  -- restricted space with no grant must come back hidden.
  IF NOT v_hidden THEN
    RAISE EXCEPTION '360: a restricted space is still enumerable';
  END IF;

  -- 3. The policies must both use the shared predicate, or they drift.
  SELECT count(*) INTO v_n FROM pg_policy
   WHERE polrelid IN ('public.knowledge_doc_access_paths'::regclass,
                      'public.knowledge_doc_collections'::regclass)
     AND pg_get_expr(polqual, polrelid) LIKE '%knowledge_collection_is_hidden_from_caller%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '360: expected both closure tables scoped by the shared predicate, found %', v_n;
  END IF;

  -- 4. Neither table may have gained a write policy along the way.
  SELECT count(*) INTO v_n FROM pg_policy
   WHERE polrelid IN ('public.knowledge_doc_access_paths'::regclass,
                      'public.knowledge_doc_collections'::regclass)
     AND polcmd <> 'r';
  IF v_n > 0 THEN RAISE EXCEPTION '360: a write policy appeared on a closure table'; END IF;

  RAISE NOTICE '360: closure enumeration closed, no policy recursion, open spaces unaffected';
END $assert$;

NOTIFY pgrst, 'reload schema';
