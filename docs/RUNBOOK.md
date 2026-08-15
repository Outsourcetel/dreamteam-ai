# Operations Runbook

This is how you run the platform. Every section assumes you've read ONBOARDING.md first.

## Table of Contents

- [Applying a Migration](#applying-a-migration)
- [Deploying an Edge Function](#deploying-an-edge-function)
- [Rolling Back](#rolling-back)
- [Debugging Production](#debugging-production)
- [The Migration Ledger](#the-migration-ledger)
- [Disaster Recovery](#disaster-recovery)

---

## Applying a Migration

Migrations are SQL files that change the database schema. They live in `supabase/migrations/` and are applied in numerical order.

### Before you apply

1. **Verify it's committed.**
   ```bash
   git status supabase/migrations/
   ```
   If the migration file is untracked, commit it first. An applied-but-uncommitted migration is the worst state: the effect is permanent, the source is one `rm` from gone, and a rebuilt environment differs silently.

2. **Verify the number is unique.**
   ```bash
   ls supabase/migrations/ | grep -E '^\d+_' | sort -n | tail -5
   ```
   Compare against production ledger:
   ```bash
   npm run db:query "select filename from public.schema_migrations order by filename desc limit 5"
   ```
   If a number is taken, renaming it is worse than keeping the duplicate — see "The Migration Ledger" below.

3. **Read the migration.** Every migration must pass this smell test:
   - Does it have a comment explaining what it changes and why?
   - Does it touch `playbook_definitions.steps` or any audit-chain table? If yes, does it claim the service_role first?
   - Does it have assertions at the end? (if not, ask why)

### Apply it

```bash
npm run migrate:next -- <path_to_migration>
```

This runs the migration against production and records it in `public.schema_migrations`. The file itself becomes the ledger entry; renaming it later orphans the ledger row.

### After you apply

1. **Verify it applied by name, not number.**
   ```bash
   npm run db:query "select filename from public.schema_migrations order by recorded_at desc limit 3"
   ```
   The `filename` column is what's keyed — the query must return your migration's exact filename.

2. **If it has assertions, re-run the migration file.** Not to apply it again — to run the assertions. The assertions are proof:
   ```bash
   npm run db:query -- supabase/migrations/NNN_your_migration.sql
   ```
   They should all pass silently or explicitly print success.

3. **Commit if it's not already.** If you applied before committing, commit now.

### If it fails

Run it again with context:
```bash
npm run db:query -- supabase/migrations/NNN_your_migration.sql
```

This re-runs the entire file, so it will hit `CREATE` and get an error if the object exists. That's expected. Look for:
- A PostgreSQL error in the output (syntax, constraint, missing table)
- An assertion failure (a line that says the data doesn't match what the migration expects)

**Do not** try to "fix it" by running pieces of the migration by hand. Either fix the migration file and re-run the whole thing (it's idempotent or it's broken), or roll back and rewrite it.

---

## Deploying an Edge Function

Edge functions are TypeScript files in `supabase/functions/` that run on Supabase's edge infrastructure. They're deployed with:

```bash
node scripts/deploy.mjs --fn <name>
```

### Before you deploy

1. **Verify your tree is up to date with main.**
   ```bash
   git fetch origin
   git log --oneline HEAD..origin/main -- supabase/functions/<name>
   ```
   If main has commits touching this function after your base, rebase first:
   ```bash
   git rebase origin/main
   ```
   Deploying over another agent's changes silently reverts their code in production. This has happened twice.

2. **If you changed _shared modules, check what depends on them.**
   ```bash
   grep -l "_shared/<module>" supabase/functions/*/index.ts
   ```
   Any function that imports from `_shared` bundles the entire module. If the module changed, the depending functions are stale in production until redeployed.

3. **Check if it has verify_jwt set correctly.**
   ```bash
   npx supabase functions list --project-ref rfsvmhcqeiyrxivbmpel | grep <name>
   ```
   Look for the `verify_jwt` column. If it was FALSE and you're deploying, it will stay FALSE (the deploy preserves the setting). If it was TRUE and should be FALSE, add `--no-verify-jwt` to the deploy command.

### Deploy it

```bash
node scripts/deploy.mjs --fn <name>
```

Or multiple at once:
```bash
node scripts/deploy.mjs --fn <name1> <name2> <name3>
```

The script will:
- Check that your tree is not ahead of origin/main (if it is, rebase)
- Bundle the function and its `_shared/` imports
- Deploy to Supabase
- Probe the deployed function with an anon RPC to verify it's alive

### After you deploy

1. **Verify the deployment succeeded.** The output says `✓ deployed N function(s)`. If it says something else, the deploy did not go through.

2. **Check the live deployment.** The easiest proof is to call the function from production and get a real response, not a 404 or 500. For example, `playbook-execute` has a `/health` endpoint:
   ```bash
   curl -X POST https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/playbook-execute \
     -H "Authorization: Bearer <anon_key>" \
     -H "Content-Type: application/json" \
     -d '{"action":"health"}'
   ```
   If you get a JSON response back, not an error, it deployed.

### If it fails

The deploy command will tell you why:
- `curl: command not found` → you need curl (comes with your OS)
- `Command failed: npx supabase functions deploy …` → read the stderr, it will say why (missing dependencies, syntax error, bad config)
- `refusing to deploy from a STALE tree` → rebase first (see "Before you deploy")

**Do not** use `--stale-ok` to bypass the staleness check unless you have read the output of `git log HEAD..origin/main -- supabase/functions/` and confirmed main doesn't have code changes to this function. Deploying over another session's changes silently overwrites them.

---

## Rolling Back

A rollback means "undo a deployment or migration and restore the prior state."

### Edge function rollback

An edge function deploy is atomic: it either fully succeeds or doesn't go live. If it fails, the old version stays live. If it succeeds but you want to revert:

1. **Revert the commit(s)** that changed the function:
   ```bash
   git revert <commit-hash>
   ```
   This creates a new commit that undoes the changes.

2. **Redeploy the function:**
   ```bash
   node scripts/deploy.mjs --fn <name>
   ```

3. **Verify the live version** matches what you reverted to (use the curl test from "After you deploy").

### Migration rollback

**There is no automatic undo for a migration.** Rollback means:

1. **Understand what the migration did** (read it top-to-bottom)

2. **Write a new migration that undoes it** (e.g., if mig 123 added a column, mig 124 drops it)

3. **Apply the undo migration** using the normal "Applying a Migration" flow

### Do not manually undo

Do not:
- Drop tables or columns by hand via the SQL editor
- Update `public.schema_migrations` to lie about what's applied

These skip the audit chain and make the git/ledger/database inconsistent.

---

## Debugging Production

### Check the audit chain

Every schema change, every data write to an audit-tracked table, and every RPC call is recorded in `public.audit_log`. Start there:

```bash
npm run db:query "
  select created_at, user_id, action, detail
  from public.audit_log
  where created_at > now() - interval '1 hour'
  order by created_at desc
  limit 20
"
```

This shows you the last hour of activity. Look for:
- Unexpected writes to a table you thought was read-only
- A user action that shouldn't have succeeded
- The exact timestamp when something went wrong

### Check the migration ledger

```bash
npm run db:query "select filename, applied_at from public.schema_migrations order by applied_at desc limit 10"
```

This tells you which migrations are applied and when. Compare against `git log --oneline supabase/migrations/` — they must match exactly (filenames, not numbers).

### Check edge function logs

The Supabase dashboard at https://supabase.com/dashboard/project/rfsvmhcqeiyrxivbmpel/functions shows recent invocations and errors. Filter by function name to see what failed.

Alternatively:
```bash
npx supabase functions list --project-ref rfsvmhcqeiyrxivbmpel
```

This shows the deployed version and `updated_at` for each function. Compare against what you deployed locally.

### RLS rejection (403)

If a user is denied access to a row they should see:

```bash
npm run db:query "
  select count(*) from public.<table>
  where tenant_id = '<their_tenant_id>'
  and <your_filter_clause>
"
```

Run this as service_role to see the raw count. If it's > 0, the row exists. Then check the RLS policy:

```bash
npm run db:query "
  select policyname, qual, with_check
  from pg_policies
  where tablename = '<table>'
  order by policyname
"
```

Each policy is a `WHERE` clause (qual) that must be true for the user to see/write the row. If the clause is wrong, the user is legitimately denied.

---

## The Migration Ledger

The ledger is `public.schema_migrations`, which keys on `filename` (not number).

### Why filenames, not numbers

If two agents apply migs 715 and 716 in parallel, one agent's 715 lands first, then the other agent's 715 tries to apply and fails. Numbering from a stale base is the trap. The filename is immutable after the file is created (`O_EXCL` at claim time), so two files never have the same name.

### Duplicate numbers are permanent debt

If two files ever share a number (e.g., `715_mig1.sql` and `715_mig2.sql`), **both must exist and both must be applied**. Renaming one is worse:
- Renaming `715_mig1.sql` to `715_mig1_old.sql` leaves the ledger row pointing to a nonexistent file
- The migration is listed as applied but the file is gone, making the environment un-rebuilding-able

The ledger records the exact filename; renaming breaks the invariant.

### Checking for duplicates

```bash
ls supabase/migrations/ | sed 's/_.*//' | sort | uniq -d
```

Any output is a duplicate number. It's OK — they're listed as permanent debt in `scripts/certify.mjs`. But renaming them is forbidden.

---

## Disaster Recovery

### Restoring from backup

Supabase has automated backups. To restore:

1. **Tell the founder.** Restore means losing all data changes since the last backup. It's a blunt instrument.

2. **Open the Supabase dashboard** → Project → Backups → Restore

3. **Pick the backup date** and confirm. The database will be unavailable for a few minutes.

4. **Re-apply any migrations** that were applied after the backup:
   ```bash
   git log --oneline <backup_timestamp>..HEAD supabase/migrations/
   ```
   Re-run each migration in order.

5. **Redeploy any edge functions** that changed after the backup.

### If migrations are orphaned

If the git log and the ledger disagree (e.g., a migration file exists but isn't in the ledger, or vice versa):

1. **List what git has:**
   ```bash
   ls supabase/migrations/ | sort
   ```

2. **List what the ledger has:**
   ```bash
   npm run db:query "select filename from public.schema_migrations order by filename"
   ```

3. **For each missing file,** apply it:
   ```bash
   npm run migrate:next -- <filename>
   ```
   (The filename here is the full path relative to the working directory.)

4. **For each orphaned ledger row,** contact the founder. A ledger entry with no file means something changed the database outside of migrations, and needs investigation.

---

## Incident Response: Production Data Corruption

If you discover a row with incorrect data:

1. **Do not delete or update it.** The audit log is the source of truth for what happened.

2. **Create an audit query** to understand the row's history:
   ```bash
   npm run db:query "
     select created_at, action, detail
     from public.audit_log
     where entity_table = '<table>'
     and entity_id = '<row_id>'
     order by created_at
   "
   ```
   This shows every change to that row.

3. **If the audit log is wrong,** that's worse — it means the audit gate was bypassed. Report to the founder.

4. **Fix the data with a new migration** that documents why:
   ```sql
   -- Mig NNN_fix_row_xyz_reason.sql
   -- Row xyz in <table> was corrupted by [incident].
   -- Correct value is [new_value], was [old_value].
   -- See audit log entry at [timestamp].
   
   update public.<table> set column = 'new_value' where id = 'xyz';
   ```

   Apply it normally. The audit log records the correction.

---

## Summary

- **Migrations**: verify unique number, commit first, apply with `npm run migrate:next`, verify via ledger
- **Edge functions**: rebase before deploy, deploy with `node scripts/deploy.mjs --fn <name>`, verify live
- **Rollback**: revert the commit, redeploy (for functions) or write an undo migration (for schema)
- **Debug**: start with audit log, then ledger, then function logs
- **Disaster**: restore from backup, re-apply migrations, redeploy functions
