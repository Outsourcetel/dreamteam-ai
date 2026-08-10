-- 702 — the digest learns what the founder's time cost (G-D ⨯ G-H wiring).
--
-- mig 689 built the weekly value digest; mig 691 built the human-review cost
-- model and granted get_review_cost_internal to service_role as the digest's
-- consumer hook. This joins them: every weekly digest now carries the MODELED
-- human-review block — total standard minutes, who consumed them, and the
-- dollar line that stays honestly NULL until the G-A baseline lands.
--
-- House rules of the host organ, kept deliberately:
--   • counts only, no rates — the digest DROPS the model's minutes_per_output
--     field (the reader divides); modeled_cost_usd stays (a cost, not a rate,
--     and null-until-baseline).
--   • the notes array gains the model's own disclaimer, so the block can
--     never be read as a measurement.
--   • per-tenant fault isolation, ISO-week idempotency, platform-gated
--     delivery: all untouched (the body below is 689 verbatim plus the block).
--
-- This week's already-issued editions are re-issued richer (delete + recompose
-- in the verify): ops_alerts are notifications, not an audit chain — a
-- same-day superset re-issue is an enhancement, not history rewritten.

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
  v_review jsonb;
  v_review_block jsonb;
  v_review_minutes numeric;
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

      -- 702: the founder's own time, modeled (mig 691), on the digest's
      -- 7-day window. Reduced to the host organ's rules: no rate field.
      v_review := public.get_review_cost_internal(v_t.id, 7);
      v_review_minutes := coalesce((v_review->'decided'->>'total_minutes')::numeric, 0);
      v_review_block := jsonb_build_object(
        'basis', v_review->>'basis',
        'total_modeled_minutes_7d', v_review_minutes,
        'by_de', v_review->'decided'->'by_de',
        'outputs_7d', v_review->'outputs',
        'hourly_rate_usd', v_review->'hourly_rate_usd',
        'modeled_cost_usd', v_review->'modeled_cost_usd',
        'note', v_review->>'note');

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
          'counts only, no rates: the reader divides',
          'human-review minutes are MODELED (standard minutes × decided tasks), never measured — tune them in Settings'));

      insert into ops_alerts (kind, message, detail)
      values (v_kind,
        format('Week in receipts — %s: %s decided of %s new asks (%s pending now) · %s work items done · %s payments recorded · %s invoices overdue (face value) · ~%s modeled review minutes. Exams excluded.',
          v_t.name, v_decided, v_created, v_pending,
          (select coalesce(sum((u->>'work_items_done_7d')::int), 0) from jsonb_array_elements(v_units) u),
          v_pay, v_overdue, round(v_review_minutes)),
        jsonb_build_object('digest', 'weekly_value', 'week', v_week,
                           'tenant_id', v_t.id, 'tenant_name', v_t.name,
                           'units', v_units, 'rollup', v_rollup,
                           'human_review', v_review_block));
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

-- ── Verify: re-issue this week's editions richer, then prove the block ──
do $$
declare
  v_week text := to_char(now(), 'IYYY"-W"IW');
  v_before int;
  v_after int;
  v_sample jsonb;
begin
  -- Count, then re-issue: delete this week's editions and recompose. A
  -- notification re-issued same-day as a superset is an enhancement — and if
  -- the count comes back different, something structural broke.
  select count(*) into v_before from ops_alerts where kind like 'value_digest_' || v_week || '%';
  delete from ops_alerts where kind like 'value_digest_' || v_week || '%';
  perform compose_weekly_value_digest();
  select count(*) into v_after from ops_alerts where kind like 'value_digest_' || v_week || '%';
  if v_before > 0 and v_after <> v_before then
    raise exception '702: re-issue changed the edition count (% -> %)', v_before, v_after;
  end if;
  if v_after = 0 then
    raise exception '702: composer wrote no digests — zero operational tenants would be its own finding';
  end if;

  -- Every edition carries the human-review block, labeled as a model, with
  -- the host organ's rules intact (no rate field; the new note present).
  for v_sample in select detail from ops_alerts where kind like 'value_digest_' || v_week || '%'
  loop
    if v_sample->'human_review' is null then
      raise exception '702: an edition lacks the human_review block';
    end if;
    if (v_sample->'human_review'->>'basis') is distinct from 'modeled_standard_minutes' then
      raise exception '702: the block lost its model label';
    end if;
    if v_sample->'human_review' ? 'minutes_per_output' then
      raise exception '702: a rate leaked into the digest — the reader divides';
    end if;
    if not (v_sample->'rollup'->'notes')::text ilike '%never measured%' then
      raise exception '702: the modeled-minutes note is missing from the notes array';
    end if;
    -- 689's own freight must survive the rewrite.
    if jsonb_typeof(v_sample->'units') <> 'array'
       or v_sample->'rollup'->>'invoices_overdue_now_face_value' is null then
      raise exception '702: a 689 invariant was lost in the rewrite';
    end if;
  end loop;

  -- Idempotency unchanged: a second run this week writes nothing new.
  perform compose_weekly_value_digest();
  if (select count(*) from ops_alerts where kind like 'value_digest_' || v_week || '%') <> v_after then
    raise exception '702: re-run duplicated digests — idempotency broken';
  end if;
end $$;

commit;
