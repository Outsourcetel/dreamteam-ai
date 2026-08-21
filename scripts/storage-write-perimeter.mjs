// ============================================================================
// storage-write-perimeter.mjs — Ring-0: the FILE STORE. What the anonymous and
// merely-signed-up surfaces hold on `storage` must not widen, the half that was
// fixable must stay fixed, and the half that is blocked must stay VISIBLE
// rather than quietly accepted.
//
// ── WHAT IS ACTUALLY TRUE TODAY, MEASURED ON PRODUCTION 2026-08-21 ────────
// Register item A-1 named two things. They have different answers, and both
// were DRIVEN in a rolled-back transaction rather than reasoned about, because
// this is precisely the class of statement that returns SUCCESS and does
// nothing.
//
//   (a) BLOCKED. `storage.objects` and `storage.buckets` grant anon AND
//       authenticated `arwdDxtm` — INSERT, SELECT, UPDATE, DELETE, TRUNCATE,
//       REFERENCES, TRIGGER, MAINTAIN. TRUNCATE is the one that matters: RLS
//       does not police it, so either role is one statement from emptying every
//       tenant's file index. Both tables are owned by `supabase_storage_admin`
//       — a THIRD role, neither `postgres` nor `supabase_admin` — and every one
//       of those grants has grantor `supabase_storage_admin`.
//
//         revoke truncate, delete, insert, update on storage.objects
//           from anon, authenticated;                    -> RETURNED SUCCESS
//         has_table_privilege('anon','storage.objects','TRUNCATE')  -> STILL t
//         relacl afterwards                              -> BYTE-IDENTICAL
//
//       ⚠ THIS IS NOT THE pg_net SHAPE, AND THAT MATTERS. There, `postgres`
//       held no grant option at all. Here it holds a*r*w*d*D*x*t*m* — WITH
//       grant option — so the revoke is not refused for lack of privilege:
//       select_best_grantor picks `postgres` as the grantor, finds no aclitem
//       with grantee=anon and grantor=postgres, and removes nothing. Holding
//       grant option is not the same as being the grantor, and a checker built
//       on "does postgres have grant option" would have called this fixable.
//       The walls that DO speak: `alter table storage.objects owner to
//       postgres` -> 42501 must be owner; `set role supabase_storage_admin`
//       -> 42501 permission denied.
//
//   (b) FIXED, by mig 839. The `storage` DEFAULT ACL handed anon and
//       authenticated everything on every object born there — and unlike
//       `public`, where the arwdDxtm row mig 715 could not move has grantor
//       `supabase_admin` (register item A-2), schema `storage` has NO
//       supabase_admin row at all. All three of its rows carry grantor
//       **postgres**, and a role may always alter its own default privileges.
//
// ── ⚠ SEVERITY OF (b), STATED HONESTLY: LATENT, NOT LIVE ─────────────────
// A default privilege fires for the role that CREATES the object, and
// `create table storage._probe (id int)` as postgres returns 42501 permission
// denied for schema storage — postgres holds USAGE on that schema, never
// CREATE. So the row mig 839 tightened had never fired and could not fire. It
// was a loaded default, not an open door: the day anything grants postgres
// CREATE there, every object born arrives TRUNCATE-able by the internet with
// no statement anywhere saying so. Arm 4 keeps it pulled.
//
// ── ⚠⚠ BOTH HALVES. A REVOKE THAT BREAKS UPLOADS IS THE SAME DEFECT ──────
// `authenticated` MUST KEEP SELECT, INSERT, UPDATE and DELETE on
// storage.objects. That is not an oversight in the escalation — it is the
// upload path: the storage service reaches storage.objects as the caller's
// role and RLS is what scopes it to the tenant. The thing to remove is
// TRUNCATE, which RLS cannot police and no upload needs. Mig 643 nearly left
// eleven of twelve workspaces administrable by nobody; a storage revoke that
// went one letter too far would read as hardening and delete the product's
// ability to store a file. So arm 5 fails on LOSS as hard as arms 1-2 fail on
// gain, and it is not decoration: it is the arm most likely to fire, because
// the escalation in docs/72 asks a human at Supabase to run a REVOKE by hand.
//
// ── WHAT THIS ARM RATCHETS: SIX THINGS THAT CAN ALL FAIL ─────────────────
//   ARM 1  a storage grant whose GRANTOR IS NOT supabase_storage_admin. That
//          one was made from THIS project and IS revocable from postgres. 0.
//   ARM 2  the surface WIDENS — a reachable storage object outside the
//          recorded baseline, or a baseline object gaining a privilege.
//   ARM 3  the surface NARROWS — a baseline object loses one, or vanishes.
//          That is the GOOD direction and it still fails, loudly, because it
//          means Supabase acted on docs/72 and A-1 must be re-measured and
//          closed rather than left open forever on a stale finding. This is
//          also the answer to "do not ship a permanently-red gate": the
//          blocked half is reported as KNOWN-BLOCKED in the denominator on
//          every green run, and the day it clears, this arm says so.
//   ARM 4  mig 839's ratchet — the EFFECTIVE default ACL for an object
//          `postgres` creates in schema storage must grant anon,
//          authenticated and PUBLIC nothing. Computed with acldefault() so a
//          MISSING pg_default_acl row is judged on what it would really mean
//          (for FUNCTIONS the built-in default is EXECUTE TO PUBLIC, so a
//          deleted row is a hole, not a clean slate).
//   ARM 5  a role that must RETAIN lost something. Uploads, both directions.
//   ARM 6  a bucket recorded PRIVATE is now public, a recorded bucket is gone,
//          or a NEW bucket arrived PUBLIC. A new PRIVATE bucket is counted in
//          the denominator and does NOT fail — onboarding-attachments is a
//          live design and a gate that reds on planned work gets ignored.
//
// ── NO ALLOWLIST, AND NOWHERE TO ADD ONE ─────────────────────────────────
// Every baseline here is a CONSTANT IN THIS FILE, not a JSON file, so
// `certify --pin-allowlist` / `--pin-write` / `--pin-edge` cannot regenerate
// it. Widening it costs a commit a human reads. That is deliberate: 48 of the
// 49 breached trigger functions the sibling arm exists for sat INSIDE a
// re-pinnable allowlist, blessed by past pin runs.
// ============================================================================

import { readFileSync } from 'node:fs';

/** The role that owns every object in `storage`. A grant from anyone else is ours. */
export const UPSTREAM_OWNER = 'supabase_storage_admin';

/** Where the blocked half is written up for someone who can actually run it. */
export const ESCALATION_DOC = 'docs/72-supabase-privilege-escalations.md';

/**
 * Everything in schema `storage` reachable by anon or authenticated, measured
 * on production 2026-08-21, with the EXACT privilege letters each role holds.
 *
 * Letters are the aclitem alphabet: a=INSERT r=SELECT w=UPDATE d=DELETE
 * D=TRUNCATE x=REFERENCES t=TRIGGER m=MAINTAIN | U=USAGE C=CREATE | X=EXECUTE.
 * They are emitted in that fixed order from has_*_privilege() rather than read
 * out of relacl text, because relacl ordering is not stable and a re-ordered
 * ACL would read as a changed surface every run.
 *
 * ⚠ `storage.migrations` is deliberately ABSENT: neither role holds anything
 * on it, so it is not on this perimeter. If a grant ever appears there, arm 2
 * reports it as new — which is correct.
 */
export const BASELINE = [
  'schema storage|anon=U|authenticated=U',
  'storage.allow_any_operation(expected_operations text[])|anon=X|authenticated=X',
  'storage.allow_only_operation(expected_operation text)|anon=X|authenticated=X',
  'storage.buckets_analytics|anon=arwdDxtm|authenticated=arwdDxtm',
  'storage.buckets_vectors|anon=r|authenticated=r',
  'storage.buckets|anon=arwdDxtm|authenticated=arwdDxtm',
  'storage.can_insert_object(bucketid text, name text, owner uuid, metadata jsonb)|anon=X|authenticated=X',
  'storage.enforce_bucket_name_length()|anon=X|authenticated=X',
  'storage.extension(name text)|anon=X|authenticated=X',
  'storage.filename(name text)|anon=X|authenticated=X',
  'storage.foldername(name text)|anon=X|authenticated=X',
  'storage.get_common_prefix(p_key text, p_prefix text, p_delimiter text)|anon=X|authenticated=X',
  'storage.get_size_by_bucket()|anon=X|authenticated=X',
  'storage.list_multipart_uploads_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text, next_upload_token text)|anon=X|authenticated=X',
  'storage.list_objects_with_delimiter(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token text, sort_order text)|anon=X|authenticated=X',
  'storage.objects|anon=arwdDxtm|authenticated=arwdDxtm',
  'storage.operation()|anon=X|authenticated=X',
  'storage.protect_delete()|anon=X|authenticated=X',
  'storage.s3_multipart_uploads_parts|anon=r|authenticated=r',
  'storage.s3_multipart_uploads|anon=r|authenticated=r',
  'storage.search(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text)|anon=X|authenticated=X',
  'storage.search_by_timestamp(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text)|anon=X|authenticated=X',
  'storage.search_v2(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_column_after text)|anon=X|authenticated=X',
  'storage.update_updated_at_column()|anon=X|authenticated=X',
  'storage.vector_indexes|anon=r|authenticated=r',
];

/**
 * The two objects in the A-1 escalation, and what must come OFF them. Named
 * separately from BASELINE so the denominator can report the blocked half as
 * KNOWN-BLOCKED on every green run instead of it disappearing into a count.
 */
export const KNOWN_BLOCKED = [
  'storage.objects: anon and authenticated hold TRUNCATE (owner supabase_storage_admin; revoke from postgres returns success and changes nothing)',
  'storage.buckets: anon and authenticated hold TRUNCATE, plus INSERT/UPDATE/DELETE on the bucket registry itself (same owner, same wall)',
];

/**
 * ⚠⚠ THE OTHER HALF. What must NEVER be lost, expressed as the privileges the
 * product actually needs rather than as an ACL string, so the arm says what
 * breaks rather than that something changed.
 *
 * `authenticated` keeping arwd on storage.objects is not a gap in the
 * escalation — it IS the upload path. docs/72 asks for TRUNCATE (and the
 * bucket-registry writes) to come off, and for nothing else to move.
 */
export const RETAINED = [
  ['service_role', 'storage.objects', 'SELECT,INSERT,UPDATE,DELETE'],
  ['service_role', 'storage.buckets', 'SELECT,INSERT,UPDATE,DELETE'],
  ['authenticated', 'storage.objects', 'SELECT,INSERT,UPDATE,DELETE'],
  ['authenticated', 'storage.buckets', 'SELECT'],
  ['anon', 'storage.objects', 'SELECT'],
  ['anon', 'storage.buckets', 'SELECT'],
  ['postgres', 'storage.objects', 'SELECT'],
  ['postgres', 'storage.buckets', 'SELECT'],
  ['supabase_admin', 'storage.objects', 'SELECT,INSERT,UPDATE,DELETE'],
  ['supabase_storage_admin', 'storage.objects', 'SELECT,INSERT,UPDATE,DELETE'],
  ['supabase_storage_admin', 'storage.buckets', 'SELECT,INSERT,UPDATE,DELETE'],
];

/** Buckets that exist and MUST stay private. migs 024, 031, 652. */
export const PRIVATE_BUCKETS = ['playbook-media', 'specialist-media'];

function literal(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Every object in schema `storage` with the privilege letters anon and
 * authenticated actually hold, plus the grantor(s) behind them.
 *
 * ⚠ coalesce(acl, acldefault(...)) is load-bearing for the GRANTOR column.
 * Seventeen of the storage routines carry proacl NULL, which does not mean
 * "ungranted" — for a function the built-in default IS execute-to-PUBLIC.
 * aclexplode over NULL returns zero rows, so without the coalesce every
 * born-public routine would report grantor '(none)' and arm 1 would call the
 * upstream default a grant this project made.
 */
export const STORAGE_OBJECT_SOURCE = `
  select ('storage.' || c.relname)::text as obj,
         c.relowner::regrole::text as owner,
         case when c.relkind = 'S' then
           concat(case when has_sequence_privilege('anon', c.oid, 'SELECT') then 'r' else '' end,
                  case when has_sequence_privilege('anon', c.oid, 'UPDATE') then 'w' else '' end,
                  case when has_sequence_privilege('anon', c.oid, 'USAGE')  then 'U' else '' end)
         else
           concat(case when has_table_privilege('anon', c.oid, 'INSERT')     then 'a' else '' end,
                  case when has_table_privilege('anon', c.oid, 'SELECT')     then 'r' else '' end,
                  case when has_table_privilege('anon', c.oid, 'UPDATE')     then 'w' else '' end,
                  case when has_table_privilege('anon', c.oid, 'DELETE')     then 'd' else '' end,
                  case when has_table_privilege('anon', c.oid, 'TRUNCATE')   then 'D' else '' end,
                  case when has_table_privilege('anon', c.oid, 'REFERENCES') then 'x' else '' end,
                  case when has_table_privilege('anon', c.oid, 'TRIGGER')    then 't' else '' end,
                  case when has_table_privilege('anon', c.oid, 'MAINTAIN')   then 'm' else '' end) end as anon_p,
         case when c.relkind = 'S' then
           concat(case when has_sequence_privilege('authenticated', c.oid, 'SELECT') then 'r' else '' end,
                  case when has_sequence_privilege('authenticated', c.oid, 'UPDATE') then 'w' else '' end,
                  case when has_sequence_privilege('authenticated', c.oid, 'USAGE')  then 'U' else '' end)
         else
           concat(case when has_table_privilege('authenticated', c.oid, 'INSERT')     then 'a' else '' end,
                  case when has_table_privilege('authenticated', c.oid, 'SELECT')     then 'r' else '' end,
                  case when has_table_privilege('authenticated', c.oid, 'UPDATE')     then 'w' else '' end,
                  case when has_table_privilege('authenticated', c.oid, 'DELETE')     then 'd' else '' end,
                  case when has_table_privilege('authenticated', c.oid, 'TRUNCATE')   then 'D' else '' end,
                  case when has_table_privilege('authenticated', c.oid, 'REFERENCES') then 'x' else '' end,
                  case when has_table_privilege('authenticated', c.oid, 'TRIGGER')    then 't' else '' end,
                  case when has_table_privilege('authenticated', c.oid, 'MAINTAIN')   then 'm' else '' end) end as auth_p,
         coalesce((select string_agg(distinct a.grantor::regrole::text, '+')
                     from aclexplode(coalesce(c.relacl,
                            acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
                    where a.grantee = 0
                       or a.grantee = 'anon'::regrole::oid
                       or a.grantee = 'authenticated'::regrole::oid), '(none)') as grantors
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'storage' and c.relkind in ('r','p','v','m','S','f')
  union all
  select ('storage.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text,
         p.proowner::regrole::text,
         case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'X' else '' end,
         case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'X' else '' end,
         coalesce((select string_agg(distinct a.grantor::regrole::text, '+')
                     from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where a.grantee = 0
                       or a.grantee = 'anon'::regrole::oid
                       or a.grantee = 'authenticated'::regrole::oid), '(none)')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'storage'
  union all
  select 'schema storage',
         n.nspowner::regrole::text,
         concat(case when has_schema_privilege('anon', n.oid, 'USAGE')  then 'U' else '' end,
                case when has_schema_privilege('anon', n.oid, 'CREATE') then 'C' else '' end),
         concat(case when has_schema_privilege('authenticated', n.oid, 'USAGE')  then 'U' else '' end,
                case when has_schema_privilege('authenticated', n.oid, 'CREATE') then 'C' else '' end),
         coalesce((select string_agg(distinct a.grantor::regrole::text, '+')
                     from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                    where a.grantee = 0
                       or a.grantee = 'anon'::regrole::oid
                       or a.grantee = 'authenticated'::regrole::oid), '(none)')
    from pg_namespace n
   where n.nspname = 'storage'`;

/**
 * What an object CREATED BY postgres IN SCHEMA storage would actually be born
 * holding — mig 839's subject.
 *
 * ⚠ acldefault() is the whole point. A missing pg_default_acl row is not a
 * clean slate: for objtype 'f' the built-in default is `{=X/owner,...}`, i.e.
 * EXECUTE TO PUBLIC. Reading pg_default_acl alone would score a DELETED row as
 * a pass, which is the catalogue equivalent of the trap this whole file is
 * about — a state that looks fixed because there is nothing there to read.
 * (Note the objtype letters differ between the two catalogues: pg_default_acl
 * spells a sequence 'S', acldefault spells it 's'.)
 */
export const STORAGE_DEFACL_SOURCE = `
  select t.objtype::text as objtype,
         coalesce(
           (select d.defaclacl
              from pg_default_acl d
              join pg_namespace n on n.oid = d.defaclnamespace
             where n.nspname = 'storage'
               and d.defaclrole = 'postgres'::regrole
               and d.defaclobjtype = t.objtype),
           acldefault(t.acldef, 'postgres'::regrole)) as eff_acl,
         (select count(*) from pg_default_acl d
            join pg_namespace n on n.oid = d.defaclnamespace
           where n.nspname = 'storage' and d.defaclrole = 'postgres'::regrole
             and d.defaclobjtype = t.objtype)::int as row_present
    from (values ('r'::"char", 'r'::"char"),
                 ('f'::"char", 'f'::"char"),
                 ('S'::"char", 's'::"char")) t(objtype, acldef)`;

/**
 * @param {object} [opts]
 * @param {string}   [opts.objSource]     relation of (obj, owner, anon_p, auth_p, grantors)
 * @param {string}   [opts.defaclSource]  relation of (objtype, eff_acl, row_present)
 * @param {string}   [opts.extraObjs]     a SELECT unioned into the object population
 * @param {string}   [opts.extraDefacl]   a SELECT unioned into the default-ACL population
 * @param {string}   [opts.extraBuckets]  a SELECT unioned into the bucket population
 * @param {string[]} [opts.baseline]      substitutable so the narrowing arm can be driven
 * @param {string[][]} [opts.retained]    substitutable so the retention arm can be driven
 * @param {string[]} [opts.privateBuckets]
 * @param {boolean}  [opts.emptyObjects]  drive the object-vacuity arm
 * @param {boolean}  [opts.emptyDefacl]   drive the default-ACL-vacuity arm
 * @param {boolean}  [opts.emptyRetained] drive the retention-vacuity arm
 */
export function storageWritePerimeterSql(opts = {}) {
  const {
    objSource = STORAGE_OBJECT_SOURCE,
    defaclSource = STORAGE_DEFACL_SOURCE,
    extraObjs = null,
    extraDefacl = null,
    extraBuckets = null,
    baseline = BASELINE,
    retained = RETAINED,
    privateBuckets = PRIVATE_BUCKETS,
    emptyObjects = false,
    emptyDefacl = false,
    emptyRetained = false,
  } = opts;

  const objs = emptyObjects
    ? `select null::text as obj, null::text as owner, null::text as anon_p, null::text as auth_p, null::text as grantors where false`
    : (extraObjs ? `${objSource}\n  union all\n${extraObjs}` : objSource);

  const defacl = emptyDefacl
    ? `select null::text as objtype, null::aclitem[] as eff_acl, null::int as row_present where false`
    : (extraDefacl ? `${defaclSource}\n  union all\n${extraDefacl}` : defaclSource);

  const retainedRows = (emptyRetained || retained.length === 0)
    ? `select null::text as role_, null::text as obj, null::text as privs where false`
    : `values ${retained.map(([r, o, p]) => `(${literal(r)}, ${literal(o)}, ${literal(p)})`).join(', ')}`;

  const bucketSrc = `select b.id::text as id, b.public as is_public from storage.buckets b`;
  const buckets = extraBuckets ? `${bucketSrc}\n  union all\n${extraBuckets}` : bucketSrc;

  return `
with objs as (${objs}),
baseline_raw(entry) as (values ${baseline.map((b) => '(' + literal(b) + ')').join(', ')}),
baseline as (
  select split_part(entry, '|', 1)                              as obj,
         substring(split_part(entry, '|', 2) from 'anon=(.*)$')          as anon_p,
         substring(split_part(entry, '|', 3) from 'authenticated=(.*)$') as auth_p
    from baseline_raw
),
reachable as (select * from objs where coalesce(anon_p,'') <> '' or coalesce(auth_p,'') <> ''),
defacl as (${defacl}),
defacl_open as (
  select d.objtype,
         case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
         string_agg(a.privilege_type, ',' order by a.privilege_type) as privs,
         bool_or(d.row_present = 0) as row_missing
    from defacl d, aclexplode(d.eff_acl) a
   where a.grantee = 0
      or a.grantee = 'anon'::regrole::oid
      or a.grantee = 'authenticated'::regrole::oid
   group by d.objtype, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
),
retained(role_, obj, privs) as (${retainedRows}),
retained_checked as (
  select r.role_, r.obj, p.priv,
         has_table_privilege(r.role_, r.obj, p.priv) as held
    from retained r
    cross join lateral unnest(string_to_array(r.privs, ',')) as p(priv)
   where to_regclass(r.obj) is not null
     and exists (select 1 from pg_roles pr where pr.rolname = r.role_)
),
buckets as (${buckets}),
counted as (
  select (select count(*) from objs)                          as n_objs,
         (select count(*) from reachable)                     as n_reachable,
         (select count(*) from baseline)                      as n_baseline,
         (select count(*) from reachable r
           where exists (select 1 from regexp_split_to_table(r.grantors, '\\+') g(x)
                          where g.x <> r.owner and g.x <> '(none)')) as n_ours,
         (select count(*) from defacl)                        as n_defacl,
         (select count(*) from defacl_open)                   as n_defacl_open,
         (select count(*) from retained_checked)              as n_retained,
         (select count(*) from retained_checked where not held) as n_retained_lost,
         (select count(*) from buckets)                       as n_buckets,
         (select count(*) from buckets where is_public)       as n_public_buckets,
         (select count(*) from objs where coalesce(anon_p,'') <> '') as n_anon_any
)

-- ── ARM 1: a storage grant THIS REPO made. The only revocable half. ───────
-- ⚠ THE COMPARISON IS AGAINST THE OBJECT'S OWN OWNER, not one constant, and
-- that is not a refinement — the first draft compared everything to
-- supabase_storage_admin and immediately reported "schema storage" as a grant
-- this project made. It is not: the SCHEMA is owned by supabase_admin and its
-- USAGE grants come from supabase_admin, while the eight relations and
-- seventeen routines inside it are owned by supabase_storage_admin. Two
-- upstream owners, one schema. A single constant makes the arm accuse upstream
-- of a grant nobody here can revoke — which is exactly the false closure this
-- perimeter exists to prevent, pointing the other way.
select r.obj || ': reachable by anon=[' || coalesce(r.anon_p,'') || '] authenticated=['
       || coalesce(r.auth_p,'') || '] via a grant whose grantor is ' || r.grantors
       || ', which is not its owner (' || r.owner || '). That grant was made from THIS project and IS '
       || 'revocable from postgres — unlike the upstream ones, where REVOKE runs clean and changes '
       || 'nothing. Revoke it in the migration that created it. Not allowlistable.' as violation,
       null::text as note
  from reachable r
 where exists (select 1 from regexp_split_to_table(r.grantors, '\\+') g(x)
                where g.x <> r.owner and g.x <> '(none)')

union all

-- ── ARM 2: the surface got WIDER — new object, or a new privilege. ────────
select r.obj || ': anon=[' || coalesce(r.anon_p,'') || '] authenticated=[' || coalesce(r.auth_p,'')
       || '] is WIDER than the recorded A-1 baseline of ' || (select n_baseline from counted)::text
       || ' object(s)' || case when b.obj is null then ' (this object is not in the baseline at all)'
                               else ' (baseline: anon=[' || coalesce(b.anon_p,'') || '] authenticated=['
                                    || coalesce(b.auth_p,'') || '])' end
       || '. Either the storage extension gained an object or someone granted one. Establish which, then '
       || 'either revoke it (if the grantor is postgres) or amend BASELINE in '
       || 'scripts/storage-write-perimeter.mjs in a commit a human reads — there is no --pin flag for this.' as violation,
       null::text as note
  from reachable r
  left join baseline b on b.obj = r.obj
 where b.obj is null
    or exists (select 1 from regexp_split_to_table(coalesce(r.anon_p,''), '') l(c)
                where position(l.c in coalesce(b.anon_p,'')) = 0)
    or exists (select 1 from regexp_split_to_table(coalesce(r.auth_p,''), '') l(c)
                where position(l.c in coalesce(b.auth_p,'')) = 0)

union all

-- ── ARM 3: the surface got NARROWER. Both directions, deliberately. ──────
-- This is how the KNOWN-BLOCKED half stops being permanent. docs/72 asks
-- Supabase to run the revoke \`postgres\` cannot; when they do, this fires and
-- names what moved, so A-1 is re-measured and closed instead of sitting open
-- forever on a finding that has quietly expired.
select b.obj || ': recorded in the A-1 baseline as anon=[' || coalesce(b.anon_p,'')
       || '] authenticated=[' || coalesce(b.auth_p,'') || '], and it now reads anon=['
       || coalesce(r.anon_p, '(object gone)') || '] authenticated=[' || coalesce(r.auth_p, '(object gone)')
       || ']. This is the GOOD direction and it is still a failure: something outside this repo changed the '
       || 'storage perimeter. Re-measure with \`node scripts/storage-write-perimeter.mjs\`, and if the TRUNCATE '
       || 'grants have genuinely gone, close register item A-1 with \`npm run defer -- --close A-1 --by '
       || '"<what closed it>"\`, shrink BASELINE, and strike the item from ' || ${literal(ESCALATION_DOC)} || '.' as violation,
       null::text as note
  from baseline b
  left join reachable r on r.obj = b.obj
 where r.obj is null
    or exists (select 1 from regexp_split_to_table(coalesce(b.anon_p,''), '') l(c)
                where position(l.c in coalesce(r.anon_p,'')) = 0)
    or exists (select 1 from regexp_split_to_table(coalesce(b.auth_p,''), '') l(c)
                where position(l.c in coalesce(r.auth_p,'')) = 0)

union all

-- ── ARM 4: mig 839's ratchet. The DEFAULT must grant the surface nothing. ─
select 'DEFAULT PRIVILEGES (grantor postgres, schema storage, objtype ' || o.objtype
       || '): an object postgres creates there would be born granting ' || o.grantee || ' ' || o.privs
       || case when o.row_missing then ' — and that is the BUILT-IN default, because the pg_default_acl row '
                                       || 'is MISSING. A deleted row is not a clean slate: for functions the '
                                       || 'built-in default is EXECUTE TO PUBLIC.'
               else '.' end
       || ' RLS does not police TRUNCATE, so a table born with D is one statement from empty. '
       || 'Migration 839 (supabase/migrations/839_storage_default_privileges_stop_granting_the_internet.sql) '
       || 'revokes exactly this. TWO CAUSES, and they need opposite actions — establish which before doing '
       || 'anything. (1) 839 is NOT in this database''s ledger: apply it — node scripts/db-query.mjs '
       || 'supabase/migrations/839_storage_default_privileges_stop_granting_the_internet.sql — do NOT write a '
       || 'second migration. Check with: select 1 from public.schema_migrations where filename like ''839!_%'' '
       || 'escape ''!''. (2) 839 IS in the ledger and this is still open: something re-granted the default '
       || 'after it ran, which is the regrowth this arm exists for. Either way the statement is: alter default '
       || 'privileges for role postgres in schema storage revoke all on '
       || case o.objtype when 'r' then 'tables' when 'f' then 'functions' else 'sequences' end
       || ' from anon, authenticated, public;' as violation,
       null::text as note
  from defacl_open o

union all

-- ── ARM 5: ⚠ THE OTHER HALF. A revoke that breaks uploads. ───────────────
select 'STORAGE IS BROKEN, NOT HARDENED: ' || rc.role_ || ' has LOST ' || rc.priv || ' on ' || rc.obj
       || '. That privilege is on the upload path — the storage service reaches storage.objects as the '
       || 'caller''s own role and RLS is what scopes it to the tenant, so removing a grant does not tighten '
       || 'anything, it deletes the ability to store a file. ' || ${literal(ESCALATION_DOC)}
       || ' asks for TRUNCATE and the bucket-registry writes to come off and NOTHING else to move; if a '
       || 'support action went further, restore it: grant ' || rc.priv || ' on ' || rc.obj || ' to ' || rc.role_ || ';' as violation,
       null::text as note
  from retained_checked rc
 where not rc.held

union all

-- ── ARM 6a: a bucket recorded PRIVATE is now PUBLIC, or has vanished. ────
select 'bucket ' || pb.name || ': recorded PRIVATE (migs 024/031/652 define its RLS policies on the '
       || 'assumption that the bucket itself grants nothing) and it is now '
       -- ⚠ THE NULL BRANCH MUST BE TESTED FIRST, not coalesced around. The first
       -- draft wrote coalesce(case when b.is_public ... else 'private' end,
       -- 'GONE'), and "case when NULL then ... else 'private'" returns 'private'
       -- rather than NULL — so the coalesce never fired and a MISSING bucket was
       -- reported as "recorded PRIVATE ... and it is now private", which reads as
       -- nonsense and hides the actual finding. Caught on dev, which is missing
       -- specialist-media; the vanished-bucket mutation asserts the word GONE for
       -- exactly this reason.
       || case when b.id is null then 'GONE — the bucket does not exist'
               when b.is_public then 'PUBLIC — every object in it is readable by URL with no key at all'
               else 'private' end
       || '. Either restore it or amend PRIVATE_BUCKETS in scripts/storage-write-perimeter.mjs.' as violation,
       null::text as note
  from (values ${privateBuckets.map((b) => '(' + literal(b) + ')').join(', ')}) pb(name)
  left join buckets b on b.id = pb.name
 where b.id is null or b.is_public

union all

-- ── ARM 6b: a NEW bucket arrived PUBLIC. A new PRIVATE one is fine. ──────
-- Deliberately asymmetric: onboarding-attachments is a live design, and a gate
-- that reds on planned work is a gate people learn to ignore. A new PUBLIC
-- bucket is a perimeter change and gets named.
select 'bucket ' || b.id || ': NEW (not in PRIVATE_BUCKETS) and PUBLIC — everything written to it is '
       || 'readable by URL with no key. If that is intended, record it in scripts/storage-write-perimeter.mjs '
       || 'in a commit a human reads; if not, \`update storage.buckets set public = false where id = '
       || quote_literal(b.id) || ';\`' as violation,
       null::text as note
  from buckets b
 where b.is_public
   and b.id not in (${privateBuckets.map((b) => literal(b)).join(', ')})

union all

-- ── VACUITY 1: no storage objects at all. ────────────────────────────────
select case when c.n_objs = 0
            then 'VACUOUS: schema \`storage\` yielded 0 objects. Either the storage extension is gone — which '
                 || 'would break every file upload — or this probe read nothing. A perimeter that compared '
                 || 'nothing is indistinguishable from a perimeter that held.'
       end, null::text
  from counted c

union all

-- ── VACUITY 2: has_*_privilege has stopped discriminating. ───────────────
select case when c.n_objs > 0 and c.n_anon_any = 0
            then 'VACUOUS: not one object in schema \`storage\` came back reachable by anon, including the '
                 || 'seventeen routines whose proacl is NULL (which MEANS execute-to-PUBLIC) and '
                 || 'storage.objects itself. has_table_privilege()/has_function_privilege() is answering '
                 || 'false for everything, so every arm above is passing by construction. Either the '
                 || 'privilege test broke or ARM 3 should have fired first — establish which.'
       end, null::text
  from counted c

union all

-- ── VACUITY 3: the default-ACL population is empty. ──────────────────────
select case when c.n_defacl <> 3
            then 'VACUOUS: the effective-default-privileges probe returned ' || c.n_defacl::text
                 || ' object type(s), not 3 (tables, functions, sequences). ARM 4 — mig 839''s entire ratchet '
                 || '— judges whatever this returns, so a short population passes it by construction.'
       end, null::text
  from counted c

union all

-- ── VACUITY 4: nothing was checked for RETENTION. ────────────────────────
select case when c.n_retained = 0
            then 'VACUOUS: 0 role/privilege pairs were checked for retention, so ARM 5 — the arm that '
                 || 'notices a revoke has BROKEN uploads rather than hardened them — compared nothing. '
                 || 'Either RETAINED is empty or to_regclass() cannot see storage.objects.'
       end, null::text
  from counted c

union all

-- ── VACUITY 5: no buckets. ───────────────────────────────────────────────
select case when c.n_buckets = 0
            then 'VACUOUS: storage.buckets holds 0 rows, so both bucket arms compared nothing. This project '
                 || 'has two private buckets (playbook-media, specialist-media) and the product cannot store '
                 || 'a file without them.'
       end, null::text
  from counted c

union all

-- ── THE DENOMINATOR, printed on a PASS as well as a fail, and carrying the
--    KNOWN-BLOCKED acknowledgement so the blocked half never goes quiet. ──
select null::text,
       format('storage-write-perimeter: examined %s object(s) in schema storage, %s reachable by anon/authenticated (baseline %s). %s carry a grantor this project controls — must be 0, and it is the only revocable half. Effective default privileges for postgres-created objects: %s type(s) checked, %s anon/authenticated/PUBLIC entr(y|ies) open — must be 0 (mig 839). Retention: %s role/privilege pair(s) asserted still held, %s lost — a LOSS here means uploads are broken, not hardened. Buckets: %s, of which %s public. ⚠ KNOWN-BLOCKED, NOT ACCEPTED — register item A-1, escalation written up in %s for a role that can run it: %s. Every one of those grants has grantor %s; \`postgres\` holds grant option but is NOT the grantor, so REVOKE returns SUCCESS and changes nothing — driven on production in a rolled-back transaction, not inferred. ARM 3 fails the day it clears, so this cannot sit open on a stale finding. No allowlist — no --pin flag can clear any of this.',
              n_objs::text, n_reachable::text, n_baseline::text, n_ours::text,
              n_defacl::text, n_defacl_open::text,
              n_retained::text, n_retained_lost::text,
              n_buckets::text, n_public_buckets::text,
              ${literal(ESCALATION_DOC)},
              ${literal(KNOWN_BLOCKED.join(' // '))},
              ${literal(UPSTREAM_OWNER)})
  from counted
`;
}

// ── CLI ───────────────────────────────────────────────────────────────────
// ⚠ certify always reads PRODUCTION; the --dev flag exists only so the
// mutation suite can be driven against a database that HAS migration 839,
// during the window where it is applied to dev and not yet to production. It
// is not a second target for the gate — a checker you can point at a friendlier
// database is a checker that reports whichever answer you preferred.
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';
const DEV_REF = 'nmuntxrcdksyhsdywpan';
const TARGET_REF = process.argv.includes('--dev') ? DEV_REF : PROD_REF;

function readToken() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function runSql(sql, ref = TARGET_REF) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  return JSON.parse(body);
}

// ── Mutants. Each asserts a COUNT DELTA as well as a message: matching a
//    substring proves only that the arm can print, never that it FIRED on the
//    injected row rather than re-reporting something already there. ─────────

/** ARM 1 — a storage grant made by postgres. Revocable, and must be named. */
const MUT_OUR_GRANT = `  select 'storage.selftest_our_grant'::text, 'supabase_storage_admin'::text, 'arwdDxtm'::text, 'arwdDxtm'::text, 'postgres'::text`;

/** ARM 2a — a NEW reachable object nobody recorded (upstream grantor, so arm 1
 *  must stay silent and only the widening arm may fire). */
const MUT_NEW_OBJECT = `  select 'storage.selftest_new_table'::text, 'supabase_storage_admin'::text, 'arwdDxtm'::text, 'arwdDxtm'::text, 'supabase_storage_admin'::text`;

/** CONTROL — the shape that broke the first draft of arm 1: an object whose
 *  OWNER is supabase_admin, granted by supabase_admin. That is upstream, not
 *  ours. `schema storage` is exactly this row and it is live, so an arm keyed
 *  on one constant owner accuses upstream of a grant nobody here can revoke. */
const CTRL_OTHER_UPSTREAM_OWNER = `  select 'storage.selftest_other_owner'::text, 'supabase_admin'::text, 'U'::text, 'U'::text, 'supabase_admin'::text`;

/** ⚠ THE INVERTED PIN for the control above. Byte-identical except the grantor
 *  is postgres. If arm 1 stays silent on THIS too, the exemption is not "the
 *  grantor is the owner", it is "arm 1 never fires". */
const MUT_OTHER_UPSTREAM_OWNER_INVERTED = `  select 'storage.selftest_other_owner'::text, 'supabase_admin'::text, 'U'::text, 'U'::text, 'postgres'::text`;

const BASELINE_WITH_OTHER_OWNER = [...BASELINE, 'storage.selftest_other_owner|anon=U|authenticated=U'];

/** CONTROL — a NEW object nobody can reach. Invisible to every arm; if arm 2
 *  names it, arm 2 is "anything new" rather than "anything new AND reachable". */
const CTRL_UNREACHABLE_NEW = `  select 'storage.selftest_unreachable'::text, 'supabase_storage_admin'::text, ''::text, ''::text, '(none)'::text`;

/** ARM 2b — a BASELINE object that GAINED a letter. Same object, one more
 *  privilege: the shape a Supabase upgrade or a stray grant actually takes. */
const MUT_WIDENED_EXISTING = `  select 'storage.selftest_widened'::text, 'supabase_storage_admin'::text, 'rD'::text, 'r'::text, 'supabase_storage_admin'::text`;
const BASELINE_WITH_WIDENED = [...BASELINE, 'storage.selftest_widened|anon=r|authenticated=r'];

/** CONTROL for 2b — byte-identical except the extra letter is absent. If arm 2
 *  names this too, it is not comparing letters, it is comparing nothing. */
const CTRL_UNCHANGED_EXISTING = `  select 'storage.selftest_widened'::text, 'supabase_storage_admin'::text, 'r'::text, 'r'::text, 'supabase_storage_admin'::text`;

/** ARM 4 — a default-ACL row that still grants the surface. */
const MUT_DEFACL_OPEN = `  select 'r'::text as objtype, '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres}'::aclitem[] as eff_acl, 1::int as row_present`;

/** ARM 4 (missing-row form) — no pg_default_acl row for functions, so the
 *  BUILT-IN default (EXECUTE TO PUBLIC) applies. Must be named, and must say
 *  the row is missing. */
const MUT_DEFACL_MISSING = `  select 'f'::text as objtype, acldefault('f', 'postgres'::regrole) as eff_acl, 0::int as row_present`;

/** CONTROL — a default-ACL row granting only postgres and service_role. Silent. */
const CTRL_DEFACL_CLOSED = `  select 'r'::text as objtype, '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}'::aclitem[] as eff_acl, 1::int as row_present`;

/** ARM 6a — a recorded-private bucket flipped public. */
const MUT_BUCKET_PUBLIC = `  select 'selftest-private-bucket'::text, true`;
/** ARM 6b — a brand-new PUBLIC bucket. */
const MUT_NEW_PUBLIC_BUCKET = `  select 'selftest-new-public'::text, true`;
/** CONTROL — a brand-new PRIVATE bucket. Counted, never failed. */
const CTRL_NEW_PRIVATE_BUCKET = `  select 'selftest-new-private'::text, false`;

async function selftest() {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  const violations = (rows) => rows.filter((r) => r.violation != null).map((r) => r.violation);
  const notes = (rows) => rows.filter((r) => r.note != null).map((r) => r.note);

  // ── DIRECTION 1: the real catalogue must be SILENT and must still count ──
  // ⚠ SILENCE IS REQUIRED ON PRODUCTION ONLY, and that is a statement about
  // which database the GATE reads, not a softer bar. Every other check below
  // asserts a DELTA from `base`, so they are exact whatever `base` is — but
  // "the live catalogue is clean" is a claim about the real perimeter and only
  // production has one. On --dev the baseline is PRINTED IN FULL instead of
  // being asserted, because dev is a rebuilt copy that drifts (register item
  // B-6) and passing a dev run off as a production result is the D-12 defect:
  // a check that was right about the wrong subject.
  const onDev = TARGET_REF === DEV_REF;
  const clean = await runSql(storageWritePerimeterSql());
  const base = violations(clean).length;
  if (onDev) {
    console.log(`  INFO  running against DEV (${DEV_REF}) — the gate reads PRODUCTION. `
      + `${base} live violation(s) here are DEV'S OWN STATE and are NOT asserted away; `
      + `every mutation below asserts a delta from that number.`);
    for (const v of violations(clean)) console.log(`        · ${v.slice(0, 200)}`);
  }
  // NOT a check() on dev — a check that cannot fail inflates the pass count and
  // is the theatre this repo has already paid for. It is simply not run there,
  // and the tally says so.
  if (!onDev) {
    check('live catalogue is silent', base === 0,
      base ? violations(clean).join(' | ').slice(0, 500) : 'no violations');
  }
  check('denominator prints on a PASS', notes(clean).length === 1,
    notes(clean)[0]?.slice(0, 200) ?? '(no note — the denominator is missing)');
  check('the denominator names the KNOWN-BLOCKED items and the escalation doc',
    (notes(clean)[0] ?? '').includes('KNOWN-BLOCKED') && (notes(clean)[0] ?? '').includes(ESCALATION_DOC)
      && (notes(clean)[0] ?? '').includes('storage.objects: anon and authenticated hold TRUNCATE'));

  // ── DIRECTION 2: every finding arm goes red and NAMES the offender ──────
  const m1 = await runSql(storageWritePerimeterSql({ extraObjs: MUT_OUR_GRANT }));
  check('ARM 1 catches + NAMES a storage grant whose grantor is postgres',
    violations(m1).some((v) => v.includes('selftest_our_grant') && v.includes('IS revocable from postgres')),
    `${violations(m1).length} violation(s)`);
  check('ARM 1 mutation moves the count (+2: our-grant arm and widening arm)',
    violations(m1).length === base + 2, `baseline ${base} -> ${violations(m1).length}`);

  const m2 = await runSql(storageWritePerimeterSql({ extraObjs: MUT_NEW_OBJECT }));
  check('ARM 2 catches + NAMES a new reachable storage object',
    violations(m2).some((v) => v.includes('selftest_new_table') && v.includes('not in the baseline at all')),
    `${violations(m2).length} violation(s)`);
  check('ARM 2 mutation moves the count (+1: widening arm only)',
    violations(m2).length === base + 1, `baseline ${base} -> ${violations(m2).length}`);
  check('ARM 2 fires WITHOUT arm 1 — an upstream grant is not called ours',
    !violations(m2).some((v) => v.includes('selftest_new_table') && v.includes('revocable from postgres')));

  const m2b = await runSql(storageWritePerimeterSql({
    extraObjs: MUT_WIDENED_EXISTING, baseline: BASELINE_WITH_WIDENED,
  }));
  check('ARM 2 catches + NAMES a BASELINE object that gained one letter (D)',
    violations(m2b).some((v) => v.includes('selftest_widened') && v.includes('is WIDER than the recorded')),
    `${violations(m2b).length} violation(s)`);
  check('ARM 2 letter-level mutation moves the count (+1)',
    violations(m2b).length === base + 1, `baseline ${base} -> ${violations(m2b).length}`);

  const c2b = await runSql(storageWritePerimeterSql({
    extraObjs: CTRL_UNCHANGED_EXISTING, baseline: BASELINE_WITH_WIDENED,
  }));
  check('CONTROL: the SAME row without the extra letter is NOT named — the arm compares letters',
    !violations(c2b).some((v) => v.includes('selftest_widened')) && violations(c2b).length === base,
    `baseline ${base} -> ${violations(c2b).length}`);

  const m3 = await runSql(storageWritePerimeterSql({
    baseline: [...BASELINE, 'storage.selftest_vanished|anon=arwdDxtm|authenticated=arwdDxtm'],
  }));
  check('ARM 3 catches + NAMES a baseline object that is no longer reachable',
    violations(m3).some((v) => v.includes('selftest_vanished') && v.includes('close register item A-1')),
    `${violations(m3).length} violation(s)`);
  check('ARM 3 mutation moves the count (+1)',
    violations(m3).length === base + 1, `baseline ${base} -> ${violations(m3).length}`);

  // ⚠ THE ONE THAT PROVES THE GATE IS NOT PERMANENTLY RED: pretend Supabase
  //   acted and TRUNCATE came off storage.objects. Arm 3 must say so BY NAME,
  //   because that is the whole mechanism by which A-1 stops being open.
  const m3b = await runSql(storageWritePerimeterSql({
    extraObjs: `  select 'storage.selftest_objects'::text, 'supabase_storage_admin'::text, 'arwdxtm'::text, 'arwdxtm'::text, 'supabase_storage_admin'::text`,
    baseline: [...BASELINE, 'storage.selftest_objects|anon=arwdDxtm|authenticated=arwdDxtm'],
  }));
  check('ARM 3 fires when the BLOCK CLEARS — TRUNCATE gone reads as "re-measure A-1", not as silence',
    violations(m3b).some((v) => v.includes('selftest_objects') && v.includes('GOOD direction'))
      && violations(m3b).length === base + 1,
    `baseline ${base} -> ${violations(m3b).length}`);

  const m4 = await runSql(storageWritePerimeterSql({ defaclSource: MUT_DEFACL_OPEN }));
  check('ARM 4 catches + NAMES a default ACL that still grants anon',
    violations(m4).some((v) => v.includes('objtype r') && v.includes('anon')),
    `${violations(m4).length} violation(s)`);
  // The mutant REPLACES the source, so the vacuity-3 arm fires too (1 type, not 3).
  check('ARM 4 mutation moves the count (+2: the open default and the short population)',
    violations(m4).length === base + 2, `baseline ${base} -> ${violations(m4).length}`);

  const m4b = await runSql(storageWritePerimeterSql({ defaclSource: MUT_DEFACL_MISSING }));
  check('ARM 4 treats a MISSING pg_default_acl row as the BUILT-IN default (PUBLIC EXECUTE), not a clean slate',
    violations(m4b).some((v) => v.includes('PUBLIC') && v.includes('row is MISSING')),
    `${violations(m4b).length} violation(s)`);

  const c4 = await runSql(storageWritePerimeterSql({ defaclSource: CTRL_DEFACL_CLOSED }));
  check('CONTROL: a default ACL granting only postgres/service_role is NOT named by arm 4',
    !violations(c4).some((v) => v.includes('DEFAULT PRIVILEGES')),
    `${violations(c4).length} violation(s) (vacuity-3 expected, since the source is one type)`);

  const m5 = await runSql(storageWritePerimeterSql({
    retained: [...RETAINED, ['anon', 'storage.objects', 'TRUNCATE'], ['authenticated', 'storage.migrations', 'SELECT']],
  }));
  // anon DOES hold TRUNCATE today, so that pair must stay silent; authenticated
  // does NOT hold SELECT on storage.migrations, so that one must fire. One
  // mutation, both polarities.
  check('ARM 5 catches + NAMES a role that has LOST a privilege it must retain',
    violations(m5).some((v) => v.includes('STORAGE IS BROKEN') && v.includes('storage.migrations')),
    `${violations(m5).length} violation(s)`);
  check('ARM 5 stays silent on a privilege that IS held (anon TRUNCATE on storage.objects, today)',
    !violations(m5).some((v) => v.includes('has LOST TRUNCATE on storage.objects'))
      && violations(m5).length === base + 1,
    `baseline ${base} -> ${violations(m5).length}`);

  const m6a = await runSql(storageWritePerimeterSql({
    extraBuckets: MUT_BUCKET_PUBLIC, privateBuckets: [...PRIVATE_BUCKETS, 'selftest-private-bucket'],
  }));
  check('ARM 6a catches + NAMES a recorded-private bucket that is now PUBLIC',
    violations(m6a).some((v) => v.includes('selftest-private-bucket') && v.includes('now PUBLIC')),
    `${violations(m6a).length} violation(s)`);
  check('ARM 6a mutation moves the count (+1)',
    violations(m6a).length === base + 1, `baseline ${base} -> ${violations(m6a).length}`);

  const m6a2 = await runSql(storageWritePerimeterSql({
    privateBuckets: [...PRIVATE_BUCKETS, 'selftest-absent-bucket'],
  }));
  check('ARM 6a catches + NAMES a recorded bucket that has VANISHED',
    violations(m6a2).some((v) => v.includes('selftest-absent-bucket') && v.includes('GONE')),
    `${violations(m6a2).length} violation(s)`);

  const m6b = await runSql(storageWritePerimeterSql({ extraBuckets: MUT_NEW_PUBLIC_BUCKET }));
  check('ARM 6b catches + NAMES a NEW bucket that is PUBLIC',
    violations(m6b).some((v) => v.includes('selftest-new-public') && v.includes('NEW (not in PRIVATE_BUCKETS)')),
    `${violations(m6b).length} violation(s)`);
  check('ARM 6b mutation moves the count (+1)',
    violations(m6b).length === base + 1, `baseline ${base} -> ${violations(m6b).length}`);

  const c6 = await runSql(storageWritePerimeterSql({ extraBuckets: CTRL_NEW_PRIVATE_BUCKET }));
  check('CONTROL: a NEW PRIVATE bucket is counted, never failed (onboarding-attachments is a live design)',
    !violations(c6).some((v) => v.includes('selftest-new-private')) && violations(c6).length === base,
    `baseline ${base} -> ${violations(c6).length}`);

  const c1 = await runSql(storageWritePerimeterSql({ extraObjs: CTRL_UNREACHABLE_NEW }));
  check('CONTROL: a NEW storage object nobody can reach is NOT named',
    !violations(c1).some((v) => v.includes('selftest_unreachable')) && violations(c1).length === base,
    `baseline ${base} -> ${violations(c1).length}`);

  // ── DIRECTION 4: INVERT THE ONE EXEMPTION. A control that is silent because
  //    the arm never fires is not a control at all. ─────────────────────────
  const c7 = await runSql(storageWritePerimeterSql({
    extraObjs: CTRL_OTHER_UPSTREAM_OWNER, baseline: BASELINE_WITH_OTHER_OWNER,
  }));
  check('CONTROL: a SECOND upstream owner granting its own object is NOT called ours (the `schema storage` shape)',
    !violations(c7).some((v) => v.includes('selftest_other_owner')) && violations(c7).length === base,
    `baseline ${base} -> ${violations(c7).length}`);

  const m7 = await runSql(storageWritePerimeterSql({
    extraObjs: MUT_OTHER_UPSTREAM_OWNER_INVERTED, baseline: BASELINE_WITH_OTHER_OWNER,
  }));
  check('INVERTED PIN: the SAME row with grantor=postgres IS named by arm 1',
    violations(m7).some((v) => v.includes('selftest_other_owner') && v.includes('is not its owner'))
      && violations(m7).length === base + 1,
    `baseline ${base} -> ${violations(m7).length} — proves the exemption is grantor==owner, not a dead arm`);

  // ── DIRECTION 3: the vacuity arms. ──────────────────────────────────────
  const v1 = await runSql(storageWritePerimeterSql({ emptyObjects: true }));
  check('VACUITY 1 fires on an empty storage schema',
    violations(v1).some((v) => v.startsWith('VACUOUS: schema `storage` yielded 0 objects')),
    `${violations(v1).length} violation(s)`);

  const v3 = await runSql(storageWritePerimeterSql({ emptyDefacl: true }));
  check('VACUITY 3 fires when the effective-default population is empty',
    violations(v3).some((v) => v.includes('object type(s), not 3')),
    `${violations(v3).length} violation(s)`);

  const v4 = await runSql(storageWritePerimeterSql({ emptyRetained: true }));
  check('VACUITY 4 fires when nothing is checked for RETENTION',
    violations(v4).some((v) => v.includes('0 role/privilege pairs were checked')),
    `${violations(v4).length} violation(s)`);

  console.log(`\n${pass + fail} mutation(s) · ${pass} passed · ${fail} failed  [target: `
    + `${onDev ? `DEV ${DEV_REF} — the live-silence check is NOT run here` : `PRODUCTION ${PROD_REF}`}]`);
  return fail === 0 ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  if (process.argv.includes('--selftest')) {
    process.exit(await selftest());
  } else {
    const rows = await runSql(storageWritePerimeterSql());
    let bad = 0;
    for (const r of rows) {
      if (r.violation != null) { bad++; console.log(` ⚠ ${r.violation}`); }
      else if (r.note != null) { console.log(`   ${r.note}`); }
    }
    console.log(bad === 0 ? '\nSTORAGE PERIMETER HELD — 0 violations' : `\n⚠ ${bad} VIOLATION(S)`);
    process.exit(bad === 0 ? 0 : 1);
  }
}
