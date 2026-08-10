-- 677_a_chase_counts_only_when_it_was_sent.sql
-- ==========================================================================
-- WHY. `advance_dunning_cadence` (migs 589/661) moves
-- `renewal_invoices.cadence_stage` — the rung a real customer is chased at —
-- on nothing more than a decision string:
--
--     if new.decision not in ('executed_after_approval','auto_executed') then
--       return null; end if;
--
-- On the HUMAN-GATED path that string arrives BEFORE anything has been sent.
--
-- THE LIFECYCLE, read from the live catalog and the edge source on 2026-08-10,
-- not from supabase/baseline/full_schema.sql (which is stale — it omits
-- `expired` from the decision CHECK that production actually carries; live
-- CHECK verified to include it).
--
--   UNGATED  connector-hub calls the external system FIRST
--     (connector-hub/index.ts:7317 `runRegisteredAction`), then writes ONE row
--     via `record_action_execution` (index.ts:7372) with
--     `p_decision = outcome.ok ? 'auto_executed' : 'failed'`,
--     `p_receipt = outcome.receipt`, `p_result = {ok,status,error}`.
--     -> terminal at INSERT, `result` never null. The current trigger is right
--        about this path and stays right.
--
--   HUMAN-GATED
--     1. `record_action_execution` (index.ts:7232) writes the GATE row —
--        `human_gated_destructive` | `human_gated_trust`, receipt NULL,
--        result NULL — and creates the human_task. Nothing sent.
--     2. a person approves.
--     3. re-entry (browser `resolveActionExecution` -> connector-hub, or the
--        approved-action driver) calls `claim_gated_action_execution`
--        (index.ts:7291). READ LIVE: that function INSERTS A SECOND ROW
--        copying the gate row — including `dedupe_key` and `params` — with
--        `decision = 'executed_after_approval'`, and hardcoded
--        `receipt = null, result = null`. STILL NOTHING SENT. The claim is an
--        exactly-once lock taken BEFORE the call, not a record of one.
--     4. `runRegisteredAction` calls out.
--     5a. success -> UPDATE the claim row setting ONLY `receipt` and `result`
--         (index.ts:7324). `decision` is NOT in that SET list.
--     5b. failure -> UPDATE setting `decision = 'failed'`,
--         `resolves_task_id = null`, `result = {ok:false,...}` (:7329).
--
-- SO, TODAY, FOR EVERY HUMAN-GATED CHASE:
--   * step 3 fires this trigger and CLIMBS THE LADDER before the chase is sent;
--   * the trigger is `after insert` ONLY (verified live), so step 5a — the
--     moment the chase actually goes out — is invisible to it;
--   * step 5b is invisible too, so a chase that FAILED leaves the rung burnt.
--     The customer is never chased at that rung, because the ladder is
--     MONOTONIC and `run_dunning_sweep` skips a (invoice, stage) that already
--     has a non-failed proposal.
--
-- ── THE CONDITION CHOSEN ─────────────────────────────────────────────────
-- The rung advances when the chase has LANDED, which is four things at once:
--   (1) a terminal-successful decision   — `auto_executed` |
--                                          `executed_after_approval`
--   (2) EVIDENCE THE CALL RETURNED       — a non-empty `receipt` or a non-null
--                                          `result`
--   (3) no contradicting result          — `result->>'ok'` is not 'false'
--   (4) not rolled back                  — `rolled_back_at` is null
-- ...and only on the FALSE -> TRUE transition of that predicate, computed over
-- OLD and NEW.
--
-- (2) is the load-bearing addition, and it is chosen on evidence rather than
-- taste. `claim_gated_action_execution` is the only writer in the codebase
-- that produces a successful-looking decision with BOTH `receipt` and `result`
-- null — it hardcodes `null, null`. Measured on production the same day: of
-- the 47 rows carrying a successful decision, 47 have BOTH a receipt and a
-- result and ZERO have both null; of the 24 successful rows carrying a
-- `params->>'external_ref'` (the PATH B key), zero have both null. So
-- "receipt or result present" separates the pre-call placeholder from every
-- real completion ever recorded, without the trigger needing to know anything
-- about connector-hub's control flow.
--
-- ── WHY NOT "ADVANCE, THEN CORRECT" ──────────────────────────────────────
-- The update is `greatest(coalesce(cadence_stage,0), v_stage)`. The ladder is
-- MONOTONIC BY DESIGN, and that design is right: a late-executing LOWER rung
-- must never drag the stage back down and re-open a chase the customer has
-- already had. `greatest()` therefore STAYS, untouched.
--
-- But monotonicity means reversal is not available. Advancing at claim time
-- and un-advancing on a later `failed` would require inventing a semantics
-- nobody asked for (down to what? the previous rung? does the customer get
-- chased twice at it?). Worse, it would fail OPEN: if the edge function dies
-- between the claim and the call, step 5b never runs, the contradicting event
-- never arrives, and the rung stays burnt forever. Requiring proof of return
-- fails CLOSED instead — the stage simply does not move, `run_dunning_sweep`
-- finds no non-failed proposal at that (invoice, stage) on its next 07:10 run,
-- and the customer gets chased. That asymmetry is the whole argument.
--
-- ── WHY THE TRIGGER EVENT HAD TO WIDEN ───────────────────────────────────
-- `after insert` cannot see step 5a at all: that UPDATE touches only `receipt`
-- and `result`. Requiring proof of return WITHOUT widening the event would
-- have made the ENTIRE gated ladder inert — no advance, ever, with nothing in
-- any log to say why. That is precisely the mig-661 failure mode (a mechanism
-- that has never once fired) and this migration must not re-create it.
--
-- The event is now a plain `after insert or update`. A column list
-- (`update of decision, receipt, result, rolled_back_at`) would be sufficient
-- today and is deliberately NOT used: it is one refactor away from
-- under-firing again, it is exactly what blinded mig 675 to the receipt-only
-- UPDATE, and the two other triggers already on this table
-- (`trg_remote_access_audit`, `trg_tenant_activity_log`) are blanket
-- AFTER INSERT OR DELETE OR UPDATE — so this adds no new cost profile.
-- Correctness is carried by the predicate, not by the event list.
--
-- ── WHY THE TRANSITION GUARD IS NOT OPTIONAL HERE ────────────────────────
-- On a monotonic ladder a re-fire looks harmless. It is not, because of
-- PATH B: that path does not read the rung from a key, it RECOMPUTES it from
-- `current_date - ri.due_date` against `dunning_rungs`. Firing on every UPDATE
-- means an unrelated later UPDATE of an already-landed row (mig 590 backfills
-- `params`; mig 645 backfills `resolves_task_id`) would recompute a HIGHER
-- rung simply because more time has passed, and `greatest()` would cheerfully
-- accept it — silently promoting an invoice to "Final notice" on the strength
-- of a chase that was only ever a friendly reminder. The false -> true guard
-- keeps the old one-shot semantics and pins the shot to the moment the chase
-- actually went out. It also makes the trigger idempotent by construction.
--
-- ── WHAT IS DELIBERATELY UNCHANGED ───────────────────────────────────────
-- PATH A (`dunning:<invoice>:<stage>`, run_dunning_sweep), PATH B (mig 661 —
-- resolve the invoice from `params->>'external_ref'`, read the rung out of
-- `dunning_rungs` with `max()` because `action_key` repeats across rungs:
-- verified live, `send_payment_reminder` is BOTH stage 1 @7d and stage 2
-- @21d), `greatest()`, the `tenant_id = new.tenant_id` scope on the UPDATE
-- (the reference arrives as caller-supplied TEXT), and the swallow-everything
-- handler (a malformed key must never roll back an execution that already
-- reached a customer's system). All six are re-pinned below.
--
-- ⚠ NAMED AND LEFT, not buried. Two things this migration does NOT do:
--
--   1. A ROLLBACK ROW STILL ADVANCES THE LADDER ON PATH B.
--      `record_action_rollback` (live definition read) inserts a compensating
--      row with `dedupe_key` NULL, `decision = 'executed_after_approval'`, a
--      non-null receipt and the ORIGINAL's `params` — so PATH B resolves the
--      same invoice and climbs. Undoing a chase should not climb the ladder.
--      It is left because the behaviour is unchanged by this migration (that
--      row is an INSERT and already advances today), because
--      `record_action_rollback` has zero callers in this repo, and because
--      what a reversal should do to a cadence is a product decision — the same
--      one mig 676 declined to make unilaterally. `rolled_back_at is null`
--      above stops a rollback of the ORIGINAL from re-advancing; it does not
--      teach the ladder to descend.
--
--   2. `run_dunning_sweep` RAISES CHASES NOBODY CAN CARRY OUT — and after this
--      migration that stops being invisible. The sweep calls
--      `record_action_execution` with `p_receipt => null, p_result => null`
--      and whatever `decide_action_execution` returned. If that is
--      `auto_executed`, the ledger says "executed" while NOTHING in the
--      codebase ever calls out for a sweep row: the sweep only writes. Under
--      the old rule that phantom advanced the ladder; under this one it does
--      not, which is correct — but the honest fix is in the sweep, not here.
--      Related and verified: the sweep passes `p_connector_id => null`, and
--      `due_approved_actions` requires `ae.connector_id is not null`, so the
--      approved-action driver can never pick up a sweep-raised approval
--      either. PATH A has produced exactly two rows on production, both
--      `human_gated_destructive`, both unclaimed since 2026-08-05.
-- ==========================================================================

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
  v_now     boolean;
  v_was     boolean := false;
begin
  -- ── HAS THE CHASE ACTUALLY BEEN SENT? Evaluated on NEW. All four, or none.
  -- `#>>` rather than `->>` so a `result` that is not a JSON object returns
  -- null instead of raising.
  v_now := new.decision in ('executed_after_approval', 'auto_executed')
       and (coalesce(btrim(new.receipt), '') <> '' or new.result is not null)
       and coalesce(new.result #>> array['ok'], 'true') <> 'false'
       and new.rolled_back_at is null;

  -- The same question about the row BEFORE this statement. On INSERT there is
  -- no before — and OLD is unassigned there, so it must not be touched.
  if tg_op = 'UPDATE' then
    v_was := old.decision in ('executed_after_approval', 'auto_executed')
         and (coalesce(btrim(old.receipt), '') <> '' or old.result is not null)
         and coalesce(old.result #>> array['ok'], 'true') <> 'false'
         and old.rolled_back_at is null;
  end if;

  -- Not sent: a gate row, a claim taken BEFORE the call, a preview, a failure,
  -- a rollback. The rung does not move for work that has not happened.
  if not v_now then return null; end if;
  -- Already sent before this statement: this UPDATE changed something else,
  -- and must not recompute a rung against a later `current_date`.
  if v_was then return null; end if;

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

  -- greatest(): a late-executing LOWER rung must never drag the ladder back
  -- down and re-open a chase the customer has already had.
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

-- Supabase grants anon/authenticated as NAMED ROLES, and `advance_dunning_
-- cadence` was measured today holding EXECUTE for public, anon AND
-- authenticated (proacl `{=X/postgres,...,anon=X/postgres,authenticated=X/
-- postgres,...}`) — 589 and 661 both created it without revoking. Revoked and
-- ASSERTED below, not merely stated. service_role is deliberately neither
-- granted nor revoked: Postgres checks EXECUTE on a trigger function at
-- CREATE TRIGGER time, not per firing role.
revoke execute on function public.advance_dunning_cadence()
  from public, anon, authenticated;

drop trigger if exists trg_advance_dunning_cadence on public.action_executions;
create trigger trg_advance_dunning_cadence
  after insert or update on public.action_executions
  for each row execute function public.advance_dunning_cadence();

-- ── Prove the guards, the event, the grant, and the attachment. ───────────
-- Every pin below is one somebody could delete and still have a function that
-- "works" on the happy path.
do $$
declare
  v_def         text;
  v_trgdef      text;
  v_trg         integer;
  v_anon_exec   boolean;
  v_authed_exec boolean;
  v_both_null   bigint;
  v_multi_rung  integer;
begin
  v_def := pg_get_functiondef('public.advance_dunning_cadence()'::regprocedure);

  -- ── 589/661's own guards, re-pinned. Losing any is a regression. ──
  -- Pinned on CODE, not on the comment that labels it: `PATH A` alone would
  -- stay true after somebody deleted the branch and left the heading. Both
  -- extractions are named, because pinning the invoice alone still passed a
  -- mutant that had gutted it (the stage line carries the same substring).
  if v_def not ilike '%dunning:%'
     or v_def not ilike '%split_part(new.dedupe_key, '':'', 2)%'
     or v_def not ilike '%split_part(new.dedupe_key, '':'', 3)%' then
    raise exception '677: the sweep path was lost — run_dunning_sweep would stop advancing';
  end if;
  -- ⚠ Pinned on `new.params->>'external_ref'`, NOT on `%external_ref%`.
  -- mig 661 used the loose form and it was a check that could not fail:
  -- `renewal_invoices.source_external_ref` two lines below CONTAINS that
  -- substring, so deleting the actual param read still matched. Proven by
  -- mutation on dev — the loose pin passed a mutant that had killed PATH B.
  if v_def not ilike '%from action_definitions ad%'
     or v_def not ilike '%new.params->>''external_ref''%' then
    raise exception '677: PATH B is gone — the employee-sent chase would stop counting, which IS the mig-661 bug';
  end if;
  -- `%dunning_rungs%` alone passed a mutant that had renamed the table to
  -- `dunning_rungs_gone` — which would raise at runtime and be SWALLOWED by
  -- the exception handler below, i.e. fail silently. Pinned on the exact FROM.
  if v_def not ilike '%from dunning_rungs r%'
     or v_def not ilike '%join dunning_ladders l on l.id = r.ladder_id%'
     or v_def not ilike '%max(r.stage)%' then
    raise exception '677: PATH B no longer reads the rung out of the ladder — action_key repeats across rungs, so a guessed stage is wrong';
  end if;
  if v_def not ilike '%greatest(coalesce(cadence_stage, 0), v_stage)%' then
    raise exception '677: a late LOWER rung could now drag the ladder back down and re-chase the customer';
  end if;
  if v_def not ilike '%and tenant_id = new.tenant_id%' then
    raise exception '677: the invoice could be selected outside the acting tenant';
  end if;
  if v_def not ilike '%exception when others%' then
    raise exception '677: a malformed key would now roll back a real execution';
  end if;

  -- ── this migration's own guards ──
  -- EVIDENCE OF RETURN on the NEW side: without it the pre-call claim row
  -- climbs the ladder again, which is the whole defect.
  if v_def not ilike '%new.receipt%' or v_def not ilike '%new.result is not null%' then
    raise exception '677: the proof-of-return guard is gone — a claim taken BEFORE the external call would advance the rung again';
  end if;
  -- ...and on the OLD side: without it there is no transition guard, and a
  -- stray later UPDATE recomputes PATH B against a later current_date and
  -- silently promotes the invoice to a rung nobody chased it at.
  if v_def not ilike '%old.receipt%' or v_def not ilike '%old.result is not null%' then
    raise exception '677: the OLD-side predicate is gone — the transition guard cannot work and a stray UPDATE would climb the ladder on elapsed time alone';
  end if;
  if v_def not ilike '%new.rolled_back_at is null%' or v_def not ilike '%old.rolled_back_at is null%' then
    raise exception '677: the rolled-back guard is gone on one or both sides';
  end if;
  if v_def not ilike '%tg_op = ''UPDATE''%' then
    raise exception '677: the OLD/NEW transition guard lost its TG_OP branch — OLD is unassigned on INSERT';
  end if;
  -- Pinned on the whole expression: `%ok%` alone matches the prose above it
  -- and would be a check that cannot fail.
  if v_def not ilike '%array[''ok'']%' or v_def not ilike '%<> ''false''%' then
    raise exception '677: the contradicting-result guard is gone — a decision its own result denies would advance the rung';
  end if;

  -- ── the EVENT. Narrowing it back to INSERT, or to a column list, makes the
  -- gated ladder INERT with nothing in any log to say why. Pinned as hard as
  -- the body. ──
  select pg_get_triggerdef(tg.oid) into v_trgdef
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'action_executions'
     and tg.tgname = 'trg_advance_dunning_cadence';
  if v_trgdef is null then
    raise exception '677: trg_advance_dunning_cadence is not attached to action_executions';
  end if;
  if v_trgdef ilike '%update of%' then
    raise exception '677: the trigger fires on a COLUMN LIST — connector-hub records a gated success by updating receipt/result only, so no gated chase would ever advance the ladder. Trigger: %', v_trgdef;
  end if;
  if v_trgdef not ilike '%after insert or update on%' then
    raise exception '677: the trigger event is not AFTER INSERT OR UPDATE — a gated chase lands on an UPDATE, so the ladder would never move. Trigger: %', v_trgdef;
  end if;

  select count(*) into v_trg from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
   where p.proname = 'advance_dunning_cadence' and not tg.tgisinternal;
  if v_trg <> 1 then
    raise exception '677: expected 1 trigger on advance_dunning_cadence, found %', v_trg;
  end if;

  -- ── the perimeter ──
  select has_function_privilege('anon', 'public.advance_dunning_cadence()', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.advance_dunning_cadence()', 'EXECUTE')
    into v_anon_exec, v_authed_exec;
  if v_anon_exec then
    raise exception '677: anon can execute advance_dunning_cadence — that is the internet';
  end if;
  if v_authed_exec then
    raise exception '677: authenticated can execute advance_dunning_cadence directly';
  end if;

  -- ── two OBSERVATIONS, reported not enforced. Both would abort a legitimate
  -- migration if they raised (a claim in flight is a normal state), so they
  -- are notices. They exist so the evidence this fix rests on is re-measured
  -- rather than assumed. ──
  select count(*) into v_both_null from action_executions
   where decision in ('auto_executed', 'executed_after_approval')
     and coalesce(btrim(receipt), '') = '' and result is null;
  if v_both_null > 0 then
    raise notice '677: % row(s) carry a successful decision with NO receipt and NO result. Under this migration they no longer advance the ladder — which is the point — but check they are pre-call claims and not a writer nobody enumerated.', v_both_null;
  else
    raise notice '677: 0 rows carry a successful decision with neither a receipt nor a result — evidence-of-return separates the pre-call claim from every completion ever recorded here';
  end if;

  select count(*) into v_multi_rung from (
    select r.action_key from dunning_rungs r group by r.action_key having count(*) > 1) x;
  if v_multi_rung = 0 then
    raise notice '677: no action_key spans multiple rungs on this database — PATH B''s max() is harmless but currently unexercised';
  end if;

  raise notice '677: the rung now advances only when the chase RETURNED — a claim taken before the call no longer counts, a failed send no longer burns the rung, the gated success UPDATE is finally visible to the trigger, and BOTH paths plus greatest() are still pinned';
end $$;

commit;
