-- 474_approve_with_edit_applies_and_learns.sql
-- ============================================================================
-- Make approve-WITH-EDIT real on the human-task queue: the edited text is what
-- gets PUBLISHED, and the (before, after) pair is recorded as a training
-- signal. Completes the founder's 2026-07-27 request, whose rejection half
-- shipped in 455-457 and was proven live on 2026-07-28.
--
-- ── What already existed, measured before writing a line ─────────────────
--   decide_human_task(…, p_edit jsonb)   accepts it
--   human_tasks.decision_edit jsonb      stores it
--   audit detail                         already carries 'edited', p_edit IS NOT NULL
--   decideHumanTask (client)             already sends {before, after}
--   de_learning_edits                    exists, source_kind allows 'human_task'
--
-- Every layer was in place except two, and they are the two that decide
-- whether the feature is honest:
--
--   1. NOTHING APPLIED THE EDIT. sync_improvement_decision calls
--      apply_improvement(related_id), which publishes de_improvements
--      .proposed_content — the ORIGINAL. An approver could correct an article,
--      watch it save, and the DE would publish the uncorrected text. Storing a
--      correction while publishing the original is worse than not offering the
--      box, because the UI states a falsehood the approver cannot see.
--
--   2. NOTHING WROTE de_learning_edits (0 rows, written only by approve_draft
--      and approve_draft_reply — the support-draft surface). So the highest
--      volume judgment surface in the product produced no training pairs.
--
-- ── Why the trigger and not apply_improvement ────────────────────────────
-- apply_improvement is called from several places and takes only an
-- improvement id; adding an edit parameter changes a shared signature for one
-- caller's benefit. The trigger already receives the decided task row, so
-- NEW.decision_edit is in hand exactly where the decision happens. The edit is
-- written to proposed_content BEFORE apply_improvement reads it, so publishing
-- stays a single unmodified code path.
--
-- ⚠ TWO SEPARATE EXCEPTION BLOCKS, DELIBERATELY. The original swallowed
-- publish failures so a human's decision is never rolled back. If the edit
-- work shared that block, a publish failure would roll back the recorded
-- training pair too (an EXCEPTION block is a subtransaction). The edit is
-- recorded independently, so a stuck publish still leaves the correction
-- captured — the learning signal survives the mechanical failure.
--
-- ⚠ de_learning_edits has CHECK (btrim(before_text) <> btrim(after_text)).
-- An approver who opens the box and changes nothing must NOT produce a row —
-- a no-op pair is not a training signal, and inserting it would raise inside
-- the trigger. Guarded explicitly rather than relying on the constraint.
--
-- ── Scope, stated plainly ────────────────────────────────────────────────
-- This wires the de_improvements path — the knowledge fixes. It does NOT wire
-- escalations (109 of 131 pending), because approving an escalation task has
-- no applier at all: there is no de_conversations hook in decideHumanTask and
-- no sync trigger for it, so an edit there would have nothing to apply to.
-- That gap is real and is reported to the founder rather than papered over
-- with an edit box that writes to nothing.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_improvement_decision()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_after  text;
  v_before text;
  v_de     uuid;
begin
  if NEW.related_table = 'de_improvements' and NEW.status in ('approved', 'rejected')
     and OLD.status is distinct from NEW.status then

    -- ── 1. Apply the approver's correction BEFORE publishing ──────────────
    -- Its own block: a failure here must not stop the publish, and a failure
    -- in the publish below must not roll back the training pair.
    if NEW.status = 'approved' and NEW.decision_edit is not null then
      begin
        v_after := nullif(btrim(NEW.decision_edit->>'after'), '');

        select proposed_content, de_id into v_before, v_de
          from de_improvements where id = NEW.related_id;

        -- Only a real change counts. Equal text is not a training signal and
        -- would violate de_learning_edits_actually_changed_check.
        if v_after is not null and v_before is not null
           and btrim(v_before) <> btrim(v_after) then

          -- THIS is what makes the edit real: apply_improvement publishes
          -- proposed_content, so the corrected text is what reaches the
          -- knowledge base.
          update de_improvements
             set proposed_content = v_after, updated_at = now()
           where id = NEW.related_id;

          insert into de_learning_edits
            (tenant_id, de_id, source_kind, source_id,
             before_text, after_text, reason_code, note, edited_by)
          values
            (NEW.tenant_id, v_de, 'human_task', NEW.id,
             v_before, v_after, NEW.decision_reason_code, NEW.decision_note,
             NEW.decided_by);
        end if;
      exception when others then
        raise warning 'sync_improvement_decision: edit capture failed for task %: %', NEW.id, SQLERRM;
      end;
    end if;

    -- ── 2. Publish or reject — unchanged behaviour ────────────────────────
    begin
      if NEW.status = 'approved' then
        perform public.apply_improvement(NEW.related_id);
      else
        perform public.reject_improvement(NEW.related_id);
      end if;
    exception when others then
      -- Never roll back the human's decision; leave the improvement in
      -- review_pending where it is visibly stuck rather than silently lost.
      raise warning 'sync_improvement_decision: % for improvement %: %', NEW.status, NEW.related_id, SQLERRM;
    end;
  end if;
  return NEW;
end;
$function$;

DO $assert$
DECLARE v_def text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='sync_improvement_decision';

  -- The edit must be APPLIED, not merely stored. Without this update the
  -- approver's correction is decorative and the original publishes.
  IF v_def NOT LIKE '%update de_improvements%proposed_content = v_after%' THEN
    RAISE EXCEPTION '474: the edit is not written to proposed_content — apply_improvement would publish the ORIGINAL';
  END IF;
  IF v_def NOT LIKE '%insert into de_learning_edits%' THEN
    RAISE EXCEPTION '474: no training pair is recorded';
  END IF;

  -- ⚠ The no-op guard. Without it an approver who opens the box and changes
  -- nothing raises inside the trigger on the actually_changed CHECK.
  IF v_def NOT LIKE '%btrim(v_before) <> btrim(v_after)%' THEN
    RAISE EXCEPTION '474: missing the no-op guard — an unchanged edit would violate the actually_changed check';
  END IF;

  -- The original contract must survive: the publish still happens, the reject
  -- still happens, and neither can roll back the human decision.
  IF v_def NOT LIKE '%apply_improvement%' OR v_def NOT LIKE '%reject_improvement%' THEN
    RAISE EXCEPTION '474: the publish/reject path was lost';
  END IF;

  -- TWO handlers: one for the edit, one for the publish. A single shared
  -- handler would let a publish failure roll back the recorded training pair.
  v_n := (length(v_def) - length(replace(v_def, 'exception when others then', ''))) / length('exception when others then');
  IF v_n < 2 THEN
    RAISE EXCEPTION '474: expected 2 exception handlers, found % — a publish failure would discard the captured edit', v_n;
  END IF;

  -- The trigger must still be attached and enabled; replacing the function
  -- does not detach it, but asserting costs nothing and the alternative is a
  -- silent no-op.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  WHERE c.relname='human_tasks' AND t.tgname='trg_sync_improvement'
                    AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION '474: trg_sync_improvement is missing or disabled — nothing would fire';
  END IF;

  -- ⚠ NOT asserted here, on purpose: that an approved edit actually reaches
  -- knowledge_docs. Proving that requires creating a real improvement and
  -- publishing a real document into a live tenant's knowledge base, and a
  -- failed cleanup would leave junk the DEs then retrieve. It is verified
  -- through the product instead, the same way the rejection half was. An
  -- assertion that cannot be written safely should be named, not faked.
  RAISE NOTICE '474: approve-with-edit applies and learns. Edited text now publishes; (before, after) recorded to de_learning_edits as source_kind=human_task.';
END $assert$;

NOTIFY pgrst, 'reload schema';
