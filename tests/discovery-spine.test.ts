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
// ROUND 2 REVIEW (migration 735, 733/734 stay applied, untouched):
//   - the silence-cannot-close fix was scoped to only the two dimensions a
//     reviewer had caught. That scoping was wrong: the defect is the SHAPE
//     "for every X [discussed/in use], P holds" — vacuously true over an
//     empty set — and it is a defect wherever that shape appears, not just
//     in the two named places. All fourteen dimensions now carry an explicit
//     silence-guard; checked below across all fourteen, not two.
//   - planned_legal moved from the_workforce_itself (hiring/payroll/rotas —
//     legal is none of those) to money_out (vendor contracts and their
//     review, which is where a legal-capability gap actually surfaces).
//
// ROUND 3 REVIEW (migration 736, 733/734/735 stay applied, untouched):
//   - Founder ruling: the_workforce_itself now carries {planned_hr}, same
//     mechanism as procurement/QA/legal. Before this, '{}' meant two
//     different things on different dimensions (see migration 736's
//     header); after it, '{}' means only "produces settings, not a role" —
//     checked below by confirming the five dimensions that mean it stay
//     empty.
//   - The old "dimensions with empty serves_archetypes never appear as
//     gaps" assertion (previously here) was DELETED: given the view's own
//     `gaps.planned_archetypes is not null` guard, an empty array cannot
//     structurally produce a gap row, so that assertion could never fail —
//     protecting nothing while reading as a guarantee. The real,
//     falsifiable version of that check now lives in migration 736's `do $$`
//     block as a THIRD rolled-back probe case (an empty-array row, asserted
//     absent from the gap view) — vitest has no write access to run a probe
//     like that itself.
//   - winning_business regained a hard, numeric ad-spend ceiling
//     (google_ads.budget_caps), lost when money_out was correctly
//     re-derived in round 1 and never re-homed anywhere.
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
    // accident. As of round 3, how_work_gets_delivered (planned_procurement,
    // planned_qa), money_out (planned_legal) and the_workforce_itself
    // (planned_hr) should all three fire.
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
  });

  it('the config-only dimensions have not silently gained an archetype', async () => {
    // Round 3 review, item 2: this REPLACES a deleted assertion that queried
    // discovery_dimensions joined to discovery_capability_gaps for dimensions
    // with an empty serves_archetypes array. That assertion could never fail:
    // the view only ever returns a row when
    // `unnest(serves_archetypes) has a planned_-prefixed element`, and an
    // empty array cannot contain one — structurally, not by luck of today's
    // data. It read as protecting the config dimensions from ever being
    // misreported as gaps and protected nothing, because no state of this
    // table could have violated it. Proven empirically before deleting it:
    // a one-off SELECT reproducing the view WITHOUT its `is not null` guard
    // returns all 14 active dimensions, config ones included — that guard is
    // where the real guarantee lives, not in any data query.
    //
    // What CAN meaningfully regress at the data layer is different: a future
    // migration accidentally attaching a real or planned_ archetype to one
    // of the five dimensions that are supposed to stay pure config (they
    // produce settings — vocabulary, guardrails, approval chains, contact
    // maps, success criteria — never a role). That is what this checks.
    // Round 1 made the_workforce_itself's old membership here temporary
    // (Founder Ruling A gave it planned_hr instead) — these five are the
    // ones the clarified rule (migration 736) says stay empty permanently.
    const configOnly = ['what_we_do', 'must_never_happen', 'who_signs_off', 'who_is_who', 'what_good_looks_like'];
    const rows = await runQuery<{ key: string; n: number }>(
      "select key, coalesce(array_length(serves_archetypes,1),0) as n from public.discovery_dimensions where active");
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.n]));
    const drifted = configOnly.filter((k) => (byKey[k] ?? 0) !== 0);
    expect(drifted, 'config-only dimensions that have gained an archetype').toEqual([]);
  });

  it('no dimension can be closed by a transcript that said nothing about it', async () => {
    // Round 2 review: round 1 fixed exactly the two dimensions a reviewer
    // had caught (who_signs_off, must_never_happen) and left seven more
    // guidance strings with a closing test that used a DIFFERENT wording but
    // the same practical risk, and five of those seven had the identical
    // formal bug — "for every X [discussed/in use/mentioned so far], P
    // holds", vacuously true over an empty set, i.e. satisfied by silence.
    // The founder's ruling: a coverage guarantee that holds for two of
    // fourteen dimensions is a coverage suggestion. This is deliberately a
    // test of ALL fourteen, not a re-check of the same two — "a test that
    // checks two of fourteen has the same shape as the bug".
    const rows = await runQuery<{ key: string; guidance: string }>(
      'select key, guidance from public.discovery_dimensions where active');
    expect(rows.length, 'all fourteen dimensions must exist').toBe(14);
    const missing = rows.filter((r) => !r.guidance.toLowerCase().includes('silence is not coverage'));
    expect(missing.map((r) => r.key), 'dimensions whose guidance can still be closed by silence').toEqual([]);
  });

  it('planned_legal lives under money_out, not the_workforce_itself', async () => {
    // Round 2, item 2: legal (contracts, terms, compliance, signature
    // authority) is not hiring/payroll/rotas. A customer describing contract
    // review would never reach the_workforce_itself's questions to trigger
    // the gap in the first place. Moved to money_out, which already
    // discusses vendor contracts and their renewal review.
    const rows = await runQuery<{ key: string; serves_archetypes: string[] }>(
      "select key, serves_archetypes from public.discovery_dimensions where active and key in ('money_out','the_workforce_itself')");
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.serves_archetypes]));
    expect(byKey['money_out'], 'money_out must carry planned_legal').toContain('planned_legal');
    expect(byKey['the_workforce_itself'] ?? [], 'the_workforce_itself must no longer carry planned_legal').not.toContain('planned_legal');
  });

  it('the_workforce_itself carries planned_hr', async () => {
    // Round 3 founder ruling: apply the same gap mechanism procurement,
    // legal and QA already get. A customer describing payroll and rotas now
    // gets the identical "we'll build one around what you've described"
    // promise, and the platform gets the same demand flag.
    const rows = await runQuery<{ serves_archetypes: string[] }>(
      "select serves_archetypes from public.discovery_dimensions where active and key = 'the_workforce_itself'");
    expect(rows.length).toBe(1);
    expect(rows[0].serves_archetypes).toEqual(['planned_hr']);
  });

  it('winning_business elicits an ad-spend ceiling as a number, not an intention', async () => {
    // Round 3, item 3: money_out's correct re-derivation to AP/vendor
    // renewals (round 1) dropped google_ads.budget_caps ("e.g. $500/day,
    // $12,000/month") on the way out — no dimension asked for it afterward.
    // Re-homed to winning_business, which already discusses google_ads for
    // its conversion_goals fact. A prose mention of "budget" would not be
    // enough — the guidance must actually contain a dollar figure, the same
    // way money_in's worked example contains "net 30" rather than "prompt
    // payment terms".
    const rows = await runQuery<{ guidance: string }>(
      "select guidance from public.discovery_dimensions where active and key = 'winning_business'");
    expect(rows.length).toBe(1);
    expect(rows[0].guidance, 'winning_business guidance must contain a concrete dollar figure').toMatch(/\$[0-9]/);
  });
});
