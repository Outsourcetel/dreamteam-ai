-- 369_fail_open_uid_guard.sql
-- ============================================================================
-- set_improvement_publish_scope is callable by ANYONE ON THE INTERNET, with no
-- account, and its authorization check does not run for them.
--
--   if auth.uid() is not null and not exists (
--        select 1 from profiles p where p.user_id = auth.uid()
--         and (p.layer = 'platform' or p.tenant_id = imp.tenant_id))
--   then raise exception 'not authorized'; end if;
--
-- Read the condition: the check only runs WHEN auth.uid() IS NOT NULL. anon has
-- a NULL auth.uid(). So an anonymous caller skips it entirely, and
-- has_function_privilege('anon', ...) is true. The only thing protecting it is
-- the difficulty of guessing a random improvement UUID — which is not a control.
--
-- ── WHY TODAY'S TWO SECURITY MIGRATIONS BOTH WALKED PAST IT ────────────────
-- 365 and 367 classified functions as "guarded" by TEXT-MATCHING their bodies
-- for auth.uid() and friends. This function CONTAINS auth.uid(), so it counted
-- as guarded. The presence of an authorization expression is not the same thing
-- as that expression running. That is a genuine weakness in how I looked, and it
-- is the reason this migration adds an invariant instead of just a fix — the
-- next one of these must be caught by a check, not by someone reading carefully.
--
-- This is the same class of bug migration 330 fixed across 26 RPCs
-- ("anon has NULL auth.uid() SAME AS service-role"). This one survived because
-- 330 looked for a different spelling of it.
--
-- ── SCOPE, MEASURED ────────────────────────────────────────────────────────
-- 32 SECURITY DEFINER functions use the `auth.uid() is not null and ...` shape.
-- In 31 of them the bypass is DELIBERATE and correct: it is how a service-role
-- edge function passes through a check meant for human callers, and those 31 are
-- not executable by anon, so the internet cannot reach the open path.
-- EXACTLY ONE is both fail-open and anon-executable. That one is fixed here.
-- The other 31 are left alone: rewriting working service-role passthrough would
-- be churn with real regression risk and no security gain.
-- ============================================================================

-- ── 1. Close the door ───────────────────────────────────────────────────────
REVOKE ALL ON ROUTINE public.set_improvement_publish_scope(uuid, text) FROM PUBLIC, anon;

-- ── 2. Make the intent explicit rather than accidental ──────────────────────
-- Reproduced from the live definition, with only the guard replaced. The new
-- condition names the service role instead of inferring it from a null uid, so
-- the next reader cannot mistake "anonymous" for "trusted backend".
CREATE OR REPLACE FUNCTION public.set_improvement_publish_scope(
  p_improvement_id uuid, p_scope text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE imp de_improvements;
BEGIN
  IF p_scope NOT IN ('de', 'role') THEN
    RAISE EXCEPTION 'invalid scope %', p_scope;
  END IF;

  SELECT * INTO imp FROM de_improvements WHERE id = p_improvement_id FOR UPDATE;
  IF imp.id IS NULL THEN RAISE EXCEPTION 'improvement not found'; END IF;

  -- The service role is the trusted backend and passes. EVERY other caller,
  -- including an anonymous one, must be a member of the improvement's tenant or
  -- platform staff. Previously an anonymous caller matched neither branch and
  -- fell straight through.
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT EXISTS (
       SELECT 1 FROM profiles p
        WHERE p.user_id = auth.uid()
          AND (p.layer = 'platform' OR p.tenant_id = imp.tenant_id))
  THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF imp.status = 'applied' THEN
    RAISE EXCEPTION 'improvement already published — scope is locked';
  END IF;
  IF imp.status = 'rejected' THEN
    RAISE EXCEPTION 'improvement was rejected';
  END IF;

  UPDATE de_improvements
     SET publish_scope = p_scope, updated_at = now()
   WHERE id = p_improvement_id;
END $function$;

-- CREATE OR REPLACE resets grants to the PUBLIC default, so the revoke has to
-- come AFTER the body, not before it. Doing this the other way round is how the
-- fix silently undoes itself.
REVOKE ALL ON ROUTINE public.set_improvement_publish_scope(uuid, text) FROM PUBLIC, anon;

-- ── 3. Prove it, and stop the next one ──────────────────────────────────────
DO $assert$
DECLARE v_bad text;
BEGIN
  IF has_function_privilege('anon', 'public.set_improvement_publish_scope(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '369: still anon-executable';
  END IF;

  IF (SELECT regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'set_improvement_publish_scope')
     ~* 'auth\.uid\(\) is not null and'
  THEN RAISE EXCEPTION '369: the fail-open condition is still in the body'; END IF;

  -- THE REAL CONTROL: no SECURITY DEFINER function may be anon-executable AND
  -- skip its check when auth.uid() is null. Either property alone is fine; the
  -- combination is an unauthenticated write path.
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p') AND p.prosecdef
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')
         ~* '(auth\.uid\(\) is not null and|if auth\.uid\(\) is null then (return|null))';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '369: anon-reachable fail-open function(s) remain: %', v_bad;
  END IF;

  RAISE NOTICE '369: unauthenticated write path closed; no anon-reachable fail-open guards remain';
END $assert$;

NOTIFY pgrst, 'reload schema';
