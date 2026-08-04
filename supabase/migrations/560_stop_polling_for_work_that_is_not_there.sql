-- 560 — retime the background pollers to the speed the work actually needs.
--
-- MEASURED, not assumed. Seven days of dispatch_log:
--     23,728 edge-function dispatches
--   →      0 chunks embedded
--   →      0 work items created
--   →      2 activity events
-- That is ~101,700 dispatches a month to accomplish essentially nothing, on a
-- workspace with no external customers. Cost scales with TIME here, not usage.
--
-- THIS MIGRATION ONLY CHANGES *WHEN* JOBS RUN. It adds no gates and skips no
-- work. That distinction is deliberate: a gate can decide "nothing to do" and be
-- wrong forever — this codebase has already lost a workforce to a wake-starvation
-- regression that read as healthy. A slower schedule can only ever DELAY work,
-- never drop it, and reverting is one UPDATE. Gating is a separate decision.
--
-- WHAT IS NOT SLOWED, on purpose:
--   knowledge-ingest-drain stays at */2. It is the only one of these a PERSON
--   waits on — upload a document, wait for it to become searchable. Saving a few
--   thousand no-op calls is not worth making that wait longer.
--   eval-run-driver's HTTP is already gated (it loops over RUNNING eval runs and
--   posts nothing when there are none), so its cost is 43,200 pointless DB
--   queries a month rather than 43,200 HTTP calls. Still worth slowing, but it
--   was never the HTTP offender I first took it for.

BEGIN;

DO $retime$
DECLARE
  r record;
  v_before int := 0;
  v_after  int := 0;
  -- job, new schedule, runs/month before, runs/month after, why
  v_plan CONSTANT jsonb := jsonb_build_array(
    -- A BACKFILL of documents embedded before the current pipeline. By
    -- definition it is catching up on the past; nothing waits on it.
    jsonb_build_object('job','embed-backfill-drain','sched','*/15 * * * *','was',21600,'now',2880),
    -- Re-embeds documents whose text changed. Matters, but a ten-minute lag
    -- between editing a document and its embedding refreshing is invisible.
    jsonb_build_object('job','knowledge-reembed-drain','sched','*/10 * * * *','was',21600,'now',4320),
    -- Looks for contradictions BETWEEN documents — a background quality sweep,
    -- not a request anybody is blocked on.
    jsonb_build_object('job','knowledge-conflict-probe-drain','sched','*/15 * * * *','was',14400,'now',2880),
    -- Already posts nothing unless an eval run is live. Slowing it costs at most
    -- four extra minutes before a running evaluation advances.
    jsonb_build_object('job','eval-run-driver','sched','*/5 * * * *','was',43200,'now',8640)
  );
  v_item jsonb;
  v_cmd  text;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_plan) LOOP
    SELECT command INTO v_cmd FROM cron.job WHERE jobname = v_item->>'job';
    IF v_cmd IS NULL THEN
      RAISE EXCEPTION 'SETUP FAILED: cron job % does not exist — refusing to invent one', v_item->>'job';
    END IF;
    -- Same jobname + same command: cron.schedule REPLACES the schedule and
    -- leaves what it runs untouched.
    PERFORM cron.schedule(v_item->>'job', v_item->>'sched', v_cmd);
    v_before := v_before + (v_item->>'was')::int;
    v_after  := v_after  + (v_item->>'now')::int;
  END LOOP;

  RAISE NOTICE '560: retimed 4 jobs — % -> % runs/month, saving % runs',
    v_before, v_after, (v_before - v_after);
END
$retime$;

-- ── Asserts ─────────────────────────────────────────────────────────────────
-- Would these pass on a no-op? No — every schedule below differs from what was
-- there. Would they pass if this broke something? No: E2 fails if a job stopped
-- being active, and E3 fails if the command was altered rather than the timing.
DO $probe$
DECLARE
  v_n int;
BEGIN
  -- E1: the new cadences are in place.
  SELECT count(*) INTO v_n FROM cron.job
   WHERE (jobname = 'embed-backfill-drain'          AND schedule = '*/15 * * * *')
      OR (jobname = 'knowledge-reembed-drain'       AND schedule = '*/10 * * * *')
      OR (jobname = 'knowledge-conflict-probe-drain' AND schedule = '*/15 * * * *')
      OR (jobname = 'eval-run-driver'               AND schedule = '*/5 * * * *');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'E1 FAILED: % of 4 jobs carry the new schedule', v_n;
  END IF;

  -- E2: THE ONE THAT MATTERS. Retiming must not disable anything. A job that
  -- stops running is not a cheaper job, it is a broken one.
  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname IN ('embed-backfill-drain','knowledge-reembed-drain',
                     'knowledge-conflict-probe-drain','eval-run-driver')
     AND active;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'E2 FAILED: only % of 4 retimed jobs are still active', v_n;
  END IF;

  -- E3: each still runs the SAME function. This migration changes when, never what.
  SELECT count(*) INTO v_n FROM cron.job
   WHERE (jobname = 'embed-backfill-drain'           AND command = 'select invoke_embed_backfill()')
      OR (jobname = 'knowledge-reembed-drain'        AND command = 'select invoke_reembed_drain()')
      OR (jobname = 'knowledge-conflict-probe-drain' AND command = 'select invoke_conflict_probe_drain()')
      OR (jobname = 'eval-run-driver'                AND command = 'select dispatch_eval_driver_internal()');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'E3 FAILED: % of 4 jobs still run their original command', v_n;
  END IF;

  -- E4: the one a person waits on was left alone.
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'knowledge-ingest-drain' AND schedule = '*/2 * * * *' AND active) THEN
    RAISE EXCEPTION 'E4 FAILED: knowledge-ingest-drain was changed — uploads would take longer to become searchable';
  END IF;

  RAISE NOTICE '560 asserts passed: 4 retimed, all active, commands unchanged, ingest untouched.';
END
$probe$;

COMMIT;
