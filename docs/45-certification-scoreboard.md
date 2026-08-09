# 45 — Certification scoreboard

**A living ledger, not a report.** Every row is an invariant with a probe that
re-runs on demand. A report is a photograph and rots (the DR doc said "no
backups" for weeks after backups existed); this re-derives its verdict from the
live system every time `npm run certify` runs.

- **Baseline:** tag `review-baseline-20260809` @ `bc86388`, census in
  `supabase/baseline/review-baseline.json`. Diff against it to see what moved.
- **Run:** `npm run certify` (full, ~3 min) · `npm run certify:fast` (~60 s) ·
  `npm run certify:mutation` (proves the probes can fail).
- **Re-pin, deliberately only:** `--pin-allowlist` after an intended perimeter
  change · `--pin-edge` after fixing edge-function type errors, to lock the gain
  in. Both ratchets move one way; re-pinning after an *accidental* change
  blesses it.
- **Status vocabulary:** **PROVEN** — a probe asserts it and the probe is
  mutation-tested to fail when violated. **UNPROVEN** — believed, no standing
  probe yet. **FALSIFIED** — a probe found it broken (fix in flight).

Effort follows blast radius: **Ring 0** (must never happen) → **Ring 1** (costs
money/reputation) → **Ring 2** (costs correctness) → **Ring 3** (polish).

---

## Ring 0 — must never happen

| # | Invariant | Status | Probe |
|---|---|---|---|
| R0.1 | Every `public` table has RLS enabled | **PROVEN** | `certify` › rls-on-every-public-table |
| R0.2 | No cross-tenant WRITE reachable by a client role | **PROVEN (fixed today)** | `knowledge-acl-invariants` + perimeter allowlist |
| R0.3 | Nothing that speaks in public is auto-executable (destructive floor) | **PROVEN** | `certify` › no-unattended-public-speech |
| R0.4 | Money moves only through `amount_cents` (else every money gate disarms) | **PROVEN** | `certify` › money-param-is-amount_cents |
| R0.5 | The approvals guard (`app.allow_task_decision`) has no new setter | **PROVEN** | `certify` › guard-bypass-setters-pinned |
| R0.6 | The audit hash-chain is intact for outsourcetel-hq | **PROVEN** | `certify` › audit-chain-verifies-hq |
| R0.7 | The `anon`/`authenticated` EXECUTE surface equals the pinned allowlist | **PROVEN** | `certify` › execute-perimeter |
| R0.8 | Tenant isolation on READ, probed with real ids across all RPCs | **UNPROVEN** | owed — `tenant-isolation` covers policies, not every RPC path |

## Ring 1 — costs money or reputation

| # | Invariant | Status | Probe |
|---|---|---|---|
| R1.1 | Every active template action is actually bound (approve → something runs) | **PROVEN** | `certify` › active-template-actions-are-bound |
| R1.2 | No template ships a silent-success op (search w/o query, list w/ query, get w/o ref, frozen date, stale test_op) | **PROVEN** | `certify` › template-op-contract-classes |
| R1.3 | The two shared contracts (browser/edge) never drift | **PROVEN** | `contract-parity` |
| R1.4 | No writer reports failure inside an HTTP 200 unchecked | **PARTIAL** | TikTok `success_when` proven; general sweep owed |
| R1.5 | No NEW unpinned-`search_path` SECURITY DEFINER function (9 legacy accepted) | **PROVEN (ratchet)** | `certify` › secdef-search-path-ratchet |
| R1.6 | Schema backup rebuilds production exactly | **PROVEN** | `npm run restore:drill` |
| R1.7 | **Data** restore loads back and the app works | **UNPROVEN** | owed — never drilled |
| R1.8 | Supabase managed physical restore works | **UNPROVEN** | cannot drill without a 2nd project (founder call) |
| R1.9 | Migrations replay from zero on an empty DB | **PARTIAL** | baseline rebuilds FK chain; full 656-replay not proven |

## Ring 2 — costs correctness

| # | Invariant | Status | Probe |
|---|---|---|---|
| R2.1 | Migration ledger matches the repo (no DRIFTED/ORPHANED) | **PROVEN** | `certify` › migration-ledger |
| R2.2 | Role-gated UI: every control's gate matches its RPC+RLS | **PROVEN** | `npm run audit:role-gates` |
| R2.3 | No silent `{ok:false}`/HTTP-200 refusal dropped at a call site | **PROVEN** | `npm run audit:silent-refusals` |
| R2.4 | Design system: no token/drift regression | **PROVEN** | `scripts/design-drift.mjs` |
| R2.7 | Every edge function type-checks, and can only improve | **PROVEN (ratchet)** | `certify` › edge-typecheck |
| R2.5 | The core loop closes end-to-end (hire→…→trust) | **PROVEN** | `npm run golden-path`, 10/10 — inside `certify` |
| R2.6 | Dev can actually run the product (no silent drift) | **PROVEN** | `npm run dev:sync:check` + golden-path in `certify` |

---

## The Golden Path, and what it found on its first run

`npm run golden-path` is the product as an **executable trace**: signup → hire →
equip → intake → escalate → **human decides** → gate → evidence → trust. Every
step asserts an *observable consequence*, not a return code. It runs against dev
through the real public signup path — never a forged `auth.users` row.

**RESOLVED 2026-08-09 — the loop now closes, 10/10, and is wired into
`certify`.** The two verdicts that matter come back right: a destructive action
for an untrusted employee resolves `human_gated_destructive`, and a *safe*
action does **not** hit the destructive floor (`human_gated_trust`). A gate that
refuses everything is as broken as one that permits everything; both halves are
proven, on a live database, through the real public signup path.

The rest of this section is kept as the record of what was wrong, because the
*shape* of it recurs.

**Original result: 2 of 10 steps proven. 8 CANNOT BE PROVEN — not because the
product was broken, but because the dev project could not run the product.**

| | dev | production | gap |
|---|---|---|---|
| routines | 779 | 881 | **−102** |
| tables | 266 | 284 | **−18** |
| policies | 350 | 387 | **−37** |
| **migration ledger rows** | **0** | 657 | **dev tracks nothing** |

Concretely, dev cannot:

- **Hire.** `role_archetypes` is **empty**. The product's first step is
  impossible there, so nothing downstream can run.
- **Escalate.** `open_de_escalation` **does not exist** — the human seam, which
  is the entire product thesis, cannot be exercised.
- **Prove the guardrail.** Dev carries **two** overloads of
  `decide_action_execution` (a 4-arg legacy and a 7-arg), production has one
  8-arg version *with `p_content`* — the parameter the guardrail scan reads. The
  duplicate-overload trap that caused a cron outage in migration 562 is sitting
  in the test environment right now.

**Why this matters more than any single bug.** There is currently **no
environment anywhere in which the core loop can be verified before it reaches
customers.** The behavioural tests that pass are running against a system 102
routines behind production, and dev has *no ledger*, so the drift is invisible
and unbounded — nothing would ever have reported it. `certify` is green because
its Ring-0 probes read production directly; the *write paths* have no
pre-production proof at all.

### How it was closed — and four things an "idempotent" schema file cannot do

`npm run dev:sync` converges dev on production **non-destructively** (dev's 185
users and 190 test tenants survive; `full_schema.sql` explicitly cannot restore
accounts, so a drop-and-rebuild would have destroyed them permanently).

The file *is* genuinely idempotent — 284 `CREATE TABLE IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS` before every create, FKs
wrapped in `duplicate_object`-swallowing `DO` blocks — and it **still could not
converge dev on its own**. Worth remembering, because the instinct is to trust it:

1. **Columns on tables that already exist.** 70 missing across 16 tables,
   including `human_tasks.disposition` and 19 columns of `profiles`.
2. **CHECK constraints on tables that already exist.** Dev still enforced the
   pre-574 category list and *rejected every ads/social template*. A stale CHECK
   is worse than a missing column — it actively refuses rows that are valid
   upstream. Re-added `NOT VALID` so historical test data doesn't block the rule.
3. **Constraints production has RETIRED.** The file can create and replace; it
   can never *remove*. 24 dropped, including the one above.
4. **Return-type changes.** `CREATE OR REPLACE` cannot widen a `RETURNS TABLE`.

And the sync itself briefly **recreated the migration-562 trap**: applying
production's definitions over older dev copies with *different argument lists*
left both, so `decide_action_execution` had three overloads and every call
failed `42725 is not unique`. **A sync that adds without removing manufactures
ambiguity.**

Dev now carries a migration ledger (657 rows) and `migrate:status --dev` reports
zero drift. The golden path runs inside `certify`, so if dev falls behind again
the loop stops closing and the bar goes red — which is how this should have been
caught the first time.

## The spine — is there a product?

| Metric | Value | Note |
|---|---|---|
| **Approve-clean rate** | **UNMEASURABLE — n=1, needs 20** | `npm run benchmark`. Two reasons, neither "the metric is broken" — see below. |
| Escalation (30d) | 151 escalated / 149 resolved | `activity_events`; ~50% — the dominant *cost*, and the real efficiency metric |
| Completion (30d) | 641 created / 22 decided | the completion gap, unchanged |

### Why the spine number is still unknown — and it is not the metric's fault

**1. No draft has ever been decided.** Of 32 decided `human_tasks`, **20 were
`action_approval`** — a yes/no gate on an action, which has *no text to edit*.
Counting those as "approved clean" would inflate the rate with decisions that
contained no draft at all, which is the easiest way to make this number lie. The
harness therefore counts only draft-shaped work — and **62 of those
(58 `inquiry_review` + 4 `knowledge_revision`) are sitting PENDING**.

> The rate is not broken. It is **unsampled**. Decide ~20 drafts and it appears.

**2. The support path destroys its own denominator.** `approve_draft_reply`
overwrites `de_messages.delivery` from `draft_pending` to `sent`, so a message
that *was* a draft is indistinguishable from one that never was. 905 sent, zero
recoverable as approved-untouched; only the **2 edits** survive in
`de_learning_edits`. A metric whose numerator is recorded and whose denominator
is erased can only ever look bad, and cannot be trusted in either direction.
**Fix is a product change** — stop erasing the fact that a draft existed —
deliberately flagged rather than quietly patched.

**Two rules the harness will not break.** It measures the *work*, never an exam
(a metric that scores the test instead of the job always closes its own loop and
always looks good — this codebase has been bitten by exactly that). And it
**refuses to publish a rate below n=20**: three samples is not 67%, it is noise
wearing a percentage sign, and a number in a slide deck outlives every caveat
attached to it.

Samples accumulate in `benchmark_samples` (migration 637), one row per run, so
the curve survives changes to the underlying tables. A curve you can recompute
retroactively is a curve you can talk yourself into. `npm run benchmark:history`.

---

## What today's Ring-0 pass already found and fixed

- **Six cross-tenant write holes** (mig 636). `upsert_external_ticket/contact/
  opportunity/ar_record`, `resolve_external_account`, `install_role_watchers` —
  all SECURITY DEFINER, all `authenticated`-executable, all taking the target
  tenant as a *parameter*. Any signed-up user could write into any workspace.
  Same class as mig 610; created in 607/608 and missed. Revoked; ingest
  (service-role) unaffected. **This is the review paying for itself on day one.**
- **A drifted + an orphaned migration** — the 580↔581 collision left the ledger
  inconsistent and a restored-then-re-deleted file orphaned. Reconciled.

Every probe above is **mutation-tested** (`certify:mutation`): each was shown to
return rows when its violation is injected and none when it is not. A gate that
cannot fail is theater, and this codebase has shipped that before.
