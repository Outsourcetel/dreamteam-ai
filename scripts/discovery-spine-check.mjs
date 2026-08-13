// The discovery-spine comparison, as a PURE function over already-fetched
// state — no database, no I/O, no clock. Same split as provider-catalog-
// check.mjs, for the same reason: certify.mjs runs against PRODUCTION, and
// the only way to prove one of these assertions can fail is to hand the
// REAL comparison a MUTATED COPY of live state and watch it fire — never to
// write a broken row into the live spine or a live session. That write was
// refused for provider-catalog and is refused here from the start (see the
// task-4 brief's "PRODUCTION-WRITE BOUNDARY" note).
//
// certify.mjs fetches and formats; this decides. scripts/certify-mutation-
// test.mjs imports the SAME function and feeds it mutated copies of the
// SAME live state, so the mutation cases exercise the real gate rather than
// a paraphrase of it — if certify and the fixtures ever walked different
// copies of this logic, the fixtures would prove nothing about certify.
//
// ⚠ There is no hardcoded dimension count anywhere below. Migration 733
// shipped 12 dimensions; 734/735/736 grew the spine to 14 without a single
// line here changing, because every assertion is phrased against
// `active.length` (whatever public.discovery_dimensions actually holds
// today), never against a literal 12 or 14. The task-4 brief itself says
// this plainly: it was written against the stale 12 and warns the reader
// not to trust that number — this file is what makes that warning
// unnecessary to have needed.

// The four words public.discovery_coverage_states_valid(jsonb) (migration
// 738) accepts. A coverage entry is invalid if its `state` is missing,
// non-string (738's own fix — a NUMBER or BOOLEAN state slipped through the
// first version of that constraint), or any string outside this set.
export const COVERAGE_STATES = new Set(['heard', 'parked', 'skipped', 'not_heard']);

/** One session's coverage jsonb -> the bad `dimension=state` pairs in it. */
function coverageViolations(coverage) {
  const bad = [];
  if (coverage && typeof coverage === 'object' && !Array.isArray(coverage)) {
    for (const [dim, entry] of Object.entries(coverage)) {
      const state = entry?.state;
      if (typeof state !== 'string' || !COVERAGE_STATES.has(state)) {
        bad.push(`${dim}=${JSON.stringify(state ?? null)}`);
      }
    }
  }
  return bad;
}

/**
 * @param {object} s live state, all of it already fetched
 * @param {object[]} s.dims           public.discovery_dimensions, EVERY row (active and not) —
 *                                    filtering happens in here, the same reason provider-catalog-
 *                                    check.mjs takes `rows` unfiltered: a mutation fixture needs to
 *                                    be able to hand this function a row the real fetch never would.
 * @param {Set<string>|string[]} s.archetypeKeys  public.role_archetypes.key, every row
 * @param {object[]} s.sessions       public.discovery_sessions, EVERY row: {id, coverage}
 * @param {object}   s.priv           table-privilege booleans, see certify.mjs's discovery-spine section
 * @returns {{failures: string[], dimensionsExamined: number, activeDimensionsExamined: number, sessionsExamined: number}}
 */
export function discoverySpineFailures(s) {
  const dims = s.dims ?? [];
  const archetypeKeys = s.archetypeKeys instanceof Set ? s.archetypeKeys : new Set(s.archetypeKeys ?? []);
  const sessions = s.sessions ?? [];
  const priv = s.priv ?? {};
  const failures = [];

  // ── Zero examined is itself a violation ─────────────────────────────────
  // A gate that silently examined nothing renders identically to a clean
  // result — this repo has shipped that exact shape of checker-that-cannot-
  // fail more than once. discovery_dimensions is seeded, standing product
  // data: it must NEVER legitimately be empty, so an empty fetch here can
  // only mean the query broke, the table got truncated, or the grant that
  // lets this section read it was revoked — every one of those is a real
  // finding, not a quiet pass. Proven by the 'zero dimensions fetched' fixture
  // in certify-mutation-test.mjs.
  if (dims.length === 0) {
    failures.push('examined ZERO discovery_dimensions rows — the fetch is broken, the table is empty, or the SELECT grant is gone; this can never legitimately be zero');
  }

  const active = dims.filter((d) => d.active);

  // ── 14 (whatever "14" actually is today) active dimensions, unique + contiguous ordinals ──
  const ordinals = active.map((d) => d.ordinal);
  const ordinalCounts = new Map();
  for (const o of ordinals) ordinalCounts.set(o, (ordinalCounts.get(o) ?? 0) + 1);
  const dupedOrdinals = [...ordinalCounts.entries()].filter(([, n]) => n > 1).map(([o]) => o);
  if (dupedOrdinals.length) {
    failures.push(`duplicate ordinal(s) among active dimensions: ${dupedOrdinals.join(', ')} — two dimensions cannot occupy the same interview slot`);
  }
  if (active.length === 0) {
    failures.push('examined ZERO active discovery_dimensions rows — every dimension has been deactivated, or the spine itself was never seeded');
  } else if (dupedOrdinals.length === 0) {
    // Only meaningful once ordinals are actually unique — this is exactly the
    // arithmetic migration 734's own re-add of the UNIQUE constraint leaned
    // on: N distinct ordinals with min=1 and max=N can only be the
    // contiguous run 1..N. Checked BEHIND the duplicate check, not instead
    // of it, so a dup and a gap occupying the same numbers don't hide
    // each other.
    const min = Math.min(...ordinals);
    const max = Math.max(...ordinals);
    if (min !== 1 || max !== active.length) {
      failures.push(`ordinals are not a contiguous 1..${active.length} run (min ${min}, max ${max}, ${active.length} active dimension(s))`);
    }
  }

  // ── No dimension references a non-existent archetype, except planned_* ──
  // planned_ is migration 734's deliberate escape hatch (founder ruling A):
  // it is what makes discovery_capability_gaps reachable at all, so it is
  // exempt BY PREFIX, not absent from this check. A genuine typo on a REAL
  // key is still refused, in both directions the migrations themselves
  // check for (a dangling reference AND, implicitly, that planned_ isn't a
  // way to typo past this silently — a typo'd planned_ key still starts
  // with planned_ and is still exempt by design, matching the migrations'
  // own orphan check exactly).
  for (const d of active) {
    for (const a of d.serves_archetypes ?? []) {
      if (a.startsWith('planned_')) continue;
      if (!archetypeKeys.has(a)) {
        failures.push(`${d.key} names archetype "${a}" which does not exist in role_archetypes and is not planned_`);
      }
    }
  }

  // ── Guidance >= 120 chars, produces non-empty ────────────────────────────
  for (const d of active) {
    const len = (d.guidance ?? '').length;
    if (len < 120) failures.push(`${d.key} guidance is only ${len} char(s) (< 120) — too thin to tell a model when to stop asking`);
    if (!(d.produces ?? []).length) failures.push(`${d.key} has an empty produces — nothing tells a later reader what this dimension is FOR`);
  }

  // ── No discovery_sessions row holds a coverage value outside the four states ──
  // sessionsExamined is reported unconditionally below (never only on
  // violation) so "0 sessions, 0 findings" can never be misread as "checked
  // and clean" — see certify.mjs's discovery-spine section for why this
  // count does not ALSO gate ok/not-ok the way dimensionsExamined does: the
  // discovery interview has not been used in production yet (task-3-report:
  // "Function not deployed"), so 0 is today's honest, legitimate count, not
  // a broken fetch — and forcing it to fail would also make every mutation
  // fixture's own "clean" baseline non-silent, since that baseline IS live
  // production state.
  for (const sess of sessions) {
    const bad = coverageViolations(sess.coverage);
    if (bad.length) {
      failures.push(`discovery_sessions ${sess.id} holds coverage state(s) outside {heard,parked,skipped,not_heard}: ${bad.join(', ')}`);
    }
  }

  // ── Grants: authenticated reads discovery_dimensions, writes nothing ────
  if (!priv.dimSelectAuthenticated) failures.push('authenticated CANNOT SELECT discovery_dimensions — the interview UI could not read the spine');
  if (priv.dimInsertAuthenticated) failures.push('authenticated can INSERT discovery_dimensions — the spine is supposed to be service_role-only to write');
  if (priv.dimUpdateAuthenticated) failures.push('authenticated can UPDATE discovery_dimensions — the spine is supposed to be service_role-only to write');
  if (priv.dimDeleteAuthenticated) failures.push('authenticated can DELETE discovery_dimensions — the spine is supposed to be service_role-only to write');

  // ── discovery_capability_demand: service_role only, it aggregates across every tenant ──
  if (priv.demandSelectAuthenticated) failures.push('authenticated can SELECT discovery_capability_demand — this view aggregates DEMAND ACROSS EVERY TENANT and must be service_role-only');
  if (priv.demandSelectAnon) failures.push('anon can SELECT discovery_capability_demand — this view aggregates DEMAND ACROSS EVERY TENANT and must be service_role-only');

  return {
    failures,
    dimensionsExamined: dims.length,
    activeDimensionsExamined: active.length,
    sessionsExamined: sessions.length,
  };
}
