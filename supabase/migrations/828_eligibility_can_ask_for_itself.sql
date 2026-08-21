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
-- ROUND 2 -- the coordinator's measurement, verbatim
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
-- open_trust_promotion_request is SECURITY INVOKER, not DEFINER. The reason
-- given for that HERE in round 2 was WRONG and is corrected in place in
-- round 3 below rather than left standing -- a migration header is
-- permanent. See ROUND 3 / IMPORTANT 2 for the correction; the short version
-- is that `postgres` turns out to already hold every privilege either
-- SECURITY DEFINER path needs, so INVOKER's justification is least-privilege
-- for its own sake, not the avoided regression this paragraph used to claim.
--
-- ── requested_by ─────────────────────────────────────────────────────────
-- Round 2 stamped a sentinel (00000000-0000-0000-0000-000000000000) here
-- instead of NULL. ROUND 3 / CRITICAL 1 below REVERTS that -- read that
-- section, not this one, for the current, correct behaviour: both callers
-- pass NULL, unchanged from before this task existed, and NULL is the
-- system-raised marker `trust-proposer-boundary.mjs` and
-- apply_trust_promotion both key on.
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
--
-- ============================================================================
-- ROUND 3 (fix round 2, coordinator review: 1 Critical + 3 Important)
-- ============================================================================
-- CRITICAL 1 -- the requested_by sentinel from round 2 is REVERTED. Two
-- independent, measured reasons, both the coordinator's:
--   1. It achieved nothing. apply_trust_promotion's self-approval guard
--      (`if requested_by is not null and auth.uid() = requested_by`) refuses
--      exactly who NULL refused -- nobody -- because no real auth.uid() can
--      ever equal the sentinel either. Zero behavioural difference, proven
--      by reading apply_trust_promotion's actual guard text, not paraphrase.
--   2. It blinded a live Ring-0 probe. scripts/trust-proposer-boundary.mjs's
--      `open_proposals` CTE (feeding certify.mjs's trust-proposer-cannot-decide,
--      arms 9/10/11) keys its ENTIRE evidence population on
--      `trust_policies.requested_by IS NULL` as the system-raised marker.
--      Measured, read-only, unaffected by this unapplied migration:
--      1 open system proposal, 1 pending total, both before and after this
--      fix (see task-1-report.md for the verbatim run of the probe's own
--      SQL). With the sentinel, that population would have gone to 0 the
--      moment this migration's sweep raised a real request, and the probe's
--      own denominator arm rules 0 a legal state -- certify would stay green
--      while comparing nothing.
--
-- open_trust_promotion_request no longer coalesces p_requested_by to
-- anything -- `requested_by = p_requested_by` is a straight pass-through,
-- and both current callers still pass literal `null`, exactly matching
-- pre-828 behaviour. The parameter is KEPT rather than dropped: neither
-- caller uses it today, but request_trust_promotion -- the human path,
-- still not migrated to this writer -- is the plausible future third caller
-- the coordinator named, and it would need to pass a real auth.uid() through
-- unchanged. An unused-but-correctly-shaped parameter costs nothing today;
-- dropping it now only to re-add it later is churn in exchange for nothing.
--
-- ⚠⚠ WHAT THIS REVERT RE-OPENS -- found while proving it, NOT asked for in
-- this round, and NOT fixed here: reverting to NULL means a criteria-shaped
-- proposal (this task's own eligibility sweep) now ALSO joins
-- trust-proposer-boundary.mjs's open_proposals population, alongside the
-- pattern-shaped ones it was built for. Proven with a synthetic row carrying
-- this exact task's real trust_evidence_for() output, injected via the
-- probe script's own `proposalExtra` test hook: arm 9
-- (citation-below-floor) FIRES, because trust_evidence_for's evidence has no
-- `pattern.decisions` array to cite -- it was never supposed to have one.
-- That is a FALSE POSITIVE the moment this migration is applied and the
-- sweep raises a real request against live data: certify would go red for a
-- legitimate criteria-based proposal behaving exactly as designed. Fixing it
-- means teaching trust-proposer-boundary.mjs's arm 9 about a second
-- legitimate evidence shape, which is a change to Ring-0 governance tooling
-- this task was not asked to make and should not make unilaterally. Full
-- reproduction in task-1-report.md; this is an open question returned to the
-- coordinator, not a decision this migration takes.
--
-- IMPORTANT 2 -- the round-2 paragraph above, claiming
-- refresh_approval_briefs_internal is "granted to trust_pattern_proposer and
-- service_role and NOT to postgres", was WRONG. That was read off
-- information_schema.role_routine_grants, which lists only EXPLICIT grants --
-- exactly the trap trust-proposer-boundary.mjs:27-29 names in its own
-- comment: "a REVOKE is not a description of the resulting privileges -- ask
-- the privilege question directly." Asked directly:
--   has_function_privilege('postgres', 'public.refresh_approval_briefs_internal(uuid)', 'EXECUTE')
--   -> true
-- because postgres is a member of BOTH approval_brief_writer (the function's
-- actual owner) and trust_pattern_proposer, both rolinherit=true (confirmed
-- via pg_auth_members / pg_roles). So a DEFINER writer owned by postgres
-- would NOT have broken that call after all -- postgres already carries
-- everything either caller's write sequence needs, the same way each
-- caller's own already-established role already does under INVOKER. The
-- TRUE, remaining, and honestly narrower reason to keep INVOKER: least
-- privilege for its own sake -- the writer has no functional NEED for an
-- identity distinct from whichever already-privileged SECURITY DEFINER
-- context calls it (postgres, rolbypassrls, for request_eligible_promotions;
-- trust_pattern_proposer, unchanged, for raise_trust_widening_proposals), so
-- it is not given one. A judgement call, not a forced one -- DEFINER would
-- also work today, with every grant below unchanged.
--
-- IMPORTANT 3 -- compute_trust_proposal_brief's "no pattern -> a human
-- requested it" else-branch was true until this task added a SECOND
-- machine-raised evidence shape, and is false for it: the brief told an
-- approver "Requested by a person from the employee file" for a proposal
-- whose own audit trail says, in the same breath, "raised automatically ...
-- no human requested it". Given a third case below, keyed on the evidence
-- carrying `criteria` and no `pattern` -- a property of the jsonb already
-- loaded, not a second lookup against human_tasks/audit_events. Same
-- severity as the branch it splits from (v_caution, not v_attention, not
-- routine) -- only the sentence about WHO asked was false; the amount of
-- scrutiny recommended was not, and is not softened.
--
-- IMPORTANT 4 -- the sweep's WHERE clause gained
-- `public.tenant_is_operational(tenant_id)`, mirroring
-- detect_trust_widening_patterns exactly (same function, same shape of
-- call, confirmed by reading its body). LATENT, not proven live: 0 of 6
-- tenants are non-operational today (measured), so no data arm on this
-- dataset can tell "filtered correctly" apart from "nothing to filter yet".
-- The verify block's proof for this one is a MECHANISM check (the deployed
-- function body still calls tenant_is_operational, comments stripped first,
-- per this repo's own convention for exactly this situation) rather than a
-- data one -- said so directly rather than implying more than that.
--
-- ============================================================================
-- ROUND 4 (fix round 3, coordinator review: 1 hard blocker on apply)
-- ============================================================================
-- PROBE 6a hardcoded a production policy id (a9574721-...) behind a plain
-- `select ... into` with no matching-row guard. On any database without
-- that exact row -- empty, a fresh environment, a restored backup, or
-- production itself once that policy stops being eligible, gains a
-- pending_task_id some other way, or its tenant is suspended -- the
-- variable stays NULL, the `is null` disjunct fires, and the migration
-- raises VERIFICATION FAILED and never applies. This is CLAUDE.md rule 3
-- exactly, and the same class of defect that made migrations 778, 789 and
-- 790 permanently unreplayable (unrepairable once applied: the ledger keys
-- on filename AND checksum, so before-it-lands is the only fixable moment).
-- Proven live before the fix, in a rolled-back block against a
-- non-existent id: `ERROR: P0001: PROBE6-ON-MISSING-ROW => FINDING APPENDED`.
--
-- Fixed by making 6a DISCOVER its subject exactly the way 6b already did --
-- no literal id anywhere in this file -- and emit a notice, not a finding,
-- when none exists. Proven three ways (task-1-report.md carries the
-- verbatim output of all three): the normal run still finds one and the
-- criteria branch still genuinely fires; forcing the discovery query to
-- find nothing still PASSES, with the notice, not a failure; inverting the
-- assertion with a real subject present still FAILS, with a distinct
-- message -- so the probe is neither fragile on empty data nor vacuous on
-- real data.
--
-- Also: PROBE 5's summary line read `sentinel_count=0/2` with nothing
-- saying what "2" counts. It is trust_policies ROWS currently carrying an
-- open request, not writers exercised this run -- on this dataset only
-- request_eligible_promotions wrote a NEW row in this transaction;
-- raise_trust_widening_proposals raised 0 here (detect_trust_widening_
-- patterns found no candidates today), and the second open-request row is
-- a pre-existing production proposal from an earlier, real run. The
-- message now says so, so "0/2" cannot be misread as "both writers fired".
--
-- ── FINAL WHOLE-FEATURE REVIEW (2026-08-21) — three changes to this file ────
-- This migration is committed but NOT APPLIED, so the ledger's filename+
-- checksum key has not closed on it yet and it is still repairable. Three
-- findings from the final review are therefore fixed HERE rather than in a
-- follow-up that could never repair them:
--
-- IMPORTANT 2 — open_trust_promotion_request updated trust_policies with NO
--   tenant predicate and no `if not found`. A caller handing it another
--   tenant's policy id got a human_tasks row stamped with the CALLER's
--   tenant, zero policy rows updated, and a returned task id that reads as
--   success. Fixed at the update, with the reasoning at the statement, and
--   proven both ways by PROBE 8 (a matching call still works; a mismatched
--   one refuses with the guard's OWN message and leaves no row behind).
--
-- LEDGER CORRECTION — the ledger recorded request_eligible_promotions as
--   "granted to nobody -- unreachable". Measurably wrong: ALTER DEFAULT
--   PRIVILEGES already leaves it `postgres=X/postgres | service_role=X/
--   postgres`. It was reachable; what was true is that its reachability rode
--   on a default this file never states. Now granted explicitly, with the
--   outcome (and the browser-side perimeter) pinned by PROBE 9.
--
-- IMPORTANT 3 — the composed human_tasks.detail, copied verbatim from
--   migration 025, restated the criteria the Task-6 evidence card now renders
--   directly below it AND promised "still capped by guardrails". Both are
--   addressed at the format() call, where the measurement that settles the
--   cap question is written out in full.
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
begin
  insert into human_tasks (id, tenant_id, type, title, detail, source, related_table, related_id, status)
  values (v_task, p_tenant_id, 'trust_promotion', p_title, p_detail,
          'system', 'trust_policies', p_policy_id, 'pending');

  -- requested_by: a straight pass-through, NULL from both current callers.
  -- See ROUND 3 / CRITICAL 1 above -- do not reintroduce a sentinel or any
  -- other transform here; NULL is the system-raised marker
  -- trust-proposer-boundary.mjs and apply_trust_promotion both key on.
  -- ⚠ FINAL REVIEW / IMPORTANT 2 -- `and tenant_id = p_tenant_id` is
  -- AUTHORISATION, not decoration, and the `if not found` below is half of
  -- the same guard. Without them this writer would take a policy id from one
  -- tenant and p_tenant_id from another, stamp the HUMAN_TASKS row with the
  -- CALLER's tenant, update ZERO policy rows, and return a task id that reads
  -- as success -- the exact "a tenant id passed as a parameter is an
  -- assertion, not authorisation" family migs 662-664 and 823 closed
  -- elsewhere. Neither of today's two callers can trip it (both pass the
  -- policy row's OWN tenant_id, from the same row) -- but this function is
  -- documented as a SHARED writer built to acquire more callers, and the
  -- ledger keys on filename AND checksum, so before-it-lands is the only
  -- moment it is fixable.
  --
  -- The raise sits AFTER the insert on purpose: the raise unwinds the
  -- statement/subtransaction that wrote the human_tasks row, so a refused
  -- call leaves NOTHING behind -- no orphan task, no audit event (the
  -- append below never runs), no returned id. A pre-check would also work;
  -- this ordering additionally guarantees the update and the insert can
  -- never disagree about which tenant this request belongs to.
  update trust_policies
     set pending_task_id = v_task,
         pending_evidence = p_evidence,
         requested_by = p_requested_by,
         requested_at = now()
   where id = p_policy_id
     and tenant_id = p_tenant_id;

  if not found then
    raise exception 'open_trust_promotion_request: policy % is not tenant %''s to file a request against — a policy id is not its own authorisation. No policy row was updated; the task row this call would have returned is unwound with this refusal.',
      p_policy_id, p_tenant_id;
  end if;

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
      -- IMPORTANT 4 (round 3): mirrors detect_trust_widening_patterns's own
      -- filter exactly. Latent on today's data -- see header.
      and public.tenant_is_operational(tenant_id)
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
        -- ⚠ FINAL REVIEW / IMPORTANT 3. This string used to be copied verbatim
        -- from migration 025's request_trust_promotion:
        --   'Evidence met all criteria: %s. Approving widens autonomy one
        --    step — still capped by guardrails.'
        -- Two things were wrong with carrying it here, and both were measured,
        -- not reasoned:
        --
        -- 1. IT RESTATED THE EVIDENCE THE CARD NOW CARRIES. Task 6 renders a
        --    curated evidence card from the SAME pending_evidence snapshot,
        --    directly below this text on both the ops queue and mobile. The
        --    approver read the criteria twice, in two voices, the SQL-composed
        --    one first.
        -- 2. "STILL CAPPED BY GUARDRAILS" PROMISED A LIMIT THE TRUST LADDER
        --    DOES NOT GRANT. Measured on production: trust_level_settings
        --    ('action_execute', 0) is enabled=false; levels 1, 2 and 3 are all
        --    enabled=true with max_amount_cents NULL. The ladder caps nothing
        --    for this category. Guardrails DO still gate independently --
        --    decide_action_execution stops destructive actions, blocked
        --    phrases/topics, and amounts over require_approval_over_cents
        --    (default 1,000,000 cents) BEFORE it ever reads the dial -- but
        --    that is a different mechanism, it bites only on the action-
        --    execution path, and only some of it is an AMOUNT cap. A sentence
        --    that says "capped" without naming which mechanism caps what is
        --    read as "the step you are approving is bounded", and for a
        --    non-money action_execute action it is not.
        --
        -- What is left is only what apply_trust_promotion itself guarantees at
        -- the moment the button is pressed, verified against its live body:
        -- it re-runs trust_evidence_for and refuses as stale if the evidence
        -- regressed, and it moves the level by least(current_level + 1,
        -- max_level) -- one step, never past this policy's own ceiling.
        -- No claim is made here about what the new level permits; that is the
        -- card's job, and it declines to claim a cap for the same reason.
        --
        -- ⚠ NOT FIXED HERE, deliberately: migration 025's request_trust_
        -- promotion still writes the original sentence, and it is APPLIED --
        -- the human "Request promotion" button produces the same contradiction
        -- on the same card. Both surfaces stop rendering the raw detail beside
        -- the curated card for criteria-shaped requests (see
        -- trustPromotionPresentation.detailIsRedundantBesideCard), which
        -- covers 025's copy too; rewriting an applied function's copy was not
        -- in this fix's scope and is named in the final-fix report instead.
        format('Raised automatically because this policy''s trust criteria are met — no human asked for it. The evidence behind it is on this request. Approving moves "%s" up one step and no further than this policy''s own ceiling; the criteria are re-verified at that moment and the request is refused if the evidence has gone stale.',
          v_label),
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
-- ⚠ FINAL REVIEW / LEDGER CORRECTION. The deferred minor recorded this
-- function as "granted to nobody -- unreachable". That was measurably wrong:
-- ALTER DEFAULT PRIVILEGES already leaves it `postgres=X/postgres |
-- service_role=X/postgres` with no explicit grant statement anywhere. It was
-- reachable; what was true is that its reachability rode entirely on a
-- default nobody states in this file, so a change to that default would have
-- silently un-shipped it. Stated explicitly now, exactly as its sibling
-- open_trust_promotion_request above states its own.
--
-- NOT granted to trust_pattern_proposer, deliberately, and the asymmetry with
-- the sibling is the point: this function is SECURITY DEFINER and owned by
-- the migration runner, so granting the proposer role EXECUTE would hand a
-- role whose entire remit is "files proposals and nothing else" a door that
-- runs as the owner. The proposer never needs to call it -- the daily sweep
-- does, and the sweep is owned by postgres.
grant execute on function public.request_eligible_promotions(uuid) to postgres, service_role;

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
    -- The `null` here is requested_by -- unchanged since before this task
    -- existed, and reverted to mean exactly that again after round 2's
    -- sentinel detour (see header, CRITICAL 1).
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

-- ── compute_trust_proposal_brief: IMPORTANT 3 (round 3) ─────────────────────
-- Adds a third branch so the approval card tells the truth about a
-- criteria-shaped (trust_evidence_for) proposal instead of assuming "no
-- pattern citation" means "a human requested it". Every other line is
-- reproduced verbatim from pg_get_functiondef.
create or replace function public.compute_trust_proposal_brief(p_task_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t          record;
  pol        trust_policies;
  pat        jsonb;
  n          integer;
  ev         jsonb := '[]'::jsonb;
  v_attention text[] := '{}';
  v_caution   text[] := '{}';
  v_risk     text;
  v_headline text;
begin
  select ht.id, ht.tenant_id, ht.type, ht.status, tn.status as tenant_status
    into t
    from human_tasks ht
    left join tenants tn on tn.id = ht.tenant_id
   where ht.id = p_task_id;
  if not found or t.type <> 'trust_promotion' then
    return null;
  end if;

  select p.* into pol from trust_policies p where p.pending_task_id = p_task_id;

  if pol.id is null then
    ev := ev || to_jsonb('No trust policy is linked to this proposal — approving would decide the task and change NOTHING (the apply hook would no-op).'::text);
    v_attention := array_append(v_attention, 'nothing is behind the button');
  else
    ev := ev || to_jsonb(format('Approving widens "%s" from level %s to level %s for one employee. Evidence is re-verified at apply time; automatic demotion can undo it.',
            pol.action_category, pol.current_level,
            least(pol.current_level + 1, least(3, coalesce(pol.max_level, 3))))::text);

    pat := pol.pending_evidence->'pattern';
    if pat is not null and jsonb_typeof(pat) = 'object' then
      n := coalesce((pat->>'n_approved')::integer, 0);
      ev := ev || to_jsonb(format('%s identical production approvals of "%s" in the last %s days — every one landed, zero rejections. Raised automatically by the pattern detector.',
              n, pat->>'action_key', pat->>'window_days')::text);
      if n < 3 then
        ev := ev || to_jsonb('The citation names fewer decisions than the pattern floor (3) — this proposal should not exist in this state.'::text);
        v_attention := array_append(v_attention, 'cites fewer decisions than the pattern floor');
      end if;
    elsif pol.pending_evidence ? 'criteria' then
      -- mig 828 round 3 (IMPORTANT 3): the second machine-raised shape --
      -- request_eligible_promotions, via trust_evidence_for. Keyed on the
      -- evidence's own shape (criteria present, pattern absent), not a
      -- second lookup, so this stays a pure function of what is already
      -- loaded. Same severity as the branch it splits from -- only the
      -- sentence about WHO asked was wrong.
      ev := ev || to_jsonb('Raised automatically because this employee''s trust criteria are met — no human asked for it. The criteria are re-verified at apply time.'::text);
      v_caution := array_append(v_caution, 'raised automatically from criteria — review before approving');
    else
      ev := ev || to_jsonb('Requested by a person from the employee file (no pattern citation) — the policy criteria were met at request time and are re-verified at apply.'::text);
      v_caution := array_append(v_caution, 'human-requested; review the criteria evidence');
    end if;
  end if;

  -- Workspace standing — same rule and same wording family as mig 705.
  if t.tenant_status = 'suspended' or t.tenant_status is null then
    ev := ev || to_jsonb(('This workspace is ' || coalesce(t.tenant_status, 'gone')
          || ' — nothing will execute until it is reinstated.')::text);
    v_attention := array_append(v_attention, 'workspace is ' || coalesce(t.tenant_status, 'gone'));
  elsif t.tenant_status <> 'active' and t.tenant_status <> 'trial' then
    ev := ev || to_jsonb(('Workspace status: ' || t.tenant_status || '.')::text);
  end if;

  if array_length(v_attention, 1) is not null then
    v_risk := 'attention';
    v_headline := 'Needs attention — ' || array_to_string(v_attention, '; ') || '.';
  elsif array_length(v_caution, 1) is not null then
    v_risk := 'caution';
    v_headline := 'Worth a look — ' || array_to_string(v_caution, '; ') || '.';
  else
    v_risk := 'routine';
    v_headline := format('Looks routine — %s identical landed approvals earned this; approving widens one dial, and demotion can undo it.', coalesce(n, 0));
  end if;

  return jsonb_build_object(
    'risk', v_risk,
    'headline', v_headline,
    'evidence', ev,
    'category', 'trust_promotion',
    'amount_cents', null
  );
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
  v_tasks_before       bigint;
  v_tasks_after        bigint;
  v_open_requests      int;
  v_sentinel_count     int;
  v_criteria_brief     jsonb;
  v_criteria_task_id   uuid;
  v_pattern_task_id    uuid;
  v_pattern_brief      jsonb;
  v_src                text;
  v_suspended_tenants  int;
  -- PROBE 8 (FINAL REVIEW / IMPORTANT 2)
  v_p8_policy          uuid;
  v_p8_tenant          uuid;
  v_p8_other_tenant    uuid;
  v_p8_task            uuid;
  v_p8_linked          int := -1;
  v_p8_outcome         text;
  v_p8_rows_before     bigint;
  v_p8_rows_after      bigint;
  v_p8_grant_ok        boolean;
begin
  -- IMPORTANT 4: every expected-value query below mirrors the sweep's own
  -- tenant_is_operational filter, so the probes stay a correct description
  -- of the function's real behaviour rather than one that only happens to
  -- match today because nothing is suspended.
  select count(*) into v_examined_expected
  from public.trust_policies where status = 'active' and public.tenant_is_operational(tenant_id);

  -- PROBEs 1/3's denominator: an eligible policy with no open task, captured
  -- BEFORE the sweep runs (so PROBE 3 below can prove causation, not just
  -- correlation -- these are the exact rows whose pending_task_id must both
  -- change AND resolve to a real, matching human_tasks row).
  select array_agg(p.id), count(*)
    into v_target_ids, v_eligible_before
  from public.trust_policies p
  where (public.trust_evidence_for(p)->>'eligible')::boolean
    and p.pending_task_id is null
    and public.tenant_is_operational(p.tenant_id);

  select count(*) into v_skip_expected
  from public.trust_policies p
  where (public.trust_evidence_for(p)->>'eligible')::boolean
    and p.pending_task_id is not null
    and public.tenant_is_operational(p.tenant_id);

  select count(*) into v_tasks_before
  from public.human_tasks where type = 'trust_promotion';

  ----------------------------------------------------------------------
  -- PROBE 1 -- every active, operational-tenant policy is examined, once.
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
  -- that many requested, zero failed, and a REAL human_tasks row for each,
  -- that did not exist before, linked back from
  -- trust_policies.pending_task_id. Vacuously fine on an empty database:
  -- 0 = 0 and an empty array joins to nothing.
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
  -- PROBE 5 -- CRITICAL 1 (round 3): no row either writer can produce
  -- carries the sentinel round 2 briefly stamped. Denominator: how many
  -- trust_policies ROWS carry an open request at all right now
  -- (pending_task_id is not null) -- the population that COULD carry a
  -- wrong value if the coalesce-to-sentinel ever came back. Vacuously fine
  -- (0 open requests => 0 with the sentinel) on an empty database.
  --
  -- ⚠ round 4: this is a count of POLICIES, not of writers exercised this
  -- run. On this dataset only request_eligible_promotions wrote a NEW row
  -- in this transaction (raise_trust_widening_proposals raised 0 here --
  -- detect_trust_widening_patterns found no candidates today); the second
  -- open-request row is a pre-existing production proposal from an
  -- earlier, real invocation. "2" is not evidence both writers fired now.
  ----------------------------------------------------------------------
  select count(*) filter (where pending_task_id is not null),
         count(*) filter (where requested_by = '00000000-0000-0000-0000-000000000000'::uuid)
    into v_open_requests, v_sentinel_count
    from public.trust_policies;

  v_checks := v_checks + 1;
  if v_sentinel_count <> 0 then
    v_bad := array_append(v_bad, format(
      '%s of %s open-request trust_policies row(s) carry the sentinel requested_by -- the CRITICAL 1 revert did not take',
      v_sentinel_count, v_open_requests));
  end if;

  ----------------------------------------------------------------------
  -- PROBE 6 -- IMPORTANT 3 (round 3): the approval card tells the truth
  -- about who asked, for BOTH evidence shapes -- a one-sided check (only
  -- the new branch, or only the old one) would not prove the split is
  -- real. Neither subject is assumed to exist: each is DISCOVERED by
  -- querying for any pending proposal of that shape, exactly like PROBE
  -- 6b -- a literal task or policy id here would hard-code a row that
  -- need not exist on an empty database, a fresh environment, or
  -- production itself if this exact policy's state has moved on by apply
  -- time (round 4: this replaced a hardcoded id that failed exactly that
  -- way -- see header). Absence of a subject is a notice, never a finding.
  ----------------------------------------------------------------------
  select ht.id into v_criteria_task_id
    from public.trust_policies tp
    join public.human_tasks ht on ht.id = tp.pending_task_id
   where tp.pending_evidence ? 'criteria'
     and ht.type = 'trust_promotion' and ht.status = 'pending'
   limit 1;

  if v_criteria_task_id is null then
    raise notice '828 PROBE 6a: no criteria-shaped pending proposal exists right now -- the criteria half of the split is unexercised on this dataset.';
  else
    select public.compute_trust_proposal_brief(v_criteria_task_id) into v_criteria_brief;
    v_checks := v_checks + 1;
    if v_criteria_brief is null
       or (v_criteria_brief->'evidence')::text ilike '%no pattern citation%'
       or (v_criteria_brief->'evidence')::text not ilike '%no human asked%' then
      v_bad := array_append(v_bad, format(
        'criteria-shaped brief [task %s] still reads human-requested, or is null: %s', v_criteria_task_id, v_criteria_brief));
    end if;
  end if;

  select ht.id into v_pattern_task_id
    from public.trust_policies tp
    join public.human_tasks ht on ht.id = tp.pending_task_id
   where ht.type = 'trust_promotion' and ht.status = 'pending'
     and tp.pending_evidence ? 'pattern'
   limit 1;

  if v_pattern_task_id is null then
    raise notice '828 PROBE 6b: no pattern-shaped pending proposal exists right now -- the pattern half of the split is unexercised on this dataset.';
  else
    select public.compute_trust_proposal_brief(v_pattern_task_id) into v_pattern_brief;
    v_checks := v_checks + 1;
    if v_pattern_brief is null
       or (v_pattern_brief->'evidence')::text not ilike '%identical production approvals%' then
      v_bad := array_append(v_bad, format(
        'pattern-shaped brief [task %s] lost its pattern sentence: %s', v_pattern_task_id, v_pattern_brief));
    end if;
  end if;

  ----------------------------------------------------------------------
  -- PROBE 7 -- IMPORTANT 4 (round 3): the dormancy filter is a MECHANISM
  -- check, not a data one -- 0 of 6 tenants are suspended today (measured
  -- below), so no data arm could distinguish "filtered correctly" from
  -- "filter absent, nothing to filter yet" on this dataset. Comments
  -- stripped before matching source, per this repo's own convention.
  ----------------------------------------------------------------------
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_src
    from pg_proc where proname = 'request_eligible_promotions' and pronamespace = 'public'::regnamespace;

  v_checks := v_checks + 1;
  if v_src !~ 'tenant_is_operational' then
    v_bad := array_append(v_bad, 'request_eligible_promotions no longer calls tenant_is_operational -- the dormancy filter is missing');
  end if;

  select count(*) into v_suspended_tenants from public.tenants where status = 'suspended';
  raise notice '828 PROBE 7: % of % tenant(s) suspended -- the dormancy filter''s DATA effect is %.',
    v_suspended_tenants, (select count(*) from public.tenants),
    case when v_suspended_tenants = 0 then 'UNEXERCISED on this dataset (mechanism-only proof above)' else 'live' end;

  ----------------------------------------------------------------------
  -- PROBE 8 -- FINAL REVIEW / IMPORTANT 2: the shared writer refuses a
  -- policy that does not belong to the tenant it was handed, and STILL
  -- works for one that does. Both halves, because a guard proven only on
  -- the refusing side could have been implemented as "always refuse".
  --
  -- Neither subject is hardcoded: the policy and the OTHER tenant are both
  -- DISCOVERED, and absence of either is a notice, never a finding (the
  -- shape PROBE 6a was rewritten into in round 3 -- see the header). On a
  -- database with no policies, or with only one tenant, the corresponding
  -- half simply does not run and says so.
  --
  -- ⚠ BOTH HALVES ARE UNDONE. Each runs inside its own BEGIN/EXCEPTION
  -- block, which is a subtransaction: the negative half is unwound by the
  -- guard's own raise, and the positive half by a sentinel raise thrown
  -- straight after its measurement. PL/pgSQL variable assignments are NOT
  -- transactional, so v_p8_linked survives the rollback that discards the
  -- rows it describes. Nothing this probe writes reaches the commit.
  ----------------------------------------------------------------------
  select p.id, p.tenant_id into v_p8_policy, v_p8_tenant
    from public.trust_policies p
   order by p.id
   limit 1;

  if v_p8_policy is null then
    raise notice '828 PROBE 8: no trust_policies row exists -- BOTH halves of the tenant-guard proof are unexercised on this dataset.';
  else
    -- ── positive half: the matching tenant still works ──────────────────
    begin
      v_p8_task := public.open_trust_promotion_request(
        v_p8_tenant, v_p8_policy, '{"probe": "828 PROBE 8"}'::jsonb, null,
        '828 PROBE 8 — rolled back', '828 PROBE 8 — rolled back',
        'Trust engine', '828 PROBE 8 — rolled back',
        jsonb_build_object('kind', 'probe', 'policy_id', v_p8_policy));

      select count(*) into v_p8_linked
        from public.trust_policies p
       where p.id = v_p8_policy and p.pending_task_id = v_p8_task;

      raise exception 'ZZ_828_PROBE8_ROLLBACK';
    exception when others then
      if sqlerrm <> 'ZZ_828_PROBE8_ROLLBACK' then
        v_p8_linked := -1;
        v_bad := array_append(v_bad, format(
          'PROBE 8 positive half: a MATCHING-tenant call to open_trust_promotion_request failed -- the guard refuses a caller it must accept. sqlerrm=%s', sqlerrm));
      end if;
    end;

    v_checks := v_checks + 1;
    if v_p8_linked <> 1 then
      v_bad := array_append(v_bad, format(
        'PROBE 8 positive half: matching-tenant call linked %s policy row(s), expected exactly 1', v_p8_linked));
    end if;

    -- ── negative half: a mismatched tenant is refused, not silently ok ──
    select t.id into v_p8_other_tenant
      from public.tenants t
     where t.id <> v_p8_tenant
     order by t.id
     limit 1;

    if v_p8_other_tenant is null then
      raise notice '828 PROBE 8b: only one tenant exists -- the MISMATCHED-tenant half is unexercised on this dataset (the positive half above still ran).';
    else
      v_checks := v_checks + 2;   -- 8b (the verdict) and 8c (the residue)
      v_p8_outcome := 'not-run';
      v_p8_rows_after := -1;
      select count(*) into v_p8_rows_before
        from public.human_tasks where type = 'trust_promotion';

      -- ⚠ TWO NESTED SUBTRANSACTIONS, and the nesting is the whole point of
      -- 8c. A single block would have to raise its own sentinel to unwind an
      -- ACCEPTED call -- and that sentinel would discard the very row 8c
      -- exists to find, so 8c could never once fail: a checker that cannot
      -- fail is theatre, by this repo's own rule, and the first draft of this
      -- probe was exactly that. The INNER block absorbs the guard's refusal;
      -- the OUTER one is what unwinds, and between them there is a moment
      -- where anything the writer left behind is still visible to count.
      begin
        begin
          v_p8_task := public.open_trust_promotion_request(
            v_p8_other_tenant, v_p8_policy, '{"probe": "828 PROBE 8b"}'::jsonb, null,
            '828 PROBE 8b — must never be written', '828 PROBE 8b — must never be written',
            'Trust engine', '828 PROBE 8b — must never be written',
            jsonb_build_object('kind', 'probe', 'policy_id', v_p8_policy));
          -- Reached only if the writer ACCEPTED a policy that is not this
          -- tenant's -- the silent success this guard exists to stop.
          v_p8_outcome := 'accepted';
        exception when others then
          -- Pinned by MESSAGE, not by "something raised": an FK violation on
          -- the human_tasks insert, a NOT NULL, or any unrelated error would
          -- otherwise read as the guard firing. Only the guard's own words
          -- count as a pass.
          if sqlerrm like '%is not tenant%to file a request against%' then
            v_p8_outcome := 'refused';
          else
            v_p8_outcome := 'wrong-error: ' || sqlerrm;
          end if;
        end;

        select count(*) into v_p8_rows_after
          from public.human_tasks where type = 'trust_promotion';

        raise exception 'ZZ_828_PROBE8B_ROLLBACK';
      exception when others then
        if sqlerrm <> 'ZZ_828_PROBE8B_ROLLBACK' then
          v_p8_outcome := 'probe-error: ' || sqlerrm;
        end if;
      end;

      if v_p8_outcome = 'accepted' then
        v_bad := array_append(v_bad, format(
          'PROBE 8b: open_trust_promotion_request ACCEPTED policy %s for tenant %s (it belongs to %s) -- the tenant predicate is missing and a mismatched call reads as success',
          v_p8_policy, v_p8_other_tenant, v_p8_tenant));
      elsif v_p8_outcome <> 'refused' then
        v_bad := array_append(v_bad, format(
          'PROBE 8b: the mismatched-tenant call did not end in the tenant guard''s own refusal -- %s', v_p8_outcome));
      end if;

      -- 8c: the refusal leaves NOTHING behind. The writer inserts the
      -- human_tasks row BEFORE it updates the policy, so a guard that
      -- RETURNED (or swallowed its own exception) instead of raising would
      -- strand an orphan pending trust_promotion task -- the mig-590/701
      -- class arm 12 of trust-proposer-boundary watches. Measured inside the
      -- outer block, before it unwinds, against the count taken immediately
      -- before the call: a delta of exactly zero, or a finding.
      if v_p8_rows_after <> v_p8_rows_before then
        v_bad := array_append(v_bad, format(
          'PROBE 8c: the mismatched-tenant call left %s human_tasks(type=trust_promotion) row(s) behind (%s -> %s) -- a refused request must unwind its own task row',
          v_p8_rows_after - v_p8_rows_before, v_p8_rows_before, v_p8_rows_after));
      end if;
    end if;
  end if;

  ----------------------------------------------------------------------
  -- PROBE 9 -- FINAL REVIEW / LEDGER CORRECTION: request_eligible_
  -- promotions is EXECUTE-able by service_role and by nobody on the
  -- browser side. This asserts the OUTCOME, which is all that is
  -- observable -- ALTER DEFAULT PRIVILEGES and an explicit GRANT leave
  -- byte-identical proacl entries, so no arm can prove which one caused
  -- it. The explicit grant statement above exists so the outcome stops
  -- depending on a default; this arm exists so a change to either is seen.
  -- has_function_privilege answers INCLUDING inheritance through PUBLIC,
  -- which is why the revoke above is what makes the three negative
  -- comparisons meaningful.
  ----------------------------------------------------------------------
  v_checks := v_checks + 1;
  select has_function_privilege('service_role', p.oid, 'EXECUTE') into v_p8_grant_ok
    from pg_proc p
   where p.proname = 'request_eligible_promotions' and p.pronamespace = 'public'::regnamespace;
  if not coalesce(v_p8_grant_ok, false) then
    v_bad := array_append(v_bad, 'request_eligible_promotions is not EXECUTE-able by service_role -- the daily sweep''s callee is unreachable');
  end if;

  v_checks := v_checks + 3;
  if exists (
    select 1 from pg_proc p
    cross join (values ('anon'), ('authenticated'), ('public')) who(r)
    where p.proname = 'request_eligible_promotions' and p.pronamespace = 'public'::regnamespace
      and has_function_privilege(who.r, p.oid, 'EXECUTE')
  ) then
    v_bad := array_append(v_bad, 'request_eligible_promotions is EXECUTE-able from the browser side (anon/authenticated/public) -- a system sweep is not a public endpoint');
  end if;

  ----------------------------------------------------------------------
  if array_length(v_bad, 1) > 0 then
    raise exception E'828 VERIFICATION FAILED (% assertions):\n  %',
      v_checks, array_to_string(v_bad, E'\n  ');
  end if;

  raise notice '828: % assertions, 0 findings. examined=%, requested=%, skipped_existing=%, thin=%, failed=%, linked=%/%, widening_examined=%, sentinel=%/% open-request policies (population, not writers exercised). tenant-guard: positive=%, mismatched=%.',
    v_checks, v_res->>'examined', v_res->>'requested', v_res->>'skipped_existing', v_res->>'thin',
    v_res->>'failed', v_linked, coalesce(array_length(v_target_ids, 1), 0), v_widen_res->>'examined',
    v_sentinel_count, v_open_requests,
    case when v_p8_policy is null then 'unexercised (no policies)' else v_p8_linked || ' policy row linked then rolled back' end,
    coalesce(v_p8_outcome, 'unexercised (fewer than two tenants)');
end;
$verify$;

commit;
