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

## compose-decide-human-task.sql (step 2)

Requires 768, 770, 772 (applied 2026-08-18) plus step 2's 783 and 784. Run as
one aborting transaction — concatenate any of those not yet applied:

    { echo 'begin;'; \
      sed -e '/^begin;$/d' -e '/^commit;$/d' supabase/migrations/783_a_workspace_can_write_an_authority_rule.sql; \
      sed -e '/^begin;$/d' -e '/^commit;$/d' supabase/migrations/784_a_second_question_before_a_signature.sql; \
      cat supabase/tests/authority/compose-decide-human-task.sql; \
    } > <scratchpad>/dry-compose.sql && node scripts/db-query.mjs <scratchpad>/dry-compose.sql

c1 is load-bearing: with authority_rules empty the added check must be `allow`
for every (tenant,user) pair drawn from live approval_authority rows, which is
what makes the composition a no-op. c1b exists because c1 passes vacuously on
zero pairs. c5 exists because c1-c4 call evaluate_authority DIRECTLY and would
all pass against an UNCOMPOSED decide_human_task — c5 is the only one that
checks the composition happened at all.
