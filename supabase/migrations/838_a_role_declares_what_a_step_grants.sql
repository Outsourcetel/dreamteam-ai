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
--    a trust step grants...". Through migration 836's decide_human_task -- now
--    the real path -- the task is NOT closed, refusal_reason is stamped on it,
--    and the queue keeps the card with the reason attached. The level does not
--    move; the request is not consumed; and the refusal leaves TWO durable
--    records (836's human_task_decision_refused and this file's
--    trust_promotion_blocked_not_possible), which is only true because this
--    refusal returns instead of raising.
--  · ⚠ AND THE ROUTE OUT IS NOW ONE STEP SHORTER THAN IT WAS. Because the
--    ladder is read through the role, a platform actor declaring
--    role_archetypes.trust_ladder for an archetype unblocks EVERY policy on
--    that role at once -- including these two, whose archetypes are `fpa` and
--    `onboarding`. No per-policy set_trust_ladder needed, and no re-request:
--    the open request becomes approvable the moment its role declares.
--  · REJECTING either request still works, unchanged. The guard sits after the
--    'rejected' branch precisely so a human can always clear the queue.
--  · The nightly eligibility sweep will not file NEW cards nobody can action --
--    a policy with no effective ladder is skipped and counted in the new
--    skipped_no_ladder key. ⚠ IT WILL NOT COUNT THESE TWO THERE, and an earlier
--    draft of this line claimed it would. Measured with 838 applied:
--    {examined:58, requested:0, skipped_existing:2, skipped_no_ladder:0, ...}.
--    Both already carry a pending_task_id, and the sweep's pre-existing
--    "a request is already open" branch continues BEFORE this file's guard is
--    reached. The behaviour is right -- an open request is not re-filed, for the
--    reason it always was -- only the sentence was wrong.
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
--         has nothing to inherit FROM. (These are the 9 live policies whose
--         employee has a null archetype -- measured, and the same 9 counted at
--         "THE 9 POLICIES THAT CAN NEVER INHERIT" below. An earlier draft of
--         this line said 8.)
--       · seed_trust_policies() -- tenant-wide rows, de_id NULL, no employee
--         and therefore no role. 0 such rows exist today.
--       · verify_decide_discovery_proposal() -- a self-test.
--
--     THE SEAM WAS RETURNED AS A QUESTION AND ANSWERED: READ-THROUGH, NOT
--     COPY-AT-HIRE. Three reasons, all of which survive re-checking here:
--
--       1. THE CODEBASE ALREADY DECIDED IT. Mig 831, in this same plan, reads
--          the sibling column through exactly this join at read time
--          (declared_trust_signals), having weighed and rejected copy-at-hire
--          in its own header. Doing the ladder differently would be gratuitous
--          divergence between two columns on one table that mean the same kind
--          of thing.
--       2. COPY-AT-HIRE IS ACTIVELY WRONG HERE, and this file's own enumeration
--          is why. provision_starter_de_internal inserts into trust_policies
--          DIRECTLY and never calls seed_de_trust_policy (whose only caller is
--          decide_discovery_proposal). Two independent creation paths already
--          exist, so stamping one leaves the other bare -- the
--          two-paths-one-counted trap, and the same divergence mig 755 had to
--          unpick. A third writer could appear tomorrow.
--       3. COPY-AT-HIRE CANNOT SERVE THE ROLES THAT WILL DECLARE. All 58
--          policies already exist. Nothing declared today would ever reach
--          them, so the first roles to declare a ladder would declare it for
--          nobody.
--
--     So the fallback lives in trust_ladder_settings -- the ENFORCEMENT reader,
--     whose readers are exactly apply_trust_promotion, trust_apply_level,
--     detect_trust_widening_patterns and one self-test -- reached through the
--     shared effective_trust_ladder below, which promotion_is_possible also
--     calls so the refusal and the enforcement cannot disagree.
--     trust_policies.ladder keeps its stated meaning as the per-policy OVERRIDE
--     (what set_trust_ladder writes); the role's declaration is the default
--     beneath it. role_archetypes.trust_ladder now HAS a reader.
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
-- ⚠ THE ENUMERATION ABOVE WAS RE-RUN AFTER MIGRATION 836 LANDED, AND IT MOVED.
-- When this file was first drafted, apply_trust_promotion had exactly ONE
-- caller and it was in the browser (src/lib/trustApi.ts). 836 -- applied while
-- this file was being written -- moved the promotion INSIDE
-- public.decide_human_task, because batch-approving a trust_promotion closed
-- the task and promoted nobody. So there is now a SQL caller that did not exist
-- when the refusal was placed, reached by decide_human_tasks (batch),
-- preview_decide_human_tasks and withdraw_human_task.
--
-- THE PLACEMENT SURVIVES THAT UNCHANGED, and that is the point of putting a
-- refusal at the writer rather than at each door: a new door opened, and it was
-- already covered. Re-measured after 836: every path still funnels through
-- apply_trust_promotion, which is still the only upward writer of
-- current_level.
--
-- AND IT COMPOSES WITH 836 EXACTLY AS 836 INTENDED. Read from the installed
-- body, not from its header: decide_human_task calls apply_trust_promotion in a
-- BEGIN...EXCEPTION *before* closing the task; on 'approved' it treats
-- `applied` not true as a refusal, stamps refusal_reason / refused_at /
-- refused_by on the task, appends its own human_task_decision_refused audit
-- event, LEAVES THE TASK PENDING, and returns the still-open row. Because this
-- refusal RETURNS rather than raises, all three records commit together: 837's
-- audit row, 836's refusal mark on the task, and this file's
-- trust_promotion_blocked_not_possible event. A raise here would have destroyed
-- all three. Probed end to end -- PROBE 10.
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
  v_tls text;
  c_tls_pre  constant text := '6eedafea0d1fed8a628e28bafc2f550d';
  c_tls_post constant text := '074d2c322c0eea347d68350add753c31';
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

  select md5(btrim(regexp_replace(
           regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g'),
           '\s+', ' ', 'g')))
    into v_tls
    from pg_proc
   where proname = 'trust_ladder_settings' and pronamespace = 'public'::regnamespace;

  if v_tls is null then
    raise exception 'PRECONDITION FAILED: public.trust_ladder_settings(trust_policies,integer) does not exist -- migration 458 has not been applied. This file replaces it to add the role-level fallback; without it the role declaration would have no enforcement reader at all.'
      using errcode = 'undefined_function';
  end if;
  if v_tls not in (c_tls_pre, c_tls_post) then
    raise exception E'PRECONDITION FAILED: trust_ladder_settings has a body this migration was not written against.\n  found    %\n  expected % (measured on production 2026-08-21)\n  or       % (the body this file installs)\nThis is the ENFORCEMENT reader -- what a level actually permits. Overwriting a parallel session''s change to it would silently alter what every earned level grants. Re-diff, fold in, update c_tls_pre.',
      v_tls, c_tls_pre, c_tls_post
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$precheck$;

-- ── the role-level declaration ──────────────────────────────────────────────
alter table public.role_archetypes
  add column if not exists trust_ladder jsonb;

comment on column public.role_archetypes.trust_ladder is
  'What each trust step GRANTS for this role, per action category: an object keyed by action_category whose values are ladder arrays in trust_policies.ladder shape (see validate_trust_ladder). READ THROUGH THE JOIN AT READ TIME, never copied at hire -- matching mig 831''s trust_signals on this same table, and for the same reasons (two independent trust_policies creation paths already exist, and all 58 live policies predate any declaration). effective_trust_ladder resolves it: a policy''s own ladder is the OVERRIDE, this is the default beneath it. Both readers go through that one function -- promotion_is_possible (may this step be taken) and trust_ladder_settings (what it grants) -- so they cannot disagree. ⚠ RETROACTIVE: editing this changes what an already-earned level grants for every employee in the role at once. ⚠ An employee with no archetype_key (9 of 58 policies today) inherits nothing and stays refused until set_trust_ladder is used directly -- correct, not a gap. A policy with no effective ladder cannot be promoted: trust_level_settings makes levels 1, 2 and 3 identical, so a central default is not safe to fall back on.';

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

-- ── the read-through: ONE definition of "the ladder that applies here" ──────
-- The policy's own ladder is the OVERRIDE (what set_trust_ladder writes, and
-- what trust_policies.ladder has always meant). The role's declaration is the
-- DEFAULT beneath it. Neither reader computes this itself: promotion_is_possible
-- (the refusal) and trust_ladder_settings (the enforcement) both call this, so
-- "may this step be taken" and "what does that step grant" can never disagree
-- about which ladder they are reading. Two copies of this cascade would be the
-- divergence mig 831's header calls out and mig 755 had to unpick.
--
-- SHAPE, and why the guards differ per arm:
--   * the override arm tests `is not null`, not jsonb_typeof = 'array'. A policy
--     that HAS an override must use it, whatever shape it is -- falling through
--     to the role because the override is malformed would silently widen an
--     employee back to the role default. A malformed override is caught, and
--     refused, by promotion_is_possible's validate_trust_ladder arm instead.
--   * the role arm tests jsonb_typeof = 'array', because `->` on a jsonb object
--     returns a jsonb VALUE: a jsonb null, a string, a nested object are all
--     possible and none of them is SQL NULL, so coalesce would not catch them.
--     This is mig 831's IMPORTANT-1 finding applied to the sibling column; the
--     top-level CHECK above cannot reach per-key values (0A000, no subqueries in
--     a CHECK), so this guard is the only place those shapes are caught.
--
-- ⚠ role_archetypes.status IS DELIBERATELY NOT FILTERED. instantiate_role_
-- archetype_internal requires status='active' to HIRE, but a role moving to
-- 'draft' afterwards must not silently delete the ladder out from under
-- employees already hired into it -- that would drop them back to
-- trust_level_settings, where levels 1/2/3 are unlimited, which is a silent
-- WIDENING and the exact defect this whole migration exists to close. All 15
-- live archetypes are active today, so this changes nothing now; it is written
-- so the dangerous direction is impossible later.
--
-- SECURITY INVOKER, and here that is load-bearing rather than tidy. This is
-- reachable from trust_ladder_settings, which carries a PUBLIC/anon grant
-- (measured, see its grant note below) and takes a trust_policies COMPOSITE --
-- so a caller can hand it any de_id it likes. Under DEFINER that would be a
-- cross-tenant probe by construction (a parameter is an assertion, not
-- authorisation -- migs 662-664). Under INVOKER, live RLS answers instead:
-- digital_employees is tenant-scoped and role_archetypes' SELECT policy is
-- `auth.uid() is not null`, so an anon caller resolves zero rows and gets NULL,
-- which falls back to exactly the trust_level_settings answer it already got
-- before this migration. Nothing new is disclosed to anybody.
create or replace function public.effective_trust_ladder(p_policy public.trust_policies)
returns jsonb
language sql
stable
security invoker
as $function$
  select case
           when p_policy.ladder is not null then p_policy.ladder
           when jsonb_typeof(v.role_ladder) = 'array' then v.role_ladder
           else null
         end
  from (
    select (
      select a.trust_ladder -> p_policy.action_category
        from public.digital_employees d
        join public.role_archetypes a on a.key = d.archetype_key
       where d.id = p_policy.de_id
    ) as role_ladder
  ) v;
$function$;

-- ⚠ GRANTED TO PUBLIC, DELIBERATELY, AND A PROBE CHOSE THAT — NOT A PREFERENCE.
-- The revoke below is not decoration: it strips the default grant so what
-- follows is a decision rather than an inheritance. The decision itself was
-- MEASURED. trust_ladder_settings holds EXECUTE for PUBLIC, anon, authenticated
-- and service_role (aclexplode, not assumed -- the PUBLIC entry is the
-- default-grant artefact migs 610/630 exist to catch, it is PRE-EXISTING, and
-- revoking it is a separate decision this file does not take). A helper reached
-- THROUGH that function must be at least as reachable, or this migration turns
-- a working call into `permission denied for function effective_trust_ladder` --
-- the same trap that kept promotion_is_possible off `authenticated`.
--
-- An earlier draft granted only anon + authenticated + service_role, reasoning
-- that those were "the real roles". PROBE 12 was written to check that claim
-- rather than trust it, and it failed the draft: 13 of 17 non-system roles
-- reach trust_ladder_settings through PUBLIC and would have lost the callee --
-- including trust_pattern_proposer (the NOLOGIN sweep role this repo's Ring-0
-- probe is built around) and approval_brief_writer. Guessing the role list
-- would have shipped a broken sweep.
--
-- This widens nothing. Under INVOKER (above) the join is bounded by live RLS:
-- digital_employees is tenant-scoped and role_archetypes' SELECT policy is
-- `auth.uid() is not null`, so an unauthenticated caller resolves zero rows and
-- gets NULL -- byte-identical to the trust_level_settings answer it already got
-- before this migration. The reachable data is a strict subset of what the
-- caller already returns. PROBE 12 stays in the file so a future REVOKE on
-- either function cannot silently break the other.
revoke all on function public.effective_trust_ladder(public.trust_policies) from public, anon, authenticated;
grant execute on function public.effective_trust_ladder(public.trust_policies) to public;

comment on function public.effective_trust_ladder(public.trust_policies) is
  'The ladder that applies to a policy: its own ladder if it has one (the per-policy OVERRIDE that set_trust_ladder writes), otherwise the ladder its employee''s role archetype declares for this action category, otherwise NULL. The single definition shared by promotion_is_possible (the refusal) and trust_ladder_settings (the enforcement), so the two cannot disagree. Read-through, never copied at hire -- matching mig 831''s trust_signals. Migration 838.';

-- ── the same cascade, reachable from a browser ─────────────────────────────
-- ⚠ THIS EXISTS BECAUSE THE CLIENT WAS ABOUT TO BECOME A THIRD DEFINITION.
-- src/lib/trustApi.ts already reimplements the ladder compile in JS
-- (earnedLadderSettings), and it reads trust_policies.ladder — the raw column,
-- which is NULL for a policy inheriting its role's declaration. Two surfaces
-- depend on that compile and BOTH were wrong after 838:
--
--   · EmployeeFileSections uses its return value to decide whether to append a
--     `trust_manual_override` AUDIT EVENT. Fed the raw column, a dial set above
--     the role's earned cap scored "within earned" and no audit row was written.
--     Audit completeness, not cosmetics.
--   · the promotion approval card ("what the step grants") renders from the same
--     column on the ops queue and the mobile shell — the surface a person reads
--     at the exact moment they grant autonomy.
--
-- The fix is NOT to teach the client the role join. That would be a third
-- definition of what a step grants, in the language least able to enforce it,
-- and 838 exists to stop there being two. The client asks the server instead,
-- through this function, and feeds the answer to the compile it already had.
--
-- ARRAY, not one id at a time: the employee file renders every capability on
-- one screen, and a per-policy round trip would be N requests to render one tab.
--
-- SECURITY INVOKER, so live RLS is the boundary: trust_policies carries
-- trust_policies_tenant_read (qual tenant_id = auth_tenant_id()), so ids
-- belonging to another workspace simply do not come back — a caller learns
-- nothing by asking about them, and no row is fabricated for them. A policy id
-- passed as a parameter is an assertion, not authorisation.
--
-- Granted to `authenticated` DELIBERATELY, and unlike promotion_is_possible that
-- grant is not a dead one: this function's only callee is
-- effective_trust_ladder, which carries a PUBLIC grant (see its own note above),
-- so an authenticated caller can actually execute the whole chain. PROBE 13h
-- asserts exactly that rather than trusting it.
create or replace function public.effective_trust_ladders(p_policy_ids uuid[])
returns table (policy_id uuid, effective_ladder jsonb)
language sql
stable
security invoker
as $function$
  select p.id, public.effective_trust_ladder(p)
    from public.trust_policies p
   where p.id = any (coalesce(p_policy_ids, '{}'::uuid[]));
$function$;

revoke all on function public.effective_trust_ladders(uuid[]) from public, anon, authenticated;
grant execute on function public.effective_trust_ladders(uuid[]) to authenticated, service_role;

comment on function public.effective_trust_ladders(uuid[]) is
  'Batch reader for effective_trust_ladder, so a browser can render what a step grants from the SAME cascade the server enforces instead of reimplementing the role join in JS. RLS-bounded (SECURITY INVOKER): ids from another workspace return no row. Migration 838.';

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
  v_ladder  jsonb;
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
  -- ⚠ effective_trust_ladder, NOT v_p.ladder. The refusal must read the SAME
  -- ladder the enforcement reader (trust_ladder_settings) reads, or a role
  -- could declare a step, have it enforced, and still be refused permission to
  -- take it. One definition, two callers -- see effective_trust_ladder above.
  v_ladder := public.effective_trust_ladder(v_p);
  if v_ladder is null then
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
    perform public.validate_trust_ladder(v_ladder, true, true, 3);
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
      from jsonb_array_elements(v_ladder) e(entry)
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
  'A REFUSAL. Returns {"possible": bool, "why": text}. It grants nothing and is never a substitute for evidence, guardrails or the approver bar -- it only answers whether a step is defined at all. Reads effective_trust_ladder, so it agrees with the enforcement reader by construction. Called by apply_trust_promotion (enforcement: the sole writer of current_level upward) and by request_eligible_promotions (noise control). Migration 838.';

-- ── the validating writer for the ROLE's declaration ────────────────────────
-- ⚠ WHY THIS EXISTS, AND WHY IT IS PART OF THIS FILE RATHER THAN A LATER ONE.
-- Before this migration, trust_ladder_settings could only ever see
-- trust_policies.ladder, which is guarded twice over: by the
-- trust_policies_ladder_is_array CHECK, and by set_trust_ladder, its SOLE
-- writer, which runs validate_trust_ladder before storing. So the enforcement
-- reader never needed to validate what it read.
--
-- This migration widens what that reader can see to
-- role_archetypes.trust_ladder -> category -- and THAT COLUMN HAS NO WRITER AT
-- ALL. Only the top-level object CHECK stands between it and
-- jsonb_array_elements. Measured with a role declaring
-- [{"level":"one","name":"bad","mode":"act"}]:
--
--   promotion_is_possible  -> refuses cleanly ("not a valid declaration")
--   trust_ladder_settings  -> 22P02: invalid input syntax for type integer: "one"
--   trust_apply_level      -> 22P02
--   trust_demote           -> 22P02
--
-- No unearned authority -- the promotion is refused, which is the direction that
-- matters. The cost is AVAILABILITY on the down and reset paths, including
-- set_trust_ladder(..., p_clear_ladder := true), which nulls the override and
-- then falls through to the malformed role ladder. A hand-written
-- UPDATE role_archetypes SET trust_ladder = ... is the only way to use this
-- feature today, so a malformed declaration is the EXPECTED first failure mode,
-- not an exotic one.
--
-- ⚠ AND THE FIX IS NOT A FALLBACK. The obvious alternative -- have
-- trust_ladder_settings catch the error and fall back to trust_level_settings --
-- is refused on the same grounds this file already refuses it for a draft role:
-- trust_level_settings makes levels 1, 2 and 3 identical and uncapped, so a
-- silent fallback is a silent WIDENING, and the trigger for it would be a
-- malformed declaration nobody noticed. Raising is the correct behaviour. The
-- fix is to stop the bad value being stored, which is what this writer is.
--
-- ⚠ SECURITY INVOKER, AND THE PERIMETER IS THE TABLE GRANT. Measured, not
-- assumed: role_archetypes grants SELECT to anon and authenticated and UPDATE to
-- nobody but postgres and service_role, and its only RLS policy is a SELECT
-- policy. Under INVOKER the UPDATE below therefore runs with the caller's own
-- privileges, and a browser caller cannot reach it at all -- with or without the
-- named-caller arm inside. PROBE 13f asserts exactly that, and is the arm that
-- goes red if the grant ever widens.
--
-- ⚠ NO AUDIT EVENT, AND THAT IS A STATED GAP RATHER THAN AN OVERSIGHT.
-- append_audit_event is tenant-scoped and extends a per-tenant tamper-evident
-- hash chain (audit_chain_state). role_archetypes has NO tenant_id -- it is a
-- shared catalog -- so there is no tenant this global declaration belongs to,
-- and fanning one row out to every tenant would forge N decisions from one act.
-- This function is still strictly better than the status quo, which is a raw
-- UPDATE that is neither validated NOR audited. A platform-level config audit
-- sink is a real gap this migration touches and does not create; it is named in
-- the report rather than invented here.
create or replace function public.set_role_trust_ladder(
  p_archetype_key   text,
  p_action_category text,
  p_ladder          jsonb   default null,
  p_clear           boolean default false
)
returns jsonb
language plpgsql
volatile
security invoker
as $function$
declare
  v_key       text := nullif(btrim(coalesce(p_archetype_key, '')), '');
  v_cat       text := nullif(btrim(coalesce(p_action_category, '')), '');
  v_row       public.role_archetypes;
  v_uses_conf boolean;
  v_uses_amt  boolean;
  v_levels    integer;
  v_next      jsonb;
begin
  if v_key is null then
    raise exception 'cannot declare a trust ladder: no role archetype was named';
  end if;
  if v_cat is null then
    raise exception 'cannot declare a trust ladder: no action category was named';
  end if;

  -- The SECOND line, for a NAMED caller. A role's ladder is a global catalog
  -- fact: changing it changes what a step grants in EVERY workspace that hired
  -- that role, so it is not a workspace-level setting and a tenant admin must
  -- not reach it. Written knowing that `auth.uid() is not null and <check>`
  -- skips the check entirely for a caller with no JWT -- the shape that makes a
  -- guard fail open. That residue is deliberate here and is covered by the
  -- table grant above rather than left to chance: the callers it lets past are
  -- exactly the ones that already hold UPDATE on this table directly, and could
  -- write the column without calling this function at all.
  if auth.uid() is not null and not public.is_platform_admin() then
    raise exception 'insufficient_permission: what a trust step grants for a ROLE is a platform-wide declaration -- it changes every workspace that hired that role, so it is not a workspace setting. A workspace sets its own limits per employee through set_trust_ladder.';
  end if;

  -- Mirrors trust_policies_action_category_check exactly. A category outside
  -- that shape can never equal a trust_policies.action_category, so the
  -- declaration would be stored, look present, and match nothing forever.
  if v_cat !~ '^[a-z0-9_:.-]+$' or length(v_cat) > 120 then
    raise exception 'action category "%" is not a shape trust_policies.action_category can hold, so no policy could ever match it', v_cat;
  end if;

  -- Status is deliberately NOT filtered: a role is declared before it is
  -- activated, and refusing to declare for a draft role would invert the order
  -- of operations. instantiate_role_archetype_internal still requires
  -- status='active' to HIRE, which is the gate that matters.
  select * into v_row from public.role_archetypes where key = v_key;
  if v_row.key is null then
    raise exception 'unknown role archetype "%"', v_key;
  end if;

  if coalesce(p_clear, false) then
    -- Removing one category's declaration. An object left with no keys becomes
    -- NULL, so "declares nothing" has exactly one representation and
    -- effective_trust_ladder's jsonb_typeof guard never has to meet an empty
    -- object.
    v_next := nullif(coalesce(v_row.trust_ladder, '{}'::jsonb) - v_cat, '{}'::jsonb);
  else
    if p_ladder is null or jsonb_typeof(p_ladder) = 'null' then
      raise exception 'no ladder was given for "%" -- pass p_clear => true to remove this role''s declaration instead', v_cat;
    end if;

    -- ⚠ THE ENTIRE POINT OF THIS FUNCTION IS THIS ONE CALL. validate_trust_ladder
    -- is the one validator every ladder in this database passes through; it
    -- raises on array-ness, the level range, duplicate levels, names, modes,
    -- settings shape, and monotonicity of mode/confidence/amount.
    --
    -- The capability split is MIRRORED FROM set_trust_ladder, verbatim, because
    -- this writer must accept exactly what that one accepts: a manager may later
    -- copy a role's ladder into a per-policy override through it, and a value
    -- this writer stored but that one refuses would be a dead end the customer
    -- cannot act on. ⚠ It is a THIRD copy of that split -- set_trust_ladder has
    -- it as an expression, de_trust_surface_candidates as positional literals --
    -- and there is no single source of truth to call instead (checked:
    -- de_trust_surface_candidates only RETURNS the booleans, keyed by an
    -- employee it would need a de_id to resolve). PROBE 13e is a RATCHET on
    -- set_trust_ladder's own body so the copies cannot drift silently; unifying
    -- all three is named in the report, not attempted here.
    v_uses_conf := v_cat in ('answer_dock', 'answer_widget');
    v_uses_amt  := not v_uses_conf;

    -- p_max_level is 3, the absolute ceiling, NOT any one policy's max_level: a
    -- role declaration is shared by policies whose ceilings differ, so
    -- validating against one of them would refuse a ladder that is legal for the
    -- others. promotion_is_possible validates at 3 for the same reason and
    -- applies the per-policy ceiling as its own separate arm.
    v_levels := public.validate_trust_ladder(p_ladder, v_uses_conf, v_uses_amt, 3);

    v_next := coalesce(v_row.trust_ladder, '{}'::jsonb)
              || jsonb_build_object(v_cat, p_ladder);
  end if;

  update public.role_archetypes set trust_ladder = v_next where key = v_key;

  return jsonb_build_object(
    'archetype_key',   v_key,
    'action_category', v_cat,
    'cleared',         coalesce(p_clear, false),
    'levels',          v_levels,
    'declares',        coalesce(
                         (select jsonb_agg(k order by k)
                            from jsonb_object_keys(coalesce(v_next, '{}'::jsonb)) k),
                         '[]'::jsonb));
end;
$function$;

revoke all on function public.set_role_trust_ladder(text, text, jsonb, boolean) from public, anon, authenticated;
-- service_role only. There is no UI for this: a platform operator declares a
-- role's ladder through a script or a direct statement, and postgres retains
-- EXECUTE as owner. Granting `authenticated` would be a grant that cannot work
-- anyway -- validate_trust_ladder's own ACL is {postgres, service_role}, the
-- same dead-grant trap that kept promotion_is_possible off `authenticated`.
grant execute on function public.set_role_trust_ladder(text, text, jsonb, boolean) to service_role;

comment on function public.set_role_trust_ladder(text, text, jsonb, boolean) is
  'The ONE door for role_archetypes.trust_ladder. Validates through validate_trust_ladder before storing, so the enforcement reader (trust_ladder_settings) can never meet a malformed ladder it would raise 22P02 on. Platform-scope: a role declaration changes what a step grants in every workspace that hired that role. p_clear => true removes one category. Migration 838.';

-- ── the enforcement reader: what an earned level actually GRANTS ────────────
-- ⚠ THIS IS THE ONLY CHANGE IN THIS FILE THAT ALTERS WHAT A LEVEL PERMITS, and
-- it is the change that gives role_archetypes.trust_ladder a reader. Exactly one
-- edit: `p_policy.ladder` becomes `effective_trust_ladder(p_policy)`, computed
-- once in a FROM-subquery so the cascade is evaluated a single time. Every other
-- character -- the level-0 short circuit, the trust_level_settings fallback, the
-- mode-to-enabled mapping, the `<= least(p_level, max_level)` window, the
-- descending pick, the all-null default -- is the live body verbatim.
--
-- ⚠ IMMUTABLE -> STABLE, and this is a correction, not a side effect. The
-- previous body read only its own arguments, so IMMUTABLE was true. This one
-- reads digital_employees and role_archetypes, and an IMMUTABLE function that
-- reads tables is a lie the PLANNER ACTS ON -- it may constant-fold the call and
-- reuse a stale answer, which for "what does this level permit" is a wrong
-- authority decision rather than a slow one. Checked before changing it, not
-- assumed safe: pg_depend reports NO index, constraint or generated column
-- depending on this function, so nothing breaks on the volatility change. Its
-- three real callers are all VOLATILE or STABLE (apply_trust_promotion,
-- trust_apply_level, detect_trust_widening_patterns), so none of them is
-- constrained by it. trust_level_settings stays IMMUTABLE and correctly so --
-- read live, its body is a pure CASE over its two arguments with no table
-- access at all.
--
-- ⚠ RETROACTIVITY, STATED PLAINLY BECAUSE IT IS REAL. This makes a role's
-- declaration apply to employees ALREADY HIRED, including one with a promotion
-- request already open. Editing a role's ladder therefore changes what an
-- already-earned level grants for every employee in that role, at once, with no
-- per-employee decision. Mig 831 accepted the identical trade for trust_signals.
--
-- Is that SAFE, or merely VISIBLE? Honestly: **visible, and safe only in the
-- narrowing direction.** apply_trust_promotion re-derives evidence at APPROVE
-- time, and this file's refusal is re-asked at the same moment, so a ladder
-- edited between request and approval is seen when the button is pressed and
-- never at the stale request-time value -- that much is genuinely safe. But an
-- edit that WIDENS a level takes effect for an already-promoted employee with
-- no approval event at all, because nothing re-approves a level already held.
-- The existing brake is that set_trust_ladder is owner/admin/manager-gated,
-- audited (trust_ladder_set), and re-applies the dial through trust_apply_level;
-- the gap is that role_archetypes has NO equivalent writer today -- it is a
-- shared catalog with no tenant_id and no RPC, so only a platform-level actor
-- can change it at all. That is the true safety boundary right now, and it is
-- narrow enough to state rather than rely on. Named as an open item in the
-- report; deliberately NOT papered over with a trigger invented here.
--
-- ⚠ THE 9 POLICIES THAT CAN NEVER INHERIT. 49 of the 58 live policies belong to
-- an employee with an archetype_key; 9 do not -- they were created by
-- provision_starter_de_internal, which inserts its digital_employees row
-- directly and sets no archetype at all. The join in effective_trust_ladder
-- fails at its second hop for those, so they fall back to NULL and stay refused
-- until set_trust_ladder is used on them directly. That is CORRECT, not a gap:
-- an employee with no declared role has no role declaration to inherit, and
-- inventing one would be the platform choosing an autonomy limit on a customer's
-- behalf. Written down so nobody later reads "9 refused forever" as a bug.
create or replace function public.trust_ladder_settings(p_policy trust_policies, p_level integer)
returns jsonb
language sql
stable
as $function$
  select case
    when p_level <= 0 then jsonb_build_object('enabled', false, 'max_amount_cents', null, 'min_confidence', null)
    when v.lad is null then public.trust_level_settings(p_policy.action_category, p_level)
    else coalesce(
      (
        select jsonb_build_object(
          'enabled',          coalesce((e.entry->>'mode') in ('act_within_limits', 'act'), false),
          'max_amount_cents', nullif(e.entry->'settings'->>'max_amount_cents', '')::bigint,
          'min_confidence',   nullif(e.entry->'settings'->>'min_confidence', '')::integer)
        from jsonb_array_elements(v.lad) e(entry)
        where (e.entry->>'level')::integer <= least(p_level, coalesce(p_policy.max_level, 3))
        order by (e.entry->>'level')::integer desc
        limit 1
      ),
      jsonb_build_object('enabled', false, 'max_amount_cents', null, 'min_confidence', null))
  end
  from (select public.effective_trust_ladder(p_policy) as lad) v;
$function$;

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
-- ── TWENTY-FOUR INVERSIONS, EACH RUN AGAINST PRODUCTION IN AN ABORTING
--    TRANSACTION, EACH RED WITH ITS OWN MESSAGE. A gate that cannot fail is
--    theatre, and "40 checks, 0 findings" is worth nothing until every one of
--    them has been seen to fail on purpose. Clean run first: 40 checks, 0
--    findings, exit 0. Then, one at a time:
--      1  ladder-null arm flipped to POSSIBLE ......... 5a + 6a + 5g RED
--      2  target-level arm removed ................... 5c RED
--      3  ceiling arm disabled ....................... 5d RED
--      4  paused arm disabled ........................ 5e RED
--      5  validate_trust_ladder not consulted ........ 5f RED (wrong reason)
--      6  refusal unwired from the WRITER ............ 3 + 5g + 10b RED
--      7  refusal unwired from the sweep ............. 3 RED
--      8  promotion_is_possible refuses EVERYTHING ... 5b + 5h + 7a RED
--      9  the new CHECK made unfireable .............. 2 RED
--     10  refusal audits under a different kind ...... 5g RED (row lost)
--     11  refusal RAISES instead of returning ........ 5g RED (837's defect)
--     12  effective_trust_ladder ignores the ROLE .... 7a + 7c RED
--     13  the ROLE outranks the policy override ...... 7e RED
--     14  enforcement left on p_policy.ladder ........ 7c RED
--     15  trust_ladder_settings left IMMUTABLE ....... 11 RED
--     16  the new grant narrowed below its caller .... 12 RED
--     17  the archetype join ignored ................. 7b + 7f RED
--     18  PROBE 10a given a pattern that cannot match  10a RED
--     19  the writer skips validate_trust_ladder ..... 13b RED
--     20  p_clear wipes every category ............... 13d RED
--     21  the category-shape check disabled .......... 13e RED
--     22  role_archetypes UPDATE given to authenticated 13f RED
--     23  the split ratchet given a dead expression .. 13g RED
--     24  the malformed fixture quietly made valid ... 13a RED
--    Inversions 6, 7, 10, 11, 12, 13, 14, 15 and 17 also turned PROBE 4 red --
--    the body-hash arm noticing that the function it measured had changed.
--    Correct, and reported alongside rather than mistaken for the target.
--
--    ⚠ TWO OF THESE FOUND REAL DEFECTS IN THIS FILE RATHER THAN CONFIRMING IT.
--    INV13 did NOT go red on the first attempt: PROBE 7e claimed to prove that
--    a per-policy override outranks the role default, but the probe's own
--    fixture had the role declaring nothing for the override's category -- so
--    there was no conflict to win, and 7e would have passed no matter which arm
--    won. It was theatre until the fixture was given a genuine collision.
--    INV18's arm was written after PROBE 10a fired on a real mismatch during
--    development: the pattern used Postgres's \m (start-of-word) as a CLOSING
--    anchor where \M (end-of-word) was meant, so it could never match. Verified
--    empirically against the live body -- \M true, \m false -- rather than
--    reasoned about.
--    INV20 found a THIRD: PROBE 13d's two arms were bare `v_ladder_after ? key`
--    tests, and `jsonb ? key` on a NULL jsonb is SQL NULL, not false -- so an
--    inversion that wiped the whole column left BOTH branches untaken and the
--    probe green having compared nothing. That is the same three-valued hole
--    trust-proposer-boundary arm 9c exists to catch, written into a new probe by
--    somebody who had just read that arm. Both arms are coalesced now.
--    None of the three would have been caught by a clean run.
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

  -- read-through fixtures (PROBE 7) and the 836 composition (PROBE 10)
  v_role_key    text := 'zz_probe_838_role_declares';
  v_role_silent text := 'zz_probe_838_role_silent';
  v_de_role     uuid;
  v_de_silent   uuid;
  v_de_noarch   uuid;
  v_p_role      uuid;
  v_p_over      uuid;
  v_p_silent    uuid;
  v_p_noarch    uuid;
  v_pol_row     public.trust_policies;
  v_decide      public.human_tasks;
  v_actor       uuid;
  v_task_decide uuid;
  v_p_write         uuid;
  v_ladder_before   jsonb;
  v_ladder_after    jsonb;
  -- an ARRAY (so the top-level object CHECK is satisfied) whose "level" is the
  -- string "one" -- the exact value the review used to reach 22P02 inside
  -- trust_ladder_settings. Only storable by a raw UPDATE, which is what PROBE
  -- 13a does and what set_role_trust_ladder exists to stop.
  c_ladder_malformed constant jsonb :=
    '[{"level":"one","name":"zz probe 838 malformed","mode":"act"}]'::jsonb;
  v_decide_note text;
  v_decide_skipped boolean := false;
  v_task_status text;
  v_task_refusal text;

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
  v_grant_total     integer := 0;
  v_grant_bad       integer := 0;
  v_grant_eg        text;
  v_batch_total     integer := 0;
  v_batch_bad       integer := 0;
  v_batch_eg        uuid;
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

  -- ══ PROBE 10a -- THE 836 COMPOSITION, AS A SCHEMA CONTRACT. Denominator 3,
  -- unconditional, correct on an empty database. Migration 836 moved the
  -- promotion INSIDE decide_human_task, so that is the path a person actually
  -- approves through now. Its contract, on which this refusal depends: it calls
  -- apply_trust_promotion, it treats `applied` not-true as a refusal, and it
  -- stamps refusal_reason instead of closing the task. If a future migration
  -- rewrites decide_human_task from a stale snapshot and drops any one of those,
  -- this refusal starts being swallowed -- the task would close as approved with
  -- nobody promoted, which is exactly the defect 836 exists to fix.
  -- Comment-stripped first, so 836's own prose about these names cannot satisfy
  -- the match.
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_src
    from pg_proc
   where proname = 'decide_human_task' and pronamespace = 'public'::regnamespace;

  if v_src is null then
    raise notice '838 VACUITY -- PROBE 10a found no public.decide_human_task on this database (migration 836 not applied). Zero comparisons; it does not count toward the checks total.';
  else
    for v_row in
      select * from (values
        ('\mapply_trust_promotion\s*\(', 'calls apply_trust_promotion at all -- the promotion is not part of the decision, so a batch approval closes the task and promotes nobody'),
        ('>>\s*''applied''',              'reads the ''applied'' key -- it cannot tell a refusal from a success, so this migration''s refusal is swallowed and the task closes as approved'),
        ('\mrefusal_reason\M',            'writes refusal_reason -- a refused promotion would leave the queue with no explanation of why it will not go through')
      ) t(pat, why)
    loop
      v_checks := v_checks + 1;
      if v_src !~ v_row.pat then
        v_bad := array_append(v_bad, format(
          'PROBE 10a: the installed decide_human_task no longer %s', v_row.why));
      end if;
    end loop;
  end if;

  -- ══ PROBE 4 -- the post-apply body hashes match what the precheck declares,
  -- so a re-apply or a replay reaching this file twice is not refused by this
  -- migration's own work. Denominator 3. Follows mig 834 PROBE 7 exactly.
  for v_row in
    select * from (values
      ('apply_trust_promotion',       '017312c97ee11ea8e76b3fbae55d7ee2'),
      ('request_eligible_promotions', '7fa132df5da8b03828d7f1a0ebd9dd17'),
      ('trust_ladder_settings',       '074d2c322c0eea347d68350add753c31')
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

  -- ══ PROBE 11 -- VOLATILITY, asserted about schema, denominator 1, correct on
  -- an empty database. trust_ladder_settings now reads two tables through
  -- effective_trust_ladder. An IMMUTABLE function that reads tables is not a
  -- style problem: the planner may CONSTANT-FOLD it and reuse a stale answer,
  -- and the answer here is "what does this trust level permit". Left IMMUTABLE
  -- this migration would install a silently wrong authority decision.
  v_checks := v_checks + 1;
  select provolatile::text into v_src from pg_proc
   where proname = 'trust_ladder_settings' and pronamespace = 'public'::regnamespace;
  if coalesce(v_src, '') <> 's' then
    v_bad := array_append(v_bad, format(
      'PROBE 11: trust_ladder_settings has provolatile=%s, expected s (STABLE). It reads digital_employees and role_archetypes now; IMMUTABLE would license the planner to fold the call and answer from a stale ladder.',
      coalesce(v_src, 'NULL')));
  end if;

  -- ══ PROBE 12 -- GRANT PARITY, denominator = every non-system role on this
  -- database, printed below. effective_trust_ladder is reached THROUGH
  -- trust_ladder_settings, so any role that can execute the caller must be able
  -- to execute the callee -- otherwise this migration turns a working call into
  -- `permission denied for function effective_trust_ladder` for that role. This
  -- is the same dead/broken-grant trap that kept promotion_is_possible off
  -- `authenticated` (validate_trust_ladder's ACL is {postgres, service_role}).
  -- has_function_privilege is used deliberately: it answers INCLUDING
  -- inheritance through PUBLIC, so a REVOKE elsewhere cannot fake a pass.
  for v_row in
    select rolname from pg_roles
     where rolname not like 'pg\_%' and rolname <> 'postgres'
     order by rolname
  loop
    v_grant_total := v_grant_total + 1;
    if has_function_privilege(v_row.rolname,
         'public.trust_ladder_settings(public.trust_policies,integer)', 'EXECUTE')
       and not has_function_privilege(v_row.rolname,
         'public.effective_trust_ladder(public.trust_policies)', 'EXECUTE') then
      v_grant_bad := v_grant_bad + 1;
      v_grant_eg := coalesce(v_grant_eg || ', ', '') || v_row.rolname;
    end if;
  end loop;
  if v_grant_total > 0 then
    v_checks := v_checks + 1;
    if v_grant_bad > 0 then
      v_bad := array_append(v_bad, format(
        'PROBE 12: %s of %s roles can execute trust_ladder_settings but NOT effective_trust_ladder (%s). Every call they make now raises permission denied -- this migration would break a caller it was supposed to leave alone.',
        v_grant_bad, v_grant_total, v_grant_eg));
    end if;
  else
    raise notice '838 VACUITY -- PROBE 12 found 0 non-system roles to compare grants across. Zero comparisons; it does not count toward the checks total.';
  end if;

  -- ══ PROBE 13f -- THE REAL PERIMETER on role_archetypes, denominator 2,
  -- unconditional, correct on an empty database. set_role_trust_ladder is
  -- SECURITY INVOKER, so what actually stops a browser caller writing a global
  -- role declaration is the TABLE grant, not the named-caller arm inside the
  -- function. has_function/has_table_privilege answer INCLUDING inheritance
  -- through PUBLIC, so a REVOKE elsewhere cannot fake a pass here.
  for v_row in select unnest(array['anon', 'authenticated']) as r loop
    v_checks := v_checks + 1;
    if has_table_privilege(v_row.r, 'public.role_archetypes', 'UPDATE') then
      v_bad := array_append(v_bad, format(
        'PROBE 13f: %s holds UPDATE on role_archetypes. A role ladder is a GLOBAL declaration -- it changes what a step grants in every workspace that hired that role -- and set_role_trust_ladder runs as INVOKER precisely because this grant is the perimeter. With it widened, the named-caller arm inside the function is the only thing left, and a service_role JWT skips that arm by design.',
        v_row.r));
    end if;
  end loop;

  -- ══ PROBE 13g -- THE SPLIT RATCHET, denominator 1. set_role_trust_ladder
  -- mirrors set_trust_ladder's capability split verbatim, because it must accept
  -- exactly what that writer accepts. There is no single source of truth to call
  -- instead, so this arm makes the copies unable to drift SILENTLY: change the
  -- split there and this goes red naming the file that has to follow.
  -- Comment-stripped, so the prose in either body cannot satisfy it.
  v_checks := v_checks + 1;
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_src
    from pg_proc where proname = 'set_trust_ladder' and pronamespace = 'public'::regnamespace;
  if v_src is null then
    v_bad := array_append(v_bad, 'PROBE 13g: public.set_trust_ladder does not exist -- the writer this file mirrors its capability split from is gone');
  elsif position('v_uses_conf := v_pol.action_category IN (''answer_dock'', ''answer_widget'')' in v_src) = 0 then
    v_bad := array_append(v_bad,
      'PROBE 13g: set_trust_ladder no longer derives its confidence/amount split as action_category IN (answer_dock, answer_widget). set_role_trust_ladder mirrors that expression verbatim and must be updated in the same commit, or the two writers will accept different ladders for the same category.');
  end if;

  -- ══ PROBE 13h -- THE BATCH READER. Two arms, both unconditional.
  -- (i) GRANT CHAIN, denominator 2. effective_trust_ladders is granted to
  -- authenticated so a browser can render what a step grants from the server's
  -- own cascade. That grant is worthless unless authenticated can also execute
  -- its callee, effective_trust_ladder -- the exact dead-grant trap that kept
  -- promotion_is_possible off authenticated (validate_trust_ladder's ACL is
  -- {postgres, service_role}). has_function_privilege answers INCLUDING
  -- inheritance through PUBLIC, so this cannot be faked by a REVOKE elsewhere.
  for v_row in
    select * from (values
      ('public.effective_trust_ladders(uuid[])', 'the client would get permission denied and silently lose the effective ladder'),
      ('public.effective_trust_ladder(public.trust_policies)', 'the batch reader would raise permission denied on its own callee for every browser caller -- a grant that looks live and is dead')
    ) t(sig, why)
  loop
    v_checks := v_checks + 1;
    if not has_function_privilege('authenticated', v_row.sig, 'EXECUTE') then
      v_bad := array_append(v_bad, format(
        'PROBE 13h(i): authenticated cannot EXECUTE %s -- %s', v_row.sig, v_row.why));
    end if;
  end loop;

  -- (ii) AGREEMENT, denominator = every live policy. The batch reader must give
  -- the same answer as the single-row one for every row, or the browser renders
  -- one ladder while the enforcement path reads another -- which is the whole
  -- defect this function exists to close, moved one layer out.
  v_batch_total := 0;
  v_batch_bad := 0;
  for v_row in
    select p.id,
           public.effective_trust_ladder(p) as one_at_a_time,
           (select b.effective_ladder from public.effective_trust_ladders(array[p.id]) b) as batched
      from public.trust_policies p
  loop
    v_batch_total := v_batch_total + 1;
    if v_row.one_at_a_time is distinct from v_row.batched then
      v_batch_bad := v_batch_bad + 1;
      if v_batch_eg is null then v_batch_eg := v_row.id; end if;
    end if;
  end loop;
  if v_batch_total > 0 then
    v_checks := v_checks + 1;
    if v_batch_bad > 0 then
      v_bad := array_append(v_bad, format(
        'PROBE 13h(ii): %s of %s live policies got a different answer from effective_trust_ladders than from effective_trust_ladder (e.g. %s) -- the browser would render a ladder the enforcement path does not read',
        v_batch_bad, v_batch_total, v_batch_eg));
    end if;
  else
    raise notice '838 VACUITY -- PROBE 13h(ii) found 0 trust_policies rows to compare the batch reader against. Zero comparisons; it does not count toward the checks total.';
  end if;

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
  -- Prefer an OPERATIONAL tenant that actually has an active tenant-layer
  -- member, because PROBE 10b needs a real identity to drive decide_human_task
  -- (mig 830's pattern). Falls back to any tenant so the other PROBE 5 arms --
  -- none of which need a member -- are not lost on a database that has none.
  -- tenant_is_operational mirrors request_eligible_promotions' own filter
  -- rather than a predicate that only matches because nothing is suspended.
  select t.id into v_tenant
    from public.tenants t
   where public.tenant_is_operational(t.id)
   order by (exists (select 1 from public.profiles p
                      where p.tenant_id = t.id and p.layer = 'tenant'
                        and coalesce(p.is_active, true))) desc,
            t.created_at
   limit 1;
  if v_tenant is null then
    select id into v_tenant from public.tenants order by created_at limit 1;
  end if;

  -- The identity PROBE 10b will act as. Discovered by query, never hardcoded,
  -- and only ever a REAL active member of the fixture tenant -- nothing is
  -- inserted into auth.users, and the whole arm is inside the subtransaction
  -- that is deliberately rolled back, so no audit row is attributed to them.
  select p.user_id into v_actor
    from public.profiles p
   where p.tenant_id = v_tenant and p.layer = 'tenant'
     and coalesce(p.is_active, true)
   order by p.user_id
   limit 1;

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
      -- A THIRD, UNTOUCHED pair for PROBE 10b. It cannot share v_task_none:
      -- PROBE 5i rejects that one, and a successful rejection CLEARS
      -- pending_task_id, so 10b would then meet 'no_pending_policy' and report a
      -- refusal that has nothing to do with this migration.
      insert into public.human_tasks (tenant_id, type, title, detail, source)
        values (v_tenant, 'trust_promotion', 'zz probe 838 (decide path)', 'zz probe 838', 'system')
        returning id into v_task_decide;

      insert into public.trust_policies
        (tenant_id, de_id, action_category, current_level, max_level, status, ladder, criteria, pending_task_id)
      values
        (v_tenant, null, 'zz_probe_838_none',  0, 3, 'active', null,         c_criteria_impossible, v_task_none),
        (v_tenant, null, 'zz_probe_838_good',  0, 3, 'active', c_ladder_l1,  c_criteria_impossible, v_task_good),
        (v_tenant, null, 'zz_probe_838_gap',   0, 3, 'active', c_ladder_l2,  c_criteria_impossible, null),
        (v_tenant, null, 'zz_probe_838_ceil',  1, 1, 'active', c_ladder_l1,  c_criteria_impossible, null),
        (v_tenant, null, 'zz_probe_838_pause', 0, 3, 'paused', c_ladder_l1,  c_criteria_impossible, null),
        (v_tenant, null, 'zz_probe_838_bad',   0, 3, 'active', c_ladder_bad, c_criteria_impossible, null),
        (v_tenant, null, 'zz_probe_838_dec',   0, 3, 'active', null,         c_criteria_impossible, v_task_decide);

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

      -- ══ PROBE 7 -- THE READ-THROUGH. A policy with NO ladder of its own,
      -- whose employee's role archetype DOES declare one for this category,
      -- must become promotable AND must be enforced at the role's settings --
      -- not at the built-in trust_level_settings defaults. This is the whole
      -- of the coordinator's answer (read-through, not copy-at-hire) and the
      -- only thing that gives role_archetypes.trust_ladder a reader.
      insert into public.role_archetypes (key, name, domain, trust_ladder)
        values (v_role_key, 'zz probe 838 (declares)', 'zz_probe_838',
                jsonb_build_object('zz_probe_838_role', c_ladder_l1,
                                   -- ⚠ THE ROLE MUST ALSO DECLARE THE OVERRIDE'S
                                   -- CATEGORY, or PROBE 7e proves nothing: with no
                                   -- role entry for it there is no conflict for the
                                   -- override to win. Caught by inversion INV13,
                                   -- which could not turn 7e red until this line
                                   -- existed -- the probe was theatre before it.
                                   'zz_probe_838_over', c_ladder_l1));
      insert into public.role_archetypes (key, name, domain, trust_ladder)
        values (v_role_silent, 'zz probe 838 (declares nothing)', 'zz_probe_838', null);

      insert into public.digital_employees (tenant_id, name, archetype_key)
        values (v_tenant, 'zz probe 838 DE (role declares)', v_role_key)
        returning id into v_de_role;
      insert into public.digital_employees (tenant_id, name, archetype_key)
        values (v_tenant, 'zz probe 838 DE (role silent)', v_role_silent)
        returning id into v_de_silent;
      insert into public.digital_employees (tenant_id, name)
        values (v_tenant, 'zz probe 838 DE (no archetype at all)')
        returning id into v_de_noarch;

      insert into public.trust_policies
        (tenant_id, de_id, action_category, current_level, max_level, status, ladder, criteria)
      values
        (v_tenant, v_de_role,   'zz_probe_838_role', 0, 3, 'active', null,        c_criteria_impossible),
        (v_tenant, v_de_role,   'zz_probe_838_over', 0, 3, 'active', c_ladder_l2, c_criteria_impossible),
        (v_tenant, v_de_role,   'zz_probe_838_write', 0, 3, 'active', null,        c_criteria_impossible),
        (v_tenant, v_de_silent, 'zz_probe_838_role', 0, 3, 'active', null,        c_criteria_impossible),
        (v_tenant, v_de_noarch, 'zz_probe_838_role', 0, 3, 'active', null,        c_criteria_impossible);

      select id into v_p_role   from public.trust_policies where de_id = v_de_role   and action_category = 'zz_probe_838_role';
      select id into v_p_over   from public.trust_policies where de_id = v_de_role   and action_category = 'zz_probe_838_over';
      select id into v_p_write  from public.trust_policies where de_id = v_de_role   and action_category = 'zz_probe_838_write';
      select id into v_p_silent from public.trust_policies where de_id = v_de_silent and action_category = 'zz_probe_838_role';
      select id into v_p_noarch from public.trust_policies where de_id = v_de_noarch and action_category = 'zz_probe_838_role';

      -- (7a) the refusal now says YES because the ROLE declared.
      v_checks := v_checks + 1;
      v_res := public.promotion_is_possible(v_p_role);
      if not coalesce((v_res->>'possible')::boolean, false) then
        v_bad := array_append(v_bad, format(
          'PROBE 7a: a policy with no ladder of its own, whose ROLE declares one for this category, was still refused (%s). The read-through is not wired, so role_archetypes.trust_ladder has no reader and the whole answer to the seam question is inert.',
          coalesce(v_res->>'why', 'no reason')));
      end if;

      -- (7b) ⛔ THE CONTROL. Same employee shape, role declares NOTHING -- must
      -- still be refused. Without this, 7a passes for a function that says yes
      -- to everything with a de_id.
      v_checks := v_checks + 1;
      v_res := public.promotion_is_possible(v_p_silent);
      if coalesce((v_res->>'possible')::boolean, true) then
        v_bad := array_append(v_bad,
          'PROBE 7b: CONTROL FAILED -- a policy whose role declares NOTHING was reported promotable, so PROBE 7a proves nothing: the read-through says yes regardless of what the role declared.');
      end if;

      -- (7c) THE ENFORCEMENT HALF. promotion_is_possible saying yes is worth
      -- nothing if trust_ladder_settings still hands back the unlimited
      -- built-in defaults -- that is precisely the defect this migration
      -- exists to close, and it would be invisible from the refusal alone.
      v_checks := v_checks + 1;
      select * into v_pol_row from public.trust_policies where id = v_p_role;
      v_res := public.trust_ladder_settings(v_pol_row, 1);
      if coalesce(v_res->>'max_amount_cents', '') <> '50000' then
        v_bad := array_append(v_bad, format(
          'PROBE 7c: trust_ladder_settings at level 1 returned %s for a policy inheriting its role''s ladder, expected max_amount_cents 50000. The refusal would permit a step the enforcement then grants at the unlimited trust_level_settings default -- a promotion that is allowed and unbounded.',
          v_res::text));
      end if;

      -- (7d) ⛔ THE CONTROL FOR 7c. The role-silent policy must still get the
      -- built-in default, or 7c is measuring a constant rather than a lookup.
      v_checks := v_checks + 1;
      select * into v_pol_row from public.trust_policies where id = v_p_silent;
      v_res := public.trust_ladder_settings(v_pol_row, 1);
      if (v_res->>'max_amount_cents') is not null then
        v_bad := array_append(v_bad, format(
          'PROBE 7d: CONTROL FAILED -- a policy whose role declares nothing got %s from trust_ladder_settings instead of the built-in default (max_amount_cents null), so PROBE 7c is not reading the role at all.',
          v_res::text));
      end if;

      -- (7e) THE OVERRIDE STILL WINS. trust_policies.ladder is documented as
      -- the per-policy override; a role default that silently outranked it
      -- would break set_trust_ladder's entire purpose. Same employee, same
      -- role, but this policy carries its own ladder declaring level 2 only.
      v_checks := v_checks + 1;
      select * into v_pol_row from public.trust_policies where id = v_p_over;
      v_res := public.trust_ladder_settings(v_pol_row, 2);
      if coalesce(v_res->>'enabled', '') <> 'true'
         or (v_res->>'max_amount_cents') is not null then
        v_bad := array_append(v_bad, format(
          'PROBE 7e: a policy carrying its OWN ladder resolved to %s at level 2 -- expected its own level-2 entry (mode act, no cap), not the role default. The per-policy override is being outranked by the role.',
          v_res::text));
      end if;

      -- (7f) THE 9 POLICIES THAT CAN NEVER INHERIT. An employee with
      -- archetype_key NULL has no role to read, so the join fails at its
      -- second hop and the policy stays refused. Asserted rather than assumed,
      -- because "it happens to be null" and "the code handles null" are
      -- different facts.
      v_checks := v_checks + 1;
      v_res := public.promotion_is_possible(v_p_noarch);
      if coalesce((v_res->>'possible')::boolean, true) then
        v_bad := array_append(v_bad,
          'PROBE 7f: a policy whose employee has NO archetype_key was reported promotable -- effective_trust_ladder resolved a role that does not exist');
      end if;

      -- ══ PROBE 13 -- THE VALIDATING WRITER. The role column is the one input
      -- to the enforcement reader that nothing guarded, and a hand-written
      -- UPDATE is the only way to use this feature today, so a malformed
      -- declaration is the expected first failure mode. These arms prove the
      -- writer closes it, and prove the hole was real in the first place.

      -- (13a) ⚠ THE HOLE, DEMONSTRATED. Stored by a RAW UPDATE -- the status quo
      -- this writer replaces -- a malformed ladder reaches jsonb_array_elements
      -- and (entry->>'level')::integer inside trust_ladder_settings and raises
      -- 22P02. Asserting the RAISE, not tolerating it: a silent fallback to
      -- trust_level_settings would be a silent widening, which this file refuses
      -- everywhere else too.
      v_checks := v_checks + 1;
      update public.role_archetypes
         set trust_ladder = jsonb_build_object('zz_probe_838_role', c_ladder_malformed)
       where key = v_role_key;
      select * into v_pol_row from public.trust_policies where id = v_p_role;
      begin
        v_res := public.trust_ladder_settings(v_pol_row, 1);
        v_bad := array_append(v_bad, format(
          'PROBE 13a: trust_ladder_settings returned %s for a role ladder whose level is the string "one". It should have raised -- if it silently answered, it fell back to something, and the only thing to fall back to is the uncapped trust_level_settings default.',
          v_res::text));
      exception when others then
        if sqlstate <> '22P02' then
          v_bad := array_append(v_bad, format(
            'PROBE 13a: expected 22P02 from a malformed role ladder, got %s: %s', sqlstate, sqlerrm));
        end if;
      end;
      -- put the role back to a good declaration for the arms that follow
      update public.role_archetypes
         set trust_ladder = jsonb_build_object('zz_probe_838_role', c_ladder_l1, 'zz_probe_838_over', c_ladder_l1)
       where key = v_role_key;

      -- (13b) THE WRITER REFUSES THE SAME VALUE, and leaves the column alone.
      v_checks := v_checks + 1;
      select trust_ladder into v_ladder_before from public.role_archetypes where key = v_role_key;
      begin
        v_res := public.set_role_trust_ladder(v_role_key, 'zz_probe_838_role', c_ladder_malformed);
        v_bad := array_append(v_bad, format(
          'PROBE 13b: set_role_trust_ladder ACCEPTED a ladder whose level is the string "one" (returned %s) -- validate_trust_ladder is not being called, so the writer is not a writer, it is a passthrough.',
          v_res::text));
      exception when raise_exception then
        null; -- expected: validate_trust_ladder refused it.
      end;
      select trust_ladder into v_ladder_after from public.role_archetypes where key = v_role_key;
      v_checks := v_checks + 1;
      if v_ladder_after is distinct from v_ladder_before then
        v_bad := array_append(v_bad,
          'PROBE 13b: the refused write still CHANGED role_archetypes.trust_ladder -- a validator that refuses after storing is not a validator');
      end if;

      -- (13c) ⛔ THE CONTROL. If the writer refuses everything, 13b proves
      -- nothing. A well-formed ladder must be accepted, stored, and then be
      -- visible through the same cascade the enforcement reader uses.
      v_checks := v_checks + 1;
      begin
        v_res := public.set_role_trust_ladder(v_role_key, 'zz_probe_838_write', c_ladder_l1);
        if coalesce((v_res->>'levels')::integer, 0) <> 1
           or coalesce(v_res->>'action_category', '') <> 'zz_probe_838_write' then
          v_bad := array_append(v_bad, format(
            'PROBE 13c: CONTROL -- the writer accepted a good ladder but reported %s', v_res::text));
        end if;
      exception when others then
        v_bad := array_append(v_bad, format(
          'PROBE 13c: CONTROL FAILED -- the writer REFUSED a well-formed ladder (%s), so PROBE 13b proves nothing: it refuses everything.',
          sqlerrm));
      end;
      v_checks := v_checks + 1;
      select * into v_pol_row from public.trust_policies where id = v_p_write;
      if public.effective_trust_ladder(v_pol_row) is distinct from c_ladder_l1 then
        v_bad := array_append(v_bad, format(
          'PROBE 13c: a ladder the writer accepted does not come back through effective_trust_ladder (%s) -- it stored something the readers cannot see',
          coalesce(public.effective_trust_ladder(v_pol_row)::text, 'SQL NULL')));
      end if;

      -- (13d) p_clear removes ONE category and leaves the others standing.
      v_checks := v_checks + 1;
      v_res := public.set_role_trust_ladder(v_role_key, 'zz_probe_838_write', null, true);
      select trust_ladder into v_ladder_after from public.role_archetypes where key = v_role_key;
      -- ⚠ BOTH ARMS COALESCE, and INV20 is why. `jsonb ? key` on a NULL jsonb
      -- is SQL NULL, not false, so an inversion that wiped the whole column left
      -- both bare arms evaluating to NULL -- neither branch taken, probe green,
      -- nothing compared. Same three-valued hole trust-proposer-boundary arm 9c
      -- exists to catch, found here by inverting rather than by reading.
      if coalesce(v_ladder_after ? 'zz_probe_838_write', false) then
        v_bad := array_append(v_bad, format(
          'PROBE 13d: p_clear did not remove "%s" -- trust_ladder is still %s', 'zz_probe_838_write', v_ladder_after::text));
      elsif not coalesce(v_ladder_after ? 'zz_probe_838_role', false) then
        v_bad := array_append(v_bad, format(
          'PROBE 13d: p_clear removed MORE than the category asked for -- "%s" is gone too (%s)',
          'zz_probe_838_role', coalesce(v_ladder_after::text, 'SQL NULL')));
      end if;

      -- (13e) a category shape trust_policies could never hold is refused, so a
      -- typo cannot be stored as a declaration that matches nothing forever.
      v_checks := v_checks + 1;
      begin
        v_res := public.set_role_trust_ladder(v_role_key, 'Not A Category', c_ladder_l1);
        v_bad := array_append(v_bad,
          'PROBE 13e: the writer stored a declaration under a category trust_policies.action_category cannot hold, so it can never match a policy');
      exception when raise_exception then
        null; -- expected
      end;

      -- ══ PROBE 10b -- THE 836 COMPOSITION, DRIVEN END TO END ON THE REAL PATH.
      -- PROBE 5g calls the writer directly and would not notice if the
      -- composition were broken; this drives the door a person actually uses.
      --
      -- IDENTITY: migration 830's pattern in this same plan, verbatim in shape.
      -- auth.uid() reads request.jwt.claim.sub FIRST (checked against its live
      -- body, not assumed), so setting that GUC plus `set local role
      -- authenticated` genuinely drives the authenticated path. NOTHING IS
      -- FORGED IN auth.users -- v_actor is a real, active tenant-layer member
      -- discovered by query above, never a hardcoded id, and the entire arm sits
      -- inside the subtransaction that is deliberately rolled back, so no audit
      -- row or task mark is attributed to that person past this statement.
      -- request.jwt.claims is cleared first so identity comes from claim.sub
      -- alone; otherwise the leftover service_role claim would send
      -- apply_trust_promotion down its service branch and this would not be the
      -- human path at all.
      --
      -- If no such member exists, the arm makes ZERO comparisons and is NOT
      -- counted -- a probe that passes because its subject never ran is theatre.
      if v_actor is null then
        v_decide_skipped := true;
        v_decide_note := 'no active tenant-layer member exists for the fixture tenant';
      else
        begin
          perform set_config('request.jwt.claims', '', true);
          perform set_config('request.jwt.claim.sub', v_actor::text, true);
          set local role authenticated;
          v_decide := public.decide_human_task(v_task_decide, 'approved', null, null, null);
          reset role;
          v_decide_note := coalesce(v_decide.status, '(null row - already decided, or a second approver is required)');
        exception when others then
          reset role;
          v_decide_note := 'RAISED: ' || sqlerrm;
          v_decide_skipped := true;
        end;
        perform set_config('request.jwt.claim.sub', '', true);
      end if;
      select status, refusal_reason into v_task_status, v_task_refusal
        from public.human_tasks where id = v_task_decide;

      if v_decide_skipped then
        raise notice '838 VACUITY -- PROBE 10b could not reach decide_human_task on this database (%). The end-to-end composition with migration 836 made ZERO comparisons here and does NOT count toward the checks total; PROBE 10a (static contract) and PROBE 5g (the refusal payload) carry it instead.', v_decide_note;
      else
        v_checks := v_checks + 1;
        if coalesce(v_task_status, '') = 'approved' then
          v_bad := array_append(v_bad, format(
            'PROBE 10b: decide_human_task CLOSED a trust_promotion task as approved on a policy that cannot be promoted (it returned %s). That is migration 836''s exact defect -- the task says approved and nobody was promoted.',
            v_decide_note));
        elsif coalesce(btrim(coalesce(v_task_refusal, '')), '') = '' then
          v_bad := array_append(v_bad, format(
            'PROBE 10b: the task was not closed (good) but carries NO refusal_reason (decide returned %s), so the queue shows a card with no explanation of why it will not go through.',
            v_decide_note));
        elsif v_task_refusal not like '%this promotion cannot be applied%' then
          v_bad := array_append(v_bad, format(
            'PROBE 10b: the task carries refusal_reason "%s", which is not this migration''s refusal -- 836 is reporting some other cause and the real one is lost.',
            v_task_refusal));
        end if;
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
