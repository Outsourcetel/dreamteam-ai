// ============================================================================
// net-outbound-perimeter.mjs — Ring-0: the OUTBOUND HTTP primitive must stay
// unreachable from the public surface, and the part of it we CAN control must
// stay at zero.
//
// ── WHAT IS ACTUALLY TRUE TODAY, MEASURED 2026-08-21 ──────────────────────
// pg_net installs schema `net`. On this project SIXTEEN net objects — 12
// routines, 2 tables, 1 sequence, and the schema itself — are reachable by
// `anon` and `authenticated`:
//
//   • the 12 routines carry proacl NULL, i.e. the built-in default, which for
//     a function IS `EXECUTE TO PUBLIC`. anon holds it by INHERITANCE, not by
//     a named grant, so `revoke ... from anon` would move the ACL not at all
//     while reading like a repair (the de_kpi_action_value lesson, mig 823).
//   • net.http_request_queue and net._http_response carry an EXPLICIT PUBLIC
//     grant of arwdDxtm. That is worse than "can call http_post": PUBLIC can
//     INSERT straight into the worker's queue and SELECT every response body —
//     and queue rows carry the Authorization header of every internal dispatch.
//   • schema `net` grants USAGE to PUBLIC, anon and authenticated by name.
//     (Contrast `cron` and `vault`, which Supabase scoped correctly: neither
//     anon nor authenticated holds USAGE on those.)
//
// EVERY ONE of those 16 grants has grantor `supabase_admin`.
//
// ── ⚠ WHY THERE IS NO REVOKE HERE, AND WHY THAT IS NOT AN OPINION ─────────
// `postgres` on Supabase is not a superuser, is not a member of supabase_admin,
// and holds NO grant option on any net object (has_function_privilege(...,
// 'EXECUTE WITH GRANT OPTION') = false; has_table_privilege(..., 'SELECT WITH
// GRANT OPTION') = false). PostgreSQL's REVOKE does not RAISE when the revoker
// lacks grant option — it warns and moves on. So the obvious fix RUNS CLEAN AND
// CHANGES NOTHING. Driven on production 2026-08-21 inside a rolled-back
// transaction, top level, not reasoned:
//
//   revoke execute on function net.http_post(...) from anon, authenticated;  -- OK
//   revoke execute on function net.http_post(...) from public;               -- OK
//   revoke usage on schema net from anon, authenticated, public;             -- OK
//   revoke all on table net.http_request_queue from public;                  -- OK
//   → anon EXECUTE on net.http_post: STILL TRUE. schema USAGE: STILL TRUE.
//     INSERT on net.http_request_queue: STILL TRUE.
//
// And the one visible effect is the trap's disguise: proacl moves from NULL to
// `{=X/supabase_admin,supabase_admin=X/supabase_admin}` — the ACL is
// MATERIALISED and nothing is removed. A checker naive enough to assert "proacl
// is no longer NULL" would go green off a change that revoked nothing. Only
// `alter function ... owner to postgres`, `set role supabase_admin` and `alter
// default privileges for role supabase_admin` raise 42501 and say so out loud.
//
// A migration containing those revokes would therefore apply cleanly, land in
// the ledger, and close register item A-3 having done nothing at all. It is not
// shipped. A-3 stays OPEN and BLOCKED, and this arm is the compensating control.
//
// ── SO WHAT DOES THIS ARM RATCHET? THREE THINGS THAT CAN ALL FAIL ─────────
// The baseline above is unfixable from here, so an arm that simply reds on it
// would be permanently red and would teach people to ignore it. What is NOT
// unfixable — and has no gate today — is everything AROUND it:
//
//   ARM 1  a net grant whose GRANTOR IS NOT supabase_admin. That is a grant
//          THIS repo made, and it IS revocable from postgres. 0 today.
//   ARM 2  the surface WIDENS — a reachable net object outside the recorded
//          baseline (a pg_net upgrade adding a routine, a new table, a direct
//          named grant). 0 today.
//   ARM 3  the surface SHRINKS — a baseline object stops being reachable.
//          That is good news and it still fails, LOUDLY, because it means
//          Supabase changed something and A-3 must be re-measured rather than
//          left sitting open forever on a stale finding. Both directions.
//   ARM 4a a function OUTSIDE net, reachable by anon or by PUBLIC, whose body
//          references a real net object. This is the only in-database bridge
//          from the anonymous surface to the outbound pipe, and it is absolute:
//          an anonymous caller has no identity, so there is no legitimate
//          instance and no exemption is needed. 0 today.
//   ARM 4b a net-referencing function reachable by anon/authenticated/PUBLIC
//          that takes a caller-controlled text/json parameter — the SSRF shape.
//          The three authenticated-reachable net callers that exist today
//          (dispatch_eval_driver_internal, dispatch_gap_improve_internal,
//          dispatch_online_eval_internal) take ZERO arguments and hard-code
//          their URL, so they are not this. Add a `p_url text` to any of them
//          and this goes red the same day.
//
// ── THE OTHER HALF OF THE GATE, WHICH IS NOT SQL ──────────────────────────
// None of the 16 grants is REACHABLE today, because `net` is not in PostgREST's
// exposed-schema list. Proven from outside with the publishable anon key:
// GET /rest/v1/http_request_queue with Accept-Profile: net and POST
// /rest/v1/rpc/http_post with Content-Profile: net both return HTTP 406
// PGRST106 — "Only the following schemas are exposed: public, graphql_public".
// That is a project CONFIG setting with no representation in the database, so
// no SQL probe can see it; certify's separate `net-not-exposed` arm asks the
// REST API directly and goes red the day someone flips it. This arm and that
// one are two halves of one gate: this one says the grant has not grown, that
// one says the door has not opened.
//
// ── NO ALLOWLIST, AND NOWHERE TO ADD ONE ──────────────────────────────────
// The baseline is a constant IN THIS FILE, not a JSON file, and `certify
// --pin-allowlist` / `--pin-write` / `--pin-edge` cannot regenerate it. That is
// deliberate: 48 of the 49 breached trigger functions the sibling arm exists
// for sat INSIDE a re-pinnable allowlist, blessed by past pin runs. Widening
// this baseline costs a commit that a human reads.
// ============================================================================

import { readFileSync } from 'node:fs';

/**
 * The sixteen anon/authenticated-reachable objects in schema `net` as measured
 * on production 2026-08-21, every one of them granted by supabase_admin and
 * therefore not revocable from `postgres`. This is register item A-3's subject
 * matter, recorded so the arm can tell "unchanged" from "wider" from "narrower".
 *
 * ⚠ Signatures are pg_get_function_identity_arguments form. A pg_net upgrade
 * that CHANGES a signature reads as one removal plus one addition, which is
 * correct — a changed signature is a changed object.
 */
export const BASELINE = [
  'net._await_response(request_id bigint)',
  'net._encode_url_with_params_array(url text, params_array text[])',
  'net._http_collect_response(request_id bigint, async boolean)',
  'net._http_response',
  'net._urlencode_string(string character varying)',
  'net.check_worker_is_up()',
  'net.http_collect_response(request_id bigint, async boolean)',
  'net.http_delete(url text, params jsonb, headers jsonb, timeout_milliseconds integer, body jsonb)',
  'net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer)',
  'net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)',
  'net.http_request_queue',
  'net.http_request_queue_id_seq',
  'net.wait_until_running()',
  'net.wake()',
  'net.worker_restart()',
  'schema net',
];

/** The role that owns schema `net`. A grant from anyone else is ours to revoke. */
export const UPSTREAM_GRANTOR = 'supabase_admin';

function literal(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Every object in schema `net`, with its reachability by anon / authenticated /
 * PUBLIC and the grantor(s) behind that reachability.
 *
 * ⚠ coalesce(acl, acldefault(...)) is load-bearing. proacl NULL does not mean
 * "ungranted" — it means the built-in default is in force, and for a function
 * that default IS execute-to-PUBLIC. aclexplode over a NULL acl returns zero
 * rows, so without the coalesce every born-public routine would read as clean.
 */
export const NET_OBJECT_SOURCE = `
  select 'function'::text as kind,
         ('net.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text as obj,
         has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x,
         exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x,
         coalesce((select string_agg(distinct a.grantor::regrole::text, '+')
                     from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where a.grantee = 0
                       or a.grantee = 'anon'::regrole::oid
                       or a.grantee = 'authenticated'::regrole::oid), '(none)') as grantors
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'net'
  union all
  select 'relation',
         ('net.' || c.relname)::text,
         case when c.relkind = 'S'
              then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
              else has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end,
         case when c.relkind = 'S'
              then has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE')
              else has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end,
         exists (select 1 from aclexplode(coalesce(c.relacl,
                   acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
                  where a.grantee = 0),
         coalesce((select string_agg(distinct a.grantor::regrole::text, '+')
                     from aclexplode(coalesce(c.relacl,
                            acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
                    where a.grantee = 0
                       or a.grantee = 'anon'::regrole::oid
                       or a.grantee = 'authenticated'::regrole::oid), '(none)')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'net' and c.relkind in ('r','p','v','m','S','f')
  union all
  select 'schema',
         'schema net',
         has_schema_privilege('anon', n.oid, 'USAGE'),
         has_schema_privilege('authenticated', n.oid, 'USAGE'),
         exists (select 1 from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                  where a.grantee = 0 and a.privilege_type = 'USAGE'),
         coalesce((select string_agg(distinct a.grantor::regrole::text, '+')
                     from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                    where a.grantee = 0
                       or a.grantee = 'anon'::regrole::oid
                       or a.grantee = 'authenticated'::regrole::oid), '(none)')
    from pg_namespace n
   where n.nspname = 'net'`;

/**
 * Every function OUTSIDE schema net, with the three facts arm 4 needs: is it
 * reachable from the public surface, does its body reference a real net object,
 * and does it take a parameter a caller could put a URL in.
 *
 * ⚠ COMMENTS ARE STRIPPED. prosrc returns them, and this repo's own fix
 * commentary names `net.http_post` in prose — decide_discovery_proposal carries
 * exactly that and is authenticated-reachable, so an unstripped matcher reports
 * it as a bridge to the outbound pipe. It is not one. The naive count is kept
 * alongside so a strip that ate the body cannot pass as a clean result.
 *
 * ⚠ THE NAME SIEVE COMES FROM THE CATALOGUE, not a hardcoded list. A bare
 * `net\\.` matcher is wrong in both directions here: it misses a routine pg_net
 * adds tomorrow, and it MATCHES 'net.uk' and 'ukr.net' inside the email-domain
 * denylist functions, both of which are authenticated-reachable. Requiring a
 * real net object name after the dot, plus a non-word non-dot character before
 * it, removes both false positives — verified against those two functions.
 *
 * ⚠ TRIGGER-SHAPED FUNCTIONS ARE FLAGGED, NOT DROPPED. extensions
 * .grant_pg_net_access() is anon-EXECUTE-able and its body names net.http_get,
 * so the first draft of arm 4a reported it as an anonymous bridge. It is not
 * one: it returns `event_trigger`, so PostgREST will not expose it and Postgres
 * rejects a direct call — the same reason trigger-execute-perimeter.mjs exists
 * one class over. It is also owned by supabase_admin, so the revoke the arm
 * would have demanded is itself a no-op. The column is carried and COUNTED in
 * the denominator rather than filtered away in the FROM clause, because an
 * exclusion nobody can see is how a population quietly becomes empty.
 */
export const NET_CALLER_SOURCE = `
  select (n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text as sig,
         p.prosecdef as secdef,
         has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x,
         exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x,
         exists (select 1 from unnest(p.proargtypes::oid[]) t
                  where format_type(t, null) ~ '(text|character varying|json|jsonb|xml|bytea)') as caller_text_param,
         (rt.typname in ('trigger', 'event_trigger')) as trigger_shaped,
         regexp_replace(regexp_replace(p.prosrc, '/\\*.*?\\*/', ' ', 'g'), '--[^\\n]*', ' ', 'g') as body,
         p.prosrc as body_naive
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type rt on rt.oid = p.prorettype
   where n.nspname not in ('net', 'pg_catalog', 'information_schema', 'pg_toast')
     and p.prokind = 'f'
     and p.prosrc is not null`;

/**
 * @param {object} [opts]
 * @param {string} [opts.objSource]      relation of (kind, obj, anon_x, auth_x, public_x, grantors)
 * @param {string} [opts.callerSource]   relation of (sig, secdef, anon_x, auth_x, public_x, caller_text_param, body, body_naive)
 * @param {string} [opts.extraObjs]      a SELECT unioned into the object population (mutation)
 * @param {string} [opts.extraCallers]   a SELECT unioned into the caller population (mutation)
 * @param {string[]} [opts.baseline]     substitutable so the shrink arm can be driven
 * @param {boolean} [opts.emptyObjects]  drive the object-vacuity arm
 * @param {boolean} [opts.blindNetNames] drive the sieve-vacuity arm
 */
export function netOutboundPerimeterSql(opts = {}) {
  const {
    objSource = NET_OBJECT_SOURCE,
    callerSource = NET_CALLER_SOURCE,
    extraObjs = null,
    extraCallers = null,
    baseline = BASELINE,
    emptyObjects = false,
    blindNetNames = false,
  } = opts;

  const objs = emptyObjects
    ? `select null::text as kind, null::text as obj, null::boolean as anon_x, null::boolean as auth_x, null::boolean as public_x, null::text as grantors where false`
    : (extraObjs ? `${objSource}\n  union all\n${extraObjs}` : objSource);
  const callers = extraCallers ? `${callerSource}\n  union all\n${extraCallers}` : callerSource;

  // The sieve. `blindNetNames` empties it so the vacuity arm can be driven —
  // an empty alternation would otherwise silently match nothing and arm 4 would
  // clear every function that has ever existed.
  const nameSource = blindNetNames
    ? `select null::text as nm where false`
    : `select p.proname::text as nm from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'net'
       union
       select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'net'`;

  return `
with objs as (${objs}),
callers_raw as (${callers}),
baseline(obj) as (values ${baseline.map((b) => '(' + literal(b) + ')').join(', ')}),
net_names as (${nameSource}),
sieve as (
  select count(*)::int as n_names,
         case when count(*) = 0 then null
              else '(^|[^A-Za-z0-9_."])net[[:space:]]*\\.[[:space:]]*"?(' || string_agg(nm, '|') || ')\\y'
         end as re
    from net_names
),
callers as (
  select c.*,
         (s.re is not null and c.body      ~* s.re) as mentions_net,
         (s.re is not null and c.body_naive ~* s.re) as mentions_net_naive
    from callers_raw c cross join sieve s
),
reachable as (select * from objs where anon_x or auth_x or public_x),
counted as (
  select (select count(*) from objs)                                             as n_objs,
         (select count(*) from reachable)                                        as n_reachable,
         (select count(*) from reachable where grantors <> ${literal(UPSTREAM_GRANTOR)}) as n_ours,
         (select count(*) from baseline)                                         as n_baseline,
         (select count(*) from callers)                                          as n_callers,
         (select count(*) from callers where mentions_net)                       as n_net_callers,
         (select count(*) from callers where mentions_net_naive)                 as n_net_callers_naive,
         (select count(*) from callers where mentions_net and not trigger_shaped and (anon_x or auth_x or public_x)) as n_bridge_reachable,
         (select count(*) from callers where mentions_net and not trigger_shaped and (anon_x or public_x))           as n_bridge_anon,
         (select count(*) from callers where mentions_net and not trigger_shaped and (anon_x or auth_x or public_x) and caller_text_param) as n_bridge_param,
         (select count(*) from callers where mentions_net and trigger_shaped) as n_trigger_shaped,
         (select n_names from sieve)                                             as n_names,
         (select count(*) from objs where anon_x)                                as n_anon_any
)

-- ── ARM 1: a net grant THIS REPO made. The only revocable half, absolute. ──
select r.obj || ': reachable by ' || nullif(concat_ws(', ',
         case when r.public_x then 'PUBLIC' end,
         case when r.anon_x   then 'anon'   end,
         case when r.auth_x   then 'authenticated' end), '')
       || ' via a grant whose grantor is ' || r.grantors || ', not ' || ${literal(UPSTREAM_GRANTOR)}
       || '. That grant was made from THIS project and IS revocable from postgres — '
       || 'unlike the sixteen upstream ones, where REVOKE runs clean and changes nothing. '
       || 'Revoke it in the migration that created it. Not allowlistable.' as violation,
       null::text as note
  from reachable r
 where r.grantors <> ${literal(UPSTREAM_GRANTOR)}

union all

-- ── ARM 2: the surface got WIDER. ─────────────────────────────────────────
select r.obj || ': reachable by anon/authenticated/PUBLIC and NOT in the recorded '
       || 'baseline of ' || (select n_baseline from counted)::text || ' object(s) (register item A-3). '
       || 'Either pg_net gained an object or someone granted one. Establish which, then '
       || 'either revoke it (if the grantor is postgres) or add it to BASELINE in '
       || 'scripts/net-outbound-perimeter.mjs in a commit a human reads — there is no --pin flag for this.' as violation,
       null::text as note
  from reachable r
 where not exists (select 1 from baseline b where b.obj = r.obj)

union all

-- ── ARM 3: the surface got NARROWER. Both directions, deliberately. ───────
-- Good news still fails. A-3 has been open since 2026-08-10 on a measurement;
-- if the measurement stops being true the item must be re-measured, not left
-- sitting open on a finding that has quietly expired.
select b.obj || ': recorded in the A-3 baseline as reachable by anon/authenticated, '
       || 'and it is NOT reachable now (or the object is gone). This is the good direction '
       || 'and it is still a failure: re-measure register item A-3 with '
       || '\`node scripts/net-outbound-perimeter.mjs\`, and if the hole has genuinely closed, '
       || 'close A-3 with \`npm run defer -- --close A-3 --by "<what closed it>"\` and shrink BASELINE.' as violation,
       null::text as note
  from baseline b
 where not exists (select 1 from reachable r where r.obj = b.obj)

union all

-- ── ARM 4a: an ANONYMOUS bridge to the outbound pipe. Absolute. ───────────
select c.sig || ': EXECUTE is reachable by '
       || nullif(concat_ws(', ', case when c.public_x then 'PUBLIC' end,
                                 case when c.anon_x then 'anon' end), '')
       || ' and its body references schema \`net\`. That is a bridge from the ANONYMOUS '
       || 'surface to the outbound HTTP primitive: PostgREST exposes public, so this is '
       || 'callable with nothing but the publishable key. An anonymous caller has no identity '
       || 'to authorise anything, so there is no legitimate instance of this shape and no '
       || 'exemption exists. Revoke: revoke execute on function ' || c.sig
       || ' from public, anon;' as violation,
       null::text as note
  from callers c
 where c.mentions_net and not c.trigger_shaped and (c.anon_x or c.public_x)

union all

-- ── ARM 4b: the SSRF shape — a reachable net caller taking caller text. ───
select c.sig || ': reachable by '
       || nullif(concat_ws(', ', case when c.public_x then 'PUBLIC' end,
                                 case when c.anon_x then 'anon' end,
                                 case when c.auth_x then 'authenticated' end), '')
       || ', references schema \`net\`, and takes a caller-supplied text/json parameter. '
       || 'A caller who can influence the request is the SSRF shape this perimeter exists to '
       || 'prevent — the database would issue the request, from inside the VPC, as its own origin. '
       || 'The net-calling dispatchers are safe today only because they take ZERO arguments and '
       || 'hard-code their URL. If this one must keep its parameter, it must not be reachable: '
       || 'revoke execute on function ' || c.sig || ' from public, anon, authenticated;' as violation,
       null::text as note
  from callers c
 where c.mentions_net and not c.trigger_shaped and (c.anon_x or c.auth_x or c.public_x) and c.caller_text_param

union all

-- ── VACUITY 1: no net objects at all. ────────────────────────────────────
select case when c.n_objs = 0
            then 'VACUOUS: schema \`net\` yielded 0 objects. Either pg_net is gone — which would '
                 || 'break every cron dispatcher — or this probe read nothing. A perimeter that '
                 || 'compared nothing is indistinguishable from a perimeter that held.'
       end, null::text
  from counted c

union all

-- ── VACUITY 2: has_*_privilege has stopped discriminating. ───────────────
select case when c.n_objs > 0 and c.n_anon_any = 0
            then 'VACUOUS: not one object in schema \`net\` came back reachable by anon, including '
                 || 'the twelve routines whose proacl is NULL (which MEANS execute-to-PUBLIC). '
                 || 'has_function_privilege() is answering false for everything, so every arm above '
                 || 'is passing by construction. Either the privilege test broke or ARM 3 should '
                 || 'have fired first — check which.'
       end, null::text
  from counted c

union all

-- ── VACUITY 3: the net-name sieve matched nothing. ───────────────────────
select case when c.n_names = 0
            then 'VACUOUS: the net-object name sieve is EMPTY, so arms 4a and 4b match no body and '
                 || 'clear every function that has ever existed. The sieve is built from the '
                 || 'catalogue; if it is empty, the catalogue read is broken.'
       end, null::text
  from counted c

union all

-- ── VACUITY 4: the body matcher found no callers at all. ────────────────
-- 24 SECURITY DEFINER dispatchers call net.http_post on this database. Zero is
-- not a clean result, it is a broken regex.
select case when c.n_callers > 0 and c.n_net_callers = 0
            then 'VACUOUS: the body matcher found 0 function(s) referencing schema \`net\` out of '
                 || c.n_callers::text || ' examined. Two dozen dispatchers call net.http_post on this '
                 || 'database, so 0 means the matcher is broken, not that the bridge is closed.'
       end, null::text
  from counted c

union all

-- ── VACUITY 5: the comment strip has never been exercised. ──────────────
-- If stripping comments never removes a match, the strip is a no-op and the
-- false positive it exists to kill (a fix comment NAMING net.http_post inside
-- an authenticated-reachable function) would be back the moment it regressed.
select case when c.n_net_callers_naive <= c.n_net_callers
            then 'VACUOUS: the comment strip removed no net mention (naive ' || c.n_net_callers_naive::text
                 || ' <= stripped ' || c.n_net_callers::text || '). It exists because decide_discovery_proposal '
                 || 'is authenticated-reachable and NAMES net.http_post in a comment; if the strip has '
                 || 'stopped firing, arms 4a/4b are being fed prose.'
       end, null::text
  from counted c

union all

-- ── THE DENOMINATOR, printed on a PASS as well as a fail. ───────────────
select null::text,
       format('net-outbound-perimeter: examined %s object(s) in schema net, %s reachable by anon/authenticated/PUBLIC (baseline %s, register item A-3 — BLOCKED, not accepted: every one is granted by %s and REVOKE from postgres runs clean and changes nothing). %s of them carry a grantor this project controls — that number must be 0 and is the only revocable half. Bridge scan: %s function(s) outside net examined, %s reference schema net (%s before comment-stripping), %s of those are reachable from the public surface, %s by anon/PUBLIC (must be 0), %s take a caller-supplied text/json parameter (must be 0). %s net-referencing function(s) return trigger/event_trigger and are EXCLUDED from arms 4a/4b by construction — PostgREST cannot expose them and Postgres rejects a direct call (extensions.grant_pg_net_access is the live example). The EXPOSURE half is not SQL and is not here: certify''s net-not-exposed arm asks the REST API whether schema net answers. No allowlist — no --pin flag can clear any of this.',
              n_objs::text, n_reachable::text, n_baseline::text, ${literal(UPSTREAM_GRANTOR)},
              n_ours::text, n_callers::text, n_net_callers::text, n_net_callers_naive::text,
              n_bridge_reachable::text, n_bridge_anon::text, n_bridge_param::text, n_trigger_shaped::text)
  from counted
`;
}

// ── CLI ───────────────────────────────────────────────────────────────────
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';

function readToken() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function runSql(sql, ref = PROD_REF) {
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

/** ARM 1 — a net grant made by postgres. Revocable, and must be named. */
const MUT_OUR_GRANT = `  select 'function'::text, 'net.selftest_our_grant()'::text, true, true, false, 'postgres'::text`;

/** ARM 2 — a NEW reachable net object nobody recorded (upstream grantor, so
 *  arm 1 must stay silent and only the widening arm may fire). */
const MUT_WIDENED = `  select 'function'::text, 'net.selftest_new_routine()'::text, true, true, true, 'supabase_admin'::text`;

/** CONTROL — a net object that is NOT reachable and not in the baseline. It is
 *  invisible to every arm; if arm 2 names it, arm 2 is "anything new" rather
 *  than "anything new AND reachable". */
const CTRL_UNREACHABLE_NEW = `  select 'function'::text, 'net.selftest_unreachable()'::text, false, false, false, 'supabase_admin'::text`;

/** ARM 4a — an anon-reachable function whose body calls net.http_post. */
const MUT_ANON_BRIDGE = `  select 'public.selftest_anon_bridge()'::text, false, true, true, true, false, false,
         'begin perform net.http_post(''https://x''); end'::text,
         'begin perform net.http_post(''https://x''); end'::text`;

/** ARM 4b — authenticated-reachable, net-calling, and takes caller text. Must
 *  fire 4b and NOT 4a (anon false, public false), or the two arms are one arm. */
const MUT_PARAM_BRIDGE = `  select 'public.selftest_param_bridge(p_url text)'::text, true, false, true, false, true, false,
         'begin perform net.http_post(p_url); end'::text,
         'begin perform net.http_post(p_url); end'::text`;

/** CONTROL — the shape that exists TODAY and is legitimate: authenticated-
 *  reachable, calls net, takes no parameters. Must be named by NOTHING. */
const CTRL_ZERO_ARG_DISPATCHER = `  select 'public.selftest_zero_arg_dispatcher()'::text, true, false, true, false, false, false,
         'begin perform net.http_post(''https://fixed''); end'::text,
         'begin perform net.http_post(''https://fixed''); end'::text`;

/** CONTROL — the false positive that broke the first draft: an authenticated-
 *  reachable function containing 'net.uk' and 'ukr.net' string literals. Both
 *  are real, live, and must stay silent. */
const CTRL_EMAIL_DOMAINS = `  select 'public.selftest_email_domains()'::text, false, false, true, false, true, false,
         'select array[''co.uk'',''net.uk'',''ukr.net'',''net.au'']'::text,
         'select array[''co.uk'',''net.uk'',''ukr.net'',''net.au'']'::text`;

/** CONTROL — authenticated-reachable and NAMES net.http_post in a COMMENT only.
 *  decide_discovery_proposal is exactly this. The strip must silence it. */
const CTRL_COMMENT_ONLY = `  select 'public.selftest_comment_only()'::text, true, false, true, false, false, false,
         'begin -- net.http_post returns a request id, not a reply\n null; end'::text,
         'begin -- net.http_post returns a request id, not a reply\n null; end'::text`;

/** CONTROL — the extensions.grant_pg_net_access shape: anon AND PUBLIC
 *  reachable, body names net.http_get, but it RETURNS event_trigger, so it is
 *  uncallable by any of them. Must stay silent. */
const CTRL_TRIGGER_SHAPED = `  select 'extensions.selftest_trigger_shaped()'::text, false, true, true, true, false, true,
         'begin alter function net.http_get(url text) security definer; end'::text,
         'begin alter function net.http_get(url text) security definer; end'::text`;

/** ⚠ THE INVERTED PIN for the control above. Byte-identical except
 *  trigger_shaped=false. If arm 4a stays silent on THIS too, the exclusion is
 *  not "trigger-shaped functions are uncallable", it is "arm 4a never fires". */
const MUT_TRIGGER_SHAPED_INVERTED = `  select 'extensions.selftest_trigger_shaped()'::text, false, true, true, true, false, false,
         'begin alter function net.http_get(url text) security definer; end'::text,
         'begin alter function net.http_get(url text) security definer; end'::text`;

/** CONTROL — a net-calling function reachable by NOBODY. Must stay silent. */
const CTRL_UNREACHABLE_CALLER = `  select 'public.selftest_unreachable_caller(p_url text)'::text, true, false, false, false, true, false,
         'begin perform net.http_post(p_url); end'::text,
         'begin perform net.http_post(p_url); end'::text`;

async function selftest() {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  const violations = (rows) => rows.filter((r) => r.violation != null).map((r) => r.violation);
  const notes = (rows) => rows.filter((r) => r.note != null).map((r) => r.note);

  // ── DIRECTION 1: the real catalogue must be SILENT and must still count ──
  const clean = await runSql(netOutboundPerimeterSql());
  const base = violations(clean).length;
  check('live catalogue is silent', base === 0,
    base ? violations(clean).join(' | ').slice(0, 400) : 'no violations');
  check('denominator prints on a PASS', notes(clean).length === 1,
    notes(clean)[0]?.slice(0, 240) ?? '(no note — the denominator is missing)');

  // ── DIRECTION 2: every finding arm goes red and NAMES the offender ──────
  const m1 = await runSql(netOutboundPerimeterSql({ extraObjs: MUT_OUR_GRANT }));
  check('ARM 1 catches + NAMES a net grant whose grantor is postgres',
    violations(m1).some((v) => v.includes('net.selftest_our_grant') && v.includes('IS revocable from postgres')),
    `${violations(m1).length} violation(s)`);
  // It is also outside the baseline, so arm 2 must fire too: +2.
  check('ARM 1 mutation moves the count (+2: our-grant arm and widening arm)',
    violations(m1).length === base + 2, `baseline ${base} -> ${violations(m1).length}`);

  const m2 = await runSql(netOutboundPerimeterSql({ extraObjs: MUT_WIDENED }));
  check('ARM 2 catches + NAMES a new reachable net object',
    violations(m2).some((v) => v.includes('net.selftest_new_routine') && v.includes('NOT in the recorded')),
    `${violations(m2).length} violation(s)`);
  check('ARM 2 mutation moves the count (+1: widening arm only)',
    violations(m2).length === base + 1, `baseline ${base} -> ${violations(m2).length}`);
  check('ARM 2 fires WITHOUT arm 1 — an upstream grant is not called ours',
    !violations(m2).some((v) => v.includes('net.selftest_new_routine') && v.includes('revocable from postgres')));

  const m3 = await runSql(netOutboundPerimeterSql({ baseline: [...BASELINE, 'net.selftest_vanished()'] }));
  check('ARM 3 catches + NAMES a baseline object that is no longer reachable',
    violations(m3).some((v) => v.includes('net.selftest_vanished') && v.includes('re-measure register item A-3')),
    `${violations(m3).length} violation(s)`);
  check('ARM 3 mutation moves the count (+1)',
    violations(m3).length === base + 1, `baseline ${base} -> ${violations(m3).length}`);

  const m4 = await runSql(netOutboundPerimeterSql({ extraCallers: MUT_ANON_BRIDGE }));
  check('ARM 4a catches + NAMES an anon-reachable bridge into schema net',
    violations(m4).some((v) => v.includes('selftest_anon_bridge') && v.includes('ANONYMOUS')),
    `${violations(m4).length} violation(s)`);
  check('ARM 4a mutation moves the count (+1: no text parameter, so 4b stays quiet)',
    violations(m4).length === base + 1, `baseline ${base} -> ${violations(m4).length}`);

  const m5 = await runSql(netOutboundPerimeterSql({ extraCallers: MUT_PARAM_BRIDGE }));
  check('ARM 4b catches + NAMES the SSRF shape (net caller with caller-supplied text)',
    violations(m5).some((v) => v.includes('selftest_param_bridge') && v.includes('SSRF shape')),
    `${violations(m5).length} violation(s)`);
  check('ARM 4b mutation moves the count (+1: authenticated only, so 4a stays quiet)',
    violations(m5).length === base + 1, `baseline ${base} -> ${violations(m5).length}`);
  check('ARM 4b fires WITHOUT arm 4a — the two arms are genuinely independent',
    !violations(m5).some((v) => v.includes('selftest_param_bridge') && v.includes('ANONYMOUS')));

  const v1 = await runSql(netOutboundPerimeterSql({ emptyObjects: true }));
  check('VACUITY 1 fires on an empty net schema',
    violations(v1).some((v) => v.startsWith('VACUOUS: schema `net` yielded 0 objects')),
    `${violations(v1).length} violation(s)`);

  const v3 = await runSql(netOutboundPerimeterSql({ blindNetNames: true }));
  check('VACUITY 3 fires when the net-name sieve is empty',
    violations(v3).some((v) => v.includes('name sieve is EMPTY')),
    `${violations(v3).length} violation(s)`);
  check('VACUITY 4 fires alongside it — a blind sieve finds no callers either',
    violations(v3).some((v) => v.includes('body matcher found 0 function(s)')));
  check('VACUITY 5 fires alongside it — a blind sieve strips nothing either',
    violations(v3).some((v) => v.includes('comment strip removed no net mention')));

  // ── DIRECTION 3: the controls. An arm that reds on everything is not a
  //    checker either, so every near-miss shape must stay SILENT. ──────────
  const c1 = await runSql(netOutboundPerimeterSql({ extraObjs: CTRL_UNREACHABLE_NEW }));
  check('CONTROL: a NEW net object nobody can reach is NOT named',
    !violations(c1).some((v) => v.includes('selftest_unreachable')) && violations(c1).length === base,
    `baseline ${base} -> ${violations(c1).length}`);

  const c2 = await runSql(netOutboundPerimeterSql({ extraCallers: CTRL_ZERO_ARG_DISPATCHER }));
  check('CONTROL: authenticated-reachable net caller with ZERO arguments is NOT named',
    !violations(c2).some((v) => v.includes('selftest_zero_arg_dispatcher')) && violations(c2).length === base,
    `baseline ${base} -> ${violations(c2).length}`);

  const c3 = await runSql(netOutboundPerimeterSql({ extraCallers: CTRL_EMAIL_DOMAINS }));
  check("CONTROL: 'net.uk' / 'ukr.net' string literals are NOT a net reference",
    !violations(c3).some((v) => v.includes('selftest_email_domains')) && violations(c3).length === base,
    `baseline ${base} -> ${violations(c3).length}`);

  const c4 = await runSql(netOutboundPerimeterSql({ extraCallers: CTRL_COMMENT_ONLY }));
  check('CONTROL: a net.http_post mention in a COMMENT is stripped, not reported',
    !violations(c4).some((v) => v.includes('selftest_comment_only')) && violations(c4).length === base,
    `baseline ${base} -> ${violations(c4).length}`);

  const c5 = await runSql(netOutboundPerimeterSql({ extraCallers: CTRL_UNREACHABLE_CALLER }));
  check('CONTROL: a net caller reachable by nobody is NOT named',
    !violations(c5).some((v) => v.includes('selftest_unreachable_caller')) && violations(c5).length === base,
    `baseline ${base} -> ${violations(c5).length}`);

  // ── DIRECTION 4: INVERT THE ONE EXEMPTION. A control that is silent because
  //    the arm never fires is not a control at all. ───────────────────────
  const c6 = await runSql(netOutboundPerimeterSql({ extraCallers: CTRL_TRIGGER_SHAPED }));
  check('CONTROL: an anon-reachable net referencer that RETURNS event_trigger is NOT named',
    !violations(c6).some((v) => v.includes('selftest_trigger_shaped')) && violations(c6).length === base,
    `baseline ${base} -> ${violations(c6).length}`);

  const m6 = await runSql(netOutboundPerimeterSql({ extraCallers: MUT_TRIGGER_SHAPED_INVERTED }));
  check('INVERTED PIN: the SAME row with trigger_shaped=false IS named by arm 4a',
    violations(m6).some((v) => v.includes('selftest_trigger_shaped') && v.includes('ANONYMOUS'))
      && violations(m6).length === base + 1,
    `baseline ${base} -> ${violations(m6).length} — proves the exclusion is the trigger shape, not a dead arm`);

  console.log(`\n${pass + fail} mutation(s) · ${pass} passed · ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  if (process.argv.includes('--selftest')) {
    process.exit(await selftest());
  } else {
    const rows = await runSql(netOutboundPerimeterSql());
    let bad = 0;
    for (const r of rows) {
      if (r.violation != null) { bad++; console.log(` ⚠ ${r.violation}`); }
      else if (r.note != null) { console.log(`   ${r.note}`); }
    }
    console.log(bad === 0 ? '\nOUTBOUND PERIMETER HELD — 0 violations' : `\n⚠ ${bad} VIOLATION(S)`);
    process.exit(bad === 0 ? 0 : 1);
  }
}
