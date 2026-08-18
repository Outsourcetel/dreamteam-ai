-- 765_a_review_judges_the_goals_you_set_over_the_window_it_names.sql
-- ==========================================================================
-- WHY: docs/54 item 13, all of it. Five defects, each measured on production
-- before being touched.
--
-- 1. THE WINDOW LIED. v_period_start was date_trunc('quarter', now()) while
--    the numbers came from get_de_performance_metrics(tenant, 13) — thirteen
--    weeks. All 6 live rows say period_start = 2026-07-01; on 2026-08-18 that
--    data reaches back to ~2026-05-19, so six weeks of evidence sat outside
--    the period the row claimed to describe. FIX: period_start is now
--    period_end - window. The two columns the table already has describe the
--    window actually measured. No new columns and no separate "label" — the
--    label WAS the bug.
--
-- 2. NO CADENCE. UNIQUE (tenant_id, de_id, period_start) with a quarter-start
--    meant every review inside a quarter upserted the same row. With an honest
--    period_start that key stops fighting cadence on its own: different
--    windows are different rows, while re-running the SAME window stays
--    idempotent, which is what the key is for. The window is p_window_weeks.
--
-- 3. IT IGNORED de_kpis ENTIRELY — verified, the old source contained no
--    reference to it. It judged on three invented numbers, so a workspace
--    could set any goals it liked and the review never looked. It now reads
--    de_kpi_status_internal (mig 764) over the SAME window it reports, so the
--    verdict cites the period it names.
--
-- 4. IT STATED A TARGET IT DID NOT ENFORCE. The old "below" summary read
--    "(target 65+)" for average confidence while the test was `< 50`. Nobody
--    listed this one. Same class as every other docs/54 surface that claimed
--    something it did not do. Gone with the thresholds.
--
-- 5. THE PIP DEADLINE COULD NEVER COME DUE. `due_date = current_date + 30` on
--    insert AND `due_date = excluded.due_date` on conflict, so every run reset
--    the clock. At any cadence faster than monthly it is never reached. FIX:
--    the description refreshes, THE DEADLINE DOES NOT MOVE.
--
-- NO GOALS MEANS NO VERDICT — founder decision, 2026-08-18. An employee whose
-- workspace set no goals gets `insufficient_data` and a summary saying exactly
-- that, never a judgment against numbers its owner did not choose. 126 of 127
-- employees are in that state today, so this visibly changes almost every
-- review and opens no PIP for them until goals exist. That is the intent:
-- judging everyone against three invented constants is precisely the
-- "defaults are demo payloads, not decisions" pattern docs/54 opens with.
--
-- The thin-evidence guard (< 10 decisions) is KEPT — orthogonal, since goals
-- can be set and still not be judgeable yet.
--
-- de_kpi_status_internal is called ONCE per employee and everything else is
-- derived from that jsonb, rather than re-querying it three times per row.
-- ==========================================================================

begin;

-- ⚠ THE OLD SIGNATURE MUST GO FIRST. Adding p_window_weeks creates an
-- OVERLOAD, not a replacement, and BOTH existing callers would then be
-- ambiguous rather than broken loudly in one place:
--   run_de_performance_review()  -> ...internal(v_tenant, null)   (mig 129:307)
--   the scheduled job            -> ...internal()                 (mig 129:581)
-- Each matches the 2-arg form exactly AND the 3-arg form via defaults, which
-- is an error at call time, not at create time — so it would have shipped
-- green and failed on the next cron tick. Caught by a dry-run probe that
-- counted TWO functions where there should be one.
drop function if exists public.run_de_performance_review_internal(uuid, uuid);

create or replace function public.run_de_performance_review_internal(
  p_tenant_id    uuid default null,
  p_de_id        uuid default null,
  p_window_weeks int  default 13
)
returns setof de_performance_reviews
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_t             record;
  m               record;
  v_skills        jsonb;
  v_verdict       text;
  v_summary       text;
  v_row           de_performance_reviews;
  v_goals         jsonb;
  v_n_goals       int;
  v_n_measured    int;
  v_n_unmet       int;
  v_unmet_text    text;
  v_first_name    text;
  v_first_key     text;
  v_first_target  numeric;
  v_first_current numeric;
  v_window_label  text;
  v_period_end    date := current_date;
  v_period_start  date;
begin
  if coalesce(p_window_weeks, 0) < 1 then
    raise exception 'window_weeks_invalid: % — a review window is at least one week', p_window_weeks;
  end if;

  -- The window the row CLAIMS is the window the numbers COME FROM.
  v_period_start := v_period_end - (p_window_weeks * 7);
  v_window_label := format('%s week%s to %s', p_window_weeks,
                           case when p_window_weeks = 1 then '' else 's' end, v_period_end);

  for v_t in
    select distinct de.tenant_id as tid from digital_employees de
    where de.lifecycle_status not in ('retired', 'archived')
      and (p_tenant_id is null or de.tenant_id = p_tenant_id)
      and tenant_is_operational(de.tenant_id)
  loop
    for m in
      select * from get_de_performance_metrics(v_t.tid, p_window_weeks)
      where (p_de_id is null or de_id = p_de_id)
    loop
      if not exists (select 1 from digital_employees d where d.id = m.de_id
                     and d.lifecycle_status in ('assigned', 'active', 'improving', 'paused')) then
        continue;
      end if;

      select coalesce(jsonb_agg(jsonb_build_object(
               'skill', s.skill_key, 'proficiency', s.proficiency, 'value', s.signal_value)), '[]'::jsonb)
        into v_skills from de_skills s where s.de_id = m.de_id;

      -- The goals this workspace actually set, resolved over THIS window. One
      -- call; every count and every sentence below is derived from it.
      select coalesce(jsonb_agg(jsonb_build_object(
               'metric_key', k.metric_key, 'name', k.name, 'target', k.target,
               'direction', k.direction, 'current', k.current, 'met', k.met) order by k.name), '[]'::jsonb)
        into v_goals
        from de_kpi_status_internal(v_t.tid, m.de_id, p_window_weeks) k;

      select count(*),
             count(*) filter (where g->>'current' is not null),
             count(*) filter (where g->>'current' is not null and coalesce((g->>'met')::boolean, false) = false)
        into v_n_goals, v_n_measured, v_n_unmet
        from jsonb_array_elements(v_goals) g;

      select string_agg(format('%s (%s vs target %s)',
                               g->>'name', round((g->>'current')::numeric, 1), round((g->>'target')::numeric, 1)),
                        '; ' order by g->>'name')
        into v_unmet_text
        from jsonb_array_elements(v_goals) g
       where g->>'current' is not null and coalesce((g->>'met')::boolean, false) = false;

      select g->>'name', g->>'metric_key', (g->>'target')::numeric, (g->>'current')::numeric
        into v_first_name, v_first_key, v_first_target, v_first_current
        from jsonb_array_elements(v_goals) g
       where g->>'current' is not null and coalesce((g->>'met')::boolean, false) = false
       order by g->>'name' limit 1;

      if v_n_goals = 0 then
        v_verdict := 'insufficient_data';
        v_summary := format('No goals are set for %s, so there is nothing to review it against. Set goals on this employee and the next review (%s) will measure them.',
                            m.de_name, v_window_label);
      elsif m.total_decisions < 10 then
        v_verdict := 'insufficient_data';
        v_summary := format('%s handled %s decisions over %s — below the 10 needed for a meaningful verdict. No judgment recorded on thin evidence.',
                            m.de_name, m.total_decisions, v_window_label);
      elsif v_n_measured = 0 then
        v_verdict := 'insufficient_data';
        v_summary := format('%s goal%s set for %s, but none has a measured value over %s yet. No judgment recorded on an unmeasured goal.',
                            v_n_goals, case when v_n_goals = 1 then ' is' else 's are' end,
                            m.de_name, v_window_label);
      elsif v_n_unmet > 0 then
        v_verdict := 'below';
        v_summary := format('%s missed %s of %s measured goal%s over %s: %s. A Performance Improvement Plan has been opened.',
                            m.de_name, v_n_unmet, v_n_measured,
                            case when v_n_measured = 1 then '' else 's' end, v_window_label, v_unmet_text);
      else
        v_verdict := 'meets';
        v_summary := format('%s met all %s measured goal%s over %s, across %s decisions.',
                            m.de_name, v_n_measured, case when v_n_measured = 1 then '' else 's' end,
                            v_window_label, m.total_decisions);
      end if;

      insert into de_performance_reviews (tenant_id, de_id, period_start, period_end, verdict, summary, metrics_snapshot)
      values (v_t.tid, m.de_id, v_period_start, v_period_end, v_verdict, v_summary,
        jsonb_build_object(
          'window_weeks', p_window_weeks,
          'total_decisions', m.total_decisions, 'resolution_rate', m.resolution_rate,
          'avg_confidence', m.avg_confidence, 'escalation_rate', m.escalation_rate,
          'error_rate', m.error_rate, 'blocked_guardrail_count', m.blocked_guardrail_count,
          'avg_frustration_score', m.avg_frustration_score, 'skills', v_skills,
          -- The goals are evidence now, so a past verdict can be read back
          -- against what it was actually judged on.
          'goals', v_goals))
      on conflict (tenant_id, de_id, period_start)
      do update set period_end = excluded.period_end, verdict = excluded.verdict,
                    summary = excluded.summary, metrics_snapshot = excluded.metrics_snapshot
      returning * into v_row;

      if v_verdict = 'below' then
        insert into de_development_items (tenant_id, de_id, item_type, source, priority, description,
          target_metric, target_value, baseline_value, status, due_date, consequence)
        values (v_t.tid, m.de_id, 'pip', 'detected', 'high',
          format('Performance Improvement Plan for %s (review of %s): meet %s within 30 days. Currently missing: %s.',
                 m.de_name, v_window_label, v_first_name, v_unmet_text),
          v_first_key, v_first_target, v_first_current,
          'proposed', current_date + 30,
          'If targets are not met by the due date, a CRITICAL incident is raised for trust review — possible outcomes decided by a human there: trust reduction, added approval gates, or pause.')
        on conflict (tenant_id, de_id, item_type) where source = 'detected' and status in ('proposed', 'in_progress')
        -- due_date IS DELIBERATELY NOT REFRESHED. It used to be
        -- `due_date = excluded.due_date`, which reset the deadline to +30 days
        -- on every run, so at any cadence faster than monthly the PIP could
        -- never come due. The description updates; the clock does not restart.
        do update set description    = excluded.description,
                      target_metric  = excluded.target_metric,
                      target_value   = excluded.target_value,
                      baseline_value = excluded.baseline_value,
                      updated_at     = now();
      elsif v_verdict = 'meets' then
        update de_development_items set status = 'completed', completed_at = now(), updated_at = now()
        where tenant_id = v_t.tid and de_id = m.de_id and item_type = 'pip'
          and source = 'detected' and status in ('proposed', 'in_progress');
      end if;

      return next v_row;
    end loop;
  end loop;
  return;
end;
$function$;

-- A dropped function takes its ACL with it, and the recreated one would
-- otherwise inherit the PUBLIC default plus Supabase's anon/authenticated
-- grants (migs 610 + 630). Restored to exactly what mig 129:290-291 set:
-- service_role only. Nothing on the browser perimeter, so the pinned EXECUTE
-- allowlist (which tracks anon/authenticated) does not move and needs no
-- re-pin.
revoke all on function public.run_de_performance_review_internal(uuid, uuid, int) from public;
revoke all on function public.run_de_performance_review_internal(uuid, uuid, int) from anon;
revoke all on function public.run_de_performance_review_internal(uuid, uuid, int) from authenticated;
grant execute on function public.run_de_performance_review_internal(uuid, uuid, int) to service_role;

commit;
