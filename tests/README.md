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

Regenerate with the anon key only (no service-role key needed anywhere
in this suite):

```
node <scratchpad>/fetch_dev_keys.js .supabase-token .env.test
```

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
