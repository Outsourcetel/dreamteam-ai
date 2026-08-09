# Deployment setup — do this ONCE, never again

**Corrected 2026-08-09.** This document used to promise that every deployment was
a single command, `node scripts/deploy.mjs`. That is not true and never was: the
migration half of that script calls a database function that was never created,
so it dies before it applies anything. The **edge-function half works**, and
migrations are applied with **`scripts/db-query.mjs`**, one file at a time.

What follows is the deploy that actually works, with the evidence for each claim.

The reason deployments need a one-time human setup at all: a safety layer
(correctly) refuses to let the AI fetch production secrets or grant itself
permission to run credential commands. So a human wires those two things once;
after that the AI just runs the pre-approved commands.

## ⛔ Broken — do not use

`node scripts/deploy.mjs` **with migrations enabled**. It does two impossible
things:

- reads a ledger table that does not exist — `deploy.mjs:70` queries
  `_supabase_migrations`;
- applies SQL through an RPC that does not exist — `deploy.mjs:86` calls
  `exec_sql`.

`npm run migrate:apply` (`scripts/apply-migration.mjs`) had the same two faults
plus a third — it used the ANON key, which cannot run DDL at all. It has been
**deleted** (2026-08-09) along with its npm script, rather than documented as
broken: a runner that cannot work is a trap for whoever finds it first, and
documentation is a weaker guard than absence.

Measured against production today:

```
node scripts/db-query.mjs --sql "select (select count(*) from pg_proc where proname='exec_sql') as exec_sql_count,
  to_regclass('public._supabase_migrations')::text as underscore_table,
  to_regclass('public.schema_migrations')::text as ledger_table"
→ [{"exec_sql_count":0,"underscore_table":null,"ledger_table":"schema_migrations"}]

GET /rest/v1/_supabase_migrations?select=name&limit=1
→ HTTP 404 {"code":"PGRST205","hint":"Perhaps you meant the table 'public.schema_migrations'"}
```

`exec_sql` exists in **no schema** — the count above is unqualified by namespace.
The real ledger is **`public.schema_migrations`** (created by migration
`364_migration_ledger.sql`), and its key column is `filename`, not `name`: a
`select=name` against it returns `42703 column … does not exist`.

This fails **closed and loud**, so nothing is at risk from having tried it —
`deploy.mjs:77` calls `die('Cannot determine applied state…')` before touching
anything. `apply-migration.mjs` is worse still: `:21` builds its client from the
**anon** key, which could not execute DDL even if `exec_sql` existed.

## Step 1 — put the secrets on disk (gitignored)

Create `D:\Dream Team AI\.env.local` (already in `.gitignore`) with:

```
SUPABASE_URL=https://rfsvmhcqeiyrxivbmpel.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
SUPABASE_ACCESS_TOKEN=<personal access token>
SUPABASE_PROJECT_REF=rfsvmhcqeiyrxivbmpel
```

- **service_role key**: Supabase dashboard → Project Settings → API → `service_role` (secret).
- **access token**: https://supabase.com/dashboard/account/tokens → *Generate new token*.

**All four are already present in this checkout** — the previous version of this
document said the two secrets were missing and that only the public anon key was
available, and that has not been the case since 2026-07-22. `.env` separately
holds the public `VITE_SUPABASE_*` values for the frontend build.

Of the two, `SUPABASE_ACCESS_TOKEN` is the one that matters most: `db-query.mjs`
and `migration-status.mjs` use it (Management API), and so does `npx supabase
functions deploy`. `SUPABASE_SERVICE_ROLE_KEY` is only read by the two broken
runners above and by `deploy.mjs`'s verify step.

## Step 2 — pre-approve the commands (once)

The classifier must not challenge the deploy commands. Run `/permissions` in an
interactive `claude` session and Allow them, or add to `.claude\settings.local.json`
under `permissions.allow`:

```json
"Bash(node scripts/db-query.mjs:*)",
"Bash(node scripts/migration-status.mjs:*)",
"Bash(node scripts/deploy.mjs:*)"
```

An agent can't add these rules itself — that's the whole point of the guard — so
it has to be you, one time.

**Check before assuming.** The previous version of this document claimed
`Bash(npx supabase functions deploy:*)` was "already allowed in this repo"; no
such rule is in either settings file today. `.claude/settings.json` carries no
`allow` entries at all, and `.claude/settings.local.json` (untracked, per-machine)
currently allows the `Bash` tool wholesale, which is why deploys run here without
a per-command rule. On another machine that will not be true.

## From then on

```bash
# What is actually applied to production right now
node scripts/migration-status.mjs          # APPLIED / ASSUMED / DRIFTED / PENDING / ORPHANED
node scripts/migration-status.mjs --dev    # same, against the dev project

# Apply ONE migration — the only path that works
node scripts/db-query.mjs supabase/migrations/653_some_migration.sql

# Ad-hoc SQL, without putting it on the shell command line
node scripts/db-query.mjs --sql "select count(*) from public.schema_migrations"

# Edge functions — this half of deploy.mjs works. --no-migrations is REQUIRED.
node scripts/deploy.mjs --no-migrations                            # defaults to de-work
node scripts/deploy.mjs --no-migrations --fn de-work de-answer     # specific functions
```

**Migrations, one at a time, in order.** `db-query.mjs` posts the file to the
Supabase Management API and — only after it succeeds — records it in
`public.schema_migrations` via `record_migration_applied()`. That row is keyed on
**FILENAME** (not the number: parallel sessions have produced duplicate numbers)
and carries a CRLF-normalised checksum, so re-applying a file that was *edited*
after it was applied prints `⚠ … applied before with DIFFERENT content`. Read the
result of each file before starting the next one; there is no batch mode.

**Edge functions.** `deploy.mjs` refuses to deploy when `origin/main` is ahead of
your HEAD (`assertNotStale`, override `--stale-ok`) — deploying from a stale tree
silently replaces another session's live function with your older copy, which has
happened twice. Rebase first. Four functions authenticate themselves and are
deployed `--no-verify-jwt` from the `NO_VERIFY_JWT` list at `deploy.mjs:113`; for
everything else the CLI preserves whatever setting the function already has.

**The verify step proves less than it looks.** `deploy.mjs`'s `verify()` probes
three hard-coded RPCs from July 2026 (`list_de_operate_config`,
`create_browser_operation`, `list_browser_operator`) — it does not check whatever
you just deployed.

Frontend deploys automatically on `git push` (Vercel git integration) — no step
needed.

## Not verified in this pass

- **The edge-function deploy was not run**, because running it is a production
  write. Its evidence is that it is the path in daily use, plus the empirical
  check recorded at `deploy.mjs:103-112`.
- **The frontend git-integration claim is inherited** from the previous version of
  this document and was not re-checked. Note that `docs/DEPLOYMENT.md` (dated
  2026-07-08) asserts the opposite — that there is no auto-deploy and every
  frontend release is a manual Vercel API call. One of the two is stale; this pass
  did not establish which.
- **Rollback is not covered here.** See `docs/DEPLOYMENT.md`, which states there is
  no one-command rollback for either half.
