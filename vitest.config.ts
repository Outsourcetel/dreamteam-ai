import { defineConfig } from 'vitest/config';

// ── Why two obviously-fake values live here ────────────────────────────────
// `src/lib/env.ts` throws at MODULE LOAD if VITE_SUPABASE_URL or
// VITE_SUPABASE_ANON_KEY is absent — correct for the browser bundle, where a
// missing value means a broken deploy. But `src/supabase.ts` imports it, and so
// does most of `src/lib`, so any pure-logic test that transitively touches a lib
// module died on import with:
//
//     Error: Missing required environment variable: VITE_SUPABASE_URL.
//
// Measured 2026-08-22: that single throw gated 3 whole test files and 182 tests
// that need no credential of any kind. The full sweep went from 521 passing to
// 703 passing purely by putting two junk strings in scope.
//
// These are NOT credentials and must never look like a place to put one. They
// are syntactically valid so `createClient()` can be constructed, and point at
// a reserved-by-RFC-2606 hostname that cannot resolve, so any test that
// accidentally tries to reach the network fails loudly rather than talking to
// something real.
//
// ⚠ They do NOT mask the credentialed suites. Those read VITE_TEST_SUPABASE_URL
// and VITE_TEST_SUPABASE_ANON_KEY from .env.test via tests/setup.ts — different
// variables entirely — and still throw when it is missing, which is the
// behaviour ci.yml depends on.
//
// A real value in the environment wins, so a developer with a .env is unaffected.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? 'https://offline.invalid',
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY ?? 'offline-test-not-a-key',
    },
  },
});
