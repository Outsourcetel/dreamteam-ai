-- ═══════════════════════════════════════════════════════════════
-- 184 — Demo-tenant provisioning helper
--
-- get_user_id_by_email lets the authorized provisioning edge function
-- (demo-provision, service-role) make user creation IDEMPOTENT: if the
-- auth user already exists, reuse it instead of erroring or duplicating.
-- Service-role only; exposes nothing beyond the id for a known email.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.get_user_id_by_email(p_email text)
returns uuid
language sql security definer set search_path to 'public', 'auth' stable as $function$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$function$;
revoke all on function public.get_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.get_user_id_by_email(text) to service_role;
