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

## compose-decide-action-execution.sql (step 3)

Requires 768, 770, 772, 783, 784 and step 3's migration. Run as one aborting
transaction (concatenate the step-3 migration if it is not yet applied):

    { echo 'begin;'; cat supabase/tests/authority/compose-decide-action-execution.sql; } \
      > <scratchpad>/dry-dae.sql && node scripts/db-query.mjs <scratchpad>/dry-dae.sql

d1 is load-bearing: with authority_rules empty, every live employee must still
get a decision from today's vocabulary. d1b exists because d1 passes vacuously
on zero employees. d5 exists because d2-d4 call decide_action_execution and
would report today's answers if the composition never happened. d6 proves the
earned-trust resolution was not replaced.

FIX ROUND 1: d3 (a `require_human` rule must not auto-execute) was vacuous
against the live fixture — that employee's real `de_autonomy` state is
`enabled=false` for `crm`, so its baseline was already not `auto_executed`
and the assertion passed whether or not the rule was ever consulted. Fixed by
seeding a `de_autonomy` row inside the aborting transaction so the baseline
is provably `auto_executed` before the rule is added, never by hunting
production for a DE that happens to be enabled (that would make the suite
depend on data that can change under it). d3a proves the seed worked; d3
proves the rule takes exactly that away. Both are scrubbed before d4 runs so
they cannot leak into it.
