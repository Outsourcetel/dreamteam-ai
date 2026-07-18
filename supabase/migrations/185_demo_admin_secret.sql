-- ═══════════════════════════════════════════════════════════════
-- 185 — read the shared demo-admin password from Vault (service-role)
--
-- So demo-provision never receives the password in a request body: it is
-- written to Vault ONCE (encrypted at rest), read here at provisioning
-- time, and deleted afterward. Service-role only; returns nothing for any
-- name other than the single demo secret.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.read_demo_admin_password()
returns text
language sql security definer set search_path to 'vault', 'public' stable as $function$
  select decrypted_secret from vault.decrypted_secrets where name = 'demo_admin_password' limit 1;
$function$;
revoke all on function public.read_demo_admin_password() from public, anon, authenticated;
grant execute on function public.read_demo_admin_password() to service_role;
