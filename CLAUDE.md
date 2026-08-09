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

## Scope discipline

Do what was asked, in full. Do not quietly widen it — if you notice something
worth fixing nearby, name it and leave it. Do not quietly narrow it either: if
part of the work is blocked, finish everything else and say exactly what you
left and why.
