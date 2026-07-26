# Disaster recovery

**Status as of 2026-07-26: the production database has no automated backups.**

This is not "backups we have never tested". It is none. Verified directly
against the Supabase Management API:

```
GET /v1/organizations/thutpyhdsvogkouvlxxj   ->  "plan": "free"
GET /v1/projects/rfsvmhcqeiyrxivbmpel/database/backups
                                             ->  "pitr_enabled": false
                                             ->  "backups": []
```

What is at stake: 16 tenants, ~19 user accounts, ~2,000 knowledge documents,
136 MB. If the project is deleted, corrupted by a bad migration, or paused and
lost, there is currently no supported way to get any of it back.

Two further consequences of the free plan that are easy to miss:

- **Free projects pause after 7 days of inactivity.** For a product with live
  tenants that is an outage, not a cost saving.
- The free tier caps the database at 500 MB. At 136 MB there is headroom, but
  the knowledge corpus and embeddings are the fastest-growing part.

---

## The one thing only the founder can do

Upgrading the org to Pro (~$25/mo) turns on **daily backups with 7-day
retention**. Adding **PITR** (~$100/mo on top) allows restoring to any second
within the retention window, which is what actually protects against
"a migration corrupted a table at 14:32".

This is a purchase, so it is deliberately not automated here. Everything below
works without it, and none of it is as good as having real backups.

---

## What exists today, and what each piece actually covers

| Artifact | Command | Covers | Does NOT cover |
|---|---|---|---|
| `supabase/baseline/full_schema.sql` | `npm run backup:schema` | Every table, view, sequence, function, trigger, index, RLS policy, and the closed EXECUTE grants | Any data at all |
| `backups/<timestamp>/*.jsonl` | `npm run backup:data` | Every row of every public table | `auth.users`, storage objects, vault secrets, cron schedules |
| Restore drill | `npm run restore:drill` | Proof the schema file rebuilds production exactly | Proof the data restores |
| `public.schema_migrations` | `npm run migrate:status` | Which migrations are applied, and whether a file changed after being applied | — |

**Neither file is a complete disaster-recovery artifact on its own, and
together they are still not one.** `auth.users` is the important gap: restoring
schema and data gives you every tenant's records with nobody able to log in.
Recreating accounts means re-inviting users, and any row keyed by a user's UUID
would need remapping.

---

## Restoring from nothing

1. Create a new Supabase project. **Enable Pro + PITR on it immediately** so
   you are not rebuilding this same hole.
2. Apply the schema:
   ```bash
   node scripts/db-query.mjs supabase/baseline/full_schema.sql
   ```
   It is ordered to work on an empty database: extensions → enums → functions
   that nothing depends on → sequences → tables → foreign keys → indexes →
   remaining functions → views → triggers → RLS → policies → grants.
3. Load the data from the newest `backups/<timestamp>/` directory, oldest
   dependency first. `_manifest.json` lists every table and its row count.
4. Recreate user accounts and re-invite them. There is no automated path.
5. Redeploy the edge functions (`node scripts/deploy.mjs --no-migrations --fn <name>`)
   and re-seed vault secrets — connector credentials are encrypted at rest and
   are deliberately not in the export.
6. Recreate the pg_cron schedules.
7. Run `npm run migrate:status` and confirm the ledger matches the repo.

---

## Why the drill matters more than the file

`npm run restore:drill` regenerates the dump, rebuilds it into a throwaway
schema on the dev project, compares it to production object-for-object, and
drops it. Current result:

```
tables 257 · views 4 · functions 613 · triggers 254
policies 332 · rls_enabled 257 · columns 2915      — all OK
```

The first time it ran it found **six defects that were invisible by reading the
file**, which is the entire argument for having it:

1. CHECK constraints call functions (`connectors` has
   `CHECK (is_safe_external_url(base_url))`), so functions must be created
   **before** tables.
2. …but functions declared `RETURNS SETOF <table>` must be created **after**
   them. One ordering cannot satisfy both, so the dump makes two function
   passes.
3. Extension-owned `LANGUAGE c` functions (pgvector, pg_net, pg_cron) cannot be
   recreated by a non-superuser and must be excluded — they come back with
   `CREATE EXTENSION`.
4. Policy names containing spaces were emitted unquoted.
5. `GENERATED ALWAYS AS (…) STORED` columns were emitted as `DEFAULT`, which
   Postgres rejects because the expression references a sibling column.
6. Sequences behind legacy `serial` columns were not dumped at all.

Views were also missing entirely, including `connector_secrets_decrypted` and
`specialist_source_secrets_decrypted`.

Every one of those would have surfaced for the first time during an actual
emergency.

---

## The grants are part of the backup

`full_schema.sql` emits an explicit `REVOKE ALL ON ROUTINE … FROM PUBLIC, anon,
authenticated` for all 180 routines that no client role may execute.

This is not tidiness. Postgres grants `EXECUTE` to `PUBLIC` by default, so a
schema restored without its ACLs comes back with every `SECURITY DEFINER`
writer that migration 365 closed **open to anyone who can sign up**. A restore
that silently reopens the security perimeter is worse than a restore that
fails, because it looks like it worked.
