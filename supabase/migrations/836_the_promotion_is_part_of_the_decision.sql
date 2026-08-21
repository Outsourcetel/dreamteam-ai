-- 836_the_promotion_is_part_of_the_decision.sql
-- ============================================================================
-- BATCH-APPROVING A TRUST PROMOTION PROMOTED NOBODY, AND SAID "APPROVED".
--
-- Found by code review, 2026-08-21. Traced and re-verified against live
-- pg_proc before this file was written, not taken from the report:
--
--   * public.decide_human_tasks (mig 795) loops over public.decide_human_task
--     once per id -- correctly, deliberately, so every guard still fires.
--   * public.decide_human_task carried NO TRUST REFERENCE AT ALL. Measured:
--       select pg_get_functiondef(oid) ~* 'trust' from pg_proc ... -> false
--     for decide_human_task, decide_human_tasks AND preview_decide_human_tasks.
--   * public.apply_trust_promotion had exactly one caller in the entire
--     system, and it was in the BROWSER -- src/lib/customerApi.ts hook #4,
--     reached only by the single-task decide path.
--
-- So the batch path closed the task as approved, left
-- trust_policies.pending_task_id and pending_evidence pointing at a task that
-- was no longer pending, wrote no trust_promoted audit event, moved
-- current_level not at all -- and the UI said "Approved 1 task."
-- preview_decide_human_tasks reported the same task as approvable, because it
-- runs the same decide_human_task and inherited the same blindness.
--
-- A second defect in the same hook: it DISCARDED apply_trust_promotion's
-- return value, and that RPC refuses in its PAYLOAD with an HTTP 200
-- ({"applied": false, "reason": "no_pending_policy"}), so even the single-task
-- path could close a task as approved and promote nobody.
--
-- ============================================================================
-- THE HARD PART: COMPOSING WITH MIGRATION 837
-- ============================================================================
-- 837 landed on main while this was being built, and it is not a bystander --
-- it rewrites apply_trust_promotion. Its fix was to stop RAISING on a
-- self-approval or a stale request, because the raise aborted the very
-- audit row that recorded the refusal, and to re-establish the throw in
-- src/lib/trustApi.ts. Its stated rationale:
--
--   "The raise was never buying atomicity: decide_human_task is a SEPARATE
--    RPC in a SEPARATE transaction that has already committed the task
--    decision by the time this hook runs."
--
-- This migration makes that sentence false. Once the promotion runs inside
-- decide_human_task, the raise buys atomicity and nothing else does.
--
-- So the two fixes want opposite things, and Postgres will not give both on
-- one transaction -- 837's own header proves it: a plpgsql exception rolls
-- back to the savepoint taken BEFORE the audit write, always. Raise and the
-- refusal leaves no record; return and the task closes having promoted
-- nobody.
--
-- ⛔ THE OBVIOUS COMPROMISES WERE BOTH REJECTED.
--   * "Raise anyway, accept the lost record." Closes this defect and quietly
--     undoes 837 the same week it shipped -- and after mig 828 (applied
--     today) the self-approval arm is reachable for the first time, so the
--     record it loses is not hypothetical.
--   * "Keep the apply in the client so 837 is untouched." Leaves the torn
--     write on the single-task path and leaves withdraw_human_task stranding
--     policies. No UI-level exclusion can reach either.
--
-- ── WHAT IS DONE INSTEAD: THE REFUSAL COMMITS, AND THE TASK STAYS OPEN ─────
-- The promotion is attempted BEFORE the task is closed, not after. If it
-- refuses, decide_human_task does not raise and does not close the task. It
-- records the refusal ON THE TASK, appends its own audit event, and RETURNS
-- THE STILL-PENDING ROW. The transaction commits, so 837's record survives
-- and so does this one -- and the task is still sitting in the queue, which
-- was the whole complaint.
--
-- That is a THIRD RETURN STATE, and this file pays for it in full rather than
-- leaving callers to guess:
--
--   row with status = p_decision   the decision went through
--   row with status <> p_decision  REFUSED. Nothing closed. refusal_reason
--                                  says why. (new)
--   NULL                           already decided, or a first approval was
--                                  recorded and a second approver is needed
--                                  (unchanged, and deliberately NOT reused --
--                                  both of its meanings are already
--                                  overloaded, and a batch that reported a
--                                  refusal as "a second approver is required"
--                                  would be a new lie replacing an old one)
--
-- Every delegating caller is updated in this same migration, because a
-- contract with one updated reader is not a contract:
--   decide_human_tasks          counts a refusal as failed, with the reason
--   preview_decide_human_tasks  reports it as a refusal, not a success
--   withdraw_human_task         does not stamp disposition on a task that
--                               was never actually rejected
-- and src/lib/customerApi.ts stops claiming the decision was made.
--
-- ── WHY THE PRE-FLIGHT IS NOT THE "TWO PATHS, ONE COUNTED" TRAP ────────────
-- 837 rejected "split the check so the audit write commits first" because it
-- makes the recording step a separate callable the enforcement does not
-- depend on. This is not that. There is still exactly ONE call to
-- apply_trust_promotion, it is still the thing that decides, and the decision
-- is downstream of it. Nothing can be skipped to get past it: skip it and the
-- task is never closed at all.
--
-- ── BOTH SHAPES OF REFUSAL ARE HANDLED, BECAUSE 837 IS NOT APPLIED YET ─────
-- Measured, not assumed: the ledger's newest row is 835, and 837 is committed
-- and pushed but UNAPPLIED. So production today still runs mig 749's
-- apply_trust_promotion, which RAISES on self-approval and staleness, while
-- the same file on main returns {"ok": false}. This migration must be correct
-- on both, and is: the call sits in a BEGIN...EXCEPTION, so a raise is caught
-- and becomes a refusal reason, and the payload is read for the same thing.
-- Neither shape can close the task. Applying 837 later changes which arm
-- fires and nothing else.
--
-- ── THE CALL SITES, ENUMERATED BEFORE CHANGING IT ──────────────────────────
-- Greps for CALLS, not definitions (CLAUDE.md), across SQL and TypeScript:
--
--   SQL (pg_get_functiondef ~ 'decide_human_task\s*\('), 3 -- all updated here:
--     decide_human_tasks           mig 795
--     preview_decide_human_tasks   mig 795
--     withdraw_human_task          migs 790/794/798
--   TypeScript, 4 modules:
--     src/lib/customerApi.ts:827         the ops queue + the mobile shell
--     src/lib/browserOperatorApi.ts:132
--     src/lib/onboardingArchitectApi.ts:65
--     src/lib/playbookBuilderApi.ts:910
--   scripts/golden-path.mjs:222, scripts/anon-probe.mjs:56,
--   tests/approval-learning-capture.test.ts,
--   tests/draft-delivery-consequence.test.ts
--
-- Only customerApi ever decides a trust_promotion; the other three pass ids
-- from their own domains, and the three of them read the return the same way
-- (a non-null id means decided). The new state is gated on the task TYPE, so
-- for every one of the other ten types those readers are provably unaffected:
-- the type test is false, the refusal branch is unreachable, and the returned
-- row's status equals the decision exactly as it always did.
--
-- ── WHY THE PREVIEW STILL TELLS THE TRUTH ──────────────────────────────────
-- Load-bearing, because mig 795's preview runs the REAL decide_human_task and
-- then raises to roll it back, and its header states the precondition: nothing
-- in that call may escape a rollback. Re-verified for the chain this migration
-- adds -- apply_trust_promotion, trust_evidence_for, trust_apply_level,
-- trust_ladder_settings, append_audit_event, and all 10 non-internal triggers
-- on trust_policies, de_autonomy and audit_events: pg_notify false, net.http
-- false, dblink false, pg_background false, across every one of them.
--
-- ⚠ AND THE REFUSAL RECORD IS ROLLED BACK BY THE PREVIEW TOO, on purpose. A
-- preview that left a durable "refused" mark would be writing, which is the
-- one thing it promises not to do. The preview reports the refusal in its
-- return value instead, which is what it is for.
--
-- ── GRANTS ON THE NEW COLUMNS, AND A CLAIM THIS FILE GOT WRONG FIRST ───────
-- ⚠ CORRECTED BEFORE SHIPPING, recorded rather than quietly deleted. An
-- earlier draft of this header asserted that human_tasks carries COLUMN-LEVEL
-- grants -- 36 of them, one per column -- and therefore that a new column is
-- invisible until granted by name. That was read out of
-- information_schema.column_privileges, which EXPANDS a table-level grant into
-- one row per column and so cannot tell the two apart. The migration's own
-- grant assertion failed on the dry run, which is what sent someone to look at
-- the real ACLs:
--
--   pg_class.relacl  -> {postgres=arwdDxtm/postgres, anon=rxtm/postgres,
--                        authenticated=arwxtm/postgres, service_role=…}
--   pg_attribute.attacl for every column -> NULL
--
-- So the grants are TABLE-LEVEL and there are no column ACLs at all. The three
-- new columns inherit SELECT (and UPDATE) for `authenticated` automatically,
-- and an explicit `grant select (…)` would be a no-op that implied a
-- protection this table does not have. It is not issued. The assertion below
-- was rewritten to check what is actually load-bearing -- that the reason is
-- READABLE -- rather than a property that was never true.
--
-- ⚠ WHAT THIS MEANS, STATED RATHER THAN PAPERED OVER. `authenticated` holds
-- table-level UPDATE on human_tasks, so a client can in principle clear its
-- own refusal_reason, exactly as it can already clear decision_note or
-- disposition. What it cannot touch is the audit event: audit_events carries
-- audit_events_no_update_delete and the hash chain, so the governance record
-- of the refusal is tamper-evident even if the convenience field on the task
-- is wiped. Narrowing this table to column-level grants would mean revoking a
-- table-level UPDATE that every other writer on human_tasks depends on -- a
-- change to a shared table far outside this fix. Named, not done.
--
-- ── WHAT CHANGES FOR SOMEONE PRESSING APPROVE ──────────────────────────────
-- Measured on production before writing this:
--   trust_promotion tasks: 1, pending, pointer intact, 0 stranded, 0 ever
--   decided. trust_policies with a human requester: 0 of 58 -- though mig 828
--   (applied today at 11:15) is the first writer that sets requested_by, so
--   the self-approval arm becomes reachable from now on.
-- Nothing decidable today becomes undecidable. A promotion that cannot be
-- applied now leaves the task in the queue with a reason on it, instead of
-- closing it and reporting success.
--
-- ── NOT FIXED HERE, NAMED SO IT IS NOT LOST ────────────────────────────────
-- scripts/audit-silent-refusals.mjs reported 0 findings against the PRE-836
-- client -- it never saw hook #4 discarding apply_trust_promotion's payload,
-- although that is precisely the class it hunts. Verified by running it
-- against the old file. The auditor has a blind spot; naming it, not widening
-- into it.
-- ============================================================================

begin;

-- ── 1. THE REFUSAL HAS SOMEWHERE TO LIVE ──────────────────────────────────
-- On the task, not only in audit_events, for two reasons: the person looking
-- at the queue is looking at the task, and the batch verb gets the reason back
-- in the composite it already receives instead of needing a second read.
alter table public.human_tasks
  add column if not exists refusal_reason text,
  add column if not exists refused_at     timestamptz,
  add column if not exists refused_by     uuid;

comment on column public.human_tasks.refusal_reason is
  'Why the last attempt to DECIDE this task was refused by the server, with the '
  'task left open. Set by decide_human_task and cleared the moment a decision '
  'succeeds. NULL means no attempt has been refused -- never that none could be.';

-- ── 2. THE DECISION, WITH THE PROMOTION INSIDE IT ─────────────────────────
-- Body is migration 786's, byte-for-byte, plus the block marked "mig 836" and
-- three declared variables. CREATE OR REPLACE (never DROP + CREATE): it
-- preserves owner and grants, and this function is granted to authenticated.
CREATE OR REPLACE FUNCTION public.decide_human_task(p_task_id uuid, p_decision text, p_reason_code text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_edit jsonb DEFAULT NULL::jsonb)
 RETURNS human_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_task   human_tasks;
  v_row    human_tasks;
  v_cat    text;
  v_amt    bigint;
  v_auth   jsonb;
  v_risk jsonb;
  v_trust   jsonb;   -- mig 836
  v_refusal text;    -- mig 836
BEGIN
  perform set_config('app.allow_task_decision', 'on', true);   -- mig 486: sanctioned decision path
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'decision must be approved or rejected';
  END IF;
  -- A rejection with no reason teaches nothing. This is the one place the
  -- friction is worth it; a clean approval needs no code.
  IF p_decision = 'rejected' AND coalesce(btrim(p_reason_code), '') = '' THEN
    RAISE EXCEPTION 'reason_required: a rejection must carry a reason code';
  END IF;

  SELECT * INTO v_task FROM human_tasks WHERE id = p_task_id AND tenant_id = v_tenant;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task_not_found'; END IF;

  -- DE scoping (mig 385). Null-tolerant, matching the mig-386/452 policies:
  -- an unattributed task is decidable by the whole workspace, exactly as it is
  -- visible to them. A bare guard here would be stricter than the table.
  IF v_task.de_id IS NOT NULL AND NOT public.can_access_de(v_task.de_id) THEN
    RAISE EXCEPTION 'not_responsible_for_de: this employee is not in your reporting line';
  END IF;

  -- ── mig 593: AUTHORITY ──────────────────────────────────
  -- Everything above answers "may you SEE this?". Nothing has ever asked
  -- "are you entitled to SIGN it?" — a PKR 45,000 credit hold and a five
  -- pound refund passed the identical test, and 238 of 320 pending items
  -- name no employee at all, so the scoping clause never even bit.
  --
  -- REJECTIONS ARE DELIBERATELY NOT GATED. Declining is the conservative
  -- direction, and a rule that stops someone saying "no" is not an
  -- authority model, it is a way of forcing things through.
  IF p_decision = 'approved' THEN
    SELECT category, amount_cents INTO v_cat, v_amt FROM task_approval_facts(p_task_id);
    v_auth := has_approval_authority(auth.uid(), v_tenant, v_cat, v_amt);

    IF NOT coalesce((v_auth->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %', v_auth->>'reason';
    END IF;

    -- ── THE SECOND QUESTION (spec §3.6) ──────────────────────────────────
    -- Entitlement above answered "may you sign this at all?" — a property of
    -- a PERSON, deny-by-default, because the absence of a grant means nobody
    -- gave you that authority. This asks "does this action need more
    -- scrutiny?" — a property of an ACTION, escalate-only, because the
    -- absence of a restriction means nobody said it was dangerous.
    -- Composed, never merged: the two models have OPPOSITE polarity, and
    -- replacing one with the other would flip deny to allow for every
    -- workspace that has declared authority.
    --
    -- With authority_rules EMPTY this is exactly a no-op, which is the point:
    -- it ships dark and begins to matter only when someone writes a rule.
    v_risk := evaluate_authority(v_tenant, 'user', auth.uid(), v_cat,
                                 case when v_amt is null then '{}'::jsonb
                                      else jsonb_build_object('amount_cents', v_amt) end);

    -- A NULL RESULT IS NOT PERMISSION. `NULL = 'deny'` evaluates to NULL,
    -- not false, so without this guard a null risk result would fall straight
    -- through the test below into an approval. Same polarity error the rest
    -- of this model exists to prevent.
    IF v_risk IS NULL THEN
      RAISE EXCEPTION 'authority_evaluator_unavailable: refusing rather than approving unchecked';
    END IF;

    IF v_risk->>'outcome' = 'deny' THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %',
        coalesce(v_risk->'reasons'->0->>'why', 'a workspace rule denies this');
    END IF;

    -- THE HOLE MIGRATION 786 EXISTS TO CLOSE.
    --
    -- evaluate_authority downgrades a rule it could not CHECK to
    -- `require_human`, because it cannot know whether the rule would have
    -- tripped. That is right for a require_human rule. It was catastrophic
    -- for a `deny` rule: require_human is deliberately treated as already
    -- satisfied here (a human IS approving), so a workspace's `deny` turned
    -- into an approval the moment its measure went unreported. Measured when
    -- this was found: 409 of 412 pending approvals report no amount_cents,
    -- so the unmeasured case was the normal case, not the corner.
    --
    -- The evaluator now carries the DECLARED outcome as `rule_outcome`. A
    -- deny we could not verify refuses. "We could not tell" must never be
    -- spelled the same way as "permitted".
    IF v_risk->'reasons' @> '[{"rule_outcome": "deny", "unverified": true}]'::jsonb THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %',
        coalesce(
          (select x->>'why' from jsonb_array_elements(v_risk->'reasons') x
            where x->>'rule_outcome' = 'deny' and (x->>'unverified')::boolean limit 1),
          'a workspace rule denies this, and the measure it depends on was not reported');
    END IF;

    -- ⚠ require_human is ALREADY SATISFIED on this path — a human IS
    -- approving. Treating it as a refusal would make every unmeasured rule
    -- block every approval. The outcomes that bite here are `deny` above and
    -- `require_second_approver`, which is OR-ed into the existing needs_second
    -- below rather than replacing it: a second pair of eyes required by
    -- EITHER the grant model or a risk rule is still a second pair of eyes.

    -- A second pair of eyes. The first approval is RECORDED and the task
    -- stays pending; it completes when a DIFFERENT person approves.
    -- Recording rather than refusing is what stops the first approver
    -- having to remember they already looked at it.
    IF (coalesce((v_auth->>'needs_second')::boolean, false)
        OR v_risk->>'outcome' = 'require_second_approver')
       AND (v_task.first_approver_id IS NULL OR v_task.first_approver_id = auth.uid()) THEN
      UPDATE human_tasks
         SET first_approver_id = auth.uid(), first_approved_at = now(), updated_at = now()
       WHERE id = p_task_id AND status = 'pending';
      RETURN NULL;   -- contract: NULL means the caller MUST skip its hooks
    END IF;
  END IF;

  -- ══ mig 836: THE PROMOTION IS PART OF THE DECISION ═══════════════════════
  -- BEFORE the close, never after. If this refuses, the task must not be
  -- closed, and the refusal must SURVIVE -- and a raise cannot do both (see
  -- this migration's header, and 837's). So it returns instead.
  --
  -- Gated on the task type, so this whole block is unreachable for the other
  -- ten types and their callers see the contract they always saw.
  IF v_task.type = 'trust_promotion' THEN
    -- Re-read under a row lock. Everything below commits, so a concurrent
    -- session must not be able to slip a decision in between the promotion
    -- and the close -- which would promote against a task somebody else had
    -- already closed.
    SELECT * INTO v_task FROM human_tasks
     WHERE id = p_task_id AND tenant_id = v_tenant FOR UPDATE;
    IF v_task.status IS DISTINCT FROM 'pending' THEN
      RETURN NULL;   -- already decided; unchanged contract, caller skips hooks
    END IF;

    BEGIN
      v_trust := public.apply_trust_promotion(p_task_id, p_decision);

      IF p_decision = 'approved' THEN
        -- Nothing but applied:true means a level actually moved.
        IF NOT coalesce((v_trust->>'applied')::boolean, false) THEN
          v_refusal := coalesce(v_trust->>'message', v_trust->>'reason',
                                'apply_trust_promotion refused without saying why');
        END IF;
      ELSE
        -- On a rejection applied is ALWAYS false and that is the success
        -- case, so the reason carries the meaning. Two are legitimate:
        --   'rejected'          the policy was found and released
        --   'no_pending_policy' nothing left to release -- the task is being
        --                       cleaned up and "do not promote" has been
        --                       honoured either way. Refusing this would trap
        --                       a stranded task open forever.
        -- Anything else means we do not know what happened, so we refuse. A
        -- future third false reason fails loudly instead of passing silently.
        IF coalesce(v_trust->>'reason', '') NOT IN ('rejected', 'no_pending_policy') THEN
          v_refusal := coalesce(v_trust->>'message', v_trust->>'reason',
                                'apply_trust_promotion refused without saying why');
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- THE PRE-837 SHAPE. Until 837 is applied, apply_trust_promotion RAISES
      -- on a self-approval and on stale evidence. Caught here so that shape
      -- lands in exactly the same place as the payload shape: the savepoint
      -- unwinds whatever that call wrote, the reason survives in a plpgsql
      -- variable, and the task still does not close. This block is what makes
      -- the migration correct regardless of whether 837 is applied first.
      v_refusal := sqlerrm;
    END;

    IF v_refusal IS NOT NULL THEN
      -- ⚠ status, decided_by and decided_at are NOT touched. That is what
      -- keeps guard_human_task_decision (mig 486) quiet, and it is the
      -- point: nothing was decided.
      UPDATE human_tasks
         SET refusal_reason = v_refusal,
             refused_at     = now(),
             refused_by     = auth.uid(),
             updated_at     = now()
       WHERE id = p_task_id AND tenant_id = v_tenant;

      -- The governance record, on the same transaction as the refusal, so it
      -- commits with it. 'approval' is constraint-legal against
      -- audit_events_category_check (checked, not assumed).
      PERFORM append_audit_event(
        v_tenant,
        coalesce((SELECT full_name FROM profiles WHERE user_id = auth.uid()), 'An approver'),
        'human',
        format('Task NOT %s — %s: %s', p_decision, v_task.title, v_refusal),
        'approval',
        jsonb_build_object(
          'kind', 'human_task_decision_refused', 'task_id', p_task_id,
          'task_type', v_task.type, 'decision', p_decision,
          'refusal_reason', v_refusal, 'de_id', v_task.de_id,
          'related_table', v_task.related_table, 'related_id', v_task.related_id));

      SELECT * INTO v_row FROM human_tasks WHERE id = p_task_id AND tenant_id = v_tenant;
      RETURN v_row;   -- status is still 'pending' <> p_decision. See the header.
    END IF;
  END IF;

  -- ⚠ The pending-only clause is the double-approval guard the caller depends
  -- on. No row back means "already decided" and the caller MUST skip its side
  -- effects (invoice send, gated-action execute, write-backs). Do not relax.
  UPDATE human_tasks
     SET status               = p_decision,
         decided_by           = auth.uid(),
         decided_at           = now(),
         updated_at           = now(),
         decision_reason_code = nullif(btrim(p_reason_code), ''),
         decision_note        = nullif(btrim(p_note), ''),
         decision_edit        = p_edit,
         -- mig 836: an earlier refusal is history the moment one succeeds.
         refusal_reason       = NULL,
         refused_at           = NULL,
         refused_by           = NULL
   WHERE id = p_task_id AND tenant_id = v_tenant AND status = 'pending'
   RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    -- mig 836: for a trust_promotion this is unreachable -- the row is held
    -- FOR UPDATE above and was pending then. If it ever happens the
    -- promotion has already been applied and the close did not stick, and
    -- committing that would be the original defect with the halves swapped.
    -- Raise so the promotion goes back with it.
    IF v_task.type = 'trust_promotion' THEN
      RAISE EXCEPTION 'decision_lost_after_promotion: task % was promoted but could not be closed; refusing to commit half a decision', p_task_id;
    END IF;
    RETURN NULL;   -- already decided; caller skips hooks
  END IF;

  -- Governance record. 'approval' is constraint-legal (checked against
  -- audit_events_category_check); p_category is NOT normalised by
  -- append_audit_event, so an invented category would raise and abort the
  -- decision — the mig-429 lesson.
  PERFORM append_audit_event(
    v_tenant,
    coalesce((SELECT full_name FROM profiles WHERE user_id = auth.uid()), 'An approver'),
    'human',
    format('Task %s: %s%s', p_decision, v_row.title,
           CASE WHEN p_reason_code IS NOT NULL THEN ' (' || p_reason_code || ')' ELSE '' END),
    'approval',
    jsonb_build_object(
      'kind', 'human_task_decision', 'task_id', p_task_id, 'task_type', v_row.type,
      'decision', p_decision, 'reason_code', nullif(btrim(p_reason_code), ''),
      'de_id', v_row.de_id, 'edited', (p_edit IS NOT NULL),
      'related_table', v_row.related_table, 'related_id', v_row.related_id));

  RETURN v_row;
END $function$
;

-- ── 3. THE BATCH VERB READS THE THIRD STATE ───────────────────────────────
-- Body is mig 795's, plus the refusal branch. Still one decide_human_task
-- call per id; still no decision rule re-implemented here.
CREATE OR REPLACE FUNCTION public.decide_human_tasks(p_task_ids uuid[], p_decision text, p_reason_code text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id     uuid;
  v_ok     int := 0;
  v_failed jsonb := '[]'::jsonb;
  v_row    human_tasks;
  v_title  text;
begin
  if p_task_ids is null or array_length(p_task_ids, 1) is null then
    return jsonb_build_object('decided', 0, 'failed', v_failed);
  end if;
  -- Same 500 cap as withdraw_human_tasks, for the same reason: a UI bug must
  -- not be able to clear a whole workspace's queue in one call.
  if array_length(p_task_ids, 1) > 500 then
    raise exception 'too_many: decide at most 500 tasks at a time (got %)', array_length(p_task_ids, 1);
  end if;

  foreach v_id in array p_task_ids loop
    select title into v_title from human_tasks where id = v_id;
    begin
      v_row := public.decide_human_task(v_id, p_decision, p_reason_code, p_note);
      -- NULL is not failure here. decide_human_task returns NULL on the
      -- first-approver path: the approval was RECORDED and the task stays
      -- pending until a different person signs. Reporting that as an error
      -- would teach people to press it twice.
      if v_row.id is null then
        v_failed := v_failed || jsonb_build_object(
          'id', v_id, 'title', coalesce(v_title, '(untitled)'),
          'error', 'first_approval_recorded: a second approver is required');
      elsif v_row.status is distinct from p_decision then
        -- mig 836: THE THIRD STATE. A row came back but the task was NOT
        -- closed -- the server refused and said why on the row. This is not
        -- an exception, so the refusal it recorded COMMITS with the rest of
        -- the batch; counting it as decided would be the exact lie this
        -- migration exists to remove.
        v_failed := v_failed || jsonb_build_object(
          'id', v_id, 'title', coalesce(v_title, '(untitled)'),
          'error', coalesce(v_row.refusal_reason,
                            format('refused: the task is still %s', v_row.status)));
      else
        v_ok := v_ok + 1;
      end if;
    exception when others then
      v_failed := v_failed || jsonb_build_object(
        'id', v_id, 'title', coalesce(v_title, '(untitled)'), 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('decided', v_ok, 'failed', v_failed);
end
$function$
;

-- ── 4. THE PREVIEW READS IT TOO ───────────────────────────────────────────
-- ⚠ mig 795's version used `perform`, which DISCARDS the return. Under the
-- new contract that would count a refusal as "would succeed" -- the preview
-- would go on telling people a promotion is approvable when it is not, which
-- is one of the three things this migration was reported for.
CREATE OR REPLACE FUNCTION public.preview_decide_human_tasks(p_task_ids uuid[], p_decision text, p_reason_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id      uuid;
  v_ok      int := 0;
  v_refuse  jsonb := '[]'::jsonb;
  v_title   text;
  v_prow    human_tasks;
  -- mig 836: the verdict has to travel OUT through the raise, because the
  -- raise is what undoes the trial decision. A plpgsql variable assigned
  -- inside the block survives the unwind, but only the message is guaranteed
  -- to reach the handler, so the reason rides on it behind a sentinel prefix.
  v_why     text;
begin
  if p_task_ids is null or array_length(p_task_ids, 1) is null then
    return jsonb_build_object('would_succeed', 0, 'would_refuse', 0, 'refusals', v_refuse);
  end if;
  if array_length(p_task_ids, 1) > 500 then
    raise exception 'too_many: preview at most 500 tasks at a time (got %)', array_length(p_task_ids, 1);
  end if;

  foreach v_id in array p_task_ids loop
    select title into v_title from human_tasks where id = v_id;
    begin
      v_prow := public.decide_human_task(v_id, p_decision, p_reason_code, '__preview__');
      if v_prow.id is not null and v_prow.status is distinct from p_decision then
        -- mig 836: refused, and the trial write must still be undone. The
        -- refusal record decide_human_task just made is rolled back with
        -- everything else -- a preview does not write, not even a refusal.
        raise exception using errcode = 'P0001',
          message = '__PREVIEW_WOULD_REFUSE__' || coalesce(v_prow.refusal_reason, 'refused without a reason');
      end if;
      -- Reaching this line means the decision WOULD go through. Undo it: the
      -- raise rolls this block back to where it started.
      raise exception using errcode = 'P0001', message = '__PREVIEW_WOULD_SUCCEED__';
    exception when others then
      if sqlerrm = '__PREVIEW_WOULD_SUCCEED__' then
        v_ok := v_ok + 1;
      elsif sqlerrm like '__PREVIEW_WOULD_REFUSE__%' then
        v_why := substr(sqlerrm, length('__PREVIEW_WOULD_REFUSE__') + 1);
        v_refuse := v_refuse || jsonb_build_object(
          'id', v_id, 'title', coalesce(v_title, '(untitled)'), 'why', v_why);
      else
        v_refuse := v_refuse || jsonb_build_object(
          'id', v_id, 'title', coalesce(v_title, '(untitled)'), 'why', sqlerrm);
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'would_succeed', v_ok,
    'would_refuse',  jsonb_array_length(v_refuse),
    'refusals',      v_refuse);
end
$function$
;

-- ── 5. WITHDRAWAL MUST NOT STAMP A TASK THAT WAS NEVER REJECTED ───────────
-- Body is the live mig 790/794/798 version, plus the refusal branch. Without
-- it, withdrawing a trust_promotion the server refused would mark
-- disposition='cancelled' on a task still sitting at 'pending' -- excluded
-- from the approval-rate denominator while still demanding a decision.
CREATE OR REPLACE FUNCTION public.withdraw_human_task(p_task_id uuid, p_note text DEFAULT NULL::text)
 RETURNS human_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- ⚠ 'other', not 'withdrawn'. See mig 798's header: 'withdrawn' is
  -- not admitted by human_tasks_decision_reason_code_check and never was, so
  -- every call raised 23514 from 790 until then. The withdrawal stays findable
  -- through disposition='cancelled' plus a non-null reason code, which the
  -- sweeps do not write.
  v_row := public.decide_human_task(p_task_id, 'rejected', 'other', p_note);

  -- NULL composite = already decided.
  if v_row.id is null then
    return null;
  end if;

  -- mig 836: THE THIRD STATE. A row with a status that is not 'rejected'
  -- means the server refused and left the task open. Returning it unstamped
  -- is the honest answer -- the caller can read refusal_reason. Stamping
  -- disposition here would take the task out of the approval-rate denominator
  -- while it is still, in fact, waiting for a decision.
  if v_row.status is distinct from 'rejected' then
    return v_row;
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
$function$
;

-- ============================================================================
-- PROOF -- and it must be able to FAIL, or it is theatre.
--
-- The load-bearing arms are REFUSE and DURABLE. Before this migration,
-- driving a trust_promotion whose policy pointer is gone through
-- decide_human_tasks returned {"decided": 1, "failed": []}, closed the task as
-- 'approved' and left an approval audit row behind. Under the rejected
-- "raise anyway" compromise it would have refused correctly but left NO
-- record. Both are asserted against STORED STATE, so either regression fails
-- here.
--
-- ALLOW is not optional either: a refusal arm alone would pass just as well if
-- trust_promotion had simply become undecidable, which is a different bug
-- wearing this fix's clothes.
--
-- EVERY ARM GOES THROUGH THE REAL DELEGATING VERB -- decide_human_tasks,
-- preview_decide_human_tasks, withdraw_human_task -- never through
-- decide_human_task directly. Testing the inner function would have proven
-- the fix on the one path that never needed it.
--
-- DENOMINATOR. 11 schema assertions, comparable on ANY database these
-- functions exist on -- an empty one included -- plus 17 data assertions that
-- need a workspace with an approver who actually holds approval authority.
-- With no such workspace the data arms make ZERO comparisons and say so; the
-- 11 schema assertions still ran, so the denominator is never 0.
--
-- ROLLBACK, NOT CLEANUP. Every fixture write is undone by raising
-- '__undo_probe_836__' inside a plpgsql BEGIN...EXCEPTION block, whose
-- implicit savepoint unwinds the lot. Not by DELETE: audit_events carries
-- audit_events_no_update_delete, and flipping the purge hatch to tidy up after
-- a checker is the audit-log-rewrite anti-pattern this repo has already named
-- and rejected. Same idiom as migs 741, 830 and 837.
--
-- ⚠ ONE ESCAPE WAS CHECKED RATHER THAN ASSUMED. Inserting a pending
-- human_tasks row fires human_tasks_push_ping -> notify_pending_human_task,
-- the one trigger on that table that reaches the network, and the dispatch
-- secret it needs IS present on production, so it really does fire. Still
-- safe: net.http_post is a plpgsql function that INSERTS into
-- net.http_request_queue and returns the id, and pg_net's worker only reads
-- COMMITTED rows. The rollback discards the queued request, so no push is
-- ever sent for a fixture task.
-- ============================================================================
do $verify$
declare
  v_checks        int := 0;
  v_bad           text[] := '{}';
  v_ran           boolean := false;

  v_fn_src        text;
  v_batch_src     text;
  v_preview_src   text;
  v_withdraw_src  text;
  v_col_ok        boolean;

  v_tenant        uuid;
  v_approver      uuid;
  v_auth          jsonb;

  -- Relaxed so eligibility is DETERMINISTIC: it cannot be broken by the
  -- discovered workspace's real eval / human-review / guardrail history, nor
  -- accidentally satisfied by it. Same construction as mig 830's fixture.
  v_criteria      jsonb := jsonb_build_object(
                     'min_eval_samples', 0, 'min_eval_pass_rate', 0,
                     'min_human_samples', 0, 'min_human_approval_rate', 0,
                     'max_guardrail_blocks', 2000000000);

  v_allow_policy    uuid;
  v_refuse_policy   uuid;
  v_prev_policy     uuid;
  v_wd_policy       uuid;
  v_allow_task      uuid;
  v_refuse_task     uuid;
  v_prev_task       uuid;
  v_wd_task         uuid;
  v_policy_row      public.trust_policies;
  v_evidence        jsonb;

  v_allow_res       jsonb;
  v_refuse_res      jsonb;
  v_prev_res        jsonb;
  v_wd_row          public.human_tasks;
  v_allow_status    text;
  v_refuse_status   text;
  v_level_before    int;
  v_level_after     int;
  v_pending_after   uuid;
  v_refuse_level    int;
  v_promoted_events int;
  v_refuse_reason   text;
  v_refused_by      uuid;
  v_refusal_audit   int;
  v_close_audit     int;
  v_refuse_error    text;
  v_prev_status     text;
  v_prev_refusal    text;

  v_expected_reason text := 'no_pending_policy';
begin
  --------------------------------------------------------------------------
  -- SCHEMA ARM -- unconditional, data-independent, runs first. This is what
  -- keeps the denominator off zero on an empty database. Comments are
  -- stripped before matching so a probe cannot match its own prose (this
  -- repo's convention -- see scripts/trust-proposer-boundary.mjs).
  --------------------------------------------------------------------------
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_fn_src
    from pg_proc where pronamespace = 'public'::regnamespace and proname = 'decide_human_task';
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_batch_src
    from pg_proc where pronamespace = 'public'::regnamespace and proname = 'decide_human_tasks';
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_preview_src
    from pg_proc where pronamespace = 'public'::regnamespace and proname = 'preview_decide_human_tasks';
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_withdraw_src
    from pg_proc where pronamespace = 'public'::regnamespace and proname = 'withdraw_human_task';

  v_checks := v_checks + 1;
  if v_fn_src is null or v_fn_src !~ 'apply_trust_promotion\s*\(' then
    v_bad := array_append(v_bad, '836 SCHEMA: decide_human_task does not call apply_trust_promotion -- the promotion is back outside the decision.');
  end if;

  v_checks := v_checks + 1;
  if v_fn_src is null or v_fn_src !~ 'v_task\.type\s*=\s*''trust_promotion''' then
    v_bad := array_append(v_bad, '836 SCHEMA: decide_human_task no longer gates on v_task.type = ''trust_promotion'' -- either the gate is gone or it fires for every task type.');
  end if;

  -- The ORDER is the whole design: refuse before closing, so the refusal can
  -- commit. If the trust block ever moves after the closing UPDATE, a refusal
  -- can only be a raise again and 837's record dies with it.
  v_checks := v_checks + 1;
  if v_fn_src is null
     or position('apply_trust_promotion' in v_fn_src) = 0
     or position('SET status               = p_decision' in v_fn_src) = 0
     or position('apply_trust_promotion' in v_fn_src) > position('SET status               = p_decision' in v_fn_src) then
    v_bad := array_append(v_bad, '836 SCHEMA: apply_trust_promotion is no longer called BEFORE the closing UPDATE -- a refusal after the close cannot leave a record without raising, which is the compromise this migration exists to avoid.');
  end if;

  v_checks := v_checks + 1;
  if v_fn_src is null or v_fn_src !~ 'refusal_reason\s*=\s*v_refusal' then
    v_bad := array_append(v_bad, '836 SCHEMA: decide_human_task no longer records the refusal on the task -- the batch verb and the UI both read it from there.');
  end if;

  v_checks := v_checks + 1;
  if v_batch_src is null or v_batch_src !~ 'decide_human_task\s*\(' then
    v_bad := array_append(v_bad, '836 SCHEMA: decide_human_tasks no longer delegates to decide_human_task -- the batch path would carry none of the guards above.');
  end if;

  v_checks := v_checks + 1;
  if v_batch_src is null or v_batch_src !~ 'v_row\.status\s+is\s+distinct\s+from\s+p_decision' then
    v_bad := array_append(v_bad, '836 SCHEMA: decide_human_tasks no longer tests the returned status against the decision -- it would count a refusal as decided again.');
  end if;

  v_checks := v_checks + 1;
  if v_preview_src is null or v_preview_src !~ 'decide_human_task\s*\(' then
    v_bad := array_append(v_bad, '836 SCHEMA: preview_decide_human_tasks no longer delegates to decide_human_task.');
  end if;

  -- ⚠ `perform` DISCARDS the return. mig 795 used it, which is exactly why
  -- the preview could not see a refusal. This arm is the pin against it
  -- coming back.
  v_checks := v_checks + 1;
  if v_preview_src is null
     or v_preview_src ~ 'perform\s+public\.decide_human_task\s*\('
     or v_preview_src !~ 'v_prow\.status\s+is\s+distinct\s+from\s+p_decision' then
    v_bad := array_append(v_bad, '836 SCHEMA: preview_decide_human_tasks discards decide_human_task''s return (or no longer tests it) -- it would report a refused promotion as approvable, which is one of the three things this was reported for.');
  end if;

  v_checks := v_checks + 1;
  if v_withdraw_src is null or v_withdraw_src !~ 'decide_human_task\s*\(' then
    v_bad := array_append(v_bad, '836 SCHEMA: withdraw_human_task no longer delegates to decide_human_task -- withdrawing a trust_promotion would strand the policy again.');
  end if;

  v_checks := v_checks + 1;
  if v_withdraw_src is null or v_withdraw_src !~ 'v_row\.status\s+is\s+distinct\s+from\s+''rejected''' then
    v_bad := array_append(v_bad, '836 SCHEMA: withdraw_human_task no longer checks that the task was actually rejected -- it would stamp disposition=cancelled on a task still waiting for a decision.');
  end if;

  -- The column grant. human_tasks is granted COLUMN BY COLUMN, so a new
  -- column no user can read is a real and silent failure mode here.
  v_checks := v_checks + 1;
  select bool_and(has_column_privilege('authenticated', 'public.human_tasks', c, 'SELECT'))
    into v_col_ok
    from unnest(array['refusal_reason', 'refused_at', 'refused_by']) c;
  if not coalesce(v_col_ok, false) then
    v_bad := array_append(v_bad, '836 SCHEMA: authenticated cannot SELECT one of the refusal columns -- the reason would be invisible to the person looking at the queue, which is most of the point of recording it. See this migration''s header: the grant is inherited from the TABLE, so this fires only if someone later narrows human_tasks to column-level ACLs and forgets these three.');
  end if;

  --------------------------------------------------------------------------
  -- Discover a workspace and an approver who could really sign this. Never a
  -- hardcoded id. The authority verdict is part of the WHERE clause on
  -- purpose: an approver who would be refused by has_approval_authority or
  -- evaluate_authority would make the ALLOW arm fail for a reason that has
  -- nothing to do with this migration.
  --------------------------------------------------------------------------
  select p.tenant_id, p.user_id into v_tenant, v_approver
    from public.profiles p
    join public.tenants t on t.id = p.tenant_id
   where p.layer = 'tenant'
     and coalesce(p.is_active, true)
     and p.role in ('tenant_owner', 'tenant_admin')
     and t.status in ('active', 'trial')
     and coalesce((public.has_approval_authority(p.user_id, p.tenant_id, 'trust_promotion', null)->>'allowed')::boolean, true)
     and not coalesce((public.has_approval_authority(p.user_id, p.tenant_id, 'trust_promotion', null)->>'needs_second')::boolean, false)
     and coalesce(public.evaluate_authority(p.tenant_id, 'user', p.user_id, 'trust_promotion', '{}'::jsonb)->>'outcome', 'allow') = 'allow'
   order by p.tenant_id, p.user_id
   limit 1;

  if v_approver is not null then
    -- Become that person, then take the tenant from auth_tenant_id() rather
    -- than from the row above: that is the tenant decide_human_task will
    -- actually operate in, and for a user with profiles in more than one
    -- workspace the two can differ. Re-check authority against whichever it
    -- picked, so the fixture and the guard cannot disagree.
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_approver, 'role', 'authenticated')::text, true);
    v_tenant := public.auth_tenant_id();
    if v_tenant is not null then
      v_auth := public.has_approval_authority(v_approver, v_tenant, 'trust_promotion', null);
      if not coalesce((v_auth->>'allowed')::boolean, true)
         or coalesce((v_auth->>'needs_second')::boolean, false)
         or coalesce(public.evaluate_authority(v_tenant, 'user', v_approver, 'trust_promotion', '{}'::jsonb)->>'outcome', 'allow') <> 'allow' then
        v_tenant := null;
      end if;
    end if;
  end if;

  if v_tenant is null or v_approver is null then
    raise notice '836: VACUITY -- no workspace with an active owner/admin who holds approval authority over a trust_promotion exists on this database. The ALLOW, REFUSE, PREVIEW and WITHDRAW arms made ZERO comparisons here. That is the honest result on an empty database, not a manufactured pass: the 11 schema assertions above are data-independent and DID run.';
  else
    v_ran := true;

    begin
      ----------------------------------------------------------------------
      -- FIXTURE. Four policies in the same workspace. de_id null so no
      -- digital_employees row is needed (and none is touched -- the
      -- workforce-assistant rule cannot be brushed). action_category is a
      -- probe-only string that cannot collide with a real dial.
      -- requested_by stays NULL, the shape mig 828's writer and every earlier
      -- one pass; the human-requester case is migration 830's subject.
      -- origin = 'exercise' so evidence_is_production() is false and these
      -- rows cannot count as evidence for any OTHER policy while they exist.
      ----------------------------------------------------------------------
      insert into public.trust_policies
        (tenant_id, de_id, action_category, current_level, max_level, status, criteria)
      values (v_tenant, null, 'zz_probe_836_allow',   0, 3, 'active', v_criteria),
             (v_tenant, null, 'zz_probe_836_refuse',  0, 3, 'active', v_criteria),
             (v_tenant, null, 'zz_probe_836_preview', 0, 3, 'active', v_criteria),
             (v_tenant, null, 'zz_probe_836_wd',      0, 3, 'active', v_criteria);

      select id into v_allow_policy  from public.trust_policies where tenant_id = v_tenant and action_category = 'zz_probe_836_allow';
      select id into v_refuse_policy from public.trust_policies where tenant_id = v_tenant and action_category = 'zz_probe_836_refuse';
      select id into v_prev_policy   from public.trust_policies where tenant_id = v_tenant and action_category = 'zz_probe_836_preview';
      select id into v_wd_policy     from public.trust_policies where tenant_id = v_tenant and action_category = 'zz_probe_836_wd';

      select * into v_policy_row from public.trust_policies where id = v_allow_policy;
      v_evidence := public.trust_evidence_for(v_policy_row);

      v_checks := v_checks + 1;
      if not coalesce((v_evidence->>'eligible')::boolean, false) then
        v_bad := array_append(v_bad, format(
          '836 FIXTURE BUG: the engineered-eligible criteria did not produce eligible:true (%s) -- the ALLOW arm below would refuse for a reason that is not about this migration.',
          v_evidence->>'eligible'));
      end if;

      -- ALLOW fixture: policy and task point at each other, exactly as
      -- request_trust_promotion leaves them.
      insert into public.human_tasks
        (tenant_id, type, title, detail, source, related_table, related_id, status, origin)
      values (v_tenant, 'trust_promotion', 'Trust promotion - probe 836 (allow arm)',
              'Fixture for migration 836 -- proves the BATCH path now promotes. Rolled back before commit.',
              'system', 'trust_policies', v_allow_policy, 'pending', 'exercise')
      returning id into v_allow_task;

      update public.trust_policies
         set pending_task_id = v_allow_task, pending_evidence = v_evidence,
             requested_by = null, requested_at = now()
       where id = v_allow_policy;

      -- REFUSE / PREVIEW / WITHDRAW fixtures: THE STRANDED SHAPE, reproduced
      -- faithfully. The task still names its policy via related_id, but the
      -- policy's pending_task_id does NOT point back -- precisely the state
      -- this defect left behind, and what apply_trust_promotion reports as
      -- no_pending_policy (it looks the policy up BY pending_task_id).
      insert into public.human_tasks
        (tenant_id, type, title, detail, source, related_table, related_id, status, origin)
      values (v_tenant, 'trust_promotion', 'Trust promotion - probe 836 (refuse arm)',
              'Fixture for migration 836 -- a trust_promotion whose policy pointer is gone. Rolled back before commit.',
              'system', 'trust_policies', v_refuse_policy, 'pending', 'exercise')
      returning id into v_refuse_task;

      insert into public.human_tasks
        (tenant_id, type, title, detail, source, related_table, related_id, status, origin)
      values (v_tenant, 'trust_promotion', 'Trust promotion - probe 836 (preview arm)',
              'Fixture for migration 836 -- the preview must call this a refusal. Rolled back before commit.',
              'system', 'trust_policies', v_prev_policy, 'pending', 'exercise')
      returning id into v_prev_task;

      insert into public.human_tasks
        (tenant_id, type, title, detail, source, related_table, related_id, status, origin)
      values (v_tenant, 'trust_promotion', 'Trust promotion - probe 836 (withdraw arm)',
              'Fixture for migration 836 -- a refused withdrawal must not be stamped cancelled. Rolled back before commit.',
              'system', 'trust_policies', v_wd_policy, 'pending', 'exercise')
      returning id into v_wd_task;

      ----------------------------------------------------------------------
      -- ALLOW ARM -- through the batch verb.
      ----------------------------------------------------------------------
      select current_level into v_level_before from public.trust_policies where id = v_allow_policy;
      v_allow_res := public.decide_human_tasks(array[v_allow_task], 'approved', null, null);

      select current_level, pending_task_id into v_level_after, v_pending_after
        from public.trust_policies where id = v_allow_policy;
      select status into v_allow_status from public.human_tasks where id = v_allow_task;
      select count(*) into v_promoted_events
        from public.audit_events
       where tenant_id = v_tenant
         and detail->>'kind' = 'trust_promoted'
         and detail->>'policy_id' = v_allow_policy::text;

      v_checks := v_checks + 1;
      if coalesce((v_allow_res->>'decided')::int, -1) <> 1 then
        v_bad := array_append(v_bad, format('836 ALLOW: batch reported decided=%s (expected 1). Full result: %s', v_allow_res->>'decided', v_allow_res));
      end if;

      v_checks := v_checks + 1;
      if coalesce(jsonb_array_length(v_allow_res->'failed'), -1) <> 0 then
        v_bad := array_append(v_bad, format('836 ALLOW: batch reported %s failure(s) on a promotion that should have gone through: %s', jsonb_array_length(v_allow_res->'failed'), v_allow_res->'failed'));
      end if;

      v_checks := v_checks + 1;
      if v_level_after is distinct from v_level_before + 1 then
        v_bad := array_append(v_bad, format('836 ALLOW: current_level went %s -> %s (expected +1) -- the batch said yes and promoted nobody, which is the defect this migration exists to close.', v_level_before, v_level_after));
      end if;

      v_checks := v_checks + 1;
      if v_pending_after is not null then
        v_bad := array_append(v_bad, format('836 ALLOW: pending_task_id is still %s after the decision -- the policy is stranded on a task that is no longer pending.', v_pending_after));
      end if;

      v_checks := v_checks + 1;
      if v_allow_status is distinct from 'approved' then
        v_bad := array_append(v_bad, format('836 ALLOW: the task is %s, not approved -- the promotion applied but the decision did not stick.', v_allow_status));
      end if;

      v_checks := v_checks + 1;
      if v_promoted_events <> 1 then
        v_bad := array_append(v_bad, format('836 ALLOW: %s trust_promoted audit event(s) for this policy (expected exactly 1) -- a promotion the governance trail cannot show did not happen as far as a buyer''s diligence is concerned.', v_promoted_events));
      end if;

      ----------------------------------------------------------------------
      -- REFUSE ARM -- same batch verb, same workspace, same approver. The
      -- ONLY difference is that the policy pointer is gone.
      ----------------------------------------------------------------------
      v_refuse_res := public.decide_human_tasks(array[v_refuse_task], 'approved', null, null);

      select status, refusal_reason, refused_by
        into v_refuse_status, v_refuse_reason, v_refused_by
        from public.human_tasks where id = v_refuse_task;
      select current_level into v_refuse_level from public.trust_policies where id = v_refuse_policy;
      select count(*) filter (where detail->>'kind' = 'human_task_decision_refused'),
             count(*) filter (where detail->>'kind' = 'human_task_decision')
        into v_refusal_audit, v_close_audit
        from public.audit_events
       where tenant_id = v_tenant and detail->>'task_id' = v_refuse_task::text;
      v_refuse_error := v_refuse_res->'failed'->0->>'error';

      v_checks := v_checks + 1;
      if coalesce((v_refuse_res->>'decided')::int, -1) <> 0 then
        v_bad := array_append(v_bad, format('836 REFUSE: batch reported decided=%s (expected 0) -- it closed a promotion that promoted nobody and called it a success. Full result: %s', v_refuse_res->>'decided', v_refuse_res));
      end if;

      v_checks := v_checks + 1;
      if coalesce(jsonb_array_length(v_refuse_res->'failed'), -1) <> 1 then
        v_bad := array_append(v_bad, format('836 REFUSE: batch reported %s failure(s), expected exactly 1: %s', jsonb_array_length(v_refuse_res->'failed'), v_refuse_res));
      end if;

      -- The reason must be the trust seam's, not some other refusal. A
      -- refusal for authority, DE scoping or an already-decided row would
      -- satisfy a loose test while proving nothing.
      v_checks := v_checks + 1;
      if v_refuse_error is null or position(v_expected_reason in v_refuse_error) = 0 then
        v_bad := array_append(v_bad, format('836 REFUSE: refused for the WRONG reason: %s (expected one naming %s)', coalesce(v_refuse_error, '(no error reported)'), v_expected_reason));
      end if;

      -- ⚠ INVERSION PIN 1. Before this migration this task came back
      -- 'approved'.
      v_checks := v_checks + 1;
      if v_refuse_status is distinct from 'pending' then
        v_bad := array_append(v_bad, format('836 REFUSE: the task is %s, not pending -- a task closed having promoted nobody.', v_refuse_status));
      end if;

      -- ⚠ INVERSION PIN 2 -- THE PROPERTY THE "RAISE ANYWAY" DESIGN LOSES.
      -- decide_human_tasks wraps each task in its own BEGIN...EXCEPTION, so a
      -- raised refusal would unwind this record with the savepoint and both
      -- of these would read empty. They are the whole reason the refusal
      -- returns instead of raising.
      v_checks := v_checks + 1;
      if v_refuse_reason is null or position(v_expected_reason in v_refuse_reason) = 0 then
        v_bad := array_append(v_bad, format('836 REFUSE: human_tasks.refusal_reason is %s -- the refusal did not SURVIVE the batch''s per-task savepoint, so the person looking at the queue cannot see why it would not go through.', coalesce(v_refuse_reason, 'NULL')));
      end if;

      v_checks := v_checks + 1;
      if v_refusal_audit <> 1 then
        v_bad := array_append(v_bad, format('836 REFUSE: %s human_task_decision_refused audit event(s) survive (expected exactly 1) -- a governed refusal that leaves no record is the defect migration 837 exists to prevent, reintroduced one layer up.', v_refusal_audit));
      end if;

      v_checks := v_checks + 1;
      if v_refused_by is distinct from v_approver then
        v_bad := array_append(v_bad, format('836 REFUSE: refused_by is %s, expected the approver %s -- a refusal nobody is attributed to is not a governance record.', coalesce(v_refused_by::text, 'NULL'), v_approver));
      end if;

      -- ⚠ INVERSION PIN 3. An APPROVAL audit row must NOT survive: the task
      -- was not approved. Before this migration exactly one did.
      v_checks := v_checks + 1;
      if v_close_audit <> 0 then
        v_bad := array_append(v_bad, format('836 REFUSE: %s human_task_decision audit event(s) survive for a decision that never happened -- the trail records an approval nobody made.', v_close_audit));
      end if;

      v_checks := v_checks + 1;
      if v_refuse_level is distinct from 0 then
        v_bad := array_append(v_bad, format('836 REFUSE: the policy moved to level %s -- a refused task must not touch any policy.', v_refuse_level));
      end if;

      ----------------------------------------------------------------------
      -- PREVIEW ARM -- must call it a refusal, and must still write nothing.
      ----------------------------------------------------------------------
      v_prev_res := public.preview_decide_human_tasks(array[v_prev_task], 'approved', null);
      select status, refusal_reason into v_prev_status, v_prev_refusal
        from public.human_tasks where id = v_prev_task;

      v_checks := v_checks + 1;
      if coalesce((v_prev_res->>'would_succeed')::int, -1) <> 0
         or coalesce((v_prev_res->>'would_refuse')::int, -1) <> 1 then
        v_bad := array_append(v_bad, format('836 PREVIEW: reported would_succeed=%s would_refuse=%s (expected 0 and 1) -- the preview is still telling people a refused promotion is approvable. Full result: %s',
          v_prev_res->>'would_succeed', v_prev_res->>'would_refuse', v_prev_res));
      end if;

      v_checks := v_checks + 1;
      if coalesce(v_prev_res->'refusals'->0->>'why', '') !~ v_expected_reason then
        v_bad := array_append(v_bad, format('836 PREVIEW: the refusal reason did not survive the rollback into the return value: %s', v_prev_res->'refusals'));
      end if;

      -- A preview writes NOTHING, refusal record included.
      v_checks := v_checks + 1;
      if v_prev_status is distinct from 'pending' or v_prev_refusal is not null then
        v_bad := array_append(v_bad, format('836 PREVIEW: it left a trace -- status %s, refusal_reason %s. A preview that writes is not a preview.', v_prev_status, coalesce(v_prev_refusal, 'NULL')));
      end if;

      ----------------------------------------------------------------------
      -- WITHDRAW ARM -- a refused withdrawal must not be stamped cancelled.
      -- ⚠ This arm depends on apply_trust_promotion refusing a REJECT, which
      -- it does not for no_pending_policy (deliberately -- see the function).
      -- So this drives the case that DOES apply: the withdrawal succeeds, and
      -- what is asserted is that it went through cleanly rather than being
      -- mistaken for a refusal by the new branch.
      ----------------------------------------------------------------------
      v_wd_row := public.withdraw_human_task(v_wd_task, 'probe 836');

      v_checks := v_checks + 1;
      if v_wd_row.id is null or v_wd_row.status is distinct from 'rejected' then
        v_bad := array_append(v_bad, format('836 WITHDRAW: a withdrawal that should have gone through came back %s -- the new third-state branch is swallowing ordinary withdrawals.',
          coalesce(v_wd_row.status, 'NULL')));
      end if;

      v_checks := v_checks + 1;
      if v_wd_row.disposition is distinct from 'cancelled' then
        v_bad := array_append(v_bad, format('836 WITHDRAW: disposition is %s, expected cancelled -- the withdrawal did not complete.', coalesce(v_wd_row.disposition, 'NULL')));
      end if;

      ----------------------------------------------------------------------
      -- Undo everything since the outer BEGIN. v_bad / v_checks and the
      -- captured results are plpgsql variables, not table state, and survive
      -- the unwind untouched.
      ----------------------------------------------------------------------
      raise exception using errcode = 'P0001', message = '__undo_probe_836__';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> '__undo_probe_836__' then raise; end if;
    end;
  end if;

  --------------------------------------------------------------------------
  if array_length(v_bad, 1) > 0 then
    raise exception E'836 VERIFICATION FAILED (% assertion(s) compared, tenant %):\n  %',
      v_checks, v_tenant, array_to_string(v_bad, E'\n  ');
  end if;

  if v_ran then
    raise notice '836: % assertion(s) compared, 0 findings (11 schema + 17 data). tenant=%, approver=%. ALLOW task=% result=% level %->% pending_after=% promoted_events=%. REFUSE task=% result=% status=% refusal_reason=% refused_by=% refusal_audit=% close_audit=%. PREVIEW result=% left status=% refusal=%. WITHDRAW status=% disposition=%. Every fixture write was rolled back via __undo_probe_836__. NOTE: db-query.mjs does not surface RAISE NOTICE, so this line is not visible on a real apply.',
      v_checks, v_tenant, v_approver,
      v_allow_task, v_allow_res, v_level_before, v_level_after, v_pending_after, v_promoted_events,
      v_refuse_task, v_refuse_res, v_refuse_status, v_refuse_reason, v_refused_by, v_refusal_audit, v_close_audit,
      v_prev_res, v_prev_status, v_prev_refusal,
      v_wd_row.status, v_wd_row.disposition;
  else
    raise notice '836: % assertion(s) compared, 0 findings -- SCHEMA ARM ONLY. No workspace with an authorised approver existed to drive the data arms on this dataset, so those made zero comparisons. NOT the same claim as the "11 schema + 17 data" line above.',
      v_checks;
  end if;
end;
$verify$;

commit;
