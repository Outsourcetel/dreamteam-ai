-- 412_guard_propose_opportunity_writeback.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — write-back sub-group. See docs/30 and
-- migration 410's header for the sub-group reasoning and why the guard refuses
-- through the error envelope rather than raising.
--
-- propose_opportunity_writeback(...) proposes a change to a PIPELINE
-- OPPORTUNITY: log an activity, set the next step, or move the deal to another
-- stage. Moving a deal stage on behalf of an employee you are not responsible
-- for rewrites someone else's forecast — and unlike the invoice desk, the
-- non-destructive ops here can auto-execute straight into the record.
--
-- Same anchor shape as 410 and 413 (single-line tenant check); 411 is the
-- three-line outlier. The count is asserted before editing regardless.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_tenant text := '  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN RETURN jsonb_build_object(''ok'', false, ''error'', ''not_tenant_member''); END IF;';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'propose_opportunity_writeback';
  IF v_src IS NULL THEN RAISE EXCEPTION '412: propose_opportunity_writeback not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '412: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/412). Role axis above, assignment axis here — both',
    '  -- before the opportunity is looked up, so a refused caller never learns',
    '  -- whether it exists. p_de_id is proven to resolve by the de_not_found',
    '  -- check above, so there is no null case. Refuses through the error',
    '  -- envelope this function contracts on rather than raising; see 410.',
    '  IF NOT public.can_access_de(p_de_id) THEN RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de''); END IF;'
    ], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_tenant, ''))) / length(a_tenant);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '412: expected 1 tenant check to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_tenant, a_tenant || v_eol || v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '412: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'propose_opportunity_writeback';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '412: expected exactly 1 guard, found %', v_guards;
  END IF;
  IF v_def NOT LIKE '%RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'')%' THEN
    RAISE EXCEPTION '412: the guard does not return the error envelope this function contracts on';
  END IF;
  IF position('not_tenant_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '412: the scope guard runs before the tenant check';
  END IF;
  IF position('can_access_de' in v_def) > position('decide_action_execution' in v_def)
     OR position('can_access_de' in v_def) > position('INSERT INTO opportunity_writeback_requests' in v_def)
     OR position('can_access_de' in v_def) > position('apply_opportunity_writeback_internal' in v_def) THEN
    RAISE EXCEPTION '412: the guard lands after the gate, the request insert, or the auto-apply';
  END IF;
  -- Anti-hallucination: the target stage must be a REAL configured stage.
  IF v_def NOT LIKE '%tenant_pipeline_stages%' THEN
    RAISE EXCEPTION '412: the configured-stage check was lost — a DE could invent a pipeline stage';
  END IF;
  IF v_def NOT LIKE '%opportunity_not_in_tenant%' OR v_def NOT LIKE '%auto_applied%' THEN
    RAISE EXCEPTION '412: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT public.propose_opportunity_writeback(
           '00000000-0000-0000-0000-000000000000'::uuid,
           '00000000-0000-0000-0000-000000000000'::uuid,
           '00000000-0000-0000-0000-000000000000'::uuid,
           'not_a_real_op', '{}'::jsonb) INTO v_out;
  IF v_out->>'error' <> 'bad_op' THEN
    RAISE EXCEPTION '412: expected bad_op, got %', coalesce(v_out::text, 'null');
  END IF;

  RAISE NOTICE '412: propose_opportunity_writeback guarded.';
END $assert$;

NOTIFY pgrst, 'reload schema';
