-- 784_a_second_question_before_a_signature.sql
-- ==========================================================================
-- WHY: spec §3.6 — two questions, both required. Entitlement
-- (has_approval_authority, a GRANT model, deny-by-default) is UNCHANGED. This
-- adds the risk question (evaluate_authority, a RESTRICTION model,
-- escalate-only) AFTER it. Nothing is deleted.
--
-- The two models have OPPOSITE polarity: has_approval_authority DENIES a user
-- who matches no grant; evaluate_authority ALLOWS an action no rule mentions.
-- Replacing one with the other would flip deny to allow for the 18 workspaces
-- that have declared authority. So they are COMPOSED — both consulted, neither
-- authoritative over the other's question.
--
-- With authority_rules EMPTY (0 rows at time of writing) this is exactly a
-- no-op. It ships dark and begins to matter only when a workspace writes a
-- rule through set_authority_rule (mig 783).
--
-- Body generated from the live pg_get_functiondef with three anchored edits;
-- the generator REFUSES if any anchor is missing, so a concurrent session's
-- edit cannot be silently overwritten.
-- ==========================================================================

begin;

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

    IF v_risk->>'outcome' = 'deny' THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %',
        coalesce(v_risk->'reasons'->0->>'why', 'a workspace rule denies this');
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
         decision_edit        = p_edit
   WHERE id = p_task_id AND tenant_id = v_tenant AND status = 'pending'
   RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RETURN NULL; END IF;   -- already decided; caller skips hooks

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

commit;
