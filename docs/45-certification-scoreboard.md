# 45 — Certification scoreboard

**A living ledger, not a report.** Every row is an invariant with a probe that
re-runs on demand. A report is a photograph and rots (the DR doc said "no
backups" for weeks after backups existed); this re-derives its verdict from the
live system every time `npm run certify` runs.

- **Baseline:** tag `review-baseline-20260809` @ `bc86388`, census in
  `supabase/baseline/review-baseline.json`. Diff against it to see what moved.
- **Run:** `npm run certify` (full, ~2 min) · `npm run certify:fast` (~40 s) ·
  `npm run certify:mutation` (proves the probes can fail).
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
| R2.5 | The core loop closes end-to-end (hire→…→trust) | **UNPROVABLE HERE** | `npm run golden-path` — built; the dev project cannot run it (see below) |

---

## The Golden Path, and what it found on its first run

`npm run golden-path` is the product as an **executable trace**: signup → hire →
equip → intake → escalate → **human decides** → gate → evidence → trust. Every
step asserts an *observable consequence*, not a return code. It runs against dev
through the real public signup path — never a forged `auth.users` row.

**Result: 2 of 10 steps proven. 8 CANNOT BE PROVEN — not because the product is
broken, but because the dev project cannot run the product.**

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

This is a **Ring-1 environment defect** and it is the highest-leverage fix
available: it is the difference between a review that certifies today and a
system that stays certified. Options, cheapest first: seed `role_archetypes` and
sync the missing routines to dev; or rebuild dev from `full_schema.sql` (the
restore drill already proves that file reproduces production exactly) and give
dev a migration ledger so it can never silently drift again.

## The spine — is there a product?

| Metric | Value | Note |
|---|---|---|
| **Approve-clean rate** | **UNMEASURABLE from history** | `draft_responses` is empty (0 rows ever); `de_learning_edits` = 2 all-time; 905 messages all `sent`. The capture instrument was never populated, so the single most important number cannot be read from the past. **The Benchmark must generate it forward.** |
| Escalation (30d) | 151 escalated / 149 resolved | `activity_events`; ~50% — the dominant *cost*, and the real efficiency metric |
| Completion (30d) | 641 created / 22 decided | the [[project_queue_self_amplification]] gap, unchanged |

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
