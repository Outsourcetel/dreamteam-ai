-- 837_a_refusal_that_leaves_a_record.sql
-- ============================================================================
-- Two governance controls in apply_trust_promotion produced NOTHING, because
-- the statement after them erased their own effect.
--
--   1. The self-approval block calls append_audit_event(...
--      'trust_promotion_blocked_self_approval' ...) and then, in the very next
--      statement, `raise exception`. The raise aborts the transaction that
--      wrote the audit row. src/lib/trustApi.ts calls this RPC directly -- one
--      statement, one implicit transaction -- so in production a blocked
--      self-approval left NO TRACE AT ALL. The guard worked; the evidence that
--      it fired did not exist.
--
--   2. The stale path's `update trust_policies set pending_task_id = null, ...`
--      is undone the same way by `raise exception 'evidence regressed since
--      the request...'`, so that path never actually cleared the pending state
--      it exists to clear -- AND lost its own trust_promotion_stale audit row
--      with it. (The brief for this task named only the UPDATE. The audit row
--      goes too; measured below.)
--
-- This is the project_dead_governance_controls class: a control that appears
-- wired and produces nothing.
--
-- ── MEASURED, NOT REASONED ABOUT ───────────────────────────────────────────
-- Proven against PRODUCTION on 2026-08-21 in an always-aborting transaction,
-- as an A/B with the cause isolated to one line. Same function, same
-- append_audit_event, same tenant, same statement -- the only difference
-- between arms is whether a raise follows the write:
--
--   ARM 1  self-approval, RAISES   trust_promotion_blocked_self_approval  0 -> 0
--   ARM 2  non-self,      RETURNS  trust_promoted                         0 -> 1
--   ARM 3  stale,         RAISES   trust_promotion_stale                  0 -> 0
--          ...and pending_task_id after the stale refusal was still the
--          fixture's task id, i.e. the cleanup UPDATE was rolled back.
--   ARM 3c the identical UPDATE with no raise after it  -> reads back NULL
--
-- ARM 2 and ARM 3c are CONTROLS and both fired positive, so "delta 0" above is
-- a fact about the raise and not about a broken counting method.
--
-- ── WHY THE REFUSAL NOW TRAVELS AS A VALUE ─────────────────────────────────
-- A raise inside a Postgres function cannot both abort and leave a durable
-- write on the same transaction. There is no arrangement of statements that
-- gets both -- PL/pgSQL's exception handler rolls back to the savepoint taken
-- at the block's BEGIN, which is always BEFORE the audit write. So the only
-- real question is which side gives: the record, or the exception. Three
-- options were weighed and two rejected on their merits.
--
--   REJECTED -- "record it through a channel that survives the abort."
--   Postgres has no autonomous transactions. What survives a rollback is the
--   server log (RAISE LOG: not tamper-evident, not tenant-queryable, not
--   audit_events -- so it is not the governance record the control is supposed
--   to produce), sequences (no content), or a second connection via
--   dblink/pg_background. The last is disqualified on its own merits here:
--   append_audit_event takes pg_advisory_xact_lock and extends a TAMPER-
--   EVIDENT HASH CHAIN through audit_chain_state. Writing a link from a
--   separate, concurrent transaction is exactly the shape that forked that
--   chain once already (see mig 549, cited in append_audit_event's own
--   comments). Trading a lost row for a forked audit chain is a worse deal.
--
--   REJECTED -- "split the check so the audit write commits first."
--   One RPC is one transaction, so committing first means a SECOND round trip,
--   which means the recording step becomes a separate callable the enforcement
--   does not depend on. That is the two-paths-one-counted trap from
--   project_debt_map_and_traps: skip the pre-flight and the guard still
--   refuses while the record simply never exists. Moving the write to the
--   client is worse still -- append_audit_event rewrites a non-service_role
--   caller's actor to their own profile name and forces actor_type='human'
--   (read live from pg_get_functiondef, not assumed), so a client-written
--   "blocked" row would be attributed to the blocked user as a human action.
--
--   CHOSEN -- the refusal returns instead of raising, and the throw is
--   re-established one layer up in src/lib/trustApi.ts.
--   The raise was never buying atomicity: decide_human_task is a SEPARATE RPC
--   in a SEPARATE transaction that has already committed the task decision by
--   the time this hook runs (src/lib/customerApi.ts, hook #4). All the raise
--   ever bought was that the TS promise rejects -- and that is reproducible on
--   the value channel. The call surface is exactly one wrapper
--   (trustApi.resolveTrustPromotion) and one consumer (customerApi hook #4).
--   Enumerated, not assumed: a pg_proc scan for functions whose prosrc calls
--   apply_trust_promotion returns ZERO rows, and supabase/functions contains
--   no reference to it. Grep of calls, not definitions.
--
-- ⚠ THE GUARD LOGIC IS UNTOUCHED, and this migration pins that. The condition
-- `requested_by is not null and auth.uid() = v_policy.requested_by` and both
-- refusal MESSAGES are byte-for-byte what production ran a minute ago -- the
-- body below was generated by rewriting pg_get_functiondef's own output with
-- exactly two substitutions, never retyped. Only the durability of the record
-- changed. The promotion is refused exactly as before, and refused for exactly
-- the same reason.
--
-- ── THE HAZARD THIS INTRODUCES, AND HOW IT IS ANSWERED ─────────────────────
-- A refusal in the PAYLOAD is this repo's own named anti-pattern
-- (project_payload_refusal_sweep): a 200 that a caller sails past. The answer
-- is not a promise -- it is to make the change VISIBLE TO THE MACHINE THAT
-- HUNTS THAT CLASS. scripts/audit-silent-refusals.mjs (run by `npm run
-- certify`) finds refusing functions by the literal `'ok', false` in the
-- function definition, and clears a wrapper as `converts` when it does
-- `ok === false ... throw`. So the two refusal paths return
-- `'applied', false, 'ok', false, ...` and resolveTrustPromotion converts that
-- back to a throw. From now on, deleting that throw is a certify failure.
--
-- `ok` is emitted ONLY on the two refusal paths. The success path, the
-- `rejected` path and `no_pending_policy` are byte-identical to what they were
-- -- so no path outside this task's scope changes behaviour, and no new field
-- has to lie about a path it was not written for. (`no_pending_policy` IS a
-- refusal the caller currently ignores; it is named here and deliberately left
-- alone rather than quietly widened into this change.)
--
-- ⚠ ORDERING, AND WHY 830 WAS APPLIED FIRST. Migration 830's PROBE 1 asserts
-- that a self-approval RAISES -- which is exactly what 837 stops doing. So
-- applying 837 first would make 830 fail with "returned without raising". 830
-- was NOT edited to accommodate this: it is another task's committed proof, and
-- rewriting somebody else's evidence to fit a later change is the wrong
-- instinct. It was APPLIED first instead (dry-run clean, then applied
-- 2026-08-21 11:53:35Z, ledger row recorded), so it is now permanently past
-- and can never meet this body. Filename order is also replay order, so an
-- environment rebuilt from history gets the same sequence for free: 830 runs
-- against a function that still raises, passes, and only then does 837 change
-- it.
--
-- ⚠ THE FIRST DRAFT OF THIS FILE WAS NOT REPLAYABLE, AND THE REPO CAUGHT IT.
-- Three grant assertions in the verification block below (proacl not NULL, no
-- PUBLIC EXECUTE, no anon EXECUTE) failed the `npm run audit:replayable`
-- dry-run against dev. They looked like schema assertions and were not:
-- CREATE OR REPLACE PRESERVES privileges, so they described the perimeter the
-- database already had rather than anything 837 installs. That is the 778/789/
-- 790 defect wearing schema clothes. They are removed, and the real dev
-- finding they surfaced is written down at the site rather than deleted along
-- with the code that found it. See that comment for the details.
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.apply_trust_promotion(p_task_id uuid, p_decision text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_policy    trust_policies;
  v_evidence  jsonb;
  v_new       integer;
  v_label     text;
  v_is_active boolean;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;

  select * into v_policy from trust_policies where pending_task_id = p_task_id;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_pending_policy');
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() and tenant_id = v_policy.tenant_id;
    if v_is_active is null or not v_is_active then
      raise exception 'not a member of this tenant';
    end if;
  end if;

  v_label := replace(v_policy.action_category, '_', ' ');

  if p_decision = 'rejected' then
    update trust_policies
    set pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
    where id = v_policy.id;
    perform append_audit_event(
      v_policy.tenant_id, 'You', 'human',
      format('Trust promotion rejected — %s stays at level %s', v_label, v_policy.current_level),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_rejected', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'level', v_policy.current_level,
        'task_id', p_task_id, 'decided_by', auth.uid())
    );
    return jsonb_build_object('applied', false, 'reason', 'rejected');
  end if;

  -- Self-approval block: the requester cannot approve their own promotion.
  if v_policy.requested_by is not null and auth.uid() = v_policy.requested_by then
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion blocked — requester cannot approve their own request (%s)', v_label),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_blocked_self_approval', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'task_id', p_task_id, 'user_id', auth.uid())
    );
    -- ⚠ 837: THE REFUSAL TRAVELS AS A VALUE, NOT AN EXCEPTION.
    -- A raise here rolled the append_audit_event above back with it, so the
    -- blocked attempt left no trace. Measured on production 2026-08-21:
    -- blocked_self_approval rows 0 -> 0 across a real refusal, while the same
    -- function's trust_promoted write on the non-self path went 0 -> 1.
    -- The message is kept BYTE-FOR-BYTE and moved into the payload;
    -- trustApi.resolveTrustPromotion turns ok:false back into a thrown error,
    -- so the person still sees this exact sentence.
    return jsonb_build_object('applied', false, 'ok', false, 'reason', 'self_approval_blocked',
      'message', 'the requester cannot approve their own promotion — a different teammate must approve');
  end if;

  -- Stale-check: evidence could have regressed since the request.
  v_evidence := trust_evidence_for(v_policy);
  if not coalesce((v_evidence->>'eligible')::boolean, false) then
    update trust_policies
    set pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
    where id = v_policy.id;
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion rejected as stale — %s evidence regressed since the request', v_label),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_stale', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'task_id', p_task_id,
        'evidence_at_request', v_policy.pending_evidence, 'evidence_at_apply', v_evidence)
    );
    -- ⚠ 837: same reason as the self-approval path above. The raise that used
    -- to sit here also rolled back the cleanup UPDATE eight lines up, so the
    -- stale path never actually cleared the pending state it exists to clear
    -- (measured: pending_task_id still set after the refusal), and its
    -- trust_promotion_stale audit row was lost with it.
    return jsonb_build_object('applied', false, 'ok', false, 'reason', 'stale',
      'message', 'evidence regressed since the request — promotion rejected as stale');
  end if;

  v_new := least(v_policy.current_level + 1, v_policy.max_level);
  -- GI-3: scope the dial write to THIS employee (v_policy.de_id) — a NULL de_id
  -- keeps the historical tenant-wide behavior for tenant-scoped policies.
  perform trust_apply_level(v_policy.tenant_id, v_policy.action_category, v_new, auth.uid(), v_policy.source_category, v_policy.de_id);

  update trust_policies
  set current_level = v_new,
      pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
  where id = v_policy.id;

  perform append_audit_event(
    v_policy.tenant_id, 'You', 'human',
    format('Trust promoted — %s level %s → %s (evidence re-verified at apply time; still capped by guardrails)',
      v_label, v_policy.current_level, v_new),
    'config_change',
    jsonb_build_object('kind', 'trust_promoted', 'policy_id', v_policy.id,
      'action_category', v_policy.action_category, 'de_id', v_policy.de_id,
      'from_level', v_policy.current_level,
      'to_level', v_new, 'task_id', p_task_id, 'approved_by', auth.uid(),
      'requested_by', v_policy.requested_by, 'evidence', v_evidence,
      'dial_settings', trust_ladder_settings(v_policy, v_new),
      'composition', 'autonomy_narrows_within_guardrails')
  );

  return jsonb_build_object('applied', true, 'new_level', v_new);
end;
$function$;

-- ============================================================================
-- VERIFICATION
--
-- ⚠ A CHECKER THAT CANNOT FAIL IS THEATRE, so the denominator is printed and
-- the arms are inverted. The SCHEMA ARM runs FIRST and UNCONDITIONALLY: it is
-- a statement about what this migration just installed, so it is comparable on
-- EVERY database -- including an empty one, where it is the only comparison
-- made and the denominator is 7, never 0.
--
-- The DATA ARMS need a real tenant with two distinct active members (never a
-- forged auth.users row -- CLAUDE.md; profiles.user_id carries a NOT NULL FK
-- to auth.users). Where none exists they make ZERO comparisons and SAY SO,
-- rather than passing vacuously in silence.
--
-- THE INVERSION IS NOT DECORATIVE: this exact block was dry-run against the
-- UNFIXED function before this file was applied, and reported
--   'ARM 1 ... the audit row did NOT survive the refusal (delta 0)'
--   'ARM 2 ... the cleanup UPDATE did NOT survive (pending_task_id still set)'
-- -- i.e. RED on the defect and green on the fix, same assertions both times.
-- See task report. A pass here is therefore a measurement, not a formality.
--
-- Every fixture write, and every row apply_trust_promotion writes while being
-- driven, is undone before commit by the __undo_probe_837__ sentinel -- NOT by
-- DELETE, because audit_events carries audit_events_no_update_delete and
-- rewriting a tamper-evident chain to make a checker tidy is the anti-pattern
-- this repo already rejected once (project_audit_chain_false_break). PL/pgSQL
-- variables are not table state and survive the unwind, so the results are
-- still assertable afterwards.
-- ============================================================================
do $verify$
declare
  v_src        text;
  v_checks     int  := 0;
  v_bad        text[] := '{}';
  v_ran        boolean := false;

  v_guard_cond text := 'requested_by\s+is\s+not\s+null\s+and\s+auth\.uid\(\)\s*=\s*v_policy\.requested_by';
  v_guard_msg  text := 'the requester cannot approve their own promotion — a different teammate must approve';
  v_stale_msg  text := 'evidence regressed since the request — promotion rejected as stale';

  v_tenant     uuid;
  v_uids       uuid[];
  v_requester  uuid;
  v_other      uuid;
  v_crit_ok    jsonb := jsonb_build_object('min_eval_samples',0,'min_eval_pass_rate',0,
                        'min_human_samples',0,'min_human_approval_rate',0,'max_guardrail_blocks',2000000000);
  v_crit_bad   jsonb := jsonb_build_object('min_eval_samples',2000000000,'min_eval_pass_rate',0,
                        'min_human_samples',0,'min_human_approval_rate',0,'max_guardrail_blocks',2000000000);

  v_pol_self uuid; v_pol_stale uuid; v_pol_ctrl uuid;
  v_task_self uuid; v_task_stale uuid; v_task_ctrl uuid;
  v_row public.trust_policies;
  v_ev_self jsonb; v_ev_stale jsonb; v_ev_ctrl jsonb;

  v_res_self  jsonb; v_raised_self  boolean := false; v_err_self  text;
  v_res_stale jsonb; v_raised_stale boolean := false; v_err_stale text;
  v_res_ctrl  jsonb; v_raised_ctrl  boolean := false; v_err_ctrl  text;

  n_self int; n_stale int; n_ctrl int;
  s_level int; s_pending uuid;
  t_level int; t_pending uuid;
  c_level int; c_pending uuid;
begin
  ----------------------------------------------------------------------
  -- SCHEMA ARM -- 7 comparisons, data-independent, always available. Every one
  -- is about what THIS migration installs, which is what makes them safe to
  -- assert on any database (see the removed grant arms below).
  -- Comments are stripped first so a check cannot match this migration's
  -- own prose instead of the live code (this repo's convention -- see
  -- scripts/trust-proposer-boundary.mjs's live_fns CTE).
  ----------------------------------------------------------------------
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g'), proacl::text
    into v_src
    from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'apply_trust_promotion';

  v_checks := v_checks + 1;
  if v_src is null then
    v_bad := array_append(v_bad, 'SCHEMA: public.apply_trust_promotion does not exist -- nothing below can be governed by a function that was never installed.');
  else
    -- The guard LOGIC must be exactly what it was. This migration changed the
    -- durability of the record, never the decision.
    v_checks := v_checks + 1;
    if v_src !~ v_guard_cond then
      v_bad := array_append(v_bad, 'SCHEMA: the self-approval condition (requested_by is not null and auth.uid() = requested_by) is gone or was rewritten -- 837 must not touch the guard logic.');
    end if;

    v_checks := v_checks + 1;
    if position(v_guard_msg in v_src) = 0 then
      v_bad := array_append(v_bad, format('SCHEMA: the self-approval message is no longer present byte-for-byte (%s).', v_guard_msg));
    end if;

    v_checks := v_checks + 1;
    if position(v_stale_msg in v_src) = 0 then
      v_bad := array_append(v_bad, format('SCHEMA: the stale message is no longer present byte-for-byte (%s).', v_stale_msg));
    end if;

    -- THE FIX ITSELF, asserted as the ABSENCE of the two raises.
    v_checks := v_checks + 1;
    if v_src ~ 'raise\s+exception\s+''the requester cannot approve' then
      v_bad := array_append(v_bad, 'SCHEMA: the self-approval path still RAISES -- the audit row it writes one statement earlier is rolled back with it, which is the whole defect 837 exists to close.');
    end if;

    v_checks := v_checks + 1;
    if v_src ~ 'raise\s+exception\s+''evidence regressed since the request' then
      v_bad := array_append(v_bad, 'SCHEMA: the stale path still RAISES -- its cleanup UPDATE and its trust_promotion_stale audit row are rolled back with it.');
    end if;

    -- The hook scripts/audit-silent-refusals.mjs keys on. If this literal
    -- goes, that auditor stops seeing this function AS a refuser and the
    -- wrapper's `ok === false -> throw` stops being checked by anything.
    v_checks := v_checks + 1;
    if v_src !~ '''ok'', false' then
      v_bad := array_append(v_bad, 'SCHEMA: the literal "''ok'', false" is gone from apply_trust_promotion -- scripts/audit-silent-refusals.mjs finds refusing functions by exactly that string, so this function just became invisible to the one checker that guards the payload-refusal class.');
    end if;

    -- ⚠ THREE GRANT ASSERTIONS USED TO SIT HERE AND WERE REMOVED. They
    -- checked that proacl is not NULL, that PUBLIC holds no EXECUTE, and that
    -- anon holds none either. They were wrong to be in this file, and
    -- `npm run audit:replayable` caught it before this migration was final:
    -- CREATE OR REPLACE *preserves* privileges, so those lines described the
    -- perimeter this database ALREADY HAD rather than anything 837 installs.
    -- On dev, where apply_trust_promotion's grants were never hardened, they
    -- failed -- which is the very defect this repo's replayability rule names,
    -- just wearing schema clothes: an assertion is only safely "about schema"
    -- when the migration itself put that schema there.
    --
    -- ⚠ AND THE DEV FINDING IS REAL, NOT AN ARTEFACT -- named here rather than
    -- silently dropped with the code that found it. On the dev project
    -- apply_trust_promotion has a NULL proacl (which is not "no grants" but
    -- the DEFAULT grant, i.e. EXECUTE to PUBLIC) and anon holds EXECUTE. That
    -- is a genuine hole of the security_default_execute_grant shape. It is NOT
    -- fixed here: hardening dev's grant perimeter is not what this task was
    -- asked to do, and doing it as a side effect of a durability fix is
    -- exactly the quiet widening CLAUDE.md forbids. It is reported instead.
    -- Production is unaffected -- measured 2026-08-21, before and after this
    -- migration: {postgres=X/postgres,service_role=X/postgres,
    -- authenticated=X/postgres}, no PUBLIC entry and no anon.
  end if;

  ----------------------------------------------------------------------
  -- DATA ARMS
  ----------------------------------------------------------------------
  select p.tenant_id into v_tenant
    from public.profiles p join public.tenants t on t.id = p.tenant_id
   where p.layer = 'tenant' and coalesce(p.is_active, true) and t.status in ('active','trial')
   group by p.tenant_id having count(distinct p.user_id) >= 2
   order by p.tenant_id limit 1;

  if v_tenant is not null then
    select array_agg(x.user_id order by x.user_id) into v_uids
      from (select distinct p.user_id from public.profiles p
             where p.tenant_id = v_tenant and p.layer = 'tenant' and coalesce(p.is_active, true)
             order by p.user_id limit 2) x;
    v_requester := v_uids[1];
    v_other     := v_uids[2];
  end if;

  if v_tenant is null or v_requester is null or v_other is null then
    raise notice '837: VACUITY -- no tenant with 2 distinct active tenant-layer members exists here, so the three data arms make ZERO comparisons. That is the honest result on an empty database, not a manufactured pass. The schema arm above is NOT vacuous and already ran.';
  else
    v_ran := true;
    begin
      ------------------------------------------------------------------
      -- FIXTURES. Criteria are engineered so eligibility is DETERMINISTIC
      -- and cannot be flipped by this tenant's real evidence history.
      -- action_category strings are probe-only and cannot collide with a
      -- real policy. origin='exercise' keeps evidence_is_production false,
      -- so these rows cannot be counted as evidence for any other policy
      -- during the moment they exist.
      ------------------------------------------------------------------
      insert into public.trust_policies (tenant_id,de_id,action_category,current_level,max_level,status,criteria)
      values (v_tenant,null,'zz_probe_837_self',0,3,'active',v_crit_ok) returning id into v_pol_self;
      insert into public.trust_policies (tenant_id,de_id,action_category,current_level,max_level,status,criteria)
      values (v_tenant,null,'zz_probe_837_stale',0,3,'active',v_crit_bad) returning id into v_pol_stale;
      insert into public.trust_policies (tenant_id,de_id,action_category,current_level,max_level,status,criteria)
      values (v_tenant,null,'zz_probe_837_ctrl',0,3,'active',v_crit_ok) returning id into v_pol_ctrl;

      select * into v_row from public.trust_policies where id = v_pol_self;  v_ev_self  := public.trust_evidence_for(v_row);
      select * into v_row from public.trust_policies where id = v_pol_stale; v_ev_stale := public.trust_evidence_for(v_row);
      select * into v_row from public.trust_policies where id = v_pol_ctrl;  v_ev_ctrl  := public.trust_evidence_for(v_row);

      v_checks := v_checks + 1;
      if not coalesce((v_ev_self->>'eligible')::boolean,false)
         or not coalesce((v_ev_ctrl->>'eligible')::boolean,false)
         or coalesce((v_ev_stale->>'eligible')::boolean,false) then
        v_bad := array_append(v_bad, format(
          'FIXTURE BUG: engineered eligibility did not come out as designed (self=%s ctrl=%s stale=%s; wanted true/true/false) -- no arm below can be trusted until this is fixed.',
          v_ev_self->>'eligible', v_ev_ctrl->>'eligible', v_ev_stale->>'eligible'));
      end if;

      insert into public.human_tasks (tenant_id,type,title,detail,source,related_table,related_id,status,origin)
      values (v_tenant,'trust_promotion','Trust promotion — probe 837 (self-approval)',
              'Fixture for migration 837. Rolled back before commit.','system','trust_policies',v_pol_self,'pending','exercise')
      returning id into v_task_self;
      update public.trust_policies set pending_task_id=v_task_self, pending_evidence=v_ev_self,
             requested_by=v_requester, requested_at=now() where id=v_pol_self;

      -- requested_by = v_other, so the SELF-APPROVAL guard does NOT fire and
      -- the STALE path is the one v_requester reaches.
      insert into public.human_tasks (tenant_id,type,title,detail,source,related_table,related_id,status,origin)
      values (v_tenant,'trust_promotion','Trust promotion — probe 837 (stale)',
              'Fixture for migration 837. Rolled back before commit.','system','trust_policies',v_pol_stale,'pending','exercise')
      returning id into v_task_stale;
      update public.trust_policies set pending_task_id=v_task_stale, pending_evidence=v_ev_stale,
             requested_by=v_other, requested_at=now() where id=v_pol_stale;

      insert into public.human_tasks (tenant_id,type,title,detail,source,related_table,related_id,status,origin)
      values (v_tenant,'trust_promotion','Trust promotion — probe 837 (control)',
              'Fixture for migration 837. Rolled back before commit.','system','trust_policies',v_pol_ctrl,'pending','exercise')
      returning id into v_task_ctrl;
      update public.trust_policies set pending_task_id=v_task_ctrl, pending_evidence=v_ev_ctrl,
             requested_by=v_requester, requested_at=now() where id=v_pol_ctrl;

      ------------------------------------------------------------------
      -- ARM 1 -- a blocked self-approval must REFUSE, and its audit row
      -- must still be there afterwards. Counts are scoped to the fixture's
      -- own policy_id, so a concurrent session cannot move them.
      ------------------------------------------------------------------
      v_checks := v_checks + 1;
      begin
        perform set_config('request.jwt.claim.sub', v_requester::text, true);
        set local role authenticated;
        v_res_self := public.apply_trust_promotion(v_task_self,'approved');
        reset role;
      exception when others then
        reset role; v_raised_self := true; v_err_self := sqlerrm;
      end;
      select count(*) into n_self from public.audit_events
       where detail->>'policy_id' = v_pol_self::text
         and detail->>'kind' = 'trust_promotion_blocked_self_approval';
      select current_level, pending_task_id into s_level, s_pending
        from public.trust_policies where id = v_pol_self;

      if v_raised_self then
        v_bad := array_append(v_bad, format('ARM 1: the self-approval path still RAISED (%s) -- so its audit row is rolled back with it and the refusal still leaves no record.', v_err_self));
      elsif n_self <> 1 then
        v_bad := array_append(v_bad, format('ARM 1: the audit row did NOT survive the refusal -- expected exactly 1 trust_promotion_blocked_self_approval row for this policy, found %s.', n_self));
      end if;

      v_checks := v_checks + 1;
      if coalesce((v_res_self->>'applied')::boolean,false)
         or (v_res_self->>'ok') is distinct from 'false'
         or (v_res_self->>'reason') is distinct from 'self_approval_blocked'
         or (v_res_self->>'message') is distinct from v_guard_msg then
        v_bad := array_append(v_bad, format('ARM 1: the refusal payload is wrong -- got %s; expected applied:false, ok:false, reason:self_approval_blocked and the guard message verbatim. trustApi converts ok:false into a throw, so a wrong shape is a refusal the user is never shown.', v_res_self));
      end if;

      v_checks := v_checks + 1;
      if s_level <> 0 or s_pending is distinct from v_task_self then
        v_bad := array_append(v_bad, format('ARM 1: the refusal was not a refusal -- level is %s (expected 0) and pending_task_id is %s (expected the request to STAND at %s). Returning instead of raising must not let the promotion through.', s_level, s_pending, v_task_self));
      end if;

      ------------------------------------------------------------------
      -- ARM 2 -- the stale path must refuse, keep its audit row, AND
      -- actually clear the pending state it exists to clear.
      ------------------------------------------------------------------
      v_checks := v_checks + 1;
      begin
        perform set_config('request.jwt.claim.sub', v_requester::text, true);
        set local role authenticated;
        v_res_stale := public.apply_trust_promotion(v_task_stale,'approved');
        reset role;
      exception when others then
        reset role; v_raised_stale := true; v_err_stale := sqlerrm;
      end;
      select count(*) into n_stale from public.audit_events
       where detail->>'policy_id' = v_pol_stale::text
         and detail->>'kind' = 'trust_promotion_stale';
      select current_level, pending_task_id into t_level, t_pending
        from public.trust_policies where id = v_pol_stale;

      if v_raised_stale then
        v_bad := array_append(v_bad, format('ARM 2: the stale path still RAISED (%s) -- its cleanup UPDATE and its audit row go with it.', v_err_stale));
      elsif n_stale <> 1 then
        v_bad := array_append(v_bad, format('ARM 2: the audit row did NOT survive the refusal -- expected exactly 1 trust_promotion_stale row for this policy, found %s.', n_stale));
      end if;

      v_checks := v_checks + 1;
      if t_pending is not null then
        v_bad := array_append(v_bad, format('ARM 2: the cleanup UPDATE did NOT survive -- pending_task_id is still %s. The stale path is meant to drop the request; rolled back, it leaves it standing.', t_pending));
      end if;

      v_checks := v_checks + 1;
      if t_level <> 0
         or coalesce((v_res_stale->>'applied')::boolean,false)
         or (v_res_stale->>'ok') is distinct from 'false'
         or (v_res_stale->>'reason') is distinct from 'stale'
         or (v_res_stale->>'message') is distinct from v_stale_msg then
        v_bad := array_append(v_bad, format('ARM 2: stale refusal wrong -- level %s (expected 0), payload %s (expected applied:false, ok:false, reason:stale, the stale message verbatim).', t_level, v_res_stale));
      end if;

      ------------------------------------------------------------------
      -- ARM 3 (CONTROL) -- a legitimate approval by a non-requester must
      -- still work end to end. Required, not optional: if nobody can be
      -- promoted at all, ARM 1 and ARM 2 prove nothing. This is also the
      -- arm that proves the audit-counting method can see a row it should
      -- see -- 0 findings from an instrument that always reads 0 would be
      -- indistinguishable from a clean result.
      ------------------------------------------------------------------
      v_checks := v_checks + 1;
      begin
        perform set_config('request.jwt.claim.sub', v_other::text, true);
        set local role authenticated;
        v_res_ctrl := public.apply_trust_promotion(v_task_ctrl,'approved');
        reset role;
      exception when others then
        reset role; v_raised_ctrl := true; v_err_ctrl := sqlerrm;
      end;
      select count(*) into n_ctrl from public.audit_events
       where detail->>'policy_id' = v_pol_ctrl::text
         and detail->>'kind' = 'trust_promoted';
      select current_level, pending_task_id into c_level, c_pending
        from public.trust_policies where id = v_pol_ctrl;

      if v_raised_ctrl then
        v_bad := array_append(v_bad, format('CONTROL FAILED: a non-requester could not approve at all (%s) -- ARM 1 and ARM 2 above prove nothing if no promotion can ever succeed.', v_err_ctrl));
      else
        v_checks := v_checks + 1;
        if not coalesce((v_res_ctrl->>'applied')::boolean,false) or c_level <> 1 or c_pending is not null then
          v_bad := array_append(v_bad, format('CONTROL: the legitimate approval did not land -- payload %s, level 0 -> %s (expected 1), pending_task_id %s (expected null).', v_res_ctrl, c_level, c_pending));
        end if;
        v_checks := v_checks + 1;
        if n_ctrl <> 1 then
          v_bad := array_append(v_bad, format('CONTROL: expected exactly 1 trust_promoted audit row for this policy, found %s -- if the instrument cannot see a row that certainly exists, ARM 1 and ARM 2''s counts mean nothing.', n_ctrl));
        end if;
      end if;

      raise exception using errcode = 'P0001', message = '__undo_probe_837__';
    exception
      when sqlstate 'P0001' then
        reset role;
        if sqlerrm <> '__undo_probe_837__' then raise; end if;
    end;
  end if;

  ----------------------------------------------------------------------
  if array_length(v_bad,1) > 0 then
    raise exception E'837 VERIFICATION FAILED (% comparison(s) made, tenant %):\n  %',
      v_checks, v_tenant, array_to_string(v_bad, E'\n  ');
  end if;

  if v_ran then
    raise notice '837: % comparison(s), 0 findings (7 schema-level + the data arms). tenant=%. ARM 1 self-approval -> %, blocked_self_approval rows for the fixture policy = %, level/pending left at %/%. ARM 2 stale -> %, trust_promotion_stale rows = %, pending cleared to %. CONTROL non-self -> %, trust_promoted rows = %, level 0 -> %. Every fixture row and every row apply_trust_promotion wrote while being driven was unwound via __undo_probe_837__; nothing but the function replacement is committed by this migration. NOTE: db-query.mjs does not surface RAISE NOTICE -- this line is not visible on a real apply.',
      v_checks, v_tenant, v_res_self, n_self, s_level, s_pending,
      v_res_stale, n_stale, t_pending, v_res_ctrl, n_ctrl, c_level;
  else
    raise notice '837: % comparison(s), 0 findings -- SCHEMA ARM ONLY. No tenant with 2 distinct active tenant-layer members existed here, so the three data arms made zero comparisons. NOT the same claim as a run that exercised them.', v_checks;
  end if;
end;
$verify$;

commit;
