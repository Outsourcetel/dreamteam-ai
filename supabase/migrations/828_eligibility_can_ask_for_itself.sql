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
-- ── Step 2 signatures, verbatim (read before writing anything below) ───────
--   request_trust_promotion(p_policy_id uuid) -> jsonb
--   trust_evidence_for(p_policy trust_policies) -> jsonb
--
-- request_trust_promotion takes ONE argument, not (uuid, jsonb) as the task
-- brief assumed. Adapted below to `perform request_trust_promotion(v_p.id)`.
--
-- ⚠⚠ A SECOND, DEEPER DIFFERENCE THE BRIEF COULD NOT KNOW, found by reading
-- the BODY (not just the signature), per Step 2's own instruction to do so:
-- request_trust_promotion is a USER-FACING action, not a system-safe one.
-- Its first gate after finding the policy is
--
--   if not exists (select 1 from profiles
--                   where user_id = auth.uid() and tenant_id = v_policy.tenant_id)
--   then raise exception 'not a member of this tenant';
--
-- with NO service_role or system-caller branch anywhere in its body --
-- unlike can_access_de, which it also calls for DE-scoped policies and which
-- DOES special-case service_role (`coalesce(auth.role(),'') = 'service_role'
-- OR ...`). auth.uid() and auth.role() both read request.jwt.claims
-- (confirmed by reading their definitions), which is empty for ANY caller
-- with no end-user JWT -- a cron job, an edge function on the service-role
-- key (a Supabase service-role token carries no `sub` claim), and this
-- migration's own dry run via db-query.mjs, which runs as bare `postgres`
-- with no JWT at all (verified live: `select auth.uid(), auth.role()` both
-- returned null in that session). There is no path by which an unattended
-- caller satisfies this check today.
--
-- Concretely: of the 2 eligible policies, one already has a pending task
-- (skipped, correctly, before any call is attempted). The other --
-- a9574721-cd41-4adb-a0f8-7836852091c7, tenant 5bb802e1..., de_id
-- 43313f2e-1c2d-4ff4-8b18-b35f5158e65d -- has none, and IS the row this task
-- exists to unblock. Calling request_trust_promotion on it from any
-- unattended context raises 'not a member of this tenant', empirically,
-- every time, today (see task-1-report.md for the verbatim dry-run output).
--
-- This is not a bug for Task 1 to route around. Fixing it means teaching
-- request_trust_promotion to accept a system caller, which is an AUTHORITY
-- decision -- who, or what, is allowed to ask for a promotion on a tenant's
-- behalf -- squarely inside what tasks 3 and 7 of this program are already
-- blocked on the founder naming (see progress.md). request_trust_promotion
-- is a CONSUMED interface for Task 1, not a produced one, and is left
-- untouched. No caller identity is forged to route around it either --
-- forging auth.users / request.jwt.claims to manufacture a passing test is
-- exactly the auth-identity boundary this repo does not cross, even for a
-- dry run that rolls back.
--
-- So: request_eligible_promotions calls request_trust_promotion for every
-- eligible, task-free policy IN FULL -- the bridge this task exists to build
-- -- and instead of one caller's rejection aborting the whole sweep (silently
-- costing every OTHER tenant its chance to be asked), each attempt is
-- wrapped individually. A rejection is recorded by policy id, tenant and
-- reason -- never swallowed, never miscounted as "requested". This is an
-- ADDITIVE change to the brief's return shape: `examined`, `requested`,
-- `skipped_existing` and `thin` all keep exactly their specified meaning;
-- `failed` and `failures` are new and strictly additive.
--
-- `thin` is counted only for a policy that was ACTUALLY requested (moved
-- inside the success branch, after `perform` returns) -- the founder ruling
-- describes what a RAISED request carries, and a request that was refused
-- was never raised.
-- ============================================================================

begin;

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

    begin
      perform public.request_trust_promotion(v_p.id);
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
      -- request_trust_promotion refuses a caller with no matching tenant
      -- membership (or, for a DE-scoped policy, no reporting-line access) --
      -- see header. That refusal is accounted for by name, not silently
      -- folded into a lower "requested" count with no explanation. A single
      -- policy's refusal must not cost every OTHER tenant's eligible policy
      -- its own chance to be asked, so the loop continues.
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

-- ── verification ────────────────────────────────────────────────────────
do $verify$
declare
  v_bad                text[] := '{}';
  v_checks             int := 0;
  v_res                jsonb;
  v_eligible_before    int;
  v_skip_expected      int;
  v_examined_expected  int;
  v_reasons            text;
begin
  select count(*) into v_examined_expected
  from public.trust_policies where status = 'active';

  -- PROBE 1's denominator: an eligible policy with no open task.
  select count(*) into v_eligible_before
  from public.trust_policies p
  where (public.trust_evidence_for(p)->>'eligible')::boolean
    and p.pending_task_id is null;

  select count(*) into v_skip_expected
  from public.trust_policies p
  where (public.trust_evidence_for(p)->>'eligible')::boolean
    and p.pending_task_id is not null;

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
  -- PROBE 3 -- an eligible policy with NO open task is ACCOUNTED FOR:
  -- either genuinely requested, or its refusal is individually recorded.
  -- Never silently dropped. Denominator stated (v_eligible_before), not
  -- only how many fired -- and if it is 0 (fresh/empty database, or the
  -- two live policies above have since moved on) the comparison below is
  -- vacuously 0 = 0 and this migration still replays cleanly, per
  -- CLAUDE.md's replay-on-empty-database rule; a loud notice says so
  -- rather than a silent pass standing in for a real proof.
  ----------------------------------------------------------------------
  if v_eligible_before = 0 then
    raise notice '828 PROBE 3: denominator is 0 -- the requested+failed = eligible-before comparison is vacuous on this dataset.';
  end if;

  v_checks := v_checks + 1;
  if coalesce((v_res->>'requested')::int, 0) + coalesce((v_res->>'failed')::int, 0) <> v_eligible_before then
    v_bad := array_append(v_bad, format(
      'accounted for %s requested + %s failed = %s, expected %s eligible-without-a-task',
      v_res->>'requested', v_res->>'failed',
      coalesce((v_res->>'requested')::int, 0) + coalesce((v_res->>'failed')::int, 0),
      v_eligible_before));
  end if;

  ----------------------------------------------------------------------
  -- PROBE 4 -- when it fails, it fails for the KNOWN reason (see header),
  -- not a swallowed, unrelated bug. Only meaningful when something did
  -- fail; on a dataset with none, this probe has nothing to check and
  -- says so rather than reporting a pass that proves nothing.
  ----------------------------------------------------------------------
  if coalesce((v_res->>'failed')::int, 0) > 0 then
    select string_agg(f->>'error', ' | ') into v_reasons
    from jsonb_array_elements(coalesce(v_res->'failures', '[]'::jsonb)) f;

    v_checks := v_checks + 1;
    if v_reasons !~* 'not a member of this tenant|not_responsible_for_de' then
      v_bad := array_append(v_bad, format(
        '%s failure(s) for a reason OTHER than the known auth boundary: %s',
        v_res->>'failed', v_reasons));
    end if;
  else
    raise notice '828 PROBE 4: nothing failed on this dataset -- the known-reason check has nothing to compare and is skipped, not passed.';
  end if;

  ----------------------------------------------------------------------
  if array_length(v_bad, 1) > 0 then
    raise exception E'828 VERIFICATION FAILED (% assertions):\n  %',
      v_checks, array_to_string(v_bad, E'\n  ');
  end if;

  raise notice '828: % assertions, 0 findings. examined=%, requested=%, skipped_existing=%, thin=%, failed=%.',
    v_checks, v_res->>'examined', v_res->>'requested', v_res->>'skipped_existing', v_res->>'thin', v_res->>'failed';
end;
$verify$;

commit;
