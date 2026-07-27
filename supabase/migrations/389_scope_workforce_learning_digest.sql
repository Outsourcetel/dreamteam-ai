-- 389_scope_workforce_learning_digest.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- get_workforce_learning_digest(p_days) has NO de_id parameter — it is a
-- whole-workspace roll-up by design, and SECURITY DEFINER, so migration 386's
-- restrictive policies on de_work_items, de_conversations and human_tasks are
-- bypassed inside it. A scoped user gets the workspace's entire volume,
-- escalation count and — in `ramp` — a NAMED LIST OF EVERY EMPLOYEE, including
-- the ones they have no relationship to.
--
-- ── What this migration scopes, and what it deliberately does not ──────────
-- FOUR reads are scoped here, and they are exactly the Wave-1 surfaces plus the
-- employee roster:
--   volume.work_done     de_work_items
--   volume.conversations de_conversations
--   volume.escalations   human_tasks
--   ramp                 digital_employees   ← a literal roster; the clearest leak
--
-- NOT scoped here, said plainly rather than left for someone to discover:
-- eval_judgments (quality), role_certifications, knowledge_docs,
-- knowledge_gap_clusters, workforce_entity_amendments and amendment_metrics all
-- carry DE attribution too. They are not Wave-1 tables and they are not on the
-- worklist, so scoping them is a later wave's decision, not something to slip in
-- here. Until then a scoped user still sees workspace-wide eval scores,
-- certification counts and knowledge activity from this function.
--
-- ── The null-de_id consequence, measured ───────────────────────────────────
-- human_tasks.de_id is NULL on 760 of 924 rows in production (82%).
-- can_access_de(NULL) is TRUE for owner/admin/manager and FALSE for a scoped
-- user, so the escalation count for a scoped user counts only tasks attached to
-- their own employees. That is the correct default-deny reading of an
-- unattributed task, and it is a real behavioural consequence: check it against
-- intent the first time somebody holds a scoped role.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  a_work text := 'WHERE tenant_id = v_tenant AND status = ''done'' AND updated_at >= v_since';
  a_conv text := 'WHERE tenant_id = v_tenant AND last_message_at >= v_since';
  -- human_tasks needs its FROM in the anchor: the bare WHERE below is character
  -- for character identical to the workforce_entity_amendments read further down.
  a_esc  text := E'FROM human_tasks\n        WHERE tenant_id = v_tenant AND created_at >= v_since';
  a_ramp text := 'AND COALESCE(d.lifecycle_status, ''active'') <> ''retired''';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_workforce_learning_digest';
  IF v_src IS NULL THEN RAISE EXCEPTION '389: get_workforce_learning_digest not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '389: already scoped, nothing to do';
    RETURN;
  END IF;

  -- Every anchor must appear exactly once before anything is edited. A previous
  -- attempt at this work "succeeded" while scoping zero functions; counting
  -- first is what makes that impossible to repeat silently.
  FOR v_hits IN
    SELECT (length(v_src) - length(replace(v_src, a, ''))) / length(a)
      FROM unnest(ARRAY[a_work, a_conv, a_esc, a_ramp]) a
  LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '389: an anchor matched % times instead of 1 — the body changed, refusing to guess', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_work, a_work || ' AND public.can_access_de(de_id)');
  v_new := replace(v_new, a_conv, a_conv || ' AND public.can_access_de(de_id)');
  v_new := replace(v_new, a_esc,  a_esc  || ' AND public.can_access_de(de_id)');
  v_new := replace(v_new, a_ramp, a_ramp || E'\n           -- DE scoping (mig 385/389): the ramp list names employees. Scope it\n           -- or a scoped user reads the whole roster off a "learning digest".\n           AND public.can_access_de(d.id)');

  IF v_new = v_src THEN
    RAISE EXCEPTION '389: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_workforce_learning_digest';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 4 THEN
    RAISE EXCEPTION '389: expected exactly 4 scope guards in the body, found %', v_guards;
  END IF;

  IF v_def NOT LIKE '%v_tenant := public.auth_tenant_id()%' THEN
    RAISE EXCEPTION '389: the tenant resolution was lost in the rewrite';
  END IF;
  -- Prove the far corners of a 5.8kB body survived. A truncated definition that
  -- still contains the guards would pass a naive check.
  IF v_def NOT LIKE '%recurring_issues_fixed%'
     OR v_def NOT LIKE '%fixes_reopened%'
     OR v_def NOT LIKE '%days_to_first_cert%'
     OR v_def NOT LIKE '%fitness_avg_delta%' THEN
    RAISE EXCEPTION '389: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runs as postgres: auth_tenant_id() is null, so the honest expectation is the
  -- not_permitted contract, not a digest. The check is that it still answers.
  SELECT public.get_workforce_learning_digest(7) INTO v_out;
  IF v_out->>'ok' IS NULL THEN
    RAISE EXCEPTION '389: the function no longer returns its ok/error contract';
  END IF;

  RAISE NOTICE '389: learning digest scoped on 4 reads (work items, conversations, escalations, ramp roster). eval_judgments / certifications / knowledge remain workspace-wide — a later wave.';
END $assert$;

NOTIFY pgrst, 'reload schema';
