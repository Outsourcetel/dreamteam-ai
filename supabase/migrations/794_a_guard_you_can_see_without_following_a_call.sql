-- 794_a_guard_you_can_see_without_following_a_call.sql
-- ============================================================================
-- Fixes a regression this session introduced. Migration 790 added
-- withdraw_human_task, and certify's knowledge-acl-invariants suite failed:
--
--   "a new SECURITY DEFINER function writes without checking the caller tenant
--    and is callable by any signed-up user"
--
-- One function flagged, and it is mine.
--
-- ── Is the test wrong? No. ──────────────────────────────────────────────────
-- The function IS safe. Its first statement calls decide_human_task, which
-- raises 'not_authenticated' when auth_tenant_id() is null, re-checks the DE
-- reporting line, and is the sanctioned path the table's own trigger demands.
-- 790 delegated on purpose, precisely so none of that had to be reimplemented.
--
-- But the safety is INHERITED THROUGH A CALL, and nothing at this function's
-- own site says so. The invariant scans a function's text for evidence that it
-- checks its caller; delegation is invisible to that scan — and it is equally
-- invisible to a person reading only this function. The test is not
-- approximating the property badly. It is reporting, correctly, that you
-- cannot tell from here.
--
-- Two ways to answer it, and only one is honest:
--
--   * Add withdraw_human_task to public.unguarded_secdef_writers. That table
--     is the tracked-debt allowlist, and this is not debt — the function is
--     guarded. Filing it there would make the ratchet count a lie, and the
--     next real unguarded writer would land next to it looking equally fine.
--
--   * State the precondition where the function states everything else. ✓
--
-- ── Why the explicit check is real, not linter-appeasement ─────────────────
-- It fails FASTER and more clearly: the caller gets 'not_authenticated' from
-- the function they actually called, not from one two frames down.
--
-- And it is load-bearing against a future edit. The delegation is the only
-- thing standing between this function and an unauthenticated write; if
-- someone later swaps decide_human_task for a different helper, or inlines the
-- status update to avoid a round trip, the guard silently leaves with it. This
-- check does not depend on what the body delegates to.
--
-- Behaviour is unchanged for every caller who was already allowed: they had a
-- tenant, so the new branch is not taken. What changes is that an
-- unauthenticated caller is refused HERE, and that a reader can see it.
-- ============================================================================

create or replace function public.withdraw_human_task(p_task_id uuid, p_note text default null)
returns human_tasks
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_row human_tasks;
begin
  -- Stated here rather than inherited from decide_human_task below. See the
  -- header: the delegation genuinely guards this, but nothing at this site
  -- said so — not to certify's invariant scan, and not to a person reading
  -- only this function.
  if public.auth_tenant_id() is null then
    raise exception 'not_authenticated';
  end if;

  -- Every remaining guard, the audit event and the fourteen trg_sync_*
  -- triggers still come from here. The reason code is required for any
  -- rejection, and 'withdrawn' is what makes these findable later as a class.
  v_row := public.decide_human_task(p_task_id, 'rejected', 'withdrawn', p_note);

  -- decide_human_task returns a NULL composite when the task was already
  -- decided. Say so rather than stamping a disposition onto someone else's
  -- decision.
  if v_row.id is null then
    return null;
  end if;

  -- Passes guard_human_task_decision: it raises only when status, decided_by
  -- or decided_at change, and none of them move here.
  update human_tasks set disposition = 'cancelled' where id = p_task_id;

  select * into v_row from human_tasks where id = p_task_id;
  return v_row;
end;
$fn$;

comment on function public.withdraw_human_task(uuid, text) is
  'Remove a task from the queue without acting on it. Delegates to '
  'decide_human_task(rejected, withdrawn) so every guard, audit event and sync '
  'trigger applies, then marks disposition=cancelled so it is excluded from '
  'the approval-rate denominator. The row is kept: mig 486''s guard refuses to '
  'let an undecided approval be deleted, and this is the decision it asks for. '
  'Checks auth_tenant_id() itself (mig 794) rather than relying on the '
  'delegate, so the guard survives a change to what this body calls.';

revoke all on function public.withdraw_human_task(uuid, text) from public, anon, authenticated;
grant execute on function public.withdraw_human_task(uuid, text) to authenticated;

-- ── Prove it, including that the invariant now agrees ───────────────────────
do $$
declare
  v_def text;
  v_flagged int;
begin
  select pg_get_functiondef(oid) into v_def
    from pg_proc where oid = 'public.withdraw_human_task(uuid, text)'::regprocedure;

  -- A. The delegation must survive. If a future edit inlines the write, the
  --    argument in 790's header stops holding and this assertion says so.
  if v_def !~* 'decide_human_task' then
    raise exception '794: withdraw_human_task no longer delegates to decide_human_task';
  end if;

  -- B. The local guard must be present.
  if v_def !~* 'auth_tenant_id' then
    raise exception '794: the explicit caller check is gone — this migration exists to put it there';
  end if;

  -- C. THE ACTUAL TEST, run here rather than trusted to pass later. This is
  --    knowledge-acl-invariants' own predicate, verbatim: no SECURITY DEFINER
  --    writer reachable by `authenticated` may lack a caller check unless it
  --    is on the tracked-debt list.
  with w as (
    select p.proname, p.prorettype::regtype::text as rettype,
           regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g') as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  select count(*) into v_flagged from w
   where def ~* '(insert into|update [a-z_"]+ set|delete from|truncate )'
     and def !~* 'auth_tenant_id|auth_has_tenant_role|can_admin_tenant_internal|is_platform_admin|resolve_platform_capability|_assert_|current_tenant|auth\.uid\(\)'
     and rettype <> 'trigger'
     and proname not in (select function_name from public.unguarded_secdef_writers);

  if v_flagged <> 0 then
    raise exception '794: % unguarded SECURITY DEFINER writer(s) still reachable by authenticated', v_flagged;
  end if;
end $$;
