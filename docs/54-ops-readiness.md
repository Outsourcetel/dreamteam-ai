# 54 — Workstream E: operational readiness (2026-08-17)

**Question E answers:** if production broke tonight, could we recover — and would anyone know?
Everything below is measured against live production today, not read from a document.

## 1. Backups — HEALTHIER than the debt map says

Verified live against the Supabase Management API (`/database/backups`), not the dashboard:

```
walg_enabled: true      pitr_enabled: false
7 backups, ALL COMPLETED, 2026-08-11 … 2026-08-17 — no gaps
```

**Debt-map finding #70 ("no automated backups, only a 14-day-old export") is STALE and should be
retired.** It was true on the free plan; the org is on Pro and daily physical backups run. The
chain is also cleaner than docs/DISASTER_RECOVERY.md recorded on 08-05 (which had a missing
08-02 snapshot); today's 7-day window is unbroken.

## 2. What is still genuinely at risk

| Gap | Measured today | Consequence |
|---|---|---|
| **PITR off** | `pitr_enabled: false` | Up to **24h** of data loss. A bad migration at 14:32 cannot be rewound to 14:31 — you restore the whole DB to the last daily snapshot. ~$100/mo closes it. **Founder purchase decision.** |
| **A restore has never been performed** | no record, anywhere | The backup is a *belief*. Every property of a restore — that it completes, how long it takes, what it loses — is untested. |
| Local data export stale | last full export **2026-07-26 = 22 days** | Secondary artifact only; the physical backups are the real control. Since that export: 165 conversations, 340 messages, 133 human decisions, 15 employees, **31,484 audit events**. |
| Schema baseline stale | `full_schema.sql` cut 08-09; **119 migrations applied since** | Rebuild-from-baseline lands 119 behind. Mitigated: **all 777 ledger entries have a tracked source file in git** (register B-10 is satisfied), so replay is possible. One untracked migration exists (754) but is **not applied** — the safe state. |

## 3. NEW DEFECT — a scheduled job has been failing every 30 minutes for a week (register **B-11**)

```
reconcile-blocked-goals-30min — 245 failed runs in 7 days, 48 in the last 24h
ERROR: new row for relation "de_objectives" violates check constraint
       "de_objectives_attention_flag_check"
```

Root cause, confirmed by reading both sides rather than inferring:

* the CHECK permits `stalled | waiting_too_long | wake_spin | steps_failed` (or NULL)
* `reconcile_blocked_goals` line 51 writes **`wait_unanswered`** — not in that list

Two lists that must agree, and nothing checks that they do. **No blocked objective has been
reconciled since 2026-08-05.** The oldest victim is on outsourcetel-hq: the Account Success DE's
"Daily onboarding progress review", blocked since 08-04.

## 4. NEW DEFECT — the alarm is wired to a lamp nobody watches (register **C-8**)

`ops_alerts` has exactly **one** consumer in the entire codebase: `OpsAlertsBanner.tsx`, an in-app
banner. No push. No email. **133 alerts unresolved** (287 resolved), and **77 of them are
`de_objective_wake_spin` — the downstream symptom of B-11 — firing continuously since 2026-07-29.**

A condition has been alarming for **20 days** in a product whose push channel *works* (proven live
in Workstream B: the founder's phone receives approval pings). Approvals reach the pocket;
failures reach a banner.

## 5. Monitoring that IS working

* **Sentry** is configured (`VITE_SENTRY_DSN`) and receives frontend errors.
* **Cron is healthy in aggregate:** 5,082 succeeded vs 48 failed in 24h — and every one of those
  48 is B-11. 53 of 54 jobs active.
* `edge_function_error` alerts: 23, but all from a burst on 08-04/05 — stopped since.

## 6. The one state-changing step — FOUNDER DECISION OWED

`scripts/restore-drill.mjs` proves the **schema** restores: it rebuilds `full_schema.sql` into a
throwaway schema **on the dev project**, diffs it object-for-object against production, and drops
it. It found six real defects the first time it ran. It does **not** touch production and does
**not** prove a *data* restore.

Two separate decisions:

1. **Run the schema drill** (low risk: dev-only, self-cleaning, ~minutes). Recommended — it is the
   cheapest proof available that the repo can rebuild the schema, and it is currently 119
   migrations out of date.
2. **Prove a real data restore** (high value, real cost): restore yesterday's physical backup into
   a *new throwaway Supabase project*, confirm row counts and that the app boots against it, then
   delete it. This is the only thing that converts "we have backups" into "we can recover."
   Never against production. Needs founder go-ahead on spend and timing.

## Verdict

**Recovery posture: better than recorded, still unproven.** The backups are real and running —
that is the good news the debt map missed. But the control has never been exercised, the loss
window is a full day, and the two defects above show the deeper problem: **this system fails
quietly.** A job died 245 times and an alarm rang 77 times, and both went unseen for three weeks,
because nothing carries a failure to a human the way it carries an approval.
