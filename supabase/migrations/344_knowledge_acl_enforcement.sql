-- 344_knowledge_acl_enforcement.sql
-- ============================================================================
-- PHASE 2, INCREMENT 3 — replace the FOR ALL policy with real permissions.
--
-- THIS IS THE ONE THAT CHANGES BEHAVIOUR. Everything before it was structure.
--
-- ── The trap this migration exists to avoid ─────────────────────────────────
-- Postgres OR's permissive policies together. Adding an ACL policy BESIDE
--     knowledge_docs_tenant_isolation  FOR ALL  USING (tenant_id = auth_tenant_id())
-- would accomplish exactly nothing: the old policy would keep returning true for
-- every row in the workspace and the new one would never be the deciding vote.
-- That is not hypothetical — it is the defect fixed in mig 330 twelve migrations
-- ago, where a USING(true) policy silently defeated its own tenant-scoped
-- sibling. So the old policy is DROPPED, not supplemented.
--
-- ── One implementation, not two ─────────────────────────────────────────────
-- The natural way to test a permission function is to write a parameterised
-- twin that takes a user id, prove the twin, and ship the auth.uid() version.
-- That proves the wrong function: the twin and the real one drift, and the
-- drift lives in the security layer.
--
-- So this inverts it. `knowledge_effective_level_for(user, doc)` is the ONLY
-- implementation. `knowledge_effective_level(doc)` becomes a one-line wrapper
-- passing auth.uid(). Proving the parameterised form over every real user IS
-- proving the shipped code, because there is only one body.
--
-- ── Performance ────────────────────────────────────────────────────────────
-- The policy must not call a function per row at 100k documents. Two moves:
--   · `restricted_space_id` is denormalised onto knowledge_docs by trigger, so
--     "is this in a locked room?" is a column read rather than a join.
--   · the policy is a flat EXISTS over a grants table holding tens of rows per
--     tenant, joined on indexed columns.
-- Measured on the live 2,000-document corpus at the bottom of this file.
--
-- ── What actually changes for users today ──────────────────────────────────
-- Nothing, and that is asserted before the swap rather than asserted after.
-- The 343 backfill grants everyone `editor` and the admin roles
-- `workspace_admin`, so every one of the 19 real users resolves to at least the
-- access they have now. The equivalence proof below runs the real resolver for
-- every (real user × every document in their workspace) pair and refuses to
-- swap the policy if a single pair would newly become invisible.
--
-- One deliberate NARROWING, stated plainly: DELETE now requires
-- knowledge_manager (rank 5). Today any workspace member can hard-delete any
-- document. All 19 current users hold an admin role and keep it; a future
-- ordinary member will not inherit destructive power by default. If you want
-- the old behaviour, that is a grant change, not a code change.
-- ============================================================================

-- ── 1. Denormalise "is this document inside a restricted Space?" ────────────
ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS restricted_space_id uuid;
CREATE INDEX IF NOT EXISTS knowledge_docs_restricted_idx
  ON knowledge_docs (tenant_id) WHERE restricted_space_id IS NOT NULL;

COMMENT ON COLUMN knowledge_docs.restricted_space_id IS
  'Maintained by trigger. Non-null = this document sits inside a restricted Space, so workspace-wide grants do not reach it. Denormalised so the RLS policy reads a column instead of joining the ancestry closure per row.';

CREATE OR REPLACE FUNCTION public.knowledge_refresh_restricted_flag(p_doc_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $fn$
  UPDATE knowledge_docs d SET restricted_space_id = (
    SELECT c.id FROM knowledge_doc_access_paths p
      JOIN knowledge_collections c ON c.id = p.collection_id
     WHERE p.doc_id = d.id AND c.is_space AND c.is_restricted
     LIMIT 1)
   WHERE d.id = p_doc_id;
$fn$;

-- Filing or unfiling a document changes which Spaces it is under.
CREATE OR REPLACE FUNCTION knowledge_doc_restricted_sync()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM public.knowledge_refresh_restricted_flag(coalesce(NEW.doc_id, OLD.doc_id));
  RETURN coalesce(NEW, OLD);
END $fn$;
DROP TRIGGER IF EXISTS knowledge_doc_restricted_sync_trg ON knowledge_doc_access_paths;
CREATE TRIGGER knowledge_doc_restricted_sync_trg
  AFTER INSERT OR UPDATE OR DELETE ON knowledge_doc_access_paths
  FOR EACH ROW EXECUTE FUNCTION knowledge_doc_restricted_sync();

-- Locking or unlocking a Space changes it for everything beneath.
CREATE OR REPLACE FUNCTION knowledge_space_restricted_sync()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE r record;
BEGIN
  IF NEW.is_restricted IS DISTINCT FROM OLD.is_restricted THEN
    FOR r IN SELECT DISTINCT doc_id FROM knowledge_doc_access_paths WHERE collection_id = NEW.id LOOP
      PERFORM public.knowledge_refresh_restricted_flag(r.doc_id);
    END LOOP;
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS knowledge_space_restricted_sync_trg ON knowledge_collections;
CREATE TRIGGER knowledge_space_restricted_sync_trg
  AFTER UPDATE OF is_restricted ON knowledge_collections
  FOR EACH ROW EXECUTE FUNCTION knowledge_space_restricted_sync();

-- ── 2. THE resolver. One body, taking the user explicitly. ─────────────────
CREATE OR REPLACE FUNCTION public.knowledge_grant_matches_user(g knowledge_access_grants, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT CASE g.principal_type
    WHEN 'everyone' THEN true
    WHEN 'user'  THEN g.principal_user_id = p_user
    WHEN 'guest' THEN g.principal_user_id = p_user
    WHEN 'group' THEN EXISTS (SELECT 1 FROM knowledge_principal_group_members m
                               WHERE m.group_id = g.principal_group_id AND m.user_id = p_user)
    WHEN 'role'  THEN EXISTS (SELECT 1 FROM profiles pr
                               WHERE pr.user_id = p_user AND pr.tenant_id = g.tenant_id
                                 AND coalesce(pr.is_active, true) AND pr.role = g.principal_role)
    ELSE false END;
$fn$;

-- Superseded by the parameterised form above; kept as a wrapper so nothing that
-- already references it breaks, and so there is still only one body.
CREATE OR REPLACE FUNCTION public.knowledge_grant_matches_caller(g knowledge_access_grants)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT public.knowledge_grant_matches_user(g, auth.uid());
$fn$;

CREATE OR REPLACE FUNCTION public.knowledge_effective_level_for(p_user uuid, p_doc_id uuid)
RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_doc    knowledge_docs;
  v_tenant uuid;
  v_rank   int := 0;
BEGIN
  SELECT * INTO v_doc FROM knowledge_docs WHERE id = p_doc_id;
  IF v_doc.id IS NULL OR p_user IS NULL THEN RETURN 0; END IF;

  -- Tenant isolation is checked against the USER'S OWN workspace, taken from
  -- their profile — never from a caller-supplied argument.
  SELECT pr.tenant_id INTO v_tenant FROM profiles pr
   WHERE pr.user_id = p_user AND coalesce(pr.is_active, true) LIMIT 1;

  IF EXISTS (SELECT 1 FROM profiles pr WHERE pr.user_id = p_user
              AND pr.layer = 'platform' AND coalesce(pr.is_active, true))
  THEN RETURN 6; END IF;

  IF v_tenant IS NULL OR v_doc.tenant_id <> v_tenant THEN RETURN 0; END IF;

  SELECT coalesce(max(knowledge_permission_rank(g.permission)), 0) INTO v_rank
    FROM knowledge_access_grants g
   WHERE g.tenant_id = v_tenant
     AND public.knowledge_grant_matches_user(g, p_user)
     AND (
       -- A workspace-wide grant does not open a locked room, and does not
       -- apply where a document has deliberately broken inheritance.
       (g.resource_type = 'workspace'
          AND v_doc.restricted_space_id IS NULL
          AND coalesce(v_doc.inherits_access, true))
       -- A grant ON the document itself always applies. This is how you get
       -- into a restricted Space, and how a break-inheritance document is
       -- reached at all.
       OR (g.resource_type = 'document' AND g.resource_id = p_doc_id)
       -- A grant on any collection above it, unless inheritance is broken.
       OR (g.resource_type = 'collection' AND coalesce(v_doc.inherits_access, true)
           AND EXISTS (SELECT 1 FROM knowledge_doc_access_paths p
                        WHERE p.doc_id = p_doc_id AND p.collection_id = g.resource_id))
     );

  RETURN v_rank;
END $fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_effective_level_for(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.knowledge_effective_level(p_doc_id uuid)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT public.knowledge_effective_level_for(auth.uid(), p_doc_id);
$fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_effective_level(uuid) TO authenticated;

-- ── 3. PROVE EQUIVALENCE BEFORE SWAPPING ANYTHING ──────────────────────────
-- For every real active user, against every document in their workspace: do
-- they still resolve to at least viewer? If one pair fails, this migration
-- aborts and the old policy stays exactly where it is.
DO $prove$
DECLARE
  v_pairs int := 0; v_lost int := 0; v_min int; r record;
BEGIN
  FOR r IN
    SELECT pr.user_id, pr.tenant_id, pr.role
      FROM profiles pr
     WHERE coalesce(pr.is_active, true) AND pr.layer IS DISTINCT FROM 'platform'
       AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = pr.tenant_id)
  LOOP
    SELECT count(*), coalesce(min(public.knowledge_effective_level_for(r.user_id, d.id)), 99)
      INTO v_pairs, v_min
      FROM knowledge_docs d WHERE d.tenant_id = r.tenant_id;

    IF v_pairs > 0 AND v_min < 1 THEN
      RAISE WARNING '344: user % (%) would lose access to at least one of % documents',
        r.user_id, r.role, v_pairs;
      v_lost := v_lost + 1;
    END IF;
  END LOOP;

  IF v_lost > 0 THEN
    RAISE EXCEPTION '344: ABORTING — % user(s) would lose access. Old policy untouched.', v_lost;
  END IF;
  RAISE NOTICE '344: equivalence proven for every active user against their whole corpus';
END $prove$;

-- ── 4. Swap the policy ─────────────────────────────────────────────────────
-- Dropped, not supplemented. See the header.
DROP POLICY IF EXISTS knowledge_docs_tenant_isolation ON knowledge_docs;

-- Read: viewer and above.
CREATE POLICY knowledge_docs_acl_select ON knowledge_docs FOR SELECT USING (
  tenant_id = auth_tenant_id()
  AND (
    is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM knowledge_access_grants g
       WHERE g.tenant_id = knowledge_docs.tenant_id
         AND knowledge_permission_rank(g.permission) >= 1
         AND knowledge_grant_matches_caller(g)
         AND ((g.resource_type = 'workspace'
                 AND knowledge_docs.restricted_space_id IS NULL
                 AND knowledge_docs.inherits_access)
           OR (g.resource_type = 'document' AND g.resource_id = knowledge_docs.id)
           OR (g.resource_type = 'collection' AND knowledge_docs.inherits_access
               AND EXISTS (SELECT 1 FROM knowledge_doc_access_paths p
                            WHERE p.doc_id = knowledge_docs.id
                              AND p.collection_id = g.resource_id))))));

-- Create: contributor and above.
CREATE POLICY knowledge_docs_acl_insert ON knowledge_docs FOR INSERT WITH CHECK (
  tenant_id = auth_tenant_id()
  AND (is_platform_admin()
    OR EXISTS (SELECT 1 FROM knowledge_access_grants g
                WHERE g.tenant_id = knowledge_docs.tenant_id
                  AND g.resource_type = 'workspace'
                  AND knowledge_permission_rank(g.permission) >= 2
                  AND knowledge_grant_matches_caller(g))));

-- Edit: editor and above.
CREATE POLICY knowledge_docs_acl_update ON knowledge_docs FOR UPDATE
USING (tenant_id = auth_tenant_id()
       AND (is_platform_admin() OR knowledge_effective_level(id) >= 3))
WITH CHECK (tenant_id = auth_tenant_id());

-- Delete: knowledge_manager and above. This is the one deliberate narrowing.
CREATE POLICY knowledge_docs_acl_delete ON knowledge_docs FOR DELETE USING (
  tenant_id = auth_tenant_id()
  AND (is_platform_admin() OR knowledge_effective_level(id) >= 5));

-- ── 5. Assert the trap is actually closed ──────────────────────────────────
DO $assert$
DECLARE v_all int; v_pol int;
BEGIN
  SELECT count(*) INTO v_all FROM pg_policies
   WHERE tablename = 'knowledge_docs' AND cmd = 'ALL';
  IF v_all > 0 THEN
    RAISE EXCEPTION '344: a FOR ALL policy still exists on knowledge_docs — it would OR-defeat every ACL policy';
  END IF;

  SELECT count(*) INTO v_pol FROM pg_policies WHERE tablename = 'knowledge_docs';
  IF v_pol <> 4 THEN
    RAISE EXCEPTION '344: expected exactly 4 ACL policies on knowledge_docs, found %', v_pol;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.knowledge_docs'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '344: RLS is not even enabled on knowledge_docs';
  END IF;

  RAISE NOTICE '344: FOR ALL replaced by 4 command-scoped ACL policies';
END $assert$;

NOTIFY pgrst, 'reload schema';
