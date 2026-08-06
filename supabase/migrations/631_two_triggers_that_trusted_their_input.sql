-- 631 — two triggers that trusted their input.
--
-- Both came out of reading all 14 cross-table trigger writers. Neither is
-- exploitable today; both are one line away from being exploitable the moment
-- something upstream changes, which is exactly when nobody is looking.
--
-- ── 1. close_escalations_for_finished_goal DISARMED THE DECISION GUARD ────
--
-- It calls `set_config('app.allow_task_decision','on', true)` — the exact flag
-- `guard_human_task_decision` checks to decide whether a write to
-- human_tasks.status is sanctioned — and then never puts it back. For the
-- remainder of that transaction the guard is off.
--
-- What saves it today: the setting is transaction-local so it dies at commit,
-- and PostgREST runs one statement per transaction, so there is no second
-- write to slip through behind it. What it does is also correct — it only
-- REJECTS tasks tied to the finished objective, and decide_human_task
-- deliberately does not gate rejections ("a rule that stops someone saying no
-- is not an authority model"). The defect is the unreset flag, not the intent.
--
-- ⚠⚠ THE FIX IS RESTORE, NOT CLEAR. Setting it to 'off' afterwards would be a
-- worse bug than the one being fixed: if this trigger ever fires inside an
-- outer sanctioned operation (a decide_* RPC that cascades into an objective
-- status change), clearing the flag would disarm that operation's REMAINING
-- writes and break it. Save the prior value, restore the prior value.
--
-- ── 2. advance_dunning_cadence WROTE ACROSS TENANTS ───────────────────────
--
-- It parses an invoice id out of a TEXT dedupe_key and then updates
-- `renewal_invoices WHERE id = <that uuid>` — with no tenant predicate at all.
-- The id is attacker-shaped data (a string field), and the row it lands on is
-- chosen entirely by that string.
--
-- Unreachable today because `action_executions` has RLS on with only a SELECT
-- policy, so no user can insert one — only service_role. But the day that
-- table gains an INSERT policy, a crafted `dunning:<other tenant's invoice>:9`
-- silently advances another workspace's dunning ladder and suppresses the
-- chase they were owed. A trigger should not depend on a neighbouring table's
-- policy for its tenant isolation.

begin;

-- ════════════════════════════════════════════════════════════════════════
-- 1. Restore the guard flag instead of leaving it on.
-- ════════════════════════════════════════════════════════════════════════
create or replace function public.close_escalations_for_finished_goal()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_prev text;
BEGIN
  IF NEW.status IN ('achieved', 'abandoned') AND NEW.status IS DISTINCT FROM OLD.status THEN
    -- ⚠ Capture whatever was already there. Restoring it (rather than forcing
    -- 'off') is what keeps this safe to call from inside an outer sanctioned
    -- operation — see the migration header.
    v_prev := coalesce(current_setting('app.allow_task_decision', true), '');

    PERFORM set_config('app.allow_task_decision', 'on', true);  -- mig 487 sanctioned path
    UPDATE human_tasks
       SET status = 'rejected',
           disposition = 'cancelled',
           decision_note = format(
             'Closed automatically: the goal this asked about is %s. Nobody needs to rule on it now, and no human ruling was made.',
             NEW.status),
           decided_at = now(),
           updated_at = now()
     WHERE related_table = 'de_objectives'
       AND related_id = NEW.id
       AND status = 'pending';

    -- Re-arm. An exception between the two would abort the transaction and
    -- take the setting with it, so there is no path that leaves it 'on'.
    PERFORM set_config('app.allow_task_decision', v_prev, true);
  END IF;
  RETURN NEW;
END
$function$;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Scope the invoice write to the execution's own workspace.
-- ════════════════════════════════════════════════════════════════════════
create or replace function public.advance_dunning_cadence()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_invoice uuid;
  v_stage   int;
begin
  if new.dedupe_key is null or new.dedupe_key not like 'dunning:%' then
    return null;
  end if;
  if new.decision not in ('executed_after_approval', 'auto_executed') then
    return null;
  end if;

  v_invoice := nullif(split_part(new.dedupe_key, ':', 2), '')::uuid;
  v_stage   := nullif(split_part(new.dedupe_key, ':', 3), '')::int;
  if v_invoice is null or v_stage is null then return null; end if;

  -- greatest(): a late-executing lower rung must never drag the ladder back
  -- down and re-open a chase the customer has already had.
  update renewal_invoices
     set cadence_stage = greatest(coalesce(cadence_stage, 0), v_stage),
         updated_at    = now()
   where id = v_invoice
     -- ⚠ The invoice id comes out of a TEXT field. Without this the row is
     -- chosen entirely by attacker-shaped data and can belong to any tenant.
     and tenant_id = new.tenant_id;

  return null;
exception when others then
  -- A malformed key must not be able to roll back a real execution.
  return null;
end;
$function$;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFY — behaviour, not text. Both fixes are exercised for real.
-- ════════════════════════════════════════════════════════════════════════
do $verify$
declare
  v_ten_a   uuid; v_ten_b uuid; v_defn uuid; v_obj uuid;
  v_inv_a   uuid; v_inv_b uuid;
  v_b_before int; v_b_after int;
  v_a_before int; v_a_after int;
  v_flag    text;
  v_ran     boolean := false;
begin
  select id into v_ten_a from tenants where slug = 'outsourcetel-hq';
  select id into v_ten_b from tenants where slug = 'acme-telecom';
  select id into v_defn  from action_definitions limit 1;
  select id, coalesce(cadence_stage, 0) into v_inv_b, v_b_before
    from renewal_invoices where tenant_id = v_ten_b limit 1;
  select id, coalesce(cadence_stage, 0) into v_inv_a, v_a_before
    from renewal_invoices where tenant_id = v_ten_a limit 1;
  select id into v_obj from de_objectives where status not in ('achieved','abandoned') limit 1;

  -- ⚠ THE PROBE WRITES REAL ROWS, so it runs inside a sub-block that always
  -- raises. plpgsql rolls the block's DB writes back to its implicit
  -- savepoint, while the variables keep the values captured inside it — so the
  -- findings survive and the test data does not. Asserting on the function
  -- SOURCE instead would only re-read what this migration just wrote.
  begin
    if v_defn is not null and v_ten_a is not null then
      -- FIX 2a: an execution in workspace A naming workspace B's invoice.
      if v_inv_b is not null then
        insert into action_executions (tenant_id, action_definition_id, mode, decision, dedupe_key)
        values (v_ten_a, v_defn, 'execute', 'auto_executed', 'dunning:' || v_inv_b::text || ':9');
        select coalesce(cadence_stage, 0) into v_b_after from renewal_invoices where id = v_inv_b;
      end if;

      -- FIX 2b CONTROL: the same shape inside ONE workspace must still work,
      -- or the fix has merely broken dunning and 2a passed for the wrong reason.
      if v_inv_a is not null then
        insert into action_executions (tenant_id, action_definition_id, mode, decision, dedupe_key)
        values (v_ten_a, v_defn, 'execute', 'auto_executed',
                'dunning:' || v_inv_a::text || ':' || (v_a_before + 1)::text);
        select coalesce(cadence_stage, 0) into v_a_after from renewal_invoices where id = v_inv_a;
      end if;
    end if;

    -- FIX 1: finishing an objective must leave the guard flag as it found it.
    if v_obj is not null then
      perform set_config('app.allow_task_decision', 'zz_sentinel_631', true);
      update de_objectives set status = 'achieved' where id = v_obj;
      v_flag := coalesce(current_setting('app.allow_task_decision', true), '');
    end if;

    v_ran := true;
    raise exception 'ZZ_ROLLBACK_PROBE_631';
  exception when others then
    if sqlerrm <> 'ZZ_ROLLBACK_PROBE_631' then raise; end if;   -- real errors still surface
  end;

  if not v_ran then raise exception 'the probe block did not run to completion'; end if;

  if v_inv_b is not null and v_b_after is distinct from v_b_before then
    raise exception 'CROSS-TENANT WRITE STILL POSSIBLE: another workspace''s invoice moved % -> %',
      v_b_before, v_b_after;
  end if;
  if v_inv_a is not null and v_a_after is distinct from v_a_before + 1 then
    raise exception 'CONTROL FAILED: same-tenant cadence did not advance (% -> %, expected %) — the fix broke dunning',
      v_a_before, v_a_after, v_a_before + 1;
  end if;
  if v_obj is not null and v_flag <> 'zz_sentinel_631' then
    raise exception 'the guard flag was not restored: expected zz_sentinel_631, found "%"', v_flag;
  end if;

  raise notice 'cross-tenant write blocked; same-tenant cadence still advances (%->%); guard flag restored',
    v_a_before, v_a_after;
end;
$verify$;

commit;
