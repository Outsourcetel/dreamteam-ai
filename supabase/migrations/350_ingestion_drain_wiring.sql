-- 350_ingestion_drain_wiring.sql
-- ============================================================================
-- Wire the 347 ingestion queue to something that actually drains it.
--
-- 347 shipped the tables, the retry classification and the RPCs, and nothing
-- consumed them. A queue with no drainer is a list. This adds the four things
-- that turn it into a worker: somewhere to put content, a publish mode, a
-- duplicate check that cannot disagree with the database, and the pg_cron
-- dispatcher that fires the edge function.
--
-- ── Following the house dispatcher idiom exactly ───────────────────────────
-- Read from the live invoke_conflict_probe_drain() before writing this:
--   · SECURITY DEFINER, search_path 'public','extensions'
--   · project ANON jwt in the Authorization header, because the edge gateway's
--     verify_jwt is what that satisfies — the REAL auth is x-dispatch-secret,
--     read from vault.decrypted_secrets and checked inside the function
--   · net.http_post with an explicit timeout, returning 'dispatched:<req_id>'
--   · returns a sentinel instead of raising when the secret is missing, so a
--     cron tick never turns into a failed job
-- Same shape here. A drainer that invents its own auth story is a drainer
-- nobody can reason about later.
-- ============================================================================

-- ── 1. Somewhere to put the content ────────────────────────────────────────
-- The queue's real value is work that is SLOW OR FLAKY and therefore worth
-- retrying: fetching a URL, re-importing a connector folder, re-chunking.
-- A browser upload already extracts text client-side through extract-document,
-- so the item carries the extracted text and the queue gives the chunk/embed
-- half of that flow the same retry safety.
ALTER TABLE knowledge_ingestion_items ADD COLUMN IF NOT EXISTS raw_content text;
COMMENT ON COLUMN knowledge_ingestion_items.raw_content IS
  'Text already in hand at enqueue time (paste, or a client-side extraction). NULL for url/connector items, whose content the worker fetches itself.';

-- ── 2. Publish straight through, or land as drafts for review ──────────────
-- Directly uses the 346 lifecycle. Default 'published' preserves the behaviour
-- every existing path has: a document you add is immediately answerable.
-- A workspace that wants review-before-answer sets 'draft' per job.
ALTER TABLE knowledge_ingestion_jobs ADD COLUMN IF NOT EXISTS publish_mode text NOT NULL DEFAULT 'published';
ALTER TABLE knowledge_ingestion_jobs DROP CONSTRAINT IF EXISTS knowledge_ingestion_jobs_publish_mode_check;
ALTER TABLE knowledge_ingestion_jobs ADD CONSTRAINT knowledge_ingestion_jobs_publish_mode_check
  CHECK (publish_mode IN ('published','draft'));

-- ── 3. Duplicate detection that cannot disagree with the trigger ───────────
-- The worker must ask "have we already got this?" before creating a document.
-- Computing the hash in TypeScript would mean two implementations of one fact,
-- and the day they diverge dedupe silently stops working. So Postgres computes
-- it, using the identical expression as the 347 trigger.
CREATE OR REPLACE FUNCTION public.find_duplicate_knowledge_doc(
  p_tenant_id uuid, p_title text, p_content text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT d.id FROM knowledge_docs d
   WHERE d.tenant_id = p_tenant_id
     AND d.is_current
     AND d.content_hash = md5(coalesce(p_title,'') || E'\n' || coalesce(p_content,''))
   LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION public.find_duplicate_knowledge_doc(uuid, text, text) FROM public, anon, authenticated;

-- ── 4. create_ingestion_job carries content and publish mode ───────────────
-- Reproduced from 347 with two fields added; the permission gate is unchanged.
CREATE OR REPLACE FUNCTION public.create_ingestion_job(
  p_label text, p_source_kind text, p_items jsonb,
  p_target_collection_id uuid DEFAULT NULL, p_source_ref text DEFAULT NULL,
  p_connector_id uuid DEFAULT NULL, p_publish_mode text DEFAULT 'published')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_job uuid; v_n int; v_lvl int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_publish_mode NOT IN ('published','draft') THEN
    RAISE EXCEPTION 'publish mode must be published or draft';
  END IF;

  SELECT coalesce(max(knowledge_permission_rank(g.permission)), 0) INTO v_lvl
    FROM knowledge_access_grants g
   WHERE g.tenant_id = v_tenant AND g.resource_type = 'workspace'
     AND knowledge_grant_matches_caller(g);
  IF v_lvl < 2 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: adding knowledge requires contributor';
  END IF;
  -- Publishing straight through is a publisher act. A contributor may still
  -- import — their work lands as drafts, which is exactly the review flow.
  IF p_publish_mode = 'published' AND v_lvl < 4 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: publishing on import requires publisher — import as draft instead';
  END IF;

  IF p_target_collection_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM knowledge_collections c
                      WHERE c.id = p_target_collection_id AND c.tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'target collection does not belong to this workspace';
  END IF;

  INSERT INTO knowledge_ingestion_jobs (tenant_id, label, source_kind, source_ref,
                                        target_collection_id, connector_id, created_by, publish_mode)
  VALUES (v_tenant, p_label, p_source_kind, p_source_ref,
          p_target_collection_id, p_connector_id, auth.uid(), p_publish_mode)
  RETURNING id INTO v_job;

  INSERT INTO knowledge_ingestion_items (job_id, tenant_id, source_ref, title, byte_size, mime_type, raw_content)
  SELECT v_job, v_tenant,
         coalesce(e->>'source_ref', e->>'url', e->>'filename', 'item'),
         e->>'title', (e->>'byte_size')::bigint, e->>'mime_type', e->>'content'
    FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'an ingestion job needs at least one item'; END IF;
  RETURN v_job;
END $fn$;
REVOKE ALL ON FUNCTION public.create_ingestion_job(text, text, jsonb, uuid, text, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_ingestion_job(text, text, jsonb, uuid, text, uuid, text) TO authenticated;
-- Drop the 347 six-argument version so the two cannot both resolve.
DROP FUNCTION IF EXISTS public.create_ingestion_job(text, text, jsonb, uuid, text, uuid);

-- ── 5. The dispatcher ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.invoke_knowledge_ingest_drain(p_tenant_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_secret text;
  v_req_id bigint;
  v_body   jsonb;
  v_due    int;
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
BEGIN
  -- Reap first. An item abandoned by a worker that died mid-flight would
  -- otherwise hold its slot forever and never appear in the due count.
  PERFORM public.reap_stale_ingestion_items();

  -- Don't wake the edge function for an empty queue. This runs every 2 minutes
  -- across 16 workspaces that will usually have nothing to do; a cheap indexed
  -- count is the difference between a free tick and 720 pointless invocations
  -- a day.
  SELECT count(*) INTO v_due FROM knowledge_ingestion_items
   WHERE status = 'queued' AND next_attempt_at <= now();
  IF v_due = 0 THEN RETURN 'idle'; END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN RETURN 'no_secret'; END IF;

  v_body := jsonb_build_object('limit', 10);
  IF p_tenant_id IS NOT NULL THEN v_body := v_body || jsonb_build_object('tenant_id', p_tenant_id); END IF;

  SELECT net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/knowledge-ingest-drain',
    body    := v_body,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_anon,
                                  'x-dispatch-secret', v_secret),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  RETURN 'dispatched:' || v_req_id || ' due:' || v_due;
END $fn$;
REVOKE ALL ON FUNCTION public.invoke_knowledge_ingest_drain(uuid) FROM public, anon, authenticated;

-- ── 6. Schedule it ─────────────────────────────────────────────────────────
-- Every 2 minutes, matching embed-backfill-drain and knowledge-reembed-drain.
-- Ingestion is something a human is watching a progress bar for, so a 2-minute
-- worst case is the right responsiveness; the idle check above makes an empty
-- tick nearly free.
DO $sched$
BEGIN
  PERFORM cron.unschedule('knowledge-ingest-drain')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'knowledge-ingest-drain');
  PERFORM cron.schedule('knowledge-ingest-drain', '*/2 * * * *',
                        'select invoke_knowledge_ingest_drain()');
END $sched$;

-- ── 7. Kill-switch ─────────────────────────────────────────────────────────
INSERT INTO platform_config (key, value)
VALUES ('knowledge.ingest_paused', 'false')
ON CONFLICT (key) DO NOTHING;

-- ── 8. Prove the wiring ────────────────────────────────────────────────────
DO $assert$
DECLARE v_sched text; v_cmd text; v_dup uuid; v_t uuid; v_title text; v_content text;
BEGIN
  SELECT schedule, command INTO v_sched, v_cmd FROM cron.job WHERE jobname = 'knowledge-ingest-drain';
  IF v_sched IS NULL THEN RAISE EXCEPTION '350: the cron job was not scheduled'; END IF;
  IF v_cmd NOT ILIKE '%invoke_knowledge_ingest_drain%' THEN
    RAISE EXCEPTION '350: the cron job runs the wrong command: %', v_cmd;
  END IF;

  -- The dispatcher must no-op on an empty queue rather than fire the function.
  IF public.invoke_knowledge_ingest_drain() <> 'idle' THEN
    RAISE EXCEPTION '350: dispatcher did not report idle on an empty queue';
  END IF;

  -- Duplicate detection must agree with the trigger that wrote the hashes.
  -- Tested against a REAL existing document: if these two expressions ever
  -- diverge, dedupe silently stops working and every re-import doubles the
  -- corpus. This is the assertion that catches it.
  SELECT d.tenant_id, d.title, d.content INTO v_t, v_title, v_content
    FROM knowledge_docs d WHERE d.is_current AND d.content IS NOT NULL LIMIT 1;
  v_dup := public.find_duplicate_knowledge_doc(v_t, v_title, v_content);
  IF v_dup IS NULL THEN
    RAISE EXCEPTION '350: duplicate lookup did not find a document that already exists — the hash expressions disagree';
  END IF;
  IF public.find_duplicate_knowledge_doc(v_t, v_title, v_content || ' __different__') IS NOT NULL THEN
    RAISE EXCEPTION '350: duplicate lookup matched different content';
  END IF;

  RAISE NOTICE '350: drain scheduled every 2 minutes, idle-safe, dedupe agrees with the trigger';
END $assert$;

NOTIFY pgrst, 'reload schema';
