-- ============================================================================
-- Two hardening items with no behavioural surface: the last four unpinned
-- SECURITY DEFINER search_paths, and the one public table without RLS.
--
-- ⚠ STAGED, NOT NUMBERED. Written without production access, and
-- scripts/migration-next.mjs claims its number ON production ("NO PRODUCTION,
-- NO CLAIM"). To land it:
--
--     npm run migrate:next -- pin_the_last_four_search_paths_and_close_the_rls_gap
--     # move this body into the file that prints, commit, push, merge to main
--     node scripts/db-query.mjs --file supabase/migrations/<NNN>_<slug>.sql
--
-- ============================================================================
-- ITEM 1 — the last four unpinned search_paths
--
-- Measured against supabase/baseline/full_schema.sql, the production snapshot
-- regenerated 2026-08-21, by parsing every function header:
--
--     functions in snapshot: 882   SECURITY DEFINER: 791   UNPINNED: 4
--
-- 787 of 791 pin it. These four do not, and each relies on an UNQUALIFIED call
-- to is_platform_admin() / auth_tenant_id() / auth_has_tenant_role() as its
-- only authorization check. If `authenticated` can create objects in any schema
-- on the caller's search_path, shadowing that helper turns the function into an
-- authorization bypass.
--
-- ⚠ SEVERITY STATED HONESTLY. Reachability was NOT confirmed — that needs a live
--   select has_schema_privilege('authenticated','public','CREATE');
-- and this session had no database. If it returns false the hardening gap is
-- real but not currently exploitable. Either way 787 of 791 already do this and
-- these four are the outliers, which is reason enough.
--
-- ⚠ ONE AGENT REPORTED ONLY ONE OF THESE AS LIVE, saying the others were dropped
-- in migrations 615/749. The production snapshot says all four exist. The
-- snapshot wins: it is generated from the database rather than reasoned about.
--
-- WHY ALTER AND NOT CREATE OR REPLACE. Reproducing four bodies to change a
-- header is four chances to transcribe something wrong. ALTER FUNCTION … SET
-- changes only proconfig; the body is untouched and cannot drift.
--
-- WHY 'public' AND NOT 'public','extensions'. 686 of the pinned functions use
-- bare 'public' and 112 add 'extensions'. Checked each of these four for calls
-- that resolve out of the extensions schema (gen_random_uuid, digest, crypt,
-- vector ops, net.*): NONE of the four makes one. Bare 'public' matches both
-- the house default and what they actually need.
-- ============================================================================

begin;

alter function public.calculate_tenant_monthly_cost(uuid)                    set search_path to 'public';
alter function public.create_workforce_assistant_de(uuid, jsonb)             set search_path to 'public';
alter function public.increment_tenant_token_usage(uuid, text, integer)      set search_path to 'public';
alter function public.suggest_de_amendments(uuid, text)                      set search_path to 'public';

-- ============================================================================
-- ITEM 2 — migration_number_claims is the only public table without RLS
--
-- 759_the_claim_is_taken_where_the_race_is.sql:51 creates it and never enables
-- RLS. certify's `rls-on-every-public-table` arm has no exemption list, so it
-- has been naming this table on every credentialed run — it is one of the 23
-- findings in the committed review/certify-last.json.
--
-- ⚠ THIS IS A RATCHET VIOLATION, NOT AN EXPOSURE, and saying otherwise would be
-- inflating it. 759:70 does `revoke all … from public, anon, authenticated`, and
-- the production snapshot confirms only service_role holds grants
-- (full_schema.sql:57867-57868 revoke, :58446 grant). Nothing outside
-- service_role can read it today. This closes it at the second layer too, so
-- the table stops being a standing exception to a rule the gate enforces
-- absolutely — and so that a future GRANT cannot silently open it.
--
-- Deny-all by design: this table is service-role-only infrastructure, exactly
-- like the 30 other RLS-on-zero-policy tables in this schema.
--
-- ⚠⚠ ENABLE ONLY — **NOT** FORCE. THIS DRAFT HAD `FORCE` AND IT WOULD HAVE
-- BROKEN `npm run migrate:next` FOR EVERYONE.
--
-- FORCE makes the table OWNER subject to its own policies. With zero policies
-- that denies the owner every row. And scripts/migration-next.mjs does not use
-- service_role: it claims the number by POSTing to the Management API
-- (`/v1/projects/<ref>/database/query`, migration-next.mjs:100), which executes
-- as `postgres` — the owner. So FORCE here would have made the INSERT at :212
-- and the SELECT at :127 return nothing, and the one tool CLAUDE.md mandates for
-- claiming a migration number would have started failing on a table it cannot
-- see. The irony is exact: a migration that breaks the ability to write
-- migrations.
--
-- This is the opposite call from the FORCE work in scripts/backup-schema.mjs the
-- same day, and both are right. There, 27 tables ALREADY carry FORCE in
-- production and the snapshot was silently dropping it — the fix is to reproduce
-- what production has. Here, production has never had it, and adding it would
-- change behaviour rather than preserve it. FORCE is correct for a
-- tenant-scoped table read through SECURITY DEFINER routines; it is wrong for
-- infrastructure the owner must reach directly.
-- ============================================================================

alter table public.migration_number_claims enable row level security;

-- ── PROOF ───────────────────────────────────────────────────────────────────
-- Schema assertions only. They describe what THIS migration installed, so they
-- are true wherever it runs — no fixture needed and nothing to roll back. That
-- is the distinction the 111 unreplayable assertion sites in this tree missed:
-- asking the catalogue what the database now IS is always replayable; asking a
-- data table what production CONTAINS is not.
do $verify$
declare v_n int; v_forced boolean; v_enabled boolean;
begin
  -- (a) all four now pin a search_path
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('calculate_tenant_monthly_cost','create_workforce_assistant_de',
                       'increment_tenant_token_usage','suggest_de_amendments')
     and (p.proconfig is null or not exists (
           select 1 from unnest(p.proconfig) c where c like 'search\_path=%'));
  if v_n <> 0 then
    raise exception 'HARDEN FAILED: % of the four still have no pinned search_path', v_n;
  end if;

  -- (b) and NO SECURITY DEFINER function anywhere is left unpinned. Stated as
  -- the absence of a violation, so it holds on an empty database and still
  -- catches a regression introduced by any later migration.
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and (p.proconfig is null or not exists (
           select 1 from unnest(p.proconfig) c where c like 'search\_path=%'));
  if v_n <> 0 then
    raise exception 'HARDEN FAILED: % SECURITY DEFINER function(s) still unpinned', v_n;
  end if;

  -- (c) the RLS gap is closed — ENABLED, and deliberately NOT forced. The
  -- second half is asserted too, because a later well-meaning "harden it
  -- properly" commit adding FORCE would lock the migration tooling out of its
  -- own claim table, and this is the only place that reasoning is written down.
  select c.relrowsecurity, c.relforcerowsecurity into v_enabled, v_forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'migration_number_claims';
  if not coalesce(v_enabled, false) then
    raise exception 'HARDEN FAILED: RLS not enabled on migration_number_claims';
  end if;
  if coalesce(v_forced, false) then
    raise exception 'HARDEN FAILED: migration_number_claims is FORCEd — that denies the owner, '
      'and migration-next.mjs claims through the Management API as postgres. See the note above.';
  end if;

  -- (d) and no public table is left without it — the same absence-of-violation
  -- form, so this becomes a standing guard rather than a one-off check.
  select count(*) into v_n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_n <> 0 then
    raise exception 'HARDEN FAILED: % public table(s) still without RLS', v_n;
  end if;

  raise notice 'hardening: 0 unpinned SECDEF search_paths, 0 public tables without RLS';
end $verify$;

commit;
