-- 673_a_review_nobody_can_see_is_not_pending.sql
-- ============================================================================
-- WHY (found 2026-08-10 while verifying founder decision #3, docs/31):
-- 3 of 4 review_pending de_improvements had human_task_id = NULL — their
-- review tasks were deleted at some point, and the FK's ON DELETE SET NULL
-- silently orphaned them. An orphaned review is invisible to every reviewer
-- AND still counts toward de-improve's <3-open-reviews backpressure, so
-- outsourcetel-hq sat exactly at 3 phantom reviews and the improvement driver
-- stopped attempting anything for the tenant. The machine looked idle; it was
-- starved by reviews nobody could see. (Same family as mig 642: a broken
-- linkage making pending look like progress.)
--
-- Fix, three parts:
--   1. create_improvement_review may RE-ISSUE a lost review: it now accepts a
--      row that is review_pending with no live task, not only 'replayed'.
--      Legitimate double-call is still refused (live task present).
--   2. Repair: re-issue tasks for every currently-orphaned review, all tenants.
--   3. Verify: zero review_pending rows without a LIVE task; refuses a
--      vacuous pass by counting the repairs it expected to make.
-- ============================================================================

begin;

create or replace function public.create_improvement_review(p_improvement_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare imp de_improvements; v_task uuid; v_name text; v_live_task uuid;
begin
  select * into imp from de_improvements where id = p_improvement_id;
  if imp.id is null then raise exception 'improvement not found'; end if;

  -- A review may be OPENED from a passing replay, or RE-ISSUED when the row
  -- says review_pending but its task is gone (deleted task + ON DELETE SET
  -- NULL leaves an invisible review that still holds a backpressure slot).
  if imp.status = 'review_pending' then
    select id into v_live_task from human_tasks where id = imp.human_task_id;
    if v_live_task is not null then
      raise exception 'review already open with a live task (%)', v_live_task;
    end if;
  elsif imp.status <> 'replayed' then
    raise exception 'improvement must have a PASSING replay before review (status is %)', imp.status;
  end if;

  select coalesce(persona_name, name, 'DE') into v_name from digital_employees where id = imp.de_id;
  insert into human_tasks (tenant_id, type, source, title, detail, related_table, related_id)
  values (imp.tenant_id, 'knowledge_revision', 'system',
    format('Approve knowledge fix proposed by %s — "%s"', v_name, left(imp.proposed_title, 80)),
    format(E'%s answered a question wrongly and proposes this knowledge fix.\n\nFailing question: %s\n\nWhy it failed: %s\n\nProposed article "%s":\n%s\n\nReplay proof: re-answering WITH this fix scored %s/100 (was %s/100); golden set %s/%s passed. Approving publishes the article scoped to this employee; rejecting discards it.',
      v_name, left(imp.failure_question, 300), left(imp.failure_rationale, 400),
      imp.proposed_title, left(imp.proposed_content, 1500),
      coalesce(imp.replay->'after'->>'score','?'), coalesce(imp.replay->'before'->>'score','?'),
      coalesce(imp.replay->'golden'->>'passed','?'), coalesce(imp.replay->'golden'->>'total','?')),
    'de_improvements', imp.id)
  returning id into v_task;

  update de_improvements set human_task_id = v_task, status = 'review_pending', updated_at = now()
   where id = p_improvement_id;
  return v_task;
end;
$function$;

-- Migs 610+630 rule (re-assert on replace): strip both default-grant
-- mechanisms; the callers are de-improve (service_role) and repair blocks.
revoke all on function public.create_improvement_review(uuid) from public, anon, authenticated;
grant execute on function public.create_improvement_review(uuid) to service_role;

-- ── Repair: re-issue every orphaned review, all tenants ──
do $$
declare
  v_expected int;
  v_row record;
  v_reissued int := 0;
begin
  select count(*) into v_expected
  from de_improvements i
  where i.status = 'review_pending'
    and not exists (select 1 from human_tasks t where t.id = i.human_task_id);

  for v_row in
    select i.id from de_improvements i
    where i.status = 'review_pending'
      and not exists (select 1 from human_tasks t where t.id = i.human_task_id)
  loop
    perform public.create_improvement_review(v_row.id);
    v_reissued := v_reissued + 1;
  end loop;

  if v_reissued <> v_expected then
    raise exception 'repair incomplete: expected % re-issues, made %', v_expected, v_reissued;
  end if;
  raise notice 're-issued % lost review task(s)', v_reissued;
end $$;

-- ── Verify: no review_pending row may lack a live task anywhere ──
do $$
declare v_orphans int; v_reviews int;
begin
  select count(*) into v_reviews from de_improvements where status = 'review_pending';
  select count(*) into v_orphans
  from de_improvements i
  where i.status = 'review_pending'
    and not exists (select 1 from human_tasks t where t.id = i.human_task_id);
  if v_reviews = 0 then
    raise exception 'verify is vacuous: zero review_pending rows — expected at least the repaired ones';
  end if;
  if v_orphans > 0 then
    raise exception '% review(s) still have no live task', v_orphans;
  end if;
  raise notice 'all % pending review(s) carry a live task', v_reviews;
end $$;

commit;
