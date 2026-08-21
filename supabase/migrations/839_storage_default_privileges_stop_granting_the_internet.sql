-- 839_storage_default_privileges_stop_granting_the_internet.sql
-- ============================================================================
-- Register item A-1, THE HALF OF IT THAT IS ACTUALLY REACHABLE FROM HERE.
--
-- A-1 says two things and they have different answers. Both were driven on
-- PRODUCTION on 2026-08-21 inside a transaction that rolled back — top level,
-- not reasoned, because this is exactly the class of statement that returns
-- SUCCESS and changes nothing:
--
--   (a) `storage.objects` and `storage.buckets` grant anon and authenticated
--       arwdDxtm — INCLUDING TRUNCATE, which RLS does not police.
--       ⚠ BLOCKED. Both tables are owned by `supabase_storage_admin`, a third
--       role that is neither `postgres` nor `supabase_admin`, and every one of
--       those grants has grantor `supabase_storage_admin`. Measured:
--
--         revoke truncate, delete, insert, update on storage.objects
--           from anon, authenticated;                    -> RETURNED SUCCESS
--         revoke truncate, delete, insert, update on storage.buckets
--           from anon, authenticated;                    -> RETURNED SUCCESS
--         has_table_privilege('anon','storage.objects','TRUNCATE')  -> STILL t
--         has_table_privilege('authenticated','storage.objects','TRUNCATE')
--                                                                   -> STILL t
--         relacl afterwards -> BYTE-IDENTICAL to before.
--
--       PostgreSQL does not RAISE when the revoker is not the grantor; it warns,
--       and the Management API discards warnings. `postgres` here holds
--       a*r*w*d*D*x*t*m* — WITH grant option — so it is not even the pg_net
--       shape where the revoker holds nothing; select_best_grantor picks
--       `postgres` as the grantor, finds no aclitem with grantee=anon and
--       grantor=postgres, and removes nothing. The walls that DO speak:
--
--         alter table storage.objects owner to postgres
--                                     -> 42501 must be owner of table objects
--         set role supabase_storage_admin
--                 -> 42501 permission denied to set role supabase_storage_admin
--
--       postgres is not a superuser and is a member of anon, authenticated,
--       authenticator, service_role, supabase_privileged_role, pg_monitor,
--       pg_read_all_data, pg_signal_backend, pg_create_subscription,
--       approval_brief_writer and trust_pattern_proposer — not supabase_admin
--       and not supabase_storage_admin.
--
--       ⚠⚠ SO THOSE REVOKES ARE NOT IN THIS FILE. A migration containing them
--       would apply cleanly, enter the ledger, and close A-1 having done
--       nothing at all — which is worse than the hole, because it stops anyone
--       looking again. The escalation is written up instead, for a role that
--       can actually run it: docs/72-supabase-privilege-escalations.md.
--
--   (b) the `storage` DEFAULT ACL hands anon and authenticated everything on
--       every object born there. ⚠ FIXABLE, AND THAT IS WHAT THIS MIGRATION
--       DOES. Unlike `public` — where the arwdDxtm row that mig 715 could not
--       move has grantor `supabase_admin` (register item A-2, re-proven today:
--       `alter default privileges for role supabase_admin in schema public`
--       still returns 42501) — schema `storage` has NO supabase_admin row at
--       all. All three of its rows carry grantor **postgres**, and a role may
--       always alter its own default privileges. Driven, and the catalogue
--       moved:
--
--         alter default privileges for role postgres in schema storage
--           revoke truncate, insert, update, delete on tables
--           from anon, authenticated;                    -> and afterwards
--         r: anon=arwdDxtm -> anon=rxtm, authenticated=arwdDxtm -> rxtm
--         f: anon=X, authenticated=X            -> entries GONE
--         S: anon=rwU, authenticated=rwU        -> entries GONE
--
-- ── ⚠ SEVERITY STATED HONESTLY: THIS HALF IS LATENT, NOT LIVE ─────────────
-- A default privilege fires for the role that CREATES the object. This row is
-- `for role postgres`, so it governs objects `postgres` creates in schema
-- `storage` — and postgres cannot create one:
--
--   create table storage._acl_probe (id int)
--                              -> 42501 permission denied for schema storage
--
-- The schema ACL is {supabase_admin=UC, postgres=U*, anon=U, authenticated=U,
-- service_role=U, supabase_storage_admin=U*C*, dashboard_user=UC} — postgres
-- holds USAGE, never CREATE. Every one of the eight relations in `storage`
-- today is owned by supabase_storage_admin, and no migration in this repo
-- creates anything there (they insert bucket rows and define RLS policies on
-- storage.objects, nothing more). So this row has never fired and cannot fire
-- while the schema ACL stays as it is.
--
-- It is shipped anyway, and the reason is not tidiness. The row is a LOADED
-- DEFAULT: the day anything grants postgres CREATE on schema `storage` — a
-- Supabase platform change, a support action, a dashboard_user script — every
-- object born there arrives TRUNCATE-able by the anonymous internet, with no
-- statement anywhere saying so. Mig 715 shipped the identical fix for `public`
-- and there the row was live. Here the fix is a fuse pulled before the current
-- arrives. certify's `storage-write-perimeter` arm watches both this row and
-- the live grants, so a regrowth by either route is caught.
--
-- ── WHAT THIS CANNOT BREAK, AND WHY THAT IS MEASURED RATHER THAN ASSERTED ──
-- Uploads matter: `playbook-media` and `specialist-media` are both PRIVATE
-- buckets and every file upload in the product goes through storage.objects.
--   · A default privilege never touches an existing object. Section 3 proves
--     it for the two tables that carry the traffic by capturing their relacl
--     BEFORE and comparing it AFTER, in this transaction, and raising on any
--     difference — so if this migration ever does move a live grant, it aborts
--     rather than reporting success.
--   · Section 3 does the same for what `postgres` and `service_role` hold in
--     the default-ACL rows themselves. An over-broad revoke that took the
--     service role's entry with it would be caught by the migration that made
--     it, not by the first failed upload.
--   · Outside the transaction, a real upload / download / list / signed-URL
--     round-trip against the private `playbook-media` bucket was driven before
--     and after this migration, together with the two refusals that prove the
--     bucket is still private. Recorded in docs/72.
--
-- ── ROLLBACK, restoring the Supabase factory setting exactly ──────────────
--   alter default privileges for role postgres in schema storage
--     grant all on tables to anon, authenticated;
--   alter default privileges for role postgres in schema storage
--     grant execute on functions to anon, authenticated;
--   alter default privileges for role postgres in schema storage
--     grant usage, select, update on sequences to anon, authenticated;
-- ============================================================================

begin;

-- ── 0. Capture the BEFORE state, inside this transaction ──────────────────
-- Everything section 3 asserts is a DELTA against these rows. A delta is the
-- only assertion shape that is both fail-able and replayable: it says "this
-- migration must not have removed X", which is vacuously true wherever X was
-- never there, and still catches the over-broad revoke everywhere it matters.
create temp table _m839_before on commit drop as
select 'relacl:' || c.relname as k, coalesce(c.relacl::text, '(null)') as v
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'storage'
   and c.relname in ('objects', 'buckets')
union all
select 'defacl:' || d.defaclobjtype::text || ':' || split_part(a.item, '=', 1),
       a.item
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace,
       unnest(coalesce(d.defaclacl::text[], array[]::text[])) as a(item)
 where n.nspname = 'storage'
   and d.defaclrole = 'postgres'::regrole
   and split_part(a.item, '=', 1) in ('postgres', 'service_role');

-- ── 1. The ratchet ────────────────────────────────────────────────────────
-- ALL, not just the write letters. mig 715 kept SELECT on `public` tables
-- because the browser reads `public` through PostgREST. `storage` is NOT in
-- PostgREST's exposed-schema list (public and graphql_public only — proven
-- from outside with the publishable key, see certify's net-not-exposed arm),
-- and the storage service reaches storage.objects as `authenticated` through
-- the grants supabase_storage_admin made, not through this row. There is no
-- consumer of a postgres-created object in schema `storage` that is anon or
-- authenticated, so the correct default is nothing at all.
alter default privileges for role postgres in schema storage
  revoke all on tables from anon, authenticated;

alter default privileges for role postgres in schema storage
  revoke all on functions from anon, authenticated;

alter default privileges for role postgres in schema storage
  revoke all on sequences from anon, authenticated;

-- PUBLIC currently holds no entry in any of the three rows — Supabase's
-- bootstrap already dropped the built-in `=X` default for functions. This is
-- therefore a NO-OP TODAY, stated out loud rather than left implicit, and it
-- is here so that the end state is declared by this migration rather than
-- inherited from a bootstrap that could change. Section 2 is what proves it.
alter default privileges for role postgres in schema storage
  revoke all on tables from public;
alter default privileges for role postgres in schema storage
  revoke all on functions from public;
alter default privileges for role postgres in schema storage
  revoke all on sequences from public;

-- ── 2. Assert the ratchet LANDED ──────────────────────────────────────────
-- ALTER DEFAULT PRIVILEGES reports nothing and succeeds whether or not it
-- changed anything — the same property that makes (a) above undetectable from
-- the statement's return. The catalogue is the only witness.
--
-- Absence-of-violation shape: a row that does not exist yields no items and
-- passes, which is the correct verdict for an environment Supabase never
-- bootstrapped. An entry for anon, authenticated or PUBLIC — with any letter
-- at all — is the violation.
do $$
declare
  offending text;
begin
  select string_agg(d.defaclobjtype::text || ' -> ' || a.item, ', ' order by d.defaclobjtype::text || a.item)
    into offending
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace,
         unnest(coalesce(d.defaclacl::text[], array[]::text[])) as a(item)
   where n.nspname = 'storage'
     and d.defaclrole = 'postgres'::regrole
     and split_part(a.item, '=', 1) in ('anon', 'authenticated', '');

  if offending is not null then
    raise exception 'STORAGE DEFAULT-ACL RATCHET FAILED: the postgres-grantor rows in schema storage still grant anon/authenticated/PUBLIC: %. Every object postgres creates in that schema would be born with those rights, TRUNCATE included, and RLS does not police TRUNCATE.', offending;
  end if;

  raise notice 'STORAGE RATCHET: postgres/storage default ACL now reads %',
    coalesce((select string_agg(d.defaclobjtype::text || '=' || d.defaclacl::text, ' | ' order by d.defaclobjtype::text)
                from pg_default_acl d
                join pg_namespace n on n.oid = d.defaclnamespace
               where n.nspname = 'storage' and d.defaclrole = 'postgres'::regrole),
             '(no rows at all — stronger still)');
end $$;

-- ── 3. Assert this migration broke NOTHING ────────────────────────────────
-- The failure mode that matters here is not "the revoke did not work", it is
-- "the revoke worked on more than it was aimed at". storage.objects is how
-- every file upload in the product reaches the database; a grant lost there,
-- or a default-ACL entry lost for postgres or service_role, is an outage.
do $$
declare
  drifted text;
begin
  -- 3a. The two live tables must be BYTE-IDENTICAL. A default privilege
  --     cannot touch an existing object — this is the proof, not the claim.
  select string_agg(b.k || ': was ' || b.v || ' | now ' || coalesce(c.relacl::text, '(null)'), '; ')
    into drifted
    from _m839_before b
    join pg_class c on c.relname = split_part(b.k, ':', 2)
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'storage'
   where b.k like 'relacl:%'
     and coalesce(c.relacl::text, '(null)') is distinct from b.v;

  if drifted is not null then
    raise exception 'MIGRATION 839 MOVED A LIVE STORAGE GRANT, which it must never do: %. Nothing here targets an existing object; abort rather than report success.', drifted;
  end if;

  -- 3b. Nothing postgres or service_role held in the default-ACL rows may
  --     have been taken with it.
  select string_agg(b.k || ' (' || b.v || ')', ', ')
    into drifted
    from _m839_before b
   where b.k like 'defacl:%'
     and not exists (
       select 1
         from pg_default_acl d
         join pg_namespace n on n.oid = d.defaclnamespace,
              unnest(coalesce(d.defaclacl::text[], array[]::text[])) as a(item)
        where n.nspname = 'storage'
          and d.defaclrole = 'postgres'::regrole
          and a.item = b.v);

  if drifted is not null then
    raise exception 'MIGRATION 839 REVOKED TOO WIDELY: the postgres/service_role default-ACL entries % are gone. The storage service and every migration in this repo run as one of those roles.', drifted;
  end if;

  raise notice 'STORAGE RATCHET: live grants on storage.objects/buckets unchanged; postgres and service_role default entries intact.';
end $$;

commit;
