-- 418_guard_apply_improvement.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — learning & trust sub-group. See docs/30.
--
-- apply_improvement(p_improvement_id) PUBLISHES a self-improvement: it takes a
-- fix an employee proposed after a failed answer, verified by replay and
-- approved by a human, and writes it into knowledge_docs so the employee reads
-- it from then on.
--
-- ⚠ It can publish at ROLE scope, not just to one employee. ────────────────
-- When imp.publish_scope = 'role' and the archetype resolves, the doc is
-- inserted with visibility 'role' and a share_archetype_key — it becomes
-- knowledge for EVERY employee of that archetype. The activity event says so in
-- as many words: "shared with all <archetype> employees". Otherwise it is
-- scoped to the one DE via knowledge_doc_scopes.
--
-- So this is the same shape as 416: the guard bounds WHO may publish, and the
-- reach is a property of the improvement record, not of the caller. Unlike 416
-- that is not a surprise — publish_scope is a deliberate, human-chosen field
-- (T2.2) rather than an unset default — so it is noted, not flagged.
--
-- ── Why the existing check is not enough ──────────────────────────────────
-- The body already refuses a caller who is neither platform layer nor a member
-- of the improvement's tenant. That is the role axis. It says nothing about
-- WHICH employee proposed the improvement, which is what this adds.
--
-- Note the existing check is the `auth.uid() is not null and ...` shape — it is
-- skipped entirely for a null uid so that service_role and cron can publish.
-- That is the deliberate-bypass pattern documented in the perimeter work (31 of
-- 32 uses are correct); this function is NOT anon-executable, so it is one of
-- the correct ones. can_access_de is true for service_role by name, so the new
-- guard preserves that path rather than breaking the workers.
--
-- de_improvements.de_id is NOT NULL, so the plain guard shape is right.
-- This function RAISEs on every failure, so the guard raises too.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_applied text := '  if imp.status = ''applied'' then return imp.applied_doc_id; end if;';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'apply_improvement';
  IF v_src IS NULL THEN RAISE EXCEPTION '418: apply_improvement not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '418: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  -- Placed BEFORE the already-applied early return on purpose: a caller who is
  -- not responsible for the employee should not be handed the published doc id
  -- just because somebody else already published it.
  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/418). Before the already-applied early return, so a',
    '  -- refused caller is not handed applied_doc_id. de_improvements.de_id is',
    '  -- NOT NULL, so no null case. service_role still passes, by role name.',
    '  if not public.can_access_de(imp.de_id) then',
    '    raise exception ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  end if;',
    ''], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_applied, ''))) / length(a_applied);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '418: expected 1 already-applied early return to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_applied, v_guard || a_applied);
  IF v_new = v_src THEN
    RAISE EXCEPTION '418: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_calls int; v_nullable text; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'apply_improvement';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_calls  := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_guards <> 1 OR v_calls <> 1 THEN
    RAISE EXCEPTION '418: expected exactly 1 guard (token %, calls %) — a comment may be inflating the count', v_guards, v_calls;
  END IF;
  IF v_def NOT LIKE '%raise exception ''not_responsible_for_de%' THEN
    RAISE EXCEPTION '418: the guard does not RAISE — this function contracts on raising';
  END IF;

  -- Order: the tenant check first, then scope, then the early return, then the
  -- publish. The early-return position is the point of this placement.
  IF position('not authorized' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '418: the scope guard runs before the tenant check';
  END IF;
  IF position('can_access_de' in v_def) > position('return imp.applied_doc_id' in v_def) THEN
    RAISE EXCEPTION '418: the guard lands after the already-applied early return — a refused caller would still get the doc id';
  END IF;
  IF position('can_access_de' in v_def) > position('insert into knowledge_docs' in v_def)
     OR position('can_access_de' in v_def) > position('update de_improvements' in v_def) THEN
    RAISE EXCEPTION '418: the guard lands after a mutation';
  END IF;

  -- The human-approval gate is the product guarantee this function exists to
  -- enforce: a proposed fix may only be published after explicit approval.
  IF v_def NOT LIKE '%is not human-approved%' THEN
    RAISE EXCEPTION '418: the human-approval gate was lost — improvements could publish unapproved';
  END IF;
  IF v_def NOT LIKE '%share_archetype_key%' OR v_def NOT LIKE '%knowledge_doc_scopes%' THEN
    RAISE EXCEPTION '418: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'de_improvements' AND column_name = 'de_id';
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION '418: de_improvements.de_id is nullable — this needs the null-tolerant shape';
  END IF;

  -- Runtime smoke test: an unknown improvement must still raise its own error.
  BEGIN
    PERFORM public.apply_improvement('00000000-0000-0000-0000-000000000000'::uuid);
  EXCEPTION WHEN others THEN
    v_raised := SQLERRM; v_fired := true;
  END;
  IF NOT v_fired OR v_raised NOT LIKE '%improvement not found%' THEN
    RAISE EXCEPTION '418: expected improvement-not-found to fire first, got: %', coalesce(v_raised, '(nothing raised)');
  END IF;

  RAISE NOTICE '418: apply_improvement guarded — note it can publish at ROLE scope to every employee of an archetype, by deliberate human choice.';
END $assert$;

NOTIFY pgrst, 'reload schema';
