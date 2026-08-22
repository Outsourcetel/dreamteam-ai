# `supabase/staged/` — migrations written, not yet numbered

These are complete, reviewed migrations that **cannot be numbered from the
session that wrote them**, because `scripts/migration-next.mjs` takes its claim
on production:

> ⚠ **NO PRODUCTION, NO CLAIM.** If the ledger is unreachable, claiming REFUSES
> rather than guessing. Reporting still works offline. Claiming without the
> shared resource is precisely the bug.

That refusal is correct and must not be worked around. Guessing a number is what
produced the **23 duplicate prefixes** already permanent in this tree — and the
tool answered correctly every time it was skipped. So the SQL waits here rather
than landing on a guessed number.

**This directory is not `supabase/migrations/`.** Nothing applies from here:
every runner and gate reads `supabase/migrations/*.sql` non-recursively, so a
file here is inert by construction.

## Landing one

```bash
npm run migrate:next -- <the_slug_below>          # claims on production, prints the path
# move the body of the staged file into the file that just appeared
git add supabase/migrations/<NNN>_<slug>.sql && git commit && git push
# merge to main — db-query.mjs requires the file to be byte-identical there
node scripts/db-query.mjs --file supabase/migrations/<NNN>_<slug>.sql
rm supabase/staged/<slug>.sql                     # it has landed; do not keep two copies
```

Then re-run `npm run certify` and expect the matching findings in
`review/certify-last.json` to disappear.

## What is here

| File | Closes | Severity |
|---|---|---|
| `close_the_cross_tenant_read_oracles.sql` | Cross-tenant task-title disclosure in `decide_human_tasks` / `preview_decide_human_tasks`, and the `data_access_grants` oracle in `validate_watcher_config` | **HIGH** |
| `pin_the_last_four_search_paths_and_close_the_rls_gap.sql` | The last 4 of 791 SECURITY DEFINER functions with no pinned `search_path`, and `migration_number_claims` — the only public table without RLS | MEDIUM |
| `anchor_the_audit_chain.sql` | The audit chain cannot detect **tail truncation**, and `audit_chain_head()` — the mitigation built for exactly that — has zero callers | **HIGH** |

## Two things each of these does deliberately

**They build their own fixtures and roll them back.** A corpus sweep on
2026-08-22 found **111 apply-time assertion sites across 57 migrations** that
assert on data production happens to contain — against the *three*
`audit-migration-replayability.mjs` names. Those cannot be repaired (the ledger
keys on filename **and** checksum, so editing an applied file breaks `certify`),
which is why the same day added a credential-free static pre-flight so a 112th
never lands. All three files here pass it:

```
node scripts/audit-migration-replayability.mjs --files supabase/staged/<file>.sql
  ✓ static pre-flight: no apply-time assertion reads data it does not create
```

**Their proofs assert the thing that would actually be broken.**
`anchor_the_audit_chain.sql` does not check that a table exists and stop there —
it appends two events, anchors, deletes the newest one, and **fails the
migration if the truncation is not detected**. A proof that cannot fail is the
shape this repository has already paid for.

## If you are reading this because the directory is empty

Good — that is the intended resting state. It exists so that "written but
unnumbered" is a visible state with a README, rather than SQL pasted into a chat
log and lost.
