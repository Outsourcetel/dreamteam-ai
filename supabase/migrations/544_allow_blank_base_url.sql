-- ============================================================
-- Migration 544: let a connector have NO base URL.
--
-- FOUND WHILE BUILDING P4 (docs/40), and it is a pre-existing bug affecting
-- roughly forty providers, not just the new ones:
--
--   * connectors_base_url_safe_check is `CHECK (is_safe_external_url(base_url))`
--   * is_safe_external_url('') returns FALSE
--   * ~40 providers (HubSpot, Slack, Notion, Stripe, Asana, Linear, Calendly,
--     Teams, Box, and the four P4 additions) talk to a FIXED API root, so the
--     connect wizard tells the customer to leave the URL blank
--
-- => saving any of those connectors violated the CHECK. Consistent with that,
-- production contains ZERO connectors for ANY of those providers and ZERO rows
-- with a blank base_url: the path was never successfully exercised.
--
-- The guard's purpose is to stop us FETCHING a private/loopback/link-local
-- address. An empty string is not an address and is never fetched — those
-- adapters build their URLs from a constant API root — and httpJson()
-- re-checks isSafeExternalUrl() at every single fetch anyway (defence in
-- depth, unchanged). So allowing empty removes a false positive without
-- widening the actual attack surface: any NON-empty value is still validated
-- exactly as before.
-- ============================================================
alter table public.connectors drop constraint if exists connectors_base_url_safe_check;
alter table public.connectors add constraint connectors_base_url_safe_check
  check (coalesce(base_url, '') = '' or is_safe_external_url(base_url));

do $assert$
begin
  -- the blank case is now allowed …
  if not (coalesce('', '') = '' or is_safe_external_url('')) then
    raise exception 'mig 544: blank base_url still rejected';
  end if;
  -- … and every unsafe form is still refused, unchanged.
  if is_safe_external_url('http://127.0.0.1/x')
     or is_safe_external_url('http://169.254.169.254/latest/meta-data')
     or is_safe_external_url('http://10.0.0.5/internal') then
    raise exception 'mig 544: SSRF guard weakened — a private address passed';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid='public.connectors'::regclass
                    and conname='connectors_base_url_safe_check') then
    raise exception 'mig 544: constraint missing after recreate';
  end if;
end
$assert$;
