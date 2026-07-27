-- 397_scope_list_browser_operator.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- list_browser_operator(p_tenant_id, p_limit) lists every browser-operator task
-- in the workspace: which employee is driving a browser, what its goal is,
-- which domains it is allowed to touch, its credential policy, and its result.
-- It is SECURITY DEFINER and checks workspace membership only.
--
-- This one deserves a moment's thought about severity. Browser operations carry
-- a `credential_policy` and an `allowed_domains` list — it is the surface where
-- an employee acts against a customer's real systems with real credentials. The
-- goal text of another team's browser task is not something a scoped user
-- should be reading over their shoulder.
--
-- ── The fix ────────────────────────────────────────────────────────────────
-- One predicate on the task list. computer_use_tasks.de_id is NOT NULL, so
-- every task belongs to exactly one employee and there is no unattributed case
-- to decide about — unlike human_tasks, where 82% of rows carry no de_id.
--
-- The runtimes list below it is deliberately NOT scoped: a runtime is a piece
-- of shared infrastructure (is a browser worker alive and when was it last
-- seen), not an employee's work. Scoping it would hide the reason a scoped
-- user's own task is stuck.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  v_anchor text := 'WHERE c.tenant_id = p_tenant_id';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'list_browser_operator';
  IF v_src IS NULL THEN RAISE EXCEPTION '397: list_browser_operator not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '397: already scoped, nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '397: expected 1 task-list tenant filter, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, v_anchor,
    E'WHERE c.tenant_id = p_tenant_id\n      -- DE scoping (mig 385/397): browser tasks carry a credential policy and an\n      -- allowed-domain list. computer_use_tasks.de_id is NOT NULL, so every task\n      -- resolves to one employee. The RUNTIMES list below stays workspace-wide\n      -- on purpose — shared infrastructure, not anybody''s work product.\n      AND public.can_access_de(c.de_id)');

  IF v_new = v_src THEN
    RAISE EXCEPTION '397: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_out jsonb; v_tenant uuid; v_nullable text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'list_browser_operator';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '397: expected exactly 1 scope guard, found %', v_guards;
  END IF;

  -- The guard belongs on the TASK read. Two independent checks, because the
  -- table name computer_use_runtimes also appears inside the task query's own
  -- LEFT JOIN and is therefore useless as a position marker:
  --   a) it must reference c.de_id — `c` is the computer_use_tasks alias, and
  --      the runtimes statement below has no aliases at all;
  --   b) it must come before the runtimes statement, located by its INTO target.
  IF v_def NOT LIKE '%can_access_de(c.de_id)%' THEN
    RAISE EXCEPTION '397: the guard does not reference the task alias — it is not on the task read';
  END IF;
  IF position('can_access_de' in v_def) > position('INTO v_runtimes' in v_def) THEN
    RAISE EXCEPTION '397: the guard landed after the task read — tasks are still unscoped';
  END IF;
  IF v_def NOT LIKE '%not_tenant_member%' THEN
    RAISE EXCEPTION '397: the workspace-membership check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%credential_policy%'
     OR v_def NOT LIKE '%allowed_domains%'
     OR v_def NOT LIKE '%is_feature_enabled_internal%' THEN
    RAISE EXCEPTION '397: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- The no-null-case claim is load-bearing. Assert it rather than trusting it.
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'computer_use_tasks' AND column_name = 'de_id';
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION '397: computer_use_tasks.de_id is nullable — the null case this migration assumed away is real';
  END IF;

  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    SELECT public.list_browser_operator(v_tenant, 50) INTO v_out;
    IF v_out->>'ok' IS NULL THEN
      RAISE EXCEPTION '397: list_browser_operator no longer returns its contract';
    END IF;
  END IF;

  RAISE NOTICE '397: browser-operator task list scoped; runtimes intentionally left workspace-wide.';
END $assert$;

NOTIFY pgrst, 'reload schema';
