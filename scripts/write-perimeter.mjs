// ============================================================================
// write-perimeter.mjs — Ring-0: the WRITE surface of `authenticated`.
//
// certify has pinned the EXECUTE surface since migs 610/630 and has never been
// pointed at TABLES. docs/52 measured the gap: `authenticated` — the role every
// logged-in browser session runs as, which mig 365's note calls "the internet" —
// held TRUNCATE on 245 of 294 public base tables, and **PostgreSQL does not
// apply RLS to TRUNCATE**. Migs 714/715 closed it and stopped it regrowing.
// This is what keeps it closed.
//
// TWO ARMS, DELIBERATELY DIFFERENT IN KIND. That difference is the whole design:
//
//   ARM 1 — the PINNED surface (in certify.mjs, symmetric, re-pinnable).
//     supabase/baseline/write-allowlist.json, same --pin-allowlist flow as the
//     EXECUTE allowlist. Fails on a NEW grant *and* on a VANISHED one. The
//     vanished half is not decoration: it is the both-halves guard. Mig 643
//     nearly left 11 of 12 workspaces administrable by nobody, and a revoke
//     that removes more than intended is that same defect wearing the opposite
//     mask. With this arm it surfaces as `allowlisted grant VANISHED` on the
//     next certify run instead of as a support ticket three weeks later.
//
//   ARM 2 — TRUNCATE, a HARD RULE, NOT PINNABLE (below).
//     A pin can be re-pinned by the next person in a hurry, and a rule that can
//     be silenced by the thing it guards against is the "gate that had never
//     fired" this repo has already paid for. TRUNCATE for `authenticated` is
//     never legitimate — there is no supabase-js method, no PostgREST verb, and
//     no raw connection anywhere in the product that could issue one — so it
//     gets no allowlist and no exemption, ever.
//
//   ARM 3 — the DEFAULT PRIVILEGES that feed arm 2.
//     Arms 1 and 2 read what IS granted. This reads what will be granted NEXT.
//     It exists because mig 715 could fix only one of the two grantor rows:
//     `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` fails with 42501 —
//     `postgres` on Supabase is not a superuser and not a member of that role.
//     The `postgres` row is enforced (it is the one every migration in this
//     repo fires); the `supabase_admin` row is REPORTED on every run so the
//     residue stays named rather than silently carried. Arm 2 is what actually
//     catches a table arriving through it, because arm 2 reads live grants and
//     does not care which default-ACL row produced them.
//
// ⚠ AND THE DENOMINATOR. Zero findings from zero comparisons looks exactly like
// a clean result. The probe reports how many tables it examined on every run,
// and treats "examined nothing" as a VIOLATION rather than a pass — the failure
// mode that let a `\b` regex match nothing in this repo and read as green.
// ============================================================================

/**
 * Arms 2 + 3. Every source is substitutable so the mutation suite can drive the
 * REAL predicate over a synthesised row rather than a paraphrase of it — mig
 * 661 shipped a pin that could not fail because the check and the thing it
 * checked had drifted apart.
 *
 * @param {object} [opts]
 * @param {string} [opts.grantSource]  Relation yielding (tbl, sch, grantee, priv).
 *   Default: the live grant catalogue restricted to public BASE TABLES.
 * @param {string} [opts.tableSource]  Relation yielding one row per examined
 *   table, as (tbl). Drives the denominator; substitute an empty set to prove
 *   the no-comparisons arm fires.
 * @param {string} [opts.defaclSource] Relation yielding (grantor, letters) —
 *   the `authenticated=` aclitem letters per grantor row for public/tables.
 */
export function writePerimeterSql(opts = {}) {
  const {
    grantSource = `
      select g.table_name::text  as tbl,
             g.table_schema::text as sch,
             g.grantee::text      as grantee,
             g.privilege_type::text as priv
        from information_schema.role_table_grants g
       where exists (select 1 from pg_class c
                      where c.relname = g.table_name
                        and c.relnamespace = 'public'::regnamespace
                        and c.relkind = 'r')`,
    tableSource = `
      select c.relname::text as tbl
        from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'`,
    defaclSource = `
      select d.defaclrole::regrole::text as grantor,
             substring(a.item from '^authenticated=([^/]*)') as letters
        from pg_default_acl d, unnest(d.defaclacl::text[]) as a(item)
       where d.defaclnamespace = 'public'::regnamespace
         and d.defaclobjtype = 'r'
         and a.item like 'authenticated=%'`,
  } = opts;

  return `
with grants as (${grantSource}),
tbls as (${tableSource}),
defacl as (${defaclSource}),
counted as (
  select (select count(*) from tbls) as n_tables,
         (select count(*) from grants
           where sch = 'public' and grantee = 'authenticated'
             and priv in ('INSERT','UPDATE','DELETE')) as n_dml
)

-- ── ARM 2: TRUNCATE. No allowlist. No exemption. ────────────────────────────
select g.tbl || ': TRUNCATE granted to authenticated (RLS does not apply to '
       || 'TRUNCATE — one statement destroys every tenant''s rows in this '
       || 'table, without a policy ever being consulted). There is no '
       || 'supabase-js method, no PostgREST verb and no raw connection in this '
       || 'product that needs it. Revoke it; do not allowlist it.' as violation,
       null::text as note
  from grants g
 where g.sch = 'public' and g.grantee = 'authenticated' and g.priv = 'TRUNCATE'

union all

-- ── ARM 3a: the postgres grantor row — ENFORCED. ────────────────────────────
-- aclitem letters (PG17): a=INSERT r=SELECT w=UPDATE d=DELETE D=TRUNCATE
-- x=REFERENCES t=TRIGGER m=MAINTAIN.
select 'default privileges REGROWING — the postgres grantor row for '
       || 'public/tables grants authenticated "' || d.letters || '", which '
       || 'includes ' ||
       case when d.letters like '%D%' then 'TRUNCATE' else 'a write privilege' end
       || '. Every new table is born with it and mig 714''s cleanup decays one '
       || 'migration at a time. Re-apply mig 715.' as violation,
       null::text as note
  from defacl d
 where d.grantor = 'postgres' and d.letters ~ '[awdD]'

union all

-- ── ARM 3b: the supabase_admin grantor row — REPORTED, not enforced. ────────
-- Failing on this would make certify permanently RED for something no role
-- available to us can fix (42501), and a gate that cries wolf is a gate people
-- learn to ignore. It is surfaced on every run instead, so the residue is
-- named. Arm 2 is the control that actually catches a table arriving this way.
select null::text as violation,
       'authenticated-write-perimeter: NOTE — the supabase_admin grantor row '
       || 'still grants authenticated "' || d.letters || '" on new public '
       || 'tables. mig 715 could not change it (42501: postgres is not a '
       || 'superuser and not a member of supabase_admin). All public relations '
       || 'are currently owned by postgres, so this path has never fired; '
       || 'Arm 2 above catches it if it ever does.' as note
  from defacl d
 where d.grantor = 'supabase_admin' and d.letters ~ '[awdD]'

union all

-- ── THE DENOMINATOR — a violation when it is zero, a note otherwise. ────────
select case when c.n_tables = 0
            then 'no-comparisons: the write perimeter probe examined 0 public '
                 || 'base tables. It read nothing, and zero findings from zero '
                 || 'comparisons is indistinguishable from a clean result.'
       end as violation,
       case when c.n_tables > 0
            then 'authenticated-write-perimeter: examined ' || c.n_tables
                 || ' public base table(s); authenticated holds ' || c.n_dml
                 || ' INSERT/UPDATE/DELETE grant(s) and 0 TRUNCATE.'
       end as note
  from counted c
`;
}

/**
 * ARM 1's query — the surface that gets pinned to
 * supabase/baseline/write-allowlist.json and diffed symmetrically in
 * certify.mjs. Base tables only: TRUNCATE on a view is inert in Postgres, and
 * pinning inert grants would mean re-pinning for changes that cannot matter.
 */
export const WRITE_PERIMETER_SQL = `
  select g.table_name as tbl, g.privilege_type as priv
    from information_schema.role_table_grants g
    join pg_class c on c.relname = g.table_name
                   and c.relnamespace = 'public'::regnamespace
                   and c.relkind = 'r'
   where g.table_schema = 'public' and g.grantee = 'authenticated'
     and g.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
   order by 1, 2`;
