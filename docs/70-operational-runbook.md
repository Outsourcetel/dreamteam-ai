# 70 — Operational runbook: the five failures that actually happen

**Companion to `docs/INCIDENT-RESPONSE-RUNBOOK.md`, not a replacement.** That document handles a
**breach** — PHI determination, regulator clocks, counsel. This one handles the incidents this
platform has actually had. Register **D-14** named the gap: the existing runbook covers the
incident type that has never happened and not the ones that happen constantly.

Every mode below is a **real incident from this review**, with the query that detects it and the
fix that worked. Numbers are live as of 2026-08-19 so you can tell "normal" from "wrong".

> **Read this first.** Every one of these ran for days undetected — 13, 7 and 20 days
> respectively — not because detection was missing but because nothing carried the detection to a
> person (register C-8). Since mig 771 a new ops alert pings the same phone that receives
> approvals. **If an alert wakes you, this document is what it is asking you to do.**

## Healthy baseline (2026-08-19)

| Signal | Healthy | Today |
|---|---|---|
| Failed cron runs, 24h | 0 | **0** |
| Inactive cron jobs | 1 (`approved-action-driver-5min`, off by founder decision) | **1** |
| Worst connector consecutive failures | 0 | **8,177** ⚠ ERPNext, see §2 |
| Unresolved ops alerts | low tens | **109** ⚠ mostly §4 |
| Registered push devices | ≥1 | **1** |

---

## 1. A scheduled job is failing

**Symptom:** work stops finishing. Objectives stay blocked, nothing errors on screen.

**Detect**
```sql
select j.jobname, count(*) failures, max(d.return_message) last_error
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 where d.status = 'failed' and d.start_time > now() - interval '24 hours'
 group by j.jobname order by failures desc;
```

**The real one (B-11):** `reconcile-blocked-goals-30min` failed every 30 minutes for **13 days** —
245 failures — because `reconcile_blocked_goals` wrote `attention_flag = 'wait_unanswered'`, a
value its own CHECK constraint forbids. No blocked objective could unblock the whole time, which
is most of why 0 of 48 objectives had ever completed.

**Fix pattern:** read the constraint, then fix the *writer*, not the constraint —
```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = '<name from the error>';
```
Widening a CHECK to admit a value the code invented leaves two values meaning one thing. Migration
769 is the worked example.

**Verify:** re-run the function by hand and read its return, then confirm failures fall to zero.

---

## 2. A connector is dead and still being called

**Symptom:** none visible. The UI correctly shows "Not working"; nothing else says anything.

**Detect**
```sql
select provider, status, consecutive_failures, last_ok_at, last_error_at, left(last_error, 200)
  from connectors where consecutive_failures >= 3 order by consecutive_failures desc;
```

**The real one (B-13):** ERPNext returned `http_402` — the dev Frappe instance hit a payment wall —
and has now failed **8,177 consecutive times**. `connectors.status` still reads `connected`
because nothing writes it on failure; only the derived health is honest.

**Fix pattern:** since mig 774 a breaker suppresses dispatch after 10 failures within an hour, so
the retries stop by themselves. Restoring service is a **provider-side** action (billing, credential,
endpoint). The breaker is half-open: fix the provider and the next scheduled run recovers on its
own with no reset to remember.

**Verify:** `select public.connector_circuit_open(consecutive_failures, last_error_at) from connectors where provider = '<p>';`
→ `false` once healthy.

---

## 3. The LLM provider fails or fails over

**Symptom:** answers stop, or quality/latency changes without a deploy.

**Detect**
```sql
select model_id, count(*) calls, max(created_at) last_used
  from de_token_usage where created_at > now() - interval '2 hours' group by model_id;
```
A model_id you did not expect means the failover chain moved: `anthropic → bedrock → openai → google`.

**What matters beyond service:** a provider joins the chain the moment its key is set, and
**customer conversations then travel to it**. docs/62 §2 and the privacy policy name all four for
this reason. Do not add a key as a quick fix without accepting that disclosure consequence.

**Also check:** `select public.check_tenant_ai_budget('<tenant-uuid>');` — enforcement is armed on
all tenants, and an exhausted budget looks exactly like an outage from the outside.

---

## 4. Objectives spin without progress

**Symptom:** `de_objective_wake_spin` alerts, repeatedly, for the same objectives.

**Detect**
```sql
select o.id, o.title, o.status, o.attention_flag, o.wake_count
  from de_objectives o where o.status = 'blocked' order by o.wake_count desc limit 20;
```

**The real one:** **46 objectives are blocked right now**, across 6 employees, and the alerts are
**correct** — they are waking, finding nothing they may do without a human, and stopping again.

⚠ **Do not resolve these alerts to clear the board.** `resolve_cleared_ops_alerts` already runs
every 15 minutes inside `check_workforce_heartbeat`; anything still open is a condition that has
NOT cleared. Closing them by hand replaces a true signal with a false one.

**The actual fix is the decision queue** — these objectives are waiting on human decisions
(register B-12). Answering, or opening the trust ladder so routine acts stop asking, is what clears
them. Nothing in the runbook does.

---

## 5. Nothing is reaching your phone

**Symptom:** silence. The most dangerous mode, because it looks identical to "all well".

**Detect**
```sql
select count(*) from push_subscriptions;                       -- ≥1 expected
select count(*) from ops_alerts where resolved_at is null
   and created_at > now() - interval '24 hours';               -- did anything raise?
select status_code, left(content::text, 120) from net._http_response order by created desc limit 5;
```
A push attempt appears in `net._http_response` as a 200 from `push-send`. `{"sent":0,"note":"no
devices registered"}` means the alarm worked and had nowhere to ring.

**Fix pattern:** re-register the device by opening `/m` and allowing notifications. A device the
push service reports as gone (404/410) is **pruned automatically** — deliberately, so a dead phone
is not pinged forever — which means silence can mean your subscription was deleted.

**Prove the whole chain rather than assuming it:**
```sql
insert into ops_alerts (kind, message, detail)
values ('runbook_probe', 'Proving the alert path reaches a phone',
        jsonb_build_object('tenant_id', '<your-tenant-uuid>'));
-- then check net._http_response for the push-send 200, and resolve the probe:
update ops_alerts set resolved_at = now() where kind = 'runbook_probe';
```

---

## What this runbook deliberately does not cover

Breach handling, regulator notification and counsel — those live in
`docs/INCIDENT-RESPONSE-RUNBOOK.md`, whose §4 containment commands remain correct and are worth
keeping. Its 14 bracketed placeholders (every role `[name]`, every contact `[____]`) are still
unfilled, and that remains open under D-14: **the founder is currently every role in it.**
