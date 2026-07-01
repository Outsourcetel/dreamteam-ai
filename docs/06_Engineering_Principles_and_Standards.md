# 06 — Engineering Principles and Standards

**DreamTeam Digital Workforce Platform**
Version 1.0 | Engineering Constitution

---

## Purpose of This Document

This is the engineering constitution of DreamTeam.

Every engineer — human or AI — must follow it. Every pull request, every architectural decision, every system design, and every feature implementation must be evaluated against these principles.

This document does not define language syntax, framework-specific patterns, or library choices. It defines permanent engineering principles that must remain valid even if DreamTeam changes its programming language, its cloud provider, its AI models, its database, or its orchestration engine.

These principles are written for a platform intended to support thousands of organisations, millions of users, millions of Digital Employees, and billions of workflow executions across multiple cloud providers and regulated industries. Every principle must be defensible at that scale.

If an engineering decision feels right but conflicts with a principle in this document, the principle wins. The principle may be challenged and revised — but through deliberate architectural review, not by quietly ignoring it.

---

## References

This document builds on and must not contradict:
- `01_Project_Handoff.md` — project vision and business context
- `02_Product_Charter.md` — product pillars and terminology rules
- `03_Product_Requirements_Document.md` — requirements and roadmap
- `04_Architecture.md` — 10-layer architectural model
- `05_Core_Domain_Model.md` — permanent domain vocabulary (the DreamTeam dictionary)

The Core Domain Model is the contract. If code uses different names than the domain model, the code is wrong — not the domain model.

---

# 1. Engineering Philosophy

## 1.1 Build Platforms, Not Features

A feature solves a problem. A platform creates the conditions in which problems can be solved — repeatedly, by many people, across many contexts, without the original engineers being present.

Every engineering decision at DreamTeam should ask: "Are we building a platform capability or hacking in a feature?" The distinction matters. A feature built on an unprincipled foundation accumulates as technical debt. A platform capability built on principled foundations compounds as leverage.

This means accepting short-term inconvenience for long-term composability. A clean service boundary is harder to build than a shortcut. Build the boundary.

## 1.2 The Domain Model Is the Source of Truth

The Core Domain Model defines the permanent vocabulary of DreamTeam. Code should express the domain. The names in code — functions, classes, tables, APIs, events — should match the domain model's names, not abstract them away.

When code diverges from the domain model, the platform becomes harder to reason about. New engineers must learn two vocabularies — the domain and the code. This is a compounding cost.

Rule: if `05_Core_Domain_Model.md` calls something a "Capability," the code calls it a capability. Not a `skill`, not a `task`, not a `feature`, not an `action`. Capability.

## 1.3 Business Outcomes Drive Engineering Priorities

Technical elegance is not the goal. Business outcomes are the goal. Engineering must continuously ask: "Does this decision help organisations achieve better business outcomes through their Digital Workforce?"

This does not mean taking shortcuts. Poor engineering produces poor platforms which produce poor outcomes. It means the compass is always pointed at business value — and technical decisions are evaluated by how well they serve that compass.

## 1.4 Explicit Over Implicit

Implicit behaviour is invisible behaviour. When a system does something because of a convention, a default, or an inherited setting, that behaviour is harder to debug, audit, and change than explicit behaviour.

DreamTeam is a governance platform. Implicit behaviour in a governance platform is a liability. Make permissions explicit. Make routing explicit. Make configuration explicit. Make failures explicit. If something matters, name it.

## 1.5 Configuration Over Hardcoding

Every value that a reasonable operator or organisation would want to change over time should be configurable — not hardcoded. This applies to confidence thresholds, approval rules, model routing, escalation triggers, knowledge scopes, and capability permissions.

Hardcoding is a bet that a decision will never need to change. That bet is almost always wrong for a platform designed to serve diverse organisations across multiple industries for many years.

## 1.6 Composition Over Duplication

Two pieces of code that do the same thing are one piece of code that needs to be changed twice when requirements change. The second change is often missed.

Prefer composition: small, well-defined units that combine cleanly. Avoid duplication: the same logic expressed in multiple places because composition felt like extra work at the time.

## 1.7 Simplicity Over Cleverness

Clever code is an engineering liability. It demonstrates that the author understood the problem but prioritised their own satisfaction over their colleagues' ability to maintain the system. The harder code is to understand, the more likely it is to be broken by a future change that didn't account for the cleverness.

Simple code is not naive code. It is code that expresses its intent clearly, fails visibly when it fails, and can be understood by any engineer on the team within a reasonable reading time.

## 1.8 Optimise for Change

Requirements change. Business understanding evolves. AI capabilities improve. Regulatory environments shift. The platform will be extended by people who have not read every original design document.

The measure of good architecture is not how well it solves today's problem — it is how cheaply it can be changed to solve tomorrow's problem. Design for change. Every tight coupling is a cost paid when change arrives.

## 1.9 Fail Loudly and Recover Gracefully

Silent failures are the most dangerous failures. A system that swallows an error and continues running as though everything is fine will produce corrupt state, mislead operators, and be nearly impossible to debug.

Fail loudly: surface errors visibly, log them richly, alert on them immediately. Recover gracefully: where recovery is possible, do it through well-defined paths that themselves are auditable and observable.

For an AI platform executing consequential business actions, silent failures are not a performance inconvenience — they are a governance failure.

## 1.10 Security Is Designed In, Not Added Later

Security added to a system after it is built is security bolted onto something that wasn't designed to be secure. It has gaps, inconsistencies, and exceptions. It is expensive to retrofit.

Security designed in from the beginning is simpler, cheaper, and more complete. Tenant isolation, least privilege, audit logging, approval gates, and secrets management are not features to add post-launch — they are load-bearing walls.

---

# 2. Architecture Principles

## 2.1 The Domain Model Is the Architectural Boundary

Service boundaries must align with domain concept boundaries defined in `05_Core_Domain_Model.md`. The Capability service handles Capabilities. The Knowledge service handles Knowledge. The Control Fabric service handles permissions and policy enforcement. No service should own concepts from another service's domain.

When service boundaries are unclear, the answer is in the domain model — not in a performance optimisation or a database schema.

## 2.2 Business Logic Must Never Depend on Infrastructure

Business logic is the rules that make DreamTeam what it is: capability execution rules, approval routing logic, confidence threshold behaviour, escalation conditions. Infrastructure is the mechanism that stores, transmits, and computes: Supabase, Vercel, Edge Functions, pgvector.

Business logic must be expressible independently of any specific infrastructure. If removing Supabase would require rewriting business logic, the architecture has failed. Infrastructure should be replaceable without changing what the platform does — only how it does it.

## 2.3 The Control Fabric Is Not Optional

Every action a Digital Employee proposes must pass through the Control Fabric before execution. There must be no code paths that bypass Control Fabric evaluation. No emergency override. No "fast path" that skips policy checks. No internal-only mode that disables permission evaluation.

The Control Fabric is a safety invariant, not a feature. Safety invariants must be enforced at multiple layers — not because we don't trust a single layer, but because defence in depth is what makes safety invariants meaningful.

## 2.4 The Intelligence Service Is the Only AI Gateway

No component in the platform except the Intelligence Service may make a direct call to a Model Provider. Agents call the Intelligence Service. The Workforce Engine calls the Intelligence Service. Nothing else does.

This is what makes the platform provider-agnostic. The moment business logic calls Anthropic directly, or references a specific model by name, the platform acquires a dependency on that provider. Intelligence Service is the abstraction that prevents this.

## 2.5 The Workforce Engine Coordinates, Not Owns

The Workforce Engine coordinates Agents to execute Capabilities. It does not own the business logic of those Capabilities. It does not make business decisions. It does not know what a Capability means to the business — it knows how to orchestrate the steps that fulfil one.

Business logic lives in Capability definitions, Knowledge, and Policy — not in orchestration code. When the Workforce Engine starts making business decisions, the platform becomes fragile: changes to business rules require changes to orchestration code.

## 2.6 Tenant Isolation Is Absolute

No code, query, or data path may ever produce cross-tenant data access. This is not a permission check — it is a structural guarantee enforced at the data, service, and API layers simultaneously.

Every database query is tenant-scoped. Every API call validates tenant context. Every service boundary checks tenant identity. One layer failing must not be sufficient for cross-tenant access to succeed.

This is not paranoia — it is the foundation of enterprise trust. A single cross-tenant data leak invalidates the trust of every customer on the platform.

## 2.7 Audit Trail Is Cross-Cutting Infrastructure

The Audit Trail is not a feature of any service. It is infrastructure that every service writes to. Every consequential event — Capability execution, Approval decision, Policy trigger, Handoff, Escalation, permission denial — emits an Audit Trail entry.

No service may decide not to log something because it seems unimportant. The Audit Trail is a compliance guarantee. Its completeness is not subject to the judgment of individual service authors.

## 2.8 Infrastructure Is a Plugin, Not a Foundation

The platform's relationship with its infrastructure should be: the platform uses infrastructure, it does not depend on it. Supabase is a plugin for persistence. Vercel is a plugin for compute delivery. pgvector is a plugin for vector similarity. Anthropic is a plugin for language model inference.

When infrastructure is treated as a foundation rather than a plugin, migrating away from it costs months of engineering time. When it is treated as a plugin with clean interfaces, migration is a matter of writing a new plugin.

## 2.9 Domain Events Are the Integration Mechanism

Services should not call each other synchronously for things that do not require an immediate response. Instead, they should emit domain Events that other services may subscribe to.

This reduces coupling, improves resilience, enables replay for debugging, and produces the event stream that powers the Audit Trail, Insight Engine, and analytics. Event-driven integration is composable; direct coupling is not.

## 2.10 No Shared Mutable State Between Services

Services share state through well-defined interfaces: APIs, events, and documented data contracts. Services must never read directly from each other's internal data stores, even if those stores are physically accessible.

Shared mutable state between services makes change impossible to isolate. A change to one service's internal data structure silently breaks another service that was reading from it.

---

# 3. Digital Workforce Engineering Standards

## 3.1 Digital Employees Are Configured, Not Coded

A Digital Employee's identity, Responsibilities, Capabilities, permissions, and behaviour must be derived entirely from configuration data — not from code. There should be no file in the codebase that says "Alex the Support Specialist does X." There should be a data record that says "this Digital Employee instance has these Responsibilities, these Capabilities, and this Control Fabric configuration."

This is what allows customers to hire, configure, and modify Digital Employees without an engineering deploy. If a customer changing their DE's name requires a code change, the architecture has failed.

## 3.2 Every Digital Employee Must Have a Complete Configuration Schema

At minimum, every Digital Employee instance must have:
- **Identity** — unique ID, display name, persona description, assigned Workforce Role
- **Responsibilities** — the sustained accountability domains it holds
- **Capabilities** — the discrete executable outcomes it may fulfil
- **Knowledge Scope** — which Knowledge Collections it may read, and at what trust level (Trusted / Restricted / No Access)
- **Connector Permissions** — which Connectors it may access, and at what permission level (read / read-write)
- **Action Rules** — which Actions are allowed, which require Approval, which are blocked
- **Confidence Profile** — the confidence threshold below which it escalates
- **Escalation Path** — where escalations are routed
- **Owner** — the human User or Department responsible for this DE
- **Version** — the configuration version, with full history
- **Lifecycle State** — draft, active, paused, retired
- **Audit Configuration** — which of its actions require explicit audit entries
- **Metrics Targets** — business outcome metrics this DE is measured against

## 3.3 Digital Employee Personas Are Stable Across Model Changes

When the Intelligence Service switches the underlying Model Provider or model version for a Digital Employee, the DE's behaviour should change as little as possible from the customer's perspective. The persona — name, tone, communication style — is a configuration asset, not a model property.

Testing must verify that model upgrades do not degrade DE persona consistency. This is an explicit quality gate before any model change is deployed.

## 3.4 Digital Employees Do Not Contain Tenant-Specific Logic

A Digital Employee type (e.g. Support Specialist) must contain no logic specific to any individual tenant's business. Tenant-specific behaviour is expressed entirely through configuration: their Knowledge Collections, their Action Rules, their Connector Permissions, their Policies. The DE type is generic; the configuration makes it specific.

This is what allows a single DE codebase to serve thousands of different tenant configurations without becoming unmaintainable.

---

# 4. Workforce Engine Standards

## 4.1 The Engine Is Stateless; State Lives in Explicit Storage

The Workforce Engine should be stateless at the process level. Any state required across execution steps must be written to an explicit, durable, observable storage mechanism — not held in memory between function calls.

Process-level state is invisible (cannot be inspected without accessing the process), fragile (lost on restart or failure), and non-scalable (tied to one process instance). Explicit storage is observable, durable, and distributable.

## 4.2 Execution Plans Are Explicit and Auditable

Before the Workforce Engine begins executing a Capability, it must produce an Execution Plan — a structured, logged record of the steps it intends to take. This plan is written to observable storage before any step executes.

This principle enables: pre-execution Policy review (checking the plan before any action), mid-execution debugging (what did the engine intend to do?), and post-execution auditing (what did the engine plan vs what actually happened).

## 4.3 Every Execution Step Is Retryable and Idempotent

Steps in a Capability execution must be designed to be safely retried without producing duplicate effects. If a step fails and is retried, the end state must be identical to a single successful execution.

Non-idempotent operations — those that cannot be safely retried — must be protected by explicit idempotency keys and deduplication mechanisms. This is especially critical for operations with external side effects (sending emails, updating CRM records, issuing refunds).

## 4.4 The Engine Must Support Durable Long-Running Workflows

The current implementation may execute Capabilities as synchronous function calls. That is appropriate for simple, fast Capabilities. It is insufficient for Workflows that span hours, days, or require human Approval steps that may take minutes or hours to complete.

The Workforce Engine must be designed from the outset with the assumption that it will eventually be backed by a durable workflow execution engine (Temporal, AWS Step Functions, Cloudflare Durable Objects, or equivalent). This means:
- No assumption that execution completes within a single function invocation
- State checkpointing at every significant step
- Human-in-the-loop pause/resume as a first-class capability
- Timer and scheduled resumption support
- Compensation logic for partial failures (what to undo if step 5 of 7 fails)

This migration is the highest-risk architectural transition in the platform's scaling journey. Not anticipating it now means rewriting the core engine under production load.

## 4.5 The Engine Never Makes Business Decisions

Routing decisions belong to Capability definitions and Policies. Business rules belong to the Control Fabric. The Workforce Engine executes plans according to rules it has been given — it does not author those rules.

If the Workforce Engine contains an `if` statement that says "for Finance Capabilities, do X," that is a business rule embedded in an orchestration engine. Business rules embedded in orchestration engines are invisible to governance, untestable by business teams, and impossible to configure by customers.

## 4.6 Partial Failures Must Produce Deterministic State

When a multi-step Capability execution fails partway through, the system must be able to determine exactly which steps completed and which did not. Ambiguous partial failure state is the most dangerous state a system can be in — it may have taken consequential actions that cannot be reliably audited or compensated.

Every execution step must atomically record its completion before proceeding to the next step. "Did we actually send that email or just try to?" must always have a definitive answer.

## 4.7 Approval Gates Are First-Class Execution States

An Approval gate is not an error condition, an exception handler, or a special case. It is a first-class execution state: the Workforce Engine paused, waiting for human decision, which will be delivered as an Event and resume execution.

This means Approval waiting state must be durable (survives restarts), observable (operators can see what is waiting and why), and timeable (can expire if no decision is made within a configured window, with defined behaviour for expiration).

---

# 5. AI Engineering Principles

## 5.1 AI Models Are Infrastructure, Not Identity

The platform's value is not in which AI models it uses. It is in the Digital Workforce layer, the Control Fabric, the Knowledge Platform, and the domain model built on top of those models. Models are the electricity that powers the platform — not the platform itself.

This means: no customer-facing marketing about specific model providers or versions. No business logic that references a specific model's capabilities or limitations. No configuration that cannot be changed to point at a different model without code changes.

## 5.2 Prompts Are Versioned, Tested, Reviewed Software Assets

A prompt is not a string that gets pasted into a function call. A prompt is a software asset that:
- Lives in version-controlled storage (not in source code strings)
- Has a version identifier
- Is tested against expected outputs before deployment
- Is reviewed by domain experts before production use
- Can be rolled back to a previous version independently of code
- Emits telemetry on usage and performance
- Is owned by a specific team or person responsible for its quality

Treating prompts as implementation details that any engineer can change at will is how AI platform quality degrades invisibly over time.

## 5.3 Prompt Architecture Is Layered

Prompts have structural layers that must be managed separately:
- **System/Persona Layer** — defines who the Digital Employee is; changes infrequently; owned by product/DE team
- **Policy Layer** — defines what the DE may and may not do; driven by Control Fabric configuration; changes per tenant configuration
- **Knowledge Layer** — dynamically assembled from Knowledge Collections at runtime; not authored directly
- **Conversation Layer** — dynamically assembled from conversation history and context; not authored
- **Task Layer** — the specific instruction for a given Capability execution; derived from Capability definition

These layers must be assembled by the Intelligence Service from their respective sources. They must never be hand-assembled inline in business logic code.

## 5.4 Every AI Response Must Be Validated

AI models produce probabilistic outputs. An output that looks correct may be structurally invalid, confidently wrong, or policy-violating. Every AI response must pass through validation before it is acted upon:
- **Structural validation** — does the response match the expected schema?
- **Content validation** — does the response comply with content policies?
- **Confidence scoring** — what is the model's stated or inferred confidence?
- **Policy validation** — does the proposed action comply with the Control Fabric's rules?

Validation failures must never be silent. They must escalate, log, and produce an Audit Trail entry.

## 5.5 Confidence Is a First-Class Engineering Concern

Every AI-generated output must have an associated confidence score. Confidence scoring is not a nice-to-have — it is what allows the platform to behave differently for high-confidence vs low-confidence outputs.

Low confidence → Approval queue or Escalation. Medium confidence → Auto-approve with audit flag. High confidence → Auto-approve.

The thresholds for these bands are configurable per-tenant, per-Digital-Employee, and per-Capability via the Control Fabric. The engineering responsibility is to produce reliable confidence signals and route them correctly — not to decide what the thresholds should be.

## 5.6 AI Reasoning Must Be Explainable When Consequential

For Capabilities with medium or high risk levels, the AI's reasoning must be captured and stored alongside its output. "What did the DE consider before proposing this action?" must be answerable for any Approval, Escalation, or consequential Action.

This is both a governance requirement and a trust-building mechanism. Organisations are more willing to delegate to a Digital Workforce when they can inspect its reasoning.

## 5.7 AI-Specific Security Is a Distinct Engineering Discipline

Standard application security does not cover AI-specific attack surfaces. The platform must explicitly defend against:
- **Prompt injection** — user-supplied content attempting to override system instructions or exfiltrate data
- **Context poisoning** — malicious content in Knowledge Collections or Connector data designed to influence AI outputs
- **Data extraction** — attempts to use the AI to reveal content from other customer sessions or tenants
- **Jailbreaking** — attempts to bypass the DE's Policy Layer and Control Fabric rules through conversational manipulation
- **Model inversion** — attempts to infer training data or system prompts from model outputs

These are not theoretical risks. They are documented attack patterns against production AI systems. Defences must be implemented, tested, and monitored.

## 5.8 Model Routing Is Configurable and Observable

The Intelligence Service must support routing different Capabilities to different models based on configurable criteria: capability type, risk level, cost constraints, tenant preference, model availability. This routing must be:
- Configured via the Control Fabric (not hardcoded)
- Observable (every model call logs which model was used)
- Testable (routing rules can be verified without executing live model calls)
- Fallback-aware (model unavailability triggers the configured fallback, not an unhandled error)

## 5.9 Token Usage Is Metered and Attributable

Every model call must record token usage attributed to: tenant, Digital Employee, Capability, and Conversation. This enables cost allocation, budget enforcement, usage analytics, and billing. Token usage that cannot be attributed is a platform cost with no recovery path.

## 5.10 Non-Determinism Is Explicitly Acknowledged and Managed

AI models are non-deterministic. The same input may produce different outputs. Engineering must account for this:
- Tests of AI-integrated behaviour use semantic assertions (does the output achieve the goal?) not exact string matching
- Critical decision paths have deterministic fallbacks when AI confidence is insufficient
- Non-determinism is acknowledged in the performance contract (exact output reproducibility is not guaranteed; business outcome achievement is)

---

# 6. Knowledge Engineering Principles

## 6.1 Knowledge Is an Enterprise Asset, Not a Platform Configuration

The Knowledge Collections that make Digital Employees competent belong to the Organisation. They are the Organisation's intellectual property, built over years of experience. The platform's job is to make that knowledge useful to the Digital Workforce — not to own it.

Engineering must ensure that Knowledge is:
- Exportable in full by the Organisation at any time
- Retained in the Organisation's data residency region if required
- Not used to train or improve models on behalf of other tenants
- Removed completely and verifiably if the Organisation terminates their subscription

## 6.2 Knowledge Ingestion Is a Governed Process, Not a File Upload

Ingesting Knowledge is not the same as uploading a file. Ingestion is a process with quality gates:
- **Validation** — is the content structurally processable?
- **Classification** — what type, audience, and domain does this content belong to?
- **Deduplication** — does this conflict with or supersede existing content?
- **Review gate** — is a human review required before this content becomes active? (configurable per tenant)
- **Indexing** — the content is processed and made retrievable
- **Activation** — the content enters the active Knowledge Collection
- **Audit** — the ingestion event is logged with source, author, and timestamp

Fast ingestion that skips these gates is a short-term convenience that creates long-term quality debt and potential compliance liability.

## 6.3 Knowledge Must Be Versioned

Every Knowledge Item must have a version history. When an article is updated, the previous version is retained. This enables:
- Rollback when an update introduces errors
- Audit of what information was available at a specific point in time (critical for compliance investigations)
- A/B testing of different versions
- Citation of specific versions in outputs

## 6.4 Knowledge Has a Freshness Contract

Every Knowledge Item has a freshness state. Items that have not been reviewed within a configurable window are automatically marked stale. Stale content is still retrievable but flagged with reduced confidence.

The platform must surface Knowledge gaps and stale content proactively — not wait for a Digital Employee to give a wrong answer based on outdated information.

## 6.5 Citations Are Non-Negotiable

Every AI output that draws on Knowledge must include citations — references to the specific Knowledge Items used to produce the output. Citations must be:
- Specific enough to be verifiable (article title, version, section)
- Surfaced to end users when appropriate to their permission level
- Stored with the Conversation record
- Used to track which Knowledge Items are most valuable (influence Insight generation)

An AI that gives answers without revealing its sources is unauditable. Citations are what transform a chatbot into a trustworthy professional tool.

## 6.6 Knowledge Is Provider-Independent

Knowledge must be stored in a format that is not dependent on any specific AI model's tokenization, embedding architecture, or inference requirements. When the embedding model changes, Knowledge is re-indexed — the underlying content remains unchanged.

This is the Knowledge equivalent of the Intelligence Service abstraction: the content is independent of the computational substrate that makes it searchable.

## 6.7 Knowledge Scope Enforcement Is a Control Fabric Concern

Which Knowledge Collections a Digital Employee may access is a Control Fabric configuration, not a Knowledge Platform implementation. The Knowledge Platform makes knowledge retrievable. The Control Fabric decides who may retrieve what.

These responsibilities must not bleed into each other. A Knowledge Platform that enforces DE-level permissions has coupled retrieval with access control — making both harder to change independently.

---

# 7. Control Fabric Principles

## 7.1 No Action Escapes the Control Fabric

Every Action proposed by a Digital Employee must pass through the Control Fabric before execution. There is no internal mode, no debug mode, no emergency bypass, and no implicit default that allows an Action to bypass Control Fabric evaluation.

The Control Fabric is not an access control list that runs sometimes. It is the governance layer that runs always. Its completeness is an architectural invariant.

## 7.2 Customers Own Their Control Configuration

The Control Fabric is configured by the Organisation's administrators. DreamTeam provides defaults, templates, and recommendations. The Organisation decides. No DreamTeam platform update may silently change a customer's Control Fabric configuration.

When a platform update would change the behaviour of a Control Fabric rule, customers must be notified in advance, given a migration path, and given the ability to opt out of the change.

## 7.3 Every Control Decision Is Logged

Allow, deny, and approval-required decisions are all logged to the Audit Trail. There are no silent passes or silent blocks. This completeness is what makes the Control Fabric a governance tool rather than just a permission system.

## 7.4 Action Rules Are Additive, Block Wins

When multiple rules apply to the same Action (e.g. a Capability-level rule and a Workspace-level rule), the most restrictive rule applies. Block overrides Approval Required. Approval Required overrides Allow.

This additive model ensures that adding a new rule can only make things more restrictive — never accidentally more permissive. Permissive exceptions require explicit positive configuration, not the absence of a restrictive rule.

## 7.5 The Control Fabric Is Auditable Without Execution

An Organisation's administrator should be able to ask "what would happen if DE Alex tried to issue a refund of $150 right now?" and get a definitive answer from the Control Fabric without actually executing that action. This simulation capability is essential for compliance verification, configuration auditing, and onboarding new Digital Employees safely.

## 7.6 Trust Boundaries Must Be Explicit

Every component in the platform knows exactly which other components it trusts and to what extent. There is no implicit trust granted by proximity (two services deployed in the same environment do not automatically trust each other). Trust is configured, enforced, and auditable.

---

# 8. Data Engineering Principles

## 8.1 The Domain Model Is the Schema Contract

Database schemas are derived from the domain model — not the other way around. A table should represent a domain concept (Capability, Digital Employee, Conversation). The table's columns represent the concept's attributes. If the domain model doesn't have a concept for something, neither should the database.

When schemas drift from the domain model, the platform develops a hidden translation layer that every engineer must understand to modify anything. This layer grows invisibly until it is the dominant cost of every engineering task.

## 8.2 Migrations Are Forward-Only

Database schema migrations are never rolled back by reverting the migration file. If a migration produces an error, a new migration is written to correct it. This keeps the migration history as a complete, honest record of how the schema evolved.

Every migration must be:
- Reversible in the sense that data can be restored from backup if necessary
- Safe to run against production data (tested on a copy of production schema before deploy)
- Accompanied by a rollback strategy documented in the migration file
- Non-destructive by default (columns are deprecated before being dropped; data is migrated before columns are removed)

## 8.3 Tenant Data Is Explicitly Scoped at Every Layer

Every table that contains tenant-specific data has a `tenant_id` column. Every query against that table includes a `tenant_id` filter. This is not something that can be handled "at the application layer" and trusted — it must be enforced at the data layer with row-level security policies.

Testing must include explicit verification that a query with one `tenant_id` cannot return data belonging to a different `tenant_id`. This test class is a safety invariant, not optional coverage.

## 8.4 Data Ownership Is Explicit in the Schema

Every significant data entity records who created it, who last modified it, and when. This is not just for auditing — it is for governance. An Organisation should always be able to answer "who put this here?" for any significant piece of data.

## 8.5 Immutable Records Remain Immutable

Audit Trail entries, completed Events, and Approval decisions are immutable. No code path may UPDATE or DELETE these records. If the data model allows mutation of these records, the schema is wrong. Immutability for these record types should be enforced at the database layer if the platform supports it.

## 8.6 Design for Data Portability

The Organisation's data — Knowledge, Conversations, Workflow history, Digital Employee configurations, Audit Trail — must be exportable in standard, documented formats. This is both a customer expectation and, in many jurisdictions, a legal requirement.

Engineering must design data models with the assumption that data export will be required. Formats that are exportable should be preferred over proprietary encodings. Storage choices that allow bulk export without custom tooling should be preferred.

---

# 9. API Design Principles

## 9.1 APIs Are Contracts, Not Conveniences

A public API is a commitment. Once published, an API endpoint, its request schema, its response schema, and its behaviour are committed to stability for the lifetime of the API version. Customers build integrations against APIs. Breaking those integrations breaks customer trust.

Design APIs as though they will be read by a thousand engineers who have no ability to ask the original authors what was intended. Every field, every status code, every error message should be self-explanatory.

## 9.2 API Versioning Is Mandatory From Day One

Every public API must include a version. `/v1/capabilities` not `/capabilities`. Versioning retrofitted after launch is painful; versioning built in from the start is free.

When an API version is deprecated:
- A minimum 12-month deprecation notice is given
- The deprecated version continues to function for the full deprecation period
- Customers are actively assisted in migrating to the new version
- The deprecation date and timeline are documented publicly

## 9.3 APIs Express the Domain Model

API resources should correspond to domain concepts. A `GET /v1/digital-employees/{id}` endpoint returns a Digital Employee. The response schema's fields match the attributes defined in `05_Core_Domain_Model.md`.

APIs that invent new concepts — `GET /v1/agents/{id}` instead of Digital Employees, or `GET /v1/skills/{id}` instead of Capabilities — create a third vocabulary that engineers must translate to and from the domain model.

## 9.4 Internal APIs Are Not Public APIs

Internal service-to-service APIs do not have the same stability contract as public APIs. They may change with any deployment, with appropriate coordination between service owners. They must never be documented publicly or surfaced to customers.

The distinction between internal and public APIs must be explicit and enforced — not a matter of convention or shared understanding.

## 9.5 Errors Are Informative and Actionable

An API error response must tell the caller: what went wrong, why it went wrong, and — where possible — what to do about it. `{"error": "Internal Server Error"}` is not an acceptable error response. `{"error": "CONFIDENCE_BELOW_THRESHOLD", "capability_id": "cap_123", "confidence": 0.42, "threshold": 0.55, "suggested_action": "review_in_approval_queue"}` is.

---

# 10. Integration Standards

## 10.1 Every Connector Has a Standard Interface

Regardless of what external system a Connector connects to, every Connector presents the same interface to the platform. The platform asks Connectors to: authenticate, read data, write data, handle errors, and report health. The Connector hides the specifics of how the external system works behind that interface.

This is what prevents Salesforce-specific logic, Stripe-specific error codes, and Zendesk-specific pagination from appearing in business code.

## 10.2 No Vendor-Specific Logic Leaks into Business Code

If removing a Connector and replacing it with a different one that presents the same data would require changing business code, the Connector boundary has leaked. Business code should be able to ask "give me the customer's recent orders" and receive a standard response — regardless of whether that data came from Stripe, a custom database, or a CSV upload.

## 10.3 Authentication Is Abstracted

Connector authentication — OAuth tokens, API keys, webhooks, certificates — is managed within the Connector layer and never exposed to business code. Business code asks a Connector to retrieve data; it does not handle OAuth token refresh, API key rotation, or credential storage.

Credentials for Connectors are stored in secrets management infrastructure, not in the database or environment variables accessible to application code.

## 10.4 Connectors Are Resilient by Default

External systems fail. Connectors must handle failure gracefully with:
- Retry logic with exponential backoff and jitter
- Circuit breakers to prevent cascading failures when an external system is degraded
- Timeout configuration (no request waits indefinitely)
- Health status reporting (the platform knows if a Connector is degraded before customers are affected)

## 10.5 Data Mapping Is Explicit and Versioned

The mapping between an external system's data model and DreamTeam's domain model is an explicit, versioned, tested configuration — not implicit logic hidden in application code. When Salesforce changes a field name, updating the mapping in one place is sufficient.

---

# 11. Security Principles

## 11.1 Zero Trust — Every Request Is Authenticated

No request from any component is implicitly trusted. Service-to-service calls carry cryptographically verifiable identity tokens. Tokens are validated on every request, not cached or assumed valid.

This applies even to internal services on the same network. Adjacency is not trust.

## 11.2 Least Privilege Is the Default

Every component — user, Digital Employee, Agent, service, integration — starts with the minimum permissions required to perform its function. Additional permissions are explicitly granted and logged. Permissions are never granted "just in case."

A Digital Employee that needs to read customer orders does not receive permission to read customer financial records. A service that sends notifications does not receive permission to modify records.

## 11.3 Secrets Are Never in Code or Configuration Files

API keys, database credentials, OAuth secrets, and encryption keys are never committed to version control, never stored in environment variable files that are checked in, and never logged in any log output.

Secrets are stored in a dedicated secrets management service (Supabase secrets, AWS Secrets Manager, or equivalent). They are accessed at runtime and rotated on a defined schedule.

A secret that appears in a log file or a Git commit is treated as compromised and rotated immediately.

## 11.4 All Data at Rest Is Encrypted

Customer data — Knowledge, Conversations, Workflow records, Digital Employee configurations, Audit Trail entries — is encrypted at rest. Encryption keys are tenant-specific where feasible and are rotated on a defined schedule.

## 11.5 All Data in Transit Is Encrypted

All network communication — between clients and servers, and between services — uses TLS 1.2 or higher. No plaintext communication is acceptable for any data that may contain customer information.

## 11.6 Input Is Validated at Every Boundary

User input, Connector data, AI model outputs, and inter-service messages are all validated at the boundary where they enter the system. Input validation at the boundary is the first line of defence against injection attacks, data corruption, and malformed payloads.

Validation is not a single layer. A payload validated at the API gateway should be re-validated when it crosses service boundaries, because its structure may have been transformed.

## 11.7 AI-Specific Attack Surfaces Are Explicitly Defended

**Prompt injection:** User-supplied content is structurally separated from system instructions. Content from users, Connectors, and Knowledge Collections is treated as data — never executed as instruction. The Intelligence Service applies injection detection before including external content in a model context.

**Context poisoning:** Knowledge Collections and Connector data are validated on ingestion for patterns designed to manipulate model outputs. Content that appears designed to override system instructions is flagged and reviewed before activation.

**Cross-tenant data extraction:** The Context assembled for any Digital Employee execution is validated to contain only data permitted by the Control Fabric for that tenant and Digital Employee. No data from another tenant may appear in any assembled context.

**Jailbreaking:** The Policy Layer of assembled prompts explicitly reinforces boundaries. Output content is validated post-generation for compliance violations.

## 11.8 Vulnerability Disclosure Response Is Defined

A responsible disclosure process must be documented and publicly accessible before the platform handles any production customer data. Engineers must know the response process for discovering a security vulnerability.

---

# 12. Observability Standards

Observability is not a feature — it is a platform property. A system that is not observable is a system that cannot be understood, debugged, or improved. For a platform executing consequential business actions on behalf of organisations, unobservability is a governance failure.

## 12.1 The Four Pillars: Events, Metrics, Traces, Logs

**Events** — structured records of significant state changes in the domain. Every Capability execution, Approval decision, Escalation, Handoff, and Policy trigger emits a domain event. Events are the raw material of the Audit Trail, Insight generation, and Workflow triggers.

**Metrics** — quantitative measurements of platform behaviour over time. Capability execution volume, latency distributions, confidence score distributions, escalation rates, error rates, token usage, approval queue depth. Metrics are aggregated and stored for trending and alerting.

**Traces** — end-to-end request traces that show the full path of a single execution, including which services were called, in what order, and with what latency. Traces are what allow an engineer to answer "why did this capability invocation take 4 seconds?" or "which step failed in this workflow?"

**Logs** — timestamped textual records of what individual processes did. Logs are the fallback when events, metrics, and traces don't give enough detail. Logs must be structured (JSON, not free text) to be reliably searchable.

## 12.2 Every Digital Employee Action Is Traceable End-to-End

Given a Conversation ID or a Capability invocation ID, it must be possible to reconstruct the complete execution history: which Agents were invoked, which Knowledge was retrieved, which Connectors were called, what the AI responded, what Actions were proposed, which were approved or blocked, and what the final output was.

This traceability is not only an engineering convenience — it is a customer promise and a compliance requirement.

## 12.3 Latency Targets Are Defined and Monitored

Every Capability type has a defined latency target. The monitoring system alerts when P99 latency for a Capability type exceeds its target. Latency targets are defined for:
- Interactive Capabilities (responds within a live Conversation) — target: under 3 seconds P95
- Background Capabilities (workflow-triggered, not user-facing) — target: under 30 seconds P95
- Long-running Capabilities (multi-step workflows, human approval gates) — target: completion within defined SLA

## 12.4 Platform Health Is Self-Reported

The platform must expose its own health status — not rely on external probing. Every service reports:
- Whether it is healthy
- Whether its dependencies (database, AI provider, connected services) are healthy
- Current load and queue depths
- Recent error rates

This self-reported health is what enables an operator to diagnose a degradation before customers report it.

## 12.5 Alerting Is Outcome-Based, Not Metric-Based

Alerts should fire when a business outcome is at risk — not when a metric crosses an arbitrary threshold. "Approval queue depth exceeds 50 items and no approver has been active in the last 30 minutes" is an outcome-based alert. "CPU usage above 80%" is a metric-based alert that may not correlate with any user impact.

Outcome-based alerts are harder to define but produce far fewer false positives and are far more actionable.

## 12.6 AI Decision Reasoning Is Captured for Consequential Actions

For Capabilities with medium or high risk levels, the Workforce Engine captures and stores the reasoning trace — the intermediate steps, retrieved Knowledge, and decision points — alongside the final output. This is stored, not just logged transiently.

This stored reasoning is what allows an Approver to make an informed decision, an audit investigator to reconstruct what the system considered, and an engineer to diagnose why a response was generated the way it was.

---

# 13. Configuration Principles

## 13.1 Configuration Is the Product

The ability for an Organisation to precisely configure their Digital Workforce — without code changes, without engineering involvement, without contacting DreamTeam support — is a core product value. Every configuration surface is a product surface.

This means configuration must be:
- Discoverable (what can be configured is visible in the UI and documented)
- Safe (invalid configuration is rejected with a clear explanation, not silently ignored)
- Versioned (configuration has a history; previous versions can be restored)
- Audited (who changed what configuration, when, is logged)
- Previewed (customers can validate configuration before it takes effect)

## 13.2 Configuration Is Layered

Configuration follows a precedence hierarchy:
1. **Platform defaults** — DreamTeam-defined sensible defaults for all tenants
2. **Tenant configuration** — Organisation-level overrides
3. **Workspace configuration** — workspace-specific overrides
4. **Capability configuration** — capability-specific overrides
5. **Digital Employee configuration** — DE-specific overrides

More specific configuration overrides less specific configuration. This hierarchy must be explicitly documented and enforced consistently.

## 13.3 Sensitive Configuration Requires Elevated Permission

Changing the confidence threshold for an auto-approval decision, modifying who can approve high-value financial actions, and adjusting data retention policies are sensitive configuration changes. They require elevated permission, produce Audit Trail entries, and may require a second approver.

The platform must enforce permission requirements on configuration changes with the same rigour it enforces permissions on Digital Employee actions.

## 13.4 Feature Flags Are Explicit, Documented, and Time-Limited

Feature flags that modify platform behaviour must be explicit (listed in a configuration manifest), documented (their effect is described), and time-limited (they have an intended removal date). Feature flags that exist to enable gradual rollout should not become permanent behaviour switches.

---

# 14. Testing Philosophy

## 14.1 Testing Strategy Is Architectural, Not Optional Coverage

For an AI platform where non-determinism, multi-tenant isolation, and consequential actions are first-class concerns, testing strategy is an architectural decision. The question is not "do we have tests?" but "what guarantees does our test suite provide, and are those guarantees sufficient for an enterprise platform?"

## 14.2 Test Classes and Their Guarantees

**Unit tests** — verify that individual components behave correctly in isolation. Fast to run; no external dependencies; test the logic, not the integration.

**Integration tests** — verify that components work correctly together. Slower to run; test against real dependencies (database, not mocks) where the integration is the thing being tested.

**Contract tests** — verify that service interfaces conform to their declared contracts. Run on every service boundary. Prevent the case where Service A changes its output schema and Service B silently breaks.

**Tenant isolation tests** — a dedicated test class that explicitly attempts cross-tenant data access and asserts that it fails. These tests are safety invariants and must be run on every deployment.

**AI behaviour tests** — test that AI-integrated Capabilities achieve their intended business outcome across a range of inputs. Use semantic assertion (does the output answer the question appropriately?) not exact string matching. Maintain a regression set of known-good input/output pairs.

**Chaos and resilience tests** — test that the system behaves correctly under failure conditions: database unavailability, AI provider errors, connector failures, network partitions. Resilience is not a feature — it is a property that must be continuously verified.

## 14.3 Non-Determinism Is Explicitly Handled

AI model outputs are non-deterministic. Tests of AI-integrated behaviour must account for this:
- Use semantic evaluation, not exact string matching
- Test over a sample of runs and assert that the correct outcome is achieved at an acceptable rate
- Maintain a fixed random seed for deterministic test runs in CI where possible
- Separately test deterministic components (routing, approval rules, Control Fabric logic) with traditional unit tests

## 14.4 The Production Environment Is the Ground Truth

Tests provide confidence that the system will behave correctly in production. They are not a substitute for observability in production. Tests that cannot be reproduced in a production-like environment are providing false confidence.

## 14.5 Regression Testing for Model Updates

Every update to a Model Provider configuration — new model version, changed model, adjusted parameters — must run against a regression suite before deployment. The regression suite contains representative Capability invocations with known acceptable output characteristics. A regression that fails blocks the model update.

---

# 15. Scalability Principles

## 15.1 Infrastructure Is a Plugin

The platform's relationship with Supabase, Vercel, pgvector, and the current Anthropic integration must be: the platform uses these as plugins, not as foundations. Business logic must not reference them directly. Data access, vector retrieval, and AI inference must go through abstraction layers that can be reimplemented without changing business code.

This is the most important scalability principle. Every other scalability strategy is easier or harder depending on how well this principle is maintained.

## 15.2 The Database Is Not the Integration Layer

Services communicate through Events and APIs — not through shared database tables. A service must not read another service's tables to get data it needs. It must request that data through the owning service's API or receive it through subscribed Events.

This principle is what allows services to be split across database instances as the platform scales. When two services share a database table as their communication channel, splitting them requires a rewrite.

## 15.3 Design for Horizontal Scale of Stateless Components

Compute components — API handlers, Agent execution, Intelligence Service calls — should be stateless and horizontally scalable. Adding more instances should increase capacity linearly without coordination overhead.

State that cannot be held stateless (Workflow execution state, Approval waiting state) must be held in durable, consistent storage — not in process memory.

## 15.4 Vector Search Must Remain Provider-Portable

The current implementation uses pgvector in Supabase. As Knowledge Collections grow to millions of items per tenant and thousands of tenants, dedicated vector databases (Pinecone, Weaviate, Qdrant, Milvus) may be required.

The Knowledge Platform's retrieval interface must abstract the vector search operation such that changing the underlying vector store requires implementing a new adapter — not modifying Knowledge retrieval logic throughout the codebase.

## 15.5 The Workforce Engine Must Support Durable Workflow Execution

As noted in Section 4, the Workforce Engine will eventually need to support Workflows that span hours, require human Approval steps, and execute thousands of concurrent instances per tenant. The current synchronous function-based execution cannot scale to this requirement.

The migration path to a durable workflow execution engine (Temporal, AWS Step Functions, or equivalent) must be anticipated in the architecture. Specifically:
- Workflow state must be stored externally from the execution process
- Execution steps must be idempotent
- Long-running Workflows must be able to survive process restarts
- The external interface to the Workflow Engine must remain stable across this migration

## 15.6 Multi-Region Is a Future Requirement, Not an Afterthought

Enterprise customers in regulated industries will require data residency guarantees — their data must not leave a specific geographic region. The platform's data architecture must support per-tenant data residency configuration.

This means: data must be attributed to a tenant's configured region from the moment it is created. Data that moves between regions (for analytics, backup, model training) must be explicitly governed. The abstraction between "where this request is processed" and "where this tenant's data is stored" must be explicit.

---

# 16. Performance Principles

## 16.1 Latency Is a Product Property

Slow responses degrade Digital Employee trustworthiness. An end customer waiting more than a few seconds for a response will lose confidence in the Digital Employee — regardless of the quality of the response when it arrives. Latency is not purely a technical concern — it is a product quality and customer trust issue.

## 16.2 Async-First for Non-Interactive Work

Work that does not need to complete within the scope of a user interaction should be async. Sending an email, updating a CRM record, running a background reconciliation, generating a report — these should be queued and executed asynchronously, with the user receiving a confirmation that work is in progress rather than waiting for it to complete.

## 16.3 Caching Is Explicit and Governed

Cached data that is used to make governance decisions (Control Fabric rules, Permission scopes) must have a defined maximum staleness. Serving a stale permission decision — allowing an action that was just blocked, or blocking an action that was just permitted — is a governance failure.

Caching is an explicit engineering decision documented with: what is cached, for how long, what invalidates the cache, and what the consequences of staleness are.

## 16.4 Background Processing Has Priority Tiers

Not all async work has equal urgency. A user-initiated Capability that is executing asynchronously must complete faster than a scheduled maintenance workflow that runs overnight. The background processing system must support priority tiers that are configurable per-Capability type.

## 16.5 Cost Optimisation Is a Design Constraint

Every AI model call has a cost. At platform scale, AI costs are a significant operating expense. Cost optimisation is not an afterthought — it is a design constraint that should be considered at Capability design time:
- Which Capability invocations can use a smaller, cheaper model?
- Which operations can be cached to avoid redundant model calls?
- Which Workflow steps can be batched to reduce per-call overhead?
- What is the cost per Capability invocation, and is that sustainable at scale?

---

# 17. Engineering Anti-Patterns

These patterns must never appear in the codebase. Their presence should fail code review. Their discovery in existing code is a prioritised technical debt item.

## Business Logic Anti-Patterns

**Business logic in UI components** — React components render; they do not approve, validate, or make routing decisions. Business logic in UI is untestable, duplicated when the UI changes, and invisible to governance.

**Tenant-specific logic in shared code** — Any `if (tenantId === 'acme-corp')` in shared code is hardcoded tenant logic. Tenant-specific behaviour is expressed through configuration; shared code is generic.

**Domain concept drift** — Code that uses different names than the domain model (calling a Capability a "skill", calling a Digital Employee an "agent", calling a Responsibility a "task") makes the codebase harder to understand and maintain. Every divergence is a translation cost paid by every engineer who reads that code.

**Repeated business logic** — The same rule expressed in two places is a rule that will be enforced inconsistently when it changes. Business rules have exactly one home.

## AI Engineering Anti-Patterns

**Hardcoded prompts in application code** — Prompts embedded as string literals in source files are unversioned, untestable, invisible to governance, and impossible to roll back independently of a code deploy.

**Direct Model Provider calls from business code** — Bypassing the Intelligence Service couples business code to a specific provider. One provider outage takes down capabilities that could have routed to a fallback.

**Trusting AI output without validation** — Acting on AI output before validating structure, content policy, and confidence is how a model hallucination or injection attack becomes a consequential platform action.

**Non-deterministic tests for AI output** — Tests that pass sometimes and fail sometimes create false confidence and mask real regressions. AI-integrated tests use semantic assertions or regression sets.

**Ignoring confidence scores** — Treating every AI response as equally reliable regardless of its stated confidence is how the platform serves incorrect answers with the same authority as correct ones.

## Security Anti-Patterns

**Bypassing approval flows** — Any code path that allows an Action to execute without Control Fabric evaluation — even "for testing", "for internal use", or "for performance" — is a security vulnerability and a governance failure.

**Skipping audit logs** — Any Action that does not produce an Audit Trail entry is unaccountable. The absence of an audit entry is not safe — it is unknown.

**Secrets in source control** — API keys, credentials, and tokens committed to a repository should be treated as compromised immediately upon discovery.

**Cross-tenant data access** — Any query that does not include tenant isolation filtering is a potential cross-tenant leak. A query that works for one tenant and accidentally returns another tenant's data is the most serious data breach the platform can have.

**Silent failures** — Catching an exception and returning an empty result rather than surfacing the error is invisible system degradation. The system appears to work; it is not working.

## Architecture Anti-Patterns

**Shared mutable state between services** — Two services reading and writing the same database table are not separate services — they are one service pretending to be two.

**Infrastructure in business logic** — A Capability definition that references `supabase.from('table').select()` has coupled a business concept to a specific database client. When Supabase changes, so must the business logic.

**Premature generalisation** — Abstracting over a pattern before there are two concrete instances of it. "We'll need this for the general case" is how platforms become over-engineered for problems they don't yet have.

**Building before observing** — Deploying a new Capability or Workflow without first defining what success looks like, how it will be measured, and what alerts will indicate failure. A feature that cannot be observed cannot be improved or trusted.

**Growing the monolith** — Adding service logic directly into the existing service because it's faster. Services that should be separate should become separate, with their own data, their own API, and their own deployment lifecycle.

---

# 18. Definition of Done

No feature, Capability, Workflow, or Digital Employee configuration is "done" until all of the following criteria are met:

## Functional
- [ ] Implements the intended Capability or behaviour as specified
- [ ] Handles all defined error cases with explicit, observable failure paths
- [ ] Produces the correct output for a representative range of inputs

## Security
- [ ] All data access is tenant-scoped with tenant isolation verified by tests
- [ ] All permissions are explicitly checked at the Control Fabric boundary
- [ ] No secrets appear in code, logs, or configuration files
- [ ] Input is validated at all boundaries

## Observability
- [ ] Emits domain Events for all significant state changes
- [ ] Produces Metrics for performance and business outcome measurement
- [ ] Includes Trace instrumentation for end-to-end request visibility
- [ ] Logs significant decisions in structured format with tenant attribution

## Auditability
- [ ] All consequential Actions produce Audit Trail entries
- [ ] The Audit Trail entry includes: who, what, when, tenant, outcome, and reason
- [ ] Approval-required Actions produce Audit Trail entries for the Approval decision, not just the Action

## Governance
- [ ] Passes through Control Fabric evaluation for all proposed Actions
- [ ] Configuration follows the defined hierarchy (Platform → Tenant → Workspace → Capability → DE)
- [ ] All configurable thresholds and rules are sourced from configuration, not hardcoded

## Quality
- [ ] Unit tests cover core business logic
- [ ] Integration tests verify behaviour in a production-like environment
- [ ] Tenant isolation tests verify no cross-tenant data access
- [ ] For AI-integrated features: regression set defined and passing

## Operability
- [ ] Latency targets defined and meeting them in the test environment
- [ ] Alerts defined for degraded behaviour
- [ ] Runbook entry added or updated if the feature introduces a new operational concern

## Documentation
- [ ] Domain concepts used in this feature align with `05_Core_Domain_Model.md`
- [ ] Public APIs follow versioning and naming conventions in this document
- [ ] Any new configuration surface is documented

---

# 19. Dependency and Vendor Governance

## 19.1 Every Third-Party Dependency Is a Long-Term Cost

Adding a dependency is easy. Maintaining it, upgrading it, removing it when it is abandoned, and migrating away from it when something better exists are all expensive. Every dependency must be evaluated not just on "does it solve today's problem" but on "are we willing to own this relationship for years?"

## 19.2 Vendor Neutrality Is a Platform Requirement

DreamTeam's architecture must be neutral with respect to AI providers, cloud providers, database vendors, and authentication platforms. No single vendor's APIs should appear in business code. All vendor integrations must go through abstraction layers designed to be reimplemented without changing business logic.

## 19.3 Evaluation Criteria for Dependencies

Before adding a third-party dependency, evaluate:
- Does this dependency introduce a vendor lock-in risk?
- Is there a clean abstraction layer between this dependency and business code?
- What is the migration cost if this dependency is abandoned or becomes unsuitable?
- Does this dependency comply with our security requirements (security audit, responsible disclosure)?
- Does this dependency respect our data residency requirements?
- Is this dependency actively maintained with a responsive maintainer?

## 19.4 Exit Strategy Is Required for Strategic Dependencies

For any dependency that is critical to platform operation — database, AI provider, workflow engine, identity provider — an exit strategy must be documented and periodically validated. An exit strategy that exists only on paper is not an exit strategy.

---

# 20. Immutable Engineering Principles

These principles must not be overridden by schedule pressure, product urgency, or technical convenience. They are the engineering constitution's equivalent of constitutional rights — they may be amended through deliberate process, but not ignored.

**Build platforms, not demos.**
Demos can take shortcuts. Platforms cannot. Every shortcut taken in a platform becomes a cost paid by every engineer who works on it afterward.

**Business logic outlives technology.**
The technology choices made today — Supabase, Vercel, Anthropic, pgvector — may all be different in five years. The business rules, domain concepts, and governance requirements will still be there. Design accordingly.

**The domain model is the contract.**
Names in code must match names in the domain model. APIs must model domain concepts. Databases must represent domain entities. Divergence from the domain model is technical debt that compounds invisibly.

**AI is replaceable infrastructure.**
The platform's value is not in which AI model it uses. Models change, improve, and become obsolete. The Digital Workforce platform is the lasting value — the models are the fuel.

**Customers own their data.**
The Organisation's Knowledge, Conversations, Workflow history, and Audit Trail belong to them. The platform is custodian, not owner. This principle must be enforced architecturally — not just stated in terms of service.

**Tenant isolation is a safety invariant.**
Cross-tenant data access is not a bug to be fixed — it is a structural failure that must be prevented at multiple architectural layers simultaneously.

**Governance is built in, not bolted on.**
The Control Fabric, Audit Trail, and Approval system are not enterprise add-ons. They are load-bearing architectural components that must be present from the first line of production code.

**Everything important is observable.**
If a Digital Employee takes an action and there is no event, no log entry, and no metric that records it — that action, from the platform's perspective, did not happen. Unobservable behaviour is ungovernable behaviour.

**Security is designed in, not added later.**
A platform that adds security controls after launch has a security model with gaps. The gaps are where the incidents happen.

**Configuration over customisation.**
An Organisation's Digital Workforce should be configurable to serve their specific needs without requiring custom code. Every time a customer's unique requirement requires a code change, that is a signal that the configuration model is not rich enough.

**Test what matters, not what is easy to test.**
Tenant isolation tests, AI behaviour regression tests, and resilience tests are harder to write than unit tests. They are also the tests that catch the failures that matter most. Optimising for test coverage metrics at the expense of testing what actually breaks in production is false assurance.

**Never sacrifice architecture for convenience.**
The decision to take an architectural shortcut is always made by one person in one moment under one set of constraints. The cost of that shortcut is paid by every engineer who works on the system afterward, indefinitely. The convenience benefit is short-lived. The architectural cost is not.

**Protect customer trust above all else.**
Trust, once broken with an enterprise customer, is extraordinarily difficult to recover. A data leak, a governance failure, an unaudited consequential action, or a broken cross-tenant isolation guarantee does not just lose one customer — it threatens the platform's reputation with every customer. Every engineering decision must be evaluated against: "could this break customer trust?"

---

*This document is the engineering constitution of the DreamTeam Digital Workforce Platform. It must be reviewed when a new architectural pattern is proposed that conflicts with its principles. Principles may be amended through deliberate architectural review — not by quiet exception. Every contributor, human or AI, must be familiar with this document before writing production code.*

*Version 1.0 — Written to remain valid at a scale of thousands of organisations, millions of users, and billions of workflow executions.*
