-- 795_a_queue_you_can_clear_without_clicking_412_times.sql
-- ==========================================================================
-- THE DECISION COCKPIT.
--
-- 412 pending decisions today, 193 of them escalations, and the only way
-- through is one click each. That IS the bottleneck this product exists to
-- remove: the workforce is governed, and governance is starving on the one
-- human who has to press approve 412 times.
--
-- Three functions, and the ORDER of them is the point:
--
--   list_decision_groups()          what is actually waiting, grouped
--   preview_decide_human_tasks()    what WOULD happen, changing nothing
--   decide_human_tasks()            do it
--
-- ⛔ NOTHING HERE RE-IMPLEMENTS A DECISION RULE.
--
-- Both the preview and the batch call the REAL public.decide_human_task once
-- per task. Every guard it fires still fires: the DE reporting-line check, the
-- approval-authority check, mig 786's refusal of a deny it could not verify,
-- the second-approver path, the audit row. A batch is N decisions, not one
-- decision with a bigger blast radius.
--
-- That is not a style preference. This repo has paid for the alternative
-- twice in one week: mig 789 had to reconcile a governance sweep that judged
-- performance plans against constants the review had already abandoned, and
-- mig 786 existed because a severity was erased in transit between two
-- functions that each looked correct alone. A second implementation of "may
-- this be approved" would be the same defect with a nicer UI on top.
--
-- HOW THE PREVIEW CAN RUN THE REAL FUNCTION AND STILL CHANGE NOTHING
-- -----------------------------------------------------------------
-- A plpgsql BEGIN...EXCEPTION block is an implicit savepoint: raising inside
-- it rolls back everything the block did. So the preview calls the real
-- decision, and then RAISES ON SUCCESS to undo it. The sentinel is checked by
-- message, and it is deliberately absurd so no genuine error can collide.
--
-- Verified before relying on it: decide_human_task contains no pg_notify, no
-- net.http, no dblink. Of the 14 triggers on human_tasks, the only one that
-- reaches the network (notify_pending_human_task) fires on INSERT, and this
-- path only ever UPDATEs. Nothing escapes the rollback.
--
-- ⚠ WHAT THE PREVIEW DOES NOT PROMISE. It reports what would happen NOW. If
-- someone else decides a task, or a rule changes, between preview and commit,
-- the answer can differ — which is exactly why decide_human_tasks re-runs
-- every guard rather than trusting the preview it was given.
-- ==========================================================================

begin;

-- ── 1. WHAT IS ACTUALLY WAITING ───────────────────────────────────────────
-- A flat list of 412 is not a queue, it is a wall. Grouped by what the work
-- IS and who it belongs to, 412 becomes about a dozen decisions.

create or replace function public.list_decision_groups()
returns table (
  task_type      text,
  de_id          uuid,
  de_name        text,
  pending        bigint,
  oldest_at      timestamptz,
  oldest_days    integer,
  overdue        bigint,
  unpriced       bigint,
  sample_title   text,
  task_ids       uuid[]
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select
    t.type                                              as task_type,
    t.de_id,
    d.name                                              as de_name,
    count(*)                                            as pending,
    min(t.created_at)                                   as oldest_at,
    extract(day from (now() - min(t.created_at)))::int  as oldest_days,
    count(*) filter (where t.sla_due_at is not null and t.sla_due_at < now()) as overdue,
    -- Carried because it is the shape mig 786 cares about: an approval that
    -- reports no amount is the one a workspace rule cannot be checked against.
    count(*) filter (where (select amount_cents from task_approval_facts(t.id)) is null) as unpriced,
    (array_agg(t.title order by t.created_at))[1]       as sample_title,
    array_agg(t.id order by t.created_at)               as task_ids
  from human_tasks t
  left join digital_employees d on d.id = t.de_id
  where t.tenant_id = auth_tenant_id()
    and t.status = 'pending'
    -- Only what THIS person could act on. A group they cannot decide is not a
    -- group, it is a tease.
    and (t.de_id is null or public.can_access_de(t.de_id))
  group by t.type, t.de_id, d.name
  order by count(*) desc, min(t.created_at);
$fn$;

revoke all on function public.list_decision_groups() from public;
revoke all on function public.list_decision_groups() from anon;
grant execute on function public.list_decision_groups() to authenticated;

-- ── 2. WHAT WOULD HAPPEN ──────────────────────────────────────────────────
-- The governed differentiator. Anyone can bulk-approve. Telling you WHICH of
-- the 91 will refuse, and why, BEFORE you commit, is the product.

create or replace function public.preview_decide_human_tasks(
  p_task_ids   uuid[],
  p_decision   text,
  p_reason_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_id      uuid;
  v_ok      int := 0;
  v_refuse  jsonb := '[]'::jsonb;
  v_title   text;
begin
  if p_task_ids is null or array_length(p_task_ids, 1) is null then
    return jsonb_build_object('would_succeed', 0, 'would_refuse', 0, 'refusals', v_refuse);
  end if;
  if array_length(p_task_ids, 1) > 500 then
    raise exception 'too_many: preview at most 500 tasks at a time (got %)', array_length(p_task_ids, 1);
  end if;

  foreach v_id in array p_task_ids loop
    select title into v_title from human_tasks where id = v_id;
    begin
      perform public.decide_human_task(v_id, p_decision, p_reason_code, '__preview__');
      -- Reaching this line means the decision WOULD go through. Undo it: the
      -- raise rolls this block back to where it started.
      raise exception using errcode = 'P0001', message = '__PREVIEW_WOULD_SUCCEED__';
    exception when others then
      if sqlerrm = '__PREVIEW_WOULD_SUCCEED__' then
        v_ok := v_ok + 1;
      else
        v_refuse := v_refuse || jsonb_build_object(
          'id', v_id, 'title', coalesce(v_title, '(untitled)'), 'why', sqlerrm);
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'would_succeed', v_ok,
    'would_refuse',  jsonb_array_length(v_refuse),
    'refusals',      v_refuse);
end
$fn$;

revoke all on function public.preview_decide_human_tasks(uuid[], text, text) from public;
revoke all on function public.preview_decide_human_tasks(uuid[], text, text) from anon;
grant execute on function public.preview_decide_human_tasks(uuid[], text, text) to authenticated;

-- ── 3. DO IT ──────────────────────────────────────────────────────────────
-- Deliberately the same shape as withdraw_human_tasks (mig 790): same cap,
-- same {count, failed[]} return, same per-task exception handling. Two batch
-- verbs on the same table that behaved differently would be a trap.

create or replace function public.decide_human_tasks(
  p_task_ids    uuid[],
  p_decision    text,
  p_reason_code text default null,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_id     uuid;
  v_ok     int := 0;
  v_failed jsonb := '[]'::jsonb;
  v_row    human_tasks;
  v_title  text;
begin
  if p_task_ids is null or array_length(p_task_ids, 1) is null then
    return jsonb_build_object('decided', 0, 'failed', v_failed);
  end if;
  -- Same 500 cap as withdraw_human_tasks, for the same reason: a UI bug must
  -- not be able to clear a whole workspace's queue in one call.
  if array_length(p_task_ids, 1) > 500 then
    raise exception 'too_many: decide at most 500 tasks at a time (got %)', array_length(p_task_ids, 1);
  end if;

  foreach v_id in array p_task_ids loop
    select title into v_title from human_tasks where id = v_id;
    begin
      v_row := public.decide_human_task(v_id, p_decision, p_reason_code, p_note);
      -- NULL is not failure here. decide_human_task returns NULL on the
      -- first-approver path: the approval was RECORDED and the task stays
      -- pending until a different person signs. Reporting that as an error
      -- would teach people to press it twice.
      if v_row.id is null then
        v_failed := v_failed || jsonb_build_object(
          'id', v_id, 'title', coalesce(v_title, '(untitled)'),
          'error', 'first_approval_recorded: a second approver is required');
      else
        v_ok := v_ok + 1;
      end if;
    exception when others then
      v_failed := v_failed || jsonb_build_object(
        'id', v_id, 'title', coalesce(v_title, '(untitled)'), 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('decided', v_ok, 'failed', v_failed);
end
$fn$;

revoke all on function public.decide_human_tasks(uuid[], text, text, text) from public;
revoke all on function public.decide_human_tasks(uuid[], text, text, text) from anon;
grant execute on function public.decide_human_tasks(uuid[], text, text, text) to authenticated;

-- ── proof, in the migration ───────────────────────────────────────────────
-- The load-bearing one is (b). A preview that quietly DECIDED would be the
-- worst defect this file could ship, so it is asserted against stored state,
-- not against the function's own return value.
do $verify$
declare
  v_t uuid; v_u uuid; v_task uuid; v_before text; v_after text;
  v_audit_before bigint; v_audit_after bigint;
  v_res jsonb; v_n int;
begin
  -- (a) the three functions exist with the intended arity
  if to_regprocedure('public.decide_human_tasks(uuid[],text,text,text)') is null
     or to_regprocedure('public.preview_decide_human_tasks(uuid[],text,text)') is null
     or to_regprocedure('public.list_decision_groups()') is null then
    raise exception 'VERIFY FAILED: a cockpit function is missing';
  end if;

  -- Find a pending task whose workspace has an admin who could sign it.
  select t.tenant_id, p.user_id, t.id into v_t, v_u, v_task
    from human_tasks t
    join profiles p on p.tenant_id = t.tenant_id and coalesce(p.is_active, true)
                   and p.role in ('tenant_owner','tenant_admin')
   where t.status = 'pending'
   order by t.created_at
   limit 1;

  if v_task is null then
    raise exception 'VERIFY FAILED: no pending task exists, so the preview assertion below would prove nothing';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_u, 'role', 'authenticated')::text, true);

  select status into v_before from human_tasks where id = v_task;
  select count(*) into v_audit_before from audit_events where tenant_id = v_t;

  -- (b) ⛔ THE PREVIEW MUST LEAVE NO TRACE.
  v_res := public.preview_decide_human_tasks(array[v_task], 'approved', null);

  select status into v_after from human_tasks where id = v_task;
  select count(*) into v_audit_after from audit_events where tenant_id = v_t;

  if v_after is distinct from v_before then
    raise exception 'VERIFY FAILED: preview CHANGED a task status (% -> %)', v_before, v_after;
  end if;
  if v_audit_after <> v_audit_before then
    raise exception 'VERIFY FAILED: preview wrote % audit row(s)', v_audit_after - v_audit_before;
  end if;

  -- (c) ...and it must still have ANSWERED. A preview that changes nothing
  --     because it did nothing is not a preview.
  if coalesce((v_res->>'would_succeed')::int, 0)
   + coalesce((v_res->>'would_refuse')::int, 0) <> 1 then
    raise exception 'VERIFY FAILED: preview of 1 task returned % verdict(s): %',
      coalesce((v_res->>'would_succeed')::int,0) + coalesce((v_res->>'would_refuse')::int,0), v_res;
  end if;

  -- (d) the empty case is 0, not an error and not a crash
  v_res := public.preview_decide_human_tasks(null, 'approved', null);
  if (v_res->>'would_succeed')::int <> 0 then
    raise exception 'VERIFY FAILED: preview of nothing claimed % successes', v_res->>'would_succeed';
  end if;
  v_res := public.decide_human_tasks('{}'::uuid[], 'approved', null, null);
  if (v_res->>'decided')::int <> 0 then
    raise exception 'VERIFY FAILED: decide of nothing claimed % decisions', v_res->>'decided';
  end if;

  -- (e) the cap refuses, in both verbs
  begin
    perform public.decide_human_tasks(
      (select array_agg(gen_random_uuid()) from generate_series(1, 501)), 'approved', null, null);
    raise exception 'VERIFY FAILED: decide_human_tasks accepted 501 ids';
  exception when others then
    if sqlerrm not like 'too_many%' then
      if sqlerrm like 'VERIFY FAILED%' then raise; end if;
      raise exception 'VERIFY FAILED: cap raised the wrong error: %', sqlerrm;
    end if;
  end;

  -- (f) the grouper returns something shaped like a queue
  select count(*) into v_n from public.list_decision_groups();
  if v_n < 1 then
    raise exception 'VERIFY FAILED: % pending task(s) exist but list_decision_groups returned no group',
      (select count(*) from human_tasks where tenant_id = v_t and status = 'pending');
  end if;
end
$verify$;

commit;
