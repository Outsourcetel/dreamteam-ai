// ============================================================
// THE SPINE — public.discovery_dimensions
//
// A fixed list of what must be KNOWN about a business, so a short interview
// can still be a complete one. The founder's requirement, verbatim: "I don't
// want to lose the depth of the interview or getting side tracked because
// customer got focused on one thing and forgot other critical pieces."
//
// The spine is DATA, not code, so that adding procurement later is an INSERT
// plus an archetype rather than a redeploy of the interview.
//
// ROUND 1 REVIEW fixed three Criticals in migration 734 (733 stays applied,
// untouched):
//   - the capability-gap view was unreachable BY CONSTRUCTION — it could only
//     fire when EVERY archetype a dimension named was missing, and the
//     orphan check refused exactly that state from ever being committed.
//     Fixed with a founder-specified `planned_` prefix: a dimension may name
//     a role we do not have yet, exempted from the orphan check, and the gap
//     view now reports it — proven below on the REAL committed spine, not
//     only via a rolled-back probe (that would repeat 733's mistake).
//   - money_out was re-derived as money LEAVING the business (AP, FP&A,
//     vendor/buy-side renewals), not ad-spend caps.
//   - who_signs_off / must_never_happen no longer close on silence — the
//     guidance now says explicitly that capturing nothing is not coverage.
//
// Read-only: runQuery() refuses anything that is not a lone SELECT/WITH.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';

const run = adminTokenAvailable() ? describe : describe.skip;

const EXPECTED = [
  'what_we_do', 'how_customers_reach_us', 'money_in', 'money_out',
  'winning_business', 'after_the_sale', 'how_work_gets_delivered', 'repetitive_work',
  'systems_of_record', 'the_workforce_itself', 'must_never_happen', 'who_signs_off',
  'who_is_who', 'what_good_looks_like',
];

run('the spine', () => {
  it('carries exactly the fourteen dimensions, in order', async () => {
    const rows = await runQuery<{ key: string; ordinal: number }>(
      'select key, ordinal from public.discovery_dimensions where active order by ordinal');
    expect(rows.map((r) => r.key)).toEqual(EXPECTED);
    expect(rows.map((r) => r.ordinal)).toEqual(rows.map((_, i) => i + 1));
  });

  it('gives every dimension guidance a model could act on', async () => {
    const thin = await runQuery<{ key: string; n: number }>(
      "select key, length(guidance) as n from public.discovery_dimensions where active and length(coalesce(guidance,'')) < 120");
    expect(thin.map((r) => r.key), 'dimensions with guidance too thin to be useful').toEqual([]);
  });

  it('names, for each dimension, what it produces', async () => {
    const empty = await runQuery<{ key: string }>(
      "select key from public.discovery_dimensions where active and coalesce(array_length(produces,1),0) = 0");
    expect(empty.map((r) => r.key), 'dimensions that produce nothing are questions asked out of curiosity').toEqual([]);
  });

  it('only claims archetypes that actually exist, unless explicitly marked planned_', async () => {
    // A dimension pointing at a role key that is neither real nor marked
    // planned_ would silently never staff, and would never be reported as a
    // gap either. planned_ is the one exemption (founder ruling, round 1) —
    // it is how a dimension names a role known not to exist yet. A genuine
    // typo on a REAL key must still be refused.
    const bad = await runQuery<{ dimension_key: string; missing: string }>(`
      select d.key as dimension_key, a as missing
        from public.discovery_dimensions d
        cross join lateral unnest(d.serves_archetypes) a
       where d.active and a !~ '^planned_'
         and not exists (select 1 from public.role_archetypes r where r.key = a)`);
    expect(bad, 'dimensions referencing non-existent, non-planned archetypes').toEqual([]);
  });

  it('derives capability gaps rather than hand-maintaining them, and the view actually fires', async () => {
    // Round 1 proved the OLD view unreachable by construction: it fired only
    // when ALL of a dimension's archetypes were missing, which the orphan
    // check made impossible to commit. This is asserted on the REAL,
    // currently-committed rows — not a rolled-back probe — specifically so
    // "gaps -> []" can never again be reported as a clean, checked result by
    // accident. Today how_work_gets_delivered (planned_procurement,
    // planned_qa) and the_workforce_itself (planned_legal) should both fire.
    const gaps = await runQuery<{ dimension_key: string; planned_archetypes: string[]; customer_message: string }>(
      'select dimension_key, planned_archetypes, customer_message from public.discovery_capability_gaps order by dimension_key');
    console.log(`capability gaps today: ${gaps.map((g) => `${g.dimension_key} (${g.planned_archetypes.join(', ')})`).join('; ') || '(none)'}`);

    expect(gaps.length, 'the view must report at least one gap on the real committed spine').toBeGreaterThan(0);
    for (const g of gaps) {
      expect(g.planned_archetypes.length, `${g.dimension_key} must name which planned_ role(s) are missing`).toBeGreaterThan(0);
      expect(g.planned_archetypes.every((a) => a.startsWith('planned_')), `${g.dimension_key} planned_archetypes must all carry the prefix`).toBe(true);
      // Founder ruling A, item 2: the message is a promise, not an apology,
      // and it must be the SAME text regardless of which surface reads it —
      // enforced here by asserting on the view's own computed column rather
      // than a UI string a future page could drift from.
      expect(g.customer_message, `${g.dimension_key} customer_message must promise to build it`).toMatch(/will build/i);
      expect(g.customer_message, `${g.dimension_key} customer_message must not read as an apology/refusal`).not.toMatch(/sorry|we can.?t|unable to/i);
    }

    // Dimensions with no serves_archetypes at all (config-only) must never
    // appear — they never claimed a role in the first place.
    const configOnly = ['what_we_do', 'must_never_happen', 'who_signs_off', 'who_is_who', 'what_good_looks_like'];
    const gapKeys = gaps.map((g) => g.dimension_key);
    expect(configOnly.filter((k) => gapKeys.includes(k)), 'config-only dimensions must never be reported as gaps').toEqual([]);
  });

  it('who_signs_off and must_never_happen cannot be closed by silence', async () => {
    // Critical 3 (round 1): both guidance strings used to end "...every
    // threshold YOU HAVE HEARD has a value and an approver" / "...a
    // violation would be unambiguous" — both vacuously true when NOTHING was
    // captured (a universal claim over an empty set). The spec says these
    // are exactly the two topics a customer never volunteers, so on a
    // sidetracked transcript they would have self-closed for free — the
    // founder's stated fear for the whole spine. The fix requires the
    // guidance to say, explicitly, that an absence of capture is not
    // coverage — checked here by a literal phrase so a future edit cannot
    // quietly drift back to the vacuous form without failing this test.
    const rows = await runQuery<{ key: string; guidance: string }>(
      "select key, guidance from public.discovery_dimensions where active and key in ('who_signs_off','must_never_happen')");
    expect(rows.length, 'both dimensions must exist').toBe(2);
    for (const r of rows) {
      expect(r.guidance.toLowerCase(), `${r.key} guidance must state that silence is not coverage`)
        .toContain('silence is not coverage');
    }
  });
});
