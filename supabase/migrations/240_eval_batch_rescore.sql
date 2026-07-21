-- 240_eval_batch_rescore.sql
-- ============================================================================
-- Bulk historical RE-SCORING via the Anthropic Message Batches API (50% off).
--
-- The eval-judge rubric grades one (question, answer) pair per synchronous call.
-- Re-grading THOUSANDS of past conversations that way is slow + full price. The
-- Batches API is built for exactly this: async, up to 100k requests, 50% cheaper
-- — but a batch can take up to 1 HOUR while an edge function times out in
-- minutes, so it CANNOT be polled inside one invocation. This is the
-- submit-now / poll-later job architecture that makes it work:
--
--   • eval_batch_jobs  — one row per submitted batch (Anthropic batch id +
--     lifecycle status + roll-up).
--   • eval_batch_items — the (question, answer) pairs, keyed by the batch
--     custom_id, where each judge verdict lands on collection.
--   • invoke_eval_batch_poll() + a 5-min cron — the "later" half: it pings the
--     eval-batch edge fn, which checks each in-flight batch and, once ended,
--     streams the results back into eval_batch_items (+ mirrors passing rows
--     into eval_judgments so existing quality views pick them up).
--
-- The eval-batch edge fn (submit + poll actions) is the runtime; this is its
-- durable spine + the poll heartbeat. Additive, tenant-scoped, GLOBAL.
-- ============================================================================

-- 1. The job ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eval_batch_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id              uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  source             text NOT NULL DEFAULT 'historical_rescore',
  anthropic_batch_id text,                         -- msgbatch_… once submitted
  status             text NOT NULL DEFAULT 'submitting'
                       CHECK (status IN ('submitting','in_progress','collecting','done','error','expired')),
  total_requests     integer NOT NULL DEFAULT 0,
  succeeded          integer NOT NULL DEFAULT 0,
  failed             integer NOT NULL DEFAULT 0,
  avg_score          integer,
  error              text,
  created_by         uuid REFERENCES auth.users(id),
  submitted_at       timestamptz,
  ended_at           timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_batch_jobs_tenant ON eval_batch_jobs(tenant_id, created_at DESC);
-- The poller scans for still-running batches; partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_eval_batch_jobs_open ON eval_batch_jobs(status)
  WHERE status IN ('in_progress','collecting');
ALTER TABLE eval_batch_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eval_batch_jobs_tenant_read ON eval_batch_jobs;
CREATE POLICY eval_batch_jobs_tenant_read ON eval_batch_jobs
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- Writes go through the eval-batch edge fn (service role), never free-form client.

-- 2. The items (custom_id ↔ Q/A pair; verdict lands here on collection) --------
CREATE TABLE IF NOT EXISTS eval_batch_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- == batch custom_id
  job_id      uuid NOT NULL REFERENCES eval_batch_jobs(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id       uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  question    text NOT NULL,
  answer      text NOT NULL,
  reference   text,
  verdict     text,
  score       integer,
  dimensions  jsonb,
  rationale   text,
  judged      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_batch_items_job ON eval_batch_items(job_id);
ALTER TABLE eval_batch_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eval_batch_items_tenant_read ON eval_batch_items;
CREATE POLICY eval_batch_items_tenant_read ON eval_batch_items
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

-- 3. The "poll later" heartbeat — pings the edge fn to advance open batches ----
CREATE OR REPLACE FUNCTION public.invoke_eval_batch_poll()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE v_secret text; v_open int; v_req bigint;
BEGIN
  -- Nothing in flight → don't wake the function at all.
  SELECT count(*) INTO v_open FROM eval_batch_jobs WHERE status IN ('in_progress','collecting');
  IF v_open = 0 THEN RETURN 'idle'; END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN RETURN 'no_secret'; END IF;

  SELECT net.http_post(
    url := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/eval-batch',
    body := jsonb_build_object('action', 'poll'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', v_secret),
    timeout_milliseconds := 150000
  ) INTO v_req;
  RETURN 'polled_open:' || v_open;
END; $$;
REVOKE ALL ON FUNCTION public.invoke_eval_batch_poll() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_eval_batch_poll() TO service_role;

-- Every 5 minutes; upserts by name — idempotent.
SELECT cron.schedule('eval-batch-poll-tick', '*/5 * * * *', 'select public.invoke_eval_batch_poll()');
