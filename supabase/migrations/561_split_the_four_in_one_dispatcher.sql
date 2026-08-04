-- 561 — split invoke_playbook_dispatch, so four unrelated jobs stop sharing one
-- clock.
--
-- It fired FOUR HTTP posts every five minutes — 34,560 a month — because they
-- happened to be written in the same function, not because they need the same
-- cadence:
--
--   playbook-execute          scheduled playbooks are due on the minute → */5
--   specialist-consult        polls external sources for new work      → */10
--   knowledge-gap-detect      mines PAST inquiries for patterns        → hourly
--   learned-behavior-detect   mines PAST behaviour for patterns        → 6-hourly
--
-- The last two look backwards over history. Running them every five minutes
-- re-analyses the same past 288 times a day to reach the same conclusion.
--
-- ⚠ STILL NO GATES. Each new dispatcher posts unconditionally, exactly as
-- before. Adding "is there anything to do?" checks is a separate decision with a
-- different risk profile — a wrong gate skips work silently and forever, which
-- has already cost this system a workforce once. Retiming can only ever delay.
--
-- The health-score loop and check_staleness() stay together on the 5-minute
-- clock: they are pure SQL with their own internal freshness filters and make no
-- HTTP calls at all, so their cost is already proportional to real work.

BEGIN;

-- ── One helper, so the secret/anon/header handling exists in ONE place ──────
-- The original repeated the same 6-line http_post block four times, which is
-- why three of the four silently lacked the exception handling the fourth had.
CREATE OR REPLACE FUNCTION public._dispatch_fn(p_path text, p_body jsonb DEFAULT '{}'::jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret text;
  v_anon   text := platform_anon_key();
  v_req    bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    -- Same alert the original raised, kept so a missing secret is still loud
    -- rather than a silently dead cron.
    PERFORM raise_ops_alert('dispatch_secret_missing',
      format('playbook_dispatch_secret is missing from Vault — %s is doing NOTHING.', p_path),
      jsonb_build_object('path', p_path));
    RETURN NULL;
  END IF;
  SELECT net.http_post(
    url := platform_fn_url(p_path),
    body := p_body,
    headers := jsonb_build_object('Content-Type','application/json',
                                  'Authorization','Bearer '||v_anon,
                                  'apikey', v_anon,
                                  'x-dispatch-secret', v_secret),
    timeout_milliseconds := 30000
  ) INTO v_req;
  RETURN v_req;
EXCEPTION WHEN OTHERS THEN
  -- The original swallowed failures on two of the four posts. Now all four
  -- behave the same way AND say so, rather than one cron dying while its
  -- neighbours in the same function carry on.
  RAISE WARNING 'dispatch to % failed: %', p_path, SQLERRM;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public._dispatch_fn(text, jsonb) FROM PUBLIC, anon, authenticated;

-- ── The four, now separable ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.invoke_playbook_execute()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$ SELECT coalesce('dispatched:' || public._dispatch_fn('/functions/v1/playbook-execute', '{"action":"dispatch"}'::jsonb)::text, 'skipped'); $function$;

CREATE OR REPLACE FUNCTION public.invoke_work_source_poll()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$ SELECT coalesce('dispatched:' || public._dispatch_fn('/functions/v1/specialist-consult', '{"action":"poll_de_work_sources"}'::jsonb)::text, 'skipped'); $function$;

CREATE OR REPLACE FUNCTION public.invoke_knowledge_gap_detect()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$ SELECT coalesce('dispatched:' || public._dispatch_fn('/functions/v1/knowledge-gap-detect')::text, 'skipped'); $function$;

CREATE OR REPLACE FUNCTION public.invoke_learned_behavior_detect()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$ SELECT coalesce('dispatched:' || public._dispatch_fn('/functions/v1/learned-behavior-detect')::text, 'skipped'); $function$;

REVOKE ALL ON FUNCTION public.invoke_playbook_execute()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoke_work_source_poll()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoke_knowledge_gap_detect()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoke_learned_behavior_detect()  FROM PUBLIC, anon, authenticated;

-- ── What stays on the 5-minute clock: the SQL-only half ────────────────────
-- Health scoring already only touches tenants whose score is >24h old, and
-- check_staleness has its own internal scope. No HTTP, so no per-tick cost that
-- scales with anything but real work.
CREATE OR REPLACE FUNCTION public.invoke_playbook_dispatch()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_t      record;
  v_health integer := 0;
  v_stale  jsonb;
BEGIN
  FOR v_t IN
    SELECT DISTINCT ca.tenant_id
    FROM customer_accounts ca
    LEFT JOIN health_score_config c ON c.tenant_id = ca.tenant_id
    WHERE (c.last_computed_at IS NULL OR c.last_computed_at < now() - interval '24 hours')
      AND tenant_is_operational(ca.tenant_id)
  LOOP
    PERFORM compute_tenant_health_service(v_t.tenant_id);
    v_health := v_health + 1;
  END LOOP;

  BEGIN
    v_stale := check_staleness();
  EXCEPTION WHEN OTHERS THEN
    v_stale := jsonb_build_object('error', sqlerrm);
  END;

  RETURN format('health:%s stale:%s', v_health, coalesce(v_stale->>'checked', '0'));
END;
$function$;

-- ── Schedules ──────────────────────────────────────────────────────────────
SELECT cron.schedule('playbook-execute-5min',      '*/5 * * * *',  'select invoke_playbook_execute()');
SELECT cron.schedule('work-source-poll-10min',     '*/10 * * * *', 'select invoke_work_source_poll()');
SELECT cron.schedule('knowledge-gap-detect-hourly','23 * * * *',   'select invoke_knowledge_gap_detect()');
SELECT cron.schedule('learned-behavior-6h',        '53 */6 * * *', 'select invoke_learned_behavior_detect()');

-- ── Asserts ────────────────────────────────────────────────────────────────
-- Would these pass on a no-op? No — none of the four jobs exists yet.
-- Would they pass if this broke the workforce? F2 is the one that would catch
-- it: every path the old function posted to must still be dispatched by
-- something, or work quietly stops arriving.
DO $probe$
DECLARE
  v_n int;
  v_paths text[] := ARRAY['playbook-execute','specialist-consult','knowledge-gap-detect','learned-behavior-detect'];
  v_p text;
BEGIN
  -- F1: four separate jobs, all active, at four different cadences.
  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname IN ('playbook-execute-5min','work-source-poll-10min',
                     'knowledge-gap-detect-hourly','learned-behavior-6h')
     AND active;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'F1 FAILED: % of 4 new jobs are active', v_n;
  END IF;
  SELECT count(DISTINCT schedule) INTO v_n FROM cron.job
   WHERE jobname IN ('playbook-execute-5min','work-source-poll-10min',
                     'knowledge-gap-detect-hourly','learned-behavior-6h');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'F1 FAILED: the four jobs share % distinct schedules — the point was to separate them', v_n;
  END IF;

  -- F2: NOTHING WAS DROPPED. Each of the four paths the old function posted to
  -- is still reachable from a scheduled function body.
  FOREACH v_p IN ARRAY v_paths LOOP
    SELECT count(*) INTO v_n
      FROM cron.job j
      JOIN pg_proc p ON j.command LIKE '%' || p.proname || '%'
      JOIN pg_namespace ns ON ns.oid = p.pronamespace AND ns.nspname = 'public'
     WHERE j.active AND p.prosrc LIKE '%' || v_p || '%';
    IF v_n = 0 THEN
      RAISE EXCEPTION 'F2 FAILED: nothing scheduled dispatches % any more — that work would stop arriving', v_p;
    END IF;
  END LOOP;

  -- F3: the SQL-only remainder still runs, and no longer makes HTTP calls.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'playbook-dispatch-5min' AND active) THEN
    RAISE EXCEPTION 'F3 FAILED: playbook-dispatch-5min is gone — health scoring and staleness would stop';
  END IF;
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'invoke_playbook_dispatch') LIKE '%net.http_post%' THEN
    RAISE EXCEPTION 'F3 FAILED: invoke_playbook_dispatch still posts — the four calls were meant to move out';
  END IF;

  -- F4: the new dispatchers are not reachable from a browser.
  IF has_function_privilege('authenticated', 'public.invoke_playbook_execute()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._dispatch_fn(text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F4 FAILED: a dispatcher is callable by a client role';
  END IF;

  RAISE NOTICE '561 asserts passed: 4 jobs, 4 cadences, every path still dispatched, 34,560 -> 13,800 posts/month.';
END
$probe$;

COMMIT;
