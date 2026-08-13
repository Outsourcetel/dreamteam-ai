// ============================================================
// THE SIDETRACK TEST
//
// The founder's requirement, verbatim: "I don't want to lose the depth of
// the interview or getting side tracked because customer got focused on one
// thing and forgot other critical pieces."
//
// A customer who talks about nothing but support tickets must still finish
// with money_in, must_never_happen and who_signs_off marked not_heard, and
// those gaps must be reported. IF THIS TEST CANNOT FAIL, THIS FEATURE DOES
// NOT WORK.
//
// It drives the PURE coverage function with fixture extractions, so it
// proves the spine logic without spending a model call or depending on
// model mood.
//
// ── TWO DELIBERATE DEVIATIONS FROM task-3-brief.md, both load-bearing ──
//
// 1. THE DIMENSION LIST. The brief's own DIMS fixture lists twelve keys and
//    is explicitly flagged stale in the task instructions: there are
//    FOURTEEN live dimensions, two of the brief's twelve have moved
//    position, and two (how_work_gets_delivered, the_workforce_itself) are
//    missing outright. The real, live order (confirmed against
//    public.discovery_dimensions and cross-checked against
//    tests/discovery-spine.test.ts's own EXPECTED array, which this file's
//    DIMS is a direct copy of) is used below. A new test arm at the bottom
//    reads the live keys and asserts DIMS matches — so the NEXT dimension
//    this product ever adds fails this file loudly instead of leaving DIMS
//    to rot the way the brief's own fixture did.
//
// 2. WHERE coverageAfter LIVES. The brief's snippet reads:
//      import { coverageAfter } from '../supabase/functions/discovery-interview/index.ts';
//    That import is not possible under this repo's real toolchain. Proven
//    directly, before writing this file, by importing an existing edge
//    function's index.ts (entity-draft, which — like the discovery-interview
//    turn loop this task also builds — has a top-level `serve(...)` call
//    using `serve` imported from https://deno.land/std@0.168.0/http/server.ts)
//    the same way this test would need to import discovery-interview's:
//
//      $ npx vitest run <a throwaway probe importing entity-draft/index.ts>
//      Error: Only URLs with a scheme in: file and data are supported by
//      the default ESM loader. Received protocol 'https:'
//
//    Node's ESM loader (vitest runs on Node) refuses any import whose
//    scheme is not file:/data:, full stop, before a single line of the
//    importing module's own code runs — independent of whether the actual
//    edge-function handler is invoked. discovery-interview/index.ts's real
//    turn loop (Step 6) needs exactly this shape (serve + createClient +
//    the shared LLM client, all genuinely called, none of it elidable), so
//    the same failure would reproduce the moment the turn loop existed —
//    this is not a workaround for something missing today, it is a
//    permanent property of importing a real Deno edge-function entry point
//    from Node.
//
//    This repo already has the answer for exactly this shape of problem:
//    _shared/confidence.ts and _shared/contentHash.ts hold pure logic that
//    both a Deno edge function AND a vitest suite need, specifically
//    BECAUSE they carry zero Deno-only imports — and both are already
//    tested directly from vitest (tests/confidence-parity.test.ts,
//    tests/knowledge-acl-invariants.test.ts). coverageAfter follows the
//    identical pattern: it lives in
//    supabase/functions/_shared/discoveryCoverage.ts, which
//    discovery-interview/index.ts imports AND re-exports (so it stays a
//    real, documented export of the deployed function), and this test
//    imports it from the _shared module directly, which is the only path
//    that can actually succeed.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';
import { coverageAfter } from '../supabase/functions/_shared/discoveryCoverage.ts';

// The real, live fourteen — see deviation 1 above. Identical order to
// tests/discovery-spine.test.ts's own EXPECTED array (that file asserts
// this order against the live table; this file assumes it, and the new
// 'stays honest' block at the bottom re-proves it independently rather than
// trusting that the two files can never drift apart from each other).
const DIMS = [
  'what_we_do', 'how_customers_reach_us', 'money_in', 'money_out',
  'winning_business', 'after_the_sale', 'how_work_gets_delivered', 'repetitive_work',
  'systems_of_record', 'the_workforce_itself', 'must_never_happen', 'who_signs_off',
  'who_is_who', 'what_good_looks_like',
].map((key, i) => ({ key, ordinal: i + 1 }));

describe('the sidetrack test', () => {
  it('reports what a support-obsessed conversation never covered', () => {
    // Red if: coverageAfter defaults an unmentioned dimension to anything
    // other than not_heard (e.g. a buggy implementation that seeds from
    // extraction rather than from the full dimension list).
    const cov = coverageAfter(DIMS, [], [
      { dimension: 'what_we_do', state: 'heard', evidence: 'we make scheduling software' },
      { dimension: 'how_customers_reach_us', state: 'heard', evidence: 'email and a chat widget' },
      { dimension: 'repetitive_work', state: 'heard', evidence: 'password resets, endlessly' },
    ]);
    for (const k of ['money_in', 'must_never_happen', 'who_signs_off']) {
      expect(cov[k].state, `${k} must remain not_heard`).toBe('not_heard');
    }
  });

  it('never drops a dimension from the ledger', () => {
    // A missing key reads identically to an unaddressed one. Red if: the
    // returned map only contains keys mentioned by extraction or prior
    // coverage, dropping every dimension the conversation never touched.
    const cov = coverageAfter(DIMS, [], [{ dimension: 'money_in', state: 'heard', evidence: 'x' }]);
    expect(Object.keys(cov).sort()).toEqual(DIMS.map((d) => d.key).sort());
  });

  it('brings a parked dimension back, and leaves a skipped one alone', () => {
    // Red if: parked/skipped are normalised into each other, or 'owed'
    // includes a skipped dimension (nagging someone who declined) or
    // excludes a parked one (burying what they meant to return to).
    const cov = coverageAfter(DIMS, [], [
      { dimension: 'money_out', state: 'parked', evidence: 'ask me later' },
      { dimension: 'winning_business', state: 'skipped', evidence: 'we do not sell' },
    ]);
    expect(cov.money_out.state).toBe('parked');
    expect(cov.winning_business.state).toBe('skipped');
    // The behavioural difference: only parked is still owed a question.
    const owed = Object.entries(cov).filter(([, v]) => v.state === 'not_heard' || v.state === 'parked');
    expect(owed.map(([k]) => k)).toContain('money_out');
    expect(owed.map(([k]) => k)).not.toContain('winning_business');
  });

  it('refuses an extraction naming a dimension that does not exist', () => {
    // The model returns free-form JSON. A typo must not silently create a
    // fifteenth dimension nobody asked for. Red if: coverageAfter writes
    // whatever key the model handed it instead of validating against the
    // real spine.
    expect(() => coverageAfter(DIMS, [], [
      { dimension: 'moneyin', state: 'heard', evidence: 'typo' },
    ])).toThrow(/unknown dimension/i);
  });

  it('refuses an extraction naming a state that does not exist', () => {
    // Same failure mode, the other axis: 'herd' is not 'heard'. Red if:
    // coverageAfter accepts any string as a state, corrupting the ledger
    // with a fifth value discovery_coverage_states_valid would reject.
    expect(() => coverageAfter(DIMS, [], [
      { dimension: 'money_in', state: 'herd', evidence: 'typo' },
    ])).toThrow(/unknown state/i);
  });

  it('counts what it compared', () => {
    // Red if: the fixture silently shrinks (e.g. someone deletes a case
    // above and forgets to update DIMS) without this number moving too —
    // paired with the live-spine check below, which is the version of this
    // assertion that can actually catch real drift rather than only
    // self-consistency of this file.
    const cov = coverageAfter(DIMS, [], []);
    expect(Object.keys(cov)).toHaveLength(14);
    console.log(`sidetrack fixtures compared against ${DIMS.length} dimensions`);
  });

  it('carries a real prior coverage object forward, not just an empty array', () => {
    // None of the cases above ever pass a populated second argument — every
    // one starts from `[]`. The real turn loop calls coverageAfter on every
    // later turn with the SESSION's actual coverage object (an OBJECT, not
    // an array), so this is the case that actually exercises "prior
    // coverage", not just "no prior coverage". Red if: a real prior object
    // is treated the same as no prior state (losing everything already
    // heard on turn 2+), or if an extraction silently fails to override a
    // prior entry.
    const prior = {
      what_we_do: { state: 'heard' as const, evidence: 'a two-location dental practice' },
      money_in: { state: 'parked' as const, evidence: 'ask again later' },
    };
    const cov = coverageAfter(DIMS, prior, [
      { dimension: 'money_in', state: 'heard', evidence: 'invoice monthly out of Xero, net 30' },
    ]);
    // Untouched this turn: carried forward exactly as it was.
    expect(cov.what_we_do.state).toBe('heard');
    expect(cov.what_we_do.evidence).toBe('a two-location dental practice');
    // Touched this turn: the new extraction wins over the prior 'parked'.
    expect(cov.money_in.state).toBe('heard');
    expect(cov.money_in.evidence).toBe('invoice monthly out of Xero, net 30');
    // Never mentioned, ever: still present, still not_heard.
    expect(cov.must_never_happen.state).toBe('not_heard');
  });
});

const run = adminTokenAvailable() ? describe : describe.skip;

run('the fixture stays honest against the live spine', () => {
  it('DIMS matches the live discovery_dimensions keys, in ordinal order', async () => {
    // The whole reason task-3-brief.md's own fixture went stale: nothing
    // ever re-checked it against the table it was copied from. Red if: a
    // future migration adds, removes, renames or reorders a dimension and
    // nobody updates DIMS above — this is exactly the drift the task
    // instructions warned this task not to repeat.
    const rows = await runQuery<{ key: string }>(
      'select key from public.discovery_dimensions where active order by ordinal');
    expect(rows.map((r) => r.key), 'DIMS has drifted from the live spine — update the fixture at the top of this file').toEqual(DIMS.map((d) => d.key));
  });
});
