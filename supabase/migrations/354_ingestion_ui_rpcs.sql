-- 354_ingestion_ui_rpcs.sql
-- ============================================================================
-- The two reads/writes the ingestion UI needs and 347/350 did not provide.
--
-- list_ingestion_jobs() already exists and answers "what imports have run".
-- A human looking at "3 failed" immediately needs two more things:
--   · WHICH three, and what exactly went wrong with each
--   · a way to try again once they have fixed it
-- Without those, the failure count is an accusation with no recourse — which is
-- the failure mode the module truth audits keep finding.
-- ============================================================================

-- ── 1. Drill-down ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_ingestion_items(p_job_id uuid)
RETURNS TABLE (id uuid, source_ref text, title text, status text,
               attempts int, max_attempts int, error_kind text, last_error text,
               next_attempt_at timestamptz, doc_id uuid, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT i.id, i.source_ref, i.title, i.status, i.attempts, i.max_attempts,
         i.error_kind, i.last_error, i.next_attempt_at, i.doc_id, i.updated_at
    FROM knowledge_ingestion_items i
    JOIN knowledge_ingestion_jobs j ON j.id = i.job_id
   WHERE i.job_id = p_job_id
     AND j.tenant_id = auth_tenant_id()          -- tenant gate on the JOB, not the argument
   ORDER BY
     -- Failures first: the whole reason someone opened this.
     CASE i.status WHEN 'failed' THEN 0 WHEN 'queued' THEN 1 WHEN 'running' THEN 2 ELSE 3 END,
     i.updated_at DESC;
$fn$;
REVOKE ALL ON FUNCTION public.list_ingestion_items(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_ingestion_items(uuid) TO authenticated;

-- ── 2. Retry ───────────────────────────────────────────────────────────────
-- Only RETRYABLE failures are re-queued. A terminal failure — an unreadable
-- PDF, a URL that does not exist, an unsupported file type — will fail exactly
-- the same way, and a retry button that silently re-fails is worse than one
-- that tells you it cannot help. The count of skipped terminals is returned so
-- the UI can say so plainly.
CREATE OR REPLACE FUNCTION public.retry_ingestion_job(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_lvl int; v_retried int; v_terminal int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_ingestion_jobs WHERE id = p_job_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'job_not_found';
  END IF;

  -- Retrying creates documents, so it needs the same right as creating the job.
  SELECT coalesce(max(knowledge_permission_rank(g.permission)), 0) INTO v_lvl
    FROM knowledge_access_grants g
   WHERE g.tenant_id = v_tenant AND g.resource_type = 'workspace'
     AND knowledge_grant_matches_caller(g);
  IF v_lvl < 2 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: retrying an import requires contributor';
  END IF;

  SELECT count(*) INTO v_terminal FROM knowledge_ingestion_items
   WHERE job_id = p_job_id AND status = 'failed' AND error_kind = 'terminal';

  UPDATE knowledge_ingestion_items
     SET status = 'queued', attempts = 0, next_attempt_at = now(),
         last_error = NULL, error_kind = NULL, updated_at = now()
   WHERE job_id = p_job_id AND status = 'failed' AND error_kind IS DISTINCT FROM 'terminal';
  GET DIAGNOSTICS v_retried = ROW_COUNT;

  -- Reopen the job so the rollup can close it again honestly.
  IF v_retried > 0 THEN
    UPDATE knowledge_ingestion_jobs
       SET status = 'running', finished_at = NULL
     WHERE id = p_job_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'retried', v_retried, 'not_retryable', v_terminal);
END $fn$;
REVOKE ALL ON FUNCTION public.retry_ingestion_job(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.retry_ingestion_job(uuid) TO authenticated;

-- ── 3. Prove it ────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_t uuid; v_job uuid; v_r uuid; v_term uuid; v_res jsonb; v_n int;
BEGIN
  SELECT id INTO v_t FROM tenants LIMIT 1;
  INSERT INTO knowledge_ingestion_jobs (tenant_id, label, source_kind, status)
  VALUES (v_t, '__retry_test', 'url', 'completed_with_errors') RETURNING id INTO v_job;

  INSERT INTO knowledge_ingestion_items (job_id, tenant_id, source_ref, status, attempts, error_kind, last_error)
  VALUES (v_job, v_t, 'https://flaky.example/a', 'failed', 3, 'retryable', 'connection reset')
  RETURNING id INTO v_r;
  INSERT INTO knowledge_ingestion_items (job_id, tenant_id, source_ref, status, attempts, error_kind, last_error)
  VALUES (v_job, v_t, 'broken.pdf', 'failed', 1, 'terminal', 'that PDF could not be read')
  RETURNING id INTO v_term;

  -- The RPC itself cannot be called here: it requires auth_tenant_id(), and this
  -- runner has a NULL auth.uid(). Forging an identity to get past an
  -- authorisation gate would prove nothing about the gate. So the GUARDS are
  -- asserted from the definition, and the SELECTION LOGIC — the part that
  -- decides what gets retried, which is where a bug would actually live — is
  -- executed directly against real rows.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='retry_ingestion_job' LIMIT 1)
     !~ 'insufficient_permission' THEN
    RAISE EXCEPTION '354: retry_ingestion_job has no permission gate';
  END IF;

  SELECT count(*) INTO v_n FROM knowledge_ingestion_items
   WHERE job_id = v_job AND status='failed' AND error_kind = 'terminal';
  IF v_n <> 1 THEN RAISE EXCEPTION '354: test fixture wrong'; END IF;

  -- The exact predicate the RPC uses.
  UPDATE knowledge_ingestion_items
     SET status='queued', attempts=0, next_attempt_at=now(), last_error=NULL, error_kind=NULL, updated_at=now()
   WHERE job_id = v_job AND status='failed' AND error_kind IS DISTINCT FROM 'terminal';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '354: expected 1 retryable item re-queued, got %', v_n;
  END IF;

  -- The retryable one is back in the queue with a clean slate...
  IF (SELECT status FROM knowledge_ingestion_items WHERE id = v_r) <> 'queued'
     OR (SELECT attempts FROM knowledge_ingestion_items WHERE id = v_r) <> 0 THEN
    RAISE EXCEPTION '354: the retryable item was not re-queued cleanly';
  END IF;
  -- ...and the terminal one is deliberately left alone.
  IF (SELECT status FROM knowledge_ingestion_items WHERE id = v_term) <> 'failed' THEN
    RAISE EXCEPTION '354: a terminal failure was re-queued and would just fail again';
  END IF;

  -- Drill-down runs (auth_tenant_id() is NULL here, so it returns nothing —
  -- that is the tenant gate working, not a fault).
  SELECT count(*) INTO v_n FROM public.list_ingestion_items(v_job);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '354: list_ingestion_items returned rows to a caller with no workspace';
  END IF;

  DELETE FROM knowledge_ingestion_jobs WHERE id = v_job;
  RAISE NOTICE '354: retry re-queues retryable failures only; terminals are left and reported';
END $assert$;

NOTIFY pgrst, 'reload schema';
