-- 441_role_gate_seed_trust_policies.sql
-- ============================================================================
-- P1 from docs/32, verified live — the last item in the ranked list.
--
-- seed_trust_policies() creates the workspace's default trust policies: the
-- criteria that decide when a digital employee may act without asking
-- (invoice_auto_send, answer_dock, answer_widget), each with its own pass-rate,
-- sample-size and guardrail-block thresholds. It checks tenant and active
-- account, and nothing else.
--
-- ── A role gate, not DE scoping ─────────────────────────────────────────
-- These rows are inserted with de_id = NULL: they are TENANT-WIDE policies, not
-- per-employee ones. can_access_de has nothing to test, so — as in 440 — the
-- missing axis is role, and reaching for the scoping predicate would invent a
-- relationship the data does not have.
--
-- Owner/admin, matching 433 and 434 rather than 440's manager+. Trust policy is
-- the ladder that governs how far every employee may go without a human; that
-- sits with the roles accountable for the workspace, and it is the same
-- boundary request_trust_promotion (mig 419) is measured against.
--
-- Bounded before and after: the insert is ON CONFLICT DO NOTHING, so a repeat
-- call cannot overwrite tuned criteria — it only fills gaps and returns the
-- current set. The exposure was "any member can materialise the defaults",
-- not "any member can loosen the ladder". Fixed anyway, for the same reason as
-- 440: bounded is not authorised.
--
-- The demo-tenant refusal and the deactivated-account check are preserved.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_anchor text := '  if v_tenant is null then';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='seed_trust_policies';
  IF v_src IS NULL THEN RAISE EXCEPTION '441: seed_trust_policies not found'; END IF;
  IF v_src ILIKE '%auth_has_tenant_role%' THEN RAISE NOTICE '441: already role-gated'; RETURN; END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  -- Anchor on the demo-tenant refusal: it is the last check before the insert,
  -- so the new gate slots in after every existing one.
  a_anchor := '    raise exception ''demo tenant uses the demo story — earned trust is a live-tenant feature'';' || v_eol || '  end if;';

  v_hits := (length(v_src) - length(replace(v_src, a_anchor, ''))) / length(a_anchor);
  IF v_hits <> 1 THEN RAISE EXCEPTION '441: expected 1 demo-tenant refusal, found %', v_hits; END IF;

  v_new := replace(v_src, a_anchor, array_to_string(ARRAY[
    a_anchor,
    '',
    '  -- Role gate (mig 441). These policies are tenant-wide (de_id is NULL), so',
    '  -- there is no employee to scope — the missing axis is role. Owner/admin,',
    '  -- matching migs 433/434: this is the ladder governing how far EVERY',
    '  -- employee may go without a human.',
    '  if not (is_platform_admin() or auth_has_tenant_role(ARRAY[''tenant_owner'', ''tenant_admin''])) then',
    '    raise exception ''insufficient_permission: seeding trust policy requires an owner or admin'';',
    '  end if;'], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION '441: edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='seed_trust_policies';
  IF v_def NOT LIKE '%auth_has_tenant_role(ARRAY[''tenant_owner'', ''tenant_admin''])%' THEN
    RAISE EXCEPTION '441: the owner/admin role gate is not present';
  END IF;
  IF v_def NOT LIKE '%demo tenant uses the demo story%' THEN
    RAISE EXCEPTION '441: the demo-tenant refusal was lost';
  END IF;
  IF v_def NOT LIKE '%account is deactivated%' THEN
    RAISE EXCEPTION '441: the deactivated-account check was lost';
  END IF;
  IF position('auth_has_tenant_role' in v_def) > position('insert into trust_policies' in v_def) THEN
    RAISE EXCEPTION '441: the role gate lands after the policies are seeded';
  END IF;
  -- ON CONFLICT DO NOTHING is what stops a repeat call overwriting tuned
  -- criteria. Losing it would turn a bounded seed into a reset.
  IF v_def NOT LIKE '%on conflict%do nothing%' THEN
    RAISE EXCEPTION '441: the ON CONFLICT DO NOTHING was lost — reseeding could overwrite tuned criteria';
  END IF;

  BEGIN
    PERFORM public.seed_trust_policies();
  EXCEPTION WHEN others THEN v_raised := SQLERRM; v_fired := true; END;
  IF NOT v_fired OR v_raised NOT LIKE '%no tenant for the current session%' THEN
    RAISE EXCEPTION '441: expected the no-tenant gate to fire first, got: %', coalesce(v_raised,'(nothing)');
  END IF;

  RAISE NOTICE '441: trust-policy seeding now requires owner/admin. P0+P1 set complete (431-441).';
END $assert$;

NOTIFY pgrst, 'reload schema';
