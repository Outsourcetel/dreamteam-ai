-- 375_scim_tokens.sql
-- ============================================================================
-- SCIM 2.0 user provisioning — the storage + authorization layer.
--
-- WHY THIS, AND WHY NOW
-- The enterprise-readiness audit scored 27/100. "How do you deprovision a
-- leaver?" is the second question a buyer's IT team asks after "do you support
-- SSO?". Today the honest answer is: a human opens the Team page and clicks.
-- Nothing in this product can be driven by the customer's Okta/Entra, so a
-- terminated employee keeps their account until somebody remembers.
--
-- SAML is blocked on the Supabase plan (config/auth: saml_enabled = false, free
-- plan). SCIM is NOT — it is our own HTTP endpoint, so it works today and keeps
-- working regardless of which plan the org lands on. That is why this piece is
-- built first: it is the half of "enterprise identity" that is not gated.
--
-- ── THE THREAT THIS SCHEMA IS SHAPED AROUND ────────────────────────────────
-- A SCIM endpoint is a service-role-powered write path into profiles, driven by
-- a bearer token, from a caller with no Supabase JWT. Two ways it kills us:
--
--   1. CROSS-TENANT REACH. If tenant A's token can name a tenant, or name a
--      resource id belonging to tenant B, A reads or deactivates B's people.
--   2. ACCOUNT CAPTURE. If A can POST /Users with an email whose account
--      already belongs to B, and we simply move that profile, A has just
--      absorbed one of B's users — and everything that user can see.
--
-- Neither is defended by RLS, because the edge function holds the service-role
-- key and service_role bypasses RLS entirely. So the defense CANNOT live in the
-- edge function's own care. It lives here:
--
--   · The edge function never names a tenant. There is no tenant parameter on
--     any function that accepts a token. The tenant is DERIVED from the token
--     hash inside the database, every single call. A bug in the TypeScript
--     cannot widen that, because there is no argument through which to widen it.
--   · Every read and every write is filtered by that derived tenant, including
--     when the caller supplies an explicit resource id.
--   · scim_user_links carries a trigger-enforced invariant that a link row can
--     never point at a profile belonging to a different tenant. Even a direct
--     service-role INSERT cannot create a cross-tenant link.
--   · A profile that already belongs to another tenant is NEVER re-homed. That
--     path returns a conflict, always, with no flag to turn it off.
--
-- ── WHAT IS DELIBERATELY *NOT* HERE ────────────────────────────────────────
-- No /Groups, and SCIM assigns no admin role. An IdP-driven role grant with no
-- group model is a privilege-escalation channel wearing a spec's clothes.
-- Provisioned users get role 'agent' — the exact default handle_new_user()
-- already assigns to every signup (verified against the live definition), which
-- is referenced by 4 live RLS policies. No role is invented here; the audit
-- already flagged "UI advertises 7, database enforces 3" and this must not make
-- that worse. Elevation to tenant_admin stays a human action in the app.
--
-- ⚠ handle_new_user() IS NOT TOUCHED BY THIS MIGRATION. Migration 056 broke
-- signup silently and it took until 115 to notice. The provisioning flow works
-- WITH the trigger — the edge function creates the auth user, the trigger
-- inserts its usual tenant_id=NULL / role='agent' row, and scim_user_upsert
-- then claims that row. Nothing about the trigger changes.
--
-- ── MEASURED, TODAY, AGAINST PRODUCTION ────────────────────────────────────
--   auth_tenant_id()      returns NULL when profiles.is_active = false
--                         (live definition: `coalesce(is_active, true) = true`)
--   232                   RLS policies reference auth_tenant_id()
--   216                   tenant tables have RLS enabled
--   auth_has_tenant_role  also gates on coalesce(is_active,true)
--   is_platform_admin     also gates on coalesce(is_active,true)
-- That chain is the whole reason deprovisioning here is `is_active = false`
-- rather than a delete: flipping one boolean makes 232 policies deny, on the
-- caller's very next query, with no session cleanup required. See the DELETE
-- justification at scim_user_delete.
--
--   pgcrypto lives in schema `extensions`, NOT public. Every digest() and
--   gen_random_bytes() call below is schema-qualified because these functions
--   pin `SET search_path TO 'public'`. The older embed-token functions
--   (20260720_reply_mode_system.sql:336) got away with a bare digest() only
--   because they pin no search_path at all. Copying them verbatim would fail.
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- 1. TOKENS
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.scim_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- ONLY the hash. The plaintext is returned once, by scim_token_issue, and is
  -- never written anywhere. The CHECK is not decoration: 64 lowercase hex chars
  -- is exactly a sha256 digest, and a plaintext token ('dtscim_' + 64 hex = 71
  -- chars) cannot satisfy it. So "we accidentally stored the secret" is not a
  -- code-review question, it is a constraint violation.
  token_hash   text NOT NULL UNIQUE
               CONSTRAINT scim_tokens_hash_is_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  -- Six hex characters of the DIGEST (not of the secret) so an admin can tell
  -- two tokens apart in the UI. Length-pinned by CHECK so this column can never
  -- quietly grow into a place the whole token fits.
  token_prefix text NOT NULL
               CONSTRAINT scim_tokens_prefix_is_short CHECK (token_prefix ~ '^dtscim_[0-9a-f]{6}$'),

  name         text NOT NULL CHECK (btrim(name) <> ''),

  -- OFF by default, and it is the ONLY switch in this schema. It permits
  -- claiming an auth account that exists but belongs to NO tenant. It can never
  -- touch an account that belongs to another tenant — that is refused
  -- unconditionally, with no flag. See scim_user_upsert.
  allow_account_adoption boolean NOT NULL DEFAULT false,

  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid
);

COMMENT ON TABLE public.scim_tokens IS
  'Bearer tokens for the /scim edge function, one tenant each. Only the sha256 hash is stored (CHECK-enforced); the plaintext is shown once at issue and is unrecoverable afterwards. Revocation is revoked_at, not DELETE, so an audit still shows the token existed.';
COMMENT ON COLUMN public.scim_tokens.allow_account_adoption IS
  'Opt-in: let this token claim an existing auth account that belongs to no tenant. Never permits claiming an account that belongs to a different tenant.';

CREATE INDEX IF NOT EXISTS scim_tokens_tenant_live_idx
  ON public.scim_tokens (tenant_id) WHERE revoked_at IS NULL;

-- Deny-all: RLS on, zero policies. These rows are reachable only through the
-- SECURITY DEFINER functions below. A tenant admin listing their tokens goes
-- through scim_tokens_list, which never returns token_hash — so even a
-- compromised admin session cannot walk away with the hashes.
ALTER TABLE public.scim_tokens ENABLE ROW LEVEL SECURITY;


-- ════════════════════════════════════════════════════════════════════════════
-- 2. USER LINKS  — the SCIM resource
-- ════════════════════════════════════════════════════════════════════════════
-- A separate table rather than columns on profiles, for three reasons:
--   · profiles is load-bearing for 232 policies; SCIM metadata does not belong
--     in the identity table's hot path.
--   · userName uniqueness must be per-tenant. profiles has no email column at
--     all (email lives in auth.users), so there is nowhere on profiles to put
--     a per-tenant unique constraint.
--   · the SCIM resource id must be opaque and tenant-scoped. Handing out
--     profiles.id as the SCIM id would leak a platform-wide identifier.

CREATE TABLE IF NOT EXISTS public.scim_user_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- the SCIM "id"
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id)  ON DELETE CASCADE,
  profile_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,                                -- auth.users.id
  user_name    text NOT NULL CHECK (btrim(user_name) <> ''), -- SCIM userName (= email)
  external_id  text,                                         -- the IdP's own id
  given_name   text,
  family_name  text,
  active       boolean NOT NULL DEFAULT true,

  -- Soft delete. RFC 7644 §3.6 explicitly allows a provider not to permanently
  -- remove a resource, provided a later GET returns 404 — which is what
  -- scim_user_get does for a row with deleted_at set. See the justification on
  -- scim_user_delete for why a hard delete is the wrong choice here.
  deleted_at   timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by_token uuid REFERENCES public.scim_tokens(id) ON DELETE SET NULL,
  last_token_id    uuid REFERENCES public.scim_tokens(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.scim_user_links IS
  'One row per SCIM-managed user. id is the SCIM resource id. Soft-deleted rows are retained (deleted_at) so a rehire re-uses the same record and so audit attribution survives; scim_user_get returns not_found for them, per RFC 7644 3.6.';

-- Includes soft-deleted rows on purpose: that is what makes a rehire find and
-- revive the original record instead of minting a second one for the same
-- person, which would leave two SCIM ids pointing at one human.
CREATE UNIQUE INDEX IF NOT EXISTS scim_user_links_tenant_username_key
  ON public.scim_user_links (tenant_id, lower(user_name));
CREATE UNIQUE INDEX IF NOT EXISTS scim_user_links_profile_key
  ON public.scim_user_links (profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS scim_user_links_tenant_external_key
  ON public.scim_user_links (tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scim_user_links_tenant_live_idx
  ON public.scim_user_links (tenant_id) WHERE deleted_at IS NULL;

ALTER TABLE public.scim_user_links ENABLE ROW LEVEL SECURITY;

-- ── The isolation invariant, enforced by the database itself ────────────────
-- Everything else in this file is careful code. This is the thing that is true
-- even if the careful code is wrong: a link row cannot exist whose tenant is
-- not the tenant of the profile it points at. service_role bypasses RLS, but
-- it does not bypass a trigger.
CREATE OR REPLACE FUNCTION public.scim_link_matches_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_profile_tenant uuid; v_profile_user uuid; v_found boolean;
BEGIN
  SELECT p.tenant_id, p.user_id, true INTO v_profile_tenant, v_profile_user, v_found
    FROM public.profiles p WHERE p.id = NEW.profile_id;

  IF v_found IS NOT TRUE THEN
    RAISE EXCEPTION 'scim_user_links: profile % does not exist', NEW.profile_id;
  END IF;
  -- IS DISTINCT FROM, not <>: a NULL profile tenant (an unclaimed account) must
  -- FAIL this check, and `NULL <> NEW.tenant_id` would evaluate to NULL and let
  -- the row through. Same null-logic trap migration 369 fixed in a guard.
  IF v_profile_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'scim_user_links: profile % belongs to tenant %, refusing to link it to tenant %',
      NEW.profile_id, coalesce(v_profile_tenant::text, '<none>'), NEW.tenant_id;
  END IF;
  IF v_profile_user IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'scim_user_links: user_id % is not the auth user of profile %',
      NEW.user_id, NEW.profile_id;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS scim_user_links_tenant_guard ON public.scim_user_links;
CREATE TRIGGER scim_user_links_tenant_guard
  BEFORE INSERT OR UPDATE OF tenant_id, profile_id, user_id ON public.scim_user_links
  FOR EACH ROW EXECUTE FUNCTION public.scim_link_matches_profile();

REVOKE ALL ON ROUTINE public.scim_link_matches_profile() FROM PUBLIC, anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 3. TOKEN ADMINISTRATION  (tenant admins, from the app)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.scim_token_issue(
  p_tenant uuid,
  p_name text,
  p_allow_account_adoption boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_body text; v_token text; v_hash text; v_id uuid; v_actor text;
BEGIN
  -- coalesce(..., false) IS NOT TRUE, never `IF NOT can_admin...`.
  -- can_admin_tenant_internal returns NULL for a caller with no tenant (NULL =
  -- p_tenant is NULL, not false), and `IF NOT NULL THEN` does not fire — the
  -- guard would silently pass. This is the fail-open shape migration 369
  -- removed from set_improvement_publish_scope; it does not get to come back.
  IF coalesce(public.can_admin_tenant_internal(p_tenant), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'not authorized to issue SCIM tokens for this workspace';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'a name is required so this token can be told apart from the others';
  END IF;

  -- 32 random bytes = 256 bits. Not guessable, so the rate limit on the edge
  -- function is about abuse volume, not about protecting this secret.
  v_body  := encode(extensions.gen_random_bytes(32), 'hex');
  v_token := 'dtscim_' || v_body;
  v_hash  := encode(extensions.digest(v_token, 'sha256'), 'hex');

  INSERT INTO public.scim_tokens (tenant_id, token_hash, token_prefix, name,
                                  allow_account_adoption, created_by)
  VALUES (p_tenant, v_hash, 'dtscim_' || substr(v_hash, 1, 6), btrim(p_name),
          coalesce(p_allow_account_adoption, false), auth.uid())
  RETURNING id INTO v_id;

  SELECT coalesce(full_name, 'a workspace admin') INTO v_actor
    FROM public.profiles WHERE user_id = auth.uid();

  PERFORM public.append_audit_event_internal(
    p_tenant, coalesce(v_actor, 'a workspace admin'), 'human',
    format('Issued SCIM provisioning token "%s"', btrim(p_name)),
    'access_control',
    jsonb_build_object('kind', 'scim_token_issued', 'token_id', v_id,
                       'prefix', 'dtscim_' || substr(v_hash, 1, 6),
                       'allow_account_adoption', coalesce(p_allow_account_adoption, false)));

  -- The only moment the plaintext exists outside the caller's IdP config.
  RETURN jsonb_build_object(
    'ok', true, 'id', v_id, 'token', v_token,
    'prefix', 'dtscim_' || substr(v_hash, 1, 6), 'name', btrim(p_name));
END $fn$;

REVOKE ALL ON ROUTINE public.scim_token_issue(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.scim_token_issue(uuid, text, boolean) TO authenticated;


CREATE OR REPLACE FUNCTION public.scim_token_revoke(p_token_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid; v_name text; v_actor text;
BEGIN
  SELECT tenant_id, name INTO v_tenant, v_name
    FROM public.scim_tokens WHERE id = p_token_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'token not found'; END IF;
  IF coalesce(public.can_admin_tenant_internal(v_tenant), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  UPDATE public.scim_tokens
     SET revoked_at = coalesce(revoked_at, now()), revoked_by = auth.uid()
   WHERE id = p_token_id;

  SELECT coalesce(full_name, 'a workspace admin') INTO v_actor
    FROM public.profiles WHERE user_id = auth.uid();
  PERFORM public.append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'a workspace admin'), 'human',
    format('Revoked SCIM provisioning token "%s"', v_name), 'access_control',
    jsonb_build_object('kind', 'scim_token_revoked', 'token_id', p_token_id));

  RETURN jsonb_build_object('ok', true);
END $fn$;

REVOKE ALL ON ROUTINE public.scim_token_revoke(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.scim_token_revoke(uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.scim_tokens_list(p_tenant uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_rows jsonb;
BEGIN
  IF coalesce(public.can_admin_tenant_internal(p_tenant), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  -- token_hash is deliberately absent from this projection.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'name', t.name, 'prefix', t.token_prefix,
           'allow_account_adoption', t.allow_account_adoption,
           'created_at', t.created_at, 'last_used_at', t.last_used_at,
           'revoked_at', t.revoked_at) ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows FROM public.scim_tokens t WHERE t.tenant_id = p_tenant;
  RETURN jsonb_build_object('ok', true, 'tokens', v_rows);
END $fn$;

REVOKE ALL ON ROUTINE public.scim_tokens_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.scim_tokens_list(uuid) TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 4. THE TOKEN → TENANT DERIVATION
-- ════════════════════════════════════════════════════════════════════════════
-- Every function below this line takes p_token and NO tenant argument. This is
-- the single choke point where a tenant is decided, and the caller has no say
-- in it. The DO $assert$ block at the bottom enforces, permanently, that no
-- scim_* function ever gains both a token argument and a tenant argument.

CREATE OR REPLACE FUNCTION public.scim_token_context(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_hash text; v_id uuid; v_tenant uuid; v_adopt boolean; v_name text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 THEN RETURN NULL; END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- One indexed equality on the digest. There is no comparison against the
  -- secret itself anywhere, so there is no byte-at-a-time timing signal to
  -- leak — the lookup either hits the unique index or it does not.
  --
  -- A suspended tenant's token stops working here rather than at 200 call
  -- sites: status is joined in, not checked later.
  SELECT k.id, k.tenant_id, k.allow_account_adoption, k.name
    INTO v_id, v_tenant, v_adopt, v_name
    FROM public.scim_tokens k
    JOIN public.tenants t ON t.id = k.tenant_id
   WHERE k.token_hash = v_hash
     AND k.revoked_at IS NULL
     AND t.status IN ('active', 'trial');

  IF v_tenant IS NULL THEN RETURN NULL; END IF;

  UPDATE public.scim_tokens SET last_used_at = now() WHERE id = v_id;

  RETURN jsonb_build_object('token_id', v_id, 'tenant_id', v_tenant,
                            'allow_account_adoption', v_adopt, 'name', v_name);
END $fn$;

-- authenticated is revoked too: this is the authentication primitive and only
-- the edge function (service_role) has any business calling it. Postgres grants
-- EXECUTE to PUBLIC by default and CREATE OR REPLACE resets grants, so this
-- REVOKE must sit after the body — see migration 369's note.
REVOKE ALL ON ROUTINE public.scim_token_context(text) FROM PUBLIC, anon, authenticated;


-- ── Resource rendering, one place, so list and get cannot drift ─────────────
CREATE OR REPLACE FUNCTION public.scim_user_resource_json(p_link_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT jsonb_build_object(
    'schemas', jsonb_build_array('urn:ietf:params:scim:schemas:core:2.0:User'),
    'id', l.id::text,
    'externalId', l.external_id,
    'userName', l.user_name,
    'name', jsonb_strip_nulls(jsonb_build_object(
              'givenName', l.given_name, 'familyName', l.family_name,
              'formatted', p.full_name)),
    'displayName', p.full_name,
    'emails', jsonb_build_array(jsonb_build_object(
                'value', l.user_name, 'type', 'work', 'primary', true)),
    'active', l.active,
    'meta', jsonb_build_object(
      'resourceType', 'User',
      'created', to_char(l.created_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'lastModified', to_char(l.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      -- ETag over the row's own mutable state. The edge function adds
      -- meta.location, which needs the request URL and is not knowable here.
      'version', 'W/"' || md5(l.id::text || l.updated_at::text || l.active::text) || '"'))
  FROM public.scim_user_links l
  JOIN public.profiles p ON p.id = l.profile_id
  WHERE l.id = p_link_id;
$fn$;

REVOKE ALL ON ROUTINE public.scim_user_resource_json(uuid) FROM PUBLIC, anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 5. SCIM /Users OPERATIONS
-- ════════════════════════════════════════════════════════════════════════════
-- Expected outcomes (not found, conflict, bad token) are RETURNED as
-- {"ok": false, "error": "..."} rather than raised. Raising would make the edge
-- function's behaviour depend on how PostgREST maps SQLSTATEs to HTTP status
-- codes and on supabase-js surfacing error.code — two layers of plumbing
-- between a security decision and its enforcement. A returned discriminator is
-- something the assertion block below can test directly, and it is what the
-- edge function's single unwrap() helper switches on.

CREATE OR REPLACE FUNCTION public.scim_users_list(
  p_token text,
  p_user_name text DEFAULT NULL,
  p_external_id text DEFAULT NULL,
  p_start_index integer DEFAULT 1,
  p_count integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_ctx jsonb; v_tenant uuid;
  v_start integer; v_count integer; v_total integer; v_rows jsonb;
BEGIN
  v_ctx := public.scim_token_context(p_token);
  IF v_ctx IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;
  v_tenant := (v_ctx->>'tenant_id')::uuid;

  v_start := greatest(coalesce(p_start_index, 1), 1);          -- SCIM is 1-based
  v_count := least(greatest(coalesce(p_count, 100), 0), 200);  -- count=0 is legal

  SELECT count(*) INTO v_total
    FROM public.scim_user_links l
   WHERE l.tenant_id = v_tenant                                -- ← derived, never supplied
     AND l.deleted_at IS NULL
     AND (p_user_name   IS NULL OR lower(l.user_name) = lower(btrim(p_user_name)))
     AND (p_external_id IS NULL OR l.external_id = p_external_id);

  SELECT coalesce(jsonb_agg(r ORDER BY ord), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT public.scim_user_resource_json(l.id) AS r,
             row_number() OVER (ORDER BY l.created_at, l.id) AS ord
        FROM public.scim_user_links l
       WHERE l.tenant_id = v_tenant
         AND l.deleted_at IS NULL
         AND (p_user_name   IS NULL OR lower(l.user_name) = lower(btrim(p_user_name)))
         AND (p_external_id IS NULL OR l.external_id = p_external_id)
       ORDER BY l.created_at, l.id
       OFFSET v_start - 1 LIMIT v_count
    ) s;

  RETURN jsonb_build_object('ok', true, 'totalResults', v_total,
                            'startIndex', v_start, 'itemsPerPage', jsonb_array_length(v_rows),
                            'resources', v_rows);
END $fn$;

REVOKE ALL ON ROUTINE public.scim_users_list(text, text, text, integer, integer)
  FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.scim_user_get(p_token text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_ctx jsonb; v_tenant uuid; v_res jsonb;
BEGIN
  v_ctx := public.scim_token_context(p_token);
  IF v_ctx IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;
  v_tenant := (v_ctx->>'tenant_id')::uuid;

  -- THE ATTACK THIS LINE ANSWERS: the caller supplies an id belonging to
  -- another tenant. tenant_id = v_tenant makes that indistinguishable from an
  -- id that does not exist — same not_found, no existence oracle.
  SELECT public.scim_user_resource_json(l.id) INTO v_res
    FROM public.scim_user_links l
   WHERE l.id = p_id AND l.tenant_id = v_tenant AND l.deleted_at IS NULL;

  IF v_res IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'resource', v_res);
END $fn$;

REVOKE ALL ON ROUTINE public.scim_user_get(text, uuid) FROM PUBLIC, anon, authenticated;


-- ── POST /Users, step 1: decide what this userName means ───────────────────
CREATE OR REPLACE FUNCTION public.scim_provision_begin(p_token text, p_user_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_ctx jsonb; v_tenant uuid; v_adopt boolean; v_uname text;
  v_link public.scim_user_links; v_auth_id uuid; v_meta_tenant text;
  v_profile_tenant uuid; v_has_profile boolean := false;
BEGIN
  v_ctx := public.scim_token_context(p_token);
  IF v_ctx IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;
  v_tenant := (v_ctx->>'tenant_id')::uuid;
  v_adopt  := coalesce((v_ctx->>'allow_account_adoption')::boolean, false);

  v_uname := lower(btrim(coalesce(p_user_name, '')));
  -- Documented constraint: userName IS the login email here. Supabase Auth is
  -- keyed on email, so a userName that is not an email could never be matched
  -- to an account and the record would be permanently unusable. Better to
  -- refuse at provisioning time than to create a ghost.
  IF v_uname = '' OR position('@' IN v_uname) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_username',
                              'detail', 'userName must be the user''s email address');
  END IF;

  SELECT * INTO v_link FROM public.scim_user_links
   WHERE tenant_id = v_tenant AND lower(user_name) = v_uname;

  IF v_link.id IS NOT NULL AND v_link.deleted_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict',
                              'detail', 'a user with this userName already exists');
  END IF;
  IF v_link.id IS NOT NULL THEN
    -- Rehire: the record was soft-deleted. Reuse it rather than mint a second
    -- SCIM id for the same human.
    RETURN jsonb_build_object('ok', true, 'mode', 'link', 'tenant_id', v_tenant,
                              'user_id', v_link.user_id,
                              'reason', 'reviving a previously deprovisioned record');
  END IF;

  SELECT u.id, u.raw_app_meta_data->>'scim_tenant' INTO v_auth_id, v_meta_tenant
    FROM auth.users u WHERE lower(u.email) = v_uname;

  IF v_auth_id IS NULL THEN
    -- tenant_id is echoed back so the edge function can stamp it into the new
    -- account's app_metadata. It is not a tenant the caller chose: it came from
    -- the token, and scim_user_upsert re-derives it rather than trusting it.
    RETURN jsonb_build_object('ok', true, 'mode', 'create', 'tenant_id', v_tenant);
  END IF;

  -- FOUND, not a `SELECT ..., true INTO` sentinel: a SELECT INTO that matches
  -- no rows sets EVERY target variable to NULL, including the sentinel, so the
  -- sentinel would be NULL rather than false and the branches below would be
  -- three-valued instead of two.
  SELECT p.tenant_id INTO v_profile_tenant FROM public.profiles p WHERE p.user_id = v_auth_id;
  v_has_profile := FOUND;

  IF v_has_profile AND v_profile_tenant = v_tenant THEN
    -- Already a member of THIS workspace — SCIM simply starts managing them.
    -- This is the ordinary path for a team that existed before SCIM was turned
    -- on, and it crosses no boundary: v_tenant came from the token.
    RETURN jsonb_build_object('ok', true, 'mode', 'link', 'tenant_id', v_tenant,
                              'user_id', v_auth_id,
                              'reason', 'existing member of this workspace');
  END IF;

  IF v_has_profile AND v_profile_tenant IS NOT NULL THEN
    -- ⚠ THE TAKEOVER ATTEMPT. Refused unconditionally: there is no flag, no
    -- setting and no request shape that re-homes another workspace's account.
    -- The message says nothing about which workspace — that would turn this
    -- endpoint into a directory of who-works-where across all 16 tenants.
    RETURN jsonb_build_object('ok', false, 'error', 'conflict',
      'detail', 'this email is already in use by an account outside this workspace');
  END IF;

  -- Account exists but belongs to no workspace.
  IF v_meta_tenant = v_tenant::text THEN
    -- We minted it ourselves for this tenant. raw_app_meta_data is writable
    -- only by the service role — never by the account holder — so this is a
    -- provenance marker, not a self-asserted claim.
    RETURN jsonb_build_object('ok', true, 'mode', 'link', 'tenant_id', v_tenant,
                              'user_id', v_auth_id,
                              'reason', 'completing a provisioning run this token started');
  END IF;
  IF v_adopt THEN
    RETURN jsonb_build_object('ok', true, 'mode', 'link', 'tenant_id', v_tenant,
                              'user_id', v_auth_id,
                              'reason', 'account adoption is enabled for this token');
  END IF;

  RETURN jsonb_build_object('ok', false, 'error', 'conflict',
    'detail', 'an account with this email exists but is not a member of this workspace; '
              'a workspace admin must add it, or enable account adoption on this SCIM token');
END $fn$;

REVOKE ALL ON ROUTINE public.scim_provision_begin(text, text) FROM PUBLIC, anon, authenticated;


-- ── POST /Users, step 2: link the account into this tenant ─────────────────
-- Deliberately re-derives every decision scim_provision_begin made instead of
-- trusting a mode passed back in. The two calls are separate HTTP round trips
-- with an auth-user creation in between; anything decided in the first and
-- merely echoed by the second is a TOCTOU window.
CREATE OR REPLACE FUNCTION public.scim_user_upsert(
  p_token text,
  p_user_id uuid,          -- auth.users.id
  p_user_name text,
  p_external_id text DEFAULT NULL,
  p_given_name text DEFAULT NULL,
  p_family_name text DEFAULT NULL,
  p_active boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_ctx jsonb; v_tenant uuid; v_adopt boolean; v_token_id uuid; v_token_name text;
  v_uname text; v_full text; v_meta_tenant text;
  v_profile public.profiles; v_link_id uuid; v_link_state text;
BEGIN
  v_ctx := public.scim_token_context(p_token);
  IF v_ctx IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;
  v_tenant     := (v_ctx->>'tenant_id')::uuid;
  v_adopt      := coalesce((v_ctx->>'allow_account_adoption')::boolean, false);
  v_token_id   := (v_ctx->>'token_id')::uuid;
  v_token_name := v_ctx->>'name';

  v_uname := lower(btrim(coalesce(p_user_name, '')));
  IF v_uname = '' OR position('@' IN v_uname) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_username');
  END IF;
  v_full := nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(p_given_name, '')), ''),
                                        nullif(btrim(coalesce(p_family_name, '')), ''))), '');

  SELECT (u.raw_app_meta_data->>'scim_tenant') INTO v_meta_tenant
    FROM auth.users u WHERE u.id = p_user_id;

  -- FOR UPDATE: two IdP pushes for the same person can land concurrently, and
  -- the window between "read tenant_id" and "write tenant_id" is exactly where
  -- a double-claim would happen.
  SELECT * INTO v_profile FROM public.profiles WHERE user_id = p_user_id FOR UPDATE;

  IF v_profile.id IS NOT NULL AND v_profile.tenant_id IS NOT NULL
     AND v_profile.tenant_id <> v_tenant THEN
    -- Unconditional. Re-checked here and not merely in scim_provision_begin.
    RETURN jsonb_build_object('ok', false, 'error', 'conflict',
      'detail', 'this email is already in use by an account outside this workspace');
  END IF;

  -- ⚠ PLATFORM STAFF ARE NOT PROVISIONABLE. EVER. NO FLAG.
  -- `layer` was referenced nowhere in this file except a comment and an INSERT
  -- column list — it was never CHECKED. Both platform_super_admin profiles have
  -- layer='platform' and tenant_id IS NULL, so they fell into the "unassigned
  -- account" branch below. The full path, with no exotic steps:
  --   a tenant admin ticks allow_account_adoption (a self-service checkbox)
  --   -> POST /Users with a platform admin's email
  --   -> mode 'link' -> tenant_id is set, layer stays 'platform', role preserved
  --   -> DELETE /Users/{id} sets is_active=false
  --   -> is_platform_admin() is layer='platform' AND is_active, so it now
  --      returns false, plus GoTrue gets a 100-year ban
  -- Two emails and one checkbox removes every platform administrator. The
  -- last-admin guard does not help: it counts only tenant_owner/tenant_admin.
  IF v_profile.id IS NOT NULL AND coalesce(v_profile.layer, 'tenant') <> 'tenant' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict',
      'detail', 'this email belongs to a platform account and cannot be managed by workspace provisioning');
  END IF;

  IF v_profile.id IS NULL OR v_profile.tenant_id IS NULL THEN
    -- Claiming an unassigned account. Allowed only with service-role-written
    -- provenance, or with the token's explicit opt-in.
    --
    -- ⚠ coalesce is load-bearing, and this is the migration-369 shape again.
    -- v_meta_tenant is NULL for every organically-signed-up account, so
    -- `NULL = v_tenant::text OR false` evaluates to NULL, `NOT NULL` is NULL,
    -- and the IF never fires — the refusal was skipped for exactly the accounts
    -- it was written to protect. Verified on production:
    --   select (NOT (null::text = 'x' OR false)) is null  ->  true
    IF NOT (coalesce(v_meta_tenant, '') = v_tenant::text OR v_adopt) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'conflict',
        'detail', 'an account with this email exists but is not a member of this workspace');
    END IF;
  END IF;

  IF v_profile.id IS NULL THEN
    -- An auth user with no profile row. handle_new_user() normally prevents
    -- this; if it ever happens, mint the same row that trigger would have — no
    -- more privilege, same 'agent' default. handle_new_user itself is untouched.
    INSERT INTO public.profiles (user_id, tenant_id, full_name, role, layer,
                                 is_active, department, invited_by)
    VALUES (p_user_id, v_tenant, v_full, 'agent', 'tenant',
            coalesce(p_active, true), '', 'SCIM: ' || coalesce(v_token_name, 'provisioning'))
    RETURNING * INTO v_profile;
  ELSE
    UPDATE public.profiles
       SET tenant_id  = v_tenant,
           full_name  = coalesce(v_full, full_name),
           -- Role is NEVER set from SCIM input, so an IdP push can neither grant
           -- nor strip tenant_admin.
           --
           -- ⚠ But "keep the existing role" is only safe for an EXISTING MEMBER.
           -- The comment here used to claim a first claim "still carries
           -- handle_new_user's 'agent'" — measured on production, that is false:
           -- there is a profile with layer='tenant', role='tenant_owner',
           -- tenant_id IS NULL, is_active=true. Adopting that row would have made
           -- the adopting workspace hand a stranger tenant_owner — able to mint
           -- further SCIM tokens and read everything.
           -- So: adopting an unassigned account starts at the floor; only a row
           -- that was ALREADY a member of this tenant keeps its role.
           role       = CASE WHEN profiles.tenant_id IS NULL THEN 'agent' ELSE profiles.role END,
           is_active  = coalesce(p_active, true),
           invited_by = coalesce(invited_by, 'SCIM: ' || coalesce(v_token_name, 'provisioning')),
           updated_at = now()
     WHERE id = v_profile.id
    RETURNING * INTO v_profile;
  END IF;

  -- userName collision with a DIFFERENT person in this tenant. Soft-deleted
  -- rows are INCLUDED here even though they are invisible over the API: the
  -- unique index on (tenant_id, lower(user_name)) covers them, so excluding
  -- them would turn a clean 409 into an unhandled unique-violation and a 500.
  IF EXISTS (SELECT 1 FROM public.scim_user_links
              WHERE tenant_id = v_tenant AND lower(user_name) = v_uname
                AND profile_id <> v_profile.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict',
                              'detail', 'a user with this userName already exists');
  END IF;

  -- Three states, not a nullable boolean: no link, a live link, or a
  -- soft-deleted one. A `SELECT (deleted_at IS NOT NULL) INTO flag` would
  -- report "no link at all" as NULL and get coalesced into the wrong answer.
  SELECT CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END INTO v_link_state
    FROM public.scim_user_links WHERE profile_id = v_profile.id;
  v_link_state := coalesce(v_link_state, 'none');

  INSERT INTO public.scim_user_links (
      tenant_id, profile_id, user_id, user_name, external_id,
      given_name, family_name, active, created_by_token, last_token_id)
  VALUES (v_tenant, v_profile.id, p_user_id, btrim(p_user_name), nullif(btrim(coalesce(p_external_id,'')), ''),
          nullif(btrim(coalesce(p_given_name,'')), ''), nullif(btrim(coalesce(p_family_name,'')), ''),
          coalesce(p_active, true), v_token_id, v_token_id)
  ON CONFLICT (profile_id) DO UPDATE
     SET user_name   = excluded.user_name,
         external_id = coalesce(excluded.external_id, public.scim_user_links.external_id),
         given_name  = coalesce(excluded.given_name,  public.scim_user_links.given_name),
         family_name = coalesce(excluded.family_name, public.scim_user_links.family_name),
         active      = excluded.active,
         deleted_at  = NULL,            -- rehire: the record comes back to life
         last_token_id = excluded.last_token_id,
         updated_at  = now()
  RETURNING id INTO v_link_id;

  PERFORM public.append_audit_event_internal(
    v_tenant, 'SCIM: ' || coalesce(v_token_name, 'provisioning'), 'system',
    format('%s %s via SCIM',
           CASE v_link_state WHEN 'deleted' THEN 'Re-provisioned'
                             WHEN 'live'    THEN 'Updated'
                             ELSE 'Provisioned' END, v_uname),
    'access_control',
    jsonb_build_object('kind', 'scim_user_provisioned', 'scim_id', v_link_id,
                       'profile_id', v_profile.id, 'token_id', v_token_id,
                       'link_state_before', v_link_state, 'active', coalesce(p_active, true)));

  -- 'created' drives 201-vs-200 in the edge function. A revive is a 201 (the
  -- resource did not exist over the API a moment ago); an update to a live
  -- record is a 200.
  RETURN jsonb_build_object('ok', true, 'created', v_link_state <> 'live',
                            'resource', public.scim_user_resource_json(v_link_id));
END $fn$;

REVOKE ALL ON ROUTINE public.scim_user_upsert(text, uuid, text, text, text, text, boolean)
  FROM PUBLIC, anon, authenticated;


-- ── PATCH /Users/{id} ──────────────────────────────────────────────────────
-- p_changes is a FLAT object the edge function distilled from the SCIM PatchOp
-- envelope: {"active":bool, "givenName":..., "familyName":..., "displayName":...,
--            "externalId":..., "userName":...}. Parsing Okta's and Entra's two
--            different PatchOp dialects belongs in TypeScript; deciding what
--            may change belongs here.
CREATE OR REPLACE FUNCTION public.scim_user_patch(
  p_token text, p_id uuid, p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_ctx jsonb; v_tenant uuid; v_token_id uuid; v_token_name text;
  v_link public.scim_user_links; v_active boolean; v_full text; v_uname text;
BEGIN
  v_ctx := public.scim_token_context(p_token);
  IF v_ctx IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;
  v_tenant     := (v_ctx->>'tenant_id')::uuid;
  v_token_id   := (v_ctx->>'token_id')::uuid;
  v_token_name := v_ctx->>'name';

  SELECT * INTO v_link FROM public.scim_user_links
   WHERE id = p_id AND tenant_id = v_tenant AND deleted_at IS NULL FOR UPDATE;
  IF v_link.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  -- jsonb_exists(), not the `?` operator: `?` is a bind placeholder to several
  -- client drivers and this SQL travels through more than one of them.
  v_active := CASE WHEN jsonb_exists(p_changes, 'active')
                   THEN coalesce((p_changes->>'active')::boolean, v_link.active)
                   ELSE v_link.active END;

  -- Refuse to strip the workspace's last admin. Migration 359 established this
  -- rule for the in-app path; an IdP that deprovisions the wrong person must
  -- not be able to route around it and leave a workspace nobody can administer.
  -- Okta surfaces this as a visible error, which is the outcome we want.
  IF v_active IS FALSE AND v_link.active IS TRUE THEN
    IF EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = v_link.profile_id
                  AND p.role IN ('tenant_owner', 'tenant_admin'))
       AND NOT EXISTS (SELECT 1 FROM public.profiles p
                        WHERE p.tenant_id = v_tenant AND p.id <> v_link.profile_id
                          AND p.role IN ('tenant_owner', 'tenant_admin')
                          AND coalesce(p.is_active, true) = true)
    THEN
      RETURN jsonb_build_object('ok', false, 'error', 'last_admin',
        'detail', 'refusing to deactivate the only remaining administrator of this workspace');
    END IF;
  END IF;

  -- userName is stored, but the login email in auth.users is NOT changed. An
  -- IdP that renames a userName must not be able to repoint a live credential
  -- at an address its operator does not control. Documented deviation.
  v_uname := nullif(btrim(coalesce(p_changes->>'userName', '')), '');
  IF v_uname IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.scim_user_links
        WHERE tenant_id = v_tenant AND lower(user_name) = lower(v_uname)
          AND id <> v_link.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict',
                              'detail', 'a user with this userName already exists');
  END IF;

  UPDATE public.scim_user_links
     SET active      = v_active,
         user_name   = coalesce(v_uname, user_name),
         given_name  = coalesce(nullif(btrim(coalesce(p_changes->>'givenName','')), ''), given_name),
         family_name = coalesce(nullif(btrim(coalesce(p_changes->>'familyName','')), ''), family_name),
         external_id = coalesce(nullif(btrim(coalesce(p_changes->>'externalId','')), ''), external_id),
         last_token_id = v_token_id,
         updated_at  = now()
   WHERE id = v_link.id;

  v_full := nullif(btrim(coalesce(p_changes->>'displayName', '')), '');

  -- THE DEPROVISION. is_active = false makes auth_tenant_id() return NULL,
  -- which makes all 232 policies that call it deny — measured today, see the
  -- header. The `tenant_id = v_tenant` predicate is redundant given the link
  -- lookup above and the trigger invariant; it is here so this UPDATE is safe
  -- read in isolation, without reconstructing the argument.
  UPDATE public.profiles
     SET is_active  = v_active,
         full_name  = coalesce(v_full, full_name),
         updated_at = now()
   WHERE id = v_link.profile_id AND tenant_id = v_tenant;

  PERFORM public.append_audit_event_internal(
    v_tenant, 'SCIM: ' || coalesce(v_token_name, 'provisioning'), 'system',
    format('%s %s via SCIM',
           CASE WHEN v_active THEN 'Reactivated' ELSE 'Deactivated' END, v_link.user_name),
    'access_control',
    jsonb_build_object('kind', 'scim_user_patched', 'scim_id', v_link.id,
                       'profile_id', v_link.profile_id, 'token_id', v_token_id,
                       'active', v_active, 'changed', p_changes - 'password'));

  -- auth_user_id is returned so the edge function can ban/unban the account
  -- through the GoTrue admin API WITHOUT ever querying scim_user_links itself.
  -- That matters: the edge function runs as service_role, so a direct read
  -- there would be unconstrained by tenant and would be the one exception to
  -- "this function never reaches a row the token did not authorise". There is
  -- no exception. The value is v_link.user_id, already proven in-tenant above.
  RETURN jsonb_build_object('ok', true, 'auth_user_id', v_link.user_id,
                            'resource', public.scim_user_resource_json(v_link.id));
END $fn$;

REVOKE ALL ON ROUTINE public.scim_user_patch(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;


-- ── DELETE /Users/{id} ─────────────────────────────────────────────────────
-- DEACTIVATE, NOT DELETE. The reasoning, since this is the decision the task
-- asks to be justified:
--
--   · ACCESS is revoked exactly as hard either way. profiles.is_active = false
--     makes auth_tenant_id() return NULL, and 232 RLS policies call it. Not
--     "on next login" — on the leaver's next query, with the JWT they already
--     hold. A hard delete of the profile row would achieve the same thing and
--     nothing more.
--   · ATTRIBUTION is only preserved one way. Every audit_events row, decision
--     trace, approval and guardrail record in this system names a human. Delete
--     the profile and those become orphaned ids — which is precisely the
--     evidence an enterprise asks for when they ask about deprovisioning. A
--     control that destroys the proof it was exercised is a worse control.
--   · RFC 7644 §3.6 permits this: a provider MAY choose not to permanently
--     remove the resource, so long as a subsequent GET returns 404. deleted_at
--     is what makes scim_user_get return not_found, so we are inside the spec,
--     not bending it.
--   · REVERSIBLE FOR A REHIRE, IRREVERSIBLE FOR ACCESS. The row survives so a
--     re-POST revives the same SCIM id; nothing about the row grants access
--     while deleted_at is set.
--
-- What this does NOT do is invalidate an access token already minted for that
-- user. Those are ~1h and every tenant table denies them meanwhile. The edge
-- function additionally bans the auth user through the admin API so no refresh
-- succeeds; that is best-effort and is stated as such in the function.
CREATE OR REPLACE FUNCTION public.scim_user_delete(p_token text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_ctx jsonb; v_tenant uuid; v_token_id uuid; v_token_name text;
  v_link public.scim_user_links; v_auth_user uuid;
BEGIN
  v_ctx := public.scim_token_context(p_token);
  IF v_ctx IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;
  v_tenant     := (v_ctx->>'tenant_id')::uuid;
  v_token_id   := (v_ctx->>'token_id')::uuid;
  v_token_name := v_ctx->>'name';

  SELECT * INTO v_link FROM public.scim_user_links
   WHERE id = p_id AND tenant_id = v_tenant AND deleted_at IS NULL FOR UPDATE;
  IF v_link.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  IF EXISTS (SELECT 1 FROM public.profiles p
              WHERE p.id = v_link.profile_id AND p.role IN ('tenant_owner', 'tenant_admin'))
     AND NOT EXISTS (SELECT 1 FROM public.profiles p
                      WHERE p.tenant_id = v_tenant AND p.id <> v_link.profile_id
                        AND p.role IN ('tenant_owner', 'tenant_admin')
                        AND coalesce(p.is_active, true) = true)
  THEN
    RETURN jsonb_build_object('ok', false, 'error', 'last_admin',
      'detail', 'refusing to remove the only remaining administrator of this workspace');
  END IF;

  UPDATE public.scim_user_links
     SET active = false, deleted_at = now(), last_token_id = v_token_id, updated_at = now()
   WHERE id = v_link.id;

  UPDATE public.profiles
     SET is_active = false, updated_at = now()
   WHERE id = v_link.profile_id AND tenant_id = v_tenant
  RETURNING user_id INTO v_auth_user;

  PERFORM public.append_audit_event_internal(
    v_tenant, 'SCIM: ' || coalesce(v_token_name, 'provisioning'), 'system',
    format('Deprovisioned %s via SCIM — access revoked', v_link.user_name),
    'access_control',
    jsonb_build_object('kind', 'scim_user_deprovisioned', 'scim_id', v_link.id,
                       'profile_id', v_link.profile_id, 'token_id', v_token_id));

  -- auth_user_id is returned so the edge function can ban the account through
  -- the GoTrue admin API. It is scoped by everything above: it is the auth user
  -- of a profile in this token's tenant, and nothing else can be returned here.
  RETURN jsonb_build_object('ok', true, 'auth_user_id', v_auth_user);
END $fn$;

REVOKE ALL ON ROUTINE public.scim_user_delete(text, uuid) FROM PUBLIC, anon, authenticated;


-- Service role bypasses RLS but not grants; it needs these explicitly because
-- the REVOKEs above stripped PUBLIC, which is where it inherited them.
GRANT EXECUTE ON ROUTINE public.scim_token_context(text)                                    TO service_role;
GRANT EXECUTE ON ROUTINE public.scim_user_resource_json(uuid)                               TO service_role;
GRANT EXECUTE ON ROUTINE public.scim_users_list(text, text, text, integer, integer)          TO service_role;
GRANT EXECUTE ON ROUTINE public.scim_user_get(text, uuid)                                    TO service_role;
GRANT EXECUTE ON ROUTINE public.scim_provision_begin(text, text)                             TO service_role;
GRANT EXECUTE ON ROUTINE public.scim_user_upsert(text, uuid, text, text, text, text, boolean) TO service_role;
GRANT EXECUTE ON ROUTINE public.scim_user_patch(text, uuid, jsonb)                           TO service_role;
GRANT EXECUTE ON ROUTINE public.scim_user_delete(text, uuid)                                 TO service_role;
GRANT EXECUTE ON ROUTINE public.scim_token_issue(uuid, text, boolean)                        TO service_role;
GRANT EXECUTE ON ROUTINE public.scim_token_revoke(uuid)                                      TO service_role;
GRANT EXECUTE ON ROUTINE public.scim_tokens_list(uuid)                                       TO service_role;


-- ════════════════════════════════════════════════════════════════════════════
-- 6. PROVE IT
-- ════════════════════════════════════════════════════════════════════════════
-- Two kinds of check, and the difference is stated rather than blurred:
--   STRUCTURAL — grants, constraints, function signatures. Cheap and permanent;
--                they also catch the NEXT scim_ function somebody adds.
--   BEHAVIOURAL — real rows, real cross-tenant calls, real assertions on what
--                comes back. Runs inside a plpgsql sub-transaction that is
--                unconditionally rolled back, so it can attempt a genuinely
--                destructive cross-tenant PATCH against live tenants and leave
--                nothing behind. That rollback is why the destructive case can
--                be tested at all instead of being argued about.
DO $assert$
DECLARE
  v_bad text;
  v_a uuid; v_b uuid; v_pa uuid; v_pb uuid; v_ua uuid; v_ub uuid; v_susp uuid;
  v_link_a uuid; v_link_b uuid; v_other_admins integer;
  v_tok_a    text := 'dtscim_' || repeat('a', 64);
  v_tok_b    text := 'dtscim_' || repeat('b', 64);
  v_tok_rev  text := 'dtscim_' || repeat('c', 64);
  v_tok_susp text := 'dtscim_' || repeat('e', 64);
  r jsonb; v_fail text := ''; v_b_active boolean; v_raised boolean;
BEGIN
  -- ── STRUCTURAL ────────────────────────────────────────────────────────────

  -- A. No scim_ function that accepts a token may also accept a tenant. This is
  --    the invariant the whole isolation argument rests on, and it must hold for
  --    functions that do not exist yet.
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p') AND p.proname LIKE 'scim\_%'
     AND pg_get_function_arguments(p.oid) ~ 'p_token text'
     AND pg_get_function_arguments(p.oid) ~ 'p_tenant';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '375: token-taking function(s) also take a caller-supplied tenant: %', v_bad;
  END IF;

  -- B. No token-taking function is reachable without the service role. anon and
  --    authenticated are both named: signup is open, so `authenticated` is one
  --    email address away from anyone on the internet. Checking these two also
  --    covers a leftover PUBLIC grant — both roles inherit PUBLIC, so a missed
  --    REVOKE ... FROM PUBLIC shows up as anon holding EXECUTE. ('public'
  --    itself cannot be passed to has_function_privilege; it is not a role.)
  SELECT string_agg(p.proname || '/' || g.grantee, ', ') INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS g(grantee)
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p') AND p.proname LIKE 'scim\_%'
     AND pg_get_function_arguments(p.oid) ~ 'p_token text'
     AND has_function_privilege(g.grantee, p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '375: SCIM token endpoint(s) executable without the service role: %', v_bad;
  END IF;

  -- C. Every token-taking function derives its tenant through the one choke
  --    point. A function that read p_token and queried directly would pass A
  --    and B and still be wrong.
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p') AND p.proname LIKE 'scim\_%'
     AND p.proname <> 'scim_token_context'
     AND pg_get_function_arguments(p.oid) ~ 'p_token text'
     AND pg_get_functiondef(p.oid) !~ 'scim_token_context';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '375: function(s) accept a token without deriving the tenant from it: %', v_bad;
  END IF;

  -- D. Plaintext has nowhere to live. The CHECK is what makes this permanent:
  --    'dtscim_' + 64 hex is 71 characters and cannot match ^[0-9a-f]{64}$.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.scim_tokens'::regclass
                    AND conname = 'scim_tokens_hash_is_sha256') THEN
    RAISE EXCEPTION '375: the sha256-shape CHECK on scim_tokens.token_hash is missing — '
                    'a plaintext token could be stored';
  END IF;
  SELECT string_agg(column_name, ', ') INTO v_bad
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'scim_tokens'
     AND column_name IN ('token', 'secret', 'plaintext', 'token_plain');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '375: scim_tokens has a column that could hold the secret: %', v_bad;
  END IF;

  -- E. Both tables are deny-all to every non-service role: RLS on, no policies.
  IF EXISTS (SELECT 1 FROM pg_tables
              WHERE schemaname = 'public'
                AND tablename IN ('scim_tokens', 'scim_user_links')
                AND NOT rowsecurity) THEN
    RAISE EXCEPTION '375: RLS is not enabled on the SCIM tables';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public'
                AND tablename IN ('scim_tokens', 'scim_user_links')) THEN
    RAISE EXCEPTION '375: a policy exists on a SCIM table — these are reachable only via RPC, '
                    'and a policy here would expose token hashes to a session';
  END IF;

  -- F. The cross-tenant link trigger is armed.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.scim_user_links'::regclass
                    AND tgname = 'scim_user_links_tenant_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '375: the tenant-match trigger on scim_user_links is missing';
  END IF;

  -- G. The deprovision mechanism still works the way the DELETE justification
  --    claims. If someone ever removes the is_active gate from auth_tenant_id(),
  --    every SCIM deprovisioning silently stops revoking anything.
  IF pg_get_functiondef((SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'public' AND p.proname = 'auth_tenant_id' LIMIT 1))
     !~ 'is_active' THEN
    RAISE EXCEPTION '375: auth_tenant_id() no longer checks is_active — SCIM deprovisioning '
                    'would no longer revoke tenant access';
  END IF;

  -- ── BEHAVIOURAL ───────────────────────────────────────────────────────────
  -- Fixtures are real profiles in two different live tenants, chosen from those
  -- NOT already SCIM-linked: scim_user_links is unique on profile_id, so
  -- borrowing an already-linked profile would make this file fail on a re-apply
  -- once SCIM is actually in use. Migration 364 exists precisely because
  -- migrations here do get re-applied.
  SELECT p.tenant_id, p.id, p.user_id INTO v_a, v_pa, v_ua
    FROM public.profiles p JOIN public.tenants t ON t.id = p.tenant_id
   WHERE p.tenant_id IS NOT NULL AND t.status IN ('active','trial')
     AND NOT EXISTS (SELECT 1 FROM public.scim_user_links l WHERE l.profile_id = p.id)
   ORDER BY p.created_at LIMIT 1;
  SELECT p.tenant_id, p.id, p.user_id INTO v_b, v_pb, v_ub
    FROM public.profiles p JOIN public.tenants t ON t.id = p.tenant_id
   WHERE p.tenant_id IS NOT NULL AND p.tenant_id <> v_a AND t.status IN ('active','trial')
     AND NOT EXISTS (SELECT 1 FROM public.scim_user_links l WHERE l.profile_id = p.id)
   ORDER BY p.created_at LIMIT 1;

  -- On first application both tables are empty, so this always runs and IS the
  -- gate. It can only be skipped on a later re-apply of an already-live system,
  -- and the skip is loud rather than silent — a quiet skip would let a broken
  -- re-apply look identical to a passing one.
  IF v_a IS NULL OR v_b IS NULL THEN
    RAISE WARNING '375: SKIPPED the behavioural isolation tests — could not find un-linked '
                  'profiles in two distinct active tenants (found % / %). The structural '
                  'checks above still ran. Re-run them against a database with two such '
                  'tenants before trusting this deployment.',
                  coalesce(v_a::text,'<none>'), coalesce(v_b::text,'<none>');
  ELSE
  BEGIN  -- sub-transaction: every write below is discarded before this block ends
    INSERT INTO public.scim_tokens (tenant_id, token_hash, token_prefix, name)
    VALUES (v_a, encode(extensions.digest(v_tok_a,'sha256'),'hex'), 'dtscim_aaaaaa', 'assert-a'),
           (v_b, encode(extensions.digest(v_tok_b,'sha256'),'hex'), 'dtscim_bbbbbb', 'assert-b');
    INSERT INTO public.scim_tokens (tenant_id, token_hash, token_prefix, name, revoked_at)
    VALUES (v_a, encode(extensions.digest(v_tok_rev,'sha256'),'hex'), 'dtscim_cccccc', 'assert-revoked', now());

    -- 1. plaintext is not what got stored
    IF EXISTS (SELECT 1 FROM public.scim_tokens WHERE token_hash = v_tok_a) THEN
      v_fail := v_fail || ' [1] the plaintext token was stored in token_hash;';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.scim_tokens
                    WHERE token_hash = encode(extensions.digest(v_tok_a,'sha256'),'hex')) THEN
      v_fail := v_fail || ' [1] the sha256 of the token was not stored;';
    END IF;

    -- 2. a live token resolves to its own tenant, and only that tenant
    IF (public.scim_token_context(v_tok_a)->>'tenant_id')::uuid IS DISTINCT FROM v_a THEN
      v_fail := v_fail || ' [2] token A did not resolve to tenant A;';
    END IF;
    IF (public.scim_token_context(v_tok_b)->>'tenant_id')::uuid IS DISTINCT FROM v_b THEN
      v_fail := v_fail || ' [2] token B did not resolve to tenant B;';
    END IF;

    -- 3. revoked and unknown tokens resolve to nothing
    IF public.scim_token_context(v_tok_rev) IS NOT NULL THEN
      v_fail := v_fail || ' [3] a REVOKED token still resolves;';
    END IF;
    IF public.scim_token_context('dtscim_' || repeat('d', 64)) IS NOT NULL THEN
      v_fail := v_fail || ' [3] an unknown token resolves;';
    END IF;
    IF public.scim_token_context(NULL) IS NOT NULL
       OR public.scim_token_context('') IS NOT NULL THEN
      v_fail := v_fail || ' [3] a null/empty token resolves;';
    END IF;

    -- 4. a link can never point across tenants, even from a direct insert
    v_raised := false;
    BEGIN
      INSERT INTO public.scim_user_links (tenant_id, profile_id, user_id, user_name)
      VALUES (v_a, v_pb, v_ub, 'crosstenant@example.invalid');   -- A's tenant, B's profile
    EXCEPTION WHEN OTHERS THEN v_raised := true;
    END;
    IF NOT v_raised THEN
      v_fail := v_fail || ' [4] a link row pointing at another tenant''s profile was accepted;';
    END IF;

    INSERT INTO public.scim_user_links (tenant_id, profile_id, user_id, user_name)
    VALUES (v_a, v_pa, v_ua, 'assert-a@example.invalid') RETURNING id INTO v_link_a;
    INSERT INTO public.scim_user_links (tenant_id, profile_id, user_id, user_name)
    VALUES (v_b, v_pb, v_ub, 'assert-b@example.invalid') RETURNING id INTO v_link_b;

    -- 5. READ across tenants, with B's id supplied explicitly
    r := public.scim_user_get(v_tok_a, v_link_b);
    IF coalesce(r->>'error', '') <> 'not_found' THEN
      v_fail := v_fail || ' [5] token A READ tenant B''s user by id: ' || r::text || ';';
    END IF;
    r := public.scim_user_get(v_tok_a, v_link_a);
    IF coalesce((r->>'ok')::boolean, false) IS NOT TRUE THEN
      v_fail := v_fail || ' [5] token A could not read its own user;';
    END IF;

    -- 6. LIST leaks nothing
    r := public.scim_users_list(v_tok_a, NULL, NULL, 1, 100);
    IF (r->>'totalResults')::int <> 1
       OR r->'resources'->0->>'id' <> v_link_a::text THEN
      v_fail := v_fail || ' [6] list under token A did not return exactly A''s own user: ' || r::text || ';';
    END IF;
    -- filter by B's userName from A's token
    r := public.scim_users_list(v_tok_a, 'assert-b@example.invalid', NULL, 1, 100);
    IF (r->>'totalResults')::int <> 0 THEN
      v_fail := v_fail || ' [6] filtering by another tenant''s userName returned rows;';
    END IF;

    -- 7. WRITE across tenants — the destructive one. This is a real attempt to
    --    deactivate a live profile in tenant B using tenant A's token.
    SELECT coalesce(is_active, true) INTO v_b_active FROM public.profiles WHERE id = v_pb;
    r := public.scim_user_patch(v_tok_a, v_link_b, '{"active": false}'::jsonb);
    IF coalesce(r->>'error', '') <> 'not_found' THEN
      v_fail := v_fail || ' [7] token A PATCHed tenant B''s user: ' || r::text || ';';
    END IF;
    IF (SELECT coalesce(is_active, true) FROM public.profiles WHERE id = v_pb) <> v_b_active THEN
      v_fail := v_fail || ' [7] tenant B''s profile was deactivated by tenant A''s token;';
    END IF;

    -- 8. DELETE across tenants
    r := public.scim_user_delete(v_tok_a, v_link_b);
    IF coalesce(r->>'error', '') <> 'not_found' THEN
      v_fail := v_fail || ' [8] token A DELETEd tenant B''s user: ' || r::text || ';';
    END IF;
    IF (SELECT deleted_at FROM public.scim_user_links WHERE id = v_link_b) IS NOT NULL THEN
      v_fail := v_fail || ' [8] tenant B''s link was soft-deleted by tenant A''s token;';
    END IF;

    -- 9. a revoked token can do nothing at all
    r := public.scim_users_list(v_tok_rev, NULL, NULL, 1, 100);
    IF coalesce(r->>'error', '') <> 'unauthorized' THEN
      v_fail := v_fail || ' [9] a revoked token listed users;';
    END IF;
    r := public.scim_user_delete(v_tok_rev, v_link_a);
    IF coalesce(r->>'error', '') <> 'unauthorized' THEN
      v_fail := v_fail || ' [9] a revoked token deleted a user;';
    END IF;

    -- 10. a token issued for a SUSPENDED tenant is inert. Checked because the
    --     status filter lives inside scim_token_context rather than at each
    --     call site, so if it were dropped nothing else would notice.
    SELECT id INTO v_susp FROM public.tenants WHERE status = 'suspended' LIMIT 1;
    IF v_susp IS NOT NULL THEN
      INSERT INTO public.scim_tokens (tenant_id, token_hash, token_prefix, name)
      VALUES (v_susp, encode(extensions.digest(v_tok_susp,'sha256'),'hex'),
              'dtscim_eeeeee', 'assert-suspended');
      IF public.scim_token_context(v_tok_susp) IS NOT NULL THEN
        v_fail := v_fail || ' [10] a suspended tenant''s token still resolves;';
      END IF;
    END IF;

    -- 11. the lockout guard. Measured today: every tenant profile in this
    --     database holds tenant_owner or tenant_admin, and no active/trial
    --     tenant has two of them — so an IdP deprovisioning the wrong person
    --     would empty a workspace of administrators. The role is set here
    --     explicitly rather than assumed, so this proves the guard rather than
    --     the current shape of the data.
    SELECT count(*) INTO v_other_admins FROM public.profiles
     WHERE tenant_id = v_a AND id <> v_pa
       AND role IN ('tenant_owner','tenant_admin') AND coalesce(is_active, true);
    IF v_other_admins = 0 THEN
      UPDATE public.profiles SET role = 'tenant_owner' WHERE id = v_pa;
      r := public.scim_user_delete(v_tok_a, v_link_a);
      IF coalesce(r->>'error', '') <> 'last_admin' THEN
        v_fail := v_fail || ' [11] SCIM removed the workspace''s only administrator: ' || r::text || ';';
      END IF;
      IF (SELECT coalesce(is_active, true) FROM public.profiles WHERE id = v_pa) IS NOT TRUE THEN
        v_fail := v_fail || ' [11] the last administrator was deactivated anyway;';
      END IF;
    END IF;

    -- 12. the real deprovision, on a non-administrator. Flips exactly the bit
    --     auth_tenant_id() reads, and the resource disappears from the API.
    UPDATE public.profiles SET role = 'agent' WHERE id = v_pa;
    r := public.scim_user_delete(v_tok_a, v_link_a);
    IF coalesce((r->>'ok')::boolean, false) IS NOT TRUE THEN
      v_fail := v_fail || ' [12] a legitimate deprovision failed: ' || r::text || ';';
    ELSIF (SELECT is_active FROM public.profiles WHERE id = v_pa) IS NOT FALSE THEN
      v_fail := v_fail || ' [12] deprovisioning did not set profiles.is_active = false;';
    ELSIF public.scim_user_get(v_tok_a, v_link_a)->>'error' <> 'not_found' THEN
      v_fail := v_fail || ' [12] a deprovisioned user is still returned by GET (RFC 7644 3.6);';
    ELSIF (SELECT deleted_at FROM public.scim_user_links WHERE id = v_link_a) IS NULL THEN
      v_fail := v_fail || ' [12] the link was not soft-deleted;';
    END IF;

    -- Unconditional rollback of everything above, including the live profile
    -- row [10] just deactivated. Nothing in this block survives.
    RAISE EXCEPTION 'SCIM_FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SCIM_FIXTURE_ROLLBACK' THEN RAISE; END IF;
  END;
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION '375 ISOLATION FAILURE:%', v_fail;
  END IF;

  -- The wording distinguishes the two cases on purpose. A single cheerful
  -- notice printed whether or not the behavioural tests ran would be the exact
  -- kind of claim this codebase's honesty rule exists to prevent.
  IF v_a IS NULL OR v_b IS NULL THEN
    RAISE NOTICE '375: STRUCTURAL checks passed (grants, constraints, signatures, trigger, '
                 'deprovision mechanism). The behavioural cross-tenant tests did NOT run — '
                 'see the WARNING above.';
  ELSE
    RAISE NOTICE '375: SCIM tokens are hash-only, revoked tokens are inert, and tenant A cannot '
                 'read, list, patch or delete a user in tenant B by any id it supplies '
                 '(structural + behavioural checks both passed).';
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
