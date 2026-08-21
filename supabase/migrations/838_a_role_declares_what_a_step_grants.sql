-- 838_a_role_declares_what_a_step_grants.sql
-- ============================================================================
-- Task 3 of the trust-promotion program (plan: 2026-08-21-trust-promotion).
--
-- WHY: 828/830/831/832/834 built the machinery by which a digital employee can
-- ASK for a looser autonomy limit and a second human can approve it. Nothing in
-- that chain says what a step actually GRANTS. Measured on production before
-- this file was written: trust_policies.ladder is NULL on all 58 live policies,
-- so trust_ladder_settings falls through to trust_level_settings, where levels
-- 1, 2 and 3 are identical (enabled=true, max_amount_cents NULL). "Earning
-- level 2" is indistinguishable from earning level 1.
--
-- This migration installs the REFUSAL that closes that: promotion_is_possible.
-- It grants nothing. It only ever says no.
--
-- ============================================================================
-- ⚠⚠⚠ BLAST RADIUS -- READ THIS BEFORE APPLYING. THIS FILE STOPS EVERY
-- PROMOTION ON PRODUCTION UNTIL SOMEBODY DECLARES A LADDER.
-- ----------------------------------------------------------------------------
-- Measured live 2026-08-21, immediately before writing:
--   58 trust policies · 0 promoted (every current_level is 0)
--   0  policies carry a ladder (trust_policies.ladder IS NULL on all 58)
--   0  role_archetypes declare trust_signals; 15 archetypes, all active
--   2  policies are currently eligible -- and they are THE SAME TWO ROWS that
--      hold the 2 open promotion requests:
--        · action_execute, archetype fpa,        level 0 of 3, request open
--        · action_execute, archetype onboarding, level 0 of 1, request open
--
-- AFTER THIS APPLIES:
--  · Both open requests STAY OPEN and become UNAPPROVABLE. Pressing Approve
--    returns {applied:false, ok:false, reason:'promotion_not_possible'} with the
--    message "this promotion cannot be applied - this role has not declared what
--    a trust step grants...", which trustApi.resolveTrustPromotion throws to the
--    person (migration 837's contract). The level does not move, the request is
--    not consumed, and -- unlike before 837 -- the refusal leaves an audit row
--    (kind trust_promotion_blocked_not_possible) that survives, because it
--    returns instead of raising.
--  · REJECTING either request still works, unchanged. The guard sits after the
--    'rejected' branch precisely so a human can always clear the queue.
--  · The nightly eligibility sweep will now examine those 2, skip them, and SAY
--    SO in its return: skipped_no_ladder. It will not file new cards nobody can
--    action.
--  · No existing level, dial, de_autonomy row or guardrail changes. Zero rows
--    are written by this migration outside its own rolled-back probe fixture.
--
-- THE ESCAPE HATCH IS LIVE TODAY AND NEEDS NO NEW CODE: set_trust_ladder (mig
-- 458) is wired to the UI at src/lib/trustApi.ts and the employee file's Trust
-- section. An owner/admin/manager declares a ladder for a policy and that
-- policy becomes promotable in the same breath -- and now its levels mean
-- something, which is the entire point.
--
-- THIS IS THE INTENDED BEHAVIOUR, NOT A REGRESSION. Today a promotion turns
-- auto-execution ON for actions carrying no monetary amount, with no bound, and
-- does so identically at levels 1, 2 and 3. Refusing until a role has said what
-- the step grants is the guard, not a side effect.
-- ============================================================================
--
-- ── ⚠ TWO SPECIFICATION ERRORS IN THE TASK BRIEF, BOTH MEASURED ────────────
--
-- (1) THE BRIEF'S promotion_is_possible TESTS THE WRONG JSON TYPE. Its draft
--     reads `if v_p.ladder is null or jsonb_typeof(v_p.ladder) <> 'object'`.
--     trust_policies.ladder is an ARRAY, not an object -- enforced live by
--     `trust_policies_ladder_is_array CHECK ((ladder IS NULL) OR
--     (jsonb_typeof(ladder) = 'array'))` (mig 458), and independently by
--     validate_trust_ladder, which raises 'ladder must be a JSON array of
--     levels' on anything else. Shipped verbatim, the draft would return
--     possible=false for EVERY policy including a perfectly declared one --
--     the brief's own CONTROL probe would have failed. Corrected to 'array'.
--     This was not a judgment call: there is exactly one type the column can
--     hold, and two independent live objects agree on it.
--
--     The ROLE-level column added below IS an object -- {category: [ladder]} --
--     one level up, exactly as mig 831's trust_signals is. Both shapes are
--     right; the brief attached the object test to the wrong one of them.
--
-- (2) ⚠ THE INHERITANCE THE BRIEF ASKS FOR IS NOT IMPLEMENTED HERE, AND CANNOT
--     BE AT THE FUNCTION IT NAMES. The brief's Step 4 says "extend
--     instantiate_role_archetype_internal to copy a.trust_ladder into the
--     trust_policies.ladder of the rows it creates". That function creates NO
--     trust_policies rows. Read in full via pg_get_functiondef: it inserts one
--     digital_employees row, attaches compliance packs, and materialises
--     de_autonomy rows from autonomy_templates. The set of trust_policies rows
--     it creates is empty, so there is nothing to extend.
--
--     Every function that DOES insert into trust_policies was enumerated
--     (pg_proc scan for `insert into trust_policies`), four in total:
--       · seed_de_trust_policy(de_id, capability_key, display_name) -- the
--         per-employee, per-capability creator a manager calls. The only one of
--         the four with a resolvable role archetype. This is the seam the brief
--         probably meant.
--       · provision_starter_de_internal(tenant_id, feature_key) -- creates its
--         digital_employees row directly with NO archetype_key at all, so it
--         has nothing to inherit FROM. (These are the 8 live policies whose
--         employee has a null archetype.)
--       · seed_trust_policies() -- tenant-wide rows, de_id NULL, no employee
--         and therefore no role. 0 such rows exist today.
--       · verify_decide_discovery_proposal() -- a self-test.
--
--     Choosing among "extend seed_de_trust_policy", "a BEFORE INSERT trigger on
--     trust_policies covering all four paths", and "read the role through the
--     join at query time (mig 831's own precedent for the sibling column, which
--     it chose deliberately over copy-at-hire)" is a real design decision with
--     different blast radii, different snapshot risk, and -- for the third -- a
--     required change to trust_ladder_settings, an IMMUTABLE function on the
--     ENFORCEMENT path. That decision is returned to the coordinator rather
--     than guessed. Nothing here is blocked by it: the refusal below is
--     complete and correct on its own, and set_trust_ladder is a live,
--     UI-reachable way to declare a ladder today.
--
--     CONSEQUENCE, STATED PLAINLY: role_archetypes.trust_ladder lands with NO
--     READER. It is a declaration surface with its inheritance deliberately
--     unwired, and its column comment says so rather than claiming an
--     inheritance that does not exist. It is landed rather than deferred
--     because its shape is identical under all three candidate mechanisms.
--
-- ── WHERE THE REFUSAL BELONGS -- THE ENUMERATION ────────────────────────────
-- Asked of pg_proc, not of memory. Functions whose comment-stripped body
-- contains `set current_level`: exactly three.
--   · apply_trust_promotion(uuid, text)  -- promotes. THE writer.
--   · trust_demote(...)                  -- only ever moves DOWN.
--   · verify_decide_discovery_proposal() -- a self-test.
-- Direct table writes were checked too, not assumed away: aclexplode over
-- trust_policies shows UPDATE on current_level held ONLY by postgres and
-- service_role. `authenticated` and `anon` hold SELECT and REFERENCES and
-- nothing else, so no PostgREST client can move a level; the one RLS UPDATE
-- policy is scoped TO trust_pattern_proposer, the NOLOGIN sweep role, which
-- certify already pins to the four request-bookkeeping columns.
--
-- The three functions that OPEN a promotion request -- request_trust_promotion
-- (the human button), request_eligible_promotions (the criteria sweep) and
-- raise_trust_widening_proposals (the pattern detector) -- write no level at
-- all. Gating them is noise control. Gating apply_trust_promotion is the
-- refusal. Both of the first two named by the brief are done; the other two
-- request paths are deliberately LEFT and named in the report, because the
-- writer-side refusal already covers them and each extra live-function replace
-- is another stale-snapshot exposure for no enforcement gain.
--
-- ── ⚠ THE STALE-SNAPSHOT GUARD (following mig 834, which set this precedent) ─
-- This file CREATE OR REPLACEs two live functions from bodies snapshotted on
-- 2026-08-21. Anything a parallel session adds to either between then and apply
-- time would be silently overwritten -- not merged, not warned about, gone. 834
-- reproduced that failure rather than theorising it. The precheck below hashes
-- each live body (line comments stripped, whitespace collapsed, so a CRLF and
-- an LF checkout hash alike) and REFUSES on anything it was not written
-- against. Both the pre- and the post- body are accepted so a re-apply and a
-- replay stay green. SQLSTATE 55000 is deliberate, exactly as in 834: the
-- functions exist, so 42883 would lie, and this is not an assertion about rows
-- the environment lacks, so P0001 would make audit-migration-replayability
-- accuse this file of the one defect it is careful not to have.
--
-- Both replaced bodies were produced by SPLICING the live pg_get_functiondef
-- output -- a script that refuses unless each anchor matches exactly once --
-- and the resulting diffs were read before pasting: 2 hunks in
-- apply_trust_promotion (one declare line, one guard block), 3 in
-- request_eligible_promotions (one declare line, one guard block, one added
-- return key). Nothing else in either body was retyped. CREATE OR REPLACE, not
-- DROP + CREATE: both are owned by postgres and carry existing grants, and only
-- OR REPLACE preserves both.
--
-- ⚠⚠ THE GUARD ABOVE IS NOT A PRECAUTION -- IT FIRED, DURING THIS FILE'S OWN
-- FIRST DRY RUN, AND IT CHANGED WHAT THIS MIGRATION DOES.
-- apply_trust_promotion was snapshotted at 59169f5e1252c8162b3a229a40e3bfa6.
-- Minutes later the first dry run refused with 55000: the live body had become
-- d274a620cda5ffb8c0d64571efba05c1. A parallel session had applied migration
-- 837 (a_refusal_that_leaves_a_record, commit c852cb71) to the same function.
-- Without this guard, this file would have applied cleanly and SILENTLY
-- REVERTED 837 -- restoring, hours after it was removed, a defect 837 had
-- measured on production. That is the whole case for the guard, made by the
-- guard, on its first use.
--
-- WHAT 837 CHANGED, AND WHY THIS FILE NOW FOLLOWS IT. 837 proved that a
-- `raise exception` inside apply_trust_promotion rolls back the audit row
-- written one statement earlier, so a governed refusal produced no record at
-- all (blocked_self_approval 0 -> 0 across a real refusal, against a control
-- that moved 0 -> 1). Its fix: both sibling refusals now RETURN
-- {applied:false, ok:false, reason, message}, and trustApi.resolveTrustPromotion
-- puts the throw back on the client. An earlier draft of THIS file raised.
-- It no longer does -- raising would have reintroduced 837's defect in the same
-- function on the same day, and the new refusal's audit row is durable only
-- because it returns. The client half needs no change: that wrapper's gate is
-- `r?.ok === false`, so a third reason is covered by construction, and the
-- existing test asserts the gate rather than an exhaustive list of reasons.
--
-- ── NEVER HARDCODE A DEPARTMENT ─────────────────────────────────────────────
-- No role name, archetype key or department string appears in any executable
-- statement in this file. promotion_is_possible branches on nothing but the
-- policy's own columns. Roles declare; the platform reads. Probe fixtures are
-- prefixed 'zz_probe_838_' and are created and destroyed inside a subtransaction
-- that is deliberately rolled back, so they leave no row and no audit event.
-- ============================================================================

begin;

-- ── precondition: dependencies, then the two stale-snapshot hashes ──────────
do $precheck$
declare
  v_atp text;
  v_rep text;
  -- PRE  = the body this migration expects to FIND (measured on production
  --        2026-08-21). POST = the body it INSTALLS, accepted too so a
  --        re-apply or a replay reaching this file twice is not refused.
  c_atp_pre  constant text := 'd274a620cda5ffb8c0d64571efba05c1';
  c_atp_post constant text := '017312c97ee11ea8e76b3fbae55d7ee2';
  c_rep_pre  constant text := 'aad54521d0f1890f5b18e1528744060f';
  c_rep_post constant text := '7fa132df5da8b03828d7f1a0ebd9dd17';
begin
  if to_regprocedure('public.validate_trust_ladder(jsonb,boolean,boolean,integer)') is null then
    raise exception 'PRECONDITION FAILED: public.validate_trust_ladder(jsonb,boolean,boolean,integer) does not exist -- migration 458 has not been applied. promotion_is_possible delegates every shape and monotonicity question to it and would raise 42883 on the first ladder it saw.'
      using errcode = 'undefined_function';
  end if;
  if to_regprocedure('public.request_eligible_promotions(uuid)') is null then
    raise exception 'PRECONDITION FAILED: public.request_eligible_promotions(uuid) does not exist -- migration 828 has not been applied. This file replaces that function.'
      using errcode = 'undefined_function';
  end if;

  select md5(btrim(regexp_replace(
           regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g'),
           '\s+', ' ', 'g')))
    into v_atp
    from pg_proc
   where proname = 'apply_trust_promotion' and pronamespace = 'public'::regnamespace;

  if v_atp is null then
    raise exception 'PRECONDITION FAILED: public.apply_trust_promotion(uuid,text) does not exist. This file replaces it; without it there is no writer to install the refusal into, and the whole point of this migration is lost.'
      using errcode = 'undefined_function';
  end if;
  if v_atp not in (c_atp_pre, c_atp_post) then
    raise exception E'PRECONDITION FAILED: apply_trust_promotion has a body this migration was not written against.\n  found    %\n  expected % (the body measured on production 2026-08-21, which this file replaces)\n  or       % (the body this file installs, so a re-apply is not refused)\nA parallel session almost certainly changed it. Applying now would SILENTLY OVERWRITE that change: the body below is a snapshot, not a merge. Re-diff pg_get_functiondef against the CREATE OR REPLACE in this file, fold in whatever is missing, and update c_atp_pre to the hash you just measured.',
      v_atp, c_atp_pre, c_atp_post
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select md5(btrim(regexp_replace(
           regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g'),
           '\s+', ' ', 'g')))
    into v_rep
    from pg_proc
   where proname = 'request_eligible_promotions' and pronamespace = 'public'::regnamespace;

  if v_rep not in (c_rep_pre, c_rep_post) then
    raise exception E'PRECONDITION FAILED: request_eligible_promotions has a body this migration was not written against.\n  found    %\n  expected % (the body migration 828 installs, as measured on production 2026-08-21)\n  or       % (the body this file installs)\nSame hazard, same fix as above: re-diff, fold in, update c_rep_pre.',
      v_rep, c_rep_pre, c_rep_post
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$precheck$;

-- ── the role-level declaration ──────────────────────────────────────────────
alter table public.role_archetypes
  add column if not exists trust_ladder jsonb;

comment on column public.role_archetypes.trust_ladder is
  'What each trust step GRANTS for this role, per action category: an object keyed by action_category whose values are ladder arrays in trust_policies.ladder shape (see validate_trust_ladder). NOTHING READS THIS COLUMN YET. The inheritance into trust_policies.ladder is deliberately NOT wired by migration 838: instantiate_role_archetype_internal -- the function the task brief named -- creates no trust_policies rows at all, and choosing the real seam (seed_de_trust_policy, a BEFORE INSERT trigger, or a read-through join) is an open decision. Until it is wired, a ladder is declared per policy through set_trust_ladder. A policy with no ladder cannot be promoted -- see promotion_is_possible. That is deliberate: trust_level_settings makes levels 1, 2 and 3 identical, so a central default is not safe to fall back on.';

-- Top-level shape only, following mig 831's precedent on this same table for
-- the sibling column trust_signals. 831 established EMPIRICALLY that a deeper
-- per-key CHECK is impossible here -- CHECK (NOT EXISTS (SELECT ...)) raises
-- 0A000: cannot use subquery in check constraint -- so the CHECK carries the
-- top-level half and a reader-side guard carries the per-category half. Here
-- that reader-side guard is validate_trust_ladder, called from
-- promotion_is_possible on whatever ends up in trust_policies.ladder.
do $cols$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.role_archetypes'::regclass
       and conname = 'role_archetypes_trust_ladder_is_object'
  ) then
    alter table public.role_archetypes add constraint role_archetypes_trust_ladder_is_object
      check (trust_ladder is null or jsonb_typeof(trust_ladder) = 'object');
  end if;
end
$cols$;

-- ── the refusal ─────────────────────────────────────────────────────────────
-- SECURITY INVOKER, not DEFINER, and the reasoning is the same one mig 831
-- applied to declared_trust_signals in this same program -- but it matters MORE
-- here, because unlike role_archetypes (a shared catalog with no tenant_id),
-- trust_policies IS tenant-scoped. Under DEFINER this function would answer
-- questions about ANY tenant's policy to anyone who could name its id: a policy
-- id passed as a parameter is an assertion, not authorisation -- the exact
-- family migrations 662-664 closed. Under INVOKER, live RLS bounds it for free:
-- trust_policies carries trust_policies_tenant_read (SELECT, role public, qual
-- tenant_id = auth_tenant_id()), so a foreign id selects zero rows and the
-- v_p.id IS NULL arm below turns that into 'no such policy' -- no error, no
-- disclosure, and identical to a genuinely absent row.
--
-- Both real callers are SECURITY DEFINER functions owned by postgres, so inside
-- them this runs as postgres (rolbypassrls) and sees the row it must see.
--
-- ⚠ GRANTED TO service_role ONLY -- NOT to `authenticated`, which is what the
-- brief asked for. Measured, not preferred: validate_trust_ladder's own ACL is
-- {postgres, service_role} and nothing else. An `authenticated` grant here
-- would produce a function that raises `permission denied for function
-- validate_trust_ladder` for every `authenticated` caller the moment it met a
-- policy carrying a ladder -- a grant that looks live and is dead. Widening
-- validate_trust_ladder's grant is a separate security decision and is not
-- taken here. Nothing in src/ calls promotion_is_possible today, so no surface
-- loses anything.
--
-- No `set search_path`: every name in this body is either schema-qualified
-- (public.trust_policies, public.validate_trust_ladder) or a pg_catalog
-- built-in, which is searched first regardless of the GUC. Same check, same
-- conclusion, as 831 -- written as a deliberate omission, not an oversight.
create or replace function public.promotion_is_possible(p_policy_id uuid)
returns jsonb
language plpgsql
stable
security invoker
as $function$
declare
  v_p       public.trust_policies;
  v_ceiling integer;
  v_target  integer;
begin
  select * into v_p from public.trust_policies where id = p_policy_id;
  if v_p.id is null then
    return jsonb_build_object('possible', false, 'why', 'no such policy');
  end if;

  -- Mirrors request_trust_promotion's own guard ("trust policy is paused") so
  -- the two answers cannot disagree about the same row.
  if coalesce(v_p.status, '') <> 'active' then
    return jsonb_build_object('possible', false,
      'why', 'this trust policy is paused, so nothing can be promoted on it');
  end if;

  -- least(3, max_level) is apply_trust_promotion's own ceiling arithmetic -- it
  -- moves to least(current_level + 1, max_level) -- and 3 is the hard ceiling
  -- trust_policies_current_level_check enforces.
  v_ceiling := least(3, coalesce(v_p.max_level, 3));
  if coalesce(v_p.current_level, 0) >= v_ceiling then
    return jsonb_build_object('possible', false,
      'why', format('already at its ceiling (level %s of %s)',
                    coalesce(v_p.current_level, 0), v_ceiling));
  end if;
  v_target := coalesce(v_p.current_level, 0) + 1;

  -- THE ARM THIS WHOLE MIGRATION EXISTS FOR.
  if v_p.ladder is null then
    return jsonb_build_object('possible', false,
      'why', 'this role has not declared what a trust step grants, so there is nothing to promote to');
  end if;

  -- ONE validator, never a second. validate_trust_ladder already owns
  -- array-ness, the 1..max level range, uniqueness, names, modes, settings
  -- types, and monotonicity of mode/confidence/amount. Re-implementing any of
  -- that here would be two definitions of a valid ladder.
  --
  -- p_uses_confidence AND p_uses_amount are both passed TRUE on purpose. That
  -- pair is the CAPABILITY-KEY split (which settings field a category
  -- enforces), and set_trust_ladder is its authority -- deriving it a second
  -- time here would be exactly the divergence the paragraph above avoids.
  -- Passing both makes this call strictly more permissive than the writer on
  -- that one axis, which is the correct direction for a REFUSAL: a guard must
  -- never invent a refusal on a question it is not the authority on.
  --
  -- p_max_level is 3, the absolute ceiling, NOT this policy's max_level. A
  -- ladder is validated for its own intrinsic shape; the policy's ceiling is
  -- the arm above. Otherwise lowering max_level after a ladder was legally
  -- written would retroactively make that ladder "invalid" and manufacture a
  -- refusal with a wrong reason.
  --
  -- `when raise_exception` and not `when others`: validate_trust_ladder signals
  -- every one of its verdicts with a bare RAISE (SQLSTATE P0001). Catching
  -- `others` would swallow insufficient_privilege and report it as "your ladder
  -- is malformed" -- a gate lying about why it refused. Anything else escapes
  -- loudly, which for a refusal is the safe direction.
  begin
    perform public.validate_trust_ladder(v_p.ladder, true, true, 3);
  exception when raise_exception then
    return jsonb_build_object('possible', false,
      'why', format('this policy carries a trust ladder that is not a valid declaration (%s), so what a step grants cannot be read from it',
                    sqlerrm));
  end;

  -- A ladder that does not define the level being STEPPED TO grants nothing new
  -- at that level: trust_ladder_settings falls back to the highest declared
  -- level at or below it, so the "promotion" would record a higher number and
  -- change no permission. That is the defect this migration exists to close,
  -- one level in, so it is refused with its own reason rather than folded into
  -- the arm above.
  if not exists (
    select 1
      from jsonb_array_elements(v_p.ladder) e(entry)
     where (e.entry->>'level')::integer = v_target
  ) then
    return jsonb_build_object('possible', false,
      'why', format('the declared ladder does not say what level %s grants, so a step to it would grant nothing new', v_target));
  end if;

  return jsonb_build_object('possible', true,
    'why', format('a ladder declares level %s and the ceiling (%s) is not reached', v_target, v_ceiling));
end;
$function$;

revoke all on function public.promotion_is_possible(uuid) from public, anon, authenticated;
grant execute on function public.promotion_is_possible(uuid) to service_role;

comment on function public.promotion_is_possible(uuid) is
  'A REFUSAL. Returns {"possible": bool, "why": text}. It grants nothing and is never a substitute for evidence, guardrails or the approver bar -- it only answers whether a step is defined at all. Called by apply_trust_promotion (enforcement: the sole writer of current_level upward) and by request_eligible_promotions (noise control). Migration 838.';

-- ── the writer: the refusal's only load-bearing site ────────────────────────
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
  v_possible  jsonb;   -- migration 838
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

  -- ⚠⚠ MIGRATION 838 -- THE REFUSAL. THIS IS THE ONLY PLACE A PROMOTION IS
  -- ACTUALLY STOPPED. This function is the sole writer of
  -- trust_policies.current_level upward -- measured, not assumed: a scan of
  -- every pg_proc body for an UPDATE ... SET current_level found exactly three,
  -- this one, trust_demote (which only moves DOWN) and a self-test; and
  -- aclexplode over the table shows UPDATE on that column held only by postgres
  -- and service_role, so no PostgREST client can move a level either. The three
  -- functions that OPEN a promotion request write no level at all, so gating
  -- them is noise control and gating this line is the refusal.
  --
  -- ⚠ IT RETURNS, IT DOES NOT RAISE. Migration 837 -- hours old when this was
  -- written, and against this same function -- measured that a raise here rolls
  -- back the audit row written one statement earlier, so a governed refusal
  -- left no trace at all. Both sibling refusals now travel as
  -- {ok:false, reason, message}, and trustApi.resolveTrustPromotion turns
  -- ok:false back into a thrown error (pinned by audit-silent-refusals.mjs and
  -- tests/trust-promotion-refusal-reaches-the-user.test.ts, whose gate is a
  -- plain `r?.ok === false`, so this third reason is covered by construction).
  -- Raising here would have reintroduced the exact defect 837 closed, in the
  -- same function, on the same day -- and the audit row below is only durable
  -- BECAUSE this returns.
  --
  -- PLACED AFTER the self-approval block and BEFORE the stale check. Both
  -- edges were weighed, not defaulted to:
  --   * AFTER self-approval, so that control keeps producing its record in
  --     every case -- an attempt to self-approve is a fact about a person, and
  --     worth recording even on a policy that could not have been promoted.
  --   * BEFORE the stale check, because that branch CLEARS pending_task_id and
  --     answers 'stale'. On an undeclarable policy it would consume the request
  --     and report the wrong cause. Refusing first leaves the request intact
  --     for a human to reject deliberately, and names the real reason.
  --   * A REJECTION is untouched by either edge: the 'rejected' branch returns
  --     well above this line, so the queue can always be cleared. Probed (5i).
  v_possible := public.promotion_is_possible(v_policy.id);
  if not coalesce((v_possible->>'possible')::boolean, false) then
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion blocked — %s: %s', v_label,
        coalesce(nullif(btrim(coalesce(v_possible->>'why', '')), ''), 'no reason given')),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_blocked_not_possible', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'de_id', v_policy.de_id,
        'level', v_policy.current_level, 'task_id', p_task_id,
        'why', v_possible->>'why', 'decided_by', auth.uid())
    );
    return jsonb_build_object('applied', false, 'ok', false, 'reason', 'promotion_not_possible',
      'message', format('this promotion cannot be applied - %s',
        coalesce(nullif(btrim(coalesce(v_possible->>'why', '')), ''),
                 'promotion_is_possible gave no reason')));
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
$function$
;

-- ── the criteria sweep: noise control, not enforcement ──────────────────────
CREATE OR REPLACE FUNCTION public.request_eligible_promotions(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_examined  int := 0;
  v_requested int := 0;
  v_skipped   int := 0;
  v_thin      int := 0;
  v_failed    int := 0;
  v_failures  jsonb := '[]'::jsonb;
  v_undeclared int := 0;   -- migration 838
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

    -- ⚠ MIGRATION 838. Noise control, NOT enforcement -- the enforcement is in
    -- apply_trust_promotion, which this sweep never calls. A policy whose role
    -- has declared nothing about what a step grants can never be approved, so
    -- filing a request for it would put a card in a human queue that is
    -- guaranteed to fail on the button. Counted and RETURNED (skipped_no_ladder)
    -- rather than dropped silently: an operator reading "examined 58,
    -- requested 0" needs the reason on the same line, or the sweep looks broken.
    if not coalesce((public.promotion_is_possible(v_p.id)->>'possible')::boolean, false) then
      v_undeclared := v_undeclared + 1;
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
    'skipped_existing', v_skipped, 'skipped_no_ladder', v_undeclared, 'thin', v_thin,
    'failed', v_failed, 'failures', v_failures);
end;
$function$
;

-- ── proof ───────────────────────────────────────────────────────────────────
-- Every probe states its DENOMINATOR, and a sweep that compared nothing does
-- not count as a check -- it raises a named VACUITY notice instead (mig 830's
-- convention, and 831's). ⚠ db-query.mjs SWALLOWS raise notice, so neither
-- success line below is visible on a real apply -- silence IS the pass, and the
-- only thing that speaks is a failure.
--
-- ── ELEVEN INVERSIONS, EACH RUN AGAINST PRODUCTION IN AN ABORTING TRANSACTION,
--    EACH RED WITH ITS OWN MESSAGE. A gate that cannot fail is theatre, and
--    "17 checks, 0 findings" is worth nothing until every one of them has been
--    seen to fail on purpose. Clean run first: 17 checks, 0 findings, exit 0.
--    Then, one at a time:
--      1  ladder-null arm flipped to POSSIBLE ......... 5a + 6a + 5g RED
--      2  target-level arm removed ................... 5c RED
--      3  ceiling arm disabled ....................... 5d RED
--      4  paused arm disabled ........................ 5e RED
--      5  validate_trust_ladder not consulted ........ 5f RED (wrong reason)
--      6  refusal unwired from the WRITER ............ 3 + 5g RED
--      7  refusal unwired from the sweep ............. 3 RED
--      8  promotion_is_possible refuses EVERYTHING ... 5b + 5h RED (controls)
--      9  the new CHECK made unfireable .............. 2 RED
--     10  refusal audits under a different kind ...... 5g RED (row lost)
--     11  refusal RAISES instead of returning ........ 5g RED (837's defect)
--    Inversions 6, 7, 10 and 11 also turned PROBE 4 red, which is the body-hash
--    arm noticing that the function it measured had changed -- correct, and
--    reported alongside rather than mistaken for the target finding.
do $verify$
declare
  v_checks integer := 0;
  v_bad    text[]  := '{}';

  v_res    jsonb;
  v_src    text;

  -- fixture arm state
  v_tenant      uuid;
  v_fixture_ran boolean := false;
  v_fixture_err text;
  c_rollback    constant text := 'zz_probe_838_deliberate_rollback';

  v_task_none uuid;
  v_task_good uuid;
  v_p_none  uuid;
  v_p_good  uuid;
  v_p_gap   uuid;
  v_p_ceil  uuid;
  v_p_pause uuid;
  v_p_bad   uuid;

  v_ctl_good    text;
  v_rej         text;
  v_apply_none  text;
  v_audit_before integer;
  v_audit_after  integer;
  v_level_after  integer;

  -- a ladder that validate_trust_ladder accepts: one level, level 1, a mode
  -- that actually executes, and a limit -- so the CONTROL below is a genuinely
  -- well-formed declaration and not a shape the validator merely tolerates.
  c_ladder_l1 constant jsonb :=
    '[{"level":1,"name":"zz probe 838 step one","mode":"act_within_limits","settings":{"max_amount_cents":50000}}]'::jsonb;
  -- valid, but declares level 2 only -- a ladder with a GAP at the step being
  -- taken from level 0.
  c_ladder_l2 constant jsonb :=
    '[{"level":2,"name":"zz probe 838 step two","mode":"act"}]'::jsonb;
  -- an ARRAY, so trust_policies_ladder_is_array accepts it, but level 9 is
  -- outside 1..3 so validate_trust_ladder rejects it. Only reachable by a
  -- direct write that bypasses set_trust_ladder -- which is exactly the case
  -- the reader-side guard exists for.
  c_ladder_bad constant jsonb :=
    '[{"level":9,"name":"zz probe 838 impossible","mode":"act"}]'::jsonb;
  -- criteria no synthetic policy can ever satisfy, so the CONTROL at 5h
  -- reliably reaches apply_trust_promotion's stale-evidence branch instead of
  -- actually promoting anything.
  c_criteria_impossible constant jsonb :=
    '{"window_days":30,"min_eval_pass_rate":0.99,"min_eval_samples":999999,"min_human_approval_rate":0.99,"min_human_samples":999999,"max_guardrail_blocks":0}'::jsonb;

  -- real-data sweep counters
  v_sweep_total     integer := 0;
  v_sweep_shape_bad integer := 0;
  v_sweep_shape_eg  uuid;
  v_null_total      integer := 0;
  v_null_possible   integer := 0;
  v_null_eg         uuid;
  v_declared_total  integer := 0;
  v_declared_bad    integer := 0;
  v_declared_eg     uuid;
  v_declared_inval  integer := 0;
  v_row             record;
begin
  -- ══ PROBE 1 -- unconditional, denominator 1, correct on an empty database.
  -- A policy id that matches nothing must refuse, and must refuse by SAYING SO
  -- rather than by returning SQL NULL that a caller's coalesce would have to
  -- rescue.
  v_checks := v_checks + 1;
  v_res := public.promotion_is_possible(gen_random_uuid());
  if v_res is null or coalesce((v_res->>'possible')::boolean, true)
     or coalesce(btrim(coalesce(v_res->>'why', '')), '') = '' then
    v_bad := array_append(v_bad, format(
      'PROBE 1: promotion_is_possible(<nonexistent policy>) returned %s -- it must refuse, with a reason',
      coalesce(v_res::text, 'SQL NULL')));
  end if;

  -- ══ PROBE 2 -- unconditional, denominator 1, no tenant needed (role_archetypes
  -- carries no tenant_id). The new CHECK does not merely EXIST, it can actually
  -- fire on a top-level violation. A gate that cannot fail is theatre.
  v_checks := v_checks + 1;
  begin
    insert into public.role_archetypes (key, name, domain, trust_ladder)
      values ('zz_probe_838_bad_top_level', 'zz probe 838 (bad top level)', 'zz_probe_838', '[]'::jsonb);
    delete from public.role_archetypes where key = 'zz_probe_838_bad_top_level';
    v_bad := array_append(v_bad,
      'PROBE 2: role_archetypes_trust_ladder_is_object did NOT reject a top-level jsonb array -- the constraint cannot fail');
  exception
    when check_violation then
      null; -- expected: the constraint refused a top-level array.
  end;

  -- ══ PROBE 3 -- WIRING, asserted about SCHEMA so it is true wherever this
  -- replays. Denominator 2. This is the built-and-starved control: a refusal
  -- nothing calls is decoration, and the failure mode is silent. Comments are
  -- stripped FIRST -- otherwise this file's own prose about the function would
  -- satisfy the grep and the probe would pass on a body that never calls it.
  for v_row in
    select unnest(array['apply_trust_promotion', 'request_eligible_promotions']) as fn
  loop
    v_checks := v_checks + 1;
    select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_src
      from pg_proc
     where proname = v_row.fn and pronamespace = 'public'::regnamespace;
    if v_src is null then
      v_bad := array_append(v_bad, format('PROBE 3: %s does not exist after this migration ran', v_row.fn));
    elsif v_src !~ '\mpromotion_is_possible\s*\(' then
      v_bad := array_append(v_bad, format(
        'PROBE 3: the installed %s body does not call promotion_is_possible -- the refusal is built and starved',
        v_row.fn));
    end if;
  end loop;

  -- ══ PROBE 4 -- the post-apply body hashes match what the precheck declares,
  -- so a re-apply or a replay reaching this file twice is not refused by this
  -- migration's own work. Denominator 2. Follows mig 834 PROBE 7 exactly.
  for v_row in
    select * from (values
      ('apply_trust_promotion',       '017312c97ee11ea8e76b3fbae55d7ee2'),
      ('request_eligible_promotions', '7fa132df5da8b03828d7f1a0ebd9dd17')
    ) t(fn, expected)
  loop
    v_checks := v_checks + 1;
    select md5(btrim(regexp_replace(
             regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g'),
             '\s+', ' ', 'g')))
      into v_src
      from pg_proc
     where proname = v_row.fn and pronamespace = 'public'::regnamespace;
    if v_src is distinct from v_row.expected then
      v_bad := array_append(v_bad, format(
        'PROBE 4: the installed %s hashes to %s, but the precheck declares %s as its post-apply body. Update that constant in BOTH places or every re-apply will refuse.',
        v_row.fn, coalesce(v_src, 'SQL NULL'), v_row.expected));
    end if;
  end loop;

  -- ══ PROBE 5 -- the fixture arm. Needs one tenant to hang throwaway rows off.
  -- On a database with 0 tenants it is skipped and SAYS SO -- never silently
  -- treated as a pass.
  --
  -- ⚠ THE WHOLE ARM RUNS INSIDE A SUBTRANSACTION THAT IS DELIBERATELY ROLLED
  -- BACK. Not tidiness: 5g/5h/5i call apply_trust_promotion, which writes
  -- audit_events, and the fixture inserts fire log_tenant_activity and
  -- log_remote_access_write triggers. Deleting the fixture rows afterwards
  -- would not undo any of that. Aborting the subtransaction undoes all of it.
  -- PL/pgSQL variables are plain memory and are NOT rolled back, so v_checks
  -- and v_bad survive -- which is the only thing this arm needs to carry out.
  select id into v_tenant from public.tenants order by created_at limit 1;

  if v_tenant is null then
    raise notice '838 VACUITY -- no tenant exists on this database, so PROBE 5 (a-i) made ZERO comparisons: every arm about a real ladder, the end-to-end refusal at apply_trust_promotion, and its two controls are unexercised here. True and honest on an empty database, not a manufactured pass. PROBES 1-4 and 6 are unaffected.';
  else
    begin
      v_fixture_ran := true;

      insert into public.human_tasks (tenant_id, type, title, detail, source)
        values (v_tenant, 'trust_promotion', 'zz probe 838 (no ladder)', 'zz probe 838', 'system')
        returning id into v_task_none;
      insert into public.human_tasks (tenant_id, type, title, detail, source)
        values (v_tenant, 'trust_promotion', 'zz probe 838 (with ladder)', 'zz probe 838', 'system')
        returning id into v_task_good;

      insert into public.trust_policies
        (tenant_id, de_id, action_category, current_level, max_level, status, ladder, criteria, pending_task_id)
      values
        (v_tenant, null, 'zz_probe_838_none',  0, 3, 'active', null,         c_criteria_impossible, v_task_none),
        (v_tenant, null, 'zz_probe_838_good',  0, 3, 'active', c_ladder_l1,  c_criteria_impossible, v_task_good),
        (v_tenant, null, 'zz_probe_838_gap',   0, 3, 'active', c_ladder_l2,  c_criteria_impossible, null),
        (v_tenant, null, 'zz_probe_838_ceil',  1, 1, 'active', c_ladder_l1,  c_criteria_impossible, null),
        (v_tenant, null, 'zz_probe_838_pause', 0, 3, 'paused', c_ladder_l1,  c_criteria_impossible, null),
        (v_tenant, null, 'zz_probe_838_bad',   0, 3, 'active', c_ladder_bad, c_criteria_impossible, null);

      select id into v_p_none  from public.trust_policies where tenant_id = v_tenant and action_category = 'zz_probe_838_none';
      select id into v_p_good  from public.trust_policies where tenant_id = v_tenant and action_category = 'zz_probe_838_good';
      select id into v_p_gap   from public.trust_policies where tenant_id = v_tenant and action_category = 'zz_probe_838_gap';
      select id into v_p_ceil  from public.trust_policies where tenant_id = v_tenant and action_category = 'zz_probe_838_ceil';
      select id into v_p_pause from public.trust_policies where tenant_id = v_tenant and action_category = 'zz_probe_838_pause';
      select id into v_p_bad   from public.trust_policies where tenant_id = v_tenant and action_category = 'zz_probe_838_bad';

      -- (5a) THE ARM THIS MIGRATION EXISTS FOR: no declaration, no promotion.
      v_checks := v_checks + 1;
      v_res := public.promotion_is_possible(v_p_none);
      if coalesce((v_res->>'possible')::boolean, true) then
        v_bad := array_append(v_bad, format(
          'PROBE 5a: a policy whose role declares no ladder reported promotion POSSIBLE (%s) -- that is the unlimited-by-default hole this migration exists to close',
          v_res::text));
      elsif coalesce(v_res->>'why', '') not like '%has not declared what a trust step grants%' then
        v_bad := array_append(v_bad, format(
          'PROBE 5a: refused, but for the wrong reason (%s) -- a refusal that misreports its cause sends the reader to fix the wrong thing',
          coalesce(v_res->>'why', 'no reason at all')));
      end if;

      -- (5b) ⛔ THE CONTROL. Without this, 5a passes whenever the function
      -- refuses EVERYTHING, which is the single most likely way to ship a
      -- guard that looks right and is useless.
      v_checks := v_checks + 1;
      v_res := public.promotion_is_possible(v_p_good);
      if not coalesce((v_res->>'possible')::boolean, false) then
        v_bad := array_append(v_bad, format(
          'PROBE 5b: CONTROL FAILED -- a policy with a valid ladder declaring its very next level ALSO reported impossible (%s). Every arm above proves nothing: nothing is ever possible.',
          coalesce(v_res->>'why', 'no reason given')));
      end if;

      -- (5c) a ladder with a GAP at the step being taken.
      v_checks := v_checks + 1;
      v_res := public.promotion_is_possible(v_p_gap);
      if coalesce((v_res->>'possible')::boolean, true) then
        v_bad := array_append(v_bad,
          'PROBE 5c: a ladder that declares level 2 but not level 1 reported a step from level 0 POSSIBLE -- trust_ladder_settings would fall back to the level below, so that step would record a higher number and grant nothing new');
      elsif coalesce(v_res->>'why', '') not like '%does not say what level 1 grants%' then
        v_bad := array_append(v_bad, format('PROBE 5c: refused for the wrong reason (%s)', coalesce(v_res->>'why', 'none')));
      end if;

      -- (5d) at the ceiling.
      v_checks := v_checks + 1;
      v_res := public.promotion_is_possible(v_p_ceil);
      if coalesce((v_res->>'possible')::boolean, true)
         or coalesce(v_res->>'why', '') not like 'already at its ceiling%' then
        v_bad := array_append(v_bad, format(
          'PROBE 5d: a policy already at its own max_level reported %s', v_res::text));
      end if;

      -- (5e) paused.
      v_checks := v_checks + 1;
      v_res := public.promotion_is_possible(v_p_pause);
      if coalesce((v_res->>'possible')::boolean, true)
         or coalesce(v_res->>'why', '') not like '%paused%' then
        v_bad := array_append(v_bad, format(
          'PROBE 5e: a PAUSED policy reported %s -- request_trust_promotion already refuses these, and the two answers must not disagree about the same row',
          v_res::text));
      end if;

      -- (5f) a ladder that is an array (so the CHECK constraint let it in) but
      -- that validate_trust_ladder rejects. This is the half a CHECK cannot
      -- reach, and the only place it is caught.
      v_checks := v_checks + 1;
      v_res := public.promotion_is_possible(v_p_bad);
      if coalesce((v_res->>'possible')::boolean, true) then
        v_bad := array_append(v_bad,
          'PROBE 5f: a malformed ladder (level 9, outside 1..3) reported promotion POSSIBLE -- validate_trust_ladder is not being consulted');
      elsif coalesce(v_res->>'why', '') not like '%not a valid declaration%' then
        v_bad := array_append(v_bad, format('PROBE 5f: refused for the wrong reason (%s)', coalesce(v_res->>'why', 'none')));
      end if;

      -- (5g) ⚠ END TO END. Everything above tests the REFUSAL FUNCTION. This
      -- tests that the refusal actually STOPS A PROMOTION, at the only writer
      -- of current_level upward, AND that it does so in migration 837's shape.
      -- The service_role claim is set so apply_trust_promotion's membership
      -- branch is skipped -- that branch reads a GUC, and no auth.users row is
      -- created, forged or touched anywhere in this file.
      --
      -- FOUR separate things are asserted, because a refusal that gets any one
      -- of them wrong is a different defect: (i) the level did not move, (ii)
      -- applied is false, (iii) ok is false -- without this exact key
      -- trustApi.resolveTrustPromotion returns a 200 the UI reads as SUCCESS,
      -- which is this repo's named payload-refusal trap -- and (iv) the audit
      -- row SURVIVES, which is the property 837 measured as absent and is only
      -- true because this refusal returns rather than raises.
      v_checks := v_checks + 1;
      select count(*) into v_audit_before from public.audit_events
       where tenant_id = v_tenant and detail->>'kind' = 'trust_promotion_blocked_not_possible';
      begin
        perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
        v_res := public.apply_trust_promotion(v_task_none, 'approved');
        v_apply_none := v_res::text;
      exception when others then
        v_apply_none := 'RAISED: ' || sqlerrm;
      end;
      select count(*) into v_audit_after from public.audit_events
       where tenant_id = v_tenant and detail->>'kind' = 'trust_promotion_blocked_not_possible';
      select current_level into v_level_after from public.trust_policies where id = v_p_none;

      if coalesce(v_level_after, -1) <> 0 then
        v_bad := array_append(v_bad, format(
          'PROBE 5g: apply_trust_promotion MOVED current_level to %s on a policy whose role declares no ladder. The refusal is not wired at the writer -- it is decoration.',
          coalesce(v_level_after::text, 'NULL')));
      elsif v_apply_none like 'RAISED:%' then
        v_bad := array_append(v_bad, format(
          'PROBE 5g: apply_trust_promotion RAISED instead of returning a refusal (%s). Migration 837 measured that a raise here rolls back the audit row written one statement earlier, so this reintroduces the defect it closed.',
          v_apply_none));
      elsif coalesce((v_res->>'applied')::boolean, true)
            or (v_res->>'ok') is distinct from 'false'
            or coalesce(v_res->>'reason', '') <> 'promotion_not_possible'
            or coalesce(v_res->>'message', '') not like '%this promotion cannot be applied%' then
        v_bad := array_append(v_bad, format(
          'PROBE 5g: the refusal payload is not 837''s shape -- got %s. trustApi.resolveTrustPromotion throws on ok===false and NOTHING ELSE, so any other shape is a 200 the UI reads as success.',
          v_apply_none));
      elsif v_audit_after <> v_audit_before + 1 then
        v_bad := array_append(v_bad, format(
          'PROBE 5g: the refusal left NO durable audit row (trust_promotion_blocked_not_possible went %s -> %s). That is exactly the dead-governance-control defect migration 837 measured and fixed in this same function.',
          v_audit_before, v_audit_after));
      end if;

      -- (5h) ⛔ THE CONTROL FOR 5g. If the new guard refuses a well-declared
      -- policy too, 5g only proved that approving always fails. Expected here:
      -- the STALE refusal, because this fixture's criteria cannot be met --
      -- which is a different refusal, from a different check, and that is the
      -- whole point.
      v_checks := v_checks + 1;
      begin
        perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
        v_res := public.apply_trust_promotion(v_task_good, 'approved');
        v_ctl_good := coalesce(v_res->>'reason', '(no reason key)');
      exception when others then
        v_ctl_good := 'RAISED: ' || sqlerrm;
      end;
      if v_ctl_good = 'promotion_not_possible' then
        v_bad := array_append(v_bad,
          'PROBE 5h: CONTROL FAILED -- a policy WITH a valid ladder declaring its next level was refused by the NEW guard too, so PROBE 5g proves nothing: the guard refuses everything.');
      end if;

      -- (5i) A REJECTION MUST NEVER BE BLOCKED. If it were, an undeclarable
      -- policy's request could never be cleared and the queue would be stuck
      -- forever -- a refusal that creates a worse trap than the hole it closes.
      -- Also asserts the `ok` key is ABSENT: trustApi documents that ok appears
      -- only on a refusal, so an ordinary decline carrying it would start
      -- throwing at the user for a decision that succeeded.
      v_checks := v_checks + 1;
      begin
        perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
        v_res := public.apply_trust_promotion(v_task_none, 'rejected');
        v_rej := coalesce(v_res->>'reason', '(no reason key)')
                 || case when v_res ? 'ok' then ' [+ok key present]' else '' end;
      exception when others then
        v_rej := 'RAISED: ' || sqlerrm;
      end;
      if v_rej <> 'rejected' then
        v_bad := array_append(v_bad, format(
          'PROBE 5i: rejecting a promotion on a no-ladder policy did not behave -- got "%s". The guard sits after the rejected branch precisely so this keeps working, and an ordinary decline must not carry ok:false.',
          v_rej));
      end if;

      perform set_config('request.jwt.claims', '', true);

      -- deliberate abort: see the note above the fixture arm.
      raise exception '%', c_rollback;
    exception when others then
      if sqlerrm <> c_rollback then
        v_fixture_err := sqlerrm;
        v_bad := array_append(v_bad, format(
          'PROBE 5: the fixture arm died before it could finish (%s). Findings collected before that point still stand; arms after it made no comparison at all.',
          v_fixture_err));
      end if;
    end;
  end if;

  -- ══ PROBE 6 -- REAL DATA, one pass, three denominators, each printed. Every
  -- assertion is about the ABSENCE of a violation, so all three are vacuously
  -- true on an empty database and none of them needs a production row to pass.
  for v_row in select * from public.trust_policies loop
    v_sweep_total := v_sweep_total + 1;

    begin
      v_res := public.promotion_is_possible(v_row.id);
    exception when others then
      v_res := null;
    end;

    -- (6c) shape: never SQL NULL, always a boolean verdict with a reason.
    if v_res is null
       or jsonb_typeof(v_res) <> 'object'
       or jsonb_typeof(v_res->'possible') <> 'boolean'
       or coalesce(btrim(coalesce(v_res->>'why', '')), '') = '' then
      v_sweep_shape_bad := v_sweep_shape_bad + 1;
      if v_sweep_shape_eg is null then v_sweep_shape_eg := v_row.id; end if;
      continue;
    end if;

    -- (6a) no policy without a ladder may report possible.
    if v_row.ladder is null then
      v_null_total := v_null_total + 1;
      if coalesce((v_res->>'possible')::boolean, false) then
        v_null_possible := v_null_possible + 1;
        if v_null_eg is null then v_null_eg := v_row.id; end if;
      end if;
    -- (6b) ⛔ the converse: a policy that IS active, IS below its ceiling and
    -- DOES declare the level it would step to must not be refused. Without
    -- this population, 6a is satisfied by a function that always says no.
    -- Its denominator is 0 today (no live policy carries a ladder at all) and
    -- that is reported rather than hidden.
    elsif coalesce(v_row.status, '') = 'active'
          and coalesce(v_row.current_level, 0) < least(3, coalesce(v_row.max_level, 3))
          and exists (
            select 1 from jsonb_array_elements(v_row.ladder) e(entry)
             where (e.entry->>'level')::integer = coalesce(v_row.current_level, 0) + 1
          )
    then
      v_declared_total := v_declared_total + 1;
      if not coalesce((v_res->>'possible')::boolean, false) then
        -- a ladder that is present and shaped right at the target level can
        -- still be rejected by validate_trust_ladder for a reason this cheap
        -- predicate cannot see (monotonicity, a bad mode). That is a correct
        -- refusal, not a finding -- counted separately so it is visible.
        if coalesce(v_res->>'why', '') like '%not a valid declaration%' then
          v_declared_inval := v_declared_inval + 1;
        else
          v_declared_bad := v_declared_bad + 1;
          if v_declared_eg is null then v_declared_eg := v_row.id; end if;
        end if;
      end if;
    end if;
  end loop;

  if v_sweep_total > 0 then
    v_checks := v_checks + 1;
    if v_sweep_shape_bad > 0 then
      v_bad := array_append(v_bad, format(
        'PROBE 6c: %s of %s live trust_policies rows did not get a well-formed {possible, why} verdict (e.g. policy %s)',
        v_sweep_shape_bad, v_sweep_total, v_sweep_shape_eg));
    end if;
  else
    raise notice '838 VACUITY -- PROBE 6c found 0 trust_policies rows to sweep. Zero rows compared, so it does not count toward the checks total.';
  end if;

  if v_null_total > 0 then
    v_checks := v_checks + 1;
    if v_null_possible > 0 then
      v_bad := array_append(v_bad, format(
        'PROBE 6a: %s of %s live policies carrying NO ladder reported promotion POSSIBLE (e.g. %s) -- the refusal is not refusing',
        v_null_possible, v_null_total, v_null_eg));
    end if;
  else
    raise notice '838 VACUITY -- PROBE 6a found 0 live policies with a NULL ladder. Zero rows compared; it does not count toward the checks total.';
  end if;

  if v_declared_total > 0 then
    v_checks := v_checks + 1;
    if v_declared_bad > 0 then
      v_bad := array_append(v_bad, format(
        'PROBE 6b: %s of %s live policies that are active, below their ceiling AND declare their next level were refused anyway (e.g. %s) -- the guard is refusing declarations it should accept',
        v_declared_bad, v_declared_total, v_declared_eg));
    end if;
  else
    raise notice '838 VACUITY -- PROBE 6b found 0 live policies that are active, below their ceiling and declare their next level. That is the expected production reality today (0 of 58 policies carry a ladder), so the real-data CONTROL compared NOTHING and does not count toward the checks total. The synthetic control at PROBE 5b is what carries this direction.';
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception 'VERIFICATION FAILED (% findings across % checks): %',
      array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  end if;

  if v_fixture_ran and v_fixture_err is null then
    raise notice '838: % checks compared, 0 findings -- FULL RUN. PROBE 5 fixture arm ran and rolled back cleanly; 5h control saw "%". PROBE 6 swept % policies: % with a null ladder (0 reported possible), % declaring their next level, % of those held an invalid ladder. NOTE: db-query.mjs does not surface RAISE NOTICE -- this line is invisible on a real apply.',
      v_checks, coalesce(v_ctl_good, '(not run)'), v_sweep_total, v_null_total, v_declared_total, v_declared_inval;
  else
    raise notice '838: % checks compared, 0 findings -- REDUCED RUN: PROBE 5 did not complete (%). Only PROBES 1-4 and 6 carried this result. PROBE 6 swept % policies: % with a null ladder, % declaring their next level. NOTE: db-query.mjs does not surface RAISE NOTICE -- this line is invisible on a real apply.',
      v_checks, coalesce(v_fixture_err, 'no tenant on this database'), v_sweep_total, v_null_total, v_declared_total;
  end if;
end
$verify$;

commit;
