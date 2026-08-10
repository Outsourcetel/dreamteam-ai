-- 688 — the tripwire pulse counts work that LANDED, not decision literals.
--
-- The landed-predicate ratchet (mig 679 / certify) caught 687's sweep naming
-- 'auto_executed'/'executed_after_approval' directly. It was right to: a
-- unit's pulse is PRODUCTION EVIDENCE, and mig 679 exists because four
-- different readers mistook a claim-time marker for proof the work happened.
-- A pulse built on claims would keep a unit "alive" on work that never
-- returned. Both action reads (fed-detection and the 90-day pulse) now go
-- through public.action_execution_landed(). Everything else is 687 verbatim.
--
-- (687's one-time SEED used the literals; that history stands — the sweep's
-- own fed-detection re-derives first_fed_at for dormant units through the
-- predicate from here on.)

create or replace function public.run_unit_tripwires_sweep()
returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_fed int := 0; v_deadline_rests int := 0; v_review_rests int := 0; v_continues int := 0;
  r record;
  v_days numeric; v_pulse numeric; v_ok_pulse boolean; v_ok_quality boolean;
  v_appr bigint; v_dec bigint; v_open_inc bigint;
begin
  -- 1. Dormant units whose demand has arrived become FED (clock starts).
  update unit_tripwires u
     set state = 'fed', first_fed_at = fed.first_ts,
         review_due_at = greatest(fed.first_ts + interval '90 days', now() + interval '7 days'),
         feeding_deadline = null, updated_at = now()
    from (
      select u2.id as uid, least(
        (select min(w.created_at) from de_work_items w where w.de_id = u2.de_id and w.status = 'done'),
        (select min(c.created_at) from de_conversations c where c.de_id = u2.de_id and c.channel <> 'exam'),
        (select min(a.created_at) from action_executions a
          where a.subject_kind = 'de' and a.subject_id = u2.de_id
            and public.action_execution_landed(a))) as first_ts
      from unit_tripwires u2 where u2.state = 'dormant'
    ) fed
   where fed.uid = u.id and fed.first_ts is not null;
  get diagnostics v_fed = row_count;

  -- 2. Dormant past the feeding deadline → rest, loudly.
  for r in select u.*, coalesce(d.persona_name, d.name) as who
             from unit_tripwires u join digital_employees d on d.id = u.de_id
            where u.state = 'dormant' and u.feeding_deadline is not null
              and u.feeding_deadline <= now()
  loop
    update unit_tripwires set state = 'resting', rested_at = now(), updated_at = now(),
           last_verdict = 'rest', last_verdict_at = now(),
           rest_reason = 'feeding deadline passed — staffed 45+ days with no real demand'
     where id = r.id;
    update work_watchers set active = false, updated_at = now()
     where de_id = r.de_id and active;
    if not exists (select 1 from human_tasks h where h.related_table = 'unit_tripwires'
                     and h.related_id = r.id and h.status = 'pending') then
      insert into human_tasks (tenant_id, type, source, title, detail, related_table, related_id, origin)
      values (r.tenant_id, 'escalation', 'de',
              'Unit resting — ' || r.who || ' (never fed)',
              r.who || ' was staffed on ' || to_char(r.staffed_at, 'FMDD FMMonth YYYY')
              || ' and has received no real demand in 45 days. Its watchers are paused and it is resting'
              || ' — the employee remains and nothing is deleted. To wake it: load its demand'
              || ' (book, channel, or records) and revive the unit.',
              'unit_tripwires', r.id, 'production');
    end if;
    v_deadline_rests := v_deadline_rests + 1;
  end loop;

  -- 3. Fed units at review: pulse floor + quality floor, exam-filtered.
  for r in select u.*, coalesce(d.persona_name, d.name) as who
             from unit_tripwires u join digital_employees d on d.id = u.de_id
            where u.state = 'fed' and u.review_due_at is not null and u.review_due_at <= now()
  loop
    v_days := least(90, greatest(7, extract(epoch from now() - r.first_fed_at) / 86400));
    select (select count(*) from de_work_items w where w.de_id = r.de_id and w.status = 'done'
              and w.created_at >= now() - interval '90 days')
         + (select count(*) from de_conversations c where c.de_id = r.de_id and c.channel <> 'exam'
              and c.created_at >= now() - interval '90 days')
         + (select count(*) from action_executions a where a.subject_kind = 'de' and a.subject_id = r.de_id
              and public.action_execution_landed(a)
              and a.created_at >= now() - interval '90 days')
      into v_pulse;
    v_ok_pulse := v_pulse >= r.pulse_floor_per_week * (v_days / 7.0);

    select count(*) filter (where status = 'approved'), count(*)
      into v_appr, v_dec
      from human_tasks
     where de_id = r.de_id and status in ('approved', 'rejected')
       and decided_at >= now() - interval '90 days'
       and evidence_is_production(origin)
       and type in ('action_approval', 'approval_gate', 'inquiry_review', 'escalation', 'review_gate');
    select count(*) into v_open_inc from de_incidents
     where de_id = r.de_id and status not in ('resolved', 'closed', 'dismissed');
    v_ok_quality := (v_open_inc = 0)
                and (v_dec = 0 or v_appr::numeric / v_dec >= r.min_approval_rate);

    if v_ok_pulse and v_ok_quality then
      update unit_tripwires set last_verdict = 'continue', last_verdict_at = now(),
             review_due_at = now() + interval '90 days', updated_at = now()
       where id = r.id;
      v_continues := v_continues + 1;
    else
      update unit_tripwires set state = 'resting', rested_at = now(), updated_at = now(),
             last_verdict = 'rest', last_verdict_at = now(),
             rest_reason = trim(both ' ' from
               case when not v_ok_pulse then format('pulse %s in %s days is below the floor of %s/week. ', round(v_pulse), round(v_days), r.pulse_floor_per_week) else '' end
               || case when v_open_inc > 0 then v_open_inc || ' open incident(s). ' else '' end
               || case when v_dec > 0 and v_appr::numeric / v_dec < r.min_approval_rate
                       then format('approval rate %s%% is below %s%%.', round(100.0 * v_appr / v_dec), round(100 * r.min_approval_rate)) else '' end)
       where id = r.id;
      update work_watchers set active = false, updated_at = now()
       where de_id = r.de_id and active;
      if not exists (select 1 from human_tasks h where h.related_table = 'unit_tripwires'
                       and h.related_id = r.id and h.status = 'pending') then
        insert into human_tasks (tenant_id, type, source, title, detail, related_table, related_id, origin)
        values (r.tenant_id, 'escalation', 'de',
                'Unit resting — ' || r.who || ' (below floor at review)',
                r.who || '''s 90-day review tripped: '
                || (select rest_reason from unit_tripwires where id = r.id)
                || ' Watchers are paused; the employee remains. Revive when its demand or quality recovers.',
                'unit_tripwires', r.id, 'production');
      end if;
      v_review_rests := v_review_rests + 1;
    end if;
  end loop;

  return jsonb_build_object('fed', v_fed, 'deadline_rests', v_deadline_rests,
                            'review_rests', v_review_rests, 'continues', v_continues);
end;
$function$;
revoke all on function public.run_unit_tripwires_sweep() from public, anon, authenticated;
grant execute on function public.run_unit_tripwires_sweep() to service_role;

-- ── Prove it ───────────────────────────────────────────────────────────────
do $$
declare v_sweep jsonb;
begin
  -- The ratchet's demand is met: the sweep calls the shared predicate and no
  -- longer names either decision literal.
  perform 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_unit_tripwires_sweep'
     and p.prosrc ilike '%action_execution_landed%'
     and p.prosrc not ilike '%auto_executed%'
     and p.prosrc not ilike '%executed_after_approval%';
  if not found then raise exception '688: the sweep still names a decision literal or dropped the predicate'; end if;

  -- And it still runs clean on day zero.
  v_sweep := public.run_unit_tripwires_sweep();
  if coalesce((v_sweep->>'deadline_rests')::int, -1) <> 0
     or coalesce((v_sweep->>'review_rests')::int, -1) <> 0 then
    raise exception '688: sweep tripped something unexpectedly: %', v_sweep;
  end if;
end $$;
