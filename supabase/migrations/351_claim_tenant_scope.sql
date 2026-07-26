-- 351_claim_tenant_scope.sql
-- ============================================================================
-- Make the ingestion claim tenant-aware, before the worker ships.
--
-- 347's claim_ingestion_items(p_limit) claims the oldest due items across ALL
-- workspaces. The drain worker accepts an optional tenant_id (the dispatcher
-- can pass one, and a "retry this workspace now" button would), and was
-- filtering the claimed batch in TypeScript AFTER the claim.
--
-- That strands work. Claiming flips a row to 'running' and consumes an attempt.
-- Items belonging to other workspaces would be claimed, discarded by the
-- filter, and left sitting in 'running' until reap_stale_ingestion_items()
-- rescues them thirty minutes later — having burned an attempt for nothing.
-- With max_attempts = 3, three tenant-scoped drains could exhaust an unrelated
-- workspace's retries and mark its import failed without ever having touched it.
--
-- The filter belongs inside the claim, where SKIP LOCKED can see it. Caught by
-- reading my own worker back before deploying it; no rows were harmed.
-- ============================================================================

DROP FUNCTION IF EXISTS public.claim_ingestion_items(int);

CREATE OR REPLACE FUNCTION public.claim_ingestion_items(
  p_limit int DEFAULT 10, p_tenant_id uuid DEFAULT NULL)
RETURNS SETOF knowledge_ingestion_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'claim_ingestion_items is not callable by tenant users';
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT i.id FROM knowledge_ingestion_items i
     WHERE i.status = 'queued'
       AND i.next_attempt_at <= now()
       AND (p_tenant_id IS NULL OR i.tenant_id = p_tenant_id)
     ORDER BY i.next_attempt_at
     LIMIT greatest(1, p_limit)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE knowledge_ingestion_items i
     SET status = 'running', attempts = i.attempts + 1, updated_at = now()
    FROM picked p WHERE i.id = p.id
  RETURNING i.*;
END $fn$;
REVOKE ALL ON FUNCTION public.claim_ingestion_items(int, uuid) FROM public, anon, authenticated;

-- ── Prove the scoping, and that it still claims ────────────────────────────
DO $assert$
DECLARE
  v_a uuid; v_b uuid; v_job_a uuid; v_job_b uuid; v_n int; v_status text;
BEGIN
  SELECT id INTO v_a FROM tenants ORDER BY created_at LIMIT 1;
  SELECT id INTO v_b FROM tenants WHERE id <> v_a ORDER BY created_at LIMIT 1;
  IF v_b IS NULL THEN RAISE EXCEPTION '351: need two workspaces to prove scoping'; END IF;

  INSERT INTO knowledge_ingestion_jobs (tenant_id, label, source_kind)
  VALUES (v_a, '__scope_a', 'paste') RETURNING id INTO v_job_a;
  INSERT INTO knowledge_ingestion_jobs (tenant_id, label, source_kind)
  VALUES (v_b, '__scope_b', 'paste') RETURNING id INTO v_job_b;
  INSERT INTO knowledge_ingestion_items (job_id, tenant_id, source_ref) VALUES (v_job_a, v_a, 'a.txt');
  INSERT INTO knowledge_ingestion_items (job_id, tenant_id, source_ref) VALUES (v_job_b, v_b, 'b.txt');

  -- A tenant-scoped claim must take ONLY that workspace's item.
  SELECT count(*) INTO v_n FROM public.claim_ingestion_items(10, v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION '351: scoped claim returned % items, expected 1', v_n; END IF;

  -- And the other workspace's item must be untouched — still queued, no attempt spent.
  SELECT status INTO v_status FROM knowledge_ingestion_items WHERE job_id = v_job_b;
  IF v_status <> 'queued' THEN
    RAISE EXCEPTION '351: an unrelated workspace''s item was claimed and left %', v_status;
  END IF;
  IF (SELECT attempts FROM knowledge_ingestion_items WHERE job_id = v_job_b) <> 0 THEN
    RAISE EXCEPTION '351: an unrelated workspace''s item had an attempt consumed';
  END IF;

  -- An unscoped claim still sweeps everything.
  SELECT count(*) INTO v_n FROM public.claim_ingestion_items(10, NULL);
  IF v_n <> 1 THEN RAISE EXCEPTION '351: unscoped claim returned % items, expected the remaining 1', v_n; END IF;

  DELETE FROM knowledge_ingestion_jobs WHERE id IN (v_job_a, v_job_b);
  RAISE NOTICE '351: claim is tenant-scoped and no longer strands other workspaces';
END $assert$;

NOTIFY pgrst, 'reload schema';
