-- 431_guard_list_de_skills.sql
-- ============================================================================
-- P0-1 from docs/32-pre-start-reports/02-permission-matrix.md (audit stream),
-- independently verified here against live pg_proc and live grants before any
-- change. Migration numbers 431+ taken by this stream; 430 is reserved for the
-- suspension session.
--
-- ⚠ THE ONLY FUNCTION IN THE REPORT THAT IS READABLE WITHOUT AN ACCOUNT. ───
-- list_de_skills(p_de_id) is SECURITY DEFINER, `language sql`, and has
-- **no authorization of any kind** — no tenant check, no auth.uid(), nothing.
-- It carries EXECUTE for both `anon` AND `PUBLIC`. Anyone on the internet with
-- a digital-employee UUID reads that employee's skill profile: proficiency,
-- sample size, signal value, and the human-written assessment text.
--
-- Measured live: 580 rows in de_skills, across 116 employees in 16 tenants.
--
-- The other findings need at least a signed-up account. This one needs nothing,
-- because it has no check to fail. It escaped the migration-330 anon sweep.
--
-- ── Two fixes, because either alone is insufficient ───────────────────────
-- 1. REVOKE from PUBLIC and anon. Without this the function stays callable by
--    the internet, and a predicate that merely returns an empty set still
--    leaks the shape of the API and burns a query on every hit.
-- 2. A predicate, because REVOKE alone leaves it cross-tenant for every signed
--    up user — and signup is live, so `authenticated` is one email away.
--
-- ⚠ REVOKE must strip PUBLIC. `authenticated` and `anon` are both members of
-- PUBLIC, so `REVOKE ... FROM anon` alone is a silent no-op — the exact mistake
-- migration 361 shipped. And ON ROUTINE, not ON FUNCTION (42809 on procedures).
--
-- ── Why a predicate and not a RAISE ───────────────────────────────────────
-- `language sql` cannot raise. The same situation as analytics_de_workload
-- (mig 398): the guard goes into the WHERE clause, and a caller who fails it
-- gets an empty list rather than an error. For a reader that is the correct
-- shape anyway — group A filters, it does not refuse.
--
-- ⚠ PRECEDENCE. The existing WHERE is `c.tenant_id IS NULL OR c.tenant_id =
-- (...)`. AND binds tighter than OR, so appending `AND <guard>` unparenthesised
-- would guard ONLY the second branch and leave every built-in catalog row
-- (tenant_id IS NULL) — which is the branch carrying the joined de_skills
-- data — completely open. The existing disjunction is therefore wrapped in
-- brackets first. This is the whole bug, and it would have looked fixed.
--
-- Caller checked before revoking: src/pages/tenant/LiveWorkforceDEs.tsx:707 is
-- the only call site, and it is an authenticated browser call. No edge function
-- calls it (the service role bypasses GRANTs regardless).
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_where text; v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'list_de_skills';
  IF v_src IS NULL THEN RAISE EXCEPTION '431: list_de_skills not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '431: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  a_where := array_to_string(ARRAY[
    '     WHERE c.tenant_id IS NULL',
    '        OR c.tenant_id = (SELECT tenant_id FROM digital_employees WHERE id = p_de_id)'], v_eol);

  v_guard := array_to_string(ARRAY[
    '     -- Guard (mig 431). NOTE THE BRACKETS: AND binds tighter than OR, so',
    '     -- without them this would guard only the second branch and leave every',
    '     -- built-in catalog row — the branch carrying the joined skill data —',
    '     -- wide open, while looking fixed.',
    '     WHERE (c.tenant_id IS NULL',
    '        OR c.tenant_id = (SELECT tenant_id FROM digital_employees WHERE id = p_de_id))',
    '       AND EXISTS (',
    '             SELECT 1 FROM digital_employees d',
    '              WHERE d.id = p_de_id',
    '                AND (coalesce(auth.role(), '''') = ''service_role''',
    '                     OR d.tenant_id = public.auth_tenant_id())',
    '                AND public.can_access_de(d.id))'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_where, ''))) / length(a_where);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '431: expected 1 catalog WHERE clause, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_where, v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '431: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

-- Strip PUBLIC as well as anon, or this is a no-op (mig 361/365 lesson).
REVOKE ALL ON ROUTINE public.list_de_skills(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.list_de_skills(uuid) TO authenticated;

DO $assert$
DECLARE v_def text; v_calls int; v_json json;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'list_de_skills';

  v_calls := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_calls <> 1 THEN
    RAISE EXCEPTION '431: expected exactly 1 scope guard, found %', v_calls;
  END IF;

  -- ⚠ THE PRECEDENCE ASSERTION. If the disjunction lost its brackets the guard
  -- would bind to the second branch only, and the built-in catalog rows — the
  -- ones joined to de_skills — would still be world-readable.
  IF v_def NOT LIKE '%WHERE (c.tenant_id IS NULL%' THEN
    RAISE EXCEPTION '431: the tenant disjunction is not bracketed — the guard binds to one branch only and the data is still open';
  END IF;
  IF v_def NOT LIKE '%auth_tenant_id()%' THEN
    RAISE EXCEPTION '431: the tenant gate is missing — the function would stay cross-tenant';
  END IF;
  -- de-work does not call this, but keep the service-role passthrough honest:
  -- if it is ever called from a worker, a null auth_tenant_id must not blank it.
  IF v_def NOT LIKE '%= ''service_role''%' THEN
    RAISE EXCEPTION '431: the service_role passthrough was lost';
  END IF;

  -- The grants: PUBLIC and anon gone, authenticated kept (the browser needs it).
  IF has_function_privilege('anon', 'public.list_de_skills(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '431: anon still holds EXECUTE — the internet can still read this';
  END IF;
  IF has_function_privilege('public', 'public.list_de_skills(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '431: PUBLIC still holds EXECUTE — REVOKE FROM anon alone is a no-op, strip PUBLIC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.list_de_skills(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '431: authenticated lost EXECUTE — LiveWorkforceDEs.tsx:707 would break';
  END IF;

  IF v_def NOT LIKE '%skill_catalog%' OR v_def NOT LIKE '%de_skills%'
     OR v_def NOT LIKE '%Not yet assessed%' THEN
    RAISE EXCEPTION '431: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test: postgres is in no workspace and is not service_role, so
  -- the guard must produce an EMPTY list rather than the whole catalog. This is
  -- the one assertion that measures behaviour, not text.
  SELECT public.list_de_skills('00000000-0000-0000-0000-000000000000'::uuid) INTO v_json;
  IF v_json::text <> '[]' THEN
    RAISE EXCEPTION '431: an unscoped caller still received rows: %', left(v_json::text, 200);
  END IF;

  RAISE NOTICE '431: list_de_skills closed. Was internet-readable with no check at all — 580 skill rows over 116 employees in 16 tenants.';
END $assert$;

NOTIFY pgrst, 'reload schema';
