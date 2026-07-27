-- 425_guard_assess_definition_of_done.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP C — "verify before skipping". See docs/30.
--
-- ⚠ THIS IS A CROSS-TENANT HOLE, FOUND BY NOT TRUSTING THE CLASSIFICATION. ─
-- docs/30 lists assess_definition_of_done under group C: "reached by triggers
-- or the service role, not by users... left alone deliberately". Measured, that
-- is false. It is not a trigger function (RETURNS jsonb), and `authenticated`
-- holds EXECUTE — so any signed-up user can call it over PostgREST.
--
-- And it has NO CALLER CHECK OF ANY KIND. It takes p_tenant_id as a PARAMETER
-- and never compares it to the caller's workspace, exactly like
-- analytics_de_workload before migration 398. So any signed-in user could ask
-- any tenant: how many gated actions are pending, how many account and
-- opportunity write-backs await approval, how many outbound drafts are sitting
-- unapproved. That is a live read of another company's approval backlog.
--
-- Signup is live, so `authenticated` is one email address away from anyone.
--
-- ── The fix is the tenant axis, not the DE axis ───────────────────────────
-- Nothing here is per-employee: the function answers "is this scope of work
-- finished, or is something still pending approval" for a tenant + scope. There
-- is no de_id to scope to, so can_access_de is the wrong tool and is NOT used.
-- The missing check is workspace membership, and that is what is added — the
-- same shape resolve_action_execution_for_task already uses two files over.
--
-- ── Why the `auth.uid() IS NOT NULL` prefix is correct here ───────────────
-- Verified, not assumed: this is called by the connector-hub edge function and
-- by _shared/defOfDone.ts through `admin.rpc(...)`, i.e. with the SERVICE ROLE,
-- whose JWT has no `sub` — so auth.uid() is NULL on those paths. It is also
-- composed into conclude_objective_verified. A check without the prefix would
-- break the definition-of-done evaluation everywhere.
--
-- anon does NOT hold EXECUTE, so this is one of the ~31 deliberate uses of that
-- shape, not the banned anon-executable-and-fail-open combination. The
-- assertion below fails the migration if anon ever gains EXECUTE.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_begin text := 'begin';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'assess_definition_of_done';
  IF v_src IS NULL THEN RAISE EXCEPTION '425: assess_definition_of_done not found'; END IF;

  IF v_src ILIKE '%not authorized for this workspace%' THEN
    RAISE NOTICE '425: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  -- Anchor on the declaration terminator, not a bare `begin`: `begin` appears
  -- inside the body too, and a bare match would splice into the wrong place.
  a_begin := 'v_gated_task uuid;' || v_eol || 'begin';

  v_guard := array_to_string(ARRAY[
    'v_gated_task uuid;',
    'begin',
    -- ⚠ TWO apostrophes escapes to ONE inside this dollar-quoted block. Four
    -- produces a doubled quote and a syntax error — which is what a first run
    -- of this migration did, and why it rolled back rather than half-applying.
    '  -- Tenant guard (mig 425). This function took p_tenant_id as a parameter',
    '  -- and never checked it — any signed-in user could read the approval',
    '  -- backlog of any other workspace. NOT a DE-scoping fix: nothing here is',
    '  -- per-employee, so can_access_de is the wrong tool and is not used.',
    '  --',
    '  -- The auth.uid() prefix is deliberate and load-bearing: connector-hub and',
    '  -- _shared/defOfDone.ts call this with the SERVICE ROLE, whose JWT has no',
    '  -- sub, so auth.uid() is NULL there. anon holds no EXECUTE (asserted by the',
    '  -- migration), so the fail-open path is not reachable from the internet.',
    '  if auth.uid() is not null',
    '     and not exists (select 1 from profiles p where p.user_id = auth.uid()',
    '                       and (p.tenant_id = p_tenant_id or p.layer = ''platform'')) then',
    '    raise exception ''not authorized for this workspace'';',
    '  end if;',
    ''], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_begin, ''))) / length(a_begin);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '425: expected 1 declaration terminator to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_begin, v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '425: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_out jsonb; v_tenant uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'assess_definition_of_done';

  IF v_def NOT LIKE '%not authorized for this workspace%' THEN
    RAISE EXCEPTION '425: the tenant guard is not present';
  END IF;
  IF v_def NOT LIKE '%p.tenant_id = p_tenant_id or p.layer = ''platform''%' THEN
    RAISE EXCEPTION '425: the guard does not compare p_tenant_id to the caller workspace';
  END IF;

  -- ⚠ The premise that makes the auth.uid() prefix acceptable.
  IF has_function_privilege('anon', 'public.assess_definition_of_done(uuid,text,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '425: anon holds EXECUTE — the auth.uid() prefix is now an unauthenticated read path. REVOKE first.';
  END IF;

  -- The guard must run before any of the four counting reads.
  IF position('not authorized for this workspace' in v_def) > position('from action_executions ae' in v_def)
     OR position('not authorized for this workspace' in v_def) > position('account_writeback_requests' in v_def)
     OR position('not authorized for this workspace' in v_def) > position('outbound_drafts' in v_def) THEN
    RAISE EXCEPTION '425: the guard lands after a read — the backlog is counted before the caller is checked';
  END IF;

  -- The fail-CLOSED anchor (d) is the product guarantee: a missing correlation
  -- must never pass as "nothing pending". Losing it would be worse than the
  -- hole being closed.
  IF v_def NOT LIKE '%v_unresolved := true%' OR v_def NOT LIKE '%last_gated_human_task_id%' THEN
    RAISE EXCEPTION '425: the fail-closed agentic_run anchor was lost — an unresolved gate could pass as verified';
  END IF;
  IF v_def NOT LIKE '%pending_count%' OR v_def NOT LIKE '%verified%' THEN
    RAISE EXCEPTION '425: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test on the SERVICE PATH: postgres has a null auth.uid(),
  -- exactly like the service role, so the guard must be bypassed and the
  -- function must still return its contract.
  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    SELECT public.assess_definition_of_done(v_tenant, 'agentic_run',
             '00000000-0000-0000-0000-000000000000'::uuid, NULL) INTO v_out;
    IF v_out->>'verified' IS NULL OR v_out->>'pending_count' IS NULL THEN
      RAISE EXCEPTION '425: the function no longer returns its contract on the service path';
    END IF;
  END IF;

  RAISE NOTICE '425: CROSS-TENANT HOLE CLOSED. docs/30 classified this as internal; it is authenticated-executable and had no caller check at all.';
END $assert$;

NOTIFY pgrst, 'reload schema';
