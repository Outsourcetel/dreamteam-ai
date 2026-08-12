-- 722_revoke_execute_on_trigger_functions.sql
-- ==========================================================================
-- The doctrine (migs 610 + 630): every function in `public` must have EXECUTE
-- revoked from PUBLIC, anon and authenticated, granted explicitly to the role
-- that needs it, and the RESULT asserted with has_function_privilege — because
-- `create or replace` PRESERVES grants, so a REVOKE statement is a request,
-- not a description of the privileges you ended up with.
--
-- This migration closes the whole TRIGGER-FUNCTION half of that surface.
--
-- ── The census, measured on production 2026-08-12 before writing a line ───
--   928  functions in `public` (prokind f/p)
--   610  of them EXECUTE-reachable by anon or authenticated
--    80  return `trigger`
--    49  of those 80 were reachable — 44 via the built-in PUBLIC grant
--         (`=X/postgres` in proacl), 5 via an explicit `authenticated=X`
--         (guard_against_demo_tenant_assignment, handle_new_user,
--          invalidate_answer_cache, trust_check_eval_regression,
--          trust_check_guardrail_block)
--   This migration fixes all 49. It leaves the 561 non-trigger reachable
--   functions alone — see "WHAT THIS DELIBERATELY DOES NOT TOUCH" below.
--
-- The two reports that started this were both instances of the 49:
--   * five `sync_*` siblings of mig 721's sync_conversation_draft_decision
--     (the new one is clean; sync_amendment_decision, sync_computer_use_approval,
--      sync_de_department, sync_de_task_from_objective, sync_de_work_escalation,
--      sync_entity_amendment_decision, sync_improvement_decision,
--      sync_outbound_draft_status, sync_primary_unit_membership,
--      sync_profile_department were not — ten, not five)
--   * playbook_definitions_set_kind(), granted to anon AND authenticated
--
-- ⚠ playbook_definitions_set_kind() IS NOT DEFINED ON `main`. Its source lives
--   only on the unmerged branch `claude/goofy-swanson-5d16ef` (worktree
--   .claude/worktrees/pensive-swanson-5668a0), in the migration the production
--   ledger carries as ORPHANED 715_the_definition_says_which_engine_owns_it.sql
--   — applied to production, present in no tree that main can see. That
--   migration revokes on its helper `playbook_definition_kind(jsonb)` and
--   forgets the trigger function itself.
--   WHOEVER MERGES THAT BRANCH MUST NOT REGRESS THIS. `create or replace`
--   preserves grants, so re-running its 715 will NOT re-open the hole — but
--   ADDING a `grant execute ... to anon, authenticated` line, or creating the
--   function fresh in an environment rebuilt from migrations, will. The branch
--   needs this line beside its own create:
--     revoke execute on function public.playbook_definitions_set_kind()
--       from public, anon, authenticated;
--   This migration is written as a RULE over every trigger function rather
--   than a list of names precisely so it stays correct when that branch lands.
--
-- ── WHY THIS IS SAFE — and why the reason usually given for it is WRONG ───
-- The received wisdom is "trigger functions run as the table owner, so the
-- caller's EXECUTE never matters". That is FALSE and was tested, not assumed
-- (dev project, rolled-back transaction, 2026-08-12): a SECURITY INVOKER
-- trigger function fired with current_user = 'authenticated'. Triggers run as
-- the CALLER.
--
-- The property that actually makes the revoke safe is a different one:
-- PostgreSQL checks EXECUTE on a trigger function at CREATE TRIGGER time, NOT
-- at fire time. The same rolled-back experiment revoked EXECUTE from PUBLIC,
-- anon and authenticated, then drove an INSERT as `authenticated`, and the
-- trigger fired and applied its effect with has_function_privilege() reading
-- false for both roles. A function returning `trigger` also cannot be called
-- directly (PostgREST cannot expose it, and Postgres rejects a direct call),
-- so no caller anywhere loses anything.
--
-- Two consequences of "triggers run as the caller" that this migration
-- respects:
--   * No dynamic DDL depends on the grant. Verified: ZERO functions in public
--     contain a CREATE TRIGGER, so nothing creates a trigger at runtime as a
--     role that would now need EXECUTE. All 80 trigger functions are attached
--     to at least one live trigger; none is stranded.
--   * It is exactly why the non-trigger helpers below are NOT touched.
--
-- ── BOTH HALVES ──────────────────────────────────────────────────────────
-- mig 643 nearly left 11 of 12 workspaces administrable by nobody. A revoke
-- that breaks a legitimate caller is the same defect wearing the opposite
-- mask, and REVOKE reports nothing either way. So the assert block below does
-- not only check that anon/authenticated/PUBLIC LOST it — it checks that
-- service_role and postgres KEPT it, on every one of the 80, and refuses to
-- report a clean sweep if it examined implausibly few (a checker that cannot
-- fail is theatre).
--
-- ── WHAT THIS DELIBERATELY DOES NOT TOUCH ────────────────────────────────
-- 20 NON-trigger functions in public also hold the built-in PUBLIC EXECUTE:
--   access_permission_level, ai_change_is_auto_appliable, b64url,
--   build_base_predicates, compute_inquiry_confidence, dunning_email,
--   dunning_execution_key, dunning_note_text, is_safe_external_url,
--   jsonb_object_agg_subset, money_text, normalize_operate_domain,
--   operate_domain_of, playbook_next_fire_at, render_playbook_structure,
--   response_window_due_at, sql_op, trust_ladder_settings,
--   trust_level_settings, watcher_label
-- Every one is SECURITY INVOKER and IMMUTABLE or STABLE — pure computation
-- over its arguments, so the exposure is a calculator, not data. They are left
-- because of the property proven above: TRIGGER BODIES RUN AS THE CALLER, and
-- EXECUTE on a *called* function IS checked at call time. playbook_next_fire_at
-- is called by the trigger playbook_schedules_compute_next; money_text and
-- trust_level_settings have SECURITY INVOKER callers reachable by
-- authenticated. Revoking these without proving each call context first is
-- precisely the mig-643 mask, and it is a separate, larger decision.
--
-- ⚠ ALSO LEFT, AND IT IS THE ROOT CAUSE: the generator is still open. A brand
-- new function created by `postgres` in `public` on production TODAY arrives
-- with proacl `=X/postgres` — PUBLIC EXECUTE — so anon and authenticated can
-- reach it the moment it exists. Measured by driving it (create a function in
-- a rolled-back transaction and read its proacl), not inferred. mig 715's
-- default-privileges ratchet fixed this for TABLES; it CANNOT fix it for
-- functions: `alter default privileges in schema public revoke execute on
-- functions from public` was tested on dev in both orderings, with and without
-- a companion grant, and in every case a newly created function still came out
-- with `=X/postgres`. There is therefore NO database-side defence available.
-- Every migration must carry its own REVOKE, and the only thing that can catch
-- the one that forgets is the gate. That is why certify gains a
-- trigger-function arm in this change that --pin-allowlist CANNOT bless.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────
-- To restore the exact pre-722 state, in two groups (they differed):
--
--   -- the 44 that held the built-in PUBLIC grant:
--   grant execute on function public.<name>() to public, anon, authenticated;
--     alert_cert_regression, assert_kpi_metric_known,
--     assert_org_unit_same_tenant, audit_de_config_changes,
--     audit_events_immutable, auto_provision_new_tenant,
--     close_escalations_for_finished_goal, dunning_rung_order_guard,
--     enqueue_conflict_probe, gate_de_certification,
--     guard_compliance_guardrails, guard_computer_use_transition,
--     guard_human_task_decision, guardrail_adjudications_immutable,
--     link_new_account_to_agreements, maintain_doc_chunk_counts,
--     net_dispatch_log_trg, normalise_de_state, onboarding_progress_recalc,
--     opportunities_stage_guard, org_units_check_parent,
--     playbook_definitions_set_kind, playbook_schedules_compute_next,
--     posting_draft_gate, stamp_gap_cluster_on_apply,
--     stamp_objective_mission_from_watcher, sync_amendment_decision,
--     sync_computer_use_approval, sync_de_department,
--     sync_de_task_from_objective, sync_de_work_escalation,
--     sync_entity_amendment_decision, sync_improvement_decision,
--     sync_outbound_draft_status, sync_primary_unit_membership,
--     sync_profile_department, tenant_deletion_receipts_immutable,
--     trg_assign_human_task, trg_provision_onboarding_architect,
--     trg_recompute_trust_badge, trg_support_sentiment,
--     trg_triage_support_conversation, update_updated_at,
--     validate_work_watcher
--
--   -- the 5 that held an explicit `authenticated` grant and no PUBLIC one:
--   grant execute on function public.<name>() to authenticated;
--     guard_against_demo_tenant_assignment, handle_new_user,
--     invalidate_answer_cache, trust_check_eval_regression,
--     trust_check_guardrail_block
--
-- Nothing here grants anything, so a rollback is only ever needed to restore
-- a privilege — never to remove one.
-- ==========================================================================

begin;

-- ── 0. Snapshot the BEFORE state ─────────────────────────────────────────
-- The assert in step 2 compares AFTER against THIS, not against an assumption
-- about what the shape "should" be. That distinction is the whole of the
-- mig-643 lesson and it earned its keep on the first dev run of this file:
-- production holds an explicit `service_role=X` on all 80 trigger functions,
-- but DEV held it on only 2 of 49 — on the other 47, service_role's EXECUTE
-- was riding on the PUBLIC grant this migration removes. A hardcoded "of
-- course service_role keeps it" would have shipped a silent over-revoke to
-- every environment that is not production. Step 1 restores it explicitly.
create temp table _mig722_before on commit drop as
  select p.oid                                                    as fn_oid,
         p.proname                                                as fn_name,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as had_service_role,
         has_function_privilege('postgres',     p.oid, 'EXECUTE') as had_postgres,
         (has_function_privilege('anon',          p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')) as was_breached
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type t      on t.oid = p.prorettype
   where n.nspname = 'public'
     and p.prokind = 'f'
     and t.typname = 'trigger';

-- ── 1. The revoke, written as the RULE rather than a snapshot ─────────────
-- A list of 49 names is correct only until the fiftieth trigger function
-- lands, and this repo has concurrent sessions and an unmerged branch that
-- already owns one of the 49. Encoding the rule makes the migration idempotent
-- and makes a rebuilt environment converge on the same answer.
do $$
declare
  r          record;
  v_examined int    := 0;
  v_revoked  int    := 0;
  v_restored int    := 0;
  v_names    text[] := '{}';
begin
  for r in select * from _mig722_before order by fn_name loop
    v_examined := v_examined + 1;

    if r.was_breached then
      -- regprocedure, not %I() — the signature comes from the catalog, so this
      -- stays correct if a trigger function ever takes CREATE TRIGGER args.
      execute format(
        'revoke execute on function %s from public, anon, authenticated',
        r.fn_oid::regprocedure);
      v_revoked := v_revoked + 1;
      v_names   := array_append(v_names, r.fn_name);
    end if;

    -- BOTH HALVES, in the same loop: if service_role held EXECUTE only through
    -- the PUBLIC grant just removed, give it back EXPLICITLY. That is the
    -- doctrine's second clause — "granted explicitly to the role that needs
    -- it" — and it converges every environment on production's shape
    -- (postgres=X | service_role=X), which is exactly what mig 721's clean
    -- sync_conversation_draft_decision already looks like. Nothing here grants
    -- a privilege that was not held a statement earlier.
    if r.had_service_role
       and not has_function_privilege('service_role', r.fn_oid, 'EXECUTE') then
      execute format('grant execute on function %s to service_role', r.fn_oid::regprocedure);
      v_restored := v_restored + 1;
    end if;
  end loop;

  -- Zero findings from zero comparisons looks exactly like a clean result.
  -- Production had 80 trigger functions in public and dev had 76 when this was
  -- written; a run that enumerated almost none is a broken query, not a clean
  -- database, and must fail loudly rather than report a sweep of nothing.
  if v_examined < 60 then
    raise exception
      'mig 722 vacuity guard: enumerated only % trigger function(s) in public, expected >= 60. Refusing to report a clean sweep of nothing.',
      v_examined;
  end if;

  raise notice
    'mig 722: enumerated % trigger function(s) in public; revoked PUBLIC/anon/authenticated EXECUTE on %; re-granted service_role explicitly on % that had been riding on the PUBLIC grant. Revoked: %',
    v_examined, v_revoked, v_restored,
    coalesce(array_to_string(v_names, ', '), '(none — already clean)');
end $$;

-- ── 2. Assert the RESULT, both directions, against the BEFORE snapshot ───
-- The doctrine's actual teeth. A REVOKE that silently did nothing and a REVOKE
-- that took too much are both invisible from the statement itself.
do $$
declare
  r         record;
  v_checked int    := 0;
  v_bad     text[] := '{}';
begin
  for r in
    select b.fn_oid, b.fn_name, b.had_service_role, b.had_postgres, p.proacl
      from _mig722_before b
      join pg_proc p on p.oid = b.fn_oid
  loop
    v_checked := v_checked + 1;

    -- half one: the ambient roles must hold nothing
    if has_function_privilege('anon', r.fn_oid, 'EXECUTE') then
      v_bad := array_append(v_bad, format('%s: anon STILL holds EXECUTE', r.fn_name));
    end if;
    if has_function_privilege('authenticated', r.fn_oid, 'EXECUTE') then
      v_bad := array_append(v_bad, format('%s: authenticated STILL holds EXECUTE', r.fn_name));
    end if;
    -- a null proacl means the built-in default is in force, i.e. PUBLIC has it
    if r.proacl is null or '=X/postgres' = any(r.proacl::text[]) then
      v_bad := array_append(v_bad, format('%s: PUBLIC STILL holds EXECUTE', r.fn_name));
    end if;

    -- half two, the mig-643 mask: nothing that HELD it may have lost it
    if r.had_service_role
       and not has_function_privilege('service_role', r.fn_oid, 'EXECUTE') then
      v_bad := array_append(v_bad, format('%s: service_role LOST EXECUTE — over-revoked', r.fn_name));
    end if;
    if r.had_postgres
       and not has_function_privilege('postgres', r.fn_oid, 'EXECUTE') then
      v_bad := array_append(v_bad, format('%s: postgres LOST EXECUTE — over-revoked', r.fn_name));
    end if;
  end loop;

  if v_checked < 60 then
    raise exception
      'mig 722 vacuity guard: asserted over only % trigger function(s), expected >= 60.', v_checked;
  end if;
  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception 'mig 722 POST-ASSERT FAILED on % point(s): %',
      array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice
    'mig 722: has_function_privilege re-checked on % trigger function(s) — PUBLIC/anon/authenticated hold EXECUTE on none of them; every role that held EXECUTE before still holds it.',
    v_checked;
end $$;

-- ── 3. DRIVE it: the trigger must still FIRE for a role with no EXECUTE ───
-- Asserting privileges proves the grant is gone. It does NOT prove the machine
-- still works, and "a trigger that silently stopped firing" is this project's
-- reports-success-without-happening class. So: a real table, one of the real
-- functions this migration just revoked (update_updated_at is attached to 56
-- tables — the widest blast radius in the set), driven by the real
-- `authenticated` role, effect read back. It runs on a scratch table so no
-- production row is touched and no RLS is disturbed, and the table is dropped
-- inside the same transaction.
do $$
declare
  v_before timestamptz;
  v_after  timestamptz;
begin
  create table public._mig722_drive (
    id         int primary key,
    updated_at timestamptz not null
  );
  create trigger _mig722_drive_touch
    before update on public._mig722_drive
    for each row execute function public.update_updated_at();
  grant select, insert, update on public._mig722_drive to authenticated;

  insert into public._mig722_drive (id, updated_at) values (1, timestamptz '2000-01-01');
  select updated_at into v_before from public._mig722_drive where id = 1;

  -- the whole point: `authenticated` holds no EXECUTE on update_updated_at now
  if has_function_privilege('authenticated', 'public.update_updated_at()', 'EXECUTE') then
    raise exception 'mig 722 drive: authenticated still holds EXECUTE — this test would prove nothing';
  end if;

  set local role authenticated;
  update public._mig722_drive set id = 1 where id = 1;
  reset role;

  select updated_at into v_after from public._mig722_drive where id = 1;
  if v_after is not distinct from v_before then
    raise exception
      'mig 722 drive: the trigger DID NOT FIRE for `authenticated` after the revoke (updated_at still %). The revoke broke the machinery — roll it back with the GRANTs in the header.',
      v_before;
  end if;

  raise notice
    'mig 722: DRIVEN PROOF — update_updated_at() fired for role `authenticated` holding no EXECUTE (updated_at % -> %).',
    v_before, v_after;

  drop table public._mig722_drive;
end $$;

commit;
