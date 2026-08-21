-- 834_wire_the_eligibility_sweep_into_the_daily_governance_sweep.sql
-- ============================================================================
-- WHY: migration 828 built the thing this whole feature exists for -- a policy
-- whose own criteria are met can ASK for its own promotion, instead of waiting
-- for the pattern detector to notice three identical repeated approvals -- and
-- shipped it with NO CALLER.
--
-- Measured on production before this migration was written, not inferred:
--
--     de_governance_sweep_internal: calls raise_trust_widening_proposals = true
--                                   calls request_eligible_promotions   = false
--
-- A whole-repo grep finds zero call sites outside 828's own prose and probes.
-- The daily cron is a single statement --
--
--     de-governance-sweep-daily | 45 6 * * * | select de_governance_sweep_internal()
--
-- -- so the sweep body IS the seam's only heartbeat, and a writer it does not
-- name is a writer that never runs. Eligibility could not ask for itself: the
-- exact closed loop the feature was built to break.
--
-- ── THE REPO ALREADY HAD AN ARM FOR THIS CLASS AND IT DID NOT FIRE ──────────
-- scripts/trust-proposer-boundary.mjs arm 8, verbatim: "sweep-unfed --
-- de_governance_sweep_internal no longer calls raise_trust_widening_proposals.
-- The seam is built and starved." 828 added a SECOND writer to that seam and
-- extended neither the sweep nor the arm, so the standing control kept passing
-- while the new half was starved. Both halves land together: this migration
-- wires the call, and the same commit extends arm 8 to watch BOTH writers --
-- proven capable of going red on either one missing, not just on the old one.
--
-- ── WHY THE ORDER IS (e) THEN (f), AND WHY IT CANNOT DOUBLE-RAISE ───────────
-- Both writers can now target the same policy, so "can one policy end up with
-- two open proposals?" is the question this migration had to answer before it
-- could be written. It cannot, and the reason is structural rather than lucky:
--
--   * trust_policies.pending_task_id is a SINGLE column, so "two open
--     proposals on one policy" is not even representable. The real failure
--     mode of a double-raise is an OVERWRITE -- writer B's task id replaces
--     writer A's, and A's human_tasks row is stranded pending, pointing at a
--     policy that no longer points back. That is the mig-590/701 orphan class
--     arm 12 of trust-proposer-boundary already watches.
--
--   * request_eligible_promotions declines any policy with
--     `pending_task_id is not null` (828's skipped_existing branch).
--
--   * detect_trust_widening_patterns -- which is what
--     raise_trust_widening_proposals iterates -- declines a whole candidate
--     chain when ANY policy in it has a pending_task_id joined to a task with
--     status = 'pending'.
--
-- Both writers run inside ONE transaction (the sweep is one function call),
-- and each statement of a PL/pgSQL body sees the effects of the statements
-- before it, so whichever writes first is visible to the second. Neither
-- order can double-raise. Only one order keeps the evidence: (e)'s proposal
-- carries citations -- dates, approvers, landed receipts for three or more
-- identical approvals -- while (f)'s carries criteria counts only. Running
-- (e) first lets the richer proposal take a contested policy. Reversed, the
-- detector's chain-block would suppress it in favour of the thinner one.
--
-- PROBE 4 drives that idempotence for real rather than asserting it: it
-- discovers an eligible policy, clears its open request inside a subtransaction
-- that always unwinds, runs the writer TWICE, and requires the second run to
-- request nothing and skip what the first raised. PROBE 5 counts orphaned
-- pending proposals across the same fixture as a DELTA, so the fixture's own
-- artifact cannot be mistaken for a writer's. PROBE 6 asks the detector
-- whether it still considers a just-raised policy a candidate.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────────────
-- It does not CALL de_governance_sweep_internal(). That function expires
-- certifications, fails performance plans and files critical incidents, and a
-- migration commits -- so invoking it to "prove the wiring end to end" would
-- ship a day's governance side effects as a side effect of a schema change.
-- The wiring is asserted about the installed function's own body (a pg_proc
-- assertion, true wherever this replays), the callee is exercised directly by
-- PROBEs 4-6, and arm 8 of the Ring-0 boundary probe is what watches the
-- linkage from here on, on every certify run.
--
-- CREATE OR REPLACE, never DROP + CREATE: the sweep is owned by postgres and
-- carries its existing grants, and only OR REPLACE preserves both. The body
-- below was generated from the LIVE pg_get_functiondef output, with exactly
-- three deltas -- the v_elig declaration, step (f), and the new return key --
-- verified by diffing the generated file against the fetched original before
-- it was pasted here. Nothing else in 193 lines was retyped.
-- ============================================================================

begin;

-- ── precondition, asserted about SCHEMA (true wherever this replays) ─────────
do $precheck$
begin
  -- errcode is deliberate, not decoration, and follows 832's precedent:
  -- audit-migration-replayability classifies a dry-run failure by SQLSTATE.
  -- P0001 means "this migration asserted on data the environment lacks" --
  -- the defect that gate exists to stop -- while 42883 means "a dependency is
  -- missing here", which is not this file's doing and is reported as NOT
  -- PROVEN rather than as a pass. Both names below are literally undefined
  -- functions when absent, so P0001 would accuse this file of a defect it
  -- does not have.
  if to_regprocedure('public.request_eligible_promotions(uuid)') is null then
    raise exception 'PRECONDITION FAILED: public.request_eligible_promotions(uuid) does not exist -- migration 828 has not been applied. Apply 828 first; without it the sweep body below would raise 42883 on every nightly run.'
      using errcode = 'undefined_function';
  end if;
  if to_regprocedure('public.detect_trust_widening_patterns(uuid)') is null then
    raise exception 'PRECONDITION FAILED: public.detect_trust_widening_patterns(uuid) does not exist -- migration 710 has not been applied. PROBE 2 below asserts its dedupe guard, and an absent function would let that assertion pass by comparing nothing.'
      using errcode = 'undefined_function';
  end if;
end
$precheck$;

CREATE OR REPLACE FUNCTION public.de_governance_sweep_internal()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_cert record;
  v_pip record;
  v_inc record;
  m record;
  v_warned integer := 0;
  v_expired integer := 0;
  v_pip_completed integer := 0;
  v_pip_failed integer := 0;
  v_sla integer := 0;
  v_de_name text;
  v_prop jsonb;
  v_elig jsonb;
  v_goals integer; v_measured integer; v_unmet integer; v_decisions bigint;
  v_pip_dismissed integer := 0;
  v_pip_unassessable integer := 0;
begin
  -- (a) Expiring within 14 days → one warning audit event per cert.
  for v_cert in
    select c.*, de.name as de_name from de_certifications c
    join digital_employees de on de.id = c.de_id
    where c.status = 'active' and c.warned_at is null
      and c.expires_at <= now() + interval '14 days' and c.expires_at > now()
      and tenant_is_operational(c.tenant_id)
  loop
    update de_certifications set warned_at = now() where id = v_cert.id;
    perform append_audit_event_internal(
      v_cert.tenant_id, 'Governance sweep', 'system',
      format('%s''s %s certification expires %s — recertify to keep it current', v_cert.de_name, v_cert.cert_type, to_char(v_cert.expires_at, 'YYYY-MM-DD')),
      'config_change',
      jsonb_build_object('kind', 'certification_expiring', 'cert_id', v_cert.id, 'de_id', v_cert.de_id)
    );
    v_warned := v_warned + 1;
  end loop;

  -- (b) Expired → status flip + incident (dedup via unique source key).
  for v_cert in
    select c.*, de.name as de_name from de_certifications c
    join digital_employees de on de.id = c.de_id
    where c.status = 'active' and c.expires_at <= now()
      and tenant_is_operational(c.tenant_id)
  loop
    update de_certifications set status = 'expired' where id = v_cert.id;
    insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
    values (v_cert.tenant_id, v_cert.de_id, 'certification_expired', 'warning',
      format('%s certification expired — %s', initcap(v_cert.cert_type), v_cert.de_name),
      jsonb_build_object('cert_id', v_cert.id, 'cert_type', v_cert.cert_type, 'scope', v_cert.scope,
                         'issued_by', v_cert.issued_by_name, 'expired_at', v_cert.expires_at),
      'de_certifications', v_cert.id, v_cert.expires_at)
    on conflict (tenant_id, source_table, source_id) do nothing;
    v_expired := v_expired + 1;
  end loop;

  -- (c) Overdue open PIPs → RE-MEASURE on a fresh 4-week window: now
  --     passing → completed (closed loop); still failing → 'failed' +
  --     CRITICAL incident for human trust review.
  for v_pip in
    select i.* from de_development_items i
    where i.item_type = 'pip' and i.source = 'detected'
      and i.status in ('proposed', 'in_progress') and i.due_date < current_date
      and tenant_is_operational(i.tenant_id)
  loop
    select name into v_de_name from digital_employees where id = v_pip.de_id;

    -- ⛔ ONE POLICY, TWO READERS.
    --
    -- This block used to re-measure against three constants:
    --   total_decisions >= 10 and escalation_rate <= 50
    --   and avg_confidence >= 50 and error_rate <= 15
    -- Mig 765 removed exactly those from the review as illegitimate -- "judging
    -- everyone against three invented constants" -- and replaced them with the
    -- goals the workspace actually set. They lived on HERE, so the two readers
    -- of one policy disagreed: the review would decline to judge an employee
    -- while this sweep failed it and raised a CRITICAL incident.
    --
    -- Worse, `v_passing` was initialised false and only ever set INSIDE a loop
    -- over get_de_performance_metrics. An employee that function returned no
    -- row for fell straight to the else branch: absence of evidence became
    -- FAILURE, plus a critical incident. That is the same polarity error mig
    -- 786 closed on the authority side -- "we could not tell" must never be
    -- spelled the same way as a verdict.
    --
    -- Same reader as the review now: de_kpi_status_internal, over the same
    -- fresh 4-week window this sweep has always used.
    select count(*),
           count(*) filter (where k.current is not null),
           count(*) filter (where k.current is not null and coalesce(k.met, false) = false)
      into v_goals, v_measured, v_unmet
      from de_kpi_status_internal(v_pip.tenant_id, v_pip.de_id, 4) k;

    v_decisions := 0;
    select coalesce(mm.total_decisions, 0) into v_decisions
      from get_de_performance_metrics(v_pip.tenant_id, 4) mm
     where mm.de_id = v_pip.de_id;

    if v_goals = 0 then
      -- No goals means no verdict (founder decision, 2026-08-18). A plan on an
      -- employee with nothing to be judged against can NEVER be adjudicated by
      -- either reader, so leaving it open is not caution -- it is a permanent
      -- open threat carrying a consequence clause that promises a critical
      -- incident. Withdraw it, and say so. `dismissed` rather than completed
      -- or failed: it neither passed nor failed, it was never judgeable.
      update de_development_items set status = 'dismissed', updated_at = now()
       where id = v_pip.id;
      perform append_audit_event_internal(
        v_pip.tenant_id, 'Governance sweep', 'system',
        format('%s has no goals set, so its Performance Improvement Plan could not be judged and has been withdrawn. Set goals and a future review can open one that means something.',
               coalesce(v_de_name, 'Employee')),
        'config_change',
        jsonb_build_object('kind', 'pip_dismissed', 'item_id', v_pip.id, 'de_id', v_pip.de_id,
                           'why', 'no goals set for this employee')
      );
      v_pip_dismissed := v_pip_dismissed + 1;

    elsif v_decisions < 10 or v_measured = 0 then
      -- ⚠ NOT A FAILURE. Goals exist but there is not yet enough to judge them
      -- on. The thin-evidence guard mig 765 deliberately KEPT, applied here for
      -- the first time. The plan stays open and its deadline stays where it is;
      -- next sweep may well have the evidence. What must not happen is a
      -- critical incident for the crime of being unmeasured.
      v_pip_unassessable := v_pip_unassessable + 1;

    elsif v_unmet = 0 then
      update de_development_items set status = 'completed', completed_at = now(), updated_at = now() where id = v_pip.id;
      perform append_audit_event_internal(
        v_pip.tenant_id, 'Governance sweep', 'system',
        format('%s met its Performance Improvement Plan targets — PIP closed', coalesce(v_de_name, 'Employee')),
        'config_change',
        jsonb_build_object('kind', 'pip_completed', 'item_id', v_pip.id, 'de_id', v_pip.de_id,
                           'goals_measured', v_measured)
      );
      v_pip_completed := v_pip_completed + 1;

    else
      -- Measured, and missed. This is the consequence the plan itself promises.
      update de_development_items set status = 'failed', updated_at = now() where id = v_pip.id;
      insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
      values (v_pip.tenant_id, v_pip.de_id, 'pip_failed', 'critical',
        format('Performance Improvement Plan failed — %s', coalesce(v_de_name, 'employee')),
        jsonb_build_object('item_id', v_pip.id, 'due_date', v_pip.due_date,
          'consequence', v_pip.consequence,
          'goals_missed', v_unmet, 'goals_measured', v_measured,
          'next_step', 'A human decides here: trust reduction, added approval gates, or pause (Pause is on the employee profile).'),
        'de_development_items', v_pip.id, now())
      on conflict (tenant_id, source_table, source_id) do nothing;
      v_pip_failed := v_pip_failed + 1;
    end if;
  end loop;

  -- (d) §10.3: critical incidents should be reviewed within 48 hours —
  --     one nudge each (detail flag dedup).
  for v_inc in
    select * from de_incidents
    where status = 'open' and severity = 'critical'
      and created_at < now() - interval '48 hours'
      and coalesce(detail->>'sla_nudged', '') = ''
      and tenant_is_operational(tenant_id)
  loop
    update de_incidents set detail = detail || '{"sla_nudged": true}'::jsonb where id = v_inc.id;
    perform append_audit_event_internal(
      v_inc.tenant_id, 'Governance sweep', 'system',
      format('Critical incident open past the 48-hour review window: %s', left(v_inc.title, 160)),
      'config_change',
      jsonb_build_object('kind', 'incident_sla_nudge', 'incident_id', v_inc.id, 'de_id', v_inc.de_id)
    );
    v_sla := v_sla + 1;
  end loop;

  -- (e) mig 710: repeated identical human approvals become a trust-widening
  --     PROPOSAL (never a decision — a human still approves it, through
  --     decide_human_task, like every other task). SECURITY DEFINER
  --     dispatch: the callee is owned by trust_pattern_proposer, so this
  --     step runs with that role's privileges, which cannot decide or move
  --     a dial. Errors are captured, not swallowed silently — they ride in
  --     the return payload; a proposer failure must not cost steps (a)-(d).
  begin
    v_prop := public.raise_trust_widening_proposals(null);
  exception when others then
    v_prop := jsonb_build_object('error', sqlerrm);
  end;

  -- (f) mig 834: the OTHER writer on the same seam. Mig 828 built
  --     request_eligible_promotions -- "eligibility can ask for itself":
  --     a policy whose own criteria are met raises its own promotion
  --     request, without waiting for three identical repeated approvals
  --     for the detector in (e) to notice. 828 shipped it with NO CALLER.
  --     This function is the seam's only heartbeat, so a writer the sweep
  --     does not call is a writer that never runs: exactly the
  --     built-and-starved defect arm 8 of scripts/trust-proposer-boundary
  --     exists to catch, and arm 8 watched only (e).
  --
  --     ⚠ ORDER IS DELIBERATE: (e) BEFORE (f), never the reverse.
  --     Both writers can target the same policy, and whichever runs first
  --     takes it -- the other's own dedupe then declines. (e)'s proposal
  --     carries citations: dates, approvers and landed receipts for three
  --     or more identical approvals. (f)'s carries criteria counts only.
  --     Running (e) first means a contested policy gets the RICHER
  --     evidence, and (f) skips it on pending_task_id. Reversed, the
  --     detector's own chain-block (detect_trust_widening_patterns's
  --     `not exists (... pending_task_id ... status = 'pending')`) would
  --     suppress the citation-bearing proposal in favour of the thinner
  --     one. Neither order can double-raise; only one keeps the receipts.
  --
  --     Errors are captured exactly as (e)'s are: they ride in the return
  --     payload rather than costing steps (a)-(e).
  begin
    v_elig := public.request_eligible_promotions(null);
  exception when others then
    v_elig := jsonb_build_object('error', sqlerrm);
  end;

  return jsonb_build_object('cert_warnings', v_warned, 'certs_expired', v_expired,
    'pips_completed', v_pip_completed, 'pips_failed', v_pip_failed,
    'pips_dismissed', v_pip_dismissed, 'pips_unassessable', v_pip_unassessable,
    'sla_nudges', v_sla,
    'trust_proposals', coalesce(v_prop, '{}'::jsonb),
    'eligible_promotions', coalesce(v_elig, '{}'::jsonb));
end;
$function$;

-- ── verification ────────────────────────────────────────────────────────────
do $verify$
declare
  v_bad             text[] := '{}';
  v_checks          int := 0;
  v_src_sweep       text;
  v_src_elig        text;
  v_src_detect      text;
  v_subject         uuid;
  v_subject_tenant  uuid;
  v_run1            jsonb;
  v_run2            jsonb;
  v_orph_before     bigint := -1;
  v_orph_after      bigint := -1;
  v_pending_tasks   bigint := -1;
  v_detector_hits   bigint := -1;
  v_raised_ids      uuid[];
  v_fixture         text := 'not-run';
begin
  -- Comments stripped before every source match, this repo's own convention
  -- (828 PROBE 7, trust-proposer-boundary's live_fns CTE): without it a probe
  -- matches its own prose and can never fail.
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_src_sweep
    from pg_proc where proname = 'de_governance_sweep_internal' and pronamespace = 'public'::regnamespace;
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_src_elig
    from pg_proc where proname = 'request_eligible_promotions' and pronamespace = 'public'::regnamespace;
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_src_detect
    from pg_proc where proname = 'detect_trust_widening_patterns' and pronamespace = 'public'::regnamespace;

  ----------------------------------------------------------------------
  -- PROBE 1 -- THE POINT OF THIS MIGRATION: the sweep names BOTH writers.
  -- Two separate comparisons, never one combined test: an arm that checks
  -- only the pair would go green again the moment somebody deleted both,
  -- and an arm that checks only the new one would not have caught the
  -- defect this file exists for (which was exactly "the old one is there,
  -- the new one is not").
  ----------------------------------------------------------------------
  v_checks := v_checks + 1;
  if coalesce(v_src_sweep, '') !~ 'request_eligible_promotions' then
    v_bad := array_append(v_bad, 'de_governance_sweep_internal does not call request_eligible_promotions -- the eligibility writer is built and starved, which is the whole defect this migration fixes');
  end if;

  v_checks := v_checks + 1;
  if coalesce(v_src_sweep, '') !~ 'raise_trust_widening_proposals' then
    v_bad := array_append(v_bad, 'de_governance_sweep_internal no longer calls raise_trust_widening_proposals -- this migration must ADD a writer, never replace one');
  end if;

  ----------------------------------------------------------------------
  -- PROBE 2 -- NEITHER WRITER CAN DOUBLE-RAISE, asserted at each one's
  -- own guard. PROBE 4 drives the behaviour; this is the mechanism check
  -- that stays true on an empty database, where no behaviour exists to
  -- drive.
  ----------------------------------------------------------------------
  v_checks := v_checks + 1;
  if coalesce(v_src_elig, '') !~ 'pending_task_id is not null' then
    v_bad := array_append(v_bad, 'request_eligible_promotions no longer skips a policy that already has an open request -- its half of the no-double-raise guarantee is gone');
  end if;

  v_checks := v_checks + 1;
  if coalesce(v_src_detect, '') !~ 'not exists' or coalesce(v_src_detect, '') !~ 'pending_task_id' then
    v_bad := array_append(v_bad, 'detect_trust_widening_patterns no longer blocks a candidate chain that already carries an open proposal -- the detector''s half of the no-double-raise guarantee is gone');
  end if;

  ----------------------------------------------------------------------
  -- PROBE 3 -- the new step is OBSERVABLE. A caller reading the sweep's
  -- return payload can tell whether (f) ran and what it did; without the
  -- key, a step that silently raised nothing looks the same as a step
  -- that is not there.
  ----------------------------------------------------------------------
  -- ⚠ MATCHED AS A QUOTED KEY, not as a bare identifier, and the first draft
  -- of this arm got that wrong: `src ~ 'eligible_promotions'` is satisfied by
  -- the CALL to request_eligible_promotions, which contains that substring.
  -- Proven by inversion -- deleting the return key entirely left the arm
  -- GREEN, a checker that could not fail. The pattern below carries the
  -- opening quote and the trailing comma, which the call site does not have.
  v_checks := v_checks + 1;
  if position('''eligible_promotions'',' in coalesce(v_src_sweep, '')) = 0 then
    v_bad := array_append(v_bad, 'the sweep''s return payload does not name eligible_promotions -- the new step reports nothing and "it raised none" is indistinguishable from "it never ran"');
  end if;

  ----------------------------------------------------------------------
  -- PROBES 4/5/6 -- the BEHAVIOURAL half, inside a subtransaction that
  -- ALWAYS unwinds.
  --
  -- Subject DISCOVERED, never hardcoded: an eligible policy that already
  -- carries an open request. Clearing that request inside the fixture is
  -- what makes the writer have something to raise -- by apply time 828's
  -- own verify block has already consumed the only genuinely
  -- eligible-and-unrequested policy, so without the fixture every arm
  -- below would be vacuous and say nothing at all. Absence of a subject
  -- is a notice, never a finding: on an empty database there is nothing
  -- to drive and PROBEs 1-3 carry the denominator.
  --
  -- ⚠ NOTHING HERE REACHES THE COMMIT. The outer block raises a sentinel
  -- after its measurements, which unwinds every row the writers created
  -- and restores the request this fixture cleared. PL/pgSQL variables are
  -- not transactional, so the measurements survive the rollback that
  -- discards the rows they describe.
  ----------------------------------------------------------------------
  select p.id, p.tenant_id into v_subject, v_subject_tenant
    from public.trust_policies p
   where p.pending_task_id is not null
     and coalesce((public.trust_evidence_for(p)->>'eligible')::boolean, false)
   order by p.id
   limit 1;

  if v_subject is null then
    raise notice '834 PROBES 4/5/6: no eligible policy with an open request exists -- the idempotence, orphan and detector-collision arms are UNEXERCISED on this dataset. PROBEs 1-3 (5 assertions) still ran.';
  else
    begin
      update public.trust_policies
         set pending_task_id = null, pending_evidence = null,
             requested_by = null, requested_at = null
       where id = v_subject;

      -- Counted AFTER the clearing, so the orphan this fixture itself
      -- creates (the human_tasks row the cleared policy used to point at)
      -- is inside the baseline and cannot be charged to a writer.
      select count(*) into v_orph_before
        from public.human_tasks ht
       where ht.type = 'trust_promotion' and ht.status = 'pending'
         and not exists (select 1 from public.trust_policies tp where tp.pending_task_id = ht.id);

      v_run1 := public.request_eligible_promotions(null);

      select array_agg(p.id) into v_raised_ids
        from public.trust_policies p
       where p.pending_task_id is not null
         and p.requested_at >= now() - interval '1 second';

      -- THE IDEMPOTENCE RUN. Same call, same transaction, nothing else
      -- changed: everything run 1 raised must come back as skipped, and
      -- nothing may be raised twice.
      v_run2 := public.request_eligible_promotions(null);

      select count(*) into v_orph_after
        from public.human_tasks ht
       where ht.type = 'trust_promotion' and ht.status = 'pending'
         and not exists (select 1 from public.trust_policies tp where tp.pending_task_id = ht.id);

      select count(*) into v_pending_tasks
        from public.human_tasks where type = 'trust_promotion' and status = 'pending';

      -- Does the OTHER writer still consider a just-raised policy a
      -- candidate? Asked of the detector directly rather than of
      -- raise_trust_widening_proposals, so a zero here means "no candidate
      -- survived the chain-block", not "the writer happened to raise none".
      select count(*) into v_detector_hits
        from public.detect_trust_widening_patterns(null) d
       where d.policy_id = any(coalesce(v_raised_ids, '{}'::uuid[]));

      v_fixture := 'ran';
      raise exception 'ZZ_834_FIXTURE_ROLLBACK';
    exception when others then
      if sqlerrm <> 'ZZ_834_FIXTURE_ROLLBACK' then
        v_fixture := 'fixture-error: ' || sqlerrm;
      end if;
    end;

    if v_fixture <> 'ran' then
      v_checks := v_checks + 1;
      v_bad := array_append(v_bad, format('PROBEs 4/5/6: the fixture did not complete -- %s', v_fixture));
    else
      ------------------------------------------------------------------
      -- PROBE 4 -- run 1 actually raised something (or the two arms below
      -- compare nothing), and run 2 raised NOTHING while skipping at
      -- least what run 1 raised.
      ------------------------------------------------------------------
      v_checks := v_checks + 1;
      if coalesce((v_run1->>'requested')::int, 0) < 1 then
        v_bad := array_append(v_bad, format(
          'PROBE 4: run 1 raised %s requests on a policy discovered as eligible-with-its-request-cleared -- the idempotence comparison below would have nothing to compare. run1=%s',
          v_run1->>'requested', v_run1));
      end if;

      v_checks := v_checks + 1;
      if coalesce((v_run2->>'requested')::int, -1) <> 0 then
        v_bad := array_append(v_bad, format(
          'PROBE 4: run 2 raised %s further request(s) for policies run 1 had just raised -- a policy can be double-raised. run1=%s run2=%s',
          v_run2->>'requested', v_run1, v_run2));
      end if;

      v_checks := v_checks + 1;
      if coalesce((v_run2->>'skipped_existing')::int, -1)
         < coalesce((v_run1->>'requested')::int, 0) then
        v_bad := array_append(v_bad, format(
          'PROBE 4: run 2 skipped %s policies but run 1 raised %s -- the skip is not seeing every request the previous run opened',
          v_run2->>'skipped_existing', v_run1->>'requested'));
      end if;

      ------------------------------------------------------------------
      -- PROBE 5 -- NO NEW ORPHANS. An overwrite (the real shape of a
      -- double-raise) strands the previous task pending with no policy
      -- pointing back. Measured as a DELTA around the writers only.
      ------------------------------------------------------------------
      v_checks := v_checks + 1;
      if v_orph_after > v_orph_before then
        v_bad := array_append(v_bad, format(
          'PROBE 5: orphaned pending trust_promotion tasks rose from %s to %s across two writer runs (of %s pending) -- a request overwrote another request''s task id',
          v_orph_before, v_orph_after, v_pending_tasks));
      end if;

      ------------------------------------------------------------------
      -- PROBE 6 -- the detector declines a policy the eligibility writer
      -- just took. Denominator is stated out loud: it is the number of
      -- policies run 1 raised on, and zero of them may still be offered.
      ------------------------------------------------------------------
      v_checks := v_checks + 1;
      if v_detector_hits <> 0 then
        v_bad := array_append(v_bad, format(
          'PROBE 6: detect_trust_widening_patterns still offers %s of the %s policy/policies request_eligible_promotions just raised on -- the chain-block did not see the new request and the sweep would raise a second proposal for the same policy',
          v_detector_hits, coalesce(array_length(v_raised_ids, 1), 0)));
      end if;
    end if;
  end if;

  ----------------------------------------------------------------------
  if array_length(v_bad, 1) > 0 then
    raise exception E'834 VERIFICATION FAILED (% assertions):\n  %',
      v_checks, array_to_string(v_bad, E'\n  ');
  end if;

  raise notice '834: % assertions, 0 findings. wiring: both writers named in the sweep body. fixture=%, run1_requested=%, run2_requested=%, run2_skipped=%, orphans %->% of % pending, detector_still_offers=% of % just-raised.',
    v_checks, v_fixture,
    coalesce(v_run1->>'requested', 'n/a'), coalesce(v_run2->>'requested', 'n/a'),
    coalesce(v_run2->>'skipped_existing', 'n/a'),
    v_orph_before, v_orph_after, v_pending_tasks,
    v_detector_hits, coalesce(array_length(v_raised_ids, 1), 0);
end;
$verify$;

commit;
