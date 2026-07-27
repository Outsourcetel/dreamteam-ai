-- 450_revoke_public_anon_employee_file_groupF.sql
-- ============================================================================
-- GROUP F — PUBLIC-EXECUTE housekeeping on the Employee-File-reachable set.
--
-- The docs/32 matrix listed 12 anon-executable RPCs among the 106. Re-derived
-- LIVE 2026-07-27 (after Wave-2 migs 431-441 and the 444 anon sweep, both
-- verified applied): only SEVEN remain holding PUBLIC and/or anon EXECUTE.
-- The rest were closed by 431 (list_de_skills), 433 (set_de_external_reply_mode),
-- 439 (cancel_case_continuation) and 444 (create_de_mission,
-- create_de_team_mission, set_de_mission_state).
--
-- The seven, with live-verified fail-closed proof (read from
-- pg_get_functiondef this hour, not from migration files):
--
--   governance_decide_proposal(uuid,text,uuid)   anon only (no PUBLIC entry).
--     Gated by governance_user_can_decide(): EXISTS over profiles on
--     auth.uid() -> false for anon. Fails closed (returns not_authorized).
--   list_consultable_for_de(uuid)                PUBLIC + anon.
--     Every branch pins tenant_id = auth_tenant_id() -> NULL for anon -> [].
--   list_de_memory_grouped(uuid,integer)         PUBLIC + anon.
--     Same auth_tenant_id() pin -> [] for anon.
--   set_de_supervisor(uuid,boolean)              PUBLIC + anon.
--     is_platform_admin() OR owner/admin role gate; both false for anon -> RAISE.
--   set_de_voice(uuid,text,integer)              anon only (no PUBLIC entry).
--     auth_tenant_id() NULL -> RAISE 'not a member of any tenant'.
--   list_certification_types()                   PUBLIC + anon.  <-- NOT fully closed
--   list_skill_categories()                      PUBLIC + anon.  <-- NOT fully closed
--     Both filter WHERE tenant_id IS NULL OR tenant_id = auth_tenant_id(),
--     so anon receives the GLOBAL catalog rows (platform-wide labels). Low
--     sensitivity, but a genuine unauthenticated read of platform content —
--     the two are the only ones in this group where the revoke changes
--     observable behaviour for the internet.
--
-- Widget / anon-flow analysis (the "must keep anon" test), re-verified:
--   public/widget.js calls only functions/v1/widget-ask; widget-ask and
--   de-answer build service-role clients (bypass GRANTs); EmbedPage/EmbedWidget
--   call verify_embed_token + de_answer_headless. NONE of the seven appears in
--   public/, supabase/functions/, or any embed component. Anon genuinely needs
--   none of them.
--
-- Caller analysis (mig-365 criterion — a revoke can only break browser code,
-- because edge functions use the service-role key, which can_access_de and
-- GRANT-bypass both wave through):
--   governance_decide_proposal  src/lib/governanceAiApi.ts:145,155   signed-in
--   list_certification_types    src/lib/roleConfigApi.ts:108         signed-in
--   list_consultable_for_de     src/pages/tenant/LiveWorkforceDEs.tsx:1717
--   list_de_memory_grouped      src/lib/deWorkbenchApi.ts:151        signed-in
--   list_skill_categories       src/lib/roleConfigApi.ts:102         signed-in
--   set_de_supervisor           src/lib/digitalEmployeesApi.ts:339   signed-in
--   set_de_voice                src/pages/tenant/LiveWorkforceDEs.tsx:1815
-- Zero supabase/functions/ callers, zero public/ callers, and zero database-
-- side plpgsql callers (prosrc scan across pg_proc, verified live). Every
-- caller runs with the `authenticated` role, which keeps its EXPLICIT grant
-- (present in all seven ACLs today) and is re-granted below anyway.
--
-- Mechanics (mig-365 + mig-444 lessons): REVOKE names PUBLIC explicitly —
-- revoking anon alone is a silent no-op while PUBLIC holds the privilege —
-- and uses ON ROUTINE. `authenticated` is a member of PUBLIC, so the assert
-- that authenticated KEPT execute is the one that matters more than the revoke.
-- ============================================================================

DO $sweep$
DECLARE
  v_sig text;
  v_sigs text[] := ARRAY[
    'public.governance_decide_proposal(uuid,text,uuid)',
    'public.list_certification_types()',
    'public.list_consultable_for_de(uuid)',
    'public.list_de_memory_grouped(uuid,integer)',
    'public.list_skill_categories()',
    'public.set_de_supervisor(uuid,boolean)',
    'public.set_de_voice(uuid,text,integer)'
  ];
  v_n int := 0;
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    -- Refuse to run against a signature that does not exist: a typo would
    -- otherwise revoke nothing and report success.
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'groupF: % does not exist — refusing to claim a revoke that cannot have happened', v_sig;
    END IF;

    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM PUBLIC, anon', v_sig);
    EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO authenticated, service_role', v_sig);
    v_n := v_n + 1;
  END LOOP;

  IF v_n <> 7 THEN
    RAISE EXCEPTION 'groupF: expected 7 functions, processed %', v_n;
  END IF;
  RAISE NOTICE 'groupF: swept % functions', v_n;
END $sweep$;

DO $assert$
DECLARE
  v_sig text;
  v_sigs text[] := ARRAY[
    'public.governance_decide_proposal(uuid,text,uuid)',
    'public.list_certification_types()',
    'public.list_consultable_for_de(uuid)',
    'public.list_de_memory_grouped(uuid,integer)',
    'public.list_skill_categories()',
    'public.set_de_supervisor(uuid,boolean)',
    'public.set_de_voice(uuid,text,integer)'
  ];
  v_bad int;
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'groupF: anon still holds EXECUTE on %', v_sig;
    END IF;
    -- The no-op detector: revoking anon while PUBLIC still holds the
    -- privilege changes nothing (the exact failure shape of mig 361).
    IF has_function_privilege('public', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'groupF: PUBLIC still holds EXECUTE on % — revoke was a no-op', v_sig;
    END IF;
    -- The assert that matters more than the revoke: authenticated is a member
    -- of PUBLIC, so REVOKE ALL FROM PUBLIC could have stripped a signed-in
    -- surface's only route to EXECUTE. If this fires, the governance panel,
    -- Employee File consult/memory/voice panels or the hire config just broke.
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'groupF: authenticated LOST EXECUTE on % — a signed-in surface is broken, roll back', v_sig;
    END IF;
    IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'groupF: service_role LOST EXECUTE on %', v_sig;
    END IF;
  END LOOP;

  -- Belt and braces at the proacl level, and across ALL overloads of these
  -- names (the per-signature loop would miss a second arity carrying a grant):
  -- no pg_proc row with any of the seven names may retain a PUBLIC (grantee=0)
  -- or anon EXECUTE entry.
  SELECT count(*) INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname IN ('governance_decide_proposal','list_certification_types',
                      'list_consultable_for_de','list_de_memory_grouped',
                      'list_skill_categories','set_de_supervisor','set_de_voice')
    AND (
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
      OR has_function_privilege('anon', p.oid, 'EXECUTE')
    );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'groupF: % overload(s) of the seven names still carry PUBLIC or anon EXECUTE in proacl', v_bad;
  END IF;

  -- Exactly one arity per name — this migration assumed seven signatures cover
  -- seven names; if an overload appeared, the assumption must fail loudly.
  SELECT count(*) INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname IN ('governance_decide_proposal','list_certification_types',
                      'list_consultable_for_de','list_de_memory_grouped',
                      'list_skill_categories','set_de_supervisor','set_de_voice');
  IF v_bad <> 7 THEN
    RAISE EXCEPTION 'groupF: expected exactly 7 pg_proc rows across the seven names, found %', v_bad;
  END IF;

  -- Grants-only migration: the in-body gates that make these fail closed must
  -- be untouched. Asserting PRESENCE of each gate token in the live definition.
  IF pg_get_functiondef('public.governance_decide_proposal(uuid,text,uuid)'::regprocedure)
       NOT LIKE '%governance_user_can_decide%' THEN
    RAISE EXCEPTION 'groupF: governance_decide_proposal lost its decide gate — bodies were not supposed to change';
  END IF;
  IF pg_get_functiondef('public.set_de_supervisor(uuid,boolean)'::regprocedure)
       NOT LIKE '%auth_has_tenant_role%' THEN
    RAISE EXCEPTION 'groupF: set_de_supervisor lost its role gate';
  END IF;
  IF pg_get_functiondef('public.set_de_voice(uuid,text,integer)'::regprocedure)
       NOT LIKE '%auth_has_tenant_role%' THEN
    RAISE EXCEPTION 'groupF: set_de_voice lost its role gate';
  END IF;
  IF pg_get_functiondef('public.list_consultable_for_de(uuid)'::regprocedure)
       NOT LIKE '%auth_tenant_id%'
     OR pg_get_functiondef('public.list_de_memory_grouped(uuid,integer)'::regprocedure)
       NOT LIKE '%auth_tenant_id%'
     OR pg_get_functiondef('public.list_certification_types()'::regprocedure)
       NOT LIKE '%auth_tenant_id%'
     OR pg_get_functiondef('public.list_skill_categories()'::regprocedure)
       NOT LIKE '%auth_tenant_id%' THEN
    RAISE EXCEPTION 'groupF: a reader lost its auth_tenant_id pin';
  END IF;

  RAISE NOTICE 'groupF: 7 functions stripped of PUBLIC + anon; authenticated + service_role preserved on all; bodies untouched. The Employee-File-reachable set now has zero PUBLIC/anon EXECUTE grants.';
END $assert$;

NOTIFY pgrst, 'reload schema';
