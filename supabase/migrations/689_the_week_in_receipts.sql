-- 689_the_week_in_receipts.sql
-- ============================================================================
-- WHY (gap G-H of the founder-adopted failure-lens addendum, portfolio memory
-- 2026-08-10): "unmeasured value" is the cheap-to-fix killer this portfolio is
-- most exposed on. Every Monday the founder gets ONE digest per operational
-- tenant on the Command Centre ops banner: what the workforce actually
-- produced last week, counted from PRODUCTION receipts only.
--
-- Honesty rules (each one exists because an audit caught its absence):
--   • G-B bar: exam traffic is EXCLUDED (channel <> 'exam') — a metric that
--     counts the test always closes a loop ([[exam-vs-production-evidence]];
--     mig 671: 282 exams once polluted the support taxonomy).
--   • Overdue invoices are labeled FACE VALUE — only evidence-fed
--     reconciliation may claim a real balance ([[de-time-saving-gap]]).
--   • Zeros are stated, never hidden: a unit that produced nothing reads
--     "0" — that IS the finding.
--   • Every number carries its window; no rates are computed at all (the
--     700%-incident-rate lesson: a digest is counts, the reader divides).
--   • Delivery via ops_alerts, which RLS restricts to is_platform_admin()
--     (verified live before writing this) — no tenant user ever sees another
--     tenant's digest because no tenant user sees ANY of this table.
--   • raise_ops_alert dedups on kind GLOBALLY, so this writes ops_alerts
--     directly with a kind that embeds ISO week + tenant, and checks
--     not-exists first — one digest per tenant per week, idempotent re-runs.
-- ============================================================================

begin;

create or replace function public.compose_weekly_value_digest()
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_week text := to_char(now(), 'IYYY"-W"IW');
  v_t record;
  v_units jsonb;
  v_rollup jsonb;
  v_kind text;
  v_created int;
  v_decided int;
  v_pending int;
  v_pay int;
  v_overdue int;
  v_written int := 0;
begin
  for v_t in
    select t.id, t.name from tenants t
     where tenant_is_operational(t.id)
  loop
    begin  -- per-tenant isolation: one bad tenant cannot kill the digest tick
      v_kind := 'value_digest_' || v_week || '_' || left(v_t.id::text, 8);
      if exists (select 1 from ops_alerts where kind = v_kind) then continue; end if;

      select coalesce(jsonb_agg(jsonb_build_object(
               'unit', u.archetype_key,
               'employees', u.n_emp,
               'work_items_done_7d', u.done,
               'deliverables_7d', u.deliv,
               'production_conversations_7d', u.convos
             ) order by u.archetype_key), '[]'::jsonb)
        into v_units
        from (
          select coalesce(de.archetype_key, '(no archetype)') as archetype_key,
                 count(distinct de.id) as n_emp,
                 count(distinct w.id)  as done,
                 count(distinct dl.id) as deliv,
                 count(distinct c.id)  as convos
            from digital_employees de
            left join de_work_items w
              on w.de_id = de.id and w.status = 'done'
             and w.updated_at > now() - interval '7 days'
            left join de_deliverables dl
              on dl.de_id = de.id and dl.created_at > now() - interval '7 days'
            left join de_conversations c
              on c.de_id = de.id and c.channel <> 'exam'
             and c.created_at > now() - interval '7 days'
           where de.tenant_id = v_t.id
             and de.lifecycle_status in ('active','published','improving')
           group by coalesce(de.archetype_key, '(no archetype)')
        ) u;

      select count(*) into v_created from human_tasks
       where tenant_id = v_t.id and created_at > now() - interval '7 days';
      select count(*) into v_decided from human_tasks
       where tenant_id = v_t.id and decided_at > now() - interval '7 days';
      select count(*) into v_pending from human_tasks
       where tenant_id = v_t.id and status = 'pending';
      select count(*) into v_pay from invoice_payments
       where tenant_id = v_t.id and created_at > now() - interval '7 days';
      select count(*) into v_overdue from renewal_invoices
       where tenant_id = v_t.id and status = 'overdue';

      v_rollup := jsonb_build_object(
        'window_days', 7,
        'human_tasks_created_7d', v_created,
        'human_tasks_decided_7d', v_decided,
        'human_tasks_pending_now', v_pending,
        'payments_recorded_7d', v_pay,
        'invoices_overdue_now_face_value', v_overdue,
        'notes', jsonb_build_array(
          'exam traffic excluded from every count',
          'overdue invoices are face value — a balance is only real after payment reconciliation',
          'counts only, no rates: the reader divides'));

      insert into ops_alerts (kind, message, detail)
      values (v_kind,
        format('Week in receipts — %s: %s decided of %s new asks (%s pending now) · %s work items done · %s payments recorded · %s invoices overdue (face value). Exams excluded.',
          v_t.name, v_decided, v_created, v_pending,
          (select coalesce(sum((u->>'work_items_done_7d')::int), 0) from jsonb_array_elements(v_units) u),
          v_pay, v_overdue),
        jsonb_build_object('digest', 'weekly_value', 'week', v_week,
                           'tenant_id', v_t.id, 'tenant_name', v_t.name,
                           'units', v_units, 'rollup', v_rollup));
      v_written := v_written + 1;
    exception when others then
      raise warning 'value digest failed for tenant %: %', v_t.id, sqlerrm;
    end;
  end loop;

  return 'value digest: ' || v_written || ' tenant digest(s) written for ' || v_week;
end; $$;

-- Migs 610+630 rule: strip both default-grant mechanisms.
revoke all on function public.compose_weekly_value_digest() from public, anon, authenticated;
grant execute on function public.compose_weekly_value_digest() to service_role;

-- ── Cron: Monday 06:45, after the 06:00/06:30 detector+program pair ──
do $$
begin
  if exists (select 1 from cron.job where jobname = 'weekly-value-digest') then
    perform cron.unschedule('weekly-value-digest');
  end if;
  perform cron.schedule('weekly-value-digest', '45 6 * * 1',
                        'select compose_weekly_value_digest()');
end $$;

-- ── First edition + verify: run it NOW so the founder sees week one without
--    waiting for Monday, then prove the run wrote what it claims. ──
do $$
declare
  v_report text;
  v_ops int;
  v_alerts int;
  v_sample jsonb;
begin
  select count(*) into v_ops from tenants t where tenant_is_operational(t.id);
  if v_ops = 0 then
    raise exception '689: zero operational tenants — verify would be vacuous, investigate';
  end if;

  select compose_weekly_value_digest() into v_report;
  raise notice '689: %', v_report;

  select count(*) into v_alerts from ops_alerts
   where kind like 'value_digest_' || to_char(now(), 'IYYY"-W"IW') || '%';
  if v_alerts < 1 then
    raise exception '689: composer ran but no digest alert exists for this week';
  end if;

  -- The digest must carry its honesty freight: units array + the face-value
  -- and exam-exclusion notes.
  select detail into v_sample from ops_alerts
   where kind like 'value_digest_' || to_char(now(), 'IYYY"-W"IW') || '%' limit 1;
  if jsonb_typeof(v_sample->'units') <> 'array' then
    raise exception '689: digest detail has no units array';
  end if;
  if v_sample->'rollup'->>'invoices_overdue_now_face_value' is null then
    raise exception '689: digest lost the face-value framing';
  end if;

  -- The delivery channel must still be platform-only (leak guard).
  if not exists (select 1 from pg_policy where polrelid = 'ops_alerts'::regclass
                  and pg_get_expr(polqual, polrelid) like '%is_platform_admin%') then
    raise exception '689: ops_alerts is no longer platform-gated — digest would leak';
  end if;

  -- Idempotency: a second run this week must write nothing new.
  select compose_weekly_value_digest() into v_report;
  if (select count(*) from ops_alerts
       where kind like 'value_digest_' || to_char(now(), 'IYYY"-W"IW') || '%') <> v_alerts then
    raise exception '689: re-run duplicated digests — idempotency broken';
  end if;

  raise notice '689: % digest(s) live for %, idempotent, platform-gated', v_alerts, to_char(now(), 'IYYY"-W"IW');
end $$;

commit;
