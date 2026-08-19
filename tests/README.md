# Automated tests

Real, end-to-end tests against the isolated dev/schema-clone Supabase
project (`nmuntxrcdksyhsdywpan`) — never production. No mocking: tests
sign up real users through the actual public signup flow and assert
on real RLS/database behavior.

## Running

```
npm test          # run once
npm run test:watch
```

Requires `.env.test` (gitignored, not committed) with:

```
VITE_TEST_SUPABASE_URL=https://nmuntxrcdksyhsdywpan.supabase.co
VITE_TEST_SUPABASE_ANON_KEY=<dev project anon key>
```

The anon key only — no service-role key is needed anywhere in this suite.

```
npx supabase projects api-keys --project-ref nmuntxrcdksyhsdywpan
```

> **This goes stale on its own.** Supabase rotates project keys with no deploy
> and no warning — it happened on 2026-08-19 at 08:57 UTC, and the copy here
> (issued 2026-07-07) started returning 401. Nothing in the repo changed, so the
> tests looked like a grants regression: they signed nobody in, ran as `anon`,
> and every insert failed with `permission denied for table human_tasks`. Four
> files went red and the same rotation had already been misdiagnosed once that
> morning against 24 edge functions.
>
> `tests/setup.ts` now asks the key whether it still works before any test runs,
> so this surfaces as one honest sentence naming the key and its issue date
> rather than N confusing permission errors. If you see that message, refresh
> the key with the command above; the schema is fine.

> The previous version of this section pointed at
> `node <scratchpad>/fetch_dev_keys.js` — a file in a per-session scratchpad that
> no longer exists, so the documented recovery path was itself broken.

## Design

- **No mocks.** `tests/helpers/testTenant.ts` creates a brand-new real
  tenant per test, through `auth.signUp()` + the real `complete_signup`
  RPC — the same path a real customer's signup goes through, not a
  synthetic shortcut.
- **Real sessions, not the JWT-simulation-as-superuser trick.** Earlier
  work in this project found that simulating a JWT via
  `set_config('request.jwt.claims', ...)` on the Management API's SQL
  connection runs as the `postgres` superuser (`rolbypassrls = true`)
  and proves nothing about RLS. These tests use an actual signed-in
  `SupabaseClient` per test user instead — the real enforcement path.
- **Dev project only.** `mailer_autoconfirm` is enabled on this dev
  project only (never production) so signup doesn't need a real inbox.

## Known dev-project gaps found and fixed while building this suite

The dev project was cloned from production once (2026-07-07/08) via
schema introspection, not migration replay. Building this suite
surfaced two gaps in that clone, now fixed on dev:

1. **`on_auth_user_created` trigger on `auth.users` was missing entirely**
   (a trigger on Supabase's own `auth` schema, outside the clone's
   public-schema sweep) — signup silently never created a `profiles`
   row. Re-added: `CREATE TRIGGER on_auth_user_created AFTER INSERT ON
   auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();`
2. **Table-level GRANTs to `anon`/`authenticated`/`service_role` were
   never copied at all** — RLS policies existed but the underlying
   role grants didn't, so every table was unreachable regardless of
   policy. Regenerated from production's `information_schema.role_table_grants`
   and replicated onto every table that exists on dev (277 statements).

**Still open — dev project schema is stale relative to production**
for anything from migration 071 onward (~19 tables missing: Knowledge
Gap Detection, Agentic Step, Platform Capability Grants, Security &
Access tenant tables, Learned Behavior Detection, and a few others).
Any test that needs one of those tables will need it added to dev
first — same schema-introspection clone process documented in
[[project_staging_environment]], scoped to just the missing objects
rather than a full re-clone.

## Cleanup

Test tenants can't be hard-deleted (their `audit_events` rows are
deliberately immutable — a real security property, not worked around
here). Instead, orphan them the same way this project already tracks
test debris in production: delete the throwaway auth identity, rename
the leftover tenant with a `[TEST SUITE DEBRIS - safe to ignore]`
prefix.

```sql
-- run against the DEV project only
update tenants set name = '[TEST SUITE DEBRIS - safe to ignore] ' || name where id in (
  select p.tenant_id from profiles p
  join auth.users u on u.id = p.user_id
  where u.email like 'test-suite-%@dreamteam-ai-tests.invalid'
);
delete from auth.users where email like 'test-suite-%@dreamteam-ai-tests.invalid';
```

## What's covered so far

- `tenant-isolation.test.ts` — cross-tenant RLS enforcement on
  `customer_accounts` (read, list, and update all correctly blocked
  across tenants), via two real signed-up tenant owners.

This is a foundation, not full coverage. Natural next additions:
self-lockout guards (platform team management, guardrail approval),
AI budget enforcement, and the Self-Learning/Knowledge Gap clustering
pipelines — each would need its underlying tables added to dev first
per the gap above.

## Two kinds of test, both needed

**`tenant-isolation.test.ts` — behavioural.** Signs real users into the isolated
dev project and asserts a signed-in user gets the right rows. Requires
`.env.test`.

**`knowledge-acl-invariants.test.ts` — invariant.** Asserts on the *shape* of the
live security layer: which policies exist, which functions carry which guards,
who holds EXECUTE. Read-only catalog queries via the Management API (see
`helpers/adminQuery.ts`), using the `SUPABASE_ACCESS_TOKEN` in `.env.local` —
the same token `scripts/db-query.mjs` uses. `runQuery()` refuses anything that
isn't a lone SELECT/WITH, so a test file cannot become a migration runner.

Why both: in-migration `DO $assert$` blocks proved each fix at apply time, but
they run **once**. Nothing stopped a later migration from undoing them. Every
assertion in the invariant suite corresponds to a defect that was actually
shipped and then found — the recurring one being *an RPC gate is worthless if
the underlying table is client-writable*, which appeared four separate times.

The invariant suite found a real hole on its first run: 36 knowledge functions
were executable by `anon`, four of them SECURITY DEFINER writers. Fixed in
migration 361.

### Known gap

The behavioural suite cannot yet cover the knowledge ACL: the dev project is a
schema clone and is missing `knowledge_collections` (mig 284) and everything
from 294 onward, including the entire ACL surface. Behavioural ACL tests need
that project resynced first.
