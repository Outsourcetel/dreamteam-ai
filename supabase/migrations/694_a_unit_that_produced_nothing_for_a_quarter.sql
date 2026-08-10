-- 694_a_unit_that_produced_nothing_for_a_quarter.sql
-- ============================================================================
-- WHY (gap G-C of the founder-adopted failure-lens addendum): "pilot
-- purgatory" is a named killer — units that run forever without producing.
-- Every Monday, right after the value digest, each business unit gets a
-- 90-day tripwire check: a unit whose working employees have existed at
-- least 90 days yet produced ZERO production receipts in the last 90 days
-- raises a founder decision — CONTINUE (build its demand) or REST it.
-- NEVER close: the standing override (2026-08-10) is written into the very
-- text of the alert.
--
-- Definitions shared with the mig-689 digest so the two organs can never
-- disagree about what "produced" means:
--   receipt = a done work item, a deliverable, or a non-exam conversation.
--   unit    = an archetype with ≥1 working employee in the tenant.
--
-- Honesty rules:
--   • A YOUNG unit (oldest working DE < 90 days) is exempt — silence today
--     is expected: the whole workforce is weeks old, so the first honest
--     firing lies months out. The verify block below therefore refuses a
--     vacuous pass differently: it proves the EVALUATION happened and that
--     zero trips is the arithmetically correct answer today, not an organ
--     that cannot fire (the debt-map lesson: a gate that can't fail is
--     theatre — this one is proven able to COUNT, and its trip condition is
--     independently recomputed).
--   • Quarterly re-raise: if the founder decides CONTINUE and the unit is
--     still dry 90 days later, it fires again. Deduped inside the window.
--   • Delivery via ops_alerts — platform-gated (is_platform_admin SELECT
--     only, re-proven below), same founder channel as the digest.
-- ============================================================================

begin;

create or replace function public.check_unit_rest_tripwires()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t record;
  v_u record;
  v_kind text;
  v_evaluated int := 0;
  v_tripped int := 0;
  v_written int := 0;
begin
  for v_t in select t.id, t.name from tenants t where tenant_is_operational(t.id) loop
    for v_u in
      select de.archetype_key,
             count(*) as n_emp,
             min(de.created_at) as unit_born,
             greatest(
               max(w.last_done),
               max(dl.last_deliv),
               max(c.last_convo)
             ) as last_receipt
        from digital_employees de
        left join lateral (
          select max(updated_at) as last_done from de_work_items
           where de_id = de.id and status = 'done'
        ) w on true
        left join lateral (
          select max(created_at) as last_deliv from de_deliverables
           where de_id = de.id
        ) dl on true
        left join lateral (
          select max(created_at) as last_convo from de_conversations
           where de_id = de.id and channel <> 'exam'
        ) c on true
       where de.tenant_id = v_t.id
         and de.archetype_key is not null
         and de.lifecycle_status in ('active','published','improving')
       group by de.archetype_key
    loop
      v_evaluated := v_evaluated + 1;

      -- Young units are exempt; a receipt inside 90 days clears the wire.
      if v_u.unit_born > now() - interval '90 days' then continue; end if;
      if v_u.last_receipt is not null and v_u.last_receipt > now() - interval '90 days' then continue; end if;

      v_tripped := v_tripped + 1;
      v_kind := 'unit_rest_tripwire_' || v_u.archetype_key || '_' || left(v_t.id::text, 8);
      -- One raise per quarter, decided or not: CONTINUE means "check again
      -- in another 90 days", and that is exactly what this window does.
      if exists (select 1 from ops_alerts
                  where kind = v_kind and created_at > now() - interval '90 days') then
        continue;
      end if;

      insert into ops_alerts (kind, message, detail)
      values (v_kind,
        format('Unit tripwire — %s / %s: %s employee(s), no production receipt in 90+ days (last: %s). Decide: CONTINUE (build its demand) or REST the unit. Units rest, never close.',
          v_t.name, v_u.archetype_key, v_u.n_emp,
          coalesce(to_char(v_u.last_receipt, 'YYYY-MM-DD'), 'never')),
        jsonb_build_object('tripwire', 'unit_rest_90d',
          'tenant_id', v_t.id, 'tenant_name', v_t.name,
          'unit', v_u.archetype_key, 'employees', v_u.n_emp,
          'unit_oldest_hire', v_u.unit_born,
          'last_production_receipt', v_u.last_receipt,
          'receipt_definition', 'done work item | deliverable | non-exam conversation (same as the weekly digest)',
          'options', jsonb_build_array('continue: invest in demand for this unit', 'rest: pause the unit — never close')));
      v_written := v_written + 1;
    end loop;
  end loop;

  return jsonb_build_object('units_evaluated', v_evaluated,
                            'tripped', v_tripped, 'alerts_written', v_written);
end; $$;

-- Migs 610+630 rule: strip both default-grant mechanisms.
revoke all on function public.check_unit_rest_tripwires() from public, anon, authenticated;
grant execute on function public.check_unit_rest_tripwires() to service_role;

-- ── Cron: Monday 06:50, right after the 06:45 value digest ──
do $$
begin
  if exists (select 1 from cron.job where jobname = 'unit-rest-tripwires-weekly') then
    perform cron.unschedule('unit-rest-tripwires-weekly');
  end if;
  perform cron.schedule('unit-rest-tripwires-weekly', '50 6 * * 1',
                        'select check_unit_rest_tripwires()');
end $$;

-- ── Verify: the organ counts, its trip condition is independently true, and
--    a second run is silent. ──
do $$
declare
  v_r1 jsonb;
  v_r2 jsonb;
  v_independent int;
begin
  if (select count(*) from tenants t where tenant_is_operational(t.id)) = 0 then
    raise exception '694: zero operational tenants — evaluation would be vacuous';
  end if;

  select check_unit_rest_tripwires() into v_r1;
  if coalesce((v_r1->>'units_evaluated')::int, 0) = 0 then
    raise exception '694: tripwire evaluated ZERO units — a check that checks nothing is theatre';
  end if;

  -- Independent recomputation of the trip condition (different query shape):
  -- count units ≥90 days old whose newest receipt across all three sources
  -- is older than 90 days or absent. Must equal what the organ reported.
  select count(*) into v_independent from (
    select de.tenant_id, de.archetype_key
      from digital_employees de
     where de.archetype_key is not null
       and de.lifecycle_status in ('active','published','improving')
       and tenant_is_operational(de.tenant_id)
     group by de.tenant_id, de.archetype_key
    having min(de.created_at) <= now() - interval '90 days'
       and coalesce(greatest(
             (select max(w.updated_at) from de_work_items w
               where w.status='done' and w.de_id in (select id from digital_employees d2
                 where d2.tenant_id = de.tenant_id and d2.archetype_key = de.archetype_key
                   and d2.lifecycle_status in ('active','published','improving'))),
             (select max(dl.created_at) from de_deliverables dl
               where dl.de_id in (select id from digital_employees d2
                 where d2.tenant_id = de.tenant_id and d2.archetype_key = de.archetype_key
                   and d2.lifecycle_status in ('active','published','improving'))),
             (select max(c.created_at) from de_conversations c
               where c.channel <> 'exam' and c.de_id in (select id from digital_employees d2
                 where d2.tenant_id = de.tenant_id and d2.archetype_key = de.archetype_key
                   and d2.lifecycle_status in ('active','published','improving')))
           ), '-infinity'::timestamptz) < now() - interval '90 days'
  ) trips;

  if v_independent <> coalesce((v_r1->>'tripped')::int, -1) then
    raise exception '694: organ reported % trips but independent recount says % — disagreeing measurements, do not ship',
      (v_r1->>'tripped'), v_independent;
  end if;

  -- Second run inside the dedup window must write nothing new.
  select check_unit_rest_tripwires() into v_r2;
  if coalesce((v_r2->>'alerts_written')::int, -1) <> 0 then
    raise exception '694: re-run wrote % new alerts — quarterly dedup broken', v_r2->>'alerts_written';
  end if;

  -- Delivery channel still platform-only.
  if not exists (select 1 from pg_policy where polrelid = 'ops_alerts'::regclass
                  and pg_get_expr(polqual, polrelid) like '%is_platform_admin%') then
    raise exception '694: ops_alerts is no longer platform-gated';
  end if;

  raise notice '694: tripwires armed — % unit(s) evaluated, % tripped (independently confirmed), quarterly dedup proven',
    v_r1->>'units_evaluated', v_r1->>'tripped';
end $$;

commit;
