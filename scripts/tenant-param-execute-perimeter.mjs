#!/usr/bin/env node
// ============================================================================
// tenant-param-execute-perimeter.mjs — NO SECURITY DEFINER function in
// `public` that takes a caller-supplied TENANT-ID parameter may be EXECUTE-able
// by `anon` or by `PUBLIC`.
//
// THERE IS NO ALLOWLIST IN THIS FILE, AND THERE IS NO PLACE TO ADD ONE. That
// is the whole point, and it is why the rule is stated absolutely rather than
// as a judgement call — see WHY IT CAN BE ABSOLUTE below.
//
// ── THE DEFECT THIS EXISTS FOR, MEASURED 2026-08-20 ──────────────────────
//
//   de_kpi_action_value(p_tenant_id uuid, p_de_id uuid, p_source text,
//                       p_source_config jsonb, p_window_weeks integer)
//   prosecdef = true   proacl = {=X/postgres, postgres=X/postgres,
//                                service_role=X/postgres}
//
// The leading `=X/` is PUBLIC. anon and authenticated held EXECUTE by
// INHERITANCE, not by a named grant — which matters, because it means the
// obvious fix (`revoke ... from anon`) would have changed the ACL not at all
// while reading like a repair. SECDEF bypasses RLS and the body's only tenant
// scoping is `ae.tenant_id = p_tenant_id`, a value the caller hands in. Three
// POSTs to /rest/v1/rpc/ carrying nothing but the PUBLISHABLE anon key
// returned three different workspaces' figures, each matching service-role
// ground truth exactly. Migration 823 revoked it.
//
// ── WHY THIS RULE CAN BE ABSOLUTE, WHEN THE AUTHENTICATED ONE CANNOT ─────
//
// An anonymous caller HAS NO IDENTITY TO DERIVE FROM. auth.uid() is null,
// auth_tenant_id() is null, there is no membership row to look up. So a
// tenant-id parameter reaching an anonymous caller is not "an assertion that
// might be checked" — there is nothing available to check it against, ever.
// The parameter IS the authorisation, in every instance, by construction. A
// rule with no legitimate counter-example needs no exemption list, and a rule
// with no exemption list cannot be laundered by re-pinning.
//
// That is precisely the property the EXECUTE allowlist does not have. It is
// symmetric and it is not blind — it named this function correctly on
// 2026-08-20 — but it is RE-PINNABLE, and its finding line reads
//
//   NEW/CHANGED grant not in allowlist: de_kpi_action_value(...)|anon=true|...
//
// which is the SAME SHAPE OF LINE as the nine benign authenticated-only
// additions it was sitting beside. Nothing in it says SECDEF, nothing says
// tenant parameter, nothing says the internet. One `--pin-allowlist` run
// meant to record the nine would have blessed the tenth. That is not a
// hypothetical: certify.mjs's own header records the near miss, and the
// trigger-function sweep found 48 of 49 real breaches sitting INSIDE the pin.
// This file is the arm that cannot be cleared that way.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO, AND THE MEASUREMENT WHY ─────
//
// It does NOT ship a second rule for the `authenticated` half. Measured on
// production: 786 SECDEF functions in public, 257 taking a tenant-id-shaped
// uuid parameter, 114 of those reachable by `authenticated` — and all but a
// handful are legitimate, because they derive the caller's tenant and compare.
// So an authenticated arm NEEDS a "does it derive?" predicate, and both
// candidates were built and MEASURED before being rejected:
//
//   · a direct-name regex over the body
//     (auth_tenant_id|auth.uid|is_platform_admin|can_access_de|...)
//     returned 7 non-derivers, of which FIVE were false positives — they
//     derive through helper names the regex did not know:
//       is_ancestor_of / tenant_ancestors / tenant_descendants
//                                     -> caller_has_tenant_relationship()
//       list_org_tree                 -> assert_own_tenant()
//       scim_tokens_list              -> can_admin_tenant_internal()
//
//   · a TRANSITIVE closure ("calls anything that reaches auth.uid()") went the
//     other way and swallowed the catalogue: 420 level-0 seeds expanded to 498
//     of 873 functions, i.e. 57% of everything "derives" and the arm clears
//     almost any body handed to it. It also cost 17s.
//
// A checker measured to be wrong in both directions is worse than no checker,
// because it manufactures findings AND grants cover — this repo has already
// paid for that lesson twice (five confident findings that were all wrong; a
// gate that had never fired). The authenticated half therefore stays with
// certify's existing `secdef-caller-tenant-ratchet`, and its real weakness is
// named here rather than papered over: that ratchet's exemptions are keyed on
// `proname` ALONE, with no signature, so a NEW OVERLOAD of an exempted name
// inherits its clearance silently. The anon half of that hole is closed
// absolutely by this file, which knows no names at all.
//
// ── THE VACUITY ARMS, because zero findings from zero comparisons looks ──
// exactly like a clean result:
//   · POPULATION — the number of SECDEF functions examined must not be zero.
//   · DETECTOR   — the tenant-parameter matcher must match SOMETHING. If it
//     matches nothing the sieve is empty and every run passes by construction;
//     that is the arm that catches a broken parameter regex.
//   · PRIVILEGE  — at least one function in `public` must come back
//     anon-executable. If has_function_privilege() answers false for the
//     entire schema it has stopped discriminating, and a clean result here
//     would mean nothing.
// The denominator prints on a PASS as well as a fail.
//
// Usage:
//   node scripts/tenant-param-execute-perimeter.mjs             # production
//   node scripts/tenant-param-execute-perimeter.mjs --selftest  # drive every arm
// and, from certify.mjs, as a PROBES entry:
//   sql: tenantParamExecutePerimeterSql()
// ============================================================================
import { readFileSync } from 'node:fs';

/** A parameter NAME that means "the tenant this call is about", matched only
 *  when its type is uuid. Deliberately anchored: `like '%uuid%'` over the whole
 *  identity-arguments string — the sieve the existing ratchet uses — also
 *  matches `p_task_ids uuid[]`, which is a different question. */
export const TENANT_PARAM_RE = '^(p_|_)?tenant(_id)?$';

/**
 * @param {object}   [opts]
 * @param {string}   [opts.extraFns]  TEST ONLY. Rows UNIONed into the
 *   population as a SELECT shaped (sig, has_tenant_param, anon_x, auth_x,
 *   public_x). A finding arm nobody has watched go red is decoration.
 * @param {boolean}  [opts.emptyPopulation]  TEST ONLY. Drop every real row, to
 *   prove the POPULATION vacuity arm fires.
 * @param {boolean}  [opts.blindParamMatch]  TEST ONLY. Replace the parameter
 *   matcher with one that matches nothing, to prove the DETECTOR vacuity arm
 *   fires rather than the sieve silently passing everything.
 */
export function tenantParamExecutePerimeterSql(opts = {}) {
  const { extraFns = null, emptyPopulation = false, blindParamMatch = false } = opts;

  const paramRe = blindParamMatch ? '^__this__matches__nothing__$' : TENANT_PARAM_RE;

  return `
with pop as (
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
         -- The tenant-id parameter test, by NAME and TYPE together.
         exists (
           select 1
             from unnest(coalesce(p.proargnames, '{}'::text[])) with ordinality a(nm, ord)
            where a.nm ~* ${literal(paramRe)}
              and p.proargtypes[a.ord - 1] = 'uuid'::regtype
         ) as has_tenant_param,
         has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x,
         -- PUBLIC, read straight off the ACL. has_function_privilege() already
         -- resolves PUBLIC inheritance for a named role, but this arm has to
         -- name PUBLIC ITSELF: an anon-only revoke that leaves \`=X/\` behind is
         -- theatre, and a function that has never been GRANTed or REVOKEd has
         -- proacl NULL, which MEANS PUBLIC=X. acldefault() spells that out.
         exists (
           select 1
             from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ax
            where ax.grantee = 0 and ax.privilege_type = 'EXECUTE'
         ) as public_x
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p') and p.prosecdef${emptyPopulation ? `
     -- MUTATION: population emptied, to prove the vacuity arm fires.
     and false` : ''}${extraFns ? `
  union all
${extraFns}` : ''}
),
-- The privilege-test liveness control. Scoped to the WHOLE schema, not to the
-- SECDEF subset, because the question is whether has_function_privilege() is
-- still discriminating at all.
live as (
  select count(*) filter (where has_function_privilege('anon', p.oid, 'EXECUTE')) as anon_reachable_anything
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
),
counted as (
  select count(*)                                                                as examined,
         count(*) filter (where has_tenant_param)                                as with_tenant_param,
         count(*) filter (where has_tenant_param and anon_x)                     as tp_anon,
         count(*) filter (where has_tenant_param and public_x)                   as tp_public,
         count(*) filter (where has_tenant_param and auth_x)                     as tp_auth,
         count(*) filter (where has_tenant_param and auth_x and not anon_x)      as tp_auth_only
    from pop
)

-- 1. THE RULE, anon. Absolute: an anonymous caller has no identity to check a
--    tenant parameter against, so the parameter IS the authorisation.
select format(
         '%s is SECURITY DEFINER, takes a caller-supplied tenant-id parameter, and anon HOLDS EXECUTE — that is the public internet reading across workspaces with RLS bypassed (migs 662-664, 749, 823). REVOKE it: revoke execute on function public.%s from public, anon, authenticated; then re-assert with has_function_privilege. There is deliberately NO allowlist in this check and nowhere to add one — an anonymous caller has nothing to derive a tenant from, so no instance of this shape is ever legitimate.',
         sig, sig) as violation,
       null::text as note
  from pop where has_tenant_param and anon_x

union all
-- 2. THE RULE, PUBLIC. Separate from arm 1 on purpose: this repo's recorded
--    lesson is that an anon-only revoke is THEATRE. A grant left on PUBLIC is
--    still reachable by anon, by authenticated, and by every role added later.
select format(
         '%s is SECURITY DEFINER, takes a caller-supplied tenant-id parameter, and PUBLIC holds EXECUTE (either =X/ in the ACL or a NULL proacl, which MEANS PUBLIC=X — a function created and never REVOKEd is born this way). Revoking from anon alone would leave this exactly as it is while looking like a fix. Revoke from PUBLIC.',
         sig),
       null::text
  from pop where has_tenant_param and public_x

union all
-- 3. VACUITY: nothing was examined.
select 'VACUOUS: zero SECURITY DEFINER functions in schema public were examined, so this check compared nothing and its clean result means nothing. Something is wrong with the scanner, not with the database.',
       null::text
  from counted where examined = 0

union all
-- 4. VACUITY: the tenant-parameter detector matched nothing. This is the arm
--    that catches a broken parameter regex — an empty sieve passes every
--    function that has ever existed and looks identical to a clean perimeter.
select format('VACUOUS: the tenant-parameter detector matched 0 of %s SECURITY DEFINER functions. Every arm below it filters on has_tenant_param, so an empty sieve passes everything by construction. The matcher (%L over uuid-typed parameters) is broken, not the database.',
              examined::text, ${literal(paramRe)}),
       null::text
  from counted where examined > 0 and with_tenant_param = 0

union all
-- 5. VACUITY: the privilege test has stopped discriminating.
select 'VACUOUS: not one function in schema public came back EXECUTE-able by anon — including the ones the pinned EXECUTE allowlist records as anon-reachable. has_function_privilege() is answering false for everything, so "no anon-reachable tenant-param function" is not evidence of anything.',
       null::text
  from live where anon_reachable_anything = 0

union all
-- 6. THE DENOMINATOR, printed on a PASS as well as a fail.
select null::text,
       format('secdef-tenant-param-unreachable-by-anon: examined %s SECURITY DEFINER function(s) in public; %s take a caller-supplied tenant-id uuid parameter (matcher %L); of those %s are reachable by anon and %s carry a PUBLIC grant — both must be 0, and there is no allowlist that could make them look like 0. %s are reachable by authenticated (%s by authenticated only); that half is NOT judged here and stays with secdef-caller-tenant-ratchet — see this file''s header for the two derivation predicates that were built, measured wrong in opposite directions, and rejected.',
              examined::text, with_tenant_param::text, ${literal(paramRe)},
              tp_anon::text, tp_public::text, tp_auth::text, tp_auth_only::text)

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

/** A synthetic SECDEF function carrying the exact defect: tenant-id parameter,
 *  anon EXECUTE. Arm 1 must NAME it. */
const MUTANT_ANON = `  select '823_selftest_anon(p_tenant_id uuid)'::text as sig,
         true as has_tenant_param, true as anon_x, true as auth_x, true as public_x`;

/** The PUBLIC-only shape: anon shows false, the grant sits on PUBLIC. This is
 *  the state an anon-only revoke leaves behind, and arm 2 must name it while
 *  arm 1 stays silent. */
const MUTANT_PUBLIC_ONLY = `  select '823_selftest_public_only(p_tenant_id uuid)'::text as sig,
         true as has_tenant_param, false as anon_x, false as auth_x, true as public_x`;

/** CONTROL — anon-reachable but NO tenant parameter. Must NOT be named, or the
 *  arm is just "anything anon" wearing a tenancy costume. */
const CONTROL_NO_TENANT_PARAM = `  select '823_selftest_control_no_param()'::text as sig,
         false as has_tenant_param, true as anon_x, true as auth_x, true as public_x`;

/** CONTROL — tenant parameter but unreachable. Must NOT be named. */
const CONTROL_UNREACHABLE = `  select '823_selftest_control_unreachable(p_tenant_id uuid)'::text as sig,
         true as has_tenant_param, false as anon_x, false as auth_x, false as public_x`;

async function selftest() {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  const violations = (rows) => rows.filter((r) => r.violation != null).map((r) => r.violation);
  const notes = (rows) => rows.filter((r) => r.note != null).map((r) => r.note);

  // ── DIRECTION 1: a clean catalogue must stay SILENT ────────────────────
  const clean = await runSql(tenantParamExecutePerimeterSql());
  check('clean catalogue is silent', violations(clean).length === 0,
    violations(clean).length ? violations(clean).join(' | ').slice(0, 300) : 'no violations');
  check('denominator prints on a PASS', notes(clean).length === 1,
    notes(clean)[0]?.slice(0, 220) ?? '(no note — the denominator is missing)');

  // ── DIRECTION 2: every finding arm must go red and NAME the offender ───
  // ⚠ Every mutation below asserts a COUNT DELTA against the clean baseline as
  //   well as the message. Matching a substring proves the arm can print; only
  //   the delta proves the arm actually FIRED on the injected row rather than
  //   re-reporting something that was already there. A mutation that changes
  //   the count by zero is a mutation that was NOT DETECTED, however good the
  //   message looks.
  const base = violations(clean).length;

  const m1 = await runSql(tenantParamExecutePerimeterSql({ extraFns: MUTANT_ANON }));
  check('ARM 1 catches + NAMES an anon-reachable tenant-param SECDEF fn',
    violations(m1).some((v) => v.includes('823_selftest_anon') && v.includes('anon HOLDS EXECUTE')),
    `${violations(m1).length} violation(s)`);
  // MUTANT_ANON is anon AND public, so it must trip BOTH finding arms: +2.
  check('ARM 1 mutation moves the count (+2: anon arm and PUBLIC arm)',
    violations(m1).length === base + 2, `baseline ${base} -> ${violations(m1).length}`);

  const m2 = await runSql(tenantParamExecutePerimeterSql({ extraFns: MUTANT_PUBLIC_ONLY }));
  check('ARM 2 catches + NAMES a PUBLIC-only grant (the anon-only-revoke residue)',
    violations(m2).some((v) => v.includes('823_selftest_public_only') && v.includes('PUBLIC holds EXECUTE')),
    `${violations(m2).length} violation(s)`);
  check('ARM 2 mutation moves the count (+1: PUBLIC arm only)',
    violations(m2).length === base + 1, `baseline ${base} -> ${violations(m2).length}`);
  check('ARM 2 fires WITHOUT arm 1 — the two arms are genuinely independent',
    !violations(m2).some((v) => v.includes('823_selftest_public_only') && v.includes('anon HOLDS EXECUTE')));

  const m3 = await runSql(tenantParamExecutePerimeterSql({ emptyPopulation: true }));
  check('POPULATION vacuity arm fires on an empty population',
    violations(m3).some((v) => v.startsWith('VACUOUS: zero SECURITY DEFINER')));

  const m4 = await runSql(tenantParamExecutePerimeterSql({ blindParamMatch: true }));
  check('DETECTOR vacuity arm fires when the parameter matcher matches nothing',
    violations(m4).some((v) => v.includes('tenant-parameter detector matched 0')));

  // ── DIRECTION 3: the controls. An arm that reds on everything is not a
  //    checker either, so the near-miss shapes must stay SILENT. ──────────
  const c1 = await runSql(tenantParamExecutePerimeterSql({ extraFns: CONTROL_NO_TENANT_PARAM }));
  check('CONTROL: anon-reachable with NO tenant parameter is NOT named',
    !violations(c1).some((v) => v.includes('823_selftest_control_no_param'))
      && violations(c1).length === base,
    `baseline ${base} -> ${violations(c1).length}`);

  const c2 = await runSql(tenantParamExecutePerimeterSql({ extraFns: CONTROL_UNREACHABLE }));
  check('CONTROL: tenant parameter but unreachable is NOT named',
    !violations(c2).some((v) => v.includes('823_selftest_control_unreachable'))
      && violations(c2).length === base,
    `baseline ${base} -> ${violations(c2).length}`);

  console.log(`\n${pass + fail} mutation(s) · ${pass} passed · ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  if (process.argv.includes('--selftest')) {
    process.exit(await selftest());
  } else {
    const rows = await runSql(tenantParamExecutePerimeterSql());
    let bad = 0;
    for (const r of rows) {
      if (r.violation != null) { bad++; console.log(` ⚠ ${r.violation}`); }
      else if (r.note != null) { console.log(`   ${r.note}`); }
    }
    console.log(bad === 0 ? '\nPERIMETER HELD — 0 violations' : `\n⚠ ${bad} VIOLATION(S)`);
    process.exit(bad === 0 ? 0 : 1);
  }
}
