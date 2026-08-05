// ============================================================
// Read-only catalog access for invariant tests.
//
// The behavioural RLS suite (tenant-isolation.test.ts) signs real users into
// the isolated dev project. These invariant tests are a different, complementary
// thing: they assert on the SHAPE of the live security layer — which policies
// exist, which functions carry which guards, who can execute what — and that
// only exists where the migrations are actually applied.
//
// So this reads the PRODUCTION catalog, and it is strictly read-only:
//   · SELECTs against pg_policy / pg_proc / information_schema only
//   · no writes, no user creation, no tenant data
// runQuery() refuses anything that is not a lone SELECT/WITH, so a future edit
// cannot quietly turn a test file into a migration runner.
//
// Reuses the same Management API path and .env.local token as
// scripts/db-query.mjs, rather than inventing a second credential path.
// ============================================================
import { readFileSync } from 'node:fs';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

let cachedToken: string | null = null;

export function adminTokenAvailable(): boolean {
  try { return !!readAccessToken(); } catch { return false; }
}

function readAccessToken(): string {
  if (cachedToken) return cachedToken;

  // CI has no .env.local — it injects the token as an Actions secret. Env var
  // wins so the same suite runs unchanged locally and in CI.
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (fromEnv) { cachedToken = fromEnv; return cachedToken; }

  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  cachedToken = line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
  return cachedToken;
}

/** Runs ONE read-only statement and returns its rows. */
export async function runQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const trimmed = sql.trim();
  // Guard rail, not decoration: these tests point at production.
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('runQuery is read-only — only SELECT/WITH statements are permitted');
  }
  if (/;\s*\S/.test(trimmed.replace(/;\s*$/, ''))) {
    throw new Error('runQuery accepts a single statement');
  }

  // Retry ONLY transient transport failures — rate limits and 5xx. The suite
  // fans several files out in parallel against one Management API endpoint, and
  // an occasional 429 was failing real assertions for no real reason. A test
  // that goes red at random is a test people learn to ignore, which is worse
  // than not having it.
  //
  // Deliberately narrow: a 4xx that is not 429 is a genuine bad query and must
  // fail immediately and loudly. Never retry on a parsed result — only here,
  // before any row is read, so a retry can never paper over a real disagreement
  // between the database and an assertion.
  const TRANSIENT = new Set([429, 500, 502, 503, 504]);
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt));
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: trimmed }),
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as T[];
    lastErr = `Management API ${res.status}: ${text.slice(0, 300)}`;
    if (!TRANSIENT.has(res.status)) break;
  }
  throw new Error(lastErr);
}

/** Convenience for the very common "one row, one column" assertion. */
export async function scalar<T = unknown>(sql: string): Promise<T> {
  const rows = await runQuery<Record<string, T>>(sql);
  if (rows.length === 0) throw new Error('query returned no rows');
  return Object.values(rows[0])[0];
}
