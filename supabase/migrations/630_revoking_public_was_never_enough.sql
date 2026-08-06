-- 630 — revoking PUBLIC was never enough.
--
-- ⚠⚠ THIS IS MY OWN DEFECT, SHIPPED TODAY, IN THE MIGRATIONS THAT ADDED THE
-- WORKFORCE CONTROLS. Every one of them ends with a line like:
--
--     revoke execute on function check_workforce_circuit_breaker() from public;
--     grant  execute on function check_workforce_circuit_breaker() to service_role;
--
-- I copied that from migration 610, which closed the hole where Postgres
-- implicitly grants EXECUTE to PUBLIC on every new function. It does close that
-- hole. It does NOT close this one, because THERE ARE TWO MECHANISMS and I only
-- knew about one:
--
--   pg_default_acl, schema public, object type FUNCTION:
--     grantor supabase_admin → postgres=X | anon=X | authenticated=X | service_role=X
--     grantor postgres       → postgres=X | anon=X | authenticated=X | service_role=X
--
-- Supabase installs DEFAULT PRIVILEGES that grant EXECUTE to `anon` and
-- `authenticated` EXPLICITLY, as named roles. `REVOKE ... FROM PUBLIC` removes
-- the PUBLIC pseudo-role grant and leaves both named grants untouched. So every
-- function I "locked down" today has been reachable with the anon key that
-- ships inside the web app — i.e. from the internet
-- ([[security_anon_guard_hole]] says exactly this about anon, and I still
-- walked into it from the other direction).
--
-- ⚠ THE FIVE THAT WERE ACTUALLY EXPOSED — SECURITY DEFINER (so RLS is bypassed),
-- reachable as an RPC, and with NO caller check of their own:
--
--   seed_approval_baseline(p_tenant_id)        WRITES. Takes an arbitrary
--       workspace id and inserts approval rules into it. Idempotent and every
--       workspace already has rules, so it is inert TODAY — by luck, not design.
--   check_workforce_circuit_breaker()          WRITES. No arguments, walks every
--       operational workspace, and pauses any that breaches its thresholds.
--   resolve_de_autonomy(p_tenant_id, …)        READS another workspace's
--   resolve_de_autonomy_chain(p_tenant_id, …)  autonomy configuration.
--   workforce_autonomy_paused(p_tenant_id)     READS another workspace's state.
--
-- The other five (derive_de_autonomy_dials, get_workforce_trust_metrics,
-- pause/resume_workforce_autonomy, set_de_autonomy) check `auth_tenant_id()`
-- and most also `auth_has_tenant_role`, so an anon call already failed. Their
-- anon grant is removed anyway: defence in depth is not a reason to leave a
-- door open, it is the reason the door being open did not cost anything.
--
-- ⚠ Nothing legitimate loses access. The edge functions that call
-- resolve_de_autonomy (de-answer, playbook-execute, widget-ask) use the ADMIN
-- client = service_role, which keeps its grant. The SQL callers are SECURITY
-- DEFINER functions owned by postgres, which also keeps its grant. The five
-- guarded ones keep `authenticated`, because the UI calls them.

begin;

-- ── 1. anon has no business calling any of these ────────────────────────
revoke execute on function check_workforce_circuit_breaker()                                    from anon;
revoke execute on function seed_approval_baseline(p_tenant_id uuid)                             from anon;
revoke execute on function workforce_autonomy_paused(p_tenant_id uuid)                          from anon;
revoke execute on function derive_de_autonomy_dials(p_de_id uuid)                               from anon;
revoke execute on function get_workforce_trust_metrics(p_tenant_id uuid, p_days integer)        from anon;
revoke execute on function pause_workforce_autonomy(p_reason text)                              from anon;
revoke execute on function resume_workforce_autonomy(p_note text)                               from anon;
revoke execute on function set_de_autonomy(p_action_type text, p_enabled boolean, p_max_amount_cents bigint,
                                           p_min_confidence integer, p_de_id uuid, p_source_category text,
                                           p_playbook_id uuid)                                  from anon;
revoke execute on function resolve_de_autonomy(p_tenant_id uuid, p_action_type text, p_de_id uuid,
                                               p_source_category text, p_playbook_id uuid)      from anon;
revoke execute on function resolve_de_autonomy_chain(p_tenant_id uuid, p_keys text[], p_de_id uuid,
                                                     p_source_category text, p_playbook_id uuid) from anon;

-- ── 2. And `authenticated` on the five that are internal-only ───────────
-- These are called by cron (service_role) and by other SECURITY DEFINER
-- functions (as postgres). No signed-in user ever calls them directly, and
-- `authenticated` means "anyone who can make an account"
-- ([[security_authenticated_perimeter]]).
revoke execute on function check_workforce_circuit_breaker()                                     from authenticated;
revoke execute on function seed_approval_baseline(p_tenant_id uuid)                              from authenticated;
revoke execute on function workforce_autonomy_paused(p_tenant_id uuid)                           from authenticated;
revoke execute on function resolve_de_autonomy(p_tenant_id uuid, p_action_type text, p_de_id uuid,
                                               p_source_category text, p_playbook_id uuid)       from authenticated;
revoke execute on function resolve_de_autonomy_chain(p_tenant_id uuid, p_keys text[], p_de_id uuid,
                                                     p_source_category text, p_playbook_id uuid) from authenticated;

-- ── 3. THE DURABLE FIX — stop the next function inheriting the same grant ──
-- Migrations run as `postgres`, so it is postgres's default privileges that
-- decide what a newly created function is granted. Default DENY; anything that
-- genuinely needs anon or authenticated now has to say so explicitly, which is
-- the posture docs/29 already requires everywhere else.
alter default privileges for role postgres in schema public revoke execute on functions from anon;
alter default privileges for role postgres in schema public revoke execute on functions from authenticated;

do $verify$
declare
  v_bad     int;
  v_acl     text;
  v_new_acl text;
begin
  -- 1. None of the ten may still be anon-reachable.
  select count(*) into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('check_workforce_circuit_breaker','seed_approval_baseline','workforce_autonomy_paused',
                      'derive_de_autonomy_dials','get_workforce_trust_metrics','pause_workforce_autonomy',
                      'resume_workforce_autonomy','set_de_autonomy','resolve_de_autonomy','resolve_de_autonomy_chain')
    and array_to_string(p.proacl::text[], ' ') like '%anon=X%';
  if v_bad > 0 then
    raise exception '% of the ten are still anon-callable', v_bad;
  end if;

  -- 2. service_role MUST survive, or the cron breaker and the edge functions
  --    that call resolve_de_autonomy stop working. Revoking too much is the
  --    obvious way to turn a security fix into an outage.
  select array_to_string(proacl::text[], ' ') into v_acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_de_autonomy';
  if v_acl not like '%service_role=X%' then
    raise exception 'resolve_de_autonomy lost service_role — the edge functions would break';
  end if;

  select array_to_string(proacl::text[], ' ') into v_acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'check_workforce_circuit_breaker';
  if v_acl not like '%service_role=X%' then
    raise exception 'the circuit breaker lost service_role — cron would stop guarding';
  end if;

  -- 3. The UI-facing five must KEEP authenticated.
  select count(*) into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('derive_de_autonomy_dials','get_workforce_trust_metrics',
                      'pause_workforce_autonomy','resume_workforce_autonomy','set_de_autonomy')
    and array_to_string(p.proacl::text[], ' ') not like '%authenticated=X%';
  if v_bad > 0 then
    raise exception '% UI-facing function(s) lost authenticated — the app would break', v_bad;
  end if;

  -- 4. ⚠ THE ONE THAT MATTERS MOST: prove the DEFAULT actually changed, by
  --    creating a function and reading its ACL. Asserting on pg_default_acl
  --    would only re-read what I just wrote; this tests the behaviour.
  execute 'create or replace function public.zz_default_grant_probe_630() returns int language sql as $q$ select 1 $q$';
  select coalesce(array_to_string(proacl::text[], ' '), '(null acl = PUBLIC)') into v_new_acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'zz_default_grant_probe_630';
  execute 'drop function public.zz_default_grant_probe_630()';

  if v_new_acl like '%anon=X%' then
    raise exception 'a NEW function is still granted to anon — the default privilege change did not take: %', v_new_acl;
  end if;
  if v_new_acl like '%authenticated=X%' then
    raise exception 'a NEW function is still granted to authenticated: %', v_new_acl;
  end if;

  raise notice 'ten functions closed to anon; new functions no longer inherit anon/authenticated (probe acl: %)', v_new_acl;
end;
$verify$;

commit;
