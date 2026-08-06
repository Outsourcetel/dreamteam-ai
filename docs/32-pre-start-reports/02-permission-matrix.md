# HEADLINE
I checked every one of the 106 RPCs the Employee File can reach, against the live database — not the four the audit already knew about. Two of them have no permission check at all: `get_de_systems` (returns which systems an employee can read, write and operate) and `list_de_skills` (returns an employee's skill ratings) will answer for ANY employee in ANY of your 15 workspaces if the caller simply knows that employee's ID — and `list_de_skills` doesn't even require a login, because it's granted to the public API key that ships inside your web app. Beyond those two, 21 more return one employee's private material (reasoning transcripts, memory contents, cost, execution logs) to anyone with a login to that workspace, regardless of whether they are responsible for that employee — the docs/29 "default must DENY" rule is not met on any of them. A third, separate class: 8 functions that CHANGE things have a workspace-membership check but no role check at all, so your most junior teammate can flip a digital employee from "draft replies for a human to approve" to "send replies automatically", overwrite a stored source credential, create a new digital employee, or undo someone's knowledge edits. Today the practical blast radius is small (only one live account sits below manager), but the assignment drive in docs/31 is exactly the event that turns all of this on. Two bonus findings while counting: five amendment RPCs the Employee File calls have never existed in the database (that panel is dead, failing silently), and the Workbench's reasoning/exception/memory/objective tables are tenant-scoped but not employee-scoped at the RLS layer either.

# STATS
106 distinct RPCs reachable from the Employee File surface (enumerated by function-level import-closure over 27 components + 225 library functions; 75-file raw closure reduced to what is actually callable). 101 exist in the live database, 5 do not. Classification: 2 UNGUARDED (no auth check at all), 8 PRIVILEGE-GAP (write, no role gate), 21 TENANT-ONLY holding per-DE data (no can_access_de), 3 SCOPED-with-caveat, 47 SCOPED, 20 not-applicable by design, 5 ABSENT. 12 RPCs are executable by `anon`; 10 of those hold PUBLIC EXECUTE in their ACL. 46 direct `.from()` tables also audited for RLS: 43 tenant-gated, only 3 (de_conversations, de_missions, de_work_items) carry a can_access_de policy. Live context: 116 DEs across 16 tenants, 20 profiles across 15 tenants, role census = 11 tenant_admin / 6 tenant_owner / 2 platform_super_admin / 1 tenant_user.

# Commitment #2 — Full permission matrix for every RPC behind the Employee File

**Date:** 2026-07-27 · **Scope:** docs/31 pre-start commitment #2 · **Mode:** read-only (no repo writes, no migrations, no deploys)

---

## Method (state it so you can re-run it)

**(a) Enumeration.** A naive "grep every `.rpc()` in every file the page imports" over the transitive import closure returns 75 files and 226 RPC names — but that over-counts badly, because `src/lib/api.ts` and `src/lib/knowledgeApi.ts` are 100+-function grab-bags and importing *one* function from them does not make the other 99 reachable.

So I did **function-level reachability** instead (`scratchpad/reach.mjs`): starting from the seven surface files, components are pulled in whole (a mounted component runs all its code), while library modules are split into top-level declarations and only the *named* functions actually imported — plus what those functions call, transitively — are marked reachable. Result:

- **27 components/pages** and **225 library functions** reachable
- **106 distinct RPC names** callable from the Employee File
- **59 tables** read directly via `.from()` (RLS-governed — tracked separately, §5)

I also grepped for dynamic (non-literal) `.rpc(variable)` call sites. Nine exist repo-wide; none are inside the reachable set except `decidePlaybookAmendment`, which is not reachable from these seven surfaces. So the 106 is complete for this surface.

**(b) Live verification.** Every name was queried against production `pg_proc` / `pg_namespace` for existence, `prosecdef`, and `has_function_privilege('anon'|'authenticated', …)`; `proacl` was read for PUBLIC grants; and `prosrc` was pattern-matched for `auth_tenant_id` / `auth_has_tenant_role` / `can_access_de` / `auth.uid()`. **Pattern matches were then hand-verified by reading the actual source of 90 functions** — the flags lie in both directions (a function can *mention* `auth.uid()` in an audit payload without gating on it, and `get_de_systems` mentions nothing at all).

**(c) The classification rule that matters.** `can_access_de()` returns TRUE for `tenant_owner`, `tenant_admin` and `tenant_manager` (verified live — it is owner/admin/manager OR an explicit `de_assignments` row). **Therefore adding `can_access_de` to a function already gated to owner/admin changes nothing.** The DE-scoping gap is only real on functions reachable by roles *below* manager — i.e. those gated by nothing more than workspace membership. That is the line I classified on, and it is why 47 functions are marked SCOPED despite having no `can_access_de` call.

**Honesty boundary.** Every claim below is read from the live database definition or the live grant. I did **not** execute any RPC as `anon` or as a low-privilege user — the task confines me to read-only SELECT. So the unguarded functions are **proven-unguarded-by-definition**, not proven-exploited-by-execution. Firing one read-only `anon` call against `list_de_skills` would close that last inch; it needs your say-so.

---

## The five findings a migration session should act on

### 1. `get_de_systems` — UNGUARDED. No permission check of any kind.

```sql
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'system_key', t.system_key, … 'can_read', t.can_read, 'can_write', t.can_write,
    'can_verify', t.can_verify, 'can_operate', t.can_operate,
    'operate_domain', public.operate_domain_of(t), 'write_registry', t.write_registry) …), '[]'::jsonb)
  FROM de_connected_systems t WHERE t.de_id = p_de_id AND t.active;
```

That is the entire body. `SECURITY DEFINER`, so it bypasses RLS on `de_connected_systems`. There is no tenant check, no role check, no `auth.uid()` check. **Any authenticated user in any of your 15 workspaces, holding any employee's UUID, gets that employee's system bindings — including which systems it may write to and operate.** This is a cross-tenant read, and it is the exact shape migration 330 was written to eliminate.

Live blast radius today: 9 active rows across 6 DEs. Small — but it is the *capability map* of your product's most sensitive objects.

Caller: `src/components/workforce/EmployeeFileStrip.tsx` (a tile docs/31 §Q12 proposes deleting — deleting the caller does **not** close the function).

### 2. `list_de_skills` — UNGUARDED **and** reachable without logging in.

Same shape: `SECURITY DEFINER`, no auth check. The only filter is `c.tenant_id IS NULL OR c.tenant_id = (SELECT tenant_id FROM digital_employees WHERE id = p_de_id)` — which *derives* the tenant from the parameter instead of checking it against the caller.

Worse, its ACL is `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres`. The leading `=X/` is **PUBLIC EXECUTE**, and `anon` is granted explicitly on top. `anon` is the key that ships inside your published web bundle. So this is readable **by anyone on the internet who has a DE UUID** — it returns the skill catalog plus that employee's `proficiency`, `sample_size`, `signal_value` and the human-written `detail` string. 580 `de_skills` rows exist live.

This is the same class as the anon-guard hole closed in migration 330 — one function that the sweep did not cover.

### 3. Eight write RPCs have a workspace-membership check but **no role check at all**

`can_access_de` is not the issue here; **privilege** is. Each of these can be called by *any* member of the workspace, including a `tenant_user`:

| RPC | What an unprivileged member can do |
|---|---|
| `set_de_external_reply_mode` | **Flip a digital employee from `draft` to `auto` external replies.** Gate is `is_platform_admin() OR profiles.tenant_id matches`. This is the single most governance-critical toggle in the product and it has no role gate. |
| `set_specialist_source_secret` | **Overwrite a stored source credential in Supabase Vault.** Gate is a `profiles` join proving tenant membership. |
| `install_technical_specialist` | **Create a digital employee** (inserts into `digital_employees`, writes an audit event as "You"). |
| `ai_undo_change` | **Revert** a `knowledge_docs`, `playbook_definitions` or `digital_employees` change inside the undo window. |
| `respond_de_task` | Mark any DE task `accepted`/`completed`/`declined` — and `completed` calls `conclude_objective_verified`, so it **closes an objective**. |
| `record_kpi_reading` | Write a KPI reading against any DE in the workspace. |
| `seed_trust_policies` | Seed the workspace's trust policies. |
| `cancel_case_continuation` | Cancel any pending case continuation. |

Compare with the 40-odd sibling writers (`set_de_voice`, `set_de_identity`, `pause_digital_employee`, …) that all correctly open with `auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin'])`. These eight are the ones that were missed, not a deliberate design.

Two more sit just below this bar and are worth a decision rather than a fix: `request_trust_promotion` and `submit_evidence_feedback` both correctly check `can_access_de` but have **no role gate**, so any member can raise trust-promotion requests or file evidence verdicts that open revision requests. Both create human tasks rather than enacting anything, so they are proposals — but they are spammable.

### 4. Twenty-one readers are TENANT-ONLY while holding per-employee material

These pass `auth_tenant_id() IS NOT NULL` (or an equivalent `profiles` membership check) and nothing more. Under docs/29 default-DENY, a member who is responsible for *no* employees sees *every* employee's private record.

The four docs/31 already named — `get_de_experience`, `get_de_execution_log`, `get_de_agentic_runs`, `get_agentic_run_messages` — are confirmed. Seventeen more were never checked:

- **Most sensitive:** `list_de_memory_grouped` (an employee's actual memory contents), `get_agentic_run_messages` (full reasoning transcripts), `get_de_execution_log`, `get_de_experience`.
- **Widest fan-out:** `get_de_performance_metrics` returns per-DE rows for **every** DE in the tenant and is the engine under `list_de_health` and `get_de_kpi_status`. Fixing it fixes three surfaces. Same shape: `get_de_action_metrics`, `get_de_cost_metrics_ranged`, `get_de_inquiry_metrics`, `get_outcome_metering`, `list_de_health`.
- **Configuration and identity:** `de_certification_status`, `compute_de_lifecycle_readiness`, `compute_trust_evidence`, `get_de_gate_status`, `get_de_role_context`, `get_kpi_metrics_for_de`, `resolve_my_de_autonomy`, `list_de_specialists`, `list_consultable_for_de`.
- **`list_de_assignments`** deserves a separate mention: it returns *who is responsible* for a DE, with full name and email. Reading the reporting line is itself a permissions question under docs/29.

Note the inconsistency this creates *inside one tab*: on Performance, `get_de_csat_metrics` and `get_de_economics` correctly apply `can_access_de` per row (Wave-2, migs 385/388), while `get_de_performance_metrics` sitting beside them does not. Same page, two different security models.

### 5. Five RPCs the Employee File calls **do not exist in the database**

`request_amendment`, `list_pending_amendments`, `get_amendment_detail`, `approve_amendment`, `reject_amendment` — absent from `pg_proc`, and absent from all 435 files in `supabase/migrations/`. They have never existed.

`PendingAmendmentsWidget` and `AmendmentWizard` are mounted live at `src/pages/tenant/LiveWorkforceDEs.tsx:3687-3689`. `src/lib/amendmentApi.ts` wraps every call in try/catch returning `null`/`[]`, so **the panel renders empty forever and reports nothing**. This is not a permission finding — it fell out of the exhaustive enumeration — but it is a dead surface in the Employee File that the docs/31 §Q12 reshuffle should either delete or build. (Note: `apply_entity_amendment` / `reject_entity_amendment` / `apply_playbook_amendment` / `reject_playbook_amendment` **do** exist — this looks like a UI wired to a naming convention that was never shipped.)

> ✅ **RESOLVED 2026-08-06 — panel deleted, RPCs deliberately NOT built.**
> This finding was correct, and the closing parenthesis above was the key to it:
> the UI was wired to a naming convention that was never shipped, while the real
> functions existed under different names. (One correction: it is **six** RPCs,
> not five — `get_amendment_history` was also absent.)
>
> `amendmentApi.ts`, `AmendmentWizard`, `PendingAmendmentsWidget` and
> `AmendmentReviewCard` are removed. The six were **not** built, because
> amendments already work end to end: `entity-amend` proposes → raises a
> **`human_tasks` row** → a person decides it in the ordinary approval queue via
> **`decide_human_task`** → `trg_sync_entity_amendment` applies or rejects it.
> Building the six would have created a second approval path that bypasses
> `decide_human_task`, where `has_approval_authority`, the pending-only guard and
> the audit event live — a governance hole, on the day approval limits went live.
> See `BACKEND_RPC_REQUIREMENTS.md` §Amendment Framework.

---

## Ranked gap list — ready for the Wave-2 migration session

Ranked by (exposure × sensitivity × how many surfaces one fix repairs).

| # | Gap | Fix | Size |
|---|---|---|---|
| **P0-1** | `list_de_skills` — no auth check, PUBLIC + anon EXECUTE | Add tenant gate + `can_access_de`; `REVOKE EXECUTE … FROM PUBLIC, anon` (must strip PUBLIC, per the mig-365 lesson) | XS |
| **P0-2** | `get_de_systems` — no auth check at all; leaks write/operate capability | Add tenant gate + `can_access_de` | XS |
| **P0-3** | `set_de_external_reply_mode` — any member can turn on automatic external replies | Add `auth_has_tenant_role(['tenant_owner','tenant_admin'])`; revoke PUBLIC/anon | XS |
| **P0-4** | `set_specialist_source_secret` — any member can overwrite a vault credential | Add owner/admin role gate | XS |
| **P1-5** | `install_technical_specialist` — any member can create a DE | Add owner/admin role gate | XS |
| **P1-6** | `ai_undo_change` — any member can revert docs/playbooks/DEs | Add owner/admin (or "the user who made the change") gate | S |
| **P1-7** | `respond_de_task` — any member can complete tasks and close objectives | Add owner/admin gate on the human path (mirror `request_de_task`, which already does this correctly) | S |
| **P1-8** | `record_kpi_reading`, `seed_trust_policies`, `cancel_case_continuation` — writes with no role gate | Add owner/admin gate to each | S |
| **P1-9** | `get_de_performance_metrics` — per-DE rows for every DE; feeds `list_de_health` + `get_de_kpi_status` | Add `AND public.can_access_de(er.de_id)` to the row filters — copy the pattern already proven in `get_de_csat_metrics` (mig 388). **One migration, three surfaces.** | M |
| **P1-10** | The four Record readers (docs/31's original ask): `get_de_experience`, `get_de_execution_log`, `get_de_agentic_runs`, `get_agentic_run_messages` | Add `can_access_de` to the DE-existence check each already performs; for `get_agentic_run_messages`, join `agentic_step_runs.de_id` and scope on that | S |
| **P1-11** | `list_de_memory_grouped` — memory contents, tenant-only | Add `can_access_de(p_de_id)`; revoke PUBLIC/anon | S |
| **P2-12** | `get_de_action_metrics`, `get_de_cost_metrics_ranged`, `get_de_inquiry_metrics`, `get_outcome_metering`, `list_de_health` — per-DE rows tenant-wide | Same row-filter pattern as P1-9 | M |
| **P2-13** | `de_certification_status`, `compute_de_lifecycle_readiness`, `compute_trust_evidence`, `get_de_gate_status`, `get_de_role_context`, `get_kpi_metrics_for_de`, `resolve_my_de_autonomy`, `list_de_specialists`, `list_consultable_for_de` | Add `can_access_de` to each DE lookup | M |
| **P2-14** | `list_de_assignments` — reveals the reporting line to any member | Founder decision: is the reporting line workspace-public or scoped? Then gate accordingly | XS + decision |
| **P2-15** | RLS: `de_decision_trace`, `de_exceptions`, `de_memory`, `de_objectives`, `de_training_progress`, `eval_judgments`, `role_certifications` are tenant-gated but have **no** `can_access_de` policy (§5) | Add `_de_scope` policies mirroring the ones already on `de_work_items` / `de_conversations` / `de_missions` | M |
| **P3-16** | 10 functions hold PUBLIC EXECUTE in `proacl` even where they fail closed | Housekeeping sweep: strip PUBLIC, grant `authenticated`/`service_role` explicitly | S |
| **P3-17** | `request_trust_promotion`, `submit_evidence_feedback` — DE-scoped but no role gate | Decision: keep as member-level proposals, or raise to manager+ | XS + decision |
| **P3-18** | ✅ **RESOLVED 2026-08-06** — panel deleted (see note under §amendment RPCs) | ~~Delete the panel, or build the RPCs~~ | S |
| **P3-19** | `create_de_team_mission` does not walk `target_spec` for DE scoping (documented in its own header, and in docs/30) | Known, pre-existing; carry forward | M |

---

## Full matrix — all 106 RPCs

Sorted by severity class. `tenant gate` = the function establishes the caller's tenant by any means. `role gate` is the *verified* gate, read from source, not the regex.

| RPC | Exists | SECDEF | anon | authenticated | tenant gate | role gate | can_access_de | Class | What it returns / does |
|---|---|---|---|---|---|---|---|---|---|
| `get_de_systems` | yes | yes | no | yes | no | **NONE — no auth check whatsoever** | no | **UNGUARDED** | per-DE connected systems incl. can_write / can_operate / write_registry |
| `list_de_skills` | yes | yes | **YES** | yes | no | **NONE — no auth check; anon + PUBLIC execute** | no | **UNGUARDED** | skill catalog + that DE's proficiency / sample size / signal |
| `ai_undo_change` | yes | yes | no | yes | yes | tenant member, NO role gate | no | **PRIV-GAP** | reverts knowledge_docs / playbook_definitions / digital_employees |
| `cancel_case_continuation` | yes | yes | **YES** | yes | yes | tenant member, NO role gate | no | **PRIV-GAP** | cancel a pending case continuation |
| `install_technical_specialist` | yes | yes | no | yes | yes | tenant member, NO role gate | no | **PRIV-GAP** | CREATES a digital employee |
| `record_kpi_reading` | yes | yes | no | yes | yes | tenant member, NO role gate | no | **PRIV-GAP** | writes a KPI reading against any DE |
| `respond_de_task` | yes | yes | no | yes | yes | tenant member, NO role gate | no | **PRIV-GAP** | marks a DE task accepted/completed/declined; closes objectives |
| `seed_trust_policies` | yes | yes | no | yes | yes | tenant member, NO role gate | no | **PRIV-GAP** | seeds workspace trust policies |
| `set_de_external_reply_mode` | yes | yes | **YES** | yes | yes | tenant member, NO role gate | no | **PRIV-GAP** | flips a DE draft → AUTO external replies |
| `set_specialist_source_secret` | yes | yes | no | yes | yes | tenant member, NO role gate | no | **PRIV-GAP** | WRITES A VAULT SECRET (source credential) |
| `compute_de_lifecycle_readiness` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE readiness (9 gate checks) |
| `compute_trust_evidence` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE trust evidence |
| `de_certification_status` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE cert state + config fingerprint |
| `get_agentic_run_messages` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | FULL REASONING TRANSCRIPT of an agentic run |
| `get_de_action_metrics` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE action decisions for EVERY DE in tenant |
| `get_de_agentic_runs` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE autonomous runs + cost |
| `get_de_cost_metrics_ranged` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE token spend for EVERY DE |
| `get_de_execution_log` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE execution log (model, confidence, spans) |
| `get_de_experience` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE experience ledger |
| `get_de_gate_status` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE records-gate reasons |
| `get_de_inquiry_metrics` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE inquiry metrics for EVERY DE |
| `get_de_performance_metrics` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE performance for EVERY DE (feeds list_de_health + get_de_kpi_status) |
| `get_de_role_context` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE domains, archetype, grants |
| `get_kpi_metrics_for_de` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | KPI catalog + applicability derived from the DE's grants |
| `get_outcome_metering` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | billable outcomes broken down per DE |
| `list_consultable_for_de` | yes | yes | **YES** | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE consult graph |
| `list_de_assignments` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | WHO is responsible for this DE (name + email) |
| `list_de_health` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | health + cost + escalation of EVERY DE |
| `list_de_memory_grouped` | yes | yes | **YES** | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE MEMORY CONTENTS |
| `list_de_specialists` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE specialist assignments |
| `resolve_my_de_autonomy` | yes | yes | no | yes | yes | tenant member only | no | **TENANT-ONLY** | per-DE dial resolution |
| `create_de_team_mission` | yes | yes | **YES** | yes | yes | manager+ AND can_access_de (target_spec not walked — known gap) | **yes** | **SCOPED\*** | Team mission |
| `request_trust_promotion` | yes | yes | no | yes | yes | can_access_de but NO role gate | **yes** | **SCOPED\*** | any member can raise a promotion request (creates a human task) |
| `submit_evidence_feedback` | yes | yes | no | yes | yes | can_access_de but NO role gate | **yes** | **SCOPED\*** | any member can file a verdict + open a revision request |
| `approve_amendment` | **NO** | — | — | — | — | — | — | **ABSENT** | Amendment card (RPC does not exist in DB) |
| `get_amendment_detail` | **NO** | — | — | — | — | — | — | **ABSENT** | Amendment card (RPC does not exist in DB) |
| `list_pending_amendments` | **NO** | — | — | — | — | — | — | **ABSENT** | Amendment widget (RPC does not exist in DB) |
| `reject_amendment` | **NO** | — | — | — | — | — | — | **ABSENT** | Amendment card (RPC does not exist in DB) |
| `request_amendment` | **NO** | — | — | — | — | — | — | **ABSENT** | Amendment wizard (RPC does not exist in DB) |
| `acknowledge_de_performance_review` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Performance — ack a review |
| `advance_de_lifecycle` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Governance — lifecycle |
| `assess_de_skills` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Skills panel |
| `attach_compliance_pack` | yes | yes | no | yes | yes | owner/admin/platform | no | SCOPED | Workbench — compliance |
| `certify_digital_employee` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Certification |
| `check_de_retirement_readiness` | yes | yes | no | yes | yes | owner/admin + can_access_de | **yes** | SCOPED | Governance |
| `create_de_development_item` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Development |
| `create_de_mission` | yes | yes | **YES** | yes | yes | manager+ AND can_access_de | **yes** | SCOPED | Mission panel |
| `create_digital_employee` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Hire |
| `decide_de_exception` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Workbench — Exceptions |
| `detect_de_development_needs` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Development |
| `forget_de_memory` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Workbench — Memory |
| `get_de_csat_metrics` | yes | yes | no | yes | yes | tenant member + can_access_de on rows | **yes** | SCOPED | Performance — CSAT |
| `get_de_economics` | yes | yes | no | yes | yes | tenant member + can_access_de on rows | **yes** | SCOPED | Performance — ROI |
| `get_de_kpi_status` | yes | yes | no | yes | yes | can_access_de + tenant | **yes** | SCOPED | Goals & KPIs |
| `get_de_operating_model` | yes | yes | no | yes | yes | tenant + can_access_de | **yes** | SCOPED | How I operate |
| `get_de_work_product` | yes | yes | no | yes | yes | tenant + can_access_de | **yes** | SCOPED | Record — lifetime ledger |
| `get_workforce_board` | yes | yes | no | yes | yes | tenant + can_access_de | **yes** | SCOPED | Work / board |
| `governance_decide_proposal` | yes | yes | **YES** | yes | yes | owner/admin | no | SCOPED | Governance AI panel |
| `install_role_kit` | yes | yes | no | yes | yes | owner/admin/manager | no | SCOPED | Hire |
| `install_role_systems` | yes | yes | no | yes | no | owner/admin (can_admin_tenant_internal) | no | SCOPED | Hire |
| `instantiate_role_archetype` | yes | yes | no | yes | yes | owner/admin/manager | no | SCOPED | Hire |
| `pause_digital_employee` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Governance |
| `remove_de_assignment` | yes | yes | no | yes | yes | manager+ (+ audit event, mig 429) | no | SCOPED | Responsible people |
| `request_de_task` | yes | yes | no | yes | yes | owner/admin on the human path | no | SCOPED | Delegated tasks |
| `resume_digital_employee` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Governance |
| `retire_digital_employee` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Governance |
| `review_de_incident` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Incidents |
| `revoke_de_certification` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Certification |
| `run_de_performance_review` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Performance |
| `set_de_assignment` | yes | yes | no | yes | yes | manager+ (+ audit event, mig 429) | no | SCOPED | Responsible people |
| `set_de_attributes` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Profile |
| `set_de_autonomy` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Trust dial |
| `set_de_availability` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Profile |
| `set_de_custom_escalation_rules` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Escalation |
| `set_de_escalation_rules` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Escalation |
| `set_de_identity` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Profile |
| `set_de_kpi` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | KPIs |
| `set_de_mission_state` | yes | yes | **YES** | yes | yes | manager+ + can_access_de | **yes** | SCOPED | Mission |
| `set_de_skill_proficiency` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Skills |
| `set_de_specialist` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Specialists |
| `set_de_supervisor` | yes | yes | **YES** | yes | yes | owner/admin/platform | no | SCOPED | Supervisor |
| `set_de_voice` | yes | yes | **YES** | yes | yes | owner/admin | no | SCOPED | Voice |
| `transfer_de_ownership` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Governance Owner (dead limb per docs/31 Q11) |
| `update_de_development_item_status` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Development |
| `update_digital_employee` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Profile |
| `upsert_de_objective` | yes | yes | no | yes | yes | owner/admin | no | SCOPED | Objectives |
| `append_audit_event` | yes | yes | no | yes | yes | tenant member; identity server-attested | no | N-A | audit write |
| `archive_workforce_team` | yes | yes | no | yes | yes | owner/admin | no | N-A | Teams (tenant-wide) |
| `end_platform_remote_access` | yes | yes | no | yes | yes | platform capability | no | N-A | platform |
| `get_escalation_signals` | yes | yes | no | yes | yes | tenant catalog | no | N-A | escalation signal catalog |
| `get_tenant_session_policy` | yes | yes | no | yes | yes | tenant member | no | N-A | tenant-wide policy |
| `list_certification_types` | yes | yes | **YES** | yes | yes | tenant catalog | no | N-A | cert types (global rows readable by anon) |
| `list_skill_categories` | yes | yes | **YES** | yes | yes | tenant catalog | no | N-A | skill categories (global rows readable by anon) |
| `list_team_members_full` | yes | yes | no | yes | yes | tenant member | no | N-A | full roster incl. emails — directory read |
| `my_account_status` | yes | yes | no | yes | yes | self | no | N-A | own profile |
| `remove_team_member` | yes | yes | no | yes | yes | owner/admin | no | N-A | Team |
| `set_team_member_status` | yes | yes | no | yes | yes | owner/admin | no | N-A | Team |
| `set_workforce_baselines` | yes | yes | no | yes | yes | owner/admin | no | N-A | tenant-wide baselines |
| `set_workforce_team_member` | yes | yes | no | yes | yes | owner/admin | no | N-A | Teams |
| `start_platform_remote_access` | yes | yes | no | yes | yes | platform capability + MFA | no | N-A | platform |
| `transfer_tenant_ownership` | yes | yes | no | yes | yes | owner only | no | N-A | Team |
| `update_team_member_department` | yes | yes | no | yes | yes | owner/admin | no | N-A | Team |
| `update_team_member_role` | yes | yes | no | yes | yes | owner/admin | no | N-A | Team |
| `upsert_kpi_metric` | yes | yes | no | yes | yes | owner/admin | no | N-A | tenant KPI catalog |
| `upsert_tenant_skill` | yes | yes | no | yes | yes | owner/admin | no | N-A | tenant skill catalog |
| `upsert_workforce_team` | yes | yes | no | yes | yes | owner/admin | no | N-A | Teams |

**Totals:** UNGUARDED 2 · PRIV-GAP 8 · TENANT-ONLY 21 · SCOPED\* 3 · ABSENT 5 · SCOPED 47 · N-A 20 = **106**.

---

## The `anon` column, read carefully

Twelve reachable RPCs are `anon`-executable. Ten of those carry PUBLIC EXECUTE (`=X/postgres`) in `proacl`, which is the exact gotcha recorded in the mig-365 note — a `REVOKE … FROM anon` that does not also strip PUBLIC accomplishes nothing.

I traced each one's behaviour under `anon` (where `auth.uid()` and therefore `auth_tenant_id()` are NULL):

**Fails closed (safe today, but should still be revoked as housekeeping):** `cancel_case_continuation`, `create_de_mission`, `create_de_team_mission`, `governance_decide_proposal`, `list_consultable_for_de`, `list_de_memory_grouped`, `set_de_external_reply_mode`, `set_de_mission_state`, `set_de_supervisor`, `set_de_voice`.

**Leaks the global catalog rows** (`WHERE tenant_id IS NULL OR tenant_id = auth_tenant_id()` → NULL branch still returns the platform-wide rows): `list_certification_types`, `list_skill_categories`. Low sensitivity — catalog labels — but it is an unauthenticated read of platform content.

**Leaks tenant data:** `list_de_skills`. See finding 2.

---

## §5 — Direct `.from()` table reads (RLS-governed, different story)

The Employee File also reads 59 tables directly. 46 of the meaningful ones were checked against `pg_policy`. **All have RLS enabled and all are tenant-gated** — the migration-330 baseline holds. But the employee-scoping picture is thin:

**Have a `can_access_de` policy (3):** `de_work_items`, `de_conversations`, `de_missions` — all added by the Wave-2 stream.

**Tenant-gated but NOT employee-scoped (the Workbench's core reading material):** `de_decision_trace` (reasoning traces), `de_exceptions`, `de_memory`, `de_objectives`, `de_training_progress`, `eval_judgments`, `role_certifications`, `de_deliverables`, `de_messages`, `de_development_items`, `de_incidents`, `de_performance_reviews`, `de_certifications`, `de_task_requests`, `de_consultation_grants`, `de_escalation_rules`, `de_lifecycle_events`, `de_playbook_charter`, `de_profile_fields`, `de_autonomy`, `de_case_events`, `work_watchers`, `data_access_grants`, `evidence_runs`, `evidence_run_decisions`, `spec_consultations`, `specialist_sources`, `media_assets`, `scribe_requests`, `tenant_activity_log`.

Their policies use the older `tenant_id IN (SELECT p.tenant_id FROM profiles p WHERE p.user_id = auth.uid())` idiom rather than `auth_tenant_id()`. Functionally equivalent for isolation, with one difference worth noting: **that idiom does not check `is_active`**, whereas `auth_tenant_id()` does (`coalesce(is_active,true) = true`). A deactivated teammate's JWT, until it expires, still satisfies these policies. Worth a consistency sweep alongside P2-15.

Three tables are deliberately world-readable and should stay that way: `ai_model_pricing` (`USING true`, writes blocked by `USING false`), `system_categories` (`USING true`, platform-admin write), `compliance_packs` (`auth.uid() IS NOT NULL`).

---

## What this pass could NOT prove

- **No RPC was executed.** Everything above is read from live function definitions and live grants. The two UNGUARDED functions are proven-unguarded *by definition*; I did not fire an `anon` or cross-tenant call to demonstrate the read, because the task confines me to read-only SELECT. One read-only `anon` call against `list_de_skills` would convert "proven-by-definition" into "proven-live" — say the word.
- **Whether GoTrue self-signup is still open.** `complete_signup` is now `anon = false`, which narrows the path to obtaining an `authenticated` token — but the auth-service signup setting is not visible from the database. This does not soften findings 1–4: with **15 tenants sharing one database**, any *legitimate* customer account is already enough to read another tenant's data through `get_de_systems` and `list_de_skills`. And `list_de_skills` needs no account at all.
- **Live exploitation risk today is low, and that is temporary.** The role census is 11 `tenant_admin`, 6 `tenant_owner`, 2 `platform_super_admin`, **1 `tenant_user`**. Only that single account sits below manager, so the TENANT-ONLY and PRIV-GAP classes are barely exercised right now. The docs/31 assignment drive (commitment #6) and any sub-manager onboarding is precisely the event that activates all 29 of them at once. **Fix before the drive, not after.**
- **Edge functions were not diffed.** Same limit docs/31 records as commitment #1 — these are database-side claims only, and database-side claims are the solid ones.
- **`get_de_operating_model` composes `get_workforce_board`.** Both apply `can_access_de` independently, so the composition is safe — but I read the two definitions, I did not test the composed call.
- **Non-Employee-File callers were not enumerated.** Fixing `get_de_systems` or `get_de_performance_metrics` will affect every other page that calls them. Grep for callers before shipping each migration.

---

## Handover notes for the Wave-2 migration session

1. **Do not delete `EmployeeFileStrip` and consider `get_de_systems` handled.** Removing a caller does not remove a `SECURITY DEFINER` function's exposure. Fix the function; then delete the tile if docs/31 §Q12 still wants it gone.
2. **Copy the pattern, don't invent one.** `get_de_csat_metrics` (mig 388) is the clean row-filter model for the metrics family. `get_de_operating_model` (mig 392) is the clean single-lookup-gate model for per-DE readers. `request_trust_promotion` (mig 419) is the correct NULL-tolerant form for nullable `de_id`.
3. **Every REVOKE must strip PUBLIC and use `ON ROUTINE`.** Ten of the twelve anon-executable functions inherit through PUBLIC, not through the `anon` grant.
4. **P1-9 is the best value per migration in the list:** one `can_access_de` row filter inside `get_de_performance_metrics` fixes Performance, `list_de_health` and `get_de_kpi_status` simultaneously.
5. Scratchpad artifacts (reachability script, SQL, raw JSON) are at
   `C:\Users\SPECTRE\AppData\Local\Temp\claude\D--Dream-Team-AI\9e864d5e-6118-4763-aad0-aba6670c7478\scratchpad\` — `reach.mjs`, `matrix.sql`, `prosrc*.sql`, `rls.sql`, `build.mjs`, `matrix.md`. Re-run `reach.mjs` after the tab reshuffle to re-derive the surface, since the merge changes which components mount.
