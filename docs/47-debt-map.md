# 47 — The technical debt map

**Commissioned because the founder did not trust the structure.** That is the
right instinct to act on, and this is the answer: 86 findings, **every one
MEASURED** — each carries the command or query that produced it and its actual
output. Nothing here is an impression.

**Method.** Nine dimensions examined in parallel (the giant files, duplication,
schema, routines, UI, tests, dependencies, infrastructure, documentation), then
three adversarial passes over the results: a skeptic instructed to *refute* the
highest-impact claims, an operator asked what actually costs money this month,
and a completeness critic hunting what the nine dimensions structurally could
not see. **14 claims did not survive** — they are listed at the bottom, because
what a review got wrong is evidence about the review.

**Scoring.** `Priority = (Impact + Risk) × (6 − Effort)`, each 1–5.

---

## 0. A correction that comes first

I have reported **"certify 9/9 green"** many times. Two of those nine sections
cannot turn red:

```
audit-role-gates.mjs:971      if (STRICT && (findings.length || navGaps.length)) process.exit(1);
audit-silent-refusals.mjs:245 if (STRICT && (bad.length || swallows.length))     process.exit(1);
package.json:24-25            "audit:role-gates":      "node scripts/audit-role-gates.mjs"      ← no --strict
                              "audit:silent-refusals": "node scripts/audit-silent-refusals.mjs" ← no --strict
```

`certify` grades a section on its exit code. Both scripts exit 0 regardless of
what they find. A third — `golden-path` — exits on `failed === 0` alone
(`golden-path.mjs:337`), so it can print *"GOLDEN PATH INCOMPLETE — 8/10
proven"* and still report **PASS**.

Both audits are clean today, so this is a latent false-green, not a live lie.
It is still the exact failure this repo's own commit messages call theatre.
**Three one-line fixes.**

---

## The ten that matter

| # | Finding | Cat | I/R/E | Score |
|---|---|---|---|---|
| 1 | **The verification apparatus is manual-only.** CI runs 4 commands — 3 of 10 test files, none of the 11 production probes. 855 commits in 30 days; `certify-last.json` committed 15 times. | infra | 5/5/2 | **40** |
| 2 | **The deploy runbook is wrong on three concrete points** and tells you to rebuild a script that already exists. It was written *because* deploy knowledge lived in one head. | docs | 4/4/1 | **40** |
| 3 | **No front door.** 140 docs, no README index. The numbering invites a newcomer to start at the four most stale documents. | docs | 5/4/2 | **36** |
| 4 | **`certify` is not in CI.** The gate that catches real regressions runs in under 3 minutes and fires only when a human types it, on a laptop holding production credentials. | infra | 4/4/2 | **32** |
| 5 | **The documented one-command deploy cannot apply migrations.** Both runners call `exec_sql`, which exists in no schema. Verified: `to_regclass('public._supabase_migrations')` is null too. | infra | 4/4/2 | **32** |
| 6 | **The action gate has no test** — the permission boundary that decides what an employee may do is guarded only by a manual production probe. The marketing-employee-can-hire-staff bug had nothing to catch its return. | test | 5/5/3 | **30** |
| 7 | **Node 20 is 101 days past end-of-life** in CI and the declared floor. Any new vulnerability is simply never patched. One line in two files. | infra | 2/4/1 | **30** |
| 8 | **The repo has a security gate that fails today and nothing runs it.** The alarm was built and never wired to a bell. | infra | 3/3/1 | **30** |
| 9 | **Two offline test files are excluded from CI** — 21 assertions, 1.8 s, no credentials — including the only guard on the browser/edge twin copies. | test | 3/3/1 | **30** |
| 10 | **The 4-method adapter contract is honoured 280 times and declared nowhere.** `connector-hub` types its dispatch map `Record<string, any>`, and `tsconfig.json` excludes `supabase/` entirely. | arch | 3/4/2 | **28** |

### A live defect, found by asking the question backwards

Every previous audit checked *schema → code*. Nobody checked *code → schema*.
Doing so found **`media_assets` is dropped in production** — `to_regclass`
returns null — with **three live callers**: `playbookBuilderApi.ts:976` (an
INSERT that runs *after* a successful file upload), `:996`, and
`playbook-execute/index.ts:2132`.

Migration `611_the_specialist_role_is_retired.sql:216` dropped it as a
"specialist-only table", justified in its own header by **row count: 0**. But
migration `031_playbook_document.sql:48` had repurposed that table for playbook
media 580 migrations earlier. The rows were zero because the feature was
**unused, not dead**.

Effect: a Playbook Builder document upload stores the file, then throws
PGRST205 and orphans it. `storage.objects` is empty, so nobody has hit it yet.
**Validated on rows instead of on callers** — the precise trap this repo's
history keeps warning about.

### Where the money actually goes

- **37.3% of all production database CPU is one cron job** —
  `detect_de_incidents_internal()`, 8,304 calls / 4.34 hours of execution, which
  has produced **76 rows in its entire life**. It runs every 5 minutes.
- **A further 11.5%** is two pollers repeatedly asking a 5,035-row table whether
  there is anything to embed. 20,496 calls, ~1.2 hours.
- **10 of 13 active tenants carry an AI budget of ~3 model calls per month**
  (10,000 tokens against an observed 1,370–4,461 per call).

Half the database's work is a question nobody needed answered.

---

## What is actually healthy

A debt map that finds debt everywhere is a map of the mapper. Checked and sound:

- **The adapter layer is cohesive, not a pile.** 70 of 74 provider adapters
  implement exactly the same four methods — `test`/`search`/`fetchRecord`/
  `listRecent`, 280 implementations, zero deviation. 2,894 of connector-hub's
  7,375 lines are these, and they belong together.
- **Parameter counts are healthy.** Across 7,802 functions, 99.4% take three or
  fewer. The 16-parameter `dispatchTool` I wrote today is an outlier, not the
  house style — though `runLoop` at 17 is worse, and neither should exist.
- **The browser/edge category contract has not drifted** — 27 ops, identical on
  both sides, despite being kept in sync only by a comment.
- **The RLS write surface has no fail-open policy.** Zero permissive INSERT
  policies to public/anon with a null or `true` check.
- **Backups are running.** 6 completed daily physical backups, newest today.
- **`playbook-execute`'s dispatch is complete** — all 19 primitives, median case
  ~37 lines.

## What the adversarial passes refuted

Listed because a review's errors are evidence about the review:

- ~~"No lockfile, dependencies resolve fresh at every deploy"~~ — `deno.lock` is
  tracked, version 5, updated today.
- ~~"No automated backups"~~ — 6 completed physical backups, daily at ~03:25 UTC.
- ~~"The app ships as one 2.1 MB JavaScript file"~~ — measured from a stale local
  `dist/` that git does not track. The conclusion survived only via an
  independent live fetch.
- ~~"Branch steps are *silently* skipped"~~ — the skip sets an explicit
  `status: 'skipped'` with a reason, persisted to `playbook_runs.steps`; and only
  2 of 100 definitions branch at all, so it has never fired.
- ~~"AI token spend is a lever"~~ — 2,021 metered calls lifetime. It is not.
- ~~"`install_role_watchers` is dead"~~ — called from two migrations the audit
  did not treat as call sites.
- ~~"140 docs with no README"~~ — two substantive READMEs exist; the conclusion
  (no index) survives, the count did not.

---

## The plan — three phases, alongside feature work

**Phase 1 — one afternoon. Make the green mean something.**
Add `--strict` to both audit scripts in package.json. Fix `golden-path`'s exit to
`failed === 0 && cannotProve === 0`. Put `certify` in CI. Move CI and the engine
floor to Node 22. Add the two excluded offline test files. Wire the existing
security gate.
*Every item is one line. Together they convert a green tick from a habit into a
guarantee.*

**Phase 2 — a few days. Stop the bleeding that is already real.**
Restore `media_assets` or remove its three callers (a live upload path is broken
today). Fix the deploy runbook to describe the deploy that works. Write the
README front door. Throttle or retire `detect_de_incidents_internal` (37% of
database CPU for 76 rows). Raise the ten tenant AI budgets off ~3 calls/month.
Declare the adapter interface and type the dispatch map.

**Phase 3 — ongoing, alongside features. Structural.**
Split `LiveWorkforceDEs.tsx` — 3,649 of its 4,414 lines belong to the Employee
File page and share exactly **four lines** with the roster, so this is a move,
not a rewrite. Bring `supabase/` into `tsc`. Write the action-gate test. Reduce
`dispatchTool`'s 16 parameters to a context object.

**Not recommended:** a rewrite, a re-platform, or a mass refactor of the giant
files. The bulk in `connector-hub` and `playbook-execute` is *earned* — one
entry per connected system, one branch per step type. Cutting it up would move
risk, not remove it.
