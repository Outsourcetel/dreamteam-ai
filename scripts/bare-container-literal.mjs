// ============================================================
// bare-container-literal.mjs — the Ring-0 ratchet for the defect migration 685
// found, in ONE place.
//
// THE SHAPE. In plpgsql, appending a BARE string literal to a text[]:
//
//     v_errors := v_errors || 'template needs at least one go-live phase item';
//
// does NOT append. The literal is `unknown`, so Postgres resolves the operator
// as `anyarray || anyarray` rather than `anyarray || anyelement`, tries to parse
// the message AS an array, and raises 22P02 "malformed array literal". The
// branch can never return its message. A sibling line using format(...) is
// fine, because format() returns typed text — which is exactly why this
// survived from migration 076 until 2026-08-11 without anyone noticing.
//
// Four rules of public.validate_onboarding_items were dead this way: "needs at
// least 1 item", "cannot exceed 50 items", "every item needs a non-empty key",
// and "needs at least one go-live phase item". Publish was still refused (the
// failure was in the safe direction), but the caller got a raw Postgres error
// instead of the structured errors[] the publish UI renders.
//
// jsonb carries the IDENTICAL trap: `jsonb || unknown` resolves jsonb||jsonb
// and parses the literal AS json. Both live in this one probe because they are
// one defect in two types, and the violation string says which cast to add.
//
// WHY THIS FILE EXISTS RATHER THAN AN INLINE PROBE. A sweep of all 1031
// non-system routines on 2026-08-11 found ZERO remaining instances, so this
// probe returns zero rows today and "passes" trivially. The mutation test is
// therefore the ONLY thing proving it can ever fire — and certify-mutation-
// test.mjs imports THIS function and feeds it a synthesised body, so it
// exercises the real regex rather than a paraphrase of it.
//
// ⚠ THE HAZARD THIS FILE WAS ALMOST SHIPPED WITH. The first draft of the
// jsonb branch used the backslash-b spelling, intending a word boundary. In
// Postgres ARE, backslash-b is a BACKSPACE CHARACTER — the word-boundary
// constraint escape is backslash-y, which is what the patterns below use.
// The regex matched nothing, the jsonb half had zero coverage, and it returned
// zero rows, which looks EXACTLY like a clean database. It was caught only by
// mutation-testing. The case named "jsonb — GUARDS THE \y ESCAPE" in
// certify-mutation-test.mjs goes red the moment anyone writes `\b` here again.
// Do not "simplify" it.
// ============================================================

// SCOPE: `public` only, deliberately, and this is a narrowing worth stating.
// The 2026-08-11 sweep covered all ten non-system schemas (auth, cron,
// extensions, graphql_public, net, pgbouncer, public, realtime, storage, vault)
// and found nothing anywhere. But every routine outside `public` is
// Supabase-managed. A vendor upgrade that introduced this shape would turn
// certify red for something we cannot fix, and the only available response
// would be an allowlist entry — which is how gates get switched off. All
// DreamTeam-authored code lives in `public`, so nothing of ours is lost.
const CATALOG_SOURCE = `
    select n.nspname                          as nspname,
           p.proname                          as proname,
           pg_get_function_arguments(p.oid)   as fullargs,
           p.prosrc                           as rawsrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language  l on l.oid = p.prolang
     where n.nspname = 'public'
       and l.lanname = 'plpgsql'
       and p.prokind in ('f', 'p')`;

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * @param {Array<{proname: string, prosrc: string, fullargs?: string}>|null} fixture
 *   null  -> scan the live `public` catalog (what certify runs)
 *   array -> scan synthesised bodies (what the mutation test runs, through the
 *            SAME regex, so a broken pattern fails the test instead of hiding)
 */
export function bareContainerLiteralSql(fixture = null) {
  const source = fixture
    ? `select * from (values ${fixture
        .map((f) => `(${sq('fixture')}, ${sq(f.proname)}, ${sq(f.fullargs ?? '')}, ${sq(f.prosrc)})`)
        .join(', ')}) as v(nspname, proname, fullargs, rawsrc)`
    : CATALOG_SOURCE;

  return String.raw`
with src as (
${source}
),
fns as (
  -- Comments are stripped FIRST. Migration 685's own header quotes the bugged
  -- line as prose; a probe that reads comments manufactures a finding out of
  -- its own documentation.
  select row_number() over () as fid, nspname, proname,
         coalesce(fullargs, '') as fullargs,
         regexp_replace(rawsrc, '--[^' || chr(10) || ']*', '', 'g') as src
    from src
),
containers as (
  select fid, var, kind from (
    -- array-typed LOCALS:  v_errors text[] := '{}';   v_codes varchar(64)[];
    select f.fid, lower(m[1]) as var, 'array' as kind
      from fns f, lateral regexp_matches(f.src,
        '([a-z_][a-z0-9_]*)\s+(?:constant\s+)?(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*(?:\s*\([0-9, ]*\))?\s*\[\s*\]',
        'gi') m
    union all
    -- json/jsonb LOCALS. The trailing escape MUST be the word-boundary one
    -- (backslash-y). The backslash-b spelling is a BACKSPACE character in
    -- Postgres ARE and silently matches nothing — see this file's header.
    select f.fid, lower(m[1]), 'jsonb'
      from fns f, lateral regexp_matches(f.src,
        '([a-z_][a-z0-9_]*)\s+(?:constant\s+)?jsonb?\y', 'gi') m
    union all
    -- array-typed ARGUMENTS
    select f.fid, lower(m[1]), 'array'
      from fns f, lateral regexp_matches(f.fullargs,
        '([a-z_][a-z0-9_]*)\s+[^,]*\[\]', 'gi') m
    union all
    -- json/jsonb ARGUMENTS
    select f.fid, lower(m[1]), 'jsonb'
      from fns f, lateral regexp_matches(f.fullargs,
        '([a-z_][a-z0-9_]*)\s+jsonb?\y', 'gi') m
  ) u
  where var not in ('declare','begin','return','returns','as','is','constant','default',
                    'alias','for','in','out','inout','type','row','record','array',
                    'then','else','end','if','loop','not','and','or','select','case')
),
stmts as (
  -- STATEMENT level, not line level: an append split across lines is the same
  -- defect and a line-based sieve cannot see it.
  select f.fid, f.proname, btrim(regexp_replace(s, '\s+', ' ', 'g')) as stmt
    from fns f, lateral regexp_split_to_table(f.src, ';') s
)
select distinct
       s.proname || ': ' || c.kind || ' variable "' || c.var
       || '" is concatenated with an UNTYPED literal. Postgres resolves this as '
       || c.kind || ' || ' || c.kind || ', parses the literal AS a ' || c.kind
       || ' and raises 22P02 at runtime, so this branch can never return its message. '
       || 'FIX: cast the literal — '
       || case when c.kind = 'array' then '''your message''::text' else '''your value''::jsonb' end
       || ' (format(...) and array_append(arr, ''lit'') are already safe; see mig 685). '
       || 'Statement: ' || left(s.stmt, 110) as violation
  from stmts s
  join containers c on c.fid = s.fid
 where (
     -- literal on the RIGHT of ||, carrying no cast
     (    s.stmt ~* ('(^|[^a-z0-9_.])' || c.var || '\s*\|\|\s*''')
      and s.stmt !~* ('(^|[^a-z0-9_.])' || c.var || '\s*\|\|\s*''[^'']*''\s*::'))
     -- literal on the LEFT of ||, carrying no cast
  or (    s.stmt ~* ('''[^'']*''\s*\|\|\s*' || c.var || '([^a-z0-9_]|$)')
      and s.stmt !~* ('''[^'']*''\s*::[a-z]+\s*\|\|\s*' || c.var))
     -- array_cat really IS (anyarray, anyarray), so a literal 2nd argument is
     -- the same defect. array_append is (anyarray, anyelement) and is CORRECT —
     -- 19 real call sites rely on it, and matching on the second argument
     -- STARTING with a quote is what keeps array_cat(v, array['x']) clean too.
  or      s.stmt ~* ('array_cat\s*\(\s*' || c.var || '\s*,\s*''')
 )
 order by 1`;
}
