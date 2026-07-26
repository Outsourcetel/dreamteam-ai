-- 341_knowledge_spaces.sql
-- ============================================================================
-- PHASE 2, INCREMENT 1 — Knowledge Spaces and a safe collection hierarchy.
-- Plan of record: docs/27. Founder approved the pushbacks in §7.
--
-- BEHAVIOUR-NEUTRAL BY DESIGN. This adds structure and constraints only. No
-- permission is enforced yet, no retrieval path changes, no document moves. It
-- is verifiable on its own, which is the point of shipping it alone.
--
-- ── Why Spaces are collections, not a new table ─────────────────────────────
-- The spec suggests a `knowledge_spaces` table. Audited first: the hierarchy it
-- describes ALREADY EXISTS as knowledge_collections.parent_id — and the table
-- holds ZERO rows across all 16 tenants, as does knowledge_doc_collections.
-- A second hierarchy would mean two parent chains to keep consistent, two RLS
-- surfaces, and a join every reader would have to remember. This session has
-- already produced three bugs from exactly that shape (tenant-scoped citation
-- writes silently dropping shelf ids; a deflection and a fan-in disagreeing;
-- 'pending' vs 'proposed' in one workflow).
--
-- So: a Space IS a collection with no parent. `is_space` makes that explicit
-- and enforceable rather than implied by parent_id being NULL.
--
-- ── The three structural rules the spec asks for ────────────────────────────
--   1. A Space is a root; a Collection always has a parent.
--   2. Depth is capped at 3 (Space > Collection > Sub-collection).
--   3. No cycles, and no cross-tenant parents.
-- All enforced by trigger, because a CHECK cannot walk a parent chain.
--
-- ── Backfill ────────────────────────────────────────────────────────────────
-- Every tenant gets a "General" Space. Documents are NOT assigned to it here —
-- assignment is increment 3, and doing it now would touch 2,000 rows for no
-- behavioural gain. An empty Space is honest; a wrongly-filed corpus is not.
-- ============================================================================

-- ── 1. A collection is either a Space (root) or a child ─────────────────────
ALTER TABLE knowledge_collections ADD COLUMN IF NOT EXISTS is_space boolean NOT NULL DEFAULT false;
ALTER TABLE knowledge_collections ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE knowledge_collections ADD COLUMN IF NOT EXISTS sort_order int NOT NULL DEFAULT 0;
ALTER TABLE knowledge_collections ADD COLUMN IF NOT EXISTS archived_at timestamptz;

COMMENT ON COLUMN knowledge_collections.is_space IS
  'True = a Knowledge Space: a root collection and the top-level organisational and security boundary. A Space never has a parent; a non-Space always does.';

ALTER TABLE knowledge_collections DROP CONSTRAINT IF EXISTS knowledge_collections_space_is_root;
ALTER TABLE knowledge_collections ADD CONSTRAINT knowledge_collections_space_is_root
  CHECK ((is_space AND parent_id IS NULL) OR (NOT is_space AND parent_id IS NOT NULL));

-- A Space name is the thing humans navigate by; keep it unique per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_collections_space_name_uq
  ON knowledge_collections (tenant_id, lower(name)) WHERE is_space AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS knowledge_collections_parent_idx
  ON knowledge_collections (tenant_id, parent_id) WHERE archived_at IS NULL;

-- ── 2. Depth, cycles and cross-tenant parents ───────────────────────────────
-- A CHECK cannot walk a parent chain, so this is a trigger. It runs on INSERT
-- and on any parent change — which is exactly when a move could create a loop.
CREATE OR REPLACE FUNCTION knowledge_collections_guard()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_parent knowledge_collections;
  v_depth int := 1;
  v_cursor uuid;
  v_seen uuid[] := ARRAY[]::uuid[];
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;   -- a Space; nothing to walk

  SELECT * INTO v_parent FROM knowledge_collections WHERE id = NEW.parent_id;
  IF v_parent.id IS NULL THEN
    RAISE EXCEPTION 'parent collection does not exist';
  END IF;
  -- Tenant-safe foreign key: the FK alone would allow a parent in another
  -- workspace, which would make one tenant's tree reachable from another's.
  IF v_parent.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'a collection cannot live under a parent in a different workspace';
  END IF;

  -- Walk up: measures depth AND detects a cycle in one pass.
  v_cursor := NEW.parent_id;
  WHILE v_cursor IS NOT NULL LOOP
    IF v_cursor = NEW.id THEN
      RAISE EXCEPTION 'that move would make a collection its own ancestor';
    END IF;
    IF v_cursor = ANY(v_seen) THEN
      RAISE EXCEPTION 'the collection tree already contains a loop at %', v_cursor;
    END IF;
    v_seen := v_seen || v_cursor;
    v_depth := v_depth + 1;
    IF v_depth > 3 THEN
      RAISE EXCEPTION 'collections may be nested at most 3 levels deep (Space > Collection > Sub-collection)';
    END IF;
    SELECT parent_id INTO v_cursor FROM knowledge_collections WHERE id = v_cursor;
  END LOOP;

  -- The chain must terminate at a Space, or the tree has no security root.
  IF NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE id = v_seen[array_length(v_seen,1)] AND is_space) THEN
    RAISE EXCEPTION 'every collection must sit under a Knowledge Space';
  END IF;

  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS knowledge_collections_guard_trg ON knowledge_collections;
CREATE TRIGGER knowledge_collections_guard_trg
  BEFORE INSERT OR UPDATE OF parent_id, tenant_id ON knowledge_collections
  FOR EACH ROW EXECUTE FUNCTION knowledge_collections_guard();

-- ── 3. knowledge_doc_collections could point across workspaces ──────────────
-- Two independent FKs (doc_id, collection_id) with nothing asserting they agree
-- on tenant — the same divergence shape that exists on knowledge_doc_chunks and
-- that the shelf design avoided by having a single FK. Closed here.
CREATE OR REPLACE FUNCTION knowledge_doc_collections_guard()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM knowledge_docs d WHERE d.id = NEW.doc_id AND d.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'document does not belong to this workspace';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_collections c WHERE c.id = NEW.collection_id AND c.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'collection does not belong to this workspace';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS knowledge_doc_collections_guard_trg ON knowledge_doc_collections;
CREATE TRIGGER knowledge_doc_collections_guard_trg
  BEFORE INSERT OR UPDATE ON knowledge_doc_collections
  FOR EACH ROW EXECUTE FUNCTION knowledge_doc_collections_guard();

-- ── 4. Ancestry helper — one recursive walk, reused by everything later ─────
-- Increment 3 resolves inherited permissions. Doing that per document at query
-- time is the classic N+1; this returns the chain once so callers can join.
CREATE OR REPLACE FUNCTION public.knowledge_collection_ancestry(p_collection_id uuid)
RETURNS TABLE (collection_id uuid, depth int, is_space boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH RECURSIVE up AS (
    SELECT c.id, c.parent_id, 1 AS depth, c.is_space
      FROM knowledge_collections c WHERE c.id = p_collection_id
    UNION ALL
    SELECT c.id, c.parent_id, up.depth + 1, c.is_space
      FROM knowledge_collections c JOIN up ON c.id = up.parent_id
     WHERE up.depth < 3            -- the tree is capped, so this cannot run away
  )
  SELECT id, depth, is_space FROM up;
$fn$;
REVOKE ALL ON FUNCTION public.knowledge_collection_ancestry(uuid) FROM public, anon;

-- ── 5. Backfill: one "General" Space per workspace ──────────────────────────
-- Documents are deliberately NOT moved into it. Filing 2,000 documents into a
-- Space nobody chose would be a guess presented as organisation.
INSERT INTO knowledge_collections (tenant_id, parent_id, name, description, is_space, icon)
SELECT t.id, NULL, 'General',
       'Everything that has not been filed into a Space yet.', true, 'folder'
  FROM tenants t
 WHERE NOT EXISTS (
   SELECT 1 FROM knowledge_collections c
    WHERE c.tenant_id = t.id AND c.is_space AND lower(c.name) = 'general');

-- ── 6. Prove the guards actually guard ──────────────────────────────────────
DO $assert$
DECLARE v_t uuid; v_space uuid; v_a uuid; v_b uuid; v_c uuid; v_ok boolean;
BEGIN
  SELECT id INTO v_t FROM tenants ORDER BY created_at LIMIT 1;
  SELECT id INTO v_space FROM knowledge_collections WHERE tenant_id = v_t AND is_space LIMIT 1;
  IF v_space IS NULL THEN RAISE EXCEPTION '341: backfill did not create a Space'; END IF;

  -- depth 2 and 3 are allowed
  INSERT INTO knowledge_collections (tenant_id, parent_id, name) VALUES (v_t, v_space, '__t_a') RETURNING id INTO v_a;
  INSERT INTO knowledge_collections (tenant_id, parent_id, name) VALUES (v_t, v_a, '__t_b') RETURNING id INTO v_b;

  -- depth 4 must fail
  v_ok := false;
  BEGIN
    INSERT INTO knowledge_collections (tenant_id, parent_id, name) VALUES (v_t, v_b, '__t_c') RETURNING id INTO v_c;
  EXCEPTION WHEN others THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '341: depth cap did not fire at level 4'; END IF;

  -- a cycle must fail
  v_ok := false;
  BEGIN
    UPDATE knowledge_collections SET parent_id = v_b WHERE id = v_a;
  EXCEPTION WHEN others THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '341: cycle guard did not fire'; END IF;

  -- a Space with a parent must fail
  v_ok := false;
  BEGIN
    INSERT INTO knowledge_collections (tenant_id, parent_id, name, is_space) VALUES (v_t, v_space, '__t_bad', true);
  EXCEPTION WHEN others THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION '341: a Space was allowed to have a parent'; END IF;

  DELETE FROM knowledge_collections WHERE name IN ('__t_a','__t_b','__t_c');
  RAISE NOTICE '341: depth, cycle and root guards all verified';
END $assert$;

NOTIFY pgrst, 'reload schema';
