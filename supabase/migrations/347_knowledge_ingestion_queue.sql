-- 347_knowledge_ingestion_queue.sql
-- ============================================================================
-- PHASE 2, INCREMENT 6 — ingestion as a real queue: jobs, items, retries that
-- know when to stop, and idempotency that actually works.
--
-- Ships BEFORE the three-panel library, per docs/27 §7e. Collections hold zero
-- rows today; a library over an empty tree shows an empty tree. Ingestion is
-- what creates the structure, so it goes first.
--
-- ── The finding that shaped this ────────────────────────────────────────────
-- The obvious idempotency lever is knowledge_docs.content_hash. It exists.
-- Measured before relying on it: **0 of 2,000 documents have it set**, there is
-- no index on it, and the only functions referencing it (enqueue_conflict_probe,
-- enqueue_conflict_backlog) hash CHUNKS, not documents.
--
-- So the column is a promise nothing keeps. Building "re-running a job will not
-- duplicate your documents" on top of it would have produced a guarantee that
-- silently never fires — machinery that looks built and does nothing. §1 below
-- makes it real: computed by trigger, backfilled over the existing corpus, and
-- indexed. Only then is it safe to dedupe against.
--
-- ── Jobs vs items ──────────────────────────────────────────────────────────
-- A JOB is one human act: "ingest these 40 files", "crawl this URL list",
-- "re-import this connector folder". An ITEM is one document-to-be. The split
-- exists because a job is what a person watches and an item is what retries.
-- Progress, partial failure and "what exactly went wrong with page 12" are all
-- properties of the item; the job only rolls them up.
--
-- ── Retryable vs terminal, and why it matters more than it sounds ──────────
-- A queue that retries a corrupt PDF forever is worse than one that gives up:
-- it burns the drain slot every tick, buries real failures under noise, and the
-- human never learns the file was unreadable. So every failure is CLASSIFIED.
--   retryable  network, timeout, rate limit, provider down  -> back off, retry
--   terminal   unparseable, too large, unsupported, empty   -> stop immediately
-- Terminal failures skip the remaining attempts entirely. Backoff is
-- exponential and capped.
--
-- ── Matching the house queue idiom, not inventing one ──────────────────────
-- Read the live schema first. The prevailing pattern here is: a table with
-- attempts/enqueued_at (knowledge_conflict_probe_queue, de_work_items), drained
-- by pg_cron calling a SECURITY DEFINER dispatcher that CLAIMS FIRST (advances
-- the clock before doing work, so a slow or duplicated tick cannot double-fire)
-- and then net.http_post's an edge function with the vault dispatch secret,
-- wrapping each row so one failure cannot abort the sweep. That is
-- dispatch_knowledge_sync_internal, and this file follows it deliberately.
--
-- ── Not duplicating connector_ingest_candidates ────────────────────────────
-- That table already exists (pending/approved/rejected/ingested, 0 rows) and
-- models DISCOVERY and human approval of connector files. This is the
-- EXECUTION layer underneath it: an approved candidate becomes an item in a
-- job. They compose; neither owns the other's state. A second discovery table
-- would have been exactly the two-sources-of-truth mistake this phase keeps
-- being careful about.
-- ============================================================================

-- ── 1. Make content_hash real ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION knowledge_docs_set_content_hash()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- Title included: two documents with identical bodies but different titles
  -- are different documents to a reader, and dedupe should agree with readers.
  -- md5 is for de-duplication, never for security.
  NEW.content_hash := md5(coalesce(NEW.title,'') || E'\n' || coalesce(NEW.content,''));
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS knowledge_docs_content_hash_trg ON knowledge_docs;
CREATE TRIGGER knowledge_docs_content_hash_trg
  BEFORE INSERT OR UPDATE OF title, content ON knowledge_docs
  FOR EACH ROW EXECUTE FUNCTION knowledge_docs_set_content_hash();

-- Backfill the existing corpus, with the side-effect triggers held off.
-- Without this, 2,000 rows would each: bump updated_at (making every document
-- look freshly edited, which feeds the freshness weighting from mig 292 and the
-- "recently updated" surfaces), and invalidate every tenant's answer cache.
-- A hash backfill changes no content and must look like nothing happened.
ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_updated_at;
ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_invalidate_cache;
UPDATE knowledge_docs
   SET content_hash = md5(coalesce(title,'') || E'\n' || coalesce(content,''))
 WHERE content_hash IS NULL;
ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_updated_at;
ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_invalidate_cache;

-- Not unique: a workspace may legitimately hold the same text twice (an old
-- version, a deliberate copy in another Space). Dedupe is a DECISION the
-- ingester makes, not a constraint that raises in the middle of an import.
CREATE INDEX IF NOT EXISTS knowledge_docs_content_hash_idx
  ON knowledge_docs (tenant_id, content_hash) WHERE is_current;

-- ── 2. Jobs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_ingestion_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label               text NOT NULL,
  source_kind         text NOT NULL CHECK (source_kind IN ('upload','url','paste','connector','reingest')),
  source_ref          text,
  -- Where the results are filed. This is the line that makes the library stop
  -- being empty, and why ingestion ships before the three-panel UI.
  target_collection_id uuid REFERENCES knowledge_collections(id) ON DELETE SET NULL,
  connector_id        uuid,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','completed','completed_with_errors','failed','cancelled')),
  total_items         int NOT NULL DEFAULT 0,
  succeeded_items     int NOT NULL DEFAULT 0,
  failed_items        int NOT NULL DEFAULT 0,
  skipped_items       int NOT NULL DEFAULT 0,
  error               text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz
);
CREATE INDEX IF NOT EXISTS knowledge_ingestion_jobs_tenant_idx
  ON knowledge_ingestion_jobs (tenant_id, created_at DESC);

-- ── 3. Items ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_ingestion_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES knowledge_ingestion_jobs(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  source_ref      text NOT NULL,          -- filename, URL, or external_ref
  title           text,
  content_hash    text,                   -- set once the content is in hand
  byte_size       bigint,
  mime_type       text,

  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed','skipped_duplicate','cancelled')),
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 3,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  error_kind      text CHECK (error_kind IN ('retryable','terminal')),

  doc_id          uuid REFERENCES knowledge_docs(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- The drain's exact access path: claimable work, oldest first.
CREATE INDEX IF NOT EXISTS knowledge_ingestion_items_claim_idx
  ON knowledge_ingestion_items (next_attempt_at)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS knowledge_ingestion_items_job_idx
  ON knowledge_ingestion_items (job_id, status);

ALTER TABLE knowledge_ingestion_jobs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_ingestion_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_ingestion_jobs_read ON knowledge_ingestion_jobs;
CREATE POLICY knowledge_ingestion_jobs_read ON knowledge_ingestion_jobs
  FOR SELECT USING (tenant_id = auth_tenant_id());
DROP POLICY IF EXISTS knowledge_ingestion_items_read ON knowledge_ingestion_items;
CREATE POLICY knowledge_ingestion_items_read ON knowledge_ingestion_items
  FOR SELECT USING (tenant_id = auth_tenant_id());
-- Read-only to clients. Every write goes through the RPCs below, which enforce
-- permission and keep the job counters honest.

-- ── 4. Job counters, maintained by trigger ─────────────────────────────────
-- Denormalised for the same reason mig 279 denormalised chunk counts: the
-- ingestion page reads job progress constantly and must never aggregate items.
CREATE OR REPLACE FUNCTION knowledge_ingestion_rollup()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_job uuid; v_open int;
BEGIN
  v_job := coalesce(NEW.job_id, OLD.job_id);

  UPDATE knowledge_ingestion_jobs j SET
    total_items     = (SELECT count(*) FROM knowledge_ingestion_items i WHERE i.job_id = v_job),
    succeeded_items = (SELECT count(*) FROM knowledge_ingestion_items i WHERE i.job_id = v_job AND i.status='succeeded'),
    failed_items    = (SELECT count(*) FROM knowledge_ingestion_items i WHERE i.job_id = v_job AND i.status='failed'),
    skipped_items   = (SELECT count(*) FROM knowledge_ingestion_items i WHERE i.job_id = v_job AND i.status='skipped_duplicate')
  WHERE j.id = v_job;

  -- A job finishes when nothing is left to do. Distinguishing "completed" from
  -- "completed_with_errors" is the difference between a green tick that means
  -- something and one that does not.
  SELECT count(*) INTO v_open FROM knowledge_ingestion_items i
   WHERE i.job_id = v_job AND i.status IN ('queued','running');
  IF v_open = 0 THEN
    UPDATE knowledge_ingestion_jobs j SET
      status = CASE WHEN j.status = 'cancelled' THEN 'cancelled'
                    WHEN j.failed_items > 0 AND j.succeeded_items = 0 THEN 'failed'
                    WHEN j.failed_items > 0 THEN 'completed_with_errors'
                    ELSE 'completed' END,
      finished_at = coalesce(j.finished_at, now())
     WHERE j.id = v_job AND j.status NOT IN ('completed','completed_with_errors','failed');
  END IF;
  RETURN coalesce(NEW, OLD);
END $fn$;

DROP TRIGGER IF EXISTS knowledge_ingestion_rollup_trg ON knowledge_ingestion_items;
CREATE TRIGGER knowledge_ingestion_rollup_trg
  AFTER INSERT OR UPDATE OF status OR DELETE ON knowledge_ingestion_items
  FOR EACH ROW EXECUTE FUNCTION knowledge_ingestion_rollup();

-- ── 5. Creating work (permission-gated via mig 343) ────────────────────────
CREATE OR REPLACE FUNCTION public.create_ingestion_job(
  p_label text, p_source_kind text, p_items jsonb,
  p_target_collection_id uuid DEFAULT NULL, p_source_ref text DEFAULT NULL,
  p_connector_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_job uuid; v_n int; v_lvl int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- Adding documents is authorship: contributor (rank 2) and above.
  SELECT coalesce(max(knowledge_permission_rank(g.permission)), 0) INTO v_lvl
    FROM knowledge_access_grants g
   WHERE g.tenant_id = v_tenant AND g.resource_type = 'workspace'
     AND knowledge_grant_matches_caller(g);
  IF v_lvl < 2 AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'insufficient_permission: adding knowledge requires contributor';
  END IF;

  -- A target collection must belong to this workspace. Cross-workspace filing
  -- would put one tenant's documents inside another's Space.
  IF p_target_collection_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM knowledge_collections c
                      WHERE c.id = p_target_collection_id AND c.tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'target collection does not belong to this workspace';
  END IF;

  INSERT INTO knowledge_ingestion_jobs (tenant_id, label, source_kind, source_ref,
                                        target_collection_id, connector_id, created_by)
  VALUES (v_tenant, p_label, p_source_kind, p_source_ref,
          p_target_collection_id, p_connector_id, auth.uid())
  RETURNING id INTO v_job;

  INSERT INTO knowledge_ingestion_items (job_id, tenant_id, source_ref, title, byte_size, mime_type)
  SELECT v_job, v_tenant,
         coalesce(e->>'source_ref', e->>'url', e->>'filename', 'item'),
         e->>'title', (e->>'byte_size')::bigint, e->>'mime_type'
    FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'an ingestion job needs at least one item'; END IF;

  RETURN v_job;
END $fn$;
REVOKE ALL ON FUNCTION public.create_ingestion_job(text, text, jsonb, uuid, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_ingestion_job(text, text, jsonb, uuid, text, uuid) TO authenticated;

-- ── 6. Claiming work — SKIP LOCKED, claim-first ────────────────────────────
-- Service-role only. FOR UPDATE SKIP LOCKED is what lets two drain ticks
-- overlap harmlessly instead of processing the same item twice.
CREATE OR REPLACE FUNCTION public.claim_ingestion_items(p_limit int DEFAULT 10)
RETURNS SETOF knowledge_ingestion_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'claim_ingestion_items is not callable by tenant users';
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT i.id FROM knowledge_ingestion_items i
     WHERE i.status = 'queued' AND i.next_attempt_at <= now()
     ORDER BY i.next_attempt_at
     LIMIT greatest(1, p_limit)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE knowledge_ingestion_items i
     SET status = 'running', attempts = i.attempts + 1, updated_at = now()
    FROM picked p WHERE i.id = p.id
  RETURNING i.*;
END $fn$;
REVOKE ALL ON FUNCTION public.claim_ingestion_items(int) FROM public, anon, authenticated;

-- ── 7. Finishing work ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_ingestion_item(
  p_item_id uuid, p_doc_id uuid, p_duplicate boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_item knowledge_ingestion_items; v_job knowledge_ingestion_jobs;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'not callable by tenant users';
  END IF;
  SELECT * INTO v_item FROM knowledge_ingestion_items WHERE id = p_item_id;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'ingestion item not found'; END IF;

  UPDATE knowledge_ingestion_items
     SET status = CASE WHEN p_duplicate THEN 'skipped_duplicate' ELSE 'succeeded' END,
         doc_id = p_doc_id, last_error = NULL, error_kind = NULL, updated_at = now()
   WHERE id = p_item_id;

  -- File the result into the job's target Space, if it had one. This is what
  -- turns an import into an organised library rather than a flat pile.
  SELECT * INTO v_job FROM knowledge_ingestion_jobs WHERE id = v_item.job_id;
  IF v_job.target_collection_id IS NOT NULL AND p_doc_id IS NOT NULL AND NOT p_duplicate THEN
    INSERT INTO knowledge_doc_collections (tenant_id, doc_id, collection_id)
    VALUES (v_job.tenant_id, p_doc_id, v_job.target_collection_id)
    ON CONFLICT DO NOTHING;
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.complete_ingestion_item(uuid, uuid, boolean) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fail_ingestion_item(
  p_item_id uuid, p_error text, p_kind text DEFAULT 'retryable')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_item knowledge_ingestion_items; v_final boolean; v_backoff interval;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'not callable by tenant users';
  END IF;
  IF p_kind NOT IN ('retryable','terminal') THEN
    RAISE EXCEPTION 'error kind must be retryable or terminal, got %', p_kind;
  END IF;

  SELECT * INTO v_item FROM knowledge_ingestion_items WHERE id = p_item_id;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'ingestion item not found'; END IF;

  -- Terminal failures do not get their remaining attempts. Retrying an
  -- unreadable file three times just delays telling the human it is unreadable.
  v_final := (p_kind = 'terminal') OR (v_item.attempts >= v_item.max_attempts);

  IF v_final THEN
    UPDATE knowledge_ingestion_items
       SET status='failed', last_error=left(p_error, 2000), error_kind=p_kind, updated_at=now()
     WHERE id = p_item_id;
    RETURN 'failed';
  END IF;

  -- Exponential backoff, capped: 1m, 4m, 9m... never more than an hour.
  v_backoff := make_interval(secs => least(3600, 60 * power(greatest(v_item.attempts,1), 2)::int));
  UPDATE knowledge_ingestion_items
     SET status='queued', last_error=left(p_error, 2000), error_kind=p_kind,
         next_attempt_at = now() + v_backoff, updated_at=now()
   WHERE id = p_item_id;
  RETURN 'retry_scheduled';
END $fn$;
REVOKE ALL ON FUNCTION public.fail_ingestion_item(uuid, text, text) FROM public, anon, authenticated;

-- A stuck 'running' item must not hold a slot forever if the worker died
-- mid-item. Anything running for over 30 minutes goes back on the queue.
CREATE OR REPLACE FUNCTION public.reap_stale_ingestion_items()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_n int;
BEGIN
  UPDATE knowledge_ingestion_items
     SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         last_error = 'the worker stopped responding part-way through this item',
         error_kind = 'retryable', next_attempt_at = now(), updated_at = now()
   WHERE status = 'running' AND updated_at < now() - interval '30 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$;
REVOKE ALL ON FUNCTION public.reap_stale_ingestion_items() FROM public, anon, authenticated;

-- ── 8. Cancelling ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_ingestion_job(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_n int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_ingestion_jobs WHERE id=p_job_id AND tenant_id=v_tenant) THEN
    RAISE EXCEPTION 'job_not_found';
  END IF;

  UPDATE knowledge_ingestion_jobs SET status='cancelled', finished_at=now() WHERE id=p_job_id;
  UPDATE knowledge_ingestion_items SET status='cancelled', updated_at=now()
   WHERE job_id=p_job_id AND status IN ('queued','running');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'cancelled_items', v_n);
END $fn$;
REVOKE ALL ON FUNCTION public.cancel_ingestion_job(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cancel_ingestion_job(uuid) TO authenticated;

-- ── 9. What the human sees ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_ingestion_jobs(p_limit int DEFAULT 20)
RETURNS TABLE (id uuid, label text, source_kind text, status text,
               total_items int, succeeded_items int, failed_items int, skipped_items int,
               target_collection text, created_at timestamptz, finished_at timestamptz,
               first_error text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT j.id, j.label, j.source_kind, j.status,
         j.total_items, j.succeeded_items, j.failed_items, j.skipped_items,
         c.name, j.created_at, j.finished_at,
         (SELECT i.last_error FROM knowledge_ingestion_items i
           WHERE i.job_id = j.id AND i.status='failed'
           ORDER BY i.updated_at DESC LIMIT 1)
    FROM knowledge_ingestion_jobs j
    LEFT JOIN knowledge_collections c ON c.id = j.target_collection_id
   WHERE j.tenant_id = auth_tenant_id()
   ORDER BY j.created_at DESC
   LIMIT greatest(1, p_limit);
$fn$;
REVOKE ALL ON FUNCTION public.list_ingestion_jobs(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_ingestion_jobs(int) TO authenticated;

-- ── 10. Prove it ───────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_t uuid; v_job uuid; v_item uuid; v_res text; v_status text;
  v_hashed int; v_total int; v_nulls int;
BEGIN
  -- content_hash must actually be populated now, or dedupe is theatre.
  SELECT count(*) FILTER (WHERE content_hash IS NOT NULL), count(*)
    INTO v_hashed, v_total FROM knowledge_docs;
  IF v_hashed <> v_total THEN
    RAISE EXCEPTION '347: only % of % documents have a content hash', v_hashed, v_total;
  END IF;

  SELECT id INTO v_t FROM tenants LIMIT 1;

  INSERT INTO knowledge_ingestion_jobs (tenant_id, label, source_kind)
  VALUES (v_t, '__selftest', 'upload') RETURNING id INTO v_job;
  INSERT INTO knowledge_ingestion_items (job_id, tenant_id, source_ref, max_attempts)
  VALUES (v_job, v_t, 'a.pdf', 3) RETURNING id INTO v_item;

  -- rollup counted it
  SELECT total_items INTO v_total FROM knowledge_ingestion_jobs WHERE id=v_job;
  IF v_total <> 1 THEN RAISE EXCEPTION '347: rollup did not count the item (got %)', v_total; END IF;

  -- a TERMINAL failure must not consume retries
  UPDATE knowledge_ingestion_items SET attempts=1 WHERE id=v_item;
  v_res := fail_ingestion_item(v_item, 'not a readable PDF', 'terminal');
  IF v_res <> 'failed' THEN RAISE EXCEPTION '347: a terminal error scheduled a retry (%)', v_res; END IF;

  -- a RETRYABLE failure below the cap must back off, not fail
  UPDATE knowledge_ingestion_items SET status='running', attempts=1 WHERE id=v_item;
  v_res := fail_ingestion_item(v_item, 'connection reset', 'retryable');
  IF v_res <> 'retry_scheduled' THEN RAISE EXCEPTION '347: a retryable error did not retry (%)', v_res; END IF;
  IF (SELECT next_attempt_at FROM knowledge_ingestion_items WHERE id=v_item) <= now() THEN
    RAISE EXCEPTION '347: retry was scheduled with no backoff — it would spin';
  END IF;

  -- at the cap, a retryable failure becomes final
  UPDATE knowledge_ingestion_items SET status='running', attempts=3 WHERE id=v_item;
  v_res := fail_ingestion_item(v_item, 'connection reset', 'retryable');
  IF v_res <> 'failed' THEN RAISE EXCEPTION '347: exhausted retries did not fail (%)', v_res; END IF;

  -- the job must now read as failed, not silently "completed"
  SELECT status INTO v_status FROM knowledge_ingestion_jobs WHERE id=v_job;
  IF v_status <> 'failed' THEN RAISE EXCEPTION '347: job with only failures reads as %', v_status; END IF;

  -- the reaper must rescue an abandoned item
  UPDATE knowledge_ingestion_items SET status='running', attempts=0, updated_at=now() - interval '2 hours'
   WHERE id=v_item;
  IF reap_stale_ingestion_items() < 1 THEN RAISE EXCEPTION '347: the reaper left a stuck item running'; END IF;
  SELECT status INTO v_status FROM knowledge_ingestion_items WHERE id=v_item;
  IF v_status <> 'queued' THEN RAISE EXCEPTION '347: reaped item is % not queued', v_status; END IF;

  DELETE FROM knowledge_ingestion_jobs WHERE id=v_job;
  RAISE NOTICE '347: queue, retry classification, backoff, rollup and reaper all verified';
END $assert$;

NOTIFY pgrst, 'reload schema';
