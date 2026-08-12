// ============================================================================
// trigger-execute-perimeter.mjs — Ring-0: no trigger function in `public` may
// be EXECUTE-reachable by PUBLIC, anon or authenticated.
//
// ── WHY THIS EXISTS BESIDE THE EXECUTE ALLOWLIST, NOT INSTEAD OF IT ────────
// certify has pinned the anon/authenticated EXECUTE surface since migs 610/630
// and it was NEVER BLIND to trigger functions: a function returning `trigger`
// has prokind='f' like any other, so PERIMETER_SQL saw all of them. That is the
// distinction worth writing down — this was not a gate that could not see the
// class. It saw it, and 48 of the 49 breached trigger functions were IN the
// pinned allowlist, blessed as accepted state by past `--pin-allowlist` runs.
// Only the 49th (playbook_definitions_set_kind, created on an unmerged branch)
// was red, because it arrived after the last pin.
//
// So the weakness was never coverage. It was that the allowlist is RE-PINNABLE,
// and one flag closes any red it produces. certify.mjs already records the near
// miss in its own header: a concurrent session's new function, granted to anon
// AND authenticated, was swept into the EXECUTE pin by a --pin-allowlist run
// meant only to record some revokes, and had to be reverted by hand.
//
// This arm has NO allowlist and NO exemption, so a fiftieth trigger function
// cannot be made green by re-pinning. It can only be made green by the revoke.
//
// ── WHY THE RULE IS ABSOLUTE, AND NOT A JUDGEMENT CALL ────────────────────
// A function returning `trigger` cannot be invoked by anon or authenticated
// through any path the product has: PostgREST will not expose it, and Postgres
// rejects a direct call. And EXECUTE on a trigger function is checked at CREATE
// TRIGGER time, NOT at fire time — proven by driving it (mig 722 §3, and a
// four-arm rolled-back drive on dev AND production on 2026-08-12: three real
// trigger functions fired for role `authenticated` holding no EXECUTE, plus a
// control table with no trigger attached that correctly did NOT fire, so the
// harness can tell a dead trigger from a live one).
//
// ⚠ THE RECEIVED REASON FOR THIS IS WRONG AND WORTH CORRECTING, because the
// wrong reason licenses a dangerous revoke elsewhere. "Trigger functions run as
// the table owner" is FALSE: in the same experiment a SECURITY INVOKER trigger
// function fired with current_user = 'authenticated'. Triggers run as the
// CALLER. It follows that a HELPER function called from a trigger body IS
// privilege-checked at call time — which is exactly why mig 722 left the 20
// non-trigger PUBLIC-EXECUTE helpers alone (playbook_next_fire_at is called by
// the playbook_schedules_compute_next trigger) rather than sweeping them in.
//
// ── ⚠ THE GENERATOR IS STILL OPEN, AND THAT IS WHY THIS ARM IS THE DEFENCE ─
// A brand new function created by `postgres` in `public` on production TODAY is
// born with proacl `=X/postgres` — PUBLIC EXECUTE — measured by creating one in
// a rolled-back transaction and reading its ACL back, not inferred. Unlike the
// TABLE case (mig 715, write-perimeter ARM 3), THERE IS NO DATABASE-SIDE FIX:
// `alter default privileges in schema public revoke execute on functions from
// public` was tried on dev in both orderings, with and without a companion
// grant, and a newly created function still came out with `=X/postgres` every
// time. Every migration must therefore carry its own REVOKE, and the only thing
// that can catch the migration that forgets is this gate.
// ============================================================================

/**
 * The live catalogue read. Exported so the mutation suite UNIONs its fixture
 * into the REAL population instead of retyping the query — mig 661 shipped a
 * pin that could not fail because the check and the thing it checked had
 * drifted apart.
 */
export const TRIGGER_FN_SOURCE = `
      select p.proname::text as fn_name,
             has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
             -- a NULL proacl means the built-in default is in force, and the
             -- built-in default for a function IS execute-to-PUBLIC
             (p.proacl is null or '=X/postgres' = any(p.proacl::text[]))  as public_x,
             has_function_privilege(p.proowner::regrole::text, p.oid, 'EXECUTE') as owner_x
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_type t      on t.oid = p.prorettype
       where n.nspname = 'public'
         and p.prokind = 'f'
         and t.typname = 'trigger'`;

/**
 * @param {object} [opts]
 * @param {string} [opts.fnSource] Relation yielding one row per trigger-returning
 *   function in public, as (fn_name text, anon bool, authed bool, public_x bool,
 *   owner_x bool). Substitutable so the mutation suite drives the REAL predicate
 *   over a synthesised catalogue rather than a paraphrase of it. Substitute an
 *   empty set to prove the no-comparisons arm fires.
 */
export function triggerExecutePerimeterSql(opts = {}) {
  const { fnSource = TRIGGER_FN_SOURCE } = opts;

  return `
with fns as (${fnSource}),
counted as (
  select (select count(*) from fns) as n_examined,
         (select count(*) from fns where anon or authed or public_x) as n_breached
)

-- ── ARM 1: the hard rule. No allowlist, no exemption, not re-pinnable. ──────
select f.fn_name || '(): EXECUTE is reachable by '
       || nullif(concat_ws(', ',
            case when f.public_x then 'PUBLIC' end,
            case when f.anon     then 'anon'   end,
            case when f.authed   then 'authenticated' end), '')
       || '. A function returning trigger cannot be called by any of them — '
       || 'PostgREST will not expose it and Postgres rejects a direct call — and '
       || 'EXECUTE is checked at CREATE TRIGGER time, not at fire time, so the '
       || 'grant buys nothing and the trigger keeps firing without it (mig 722, '
       || 'driven on dev and prod). This is migs 610/630 doctrine and it is NOT '
       || 'allowlistable: do not --pin-allowlist it, add the revoke to the '
       || 'migration that created the function: revoke execute on function '
       || 'public.' || f.fn_name || '() from public, anon, authenticated;' as violation,
       null::text as note
  from fns f
 where f.anon or f.authed or f.public_x

union all

-- ── ARM 2: BOTH HALVES. A revoke that took too much wears the same mask. ───
-- mig 643 nearly left 11 of 12 workspaces administrable by nobody, and REVOKE
-- reports nothing either way. If the OWNER cannot execute its own trigger
-- function, the revoke overshot: CREATE TRIGGER on it will fail, so the next
-- migration that re-attaches or re-creates the trigger dies — and until then
-- nothing looks wrong at all.
select f.fn_name || '(): the function OWNER holds no EXECUTE. A revoke overshot '
       || '— CREATE TRIGGER on this function will now fail, and nothing will say '
       || 'so until the next migration tries to attach it. Restore it: grant '
       || 'execute on function public.' || f.fn_name || '() to postgres;' as violation,
       null::text as note
  from fns f
 where not f.owner_x

union all

-- ── THE DENOMINATOR. Zero findings from zero comparisons is not a pass. ────
select case when c.n_examined = 0
            then 'no-comparisons: the trigger-execute perimeter examined 0 '
                 || 'trigger function(s) in public. It read nothing, and a probe '
                 || 'that compared nothing is indistinguishable from a clean one.'
       end as violation,
       case when c.n_examined > 0
            then 'trigger-execute-perimeter: examined ' || c.n_examined
                 || ' trigger-returning function(s) in public; ' || c.n_breached
                 || ' reachable by PUBLIC/anon/authenticated (mig 722 took this '
                 || 'from 49 to 0). This arm has no allowlist — --pin-allowlist '
                 || 'cannot make it green.'
       end as note
  from counted c
`;
}
