-- 358_principal_group_management.sql
-- ============================================================================
-- Managing human groups. Mig 343 created knowledge_principal_groups and its
-- members table with SELECT policies only and no write path — the same shape as
-- the grants themselves before 356.
--
-- ── A group is not a folder. It is a permission-bearing principal. ─────────
-- That single fact drives every guard here. Adding somebody to a group grants
-- them everything the group holds, everywhere it holds it. So group membership
-- is exactly as sensitive as a direct grant, and it is guarded the same way —
-- plus one extra rule that direct grants do not need:
--
--   YOU CANNOT ADD ANYONE TO A GROUP THAT HOLDS MORE THAN YOU DO.
--
-- Without it, group membership is a laundering route around 356's escalation
-- guard. A knowledge manager (5) cannot grant workspace_admin (6) directly —
-- 356 refuses. But if any group anywhere holds workspace_admin, they could add
-- THEMSELVES to it and have level 6 a second later. The direct door is bolted
-- and the side door is a permission primitive that looks like an address book.
--
-- ── Deleting a group silently revokes access ───────────────────────────────
-- knowledge_access_grants.principal_group_id is ON DELETE CASCADE, so removing
-- a group removes every grant made through it. That is correct behaviour and a
-- terrible surprise. delete_principal_group returns exactly how many grants it
-- destroyed and how many people lost access, so the screen can say so BEFORE
-- and confirm AFTER, rather than a row quietly vanishing from a permissions
-- table nobody re-reads.
-- ============================================================================

-- ── 1. What a group holds, and who is in it ────────────────────────────────
CREATE OR REPLACE FUNCTION public.knowledge_group_max_level(p_group_id uuid)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT coalesce(max(knowledge_permission_rank(g.permission)), 0)
    FROM knowledge_access_grants g
   WHERE g.principal_type = 'group' AND g.principal_group_id = p_group_id;
$fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_group_max_level(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_principal_groups()
RETURNS TABLE (id uuid, name text, description text, member_count bigint,
               grant_count bigint, max_level int, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT g.id, g.name, g.description,
         (SELECT count(*) FROM knowledge_principal_group_members m WHERE m.group_id = g.id),
         (SELECT count(*) FROM knowledge_access_grants a
           WHERE a.principal_type = 'group' AND a.principal_group_id = g.id),
         public.knowledge_group_max_level(g.id),
         g.created_at
    FROM knowledge_principal_groups g
   WHERE g.tenant_id = auth_tenant_id()
   ORDER BY g.name;
$fn$;
REVOKE ALL ON FUNCTION public.list_principal_groups() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_principal_groups() TO authenticated;

CREATE OR REPLACE FUNCTION public.list_group_members(p_group_id uuid)
RETURNS TABLE (user_id uuid, full_name text, role text, added_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT m.user_id, coalesce(pr.full_name, 'Unnamed teammate'), pr.role, m.created_at
    FROM knowledge_principal_group_members m
    JOIN knowledge_principal_groups g ON g.id = m.group_id
    LEFT JOIN profiles pr ON pr.user_id = m.user_id AND pr.tenant_id = g.tenant_id
   WHERE m.group_id = p_group_id
     AND g.tenant_id = auth_tenant_id()      -- gate on the GROUP, not the argument
   ORDER BY 2;
$fn$;
REVOKE ALL ON FUNCTION public.list_group_members(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_group_members(uuid) TO authenticated;

-- ── 2. Create / rename ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_principal_group(p_name text, p_description text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF public.knowledge_my_admin_level(NULL) < 5 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: managing groups requires knowledge manager';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'a group needs a name'; END IF;

  INSERT INTO knowledge_principal_groups (tenant_id, name, description, created_by)
  VALUES (v_tenant, btrim(p_name), nullif(btrim(coalesce(p_description,'')), ''), auth.uid())
  RETURNING id INTO v_id;

  PERFORM append_audit_event(v_tenant, 'Knowledge', 'human',
    format('Created the group "%s"', btrim(p_name)), 'access_control',
    jsonb_build_object('group_id', v_id));
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'a group called "%" already exists', btrim(p_name);
END $fn$;
REVOKE ALL ON FUNCTION public.create_principal_group(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_principal_group(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.rename_principal_group(p_group_id uuid, p_name text, p_description text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF public.knowledge_my_admin_level(NULL) < 5 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: managing groups requires knowledge manager';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_principal_groups WHERE id = p_group_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'group_not_found';
  END IF;

  UPDATE knowledge_principal_groups
     SET name = coalesce(nullif(btrim(p_name), ''), name),
         description = nullif(btrim(coalesce(p_description,'')), ''),
         updated_at = now()
   WHERE id = p_group_id;
  RETURN jsonb_build_object('ok', true);
END $fn$;
REVOKE ALL ON FUNCTION public.rename_principal_group(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rename_principal_group(uuid, text, text) TO authenticated;

-- ── 3. Delete — and say what it costs ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_principal_group(p_group_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_name text; v_grants int; v_members int; v_my int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT name INTO v_name FROM knowledge_principal_groups WHERE id = p_group_id AND tenant_id = v_tenant;
  IF v_name IS NULL THEN RAISE EXCEPTION 'group_not_found'; END IF;

  v_my := public.knowledge_my_admin_level(NULL);
  IF v_my < 5 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: managing groups requires knowledge manager';
  END IF;
  -- Symmetric with 356's revoke guard: deleting a group revokes its grants, so
  -- you may not delete one holding more access than you could have removed.
  IF public.knowledge_group_max_level(p_group_id) > v_my AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: that group holds access above your level';
  END IF;

  SELECT count(*) INTO v_grants FROM knowledge_access_grants
   WHERE principal_type = 'group' AND principal_group_id = p_group_id;
  SELECT count(*) INTO v_members FROM knowledge_principal_group_members WHERE group_id = p_group_id;

  DELETE FROM knowledge_principal_groups WHERE id = p_group_id;   -- cascades the grants

  PERFORM append_audit_event(v_tenant, 'Knowledge', 'human',
    format('Deleted the group "%s" — %s grant(s) removed, %s member(s) affected', v_name, v_grants, v_members),
    'access_control',
    jsonb_build_object('group_id', p_group_id, 'grants_removed', v_grants, 'members', v_members));

  RETURN jsonb_build_object('ok', true, 'grants_removed', v_grants, 'members_affected', v_members);
END $fn$;
REVOKE ALL ON FUNCTION public.delete_principal_group(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_principal_group(uuid) TO authenticated;

-- ── 4. Membership — the escalation-sensitive part ─────────────────────────
CREATE OR REPLACE FUNCTION public.add_group_member(p_group_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_my int; v_group int; v_name text; v_who text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT name INTO v_name FROM knowledge_principal_groups WHERE id = p_group_id AND tenant_id = v_tenant;
  IF v_name IS NULL THEN RAISE EXCEPTION 'group_not_found'; END IF;

  v_my := public.knowledge_my_admin_level(NULL);
  IF v_my < 5 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: managing groups requires knowledge manager';
  END IF;

  -- THE GUARD THIS FUNCTION EXISTS FOR. Membership confers everything the group
  -- holds, so adding somebody to a group is a grant of that level. Without this
  -- check a knowledge manager adds themselves to any group holding
  -- workspace_admin and has it a second later — laundering straight around
  -- mig 356's escalation guard.
  v_group := public.knowledge_group_max_level(p_group_id);
  IF v_group > v_my AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: "%" carries access above your level, so you cannot add people to it', v_name;
  END IF;

  -- The person must be a real, active member of THIS workspace.
  SELECT coalesce(full_name, 'a teammate') INTO v_who FROM profiles
   WHERE user_id = p_user_id AND tenant_id = v_tenant AND coalesce(is_active, true);
  IF v_who IS NULL THEN RAISE EXCEPTION 'that person is not a member of this workspace'; END IF;

  INSERT INTO knowledge_principal_group_members (tenant_id, group_id, user_id, added_by)
  VALUES (v_tenant, p_group_id, p_user_id, auth.uid())
  ON CONFLICT (group_id, user_id) DO NOTHING;

  PERFORM append_audit_event(v_tenant, 'Knowledge', 'human',
    format('Added %s to the group "%s"', v_who, v_name), 'access_control',
    jsonb_build_object('group_id', p_group_id, 'user_id', p_user_id));
  RETURN jsonb_build_object('ok', true);
END $fn$;
REVOKE ALL ON FUNCTION public.add_group_member(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.add_group_member(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_my int; v_group int; v_name text; v_who text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT name INTO v_name FROM knowledge_principal_groups WHERE id = p_group_id AND tenant_id = v_tenant;
  IF v_name IS NULL THEN RAISE EXCEPTION 'group_not_found'; END IF;

  v_my := public.knowledge_my_admin_level(NULL);
  IF v_my < 5 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: managing groups requires knowledge manager';
  END IF;
  -- Removing is revoking, so the same ceiling applies in reverse: you cannot
  -- strip access you could not have granted.
  v_group := public.knowledge_group_max_level(p_group_id);
  IF v_group > v_my AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: "%" carries access above your level', v_name;
  END IF;

  SELECT coalesce(full_name, 'a teammate') INTO v_who FROM profiles WHERE user_id = p_user_id;
  DELETE FROM knowledge_principal_group_members WHERE group_id = p_group_id AND user_id = p_user_id;

  PERFORM append_audit_event(v_tenant, 'Knowledge', 'human',
    format('Removed %s from the group "%s"', coalesce(v_who,'someone'), v_name), 'access_control',
    jsonb_build_object('group_id', p_group_id, 'user_id', p_user_id));
  RETURN jsonb_build_object('ok', true);
END $fn$;
REVOKE ALL ON FUNCTION public.remove_group_member(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.remove_group_member(uuid, uuid) TO authenticated;

-- ── 5. Prove the guards, and that the tables stay RPC-only ────────────────
DO $assert$
DECLARE v_def text; v_open text[] := ARRAY[]::text[]; r record;
BEGIN
  -- The laundering guard must be in BOTH membership functions.
  FOR r IN SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname='public' AND p.proname IN ('add_group_member','remove_group_member')
  LOOP
    IF r.def !~ 'knowledge_group_max_level' THEN
      RAISE EXCEPTION '358: % has no group-level ceiling — group membership would launder around the escalation guard', r.proname;
    END IF;
  END LOOP;

  -- Deleting a group must report what it destroyed.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='delete_principal_group' LIMIT 1;
  IF v_def !~ 'grants_removed' THEN
    RAISE EXCEPTION '358: deleting a group revokes grants silently';
  END IF;

  -- The tables themselves must stay unwritable from the client, or every guard
  -- above is a front door beside an open window (the 344/349/357 lesson).
  FOR r IN
    SELECT c.relname,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polcmd <> 'r') AS write_policies,
           c.relrowsecurity
      FROM pg_class c
     WHERE c.relname IN ('knowledge_principal_groups','knowledge_principal_group_members')
  LOOP
    IF NOT r.relrowsecurity THEN v_open := v_open || (r.relname || ':no-RLS'); END IF;
    IF r.write_policies > 0 THEN v_open := v_open || (r.relname || ':has-write-policy'); END IF;
  END LOOP;
  IF array_length(v_open, 1) > 0 THEN
    RAISE EXCEPTION '358: group tables are client-writable: %', array_to_string(v_open, ', ');
  END IF;

  RAISE NOTICE '358: group management is RPC-only, ceiling-guarded, and deletion reports its cost';
END $assert$;

NOTIFY pgrst, 'reload schema';
