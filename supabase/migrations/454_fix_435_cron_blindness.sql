-- 454_fix_435_cron_blindness.sql
-- ============================================================================
-- Repairs migration 435 — mine, applied this morning at 09:59Z. It has been
-- silently breaking four cron jobs ever since.
--
-- ── What broke ───────────────────────────────────────────────────────────
-- 435 added `and public.can_access_de(de.id)` to the outer employee list of
-- get_de_performance_metrics. can_access_de resolves a caller through
-- auth.role() / auth.uid() / de_assignments. **pg_cron has none of them**: it
-- runs as `postgres` over a direct connection with no JWT, so auth.role() is
-- NULL, which matches neither the service_role branch nor any tenant branch.
-- The guard is therefore FALSE for every employee, and the function returns an
-- empty set to every cron caller.
--
-- Verified in exactly that context (this migration runs the same way):
--   current_user = postgres, session_user = postgres,
--   auth.role() = NULL, auth.uid() = NULL, can_access_de(<any de>) = false
--
-- Four active jobs reach it, and have been reading nothing since 435:
--   de-reply-mode-gate-15min        every 15 min   run_reply_mode_gate_internal
--   de-development-needs-daily      daily          detect_de_development_needs_internal
--   de-governance-sweep-daily       daily          de_governance_sweep_internal
--   de-performance-review-quarterly quarterly      run_de_performance_review_internal
--
-- The reply-mode gate is the one that matters most: a governance control that
-- decides whether employees may keep auto-replying, running four times an hour
-- on an empty performance set. Fails-empty-not-loud, one auth context further
-- out than the admin-client case that mig 432 had to handle.
--
-- ⚠ MY OWN ASSERTION IN 435 ENCODED THE BUG AS THE PASS CONDITION.
-- It called the function as postgres, asserted the result was EMPTY, and
-- treated that as proof the guard worked. The comment beside it claimed
-- "auth.role() is null here, which the function treats as a trusted-server
-- call" — true of the function's membership gate, FALSE of the guard I had
-- just added. A smoke test that asserts the broken behaviour is worse than no
-- smoke test, because it manufactures confidence. That assertion is corrected
-- below to require the opposite.
--
-- ── The fix: agree with the function instead of inventing a policy ──────
-- This function already defines a trusted caller, at the top of its own body:
--
--     if auth.role() is not null and auth.role() <> 'service_role' then
--       ... membership check ...
--
-- i.e. "NULL auth.role() or service_role means a trusted server; skip the human
-- check". 435's guard silently disagreed with that definition. The repair is
-- not a new escape hatch — it is making the two lines say the same thing.
--
-- Deliberately NOT changing can_access_de. That predicate is the security core
-- behind 63 guarded functions and ~10 RLS policies; widening it to treat "no
-- JWT" as trusted is a real decision with a real blast radius, and it is not
-- needed here. Swept the other 62: NONE is reachable from any of the 30 active
-- cron jobs, so this one function is the whole of the live damage.
--
-- ⚠ For whoever revisits the systemic question: a `current_user` test will NOT
-- work. can_access_de is SECURITY DEFINER, so current_user inside it is the
-- function OWNER regardless of caller, and such a test would be true for
-- everyone. `session_user` survives SECURITY DEFINER and is the correct
-- discriminator (postgres for direct/cron, authenticator for PostgREST).
--
-- Scoped users are unaffected: a browser session always carries a JWT, so
-- auth.role() is 'authenticated' and the can_access_de branch still decides.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='get_de_performance_metrics';
  IF v_src IS NULL THEN RAISE EXCEPTION '454: get_de_performance_metrics not found'; END IF;

  IF v_src LIKE '%or auth.role() = ''service_role''%and public.can_access_de%'
     OR v_src LIKE '%auth.role() is null%or public.can_access_de(de.id)%' THEN
    RAISE NOTICE '454: already repaired, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  a_guard := '      and public.can_access_de(de.id)';

  v_hits := (length(v_src) - length(replace(v_src, a_guard, ''))) / length(a_guard);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '454: expected 1 mig-435 guard to repair, found % — refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_guard, array_to_string(ARRAY[
    '      -- DE scoping (mig 385/435), REPAIRED by mig 454.',
    '      -- The trusted-server test MIRRORS this function''''s own membership gate',
    '      -- at the top of the body (`auth.role() is not null and <> service_role`).',
    '      -- 435 omitted it, so pg_cron — direct connection, no JWT, auth.role()',
    '      -- NULL — failed the guard for every employee and four jobs read nothing.',
    '      and (auth.role() is null',
    '           or auth.role() = ''service_role''',
    '           or public.can_access_de(de.id))'], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION '454: the edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_n int; v_tenant uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='get_de_performance_metrics';

  -- The scoping must SURVIVE. This repair widens for trusted servers only; if
  -- can_access_de vanished, mig 435 would be undone and every signed-in user
  -- would see every employee again.
  IF v_def NOT LIKE '%public.can_access_de(de.id)%' THEN
    RAISE EXCEPTION '454: the mig-435 scope guard was lost — this would undo the scoping, not repair it';
  END IF;
  IF v_def NOT LIKE '%auth.role() is null%' THEN
    RAISE EXCEPTION '454: the trusted-server branch is not present';
  END IF;
  -- The function's own membership gate must still be there, or the two
  -- definitions of "trusted" have diverged again in the other direction.
  IF v_def NOT LIKE '%not authorized to view this workspace%' THEN
    RAISE EXCEPTION '454: the membership gate was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%high_frustration_count%' OR v_def NOT LIKE '%trend_agg%' THEN
    RAISE EXCEPTION '454: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- ⚠ THE ASSERTION 435 GOT BACKWARDS. This migration runs as postgres over a
  -- direct connection — the SAME auth context as pg_cron. So this is a real
  -- behavioural test of the cron path, not a shape check: the four jobs read
  -- through exactly this call. Empty here means empty there.
  SELECT id INTO v_tenant FROM tenants
   WHERE id IN (SELECT tenant_id FROM digital_employees GROUP BY tenant_id ORDER BY count(*) DESC LIMIT 1);
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION '454: no tenant with employees — refusing to claim the cron path works';
  END IF;

  SELECT count(*) INTO v_n FROM public.get_de_performance_metrics(v_tenant, 4);
  IF v_n = 0 THEN
    RAISE EXCEPTION '454: the cron path STILL returns zero employees — the four jobs remain no-ops';
  END IF;

  RAISE NOTICE '454: cron path repaired — % employees now visible to a NULL-auth caller (was 0 since 09:59Z). Scoping for signed-in users is intact.', v_n;
END $assert$;

NOTIFY pgrst, 'reload schema';
