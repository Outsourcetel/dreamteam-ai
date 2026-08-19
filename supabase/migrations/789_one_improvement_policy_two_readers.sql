-- 789_one_improvement_policy_two_readers.sql
-- ==========================================================================
-- Register item B-15, from the whole-branch review of migs 768-785.
--
-- Mig 765 decided that an employee whose workspace set no goals gets no
-- verdict. Correct, and a founder decision. But `insufficient_data` reaches
-- neither the `below` branch (which opens a plan) nor the `meets` branch
-- (which closes one), so an ALREADY-OPEN improvement plan became
-- unclosable -- stuck open, overdue, carrying a consequence clause that
-- promises a CRITICAL incident.
--
-- And the policy had a second reader that mig 765 never touched.
-- de_governance_sweep_internal (cron de-governance-sweep-daily) still
-- adjudicated overdue plans against the exact three constants 765 had just
-- declared illegitimate, and could mark one failed and raise a critical
-- incident on them. Two readers of one policy, disagreeing.
--
-- MEASURED, not assumed. Two open detected plans exist, both overdue since
-- 2026-08-10, both on employees with ZERO goals. No pip_failed incident has
-- ever fired for them -- but that is DORMANCY, not safety: the only thing
-- stopping the sweep is tenant_is_operational() being false for their
-- workspace. get_de_performance_metrics does return a row for both, so the
-- moment that workspace reactivates the sweep would judge them on the
-- removed constants. The review is gated on the same predicate, so neither
-- reader would ever have reached them on its own.
--
-- Three changes:
--   (1) the sweep reads the same goals the review does, via the same
--       function, over the same 4-week window it always used;
--   (2) the review withdraws a plan it can never judge -- and ONLY for the
--       no-goals case, since thin evidence is "not yet", not "never";
--   (3) the two existing stranded plans are withdrawn here, because neither
--       reader runs on a non-operational workspace and they would otherwise
--       sit open forever waiting for a cron that will not come.
--
-- The sweep also had a polarity bug worth naming on its own: v_passing was
-- initialised FALSE and only ever set inside a loop over
-- get_de_performance_metrics, so an employee with no metrics row fell
-- through to the else branch -- absence of evidence became failure, plus a
-- critical incident. Exactly the shape mig 786 closed on the authority
-- side, three days earlier, in a different subsystem.
-- ==========================================================================

begin;

-- (1) the sweep judges the goals the workspace set ------------------------
CREATE OR REPLACE FUNCTION public.de_governance_sweep_internal()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_cert record;
  v_pip record;
  v_inc record;
  m record;
  v_warned integer := 0;
  v_expired integer := 0;
  v_pip_completed integer := 0;
  v_pip_failed integer := 0;
  v_sla integer := 0;
  v_de_name text;
  v_prop jsonb;
  v_goals integer; v_measured integer; v_unmet integer; v_decisions bigint;
  v_pip_dismissed integer := 0;
  v_pip_unassessable integer := 0;
begin
  -- (a) Expiring within 14 days → one warning audit event per cert.
  for v_cert in
    select c.*, de.name as de_name from de_certifications c
    join digital_employees de on de.id = c.de_id
    where c.status = 'active' and c.warned_at is null
      and c.expires_at <= now() + interval '14 days' and c.expires_at > now()
      and tenant_is_operational(c.tenant_id)
  loop
    update de_certifications set warned_at = now() where id = v_cert.id;
    perform append_audit_event_internal(
      v_cert.tenant_id, 'Governance sweep', 'system',
      format('%s''s %s certification expires %s — recertify to keep it current', v_cert.de_name, v_cert.cert_type, to_char(v_cert.expires_at, 'YYYY-MM-DD')),
      'config_change',
      jsonb_build_object('kind', 'certification_expiring', 'cert_id', v_cert.id, 'de_id', v_cert.de_id)
    );
    v_warned := v_warned + 1;
  end loop;

  -- (b) Expired → status flip + incident (dedup via unique source key).
  for v_cert in
    select c.*, de.name as de_name from de_certifications c
    join digital_employees de on de.id = c.de_id
    where c.status = 'active' and c.expires_at <= now()
      and tenant_is_operational(c.tenant_id)
  loop
    update de_certifications set status = 'expired' where id = v_cert.id;
    insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
    values (v_cert.tenant_id, v_cert.de_id, 'certification_expired', 'warning',
      format('%s certification expired — %s', initcap(v_cert.cert_type), v_cert.de_name),
      jsonb_build_object('cert_id', v_cert.id, 'cert_type', v_cert.cert_type, 'scope', v_cert.scope,
                         'issued_by', v_cert.issued_by_name, 'expired_at', v_cert.expires_at),
      'de_certifications', v_cert.id, v_cert.expires_at)
    on conflict (tenant_id, source_table, source_id) do nothing;
    v_expired := v_expired + 1;
  end loop;

  -- (c) Overdue open PIPs → RE-MEASURE on a fresh 4-week window: now
  --     passing → completed (closed loop); still failing → 'failed' +
  --     CRITICAL incident for human trust review.
  for v_pip in
    select i.* from de_development_items i
    where i.item_type = 'pip' and i.source = 'detected'
      and i.status in ('proposed', 'in_progress') and i.due_date < current_date
      and tenant_is_operational(i.tenant_id)
  loop
    select name into v_de_name from digital_employees where id = v_pip.de_id;

    -- ⛔ ONE POLICY, TWO READERS.
    --
    -- This block used to re-measure against three constants:
    --   total_decisions >= 10 and escalation_rate <= 50
    --   and avg_confidence >= 50 and error_rate <= 15
    -- Mig 765 removed exactly those from the review as illegitimate -- "judging
    -- everyone against three invented constants" -- and replaced them with the
    -- goals the workspace actually set. They lived on HERE, so the two readers
    -- of one policy disagreed: the review would decline to judge an employee
    -- while this sweep failed it and raised a CRITICAL incident.
    --
    -- Worse, `v_passing` was initialised false and only ever set INSIDE a loop
    -- over get_de_performance_metrics. An employee that function returned no
    -- row for fell straight to the else branch: absence of evidence became
    -- FAILURE, plus a critical incident. That is the same polarity error mig
    -- 786 closed on the authority side -- "we could not tell" must never be
    -- spelled the same way as a verdict.
    --
    -- Same reader as the review now: de_kpi_status_internal, over the same
    -- fresh 4-week window this sweep has always used.
    select count(*),
           count(*) filter (where k.current is not null),
           count(*) filter (where k.current is not null and coalesce(k.met, false) = false)
      into v_goals, v_measured, v_unmet
      from de_kpi_status_internal(v_pip.tenant_id, v_pip.de_id, 4) k;

    v_decisions := 0;
    select coalesce(mm.total_decisions, 0) into v_decisions
      from get_de_performance_metrics(v_pip.tenant_id, 4) mm
     where mm.de_id = v_pip.de_id;

    if v_goals = 0 then
      -- No goals means no verdict (founder decision, 2026-08-18). A plan on an
      -- employee with nothing to be judged against can NEVER be adjudicated by
      -- either reader, so leaving it open is not caution -- it is a permanent
      -- open threat carrying a consequence clause that promises a critical
      -- incident. Withdraw it, and say so. `dismissed` rather than completed
      -- or failed: it neither passed nor failed, it was never judgeable.
      update de_development_items set status = 'dismissed', updated_at = now()
       where id = v_pip.id;
      perform append_audit_event_internal(
        v_pip.tenant_id, 'Governance sweep', 'system',
        format('%s has no goals set, so its Performance Improvement Plan could not be judged and has been withdrawn. Set goals and a future review can open one that means something.',
               coalesce(v_de_name, 'Employee')),
        'config_change',
        jsonb_build_object('kind', 'pip_dismissed', 'item_id', v_pip.id, 'de_id', v_pip.de_id,
                           'why', 'no goals set for this employee')
      );
      v_pip_dismissed := v_pip_dismissed + 1;

    elsif v_decisions < 10 or v_measured = 0 then
      -- ⚠ NOT A FAILURE. Goals exist but there is not yet enough to judge them
      -- on. The thin-evidence guard mig 765 deliberately KEPT, applied here for
      -- the first time. The plan stays open and its deadline stays where it is;
      -- next sweep may well have the evidence. What must not happen is a
      -- critical incident for the crime of being unmeasured.
      v_pip_unassessable := v_pip_unassessable + 1;

    elsif v_unmet = 0 then
      update de_development_items set status = 'completed', completed_at = now(), updated_at = now() where id = v_pip.id;
      perform append_audit_event_internal(
        v_pip.tenant_id, 'Governance sweep', 'system',
        format('%s met its Performance Improvement Plan targets — PIP closed', coalesce(v_de_name, 'Employee')),
        'config_change',
        jsonb_build_object('kind', 'pip_completed', 'item_id', v_pip.id, 'de_id', v_pip.de_id,
                           'goals_measured', v_measured)
      );
      v_pip_completed := v_pip_completed + 1;

    else
      -- Measured, and missed. This is the consequence the plan itself promises.
      update de_development_items set status = 'failed', updated_at = now() where id = v_pip.id;
      insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
      values (v_pip.tenant_id, v_pip.de_id, 'pip_failed', 'critical',
        format('Performance Improvement Plan failed — %s', coalesce(v_de_name, 'employee')),
        jsonb_build_object('item_id', v_pip.id, 'due_date', v_pip.due_date,
          'consequence', v_pip.consequence,
          'goals_missed', v_unmet, 'goals_measured', v_measured,
          'next_step', 'A human decides here: trust reduction, added approval gates, or pause (Pause is on the employee profile).'),
        'de_development_items', v_pip.id, now())
      on conflict (tenant_id, source_table, source_id) do nothing;
      v_pip_failed := v_pip_failed + 1;
    end if;
  end loop;

  -- (d) §10.3: critical incidents should be reviewed within 48 hours —
  --     one nudge each (detail flag dedup).
  for v_inc in
    select * from de_incidents
    where status = 'open' and severity = 'critical'
      and created_at < now() - interval '48 hours'
      and coalesce(detail->>'sla_nudged', '') = ''
      and tenant_is_operational(tenant_id)
  loop
    update de_incidents set detail = detail || '{"sla_nudged": true}'::jsonb where id = v_inc.id;
    perform append_audit_event_internal(
      v_inc.tenant_id, 'Governance sweep', 'system',
      format('Critical incident open past the 48-hour review window: %s', left(v_inc.title, 160)),
      'config_change',
      jsonb_build_object('kind', 'incident_sla_nudge', 'incident_id', v_inc.id, 'de_id', v_inc.de_id)
    );
    v_sla := v_sla + 1;
  end loop;

  -- (e) mig 710: repeated identical human approvals become a trust-widening
  --     PROPOSAL (never a decision — a human still approves it, through
  --     decide_human_task, like every other task). SECURITY DEFINER
  --     dispatch: the callee is owned by trust_pattern_proposer, so this
  --     step runs with that role's privileges, which cannot decide or move
  --     a dial. Errors are captured, not swallowed silently — they ride in
  --     the return payload; a proposer failure must not cost steps (a)-(d).
  begin
    v_prop := public.raise_trust_widening_proposals(null);
  exception when others then
    v_prop := jsonb_build_object('error', sqlerrm);
  end;

  return jsonb_build_object('cert_warnings', v_warned, 'certs_expired', v_expired,
    'pips_completed', v_pip_completed, 'pips_failed', v_pip_failed,
    'pips_dismissed', v_pip_dismissed, 'pips_unassessable', v_pip_unassessable,
    'sla_nudges', v_sla,
    'trust_proposals', coalesce(v_prop, '{}'::jsonb));
end;
$function$
;

-- (2) the review withdraws a plan it can never judge ----------------------

CREATE OR REPLACE FUNCTION public.run_de_performance_review_internal(p_tenant_id uuid DEFAULT NULL::uuid, p_de_id uuid DEFAULT NULL::uuid, p_window_weeks integer DEFAULT 13)
 RETURNS SETOF de_performance_reviews
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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

      elsif v_verdict = 'insufficient_data' and v_n_goals = 0 then
        -- ⛔ THE STRANDING THIS FIXES. `insufficient_data` reached neither
        -- branch above, so an already-open plan could never be closed by the
        -- review again -- it just sat there, overdue, carrying a consequence
        -- clause promising a critical incident.
        --
        -- ONLY the no-goals case. The other two routes to insufficient_data --
        -- thin evidence, and goals with nothing measured yet -- are "not yet",
        -- not "never": that employee may well be judgeable next window, and
        -- withdrawing its plan on a quiet fortnight would be its own defect.
        -- With no goals at all there is nothing a future window can change
        -- until someone sets them.
        update de_development_items set status = 'dismissed', updated_at = now()
        where tenant_id = v_t.tid and de_id = m.de_id and item_type = 'pip'
          and source = 'detected' and status in ('proposed', 'in_progress');
      end if;

      return next v_row;
    end loop;
  end loop;
  return;
end;
$function$
;

-- (3) the two plans neither reader can reach ------------------------------
--
-- Scoped by the CONDITION, not by id: any open detected plan on an employee
-- with no goals. Measured before writing this: 2 rows, both on
-- non-operational workspaces, and 0 open plans on employees that DO have
-- goals -- so nothing judgeable is touched.
--
-- ⚠ AND THAT LAST CLAIM IS EXACTLY WHY THE GUARD BELOW WOULD BE THEATRE.
-- "No plan on a goal-having employee was withdrawn" is trivially true when
-- no such plan exists: zero out of zero. So one is CREATED here first, and
-- the guard then has something real to be wrong about. It is deleted again
-- before this migration commits.
do $seed$
declare v_t uuid; v_de uuid;
begin
  select k.tenant_id, k.de_id into v_t, v_de
    from de_kpis k
   where not exists (select 1 from de_development_items i
                      where i.de_id = k.de_id and i.item_type = 'pip'
                        and i.source = 'detected'
                        and i.status in ('proposed', 'in_progress'))
   group by k.tenant_id, k.de_id
   order by count(*) desc limit 1;

  if v_t is null then
    raise exception 'VERIFY SETUP FAILED: no goal-having employee without an open plan, so the survival guard cannot discriminate and must not be trusted';
  end if;

  insert into de_development_items
    (tenant_id, de_id, item_type, source, priority, description, status, due_date)
  values (v_t, v_de, 'pip', 'detected', 'high',
          'MIGRATION 789 PROBE — an open plan on an employee that HAS goals. Deleted before this migration commits.',
          'proposed', current_date - 1);
end
$seed$;

do $dispose$
declare v_n integer;
begin
  with doomed as (
    select i.id, i.tenant_id, i.de_id, d.name as de_name
      from de_development_items i join digital_employees d on d.id = i.de_id
     where i.item_type = 'pip' and i.source = 'detected'
       and i.status in ('proposed', 'in_progress')
       and not exists (select 1 from de_kpis k where k.de_id = i.de_id)
  ), moved as (
    update de_development_items t set status = 'dismissed', updated_at = now()
      from doomed x where t.id = x.id
    returning x.tenant_id, x.de_id, x.de_name, x.id
  )
  select count(*) into v_n from moved;

  raise notice 'withdrew % unjudgeable improvement plan(s)', v_n;
end
$dispose$;

-- proof, in the migration: each guard must be able to FAIL ----------------
do $verify$
declare v_src text; v_left integer;
begin
  -- (a) the invented constants are GONE from the sweep
  select regexp_replace(prosrc,'--[^' || chr(10) || ']*','','g') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='de_governance_sweep_internal';
  if v_src ~ 'escalation_rate <= 50' or v_src ~ 'avg_confidence >= 50' or v_src ~ 'error_rate <= 15' then
    raise exception 'VERIFY FAILED: the sweep still judges on the constants mig 765 removed';
  end if;
  if v_src !~ 'de_kpi_status_internal' then
    raise exception 'VERIFY FAILED: the sweep does not read the goals model';
  end if;
  if v_src ~ 'v_passing' then
    raise exception 'VERIFY FAILED: v_passing survives — absence can still read as failure';
  end if;

  -- (b) the review can withdraw a plan it cannot judge
  select regexp_replace(prosrc,'--[^' || chr(10) || ']*','','g') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='run_de_performance_review_internal';
  if v_src !~ 'dismissed' then
    raise exception 'VERIFY FAILED: the review still has no path that closes a stranded plan';
  end if;

  -- (c) ⚠ THE ONE THAT MEASURES RATHER THAN GREPS. No open detected plan may
  --     remain on a goal-less employee.
  select count(*) into v_left from de_development_items i
   where i.item_type = 'pip' and i.source = 'detected'
     and i.status in ('proposed', 'in_progress')
     and not exists (select 1 from de_kpis k where k.de_id = i.de_id);
  if v_left > 0 then
    raise exception 'VERIFY FAILED: % unjudgeable plan(s) still open', v_left;
  end if;

  -- (d) ...and it was CONDITION-scoped, not a blanket sweep. The seeded probe
  --     sits on an employee that has goals and must still be open. This is
  --     the assertion the fixture above exists to make answerable.
  select count(*) into v_left from de_development_items i
   where i.description like 'MIGRATION 789 PROBE%' and i.status = 'proposed';
  if v_left <> 1 then
    raise exception 'VERIFY FAILED: the probe plan on a goal-HAVING employee did not survive the disposal (found % still open) — the disposal is a blanket sweep', v_left;
  end if;
end
$verify$;

-- The probe leaves. An open Performance Improvement Plan is a real thing to
-- a real workspace; it does not get to exist because a migration needed
-- something to measure.
do $cleanup$
declare v_left integer;
begin
  delete from de_development_items where description like 'MIGRATION 789 PROBE%';
  select count(*) into v_left from de_development_items
   where description like 'MIGRATION 789 PROBE%';
  if v_left <> 0 then
    raise exception 'VERIFY FAILED: % probe row(s) survived cleanup', v_left;
  end if;
end
$cleanup$;

commit;
