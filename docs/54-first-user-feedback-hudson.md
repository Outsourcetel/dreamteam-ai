# 54 — First-user feedback: Hudson & Family

**Date:** 2026-08-12 · **Source:** founder, first-time-user pass on a brand-new tenant
**Tenant:** Hudson & Family `1ad45721-5ec8-45e0-8fcd-7804ed8ec8df`, industry **Healthcare**,
status trial, created 2026-08-12 12:35 UTC via the real signup path.
**Status:** RESEARCH COMPLETE — 19 items, 10 parallel read-only agents. **Nothing applied.**
Awaiting founder decisions before any change.

Related: [49](49-full-review-inventory.md) inventory · [50](50-review-scorecard.md) scorecard ·
[47](47-debt-map.md) debt map. This document is Workstream **T (voice-of-user)** delivered early,
and it overlaps F (product gaps) and K (UX).

---

## 0. The three patterns

Nineteen separate complaints, but the research keeps landing on the same three shapes. These are
the finding; the item list below is evidence.

### Pattern 1 — the capability exists; the last hop is missing

Over and over, the thing the founder asked for is already built, already in the database, already
returned by the API — and then dropped one step before it reaches him.

| Thing | Where it already is | Where it dies |
|---|---|---|
| Skill descriptions + signal labels | in `skill_catalog`, returned by `list_de_skills`, declared in the TS type | **the render never prints them** (`EmployeeFileSections.tsx:383-408`) |
| Full-field guardrail edit | `guardrailApi.ts:144` supports rule/pattern/threshold/severity | **UI only ever sends `{active}`** (`CompliancePage.tsx:330`) |
| Mission cancel | RPC permits it from draft / awaiting_approval / approved / running / paused | **buttons rendered only for running\|paused** (`MissionPanel.tsx:179`) |
| Industry-aware setup | `INDUSTRY_TEMPLATES` — Healthcare recommends Patient Services + HR DEs and 3 clinical guardrails | **no seeding code reads `tenants.industry`** (6 of 928 fns mention it; all write or display) |
| AI governance authoring | `governanceAiApi` → `ai-session` → `governance_proposals` → human approve, fully wired | **0 rows ever, 0 tenants** |
| Per-role setup questions | every one of 15 `role_archetypes` ships 4–8 `setup_questions` | **they fire *after* you have already hired that role** |
| A counting primitive for quotas | `rate_limit_hit(bucket_key, window, max)` + `rate_limit_counters` | **wired to edge-fn abuse only, never to governance** |
| A designed quota model | `tenant_feature_toggles` — max_monthly_responses, soft_limit_alert_percent, `hard_limit_behavior` | **0 rows, 0 readers, zero refs in src/functions/scripts** |
| Risk on an approval | `approval_briefs.risk`, 91 rows already computed | **the gate ignores it** |

Dead or inert alongside them: `digital_employees.skills` jsonb (0-length on all 127 DEs),
`required_approval` (**zero runtime readers**), `channels[]` (empty on 100%), `de_config` (0 rows —
config versioning is dead), `escalation_signals.language` and `.destructive` (no caller ever
supplies them), `de_autonomy.max_amount_cents` (**NULL on all 25 rows**).

**The general law, stated by the approval-limits research and true across the whole review:**

> **A limit — or a feature — works only when the path it governs emits its measure automatically.**

Money limits have no amount. Spend caps have no ledger. Discount caps have no reader. Quota
toggles have no rows. This is why *building more* is usually the wrong instinct here.

### Pattern 2 — the defaults are demo payloads, not decisions

- **Finance DE + Account Success DE + both playbooks** come from feature flags `finance_de` /
  `account_de`. Mig 068's header: an earlier migration shipped a registry that *"actually GATED or
  PROVISIONED nothing"*; these two flags were chosen to prove the mechanism **because they were the
  only two that created visible standing state.** Demo payload for a plumbing fix.
- **The 2 governance rules** are seeded by a hardcoded `VALUES` list at
  `118_tenant_provisioning_contract.sql:51-78` whose own comment reads **"Same rules Acme
  validated"** — Acme Telecom, the support demo tenant.
- Result: a **Healthcare** company is handed refund and legal-threat rules, an Overdue-Invoice
  playbook and an Account-At-Risk playbook — **while a `hipaa` compliance pack sits unused in the
  catalogue.**

### Pattern 3 — surfaces that claim something they do not do

Same class as the already-known F-6 (phone said "Approved and sent." while the draft stayed
pending). Each of these is a lie the product tells a new customer:

- `CompliancePage.tsx:206` renders a stat tile **`{label:'Enforcement', value:'Live'}` as a
  hardcoded string** — while **2 of the 3 enforcement layers are off platform-wide** (semantic
  judge has no `platform_config` row so it fails inert; adjudication is `mode='shadow'`).
- The certification badge claims **"gates autonomy"**; on Hudson the exam button will fail
  `no_golden_qa`, and `require_certification` is **not enabled for Hudson at all**.
- **"Next up — in order"** renders a card headed *in order* whose body says *"Nothing on the
  schedule."* — 11 of 107 DEs show the empty card.
- The founder's own failed mission still offers a **"Compile plan" button that will fail
  identically** every time.
- `max_discount_pct` is configured on 5 rules and **has zero enforcement readers** — it is
  `string_agg`'d into a prompt. **Enforced by asking the model nicely.**
- Approval Limits presents itself as a money limiter and **is a category ACL** (below).

---

## 1. Per-item findings

Numbered as the founder wrote them (his first two items were both numbered "1").

### 1a — 4 default DEs + 2 playbooks; rethink onboarding
Two mechanisms, which is why nobody noticed the pile-up. **Triggers** make DE 1 (Workspace
Assistant, `auto_provision_new_tenant_trigger`, mig 196→332) and DE 2 (Onboarding Architect "Ada",
mig 143). **Feature flags** make DEs 3–4 *and both playbooks*:
`provision_tenant_baseline_internal` loops `reconcile_tenant_feature` over 24 default-on flags;
only 4 do anything and 2 of them mint a DE + playbook + connector grant.

**Removal cost: one `UPDATE` per flag**, reversible by design (`deprovision_starter_de_internal`
**pauses, never deletes**). `starter_finance_de`/`starter_account_de` have **zero references**
outside migrations and the baseline dump.

⚠ **ONE HARD BREAK:** `audit_tenant_feature_parity()` and
`audit_tenant_provisioning().baseline_complete` both require **`playbook_definitions >= 2`**.
Dropping both → **every workspace flagged weekly** by cron `tenant-feature-parity-weekly` →
`raise_ops_alert`. The threshold must move in the same change.

⚠ **ONE TRAP:** removing Ada would remove the `platform_admin` connector, and certify's
`workspace-admin-has-an-owner` is guarded by `exists(connector … category='platform_admin')` —
it would **vacuously pass**. Fix that gate regardless.

**Ada is load-bearing and is also the asked-for feature.** `onboarding-assist:57` matches her **by
literal name** (HTTP 409 `no_architect` without her) and she is the sole creator of the
`platform_admin` connector. Mig 143's intent: *"describe what they need and the DE proposes the
setup."* **26 proposals ever · 19 still undecided · 5 expired · 2 executed.** Wired and starved.

**Reusable engines for the discovery interview (all already built):**
`onboarding-assist` (free text → gated proposals; already injects the archetype catalog) ·
`de-mission` (directive → compiled plan; its `validateScope` is the *LLM proposes, server disposes*
pattern) · **`compile-trust-plan` — best built: validates against the LIVE validator with
reject-and-retry, returns an honest `unmapped`, writes nothing but an audit row** ·
`entity-draft` (role brief → config + **clarifying questions**) · `playbook-draft` (SOP → typed
steps + auto-repair + `playbook_gaps`) · **`ai-session` — the only multi-turn backbone, and
`subject_kind='workspace'` already exists.**

**Missing:** an actual interview (every surface is a one-shot textarea) · Ada cannot propose
guardrails or trust rules (4 verbs, one of them `create_specialist` **disabled but still offered in
her charter**, mig 143:60) · no role→connector recommendation (`required_connector_categories` is
display-only) · `TOP_PROVIDERS` has no `ads`/`social`/`web_analytics` so **4 of 15 archetypes
demand a category with no provider** · `proposeTailoredSetup` is **regex, not LLM**, and returns
all-nulls for most roles · no conversation-type recommender · `SuggestionAlert.tsx:11` is
**hardcoded placeholder data**.

### 1b — My Profile empty
All 18 Job-tab fields NULL. **Not a permissions bug** — `update_employee_profile` is SECURITY
DEFINER and the owner has `can_edit_job`. Four proven defects: (1) `full_name` **is** populated
("Derek McIntyre") and used everywhere else, but the drawer's `inline` mode
(`EmployeeProfileDrawer.tsx:379`) **discards the title** — My Profile is the only view that hides
the name we have; (2) `full_name` is **unsaveable** through this path (`field_not_editable`);
(3) `first_name`/`last_name` are **collected by nothing** — 0/21 profiles have `job_title`;
(4) `work_email` is never seeded from `auth.users.email`.

### 2 — Approval Limits
`approval_authority`: subject (org_unit | role | user, OR'd) × `category` (**free text, no enum**) ×
`max_amount_cents` + `second_approver_above_cents`. **No period, unit, count, window or on-breach.**
151 rows, 18/18 tenants. Only `decide_human_task` enforces; **zero callers in `src/` or
`supabase/functions/`**.

⚠⚠ **It is not even a money limiter. 0 of 186 `action_executions` carry `amount_cents`**, so
`has_approval_authority` returns early — *"Nothing financial attached: holding any matching grant is
enough."* **Today it is a category ACL.** Proven by live probe.

⚠ **The category axis leaks:** UI offers 11; pending tasks resolve to 12, of which **5 are not in
the dropdown** — 125 of 386 pending tasks. Roles `tenant_manager`/`approver` match zero profiles.
**Permissive-default trap PROVEN** (count is tenant-wide and category-blind) but **moot** — 627
seeded all 18.

**Market research, three corrections to the naive tuple:** subject is an *output* (split the match
predicate from the person's capacity) · **period is absent from every enterprise approval product
surveyed** (SAP, Oracle AMX, NetSuite, Coupa, Salesforce, ServiceNow are all per-transaction;
"Monthly Cumulative Limit" exists only in the *paper* DoA matrix) — **cumulative-over-period
authority is real governance with no vendor implementation, which is exactly the whitespace the
founder pointed at** · on-breach splits: approval systems **escalate**, quota systems **block**,
and **AWS Budgets Actions is the only precedent spanning both**.

**Proposed:** keep the holder + scope, replace the two money columns with a measure triple
(`measure_key`, `unit`, `limit_kind` ∈ per_transaction|per_period|outstanding|total, `period`,
`threshold`, `second_above`) plus `on_breach` ∈ escalate|block|warn. **The 151 existing rows
migrate as `money.amount/cents/per_transaction/null` — zero behaviour change.**
⭐ **Why this will work where money failed: money needs `amount_cents` *authored* into params by
each executor and nobody does it. Counts are already in the ledger.** Proven derivable today with
no new writes — approvals per approver per week from `human_tasks`, gated acts per category from
`action_executions`. Implement `count.*` as **views**, not new writes.
**Blast radius: 4 DB functions + 1 API file + 1 page.** ⚠ Do **not** touch
`decide_action_execution` — separate parallel gate; changing it creates a second decision path.

### 3 — "Your data" / Customers
Settings→Data offers exactly **3** kinds (`BooksImportCard.tsx:14-35`): invoices → `renewal_invoices`
(*not* `invoices`), agreements, contacts. Columns hardcoded in a TS record **and again** in the RPC.
**UI-only to add:** opportunities, agreements, contacts, activities (schema exists, ~0 rows).
**New schema required:** leads, orders, products, inventory, meetings, emails, receipts, call
transcripts, quotes.
⚠ **Two import doors** — `ImportCustomersModal` has column mapping, header aliases and a preview;
`BooksImportCard` has rigid exact headers and hard failure. **The better UX is the one buried in
Customers.** ⚠ `invoices` (5 rows) has **zero readers** — two tables, one concept.
⭐ **Unstructured types work TODAY:** `ingest-chunks:40,78` takes only `{doc_id}` and never inspects
the text, so meeting minutes and transcripts pasted as text already work — but `knowledge_docs` has
**no `doc_type`**, and `.docx/.eml/.vtt` are in no `accept=`.
⭐ **Vertical machinery exists:** `INDUSTRY_WORK_CONFIG` already carries per-industry vocabulary,
pipeline stages and entity fields — it just never reaches **object types**. Custom fields exist for
`customer_accounts` only (`tenant_entity_fields`, text|number|date).

### 4 — Review minutes — **the founder's hypothesis is wrong; this one is generic**
`review_time_standards` (mig 691) covers **11 task types**, and its CHECK list is **identical** to
`human_tasks_type_check` — no task type can exist unpriced. It **changes no behaviour**: only the
weekly digest and the benchmark report read it. It *feels* hardcoded because **every row is
`source='default'` — no tenant has ever overridden it.** Real defects anyway: an unreachable `3`
fallback that would silently lie if the CHECK lists drift; the 11-type list duplicated in **three**
places, and `TYPE_LABELS` **filters to keys it knows**, so a 12th type silently would not render;
and the report already attributes minutes **by DE** while the rate is tenant-wide.

### 5 + 6 — Governance rules / guardrail CRUD
The "2 rules" are the tenant's own `guardrail_rules` **filtered for display**
(`GuardrailAdjudicationPanel.tsx:87` — blocking + blocked_phrase/topic). Hudson has 7; 2 pass.
⭐ **The schema is NOT support-shaped** — a generic (regex **or** numeric threshold) × severity ×
scope engine with 9 rule types. **This is a content fix, not a rebuild.**
**CRUD:** create ✅ · **edit ❌ in practice** (API supports full-field; UI sends only `active`) ·
**delete ❌ three ways** — no function exists, no UI, and ⚠ **the GRANT is missing** (DELETE only to
`service_role`; the RLS policy is `FOR ALL` and *would* permit it, so a hand-rolled DELETE fails
**42501, not RLS**).
✅ **No shared-row risk** — all 7 are tenant-owned copies; the pack catalogue is copied on attach.
⚠ **AI authoring is fully built and has never been used once**: `governance_proposals` = **0 rows
ever**, and `created_by IS NOT NULL` on `guardrail_rules` = **0 across all 18 tenants** — not one
guardrail has ever been authored by a human or an AI in production. **0 proposals is equally
consistent with non-use and with silent failure; that is the single biggest open question here.**
Proposal actions are `add|pause|resume|edit` — **no delete**, so that path cannot satisfy item 6.

### 7 — DE naming
Three columns because mig `130:29` added `display_title` (a **job title**) without reconciling it
against `name` (internal) and `persona_name` (customer-visible). 75/127 have a persona, 72 differ;
only 8/127 have a display_title. **`coalesce(persona_name, name)` is already the standard at ~30
sites and in every DB function that returns a display name.** **Only 6 stragglers** —
`accessGrantsApi.ts:105` (**the founder's exact report**), `orgApi.ts:188` + RPC
`list_org_tree_core` (the sole DB outlier), `browserOperatorApi.ts:148`, `knowledgeApi.ts:436`,
`LiveWorkforceDEs.tsx:321`. ⚠ `audit_events.actor` stores the resolved name as text at write time,
so a rename will not retro-relabel history (correct, but worth knowing).

### 8 — Mission edit/delete
`de_missions` grants to `authenticated` are **SELECT only** (mig 716 revoked DML); both policies
are read. The only state-changer is `set_de_mission_state` accepting **`pause|resume|cancel`** —
no update, no delete, no re-word. **The UI gap is narrower than the RPC gap and both exist:** the
RPC permits cancel from draft/awaiting_approval/approved too, but `MissionPanel.tsx:179` renders it
only for running|paused — **`approved` has no buttons at all.** That half is a pure UI fix.
⚠ **Editing without re-compiling is unsafe** — `compiled_plan` is what the watchers and objectives
were built from, so a changed directive over a stale plan **makes the audit trail lie.** `cancel`
already implements the correct unwind (watchers deleted, work items cancelled, objectives
abandoned). Recommend: **edit free before approval; after approval it is cancel + duplicate.**
Live: 3 missions all-time; **the failed one is the founder's own** (2026-08-11, `cannot_do:` — the
compiler refused a CSM directive as outside that DE's role).

### 9 — Consolidate Mission / Identity & Purpose / trust
**Proven by the prompt itself:** `entity-draft:86` defines `purpose_statement` as *"a charter: what
this employee is FOR, its scope, and **hard limits**"* — "hard limits" is what the trust composer
compiles, "what it is FOR" is what the mission states. **Three writers, three storage shapes, one
concept — three *tenses*: charter → limits → standing orders.**
⚠⚠ **The trust-plan prose is NEVER STORED.** `compile-trust-plan`'s only server side-effect is one
audit row. Refresh and the sentence is gone; the ladders remain with no record of what produced
them. **Persisting it is a prerequisite for "modify or delete what the AI set up earlier."**
Identity & Purpose has **no AI on the panel** (the AI writes `purpose_statement` only at hire).
`de_config` has **0 rows** — versioning is dead.

### 10 — "Next up — in order"
**It is already conditional; the condition is wrong.** It also renders on `listens_live` or
`waiting_on_you>0`, producing a card titled *in order* reading *"Nothing on the schedule."*
**Census over 107 non-retired DEs: 8 real · 11 empty cards · 88 correctly hidden.** All 11 triggered
by pending `human_tasks`. **Hudson's 4 all correctly hide it.** Correct gate = `next_up.length>0`.
⚠ `archetype_key` would be a bad gate — only 22 of 107 DEs have one. Also: it is a **schedule**,
not a priority ranking — the title oversells it.

### 11 — Recent decisions
Hard `LIMIT 10`, no pagination, no scroll container. Doesn't bite yet (max 7 for any DE) — the
request is anticipatory but correct. ⚠ **There is no topic.** `evidence_runs` has no such column;
`work_category` is dead (1 of 284 rows); `kind` is useless (283/1). The only usable axis is
`evidence_run_decisions.source_category` — **the *system* category, not a topic**.
**Date filter is free; "topic" is a decision, not a task.**

### 12 — KPIs
`unit` is actually **free text** — the founder misread the symptom. The real ceilings:
direction locked to `higher|lower` by **two DB CHECKs plus a 2-option select**; `target` is one
scalar (no range, band, window or denominator); and ⚠⚠ **`upsert_kpi_metric` hardcodes
`source='manual'` — a tenant-defined metric can NEVER be computed by the platform. That is the
wall.** Only one consumer reads target/direction, and only for a display boolean. **0 tenant-defined
metrics on any tenant; 10 readings, all `source='system'`, zero manual.** The form silently drops
`description` though the RPC accepts it.
⭐ Extension point exists: `kpi_metric_catalog.source_config` + `domains[]` is already a mini DSL.
⚠ **First cost: the action-arm SQL is copy-pasted VERBATIM between `get_de_kpi_status` and
`snapshot_de_kpi_readings` (the code says so at `:27310`)** — every new shape must be written twice
or they diverge. Extract before extending.

### 13 — Performance reviews
⚠ **There is no prompt and no LLM.** `run_de_performance_review_internal` is deterministic SQL with
hardcoded thresholds, and **it ignores `de_kpis` entirely** — Goals and Reviews are disconnected.
⚠ **Proven bug in prod:** the window is a **rolling 13 weeks** while `period_start` is
`date_trunc('quarter')` — real rows exist labelled "quarter starting Jul 1" whose numbers span
**Apr 11 – Jul 11**.
⚠ **Hard blocker for custom cadence:** `UNIQUE (tenant_id, de_id, period_start)` means daily or
weekly reviews inside a quarter would **UPSERT the same row**.
⚠ **Adjacent trap:** the PIP upsert sets `due_date = current_date + 30` on conflict — **at daily
cadence the deadline is rewritten every day and can never come due.**
**Custom instructions means putting an LLM into a path that is currently fully deterministic and
auditable. That is the biggest single decision in this review.**

### 14 — Skills
⚠ `digital_employees.skills` jsonb is **dead** (0-length on all 127). Real skills are
`skill_catalog` + `de_skills` (615 rows, 17 tenants). **The 5 presets are global catalog rows and
every one already has a description AND a signal_label; `list_de_skills` returns both; the TS type
declares both; the render prints neither.** The create form drops both though the RPC accepts them.
⚠ **A skill does nothing at runtime — PROVEN, zero hits in `supabase/functions/`.** No prompt, no
routing, no tool-offer, no gate. **Adding descriptions is cosmetic — do not let it imply skills
became functional.** Update has no UI and a rename **re-slugifies, creating a new skill and
stranding the old one**; **delete has no RPC at all** (same for custom metrics).

### 15 — Customer replies
`external_reply_mode` CHECK is **`['draft','auto']` — there is no `off`**; default `draft`.
**Only `widget-ask:271` gates on it**; `email-inbound` uses it only to pick a front DE and does not
gate the send; `de-answer` never reads it.
⚠ **It is a workspace setting wearing a per-employee costume** — `widget-ask:260` picks ONE
tenant-wide front DE. In Outsourcetel, of 18 DEs exactly **one** has any external conversation, and
**158 of its 159 are `channel='exam'`**; tenant-wide there is **one** `hosted` conversation ever.
✅ Gate available at zero runtime risk: `category` (`Customer|Internal`, populated, **no runtime
reader**). ⚠ `channels[]` is dead — not usable.

### 16 — Attached procedures
Join is a bare FK `playbook_definitions.de_id` — no rank, no conditions, and **a procedure belongs
to exactly one DE, so attaching elsewhere silently steals it.** "Five" is a coincidence; there are
**three inconsistent caps** downstream (briefing `LIMIT 4 ORDER BY updated_at`; objective briefing
`LIMIT 1` by ts_rank; work compilation `.limit(5)` **with no ORDER BY**).
⚠⚠⚠ **RUNTIME SELECTION IS PROVEN UNDEFINED ON THE PRIMARY PATH.** `de-work/index.ts:187-196`
fetches 5 rows **with no `.order()`** and takes the first containing a `use_tool` step, then
`break`. Postgres row order without ORDER BY can change on VACUUM, index choice or a plan flip —
**and this is the path that turns a procedure into real work items.** The other selector ranks on
**name + description only**, never the steps, and its own migration header concedes *"empty/nonsense
objective → all ranks 0 → most-recent wins."*
**Minimum honest fix: add `ORDER BY` — one line, removes the nondeterminism today.**
✅ Verified: `sop_playbook` IS structured JSONB, and **`inbox` watchers never fire** (live kinds are
only state_condition 15 / date_horizon 7 / schedule 6). `work_watchers.config` is **the only real
condition language in the product** and is not linked to playbooks.

### 17 — Escalation
`de_escalation_rules (frustration_threshold, always_escalate_topics, custom_rules)`.
`escalation_signals` has **8 global rows: 4 conversation-shaped, 2 inert (`language`, `destructive`
— no caller supplies them), and exactly 2 (`action`, `amount`) serve a non-conversational DE.**
⚠ **Frustration is structurally privileged** — the only signal with its own top-level column, its
own labelled input, and **the only escalation that fires with no rule authored at all** (default 50).
Mig 262 already *tried* to de-support-shape this and did not finish.
⚠ **One `de_escalation_rules` row exists across all 18 tenants** — and **the founder's own only
custom rule is a `confidence` rule, not a sentiment rule.** His usage already disproves the model
the UI privileges.
**Market research → 12-class department-neutral taxonomy:** confidence/grounding · novelty ·
authority/limit · blast radius · irreversibility · policy/compliance · time/SLA · input quality ·
ambiguity · repeated failure · tool/system failure · **counterparty state (the only channel-specific
class — sentiment is one member of it)**. Frameworks: ITIL 4 · DoA matrix + maker-checker ·
EU AI Act Art. 14 (+ selective prediction / learning-to-defer).
⭐ **THE HIGHEST-VALUE IDEA IN THE REVIEW — escalation *direction*.** ITIL separates **functional**
escalation (sideways, to more *skill*) from **hierarchical** (upward, to more *authority*).
**This product already has both organs — `specialist-consult` and `approval_authority` +
`assigned_role` — and routes them through one undifferentiated queue.**
**7 of 12 classes already fire in production** — the gap is a config surface and a shared
vocabulary, not an engine. **Only 2 need new machinery:** blast radius (`human_tasks.priority` is
written, never computed) and real SLA config (`sla_due_at` is write-only — 32 of 201 escalations,
0 of every other task type). ⚠ **No canonical `create_human_task` RPC** — 20+ SQL fns and 15+ edge
fns insert directly, which is why the task vocabulary drifted.

### 18 — "May do on its own" × 2
**Two distinct features rendered adjacently.** Dials (`DEActionDials.tsx:101`) write `de_autonomy`
with `action_type='action:<category>'`; the trust ladder writes `trust_policies`, and a promotion
writes `de_autonomy` with `action_type='action_execute'`.
⚠⚠⚠ **They write the same enforced table under different keys, and `decide_action_execution`
resolves specific-first (`['action:'||category, p_action_type, 'action_execute']`). A dial set in
the top panel SILENTLY PRE-EMPTS THE ENTIRE EARNED-TRUST LADDER below it — and neither panel says
so.** Hudson's live rows show the collision exactly. This is the *two-paths-one-counted* trap, live.
**The single choke point is `decide_action_execution`** (connector-hub:7254,
playbook-execute:1382). A custom rule is real only if it lands in `guardrail_rules`, `de_autonomy`
or the `destructive` flag.
⚠⚠ **The decorative-text trap, named:** `de-mission:184` injects trust level into the prompt and
`get_de_briefing` injects playbooks as prose. **A free-text "custom rules" box writing to a text
column would be a gate that cannot fail.** The honest precedent to copy is `TrustPlanComposerPanel`
— compile → draft → approve through validated writers, with absolute prohibitions turned into
**guardrail suggestions the user must action.**
Inert: `trust_level` (one reader; all 127 DEs `supervised`) · `required_approval` (**dead column**).
Not expressible at all: time-of-day, counterparty, per-customer, conditionals, sequencing.

### 19 — Certifications
**Two unrelated systems share the name.** Exam: `golden_qa` → `eval_runs` → `certify_de_from_eval`
→ `role_certifications` (with `config_fingerprint`). Governance: `certification_types` +
`de_certifications` — **globally empty, no UI writer.**
Hudson: **0 role_certifications, 0 de_certifications, 0 golden_qa.** ⚠ **Pressing "Run
certification exam" will fail `no_golden_qa`** while the badge claims "gates autonomy".
`require_certification` is **not enabled for Hudson at all** (no override row; 16 tenants have one,
Hudson is not among them) — and by census the flag is **very nearly theatre** (only 2 DEs
platform-wide were hired after opt-in, and the branch also requires an exam to exist).
**The unconditional trigger `trg_gate_de_certification` IS real** and reads no feature flag —
Hudson's 3 published DEs bypassed it only because they were **inserted, not transitioned**.
Custom exams are authorable but **only on `LiveProvingGround`, not the DE page**; no
custom-instruction field exists anywhere. ⚠ **No time expiry on `role_certifications`** — a
six-month-old cert on unchanged config reads "certified" forever. **Visibility is score-only** —
`eval_run_id` exists in the table and is not surfaced, so there is no way to see what was asked or
what failed. The founder's complaint is accurate.

---

## 2. Evidence standard

All of the above is **PROVEN** — read from current source at the cited line, or measured by
read-only SQL against the live database — except where marked inferred. Nothing was executed that
writes. Notable **not-checked** items carried forward:

- **No page was rendered in a browser.** Every UI claim is from source. (The founder's own
  observations are the counter-evidence, and they matched every time.)
- The approval-limits agent **did not confirm `scripts/db-query.mjs` targets production**; other
  agents' tenant counts (18) are consistent with prod.
- `governance_proposals` = 0 **cannot distinguish non-use from silent failure** — must be tested by
  clicking, not queried.
- No playbook was run end-to-end, so the arbitrary-selection finding is from source + schema, not
  an observed flip.
- Market-research URLs were gathered by subagents and not individually re-verified.
- `npm run certify` was **read, not executed**.

---

## 3. Staging — FOUNDER DECISIONS TAKEN 2026-08-12

**Approved: Stages A + B now.** Sequenced so that **truth-telling fixes come before new build**,
because three of the items are surfaces that currently lie.

**Four decisions, on the record:**
1. **Start with A + B together** — *and Stage D (the discovery interview) is explicitly NOT to be
   forgotten.* It stays on the roadmap as the keystone; it is deferred, not dropped.
2. **Default-DE removal applies to NEW TENANTS ONLY.** The existing 17 workspaces keep the Finance
   and Account Success DEs they already have. Nothing currently on screen changes.
3. **Retire, not delete.** A removed guardrail stops applying and leaves the working list, but the
   row survives so the audit trail can still explain a past block. Matches the repo precedent set
   when the Specialist role was retired (mig 611). Reversible.
4. **Performance reviews: deterministic verdict + optional AI narrative.** Any cadence
   (daily→yearly or custom range); the verdict starts judging against the tenant's own KPIs instead
   of three hardcoded numbers, and stays reproducible. Custom free-text instructions produce a
   written commentary **alongside**, clearly marked AI-written, and **never the verdict.**
   *(Stage C — recorded now so the design is not re-litigated later.)*

**Stage A — the new-customer experience (items 1a, 1b, 5-seed, 7, 10 + the three lying surfaces).**
Turn off the two demo flags and move the parity threshold in the same change · make seeding read
`industry` and use the `INDUSTRY_TEMPLATES` that already exist (incl. attaching the HIPAA pack) ·
fix the 6 naming stragglers · fix the `next_up` gate · replace the hardcoded "Enforcement: Live"
tile with the real state · make My Profile show and save the name we already have · fix the
vacuously-passing `workspace-admin-has-an-owner` gate.

**Stage B — last-hop fixes, disproportionate value per line (items 6, 8-partial, 11-partial, 14,
15, 16).** `ORDER BY` at `de-work:187` (**a live correctness bug**) · render the skill descriptions
that already arrive · wire the guardrail edit UI to the API that already supports it, and add the
missing DELETE grant + RPC · render mission Cancel in the three missing states · scroll + date
filter on recent decisions · gate Customer replies on `category` and add an `off` state.

**Stage C — consolidations needing design (items 9, 12, 13, 18).** Fix the silent dial-over-ladder
override **first — that is a bug, not a design question** · then charter → limits → standing orders
as one sequence, with the trust prose persisted · KPI model · review cadence.

**Stage D — genuinely new build (items 1-rethink, 2, 3, 17, 19).** The discovery interview
(multi-turn on `ai-session`, `setup_questions` hoisted pre-hire, Ada's verbs widened to guardrails
and trust) · the generalized authority model · object types / Your Data vs Customers · the
escalation taxonomy and direction · certification purpose.

---

## 4. Stage A + B — BUILT 2026-08-12, NOT YET APPLIED OR COMMITTED

Four migrations written (`723`–`726`), **none applied**. 13 source files changed.
`npm run typecheck` exit 0 · `npm run build` ✓ 21.7s · `npm test` **166/166 assertions pass**
(one suite red in TEARDOWN only — see below, not caused by this work).

| Item | What shipped |
|---|---|
| 1a defaults | **723** — `finance_de`/`account_de` `default_enabled → false`; baseline contract's `playbooks >= 2` clause dropped in the same transaction; EXECUTE grants re-asserted with a deliberate asymmetry; 3 self-checks incl. both directions of the grant |
| 1b profile | **725** + drawer — `full_name` added to `v_self_ok` AND `v_hr_ok` AND **the `UPDATE ... SET` clause**; inline identity card; SetupChecklist; `work_email` offered, never prefilled |
| 5 (partial) | Enforcement tile now derived from `guardrail_enforcement_status()`; can never say "Live" again |
| 6 guardrails | **726** — edit via the existing composer; **retire** (`retired_at` + `active=false` under one CHECK) with a Restore shelf; 16 readers enumerated, 1 needed editing |
| 7 naming | **724** + 5 client sites — `coalesce(nullif(persona_name,''), name)` |
| 8 mission | Cancel rendered for all 5 permitted states; honest unwind dialog; `cannot_do:` retry removed |
| 10 next-up | Gated on `next_up.length > 0`; heading → "Next up — by when" |
| 11 decisions | Limit 10→50, scroll container, **query-side** date filter, "System" filter (never "Topic") |
| 14 skills | Description + signal_label rendered and collectable; "not a gate" honesty strengthened |
| 15 replies | Gated on `category='Customer'`; Internal employees get an honest not-applicable card |
| 16 procedures | `de-work:187` ORDER BY — **the live nondeterminism is closed** |

### Four errors in my own briefs, caught by verification rather than trust
Recorded because each would have shipped a defect, and the pattern is the point.
1. **`display_title` is `''`, not NULL, on 119 of 127 DEs** — a plain `coalesce` would have rendered
   nameless rows. Hence `nullif`.
2. **`waiting_on_you` was NOT already covered by the waiting banner.** The banner reads
   `de_work_items.status='waiting_human'`; the board counts pending `human_tasks`. Different tables.
   Live query: 17 DEs have pending tasks, **11 have no waiting work item — exactly the 11 from the
   census.** Following my brief literally would have deleted that count for precisely the employees
   that had it.
3. **Adding `full_name` to the self-editable set alone would not have worked** — the gate is
   `case when v_is_hr then v_hr_ok else v_self_ok end`, either/or not union, and a tenant_owner
   takes the HR branch.
4. **Worse: the `UPDATE ... SET` clause had no `full_name` column**, so an allow-list entry alone
   would have returned `ok=true, changed=1, fields:['full_name']` and stored nothing —
   **success reported on a write that never happened**, the F-6 class exactly.

### Verified, and not verified
- **Verified:** typecheck, build, 166 test assertions, every claim above re-measured against live
  data by the implementing agent, blast radius of 723 enumerated (only 2 functions anywhere assert
  a playbook count), grant asymmetry asserted in both directions.
- **NOT verified:** nothing was rendered in a browser. Layout of the new filter bar, scroll
  container, identity card, retired shelf and confirm dialogs is inferred from the design-system
  primitives, not seen. The migrations are unapplied, so no end-to-end path (name save, retire,
  cancel) has been exercised.
- **Cross-session finding, not ours:** `tests/tenant-isolation.test.ts` fails in teardown —
  migration **717** (a parallel session's revoke sweep) removed `('customer_accounts','DELETE')`
  from `authenticated`. The revoke looks correct; the test should clean up as `service_role`.
  A red suite hides real regressions, so this needs an owner.

### Deploy ordering
⚠ **725 must be applied BEFORE the profile UI ships.** `update_employee_profile` raises on the
first disallowed key and aborts the whole patch, so against today's live function editing your name
would fail the *entire* save, not just that field.
