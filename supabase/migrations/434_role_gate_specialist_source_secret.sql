-- 434_role_gate_specialist_source_secret.sql
-- ============================================================================
-- P0-4 from docs/32-pre-start-reports/02-permission-matrix.md, independently
-- verified against live pg_proc before changing anything. Completes the P0 set.
--
-- set_specialist_source_secret(p_source_id, p_secret) writes a credential into
-- Supabase Vault — either updating an existing secret or creating one — for a
-- specialist source. Its gate is a profiles join proving membership of the
-- source's tenant, with a service_role bypass. **No role check.**
--
-- So any member of the workspace can overwrite the stored credential for a
-- system a digital employee authenticates to.
--
-- ── Being precise about the severity, in both directions ─────────────────
-- It does NOT read the secret back — there is no path here that discloses an
-- existing credential. This is substitution, not exfiltration. That makes it
-- less bad than "any member can steal your API keys" and it should not be
-- described that way.
--
-- It is still serious: substituting a credential can break an integration
-- silently, or point an employee's authenticated access at something the
-- attacker controls. And `set_de_operate_login` — the same family, flagged in
-- the perimeter work (mig 365) as the worst outstanding item — is the reason
-- this family deserves the stricter gate rather than the convenient one.
--
-- Measured live: specialist_source_secrets has **0 rows**. So nothing can be
-- overwritten today; the first write would create the row. That is a reason
-- this is cheap to fix now, not a reason it is fine.
--
-- ── Owner/admin, matching 433 ────────────────────────────────────────────
-- Storing a customer's credential is an act of workspace accountability, not
-- day-to-day employee management. Same reasoning and same role array as the
-- external-reply toggle.
--
-- ── The service_role bypass is preserved deliberately ────────────────────
-- The existing gate opens with `coalesce(auth.role(), '') <> 'service_role' and
-- not exists (...)`, so trusted server paths skip the membership check. The new
-- role gate is placed INSIDE that same non-service branch, so provisioning and
-- connector flows that run as the service role are unaffected. A role gate
-- applied unconditionally would break them.
--
-- Caller checked: src/lib/specialistApi.ts:292 is an authenticated browser
-- call. It will now require owner/admin — intended, and worth knowing if a
-- non-admin ever ran specialist setup.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_raise text := '    raise exception ''not a member of this source''''s tenant'';';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_specialist_source_secret';
  IF v_src IS NULL THEN RAISE EXCEPTION '434: set_specialist_source_secret not found'; END IF;

  IF v_src ILIKE '%auth_has_tenant_role%' THEN
    RAISE NOTICE '434: already role-gated, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  -- Spliced INSIDE the existing non-service_role branch, immediately after the
  -- membership refusal, so trusted server paths keep skipping both checks.
  v_guard := array_to_string(ARRAY[
    a_raise,
    '  end if;',
    '',
    '  -- Role gate (mig 434). Inside the non-service branch on purpose: a gate',
    '  -- applied unconditionally would break provisioning and connector flows',
    '  -- that run as the service role. Storing a customer credential is an act',
    '  -- of workspace accountability, so owner/admin — same as mig 433.',
    '  if coalesce(auth.role(), '''') <> ''service_role''',
    '     and not (is_platform_admin() or public.auth_has_tenant_role(ARRAY[''tenant_owner'', ''tenant_admin''])) then',
    '    raise exception ''insufficient_permission: storing a source credential requires an owner or admin'';'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_raise, ''))) / length(a_raise);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '434: expected 1 membership refusal, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_raise, v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '434: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_specialist_source_secret';

  IF v_def NOT LIKE '%auth_has_tenant_role(ARRAY[''tenant_owner'', ''tenant_admin''])%' THEN
    RAISE EXCEPTION '434: the owner/admin role gate is not present';
  END IF;
  -- Membership must survive alongside it: both axes, as everywhere in this wave.
  IF v_def NOT LIKE '%not a member of this source%' THEN
    RAISE EXCEPTION '434: the tenant-membership check was lost in the rewrite';
  END IF;

  -- ⚠ TWO service_role escapes must remain — one per check. If the role gate
  -- were applied unconditionally, every server-side provisioning path that
  -- stores a credential would start raising.
  IF (length(v_def) - length(replace(v_def, '''service_role''', ''))) / length('''service_role''') < 2 THEN
    RAISE EXCEPTION '434: a service_role escape is missing — server-side credential provisioning would break';
  END IF;

  -- Order: refuse before writing to the vault, in both directions.
  IF position('auth_has_tenant_role' in v_def) > position('vault.update_secret' in v_def)
     OR position('auth_has_tenant_role' in v_def) > position('vault.create_secret' in v_def) THEN
    RAISE EXCEPTION '434: the role gate lands after a vault write — the credential is stored before the caller is checked';
  END IF;
  IF v_def NOT LIKE '%specialist_source_secrets%' THEN
    RAISE EXCEPTION '434: the body lost content — a stale or truncated definition was applied';
  END IF;
  IF has_function_privilege('anon', 'public.set_specialist_source_secret(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '434: anon holds EXECUTE on a credential writer';
  END IF;

  -- Runtime smoke test: postgres is not service_role and is a member of no
  -- workspace, so the membership refusal must fire before anything is written.
  BEGIN
    PERFORM public.set_specialist_source_secret('00000000-0000-0000-0000-000000000000'::uuid, 'x');
  EXCEPTION WHEN others THEN v_raised := SQLERRM; v_fired := true;
  END;
  IF NOT v_fired OR v_raised NOT LIKE '%not a member of this source%' THEN
    RAISE EXCEPTION '434: expected the membership gate to fire first, got: %', coalesce(v_raised, '(nothing raised)');
  END IF;

  RAISE NOTICE '434: credential writer now requires owner/admin. P0 set complete (431-434).';
END $assert$;

NOTIFY pgrst, 'reload schema';
