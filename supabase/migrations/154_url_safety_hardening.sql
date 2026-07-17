-- ═══════════════════════════════════════════════════════════════
-- 154 — Harden public.is_safe_external_url() to match the hardened
-- Deno _shared/urlSafety.ts (this session). The DB function backs the
-- connectors.base_url CHECK constraint (mig 099); it had the same two
-- gaps the TS guard did:
--   • IPv6 literal with a port, e.g. http://[::1]:9000/ — the old
--     `^\[(.*)\]$` strip only matched a fully-bracketed authority and
--     let the :port form through as a multi-colon "IPv6" host.
--   • DNS names for internal targets — metadata.google.internal and
--     the .internal/.local families were not blocked (IP-literal only).
-- Also adds IPv4-mapped-IPv6 unwrapping and CGNAT 100.64/10.
--
-- SAFE TO REPLACE: CREATE OR REPLACE does not re-validate existing rows,
-- and the hardened rules only ever block MORE (never un-block). This
-- migration was applied only after confirming every existing
-- connectors.base_url still passes the new function (so no future UPDATE
-- to an existing connector can trip the CHECK).
-- ═══════════════════════════════════════════════════════════════

create or replace function public.is_safe_external_url(p_url text)
returns boolean
language plpgsql
immutable
as $function$
declare
  v_rest text;
  v_host text;
  v_m text[];
begin
  if p_url is null or btrim(p_url) = '' then
    return false;
  end if;
  if p_url !~* '^https?://[^/]' then
    return false;
  end if;

  v_rest := regexp_replace(p_url, '^https?://', '', 'i');
  if position('@' in split_part(v_rest, '/', 1)) > 0 then
    v_rest := regexp_replace(v_rest, '^[^/@]*@', '');
  end if;
  v_host := lower(split_part(v_rest, '/', 1));
  v_host := split_part(v_host, '?', 1);
  v_host := split_part(v_host, '#', 1);

  -- Host extraction: IPv6 literals are bracketed and may carry a :port
  -- AFTER the closing bracket. Pull the part between [ and ]; otherwise
  -- strip a trailing :port from an IPv4/hostname authority.
  if left(v_host, 1) = '[' then
    v_host := split_part(substring(v_host from 2), ']', 1);
  else
    v_host := split_part(v_host, ':', 1);
  end if;
  if v_host = '' then return false; end if;

  -- IPv4-mapped / -compatible IPv6 (::ffff:169.254.169.254, ::127.0.0.1):
  -- re-check the embedded dotted-quad under the IPv4 rules below.
  v_m := regexp_match(v_host, ':(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$');
  if v_m is not null then
    v_host := v_m[1];
  end if;

  -- Hostname denylist (non-IP internal names). NOTE: the generic
  -- ".internal" suffix is deliberately NOT blocked — the self-management
  -- provider uses a "dreamteam.internal" marker base_url (mig 142) and
  -- blocking it would fail this CHECK on any future update to that row.
  -- The specific cloud-metadata hostnames are still blocked by exact
  -- name (plus 169.254.169.254 by IP), so the primary SSRF target is
  -- covered; a generic "*.internal" GCP-VM host is the accepted residual.
  if v_host = 'localhost' or v_host = 'localhost.localdomain' then return false; end if;
  if v_host = 'metadata' or v_host = 'metadata.google.internal' then return false; end if;
  if v_host ~ '\.(local|localhost|localdomain)$' then return false; end if;

  -- IPv4 private / loopback / link-local / CGNAT.
  if v_host ~ '^127\.' then return false; end if;
  if v_host = '0.0.0.0' or v_host ~ '^0\.' then return false; end if;
  if v_host ~ '^10\.' then return false; end if;
  if v_host ~ '^172\.(1[6-9]|2[0-9]|3[0-1])\.' then return false; end if;
  if v_host ~ '^192\.168\.' then return false; end if;
  if v_host ~ '^169\.254\.' then return false; end if;
  if v_host ~ '^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.' then return false; end if;

  -- IPv6 loopback / link-local / unique-local.
  if v_host = '::1' or v_host = '0:0:0:0:0:0:0:1' or v_host = '::' then return false; end if;
  if v_host ~ '^fe80' then return false; end if;
  if v_host ~ '^f[cd][0-9a-f][0-9a-f]:' then return false; end if;

  return true;
end;
$function$;
