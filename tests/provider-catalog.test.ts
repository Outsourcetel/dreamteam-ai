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
import { PROVIDERS, matchProvider } from '../src/lib/connectorApi';

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

run('a connector can be prepared before it is authenticated', () => {
  it('accepts pending_credentials as a status', async () => {
    const [{ def }] = await runQuery<{ def: string }>(`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.connectors'::regclass and conname = 'connectors_status_check'`);
    expect(def).toContain('pending_credentials');
  });

  it('still rejects a status we never defined', async () => {
    // The pairing rule: widening a CHECK is only safe if it did not become a
    // free-for-all. Assert the fence still exists on the other side.
    const [{ def }] = await runQuery<{ def: string }>(`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.connectors'::regclass and conname = 'connectors_status_check'`);
    expect(def).not.toContain('anything');
    expect(def).toContain('connected');
    expect(def).toContain('disconnected');
    expect(def).toContain('error');
  });
});

describe('matchProvider', () => {
  const catalog = [
    { provider_key: 'xero', label: 'Xero', category: 'erp_financials', aliases: ['xero', 'zero', 'books'] },
    { provider_key: 'hubspot', label: 'HubSpot', category: 'crm', aliases: ['hubspot', 'hub spot'] },
  ];

  it('finds a provider named exactly', () => {
    expect(matchProvider('we use HubSpot', catalog).map((m) => m.provider_key)).toEqual(['hubspot']);
  });

  it('finds a provider named by a synonym', () => {
    expect(matchProvider('we do our books in zero', catalog).map((m) => m.provider_key)).toEqual(['xero']);
  });

  it('finds more than one system in one sentence', () => {
    const keys = matchProvider('HubSpot for sales and Xero for books', catalog).map((m) => m.provider_key);
    expect(keys.sort()).toEqual(['hubspot', 'xero']);
  });

  it('returns nothing rather than guessing', () => {
    // The pairing rule. A matcher that always finds something is worse than
    // none: the interview would silently prepare the wrong connector.
    expect(matchProvider('we mostly use spreadsheets and email', catalog)).toEqual([]);
  });

  it('does not match a word that merely contains an alias', () => {
    expect(matchProvider('our zeroth priority is hiring', catalog)).toEqual([]);
  });
});

run('every category a role needs has something to suggest', () => {
  it('leaves no archetype demanding a system we cannot name', async () => {
    const rows = await runQuery<{ cat: string; keys: string[] }>(`
      select distinct unnest(required_connector_categories) as cat,
             array_agg(distinct key) as keys
        from public.role_archetypes
       where required_connector_categories is not null
       group by 1`);
    const { TOP_PROVIDERS } = await import('../src/lib/connectorApi');
    const orphans = rows
      .filter((r) => !(TOP_PROVIDERS as Record<string, string[] | undefined>)[r.cat]?.length)
      .map((r) => `${r.cat} (needed by ${r.keys.join(', ')})`);
    expect(orphans, `categories with no suggested provider: ${orphans.join(' | ')}`).toEqual([]);
  });
});
