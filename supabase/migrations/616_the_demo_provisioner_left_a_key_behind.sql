-- 616 — the demo provisioner left a key behind.
--
-- `playbook-mine`, `demo-authcheck`, `demo-ingest` and `demo-provision` are
-- deleted (repo and project — all four were ACTIVE, i.e. reachable HTTP
-- endpoints; 62 -> 58 deployed functions).
--
-- Deleting a function orphans whatever existed only to serve it.
-- `read_demo_admin_password()` was called by exactly one thing, demo-provision:
--
--   CREATE FUNCTION read_demo_admin_password() RETURNS text
--     SECURITY DEFINER SET search_path TO 'vault','public'
--   AS $$ select decrypted_secret from vault.decrypted_secrets
--          where name = 'demo_admin_password' limit 1 $$;
--
-- A SECURITY DEFINER function that decrypts an admin password and hands it back
-- as text, with nothing left that calls it, is not ordinary dead code — it is a
-- credential-disclosure primitive waiting for someone to find a use for it.
--
-- ⚠ It is NOT a live exposure today: migration 610's sweep already cut it back
-- to postgres + service_role, so anon and authenticated cannot reach it. That is
-- the reason to remove it calmly now rather than urgently.
--
-- ⚠ AND THE SECRET IT READ DOES NOT EXIST. Checked while writing this: vault
-- holds NO `demo_admin_password` row. So the function had no caller AND nothing
-- to return — it would have handed back NULL. Nothing to decide about the
-- secret, because there is no secret; the assertion below records that rather
-- than assuming it.

begin;

-- Prove it is unreferenced BEFORE removing it. A "nothing calls this" claim
-- that turns out wrong deletes a live path — and the only caller here was an
-- edge function, which no SQL check can see, so this asserts the SQL half and
-- the report records the other.
do $verify$
declare v_callers int;
begin
  select count(*) into v_callers
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and p.proname <> 'read_demo_admin_password'
    and pg_get_functiondef(p.oid) ~ 'read_demo_admin_password';
  if v_callers > 0 then
    raise exception '% SQL function(s) still call read_demo_admin_password — refusing to drop', v_callers;
  end if;
end;
$verify$;

drop function if exists read_demo_admin_password();

do $verify$
declare
  v_left   int;
  v_secret int;
begin
  select count(*) into v_left from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'read_demo_admin_password';
  if v_left > 0 then
    raise exception 'read_demo_admin_password survived — a drop with the wrong signature is a SILENT no-op';
  end if;

  -- The demo GUARDS stay: they stop a real tenant being wired to a demo one and
  -- are unrelated to provisioning.
  select count(*) into v_left from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in
    ('guard_against_demo_tenant_assignment', 'guard_against_demo_tenant_parent');
  if v_left <> 2 then
    raise exception 'a demo GUARD was removed by mistake (% of 2 left)', v_left;
  end if;

  select count(*) into v_secret from vault.decrypted_secrets where name = 'demo_admin_password';
  if v_secret > 0 then
    raise notice 'credential reader dropped; both demo guards intact. ⚠ the vault secret demo_admin_password DOES exist (% row) — founder to decide whether it goes too', v_secret;
  else
    raise notice 'credential reader dropped; both demo guards intact; the secret it read does not exist, so nothing is left behind';
  end if;
end;
$verify$;

commit;
