# 12 — Digital Workforce Playbook Framework

**DreamTeam AI — Operational Playbook Constitutional Framework**
Version 1.0 | 2026-07-01

---

## Table of Contents

1. [What Is an Operational Playbook?](#1-what-is-an-operational-playbook)
2. [Relationship Model](#2-relationship-model)
3. [Anatomy of a Playbook](#3-anatomy-of-a-playbook)
4. [Agent Ensemble Architecture](#4-agent-ensemble-architecture)
5. [Human Collaboration](#5-human-collaboration)
6. [Playbook Lifecycle](#6-playbook-lifecycle)
7. [Playbook Inheritance](#7-playbook-inheritance)
8. [Operational Domain Playbooks](#8-operational-domain-playbooks)
9. [Playbook Composition](#9-playbook-composition)
10. [Performance & Optimisation](#10-performance--optimisation)
11. [Marketplace Readiness](#11-marketplace-readiness)
12. [Anti-Patterns](#12-anti-patterns)
13. [Immutable Principles](#13-immutable-principles)

---

## 1. What Is an Operational Playbook?

### 1.1 Definition

An Operational Playbook is the governed business process specification that defines how a Digital Employee performs a category of work. It is the authoritative description of business intent, quality standards, decision rules, governance requirements, and success criteria for a specific operational activity.

The Playbook is not code. It is not a prompt. It is not a workflow configuration file. It is a **business document that has been made executable** — authored by operations professionals, governed by compliance officers, and executed by the Workforce Engine through a coordinated ensemble of internal Agents.

Every meaningful thing a Digital Employee does is governed by a Playbook. Without a Playbook, there is no governed operation — there is only ungoverned AI behaviour.

### 1.2 Business Value

**For Outsourcetel:** Playbooks are the intellectual property of the delivery model. They encode the operational expertise that currently lives in the heads of team leads, senior agents, and operations managers — making it transferable, scalable, and measurable. A Playbook means a new Digital Employee (or a new human agent) does not need to be trained from scratch; they inherit the Playbook and execute against a proven standard.

**For clients:** Playbooks are the governance guarantee. When a client asks "how do your agents handle a billing dispute?" the answer is a Playbook — a document that defines exactly what happens, in what order, with what approval gates, measured against which KPIs. This is a fundamentally stronger assurance than "our agents are trained to handle it."

**For the platform:** Playbooks are the primary reusable asset. A well-authored Playbook for Customer Support can be deployed for ten clients with configuration changes only — no business logic rewrite. Playbooks are DreamTeam's most durable competitive advantage because they encode operational excellence, not just technical capability.

### 1.3 What a Playbook Is Not

These distinctions are critical and must be maintained consistently.

| Concept | What It Is | How It Differs from a Playbook |
|---|---|---|
| **Workflow** | A technical orchestration artifact — a pre-configured sequence of Capability invocations with defined branching logic | A Workflow implements one or more Playbook steps. A Playbook is the business intent; the Workflow is one possible technical execution path. Multiple Workflows may implement different paths within one Playbook. |
| **Capability** | A discrete, executable business outcome with defined inputs and outputs | A Capability is a building block a Playbook uses. A Playbook orchestrates one or more Capabilities, governs their sequencing, and defines what happens between and after them. |
| **AI Agent** | An internal execution component that performs a bounded task | Agents are invisible to the Playbook author. The Playbook defines what must happen; the Workforce Engine decides which Agents to deploy. |
| **Prompt** | Internal AI configuration | A prompt is an implementation detail inside an Agent. Playbooks do not contain prompts. Playbooks define business rules; prompts are how Agents fulfil them internally. |
| **SOP** | A human-authored Standard Operating Procedure — a static document | An SOP describes what humans should do. A Playbook is a governing specification that the Workforce Engine executes. A Playbook is an SOP that has been made operational, governed, measured, and continuously improved. |
| **Policy** | A rule that constrains permitted behaviour | Policies are inputs to Playbooks — they define what the Playbook cannot do. A Policy says "never do X"; a Playbook says "here is how to do Y within all applicable policies." |

### 1.4 Ownership

Every Playbook has a defined Owner — the human role accountable for its quality, currency, and performance. Ownership responsibilities:

- Reviewing the Playbook's performance metrics at defined intervals
- Approving changes to Playbook logic, decision rules, and escalation paths
- Initiating recertification when material changes are made
- Ensuring the Playbook remains compliant with applicable regulations
- Authorising the Playbook's retirement when it is no longer needed

Ownership is not optional. A Playbook without an owner is an ungoverned operation.

### 1.5 Lifecycle

Every Playbook progresses through a defined lifecycle from authoring to retirement. See Section 6 for the full lifecycle model. The lifecycle exists because operational contexts change: regulations evolve, client requirements change, AI capabilities improve, and business processes mature. A Playbook must be able to change with the business while its execution history is preserved.

### 1.6 Governance

Playbooks are governed at three levels:

**Organisation-level governance:** Which Playbooks exist, who owns them, whether they are compliant with applicable regulations, and how they perform against business objectives.

**Playbook-level governance:** The specific approval points, escalation rules, decision boundaries, and audit requirements embedded within each Playbook.

**Execution-level governance:** The Control Fabric's real-time enforcement of policies, permissions, and approval gates on every Playbook execution.

---

## 2. Relationship Model

### 2.1 The Full Stack

Every execution of an operation in DreamTeam traces through the following layers. Each layer has a specific responsibility. No layer absorbs the responsibility of another.

```
Organisation
  └── Workspace  [what the business calls a "Business Function"]
        └── Digital Employee
              └── Operational Playbook
                    └── Capabilities
                          └── Workforce Engine
                                └── Agent Ensemble
                                      ├── Tools
                                      ├── Knowledge
                                      ├── Connectors
                                      └── Intelligence Service → Model Providers
```

### 2.2 Layer Responsibilities

**Organisation**
The subscribing business entity. Owns all Playbooks, Policies, Knowledge, and Digital Employees within its tenant. Sets the governance standards that all Playbooks must meet.

**Workspace** *(what the prompt calls "Business Function")*
A bounded domain of business activity — Customer Support, Finance, Revenue, HR. Workspaces contain Capabilities and Digital Employees. A Workspace is DreamTeam's representation of a Business Function. The term "Workspace" is used throughout the platform; "Business Function" is the business-language synonym.

**Digital Employee**
The customer-facing business persona. The Digital Employee does not execute business logic directly — it executes Playbooks. The DE is what the client or customer knows and trusts; the Playbook is how the DE performs its work consistently.

**Operational Playbook**
The governing specification of how a business operation is conducted. Defines the trigger, inputs, decision rules, approval gates, quality standards, and expected outputs. The Playbook is the bridge between the Digital Employee's Responsibilities and the Workforce Engine's execution.

**Capabilities**
The discrete, executable business outcomes that a Playbook invokes. A Playbook may invoke one Capability or many, in sequence or in parallel, conditionally or unconditionally.

**Workforce Engine**
The internal orchestration service. Receives the Playbook and its context, creates an Execution Plan, coordinates the Agent Ensemble, enforces approval gates, and returns results. The Workforce Engine is not visible to Playbook authors or to customers.

**Agent Ensemble**
The coordinated set of internal Agents deployed by the Workforce Engine to execute the steps of an Execution Plan. Each Agent performs a bounded task — research, retrieval, reasoning, compliance checking, drafting, quality review. Agents are invisible to the Playbook author and to customers. See Section 4.

**Tools**
Specific, bounded, callable functions that Agents invoke to take action: create a record, send a message, query a dataset, format a document. Tools are governed by the Control Fabric.

**Knowledge**
The organisational content — documentation, policies, procedures, case histories, product information — that Agents draw upon when executing Playbook steps. Knowledge is scoped per Digital Employee via the Control Fabric.

**Connectors**
The configured bindings to external systems — CRM, ticketing, billing, ERP. Connectors give Agents access to live operational data and the ability to take action in external systems.

**Intelligence Service → Model Providers**
The internal abstraction layer that manages all AI model interactions. The Playbook author never specifies which model is used. Model selection is an operational decision made by the Intelligence Service based on the task type, cost constraints, and configured preferences.

### 2.3 The Key Insight

The Playbook author (an operations professional or business analyst) works at the **Operational Playbook** layer. They define business intent, decision rules, approval gates, and quality standards. They do not configure AI models, write prompts, or design agent coordination.

The platform engineer works at the **Capability**, **Workforce Engine**, and **Agent** layers. They ensure the technical machinery can execute what the Playbook specifies.

The client or customer interacts with the **Digital Employee** layer. They experience a named, accountable, consistent colleague — never the Playbook, never the Agents, never the models.

---

## 3. Anatomy of a Playbook

Every Playbook — whether built by Outsourcetel, installed from the Marketplace, or authored by a client — must define all components in this section. Partial Playbooks are not publishable.

### 3.1 Identity

| Field | Purpose |
|---|---|
| `playbook_id` | Unique identifier. Immutable after creation. |
| `name` | Business-language name. Example: "Handle Billing Dispute", "Qualify Inbound Lead". |
| `slug` | URL-safe identifier. Example: `handle-billing-dispute`. |
| `version` | Integer. Increments on every approved change. |
| `owner` | The human role accountable for this Playbook's quality. |
| `workspace_id` | The Workspace this Playbook belongs to. |
| `domain` | Operational domain. Example: `billing`, `customer_support`, `finance`. |
| `risk_level` | `low`, `medium`, `high`, `critical`. Drives default approval and audit requirements. |
| `lifecycle_status` | Current lifecycle stage. See Section 6. |
| `created_at` | Date Playbook was first authored. |
| `last_reviewed_at` | Date of most recent owner review. |
| `next_review_due` | Scheduled review date. |

---

### 3.2 Business Objective

One paragraph in business language describing what this Playbook exists to achieve. Written for the benefit of the Playbook owner and the client — not for engineers.

*Example: "This Playbook ensures that every billing dispute raised by a client is acknowledged within SLA, investigated against account records, resolved where the policy permits autonomous resolution, and escalated to a human Finance Manager with a complete context pack where it does not."*

---

### 3.3 Trigger

What initiates this Playbook's execution. Triggers are one of:

| Trigger Type | Example |
|---|---|
| `inbound_request` | Customer submits a support query via chat |
| `api_call` | External system calls Capability endpoint |
| `scheduled` | Daily reconciliation at 06:00 UTC |
| `event` | `connector.sync_completed` event fires |
| `workflow_step` | A parent Workflow reaches this step |
| `human_initiated` | Manager manually triggers the Playbook |
| `threshold_breach` | Metric breaches configured value |

Triggers are defined precisely — not as "when a customer has a billing issue" but as "when an inbound message is classified with intent `billing_dispute` by the triage Capability."

---

### 3.4 Inputs

The data the Playbook requires at the point of trigger. Each input specifies:

- `name` — field identifier
- `type` — string, number, object, array
- `required` — boolean
- `source` — where the input comes from: `inbound_message`, `connector_data`, `knowledge_retrieval`, `previous_capability_output`, `human_provided`
- `validation` — constraints the input must satisfy before the Playbook proceeds

Inputs that are not provided and cannot be retrieved cause the Playbook to request them before proceeding — not to fail silently.

---

### 3.5 Required Context

The additional contextual information the Workforce Engine must assemble before Playbook execution begins:

- Customer account history (from Connector)
- Previous Conversation history (from Conversation Memory)
- Relevant knowledge articles (from Knowledge Platform)
- Active policies applicable to this operation (from Control Fabric)
- Digital Employee's current Trust Level and permission set

Context assembly is the Workforce Engine's responsibility. The Playbook declares what context is needed; the engine retrieves it.

---

### 3.6 Preconditions

Conditions that must be true before the Playbook executes. If a precondition fails, the Playbook does not proceed — it routes to the defined precondition failure handler.

*Examples:*
- Customer account must be in active status
- Invoice must exist in billing system
- User must be authenticated
- Applicable connector must be in `healthy` status

Precondition failures are not errors — they are expected operational states that require a defined response.

---

### 3.7 Skills Required

The Skills (see `docs/10_Digital_Workforce_Framework.md` Section 4) a Digital Employee must possess at a defined proficiency level to execute this Playbook reliably. If the assigned DE does not meet the Skills requirement, the Playbook is blocked from assignment until the DE's Development Plan addresses the gap.

*Example for "Handle Billing Dispute":*
- Billing Policy Knowledge — proficiency ≥ 3
- Financial Record Analysis — proficiency ≥ 3
- Customer Communication — proficiency ≥ 4

---

### 3.8 Responsibilities Served

Which of the Digital Employee's Responsibilities this Playbook fulfils. A Playbook must be linked to at least one Responsibility. This prevents Playbooks from being invoked outside the DE's defined accountability domain.

---

### 3.9 Capabilities Used

The ordered or conditional set of Capabilities this Playbook invokes. Defined as a directed graph — not necessarily linear:

```
Triage Billing Query
    ↓
Retrieve Account History [via Connector]
    ↓
Classify Dispute Type
    ↓
Policy permits resolution? ──Yes──→ Calculate Resolution Amount
     ↓ No                                    ↓
Prepare Escalation Brief          Resolution within threshold?
     ↓                             ──Yes──→ Apply Resolution → Confirm to Customer
Route to Human                     ──No──→ Prepare Human Approval Request
```

Each Capability in the graph is versioned. Playbook authors specify which Capability version they require. Capability upgrades do not automatically change the Playbook.

---

### 3.10 Knowledge Required

Which Knowledge Collections the Playbook draws upon, and the access level required:

| Collection | Access Level | Freshness Requirement |
|---|---|---|
| Billing Policy Documentation | Full read | ≤ 30 days old |
| Refund and Resolution Guidelines | Full read | ≤ 7 days old |
| Client Account Procedures | Full read | ≤ 7 days old |

If a required Knowledge Collection does not meet its freshness requirement, the Playbook surfaces a `knowledge.outdated` warning before execution and may require human confirmation to proceed.

---

### 3.11 Tools Required

The specific Tools this Playbook invokes, with declared permission levels:

| Tool | Permission | Reversibility | Approval Required |
|---|---|---|---|
| `retrieve_account_record` | read | fully_reversible | No |
| `create_billing_adjustment` | execute | partially_reversible | If > threshold |
| `send_customer_notification` | execute | partially_reversible | No (within policy) |
| `update_ticket_status` | execute | fully_reversible | No |

---

### 3.12 Connector Requirements

Which external system Connectors must be active for this Playbook to execute:

| Connector Type | Required | Fallback |
|---|---|---|
| `billing_system` | Required | None — Playbook pauses if unavailable |
| `crm` | Required | None — Playbook pauses if unavailable |
| `ticketing` | Optional | Playbook proceeds without ticket update |

---

### 3.13 Agent Ensemble

The internal Agents the Workforce Engine will coordinate to execute this Playbook. This section is authored by the platform engineering team — not the Playbook business author. It is included in the Playbook specification for transparency and auditability, not for customer consumption.

*Example for "Handle Billing Dispute":*

- **Research Agent** — retrieves account history and previous dispute records
- **Knowledge Retrieval Agent** — finds relevant billing policy and resolution guidelines
- **Reasoning Agent** — analyses the dispute against policy and calculates applicable resolution
- **Compliance Agent** — validates proposed resolution against applicable policies and regulatory requirements
- **Communication Agent** — drafts the customer response in the appropriate tone and format
- **Quality Assurance Agent** — reviews the draft response before delivery or human review
- **Audit Agent** — records the full execution trace to the Audit Trail

See Section 4 for the full Agent Ensemble architecture.

---

### 3.14 Human Approval Points

Precisely defined points at which a human must review and approve before execution continues. Each approval point specifies:

| Field | Purpose |
|---|---|
| `approval_id` | Identifier for this approval gate within the Playbook |
| `trigger_condition` | What causes this approval gate to activate |
| `approver_role` | Which human role must approve |
| `context_provided` | What the approver sees (context pack contents) |
| `timeout_window` | How long before the request expires |
| `on_approval` | What happens next |
| `on_rejection` | What happens next |
| `on_timeout` | Auto-reject, escalate, or hold |
| `audit_requirement` | Always — every approval decision is audited |

*Example approval point:*
```json
{
  "approval_id": "billing_resolution_approval",
  "trigger_condition": "resolution_amount > tenant_config.billing_auto_approve_threshold",
  "approver_role": "finance_manager",
  "context_provided": ["account_summary", "dispute_details", "policy_reference", "resolution_calculation"],
  "timeout_window": "4_hours",
  "on_approval": "apply_resolution_and_notify_customer",
  "on_rejection": "route_to_senior_finance_review",
  "on_timeout": "escalate_to_operations_manager"
}
```

---

### 3.15 Decision Rules

The business logic governing conditional paths within the Playbook. Decision rules are expressed in business language — not code. They are authored by the Playbook owner and interpreted by the Workforce Engine.

*Example decision rules for "Handle Billing Dispute":*
- If dispute amount ≤ auto-resolve threshold AND dispute type is in approved auto-resolve categories AND customer account is in good standing → auto-resolve
- If dispute amount > auto-resolve threshold → request human approval
- If dispute involves a contract-level pricing commitment → always route to human
- If customer has escalated to a senior contact → always route to human regardless of amount
- If the same dispute has been raised more than twice → flag as pattern and route to human

Decision rules reference Policy values — they do not hardcode threshold values. Thresholds live in configuration, not in the Playbook logic.

---

### 3.16 Exception Handling

Defined responses to unexpected conditions during execution:

| Exception | Response |
|---|---|
| Connector unavailable | Pause Playbook, alert admin, retry after configured interval |
| Knowledge retrieval failure | Proceed with available context, flag low-confidence, raise escalation threshold |
| Confidence below threshold mid-execution | Pause, route to human with current context |
| Agent execution timeout | Retry up to configured limit, then route to human |
| Precondition failure mid-execution | Halt Playbook, record exception, notify owner |
| Policy violation detected | Halt immediately, generate policy violation audit entry, notify compliance |

No exception is handled silently. Every exception generates an Audit Trail entry.

---

### 3.17 Escalation Rules

Conditions under which the Playbook transfers accountability to a human. Escalation rules are distinct from approval points — approvals are planned checkpoints; escalations are triggered responses to unexpected conditions.

*Examples:*
- Customer sentiment below -0.5 at any point → immediate escalation regardless of Playbook stage
- Three consecutive failed resolution attempts → escalate to senior specialist
- Customer explicitly requests a human → honour immediately, no delay
- Compliance Agent flags a regulatory concern → halt and escalate to Compliance Officer

Every escalation generates a Handoff with full context — the human who receives the escalation never starts cold.

---

### 3.18 Expected Outputs

The defined deliverables this Playbook produces on successful completion:

| Output | Type | Recipient | Format |
|---|---|---|---|
| Customer response | Communication | Customer | Formatted per channel |
| Resolution record | Data | Billing system (via Connector) | Structured record |
| Ticket update | Data | Ticketing system | Status + notes |
| Audit record | Immutable log | Audit Trail | Standard audit schema |
| Performance metrics | Data | Analytics | Per-execution metrics |

---

### 3.19 KPIs and Success Metrics

The measurable outcomes this Playbook is accountable for:

| KPI | Definition | Target |
|---|---|---|
| Resolution Rate | % of disputes resolved without human escalation | ≥ 70% at Stage 2 |
| First-Contact Resolution | % resolved in the initiating conversation | ≥ 60% |
| Customer Satisfaction | CSAT score on resolved disputes | ≥ 4.2/5.0 |
| SLA Achievement | % resolved within contracted SLA | ≥ 98% |
| Average Resolution Time | Mean time from trigger to resolution | ≤ 4 hours |
| Human Escalation Rate | % routed to human | ≤ 30% |
| Policy Compliance Rate | % of executions with zero policy flags | ≥ 99.5% |
| Cost per Execution | AI spend + overhead per Playbook run | Per budget target |

---

### 3.20 Audit Requirements

Every Playbook execution generates a structured audit record containing:

- Playbook ID and version
- Digital Employee ID
- Human initiator ID (if applicable)
- Trigger type and trigger data
- All Capabilities invoked (with inputs and outputs)
- All Tools invoked (with input summary and outcome)
- All approval points reached and decisions recorded
- All escalation events
- All policy evaluations and outcomes
- Final output summary
- Execution duration
- Total AI token usage and cost
- Execution outcome (completed / failed / escalated / cancelled)

This record is immutable, append-only, and retained per the data retention policy in `docs/08_Database_Design.md`.

---

### 3.21 Cost Profile

| Field | Purpose |
|---|---|
| `estimated_cost_usd` | Average AI token cost per execution at standard volume |
| `cost_per_execution_target` | Budget target per run |
| `monthly_volume_estimate` | Expected executions per month |
| `monthly_budget_usd` | Total monthly AI budget allocation for this Playbook |
| `cost_alert_threshold` | % of monthly budget that triggers an alert |

Cost estimates are recalibrated monthly based on actual execution data.

---

### 3.22 Estimated Duration

| Field | Purpose |
|---|---|
| `estimated_duration_ms` | Average end-to-end execution time |
| `sla_threshold_ms` | SLA commitment — executions exceeding this trigger an SLA alert |
| `p99_duration_ms` | 99th percentile duration (for capacity planning) |

---

## 4. Agent Ensemble Architecture

### 4.1 What the Agent Ensemble Is

The Agent Ensemble is the coordinated set of internal Agents that the Workforce Engine deploys to execute a Playbook's Execution Plan. It is the technical implementation layer — completely invisible to Playbook authors, Digital Employees, and customers.

The Playbook defines what must be done. The Workforce Engine determines which Agents to deploy. The Agent Ensemble executes. The customer experiences the Digital Employee's output.

**The word "Agent" must never appear in customer-facing surfaces, client documentation, or Playbook business specifications.** Agents are an engineering concept. The business concept is the Digital Employee and its Playbook.

### 4.2 Agent Types

**Research Agent**
Gathers information from Connectors, external data sources, and prior Conversation Memory. Assembles the factual foundation the other Agents need. Does not reason or generate responses — it retrieves and structures.

*Responsible for:* Account lookups, historical record retrieval, entity resolution, data enrichment

**Knowledge Retrieval Agent**
Searches Knowledge Collections for relevant content using semantic and keyword retrieval. Returns ranked, cited results with confidence scores. Does not interpret — it retrieves.

*Responsible for:* Policy lookups, procedure retrieval, FAQ matching, documentation citation

**Reasoning Agent**
Analyses the assembled context against the Playbook's decision rules. Evaluates conditions, applies logic, and determines the recommended path through the Playbook. Produces structured reasoning outputs — not free text responses.

*Responsible for:* Decision rule evaluation, option analysis, recommendation generation, confidence scoring

**Compliance Agent**
Evaluates every proposed action against the Control Fabric's active policies. Runs in parallel with or immediately after the Reasoning Agent. If the Compliance Agent flags a policy violation, execution halts regardless of what other Agents have concluded.

*Responsible for:* Policy evaluation, regulatory constraint checking, data handling compliance, approval gate triggering

**Communication Agent**
Drafts all customer-facing and internal communications produced by the Playbook. Takes the Reasoning Agent's structured output and produces natural language content formatted for the appropriate channel.

*Responsible for:* Response drafting, email composition, notification generation, summary writing

**Quality Assurance Agent**
Reviews outputs before they are delivered or submitted for human approval. Checks for completeness, accuracy, tone, policy compliance, and factual consistency against Knowledge sources.

*Responsible for:* Output review, citation verification, tone check, completeness validation

**Execution Agent**
Takes approved actions in external systems via Tools and Connectors. Creates records, updates statuses, sends notifications, and applies resolutions. The Execution Agent is the only Agent that creates side effects in external systems.

*Responsible for:* Tool invocation, Connector writes, record creation and update, notification dispatch

**Audit Agent**
Runs continuously throughout Playbook execution. Records every significant event — Agent outputs, decision points, approval triggers, tool calls, compliance evaluations — to the Audit Trail. The Audit Agent cannot be disabled.

*Responsible for:* Real-time audit record generation, execution trace capture, compliance event logging

**Cost Optimisation Agent**
Monitors token usage during execution and, where the Playbook permits, selects lower-cost model options for tasks that do not require maximum capability. Operates within the Intelligence Service's model selection framework.

*Responsible for:* Token usage monitoring, model selection optimisation, cost attribution

**Manager Agent** *(for complex multi-step Playbooks only)*
In Playbooks with significant conditional complexity or DE Composition (multiple Digital Employees collaborating), a Manager Agent coordinates the sequencing of other Agents and resolves conflicts between their outputs. Used sparingly — only when coordination complexity warrants it.

*Responsible for:* Agent output synthesis, conflict resolution, plan adaptation mid-execution

### 4.3 Ensemble Composition

Not every Playbook deploys every Agent. The Workforce Engine assembles the minimum Agent Ensemble required for the Playbook's specific execution path. A simple Knowledge lookup Playbook may require only Research, Knowledge Retrieval, Communication, and Audit Agents. A complex billing resolution Playbook deploys the full ensemble.

The Ensemble is determined at runtime — not prescribed at Playbook authoring time. The Playbook author declares what must happen; the Workforce Engine decides how to deploy the Agents to make it happen.

### 4.4 Agent Coordination Principles

1. **Agents are stateless between invocations.** Each Agent receives the full context it needs at invocation time. Agents do not maintain their own state between Playbook executions.

2. **The Compliance Agent has veto authority.** Any Agent output that is flagged by the Compliance Agent as a policy violation causes an immediate halt, regardless of what other Agents have concluded.

3. **The Audit Agent cannot be bypassed.** Every Agent invocation is logged to the Audit Agent's stream. There is no execution path that bypasses the Audit Agent.

4. **The Execution Agent only acts on approved outputs.** The Execution Agent never acts on outputs that have not passed the Quality Assurance Agent and, where applicable, received human approval.

5. **Model selection is the Intelligence Service's responsibility.** No Agent hardcodes a model provider. All model invocations go through the Intelligence Service abstraction.

---

## 5. Human Collaboration

### 5.1 Designed-In, Not Added-On

Human participation in Playbook execution is designed into the Playbook from the start — not added reactively when something goes wrong. Every Playbook specifies exactly where humans are involved, in what capacity, and with what authority.

This is the "trust-before-automation" principle applied at the Playbook level. A Playbook that has been designed with appropriate human touchpoints from the start is more trustworthy than one that attempts full automation and adds humans as an afterthought.

### 5.2 Human Roles in Playbook Execution

**Approver**
Reviews a specific action and grants or denies permission to proceed. An Approver receives a structured context pack — not a raw AI output — assembled by the Agent Ensemble. The context pack presents: what happened, what the DE recommends, what the impact is, and what options exist. The Approver makes a decision; they do not do additional research.

**Exception Handler**
Receives cases that the Playbook cannot resolve — because a precondition failed, a decision rule led to no eligible path, or confidence fell below threshold. The Exception Handler takes over with full context and resolves the case using their judgment.

**Coach / Reviewer**
Reviews sampled DE outputs for quality, consistency, and compliance. Provides feedback that feeds into Development Plans and Playbook improvements. Does not intervene in live executions — reviews completed work.

**Relationship Manager**
Handles all moments where human relationship is the primary value — senior client conversations, escalated complaints, contract discussions, strategic decisions. The DE prepares the context; the Relationship Manager leads the interaction.

**Playbook Owner**
Reviews Playbook performance metrics, authorises changes, approves new versions, and ensures the Playbook remains fit for purpose. The Owner's involvement is periodic (performance reviews, development actions) not transactional (per-execution).

**Compliance Officer**
Reviews Playbooks for regulatory compliance before certification. Signs off on Playbooks that operate in regulated domains. Receives immediate alerts on compliance events during live execution.

### 5.3 The Handoff Covenant

When a Playbook transfers work to a human — whether through an approval gate, an escalation, or an exception path — the human always receives:

1. **Full context** — everything the DE knows about the situation
2. **DE's reasoning** — what the DE concluded and why
3. **Recommended action** — what the DE would do if it had authority
4. **Available options** — the alternatives and their implications
5. **Urgency signal** — whether SLA is at risk

The human never starts cold. The value of the Digital Workforce is not only in what it resolves autonomously — it is in how well it prepares the human for what it cannot resolve.

---

## 6. Playbook Lifecycle

### 6.1 Overview

Every Playbook progresses through a defined lifecycle. Lifecycle stage is a governance gate — not a label. Each stage has entry criteria, permitted operations, and exit criteria.

```
Designed → Drafted → Configured → Tested → Simulated → Certified → Published
                                                                        ↓
                                                                     Assigned
                                                                        ↓
                                                                      Active
                                                                        ↓
                                                              Continuously Improved ←──┐
                                                                        ↓              │
                                                                    Deprecated ─────────┘
                                                                        ↓
                                                                     Retired
```

### 6.2 Stage Definitions

---

**Designed**
The Playbook's business objective, trigger, and scope have been agreed. A Playbook Owner has been assigned. The Playbook exists as an outline — not yet drafted in full.

*Entry:* Decision to create a new Playbook.
*Exit:* Business objective, scope, and Owner defined. Linked to a Workspace and at least one Digital Employee role.

---

**Drafted**
The Playbook's full Anatomy (Section 3) has been completed. All fields are populated. Decision rules and exception handling have been written in business language.

*Entry:* Outline approved.
*Exit:* All mandatory Anatomy fields complete. Reviewed by at least one subject matter expert in the domain. Knowledge gaps identified and addressed.

---

**Configured**
The Playbook has been translated into executable configuration in the platform. Capabilities are assigned and versioned. Connector requirements are validated. Agent Ensemble is specified by the engineering team. Control Fabric policies are applied.

*Entry:* Draft reviewed and approved.
*Exit:* All Capabilities assigned and available. All required Connectors healthy. All Tools declared and permissions confirmed. Approval rules configured in the platform.

---

**Tested**
The Playbook is executed against a defined test suite in a non-production environment. Test cases cover the happy path, all decision rule branches, all escalation triggers, and all exception scenarios.

*Entry:* Configuration complete.
*Exit:* All test cases pass. Zero policy violations. Approval gates verified to trigger correctly. KPI baselines estimated from test data. Performance (duration, cost) within target range.

---

**Simulated**
Shadow-mode execution. The Playbook runs against real production inputs but takes no actions and delivers no outputs to customers or external systems. The full Agent Ensemble executes. Every step produces real outputs — they are simply held for human review rather than delivered.

Human reviewers observe the complete execution trace: what was retrieved, what was reasoned, what was drafted, what approval gates were triggered, what would have been sent. This is the final validation that the Playbook behaves as designed under real conditions.

*Entry:* Testing complete and passed.
*Exit:* Simulation runs for a defined period (minimum 5 business days, or 50 executions — whichever comes later). Human reviewers sign off on output quality. Edge cases identified are addressed (returning to Configured if significant changes required, or proceeding if minor). No critical issues observed.

---

**Certified**
A qualified reviewer — Playbook Owner, Compliance Officer for regulated domains, or senior operations lead — formally certifies that the Playbook is fit for live deployment. Certification is a governance checkpoint that cannot be automated.

*Entry:* Simulation approved.
*Exit:* Certification record created with reviewer identity, timestamp, scope, and any conditions attached to the certification.

---

**Published**
The Playbook is available for assignment to Digital Employees. It is not yet handling live work.

*Entry:* Certified.
*Exit:* Assigned to at least one Digital Employee.

---

**Assigned**
The Playbook has been assigned to one or more Digital Employees and is configured for a specific Workspace and client context. Knowledge has been populated. Connectors are active.

*Entry:* Published and assigned.
*Exit:* First live execution completes successfully.

---

**Active**
The Playbook is handling live work. Performance metrics are accumulating. The Owner reviews performance at defined intervals.

*Entry:* First successful live execution.
*Permitted changes:* Minor configuration adjustments (threshold values, Knowledge updates) that do not change business logic. Major changes require a version increment and return to Configured.
*Exit:* Performance gap identified (→ Continuously Improved) or retirement decision made.

---

**Continuously Improved**
An active Playbook with an open improvement cycle. The Playbook continues to handle live work while a Development Plan drives targeted improvements. Improvement cycles close when targets are met; the Playbook remains Active unless issues are severe enough to warrant temporary suspension.

*Entry:* Performance review identifies gap, or Owner initiates improvement cycle.
*Exit:* Improvement targets met, validated through performance data. Returns to Active.

---

**Deprecated**
The Playbook has been superseded by a newer version or a replacement Playbook. It is no longer the primary Playbook for its operational domain but may still be executing for a transition period. No new Digital Employee assignments are made to a Deprecated Playbook.

*Entry:* Owner decision; typically accompanied by a Published replacement.
*Exit:* All active executions complete; transition period ends. → Retired.

---

**Retired**
The Playbook is permanently decommissioned. No further executions. Full execution history and configuration retained per retention policy. The Playbook remains queryable for audit, compliance, and reference purposes.

*Entry:* Deprecation transition period complete; all DEs migrated to replacement.
*Exit:* N/A — terminal state.

---

## 7. Playbook Inheritance

### 7.1 The Multi-Client Problem

Outsourcetel runs the same operational processes for multiple clients. A "Handle Customer Billing Dispute" Playbook serves the same fundamental business intent across all clients — but each client has different thresholds, different escalation contacts, different Knowledge content, different SLA commitments, and potentially different regulatory requirements.

Without Playbook Inheritance, Outsourcetel maintains a separate, near-identical Playbook for every client. When the core process improves — a better decision rule, a more effective escalation path, a new compliance requirement — the improvement must be manually applied to every client's copy. This is operationally unsustainable at scale and creates divergence risk.

### 7.2 The Inheritance Model

Playbook Inheritance allows a **Client-Specific Playbook** to inherit from a **Base Playbook** — taking the core business logic, decision rules, and process structure from the base while overriding specific fields for the client's context.

```
Base Playbook: Handle Billing Dispute [v3.2]
  ├── Business Objective (inherited, not overridable)
  ├── Core Decision Rules (inherited, some overridable)
  ├── Capabilities Used (inherited, client may add but not remove)
  ├── Agent Ensemble (inherited, not overridable)
  ├── Audit Requirements (inherited, not overridable)
  └── [Overridable fields]
        ├── Knowledge Collections → Client-specific KB
        ├── Approval Thresholds → Client-specific values
        ├── Escalation Contacts → Client-specific team
        ├── SLA Targets → Client contract values
        ├── Connector References → Client-specific systems
        └── Communication Templates → Client-branded format
```

### 7.3 Inheritance Rules

**What can be overridden:**
- Knowledge Collection references
- Approval thresholds and timeout windows
- Escalation contacts and routing
- SLA targets and KPI thresholds
- Connector references (a client may use Zendesk instead of Freshdesk)
- Communication templates and tone guidelines
- Cost budget targets

**What cannot be overridden:**
- Core business logic and decision rule structure
- Agent Ensemble composition
- Audit requirements
- Compliance and policy checks
- The fundamental business objective

**The rationale:** Core logic and governance are Outsourcetel's IP and quality guarantee. Client-specific context is configuration. The distinction between the two defines what makes the Playbook a platform asset rather than a bespoke delivery.

### 7.4 Inheritance and Versioning

When the Base Playbook is updated to a new version:

1. All Client-Specific Playbooks that inherit from it receive an upgrade notification
2. Outsourcetel's operations team reviews the change log and decides whether to upgrade each client's Playbook
3. Upgraded client Playbooks undergo a targeted re-test of affected decision paths
4. The upgrade is certified by the client's Playbook Owner
5. The client Playbook's version increments (independently of the Base version)

Clients are not forced to upgrade immediately. The Base Playbook version a Client-Specific Playbook inherits from is pinned and recorded. A client running a Playbook that inherits from a deprecated Base version receives a governance alert.

---

## 8. Operational Domain Playbooks

### 8.1 Reference Playbook Library

The following describes the primary operational Playbooks for each domain. This is not an exhaustive list — it is the foundational set that Outsourcetel should build first. Each entry names the Playbook and identifies the trigger, primary decision point, and key human touchpoint.

---

### Customer Support

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Handle Customer Query | Inbound message classified as general query | Confidence ≥ threshold? | Escalation if below |
| Handle Billing Dispute | Inbound classified as billing dispute | Amount ≤ auto-resolve threshold? | Finance approval above threshold |
| Handle Product Complaint | Inbound classified as complaint | Severity level? | High severity → human immediately |
| Manage Escalated Case | Escalation trigger from another Playbook | Can DE resolve? | Always involves human for client-facing resolution |
| Process Service Request | Inbound classified as service request | Policy permits autonomous fulfilment? | Exception requests → human |
| Handle Cancellation Request | Customer requests cancellation | Retention offer applicable? | Senior agent for high-value accounts |
| Generate Case Summary | Case resolved or handed off | Completeness check | None — autonomous |

---

### Technical Support

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Diagnose Technical Issue | Inbound technical support request | Issue in known resolution playbook? | L2/L3 escalation for novel issues |
| Execute Resolution Playbook | Known issue identified | Resolution requires system access? | Human executes any infrastructure change |
| Document Resolution | Issue resolved | Resolution novel enough to add to KB? | Human approves new KB article |
| Prepare L2 Escalation Brief | Confidence below threshold | — | Human L2 engineer receives brief |
| Track Known Issue Status | Recurring issue detected | Mass communication required? | Human approves mass communication |

---

### Customer Success

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Monitor Account Health | Scheduled: daily per account | Health score below threshold? | CSM alert for at-risk accounts |
| Detect Churn Risk | Health signal or usage drop | Risk severity? | High-risk → immediate CSM handoff |
| Prepare QBR Pack | Scheduled: 3 weeks before QBR date | Data complete? | CSM reviews and presents |
| Manage Renewal Workflow | 90 days before contract end | Auto-renew eligible? | CSM leads commercial conversation |
| Identify Expansion Opportunity | Usage pattern above threshold | Opportunity qualified? | CSM owns expansion conversation |
| Draft Success Plan | New client or plan refresh cycle | Plan approved? | CSM and client sign off |

---

### Business Development

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Research Target Account | Prospect added to ICP list | ICP match score ≥ threshold? | BD Manager reviews and approves prospect list |
| Qualify Inbound Lead | Lead submitted or inbound enquiry | Qualification score ≥ threshold? | BD Manager handles qualified leads |
| Draft Outreach Sequence | Prospect approved for outreach | Personalisation quality ≥ threshold? | BD Manager approves before send |
| Prepare Meeting Briefing Pack | Meeting confirmed in calendar | Pack complete? | Autonomous — human reviews before meeting |
| Update CRM After Interaction | Meeting or call logged | Record complete? | Autonomous |
| Monitor Competitive Intelligence | Scheduled: weekly | Signal material? | BD Manager receives weekly briefing |

---

### Sales Operations

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Monitor Pipeline Health | Scheduled: daily | Deal stalled beyond threshold? | CRO alert for stalled deals |
| Generate Revenue Forecast | Scheduled: weekly | Forecast methodology applied correctly? | CRO reviews and adjusts |
| Review Deal Desk Request | Non-standard pricing submitted | Within policy exception range? | Commercial Director approves exceptions |
| Track Contract Milestones | Ongoing: all active contracts | Milestone within alert window? | Delivery Manager receives alert |
| Prepare Renewal Proposal | Contract end approaching | Standard renewal or negotiated? | Account Manager leads commercial discussion |

---

### Customer Onboarding

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Initiate Onboarding | New client contract signed | Onboarding template match? | Delivery Manager leads kickoff call |
| Collect Configuration Requirements | Onboarding initiated | Requirements complete? | Human validates complex requirements |
| Setup Knowledge Collections | Requirements collected | Content complete? | Human reviews and approves KB content |
| Validate Configuration | Configuration complete | All checks passed? | Delivery Manager signs off readiness |
| Generate Handover Pack | Configuration validated | Handover criteria met? | Delivery Manager delivers to client |
| Track Onboarding Milestone | Ongoing during onboarding | Milestone at risk? | Delivery Manager receives alert |

---

### Billing Operations

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Generate Client Invoice | Billing cycle trigger | Invoice within threshold? | Finance Manager reviews above threshold |
| Process Payment Reminder | Invoice overdue | Escalation level? | Collections team for severe overdue |
| Manage Collections Outreach | Account past defined ageing | Value above threshold? | Finance Manager handles material amounts |
| Reconcile Billing Records | Scheduled: daily | Variance detected? | Finance Manager reviews variances |
| Handle Billing Query | Inbound billing query | Query resolvable with account data? | Finance Manager for complex queries |
| Process Credit Note | Credit request received | Credit within policy? | Finance Director approval above threshold |

---

### Accounting Operations

| Playbook | Trigger | Key Decision | Human Touchbook |
|---|---|---|---|
| Daily Reconciliation | Scheduled: daily | All items matched? | Accountant reviews unmatched items |
| Review Supplier Invoice | Invoice received | Invoice matches PO and contract? | Finance Manager approves discrepancies |
| Month-End Close Preparation | Scheduled: last 3 days of month | All items complete? | Finance Director reviews and signs off |
| Generate Management Accounts | Scheduled: monthly | Anomalies detected? | CFO reviews before distribution |
| Payroll Input Review | Payroll cycle trigger | All inputs valid? | Finance Manager processes payroll |

---

### Quality Assurance

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Sample and Score DE Output | Scheduled: daily sampling | Score below threshold? | QA Manager reviews low-scoring samples |
| Generate Coaching Brief | Score pattern identified | Coaching brief actionable? | Team Leader delivers coaching |
| Calibration Review | Weekly calibration cycle | Scoring consistent? | QA Manager adjudicates inconsistencies |
| Generate QA Trend Report | Scheduled: weekly | Trend material? | Quality Director reviews and acts |
| Audit Playbook Execution | Exception or incident trigger | Audit complete? | Compliance Officer reviews findings |

---

### Knowledge Management

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Detect Knowledge Gap | Escalation pattern or DE signal | Gap material? | Knowledge Manager prioritises gap closure |
| Draft Knowledge Article | Gap identified | Draft quality ≥ threshold? | Knowledge Manager approves publication |
| Review Article Freshness | Scheduled: per article freshness threshold | Article outdated? | Subject matter expert updates content |
| Identify Duplicate Content | Scheduled: weekly | Duplicate confirmed? | Knowledge Manager consolidates |
| Generate Knowledge Health Report | Scheduled: weekly | Health score below target? | Knowledge Director reviews |

---

### Learning & Development

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Identify Training Need | QA data or performance gap | Need confirmed? | L&D Manager prioritises |
| Generate Training Module | Training need approved | Module quality ≥ threshold? | L&D Manager reviews before publication |
| Administer Assessment | Training module completed | Pass threshold met? | L&D Manager reviews failure patterns |
| Track Certification Progress | Certification schedule | On track? | Team Leader manages at-risk certifications |

---

### Compliance Operations

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Monitor Policy Adherence | Continuous: all executions | Violation detected? | Compliance Officer receives immediate alert |
| Track Regulatory Changes | Scheduled: daily source monitoring | Change material? | Compliance Officer assesses impact |
| Prepare Audit Evidence Pack | Audit notification received | Evidence complete? | Compliance Officer reviews and submits |
| Review Data Handling Compliance | Scheduled: weekly | Breach detected? | DPO and Compliance Officer act immediately |
| Conduct Playbook Compliance Review | Certification or scheduled review | Playbook compliant? | Compliance Officer certifies |

---

### Service Delivery Management

| Playbook | Trigger | Key Decision | Human Touchpoint |
|---|---|---|---|
| Monitor SLA Performance | Continuous: all active SLAs | SLA at risk? | Delivery Manager receives alert ≥ 4 hours before breach |
| Generate Client Performance Report | Scheduled: per client cadence | Anomaly in data? | Delivery Manager reviews before sending to client |
| Track Open Escalations | Continuous: all open escalations | Escalation overdue? | Delivery Manager acts on overdue items |
| Prepare QBR Data Pack | Scheduled: 3 weeks before QBR | Data complete? | Delivery Manager reviews and presents |
| Monitor Contract Obligations | Continuous: all active contracts | Obligation at risk? | Delivery Manager receives advance alert |

---

## 9. Playbook Composition

### 9.1 Modular by Design

Playbooks are not monolithic specifications. They are assembled from reusable components that can be combined, customised, and versioned independently. This modularity enables Outsourcetel to build new Playbooks rapidly by composing proven components — rather than authoring every element from scratch.

### 9.2 Reusable Components

**Capability Blocks**
Individual Capabilities — Qualify Lead, Answer Question, Retrieve Account Record — are standalone, versioned, testable units. A Capability Block can be used in any number of Playbooks. When the Capability is improved, all Playbooks that reference it benefit from the improvement (subject to their upgrade policy).

**Decision Rule Libraries**
Common decision rules — "escalate if sentiment below threshold", "require approval if amount above threshold", "flag if same issue raised more than N times" — can be defined once in a library and referenced by any Playbook. When the rule changes (e.g. the threshold value changes), it changes in one place.

**Approval Templates**
Standard approval gate configurations — which role approves, what context they receive, timeout window, behaviour on timeout — can be templated and reused across Playbooks with similar approval requirements. Approval templates ensure consistency across the approval experience.

**Exception Handlers**
Standard responses to common exceptional conditions — connector unavailable, confidence below threshold, precondition failure — are defined once and referenced by any Playbook. Consistency in exception handling is a quality and governance requirement.

**Escalation Paths**
Named escalation configurations — which team receives the escalation, what context is included in the Handoff, what the priority is — are defined at the Workspace level and referenced by Playbooks. When a team changes, the escalation path is updated in one place.

**Knowledge References**
Knowledge Collections are referenced by Playbooks — not embedded. A Playbook references the "Billing Policy" collection; the content of that collection is updated independently. The Playbook always uses the current version of the Knowledge it references.

**Communication Templates**
Standard communication frameworks — acknowledgement messages, resolution confirmations, escalation notifications — are templated and referenced by Playbooks. Client-specific Playbooks override the template with client-branded versions.

**Policy References**
Applicable policies are referenced by Playbooks, not embedded. When a policy changes, all Playbooks that reference it automatically execute against the new policy without requiring a Playbook version change.

### 9.3 Composition Governance

Reusable components are versioned independently. When a component is updated, Playbooks that reference it receive an upgrade notification. Whether to adopt the updated component is a decision for the Playbook Owner — not an automatic change.

This prevents silent changes in live Playbooks while ensuring that improvements are available when the Owner is ready to adopt them.

---

## 10. Performance & Optimisation

### 10.1 The Measurement Framework

Every Playbook execution generates a performance record. Performance is measured at three levels:

**Execution Level** — per run metrics captured automatically:
- Execution duration
- AI token usage and cost
- Agent Ensemble composition used
- Approval gates triggered
- Escalations triggered
- Outcome (completed / escalated / failed)
- Capability versions used

**Aggregate Level** — rolling summaries at defined periods:
- DE-handled rate (% completed without human intervention)
- First-contact resolution rate
- Average execution cost
- Average execution duration
- Escalation rate
- Approval rate
- SLA achievement rate
- Knowledge citation accuracy

**Business Outcome Level** — the metrics that matter to executives:
- Customer satisfaction scores
- Business outcomes contributed
- Hours of human effort saved
- Cost per resolved case
- FTE equivalent value

### 10.2 Continuous Improvement Cycle

```
Playbook Executes
        ↓
Performance Metrics Accumulate
        ↓
Insight Engine Analyses Trends
        ↓
Recommendation Generated (e.g. "Escalation rate 8% above target — 
Knowledge gap in refund policy for international orders")
        ↓
Playbook Owner Reviews Recommendation
        ↓
Development Action Approved (e.g. Knowledge update, decision rule adjustment)
        ↓
Change Applied → Playbook Version Increments
        ↓
Performance Improvement Validated
        ↓
Cycle Repeats
```

No Playbook is ever "finished." Every Playbook is either performing well or has an open improvement cycle.

### 10.3 Optimisation Levers

When a Playbook's performance is below target, the following levers are available (in order of impact, ascending by governance cost):

1. **Knowledge update** — most common root cause of accuracy issues; lowest governance cost
2. **Decision rule adjustment** — threshold changes, rule refinement; requires Playbook version increment
3. **Approval threshold recalibration** — adjust where human gates activate; requires Owner approval
4. **Escalation threshold adjustment** — recalibrate when DE escalates; requires review
5. **Capability upgrade** — adopt a newer Capability version; requires testing
6. **Agent Ensemble adjustment** — add or swap an Agent type; requires engineering and re-simulation
7. **Playbook redesign** — fundamental logic change; full lifecycle restart from Configured

Start with Knowledge. Reach for Playbook redesign only when all other levers are exhausted.

---

## 11. Marketplace Readiness

### 11.1 Design for Portability from Day One

Every Playbook Outsourcetel authors for its own delivery operations is being authored as a future Marketplace asset. This is not a future migration exercise — it is a present design discipline. The discipline is simple: follow the standards in this document, and the Playbook is already Marketplace-ready.

### 11.2 Portability Requirements

For a Playbook to be Marketplace-ready, it must satisfy all of the following:

**No hardcoded client values.** Approval thresholds, SLA targets, escalation contacts, and Knowledge references are configuration parameters — not fixed values in the Playbook logic.

**Connector type references, not instance references.** A Playbook requires a `billing_system` connector — not "the Xero connector at TCP's account." The specific connector instance is a deployment-time configuration.

**Knowledge is a swappable layer.** The Playbook references Knowledge Collection types — not specific content. A "Billing Policy" collection is populated with the installing Organisation's content at deployment time.

**Decision rules are parameterised.** Threshold values and category lists are configuration parameters. The rule structure is the IP; the values are the context.

**Owned by a domain, not a client.** A Playbook belongs to a Workspace domain (`billing`, `customer_support`) — not to a specific client account. Client-specific Playbooks are always child Playbooks that inherit from a domain-level Base Playbook.

**Fully documented.** Every field in Section 3 is complete. Undocumented Playbooks cannot be packaged.

**Versioned with a changelog.** Every version increment has a documented change summary. Organisations installing a Playbook from the Marketplace must be able to understand what changed between versions.

### 11.3 Solution Pack Bundling

Related Playbooks for a domain can be bundled into a **Solution Pack** — a single Marketplace artifact that includes:

- A set of related Playbooks (e.g. all Customer Support Playbooks)
- The required Capabilities
- Knowledge Collection templates
- Default Connector requirements
- Default Control Fabric policies
- A recommended Digital Employee configuration

Solution Packs are the mechanism by which Outsourcetel's operational expertise becomes a commercial product.

---

## 12. Anti-Patterns

### 12.1 Playbooks Hardcoded into Code

Writing Playbook logic as application code — conditional statements, hardcoded API sequences, prompt strings — creates an ungovernable operation. When the business process changes, code must be redeployed. When a policy changes, developers must change code. When a new client is onboarded, code must be copied and modified.

Playbooks belong in the Playbook layer, configured through the platform. Operations professionals change them; not engineers.

### 12.2 AI Agents Bypassing Playbooks

Agents that call Tools, Connectors, or external systems directly without a governing Playbook — invoked ad-hoc by a Digital Employee or by another Agent outside the Workforce Engine's orchestration — are ungoverned operations. There are no audit records, no approval gates, no policy evaluations, and no performance metrics. This is the equivalent of an employee taking consequential action with no authorisation.

Every consequential operation is governed by a Playbook. There are no authorised bypasses.

### 12.3 Missing Approval Points

A Playbook that performs irreversible actions — deleting records, sending communications, processing financial adjustments — without any human approval gate is a governance failure. Approval gates may feel like friction, but they are the mechanism by which the Organisation retains control over consequential actions. Missing an approval point is not an efficiency improvement; it is a risk.

The reversibility classification of every Tool used in a Playbook must be reviewed when the Playbook is designed. Every `irreversible` or `difficult_to_reverse` Tool requires a corresponding approval point.

### 12.4 No Audit Trail

A Playbook execution that does not generate a complete Audit Trail record cannot be reviewed, investigated, or reported on. Silent operations are governance failures. In regulated environments, they are compliance failures.

The Audit Agent runs on every Playbook execution. It cannot be disabled. If a Playbook is not generating audit records, the Audit Agent is not running — which means the Playbook is not executing through the Workforce Engine.

### 12.5 Vendor-Specific Playbooks

A Playbook that embeds Salesforce field names, Zendesk ticket types, or Stripe payment references into its core logic is not reusable. When the client changes their CRM, the Playbook must be rewritten from scratch. Playbooks reference connector types and field mapping configurations — not vendor-specific implementations.

### 12.6 Hidden Business Rules

Decision rules that exist in Agent prompts, in application code, or in undocumented configuration — rather than in the Playbook's Decision Rules section — are hidden. They cannot be reviewed by the Playbook Owner, audited by the Compliance Officer, or updated by the Operations team. Hidden business rules are a governance and operational risk.

All business logic governing a Playbook's behaviour must be visible in the Playbook specification. No hidden rules.

### 12.7 Duplicate Playbooks

Two Playbooks that serve the same business purpose — created independently by different teams or for different clients — create maintenance debt. When the process improves, both must be updated separately. When they diverge, inconsistent client experience results.

Use Playbook Inheritance. Define the Base Playbook once. Create Client-Specific Playbooks as inheriting children. Eliminate duplication at the root.

### 12.8 Playbooks Without Owners

A Playbook without a defined, active Owner is an unmanaged operation. No one reviews its performance. No one approves changes. No one is accountable when it underperforms or violates a policy. Unowned Playbooks are operationally dangerous.

Every Playbook has an Owner. If an Owner leaves the organisation or transfers responsibility, ownership is formally transferred — it is not left vacant.

### 12.9 Unmeasured Playbooks

A Playbook that executes without tracked KPIs is running blind. If no one knows whether the Playbook is achieving its business objective, no one knows whether the operation is performing. Unmeasured Playbooks cannot improve. They cannot be compared. They cannot be justified commercially.

Every Active Playbook has at least three measured KPIs with targets. If the target cannot be defined, the Playbook's business objective is not clear enough.

### 12.10 Playbooks That Cannot Escalate

A Playbook designed to handle everything autonomously — with no escalation path for low confidence, policy edge cases, or high-stakes exceptions — will eventually handle something it should not. The absence of escalation rules is not a sign of AI capability; it is a sign of insufficient governance.

Every Playbook has at least one escalation path. At minimum: if confidence falls below threshold at any point, the Playbook escalates with full context. This is non-negotiable.

---

## 13. Immutable Principles

These principles are the constitutional foundation of the DreamTeam Playbook Framework. They apply to every Playbook, every Digital Employee, every Workforce Team, and every client delivery model. Any proposed design, feature, or shortcut that violates a principle requires explicit architectural review and amendment of this document.

---

**Principle 1: Business operations are governed through Playbooks.**
Every consequential operation executed by a Digital Employee is defined, governed, measured, and continuously improved through an Operational Playbook. Ungoverned operations — where AI acts without a Playbook — do not exist in the DreamTeam model.

**Principle 2: Customers interact with Digital Employees — not AI Agents.**
The Agent Ensemble, the Workforce Engine, and the model providers are invisible to customers and clients. What is visible is the Digital Employee's output, governed by its Playbook. The sophistication is the platform's problem, not the customer's.

**Principle 3: Playbooks are authored by operations professionals — not engineers.**
The Playbook's business logic, decision rules, approval gates, and quality standards are defined by people who understand the operation — not by developers. Engineers configure the technical execution; operations professionals define what the execution must achieve.

**Principle 4: The Compliance Agent has veto authority.**
No Playbook execution proceeds past a compliance flag. Policy enforcement is not advisory — it is structural. The Compliance Agent's assessment stops execution regardless of what other Agents have concluded.

**Principle 5: Every approval point is designed in — not added after.**
Approval requirements are defined during Playbook authoring based on the reversibility and risk of the operations involved. They are never retrofitted. An operation that needs an approval gate gets one before it goes live.

**Principle 6: The Audit Agent is always running.**
Every Playbook execution generates an immutable audit record. Audit cannot be disabled, bypassed, or selectively applied. If an operation cannot be audited, it cannot be executed through DreamTeam.

**Principle 7: Playbook Inheritance eliminates duplication.**
Base Playbooks encode the operational IP. Client-Specific Playbooks inherit and configure. No business logic is duplicated across clients. When the core process improves, the improvement propagates through the inheritance hierarchy.

**Principle 8: Escalation is a designed behaviour — not a failure.**
Every Playbook has escalation paths. A Digital Employee that escalates when it should is more trustworthy than one that never escalates. Escalation readiness is a quality indicator, not a deficiency.

**Principle 9: Operational excellence takes precedence over AI novelty.**
The objective of every Playbook is a business outcome — a resolved case, a qualified lead, a reconciled account. The AI is the means; the business outcome is the purpose. No feature, agent type, or model capability is adopted unless it measurably improves the business outcome.

**Principle 10: Playbooks are platform assets — designed for reuse from the start.**
Every Playbook Outsourcetel authors is authored to the standard that would make it a Marketplace asset. This is not a future migration exercise. It is the standard that applies to every Playbook from the first day of authoring.

**Principle 11: Business outcomes always take precedence over technical implementation.**
How a Playbook is executed is secondary to what it achieves. If a simpler Agent Ensemble achieves the same business outcome at lower cost, use the simpler ensemble. If a different model achieves better accuracy for this specific Playbook, use that model. Optimise for the outcome.

**Principle 12: A Playbook is never finished — it is always improving.**
The Active and Continuously Improved lifecycle states are not end states — they are an ongoing cycle. Every Playbook has an open performance loop. When performance targets are met, new targets are set. The Digital Workforce improves because its Playbooks improve.

---

*End of Document — DreamTeam AI Digital Workforce Playbook Framework v1.0*

*This document defines the operational DNA of DreamTeam. The Playbook Framework is the mechanism by which business expertise becomes executable, governed, measurable, and continuously improving. Every Playbook authored under this framework contributes to DreamTeam's primary long-term competitive advantage: a library of proven, reusable, enterprise-grade operational Playbooks that represent decades of accumulated delivery excellence.*
