-- 433_role_gate_de_external_reply_mode.sql
-- ============================================================================
-- P0-3 from docs/32-pre-start-reports/02-permission-matrix.md, independently
-- verified against live pg_proc before changing anything.
--
-- set_de_external_reply_mode(p_de_id, p_mode) flips a digital employee between
-- 'draft' — every outbound reply waits for a human — and 'auto', where it
-- answers customers directly with nobody in the loop. The audit stream calls it
-- the single most governance-critical toggle in the product, and that is not an
-- overstatement: it is the switch between "an AI drafts, a person sends" and
-- "an AI speaks to your customers unsupervised".
--
-- It checks workspace membership (or platform admin) and **no role at all**. So
-- any member of the workspace can turn it on. That is the role axis missing on
-- the one setting where it matters most.
--
-- Measured live: 1 employee is currently on 'auto'.
--
-- ── What I verified that the report did not mention ──────────────────────
-- This function also carries EXECUTE for `anon` AND `PUBLIC`. That looks worse
-- than it is: the body opens with
--
--     if auth.uid() is null then raise exception 'not authenticated'; end if;
--
-- so anon fails closed on the first line — this is NOT the fail-open shape
-- migration 369 fixed, and it is why the invariant suite stays green. The
-- grants are inert rather than dangerous. They are revoked anyway, because an
-- inert grant on a governance toggle is one refactor away from being a live
-- one, and nothing legitimate uses it: the only caller is an authenticated
-- browser call.
--
-- ── Owner/admin, deliberately NOT manager ────────────────────────────────
-- docs/29 puts the DE reporting line at primary → manager → executive, and a
-- manager can approve work and move the trust dial. Letting an employee answer
-- customers with no human in the loop is a step beyond approving its drafts: it
-- removes the approval step entirely, for every future message. That belongs
-- with the roles accountable for the workspace, which is why this uses
-- ['tenant_owner','tenant_admin'] and not the three-role array used elsewhere.
--
-- The membership check is KEPT, not replaced — role and membership are separate
-- axes and both must hold.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_auth text := '  if not (is_platform_admin() or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = v_tenant)) then';
  a_end  text; v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_de_external_reply_mode';
  IF v_src IS NULL THEN RAISE EXCEPTION '433: set_de_external_reply_mode not found'; END IF;

  IF v_src ILIKE '%auth_has_tenant_role%' THEN
    RAISE NOTICE '433: already role-gated, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  a_end := '  update digital_employees set external_reply_mode = p_mode where id = p_de_id;';

  v_guard := array_to_string(ARRAY[
    '  -- Role gate (mig 433). Membership above proves WHICH WORKSPACE; this',
    '  -- proves the caller is accountable for it. Owner/admin only, not manager:',
    '  -- switching to auto does not approve one reply, it removes the approval',
    '  -- step for every future one.',
    '  if not (is_platform_admin() or public.auth_has_tenant_role(ARRAY[''tenant_owner'', ''tenant_admin''])) then',
    '    raise exception ''insufficient_permission: turning external replies on or off requires an owner or admin'';',
    '  end if;',
    a_end], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_auth, ''))) / length(a_auth);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '433: expected 1 membership check, found % — the body changed, refusing to guess', v_hits;
  END IF;
  v_hits := (length(v_src) - length(replace(v_src, a_end, ''))) / length(a_end);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '433: expected 1 update statement, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_end, v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '433: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

-- Inert today (the null-uid check fires first), but an inert grant on a
-- governance toggle is one refactor from being a live one. Strip PUBLIC too.
REVOKE ALL ON ROUTINE public.set_de_external_reply_mode(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.set_de_external_reply_mode(uuid, text) TO authenticated;

DO $assert$
DECLARE v_def text; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_de_external_reply_mode';

  IF v_def NOT LIKE '%auth_has_tenant_role(ARRAY[''tenant_owner'', ''tenant_admin''])%' THEN
    RAISE EXCEPTION '433: the owner/admin role gate is not present';
  END IF;
  -- Both axes must hold. Losing membership while adding role would let an
  -- owner of ANY workspace flip an employee in ANOTHER one.
  IF v_def NOT LIKE '%not authorized for this workspace%' THEN
    RAISE EXCEPTION '433: the workspace-membership check was lost — an owner elsewhere could flip this employee';
  END IF;
  IF v_def NOT LIKE '%not authenticated%' THEN
    RAISE EXCEPTION '433: the null-uid check was lost — this function holds anon grants historically and must fail closed';
  END IF;
  IF v_def NOT LIKE '%mode must be draft or auto%' THEN
    RAISE EXCEPTION '433: the mode validation was lost in the rewrite';
  END IF;
  -- Order: authenticate, validate, resolve, membership, ROLE, then mutate.
  IF position('not authorized for this workspace' in v_def) > position('auth_has_tenant_role' in v_def) THEN
    RAISE EXCEPTION '433: the role gate runs before the membership check';
  END IF;
  IF position('auth_has_tenant_role' in v_def) > position('update digital_employees' in v_def) THEN
    RAISE EXCEPTION '433: the role gate lands AFTER the update — the toggle flips before the caller is checked';
  END IF;

  IF has_function_privilege('anon', 'public.set_de_external_reply_mode(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '433: anon still holds EXECUTE';
  END IF;
  IF has_function_privilege('public', 'public.set_de_external_reply_mode(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '433: PUBLIC still holds EXECUTE — strip PUBLIC, not just anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.set_de_external_reply_mode(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '433: authenticated lost EXECUTE — the governance toggle would be unusable';
  END IF;

  -- Runtime smoke test: postgres has a null auth.uid(), so the first gate fires.
  BEGIN
    PERFORM public.set_de_external_reply_mode('00000000-0000-0000-0000-000000000000'::uuid, 'auto');
  EXCEPTION WHEN others THEN v_raised := SQLERRM; v_fired := true;
  END;
  IF NOT v_fired OR v_raised NOT LIKE '%not authenticated%' THEN
    RAISE EXCEPTION '433: expected the authentication gate to fire first, got: %', coalesce(v_raised, '(nothing raised)');
  END IF;

  RAISE NOTICE '433: external reply mode now requires owner/admin. Was any workspace member.';
END $assert$;

NOTIFY pgrst, 'reload schema';
