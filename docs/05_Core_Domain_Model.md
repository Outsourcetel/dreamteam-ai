# 05 — Core Domain Model

**DreamTeam Digital Workforce Platform**
Version 1.0 | Permanent Foundational Reference

---

## Purpose of This Document

This document defines the permanent conceptual language of the DreamTeam platform.

It is not a database design, an API specification, an architecture document, or an implementation guide. It describes no tables, no endpoints, no classes, and no code.

It defines:
- What concepts exist in the DreamTeam domain.
- Why each concept exists.
- What each concept is responsible for.
- What each concept must never own.
- How concepts relate to one another.
- Who can see or interact with each concept.

This document should remain valid even if the frontend changes, the backend changes, the AI models change, the database changes, the cloud provider changes, or the orchestration engine changes.

Everything else — databases, APIs, UI, architecture, engineering standards, prompts, documentation — should reference this document instead of inventing new terminology.

**This is DreamTeam's dictionary. It should remain relevant for a decade.**

---

## Architectural Ownership Notation

Throughout this document, each concept is tagged with its owning layer from the 10-layer architecture:

| Tag | Layer |
|-----|-------|
| **[Platform]** | Platform Foundation — auth, RBAC, billing, audit, multi-tenancy |
| **[Workspace]** | Workspaces & Business Capabilities |
| **[Workforce]** | Workforce Engine & Digital Workforce |
| **[Knowledge]** | Knowledge & Memory Platform |
| **[Control]** | Control Fabric |
| **[Integration]** | Integration Platform |
| **[Intelligence]** | Intelligence Platform |
| **[Performance]** | Performance & Optimisation |
| **[Infra]** | Infrastructure |

---

## Deliberate Exclusions

The following are **not** domain concepts. They are implementation details that belong behind the platform's boundaries. They must never appear in customer-facing surfaces, documentation, or product naming.

- Agents (internal execution units; customers hire Digital Employees, not agents)
- Prompts (internal configuration; customers define Responsibilities, not prompts)
- Embeddings (internal representation; customers manage Knowledge, not vectors)
- Vector databases (internal storage; customers interact with Knowledge Collections)
- LLMs, model weights, transformer architectures
- Orchestration pipelines
- Tokens and context windows (surfaced only as operational metrics to platform admins)

---

## 1. Tenant

**[Platform]** | Internal / Admin-facing

### Definition
A Tenant is the platform's unit of isolation, subscription, billing, and configuration. Every piece of data, every Digital Employee, every Workflow, and every Conversation belongs to exactly one Tenant. Tenants are logically and physically isolated from one another.

### Purpose
Tenant exists to enforce the multi-tenancy contract. It is the boundary within which a customer's entire Digital Workforce operates. It is not the customer's business — it is their instance of the platform.

### Responsibilities
- Own all data within its boundary.
- Enforce configuration and policy isolation.
- Track subscription, entitlements, and usage.
- Define the root of all permission and audit trails.

### Relationships
- A Tenant represents one Organisation.
- A Tenant contains one or more Workspaces.
- A Tenant owns Policies, Connectors, Knowledge Collections, and Digital Employees.
- A Tenant may be governed by Data Residency rules that constrain where its data is stored and processed.

### What Tenant Must Never Own
Tenant must never own business logic. It is an administrative and operational boundary, not a product concept. Capabilities, Workflows, and Responsibilities are defined within the Tenant but not by the Tenant concept itself.

### Customer Visibility
Internal and admin-facing. Customers experience their Tenant as "their DreamTeam environment" without necessarily knowing the word Tenant.

### Future Considerations
A single Organisation may eventually operate multiple Tenants (e.g. for regional subsidiaries, regulated divisions, or environment separation). The model should support this without requiring Tenant to become aware of Organisation hierarchy.

---

## 2. Organisation

**[Platform]** | Customer-facing

### Definition
An Organisation is the real-world business entity that subscribes to DreamTeam. It has a name, an industry, an identity, and human leaders who are accountable for its Digital Workforce strategy.

### Purpose
Organisation provides the human and business context within which all Digital Workforce activity takes place. It is how the platform represents the customer's company as a meaningful entity — not just a billing record.

### Responsibilities
- Represent the legal and operational entity.
- Own the brand identity presented to users and customers.
- Define the top-level industry context that shapes default Workspace and Capability recommendations.
- Hold the relationship between DreamTeam and the subscribing business.

### Relationships
- An Organisation is represented by exactly one Tenant at the platform level.
- An Organisation contains Departments.
- An Organisation employs Users (human) and Digital Employees (AI).
- An Organisation defines Policies that govern its entire Digital Workforce.

### What Organisation Must Never Own
Organisation must never own execution logic, Workflows, or AI configuration. Those belong to Workspaces and the Workforce Engine.

### Customer Visibility
Customer-facing. Customers configure and identify with their Organisation.

### Future Considerations
Organisations may eventually have a hierarchical structure (parent company, subsidiaries, brands). The model should remain stable as that structure is introduced — Organisation relationships can evolve without redefining what an Organisation is.

---

## 3. User

**[Platform]** | Customer-facing / Admin-facing

### Definition
A User is a human being who interacts with the DreamTeam platform. Users exist at multiple levels: platform operators (DreamTeam staff), tenant administrators, and end users (employees or customers of the subscribing Organisation).

### Purpose
User exists to represent human actors within the platform's identity and permission model. Every audited action is attributable to either a User or a Digital Employee.

### Responsibilities
- Authenticate to the platform.
- Hold a Role that determines access permissions.
- Appear in Audit Trails as the human actor responsible for decisions.
- Initiate Conversations, approve Actions, and configure the platform.

### Relationships
- A User belongs to a Tenant.
- A User holds one or more Roles.
- A User may interact with Digital Employees via Conversations.
- A User may be an Approver in an Approval Workflow.
- A User may be a recipient of Escalations and Handoffs.

### Customer Visibility
Customer-facing. Users are aware of themselves and their colleagues. They may be aware of Digital Employees as peers in the workforce.

### Future Considerations
Users may eventually include external parties (contractors, partners) with limited scoped access. The User concept remains stable; the Role and permission model absorbs that complexity.

---

## 4. Department

**[Platform]** | Customer-facing / Admin-facing

### Definition
A Department is an organisational grouping of Users and Digital Employees that reflects a real business unit within the Organisation (e.g. Customer Support, Finance, Human Resources, Sales).

### Purpose
Departments provide an organisational context that allows Workspaces, Capabilities, and Policies to be configured and scoped appropriately. They reflect how the Organisation actually operates, not how the platform is structured.

### Responsibilities
- Group Users and Digital Employees by business function.
- Provide a scoping boundary for Workspace access, Reporting, and Policy application.
- Enable department-level approval hierarchies and escalation paths.

### Relationships
- Departments belong to an Organisation.
- Departments may contain Users and Digital Employees.
- Departments may be associated with one or more Workspaces.
- Departments may own department-level Policies.

### Customer Visibility
Customer-facing and admin-facing. Department heads configure their department; users see the department they belong to.

### Future Considerations
Departments may eventually map to formal org chart hierarchies with parent/child relationships. They may also map to external HR systems.

---

## 5. Workspace

**[Workspace]** | Customer-facing

### Definition
A Workspace is a named domain of business activity within an Organisation. Each Workspace groups the Capabilities, Digital Employees, and Knowledge relevant to a specific business function. Examples: Customer Support, Revenue, Finance, HR, Customer Success.

### Purpose
Workspace gives the DreamTeam platform its business shape. Users navigate to a Workspace to understand what their Digital Workforce is doing and to configure how it operates. A Workspace represents "what this part of the business does" — not how the technology executes it.

### Responsibilities
- Group related Business Capabilities under a coherent business domain.
- Present the Digital Workforce active in that domain.
- Surface Insights and Metrics relevant to that domain.
- Enforce domain-level Policies.
- Serve as the primary navigation and operational surface for business users.

### Relationships
- A Workspace belongs to a Tenant.
- A Workspace contains Capabilities.
- A Workspace is served by Digital Employees with matching Workforce Roles.
- A Workspace may be associated with one or more Departments.
- A Workspace may subscribe to Channels (the surfaces through which work arrives).

### What Workspace Must Never Own
A Workspace must never own execution logic, AI model configuration, or the internal details of how Capabilities are fulfilled. It is a business container, not a technical one.

### Customer Visibility
Customer-facing. Workspaces are the primary way customers navigate and understand their Digital Workforce.

### Future Considerations
Workspaces may evolve to support cross-workspace Capabilities (e.g. a capability that spans Finance and HR). The Workspace concept remains stable; the Capability model absorbs that complexity.

---

## 6. Capability

**[Workspace]** | Customer-facing

### Definition
A Capability is a named, discrete Business Outcome that the Digital Workforce can execute on behalf of the Organisation. A Capability represents what the business can do — not how it is done technically. Examples: Answer Customer Question, Qualify Lead, Detect Transaction Exception, Onboard New Employee.

### Purpose
Capability is the atomic unit of business value in DreamTeam. It is the answer to the customer's question: "What can my Digital Workforce actually do?" Capabilities are stable over time — they represent business intent, not technical implementation. A Capability may be fulfilled by different AI models, orchestration strategies, or data sources over time without its definition changing.

### Responsibilities
- Define the name, description, and expected business outcome.
- Specify the Inputs required and Outputs produced.
- Hold the approval rules and risk classification.
- Declare which Knowledge, Connectors, and Digital Employees are required.
- Record execution history, confidence, and performance metrics.

### Relationships
- A Capability belongs to a Workspace.
- A Capability is fulfilled by one or more Digital Employees.
- A Capability requires specific Knowledge, Connectors, and Tools (declared, not owned).
- A Capability may require an Approval before its output is acted upon.
- A Capability is governed by Policies from the Control Fabric.
- A Capability generates Events that feed the Audit Trail and Insight Engine.

### What Capability Must Never Own
A Capability must never know which AI model executes it, which internal Agents are coordinated, or how data is retrieved from a Knowledge source. It declares business intent; the Workforce Engine and Intelligence Service fulfil it.

### Customer Visibility
Customer-facing. Capabilities are what customers enable, disable, configure, and measure.

### Future Considerations
Capabilities may evolve to support composability — a Capability composed of sub-Capabilities. They may also evolve to support SLAs, business rules, and outcome-based pricing.

---

## 7. Workforce Role

**[Workforce]** | Admin-facing

### Definition
A Workforce Role is a logical business function that defines the category of work a Digital Employee performs within the Organisation. Examples: Customer Support Specialist, Revenue Development Representative, Finance Analyst, HR Advisor, Compliance Officer.

### Purpose
Workforce Roles provide the structural vocabulary for describing a Digital Workforce. They allow Organisations to define what kinds of Digital Employees they need, independent of any specific Digital Employee instance. A Workforce Role is the job family; a Digital Employee is the hire.

### Responsibilities
- Define the expected competency domain (Support, Finance, HR, Revenue, etc.).
- Specify which Workspaces and Capabilities a Digital Employee of this role may serve.
- Provide the default Responsibility set for Digital Employees assigned to this role.
- Inform the hiring and configuration experience (what does this role do, what does it need access to).

### Relationships
- A Workforce Role is a classification applied to a Digital Employee.
- A Workforce Role is associated with one or more Workspaces.
- A Workforce Role suggests a default set of Responsibilities.

### What Workforce Role Must Never Own
Workforce Role must never own the actual Responsibilities or Capabilities of a specific Digital Employee. It is a template and classification, not a constraint.

### Customer Visibility
Admin-facing. Customers choose or define Workforce Roles when configuring their Digital Employees.

### Future Considerations
The marketplace of available Workforce Roles may grow significantly. Roles may have certification or compliance requirements in regulated industries.

---

## 8. Digital Employee

**[Workforce]** | Customer-facing

### Definition
A Digital Employee is a named AI-powered team member within the Organisation that customers interact with, assign work to, and trust as a functional colleague. A Digital Employee has a name, a Workforce Role, a set of Responsibilities, and a defined scope of access. Examples: Alex (Support Specialist), Jordan (Billing Advisor), Casey (HR Advisor).

### Purpose
Digital Employees are DreamTeam's core customer-facing value proposition. They are the entity customers think of when they ask "who handles our customer queries?" or "who monitors our transactions?" They are not chatbots, assistants, or tools. They are members of the workforce — accountable, auditable, and configurable.

### Important Distinction
**A Digital Employee is not an Agent.**

A Digital Employee is a customer-visible business persona with a defined identity, Responsibilities, and accountability. It is what customers hire, name, configure, and measure.

An Agent is an internal execution component. Customers never see, configure, or interact with Agents directly. The Workforce Engine coordinates Agents to fulfil what Digital Employees are accountable for.

The analogy: a Digital Employee is the employee. Agents are the skills and tools that employee uses — invisible to the person who hired them.

### Responsibilities
- Maintain a defined identity (name, role, persona) within the Organisation.
- Own a set of Responsibilities that define its accountability domain.
- Participate in Conversations, execute Capabilities, and generate Actions.
- Maintain a Confidence profile — when it is and isn't certain of its work.
- Generate an Audit Trail of every action taken.
- Operate within the boundaries set by the Control Fabric.
- Escalate or request Approval when its Responsibilities or confidence require it.

### Relationships
- A Digital Employee belongs to a Tenant.
- A Digital Employee is assigned a Workforce Role.
- A Digital Employee owns Responsibilities.
- A Digital Employee fulfils Capabilities (but does not own them).
- A Digital Employee operates within a defined Knowledge Scope (what it can read and cite).
- A Digital Employee is governed by Connector Permissions, Action Rules, and Policies from the Control Fabric.
- A Digital Employee participates in Conversations with Users and customers.
- A Digital Employee may Escalate or initiate a Handoff to a human User.

### What a Digital Employee Must Never Own
A Digital Employee must never own its own AI model configuration, prompt templates, or embedding logic. It must never bypass approval rules or audit requirements. It must never access data outside its assigned Knowledge Scope and Connector Permissions.

### Customer Visibility
Customer-facing. Digital Employees are the primary entity that end customers interact with and that business administrators configure and trust.

### Future Considerations
Digital Employees may evolve to have learning profiles, performance reviews, and specialisation paths — mirroring the lifecycle of a human employee in HR systems.

---

## 9. Responsibility

**[Workforce]** | Admin-facing

### Definition
A Responsibility is a sustained domain of accountability assigned to a Digital Employee. It defines what the Digital Employee is accountable for — the ongoing obligations of its role — rather than any single discrete action. Examples: Customer Troubleshooting, Billing Management, Employee Onboarding, Compliance Monitoring.

### Why Responsibility Is Different From Capability

This is a critical distinction that must be permanently maintained.

A **Capability** is an executable business outcome — a discrete thing the platform can do. It has defined inputs and outputs. It is atomic. It is measured per execution. It may be fulfilled by multiple Digital Employees.

A **Responsibility** is an ongoing accountability domain — a sustained area of ownership that a Digital Employee holds. It does not execute. It is not measured per invocation. It shapes the Digital Employee's identity and determines which Capabilities it is expected to fulfil.

The relationship: a Responsibility explains *why* a Digital Employee is trusted with certain Capabilities. The Capability is *what* gets done. The Responsibility is *what the Digital Employee is accountable for as a standing member of the team*.

**Analogy:** A human Support Manager is *responsible* for Customer Satisfaction and Ticket Resolution (Responsibilities). To fulfil those responsibilities, they *answer queries, issue refunds, and escalate complex cases* (Capabilities). The responsibility doesn't disappear after each ticket. The capability is exercised once per ticket.

### Example
Digital Employee: Alex — Support Specialist

Responsibilities:
- Customer Troubleshooting
- Product Education
- Ticket Management
- Escalation Management

Capabilities Alex can execute:
- Answer Customer Question
- Reset Password
- Escalate to Human Agent
- Summarise Case History

Alex can answer a customer question because it is *responsible* for Customer Troubleshooting. But Customer Troubleshooting is not "done" after one question — it is a sustained commitment.

### Responsibilities (What This Concept Owns)
- Define the accountability domain of a Digital Employee.
- Shape which Capabilities the Digital Employee is expected to fulfil.
- Appear in the Digital Employee's public profile as its role commitments.
- Inform the Control Fabric about which data and tools access is appropriate.

### Relationships
- Responsibilities are owned by a Digital Employee.
- Each Responsibility is associated with one or more Capabilities.
- Responsibilities are informed by the assigned Workforce Role (default set) but are customisable per Digital Employee instance.

### What Responsibility Must Never Own
Responsibility must never own execution logic, AI configuration, or data access rules. Those belong to Capabilities and the Control Fabric respectively.

### Customer Visibility
Admin-facing. Customers see a Digital Employee's Responsibilities when reviewing who is accountable for what.

### Future Considerations
Responsibilities may eventually be certified or attested — confirming that a Digital Employee is fit-for-purpose for a given accountability domain. This is especially relevant in regulated industries.

---

## 10. Workforce Engine

**[Workforce]** | Internal

### Definition
The Workforce Engine is the internal orchestration service that coordinates the execution of Capabilities. It receives a Capability invocation, plans the execution steps, coordinates the necessary Agents, manages state and context, enforces approval and escalation rules, and returns results.

### Purpose
The Workforce Engine is what makes Digital Employees actually work. It is the operational core of the platform — the engine behind the persona. Customers never see it, name it, or configure it directly. They configure Capabilities, Policies, and the Control Fabric; the Workforce Engine executes against those configurations.

### Responsibilities
- Accept Capability invocation requests from the platform.
- Plan the execution sequence for a given Capability.
- Coordinate internal Agents to execute plan steps.
- Maintain execution state, context, and memory across steps.
- Apply approval rules and escalation logic mid-execution.
- Return results to the originating surface (Conversation, Workflow, API).
- Log all execution steps to the Audit Trail.

### Relationships
- The Workforce Engine executes Capabilities.
- The Workforce Engine coordinates Agents.
- The Workforce Engine reads Policies and Control Fabric rules during execution.
- The Workforce Engine writes to the Audit Trail and generates Events.
- The Workforce Engine manages Working Memory and Conversation Memory during execution.

### What the Workforce Engine Must Never Own
The Workforce Engine must never expose implementation details to customers. It must never bypass Control Fabric rules or approval requirements. It must never store business data — it is a coordination layer, not a data store.

### Customer Visibility
Internal. Customers interact with its outputs (results, approvals, escalations) without knowing it exists.

### Future Considerations
The Workforce Engine may evolve to support parallelisation, multi-agent coordination, planning verification (checking a plan against Policies before execution), and cross-tenant coordination for platform-level tasks.

---

## 11. Agent

**[Workforce]** | Engineering-only / Internal

### Definition
An Agent is an internal execution component that performs a specific, bounded function within the Workforce Engine's coordination of a Capability. An Agent may retrieve knowledge, call a tool, generate text, validate an output, or perform a reasoning step. Agents are invisible to customers.

### Purpose
Agents are the technical implementation units that enable Digital Employees to function. They exist to keep execution modular, composable, and replaceable. When a Digital Employee answers a question, multiple Agents may have collaborated: one retrieved relevant Knowledge, one generated a draft response, one validated compliance with Policy, one formatted the output. The customer saw none of this — they saw the Digital Employee answer their question.

### The Most Important Rule in This Domain Model

**Customers hire Digital Employees. The Workforce Engine coordinates Agents. These two concepts must never merge in the platform's communication, product design, or customer-facing surfaces.**

Exposing Agents to customers is the equivalent of a staffing agency explaining the neurological processes of their candidates rather than their skills. The abstraction exists for good reason: AI implementation changes constantly. The Digital Employee persona remains stable.

### Responsibilities
- Execute a specific bounded function (retrieve, generate, validate, transform, call).
- Return a typed result to the Workforce Engine.
- Report confidence and error state.
- Log its action to the Audit Trail.

### Relationships
- Agents are coordinated by the Workforce Engine.
- An Agent may invoke Tools and Connectors.
- An Agent draws from the Knowledge Platform.
- An Agent uses the Intelligence Service for model interactions.
- Multiple Agents may collaborate within a single Capability execution.

### Customer Visibility
Engineering-only. Never customer-facing. Never admin-facing in normal operation.

### Future Considerations
Agents may become more specialised as the platform evolves. The model remains stable: the customer always sees Digital Employees; Agents remain implementation detail.

---

## 12. Tool

**[Integration]** | Admin-facing

### Definition
A Tool is a specific, named action or function that an Agent can invoke during Capability execution. A Tool is bounded — it does one thing. Examples: send_email, create_ticket, query_crm_record, calculate_refund_amount, format_document.

### Purpose
Tools make Agents capable of taking action in the world. A Tool is the mechanism by which the Digital Workforce creates outputs beyond generating text — it updates records, sends messages, retrieves data, and triggers processes.

### Responsibilities
- Define a specific callable function with a name, input schema, and output schema.
- Execute reliably and return a typed result.
- Be auditable — every Tool invocation is logged with inputs, outputs, and invoking entity.
- Respect the permissions granted to the invoking Agent by the Control Fabric.

### Relationships
- Tools are invoked by Agents.
- Tools may interact with external systems via Connectors.
- Tool invocations are governed by Action Rules in the Control Fabric.
- Tool invocations generate Events in the Audit Trail.

### What Tool Must Never Own
A Tool must never make a business decision. It is a pure function — given inputs, produce outputs or take a defined action. Business logic lives in the Capability definition and the Workforce Engine, not in a Tool.

### Customer Visibility
Admin-facing at the level of Tool categories and permissions (e.g. "Alex can send emails but not delete records"). The specific implementation of a Tool is engineering-only.

---

## 13. Connector

**[Integration]** | Admin-facing

### Definition
A Connector is a configured binding to an external system that makes that system's data and capabilities available within the DreamTeam platform. A Connector handles authentication, data mapping, sync cadence, and permission scoping for a specific external system. Examples: Salesforce Connector, Stripe Connector, Zendesk Connector, BambooHR Connector.

### Purpose
Connectors are how the Digital Workforce becomes aware of and takes action within the Organisation's existing technology stack. A Connector is not the data — it is the bridge to the data.

---

## 14. Integration

**[Integration]** | Admin-facing

### Definition
An Integration is the configured use of one or more Connectors within a specific Workflow or Capability. An Integration answers the question: "How is this external system being used in this business process?"

### The Critical Distinction Between Connector and Integration

A **Connector** is the *capability to connect* to a system. It is configured once per Tenant and is reusable across many Workflows and Capabilities. A Connector establishes a channel: credentials, API bindings, field mappings.

An **Integration** is the *configured use* of that connection in a specific business context. You connect Salesforce once (Connector); you then integrate it into the Lead Qualification Capability and the Account Renewal Workflow separately (two Integrations using one Connector).

**Analogy:** A Connector is the electrical outlet. An Integration is the specific appliance plugged in for a specific purpose. The outlet exists once; the appliances are configured per use.

### Responsibilities
- Define how a specific Connector is used within a Capability or Workflow.
- Map external data fields to the platform's internal data model.
- Enforce data permission rules specific to that Integration context.

### Relationships
- An Integration uses one or more Connectors.
- An Integration is associated with one or more Capabilities or Workflows.
- An Integration's data access is governed by the Control Fabric.

### Customer Visibility
Admin-facing. Customers configure Integrations when setting up Capabilities.

---

## 15. Channel

**[Workspace]** | Admin-facing

### Definition
A Channel is an inbound surface through which Conversations originate and through which the Digital Workforce delivers responses. Examples: live chat widget, email inbox, API endpoint, voice interface, internal employee portal, WhatsApp, Slack.

### Purpose
Channel exists because the same Capability may be delivered through multiple surfaces, each with different formatting requirements, latency constraints, tone expectations, and policy implications. The platform must model Channel explicitly to support true omnichannel operation.

### Responsibilities
- Define the inbound surface and its technical protocol.
- Specify formatting constraints (e.g. plain text only for SMS, rich markdown for chat).
- Configure per-channel Policies (e.g. human approval required for email, auto-send for chat).
- Route inbound requests to the appropriate Workspace and Capability.

### Relationships
- A Channel is associated with one or more Workspaces.
- Conversations originate from a Channel.
- Policies may vary by Channel.

### What Channel Must Never Own
Channel must never contain business logic. It is a delivery and intake mechanism.

### Customer Visibility
Admin-facing.

---

## 16. Knowledge

**[Knowledge]** | Admin-facing

### Definition
Knowledge is the totality of information assets that the Digital Workforce can draw upon when executing Capabilities. Knowledge is an enterprise asset — it exists independently of any AI model or technology platform. Examples of Knowledge: product documentation, SOPs, FAQs, case histories, policy documents, training materials.

### Purpose
Knowledge is what makes Digital Employees competent. A Digital Employee without Knowledge is a generic AI; a Digital Employee with well-curated Knowledge is a domain expert. Knowledge is a strategic asset that the Organisation owns, controls, and continuously maintains.

### Responsibilities
- Exist as structured, curated, version-controlled content.
- Be classified by type, audience, domain, and trust level.
- Be accessible only to Digital Employees with the appropriate Knowledge Scope as defined in the Control Fabric.
- Maintain provenance — every use of Knowledge should be traceable back to its source.

### What Knowledge Must Never Own
Knowledge must never own execution logic, AI model configuration, or retrieval mechanisms. It is content — how it is retrieved and used is the responsibility of the Knowledge Platform.

### Customer Visibility
Admin-facing and customer-facing (when cited in responses).

---

## 17. Knowledge Source

**[Knowledge]** | Admin-facing

### Definition
A Knowledge Source is the origin point of content that populates a Knowledge Collection. Examples: uploaded PDF documents, connected Confluence spaces, ingested web pages, CRM notes, historical ticket conversations, structured CSV files.

### Purpose
Knowledge Sources represent the diverse origins of organisational knowledge. The platform must ingest from many sources while normalising the resulting Knowledge into a consistent internal representation.

### Relationships
- A Knowledge Source feeds one or more Knowledge Collections.
- Knowledge Sources may be live (synchronised continuously) or static (uploaded once).
- A Knowledge Source is bound to a Connector if it originates from an external system.

---

## 18. Knowledge Collection

**[Knowledge]** | Admin-facing

### Definition
A Knowledge Collection is a curated, structured set of Knowledge Items that has been processed, indexed, and made retrievable within the platform. A Knowledge Collection belongs to a Tenant and may be scoped to specific Workspaces, Capabilities, or Digital Employees via the Control Fabric.

### Purpose
Knowledge Collections are the unit of knowledge governance. They allow Organisations to maintain clear separation between knowledge intended for customers, knowledge intended for internal staff, and knowledge restricted to specific Digital Employees.

### Responsibilities
- Maintain a curated, versioned set of Knowledge Items.
- Enforce audience scoping (customer-facing vs internal).
- Support search, retrieval, and citation by the Knowledge Platform.
- Track coverage gaps and freshness.

---

## 19. Memory

**[Knowledge]** | Internal

### Definition
Memory is the platform's capability to retain, recall, and contextualise information across time and interactions. Memory is distinct from Knowledge: Knowledge is curated enterprise content; Memory is dynamically captured operational context.

### Memory Types

**Organisational Memory** — Long-lived, tenant-scoped information about the Organisation, its customers, relationships, patterns, and learned preferences. Organisational Memory persists indefinitely and grows richer over time. Example: "Customer Acme Corp. has escalated billing issues three times in the past year."

**Working Memory** — Short-lived, capability-execution-scoped context held during a single Capability invocation. Discarded when execution completes. Example: the intermediate steps and data gathered while answering a multi-part question.

**Conversation Memory** — Medium-lived context scoped to a single Conversation. Persists for the duration of the conversation and may be summarised for Organisational Memory after it concludes. Example: what was discussed earlier in the same chat session.

### Important Principle
Memory types operate at different scopes and timescales. They must be kept architecturally separate to prevent information leakage across scope boundaries — for example, Working Memory from one customer's session must never bleed into another customer's Conversation Memory.

### Customer Visibility
Internal. Customers experience its effects (the platform "remembers" context) without directly managing it. Organisational Memory summaries may be surfaced as Insights.

---

## 20. Context

**[Workforce]** | Internal

### Definition
Context is the assembled information made available to the Workforce Engine at the moment of Capability execution. Context is constructed from Memory, the active Conversation, relevant Knowledge, and Connector data. It is temporary — it exists only for the duration of an execution.

### Purpose
Context is what allows Digital Employees to give answers that are relevant, accurate, and situationally appropriate rather than generic. It is the difference between "Here is how to reset a password" and "Based on your account history and current session, here is the specific reset process for your plan level."

### What Context Must Never Do
Context must never persist beyond the execution scope for which it was assembled. It must never include data that the Control Fabric has excluded from the executing Digital Employee's scope.

---

## 21. Conversation

**[Workspace]** | Customer-facing

### Definition
A Conversation is a bounded, recorded exchange between one or more Users (or customers) and one or more Digital Employees. A Conversation has a beginning, a state (active, resolved, escalated), and a permanent record in the Audit Trail.

### Purpose
Conversation is the primary interaction surface between humans and the Digital Workforce. It is where Capabilities are invoked, where trust is built or broken, and where the platform generates most of its observable value.

### Responsibilities
- Maintain the exchange record.
- Track state transitions (active → resolved, active → escalated, active → handoff).
- Link to the Capabilities invoked within it.
- Capture sentiment and satisfaction signals.
- Generate Audit Trail entries.

### Relationships
- A Conversation originates on a Channel.
- A Conversation involves one or more Digital Employees and one or more humans.
- A Conversation may generate one or more Actions, Approvals, Escalations, or Handoffs.
- A Conversation is stored in Conversation Memory during its lifetime.
- A Conversation generates Events.

---

## 22. Workflow

**[Workspace]** | Admin-facing

### Definition
A Workflow is a pre-configured, multi-step sequence of Capabilities and actions that executes in response to a defined trigger or schedule. Workflows represent business processes that the Organisation has decided to automate.

### Purpose
Workflows enable the Digital Workforce to operate proactively — not only responding to inbound requests but executing structured processes end-to-end. Examples: monthly reconciliation workflow, new employee onboarding workflow, contract renewal outreach workflow.

### Responsibilities
- Define the trigger, sequence of steps, and completion criteria.
- Specify the Digital Employees responsible for each step.
- Define decision points, branching logic, and approval gates.
- Log all execution history.

### Relationships
- A Workflow belongs to a Workspace.
- A Workflow invokes one or more Capabilities.
- A Workflow may include Approval gates.
- A Workflow generates Events and Audit Trail entries.
- A Workflow is governed by Control Fabric Policies.

### What Workflow Must Never Own
Workflow must never contain AI model logic, prompting logic, or data retrieval logic. It orchestrates Capabilities; the Workforce Engine executes them.

---

## 23. Execution Plan

**[Workforce]** | Internal

### Definition
An Execution Plan is a dynamic, runtime-generated sequence of steps that the Workforce Engine creates when it receives a Capability invocation. Unlike a Workflow (which is pre-configured), an Execution Plan is reasoned and generated at runtime based on the Capability, Context, and available Tools.

### Purpose
Not every business task can be fully pre-scripted as a Workflow. The Workforce Engine must sometimes reason about how to accomplish a Capability given the specific context of a request. The Execution Plan is the output of that reasoning — the engine's structured proposal for what it will do before it does it.

### Importance
The Execution Plan is what allows the Workforce Engine to be intelligent without being opaque. It can be logged, reviewed, and in some configurations, approved before execution begins. This is foundational to trustworthy AI operation.

### Relationships
- An Execution Plan is generated by the Workforce Engine.
- An Execution Plan is specific to a single Capability invocation.
- An Execution Plan may be subject to Policy review before execution.
- An Execution Plan generates the sequence of Agent coordinations.

### Customer Visibility
Internal by default. May be surfaced to administrators in high-risk scenarios as part of pre-execution approval.

---

## 24. Task

**[Workforce]** | Admin-facing

### Definition
A Task is a discrete unit of work assigned to a Digital Employee, either generated by a Workflow, requested by a User, or created by the Digital Employee itself as part of a Capability execution. A Task has an owner, a status, a deadline, and an outcome.

### Purpose
Tasks allow the Digital Workforce's activity to be tracked, managed, and prioritised in the same way human work is managed. They bridge the gap between AI-initiated activity and human operational oversight.

### Relationships
- Tasks are assigned to Digital Employees or Users.
- Tasks may be generated by Workflows or Conversations.
- Tasks may require Approval before proceeding.
- Tasks generate Events upon completion, failure, or escalation.

---

## 25. Event

**[Platform]** | Internal / Admin-facing

### Definition
An Event is a notification that a meaningful state change has occurred within the platform. Events are immutable records of what happened, when, and to whom. They are the foundation of the Audit Trail, the Insight Engine, and reactive Workflows.

### Purpose
Events make the platform observable. Everything that happens — Capability executions, Workflow completions, Approval decisions, Escalations, Handoffs, Policy violations — generates an Event. Events are the raw material of governance, analytics, and continuous improvement.

### Responsibilities
- Record the what, when, who, and result of a state change.
- Be immutable once written.
- Feed the Audit Trail.
- Trigger reactive Workflows and Alerts.
- Aggregate into Metrics and Insights.

### What Event Must Never Own
Events must never be modified or deleted. They are the ground truth of platform history.

---

## 26. Approval

**[Control]** | Customer-facing / Admin-facing

### Definition
An Approval is a formal checkpoint at which a human User must review and authorise a proposed Action before it is executed. Approvals may be triggered by Policy, by the risk level of an Action, by the value of a transaction, or by the confidence level of a Digital Employee.

### Purpose
Approval is one of DreamTeam's most important trust mechanisms. It ensures that high-risk, high-value, or ambiguous actions remain under human control. Approvals are not a sign of platform weakness — they are an architectural guarantee that humans remain in the loop where the Organisation has decided they must be.

### Responsibilities
- Present the proposed action and its context clearly to the Approver.
- Record the approval or rejection decision with the approver's identity and timestamp.
- Release or block the action based on the decision.
- Generate an Audit Trail entry regardless of outcome.
- Time-out gracefully if no decision is made within a configured window.

### Relationships
- Approvals are triggered by Capability executions, Workflow steps, or Action Rules in the Control Fabric.
- Approvals are assigned to specific Users or Roles.
- Approvals generate Events.

---

## 27. Escalation

**[Workspace]** | Customer-facing / Admin-facing

### Definition
An Escalation is the automated or manual elevation of a Conversation, Task, or Decision to a higher authority or different team when the Digital Employee determines it cannot or should not handle the situation independently. Escalation is a signal — it says "this needs human attention or a different Digital Employee."

### Purpose
Escalation is how the platform maintains quality and safety at the boundary of the Digital Employee's competence or authority. It is a designed behaviour, not a failure — a well-calibrated Digital Employee should escalate appropriately.

### The Distinction Between Escalation and Handoff

**Escalation** is a trigger. It says: "Something about this situation exceeds my threshold — confidence too low, risk too high, complexity beyond my scope, or customer has explicitly requested a human." Escalation generates an alert and an Approval or routing decision.

**Handoff** is the transfer of accountability that may follow an Escalation. A Handoff carries context: the Conversation history, the Digital Employee's summary, the recommended next steps. A Handoff can also be planned and deliberate without an Escalation — for example, handing a qualified lead from a Sales DE to a human Account Executive.

**Analogy:** Escalation is raising your hand. Handoff is passing the baton.

---

## 28. Handoff

**[Workspace]** | Customer-facing / Admin-facing

### Definition
A Handoff is the deliberate transfer of accountability for a Conversation, Task, or Process from one entity to another — from Digital Employee to human, from human to Digital Employee, or from one Digital Employee to another. A Handoff carries a structured summary of context, history, and recommended next steps.

### Purpose
Handoff ensures that transfers of accountability are clean, context-rich, and accountable. Poor handoffs lose context. Good Handoffs make the receiving party more effective than if they had started from scratch.

### Responsibilities
- Carry Conversation history and relevant context.
- Include the transferring entity's summary and recommendation.
- Record the transfer in the Audit Trail.
- Notify the receiving entity.
- Update the Conversation state.

---

## 29. Policy

**[Control]** | Admin-facing

### Definition
A Policy is a formal rule that governs how the Digital Workforce is permitted to behave. Policies are defined by the Organisation and enforced by the Control Fabric across all Capabilities, Workflows, and Actions. Examples: "All customer refunds above £100 require approval", "No customer data may be exported without admin authorisation", "All communication with users in the EU must comply with GDPR data handling."

### Purpose
Policies are how Organisations translate governance, compliance, risk management, and business rules into enforceable AI behaviour. Policies are not suggestions — they are constraints. A Digital Employee cannot override a Policy; the Control Fabric enforces it at the execution boundary.

### Responsibilities
- Define a rule: condition, scope, and consequence.
- Apply consistently across all affected Capabilities and Workflows.
- Be versioned and auditable.
- Generate an Event whenever a Policy is triggered.

### Relationships
- Policies are owned by the Organisation (via the Control Fabric).
- Policies govern Capabilities, Workflows, Actions, and Channels.
- Policies may be informed by Department-level rules.
- Policies generate Events and Audit Trail entries when triggered.

### What Policy Must Never Own
Policies must never contain implementation logic. A Policy defines a rule; the Control Fabric and Workforce Engine enforce it.

---

## 30. Control Fabric

**[Control]** | Admin-facing (Strategic differentiator)

### Definition
The Control Fabric is the governance and configuration layer through which Organisations define, at a granular level, exactly what their Digital Workforce is permitted to do, access, know, and decide. It is the answer to the question every enterprise customer asks before deploying AI: "How do I make sure it only does what I want it to do?"

### Why Control Fabric Is a Strategic Differentiator

Most AI platforms give organisations an on/off switch. DreamTeam gives them a control panel.

The Control Fabric means that DreamTeam is not a platform you deploy and hope works correctly — it is a platform you configure with precision and then trust because you set the rules. This is the fundamental difference between an AI toy and an enterprise Digital Workforce Platform.

**Control Fabric gives Organisations complete control over:**
- **Data Access** — Which Digital Employees can access which Connectors and which fields within those Connectors.
- **Knowledge Scope** — Which Knowledge Collections each Digital Employee may read, cite, or reason from (Trusted vs Restricted vs No Access).
- **Action Rules** — Which Actions are automatically allowed, which require Approval, and which are blocked entirely for each Digital Employee and Capability.
- **Workflow Governance** — Which Workflows may run autonomously and which require human sign-off before execution.
- **AI Behaviour** — Confidence thresholds, safety levels, output constraints, and escalation triggers.
- **Human Approval Gates** — Precisely where and when a human must be in the loop.
- **Data Residency** — Where data may be stored and processed (critical for regulated industries and multinational Organisations).
- **Trust Boundaries** — Who can see what, who can do what, and under what conditions.

### Responsibilities
- Enforce data access permissions for every Digital Employee.
- Enforce Knowledge Scope for every Digital Employee.
- Evaluate every proposed Action against Action Rules before execution.
- Apply Policies from the Organisation, Department, and Workspace levels.
- Generate an Audit Trail entry for every permission evaluation — even those that result in "allow."
- Prevent any execution that would violate a defined constraint.

### Relationships
- The Control Fabric governs the Workforce Engine's execution of every Capability.
- The Control Fabric is configured by Organisation administrators.
- The Control Fabric reads Policies and enforces them at the execution boundary.
- The Control Fabric generates Events that feed the Audit Trail and Compliance reporting.

### What Control Fabric Must Never Do
The Control Fabric must never silently allow a rule violation. Every denied action must be logged. The Control Fabric must never be configurable in ways that allow a Digital Employee to bypass its own access rules.

### Customer Visibility
Admin-facing at the configuration level; customer-facing in effect (customers experience a Digital Workforce that behaves consistently, correctly, and safely).

---

## 31. Model Provider

**[Intelligence]** | Admin-facing

### Definition
A Model Provider is an external AI model service that the Intelligence Service uses to perform language generation, reasoning, and classification tasks. Examples: Anthropic (Claude), OpenAI (GPT), Google (Gemini), AWS (Amazon Nova). Model Providers are **replaceable**. The platform must not depend on any single provider.

### Purpose
Model Providers are the computational intelligence substrate. They are a commodity input to the platform, not a distinguishing feature of it. DreamTeam's value is in its domain model, its Control Fabric, its Knowledge Platform, and its Digital Employee personas — not in which AI model is running underneath.

### Responsibilities
- Accept prompts and return completions (kept internal to the Intelligence Service).
- Report token usage for billing and monitoring.
- Respect rate limits and SLAs.

### What Model Provider Must Never Own
Model Providers must never be exposed to customers as a feature or selling point. Customers should not need to choose, understand, or manage Model Providers. Provider selection is an administrative and operational decision, not a product decision.

### Relationships
- Model Providers are used exclusively by the Intelligence Service.
- Model Provider configuration belongs to the Control Fabric (tenant-level model selection and BYOK).

### Customer Visibility
Admin-facing (provider selection, BYOK). Engineering-facing (model configuration). Never customer-facing.

---

## 32. Intelligence Service

**[Intelligence]** | Internal

### Definition
The Intelligence Service is the internal abstraction layer through which all AI model interactions pass. It manages provider selection, prompt construction, model invocation, response parsing, confidence scoring, safety filtering, fallback routing, and cost tracking. No other layer in the platform may call a Model Provider directly.

### Purpose
The Intelligence Service ensures that the platform is genuinely provider-agnostic. When Anthropic releases a better model, or when OpenAI changes its pricing, or when a customer wants to use their own enterprise Azure deployment, those changes happen inside the Intelligence Service — nothing else in the platform changes.

### Critical Principle
A Capability should never know which AI model executes it. A Digital Employee should never know which Model Provider is being used. The Intelligence Service exists precisely to enforce this separation.

### Customer Visibility
Internal. Customers see its effects (quality, confidence, speed) but never the service itself.

---

## 33. Insight

**[Performance]** | Customer-facing / Admin-facing

### Definition
An Insight is a meaningful, actionable observation derived from platform Events, Metrics, and historical patterns. An Insight goes beyond reporting what happened — it explains why it matters and what the Organisation should consider doing about it. Examples: "Customer escalation rate has increased 18% this week — your Knowledge Hub has a gap in refund policy articles." "The Lead Qualification Capability is performing 34% above industry benchmark."

### Purpose
Insights transform raw platform data into business intelligence. They close the loop between Digital Workforce activity and business decision-making.

### Relationships
- Insights are derived from aggregated Events and Metrics.
- Insights may generate Recommendations.
- Insights are surfaced in Dashboards and reports.
- Insights belong to a Workspace and time period.

---

## 34. Recommendation

**[Performance]** | Customer-facing / Admin-facing

### Definition
A Recommendation is a platform-generated suggestion for how the Organisation should change its Digital Workforce configuration to improve Business Outcomes. A Recommendation is always grounded in evidence — an Insight that identified a gap or opportunity.

### Examples
- "Add an article covering VAT exemption queries to reduce the 23% escalation rate on billing questions."
- "Enable the Lead Research Capability for your Sales DE — accounts touched by this capability close 31% faster."
- "Lower the confidence threshold for the HR Onboarding Capability from 0.75 to 0.60 — current threshold is blocking 40% of valid requests."

### Relationships
- Recommendations are generated from Insights.
- Recommendations may suggest changes to Capabilities, Knowledge, Control Fabric rules, or Digital Employee configuration.
- Accepted Recommendations generate Events.

---

## 35. Metric

**[Performance]** | Admin-facing

### Definition
A Metric is a quantified measurement of Digital Workforce performance, activity, or business impact. Metrics are derived from Events and aggregated over time. Examples: Capability execution volume, average confidence score, escalation rate, approval rate, average handle time, knowledge retrieval accuracy, estimated hours saved, cost per resolution.

### Purpose
Metrics make the Digital Workforce legible as a business investment. They allow Organisations to answer: "What is our Digital Workforce doing? How well is it performing? What is it worth?"

### What a Metric Must Never Be
A Metric must never be surfaced as a raw technical measurement (e.g. "tokens consumed per request"). Metrics must always be expressed in business terms. The platform internally tracks technical metrics but always translates them to business-meaningful representations for customer-facing surfaces.

---

## 36. Business Outcome

**[Performance]** | Customer-facing

### Definition
A Business Outcome is a measurable improvement in the Organisation's business performance attributable to the Digital Workforce. Examples: reduction in average ticket resolution time, increase in lead conversion rate, decrease in billing escalations, hours of human work saved, cost per customer interaction reduced.

### Purpose
Business Outcome is the ultimate unit of value for DreamTeam. The platform does not sell AI. It does not sell automation. It sells better business results — delivered by a Digital Workforce that is trustworthy, measurable, and continuously improving.

### The Fundamental Principle
DreamTeam optimises Business Outcomes — not AI usage. This means the platform should always be asking "did this make the business better?" not "how many AI calls did we make?" Every Capability, Metric, Insight, and Recommendation should ultimately trace back to a Business Outcome.

### Relationships
- Business Outcomes are the aggregate of many Metrics over time.
- Recommendations aim to improve Business Outcomes.
- Organisations configure their Workspaces and Capabilities in pursuit of Business Outcomes.
- Business Outcomes are reported at the Organisation level.

---

## 37. Marketplace

**[Platform]** | Customer-facing

### Definition
The Marketplace is the platform's library of pre-built Capabilities, Digital Employee templates, Workflow templates, Connector packages, and industry-specific Digital Workforce configurations that Organisations can adopt and customise.

### Purpose
The Marketplace reduces time-to-value. Instead of building a Support DE from scratch, an Organisation adopts the Support Specialist Digital Employee Pack, which includes pre-configured Capabilities, Responsibilities, Knowledge templates, and Control Fabric defaults. The Marketplace makes DreamTeam accessible to organisations without deep AI expertise.

### Relationships
- Marketplace items are published by DreamTeam or certified partners.
- Marketplace items are adopted into a Tenant and customised.
- Marketplace items reference Templates.

---

## 38. Template

**[Platform]** | Admin-facing

### Definition
A Template is a reusable, pre-configured starting point for a Digital Employee, Capability, Workflow, or Knowledge Collection. Templates encode best practices and industry standards. They are customisable but provide a validated foundation.

### Purpose
Templates accelerate configuration and reduce the risk of incorrect setup. They embed institutional knowledge — what a good Support Specialist Capability looks like, what a compliant Finance Workflow requires — into the platform itself.

---

## 39. Audit Trail

**[Platform]** | Admin-facing / Compliance

### Definition
The Audit Trail is the permanent, immutable, chronological record of all significant actions, decisions, and events within a Tenant. It records who did what, when, to what, with what outcome, and under what Policy.

### Purpose
The Audit Trail is the foundation of enterprise trust. It allows Organisations to answer compliance questions, investigate incidents, prove governance, and demonstrate accountability. Without the Audit Trail, a Digital Workforce is not enterprise-ready — regardless of its capabilities.

### Responsibilities
- Record every auditable event with a complete context snapshot.
- Be immutable — no event may be modified or deleted.
- Be searchable, filterable, and exportable.
- Support compliance reporting and regulatory queries.

### What Audit Trail Must Never Lack
Every Control Fabric decision (allow, deny, approve), every Capability execution, every Handoff, every Escalation, every Approval decision, and every Policy trigger must appear in the Audit Trail. Gaps in the Audit Trail are compliance failures.

---

# Conceptual Relationships

## Ownership Hierarchy

The following represents how concepts are *owned* — parent concepts contain and govern child concepts.

```
Organisation
└── Tenant (platform representation of the Organisation)
    ├── Department(s)
    ├── User(s)
    ├── Policy(ies)
    ├── Control Fabric
    ├── Knowledge Collection(s)
    │   └── Knowledge (Items)
    ├── Connector(s)
    └── Workspace(s)
        ├── Channel(s)
        ├── Capability(ies)
        │   └── Integration(s)
        ├── Workflow(s)
        └── Digital Workforce
            └── Digital Employee(s)
                └── Responsibility(ies)
```

## Execution Dependency Graph

The following represents how concepts *depend on each other at runtime* — this is separate from ownership.

```
Inbound Event / User Request / Scheduled Trigger
        ↓
    Channel
        ↓
    Conversation  ←──────────────────────────────────────────────┐
        ↓                                                         │
    Capability (selected based on intent)                         │
        ↓                                                         │
  Control Fabric (evaluates Policy, Permissions, Action Rules)    │
        ↓ (if permitted)                                          │
  Workforce Engine (creates Execution Plan)                       │
        ↓                                                         │
    Agent(s) coordination                                         │
    ├── Intelligence Service → Model Provider                     │
    ├── Knowledge Platform → Knowledge Collection                 │
    ├── Tool(s) → Connector(s) → External Systems                 │
    └── Memory (Working Memory ← read/write)                      │
        ↓                                                         │
    Output / Action                                               │
        ↓                                                         │
  Approval required? ──yes──→ Approval Queue → Human Decision     │
        ↓ (auto or approved)                                      │
    Audit Trail ← Event generated                                 │
        ↓                                                         │
    Conversation continues or resolves ─────────────────────────→─┘
        ↓
    Escalation or Handoff (if triggered)
        ↓
    Metrics ← aggregated from Events
        ↓
    Insights ← derived from Metrics
        ↓
    Recommendations ← generated from Insights
        ↓
    Business Outcomes ← improved through Recommendations
```

---

# Permanent Design Rules

These rules must hold across all future implementations, APIs, database designs, and product decisions. Any proposed change that violates a rule requires explicit architectural review and amendment of this document.

**On Separation of Concerns**

1. A Capability must never know which AI model executes it. AI models are runtime configuration, not domain definition.
2. A Digital Employee must never know the internal structure of the Agents that serve it. The Workforce Engine is the sole coordinator.
3. Knowledge must never be aware of how it is retrieved or which model consumes it. Knowledge is content; retrieval is infrastructure.
4. Policies are enforced by the Control Fabric — never by individual Capabilities, Workflows, or Agents enforcing their own rules.
5. A Channel must never contain business logic. It is an intake surface.
6. The Audit Trail must never be owned by any domain concept. It is a platform-level cross-cutting concern.

**On Stability of Concepts**

7. Capabilities represent business intent — they remain stable while implementations evolve. Do not redefine a Capability every time the underlying AI approach changes.
8. Digital Employee personas are stable — their names, Responsibilities, and identities should not change every time a new model is deployed.
9. Business Outcomes are the constant. Metrics, Insights, and Recommendations are the variables. Do not let technical metrics crowd out Business Outcome measurement.

**On Governance**

10. Organisations own their Policies. DreamTeam may suggest Policy templates; it may never impose Policies on an Organisation's tenant without consent.
11. The Control Fabric must evaluate every Action before execution — there must be no paths through the Workforce Engine that bypass Control Fabric evaluation.
12. Every Control Fabric decision — allow, deny, or approval-required — must generate an Audit Trail entry. Silent decisions are governance failures.
13. No cross-tenant data access is ever permitted. Tenant isolation is an absolute constraint, not a default configuration.

**On Customer Experience**

14. Customers interact with Digital Employees — not Agents, not prompts, not AI models. Every customer-facing surface must honour this abstraction.
15. Capabilities are what customers buy, enable, and measure — not features, not API calls, not AI completions.
16. Escalation and Handoff are first-class features, not fallback states. A Digital Employee that escalates well is more trustworthy than one that never escalates.
17. Approval is a trust mechanism, not a limitation. The ability to require human approval before consequential actions is a feature that enterprise customers pay for.

**On Intelligence**

18. AI models are replaceable. No business logic may depend on the characteristics of a specific model.
19. The Intelligence Service is the only component permitted to call Model Providers. All other layers must go through this abstraction.
20. Confidence scores are business signals, not technical metrics. They inform Approval routing, Escalation decisions, and performance reporting.

**On Data**

21. Workflows govern behaviour, not data. Data is owned by the Tenant; Workflows orchestrate what the Digital Workforce does with it.
22. Memory is scoped — Working Memory is per-execution, Conversation Memory is per-conversation, Organisational Memory is per-tenant. Cross-scope memory access is never permitted.
23. Knowledge is an enterprise asset. Its quality, coverage, and currency are the Organisation's responsibility. The platform provides the tools; the Organisation provides the content.

---

# Guiding Principles

These are the immutable truths of the DreamTeam platform. They are not engineering principles. They are not product principles. They are the philosophical commitments that define what DreamTeam is.

**1. Customers interact with Digital Employees — not with AI.**
The technical sophistication of the platform is invisible to the end customer. They hire a Digital Employee. They trust a Digital Employee. They measure a Digital Employee. The AI is the engine; the Digital Employee is the colleague.

**2. Business Capabilities remain stable while implementations evolve.**
Technology changes. Business intent does not. "Qualify a Lead" meant something in 2020 and it will mean the same thing in 2030 — even if the AI models, data sources, and orchestration approaches are completely different.

**3. Knowledge is an enterprise asset — not a platform configuration.**
The Organisation's knowledge is the source of the Digital Workforce's competence. It must be owned, governed, maintained, and curated by the Organisation. The platform is the vehicle; the knowledge is the value.

**4. AI models are interchangeable infrastructure.**
Which AI model runs underneath a Digital Employee is an operational and commercial decision, not a product identity. DreamTeam's value is not "we use Claude" or "we use GPT" — it is the Digital Workforce layer we build on top of those commodities.

**5. Governance is built into every layer, not bolted on.**
The Control Fabric is not an access control list appended to the platform. It is the permission and governance fabric woven through every Capability execution, every Action, and every data access. Governance is not an enterprise add-on; it is the foundation.

**6. Organisations retain complete control over their Digital Workforce.**
Every permission, every approval rule, every knowledge boundary, every escalation threshold is configurable by the Organisation. DreamTeam provides defaults; the Organisation decides.

**7. Escalation and human oversight are designed behaviours, not failures.**
A Digital Workforce that knows when to stop and ask is more trustworthy than one that always attempts to proceed. The platform is designed to make escalation and human approval seamless, not exceptional.

**8. DreamTeam optimises Business Outcomes — not AI usage.**
The platform's success is measured in business results: faster resolutions, higher conversion rates, reduced cost per interaction, better compliance. Never in tokens consumed, requests processed, or AI model versions deployed.

**9. Trust is earned through transparency and auditability.**
The Audit Trail is not a compliance checkbox — it is the foundation of the trust relationship between the platform and the Organisation. Every AI action must be attributable, explainable, and auditable.

**10. The Digital Workforce should improve over time.**
A Digital Employee that performs the same way in year three as it did in year one is underperforming. Insights, Recommendations, Knowledge improvements, and Capability refinements should make the Digital Workforce measurably better over time — not statically good.

**11. Simplicity for the customer; sophistication in the platform.**
Customers should experience a simple, intuitive Digital Workforce that just works. The sophistication — multi-agent coordination, vector retrieval, confidence scoring, policy enforcement — is the platform's problem to solve, not the customer's.

**12. DreamTeam is a workforce platform, not an AI application.**
This is the most important principle. Salesforce is not a database. Workday is not a spreadsheet. DreamTeam is not a chatbot. We build Digital Workforces that operate inside real Organisations, with real governance, real accountability, and real business outcomes. The AI is the engine. The workforce is the product.

---

*This document was authored as the permanent conceptual foundation of the DreamTeam Digital Workforce Platform. It should be reviewed when a new domain concept is proposed for addition, but its existing concepts and principles should not be amended lightly. Changes to this document have platform-wide implications.*

*Version 1.0 — The concepts defined here are intended to remain stable for the next decade.*
