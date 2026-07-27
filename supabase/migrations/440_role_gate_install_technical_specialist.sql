-- 440_role_gate_install_technical_specialist.sql
-- ============================================================================
-- P1 from docs/32, verified live. install_technical_specialist() CREATES A
-- DIGITAL EMPLOYEE — a Technical Specialist, with a seeded charter — in the
-- caller's workspace. It checks that the caller has a tenant and an active
-- account, and nothing else.
--
-- ── A role gate, NOT can_access_de ──────────────────────────────────────
-- There is no employee to scope: this function brings one into existence.
-- can_access_de would have nothing to test, and reaching for it here would be
-- the same mistake the onboarding pair was reclassified for in group B —
-- inventing a relationship the data does not have. Hiring is a workspace act,
-- so the missing axis is role.
--
-- Manager and above, matching set_de_assignment: adding a member of the
-- workforce is management, not ownership. That is deliberately looser than the
-- owner/admin gate on 433 and 434, which govern credentials and unsupervised
-- customer contact.
--
-- The function is idempotent (returns the existing specialist if installed), so
-- the exposure was bounded — one extra employee per workspace, not unbounded
-- creation. Fixed because "bounded" is not "authorised", and because a
-- digital employee appearing in the roster with a charter nobody approved is
-- exactly the governance gap this product sells against.
--
-- The service_role branch is left exactly as found: it already refuses and
-- tells the caller to use direct inserts with an explicit tenant.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_anchor text := '  if not v_is_active then raise exception ''account is deactivated''; end if;';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='install_technical_specialist';
  IF v_src IS NULL THEN RAISE EXCEPTION '440: install_technical_specialist not found'; END IF;
  IF v_src ILIKE '%auth_has_tenant_role%' THEN RAISE NOTICE '440: already role-gated'; RETURN; END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  v_hits := (length(v_src) - length(replace(v_src, a_anchor, ''))) / length(a_anchor);
  IF v_hits <> 1 THEN RAISE EXCEPTION '440: expected 1 deactivated check, found %', v_hits; END IF;

  v_new := replace(v_src, a_anchor, array_to_string(ARRAY[
    a_anchor,
    '',
    '  -- Role gate (mig 440). Creating a digital employee is a management act.',
    '  -- Manager+ rather than owner/admin: hiring is looser than the credential',
    '  -- and unsupervised-reply gates in migs 433/434.',
    '  if not (is_platform_admin() or auth_has_tenant_role(ARRAY[''tenant_owner'', ''tenant_admin'', ''tenant_manager''])) then',
    '    raise exception ''insufficient_permission: adding a digital employee requires a manager'';',
    '  end if;'], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION '440: edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='install_technical_specialist';
  IF v_def NOT LIKE '%auth_has_tenant_role(ARRAY[''tenant_owner'', ''tenant_admin'', ''tenant_manager''])%' THEN
    RAISE EXCEPTION '440: the manager+ role gate is not present';
  END IF;
  IF v_def NOT LIKE '%account is deactivated%' THEN
    RAISE EXCEPTION '440: the deactivated-account check was lost';
  END IF;
  IF v_def NOT LIKE '%service role must use direct inserts%' THEN
    RAISE EXCEPTION '440: the service_role branch was lost';
  END IF;
  -- Gate before the insert, and after the tenant resolution it depends on.
  IF position('auth_has_tenant_role' in v_def) > position('insert into digital_employees' in v_def) THEN
    RAISE EXCEPTION '440: the role gate lands after the employee is created';
  END IF;
  IF v_def NOT LIKE '%already_installed%' THEN
    RAISE EXCEPTION '440: the idempotency check was lost — repeat calls would create duplicates';
  END IF;

  -- postgres has no profile, so the no_tenant path answers before the new gate.
  SELECT public.install_technical_specialist() INTO v_out;
  IF v_out->>'error' <> 'no_tenant' THEN
    RAISE EXCEPTION '440: expected no_tenant, got %', coalesce(v_out::text,'null');
  END IF;

  RAISE NOTICE '440: creating a specialist now requires manager+.';
END $assert$;

NOTIFY pgrst, 'reload schema';
