-- 356_knowledge_access_write_api.sql
-- ============================================================================
-- The write path for knowledge permissions, and the "who can see this, and why"
-- answer the spec asks for.
--
-- Mig 343 created knowledge_access_grants and knowledge_principal_groups with
-- SELECT policies only, deliberately: "granting yourself workspace_admin must
-- not be a PostgREST call away". It then never built the RPCs, so today the ACL
-- is real, enforced, and completely unmanageable from the product. This closes
-- that.
--
-- ── The three ways a permissions API gets this wrong ───────────────────────
--
-- 1. PRIVILEGE ESCALATION. If "may manage permissions" is one boolean, a
--    knowledge_manager can grant somebody workspace_admin and then be granted it
--    back. Nobody has to be malicious for this to matter — it means the ladder
--    is decorative. Here you may never grant, or revoke, ABOVE YOUR OWN LEVEL.
--
-- 2. LOCKOUT. Permissions UIs let people revoke the last administrator and then
--    nobody can fix it without a support ticket into the database. The last
--    workspace_admin grant in a workspace cannot be revoked.
--
-- 3. CROSS-TENANT PRINCIPALS. Granting access to a user id from another
--    workspace is the quietest possible data leak: it looks like a normal row.
--    Every principal is verified to be a member of the caller's workspace, and
--    every resource is verified to belong to it too.
--
-- ── "Effective access" is the actual feature ───────────────────────────────
-- The spec asks for a preview "showing exactly who can access a resource and
-- why". The WHY is the part that matters. A grid of checkboxes tells you what
-- you set; it does not tell you that Priya can read the HR space because she is
-- in a group somebody added her to in March. preview_space_access() answers for
-- every real person: what level, and which grant produced it.
-- ============================================================================

-- ── 1. What level does a user hold on a SPACE (not a document)? ────────────
-- knowledge_effective_level_for answers for documents. Permissions are
-- administered on Spaces, so the same rules are needed one level up. Returns
-- the level AND the reason, because the reason is what makes a permissions
-- screen honest.
CREATE OR REPLACE FUNCTION public.knowledge_space_level_for(p_user uuid, p_space_id uuid)
RETURNS TABLE (level int, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_tenant uuid; v_restricted boolean; v_space knowledge_collections;
  v_best int := 0; v_why text := NULL; r record;
BEGIN
  SELECT * INTO v_space FROM knowledge_collections WHERE id = p_space_id;
  IF v_space.id IS NULL OR p_user IS NULL THEN RETURN; END IF;

  IF EXISTS (SELECT 1 FROM profiles pr WHERE pr.user_id = p_user
              AND pr.layer = 'platform' AND coalesce(pr.is_active, true)) THEN
    RETURN QUERY SELECT 6, 'DreamTeam platform administrator'; RETURN;
  END IF;

  SELECT pr.tenant_id INTO v_tenant FROM profiles pr
   WHERE pr.user_id = p_user AND coalesce(pr.is_active, true) LIMIT 1;
  IF v_tenant IS NULL OR v_tenant <> v_space.tenant_id THEN RETURN; END IF;

  v_restricted := coalesce(v_space.is_restricted, false);

  FOR r IN
    SELECT g.*, knowledge_permission_rank(g.permission) AS rk
      FROM knowledge_access_grants g
     WHERE g.tenant_id = v_tenant
       AND knowledge_grant_matches_user(g, p_user)
       -- A workspace-wide grant does not reach into a locked room.
       AND ((g.resource_type = 'workspace' AND NOT v_restricted)
         OR (g.resource_type = 'collection' AND g.resource_id = p_space_id))
     ORDER BY knowledge_permission_rank(g.permission) DESC
  LOOP
    IF r.rk > v_best THEN
      v_best := r.rk;
      v_why := CASE r.principal_type
        WHEN 'everyone' THEN 'everyone in this workspace'
        WHEN 'role'     THEN 'their role (' || r.principal_role || ')'
        WHEN 'group'    THEN 'the group "' || coalesce((SELECT name FROM knowledge_principal_groups WHERE id = r.principal_group_id), '?') || '"'
        WHEN 'guest'    THEN 'a guest invitation'
        ELSE 'granted to them directly' END
        || CASE WHEN r.resource_type = 'collection' THEN ' on this space' ELSE '' END;
    END IF;
  END LOOP;

  IF v_best = 0 THEN RETURN; END IF;
  RETURN QUERY SELECT v_best, v_why;
END $fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_space_level_for(uuid, uuid) TO authenticated;

-- ── 2. The caller's own administrative level ───────────────────────────────
CREATE OR REPLACE FUNCTION public.knowledge_my_admin_level(p_space_id uuid DEFAULT NULL)
RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_lvl int := 0;
BEGIN
  IF v_tenant IS NULL THEN RETURN 0; END IF;
  IF is_platform_admin() THEN RETURN 6; END IF;

  IF p_space_id IS NOT NULL THEN
    SELECT level INTO v_lvl FROM public.knowledge_space_level_for(auth.uid(), p_space_id);
    RETURN coalesce(v_lvl, 0);
  END IF;

  SELECT coalesce(max(knowledge_permission_rank(g.permission)), 0) INTO v_lvl
    FROM knowledge_access_grants g
   WHERE g.tenant_id = v_tenant AND g.resource_type = 'workspace'
     AND knowledge_grant_matches_caller(g);
  RETURN v_lvl;
END $fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_my_admin_level(uuid) TO authenticated;

-- ── 3. Grant ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.grant_knowledge_access(
  p_resource_type text,          -- 'workspace' | 'collection' | 'document'
  p_resource_id uuid,            -- NULL for workspace
  p_principal_type text,         -- 'everyone' | 'role' | 'group' | 'user' | 'guest'
  p_principal_id uuid,           -- user id or group id; NULL otherwise
  p_principal_role text,         -- role name; NULL otherwise
  p_permission text,
  p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_my int; v_want int; v_id uuid; v_space uuid; v_who text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_resource_type NOT IN ('workspace','collection','document') THEN
    RAISE EXCEPTION 'unknown resource type: %', p_resource_type;
  END IF;
  IF p_principal_type NOT IN ('everyone','role','group','user','guest') THEN
    RAISE EXCEPTION 'unknown principal type: %', p_principal_type;
  END IF;
  v_want := knowledge_permission_rank(p_permission);
  IF v_want = 0 THEN RAISE EXCEPTION 'unknown permission: %', p_permission; END IF;

  -- The resource must belong to this workspace.
  IF p_resource_type = 'collection' THEN
    IF NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE id = p_resource_id AND tenant_id = v_tenant) THEN
      RAISE EXCEPTION 'that space does not belong to this workspace';
    END IF;
    v_space := p_resource_id;
  ELSIF p_resource_type = 'document' THEN
    IF NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE id = p_resource_id AND tenant_id = v_tenant) THEN
      RAISE EXCEPTION 'that document does not belong to this workspace';
    END IF;
  ELSIF p_resource_id IS NOT NULL THEN
    RAISE EXCEPTION 'a workspace-wide grant does not take a resource';
  END IF;

  -- Managing permissions is a knowledge_manager act (rank 5).
  v_my := public.knowledge_my_admin_level(v_space);
  IF v_my < 5 THEN
    RAISE EXCEPTION 'insufficient_permission: changing who can see knowledge requires knowledge manager';
  END IF;
  -- ...and you cannot hand out more than you hold. Without this the ladder is
  -- decorative: a knowledge manager grants somebody workspace_admin, and is
  -- granted it back the same afternoon.
  IF v_want > v_my THEN
    RAISE EXCEPTION 'insufficient_permission: you cannot grant % because you only hold level %', p_permission, v_my;
  END IF;

  -- The principal must be real, and in THIS workspace.
  IF p_principal_type IN ('user','guest') THEN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = p_principal_id AND tenant_id = v_tenant
                     AND coalesce(is_active, true)) THEN
      RAISE EXCEPTION 'that person is not a member of this workspace';
    END IF;
    SELECT coalesce(full_name, 'a teammate') INTO v_who FROM profiles WHERE user_id = p_principal_id;
  ELSIF p_principal_type = 'group' THEN
    IF NOT EXISTS (SELECT 1 FROM knowledge_principal_groups WHERE id = p_principal_id AND tenant_id = v_tenant) THEN
      RAISE EXCEPTION 'that group does not belong to this workspace';
    END IF;
    SELECT name INTO v_who FROM knowledge_principal_groups WHERE id = p_principal_id;
  ELSIF p_principal_type = 'role' THEN
    IF p_principal_role IS NULL OR btrim(p_principal_role) = '' THEN
      RAISE EXCEPTION 'a role grant needs a role name';
    END IF;
    v_who := 'everyone with the role ' || p_principal_role;
  ELSE
    v_who := 'everyone in the workspace';
  END IF;

  INSERT INTO knowledge_access_grants (
    tenant_id, resource_type, resource_id, principal_type,
    principal_user_id, principal_group_id, principal_role, permission, granted_by, note)
  VALUES (
    v_tenant, p_resource_type, p_resource_id, p_principal_type,
    CASE WHEN p_principal_type IN ('user','guest') THEN p_principal_id END,
    CASE WHEN p_principal_type = 'group' THEN p_principal_id END,
    CASE WHEN p_principal_type = 'role' THEN p_principal_role END,
    p_permission, auth.uid(), p_note)
  ON CONFLICT (tenant_id, resource_type, coalesce(resource_id, '00000000-0000-0000-0000-000000000000'::uuid),
               principal_type,
               coalesce(principal_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(principal_role, ''))
  DO UPDATE SET permission = excluded.permission, granted_by = excluded.granted_by,
                note = excluded.note, updated_at = now()
  RETURNING id INTO v_id;

  PERFORM append_audit_event(
    v_tenant, 'Knowledge', 'human',
    format('Gave %s %s access', v_who, p_permission),
    'access_control',
    jsonb_build_object('grant_id', v_id, 'resource_type', p_resource_type,
                       'resource_id', p_resource_id, 'permission', p_permission,
                       'principal_type', p_principal_type));
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.grant_knowledge_access(text, uuid, text, uuid, text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.grant_knowledge_access(text, uuid, text, uuid, text, text, text) TO authenticated;

-- ── 4. Revoke ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_knowledge_access(p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_g knowledge_access_grants; v_my int; v_space uuid; v_admins int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO v_g FROM knowledge_access_grants WHERE id = p_grant_id AND tenant_id = v_tenant;
  IF v_g.id IS NULL THEN RAISE EXCEPTION 'grant_not_found'; END IF;

  v_space := CASE WHEN v_g.resource_type = 'collection' THEN v_g.resource_id END;
  v_my := public.knowledge_my_admin_level(v_space);
  IF v_my < 5 THEN
    RAISE EXCEPTION 'insufficient_permission: changing who can see knowledge requires knowledge manager';
  END IF;
  -- Symmetric with granting: you cannot remove an access level you could not
  -- have handed out. Otherwise a knowledge manager can demote an owner.
  IF knowledge_permission_rank(v_g.permission) > v_my THEN
    RAISE EXCEPTION 'insufficient_permission: that grant is above your level';
  END IF;

  -- Never leave a workspace with nobody who can administer it.
  IF v_g.permission = 'workspace_admin' THEN
    SELECT count(*) INTO v_admins FROM knowledge_access_grants
     WHERE tenant_id = v_tenant AND permission = 'workspace_admin' AND id <> p_grant_id;
    IF v_admins = 0 THEN
      RAISE EXCEPTION 'that is the last full-access grant in this workspace — add another before removing it';
    END IF;
  END IF;

  DELETE FROM knowledge_access_grants WHERE id = p_grant_id;

  PERFORM append_audit_event(
    v_tenant, 'Knowledge', 'human',
    format('Removed %s access', v_g.permission),
    'access_control',
    jsonb_build_object('grant_id', p_grant_id, 'resource_type', v_g.resource_type,
                       'resource_id', v_g.resource_id, 'permission', v_g.permission,
                       'principal_type', v_g.principal_type));
  RETURN jsonb_build_object('ok', true);
END $fn$;
REVOKE ALL ON FUNCTION public.revoke_knowledge_access(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.revoke_knowledge_access(uuid) TO authenticated;

-- ── 5. Lock / unlock a Space ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_space_restricted(p_space_id uuid, p_restricted boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_my int; v_name text; v_reachable int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT name INTO v_name FROM knowledge_collections
   WHERE id = p_space_id AND tenant_id = v_tenant AND is_space;
  IF v_name IS NULL THEN RAISE EXCEPTION 'space_not_found'; END IF;

  v_my := public.knowledge_my_admin_level(p_space_id);
  IF v_my < 5 THEN
    RAISE EXCEPTION 'insufficient_permission: locking a space requires knowledge manager';
  END IF;

  UPDATE knowledge_collections SET is_restricted = p_restricted, updated_at = now()
   WHERE id = p_space_id;

  -- Locking a space with no explicit grants makes it reachable by nobody but
  -- platform staff. That is a legitimate thing to want, and a terrible thing to
  -- do BY ACCIDENT, so it is reported rather than silently done.
  v_reachable := 0;
  IF p_restricted THEN
    SELECT count(*) INTO v_reachable FROM knowledge_access_grants
     WHERE tenant_id = v_tenant AND resource_type = 'collection' AND resource_id = p_space_id;
  END IF;

  PERFORM append_audit_event(
    v_tenant, 'Knowledge', 'human',
    format('%s the space "%s"', CASE WHEN p_restricted THEN 'Restricted' ELSE 'Opened' END, v_name),
    'access_control',
    jsonb_build_object('space_id', p_space_id, 'restricted', p_restricted));

  RETURN jsonb_build_object('ok', true, 'restricted', p_restricted, 'explicit_grants', v_reachable);
END $fn$;
REVOKE ALL ON FUNCTION public.set_space_restricted(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_space_restricted(uuid, boolean) TO authenticated;

-- ── 6. Reads for the screen ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_knowledge_spaces_admin()
RETURNS TABLE (id uuid, name text, description text, is_restricted boolean,
               doc_count bigint, grant_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT c.id, c.name, c.description, c.is_restricted,
         (SELECT count(*) FROM knowledge_doc_access_paths p WHERE p.collection_id = c.id),
         (SELECT count(*) FROM knowledge_access_grants g
           WHERE g.resource_type = 'collection' AND g.resource_id = c.id)
    FROM knowledge_collections c
   WHERE c.tenant_id = auth_tenant_id() AND c.is_space AND c.archived_at IS NULL
   ORDER BY c.name;
$fn$;
REVOKE ALL ON FUNCTION public.list_knowledge_spaces_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_knowledge_spaces_admin() TO authenticated;

-- Grants ON a resource, with the principal resolved to a human-readable name.
CREATE OR REPLACE FUNCTION public.list_resource_access(p_resource_type text, p_resource_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, principal_type text, principal_label text, permission text,
               scope text, note text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT g.id, g.principal_type,
         CASE g.principal_type
           WHEN 'everyone' THEN 'Everyone in this workspace'
           WHEN 'role'     THEN 'Role: ' || g.principal_role
           WHEN 'group'    THEN coalesce((SELECT name FROM knowledge_principal_groups WHERE id = g.principal_group_id), 'a group')
           ELSE coalesce((SELECT full_name FROM profiles WHERE user_id = g.principal_user_id), 'a teammate')
         END,
         g.permission,
         CASE g.resource_type WHEN 'workspace' THEN 'Whole workspace' ELSE 'This space' END,
         g.note, g.created_at
    FROM knowledge_access_grants g
   WHERE g.tenant_id = auth_tenant_id()
     AND (g.resource_type = 'workspace'
          OR (g.resource_type = p_resource_type AND g.resource_id = p_resource_id))
   ORDER BY knowledge_permission_rank(g.permission) DESC, g.created_at;
$fn$;
REVOKE ALL ON FUNCTION public.list_resource_access(text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_resource_access(text, uuid) TO authenticated;

-- THE feature: who can actually reach this space, and why.
CREATE OR REPLACE FUNCTION public.preview_space_access(p_space_id uuid)
RETURNS TABLE (user_id uuid, full_name text, role text, level int, level_name text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT pr.user_id,
         coalesce(pr.full_name, 'Unnamed teammate'),
         pr.role,
         coalesce(l.level, 0),
         CASE coalesce(l.level, 0)
           WHEN 6 THEN 'Full access' WHEN 5 THEN 'Knowledge manager' WHEN 4 THEN 'Publisher'
           WHEN 3 THEN 'Editor'      WHEN 2 THEN 'Contributor'       WHEN 1 THEN 'Viewer'
           ELSE 'No access' END,
         coalesce(l.reason, 'nothing grants them access')
    FROM profiles pr
    LEFT JOIN LATERAL public.knowledge_space_level_for(pr.user_id, p_space_id) l ON true
   WHERE pr.tenant_id = auth_tenant_id()
     AND coalesce(pr.is_active, true)
     AND pr.layer IS DISTINCT FROM 'platform'
   ORDER BY coalesce(l.level, 0) DESC, pr.full_name;
$fn$;
REVOKE ALL ON FUNCTION public.preview_space_access(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.preview_space_access(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_workspace_people()
RETURNS TABLE (user_id uuid, full_name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT pr.user_id, coalesce(pr.full_name, 'Unnamed teammate'), pr.role
    FROM profiles pr
   WHERE pr.tenant_id = auth_tenant_id() AND coalesce(pr.is_active, true)
     AND pr.layer IS DISTINCT FROM 'platform'
   ORDER BY 2;
$fn$;
REVOKE ALL ON FUNCTION public.list_workspace_people() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_workspace_people() TO authenticated;

-- ── 7. Prove the guards ────────────────────────────────────────────────────
DO $assert$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='grant_knowledge_access' LIMIT 1;

  IF v_def !~ 'v_want > v_my' THEN
    RAISE EXCEPTION '356: grant has no escalation guard — a knowledge manager could grant workspace_admin';
  END IF;
  IF v_def !~ 'not a member of this workspace' THEN
    RAISE EXCEPTION '356: grant does not verify the principal is in the caller''s workspace';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='revoke_knowledge_access' LIMIT 1;
  IF v_def !~ 'last full-access grant' THEN
    RAISE EXCEPTION '356: revoke can empty a workspace of administrators';
  END IF;
  IF v_def !~ 'above your level' THEN
    RAISE EXCEPTION '356: revoke has no escalation guard — a manager could demote an owner';
  END IF;

  -- The ladder the guards compare against must still be ordered.
  IF NOT (knowledge_permission_rank('knowledge_manager') < knowledge_permission_rank('workspace_admin')) THEN
    RAISE EXCEPTION '356: the permission ladder is not ordered — every guard above is meaningless';
  END IF;

  -- The reads must be tenant-scoped, not argument-scoped.
  FOR v_def IN
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname IN
       ('list_knowledge_spaces_admin','list_resource_access','preview_space_access','list_workspace_people')
  LOOP
    IF v_def !~ 'auth_tenant_id\(\)' THEN
      RAISE EXCEPTION '356: a read function is not scoped to the caller''s workspace';
    END IF;
  END LOOP;

  RAISE NOTICE '356: escalation, lockout, cross-tenant and scoping guards all present';
END $assert$;

NOTIFY pgrst, 'reload schema';
