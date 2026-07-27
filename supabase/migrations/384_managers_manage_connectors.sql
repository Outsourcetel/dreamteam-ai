-- 384_managers_manage_connectors.sql
-- ============================================================================
-- Founder decision 1, docs/29-permissions-and-de-reporting-line.md §1:
-- department managers get Connected Systems, including actually connecting one.
--
-- ⚠ THIS WIDENS A CREDENTIAL BOUNDARY. set_connector_secret is the function
-- that stores a customer's credentials for their systems of record — the real
-- keys to Zendesk, QuickBooks, HubSpot and the rest. Until now only
-- tenant_owner and tenant_admin could call it. This adds tenant_manager.
--
-- That is a deliberate, founder-approved trade (managers are trusted staff),
-- recorded here so it is never mistaken for a navigation change that happened
-- to touch the database. It was proposed as a browse-only split — managers see
-- what is connected, owners/admins hold the keys — and the founder chose full
-- access instead. If that is ever reconsidered, this migration is the thing to
-- reverse, and src/lib/navAccess.ts must move systems_connectors back to ADMIN
-- in the same change so the nav and the database never disagree.
--
-- ── ALL FOUR, not just the one that was asked about ────────────────────────
-- Granting only set_connector_secret would produce a manager who can store a
-- credential but not rotate or remove it — a half-permission that looks like a
-- bug at exactly the moment someone is trying to revoke access in a hurry:
--   set_connector_secret        store / replace a credential
--   purge_connector_secret      remove one
--   set_connector_schedule      when it syncs
--   set_connector_ingest_config what it pulls
--
-- ── Reproduce-from-live ────────────────────────────────────────────────────
-- Bodies are read with pg_get_functiondef and rewritten, not pasted from old
-- migration files. Pasting a stale body silently reverts whatever else has
-- changed since — which is how migration 377 undid the export pager earlier
-- today. The regex is whitespace-tolerant because these four are not written
-- identically: two use array['a', 'b'] and two use array['a','b'].
--
-- Arity is untouched, so this cannot create an overload (see 382).
-- ============================================================================

DO $rewrite$
DECLARE
  r         record;
  v_src     text;
  v_new     text;
  v_changed int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f','p')
       AND p.proname IN ('set_connector_secret', 'purge_connector_secret',
                         'set_connector_schedule', 'set_connector_ingest_config')
     ORDER BY p.proname
  LOOP
    v_src := pg_get_functiondef(r.oid);

    -- Only the owner+admin pair is widened. A guard listing different roles is
    -- left alone rather than guessed at.
    v_new := regexp_replace(
      v_src,
      '(auth_has_tenant_role\s*\(\s*array\[\s*''tenant_owner''\s*,\s*''tenant_admin''\s*)\]',
      '\1, ''tenant_manager'']',
      'g');

    IF v_new = v_src THEN
      RAISE EXCEPTION '384: % did not carry the expected owner+admin guard — refusing to guess', r.proname;
    END IF;

    EXECUTE v_new;
    v_changed := v_changed + 1;
  END LOOP;

  IF v_changed <> 4 THEN
    RAISE EXCEPTION '384: expected to rewrite 4 connector functions, rewrote %', v_changed;
  END IF;
  RAISE NOTICE '384: % connector functions now admit tenant_manager', v_changed;
END $rewrite$;

-- ── Close anon on all four while we are here ───────────────────────────────
-- Found running this migration: on PRODUCTION, set_connector_schedule was
-- anon-executable while its three siblings were not. NOT a hole — verified that
-- auth_has_tenant_role fails closed for a NULL identity:
--   resolve_remote_access_tenant(null, null) IS NULL  → the OR clause is false
--   the profiles clause matches no row for user_id = NULL
-- so anon could call it and was rejected inside. An unnecessary grant, not an
-- open door. On DEV all four were anon-executable, because dev never received
-- the perimeter revokes from migs 330/365.
--
-- Revoking anyway: a credential-adjacent writer reachable by anon relies on one
-- function continuing to fail closed, and that is a thin thing to rest on when
-- signup is open and anon is therefore the internet. Defence in depth, and it
-- makes the four consistent.
--
-- ⚠ REVOKE must strip PUBLIC, not just anon: Postgres grants EXECUTE to PUBLIC
-- by default, so revoking from anon alone is a no-op (mig 365's lesson). ON
-- ROUTINE, not ON FUNCTION, so procedures do not raise 42809.
DO $revoke$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f','p')
       AND p.proname IN ('set_connector_secret', 'purge_connector_secret',
                         'set_connector_schedule', 'set_connector_ingest_config')
  LOOP
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO authenticated', r.sig);
  END LOOP;
  RAISE NOTICE '384: anon and PUBLIC revoked on the four connector writers; authenticated re-granted';
END $revoke$;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_bad text;
BEGIN
  -- 1. All four must now admit a manager.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
     AND p.proname IN ('set_connector_secret', 'purge_connector_secret',
                       'set_connector_schedule', 'set_connector_ingest_config')
     AND pg_get_functiondef(p.oid) NOT LIKE '%tenant_manager%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '384: these still exclude managers: %', v_bad;
  END IF;

  -- 2. None may have LOST its guard. A rewrite that deleted the check would
  --    open these to every tenant role — the opposite of the intent, and
  --    invisible until someone audited it.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
     AND p.proname IN ('set_connector_secret', 'purge_connector_secret',
                       'set_connector_schedule', 'set_connector_ingest_config')
     AND pg_get_functiondef(p.oid) NOT ILIKE '%auth_has_tenant_role%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '384: these lost their role guard entirely: %', v_bad;
  END IF;

  -- 3. The widening must stop at manager. If any of the four now admits a role
  --    below it, this migration went further than the decision it implements.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
     AND p.proname IN ('set_connector_secret', 'purge_connector_secret',
                       'set_connector_schedule', 'set_connector_ingest_config')
     AND (pg_get_functiondef(p.oid) ILIKE '%tenant_user%'
       OR pg_get_functiondef(p.oid) ILIKE '%read_only%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '384: these widened too far, admitting a role below manager: %', v_bad;
  END IF;

  -- 4. anon must never reach a credential writer. Signup is open, so anon is
  --    the internet (mig 330's lesson).
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
     AND p.proname IN ('set_connector_secret', 'purge_connector_secret',
                       'set_connector_schedule', 'set_connector_ingest_config')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '384: anon can execute: %', v_bad;
  END IF;

  RAISE NOTICE '384: managers may now manage connectors end to end; anon still cannot';
END $assert$;

NOTIFY pgrst, 'reload schema';
