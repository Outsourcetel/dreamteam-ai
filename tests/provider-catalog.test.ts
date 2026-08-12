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
import { PROVIDERS, matchProvider, type ProviderCatalogRow } from '../src/lib/connectorApi';

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

// ── The matcher, against the catalog it will ACTUALLY be handed ────────────
// The block above proves the FUNCTION works. It proves nothing about the DATA,
// because it hands matchProvider a two-row fixture invented for the test.
//
// The live catalog is 75 rows, and the seed derives an alias from every
// provider's lowercased label — so Close, Front, Box, monday.com, Linear,
// Square and Epic each contributed a bare ordinary English word, and a curated
// "books" synonym was added to xero by hand. Against those rows the matcher
// read "we close deals on monday and the team meets in front of the box" as
// FOUR systems, every one at confidence 'exact' — the label a consumer would
// most trust for automatic action. The function's own docstring promises the
// opposite ("a false positive is worse than a miss"), so the data was breaking
// the promise the code makes.
//
// This block therefore runs the matcher over the REAL rows. It needs the
// database, hence the `run` gate: a skipped suite is not a passing one.
run('matchProvider against the catalog it is actually handed', () => {
  const catalog = () => runQuery<ProviderCatalogRow>(
    `select provider_key, label, category, aliases
       from public.connector_providers where active`,
  );

  // Ordinary business prose. Every word below is doing its ordinary English
  // job; not one of these sentences names a system we sell a connector for.
  // The last one is deliberately sentence-cased — a capital that is there for
  // grammar, not because the writer meant the CRM.
  const PROSE = [
    'we close deals on monday and the team meets in front of the box',
    'we run a square meal service, epic turnout, linear growth',
    'our books are a mess',
    'there is some slack in the schedule and we have zero appetite for risk',
    'she ran the escalation with real gusto and is now our in-house guru',
    'a confluence of factors: market dynamics, a blank canvas, no obvious lever to pull',
    'we had a notion the intercom in reception was broken',
    'greenhouse gas reporting still runs off a spreadsheet template',
    'add a stripe of colour to the toast at the launch party',
    'Close of business is five. Front desk cover starts at eight.',
  ];

  // The pairing rule, and it is the whole point: a matcher that returned []
  // for everything would sail through the test above. These must still resolve
  // — including "we use Close", where the ordinary word IS the product name.
  const NAMED: Array<readonly [string, string[]]> = [
    ['we use Zendesk for tickets and HubSpot for the pipeline', ['hubspot', 'zendesk']],
    ['everything runs through xero and quickbooks online', ['quickbooks', 'xero']],
    ['sfdc is our system of record', ['salesforce']],
    ['we run monday.com for projects', ['monday']],
    ['our chat is Slack', ['slack']],
    ['we use Close', ['close']],
  ];

  it('finds nothing in ordinary business prose', async () => {
    const rows = await catalog();
    const wrong = PROSE
      .map((s) => [s, matchProvider(s, rows)] as const)
      .filter(([, m]) => m.length > 0)
      .map(([s, m]) => `"${s}" -> ${m.map((x) => `${x.provider_key}(${x.confidence})`).join(', ')}`);
    expect(wrong, `false positives against the LIVE catalog:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('still resolves a system a customer actually names', async () => {
    const rows = await catalog();
    const missed = NAMED
      .map(([s, want]) => [s, want, matchProvider(s, rows).map((m) => m.provider_key).sort()] as const)
      .filter(([, want, got]) => JSON.stringify(got) !== JSON.stringify([...want].sort()))
      .map(([s, want, got]) => `"${s}" -> got [${got.join(', ')}], wanted [${want.join(', ')}]`);
    expect(missed, `the matcher stopped recognising real systems:\n  ${missed.join('\n  ')}`).toEqual([]);
  });

  it('still calls an exact product name exact', async () => {
    // 'exact' is the confidence a consumer would act on automatically. If the
    // fix for the false positives quietly demoted every match instead, that
    // would look like a pass above and be a different bug.
    const rows = await catalog();
    expect(matchProvider('we use Close', rows)[0]?.confidence).toBe('exact');
    expect(matchProvider('we use Zendesk', rows)[0]?.confidence).toBe('exact');
  });

  it('reports how much it compared', async () => {
    // Zero findings from zero comparisons looks exactly like a clean result.
    const rows = await catalog();
    const aliases = rows.reduce((n, r) => n + (r.aliases?.length ?? 0), 0);
    expect(rows.length).toBeGreaterThan(50);
    expect(aliases).toBeGreaterThan(50);
    console.log(
      `matched ${PROSE.length} prose phrases and ${NAMED.length} named-system phrases `
      + `against ${rows.length} live catalog rows / ${aliases} aliases`,
    );
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
