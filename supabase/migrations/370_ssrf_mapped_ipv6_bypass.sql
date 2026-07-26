-- 370_ssrf_mapped_ipv6_bypass.sql
-- ============================================================================
-- The SSRF guard can be walked straight past, and it is the SHARED guard.
--
-- REPRODUCED, not theorised. The WHATWG URL serializer rewrites an IPv4-mapped
-- IPv6 literal to HEX. Both this function and its TypeScript mirror
-- (supabase/functions/_shared/urlSafety.ts) only un-map a trailing DOTTED QUAD,
-- so the form that actually arrives was never inspected:
--
--   http://[::ffff:169.254.169.254]/  ->  http://[::ffff:a9fe:a9fe]/   ALLOWED
--   http://[::ffff:127.0.0.1]/        ->  http://[::ffff:7f00:1]/      ALLOWED
--   http://[::ffff:10.1.2.3]/         ->  http://[::ffff:a01:203]/     ALLOWED
--   http://[::ffff:192.168.1.1]/      ->  http://[::ffff:c0a8:101]/    ALLOWED
--
-- The first of those is AWS/GCP instance metadata — credentials.
--
-- WHY THE NORMALISED FORM IS THE ONE THAT MATTERS: callers do not hand this
-- function the string a user typed. Redirect following computes
-- `new URL(loc, current).toString()` and validates THAT. So the hex form is not
-- an exotic input, it is the normal one.
--
-- A second, smaller hole in the same family: a bare-integer host
-- (http://2130706433/ == 127.0.0.1) passed the RAW check and was only caught if
-- something normalised it first. Handled here too rather than left to luck.
--
-- Verified before applying: 22 connectors exist, 0 have a base_url that this
-- tightening would newly reject, so no existing row becomes un-updatable.
-- (Postgres does not re-validate existing rows when a CHECK's function changes;
-- the risk would be a LATER update to an offending row failing. There are none.)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_safe_external_url(p_url text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $function$
DECLARE
  v_rest text; v_host text; v_m text[]; v_hi bigint; v_lo bigint; v_n numeric;
BEGIN
  IF p_url IS NULL OR btrim(p_url) = '' THEN RETURN false; END IF;
  IF p_url !~* '^https?://[^/]' THEN RETURN false; END IF;

  v_rest := regexp_replace(p_url, '^https?://', '', 'i');
  IF position('@' IN split_part(v_rest, '/', 1)) > 0 THEN
    v_rest := regexp_replace(v_rest, '^[^/@]*@', '');
  END IF;
  v_host := lower(split_part(v_rest, '/', 1));
  v_host := split_part(v_host, '?', 1);
  v_host := split_part(v_host, '#', 1);

  -- IPv6 literals are bracketed and may carry a :port AFTER the bracket.
  IF left(v_host, 1) = '[' THEN
    v_host := split_part(substring(v_host FROM 2), ']', 1);
  ELSE
    v_host := split_part(v_host, ':', 1);
  END IF;
  IF v_host = '' THEN RETURN false; END IF;

  -- Dotted-quad mapped form (what a human types).
  v_m := regexp_match(v_host, ':(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$');
  IF v_m IS NOT NULL THEN v_host := v_m[1]; END IF;

  -- ── THE FIX: hex mapped form (what the URL serializer produces) ──────────
  v_m := regexp_match(v_host, '^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$');
  IF v_m IS NOT NULL THEN
    v_hi := ('x' || lpad(v_m[1], 4, '0'))::bit(16)::int;
    v_lo := ('x' || lpad(v_m[2], 4, '0'))::bit(16)::int;
    v_host := format('%s.%s.%s.%s', (v_hi >> 8) & 255, v_hi & 255,
                                    (v_lo >> 8) & 255, v_lo & 255);
  END IF;

  -- Any other mapped/compatible shape we cannot confidently decode is refused.
  -- An address we cannot read is not an address we can vouch for.
  IF v_host LIKE '::ffff:%' OR v_host ~ '^::\d' THEN RETURN false; END IF;

  -- Bare-integer IPv4 (http://2130706433/ == 127.0.0.1).
  IF v_host ~ '^\d+$' THEN
    v_n := v_host::numeric;
    IF v_n > 4294967295 THEN RETURN false; END IF;
    v_host := format('%s.%s.%s.%s',
      floor(v_n / 16777216) % 256, floor(v_n / 65536) % 256,
      floor(v_n / 256) % 256, v_n % 256);
  END IF;
  IF v_host ~ '^0[0-7]*\.' THEN RETURN false; END IF;  -- octal first octet

  -- ── Hostname denylist. The generic ".internal" suffix is deliberately NOT
  -- blocked: the self-management provider uses a "dreamteam.internal" marker
  -- base_url (mig 142) and blocking it would fail this CHECK on any update to
  -- that row. The specific cloud-metadata names are blocked by exact name, plus
  -- 169.254.169.254 by IP, so the primary target is covered. A generic
  -- "*.internal" GCP-VM host is the accepted residual, same as mig 154.
  IF v_host IN ('localhost', 'localhost.localdomain') THEN RETURN false; END IF;
  IF v_host IN ('metadata', 'metadata.google.internal') THEN RETURN false; END IF;
  IF v_host ~ '\.(local|localhost|localdomain)$' THEN RETURN false; END IF;

  -- ── IPv4 private / loopback / link-local ──
  IF v_host ~ '^127\.' THEN RETURN false; END IF;
  IF v_host = '0.0.0.0' OR v_host ~ '^0\.' THEN RETURN false; END IF;
  IF v_host ~ '^10\.' THEN RETURN false; END IF;
  IF v_host ~ '^172\.(1[6-9]|2[0-9]|3[0-1])\.' THEN RETURN false; END IF;
  IF v_host ~ '^192\.168\.' THEN RETURN false; END IF;
  IF v_host ~ '^169\.254\.' THEN RETURN false; END IF;
  IF v_host ~ '^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.' THEN RETURN false; END IF;

  -- ── IPv6 loopback / link-local / unique-local ──
  IF v_host IN ('::1', '0:0:0:0:0:0:0:1', '::') THEN RETURN false; END IF;
  IF v_host ~ '^fe80' THEN RETURN false; END IF;
  IF v_host ~ '^f[cd][0-9a-f][0-9a-f]:' THEN RETURN false; END IF;

  RETURN true;
END $function$;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_blocked text[] := ARRAY[
    'http://[::ffff:a9fe:a9fe]/latest/meta-data/',   -- the bypass, hex form
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a01:203]/',
    'http://[::ffff:c0a8:101]/',
    'http://[::ffff:169.254.169.254]/',              -- dotted form
    'http://169.254.169.254/',
    'http://2130706433/',                            -- bare integer = 127.0.0.1
    'http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/',
    'http://[::1]/', 'http://localhost/', 'http://metadata.google.internal/',
    'http://[fe80::1]/', 'http://[fc00::1]/'
  ];
  v_allowed text[] := ARRAY[
    'https://example.com/', 'https://acme.com/help',
    'http://93.184.216.34/', 'https://sub.domain.co.uk/a?b=1',
    'https://dreamteam.internal/'   -- mig 142 marker MUST keep working
  ];
  u text;
BEGIN
  FOREACH u IN ARRAY v_blocked LOOP
    IF public.is_safe_external_url(u) THEN
      RAISE EXCEPTION '370: STILL ALLOWED (SSRF): %', u;
    END IF;
  END LOOP;

  FOREACH u IN ARRAY v_allowed LOOP
    IF NOT public.is_safe_external_url(u) THEN
      RAISE EXCEPTION '370: legitimate URL now blocked — over-tightened: %', u;
    END IF;
  END LOOP;

  -- No existing connector may become un-updatable by this change.
  IF EXISTS (SELECT 1 FROM connectors WHERE NOT public.is_safe_external_url(base_url)) THEN
    RAISE EXCEPTION '370: an existing connector base_url now fails the check';
  END IF;

  RAISE NOTICE '370: mapped-IPv6 and bare-integer SSRF bypasses closed; % blocked, % allowed',
    array_length(v_blocked, 1), array_length(v_allowed, 1);
END $assert$;

NOTIFY pgrst, 'reload schema';
