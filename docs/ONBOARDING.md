# Onboarding Guide

This guide is for a new engineer joining the team. It covers setup, understanding the project shape, and the working agreements that keep everything consistent.

**Before you code, read:** CLAUDE.md (2 min), this guide (20 min), then ARCHITECTURE.md (10 min). Then pick a small bug or docs fix to practice the workflow.

---

## Table of Contents

- [Environment Setup](#environment-setup)
- [The Project Shape](#the-project-shape)
- [How Work Flows](#how-work-flows)
- [The Three Big Engines](#the-three-big-engines)
- [The Working Agreement](#the-working-agreement)
- [Common Tasks](#common-tasks)

---

## Environment Setup

### Prerequisites

- Node.js 22+ (check: `node --version`)
- Git (check: `git --version`)
- A Supabase account (the project is already set up; you don't create a new one)
- GitHub access to Outsourcetel/dreamteam-ai

### One-time setup

1. **Clone and install:**
   ```bash
   git clone https://github.com/Outsourcetel/dreamteam-ai.git
   cd "Dream Team AI"
   npm install
   ```

2. **Set up `.env.local`** for local development (ask the team for this file; it has secrets):
   ```bash
   cp .env.local.example .env.local  # if one exists
   # otherwise, ask the founder for the values
   ```
   This file never goes to git. It holds:
   - `SUPABASE_URL`: https://rfsvmhcqeiyrxivbmpel.supabase.co
   - `SUPABASE_ANON_KEY`: the public API key (safe to read from git config if needed)
   - `SUPABASE_SERVICE_ROLE_KEY`: the secret admin key (ask the founder)
   - `SUPABASE_ACCESS_TOKEN`: for running migrations locally (ask the founder)
   - `SUPABASE_PROJECT_REF`: rfsvmhcqeiyrxivbmpel

3. **Verify it works:**
   ```bash
   npm run db:query "select count(*) from public.playbook_definitions"
   ```
   If you get a number, you're connected. If you get an auth error, `.env.local` is wrong.

4. **Read CLAUDE.md** in this directory. It's not aspirational — it's how the team actually works.

---

## The Project Shape

This is a **workforce operating system** — software that runs inside a company to automate and coordinate work.

### What is a DE?

A "DE" (Digital Employee) is a semi-autonomous role. It has:
- A playbook (a set of steps it can run)
- A desk (the data it reads and writes)
- Authority levels (what it can decide on its own vs. what needs human approval)
- A lifecycle (idle → active → archived)

Examples: Accounting DE, Sales Support DE, Onboarding DE. There are twelve of them live in production.

### The core tables

These are the load-bearing rows. Understand them before anything else:

| Table | Purpose | Source of truth |
|---|---|---|
| `digital_employees` | DE instances and their status | this table |
| `playbook_definitions` | the steps a DE can run | git (built by migrations) |
| `playbook_versions` | immutable snapshots of a definition at publish time | set by the executor |
| `de_work_items` | tasks the DE is working on | built by the work engine |
| `de_objectives` | outcomes the DE is pursuing | from watchers (time, state) |
| `audit_log` | every schema change and RPC call | triggers on every write |
| `role_archetypes` | templates for DE roles (the blueprint for Accounting, Sales, etc.) | git (built by migrations) |

### Sources of truth

- **Code** lives in git. Git is the source of truth for migrations, edge functions, and the schema.
- **Config** lives in the database. Dials, guardrails, and trust levels are rows in tables.
- **Ledger** is `public.schema_migrations`. It records which migrations have run.
- **Audit** is `public.audit_log`. It records every write and every decision.

If git, database, and ledger disagree, something went wrong. See RUNBOOK.md, "The Migration Ledger."

---

## How Work Flows

This is the **handoff between you, the system, and the database:**

### 1. You edit code

You make changes locally, commit them, and push to a branch.

### 2. You run the changes

Before opening a PR:
- If you changed a migration, apply it: `npm run migrate:next`
- If you changed an edge function, deploy it: `node scripts/deploy.mjs --fn <name>`
- If you changed the frontend, test it locally: `npm run dev`

You run your own code first. You verify it works. **You don't ask someone else to test it.**

### 3. You open a PR

A PR is a proposal. It stays open only if it's waiting for a human decision (will we pursue this? do you approve?). If it's already in production, close it and link to the live work.

For migrations and edge functions, the PR is often redundant — the code is already live and already tested. That's fine. The PR is a record, not a gate.

### 4. The tests run

GitHub Actions runs `npm run build`, `npm run test:unit`, and `npm run audit`. These must pass. If they don't, fix them and push again — no "merge anyway."

### 5. Someone merges it

This is straightforward: squash-merge, delete the branch.

### No staging environment

There is no staging. You test against production data. This is scary and necessary. It's how we catch schema mismatches and permission bugs that a staging environment would hide.

---

## The Three Big Engines

The platform has three core systems that do different jobs:

### 1. `de-work`

**What it does:** Turns a DE's SOPs (standard operating procedures) into work items.

**Where it lives:** `supabase/functions/de-work/index.ts`

**How it works:**
- Reads `playbook_definitions` where `kind='sop'`
- Compiles the steps into `de_work_items`
- The DE picks one up and works it

**What can break:** If `kind` is wrong, it won't find the SOP. If a step references a tool the DE isn't offered, it escalates.

### 2. `playbook-execute`

**What it does:** Runs a playbook step-by-step, making decisions and calling tools.

**Where it lives:** `supabase/functions/playbook-execute/index.ts`

**How it works:**
- Reads a `playbook_definitions` row where `kind='procedure'`
- Executes each step (decision, instruction, checklist, etc.)
- Records the run in `playbook_runs` and `playbook_steps`

**What can break:** If a step has an unknown key, it errors. If a decision's condition is malformed, it can't evaluate.

### 3. `de-work` (the compiler)

**What it does:** Watches for objectives (goals the DE should pursue) and compiles the SOP into work.

**Where it lives:** `supabase/functions/de-work/index.ts` (same file as #1)

**How it works:**
- Listens for new `de_objectives` (from watchers — time-based, state-based)
- Finds the DE's published SOP
- Compiles the SOP's steps into `de_work_items`

**What can break:** If the SOP has malformed steps, the compilation fails silently. See RUNBOOK.md, "Debugging Production."

### Key difference: SOP vs. Procedure

- **SOP** (`kind='sop'`): steps are compiled into work items by `de-work`. The DE works them asynchronously.
- **Procedure** (`kind='procedure'`): steps are run synchronously by `playbook-execute`. A human or a timer starts the run.

An SOP is "do these things in your queue." A procedure is "execute this script right now."

---

## The Working Agreement

This is non-negotiable. It's in CLAUDE.md, but spelled out here for clarity:

### 1. Verify before completion

Never call something done without running it and reading the output. State plainly:
- What is proven (you ran it, it worked)
- What is inferred (the code is correct, but you didn't test this path)
- What was not checked (you didn't test with actual customer data)

### 2. Enumerate before acting

Search the whole surface, not the part you expect.
- If you're changing a RPC, grep for all call sites, not the ones you know about
- If you're renaming a column, check every table that references it
- If you're deprecating a field, find every client that reads it

### 3. Honesty over reassurance

Report failures with their output. Say when a step was skipped. Correct your own claims when they turn out wrong.

Don't say "I tested the new endpoint" if you only tested it in a happy path. Say "I tested it with valid input; I didn't test invalid input."

### 4. Commit the migration before applying it

An applied-but-uncommitted migration is the worst state. The effect is permanent, the source is one `rm` from gone, and a rebuilt environment differs silently.

```bash
git add supabase/migrations/NNN_name.sql
git commit -m "…"
npm run migrate:next --sql supabase/migrations/NNN_name.sql
```

### 5. No brainstorming on scoped work

If the task names its own target ("fix the deep link", "add the trust dial"), go straight to the work. Enumerate the surface, do it, report honestly.

Brainstorming is for open questions ("how should we price this?" "what should the onboarding flow look like?"). It's not for "implement X" — that's already decided.

---

## Common Tasks

### Running a migration

```bash
# 1. Write the migration (or ask for help)
# 2. Commit it
git add supabase/migrations/NNN_name.sql
git commit -m "…"

# 3. Apply it
npm run migrate:next -- supabase/migrations/NNN_name.sql
```

See RUNBOOK.md for the full flow.

### Deploying an edge function

```bash
# 1. Make changes to supabase/functions/<name>/index.ts
# 2. Test locally (if possible)
# 3. Commit
git add supabase/functions/<name>/
git commit -m "…"

# 4. Rebase to be up-to-date with main
git rebase origin/main

# 5. Deploy
node scripts/deploy.mjs --fn <name>
```

See RUNBOOK.md for the full flow.

### Making a frontend change

```bash
# 1. Edit src/ files
# 2. Run locally to verify
npm run dev
# (navigate to the page, test the feature)

# 3. Commit
git add src/
git commit -m "…"

# 4. Push
git push origin <branch>

# 5. Open a PR (if it's a significant change)
gh pr create --base main --head <branch>
```

The frontend deploys automatically on git push (Vercel integration).

### Debugging a production error

1. **Check the audit log** (most recent hour):
   ```bash
   npm run db:query "
     select created_at, action, entity_table, entity_id, detail
     from public.audit_log
     where created_at > now() - interval '1 hour'
     order by created_at desc
     limit 50
   "
   ```

2. **Check the relevant table**:
   ```bash
   npm run db:query "
     select * from public.<table>
     where <filter_matching_the_error>
   "
   ```

3. **Check edge function logs** in the Supabase dashboard, or:
   ```bash
   npx supabase functions list --project-ref rfsvmhcqeiyrxivbmpel
   ```

4. **If it's a data issue**, write a fix as a new migration (see RUNBOOK.md, "Incident Response").

### Reading the memory system

The team maintains institutional knowledge in `.claude/projects/D--Dream-Team-AI/memory/`. Key files:

- **MEMORY.md** — the index. Start here. One-line summaries of everything.
- **project_playbook_definitions_three_readers.md** — why `playbook_definitions` has two formats
- **project_de_machinery_learnings.md** — how the DE engines actually work (not theory)
- **feedback_enumeration_before_acting.md** — how to search for call sites and avoid surprises

These are living documents. They record decisions, blockers, and what was learned by failing. They're more reliable than code comments because they're updated when context changes.

---

## Your First Task

Pick something small:

1. **A typo fix.** Find a typo in the UI or docs, fix it, commit it, open a PR.
2. **A docs update.** Rewrite something that confused you when you read it, make it clearer.
3. **A small bug.** Pick a GitHub issue labeled "good first issue" if they exist, otherwise ask the founder.

This teaches you the commit/test/PR flow without shipping something fragile.

---

## When you get stuck

1. **Check RUNBOOK.md.** It has playbooks for common failures.
2. **Check ARCHITECTURE.md.** It explains decisions and trade-offs.
3. **Grep the memory files** in `.claude/projects/D--Dream-Team-AI/memory/`. The thing that's broken has probably happened before.
4. **Ask the founder.** If something is unclear, ask. The working agreement values honesty over guessing.

Welcome.
