-- 661_a_chase_that_counts_whoever_sent_it.sql
-- ============================================================================
-- `renewal_invoices.cadence_stage` has been 0 since the beginning, for every
-- invoice, and the dunning ladder has never advanced once. That is why the
-- Billing employee keeps proposing the same chase for the same $85,000 and the
-- same question keeps arriving in the queue — 22 of the 64 triaged tasks were
-- one commercial decision, asked repeatedly.
--
-- WHY. `advance_dunning_cadence` is a trigger on action_executions and IS
-- correctly attached. Its first guard is:
--
--   if new.dedupe_key is null or new.dedupe_key not like 'dunning:%' then return null;
--
-- Only `run_dunning_sweep` writes that key shape. When the EMPLOYEE proposes
-- the identical chase through the registered-action path, connector-hub writes
-- the generic key `<action_definition_id>:{"external_ref":...}`, the guard drops
-- it, and the ladder does not move. Two paths do the same work and only one of
-- them counts.
--
-- Worse, the only two rows that ever carried a `dunning:` key were
-- human_gated_destructive and never executed. So neither path has ever moved the
-- ladder. The mechanism is not subtly wrong; it has never once fired.
--
-- THE RULE: the cadence is a property of THE WORK — a chase was sent to this
-- customer about this invoice — not of the CHANNEL that produced it. The trigger
-- now recognises both.
--
-- ⚠ THE STAGE IS READ, NOT GUESSED, and this is the part that needed care.
-- `action_key` is NOT unique per rung: on the platform ladder
-- `send_payment_reminder` is BOTH stage 1 ("Friendly reminder", 7 days) and
-- stage 2 ("Firm follow-up", 21 days). So an action key alone cannot say which
-- rung was climbed. The faithful rule is the highest rung whose action matches
-- AND whose day threshold the invoice has ACTUALLY passed — which is precisely
-- what dunning_position would have offered the employee when it acted.
--
-- greatest() is kept: a late-executing lower rung must never drag the ladder
-- back down and re-open a chase the customer has already had. Tenant scoping is
-- kept: the invoice reference arrives from a TEXT param and must never select a
-- row outside the acting tenant. The exception guard is kept: a malformed input
-- must not roll back a real execution that already reached a customer.
-- ============================================================================

begin;

create or replace function public.advance_dunning_cadence()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_invoice uuid;
  v_stage   int;
  v_key     text;
  v_ref     text;
begin
  -- Only a real, completed execution advances anything.
  if new.decision not in ('executed_after_approval', 'auto_executed') then
    return null;
  end if;

  -- ── PATH A: the sweep's own key, unchanged. dunning:<invoice>:<stage> ────
  if new.dedupe_key is not null and new.dedupe_key like 'dunning:%' then
    v_invoice := nullif(split_part(new.dedupe_key, ':', 2), '')::uuid;
    v_stage   := nullif(split_part(new.dedupe_key, ':', 3), '')::int;

  -- ── PATH B (mig 661): the same chase, sent by an employee. ──────────────
  -- Recognise it by the ACTION it ran, resolve the invoice from the reference
  -- it was given, and read the rung out of the ladder.
  else
    select ad.action_key into v_key
      from action_definitions ad where ad.id = new.action_definition_id;
    if v_key is null then return null; end if;

    v_ref := nullif(btrim(new.params->>'external_ref'), '');
    if v_ref is null then return null; end if;

    -- Tenant-scoped by construction: the reference is caller-supplied text.
    select ri.id into v_invoice
      from renewal_invoices ri
     where ri.tenant_id = new.tenant_id
       and ri.source_external_ref = v_ref
     limit 1;
    if v_invoice is null then return null; end if;

    -- The highest rung this action can represent that the invoice has actually
    -- reached. Not the action's "usual" stage — action_key repeats across rungs.
    select max(r.stage) into v_stage
      from dunning_rungs r
      join dunning_ladders l on l.id = r.ladder_id
      join renewal_invoices ri on ri.id = v_invoice
     where l.active
       and (l.tenant_id = new.tenant_id or l.tenant_id is null)
       and r.action_key = v_key
       and ri.due_date is not null
       and (current_date - ri.due_date) >= coalesce(r.after_days_overdue, 0);
  end if;

  if v_invoice is null or v_stage is null then return null; end if;

  update renewal_invoices
     set cadence_stage = greatest(coalesce(cadence_stage, 0), v_stage),
         updated_at    = now()
   where id = v_invoice
     and tenant_id = new.tenant_id;

  return null;
exception when others then
  -- A malformed key or reference must not roll back an execution that has
  -- already reached a customer.
  return null;
end;
$function$;

-- ── Prove it, including that the OLD path still works. ────────────────────
do $$
declare
  v_def text;
  v_trg int;
  v_expected int;
begin
  v_def := pg_get_functiondef('public.advance_dunning_cadence()'::regprocedure);

  if v_def not ilike '%PATH A%' or v_def not ilike '%dunning:%' then
    raise exception '661: the sweep path was lost — run_dunning_sweep would stop advancing';
  end if;
  if v_def not ilike '%action_definitions%' or v_def not ilike '%external_ref%' then
    raise exception '661: the employee path did not land';
  end if;
  if v_def not ilike '%greatest(coalesce(cadence_stage, 0), v_stage)%' then
    raise exception '661: a late lower rung could now drag the ladder back down';
  end if;
  if v_def not ilike '%and tenant_id = new.tenant_id%' then
    raise exception '661: the invoice could be selected outside the acting tenant';
  end if;

  -- Still attached, exactly once.
  select count(*) into v_trg from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
   where p.proname = 'advance_dunning_cadence' and not tg.tgisinternal;
  if v_trg <> 1 then raise exception '661: expected 1 trigger, found %', v_trg; end if;

  -- The ladder must still be readable and ambiguous in the way we handled: if
  -- action_key were unique per rung this migration's max() would be pointless,
  -- and if the rungs vanished it would silently advance nothing.
  select count(*) into v_expected from (
    select r.action_key from dunning_rungs r group by r.action_key having count(*) > 1) x;
  if v_expected = 0 then
    raise notice '661: no action_key spans multiple rungs on this database — the max() is harmless but currently unexercised';
  end if;

  raise notice '661: a chase now advances the ladder whoever sent it';
end $$;

commit;
