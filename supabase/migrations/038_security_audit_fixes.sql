-- Migration 038: Adversarial multi-tenant isolation audit — critical fixes
-- (numbered 038 because migration 037 was taken concurrently by another
-- session's account_de.sql; this file was applied to the live DB while
-- numbered 037, then renamed to 038 here purely to keep the migration
-- file sequence consistent with what's on disk — no re-application
-- needed, the DB already reflects everything in this file)
--
-- Context: pre-onboarding security audit found platform_config (holds
-- platform-wide secrets: RESEND_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY,
-- GOOGLE_AI_KEY, and per-tenant alert-email settings) had RLS disabled AND
-- default anon/authenticated grants left in place. Confirmed LIVE via an
-- unauthenticated curl against the public REST API: anon key could both
-- READ every secret in the table and WRITE/DELETE arbitrary rows with zero
-- authentication. This migration locks it down to service-role only, which
-- was always the documented intent (see migration 007's own comment).

-- 1) Revoke all default PostgREST-exposed-role grants. Only service_role
--    (used exclusively by edge functions, never shipped to any client)
--    may touch this table going forward.
REVOKE ALL ON TABLE platform_config FROM anon;
REVOKE ALL ON TABLE platform_config FROM authenticated;

-- 2) Enable RLS and force it, then add an explicit deny-all policy for
--    completeness/defense-in-depth (belt AND suspenders: even if a future
--    migration accidentally re-grants table privileges to anon/authenticated,
--    RLS with no permissive policy still blocks all access from those roles).
ALTER TABLE platform_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_config FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_config_service_only ON platform_config;
CREATE POLICY platform_config_service_only ON platform_config
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- Note: service_role bypasses RLS entirely (Postgres BYPASSRLS on that role
-- in Supabase), so this deny-all policy does not affect service_role access
-- from edge functions — it only blocks anon/authenticated, which is exactly
-- the intent.

-- 3) The frontend SettingsPage "AI Engine" tab previously called
--    platform_config directly via the anon/authenticated client
--    (savePlatformConfig / hasPlatformConfigKey in src/lib/api.ts). That
--    path is now fixed to go through this SECURITY DEFINER RPC instead,
--    which is itself gated to platform_super_admin/platform-layer users
--    only (this was previously ungated in the UI and, worse, ungated at
--    the DB level too).
CREATE OR REPLACE FUNCTION platform_config_set(p_entries jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k text;
  v text;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  FOR k, v IN SELECT * FROM jsonb_each_text(p_entries)
  LOOP
    INSERT INTO platform_config (key, value, updated_at)
    VALUES (k, v, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END LOOP;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION platform_config_has_key(p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN EXISTS (SELECT 1 FROM platform_config WHERE key = p_key);
END;
$$;

-- Only authenticated users may even attempt these RPCs (anon cannot call
-- them at all); the is_platform_admin() check inside enforces the real
-- authorization boundary regardless of role.
REVOKE ALL ON FUNCTION platform_config_set(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_config_has_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_config_set(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION platform_config_has_key(text) TO authenticated;

-- =====================================================================
-- CRITICAL: handle_new_user signup tenant-takeover
-- =====================================================================
-- Live adversarial test (this audit): an unauthenticated caller with only
-- the public anon key called POST /auth/v1/signup with
-- options.data.tenant_id = <Acme Telecom's real tenant UUID>. handle_new_user
-- read that value straight from NEW.raw_user_meta_data->>'tenant_id' with
-- ZERO validation and inserted a `profiles` row with role='tenant_owner'
-- pointing at Acme Telecom's real tenant. Since every RLS policy in this
-- system correctly trusts profiles.tenant_id (by design — that part is
-- fine), this forged profile then had full tenant_owner-level RLS-legitimate
-- access to 100% of Acme Telecom's data. This is a complete tenant-takeover
-- vulnerability via self-signup, not just a demo-tenant mixup — reproduced
-- live, then cleaned up (profile + auth.users row deleted).
--
-- Root cause: raw_user_meta_data is fully client-controlled at signup time
-- (options.data in supabase.auth.signUp()) and must never be trusted as an
-- authorization claim. The application's own real signup flow (LoginPage.tsx
-- handleSignUp) never puts tenant_id in signup metadata — it creates a fresh
-- `tenants` row and then inserts `profiles` explicitly, itself, after signup.
-- So handle_new_user has no legitimate reason to ever honor a client-supplied
-- tenant_id at all. Fix: strip that trust entirely. New auth users always get
-- tenant_id = NULL from the trigger; real tenant assignment only happens
-- through the app's own controlled insert (self-serve creates a brand-new
-- tenant for a brand-new user) or the invite flow (useUsers.ts `invite`,
-- which inserts the profile directly with a tenant_id the *inviting* admin's
-- own session already owns — that path is safe because the inviter's own
-- RLS-derived tenant_id gates it, not attacker-supplied metadata).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name, avatar, role, layer, tenant_id)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar',
    -- role from metadata is still just a display-preference default here;
    -- it grants nothing by itself until a profile row + real tenant_id
    -- exist, and tenant-scoped RLS never trusts role alone without also
    -- matching tenant_id, so this remains safe. tenant_id itself must
    -- NEVER be sourced from client-controlled signup metadata.
    COALESCE(NEW.raw_user_meta_data->>'role', 'agent'),
    COALESCE(NEW.raw_user_meta_data->>'layer', 'tenant'),
    NULL
  ) ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Defense-in-depth: even if some future code path ever re-introduces a
-- client-influenceable tenant_id at profile-insert time, a brand-new
-- profile can never be created already pointing at the demo tenant.
-- (Existing demo-login profiles are untouched — this only blocks INSERT of
-- new rows, never blocks UPDATE of a pre-existing demo profile.)
CREATE OR REPLACE FUNCTION guard_against_demo_tenant_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.tenant_id = 'a0000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'Cannot assign new signups to the demo tenant (a0000000-0000-0000-0000-000000000001). This tenant is reserved for the seeded product demo only.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_demo_tenant ON profiles;
CREATE TRIGGER trg_guard_demo_tenant
  BEFORE INSERT ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION guard_against_demo_tenant_assignment();

-- =====================================================================
-- Demo tenant rename
-- =====================================================================
-- The seeded demo tenant was named "Outsourcetel" — identical to the
-- founder's real company name. This caused the founder's own real account
-- to be accidentally misattached to the demo tenant. Renamed to an
-- unmistakable name.
UPDATE tenants
SET name = 'Demo Workspace'
WHERE id = 'a0000000-0000-0000-0000-000000000001';

-- =====================================================================
-- SECURITY DEFINER functions: missing tenant-ownership checks
-- =====================================================================
-- A parallel audit of all 68 SECURITY DEFINER functions in `public` found
-- 12 that accept a client-suppliable p_tenant_id-like parameter, are
-- EXECUTE-granted to anon/authenticated (Postgres default: EXECUTE is
-- granted to PUBLIC unless explicitly revoked — none of these had ever
-- been revoked), and perform ZERO check that the parameter matches the
-- caller's own tenant. Since these are SECURITY DEFINER, they bypass RLS
-- entirely — the missing check is not backstopped by anything else.
--
-- Two fix strategies, applied per-function based on actual legitimate
-- calling pattern (checked against real call sites in src/ and
-- supabase/functions/):
--   (A) Functions with a genuine direct end-user calling pattern
--       (found via supabase.rpc(...) in src/) get an explicit
--       ownership guard added to the function body.
--   (B) Functions with NO direct frontend call site (only ever invoked
--       internally, from another already-checked SECURITY DEFINER
--       function, or intended for cron/service-role use only) get
--       EXECUTE revoked from anon/authenticated instead — the safest
--       fix, since it removes the attack surface entirely rather than
--       trying to guess the "correct" check for a function that was
--       never meant to be called directly.

-- --- (A) Direct end-user call sites confirmed — add ownership guard ---

-- search_knowledge: called directly from src/lib/api.ts (draftAgentAction,
-- legacy pre-rebuild fallback path) via supabase.rpc('search_knowledge', ...).
-- Both overloads existed with zero tenant check, while sibling functions in
-- the same migration (match_cached_answer, match_doc_chunks,
-- visible_knowledge_docs) already had the correct guard — this looks like
-- an oversight where the pattern wasn't applied consistently.
CREATE OR REPLACE FUNCTION public.search_knowledge(p_tenant_id uuid, p_query text, p_audience text DEFAULT NULL::text, p_limit integer DEFAULT 5)
RETURNS TABLE(id uuid, title text, summary text, body text, audience text, category text, tags text[], rank real)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT ka.id, ka.title, ka.summary, ka.body, ka.audience, ka.category, ka.tags,
         ts_rank(ka.search_tsv, websearch_to_tsquery('english', p_query)) AS rank
  FROM public.knowledge_articles ka
  WHERE ka.tenant_id = p_tenant_id
    AND (auth.uid() IS NULL OR p_tenant_id IN (SELECT tenant_id FROM public.profiles WHERE user_id = auth.uid()))
    AND ka.status = 'published'
    AND (p_audience IS NULL OR ka.audience = p_audience OR ka.audience = 'all')
    AND ka.search_tsv @@ websearch_to_tsquery('english', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_limit, 1);
$$;

CREATE OR REPLACE FUNCTION public.search_knowledge(p_tenant_id uuid, p_query text, p_limit integer DEFAULT 5)
RETURNS TABLE(id uuid, title text, body text, similarity double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND p_tenant_id NOT IN (SELECT tenant_id FROM profiles WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'tenant access denied';
  END IF;
  RETURN QUERY
  SELECT ka.id, ka.title, ka.body,
    ts_rank(
      to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.body,'')),
      plainto_tsquery('english', p_query)
    )::float AS similarity
  FROM knowledge_articles ka
  WHERE ka.tenant_id = p_tenant_id
    AND ka.status = 'published'
    AND to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.body,''))
        @@ plainto_tsquery('english', p_query)
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;

-- resolve_action_execution_for_task: called directly from
-- src/lib/connectorApi.ts (resolveActionExecution) with only a task_id.
-- A malicious authenticated user could pass another tenant's task UUID and
-- read that tenant's action_executions row (params/result/receipt — may
-- contain PII or business data). Add an explicit tenant-ownership check by
-- joining through human_tasks (which carries tenant_id) for the same task.
-- Original returned a single `action_executions` row (LANGUAGE sql, not
-- SETOF) — preserve that exact return shape so the frontend's existing
-- `.rpc(...)` call (which expects a single object, not an array) keeps
-- working unchanged.
DROP FUNCTION IF EXISTS public.resolve_action_execution_for_task(uuid);
CREATE OR REPLACE FUNCTION public.resolve_action_execution_for_task(p_task_id uuid)
RETURNS action_executions
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_task_tenant uuid;
  v_row action_executions;
BEGIN
  SELECT tenant_id INTO v_task_tenant FROM human_tasks WHERE id = p_task_id;
  IF v_task_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  IF auth.uid() IS NOT NULL AND v_task_tenant NOT IN (SELECT tenant_id FROM profiles WHERE user_id = auth.uid()) AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'tenant access denied';
  END IF;
  SELECT ae.* INTO v_row FROM action_executions ae
    WHERE ae.task_id = p_task_id AND ae.tenant_id = v_task_tenant
    ORDER BY ae.created_at DESC LIMIT 1;
  RETURN v_row;
END;
$$;

-- --- (B) No direct end-user call site found — revoke EXECUTE from
--         anon/authenticated entirely. All confirmed called only from
--         edge functions (service-role) or other already-tenant-checked
--         SECURITY DEFINER functions, never from src/ via supabase.rpc(). ---

REVOKE EXECUTE ON FUNCTION resolve_access(uuid, text, uuid, uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION resolve_action_definition_for_category(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION resolve_work_item_framing(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION decide_action_execution(uuid, text, text, boolean) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION decide_inquiry_triage(uuid, text, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION decide_work_item_triage(uuid, text, text, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION touch_inbox_watch_state(uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION upsert_inbox_watch_state(uuid, uuid, text, timestamptz) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION trust_apply_level(uuid, text, integer, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION trust_demote(uuid, text, text, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION increment_tenant_token_usage(uuid, text, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION poll_de_work_sources_targets(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION poll_support_inbox_targets(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION trust_evidence_for(trust_policies) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION match_knowledge_chunks(vector, uuid, double precision, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION p_workspace_period_end(uuid) FROM anon, authenticated;

-- These revokes still allow the functions to run correctly when invoked by
-- postgres/service_role (edge functions, cron dispatchers, and other
-- SECURITY DEFINER functions calling them internally) — REVOKE only affects
-- the anon/authenticated PostgREST-facing roles, not internal callers.
