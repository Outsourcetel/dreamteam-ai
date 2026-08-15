# Architecture: Decisions and Trade-offs

This document explains **why** the system is shaped the way it is, not what it does. Read ONBOARDING.md first for what things are.

---

## Core Pattern: Dual Formats for `playbook_definitions`

One table, two formats, three readers. This is the central tension of the platform.

### The Problem

A playbook could be:
- Something a human runs step-by-step (a procedure: checklist, decision, instruction, then complete)
- Something a DE's work engine compiles into tasks (an SOP: discrete steps it does in its own time queue)

Both are "steps," both are "published," but they're executable by different engines. The system had one flag (`status='published'`) being read by three different readers, each meaning something different.

### The Solution (Mig 715)

Add a `kind` column:
- `kind='sop'` → de-work compiles this into work items
- `kind='procedure'` → playbook-execute runs this synchronously

The column is **derived from the steps by trigger**, never declared. If someone rewrites the steps, `kind` updates automatically. This prevents drift — a row cannot claim to be an SOP while containing procedure-only steps.

### The Cost

One table holds two incompatible objects. Naming a column `kind` works, but it's not intuitive. New teammates have to learn that a "published playbook" might not be runnable by playbook-execute. 

The briefing doesn't filter by `kind` — a DE's briefing shows both formats it owns. This is correct: a DE needs to know "I'm working this SOP" and "I have this procedure available." Filtering would hide half the briefing.

### What This Teaches

- A single flag shared by multiple readers is a smell that you have two different object types
- Derive what you can (kind from steps) rather than storing it (kind from a dropdown)
- Don't optimize for a third-party tool's convenience (making the briefing easier) at the cost of completeness

---

## Deploy-Time Verification Over Runtime Gates

The system trusts you to verify code before shipping it, then ships without additional gates.

### The Pattern

```
You make changes → You run the changes → You verify the output → You push/merge
                   ↑
                   This step is non-negotiable
```

Every step of the pipeline assumes the previous step was done:
- The migration applies and asserts
- The edge function deploys and is probed
- The frontend runs locally before push
- Production has no canary rollout

### The Trade-off

**If you ship broken code, it breaks production immediately.** There is no staging, no slow rollout, no automatic rollback.

**The upside:** You find real bugs that staging environments hide. Staging has different data, different load, different edge cases. Production has all three. A schema mismatch or an RLS policy that's wrong shows up the moment the real query runs.

**The downside:** You have to be disciplined. The working agreement ("verify before completion") is load-bearing.

### What This Teaches

- Staging environments buy safety at the cost of realism
- Production testing is expensive in reputation but rich in signal
- You need very clear discipline about what "verified" means (code run, output read, not just "it compiled")

---

## Migration Numbers Are Filenames, Not Sequences

The ledger keys on `filename`, not the number prefix.

### The Problem

Two agents working in parallel might both pick number 715. If the ledger keyed on number, the second one would fail. If they both went live, the ledger would have two rows with the same number, and rebuilding the schema would apply them in a different order than production.

### The Solution

Claim the filename with `O_EXCL` at claim time (`npm run migrate:next`). The file itself becomes the ledger entry. Two files cannot have the same name on one filesystem.

### The Cost

The filename is long and ugly: `715_the_definition_says_which_engine_owns_it.sql`. The number is a hint, not an identifier. Duplicate numbers are permanent debt. And if two files collide (this has happened), renaming is impossible — the ledger row is tied to the filename forever.

### What This Teaches

- A claim (this file is taken) is stronger than an assignment (this number is used)
- Ledgers that key on immutable values (filename) are safer than ledgers that key on mutable ones (a number you picked)
- Permanent debt (the list of known duplicates) is cheaper than the machinery to prevent it (a central registry)

---

## Audit Log as Source of Truth

Every write and every decision is recorded in `public.audit_log`. The log is append-only; you cannot delete or rewrite it.

### The Pattern

- A schema change? The migration records it
- A data write? The trigger records the before/after
- An RPC call? The gate records who called it, what they asked for, what was returned
- A human decision? The task tracks it

The audit log is the system's memory of what happened.

### The Trade-off

**You cannot hide mistakes.** If you make a bad decision, it's in the log. If you write wrong data, it's in the log. The log cannot be edited to make it look good.

**But you can investigate.** Every production incident starts with the audit log. It tells you what changed, when, and who asked for it.

### What This Teaches

- A write-only ledger is a safety mechanism, not overhead
- If you're tempted to edit the log to "fix" something, you're masking a deeper problem (the tool that wrote the bad data)
- The log is the contract between the code and the compliance team

---

## Watchers as the Source of Objectives

A DE doesn't decide what to do — watchers decide when the DE should act.

### The Pattern

A watcher is a rule:
- **Schedule:** "Run this SOP every Monday at 9am"
- **State:** "When revenue < $X, start the retention flow"
- **Event:** "When a ticket is assigned to this queue, start the onboarding SOP"

When the watcher fires, it creates a `de_objective`, which the DE's work engine reads.

### The Trade-off

**The DE is reactive, not proactive.** It cannot decide "I want to do this task." It waits for a watcher to tell it to. This means the watcher logic is the bottleneck — a broken watcher produces no work, but a wrong watcher produces bad work.

**But this prevents autonomous misbehavior.** A DE cannot escalate beyond what its watcher allows. A DE cannot decide to contact someone who opted out. A DE cannot decide to spend the trust budget without a watcher saying it can.

### What This Teaches

- Authority flows from rules (watchers), not from agents (DEs)
- If the system behaves wrong, check the rules before blaming the agent
- Reactivity is a constraint that prevents worse mistakes

---

## No Staging Environment

Production data is the only real data. Tests use a dev project (`nmuntxrcdksyhsdywpan`).

### The Pattern

- **Local testing** uses `.env.test` (the dev project)
- **Production testing** uses `.env.local` (the prod project, applied after commit)
- **The CI system** runs against the dev project, then blocks if you deploy stale code to prod

### The Trade-off

**Staging would be safer.** A separate database that looks like production but isn't would let you test schema changes, permission changes, and edge cases without risk.

**But staging gets stale.** Staging has a copy of data from days/weeks ago. A schema mismatch or an RLS policy that's wrong shows up in production immediately, but in staging it shows up only if the test data hits that path. You'd need to maintain staging constantly.

**The real risk is not the schema — it's the ledger.** If a migration is applied to production but not to staging, they're out of sync. Rebuilding staging from production would take hours. It's cheaper to just test against production.

### What This Teaches

- Staging is useful when production and test data diverge slowly
- When they diverge quickly (an active platform), staging is liability maintenance
- The risk you're trying to prevent (deploying untested code) is better solved by discipline (verify before pushing) than by process (a staging gate)

---

## The Memory System as Distributed Knowledge

The team maintains context in `.claude/projects/D--Dream-Team-AI/memory/`. These files record:
- Decisions and their trade-offs
- Incidents and what was learned
- Blockers and why they can't be solved
- Patterns and anti-patterns

### The Pattern

A team decision is recorded in `project_*.md`, linked from `MEMORY.md`. When context is needed, someone reads the decision, understands the trade-off, and proceeds accordingly.

An incident is recorded in `project_incident_*.md` with what happened, what was tried, and what was learned. The next person who hits the same issue reads it and avoids the trap.

### The Trade-off

**The memory system is lossy.** It captures what was decided, not what was tried. It records patterns, not proofs.

**But it's the bridge between sessions.** A person joins the team, reads the memory, and understands not just the code but the thought process that shaped it. They avoid re-fighting old battles.

### What This Teaches

- Written context outlasts oral tradition
- The decision is less important than the trade-off (why we chose this over that)
- Memory maintenance is part of the job

---

## Mig 715: Typing `playbook_definitions.kind`

The most recent structural decision. See memory: `project_playbook_definitions_three_readers.md`.

The issue: one flag, three readers, three meanings.

The fix: add `kind` (derived from steps), three readers → three predicates.

The proof: 12 SOP definitions compiled from steps using the new predicate. Six pre-existing SOPs still worked. Three procedure-only definitions still runnable. No rows broken, no briefing incomplete.

---

## Summary

These decisions live here because each one is a trade-off, not an optimization. Each one sacrifices something (staging, automation, simplicity) to preserve something else (realism, autonomy, knowledge).

When you're tempted to "fix" one of these patterns (add staging, automate the deploy, centralize the memory), read this first. The trade-off might be worth it. But it's a decision, not an oversight.
