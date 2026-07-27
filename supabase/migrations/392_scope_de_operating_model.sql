-- 392_scope_de_operating_model.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- get_de_operating_model(p_de_id) is "how this employee operates": its work
-- sources, published playbooks, open objectives, what it is waiting on a human
-- for, what it is working on right now and what is queued next. It is
-- SECURITY DEFINER and checks only that the employee belongs to the caller's
-- WORKSPACE — not that the caller is responsible for it.
--
-- ── One gate, not eleven ───────────────────────────────────────────────────
-- The body already resolves the employee once, up front, and returns
-- {ok:false, error:'not_found'} if that lookup misses. Every one of the eleven
-- reads below is keyed on the same p_de_id. So the scope check belongs on that
-- single lookup: fail it and the function returns before touching anything.
-- Adding a predicate to each read instead would be eleven chances to miss one.
--
-- ── Denied is reported as not_found, on purpose ────────────────────────────
-- An employee you are not responsible for is indistinguishable from one that
-- does not exist. A distinct 'not_permitted' would confirm the employee exists
-- and hint at how many there are — a small leak, but a free one to avoid.
--
-- Note this function calls get_workforce_board(p_de_id), already scoped by
-- migration 387, so next_up and listens_live were partially covered already.
-- The identity block, work sources, playbooks and objectives were not.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  v_anchor text := 'WHERE id = p_de_id AND tenant_id = v_tenant;';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_operating_model';
  IF v_src IS NULL THEN RAISE EXCEPTION '392: get_de_operating_model not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '392: already scoped, nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '392: expected 1 employee lookup, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, v_anchor,
    E'WHERE id = p_de_id AND tenant_id = v_tenant\n     -- DE scoping (mig 385/392): one gate on the single lookup every read below\n     -- is keyed to. Fail it and the function returns not_found before touching\n     -- work sources, playbooks, objectives or deliverables.\n     AND public.can_access_de(id);');

  IF v_new = v_src THEN
    RAISE EXCEPTION '392: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_operating_model';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '392: expected exactly 1 scope guard, found %', v_guards;
  END IF;

  -- The gate is worthless if it sits after the reads. Position, not presence:
  -- the guard must appear before the first thing it is meant to protect.
  IF position('can_access_de' in v_def) = 0
     OR position('can_access_de' in v_def) > position('work_sources' in v_def) THEN
    RAISE EXCEPTION '392: the guard is not ahead of the reads it is meant to gate';
  END IF;
  IF v_def NOT LIKE '%tenant_id = v_tenant%' THEN
    RAISE EXCEPTION '392: the workspace filter was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%work_sources%'
     OR v_def NOT LIKE '%current_focus%'
     OR v_def NOT LIKE '%last_deliverable%' THEN
    RAISE EXCEPTION '392: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runs as postgres: auth_tenant_id() is null, so not_permitted is the correct
  -- and expected answer. The check is that it answers in contract, not that it
  -- returns data — a migration can never observe what a scoped user sees.
  SELECT public.get_de_operating_model('00000000-0000-0000-0000-000000000000'::uuid) INTO v_out;
  IF v_out->>'ok' IS NULL THEN
    RAISE EXCEPTION '392: the function no longer returns its ok/error contract';
  END IF;

  RAISE NOTICE '392: operating model scoped at the employee lookup; denial reports as not_found.';
END $assert$;

NOTIFY pgrst, 'reload schema';
