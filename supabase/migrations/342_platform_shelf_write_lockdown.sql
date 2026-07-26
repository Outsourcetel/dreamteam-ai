-- 342_platform_shelf_write_lockdown.sql
-- ============================================================================
-- P0 — CROSS-TENANT WRITE PATH INTO THE GLOBAL PLATFORM SHELF.
--
-- Found while auditing for Phase 2, verified against the live database before
-- writing a line of this.
--
-- Mig 334 created the shelf and revoked its functions FROM public, anon,
-- authenticated. Mig 338 added the self-maintaining loop and revoked the new
-- functions FROM public, anon — dropping `authenticated` from the list. The
-- omission is one word and it opens the widest door in the knowledge layer:
--
--   publish_platform_shelf_doc(uuid, text, text, uuid)
--     · SECURITY DEFINER, executable by `authenticated`  ← measured, not assumed
--     · zero caller checks in the body: no is_platform_admin(), no
--       _assert_caller_tenant(), nothing. It reads the doc, versions it, and
--       writes whatever content it is handed.
--
-- The blast radius is what makes this a P0 rather than a tidy-up. The platform
-- shelf is TENANT-LESS BY DESIGN — 61 articles that every one of the 16
-- workspaces' Workforce Assistants retrieve from and cite. So a single logged-in
-- user of ANY tenant could rewrite the product guide that ALL tenants are
-- answered from. That is not a data leak; it is content injection into every
-- other customer's Digital Employee, with the DreamTeam name on the answer.
--
-- Three more from 338 share the omission:
--   list_platform_kb_review_queue()  — exposes unreleased migration titles and
--                                      bodies (our internal change feed) to
--                                      every customer's logged-in users
--   dismiss_platform_kb_change(uuid) — lets them silence our review queue
--   get_platform_kb_health()         — platform-internal posture
--
-- ── Why grants alone are not the fix ────────────────────────────────────────
-- Revoking is necessary and it is where the exposure actually lives. But
-- Supabase re-grants EXECUTE to `authenticated` by default on every future
-- CREATE OR REPLACE, so a grant-only fix silently re-opens the moment someone
-- edits one of these functions and forgets the REVOKE line — which is precisely
-- how 338 happened, four migrations after 334 got it right.
--
-- So both: revoke the grant AND put the check inside the body, where a future
-- CREATE OR REPLACE carries it along. Defence that survives the next edit.
--
-- ── Blast radius of this fix: none ──────────────────────────────────────────
-- Grepped the whole frontend: zero call sites for all four. They have only ever
-- been driven by service-role SQL. Locking them changes no user-visible
-- behaviour, which is why this ships as its own verifiable increment.
-- ============================================================================

-- ── 1. Close the grant ──────────────────────────────────────────────────────
-- Signatures resolved from the catalogue, not hand-written. A REVOKE with a
-- guessed argument list raises "function does not exist" and — because this file
-- runs as one statement — would roll back the entire lockdown. Naming the
-- function and letting Postgres tell us its arguments removes that failure mode
-- for good, including for whatever these signatures become later.
DO $revoke$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('publish_platform_shelf_doc','list_platform_kb_review_queue',
                         'dismiss_platform_kb_change','get_platform_kb_health')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', r.sig);
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN RAISE EXCEPTION '342: none of the four shelf functions exist — wrong database?'; END IF;
  RAISE NOTICE '342: revoked tenant-user EXECUTE on % shelf function(s)', v_n;
END $revoke$;

-- ── 2. Put the check inside the write path ──────────────────────────────────
-- Reproduced from the LIVE definition via pg_get_functiondef; the only change is
-- the guard block inserted after BEGIN. Nothing else in the body is touched.
DO $rewrite$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'publish_platform_shelf_doc' AND p.prokind = 'f'
   LIMIT 1;
  IF v_def IS NULL THEN RAISE EXCEPTION '342: publish_platform_shelf_doc not found'; END IF;

  IF v_def ILIKE '%is_platform_admin()%' THEN
    RAISE NOTICE '342: publish already guarded; leaving the body alone';
    RETURN;
  END IF;

  -- Service-role and pg_cron have a NULL auth.uid() and must keep working — the
  -- harvester publishes through this path. A logged-in human must be platform.
  v_new := regexp_replace(
    v_def,
    'DECLARE v_old platform_knowledge_docs; v_new uuid; v_mig text;\s*BEGIN',
    'DECLARE v_old platform_knowledge_docs; v_new uuid; v_mig text;' || E'\n' ||
    'BEGIN' || E'\n' ||
    '  -- 342: the shelf is global. A tenant user editing it would rewrite the' || E'\n' ||
    '  -- product guide that every OTHER tenant is answered from.' || E'\n' ||
    '  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN' || E'\n' ||
    '    RAISE EXCEPTION ''only platform administrators can publish to the shared shelf'';' || E'\n' ||
    '  END IF;',
    'i');

  IF v_new = v_def THEN RAISE EXCEPTION '342: could not anchor the guard into publish_platform_shelf_doc'; END IF;
  EXECUTE v_new;
  -- CREATE OR REPLACE re-applies Supabase's default grants, so re-revoke.
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated',
    (SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='publish_platform_shelf_doc' AND p.prokind='f' LIMIT 1));
END $rewrite$;

-- Same treatment for the one other mutator.
DO $rewrite2$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'dismiss_platform_kb_change' AND p.prokind = 'f' LIMIT 1;
  IF v_def IS NULL OR v_def ILIKE '%is_platform_admin()%' THEN RETURN; END IF;

  v_new := regexp_replace(v_def, '(AS \$function\$\s*BEGIN)',
    '\1' || E'\n' ||
    '  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN' || E'\n' ||
    '    RAISE EXCEPTION ''only platform administrators can manage the shelf review queue'';' || E'\n' ||
    '  END IF;', 'i');
  IF v_new <> v_def THEN
    EXECUTE v_new;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated',
      (SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='dismiss_platform_kb_change' AND p.prokind='f' LIMIT 1));
  END IF;
END $rewrite2$;

-- ── 3. Prove the door is shut ───────────────────────────────────────────────
DO $assert$
DECLARE r record; v_open text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('publish_platform_shelf_doc','list_platform_kb_review_queue',
                         'dismiss_platform_kb_change','get_platform_kb_health')
  LOOP
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE')
       OR has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      v_open := v_open || r.proname;
    END IF;
  END LOOP;

  IF array_length(v_open, 1) > 0 THEN
    RAISE EXCEPTION '342: still reachable by tenant users: %', array_to_string(v_open, ', ');
  END IF;

  -- And the in-body guard must be there, so the next CREATE OR REPLACE keeps it.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='publish_platform_shelf_doc' AND p.prokind='f' LIMIT 1)
     NOT ILIKE '%is_platform_admin()%'
  THEN RAISE EXCEPTION '342: the publish body still has no caller check'; END IF;

  RAISE NOTICE '342: shelf write path closed at both the grant and the body';
END $assert$;

-- ── 4. Sweep: any OTHER shelf function still open to tenant users? ──────────
-- The bug was an omission, so the useful question is whether it happened twice.
DO $sweep$
DECLARE r record; v_found text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
       AND (p.proname ILIKE '%platform_kb%' OR p.proname ILIKE '%platform_shelf%'
            OR p.proname ILIKE '%platform_knowledge%')
  LOOP
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      v_found := v_found || r.proname;
    END IF;
  END LOOP;
  -- list_platform_shelf / get_platform_shelf_doc / platform_match_knowledge are
  -- INTENTIONALLY reachable: they are the read API the shelf panel and the
  -- Assistant use. Read-only, no tenant data, and that is the whole point.
  RAISE NOTICE '342: still reachable by design (read-only): %',
    coalesce(array_to_string(v_found, ', '), 'none');
END $sweep$;

NOTIFY pgrst, 'reload schema';
