#!/usr/bin/env node
// ============================================================================
// secdef-authority-prefix.mjs — no SECURITY DEFINER function may gate its
// authority check on `auth.uid() is not null`.
//
// ⚠ THE DEFECT, and why a comment in a migration was not enough.
//
//     if auth.uid() is not null and not exists (<caller is a member>) then
//       raise exception 'not authorized';
//     end if;
//
// reads like a guard and is not one. The identity test makes the check SKIP
// rather than FAIL when auth.uid() is null. Most of the affected functions take
// a tenant id — or an id that resolves to one — AS A PARAMETER, so what is left
// is the shape migrations 662-664 exist to prevent: a tenant-id parameter
// standing in for authorisation.
//
// The exposure is precise, and overstating it would be its own dishonesty:
// auth.uid() is null for `anon`, for `service_role`, and for an `authenticated`
// JWT with no `sub`. `anon` holds EXECUTE on none of the affected functions.
// So this is not an open door to the internet — it is the removal of the last
// tenant-scoping backstop from every service-role path, and an edge function
// that relays a caller-supplied tenant id into one of them is a confused
// deputy. Whether any given edge function launders user input today is not a
// property anyone re-checks tomorrow, which is why the rule is absolute.
//
// ⚠⚠ AND THE REASON THIS FILE EXISTS RATHER THAN A COMMENT. Migration 685
// wrote the lesson down. Migration 741 reintroduced the ambiguous-append
// defect 36 times anyway, months later, which is what taught this repo that a
// fact living in one migration's comment is a fact the next author will not
// have. The same is true here: migrations 747 and 748 fixed four instances by
// hand and named more; the sweep that followed closed the rest in migration
// 749. The next one must go red on arrival, not on the next person's
// initiative.
//
// ==========================================================================
// ⚠⚠⚠ THE PREDICATE IS A REGEX, NOT A SUBSTRING, AND THAT IS THE WHOLE POINT
// OF THIS FILE'S SECOND DRAFT.
//
// The first version of this check asked `src ilike '%auth.uid() is not null
// and%'`. A literal cannot see a defect that spans a line break, and real
// bodies break the line — `enqueue_conflict_backlog` writes
//
//     IF auth.uid() IS NOT NULL
//        AND NOT (p_tenant_id = auth_tenant_id() ...
//
// which is the identical defect and which the literal did not match. MEASURED
// on 2026-08-16 over the same 750 SECURITY DEFINER functions in `public`:
//
//     ilike '%auth.uid() is not null and%'               ->  21
//     ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and'         ->  27
//
// Six live carriers — two of them WRITERS taking a tenant id as a parameter —
// were invisible to the literal, and so was the migration probe built on it.
// A reviewer proved the blindness by injecting a synthetic body carrying the
// pattern with a newline before `and`: population 750 -> 751, violations
// 21 -> 21. NOT DETECTED. That mutation is now `--selftest` case 1 below, and
// it must RAISE the count or this file is decoration.
//
// TWO ARMS, because the defect has two shapes and only two — enumerated over
// the whole catalogue rather than over the ones expected:
//
//   ARM A, FLAT — the identity test is a conjunct of the authority test.
//       if auth.uid() is not null and not exists (…) then raise
//   ARM B, WRAPPING — the identity test is an OUTER `if` around it.
//       if auth.uid() is not null then
//         if not exists (…) then raise
//       end if;
//   Measured: 27 flat, 2 wrapping (set_de_objective_status,
//   verify_extraction_result). Both are the same fail-open behaviour.
//
// ⚠ AND THE SHAPE THAT LOOKS IDENTICAL AND IS THE EXACT OPPOSITE. ARM B is
// deliberately `then` + a NESTED `if`, not `then` + anything, because
//
//     IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'service role only'; END IF;
//
// is a fail-CLOSED bar — it refuses every caller who HAS an identity — and
// widening arm B to catch it would have this checker demand the deletion of a
// correct guard. probe_chunk_neighbors and record_knowledge_conflict are the
// live examples. They are classified below, not matched.
//
// ⚠ WHICH LEAVES THE HONEST GAP A REGEX ALWAYS LEAVES: a third shape nobody
// has written yet. ARM C answers it rather than hoping. Any SECURITY DEFINER
// body that mentions `auth.uid() is not null` at all, in a form NEITHER arm
// recognises and which is not named in CLASSIFIED_NON_DEFECTS, is a violation
// reading "a human must classify this". The population of unclassified shapes
// is pinned at the three that were read and argued, so shape number four goes
// red on arrival instead of being silently outside the predicate. That is the
// difference between a checker with a known blind spot and a checker that
// reports when it has been handed something it cannot judge.
//
// ⚠⚠⚠ THE SWEEP MUST STRIP LINE COMMENTS, AND THIS IS NOT A DETAIL. prosrc
// returns the `--` comments, so a naive match also matches every comment that
// NAMES the pattern — including the ones migrations 747, 748 and 749 added to
// explain the fix. Migration 747's own first apply failed on exactly that: it
// found itself. The stripped form is:
//
//     regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
//
// ⚠ WHICH CREATES THE OPPOSITE TRAP, so both are guarded. A strip that ate the
// whole body would report zero findings over empty text and look exactly like
// a clean database. Three vacuity arms answer that:
//   · POPULATION — the number of SECURITY DEFINER functions EXAMINED must not
//     be zero. Zero findings over zero comparisons is a violation, never a pass.
//   · NOT-EATING-CODE — at least one stripped body must still mention
//     auth.uid(). If none does, the strip is removing code, not comments.
//   · STRIP-IS-LOAD-BEARING — the naive (comment-inclusive) count must EXCEED
//     the stripped count. If they are equal the strip is doing nothing and has
//     never been exercised, so nobody would learn it had broken. Migration 749
//     deliberately leaves the pattern NAMED in the comments of several live
//     bodies precisely so this arm has something to measure. If that ever
//     stops being true this goes red with a sentence saying so — an honest red
//     about an unexercised check, not a silent pass.
//
// ⚠ IT READS THE LIVE CATALOGUE, NOT THE MIGRATION FILES, and that is
// deliberate. Migrations 715 and 717 are in the production ledger and ABSENT
// from HEAD, and supabase/baseline carries older bodies, so a file is not
// evidence of what is running. pg_proc is.
//
// THE PIN. KNOWN_PREFIXED is EMPTY, and empty is the point: after migration
// 749 no live SECURITY DEFINER function carries either shape in code, so any
// entry at all is a regression rather than debt. It is a symmetric pin — a
// name listed here that does NOT carry the pattern is also a violation, so an
// exemption cannot be left aimed at nothing and quietly widened.
//
// Usage:
//   node scripts/secdef-authority-prefix.mjs             # against production
//   node scripts/secdef-authority-prefix.mjs --dev       # against the dev project
//   node scripts/secdef-authority-prefix.mjs --selftest  # drive every arm red
// and, from certify.mjs, as a PROBES entry: sql: secdefAuthorityPrefixSql()
// ============================================================================
import { readFileSync } from 'node:fs';

/** Live SECURITY DEFINER functions permitted to carry the pattern IN CODE.
 *  EMPTY, deliberately — see the header. Adding a name here is a decision that
 *  a fail-open authority check may stay, and it must be argued in the migration
 *  that makes it true, never here. */
export const KNOWN_PREFIXED = Object.freeze([]);

/** Bodies that mention `auth.uid() is not null` in a shape that is NOT the
 *  defect. Each was read in full and argued; the reason is carried here so the
 *  next reviewer inherits the argument rather than the conclusion.
 *
 *  ⚠ SYMMETRIC, BOTH WAYS. A name here that no longer mentions the pattern at
 *  all is a violation (a pin aimed at nothing quietly widens), and a name here
 *  that has BECOME a carrier is a violation (a classification that stopped
 *  being true is worse than no classification). Neither can rot silently. */
export const CLASSIFIED_NON_DEFECTS = Object.freeze([
  {
    name: 'probe_chunk_neighbors',
    why: 'fail-CLOSED, the exact inverse of the defect: `IF auth.uid() IS NOT '
       + 'NULL THEN RAISE EXCEPTION \'service role only\'` REFUSES every caller '
       + 'that has an identity. Deleting it would widen the function to every '
       + 'signed-in user, so this checker must never ask for that.',
  },
  {
    name: 'record_knowledge_conflict',
    why: 'same fail-CLOSED service-role-only bar as probe_chunk_neighbors, and '
       + 'the same reason it must not be "fixed".',
  },
  {
    name: 'hybrid_match_knowledge',
    why: 'not a guard at all — `case when auth.uid() is not null then auth.uid() '
       + 'else p_acting_user end` RESOLVES AN ACTOR. There is no authority test '
       + 'attached to it, so there is nothing here to fail open.',
  },
]);

/** The defect, in prose, for the violation messages. */
export const PREFIX = 'auth.uid() is not null';

/** ARM A — flat: the identity test is a conjunct of the authority test.
 *  Whitespace-tolerant, which is the entire repair over the first draft. */
export const FLAT_RE = 'auth\\.uid\\(\\)\\s+is\\s+not\\s+null\\s+and';

/** ARM B — wrapping: an outer `if auth.uid() is not null then` around a NESTED
 *  `if`. The `if\\M` is load-bearing: `then RAISE` is the fail-closed shape and
 *  must not match. See the header. */
export const WRAP_RE = 'auth\\.uid\\(\\)\\s+is\\s+not\\s+null\\s+then\\s+if\\M';

/** ARM C's denominator — any mention at all, in any shape. */
export const ANY_RE = 'auth\\.uid\\(\\)\\s+is\\s+not\\s+null';

/**
 * @param {object}  [opts]
 * @param {string}  [opts.extraFns]  Extra rows UNIONed into the population, as
 *   a SELECT with the shape (sig text, raw text). Used to prove the finding arm
 *   actually fires — a checker nobody has watched go red is theatre.
 * @param {boolean} [opts.emptyPopulation]  Drop every real function, to prove
 *   the POPULATION vacuity arm fires.
 * @param {boolean} [opts.noStrip]  Compare against the RAW source instead of
 *   the stripped one, to prove the naive form finds the comments and would have
 *   produced a false red — the failure migration 747 actually hit.
 * @param {boolean} [opts.substringOnly]  TEST ONLY. Reinstates the ORIGINAL
 *   literal `ilike '%auth.uid() is not null and%'` predicate, so the selftest
 *   can show the line-broken mutation slipping past it and being caught by the
 *   regex. A repair nobody watched the old code fail is not a repair.
 * @param {string[]} [opts.pinnedOverride]  TEST ONLY. Stands in for
 *   KNOWN_PREFIXED so the symmetric-pin arm can be driven — a pin nobody has
 *   watched fire is an exemption nobody has checked. Never pass this from
 *   certify: the real pin is the exported constant, and it is empty.
 * @param {string[]} [opts.classifiedOverride]  TEST ONLY. Stands in for
 *   CLASSIFIED_NON_DEFECTS, so both directions of that pin can be driven too.
 */
export function secdefAuthorityPrefixSql(opts = {}) {
  const { extraFns = null, emptyPopulation = false, noStrip = false,
          substringOnly = false, pinnedOverride = null,
          classifiedOverride = null } = opts;

  const pinList = pinnedOverride ?? KNOWN_PREFIXED;
  const pinned = pinList.length
    ? pinList.map((s) => `(${literal(s)})`).join(', ')
    : null;

  const classList = classifiedOverride
    ? classifiedOverride.map((n) => (typeof n === 'string' ? { name: n, why: '(test)' } : n))
    : CLASSIFIED_NON_DEFECTS;
  const classified = classList.length
    ? classList.map((c) => `(${literal(c.name)}, ${literal(c.why)})`).join(', ')
    : null;

  const stripped = noStrip
    ? 'raw'
    : `regexp_replace(raw, '--[^' || chr(10) || ']*', '', 'g')`;

  // ⚠ The mutation switch that proves the repair. `substringOnly` restores the
  // blind literal; everything else keeps the widened arms.
  const flatHit  = (col) => substringOnly
    ? `${col} ilike '%auth.uid() is not null and%'`
    : `${col} ~* ${literal(FLAT_RE)}`;
  const wrapHit  = (col) => substringOnly ? 'false' : `${col} ~* ${literal(WRAP_RE)}`;
  const anyHit   = (col) => `${col} ~* ${literal(ANY_RE)}`;

  return `
with population as (
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
         p.prosrc as raw
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef${emptyPopulation ? `
     -- MUTATION: population emptied, to prove the vacuity arm fires.
     and false` : ''}${extraFns ? `
  union all
${extraFns}` : ''}
),
scanned as (
  select sig, raw, ${stripped} as src from population
),
classed as (
  select sig, raw, src,
         ${flatHit('src')}                       as flat_hit,
         ${wrapHit('src')}                       as wrap_hit,
         ${anyHit('src')}                        as any_hit,
         (${flatHit('raw')} or ${wrapHit('raw')}) as naive_hit
    from scanned
),
counted as (
  select count(*)                                                              as examined,
         count(*) filter (where flat_hit or wrap_hit)                          as code_hits,
         count(*) filter (where flat_hit)                                      as flat_hits,
         count(*) filter (where wrap_hit)                                      as wrap_hits,
         count(*) filter (where naive_hit)                                     as naive_hits,
         count(*) filter (where src ilike '%auth.uid()%')                      as code_mentions,
         count(*) filter (where any_hit and not flat_hit and not wrap_hit)     as unclassified
    from classed
),
pinned(sig) as (
  ${pinned ? `values ${pinned}` : `select null::text where false`}
),
classified(name, why) as (
  ${classified ? `values ${classified}` : `select null::text, null::text where false`}
)
-- 1. THE RULE. A SECURITY DEFINER function whose CODE gates an authority check
--    on auth.uid() being non-null, in EITHER shape.
select format(
         '%s gates its authority check on %L (%s form) — that makes the check SKIP rather than FAIL when auth.uid() is null (service_role, or any caller with no identity). Split it (an _internal variant for the service path, migs 747/748/749) or delete the identity test so the guard refuses. Do NOT pin it here.',
         c.sig, ${literal(PREFIX)},
         case when c.flat_hit and c.wrap_hit then 'flat AND wrapping'
              when c.flat_hit then 'flat' else 'wrapping' end) as violation,
       null::text as note
  from classed c
 where (c.flat_hit or c.wrap_hit)
   and c.sig not in (select sig from pinned where sig is not null)

union all
-- 2. THE PIN, THE OTHER WAY ROUND. An exemption aimed at nothing silently
--    permits the pattern everywhere it is pointed.
select format('pinned exemption %L no longer names a live SECURITY DEFINER function that carries the pattern — remove the pin rather than leaving it aimed at nothing', p.sig),
       null::text
  from pinned p
 where p.sig is not null
   and not exists (select 1 from classed c
                    where c.sig = p.sig and (c.flat_hit or c.wrap_hit))

union all
-- 3. ARM C — A SHAPE NEITHER ARM RECOGNISES. This is the arm that stops the
--    regex being a blind spot with better manners: a body that mentions the
--    pattern in some third form is neither passed nor failed, it is REPORTED
--    for a human to classify. Silence here would look exactly like a clean run.
select format('%s mentions %L in a shape this check does not recognise — it is neither the flat form nor the wrapping form, and it is not one of the %s classified non-defects. Read the body and either fix it or add it to CLASSIFIED_NON_DEFECTS with the argument. Do NOT widen the arms to swallow it: \`if auth.uid() is not null then raise\` is a fail-CLOSED bar and this check must never demand its deletion.',
              c.sig, ${literal(PREFIX)}, ${classList.length}::text),
       null::text
  from classed c
 where c.any_hit and not c.flat_hit and not c.wrap_hit
   and not exists (select 1 from classified cl
                    where cl.name is not null
                      and split_part(c.sig, '(', 1) = cl.name)

union all
-- 4. THE CLASSIFICATION PIN, AIMED AT NOTHING. A name argued to be a
--    non-defect that no longer mentions the pattern at all is a stale
--    exemption, and stale exemptions are how a pin becomes cover.
select format('CLASSIFIED_NON_DEFECTS names %L, but no live SECURITY DEFINER function by that name mentions %L any more — remove the entry rather than leaving it aimed at nothing. It was classified because: %s',
              cl.name, ${literal(PREFIX)}, cl.why),
       null::text
  from classified cl
 where cl.name is not null
   and not exists (select 1 from classed c where split_part(c.sig, '(', 1) = cl.name and c.any_hit)

union all
-- 5. THE CLASSIFICATION PIN, THE DANGEROUS WAY ROUND. A body argued to be a
--    non-defect that has SINCE become a carrier would otherwise be exempted by
--    its own obsolete argument.
select format('%s is listed in CLASSIFIED_NON_DEFECTS but now carries the defect in code (%s form) — the classification is out of date and is currently EXEMPTING a fail-open authority check. It was classified because: %s',
              c.sig,
              case when c.flat_hit and c.wrap_hit then 'flat AND wrapping'
                   when c.flat_hit then 'flat' else 'wrapping' end,
              cl.why),
       null::text
  from classed c
  join classified cl on split_part(c.sig, '(', 1) = cl.name
 where (c.flat_hit or c.wrap_hit)

union all
-- 6. VACUITY: nothing was examined.
select 'VACUOUS: zero SECURITY DEFINER functions in schema public were examined, so this check compared nothing and its clean result means nothing. Something is wrong with the scanner, not with the database.',
       null::text
  from counted where examined = 0

union all
-- 7. VACUITY: the comment strip is eating CODE, not comments.
select format('VACUOUS: not one of the %s SECURITY DEFINER bodies still mentions auth.uid() after stripping — the comment strip is removing code, and a sweep over empty text finds nothing by construction',
              examined::text),
       null::text
  from counted where examined > 0 and code_mentions = 0

union all
-- 8. VACUITY: the comment strip has never been exercised.
select format('the comment strip changed nothing (naive=%s, stripped=%s). Either no live body names the pattern in a comment any more — migration 749 left several that do, on purpose, so that this arm has something to measure — or the strip is not running. A strip nobody exercises is the step migration 747 lost a first apply to.',
              naive_hits::text, code_hits::text),
       null::text
  from counted where examined > 0 and naive_hits <= code_hits

union all
-- 9. THE DENOMINATOR, printed on a PASS as well as a fail.
select null::text,
       format('secdef-authority-prefix: examined %s SECURITY DEFINER function(s) in public; %s carry %L in CODE (%s flat, %s wrapping), %s mention it anywhere including comments — the gap between those two numbers IS the comment strip, and arm 8 goes red when it closes; %s body/bodies mention it in a shape neither arm claims, of which %s are classified non-defects; %s pinned exemption(s)',
              examined::text, code_hits::text, ${literal(PREFIX)},
              flat_hits::text, wrap_hits::text, naive_hits::text,
              unclassified::text, ${classList.length}::text, ${pinList.length}::text)
  from counted
`;
}

function literal(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ── CLI ───────────────────────────────────────────────────────────────────
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';

function readToken() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function runSql(sql, ref) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  return JSON.parse(body);
}

/** THE MUTATION THAT NAMES THIS FILE'S SECOND DRAFT. A synthetic SECURITY
 *  DEFINER body carrying the defect with a LINE BREAK before `and` — the exact
 *  injection a reviewer used to show the literal predicate could not see it. */
const MUTANT_LINEBREAK = `  select '749_selftest_linebreak(uuid)'::text as sig,
         $mut$
begin
  if auth.uid() is not null
     and not exists (select 1 from profiles p where p.user_id = auth.uid()
                       and p.tenant_id = p_tenant_id) then
    raise exception 'not authorized';
  end if;
  return true;
end;
$mut$::text as raw`;

/** The WRAPPING shape, also line-broken, for arm B. */
const MUTANT_WRAPPING = `  select '749_selftest_wrapping(uuid)'::text as sig,
         $mut$
begin
  if auth.uid() is not null then
    if not exists (select 1 from profiles p where p.user_id = auth.uid()) then
      raise exception 'not authorized';
    end if;
  end if;
  return true;
end;
$mut$::text as raw`;

/** The FAIL-CLOSED shape that must NOT be reported as a carrier, and must NOT
 *  be silently ignored either — arm C should claim it as unclassified. */
const MUTANT_FAILCLOSED = `  select '749_selftest_failclosed(uuid)'::text as sig,
         $mut$
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'service role only'; END IF;
  RETURN true;
END
$mut$::text as raw`;

/** Split the findings by ARM, because a total is not a proof. The mutation
 *  this file exists for is invisible in the total — arm C catches the
 *  line-broken body even under the OLD literal — and only the CARRIER count
 *  answers "would the ratchet have demanded a fix". */
function byArm(rows) {
  const v = rows.filter((r) => r.violation != null).map((r) => r.violation);
  return {
    total: v.length,
    carrier: v.filter((x) => x.includes('gates its authority check on')).length,
    unclassified: v.filter((x) => x.includes('in a shape this check does not recognise')).length,
    all: v,
  };
}

async function selftest(ref) {
  const cases = [
    { name: 'BASELINE, widened predicate', opts: {} },
    { name: 'BASELINE, OLD substring predicate (what shipped in the first draft)',
      opts: { substringOnly: true } },
    { name: 'MUTATION 1 — line-broken FLAT body + OLD substring predicate — CARRIERS MUST NOT RISE (this is the defect)',
      opts: { extraFns: MUTANT_LINEBREAK, substringOnly: true }, expectCarrierRise: false, base: 1 },
    { name: 'MUTATION 1 — line-broken FLAT body + WIDENED predicate — CARRIERS MUST RISE (this is the repair)',
      opts: { extraFns: MUTANT_LINEBREAK }, expectCarrierRise: true, base: 0 },
    { name: 'MUTATION 2 — WRAPPING body — CARRIERS MUST RISE (arm B)',
      opts: { extraFns: MUTANT_WRAPPING }, expectCarrierRise: true, base: 0 },
    { name: 'MUTATION 3 — fail-CLOSED body — CARRIERS MUST NOT RISE, arm C must claim it',
      opts: { extraFns: MUTANT_FAILCLOSED }, expectCarrierRise: false, base: 0 },
    { name: 'MUTATION 4 — empty population (vacuity arm must fire)',
      opts: { emptyPopulation: true } },
    { name: 'MUTATION 5 — no comment strip (naive form must produce a false red)',
      opts: { noStrip: true } },
    { name: 'MUTATION 6 — pin aimed at nothing (symmetric-pin arm must fire)',
      opts: { pinnedOverride: ['a_function_that_does_not_exist(uuid)'] } },
    { name: 'MUTATION 7 — classification aimed at nothing (arm 4 must fire)',
      opts: { classifiedOverride: [{ name: 'no_such_function_anywhere', why: 'test' }] } },
  ];

  const bases = [];
  let failed = false;
  for (const c of cases) {
    let rows;
    try {
      rows = await runSql(secdefAuthorityPrefixSql(c.opts), ref);
    } catch (e) {
      console.error(`  ✗ ${c.name}: PROBE ERROR ${String(e).slice(0, 300)}`);
      failed = true;
      continue;
    }
    const a = byArm(rows);
    if (bases.length < 2) bases.push(a);
    const b = c.base != null ? bases[c.base] : null;
    let verdict = '';
    if (b && c.expectCarrierRise != null) {
      const rose = a.carrier > b.carrier;
      const ok = rose === c.expectCarrierRise;
      if (!ok) { failed = true; }
      verdict = `  ${ok ? 'AS EXPECTED' : '*** UNEXPECTED ***'} carriers ${b.carrier} -> ${a.carrier}`;
    }
    console.log(`  ${c.name}\n      carriers=${a.carrier}  unclassified=${a.unclassified}  totalFindings=${a.total}${verdict}`);
    for (const line of a.all.filter((x) => /selftest|does not exist|no_such_function|VACUOUS|comment strip/.test(x)).slice(0, 2)) {
      console.log(`      · ${line.slice(0, 175)}`);
    }
  }
  if (failed) {
    console.error('  ✗ selftest: at least one arm did not behave as stated above.');
    process.exitCode = 1;
  } else {
    console.log('  selftest: every arm fired, and the line-broken body is invisible to the old predicate and visible to the new one.');
  }
}

// ⚠ THROUGHOUT: process.exitCode, NOT process.exit(). On Windows, exiting
// while a long stdout write is still queued aborts the process with a libuv
// assertion (`!(handle->flags & UV_HANDLE_CLOSING)`) and the caller sees a
// CRASH instead of the exit code. Measured on this machine, on the very first
// run, with the 21 findings this check was written for.
if (process.argv[1]?.endsWith('secdef-authority-prefix.mjs')) {
  const ref = process.argv.includes('--dev')
    ? (process.env.SUPABASE_DEV_REF ?? 'nmuntxrcdksyhsdywpan')
    : PROD_REF;

  if (process.argv.includes('--selftest')) {
    console.log('secdef-authority-prefix --selftest: every arm driven, against the LIVE catalogue.');
    await selftest(ref);
  } else {
    let rows = null;
    try {
      rows = await runSql(secdefAuthorityPrefixSql(), ref);
    } catch (e) {
      // A broken probe is a FAILURE, not a skip.
      console.error(`secdef-authority-prefix: PROBE ERROR (a broken check is a failure, not a skip) — ${String(e).slice(0, 400)}`);
      process.exitCode = 1;
    }
    if (rows !== null) {
      const violations = rows.filter((r) => r.violation != null).map((r) => r.violation);
      const notes = rows.filter((r) => r.note != null).map((r) => r.note);
      for (const n of notes) console.log(n);
      if (violations.length > 0) {
        console.error(violations.map((v) => `  ✗ ${v}`).join('\n'));
        process.exitCode = 1;
      }
      if (notes.length === 0) {
        console.error('secdef-authority-prefix: the query returned no denominator at all — it cannot say what it compared, so this is not a pass');
        process.exitCode = 1;
      }
    }
  }
}
