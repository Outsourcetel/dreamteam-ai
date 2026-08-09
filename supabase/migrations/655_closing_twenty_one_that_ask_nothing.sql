-- 655_closing_twenty_one_that_ask_nothing.sql
-- ============================================================================
-- 21 of the 64 pending tasks in outsourcetel-hq contain no question. Closing
-- them is housekeeping, not a judgement about anyone's work — which is why it is
-- done here, in a migration, with the sanctioned guard flag and a reason
-- recorded on every row, rather than through a path that would let software
-- answer questions on a person's behalf.
--
-- ⚠ WHAT THIS DOES NOT TOUCH. The 18 LIVE "Goal blocked" tasks, the 8 contact
-- escalations, the 4 collections approvals, the knowledge revision, and the
-- Grant Plastics requirements question all stay exactly as they are. Every one
-- of those is a real question waiting on a person.
--
-- ── (A) 20 SUPERSEDED COPIES ──────────────────────────────────────────────
-- The runtime raises "Goal blocked" per objective and, since 5c771fd, REFRESHES
-- an existing open one instead of inserting a second. These 20 are the copies
-- that predate that fix: frozen snapshots the refresh path has abandoned. Each
-- objective keeps its most recently refreshed copy, which carries today's
-- description; the older ones say the same thing in staler words.
--
-- The partition is not a guess. Ordered by updated_at per objective, the newest
-- SUPERSEDED copy is 2026-08-08 13:00 and the oldest KEPT copy is 2026-08-09
-- 10:00 — a clean temporal split with no overlap, which is exactly what you
-- would expect if the refresh path took over on the 9th and never touched the
-- rest again. The set is RE-DERIVED here, not hardcoded.
--
-- ── (B) 1 FINISHED JOB FILED AS A QUESTION ────────────────────────────────
-- Task de82a56c holds raw tool-call syntax, not a question: the model wrote its
-- mark_done as prose and the runtime filed it to a human (fixed forward in
-- de-work; this is the one instance that already happened). Its work item is
-- STILL parked at waiting_human, which is what pinned its objective blocked.
--
-- So this closes the task AND completes the work item with the summary the
-- employee actually produced. Closing the ticket while leaving the step stuck
-- would fix the symptom and keep the cause: one waiting step pins a goal, and
-- reconcile_blocked_goals abstains on it forever.
--
-- 'expired' is used rather than 'rejected' deliberately. Nobody rejected this
-- work. The status column IS the decision, and writing a rejection that never
-- happened is the falsification this project refuses to commit.
-- ============================================================================

begin;

do $$
declare
  v_superseded uuid[];
  v_malformed  uuid := 'de82a56c-db14-4c63-accd-0f979d31f587';
  v_item       uuid := 'b7ea510e-a372-4702-895c-85ce84817a08';
  v_summary    text;
  v_before     int;
  v_after      int;
  v_n          int;
  v_live_before int;
begin
  perform set_config('app.allow_task_decision', 'on', true);  -- mig 486 sanctioned path

  select count(*) into v_before from human_tasks h join tenants t on t.id = h.tenant_id
   where t.slug = 'outsourcetel-hq' and h.status = 'pending';

  -- Guard: the live set must be untouched at the end.
  select count(*) into v_live_before from human_tasks h join tenants t on t.id = h.tenant_id
   where t.slug = 'outsourcetel-hq' and h.status = 'pending'
     and not (h.type = 'escalation' and h.title like 'Goal blocked%')
     and h.id <> v_malformed;

  -- ── (A) Re-derive the superseded copies. ────────────────────────────────
  with gb as (
    select h.id,
           row_number() over (partition by h.related_id
                              order by h.updated_at desc, h.created_at desc) as rn
      from human_tasks h join tenants t on t.id = h.tenant_id
     where t.slug = 'outsourcetel-hq' and h.status = 'pending'
       and h.type = 'escalation' and h.title like 'Goal blocked%'
  )
  select array_agg(id) into v_superseded from gb where rn > 1;

  v_n := coalesce(array_length(v_superseded, 1), 0);
  if v_n = 0 then
    raise notice '655: no superseded copies here — nothing to close (expected on dev/replay)';
    return;
  end if;
  if v_n <> 20 then
    raise exception '655: expected 20 superseded copies, found %. The population moved — re-derive before running.', v_n;
  end if;

  update human_tasks
     set status = 'expired',
         disposition = 'cancelled',
         decision_note = 'Closed by migration 655: a superseded copy of a still-open blocker. '
           || 'The runtime now refreshes one task per objective (5c771fd); this copy predates that '
           || 'and was frozen. The current description of this blocker is on the task that remains open. '
           || 'Nothing was decided about the underlying work.',
         updated_at = now()
   where id = any(v_superseded) and status = 'pending';
  get diagnostics v_n = row_count;
  if v_n <> 20 then raise exception '655: expected to close 20, closed %', v_n; end if;

  -- ── (B) The finished job. Recover its summary from the stored question. ──
  select substring(w.result->>'question' from '<parameter name="summary">([\s\S]*?)</parameter>')
    into v_summary
    from de_work_items w where w.id = v_item;

  if coalesce(btrim(v_summary), '') = '' then
    raise exception '655: could not recover the summary from the malformed task — refusing to close work whose result I cannot read';
  end if;

  update de_work_items
     set status = 'done',
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'summary', btrim(v_summary),
           'recovered_by', 'migration 655',
           'recovery_note', 'The employee wrote its mark_done as prose instead of a tool call, so the '
             || 'runtime filed a finished job as a question and left this step parked, which pinned the '
             || 'objective blocked. The work was done; this is its real summary. de-work now recognises '
             || 'this shape.'),
         updated_at = now()
   where id = v_item and status = 'waiting_human';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '655: the malformed work item was not in the expected waiting_human state (updated %)', v_n; end if;

  update human_tasks
     set status = 'expired', disposition = 'cancelled',
         decision_note = 'Closed by migration 655: this contains a completed result, not a question. '
           || 'The employee wrote its mark_done as prose and the runtime filed it to a person. '
           || 'The work item has been completed with the summary it produced.',
         updated_at = now()
   where id = v_malformed and status = 'pending';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '655: the malformed task was not pending (updated %)', v_n; end if;

  -- ── Prove exactly 21 closed, and that nothing live was touched. ─────────
  select count(*) into v_after from human_tasks h join tenants t on t.id = h.tenant_id
   where t.slug = 'outsourcetel-hq' and h.status = 'pending';
  if v_after <> v_before - 21 then
    raise exception '655: pending went % -> %, expected a drop of exactly 21', v_before, v_after;
  end if;

  select count(*) into v_n from human_tasks h join tenants t on t.id = h.tenant_id
   where t.slug = 'outsourcetel-hq' and h.status = 'pending'
     and not (h.type = 'escalation' and h.title like 'Goal blocked%')
     and h.id <> v_malformed;
  if v_n <> v_live_before then
    raise exception '655: the untouched set changed from % to % — a real question was closed', v_live_before, v_n;
  end if;

  -- One live copy must survive per objective. Closing a blocker nobody has
  -- resolved would hide it, which is worse than duplicating it.
  select count(*) into v_n from (
    select h.related_id from human_tasks h join tenants t on t.id = h.tenant_id
     where t.slug = 'outsourcetel-hq' and h.status = 'pending'
       and h.type = 'escalation' and h.title like 'Goal blocked%'
     group by h.related_id having count(*) <> 1) x;
  if v_n > 0 then
    raise exception '655: % objective(s) do not have exactly one open blocker left', v_n;
  end if;

  raise notice '655: closed 21 (20 superseded + 1 finished-job-as-question); pending % -> %; live questions untouched at %',
    v_before, v_after, v_live_before;
end $$;

commit;
