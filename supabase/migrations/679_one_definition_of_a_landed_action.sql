-- 679_one_definition_of_a_landed_action.sql
-- ==========================================================================
-- WHY. Migrations 676, 677 and 678 each fixed a DIFFERENT reader that mistook
-- "a human approved this and the row is locked" for "this happened":
--
--   676  complete_onboarding_item_from_execution  marked a checklist item done
--   677  advance_dunning_cadence                  climbed a real customer's
--                                                 chase ladder
--   678  assess_definition_of_done                let a run call itself done
--
-- All three now carry the SAME four-conjunct test, written out three times.
-- That is the disease, not the cure: the correct predicate lives in three
-- places and NOTHING forces a fourth reader to use it. This migration makes it
-- live in ONE place, and its sibling probe in scripts/certify.mjs
-- (`landed-reads-use-the-shared-predicate`) makes a fourth reader that
-- open-codes it a red bar rather than a defect somebody finds in three months.
--
-- ── THE PREDICATE, verified conjunct by conjunct against all three bodies ──
-- Read live from the catalog on 2026-08-10, not from the migration files and
-- not from supabase/baseline/full_schema.sql (stale — it omits `expired` from
-- the decision CHECK that production actually carries). All three are
-- CHARACTER-IDENTICAL apart from the order of the two decision literals in
-- 677 (`('executed_after_approval','auto_executed')` vs `('auto_executed',
-- 'executed_after_approval')` — the same set, so the same result). There is no
-- deliberate local difference to flatten, and no bug in any of the three.
--
--   (1) decision in ('auto_executed','executed_after_approval')
--         a TERMINAL-SUCCESSFUL decision. A whitelist, never `<> 'failed'` —
--         mig 678 showed a blacklist admits `previewed`, `rejected`,
--         `guardrail_blocked`, `access_denied`, both `human_gated_*`, and the
--         six mig-642 `expired` tombstones that say, verbatim, "Approved but
--         never executed."
--
--   (2) coalesce(btrim(receipt), '') <> '' or result is not null
--         EVIDENCE THE CALL RETURNED. ⚠ Note the exact form: a receipt that is
--         present but BLANK does not count. `receipt is not null` would be
--         weaker than what 676/677/678 actually shipped, so the strict form is
--         what is preserved here. This is the conjunct that defeats the
--         pre-call claim: `claim_gated_action_execution` is the only writer in
--         the codebase producing a successful-looking decision with BOTH
--         receipt and result null — it hardcodes `null, null`.
--
--   (3) coalesce(result #>> array['ok'], 'true') <> 'false'
--         NO CONTRADICTING RESULT. `#>>` rather than `->>` so a `result` that
--         is not a JSON object yields null instead of raising — proven below
--         in the truth table, not assumed.
--
--   (4) rolled_back_at is null
--         NOT UNDONE.
--
-- ── ROLLBACK SEMANTICS, stated because it is the one place the conjuncts do
--    something non-obvious ────────────────────────────────────────────────
-- `record_action_rollback` (live body read today) does TWO things: it INSERTs
-- a compensating row (decision `executed_after_approval`, receipt and result
-- from the caller, `rollback_of` set, `dedupe_key` NULL) AND it stamps
-- `rolled_back_at = now()` on the ORIGINAL.
--
-- Under these four conjuncts:
--   * the ORIGINAL becomes NOT landed          — conjunct (4)
--   * the COMPENSATING row IS landed           — it is itself a real call that
--                                                really returned
--
-- That is deliberate and it is what 676/677/678 do TODAY — this migration is a
-- pure extraction and changes neither. The predicate answers "did THIS row's
-- call land", not "does the world still contain this effect". Each reader
-- decides what to do with that: 676 stops a rollback RE-completing an item but
-- does not un-complete one; 677 stops a rolled-back original RE-advancing the
-- ladder but the compensating row still advances it on PATH B (named and left
-- in 677's own header); 678 stops a rolled-back row counting as a carried-out
-- approval. All three behaviours are UNCHANGED here, and case 11 of the truth
-- table below drives the real pair to prove it.
--
-- ── SHAPE, and why ───────────────────────────────────────────────────────
-- `action_execution_landed(ae public.action_executions) returns boolean`, over
-- the ROW TYPE, with local precedent in `knowledge_grant_matches_user(g
-- knowledge_access_grants, ...)` (mig 344). Three reasons it beats a
-- plain-columns signature for the call sites that actually exist:
--   * two of the three readers are TRIGGERS, where the row is already in hand
--     as NEW/OLD. `action_execution_landed(new)` cannot get an argument in the
--     wrong order; a 4-arg `(decision, receipt, result, rolled_back_at)` call
--     silently can, and this repo has already paid for exactly that class of
--     bug (mig 661's `%external_ref%` pin matching `source_external_ref`).
--   * the third reader is a `not exists (… ex …)` subquery, where
--     `public.action_execution_landed(ex)` reads as the sentence it is.
--   * adding a fifth conjunct later touches ONE signature, not four call
--     sites — which is the entire point of the exercise.
-- PROVEN, not assumed: plpgsql resolves a function call at first EXECUTION,
-- not at CREATE, so "it compiled" would have been worth nothing. A trigger
-- passing NEW and OLD to this signature was fired for real on dev — on an
-- INSERT and on a receipt-only UPDATE — before this migration was written.
--
-- ── VOLATILITY: IMMUTABLE, and this is the thing to get right ────────────
-- The body reads no table, no session GUC, no clock — it is a pure function of
-- its argument, so IMMUTABLE is correct and lets the planner inline it.
-- ⚠ mig 674 is the cautionary tale in the other direction: it was IMMUTABLE
-- and had to become STABLE the moment its body started reading
-- `action_definitions`. The rule is the same one, applied honestly: the day
-- anybody makes this function read a table, it MUST drop to STABLE. The
-- assertion block pins `provolatile = 'i'` so that change cannot be made
-- quietly.
--
-- ── NO `SET search_path`, DELIBERATELY ───────────────────────────────────
-- A SET clause makes a SQL function un-inlinable, and this one has nothing to
-- protect: it is SECURITY INVOKER and its body references no schema-qualified
-- object at all — only `btrim`, `coalesce`, `#>>` and comparison operators,
-- every one of which resolves from `pg_catalog`, which is searched first
-- implicitly whenever it is not named explicitly. The hijack this repo guards
-- against needs SECURITY DEFINER to be worth anything. So that it cannot drift
-- into a hole, `prosecdef = false` is PINNED below: the day someone makes this
-- SECURITY DEFINER, the migration-time assertion tells them they now owe it a
-- search_path.
--
-- ── WHAT IS DELIBERATELY LEFT ALONE ──────────────────────────────────────
-- ⚠ `check_action_idempotency` and `due_approved_actions` and
-- `claim_gated_action_execution`'s own duplicate check are LOCKS, not gates. A
-- claim in flight is exactly what a lock must refuse — tightening them to
-- "landed" would permit a DOUBLE SEND while a claim is outstanding. mig 678
-- made this call for `due_approved_actions` explicitly; the same reasoning
-- covers the other two. They stay, and they are pinned in the probe's
-- allowlist with that reason.
--
-- ⚠ The eight COUNTERS (`get_de_action_metrics`, `get_de_economics`,
-- `get_de_kpi_status`, `get_de_work_product`, `get_workforce_trust_metrics`,
-- `check_workforce_circuit_breaker`, `assess_de_skills_internal`,
-- `snapshot_de_kpi_readings`) count ATTEMPTED work on purpose — an autonomy
-- rate whose denominator excluded in-flight work would move when nothing
-- changed. They stay, pinned with reasons. One HONEST caveat, named not
-- buried: `get_de_economics` multiplies its `auto_executed |
-- executed_after_approval` count by `action_minutes` to report hours saved, so
-- a claim in flight is briefly counted as time saved. That is a metric
-- imprecision, not a governance defect, and correcting it is a product call
-- about what "actions_executed" should mean — not a side effect of this
-- extraction.
-- ==========================================================================

begin;

-- ── THE ONE DEFINITION ────────────────────────────────────────────────────
create or replace function public.action_execution_landed(ae public.action_executions)
returns boolean
language sql
immutable
as $function$
  -- (1) a terminal-SUCCESSFUL decision. A WHITELIST — never a not-a-failure
  --     blacklist, which admits previewed, rejected, expired and both gates.
  select ae.decision in ('auto_executed', 'executed_after_approval')
  -- (2) evidence the call RETURNED. A blank receipt is not a receipt.
     and (coalesce(btrim(ae.receipt), '') <> '' or ae.result is not null)
  -- (3) no contradicting result. `#>>` so a non-object result yields null.
     and coalesce(ae.result #>> array['ok'], 'true') <> 'false'
  -- (4) not undone
     and ae.rolled_back_at is null;
$function$;

comment on function public.action_execution_landed(public.action_executions) is
  'THE definition of "this action actually landed": a terminal-successful '
  'decision, evidence the call returned, no contradicting result, not rolled '
  'back. Migs 676/677/678 each open-coded this and each was wrong before they '
  'did. Ring-0 probe `landed-reads-use-the-shared-predicate` fails certify if '
  'a new reader open-codes it again. A ROLLBACK makes the ORIGINAL not-landed '
  'and leaves the COMPENSATING row landed — that is the intended reading and '
  'it is what all three readers did before this function existed.';

-- Supabase grants anon/authenticated as NAMED ROLES; `revoke from public`
-- alone leaves them reachable. Asserted, not merely stated, below.
-- ⚠ service_role is GRANTED EXPLICITLY. A brand-new function starts with
-- proacl NULL — EXECUTE arrives via PUBLIC — so a bare revoke strips the
-- service role, which is the failure mig 678 caught on dev. No caller needs it
-- today (all three readers are SECURITY DEFINER and run as the owner), but a
-- future SECURITY INVOKER reader called by the service role would break with
-- an error nobody would connect to this line. It leaks nothing: the argument
-- is a row the caller must already hold.
revoke execute on function public.action_execution_landed(public.action_executions)
  from public, anon, authenticated;
grant execute on function public.action_execution_landed(public.action_executions)
  to service_role;

-- ══ READER 1 of 3 — mig 676. ══════════════════════════════════════════════
-- Body preserved verbatim except that the two open-coded copies of the
-- four-conjunct test are replaced by the call. The `onboarding:%` prefix
-- guard is NOT part of landedness — it is this reader's own scope filter —
-- so it stays inline on both sides.
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
  -- HAS THE WORK LANDED? Evaluated on NEW, through the ONE definition.
  v_now := new.dedupe_key is not null
       and new.dedupe_key like 'onboarding:%'
       and public.action_execution_landed(new);

  -- The same question about the row BEFORE this statement. On INSERT there is
  -- no before, and OLD is unassigned there, so it must not be touched.
  if tg_op = 'UPDATE' then
    v_was := old.dedupe_key is not null
         and old.dedupe_key like 'onboarding:%'
         and public.action_execution_landed(old);
  end if;

  -- Not landed: a gate row, a claim taken before the call, a preview, a
  -- failure, a rollback. Nothing to record. (A landed -> not-landed
  -- transition also lands here: see mig 676's NAMED AND LEFT note.)
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
                                        'note',    coalesce(nullif(btrim(new.receipt), ''), 'applied'),
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

revoke execute on function public.complete_onboarding_item_from_execution()
  from public, anon, authenticated;

-- ══ READER 2 of 3 — mig 677. ══════════════════════════════════════════════
-- Body preserved verbatim except for the two open-coded copies. PATH A, PATH
-- B, the ladder read, `greatest()`, the tenant scope and the swallow-
-- everything handler are untouched and re-pinned below.
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
  -- ── HAS THE CHASE ACTUALLY BEEN SENT? Through the ONE definition.
  v_now := public.action_execution_landed(new);

  -- The same question about the row BEFORE this statement. On INSERT there is
  -- no before — and OLD is unassigned there, so it must not be touched.
  if tg_op = 'UPDATE' then
    v_was := public.action_execution_landed(old);
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

revoke execute on function public.advance_dunning_cadence()
  from public, anon, authenticated;

-- ══ READER 3 of 3 — mig 678. ══════════════════════════════════════════════
-- Body preserved verbatim except for the two open-coded copies in clause (a)
-- and the fail-CLOSED `agentic_run` anchor (d). mig 425's tenant guard, its
-- position AHEAD of every read, mig 428's counter invariant, the returned
-- contract and STABLE/SECURITY DEFINER/search_path are all untouched and
-- re-pinned below.
create or replace function public.assess_definition_of_done(
  p_tenant_id uuid, p_scope text, p_scope_id uuid, p_objective_id uuid default null
) returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_pending int := 0;
  v_unresolved boolean := false;
  v_gated_task uuid;
begin
  -- Tenant guard (mig 425). This function took p_tenant_id as a parameter
  -- and never checked it — any signed-in user could read the approval
  -- backlog of any other workspace. NOT a DE-scoping fix: nothing here is
  -- per-employee, so the DE-scoping predicate is the wrong tool here and is not applied.
  --
  -- The auth.uid() prefix is deliberate and load-bearing: connector-hub and
  -- _shared/defOfDone.ts call this with the SERVICE ROLE, whose JWT has no
  -- sub, so auth.uid() is NULL there. As of mig 678 neither anon NOR
  -- authenticated holds EXECUTE (asserted by the migration), so the fail-open
  -- path is not reachable from a browser at all.
  if auth.uid() is not null
     and not exists (select 1 from profiles p where p.user_id = auth.uid()
                       and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized for this workspace';
  end if;

  -- (a) origin-scoped gated actions: pending = a gated row whose task is still
  --     'pending', OR 'approved' but with nothing that LANDED resolving it.
  --     ⚠ migs 678 + 679. The resolving test used to be a blacklist — anything
  --     not marked as a failure — which a row satisfies the instant the
  --     approval is CLAIMED, before the external call, and which a voided
  --     tombstone satisfies forever. It is now THE shared proof-of-landing.
  select count(*) into v_pending
    from action_executions ae
    join human_tasks ht on ht.id = ae.task_id
   where ae.tenant_id = p_tenant_id and ae.origin_kind = p_scope and ae.origin_id = p_scope_id
     and ae.decision in ('human_gated_destructive','human_gated_trust')
     and ( ht.status = 'pending'
        or ( ht.status = 'approved'
             and not exists (select 1 from action_executions ex
                              where ex.resolves_task_id = ae.task_id
                                and public.action_execution_landed(ex)) ) );

  -- (b) account / opportunity write-backs on this objective.
  if p_objective_id is not null then
    v_pending := v_pending
      + (select count(*) from account_writeback_requests w where w.tenant_id = p_tenant_id and w.objective_id = p_objective_id and w.status = 'pending_approval')
      + (select count(*) from opportunity_writeback_requests w where w.tenant_id = p_tenant_id and w.objective_id = p_objective_id and w.status = 'pending_approval');
  end if;

  -- (c) outbound drafts scoped to this run/item.
  v_pending := v_pending
    + (select count(*) from outbound_drafts d where d.tenant_id = p_tenant_id and d.source_kind = p_scope and d.source_ref = p_scope_id and d.status = 'pending_approval');

  -- (d) fail-CLOSED anchor: an agentic run that flagged a gate whose task is not
  --     resolved by a LANDED execution is 'unresolved' even if origin wasn't
  --     threaded — so a missing correlation can never pass as "nothing pending".
  --     Same shared predicate as (a), and now identical BY CONSTRUCTION rather
  --     than by two copies happening to agree.
  if p_scope = 'agentic_run' then
    select last_gated_human_task_id into v_gated_task from agentic_step_runs where id = p_scope_id and tenant_id = p_tenant_id;
    if v_gated_task is not null
       and not exists (select 1 from action_executions ex
                        where ex.resolves_task_id = v_gated_task
                          and public.action_execution_landed(ex)) then
      v_unresolved := true;
    end if;
  end if;

  return jsonb_build_object(
    'verified', (coalesce(v_pending, 0) = 0) and not v_unresolved,
    'pending_count', coalesce(v_pending, 0),
    'unresolved', v_unresolved,
    'detail', jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id, 'objective_id', p_objective_id)
  );
end $function$;

-- `create or replace` PRESERVES the ACL, so mig 678's perimeter should survive
-- untouched. Re-issued anyway so that a replay from an empty database lands in
-- the same state, and ASSERTED below either way.
revoke execute on function public.assess_definition_of_done(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.assess_definition_of_done(uuid, text, uuid, uuid)
  to service_role;

-- ══ PROVE IT ══════════════════════════════════════════════════════════════
do $assert$
declare
  v_landed  text;
  v_676     text;
  v_677     text;
  v_678     text;
  v_trgdef  text;
  v_n       int;
  v_vol     "char";
  v_secdef  boolean;
  v_cnt     int;
  v_case    record;
  v_got     boolean;
  v_fail    text := '';
  v_tenant  uuid;
  v_out     jsonb;
begin
  v_landed := pg_get_functiondef('public.action_execution_landed(public.action_executions)'::regprocedure);
  v_676    := pg_get_functiondef('public.complete_onboarding_item_from_execution()'::regprocedure);
  v_677    := pg_get_functiondef('public.advance_dunning_cadence()'::regprocedure);
  v_678    := pg_get_functiondef('public.assess_definition_of_done(uuid,text,uuid,uuid)'::regprocedure);

  -- ══ A. THE PREDICATE ITSELF ═════════════════════════════════════════════
  -- A1. the four conjuncts, each pinned on its whole expression. `%ok%` or
  -- `%receipt%` alone would match the prose above and could never fail.
  if position($tok$ae.decision in ('auto_executed', 'executed_after_approval')$tok$ in v_landed) = 0 then
    raise exception '679: conjunct (1) is gone — the whitelist of terminal-successful decisions. A blacklist admits the mig-642 `expired` tombstones that say "Approved but never executed"';
  end if;
  if position($tok$coalesce(btrim(ae.receipt), '') <> '' or ae.result is not null$tok$ in v_landed) = 0 then
    raise exception '679: conjunct (2) is gone — a claim taken BEFORE the external call would count as landed in all three readers at once';
  end if;
  if position($tok$coalesce(ae.result #>> array['ok'], 'true') <> 'false'$tok$ in v_landed) = 0 then
    raise exception '679: conjunct (3) is gone — a decision its own result denies would count as landed';
  end if;
  if position('ae.rolled_back_at is null' in v_landed) = 0 then
    raise exception '679: conjunct (4) is gone — an undone action would count as landed';
  end if;
  -- A2. never a blacklist. This is the one pin a body that still reads a
  -- claim-time marker as truth cannot satisfy.
  if position($tok$<> 'failed'$tok$ in v_landed) > 0 then
    raise exception '679: the shared predicate contains a `<> ''failed''` blacklist — that is the defect 678 removed, re-introduced at the source';
  end if;

  -- A3. VOLATILITY and the SECDEF/search_path bargain.
  select p.provolatile, p.prosecdef into v_vol, v_secdef
    from pg_proc p where p.oid = 'public.action_execution_landed(public.action_executions)'::regprocedure;
  if v_vol <> 'i' then
    raise exception '679: action_execution_landed is not IMMUTABLE (provolatile=%). If it now reads a table it MUST be STABLE — mig 674 shipped exactly that mistake in reverse', v_vol;
  end if;
  if v_secdef then
    raise exception '679: action_execution_landed became SECURITY DEFINER. It has NO pinned search_path, deliberately, because SECURITY INVOKER + no schema-qualified reference needs none. If it must be SECURITY DEFINER, it owes a `set search_path` first';
  end if;

  -- A4. ONE function of this name. A stale overload would be resolved instead
  -- of this one and nobody would see a diff.
  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'action_execution_landed';
  if v_cnt <> 1 then
    raise exception '679: expected exactly 1 action_execution_landed, found %', v_cnt;
  end if;

  -- ══ B. THE TRUTH TABLE — the predicate DRIVEN, not described. ═══════════
  -- Every row here is one conjunct inverted. A predicate hard-wired to false
  -- fails cases 1/2/10/11b; one hard-wired to true fails everything else.
  -- Rows are built with jsonb_populate_record so column ORDER cannot silently
  -- shift the meaning of a literal row(...) constructor.
  for v_case in
    select * from (values
      ('1  ungated success (auto_executed + receipt + ok:true)',
       '{"decision":"auto_executed","receipt":"CFG-1","result":{"ok":true}}'::jsonb, true),
      ('2  gated success (executed_after_approval + receipt + result)',
       '{"decision":"executed_after_approval","receipt":"CFG-2","result":{"ok":true}}'::jsonb, true),
      ('3  THE PRE-CALL CLAIM (successful decision, receipt+result BOTH null)',
       '{"decision":"executed_after_approval"}'::jsonb, false),
      ('4  contradicting result (decision says done, result says ok:false)',
       '{"decision":"auto_executed","receipt":"CFG-4","result":{"ok":false}}'::jsonb, false),
      ('5  rolled back (the ORIGINAL, after record_action_rollback)',
       '{"decision":"auto_executed","receipt":"CFG-5","result":{"ok":true},"rolled_back_at":"2026-08-10T00:00:00Z"}'::jsonb, false),
      ('6  mig-642 tombstone (decision=expired, "Approved but never executed")',
       '{"decision":"expired","receipt":"","result":{"note":"Approved but never executed."}}'::jsonb, false),
      ('7  outright failure',
       '{"decision":"failed","receipt":"","result":{"ok":false}}'::jsonb, false),
      ('8  the GATE row (human_gated_destructive, nothing sent)',
       '{"decision":"human_gated_destructive"}'::jsonb, false),
      ('9  BLANK receipt, no result — `receipt is not null` would wrongly pass this',
       '{"decision":"auto_executed","receipt":"   "}'::jsonb, false),
      ('10 result is not a JSON OBJECT — `#>>` must yield null, not raise',
       '{"decision":"auto_executed","result":"just a string"}'::jsonb, true),
      ('11a rollback pair — the COMPENSATING row is landed',
       '{"decision":"executed_after_approval","receipt":"undone","result":{"ok":true}}'::jsonb, true),
      ('11b rollback pair — the ORIGINAL is not',
       '{"decision":"executed_after_approval","receipt":"sent","result":{"ok":true},"rolled_back_at":"2026-08-10T00:00:00Z"}'::jsonb, false),
      ('12 a PREVIEW carrying a receipt',
       '{"decision":"previewed","receipt":"this is only a preview","result":{"ok":true}}'::jsonb, false)
    ) t(label, row_json, expected)
  loop
    v_got := public.action_execution_landed(
               jsonb_populate_record(null::public.action_executions, v_case.row_json));
    if v_got is distinct from v_case.expected then
      v_fail := v_fail || format(E'\n    %s -> got %s, expected %s', v_case.label, v_got, v_case.expected);
    end if;
  end loop;
  if v_fail <> '' then
    raise exception '679: the shared predicate FAILED its truth table:%', v_fail;
  end if;

  -- ══ C. ALL THREE READERS NOW CALL IT — and each still carries its own
  --       guards, which a create-or-replace of a whole body is exactly how
  --       you lose. ═════════════════════════════════════════════════════════

  -- C1. mig 676. Two calls (NEW side and OLD side); the transition guard is
  -- worthless with one.
  v_n := (length(v_676) - length(replace(v_676, 'public.action_execution_landed(', '')))
         / length('public.action_execution_landed(');
  if v_n <> 2 then
    raise exception '676/679: expected the shared predicate on BOTH the NEW and OLD sides of complete_onboarding_item_from_execution, found % — with one, a stray later UPDATE re-completes an item a person has moved on from', v_n;
  end if;
  if position('public.action_execution_landed(new)' in v_676) = 0
     or position('public.action_execution_landed(old)' in v_676) = 0 then
    raise exception '676/679: the two calls are not NEW and OLD';
  end if;
  -- the open-coded copy must be GONE, or there are two definitions again
  if v_676 ilike '%auto_executed%' or v_676 ilike '%executed_after_approval%' then
    raise exception '676/679: complete_onboarding_item_from_execution still open-codes a decision literal — that is the second definition this migration exists to remove';
  end if;
  if position('onboarding:%' in v_676) = 0 then
    raise exception '676/679: the dedupe_key prefix guard was dropped';
  end if;
  if position('signed_off' in v_676) = 0 then
    raise exception '676/679: the terminal-item guard was dropped — a receipt could downgrade a human sign-off back to done';
  end if;
  if position('tenant_id = new.tenant_id' in v_676) = 0 then
    raise exception '676/679: the tenant scope was dropped from the update — a key could reach across tenants';
  end if;
  if v_676 not ilike '%exception when others%' then
    raise exception '676/679: a malformed key would now roll back a real execution';
  end if;
  if position($tok$tg_op = 'UPDATE'$tok$ in v_676) = 0 then
    raise exception '676/679: the OLD/NEW transition guard lost its TG_OP branch — OLD is unassigned on INSERT';
  end if;
  if position('completed_by_execution' in v_676) = 0 then
    raise exception '676/679: the completed_by_execution stamp is gone — a future reversal has nothing to scope itself on';
  end if;

  -- C2. mig 677.
  v_n := (length(v_677) - length(replace(v_677, 'public.action_execution_landed(', '')))
         / length('public.action_execution_landed(');
  if v_n <> 2 then
    raise exception '677/679: expected the shared predicate on BOTH the NEW and OLD sides of advance_dunning_cadence, found % — with one, an unrelated UPDATE recomputes PATH B against a later current_date and promotes an invoice to a rung nobody chased it at', v_n;
  end if;
  if position('public.action_execution_landed(new)' in v_677) = 0
     or position('public.action_execution_landed(old)' in v_677) = 0 then
    raise exception '677/679: the two calls are not NEW and OLD';
  end if;
  if v_677 ilike '%auto_executed%' or v_677 ilike '%executed_after_approval%' then
    raise exception '677/679: advance_dunning_cadence still open-codes a decision literal';
  end if;
  -- 677's own six, re-pinned. Pinned on CODE, not on the comment that labels
  -- it: `PATH A` alone stays true after somebody deletes the branch.
  if position('dunning:%' in v_677) = 0
     or position($tok$split_part(new.dedupe_key, ':', 2)$tok$ in v_677) = 0
     or position($tok$split_part(new.dedupe_key, ':', 3)$tok$ in v_677) = 0 then
    raise exception '677/679: the sweep path was lost — run_dunning_sweep would stop advancing';
  end if;
  -- ⚠ pinned on `new.params->>''external_ref''`, NOT on `%external_ref%`:
  -- mig 661 used the loose form and `renewal_invoices.source_external_ref` two
  -- lines below CONTAINS that substring, so the pin could not fail.
  if position('from action_definitions ad' in v_677) = 0
     or position($tok$new.params->>'external_ref'$tok$ in v_677) = 0 then
    raise exception '677/679: PATH B is gone — the employee-sent chase would stop counting, which IS the mig-661 bug';
  end if;
  if position('from dunning_rungs r' in v_677) = 0
     or position('join dunning_ladders l on l.id = r.ladder_id' in v_677) = 0
     or position('max(r.stage)' in v_677) = 0 then
    raise exception '677/679: PATH B no longer reads the rung out of the ladder — action_key repeats across rungs, so a guessed stage is wrong';
  end if;
  if position('greatest(coalesce(cadence_stage, 0), v_stage)' in v_677) = 0 then
    raise exception '677/679: a late LOWER rung could now drag the ladder back down and re-chase the customer';
  end if;
  if position('and tenant_id = new.tenant_id' in v_677) = 0 then
    raise exception '677/679: the invoice could be selected outside the acting tenant';
  end if;
  if v_677 not ilike '%exception when others%' then
    raise exception '677/679: a malformed key would now roll back a real execution';
  end if;
  if position($tok$tg_op = 'UPDATE'$tok$ in v_677) = 0 then
    raise exception '677/679: the OLD/NEW transition guard lost its TG_OP branch';
  end if;

  -- C3. mig 678. Two calls, one per clause: a mutant that fixed only clause
  -- (a) would otherwise pass.
  v_n := (length(v_678) - length(replace(v_678, 'public.action_execution_landed(ex)', '')))
         / length('public.action_execution_landed(ex)');
  if v_n <> 2 then
    raise exception '678/679: expected the shared predicate in BOTH the origin clause and the agentic_run anchor, found % — mig 642 tombstones pass through whichever one is missing', v_n;
  end if;
  if v_678 ilike '%auto_executed%' or v_678 ilike '%executed_after_approval%' then
    raise exception '678/679: assess_definition_of_done still open-codes a decision literal';
  end if;
  if position($tok$<> 'failed'$tok$ in v_678) > 0 then
    raise exception '678/679: the blacklist resolving test is back — a claim taken BEFORE the call, and a voided approval nobody carried out, would both count as done';
  end if;
  -- both clauses still ASK the question. A mutant that deleted the (d) anchor
  -- outright satisfies the count above by having no second copy to be wrong.
  if position('ex.resolves_task_id = ae.task_id' in v_678) = 0 then
    raise exception '678/679: the origin-scoped clause no longer asks whether the approval was carried out';
  end if;
  if position('ex.resolves_task_id = v_gated_task' in v_678) = 0
     or position('last_gated_human_task_id' in v_678) = 0
     or position('v_unresolved := true' in v_678) = 0 then
    raise exception '678/679: the fail-CLOSED agentic_run anchor was lost — an unresolved gate could pass as verified';
  end if;
  -- mig 425, re-pinned, INCLUDING its position ahead of every read.
  if position('not authorized for this workspace' in v_678) = 0
     or position($tok$p.tenant_id = p_tenant_id or p.layer = 'platform'$tok$ in v_678) = 0 then
    raise exception '678/679: the mig-425 tenant guard is gone — this function takes p_tenant_id as a PARAMETER and is SECURITY DEFINER, so that is a live cross-tenant read';
  end if;
  if position('not authorized for this workspace' in v_678) > position('from action_executions ae' in v_678)
     or position('not authorized for this workspace' in v_678) > position('account_writeback_requests' in v_678)
     or position('not authorized for this workspace' in v_678) > position('outbound_drafts' in v_678) then
    raise exception '678/679: the guard lands after a read — the backlog is counted before the caller is checked';
  end if;
  -- mig 428, re-pinned: the census counts occurrences of this token as real
  -- guard calls; one mention in a comment makes an unguarded reader invisible.
  if position('can_access_de' in v_678) > 0 then
    raise exception '678/679: the mig-428 counter invariant is broken — the token is back in the body';
  end if;
  -- the contract, and BOTH DIRECTIONS of the verdict.
  if position('pending_count' in v_678) = 0 or position('''verified''' in v_678) = 0
     or position('''unresolved''' in v_678) = 0 then
    raise exception '678/679: the returned contract lost a key';
  end if;
  if position($tok$'verified', (coalesce(v_pending, 0) = 0) and not v_unresolved$tok$ in v_678) = 0 then
    raise exception '678/679: verified is no longer computed from the pending count and the unresolved anchor — it could now be a constant in either direction';
  end if;
  if position('stable' in lower(v_678)) = 0 or position('security definer' in lower(v_678)) = 0
     or position($tok$search_path TO 'public'$tok$ in v_678) = 0 then
    raise exception '678/679: assess_definition_of_done lost STABLE, SECURITY DEFINER or its pinned search_path';
  end if;

  -- ══ D. THE TRIGGER EVENTS. A column list is what made mig 675 blind to the
  --       receipt-only success UPDATE; narrowing either one back makes its
  --       whole gated lifecycle INERT with nothing in any log to say why. ═══
  for v_case in
    select * from (values ('trg_onboarding_item_completes'), ('trg_advance_dunning_cadence')) t(nm)
  loop
    select pg_get_triggerdef(tg.oid) into v_trgdef
      from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'action_executions' and tg.tgname = v_case.nm;
    if v_trgdef is null then
      raise exception '679: % is not attached to action_executions', v_case.nm;
    end if;
    if v_trgdef ilike '%update of%' then
      raise exception '679: % fires on a COLUMN LIST — connector-hub records a gated success by updating receipt/result only. Trigger: %', v_case.nm, v_trgdef;
    end if;
    if v_trgdef not ilike '%after insert or update on%' then
      raise exception '679: % is not AFTER INSERT OR UPDATE. Trigger: %', v_case.nm, v_trgdef;
    end if;
  end loop;

  -- ══ E. THE PERIMETER, asserted not stated, on all four functions. ═══════
  if has_function_privilege('anon', 'public.action_execution_landed(public.action_executions)', 'EXECUTE') then
    raise exception '679: anon can execute action_execution_landed — that is the internet';
  end if;
  if has_function_privilege('authenticated', 'public.action_execution_landed(public.action_executions)', 'EXECUTE') then
    raise exception '679: authenticated can execute action_execution_landed directly';
  end if;
  if has_function_privilege('public', 'public.action_execution_landed(public.action_executions)', 'EXECUTE') then
    raise exception '679: PUBLIC still holds EXECUTE on action_execution_landed — revoking the named roles alone is theatre';
  end if;
  -- ⚠ the pin that catches the dev failure mode mig 678 found: a brand-new
  -- function has proacl NULL, so EXECUTE arrives via PUBLIC and a BARE revoke
  -- strips the service role along with everyone else.
  if not has_function_privilege('service_role', 'public.action_execution_landed(public.action_executions)', 'EXECUTE') then
    raise exception '679: service_role LOST EXECUTE on action_execution_landed';
  end if;

  if has_function_privilege('anon', 'public.complete_onboarding_item_from_execution()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.complete_onboarding_item_from_execution()', 'EXECUTE') then
    raise exception '679: mig 676''s perimeter regressed — anon or authenticated can execute complete_onboarding_item_from_execution';
  end if;
  if has_function_privilege('anon', 'public.advance_dunning_cadence()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.advance_dunning_cadence()', 'EXECUTE') then
    raise exception '679: mig 677''s perimeter regressed — anon or authenticated can execute advance_dunning_cadence';
  end if;
  if has_function_privilege('anon', 'public.assess_definition_of_done(uuid,text,uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.assess_definition_of_done(uuid,text,uuid,uuid)', 'EXECUTE')
     or has_function_privilege('public', 'public.assess_definition_of_done(uuid,text,uuid,uuid)', 'EXECUTE') then
    raise exception '679: mig 678''s perimeter regressed on assess_definition_of_done';
  end if;
  if not has_function_privilege('service_role', 'public.assess_definition_of_done(uuid,text,uuid,uuid)', 'EXECUTE') then
    raise exception '679: service_role LOST EXECUTE on assess_definition_of_done — de-work, agentic-step-execute and connector-hub all call it as the service role';
  end if;

  -- ══ F. RUNTIME SMOKE on the SERVICE path, both directions. A gate that
  --       withholds everything passes every pin above and is useless. ═══════
  select id into v_tenant from tenants limit 1;
  if v_tenant is not null then
    select public.assess_definition_of_done(v_tenant, 'agentic_run',
             '00000000-0000-0000-0000-000000000000'::uuid, null) into v_out;
    if v_out->>'verified' is null or v_out->>'pending_count' is null or v_out->>'unresolved' is null then
      raise exception '679: assess_definition_of_done no longer returns its contract on the service path: %', v_out;
    end if;
    if (v_out->>'verified')::boolean is not true then
      raise exception '679: an empty scope did NOT verify — the gate now withholds work that finished. %', v_out;
    end if;
  end if;

  -- ══ G. OBSERVATION, reported not enforced: the same census the Ring-0
  --       probe runs, so the pin list in scripts/certify.mjs is re-measured
  --       here rather than assumed. ═══════════════════════════════════════
  select count(*) into v_cnt
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
     and (p.prosrc ilike '%executed_after_approval%' or p.prosrc ilike '%auto_executed%')
     and p.prosrc not ilike '%action_execution_landed%';
  raise notice '679: % function(s) still name a decision literal without calling the shared predicate. Every one must be a WRITER, a COUNTER or a LOCK, pinned with its reason in certify.mjs — anything else is a fifth reader.', v_cnt;

  raise notice '679: ONE definition of a landed action. 676, 677 and 678 now share it, the truth table drove all four conjuncts including the rollback pair, and every guard those three shipped is still pinned.';
end $assert$;

commit;

notify pgrst, 'reload schema';
