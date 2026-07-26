-- 355_lifecycle_roundtrip_fix.sql
-- ============================================================================
-- Fix a regression 346 introduced, found by the adversarial review of my own
-- design and then verified directly against the live definitions.
--
-- ── The regression ─────────────────────────────────────────────────────────
-- 346 assumed is_current means one thing: "this is the newest version of this
-- lineage". It does not. Shipped code uses it for a SECOND meaning — "this
-- document is live" — with no version chain involved at all:
--
--   retire_playbook_knowledge()  (trigger on playbooks)
--     when a playbook is archived:
--       update knowledge_docs set is_current = false
--        where external_ref = 'playbook:' || new.id
--     No successor row. No previous_version_id. It is an ARCHIVE, expressed
--     through the version flag.
--
--   playbook-execute/index.ts:722  (re-publish)
--     update knowledge_docs set title, content, is_current: true, tags
--     The same flag flipped back to bring the document live again.
--
-- 346's sync trigger only ran one way — is_current true->false archives the
-- lifecycle. So the round trip broke:
--     archive   -> is_current=false, lifecycle_status='archived'   (correct)
--     republish -> is_current=true,  lifecycle_status='archived'   (WRONG)
-- and 346 gates retrieval on lifecycle_status='published'. A re-published
-- playbook's knowledge document would have come back as "current" and stayed
-- permanently invisible to every Digital Employee — silently, with no error
-- anywhere, and no way for the customer to tell why the answer got worse.
--
-- ── The fix: make the rule symmetric ───────────────────────────────────────
-- If leaving the current set archives a document, rejoining it un-archives one.
-- Both directions are DERIVED from the same flag, so there is still exactly one
-- writer for the fact and no drift.
--
-- Safe against a deliberate human archive: a person archiving through
-- set_knowledge_lifecycle() sets lifecycle_status and leaves is_current alone,
-- so no false->true transition occurs and nothing is un-archived behind them.
-- The only things that flip is_current back to true are the republish and
-- version-restore paths, which is exactly when un-archiving is correct.
--
-- ── Second defect, same family ─────────────────────────────────────────────
-- apply_knowledge_revision inserts the successor with 8 columns and no
-- lifecycle_status, so it falls to the DEFAULT 'published'. A revision of a
-- DRAFT would therefore publish it — turning "propose an edit" into a way to
-- publish without ever passing the publisher gate. The successor now inherits
-- the source document's lifecycle instead.
-- ============================================================================

-- ── 1. Symmetric sync ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION knowledge_lifecycle_sync()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- Leaving the current set archives a published document (346).
  IF OLD.is_current AND NOT NEW.is_current AND NEW.lifecycle_status = 'published' THEN
    NEW.lifecycle_status := 'archived';
  END IF;

  -- 355: and rejoining it brings the document back. Without this, the
  -- playbook archive/re-publish round trip leaves a live document permanently
  -- unretrievable.
  IF NOT OLD.is_current AND NEW.is_current AND NEW.lifecycle_status = 'archived' THEN
    NEW.lifecycle_status := 'published';
  END IF;

  IF NEW.lifecycle_status = 'published' AND NOT NEW.is_current THEN
    RAISE EXCEPTION 'only the current version of a document can be published';
  END IF;
  RETURN NEW;
END $fn$;

-- ── 2. A revision inherits its source's lifecycle ──────────────────────────
-- Reproduced from the live definition; only the INSERT column list and its
-- matching SELECT expression change.
DO $rewrite$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='apply_knowledge_revision' LIMIT 1;
  IF v_def IS NULL THEN RAISE EXCEPTION '355: apply_knowledge_revision not found'; END IF;
  IF v_def ILIKE '%lifecycle_status%' THEN
    RAISE NOTICE '355: revision already carries lifecycle'; RETURN;
  END IF;

  v_new := replace(v_def,
    'tenant_id, title, content, source, tags, previous_version_id, is_current, visibility' || E'\n  )',
    'tenant_id, title, content, source, tags, previous_version_id, is_current, visibility, lifecycle_status' || E'\n  )');
  v_new := replace(v_new,
    'coalesce((select visibility from knowledge_docs where id = v_req.source_doc_id and tenant_id = v_req.tenant_id), ''tenant'')',
    'coalesce((select visibility from knowledge_docs where id = v_req.source_doc_id and tenant_id = v_req.tenant_id), ''tenant''),' || E'\n' ||
    '    -- 355: a revision of a draft stays a draft. Otherwise "propose an edit"' || E'\n' ||
    '    -- becomes a way to publish without passing the publisher gate.' || E'\n' ||
    '    coalesce((select lifecycle_status from knowledge_docs where id = v_req.source_doc_id and tenant_id = v_req.tenant_id), ''published'')');

  IF v_new = v_def THEN RAISE EXCEPTION '355: could not anchor lifecycle into apply_knowledge_revision'; END IF;
  EXECUTE v_new;
END $rewrite$;

-- ── 3. Prove the round trip, on a real document ────────────────────────────
DO $assert$
DECLARE v_t uuid; v_doc uuid; v_status text; v_cur boolean; v_was timestamptz; v_def text;
BEGIN
  -- Triggers held off so this assertion leaves no trace (mig 348/349's lesson).
  ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_updated_at;
  ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_invalidate_cache;

  SELECT id, tenant_id, updated_at INTO v_doc, v_t, v_was
    FROM knowledge_docs WHERE is_current AND lifecycle_status='published' LIMIT 1;

  -- Archive, exactly the way retire_playbook_knowledge() does it.
  UPDATE knowledge_docs SET is_current = false WHERE id = v_doc;
  SELECT lifecycle_status INTO v_status FROM knowledge_docs WHERE id = v_doc;
  IF v_status <> 'archived' THEN
    RAISE EXCEPTION '355: retiring did not archive (got %)', v_status;
  END IF;

  -- Re-publish, exactly the way playbook-execute does it.
  UPDATE knowledge_docs SET is_current = true WHERE id = v_doc;
  SELECT lifecycle_status, is_current INTO v_status, v_cur FROM knowledge_docs WHERE id = v_doc;
  IF v_status <> 'published' OR NOT v_cur THEN
    RAISE EXCEPTION '355: re-publishing left the document is_current=% lifecycle=% — it would stay invisible to every employee',
      v_cur, v_status;
  END IF;

  UPDATE knowledge_docs SET updated_at = v_was WHERE id = v_doc;
  ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_updated_at;
  ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_invalidate_cache;

  -- A deliberate human archive must NOT be undone by this rule.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='knowledge_lifecycle_sync' LIMIT 1)
     !~ 'NOT OLD\.is_current AND NEW\.is_current' THEN
    RAISE EXCEPTION '355: the un-archive rule is not keyed on the is_current transition';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='apply_knowledge_revision' LIMIT 1;
  IF v_def NOT ILIKE '%lifecycle_status%' THEN
    RAISE EXCEPTION '355: revisions still drop lifecycle — a draft revision would publish itself';
  END IF;

  RAISE NOTICE '355: archive/re-publish round trip restores retrievability; revisions inherit lifecycle';
END $assert$;

NOTIFY pgrst, 'reload schema';
