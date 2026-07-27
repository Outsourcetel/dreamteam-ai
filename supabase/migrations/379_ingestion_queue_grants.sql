-- 379_ingestion_queue_grants.sql
-- ============================================================================
-- Nobody can read their own import queue. The tables have RLS and a correct
-- read policy — and no GRANT, so the policy is never reached.
--
-- Reproduced as a real signed-in workspace owner:
--   knowledge_ingestion_jobs  -> permission denied for table   (SQLSTATE 42501)
--   knowledge_ingestion_items -> permission denied for table   (SQLSTATE 42501)
--   auth_tenant_id()          -> 255b931d-...  (correct — the user was fine)
--
-- 42501 is a PRIVILEGE error, not an RLS one. Postgres checks the table GRANT
-- first; with no SELECT privilege the policy `tenant_id = auth_tenant_id()`
-- never runs. Migration 347 created these tables with RLS and a policy and
-- never granted anything, and nothing noticed because the queue had never been
-- exercised by a real user until tonight.
--
-- ── EVERY SYMPTOM CHASED TONIGHT TRACES HERE ───────────────────────────────
-- The import genuinely worked the whole time — discovery ranked, the job and its
-- items were created correctly — but every READ-BACK came home empty, and each
-- empty read was reported as something else entirely:
--   · "tenant mismatch while queueing the import" — a job that could not be READ
--     reported as tenants disagreeing. They never disagreed.
--   · "queued: 0" while the queue held exactly max_pages items.
--   · the in-flight idempotency guard NEVER FIRED: three consecutive imports of
--     basecamp.com each created a new job, because the guard's own read was
--     denied and an empty result reads as "nothing in flight".
-- Three different wrong stories from one missing GRANT. Worth remembering next
-- time a read returns nothing: check the privilege before the predicate.
--
-- SELECT only. Writes go through create_ingestion_job (SECURITY DEFINER, which
-- enforces the contributor gate) and the drain runs as the service role, so
-- granting anything beyond read here would widen the surface for no reason.
-- RLS still scopes what SELECT returns to the caller's own tenant.
-- ============================================================================

GRANT SELECT ON public.knowledge_ingestion_jobs  TO authenticated;
GRANT SELECT ON public.knowledge_ingestion_items TO authenticated;

-- anon must NOT read the queue: signup is open, so anon is the internet.
REVOKE ALL ON public.knowledge_ingestion_jobs  FROM anon;
REVOKE ALL ON public.knowledge_ingestion_items FROM anon;

DO $assert$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_missing
    FROM (VALUES ('knowledge_ingestion_jobs'), ('knowledge_ingestion_items')) AS x(t)
   WHERE NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '379: authenticated still cannot SELECT: %', v_missing;
  END IF;

  SELECT string_agg(t, ', ') INTO v_missing
    FROM (VALUES ('knowledge_ingestion_jobs'), ('knowledge_ingestion_items')) AS x(t)
   WHERE has_table_privilege('anon', 'public.' || t, 'SELECT');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '379: anon can read the queue: %', v_missing;
  END IF;

  -- The grant is only safe because RLS scopes it. If the policy ever goes, this
  -- turns into a cross-tenant read of every workspace's import history.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.knowledge_ingestion_items'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_policy p
                     WHERE p.polrelid = 'public.knowledge_ingestion_items'::regclass) THEN
    RAISE EXCEPTION '379: granting SELECT without RLS+policy would expose every tenant''s queue';
  END IF;

  RAISE NOTICE '379: the import queue is readable by its own tenant, and by nobody else';
END $assert$;

NOTIFY pgrst, 'reload schema';
