# 52 — The `authenticated` write perimeter

**Status:** AUDIT + PROPOSAL. Nothing has been applied. No migration exists.
**Measured against production** (`rfsvmhcqeiyrxivbmpel`, PostgreSQL 17.6) on **2026-08-12**, read-only.
**Decision required from the founder** before any agent writes a migration.

---

## 0. The one-paragraph version

`authenticated` — the role every logged-in browser session runs as, and which
this repo's own note calls *"the internet"* (`security_authenticated_perimeter`,
mig 365) — holds **TRUNCATE on 245 of 294 public tables**, including
`playbook_versions`, the immutable published-playbook snapshots for every
tenant. **PostgreSQL does not apply RLS to TRUNCATE.** `playbook_versions` has
RLS enabled with exactly one policy (`playbook_versions_tenant_select`,
PERMISSIVE, SELECT) and no DML policy at all — so RLS blocks INSERT/UPDATE/DELETE
from `authenticated` and one TRUNCATE from the same role would destroy all 104
rows across all tenants without a policy ever being consulted.

**It is not reachable today.** Section 2 establishes that, with evidence. It is
latent, not live. But it is latent for a reason nobody wrote down and no gate
protects, and the default privileges are still handing it out to every new
table (Section 6). The honest framing is: *one added SECURITY INVOKER function
with dynamic SQL, or one new PostgREST capability, turns 245 latent holes live
at once, and nothing in `certify` would notice either the new function or the
grants.*

---

## 1. What was measured, and how

Every number in this document came from a query against production. The queries
are inline so the next agent can re-run them rather than trust this file.

```
node scripts/db-query.mjs --sql "select count(*) from information_schema.role_table_grants
  where table_schema='public' and grantee='authenticated' and privilege_type='TRUNCATE'"
→ 248
```

248 splits as **245 base tables + 3 views** (`eval_gate`, `pipeline_summary`,
`tenant_sso_effective_policy`). TRUNCATE on a view is inert in Postgres — you
cannot truncate a view — so the 3 are noise. Stating the split matters only
because 248 vs 245 otherwise reads like a miscount.

| Measurement | Value |
|---|---|
| Public relations, `relkind='r'` (base tables) | **294** |
| …with RLS enabled (`relrowsecurity`) | **294 (100%)** |
| …owned by `postgres` (so RLS is not owner-bypassed) | **294 (100%)** |
| …with `authenticated` TRUNCATE | **245** |
| …with `authenticated` INSERT / UPDATE / DELETE | 247 / 246 / 249 |
| …with at least one of I/U/D | **249** |
| …with none of I/U/D | 45 |
| RLS policies in `public` | 394 (390 name `authenticated` or `public`) |
| …PERMISSIVE / RESTRICTIVE | 367 / 27 |

Two catalogue facts that shape the whole analysis:

1. **Every public table has RLS on.** There is no "`relrowsecurity=false`, so the
   grant is live regardless of policies" tier. The brief anticipated one; it is
   empty, and that is a real (good) result, not an omission. `certify`'s
   `rls-on-every-public-table` Ring-0 probe is why.
2. **27 policies are RESTRICTIVE.** A RESTRICTIVE policy only subtracts; it can
   never permit a command. The first pass of this census counted them as
   coverage and classified 7 tables as "live" that are in fact blocked. Every
   number below uses `permissive='PERMISSIVE'` only. Naming the mistake because
   the same slip in the applying migration would produce the opposite error —
   keeping grants nobody can use.

### Cross-check that the census is complete

The three tiers plus the keep-set must exhaust the grant count, or something was
double-counted or dropped:

```
TIER B 469  +  TIER C 192  +  KEEP 81  =  742
INSERT 247  +  UPDATE 246  +  DELETE 249  =  742   ✓
```

---

## 2. Reachability verdict: **LATENT, not live**

> `authenticated` cannot issue TRUNCATE against this database today. The grant is
> real and the RLS bypass is real; what is missing is a path that gets a
> `TRUNCATE` statement executed under that role.

Six independent things had to be true, and all six were checked:

| # | Path | Result | Evidence |
|---|---|---|---|
| 1 | **Direct connection as `authenticated`** | Blocked | `pg_roles.rolcanlogin = false` for `authenticated` and `anon`. Only `authenticator` and `postgres` can log in. `authenticated` is a member of no other role (`pg_auth_members`), and holds no grant `WITH GRANT OPTION` (0 rows where `is_grantable='YES'`). |
| 2 | **PostgREST** | Blocked | PostgREST maps GET→SELECT, POST→INSERT, PATCH→UPDATE, PUT→upsert, DELETE→DELETE, POST /rpc→function call. It has no TRUNCATE verb. Note the asymmetry that makes this finding matter: an unfiltered PostgREST `DELETE` *is* possible and *is* stopped by RLS. TRUNCATE would not be. |
| 3 | **A SECURITY INVOKER function running dynamic SQL** — the path the brief asked about | **None exists** | 0 rows: functions in `public` with `prosecdef=false`, EXECUTE granted to `authenticated`, and `prosrc` matching `execute ` or `truncate`. |
| 4 | **A SECURITY DEFINER function coerced into emitting TRUNCATE** | None | 5 auth-executable functions use dynamic SQL: `export_tenant_manifest`, `export_tenant_table_page`, `list_de_system`, `read_de_system`, `tenant_rows_remaining`. All are read-only; all compose identifiers through `format('%I')`; all three that take a table name validate it against a catalogue or a hard-coded allowlist *before* composing (`export_tenant_surface()`; `ARRAY['customer_accounts','opportunities',…]`). Being SECURITY DEFINER they run as `postgres` anyway, so revoking `authenticated`'s TRUNCATE would not have helped had one been injectable — that is a separate class and it is clean. |
| 5 | **`TRUNCATE` anywhere in the database's own code** | 0 hits | No function body in `public`, `auth`, or `storage` contains the word, secdef or not. The single TRUNCATE trigger that exists is a *guard*: `audit_events_no_truncate_stmt` → `audit_events_no_truncate()`, which raises `'audit_events cannot be truncated — the record is append-only'`. |
| 6 | **`pg_cron` — schedule a job that runs as `authenticated`** | Blocked twice | `cron.schedule` *is* EXECUTE-granted to `authenticated` (pg_cron's own default). It is unreachable because `authenticated` has **no USAGE on schema `cron`** (`nspacl = {supabase_admin=UC, postgres=U*}`). And `cron.use_background_workers = off`, so pg_cron connects via libpq, which requires LOGIN — which `authenticated` does not have. |

Two more, checked because they are the usual escape hatches: **`dblink` is not
installed** (extensions present: hypopg, index_advisor, pg_cron, pg_net,
pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp, vector), and
**nothing in the repo opens a raw Postgres connection** — `src/supabase.ts` is
`createClient(SUPABASE_URL, SUPABASE_ANON_KEY)` and there is no `pg`/`postgres://`
client anywhere in `src/` or `supabase/functions/`.

### What "latent" does and does not buy

Say it plainly, because the distinction is the whole decision:

- **It is not exploitable today.** A hostile authenticated user cannot destroy
  `playbook_versions`. No incident is implied, no rotation is needed.
- **It is one commit from live, and the commit looks innocent.** There are
  **168** SECURITY INVOKER functions already EXECUTE-granted to `authenticated`.
  The day someone adds a 169th that takes a `text` parameter and `EXECUTE`s it —
  a debug helper, a generic "run this saved query" RPC, an admin utility that
  seemed fine because "only admins can see the button" — 245 tables become
  truncatable by anyone with a login, and RLS will not be consulted for any of
  them. `certify`'s `execute-perimeter` allowlist would flag the *new function*
  (it pins the EXECUTE surface and fails on any diff), which is genuine
  mitigation — but it would not connect that function to 245 unnecessary TRUNCATE
  grants, and re-pinning the allowlist is a one-line habit.
- **It costs nothing to close.** No caller anywhere issues TRUNCATE as
  `authenticated`. Section 4 is a pure subtraction.

`anon` is the precedent and the proof this is a real gap rather than a
theoretical one. `anon` holds only `SELECT, REFERENCES, TRIGGER` across 245
tables — no INSERT, UPDATE, DELETE or TRUNCATE. Somebody already did this
exercise for `anon` and stopped there. That is exactly the shape of
`security_anon_guard_hole` in this repo's memory: *an anon-only revoke is
theatre*, because `authenticated` is obtained by anyone who can sign up.

---

## 3. Census of the write surface — with denominators

### 3a. What actually needs a write grant (`src/` call sites, not definitions)

Scanned **217** `.ts/.tsx/.js/.jsx` files under `src/`.

- **324** `.from('<table>')` call sites.
- **112** supabase write-verb sites (`.insert(`, `.update(`, `.upsert(`, `.delete(`).
- **97** resolved to a `.from()` table.
- **15** did not — and all 15 were read by hand and are **not** Supabase writes:
  10 are `Set.prototype.delete()` inside `useState` updaters
  (`src/components/Sidebar.tsx:301`, `src/pages/tenant/OrganisationPage.tsx:490`,
  `src/pages/tenant/knowledge/LiveKnowledgeLibrary.tsx:250/290/351/1121`, …),
  one is `crypto.createHmac(…).update(…)` inside a docs code block
  (`src/pages/tenant/SettingsPage.tsx:1026`), and four are *comments* in
  `src/lib/api.ts` (lines 97, 297, 675, 734) describing writes that were
  **removed** because they were silent no-ops against `tenants`.
- **2** call sites use a non-literal table name. Both resolved:
  `src/lib/liveShared.ts:30` `.from(table).select(…)` is read-only;
  `src/lib/ssoApi.ts:608` `.from(SSO_POLICY_TABLE).upsert(…)` where
  `SSO_POLICY_TABLE = 'tenant_sso_policy'` (`src/lib/ssoApi.ts:94`). The literal
  scanner missed the second one; it is added by hand. **This is why the inverted
  scan exists** — the forward scan alone would have under-counted the keep-set
  and proposed revoking a grant the SSO settings page needs.

**Denominator: 294 tables examined · 39 with a live `src/` write caller · 255 without.**

### 3b. The other things that could run as `authenticated`

A revoke that only consults `src/` is half an enumeration. Two more surfaces:

**Edge functions.** 62 of them use `SERVICE_ROLE_KEY` (unaffected by any revoke
here). **12** reference `SUPABASE_ANON_KEY`; **6** build a user-scoped client
(`asUser`) from a forwarded JWT — those genuinely run as `authenticated`. Every
use of every one of those clients was read: `ai-engine-status:51`,
`ai-session:558`, `brand-extract:207`, `compile-trust-plan:200/204/219`,
`site-import:277`, `tenant-export:96/208`. **All are `.rpc()` or
`auth.getUser()`. Not one is `.from().insert/update/delete`.** The remaining 6
pass the anon key only as an `apikey` header for function-to-function dispatch.

**SECURITY INVOKER trigger functions** — the trap that would break a revoke
silently. A trigger function that is *not* SECURITY DEFINER runs with the
privileges of whoever fired the trigger, so a trigger on a keep-table that writes
to a revoked table would start failing. There are 26 invoker trigger functions;
**3** perform DML, and all 3 were mapped:

| Trigger function | On table | Writes | Verdict |
|---|---|---|---|
| `opportunities_stage_guard` | `opportunities` (KEEP: INSERT/UPDATE) | `activity_events` | Safe — `activity_events` **INSERT is in the keep-set**. Its UPDATE/DELETE (Tier C) are not used by the trigger. |
| `maintain_doc_chunk_counts` | `knowledge_doc_chunks` (Tier C) | `knowledge_docs` | Safe — `knowledge_docs` UPDATE is in the keep-set. If `knowledge_doc_chunks` writes are revoked the trigger simply stops being reachable as `authenticated`; no `src/` caller writes it. |
| `stamp_gap_cluster_on_apply` | `de_improvements` (Tier C) | `knowledge_gap_clusters` | Already dead for `authenticated` — `knowledge_gap_clusters` is one of the 45 tables with **no** DML grant, so this path fails today. Written by the `de-improve` edge function as `service_role`, unaffected. |

There are **no** standalone SECURITY INVOKER RPCs that perform DML: the only 3
invoker functions containing DML are the trigger functions above, and a
trigger-returning function cannot be usefully invoked through PostgREST.

### 3c. Column-level grants — measured, and they change one table

A table-level `REVOKE` does **not** remove a column-level grant; the two are
independent ACLs. So a census that reads only `role_table_grants` can propose a
revoke that appears to close a hole and does not.

`information_schema.column_privileges` times out on this database (it expands
table-level grants across all columns — ~5,900 rows). The catalogue answers it
directly and exactly:

```
select c.relname, a.attname, a.attacl::text from pg_attribute a
  join pg_class c on c.oid = a.attrelid
 where c.relnamespace='public'::regnamespace and c.relkind='r'
   and a.attacl is not null and a.attacl::text like '%authenticated%'
```

**Three column grants exist, all on `profiles`:**
`avatar`, `full_name`, `last_seen_at` — each `{authenticated=w/postgres}` (UPDATE).

This is `project_org_scoped_permissions`' "profiles UPDATE bounded by COLUMN
grant" and it is working as designed: `profiles` has **no table-level UPDATE**
grant, so those three columns are the entire self-service profile-edit surface.
Consequences for this proposal, both of which the applying migration must honour:

- `profiles` appears in Tier C as **INSERT/DELETE only** — correctly, because
  UPDATE was never granted at table level.
- **`revoke all on profiles from authenticated` would silently delete the
  self-service profile editor** by taking the column grants and SELECT with it.
  Another reason §7.2's "name the privileges, never `ALL`" is a hard rule.

---

## 4. TIER A — TRUNCATE, everywhere

**245 base tables (+3 inert view grants). Revoke all of them.**

**Is any legitimate caller truncating as `authenticated`?** No, and here is the
proof rather than the assertion:

1. No function body in the database contains `TRUNCATE` (Section 2, row 5).
2. supabase-js has no truncate method; PostgREST has no truncate verb. There is
   no client-side way to express it.
3. No `src/` or edge-function code opens a raw SQL connection.
4. `postgres` and `service_role` each retain `TRUNCATE` on 299 relations
   independently — migrations, `delete_tenant`, and every maintenance script run
   as `postgres` via the Management API and are untouched by a revoke scoped to
   `authenticated`.
5. The one place the platform *did* care about truncation, it built a trigger
   guard rather than removing the grant (`audit_events_no_truncate`). That guard
   protects exactly 1 table out of 246 that hold the grant. **Prior art
   establishing intent, and the measure of how far the intent got.**

**Tier A is the whole point of this document.** It removes an RLS-immune
whole-table destruction primitive from the internet-facing role, and it cannot
break a caller because there is no caller.

---

## 5. TIER B and TIER C — DML

### The classification rule, stated once

> A grant is **dead** if the table has RLS enabled and **no PERMISSIVE policy for
> that command** applying to `authenticated` or `public`. Postgres denies the
> command before the grant is ever relevant. Revoking is a no-op on behaviour.
>
> A grant is **live** if a PERMISSIVE policy for that command exists. Revoking
> changes behaviour, and the question becomes whether anything uses it.

Every table is classified per **command**, not per table, so a table appears in
more than one tier when its INSERT is used and its DELETE is not (e.g.
`opportunities`: INSERT/UPDATE in keep, DELETE in Tier C). That is the finer and
correct grain.

### TIER B — RLS-dead DML grants: **171 tables, 469 command-grants**

Safe to revoke. RLS already refuses these; the grant is bookkeeping. Includes,
notably: `action_executions`, `action_definitions`, `tenants`, `trust_policies`,
`playbook_versions`, `schema_migrations`, `profile_compensation`,
`profile_private`, `connector_secrets`, `widget_key_secrets`,
`specialist_source_secrets`, `de_autonomy`-adjacent tables, `audit_logs`
(UPDATE/DELETE — its INSERT is live and in the keep-set).

<details><summary>Full Tier B list (171)</summary>

account_activities (INSERT/UPDATE/DELETE), account_writeback_requests (INSERT/UPDATE/DELETE),
action_definitions (INSERT/UPDATE/DELETE), action_executions (INSERT/UPDATE/DELETE),
adapter_templates (INSERT/UPDATE/DELETE), ai_change_log (INSERT/UPDATE/DELETE),
ai_session_messages (INSERT/UPDATE/DELETE), ai_sessions (INSERT/UPDATE/DELETE),
ai_usage_events (INSERT/UPDATE/DELETE), amendment_metrics (DELETE),
analytics_query_defs (INSERT/UPDATE/DELETE), audit_evidence (DELETE), audit_logs (UPDATE/DELETE),
bank_transactions (DELETE), billable_outcomes (INSERT/UPDATE/DELETE), bills (DELETE),
certification_types (INSERT/UPDATE/DELETE), close_tasks (DELETE), close_workspaces (DELETE),
compliance_pack_rules (INSERT/UPDATE/DELETE), compliance_packs (INSERT/UPDATE/DELETE),
computer_use_runtimes (INSERT/UPDATE/DELETE), computer_use_tasks (INSERT/UPDATE/DELETE),
config_schema_instances (DELETE), config_schema_templates (INSERT/UPDATE/DELETE),
connector_ingest_candidates (INSERT/UPDATE/DELETE), connector_secrets (INSERT/UPDATE/DELETE),
connector_sync_cursors (INSERT/UPDATE/DELETE), continuity_case_events (INSERT/UPDATE/DELETE),
continuity_cases (INSERT/UPDATE/DELETE), continuity_writeback_requests (INSERT/UPDATE/DELETE),
conversation_facts (INSERT/UPDATE/DELETE), customers (DELETE),
data_access_grants (INSERT/UPDATE/DELETE), de_budget_policies (INSERT/UPDATE/DELETE),
de_case_events (INSERT/UPDATE/DELETE), de_certifications (INSERT/UPDATE/DELETE),
de_channels (INSERT/UPDATE/DELETE), de_decision_trace (INSERT/UPDATE/DELETE),
de_delegation_tokens (INSERT/UPDATE/DELETE), de_deliverables (INSERT/UPDATE/DELETE),
de_deployment_stages (INSERT/UPDATE/DELETE), de_escalation_rules (INSERT/UPDATE/DELETE),
de_exceptions (INSERT/UPDATE/DELETE), de_experience (INSERT/UPDATE/DELETE),
de_improvements (INSERT/UPDATE/DELETE), de_incidents (INSERT/UPDATE/DELETE),
de_kpi_readings (INSERT/UPDATE/DELETE), de_kpis (INSERT/UPDATE/DELETE),
de_lifecycle_events (INSERT/UPDATE/DELETE), de_memory (INSERT/UPDATE/DELETE),
de_missions (INSERT/UPDATE/DELETE), de_model_routes (INSERT/UPDATE/DELETE),
de_objectives (INSERT/UPDATE/DELETE), de_performance_reviews (INSERT/UPDATE/DELETE),
de_product_knowledge (INSERT/UPDATE/DELETE), de_role_assignments (INSERT/UPDATE/DELETE),
de_skills (INSERT/UPDATE/DELETE), de_spend_ledger (INSERT/UPDATE/DELETE),
de_system_verifications (INSERT/UPDATE/DELETE), de_task_requests (INSERT/UPDATE/DELETE),
de_training_feedback (INSERT/UPDATE/DELETE), de_training_modules (INSERT/UPDATE/DELETE),
de_training_progress (INSERT/UPDATE/DELETE), de_work_items (INSERT/UPDATE/DELETE),
definition_of_done_log (INSERT/UPDATE/DELETE), digital_employees (DELETE),
dunning_ladders (INSERT/UPDATE/DELETE), dunning_rungs (INSERT/UPDATE/DELETE),
end_user_sessions (INSERT/UPDATE/DELETE), escalation_signals (INSERT/UPDATE/DELETE),
escalations (DELETE), eval_batch_items (INSERT/UPDATE/DELETE),
eval_batch_jobs (INSERT/UPDATE/DELETE), eval_judgments (INSERT/UPDATE/DELETE),
eval_runs (INSERT/UPDATE/DELETE), event_definitions (INSERT/UPDATE/DELETE),
evidence_feedback (INSERT/UPDATE/DELETE), evidence_run_decisions (INSERT/UPDATE/DELETE),
evidence_runs (INSERT/UPDATE/DELETE), exceptions (DELETE),
extraction_results (INSERT/UPDATE/DELETE), extraction_templates (INSERT/UPDATE/DELETE),
feature_registry (INSERT/UPDATE/DELETE), fin_accounts (DELETE), fin_documents (DELETE),
governance_proposals (INSERT/UPDATE/DELETE),
grounded_confidence_shadow_log (INSERT/UPDATE/DELETE),
grounded_confidence_validation (INSERT/UPDATE/DELETE),
guardrail_adjudication_cache (INSERT/UPDATE/DELETE),
guardrail_adjudications (INSERT/UPDATE/DELETE), invoice_activities (INSERT/UPDATE/DELETE),
invoice_payments (INSERT/UPDATE/DELETE), invoice_writeback_requests (INSERT/UPDATE/DELETE),
invoices (DELETE), journal_entries (DELETE), knowledge_access_grants (INSERT/UPDATE/DELETE),
knowledge_conflict_probe_queue (INSERT/UPDATE/DELETE),
knowledge_conflicts (INSERT/UPDATE/DELETE), knowledge_doc_access_paths (INSERT/UPDATE/DELETE),
knowledge_doc_collections (INSERT/UPDATE/DELETE), knowledge_doc_scopes (INSERT/UPDATE/DELETE),
knowledge_doc_usage_daily (INSERT/UPDATE/DELETE),
knowledge_ingestion_items (INSERT/UPDATE/DELETE),
knowledge_ingestion_jobs (INSERT/UPDATE/DELETE),
knowledge_principal_group_members (INSERT/UPDATE/DELETE),
knowledge_principal_groups (INSERT/UPDATE/DELETE),
knowledge_revision_requests (INSERT/UPDATE/DELETE), kpi_metric_catalog (INSERT/UPDATE/DELETE),
learned_tool_specs (INSERT/UPDATE/DELETE), media_assets (UPDATE), messages (DELETE),
oauth_connect_states (INSERT/UPDATE/DELETE), onboarding_template_versions (INSERT/UPDATE/DELETE),
opportunity_activities (INSERT/UPDATE/DELETE),
opportunity_writeback_requests (INSERT/UPDATE/DELETE), ops_alerts (INSERT/UPDATE/DELETE),
otel_spans (INSERT/UPDATE/DELETE), outbound_drafts (INSERT/UPDATE/DELETE),
payment_promises (INSERT/UPDATE/DELETE), payments (DELETE),
platform_runtime_config (INSERT/UPDATE/DELETE), playbook_gaps (INSERT/UPDATE/DELETE),
playbook_trigger_fires (INSERT/UPDATE/DELETE), playbook_versions (INSERT/UPDATE/DELETE),
posting_draft_lines (INSERT/UPDATE/DELETE), posting_drafts (INSERT/UPDATE/DELETE),
profile_compensation (INSERT/UPDATE/DELETE), profile_private (INSERT/UPDATE/DELETE),
rate_limit_counters (INSERT/UPDATE/DELETE), role_archetypes (INSERT/UPDATE/DELETE),
role_certifications (INSERT/UPDATE/DELETE), schema_migrations (INSERT/UPDATE/DELETE),
scim_tokens (INSERT/UPDATE/DELETE), scim_user_links (INSERT/UPDATE/DELETE),
semantic_guardrail_cache (INSERT/UPDATE/DELETE),
semantic_guardrail_shadow_log (INSERT/UPDATE/DELETE), sim_runs (INSERT/UPDATE/DELETE),
skill_catalog (INSERT/UPDATE/DELETE), skill_categories (INSERT/UPDATE/DELETE),
specialist_source_secrets (INSERT/UPDATE/DELETE), staleness_escalations (INSERT/UPDATE/DELETE),
tenant_billing_config (INSERT/DELETE), tenant_brand_identity (INSERT/UPDATE/DELETE),
tenant_branding (INSERT/UPDATE/DELETE), tenant_compliance_packs (INSERT/UPDATE/DELETE),
tenant_cost_tracking (INSERT/UPDATE/DELETE), tenant_deletion_receipts (INSERT/UPDATE/DELETE),
tenant_deletion_requests (INSERT/UPDATE/DELETE), tenant_feature_overrides (INSERT/UPDATE/DELETE),
tenant_feature_toggles (INSERT/DELETE), tenant_pipeline_stages (INSERT/UPDATE/DELETE),
tenant_provisioning_requests (INSERT/UPDATE/DELETE), tenant_usage_metrics (INSERT/UPDATE/DELETE),
tenants (INSERT/UPDATE/DELETE), trust_policies (INSERT/UPDATE/DELETE),
unguarded_secdef_writers (INSERT/UPDATE/DELETE), unit_tripwires (INSERT/UPDATE/DELETE),
usage_metrics (INSERT/UPDATE/DELETE), vendors (DELETE),
watch_source_catalog (INSERT/UPDATE/DELETE), watch_source_fields (INSERT/UPDATE/DELETE),
widget_key_secrets (INSERT/UPDATE/DELETE), work_item_framing (INSERT/UPDATE/DELETE),
work_watcher_matches (INSERT/UPDATE/DELETE), workforce_actions (INSERT/DELETE),
workforce_baselines (INSERT/UPDATE/DELETE), workforce_conversations (DELETE),
workforce_team_members (INSERT/UPDATE/DELETE), workforce_teams (INSERT/UPDATE/DELETE),
workforce_trust_posture (INSERT/UPDATE/DELETE)

</details>

#### ⚠ The one Tier B entry that is not a no-op

**`de_deployment_stages` (UPDATE)** is RLS-dead *and* has a live `src/` caller:
`src/lib/workforceApi.ts:292` — `promoteDeploymentStage`, which does
`.from('de_deployment_stages').update({ stage, stage_promoted_at,
promotion_reason })`.

That call **does not work today**. `de_deployment_stages` has no PERMISSIVE
UPDATE policy for `authenticated`, so RLS matches zero rows and PostgREST returns
*success with no error* — the exact trap recorded in this repo's memory as
*"RLS-denied write = PostgREST SUCCESS 0 rows"* (`project_role_gated_ui_audit`).
The DE promotion button reports that it promoted a digital employee and nothing
changed.

Revoking the grant would convert a silent lie into a `42501` the UI would
surface as an error. That is arguably an improvement, but it is a **behaviour
change disguised as a cleanup**, and it belongs to whoever owns DE promotion, not
to this migration. **Recommendation: hold `de_deployment_stages` UPDATE out of
the Tier B revoke and file the broken promotion path separately.** Tier B then
carries 468 command-grants across 171 tables.

### TIER C — live grant, no `src/` caller: **85 tables, 192 command-grants**

The genuinely risky tier: a PERMISSIVE policy exists, so `authenticated` *can*
perform the command today; nothing in `src/` does. Absence of a caller is
evidence, not proof — a caller could arrive tomorrow, or live in a surface this
audit did not read.

**The per-table evidence for every one of the 85 is the same three facts, each
independently re-checkable rather than asserted here:** (1) `authenticated` holds
the named command-grant — `information_schema.role_table_grants`; (2) a
PERMISSIVE policy for that command applies to `authenticated` or `public` —
`pg_policies`, so the grant is *live*, not RLS-dead; (3) zero write call sites in
`src/` out of the 97 resolved (§3a), zero in the 6 `asUser` edge-function
clients, and no SECURITY INVOKER trigger reaches it (§3b) — the three tables that
one *could* reach are named in that section, not left to inference. Anything with
a caller is in the keep-set, not here.

Highest-value entries, with why they matter:

| Table (commands) | Why the grant is worth removing |
|---|---|
| `tenant_api_keys` (I/U/D) | API credentials. A live write path to credential rows bounded only by a tenant-scoped policy. |
| `tenant_ip_allowlists`, `tenant_ip_allowlist_entries` (I/U/D) | A user who can edit the IP allowlist can widen the perimeter that gates themselves. |
| `tenant_session_policies` (I/U/D) | Session lifetime / re-auth rules — self-modifiable security control. |
| `sso_attribute_role_map` (I/U/D) | Maps IdP attributes to roles. Write access is role self-assignment at the next login. |
| `de_autonomy` (I/U/D) | **The trust dial.** `project_org_level_trust` records that the dials are derived and governed; a direct write is a bypass of the governance path. |
| `profiles` (INSERT/DELETE) | Identity rows. |
| `workspaces`, `departments` (I/U/D) | Org structure. Compare mig 643, which nearly left 11 of 12 workspaces administrable by nobody. |
| `de_connected_systems` (I/U/D) | Feeds `read_de_system` / `list_de_system`, which `format('%I')` its `source_table` and `id_column`. The allowlist holds, but a writable binding table next to a dynamic-SQL reader is a bad adjacency. |
| `human_tasks` (DELETE) | Deleting the approval queue rows. INSERT/UPDATE are in the keep-set; DELETE has no caller. |
| `answer_cache`, `knowledge_chunks`, `knowledge_doc_chunks` (I/U/D) | Retrieval corpus poisoning: write access to what the DEs read back as grounded truth. |

<details><summary>Full Tier C list (85)</summary>

activity_events (UPDATE/DELETE), agent_actions (INSERT/UPDATE/DELETE),
agentic_step_policies (INSERT/UPDATE/DELETE), agreement_lines (INSERT/UPDATE/DELETE),
ai_model_pricing (INSERT/UPDATE/DELETE), answer_cache (INSERT/UPDATE/DELETE),
audit_evidence (INSERT/UPDATE), bank_transactions (INSERT/UPDATE), bills (INSERT/UPDATE),
capabilities (INSERT/UPDATE/DELETE), close_tasks (INSERT/UPDATE),
close_workspaces (INSERT/UPDATE), commercial_agreements (INSERT/UPDATE/DELETE),
commercial_catalog_items (INSERT/UPDATE/DELETE), connector_actions (DELETE),
connector_objects (DELETE), continuity_stage_config (INSERT/UPDATE/DELETE),
conversations (INSERT/UPDATE/DELETE), customer_account_contacts (INSERT/UPDATE/DELETE),
customer_accounts (DELETE), customers (INSERT/UPDATE), de_assignments (INSERT/UPDATE/DELETE),
de_autonomy (INSERT/UPDATE/DELETE), de_connected_systems (INSERT/UPDATE/DELETE),
de_consultation_grants (DELETE), de_conversations (INSERT/UPDATE/DELETE),
de_development_items (INSERT/UPDATE/DELETE), de_learning_policies (INSERT/UPDATE/DELETE),
de_messages (INSERT/UPDATE/DELETE), de_playbook_assignments (INSERT/UPDATE/DELETE),
de_profile_fields (UPDATE/DELETE), de_token_usage (INSERT/UPDATE/DELETE),
departments (INSERT/UPDATE/DELETE), digital_employees (INSERT/UPDATE),
escalations (INSERT/UPDATE), exceptions (INSERT/UPDATE), fin_accounts (INSERT/UPDATE),
fin_documents (INSERT/UPDATE), guardrail_rules (DELETE), health_score_config (DELETE),
human_tasks (DELETE), invoices (INSERT/UPDATE), journal_entries (INSERT/UPDATE),
knowledge_articles (INSERT/UPDATE/DELETE), knowledge_chunks (INSERT/UPDATE/DELETE),
knowledge_collections (UPDATE), knowledge_doc_chunks (INSERT/UPDATE/DELETE),
knowledge_gap_policies (INSERT/DELETE), knowledge_tags (INSERT/UPDATE/DELETE),
mcp_server_allowlist (UPDATE), media_assets (DELETE), messages (INSERT/UPDATE),
notifications (INSERT/UPDATE/DELETE), onboarding_projects (INSERT/DELETE),
opportunities (DELETE), org_units (DELETE), payments (INSERT/UPDATE),
playbook_amendments (INSERT/UPDATE/DELETE), playbook_definitions (DELETE),
playbook_runs (INSERT/UPDATE/DELETE), playbook_studies (INSERT/UPDATE/DELETE),
playbooks (INSERT/UPDATE/DELETE), profiles (INSERT/DELETE), renewal_invoices (DELETE),
sso_attribute_role_map (INSERT/UPDATE/DELETE), staleness_policies (INSERT/UPDATE/DELETE),
support_tickets (DELETE), system_categories (INSERT/UPDATE/DELETE),
tenant_ai_usage (INSERT/UPDATE/DELETE), tenant_api_keys (INSERT/UPDATE/DELETE),
tenant_billing_config (UPDATE), tenant_comms_settings (INSERT/UPDATE/DELETE),
tenant_entity_fields (UPDATE/DELETE), tenant_feature_toggles (UPDATE),
tenant_ip_allowlist_entries (INSERT/UPDATE/DELETE), tenant_ip_allowlists (INSERT/UPDATE/DELETE),
tenant_outcome_pricing (DELETE), tenant_session_policies (INSERT/UPDATE/DELETE),
tenant_sso_policy (DELETE), vendors (INSERT/UPDATE), widget_keys (DELETE),
workforce_conversations (INSERT/UPDATE), workforce_entity_amendments (INSERT/UPDATE/DELETE),
workforce_entity_studies (INSERT/UPDATE/DELETE), workspaces (INSERT/UPDATE/DELETE)

</details>

### KEEP — live grant with a proven `src/` caller: **38 tables, 81 command-grants**

Not to be touched. Each has a file:line write call site (Section 3a).

activity_events (INSERT), approval_authority (I/U/D), audit_logs (INSERT),
connector_actions (I/U), connector_objects (I/U), connectors (I/U/D),
customer_accounts (I/U), de_consultation_grants (I/U), de_playbook_charter (I/U/D),
de_profile_fields (INSERT), golden_qa (I/U/D), guardrail_rules (I/U),
health_score_config (I/U), human_tasks (I/U), knowledge_collections (INSERT/DELETE),
knowledge_docs (I/U/D), knowledge_gap_policies (UPDATE),
mcp_server_allowlist (INSERT/DELETE), media_assets (INSERT), onboarding_projects (UPDATE),
onboarding_templates (I/U/D), opportunities (I/U), org_unit_members (I/U/D),
org_units (I/U), playbook_definitions (I/U), playbook_event_rules (I/U/D),
playbook_schedules (I/U/D), push_subscriptions (I/U/D), renewal_invoices (I/U),
support_tickets (I/U), support_triage_rules (I/U/D), tenant_entity_fields (INSERT),
tenant_outcome_pricing (I/U), tenant_sso_policy (I/U), widget_keys (I/U),
work_assignment_rules (I/U/D), work_watchers (I/U/D), workforce_actions (UPDATE)

---

## 6. THE RATCHET — yes, it regrows

**A one-time revoke silently un-does itself.** From `pg_default_acl`:

```
grantor    schema  objtype  acl
postgres   public  r        {postgres=arwdDxtm/postgres, anon=rxtm/postgres,
                             authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
supabase_admin  public  r   {…, authenticated=arwdDxtm/supabase_admin, …}
```

In PostgreSQL 17 aclitem letters: `a`=INSERT, `r`=SELECT, `w`=UPDATE, `d`=DELETE,
**`D`=TRUNCATE**, `x`=REFERENCES, `t`=TRIGGER, `m`=MAINTAIN. So **every new table
created by `postgres` or `supabase_admin` in `public` is born with TRUNCATE for
`authenticated`.** Migrations in this repo are applied through the Management API
as `postgres`, so the first entry fires on every migration that creates a table.

Note in the same row that **`anon` is already reduced to `rxtm`** — no `a`, `w`,
`d` or `D`. Somebody fixed the default privileges for `anon` and left
`authenticated` at the Supabase factory setting. Without changing this, a revoke
migration cleans 245 tables and table 295 arrives carrying the grant again.

### 6a. Proposed default-privilege change

```sql
alter default privileges for role postgres       in schema public
  revoke truncate, insert, update, delete on tables from authenticated;
alter default privileges for role supabase_admin in schema public
  revoke truncate, insert, update, delete on tables from authenticated;
```

`ALTER DEFAULT PRIVILEGES` must name the **grantor role** — it is not global, and
this is where a partial fix hides: doing only `postgres` leaves the
`supabase_admin` path open. Verify afterwards that both rows read `authenticated=rxtm`.

⚠ **The trade-off the founder should decide.** After this, a new table needs an
explicit `grant insert, update, delete on <t> to authenticated;` in its own
migration whenever the browser writes it directly. That is a real ergonomic cost
— roughly the 38-table keep-set's worth of tables, one line each — paid in
exchange for write access never being the default. The alternative (revoke only
TRUNCATE from the defaults, leave I/U/D) is cheaper and still closes the
RLS-immune primitive. **Recommended: revoke all four.** RLS is the tenancy
boundary and a grant that RLS then has to catch is a second lock guarding a door
the first lock already holds — except for TRUNCATE, where there is no first lock.

### 6b. Proposed `certify` Ring-0 probe: `authenticated-write-perimeter`

`scripts/certify.mjs` already has the right mechanism for exactly this shape and
has never been pointed at tables: `perimeterCheck()` pins the **EXECUTE** surface
for `anon`/`authenticated` to `supabase/baseline/execute-allowlist.json` and
fails on any diff in either direction. The table-grant analogue belongs beside it.

**Two arms, deliberately different in kind:**

**Arm 1 — pinned surface (symmetric, re-pinnable).** New file
`supabase/baseline/write-allowlist.json`, same `--pin-allowlist` flow. Fails on a
**new** grant *and* on a **vanished** one. The vanished half is not decoration:
it is the both-halves guard, and it is what would have caught mig 643's near-miss
class — a revoke that removed more than intended shows up as
`allowlisted grant VANISHED` on the next run rather than as a support ticket.

```sql
-- writePerimeterSql(): the pinned surface
select g.table_name as tbl, g.privilege_type as priv
  from information_schema.role_table_grants g
  join pg_class c on c.relname = g.table_name
                 and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
 where g.table_schema = 'public' and g.grantee = 'authenticated'
   and g.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
 order by 1, 2
```

**Arm 2 — TRUNCATE, hard rule, NOT pinnable.** A pin can be re-pinned by the next
person in a hurry, and a rule that can be silenced by the thing it guards against
is the "gate that had never fired" this repo already paid for. TRUNCATE for
`authenticated` is never legitimate, so it gets no allowlist and no exemption:

```sql
-- always-on arm; no allowlist, no exemption
select g.table_name || ': TRUNCATE granted to authenticated (RLS does not apply
        to TRUNCATE — one statement destroys every tenant''s rows)' as violation
  from information_schema.role_table_grants g
  join pg_class c on c.relname = g.table_name
                 and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
 where g.table_schema = 'public' and g.grantee = 'authenticated'
   and g.privilege_type = 'TRUNCATE'
union all
-- DENOMINATOR: zero findings from zero comparisons looks exactly like a clean
-- result. Reported as a note on pass, and a VIOLATION if it is ever zero.
select case when n = 0
            then 'no-comparisons: examined 0 public base tables — the probe read nothing'
       end as violation
  from (select count(*) n from pg_class
         where relnamespace = 'public'::regnamespace and relkind = 'r') d
```

`certify` surfaces rows whose `violation` is NULL as a printed `note`, so the
denominator arm prints "examined 294 tables" on a green run and fails outright if
it ever compares nothing.

**Mutation case — proof the probe can fire.** Two, matching the existing
`scripts/certify-mutation-test.mjs` conventions (`fx()` fixtures fed through the
*real* query, plus MANUAL cases for live catalog state):

1. **Automated, no writes.** Export the probe as
   `writePerimeterSql({ source })` where `source` defaults to
   `information_schema.role_table_grants` and the mutation harness substitutes a
   CTE: `(values ('mutant_tbl','authenticated','TRUNCATE','public'))`. Asserts the
   real predicate returns 1 row on the synthesised grant and 0 rows on
   `('mutant_tbl','authenticated','SELECT','public')`. This is what proves the
   predicate is not vacuous — the same failure mode as the `\b` regex that
   matched nothing and looked like a clean scan.
2. **MANUAL, for the applying agent, inside an explicit transaction that rolls
   back.** This is a DDL write and is therefore **out of scope for this audit and
   deliberately not run**:
   ```sql
   begin;
     create table public._mutant_default_acl_check (id int);
     select privilege_type from information_schema.role_table_grants
      where table_schema='public' and table_name='_mutant_default_acl_check'
        and grantee='authenticated';   -- BEFORE 6a: includes TRUNCATE
   rollback;
   ```
   Run before and after the `ALTER DEFAULT PRIVILEGES`. Before: TRUNCATE present
   — proving the regrowth is real rather than inferred from `pg_default_acl`.
   After: absent — proving the ratchet holds. Until then, `pg_default_acl`'s
   `authenticated=arwdDxtm` is catalogue-level evidence, and the letters are
   documented, but it is inference from the catalogue rather than an observed
   new table.

---

## 7. BOTH HALVES — what breaks if I am wrong

Mig 643 is the standing example: a correct-looking authorisation fix that nearly
left 11 of 12 workspaces administrable by nobody. Per tier:

| Tier | If this analysis is wrong, what breaks | How the next agent proves it did not |
|---|---|---|
| **A — TRUNCATE (245)** | Nothing identifiable. There is no client-side way to express TRUNCATE, no function body containing the word, no raw connection. The only way to be wrong is a caller outside `src/`, `supabase/functions/` and the database itself. | After applying: `select count(*) … privilege_type='TRUNCATE' and grantee='authenticated'` **= 0**; and `has_table_privilege('service_role','public.playbook_versions','TRUNCATE')` and the same for `postgres` **= true**. |
| **B — RLS-dead DML (468)** | Nothing, *by construction* — Postgres refuses these before the grant is read. The failure mode is a **misclassification**: counting a RESTRICTIVE policy as coverage (caught, Section 1) or missing a policy whose `roles` array names a role I did not treat as covering `authenticated`. | Re-run the classification query after applying and confirm the table has zero PERMISSIVE policies for that command. Then smoke-test the app: any write that starts returning `42501` where it previously returned success-with-0-rows was in the `de_deployment_stages` class and needs a policy, not the grant back. |
| **C — live, no caller (192)** | **This is where real breakage lives.** A path outside `src/` that writes as `authenticated`. The three surfaces that could hold one were enumerated (Section 3b) and all three came back clean — but "I found no caller" is weaker than "there is no caller". | Apply **in slices, not one migration** (Section 8), and watch Sentry `42501` / PostgREST 403 for a week per slice. Each slice reverts with a one-line `grant`. |
| **`de_deployment_stages` UPDATE** | Held back from Tier B on purpose. Revoking turns a silent no-op into a visible error in DE promotion. | Excluded. File separately. |

**Three things the applying migration must do, none of which a `REVOKE` does by itself:**

1. **A REVOKE is not a description of the resulting privileges.** `REVOKE`
   succeeds whether or not the grant was there, revokes nothing if the privilege
   came via a role membership, and reports no rows. The migration must **assert**
   afterwards and fail loudly:
   ```sql
   do $$
   declare n int;
   begin
     select count(*) into n from information_schema.role_table_grants
      where table_schema='public' and grantee='authenticated' and privilege_type='TRUNCATE';
     if n <> 0 then raise exception 'TRUNCATE still held on % relations', n; end if;
     if not has_table_privilege('service_role','public.playbook_versions','TRUNCATE')
        or not has_table_privilege('postgres','public.playbook_versions','TRUNCATE') then
       raise exception 'over-revoked: service_role/postgres lost TRUNCATE';
     end if;
   end $$;
   ```
2. **`service_role` and `postgres` must keep what they need.** Both currently hold
   INSERT/UPDATE/DELETE/TRUNCATE/SELECT/REFERENCES/TRIGGER on 299 relations.
   `REVOKE … FROM authenticated` does not touch them — but `REVOKE … FROM PUBLIC`
   would reach further than intended, and `REVOKE ALL ON ALL TABLES IN SCHEMA
   public FROM authenticated` would also drop **SELECT**, blanking every read in
   the product — and on `profiles` it would additionally take the three
   column-level UPDATE grants (§3c) and break the self-service profile editor.
   **Name the four privileges explicitly. Never `ALL`.**
   ```sql
   revoke truncate, insert, update, delete on table public.<t> from authenticated;  -- ✓
   revoke all on all tables in schema public from authenticated;                     -- ✗ takes SELECT too
   ```
3. **The two least-privilege writer roles are untouched.** `approval_brief_writer`
   (INSERT/SELECT/UPDATE on 1 table) and `trust_pattern_proposer` (INSERT on 1
   table) are separate NOLOGIN roles from migs 705/710, not members of
   `authenticated`. `certify`'s `advisory-layer-cannot-decide` and
   `trust-proposer-cannot-decide` probes will show it if that changes.

---

## 8. Recommended apply order

Each step is a separate migration, separately committed, separately verified.
**Do not combine them** — the whole value of the ordering is that a regression
names its own slice.

| # | Step | Risk | Rollback |
|---|---|---|---|
| 1 | **Tier A** — revoke TRUNCATE from `authenticated` on all 245 base tables (and the 3 views, for tidiness). Assertion block per §7.1. | None found | `grant truncate on <t> to authenticated` — but there is no reason to |
| 2 | **The ratchet, §6a** — `ALTER DEFAULT PRIVILEGES` for both `postgres` and `supabase_admin`. Without this, step 1 decays. | Ergonomic only: new tables need explicit grants | Re-issue `alter default privileges … grant …` |
| 3 | **The probe, §6b** — both arms + the mutation cases, *and re-run `npm run certify` to see it green with a printed denominator*. A probe that has never run is not a probe. | None (read-only) | n/a |
| 4 | **Tier B** — revoke the 468 RLS-dead command-grants across 171 tables. Excludes `de_deployment_stages` UPDATE. Re-pin the write-allowlist deliberately after. | Low: RLS already refuses these | Per-table `grant` |
| 5 | **Tier C, slice 1 — security-control tables**: `tenant_api_keys`, `tenant_ip_allowlists`, `tenant_ip_allowlist_entries`, `tenant_session_policies`, `sso_attribute_role_map`, `de_autonomy`, `profiles`. Highest value, smallest blast radius, most obvious if wrong. | Medium | Per-table `grant` |
| 6 | **Tier C, slice 2 — the rest (78 tables).** Only after slice 1 has run a week clean. | Medium | Per-table `grant` |
| 7 | **Separately, not part of this work** — fix `promoteDeploymentStage` (`src/lib/workforceApi.ts:292`), which silently does nothing today. Needs a policy or an RPC, not a grant. | — | — |

**Steps 1–3 are the recommendation.** They close the RLS-immune primitive, stop it
regrowing, and prove the guard can fire — with no identified caller at risk.
Steps 4–7 are defence in depth and can wait for a founder decision on the
ergonomic trade-off in §6a.

---

## 9. What this audit did **not** check

Stated so the next reader does not mistake silence for coverage:

- **No table in a schema other than `public`.** `storage`, `auth`, `realtime` and
  `vault` grants were not censused. `storage`'s default ACL row shows
  `authenticated=arwdDxtm` there too — **unexamined, and a plausible second
  finding of the same shape.**
- **`net.http_post` is EXECUTE-granted to `authenticated`** (pg_net, schema `net`,
  USAGE granted). That is an outbound-request primitive available to any logged-in
  user. It is not a TRUNCATE path — pg_net cannot authenticate back to Postgres —
  so it is out of scope here. `certify`'s `net-not-exposed` arm already watches
  the related config. **Named and left, per scope discipline.**
- **Whether every keep-set write actually succeeds.** The keep-set proves a
  caller exists, not that the call works. `de_deployment_stages` was found only
  because its grant was RLS-dead; a keep-set table with a policy that matches zero
  rows in practice would look identical to a working one from here.

---

## 10. Provenance

Read-only throughout. No `GRANT`, no `REVOKE`, no DDL, no migration file, no
write of any kind was executed against any database, production or dev.
`action_executions` measured at **186** rows at the time of writing, unchanged.
