-- 456_decision_audit_detail_parity.sql
-- ============================================================================
-- docs/34 increment 2, prerequisite. Adds related_table / related_id to the
-- audit detail written by decide_human_task (mig 455).
--
-- ── Why, and why it is a prerequisite rather than a nicety ──────────────
-- decide_human_task writes an 'approval' audit event. So does the CLIENT, in
-- customerApi.decideHumanTask, which has been the only writer until now.
-- Increment 2 swaps the client onto the RPC, so the client-side
-- appendAuditEvent must be REMOVED or every decision would be logged twice —
-- duplicate entries in the one chain a governance-first buyer's diligence
-- reads is a worse outcome than the gap being closed.
--
-- But the client's detail carries two keys mine does not:
--     related_table, related_id
-- Those are what tie a decision to the record it acted on — the invoice, the
-- write-back request, the draft, the onboarding project. Dropping the client
-- writer without adding them would silently lose traceability from the audit
-- chain, which is exactly the kind of quiet regression this migration exists
-- to prevent.
--
-- Reproduce-from-live splice, not a rewrite from the 455 source, even though
-- 455 is twenty minutes old and mine. The habit is the point: 377 reverted the
-- export pager by pasting a body that was true when it was written.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  a_tail text := '      ''de_id'', v_row.de_id, ''edited'', (p_edit IS NOT NULL)));';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='decide_human_task';
  IF v_src IS NULL THEN RAISE EXCEPTION '456: decide_human_task not found — apply 455 first'; END IF;

  IF v_src LIKE '%related_table%' THEN
    RAISE NOTICE '456: already at parity, nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, a_tail, ''))) / length(a_tail);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '456: expected 1 audit-detail tail, found % — refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_tail,
    '      ''de_id'', v_row.de_id, ''edited'', (p_edit IS NOT NULL),' || chr(10) ||
    '      ''related_table'', v_row.related_table, ''related_id'', v_row.related_id));');

  IF v_new = v_src THEN RAISE EXCEPTION '456: the edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='decide_human_task';

  IF v_def NOT LIKE '%''related_table'', v_row.related_table%'
     OR v_def NOT LIKE '%''related_id'', v_row.related_id%' THEN
    RAISE EXCEPTION '456: the traceability keys are not present';
  END IF;

  -- Everything 455 asserted must still hold. A parity splice must not cost the
  -- guard, the money clause, or the audit category.
  IF v_def NOT LIKE '%v_task.de_id IS NOT NULL AND NOT public.can_access_de(v_task.de_id)%' THEN
    RAISE EXCEPTION '456: the DE guard was lost in the splice';
  END IF;
  IF v_def NOT LIKE '%AND status = ''pending''%' THEN
    RAISE EXCEPTION '456: the pending-only clause is gone — this re-opens the double-charge bug';
  END IF;
  IF v_def NOT LIKE '%RETURN NULL;%' THEN
    RAISE EXCEPTION '456: the already-decided path must still return NULL';
  END IF;
  IF v_def NOT LIKE '%reason_required%' THEN
    RAISE EXCEPTION '456: the rejection-needs-a-reason rule was lost';
  END IF;
  IF v_def NOT LIKE '%''approval''%' THEN
    RAISE EXCEPTION '456: the audit category was lost';
  END IF;

  BEGIN
    PERFORM public.decide_human_task('00000000-0000-0000-0000-000000000000'::uuid, 'approved');
  EXCEPTION WHEN others THEN v_raised := SQLERRM; v_fired := true; END;
  IF NOT v_fired OR v_raised NOT LIKE '%not_authenticated%' THEN
    RAISE EXCEPTION '456: expected the auth gate to fire first, got: %', coalesce(v_raised,'(nothing)');
  END IF;

  RAISE NOTICE '456: audit detail at parity — the client-side appendAuditEvent can now be removed without losing traceability.';
END $assert$;

NOTIFY pgrst, 'reload schema';
