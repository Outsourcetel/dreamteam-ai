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
| R2.5 | The core loop closes end-to-end (hire→…→trust) | **UNPROVEN** | Golden Path — building next |

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
