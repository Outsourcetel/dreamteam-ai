-- ============================================================================
-- 715 — THE RATCHET: stop new tables arriving with write grants for
--       `authenticated`. docs/52 §6.
--
-- Mig 714 cleaned 245 tables. Without this, table 295 is born holding TRUNCATE
-- again and 714 decays silently — the "one-time revoke that un-does itself".
--
-- THIS IS NOT INFERENCE. Before this migration ran, inside a transaction that
-- was rolled back:
--
--     begin;
--       create table public._mutant_default_acl_check (id int);
--       select privilege_type from information_schema.role_table_grants
--        where table_schema='public' and table_name='_mutant_default_acl_check'
--          and grantee='authenticated';
--     rollback;
--
--   → DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- A brand-new table, created by `postgres` (which is how every migration in
-- this repo is applied, through the Management API), was born truncatable by
-- the internet-facing role. docs/52 §6b deferred that check to the applying
-- agent because it is a DDL write; it has now been run, and the regrowth is
-- OBSERVED rather than read off `pg_default_acl`. The same statement is run
-- again after this migration and must come back without the write privileges —
-- that is the second half of the mutation case, recorded in
-- scripts/certify-mutation-test.mjs.
--
-- PRECEDENT. `anon` already reads `rxtm` in this same catalogue row — somebody
-- did this exercise for `anon` and stopped there. That is exactly the shape of
-- `security_anon_guard_hole`: an anon-only fix is theatre, because
-- `authenticated` is what anyone who can sign up receives.
--
-- ⚠ THE COST, which the founder accepted. After this, a new table the browser
-- writes directly needs an explicit
--     grant insert, update, delete on public.<t> to authenticated;
-- in its own migration. That is roughly the 38-table keep-set's worth of
-- tables, one line each, paid so that write access is never the default.
--
-- ROLLBACK — restores the Supabase factory setting exactly:
--   alter default privileges for role postgres in schema public
--     grant truncate, insert, update, delete on tables to authenticated;
-- (The `supabase_admin` half below is a no-op to roll back; see §2.)
-- ============================================================================

-- ── 1. The `postgres` grantor — the one that fires on every migration ───────
alter default privileges for role postgres in schema public
  revoke truncate, insert, update, delete on tables from authenticated;

-- ── 2. The `supabase_admin` grantor — ATTEMPTED, AND IT CANNOT BE DONE HERE ─
-- docs/52 §6a says "ALTER DEFAULT PRIVILEGES must name the grantor role — it is
-- not global, and this is where a partial fix hides: doing only `postgres`
-- leaves the `supabase_admin` path open." That is correct, and the fix is not
-- available to us:
--
--   `postgres` on Supabase is NOT a superuser and is NOT a member of
--   `supabase_admin` (checked: pg_auth_members lists postgres in anon,
--   authenticated, authenticator, service_role, supabase_privileged_role,
--   pg_monitor, pg_read_all_data, pg_signal_backend, pg_create_subscription,
--   approval_brief_writer, trust_pattern_proposer — not supabase_admin), so the
--   statement fails with 42501 "permission denied to change default privileges".
--   Verified by running it in a rolled-back transaction before writing this.
--
-- The attempt is kept, rather than deleted with a comment, so that it applies
-- on any environment where the role IS reachable. The handler is narrow — only
-- insufficient_privilege — because a swallowed exception is the "gate that
-- cannot fail" this repo has already paid for; any other error must still
-- abort the migration.
--
-- HOW BIG IS THE RESIDUE? Measured, not assumed:
--   · All 299 relations in `public` (294 tables + 5 views) are owned by
--     `postgres`. Not one was created by `supabase_admin`. The grantor path
--     this row governs has never fired for any object that exists.
--   · The compensating control is Arm 2 of the `authenticated-write-perimeter`
--     probe (mig 716 / scripts/write-perimeter.mjs). It is a hard rule over
--     LIVE GRANTS, not over pg_default_acl — so a table that arrives carrying
--     TRUNCATE by any route, including this one, turns certify RED regardless
--     of which default-ACL row produced it. The probe's third arm additionally
--     watches both grantor rows directly and prints them on every run.
-- This is reported to the founder as the one part of the approved scope that
-- could not be applied.
do $$
begin
  alter default privileges for role supabase_admin in schema public
    revoke truncate, insert, update, delete on tables from authenticated;
  raise notice 'RATCHET: supabase_admin default privileges tightened.';
exception when insufficient_privilege then
  raise notice 'RATCHET: supabase_admin default privileges NOT changed — 42501, postgres is not a member of supabase_admin and Supabase grants no superuser. Residue is covered by the authenticated-write-perimeter probe (hard TRUNCATE arm over live grants). See migration header.';
end $$;

-- ── 3. Assert the half we could do actually landed ─────────────────────────
-- ALTER DEFAULT PRIVILEGES reports nothing and succeeds whether or not it
-- changed anything. The catalogue is the only witness.
do $$
declare
  pg_acl    text;
  anon_acl  text;
begin
  -- ⚠ LEFT NULL WHEN ABSENT, deliberately. The first draft coalesced to a
  -- human-readable placeholder and the dev rehearsal failed on it — because
  -- the string "(no authenticated entry)" itself contains a `d`, and the
  -- letter test below matched its own placeholder. A sentinel that lives in
  -- the same alphabet as the thing being tested is not a sentinel.
  select substring(a.item from '^authenticated=([^/]*)')
    into pg_acl
    from pg_default_acl d, unnest(d.defaclacl::text[]) as a(item)
   where d.defaclrole = 'postgres'::regrole
     and d.defaclnamespace = 'public'::regnamespace
     and d.defaclobjtype = 'r'
     and a.item like 'authenticated=%';

  select substring(a.item from '^anon=([^/]*)')
    into anon_acl
    from pg_default_acl d, unnest(d.defaclacl::text[]) as a(item)
   where d.defaclrole = 'postgres'::regrole
     and d.defaclnamespace = 'public'::regnamespace
     and d.defaclobjtype = 'r'
     and a.item like 'anon=%';

  -- aclitem letters (PG17): a=INSERT r=SELECT w=UPDATE d=DELETE D=TRUNCATE
  -- x=REFERENCES t=TRIGGER m=MAINTAIN. None of a/w/d/D may remain.
  -- NULL = no default-privilege entry for the role at all, which is the same
  -- end state or stronger (a new table grants it nothing). That is a PASS.
  if pg_acl is not null and pg_acl ~ '[awdD]' then
    raise exception 'RATCHET FAILED: postgres/public default ACL still grants write to authenticated (%). Expected no a/w/d/D.', pg_acl;
  end if;

  -- Match the precedent exactly. If `anon` ever reads something else, the
  -- thing this migration was measured against has moved and the comparison
  -- in the header is stale.
  raise notice 'RATCHET: postgres/public default ACL — authenticated=[%], anon=[%] (anon is the precedent; NULL means no entry at all, which is stronger).',
    coalesce(pg_acl, 'NULL'), coalesce(anon_acl, 'NULL');
end $$;
