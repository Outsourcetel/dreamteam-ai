-- 828_eligibility_can_ask_for_itself.sql
-- ============================================================================
-- Task 1 of 7, trust-promotion program (plan: 2026-08-21-trust-promotion).
--
-- WHY: 66 trust_policies exist; 0 have ever been promoted past level 0.
-- Measured 2026-08-21: 2 policies report eligible:true, both action_execute,
-- on different employees in tenant 5bb802e1-8e92-4eef-9a7a-ac348785d43f -- and
-- detect_trust_widening_patterns returns 0 candidates for that same tenant.
-- Eligibility (trust_evidence_for's criteria are met) and proposability
-- (does anything ASK about it) are different tests, and nothing bridges them:
-- an eligible policy sits there, un-asked-about, forever.
--
-- Founder ruling (2026-08-21): an eligible policy raises a request even with
-- NO approved-action history, and the request must carry how thin the
-- evidence is. No history threshold is added here.
--
-- ── Step 2 signatures, verbatim ─────────────────────────────────────────────
--   request_trust_promotion(p_policy_id uuid) -> jsonb
--   trust_evidence_for(p_policy trust_policies) -> jsonb
--
-- ============================================================================
-- ROUND 1 (superseded design, kept for the record -- do not rebuild this)
-- ============================================================================
-- request_trust_promotion takes ONE argument, not (uuid, jsonb) as the task
-- brief assumed. Reading its BODY (not just its signature, per Step 2's own
-- instruction) found a second, deeper problem: it is a USER-FACING action,
-- not a system-safe one. Its first gate after finding the policy is
--
--   if not exists (select 1 from profiles
--                   where user_id = auth.uid() and tenant_id = v_policy.tenant_id)
--   then raise exception 'not a member of this tenant';
--
-- with NO service_role or system-caller branch anywhere in its body. auth.uid()
-- and auth.role() both read request.jwt.claims, which is empty for ANY caller
-- with no end-user JWT -- confirmed empirically: `select auth.uid(), auth.role()`
-- both null under db-query.mjs, and calling request_trust_promotion on the one
-- live eligible/task-free policy raised 'not a member of this tenant' every
-- time. Round 1 wrapped that call per-row so one refusal couldn't abort the
-- whole sweep, which was the right instinct but the wrong callee -- verified
-- independently by the coordinator, below.
--
-- ============================================================================
-- ROUND 2 (this version) -- the coordinator's measurement, verbatim
-- ============================================================================
--   request_trust_promotion(p_policy_id uuid)   membership guard: YES  system path: NO
--   raise_trust_widening_proposals()             calls request_trust_promotion: NO
--                                                 updates trust_policies directly: YES
--                                                 inserts human_tasks directly: YES
--
-- request_trust_promotion is the HUMAN path (runs on a browser session, via
-- PostgREST, with a real JWT). raise_trust_widening_proposals is the SYSTEM
-- path: it runs unattended from the daily cron (granted to `service_role` and
-- a dedicated `trust_pattern_proposer` role -- confirmed via
-- information_schema.role_routine_grants -- and OWNED by trust_pattern_proposer,
-- confirmed via pg_proc.proowner), and it opens a trust_promotion human_tasks
-- row and stamps trust_policies directly, with no membership check at all.
-- That -- not request_trust_promotion -- is the callee an unattended sweep
-- belongs on, and it already exists. request_trust_promotion is still not
-- called anywhere in this file.
--
-- ── DO NOT BECOME A THIRD WRITER ────────────────────────────────────────────
-- There were already two paths that open a trust-promotion request (the human
-- RPC and the daily sweep); migration 755 had to unpick exactly this kind of
-- divergence between list_de_trust_surface and decide_action_execution once
-- already. So the write path is factored out ONCE --
-- public.open_trust_promotion_request(...) -- and BOTH
-- raise_trust_widening_proposals (refactored below, CREATE OR REPLACE, same
-- signature, same owner/grants -- Postgres preserves both across REPLACE) and
-- request_eligible_promotions call it. Nothing about raise_trust_widening_
-- proposals' visible behaviour changes: same human_tasks columns, same
-- trust_policies columns, same dedupe-within-a-sweep loop (kept where it was,
-- since detect_trust_widening_patterns -- its candidate source -- can return
-- the same policy_id twice; trust_policies, my candidate source, cannot),
-- same title/detail/audit text verbatim (still built by
-- raise_trust_widening_proposals itself and PASSED IN -- the two callers'
-- evidence shapes are different enough that the human-readable text cannot be
-- generated generically without silently changing what either one says).
-- The task id was previously generated by the caller and reused when building
-- the audit metadata; the shared writer now generates it and merges
-- `task_id` into whatever metadata jsonb the caller passed, so neither
-- caller needs to pre-allocate it.
--
-- open_trust_promotion_request takes (p_tenant_id uuid, p_policy_id uuid, ...)
-- rather than the coordinator's suggested `p_policy trust_policies` -- adapted
-- deliberately: the writer's body only ever needs .tenant_id and .id, and
-- raise_trust_widening_proposals' loop variable is a detect_trust_widening_
-- patterns row, not a trust_policies row, so a row-typed parameter would have
-- forced a brand new SELECT that the original code never did. Two scalars
-- move the code as it was; a row type would have improved it.
--
-- open_trust_promotion_request is SECURITY INVOKER, not DEFINER, and this is
-- also a deliberate departure from the suggested shape, for a reason found
-- while wiring the grants: append_audit_event_internal, detect_trust_widening_
-- patterns and refresh_approval_briefs_internal are each granted individually
-- to `trust_pattern_proposer` (this project's `postgres` role is NOT
-- rolsuper, confirmed via pg_roles, so nothing here is free) -- but
-- refresh_approval_briefs_internal is granted to trust_pattern_proposer and
-- service_role and NOT to postgres. A DEFINER writer owned by postgres would
-- have silently traded "raise_trust_widening_proposals' advisory brief
-- refresh succeeds" for "it fails closed, swallowed by the existing `when
-- others then null` guard" -- legal, but not EXACT, and exactly the kind of
-- quiet regression this refactor must not introduce. INVOKER means the writer
-- runs as whichever already-privileged role called it (postgres, which
-- rolbypassrls, for request_eligible_promotions; trust_pattern_proposer,
-- unchanged, for raise_trust_widening_proposals -- both already do these
-- exact writes today, directly), so no new grant is required anywhere except
-- EXECUTE on the writer function itself, which IS explicitly granted below
-- to postgres, service_role and trust_pattern_proposer (confirmed members:
-- postgres is a member of trust_pattern_proposer via pg_auth_members).
--
-- ── requested_by: sentinel, not NULL (coordinator instruction) ─────────────
-- raise_trust_widening_proposals previously stamped `requested_by = null`
-- with a comment reading "NULL requested_by = system-raised". That is true
-- today but fragile: apply_trust_promotion's self-approval guard is
--   if requested_by is not null and auth.uid() = requested_by then <deny>
-- and NULL makes the whole condition short-circuit false, so the guard is a
-- silent no-op for every machine-raised request -- ANY approver qualifies,
-- not because that was decided anywhere, but because NULL happens to defeat
-- an `is not null` check. Task 2 of this program ("approver who is not the
-- requester") exists to decide the real rule; this migration does not
-- change apply_trust_promotion and does not decide that rule. It only stops
-- deciding it BY ACCIDENT: open_trust_promotion_request coalesces a NULL
-- p_requested_by to the sentinel 00000000-0000-0000-0000-000000000000, a
-- uuid no real auth.users row will ever hold, so `auth.uid() = requested_by`
-- still can never be true -- TODAY's approval outcome is bit-for-bit
-- unchanged -- but the column now carries a positive, greppable marker
-- ("machine-raised") for Task 2 to key a real rule off, instead of an
-- absence that also means "old data" or "a bug". Both callers still pass
-- NULL at the call site (raise_trust_widening_proposals unchanged, in
-- keeping with "move the code, don't improve it"); the sentinel lives in
-- exactly one place, the writer, so it can't drift between callers.
--
-- ── what request_eligible_promotions still does ─────────────────────────────
-- Sweeps active trust_policies, computes trust_evidence_for per policy, skips
-- anything not eligible or already carrying an open task, and calls
-- open_trust_promotion_request for the rest -- wrapped per-row (not a bare,
-- unguarded call) because a single bad row must not cost every OTHER
-- eligible policy, across every OTHER tenant, its own chance to be asked;
-- that robustness argument does not depend on which function is being
-- called and is kept from round 1. `examined`, `requested`,
-- `skipped_existing` and `thin` keep exactly their brief-specified meaning;
-- `failed`/`failures` remain as defensive, additive accounting for a genuine
-- write failure (a constraint violation, a data anomaly) -- on today's data
-- this is expected to be exactly 0, now that the right callee is wired in.
-- `thin` is still counted only in the success branch, per the founder's
-- ruling that a raised request carries its own thinness -- a request that
-- was never opened carries nothing.
-- ============================================================================

begin;

-- ── the shared writer ───────────────────────────────────────────────────────
create or replace function public.open_trust_promotion_request(
  p_tenant_id       uuid,
  p_policy_id       uuid,
  p_evidence        jsonb,
  p_requested_by    uuid,
  p_title           text,
  p_detail          text,
  p_actor           text,
  p_audit_action    text,
  p_audit_metadata  jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_task uuid := gen_random_uuid();
  -- Never NULL for a machine-raised request -- see header. Both current
  -- callers pass p_requested_by = null; this is the one place that becomes
  -- the sentinel, so it cannot drift between them.
  v_requested_by uuid := coalesce(p_requested_by, '00000000-0000-0000-0000-000000000000'::uuid);
begin
  insert into human_tasks (id, tenant_id, type, title, detail, source, related_table, related_id, status)
  values (v_task, p_tenant_id, 'trust_promotion', p_title, p_detail,
          'system', 'trust_policies', p_policy_id, 'pending');

  update trust_policies
     set pending_task_id = v_task,
         pending_evidence = p_evidence,
         requested_by = v_requested_by,
         requested_at = now()
   where id = p_policy_id;

  perform public.append_audit_event_internal(
    p_tenant_id, p_actor, 'system', p_audit_action, 'config_change',
    p_audit_metadata || jsonb_build_object('task_id', v_task));

  -- Advisory overlay -- its failure must never cost the proposal. Verbatim
  -- from raise_trust_widening_proposals, relocated unchanged (comment and
  -- all): mig 705's AFTER INSERT trigger wrote a provisional brief BEFORE
  -- the policy linkage existed (same statement, earlier moment); refresh it
  -- now so the stored brief is right from birth.
  begin
    perform public.refresh_approval_briefs_internal(p_tenant_id);
  exception when others then
    null;
  end;

  return v_task;
end;
$function$;

revoke all on function public.open_trust_promotion_request(uuid, uuid, jsonb, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.open_trust_promotion_request(uuid, uuid, jsonb, uuid, text, text, text, text, jsonb) to postgres, service_role, trust_pattern_proposer;

-- ── the eligibility sweep (this task's produced interface) ─────────────────
create or replace function public.request_eligible_promotions(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_examined  int := 0;
  v_requested int := 0;
  v_skipped   int := 0;
  v_thin      int := 0;
  v_failed    int := 0;
  v_failures  jsonb := '[]'::jsonb;
  v_p         public.trust_policies;
  v_ev        jsonb;
  v_label     text;
  v_task      uuid;
begin
  for v_p in
    select * from public.trust_policies
    where status = 'active'
      and (p_tenant_id is null or tenant_id = p_tenant_id)
  loop
    v_examined := v_examined + 1;
    v_ev := public.trust_evidence_for(v_p);

    if not coalesce((v_ev->>'eligible')::boolean, false) then
      continue;
    end if;

    if v_p.pending_task_id is not null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_label := replace(v_p.action_category, '_', ' ');

    begin
      v_task := public.open_trust_promotion_request(
        v_p.tenant_id, v_p.id, v_ev, null,
        format('Trust promotion — %s to level %s', v_label, v_p.current_level + 1),
        format('Evidence met all criteria: %s. Approving widens autonomy one step — still capped by guardrails.',
          (select string_agg(x->>'detail', ' · ') from jsonb_array_elements(v_ev->'criteria') x)),
        'Trust engine',
        format('Trust promotion requested — %s level %s -> %s (evidence eligible; raised automatically by the eligibility sweep, no human requested it)',
          v_label, v_p.current_level, v_p.current_level + 1),
        jsonb_build_object('kind', 'trust_promotion_requested', 'policy_id', v_p.id,
          'action_category', v_p.action_category, 'from_level', v_p.current_level,
          'to_level', v_p.current_level + 1, 'requested_by', null, 'evidence', v_ev,
          'raised_by', 'request_eligible_promotions')
      );
      v_requested := v_requested + 1;

      -- ⚠ THIN EVIDENCE IS RAISED, NOT SUPPRESSED (founder ruling 2026-08-21).
      -- A policy whose criteria require no human samples is eligible on an
      -- empty record. That request is still raised, and pending_evidence
      -- carries the count so the card can say so. Suppressing it here would
      -- re-create the deadlock this function exists to break. Counted only
      -- on the success branch: this is "how thin was a RAISED request's
      -- evidence", not "how thin was an attempt".
      if coalesce((v_ev->>'corroborated_refusals')::int, 0) = 0
         and coalesce((v_ev->'criteria'->0->>'actual')::numeric, 0) = 0 then
        v_thin := v_thin + 1;
      end if;
    exception when others then
      -- Defensive, not expected: a genuine write failure (constraint
      -- violation, data anomaly) on ONE policy must not cost every OTHER
      -- tenant's eligible policy its own chance to be asked, so the loop
      -- continues and the failure is recorded by policy/tenant/reason
      -- rather than silently folded into a lower "requested" count.
      v_failed := v_failed + 1;
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'policy_id', v_p.id, 'tenant_id', v_p.tenant_id,
        'action_category', v_p.action_category, 'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object(
    'examined', v_examined, 'requested', v_requested,
    'skipped_existing', v_skipped, 'thin', v_thin,
    'failed', v_failed, 'failures', v_failures);
end;
$function$;

revoke all on function public.request_eligible_promotions(uuid) from public, anon, authenticated;

-- ── raise_trust_widening_proposals: refactored to call the shared writer ───
-- Same signature (p_tenant_id uuid default null) -> Postgres preserves this
-- function's existing owner (trust_pattern_proposer) and existing grants
-- (service_role, trust_pattern_proposer) across CREATE OR REPLACE; neither
-- is re-stated here. Every line of behaviour before the write step --
-- the detect_trust_widening_patterns loop, the v_done dedupe-within-a-sweep
-- guard, the v_title/v_detail composition, the audit action text and its
-- metadata shape -- is byte-for-byte the original. Only the insert/update/
-- audit-call/refresh-call block is replaced with one call to the writer.
create or replace function public.raise_trust_widening_proposals(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  r         record;
  v_task    uuid;
  v_title   text;
  v_detail  text;
  v_lines   text;
  v_examined integer := 0;
  v_raised   integer := 0;
  v_tasks    uuid[] := '{}';
  v_done     uuid[] := '{}';
begin
  for r in select * from public.detect_trust_widening_patterns(p_tenant_id) loop
    v_examined := v_examined + 1;
    -- One open proposal per policy, even when two action groups map to the
    -- same ladder in a single sweep.
    if r.policy_id = any(v_done) then continue; end if;
    v_done := v_done || r.policy_id;

    select string_agg(format('- %s, approved by %s. Receipt: %s',
             to_char((d->>'decided_at')::timestamptz, 'YYYY-MM-DD'),
             d->>'decided_by_name',
             coalesce(d->>'receipt', '(none)')), e'\n' order by d->>'decided_at')
      into v_lines
      from jsonb_array_elements(r.evidence->'pattern'->'decisions') d;

    v_title := left(format('Trust proposal — %s: "%s" approved and landed %s times; widen to level %s',
                 r.de_name, coalesce(r.action_label, r.action_key), r.n_approved, r.proposed_level), 300);

    v_detail :=
      format('A human said yes to the same thing %s times. %s asked to run "%s" and a person approved it '
             || 'on every occasion between %s and %s — each run was carried out and LANDED (receipts below), '
             || 'zero rejections, nothing rolled back, production work only (exam activity never counts).',
             r.n_approved, r.de_name, coalesce(r.action_label, r.action_key),
             to_char(r.first_decided, 'YYYY-MM-DD'), to_char(r.last_decided, 'YYYY-MM-DD'))
      || e'\n\n' || v_lines
      || e'\n\n'
      || format('Approving widens ONE dial through the existing trust machinery: "%s" moves from level %s to level %s '
             || '(proposed settings: %s). The evidence is re-verified at the moment of approval and the request is '
             || 'refused if it has gone stale; automatic demotion (a guardrail block or an evaluation regression) '
             || 'can take the widened level away at any time. Rejecting keeps everything gated exactly as today, '
             || 'and this proposal will NOT be re-raised until the full pattern re-accumulates from scratch after '
             || 'this decline. Raised automatically by the trust pattern detector — no human requested it.',
             r.policy_category, r.current_level, r.proposed_level,
             coalesce((r.evidence->'dial'->'proposed_settings')::text, '(defaults)'));

    -- mig 828: relocated to the shared writer (open_trust_promotion_request).
    -- Everything above this line, and the text passed into it, is unchanged.
    v_task := public.open_trust_promotion_request(
      r.tenant_id, r.policy_id, r.evidence, null,
      v_title, v_detail,
      'Trust pattern detector',
      format('Trust-widening proposal raised — %s identical landed approvals of "%s" by %s; "%s" level %s -> %s awaits a human decision',
             r.n_approved, coalesce(r.action_label, r.action_key), r.de_name,
             r.policy_category, r.current_level, r.proposed_level),
      jsonb_build_object('kind', 'trust_widening_proposed',
        'policy_id', r.policy_id, 'de_id', r.de_id,
        'action_key', r.action_key, 'n_approved', r.n_approved,
        'from_level', r.current_level, 'to_level', r.proposed_level,
        'evidence', r.evidence)
    );

    v_raised := v_raised + 1;
    v_tasks := v_tasks || v_task;
  end loop;

  return jsonb_build_object('examined', v_examined, 'raised', v_raised,
                            'task_ids', to_jsonb(v_tasks));
end $function$;

-- ── verification ────────────────────────────────────────────────────────
do $verify$
declare
  v_bad                text[] := '{}';
  v_checks             int := 0;
  v_res                jsonb;
  v_widen_res          jsonb;
  v_eligible_before    int;
  v_skip_expected      int;
  v_examined_expected  int;
  v_target_ids         uuid[];
  v_linked             int;
  v_tasks_before        bigint;
  v_tasks_after         bigint;
begin
  select count(*) into v_examined_expected
  from public.trust_policies where status = 'active';

  -- PROBEs 1/3's denominator: an eligible policy with no open task, captured
  -- BEFORE the sweep runs (so PROBE 3 below can prove causation, not just
  -- correlation -- these are the exact rows whose pending_task_id must both
  -- change AND resolve to a real, matching human_tasks row).
  select array_agg(p.id), count(*)
    into v_target_ids, v_eligible_before
  from public.trust_policies p
  where (public.trust_evidence_for(p)->>'eligible')::boolean
    and p.pending_task_id is null;

  select count(*) into v_skip_expected
  from public.trust_policies p
  where (public.trust_evidence_for(p)->>'eligible')::boolean
    and p.pending_task_id is not null;

  select count(*) into v_tasks_before
  from public.human_tasks where type = 'trust_promotion';

  ----------------------------------------------------------------------
  -- PROBE 1 -- every active policy is examined, exactly once.
  ----------------------------------------------------------------------
  v_res := public.request_eligible_promotions(null);

  v_checks := v_checks + 1;
  if coalesce((v_res->>'examined')::int, -1) <> v_examined_expected then
    v_bad := array_append(v_bad, format(
      'examined %s active policies, expected %s', v_res->>'examined', v_examined_expected));
  end if;

  ----------------------------------------------------------------------
  -- PROBE 2 -- an eligible policy that ALREADY has an open task is
  -- skipped, never re-requested.
  ----------------------------------------------------------------------
  v_checks := v_checks + 1;
  if coalesce((v_res->>'skipped_existing')::int, -1) <> v_skip_expected then
    v_bad := array_append(v_bad, format(
      'skipped_existing %s, expected %s', v_res->>'skipped_existing', v_skip_expected));
  end if;

  ----------------------------------------------------------------------
  -- PROBE 3 -- IT RAISES ONE. Denominator stated: with v_eligible_before
  -- eligible-without-a-task policies today (measured: 1), expect exactly
  -- that many requested, zero failed, and -- the part round 1 could not
  -- get past -- a REAL human_tasks row for each, that did not exist before,
  -- linked back from trust_policies.pending_task_id. Vacuously fine on an
  -- empty database: 0 = 0 and an empty array joins to nothing.
  ----------------------------------------------------------------------
  if v_eligible_before = 0 then
    raise notice '828 PROBE 3: denominator is 0 -- the requested/linkage comparisons below are vacuous on this dataset.';
  end if;

  v_checks := v_checks + 1;
  if coalesce((v_res->>'requested')::int, 0) <> v_eligible_before
     or coalesce((v_res->>'failed')::int, 0) <> 0 then
    v_bad := array_append(v_bad, format(
      'requested %s of %s eligible-without-a-task policies, failed %s -- expected all requested, none failed',
      v_res->>'requested', v_eligible_before, v_res->>'failed'));
  end if;

  -- 3b: not just a counter -- a real, correctly-typed, correctly-linked row.
  select count(*) into v_linked
  from public.trust_policies p
  join public.human_tasks t
    on t.id = p.pending_task_id
   and t.type = 'trust_promotion'
   and t.status = 'pending'
   and t.related_table = 'trust_policies'
   and t.related_id = p.id
  where p.id = any(v_target_ids);

  v_checks := v_checks + 1;
  if v_linked <> coalesce(array_length(v_target_ids, 1), 0) then
    v_bad := array_append(v_bad, format(
      '%s of %s targeted policies have a linked, pending trust_promotion human_tasks row -- expected all',
      v_linked, coalesce(array_length(v_target_ids, 1), 0)));
  end if;

  -- 3c: literally what was asked -- a row exists after that did not exist
  -- before, counted independently of the linkage check above.
  select count(*) into v_tasks_after
  from public.human_tasks where type = 'trust_promotion';

  v_checks := v_checks + 1;
  if v_tasks_after - v_tasks_before <> coalesce((v_res->>'requested')::int, 0) then
    v_bad := array_append(v_bad, format(
      'human_tasks(type=trust_promotion) grew by %s, expected exactly %s (the requested count)',
      v_tasks_after - v_tasks_before, v_res->>'requested'));
  end if;

  ----------------------------------------------------------------------
  -- PROBE 4 -- raise_trust_widening_proposals still runs clean after the
  -- refactor (same shape back: examined/raised/task_ids). Not a deep
  -- behavioural re-proof -- detect_trust_widening_patterns returns 0
  -- candidates for the only tenant with data today (measured baseline,
  -- progress.md), so this call is a safe no-op either way -- but it does
  -- prove the CREATE OR REPLACE + the new nested call to
  -- open_trust_promotion_request are wired correctly: wrong owner/grant
  -- wiring would show up here as an error, not a silent pass.
  ----------------------------------------------------------------------
  v_widen_res := public.raise_trust_widening_proposals(null);

  v_checks := v_checks + 1;
  if not (v_widen_res ? 'examined' and v_widen_res ? 'raised' and v_widen_res ? 'task_ids') then
    v_bad := array_append(v_bad, format(
      'raise_trust_widening_proposals returned an unexpected shape after the refactor: %s', v_widen_res));
  end if;

  ----------------------------------------------------------------------
  if array_length(v_bad, 1) > 0 then
    raise exception E'828 VERIFICATION FAILED (% assertions):\n  %',
      v_checks, array_to_string(v_bad, E'\n  ');
  end if;

  raise notice '828: % assertions, 0 findings. examined=%, requested=%, skipped_existing=%, thin=%, failed=%, linked=%/%, widening_examined=%.',
    v_checks, v_res->>'examined', v_res->>'requested', v_res->>'skipped_existing', v_res->>'thin',
    v_res->>'failed', v_linked, coalesce(array_length(v_target_ids, 1), 0), v_widen_res->>'examined';
end;
$verify$;

commit;
