-- 675_an_item_completes_when_the_work_lands.sql
-- ==========================================================================
-- WHY: mig 674 lets a checklist item name a verb the DE performs, and mig
-- 673's certify probe (Task 2) guards that the named verb is actually
-- runnable. Neither of them decides when the item counts as DONE. Today
-- that only happens because a human (update_onboarding_item) or a DE
-- (update_onboarding_item_as_de, mig 648) SAYS SO. A bound item needs a
-- third path: the receipt of the action itself flips it, because otherwise
-- "bound to a verb" is decoration — the item still only completes on
-- somebody's word, exactly the "stored marker read as truth" trap this
-- repo has paid for before (mig 642: an approval nobody carried out).
--
-- LINKAGE. `action_executions.subject_kind` is CHECK'd to ('de','specialist')
-- — it identifies the EMPLOYEE, not the work being completed, and a third
-- value fails at insert. So the link rides `dedupe_key`, matching the
-- existing house pattern `dunning:<invoice>:<stage>` (mig 595/661):
--     dedupe_key = 'onboarding:<project_id>:<item_key>'
--
-- ⚠ MIG-661 GAP, FOUND AND NOT SILENTLY SHIPPED. 661's own header is the
-- warning this migration must be read against: `advance_dunning_cadence`
-- matched only the ONE key shape `run_dunning_sweep` produced, and the DE
-- doing the identical chase through the generic registered-action path
-- wrote a different key and went uncounted for the feature's entire life.
-- I checked whether the equivalent is already true here, before writing a
-- guard that could repeat it:
--   - `supabase/functions/connector-hub/index.ts` computes `dedupeKey`
--     unconditionally at the point of execution —
--     `const dedupeKey = def.risk.idempotent ? null : `${def.id}:${JSON.stringify(validated.values)}`;`
--     (line ~7108) — with NO caller-supplied override. This is the ONLY
--     execution path that exists today for `configure_customer_setup`
--     (mig 651, the one verb currently bound to any item). It is
--     STRUCTURALLY UNABLE to write an `onboarding:...` key.
--   - `supabase/functions/playbook-execute/index.ts` writes onboarding-
--     related executions (project creation, invoice generation) with
--     `p_dedupe_key: null` — also never `onboarding:...`.
-- So as of this migration, NO caller in the codebase can satisfy this
-- trigger's guard — not "one route recognised, one silently dropped" like
-- 661, but zero. That is a gap in the CALLER side (a future task must add
-- a dedicated writer that sets this key explicitly when a DE completes a
-- bound item, the same way `run_dunning_sweep` sets `dunning:...` directly
-- rather than going through connector-hub's generic path — or connector-hub
-- must grow a caller-supplied dedupe_key override, which it does not have).
-- It is NOT a reason to withhold the trigger: Task 3's job is to make the
-- rule correct and ready for whichever caller lands next, not to build
-- that caller. Recorded here and in the task report so the gap is visible
-- to whoever builds it, rather than discovered the way 661 was.
--
-- TERMINAL-ITEM GUARD (deviation from the brief's literal SQL, and why).
-- mig 648 established, twice, that a `signed_off` item is TERMINAL — a
-- person's decision, and nothing else may touch it again
-- (`item_already_signed_off` in both `update_onboarding_item` and
-- `update_onboarding_item_as_de`). The brief's update has no such guard: a
-- late-arriving receipt for an item that a human has already signed off
-- would overwrite `status` back to `done`, silently downgrading a human
-- decision to a machine one. Added `and i->>'status' <> 'signed_off'` to
-- the CASE so this trigger leaves a signed-off item completely untouched
-- — same invariant, same reason mig 648 gives it.
--
-- WHAT IT DOES NOT DO. It does not call `onboarding_check_complete`.
-- `update_onboarding_item_as_de`'s closing comment is explicit and this
-- trigger honours it rather than reopening it: "A non-signoff item
-- completing the project is the human function's rule and stays the
-- human function's rule: an employee must not be able to drive a project
-- to completed as a side effect of ticking the last box." A receipt
-- landing is still the employee's work arriving, not a human's decision —
-- so project-level completion stays exactly where it already is, on the
-- human-facing `update_onboarding_item` / `resolve_onboarding_signoff`
-- paths. `progress_pct` still recomputes automatically: it is driven by
-- the pre-existing `onboarding_projects_progress` BEFORE trigger on
-- `items_state`, which this UPDATE fires like any other.
-- ==========================================================================

begin;

create or replace function public.complete_onboarding_item_from_execution()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_project uuid;
  v_key     text;
begin
  -- Only a real, completed execution advances anything.
  if new.decision not in ('auto_executed', 'executed_after_approval') then
    return null;
  end if;
  if new.dedupe_key is null or new.dedupe_key not like 'onboarding:%' then
    return null;
  end if;

  v_project := nullif(split_part(new.dedupe_key, ':', 2), '')::uuid;
  v_key     := nullif(split_part(new.dedupe_key, ':', 3), '');
  if v_project is null or v_key is null then return null; end if;

  -- Tenant-scoped by construction: the id arrives inside a text key, and the
  -- WHERE clause below still requires it to match the execution's own
  -- tenant_id before anything is written.
  update onboarding_projects p
     set items_state = (
           select jsonb_agg(case when i->>'key' = v_key and i->>'status' <> 'signed_off'
                                 then i || jsonb_build_object(
                                        'status',  'done',
                                        'done_at', now(),
                                        'note',    coalesce(new.receipt, 'applied'))
                                 else i end)
             from jsonb_array_elements(p.items_state) i)
   where p.id = v_project
     and p.tenant_id = new.tenant_id;

  return null;
exception when others then
  -- A malformed key must not roll back an execution that already reached a
  -- customer's system.
  return null;
end;
$function$;

-- Supabase grants anon/authenticated as NAMED ROLES; `revoke from public`
-- alone leaves them reachable (security_default_execute_grant). A trigger
-- function cannot be invoked directly regardless of grants (Postgres
-- refuses to CALL/SELECT a `returns trigger` function), but the revoke is
-- the standing perimeter rule for every new function in this repo and is
-- asserted, not just stated, below.
revoke execute on function public.complete_onboarding_item_from_execution()
  from public, anon, authenticated;

drop trigger if exists trg_onboarding_item_completes on public.action_executions;
create trigger trg_onboarding_item_completes
  after insert or update of decision on public.action_executions
  for each row execute function public.complete_onboarding_item_from_execution();

-- ── Prove the guards, the grant, and the attachment. ───────────────────────
do $$
declare
  v_def         text;
  v_trg         integer;
  v_anon_exec   boolean;
  v_authed_exec boolean;
begin
  v_def := pg_get_functiondef('public.complete_onboarding_item_from_execution()'::regprocedure);

  if v_def not ilike '%auto_executed%' or v_def not ilike '%executed_after_approval%' then
    raise exception '675: the decision gate was dropped — a non-completed execution could mark an item done';
  end if;
  if v_def not ilike '%onboarding:%' then
    raise exception '675: the dedupe_key prefix guard was dropped';
  end if;
  if v_def not ilike '%signed_off%' then
    raise exception '675: the terminal-item guard was dropped — a receipt could downgrade a human sign-off back to done';
  end if;
  if v_def not ilike '%tenant_id = new.tenant_id%' then
    raise exception '675: the tenant scope was dropped from the update — a key could reach across tenants';
  end if;
  if v_def not ilike '%exception when others%' then
    raise exception '675: a malformed key would now roll back a real execution';
  end if;

  select has_function_privilege('anon', 'public.complete_onboarding_item_from_execution()', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.complete_onboarding_item_from_execution()', 'EXECUTE')
    into v_anon_exec, v_authed_exec;
  if v_anon_exec then
    raise exception '675: anon can execute complete_onboarding_item_from_execution — that is the internet';
  end if;
  if v_authed_exec then
    raise exception '675: authenticated can execute complete_onboarding_item_from_execution directly';
  end if;

  select count(*) into v_trg from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
   where p.proname = 'complete_onboarding_item_from_execution' and not tg.tgisinternal;
  if v_trg <> 1 then
    raise exception '675: expected 1 trigger on complete_onboarding_item_from_execution, found %', v_trg;
  end if;

  raise notice '675: an item now completes from a receipt — decision gated, dedupe_key scoped, signed_off terminal, tenant-scoped, anon/authenticated closed';
end $$;

commit;
