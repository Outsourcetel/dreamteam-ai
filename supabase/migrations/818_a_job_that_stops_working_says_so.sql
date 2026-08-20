-- 818_a_job_that_stops_working_says_so.sql
-- ==========================================================================
-- WHY: 55 cron jobs run this platform. NOTHING HAS EVER ASKED WHETHER THEY
-- SUCCEED.
--
-- Four separate audits opened `cron.job` — every one of them to answer "who
-- CALLS this function?". None asked whether the caller worked. Measured on
-- 2026-08-20 against 187,959 retained run records (retention begins
-- 2026-07-04 18:00Z):
--
--     reconcile-blocked-goals-30min          ok   failed
--       2026-08-12                           45      3     <- last ok 22:00Z
--       2026-08-13                            0     48     <- 100%
--       2026-08-14                            0     48
--       2026-08-15                            0     48
--       2026-08-16                            0     48
--       2026-08-17                            0     48
--       2026-08-18                           28     20     <- fixed 09:24Z
--       2026-08-19                           48      0
--
--     ERROR: new row for relation "de_objectives" violates check constraint
--            "de_objectives_attention_flag_check"
--
-- A governance driver was dead from 2026-08-12 22:30Z to 2026-08-18 10:00Z —
-- five days and eleven hours, 263 consecutive failed runs — and the only thing
-- that ever said so was a human eventually finding it by hand. Migration 769
-- ("reconcile writes a flag the table allows", applied 2026-08-18 09:24:32Z)
-- is that human. The next tick after it landed, 10:00Z, succeeded.
--
-- ⚠ NOTHING IS FAILING AS THIS IS WRITTEN. Re-measured immediately before
-- building: every one of the 54 active jobs has zero failures in the last 24
-- hours, and the only two failures anywhere in the retained window are the 263
-- above plus one isolated `knowledge-conflict-probe-drain` run on 2026-08-04
-- that the next tick recovered from. This migration is not an incident report.
--
-- ==========================================================================
-- WHAT COUNTS AS BROKEN — the line, and the argument for it
-- ==========================================================================
--
-- A single failure is noise; five days is a catastrophe. The line cannot be a
-- count of failures, because a count means opposite things at opposite
-- cadences: three consecutive failures is fifteen minutes for `*/5` and nine
-- months for the quarterly review. So the measure is TIME WITHOUT A SUCCESS,
-- expressed in the job's OWN periods:
--
--     failing  :=  no success for  least( greatest(3 x period, 1 hour), 24 hours )
--                  AND at least one FAILED run in that gap
--     silent   :=  it used to run and has not run at all for
--                  greatest(3 x period, 1 hour)              -- no 24h ceiling
--
-- THREE PERIODS, because one alerts on every blip and two is a coin-flip
-- against transient contention — `reconcile-blocked-goals-30min` has a real
-- `deadlock detected` in its history, recovered on the next tick, and that must
-- never page anyone. Three consecutive missed successes is a pattern.
--
-- THE 1-HOUR FLOOR, because `knowledge-ingest-drain` runs every 2 minutes and
-- 3 periods is 6 minutes. A deploy or a lock wait can eat six minutes. Below an
-- hour nobody wants to be told.
--
-- THE 24-HOUR CEILING, because it is what makes the rule differ correctly
-- between a 5-minute job and a quarterly one. A fast job that fails self-heals
-- on the next tick, so it gets 3 chances. A DAILY job gets one chance a day and
-- a QUARTERLY job gets one chance a quarter — for them a single failure is
-- already the whole outage, and waiting 3 periods would mean waiting until
-- October to mention that July's run died. The ceiling says: whatever the
-- cadence, no job may be failing for more than 24 hours without saying so.
-- Between the floor and the ceiling the line is the job's own rhythm.
--
-- ⚠ THE SILENT ARM HAS NO CEILING, deliberately. Absence of runs is normal for
-- a slow job — a weekly job is legitimately silent for 7 days. Applying the
-- 24-hour ceiling there would alert on every daily job every night.
--
-- ==========================================================================
-- THE TWO JOBS THAT LOOK BROKEN AND ARE NOT
-- ==========================================================================
--
-- `de-performance-review-quarterly` (`0 7 1 1,4,7,10 *`, ACTIVE) has ZERO run
-- records. Not because it is broken — because it last fired 2026-07-01 and
-- retention starts 2026-07-04. Its next fire is 2026-10-01. A naive "no
-- successful run recently" detector calls that broken; it is not.
--
-- `approved-action-driver-5min` (`*/5 * * * *`) is INACTIVE with zero runs.
--
-- Both are handled by the same rule, and it is a rule about what this data can
-- and cannot prove:
--
--   · A job with NO RUN RECORD AT ALL is `never_observed`, and NEVER alerts.
--     Three different causes produce that one observation — created but not yet
--     due, period longer than retention, genuinely never firing — and
--     `cron.job` carries no created_at, so nothing here can tell them apart. A
--     detector that cannot tell must not assert. It is REPORTED by
--     cron_health_status() so a human can look; it is not shouted about.
--
--   · A job with `active = false` is `disabled`, and NEVER alerts. Somebody
--     ran `cron.alter_job(..., active := false)`. That is a DECISION, not a
--     fault, and alerting on decisions is how a channel gets ignored. Also
--     reported, never raised.
--
-- The silent arm therefore only ever fires on a job that HAS run before and
-- then stopped — where the cadence is observed fact, not a guess.
--
-- ==========================================================================
-- THE CHANNEL — measured, not assumed
-- ==========================================================================
--
-- public.raise_ops_alert(kind, message, detail) already exists, is read by
-- src/components/OpsAlertsBanner.tsx, and a prior note warns that it "dedupes
-- on kind GLOBALLY". Read before relying on it. What it ACTUALLY does:
--
--     IF EXISTS (SELECT 1 FROM ops_alerts
--                 WHERE kind = p_kind AND resolved_at IS NULL
--                   AND created_at > now() - interval '1 hour')
--     THEN RETURN; END IF;
--
-- so it is (a) global across tenants and jobs, and (b) a ONE-HOUR rate limit,
-- not a suppression — an open alert older than an hour does not stop a second
-- row. Both halves matter:
--
--   · one shared kind would have named the FIRST broken job and gone silent
--     about every other one for an hour. So the kind carries the job:
--     `cron_job_broken:<jobname>`. `ops_alerts.kind` is free text with no CHECK
--     constraint, and this is the established shape here — `value_digest_
--     2026-W34_<tenant>` already namespaces the same way.
--
--   · the hourly re-raise would have written ~131 rows for the single
--     reconcile-blocked-goals outage. So the scan raises only when NO open
--     alert of that kind exists, and otherwise UPDATEs the open row's message
--     and detail in place. One row per outage per job, whose created_at is the
--     moment the outage was first noticed and whose text stays current as it
--     drags on. raise_ops_alert's own dedup window is therefore never the thing
--     holding the line; it is not fought either.
--
-- RECOVERY CLEARS IT. Every tick, any job whose verdict is not failing/silent
-- has its open `cron_job_broken:` alert resolved. Replayed against the real
-- history, the alert raised at 2026-08-12 23:45Z would have cleared itself at
-- 2026-08-18 10:15Z without anyone touching it.
--
-- ==========================================================================
-- ⚠⚠ WHO WATCHES THIS ONE — stated plainly, because it is NOT fully covered
-- ==========================================================================
--
-- The detector is a cron job. If it stops, nothing in this database reports
-- that, and saying otherwise would be exactly the theatre this migration
-- exists to end. Precisely:
--
--   · Self-inclusion covers NOTHING. It scans every active job including
--     itself, but a permanently dead detector is not running to notice its own
--     death, and a transiently failed one has a fresh success by the time it
--     next looks. This is written down because "it watches itself" is the
--     comforting sentence that would otherwise get written here.
--   · A SECOND in-database watchdog was considered and rejected: both watchers
--     share pg_cron, so the failure that matters most takes both.
--   · WHAT IS COVERED: staleness is made VISIBLE rather than silent.
--     cron_health_status() reports the detector's own last successful run and
--     how long ago it was, in the same payload as the findings — so anyone who
--     opens the channel sees "detector last ran 4 days ago" instead of an
--     empty list that looks like good news. And scripts/cron-detector-liveness.mjs
--     exits non-zero when that timestamp is stale.
--   · WHAT IS NOT: that script is not wired into CI or `certify` by this
--     change, so today the outermost watcher is a person running one command.
--     Until it is wired in, a dead detector is quiet.
--
-- ==========================================================================
-- ⚠ REPLAYABILITY. Every assertion in the verification block below is either
-- about SCHEMA (pg_proc, cron.job, grants) or about the PURE predicate
-- functions called with literal arguments. None of them requires production's
-- rows, so `npm run audit:replayable` passes and this file replays into an
-- empty database. The historical replay is REPORTED, and its one assertion is
-- guarded on the data being present — vacuously true where it is not.
-- ==========================================================================

begin;

-- ── 0. Precondition ───────────────────────────────────────────────────────
-- Not an assertion about rows: an assertion that the objects this migration
-- reads and schedules against exist at all. Without pg_cron the cron.schedule
-- call below could not run either, so failing here is failing earlier and
-- louder rather than differently.
do $pre$
begin
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    raise exception '818: pg_cron is not installed (cron.job / cron.job_run_details missing) — the detector has nothing to read.';
  end if;
  if to_regprocedure('public.raise_ops_alert(text,text,jsonb)') is null then
    raise exception '818: public.raise_ops_alert(text,text,jsonb) is missing — this migration deliberately does not invent a second alert channel.';
  end if;
  if to_regclass('public.ops_alerts') is null then
    raise exception '818: public.ops_alerts is missing.';
  end if;
end $pre$;

-- ── 1. How often is this job SUPPOSED to run? ─────────────────────────────
-- A cron expression, reduced to the interval between two fires. Deliberately
-- narrow: it recognises the shapes this platform actually uses and returns
-- NULL for anything else, because a confident wrong period is worse than an
-- admitted unknown — NULL routes the job to the measured fallback in
-- cron_health_findings, and if that is also unavailable the verdict is
-- `unjudgeable` and nothing is claimed about it.
--
-- Validated against all 55 live schedules before this was written: 0
-- unparseable, and on the 48 jobs with enough history to measure a median gap,
-- the parsed period equalled the measured one every time. Two independent
-- methods, no disagreements.
create or replace function public.cron_schedule_period(p_schedule text)
returns interval
language plpgsql
immutable
set search_path to 'public'
as $$
declare
  f  text[];
  mi text; hr text; dm text; mo text; dw text;
begin
  if p_schedule is null then return null; end if;
  f := regexp_split_to_array(regexp_replace(btrim(p_schedule), '\s+', ' ', 'g'), ' ');
  if array_length(f, 1) <> 5 then return null; end if;
  mi := f[1]; hr := f[2]; dm := f[3]; mo := f[4]; dw := f[5];

  -- */N * * * *  -> every N minutes
  if mi ~ '^\*/[0-9]+$' and hr = '*' then
    return make_interval(mins => substring(mi from 3)::int);
  end if;
  -- M * * * *    -> hourly
  if mi ~ '^[0-9]+$' and hr = '*' then
    return interval '1 hour';
  end if;
  -- M */N * * *  -> every N hours
  if mi ~ '^[0-9]+$' and hr ~ '^\*/[0-9]+$' then
    return make_interval(hours => substring(hr from 3)::int);
  end if;
  -- M H * * *    -> daily
  if mi ~ '^[0-9]+$' and hr ~ '^[0-9]+$' and dm = '*' and mo = '*' and dw = '*' then
    return interval '1 day';
  end if;
  -- M H * * D    -> weekly
  if mi ~ '^[0-9]+$' and hr ~ '^[0-9]+$' and dm = '*' and mo = '*' and dw ~ '^[0-9]$' then
    return interval '7 days';
  end if;
  -- M H D <month list> *  -> once per listed month
  if mi ~ '^[0-9]+$' and hr ~ '^[0-9]+$' and dm ~ '^[0-9]+$' and mo ~ '^[0-9]+(,[0-9]+)*$' then
    return make_interval(days => (365 / array_length(string_to_array(mo, ','), 1))::int);
  end if;

  return null;
end $$;

-- ── 2. THE PREDICATE, as a pure function of its arguments ─────────────────
-- Separated from the gathering ON PURPOSE. A verdict that reads cron.* can
-- only be tested against whatever production happens to contain today; a
-- verdict that takes seven scalars can be pinned with literals, inverted one
-- argument at a time, and replayed identically in an empty database. Every
-- assertion at the bottom of this file drives THIS function.
create or replace function public.cron_health_verdict(
  p_active       boolean,
  p_period       interval,
  p_as_of        timestamptz,
  p_last_success timestamptz,
  p_last_run     timestamptz,
  p_first_run    timestamptz,
  p_fails_since  integer
) returns text
language plpgsql
immutable
set search_path to 'public'
as $$
declare
  v_silent_grace interval;
  v_fail_grace   interval;
  v_since        timestamptz;
begin
  -- A decision, not a fault.
  if not coalesce(p_active, false) then return 'disabled'; end if;
  -- Three causes, one observation. Nothing may be asserted.
  if p_last_run is null then return 'never_observed'; end if;
  -- No period from either the parser or the history: say so rather than guess.
  if p_period is null or p_period <= interval '0' then return 'unjudgeable'; end if;

  -- It used to run and has stopped. No ceiling: slow jobs are silent for long
  -- stretches by design.
  v_silent_grace := greatest(3 * p_period, interval '1 hour');
  if p_as_of - p_last_run > v_silent_grace then return 'silent'; end if;

  -- It is running and erroring. Floor 1h (fast jobs blip), ceiling 24h (slow
  -- jobs cannot self-heal, so their one missed chance IS the outage).
  v_fail_grace := least(greatest(3 * p_period, interval '1 hour'), interval '24 hours');
  v_since      := coalesce(p_last_success, p_first_run);
  if coalesce(p_fails_since, 0) >= 1 and v_since is not null
     and p_as_of - v_since > v_fail_grace then
    return 'failing';
  end if;

  return 'ok';
end $$;

-- ── 3. The gathering ──────────────────────────────────────────────────────
-- p_as_of exists so the predicate can be replayed over real history at a
-- historical instant, using THE FUNCTION ITSELF rather than a second
-- implementation of it in another language. It only ever narrows what is READ;
-- it cannot write anything.
create or replace function public.cron_health_findings(p_as_of timestamptz default now())
returns table (
  jobid         bigint,
  jobname       text,
  schedule      text,
  active        boolean,
  period        interval,
  period_source text,
  last_run      timestamptz,
  last_success  timestamptz,
  first_run     timestamptz,
  fails_since   integer,
  verdict       text,
  headline      text,
  detail        jsonb
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with agg as (
    select x.jobid,
           max(x.start_time)                                       as last_run,
           min(x.start_time)                                       as first_run,
           max(x.start_time) filter (where x.status = 'succeeded') as last_success,
           count(*) filter (
             where x.status = 'failed'
               and x.start_time > coalesce(x.ls, '-infinity'::timestamptz)
           )::int                                                  as fails_since,
           -- First line only, and capped. pg_cron stores the whole error
           -- including a DETAIL that quotes the offending ROW — tenant id,
           -- employee id, free text. That belongs in the log, not copied into
           -- an alert message; the ERROR line alone is what tells a human what
           -- broke.
           (array_agg(left(split_part(coalesce(x.return_message, ''), E'\n', 1), 200) order by x.start_time desc)
              filter (where x.status = 'failed'))[1]               as last_error
      from (
        select d.jobid, d.start_time, d.status, d.return_message,
               max(d.start_time) filter (where d.status = 'succeeded')
                 over (partition by d.jobid) as ls
          from cron.job_run_details d
         where d.start_time <= p_as_of
      ) x
     group by x.jobid
  ),
  -- Fallback only. Computed for the jobs whose schedule the parser could not
  -- read — today that set is empty, so this scans nothing. A job that is
  -- unwatchable because nobody taught the parser its syntax would be a silent
  -- hole, so the history answers where the text cannot.
  gaps as (
    select g.jobid, percentile_disc(0.5) within group (order by g.gap) as med
      from (
        select d.jobid,
               d.start_time - lag(d.start_time) over (partition by d.jobid order by d.start_time) as gap
          from cron.job_run_details d
         where d.start_time <= p_as_of
           and d.jobid in (select j2.jobid
                             from cron.job j2
                            where public.cron_schedule_period(j2.schedule) is null)
      ) g
     where g.gap is not null
     group by g.jobid
  ),
  j as (
    select cj.jobid, cj.jobname, cj.schedule, cj.active,
           coalesce(public.cron_schedule_period(cj.schedule), gaps.med) as period,
           case when public.cron_schedule_period(cj.schedule) is not null then 'parsed'
                when gaps.med is not null                               then 'measured'
                else 'unknown' end                                      as period_source,
           agg.last_run, agg.last_success, agg.first_run,
           coalesce(agg.fails_since, 0) as fails_since,
           agg.last_error
      from cron.job cj
      left join agg  on agg.jobid  = cj.jobid
      left join gaps on gaps.jobid = cj.jobid
  ),
  v as (
    select j.*,
           public.cron_health_verdict(j.active, j.period, p_as_of,
                                      j.last_success, j.last_run, j.first_run, j.fails_since) as verdict
      from j
  )
  select v.jobid, v.jobname, v.schedule, v.active, v.period, v.period_source,
         v.last_run, v.last_success, v.first_run, v.fails_since, v.verdict,
         case v.verdict
           when 'failing' then format(
             'Scheduled job "%s" (%s) has not succeeded since %s — %s failed run(s) since, %s without a success.%s',
             v.jobname, v.schedule,
             coalesce(to_char(v.last_success at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z', 'ever'),
             v.fails_since::text,
             date_trunc('minute', p_as_of - coalesce(v.last_success, v.first_run))::text,
             coalesce(' Last error: ' || v.last_error, ''))
           when 'silent' then format(
             'Scheduled job "%s" (%s) has not run at all since %s — %s of silence on a %s schedule. It is still marked active, so the scheduler should have fired it.',
             v.jobname, v.schedule,
             to_char(v.last_run at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z',
             date_trunc('minute', p_as_of - v.last_run)::text,
             v.period::text)
           when 'unjudgeable' then format(
             'Scheduled job "%s" has schedule "%s", which neither the parser nor its own run history can turn into a period. It is NOT being watched.',
             v.jobname, v.schedule)
           when 'disabled' then format('Scheduled job "%s" is inactive — a decision, reported not alerted.', v.jobname)
           when 'never_observed' then format(
             'Scheduled job "%s" (%s) has no run record in the retained window. Cause is not determinable from this data — reported, not alerted.',
             v.jobname, v.schedule)
           else format('Scheduled job "%s" is healthy.', v.jobname)
         end as headline,
         jsonb_build_object(
           'jobid', v.jobid, 'jobname', v.jobname, 'schedule', v.schedule,
           'active', v.active, 'verdict', v.verdict,
           'period', v.period::text, 'period_source', v.period_source,
           'as_of', p_as_of, 'last_run', v.last_run, 'last_success', v.last_success,
           'first_run', v.first_run, 'failed_runs_since_last_success', v.fails_since,
           'last_error', v.last_error
         ) as detail
    from v;
$$;

-- ── 4. The scan: raise, freshen, resolve ──────────────────────────────────
-- ⚠ p_as_of EXISTS SO THE WRITE PATH CAN BE REPLAYED, and it is the difference
-- between proving a predicate and proving a detector. Without it the only way
-- to test "does it actually raise?" is to wait for something to break. With it,
-- the verification block below drives THIS function over the real August 2026
-- outage inside a rolled-back transaction and watches the alert appear and then
-- clear itself. The scheduled caller never passes it (`select
-- public.cron_health_scan()`), and EXECUTE is revoked from anon and
-- authenticated, so the reachable surface is postgres and service_role. Named
-- rather than hidden: a caller who passes a past timestamp WILL write alerts
-- describing that moment.
create or replace function public.cron_health_scan(p_as_of timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_now       timestamptz := p_as_of;
  r           record;
  v_kind      text;
  v_open      uuid;
  v_raised    int := 0;
  v_freshened int := 0;
  v_resolved  int := 0;
  v_seen      int := 0;
  v_broken    text[] := '{}';
begin
  for r in select * from public.cron_health_findings(v_now) loop
    v_seen := v_seen + 1;
    v_kind := format('cron_job_broken:%s', r.jobname);

    select a.id into v_open
      from ops_alerts a
     where a.kind = v_kind and a.resolved_at is null
     order by a.created_at
     limit 1;

    if r.verdict in ('failing', 'silent', 'unjudgeable') then
      v_broken := array_append(v_broken, r.jobname);
      if v_open is null then
        -- No open alert for THIS job: start one. raise_ops_alert's own hourly
        -- window cannot suppress it, because an open alert is exactly the case
        -- this branch does not reach.
        perform public.raise_ops_alert(v_kind, r.headline, r.detail);
        v_raised := v_raised + 1;
      else
        -- The outage is still open. Keep ONE row and keep it current, rather
        -- than letting raise_ops_alert append a new one every hour. created_at
        -- stays the moment it was first noticed, which is the fact worth
        -- keeping.
        update ops_alerts
           set message = r.headline, detail = r.detail
         where id = v_open;
        v_freshened := v_freshened + 1;
      end if;
    elsif v_open is not null then
      -- RECOVERY. Without this the first outage poisons the channel forever.
      -- Scoped to this kind only: no other alert type is ever touched here.
      update ops_alerts
         set resolved_at = v_now
       where kind = v_kind and resolved_at is null;
      v_resolved := v_resolved + 1;
    end if;

    v_open := null;
  end loop;

  return jsonb_build_object(
    'at', v_now, 'jobs_examined', v_seen, 'raised', v_raised,
    'freshened', v_freshened, 'resolved', v_resolved,
    'broken', to_jsonb(v_broken));
end $$;

-- ── 5. Reading the channel — and seeing whether the detector is alive ─────
-- The findings and the detector's own liveness in ONE payload, so an empty
-- findings list can never be mistaken for good news by someone whose detector
-- died four days ago.
create or replace function public.cron_health_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_last_scan timestamptz;
  v_scan_job  boolean;
begin
  if not public.is_platform_admin() then
    raise exception 'cron_health_status: platform admin only';
  end if;

  select exists (select 1 from cron.job where jobname = 'cron-health-scan-15min' and active)
    into v_scan_job;
  select max(d.start_time) into v_last_scan
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
   where j.jobname = 'cron-health-scan-15min' and d.status = 'succeeded';

  return jsonb_build_object(
    'detector', jsonb_build_object(
      'scheduled_and_active', coalesce(v_scan_job, false),
      'last_successful_scan', v_last_scan,
      'scan_age', case when v_last_scan is null then null
                       else date_trunc('minute', now() - v_last_scan)::text end,
      'stale', case when not coalesce(v_scan_job, false) then true
                    when v_last_scan is null then true
                    else now() - v_last_scan > interval '1 hour' end,
      'note', 'A dead detector cannot report its own death. This timestamp is the reason silence is not proof.'),
    'counts', (select jsonb_object_agg(verdict, n)
                 from (select f.verdict, count(*) n
                         from public.cron_health_findings() f group by f.verdict) c),
    'findings', coalesce((select jsonb_agg(f.detail order by f.jobname)
                            from public.cron_health_findings() f
                           where f.verdict in ('failing', 'silent', 'unjudgeable')), '[]'::jsonb),
    'not_alerted', coalesce((select jsonb_agg(jsonb_build_object('jobname', f.jobname, 'verdict', f.verdict, 'why', f.headline) order by f.jobname)
                               from public.cron_health_findings() f
                              where f.verdict in ('disabled', 'never_observed')), '[]'::jsonb),
    'open_alerts', coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'since', a.created_at, 'message', a.message) order by a.created_at)
                               from ops_alerts a
                              where a.resolved_at is null and a.kind like 'cron\_job\_broken:%'), '[]'::jsonb));
end $$;

-- ── 6. Grants ─────────────────────────────────────────────────────────────
-- Default EXECUTE goes to PUBLIC (and this project also grants anon and
-- authenticated at creation time), so every one of these is revoked explicitly
-- before anything is granted back. cron_health_scan is machinery: the cron job
-- runs it as postgres and nothing in the product should call it.
revoke all on function public.cron_schedule_period(text)                                                                   from public, anon, authenticated;
revoke all on function public.cron_health_verdict(boolean, interval, timestamptz, timestamptz, timestamptz, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.cron_health_findings(timestamptz)                                                            from public, anon, authenticated;
revoke all on function public.cron_health_scan(timestamptz)                                                                from public, anon, authenticated;
revoke all on function public.cron_health_status()                                                                         from public, anon, authenticated;

grant execute on function public.cron_health_scan(timestamptz) to service_role;
grant execute on function public.cron_health_status() to authenticated, service_role;

-- ── 7. Schedule it ────────────────────────────────────────────────────────
-- Every 15 minutes. The tightest grace this rule can ever apply is one hour,
-- so a 15-minute cadence detects well inside the resolution that matters and a
-- 5-minute one would triple the work for nothing.
do $sched$
begin
  if exists (select 1 from cron.job where jobname = 'cron-health-scan-15min') then
    perform cron.unschedule('cron-health-scan-15min');
  end if;
  perform cron.schedule('cron-health-scan-15min', '*/15 * * * *', 'select public.cron_health_scan()');
end $sched$;

-- ==========================================================================
-- VERIFICATION
--
-- ⚠ The probe counter is not decoration. A probe that cannot RUN is counted as
-- a failure, never as a skip, because "0 findings from 0 comparisons" and "0
-- findings from 340 comparisons" print the same word.
-- ==========================================================================
do $verify$
declare
  v_bad        text[] := '{}';
  v_report     text[] := '{}';
  v_checks     int := 0;   -- data-INDEPENDENT assertions actually evaluated
  v_probes_try int := 0;
  v_probes_ok  int := 0;
  v_t          text;
  v_n          int;
  v_i          int;
  v_id         uuid;
  v_before     int;
  v_after      int;
  v_json       jsonb;
  -- The real incident, as literals. 30-minute job; last success 22:00Z on
  -- 08-12; three failures by 23:30Z; grace = 3 x 30min = 90 min.
  c_period  constant interval    := interval '30 minutes';
  c_success constant timestamptz := '2026-08-12 22:00:00+00';
  c_first   constant timestamptz := '2026-07-28 12:00:00+00';
begin

  ----------------------------------------------------------------------
  -- PROBE 1 — the schedule parser reads every shape this platform uses.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    for v_i in 1..1 loop
      v_checks := v_checks + 1;
      if public.cron_schedule_period('*/5 * * * *') <> interval '5 minutes' then
        v_bad := array_append(v_bad, format('parser: */5 * * * * -> %s, expected 5 minutes', public.cron_schedule_period('*/5 * * * *')::text));
      end if;
      v_checks := v_checks + 1;
      if public.cron_schedule_period('*/2 * * * *') <> interval '2 minutes' then
        v_bad := array_append(v_bad, 'parser: */2 * * * * should be 2 minutes'::text);
      end if;
      v_checks := v_checks + 1;
      if public.cron_schedule_period('*/30 * * * *') <> interval '30 minutes' then
        v_bad := array_append(v_bad, 'parser: */30 * * * * should be 30 minutes'::text);
      end if;
      v_checks := v_checks + 1;
      if public.cron_schedule_period('7 * * * *') <> interval '1 hour' then
        v_bad := array_append(v_bad, 'parser: 7 * * * * should be 1 hour'::text);
      end if;
      v_checks := v_checks + 1;
      if public.cron_schedule_period('20 */6 * * *') <> interval '6 hours' then
        v_bad := array_append(v_bad, 'parser: 20 */6 * * * should be 6 hours'::text);
      end if;
      v_checks := v_checks + 1;
      if public.cron_schedule_period('20 7 * * *') <> interval '1 day' then
        v_bad := array_append(v_bad, 'parser: 20 7 * * * should be 1 day'::text);
      end if;
      v_checks := v_checks + 1;
      if public.cron_schedule_period('20 6 * * 1') <> interval '7 days' then
        v_bad := array_append(v_bad, 'parser: 20 6 * * 1 should be 7 days'::text);
      end if;
      v_checks := v_checks + 1;
      if public.cron_schedule_period('0 7 1 1,4,7,10 *') <> interval '91 days' then
        v_bad := array_append(v_bad, format('parser: quarterly -> %s, expected 91 days', public.cron_schedule_period('0 7 1 1,4,7,10 *')::text));
      end if;
    end loop;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 1 (parser shapes) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 2 — INVERTED. The parser must ADMIT it cannot read something.
  -- A parser that always returns a number would make every job look
  -- watched; NULL is what routes a job to `unjudgeable` and gets it said
  -- out loud instead of silently dropped.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    v_checks := v_checks + 1;
    if public.cron_schedule_period('0 7 * * 1-5') is not null then
      v_bad := array_append(v_bad, 'parser: a day-of-week RANGE is not supported and must return NULL, not a guess'::text);
    end if;
    v_checks := v_checks + 1;
    if public.cron_schedule_period('nonsense') is not null then
      v_bad := array_append(v_bad, 'parser: garbage must return NULL'::text);
    end if;
    v_checks := v_checks + 1;
    if public.cron_schedule_period(null) is not null then
      v_bad := array_append(v_bad, 'parser: NULL in, NULL out'::text);
    end if;
    v_checks := v_checks + 1;
    if public.cron_schedule_period('*/5 * * *') is not null then
      v_bad := array_append(v_bad, 'parser: a four-field expression is not a cron schedule'::text);
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 2 (parser refuses) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 3 — THE REAL INCIDENT, replayed through the real predicate with
  -- literal arguments. At 2026-08-12 23:45Z the job had 3 failures and
  -- 1h45m without a success, against a 1h30m grace. It must say `failing`.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, c_period, '2026-08-12 23:45:00+00', c_success, '2026-08-12 23:30:00+00', c_first, 3);
    if v_t <> 'failing' then
      v_bad := array_append(v_bad, format('reconcile-blocked-goals at 2026-08-12 23:45Z should be `failing`, got `%s`', v_t));
    end if;
    v_report := array_append(v_report, format('08-12 23:45Z (1h45m, 3 fails, 30min job) -> %s', v_t));

    -- And still failing five days later, which is the whole point.
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, c_period, '2026-08-17 12:00:00+00', c_success, '2026-08-17 11:30:00+00', c_first, 227);
    if v_t <> 'failing' then
      v_bad := array_append(v_bad, format('reconcile-blocked-goals on day 5 should still be `failing`, got `%s`', v_t));
    end if;
    v_report := array_append(v_report, format('08-17 12:00Z (day 5, 227 fails)        -> %s', v_t));

    -- And healthy again the moment 769 landed and 10:00Z succeeded.
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, c_period, '2026-08-18 10:15:00+00', '2026-08-18 10:00:00+00', '2026-08-18 10:00:00+00', c_first, 0);
    if v_t <> 'ok' then
      v_bad := array_append(v_bad, format('after the 2026-08-18 10:00Z recovery the verdict must be `ok`, got `%s`', v_t));
    end if;
    v_report := array_append(v_report, format('08-18 10:15Z (recovered)               -> %s  (alert auto-resolves)', v_t));
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 3 (the real incident) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 4 — INVERTED, one argument at a time. Each line changes exactly
  -- ONE input of the PROBE 3 call and must flip the verdict. Without these
  -- `failing` could be a constant.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    -- no failures in the gap -> the job is simply idle, not broken
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, c_period, '2026-08-12 23:45:00+00', c_success, '2026-08-12 23:30:00+00', c_first, 0);
    if v_t <> 'ok' then
      v_bad := array_append(v_bad, format('INVERSION fails_since=0 should be `ok`, got `%s`', v_t));
    end if;
    -- inside the grace (60 min < 90 min) -> a blip, not an outage
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, c_period, '2026-08-12 23:00:00+00', c_success, '2026-08-12 23:00:00+00', c_first, 2);
    if v_t <> 'ok' then
      v_bad := array_append(v_bad, format('INVERSION 60min gap (grace 90min) should be `ok`, got `%s`', v_t));
    end if;
    -- inactive -> a decision
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(false, c_period, '2026-08-12 23:45:00+00', c_success, '2026-08-12 23:30:00+00', c_first, 3);
    if v_t <> 'disabled' then
      v_bad := array_append(v_bad, format('INVERSION active=false should be `disabled`, got `%s`', v_t));
    end if;
    -- no period at all -> admitted, not guessed
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, null, '2026-08-12 23:45:00+00', c_success, '2026-08-12 23:30:00+00', c_first, 3);
    if v_t <> 'unjudgeable' then
      v_bad := array_append(v_bad, format('INVERSION period=NULL should be `unjudgeable`, got `%s`', v_t));
    end if;
    -- exactly ON the boundary is not past it
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, c_period, '2026-08-12 23:30:00+00', c_success, '2026-08-12 23:30:00+00', c_first, 2);
    if v_t <> 'ok' then
      v_bad := array_append(v_bad, format('INVERSION gap == grace exactly should be `ok`, got `%s`', v_t));
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 4 (inversions) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 5 — THE QUARTERLY TRAP. de-performance-review-quarterly is ACTIVE
  -- with zero runs, because it last fired 2026-07-01 and retention starts
  -- 2026-07-04. It must NOT be called broken — and the INVERTED half proves
  -- that is a rule about missing evidence, not a special case for one name.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, public.cron_schedule_period('0 7 1 1,4,7,10 *'),
                                      '2026-08-20 13:50:00+00', null, null, null, 0);
    if v_t <> 'never_observed' then
      v_bad := array_append(v_bad, format('the quarterly job with no runs must be `never_observed`, got `%s`', v_t));
    end if;
    v_report := array_append(v_report, format('de-performance-review-quarterly (0 runs) -> %s  (reported, never alerted)', v_t));

    -- INVERTED: the SAME job, once it has actually run and then failed, IS
    -- broken within 24 hours — because the ceiling means a job that only gets
    -- one chance a quarter does not get to wait 273 days to be mentioned.
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '91 days', '2026-10-02 08:00:00+00',
                                      '2026-07-01 07:00:00+00', '2026-10-01 07:00:00+00', '2026-04-01 07:00:00+00', 1);
    if v_t <> 'failing' then
      v_bad := array_append(v_bad, format('a quarterly job that RAN and failed must be `failing` inside 24h, got `%s`', v_t));
    end if;

    -- and 12 hours after that failure it is still inside the ceiling
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '91 days', '2026-10-01 19:00:00+00',
                                      '2026-07-01 07:00:00+00', '2026-10-01 07:00:00+00', '2026-04-01 07:00:00+00', 1);
    if v_t <> 'failing' then
      v_bad := array_append(v_bad, format('a quarterly job 12h after failing: last success is a quarter old, so `failing`, got `%s`', v_t));
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 5 (quarterly trap) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 6 — THE FLOOR AND THE CEILING both bind, in both directions.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    -- knowledge-ingest-drain: 2-minute job. 3 periods is 6 minutes; the floor
    -- says an hour, so 30 minutes of failure is still `ok`.
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '2 minutes', '2026-08-20 12:30:00+00',
                                      '2026-08-20 12:00:00+00', '2026-08-20 12:28:00+00', c_first, 14);
    if v_t <> 'ok' then
      v_bad := array_append(v_bad, format('FLOOR: a 2-minute job failing for 30 minutes must be `ok`, got `%s`', v_t));
    end if;
    -- INVERTED: past the hour it is not
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '2 minutes', '2026-08-20 13:10:00+00',
                                      '2026-08-20 12:00:00+00', '2026-08-20 13:08:00+00', c_first, 35);
    if v_t <> 'failing' then
      v_bad := array_append(v_bad, format('FLOOR: a 2-minute job failing for 70 minutes must be `failing`, got `%s`', v_t));
    end if;
    -- weekly job: 3 periods is 21 days, but the ceiling caps the FAILING arm
    -- at 24 hours, so 25 hours of no success with a failure is broken.
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '7 days', '2026-08-18 07:20:00+00',
                                      '2026-08-11 06:20:00+00', '2026-08-17 06:20:00+00', c_first, 1);
    if v_t <> 'failing' then
      v_bad := array_append(v_bad, format('CEILING: a weekly job whose run failed must be `failing` within 24h, got `%s`', v_t));
    end if;
    -- INVERTED: the same weekly job whose run SUCCEEDED is silent-but-fine for
    -- days, because the silent arm has no ceiling.
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '7 days', '2026-08-20 13:50:00+00',
                                      '2026-08-17 06:20:00+00', '2026-08-17 06:20:00+00', c_first, 0);
    if v_t <> 'ok' then
      v_bad := array_append(v_bad, format('a weekly job 3 days after a SUCCESS must be `ok`, got `%s`', v_t));
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 6 (floor and ceiling) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 7 — THE SILENT ARM: a job that stopped being fired at all.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    -- a 5-minute job last seen 2 hours ago: the scheduler has stopped
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '5 minutes', '2026-08-20 14:00:00+00',
                                      '2026-08-20 12:00:00+00', '2026-08-20 12:00:00+00', c_first, 0);
    if v_t <> 'silent' then
      v_bad := array_append(v_bad, format('SILENT: a 5-minute job absent for 2 hours must be `silent`, got `%s`', v_t));
    end if;
    -- INVERTED: absent for 20 minutes is 4 ticks but under the 1h floor
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '5 minutes', '2026-08-20 12:20:00+00',
                                      '2026-08-20 12:00:00+00', '2026-08-20 12:00:00+00', c_first, 0);
    if v_t <> 'ok' then
      v_bad := array_append(v_bad, format('SILENT: 20 minutes is inside the 1h floor, expected `ok`, got `%s`', v_t));
    end if;
    -- a daily job absent for 4 days
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '1 day', '2026-08-20 08:00:00+00',
                                      '2026-08-16 07:20:00+00', '2026-08-16 07:20:00+00', c_first, 0);
    if v_t <> 'silent' then
      v_bad := array_append(v_bad, format('SILENT: a daily job absent 4 days must be `silent`, got `%s`', v_t));
    end if;
    -- INVERTED: the same daily job absent 2 days is inside 3 periods
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '1 day', '2026-08-18 08:00:00+00',
                                      '2026-08-16 07:20:00+00', '2026-08-16 07:20:00+00', c_first, 0);
    if v_t <> 'ok' then
      v_bad := array_append(v_bad, format('SILENT: a daily job absent 2 days is inside 3 periods, expected `ok`, got `%s`', v_t));
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 7 (silent arm) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 8 — THE ISOLATED FAILURE STAYS QUIET. knowledge-conflict-probe-drain
  -- failed once, at 2026-08-04 12:15Z, and the 12:30Z tick recovered. 7,147
  -- successes. If this rule alerted on that, it would be noise machinery.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '15 minutes', '2026-08-04 12:20:00+00',
                                      '2026-08-04 12:00:00+00', '2026-08-04 12:15:00+00', c_first, 1);
    if v_t <> 'ok' then
      v_bad := array_append(v_bad, format('a single 15-minute failure must stay quiet, got `%s`', v_t));
    end if;
    v_report := array_append(v_report, format('knowledge-conflict-probe-drain single failure 08-04 -> %s', v_t));
    v_checks := v_checks + 1;
    v_t := public.cron_health_verdict(true, interval '15 minutes', '2026-08-04 12:35:00+00',
                                      '2026-08-04 12:30:00+00', '2026-08-04 12:30:00+00', c_first, 0);
    if v_t <> 'ok' then
      v_bad := array_append(v_bad, format('after recovery it must be `ok`, got `%s`', v_t));
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 8 (isolated failure) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 9 — THE CHANNEL, end to end, on a synthetic job name. Raise once,
  -- prove a second raise does NOT duplicate, resolve, prove the resolve
  -- worked, and prove a fresh outage after recovery raises AGAIN (an alert
  -- that can only fire once is a smoke detector with a spent battery).
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    v_checks := v_checks + 1;
    select count(*) into v_before from ops_alerts where kind = 'cron_job_broken:__mig818_selftest__';
    if v_before <> 0 then
      v_bad := array_append(v_bad, format('self-test kind is not clean: %s pre-existing row(s)', v_before::text));
    end if;

    perform public.raise_ops_alert('cron_job_broken:__mig818_selftest__', 'synthetic outage', '{"probe":9}'::jsonb);
    select count(*) into v_after from ops_alerts where kind = 'cron_job_broken:__mig818_selftest__' and resolved_at is null;
    v_checks := v_checks + 1;
    if v_after <> 1 then
      v_bad := array_append(v_bad, format('raise_ops_alert did not create exactly one open alert (%s)', v_after::text));
    end if;

    -- The scan's rule: an open alert means UPDATE, never a second row.
    select a.id into v_id from ops_alerts a where a.kind = 'cron_job_broken:__mig818_selftest__' and a.resolved_at is null limit 1;
    update ops_alerts set message = 'synthetic outage, still open', detail = '{"probe":9,"freshened":true}'::jsonb where id = v_id;
    select count(*) into v_after from ops_alerts where kind = 'cron_job_broken:__mig818_selftest__';
    v_checks := v_checks + 1;
    if v_after <> 1 then
      v_bad := array_append(v_bad, format('freshening an open alert must not add a row (%s rows)', v_after::text));
    end if;
    v_checks := v_checks + 1;
    select message into v_t from ops_alerts where id = v_id;
    if v_t <> 'synthetic outage, still open' then
      v_bad := array_append(v_bad, 'freshening did not update the open alert message'::text);
    end if;

    -- Recovery.
    update ops_alerts set resolved_at = now() where kind = 'cron_job_broken:__mig818_selftest__' and resolved_at is null;
    select count(*) into v_after from ops_alerts where kind = 'cron_job_broken:__mig818_selftest__' and resolved_at is null;
    v_checks := v_checks + 1;
    if v_after <> 0 then
      v_bad := array_append(v_bad, format('recovery left %s alert(s) open — the channel would be poisoned forever', v_after::text));
    end if;

    -- A LATER outage must be able to speak again.
    perform public.raise_ops_alert('cron_job_broken:__mig818_selftest__', 'a second, later outage', '{"probe":9,"second":true}'::jsonb);
    select count(*) into v_after from ops_alerts where kind = 'cron_job_broken:__mig818_selftest__' and resolved_at is null;
    v_checks := v_checks + 1;
    if v_after <> 1 then
      v_bad := array_append(v_bad, format('a second outage after recovery must raise again, got %s open', v_after::text));
    end if;

    -- ⚠ AND THE DEDUP THIS DESIGN EXISTS TO WORK AROUND, demonstrated rather
    -- than quoted: with the alert OPEN and under an hour old, calling
    -- raise_ops_alert again is swallowed. That is why a shared kind would have
    -- named one broken job and hidden the rest, and why the kind carries the
    -- job name.
    perform public.raise_ops_alert('cron_job_broken:__mig818_selftest__', 'THIS MUST BE SWALLOWED', '{}'::jsonb);
    select count(*) into v_after from ops_alerts where kind = 'cron_job_broken:__mig818_selftest__' and resolved_at is null;
    v_checks := v_checks + 1;
    if v_after <> 1 then
      v_bad := array_append(v_bad, format('raise_ops_alert dedup is not the 1-hour open-alert window this design assumes (%s open)', v_after::text));
    end if;

    delete from ops_alerts where kind = 'cron_job_broken:__mig818_selftest__';
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 9 (channel end to end) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 10 — the objects exist, with the right shape and the right reach.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    v_checks := v_checks + 1;
    if to_regprocedure('public.cron_schedule_period(text)') is null then
      v_bad := array_append(v_bad, 'cron_schedule_period is missing'::text);
    end if;
    v_checks := v_checks + 1;
    if to_regprocedure('public.cron_health_findings(timestamptz)') is null then
      v_bad := array_append(v_bad, 'cron_health_findings is missing'::text);
    end if;
    v_checks := v_checks + 1;
    if to_regprocedure('public.cron_health_scan(timestamptz)') is null then
      v_bad := array_append(v_bad, 'cron_health_scan is missing'::text);
    end if;
    v_checks := v_checks + 1;
    if to_regprocedure('public.cron_health_status()') is null then
      v_bad := array_append(v_bad, 'cron_health_status is missing'::text);
    end if;

    -- ⚠ THE PERIMETER. `authenticated` is the internet with a login. None of
    -- these may be reachable from it except the platform-admin-gated reader.
    v_checks := v_checks + 1;
    select count(*) into v_n
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('cron_schedule_period','cron_health_verdict','cron_health_findings','cron_health_scan')
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    if v_n <> 0 then
      v_bad := array_append(v_bad, format('%s of the four internal cron-health functions are reachable by anon/authenticated', v_n::text));
    end if;

    v_checks := v_checks + 1;
    if not has_function_privilege('authenticated', 'public.cron_health_status()', 'EXECUTE') then
      v_bad := array_append(v_bad, 'cron_health_status must be callable by authenticated — it is the reader, and it gates on is_platform_admin() itself'::text);
    end if;

    -- The status reader must REFUSE, not return, for a non-admin. Proven by
    -- reading the body for the guard rather than by forging a session.
    v_checks := v_checks + 1;
    select p.prosrc into v_t from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'cron_health_status';
    if v_t !~ 'is_platform_admin' then
      v_bad := array_append(v_bad, 'cron_health_status has no is_platform_admin guard'::text);
    end if;
    v_checks := v_checks + 1;
    if v_t ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and' then
      v_bad := array_append(v_bad, 'cron_health_status gates its authority on auth.uid() is not null — the skip-not-fail shape'::text);
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 10 (objects and perimeter) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 11 — the detector is actually scheduled, and calls what it says.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    v_checks := v_checks + 1;
    if not exists (select 1 from cron.job where jobname = 'cron-health-scan-15min') then
      v_bad := array_append(v_bad, 'cron job cron-health-scan-15min was not scheduled'::text);
    end if;
    v_checks := v_checks + 1;
    if not exists (select 1 from cron.job where jobname = 'cron-health-scan-15min' and schedule = '*/15 * * * *' and active) then
      v_bad := array_append(v_bad, 'cron-health-scan-15min is not active on */15 * * * *'::text);
    end if;
    v_checks := v_checks + 1;
    if not exists (select 1 from cron.job where jobname = 'cron-health-scan-15min' and command like '%cron_health_scan%') then
      v_bad := array_append(v_bad, 'cron-health-scan-15min does not call cron_health_scan'::text);
    end if;
    -- ⚠ and the parser must be able to read the detector's OWN schedule, or
    -- the detector could not judge itself even in the one case where it can.
    v_checks := v_checks + 1;
    if public.cron_schedule_period((select schedule from cron.job where jobname = 'cron-health-scan-15min')) <> interval '15 minutes' then
      v_bad := array_append(v_bad, 'the detector cannot parse its own schedule'::text);
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 11 (scheduled) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 12 — the gathering runs and agrees with the predicate.
  --
  -- ⚠ THIS PROBE MAKES NO ASSERTION THAT NEEDS PRODUCTION'S ROWS. It asserts
  -- an INTERNAL CONSISTENCY that is vacuously true on an empty database: for
  -- every row the gathering returns, feeding that row's own numbers back into
  -- the predicate must reproduce the same verdict. Zero rows, zero findings,
  -- and the count is reported so that is not mistaken for a pass.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    v_checks := v_checks + 1;
    select count(*) into v_n
      from public.cron_health_findings() f
     where f.verdict is distinct from
           public.cron_health_verdict(f.active, f.period, now(), f.last_success, f.last_run, f.first_run, f.fails_since);
    if v_n <> 0 then
      v_bad := array_append(v_bad, format('%s job(s) where the gathering and the predicate disagree', v_n::text));
    end if;

    select count(*) into v_n from public.cron_health_findings();
    v_report := array_append(v_report, format('gathering returned %s job(s); consistency comparisons made: %s', v_n::text, v_n::text));

    -- Every job must land on exactly one of the known verdicts. A typo in the
    -- CASE would otherwise produce a verdict nothing acts on — neither alerted
    -- nor reported — which is the quietest possible failure.
    v_checks := v_checks + 1;
    select count(*) into v_n from public.cron_health_findings() f
     where f.verdict not in ('ok','failing','silent','unjudgeable','disabled','never_observed');
    if v_n <> 0 then
      v_bad := array_append(v_bad, format('%s job(s) carry a verdict outside the known set', v_n::text));
    end if;

    -- Nothing may be unwatched because its schedule could not be read.
    select count(*) into v_n from public.cron_health_findings() f where f.verdict = 'unjudgeable';
    v_report := array_append(v_report, format('jobs with no derivable period (unjudgeable, alerted so they cannot hide): %s', v_n::text));

    select jsonb_object_agg(t.verdict, t.n) into v_json
      from (select f.verdict, count(*) n from public.cron_health_findings() f group by f.verdict) t;
    v_report := array_append(v_report, format('verdicts right now: %s', coalesce(v_json::text, '(no jobs)')));
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 12 (gathering vs predicate) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 13 — THE HISTORICAL REPLAY, through the real gathering function at
  -- historical instants. This is the probe that catches a bug in the SQL
  -- aggregate rather than in the predicate.
  --
  -- ⚠ ITS ASSERTION IS GUARDED ON THE DATA BEING PRESENT, and is therefore
  -- vacuously true in a database that does not carry August 2026's cron
  -- history — which is every database except this one. The probe still RUNS
  -- everywhere (so the floor below is honest); it simply says so when there is
  -- nothing to replay.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    if exists (
      select 1 from cron.job j
        join cron.job_run_details d on d.jobid = j.jobid
       where j.jobname = 'reconcile-blocked-goals-30min'
         and d.status = 'failed'
         and d.start_time between '2026-08-13 00:00:00+00' and '2026-08-17 23:59:59+00')
    then
      v_checks := v_checks + 1;
      select f.verdict into v_t
        from public.cron_health_findings('2026-08-12 23:45:00+00'::timestamptz) f
       where f.jobname = 'reconcile-blocked-goals-30min';
      if v_t is distinct from 'failing' then
        v_bad := array_append(v_bad, format('REPLAY 2026-08-12 23:45Z: expected `failing`, got `%s`', coalesce(v_t, '(no row)')));
      end if;

      v_checks := v_checks + 1;
      select f.verdict into v_t
        from public.cron_health_findings('2026-08-12 22:15:00+00'::timestamptz) f
       where f.jobname = 'reconcile-blocked-goals-30min';
      if v_t is distinct from 'ok' then
        v_bad := array_append(v_bad, format('REPLAY 2026-08-12 22:15Z (15 min in): expected `ok`, got `%s`', coalesce(v_t, '(no row)')));
      end if;

      for v_t in
        select format('  %s -> %s | fails_since=%s | last_success=%s',
                      to_char(a.ts at time zone 'UTC', 'MM-DD HH24:MI') || 'Z',
                      rpad(f.verdict, 8),
                      f.fails_since::text,
                      coalesce(to_char(f.last_success at time zone 'UTC', 'MM-DD HH24:MI') || 'Z', '(never)'))
          from (values ('2026-08-12 22:15:00+00'::timestamptz),
                       ('2026-08-12 23:15:00+00'::timestamptz),
                       ('2026-08-12 23:45:00+00'::timestamptz),
                       ('2026-08-13 06:00:00+00'::timestamptz),
                       ('2026-08-15 12:00:00+00'::timestamptz),
                       ('2026-08-17 12:00:00+00'::timestamptz),
                       ('2026-08-18 09:45:00+00'::timestamptz),
                       ('2026-08-18 10:15:00+00'::timestamptz),
                       ('2026-08-19 12:00:00+00'::timestamptz)) a(ts)
          cross join lateral (select * from public.cron_health_findings(a.ts) x
                               where x.jobname = 'reconcile-blocked-goals-30min') f
      loop
        v_report := array_append(v_report, format('REPLAY %s', v_t));
      end loop;

      -- and the two traps, replayed through the same gathering at today's clock
      for v_t in
        select format('  %s -> %s (%s)', rpad(f.jobname, 32), f.verdict, f.schedule)
          from public.cron_health_findings() f
         where f.jobname in ('de-performance-review-quarterly','approved-action-driver-5min','reconcile-blocked-goals-30min','knowledge-conflict-probe-drain')
         order by f.jobname
      loop
        v_report := array_append(v_report, format('TODAY %s', v_t));
      end loop;
    else
      v_report := array_append(v_report, 'REPLAY skipped: this database holds no August 2026 reconcile-blocked-goals failures to replay. The predicate assertions in probes 3-8 carry the same numbers as literals and DID run.'::text);
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 13 (historical replay) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 14 — the scan itself runs, and on a healthy estate CHANGES NOTHING.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    select count(*) into v_before from ops_alerts;
    v_json := public.cron_health_scan();
    select count(*) into v_after from ops_alerts;
    v_checks := v_checks + 1;
    if v_json is null or not (v_json ? 'jobs_examined') then
      v_bad := array_append(v_bad, 'cron_health_scan returned no receipt'::text);
    end if;
    v_checks := v_checks + 1;
    if (v_json->>'raised')::int <> v_after - v_before then
      v_bad := array_append(v_bad, format('the scan claims %s raised but ops_alerts moved by %s', v_json->>'raised', (v_after - v_before)::text));
    end if;
    v_report := array_append(v_report, format('scan receipt: %s', v_json::text));
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 14 (scan runs) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- PROBE 15 — THE WRITE PATH, DRIVEN OVER THE REAL OUTAGE.
  --
  -- Probes 3-8 prove the predicate; probe 13 proves the gathering. Neither
  -- proves that an alert would actually have been WRITTEN, which is the only
  -- thing that would have helped anyone on 2026-08-13. This drives the real
  -- cron_health_scan() at historical instants and watches ops_alerts.
  --
  -- Guarded on the history existing, and everything it writes is rolled back
  -- with the rest of this transaction.
  ----------------------------------------------------------------------
  v_probes_try := v_probes_try + 1;
  begin
    if exists (
      select 1 from cron.job j
        join cron.job_run_details d on d.jobid = j.jobid
       where j.jobname = 'reconcile-blocked-goals-30min'
         and d.status = 'failed'
         and d.start_time between '2026-08-13 00:00:00+00' and '2026-08-17 23:59:59+00')
    then
      delete from ops_alerts where kind = 'cron_job_broken:reconcile-blocked-goals-30min';

      -- 15 minutes into the outage: NOT yet, because one failure is a blip.
      perform public.cron_health_scan('2026-08-12 22:45:00+00'::timestamptz);
      select count(*) into v_n from ops_alerts
       where kind = 'cron_job_broken:reconcile-blocked-goals-30min' and resolved_at is null;
      v_checks := v_checks + 1;
      if v_n <> 0 then
        v_bad := array_append(v_bad, format('WRITE REPLAY: alerted 45 min into the outage (%s open) — that is inside the grace', v_n::text));
      end if;

      -- 23:45Z, 1h45m without a success and three failed runs: THE MOMENT.
      v_json := public.cron_health_scan('2026-08-12 23:45:00+00'::timestamptz);
      select count(*) into v_n from ops_alerts
       where kind = 'cron_job_broken:reconcile-blocked-goals-30min' and resolved_at is null;
      v_checks := v_checks + 1;
      if v_n <> 1 then
        v_bad := array_append(v_bad, format('WRITE REPLAY: expected exactly 1 open alert at 2026-08-12 23:45Z, got %s', v_n::text));
      end if;
      select a.message into v_t from ops_alerts a
       where a.kind = 'cron_job_broken:reconcile-blocked-goals-30min' and a.resolved_at is null limit 1;
      v_report := array_append(v_report, format('WOULD HAVE SAID (2026-08-12 23:45Z): %s', coalesce(v_t, '(nothing)')));
      v_checks := v_checks + 1;
      if coalesce(v_t, '') !~ 'has not succeeded since 2026-08-12 22:00' then
        v_bad := array_append(v_bad, format('WRITE REPLAY: the message does not name the last success. Got: %s', coalesce(v_t, '(null)')));
      end if;

      -- ⚠ BACKDATE BEFORE THE NEXT SCAN, and this line is load-bearing.
      -- `ops_alerts.created_at` defaults to the REAL clock, not p_as_of, so a
      -- replay that fires three scans inside one second leaves every alert less
      -- than an hour old — which is precisely the window raise_ops_alert
      -- suppresses. Without this the freshen-vs-append branch is untestable:
      -- an implementation that wrongly called raise_ops_alert every tick would
      -- still show one row, because raise_ops_alert would swallow the extras.
      -- Measured: with this line removed, a mutation replacing the UPDATE with
      -- a second raise_ops_alert call SURVIVED the whole block. Ageing the row
      -- past the dedup window is what makes the next scan's choice visible.
      update ops_alerts set created_at = now() - interval '3 hours'
       where kind = 'cron_job_broken:reconcile-blocked-goals-30min';

      -- Five days later: still ONE row, freshened, not 131 of them.
      perform public.cron_health_scan('2026-08-17 12:00:00+00'::timestamptz);
      select count(*) into v_n from ops_alerts where kind = 'cron_job_broken:reconcile-blocked-goals-30min';
      v_checks := v_checks + 1;
      if v_n <> 1 then
        v_bad := array_append(v_bad, format('WRITE REPLAY: five days of outage produced %s alert rows; it must stay at 1', v_n::text));
      end if;
      -- and the ONE row still carries the moment the outage was first noticed
      v_checks := v_checks + 1;
      select count(*) into v_n from ops_alerts
       where kind = 'cron_job_broken:reconcile-blocked-goals-30min'
         and created_at < now() - interval '2 hours';
      if v_n <> 1 then
        v_bad := array_append(v_bad, 'WRITE REPLAY: freshening must keep the ORIGINAL created_at — it is when the outage started being noticed'::text);
      end if;
      select a.message into v_t from ops_alerts a
       where a.kind = 'cron_job_broken:reconcile-blocked-goals-30min' limit 1;
      v_report := array_append(v_report, format('WOULD HAVE SAID (2026-08-17 12:00Z, day 5): %s', coalesce(v_t, '(nothing)')));

      -- After the 2026-08-18 10:00Z recovery: the channel clears itself.
      v_json := public.cron_health_scan('2026-08-19 12:00:00+00'::timestamptz);
      select count(*) into v_n from ops_alerts
       where kind = 'cron_job_broken:reconcile-blocked-goals-30min' and resolved_at is null;
      v_checks := v_checks + 1;
      if v_n <> 0 then
        v_bad := array_append(v_bad, format('WRITE REPLAY: recovery left %s alert(s) open — the first outage would poison the channel forever', v_n::text));
      end if;
      select count(*) into v_n from ops_alerts
       where kind = 'cron_job_broken:reconcile-blocked-goals-30min' and resolved_at is not null;
      v_checks := v_checks + 1;
      if v_n <> 1 then
        v_bad := array_append(v_bad, format('WRITE REPLAY: expected the one alert to be RESOLVED, found %s resolved', v_n::text));
      end if;
      v_report := array_append(v_report, format('RECOVERY: scan at 2026-08-19 12:00Z resolved it by itself — receipt %s', v_json::text));

      delete from ops_alerts where kind = 'cron_job_broken:reconcile-blocked-goals-30min';
    else
      v_report := array_append(v_report, 'WRITE REPLAY skipped: no August 2026 outage in this database to drive the scan over.'::text);
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 15 (write path replay) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ----------------------------------------------------------------------
  -- THE FLOOR. Zero findings from zero comparisons looks exactly like a clean
  -- result, so the denominators are ASSERTED, not merely printed.
  ----------------------------------------------------------------------
  if v_probes_ok <> v_probes_try then
    v_bad := array_append(v_bad, format(
      'only %s of %s probes completed. A probe that cannot run is a failure, never a skip — its assertions compared nothing this run.',
      v_probes_ok::text, v_probes_try::text));
  end if;
  -- ⚠ MEASURED, not guessed. A dry run against production evaluates 65
  -- assertions; the same run with probes 13 and 15 forced past their history
  -- guard — the fresh-database case — evaluates 56. The floor is set against the
  -- SMALLER number, because it has to hold where there is no history to replay,
  -- and 54 leaves two of slack for nothing more than that. Anything that
  -- collapses this block into a handful of branches trips here rather than
  -- printing a clean result nobody counted.
  if v_checks < 54 then
    v_bad := array_append(v_bad, format(
      'only %s assertion(s) were evaluated; this block carries at least 54 that do not depend on any data (65 where August 2026 history exists). A collapse means branches were skipped rather than run.',
      v_checks::text));
  end if;

  create temp table if not exists _818_report (k text, v text);
  delete from _818_report;
  insert into _818_report (k, v)
  values ('note', format('probes_completed=%s probes_attempted=%s assertions=%s findings=%s',
                         v_probes_ok::text, v_probes_try::text, v_checks::text,
                         coalesce(array_length(v_bad, 1), 0)::text));
  insert into _818_report (k, v)
  values ('threshold', 'failing := no success for least(greatest(3 x period, 1h), 24h) AND >=1 failed run in the gap; silent := ran before, then nothing for greatest(3 x period, 1h); disabled and never_observed are REPORTED, never alerted.'::text);
  insert into _818_report (k, v) select 'report', u from unnest(v_report) u;
  insert into _818_report (k, v) select 'finding', u from unnest(v_bad) u;

  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception '818: % of % assertion(s) failed across % of % probes: %',
      array_length(v_bad, 1), v_checks, v_probes_ok, v_probes_try, array_to_string(v_bad, ' | ');
  end if;

  raise notice '818 OK: probes_completed=% probes_attempted=% assertions=% findings=0',
    v_probes_ok, v_probes_try, v_checks;
end $verify$;

commit;
