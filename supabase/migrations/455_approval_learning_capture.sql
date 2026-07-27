-- 455_approval_learning_capture.sql
-- ============================================================================
-- docs/34 increment 1: let the approval step teach the workforce.
--
-- Today `decideHumanTask` writes exactly three fields — status, decided_by,
-- decided_at — on the highest-volume human-judgment surface in the product
-- (137 pending in one workspace, 118 visible to a single scoped user). Every
-- human judgment made there is discarded the moment it is made.
--
-- This adds the capture. The frontend swap comes next; nothing calls the new
-- RPC yet, so this migration is inert on arrival.
--
-- ── ⚠ WHY `before` IS CAPTURED, NOT JUST THE CORRECTION ─────────────────
-- The valuable artefact is the PAIR (original, corrected) — that is what makes
-- an approval a training signal rather than a rating. And the original is
-- genuinely at risk: approve_draft already does
--     draft_content = COALESCE(p_edited_content, draft_content)
-- i.e. it OVERWRITES the original with the edit. If the pair is not captured at
-- decision time it is not recoverable afterwards. So `decision_edit` is
-- constrained to carry both halves, checked by the database rather than left to
-- a convention that would decay.
--
-- ── One vocabulary for both outcomes, deliberately ──────────────────────
-- The same reason codes apply to a rejection and to an approve-with-edits: both
-- answer "what was wrong with it". Sharing the vocabulary makes them comparable
-- — "wrong_tone produced 12 edits and 5 rejections on this employee" is a
-- sentence you can act on. Two separate taxonomies could not be added up.
--
-- Codes are a CLOSED SET enforced by CHECK, following audit_events_category_check.
-- docs/34's reasoning: a mandatory free-text box on a 118-item queue decays to
-- "ok" and "no", and this project has already shipped a written-never-read
-- surface once (ops_alerts had no reader for four days). Codes aggregate;
-- sentences do not. Free text stays OPTIONAL alongside.
--
-- ── Required on rejection, optional on approval ─────────────────────────
-- A rejection with no reason teaches nothing, and that is the case worth the
-- friction. A clean approval needs no code — its signal is that nothing was
-- wrong, and forcing a code there would produce noise and slow the queue.
--
-- ── The RPC closes a real gap, not just an ergonomic one ────────────────
-- decideHumanTask is a DIRECT UPDATE from the browser. That is precisely why it
-- escaped all 48 wave-2 function guards and needed mig 452's restrictive write
-- policy. Routing the decision through an RPC lets it carry the group-B guard
-- shape (can_access_de on the task's DE, refusing explicitly) AND write the
-- decision, the reason and the edit atomically — today a client could update
-- status and then fail before recording why.
--
-- ⚠ THE IDEMPOTENCY CONTRACT IS LOAD-BEARING AND IS PRESERVED EXACTLY.
-- The existing client relies on "UPDATE ... WHERE status = 'pending' matched no
-- row" to mean "already decided, do NOT re-run the side effects" — invoice
-- send, gated-action execute (a real external charge), email delivery,
-- write-backs. docs/24 records a live double-charge bug fixed by exactly this
-- guard. The RPC therefore returns the row on transition and NULL when the task
-- was already decided, which is byte-compatible with the .maybeSingle() the
-- caller uses today. Breaking that would re-open a money bug.
-- ============================================================================

ALTER TABLE public.human_tasks
  ADD COLUMN IF NOT EXISTS decision_reason_code text,
  ADD COLUMN IF NOT EXISTS decision_note       text,
  ADD COLUMN IF NOT EXISTS decision_edit       jsonb;

COMMENT ON COLUMN public.human_tasks.decision_reason_code IS
  'Closed-vocabulary reason for a rejection, or for an approval that required edits. Shared vocabulary so edits and rejections aggregate together (docs/34).';
COMMENT ON COLUMN public.human_tasks.decision_note IS
  'Optional free text alongside the code. Never the only signal — codes aggregate, sentences do not.';
COMMENT ON COLUMN public.human_tasks.decision_edit IS
  'The (before, after) training pair when an approver corrected the work. Both halves are required: approve_draft OVERWRITES the original, so `before` is unrecoverable after the fact.';

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'human_tasks_decision_reason_code_check') THEN
    ALTER TABLE public.human_tasks ADD CONSTRAINT human_tasks_decision_reason_code_check
      CHECK (decision_reason_code IS NULL OR decision_reason_code IN (
        'wrong_facts',        -- factually incorrect
        'wrong_tone',         -- voice or register wrong for the audience
        'missing_context',    -- did not know something it should have
        'incomplete',         -- correct as far as it went, not finished
        'not_permitted',      -- should not have proposed this at all
        'customer_specific',  -- right in general, wrong for THIS customer
        'other'               -- requires decision_note
      ));
  END IF;

  -- Both halves of the pair, or neither. A stored correction without its
  -- original is not a training signal, just a duplicate of the current value.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'human_tasks_decision_edit_shape_check') THEN
    ALTER TABLE public.human_tasks ADD CONSTRAINT human_tasks_decision_edit_shape_check
      CHECK (decision_edit IS NULL
             OR (decision_edit ? 'before' AND decision_edit ? 'after'));
  END IF;

  -- 'other' without a note is the shape that produces an unreadable backlog.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'human_tasks_decision_other_needs_note_check') THEN
    ALTER TABLE public.human_tasks ADD CONSTRAINT human_tasks_decision_other_needs_note_check
      CHECK (decision_reason_code IS DISTINCT FROM 'other'
             OR coalesce(btrim(decision_note), '') <> '');
  END IF;
END $constraints$;

CREATE INDEX IF NOT EXISTS human_tasks_decision_reason_idx
  ON public.human_tasks (tenant_id, decision_reason_code)
  WHERE decision_reason_code IS NOT NULL;

-- ── The decision path ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.decide_human_task(
  p_task_id      uuid,
  p_decision     text,
  p_reason_code  text    DEFAULT NULL,
  p_note         text    DEFAULT NULL,
  p_edit         jsonb   DEFAULT NULL
)
RETURNS human_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_task   human_tasks;
  v_row    human_tasks;
BEGIN
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
      'de_id', v_row.de_id, 'edited', (p_edit IS NOT NULL)));

  RETURN v_row;
END $fn$;

REVOKE ALL ON ROUTINE public.decide_human_task(uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.decide_human_task(uuid, text, text, text, jsonb) TO authenticated;

DO $assert$
DECLARE v_def text; v_raised text; v_fired boolean := false; v_n int;
BEGIN
  -- Columns and constraints landed.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='human_tasks'
         AND column_name IN ('decision_reason_code','decision_note','decision_edit')) <> 3 THEN
    RAISE EXCEPTION '455: the three capture columns are not all present';
  END IF;
  FOR v_n IN SELECT 1 FROM (VALUES
      ('human_tasks_decision_reason_code_check'),
      ('human_tasks_decision_edit_shape_check'),
      ('human_tasks_decision_other_needs_note_check')) c(n)
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.n)
  LOOP
    RAISE EXCEPTION '455: a decision constraint is missing';
  END LOOP;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='decide_human_task';
  IF v_def IS NULL THEN RAISE EXCEPTION '455: decide_human_task not created'; END IF;

  -- The group-B guard, null-tolerant to match the table policies.
  IF v_def NOT LIKE '%v_task.de_id IS NOT NULL AND NOT public.can_access_de(v_task.de_id)%' THEN
    RAISE EXCEPTION '455: the DE guard is missing or not null-tolerant';
  END IF;
  -- ⚠ The money guard. Losing the pending-only clause re-opens the
  -- double-approval double-charge bug recorded in docs/24.
  IF v_def NOT LIKE '%AND status = ''pending''%' THEN
    RAISE EXCEPTION '455: the pending-only clause is gone — this re-opens the double-charge bug';
  END IF;
  IF v_def NOT LIKE '%RETURN NULL;%' THEN
    RAISE EXCEPTION '455: the already-decided path must return NULL so the caller skips its side effects';
  END IF;
  IF v_def NOT LIKE '%''approval''%' THEN
    RAISE EXCEPTION '455: the audit event is missing';
  END IF;
  IF has_function_privilege('anon','public.decide_human_task(uuid,text,text,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION '455: anon holds EXECUTE on a decision writer';
  END IF;

  -- 'approval' must actually be legal, verified against the LIVE constraint
  -- rather than against this file's own text (mig 429's lesson).
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname='audit_events_category_check') NOT LIKE '%approval%' THEN
    RAISE EXCEPTION '455: approval is not an allowed audit category — the decision would abort';
  END IF;

  -- Runtime: postgres has no workspace, so the first gate must fire. Proves the
  -- body compiles and the gate order survived.
  BEGIN
    PERFORM public.decide_human_task('00000000-0000-0000-0000-000000000000'::uuid, 'approved');
  EXCEPTION WHEN others THEN v_raised := SQLERRM; v_fired := true; END;
  IF NOT v_fired OR v_raised NOT LIKE '%not_authenticated%' THEN
    RAISE EXCEPTION '455: expected the auth gate to fire first, got: %', coalesce(v_raised,'(nothing)');
  END IF;

  RAISE NOTICE '455: approval capture ready — columns, closed reason vocabulary, (before,after) pair enforced, guarded RPC. INERT until the frontend swaps off the direct UPDATE.';
END $assert$;

NOTIFY pgrst, 'reload schema';
