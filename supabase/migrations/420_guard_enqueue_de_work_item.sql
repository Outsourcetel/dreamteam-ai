-- 420_guard_enqueue_de_work_item.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — missions & work. See docs/30.
--
-- ⚠ THE ONLY REAL GAP IN THIS SUB-GROUP. ──────────────────────────────────
-- Its three siblings (create_de_mission, create_de_team_mission,
-- set_de_mission_state) are all gated to tenant_owner / tenant_admin /
-- tenant_manager, which can_access_de passes unconditionally — so 421-423 are
-- defence in depth. This one is different: its ONLY check is workspace
-- membership.
--
--     if auth.uid() is not null
--        and not exists (select 1 from profiles p where p.user_id = auth.uid()
--                          and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
--       raise exception 'not authorized to enqueue work for this tenant';
--
-- No role check at all. So ANY authenticated member of the workspace — a
-- tenant_user included — can queue work for ANY employee in it. That is the
-- assignment axis missing entirely, on the function that puts work into an
-- employee's queue.
--
-- ── ⚠ THE GUARD DELIBERATELY COPIES THE `auth.uid() IS NOT NULL` BYPASS ───
-- That shape is the one the perimeter work flagged as dangerous: the check does
-- not run when auth.uid() is null, and anon has a null uid. Replicating it
-- needs a reason, and here there is one — verified, not assumed:
--
--   * de-work (supabase/functions/de-work/index.ts) calls this through a
--     service-role client. Service-role JWTs carry no `sub`, so auth.uid() IS
--     NULL on that path. A bare `if not can_access_de(...)` would raise inside
--     the worker and stop the whole autonomy loop.
--   * NO database function calls it — checked across every plpgsql body — so
--     the edge function is the only machine caller to preserve.
--   * anon does NOT hold EXECUTE on it. The banned combination from the
--     perimeter invariants is anon-executable AND fail-open-on-null-uid;
--     with anon revoked, this is one of the ~31 deliberate, correct uses.
--
-- Copying the existing condition exactly means every path the current check
-- lets through unchallenged is still let through, and only real human callers
-- gain the new test. Strictly additive; it cannot break a worker.
--
-- The assertion block below FAILS THIS MIGRATION if anon ever holds EXECUTE,
-- so the premise that makes the bypass safe is checked rather than trusted.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_auth text; v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enqueue_de_work_item';
  IF v_src IS NULL THEN RAISE EXCEPTION '420: enqueue_de_work_item not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '420: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  -- Four spaces before `raise`, verified against the live body (LF endings, no
  -- CR). Guessing this cost one refused run — which is the anchor count doing
  -- its job rather than a near miss silently patching the wrong place.
  a_auth := array_to_string(ARRAY[
    '    raise exception ''not authorized to enqueue work for this tenant'';',
    '  end if;'], v_eol);

  v_guard := array_to_string(ARRAY[
    '',
    '  -- DE scoping (mig 385/420). The membership test above is the ONLY check',
    '  -- this function had — no role gate — so any workspace member could queue',
    '  -- work for any employee. This adds the assignment axis.',
    '  --',
    '  -- The `auth.uid() is not null` prefix MIRRORS the condition above on',
    '  -- purpose. de-work calls this with a service-role key, whose JWT has no',
    '  -- sub, so auth.uid() is NULL on that path; a bare guard would raise',
    '  -- inside the worker and stop the autonomy loop. anon does not hold',
    '  -- EXECUTE here (asserted by the migration), so the fail-open shape the',
    '  -- perimeter work warns about is not reachable from the internet.',
    '  if auth.uid() is not null and not public.can_access_de(p_de_id) then',
    '    raise exception ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  end if;'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_auth, ''))) / length(a_auth);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '420: expected 1 membership check to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_auth, a_auth || v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '420: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_calls int; v_id uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enqueue_de_work_item';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_calls  := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_guards <> 1 OR v_calls <> 1 THEN
    RAISE EXCEPTION '420: expected exactly 1 guard (token %, calls %)', v_guards, v_calls;
  END IF;
  IF v_def NOT LIKE '%raise exception ''not_responsible_for_de%' THEN
    RAISE EXCEPTION '420: the guard does not RAISE — this function contracts on raising';
  END IF;

  -- ⚠ THE PREMISE THAT MAKES THE BYPASS SAFE. If anon ever holds EXECUTE, this
  -- function becomes anon-executable AND fail-open on a null uid — precisely
  -- the combination the perimeter invariants forbid, and an unauthenticated
  -- write path into an employee's work queue. Fail the migration, loudly.
  IF has_function_privilege('anon',
       'public.enqueue_de_work_item(uuid,uuid,text,text,timestamptz,uuid,integer,uuid,jsonb,text,integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION '420: anon holds EXECUTE — the auth.uid()-is-not-null bypass is now an unauthenticated write path. REVOKE before guarding.';
  END IF;

  -- The bypass must be present and must match the existing one, or the worker
  -- breaks. Both conditions in one assertion.
  IF v_def NOT LIKE '%if auth.uid() is not null and not public.can_access_de(p_de_id) then%' THEN
    RAISE EXCEPTION '420: the guard does not mirror the trusted-server bypass — de-work would start failing';
  END IF;
  IF v_def NOT LIKE '%not authorized to enqueue work for this tenant%' THEN
    RAISE EXCEPTION '420: the workspace-membership check was lost in the rewrite';
  END IF;
  IF position('not authorized to enqueue work' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '420: the scope guard runs before the membership check';
  END IF;
  IF position('can_access_de' in v_def) > position('insert into de_work_items' in v_def) THEN
    RAISE EXCEPTION '420: the guard lands after the insert';
  END IF;
  -- The idempotency contract is load-bearing for the worker: the same key must
  -- always return the same id, or de-work will duplicate work.
  IF v_def NOT LIKE '%on conflict (tenant_id, idempotency_key)%'
     OR v_def NOT LIKE '%where idempotency_key is not null%' THEN
    RAISE EXCEPTION '420: the idempotency contract was lost — de-work would duplicate work items';
  END IF;

  -- Runtime smoke test on the SERVICE PATH, which is the one that must not
  -- break. postgres has a null auth.uid(), exactly like the service role, so
  -- the guard must be bypassed and the insert must fail only on the real FK.
  BEGIN
    SELECT public.enqueue_de_work_item(
      '00000000-0000-0000-0000-000000000000'::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid,
      'scope smoke test') INTO v_id;
    RAISE EXCEPTION '420: expected a foreign-key failure on a fake tenant/de, got id %', v_id;
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;  -- correct: the guard was bypassed for the null-uid caller, as designed
  WHEN others THEN
    IF SQLERRM LIKE '%not_responsible_for_de%' THEN
      RAISE EXCEPTION '420: the guard fired for a NULL-uid caller — this WILL break de-work';
    END IF;
    RAISE;
  END;

  RAISE NOTICE '420: enqueue_de_work_item guarded — a real gap: its only check was workspace membership, with no role gate at all.';
END $assert$;

NOTIFY pgrst, 'reload schema';
