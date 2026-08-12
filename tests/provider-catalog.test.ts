// ============================================================
// THE PROVIDER CATALOG — public.connector_providers
//
// Until this table existed, the ~75 systems we claim to support lived in a
// TypeScript constant (PROVIDERS in src/lib/connectorApi.ts) hand-synced
// against a 75-value CHECK constraint on connectors.provider. Two lists, one
// truth, no one watching. The discovery interview needs to ask the DATABASE
// "what do we know about Xero", so the list has to exist server-side.
//
// This suite's job is to make sure the copy cannot silently diverge from the
// original. It is read-only: runQuery() refuses anything but a lone SELECT.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';
import { PROVIDERS } from '../src/lib/connectorApi';

const run = adminTokenAvailable() ? describe : describe.skip;

run('connector_providers mirrors PROVIDERS', () => {
  it('has a row for every provider the UI can render', async () => {
    const rows = await runQuery<{ provider_key: string }>(
      'select provider_key from public.connector_providers where active',
    );
    const inDb = new Set(rows.map((r) => r.provider_key));
    const inTs = Object.keys(PROVIDERS);
    const missing = inTs.filter((k) => !inDb.has(k));
    expect(missing, `in PROVIDERS but not in the catalog: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no row the UI cannot render', async () => {
    const rows = await runQuery<{ provider_key: string }>(
      'select provider_key from public.connector_providers where active',
    );
    const inTs = new Set(Object.keys(PROVIDERS));
    const extra = rows.map((r) => r.provider_key).filter((k) => !inTs.has(k));
    expect(extra, `in the catalog but not in PROVIDERS: ${extra.join(', ')}`).toEqual([]);
  });

  it('reports how many providers it compared', async () => {
    // Zero findings from zero comparisons looks exactly like a clean result.
    const [{ n }] = await runQuery<{ n: number }>(
      'select count(*)::int as n from public.connector_providers where active',
    );
    expect(n).toBeGreaterThan(50);
    console.log(`compared ${n} catalog rows against ${Object.keys(PROVIDERS).length} PROVIDERS entries`);
  });
});
