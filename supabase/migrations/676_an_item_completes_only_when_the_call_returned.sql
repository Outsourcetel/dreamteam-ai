-- 676_an_item_completes_only_when_the_call_returned.sql
-- ==========================================================================
-- WHY. mig 675 completes an onboarding checklist item when an
-- `action_executions` row carries decision `auto_executed` or
-- `executed_after_approval`. For the UNGATED lifecycle that is right. For the
-- HUMAN-GATED one it is wrong, and wrong in the exact way 675's own header
-- says it exists to prevent — a stored marker read as truth.
--
-- THE LIFECYCLE, read from the live catalog and the edge source, not from
-- supabase/baseline/full_schema.sql (which is stale — it omits `expired` from
-- the decision CHECK that production actually carries).
--
--   UNGATED (decide_action_execution said `auto_executed`)
--     connector-hub calls the external system FIRST
--     (supabase/functions/connector-hub/index.ts:7317 `runRegisteredAction`),
--     then writes ONE row through `record_action_execution` (index.ts:7372)
--     with `p_decision = outcome.ok ? 'auto_executed' : 'failed'`,
--     `p_receipt = outcome.receipt`, `p_result = {ok,status,error}`.
--     -> the row is terminal at INSERT, and its `result` is never null.
--
--   HUMAN-GATED (destructive / guardrail / trust / semantic screen)
--     1. `record_action_execution` (index.ts:7232) writes the GATE row:
--        decision `human_gated_destructive` | `human_gated_trust`,
--        receipt NULL, result NULL, and it creates the human_task.
--        NOTHING has been sent.
--     2. a person approves the task.
--     3. re-entry (browser `resolveActionExecution`, or the
--        approved-action-driver cron, both via connector-hub's
--        `approved_execution_id`) calls `claim_gated_action_execution`
--        (index.ts:7291). Read live: that function INSERTS A SECOND ROW
--        copying the gate row's fields — including `dedupe_key` — with
--        `decision = 'executed_after_approval'`, `receipt NULL`,
--        `result NULL`. STILL NOTHING HAS BEEN SENT. The claim is an
--        exactly-once lock taken BEFORE the call, not a record of one.
--     4. `runRegisteredAction` calls out.
--     5a. success -> UPDATE the claim row setting ONLY `receipt` and
--         `result` (index.ts:7324). `decision` is NOT in that SET list.
--     5b. failure -> UPDATE the claim row setting `decision = 'failed'`,
--         `resolves_task_id = null`, `result = {ok:false,...}`
--         (index.ts:7329).
--
--   ROLLBACK (`record_action_rollback`, live definition read): inserts a
--   compensating row with `dedupe_key` NULL, and sets `rolled_back_at` on the
--   original. It has ZERO callers in this repo today.
--
-- SO, PROVEN ON DEV AGAINST THE DEPLOYED mig-675 FUNCTION
-- (.superpowers/sdd/2026-08-10-onboarding-item-execution/proof-676-*.sql,
-- one rolled-back transaction driving the real functions):
--   * step 3 fires 675's trigger and marks the item `done` — before the
--     external call has been attempted;
--   * step 5b fires it again with `failed`, which 675 does not handle, so the
--     item STAYS `done` for work that FAILED;
--   * step 5a does not fire it at all (`update of decision` does not include a
--     receipt-only UPDATE), which is why a genuine gated success recorded the
--     note `applied` instead of the real receipt — visible proof that the
--     completion came from the claim and never from the receipt.
--
-- THE CONDITION CHOSEN, and why it is the right one for BOTH lifecycles.
-- An item completes when the execution has LANDED, which is four things at
-- once, not one:
--   (1) a terminal-successful decision       — `auto_executed` |
--                                              `executed_after_approval`
--   (2) EVIDENCE THE CALL RETURNED           — a non-empty `receipt` or a
--                                              non-null `result`
--   (3) no contradicting result              — `result->>'ok'` is not 'false'
--   (4) not rolled back                      — `rolled_back_at` is null
--
-- (2) is the load-bearing addition and it is chosen on evidence, not taste:
-- `claim_gated_action_execution` is the ONLY writer in the codebase that
-- produces a successful-looking decision with BOTH `receipt` and `result`
-- null — it hardcodes `null, null` — and on production, of the 47 rows
-- carrying a successful decision, ZERO have both null. So "receipt or result
-- present" separates the pre-call placeholder from every real completion that
-- has ever been recorded, and does it without knowing anything about
-- connector-hub's control flow.
--
-- Note the direction of failure. If the edge function crashes between the
-- claim and the call, step 5b never runs — a rule that only REVERSED on a
-- later `failed` could not save the item, because the contradicting event
-- never arrives. Requiring proof of return instead fails CLOSED: the item
-- simply never completes, and `perform_onboarding_item` (mig 674/Task 5) sees
-- the stale row on the next wake. That is why the condition is proof-of-
-- return and not compensation-after-the-fact.
--
-- WHY THE TRIGGER EVENT HAD TO WIDEN. `after insert or update OF decision`
-- cannot see step 5a at all, because that UPDATE touches only `receipt` and
-- `result`. Requiring proof of return WITHOUT widening the event would have
-- silently broken the entire gated lifecycle — an item that never completes,
-- with nothing in any log to say why. The event is now a plain
-- `after insert or update`. A column list (`update of decision, receipt,
-- result, rolled_back_at`) would be sufficient today and is deliberately NOT
-- used: it is one refactor away from under-firing again, and the two other
-- triggers already on this table (`trg_remote_access_audit`,
-- `trg_tenant_activity_log`) are blanket AFTER INSERT OR DELETE OR UPDATE, so
-- this adds no new cost profile. Correctness is carried by the predicate
-- below, not by the event list.
--
-- WHY THE TRANSITION GUARD. Firing on every UPDATE means a later unrelated
-- UPDATE of an already-landed row (mig 590 backfills `params`, mig 645
-- backfills `resolves_task_id`) would otherwise RE-complete an item a person
-- has since moved to `blocked` or `in_progress`. So the function acts only
-- when landedness CHANGES from false to true — computed over OLD and NEW.
-- That also makes the trigger idempotent by construction.
--
-- ⚠ NAMED AND LEFT, not buried. A rollback AFTER an item has completed leaves
-- the item `done`. `rolled_back_at is null` in the predicate stops a rollback
-- from RE-completing an item, but this migration does not un-complete one.
-- That is deliberate: `record_action_rollback` has zero callers in this repo
-- (grep: definition, its revoke, and one comment in mig 531), so a reversal
-- branch would be machinery no writer can reach; and more importantly the
-- honest target status for an undone item — back to `pending`? `blocked`? and
-- does the PROJECT un-complete? — is a product decision, the same kind mig 675
-- declined to make unilaterally about `onboarding_check_complete`. Whoever
-- wires rollback owns that decision. The `completed_by_execution` stamp added
-- below is what a scoped reversal would key on when someone does.
--
-- WHAT IS DELIBERATELY UNCHANGED: the `signed_off` terminal guard, the
-- `onboarding:<project>:<item>` linkage and its split_part parsing, the
-- tenant scope on the UPDATE, the swallow-everything exception handler (a
-- malformed key must never roll back an execution that already reached a
-- customer's system), and the decision to NOT call `onboarding_check_complete`
-- — all four are mig 675's, all four are re-pinned below.
--
-- NOT A GAP: a bound item can never require sign-off, so this trigger never
-- needs to raise the `review_gate` task that `update_onboarding_item` raises.
-- mig 674 rule (a) forces `action_key` -> `owner_type = 'de'`, and the older
-- rule refuses `requires_signoff` on a `de`-owned item. The `signed_off` guard
-- below is therefore belt-and-braces, and stays.
-- ==========================================================================

begin;

create or replace function public.complete_onboarding_item_from_execution()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_now     boolean;
  v_was     boolean := false;
  v_project uuid;
  v_key     text;
begin
  -- HAS THE WORK LANDED? Evaluated on NEW. All four clauses, or nothing.
  -- `#>>` rather than `->>` so a `result` that is not a JSON object returns
  -- null instead of raising.
  v_now := new.dedupe_key is not null
       and new.dedupe_key like 'onboarding:%'
       and new.decision in ('auto_executed', 'executed_after_approval')
       and (coalesce(btrim(new.receipt), '') <> '' or new.result is not null)
       and coalesce(new.result #>> array['ok'], 'true') <> 'false'
       and new.rolled_back_at is null;

  -- The same question about the row BEFORE this statement. On INSERT there is
  -- no before, so it had not landed.
  if tg_op = 'UPDATE' then
    v_was := old.dedupe_key is not null
         and old.dedupe_key like 'onboarding:%'
         and old.decision in ('auto_executed', 'executed_after_approval')
         and (coalesce(btrim(old.receipt), '') <> '' or old.result is not null)
         and coalesce(old.result #>> array['ok'], 'true') <> 'false'
         and old.rolled_back_at is null;
  end if;

  -- Not landed: a gate row, a claim taken before the call, a preview, a
  -- failure, a rollback. Nothing to record. (A landed -> not-landed
  -- transition also lands here: see the NAMED AND LEFT note in the header.)
  if not v_now then return null; end if;
  -- Already landed before this statement: this UPDATE changed something else,
  -- and must not re-write an item a person has moved on from since.
  if v_was then return null; end if;

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
                                        -- the REAL receipt now: on the gated
                                        -- path this runs on the update that
                                        -- carries it, not on the claim.
                                        'note',    coalesce(nullif(btrim(new.receipt), ''), 'applied'),
                                        -- which execution completed it, so a
                                        -- person can trace the claim, and so a
                                        -- future reversal can scope itself.
                                        'completed_by_execution', new.id)
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
-- alone leaves them reachable (security_default_execute_grant). Asserted, not
-- merely stated, below. service_role is deliberately neither granted nor
-- revoked: Postgres checks EXECUTE on a trigger function at CREATE TRIGGER
-- time, not per firing role.
revoke execute on function public.complete_onboarding_item_from_execution()
  from public, anon, authenticated;

drop trigger if exists trg_onboarding_item_completes on public.action_executions;
create trigger trg_onboarding_item_completes
  after insert or update on public.action_executions
  for each row execute function public.complete_onboarding_item_from_execution();

-- ── Prove the guards, the event, the grant, and the attachment. ───────────
-- Every pin below is one somebody could delete and still have a function that
-- "works" on the happy path. The two new ones (evidence-of-return on BOTH
-- sides, and the trigger event) are the ones this migration exists for.
do $$
declare
  v_def         text;
  v_trgdef      text;
  v_trg         integer;
  v_anon_exec   boolean;
  v_authed_exec boolean;
begin
  v_def := pg_get_functiondef('public.complete_onboarding_item_from_execution()'::regprocedure);

  -- ── mig 675's five, re-pinned. Losing any of them is a regression. ──
  if v_def not ilike '%auto_executed%' or v_def not ilike '%executed_after_approval%' then
    raise exception '676: the decision gate was dropped — a non-completed execution could mark an item done';
  end if;
  if v_def not ilike '%onboarding:%' then
    raise exception '676: the dedupe_key prefix guard was dropped';
  end if;
  if v_def not ilike '%signed_off%' then
    raise exception '676: the terminal-item guard was dropped — a receipt could downgrade a human sign-off back to done';
  end if;
  if v_def not ilike '%tenant_id = new.tenant_id%' then
    raise exception '676: the tenant scope was dropped from the update — a key could reach across tenants';
  end if;
  if v_def not ilike '%exception when others%' then
    raise exception '676: a malformed key would now roll back a real execution';
  end if;

  -- ── this migration's own guards ──
  -- (2) EVIDENCE OF RETURN, on the NEW side: without it the pre-call claim row
  -- completes the item again, which is the whole defect.
  if v_def not ilike '%new.receipt%' or v_def not ilike '%new.result is not null%' then
    raise exception '676: the proof-of-return guard is gone — a claim taken BEFORE the external call would complete the item again';
  end if;
  -- ...and on the OLD side: without the OLD copy there is no transition guard,
  -- and an unrelated later UPDATE re-completes an item a person has moved on.
  if v_def not ilike '%old.receipt%' or v_def not ilike '%old.result is not null%' then
    raise exception '676: the OLD-side predicate is gone — the transition guard cannot work and a stray UPDATE would re-complete the item';
  end if;
  if v_def not ilike '%new.rolled_back_at is null%' or v_def not ilike '%old.rolled_back_at is null%' then
    raise exception '676: the rolled-back guard is gone on one or both sides';
  end if;
  if v_def not ilike '%tg_op = ''UPDATE''%' then
    raise exception '676: the OLD/NEW transition guard lost its TG_OP branch — OLD is unassigned on INSERT';
  end if;

  -- ── the EVENT. A column list here is what made 675 blind to the
  -- receipt-only success UPDATE; a narrowed event is a silent no-op, so it is
  -- pinned as hard as the body. ──
  select pg_get_triggerdef(tg.oid) into v_trgdef
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'action_executions'
     and tg.tgname = 'trg_onboarding_item_completes';
  if v_trgdef is null then
    raise exception '676: trg_onboarding_item_completes is not attached to action_executions';
  end if;
  if v_trgdef ilike '%update of%' then
    raise exception '676: the trigger fires on a COLUMN LIST — connector-hub records a gated success by updating receipt/result only, so the item would never complete. Trigger: %', v_trgdef;
  end if;
  if v_trgdef not ilike '%after insert or update on%' then
    raise exception '676: the trigger event is not AFTER INSERT OR UPDATE. Trigger: %', v_trgdef;
  end if;

  -- ── the perimeter ──
  select has_function_privilege('anon', 'public.complete_onboarding_item_from_execution()', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.complete_onboarding_item_from_execution()', 'EXECUTE')
    into v_anon_exec, v_authed_exec;
  if v_anon_exec then
    raise exception '676: anon can execute complete_onboarding_item_from_execution — that is the internet';
  end if;
  if v_authed_exec then
    raise exception '676: authenticated can execute complete_onboarding_item_from_execution directly';
  end if;

  select count(*) into v_trg from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
   where p.proname = 'complete_onboarding_item_from_execution' and not tg.tgisinternal;
  if v_trg <> 1 then
    raise exception '676: expected 1 trigger on complete_onboarding_item_from_execution, found %', v_trg;
  end if;

  raise notice '676: an item completes only when the call RETURNED — claim-before-call no longer counts, a failed call no longer leaves it done, the gated success UPDATE is now visible to the trigger, and every mig-675 guard is still pinned';
end $$;

commit;
