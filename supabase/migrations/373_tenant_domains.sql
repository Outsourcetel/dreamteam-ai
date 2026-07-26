-- 373_tenant_domains.sql
-- ============================================================================
-- DOMAIN CLAIM + DNS VERIFICATION — the foundation SSO, SCIM and JIT-provisioning
-- all sit on. Nothing here turns SAML on; SAML is a Supabase Pro feature and the
-- org is on FREE (GET /v1/projects/rfsvmhcqeiyrxivbmpel/config/auth reports
-- saml_enabled = false, measured 2026-07-26). This is everything AROUND it, so
-- flipping that flag is a same-day change instead of the start of a build.
--
-- ── WHY THIS IS THE MOST DANGEROUS TABLE IN THE PRODUCT ────────────────────
-- A verified domain is an instruction to the identity layer: "any future user
-- whose email ends in @acme.com belongs to workspace X." If workspace X can set
-- that without proving it controls acme.com, then X owns every future acme.com
-- employee account and everything those accounts can read. That is a full tenant
-- takeover primitive, obtained by typing a string into a form.
--
-- signup is OPEN on this project (disable_signup = false), so 'authenticated' is
-- one throwaway email away from anyone on the internet. Anyone can create a
-- workspace, become its tenant_owner, and reach every RPC in this file. The
-- design below therefore assumes the CALLER IS HOSTILE and gives them exactly
-- two powers: create a pending row, and ask a machine to check DNS. Neither of
-- those grants anything.
--
-- ── THE FOUR RULES, AND WHERE EACH ONE IS ENFORCED ─────────────────────────
--   1. A domain is verified for AT MOST ONE tenant, ever.
--        -> partial UNIQUE INDEX on (domain) WHERE status='verified'.
--           In the SCHEMA, not in application code. Application code is where
--           this class of rule goes to die: it survives the first author and
--           dies at the third caller. Postgres cannot be argued with.
--   2. A public email provider can never be claimed at all.
--        -> CHECK constraint calling an IMMUTABLE denylist function. Whoever
--           verifies gmail.com owns every future Gmail signup on the platform.
--   3. An unverified claim grants NOTHING.
--        -> verified_domain_tenant() filters status='verified'. It is the ONLY
--           function that translates a domain into a tenant, so "verified only"
--           is stated in exactly one place. Downstream pieces MUST call it
--           rather than re-querying tenant_domains.
--   4. Only the backend may declare a domain verified.
--        -> the two machine RPCs refuse any caller whose auth.role() is not
--           'service_role', IN THE BODY, and are revoked from authenticated.
--           This is the load-bearing control and section 6 explains it.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ───────────────────────────
-- It does not touch handle_new_user(). That trigger is the live signup path;
-- migration 056 broke it and nobody noticed until 115 fixed it. Consuming a
-- verified domain at signup time is a separate, separately-reviewed change.
-- Until then a verified domain is inert data with a hard uniqueness guarantee —
-- which is exactly the safe order to build this in.
-- ============================================================================

-- ── 1. Normalisation ────────────────────────────────────────────────────────
-- Every comparison in this file (the unique index, the denylist, the lookup)
-- compares raw text. That is only sound if the stored text is canonical, so
-- canonicalisation is a function, it is IMMUTABLE, and a CHECK constraint makes
-- it impossible to store a row that is not already a fixed point of it.
--
-- Deliberately NOT done: IDNA/unicode folding. Postgres has no IDNA library, and
-- a homograph pair (Cyrillic "аcme.com" vs ASCII "acme.com") would be two
-- distinct rows that the unique index cannot see as the same domain — which is
-- rule 1 defeated by a character set. So non-ASCII is REJECTED outright by
-- is_valid_email_domain and the claim RPC tells the admin to enter the A-label
-- (xn--) form. Honest and safe beats convenient and subtly wrong.
CREATE OR REPLACE FUNCTION public.normalize_email_domain(p_input text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT btrim(
    regexp_replace(                            -- 6. trailing dot(s) (FQDN form)
      regexp_replace(                          -- 5. :port
        regexp_replace(                        -- 4. /path ?query #frag
          regexp_replace(                      -- 3. anything up to the last '@'
            regexp_replace(                    -- 2. scheme://
              regexp_replace(                  -- 1. angle brackets from mailto
                lower(btrim(coalesce(p_input, ''))),
              '[<>]', '', 'g'),
            '^[a-z][a-z0-9+.\-]*://', ''),
          '^.*@', ''),
        '[/?#].*$', ''),
      ':[0-9]+$', ''),
    '\.+$', '')
  );
$fn$;
COMMENT ON FUNCTION public.normalize_email_domain(text) IS
  'Canonical form of an email domain. IMMUTABLE and idempotent so it can back a CHECK constraint. Accepts a bare domain, an @domain, a full address or a URL.';

-- Bare public suffixes. "co.uk" is not a domain anyone can own, and accepting it
-- would mean one workspace claiming every .co.uk address. There is no Public
-- Suffix List in Postgres, so this is the pragmatic subset that covers the
-- suffixes a real customer might paste in by mistake. Single-label input is
-- already rejected by the shape regex, which handles bare TLDs.
CREATE OR REPLACE FUNCTION public.is_bare_public_suffix(p_domain text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lower(p_domain) = ANY (ARRAY[
    'co.uk','org.uk','ac.uk','gov.uk','me.uk','net.uk','plc.uk','ltd.uk',
    'com.au','net.au','org.au','edu.au','gov.au','id.au',
    'co.nz','net.nz','org.nz','govt.nz','ac.nz',
    'co.jp','or.jp','ne.jp','ac.jp','go.jp',
    'co.kr','or.kr','ne.kr','go.kr',
    'co.in','net.in','org.in','gov.in','ac.in','edu.in',
    'com.br','net.br','org.br','gov.br','edu.br',
    'com.mx','org.mx','gob.mx','com.ar','com.co','com.pe','com.ve','com.cl',
    'co.za','org.za','net.za','gov.za','ac.za',
    'com.sg','com.my','com.hk','com.tw','com.ph','co.th','com.vn','co.id',
    'com.tr','com.cn','net.cn','org.cn','gov.cn','edu.cn',
    'com.ua','com.pl','com.ru','com.es','com.pt','com.gr','com.cy',
    'co.il','com.sa','com.eg','com.ng','co.ke','com.gh'
  ]::text[]);
$fn$;

CREATE OR REPLACE FUNCTION public.is_valid_email_domain(p_domain text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT p_domain IS NOT NULL
     AND length(p_domain) BETWEEN 4 AND 253            -- 'a.co' .. RFC 1035 cap
     -- Byte-class ASCII gate FIRST. The [a-z] ranges below are collation
     -- sensitive, so a homograph could in principle slip through them; this
     -- test is on code points and cannot. Rule 1 must not be defeatable by
     -- choosing a different alphabet.
     AND p_domain !~ '[^\x01-\x7F]'
     -- Letter-digit-hyphen labels; at least two labels; TLD alphabetic or an
     -- A-label.
     AND p_domain ~ '^([a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9\-]{2,59})$'
     -- Reserved / non-delegated namespaces (RFC 2606, RFC 6761, RFC 8375,
     -- mDNS, Tor). These never resolve on the public internet, so no DNS TXT
     -- proof of control is possible and a claim on one could never be honest.
     AND p_domain !~ '\.(test|invalid|localhost|local|example|internal|onion|alt|arpa)$'
     AND NOT public.is_bare_public_suffix(p_domain);
$fn$;

-- ── 2. The public-provider denylist ─────────────────────────────────────────
-- STARTER LIST, NOT EXHAUSTIVE — say so out loud rather than implying coverage
-- this cannot have. Three categories, all of which are catastrophic to verify:
--   (a) consumer mailbox providers  — verifying gmail.com hands one workspace
--       every future Gmail signup on the platform;
--   (b) ISP/telco mailboxes         — same failure mode, less obvious;
--   (c) disposable/throwaway hosts  — free, unlimited, un-attributable identity.
-- Plus the RFC 2606 / RFC 6761 reserved names, which must never become real.
--
-- Baked into an IMMUTABLE function rather than a table ON PURPOSE: a CHECK
-- constraint cannot read a table, and a "denylist" enforced only in the claim
-- RPC is a denylist that any future second insert path walks straight past.
-- The cost is that extending it needs a migration. That is the correct cost:
-- adding a domain here is a security decision and should leave a commit.
--
-- THE ERROR ASYMMETRY, which is why borderline entries are included: a false
-- positive is one support ticket and a one-line migration. A false negative is
-- one workspace silently owning every future account at a mailbox provider,
-- platform-wide, discovered later. So when a domain is plausibly consumer mail,
-- it goes in. Domains that are unambiguously a company's own corporate mail
-- (google.com, duckduckgo.com) are deliberately NOT listed — blocking a real
-- enterprise buyer is the failure this list must not cause.
--
-- LIMIT, stated plainly: replacing this function does NOT re-validate rows that
-- already exist, because CHECK constraints only run on write. Adding an entry
-- that some tenant has already verified needs a deliberate cleanup.
CREATE OR REPLACE FUNCTION public.public_email_domain_denylist()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    -- (a) consumer mailbox providers
    'gmail.com','googlemail.com',
    'outlook.com','outlook.co.uk','hotmail.com','hotmail.co.uk','hotmail.fr',
    'hotmail.it','hotmail.es','hotmail.de','live.com','live.co.uk','live.ca',
    'live.com.au','live.nl','msn.com',
    'yahoo.com','yahoo.co.uk','yahoo.co.jp','yahoo.co.in','yahoo.ca','yahoo.fr',
    'yahoo.de','yahoo.es','yahoo.it','yahoo.com.au','yahoo.com.br','yahoo.in',
    'ymail.com','rocketmail.com',
    'aol.com','aim.com','icloud.com','me.com','mac.com',
    'proton.me','protonmail.com','protonmail.ch','pm.me',
    'gmx.com','gmx.net','gmx.de','gmx.at','gmx.ch','mail.com','email.com',
    'zoho.com','zohomail.com','fastmail.com','fastmail.fm','hushmail.com',
    'tutanota.com','tutanota.de','tuta.io','tutamail.com',
    'mail.ru','list.ru','bk.ru','inbox.ru','internet.ru','rambler.ru',
    'yandex.ru','yandex.com','ya.ru','ukr.net','i.ua','meta.ua',
    'qq.com','foxmail.com','163.com','126.com','yeah.net','sina.com','sina.cn',
    'sohu.com','naver.com','daum.net','hanmail.net','nate.com',
    'web.de','t-online.de','freenet.de','arcor.de',
    'orange.fr','free.fr','laposte.net','wanadoo.fr','sfr.fr','bbox.fr',
    'libero.it','virgilio.it','tiscali.it','alice.it','tin.it',
    'terra.com.br','uol.com.br','bol.com.br','ig.com.br',
    'rediffmail.com','sify.com',
    'seznam.cz','centrum.cz','wp.pl','o2.pl','onet.pl','interia.pl','gazeta.pl',
    'abv.bg','walla.com','walla.co.il',
    -- (b) ISP / telco mailboxes — same failure mode, less obvious
    'comcast.net','verizon.net','att.net','sbcglobal.net','bellsouth.net',
    'cox.net','charter.net','earthlink.net','juno.com','netzero.net',
    'roadrunner.com','optonline.net','windstream.net',
    'btinternet.com','sky.com','talktalk.net','virginmedia.com','ntlworld.com',
    'blueyonder.co.uk','tiscali.co.uk',
    'shaw.ca','sympatico.ca','telus.net','videotron.ca',
    'bigpond.com','bigpond.net.au','optusnet.com.au','iinet.net.au',
    'xtra.co.nz',
    -- (c) disposable / throwaway / alias — free, unlimited, un-attributable
    'mailinator.com','guerrillamail.com','sharklasers.com','grr.la',
    '10minutemail.com','temp-mail.org','tempmail.com','tempmailo.com',
    'yopmail.com','throwawaymail.com','trashmail.com','trashmail.de',
    'getnada.com','nada.email','dispostable.com','maildrop.cc','mailnesia.com',
    'moakt.com','emailondeck.com','spamgourmet.com','mytemp.email',
    'fakeinbox.com','mailcatch.com','discard.email','mail-temporaire.fr',
    'burnermail.io','anonaddy.com','simplelogin.io','duck.com','33mail.com',
    -- RFC 2606 second-level reservations. The reserved TLDs (.test, .invalid,
    -- .localhost, .example, .local, .internal, .onion) are handled by
    -- is_valid_email_domain instead, since a suffix rule covers them all.
    'example.com','example.org','example.net','example.edu'
  ]::text[];
$fn$;

-- Matches the domain itself AND any subdomain of it. A subdomain of a consumer
-- provider is not a legitimate corporate mail domain, and letting one through
-- would put a row in the table that a future, looser matcher could act on.
CREATE OR REPLACE FUNCTION public.is_public_email_domain(p_domain text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM unnest(public.public_email_domain_denylist()) AS d
     -- no LIKE metacharacters ('%', '_') appear in the denylist, so '%.'||d is
     -- an exact suffix match; dots are literal in LIKE.
     WHERE lower(p_domain) = d OR lower(p_domain) LIKE '%.' || d
  );
$fn$;

-- The DNS record name is a function, not a string literal repeated in four
-- places, so the migration, the RPCs, the edge function and the UI can never
-- disagree about where the token is supposed to live.
CREATE OR REPLACE FUNCTION public.tenant_domain_dns_record_name(p_domain text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT '_dreamteam-verify.' || p_domain;
$fn$;

-- ── 3. The table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_domains (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain              text NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','verified','failed')),

  -- Unguessable BY CONSTRUCTION: the DEFAULT is the only place a token is ever
  -- minted, so no current or future RPC can accidentally ship a weak one.
  -- 32 CSPRNG bytes = 256 bits, hex-encoded. Not sequential, not derived from
  -- the domain, not derived from the tenant id — a token that can be computed
  -- from public inputs is not a proof of control.
  verification_token  text NOT NULL
                        DEFAULT 'dreamteam-domain-verification=' ||
                                encode(extensions.gen_random_bytes(32), 'hex'),
  verification_method text NOT NULL DEFAULT 'dns_txt'
                        CHECK (verification_method IN ('dns_txt')),

  verified_at         timestamptz,
  last_checked_at     timestamptz,
  last_error          text,          -- machine-readable reason, not prose
  check_count         integer NOT NULL DEFAULT 0,
  failure_count       integer NOT NULL DEFAULT 0,
  checks_today        integer NOT NULL DEFAULT 0,
  checks_today_on     date,

  created_by          uuid,          -- auth.users id; no FK, matching profiles
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Canonical form is a storage invariant, not a hope about callers.
  CONSTRAINT tenant_domains_canonical
    CHECK (domain = public.normalize_email_domain(domain)),
  CONSTRAINT tenant_domains_shape
    CHECK (public.is_valid_email_domain(domain)),
  -- RULE 2. Enforced here rather than in the claim RPC so that every write
  -- path, present and future, is covered by the same statement.
  CONSTRAINT tenant_domains_not_public_provider
    CHECK (NOT public.is_public_email_domain(domain)),
  -- 'verified' and 'has a verification timestamp' are the same fact; a row that
  -- disagrees with itself is a row an auditor cannot read.
  CONSTRAINT tenant_domains_verified_shape
    CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  CONSTRAINT tenant_domains_token_strength
    CHECK (length(verification_token) >= 48)
);

-- RULE 1, IN THE SCHEMA. This single index is the whole anti-takeover story:
-- two tenants cannot both hold acme.com as verified, no matter which code path
-- tries. Pending rows are deliberately NOT covered — see section 5.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_verified_uq
  ON tenant_domains (domain) WHERE status = 'verified';

-- One row per (tenant, domain): re-claiming is idempotent, never duplicative.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_tenant_domain_uq
  ON tenant_domains (tenant_id, domain);

DROP TRIGGER IF EXISTS tenant_domains_touch ON tenant_domains;
CREATE TRIGGER tenant_domains_touch BEFORE UPDATE ON tenant_domains
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;

-- READ is admin-only, not member-wide: the row carries the verification token,
-- and the token is the one piece of data that (combined with DNS control)
-- decides who owns the domain. Least exposure.
-- There is NO insert/update/delete policy anywhere. Writes go exclusively
-- through the SECURITY DEFINER functions below. A client-writable domain table
-- is a client-writable identity system.
DROP POLICY IF EXISTS tenant_domains_read ON tenant_domains;
CREATE POLICY tenant_domains_read ON tenant_domains
  FOR SELECT USING (public.can_admin_tenant_internal(tenant_id));

COMMENT ON TABLE tenant_domains IS
  'Email domains claimed by a workspace. Only status=''verified'' means anything; a pending or failed row grants nothing. A domain is verified for at most one tenant (partial unique index tenant_domains_verified_uq).';

-- ── 4. The lookup — the ONLY place a domain becomes a tenant ───────────────
-- RULE 3 lives here. Every downstream consumer (JIT provisioning, invite
-- suggestions, an SSO connection lookup) must call this and must not re-query
-- the table, so there is exactly one line in the codebase that decides whether
-- an unverified claim counts. It does not.
--
-- service_role ONLY, and it says so in its own body. Exposing it to
-- 'authenticated' would turn it into a customer-enumeration oracle: anybody with
-- a throwaway signup could probe "does workspace X exist for stripe.com" across
-- the whole platform. It returns a tenant id and nothing else.
--
-- Suspended tenants are excluded: a workspace that has been switched off must
-- not silently absorb new accounts. It is still excluded from re-claiming by
-- the unique index, which is the intended behaviour — its claim is held, not
-- released.
CREATE OR REPLACE FUNCTION public.verified_domain_tenant(p_email_or_domain text)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid;
BEGIN
  -- Named explicitly. NEVER written as "if auth.uid() is null then trust" —
  -- anon also has a NULL uid, which is the exact bug migration 369 fixed.
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'verified_domain_tenant is a backend-only lookup'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT d.tenant_id INTO v_tenant
    FROM tenant_domains d
    JOIN tenants t ON t.id = d.tenant_id
   WHERE d.status = 'verified'
     AND d.domain = public.normalize_email_domain(p_email_or_domain)
     AND coalesce(t.status, 'active') <> 'suspended'
   LIMIT 1;

  RETURN v_tenant;
END $fn$;
REVOKE ALL ON ROUTINE public.verified_domain_tenant(text) FROM PUBLIC, anon, authenticated;

-- ── 5. Human RPCs: claim, list, remove ─────────────────────────────────────
-- All three are gated by can_admin_tenant_internal(caller's own tenant). Note
-- that function returns true for service_role regardless of the tenant argument,
-- so each RPC resolves the tenant from the CALLER (auth_tenant_id()) and refuses
-- when that is NULL. A service-role caller therefore has no tenant to act on and
-- cannot use these to reach into an arbitrary workspace.
CREATE OR REPLACE FUNCTION public.claim_tenant_domain(p_domain text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $fn$
DECLARE
  v_tenant uuid := public.auth_tenant_id();
  v_domain text;
  v_row    tenant_domains;
  v_count  integer;
  v_actor  text;
  v_existed boolean := false;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'not a member of any workspace' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.can_admin_tenant_internal(v_tenant) THEN
    RAISE EXCEPTION 'only workspace owners and admins can claim a domain'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Precise refusals. "invalid domain" makes an admin guess; each branch below
  -- tells them the one thing they have to change.
  IF p_domain IS NULL OR btrim(p_domain) = '' THEN
    RAISE EXCEPTION 'enter a domain, for example acme.com';
  END IF;
  IF p_domain ~ '[^\x01-\x7F]' THEN
    RAISE EXCEPTION 'internationalised domains must be entered in punycode form (for example xn--80ak6aa92e.com) — we do not convert unicode, because two spellings of one domain would defeat the one-workspace-per-domain rule';
  END IF;

  v_domain := public.normalize_email_domain(p_domain);

  IF public.is_bare_public_suffix(v_domain) THEN
    RAISE EXCEPTION '"%" is a public suffix, not a domain anyone can own', v_domain;
  END IF;
  IF NOT public.is_valid_email_domain(v_domain) THEN
    RAISE EXCEPTION '"%" is not a valid domain — enter the part after the @, for example acme.com', v_domain;
  END IF;
  IF public.is_public_email_domain(v_domain) THEN
    RAISE EXCEPTION '"%" is a public email provider and cannot be claimed by any workspace — verifying it would hand this workspace every future account at that provider', v_domain;
  END IF;

  SELECT count(*) INTO v_count FROM tenant_domains WHERE tenant_id = v_tenant;
  IF v_count >= 25 THEN
    RAISE EXCEPTION 'this workspace already has 25 claimed domains — remove one first';
  END IF;

  -- Idempotent: re-claiming returns the SAME token. Rotating it here would
  -- break an admin who has already published the TXT record and is waiting for
  -- DNS to propagate — the single most common way this flow is used.
  SELECT * INTO v_row FROM tenant_domains
   WHERE tenant_id = v_tenant AND domain = v_domain;

  IF FOUND THEN
    v_existed := true;
  ELSE
    -- verification_token deliberately omitted: the column DEFAULT is the only
    -- token minting site in the system.
    INSERT INTO tenant_domains (tenant_id, domain, created_by)
    VALUES (v_tenant, v_domain, auth.uid())
    RETURNING * INTO v_row;

    SELECT coalesce(full_name, 'a workspace admin') INTO v_actor
      FROM profiles WHERE user_id = auth.uid();
    PERFORM public.append_audit_event_internal(
      v_tenant, coalesce(v_actor, 'a workspace admin'), 'human',
      format('Claimed the email domain %s (unverified)', v_domain),
      'config_change',
      jsonb_build_object('kind', 'tenant_domain_claimed', 'domain', v_domain,
                         'domain_id', v_row.id));
  END IF;

  -- NOTE what is NOT returned: whether some other workspace already verified
  -- this domain. Telling an anonymous-signup caller that would turn this RPC
  -- into a customer-list enumeration oracle. They find out at verification
  -- time — at which point they have proved they control the domain, so telling
  -- them is safe. See record_domain_verification_attempt.
  RETURN jsonb_build_object(
    'id', v_row.id,
    'domain', v_row.domain,
    'status', v_row.status,
    'already_claimed', v_existed,
    'record_type', 'TXT',
    'record_name', public.tenant_domain_dns_record_name(v_row.domain),
    'record_value', v_row.verification_token
  );
END $fn$;
REVOKE ALL ON ROUTINE public.claim_tenant_domain(text) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.claim_tenant_domain(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_tenant_domains()
RETURNS TABLE (id uuid, domain text, status text, verification_token text,
               record_name text, verified_at timestamptz,
               last_checked_at timestamptz, last_error text,
               check_count integer, failure_count integer, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_tenant IS NULL OR NOT public.can_admin_tenant_internal(v_tenant) THEN
    RAISE EXCEPTION 'only workspace owners and admins can view claimed domains'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT d.id, d.domain, d.status, d.verification_token,
           public.tenant_domain_dns_record_name(d.domain),
           d.verified_at, d.last_checked_at, d.last_error,
           d.check_count, d.failure_count, d.created_at
      FROM tenant_domains d
     WHERE d.tenant_id = v_tenant
     ORDER BY (d.status = 'verified') DESC, d.domain;
END $fn$;
REVOKE ALL ON ROUTINE public.list_tenant_domains() FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.list_tenant_domains() TO authenticated;

-- Removing a VERIFIED domain is allowed on purpose. A customer changing email
-- provider, divesting a brand, or correcting a typo is normal, and a claim that
-- can only be released by support is a support queue plus a hostage. Removal
-- releases the domain for anyone else to verify — which is why it is audited
-- loudly and why the RPC reports back that the domain was verified so the UI
-- can make the consequence explicit before the click.
CREATE OR REPLACE FUNCTION public.remove_tenant_domain(p_domain_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_tenant uuid := public.auth_tenant_id();
  v_row    tenant_domains;
  v_actor  text;
BEGIN
  IF v_tenant IS NULL OR NOT public.can_admin_tenant_internal(v_tenant) THEN
    RAISE EXCEPTION 'only workspace owners and admins can remove a domain'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Scoped by tenant_id in the DELETE itself, so an id belonging to another
  -- workspace deletes nothing and is reported as not found. The same wording
  -- for "wrong id" and "someone else's id" is intentional: it leaks nothing.
  DELETE FROM tenant_domains
   WHERE id = p_domain_id AND tenant_id = v_tenant
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'domain not found in this workspace';
  END IF;

  SELECT coalesce(full_name, 'a workspace admin') INTO v_actor
    FROM profiles WHERE user_id = auth.uid();
  PERFORM public.append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'a workspace admin'), 'human',
    format('Removed the email domain %s (%s)', v_row.domain, v_row.status),
    'config_change',
    jsonb_build_object('kind', 'tenant_domain_removed', 'domain', v_row.domain,
                       'was_verified', v_row.status = 'verified'));

  RETURN jsonb_build_object('removed', true, 'domain', v_row.domain,
                            'was_verified', v_row.status = 'verified');
END $fn$;
REVOKE ALL ON ROUTINE public.remove_tenant_domain(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.remove_tenant_domain(uuid) TO authenticated;

-- ── 6. Machine RPCs — RULE 4, the load-bearing control ─────────────────────
-- THE THREAT: list_tenant_domains shows an admin their own verification token,
-- because they need it to publish the DNS record. So if a tenant_admin could
-- call the "record the result" RPC directly, they would simply pass their own
-- token back in and self-verify any domain on earth without touching DNS. That
-- is the tenant-takeover primitive, fully armed, in one RPC call.
--
-- THE FIX, in two layers that do not depend on each other:
--   (i)  REVOKE ... FROM PUBLIC, anon, authenticated — no grant, no call.
--   (ii) an explicit auth.role() = 'service_role' check IN THE BODY, so a
--        future CREATE OR REPLACE that silently resets grants to the PUBLIC
--        default (which is exactly how this codebase has lost a revoke before)
--        still cannot be exploited.
-- Layer (ii) is why the token comparison also lives in SQL rather than in the
-- edge function: the edge function never asserts "this is verified", it only
-- reports what DNS said, and Postgres decides. Verification logic sitting next
-- to the token it compares against is one place to review instead of two.

-- Claim a check slot. Atomic: the cooldown is a predicate on the UPDATE, so two
-- concurrent isolates cannot both pass a read-then-check and both hit DNS.
-- Rate limiting lives here rather than only in the edge function because the
-- edge function is redeployable and this is not — a caller must never be able
-- to use us as a DNS amplifier against a third party's nameservers.
--
-- Accepts EITHER the row id or the domain string, because the admin UI holds
-- one and a scripted caller naturally holds the other. Resolution happens here,
-- using this file's own normalize_email_domain, so there is never a second
-- spelling of "which row is acme.com" living in TypeScript and drifting.
-- Whichever is supplied, the row must belong to p_tenant.
CREATE OR REPLACE FUNCTION public.claim_domain_verification_slot(
  p_tenant uuid, p_domain_id uuid DEFAULT NULL, p_domain text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
-- v_updated is separate from v_domain on purpose: PL/pgSQL sets an INTO target
-- to NULL when the statement returns no rows, so reusing v_domain as the
-- RETURNING target would erase the value read a few lines earlier and the
-- throttle message would name a blank domain.
DECLARE v_domain text; v_status text; v_updated text; v_id uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'domain verification runs from the backend only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_tenant IS NULL OR (p_domain_id IS NULL AND p_domain IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- p_tenant comes from the caller's JWT as resolved by the edge function, and
  -- is matched here rather than trusted there. A bug in the edge function that
  -- passes somebody else's domain id therefore fails in SQL instead of
  -- verifying another workspace's domain. Note tenant_id is in BOTH branches.
  SELECT id, status, domain INTO v_id, v_status, v_domain
    FROM tenant_domains
   WHERE tenant_id = p_tenant
     AND (( p_domain_id IS NOT NULL AND id = p_domain_id)
       OR ( p_domain_id IS NULL AND domain = public.normalize_email_domain(p_domain)));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_status = 'verified' THEN
    -- Idempotent: verifying an already-verified domain is a no-op, not a DNS
    -- query and not an error.
    RETURN jsonb_build_object('ok', false, 'reason', 'already_verified',
                              'status', 'verified', 'domain', v_domain,
                              'domain_id', v_id);
  END IF;

  UPDATE tenant_domains
     SET last_checked_at = now(),
         check_count     = check_count + 1,
         checks_today    = CASE WHEN checks_today_on IS DISTINCT FROM current_date
                                THEN 1 ELSE checks_today + 1 END,
         checks_today_on = current_date
   WHERE id = v_id
     AND tenant_id = p_tenant
     AND status <> 'verified'
     AND (last_checked_at IS NULL OR last_checked_at <= now() - interval '30 seconds')
     AND (checks_today_on IS DISTINCT FROM current_date OR checks_today < 50)
  RETURNING domain INTO v_updated;

  IF NOT FOUND THEN
    -- v_domain still holds the value read above, so the caller can name the
    -- domain in the "wait 30 seconds" message instead of showing a blank.
    RETURN jsonb_build_object('ok', false, 'reason', 'throttled',
                              'status', v_status, 'domain', v_domain,
                              'domain_id', v_id,
                              'record_name', public.tenant_domain_dns_record_name(v_domain));
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'domain', v_domain, 'domain_id', v_id,
    'record_name', public.tenant_domain_dns_record_name(v_domain));
END $fn$;
REVOKE ALL ON ROUTINE public.claim_domain_verification_slot(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

-- Record what DNS actually said, and let Postgres — not the caller — decide
-- whether that constitutes proof.
CREATE OR REPLACE FUNCTION public.record_domain_verification_attempt(
  p_tenant uuid, p_domain_id uuid, p_txt_records text[], p_dns_error text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_row     tenant_domains;
  v_matched boolean;
  v_seen    integer := coalesce(array_length(p_txt_records, 1), 0);
  v_reason  text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'domain verification runs from the backend only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_row FROM tenant_domains
   WHERE id = p_domain_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unknown', 'reason', 'not_found');
  END IF;
  IF v_row.status = 'verified' THEN
    RETURN jsonb_build_object('status', 'verified', 'reason', 'already_verified',
                              'verified_at', v_row.verified_at);
  END IF;

  IF p_dns_error IS NOT NULL THEN
    v_reason := p_dns_error;                       -- nxdomain / dns_timeout / ...
  ELSE
    -- Resolvers hand back TXT values quoted, and a long value arrives as several
    -- character-strings the client must concatenate; the edge function joins
    -- them, we strip quotes and whitespace here. Comparison is on the full
    -- 256-bit token, so there is nothing to shorten and no prefix match.
    SELECT EXISTS (
      SELECT 1 FROM unnest(p_txt_records) AS r
       WHERE btrim(btrim(r), '"') = v_row.verification_token
    ) INTO v_matched;

    IF NOT v_matched THEN
      v_reason := CASE WHEN v_seen = 0 THEN 'no_txt_record' ELSE 'token_mismatch' END;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    UPDATE tenant_domains
       SET last_error    = v_reason,
           failure_count = failure_count + 1,
           -- 'failed' is a UI signal ("this claim has been failing for a while,
           -- look at it"), NOT a lock: the next successful check clears it and
           -- claim_domain_verification_slot still accepts attempts. A status
           -- that traps a customer needing support to escape is a worse bug
           -- than a status that nags.
           status        = CASE WHEN failure_count + 1 >= 10 THEN 'failed' ELSE status END
     WHERE id = p_domain_id
    RETURNING * INTO v_row;

    RETURN jsonb_build_object('status', v_row.status, 'reason', v_reason,
                              'records_seen', v_seen);
  END IF;

  BEGIN
    UPDATE tenant_domains
       SET status = 'verified', verified_at = now(),
           last_error = NULL, failure_count = 0
     WHERE id = p_domain_id
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    -- RULE 1 firing. The caller has just PROVED control of this domain, so
    -- naming the situation is safe and is the only way they can act on it
    -- (get the other workspace to release it, or contact support). We still do
    -- not name the other workspace.
    UPDATE tenant_domains
       SET last_error = 'domain_verified_by_another_workspace',
           failure_count = failure_count + 1
     WHERE id = p_domain_id;
    RETURN jsonb_build_object('status', 'pending',
                              'reason', 'domain_verified_by_another_workspace');
  END;

  PERFORM public.append_audit_event_internal(
    v_row.tenant_id, 'domain verification', 'system',
    format('Verified control of the email domain %s by DNS TXT record', v_row.domain),
    'config_change',
    jsonb_build_object('kind', 'tenant_domain_verified', 'domain', v_row.domain,
                       'domain_id', v_row.id, 'method', 'dns_txt'));

  RETURN jsonb_build_object('status', 'verified', 'reason', 'token_matched',
                            'verified_at', v_row.verified_at);
END $fn$;
REVOKE ALL ON ROUTINE public.record_domain_verification_attempt(uuid, uuid, text[], text)
  FROM PUBLIC, anon, authenticated;

-- CREATE OR REPLACE resets grants to the PUBLIC default, so every revoke above
-- is placed AFTER its body. Doing it the other way round is how a fix silently
-- undoes itself. Re-stated here as a block so a future editor who appends a
-- function to section 6 sees the pattern.
REVOKE ALL ON ROUTINE public.verified_domain_tenant(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ROUTINE public.claim_domain_verification_slot(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ROUTINE public.record_domain_verification_attempt(uuid, uuid, text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ROUTINE public.normalize_email_domain(text) FROM PUBLIC, anon;
REVOKE ALL ON ROUTINE public.is_public_email_domain(text) FROM PUBLIC, anon;
REVOKE ALL ON ROUTINE public.is_valid_email_domain(text) FROM PUBLIC, anon;
REVOKE ALL ON ROUTINE public.is_bare_public_suffix(text) FROM PUBLIC, anon;
REVOKE ALL ON ROUTINE public.public_email_domain_denylist() FROM PUBLIC, anon;
REVOKE ALL ON ROUTINE public.tenant_domain_dns_record_name(text) FROM PUBLIC, anon;
-- The pure predicates are safe for a logged-in admin: they let the claim form
-- say "that's a public provider" before submitting, and they reveal nothing
-- about any tenant.
GRANT EXECUTE ON ROUTINE public.normalize_email_domain(text) TO authenticated;
GRANT EXECUTE ON ROUTINE public.is_public_email_domain(text) TO authenticated;
GRANT EXECUTE ON ROUTINE public.is_valid_email_domain(text) TO authenticated;
GRANT EXECUTE ON ROUTINE public.is_bare_public_suffix(text) TO authenticated;
GRANT EXECUTE ON ROUTINE public.tenant_domain_dns_record_name(text) TO authenticated;

-- ── 7. PROVE IT ────────────────────────────────────────────────────────────
-- Every probe below can fail. Each one attempts something the design says is
-- impossible and RAISES if it succeeded. Probe rows are inserted against two
-- real tenants and deleted at the end of the success path; on any failure the
-- whole migration aborts and the transaction rolls back, so nothing survives
-- either way. The final probe re-counts to prove the cleanup.
DO $assert$
DECLARE
  v_t1     uuid;
  v_t2     uuid;
  v_probe  text := 'dt-mig373-probe.com';
  v_probe2 text := 'dt-mig373-probe2.com';
  v_probe3 text := 'dt-mig373-probe3.com';
  v_tok    text := 'dreamteam-domain-verification=' || repeat('a', 64);
  v_tok2   text := 'dreamteam-domain-verification=' || repeat('b', 64);
  v_ok     boolean;
  v_id     uuid;
  v_id2    uuid;
  v_id3    uuid;
  v_got    uuid;
  v_a      text;
  v_b      text;
  v_left   integer;
BEGIN
  SELECT count(*) INTO v_left FROM tenants;
  SELECT id INTO v_t1 FROM tenants ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_t2 FROM tenants WHERE id <> v_t1 ORDER BY created_at, id LIMIT 1;
  IF v_t1 IS NULL OR v_t2 IS NULL THEN
    RAISE EXCEPTION '373: two tenants are required to prove the one-workspace-per-domain rule; found %', v_left;
  END IF;

  -- A. Normalisation is idempotent and actually strips the shapes users paste.
  IF public.normalize_email_domain('  HTTPS://User@ACME.com:443/login?x=1  ') <> 'acme.com'
     OR public.normalize_email_domain('@Acme.COM.') <> 'acme.com'
     OR public.normalize_email_domain(public.normalize_email_domain('ACME.com')) <> 'acme.com'
  THEN
    RAISE EXCEPTION '373: normalize_email_domain does not canonicalise the shapes it claims to';
  END IF;

  -- B. Public providers are rejected BY THE SCHEMA, not by the RPC.
  FOREACH v_a IN ARRAY ARRAY['gmail.com','outlook.com','yahoo.com','hotmail.com',
                             'icloud.com','proton.me','mailinator.com',
                             'mail.gmail.com',      -- and subdomains of them
                             'example.com','foo.local','foo.internal','foo.test']
  LOOP
    BEGIN
      INSERT INTO tenant_domains (tenant_id, domain, verification_token)
      VALUES (v_t1, v_a, v_tok);
      v_ok := false;
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION '373: the public/reserved-domain CHECK accepted % — one workspace could own every account there', v_a;
    END IF;
  END LOOP;

  -- B2. A corporate domain that merely LOOKS consumer-ish must still be
  --     claimable. A denylist that blocks real buyers is its own outage.
  IF public.is_public_email_domain('outsourcetel.com')
     OR public.is_public_email_domain('google.com')
     OR NOT public.is_valid_email_domain('mail.acme-corp.co.uk')
  THEN
    RAISE EXCEPTION '373: the denylist or the shape check is rejecting legitimate corporate domains';
  END IF;

  -- C. Non-canonical / malformed / public-suffix input cannot be stored at all,
  --    so the unique index in D is comparing like with like.
  FOREACH v_a IN ARRAY ARRAY['ACME.com','acme.com.','http://acme.com','acme',
                             'co.uk','-acme.com','acme.com/path','acme..com']
  LOOP
    BEGIN
      INSERT INTO tenant_domains (tenant_id, domain, verification_token)
      VALUES (v_t1, v_a, v_tok);
      v_ok := false;
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION '373: a non-canonical domain (%) was storable — the unique index can be defeated by spelling', v_a;
    END IF;
  END LOOP;

  -- C2. HOMOGRAPHS. Tested as a predicate rather than an INSERT because the
  --     [a-z] ranges in the shape regex are collation-dependent, and the point
  --     of this probe is that the ASCII byte-class gate — not the collation —
  --     is what rejects a Cyrillic lookalike. Written with chr() so the
  --     assertion cannot be silently disarmed by a file re-encoding.
  v_a := chr(1072) || 'cme.com';    -- U+0430 CYRILLIC SMALL LETTER A + "cme.com"
  IF public.is_valid_email_domain(v_a) THEN
    RAISE EXCEPTION '373: a homograph of acme.com is a valid domain — two spellings of one name would both be verifiable, defeating the one-workspace-per-domain rule';
  END IF;

  -- D. RULE 1: a second tenant CANNOT verify a domain another tenant holds.
  INSERT INTO tenant_domains (tenant_id, domain, status, verified_at, verification_token)
  VALUES (v_t1, v_probe, 'verified', now(), v_tok)
  RETURNING id INTO v_id;

  BEGIN
    INSERT INTO tenant_domains (tenant_id, domain, status, verified_at, verification_token)
    VALUES (v_t2, v_probe, 'verified', now(), v_tok2);
    v_ok := false;
  EXCEPTION WHEN unique_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION '373: TWO TENANTS HOLD THE SAME VERIFIED DOMAIN — this is the takeover bug the whole file exists to prevent';
  END IF;

  -- E. A competing PENDING claim is allowed (documented in section 5: refusing
  --    it at claim time would leak which domains are already customers), and it
  --    must lose to the verified holder in the lookup.
  INSERT INTO tenant_domains (tenant_id, domain, verification_token)
  VALUES (v_t2, v_probe, v_tok2)
  RETURNING id INTO v_id2;

  -- F. RULE 3: pending grants nothing; verified resolves to the right tenant.
  --    verified_domain_tenant refuses non-service-role callers (probe I), so
  --    this reads the same predicate directly rather than forging a JWT claim —
  --    forging identity to test a gate proves nothing about the gate.
  INSERT INTO tenant_domains (tenant_id, domain, verification_token)
  VALUES (v_t1, v_probe2, v_tok)
  RETURNING id INTO v_id3;

  SELECT d.tenant_id INTO v_got FROM tenant_domains d
   WHERE d.status = 'verified' AND d.domain = public.normalize_email_domain('someone@' || v_probe2);
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION '373: an UNVERIFIED claim resolved to tenant % — pending must grant nothing', v_got;
  END IF;

  SELECT d.tenant_id INTO v_got FROM tenant_domains d
   WHERE d.status = 'verified' AND d.domain = public.normalize_email_domain('Someone@' || v_probe);
  IF v_got IS DISTINCT FROM v_t1 THEN
    RAISE EXCEPTION '373: verified lookup returned % but the verified holder is %', v_got, v_t1;
  END IF;

  -- G. status/verified_at cannot disagree. Run against v_probe2, which no other
  --    tenant holds, so the CHECK is what rejects it and not the unique index.
  BEGIN
    UPDATE tenant_domains SET status = 'verified' WHERE id = v_id3;  -- verified_at still NULL
    v_ok := false;
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION '373: a row can be verified with no verified_at — the audit trail would be unreadable';
  END IF;

  -- H. Tokens are unguessable by construction. BOTH rows here omit
  --    verification_token so the column DEFAULT mints both — comparing a
  --    generated token against a hand-written one would prove nothing about the
  --    generator. Two rows minted microseconds apart must share nothing, and
  --    neither may be derivable from the domain or the tenant id.
  INSERT INTO tenant_domains (tenant_id, domain)
  VALUES (v_t2, v_probe2) RETURNING verification_token INTO v_a;
  INSERT INTO tenant_domains (tenant_id, domain)
  VALUES (v_t1, v_probe3) RETURNING verification_token INTO v_b;
  IF v_b = v_a
     OR v_a !~ '^dreamteam-domain-verification=[0-9a-f]{64}$'
     OR v_b !~ '^dreamteam-domain-verification=[0-9a-f]{64}$'
     OR strpos(v_a, v_probe2) > 0 OR strpos(v_a, replace(v_t2::text, '-', '')) > 0
  THEN
    RAISE EXCEPTION '373: the token DEFAULT is not producing 256 independent random bits (got %)', left(v_b, 45);
  END IF;

  -- I. RULE 4: the machine RPCs refuse a caller that is not the service role.
  --    No forgery involved — this migration runs as postgres with no JWT, so
  --    auth.role() is genuinely NULL here (measured: select auth.role() returns
  --    null over the management API). Guarded so that a future runner which IS
  --    service_role skips rather than fails.
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    BEGIN
      PERFORM public.record_domain_verification_attempt(v_t1, v_id2, ARRAY[v_a], NULL::text);
      v_ok := false;
    EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION '373: record_domain_verification_attempt ran for a non-service-role caller — any tenant admin could self-verify any domain';
    END IF;

    BEGIN
      PERFORM public.claim_domain_verification_slot(v_t1, v_id2);
      v_ok := false;
    EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION '373: claim_domain_verification_slot ran for a non-service-role caller';
    END IF;

    BEGIN
      PERFORM public.verified_domain_tenant('someone@' || v_probe);
      v_ok := false;
    EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION '373: verified_domain_tenant is callable by non-backend code — it is a customer enumeration oracle';
    END IF;
  ELSE
    RAISE NOTICE '373: skipped the service_role refusal probes (this session IS service_role)';
  END IF;

  -- J. Grants match intent. anon reaches nothing; authenticated reaches only
  --    the three human RPCs and the pure predicates.
  SELECT string_agg(sig, ', ') INTO v_a FROM (
    SELECT s.sig FROM (VALUES
      ('public.claim_tenant_domain(text)'),
      ('public.list_tenant_domains()'),
      ('public.remove_tenant_domain(uuid)'),
      ('public.verified_domain_tenant(text)'),
      ('public.claim_domain_verification_slot(uuid,uuid,text)'),
      ('public.record_domain_verification_attempt(uuid,uuid,text[],text)')
    ) AS s(sig)
    WHERE has_function_privilege('anon', s.sig, 'EXECUTE')
  ) q;
  IF v_a IS NOT NULL THEN
    RAISE EXCEPTION '373: anon can execute % — signup is open, so anon means the internet', v_a;
  END IF;

  SELECT string_agg(sig, ', ') INTO v_b FROM (
    SELECT s.sig FROM (VALUES
      ('public.verified_domain_tenant(text)'),
      ('public.claim_domain_verification_slot(uuid,uuid,text)'),
      ('public.record_domain_verification_attempt(uuid,uuid,text[],text)')
    ) AS s(sig)
    WHERE has_function_privilege('authenticated', s.sig, 'EXECUTE')
  ) q;
  IF v_b IS NOT NULL THEN
    RAISE EXCEPTION '373: authenticated can execute % — a tenant admin holds their own token and could self-verify without DNS', v_b;
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.claim_tenant_domain(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.list_tenant_domains()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.remove_tenant_domain(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION '373: the human RPCs are not reachable by logged-in admins — the feature is unusable';
  END IF;

  -- K. RLS is on and no write policy exists on the table itself.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_domains'::regclass) THEN
    RAISE EXCEPTION '373: RLS is not enabled on tenant_domains';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'tenant_domains'
                AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION '373: a non-SELECT policy exists on tenant_domains — writes must go through the RPCs only';
  END IF;

  -- L. Clean up, then prove the cleanup. Probe rows referencing real tenants
  --    must not outlive this block.
  DELETE FROM tenant_domains WHERE domain LIKE 'dt-mig373-probe%';
  SELECT count(*) INTO v_left FROM tenant_domains WHERE domain LIKE 'dt-mig373-probe%';
  IF v_left <> 0 THEN
    RAISE EXCEPTION '373: % probe rows survived the assertion block', v_left;
  END IF;

  RAISE NOTICE '373: one workspace per verified domain enforced by index; public providers rejected by CHECK; unverified grants nothing; verification is service-role only';
END $assert$;

NOTIFY pgrst, 'reload schema';
