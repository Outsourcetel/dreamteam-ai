-- 830_an_approver_who_is_not_the_requester.sql
-- ============================================================================
-- Task 2 of 7, trust-promotion program (plan: 2026-08-21-trust-promotion).
--
-- WHY: apply_trust_promotion guards with
--   if v_policy.requested_by is not null and auth.uid() = v_policy.requested_by
--   then raise exception 'the requester cannot approve their own promotion...';
-- raise_trust_widening_proposals -- the only writer that has EVER run for
-- real -- always stamps requested_by = NULL. Measured 2026-08-21: the one
-- open trust_promotion proposal in production reads requested_by IS NULL.
-- The guard's `is not null` conjunct has never once been true on a real row,
-- so it has never refused anyone -- not because it is broken, but because no
-- human-requested promotion has ever existed to point it at. This migration
-- is a PROOF, not a change: it changes no logic in apply_trust_promotion.
--
-- ⚠ CORRECTED 2026-08-21, after this task's own earlier draft (before this
-- file existed). An earlier plan for this task said to stamp a sentinel uuid
-- (00000000-0000-0000-0000-000000000000) into requested_by on the automatic
-- path and make a NULL requester a hard refusal. Both are wrong and NEITHER
-- is done here:
--   * the sentinel achieves nothing -- a real approver's auth.uid() is never
--     equal to it, so the guard still refuses nobody, reached by a longer
--     route than NULL was;
--   * scripts/trust-proposer-boundary.mjs:79-84 keys its entire evidence
--     population on `trust_policies.requested_by IS NULL` as the SYSTEM
--     marker (Ring-0 probe trust-proposer-cannot-decide, arms 9/9b/9c/10/11).
--     Replacing NULL with a sentinel, or refusing NULL outright, would empty
--     that probe's denominator to a false "nothing to check" while a real
--     system-raised proposal sat there unexamined.
--
-- So apply_trust_promotion's guard is left byte-for-byte as it is: a
-- machine-raised request has no human self for a self-approval guard to
-- catch, and NULL is the correct, true encoding of "no human asked for
-- this" -- not an escape hatch of the migration-749 shape (that prefix lets
-- a caller who SHOULD be checked skip the check; this one governs a request
-- that structurally has no requester to check). What has never been done is
-- DEMONSTRATING the guard fires on the path it does govern. This migration
-- builds a real human-requested promotion, purely to drive it.
--
-- ⚠ NOT SOLVED HERE, stated so it is not lost: who may approve a
-- SYSTEM-raised promotion (requested_by is null) is unrestrained by this
-- guard -- the null check short-circuits it by design. That is segregation
-- of duties, not self-approval, and belongs to a later task's authority
-- seam. No approver rule is invented here.
--
-- ⚠ DOES NOT DEPEND ON MIGRATION 828. 828 (open_trust_promotion_request,
-- request_eligible_promotions) is committed and pushed but NOT YET APPLIED --
-- confirmed live, 2026-08-21: pg_proc has request_trust_promotion only;
-- schema_migrations has no row for 828. Building this fixture through
-- open_trust_promotion_request would make this migration depend on apply
-- order across two unmerged-in-application migrations. Instead the fixture
-- writes trust_policies/human_tasks directly, in the same shape
-- open_trust_promotion_request would have written (mirroring mig 828's own
-- insert list verbatim), so this migration is correct whether it lands
-- before or after 828.
--
-- ── HOW THE PROOF IS BUILT WITHOUT TOUCHING PRODUCTION DATA ─────────────────
-- No human-requested trust_policies row exists yet. This migration drives
-- one into being for the sole duration of the probe: it discovers a REAL
-- tenant with >= 2 distinct active tenant-layer members (never a fabricated
-- user -- profiles.user_id carries a NOT NULL FK to auth.users and a
-- UNIQUE(user_id), so a synthetic identity cannot be created without a real
-- auth.users row, which this migration will not do -- CLAUDE.md: never
-- forge auth.users). It builds two fixture trust_policies rows scoped to
-- that tenant with criteria relaxed to a DETERMINISTIC "eligible" state (so
-- eligibility does not depend on, and cannot be broken or accidentally
-- satisfied by, that tenant's real eval/human-review/guardrail history),
-- attaches a pending human_tasks row to each with requested_by set to a REAL
-- discovered uid (instead of the null every current writer passes), then
-- drives apply_trust_promotion as two DIFFERENT simulated sessions
-- (set_config('request.jwt.claim.sub', ...) + set local role authenticated,
-- the same idiom migration 741 proved -- never a forged auth.users row, per
-- CLAUDE.md and this task's own brief).
--
-- Every write this probe makes -- both trust_policies rows, both human_tasks
-- rows, the audit_events row apply_trust_promotion writes on the successful
-- control approval, and the de_autonomy row that same approval's
-- trust_apply_level call writes -- is undone before commit. Not by DELETE:
-- audit_events carries audit_events_no_update_delete (BEFORE DELETE OR
-- UPDATE ... EXECUTE FUNCTION audit_events_immutable()), so a cleanup DELETE
-- on that table either fails outright or needs the app.allow_audit_purge
-- escape hatch -- and flipping that on a tamper-evident chain just to make a
-- checker tidy is exactly the audit-log-rewrite anti-pattern this repo has
-- already named and rejected once (project_audit_chain_false_break). Instead
-- the entire fixture lives inside ONE begin/exception block that ends with a
-- deliberate `raise exception ... '__undo_probe_830__'`, caught by nothing
-- but its own handler -- the same idiom migration 741 uses throughout (see
-- its header: "each undone by raising the sentinel '__undo_probe__'").
-- PL/pgSQL's implicit savepoint at that BEGIN unwinds every write back to
-- the instant before the fixture existed; PL/pgSQL variables are not table
-- state and are untouched by that unwind, so the captured results are still
-- available to assert on afterward. No DELETE, no purge flag, no trace --
-- and no dangling hash-chain link either: because the insert and the
-- rollback both happen inside this one uncommitted transaction, no other
-- session can ever see the fixture's audit_events row to chain off it in
-- the first place.
--
-- ⚠ A SIGNATURE NOTE, since the brief's own instruction was to resolve this
-- by reading the code rather than guess. This task's brief sketches the
-- probe calling `apply_trust_promotion(v_policy_id, 'approved', null)` --
-- three arguments, the first being a trust_policies id. Read live (via
-- pg_get_function_arguments, as the brief's Interfaces section itself
-- instructs before using the function): the deployed signature is
-- `apply_trust_promotion(p_task_id uuid, p_decision text)` -- two arguments,
-- and the first is the PENDING human_tasks id
-- (`select ... from trust_policies where pending_task_id = p_task_id`), not
-- the policy id. Treated as illustrative shorthand, not a literal call to
-- reproduce: this migration calls the real two-argument signature with each
-- fixture's pending task id, named v_task_id / v_task_id_2 below so the id
-- it actually is stays visible in the code rather than overloading
-- v_policy_id for two different kinds of id.
--
-- ============================================================================
-- FIX ROUND 1 (coordinator review: spec + quality approved; 3 items)
-- ============================================================================
-- 1. PROMOTED TO IMPORTANT -- this migration installs no schema, so on a
--    database with no qualifying tenant (empty, or one where no tenant has
--    2 active members) the whole probe made ZERO comparisons -- and because
--    db-query.mjs prints only the HTTP response body, RAISE NOTICE never
--    reaches the console either way. A vacuous apply and a real 4-comparison
--    apply were indistinguishable to an operator watching a real apply, and
--    left an identical ledger row. Fixed with a SCHEMA ARM (below, runs
--    first, unconditionally): it asserts, via pg_get_functiondef with
--    comments stripped first (this repo's own convention -- see
--    trust-proposer-boundary.mjs), that apply_trust_promotion's body still
--    contains the self-approval guard's condition AND still raises its exact
--    message. This is a statement about SCHEMA, not data -- true on any
--    database the function exists on, including one with no tenants at all
--    -- so it stays replayable (confirmed again below) and guarantees the
--    denominator is never zero.
--
--    Console legibility on a REAL apply is NOT fully solved, and said so
--    rather than papered over: db-query.mjs's HTTP response body does not
--    carry RAISE NOTICE content (confirmed empirically -- see task-2-report
--    for the raw response of a successful DO block), and no existing
--    convention in this repo surfaces DO-block state through it without
--    RAISE EXCEPTION (searched; none found). RAISE EXCEPTION on the clean
--    path was explicitly rejected -- it would make a genuine pass indistin-
--    guishable from a genuine failure at the transaction-outcome level,
--    which is worse than the problem it would fix. So: the schema arm
--    guarantees the denominator is structurally never zero, but an operator
--    watching only db-query.mjs's console output still cannot SEE the count
--    on a clean run without a real psql/terminal session. Both facts are
--    true at once and both are stated, not blended into one.
--
-- 2. Minor -- PROBE 1's "refused for the right reason" check was a loose
--    ilike '%approver%'/'%requester%' substring match. Replaced with an
--    EXACT match against the guard's literal message (v_guard_message,
--    declared once and shared with the schema arm's presence check below),
--    fetched byte-for-byte from pg_proc.prosrc via JSON parsing (not
--    retyped from memory) to guarantee the pin and the live text agree.
--
-- 3. Minor -- the header above (see "DOES NOT DEPEND ON MIGRATION 828")
--    overstated the human_tasks insert as matching mig 828's writer
--    "verbatim". It does not: this fixture's insert omits the `id` column
--    (letting it default) and ADDS `origin = 'exercise'`, which 828's writer
--    does not set (human_tasks.origin defaults to 'production'). That is a
--    deliberate improvement, not an oversight: evidence_is_production('exer
--    cise') is false, so trust_evidence_for cannot count these fixture rows
--    as evidence for any OTHER policy during the brief window they exist.
--    Corrected here rather than left to mislead the next reader; full
--    credit for the choice is in task-2-report.md.
-- ============================================================================

begin;

do $verify$
declare
  v_tenant             uuid;
  v_requester          uuid;
  v_other_user         uuid;
  v_user_ids           uuid[];
  v_checks             int := 0;
  v_bad                text[] := '{}';
  v_ran                boolean := false;
  v_criteria           jsonb := jsonb_build_object(
                           'min_eval_samples', 0, 'min_eval_pass_rate', 0,
                           'min_human_samples', 0, 'min_human_approval_rate', 0,
                           'max_guardrail_blocks', 2000000000);

  v_policy_id          uuid;
  v_policy_id_2        uuid;
  v_task_id            uuid;
  v_task_id_2          uuid;
  v_policy_row         public.trust_policies;
  v_evidence           jsonb;
  v_evidence_2         jsonb;

  v_p1_raised          boolean := false;
  v_p1_err             text;
  v_p1_result          jsonb;

  v_ctrl_raised        boolean := false;
  v_ctrl_err           text;
  v_ctrl_result        jsonb;
  v_ctrl_level_before  int;
  v_ctrl_level_after   int;
  v_ctrl_pending_after uuid;

  -- FIX ROUND 1: the guard's exact literal, fetched byte-for-byte from
  -- pg_proc.prosrc at task time (not retyped), shared by the schema arm
  -- (presence check) and PROBE 1 (exact-match refusal check) so there is
  -- exactly one place this text is spelled out.
  v_guard_message      text := 'the requester cannot approve their own promotion — a different teammate must approve';
  v_fn_src             text;
begin
  ------------------------------------------------------------------
  -- SCHEMA ARM (FIX ROUND 1) -- runs UNCONDITIONALLY, independent of any
  -- data, BEFORE tenant discovery. This is what guarantees the denominator
  -- is never zero: apply_trust_promotion predates this migration (it must
  -- already exist for this migration to mean anything), so this comparison
  -- is available on EVERY database this migration can run against --
  -- including one with no tenants at all, where it is the ONLY comparison
  -- made. Comments are stripped first so the check cannot match its own
  -- prose in a comment rather than the live guard (this repo's convention --
  -- see trust-proposer-boundary.mjs's live_fns CTE).
  ------------------------------------------------------------------
  v_checks := v_checks + 1;
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g')
    into v_fn_src
    from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'apply_trust_promotion';

  if v_fn_src is null then
    v_bad := array_append(v_bad, 'SCHEMA ARM: public.apply_trust_promotion does not exist on this database -- nothing below can be governed by a guard that was never installed.');
  else
    if v_fn_src !~ 'requested_by\s+is\s+not\s+null\s+and\s+auth\.uid\(\)\s*=\s*v_policy\.requested_by' then
      v_bad := array_append(v_bad, 'SCHEMA ARM: apply_trust_promotion no longer tests "requested_by is not null and auth.uid() = requested_by" -- the self-approval guard''s condition is gone or was rewritten.');
    end if;
    if position(v_guard_message in v_fn_src) = 0 then
      v_bad := array_append(v_bad, format('SCHEMA ARM: apply_trust_promotion no longer raises the guard''s exact message (%s) -- PROBE 1''s exact-match check below would be comparing against dead text.', v_guard_message));
    end if;
  end if;

  -- ── discover a real tenant with >= 2 distinct active tenant-layer
  -- members. Never a hardcoded id (CLAUDE.md): on an empty database, or one
  -- where no tenant has two active members, PROBE 1 and CONTROL below are
  -- vacuous and say so rather than failing -- the schema arm above already
  -- ran and is NOT vacuous either way.
  select p.tenant_id
    into v_tenant
    from public.profiles p
    join public.tenants t on t.id = p.tenant_id
   where p.layer = 'tenant'
     and coalesce(p.is_active, true)
     and t.status in ('active', 'trial')
   group by p.tenant_id
  having count(distinct p.user_id) >= 2
   order by p.tenant_id
   limit 1;

  if v_tenant is not null then
    select array_agg(x.user_id order by x.user_id) into v_user_ids
      from (
        select distinct p.user_id
          from public.profiles p
         where p.tenant_id = v_tenant
           and p.layer = 'tenant'
           and coalesce(p.is_active, true)
         order by p.user_id
         limit 2
      ) x;
    v_requester  := v_user_ids[1];
    v_other_user := v_user_ids[2];
  end if;

  if v_tenant is null or v_requester is null or v_other_user is null then
    raise notice '830: VACUITY -- no tenant with 2 distinct active tenant-layer members exists on this database. PROBE 1 and CONTROL make ZERO comparisons on this dataset -- true, and the honest result, on an empty database, not a manufactured pass. The schema arm above already ran and is NOT vacuous: it is comparable on any database where apply_trust_promotion exists, so the total denominator below is 1, never 0.';
  else
    v_ran := true;

    begin
      ------------------------------------------------------------------
      -- FIXTURE -- two policies, same tenant, same real human requester.
      -- criteria is relaxed so eligibility is DETERMINISTIC: it cannot be
      -- broken by this tenant's real eval/human-review history, nor
      -- accidentally satisfied by it either (see trust_evidence_for).
      -- de_id left null (tenant-scoped) so no digital_employees row is
      -- needed. action_category is a probe-only string that cannot collide
      -- with a real policy's category.
      ------------------------------------------------------------------
      insert into public.trust_policies
        (tenant_id, de_id, action_category, current_level, max_level, status, criteria)
      values
        (v_tenant, null, 'zz_probe_830_selfapproval', 0, 3, 'active', v_criteria)
      returning id into v_policy_id;

      insert into public.trust_policies
        (tenant_id, de_id, action_category, current_level, max_level, status, criteria)
      values
        (v_tenant, null, 'zz_probe_830_control', 0, 3, 'active', v_criteria)
      returning id into v_policy_id_2;

      select * into v_policy_row from public.trust_policies where id = v_policy_id;
      v_evidence := public.trust_evidence_for(v_policy_row);
      select * into v_policy_row from public.trust_policies where id = v_policy_id_2;
      v_evidence_2 := public.trust_evidence_for(v_policy_row);

      v_checks := v_checks + 1;
      if not coalesce((v_evidence->>'eligible')::boolean, false)
         or not coalesce((v_evidence_2->>'eligible')::boolean, false) then
        v_bad := array_append(v_bad, format(
          'FIXTURE BUG: the engineered-eligible criteria did not produce eligible:true (arm1=%s, arm2=%s) -- neither probe below can be trusted until this is fixed',
          v_evidence->>'eligible', v_evidence_2->>'eligible'));
      end if;

      -- ── attach a HUMAN-requested pending promotion to each, in the same
      -- shape open_trust_promotion_request (mig 828, not yet applied -- see
      -- header) would write: a pending trust_promotion human_tasks row,
      -- linked back via trust_policies.pending_task_id, with requested_by
      -- set to a REAL uid instead of the null every writer that exists
      -- TODAY passes.
      insert into public.human_tasks
        (tenant_id, type, title, detail, source, related_table, related_id, status, origin)
      values
        (v_tenant, 'trust_promotion', 'Trust promotion — probe 830 (self-approval arm)',
         'Fixture for migration 830 -- proves apply_trust_promotion''s self-approval guard. Rolled back before commit.',
         'system', 'trust_policies', v_policy_id, 'pending', 'exercise')
      returning id into v_task_id;

      update public.trust_policies
         set pending_task_id = v_task_id, pending_evidence = v_evidence,
             requested_by = v_requester, requested_at = now()
       where id = v_policy_id;

      insert into public.human_tasks
        (tenant_id, type, title, detail, source, related_table, related_id, status, origin)
      values
        (v_tenant, 'trust_promotion', 'Trust promotion — probe 830 (control arm)',
         'Fixture for migration 830 -- proves a non-requester CAN approve. Rolled back before commit.',
         'system', 'trust_policies', v_policy_id_2, 'pending', 'exercise')
      returning id into v_task_id_2;

      update public.trust_policies
         set pending_task_id = v_task_id_2, pending_evidence = v_evidence_2,
             requested_by = v_requester, requested_at = now()
       where id = v_policy_id_2;

      ------------------------------------------------------------------
      -- PROBE 1 -- a self-approval is refused. v_requester, who requested
      -- v_task_id, tries to approve the very thing they requested.
      ------------------------------------------------------------------
      v_checks := v_checks + 1;
      begin
        perform set_config('request.jwt.claim.sub', v_requester::text, true);
        set local role authenticated;
        v_p1_result := public.apply_trust_promotion(v_task_id, 'approved');
        reset role;
        -- no exception: the call returned instead of refusing.
      exception when others then
        reset role;
        v_p1_raised := true;
        v_p1_err := sqlerrm;
      end;

      if v_p1_raised then
        -- FIX ROUND 1: exact match against the guard's literal message
        -- (shared with the schema arm above), not a loose substring test.
        -- A future message containing "approver" or "requester" for an
        -- unrelated reason would have silently passed the old check.
        if v_p1_err is distinct from v_guard_message then
          v_bad := array_append(v_bad, format('PROBE 1 refused for the WRONG reason: %s (expected exactly: %s)', v_p1_err, v_guard_message));
        end if;
      elsif coalesce((v_p1_result->>'applied')::boolean, false) then
        v_bad := array_append(v_bad, format(
          'PROBE 1: self-approval SUCCEEDED -- the requester approved their own promotion (result: %s)', v_p1_result));
      else
        -- No exception AND applied is not true: apply_trust_promotion's
        -- only non-raising false path is "no_pending_policy" (task id did
        -- not resolve). That is a FIXTURE bug, not a fact about the guard --
        -- reported as its own thing rather than folded into either verdict.
        v_bad := array_append(v_bad, format(
          'PROBE 1 setup bug: apply_trust_promotion returned %s without raising -- the guard was never reached (task id likely did not resolve)', v_p1_result));
      end if;

      ------------------------------------------------------------------
      -- CONTROL -- a DIFFERENT approver, on a SEPARATE fixture requested by
      -- the SAME person, must succeed. Required, not optional: a refusal
      -- here means PROBE 1's refusal proves nothing, because nobody could
      -- ever approve a human-requested promotion at all.
      ------------------------------------------------------------------
      v_checks := v_checks + 1;
      select current_level into v_ctrl_level_before from public.trust_policies where id = v_policy_id_2;

      begin
        perform set_config('request.jwt.claim.sub', v_other_user::text, true);
        set local role authenticated;
        v_ctrl_result := public.apply_trust_promotion(v_task_id_2, 'approved');
        reset role;
      exception when others then
        reset role;
        v_ctrl_raised := true;
        v_ctrl_err := sqlerrm;
      end;

      select current_level, pending_task_id into v_ctrl_level_after, v_ctrl_pending_after
        from public.trust_policies where id = v_policy_id_2;

      if v_ctrl_raised then
        v_bad := array_append(v_bad, format(
          'CONTROL FAILED: a non-requester could not approve either (%s) -- PROBE 1''s refusal above proves nothing', v_ctrl_err));
      elsif coalesce((v_ctrl_result->>'applied')::boolean, false) is not true then
        -- Not an exception, but not a real promotion either -- a silent
        -- {"applied":false} no-op would pass a naive "no exception raised"
        -- check while proving nothing. Caught here instead.
        v_bad := array_append(v_bad, format(
          'CONTROL did not raise but did not apply either: %s -- a silent no-op is not a successful approval', v_ctrl_result));
      elsif v_ctrl_level_after is distinct from v_ctrl_level_before + 1 or v_ctrl_pending_after is not null then
        v_bad := array_append(v_bad, format(
          'CONTROL reported applied:true but the row disagrees -- level %s -> %s (expected +1), pending_task_id now %s (expected null)',
          v_ctrl_level_before, v_ctrl_level_after, v_ctrl_pending_after));
      end if;

      -- ── undo everything since the outer BEGIN: both trust_policies rows,
      -- both human_tasks rows, the audit_events row(s) apply_trust_promotion
      -- wrote, and the de_autonomy row the control approval's
      -- trust_apply_level call wrote. v_bad/v_checks/v_p1_*/v_ctrl_* are
      -- PL/pgSQL variables, not table state, and survive this unwind
      -- untouched -- see header for why this is the only safe way to undo
      -- an insert into an immutable audit_events.
      raise exception using errcode = 'P0001', message = '__undo_probe_830__';
    exception
      when sqlstate 'P0001' then
        reset role;
        if sqlerrm <> '__undo_probe_830__' then raise; end if;
    end;
  end if;

  ----------------------------------------------------------------------
  if array_length(v_bad, 1) > 0 then
    raise exception E'830 VERIFICATION FAILED (% assertion(s), tenant %):\n  %',
      v_checks, v_tenant, array_to_string(v_bad, E'\n  ');
  end if;

  if v_ran then
    raise notice '830: % assertion(s) compared, 0 findings (1 schema-level + 3 data-level: fixture sanity, PROBE 1, CONTROL). tenant=%, requester=%, other_approver=%. PROBE 1 task=% raised=% message=%. CONTROL task=% result=% level_before=% level_after=% pending_after=%. Both fixtures and every row either write touched (trust_policies x2, human_tasks x2, audit_events, de_autonomy) were rolled back inside the probe via the __undo_probe_830__ sentinel -- nothing committed by this migration beyond this notice. NOTE: db-query.mjs does not surface RAISE NOTICE -- this line is not visible on a real apply; see task-2-report.md.',
      v_checks, v_tenant, v_requester, v_other_user,
      v_task_id, v_p1_raised, v_p1_err,
      v_task_id_2, v_ctrl_result, v_ctrl_level_before, v_ctrl_level_after, v_ctrl_pending_after;
  else
    raise notice '830: % assertion(s) compared, 0 findings -- SCHEMA ARM ONLY. No tenant with 2 distinct active tenant-layer members existed to drive PROBE 1 / CONTROL on this dataset, so those made zero comparisons (vacuously fine -- see the VACUITY notice above). NOT the same claim as the "1 schema-level + 3 data-level" line above for a dataset with a qualifying tenant.',
      v_checks;
  end if;
end;
$verify$;

commit;
