// discoveryCoverage.ts — the pure spine-coverage reducer for the discovery
// interview engine (.superpowers/sdd/2026-08-13-discovery-interview-engine,
// Task 3: "the engine, and the test it exists to pass").
//
// WHY THIS LIVES HERE AND NOT INLINE IN discovery-interview/index.ts:
// task-3-brief.md's own test snippet imports coverageAfter from
// '../supabase/functions/discovery-interview/index.ts'. That import is not
// possible under this repo's real toolchain, proven empirically before
// writing this file — see tests/discovery-sidetrack.test.ts's header for
// the exact command and the exact error. Short version: every edge
// function's index.ts statically imports `serve` from
// https://deno.land/std@.../http/server.ts and `createClient` from
// https://esm.sh/@supabase/supabase-js@2 as genuine VALUES (serve(handler)
// is actually called; createClient(...) is actually invoked). Node's ESM
// loader — which vitest runs on — refuses any import whose scheme is not
// file: or data:, unconditionally, before a single line of the importing
// module's own code runs. The reason _shared/llm.ts's identical-looking
// `import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'`
// already survives a direct vitest import today (six existing test files do
// exactly this — confidence-parity.test.ts, contract-parity.test.ts, etc.)
// is that SupabaseClient is used SOLELY as a type annotation there; esbuild
// elides an import whose binding is never referenced as a value, so the URL
// is never actually resolved. serve(...), createClient(...) and the model
// call in discovery-interview's real turn loop are not elidable the same
// way. So coverageAfter — the one piece of this task that must be testable
// "without spending a model call or depending on model mood" (task
// instructions, verbatim) — lives in a file with zero Deno-only imports,
// exactly the same move this codebase already made for
// _shared/confidence.ts and _shared/contentHash.ts, both tested directly
// from vitest for the identical structural reason.
// discovery-interview/index.ts imports AND re-exports coverageAfter, so it
// remains a real, documented export of the deployed function for anyone
// reading that file — it is only the TEST that must reach it through this
// module instead.
//
// THE FOUNDER'S REQUIREMENT, VERBATIM, is why this function exists at all:
// "I don't want to lose the depth of the interview or getting side tracked
// because customer got focused on one thing and forgot other critical
// pieces." coverageAfter is the ONE gate every model extraction passes
// through before anything is persisted — the model proposes, this function
// disposes, exactly as de-mission's validateScope works for mission scopes
// and compile-trust-plan's live-validator pass works for trust ladders. A
// dimension the model never mentions this turn keeps its PRIOR state (never
// silently promoted, never silently dropped from the map); an extraction
// naming a dimension outside the real spine is refused outright rather than
// silently minting a fifteenth one nobody asked for.
// ============================================================

export type DiscoveryCoverageState = 'heard' | 'parked' | 'skipped' | 'not_heard';

export const DISCOVERY_COVERAGE_STATES: readonly DiscoveryCoverageState[] =
  ['heard', 'parked', 'skipped', 'not_heard'];

const VALID_STATES: ReadonlySet<string> = new Set(DISCOVERY_COVERAGE_STATES);

/** Anything shaped like a discovery_dimensions row — only `.key` is read,
 *  deliberately, so a test fixture and a live DB row (which both carry many
 *  other columns) are equally valid without an index signature forcing
 *  every caller's own row type to declare one too (TypeScript does not
 *  consider a plain interface assignable to one with an index signature,
 *  even when every property it does have is compatible — proven directly
 *  against this file before writing this comment: `interface Foo {key,
 *  ordinal, title, guidance}` failed to assign to the indexed version with
 *  TS2345/"index signature is missing"). `key` is the only field this
 *  module ever reads, so it is the only field this type requires. */
export interface DiscoveryDimensionLike {
  key: string;
}

export interface DiscoveryCoverageEntry {
  state: DiscoveryCoverageState;
  evidence: string | null;
  /** Present when carried forward from a real, already-persisted entry.
   *  coverageAfter never fabricates this itself — recorded_at is set
   *  server-side by record_dimension_state's own now(), and a client-side
   *  guess here would be a lie about when something was actually recorded. */
  recorded_at?: string | null;
}

export type DiscoveryCoverageMap = Record<string, DiscoveryCoverageEntry>;

/** What the model claims for one dimension it believes it just heard
 *  evidence for. `dimension`/`state` are deliberately typed as `string`,
 *  not the narrower literal types — this is free-form model JSON, and the
 *  whole point of this function is to validate that shape, not trust it. */
export interface DiscoveryExtraction {
  dimension: string;
  state: string;
  evidence?: string | null;
}

/**
 * coverageAfter — apply one turn's extraction on top of prior coverage,
 * against the real dimension list, and return a COMPLETE coverage map.
 *
 * Contract (pinned by tests/discovery-sidetrack.test.ts):
 *  - every dimensions[].key is present in the result, always — a dimension
 *    the extraction never mentions carries its PRIOR state forward
 *    (defaulting to not_heard when there is no prior coverage at all), so a
 *    missing key and an unaddressed dimension can never be confused —
 *    exactly the guarantee start_discovery_session gives at turn zero.
 *  - THROWS on an extraction naming a dimension key not in `dimensions`.
 *  - THROWS on a state outside the four real ones.
 *  - 'parked' and 'skipped' are stored exactly as given, never normalised
 *    into one another and never silently promoted to 'heard'.
 *
 * `priorCoverage` accepts the real production shape (a jsonb OBJECT keyed
 * by dimension, exactly discovery_sessions.coverage) OR an empty
 * array/null/undefined, all treated identically as "no prior state" — the
 * sidetrack test fixtures start every case from `[]` (a session with
 * nothing recorded yet has no coverage object worth naming), and the real
 * turn loop passes the session's actual coverage object on every later
 * turn.
 */
export function coverageAfter(
  dimensions: readonly DiscoveryDimensionLike[],
  priorCoverage: DiscoveryCoverageMap | readonly unknown[] | null | undefined,
  extraction: readonly DiscoveryExtraction[] | null | undefined,
): DiscoveryCoverageMap {
  const knownKeys = new Set(dimensions.map((d) => d.key));
  const prior: DiscoveryCoverageMap =
    priorCoverage && !Array.isArray(priorCoverage) ? (priorCoverage as DiscoveryCoverageMap) : {};

  // Seed from the FULL dimension list, never from what extraction happens to
  // mention — this is what guarantees no key is ever silently absent.
  const next: DiscoveryCoverageMap = {};
  for (const d of dimensions) {
    const existing = prior[d.key];
    next[d.key] = existing && VALID_STATES.has(existing.state)
      ? {
        state: existing.state,
        evidence: existing.evidence ?? null,
        ...(existing.recorded_at != null ? { recorded_at: existing.recorded_at } : {}),
      }
      : { state: 'not_heard', evidence: null };
  }

  for (const item of extraction ?? []) {
    const dim = item?.dimension;
    if (typeof dim !== 'string' || !knownKeys.has(dim)) {
      throw new Error(
        `coverageAfter: unknown dimension "${String(dim)}" — not one of the ${dimensions.length} real dimensions (a model typo must not mint a new one)`,
      );
    }
    const state = item?.state;
    if (typeof state !== 'string' || !VALID_STATES.has(state)) {
      throw new Error(
        `coverageAfter: unknown state "${String(state)}" for dimension "${dim}" — must be one of ${DISCOVERY_COVERAGE_STATES.join(', ')}`,
      );
    }
    next[dim] = { state: state as DiscoveryCoverageState, evidence: item.evidence ?? null };
  }

  return next;
}

/** Dimensions still owed a question this session: not yet heard, or parked
 *  for later. The turn loop's next question must always target one of
 *  these — the model cannot leave the spine — and the interview is `done`
 *  only once this is empty. 'skipped' is deliberately NOT owed: a customer
 *  who said "not relevant to us" is not nagged again for it. */
export function stillOwed(coverage: DiscoveryCoverageMap): string[] {
  return Object.entries(coverage)
    .filter(([, v]) => v.state === 'not_heard' || v.state === 'parked')
    .map(([k]) => k);
}
