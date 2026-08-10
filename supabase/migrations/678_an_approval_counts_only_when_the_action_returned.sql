-- 678_an_approval_counts_only_when_the_action_returned.sql
-- ==========================================================================
-- WHY. `assess_definition_of_done` (mig 319, guarded by 425, reworded by 428)
-- is THE GATE: it decides whether a run, a work item or an objective may call
-- itself done. It asks "is every required side-effect actually finished?" and
-- it answers that question, twice, with this test:
--
--     not exists (select 1 from action_executions ex
--                  where ex.resolves_task_id = <the approval>
--                    and ex.decision <> 'failed')
--
-- `resolves_task_id` is written AT CLAIM TIME. Read live from the catalog:
-- `claim_gated_action_execution` INSERTS a row carrying
-- `decision = 'executed_after_approval'`, `resolves_task_id = p_task_id`, and
-- hardcoded `receipt = null, result = null` — and connector-hub calls it at
-- index.ts:7291, which is BEFORE `runRegisteredAction` at index.ts:7317.
-- So the gate reads "this approval was carried out" for an action that has
-- not happened yet and may still fail. Same root cause as migs 676 and 677:
-- claim-time bookkeeping read as proof of completion.
--
-- ── THE TWO LIFECYCLES, and what this gate does with each ────────────────
-- Read from the live catalog and the edge source on 2026-08-10, not from
-- supabase/baseline/full_schema.sql (stale — it omits `expired` from the
-- decision CHECK; live production carries it, verified today).
--
--   UNGATED  connector-hub calls out FIRST (index.ts:7317), then writes ONE
--     row via `record_action_execution` (index.ts:7372) with
--     `p_decision = outcome.ok ? 'auto_executed' : 'failed'`, receipt and
--     result together. That row has NO human_task, so `task_id` is null.
--     ⚠ THE UNGATED PATH NEVER ENTERS THIS GATE AT ALL, before or after this
--     migration: clause (a) filters `ae.decision in (human_gated_*)` AND
--     inner-joins `human_tasks on ht.id = ae.task_id`. An auto_executed row
--     fails both. It contributes 0 to pending_count and always has.
--     This migration must not, and does not, change that.
--
--   HUMAN-GATED
--     1. `record_action_execution` (index.ts:7232) writes the GATE row —
--        `human_gated_destructive` | `human_gated_trust` — and the human_task.
--        Nothing sent. Counted pending here while the task is 'pending'.
--     2. a person approves.
--     3. `claim_gated_action_execution` (index.ts:7291) inserts the CLAIM row:
--        successful-looking decision, resolves_task_id set, receipt and result
--        NULL. STILL NOTHING SENT. ← today the gate stops counting it here.
--     4. `runRegisteredAction` calls out.
--     5a. success -> UPDATE the claim row setting ONLY receipt and result
--         (index.ts:7324). This is the first moment anything is true.
--     5b. failure -> UPDATE setting `decision='failed'`,
--         `resolves_task_id = null`, result ok:false (index.ts:7329).
--
-- ── THE CONDITION CHOSEN ─────────────────────────────────────────────────
-- An approval counts as CARRIED OUT when a row that resolves it has LANDED,
-- which is four things at once:
--   (1) a terminal-successful decision   — `auto_executed` |
--                                          `executed_after_approval`
--   (2) EVIDENCE THE CALL RETURNED       — a non-empty `receipt` or a non-null
--                                          `result`
--   (3) no contradicting result          — `result->>'ok'` is not 'false'
--   (4) not rolled back                  — `rolled_back_at` is null
--
-- ⚠ (1) IS NOT COSMETIC HERE, AND THIS IS WHERE 676's PREDICATE COULD NOT BE
-- COPIED BLINDLY. 676 and 677 were tightening a test that ALREADY named the
-- two successful decisions. This one names none: `decision <> 'failed'` is a
-- BLACKLIST, so every other value in the live CHECK — `previewed`, `rejected`,
-- `expired`, `guardrail_blocked`, `access_denied`, both `human_gated_*` —
-- counts as carried out. Measured on production today that is not theoretical:
-- of the 20 rows carrying `resolves_task_id`, SIX have `decision = 'expired'`
-- with an empty receipt and a result that reads, verbatim, "Approved but never
-- executed. Voided before a scheduled executor existed…". Those are mig 642's
-- tombstones for approvals nobody ever carried out, and the gate currently
-- reads all six as evidence of completion. Adding (2) alone would NOT have
-- caught them — they carry a non-null `result`. The blacklist had to become a
-- whitelist.
--
-- (2) is what defeats the pre-call claim, and it is chosen on evidence rather
-- than taste: `claim_gated_action_execution` is the only writer that produces
-- a successful-looking decision with BOTH receipt and result null (it hardcodes
-- `null, null`), and of the 14 production rows that resolve a task with a
-- successful decision, 14 carry BOTH a receipt and a result and ZERO carry
-- neither. So "receipt or result present" separates the pre-call placeholder
-- from every completion ever recorded here.
--
-- ── WHAT THE GATE RETURNS, CASE BY CASE. Both halves, stated. ────────────
-- A gate that withholds everything would pass any "it no longer passes
-- prematurely" test and be completely broken, so each of these is proved on
-- dev in a rolled-back transaction, not asserted here:
--   claim only (in flight, or edge fn died) -> verified FALSE   (was TRUE ⚠)
--   claim then success (5a receipt/result)  -> verified TRUE    (unchanged)
--   claim then failure (5b nulls the link)  -> verified FALSE   (unchanged)
--   ungated success (auto_executed)         -> verified TRUE    (unchanged;
--                                              never entered the count at all)
--   resolved by a rolled-back row           -> verified FALSE   (was TRUE)
--   resolved only by a 642 `expired` stone  -> verified FALSE   (was TRUE ⚠)
--   task still 'pending'                    -> verified FALSE   (unchanged)
--
-- ── DIRECTION OF FAILURE ─────────────────────────────────────────────────
-- If the edge function dies between the claim and the call, 5b never runs and
-- the contradicting event never arrives. A rule that only REVERSED on a later
-- `failed` could not save this. Requiring proof of return fails CLOSED: the
-- terminal is withheld, and it SELF-HEALS — connector-hub's reconcile
-- (index.ts:7340-7365) re-assesses on the real success and flips
-- `awaiting_verification` -> `completed` and `waiting_human` -> `done`. So the
-- in-flight window costs a re-check, not a stuck record.
--
-- ── WHAT MUST NOT CHANGE, AND DID NOT ────────────────────────────────────
-- ⚠ `due_approved_actions` uses the SAME `resolves_task_id … decision <>
-- 'failed'` test and is DELIBERATELY LEFT ALONE. There it is an exactly-once
-- LOCK — "somebody is already running this, do not fire it twice" — and a
-- claim in flight is exactly what it must refuse. The same predicate is right
-- as a lock and wrong as a gate. `claim_gated_action_execution`'s own
-- duplicate check is the same, and is likewise untouched.
--
-- Re-pinned below because a `create or replace` of the whole body could drop
-- them silently: mig 425's cross-tenant guard and its position AHEAD of every
-- read (this function takes p_tenant_id as a PARAMETER and is SECURITY
-- DEFINER), mig 428's rule that the literal `can_access_de` appears nowhere in
-- the body (a census counts occurrences of that token as real guard calls),
-- the fail-CLOSED `agentic_run` anchor, and the returned contract.
--
-- ⚠ NAMED AND LEFT, not buried. Three things this migration does NOT do:
--
--   1. CLAUSE (a) STILL IGNORES A TASK WHOSE STATUS IS 'expired' OR
--      'rejected'. It counts only `pending` and `approved`. So a voided or
--      refused approval contributes 0 to pending_count, i.e. reads as nothing
--      outstanding. Clause (d) now catches this for `agentic_run` scope; (a)
--      does not, for any scope. Left because "does a refused approval block
--      its objective from ever completing?" is a product decision, not a bug
--      fix — the same call migs 676 and 677 declined to make unilaterally.
--      Measured today: 0 origin scopes on production are affected, so the gap
--      is real but currently unexercised.
--
--   2. THE TWO SUBQUERIES CARRY NO TENANT PREDICATE. They match on
--      `resolves_task_id`, a uuid. Safe today by argument rather than by
--      construction: the only writer is `claim_gated_action_execution`, which
--      resolves the task under `where id = p_task_id and tenant_id =
--      p_tenant_id` before copying that same tenant onto the claim row.
--      Measured today: 0 of 20 resolver rows on production have a tenant
--      differing from the task they resolve. Adding `ex.tenant_id =
--      ae.tenant_id` is a perimeter change, not this defect, and belongs in
--      its own migration with its own proof.
--
--   3. `record_action_rollback` still has zero callers in this repo, so (4) is
--      protection against a mechanism nothing reaches yet. It is included for
--      the same reason 676 included it: the day something does call it, the
--      honest reading of a reversed action is that its side-effect no longer
--      stands.
--
-- ── MEASURED DELTA, before writing anything ──────────────────────────────
-- The gate is in SHADOW (`platform_config definition_of_done.mode = 'shadow'`,
-- with `.enabled = 'true'`), so its verdicts are logged and never acted on —
-- one config row from being live. Replaying BOTH bodies in pure SQL over the
-- 25 logged assessments reproduced all 25 stored verdicts exactly (25/25), and
-- 0 of the 25 CHANGE under this migration — all 25 are `de_work_item` scope
-- and none of them touch a claim row. Over the whole surface: 0 of 2 origin
-- scopes change clause (a); 2 of 6 `agentic_step_runs` change clause (d), both
-- because their approval is resolved only by a mig-642 `expired` tombstone;
-- the one run resolved by a genuine `executed_after_approval` still verifies.
-- Nothing that ever really completed stops verifying.
-- ==========================================================================

begin;

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
  --
  --     ⚠ mig 678. The resolving test used to be a blacklist — anything not
  --     marked as a failure — which a row satisfies the instant the approval
  --     is CLAIMED, before the external call, and which a voided tombstone
  --     satisfies forever. It is now proof that the call RETURNED. `#>>`
  --     rather than `->>` so a result that is not a JSON object yields null
  --     instead of raising.
  select count(*) into v_pending
    from action_executions ae
    join human_tasks ht on ht.id = ae.task_id
   where ae.tenant_id = p_tenant_id and ae.origin_kind = p_scope and ae.origin_id = p_scope_id
     and ae.decision in ('human_gated_destructive','human_gated_trust')
     and ( ht.status = 'pending'
        or ( ht.status = 'approved'
             and not exists (select 1 from action_executions ex
                              where ex.resolves_task_id = ae.task_id
                                and ex.decision in ('auto_executed', 'executed_after_approval')
                                and (coalesce(btrim(ex.receipt), '') <> '' or ex.result is not null)
                                and coalesce(ex.result #>> array['ok'], 'true') <> 'false'
                                and ex.rolled_back_at is null) ) );

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
  --     Same mig-678 tightening as (a), and the two must stay identical: this
  --     is the clause the six voided approvals were passing through.
  if p_scope = 'agentic_run' then
    select last_gated_human_task_id into v_gated_task from agentic_step_runs where id = p_scope_id and tenant_id = p_tenant_id;
    if v_gated_task is not null
       and not exists (select 1 from action_executions ex
                        where ex.resolves_task_id = v_gated_task
                          and ex.decision in ('auto_executed', 'executed_after_approval')
                          and (coalesce(btrim(ex.receipt), '') <> '' or ex.result is not null)
                          and coalesce(ex.result #>> array['ok'], 'true') <> 'false'
                          and ex.rolled_back_at is null) then
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

-- ── The perimeter. ────────────────────────────────────────────────────────
-- mig 319 granted `authenticated` deliberately and mig 425 then had to bolt a
-- tenant guard on because of it. Measured today: the ONLY callers are
-- `conclude_objective_verified` (SECURITY DEFINER, runs as owner) and the edge
-- functions, which use the SERVICE ROLE — connector-hub/index.ts:7346 and
-- _shared/defOfDone.ts:39, reached from de-work (x2) and agentic-step-execute.
-- Nothing in the app calls it. So the browser-reachable grant buys nothing and
-- costs a permanent reliance on that guard. Revoked; asserted below.
--
-- ⚠ service_role is GRANTED, not merely left alone. On production the ACL
-- already names it, but on dev `proacl` is NULL — meaning EXECUTE arrives via
-- PUBLIC — so a bare revoke there would strip the service role and break every
-- caller. Unlike migs 676/677 this is not a trigger function; the firing role
-- is checked on every call.
revoke execute on function public.assess_definition_of_done(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.assess_definition_of_done(uuid, text, uuid, uuid)
  to service_role;

-- ── Prove the guards, the perimeter and the contract. ─────────────────────
-- Every pin below is one somebody could delete and still have a function that
-- "works" on the happy path. Each was inverted on dev and confirmed to turn
-- red before this shipped; the counts are pinned at 2 because the predicate
-- appears twice and a mutant that fixed only clause (a) would otherwise pass.
do $assert$
declare
  v_def          text;
  v_n            int;
  v_anon         boolean;
  v_authed       boolean;
  v_public       boolean;
  v_service      boolean;
  v_tenant       uuid;
  v_out          jsonb;
  v_not_landed   bigint;
  v_landed       bigint;
  function_count int;
begin
  v_def := pg_get_functiondef('public.assess_definition_of_done(uuid,text,uuid,uuid)'::regprocedure);

  -- ── THE DEFECT ITSELF. The blacklist must be gone from BOTH clauses. This
  -- is the one pin that cannot be satisfied by a body that still reads a
  -- claim-time marker as truth. ──
  -- Pinned on the bare operator, NOT on `ex.decision <> ''failed''`: the alias
  -- is one rename away from slipping past a qualified pin, and this body has no
  -- other legitimate use of it. mig 677 shipped after discovering mig 661's pin
  -- could not fail because a loose substring matched a different column; the
  -- lesson generalises to pins that are too TIGHT as well as too loose.
  if position($tok$<> 'failed'$tok$ in v_def) > 0 then
    raise exception '678: the blacklist resolving test is still present — a claim taken BEFORE the external call, and a voided approval nobody carried out, would both still count as done';
  end if;

  -- ── (1) terminal-successful decision, in BOTH clauses. ──
  v_n := (length(v_def) - length(replace(v_def, $tok$ex.decision in ('auto_executed', 'executed_after_approval')$tok$, '')))
         / length($tok$ex.decision in ('auto_executed', 'executed_after_approval')$tok$);
  if v_n <> 2 then
    raise exception '678: expected the successful-decision whitelist in BOTH the origin clause and the agentic_run anchor, found % — mig 642 tombstones (decision=expired) pass through whichever one is missing', v_n;
  end if;

  -- ── (2) EVIDENCE THE CALL RETURNED, in BOTH clauses. Without this the
  -- pre-call claim row still closes the gate, which is the whole defect. ──
  v_n := (length(v_def) - length(replace(v_def, $tok$coalesce(btrim(ex.receipt), '') <> '' or ex.result is not null$tok$, '')))
         / length($tok$coalesce(btrim(ex.receipt), '') <> '' or ex.result is not null$tok$);
  if v_n <> 2 then
    raise exception '678: the proof-of-return guard is present % time(s), expected 2 — a claim taken BEFORE the call would close the gate', v_n;
  end if;

  -- ── (3) contradicting result, in BOTH clauses. Pinned on the whole
  -- expression: `%ok%` alone matches prose and could never fail. ──
  v_n := (length(v_def) - length(replace(v_def, $tok$coalesce(ex.result #>> array['ok'], 'true') <> 'false'$tok$, '')))
         / length($tok$coalesce(ex.result #>> array['ok'], 'true') <> 'false'$tok$);
  if v_n <> 2 then
    raise exception '678: the contradicting-result guard is present % time(s), expected 2 — a decision its own result denies would count as done', v_n;
  end if;

  -- ── (4) not rolled back, in BOTH clauses. ──
  v_n := (length(v_def) - length(replace(v_def, $tok$ex.rolled_back_at is null$tok$, '')))
         / length($tok$ex.rolled_back_at is null$tok$);
  if v_n <> 2 then
    raise exception '678: the rolled-back guard is present % time(s), expected 2', v_n;
  end if;

  -- ── both clauses still ASK the question. A mutant that deleted the (d)
  -- anchor outright would satisfy every count above by having no second copy
  -- to be wrong, so the anchors are named individually. ──
  if position($tok$ex.resolves_task_id = ae.task_id$tok$ in v_def) = 0 then
    raise exception '678: the origin-scoped clause no longer asks whether the approval was carried out';
  end if;
  if position($tok$ex.resolves_task_id = v_gated_task$tok$ in v_def) = 0
     or position('last_gated_human_task_id' in v_def) = 0
     or position('v_unresolved := true' in v_def) = 0 then
    raise exception '678: the fail-CLOSED agentic_run anchor was lost — an unresolved gate could pass as verified';
  end if;

  -- ── mig 425, re-pinned. A create-or-replace of the whole body is exactly
  -- how a cross-tenant guard gets dropped without anyone noticing. ──
  if position('not authorized for this workspace' in v_def) = 0 then
    raise exception '678: the mig-425 tenant guard is gone — this function takes p_tenant_id as a PARAMETER and is SECURITY DEFINER, so that is a live cross-tenant read';
  end if;
  if position($tok$p.tenant_id = p_tenant_id or p.layer = 'platform'$tok$ in v_def) = 0 then
    raise exception '678: the guard no longer compares p_tenant_id to the caller workspace';
  end if;
  if position('not authorized for this workspace' in v_def) > position('from action_executions ae' in v_def)
     or position('not authorized for this workspace' in v_def) > position('account_writeback_requests' in v_def)
     or position('not authorized for this workspace' in v_def) > position('outbound_drafts' in v_def) then
    raise exception '678: the guard lands after a read — the backlog is counted before the caller is checked';
  end if;

  -- ── mig 428, re-pinned. The census counts occurrences of this token as real
  -- guard calls; one mention in a comment makes an unguarded reader invisible. ──
  if position('can_access_de' in v_def) > 0 then
    raise exception '678: the mig-428 counter invariant is broken — the token is back in the body';
  end if;

  -- ── the contract the four callers depend on. ──
  if position('pending_count' in v_def) = 0 or position('''verified''' in v_def) = 0
     or position('''unresolved''' in v_def) = 0 then
    raise exception '678: the returned contract lost a key — assessAndLog reads verified, the log stores pending_count';
  end if;
  if position('stable' in lower(v_def)) = 0 or position('security definer' in lower(v_def)) = 0
     or position($tok$search_path TO 'public'$tok$ in v_def) = 0 then
    raise exception '678: the function lost STABLE, SECURITY DEFINER or its pinned search_path';
  end if;

  -- ── the perimeter, ASSERTED not stated. ──
  select has_function_privilege('anon',          'public.assess_definition_of_done(uuid,text,uuid,uuid)', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.assess_definition_of_done(uuid,text,uuid,uuid)', 'EXECUTE'),
         has_function_privilege('public',        'public.assess_definition_of_done(uuid,text,uuid,uuid)', 'EXECUTE'),
         has_function_privilege('service_role',  'public.assess_definition_of_done(uuid,text,uuid,uuid)', 'EXECUTE')
    into v_anon, v_authed, v_public, v_service;
  if v_anon then
    raise exception '678: anon can execute assess_definition_of_done — that is the internet';
  end if;
  if v_authed then
    raise exception '678: authenticated can still execute assess_definition_of_done directly';
  end if;
  if v_public then
    raise exception '678: PUBLIC still holds EXECUTE — revoking the named roles alone is theatre';
  end if;
  -- ⚠ the pin that catches the dev failure mode: a bare revoke where proacl was
  -- NULL strips the service role, and every caller is the service role.
  if not v_service then
    raise exception '678: service_role LOST EXECUTE — de-work, agentic-step-execute and connector-hub all call this as the service role, so the gate would throw and (in enforce) withhold EVERY terminal';
  end if;

  -- exactly one function of this name; a stale overload would be called instead
  select count(*) into function_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'assess_definition_of_done';
  if function_count <> 1 then
    raise exception '678: expected exactly 1 assess_definition_of_done, found %', function_count;
  end if;

  -- ── runtime smoke on the SERVICE path. postgres has a null auth.uid(),
  -- exactly like the service role, so the guard must be bypassed and the
  -- contract must still come back. A body that raises would be caught here. ──
  select id into v_tenant from tenants limit 1;
  if v_tenant is not null then
    select public.assess_definition_of_done(v_tenant, 'agentic_run',
             '00000000-0000-0000-0000-000000000000'::uuid, null) into v_out;
    if v_out->>'verified' is null or v_out->>'pending_count' is null or v_out->>'unresolved' is null then
      raise exception '678: the function no longer returns its contract on the service path: %', v_out;
    end if;
    -- ⚠ THE OTHER HALF. A gate that withholds everything passes every test
    -- above and is useless. An empty scope has nothing pending, so it MUST
    -- verify. If this ever raises, the predicate is inverted somewhere.
    if (v_out->>'verified')::boolean is not true then
      raise exception '678: an empty scope did NOT verify — the gate now withholds work that finished. %', v_out;
    end if;
  end if;

  -- ── two OBSERVATIONS, reported not enforced. A claim in flight is a normal
  -- state, so raising on it would abort a legitimate migration. They exist so
  -- the evidence this fix rests on is re-measured rather than assumed. ──
  select count(*) filter (where not landed), count(*) filter (where landed)
    into v_not_landed, v_landed
    from (select (ex.decision in ('auto_executed','executed_after_approval')
                  and (coalesce(btrim(ex.receipt), '') <> '' or ex.result is not null)
                  and coalesce(ex.result #>> array['ok'], 'true') <> 'false'
                  and ex.rolled_back_at is null) as landed
            from action_executions ex where ex.resolves_task_id is not null) s;
  raise notice '678: % row(s) resolve an approval and HAVE landed (these still count as done); % row(s) resolve one and have NOT (pre-call claims, failures, voided approvals — these no longer count)', v_landed, v_not_landed;

  raise notice '678: an approval counts only when the action RETURNED — the claim taken before the call no longer closes the gate, a voided approval no longer reads as evidence, the ungated path is untouched, and mig 425''s tenant guard plus 428''s counter invariant are still pinned';
end $assert$;

commit;

notify pgrst, 'reload schema';
