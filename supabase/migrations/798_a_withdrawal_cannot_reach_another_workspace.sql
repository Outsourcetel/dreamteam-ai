-- 798_a_withdrawal_cannot_reach_another_workspace.sql
-- ==========================================================================
-- ⚠ THIS BODY WAS WRITTEN AS 792 AND MOVED HERE DELIBERATELY. The number is
-- part of the fix, not bookkeeping.
--
-- 792 was claimed at 22:43. A parallel session claimed 794 at 23:01 and
-- APPLIED it at 23:03, and 794 CREATE OR REPLACEs the same function this
-- file replaces. Migrations replay in FILENAME ORDER, so on any rebuild 794
-- would run after 792 and silently drop the tenant predicate below —
-- production would carry it and a rebuilt environment would not. That is the
-- worst available outcome: a security property that exists only where nobody
-- looks. Renumbering an APPLIED migration is forbidden (schema_migrations
-- keys on filename), so the only correct home for this body is a number
-- ABOVE 794. 792 was released back with `migrate:next -- --release 792`.
--
-- The build agent stopped and asked rather than applying at 792. That was
-- right, and it is why this note exists instead of a silent regression.
-- ==========================================================================
-- WHY: tests/knowledge-acl-invariants.test.ts > "no NEW unguarded SECURITY
-- DEFINER writer becomes reachable" went RED on migration 790:
--
--     expected [ "withdraw_human_task" ] to deeply equal []
--
-- 790's last write is, verbatim:
--
--     update human_tasks set disposition = 'cancelled' where id = p_task_id;
--
-- No tenant predicate, on a SECURITY DEFINER function that `authenticated`
-- holds EXECUTE on. That is the shape migration 749 spent a day closing across
-- 29 functions, and the shape this test exists to catch.
--
-- == IS IT EXPLOITABLE? NO. DRIVEN, NOT ARGUED. ===========================
-- withdraw_human_task's first act is
-- `decide_human_task(p_task_id, 'rejected', 'withdrawn', p_note)`.
-- decide_human_task declares `v_tenant uuid := auth_tenant_id()`, refuses a
-- null tenant with `not_authenticated`, and looks the task up with
-- `where id = p_task_id and tenant_id = v_tenant`, raising `task_not_found`
-- when that misses. A foreign id dies there and never reaches the update.
--
-- Section 3 proves that by DOING it: two workspaces, five task fixtures
-- created here, a member of A calling withdraw on B's task -- singular, and
-- again inside a mixed plural array -- with B's row read back afterwards.
-- Probe 1 raises `task_not_found`; B's row does not move. Probe 4 does the
-- same with no tenant at all. This is hardening, not an incident.
--
-- == WHAT 794 CHANGED, AND WHY IT IS NOT ENOUGH ===========================
-- Migration 794 (parallel session, applied after the handoff that started
-- this file was written) added an explicit bar to the same function:
--
--     if public.auth_tenant_id() is null then raise exception ...
--
-- That is a real improvement and it is kept below. But it is an IDENTITY bar,
-- not a TENANCY one: it stops a caller with no workspace, and does nothing
-- about an authenticated caller from a DIFFERENT workspace. The write is
-- still `where id = p_task_id`.
--
-- !! And it made the detector blind. The invariant is a TEXT test: a body is
-- "guarded" if it mentions auth_tenant_id (or one of seven siblings). 794 put
-- that string in the body, so the suite is green -- while the statement it
-- was watching is unchanged. Pin S8-inverted (b) demonstrates this inside
-- this migration: the detector is run against a copy of the body with the
-- tenant predicate deleted but 794's token kept, and it reports nothing. Not
-- an allow-list entry, but the same effect on what the checker can see.
--
-- The fix is for the write to carry its own predicate, so the property the
-- test asserts is TRUE rather than merely spelled. Delegation AND predicate,
-- never either -- probe 5 shows why: with the delegation removed, 790/794's
-- statement stamps disposition onto another workspace's row, and the same
-- statement carrying `and tenant_id = v_tenant` touches nothing.
--
-- == !! AND THE FUNCTION HAS NEVER WORKED AT ALL !! =======================
-- Found by probe 7, which is the first thing in three migrations to CALL it:
--
--     withdraw_human_task(own task, own workspace)
--       -> 23514 new row for relation "human_tasks" violates check
--          constraint "human_tasks_decision_reason_code_check"
--
-- 790 passes reason code 'withdrawn'. The constraint admits exactly
-- {wrong_facts, wrong_tone, missing_context, incomplete, not_permitted,
--  customer_specific, other}. 'withdrawn' is not among them, so every call
-- raises. Measured: 0 of 476 human_tasks rows carry any non-null
-- decision_reason_code, and all 31 disposition='cancelled' rows come from the
-- expiry and stranding sweeps, which set it directly. Not one task has ever
-- been withdrawn.
--
-- 790's and 794's verification blocks both passed because every assertion in
-- them reads pg_get_functiondef and matches text. Neither ever called the
-- function. This migration does not fix it: choosing between widening a
-- closed, learning-bearing reason vocabulary and reusing 'other' is a product
-- decision, and 798 is about tenant isolation. Probe 7 CLASSIFIES the failure
-- instead -- it stays loud, it fails on any OTHER error, and it becomes a
-- hard assertion the moment 'withdrawn' is made legal.
--
-- !! get diagnostics / row_count is not decoration. A tenant predicate turns
-- a refusal into a SILENT ZERO-ROW SUCCESS, this repo's most expensive
-- recurring trap. The decision is already recorded by the time this statement
-- runs, so a withdrawal whose mark reached no row must abort the whole call.
-- ==========================================================================

begin;

-- == Capture the PRE-798 definition, for the inversion arms in section 3 ===
do $capture$
declare
  v_def text := '';
begin
  if to_regprocedure('public.withdraw_human_task(uuid, text)') is not null then
    select pg_get_functiondef(oid) into v_def
      from pg_proc where oid = 'public.withdraw_human_task(uuid, text)'::regprocedure;
  end if;
  perform set_config('app.probe_798_def_before', coalesce(v_def, ''), true);
end $capture$;

-- ==========================================================================
-- SECTION 1 -- the write guards itself
-- ==========================================================================
create or replace function public.withdraw_human_task(p_task_id uuid, p_note text default null)
returns human_tasks
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_row    human_tasks;
  -- Captured once. Never gated on an identity test: the `auth.uid() is not
  -- null and` prefix SKIPS a check for a caller with no identity instead of
  -- failing it. 29 of those were closed in mig 749 and
  -- scripts/secdef-authority-prefix.mjs ratchets against a 30th.
  -- auth_tenant_id() is NULL for service_role and for anon, and NULL is
  -- refused outright on the next line.
  v_tenant uuid := auth_tenant_id();
  v_n      integer;
begin
  -- Mig 794's bar, kept. decide_human_task raises the same thing, so no
  -- caller sees a new failure mode; it is restated here so this function's
  -- refusal does not depend on what it happens to delegate to.
  if v_tenant is null then
    raise exception 'not_authenticated';
  end if;

  -- Every remaining guard, the audit event and the fourteen trg_sync_*
  -- triggers still come from here.
  v_row := public.decide_human_task(p_task_id, 'rejected', 'withdrawn', p_note);

  -- NULL composite = already decided. Say so rather than stamping a
  -- disposition onto someone else's decision.
  if v_row.id is null then
    return null;
  end if;

  -- THE CHANGE. Passes guard_human_task_decision: that trigger raises only
  -- when status, decided_by or decided_at change, and none of them move here.
  update human_tasks
     set disposition = 'cancelled'
   where id = p_task_id
     and tenant_id = v_tenant;

  -- A predicate that can miss must be able to SAY it missed. Without this,
  -- adding the tenant clause above would convert a future refusal into a
  -- quiet success returning a task marked decided but not withdrawn.
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'withdraw_incomplete: task % was decided but the withdrawal mark reached % row(s); refusing to report a partial write as success', p_task_id, v_n;
  end if;

  select * into v_row from human_tasks where id = p_task_id and tenant_id = v_tenant;
  return v_row;
end;
$fn$;

comment on function public.withdraw_human_task(uuid, text) is
  'Remove a task from the queue without acting on it. Delegates to '
  'decide_human_task(rejected, withdrawn) so every guard, audit event and sync '
  'trigger applies, then marks disposition=cancelled so it is excluded from '
  'the approval-rate denominator. Mig 794 checks auth_tenant_id() at this '
  'site; mig 798 puts the same tenant on the disposition write itself, so the '
  'isolation of this function is not a property of decide_human_task''s where '
  'clause. The row is kept: mig 486''s guard refuses to let an undecided '
  'approval be deleted, and this is the decision it asks for.';

-- == The plural is NOT given a predicate, and section 3 proves why =========
-- It writes nothing. It loops the singular inside per-task subtransactions so
-- one refusal does not roll back the rest, and reports {withdrawn, failed[]}.
-- A second copy of the predicate would be a second thing to keep in step with
-- no statement to protect. Probe 3 drives a MIXED array to show a foreign id
-- comes back in `failed` with its reason rather than being silently dropped,
-- and pin S6 holds the body to writing nothing.

-- == Grants, re-stated after CREATE OR REPLACE ============================
revoke all on function public.withdraw_human_task(uuid, text) from public, anon, authenticated;
grant execute on function public.withdraw_human_task(uuid, text) to authenticated;

-- ==========================================================================
-- SECTION 3 -- VERIFICATION
--
-- Every probe drives the real function against fixtures created here, inside
-- a subtransaction that ALWAYS rolls back. Nothing below reads or writes a
-- live pending task, and no cross-tenant breach is performed to prove one is
-- possible: probe 5 proves the REFUSAL, against scratch functions built and
-- destroyed inside the same subtransaction.
--
-- !! `v_bad := v_bad || 'literal'` is BANNED (22P02 the moment a branch
-- fires; mig 685/741, scripts/migration-append-check.mjs). array_append only.
--
-- !! Every static match below runs on COMMENT-STRIPPED source. The first
-- version of pin S4 fired on this function's own warning comment about the
-- banned prefix. A ratchet that reads prose is a ratchet that reads itself.
-- ==========================================================================
do $verify$
declare
  v_bad       text[] := array[]::text[];
  v_checks    integer := 0;
  v_probes    integer := 0;   -- completed
  v_attempted integer := 0;   -- started
  v_caller    text;
  v_seen      text;
  v_d         boolean;

  -- fixtures: two workspaces, three tasks in A, two in B, all created here
  v_ta uuid; v_ua uuid; v_sa text;
  v_tb uuid; v_ub uuid; v_sb text;
  v_a1 uuid; v_a2 uuid; v_a3 uuid;
  v_b1 uuid; v_b2 uuid;

  -- probe scratch
  v_ref   boolean; v_msg text; v_state text;
  v_uid   uuid;    v_tid uuid;
  v_row   human_tasks;
  v_json  jsonb;
  v_int   integer;
  v_txt   text;

  -- classification of the live reason-code defect
  v_wd_legal   boolean;
  v_wd_outcome text := '(not run)';

  -- foreign-row snapshots: "did anything move?" answered on the whole
  -- decision tuple, not just status.
  v_b1_before text; v_b1_after text;
  v_b2_before text; v_b2_after text;

  -- static sweep, all on comment-stripped source
  v_code_after  text;
  v_code_before text;
  v_code_plural text;
  v_code_decide text;
  v_mut_nopred  text;
  v_mut_notoken text;
  v_pop        bigint; v_writers bigint; v_silent bigint; v_silent_w bigint;
  v_flagged    text;
  v_grants     text;
  v_trg_total  bigint; v_trg_disp text;
  v_notnull    text;

  -- the detector's two halves, applied to an arbitrary body
  v_det_writes  boolean;
  v_det_tokened boolean;
begin
  v_caller := current_user::text;

  ----------------------------------------------------------------------
  -- CAN THIS BLOCK IMPERSONATE AT ALL? Asked by DOING it. Without the role
  -- switch every refusal below would be a claim about `postgres`, which holds
  -- EXECUTE on everything and is not the caller anyone is worried about.
  ----------------------------------------------------------------------
  begin
    set local role authenticated;
    v_seen := current_user::text;
    execute format('set local role %I', v_caller);
  exception when others then
    raise exception '798: cannot switch to role authenticated and back to % (%: %); every probe below would be testing the wrong role', v_caller, sqlstate, sqlerrm;
  end;
  if v_seen is distinct from 'authenticated' then
    raise exception '798: role switch reported current_user=% rather than authenticated', coalesce(v_seen, 'NULL');
  end if;

  ----------------------------------------------------------------------
  -- FIXTURES. Two real workspaces with a real active member each, chosen
  -- from live data and never hardcoded; the TASKS are created here.
  --
  -- !! Identities are NOT fabricated. auth.users is the platform's real
  -- identity store and a synthetic row in it is a usable account, so the
  -- callers below are existing members whose JWT is simulated, the same
  -- technique migration 749 uses. What is created is only the mutable thing
  -- under test: five human_tasks rows, origin='exercise' so no production
  -- gate counts them, all rolled back.
  --
  -- Excluded: hudson-family (the first real customer), outsourcetel-hq (the
  -- founder's own workspace), and anyone holding a platform-layer profile,
  -- because auth_tenant_id() has a platform-operator fallback that would make
  -- the caller's workspace ambiguous.
  ----------------------------------------------------------------------
  select t.id, p.user_id, t.slug into v_ta, v_ua, v_sa
    from public.profiles p join public.tenants t on t.id = p.tenant_id
   where p.layer = 'tenant' and coalesce(p.is_active, true)
     and t.status in ('active','trial')
     and t.slug not in ('hudson-family','outsourcetel-hq')
     and not exists (select 1 from public.profiles q where q.user_id = p.user_id and q.layer = 'platform')
   order by (t.slug = 'review-lab-disposable') desc, t.slug
   limit 1;

  select t.id, p.user_id, t.slug into v_tb, v_ub, v_sb
    from public.profiles p join public.tenants t on t.id = p.tenant_id
   where p.layer = 'tenant' and coalesce(p.is_active, true)
     and t.status in ('active','trial')
     and t.slug not in ('hudson-family','outsourcetel-hq')
     and t.id <> v_ta
     and not exists (select 1 from public.profiles q where q.user_id = p.user_id and q.layer = 'platform')
   order by (t.slug = 'harbor-peak-consulting') desc, t.slug
   limit 1;

  if v_ta is null or v_tb is null or v_ua is null or v_ub is null or v_ta = v_tb then
    raise exception '798: VACUITY -- could not assemble TWO distinct workspaces with a real active member (a=% / %, b=% / %). Every cross-tenant probe below would compare a workspace with itself and pass with the predicate deleted.',
      coalesce(v_ta::text,'NULL'), coalesce(v_ua::text,'NULL'),
      coalesce(v_tb::text,'NULL'), coalesce(v_ub::text,'NULL');
  end if;
  if v_ua = v_ub then
    raise exception '798: VACUITY -- the two workspaces resolved to the SAME member (%), so "as a member of A" and "as a member of B" are the same caller', v_ua;
  end if;

  -- Is 'withdrawn' a legal reason code TODAY? Read from the CONSTRAINT, never
  -- from a copy of the vocabulary held here: a copy would agree with itself
  -- after the constraint changed, which is the one moment this must not.
  select pg_get_constraintdef(oid) ~ '''withdrawn''' into v_wd_legal
    from pg_constraint
   where conrelid = 'public.human_tasks'::regclass
     and conname = 'human_tasks_decision_reason_code_check';

  ----------------------------------------------------------------------
  -- THE PROBE SUBTRANSACTION. Everything from here to `__undo__` is rolled
  -- back, including the scratch functions probes 2 and 5 build.
  ----------------------------------------------------------------------
  v_d := true;
  v_attempted := v_attempted + 7;
  begin
    ------------------------------------------------------------------
    -- Fixture rows. Inserted NOT-pending and then flipped, deliberately:
    -- human_tasks_push_ping is an AFTER INSERT trigger that fires a real
    -- net.http_post to push-send for a row inserted `pending`. A rolled-back
    -- transaction is not a reason to queue a push notification to a real
    -- workspace's devices. The trigger returns early for any other status and
    -- does not fire on UPDATE at all, so the two-step insert avoids it
    -- without disabling anything or taking a lock on a live table.
    ------------------------------------------------------------------
    insert into public.human_tasks (tenant_id, type, title, detail, source, status, origin)
    values (v_ta, 'approval_gate', '798 probe A1', 'cross-tenant withdrawal probe', 'system', 'rejected', 'exercise')
    returning id into v_a1;
    insert into public.human_tasks (tenant_id, type, title, detail, source, status, origin)
    values (v_ta, 'approval_gate', '798 probe A2', 'cross-tenant withdrawal probe', 'system', 'rejected', 'exercise')
    returning id into v_a2;
    insert into public.human_tasks (tenant_id, type, title, detail, source, status, origin)
    values (v_ta, 'approval_gate', '798 probe A3', 'cross-tenant withdrawal probe', 'system', 'rejected', 'exercise')
    returning id into v_a3;
    insert into public.human_tasks (tenant_id, type, title, detail, source, status, origin)
    values (v_tb, 'approval_gate', '798 probe B1', 'cross-tenant withdrawal probe', 'system', 'rejected', 'exercise')
    returning id into v_b1;
    insert into public.human_tasks (tenant_id, type, title, detail, source, status, origin)
    values (v_tb, 'approval_gate', '798 probe B2', 'cross-tenant withdrawal probe', 'system', 'rejected', 'exercise')
    returning id into v_b2;

    perform set_config('app.allow_task_decision', 'on', true);   -- fixture setup only
    update public.human_tasks set status = 'pending'
     where id in (v_a1, v_a2, v_a3, v_b1, v_b2);
    perform set_config('app.allow_task_decision', 'off', true);  -- guard re-armed

    select count(*) into v_int from public.human_tasks
     where id in (v_a1, v_a2, v_a3, v_b1, v_b2) and status = 'pending';
    v_checks := v_checks + 1;
    if v_int <> 5 then
      v_bad := array_append(v_bad, format('VACUITY: only %s of 5 fixture tasks are pending; a withdrawal probe against a non-pending task refuses for the wrong reason', v_int::text));
    end if;

    -- The table guard must be ARMED for the rest of this run, or "nothing
    -- moved" below could be luck rather than refusal.
    v_ref := false;
    begin
      update public.human_tasks set status = 'approved' where id = v_b1;
    exception when others then v_ref := true; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'guard_human_task_decision did NOT raise on a direct status write; app.allow_task_decision leaked on and every probe below runs with the table guard disabled');
    end if;

    select format('%s|%s|%s|%s|%s', status, coalesce(decided_by::text,'-'),
                  coalesce(decided_at::text,'-'), coalesce(disposition,'-'),
                  coalesce(decision_reason_code,'-'))
      into v_b1_before from public.human_tasks where id = v_b1;
    select format('%s|%s|%s|%s|%s', status, coalesce(decided_by::text,'-'),
                  coalesce(decided_at::text,'-'), coalesce(disposition,'-'),
                  coalesce(decision_reason_code,'-'))
      into v_b2_before from public.human_tasks where id = v_b2;

    ------------------------------------------------------------------
    -- The two scratch statements, isolated. 790/794's write and 798's write,
    -- side by side, with the delegation removed: the state one careless edit
    -- to decide_human_task away. Probe 2b uses them as the positive control
    -- for the new predicate; probe 5 uses them for the inversion.
    ------------------------------------------------------------------
    execute $q$
      create function public._probe798_noguard(p_task_id uuid) returns integer
      language plpgsql security definer set search_path to 'public' as $f$
      declare n integer; begin
        update human_tasks set disposition = 'cancelled' where id = p_task_id;
        get diagnostics n = row_count; return n;
      end $f$$q$;
    execute $q$
      create function public._probe798_guarded(p_task_id uuid) returns integer
      language plpgsql security definer set search_path to 'public' as $f$
      declare n integer; v_tenant uuid := auth_tenant_id(); begin
        update human_tasks set disposition = 'cancelled'
         where id = p_task_id and tenant_id = v_tenant;
        get diagnostics n = row_count; return n;
      end $f$$q$;
    execute $q$
      create function public._probe798_nullind(p_task_id uuid) returns integer
      language plpgsql security definer set search_path to 'public' as $f$
      declare n integer; begin
        update human_tasks set disposition = 'cancelled'
         where id = p_task_id and tenant_id is not distinct from auth_tenant_id();
        get diagnostics n = row_count; return n;
      end $f$$q$;

    ------------------------------------------------------------------
    -- PROBE 1 -- THE HEADLINE. A member of workspace A calls
    -- withdraw_human_task on workspace B's task id.
    ------------------------------------------------------------------
    perform set_config('request.jwt.claim.sub', v_ua::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_ua::text, 'role', 'authenticated')::text, true);
    select auth.uid(), public.auth_tenant_id() into v_uid, v_tid;
    v_checks := v_checks + 1;
    if v_uid is distinct from v_ua or v_tid is distinct from v_ta then
      v_bad := array_append(v_bad, format('could not impersonate a member of A: auth.uid()=%L auth_tenant_id()=%L, wanted %L / %L; every refusal below would be about the wrong caller',
        coalesce(v_uid::text,'NULL'), coalesce(v_tid::text,'NULL'), v_ua::text, v_ta::text));
    end if;

    set local role authenticated;
    v_ref := false; v_msg := null;
    begin
      v_row := public.withdraw_human_task(v_b1, '798 probe: cross-tenant singular');
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    execute format('set local role %I', v_caller);

    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, format('EXPLOITABLE: a member of %s withdrew a task belonging to %s and the call RETURNED (id=%L) instead of raising', v_sa, v_sb, coalesce(v_row.id::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_ref and coalesce(v_msg,'') not like 'task_not_found%' then
      v_bad := array_append(v_bad, format('the cross-tenant singular refused, but NOT at the tenant lookup: %L; a refusal for another reason is not evidence about isolation', coalesce(v_msg,'NULL')));
    end if;

    select format('%s|%s|%s|%s|%s', status, coalesce(decided_by::text,'-'),
                  coalesce(decided_at::text,'-'), coalesce(disposition,'-'),
                  coalesce(decision_reason_code,'-'))
      into v_b1_after from public.human_tasks where id = v_b1;
    v_checks := v_checks + 1;
    if v_b1_after is distinct from v_b1_before then
      v_bad := array_append(v_bad, format('EXPLOITABLE: B''s task moved across the cross-tenant singular call: %L -> %L (status|decided_by|decided_at|disposition|reason)', v_b1_before, v_b1_after));
    end if;

    ------------------------------------------------------------------
    -- PROBE 2 -- POSITIVE CONTROLS. Without these, probe 1 proves only that
    -- something refuses everything, which a `raise` on line 1 would too.
    --
    -- 2a: the tenant LOOKUP admits the caller's own task. Driven through
    --     decide_human_task with a LEGAL reason code, because probe 7 shows
    --     withdraw_human_task cannot complete for an unrelated reason.
    -- 2b: the NEW PREDICATE admits the caller's own row. This is the direct
    --     positive control for the statement this migration adds.
    ------------------------------------------------------------------
    perform set_config('app.allow_task_decision', 'off', true);
    set local role authenticated;
    v_ref := false; v_msg := null;
    begin
      v_row := public.decide_human_task(v_a1, 'rejected', 'other', '798 probe: positive control');
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    execute format('set local role %I', v_caller);
    v_checks := v_checks + 1;
    if v_ref or v_row.id is null then
      v_bad := array_append(v_bad, format('POSITIVE CONTROL 2a FAILED: a member of %s could not decide their OWN task: %L; probe 1''s refusal proves nothing if everything is refused', v_sa, coalesce(v_msg,'returned NULL')));
    end if;

    set local role authenticated;
    v_int := public._probe798_guarded(v_a2);
    execute format('set local role %I', v_caller);
    v_checks := v_checks + 1;
    if v_int <> 1 then
      v_bad := array_append(v_bad, format('POSITIVE CONTROL 2b FAILED: the new predicate touched %s of the caller''s OWN rows instead of 1; a predicate that refuses everything is not isolation, it is an outage', v_int::text));
    end if;
    update public.human_tasks set disposition = null where id = v_a2;

    ------------------------------------------------------------------
    -- PROBE 3 -- THE PLURAL, MIXED ARRAY. A partial success that silently
    -- drops the foreign ids is a DIFFERENT answer from a refusal, and the
    -- caller must be able to tell which.
    ------------------------------------------------------------------
    perform set_config('app.allow_task_decision', 'off', true);
    set local role authenticated;
    v_ref := false; v_msg := null;
    begin
      v_json := public.withdraw_human_tasks(array[v_a2, v_b2, v_a3], '798 probe: mixed array');
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    execute format('set local role %I', v_caller);

    v_checks := v_checks + 1;
    if v_ref then
      v_bad := array_append(v_bad, format('the plural raised on a mixed array instead of reporting partial results: %L', coalesce(v_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not (coalesce(v_json->'failed', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', v_b2::text, 'error', 'task_not_found'))) then
      v_bad := array_append(v_bad, format('the plural did not name B''s id in `failed` with task_not_found; a caller cannot tell a partial result from a success. failed=%L', coalesce((v_json->'failed')::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce((v_json->'failed')::text, '') like ('%' || v_b2::text || '%')
       and coalesce((v_json->>'withdrawn')::int, -1) < 0 then
      v_bad := array_append(v_bad, 'the plural returned no `withdrawn` count at all; a partial result with no numerator is not a report');
    end if;

    select format('%s|%s|%s|%s|%s', status, coalesce(decided_by::text,'-'),
                  coalesce(decided_at::text,'-'), coalesce(disposition,'-'),
                  coalesce(decision_reason_code,'-'))
      into v_b2_after from public.human_tasks where id = v_b2;
    v_checks := v_checks + 1;
    if v_b2_after is distinct from v_b2_before then
      v_bad := array_append(v_bad, format('EXPLOITABLE: B''s task moved across the mixed-array plural call: %L -> %L', v_b2_before, v_b2_after));
    end if;

    ------------------------------------------------------------------
    -- PROBE 4 -- NO TENANT AT ALL. auth_tenant_id() is NULL for anon and for
    -- service_role. If the lookup became `tenant_id = NULL` it matches
    -- nothing, which is safe; if any path compared with `is not distinct
    -- from`, NULL would match NULL. Both spellings are DRIVEN, in probe 5.
    ------------------------------------------------------------------
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims',    '', true);
    perform set_config('app.allow_task_decision', 'off', true);
    select auth.uid(), public.auth_tenant_id() into v_uid, v_tid;
    v_checks := v_checks + 1;
    if v_uid is not null or v_tid is not null then
      v_bad := array_append(v_bad, format('could not clear the identity (auth.uid()=%L auth_tenant_id()=%L); the refusals in probe 4 would be about some other bar',
        coalesce(v_uid::text,'NULL'), coalesce(v_tid::text,'NULL')));
    end if;

    set local role authenticated;
    v_ref := false; v_msg := null;
    begin
      v_row := public.withdraw_human_task(v_b1, '798 probe: no tenant');
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    execute format('set local role %I', v_caller);

    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, format('EXPLOITABLE: a caller with NO tenant withdrew a task (id=%L)', coalesce(v_row.id::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_ref and coalesce(v_msg,'') not like 'not_authenticated%' then
      v_bad := array_append(v_bad, format('the no-tenant caller was refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    -- tenant_id is NOT NULL on this table, so even the dangerous spelling
    -- matches nothing HERE. That is worth proving, not assuming: it is the
    -- only thing standing behind the equality if the column is ever relaxed.
    select is_nullable into v_notnull from information_schema.columns
     where table_schema='public' and table_name='human_tasks' and column_name='tenant_id';
    v_checks := v_checks + 1;
    if coalesce(v_notnull,'YES') <> 'NO' then
      v_bad := array_append(v_bad, format('human_tasks.tenant_id is_nullable=%L; a NULL tenant_id row would be matched by `is not distinct from NULL`', coalesce(v_notnull,'NULL')));
    end if;

    ------------------------------------------------------------------
    -- PROBE 5 -- THE INVERSION, and the reason this migration exists.
    --
    -- The new predicate is UNREACHABLE through the public entry point while
    -- the delegation holds, so deleting it there changes nothing observable
    -- and no probe on the real function could ever go red for it. These
    -- isolate the statement instead.
    ------------------------------------------------------------------
    perform set_config('request.jwt.claim.sub', v_ua::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_ua::text, 'role', 'authenticated')::text, true);

    set local role authenticated;
    v_int := public._probe798_guarded(v_b1);
    execute format('set local role %I', v_caller);
    v_checks := v_checks + 1;
    if v_int <> 0 then
      v_bad := array_append(v_bad, format('THE NEW PREDICATE DID NOT HOLD: the guarded statement touched %s of B''s rows as a member of A', v_int::text));
    end if;

    set local role authenticated;
    v_int := public._probe798_noguard(v_b1);
    execute format('set local role %I', v_caller);
    v_checks := v_checks + 1;
    if v_int <> 1 then
      v_bad := array_append(v_bad, format('INVERSION DEAD: 790/794''s unguarded statement touched %s of B''s rows instead of 1. The probe cannot tell the predicate apart from its absence, so the green above proves nothing', v_int::text));
    end if;
    select disposition into v_txt from public.human_tasks where id = v_b1;
    v_checks := v_checks + 1;
    if v_txt is distinct from 'cancelled' then
      v_bad := array_append(v_bad, format('INVERSION DEAD: the unguarded statement reported 1 row but B''s disposition is %L; the red arm did not actually write', coalesce(v_txt,'NULL')));
    end if;

    -- undo the inversion's write at once, so the "nothing moved" checks that
    -- follow are not measuring the probe's own damage.
    update public.human_tasks set disposition = null where id = v_b1;

    set local role authenticated;
    v_int := public._probe798_nullind(v_b1);
    execute format('set local role %I', v_caller);
    v_checks := v_checks + 1;
    if v_int <> 0 then
      v_bad := array_append(v_bad, format('`tenant_id is not distinct from auth_tenant_id()` matched %s of B''s rows as a member of A', v_int::text));
    end if;

    -- and with NO identity: the NULL-matches-NULL question, driven.
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims',    '', true);
    set local role authenticated;
    v_int := public._probe798_nullind(v_b1);
    v_seen := public._probe798_guarded(v_b1)::text;
    execute format('set local role %I', v_caller);
    v_checks := v_checks + 1;
    if v_int <> 0 then
      v_bad := array_append(v_bad, format('NULL MATCHED NULL: with auth_tenant_id() null, `is not distinct from` matched %s row(s); that spelling is a cross-tenant write', v_int::text));
    end if;
    v_checks := v_checks + 1;
    if v_seen <> '0' then
      v_bad := array_append(v_bad, format('with auth_tenant_id() null, the equality predicate matched %s row(s); wanted 0', v_seen));
    end if;

    execute 'drop function public._probe798_noguard(uuid)';
    execute 'drop function public._probe798_guarded(uuid)';
    execute 'drop function public._probe798_nullind(uuid)';

    ------------------------------------------------------------------
    -- PROBE 6 -- THE WINDOW. The disposition is written AFTER
    -- decide_human_task has already returned, so between the two statements
    -- the task is DECIDED and NOT YET DISPOSITIONED. Driven, not reasoned
    -- about. (A legal reason code is used because probe 7 shows the one
    -- withdraw_human_task passes is rejected by a CHECK constraint; the
    -- window is structural and does not depend on which code is used.)
    ------------------------------------------------------------------
    perform set_config('request.jwt.claim.sub', v_ub::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_ub::text, 'role', 'authenticated')::text, true);
    perform set_config('app.allow_task_decision', 'off', true);
    set local role authenticated;
    v_row := public.decide_human_task(v_b2, 'rejected', 'other', '798 probe: window');
    execute format('set local role %I', v_caller);

    select status, disposition into v_txt, v_seen from public.human_tasks where id = v_b2;
    v_checks := v_checks + 1;
    if v_txt is distinct from 'rejected' then
      v_bad := array_append(v_bad, format('window probe: the decision did not land (status=%L) so the window was never entered', coalesce(v_txt,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_seen is not null then
      v_bad := array_append(v_bad, format('window probe: disposition was already %L immediately after decide_human_task; the window described in this migration''s header does not exist and the header is wrong', v_seen));
    end if;

    ------------------------------------------------------------------
    -- PROBE 7 -- DOES THE FUNCTION WORK AT ALL? The first thing in three
    -- migrations to CALL it rather than read its text.
    --
    -- This does not fail the migration on the KNOWN defect (790 passes an
    -- illegal reason code; repairing that means choosing between widening a
    -- closed, learning-bearing vocabulary and reusing 'other', which is a
    -- product decision and not this file's subject). It stays loud, it fails
    -- on any OTHER error, and it becomes a hard assertion the moment
    -- 'withdrawn' is made legal.
    ------------------------------------------------------------------
    perform set_config('request.jwt.claim.sub', v_ua::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_ua::text, 'role', 'authenticated')::text, true);
    perform set_config('app.allow_task_decision', 'off', true);
    set local role authenticated;
    v_ref := false; v_msg := null; v_state := null;
    begin
      v_row := public.withdraw_human_task(v_a3, '798 probe: does it work at all');
    exception when others then v_ref := true; v_msg := sqlerrm; v_state := sqlstate; end;
    execute format('set local role %I', v_caller);

    if not v_ref then
      select status, disposition into v_txt, v_seen from public.human_tasks where id = v_a3;
      v_wd_outcome := format('WORKS (status=%s disposition=%s)', coalesce(v_txt,'NULL'), coalesce(v_seen,'NULL'));
    else
      v_wd_outcome := format('%s %s', coalesce(v_state,'?'), coalesce(v_msg,'?'));
    end if;

    v_checks := v_checks + 1;
    if v_ref and not (v_state = '23514' and coalesce(v_msg,'') like '%human_tasks_decision_reason_code_check%') then
      v_bad := array_append(v_bad, format('withdraw_human_task failed on its OWN workspace''s task in a way this migration has not classified: %s %L', coalesce(v_state,'?'), coalesce(v_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_ref and v_wd_legal then
      v_bad := array_append(v_bad, format('''withdrawn'' is now a legal decision_reason_code and withdraw_human_task STILL fails: %s %L', coalesce(v_state,'?'), coalesce(v_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_ref then
      select status, disposition into v_txt, v_seen from public.human_tasks where id = v_a3;
      if v_txt is distinct from 'rejected' or v_seen is distinct from 'cancelled' then
        v_bad := array_append(v_bad, format('withdraw_human_task returned without error but left status=%L disposition=%L; wanted rejected/cancelled', coalesce(v_txt,'NULL'), coalesce(v_seen,'NULL')));
      end if;
    end if;

    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('THE PROBE SUBTRANSACTION ABORTED (%s: %s); probes 1-7 were NOT completed this run', sqlstate, sqlerrm));
      v_d := false;
    end if;
  end;
  if v_d then v_probes := v_probes + 7; end if;

  ----------------------------------------------------------------------
  -- ROLLBACK PROOF. Every fixture and every scratch function must be gone.
  ----------------------------------------------------------------------
  select count(*) into v_int from public.human_tasks where title like '798 probe %';
  v_checks := v_checks + 1;
  if v_int <> 0 then
    v_bad := array_append(v_bad, format('%s probe task(s) survived the subtransaction; the fixtures were not rolled back', v_int::text));
  end if;
  v_checks := v_checks + 1;
  if to_regprocedure('public._probe798_noguard(uuid)') is not null
     or to_regprocedure('public._probe798_guarded(uuid)') is not null
     or to_regprocedure('public._probe798_nullind(uuid)') is not null then
    v_bad := array_append(v_bad, 'a _probe798_* scratch function survived the subtransaction; this migration would ship an unguarded SECURITY DEFINER writer of its own');
  end if;

  ----------------------------------------------------------------------
  -- STATIC PINS. All on COMMENT-STRIPPED, whitespace-collapsed source: pin
  -- S4 fired on this function's own warning comment the first time it ran.
  ----------------------------------------------------------------------
  select regexp_replace(regexp_replace(pg_get_functiondef(oid), '--[^' || chr(10) || ']*', '', 'g'), '\s+', ' ', 'g')
    into v_code_after from pg_proc where oid = 'public.withdraw_human_task(uuid, text)'::regprocedure;
  select regexp_replace(regexp_replace(pg_get_functiondef(oid), '--[^' || chr(10) || ']*', '', 'g'), '\s+', ' ', 'g')
    into v_code_plural from pg_proc where oid = 'public.withdraw_human_tasks(uuid[], text)'::regprocedure;
  select regexp_replace(regexp_replace(pg_get_functiondef(oid), '--[^' || chr(10) || ']*', '', 'g'), '\s+', ' ', 'g')
    into v_code_decide from pg_proc where oid = 'public.decide_human_task(uuid, text, text, text, jsonb)'::regprocedure;
  v_code_before := regexp_replace(regexp_replace(
      coalesce(current_setting('app.probe_798_def_before', true), ''),
      '--[^' || chr(10) || ']*', '', 'g'), '\s+', ' ', 'g');

  -- The strip must actually strip. A no-op regexp would leave every pin below
  -- reading prose again, silently.
  v_checks := v_checks + 1;
  if v_code_after ~ '--' then
    v_bad := array_append(v_bad, 'the comment strip left `--` in the source; every pin below is matching prose as well as code');
  end if;
  v_checks := v_checks + 1;
  if length(v_code_after) >= length(pg_get_functiondef('public.withdraw_human_task(uuid, text)'::regprocedure)) then
    v_bad := array_append(v_bad, 'the comment strip removed nothing; it is not doing the job pin S4 needs it to do');
  end if;

  -- S1. The predicate is there.
  v_checks := v_checks + 1;
  if v_code_after !~* 'update human_tasks set disposition = ''cancelled'' where id = p_task_id and tenant_id = v_tenant' then
    v_bad := array_append(v_bad, 'the disposition update no longer carries `and tenant_id = v_tenant`; the whole point of this migration');
  end if;

  -- S1-inverted. Strip the predicate from a COPY and confirm the pin fires.
  -- A pin whose pattern matched anything would look identical without this.
  v_mut_nopred := replace(v_code_after, ' and tenant_id = v_tenant', '');
  v_checks := v_checks + 1;
  if v_mut_nopred ~* 'update human_tasks set disposition = ''cancelled'' where id = p_task_id and tenant_id = v_tenant' then
    v_bad := array_append(v_bad, 'PIN S1 IS VACUOUS: it still matches a copy of the body with the predicate deleted');
  end if;

  -- S2. The delegation must survive. Predicate AND delegation, never either.
  v_checks := v_checks + 1;
  if v_code_after !~* 'decide_human_task' then
    v_bad := array_append(v_bad, 'withdraw_human_task no longer delegates to decide_human_task; the audit event, the DE reporting-line check and the fourteen sync triggers all came from that call');
  end if;
  v_checks := v_checks + 1;
  if v_code_after ~* 'update human_tasks set[^;]*status' then
    v_bad := array_append(v_bad, 'withdraw_human_task writes status directly; that is the second decision path mig 486 exists to prevent');
  end if;
  v_checks := v_checks + 1;
  if v_code_after !~* '''rejected''' then
    v_bad := array_append(v_bad, 'withdraw_human_task does not decide rejected; a withdrawal must never be able to execute the action');
  end if;

  -- S3. The zero-row arm.
  v_checks := v_checks + 1;
  if v_code_after !~* 'get diagnostics' or v_code_after !~* 'withdraw_incomplete' then
    v_bad := array_append(v_bad, 'the disposition update no longer checks its own row_count; a tenant predicate that misses would return a decided-but-not-withdrawn task as success');
  end if;

  -- S4. THE BANNED PREFIX, on stripped code only.
  v_checks := v_checks + 1;
  if v_code_after ~* 'auth\.uid\(\) is not null and' then
    v_bad := array_append(v_bad, 'withdraw_human_task gates its check on `auth.uid() is not null and`; the mig 749 shape, which skips rather than fails');
  end if;

  -- S4b. MIG 794's BAR, kept. It is REDUNDANT at runtime -- deleting it leaves
  -- every probe here green, because decide_human_task raises the same
  -- 'not_authenticated' one frame down -- which is exactly why it needs a
  -- static pin: nothing else in this suite would notice it going. Measured by
  -- mutation, not assumed: the mutant that removes it is the one mutant of
  -- eight that stayed green.
  v_checks := v_checks + 1;
  if v_code_after !~* 'if v_tenant is null then raise exception ''not_authenticated''' then
    v_bad := array_append(v_bad, 'the explicit null-tenant bar (mig 794) is gone from the body; no runtime probe can see that, because the delegation raises the same thing one frame down');
  end if;

  -- S5. No `is not distinct from` on the tenant comparison, in EITHER
  -- function. Probe 5 showed what that spelling does when both sides are null.
  v_checks := v_checks + 1;
  if v_code_after ~* 'tenant_id is not distinct from'
     or v_code_decide ~* 'tenant_id is not distinct from' then
    v_bad := array_append(v_bad, 'a tenant comparison on this path uses `is not distinct from`; NULL matches NULL and a caller with no workspace matches rows with none');
  end if;
  v_checks := v_checks + 1;
  if v_code_decide !~* 'tenant_id = v_tenant' then
    v_bad := array_append(v_bad, 'decide_human_task no longer scopes its task lookup by tenant_id = v_tenant; the delegation half of the defence is gone');
  end if;

  -- S6. THE PLURAL. It needs no predicate because it writes nothing.
  v_checks := v_checks + 1;
  if v_code_plural ~* '(insert into|update [a-z_"]+ set|delete from|truncate )' then
    v_bad := array_append(v_bad, 'withdraw_human_tasks grew a direct write; it is exempt from a tenant predicate ONLY while it writes nothing and loops the singular');
  end if;
  v_checks := v_checks + 1;
  if v_code_plural !~* 'withdraw_human_task' then
    v_bad := array_append(v_bad, 'withdraw_human_tasks no longer calls the singular; its isolation came entirely from that call');
  end if;

  -- S7. GRANTS, both directions.
  select coalesce(string_agg(distinct grantee, ','), '(none)') into v_grants
    from information_schema.role_routine_grants
   where specific_schema = 'public'
     and routine_name in ('withdraw_human_task','withdraw_human_tasks')
     and grantee in ('anon','PUBLIC','public');
  v_checks := v_checks + 1;
  if v_grants <> '(none)' then
    v_bad := array_append(v_bad, format('withdraw is reachable by %s; the internet does not clear a governance queue', v_grants));
  end if;
  v_checks := v_checks + 1;
  if not has_function_privilege('authenticated', 'public.withdraw_human_task(uuid, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.withdraw_human_tasks(uuid[], text)', 'EXECUTE') then
    v_bad := array_append(v_bad, 'CREATE OR REPLACE dropped the authenticated grant; the Approvals page would 403 on every withdrawal');
  end if;

  -- S8. THE TEST THAT WAS RED. Its own detector, re-run here.
  select count(*) filter (where prosecdef and auth_can and rettype <> 'trigger'),
         count(*) filter (where prosecdef and auth_can and rettype <> 'trigger' and writes),
         count(*) filter (where prosecdef and auth_can and rettype <> 'trigger' and not tokened),
         count(*) filter (where prosecdef and auth_can and rettype <> 'trigger' and not tokened and writes),
         coalesce(string_agg(proname, ',' order by proname)
                  filter (where prosecdef and auth_can and rettype <> 'trigger' and not tokened and writes
                            and proname not in (select function_name from public.unguarded_secdef_writers)), '(none)')
    into v_pop, v_writers, v_silent, v_silent_w, v_flagged
    from (
      select p.proname, p.prosecdef, p.prorettype::regtype::text as rettype,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_can,
             (regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')
                ~* '(insert into|update [a-z_"]+ set|delete from|truncate )') as writes,
             (regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')
                ~* 'auth_tenant_id|auth_has_tenant_role|can_admin_tenant_internal|is_platform_admin|resolve_platform_capability|_assert_|current_tenant|auth\.uid\(\)') as tokened
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind in ('f','p')
    ) s;
  v_checks := v_checks + 1;
  if v_flagged <> '(none)' then
    v_bad := array_append(v_bad, format('the invariant test is STILL red: %s', v_flagged));
  end if;
  v_checks := v_checks + 1;
  if v_pop < 100 or v_writers < 10 then
    v_bad := array_append(v_bad, format('VACUITY: the detector examined %s function(s) of which %s write; too few for "nothing flagged" to mean anything', v_pop::text, v_writers::text));
  end if;

  -- S8-inverted (a): the detector must still be ABLE to flag something.
  -- Strip the authority token from a copy of the new body and re-run it.
  v_mut_notoken := replace(v_code_after, 'auth_tenant_id', 'zzz_no_token');
  v_det_writes  := v_mut_notoken ~* '(insert into|update [a-z_"]+ set|delete from|truncate )';
  v_det_tokened := v_mut_notoken ~* 'auth_tenant_id|auth_has_tenant_role|can_admin_tenant_internal|is_platform_admin|resolve_platform_capability|_assert_|current_tenant|auth\.uid\(\)';
  v_checks := v_checks + 1;
  if not (v_det_writes and not v_det_tokened) then
    v_bad := array_append(v_bad, format('INVERSION DEAD: with the authority token removed the detector still does not flag this body (writes=%s tokened=%s); its silence about the real body means nothing', v_det_writes::text, v_det_tokened::text));
  end if;

  -- S8-inverted (b) -- THE BLIND SPOT, demonstrated rather than asserted.
  -- Take the new body, delete ONLY the tenant predicate, keep the token that
  -- migration 794 added. The write is then exactly as unguarded as 790's, and
  -- the detector reports NOTHING. This is why the suite going green is not by
  -- itself evidence, and why an allow-list entry would have been worse still.
  v_det_writes  := v_mut_nopred ~* '(insert into|update [a-z_"]+ set|delete from|truncate )';
  v_det_tokened := v_mut_nopred ~* 'auth_tenant_id|auth_has_tenant_role|can_admin_tenant_internal|is_platform_admin|resolve_platform_capability|_assert_|current_tenant|auth\.uid\(\)';
  v_checks := v_checks + 1;
  if not (v_det_writes and v_det_tokened) then
    v_bad := array_append(v_bad, format('the blind-spot demonstration did not reproduce (writes=%s tokened=%s); the claim in this migration''s header about what the detector cannot see is unproven and must be rewritten', v_det_writes::text, v_det_tokened::text));
  end if;

  -- S8-inverted (c): the body this migration replaced. Recorded, not
  -- asserted: what "before" holds depends on which sibling migration landed
  -- last, and a pin that depends on that is a pin that rots.
  v_checks := v_checks + 1;
  if v_code_before = '' then
    v_bad := array_append(v_bad, 'the pre-798 definition was not captured; the before/after comparison below is empty');
  end if;

  -- S9. THE WINDOW's readers, enumerated rather than assumed.
  select count(*), coalesce(string_agg(p.proname, ',' order by p.proname)
                            filter (where pg_get_functiondef(p.oid) ~* 'disposition'), '(none)')
    into v_trg_total, v_trg_disp
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.human_tasks'::regclass and not t.tgisinternal;
  v_checks := v_checks + 1;
  if v_trg_total < 10 then
    v_bad := array_append(v_bad, format('VACUITY: only %s triggers found on human_tasks; the window enumeration is looking at the wrong table', v_trg_total::text));
  end if;
  v_checks := v_checks + 1;
  if v_trg_disp <> 'sync_de_work_escalation' then
    v_bad := array_append(v_bad, format('the set of human_tasks triggers reading `disposition` changed to {%s}; the window analysis in this migration''s header is out of date and must be redone', v_trg_disp));
  end if;

  ----------------------------------------------------------------------
  -- ASSERTION FLOOR. Zero findings from zero comparisons looks exactly like
  -- a clean result, and every arm above is a "no violation found" query.
  ----------------------------------------------------------------------
  if v_attempted <> 7 then
    raise exception '798: ASSERTION FLOOR -- % probes were attempted, 7 expected', v_attempted;
  end if;
  if v_probes <> v_attempted then
    raise exception E'798: ASSERTION FLOOR -- % of % probes completed. Findings so far:\n  %',
      v_probes, v_attempted, coalesce(array_to_string(v_bad, E'\n  '), '(none recorded)');
  end if;
  if v_checks < 52 then
    raise exception '798: ASSERTION FLOOR -- only % assertions ran; at least 52 must. A run that compared less than it claims is not a pass.', v_checks;
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception E'798 VERIFICATION FAILED (% assertions across %/% probes):\n  %',
      v_checks, v_probes, v_attempted, array_to_string(v_bad, E'\n  ');
  end if;

  ----------------------------------------------------------------------
  -- A CLEAN RUN IS AS LOUD AS A FAILING ONE, and under dry run neither can
  -- commit. The migration aborts ITSELF rather than relying on whoever ran it
  -- remembering to type rollback.
  ----------------------------------------------------------------------
  if coalesce(current_setting('app.probe_798_dry_run', true), '') = 'on' then
    raise exception E'798 DRY RUN COMPLETE -- % assertions across %/% probes, 0 findings.\n  NOT EXPLOITABLE: as a member of %, withdraw_human_task on a task of % raised task_not_found and that row did not move; the mixed-array plural named the foreign id in `failed` as task_not_found and that row did not move; a caller with no tenant raised not_authenticated.\n  THE PREDICATE IS LOAD-BEARING ANYWAY: with the delegation removed, 790/794''s statement wrote the foreign row (1 row) and 798''s touched 0, while the SAME body minus the predicate is invisible to the invariant detector (writes AND tokened).\n  DOES IT WORK AT ALL: withdraw_human_task(own task, own workspace) -> %.\n  Detector: % SECURITY DEFINER functions reachable by authenticated, % write, % name no authority token, % of those write. Flagged: %.\n  Aborting deliberately: nothing here is committed.',
      v_checks, v_probes, v_attempted, v_sa, v_sb, v_wd_outcome, v_pop, v_writers, v_silent, v_silent_w, v_flagged;
  end if;

  raise notice '798: % assertions across %/% probes, 0 findings. A member of % cannot reach a task of %: the singular raises task_not_found, the mixed-array plural names the foreign id in `failed`, a caller with no tenant raises not_authenticated, and the foreign row does not move in any of the three. The predicate is load-bearing anyway: with the delegation removed 790/794''s statement wrote the foreign row and 798''s did not. withdraw_human_task(own task) -> %. Detector: %/% reachable SECURITY DEFINER writers, % token-silent, % of those write, flagged=%.',
    v_checks, v_probes, v_attempted, v_sa, v_sb, v_wd_outcome, v_writers, v_pop, v_silent, v_silent_w, v_flagged;
end;
$verify$;

commit;
