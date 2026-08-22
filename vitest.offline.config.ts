import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// ============================================================================
// The credential-free sweep — everything that CAN run without a secret.
//
// ── WHAT THIS REPLACED, AND WHY IT MATTERED ────────────────────────────────
// `test:unit` was a hand-maintained ALLOWLIST of five filenames. CI ran those
// five and nothing else, so of 40 test files:
//
//     CI executed         5 files /  56 tests
//     runnable offline   33 files / 717 tests      (measured 2026-08-22)
//
// CI was proving 8% of what it already had. The gap was not a missing suite —
// it was a list nobody had extended in months. `certify:offline`'s `suite`
// section ran the same five, so a second green tick agreed with the first for
// the same reason.
//
// The cost is not theoretical. `trust-promotion-applied-server-side.test.ts` is
// the guard on a server-side refusal reaching the user, and it ran in no
// automation; deleting the guard it protects left CI green. Same for
// `human-tasks-trust-promotion-gate`, `role-cannot`, `closed-pages`,
// `write-bindings` and `service-caller`.
//
// ── WHY AN EXCLUDE LIST BEATS AN INCLUDE LIST ──────────────────────────────
// An allowlist fails silently when someone adds a test file: the file simply
// never runs, and nothing anywhere says so. A denylist fails loudly: a new file
// runs by default, and the only way to lose coverage is to add a line here,
// deliberately, in a diff a reviewer sees.
//
// ── THE SEVEN, AND WHY EACH IS OUT ─────────────────────────────────────────
// Every one imports tests/helpers/testTenant.ts or asserts against a live
// project, and throws at module load without .env.test or SUPABASE_ACCESS_TOKEN.
// They fail LOUDLY rather than skipping, which is correct and deliberate — see
// ci.yml's header — so they cannot simply be left in.
//
// They are NOT abandoned: ci.yml runs tenant-isolation and
// knowledge-acl-invariants in their own credentialed jobs, gated by
// scripts/ci-require-secrets.sh. The rest run in a full local `certify`.
//
// ⚠ VERIFY BEFORE EDITING THIS LIST. It was derived by running the whole suite
// with no credentials and reading which files failed — not by reasoning about
// which ones look live. Re-derive the same way:
//     npx vitest run 2>&1 | grep '^ FAIL '
// ============================================================================
const CREDENTIALED = [
  'tests/action-gate.test.ts',                  // SUPABASE_ACCESS_TOKEN — 18 tests
  'tests/knowledge-acl-invariants.test.ts',     // SUPABASE_ACCESS_TOKEN — 21 tests (own CI job)
  'tests/playbook-gate.test.ts',                // SUPABASE_ACCESS_TOKEN —  3 tests
  'tests/tenant-isolation.test.ts',             // .env.test —  5 tests (own CI job)
  'tests/approval-learning-capture.test.ts',    // .env.test —  5 tests
  'tests/draft-delivery-consequence.test.ts',   // .env.test —  5 tests
  'tests/review-minutes.test.ts',               // .env.test —  4 tests
];

export default mergeConfig(base, defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', ...CREDENTIALED],
  },
}));
