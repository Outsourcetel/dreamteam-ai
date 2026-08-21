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

// ============================================================================
// A SEPARATE PROBE, A SEPARATE CLASS: write-grants-can-actually-write.
//
// The three arms above ask "does authenticated hold a privilege it should not?"
// This one asks the opposite question about the SAME surface: "of the write
// privileges authenticated still holds — the ones migs 716-719 deliberately
// kept because a real `src/` caller uses them — is there any that RLS can only
// ever refuse?"
//
// THE CLASS. A table with RLS enabled and NO PERMISSIVE policy for a command
// refuses that command before the grant is ever consulted. Postgres does not
// error: the statement matches zero rows and PostgREST returns 204/200 with an
// empty body. supabase-js reports `error === null`. Every client written the
// obvious way then reports SUCCESS for a write that did nothing. This repo has
// already paid for that shape twice — `project_role_gated_ui_audit` recorded
// it as "RLS-denied write = PostgREST SUCCESS, 0 rows", and four writes against
// `tenants` in src/lib/api.ts were removed as silent no-ops (their comments are
// still at api.ts:97/297/675/734).
//
// docs/52 §5 measured the population and found exactly ONE live instance —
// `de_deployment_stages` UPDATE, driving promoteDeploymentStage — out of 82
// kept command-grants. Mig 720 closed it by routing promotion through
// promote_de_deployment_stage() and revoking the grant. That measurement is a
// point in time; this is what makes instance #2 impossible to ship quietly.
//
// WHY IT IS NOT A DUPLICATE OF ARM 1. Arm 1 pins the grant surface and fails on
// any diff, so it catches a grant ARRIVING. It cannot tell a useful grant from
// a useless one, and re-pinning is one flag away — a future migration that adds
// `grant insert on <t> to authenticated` and re-pins would be green on arm 1
// and lying to the first client that calls it. This arm reads the POLICIES, not
// the pin, so a re-pin cannot silence it.
//
// ⚠ WHAT IT CANNOT SEE. A table whose PERMISSIVE policy exists but whose USING
// clause matches zero rows for the caller in practice looks identical to a
// working one from the catalogue — docs/52 §9 says so in its own words. This
// probe closes the structural half (no policy at all), which is the half that
// is decidable without executing as a user.
// ============================================================================

/**
 * @param {object} [opts]
 * @param {string} [opts.grantSource]  (tbl, sch, grantee, priv)
 * @param {string} [opts.policySource] (tbl, cmd, permissive, roles text[])
 * @param {string} [opts.rlsSource]    (tbl, rls_enabled)
 */
export function silentNoopWriteSql(opts = {}) {
  const {
    grantSource = `
      select g.table_name::text     as tbl,
             g.table_schema::text   as sch,
             g.grantee::text        as grantee,
             g.privilege_type::text as priv
        from information_schema.role_table_grants g
       where exists (select 1 from pg_class c
                      where c.relname = g.table_name
                        and c.relnamespace = 'public'::regnamespace
                        and c.relkind = 'r')`,
    policySource = `
      select p.tablename::text   as tbl,
             p.cmd::text         as cmd,
             p.permissive::text  as permissive,
             p.roles::text[]     as roles
        from pg_policies p
       where p.schemaname = 'public'`,
    rlsSource = `
      select c.relname::text as tbl, c.relrowsecurity as rls_enabled
        from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'`,
  } = opts;

  return `
with grants as (${grantSource}),
pols as (${policySource}),
rls as (${rlsSource}),
pairs as (
  select g.tbl, g.priv
    from grants g
   where g.sch = 'public' and g.grantee = 'authenticated'
     and g.priv in ('INSERT','UPDATE','DELETE')
),
-- The set actually COMPARED. A pair on a table with RLS off cannot silently
-- no-op (no policy is consulted at all), so it is out of scope here and
-- rls-on-every-public-table owns it instead.
compared as (
  select p.tbl, p.priv
    from pairs p
    left join rls r on r.tbl = p.tbl
   where coalesce(r.rls_enabled, false)
),
counted as (
  select (select count(*) from pairs) as n_pairs,
         (select count(*) from compared) as n_compared
)

select c.tbl || '.' || c.priv || ': authenticated holds this write grant, but '
       || c.tbl || ' has RLS enabled and NO PERMISSIVE ' || c.priv || ' policy '
       || 'for authenticated or public. Postgres refuses the command before the '
       || 'grant is read — it matches zero rows and PostgREST returns SUCCESS '
       || 'WITH NO ERROR, so every client reports a write that never happened '
       || '(project_role_gated_ui_audit; mig 720). Either add the policy that '
       || 'makes the write real, or route it through a SECURITY DEFINER RPC and '
       || 'revoke the grant. Do NOT leave it: a grant RLS can only refuse is a '
       || 'lie waiting for its first caller.' as violation,
       null::text as note
  from compared c
 where not exists (
   select 1 from pols p
    where p.tbl = c.tbl
      and p.permissive = 'PERMISSIVE'          -- RESTRICTIVE only ever subtracts
      and p.cmd in ('ALL', c.priv)
      and p.roles && array['authenticated','public']::text[]
 )

union all

-- THE DENOMINATOR. Zero findings from zero comparisons is indistinguishable
-- from a clean result, and this probe is one falsified predicate away from it.
select case when c.n_compared = 0
            then 'no-comparisons: write-grants-can-actually-write compared 0 '
                 || 'grant/command pairs. It read nothing, and a probe that '
                 || 'examined nothing looks exactly like a clean one.'
       end as violation,
       case when c.n_compared > 0
            then 'write-grants-can-actually-write: examined ' || c.n_pairs
                 || ' authenticated INSERT/UPDATE/DELETE grant(s) on public base '
                 || 'tables, ' || c.n_compared || ' of them on RLS-enabled tables; '
                 || 'any pair without a PERMISSIVE policy for its command is '
                 || 'listed above, and there are ' || (
                      select count(*) from compared cc
                       where not exists (
                         select 1 from pols p
                          where p.tbl = cc.tbl and p.permissive = 'PERMISSIVE'
                            and p.cmd in ('ALL', cc.priv)
                            and p.roles && array['authenticated','public']::text[]))
                 || ' of them.'
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

// ============================================================================
// A THIRD PROBE, A THIRD CLASS: evidence-tables-are-sealed.
//
// The arms above police `authenticated`. This one polices `service_role`, and
// it is the only thing in this repo that does.
//
// ── WHY IT EXISTS ─────────────────────────────────────────────────────────
// Migs 832 and 835 made verify_de_system refuse to record a check that
// compared nothing — a digital employee could otherwise bank `matched = true`
// having read no system of record at all. Both guards live INSIDE THE RPC.
// `service_role` held INSERT/UPDATE/DELETE/TRUNCATE on the table directly, so
// any edge function writing it without the RPC bypassed both. Mig 840 revoked
// that (`revoke all` + `grant select`, the shape mig 744:197 used for
// discovery_capability_demand_log). THIS is what stops it growing back.
//
// ⚠ AND IT IS THE LOAD-BEARING HALF, NOT THE DECORATION. Measured 2026-08-21:
// there is NO standing gate on service_role TABLE grants anywhere in this repo.
// certify.mjs names service_role once, for a FUNCTION-execute privilege
// (:1166); the three arms above are `authenticated`-only. Mig 716:334 LOOKS
// like a standing invariant ("TIER B OVER-REVOKED: service_role grants went
// from % to %") and is not — that is a before/after comparison inside 716's own
// DO block, a blast-radius check on 716 itself, and it does not re-run. So
// before this probe, mig 840's revoke could have been undone by anything, at
// any time, and nothing would have said a word.
//
// ── WHY has_table_privilege AND NOT information_schema ────────────────────
// The arms above read information_schema.role_table_grants. THAT IS NOT SAFE
// FOR THIS QUESTION, and the difference was measured rather than assumed:
// information_schema shows only grants the QUERYING ROLE is party to. Asked
// for de_system_verifications with grantee='service_role', on the same
// database, at the same moment:
//
//   scripts/db-query.mjs  (connects as postgres, the grantor)      -> 7 rows
//   Supabase MCP execute_sql (connects as supabase_read_only_user) -> 0 rows
//
// Zero rows reads as "no grants" — a false ALL-CLEAR that already fooled one
// audit of this exact table. The arms above survive it only because certify
// happens to connect as postgres. has_table_privilege answers the privilege
// system directly and gives the same answer whoever asks, so this arm cannot
// be quietly disarmed by the connection it runs on.
//
// ── BOTH HALVES, AND A SEAL THAT CANNOT GUARD NOTHING ─────────────────────
// Three ways this can be wrong, and it checks all three:
//   A  a write privilege REGREW           — the thing it was built for
//   B  the table VANISHED or was RENAMED  — the seal now guards nothing, and
//      a silent pass would be indistinguishable from a clean one. This is the
//      `to_regclass` lesson from mig 716:294 (`::regclass` RAISES 42P01 and
//      the row drops out) and the "check the evaluator EXISTS" lesson from
//      the authority probe.
//   C  SELECT was ALSO revoked            — over-revoking is the same defect
//      wearing the opposite mask (mig 643 nearly left 11 of 12 workspaces
//      administrable by nobody), and this table is READ as evidence.
//
// ── SCOPE, DELIBERATELY NARROW, AND WHY IT IS A LIST AND NOT A PATTERN ────
// SEALED below is one table. The tempting generalisation — "every append-only
// audit table" — was enumerated and declined in mig 840's header: fifteen
// tables have zero references in shipped code, and narrowing those to "read as
// evidence" is a judgment call at each one, which is how a sweep ends up
// partial while looking complete. A literal list makes each addition a
// deliberate, reviewable diff instead of a pattern that silently changes
// membership when somebody renames a table.
// ============================================================================

/**
 * Tables whose rows ARE the evidence that something happened, and which are
 * therefore writable only by their SECURITY DEFINER RPC. Adding one here is
 * only half the job — the grants have to be revoked by a migration too, or
 * this probe fails immediately (which is the correct order to find out).
 */
export const SEALED_EVIDENCE_TABLES = ['de_system_verifications'];

/** Privileges that let a role change what a sealed table SAYS. */
const SEAL_FORBIDDEN = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'];

const sealedValues = (tables) =>
  tables.map((t) => `('${String(t).replace(/'/g, "''")}')`).join(', ');

/**
 * @param {object} [opts]
 * @param {string[]} [opts.sealed]       Tables under seal. Drives the denominator.
 * @param {string} [opts.grantSource]    (tbl, priv) — one row per FORBIDDEN privilege
 *   service_role actually holds. Substitutable so the mutation suite drives the REAL
 *   predicate over synthesised rows rather than a paraphrase of it.
 * @param {string} [opts.presenceSource] (tbl, present, can_read).
 */
export function sealedEvidenceSql(opts = {}) {
  const sealed = opts.sealed ?? SEALED_EVIDENCE_TABLES;
  // A self-contained empty subquery for the zero-table case: an empty VALUES
  // list is a syntax error, and a trailing `where false` on the alias would
  // collide with the WHERE the grant source appends after it.
  const vals = sealed.length
    ? `(values ${sealedValues(sealed)}) v(tbl)`
    : `(select null::text as tbl where false) v`;
  const privVals = `(values ${SEAL_FORBIDDEN.map((p) => `('${p}')`).join(', ')}) p(priv)`;

  const {
    grantSource = `
      select v.tbl::text as tbl, p.priv::text as priv
        from ${vals}
        cross join ${privVals}
       where to_regclass('public.' || quote_ident(v.tbl)) is not null
         and has_table_privilege('service_role', to_regclass('public.' || quote_ident(v.tbl)), p.priv)`,
    presenceSource = `
      select v.tbl::text as tbl,
             to_regclass('public.' || quote_ident(v.tbl)) is not null as present,
             coalesce(has_table_privilege('service_role',
                        to_regclass('public.' || quote_ident(v.tbl)), 'SELECT'), false) as can_read
        from ${vals}`,
  } = opts;

  return `
with held as (${grantSource}),
present as (${presenceSource}),
counted as (
  select (select count(*) from present) as n_sealed,
         (select count(*) from present where present) as n_examined,
         (select count(*) from held) as n_held
)

-- ── A: a forbidden privilege REGREW on a sealed table. ──────────────────────
select h.tbl || '.' || h.priv || ': service_role holds this on a WRITE-SEALED '
       || 'evidence table. Rows in ' || h.tbl || ' are the proof that a check '
       || 'actually happened, and the guards that decide whether a row is '
       || 'honest live inside the SECURITY DEFINER RPC that writes it (migs '
       || '832/835). A role that can write the table directly bypasses those '
       || 'guards entirely and can mint evidence for work it never did. Mig '
       || '840 revoked exactly this. Revoke it again; do not allowlist it, and '
       || 'do not route a new writer around the RPC.' as violation,
       null::text as note
  from held h

union all

-- ── B: the seal now guards NOTHING. ─────────────────────────────────────────
select p.tbl || ': listed in SEALED_EVIDENCE_TABLES but no such table exists '
       || 'in public. Either it was renamed and the seal silently stopped '
       || 'following it, or it was dropped and this entry is stale. A seal '
       || 'over a table that is not there passes every run and protects '
       || 'nothing, which looks exactly like a clean result.' as violation,
       null::text as note
  from present p
 where not p.present

union all

-- ── C: OVER-revoked. The opposite mask of the same defect. ──────────────────
select p.tbl || ': service_role has lost SELECT on this sealed evidence table. '
       || 'The seal is meant to stop WRITES, not reads — these rows are read as '
       || 'promotion evidence. A revoke that removed more than intended is the '
       || 'same class of defect as the grant it was closing (mig 643). Restore '
       || 'SELECT.' as violation,
       null::text as note
  from present p
 where p.present and not p.can_read

union all

-- ── THE DENOMINATOR. Zero comparisons is a VIOLATION, not a pass. ───────────
select case when c.n_examined = 0
            then 'no-comparisons: evidence-tables-are-sealed examined 0 tables. '
                 || 'It read nothing, and a probe that examined nothing is '
                 || 'indistinguishable from a clean one.'
       end as violation,
       case when c.n_examined > 0
            then 'evidence-tables-are-sealed: examined ' || c.n_examined
                 || ' of ' || c.n_sealed || ' sealed table(s) against '
                 || ${SEAL_FORBIDDEN.length} || ' forbidden privilege(s) each; '
                 || 'service_role holds ' || c.n_held || ' of them.'
       end as note
  from counted c
`;
}
