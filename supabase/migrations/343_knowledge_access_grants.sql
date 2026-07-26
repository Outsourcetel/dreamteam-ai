-- 343_knowledge_access_grants.sql
-- ============================================================================
-- PHASE 2, INCREMENT 2 — the permission model itself.
--
-- STILL BEHAVIOUR-NEUTRAL. This creates the grant tables, the human group
-- primitive, the resolution functions and the ancestry closure, and backfills
-- grants that reproduce TODAY'S access exactly. It does NOT touch a single RLS
-- policy — that is increment 3, and keeping it separate is what makes the
-- riskiest change in this phase a small diff against a model already proven.
--
-- ── The six levels, as specified ────────────────────────────────────────────
--   1 viewer            view published documents
--   2 contributor       + create drafts, suggest changes
--   3 editor            + edit, move and organise
--   4 publisher         + review, approve and publish
--   5 knowledge_manager + manage spaces, collections, owners, lifecycle, perms
--   6 workspace_admin   full control
-- Stored as text (readable in every audit log and error message) with an
-- IMMUTABLE rank function for comparison. A smallint would be faster and
-- unreadable; grants are tens of rows per tenant, so readability wins.
--
-- ── Principals ──────────────────────────────────────────────────────────────
-- everyone · role · group · user · guest. Three typed columns rather than one
-- polymorphic `principal_id`, because a user and a group can then both carry a
-- real foreign key. The alternative — a uuid column meaning different things by
-- discriminator — is unenforceable at exactly the moment it matters.
--
-- ── Resources ───────────────────────────────────────────────────────────────
-- workspace · collection · document. There is deliberately NO 'space' type: a
-- Space IS a collection with is_space = true (mig 341). Two names for one row
-- is the drift bug this session has already paid for three times.
--
-- `workspace` matters more than it looks. 1,950 of the 2,000 live documents sit
-- in NO collection. If access required a collection ancestry, every one of them
-- would resolve to no grants and vanish on the day the policy flips. The
-- workspace-level grant is what makes the backfill honest.
--
-- ── Why a closure table ─────────────────────────────────────────────────────
-- Resolving inheritance means walking Space > Collection > Sub-collection for
-- each document. Done inside an RLS policy that is a recursive CTE per row —
-- the N+1 called out in docs/27 §4.5, fatal at 100k documents. So the ancestry
-- is materialised into knowledge_doc_access_paths by trigger (depth is capped
-- at 3, so at most 3 rows per membership) and the policy becomes a flat indexed
-- EXISTS. This codebase has made this exact trade twice already — chunk counts
-- (mig 279) and the tenant_id denormalisation on knowledge_doc_collections
-- (mig 284) — both for the same reason.
-- ============================================================================

-- ── 1. The ladder ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.knowledge_permission_rank(p_level text)
RETURNS int LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE p_level
    WHEN 'viewer' THEN 1 WHEN 'contributor' THEN 2 WHEN 'editor' THEN 3
    WHEN 'publisher' THEN 4 WHEN 'knowledge_manager' THEN 5 WHEN 'workspace_admin' THEN 6
    ELSE 0 END;
$fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_permission_rank(text) TO authenticated;

-- ── 2. Human groups — the primitive that genuinely did not exist ────────────
-- workforce_teams is for Digital Employees (de_id references digital_employees)
-- and mig 128 states outright that teams never grant access. Humans had nothing.
CREATE TABLE IF NOT EXISTS knowledge_principal_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_principal_groups_name_uq
  ON knowledge_principal_groups (tenant_id, lower(name));

CREATE TABLE IF NOT EXISTS knowledge_principal_group_members (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id   uuid NOT NULL REFERENCES knowledge_principal_groups(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  added_by   uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS knowledge_group_members_user_idx
  ON knowledge_principal_group_members (user_id, tenant_id);

ALTER TABLE knowledge_principal_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_principal_group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_principal_groups_read ON knowledge_principal_groups;
CREATE POLICY knowledge_principal_groups_read ON knowledge_principal_groups
  FOR SELECT USING (tenant_id = auth_tenant_id());
DROP POLICY IF EXISTS knowledge_group_members_read ON knowledge_principal_group_members;
CREATE POLICY knowledge_group_members_read ON knowledge_principal_group_members
  FOR SELECT USING (tenant_id = auth_tenant_id());
-- Writes go through RPCs only. A client-writable group table is a client-
-- writable permission system.

-- ── 3. Grants ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_access_grants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  resource_type      text NOT NULL CHECK (resource_type IN ('workspace','collection','document')),
  resource_id        uuid,           -- NULL only for resource_type='workspace'

  principal_type     text NOT NULL CHECK (principal_type IN ('everyone','role','group','user','guest')),
  principal_user_id  uuid,
  principal_group_id uuid REFERENCES knowledge_principal_groups(id) ON DELETE CASCADE,
  principal_role     text,

  permission         text NOT NULL CHECK (permission IN
                       ('viewer','contributor','editor','publisher','knowledge_manager','workspace_admin')),
  granted_by         uuid,
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Exactly one principal column populated, matched to the discriminator.
  CONSTRAINT knowledge_grants_principal_shape CHECK (
    (principal_type = 'everyone' AND principal_user_id IS NULL AND principal_group_id IS NULL AND principal_role IS NULL)
 OR (principal_type IN ('user','guest') AND principal_user_id IS NOT NULL AND principal_group_id IS NULL AND principal_role IS NULL)
 OR (principal_type = 'group'    AND principal_group_id IS NOT NULL AND principal_user_id IS NULL AND principal_role IS NULL)
 OR (principal_type = 'role'     AND principal_role IS NOT NULL AND principal_user_id IS NULL AND principal_group_id IS NULL)),

  CONSTRAINT knowledge_grants_resource_shape CHECK (
    (resource_type = 'workspace' AND resource_id IS NULL)
 OR (resource_type <> 'workspace' AND resource_id IS NOT NULL))
);

-- One grant per (resource, principal). Re-granting updates the level rather
-- than stacking two rows that disagree.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_access_grants_uq ON knowledge_access_grants (
  tenant_id, resource_type, coalesce(resource_id, '00000000-0000-0000-0000-000000000000'::uuid),
  principal_type,
  coalesce(principal_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(principal_role, ''));

CREATE INDEX IF NOT EXISTS knowledge_access_grants_lookup_idx
  ON knowledge_access_grants (tenant_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS knowledge_access_grants_user_idx
  ON knowledge_access_grants (tenant_id, principal_user_id) WHERE principal_user_id IS NOT NULL;

ALTER TABLE knowledge_access_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_access_grants_read ON knowledge_access_grants;
CREATE POLICY knowledge_access_grants_read ON knowledge_access_grants
  FOR SELECT USING (tenant_id = auth_tenant_id());
-- No client INSERT/UPDATE/DELETE policy, deliberately. Granting yourself
-- workspace_admin must not be a PostgREST call away.

-- ── 4. Restricted spaces and broken inheritance ─────────────────────────────
-- "Least privilege and default-deny for restricted spaces", and "a child may
-- become more restrictive but must not silently become broader".
ALTER TABLE knowledge_collections ADD COLUMN IF NOT EXISTS is_restricted boolean NOT NULL DEFAULT false;
ALTER TABLE knowledge_collections ADD COLUMN IF NOT EXISTS inherits_access boolean NOT NULL DEFAULT true;
ALTER TABLE knowledge_docs        ADD COLUMN IF NOT EXISTS inherits_access boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN knowledge_collections.is_restricted IS
  'A restricted Space is a locked room: a workspace-wide grant does not open it. Access requires a grant on the Space itself or something inside it.';
COMMENT ON COLUMN knowledge_collections.inherits_access IS
  'False = inheritance broken here. Grants above this point stop applying; only grants on this resource and below count.';

-- ── 5. Ancestry closure — doc → every collection above it ───────────────────
CREATE TABLE IF NOT EXISTS knowledge_doc_access_paths (
  tenant_id     uuid NOT NULL,
  doc_id        uuid NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
  depth         int  NOT NULL,      -- 1 = the collection the doc is filed in
  PRIMARY KEY (doc_id, collection_id)
);
CREATE INDEX IF NOT EXISTS knowledge_doc_access_paths_coll_idx
  ON knowledge_doc_access_paths (tenant_id, collection_id);
ALTER TABLE knowledge_doc_access_paths ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_doc_access_paths_read ON knowledge_doc_access_paths;
CREATE POLICY knowledge_doc_access_paths_read ON knowledge_doc_access_paths
  FOR SELECT USING (tenant_id = auth_tenant_id());

CREATE OR REPLACE FUNCTION public.knowledge_rebuild_doc_paths(p_doc_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  DELETE FROM knowledge_doc_access_paths WHERE doc_id = p_doc_id;
  INSERT INTO knowledge_doc_access_paths (tenant_id, doc_id, collection_id, depth)
  WITH RECURSIVE direct AS (
    SELECT dc.tenant_id, dc.collection_id, 1 AS depth
      FROM knowledge_doc_collections dc WHERE dc.doc_id = p_doc_id
  ), up AS (
    SELECT tenant_id, collection_id, depth FROM direct
    UNION
    SELECT u.tenant_id, c.parent_id, u.depth + 1
      FROM up u JOIN knowledge_collections c ON c.id = u.collection_id
     WHERE c.parent_id IS NOT NULL AND u.depth < 3
  )
  SELECT DISTINCT ON (collection_id) tenant_id, p_doc_id, collection_id, depth
    FROM up WHERE collection_id IS NOT NULL
   ORDER BY collection_id, depth;
END $fn$;

CREATE OR REPLACE FUNCTION knowledge_doc_paths_sync()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM public.knowledge_rebuild_doc_paths(coalesce(NEW.doc_id, OLD.doc_id));
  RETURN coalesce(NEW, OLD);
END $fn$;

DROP TRIGGER IF EXISTS knowledge_doc_paths_sync_trg ON knowledge_doc_collections;
CREATE TRIGGER knowledge_doc_paths_sync_trg
  AFTER INSERT OR UPDATE OR DELETE ON knowledge_doc_collections
  FOR EACH ROW EXECUTE FUNCTION knowledge_doc_paths_sync();

-- Re-parenting a collection changes ancestry for everything beneath it.
CREATE OR REPLACE FUNCTION knowledge_collection_reparent_sync()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE r record;
BEGIN
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    FOR r IN SELECT DISTINCT doc_id FROM knowledge_doc_access_paths WHERE collection_id = NEW.id LOOP
      PERFORM public.knowledge_rebuild_doc_paths(r.doc_id);
    END LOOP;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS knowledge_collection_reparent_sync_trg ON knowledge_collections;
CREATE TRIGGER knowledge_collection_reparent_sync_trg
  AFTER UPDATE OF parent_id ON knowledge_collections
  FOR EACH ROW EXECUTE FUNCTION knowledge_collection_reparent_sync();

-- ── 6. Resolution ───────────────────────────────────────────────────────────
-- Does this grant apply to whoever is calling right now?
CREATE OR REPLACE FUNCTION public.knowledge_grant_matches_caller(g knowledge_access_grants)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT CASE g.principal_type
    WHEN 'everyone' THEN true
    WHEN 'user'  THEN g.principal_user_id = auth.uid()
    WHEN 'guest' THEN g.principal_user_id = auth.uid()
    WHEN 'group' THEN EXISTS (SELECT 1 FROM knowledge_principal_group_members m
                               WHERE m.group_id = g.principal_group_id AND m.user_id = auth.uid())
    WHEN 'role'  THEN EXISTS (SELECT 1 FROM profiles pr
                               WHERE pr.user_id = auth.uid() AND pr.tenant_id = g.tenant_id
                                 AND coalesce(pr.is_active, true) AND pr.role = g.principal_role)
    ELSE false END;
$fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_grant_matches_caller(knowledge_access_grants) TO authenticated;

-- What level does the CALLER hold on a document?
-- Returns 0 for no access. Used by the RLS policies in increment 3, by the
-- retrieval predicate, and by the "Effective access" preview the spec asks for.
--
-- Platform operators on an active remote-access session keep the reach they
-- have today — auth_tenant_id() already grants it, and silently removing
-- support's ability to see a customer's knowledge while debugging would be a
-- regression dressed up as a security win. It is audited by mig 330's machinery.
CREATE OR REPLACE FUNCTION public.knowledge_effective_level(p_doc_id uuid)
RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_tenant uuid;
  v_doc    knowledge_docs;
  v_rank   int := 0;
  v_space_restricted boolean := false;
  v_in_restricted_space boolean;
BEGIN
  SELECT * INTO v_doc FROM knowledge_docs WHERE id = p_doc_id;
  IF v_doc.id IS NULL THEN RETURN 0; END IF;

  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RETURN 0; END IF;              -- anon/service handled by callers
  IF v_doc.tenant_id <> v_tenant THEN RETURN 0; END IF;   -- tenant isolation, first and always
  IF is_platform_admin() THEN RETURN 6; END IF;

  -- Does this document live inside a restricted Space?
  SELECT EXISTS (
    SELECT 1 FROM knowledge_doc_access_paths p
      JOIN knowledge_collections c ON c.id = p.collection_id
     WHERE p.doc_id = p_doc_id AND c.is_space AND c.is_restricted)
  INTO v_in_restricted_space;

  SELECT coalesce(max(knowledge_permission_rank(g.permission)), 0) INTO v_rank
    FROM knowledge_access_grants g
   WHERE g.tenant_id = v_tenant
     AND public.knowledge_grant_matches_caller(g)
     AND (
       -- Workspace-wide grants do NOT reach into a restricted Space.
       (g.resource_type = 'workspace' AND NOT v_in_restricted_space
          AND coalesce(v_doc.inherits_access, true))
       OR (g.resource_type = 'document' AND g.resource_id = p_doc_id)
       OR (g.resource_type = 'collection' AND coalesce(v_doc.inherits_access, true)
           AND EXISTS (SELECT 1 FROM knowledge_doc_access_paths p
                        WHERE p.doc_id = p_doc_id AND p.collection_id = g.resource_id))
     );

  RETURN v_rank;
END $fn$;
GRANT EXECUTE ON FUNCTION public.knowledge_effective_level(uuid) TO authenticated;

-- ── 7. Backfill: reproduce today's access exactly ───────────────────────────
-- Today knowledge_docs has ONE policy, FOR ALL, USING (tenant_id = auth_tenant_id()).
-- Every member of a workspace can read, write and delete everything in it.
-- Two grants per tenant reproduce that without giving a future ordinary member
-- destructive power by default:
--   · everyone → editor           (read, create, edit — what people actually do)
--   · the admin roles → workspace_admin (delete, permissions, lifecycle)
-- Measured first: all 19 existing profiles hold an owner/admin role, so NO
-- CURRENT USER LOSES ANY ABILITY. That is the whole test for this backfill.
INSERT INTO knowledge_access_grants (tenant_id, resource_type, resource_id, principal_type, permission, note)
SELECT t.id, 'workspace', NULL, 'everyone', 'editor',
       'Backfilled by mig 343 to reproduce pre-ACL behaviour exactly.'
  FROM tenants t
ON CONFLICT DO NOTHING;

INSERT INTO knowledge_access_grants (tenant_id, resource_type, resource_id, principal_type, principal_role, permission, note)
SELECT t.id, 'workspace', NULL, 'role', r.role, 'workspace_admin',
       'Backfilled by mig 343: admins keep the full control they have today.'
  FROM tenants t
  CROSS JOIN (VALUES ('tenant_owner'),('tenant_admin'),('owner'),('admin')) AS r(role)
ON CONFLICT DO NOTHING;

-- ── 8. Prove it ─────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_t int; v_g int; v_everyone int; v_noaccess int;
BEGIN
  SELECT count(*) INTO v_t FROM tenants;
  SELECT count(*) INTO v_g FROM knowledge_access_grants;
  SELECT count(*) INTO v_everyone FROM knowledge_access_grants WHERE principal_type='everyone';

  IF v_everyone <> v_t THEN
    RAISE EXCEPTION '343: % tenants but only % workspace-wide grants — some workspace would go dark', v_t, v_everyone;
  END IF;

  -- Every existing human must resolve to at least editor, or the backfill has
  -- silently taken access away from a real person.
  --
  -- Scoped to people who can actually resolve a workspace today. This surfaced
  -- an orphaned tenant_owner with a NULL tenant_id (profile created 2026-07-09,
  -- its tenant no longer exists). auth_tenant_id() returns NULL for them, and
  -- `tenant_id = NULL` is NULL rather than true, so the CURRENT policy already
  -- denies them everything. Counting them as "losing access" would be measuring
  -- a hole that predates this migration — and would block a correct backfill on
  -- an unrelated data defect. Reported separately below instead.
  SELECT count(*) INTO v_noaccess
    FROM profiles pr
   WHERE pr.layer IS DISTINCT FROM 'platform'
     AND coalesce(pr.is_active, true)
     AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = pr.tenant_id)
     AND NOT EXISTS (
       SELECT 1 FROM knowledge_access_grants g
        WHERE g.tenant_id = pr.tenant_id
          AND (g.principal_type = 'everyone'
               OR (g.principal_type = 'role' AND g.principal_role = pr.role))
          AND knowledge_permission_rank(g.permission) >= 3);
  IF v_noaccess > 0 THEN
    RAISE EXCEPTION '343: % existing user(s) would lose edit access', v_noaccess;
  END IF;

  -- The ladder must be strictly ordered, or every comparison downstream is wrong.
  IF NOT (knowledge_permission_rank('viewer') < knowledge_permission_rank('contributor')
      AND knowledge_permission_rank('contributor') < knowledge_permission_rank('editor')
      AND knowledge_permission_rank('editor') < knowledge_permission_rank('publisher')
      AND knowledge_permission_rank('publisher') < knowledge_permission_rank('knowledge_manager')
      AND knowledge_permission_rank('knowledge_manager') < knowledge_permission_rank('workspace_admin')
      AND knowledge_permission_rank('nonsense') = 0)
  THEN RAISE EXCEPTION '343: the permission ladder is not strictly ordered'; END IF;

  RAISE NOTICE '343: % grants across % tenants; no existing user loses access', v_g, v_t;

  -- Orphans: real rows that point at a workspace that no longer exists. Not
  -- caused by this migration and not fixed by it — but they should not stay
  -- invisible just because they happen to be harmless today.
  SELECT count(*) INTO v_noaccess FROM profiles pr
   WHERE coalesce(pr.is_active, true) AND pr.layer IS DISTINCT FROM 'platform'
     AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = pr.tenant_id);
  IF v_noaccess > 0 THEN
    RAISE WARNING '343: % active profile(s) reference a workspace that no longer exists — they can reach nothing today', v_noaccess;
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
