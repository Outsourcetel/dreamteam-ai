-- 361_revoke_anon_knowledge_surface.sql
-- ============================================================================
-- Found by the new knowledge-ACL invariant test suite, on its FIRST run.
--
-- 36 knowledge/ingestion/group/shelf functions were executable by `anon`.
-- Supabase grants EXECUTE to anon and authenticated by default on every new
-- function, so anything that shipped without an explicit REVOKE inherited it —
-- including four SECURITY DEFINER functions that WRITE, two of which I created
-- in migrations 343 and 344 and never revoked.
--
-- ── Why anon is the dangerous role here, not just an untidy one ────────────
-- Mig 330 established this and it is the single most important fact about this
-- codebase's auth model: **anon has a NULL auth.uid(), exactly like
-- service-role**. Every guard shaped like "if auth.uid() is null then this is
-- an internal caller, allow it" is therefore open to the public internet.
-- _assert_caller_tenant returns early on a NULL uid for precisely that reason.
--
-- ── What was actually reachable ───────────────────────────────────────────
--   dispatch_knowledge_sync_internal()       fires connector syncs across every
--                                            eligible tenant — unauthenticated,
--                                            billable, cross-tenant work
--   set_knowledge_freshness_config(text,num) rewrites PLATFORM-WIDE retrieval
--                                            tuning in platform_config
--   knowledge_rebuild_doc_paths(uuid)        DELETE+INSERT on the ancestry
--                                            closure          [mine, mig 343]
--   knowledge_refresh_restricted_flag(uuid)  UPDATE knowledge_docs
--                                                             [mine, mig 344]
--   resolve_knowledge_conflict(...)          resolves conflicts
--
-- Plus ~30 read-only helpers and trigger functions. Those are far less serious —
-- they resolve to nothing for a caller with no tenant — but there is no reason
-- for anon to hold EXECUTE on any of them, and "less serious" is how the
-- dangerous ones stayed hidden among them.
--
-- ── Why a blanket revoke is safe ──────────────────────────────────────────
-- Nothing anonymous calls knowledge RPCs directly. The public widget path is
-- widget-ask, an edge function that authenticates at the gateway with an anon
-- BEARER and then does its database work with the SERVICE ROLE client. Proof it
-- holds: hybrid_match_knowledge — the single hottest retrieval path, used by the
-- widget — was already revoked from anon in migs 345/346/357 and every answer
-- path kept working.
--
-- Four internal functions additionally lose `authenticated`, verified as having
-- no call site anywhere in src/. resolve_knowledge_conflict keeps it because
-- knowledgeApi.ts calls it; it is asserted below to carry its own guard.
-- ============================================================================

-- ── 1. Blanket: anon loses EXECUTE on the whole knowledge surface ──────────
-- THE SUBTLETY THAT MADE THE FIRST ATTEMPT A NO-OP: the privilege does not come
-- from a grant to `anon`. Postgres grants EXECUTE on every new function to
-- PUBLIC automatically, and `anon` inherits it that way. `REVOKE ... FROM anon`
-- removes a grant that was never issued and changes nothing —
-- has_function_privilege still returns true. PUBLIC is what has to be revoked.
--
-- But revoking PUBLIC also strips `authenticated` and `service_role`, which the
-- app and the edge functions genuinely need. So this snapshots who can execute
-- what FIRST, revokes PUBLIC, and restores the explicit grants — rather than
-- revoking broadly and hoping nothing was load-bearing.
DO $revoke_anon$
DECLARE r record; v_n int := 0; v_restored int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname,
           -- snapshot BEFORE the revoke
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_had,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_had,
           p.prorettype = 'trigger'::regtype AS is_trigger_fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND (p.proname LIKE '%knowledge%' OR p.proname LIKE '%ingestion%'
            OR p.proname LIKE '%principal_group%' OR p.proname LIKE '%platform_shelf%'
            OR p.proname LIKE '%platform_kb%')
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    v_n := v_n + 1;

    -- Restore what was there, except for trigger functions (never called
    -- directly) and the four internal ones handled in §2.
    IF NOT r.is_trigger_fn
       AND r.proname NOT IN ('knowledge_rebuild_doc_paths','knowledge_refresh_restricted_flag',
                             'dispatch_knowledge_sync_internal','set_knowledge_freshness_config')
    THEN
      IF r.authed_had THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
        v_restored := v_restored + 1;
      END IF;
      IF r.svc_had THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
      END IF;
    END IF;
  END LOOP;
  RAISE NOTICE '361: closed % function(s) to anon, restored % authenticated grant(s)', v_n, v_restored;
END $revoke_anon$;

-- ── 2. Internal-only functions also lose `authenticated` ──────────────────
-- Each verified to have zero call sites under src/. These are called by
-- triggers, by pg_cron, or by other SECURITY DEFINER functions — never by a
-- browser.
DO $revoke_internal$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname IN ('knowledge_rebuild_doc_paths',
                         'knowledge_refresh_restricted_flag',
                         'dispatch_knowledge_sync_internal',
                         'set_knowledge_freshness_config')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    v_n := v_n + 1;
  END LOOP;
  IF v_n < 4 THEN RAISE EXCEPTION '361: expected 4 internal functions, locked %', v_n; END IF;
END $revoke_internal$;

-- ── 3. Trigger functions are never called directly ────────────────────────
-- PostgREST does not expose them and they fail outside a trigger context, but
-- they run SECURITY DEFINER and there is no reason for a client role to hold
-- EXECUTE. Removing them also stops them padding the anon list and hiding the
-- next real one.
DO $revoke_triggers$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.prorettype = 'trigger'::regtype
       AND (p.proname LIKE '%knowledge%' OR p.proname LIKE '%ingestion%'
            OR p.proname LIKE '%platform_knowledge%' OR p.proname LIKE '%playbook_knowledge%')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '361: locked % trigger function(s)', v_n;
END $revoke_triggers$;

-- ── 4. Prove it, and prove the UI-facing one still guards itself ──────────
DO $assert$
DECLARE v_open text[] := ARRAY[]::text[]; r record; v_def text;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosecdef,
           (pg_get_functiondef(p.oid) ~* '\m(insert|update|delete)\M') AS writes
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND (p.proname LIKE '%knowledge%' OR p.proname LIKE '%ingestion%'
            OR p.proname LIKE '%principal_group%' OR p.proname LIKE '%platform_shelf%'
            OR p.proname LIKE '%platform_kb%')
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    v_open := v_open || (r.proname || CASE WHEN r.writes THEN ' [WRITES]' ELSE '' END);
  END LOOP;

  IF array_length(v_open, 1) > 0 THEN
    RAISE EXCEPTION '361: still anon-executable: %', array_to_string(v_open, ', ');
  END IF;

  -- The one that keeps `authenticated` must enforce its own tenant/role gate,
  -- since it is now the only writer in this family a browser can reach.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_knowledge_conflict' LIMIT 1;
  IF v_def IS NOT NULL AND v_def !~* 'auth_tenant_id|auth_has_tenant_role|is_platform_admin' THEN
    RAISE EXCEPTION '361: resolve_knowledge_conflict is browser-reachable with no tenant guard';
  END IF;

  -- And the four internal ones must be unreachable from any client role.
  FOR r IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('knowledge_rebuild_doc_paths','knowledge_refresh_restricted_flag',
                         'dispatch_knowledge_sync_internal','set_knowledge_freshness_config')
       AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  LOOP
    RAISE EXCEPTION '361: % is still reachable from a client role', r.proname;
  END LOOP;

  RAISE NOTICE '361: the knowledge surface is closed to anon';
END $assert$;

NOTIFY pgrst, 'reload schema';
