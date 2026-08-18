# Authority evaluator probes

Behavioural coverage for `public.evaluate_authority` (migs 768/770/772,
still UNAPPLIED to production): exact/role/org-unit actor binding, the
inactive-intermediate-unit differential (i3/i4), absence-escalates on every
input, the actor-kind whitelist and actor-resolution check, unfireable
thresholds rejected at insert, and the certify probe's evaluator-absence
arm. Not wired into `npm run certify` — that depends on schema this branch
has not shipped yet.

Run as ONE aborting transaction against production; nothing here is ever committed:

```sh
{ echo 'begin;'; \
  sed -e '/^begin;$/d' -e '/^commit;$/d' supabase/migrations/768_a_registry_of_things_authority_can_measure.sql; \
  sed -e '/^begin;$/d' -e '/^commit;$/d' supabase/migrations/770_a_rule_that_cannot_name_an_unreadable_measure.sql; \
  sed -e '/^begin;$/d' -e '/^commit;$/d' supabase/migrations/772_one_evaluator_strictest_wins_absence_escalates.sql; \
  cat supabase/tests/authority/evaluate-authority-probes.sql; \
} > /tmp/authority-dry-run.sql && node scripts/db-query.mjs /tmp/authority-dry-run.sql
```

The output file must land outside `supabase/migrations/` — that path is what makes `db-query.mjs` treat a file as a real migration and refuse it unless committed.
