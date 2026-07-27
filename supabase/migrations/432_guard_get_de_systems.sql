-- 432_guard_get_de_systems.sql
-- ============================================================================
-- P0-2 from docs/32-pre-start-reports/02-permission-matrix.md, independently
-- verified against live pg_proc before changing anything.
--
-- get_de_systems(p_de_id) is SECURITY DEFINER, `language sql`, and has **no
-- authorization of any kind** — a single unguarded SELECT over
-- de_connected_systems. It is not anon-reachable, but signup is live, so
-- `authenticated` is one email address away from anyone, and 16 tenants share
-- this database. Any signed-up user could enumerate any employee's system
-- bindings in any workspace.
--
-- What that exposes is worse than a list of integrations: the row carries
-- can_read, can_write, can_verify, **can_operate**, the operate domain, and the
-- write_registry. That is a map of which digital employee can reach into which
-- customer system and how far it is allowed to go — reconnaissance for exactly
-- the surface migrations 414/415 and 397 were written to protect.
--
-- Measured live: 9 active bindings, 1 of them operate-capable.
--
-- ── ⚠ THE SERVICE-ROLE PASSTHROUGH IS LOAD-BEARING HERE ──────────────────
-- Unlike list_de_skills (431), this function has a MACHINE caller:
-- supabase/functions/de-work/index.ts calls it at lines 104 and 769 through an
-- `admin` client, i.e. with the SERVICE ROLE. A service-role JWT has no `sub`,
-- so auth.uid() and auth_tenant_id() are both NULL on that path.
--
-- A guard of the form `d.tenant_id = public.auth_tenant_id()` alone would
-- therefore return an EMPTY system list to de-work — and the failure would be
-- silent: the worker would simply believe every employee has no connected
-- systems and quietly stop doing integration work. No error, no alert. That is
-- the worst shape of breakage this codebase keeps producing, so the
-- service_role branch is explicit and asserted below.
--
-- can_access_de() already returns true for service_role by name; the tenant
-- comparison is the part that needed the escape.
--
-- ── Why a predicate and not a RAISE ───────────────────────────────────────
-- `language sql` cannot raise (same as 398 and 431). The guard goes in the
-- WHERE clause and an unauthorised caller gets '[]'. For a reader that is the
-- correct shape: group A filters rather than refusing.
--
-- Browser caller kept working: src/components/workforce/EmployeeFileStrip.tsx:37
-- is an authenticated call and `authenticated` retains EXECUTE.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_from text := '  FROM de_connected_systems t WHERE t.de_id = p_de_id AND t.active;';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_de_systems';
  IF v_src IS NULL THEN RAISE EXCEPTION '432: get_de_systems not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '432: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  FROM de_connected_systems t WHERE t.de_id = p_de_id AND t.active',
    '    -- Guard (mig 432). The service_role branch is NOT optional: de-work',
    '    -- calls this with an admin client whose JWT has no sub, so',
    '    -- auth_tenant_id() is NULL there. Without it the worker would silently',
    '    -- see every employee as having no connected systems and stop doing',
    '    -- integration work, with no error and no alert.',
    '    AND EXISTS (',
    '          SELECT 1 FROM digital_employees d',
    '           WHERE d.id = p_de_id',
    '             AND (coalesce(auth.role(), '''') = ''service_role''',
    '                  OR d.tenant_id = public.auth_tenant_id())',
    '             AND public.can_access_de(d.id));'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_from, ''))) / length(a_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '432: expected 1 FROM clause to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_from, v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '432: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_calls int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_de_systems';

  v_calls := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_calls <> 1 THEN
    RAISE EXCEPTION '432: expected exactly 1 scope guard, found %', v_calls;
  END IF;
  IF v_def NOT LIKE '%auth_tenant_id()%' THEN
    RAISE EXCEPTION '432: the tenant gate is missing — the function would stay cross-tenant';
  END IF;

  -- ⚠ THE ASSERTION THAT PROTECTS THE WORKER. Losing this branch does not
  -- error; it silently empties every system list de-work reads.
  IF v_def NOT LIKE '%coalesce(auth.role(), '''') = ''service_role''%' THEN
    RAISE EXCEPTION '432: the service_role passthrough is missing — de-work would silently see no connected systems';
  END IF;

  IF v_def NOT LIKE '%can_operate%' OR v_def NOT LIKE '%write_registry%'
     OR v_def NOT LIKE '%operate_domain_of%' THEN
    RAISE EXCEPTION '432: the body lost content — a stale or truncated definition was applied';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_de_systems(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '432: authenticated lost EXECUTE — EmployeeFileStrip.tsx:37 would break';
  END IF;
  IF has_function_privilege('anon', 'public.get_de_systems(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '432: anon gained EXECUTE somehow — this must not be internet-reachable';
  END IF;

  -- Runtime smoke test: postgres is in no workspace and is not service_role, so
  -- the guard must return an empty list rather than the bindings.
  SELECT public.get_de_systems('00000000-0000-0000-0000-000000000000'::uuid) INTO v_out;
  IF v_out::text <> '[]' THEN
    RAISE EXCEPTION '432: an unscoped caller still received bindings: %', left(v_out::text, 200);
  END IF;

  RAISE NOTICE '432: get_de_systems closed. Was a cross-tenant map of which employee can operate which customer system.';
END $assert$;

NOTIFY pgrst, 'reload schema';
