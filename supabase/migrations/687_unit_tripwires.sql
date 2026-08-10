-- 687 — a unit either performs, or rests. Nothing zombies (G-C).
--
-- Founder ratified 2026-08-10: two tripwires, three states.
--   DORMANT  — staffed but never fed real demand. Feeding deadline 45 days;
--              unfed past deadline → RESTING. The trip is on demand-loading
--              (mostly founder-side work), and resting is the no-shame state.
--   FED      — real demand flowing. Performance review at first_fed + 90d:
--              pulse floor ≥ 1 production work-unit/week (exam-filtered per
--              mig 682) AND quality floor (no open incidents; ≥70% approval
--              where the unit has decided approvals). Below floor → RESTING
--              by default; revival is one founder action.
--   RESTING  — watchers off, no build investment (doctrine), attention off.
--              THE EMPLOYEE IS NEVER CLOSED (founder standing rule). Blair
--              (bdr) and Sky (marketing) formalize here now — the portfolio
--              HOLD, encoded. seo/google_ads archetypes rest with them.
--   EXEMPT   — the Workspace Assistant: platform property, no tripwire.
--
-- Deliberate choices:
--   * Rest-notice tasks carry de_id NULL. A decided governance notice must
--     never count as approval EVIDENCE about the employee (mig 586 counts
--     decided escalations; unattributed tasks are excluded from scoped
--     policies by design).
--   * Auto-rest at a tripped floor IS the ratified pre-commitment. It is
--     reversible in minutes (revive_unit), non-destructive, and the notice
--     task makes it loud. The founder overrides by reviving, not by the
--     system waiting forever for a decision that never comes — waiting
--     forever is the zombie state this migration exists to kill.

-- ── The record ─────────────────────────────────────────────────────────────
create table if not exists unit_tripwires (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  de_id                uuid not null references digital_employees(id) on delete cascade,
  state                text not null default 'dormant'
                         check (state in ('dormant', 'fed', 'resting', 'exempt')),
  staffed_at           timestamptz not null default now(),
  feeding_deadline     timestamptz,
  first_fed_at         timestamptz,
  review_due_at        timestamptz,
  pulse_floor_per_week numeric not null default 1,
  min_approval_rate    numeric not null default 0.7,
  last_verdict         text check (last_verdict in ('continue', 'rest')),
  last_verdict_at      timestamptz,
  rested_at            timestamptz,
  rest_reason          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, de_id)
);
alter table unit_tripwires enable row level security;
drop policy if exists unit_tripwires_read on unit_tripwires;
create policy unit_tripwires_read on unit_tripwires for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- ── Seed every active employee on every active tenant ──────────────────────
insert into unit_tripwires (tenant_id, de_id, state, staffed_at, feeding_deadline,
                            first_fed_at, review_due_at, rested_at, rest_reason)
select d.tenant_id, d.id,
       case
         when coalesce(d.is_workforce_assistant, false)               then 'exempt'
         when d.archetype_key in ('bdr','marketing','seo','google_ads') then 'resting'
         when fed.first_ts is not null                                 then 'fed'
         else 'dormant'
       end,
       d.created_at,
       case when coalesce(d.is_workforce_assistant,false) = false
             and d.archetype_key not in ('bdr','marketing','seo','google_ads')
             and fed.first_ts is null
            then now() + interval '45 days' end,
       fed.first_ts,
       case when fed.first_ts is not null
            then greatest(fed.first_ts + interval '90 days', now() + interval '7 days') end,
       case when d.archetype_key in ('bdr','marketing','seo','google_ads') then now() end,
       case when d.archetype_key in ('bdr','marketing','seo','google_ads')
            then 'portfolio HOLD (founder, 2026-08-10)' end
  from digital_employees d
  join tenants t on t.id = d.tenant_id and t.status = 'active'
  left join lateral (
    select least(
      (select min(w.created_at) from de_work_items w where w.de_id = d.id and w.status = 'done'),
      (select min(c.created_at) from de_conversations c where c.de_id = d.id and c.channel <> 'exam'),
      (select min(a.created_at) from action_executions a
        where a.subject_kind = 'de' and a.subject_id = d.id
          and a.decision in ('auto_executed', 'executed_after_approval'))
    ) as first_ts
  ) fed on true
 where coalesce(d.lifecycle_status, 'active') not in ('paused', 'retired', 'archived')
   and not exists (select 1 from unit_tripwires u where u.tenant_id = d.tenant_id and u.de_id = d.id);

-- The HOLD is enacted, not just recorded: resting units' watchers go quiet.
update work_watchers ww
   set active = false, updated_at = now()
  from unit_tripwires u
 where u.de_id = ww.de_id and u.tenant_id = ww.tenant_id
   and u.state = 'resting' and ww.active;

-- ── The sweep (daily): transitions, trips, and reviews ─────────────────────
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
            and a.decision in ('auto_executed', 'executed_after_approval'))) as first_ts
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
              and a.decision in ('auto_executed', 'executed_after_approval')
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

-- ── Revival — one founder action, audited ──────────────────────────────────
create or replace function public.revive_unit(p_de_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_u unit_tripwires; v_who text;
begin
  select u.* into v_u from unit_tripwires u
   where u.de_id = p_de_id and u.tenant_id = auth_tenant_id();
  if v_u.id is null then raise exception 'no tripwire record for this employee in your workspace'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only a workspace owner or admin may revive a unit';
  end if;
  if v_u.state <> 'resting' then
    return jsonb_build_object('revived', false, 'reason', 'unit is ' || v_u.state || ', not resting');
  end if;

  update unit_tripwires set
    state = case when first_fed_at is not null then 'fed' else 'dormant' end,
    review_due_at = case when first_fed_at is not null then now() + interval '90 days' end,
    feeding_deadline = case when first_fed_at is null then now() + interval '45 days' end,
    rested_at = null, rest_reason = null, updated_at = now()
  where id = v_u.id;

  update work_watchers set active = true, updated_at = now()
   where de_id = p_de_id and tenant_id = v_u.tenant_id and not active;

  select coalesce(d.persona_name, d.name) into v_who from digital_employees d where d.id = p_de_id;
  perform append_audit_event(v_u.tenant_id, 'workspace admin', 'human',
    'Unit revived — ' || v_who || ' returns to ' ||
    case when v_u.first_fed_at is not null then 'FED (next review in 90 days)'
         else 'DORMANT (fresh 45-day feeding deadline)' end,
    'governance', jsonb_build_object('de_id', p_de_id, 'origin', 'production'));
  return jsonb_build_object('revived', true,
    'state', case when v_u.first_fed_at is not null then 'fed' else 'dormant' end);
end;
$function$;
revoke all on function public.revive_unit(uuid) from public, anon;
grant execute on function public.revive_unit(uuid) to authenticated, service_role;

-- ── Daily cron ─────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'unit-tripwires-daily') then
    perform cron.unschedule('unit-tripwires-daily');
  end if;
  perform cron.schedule('unit-tripwires-daily', '15 5 * * *', 'select public.run_unit_tripwires_sweep()');
end $$;

-- ── Prove it, in this transaction ──────────────────────────────────────────
do $$
declare v_n bigint; v_sweep jsonb;
begin
  -- Every active hq employee has exactly one tripwire record.
  select count(*) into v_n
    from digital_employees d join tenants t on t.id = d.tenant_id
   where t.slug = 'outsourcetel-hq'
     and coalesce(d.lifecycle_status, 'active') not in ('paused', 'retired', 'archived')
     and not exists (select 1 from unit_tripwires u where u.de_id = d.id);
  if v_n > 0 then raise exception '687: % hq employee(s) without a tripwire record', v_n; end if;

  -- Fed units are fed; dormant units carry a ~45-day deadline; the HOLD rests.
  select count(*) into v_n
    from unit_tripwires u join digital_employees d on d.id = u.de_id
    join tenants t on t.id = u.tenant_id
   where t.slug = 'outsourcetel-hq' and (
        (d.archetype_key in ('billing_ar','cs_manager','fpa','accounting','onboarding')
          and (u.state <> 'fed' or u.first_fed_at is null or u.review_due_at is null))
     or (d.archetype_key in ('support_agent','renewal_manager','front_desk','it_helpdesk')
          and (u.state <> 'dormant'
               or u.feeding_deadline not between now() + interval '44 days' and now() + interval '46 days'))
     or (d.archetype_key in ('bdr','marketing') and u.state <> 'resting')
     or (coalesce(d.is_workforce_assistant, false) and u.state <> 'exempt'));
  if v_n > 0 then raise exception '687: % hq unit(s) seeded into the wrong state', v_n; end if;

  -- Nothing outside the founder''s HOLD list was born resting.
  select count(*) into v_n
    from unit_tripwires u join digital_employees d on d.id = u.de_id
   where u.state = 'resting'
     and coalesce(d.archetype_key, '') not in ('bdr','marketing','seo','google_ads');
  if v_n > 0 then raise exception '687: % unit(s) born resting outside the HOLD list', v_n; end if;

  -- Resting units'' watchers are actually quiet.
  select count(*) into v_n
    from work_watchers ww join unit_tripwires u
      on u.de_id = ww.de_id and u.tenant_id = ww.tenant_id
   where u.state = 'resting' and ww.active;
  if v_n > 0 then raise exception '687: % watcher(s) still active on resting units', v_n; end if;

  -- The sweep runs, and today it trips nothing (no deadline has passed,
  -- no review is due before its bootstrap date).
  v_sweep := public.run_unit_tripwires_sweep();
  if coalesce((v_sweep->>'deadline_rests')::int, -1) <> 0
     or coalesce((v_sweep->>'review_rests')::int, -1) <> 0 then
    raise exception '687: first sweep tripped something on day zero: %', v_sweep;
  end if;
end $$;
