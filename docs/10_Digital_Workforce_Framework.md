# 10 — Digital Workforce Framework

**DreamTeam AI — Constitutional Framework for the Digital Workforce**
Version 1.0 | 2026-07-01

---

## Table of Contents

1. [Digital Workforce Philosophy](#1-digital-workforce-philosophy)
2. [Workforce Structure](#2-workforce-structure)
3. [Digital Employee Blueprint](#3-digital-employee-blueprint)
4. [Skills Framework](#4-skills-framework)
5. [Responsibilities Framework](#5-responsibilities-framework)
6. [Capability Assignment](#6-capability-assignment)
7. [Workforce Teams](#7-workforce-teams)
8. [Lifecycle](#8-lifecycle)
9. [Development Framework](#9-development-framework)
10. [Performance Management](#10-performance-management)
11. [Workforce Health](#11-workforce-health)
12. [Workforce Economics](#12-workforce-economics)
13. [Governance](#13-governance)
14. [Marketplace Readiness](#14-marketplace-readiness)
15. [Anti-Patterns](#15-anti-patterns)
16. [Immutable Principles](#16-immutable-principles)

---

## 0. Implementation Status — read this first

*Added 2026-07-09. This document specifies the constitution; it does not report on itself. Every section below was written as the target, and for a long time nothing marked which parts of the target had actually been reached. That silence let real drift go unnoticed. This ledger closes that gap, using the same discipline already established in [`TRUST-AND-ARCHITECTURE.md`](TRUST-AND-ARCHITECTURE.md): every claim is labeled **Live** (built, verified against the deployed schema/code), **Partial** (a real piece exists but falls short of the spec below), **Designed** (schema/hooks exist, reserved, unused), or **Roadmap** (not started). When in doubt, downgrade the label — this ledger is only useful if it never rounds up. Re-verify against the live migrations before trusting a label more than a few weeks old; this codebase moves fast.*

| # | Concept | Status | Evidence |
|---|---|---|---|
| §2 | Knowledge Scope, Tool Access, Connector Access (the Control Fabric) | **Live** | `data_access_grants` (029) + `knowledge_doc_scopes` (030), enforced server-side, default-deny, real admin UI (Data Access page, per-doc "who can use this" modal). The most mature piece of this document. |
| §2 | Workforce Teams | **Partial** | `workforce_teams` + ranked members with enforced fallback chains (migration 128) — see the §7.1–7.5 row below for scope. |
| §2 | Memory (Working / Conversation / Organisational, three-tier) | **Partial** | Per-DE experience memory is real (`de_experience`/`resolve_experience`, 045) but only wired into the specialist-consult evidence pipeline, not a general three-tier model. `conversation_facts` (045) covers short-term in-conversation state only. |
| §3.1–3.2 | Identity & Purpose (`display_title`, `avatar_url`, `slug`, `purpose_statement`, `primary_business_outcome`) | **Live (core fields)** | Migration 130 (2026-07-11): `display_title`, `purpose_statement`, `primary_business_outcome` columns + `set_de_identity()` (versioned, audited) — and genuinely CONSUMED: title + purpose feed the answering persona's system prompt (dePersona), responsibilities finally have an edit surface (they're a §8 identity criterion). Not built: `avatar_url`, `slug` (no consuming surface yet). |
| §3.3 | Workforce Role & Classification (`workforce_role` enum, `seniority_level`) | **Roadmap** | `department`/`category` are free text/loose enum, not a job-family classification with seniority-driven default autonomy. |
| §3.4–3.6 | Responsibilities, Capability assignment, Skills Profile | **Partial** | Skills Profile is now **Live** (migration 127, 2026-07-11): `de_skills` assessed from real 30-day evidence — see §4. `responsibilities[]`, `capabilities`, `model_config` remain dead columns (seed-time only). |
| §3.7 | Knowledge Scope | **Live** | Same as §2 above. |
| §3.8–3.9 | Tool Access, Connector Access | **Live** | Same as §2 above — this is the one place the Blueprint's ambition is fully met. |
| §3.10–3.12 | Policies, Approval Rules, Escalation Rules | **Live (per-DE)** | The trust dial resolves per-DE with tenant fallback (migration 108); escalation rules are now a per-DE structured object with workspace fallback — frustration threshold + always-escalate topics, consumed by both live triage paths (migration 124, 2026-07-11). Amount thresholds live in the unified action gate (migration 125). |
| §3.13 | Goals & KPIs | **Live (honest form)** | Migration 130 (2026-07-11): `de_kpis` — targets against a curated set of metrics the platform ACTUALLY measures; `current` is computed at read time from the same real metric functions as the Performance page (`get_de_kpi_status`), never stored or fabricated; no measurable sample → null, not zero. Free-form `goals` with arbitrary metrics deliberately not built — a goal against an unmeasured metric would be decoration. |
| §3.14 | Performance Profile | **Partial** | Real per-DE resolution/confidence/escalation/error-rate/cost/frustration metrics exist and are shown live (Performance page), but not in this exact schema shape, and with no quarterly review cadence. |
| §3.15 | Trust Level (promotion & demotion) | **Partial — further along than it looks.** | The evidence-based promote/demote machinery is genuinely **Live** (`trust_policies`, migration 025 — server-computed evidence, human-gated promotion with re-verification and self-approval blocked, *automatic* demotion on eval regression or guardrail block). What's missing is only the `de_id` granularity: today it resolves per `(tenant, action_category)`, not per individual DE — and the column for that is already sitting in the schema, reserved and commented, unfinished. See `docs/ROADMAP.md` "R5.5 — Earned-Trust Progression." |
| §3.16 | Incident Record | **Live** | `de_incidents` (migration 123, 2026-07-11): durable rows with kind/severity, open→reviewed→closed lifecycle, resolution notes, provenance back to source events; idempotent 5-minute capture sweep across 5 sources; review RPC + profile panel. |
| §3.17 | Health Profile (DE-level) | **Roadmap** | A near-identical *account*-health model is real (Customer Success health scoring) — the same pattern has not been applied to DE operational health. |
| §3.18 | Cost Profile | **Partial** | Per-DE token usage tracking and tenant AI budget enforcement are real and live. `fte_equivalent` and `roi_score` are dead/unpopulated fields — no executive ROI reporting exists yet. |
| §3.19 | Availability | **Partial (schedule only)** | Migration 130 (2026-07-11): `availability` (always_on / business_hours with timezone, hours, days) enforced at the inbox-poll gate — off-schedule falls through the same chain as paused (team backup → specialist), fail-open on malformed config so a typo'd timezone never silently stops a live inbox. Reactive Q&A stays available off-schedule (the §8 sandbox deviation). `max_concurrent_tasks` / `queue_overflow_behavior` deliberately NOT built — no concurrency or queue machinery exists to honor them. |
| §3.20 | Development Record | **Partial** | The tenant-wide audit trail is real and strong; a dedicated per-DE `development_history`/`certifications` structure is not. |
| §4 | Skills Framework | **Partial (evidence-assessed slice)** | Migration 127 (2026-07-11): 5 platform skills (one per §4.2 category), each bound to ONE real 30-day evidence signal, assessed daily + on demand. §4.4's discipline enforced structurally: below min sample → NULL ("not yet assessed"), auto-assessment caps at level 4 (Expert is human-awarded), `skill_updated` events on material change, sub-threshold skills drive a `skill_gap` Development item (§4.5). Not built: per-work-category skill breakdown (needs evidence tagged with the capability exercised). |
| §5 | Responsibilities Framework | **Roadmap** | Not started — see §3.4. |
| §6 | Capability Assignment (primary/backup, proficiency) | **Roadmap** | A `capabilities` table exists (002) but not this many-to-many assignment model with primary/backup resilience. |
| §7.1–7.5 | Workforce Teams | **Partial (fallback chains live)** | Migration 128 (2026-07-11): `workforce_teams` + ranked members; §7.5's fallback chain is genuinely enforced in inbox ownership — the lowest-rank ELIGIBLE member owns each shared work source, backups take over automatically on pause/retirement, composing with the lifecycle gate and specialist fallback (primary DE → backup DE → specialist). Teams never grant access (Control Fabric stays sovereign). Not built: routing rules, load balancing, team memory, team KPIs — no machinery exists to honor them yet. |
| §7.6 | DE Composition (sub-agent delegation) | **Partial (deliberately bounded)** | Migration 111 shipped ONE real DE-to-DE delegation (Support DE → Finance DE, one scoped billing question, answered from the target's own access) — not the full pattern this section describes. No Coordinator role, no multi-target fan-out, no result synthesis across DEs, single-hop only by construction (a consulted DE's own evidence-gathering cannot itself delegate further). Justified as argued-but-not-observed (no live ticket was actually stuck on this), built as a deliberate exception to this section's own "not before Phase 3" gate rather than as full Composition — see the governance rules this migration DID keep: explicit tenant-admin allow-list (`de_consultation_grants`), the target's own Responsibility/Policy constraints govern the answer (never the requester's), and every consultation is a distinct audited event. |
| §8 | Lifecycle (governance gates) | **Live (10 of 12 stages)** | Migration 126 (2026-07-11): the full pre-launch chain (Designed→…→Assigned) enforced via `advance_de_lifecycle` with real entry criteria per stage (identity, Control Fabric grant, embedded knowledge, golden-QA pass, named human certification, work channel); Assigned→Active auto-detected from first real execution (5-min sweep); Paused has teeth (stops polling, answering, playbooks; note-gated resume); retirement unchanged (110). Enforcement points: poll targets, widget/chat answering eligibility, playbook run start. Scoped deviation recorded in the migration: reactive Q&A stays available pre-launch as the sandbox surface. Not built: Archived (cold storage) and Marketplace certification. |
| §9 | Development Framework | **Live (core), Partial (§9.3–9.4)** | `de_development_items` (112) + daily detection cron (125) + `skill_gap` items (127) + §9.5 Certifications (129, 2026-07-11): `de_certifications` — typed (workspace/compliance/capability), scoped, issued by a named human, EXPIRING; expiry warnings at 14 days, expiry raises a `certification_expired` incident; lifecycle certification (126) auto-issues the workspace cert. Not built: Partner/Industry certs (marketplace), §9.3's targeted re-test loop, §9.4 capability-version upgrade flow. |
| §10 | Performance Management (reviews, PIPs, benchmarking) | **Live (reviews + PIPs)** | Migration 129 (2026-07-11): quarterly Performance Reviews (scheduled cron + on demand) — durable records with honest verdicts (meets/below/insufficient_data — never a fabricated judgment on <10 decisions), real metrics snapshots, human acknowledgment. §10.4 PIPs: a 'below' verdict opens a PIP with a formal 30-day deadline and a WRITTEN consequence; the daily governance sweep re-measures overdue PIPs — targets met → completed, still failing → 'failed' + CRITICAL incident routed to human trust review (deliberately no automatic pause/demotion — a cron must not fire an employee). §10.3's 48-hour critical-incident review SLA gets a real daily nudge. Not built: §10.5 cross-tenant benchmarks (needs opt-in anonymised aggregation). |
| §11 | Workforce Health (DE-level) | **Partial (evidence-grounded slice)** | `list_de_health()` (migration 112) composes a real per-DE state from signals that are already live — but implements only the subset of the spec's 11 states with a real, attributable-per-DE signal today (`incident_active`, `degraded`, `low_confidence`, `high_cost`, `improving`, `healthy`, `insufficient_data`, `retired`). Deliberately NOT implemented: `policy_restricted`, `awaiting_approval`, `knowledge_outdated`, `connector_failure`, `certification_expired` — none have a real signal in this codebase; faking one was rejected on the same "no fabricated data" grounds as FTE/ROI below. |
| §12 | Workforce Economics (FTE, ROI, executive reporting) | **Partial** | Cost tracking and budget enforcement are real; migration 112 adds a real cost-per-resolved-task number (joining `get_de_cost_metrics` + `get_de_performance_metrics`, both already real) as an honest proxy for §12.2's unit-economics goal. FTE Equivalent, ROI, and the executive report suite remain explicitly unbuilt — both need org-configured `avg_human_task_time_minutes`/`avg_human_fte_cost_usd` that exist nowhere in this codebase, and inventing them would mean fabricating exactly the kind of number this codebase has repeatedly refused to fake (see `LivePerformancePage`'s own comment: "no assumed human-cost comparison, since there's no real baseline to compare against yet"). |
| §13.2 | Permission Governance | **Live** | This is exactly what the Control Fabric (§2) already does. |
| §13.3–13.4 | Approval & Policy Governance | **Partial** | Real but coarser than the spec — see §3.10–3.12. |
| §13.5 | Versioning Governance | **Partial** | `config_version` (migration 110) increments on every genuine config edit via `update_digital_employee()`, and full before/after history is real (reused `tenant_activity_log`'s existing trigger, not a new mechanism). Missing: the spec's "lightweight re-certification for major changes" — a version bump today doesn't affect `lifecycle_status` or trust standing at all. |
| §13.6 | Ownership Governance (owner, transfer) | **Live** | `owner_id` (backfilled from `created_by` for every existing DE) + `transfer_de_ownership()` — a real, audited, role-gated transfer to another active workspace member. |
| §13.7 | Retirement Governance | **Partial** | `retire_digital_employee()` genuinely refuses (not just discourages) while `check_de_retirement_readiness()` finds open escalations, pending action approvals, playbook assignments, or active charter bindings — real counts against real tables, and the RLS DELETE policy that let anyone bypass this via a raw client call was removed outright. Missing from the full spec: a separate compliance-officer confirmation step, and `data_access_grants`/`knowledge_doc_scopes` are not touched on retirement (only `de_playbook_charter`/`de_autonomy` are soft-disabled). |
| §14 | Marketplace Readiness | **Roadmap** | Not started. |
| §15 | Anti-Patterns | *Doctrine* | Worth flagging which ones the current gaps above put at risk if left unaddressed: §15.9 (DE Composition Without Governance — moot until §7.6 exists). §15.8 (Trust Level Inflation) is actively **well-guarded** by the real promotion machinery in §3.15. §15.10 (Retiring Without Resolution) is now genuinely enforced server-side, not just discouraged — see §13.7. §15.3 (Unmanaged Development) is better than it was — a real edit surface with versioning exists (§13.5) — but still not a full development-plan-gated process. |
| §16 | Immutable Principles | *Doctrine* | Principle 3 ("trust is earned") is **true today** — per-DE granularity since migrations 108/125. Principle 9 ("incidents are managed") is **true** since migration 123 (durable Incident Record with review lifecycle). Principle 11 ("FTE Equivalent is auditable") is not violated (nothing is fabricated) but not fulfilled either — an honest empty state until tenant-configured baselines exist (DE-C5). |

---

## 1. Digital Workforce Philosophy

### 1.1 The Fundamental Premise

DreamTeam is built on a premise that most AI platforms miss entirely: **organisations do not want AI tools. They want capable, accountable, measurable colleagues.**

When a company hires a human Support Manager, they do not ask which neural pathways the manager uses to recall product information. They ask: what are you responsible for, how will we measure your success, who do you report to, and how do we ensure you act within policy?

A Digital Workforce applies the same expectations to AI-powered team members. Customers hire **Digital Employees** — named, configured, governed, measurable members of their workforce. The AI models underneath are infrastructure, invisible to the customer and irrelevant to their workforce management practice.

This is not a metaphor. It is an architectural commitment that shapes every design decision in the platform.

### 1.2 Why Employee, Not Tool

The "AI as tool" model has well-documented enterprise failure modes:

- **No accountability** — tools don't have Responsibilities; they have functions. When a tool produces a wrong result, the question is "why did it fail?" rather than "who was accountable?"
- **No governance** — tools don't have autonomy boundaries, approval rules, or escalation behaviour. They either work or they don't.
- **No measurability** — tools produce outputs; they don't produce Business Outcomes. You cannot conduct a performance review of a tool.
- **No lifecycle** — tools are deployed and forgotten. They don't improve, they don't earn trust, they don't retire.
- **No trust model** — enterprises cannot grant increasing autonomy to a tool based on its track record. Trust is binary: it works or it doesn't.

The Digital Employee model resolves all of these. A Digital Employee has Responsibilities (who is accountable), Policies (what it can and cannot do), a Performance Profile (how well it is doing), a Trust Level (how much autonomy it has earned), and a Lifecycle (it is hired, developed, and eventually retired).

### 1.3 How Digital Employees Complement Human Employees

Digital Employees are not replacements. They are complements — they handle the repeatable, structured, high-volume, data-intensive work that consumes human capacity without requiring human judgment. This frees human employees to apply judgment, creativity, relationship management, and strategic thinking.

The model is collaborative:

- **Digital Employees handle volume** — answering the 400th version of the same customer question, reviewing the 10,000th transaction for anomalies, qualifying the 50th lead of the day.
- **Human Employees provide judgment** — handling the exceptions, the edge cases, the relationship moments, the strategic decisions.
- **The Handoff mechanism** makes this collaboration seamless — a Digital Employee that reaches its confidence boundary or hits an escalation trigger hands the context, history, and recommendation to a human colleague. The human picks up in context, not cold.

The organisation gains capacity and speed from the Digital Workforce without sacrificing the human judgment that defines their brand.

### 1.4 The Governing Philosophy in Three Sentences

Customers hire Digital Employees — not AI models.
Customers manage a Digital Workforce — not prompts.
Customers optimise Business Outcomes — not token usage.

Everything in this framework exists to honour these three commitments.

---

## 2. Workforce Structure

### 2.1 The Hierarchy

The Digital Workforce is structured as a layered hierarchy. Each layer has a specific purpose and must not absorb the responsibilities of another layer.

```
Digital Workforce
  └── Workforce Teams
        └── Digital Employees
              ├── Workforce Role
              ├── Responsibilities
              │     └── Capabilities
              │           └── Skills
              ├── Knowledge Scope
              ├── Tool Access
              └── Memory
```

### 2.2 Layer Definitions and Relationships

**Digital Workforce**
The totality of all Digital Employees operating within an Organisation. The Digital Workforce is the enterprise asset — it has a cost profile, a performance aggregate, and an ROI. Executives manage the Digital Workforce the way they manage a human workforce: headcount, productivity, budget, and outcomes.

**Workforce Teams**
Named coordination units of Digital Employees that collectively serve a Workspace. A Workforce Team is not a database group — it is a purposeful operational unit. Examples: the Customer Support Team (three support DEs + one escalation DE), the Revenue Team (two SDR DEs + one deal desk DE). Teams have shared goals and metrics. The Workforce Engine coordinates work within a team. See Section 7.

**Digital Employees**
The fundamental unit of the Digital Workforce. A named, configured, governed AI-powered team member with a defined identity, Responsibilities, Capability set, Knowledge Scope, and lifecycle. Customers hire, configure, measure, and retire Digital Employees. See Section 3.

**Workforce Role**
The job family classification. A Workforce Role defines the category of work a Digital Employee performs — Customer Support Specialist, Revenue Development Representative, Finance Analyst, HR Advisor, Compliance Officer. The Role informs the default Responsibility set and Capability recommendations. A Digital Employee is an instance of a Workforce Role.

**Responsibilities**
Sustained accountability domains — what the Digital Employee is accountable for as a standing member of the team. Responsibilities never end; they define ongoing obligations. Example: a Support Specialist DE is responsible for Customer Troubleshooting and Ticket Management. See Section 5.

**Capabilities**
Discrete, executable business outcomes the Digital Employee can fulfil. Capabilities are atomic — they have defined inputs, defined outputs, and a measured result per execution. A Capability is exercised once per invocation; it is not sustained. Example: Answer Customer Question, Qualify Lead, Review Transaction. See Section 6.

**Skills**
Micro-competencies that a Digital Employee possesses which enable it to execute Capabilities reliably. Skills are the bridge between what a DE is expected to do (Capability) and whether it can do it well. Example: the "Qualify Lead" Capability requires the Skills of CRM Record Analysis, Prospect Scoring, and ICP Pattern Recognition. See Section 4.

**Knowledge Scope**
The defined boundary of organisational Knowledge that a Digital Employee may access, read, cite, and reason from. Knowledge Scope is enforced by the Control Fabric. A Digital Employee cannot access Knowledge outside its defined scope, regardless of how it is invoked.

**Tool Access**
The specific set of Tools a Digital Employee may invoke during Capability execution. Tool Access is declared explicitly — a Digital Employee can only use Tools it has been granted access to. The Control Fabric enforces this at invocation time.

**Memory**
The contextual state available to a Digital Employee across different time horizons. Working Memory (ephemeral, per-execution, in Redis), Conversation Memory (per-conversation, in Postgres), and Organisational Memory (long-lived, tenant-scoped Knowledge Items). Memory is scoped — it never crosses boundaries between executions, conversations, or organisations.

---

## 3. Digital Employee Blueprint

Every Digital Employee in the DreamTeam platform — whether created by the Organisation, installed from the Marketplace, or built by a partner — must conform to this Blueprint. The Blueprint is the constitutional definition of a Digital Employee. No partial implementation is permitted.

### 3.1 Identity

| Attribute | Type | Purpose |
|---|---|---|
| `id` | UUID | Permanent unique identifier. Immutable after creation. |
| `name` | String | The DE's working name as experienced by customers and colleagues. Example: "Aria", "Jordan", "Casey". Human-readable, chosen by the Organisation. |
| `display_title` | String | The role title shown in customer-facing surfaces. Example: "Customer Success Manager", "Revenue Development Representative". |
| `avatar_url` | String | Visual identity for customer-facing surfaces. Optional. |
| `slug` | String | URL-safe unique identifier within the tenant. Example: `aria-support`. |
| `version` | Integer | The DE's configuration version. Increments on every configuration change. |
| `lifecycle_status` | Enum | Current lifecycle stage. See Section 8. |

**Why identity matters:** A Digital Employee must have a stable, recognisable identity. Customers build trust with a named colleague. An unnamed, interchangeable AI instance cannot be trusted in the same way. The name persists even when the underlying model configuration changes.

### 3.2 Purpose

| Attribute | Type | Purpose |
|---|---|---|
| `purpose_statement` | Text | One to three sentences describing what this DE exists to do for the Organisation. Written in business language. Example: "Aria handles all first-contact customer support, resolves common queries autonomously, and ensures escalations reach the right human with full context." |
| `primary_business_outcome` | Text | The single most important Business Outcome this DE contributes to. Example: "Reduce average ticket resolution time by 40%." |
| `workspace_id` | UUID | The Workspace this DE operates within. |
| `department_id` | UUID | The Department this DE is associated with. |

### 3.3 Workforce Role & Classification

| Attribute | Type | Purpose |
|---|---|---|
| `workforce_role` | Enum | The job family classification. Example: `customer_support_specialist`, `revenue_development_representative`, `finance_analyst`. |
| `seniority_level` | Enum | `junior`, `mid`, `senior`, `lead`. Informs default autonomy and approval thresholds. |
| `specialisation` | String | Optional sub-specialisation within the role. Example: "Technical Support", "Enterprise Accounts". |

### 3.4 Responsibilities

| Attribute | Type | Purpose |
|---|---|---|
| `responsibilities` | Array | The list of Responsibility domains this DE owns. Each Responsibility has a name, description, and the set of Capabilities it enables. Minimum 1, recommended 2–5 per DE. See Section 5. |

### 3.5 Capabilities

| Attribute | Type | Purpose |
|---|---|---|
| `capabilities` | Array | The Capabilities this DE is assigned to fulfil. Many-to-many with Capabilities table. Includes assignment metadata: is_primary, proficiency_level, assigned_at. See Section 6. |

### 3.6 Skills Profile

| Attribute | Type | Purpose |
|---|---|---|
| `skills` | Array | The Skills this DE possesses. Each Skill includes skill_name, proficiency_level (1–5), last_assessed_at, and assessment_method. See Section 4. |

### 3.7 Knowledge Scope

| Attribute | Type | Purpose |
|---|---|---|
| `knowledge_scope` | Object | Defines which Knowledge Collections this DE may access. Each collection entry specifies: `collection_id`, `access_level` (full / cite_only / restricted), and `expires_at` (optional). |
| `knowledge_cutoff_awareness` | Boolean | Whether this DE is informed when Knowledge is outdated relative to the current date. |

### 3.8 Tool Access

| Attribute | Type | Purpose |
|---|---|---|
| `tool_permissions` | Array | Explicit list of Tools this DE may invoke. Each entry: `tool_name`, `permission_level` (read / execute / admin), `requires_approval`, `daily_limit`. |

### 3.9 Connector Access

| Attribute | Type | Purpose |
|---|---|---|
| `connector_permissions` | Array | Which Connectors this DE may read from or write to. Each entry: `connector_id`, `connector_type`, `allowed_objects`, `allowed_actions` (read/create/update), `field_restrictions`. |

### 3.10 Policies

| Attribute | Type | Purpose |
|---|---|---|
| `applied_policies` | Array | The Control Fabric Policies governing this DE's behaviour. Includes inherited tenant-level policies and DE-specific overrides. |
| `compliance_tags` | Array | Regulatory frameworks this DE operates under. Example: `GDPR`, `SOC2`, `HIPAA`. Drives additional policy enforcement. |

### 3.11 Approval Rules

| Attribute | Type | Purpose |
|---|---|---|
| `approval_rules` | Object | Defines which Actions require human approval before execution. Structured by `reversibility_class` and `action_category`. Includes `approver_role`, `approval_timeout`, and `auto_reject_on_timeout`. |
| `dual_approval_required` | Boolean | Whether irreversible actions require two approvers. |

### 3.12 Escalation Rules

| Attribute | Type | Purpose |
|---|---|---|
| `escalation_rules` | Object | Defines when and how this DE escalates. Triggers: `confidence_below`, `sentiment_below`, `policy_triggered`, `topic_category`, `customer_tier`. Actions: route to user role, route to specific DE, create Handoff. |
| `escalation_threshold_confidence` | Float | Confidence score below which this DE must escalate rather than respond. Range 0.0–1.0. |
| `max_autonomy_attempts` | Integer | Maximum number of attempts the DE makes before escalating regardless of confidence. |

### 3.13 Goals & KPIs

| Attribute | Type | Purpose |
|---|---|---|
| `goals` | Array | Business goals this DE is working toward in the current period. Each goal: `name`, `target_metric`, `target_value`, `measurement_period`, `owner_user_id`. |
| `kpis` | Array | The Key Performance Indicators tracked for this DE. Each KPI: `name`, `metric_key`, `target`, `current`, `trend`. See Section 10. |

### 3.14 Performance Profile

| Attribute | Type | Purpose |
|---|---|---|
| `accuracy_rate` | Float | Percentage of Capability outputs assessed as correct. |
| `csat_score` | Float | Customer satisfaction score attributed to this DE. |
| `escalation_rate` | Float | Percentage of conversations/tasks escalated to human. |
| `approval_rate` | Float | Percentage of approval-required actions approved (vs rejected). |
| `hallucination_rate` | Float | Percentage of outputs flagged as factually incorrect. |
| `sla_achievement_rate` | Float | Percentage of tasks completed within SLA. |
| `avg_handle_time_ms` | Integer | Average time to complete a Capability run. |
| `last_performance_review_at` | Timestamp | Date of last formal performance review. |
| `performance_trend` | Enum | `improving`, `stable`, `declining`. |

### 3.15 Trust Level

Trust Level is a first-class attribute earned by a Digital Employee over time through a verified performance and compliance record. It is not set arbitrarily — it evolves through a governed process.

| Attribute | Type | Purpose |
|---|---|---|
| `trust_level` | Enum | Current trust level: `supervised`, `established`, `trusted`, `autonomous`. |
| `trust_level_granted_at` | Timestamp | When the current trust level was assigned. |
| `trust_level_granted_by` | UUID | User who authorised the trust level change. |
| `trust_level_basis` | Text | Summary of the evidence supporting the current trust level. |

**Trust Level Definitions:**

| Level | Meaning | Typical Autonomy |
|---|---|---|
| `supervised` | New or unproven DE. All consequential actions require approval. High escalation threshold. | Low |
| `established` | Demonstrated reliable performance over a defined period. Reduced approval requirements for medium-risk actions. | Medium |
| `trusted` | Consistent high performance, low incident rate, verified policy compliance. Approved for autonomous operation on most action classes. | High |
| `autonomous` | Exceptional track record. Approved by both DE owner and compliance officer. Operates with minimal approval gates. Reserved for proven, mission-critical DEs. | Maximum (within policy) |

Trust Level changes are governance events — they generate Audit Trail entries, require authorisation, and cannot be self-assigned.

### 3.16 Incident Record

An Incident Record captures every instance where a Digital Employee caused a policy violation, produced a harmful or incorrect output that was acted upon, or failed a critical escalation. Incident Records are the workforce management equivalent of HR corrective action.

| Attribute | Type | Purpose |
|---|---|---|
| `incidents` | Array | List of Incident Records. Each: `incident_id`, `date`, `severity` (minor/major/critical), `type`, `description`, `impact`, `remediation_taken`, `trust_level_impact`. |
| `active_incident_count` | Integer | Current open incidents (not yet remediated). |
| `incident_free_days` | Integer | Days since last incident. A governance signal. |

**Incident types:** `policy_violation`, `hallucination_acted_upon`, `escalation_failure`, `data_access_breach`, `approval_bypass_attempt`, `connector_data_misuse`.

Incidents above a severity threshold trigger automatic Trust Level review. Repeated incidents within a period can trigger automatic Pausing of the DE pending investigation.

### 3.17 Health Profile

| Attribute | Type | Purpose |
|---|---|---|
| `health_status` | Enum | Current operational health. See Section 11. |
| `health_signals` | Array | Active health signals contributing to the current status. Each: `signal_type`, `severity`, `since`, `description`. |
| `last_health_check_at` | Timestamp | Last automated health evaluation. |

### 3.18 Cost Profile

| Attribute | Type | Purpose |
|---|---|---|
| `monthly_cost_usd` | Float | Total AI spend attributed to this DE in the current month. |
| `cost_per_task_usd` | Float | Rolling average cost per Capability run. |
| `cost_per_conversation_usd` | Float | Rolling average cost per Conversation. |
| `fte_equivalent` | Float | Computed FTE equivalent value. See Section 12. |
| `monthly_budget_usd` | Float | Allocated monthly budget for this DE. |
| `budget_utilisation_pct` | Float | Current spend as a percentage of monthly budget. |
| `roi_score` | Float | Calculated return on investment. See Section 12. |

### 3.19 Availability

| Attribute | Type | Purpose |
|---|---|---|
| `availability_schedule` | Object | Defines when this DE is active. Supports `always_on`, `business_hours`, or a custom schedule with timezone. |
| `max_concurrent_tasks` | Integer | Maximum number of simultaneous Capability runs this DE will execute. |
| `queue_overflow_behavior` | Enum | What happens when tasks arrive beyond capacity: `queue`, `route_to_team`, `escalate_to_human`. |

### 3.20 Development Record

| Attribute | Type | Purpose |
|---|---|---|
| `development_history` | Array | Log of all significant Development events: knowledge updates, Capability upgrades, configuration changes, policy updates, performance interventions. Each: `date`, `type`, `summary`, `applied_by`. |
| `last_knowledge_update_at` | Timestamp | When the DE's Knowledge Scope was last refreshed. |
| `certifications` | Array | Formal certifications this DE has achieved. Each: `name`, `issuer`, `achieved_at`, `expires_at`, `scope`. See Section 9. |
| `pending_development_items` | Array | Recommended development actions not yet applied. |

---

## 4. Skills Framework

### 4.1 What Skills Are

A Skill is a micro-competency that a Digital Employee possesses which enables reliable Capability execution. Skills are not a customer-facing concept — they are the platform's model of what a DE actually knows how to do underneath its Responsibilities and Capabilities.

**The Three-Layer Distinction:**

| Concept | Question It Answers | Duration | Measured |
|---|---|---|---|
| **Responsibility** | What is the DE accountable for? | Ongoing — never ends | By Business Outcome |
| **Capability** | What can the platform execute? | Per-invocation — discrete | By execution result |
| **Skill** | What can the DE do well? | Persistent — improves over time | By proficiency level |

**Analogy:** A human HR Advisor is *responsible* for Employee Relations (Responsibility). To fulfil that, they *conduct grievance investigations* (Capability). They can do this well because they possess *Employment Law Knowledge*, *Interview Technique*, and *Conflict Resolution* (Skills).

Skills explain why one Digital Employee assigned the same Capability as another performs it better. They are the underlying competency model.

### 4.2 Skill Categories

**Domain Skills**
Knowledge of a specific business domain. Examples: Financial Regulation, HR Policy, Product Knowledge, Pricing Strategy, GDPR Compliance. Domain Skills are primarily developed through Knowledge updates.

**Process Skills**
Competency in executing specific business processes. Examples: Lead Qualification, Case Summarisation, Transaction Review, Contract Parsing. Process Skills are developed through Capability execution volume and feedback.

**Communication Skills**
Quality of language, tone, and format in outputs. Examples: Professional Email Drafting, Executive Summarisation, Concise Explanation, Multilingual Response. Communication Skills are assessed through output quality metrics.

**Analytical Skills**
Reasoning, pattern recognition, and evaluation capabilities. Examples: Anomaly Detection, Root Cause Analysis, Risk Assessment, Data Interpretation. Analytical Skills are assessed through accuracy metrics.

**Integration Skills**
Ability to effectively use Tools and Connectors. Examples: CRM Data Interpretation, Support Ticket Analysis, Financial Record Review. Integration Skills develop through Tool and Connector usage patterns.

### 4.3 Proficiency Levels

| Level | Name | Description |
|---|---|---|
| 1 | Foundational | Can execute with high supervision. Frequent escalation. Requires approval for most actions. |
| 2 | Developing | Executes reliably for standard cases. Struggles with edge cases. Moderate escalation rate. |
| 3 | Proficient | Handles standard and most non-standard cases independently. Low escalation rate. |
| 4 | Advanced | Handles complex cases with high accuracy. Rarely escalates. High confidence scores. |
| 5 | Expert | Exceptional accuracy across all case types. Can inform Capability design and Knowledge gaps. |

### 4.4 Skill Assessment

Skills are not self-reported. They are assessed from observable evidence:

- **Accuracy rate** on Capabilities that require the Skill
- **Confidence score** distribution on relevant outputs
- **Escalation rate** on relevant Capability types
- **Approval rejection rate** (approvals rejected indicate poor judgment in the Skill area)
- **Feedback signals** from human reviewers
- **Knowledge citation quality** (are cited sources accurate and relevant?)

Skills are assessed automatically on a rolling 30-day basis. Material changes in a Skill's proficiency level generate a `digital_employee.skill_updated` event and may trigger a Development recommendation.

### 4.5 Skills and Development

Skill gaps drive Development recommendations. When a Skill drops below a threshold — or when a new Capability is assigned that requires a Skill the DE doesn't have — the platform generates a Development Plan item. See Section 9.

---

## 5. Responsibilities Framework

### 5.1 Definition

A Responsibility is a sustained domain of accountability. It defines what a Digital Employee is answerable for as an ongoing member of the workforce — not what it does in a single task. Responsibilities are the backbone of the Digital Employee's identity.

A Digital Employee without clear Responsibilities is an unaccountable AI. A Digital Employee with well-defined Responsibilities is a measurable, trustworthy team member.

### 5.2 Responsibility Structure

Each Responsibility must define:

| Field | Purpose |
|---|---|
| `name` | Clear, business-language name. Example: "Customer Troubleshooting", "Billing Management". |
| `description` | One paragraph describing the full scope of this accountability. |
| `enabled_capabilities` | The Capabilities this Responsibility authorises the DE to execute. A Capability must be linked to a Responsibility to be exercised. |
| `success_criteria` | How the Organisation measures whether this Responsibility is being fulfilled. |
| `escalation_domain` | Which human role or team receives escalations for this Responsibility. |
| `policy_scope` | Which Policies apply specifically within this Responsibility domain. |
| `knowledge_domains` | Which Knowledge Collections are most relevant to this Responsibility. |

### 5.3 Ownership and Accountability

A Responsibility is owned by the Digital Employee. Ownership means:

1. The DE is the first point of contact for work in this domain
2. The DE is measured on the quality of outcomes in this domain
3. If the DE is unavailable, escalation rules define the fallback
4. The DE's Trust Level directly affects autonomy within this Responsibility

Responsibilities are not shared between DEs by default. Two DEs may have the same Responsibility type (e.g. both are responsible for "Ticket Management"), but they each own it independently within their scope. Shared Responsibility with clear ownership boundaries is defined at the Workforce Team level.

### 5.4 Responsibility Boundaries

Responsibilities have explicit limits. A DE may only exercise Capabilities that are linked to one of its Responsibilities. This prevents scope creep — a Finance DE should not handle customer support, even if the underlying Capability technically exists.

The Control Fabric enforces Responsibility boundaries at the execution boundary. An attempt to invoke a Capability outside the DE's Responsibility scope is blocked and generates an Audit Trail entry.

### 5.5 Responsibility Evolution

Responsibilities can be added, modified, or removed by Organisation admins. All changes are versioned and audited. Removing a Responsibility disables the associated Capabilities for that DE without affecting the Capability definitions themselves.

---

## 6. Capability Assignment

### 6.1 The Assignment Model

Capabilities exist at the Workspace level — they belong to the Organisation, not to any specific Digital Employee. Assigning a Capability to a Digital Employee is a governance decision that says: "this DE is authorised and equipped to fulfil this Capability."

The relationship is many-to-many:
- One Capability may be assigned to multiple Digital Employees (redundancy, load distribution, specialisation)
- One Digital Employee may be assigned multiple Capabilities (breadth of function)

### 6.2 Assignment Record

Each assignment carries:

```json
{
  "digital_employee_id": "de_...",
  "capability_id": "cap_...",
  "is_primary": true,
  "proficiency_level": 3,
  "assigned_at": "2026-07-01T00:00:00Z",
  "assigned_by": "usr_...",
  "linked_responsibility": "cust_troubleshooting",
  "approval_override": null,
  "assignment_notes": "Primary handler for Tier 1 support queries"
}
```

`is_primary` designates which DE receives first routing for a Capability when multiple DEs are assigned.

### 6.3 Governance Around Assignment

**Adding a Capability:**
1. Admin selects a Capability and proposes assignment to a DE
2. Platform checks: does the DE's Knowledge Scope cover the Capability's requirements? Does the DE have the required Skills?
3. If gaps exist, a Development Plan item is created
4. Assignment is approved by the Workspace admin
5. A `capability.assigned` event is generated

**Removing a Capability:**
1. Admin proposes removal
2. Platform checks: are there active runs in progress? Are there scheduled Workflows depending on this DE for this Capability?
3. Active runs complete; Workflow dependencies are resolved or rerouted
4. Removal is confirmed; a `capability.unassigned` event is generated

**Versioning a Capability:**
When a Capability is updated to a new version, existing assignments are not automatically upgraded. Admins review the change log and confirm the upgrade for each DE. This prevents silent behaviour changes in production Digital Employees.

### 6.4 Primary vs Backup Assignment

Every Capability should have a primary DE and at least one backup DE. If the primary DE is unavailable (Paused, Health-degraded, at capacity), the Workforce Engine routes to the backup. If no backup is available, the task queues and an alert is generated.

This mirrors human workforce resilience planning — no critical Capability should have a single point of failure.

---

## 7. Workforce Teams

### 7.1 What a Workforce Team Is

A Workforce Team is a named, purposeful coordination unit of Digital Employees that collectively serves a Workspace. It is distinct from:

- **Human Teams** (`teams` table) — groups of human users
- **Departments** — organisational business units

A Workforce Team is specifically a group of Digital Employees with shared goals, complementary Capabilities, and team-level governance. The Workforce Engine coordinates work within a team.

### 7.2 Team Structure

```json
{
  "team_id": "wft_...",
  "name": "Customer Support Workforce",
  "workspace_id": "ws_...",
  "purpose": "Handle all inbound customer support across web chat and email channels.",
  "members": [
    { "de_id": "de_...", "role_in_team": "primary_responder" },
    { "de_id": "de_...", "role_in_team": "escalation_handler" },
    { "de_id": "de_...", "role_in_team": "quality_reviewer" }
  ],
  "team_goals": [...],
  "team_kpis": [...],
  "coordination_policy": "round_robin",
  "overflow_behavior": "queue_with_alert"
}
```

### 7.3 Roles Within a Team

| Team Role | Description |
|---|---|
| `primary_responder` | First-contact handler for inbound work in this team's domain |
| `specialist` | Handles specific subtypes that the primary cannot |
| `escalation_handler` | Receives escalations from other team members |
| `quality_reviewer` | Reviews outputs before delivery (for high-stakes Capabilities) |
| `coordinator` | Orchestrates work distribution across the team (see DE Composition, Section 7.6) |

### 7.4 Example Teams

**Customer Support Workforce Team**
- Primary Responder DE: handles Tier 1 queries (Answer Question, Reset Password, Order Status)
- Specialist DE: handles Billing and Refund cases
- Escalation Handler DE: receives complex cases and prepares Handoff packets for human agents

**Revenue Workforce Team**
- SDR DE: qualifies inbound leads, drafts initial outreach
- Deal Desk DE: reviews contract terms, flags exceptions
- Coordinator DE: manages pipeline updates, assigns follow-up tasks

**Finance Workforce Team**
- Transaction Review DE: scans transactions for anomalies
- Reconciliation DE: performs account reconciliation
- Reporting DE: generates financial summaries for human review

**HR Workforce Team**
- Onboarding DE: manages new employee onboarding tasks
- Policy Advisor DE: answers employee HR policy questions
- Compliance Monitor DE: flags policy violations and required actions

### 7.5 Workforce Engine Coordination

The Workforce Engine coordinates within a team using:

- **Routing rules** — which DE handles which type of incoming work
- **Load balancing** — distributing work across DEs at capacity
- **Escalation paths** — which team member receives internal escalations
- **Fallback chains** — when the primary is unavailable, who is next
- **Team memory** — shared Conversation and Organisational Memory accessible to all team members (within their individual Knowledge Scopes)

### 7.6 Digital Employee Composition

In advanced team configurations, a **Coordinator DE** can orchestrate other Digital Employees — delegating sub-tasks and assembling results. This is DE Composition: a first-class pattern where one DE acts as an orchestrator of others.

**Example:** A "Revenue Operations Manager" DE receives a request to prepare a full account review. It delegates to the CRM Analysis DE (for account data), the Outreach History DE (for communication history), and the Deal Risk DE (for contract analysis). It then synthesises the results into an executive summary.

**Composition Governance Rules:**
1. A Coordinator DE must have explicit `coordinator` role in the team
2. The Coordinator DE can only delegate to DEs within the same Workspace
3. Each delegated DE executes under its own Responsibility and Policy constraints — the Coordinator cannot escalate permissions
4. The Control Fabric evaluates each delegation independently
5. The full delegation chain is recorded in the Audit Trail
6. `human_initiator_id` is preserved through the delegation chain

DE Composition is a Phase 3 capability. It must not be implemented before the single-DE model is stable and well-governed.

---

## 8. Lifecycle

### 8.1 The Lifecycle Model

Every Digital Employee passes through a defined lifecycle. Lifecycle status is not a label — it is a governance gate. Each stage has entry criteria (what must be true to enter), exit criteria (what must be true to leave), and permitted operations (what can be done to the DE in this stage).

```
Designed → Configured → Trained → Tested → Certified → Published
                                                           ↓
                                                        Assigned
                                                           ↓
                                                         Active
                                                           ↓
                                                        Improving ←──┐
                                                           ↓          │
                                                         Paused ──────┘
                                                           ↓
                                                         Retired
                                                           ↓
                                                         Archived
```

### 8.2 Stage Definitions

---

**Designed**
*Entry:* Admin begins creating a new Digital Employee profile.
*What it means:* The DE exists as a definition — Identity, Purpose, Role, and Responsibilities are being established. No Capabilities are active. No AI execution occurs.
*Permitted operations:* Edit all attributes. Cannot run Capabilities. Cannot be assigned to Conversations.
*Exit criteria:* Identity, Purpose, Workforce Role, and at least one Responsibility are fully defined.

---

**Configured**
*Entry:* Core identity is complete.
*What it means:* Capabilities are being assigned, Knowledge Scope is being defined, Tool Access is being granted, Control Fabric Policies are being applied, and Approval Rules are being set.
*Permitted operations:* All configuration. No live execution.
*Exit criteria:* Minimum viable configuration complete: at least one Capability assigned, Knowledge Scope defined, Policies applied, Approval Rules set.

---

**Trained**
*Entry:* Configuration is complete.
*What it means:* The Development team reviews the DE's Knowledge Scope, Skills profile, and configuration against the Capabilities it is expected to fulfil. Knowledge gaps are identified and filled. Skills are assessed. Development Plan items are completed.
*Note:* "Trained" in the DreamTeam context means Knowledge, Skills, and configuration are verified — not model fine-tuning.
*Permitted operations:* Development activities (Knowledge updates, Configuration refinement). Test execution in sandbox mode only.
*Exit criteria:* Knowledge Scope covers all Capability requirements. Skills profile meets minimum proficiency threshold for all assigned Capabilities.

---

**Tested**
*Entry:* Training is complete.
*What it means:* The DE undergoes structured testing against a defined test suite: accuracy checks, edge case handling, escalation trigger verification, policy enforcement, approval routing, and output quality review.
*Permitted operations:* Test execution in sandbox/staging environment. Output review. Configuration adjustments based on test results.
*Exit criteria:* Accuracy rate ≥ minimum threshold, escalation rate within expected range, zero policy violations in test suite, all approval rules verified to trigger correctly.

---

**Certified**
*Entry:* Testing passes all exit criteria.
*What it means:* A qualified reviewer (Workspace admin or Compliance officer) formally certifies that the DE meets the Organisation's standards for deployment. Certification is a governance checkpoint — it cannot be automated away for high-Trust DEs.
*For Marketplace DEs:* Certification is performed by DreamTeam's partner review process before the listing is published.
*Permitted operations:* Review-only. No further configuration changes (changes reset to Configured).
*Exit criteria:* Certification approval recorded with reviewer ID, timestamp, and certification scope.

---

**Published**
*Entry:* Certified.
*What it means:* The DE is available to be assigned to a Workspace and Conversations, but not yet actively handling live work. For Marketplace DEs, Published means the listing is live in the Marketplace and available for Organisations to install.
*Permitted operations:* Assignment to Workspace. Configuration review. Cannot yet handle live Conversations.
*Exit criteria:* Assignment to a Workspace and Channel.

---

**Assigned**
*Entry:* Published and assigned to a Workspace.
*What it means:* The DE is configured for a specific Workspace and is ready to accept work. Channel routing is active. The DE appears in the Organisation's Digital Workforce directory.
*Permitted operations:* All operations. Conversations can be routed to it.
*Exit criteria:* First successful live Capability execution.

---

**Active**
*Entry:* First live Capability execution completed.
*What it means:* The DE is fully operational. Performance metrics are accumulating. Trust Level is being evaluated. Health signals are monitored.
*Permitted operations:* All operations. Performance reviews. Trust Level changes. Configuration updates (each update increments version and triggers a lightweight re-certification for major changes).
*Exit criteria:* Performance degradation (triggers Improving), policy violation (triggers Paused), or retirement decision.

---

**Improving**
*Entry:* Performance review identifies a gap; a Development Plan is active.
*What it means:* The DE continues to operate but is under an active Development Plan. Increased monitoring. Escalation thresholds may be temporarily raised.
*Permitted operations:* All operations with enhanced monitoring. Development activities.
*Exit criteria:* Development Plan targets met, validated by performance review → returns to Active. Targets not met within defined period → escalates to Paused.

---

**Paused**
*Entry:* Policy violation, critical Incident, or persistent performance failure. Manual admin action.
*What it means:* The DE is temporarily suspended from live execution. Active Conversations are handed off. Scheduled Workflows are paused. The DE remains configured and retains its Trust Level pending investigation.
*Permitted operations:* Incident investigation. Configuration changes. Does not handle live work.
*Exit criteria:* Investigation complete, remediation verified, re-certification completed → returns to Active or Improving. Remediation not possible → Retired.

---

**Retired**
*Entry:* Organisation decision to permanently decommission the DE.
*What it means:* The DE is no longer available for new work. Existing Conversations are concluded or handed off. The DE's configuration and performance history are retained for audit and reference.
*Permitted operations:* Read-only. Historical audit queries. Cannot be reactivated.
*Exit criteria:* All active Conversations resolved. All Workflow dependencies removed. Archived after retention period.

---

**Archived**
*Entry:* Retention period after Retirement.
*What it means:* The DE record is moved to cold storage. Full configuration, performance history, and audit trail are retained per data retention policy. Not visible in the active Digital Workforce directory.
*Permitted operations:* Compliance audit queries only.

---

## 9. Development Framework

### 9.1 Why "Development" Not "Learning"

DreamTeam does not train AI models. The platform does not modify model weights, fine-tune models, or create custom model checkpoints for individual Digital Employees. These are implementation details that belong in the Intelligence Service, if they are used at all.

When we say a Digital Employee "improves over time," we mean:

- **Knowledge updates** — the Knowledge Collections in its scope are refreshed with new, corrected, or expanded content
- **Capability upgrades** — the Capabilities it executes are updated to newer, better-performing versions
- **Configuration refinement** — Approval Rules, escalation thresholds, and Policies are tuned based on performance data
- **Skills development** — proficiency assessments identify gaps; targeted Knowledge and configuration changes address them
- **Feedback integration** — output quality reviews generate specific recommendations that are applied as configuration changes

This is Development. It is deliberate, governed, and auditable. It is not automatic — no change to a Digital Employee's configuration should happen without human authorisation.

### 9.2 Development Plan

A Development Plan is a structured, time-bound set of improvement actions for a Digital Employee. It is triggered by:

- Performance review identifying a gap
- Skill assessment identifying a deficiency
- Transition to `Improving` lifecycle state
- New Capability assignment requiring new Skills
- Periodic scheduled review

Each Development Plan item specifies:

```json
{
  "item_id": "dpi_...",
  "type": "knowledge_update",
  "priority": "high",
  "description": "Add refund policy articles covering international orders to Customer Support knowledge base.",
  "target_skill": "Refund Policy Knowledge",
  "target_metric": "accuracy_rate",
  "target_value": 0.92,
  "measurement_period_days": 30,
  "assigned_to": "usr_...",
  "due_date": "2026-08-01",
  "status": "in_progress"
}
```

### 9.3 Knowledge Updates

Knowledge updates are the highest-leverage Development action. When a DE's accuracy degrades or the `knowledge.gap_detected` event fires, the Knowledge team reviews the gap and adds, updates, or restructures content in the relevant Knowledge Collection.

After a Knowledge update, the DE undergoes a targeted re-test against cases that previously failed. If the accuracy improves past threshold, the Development Plan item is marked complete.

Knowledge is never silently updated. Every update is versioned, timestamped, and attributed to the person who made the change.

### 9.4 Capability Upgrades

When a Capability is released at a new version, the DE's assignment record must be explicitly upgraded. This requires:

1. A review of the change log between the current and new Capability version
2. A targeted test of the DE's performance against the updated Capability
3. Admin approval to upgrade the assignment
4. Version increment on the DE's configuration

Auto-upgrades are prohibited. Silent Capability changes in production Digital Employees break the trust model.

### 9.5 Certifications

A Certification is a formal attestation that a Digital Employee is fit-for-purpose for a specific accountability domain. Certifications are especially important in regulated industries.

| Certification Type | Description | Issuer |
|---|---|---|
| **Workspace Certified** | Meets Organisation's standards for the assigned Workspace | Workspace Admin |
| **Compliance Certified** | Meets regulatory compliance requirements (GDPR, SOC2, HIPAA) | Compliance Officer |
| **Capability Certified** | Demonstrated proficiency in a specific Capability | Capability Owner |
| **Partner Certified** | Meets DreamTeam's standards for Marketplace listing | DreamTeam |
| **Industry Certified** | Meets industry-specific requirements (Financial Services, Healthcare) | DreamTeam + Partner |

Certifications have an expiry date. A DE whose certification has expired is flagged in the Health Profile. Recertification is required before the DE can continue operating in the certified domain.

### 9.6 Development Governance

No Development activity modifies a live, Active Digital Employee without:

1. A Development Plan item authorising the change
2. A review by the responsible admin
3. Testing in a non-production context where practical
4. Version increment on the DE's configuration
5. An Audit Trail entry recording what changed, why, and who authorised it

The Development History in the DE Blueprint is the permanent record of every significant change made to the DE since its creation.

---

## 10. Performance Management

### 10.1 Performance as Workforce Management

Digital Employee performance is managed the same way human employee performance is managed: with defined metrics, regular reviews, improvement plans, and consequences for persistent underperformance.

The platform provides the measurement infrastructure. The Organisation provides the standards.

### 10.2 Core Performance Metrics

**Quality Metrics**

| Metric | Definition | Target Direction |
|---|---|---|
| Accuracy Rate | % of Capability outputs assessed as correct | Higher is better |
| Hallucination Rate | % of outputs containing factual errors | Lower is better |
| Knowledge Citation Quality | % of citations that are relevant and accurate | Higher is better |
| Output Completeness Rate | % of outputs that fully address the input | Higher is better |

**Customer Experience Metrics**

| Metric | Definition | Target Direction |
|---|---|---|
| CSAT Score | Customer satisfaction score on DE-handled interactions | Higher is better |
| First Contact Resolution Rate | % of conversations resolved without escalation | Higher is better |
| Response Quality Score | Human-reviewed quality rating on sample outputs | Higher is better |

**Operational Metrics**

| Metric | Definition | Target Direction |
|---|---|---|
| Escalation Rate | % of tasks escalated to human | Contextual — too low may indicate overconfidence |
| Approval Rate | % of approval-requested actions approved | Higher indicates good judgment |
| Average Handle Time | Average Capability run duration | Lower is better (within quality bounds) |
| SLA Achievement Rate | % of tasks completed within SLA | Higher is better |
| Availability Rate | % of scheduled time DE is operational | Higher is better |

**Business Outcome Metrics**

| Metric | Definition |
|---|---|
| Business Outcomes Contributed | Measurable business improvements attributed to this DE |
| Tasks Completed | Volume of Capability runs completed in period |
| Conversations Handled | Volume of Conversations participated in |
| Hours Saved | Estimated human time saved by DE activity |
| Revenue Influenced | Revenue associated with DE-assisted interactions (where attributable) |

### 10.3 Performance Review Cadence

| Review Type | Frequency | Trigger | Output |
|---|---|---|---|
| Automated Health Check | Continuous | Scheduled | Health signal updates |
| Skills Assessment | Monthly (rolling 30 days) | Scheduled | Skill proficiency updates |
| Performance Review | Quarterly | Scheduled | Performance report, Development Plan update |
| Trust Level Review | Every 90 days after level change | Scheduled | Trust Level confirmation or adjustment |
| Incident Review | Within 48 hours of critical incident | Incident-triggered | Incident Record, immediate actions |
| Certification Review | At certification expiry | Scheduled | Recertification or lifecycle change |

### 10.4 Performance Improvement Plans

When a quarterly performance review identifies a DE whose metrics are below threshold, a Performance Improvement Plan (PIP) is created. A PIP is a Development Plan with a formal timeline, specific targets, and a consequence definition.

If PIP targets are not met within the defined period, the DE's Trust Level may be reduced, additional approval gates may be added, or the DE may be moved to Paused status for investigation.

### 10.5 Benchmark Comparison

DreamTeam provides anonymised, aggregated benchmarks for Digital Employees in the same Workforce Role across the platform (opt-in). An Organisation can compare their Support Specialist DE's accuracy rate against the anonymised average for all Support Specialist DEs on the platform.

This is not competitive intelligence — it is a calibration tool that helps Organisations set realistic performance targets and identify where their DE's Knowledge, configuration, or Capability set may be falling short.

---

## 11. Workforce Health

### 11.1 The Health Model

A Digital Employee's health reflects its current operational fitness. Health is not a binary — it is a signal system that tells the Workforce Engine, Workforce admins, and the organisation how much confidence to place in the DE's outputs.

Health directly influences:
- Routing priority (degraded DEs receive lower priority in work distribution)
- Escalation thresholds (unhealthy DEs escalate sooner)
- Approval requirements (unhealthy DEs may require additional approvals)
- Recommendations (health signals drive Development suggestions)

### 11.2 Health States

| State | Meaning | Platform Response |
|---|---|---|
| `healthy` | All systems nominal. Performance within targets. | Normal operation |
| `learning` | Active Development Plan in progress. Metrics below target but improving. | Enhanced monitoring; normal routing |
| `degraded` | Performance metrics have declined materially. Active investigation. | Reduced routing priority; escalation threshold raised; alert to admin |
| `policy_restricted` | A policy change has temporarily limited the DE's permitted actions. | Operates within restriction; admin notified |
| `awaiting_approval` | A required approval has not been granted within the expected window. | Tasks queue; human alert sent |
| `knowledge_outdated` | Key Knowledge Collections are stale beyond the configured freshness threshold. | Warning on outputs; admin alert; knowledge update recommended |
| `connector_failure` | One or more required Connectors are unavailable. | Capability affected; fallback to available data; connector error surfaces |
| `high_cost` | AI spend has exceeded budget threshold. | Alert to admin; optional auto-pause on budget breach |
| `low_confidence` | Sustained confidence scores below threshold across recent executions. | Escalation threshold raised; review recommended |
| `incident_active` | An open Incident is under investigation. | Trust Level under review; may be Paused pending outcome |
| `certification_expired` | One or more certifications have expired. | Warning in admin UI; recertification required |

### 11.3 Health Signals

Health states are composed from underlying health signals. Each signal has a type, severity, and duration. The platform evaluates signals continuously and updates the `health_status` based on the combination of active signals.

Example signals: `accuracy_below_threshold`, `escalation_rate_spike`, `connector_sync_failed`, `knowledge_item_flagged_outdated`, `budget_at_80pct`, `incident_opened`, `certification_expiring_soon`.

Health signals expire when the underlying condition resolves. Persistent signals escalate from warning to critical.

### 11.4 Health in the Workforce HQ

The Workforce HQ dashboard surfaces an Organisation's Digital Workforce health at a glance:

- **Green:** All DEs healthy
- **Amber:** One or more DEs in `learning`, `knowledge_outdated`, or `low_confidence`
- **Red:** One or more DEs in `degraded`, `incident_active`, or `connector_failure`

Workforce health is a board-level concern. An Organisation with a degraded Digital Workforce is at risk of service quality failures, compliance gaps, and customer experience deterioration.

---

## 12. Workforce Economics

### 12.1 The Economic Model

The Digital Workforce has a cost and a value. Both must be measured with the same rigour as a human workforce. An Organisation that cannot answer "what is our Digital Workforce costing us and what is it returning?" is not managing it — it is hoping it works.

### 12.2 Cost Tracking

**AI Spend Attribution**
Every AI token consumed by a Digital Employee is attributed to:
- The specific DE
- The specific Capability run
- The Workspace
- The time period

This creates a full cost breakdown: by DE, by Workspace, by Capability, by time. See `docs/08_Database_Design.md` Section 15.

**Cost Per Task**
```
cost_per_task = total_ai_spend_in_period / capability_runs_in_period
```

**Cost Per Conversation**
```
cost_per_conversation = total_ai_spend_in_period / conversations_handled_in_period
```

**Cost Per Capability**
Each Capability type has an average AI spend per run, tracked across all executions in the period.

### 12.3 FTE Equivalent

FTE Equivalent is a governed, auditable metric — not a marketing claim. It answers: "if humans were doing the work this DE does, how many full-time equivalent employees would that require?"

**Calculation:**
```
fte_equivalent = (tasks_completed × avg_human_task_time_minutes) / standard_working_minutes_per_period
```

Where:
- `tasks_completed` = Capability runs completed in the measurement period
- `avg_human_task_time_minutes` = the Organisation-configured average time a human takes to complete this task type. This is configured by the Organisation, not invented by the platform.
- `standard_working_minutes_per_period` = 9,600 minutes per month (480 minutes × 20 working days)

Each Capability type should have its own `avg_human_task_time_minutes` configured. A "Qualify Lead" Capability might take a human 12 minutes; an "Answer Customer Question" might take 4 minutes.

FTE Equivalent is presented alongside a confidence indicator. Organisations that have not configured `avg_human_task_time_minutes` see a "configure to calculate" prompt rather than a platform-generated estimate.

### 12.4 Return on Investment

```
roi = ((fte_equivalent × avg_human_fte_cost_usd) - total_de_cost_usd) / total_de_cost_usd
```

Where `avg_human_fte_cost_usd` is the Organisation-configured average fully-loaded cost of a human FTE in the equivalent role. This is not a platform estimate — it is Organisation-configured.

ROI is presented as a ratio (e.g. 4.2x) and as an absolute monthly saving (e.g. £18,400/month).

### 12.5 Budget Management

Each Digital Employee has a monthly AI budget. Budget controls:

- **Alert threshold** (default 80%) — admin notification
- **Hard limit** — DE automatically pauses non-critical Capability runs; critical runs continue with admin alert
- **Budget carry-forward** — unspent budget does not carry to the next period (prevents gaming)

Budget is allocated at the Workspace level and distributed to DEs. Workspace admins can reallocate budget between DEs within the Workspace allocation.

### 12.6 Executive Reporting

The Digital Workforce economic model supports executive-level reporting:

| Report | Audience | Content |
|---|---|---|
| Workforce Cost Summary | CFO | Total AI spend, by Workspace, by DE, trend vs prior period |
| Workforce ROI Report | CEO / COO | FTE Equivalent, hours saved, cost savings, Business Outcomes |
| Workforce Utilisation | Workforce Admin | DE utilisation rates, idle time, capacity headroom |
| Capability Economics | Product / Operations | Cost per Capability type, volume, trend |
| Budget vs Actual | Finance | Budget allocation vs spend, by Workspace and DE |

---

## 13. Governance

### 13.1 Governance Is Not Optional

Every Digital Employee operates under formal governance. Governance is not an enterprise add-on — it is built into the platform architecture at every layer. A Digital Employee without governance is a liability, not an asset.

The Control Fabric is the technical implementation of governance (see `docs/07_Security_and_Governance.md`). This section defines the governance *model* — the principles, processes, and accountabilities that the Control Fabric enforces.

### 13.2 Permission Governance

Permissions are declared, not assumed. A Digital Employee can only:

- Access Knowledge Collections in its defined Knowledge Scope
- Invoke Tools in its declared Tool Access list
- Use Connectors in its Connector Access list
- Execute Capabilities linked to its Responsibilities

Permissions are reviewed at every Trust Level change, at every major configuration version increment, and at every periodic certification review.

### 13.3 Approval Governance

Approval rules are set per Digital Employee, per Capability, and per action class. They are not global — they are calibrated to the specific risk profile of each DE in each context.

Approval governance includes:

- **Who must approve** — specific user, role, or team
- **How long approvals wait** — timeout window
- **What happens on timeout** — auto-reject, auto-approve (only for low-risk, explicitly configured), or escalate to admin
- **Dual approval** — required for irreversible actions for DEs at `trusted` or `autonomous` Trust Level
- **Approval history** — every approval decision is recorded and auditable

### 13.4 Policy Governance

Policies are owned by the Organisation. DreamTeam provides templates; the Organisation configures their own rules. Policies govern:

- What actions are permitted
- What data the DE can access
- What outputs can be delivered without review
- When escalation is mandatory
- How long data can be retained in context

All policy changes are versioned and audited. A policy change that reduces a DE's permissions takes effect immediately. A policy change that expands permissions requires review and approval.

### 13.5 Versioning Governance

Every DE has a configuration version. Version increments are triggered by:

- Capability assignment changes
- Policy changes affecting this DE
- Knowledge Scope changes
- Tool Access changes
- Approval Rule changes
- Trust Level changes

Major version changes (those affecting Capability, Policy, or Trust Level) require re-certification. Minor version changes (Knowledge updates, configuration refinements) require review but not full recertification.

### 13.6 Ownership Governance

Every Digital Employee has a defined owner — the human user responsible for its configuration, performance, and governance. The owner is accountable for:

- Reviewing performance metrics
- Approving Development Plans
- Authorising configuration changes
- Escalating persistent health issues
- Initiating retirement when appropriate

Ownership can be transferred between users. Transfer is an audited event — the new owner receives a full briefing on the DE's current performance, health, and open Development Plan items.

### 13.7 Retirement Governance

Retiring a Digital Employee is a formal process:

1. Owner proposes retirement with a reason
2. Platform checks: active Conversations? Active Workflows depending on this DE? Pending Approvals?
3. Dependencies are resolved (Conversations concluded, Workflows rerouted, Approvals expired)
4. Compliance officer confirms no compliance obligations require the DE to remain active
5. Retirement is executed; configuration is locked read-only
6. Full audit trail and performance history are retained per retention policy

A retired DE cannot be reactivated. If the same function is needed again, a new DE is created — potentially using the retired DE's configuration as a template.

---

## 14. Marketplace Readiness

### 14.1 The Marketplace Vision

The DreamTeam Marketplace allows Organisations to adopt pre-built Digital Employees — configured, tested, certified, and ready to deploy. A new Organisation should be able to adopt a fully functional "Support Specialist DE for SaaS companies" in minutes, not months.

Partners and ISVs can publish Digital Employee packages to the Marketplace. Every listing is reviewed and certified by DreamTeam before publication.

### 14.2 Marketplace Artifact Schema

A Marketplace listing for a Digital Employee is a precisely defined artifact — not a vague package. Every listing must contain exactly these components:

```json
{
  "listing_id": "mkt_...",
  "artifact_type": "digital_employee",
  "name": "Support Specialist — SaaS",
  "version": "2.1.0",
  "publisher": "DreamTeam",
  "description": "A pre-configured Support Specialist DE designed for SaaS companies, covering customer troubleshooting, billing queries, and product education.",
  "workforce_role": "customer_support_specialist",

  "de_profile_template": {
    "purpose_statement": "...",
    "responsibilities": [...],
    "skills": [...],
    "availability": "always_on",
    "default_trust_level": "supervised",
    "seniority_level": "mid"
  },

  "capabilities_included": [
    { "capability_slug": "answer-customer-question", "version": "1.3" },
    { "capability_slug": "summarise-case", "version": "1.1" },
    { "capability_slug": "escalate-conversation", "version": "1.0" }
  ],

  "knowledge_templates": [
    {
      "collection_name": "Product Documentation",
      "description": "Placeholder collection — customer must populate with their product docs.",
      "required": true
    },
    {
      "collection_name": "Refund and Returns Policy",
      "description": "Placeholder — customer provides policy document.",
      "required": true
    }
  ],

  "tool_permissions_required": [
    { "tool_name": "send_email", "permission_level": "execute" },
    { "tool_name": "create_ticket", "permission_level": "execute" }
  ],

  "connector_requirements": [
    { "connector_type": "helpdesk", "required": true, "minimum_objects": ["Ticket", "Contact"] }
  ],

  "default_policies_included": [
    { "policy_name": "Require approval for refunds above £50", "configurable": true },
    { "policy_name": "Always escalate sentiment below -0.6", "configurable": false }
  ],

  "certifications": ["Partner Certified", "GDPR Compliant"],

  "pricing": {
    "model": "included_in_plan",
    "per_run_usd": null,
    "monthly_usd": null
  },

  "compatibility": {
    "minimum_plan": "growth",
    "required_api_version": "2026-07-01"
  }
}
```

### 14.3 Installation Process

When an Organisation installs a Marketplace DE:

1. **Review** — Admin reviews the artifact schema, required connectors, and Knowledge templates
2. **Customise** — Organisation provides required Knowledge content; adjusts configurable policies; sets its own Goals and KPIs
3. **Configure Connectors** — Required Connectors are connected to the Organisation's external systems
4. **Test** — The installed DE goes through the Tested lifecycle stage in the Organisation's environment
5. **Certify** — Workspace admin certifies the DE for the Organisation's specific context
6. **Publish → Assign → Active** — Standard lifecycle from this point

The Marketplace accelerates time-to-value but does not bypass governance. Every installed DE must pass Testing and Certification within the Organisation's context.

### 14.4 Versioning and Upgrades

Marketplace listings are versioned with semantic versioning (`major.minor.patch`). When a new version is published:

- Organisations with the DE installed are notified
- The change log describes what has changed
- Organisations choose when to upgrade (upgrades are not automatic)
- Upgrading resets the DE to the Configured stage for the changed components
- The Organisation's Knowledge, customised policies, and KPI targets are preserved

Major version changes (breaking changes to Capability schemas or default policies) require full re-certification.

### 14.5 Partner Certification

Partners who publish to the Marketplace must:

1. Submit the full artifact schema for review
2. Provide test cases and expected outputs
3. Pass DreamTeam's automated validation suite
4. Pass DreamTeam's human review (security, compliance, domain accuracy)
5. Agree to the Partner Publisher Agreement (support obligations, update commitments)
6. Achieve "Partner Certified" status, renewable annually

A partner whose listing is associated with a customer incident (hallucination, policy violation, security breach) may have their listing suspended pending investigation.

---

## 15. Anti-Patterns

### 15.1 Hardcoded Digital Employees

Embedding Digital Employee behaviour in code — hardcoded prompts, fixed decision trees, hard-wired API calls — creates Digital Employees that cannot be governed, upgraded, or measured. Every DE must be defined through the Blueprint, configured through the Control Fabric, and executed through the Workforce Engine. There are no hardcoded shortcuts.

**Why it matters:** A hardcoded DE cannot be governed by policy. It cannot have its Trust Level adjusted. It cannot be audited in a meaningful way. It is an ungoverned AI, which is the opposite of what enterprise customers are buying.

### 15.2 Hidden Permissions

Granting a Digital Employee access to Knowledge, Tools, or Connectors without declaring it in the Blueprint creates invisible exposure. Every permission must be declared, reviewed, and audited. "Implicit" access that comes from inheriting a broad role without specific review is a governance failure.

### 15.3 Unmanaged Development

Updating a Digital Employee's Knowledge, configuration, or Capability assignments without following the Development governance process means changes are uncontrolled, untested, and unauditable. Every Development action must be authorised, documented, tested, and recorded. Silent changes to live DEs are a trust failure.

### 15.4 Opaque Performance

A Digital Employee whose performance metrics are not tracked, not reviewed, and not acted upon is not being managed — it is being ignored. Every active DE must have tracked KPIs, regular performance reviews, and an owner who is accountable for the outcomes. "It seems to be working fine" is not a performance management strategy.

### 15.5 Unmanaged Costs

Deploying Digital Employees without budget allocation, cost tracking, or spend alerts is fiscal negligence. Every DE must have a cost profile, a budget, and an escalation path when the budget is exceeded. Unmanaged AI spend compounds quickly at scale.

### 15.6 Coupling Digital Employees to Specific Models

A Digital Employee that is defined by which AI model it uses ("our GPT-4 DE", "our Claude DE") is brittle. Model providers change, models deprecate, costs shift. The DE's identity, Responsibilities, and Capabilities must be model-agnostic. The Intelligence Service selects the model; the DE is defined by what it does, not what runs it.

### 15.7 Single-Point-of-Failure Capability Coverage

Assigning a critical Capability to only one Digital Employee creates a single point of failure. Every Capability that the business depends on should have a primary DE and at least one backup. The Workforce Team model and Capability assignment framework exist precisely to support this resilience.

### 15.8 Trust Level Inflation

Granting `trusted` or `autonomous` Trust Level to a Digital Employee without a verified performance history — because it is convenient, because configuration is complex, or because approvals are seen as friction — defeats the purpose of the Trust Level system. Trust must be earned through observable evidence. An `autonomous` DE that hasn't earned autonomy is an ungoverned AI with a governance label.

### 15.9 DE Composition Without Governance

Allowing Digital Employees to orchestrate other Digital Employees without the Composition governance framework creates untracked delegation chains, unclear audit trails, and potential permission escalation. DE Composition is a powerful capability that must be implemented only through the defined framework — not through ad-hoc inter-DE calls.

### 15.10 Retiring Without Resolution

Retiring a Digital Employee without resolving active Conversations, Workflow dependencies, and pending Approvals creates dangling references and failed customer interactions. The retirement process must be followed completely. No shortcut retirement paths exist.

---

## 16. Immutable Principles

These principles define how DreamTeam will always design, govern, evolve, and measure its Digital Workforce. They are not guidelines — they are constitutional commitments. Any proposed feature, integration, or architectural change that violates a principle requires explicit review and amendment of this document.

---

**Principle 1: Customers hire Digital Employees — not AI models.**
The Digital Employee is the customer-facing entity. The AI model is invisible infrastructure. No customer-facing surface, documentation, or communication should reference the underlying model. The DE's identity persists across model changes.

**Principle 2: Every Digital Employee is accountable.**
Accountability requires a name, Responsibilities, a defined owner, measured KPIs, and a complete Audit Trail. An AI system without clear accountability is not a Digital Employee — it is an ungoverned tool.

**Principle 3: Trust is earned, not configured.**
A Digital Employee's autonomy level must reflect its verified track record. Trust Levels progress through evidence-based review, not through administrative convenience. Autonomy cannot be granted to a DE that has not demonstrated it deserves it.

**Principle 4: Development is deliberate and governed.**
No change to a Digital Employee's Knowledge, configuration, or Capability assignment happens silently or automatically. Every Development action is authorised, tested, documented, and audited. The Development History is permanent.

**Principle 5: Performance is measured in Business Outcomes.**
KPIs and metrics that do not connect to Business Outcomes — tokens consumed, API calls made, requests processed — are internal diagnostics, not workforce metrics. Executive reporting always expresses Digital Workforce performance in business terms.

**Principle 6: Health is a first-class operational signal.**
The health of the Digital Workforce is a board-level concern, not an engineering metric. A degraded DE affects customers, business outcomes, and trust. Health signals must be surfaced clearly, acted upon promptly, and resolved through governed Development processes.

**Principle 7: Governance is built in, not bolted on.**
Permissions, Policies, Approval Rules, Audit Requirements, and Escalation Rules are part of every Digital Employee's Blueprint — not added after deployment. A DE that has not been through the governance framework is not ready for production.

**Principle 8: The Workforce Team is the unit of resilience.**
No critical business function should depend on a single Digital Employee. Workforce Teams with primary and backup DE coverage are the standard architecture. Single-DE coverage of critical Capabilities is a known risk that must be explicitly acknowledged and remediated.

**Principle 9: Incidents are managed, not ignored.**
When a Digital Employee causes harm — an incorrect output acted upon, a policy violation, a failed escalation — the Incident is formally recorded, investigated, and remediated. Incidents inform Trust Level decisions. A platform that does not manage AI incidents is not enterprise-ready.

**Principle 10: The Marketplace extends the framework, never bypasses it.**
Marketplace Digital Employees are subject to the same Blueprint, lifecycle, governance, and performance requirements as custom-built DEs. The Marketplace accelerates time-to-value — it does not create a governance-exempt category of AI.

**Principle 11: FTE Equivalent is auditable, not approximate.**
The economic value of the Digital Workforce must be calculable from real data using defined methodology. FTE Equivalent and ROI are governed metrics with Organisation-configured inputs — not platform-estimated numbers designed to impress rather than inform.

**Principle 12: Retirement is a managed transition, not an off switch.**
A Digital Employee is decommissioned through a formal process that resolves dependencies, concludes active work, and preserves the complete record. The retirement of a DE is an event in the organisation's workforce history, not a deletion.

**Principle 13: The Digital Workforce improves over time.**
A Digital Employee that performs exactly the same in year three as it did in year one is underperforming. The Development Framework, Performance Management model, and Skills Framework exist to make continuous, measurable improvement the default — not an aspiration.

**Principle 14: AI complexity is the platform's problem, not the customer's.**
Model selection, orchestration strategy, vector retrieval, confidence scoring, token management — none of this is the Organisation's concern. The customer configures a Digital Workforce; the platform handles the intelligence. Sophistication underneath, simplicity above.

**Principle 15: DreamTeam is a workforce platform, not an AI application.**
This is the most important principle. The Digital Workforce Framework is not a feature set — it is an operating model. Organisations that adopt it are not deploying chatbots. They are building a Digital Workforce that operates with the same governance, accountability, measurability, and strategic intent as their human workforce. That is the product.

---

*End of Document — DreamTeam AI Digital Workforce Framework v1.0*

*This document is the constitutional framework for the DreamTeam Digital Workforce. It should be treated as a foundational reference alongside the Core Domain Model. Changes to the Immutable Principles require architectural review. New Digital Employee types, Workforce Roles, or lifecycle stages introduced in future platform releases must conform to this framework or explicitly document their deviation and seek amendment.*
