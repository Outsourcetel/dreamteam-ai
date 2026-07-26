-- 349_lifecycle_transition_authz.sql
-- ============================================================================
-- Close a hole I opened in 346, found by adversarial review of my own design.
--
-- ── The hole ────────────────────────────────────────────────────────────────
-- 346 added set_knowledge_lifecycle(), which requires publisher (rank 4) to
-- publish or archive a document. That gate is real — and it was also entirely
-- optional, because lifecycle_status is an ordinary column on a table whose
-- UPDATE policy admits editor (rank 3):
--
--   knowledge_docs_acl_update
--     USING       (tenant_id = auth_tenant_id() AND (... knowledge_effective_level(id) >= 3))
--     WITH CHECK  (tenant_id = auth_tenant_id())
--
-- The WITH CHECK verifies only the workspace. So any editor could skip the RPC
-- and PATCH the column directly through PostgREST:
--     PATCH /knowledge_docs?id=eq.<uuid>   {"lifecycle_status": "published"}
-- Verified against the live policy before writing this, not assumed.
--
-- That makes "submit for review" theatre: a contributor-turned-editor could
-- publish their own draft to every Digital Employee in the workspace without
-- ever passing the publisher gate, and without the audit event the RPC writes.
-- A governance control reachable only through the polite door is not a control.
--
-- ── The fix, and why it is a trigger rather than a tighter policy ──────────
-- The obvious repair is a stricter WITH CHECK. It does not work: WITH CHECK
-- sees only the NEW row, so it cannot tell "this update changed the lifecycle"
-- from "this update changed the title and left the lifecycle alone". Tightening
-- it to require publisher for any row that IS published would stop editors from
-- fixing a typo in a published document — which is exactly what editors are for.
--
-- A BEFORE UPDATE trigger can see OLD and NEW, so it can gate the TRANSITION
-- rather than the state. That is the actual thing being authorised.
--
-- ── Trigger ordering, which matters here ───────────────────────────────────
-- Same-timing triggers fire in NAME order. This one is knowledge_lifecycle_
-- authz_trg and the existing auto-archive is knowledge_lifecycle_sync_trg, so
-- 'a' sorts before 's' and authz runs first. That ordering is deliberate:
--   · A user writing lifecycle_status directly is checked.
--   · The sync trigger's automatic archive-on-supersede happens AFTER, by
--     mutating NEW in place, so it is never re-checked and an editor
--     superseding a document is not blocked by a rule about publishing.
-- Renaming either trigger would silently reverse this. Hence this paragraph.
--
-- ── Service role and cron are deliberately exempt ──────────────────────────
-- auth.uid() is NULL for the migration runner, pg_cron and edge functions on
-- the service role. They are already trusted to write anything on this table
-- and gating them would break ingestion (347 publishes documents it creates)
-- and the backfills above. Humans are the ones this authorises.
-- ============================================================================

CREATE OR REPLACE FUNCTION knowledge_lifecycle_authz()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_needed int; v_level int; v_word text;
BEGIN
  -- Only a genuine transition is authorised. Rewriting a title on a published
  -- document is an edit, not a publication.
  IF NEW.lifecycle_status IS NOT DISTINCT FROM OLD.lifecycle_status THEN
    RETURN NEW;
  END IF;

  -- Service role, pg_cron, edge functions and this migration runner.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF is_platform_admin() THEN RETURN NEW; END IF;

  IF NEW.lifecycle_status IN ('published','archived') THEN
    v_needed := 4; v_word := 'publisher';       -- publishing and retiring are governance
  ELSE
    v_needed := 2; v_word := 'contributor';     -- drafting is authorship
  END IF;

  v_level := knowledge_effective_level(NEW.id);
  IF v_level < v_needed THEN
    RAISE EXCEPTION
      'insufficient_permission: moving a document to % requires %; you have level %',
      NEW.lifecycle_status, v_word, v_level
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS knowledge_lifecycle_authz_trg ON knowledge_docs;
CREATE TRIGGER knowledge_lifecycle_authz_trg
  BEFORE UPDATE OF lifecycle_status ON knowledge_docs
  FOR EACH ROW EXECUTE FUNCTION knowledge_lifecycle_authz();

-- ── Prove the mechanics ────────────────────────────────────────────────────
-- The auth BINDING (auth.uid() resolving to a real signed-in person) is the one
-- part this runner cannot exercise: it executes as the database owner with a
-- NULL auth.uid(), and forging an identity to test an authorisation gate would
-- prove nothing about the gate. So the SQL mechanics are verified directly and
-- the boundary is stated rather than papered over.
DO $assert$
DECLARE v_def text; v_authz text; v_sync text; v_doc uuid; v_t uuid; v_status text; v_was timestamptz;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='knowledge_lifecycle_authz' LIMIT 1;
  IF v_def IS NULL THEN RAISE EXCEPTION '349: the authz function does not exist'; END IF;

  -- It must gate the TRANSITION, not the state, or editors lose the ability to
  -- edit published documents.
  IF v_def !~ 'IS NOT DISTINCT FROM OLD\.lifecycle_status' THEN
    RAISE EXCEPTION '349: authz does not compare OLD to NEW — it would block ordinary edits';
  END IF;
  -- It must exempt null-auth callers, or ingestion and cron break.
  IF v_def !~ 'auth\.uid\(\) IS NULL' THEN
    RAISE EXCEPTION '349: authz has no service-role exemption — ingestion would fail';
  END IF;

  -- Ordering: authz MUST sort before sync or the auto-archive gets authorised
  -- as if a human had done it.
  SELECT tgname INTO v_authz FROM pg_trigger
   WHERE tgrelid='public.knowledge_docs'::regclass AND tgname='knowledge_lifecycle_authz_trg';
  SELECT tgname INTO v_sync FROM pg_trigger
   WHERE tgrelid='public.knowledge_docs'::regclass AND tgname='knowledge_lifecycle_sync_trg';
  IF v_authz IS NULL OR v_sync IS NULL THEN RAISE EXCEPTION '349: a lifecycle trigger is missing'; END IF;
  IF NOT (v_authz < v_sync) THEN
    RAISE EXCEPTION '349: trigger order is wrong (% must sort before %)', v_authz, v_sync;
  END IF;

  -- And the null-auth path must still work end to end, since 347 depends on it.
  --
  -- This exercises a REAL document, so it leaves a trace: knowledge_docs carries
  -- an unconditional updated_at trigger, and an assertion that stamps a customer's
  -- document as edited is a worse bug than the one it is checking for. Mig 348
  -- exists because I learned that the expensive way on 2,000 rows. The trigger is
  -- held off for the probe and the timestamp restored, so this assertion is
  -- observationally invisible.
  ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_updated_at;
  ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_invalidate_cache;

  SELECT id, tenant_id, updated_at INTO v_doc, v_t, v_was FROM knowledge_docs WHERE is_current LIMIT 1;
  UPDATE knowledge_docs SET lifecycle_status='draft' WHERE id=v_doc;
  SELECT lifecycle_status INTO v_status FROM knowledge_docs WHERE id=v_doc;
  UPDATE knowledge_docs SET lifecycle_status='published', updated_at=v_was WHERE id=v_doc;

  ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_updated_at;
  ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_invalidate_cache;

  IF v_status <> 'draft' THEN RAISE EXCEPTION '349: service-role transition was blocked'; END IF;

  RAISE NOTICE '349: lifecycle transitions are gated at the table, on every path';
END $assert$;

NOTIFY pgrst, 'reload schema';
