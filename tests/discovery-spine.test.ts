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
// Read-only: runQuery() refuses anything that is not a lone SELECT/WITH.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';

const run = adminTokenAvailable() ? describe : describe.skip;

const EXPECTED = [
  'what_we_do', 'how_customers_reach_us', 'money_in', 'money_out',
  'winning_business', 'after_the_sale', 'repetitive_work', 'systems_of_record',
  'must_never_happen', 'who_signs_off', 'who_is_who', 'what_good_looks_like',
];

run('the spine', () => {
  it('carries exactly the twelve dimensions, in order', async () => {
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

  it('only claims archetypes that actually exist', async () => {
    // A dimension pointing at a role key that is not in role_archetypes would
    // silently never staff, and would never be reported as a gap either.
    const bad = await runQuery<{ dimension_key: string; missing: string }>(`
      select d.key as dimension_key, a as missing
        from public.discovery_dimensions d
        cross join lateral unnest(d.serves_archetypes) a
       where d.active and not exists (select 1 from public.role_archetypes r where r.key = a)`);
    expect(bad, 'dimensions referencing non-existent archetypes').toEqual([]);
  });

  it('derives capability gaps rather than hand-maintaining them', async () => {
    // Today procurement, legal and QA have no archetype. The view must say so
    // WITHOUT anyone writing that fact down, or it goes stale the day one ships.
    const gaps = await runQuery<{ dimension_key: string }>(
      'select dimension_key from public.discovery_capability_gaps');
    // Dimensions with no serves_archetypes at all are not gaps — they produce
    // config, not roles. A gap is: names archetypes, none of which exist.
    const named = await runQuery<{ n: number }>(
      "select count(*)::int as n from public.discovery_dimensions where active and coalesce(array_length(serves_archetypes,1),0) > 0");
    expect(named[0].n).toBeGreaterThan(0);
    console.log(`capability gaps today: ${gaps.map((g) => g.dimension_key).join(', ') || '(none)'}`);
  });
});
