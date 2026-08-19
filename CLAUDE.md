# Working agreement

This repo has the `superpowers` plugin enabled at project scope
(`.claude/settings.json`). Its `using-superpowers` skill is injected at every
session start and states that a skill applying to the task is **not
negotiable**. It also states, in its own words, that *"user instructions
(CLAUDE.md … direct requests) take precedence over skills."*

This file is that instruction. It calibrates **when** the process skills fire.
It does not switch them off, and the second half below is not adjustable.

## Match the ceremony to the task

The founder works in short, direct instructions — "do the filter bar and wizard
draft", "fix the deep link first". That is not underspecification; it is a
decision already made. Answering a four-word instruction with a brainstorming
round re-opens a question that was closed, and it teaches the founder to write
longer prompts to avoid the interrogation.

**Go straight to the work when the request names its own target.** A named
file, component, page, function, bug or migration; a mechanical or bounded
change; anything already scoped in an earlier turn. Enumerate the surface, do
it, report honestly. No brainstorm gate, no written plan, no worktree.

**Use the full process when the work is genuinely open.** A new surface or
route with no design yet; several defensible approaches with real trade-offs;
requirements that would change the shape of the answer; anything touching
authority, tenancy, money or the audit trail; work spanning many sessions.
Mobile (handoff `13`) is the current example — brainstorm and plan that one.

When unsure, ask one sentence rather than running a whole skill to find out.

## What never yields

Calibration applies to *planning* ceremony only. These hold on every task, and
"the task was small" is not a reason to skip them:

- **Verification before completion.** Never call something done, fixed or
  passing without running the thing and reading the output. State plainly what
  is proven, what is inferred, and what was not checked.
- **Systematic debugging.** Find the cause before proposing a fix. Three wrong
  hypotheses shipped confidently cost more than one hour spent reading.
- **Honesty over reassurance.** Report failures with their output. Say when a
  step was skipped. Correct your own earlier claims when they turn out wrong,
  including in the same session.
- **Enumerate before acting.** Search the whole surface, not the part you
  expect. Grep call sites, not definitions.
- **A checker that cannot fail is theatre.** Invert every pin. Count the
  comparisons, not just the findings — zero findings from zero comparisons
  looks exactly like a clean result.

These are not stylistic. Each one is here because its absence has already cost
this project real defects: a governed refusal reported to the user as success,
five confident findings that were all wrong, a gate that had never fired.

## Migrations: claim the number, commit before you apply

More than one agent works this repo at once, sometimes in the same working
tree. Two rules, because both were broken on 2026-08-10 and one of them put
schema into production that the repository could not rebuild.

**1. Never pick the number yourself.**

```bash
npm run migrate:next -- what_it_does     # creates + prints supabase/migrations/NNN_what_it_does.sql
```

`ls | tail -1` is wrong, and quietly. "Taken" is the union of three sources that
routinely disagree — local files, `origin/main`, and the **production ledger**.
On the day this was written those read 666 / 668 / 668: anyone counting locally
would have re-used a number already applied to production. The command claims
the file with `O_EXCL`, so two agents racing cannot both win — and because the
file lands on disk immediately, it is a claim the other agent can see.

Run it with no slug to look without claiming.

**2. Commit the migration before applying it.** `db-query.mjs` now refuses an
untracked migration file. An applied-but-uncommitted migration is the worst
state available: the effect is permanent, the source is one `rm` from gone, and
a rebuilt environment differs silently. If you genuinely mean to, say so out
loud with `--allow-uncommitted`.

**3. Assert the absence of a violation, never the presence of an example.**

A migration's assertions must be about what the database now **is**, not about
what production happens to **contain**.

```sql
✗  if not exists (select 1 from t where <the good thing>) then raise ...
✓  if exists     (select 1 from t where <the bad thing>)  then raise ...
```

The second is vacuously true on empty data and still catches every real
violation. The first demands production's rows in order to pass, which encodes
"I am only ever run once, against one database" — the single thing a migration
must not assume. Assertions about **schema** — `pg_proc`, `pg_indexes`,
`information_schema`, a constraint definition — are always fine, because they
describe what the migration itself installed and are true wherever it runs.

This is not style. Three migrations already break it — 778 ("found no tenant
with two distinctly named non-assistant employees"), 789 ("no goal-having
employee without an open plan") and 790 ("no row carries
`disposition=cancelled`") — and the cost is that **dev cannot be brought level
by replay, a restored backup cannot be verified by replay, and a new
environment cannot be built from the migration history at all.**

They also cannot be repaired. The ledger keys on filename **and checksum**, so
editing an applied migration breaks `certify`. Before it lands is the only
moment this is fixable, which is why CI runs it on every new migration:

```bash
npm run audit:replayable
```

**Why the format cannot change.** The obvious fix is timestamps. It does not
work here: migrations replay in filename order and `20260810…` sorts *before*
`666…`, so every new migration would land in the middle of history. Renumbering
is worse — `public.schema_migrations` keys on **filename**, so renaming an
applied migration turns it into an orphaned ledger row plus a pending file.
The 19 pre-existing duplicate numbers are therefore permanent; `certify` ›
`migration-numbering` ratchets against a 20th.

## Scope discipline

Do what was asked, in full. Do not quietly widen it — if you notice something
worth fixing nearby, name it and leave it. Do not quietly narrow it either: if
part of the work is blocked, finish everything else and say exactly what you
left and why.
