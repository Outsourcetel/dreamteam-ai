-- 359_admin_not_locked_out.sql
-- ============================================================================
-- Two defects found by adversarially attacking mig 356, both verified against
-- the live database before writing this. One would have bricked a customer's
-- space the first time they used the feature I shipped.
--
-- ── A. RESTRICTING A SPACE WAS A ONE-WAY DOOR ──────────────────────────────
-- knowledge_space_level_for deliberately stops counting workspace-wide grants
-- once a Space is restricted. That is correct for CONTENT — it is the whole
-- point of a locked room, and mig 356's tests proved it.
--
-- But 356 then used that same restricted-aware number to authorise
-- ADMINISTRATION: both set_space_restricted and grant_knowledge_access gate on
-- knowledge_my_admin_level(space). So the act of locking the room destroyed the
-- caller's authority over it. Measured across the live database: every one of
-- the 16 spaces, for every real admin in all 16 workspaces, went
--     level today = 6   ->   level after restricting = 0
-- and there is not a single collection-scoped grant anywhere to survive it.
--
-- The customer clicks "Restricted", and can then neither unlock it nor give
-- anyone access. Their documents are unreachable by every human and every
-- Digital Employee, permanently, with no path back through the product. I built
-- that, and my own test read the level-0 result as a security win without
-- asking who was supposed to hold the key.
--
-- The fix is a distinction 356 failed to make: being locked out of a room's
-- CONTENTS must not lock you out of its CONTROLS. Administration is a
-- workspace-level right; content access is not.
--
-- Note what this deliberately does NOT do: it does not let a workspace admin
-- READ a restricted space. knowledge_effective_level_for and retrieval keep the
-- restriction rule untouched, so an admin who wants in must grant themselves
-- access — which writes an access_control audit event. Full access can always
-- get in; it can never get in silently. That is the property worth keeping.
--
-- ── B. TWO UNGUARDED SECURITY DEFINER FILING RPCs ─────────────────────────
-- assign_doc_collection and unassign_doc_collection (mig 284) are SECURITY
-- DEFINER, granted to `authenticated`, and check only tenant. unassign does not
-- even verify the document exists.
--
-- That is a complete bypass of the locked room, independent of any policy:
-- un-filing a document rebuilds its ancestry closure, the closure trigger nulls
-- restricted_space_id, and mig 343's workspace-wide `everyone -> editor` grant
-- (present in all 16 workspaces) then makes the document readable and editable
-- by anyone. The mirror case is as bad: assign lets any member file ANY document
-- into a space they control.
-- ============================================================================

-- ── A. Administration is a workspace right ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.knowledge_my_admin_level(p_space_id uuid DEFAULT NULL)
RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_lvl int := 0;
BEGIN
  IF v_tenant IS NULL THEN RETURN 0; END IF;
  IF is_platform_admin() THEN RETURN 6; END IF;

  -- Workspace-scope grants count ALWAYS — including on a restricted Space.
  -- This is the fix: whoever administers the workspace keeps the keys to every
  -- room in it, or locking a room is an irreversible act.
  -- Collection-scope grants on THIS space count too, which is how a space-level
  -- knowledge manager administers just their own space.
  SELECT coalesce(max(knowledge_permission_rank(g.permission)), 0) INTO v_lvl
    FROM knowledge_access_grants g
   WHERE g.tenant_id = v_tenant
     AND knowledge_grant_matches_caller(g)
     AND (g.resource_type = 'workspace'
       OR (p_space_id IS NOT NULL AND g.resource_type = 'collection' AND g.resource_id = p_space_id));

  RETURN v_lvl;
END $fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_my_admin_level(uuid) TO authenticated;

COMMENT ON FUNCTION public.knowledge_my_admin_level(uuid) IS
  'Authority to ADMINISTER (lock/unlock a space, change grants). Deliberately ignores is_restricted, unlike knowledge_space_level_for which answers CONTENT access — otherwise restricting a space destroys the authority needed to unrestrict it. An admin still cannot READ a restricted space without granting themselves access, which is audited.';

-- ── B. The filing RPCs get authorisation ───────────────────────────────────
-- Moving a document between spaces changes who can see it, so it needs the
-- rights for both halves: you must be able to edit the document, and to
-- administer the space you are moving it into or out of.
CREATE OR REPLACE FUNCTION public.assign_doc_collection(p_doc_id uuid, p_collection_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE id = p_doc_id AND tenant_id = v_tenant)
    THEN RETURN jsonb_build_object('ok', false, 'error', 'doc_not_found'); END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE id = p_collection_id AND tenant_id = v_tenant)
    THEN RETURN jsonb_build_object('ok', false, 'error', 'collection_not_found'); END IF;

  -- 359: filing a document you cannot edit, into a space you do not administer,
  -- is how a member moves a document somewhere they CAN read it.
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    IF public.knowledge_effective_level(p_doc_id) < 3 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'insufficient_permission',
                                'detail', 'you need edit access to that document');
    END IF;
    IF public.knowledge_my_admin_level(p_collection_id) < 3 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'insufficient_permission',
                                'detail', 'you need access to the space you are filing it into');
    END IF;
  END IF;

  INSERT INTO knowledge_doc_collections (tenant_id, doc_id, collection_id)
  VALUES (v_tenant, p_doc_id, p_collection_id)
  ON CONFLICT (doc_id, collection_id) DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END $fn$;

CREATE OR REPLACE FUNCTION public.unassign_doc_collection(p_doc_id uuid, p_collection_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  -- The original did not even check the document existed.
  IF NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE id = p_doc_id AND tenant_id = v_tenant)
    THEN RETURN jsonb_build_object('ok', false, 'error', 'doc_not_found'); END IF;

  -- 359: THE BYPASS THIS CLOSES. Un-filing rebuilds the ancestry closure, which
  -- nulls restricted_space_id, which lets the workspace-wide grant reach a
  -- document that was in a locked room. Unrestricted by any policy, because
  -- this function is SECURITY DEFINER.
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    IF public.knowledge_effective_level(p_doc_id) < 3 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'insufficient_permission',
                                'detail', 'you need edit access to that document');
    END IF;
    IF public.knowledge_my_admin_level(p_collection_id) < 3 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'insufficient_permission',
                                'detail', 'you need access to the space you are removing it from');
    END IF;
  END IF;

  DELETE FROM knowledge_doc_collections
   WHERE tenant_id = v_tenant AND doc_id = p_doc_id AND collection_id = p_collection_id;
  RETURN jsonb_build_object('ok', true);
END $fn$;

REVOKE ALL ON FUNCTION public.assign_doc_collection(uuid, uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.unassign_doc_collection(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.assign_doc_collection(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unassign_doc_collection(uuid, uuid) TO authenticated;

-- ── Prove both ─────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_u uuid; v_t uuid; v_space uuid; v_admin_before int; v_admin_after int;
  v_content_after int; v_def text; r record;
BEGIN
  SELECT pr.user_id, pr.tenant_id INTO v_u, v_t FROM profiles pr
   WHERE coalesce(pr.is_active,true) AND pr.layer='tenant' AND pr.tenant_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM knowledge_collections c WHERE c.tenant_id=pr.tenant_id AND c.is_space)
   LIMIT 1;
  SELECT id INTO v_space FROM knowledge_collections WHERE tenant_id=v_t AND is_space LIMIT 1;

  -- A. The admin level must SURVIVE restriction. knowledge_my_admin_level reads
  -- auth.uid() (NULL here), so the property is asserted on the shape of the
  -- query instead of by forging an identity: workspace grants must be counted
  -- with no reference to is_restricted.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='knowledge_my_admin_level' LIMIT 1;
  IF v_def ~ 'knowledge_space_level_for' THEN
    RAISE EXCEPTION '359: admin level still derives from the restricted-aware content resolver — restricting is still a one-way door';
  END IF;
  IF v_def !~ 'resource_type = ''workspace''' THEN
    RAISE EXCEPTION '359: admin level does not count workspace-scope grants';
  END IF;

  -- Content access MUST still be shut off by restriction, or the fix traded a
  -- lockout for a leak.
  UPDATE knowledge_collections SET is_restricted = true WHERE id = v_space;
  SELECT coalesce((SELECT level FROM knowledge_space_level_for(v_u, v_space)), 0) INTO v_content_after;
  UPDATE knowledge_collections SET is_restricted = false WHERE id = v_space;
  IF v_content_after <> 0 THEN
    RAISE EXCEPTION '359: a restricted space is now readable without a grant (level %) — the lock is broken', v_content_after;
  END IF;

  -- B. Both filing RPCs must now carry a permission check.
  FOR r IN SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
             JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname IN ('assign_doc_collection','unassign_doc_collection')
  LOOP
    IF r.def !~ 'insufficient_permission' THEN
      RAISE EXCEPTION '359: % is still unguarded — a member can move documents out of a locked room', r.proname;
    END IF;
    IF r.def !~ 'knowledge_effective_level' THEN
      RAISE EXCEPTION '359: % does not check edit access to the document', r.proname;
    END IF;
  END LOOP;

  RAISE NOTICE '359: administration survives restriction, content access does not, filing is guarded';
END $assert$;

NOTIFY pgrst, 'reload schema';
