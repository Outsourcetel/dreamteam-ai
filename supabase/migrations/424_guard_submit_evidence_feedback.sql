-- 424_guard_submit_evidence_feedback.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — the last genuine actor. See docs/30.
--
-- submit_evidence_feedback(p_evidence_run_id, p_verdict, p_notes) is a reviewer
-- judging an employee's evidence trail. A verdict of 'needs_improvement' or
-- 'inaccurate' does not just record an opinion: it COMPOSES A KNOWLEDGE
-- REVISION — reading the doc the run cited, appending the reviewer's note and
-- the recorded evidence gaps — and raises a knowledge_revision task for
-- approval. So an unscoped caller could rule on the work of an employee they
-- have no relationship with AND put a drafted edit to that employee's knowledge
-- in front of an approver, with their name on it.
--
-- That is the same shape as the learning & trust sub-group (416-419): the harm
-- is not the row it writes, it is what the employee ends up knowing.
--
-- ── ⚠ NULL-TOLERANT, and here the null case is the MAJORITY ───────────────
-- evidence_runs.de_id is nullable and **149 of the 203 runs in production have
-- no de_id — 73%**. Every other null-tolerant guard in this wave covered an
-- edge case; this one covers most of the table. A plain
-- `not can_access_de(v_run.de_id)` would refuse feedback on nearly three
-- quarters of all evidence runs for a scoped user, while the readers beside it
-- happily show those runs. The guard is therefore the exact negation of the
-- migration-386 predicate, as in 404/406/407/408/419/423.
--
-- evidence_runs also carries specialist_de_id — a second employee CONSULTED
-- during the run. It is deliberately NOT guarded: the run is the work of de_id,
-- and a consultation does not transfer ownership of the verdict. Responsibility
-- for the owning employee is the right test.
--
-- ── The existing membership check already handles the trusted-server path ──
-- Unlike enqueue_de_work_item (420), this body does NOT fail open on a null
-- uid: it explicitly requires auth.role() = 'service_role' in the null-uid
-- branch. So the guard needs no bypass of its own — can_access_de returns true
-- for service_role by name, and every other null-uid caller has already been
-- turned away above.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_ins text := '  insert into evidence_feedback (tenant_id, evidence_run_id, reviewer_user_id, verdict, notes)';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'submit_evidence_feedback';
  IF v_src IS NULL THEN RAISE EXCEPTION '424: submit_evidence_feedback not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '424: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/424). NULL-TOLERANT, and here the null case is the',
    '  -- MAJORITY: 149 of 203 live evidence runs carry no de_id. The plain form',
    '  -- would refuse feedback on ~73% of runs for a scoped user while the',
    '  -- readers still show them. Exact negation of the mig-386 predicate.',
    '  -- specialist_de_id is intentionally NOT tested: the run is the work of',
    '  -- de_id, and being consulted does not transfer ownership of the verdict.',
    '  if v_run.de_id is not null and not public.can_access_de(v_run.de_id) then',
    '    return jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  end if;',
    ''], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_ins, ''))) / length(a_ins);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '424: expected 1 feedback insert to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_ins, v_guard || a_ins);
  IF v_new = v_src THEN
    RAISE EXCEPTION '424: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_calls int; v_nullable text; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'submit_evidence_feedback';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_calls  := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_guards <> 1 OR v_calls <> 1 THEN
    RAISE EXCEPTION '424: expected exactly 1 guard (token %, calls %)', v_guards, v_calls;
  END IF;
  IF v_def NOT LIKE '%''not_responsible_for_de''%' THEN
    RAISE EXCEPTION '424: the guard does not refuse';
  END IF;

  -- ⚠ The null-tolerant shape is the measured decision here, and the stakes are
  -- higher than anywhere else in the wave because the null case is the majority.
  IF v_def NOT LIKE '%v_run.de_id is not null and not public.can_access_de(v_run.de_id)%' THEN
    RAISE EXCEPTION '424: the guard is not null-tolerant — 149 of 203 live evidence runs have a null de_id';
  END IF;
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'evidence_runs' AND column_name = 'de_id';
  IF v_nullable <> 'YES' THEN
    RAISE EXCEPTION '424: evidence_runs.de_id is NOT NULL — the null-tolerant shape is now dead code, re-check it';
  END IF;

  -- Order: membership first, then scope, then every write.
  IF position('not_tenant_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '424: the scope guard runs before the membership check';
  END IF;
  IF position('can_access_de' in v_def) > position('insert into evidence_feedback' in v_def)
     OR position('can_access_de' in v_def) > position('insert into knowledge_revision_requests' in v_def)
     OR position('can_access_de' in v_def) > position('insert into human_tasks' in v_def) THEN
    RAISE EXCEPTION '424: the guard lands after a write — feedback, a revision draft, or a task';
  END IF;

  -- This body does NOT fail open on a null uid; it demands service_role
  -- explicitly. That is why the guard needs no bypass, so the property must
  -- survive or the reasoning in the header stops holding.
  IF v_def NOT LIKE '%elsif coalesce(auth.role(), '''') <> ''service_role'' then%' THEN
    RAISE EXCEPTION '424: the explicit service_role branch was lost — the null-uid path would fail open';
  END IF;
  IF v_def NOT LIKE '%bad_verdict%' OR v_def NOT LIKE '%evidence_run_not_found%'
     OR v_def NOT LIKE '%knowledge_revision%' THEN
    RAISE EXCEPTION '424: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test: a bad verdict needs no identity and must still be
  -- rejected in contract.
  SELECT public.submit_evidence_feedback(
           '00000000-0000-0000-0000-000000000000'::uuid, 'not_a_verdict', '') INTO v_out;
  IF v_out->>'error' <> 'bad_verdict' THEN
    RAISE EXCEPTION '424: expected bad_verdict, got %', coalesce(v_out::text, 'null');
  END IF;

  RAISE NOTICE '424: submit_evidence_feedback guarded, null-tolerant. GROUP B COMPLETE — 22 actors, not the 24 first listed; see docs/30 for the two reclassifications.';
END $assert$;

NOTIFY pgrst, 'reload schema';
