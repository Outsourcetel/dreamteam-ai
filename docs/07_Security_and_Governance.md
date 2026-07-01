# 07 — Security and Governance

**DreamTeam Digital Workforce Platform**
Version 1.0 | Permanent Foundational Reference

---

## Purpose of This Document

This document defines the permanent trust framework for the DreamTeam platform.

It covers identity, access, data, AI governance, privacy, compliance, audit, and the organizational controls that enterprise customers require before trusting any platform with their workforce, their knowledge, and their critical business operations.

It is not an implementation guide. It does not specify database schemas, API endpoints, or infrastructure configurations. It defines principles, rules, and boundaries that must remain valid regardless of cloud provider, AI model, programming language, database technology, or deployment architecture.

Every engineering decision, product feature, integration, and AI behaviour must be evaluated against this document before it is built.

**This document defines DreamTeam's most valuable feature: trustworthiness.**

---

## Relationship to Other Documents

This document builds on:

- **05_Core_Domain_Model.md** — Uses its permanent terminology. Concepts such as Audit Trail, Control Fabric, Execution Plan, Handoff, Channel, Digital Employee, Capability, Responsibility, and Connector are defined there and used here without redefinition.
- **06_Engineering_Principles_and_Standards.md** — Extends its security engineering rules with governance, compliance, and AI-specific controls.

When this document and any other document conflict, this document takes precedence on security, governance, and privacy matters.

---

## 1. Security Philosophy

### 1.1 The Foundational Belief

DreamTeam exists to give organizations the power of an AI-augmented workforce without surrendering control of their data, their decisions, or their identity as an organization. Every architectural decision, product feature, and deployment choice must be evaluated against one question: **does this preserve the customer's ability to remain in control?**

Security is not a feature set. It is not a compliance checkbox. It is the permanent operating condition of the platform.

### 1.2 Permanent Security Principles

**Trust is earned, not assumed.**
No identity, system, or service is trusted by default. Every request must prove who it is, what it is authorized to do, and whether the context of the request is consistent with its claimed identity and role.

**Least privilege by default.**
Every user, Digital Employee, service account, and API identity starts with no permissions. Access is granted explicitly, narrowly, and only for the scope required. Permissions are never inherited from convenience. They are never broader than the task requires.

**Security before convenience.**
When security and user experience conflict, security wins. Friction that protects customer data is acceptable. Convenience that weakens governance is not. The platform should work to make secure behaviour the easy path — but it must never sacrifice the secure path in pursuit of the easy one.

**Every action is attributable.**
Every action taken on the platform — by a human, a Digital Employee, or the platform itself — can be traced to an identity, a time, a context, and an authorization decision. Anonymous action is not permitted anywhere in the system.

**Every action is auditable.**
Attribution without a record is meaningless. The platform maintains an immutable, tamper-resistant Audit Trail for every action of significance. The Audit Trail is a first-class domain concept, not a logging afterthought.

**Customer data belongs to the customer.**
DreamTeam does not own, claim, or derive commercial value from customer data. Customers retain full ownership of their data, their knowledge, their Digital Employees, their configurations, and their Audit Trails. DreamTeam is a platform, not a data broker.

**AI must remain governable.**
No AI behaviour on this platform operates without governance constraints. Every Digital Employee operates within a defined permission boundary. No model makes an irreversible real-world decision without human authorization at the appropriate level. The platform provides the control surface; the customer decides the controls.

**Human oversight for high-risk decisions.**
The platform is designed with the presumption that humans must remain accountable for decisions with significant financial, legal, reputational, or operational consequences. Automation is a tool. Human accountability is a principle.

**Governance is designed in — not added later.**
Every feature is built with governance instrumentation from the start. Audit hooks, permission checks, approval gates, and policy evaluation are not retrofitted. They are structural.

**Security is a shared responsibility, clearly partitioned.**
DreamTeam secures the platform. Customers secure their configuration, their users, their connectors, and their governance policies. Neither party can fully compensate for failures in the other's domain. The boundary of responsibility is explicit, documented, and contractually defined.

**Fail secure.**
When the platform encounters an ambiguous state, an unexpected condition, or an error in authorization logic, it denies access and alerts. It never defaults to permitting action under uncertainty.

**Defense in depth.**
No single control is assumed to be sufficient. Every sensitive operation is protected by multiple independent layers of security: authentication, authorization, policy evaluation, rate limiting, anomaly detection, and audit. The failure of any single layer does not compromise the system.

**Reduction of blast radius.**
The platform is designed to limit the damage any single compromised identity, connector, or Digital Employee can cause. Permissions are scoped. Actions are bounded. Isolation is enforced. A breach in one tenant, one Digital Employee, or one connector must not propagate.

---

## 2. Identity and Access Management

### 2.1 Authentication Standards

Authentication is the foundation of all trust on the platform. The following standards apply permanently:

**Supported authentication methods (current):**
- Username and password with enforced complexity and breach detection
- Time-based one-time passwords (TOTP) as a second factor
- Email magic links for low-risk session initiation

**Future-ready authentication:**
- SAML 2.0 for enterprise SSO
- OpenID Connect (OIDC) for federated identity
- SCIM for identity lifecycle management and provisioning
- Passkeys and FIDO2 for passwordless authentication
- Hardware security keys (WebAuthn)
- Certificate-based authentication for service-to-service communication

**Multi-factor authentication (MFA):**
MFA is required for all human users in production environments. It is enforced at the platform level and cannot be disabled by tenant administrators except through an explicit policy override that itself requires platform-level approval.

**Session management:**
- Sessions carry a maximum lifetime appropriate to their risk level
- Privileged sessions (administrative access, Break-glass accounts) carry shorter lifetimes
- Sessions are invalidated immediately on role change, permission revocation, or suspicious activity
- Sessions are cryptographically signed and cannot be tampered with or replicated
- Concurrent session limits are configurable per organization

### 2.2 Authorization Architecture

**Role-Based Access Control (RBAC):**
Every user holds one or more roles. Roles define the set of permissions a user may exercise. Roles are defined at the platform level (DreamTeam-defined) and at the tenant level (organization-defined). Custom tenant roles inherit from a defined permission vocabulary — they cannot invent new permission primitives.

Platform-defined roles include:
- `platform_super_admin` — DreamTeam staff only. Full platform visibility. Scoped to internal operations.
- `platform_support` — Read access to tenant environments for support. Requires explicit customer authorization per session.
- `tenant_owner` — Full control of a single tenant. Billing, users, connectors, governance policy.
- `tenant_admin` — Administrative control without billing access.
- `tenant_member` — Standard operational access. Scoped by department and role assignment.
- `tenant_viewer` — Read-only access. Cannot trigger actions.
- `digital_employee_service` — Non-human identity used by Digital Employees at runtime.
- `connector_service` — Non-human identity used by active Connectors.

**Attribute-Based Access Control (ABAC) — future readiness:**
The platform's authorization model is designed to accommodate attribute-based evaluation as a complement to RBAC. Attributes such as department, cost centre, geographic region, data sensitivity classification, time of day, and device trust state may all become inputs to authorization decisions without requiring architectural changes.

### 2.3 Organizational and Departmental Isolation

Access boundaries are enforced at multiple levels:

- **Tenant boundary** — Complete isolation between organizations. No data, configuration, or identity crosses a tenant boundary.
- **Department boundary** — Within a tenant, departments may be configured as isolated silos. A user in Sales cannot access HR knowledge, workflows, or Digital Employee activity unless explicit cross-department access is granted.
- **Digital Employee boundary** — Each Digital Employee operates with a distinct service identity. One Digital Employee cannot access another's memory, Connector tokens, or Execution Plans unless explicitly permitted.

### 2.4 Temporary and Just-in-Time Access

Permanent elevated permissions are a security anti-pattern. The platform supports:

- **Time-bounded role grants** — Elevated access that expires automatically without manual revocation
- **Just-in-time (JIT) access** — Access granted for the duration of a specific task or approval workflow
- **Temporary connector permissions** — A Digital Employee may be granted access to a Connector for a single Capability execution, then automatically revoked
- **Access request workflows** — Users may request elevated permissions through a governed approval process that generates an Audit Trail entry

### 2.5 Service Accounts and API Identities

All non-human identities are first-class citizens of the IAM model.

- Every API integration receives a dedicated service identity — never a shared credential
- Service identities carry the minimum permissions required for their function
- Service identity tokens have defined expiry and rotation schedules
- Service identities are scoped to the Connector or integration they represent — they cannot be reused across integrations
- Service identity activity is logged with the same fidelity as human activity

### 2.6 Delegated Administration

Tenant administrators may delegate specific administrative functions to nominated team members without granting full administrative access. Delegations are:

- Explicit (not implied by role inheritance)
- Scoped (specific capabilities only, not full admin authority)
- Time-bounded (optional, with automatic expiry)
- Audited (every delegation grant and use is recorded in the Audit Trail)

### 2.7 Break-Glass Accounts

For emergency operational access when normal authentication paths are unavailable:

- Break-glass accounts exist at both platform and tenant levels
- Their credentials are stored in a dedicated, separately secured vault
- Every use of a break-glass account triggers an immediate alert to the security team and the tenant owner
- All actions taken under a break-glass session are recorded in the Audit Trail with elevated detail
- Break-glass sessions have a strict maximum duration
- Post-incident review is mandatory after every break-glass use

---

## 3. Multi-Tenant Security

### 3.1 The Absolute Isolation Rule

Tenants are completely isolated from one another. This is not a configuration option — it is a structural guarantee. No action by any user, Digital Employee, administrator, or platform operator can cause one tenant's data to become visible to another tenant.

The following must never cross a tenant boundary under any circumstances:

- Knowledge Collections and their contents
- Conversation history
- Audit Trails and Logs
- Connector configurations and credentials
- Digital Employee definitions, memory, and Execution Plans
- Analytics and performance metrics
- Workflow definitions
- Approval policies
- User identities and profiles
- Environment variables and secrets

### 3.2 Isolation Layers

Isolation is enforced at every layer of the stack independently:

- **Data layer** — Every database record carries a `tenant_id`. Every query is automatically scoped to the authenticated tenant. Queries without a tenant scope are rejected at the query layer, not the application layer.
- **API layer** — Every API endpoint validates tenant membership before processing any request. Tenant context is derived from the authenticated identity, never from a caller-supplied parameter.
- **Service layer** — Internal services do not accept cross-tenant requests. Service-to-service communication carries cryptographically verifiable tenant context.
- **Storage layer** — Object storage is partitioned by tenant. Storage access policies enforce tenant boundaries at the infrastructure level.
- **Search and retrieval layer** — Knowledge retrieval, semantic search, and vector queries are always scoped to the authenticated tenant's data. A retrieval operation can never return results from another tenant's knowledge.
- **Cache layer** — Cached responses are keyed by tenant. Cache entries from one tenant cannot be served to another.
- **AI retrieval layer** — Context assembled for any AI model execution is scoped to the tenant and the specific Digital Employee's authorized Knowledge Collections. The assembly process cannot include data outside these boundaries.

### 3.3 Context Window as a Security Boundary

Data that enters an AI model's context window must be held to the same authorization standard as data accessed directly by a human user.

This rule is unconditional: if a user is not authorized to read a document directly, that document may not enter any model context window during a session associated with that user — regardless of how the retrieval was triggered, how the Knowledge Collection is configured, or what the Digital Employee's base permissions allow.

Authorization is evaluated at the point of retrieval, before data enters the context assembly pipeline. The pipeline does not perform its own secondary authorization check — the upstream retrieval layer is the enforcement point, and it must be correct.

Failure to enforce this rule creates a class of data exposure attack in which a user infers restricted information through model responses without ever accessing the restricted data directly.

### 3.4 Platform Operator Access

DreamTeam platform operators (employees) must never access tenant data for operational purposes without:

- Explicit customer authorization via a governed approval flow
- A time-bounded support session with a defined scope
- Full logging of all actions taken during the session in both the platform's internal audit system and the customer's Audit Trail
- Automatic session expiry at the end of the authorized window

This applies even to DreamTeam engineers with infrastructure-level access. Technical access capability does not constitute authorization.

---

## 4. AI Governance

### 4.1 The Distinction Between Security and Governance

Security asks: **is this action permitted?**
Governance asks: **is this action appropriate?**

These are different questions requiring different controls. A Digital Employee may be technically authorized to send an email (security: permission exists) but governance may require that emails of a certain type require human review before sending (governance: policy evaluation). Both checks must pass before the action proceeds.

Security is enforced by the IAM system and the Control Fabric's permission layer.
Governance is enforced by the Control Fabric's policy evaluation layer.

### 4.2 Digital Employee Governance Boundaries

Every Digital Employee operates within a governance envelope that the organization defines. This envelope specifies:

- **Allowed model providers** — Which AI providers (Anthropic, OpenAI, Google, Azure, AWS) the Digital Employee may route requests to
- **Allowed models** — Which specific models within each provider are permitted
- **Knowledge scope** — Which Knowledge Collections the Digital Employee may retrieve from, and at what trust level
- **Connector permissions** — Which Connectors the Digital Employee may invoke, and with what action scope (read-only, read-write, create, delete)
- **Memory scope** — What the Digital Employee may write to Working, Conversation, and Organisational memory
- **Action authority** — Which Capabilities the Digital Employee may execute autonomously vs. which require approval
- **Spend authority** — Maximum financial value of actions the Digital Employee may initiate without approval
- **Communication permissions** — Whether the Digital Employee may send communications (email, messages, notifications) autonomously

### 4.3 Model Provider Governance

Organizations retain the right to restrict or prohibit specific AI model providers entirely. This is a binding governance control, not a preference setting.

Reasons an organization may restrict a provider:
- Data residency obligations (model provider does not operate in required jurisdiction)
- Contractual restrictions prohibiting data sharing with specific third parties
- Internal AI ethics policies
- Regulatory requirements limiting which AI systems may process certain data categories

The Intelligence Service (as defined in the domain model) is the only component that calls Model Providers. This architectural constraint means that model provider restrictions need only be enforced in one place. The restriction propagates automatically to all Digital Employees.

### 4.4 Prompt Governance

Prompts are an internal configuration mechanism, not a customer-facing concept (per the domain model). However, prompts represent a significant governance surface for two distinct reasons:

**As an attack vector (security):** Prompts can be manipulated through adversarial input — a technique known as prompt injection. The platform must treat all user-supplied content as untrusted input, structurally separating it from system instructions. No user input should be capable of overriding a Digital Employee's governance constraints, its Responsibility definition, or its allowed action scope.

**As a governance asset:** The instructions that define a Digital Employee's behaviour are organizational assets that must be versioned, approved, and audited. Changes to the instruction set that governs a Digital Employee constitute a material change to the Digital Employee's behaviour and must follow the same change control process as any other governance policy change.

### 4.5 Memory Governance

Memory is scoped by type and governed by policy:

- **Working memory** — Transient. Cleared at the end of an Execution Plan. No persistence, no governance policy required.
- **Conversation memory** — Retained for the duration of a conversation or a configured period. Subject to data retention policies. Cannot cross between Digital Employees without explicit permission.
- **Organisational memory** — Persistent knowledge derived from activity. Governed as an organizational asset. Requires explicit policy for what may be written, who may read it, and how long it is retained.

No Digital Employee may write to Organisational memory without an explicit write permission in its governance envelope.

### 4.6 Confidence and Uncertainty Governance

The platform defines minimum confidence thresholds for autonomous AI action. These thresholds are configurable per Capability, per Digital Employee, and per action type.

When a Digital Employee's confidence in its decision falls below the configured threshold, it must escalate rather than proceed. It may not take autonomous action under conditions of significant uncertainty when those conditions relate to consequential decisions.

Escalation to a human is not a failure state. It is the correct outcome when confidence governance triggers.

### 4.7 Hallucination Management

The platform does not assume AI model outputs are factually accurate. Governance controls for hallucination risk include:

- Knowledge-grounded responses: where accuracy is required, the Digital Employee retrieves from approved Knowledge Collections rather than relying on model-internal knowledge
- Source citation: where claims are made from retrieved knowledge, the source is recorded in the Audit Trail
- Human review gates for high-stakes outputs: outputs that will inform significant decisions, communications, or financial actions require human review before use
- Confidence scoring on retrieved context: retrieval results carry a relevance score, and low-confidence retrieval triggers escalation rather than generation

### 4.8 Autonomous Action Limits

The platform enforces hard limits on autonomous AI action. These limits exist at multiple levels:

- **Platform defaults** — Conservative limits applied to all Digital Employees regardless of organizational configuration
- **Organizational policy** — Organizations may configure limits within the range permitted by platform defaults
- **Digital Employee configuration** — Limits applied to a specific Digital Employee within the range permitted by organizational policy
- **Capability configuration** — Limits applied to a specific Capability execution

No configuration at a lower level may exceed the limits set at a higher level. This hierarchy is enforced, not advisory.

---

## 5. Control Fabric Governance

### 5.1 Role of the Control Fabric

The Control Fabric is DreamTeam's strategic governance enforcement layer. It sits between every request and every action on the platform. Nothing that a Digital Employee does — retrieves, calls, communicates, writes, or decides — bypasses the Control Fabric.

Its role is to answer four questions before any action proceeds:

1. **Is this identity authorized to perform this action?** (IAM enforcement)
2. **Does organizational policy permit this action in this context?** (Policy evaluation)
3. **Does this action require human approval before proceeding?** (Approval gate)
4. **Has this action been recorded for future accountability?** (Audit generation)

All four questions must be answered affirmatively before any consequential action proceeds.

### 5.2 What the Control Fabric Governs

The Control Fabric evaluates and enforces governance over:

- **Data access** — Which Knowledge Collections, Connectors, and data sources a Digital Employee may access for a given Capability execution
- **Knowledge access** — Which knowledge may be retrieved, at what trust level, and for what purpose
- **Memory operations** — What may be read from and written to each memory scope
- **Workflow execution** — Which Workflows may be triggered, by whom, and under what conditions
- **Connector invocations** — Which Connectors may be called, with what action scope, and up to what frequency and volume
- **AI model routing** — Which model providers and specific models may be used for each execution context
- **Human approval gates** — Which actions must pause for human authorization before proceeding
- **Automation limits** — Maximum spend, volume, frequency, and reach of autonomous Digital Employee action
- **Data retention enforcement** — Ensuring data is not retained beyond its configured policy period
- **Data residency enforcement** — Ensuring data processing respects geographic constraints

### 5.3 Policy Engine

The Policy Engine is the decision-making component within the Control Fabric. It is the runtime evaluation layer that converts organizational governance configuration into binding decisions.

**What the Policy Engine evaluates:**

Every Control Fabric decision is the output of a policy evaluation. The inputs to that evaluation include:

- The identity requesting the action (human or Digital Employee)
- The action being requested (what Capability, Connector, Knowledge Collection, or operation)
- The organizational context (which tenant, which department, which time of day)
- The data classification of the assets involved
- The risk profile of the action (read vs. write, reversible vs. irreversible, financial value if applicable)
- The regulatory context (jurisdiction, data category, applicable compliance framework)
- The current approval state (is an approval already on record for this action?)

**Policy rule types the engine supports:**

- **Permission rules** — "Digital Employee X may invoke Connector Y with read-only scope"
- **Approval rules** — "Any action with a financial value above $500 requires manager approval"
- **Restriction rules** — "No Digital Employee may access medical records without a logged clinical justification"
- **Time-based rules** — "Connector Z may only be invoked during business hours in the tenant's configured timezone"
- **Conditional rules** — "Approval is required if the action involves a customer account with overdue payments"
- **Prohibition rules** — "Model provider P is prohibited for all Digital Employees in this organization"
- **Data residency rules** — "Knowledge Collections labelled EU-GDPR may not be processed by model providers outside the European Economic Area"

**Policy evaluation is atomic.**
The Policy Engine evaluates the full set of applicable rules for each action in a single decision. It does not evaluate rules incrementally or allow partial approvals. A policy evaluation produces a single outcome: permit, require approval, or deny.

**Every Policy Engine decision generates an Audit Trail entry.**
This is unconditional. Every evaluation — whether it permits, requires approval, or denies — is recorded. Silent permits are not possible. Every action that proceeds through the Control Fabric has a corresponding audit record.

**Policy is versioned.**
Changes to organizational policy are versioned and timestamped. The version of the policy active at the time of an action is recorded in the Audit Trail. This allows retrospective compliance review to reconstruct what rules were in effect at any historical point.

### 5.4 Everything Is Configurable — Within Hierarchy

The Control Fabric is configurable by organizations within the boundaries set by DreamTeam. This hierarchy is permanent:

- DreamTeam sets **platform-level limits** that no organization may exceed
- Organizations set **organizational-level policy** within those limits
- Tenant administrators configure **department-level rules** within organizational policy
- Digital Employee governance envelopes are configured within department-level rules

No configuration at any level may exceed the constraints imposed by the level above it. This hierarchy cannot be overridden, delegated around, or technically circumvented.

---

## 6. Data Governance

### 6.1 Data Ownership

Customer data belongs to the customer. This principle is permanent and non-negotiable.

DreamTeam is a processor of customer data, not a controller. Customers determine what data is collected, how it is used, how long it is retained, and when it is deleted. DreamTeam provides the platform and the controls; the customer exercises the authority.

### 6.2 Data Classification

The platform supports classification labels that organizations apply to their data assets. Classification governs what controls apply to each asset.

Recommended classification tiers (organizations may customize):

| Tier | Description | Examples |
|------|-------------|---------|
| **Public** | May be shared externally without restriction | Marketing materials, public documentation |
| **Internal** | For organizational use only | General operational documents |
| **Confidential** | Restricted to authorized personnel | HR records, contracts, financial reports |
| **Restricted** | Tightly controlled, highly sensitive | Medical records, legal strategy, executive communications |
| **Regulated** | Subject to external regulatory requirements | PII, PHI, payment card data |

Classification is applied at the Knowledge Collection level and at the individual document level where documents warrant higher classification than their collection. The higher classification always takes precedence.

### 6.3 Data Retention

Every data category has a defined retention policy. The platform enforces retention at the storage layer — it is not left to application-level cleanup.

- Retention policies are configurable by tenant within platform-defined limits
- Data is not retained beyond its configured retention period without an explicit legal hold
- Legal holds are a first-class operational concept: they suspend automatic deletion pending regulatory or legal requirements, are themselves audited, and must be explicitly lifted
- Retention policies are applied consistently regardless of where data lives (primary storage, backup, cache, audit logs)

### 6.4 Data Deletion

The right to deletion is supported at multiple levels:

- **Record deletion** — Specific data records may be deleted on request, subject to legal holds and regulatory requirements
- **Conversation deletion** — Conversation history may be deleted by authorized users within the configured retention window
- **Tenant offboarding** — When a customer ends their relationship with DreamTeam, all tenant data is deleted according to a documented, verifiable process within a defined timeframe
- **Right to erasure (GDPR Article 17)** — The platform supports the structured deletion of a natural person's data across all storage surfaces where technically feasible

Deletion is verifiable. Customers may request a deletion certificate confirming that their data has been removed from all production systems.

### 6.5 Encryption

All data is encrypted at rest and in transit without exception.

- **In transit** — TLS 1.2 minimum; TLS 1.3 preferred. No unencrypted communication between any platform components.
- **At rest** — AES-256 minimum for all stored data, including database records, object storage, backups, and audit logs.
- **Key management** — Encryption keys are managed separately from the data they protect. Key rotation is automated. Key access is audited.
- **Customer-managed keys (future)** — Organizations with the highest security requirements may supply and manage their own encryption keys. This prevents DreamTeam platform operators from being able to decrypt customer data even with infrastructure access.

### 6.6 Data Residency and Sovereignty

Organizations operating under data residency requirements (EU GDPR, Australian Privacy Act, India PDPB, and others) need confidence that their data does not leave defined geographic boundaries.

The platform is designed for multi-region deployment with tenant-level data residency configuration. A tenant configured for EU residency processes and stores all its data within EU infrastructure. Cross-region replication does not occur for tenants with residency constraints unless the specific destination regions are explicitly authorized by the tenant.

Data residency applies to:
- Primary data storage
- Backup and disaster recovery storage
- AI model execution (models and providers must comply with residency constraints)
- Audit log storage
- Search indexes

### 6.7 Data Minimization

The platform collects only the data required for its stated function. This is an architectural principle, not a policy commitment. Features are not built in ways that collect incidental data not required for the feature's purpose. Each data collection decision is justified at design time.

---

## 7. Knowledge Governance

### 7.1 Knowledge as a Governed Organizational Asset

Knowledge Collections are not unstructured file repositories. They are governed organizational assets that directly influence Digital Employee behaviour, customer-facing responses, and business decisions. The governance standards applied to Knowledge must reflect this.

### 7.2 Knowledge Ownership

Every Knowledge Collection has a defined owner. Ownership carries accountability for:

- The accuracy and freshness of the knowledge
- The appropriateness of the knowledge for the Digital Employees it serves
- The classification applied to the knowledge
- The review cycle that keeps the knowledge current

Ownership is not a label — it is an active responsibility. Platform reporting surfaces knowledge that has not been reviewed within its configured cycle to its owner.

### 7.3 Approval and Publishing

Knowledge does not become available to Digital Employees upon upload. The publishing pipeline is:

1. **Draft** — Knowledge is uploaded and visible only to authorized editors
2. **Review** — Knowledge is reviewed for accuracy, appropriateness, and classification
3. **Approved** — An authorized reviewer confirms the knowledge is ready for use
4. **Published** — Knowledge becomes available to authorized Digital Employees
5. **Superseded / Archived** — Replaced knowledge is retired, not deleted; it remains accessible for audit purposes

Digital Employees configured with the `approved_only` knowledge policy must not access knowledge in Draft or Review state. This is a platform enforcement rule, not an application-level advisory.

### 7.4 Versioning

Every knowledge item is versioned. When knowledge is updated:

- The previous version is retained and accessible for audit
- The Audit Trail records when the version change occurred and who approved it
- Digital Employees using the knowledge at the time of the change are not automatically switched to the new version — a configurable propagation policy determines when updated knowledge is active

### 7.5 Trust Levels

Knowledge Sources carry a trust level that governs how a Digital Employee may use them:

| Trust Level | Meaning |
|-------------|---------|
| **Authoritative** | Organization-verified. May be used as the basis for definitive responses and decisions. |
| **Informational** | Useful context. May inform responses but not serve as the sole basis for consequential decisions. |
| **Supplementary** | Background material. Must be used with caution. High-stakes responses should not rely solely on Supplementary knowledge. |
| **Unverified** | Recently ingested, not yet reviewed. Digital Employees with strict governance profiles must not use Unverified knowledge autonomously. |

### 7.6 Sensitivity Labels and Access Scoping

Knowledge items inherit their collection's sensitivity classification and may carry their own additional labels. Labels include:

- `PII` — Contains personally identifiable information
- `PHI` — Contains protected health information
- `FINANCIAL` — Contains non-public financial data
- `LEGAL_PRIVILEGE` — Subject to legal professional privilege
- `EXECUTIVE` — Restricted to executive-level access

Digital Employees must have explicit permission to access knowledge carrying these labels. Unlabelled knowledge is the default access tier.

### 7.7 Freshness and Expiration

Knowledge has a configured freshness requirement based on its type. Time-sensitive knowledge (pricing, policies, regulatory requirements, product specifications) carries an expiration date. Upon expiration:

- The knowledge moves from `Published` to `Pending Review`
- Digital Employees with strict freshness policies will not use knowledge in `Pending Review` state for high-confidence autonomous responses
- The owner is notified and must re-approve before the knowledge returns to active use

---

## 8. Approval Governance

### 8.1 The Role of Approvals

Approvals are the mechanism by which organizations maintain human authority over AI actions that carry risk, cost, or consequence beyond what they have chosen to delegate to Digital Employees.

An approval is not a workaround for insufficient AI capability. It is an intentional governance gate — a point at which human judgment is required before the platform proceeds. Well-designed approval architecture makes the platform more trusted, not less capable.

### 8.2 Reversibility as the Primary Approval Driver

The most important factor in determining whether an action requires approval is its reversibility profile.

**Reversibility classification:**

| Class | Description | Default Stance |
|-------|-------------|---------------|
| **Fully reversible** | Action can be completely undone with no side effects | Autonomous action permitted within other policy limits |
| **Partially reversible** | Action can be largely undone but leaves some trace | Configurable; approval recommended for high-value operations |
| **Difficult to reverse** | Action can be undone with significant effort or downstream impact | Approval recommended by default |
| **Irreversible** | Action cannot be undone once taken (email sent, payment made, record permanently deleted, regulatory filing submitted) | Approval required unless explicitly configured otherwise |

Reversibility classification is defined at the Capability level during platform configuration, not inferred at runtime. It is the organization's responsibility to classify Capabilities correctly during onboarding and review.

The platform's default stance is: when reversibility is unknown or ambiguous, treat the action as irreversible.

### 8.3 Approval Architectures

The platform supports multiple approval configurations:

**Single approver** — One named individual or role must approve. Suitable for routine governance.

**Multi-level approval** — The action must pass through a defined sequence of approvers. Each level must complete before the next is notified. Used for high-value or cross-functional actions.

**Department approval** — Any member of an authorized department may approve. Distributes the approval burden for high-frequency operational decisions.

**Executive approval** — Approval must come from a named executive tier. Used for actions with significant financial, legal, or reputational consequence.

**Quorum approval** — A defined number of approvers from a pool must concur. Used for decisions requiring collective accountability.

**Conditional approval** — Approval is required only when specific conditions are met (action value exceeds a threshold, the affected customer account meets certain criteria, the action occurs outside business hours).

**Risk-based approval** — The platform evaluates a risk score for each action. Actions above the configured risk threshold are automatically routed for approval regardless of other configuration.

**Time-limited approval** — An approval is valid for a defined window. If the action is not executed within the window, the approval lapses and must be re-requested.

### 8.4 Approval Record

Every approval decision is recorded in the Audit Trail with:

- The action that required approval
- The approver's identity
- The time of the approval decision
- The approval rationale (if captured)
- The expiry of the approval
- The action outcome (whether the approved action was subsequently taken)

Approval records are immutable. A recorded approval cannot be retroactively altered.

### 8.5 Approval Delegation

Approvers may delegate their approval authority for a defined period (leave, capacity constraints). Delegations are:

- Explicit — the delegator nominates a specific delegate
- Scoped — the delegation covers specific approval categories, not all approval authority
- Time-bounded — the delegation expires automatically
- Audited — the Audit Trail records the delegation grant and any approvals made under delegation

Delegation chains may not exceed two levels. An approver who is already acting as a delegate may not further delegate.

---

## 9. Digital Employee Governance

### 9.1 Digital Employees Are Governed Agents of the Organization

Digital Employees are not autonomous systems. They are governed workforce members with defined authority, defined accountability, and defined limits. Every Digital Employee hired onto a tenant operates within a governance envelope that the organization has explicitly configured.

A Digital Employee may not exceed the authority its governance envelope permits — regardless of what the underlying AI model is technically capable of.

### 9.2 Governance Envelope

Every Digital Employee's governance envelope specifies:

**Identity and scope:**
- Assigned Responsibilities (sustained accountability domains)
- Assigned Capabilities (discrete executable outcomes)
- Organizational position (department, reporting structure, cost centre)

**Knowledge access:**
- Authorized Knowledge Collections and their trust levels
- Knowledge sensitivity labels the Digital Employee may access
- Freshness requirements that apply to knowledge used in autonomous responses

**Tool and Connector access:**
- Authorized Connectors and the action scope for each (read, write, create, delete)
- Maximum invocation frequency and volume per Connector per time period
- Connectors that require human approval before each use

**AI model permissions:**
- Permitted model providers
- Permitted specific models within each provider
- Whether the Digital Employee may modify its own model configuration

**Action authority:**
- Reversibility classes the Digital Employee may act on autonomously
- Financial spend authority (maximum value of actions it may initiate without approval)
- Communication authority (whether it may send external communications autonomously)
- Maximum scope of any single action (e.g., may affect up to N records per execution)

**Escalation and Handoff rules:**
- Conditions under which the Digital Employee must escalate
- Conditions under which it must initiate a Handoff (transfer of accountability to a human or another Digital Employee with appropriate authority)
- Maximum number of autonomous attempts before mandatory escalation

**Memory permissions:**
- May read from Conversation memory: yes/no
- May write to Conversation memory: yes/no
- May read from Organisational memory: yes/no
- May write to Organisational memory: yes/no

### 9.3 No Capability Inheritance

Digital Employees do not inherit permissions from other Digital Employees, from their department's permissions, or from any other source. Every permission in the governance envelope is explicitly granted.

A Digital Employee that has not been granted a permission may not exercise that capability — even if an adjacent Digital Employee with the same Responsibilities holds that permission.

### 9.4 Reversibility in Digital Employee Governance

Digital Employees are configured with a maximum reversibility class for autonomous action. An organization may configure a Digital Employee to act autonomously on Fully Reversible and Partially Reversible actions while requiring approval for Difficult to Reverse and Irreversible actions.

This configuration is set in the governance envelope and enforced by the Control Fabric. It is not an advisory setting that the Digital Employee's runtime can override under any circumstance.

### 9.5 Suspension and Deactivation

A Digital Employee may be suspended (temporarily inactivated while retaining configuration) or deactivated (permanently retired). On suspension or deactivation:

- Active Execution Plans are completed or cleanly aborted according to configured policy
- In-progress approvals are redirected to designated humans
- Connector tokens issued in the Digital Employee's name are revoked
- The Digital Employee's service identity is deactivated in the IAM system
- The deactivation event is recorded in the Audit Trail

---

## 10. Audit and Compliance

### 10.1 The Audit Trail as a First-Class Domain Concept

The Audit Trail is defined in the Core Domain Model as a permanent, first-class platform concept. It is not a log file, a debugging tool, or an operational metric. It is the immutable record of the platform's history — the document by which the platform proves its trustworthiness.

The Audit Trail is the answer to the question: *how do we know what happened, and why?*

### 10.2 What the Audit Trail Records

Every Audit Trail entry captures:

| Field | Description |
|-------|-------------|
| `event_id` | Globally unique, immutable identifier |
| `timestamp` | UTC timestamp with millisecond precision |
| `tenant_id` | Organizational context |
| `actor_type` | Human, Digital Employee, or Platform |
| `actor_id` | Identity of the acting party |
| `human_initiator_id` | The human who authorized or initiated the intent (see delegation chain below) |
| `capability_id` | The Capability being executed, if applicable |
| `workflow_id` | The Workflow, if applicable |
| `connector_id` | The Connector invoked, if applicable |
| `knowledge_collection_id` | The Knowledge Collection accessed, if applicable |
| `model_provider` | The AI model provider used, if applicable |
| `prompt_version` | The version of the instruction set in effect |
| `policy_version` | The version of the organizational policy evaluated |
| `data_classifications_accessed` | Labels of any classified data involved |
| `action` | What was done |
| `outcome` | Success, failure, approval required, denied |
| `approval_id` | Reference to the approval record, if applicable |
| `reversibility_class` | The reversibility classification of the action |
| `decision_rationale` | Summary of why the Control Fabric permitted or denied the action |
| `channel` | The Channel through which the interaction originated |

### 10.3 Delegation Chain

When a Digital Employee takes an action, two identities are accountable: the Digital Employee that executed the action, and the human who authorized the intent that led to that execution. Both must be recorded in every Audit Trail entry. Legal and regulatory accountability traces to the human; operational accountability traces to the Digital Employee.

### 10.4 Immutability

Audit Trail entries are immutable. Once written, they cannot be modified, deleted, or overwritten — not by tenant administrators, not by DreamTeam platform engineers, not by any automated process.

Technical immutability is enforced through:

- Append-only storage architecture for audit records
- Cryptographic chaining of sequential records (each entry contains a hash of the previous entry, making retroactive modification detectable)
- Separate storage credentials for audit records that are not accessible to the application layer
- Independent audit log integrity verification on a scheduled basis

### 10.5 Audit Retention

Audit records are retained for a minimum of seven years by default. Organizations may configure longer retention. Audit records are never subject to automatic deletion based on shorter data retention policies applied to other data categories.

Legal holds on audit records are supported. A held audit record cannot be deleted regardless of its nominal retention period.

### 10.6 Audit Export

Organizations may export their Audit Trail in structured, machine-readable format for import into their own security information and event management (SIEM) systems. Audit export is a tenant-controlled operation that itself generates an Audit Trail entry.

### 10.7 Compliance Reporting

The platform generates compliance reports from Audit Trail data on demand. Standard reports include:

- Access reviews: who accessed what, when
- Permission change history: every grant and revocation
- Digital Employee activity summaries: by DE, by Capability, by time period
- Approval records: every approval requested, granted, denied, and lapsed
- Knowledge access reports: which knowledge was retrieved, by whom, for what purpose
- Policy violation summaries: every Control Fabric denial and its reason
- Connector invocation logs: every external system call made on the tenant's behalf

---

## 11. Privacy

### 11.1 Privacy by Design

Privacy is not a compliance afterthought applied at the end of development. It is a design constraint applied at the beginning. Every feature that processes personal data must demonstrate, at design time, that it collects only what is necessary, retains it only as long as required, and protects it with controls appropriate to its sensitivity.

### 11.2 Personal Data Handling

Personal data that enters the platform — through user profiles, conversation content, knowledge documents, Connector data, or any other path — is subject to the following standing rules:

- It is processed only for the purpose for which it was collected or for a compatible purpose explicitly authorized by the individual
- It is not used to train AI models without explicit, informed, and revocable consent
- It is not shared with third parties (including AI model providers) beyond what is necessary to deliver the contracted service
- It is retained only for the configured retention period, subject to legal holds

### 11.3 Regulatory Readiness

**GDPR (EU General Data Protection Regulation):**
- Lawful basis for processing is documented per data category
- Data subject rights are supported: access, rectification, erasure, restriction, portability, objection
- Data Processing Agreements (DPAs) are available for all customers
- Data Protection Impact Assessments (DPIAs) are completed for high-risk processing activities
- Data breach notification processes meet the 72-hour reporting requirement
- Cross-border data transfers use approved transfer mechanisms (Standard Contractual Clauses or adequacy decisions)

**CCPA (California Consumer Privacy Act):**
- Consumers' right to know what personal data is collected is supported through data export
- Consumers' right to delete personal data is supported through verified deletion requests
- Opt-out of sale/sharing of personal data is honored at the platform level

**HIPAA (Health Insurance Portability and Accountability Act):**
- Protected Health Information (PHI) receives the highest classification tier
- Business Associate Agreements (BAAs) are available for covered entities
- PHI access is restricted by role and explicitly logged
- PHI may not be processed by model providers that are not covered under the applicable BAA
- Minimum necessary standard is applied to all PHI access

**Regional and emerging privacy laws:**
The platform's privacy architecture is designed to accommodate additional regional privacy requirements through configuration rather than architectural change. Data residency, retention policies, consent management, and data subject rights tooling are built as configurable capabilities.

### 11.4 Sensitive Information Handling

The platform recognizes the following categories of sensitive information as requiring elevated protection:

- Health and medical information
- Financial account information
- Government-issued identification numbers
- Biometric data
- Criminal history
- Sexual orientation and gender identity
- Political opinions and religious beliefs
- Immigration status
- Children's data (subject to COPPA and equivalent regional regulations)

Digital Employees are not permitted to process these categories unless the organization has explicitly configured a knowledge and Connector scope that includes them, and the applicable regulatory compliance controls are in place.

---

## 12. Secrets Management

### 12.1 Zero Secrets in Code or Configuration

No secret — API key, database credential, OAuth token, certificate private key, encryption key, webhook secret, or third-party integration credential — may appear in:

- Application source code
- Version control repositories
- Environment variable files committed to repositories
- Log files
- Error messages surfaced to end users
- Audit Trail entries (Audit Trails record that a Connector was used; they do not record the credential used to authenticate it)

Violations of this rule are treated as security incidents regardless of whether exploitation is known to have occurred.

### 12.2 Secret Lifecycle

All secrets follow a governed lifecycle:

- **Generation** — Secrets are generated with appropriate entropy by platform-managed systems, not by humans
- **Storage** — Secrets are stored in a dedicated secrets management system, encrypted, with access audited
- **Rotation** — Secrets are rotated on a defined schedule and immediately upon any suspected compromise. The platform supports zero-downtime rotation.
- **Revocation** — Secrets may be revoked immediately. Revocation propagates to all services using the revoked secret within a defined maximum window.
- **Expiry** — Secrets carry a defined maximum lifetime. Expired secrets are automatically invalidated.
- **Deletion** — Deleted secrets are purged from all storage, including backups, within the retention window of the secrets management system.

### 12.3 Connector Credentials

Connector credentials (OAuth tokens, API keys, service account credentials) are the most operationally sensitive secrets on the platform. They provide access to external organizational systems on behalf of Digital Employees.

- Each Connector credential is stored independently with its own access control
- Connector credentials are scoped to the minimum permissions required for the Connector's defined action scope
- Credential access is audited — every use of a Connector credential is traceable to the Capability execution that required it
- Unused Connector credentials (Connectors that have not been invoked within a configured period) trigger an alert and a review requirement
- Organizations may revoke Connector credentials at any time through the Control Fabric interface

---

## 13. Secure Integrations

### 13.1 Connector Security Model

Every Connector represents a trust relationship between DreamTeam and an external system. The security model for Connectors must be conservative: minimum necessary permissions, explicit scope definition, audited access, and revocable authorization.

### 13.2 Connector Permission Definition

When a Connector is configured, its permission scope is explicitly declared:

- **Read** — May retrieve data from the external system
- **Write** — May create or update records in the external system
- **Delete** — May remove records from the external system (requires specific approval; not granted by default)
- **Execute** — May trigger actions or workflows in the external system
- **Admin** — May modify configuration of the external system (requires executive approval; almost never appropriate for Digital Employee use)

The declared scope is enforced at the Control Fabric level. A Connector invocation that requests actions outside its declared scope is rejected before it reaches the external system.

### 13.3 OAuth and Token Management

Where external systems support OAuth 2.0, Connectors use it. Token management follows these rules:

- Access tokens are short-lived; refresh tokens are stored in the secrets management system
- Token refresh is automatic and audited
- Token revocation in the external system is mirrored by deletion of the token from the platform's secrets management system
- Connectors do not share OAuth authorization grants. Each Connector has its own authorization, even if two Connectors connect to the same external system.

### 13.4 Connector Audit Trail

Every Connector invocation is recorded in the Audit Trail with:

- The Connector identity
- The action requested
- The data sent to the external system (subject to data minimization — full payloads are logged only at elevated audit levels)
- The response received (metadata only, not full content, unless elevated audit is configured)
- The Capability execution that triggered the invocation
- The Digital Employee that authorized the invocation
- The outcome (success, failure, rejection by external system)

### 13.5 Webhook Security

Inbound webhooks (external systems sending events to DreamTeam) must be authenticated:

- Shared secrets for webhook signature verification
- IP allowlist restriction where the external system supports it
- Rate limiting on inbound webhook endpoints
- Payload validation before processing
- Replay attack prevention through timestamp and nonce validation

---

## 14. Enterprise Deployment Models

### 14.1 Deployment Flexibility

The platform's security and governance architecture must remain valid regardless of how the platform is deployed. Governance controls, audit requirements, data protection standards, and IAM policies apply uniformly across all deployment models.

### 14.2 Supported and Planned Deployment Models

**Multi-tenant SaaS (current):**
All tenants share infrastructure managed by DreamTeam. Logical isolation is enforced at every layer. DreamTeam manages all infrastructure security. Customers manage their own configuration, users, and governance policies.

**Dedicated cloud (future):**
A tenant's data and workloads run on infrastructure dedicated to that tenant, managed by DreamTeam. Physical isolation supplements logical isolation. Suitable for regulated industries requiring dedicated compute.

**Private cloud / customer-managed infrastructure (future):**
The platform is deployed within the customer's own cloud environment. The customer manages infrastructure security. DreamTeam provides the software layer and governance tooling. Suitable for customers with strict data residency, sovereignty, or regulatory requirements.

**Hybrid (future):**
Core platform services run in DreamTeam's infrastructure while sensitive workloads (specific AI inference, data processing) run within the customer's environment. Data does not leave the customer's perimeter for those workloads.

**Air-gapped (long-term vision):**
The platform operates without any connectivity to DreamTeam's infrastructure after initial deployment. Model updates, security patches, and configuration changes are delivered through secure, verifiable channels on a defined schedule. Suitable for government and defence contexts.

**Customer-managed encryption keys:**
In any deployment model, customers may supply their own encryption keys through a Bring Your Own Key (BYOK) arrangement. DreamTeam platform operators cannot decrypt data protected by customer-managed keys.

### 14.3 Security Responsibilities by Deployment Model

The boundary of security responsibility shifts with the deployment model. This boundary is documented explicitly for each model and forms part of the contractual relationship with the customer. Customers selecting self-managed deployment models accept the security responsibilities they assume.

---

## 15. Regulatory Readiness

### 15.1 Architectural Readiness, Not Certification

This document describes architectural readiness for regulatory compliance. Formal certification requires external audit and assessment processes that occur independently. The platform is designed so that readiness is continuous — audit-ready at any point in time, not scrambled into compliance during an assessment period.

### 15.2 Regulatory Frameworks

**SOC 2 Type II:**
The platform's security controls, availability commitments, processing integrity standards, confidentiality controls, and privacy practices are designed to satisfy the Trust Services Criteria. Audit Trail fidelity, access controls, encryption standards, and incident response processes are the primary evidence requirements.

**ISO 27001:**
The Information Security Management System (ISMS) aligned to ISO 27001 governs platform-level security. Risk assessment, treatment, and monitoring processes operate continuously. Control objectives map directly to platform architectural controls.

**GDPR:**
Covered in Section 11. The platform is a data processor. Data subject rights, lawful basis documentation, DPAs, DPIA processes, and breach notification are all supported.

**HIPAA:**
Covered in Section 11. BAAs, PHI access controls, minimum necessary standard, and audit requirements are all supported for applicable deployment configurations.

**PCI DSS:**
The platform does not process, store, or transmit payment card data directly. Organizations using DreamTeam Capabilities that interact with payment systems must ensure those Connectors are scoped to minimize cardholder data exposure and that their Connector configuration is reviewed against PCI DSS requirements.

**NIST AI Risk Management Framework (AI RMF):**
The platform's AI governance architecture maps to the NIST AI RMF's four functions: Govern, Map, Measure, and Manage. AI Governance (Section 4), Control Fabric Governance (Section 5), Digital Employee Governance (Section 9), and AI Safety (Section 16) collectively constitute the platform's AI risk management posture.

**EU AI Act (future readiness):**
The EU AI Act establishes risk-based requirements for AI systems operating in the EU. DreamTeam's AI governance architecture is designed with this framework in mind. Digital Employees operating in HR, credit, healthcare, law enforcement, or other high-risk categories identified by the Act will require additional governance controls and documentation when the Act's requirements take effect.

**FedRAMP (long-term):**
US Federal Risk and Authorization Management Program compliance requires a dedicated US government deployment model, FedRAMP-authorized infrastructure, and an extended control set. This is a long-term platform objective, not a current readiness claim.

---

## 16. AI Safety

### 16.1 Safety as a Governance Requirement

AI safety is not a research concern for DreamTeam — it is an operational governance requirement. Every Digital Employee operates in a real organizational context with real data, real customers, and real consequences. Safety failures are not acceptable experiments.

### 16.2 Hallucination Management

Covered in Section 4.7. The platform's approach to hallucination risk is: do not trust model-internal knowledge for consequential decisions; ground responses in verified Knowledge Collections; require human review for high-stakes outputs.

### 16.3 Prompt Injection Defense

Prompt injection is the most immediate AI-specific security threat on the platform. An attacker who can inject instructions into a Digital Employee's context may be able to override its governance constraints, exfiltrate data, or cause it to take unauthorized actions.

Defenses are structural, not heuristic:

- System instructions (the Digital Employee's governance envelope and Responsibility definition) are structurally separated from user-supplied content. They occupy different positions in the context assembly pipeline and cannot be overwritten by user content.
- User-supplied content is treated as untrusted data at all times. It may inform the Digital Employee's response; it may not modify its operating parameters.
- The Control Fabric evaluates every proposed action against the Digital Employee's governance envelope independently of what instructions appear in the conversation. Even if a user convinces the Digital Employee that it has been "authorized" to take an action, the Control Fabric's independent policy evaluation is the binding check.
- Anomalous action patterns (a Digital Employee attempting actions outside its normal behavioral profile) trigger a security alert and a human review requirement.

### 16.4 Data Poisoning Awareness

Knowledge Collections used by Digital Employees represent a potential poisoning surface. If an attacker can introduce malicious content into a Knowledge Collection, they may influence Digital Employee responses in harmful ways.

Mitigations:
- Knowledge ingestion from external sources is subject to the full knowledge governance pipeline (Draft → Review → Approved → Published)
- Automated content screening for obvious malicious patterns before knowledge enters the review pipeline
- Anomaly detection on knowledge that produces statistically unusual Digital Employee behavior
- Source attribution on all retrieved knowledge, enabling retrospective investigation of poisoning attempts

### 16.5 Retrieval Safety

The retrieval system (vector search, semantic retrieval) must not return results that violate the requesting Digital Employee's knowledge scope. The retrieval query is always parameterized by:

- Tenant ID
- Authorized Knowledge Collection IDs for the Digital Employee
- Sensitivity label filter matching the Digital Employee's authorized access

Retrieval results are never post-filtered at the application layer as the primary access control. They are pre-filtered at the retrieval layer. The application layer is a secondary check, not the enforcement point.

### 16.6 Unsafe Content Handling

Digital Employees must not generate, retrieve, or transmit content that:

- Constitutes illegal material
- Incites violence, discrimination, or harm
- Violates applicable regional content regulations
- Facilitates fraud, deception, or manipulation

Output screening is applied to Digital Employee responses before delivery. Flagged content is blocked, logged, and reviewed. Persistent generation of flagged content triggers a Digital Employee suspension pending review.

---

## 17. Security Observability

### 17.1 Observable by Design

Security events that are not observed are security events that cannot be responded to. The platform is designed for complete security observability — not as an operational enhancement, but as a security requirement.

### 17.2 Security Event Categories

**Authentication events:**
Login success, login failure, MFA challenge, MFA failure, session creation, session expiry, session revocation, break-glass activation

**Authorization events:**
Permission grants, permission revocations, role assignments, role removals, delegation grants, delegation expirations, access denials

**Connector events:**
Connector registration, Connector configuration changes, Connector token issuance, Connector token revocation, Connector invocations (all), Connector failures, unusual invocation patterns

**Knowledge events:**
Knowledge Collection creation, document ingestion, document approval, document publishing, knowledge access by Digital Employee, knowledge trust level changes, freshness policy violations

**AI events:**
Digital Employee activation, deactivation, suspension, governance envelope changes, prompt version changes, model provider changes, confidence threshold triggers, hallucination flags, prompt injection detection alerts, anomalous action patterns

**Approval events:**
Approval requested, approval granted, approval denied, approval lapsed, approval delegation, approval under delegation

**Policy events:**
Policy version changes, Policy Engine denials (every denial with reason), policy evaluation anomalies

**Data events:**
Sensitive data access, data classification changes, data export, legal hold creation, legal hold release, data deletion

**Security events:**
Failed authentication at volume, permission escalation attempts, unusual access patterns, API rate limit hits, Cross-tenant access attempts (which should never succeed but must be attempted and alerted on), break-glass account use

### 17.3 Alerting Thresholds

Alerts are generated for:

- Any break-glass account activation
- Any cross-tenant data access attempt (regardless of outcome)
- Any prompt injection detection
- Any Control Fabric policy denial at elevated frequency
- Any anomalous Connector invocation volume
- Authentication failures above configured thresholds
- Any change to a Digital Employee's governance envelope
- Any deletion of data subject to a legal hold

### 17.4 SIEM Integration

Security events are exportable in real time to customer SIEM systems. The export format is standard (JSON, CEF, or LEEF), the event taxonomy is documented, and the export pipeline itself is monitored for disruption.

---

## 18. Security Anti-Patterns

The following practices are prohibited absolutely. They are listed here not as aspirations but as enforceable prohibitions. Any instance of these patterns discovered in the platform — in code, in configuration, in operational practice, or in design — must be remediated as a security incident, not a technical debt item.

**Identity and Access:**
- Shared credentials between users, services, or systems — every identity must be distinct and individually accountable
- Hardcoded secrets in any code, configuration file, environment variable committed to version control, or log output
- Permanent administrative access without regular review and recertification
- Service accounts with broader permissions than the single service they represent requires
- Use of production credentials in development or testing environments
- Password sharing or credential transfer through unencrypted channels
- Authorization logic that can be bypassed by caller-supplied parameters

**Data and Storage:**
- Cross-tenant data access of any kind, for any reason, without explicit tenant authorization
- Unencrypted data at rest or in transit between any platform components
- Database schemas without tenant isolation enforced at the query layer
- Application-layer-only tenant isolation (must be enforced at the storage layer independently)
- Sensitive data (PII, PHI, financial) appearing in log files, error messages, or Audit Trail entries
- Audit Trail records that can be modified or deleted by any party

**AI and Knowledge:**
- Unrestricted AI model access without a governance envelope
- Knowledge Collections without a defined owner, classification, or freshness policy
- Knowledge that bypasses the approval pipeline and enters Digital Employee context directly
- Context assembly that does not enforce the same access controls as direct data access
- System instructions that can be overwritten by user-supplied content (prompt injection)
- Digital Employees that can exceed their configured authority regardless of what appears in their conversation
- Autonomous action on irreversible operations without explicit human approval

**Approvals and Governance:**
- Bypassing the approval system under "emergency" conditions without an audited break-glass process
- Approval workflows that can be short-circuited by any party without generating an Audit Trail entry
- Governance policies that cannot be changed without generating an Audit Trail entry recording the old and new policy

**Connectors and Integrations:**
- Over-privileged Connectors with broader scope than their defined function requires
- Connector credentials that do not rotate
- Webhook endpoints without authentication
- Integrations that share credentials across multiple Connectors or multiple Digital Employees
- Connector invocations that bypass the Control Fabric

**Operational:**
- Platform operator access to tenant data without explicit customer authorization
- Debug or diagnostic modes that reduce security controls in production
- Features shipped without audit instrumentation because audit was "too slow" or "added later"
- Security incidents treated as technical debt rather than immediate remediation items

---

## 19. Zero Trust Principles

### 19.1 Never Trust, Always Verify

DreamTeam adopts Zero Trust as its permanent network and security architecture philosophy. The perimeter model — where trust is granted to anyone inside a defined boundary — is incompatible with a multi-tenant AI workforce platform where Digital Employees traverse multiple external systems, model providers, and organizational boundaries.

Zero Trust replaces perimeter trust with continuous verification.

### 19.2 Zero Trust Axioms

**No implicit trust from network location.**
A request originating from within the platform's own infrastructure is not trusted by virtue of its origin. Every request to every service is authenticated and authorized independently.

**Identity is the perimeter.**
The security boundary is the authenticated, authorized identity — not the network segment, IP address, or service name. Every internal service-to-service call carries verifiable identity claims.

**Least privilege access, always.**
Access is granted to the minimum scope required for the specific operation, for the minimum time required. There is no persistent elevated access granted for convenience.

**Assume breach.**
The platform is designed on the assumption that a component may be compromised at any time. Defense in depth, compartmentalization, and anomaly detection are designed so that a compromised component cannot escalate to full platform compromise.

**Verify explicitly.**
Every access decision uses all available signals: identity, permission, device state (where applicable), time, location, risk score, and behavioral pattern. No access decision is made on identity alone.

**Continuous re-evaluation.**
A session that was trusted at initiation is not trusted indefinitely. High-value operations re-evaluate trust at the point of execution. Long-running sessions are subject to periodic re-authentication.

**Inspect and log all traffic.**
All traffic between platform components is inspectable and logged. Encrypted traffic does not mean unmonitored traffic within the platform's own boundaries.

### 19.3 Zero Trust in Practice

- Service-to-service communication uses mutual TLS with short-lived certificates
- Inter-service authorization uses signed tokens with minimal scope and short expiry
- The Control Fabric evaluates every Digital Employee action as an independent trust decision — a Digital Employee with a valid session does not inherit permanent authorization for any subsequent action
- Anomaly detection operates on behavioral patterns, not just known-bad signatures

---

## 20. Immutable Security Principles

These principles are permanent. They do not change with technology, scale, commercial pressure, customer request, or competitive landscape. They are the foundation of DreamTeam's trustworthiness.

---

**Customers own their data, their knowledge, and their AI.**
DreamTeam is the platform. The customer is the owner. This distinction is permanent, contractual, and architectural.

**Customers control their governance.**
The organization defines what their Digital Employees may do, what knowledge they may access, what systems they may interact with, and what requires human approval. DreamTeam provides the control surface. The customer exercises the authority.

**Governance is built into every workflow — not added later.**
Audit hooks, permission checks, policy evaluation, and approval gates are structural elements of the platform, not features added on top. They cannot be removed by configuration, and they cannot be bypassed by design.

**Every important action is attributable and auditable.**
No action of consequence occurs anonymously or without a record. The Audit Trail is immutable. The identity behind every action is knowable. This is the foundation of enterprise accountability.

**AI must remain accountable.**
Digital Employees operate within defined governance envelopes. The Control Fabric enforces limits that the AI's underlying models cannot override. Human oversight is available at every consequential decision point. No AI on this platform operates beyond the reach of organizational governance.

**Reversibility governs automation.**
The platform does not fully automate what cannot be undone without first ensuring a human has authorized it. Irreversibility is a governance signal, not just a technical characteristic. The appropriate human must be in the loop before any truly irreversible action proceeds.

**Security is designed in — it cannot be added later.**
Features are built with security instrumentation from inception. A feature without audit capability, without authorization controls, or without policy evaluation is not a complete feature — it is an incomplete one. Completion includes governance.

**Trust is DreamTeam's most valuable feature.**
Speed, capability, intelligence, and integrations are competitive advantages. Trust is a permanent operating requirement. Enterprise organizations, regulated industries, and government bodies will evaluate DreamTeam first on trust. Every architectural decision must preserve and strengthen it.

**The platform must be trustworthy even when it is the most convenient path to circumvent it.**
Security anti-patterns are not just technical mistakes — they are organizational culture failures. The platform's design must make the secure path the easy path, and must make circumvention conspicuous, audited, and consequential.

**We hold ourselves to the standard we ask customers to trust.**
DreamTeam's own operational practices — secret management, access control, audit discipline, data handling — must meet or exceed the standards this document defines for customers. We cannot ask customers to trust a platform whose operators do not trust those same principles themselves.

---

*Document Version: 1.0*
*Classification: Internal Foundational Reference*
*Next Review: Q3 2026*
*Owner: Platform Architecture & Security*
