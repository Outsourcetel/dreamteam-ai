// ============================================================
// Shared test config. Points at the isolated dev/schema-clone
// Supabase project (nmuntxrcdksyhsdywpan), never production —
// see .env.test (gitignored) for the URL/anon key, fetched via
// the Management API and never committed. Tests create and clean
// up their own real auth users/tenants in that project; the anon
// key alone is enough (no service-role key needed anywhere here).
// ============================================================
import { config } from 'dotenv';
import WebSocket from 'ws';

config({ path: '.env.test' });

// @supabase/supabase-js always constructs a Realtime client (unused by
// these tests, which are plain REST/RPC calls) and Node 20 has no
// native WebSocket global — polyfill it so createClient() doesn't throw.
if (!(globalThis as any).WebSocket) {
  (globalThis as any).WebSocket = WebSocket;
}

export const TEST_SUPABASE_URL = process.env.VITE_TEST_SUPABASE_URL!;
export const TEST_SUPABASE_ANON_KEY = process.env.VITE_TEST_SUPABASE_ANON_KEY!;

const REFRESH_HINT =
  'Get the current key with:\n' +
  '    npx supabase projects api-keys --project-ref nmuntxrcdksyhsdywpan\n' +
  'and put the anon/publishable one in .env.test as VITE_TEST_SUPABASE_ANON_KEY.';

if (!TEST_SUPABASE_URL || !TEST_SUPABASE_ANON_KEY) {
  throw new Error('Missing .env.test — VITE_TEST_SUPABASE_URL / VITE_TEST_SUPABASE_ANON_KEY.\n' + REFRESH_HINT);
}

// ⚠ PRESENCE IS NOT VALIDITY, AND THE DIFFERENCE COST A DAY.
// This guard used to check only that the two variables existed. On 2026-08-19
// at 08:57 UTC Supabase rotated the project keys — no deploy, no warning — and
// the key in .env.test (issued 2026-07-07) began returning 401. It was still
// PRESENT, so this guard passed, the tests then signed nobody in, and each one
// failed with "permission denied for table human_tasks" from the anon role.
// Four test files went red in a way that reads exactly like a grants bug, and
// the same rotation had already been misdiagnosed that morning against 24 edge
// functions before anyone thought to ask the key whether it still worked.
//
// So: ask it, ONCE, before any test runs, and say what is actually wrong. One
// honest failure beats N misleading ones. Costs a single HEAD request and
// cannot pass on a dead key.
// ⚠ ASK AUTH, NOT POSTGREST — and this correction cost a second day.
// The probe above used to be HEAD /rest/v1/, which conflates two completely
// different failures because PostgREST returns HTTP 401 for a Postgres
// PERMISSION error (SQLSTATE 42501) as readily as for a bad key. Measured
// 2026-08-20, the body behind that 401 was:
//
//   {"code":"42501","message":"permission denied for table tenants",
//    "hint":"GRANT SELECT ON public.tenants TO anon;"}
//
// The key was perfectly valid. What had changed was the anon perimeter — the
// revokes that took `anon` off tables it never needed (mig 787 and the sweep
// around it). So this guard turned a SUCCESSFUL security hardening into
// "your key was rotated", and would have sent someone to rotate keys that
// were fine — the same misdiagnosis, in the opposite direction, as the
// rotation it was written to catch.
//
// Proof it is now the right question: the CURRENT publishable key also
// returned 401 from the old probe, so it could not tell a live key from a
// dead one at all. /auth/v1/settings validates the KEY and nothing else —
// valid 200, garbage 401, truncated 401, all verified against the dev project.
const probe = await fetch(`${TEST_SUPABASE_URL}/auth/v1/settings`, {
  headers: { apikey: TEST_SUPABASE_ANON_KEY, Authorization: `Bearer ${TEST_SUPABASE_ANON_KEY}` },
}).catch(() => ({ status: 0 } as Response));

if (probe.status === 401 || probe.status === 403) {
  let issued = '';
  try {
    const claims = JSON.parse(atob(TEST_SUPABASE_ANON_KEY.split('.')[1] ?? ''));
    if (claims?.iat) {
      issued = ` (the copy in .env.test was issued ${new Date(claims.iat * 1000).toISOString().slice(0, 10)})`;
    }
  } catch { /* the newer sb_publishable_ format is not a JWT and carries no claims */ }
  throw new Error(
    `.env.test's anon key is no longer valid for this project — it returned ${probe.status}${issued}.\n` +
    'Supabase rotates project keys without a deploy, so a stored copy goes stale silently.\n' +
    'Nothing is wrong with the schema or the grants — the tests simply cannot sign in.\n' +
    REFRESH_HINT,
  );
}
