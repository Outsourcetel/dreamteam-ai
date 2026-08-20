# Disaster recovery

**Status as of 2026-08-20: production has daily backups (7/7 COMPLETED this week,
no gaps), PITR is still OFF, and — new since 2026-08-05 — BOTH restore drills are
green: the schema rebuilds exactly AND the data export loads back verified.** Verified directly against the Supabase Management API, not inferred
from the dashboard:

```
GET /v1/projects/rfsvmhcqeiyrxivbmpel/database/backups
    "walg_enabled":  true          → daily physical backups
    "pitr_enabled":  false         → no point-in-time recovery
    7 backups, all COMPLETED, 2026-07-29 … 2026-08-05
    MISSING: 2026-08-02
```

This document was previously headed "the production database has no automated
backups", which was true on the free plan and stopped being true when the org
moved to Pro. It is worth saying plainly, because a stale DR document is worse
than none: it gets read in an emergency and believed.

**What is at stake:** 16 tenants · 21 user accounts · 2,005 knowledge documents ·
24 connectors · 47 scheduled jobs · 190 MB.

---

## What the current protection actually gives you

| Question | Answer |
|---|---|
| Project deleted or corrupted? | Restore yesterday's physical backup. |
| How much work can you lose? | **Up to 24 hours.** Snapshots are daily. |
| A bad migration corrupted a table at 14:32? | You cannot rewind to 14:31. You restore the whole database to the last snapshot and lose everything after it. |
| How far back can you go? | 7 days. |
| Has a managed restore ever been performed? | **No.** See "What is still not proven". |

**PITR (~$100/mo) is what closes the 24-hour window**, and it is the only thing
that turns "a migration corrupted one table this afternoon" from a day's data
loss into a few seconds'. That is a purchase decision, deliberately not
automated here.

### The missing 2026-08-02 backup

The chain runs Jul 29, 30, 31, Aug 1, **[nothing]**, Aug 3, 4, 5. Every other day
completed. One missing snapshot inside a 7-day retention window means the real
worst case that week was **48 hours of loss, not 24**.

Nothing in the platform notices this. If daily backups are load-bearing, a
periodic check of the backup list is worth more than trusting it silently — the
query is in the first code block above.

---

## What exists in the repo, and what each piece actually covers

These are independent of Supabase's managed backups and exist because a
managed backup is only as good as your ability to invoke it.

| Artifact | Command | Covers | Does NOT cover |
|---|---|---|---|
| `supabase/baseline/full_schema.sql` | `npm run backup:schema` | Every table, view, sequence, function, trigger, index, RLS policy, and the closed EXECUTE grants | Any data at all |
| `backups/<timestamp>/*.jsonl` | `npm run backup:data` | Every row of every public table, **plus `auth.users` and `auth.identities`** | Password hashes (opt-in), storage objects, vault secrets, cron schedules |
| Schema drill | `npm run restore:drill` | Proof the schema file rebuilds production exactly (throwaway schema on dev) | Proof the **data** restores |
| Data drill | `node scripts/restore-data-drill.mjs` | Proof the JSONL export loads back: row counts vs manifest, every FK orphan-swept, auth linkage, a real function answering from restored rows — in a throwaway local supabase/postgres container | Supabase's MANAGED restore (needs a second project = founder purchase) |
| `public.schema_migrations` | `npm run migrate:status` | Which migrations are applied, and whether a file changed after being applied | — |

### auth.users is captured — the old gap is narrower than it was

An earlier version of this document said a restore "gives you every tenant's
records with nobody able to log in". That is no longer accurate.
`backup-data.mjs` exports `auth.users` **including the UUIDs**, which are the
load-bearing part — every `profiles.user_id` and every audit row points at one.

`encrypted_password` is **excluded by default** and needs
`--include-password-hashes`. That default is deliberate: customer data leaking is
bad, but bcrypt hashes leaking is worse in kind, because they can be cracked
offline and tried against those people's other accounts. Without hashes a restore
still works — every user goes through one password reset. With them, nobody
notices the restore happened. Choose per situation; do not make it the silent
default.

### What is genuinely still not in any backup

- **Vault secrets** — connector credentials are encrypted at rest and
  deliberately not exported. After a restore, every connector must be
  re-authorised. With 24 connectors that is real work; budget for it.
- **Storage objects** — currently zero, so no loss today. This stops being true
  the moment file upload is used, and nothing will announce it.
- **pg_cron schedules** — 47 jobs, recreated by hand or by re-running the
  migrations that created them.

---

## Restoring

### Case 1 — the project still exists, and you want it back to yesterday

Use Supabase's own restore from the dashboard. It restores **in place**, over the
current database. Everything since the snapshot is gone. Nothing in this repo is
involved.

### Case 2 — restoring from nothing (project deleted, or moving providers)

1. Create a new Supabase project. **Enable Pro + PITR on it immediately**, so
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
4. Load `_auth_users.jsonl` and `_auth_identities.jsonl`. Keep the UUIDs — every
   foreign key into a user depends on them. Without hashes, trigger a password
   reset for every user.
5. Redeploy the edge functions
   (`node scripts/deploy.mjs --no-migrations --fn <name>`) and **re-seed vault
   secrets** — every connector needs re-authorising.
6. Recreate the pg_cron schedules.
7. Run `npm run migrate:status` and confirm the ledger matches the repo.

---

## What is still not proven

Being explicit, because the gap between "we have backups" and "we can recover"
is where recoveries fail.

| | Proven? |
|---|---|
| The schema file rebuilds production exactly | **Yes** — drilled, see below |
| The data export loads back and the app works | **Yes** — drilled 2026-08-20: 108,109 rows, 214/214 tables match the manifest, 604/604 FKs swept clean, 24 auth users linked (0 orphaned profiles), get_de_worklists answered with production's live numbers from restored rows |
| Supabase's managed physical backup restores | **No** — and cannot be drilled here |

**The managed restore cannot be drilled without spending money.** It restores in
place, so rehearsing it on production would destroy production. Proving it needs
a second project to restore *into*. That is a founder decision, not an
engineering task — and until it is made, "we have daily backups" means the
snapshots exist, not that anyone has watched one come back.

---

## Why the drill matters more than the file

`npm run restore:drill` regenerates the dump, rebuilds it into a throwaway
schema on the dev project, compares it to production object-for-object, and
drops it. Production is read-only throughout. Current result (2026-08-20):

```
tables 306 · views 7 · functions 867 · triggers 296
policies 404 · rls_enabled 305 · columns 3498      — all OK (7/7)
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

### And the drill itself rotted, which is the lesson underneath the lesson

On 2026-08-05 the drill passed all seven comparisons and then **threw during
cleanup**, leaving all 1,053 objects of its scratch schema on the dev project.
`DROP SCHEMA … CASCADE` takes a lock on every dependent object in one
transaction, and the schema had quietly grown past
`max_locks_per_transaction`. It had crossed that line some weeks earlier.

Two separate faults, and the second is the more dangerous:

- The **leak**: fixed by dropping in batches of statements. Both limits pull
  opposite ways — one statement blows the lock table, one request per object gets
  rate-limited into an HTML error page. Thirty objects per statement satisfies
  both.
- The **misattribution**: cleanup ran *before* the pass/fail check, so a drill
  whose comparison had PASSED exited non-zero with a lock error. Read at a
  glance, that says "the backup is broken". It was not. **A tidying step must
  never be able to impersonate the thing being tested** — the verdict is now
  decided first, and a cleanup failure says so in its own words.

Run the drill periodically, not once. It is the only artifact here that tells you
whether the backup still describes the system.

---

## 2026-08-20 — the day both drills earned their keep

Three defects found, all invisible by reading the files, all fixed the same day:

1. **The dump had stopped being able to restore itself.** Five LANGUAGE-sql
   functions call `evidence_is_production` (mig 682) and were emitted BEFORE
   its definition; sql bodies validate at CREATE, so the restore died at ~4%.
   The drill had been green on 2026-08-05 — production GREW into the defect.
   Fix: the dump now opens with `SET check_function_bodies = off` (pg_dump's
   own answer to exactly this).
2. **The dump outgrew the Management API.** A-12's 841 grant lines pushed the
   single-request restore past the body cap (HTTP 413). The drill now splits
   into whole statements (dollar-quote-aware, byte-identical round-trip) and
   applies 512KB chunks, re-stating session GUCs per chunk.
3. **The data drill's own first run lied to itself** — 3MB of schema fed down
   docker's stdin on Windows chokes silently; zero objects landed and only the
   object-count check said anything. Payloads now travel docker cp → psql -f,
   and a zero-table apply fails loudly.

4. **Four policies restored into thin air.** Policies bound to CUSTOM roles
   (`trust_pattern_proposer`, `approval_brief_writer`) errored on any
   environment lacking the roles — the dev drill never noticed because dev's
   migrations had created them. The dump now emits every non-builtin role a
   policy references, idempotently, with memberships, before the policies.

First-ever DATA restore proof, same day: **108,109 rows · 214/214 tables match
the manifest · 604/604 foreign keys orphan-swept clean · 24 auth users linked,
0 orphaned profiles · `get_de_worklists` answered from restored rows with
production's live numbers — and after fix 4, the apply runs with ZERO error
lines and 404/404 policies.** Exporter hardened en route: adaptive page halving
(the API truncates oversized bodies MID-JSON with HTTP 200), 429 backoff on
the throttler's timescale, and `--resume` so a crash never re-pays finished
tables.

Still not proven, unchanged: **Supabase's managed physical restore** — needs a
second project to restore into (founder purchase), and PITR remains OFF.

## The grants are part of the backup

`full_schema.sql` emits an explicit `REVOKE ALL ON ROUTINE … FROM PUBLIC, anon,
authenticated` for the 248 routines that no client role may execute.

This is not tidiness. Postgres grants `EXECUTE` to `PUBLIC` by default, so a
schema restored without its ACLs comes back with every `SECURITY DEFINER`
writer that migration 365 closed **open to anyone who can sign up**. A restore
that silently reopens the security perimeter is worse than a restore that
fails, because it looks like it worked.
