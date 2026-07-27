-- 443_exception_ruling_closes_the_loop.sql
-- ============================================================================
-- docs/31 pre-start commitment #4, part 2 (ships WITH the DeWorkbench.tsx
-- one-word fix — the UI edit alone would render Approve/Reject buttons whose
-- decisions leave 18 work items stuck forever, a worse false signal than
-- today's visible stuckness).
--
-- Deciding an exception now:
--   (A) writes the ruling to de_memory when the human ticked "remember this"
--       — the learned flag finally has an effect. Written on EITHER decision:
--       a denial ruling is exactly what stops the employee re-proposing.
--   (B) moves the paused work item: approve -> re-queued with the ruling
--       appended to payload.detail (the exact field de-work builds its LLM
--       goal from — index.ts:582 — so the ruling reaches the employee's next
--       run with zero edge-function changes); deny -> cancelled along with
--       its dependent chain (claim_de_work_items requires depends_on='done';
--       a cancelled predecessor would strand successors as invisible-stuck
--       queued rows — each of the 18 open items has exactly one, proven live).
--
-- Audit category 'approval' — verified against the LIVE
-- audit_events_category_check; 'governance' is NOT legal (the mig-429 lesson).
-- Reproduced from live pg_get_functiondef (byte-identical to mig 340's body,
-- verified 2026-07-27) — never retyped from an old migration (the 377 lesson).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.decide_de_exception(
  p_exception_id uuid, p_decision text, p_outcome text DEFAULT NULL::text, p_learned boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_row de_exceptions;
  v_de_name text;
  v_status text;
  v_memory_id uuid;
  v_item_moved uuid;
  v_instruction text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;
  IF p_decision NOT IN ('approved','rejected','denied') THEN
    RAISE EXCEPTION 'decision must be approved or rejected';
  END IF;
  v_status := CASE WHEN p_decision = 'rejected' THEN 'denied' ELSE p_decision END;
  SELECT * INTO v_row FROM de_exceptions WHERE id = p_exception_id AND tenant_id = v_tenant;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'exception_not_found'; END IF;
  IF v_row.status <> 'proposed' THEN RAISE EXCEPTION 'already_decided: %', v_row.status; END IF;
  SELECT name INTO v_de_name FROM digital_employees WHERE id = v_row.de_id;
  v_instruction := nullif(btrim(coalesce(p_outcome, '')), '');

  UPDATE de_exceptions SET
    status = v_status, outcome = p_outcome, learned = coalesce(p_learned, false),
    decided_by = auth.uid(), decided_at = now()
  WHERE id = p_exception_id;

  -- (A) "remember this" -> durable memory the employee actually recalls.
  IF coalesce(p_learned, false) THEN
    v_memory_id := de_memory_write(
      p_tenant_id    => v_tenant,
      p_de_id        => v_row.de_id,
      p_content      => left(format('Human ruling (%s): when facing "%s" the proposal was "%s".%s', v_status, v_row.situation, v_row.proposed_action, CASE WHEN v_instruction IS NOT NULL THEN ' Instruction: ' || v_instruction ELSE '' END), 2000),
      p_embedding    => NULL,             -- de_memory_search degrades to recency+salience when null
      p_subject_kind => 'general',
      p_subject_ref  => NULL,
      p_kind         => 'fact',
      p_salience     => 0.8,
      p_source       => 'human');
  END IF;

  -- (B) the paused work item moves with the decision.
  IF v_row.work_item_id IS NOT NULL THEN
    IF v_status = 'approved' THEN
      UPDATE de_work_items SET
        status = 'queued', scheduled_for = now(), attempts = 0, last_error = NULL,
        locked_at = NULL, locked_by = NULL, updated_at = now(),
        payload = payload || jsonb_build_object(
          'detail', left(coalesce(payload->>'detail','')
            || E'\n\nHUMAN RULING: your proposal for this task was APPROVED'
            || CASE WHEN v_instruction IS NOT NULL THEN '. Instruction: ' || v_instruction ELSE '' END
            || '. Approved proposal: "' || left(v_row.proposed_action, 400)
            || '". Carry it out now; do not raise this same exception again.', 4000),
          'human_ruling', jsonb_build_object('exception_id', p_exception_id,
            'decision', v_status, 'outcome', p_outcome, 'decided_at', now()))
      WHERE id = v_row.work_item_id AND tenant_id = v_tenant AND status = 'waiting_human'
      RETURNING id INTO v_item_moved;
    ELSE
      UPDATE de_work_items SET
        status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = now(),
        result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
          'summary', left('Denied by human' || CASE WHEN v_instruction IS NOT NULL THEN ': ' || v_instruction ELSE '' END, 500),
          'human_ruling', jsonb_build_object('exception_id', p_exception_id,
            'decision', v_status, 'outcome', p_outcome, 'decided_at', now()))
      WHERE id = v_row.work_item_id AND tenant_id = v_tenant AND status = 'waiting_human'
      RETURNING id INTO v_item_moved;
      -- claim_de_work_items requires depends_on to be 'done'; a cancelled
      -- predecessor strands its successors as invisible-stuck 'queued' rows.
      IF v_item_moved IS NOT NULL THEN
        WITH RECURSIVE chain AS (
          SELECT w.id FROM de_work_items w
           WHERE w.depends_on = v_row.work_item_id AND w.tenant_id = v_tenant
             AND w.status IN ('queued','waiting_human')
          UNION ALL
          SELECT w2.id FROM de_work_items w2 JOIN chain c ON w2.depends_on = c.id
           WHERE w2.status IN ('queued','waiting_human')
        )
        UPDATE de_work_items w SET status = 'cancelled',
               last_error = 'predecessor denied by human ruling', updated_at = now()
          FROM chain WHERE w.id = chain.id;
      END IF;
    END IF;
  END IF;

  PERFORM append_audit_event(
    v_tenant, 'Workspace', 'human',
    format('%s exception %s — %s', coalesce(v_de_name, 'An employee'), v_status, left(v_row.situation, 120)),
    'approval',
    jsonb_build_object('exception_id', p_exception_id, 'de_id', v_row.de_id,
      'decision', v_status, 'learned', coalesce(p_learned, false),
      'memory_id', v_memory_id, 'work_item_id', v_row.work_item_id,
      'work_item_moved', v_item_moved IS NOT NULL));
  RETURN jsonb_build_object('ok', true, 'status', v_status,
    'memory_id', v_memory_id, 'work_item_id', v_row.work_item_id,
    'work_item_moved', v_item_moved IS NOT NULL);
END$function$;

-- Prove the change landed and every value it writes is legal on the LIVE checks
DO $assert$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='decide_de_exception' AND p.prokind='f' LIMIT 1;
  IF v_def !~ 'de_memory_write' THEN RAISE EXCEPTION '443: learned ruling does not write memory'; END IF;
  IF v_def !~ 'waiting_human' THEN RAISE EXCEPTION '443: work-item transition missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.de_memory'::regclass
      AND conname='de_memory_kind_check' AND pg_get_constraintdef(oid) ILIKE '%''fact''%')
    THEN RAISE EXCEPTION '443: de_memory kind fact not legal'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.de_memory'::regclass
      AND conname='de_memory_source_check' AND pg_get_constraintdef(oid) ILIKE '%''human''%')
    THEN RAISE EXCEPTION '443: de_memory source human not legal'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.de_work_items'::regclass
      AND conname='de_work_items_status_check' AND pg_get_constraintdef(oid) ILIKE '%''queued''%'
      AND pg_get_constraintdef(oid) ILIKE '%''cancelled''%')
    THEN RAISE EXCEPTION '443: work-item statuses queued/cancelled not legal'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.audit_events'::regclass
      AND conname='audit_events_category_check' AND pg_get_constraintdef(oid) ILIKE '%''approval''%')
    THEN RAISE EXCEPTION '443: audit category approval not legal — and governance is NOT an alternative'; END IF;
END $assert$;

REVOKE ALL ON ROUTINE public.decide_de_exception(uuid, text, text, boolean) FROM PUBLIC, anon;
NOTIFY pgrst, 'reload schema';
