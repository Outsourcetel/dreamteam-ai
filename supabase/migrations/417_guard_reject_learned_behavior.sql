-- 417_guard_reject_learned_behavior.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — learning & trust sub-group. See docs/30
-- and migration 416's header for the sub-group reasoning.
--
-- reject_learned_behavior(p_cluster_id, p_reason) declines a proposed learned
-- behaviour: it rejects the review task, returns the cluster to 'open', and
-- writes a config_change audit event naming the rejector.
--
-- ── Rejecting is not the harmless direction ───────────────────────────────
-- It is tempting to treat approve as the dangerous verb and reject as the safe
-- one. It is not: rejecting suppresses a correction the platform derived from
-- an employee's own failures, and it detaches the human task so the proposal
-- stops being anybody's queue item. Unscoped, a person could silently discard
-- the improvement signal for an employee they have no relationship with — and
-- the audit trail would record them as the reviewer who made that call. The
-- proposal returns to 'open' rather than being deleted, so it is recoverable;
-- that is the only thing that makes this milder than 416, not the direction.
--
-- Same table and therefore the same shape as 416: de_id is NOT NULL so the
-- plain guard is right, and the refusal uses this function's own {ok:false}
-- envelope. Kept as its own migration so a failure here cannot be confused with
-- a failure there and the assertion names one function.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_task text := '  if v_cluster.human_task_id is not null then';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reject_learned_behavior';
  IF v_src IS NULL THEN RAISE EXCEPTION '417: reject_learned_behavior not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '417: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/417). Rejecting suppresses a correction derived',
    '  -- from this employee''''s own failures and records the caller as the',
    '  -- reviewer who decided it. de_id is NOT NULL here, so no null case.',
    '  if not public.can_access_de(v_cluster.de_id) then',
    '    return jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  end if;',
    ''], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_task, ''))) / length(a_task);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '417: expected 1 human-task branch to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_task, v_guard || a_task);
  IF v_new = v_src THEN
    RAISE EXCEPTION '417: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_calls int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reject_learned_behavior';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_calls  := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_guards <> 1 OR v_calls <> 1 THEN
    RAISE EXCEPTION '417: expected exactly 1 guard (token %, calls %) — a comment may be inflating the count', v_guards, v_calls;
  END IF;
  IF v_def NOT LIKE '%''not_responsible_for_de''%' THEN
    RAISE EXCEPTION '417: the guard does not refuse — an actor must refuse explicitly, not filter';
  END IF;
  IF position('not_tenant_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '417: the scope guard runs before the tenant check';
  END IF;
  IF position('can_access_de' in v_def) > position('update human_tasks' in v_def)
     OR position('can_access_de' in v_def) > position('update de_learned_behavior_clusters' in v_def) THEN
    RAISE EXCEPTION '417: the guard lands after a mutation';
  END IF;
  IF v_def NOT LIKE '%not_proposed%' OR v_def NOT LIKE '%learned_behavior_rejected%' THEN
    RAISE EXCEPTION '417: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT public.reject_learned_behavior('00000000-0000-0000-0000-000000000000'::uuid, 'why') INTO v_out;
  IF v_out->>'error' <> 'not_proposed' THEN
    RAISE EXCEPTION '417: expected not_proposed, got %', coalesce(v_out::text, 'null');
  END IF;

  RAISE NOTICE '417: reject_learned_behavior guarded.';
END $assert$;

NOTIFY pgrst, 'reload schema';
