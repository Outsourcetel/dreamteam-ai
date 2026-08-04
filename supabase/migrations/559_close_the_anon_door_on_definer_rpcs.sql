-- 559 — take the unauthenticated internet off 32 SECURITY DEFINER RPCs.
--
-- Started as a one-line revoke on get_de_config(uuid). Counting first turned up
-- 33 SECURITY DEFINER functions executable by `anon` — the role every
-- unauthenticated visitor holds.
--
-- MOST ARE GUARDED, AND THAT IS NOT THE POINT. Proven live over PostgREST with
-- the anon key: get_all_tenants_with_summary refuses ("Unauthorized"), but
-- resolve_de_archetype answered HTTP 200. So the set is genuinely mixed, and a
-- guard I have to read the body to find is a guard someone can remove in a later
-- edit without noticing what it was load-bearing for. Defence in depth belongs at
-- the grant.
--
-- ⚠ REVOKING FROM anon ALONE WOULD HAVE BEEN THEATRE. 22 of the 33 ALSO carry
-- PUBLIC EXECUTE, and PUBLIC INCLUDES anon — the door stays open through the
-- other grant. This strips both, which is the whole point of the standing rule
-- that a REVOKE must take PUBLIC with it.
--
-- WHY THIS CANNOT BREAK SIGNED-IN USERS: all 33 hold an EXPLICIT
-- `authenticated=X` grant of their own, so removing the PUBLIC grant removes a
-- redundant path, not their only one. Asserted below rather than assumed.
--
-- KEPT ON PURPOSE — verify_embed_token(text,uuid,uuid). EmbedPage.tsx is the
-- public support widget running in an iframe on a customer's site, with no
-- session at all. anon IS its legitimate caller. It is the only one.
--   (widget_identity_configured LOOKS like a widget function and is not: its only
--    caller is widgetApi → SettingsPage, which is a signed-in tenant screen.)
--
-- Edge functions are unaffected — they call with the service role, which keeps
-- its own grant throughout.

BEGIN;

DO $revoke$
DECLARE
  r record;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'   -- skip extension fns
     WHERE ns.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prosecdef                              -- SECURITY DEFINER only
       AND p.prorettype <> 'trigger'::regtype       -- triggers are not callable
       AND d.objid IS NULL
       -- BOTH doors, matched exactly as the assert counts them. The first draft
       -- of this loop selected only `anon=X` and the assert caught it: 11
       -- functions carry PUBLIC EXECUTE with NO explicit anon grant, so they were
       -- reachable by the internet through a door the loop never looked at.
       AND (p.proacl::text LIKE '%anon=X%' OR p.proacl::text ~ '[{,]=X/')
  LOOP
    -- verify_embed_token keeps its EXPLICIT anon grant (the public widget has no
    -- session) but loses the redundant PUBLIC one, so its access is stated once,
    -- deliberately, rather than inherited.
    IF r.sig NOT LIKE 'verify_embed_token(%' THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig);
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '559: revoked anon + PUBLIC EXECUTE on % functions', v_n;
END
$revoke$;

-- ── Asserts ─────────────────────────────────────────────────────────────────
-- Would these pass on a no-op? No: 33 such functions exist right now.
-- Would they pass if this broke the app? No: D2 fails the moment a signed-in
-- user loses a function they can currently call.
DO $probe$
DECLARE
  v_left int;
  v_auth_lost int;
BEGIN
  -- D1: the door is shut. Counted the same way it was counted before, so the
  -- number is comparable rather than a fresh definition that flatters itself.
  SELECT count(*) INTO v_left
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
   WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
     AND p.prorettype <> 'trigger'::regtype AND d.objid IS NULL
     AND (p.proacl::text LIKE '%anon=X%' OR p.proacl::text ~ '[{,]=X/');
  IF v_left <> 1 THEN
    RAISE EXCEPTION 'D1 FAILED: % SECURITY DEFINER RPCs still reachable by anon/PUBLIC, expected exactly 1 (verify_embed_token)', v_left;
  END IF;

  -- D2: THE ONE THAT MATTERS. Every function touched must still be executable
  -- by `authenticated`, or a signed-in person just lost a screen.
  SELECT count(*) INTO v_auth_lost
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
   WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
     AND p.prorettype <> 'trigger'::regtype AND d.objid IS NULL
     AND p.proacl::text LIKE '%service_role=X%'
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND p.proname IN (
       'get_de_config','save_de_config','install_technical_specialist',
       'resolve_account_writeback','resolve_continuity_writeback',
       'resolve_opportunity_writeback','set_tenant_comms_settings',
       'rotate_widget_identity_secret','record_deliverable','list_kpi_metrics');
  IF v_auth_lost <> 0 THEN
    RAISE EXCEPTION 'D2 FAILED: % function(s) are no longer executable by authenticated — a signed-in screen just broke', v_auth_lost;
  END IF;

  -- D3: the widget's own call still works for a visitor with no session.
  IF NOT has_function_privilege('anon', 'public.verify_embed_token(text,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'D3 FAILED: anon lost verify_embed_token — the public support widget cannot authenticate';
  END IF;

  -- D4: the founder's original one-line ask, checked by name.
  IF has_function_privilege('anon', 'public.get_de_config(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'D4 FAILED: anon can still execute get_de_config(uuid)';
  END IF;

  RAISE NOTICE '559 asserts passed: anon holds 1 function (the widget), authenticated kept everything.';
END
$probe$;

COMMIT;
