-- 374_sso_policy_jit.sql
-- ============================================================================
-- SSO ENFORCEMENT POLICY + JUST-IN-TIME MEMBERSHIP PROVISIONING
--
-- WHAT THIS IS FOR: an enterprise buyer's IT team asks two questions before
-- they will sign. "Can you force our people to sign in through our IdP?" and
-- "when someone joins, do they get a workspace automatically or does someone
-- email you?" This migration is the answer to both, minus the SAML handshake
-- itself. Supabase reports saml_enabled = false because the org is on the FREE
-- plan; when that flips, the only thing left to do is send the assertion's
-- attributes into resolve_jit_membership(). Nothing here assumes SAML is live.
--
-- ── THE THING THAT MAKES THIS DANGEROUS ────────────────────────────────────
-- JIT provisioning is a tenant-takeover primitive wearing a convenience hat.
-- "user@acme.com joins the tenant that owns acme.com" is only safe if owning a
-- domain is *proven*. This file therefore reads exactly one thing from
-- tenant_domains (migration 373): rows with status = 'verified'. A pending or
-- failed claim grants nothing, and if two tenants somehow both hold the same
-- verified domain, the answer is NOBODY gets the user — see 'ambiguous_domain'.
--
-- ── WHY handle_new_user IS NOT TOUCHED ─────────────────────────────────────
-- handle_new_user() is the live AFTER INSERT trigger on auth.users
-- (trigger: on_auth_user_created). This repository has already shipped a change
-- that broke signup completely — migration 056 broke it, migration 115 fixed
-- it, and roughly sixty migrations passed in between with nobody noticing,
-- because a broken signup trigger fails silently for everyone except the person
-- trying to sign up. Putting domain lookups inside that trigger would make
-- every future tenant_domains change a signup-outage risk.
--
-- So JIT is a SEPARATE, EXPLICITLY-CALLED function. Signup keeps doing exactly
-- what it does today: create a profile with role='agent', layer='tenant',
-- tenant_id=NULL. If resolve_jit_membership() throws, or is never called, the
-- user simply has no tenant — which is today's behaviour for every signup.
-- Signup is strictly no-worse than before this file. Assertion 1 below proves
-- the trigger function is byte-for-byte unchanged (md5 of pg_get_functiondef).
--
-- ── MEASURED FACTS THIS FILE IS BUILT ON (production, read-only, 2026-07-26) ─
--   · profiles by (layer, role, tenant_id IS NULL):
--       platform / platform_super_admin / no tenant   ->  2   ⚠ SEE BELOW
--       tenant   / tenant_owner         / has tenant  ->  5
--       tenant   / tenant_owner         / NO tenant   ->  1   ⚠ SEE BELOW
--       tenant   / tenant_admin         / has tenant  -> 11
--     BOTH platform admins have tenant_id IS NULL. A naive JIT rule of
--     "tenant_id is null => eligible" would have demoted platform staff into a
--     customer's workspace the first time outsourcetel.com got verified,
--     destroying platform access and handing a customer two admin accounts.
--     There is also one orphaned tenant_owner with no tenant. Hence the rule
--     below: JIT only ever touches a profile still in its untouched signup
--     state (layer='tenant' AND role='agent' AND tenant_id IS NULL).
--
--   · RLS policies in public: 332 total. 232 gate on auth_tenant_id() alone
--     (membership), 34 additionally require auth_has_tenant_role(...). That
--     ratio is why 'tenant_user' is used as the JIT default rather than
--     'tenant_admin' — see the jit_default_role comment.
--
--   · tenants.status CHECK allows exactly ('active','suspended','trial').
--     Live rows include all three, so JIT admits active+trial and refuses
--     suspended rather than hard-coding 'active'.
--
--   · profiles carries trigger trg_guard_demo_tenant, which RAISES on any
--     attempt to set tenant_id = a0000000-0000-0000-0000-000000000001. JIT
--     refuses that tenant up front with reason 'demo_tenant' so the refusal is
--     a recorded decision rather than an escaped trigger exception.
--
--   · profiles carries trg_tenant_activity_log, but log_tenant_activity()
--     returns early when the actor has no tenant_id (it reads the ACTOR's
--     tenant, and a JIT candidate has none). So the JIT grant would be
--     invisible in tenant_activity_log. This file writes its own audit_logs
--     row for every outcome, grant AND refusal — the same lesson as GI-10,
--     where declines were invisible because only approvals were recorded.
-- ============================================================================


-- ── 0. HARD DEPENDENCY ON MIGRATION 373 ─────────────────────────────────────
-- Fail loudly, not silently. If tenant_domains is absent this file's entire
-- security model (verified-domain routing) has nothing to stand on, and a
-- half-applied SSO stack is worse than none: the policy tables would exist and
-- look configured while resolving nothing.
DO $dep$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('public.tenant_domains') IS NULL THEN
    RAISE EXCEPTION
      '374 requires migration 373 (tenant_domains). Apply 373 first — this file routes users by verified domain and has no fallback.';
  END IF;

  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['tenant_id','domain','status']) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenant_domains'
        AND column_name = c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '374: tenant_domains exists but is missing column(s): % — 373 shape changed', v_missing;
  END IF;

  -- 373 owns the uniqueness guarantee; 374 depends on it, so 374 checks it is
  -- really there rather than assuming. Both a plain column index and an
  -- expression index (e.g. on lower(domain)) are accepted, because 373 is
  -- being written in parallel and either form is legitimate.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.tenant_domains'::regclass
       AND i.indisunique
       AND ( EXISTS (SELECT 1
                       FROM unnest(i.indkey::smallint[]) AS k
                       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k
                      WHERE a.attname = 'domain')
             OR coalesce(pg_get_expr(i.indexprs, i.indrelid), '') ILIKE '%domain%' )
  ) THEN
    RAISE EXCEPTION
      '374: tenant_domains has no UNIQUE index covering domain. Without it two tenants can hold the same domain and JIT becomes a takeover primitive. Fix 373 first.';
  END IF;

  -- The invariant itself, checked against real data rather than against schema.
  IF EXISTS (
    SELECT 1 FROM public.tenant_domains
     WHERE status = 'verified'
     GROUP BY lower(domain)
    HAVING count(DISTINCT tenant_id) > 1
  ) THEN
    RAISE EXCEPTION '374: a domain is already VERIFIED for more than one tenant. Refusing to build JIT on top of that.';
  END IF;

  RAISE NOTICE '374: dependency on 373 (tenant_domains) satisfied';
END $dep$;


-- ── 1. PER-TENANT SSO POLICY ────────────────────────────────────────────────
-- One row per tenant, created only when an admin configures SSO. NO ROW means
-- "not configured", which means JIT is off — absence must never read as
-- permission. Note what is deliberately NOT stored here: allowed_domains. The
-- allowed set is DERIVED from tenant_domains WHERE status='verified' every time
-- it is needed (see the view below). A cached copy of "which domains we own" is
-- a second source of truth for the exact fact that authorises account creation,
-- and it would go stale the moment a domain is revoked.
CREATE TABLE IF NOT EXISTS public.tenant_sso_policy (
  tenant_id        uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- "Members of this workspace must sign in via SSO." Enforced in two places
  -- that work TODAY even with saml_enabled=false: JIT refuses to provision a
  -- non-SSO account into this tenant, and sso_login_compliance() lets the app
  -- eject a session that arrived by password. It is not enforceable inside
  -- Postgres for an already-provisioned user — GoTrue owns password login, not
  -- this database. That limit is real and is stated in the column comment.
  sso_required     boolean NOT NULL DEFAULT false,

  -- Default DENY. Verifying a domain proves ownership; it does not by itself
  -- mean "auto-admit everyone with that domain". Those are two separate
  -- decisions and a customer's IT team expects to make them separately.
  jit_enabled      boolean NOT NULL DEFAULT false,

  -- Only two values are permitted, and the CHECK is the enforcement, not the
  -- application. 'tenant_owner' and every platform_* role are structurally
  -- unreachable through JIT because they cannot be stored in this column.
  --
  -- Why 'tenant_user' is the default and not 'tenant_admin':
  -- measured above, 232 of 332 RLS policies gate on tenant membership alone
  -- (auth_tenant_id()) and 34 additionally require
  -- auth_has_tenant_role(['tenant_owner','tenant_admin']). A tenant_user
  -- profile therefore passes the 232 membership policies and is refused by the
  -- 34 privileged ones. That is a real, enforced least-privilege level — it is
  -- enforced by the ABSENCE of the role those 34 policies check for, which is
  -- exactly how least privilege is supposed to work here. It is already in
  -- profiles_role_check, so no constraint is being widened.
  -- The alternative was making tenant_admin the only JIT outcome, which would
  -- hand workspace administration to every person who happens to hold an email
  -- address at a verified domain. That is not a defensible default.
  jit_default_role text NOT NULL DEFAULT 'tenant_user'
                   CHECK (jit_default_role IN ('tenant_user','tenant_admin')),

  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tenant_sso_policy IS
  'Per-tenant SSO/JIT policy. No row = not configured = JIT off. allowed_domains is deliberately NOT stored here; it is derived from tenant_domains WHERE status=''verified'' so a revoked domain stops admitting users immediately.';
COMMENT ON COLUMN public.tenant_sso_policy.sso_required IS
  'Workspace requires IdP sign-in. Enforced by JIT (refuses non-SSO provisioning) and by sso_login_compliance() which the app calls post-login. NOT enforceable inside Postgres for an existing user: GoTrue owns password login. Full enforcement needs Supabase Pro (saml_enabled is false today) plus the app acting on the compliance result.';
COMMENT ON COLUMN public.tenant_sso_policy.jit_default_role IS
  'Role granted to a JIT-provisioned member. CHECK-constrained to tenant_user|tenant_admin so neither tenant_owner nor any platform_* role is reachable by automatic provisioning. Owner is a deliberate human act.';

DROP TRIGGER IF EXISTS tenant_sso_policy_updated_at ON public.tenant_sso_policy;
CREATE TRIGGER tenant_sso_policy_updated_at
  BEFORE UPDATE ON public.tenant_sso_policy
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


-- ── 2. ATTRIBUTE -> ROLE MAPPING ────────────────────────────────────────────
-- "Everyone in the Okta group DreamTeam-Admins should be an admin here."
-- The role column carries the SAME CHECK as jit_default_role: a customer's IdP
-- administrator cannot decide who is platform staff, and cannot mint owners.
-- That is enforced by the constraint, so it holds even if every line of the
-- resolution function below were rewritten wrongly tomorrow.
CREATE TABLE IF NOT EXISTS public.sso_attribute_role_map (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- e.g. attribute_name='groups', attribute_value='DreamTeam-Admins'.
  -- Matching is case-insensitive: IdPs are inconsistent about casing and a
  -- mapping that silently fails to match is a support ticket, not a security
  -- win (the security win is the CHECK on role, above).
  attribute_name  text NOT NULL CHECK (length(btrim(attribute_name))  BETWEEN 1 AND 128),
  attribute_value text NOT NULL CHECK (length(btrim(attribute_value)) BETWEEN 1 AND 256),

  role            text NOT NULL CHECK (role IN ('tenant_user','tenant_admin')),

  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Lookup index and duplicate guard in one. Case-folded to match the resolver.
CREATE UNIQUE INDEX IF NOT EXISTS sso_attribute_role_map_unique
  ON public.sso_attribute_role_map (tenant_id, lower(btrim(attribute_name)), lower(btrim(attribute_value)));

COMMENT ON TABLE public.sso_attribute_role_map IS
  'Maps IdP attribute/group values to a DreamTeam role for JIT provisioning. role is CHECK-constrained to tenant_user|tenant_admin: a customer IdP can never assert platform staff or workspace ownership. Attributes are only honoured when supplied by the service role (a real IdP assertion), never when supplied by a browser.';

DROP TRIGGER IF EXISTS sso_attribute_role_map_updated_at ON public.sso_attribute_role_map;
CREATE TRIGGER sso_attribute_role_map_updated_at
  BEFORE UPDATE ON public.sso_attribute_role_map
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


-- ── 3. RLS + TABLE GRANTS ───────────────────────────────────────────────────
-- Supabase's default privileges grant ALL on every new public table to anon
-- AND authenticated — verified on public.schema_migrations, which shows anon
-- holding INSERT/SELECT/UPDATE/DELETE/TRUNCATE. RLS covers the DML, but
-- TRUNCATE is NOT filtered by RLS, so the grant is removed rather than trusted.
ALTER TABLE public.tenant_sso_policy      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sso_attribute_role_map ENABLE ROW LEVEL SECURITY;

-- Revoking from "authenticated" is NOT optional: pg_default_acl for this owner grants
-- {anon,authenticated}=arwdDxtm on every new table, and the D is TRUNCATE, which
-- RLS does not filter. The GRANT below restores exactly the four DML rights.
REVOKE ALL ON TABLE public.tenant_sso_policy      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sso_attribute_role_map FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_sso_policy      TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sso_attribute_role_map TO authenticated, service_role;

-- Read: own tenant, or platform staff. Platform staff can SEE a customer's SSO
-- posture (support needs that) but deliberately cannot WRITE it — nobody at
-- DreamTeam should be able to quietly turn a customer's SSO requirement off.
-- The one platform path that can write is an ACTIVE remote-access session,
-- because can_admin_tenant_internal -> auth_has_tenant_role already contains
-- resolve_remote_access_tenant(); that path is time-boxed and audited today.
DROP POLICY IF EXISTS tenant_sso_policy_read ON public.tenant_sso_policy;
CREATE POLICY tenant_sso_policy_read ON public.tenant_sso_policy
  FOR SELECT USING (tenant_id = public.auth_tenant_id() OR public.is_platform_admin());

DROP POLICY IF EXISTS tenant_sso_policy_write ON public.tenant_sso_policy;
CREATE POLICY tenant_sso_policy_write ON public.tenant_sso_policy
  FOR ALL USING (public.can_admin_tenant_internal(tenant_id))
          WITH CHECK (public.can_admin_tenant_internal(tenant_id));

DROP POLICY IF EXISTS sso_attribute_role_map_read ON public.sso_attribute_role_map;
CREATE POLICY sso_attribute_role_map_read ON public.sso_attribute_role_map
  FOR SELECT USING (tenant_id = public.auth_tenant_id() OR public.is_platform_admin());

DROP POLICY IF EXISTS sso_attribute_role_map_write ON public.sso_attribute_role_map;
CREATE POLICY sso_attribute_role_map_write ON public.sso_attribute_role_map
  FOR ALL USING (public.can_admin_tenant_internal(tenant_id))
          WITH CHECK (public.can_admin_tenant_internal(tenant_id));


-- ── 4. EFFECTIVE POLICY VIEW (allowed_domains, derived) ─────────────────────
-- security_invoker so the caller's RLS on BOTH tenant_sso_policy and
-- tenant_domains applies. A definer-rights view here would hand every
-- authenticated user the full domain map of every tenant — the exact
-- reconnaissance an attacker wants before attempting a domain claim.
CREATE OR REPLACE VIEW public.tenant_sso_effective_policy
WITH (security_invoker = true) AS
SELECT
  p.tenant_id,
  p.sso_required,
  p.jit_enabled,
  p.jit_default_role,
  COALESCE(
    (SELECT array_agg(DISTINCT lower(d.domain) ORDER BY lower(d.domain))
       FROM public.tenant_domains d
      WHERE d.tenant_id = p.tenant_id AND d.status = 'verified'),
    ARRAY[]::text[]
  ) AS allowed_domains,
  p.updated_at
FROM public.tenant_sso_policy p;

-- Consequence worth stating rather than discovering: 373's only read policy on
-- tenant_domains is can_admin_tenant_internal(tenant_id), because the row
-- carries the verification token. With security_invoker=true that flows
-- through, so a plain member reading this view sees their policy with an EMPTY
-- allowed_domains, while an admin sees the real list. That is the right
-- exposure — the domain list is admin information — but the UI must not read
-- an empty array as "no domains verified".
COMMENT ON VIEW public.tenant_sso_effective_policy IS
  'Tenant SSO policy with allowed_domains derived live from verified tenant_domains. security_invoker=true so RLS on both underlying tables applies: non-admin members see an empty allowed_domains because 373 restricts tenant_domains reads to tenant admins.';

REVOKE ALL ON public.tenant_sso_effective_policy FROM PUBLIC, anon;
GRANT SELECT ON public.tenant_sso_effective_policy TO authenticated, service_role;


-- ── 5. THE DECISION, ISOLATED AND TESTABLE ──────────────────────────────────
-- Everything that decides whether a user is admitted lives here, takes its
-- inputs as arguments, reads no session state and writes nothing. That split
-- exists for one reason: it is the only way to ASSERT the refusal rules in this
-- migration without fabricating rows in auth.users. Forging an auth identity to
-- test an authorization gate proves nothing about the real gate, so the gate is
-- tested directly instead (see the assertions at the end).
--
-- p_trust_attributes is the hinge of the whole attribute-mapping design. The
-- caller declares whether the attributes came from a verified IdP assertion
-- (service role) or from a browser (never trusted). A self-service caller can
-- send {"groups":["Admins"]} all day and it is ignored.
CREATE OR REPLACE FUNCTION public.jit_decide_internal(
  p_email            text,
  p_email_confirmed  boolean,
  p_is_sso_user      boolean,
  p_profile_exists   boolean,
  p_profile_layer    text,
  p_profile_role     text,
  p_profile_tenant   uuid,
  p_attributes       jsonb,
  p_trust_attributes boolean
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_domain  text;
  v_tenants uuid[];
  v_tenant  uuid;
  v_status  text;
  v_policy  public.tenant_sso_policy;
  v_role    text;
  v_mapped  text;
  -- Reserved by trg_guard_demo_tenant on public.profiles, which RAISES on any
  -- attempt to assign it. Refused here so the outcome is a recorded decision.
  c_demo_tenant CONSTANT uuid := 'a0000000-0000-0000-0000-000000000001';
BEGIN
  -- Deny-first. Every branch returns granted=false with a reason; there is
  -- exactly one path to granted=true and it is at the bottom.

  IF p_email IS NULL OR position('@' IN p_email) = 0 THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'no_email');
  END IF;

  v_domain := lower(btrim(split_part(p_email, '@', 2)));
  IF v_domain IS NULL OR v_domain = '' THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'no_email');
  END IF;

  -- An unverified email address is an unverified CLAIM to a domain. Anyone can
  -- type someone@acme.com into a signup form; only someone who can read that
  -- mailbox can confirm it. Without this line the whole verified-domain model
  -- collapses to "type the right address".
  IF NOT COALESCE(p_email_confirmed, false) THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'email_unverified', 'domain', v_domain);
  END IF;

  IF NOT COALESCE(p_profile_exists, false) THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'no_profile', 'domain', v_domain);
  END IF;

  -- Both live platform_super_admin profiles have tenant_id IS NULL (measured).
  -- Without this branch, verifying outsourcetel.com would sweep platform staff
  -- into a customer tenant at tenant_user and lock them out of the platform.
  IF p_profile_layer = 'platform' THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'platform_account', 'domain', v_domain);
  END IF;

  IF p_profile_tenant IS NOT NULL THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'already_member',
                              'domain', v_domain, 'tenant_id', p_profile_tenant);
  END IF;

  -- 'agent' is what handle_new_user() writes and nothing else in production
  -- uses it (0 active profiles hold it). So role='agent' is a reliable marker
  -- for "untouched by any human decision". Anything else — including the one
  -- live tenant_owner who has no tenant_id — is a profile someone deliberately
  -- shaped, and JIT does not get to reshape it.
  IF COALESCE(p_profile_role, '') <> 'agent' THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'profile_not_fresh', 'domain', v_domain);
  END IF;

  SELECT array_agg(DISTINCT d.tenant_id) INTO v_tenants
    FROM public.tenant_domains d
   WHERE lower(btrim(d.domain)) = v_domain
     AND d.status = 'verified';

  IF v_tenants IS NULL OR array_length(v_tenants, 1) IS NULL THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'no_verified_domain', 'domain', v_domain);
  END IF;

  -- 373 should make this impossible. If it ever happens anyway, the safe answer
  -- is not "pick one" — picking one is the takeover. Nobody gets the user.
  IF array_length(v_tenants, 1) > 1 THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'ambiguous_domain', 'domain', v_domain);
  END IF;

  v_tenant := v_tenants[1];

  IF v_tenant = c_demo_tenant THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'demo_tenant', 'domain', v_domain);
  END IF;

  SELECT t.status INTO v_status FROM public.tenants t WHERE t.id = v_tenant;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'tenant_missing', 'domain', v_domain);
  END IF;
  -- tenants_status_check allows exactly active|suspended|trial. A trial
  -- workspace must be able to onboard people; a suspended one must not.
  IF v_status NOT IN ('active', 'trial') THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'tenant_not_active',
                              'domain', v_domain, 'tenant_id', v_tenant);
  END IF;

  SELECT * INTO v_policy FROM public.tenant_sso_policy WHERE tenant_id = v_tenant;
  IF v_policy.tenant_id IS NULL OR NOT v_policy.jit_enabled THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'jit_disabled',
                              'domain', v_domain, 'tenant_id', v_tenant);
  END IF;

  -- Makes sso_required mean something TODAY, with saml_enabled still false: a
  -- password signup at an SSO-required workspace is provisioned into nothing.
  IF v_policy.sso_required AND NOT COALESCE(p_is_sso_user, false) THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'sso_required',
                              'domain', v_domain, 'tenant_id', v_tenant);
  END IF;

  v_role := v_policy.jit_default_role;

  IF COALESCE(p_trust_attributes, false)
     AND p_attributes IS NOT NULL
     AND jsonb_typeof(p_attributes) = 'object'
  THEN
    -- Flatten {"groups":["A","B"],"dept":"Ops"} to (name,value) pairs so a
    -- multi-valued IdP claim behaves the way an admin expects.
    WITH pairs AS (
      SELECT lower(btrim(kv.key)) AS attr_name,
             lower(btrim(el #>> '{}')) AS attr_value
        FROM jsonb_each(p_attributes) kv
        CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(kv.value) = 'array'
                    THEN kv.value ELSE jsonb_build_array(kv.value) END) el
       WHERE el #>> '{}' IS NOT NULL
    )
    SELECT m.role INTO v_mapped
      FROM public.sso_attribute_role_map m
      JOIN pairs pr
        ON lower(btrim(m.attribute_name))  = pr.attr_name
       AND lower(btrim(m.attribute_value)) = pr.attr_value
     WHERE m.tenant_id = v_tenant
     -- Most privileged match wins, so an admin group is not lost to
     -- alphabetical accident when a user matches several mappings.
     ORDER BY CASE m.role WHEN 'tenant_admin' THEN 1 ELSE 2 END
     LIMIT 1;

    IF v_mapped IS NOT NULL THEN
      v_role := v_mapped;
    END IF;
  END IF;

  -- Belt and braces. The CHECK constraints already make anything else
  -- unstorable; this makes it unreturnable even if a constraint were dropped.
  IF v_role NOT IN ('tenant_user', 'tenant_admin') THEN
    v_role := 'tenant_user';
  END IF;

  RETURN jsonb_build_object(
    'granted', true, 'reason', 'ok',
    'domain', v_domain, 'tenant_id', v_tenant, 'role', v_role,
    'attributes_trusted', COALESCE(p_trust_attributes, false));
END $function$;

-- Internal only. It reveals which tenant owns which domain, so no client role
-- gets it — not even authenticated. resolve_jit_membership() calls it from
-- inside a SECURITY DEFINER body, where the effective user is the owner.
REVOKE ALL ON ROUTINE public.jit_decide_internal(text, boolean, boolean, boolean, text, text, uuid, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.jit_decide_internal(text, boolean, boolean, boolean, text, text, uuid, jsonb, boolean) IS
  'Pure JIT decision: inputs in, {granted,reason,tenant_id,role} out. Writes nothing, reads no session state. Split out from resolve_jit_membership so the refusal rules can be asserted without fabricating auth.users rows. Not granted to any client role.';


-- ── 6. THE EXPLICIT ENTRY POINT ─────────────────────────────────────────────
-- Called by the app AFTER signup / first login. Never by a trigger.
CREATE OR REPLACE FUNCTION public.resolve_jit_membership(
  p_user_id    uuid  DEFAULT NULL,
  p_attributes jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_is_service   boolean;
  v_caller       uuid;
  v_target       uuid;
  v_trust        boolean;
  v_email        text;
  v_confirmed    timestamptz;
  v_is_sso       boolean;
  v_deleted      timestamptz;
  v_banned       timestamptz;
  v_found        boolean := false;
  v_p_exists     boolean := false;
  v_p_id         uuid;
  v_p_layer      text;
  v_p_role       text;
  v_p_tenant     uuid;
  v_decision     jsonb;
  v_rows         integer;
BEGIN
  -- The service role is named explicitly. It is NOT inferred from a null
  -- auth.uid(), because anon also has a null uid — that inference is the exact
  -- bug migrations 330 and 369 had to go back and fix.
  v_is_service := COALESCE(auth.role(), '') = 'service_role';
  v_caller     := auth.uid();
  v_target     := COALESCE(p_user_id, v_caller);

  IF NOT v_is_service THEN
    -- A logged-in user may resolve ONLY themselves. Resolving someone else
    -- would let any account force-provision another account, and would turn
    -- this function into an oracle for "which domains are verified".
    IF v_caller IS NULL OR v_target IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;

  IF v_target IS NULL THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- Attributes are only believed when they arrive from the backend, which got
  -- them from a signed IdP assertion. From a browser they are user-controlled
  -- text; honouring them would let anyone self-assert into tenant_admin.
  v_trust := v_is_service;

  SELECT u.email, u.email_confirmed_at, COALESCE(u.is_sso_user, false),
         u.deleted_at, u.banned_until, true
    INTO v_email, v_confirmed, v_is_sso, v_deleted, v_banned, v_found
    FROM auth.users u
   WHERE u.id = v_target;

  IF NOT COALESCE(v_found, false) THEN
    v_decision := jsonb_build_object('granted', false, 'reason', 'user_not_found');
  ELSIF v_deleted IS NOT NULL OR (v_banned IS NOT NULL AND v_banned > now()) THEN
    v_decision := jsonb_build_object('granted', false, 'reason', 'user_disabled');
  ELSE
    SELECT pr.id, true, pr.layer, pr.role, pr.tenant_id
      INTO v_p_id, v_p_exists, v_p_layer, v_p_role, v_p_tenant
      FROM public.profiles pr
     WHERE pr.user_id = v_target;

    v_decision := public.jit_decide_internal(
      v_email, v_confirmed IS NOT NULL, v_is_sso,
      COALESCE(v_p_exists, false), v_p_layer, v_p_role, v_p_tenant,
      p_attributes, v_trust);
  END IF;

  IF (v_decision->>'granted')::boolean THEN
    -- Every precondition is restated in the WHERE clause, so two concurrent
    -- calls cannot both win and the row cannot have changed underneath the
    -- decision. Zero rows updated means someone else got there first.
    UPDATE public.profiles
       SET tenant_id  = (v_decision->>'tenant_id')::uuid,
           role       = v_decision->>'role',
           layer      = 'tenant',
           updated_at = now()
     WHERE user_id   = v_target
       AND tenant_id IS NULL
       AND layer      = 'tenant'
       AND role       = 'agent';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      v_decision := jsonb_set(
        jsonb_set(v_decision, '{granted}', 'false'::jsonb),
        '{reason}', '"race_lost"'::jsonb);
    END IF;
  END IF;

  -- Record the refusal, not just the grant. log_tenant_activity() on profiles
  -- returns early for an actor with no tenant_id, which is every JIT candidate,
  -- so without this insert a JIT decision leaves no trace anywhere. Refusals
  -- are the interesting half: "why did our new hire not get in" and "who keeps
  -- trying" are both answered here.
  BEGIN
    INSERT INTO public.audit_logs (
      tenant_id, actor_user_id, action, entity_type, entity_id, entity_name,
      after_data, metadata)
    VALUES (
      NULLIF(v_decision->>'tenant_id', '')::uuid,
      v_target,
      CASE WHEN (v_decision->>'granted')::boolean THEN 'sso.jit_provisioned'
           ELSE 'sso.jit_refused' END,
      'profile', v_p_id, v_email,
      v_decision,
      jsonb_build_object(
        'source', CASE WHEN v_is_service THEN 'service_role' ELSE 'self_service' END,
        'attributes_trusted', v_trust,
        'attribute_keys', CASE WHEN jsonb_typeof(COALESCE(p_attributes,'{}'::jsonb)) = 'object'
                               -- keys only: attribute VALUES can carry HR data
                               -- (department, cost centre) and this table is
                               -- readable by every member of the tenant.
                               THEN (SELECT COALESCE(jsonb_agg(k), '[]'::jsonb)
                                       FROM jsonb_object_keys(p_attributes) k)
                               ELSE '[]'::jsonb END));
  EXCEPTION WHEN others THEN
    -- Audit failure must not deny a legitimate member their workspace, but it
    -- must be visible in the Postgres log rather than swallowed silently.
    RAISE WARNING 'resolve_jit_membership: audit insert failed: %', SQLERRM;
  END;

  RETURN v_decision;
END $function$;

-- CREATE OR REPLACE resets grants to the PUBLIC default, so this must stay
-- BELOW the body. anon is removed explicitly; authenticated keeps it because
-- the self-service path (a user resolving their own membership after first
-- login) is the whole point, and that path is guarded above.
REVOKE ALL ON ROUTINE public.resolve_jit_membership(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.resolve_jit_membership(uuid, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_jit_membership(uuid, jsonb) IS
  'Explicitly-called JIT membership resolution. NOT wired into handle_new_user: signup must never depend on this. Self-service callers may only resolve themselves and their p_attributes are ignored; only the service role (holding a verified IdP assertion) has attributes honoured. Every outcome, grant or refusal, is written to audit_logs.';


-- ── 7. SSO LOGIN COMPLIANCE ─────────────────────────────────────────────────
-- What an IT team means by "must sign in via SSO" for people who ALREADY have
-- accounts. Postgres cannot block GoTrue password login, so this returns the
-- verdict and the app enforces it by signing the session out. Honest about
-- where the boundary is rather than pretending the database can hold it.
CREATE OR REPLACE FUNCTION public.sso_login_compliance(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_is_service boolean;
  v_caller     uuid;
  v_target     uuid;
  v_tenant     uuid;
  v_required   boolean := false;
  v_is_sso     boolean := false;
BEGIN
  v_is_service := COALESCE(auth.role(), '') = 'service_role';
  v_caller     := auth.uid();
  v_target     := COALESCE(p_user_id, v_caller);

  IF NOT v_is_service THEN
    IF v_caller IS NULL OR v_target IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT pr.tenant_id INTO v_tenant FROM public.profiles pr WHERE pr.user_id = v_target;
  SELECT COALESCE(u.is_sso_user, false) INTO v_is_sso FROM auth.users u WHERE u.id = v_target;

  IF v_tenant IS NOT NULL THEN
    SELECT COALESCE(sp.sso_required, false) INTO v_required
      FROM public.tenant_sso_policy sp WHERE sp.tenant_id = v_tenant;
  END IF;
  v_required := COALESCE(v_required, false);

  RETURN jsonb_build_object(
    'tenant_id',    v_tenant,
    'sso_required', v_required,
    'is_sso_user',  COALESCE(v_is_sso, false),
    'compliant',    (NOT v_required) OR COALESCE(v_is_sso, false),
    -- Surfaced so the UI can say WHY it is ejecting a session instead of
    -- showing a bare "signed out".
    'reason',       CASE WHEN NOT v_required THEN 'sso_not_required'
                         WHEN COALESCE(v_is_sso, false) THEN 'sso_session'
                         ELSE 'password_session_on_sso_required_workspace' END);
END $function$;

REVOKE ALL ON ROUTINE public.sso_login_compliance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.sso_login_compliance(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.sso_login_compliance(uuid) IS
  'Post-login verdict for "this workspace requires SSO". Self-only unless service_role. Advisory by necessity: GoTrue owns password login, so the app must act on compliant=false by ending the session.';


-- ── 8. PROVE IT ─────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  -- md5 of pg_get_functiondef(handle_new_user) as measured on production
  -- immediately before this file was written (length 445 bytes). If this no
  -- longer matches, either someone changed the most dangerous object in the
  -- database or this migration is being applied to a database that is not the
  -- one it was written against. Both deserve a stop.
  c_handle_new_user_md5 CONSTANT text := '05f664b9b1d5d59b57c76db3942eaa44';
  v_live_md5   text;
  v_live_def   text;
  v_role       text;
  v_raised     boolean;
  v_tenant     uuid;
  v_probe_ran  boolean := false;
  v_unfillable text;
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb;
BEGIN
  -- 8.1 handle_new_user is untouched, and still wired up ---------------------
  SELECT pg_get_functiondef(p.oid), md5(pg_get_functiondef(p.oid))
    INTO v_live_def, v_live_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'handle_new_user' AND p.prokind IN ('f','p');

  IF v_live_md5 IS NULL THEN
    RAISE EXCEPTION '374: handle_new_user() does not exist. Signup is already broken — fix that before adding JIT.';
  END IF;
  IF v_live_md5 <> c_handle_new_user_md5 THEN
    RAISE EXCEPTION
      '374: handle_new_user() changed (expected md5 %, found %). 374 does not touch it, so something else did. Review that change before applying this file.',
      c_handle_new_user_md5, v_live_md5;
  END IF;
  -- Independent of formatting: the trigger body must not have learned about
  -- anything in this file. This is the check that still works if someone
  -- legitimately reformats the function and updates the md5 above.
  IF v_live_def ~* '(tenant_domains|resolve_jit_membership|tenant_sso_policy|jit_decide_internal|sso_attribute_role_map)' THEN
    RAISE EXCEPTION '374: handle_new_user() now references JIT machinery. Signup must not depend on it.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'auth.users'::regclass
       AND t.tgname  = 'on_auth_user_created'
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'D')
  THEN
    RAISE EXCEPTION '374: trigger on_auth_user_created is missing or disabled — signup would create no profile at all.';
  END IF;

  -- 8.2 A customer IdP cannot mint owners or platform staff ------------------
  -- Tested by actually attempting the insert. Every privileged role name from
  -- the live profiles_role_check is tried, so this keeps working if that
  -- constraint grows a new privileged role later.
  SELECT id INTO v_tenant FROM public.tenants
   WHERE status IN ('active','trial') AND id <> 'a0000000-0000-0000-0000-000000000001'::uuid
   ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION '374: no non-demo active/trial tenant available to test constraints against.';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'tenant_owner','platform_super_admin','platform_support','platform_billing',
    'dt_super_admin','dt_god_access','agent'
  ] LOOP
    v_raised := false;
    BEGIN
      INSERT INTO public.sso_attribute_role_map (tenant_id, attribute_name, attribute_value, role)
      VALUES (v_tenant, 'probe-374', 'probe-374', v_role);
    EXCEPTION WHEN check_violation THEN
      v_raised := true;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION '374: sso_attribute_role_map accepted role % — an IdP could assert it.', v_role;
    END IF;

    v_raised := false;
    BEGIN
      INSERT INTO public.tenant_sso_policy (tenant_id, jit_default_role)
      VALUES (v_tenant, v_role);
    EXCEPTION WHEN check_violation THEN
      v_raised := true;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION '374: tenant_sso_policy accepted jit_default_role % — JIT could grant it.', v_role;
    END IF;
  END LOOP;

  -- 8.3 The refusal rules, exercised for real -------------------------------
  -- No verified domain anywhere yet, so these all resolve against real tables.
  IF (public.jit_decide_internal('someone@nobody-owns-this-374.invalid', true, false,
        true, 'tenant', 'agent', NULL, '{}'::jsonb, false)->>'reason') <> 'no_verified_domain' THEN
    RAISE EXCEPTION '374: an unverified domain did not produce no_verified_domain';
  END IF;

  IF (public.jit_decide_internal('someone@nobody-owns-this-374.invalid', false, false,
        true, 'tenant', 'agent', NULL, '{}'::jsonb, false)->>'reason') <> 'email_unverified' THEN
    RAISE EXCEPTION '374: an unconfirmed email was not refused';
  END IF;

  IF (public.jit_decide_internal('someone@nobody-owns-this-374.invalid', true, false,
        true, 'platform', 'platform_super_admin', NULL, '{}'::jsonb, false)->>'reason') <> 'platform_account' THEN
    RAISE EXCEPTION '374: a platform account was not refused — JIT could demote platform staff into a tenant';
  END IF;

  IF (public.jit_decide_internal('someone@nobody-owns-this-374.invalid', true, false,
        true, 'tenant', 'tenant_owner', NULL, '{}'::jsonb, false)->>'reason') <> 'profile_not_fresh' THEN
    RAISE EXCEPTION '374: a human-shaped profile was not refused';
  END IF;

  IF (public.jit_decide_internal('someone@nobody-owns-this-374.invalid', true, false,
        true, 'tenant', 'agent', v_tenant, '{}'::jsonb, false)->>'reason') <> 'already_member' THEN
    RAISE EXCEPTION '374: an existing member was not refused (JIT must never re-home or re-role a member)';
  END IF;

  IF (public.jit_decide_internal('no-at-sign', true, false,
        true, 'tenant', 'agent', NULL, '{}'::jsonb, false)->>'reason') <> 'no_email' THEN
    RAISE EXCEPTION '374: a malformed address was not refused';
  END IF;

  -- 8.4 The GRANT path, inside a subtransaction that is always discarded -----
  -- This is the only assertion that needs a verified domain to exist, and
  -- creating one for real — even briefly — is precisely the dangerous act this
  -- file exists to control. So it is written inside a plpgsql block that always
  -- raises, which rolls the inserts back while leaving the captured results in
  -- the variables (plpgsql variables are not transactional).
  -- Skipped only if 373 gave tenant_domains a NOT NULL column this block
  -- cannot supply; any OTHER failure is fatal, so the probe cannot rot quietly.
  SELECT string_agg(c.column_name, ', ') INTO v_unfillable
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenant_domains'
     AND c.is_nullable = 'NO' AND c.column_default IS NULL
     AND c.column_name NOT IN ('tenant_id','domain','status','verified_at');

  IF v_unfillable IS NOT NULL THEN
    RAISE NOTICE '374: grant-path probe SKIPPED — tenant_domains requires column(s) this migration cannot supply: %. Refusal assertions above still ran.', v_unfillable;
  ELSE
    BEGIN
      INSERT INTO public.tenant_sso_policy (tenant_id, jit_enabled, jit_default_role)
      VALUES (v_tenant, true, 'tenant_user')
      ON CONFLICT (tenant_id) DO UPDATE SET jit_enabled = true, jit_default_role = 'tenant_user';

      -- The obvious safe choice — an RFC 2606 reserved name like .invalid — is
      -- NOT available: 373's tenant_domains_shape CHECK calls
      -- is_valid_email_domain(), which explicitly rejects
      -- \.(test|invalid|localhost|local|example|internal|onion|alt|arpa)$
      -- on the grounds that a reserved name can never carry an honest DNS
      -- proof of control. Correct rule, and it means the probe has to use a
      -- syntactically real domain. Safety comes from the rollback instead, and
      -- from the two survival checks below that refuse to let the migration
      -- report success if either probe row is still there.
      -- verified_at is supplied because tenant_domains_verified_shape requires
      -- status='verified' and verified_at IS NOT NULL to agree.
      EXECUTE format(
        'INSERT INTO public.tenant_domains (tenant_id, domain, status, verified_at) VALUES (%L, %L, %L, now())',
        v_tenant, 'dt-jit-probe-374-rollback-only.com', 'verified');

      INSERT INTO public.sso_attribute_role_map (tenant_id, attribute_name, attribute_value, role)
      VALUES (v_tenant, 'groups', 'Probe-Admins', 'tenant_admin');

      -- (a) a fresh, confirmed user at a verified domain is admitted at the
      --     configured default role. Mixed case on purpose: an IdP will not
      --     hand back the address in the casing the admin typed.
      v_r1 := public.jit_decide_internal('New.Hire@DT-JIT-Probe-374-Rollback-Only.COM', true, false,
                true, 'tenant', 'agent', NULL, '{}'::jsonb, false);

      -- (b) the SAME user self-asserting an admin group is IGNORED, because the
      --     caller did not vouch for the attributes
      v_r2 := public.jit_decide_internal('new.hire@dt-jit-probe-374-rollback-only.com', true, false,
                true, 'tenant', 'agent', NULL, '{"groups":["Probe-Admins"]}'::jsonb, false);

      -- (c) the same claim from the service role (a real IdP assertion) maps
      v_r3 := public.jit_decide_internal('new.hire@dt-jit-probe-374-rollback-only.com', true, false,
                true, 'tenant', 'agent', NULL, '{"groups":["probe-admins"]}'::jsonb, true);

      -- Set BEFORE the rollback: plpgsql variables are not transactional, so
      -- this and v_r1..v_r3 survive the discarded subtransaction. That is the
      -- entire trick that lets a write-path be proven without leaving a write.
      v_probe_ran := true;
      RAISE EXCEPTION 'PROBE_ROLLBACK_374';
    EXCEPTION
      WHEN others THEN
        IF SQLERRM = 'PROBE_ROLLBACK_374' THEN
          NULL;  -- expected exit: every insert above is now discarded
        ELSE
          -- Deliberately fatal. 373 is being written in parallel, so if it
          -- grew a trigger or a constraint this block cannot satisfy, the
          -- coupling between 373 and 374 is what needs fixing — not this
          -- assertion. Silently downgrading to a NOTICE here would leave the
          -- grant path unproven while the migration reported success.
          RAISE EXCEPTION
            '374: grant-path probe failed against tenant_domains — SQLSTATE %, %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_probe_ran THEN
      RAISE EXCEPTION '374: grant-path probe did not complete';
    END IF;

    IF NOT (v_r1->>'granted')::boolean OR v_r1->>'role' <> 'tenant_user'
       OR (v_r1->>'tenant_id')::uuid <> v_tenant THEN
      RAISE EXCEPTION '374: verified-domain grant path is broken: %', v_r1;
    END IF;
    IF v_r2->>'role' <> 'tenant_user' THEN
      RAISE EXCEPTION '374: BROWSER-SUPPLIED ATTRIBUTES WERE HONOURED — self-service privilege escalation: %', v_r2;
    END IF;
    IF v_r3->>'role' <> 'tenant_admin' THEN
      RAISE EXCEPTION '374: trusted IdP attribute mapping did not apply: %', v_r3;
    END IF;

    -- The probe's rollback really happened. This is not ceremony: the probe
    -- wrote a VERIFIED domain row, which is the exact object that decides who
    -- joins which workspace. A surviving one is a live takeover primitive.
    IF EXISTS (SELECT 1 FROM public.tenant_domains
                WHERE domain = 'dt-jit-probe-374-rollback-only.com') THEN
      RAISE EXCEPTION '374: PROBE DOMAIN SURVIVED THE ROLLBACK — delete that tenant_domains row immediately.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tenant_sso_policy WHERE tenant_id = v_tenant) THEN
      RAISE EXCEPTION '374: probe policy row survived the rollback.';
    END IF;

    RAISE NOTICE '374: grant path, untrusted-attribute rejection and trusted-attribute mapping all proven, then rolled back';
  END IF;

  -- 8.5 Reachability: the internet must not touch any of this ---------------
  IF has_function_privilege('anon', 'public.resolve_jit_membership(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '374: resolve_jit_membership is anon-executable';
  END IF;
  IF has_function_privilege('anon', 'public.sso_login_compliance(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '374: sso_login_compliance is anon-executable';
  END IF;
  IF has_function_privilege('anon', 'public.jit_decide_internal(text,boolean,boolean,boolean,text,text,uuid,jsonb,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.jit_decide_internal(text,boolean,boolean,boolean,text,text,uuid,jsonb,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '374: jit_decide_internal is reachable by a client role — it is a domain-ownership oracle';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.resolve_jit_membership(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '374: resolve_jit_membership is not callable by authenticated — the self-service path is dead';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
              WHERE table_schema='public'
                AND table_name IN ('tenant_sso_policy','sso_attribute_role_map')
                AND grantee IN ('anon','PUBLIC')) THEN
    RAISE EXCEPTION '374: anon still holds table grants on the SSO tables';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
              WHERE table_schema='public'
                AND table_name IN ('tenant_sso_policy','sso_attribute_role_map')
                AND grantee='authenticated' AND privilege_type='TRUNCATE') THEN
    RAISE EXCEPTION '374: authenticated holds TRUNCATE on an SSO table (TRUNCATE is not filtered by RLS)';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public'
                AND c.relname IN ('tenant_sso_policy','sso_attribute_role_map')
                AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION '374: an SSO table has RLS disabled';
  END IF;

  RAISE NOTICE '374: SSO policy + JIT provisioning installed; handle_new_user untouched (md5 %)', c_handle_new_user_md5;
END $assert$;

NOTIFY pgrst, 'reload schema';
