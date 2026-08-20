-- 799_a_withdrawal_that_actually_withdraws.sql
-- ==========================================================================
-- WHY: withdraw_human_task has raised on every call since migration 790.
--
--     withdraw_human_task(own task, own workspace)
--       -> 23514 new row for relation "human_tasks" violates check
--          constraint "human_tasks_decision_reason_code_check"
--
-- 790 passes reason code 'withdrawn'. The constraint admits exactly
-- {wrong_facts, wrong_tone, missing_context, incomplete, not_permitted,
--  customer_specific, other}. 'withdrawn' has never been among them, so the
-- feature has never worked once: 0 of 476 human_tasks rows carry any non-null
-- decision_reason_code, and all 31 disposition='cancelled' rows come from the
-- expiry and stranding sweeps, which set the column directly.
--
-- Three migrations shipped it green because 790's, 794's and 798's assertions
-- all read pg_get_functiondef and matched TEXT. 798's probe 7 was the first
-- thing to CALL it, and it classified the failure rather than fixing it,
-- because the choice below is a product decision and 798 was about isolation.
--
-- == THE FOUNDER'S RULING, AND WHAT IT COSTS =============================
-- Reuse the existing bucket rather than widen the vocabulary: reason code
-- 'other'. A literal 'Other/Test' would fail the same constraint the same way
-- -- every admitted value is lowercase snake_case -- so the legal spelling is
-- what ships.
--
-- ⚠ THE OBVIOUS OBJECTION, MEASURED AND ANSWERED. Reusing 'other' looks like
-- it loses the ability to find withdrawals as a class, which is why 798 left
-- the decision open. It does not, because the two producers of
-- disposition='cancelled' differ on a column neither of them shares:
--
--     expiry / stranding sweeps : disposition='cancelled', reason_code IS NULL
--     a withdrawal              : disposition='cancelled', reason_code='other'
--
-- Measured on production before this migration: 31 cancelled rows, 0 with any
-- reason code. So "disposition = 'cancelled' and decision_reason_code is not
-- null" names withdrawals exactly, and PROBE 4 pins that rather than trusting
-- it. If a sweep ever starts writing a reason code the pin goes red, which is
-- the moment the class would silently stop being findable.
--
-- ⚠ THE VOCABULARY IS READ FROM THE CONSTRAINT, NEVER FROM A COPY. PROBE 1
-- parses pg_get_constraintdef and asserts the value this function passes is
-- admitted by it. A hard-coded list here would agree with itself forever and
-- is exactly how 'withdrawn' survived three migrations.
--
-- Everything 798 added is kept verbatim: the null-tenant bar, the tenant
-- predicate on the write, and the get-diagnostics row-count check that stops
-- a scoped predicate turning a refusal into a silent zero-row success.
-- ==========================================================================

begin;

-- ⚠ p_note CARRIES A DEFAULT AND IT MUST BE RESTATED. The first draft of this
-- migration wrote the signature from pg_get_function_identity_arguments,
-- which OMITS defaults, and the dry run refused it:
--     42P13 cannot remove parameter defaults from existing function
-- The same trap took migration 743. Read pg_get_function_ARGUMENTS instead;
-- dropping the default would also break every caller relying on the one-arg
-- form.
create or replace function public.withdraw_human_task(p_task_id uuid, p_note text default null::text)
returns human_tasks
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row    human_tasks;
  -- Captured once. Never gated on an identity test: the "auth.uid() is not
  -- null and" prefix SKIPS a check for a caller with no identity instead of
  -- failing it. 29 of those were closed in mig 749 and
  -- scripts/secdef-authority-prefix.mjs ratchets against a 30th.
  v_tenant uuid := auth_tenant_id();
  v_n      integer;
begin
  -- Mig 794's bar, kept.
  if v_tenant is null then
    raise exception 'not_authenticated';
  end if;

  -- ⚠ 'other', not 'withdrawn'. See this migration's header: 'withdrawn' is
  -- not admitted by human_tasks_decision_reason_code_check and never was, so
  -- every call raised 23514 from 790 until now. The withdrawal stays findable
  -- through disposition='cancelled' plus a non-null reason code, which the
  -- sweeps do not write.
  v_row := public.decide_human_task(p_task_id, 'rejected', 'other', p_note);

  -- NULL composite = already decided.
  if v_row.id is null then
    return null;
  end if;

  update human_tasks
     set disposition = 'cancelled'
   where id = p_task_id
     and tenant_id = v_tenant;

  -- A predicate that can miss must be able to SAY it missed (mig 798).
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'withdraw_incomplete: task % was decided but the withdrawal mark reached % row(s); refusing to report a partial write as success', p_task_id, v_n;
  end if;

  select * into v_row from human_tasks where id = p_task_id and tenant_id = v_tenant;
  return v_row;
end;
$function$;

revoke all on function public.withdraw_human_task(uuid, text) from public, anon, authenticated;
grant execute on function public.withdraw_human_task(uuid, text) to authenticated;

do $verify$
declare
  v_bad      text[] := '{}';
  v_checks   int := 0;
  v_probes   int := 0;
  v_allowed  text[];
  v_src      text;
  v_tenant   uuid;
  v_user     uuid;
  v_task     uuid;
  v_row      human_tasks;
  v_sweep_with_reason int;
  v_found    int;
begin
  ----------------------------------------------------------------------
  -- PROBE 1 -- the value is admitted by the CONSTRAINT, read from the
  -- catalogue. Not from a list restated here, which is how 'withdrawn'
  -- survived three migrations that all "verified" this function.
  ----------------------------------------------------------------------
  select array_agg(m[1]) into v_allowed
  from pg_constraint c,
       lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
  where c.conname = 'human_tasks_decision_reason_code_check';

  v_checks := v_checks + 1;
  if v_allowed is null or array_length(v_allowed, 1) is null then
    v_bad := array_append(v_bad, 'could not read the reason-code vocabulary from the constraint -- this probe is comparing nothing');
  end if;

  v_checks := v_checks + 1;
  if not ('other' = any(v_allowed)) then
    v_bad := array_append(v_bad, format('the function passes ''other'' and the constraint admits %L -- the same defect as ''withdrawn''', v_allowed));
  end if;

  v_checks := v_checks + 1;
  if 'withdrawn' = any(v_allowed) then
    v_bad := array_append(v_bad, 'the constraint now admits ''withdrawn'' -- if the vocabulary was widened deliberately, pass it instead of ''other'' and delete this arm; until then the two disagree');
  end if;
  v_probes := v_probes + 1;

  ----------------------------------------------------------------------
  -- PROBE 2 -- the function no longer passes the illegal value, and still
  -- carries everything 798 added. Source pins, so a later edit that drops
  -- the tenant predicate or the row-count check goes red here.
  ----------------------------------------------------------------------
  v_src := regexp_replace(
    pg_get_functiondef('public.withdraw_human_task(uuid,text)'::regprocedure),
    '--[^' || chr(10) || ']*', '', 'g');

  v_checks := v_checks + 1;
  if position('''withdrawn''' in v_src) > 0 then
    v_bad := array_append(v_bad, 'the body still passes ''withdrawn'' after the comment strip');
  end if;

  v_checks := v_checks + 1;
  if position('''rejected'', ''other''' in v_src) = 0 then
    v_bad := array_append(v_bad, 'the body does not pass ''other'' to decide_human_task');
  end if;

  v_checks := v_checks + 1;
  if position('tenant_id = v_tenant' in v_src) = 0 then
    v_bad := array_append(v_bad, 'mig 798''s tenant predicate on the write is gone');
  end if;

  v_checks := v_checks + 1;
  if position('get diagnostics' in v_src) = 0 then
    v_bad := array_append(v_bad, 'mig 798''s row-count check is gone -- a scoped predicate that can miss must say it missed');
  end if;

  v_checks := v_checks + 1;
  if length(v_src) < 400 then
    v_bad := array_append(v_bad, format('the function body read back as %s chars -- too short to be the real one, so the pins above compared nothing', length(v_src)));
  end if;
  v_probes := v_probes + 1;

  ----------------------------------------------------------------------
  -- PROBE 3 -- DRIVE IT. The three migrations that touched this function
  -- all passed while it raised on every call, because every assertion in
  -- them read text. This one calls it.
  ----------------------------------------------------------------------
  select t.id, p.user_id into v_tenant, v_user
  from public.tenants t
  join public.profiles p on p.tenant_id = t.id
  where t.slug = 'review-lab-disposable'
  limit 1;

  v_checks := v_checks + 1;
  if v_tenant is null or v_user is null then
    v_bad := array_append(v_bad, 'no fixture workspace -- probe 3 drove nothing');
  else
    insert into public.human_tasks (tenant_id, type, title, detail, source, status, origin)
    values (v_tenant, 'escalation', 'vddp799 withdrawal probe', 'created by migration 799, rolled back', 'de', 'pending', 'exercise')
    returning id into v_task;

    perform set_config('request.jwt.claim.sub', v_user::text, true);
    execute 'set local role authenticated';

    begin
      v_row := public.withdraw_human_task(v_task, 'withdrawn by migration 799 own probe');
    exception when others then
      v_bad := array_append(v_bad, format('withdraw_human_task RAISED on its own workspace own task: %s %s -- this is the defect 799 exists to fix', sqlstate, sqlerrm));
    end;

    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', true);

    v_checks := v_checks + 1;
    if v_row.id is null then
      v_bad := array_append(v_bad, 'withdraw_human_task returned NULL on a fresh pending task -- it should have withdrawn it');
    end if;

    v_checks := v_checks + 1;
    if coalesce(v_row.disposition, '') <> 'cancelled' then
      v_bad := array_append(v_bad, format('disposition after withdrawal is %L, expected cancelled', v_row.disposition));
    end if;

    v_checks := v_checks + 1;
    if coalesce(v_row.decision_reason_code, '') <> 'other' then
      v_bad := array_append(v_bad, format('decision_reason_code after withdrawal is %L, expected other', v_row.decision_reason_code));
    end if;

    v_checks := v_checks + 1;
    if coalesce(v_row.status, '') <> 'rejected' then
      v_bad := array_append(v_bad, format('status after withdrawal is %L, expected rejected', v_row.status));
    end if;
  end if;
  v_probes := v_probes + 1;

  ----------------------------------------------------------------------
  -- PROBE 4 -- a withdrawal is still FINDABLE as a class. This is the whole
  -- cost of reusing 'other', and it is measured rather than assumed.
  ----------------------------------------------------------------------
  select count(*) into v_sweep_with_reason
  from public.human_tasks
  where disposition = 'cancelled' and decision_reason_code is not null
    and coalesce(origin, '') <> 'exercise';

  v_checks := v_checks + 1;
  if v_sweep_with_reason <> 0 then
    v_bad := array_append(v_bad, format('%s pre-existing cancelled row(s) already carry a reason code, so cancelled + reason-is-not-null no longer names withdrawals exactly -- the class this ruling relied on has stopped being findable', v_sweep_with_reason));
  end if;

  select count(*) into v_found
  from public.human_tasks
  where id = v_task and disposition = 'cancelled' and decision_reason_code is not null;

  v_checks := v_checks + 1;
  if v_found <> 1 then
    v_bad := array_append(v_bad, 'the task this probe withdrew is not findable by cancelled + reason-is-not-null');
  end if;
  v_probes := v_probes + 1;

  ----------------------------------------------------------------------
  if array_length(v_bad, 1) > 0 then
    raise exception E'799 VERIFICATION FAILED (% assertions across % probes):\n  %',
      v_checks, v_probes, array_to_string(v_bad, E'\n  ');
  end if;

  if coalesce(current_setting('app.probe_799_dry_run', true), '') = 'on' then
    raise exception E'799 DRY RUN COMPLETE -- % assertions across % probes, 0 findings.\n  DRIVEN: withdraw_human_task on its own task returned status=%, disposition=%, reason=%. It has raised 23514 on every call since 790.\n  FINDABLE: % pre-existing cancelled row(s) carry a reason code (must be 0), and the withdrawn task IS found by cancelled + reason-is-not-null.\n  Aborting deliberately: nothing here is committed.',
      v_checks, v_probes, v_row.status, v_row.disposition, v_row.decision_reason_code, v_sweep_with_reason;
  end if;

  raise notice '799: % assertions across % probes, 0 findings. withdraw_human_task now returns status=%, disposition=%, reason=%.',
    v_checks, v_probes, v_row.status, v_row.disposition, v_row.decision_reason_code;
end;
$verify$;

commit;
