-- 330_tenant_isolation_anon_hardening.sql
-- ============================================================================
-- Close the one real cross-tenant path found in the isolation audit, before
-- features are widened to every tenant.
--
-- WHAT THE AUDIT FOUND
--   242 tables, 210 tenant-scoped, ZERO without RLS. Direct table reads by anon
--   are blocked (anon cannot even execute auth_tenant_id). Table isolation holds.
--   Two defects, both below.
--
-- DEFECT 1 — THE ANON GUARD HOLE (systemic).
--   Every tenant guard on the SECURITY DEFINER RPCs is written as:
--       IF auth.uid() IS NULL THEN RETURN; END IF;              -- _assert_caller_tenant
--       if auth.uid() is not null and <not a member> then raise -- inline variants
--   That is correct for a logged-in user (blocks cross-tenant) and correct for a
--   service-role edge function (must be allowed). But `anon` ALSO has a NULL
--   auth.uid(), and Supabase's default privileges grant EXECUTE on new functions
--   to anon. So for 26 SECURITY DEFINER functions taking p_tenant_id, the guard
--   was a no-op for an unauthenticated caller.
--
--   Verified empirically, not inferred: calling these over PostgREST with the
--   public anon key EXECUTED them (runtime errors from inside the function body)
--   rather than returning 403. Worst two:
--     * get_or_create_embed_token -> generate_embed_token: mints a 24-HOUR widget
--       embed token for any tenant/DE pair. Its two guards (_assert_caller_tenant,
--       then a role check conditioned on auth.uid() IS NOT NULL) both pass for anon.
--     * match_cached_answer: returns another tenant's cached customer answer text.
--   Exploitation needs tenant + DE UUIDs, which are not published — obscurity,
--   not a control.
--
-- DEFECT 2 — skill_catalog had TWO permissive SELECT policies:
--     read global and own skills : tenant_id IS NULL OR tenant_id = auth_tenant_id()
--     skill_catalog_read         : USING (true)
--   Postgres OR's permissive policies, so the second silently defeated the first.
--   Harmless today (all 5 rows are global, 0 tenant-owned) but the tenant_id
--   column exists so tenants CAN add private skills — the first one would have
--   been world-readable. The only table on the platform with this pattern.
--
-- WHY THE FIX IS SAFE
--   Verified every one of these against the codebase: they are called from EDGE
--   FUNCTIONS using the service role, which this migration does not touch, and
--   from the authenticated frontend, which keeps its grant. Exactly ONE is
--   legitimately called by an unauthenticated page — verify_embed_token, from
--   the public EmbedPage — and it authenticates by an opaque random SECRET
--   (SHA-256 hashed server-side), not by a guessable tenant UUID. It is
--   explicitly kept.
-- ============================================================================

-- ── 1. Make the shared guard reject anon specifically. ──────────────────────
-- Surgical: ONLY an explicit `anon` request role is rejected. A service-role
-- call, a pg_cron job, or a direct psql session (all of which have no JWT claims
-- at all) keep today's behaviour exactly — so nothing server-side changes.
CREATE OR REPLACE FUNCTION public._assert_caller_tenant(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- An unauthenticated PostgREST caller is NOT a trusted server caller, even
  -- though both present a NULL auth.uid(). Distinguish them by the request role.
  IF coalesce(
       nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
       '') = 'anon' THEN
    RAISE EXCEPTION 'not_authorized_for_tenant';
  END IF;
  IF auth.uid() IS NULL THEN RETURN; END IF;   -- service role / cron / psql
  IF p_tenant_id IS NULL OR public.auth_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'not_authorized_for_tenant';
  END IF;
END$function$;

-- ── 2. Same hardening inline on the content-leak function. ──────────────────
-- Reproduced verbatim from the live definition; the ONLY change is the added
-- anon rejection at the top. Defence in depth: even if a future migration
-- re-grants anon, the body now refuses.
CREATE OR REPLACE FUNCTION public.match_cached_answer(
  p_tenant_id uuid, p_account_id uuid, p_query_embedding vector,
  p_max_distance double precision DEFAULT 0.15, p_language text DEFAULT NULL::text,
  p_de_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(id uuid, answer text, confidence integer, sources jsonb, distance double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'anon' then
    raise exception 'tenant access denied';
  end if;
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  return query
  select a.id, a.answer, a.confidence, a.sources,
         (a.question_embedding <=> p_query_embedding)::float as distance
  from answer_cache a
  where a.tenant_id = p_tenant_id
    and a.invalidated = false
    and a.question_embedding is not null
    and a.de_id is not distinct from p_de_id   -- DE-scoped: a DE's cache serves only that DE
    and (a.account_id is null or (p_account_id is not null and a.account_id = p_account_id))
    and (a.question_embedding <=> p_query_embedding) < p_max_distance
    and (
      (p_language is null and (a.language is null or a.language ilike 'english'))
      or (p_language is not null and a.language ilike p_language)
    )
  order by
    (a.account_id is not null and a.account_id = p_account_id) desc,
    a.question_embedding <=> p_query_embedding
  limit 1;
end;
$function$;

-- ── 3. Revoke anon + PUBLIC on every tenant-scoped SECURITY DEFINER RPC. ────
-- Dynamic rather than a hardcoded list of 26, so a function added later by a
-- future migration is covered the next time this pattern is applied. The
-- `authenticated` role KEEPS its grant — for a logged-in user the existing
-- membership checks work correctly and are unaffected.
DO $revoke$
DECLARE
  r record;
  n int := 0;
  -- The ONLY legitimately-public one: authenticates by an opaque secret token,
  -- not by tenant UUID. Used by the public embed page.
  keep text[] := array['verify_embed_token'];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.prosecdef
       AND pg_get_function_arguments(p.oid) ~ 'p_tenant_id'
       AND NOT (p.proname = ANY(keep))
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM public', r.sig);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '330: revoked anon/public EXECUTE on % tenant-scoped SECURITY DEFINER functions', n;
END $revoke$;

-- ── 4. Drop the policy that defeated skill_catalog's tenant scoping. ────────
DROP POLICY IF EXISTS skill_catalog_read ON skill_catalog;

-- ── 5. Assertions — this migration must be provable, not hopeful. ───────────
DO $assert$
DECLARE v_leaky int; v_embed boolean; v_skill int;
BEGIN
  SELECT count(*) INTO v_leaky
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prosecdef
     AND pg_get_function_arguments(p.oid) ~ 'p_tenant_id'
     AND p.proname <> 'verify_embed_token'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_leaky > 0 THEN
    RAISE EXCEPTION '330: % tenant-scoped SECURITY DEFINER functions are still anon-callable', v_leaky;
  END IF;

  SELECT has_function_privilege('anon', p.oid, 'EXECUTE') INTO v_embed
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'verify_embed_token' LIMIT 1;
  IF NOT coalesce(v_embed, false) THEN
    RAISE EXCEPTION '330: verify_embed_token lost its anon grant — the public embed page would break';
  END IF;

  SELECT count(*) INTO v_skill
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'skill_catalog' AND pg_get_expr(p.polqual, p.polrelid) = 'true';
  IF v_skill > 0 THEN
    RAISE EXCEPTION '330: skill_catalog still has a USING(true) policy';
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
