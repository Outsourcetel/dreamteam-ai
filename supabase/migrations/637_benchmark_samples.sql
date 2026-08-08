-- 637 — where the capability curve accumulates.
--
-- The approve-clean rate — what fraction of what an employee drafts a human
-- approves UNTOUCHED — is the number that separates "an employee" from "an
-- expensive text box". The certification review found it cannot be read from
-- history at all, for two separate reasons:
--
--   1. NO DRAFT HAS EVER BEEN DECIDED. Of 32 decided human_tasks, 20 were
--      action_approval (a yes/no gate on an action, which has no text to edit,
--      so the metric is meaningless for them) and none were draft-shaped.
--      Meanwhile 58 inquiry_review tasks — the actual drafts — sit PENDING.
--      The rate is not broken; it is unsampled.
--
--   2. THE SUPPORT PATH DESTROYS ITS OWN DENOMINATOR. approve_draft_reply
--      overwrites de_messages.delivery from 'draft_pending' to 'sent', so a
--      message that was once a draft is indistinguishable from one that never
--      was. 905 messages are 'sent'; zero are recoverable as "approved
--      untouched". Only the 2 EDITS survive, in de_learning_edits. A metric
--      whose numerator is recorded and whose denominator is erased can only
--      ever look bad, and cannot be trusted either way.
--
-- This table is the ledger the curve accumulates in. It is deliberately
-- append-only in spirit: each run records what was true at that moment, so the
-- series survives even as the definition of the underlying tables changes.
-- A curve you can recompute retroactively is a curve you can talk yourself
-- into.

BEGIN;

CREATE TABLE IF NOT EXISTS public.benchmark_samples (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at   timestamptz NOT NULL DEFAULT now(),
  metric        text NOT NULL,
  scope         text NOT NULL DEFAULT 'all',      -- 'all' or a de_id
  window_days   integer NOT NULL,
  n             integer NOT NULL,                  -- denominator: decisions seen
  numerator     integer NOT NULL,                  -- e.g. approved untouched
  rate          numeric,                           -- NULL when n is too small to mean anything
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT benchmark_samples_n_nonneg CHECK (n >= 0 AND numerator >= 0 AND numerator <= n)
);

CREATE INDEX IF NOT EXISTS benchmark_samples_metric_time_idx
  ON public.benchmark_samples (metric, captured_at DESC);

ALTER TABLE public.benchmark_samples ENABLE ROW LEVEL SECURITY;

-- Platform-level measurement, not tenant data: it counts decisions across the
-- whole install and is read by the review harness on the service role. No
-- client role gets a policy, so the default deny stands — and the perimeter
-- probe in certify will not see a new grant.
REVOKE ALL ON TABLE public.benchmark_samples FROM PUBLIC, anon, authenticated;

DO $probe$
BEGIN
  IF to_regclass('public.benchmark_samples') IS NULL THEN
    RAISE EXCEPTION 'B1 FAILED: table not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.benchmark_samples'::regclass) THEN
    RAISE EXCEPTION 'B2 FAILED: RLS not enabled — certify would flag it and it would be right';
  END IF;
  IF has_table_privilege('authenticated', 'public.benchmark_samples', 'SELECT') THEN
    RAISE EXCEPTION 'B3 FAILED: authenticated can read the benchmark ledger';
  END IF;
  RAISE NOTICE '637 asserts passed: benchmark_samples exists, RLS on, no client grant.';
END
$probe$;

COMMIT;
