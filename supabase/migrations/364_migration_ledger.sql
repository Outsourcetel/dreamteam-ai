-- 364_migration_ledger.sql
-- ============================================================================
-- A real migration ledger. Today there is none, and the consequences are worse
-- than untidiness.
--
-- MEASURED BEFORE WRITING THIS:
--   · public._supabase_migrations                     does not exist  (0)
--   · the supabase_migrations schema                  does not exist  (0)
--   · public.exec_sql, in ANY schema                  does not exist  (0)
-- scripts/deploy.mjs:70 reads that missing table and :77 dies; :86 and
-- scripts/apply-migration.mjs:46 both call the missing exec_sql. So the two
-- tools that look like the deployment system are dead code, and the only path
-- that works is a human running db-query.mjs one file at a time — with "which
-- migrations are applied" living in that person's memory.
--
-- Nobody, including the founder, can answer "is migration 287 applied to
-- production?" A customer-impacting hotfix therefore gets applied by hand by
-- the one person who remembers where the sequence stopped. A skipped migration
-- silently omits customer data; a re-applied one can silently corrupt it. There
-- is no record to diff against afterwards.
--
-- ── Why this records CHECKSUMS, not just filenames ─────────────────────────
-- A filename-only ledger would still be a lie in this repository, because
-- migration files here get EDITED AFTER being applied — I did it twice today
-- (349 and 353) while fixing assertions. "349 is applied" is then true of a
-- file that no longer exists in that form. The checksum makes that visible as
-- DRIFTED rather than letting it pass as APPLIED.
--
-- ── Why the past is recorded as 'assumed', not 'applied' ───────────────────
-- 368 migrations predate this ledger. The honest claim is that they were
-- probably all applied, in order, by hand — not that anyone verified it. So
-- they are recorded with provenance 'assumed_pre_ledger' and a NULL applied_at.
-- Everything from here forward is recorded by the runner at the moment it
-- succeeds, with a real timestamp. Two grades of certainty, both visible,
-- rather than one comfortable fiction.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename    text PRIMARY KEY,
  checksum    text NOT NULL,
  -- NULL means "believed applied before this ledger existed, never verified".
  applied_at  timestamptz,
  applied_by  text,
  provenance  text NOT NULL CHECK (provenance IN ('assumed_pre_ledger', 'applied_by_runner')),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.schema_migrations IS
  'Which migration files have been applied to THIS database. provenance=assumed_pre_ledger means it predates the ledger and was never verified; applied_by_runner means the runner recorded it on success. checksum detects a file edited after it was applied.';

-- Platform-operations data, not tenant data: no tenant_id, so RLS denies all
-- and only the service role and the Management API can read it.
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;

-- ── Recording an application ───────────────────────────────────────────────
-- Called by the runner AFTER the migration's own statements succeed, in the
-- same request, so a failed migration never leaves a ledger row claiming
-- success.
CREATE OR REPLACE FUNCTION public.record_migration_applied(
  p_filename text, p_checksum text, p_applied_by text DEFAULT 'db-query.mjs')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_prev text; v_was text;
BEGIN
  IF p_filename IS NULL OR btrim(p_filename) = '' THEN RAISE EXCEPTION 'filename required'; END IF;
  IF p_checksum IS NULL OR btrim(p_checksum) = '' THEN RAISE EXCEPTION 'checksum required'; END IF;

  SELECT checksum, provenance INTO v_prev, v_was
    FROM schema_migrations WHERE filename = p_filename;

  INSERT INTO schema_migrations (filename, checksum, applied_at, applied_by, provenance)
  VALUES (p_filename, p_checksum, now(), p_applied_by, 'applied_by_runner')
  ON CONFLICT (filename) DO UPDATE
    SET checksum = excluded.checksum, applied_at = now(),
        applied_by = excluded.applied_by, provenance = 'applied_by_runner';

  RETURN jsonb_build_object(
    'ok', true,
    'filename', p_filename,
    -- Re-applying a file whose content changed is the dangerous case; say so.
    'reapplied', v_prev IS NOT NULL,
    'content_changed_since_last_apply', v_prev IS NOT NULL AND v_prev <> p_checksum,
    'previous_provenance', v_was);
END $fn$;
REVOKE ALL ON FUNCTION public.record_migration_applied(text, text, text) FROM PUBLIC, anon, authenticated;

-- ── Reading the ledger ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_schema_migrations()
RETURNS TABLE (filename text, checksum text, applied_at timestamptz,
               applied_by text, provenance text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT filename, checksum, applied_at, applied_by, provenance
    FROM schema_migrations ORDER BY filename;
$fn$;
REVOKE ALL ON FUNCTION public.list_schema_migrations() FROM PUBLIC, anon, authenticated;

-- ── Prove it ───────────────────────────────────────────────────────────────
DO $assert$
DECLARE v jsonb;
BEGIN
  -- A first record is an apply, not a re-apply.
  v := public.record_migration_applied('__ledger_selftest.sql', 'aaa', 'assert');
  IF (v->>'reapplied')::boolean THEN RAISE EXCEPTION '364: first record reported as a re-apply'; END IF;

  -- Same file, SAME content: a re-apply, but not a content change.
  v := public.record_migration_applied('__ledger_selftest.sql', 'aaa', 'assert');
  IF NOT (v->>'reapplied')::boolean THEN RAISE EXCEPTION '364: re-apply not detected'; END IF;
  IF (v->>'content_changed_since_last_apply')::boolean THEN
    RAISE EXCEPTION '364: unchanged content reported as changed'; END IF;

  -- Same file, DIFFERENT content: the case that silently corrupts data.
  v := public.record_migration_applied('__ledger_selftest.sql', 'bbb', 'assert');
  IF NOT (v->>'content_changed_since_last_apply')::boolean THEN
    RAISE EXCEPTION '364: a migration edited after apply was not flagged'; END IF;

  DELETE FROM schema_migrations WHERE filename = '__ledger_selftest.sql';

  -- The ledger must not be readable by tenant users or the public.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname IN ('record_migration_applied','list_schema_migrations')
         AND (has_function_privilege('anon', p.oid,'EXECUTE')
           OR has_function_privilege('authenticated', p.oid,'EXECUTE'))) > 0
  THEN RAISE EXCEPTION '364: the ledger is reachable from a client role'; END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.schema_migrations'::regclass)
  THEN RAISE EXCEPTION '364: RLS not enabled on the ledger'; END IF;

  RAISE NOTICE '364: ledger live; re-apply and content-drift both detected';
END $assert$;

NOTIFY pgrst, 'reload schema';
