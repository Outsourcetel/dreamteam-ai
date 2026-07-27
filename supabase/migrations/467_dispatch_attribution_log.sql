-- 467_dispatch_attribution_log.sql
-- ============================================================================
-- Make dispatch failures ATTRIBUTABLE. Today they are not, which is why four
-- dispatch_failure alerts sat unresolved for two days.
--
-- ── The problem, from reading the four alerts ────────────────────────────
-- check_dispatch_failures reports "1 of 140 background dispatches failed in the
-- last hour" and CANNOT say which dispatch, or to which function.
-- net.http_request_queue is purged on completion and net._http_response keeps
-- no URL, so attribution is impossible after the fact — I tried.
--
-- The consequence is not just inconvenience. Severity is unknowable: a failed
-- de-work tick is harmless and self-heals on the next 5-minute run, while a 520
-- from de-answer means a customer saw nothing. Same alert, no way to tell them
-- apart, so nobody can triage and nobody does.
--
-- The four also turned out to be THREE different faults wearing one label —
-- DNS resolution timeouts, edge-function timeouts, and HTTP 520 origin errors.
-- The alert recorded `max(error_msg)` as a single "sample_error", which hid
-- that entirely. docs/35 has the analysis.
--
-- ── Why a trigger and not 14 edits ───────────────────────────────────────
-- Fourteen database functions call net.http_post. Splicing a log write into
-- each is fourteen chances to get it wrong, and it captures nothing from a
-- dispatcher written next week.
--
-- net.http_request_queue receives a row for every dispatch, carrying the URL —
-- which is exactly the attribution that is missing. One AFTER INSERT trigger
-- captures all fourteen and everything added later, with no dispatcher touched.
--
-- ⚠ THE TRIGGER MUST NEVER BE ABLE TO BREAK A DISPATCH. It runs inside every
-- net.http_post, so an error here would take down ALL background dispatch —
-- the workforce, the drains, the drivers. Strictly worse than the blindness it
-- fixes. Every statement is therefore wrapped in an exception handler that
-- swallows everything: if logging fails, the dispatch still goes out and we
-- simply lose that one attribution. Losing a log line is acceptable; losing the
-- autonomy loop is not.
--
-- ⚠ SECOND-ORDER RISK, STATED: net.http_request_queue is owned by
-- supabase_admin and belongs to the pg_net extension. A pg_net upgrade that
-- recreates the table would drop this trigger silently, and dispatches would go
-- back to being unattributable with nothing to say so. The assertion in
-- migration 466's monitor cannot see it; check_dispatch_failures below reports
-- `attribution: 'unavailable'` when it finds no matching log rows, which makes
-- the loss visible in the alert itself rather than silent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.dispatch_log (
  request_id  bigint PRIMARY KEY,
  method      text,
  url         text,
  fn          text,           -- edge function slug parsed from the URL
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dispatch_log IS
  'Attribution for background HTTP dispatches: request_id -> which edge function. Written by a trigger on net.http_request_queue because that is the only place the URL exists; net._http_response keeps the id but not the target. Join on request_id to name a failure.';

CREATE INDEX IF NOT EXISTS dispatch_log_created_idx ON public.dispatch_log (created_at DESC);
CREATE INDEX IF NOT EXISTS dispatch_log_fn_idx      ON public.dispatch_log (fn, created_at DESC);

-- Platform-level infrastructure, not tenant data: no tenant_id, so no RLS
-- policy could be meaningful. Locked to the service role and the cron owner;
-- REVOKE strips the PUBLIC default (mig 361/426 lesson).
ALTER TABLE public.dispatch_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.net_dispatch_log_trg()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  -- ⚠ Swallow EVERYTHING. This runs inside net.http_post; raising here would
  -- break every background dispatch in the product. A missing log row is a
  -- diagnostic gap, a raised exception is an outage.
  BEGIN
    INSERT INTO public.dispatch_log (request_id, method, url, fn)
    VALUES (NEW.id, NEW.method, NEW.url,
            nullif(substring(NEW.url from '/functions/v1/([a-zA-Z0-9_-]+)'), ''))
    ON CONFLICT (request_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS net_dispatch_log ON net.http_request_queue;
CREATE TRIGGER net_dispatch_log
  AFTER INSERT ON net.http_request_queue
  FOR EACH ROW EXECUTE FUNCTION public.net_dispatch_log_trg();

-- ── Teach the alert to name what failed ────────────────────────────────────
DO $patch$
DECLARE v_src text; v_new text; v_hits int;
  a_detail text := '           ''failed'', v_failed, ''total'', v_total, ''sample_error'', v_sample,';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='check_dispatch_failures';
  IF v_src IS NULL THEN RAISE EXCEPTION '467: check_dispatch_failures not found'; END IF;
  IF v_src LIKE '%dispatch_log%' THEN RAISE NOTICE '467: already attributing'; RETURN; END IF;

  v_hits := (length(v_src) - length(replace(v_src, a_detail, ''))) / length(a_detail);
  IF v_hits <> 1 THEN RAISE EXCEPTION '467: expected 1 detail block, found %', v_hits; END IF;

  -- Adds: which functions failed, the status-code mix, and an explicit
  -- 'unavailable' marker when the trigger has stopped capturing — so the loss
  -- of attribution shows up in the alert rather than silently.
  v_new := replace(v_src, a_detail, a_detail || E'\n' ||
    '           ''by_function'', coalesce((' || E'\n' ||
    '             select jsonb_object_agg(coalesce(d.fn, ''(unattributed)''), c) from (' || E'\n' ||
    '               select d.fn, count(*) c from net._http_response r' || E'\n' ||
    '               left join dispatch_log d on d.request_id = r.id' || E'\n' ||
    '                where r.created > now() - interval ''1 hour''' || E'\n' ||
    '                  and (r.error_msg is not null or r.status_code >= 400)' || E'\n' ||
    '                group by d.fn) d), ''{}''::jsonb),' || E'\n' ||
    '           ''status_codes'', coalesce((' || E'\n' ||
    '             select jsonb_object_agg(coalesce(sc::text, ''timeout''), c) from (' || E'\n' ||
    '               select status_code sc, count(*) c from net._http_response' || E'\n' ||
    '                where created > now() - interval ''1 hour''' || E'\n' ||
    '                  and (error_msg is not null or status_code >= 400)' || E'\n' ||
    '                group by status_code) s), ''{}''::jsonb),' || E'\n' ||
    '           ''attribution'', case when exists (select 1 from dispatch_log' || E'\n' ||
    '                                   where created_at > now() - interval ''1 hour'')' || E'\n' ||
    '                                then ''ok'' else ''unavailable — is the net_dispatch_log trigger still installed?'' end,');

  IF v_new = v_src THEN RAISE EXCEPTION '467: the edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

-- Retention: attribution is only useful while the response rows it joins to
-- still exist, and those are pruned by pg_net well inside a day. 7 days is
-- generous and keeps the table trivially small.
DO $prune$
BEGIN
  PERFORM cron.unschedule('dispatch-log-prune');
EXCEPTION WHEN OTHERS THEN NULL;
END $prune$;
SELECT cron.schedule('dispatch-log-prune', '17 4 * * *',
  $$delete from public.dispatch_log where created_at < now() - interval '7 days'$$);

-- ── The connector-hub alert is stale: fixed 26 Jul, deployed 27 Jul ───────
-- The crash ("Cannot read properties of undefined (reading 'listRecent')") was
-- fixed in commit 3c70194 SEVEN MINUTES after the alert fired, and connector-hub
-- v63 carrying that fix deployed 2026-07-27 10:20:45Z. Zero recurrences in the
-- 14 hours since. Nothing to code; the alert simply outlived its cause.
UPDATE public.ops_alerts
   SET resolved_at = now()
 WHERE kind = 'edge_function_error'
   AND resolved_at IS NULL
   AND message ILIKE '%listRecent%';

DO $assert$
DECLARE v_def text; v_res jsonb; v_n int;
BEGIN
  -- The trigger exists and points at our function.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                   JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'http_request_queue' AND t.tgname = 'net_dispatch_log') THEN
    RAISE EXCEPTION '467: the attribution trigger was not created';
  END IF;

  -- ⚠ THE PROPERTY THAT MATTERS MOST: the trigger cannot break a dispatch.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='net_dispatch_log_trg';
  IF v_def NOT LIKE '%EXCEPTION WHEN OTHERS THEN%' THEN
    RAISE EXCEPTION '467: the trigger has no exception handler — a logging error would break ALL background dispatch';
  END IF;

  -- The alert now names what failed.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='check_dispatch_failures';
  IF v_def NOT LIKE '%by_function%' OR v_def NOT LIKE '%status_codes%' THEN
    RAISE EXCEPTION '467: check_dispatch_failures does not attribute';
  END IF;
  IF v_def NOT LIKE '%attribution%' THEN
    RAISE EXCEPTION '467: the attribution-unavailable marker is missing — losing the trigger would be silent';
  END IF;
  -- Its existing one-alert-per-hour dedupe must survive the splice.
  IF v_def NOT LIKE '%WHERE NOT EXISTS%' THEN
    RAISE EXCEPTION '467: the dedupe was lost — this would alert once per check';
  END IF;

  -- Behavioural: runs in the same auth context as cron, so this is a real test.
  SELECT public.check_dispatch_failures() INTO v_res;
  IF v_res->>'ok' IS NULL THEN RAISE EXCEPTION '467: the checker no longer returns its contract'; END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='dispatch-log-prune' AND active) THEN
    RAISE EXCEPTION '467: the retention job is missing or inactive';
  END IF;
  IF has_table_privilege('anon','public.dispatch_log','SELECT') THEN
    RAISE EXCEPTION '467: anon can read the dispatch log';
  END IF;

  SELECT count(*) INTO v_n FROM ops_alerts WHERE kind='edge_function_error' AND resolved_at IS NULL;
  RAISE NOTICE '467: dispatch attribution live; % unresolved edge_function_error remaining. First check said: %', v_n, v_res::text;
END $assert$;

NOTIFY pgrst, 'reload schema';
