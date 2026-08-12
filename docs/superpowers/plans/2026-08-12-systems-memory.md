# Systems Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the hand-maintained TypeScript provider list into a real catalog the discovery interview can query, so a customer naming a system in plain English gets a connector prepared for them up to — but never including — their credentials.

**Architecture:** A new `connector_providers` table seeded from the existing `PROVIDERS` constant, plus `aliases` so free text resolves to a provider. The React UI keeps rendering from `PROVIDERS`; a test asserts the two never drift in either direction. A new `pending_credentials` connector state gives the interview somewhere to land a prepared-but-unauthenticated connector.

**Tech Stack:** Postgres (Supabase), TypeScript, Vitest, vite.

**Spec:** `docs/superpowers/specs/2026-08-12-discovery-interview-design.md` §6. This plan covers §11 step 1 only.

## Global Constraints

- **Never pick a migration number.** Claim it only with `npm run migrate:next -- <slug>` from the repo root. `ls | tail -1` is wrong — "taken" is the union of local files, `origin/main` and the production ledger, which routinely disagree.
- **Commit the migration before applying it.** `scripts/db-query.mjs` refuses an untracked migration file. Apply with `node scripts/db-query.mjs supabase/migrations/<file>.sql`.
- **Every function gets `revoke execute … from public, anon, authenticated`, an explicit grant, and `has_function_privilege` asserted in BOTH directions** (migrations 610/630/722 doctrine). `create or replace` preserves grants, so a REVOKE is a request, not a description of where you ended up.
- **Every migration ends with a `do $$ … $$` block that raises** if the change did not take effect. A check that cannot fail is worthless.
- **⚠ The Workspace Assistant and its chatbot are untouched.** Nothing in this plan may write to a `digital_employees` row with `is_workforce_assistant = true`.
- **Tests run read-only against production** via `tests/helpers/adminQuery.ts` — `runQuery()` refuses anything that is not a lone SELECT/WITH. Never write from a test.
- **The pairing rule.** Every check is proved by the pair — it fires AND it does not fire. A one-sided assertion passes against a control that is broken in the permissive direction.
- Migration prose headers match the house voice: read `supabase/migrations/721_*.sql` and `723_*.sql` first.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/<n>_a_catalog_of_systems_we_know.sql` (create) | `connector_providers` table, seed, grants, assertions |
| `supabase/migrations/<n>_a_connector_can_wait_for_credentials.sql` (create) | widen `connectors.status` CHECK |
| `scripts/gen-provider-seed.mjs` (create) | one-off generator: `PROVIDERS` → seed SQL, so 75 rows are never hand-typed |
| `src/lib/connectorApi.ts` (modify) | add `ADS_SOCIAL_ANALYTICS` entries to `TOP_PROVIDERS`; export `matchProvider()` |
| `tests/provider-catalog.test.ts` (create) | drift check, alias matching, category coverage, pairing |

---

## Task 1: The catalog table, seeded from what already exists

**Files:**
- Create: `scripts/gen-provider-seed.mjs`
- Create: `supabase/migrations/<claimed>_a_catalog_of_systems_we_know.sql`
- Test: `tests/provider-catalog.test.ts`

**Interfaces:**
- Consumes: `PROVIDERS` and `ConnectorProvider` from `src/lib/connectorApi.ts` (existing).
- Produces: table `public.connector_providers(provider_key text PK, label text, category text, aliases text[], auth_kind text, credential_hint text, default_base_url text, implemented boolean, active boolean, created_at timestamptz)`.

**Two deliberate departures from spec §6, both YAGNI:**
- The spec lists `credential_hint` *and* `credential_where`. One field is enough — `PROVIDERS[x].help` already contains both the what and the where ("In Zendesk: Admin Center → Apps and integrations → …"), so splitting it would mean re-authoring 75 strings to gain nothing.
- `exposed_objects` and `unlocks_action_categories` are **not created here.** Nothing in this plan populates them, and this repo has been bitten repeatedly by a stored marker treated as truth — an always-empty column reads as "we know this" when we do not. They belong to the plan that adds post-credential object discovery, which creates and fills them together.

- [ ] **Step 1: Write the failing drift test**

Create `tests/provider-catalog.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run tests/provider-catalog.test.ts`
Expected: FAIL with a Postgres error mentioning `relation "public.connector_providers" does not exist`. If it fails because `adminTokenAvailable()` is false, stop — fix credentials first, because a skipped suite is not a passing one.

- [ ] **Step 3: Write the seed generator**

Create `scripts/gen-provider-seed.mjs`. Hand-typing 75 rows guarantees a typo; generate them from the constant that is already the source of truth.

```javascript
// Prints the VALUES body for the connector_providers seed, read from the
// TypeScript constant so the two cannot disagree at authoring time.
// Usage: node scripts/gen-provider-seed.mjs
import { PROVIDERS } from '../src/lib/connectorApi.ts';

const q = (s) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const arr = (a) => (a.length ? `array[${a.map(q).join(',')}]` : `'{}'::text[]`);

const rows = Object.entries(PROVIDERS).map(([key, m]) => {
  // Aliases: the key, the label, and the label without punctuation. Curated
  // synonyms are added by hand in the migration below, not generated.
  const aliases = [...new Set([key, m.label.toLowerCase(), m.label.toLowerCase().replace(/[^a-z0-9]/g, '')])];
  const authKind = m.oauth ? 'oauth' : m.fields?.some((f) => f.secret) ? 'api_key' : 'basic';
  return `  (${q(key)}, ${q(m.label)}, ${q(m.defaultCategory)}, ${arr(aliases)}, ${q(authKind)}, ` +
         `${q(m.help)}, ${q(m.baseUrlPlaceholder ?? null)}, ${m.implemented ? 'true' : 'false'})`;
});
console.log(rows.join(',\n'));
```

Run it and keep the output: `node scripts/gen-provider-seed.mjs > /tmp/seed.sql`
(If the `.ts` import fails under plain node, run it with `npx tsx scripts/gen-provider-seed.mjs`.)

- [ ] **Step 4: Claim the migration number**

Run: `npm run migrate:next -- a_catalog_of_systems_we_know`
Expected: prints `supabase/migrations/<n>_a_catalog_of_systems_we_know.sql`. Use exactly that path. Do not choose a number yourself.

- [ ] **Step 5: Write the migration**

Paste the generated rows into the `values` block. Header in the house voice:

```sql
-- <n> — a catalog of the systems we know
--
-- The ~75 systems we claim to support have lived in a TypeScript constant
-- (PROVIDERS, src/lib/connectorApi.ts) hand-synced against a CHECK constraint
-- on connectors.provider. Two lists, one truth, nobody watching — and the
-- consequence is visible: TOP_PROVIDERS has no entry at all for ads, social or
-- web analytics, so 4 of 15 role archetypes demand a system category the
-- product cannot suggest anything for.
--
-- The discovery interview needs to ask the DATABASE "what do we know about
-- Xero", so the list has to exist server-side. This is a port, not a rewrite:
-- label, category, credential help and OAuth-ness all come straight from the
-- constant. The one genuinely new field is `aliases`, which is what lets free
-- text resolve to a provider.
--
-- The React UI deliberately keeps rendering from PROVIDERS. A test asserts the
-- two agree in both directions, which closes the drift risk without a risky
-- rewrite of the connector screens.

begin;

create table if not exists public.connector_providers (
  provider_key              text primary key,
  label                     text not null,
  category                  text not null,
  aliases                   text[] not null default '{}',
  auth_kind                 text not null check (auth_kind in ('oauth','api_key','basic')),
  credential_hint           text,
  default_base_url          text,
  implemented               boolean not null default false,
  active                    boolean not null default true,
  created_at                timestamptz not null default now()
);

alter table public.connector_providers enable row level security;

-- Readable by any signed-in user (it is a product catalog, not tenant data);
-- writable by nobody through PostgREST — it changes by migration only.
drop policy if exists connector_providers_read on public.connector_providers;
create policy connector_providers_read on public.connector_providers
  for select to authenticated using (true);

revoke all on public.connector_providers from public, anon;
revoke insert, update, delete on public.connector_providers from authenticated;
grant select on public.connector_providers to authenticated, service_role;
grant insert, update, delete on public.connector_providers to service_role;

insert into public.connector_providers
  (provider_key, label, category, aliases, auth_kind, credential_hint, default_base_url, implemented)
values
-- >>> paste the generated rows here <<<
on conflict (provider_key) do update set
  label = excluded.label,
  category = excluded.category,
  aliases = excluded.aliases,
  auth_kind = excluded.auth_kind,
  credential_hint = excluded.credential_hint,
  default_base_url = excluded.default_base_url,
  implemented = excluded.implemented;

-- Curated synonyms the generator cannot infer. These are what make free text
-- resolve: a customer says "we do our books in zero", not "xero".
update public.connector_providers set aliases = aliases || array['zero','books','accounting software']
  where provider_key = 'xero';
update public.connector_providers set aliases = aliases || array['qb','quickbooks online','qbo']
  where provider_key = 'quickbooks';
update public.connector_providers set aliases = aliases || array['sfdc','sales force']
  where provider_key = 'salesforce';
update public.connector_providers set aliases = aliases || array['hub spot']
  where provider_key = 'hubspot';
update public.connector_providers set aliases = aliases || array['zen desk']
  where provider_key = 'zendesk';

do $$
declare v_n int; v_dupe int;
begin
  select count(*) into v_n from public.connector_providers where active;
  if v_n < 50 then
    raise exception '<n>: expected the full provider catalog, only % rows landed', v_n;
  end if;

  -- An alias that matches two providers makes the matcher ambiguous and is a
  -- seeding bug, not a runtime one. Catch it here.
  select count(*) into v_dupe from (
    select unnest(aliases) as a from public.connector_providers where active
  ) x group by a having count(*) > 1 limit 1;
  if coalesce(v_dupe, 0) > 0 then
    raise exception '<n>: an alias resolves to more than one provider';
  end if;

  if has_table_privilege('authenticated', 'public.connector_providers', 'delete') then
    raise exception '<n>: authenticated must not be able to delete from the catalog';
  end if;
  if not has_table_privilege('authenticated', 'public.connector_providers', 'select') then
    raise exception '<n>: authenticated must be able to read the catalog';
  end if;
end $$;

commit;
```

- [ ] **Step 6: Commit, then apply**

```bash
git add scripts/gen-provider-seed.mjs supabase/migrations/*_a_catalog_of_systems_we_know.sql tests/provider-catalog.test.ts
git commit -m "feat(connectors): a catalog of the systems we know"
node scripts/db-query.mjs supabase/migrations/<n>_a_catalog_of_systems_we_know.sql
```

Expected: `ledger: <n>_a_catalog_of_systems_we_know.sql recorded`.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `npx vitest run tests/provider-catalog.test.ts`
Expected: 3 passing, and the console line reporting how many rows were compared. If the counts differ, the seed is incomplete — fix the seed, not the test.

---

## Task 2: A connector can wait for credentials

**Files:**
- Create: `supabase/migrations/<claimed>_a_connector_can_wait_for_credentials.sql`
- Test: `tests/provider-catalog.test.ts` (append)

**Interfaces:**
- Consumes: `public.connectors` (existing).
- Produces: `connectors.status` accepts `'pending_credentials'` in addition to `connected | error | disconnected`.

- [ ] **Step 1: Write the failing test**

Append to `tests/provider-catalog.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/provider-catalog.test.ts -t "accepts pending_credentials"`
Expected: FAIL — the constraint currently reads `ARRAY['connected','error','disconnected']`.

- [ ] **Step 3: Claim the number and write the migration**

Run: `npm run migrate:next -- a_connector_can_wait_for_credentials`

```sql
-- <n> — a connector can wait for credentials
--
-- connectors.status knew three things: connected, error, disconnected. There
-- was no word for "we have prepared this for you and are waiting on you",
-- which is exactly the state the discovery interview leaves a system in: row
-- created, named, categorised, base URL set, employee access bound — and no
-- credentials, because those are the customer's to enter and nobody else's.
--
-- Widening only. No existing row changes meaning; the three original values
-- keep their exact semantics.

begin;

alter table public.connectors drop constraint if exists connectors_status_check;
alter table public.connectors add constraint connectors_status_check
  check (status in ('connected', 'error', 'disconnected', 'pending_credentials'));

do $$
declare v_bad int; v_tenant uuid;
begin
  -- Widening must not have stranded an existing row.
  select count(*) into v_bad from public.connectors
   where status not in ('connected','error','disconnected','pending_credentials');
  if v_bad > 0 then raise exception '<n>: % connector rows hold a status the new CHECK rejects', v_bad; end if;

  -- And it must not have become permissive. Prove the fence by trying to cross
  -- it — with a REAL tenant_id, so that the CHECK is what refuses us.
  --
  -- ⚠ An earlier draft used a zero UUID and caught foreign_key_violation as
  -- "also fine". That is a check that cannot fail: the FK refuses the row
  -- before the CHECK is ever the reason, so the probe reports success whether
  -- or not the CHECK exists. Use a tenant that exists; catch ONLY
  -- check_violation. The insert never commits — either the CHECK rejects it,
  -- or we raise and the whole migration rolls back.
  select id into v_tenant from public.tenants limit 1;
  if v_tenant is null then
    raise exception '<n>: no tenant to probe with — cannot prove the CHECK holds';
  end if;

  begin
    insert into public.connectors (tenant_id, provider, display_name, status, category)
    values (v_tenant, 'mcp', 'CHECK probe — never commits', 'not_a_real_status', 'other');
    raise exception '<n>: the status CHECK accepted a value it should refuse';
  exception
    when check_violation then null;   -- the only acceptable outcome
  end;
end $$;

commit;
```

- [ ] **Step 4: Commit, apply, verify**

```bash
git add supabase/migrations/*_a_connector_can_wait_for_credentials.sql tests/provider-catalog.test.ts
git commit -m "feat(connectors): a connector can wait for credentials"
node scripts/db-query.mjs supabase/migrations/<n>_a_connector_can_wait_for_credentials.sql
npx vitest run tests/provider-catalog.test.ts
```

Expected: 5 passing.

---

## Task 3: Resolve plain English to a provider

**Files:**
- Modify: `src/lib/connectorApi.ts` (append export)
- Test: `tests/provider-catalog.test.ts` (append)

**Interfaces:**
- Produces: `export function matchProvider(text: string, catalog: ProviderCatalogRow[]): ProviderMatch[]` where
  `type ProviderCatalogRow = { provider_key: string; label: string; category: string; aliases: string[] }` and
  `type ProviderMatch = { provider_key: string; matched_on: string; confidence: 'exact' | 'alias' | 'partial' }`.
  The discovery interview (Plan 3) calls this with a customer's sentence.

- [ ] **Step 1: Write the failing test**

```typescript
import { matchProvider } from '../src/lib/connectorApi';

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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/provider-catalog.test.ts -t matchProvider`
Expected: FAIL with `matchProvider is not a function` / import error.

- [ ] **Step 3: Implement**

Append to `src/lib/connectorApi.ts`:

```typescript
export type ProviderCatalogRow = {
  provider_key: string; label: string; category: string; aliases: string[];
};
export type ProviderMatch = {
  provider_key: string; matched_on: string; confidence: 'exact' | 'alias' | 'partial';
};

/** Resolve free text ("we do our books in zero") to known providers.
 *
 *  Deliberately conservative: it matches on WORD BOUNDARIES only, and returns
 *  an empty array rather than a best guess. The discovery interview acts on
 *  what this returns — preparing a connector row and binding an employee's
 *  access to it — so a false positive is worse than a miss. A miss just means
 *  we ask one more question. */
export function matchProvider(text: string, catalog: ProviderCatalogRow[]): ProviderMatch[] {
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const hits = new Map<string, ProviderMatch>();

  for (const row of catalog) {
    for (const alias of row.aliases) {
      const needle = ` ${alias.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
      if (needle.trim() === '') continue;
      if (!haystack.includes(needle)) continue;
      const confidence: ProviderMatch['confidence'] =
        alias.toLowerCase() === row.label.toLowerCase() ? 'exact'
        : alias === row.provider_key ? 'exact' : 'alias';
      const existing = hits.get(row.provider_key);
      if (!existing || (existing.confidence !== 'exact' && confidence === 'exact')) {
        hits.set(row.provider_key, { provider_key: row.provider_key, matched_on: alias, confidence });
      }
    }
  }
  return [...hits.values()];
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run tests/provider-catalog.test.ts -t matchProvider`
Expected: 5 passing. The word-boundary test is the one that matters — if `zeroth` matches `zero`, the padding logic is wrong.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/connectorApi.ts tests/provider-catalog.test.ts
git commit -m "feat(connectors): resolve plain English to a known provider"
```

Expected: typecheck exit 0.

---

## Task 4: Close the ads, social and web-analytics gap

**Files:**
- Modify: `src/lib/connectorApi.ts:1201` (`TOP_PROVIDERS`)
- Test: `tests/provider-catalog.test.ts` (append)

**Interfaces:**
- Consumes: `role_archetypes.required_connector_categories` (existing), `TOP_PROVIDERS` (existing).
- Produces: no new exports. `TOP_PROVIDERS` gains entries so that every category any archetype requires has at least one suggestion.

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run it and confirm it fails, and read WHICH categories**

Run: `npx vitest run tests/provider-catalog.test.ts -t "no archetype demanding"`
Expected: FAIL listing the orphan categories with the archetypes that need them. Note them — the failure message is the specification for step 3.

- [ ] **Step 3: Add the entries**

In `src/lib/connectorApi.ts`, extend `TOP_PROVIDERS` with an entry for each orphan the test named. Only list providers that exist in `PROVIDERS`; if a category genuinely has no implemented adapter, the honest fix is to add `mcp` and `generic_rest` (the escape hatches already used for `product_system` and `other`) rather than to name a product we cannot connect:

```typescript
  ads: ['mcp', 'generic_rest'],
  social: ['mcp', 'generic_rest'],
  web_analytics: ['mcp', 'generic_rest'],
```

Adjust the exact keys to whatever the step-2 failure listed. Keep the existing comment style — the block already explains that a rail is short where the adapter is not built, and that principle still holds.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run tests/provider-catalog.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/connectorApi.ts tests/provider-catalog.test.ts
git commit -m "fix(connectors): every category a role needs has something to suggest"
```

---

## Task 5: Wire it into certify, and prove the checks can fail

**Files:**
- Modify: `scripts/certify.mjs`
- Test: manual mutation run

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: a `provider-catalog` section in `npm run certify` output.

- [ ] **Step 1: Read how an existing certify section is written**

Run: `grep -n "section(" scripts/certify.mjs | head -20`
Read two neighbouring sections in full before writing one. Match their shape exactly — do not invent a new reporting style.

- [ ] **Step 2: Add the section**

`scripts/certify.mjs` already has `async function q(sql)` at line 90 and `section(name, fn)` at 627; a section returns `{ ok, detail }`. Add this to the `sections` array, next to `migration-numbering`:

```javascript
  // ── The provider catalog cannot silently drift ─────────────────────────
  // The systems we claim to support lived in a TypeScript constant hand-synced
  // against a CHECK constraint — two lists, one truth, nobody watching. The
  // discovery interview reads the DB copy, so a drift means we prepare the
  // wrong connector, or fail to recognise a system the customer named.
  section('provider-catalog', async () => {
    const failures = [];
    const { PROVIDERS, TOP_PROVIDERS } = await import('../src/lib/connectorApi.ts');

    const rows = await q(`select provider_key, aliases from public.connector_providers where active`);
    const inDb = new Set(rows.map((r) => r.provider_key));
    const inTs = Object.keys(PROVIDERS);

    // BOTH directions. Asserting only one half passes a catalog that is empty.
    for (const k of inTs) if (!inDb.has(k)) failures.push(`catalog missing provider: ${k}`);
    for (const k of inDb) if (!inTs.includes(k)) failures.push(`catalog has unknown provider: ${k}`);

    const seen = new Map();
    for (const r of rows) {
      for (const a of r.aliases ?? []) {
        if (seen.has(a)) failures.push(`alias "${a}" resolves to both ${seen.get(a)} and ${r.provider_key}`);
        else seen.set(a, r.provider_key);
      }
    }

    const cats = await q(`select distinct unnest(required_connector_categories) as cat
                            from public.role_archetypes
                           where required_connector_categories is not null`);
    for (const { cat } of cats) {
      if (!TOP_PROVIDERS[cat]?.length) failures.push(`no provider suggested for category: ${cat}`);
    }

    const [priv] = await q(`select has_table_privilege('authenticated','public.connector_providers','select') as can_read,
                                   has_table_privilege('authenticated','public.connector_providers','delete') as can_delete`);
    if (!priv.can_read) failures.push('authenticated cannot read the catalog');
    if (priv.can_delete) failures.push('authenticated can DELETE from the catalog');

    // Count the comparisons, not just the findings. Zero findings from zero
    // comparisons looks exactly like a clean result.
    const detail = failures.length
      ? failures.join('\n')
      : `compared ${inTs.length} providers, ${seen.size} aliases, ${cats.length} required categories`;
    if (!failures.length) console.log(`        provider-catalog: ${detail}`);
    return { ok: failures.length === 0, detail };
  }),
```

Note the privilege assertion is **structural** — it reads the grant rather than attempting a DELETE, because certify runs against production and a real delete probe is not safe there. Say so in the comment rather than implying it was proven behaviourally.

- [ ] **Step 3: Run certify and confirm the section is green**

Run: `npm run certify:fast`
Expected: the new section appears and passes. If `certify:fast` does not include it, add it to the fast ring the same way its neighbours are registered.

- [ ] **Step 4: Mutation-test each assertion — the step that makes this real**

For each of the four assertions, break it deliberately and confirm certify goes red, then restore:

```bash
# 1. drift: deactivate one catalog row
node scripts/db-query.mjs --sql "update public.connector_providers set active=false where provider_key='xero';"
npm run certify:fast   # EXPECT: provider-catalog RED
node scripts/db-query.mjs --sql "update public.connector_providers set active=true where provider_key='xero';"

# 2. ambiguity: give two providers the same alias
node scripts/db-query.mjs --sql "update public.connector_providers set aliases = aliases || array['dupe_probe'] where provider_key in ('xero','quickbooks');"
npm run certify:fast   # EXPECT: provider-catalog RED
node scripts/db-query.mjs --sql "update public.connector_providers set aliases = array_remove(aliases,'dupe_probe') where provider_key in ('xero','quickbooks');"
```

For assertion 3, temporarily comment out one `TOP_PROVIDERS` entry, run, restore. For assertion 4, no safe mutation exists against production — assert it structurally and say so in the section's own comment rather than pretending it was proven.

**A check that has never failed is not a check.** If any assertion stays green while broken, it is wrong — fix the assertion, not the probe.

- [ ] **Step 5: Confirm the database is back to its starting state**

```bash
node scripts/db-query.mjs --sql "select count(*) filter (where not active) as inactive, count(*) filter (where 'dupe_probe' = any(aliases)) as dupes from public.connector_providers;"
```
Expected: `inactive: 0, dupes: 0`. Do not skip this — the mutation steps wrote to production.

- [ ] **Step 6: Commit**

```bash
git add scripts/certify.mjs
git commit -m "test(certify): the provider catalog cannot silently drift"
```

---

## Done when

- `npm run typecheck` exit 0, `npm test` no new failures, `npm run certify:fast` green with the new section.
- Every one of the four certify assertions has been seen to go red when broken, and the database is verified back to its starting state.
- `matchProvider('we mostly use spreadsheets and email', …)` returns `[]` — the matcher declines to guess.
- No `digital_employees` row with `is_workforce_assistant = true` was read or written by anything in this plan.
