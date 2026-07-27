-- 416_guard_approve_learned_behavior.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — learning & trust sub-group. See docs/30.
--
-- approve_learned_behavior(p_cluster_id, p_final_pattern, p_final_threshold)
-- accepts a pattern the platform noticed in an employee's corrected answers and
-- turns it into a GUARDRAIL RULE — either creating one (verdict 'correction') or
-- amending / deactivating an existing one (any other verdict).
--
-- This is the sub-group where an actor changes what an employee BECOMES rather
-- than what it did once. A guardrail rule shapes every future answer, so an
-- unscoped approval is not a one-off act; it is a permanent change to how the
-- workforce behaves, attributed to the approver in the audit trail.
--
-- ⚠ THE GUARD BOUNDS WHO MAY APPROVE. IT DOES NOT BOUND THE BLAST RADIUS. ──
-- Measured, not assumed: guardrail_rules.scope is NOT NULL DEFAULT 'workspace',
-- and the INSERT below does not set it. So a learned behaviour derived from ONE
-- employee becomes a WORKSPACE-WIDE rule. The other branch is sharper still —
-- with no override given it runs
--
--     update guardrail_rules set active = false ...
--
-- and 155 of the 171 rules in production are workspace-scoped, so approving a
-- "too strict" verdict can DEACTIVATE a guardrail that protects every employee.
--
-- After this migration a scoped user must be responsible for the employee the
-- cluster came from — but the rule they create or switch off still applies
-- workspace-wide. That is a product design question (should a learned behaviour
-- publish at employee scope by default, given guardrail_rules already supports
-- scope = 'employee' and 16 rules use it?) and NOT a scoping bug, so it is
-- written up rather than changed here. Changing it would alter what the feature
-- does, which is not this wave's business.
--
-- ── Shape ─────────────────────────────────────────────────────────────────
-- de_learned_behavior_clusters.de_id is NOT NULL, so the plain guard is right —
-- no unattributed case exists. Refuses through this function's own {ok:false}
-- envelope (bad shape to raise where every sibling failure returns), placed
-- after the tenant and is_active checks so the cheaper ones still fail first.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_branch text := '  if v_cluster.verdict_type = ''correction'' then';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_learned_behavior';
  IF v_src IS NULL THEN RAISE EXCEPTION '416: approve_learned_behavior not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '416: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  -- NB: no bare token in the comment — the wave counts occurrences of it to
  -- verify guard counts, and a comment mention would inflate that (mig 414).
  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/416). The cluster belongs to one employee and',
    '  -- de_learned_behavior_clusters.de_id is NOT NULL, so no null case.',
    '  -- NOTE the resulting guardrail rule is WORKSPACE-scoped by default; this',
    '  -- guard bounds who may approve, not how far the rule reaches. See header.',
    '  if not public.can_access_de(v_cluster.de_id) then',
    '    return jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  end if;',
    ''], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_branch, ''))) / length(a_branch);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '416: expected 1 verdict branch to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_branch, v_guard || a_branch);
  IF v_new = v_src THEN
    RAISE EXCEPTION '416: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_calls int; v_nullable text; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_learned_behavior';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_calls  := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_guards <> 1 OR v_calls <> 1 THEN
    RAISE EXCEPTION '416: expected exactly 1 guard (token %, calls %) — a comment may be inflating the count', v_guards, v_calls;
  END IF;
  IF v_def NOT LIKE '%''not_responsible_for_de''%' THEN
    RAISE EXCEPTION '416: the guard does not refuse — an actor must refuse explicitly, not filter';
  END IF;

  -- Order: tenant checks first, then scope, then every guardrail mutation.
  IF position('not_tenant_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '416: the scope guard runs before the tenant check';
  END IF;
  IF position('can_access_de' in v_def) > position('insert into guardrail_rules' in v_def)
     OR position('can_access_de' in v_def) > position('update guardrail_rules' in v_def)
     OR position('can_access_de' in v_def) > position('update de_learned_behavior_clusters' in v_def) THEN
    RAISE EXCEPTION '416: the guard lands after a guardrail or cluster mutation';
  END IF;
  -- The deactivate branch is the sharpest effect in the function; it must still
  -- be behind the guard and must still exist.
  IF v_def NOT LIKE '%set active = false%' THEN
    RAISE EXCEPTION '416: the deactivate branch was lost — approve would become a silent no-op';
  END IF;
  IF v_def NOT LIKE '%not_proposed%' OR v_def NOT LIKE '%no_target_rule%' OR v_def NOT LIKE '%pattern_required%' THEN
    RAISE EXCEPTION '416: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- The NOT NULL claim justifies the plain (non-null-tolerant) guard shape.
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'de_learned_behavior_clusters' AND column_name = 'de_id';
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION '416: de_learned_behavior_clusters.de_id is nullable — this needs the null-tolerant shape';
  END IF;

  -- Runtime smoke test: an unknown cluster must return not_proposed in contract.
  SELECT public.approve_learned_behavior('00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL) INTO v_out;
  IF v_out->>'error' <> 'not_proposed' THEN
    RAISE EXCEPTION '416: expected not_proposed, got %', coalesce(v_out::text, 'null');
  END IF;

  RAISE NOTICE '416: approve_learned_behavior guarded. OPEN QUESTION for the founder — the resulting guardrail rule is workspace-scoped by default; the guard bounds the approver, not the reach.';
END $assert$;

NOTIFY pgrst, 'reload schema';
