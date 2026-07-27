-- 382_drop_export_pager_overload.sql
-- ============================================================================
-- The export returned 200 with rows_exported: 0 because the RPC never ran.
--
--   Could not choose the best candidate function between:
--     public.export_tenant_table_page(p_tenant, p_table, p_cursor, p_limit)
--     public.export_tenant_table_page(p_tenant, p_table, p_cursor, p_limit, p_session)
--
-- Migration 377 added p_session WITH A DEFAULT and did not drop the 4-argument
-- original, so both matched a 4-argument call and PostgREST refused to pick.
-- EVERY table failed this way. The failures were reported honestly per-table in
-- the stream — the archive was never silently wrong — but the summary line said
-- 200/complete:false, which reads as "finished with problems" rather than
-- "nothing was exported at all".
--
-- ⚠ CREATE OR REPLACE DOES NOT REPLACE ACROSS ARITIES. Adding a defaulted
-- parameter creates a SECOND function; it does not amend the first. Any later
-- change of this shape needs an explicit DROP of the old signature, or callers
-- get an ambiguity error rather than the new behaviour.
--
-- Migration 381 restored the paging contract this pager had lost; without this
-- drop, that restored function was still unreachable.
-- ============================================================================

DROP FUNCTION IF EXISTS public.export_tenant_table_page(uuid, text, jsonb, int);

DO $assert$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'export_tenant_table_page';

  IF v_n <> 1 THEN
    RAISE EXCEPTION '382: expected exactly ONE export_tenant_table_page, found % — an ambiguous call will fail again', v_n;
  END IF;

  IF (SELECT pg_get_function_arguments(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'export_tenant_table_page') NOT LIKE '%p_session%' THEN
    RAISE EXCEPTION '382: the surviving pager is the OLD one — 381''s restored version was dropped instead';
  END IF;

  RAISE NOTICE '382: one pager remains, the one with p_session and the restored contract';
END $assert$;

NOTIFY pgrst, 'reload schema';
