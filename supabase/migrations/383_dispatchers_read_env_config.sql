-- 383_dispatchers_read_env_config.sql
-- ============================================================================
-- Ten dispatchers hardcode the PRODUCTION project URL and the PRODUCTION anon
-- key, so a copy of this database can never dispatch to itself.
--
-- Measured on the dev project before writing this:
--   10 functions containing 'rfsvmhcqeiyrxivbmpel'  ← the PRODUCTION ref
--   dispatch_de_fitness_measure_internal, dispatch_de_improve_internal,
--   dispatch_eval_driver_internal, dispatch_gap_improve_internal,
--   dispatch_knowledge_sync_internal, invoke_conflict_probe_drain,
--   invoke_eval_batch_poll, invoke_knowledge_ingest_drain,
--   invoke_reembed_drain, platform_fn_url
--
-- CONSEQUENCE: dev's cron would wake PRODUCTION's edge functions, which drain
-- PRODUCTION's queues. Dev's own queued items are never touched no matter how
-- long you wait. That is the "import queues but never drains" symptom — the
-- worker was never asked to look at dev.
--
-- It is also a genuine hazard in the other direction: a scheduled job on a test
-- database reaching into production is a cross-environment write path nobody
-- would approve if asked directly. Dev is currently saved from it only by
-- accident (no cron jobs, no vault secret, and a different anon key), which is
-- three coincidences rather than a control.
--
-- ── THE FIX ALREADY EXISTED AND WAS BYPASSED ───────────────────────────────
-- platform_fn_url(path) reads platform_runtime_config.function_base_url and
-- falls back to the production URL, and platform_runtime_config ALSO already
-- holds supabase_anon_key. The mechanism was built; the dispatchers just kept
-- their own copies. This migration deletes the copies.
--
-- ⚠ PROVEN NO-OP ON PRODUCTION. Verified before writing, on production:
--     every_url_matches_config = true   (9 of 9 URL literals)
--     every_jwt_matches_config = true   (8 of 8 anon-key literals)
--   Every literal being replaced is byte-identical to the config value that
--   replaces it, so production resolves to exactly the same string it uses
--   today. The behaviour change is confined to databases whose config says
--   something different — which is the entire point.
--
-- ── WHY A REWRITE LOOP AND NOT NINE PASTED BODIES ──────────────────────────
-- These functions have been amended repeatedly (mig 300 fixed a JWT, mig 366
-- added timeouts to seven of them). Pasting bodies from old migration files
-- would silently revert that work — which is exactly how migration 377 undid
-- the export pager earlier tonight. So each body is read LIVE with
-- pg_get_functiondef, two targeted substitutions are applied, and the result is
-- re-executed. Whatever a function says today is what it will say afterwards,
-- minus the hardcoded environment.
--
-- Arity is untouched, so this cannot create an overload — the failure mode that
-- broke the export in migration 377 (see 382).
-- ============================================================================

DO $rewrite$
DECLARE
  r           record;
  v_src       text;
  v_new       text;
  v_changed   int := 0;
  v_url_hits  int := 0;
  v_jwt_hits  int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f','p')
       AND pg_get_functiondef(p.oid) LIKE '%rfsvmhcqeiyrxivbmpel%'
       -- platform_fn_url is the ONE place the production URL legitimately
       -- appears: it is the fallback for a database with no config row, which
       -- is what keeps production safe if the row is ever deleted.
       AND p.proname <> 'platform_fn_url'
     ORDER BY p.proname
  LOOP
    v_src := pg_get_functiondef(r.oid);
    v_new := v_src;

    -- 1. URL literal → the existing helper, which reads config.
    --    'https://<ref>.supabase.co/functions/v1/x' → platform_fn_url('/functions/v1/x')
    --    Matches a bare origin too (empty path), so no call site is missed.
    v_new := regexp_replace(v_new,
      '''https://rfsvmhcqeiyrxivbmpel\.supabase\.co([^'']*)''',
      'public.platform_fn_url(''\1'')', 'g');

    -- 2. anon-key literal → config, KEEPING the literal as the fallback.
    --    Deliberately coalesce rather than replace outright: if the config row
    --    is missing, production must keep working exactly as it does now. A
    --    dispatcher that starts sending a NULL Authorization header because a
    --    config row was deleted would fail as a 401 — which, as established
    --    this morning, looks identical to a fast success.
    --
    --    Matched by SHAPE, not by content: three dot-separated base64url runs,
    --    which is what a JWT is. Writing out a real token's header bytes here
    --    would put a credential-shaped string in a committed file for no gain —
    --    and this form also catches a token signed with any other algorithm,
    --    which a header-specific pattern would silently skip. The 16-character
    --    floor per segment is what keeps it off hostnames: 'supabase' is 8.
    v_new := regexp_replace(v_new,
      '''([A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})''',
      'coalesce((select value from platform_runtime_config where key = ''supabase_anon_key''), ''\1'')',
      'g');

    IF v_new = v_src THEN
      RAISE EXCEPTION '383: % contains the production ref but neither pattern matched — refusing to guess', r.proname;
    END IF;

    IF v_new LIKE '%platform_fn_url(%'    THEN v_url_hits := v_url_hits + 1; END IF;
    IF v_new LIKE '%supabase_anon_key%'   THEN v_jwt_hits := v_jwt_hits + 1; END IF;

    EXECUTE v_new;
    v_changed := v_changed + 1;
  END LOOP;

  RAISE NOTICE '383: rewrote % dispatcher(s) — % now resolve the URL from config, % the anon key',
    v_changed, v_url_hits, v_jwt_hits;

  IF v_changed = 0 THEN
    RAISE NOTICE '383: nothing to rewrite (already environment-aware)';
  END IF;
END $rewrite$;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_left   text;
  v_broken text;
BEGIN
  -- 1. No function may still carry the production ref, except the one helper
  --    whose job is to hold the fallback.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
     AND p.proname <> 'platform_fn_url'
     AND pg_get_functiondef(p.oid) LIKE '%rfsvmhcqeiyrxivbmpel%';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION '383: these still hardcode the production project: %', v_left;
  END IF;

  -- 2. The rewrite must not have cost a dispatcher its actual dispatch. A
  --    function that no longer posts anywhere would go quiet without erroring,
  --    which is the worst possible outcome of a mechanical rewrite.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_broken
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
     AND p.proname LIKE ANY (ARRAY['invoke\_%','dispatch\_%'])
     AND pg_get_functiondef(p.oid) LIKE '%platform_fn_url%'
     AND pg_get_functiondef(p.oid) NOT LIKE '%net.http_post%';
  IF v_broken IS NOT NULL THEN
    RAISE EXCEPTION '383: these lost their http_post in the rewrite: %', v_broken;
  END IF;

  -- 3. This database must be able to say where it is. Reported, not raised:
  --    production has the row, and a fresh clone should be told what is wrong
  --    rather than blocked from applying migrations.
  IF NOT EXISTS (SELECT 1 FROM platform_runtime_config WHERE key = 'function_base_url') THEN
    RAISE NOTICE '383: ⚠ no function_base_url row — this database will dispatch to the PRODUCTION fallback. Set it before scheduling any cron job here.';
  ELSE
    RAISE NOTICE '383: dispatchers now target %', (SELECT value FROM platform_runtime_config WHERE key = 'function_base_url');
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
