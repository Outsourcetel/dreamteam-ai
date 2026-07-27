# 35 — The direct-write census

**Status:** completed audit, 2026-07-28. Measured against the live database and
`src/`, not against intent.
**Why it exists:** the permission matrix (`docs/32`) audited 106 RPCs. Nobody had
ever swept the paths that **bypass functions entirely** — a client writing
straight to a table through PostgREST, where no `SECURITY DEFINER` guard can
reach. Prompted by finding three such paths on `human_tasks` that could decide
an already-decided task.

---

## Method

Parsed every `.from('table')` in `src/` and looked ahead for the first terminal
operation, keeping only `update` / `insert` / `upsert` / `delete`. Then
cross-referenced each table against `pg_policy` and `has_table_privilege`.

**93 write sites across 38 tables.**

The classification that matters is not "does the client write this" — it is
**what actually bounds the write**: a permissive policy alone (tenant), a role
gate, a DE scope, or nothing but the absence of a permissive policy.

---

## Finding 1 — two tables with a `de_id` and no scoping on the write ✅ FIXED

Migration 465. The same class migration 452 closed for `human_tasks` /
`de_conversations` / `draft_responses`.

| table | rows | `de_id` | what a member could do |
|---|---|---|---|
| `de_playbook_charter` | 35 | NOT NULL | bind, unbind or deactivate the charter of **any** employee — changing what it is instructed to do. `check_de_retirement_readiness` counts active bindings as a retirement blocker, so it also moves another employee's lifecycle. |
| `widget_keys` | 8 | nullable | repoint a **live customer-facing widget** at a different employee, or switch it off |

Not exploitable today — every live user is owner or admin, both of whom pass
`can_access_de` unconditionally. Same "ships dark, becomes real on the first
assignment" position as the rest of the wave.

Fixed with the mig-452 shape: restrictive `FOR ALL`, `USING` + `WITH CHECK`,
null-tolerant to match mig 386. `WITH CHECK` matters as much as `USING` —
without it a member could take a row they may touch and **reassign** its `de_id`
to an employee they may not.

## Finding 2 — 36 tables carry `anon` write grants ⚠ DEBT, NOT A HOLE

`has_table_privilege('anon', …, 'UPDATE')` is true on 36 of the 38.

**I checked the policies rather than reporting the grant.** Every permissive
write policy on those tables requires either `auth.uid()` matching a `profiles`
row or `auth_tenant_id()` — both NULL for `anon`. **RLS denies all of them.**
The grants are inert.

This is Supabase's default privileges granting new public tables to `anon` and
`authenticated` on creation. It is the same latent shape as migration 457 (where
my own new table arrived with `INSERT` already granted, caught only by an
adversarial assertion) and the seven workbench tables the audit stream reviewed
— now measured at 36-table scale.

**Why it still matters:** the safety rests on something being *absent* — no
permissive policy admitting a null-auth caller. The day someone adds one for an
unrelated reason, the grant is already there. Recommended follow-up is a single
housekeeping migration stripping write grants from `anon` across the set.

## Finding 3 — 23 tables are client-writable on tenant-only policies ✅ MOSTLY BY DESIGN

Listed below for the record. **This is largely correct, not a defect** — a
workspace member editing their own workspace's data is the product working.
Narrowing it is a product decision, not a bug fix, and doing it reflexively
would break ordinary use.

`activity_events`, `audit_logs`, `connector_actions`, `connector_objects`,
`customer_accounts`, `de_playbook_charter`*, `de_profile_fields`, `escalations`,
`golden_qa`, `health_score_config`, `knowledge_collections`, `knowledge_docs`,
`media_assets`, `onboarding_templates`, `opportunities`, `playbook_event_rules`,
`playbook_schedules`, `renewal_invoices`, `specialist_sources`,
`support_tickets`, `tenant_entity_fields`, `tenant_outcome_pricing`,
`widget_keys`* — *\*now DE-scoped by mig 465.*

Two worth a second look, neither urgent:

- **`audit_logs`** accepts client `INSERT` on a tenant-only policy (3 rows). It
  is append-only from the client — no `UPDATE`/`DELETE` policy — so nobody can
  alter history, and it is a *different* table from the hash-chained
  `audit_events` that GI-2 locked down. Question is whether it is used at all,
  not whether it is dangerous.
- **`renewal_invoices`** and **`opportunities`** carry money and pipeline state
  on tenant-only writes. Correct for a workspace where every member is trusted;
  worth revisiting when scoped roles are common.

## Finding 4 — `de_deployment_stages` writes rely on default-deny

Grant exists, no permissive write policy, so Postgres refuses. Works, but the
protection is the *absence* of a policy rather than the presence of a rule —
Finding 2's shape in a single table.

---

## ⚠ Finding 5 — an unrelated production problem, found by being blocked

Migration 465 timed out on `DROP POLICY`. The cause was not the migration:

> **PostgREST connection pid 3320955, `idle in transaction` for 16 h 55 m.**

It held `AccessShareLock` on `de_playbook_charter`, `customer_accounts`,
`opportunities`, `playbook_definitions` and their indexes, so any `ALTER`/`DROP`
on those tables — mine, or anyone's — could not acquire `AccessExclusiveLock`.

Worse than the blockage: it **pinned the xmin horizon** at `backend_xmin
432665`, so `VACUUM` could not reclaim any newer row version **anywhere in the
database** for nearly 17 hours. Continuous bloat across every table, invisible.

Terminated on founder instruction. Confirmed afterwards: `oldest_xmin_age` back
to `0`, zero connections idle in transaction, mig 465 applied cleanly.

**Worth a monitor.** Nothing detected this, and nothing would have — it does not
error, it does not appear in `ops_alerts`, and its only symptom was a migration
timing out on an unrelated table. A check for `state = 'idle in transaction' AND
now() - state_change > 5 minutes` is a few lines and would have caught it in
minutes rather than by accident 17 hours later.

---

## What this changes about how to audit

The RPC matrix was the right audit and it was **structurally incomplete**: a
`SECURITY DEFINER` guard cannot protect a table the client writes to directly.
Both are needed, and they find different things.

It also produced the day's clearest rule, from the audit stream:

> **RLS answers WHO, never HOW MANY TIMES.**

A restrictive `FOR ALL` policy reads like it covers everything a direct write
could get wrong. It does not — *"only if still pending"* is a `WHERE` clause,
not a policy. Scoping and idempotency are different properties, and RLS can
express only the first. That distinction is what made the three `human_tasks`
paths look safe when they were not.
