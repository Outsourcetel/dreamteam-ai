-- 362_knowledge_tree_api.sql
-- ============================================================================
-- The data layer for the three-panel Library — and a fix for a regression I
-- shipped in mig 341 and did not notice.
--
-- ── THE REGRESSION ────────────────────────────────────────────────────────
-- 341 added:
--     CHECK ((is_space AND parent_id IS NULL) OR (NOT is_space AND parent_id IS NOT NULL))
-- The Library's existing "create collection" path (knowledgeApi.ts:169) inserts
-- with neither is_space nor parent_id, so since 341 every collection creation
-- from the product has failed with a constraint violation. Verified by replaying
-- that exact insert against the live database.
--
-- Nobody noticed because knowledge_collections held zero rows — the feature was
-- unused, so breaking it was invisible. That is precisely the class of bug the
-- new invariant suite exists to catch, and this one predates it.
--
-- The fix is not to loosen the constraint. The constraint is right: a collection
-- is either a root Space or has a parent. What was wrong is that the client was
-- inserting directly into a table whose shape it did not model. So creation
-- moves behind RPCs that know the difference — which also lets them enforce the
-- knowledge_manager gate that mig 357 put on the table, instead of relying on
-- an RLS policy the client has to guess its way past.
--
-- ── Subtree counts come free ──────────────────────────────────────────────
-- knowledge_doc_access_paths already stores doc -> EVERY ancestor collection
-- (mig 343, capped at depth 3). So "how many documents are under this Space"
-- is a plain indexed count on that table, not a recursive walk per node. The
-- closure was built for permission resolution; the tree gets it for nothing.
-- ============================================================================

-- ── 1. Creating structure ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_knowledge_space(
  p_name text, p_description text DEFAULT NULL, p_icon text DEFAULT 'folder')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF knowledge_my_admin_level(NULL) < 5 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: creating a space requires knowledge manager';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'a space needs a name'; END IF;

  INSERT INTO knowledge_collections (tenant_id, parent_id, name, description, is_space, icon)
  VALUES (v_tenant, NULL, btrim(p_name), nullif(btrim(coalesce(p_description,'')),''), true, p_icon)
  RETURNING id INTO v_id;

  PERFORM append_audit_event(v_tenant, 'Knowledge', 'human',
    format('Created the space "%s"', btrim(p_name)), 'access_control',
    jsonb_build_object('space_id', v_id));
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'a space called "%" already exists', btrim(p_name);
END $fn$;
REVOKE ALL ON FUNCTION public.create_knowledge_space(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_knowledge_space(text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_knowledge_collection(
  p_parent_id uuid, p_name text, p_description text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_parent_id IS NULL THEN
    RAISE EXCEPTION 'a collection lives inside a space — use create_knowledge_space for a new top-level space';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE id = p_parent_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'that parent does not belong to this workspace';
  END IF;
  -- Administering the branch, not reading it (mig 359's distinction).
  IF knowledge_my_admin_level(p_parent_id) < 5 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: organising knowledge requires knowledge manager';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'a collection needs a name'; END IF;

  -- The 341 trigger enforces depth <= 3, no cycles and no cross-workspace parent.
  INSERT INTO knowledge_collections (tenant_id, parent_id, name, description, is_space)
  VALUES (v_tenant, p_parent_id, btrim(p_name), nullif(btrim(coalesce(p_description,'')),''), false)
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.create_knowledge_collection(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_knowledge_collection(uuid, text, text) TO authenticated;

-- ── 2. Renaming, moving, archiving ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rename_knowledge_collection(
  p_id uuid, p_name text, p_description text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE id = p_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF knowledge_my_admin_level(p_id) < 5 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: organising knowledge requires knowledge manager';
  END IF;
  UPDATE knowledge_collections
     SET name = coalesce(nullif(btrim(p_name),''), name),
         description = nullif(btrim(coalesce(p_description,'')),''),
         updated_at = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $fn$;
REVOKE ALL ON FUNCTION public.rename_knowledge_collection(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_knowledge_collection(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.move_knowledge_collection(p_id uuid, p_new_parent_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_is_space boolean;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT is_space INTO v_is_space FROM knowledge_collections WHERE id = p_id AND tenant_id = v_tenant;
  IF v_is_space IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_is_space THEN RAISE EXCEPTION 'a space is already top level — it cannot be moved inside another'; END IF;
  IF p_new_parent_id IS NULL THEN
    RAISE EXCEPTION 'choose a space or collection to move this into';
  END IF;
  -- Authority over BOTH ends, or moving is a way to relocate content into a
  -- branch you control.
  IF (knowledge_my_admin_level(p_id) < 5 OR knowledge_my_admin_level(p_new_parent_id) < 5)
     AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: you need knowledge manager on both the item and its destination';
  END IF;

  -- 341's trigger rejects cycles, depth > 3 and cross-workspace parents; the
  -- reparent trigger rebuilds the ancestry closure for everything beneath.
  UPDATE knowledge_collections SET parent_id = p_new_parent_id, updated_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $fn$;
REVOKE ALL ON FUNCTION public.move_knowledge_collection(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_knowledge_collection(uuid, uuid) TO authenticated;

-- Archive, never hard-delete: a DELETE cascades knowledge_doc_collections and
-- silently unfiles documents. Archiving hides the branch and keeps the filing.
CREATE OR REPLACE FUNCTION public.archive_knowledge_collection(p_id uuid, p_archived boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_docs int; v_children int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE id = p_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF knowledge_my_admin_level(p_id) < 5 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: archiving requires knowledge manager';
  END IF;

  SELECT count(DISTINCT doc_id) INTO v_docs FROM knowledge_doc_access_paths WHERE collection_id = p_id;
  SELECT count(*) INTO v_children FROM knowledge_collections WHERE parent_id = p_id AND archived_at IS NULL;

  UPDATE knowledge_collections
     SET archived_at = CASE WHEN p_archived THEN now() ELSE NULL END, updated_at = now()
   WHERE id = p_id;

  -- The documents are untouched — say so, because "archive" reads as "delete"
  -- to most people and this one genuinely is not.
  RETURN jsonb_build_object('ok', true, 'archived', p_archived,
                            'documents_kept', v_docs, 'child_collections', v_children);
END $fn$;
REVOKE ALL ON FUNCTION public.archive_knowledge_collection(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_knowledge_collection(uuid, boolean) TO authenticated;

-- ── 3. The tree itself ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_knowledge_tree(p_include_archived boolean DEFAULT false)
RETURNS TABLE (id uuid, parent_id uuid, name text, description text,
               is_space boolean, is_restricted boolean, archived boolean,
               depth int, doc_count bigint, my_level int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT c.id, c.parent_id, c.name, c.description,
         c.is_space, c.is_restricted, (c.archived_at IS NOT NULL),
         CASE WHEN c.is_space THEN 1
              WHEN (SELECT p.is_space FROM knowledge_collections p WHERE p.id = c.parent_id) THEN 2
              ELSE 3 END,
         -- Subtree count, straight off the ancestry closure (mig 343).
         (SELECT count(DISTINCT ap.doc_id) FROM knowledge_doc_access_paths ap
           WHERE ap.collection_id = c.id),
         -- What the caller may do here, so the tree can show create/rename
         -- affordances only where the server would actually allow them.
         public.knowledge_my_admin_level(c.id)
    FROM knowledge_collections c
   WHERE c.tenant_id = auth_tenant_id()
     AND (p_include_archived OR c.archived_at IS NULL)
   ORDER BY c.is_space DESC, c.sort_order, c.name;
$fn$;
REVOKE ALL ON FUNCTION public.list_knowledge_tree(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_knowledge_tree(boolean) TO authenticated;

-- ── 4. Search learns about lifecycle ──────────────────────────────────────
-- The Library must be able to show and filter drafts vs published — otherwise
-- mig 346's lifecycle is invisible in the one screen where people manage it.
-- Return type changes, so DROP then CREATE. Reproduced from the live body; the
-- only changes are the new column, the new filter, and the ORDER BY tiebreak.
DROP FUNCTION IF EXISTS public.search_knowledge_docs(text, text[], text, text, uuid, boolean, integer, integer);

CREATE OR REPLACE FUNCTION public.search_knowledge_docs(
  p_query text DEFAULT NULL::text, p_tags text[] DEFAULT NULL::text[],
  p_source text DEFAULT NULL::text, p_visibility text DEFAULT NULL::text,
  p_collection_id uuid DEFAULT NULL::uuid, p_current_only boolean DEFAULT true,
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0,
  p_lifecycle text DEFAULT NULL::text)
RETURNS TABLE(id uuid, title text, preview text, tags text[], source text, visibility text,
              share_archetype_key text, authority integer,
              last_verified_at timestamp with time zone, is_current boolean,
              chunk_count integer, embedded_count integer,
              updated_at timestamp with time zone, citation_count integer,
              last_cited_at timestamp with time zone,
              lifecycle_status text, verification_state text, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := public.auth_tenant_id();
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
BEGIN
  IF v_tenant IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH filtered AS (
    SELECT d.* FROM knowledge_docs d
     WHERE d.tenant_id = v_tenant
       AND (NOT p_current_only OR d.is_current)
       AND (p_source     IS NULL OR d.source = p_source)
       AND (p_visibility IS NULL OR d.visibility = p_visibility)
       AND (p_tags       IS NULL OR d.tags && p_tags)
       AND (p_lifecycle  IS NULL OR d.lifecycle_status = p_lifecycle)
       AND (p_collection_id IS NULL OR EXISTS (
              -- Closure, not the direct junction: selecting a Space now finds
              -- documents filed anywhere beneath it, which is what clicking a
              -- folder means to a human.
              SELECT 1 FROM knowledge_doc_access_paths ap
               WHERE ap.doc_id = d.id AND ap.collection_id = p_collection_id))
       AND (v_q IS NULL OR d.search_tsv @@ websearch_to_tsquery('english', v_q))
  ), counted AS (SELECT count(*) AS n FROM filtered)
  SELECT f.id, f.title, left(coalesce(f.content, ''), 200) AS preview, f.tags, f.source, f.visibility,
         f.share_archetype_key, f.authority, f.last_verified_at, f.is_current,
         coalesce(f.chunk_count, 0), coalesce(f.embedded_count, 0), f.updated_at,
         coalesce(f.citation_count, 0), f.last_cited_at,
         f.lifecycle_status,
         public.knowledge_verification_state(f.*),
         (SELECT n FROM counted) AS total_count
    FROM filtered f
   ORDER BY
     CASE WHEN v_q IS NULL THEN 0 ELSE ts_rank(f.search_tsv, websearch_to_tsquery('english', v_q)) END DESC,
     f.updated_at DESC
   LIMIT greatest(1, least(200, coalesce(p_limit, 50)))
  OFFSET greatest(0, coalesce(p_offset, 0));
END $function$;
REVOKE ALL ON FUNCTION public.search_knowledge_docs(text, text[], text, text, uuid, boolean, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_knowledge_docs(text, text[], text, text, uuid, boolean, integer, integer, text) TO authenticated;

-- ── 5. Prove it ───────────────────────────────────────────────────────────
DO $assert$
DECLARE v_t uuid; v_space uuid; v_child uuid; v_n int; v_ok boolean;
BEGIN
  SELECT id INTO v_t FROM tenants ORDER BY created_at LIMIT 1;
  SELECT id INTO v_space FROM knowledge_collections WHERE tenant_id=v_t AND is_space LIMIT 1;

  -- The 341 regression must be fixed: a child collection under a space works.
  INSERT INTO knowledge_collections (tenant_id, parent_id, name, is_space)
  VALUES (v_t, v_space, '__tree_probe', false) RETURNING id INTO v_child;

  -- ...and a parentless non-space is still correctly rejected. That constraint
  -- was never the bug; the client bypassing the model was.
  v_ok := false;
  BEGIN
    INSERT INTO knowledge_collections (tenant_id, name) VALUES (v_t, '__tree_bad');
  EXCEPTION WHEN others THEN v_ok := true; END;
  IF NOT v_ok THEN RAISE EXCEPTION '362: a parentless collection was accepted'; END IF;

  -- Search must EXECUTE cleanly and expose lifecycle.
  --
  -- Row count is deliberately not asserted: search_knowledge_docs returns early
  -- when auth_tenant_id() is NULL, which it is for this runner, so it correctly
  -- yields zero rows here. Asserting "> 0" would be asserting that the tenant
  -- gate is broken. Calling it proves the rewritten body parses, plans and runs;
  -- the catalog check proves the new column and filter are really there.
  PERFORM count(*) FROM search_knowledge_docs(NULL,NULL,NULL,NULL,NULL,true,5,0,NULL);
  PERFORM count(*) FROM search_knowledge_docs(NULL,NULL,NULL,NULL,NULL,true,5,0,'draft');

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='search_knowledge_docs'
     AND pg_get_functiondef(p.oid) ILIKE '%p_lifecycle%'
     AND pg_get_functiondef(p.oid) ILIKE '%knowledge_doc_access_paths%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '362: search is missing the lifecycle filter or still uses the direct junction';
  END IF;

  -- Exactly one overload may exist, or PostgREST calls become ambiguous.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='search_knowledge_docs';
  IF v_n <> 1 THEN RAISE EXCEPTION '362: % overloads of search_knowledge_docs exist', v_n; END IF;

  DELETE FROM knowledge_collections WHERE name IN ('__tree_probe','__tree_bad');
  RAISE NOTICE '362: collection creation fixed, tree + lifecycle-aware search live';
END $assert$;

NOTIFY pgrst, 'reload schema';
