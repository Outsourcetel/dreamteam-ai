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

if (!TEST_SUPABASE_URL || !TEST_SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing .env.test — run `node <scratchpad>/fetch_dev_keys.js .supabase-token .env.test` ' +
    'to populate VITE_TEST_SUPABASE_URL / VITE_TEST_SUPABASE_ANON_KEY against the dev project.'
  );
}
