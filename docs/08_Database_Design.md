# 08 — Database Design

**DreamTeam AI — Enterprise Database Blueprint**
Version 1.0 | 2026-07-01

---

## Table of Contents

1. [Database Philosophy](#1-database-philosophy)
2. [Logical Domain Model](#2-logical-domain-model)
3. [Multi-Tenancy Model](#3-multi-tenancy-model)
4. [Core Platform Tables](#4-core-platform-tables)
5. [Workspace & Capability Tables](#5-workspace--capability-tables)
6. [Digital Workforce Tables](#6-digital-workforce-tables)
7. [Agent & Workforce Engine Tables](#7-agent--workforce-engine-tables)
8. [Workflow Tables](#8-workflow-tables)
9. [Control Fabric Tables](#9-control-fabric-tables)
10. [Knowledge & Memory Tables](#10-knowledge--memory-tables)
11. [Conversation & Customer Portal Tables](#11-conversation--customer-portal-tables)
12. [Approval Tables](#12-approval-tables)
13. [Connector & Integration Tables](#13-connector--integration-tables)
14. [Intelligence & Model Provider Tables](#14-intelligence--model-provider-tables)
15. [AI Token Usage, Cost & FinOps Tables](#15-ai-token-usage-cost--finops-tables)
16. [Billing & Subscription Tables](#16-billing--subscription-tables)
17. [Audit, Event & Compliance Tables](#17-audit-event--compliance-tables)
18. [Analytics & Optimization Tables](#18-analytics--optimization-tables)
19. [Soft Deletes, Versioning & History](#19-soft-deletes-versioning--history)
20. [Indexing & Performance Strategy](#20-indexing--performance-strategy)
21. [Row-Level Security Strategy](#21-row-level-security-strategy)
22. [Data Retention & Archival](#22-data-retention--archival)
23. [Migration Strategy](#23-migration-strategy)
24. [Seed Data Strategy](#24-seed-data-strategy)
25. [Database Anti-Patterns](#25-database-anti-patterns)
26. [Final Recommended Table List](#26-final-recommended-table-list)
27. [Implementation Priorities](#27-implementation-priorities)

---

## 1. Database Philosophy

### 1.1 Core Principles

DreamTeam's database is not a persistence layer bolted underneath a product. It is the authoritative record of everything a tenant's Digital Workforce has ever been asked to do, decided, acted upon, or declined. Every table design decision flows from five non-negotiable principles:

**Principle 1 — Tenant isolation is structural, not conditional.**
Row-level security (RLS) policies enforce tenant boundaries at the Postgres engine level. No application query can accidentally read cross-tenant data. The `tenant_id` column exists on every data table, indexed always, referenced always.

**Principle 2 — The Audit Trail is a first-class domain entity.**
Every Control Fabric decision, every Action taken, every approval granted or denied generates an immutable audit record. Audit rows are never updated, never soft-deleted. They are append-only by RLS policy and can only be archived, never erased.

**Principle 3 — Domain terminology maps 1:1 to table names.**
Table names follow the Core Domain Model (`docs/05_Core_Domain_Model.md`) exactly. `digital_employees` not `agents`. `capabilities` not `skills`. `handoffs` not `transfer_events`. Any deviation is a naming error, not a design choice.

**Principle 4 — Working Memory is not a database table.**
Conversation-scoped working memory is ephemeral state. It lives in Redis (or equivalent cache) scoped to a session key. It is not persisted to Postgres. When a session ends, working memory expires. What must be retained from a session is written to `conversation_messages` or `knowledge_items`, not a working memory table.

**Principle 5 — Schema evolution is additive.**
Columns are added, never renamed in place. Tables are added, never restructured destructively. Every migration is reversible. Breaking changes require a deprecation migration that adds the new column, a data migration that backfills, and a cleanup migration that drops the old column in a separate deployment.

### 1.2 Technology Choices

| Concern | Technology | Rationale |
|---|---|---|
| Primary database | Supabase (Postgres 15+) | RLS, pgvector, auth, edge functions in one platform |
| Vector search | pgvector extension | Embedding storage and semantic search without external vector DB in Phase 1 |
| Full-text search | Postgres `tsvector` + GIN index | Sufficient for Phase 1; Elasticsearch deferred |
| Session / working memory | Redis (Upstash or Supabase-adjacent) | Ephemeral, session-scoped, sub-millisecond; never Postgres |
| Migrations | Supabase CLI migrations | Version-controlled SQL files, applied in CI |
| Seed data | Supabase seed scripts | Platform defaults; tenant data seeded via application layer |

### 1.3 Naming Conventions

- Tables: `snake_case`, plural nouns (`digital_employees`, `capabilities`)
- Primary keys: `id uuid DEFAULT gen_random_uuid()`
- Foreign keys: `<table_singular>_id` (e.g., `tenant_id`, `workspace_id`)
- Timestamps: `created_at`, `updated_at` (both `timestamptz DEFAULT now()`)
- Soft delete: `deleted_at timestamptz` (NULL = active)
- Status enums: defined as Postgres `ENUM` types, prefixed with table name (e.g., `de_status`, `workflow_run_status`)
- Boolean columns: affirmative prefix (`is_active`, `is_published`, `requires_approval`)

---

## 2. Logical Domain Model

### 2.1 Aggregate Roots

The following domain entities are aggregate roots — they exist independently and are referenced by other entities:

| Aggregate Root | Primary Table | Key Relationships |
|---|---|---|
| Tenant | `tenants` | Root of all data isolation |
| Organisation | `organisations` | The real business; has one Tenant in Phase 1 |
| Workspace | `workspaces` | Bounded operational context within a Tenant |
| Digital Employee | `digital_employees` | Customer-visible business persona |
| Capability | `capabilities` | Discrete executable outcome |
| Workflow | `workflows` | Orchestrated sequence of Capabilities |
| Connector | `connectors` | Configured binding to an external system |
| Knowledge Base | `knowledge_bases` | Scoped knowledge repository |
| Channel | `channels` | Inbound surface (chat, email, API, voice) |
| Model Provider | `model_providers` | External AI inference service |

### 2.2 Key Entity Relationships

```
Tenant
  └── Organisation
  └── Workspaces
        └── Digital Employees
              └── Responsibilities
              └── Capabilities (via assignments)
              └── Conversations
        └── Capabilities
              └── Workflows
              └── Integrations (Connector × Capability)
        └── Knowledge Bases
              └── Knowledge Items
  └── Connectors
  └── Channels
  └── Control Fabric Policies
  └── Billing Subscription
```

### 2.3 Cross-Cutting Entities

These entities span multiple aggregates:

- **Audit Trail** — references any entity via `entity_type` + `entity_id`
- **Approval Requests** — references Actions from any Capability or Workflow
- **AI Token Usage** — references any execution context
- **Feature Flags** — split by scope: `plan_features` (billing tier) vs `platform_feature_flags` (ops)

---

## 3. Multi-Tenancy Model

### 3.1 Isolation Model

DreamTeam uses **shared schema, row-level isolation**. All tenants share the same Postgres schema. The `tenant_id` column on every data table, combined with RLS policies, provides the isolation boundary. This model is chosen for operational simplicity at early scale.

### 3.2 Tenant Resolution

Every authenticated request resolves a `tenant_id` from the JWT claim `app_metadata.tenant_id`. This is set by Supabase Auth at login time. The tenant_id is available as a Postgres session variable (`current_setting('app.tenant_id')`) for use in RLS policies.

```sql
-- Set on each connection via Supabase Auth or Edge Function
SET app.tenant_id = '<uuid>';
```

### 3.3 RLS Policy Pattern

Every tenant-scoped table follows this pattern:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

Service-role operations (admin jobs, background workers) bypass RLS using the `service_role` key. This key is never exposed to the client.

### 3.4 Tenant Provisioning Sequence

When a new tenant is created:

1. Insert into `tenants`
2. Insert into `organisations`
3. Create default `workspaces` record
4. Apply default `control_fabric_policies` from platform seed
5. Create `billing_subscriptions` record (trial plan)
6. Create platform admin `users` record
7. Emit `tenant.provisioned` event to Audit Trail

---

## 4. Core Platform Tables

### 4.1 `tenants`

```sql
CREATE TABLE tenants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text UNIQUE NOT NULL,          -- URL-safe identifier
  display_name        text NOT NULL,
  status              tenant_status NOT NULL DEFAULT 'trial',
  plan_id             uuid REFERENCES billing_plans(id),
  region              text NOT NULL DEFAULT 'us-east-1',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE TYPE tenant_status AS ENUM ('trial', 'active', 'suspended', 'cancelled');
```

### 4.2 `organisations`

```sql
CREATE TABLE organisations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_name      text NOT NULL,
  display_name    text NOT NULL,
  industry        text,
  country_code    char(2),
  timezone        text NOT NULL DEFAULT 'UTC',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

### 4.3 `users`

```sql
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  auth_user_id    uuid UNIQUE REFERENCES auth.users(id),  -- Supabase Auth
  email           text NOT NULL,
  full_name       text,
  role            user_role NOT NULL DEFAULT 'member',
  is_active       boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'member', 'viewer');
```

### 4.4 `teams`

```sql
CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id     uuid NOT NULL REFERENCES teams(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL DEFAULT 'member',
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
```

---

## 5. Workspace & Capability Tables

### 5.1 `workspaces`

A Workspace is a bounded operational context — a product line, business unit, or division that operates semi-independently within a Tenant.

```sql
CREATE TABLE workspaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  name            text NOT NULL,
  description     text,
  slug            text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  settings        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (tenant_id, slug)
);
```

### 5.2 `capabilities`

A Capability is a discrete, measurable, executable outcome. It is not a tool call. It is not a task. It is a complete business outcome that can be independently requested, measured, and priced.

```sql
CREATE TABLE capabilities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id),
  name                text NOT NULL,
  slug                text NOT NULL,
  description         text,
  category            text,
  input_schema        jsonb NOT NULL DEFAULT '{}',   -- JSON Schema for inputs
  output_schema       jsonb NOT NULL DEFAULT '{}',   -- JSON Schema for outputs
  requires_approval   boolean NOT NULL DEFAULT false,
  reversibility_class reversibility_class NOT NULL DEFAULT 'fully_reversible',
  is_published        boolean NOT NULL DEFAULT false,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  UNIQUE (workspace_id, slug)
);

CREATE TYPE reversibility_class AS ENUM (
  'fully_reversible',
  'partially_reversible',
  'difficult_to_reverse',
  'irreversible'
);
```

### 5.3 `capability_versions`

```sql
CREATE TABLE capability_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_id   uuid NOT NULL REFERENCES capabilities(id),
  version         integer NOT NULL,
  snapshot        jsonb NOT NULL,    -- full capability definition at this version
  changed_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capability_id, version)
);
```

---

## 6. Digital Workforce Tables

### 6.1 `digital_employees`

A Digital Employee is a named, customer-visible business persona. It is not an agent. It is not a bot. It is a trusted team member with a defined role, responsibilities, and a capability profile. Agents are internal execution components — never exposed to customers.

```sql
CREATE TABLE digital_employees (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id),
  name                text NOT NULL,                  -- business name (e.g. "Aria")
  role_title          text NOT NULL,                  -- e.g. "Customer Success Manager"
  persona_description text,
  avatar_url          text,
  status              de_status NOT NULL DEFAULT 'draft',
  autonomy_level      autonomy_level NOT NULL DEFAULT 'supervised',
  is_customer_facing  boolean NOT NULL DEFAULT true,
  settings            jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE TYPE de_status AS ENUM ('draft', 'active', 'paused', 'retired');
CREATE TYPE autonomy_level AS ENUM ('supervised', 'semi_autonomous', 'autonomous');
```

### 6.2 `responsibilities`

A Responsibility is a sustained accountability domain — what a Digital Employee is accountable for as a standing team member. Unlike a Capability, which is executed once, a Responsibility never ends.

```sql
CREATE TABLE responsibilities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  digital_employee_id uuid NOT NULL REFERENCES digital_employees(id),
  name                text NOT NULL,
  description         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

### 6.3 `digital_employee_capabilities`

Junction table assigning Capabilities to Digital Employees. A Capability may be fulfilled by multiple Digital Employees; a Digital Employee may have many Capabilities.

```sql
CREATE TABLE digital_employee_capabilities (
  digital_employee_id uuid NOT NULL REFERENCES digital_employees(id),
  capability_id       uuid NOT NULL REFERENCES capabilities(id),
  is_primary          boolean NOT NULL DEFAULT false,   -- primary DE for this capability
  assigned_at         timestamptz NOT NULL DEFAULT now(),
  assigned_by         uuid REFERENCES users(id),
  PRIMARY KEY (digital_employee_id, capability_id)
);
```

### 6.4 `digital_employee_channels`

Which Channels a Digital Employee is active on.

```sql
CREATE TABLE digital_employee_channels (
  digital_employee_id uuid NOT NULL REFERENCES digital_employees(id),
  channel_id          uuid NOT NULL REFERENCES channels(id),
  is_active           boolean NOT NULL DEFAULT true,
  settings            jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (digital_employee_id, channel_id)
);
```

---

## 7. Agent & Workforce Engine Tables

### 7.1 Agent vs Digital Employee

**Critical distinction:** Digital Employees are customer-visible personas (`digital_employees` table). Agents are internal execution components managed by the Workforce Engine. They are never referenced in customer-facing UI. Agent records track what type of execution component was invoked during a Capability run.

### 7.2 `agents`

```sql
CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  agent_type      agent_type NOT NULL,
  name            text NOT NULL,           -- internal technical name
  description     text,
  model_id        uuid REFERENCES model_configurations(id),
  system_prompt   text,
  tools_config    jsonb NOT NULL DEFAULT '{}',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE agent_type AS ENUM (
  'orchestrator',
  'executor',
  'evaluator',
  'retrieval',
  'planner',
  'specialist'
);
```

### 7.3 `execution_plans`

An Execution Plan is the dynamic runtime plan created by the Workforce Engine before executing a complex Capability. It is distinct from a Workflow (which is a pre-configured orchestration). An Execution Plan is generated per-run and can be reviewed by a human before execution begins, enabling the trust-before-automation principle.

```sql
CREATE TABLE execution_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  capability_run_id   uuid REFERENCES capability_runs(id),
  workflow_run_id     uuid REFERENCES workflow_runs(id),
  status              execution_plan_status NOT NULL DEFAULT 'draft',
  steps               jsonb NOT NULL DEFAULT '[]',   -- ordered array of planned steps
  rationale           text,                          -- why this plan was chosen
  estimated_cost_usd  numeric(10,4),
  requires_approval   boolean NOT NULL DEFAULT false,
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE execution_plan_status AS ENUM (
  'draft', 'pending_approval', 'approved', 'executing', 'completed', 'cancelled', 'failed'
);
```

### 7.4 `capability_runs`

A Capability Run is a single execution instance of a Capability.

```sql
CREATE TABLE capability_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  capability_id       uuid NOT NULL REFERENCES capabilities(id),
  digital_employee_id uuid REFERENCES digital_employees(id),
  triggered_by        uuid REFERENCES users(id),      -- null = system/automated trigger
  trigger_type        trigger_type NOT NULL,
  input_data          jsonb NOT NULL DEFAULT '{}',
  output_data         jsonb,
  status              run_status NOT NULL DEFAULT 'queued',
  started_at          timestamptz,
  completed_at        timestamptz,
  duration_ms         integer,
  error_message       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE run_status AS ENUM (
  'queued', 'running', 'completed', 'failed', 'cancelled', 'pending_approval'
);

CREATE TYPE trigger_type AS ENUM (
  'manual', 'conversation', 'workflow', 'schedule', 'webhook', 'api'
);
```

---

## 8. Workflow Tables

### 8.1 `workflows`

A Workflow is a pre-configured, orchestrated sequence of Capabilities. It represents a repeatable business process with defined steps, branching logic, and error handling.

```sql
CREATE TABLE workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id),
  name            text NOT NULL,
  description     text,
  definition      jsonb NOT NULL DEFAULT '{}',    -- DAG of steps (nodes + edges)
  trigger_config  jsonb NOT NULL DEFAULT '{}',    -- how it is triggered
  is_published    boolean NOT NULL DEFAULT false,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
```

### 8.2 `workflow_versions`

```sql
CREATE TABLE workflow_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     uuid NOT NULL REFERENCES workflows(id),
  version         integer NOT NULL,
  definition      jsonb NOT NULL,
  changed_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);
```

### 8.3 `workflow_runs`

```sql
CREATE TABLE workflow_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  workflow_id     uuid NOT NULL REFERENCES workflows(id),
  triggered_by    uuid REFERENCES users(id),
  trigger_type    trigger_type NOT NULL,
  status          run_status NOT NULL DEFAULT 'queued',
  input_data      jsonb NOT NULL DEFAULT '{}',
  output_data     jsonb,
  started_at      timestamptz,
  completed_at    timestamptz,
  duration_ms     integer,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

### 8.4 `workflow_step_runs`

```sql
CREATE TABLE workflow_step_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  step_key        text NOT NULL,                    -- matches key in workflow definition
  capability_id   uuid REFERENCES capabilities(id),
  status          run_status NOT NULL DEFAULT 'queued',
  input_data      jsonb NOT NULL DEFAULT '{}',
  output_data     jsonb,
  started_at      timestamptz,
  completed_at    timestamptz,
  duration_ms     integer,
  error_message   text,
  sequence_order  integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

---

## 9. Control Fabric Tables

The Control Fabric is the runtime governance layer. Every Action taken by a Digital Employee passes through the Control Fabric before execution. No bypass paths exist. The Policy Engine is a component of the Control Fabric.

### 9.1 `control_fabric_policies`

```sql
CREATE TABLE control_fabric_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  workspace_id        uuid REFERENCES workspaces(id),    -- null = tenant-wide
  name                text NOT NULL,
  description         text,
  policy_type         policy_type NOT NULL,
  scope               policy_scope NOT NULL,
  conditions          jsonb NOT NULL DEFAULT '{}',       -- rule conditions
  actions             jsonb NOT NULL DEFAULT '{}',       -- what to do when matched
  priority            integer NOT NULL DEFAULT 100,
  is_active           boolean NOT NULL DEFAULT true,
  effective_from      timestamptz,
  effective_until     timestamptz,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE policy_type AS ENUM (
  'approval_gate',
  'rate_limit',
  'data_access',
  'channel_restriction',
  'autonomy_boundary',
  'compliance_rule',
  'cost_limit'
);

CREATE TYPE policy_scope AS ENUM (
  'tenant', 'workspace', 'digital_employee', 'capability', 'channel'
);
```

### 9.2 `policy_evaluations`

Every Control Fabric evaluation generates a record. This is the foundation of the Audit Trail for governed actions.

```sql
CREATE TABLE policy_evaluations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  policy_id           uuid NOT NULL REFERENCES control_fabric_policies(id),
  entity_type         text NOT NULL,                  -- what was being evaluated
  entity_id           uuid NOT NULL,
  capability_run_id   uuid REFERENCES capability_runs(id),
  outcome             policy_outcome NOT NULL,
  matched_conditions  jsonb,
  applied_actions     jsonb,
  evaluated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE policy_outcome AS ENUM (
  'allowed', 'blocked', 'requires_approval', 'rate_limited', 'flagged'
);
```

### 9.3 `actions`

An Action is a discrete side-effecting step taken by a Digital Employee — a write to an external system, a message sent, an approval requested. Actions are the unit of Control Fabric oversight.

```sql
CREATE TABLE actions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  capability_run_id   uuid REFERENCES capability_runs(id),
  digital_employee_id uuid REFERENCES digital_employees(id),
  action_type         text NOT NULL,
  description         text NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}',
  reversibility_class reversibility_class NOT NULL,
  status              action_status NOT NULL DEFAULT 'pending',
  policy_evaluation_id uuid REFERENCES policy_evaluations(id),
  executed_at         timestamptz,
  reversed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE action_status AS ENUM (
  'pending', 'approved', 'executing', 'completed', 'rejected', 'reversed', 'failed'
);
```

---

## 10. Knowledge & Memory Tables

### 10.1 Working Memory — Redis, Not Postgres

Working Memory is ephemeral, session-scoped state used by a Digital Employee during an active conversation or Capability run. It is NOT stored in Postgres.

**Implementation:** Redis key pattern `wm:{tenant_id}:{session_id}` with TTL matching the session timeout (default 30 minutes). When a session ends, anything that must be retained is written to `conversation_messages` (for conversation context) or `knowledge_items` (for learned facts to persist).

### 10.2 `knowledge_bases`

```sql
CREATE TABLE knowledge_bases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  workspace_id    uuid REFERENCES workspaces(id),    -- null = tenant-wide
  name            text NOT NULL,
  description     text,
  scope           knowledge_scope NOT NULL DEFAULT 'workspace',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE knowledge_scope AS ENUM ('tenant', 'workspace', 'digital_employee');
```

### 10.3 `knowledge_items`

```sql
CREATE TABLE knowledge_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id),
  title           text NOT NULL,
  content         text NOT NULL,
  content_type    text NOT NULL DEFAULT 'text/plain',
  source_type     text,                              -- 'upload', 'connector_sync', 'manual'
  source_url      text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  embedding       vector(1536),                      -- pgvector; dimension per model
  indexed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
```

### 10.4 `knowledge_item_tags`

```sql
CREATE TABLE knowledge_item_tags (
  knowledge_item_id   uuid NOT NULL REFERENCES knowledge_items(id),
  tag                 text NOT NULL,
  PRIMARY KEY (knowledge_item_id, tag)
);
```

### 10.5 Organisational Memory

Organisational Memory is the set of all Knowledge Items scoped to the Tenant or Workspace that persist beyond individual conversations. It is represented by `knowledge_bases` + `knowledge_items`, not a separate table.

---

## 11. Conversation & Customer Portal Tables

### 11.1 `channels`

A Channel is a first-class domain entity representing an inbound surface through which customers interact with Digital Employees. Channels are the basis for per-channel policies and omnichannel routing.

```sql
CREATE TABLE channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  workspace_id    uuid REFERENCES workspaces(id),
  name            text NOT NULL,
  channel_type    channel_type NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}',       -- API keys, webhook URLs, settings
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE channel_type AS ENUM (
  'web_chat', 'email', 'api', 'voice', 'sms', 'slack', 'teams', 'whatsapp'
);
```

### 11.2 `conversations`

```sql
CREATE TABLE conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id),
  channel_id          uuid NOT NULL REFERENCES channels(id),
  digital_employee_id uuid REFERENCES digital_employees(id),
  external_contact_id uuid,                          -- customer identity (future CRM link)
  status              conversation_status NOT NULL DEFAULT 'active',
  subject             text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE conversation_status AS ENUM (
  'active', 'completed', 'escalated', 'handed_off', 'abandoned'
);
```

### 11.3 `conversation_messages`

```sql
CREATE TABLE conversation_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  role            message_role NOT NULL,
  content         text NOT NULL,
  content_type    text NOT NULL DEFAULT 'text/plain',
  metadata        jsonb NOT NULL DEFAULT '{}',
  sent_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE message_role AS ENUM ('user', 'digital_employee', 'system', 'tool');
```

### 11.4 `handoffs`

A Handoff is a deliberate, accountable transfer of responsibility from a Digital Employee to a human operator (or another Digital Employee). It is distinct from an Escalation. An Escalation is a signal that a threshold was exceeded. A Handoff is the structured transfer action that follows — with context, summary, and recommendation.

```sql
CREATE TABLE handoffs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  conversation_id         uuid NOT NULL REFERENCES conversations(id),
  from_digital_employee_id uuid NOT NULL REFERENCES digital_employees(id),
  to_user_id              uuid REFERENCES users(id),          -- human recipient
  to_digital_employee_id  uuid REFERENCES digital_employees(id), -- DE recipient
  reason                  text NOT NULL,
  context_summary         text NOT NULL,                     -- what happened so far
  recommendation          text,                              -- suggested next step
  priority                handoff_priority NOT NULL DEFAULT 'normal',
  status                  handoff_status NOT NULL DEFAULT 'pending',
  accepted_at             timestamptz,
  resolved_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE handoff_priority AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE handoff_status AS ENUM ('pending', 'accepted', 'resolved', 'expired');
```

### 11.5 `handoff_events`

Event log for all state transitions within a Handoff lifecycle.

```sql
CREATE TABLE handoff_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  handoff_id  uuid NOT NULL REFERENCES handoffs(id),
  event_type  text NOT NULL,            -- 'created', 'accepted', 'note_added', 'resolved'
  actor_id    uuid REFERENCES users(id),
  notes       text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
```

### 11.6 `escalations`

An Escalation is the trigger signal — not the transfer itself. It records that a threshold was breached, which may result in a Handoff being created.

```sql
CREATE TABLE escalations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  conversation_id     uuid NOT NULL REFERENCES conversations(id),
  capability_run_id   uuid REFERENCES capability_runs(id),
  reason              text NOT NULL,
  threshold_type      text,                          -- e.g. 'sentiment', 'complexity', 'policy'
  threshold_value     jsonb,
  handoff_id          uuid REFERENCES handoffs(id), -- null until handoff is created
  created_at          timestamptz NOT NULL DEFAULT now()
);
```

---

## 12. Approval Tables

### 12.1 Approval Philosophy

Approval requirements are driven by the reversibility class of the Action. The less reversible an action, the more governance it requires. This is not a configuration — it is a structural principle encoded in the `capabilities.reversibility_class` and `actions.reversibility_class` columns.

| Reversibility Class | Default Approval Required |
|---|---|
| Fully Reversible | No |
| Partially Reversible | Optional (policy-driven) |
| Difficult to Reverse | Yes — single approver |
| Irreversible | Yes — dual approver recommended |

### 12.2 `approval_requests`

```sql
CREATE TABLE approval_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  action_id           uuid REFERENCES actions(id),
  capability_run_id   uuid REFERENCES capability_runs(id),
  execution_plan_id   uuid REFERENCES execution_plans(id),
  requested_by_de_id  uuid REFERENCES digital_employees(id),
  description         text NOT NULL,
  context_data        jsonb NOT NULL DEFAULT '{}',
  reversibility_class reversibility_class NOT NULL,
  status              approval_status NOT NULL DEFAULT 'pending',
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE approval_status AS ENUM (
  'pending', 'approved', 'rejected', 'expired', 'cancelled'
);
```

### 12.3 `approval_decisions`

```sql
CREATE TABLE approval_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  approval_request_id uuid NOT NULL REFERENCES approval_requests(id),
  decided_by          uuid NOT NULL REFERENCES users(id),
  decision            text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  notes               text,
  decided_at          timestamptz NOT NULL DEFAULT now()
);
```

---

## 13. Connector & Integration Tables

### 13.1 Connector vs Integration

A **Connector** is a configured, reusable binding to an external system — credentials, base URL, auth method. It is set up once.

An **Integration** is the configured use of a Connector within a specific Capability or Workflow — the mapping, transformation rules, and scope of access. One Connector can back many Integrations.

### 13.2 `connectors`

```sql
CREATE TABLE connectors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  name            text NOT NULL,
  connector_type  text NOT NULL,           -- 'salesforce', 'hubspot', 'slack', etc.
  display_name    text NOT NULL,
  credentials     jsonb NOT NULL DEFAULT '{}',  -- encrypted at rest via Supabase Vault
  config          jsonb NOT NULL DEFAULT '{}',
  status          connector_status NOT NULL DEFAULT 'draft',
  last_sync_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE connector_status AS ENUM ('draft', 'active', 'error', 'paused', 'disconnected');
```

### 13.3 `integrations`

```sql
CREATE TABLE integrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  connector_id    uuid NOT NULL REFERENCES connectors(id),
  capability_id   uuid REFERENCES capabilities(id),
  workflow_id     uuid REFERENCES workflows(id),
  name            text NOT NULL,
  field_mappings  jsonb NOT NULL DEFAULT '{}',   -- source → target field mapping
  filters         jsonb NOT NULL DEFAULT '{}',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

### 13.4 `connector_synced_records`

Records synchronized from external systems via a Connector. The name `connector_synced_records` (not `connector_objects`) makes the direction and nature of the data explicit — these are records pulled from external systems, not platform-native objects.

```sql
CREATE TABLE connector_synced_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  connector_id        uuid NOT NULL REFERENCES connectors(id),
  external_id         text NOT NULL,            -- ID in the source system
  record_type         text NOT NULL,            -- 'contact', 'opportunity', 'ticket', etc.
  data                jsonb NOT NULL DEFAULT '{}',
  checksum            text,                     -- hash to detect changes
  first_synced_at     timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz NOT NULL DEFAULT now(),
  deleted_in_source   boolean NOT NULL DEFAULT false,
  UNIQUE (connector_id, external_id, record_type)
);
```

---

## 14. Intelligence & Model Provider Tables

### 14.1 Intelligence Service Boundary

The Intelligence Service is the only component that calls Model Providers. No Capability, Workflow, or Agent calls a model directly. This ensures model portability, cost attribution, and rate limit management are centrally controlled.

### 14.2 `model_providers`

```sql
CREATE TABLE model_providers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,          -- 'anthropic', 'openai', 'google', 'cohere'
  display_name    text NOT NULL,
  api_base_url    text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

### 14.3 `model_definitions`

```sql
CREATE TABLE model_definitions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id             uuid NOT NULL REFERENCES model_providers(id),
  model_id                text NOT NULL UNIQUE,    -- e.g. 'claude-sonnet-5'
  display_name            text NOT NULL,
  context_window_tokens   integer,
  input_price_per_1m      numeric(10,6),           -- USD per 1M input tokens
  output_price_per_1m     numeric(10,6),           -- USD per 1M output tokens
  supports_vision         boolean NOT NULL DEFAULT false,
  supports_tools          boolean NOT NULL DEFAULT false,
  is_active               boolean NOT NULL DEFAULT true,
  deprecated_at           timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
```

### 14.4 `model_configurations`

Tenant-specific model configuration — which model to use for which purpose, with overrides.

```sql
CREATE TABLE model_configurations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  name                text NOT NULL,
  model_definition_id uuid NOT NULL REFERENCES model_definitions(id),
  purpose             text,                         -- 'orchestration', 'conversation', 'retrieval'
  temperature         numeric(3,2),
  max_tokens          integer,
  system_prompt       text,
  is_default          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

---

## 15. AI Token Usage, Cost & FinOps Tables

### 15.1 Phase Placement

AI cost tracking tables are Phase 2 infrastructure. The cost data model must be defined and deployed before any production workloads run, because retroactive attribution is unreliable. Reporting dashboards and rollup aggregations are Phase 5 features built on top of this infrastructure.

### 15.2 `ai_token_usage`

Every call to the Intelligence Service generates a token usage record. This is the atomic unit of AI cost tracking.

```sql
CREATE TABLE ai_token_usage (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  model_definition_id uuid NOT NULL REFERENCES model_definitions(id),
  capability_run_id   uuid REFERENCES capability_runs(id),
  workflow_run_id     uuid REFERENCES workflow_runs(id),
  conversation_id     uuid REFERENCES conversations(id),
  digital_employee_id uuid REFERENCES digital_employees(id),
  workspace_id        uuid REFERENCES workspaces(id),
  input_tokens        integer NOT NULL DEFAULT 0,
  output_tokens       integer NOT NULL DEFAULT 0,
  total_tokens        integer GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
  cost_usd            numeric(12,8),              -- calculated at write time from model pricing
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
```

### 15.3 `ai_cost_budgets`

```sql
CREATE TABLE ai_cost_budgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  workspace_id    uuid REFERENCES workspaces(id),    -- null = tenant-wide
  budget_period   budget_period NOT NULL,
  budget_usd      numeric(10,2) NOT NULL,
  alert_threshold numeric(5,2) NOT NULL DEFAULT 0.80,  -- alert at 80% by default
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE budget_period AS ENUM ('daily', 'weekly', 'monthly');
```

### 15.4 `ai_cost_rollups`

Pre-aggregated cost summaries for fast dashboard queries. Populated by background jobs, not by the critical path.

```sql
CREATE TABLE ai_cost_rollups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  workspace_id    uuid REFERENCES workspaces(id),
  period_type     budget_period NOT NULL,
  period_start    date NOT NULL,
  total_tokens    bigint NOT NULL DEFAULT 0,
  total_cost_usd  numeric(12,4) NOT NULL DEFAULT 0,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, period_type, period_start)
);
```

---

## 16. Billing & Subscription Tables

### 16.1 Feature Flag Split

Feature flags are split into two distinct tables with different scopes and ownership:

- **`plan_features`** — what a billing plan includes. Owned by Finance/Product. Controls feature entitlements per subscription tier. Changes when plans change.
- **`platform_feature_flags`** — operational flags for gradual rollout, A/B testing, kill switches. Owned by Engineering/Operations. Changes when deploying new code.

Mixing these was an anti-pattern: billing tier changes should not require engineering deployments, and kill switches should not be coupled to billing logic.

### 16.2 `billing_plans`

```sql
CREATE TABLE billing_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,             -- 'starter', 'growth', 'enterprise'
  display_name    text NOT NULL,
  price_monthly   numeric(10,2),
  price_annual    numeric(10,2),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

### 16.3 `plan_features`

```sql
CREATE TABLE plan_features (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid NOT NULL REFERENCES billing_plans(id),
  feature_key     text NOT NULL,
  is_enabled      boolean NOT NULL DEFAULT true,
  limit_value     integer,                           -- null = unlimited
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, feature_key)
);
```

### 16.4 `billing_subscriptions`

```sql
CREATE TABLE billing_subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) UNIQUE,
  plan_id                 uuid NOT NULL REFERENCES billing_plans(id),
  status                  subscription_status NOT NULL DEFAULT 'trial',
  trial_ends_at           timestamptz,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  stripe_customer_id      text,
  stripe_subscription_id  text,
  cancelled_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE subscription_status AS ENUM (
  'trial', 'active', 'past_due', 'cancelled', 'paused'
);
```

### 16.5 `platform_feature_flags`

```sql
CREATE TABLE platform_feature_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key        text NOT NULL UNIQUE,
  description     text,
  is_enabled      boolean NOT NULL DEFAULT false,
  rollout_percent integer NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  target_tenants  uuid[],                           -- explicit allowlist; null = percentage-based
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

### 16.6 `usage_records`

```sql
CREATE TABLE usage_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  metric_key      text NOT NULL,                    -- 'capability_runs', 'de_count', etc.
  quantity        integer NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL
);
```

---

## 17. Audit, Event & Compliance Tables

### 17.1 `audit_trail`

The Audit Trail is immutable. No application code may UPDATE or DELETE audit rows. RLS enforces this. The `human_initiator_id` records who started the chain that led to this event — enabling the Delegation Chain principle (human initiator + DE executor, both on record).

```sql
CREATE TABLE audit_trail (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  event_type            text NOT NULL,               -- 'action.executed', 'policy.blocked', etc.
  entity_type           text NOT NULL,               -- 'capability_run', 'digital_employee', etc.
  entity_id             uuid NOT NULL,
  digital_employee_id   uuid REFERENCES digital_employees(id),
  human_initiator_id    uuid REFERENCES users(id),   -- delegation chain: who started this
  actor_type            text NOT NULL,               -- 'user', 'digital_employee', 'system'
  actor_id              uuid,
  action_description    text NOT NULL,
  outcome               text NOT NULL,               -- 'success', 'failure', 'blocked'
  metadata              jsonb NOT NULL DEFAULT '{}',
  ip_address            inet,
  occurred_at           timestamptz NOT NULL DEFAULT now()
);

-- Append-only: no UPDATE or DELETE permitted via RLS
CREATE POLICY audit_insert_only ON audit_trail
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- No UPDATE policy = updates blocked
-- No DELETE policy = deletes blocked
```

### 17.2 `domain_events`

Domain events are the integration backbone — published when significant domain transitions occur (DE hired, Capability completed, Handoff created). Consumers subscribe to derive state.

```sql
CREATE TABLE domain_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  event_type      text NOT NULL,                     -- 'de.hired', 'capability.completed'
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  schema_version  integer NOT NULL DEFAULT 1,
  published_at    timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
```

---

## 18. Analytics & Optimization Tables

### 18.1 `performance_metrics`

```sql
CREATE TABLE performance_metrics (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  entity_type         text NOT NULL,
  entity_id           uuid NOT NULL,
  metric_key          text NOT NULL,
  metric_value        numeric NOT NULL,
  dimension_data      jsonb NOT NULL DEFAULT '{}',
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  period_start        timestamptz,
  period_end          timestamptz
);
```

### 18.2 `insights`

```sql
CREATE TABLE insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  workspace_id    uuid REFERENCES workspaces(id),
  insight_type    text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,
  entity_type     text,
  entity_id       uuid,
  severity        text NOT NULL DEFAULT 'info',
  is_acknowledged boolean NOT NULL DEFAULT false,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
```

### 18.3 `recommendations`

```sql
CREATE TABLE recommendations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  insight_id      uuid REFERENCES insights(id),
  title           text NOT NULL,
  description     text NOT NULL,
  action_type     text,
  action_payload  jsonb,
  status          text NOT NULL DEFAULT 'open',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

---

## 19. Soft Deletes, Versioning & History

### 19.1 Soft Delete Pattern

Tables that support soft delete include a `deleted_at timestamptz` column. The RLS policy and application queries filter `WHERE deleted_at IS NULL` by default. Hard deletes only occur during data retention archival (see Section 22).

Tables with soft delete:
- `tenants`, `workspaces`, `capabilities`, `digital_employees`, `workflows`, `knowledge_items`, `connectors`

Tables without soft delete (append-only or junction):
- `audit_trail`, `domain_events`, `ai_token_usage`, `team_members`, `digital_employee_capabilities`

### 19.2 Versioning Pattern

Entities with version history follow the pattern: a primary table stores the current state, a `_versions` table stores historical snapshots.

| Primary Table | Version Table |
|---|---|
| `capabilities` | `capability_versions` |
| `workflows` | `workflow_versions` |

`workspaces` are NOT versioned. Workspace configuration changes are tracked in `audit_trail`. The `workspace_versions` table was removed — workspaces are not versionable products; they are operational contexts.

### 19.3 `_history` Pattern

For entities where column-level change tracking is required (e.g., billing plan changes), a `_history` table stores a snapshot on each write:

```sql
-- Example: billing_subscription_history
CREATE TABLE billing_subscription_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id     uuid NOT NULL REFERENCES billing_subscriptions(id),
  snapshot            jsonb NOT NULL,
  changed_at          timestamptz NOT NULL DEFAULT now(),
  changed_by          uuid REFERENCES users(id)
);
```

---

## 20. Indexing & Performance Strategy

### 20.1 Standard Indexes

Every table with `tenant_id` gets a composite index on `(tenant_id, created_at DESC)` for time-ordered queries within a tenant.

```sql
-- Applied to every tenant-scoped table
CREATE INDEX idx_<table>_tenant_created ON <table>(tenant_id, created_at DESC);
```

### 20.2 Foreign Key Indexes

All foreign key columns are indexed. Postgres does not auto-index FKs. Missing FK indexes cause slow JOIN and CASCADE operations.

### 20.3 Lookup Indexes

```sql
-- Capability run status filtering
CREATE INDEX idx_capability_runs_status ON capability_runs(tenant_id, status) WHERE deleted_at IS NULL;

-- Knowledge item embedding search
CREATE INDEX idx_knowledge_items_embedding ON knowledge_items USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Audit trail time-range queries
CREATE INDEX idx_audit_trail_occurred ON audit_trail(tenant_id, occurred_at DESC);

-- Conversation by DE and status
CREATE INDEX idx_conversations_de_status ON conversations(tenant_id, digital_employee_id, status);

-- Handoff pending queue
CREATE INDEX idx_handoffs_pending ON handoffs(tenant_id, status, created_at DESC)
  WHERE status = 'pending';

-- Policy evaluation by entity
CREATE INDEX idx_policy_evals_entity ON policy_evaluations(tenant_id, entity_type, entity_id);
```

### 20.4 Partial Indexes

Use partial indexes for hot query patterns over filtered subsets:

```sql
-- Active digital employees only
CREATE INDEX idx_de_active ON digital_employees(tenant_id, workspace_id)
  WHERE deleted_at IS NULL AND status = 'active';

-- Pending approval requests
CREATE INDEX idx_approvals_pending ON approval_requests(tenant_id, created_at DESC)
  WHERE status = 'pending';
```

---

## 21. Row-Level Security Strategy

### 21.1 Policy Structure

Three categories of RLS policy:

| Category | Who | Scope |
|---|---|---|
| Tenant user | Authenticated user with tenant claim | Own tenant data only |
| Service role | Supabase `service_role` key (background jobs, admin) | Bypasses RLS |
| Audit append-only | Authenticated user | INSERT only; no UPDATE/DELETE |

### 21.2 Standard Tenant Policy

```sql
-- Template for all tenant-scoped tables
CREATE POLICY "tenant_users_own_tenant" ON <table>
  FOR ALL
  TO authenticated
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);
```

### 21.3 Platform Tables

`billing_plans`, `model_providers`, `model_definitions`, `platform_feature_flags` are platform-managed tables. They are readable by all authenticated users but writable only via service role.

```sql
CREATE POLICY "read_platform_tables" ON billing_plans
  FOR SELECT TO authenticated USING (true);
-- No INSERT/UPDATE/DELETE policy for authenticated users
```

### 21.4 User-Scoped Policies

Some tables require sub-tenant scoping (e.g., a user can only update their own profile):

```sql
CREATE POLICY "users_own_record" ON users
  FOR ALL
  TO authenticated
  USING (
    tenant_id = (current_setting('app.tenant_id'))::uuid
    AND auth_user_id = auth.uid()
  );
```

---

## 22. Data Retention & Archival

### 22.1 Retention Policy

| Data Category | Active Retention | Archive Period | Delete |
|---|---|---|---|
| Audit Trail | Indefinite in primary DB | Archive to cold storage after 2 years | Never (compliance) |
| Conversation messages | 12 months in primary DB | Archive to cold storage for 5 years | Per tenant data deletion request |
| AI token usage | 24 months | Archive for 5 years (billing evidence) | Per deletion request |
| Capability run outputs | 6 months | Archive for 1 year | After archive period |
| Domain events (processed) | 90 days | Not archived | Delete after 90 days |
| Knowledge items (deleted) | 30 days soft-delete | Not archived | Hard delete after 30 days |

### 22.2 Archival Strategy

- Archive jobs run as Supabase Edge Functions on a nightly schedule
- Archived rows are copied to a cold storage table (append-only, read-only RLS)
- Hard delete from primary table happens only after successful archive confirmation
- Tenant data deletion requests (GDPR right to erasure) are handled by a dedicated deletion job that PII-scrubs conversation content and deletes non-audit records

### 22.3 GDPR / Right to Erasure

Audit trail rows are never deleted. PII within audit metadata is anonymised (user email replaced with `[REDACTED]`, names replaced with `[ANONYMISED]`). The audit event itself (that a Capability ran, that a policy was evaluated) is retained. What is scrubbed is the personal data in the payload.

---

## 23. Migration Strategy

### 23.1 Migration Principles

1. **Every migration is a single SQL file** — one file per named change. Files are numbered sequentially (`20260701_001_create_tenants.sql`).
2. **Migrations are additive** — add columns, add tables. Never rename in place.
3. **Breaking changes require three migrations** — (1) add new column, (2) backfill data, (3) drop old column (separate deploy).
4. **Every migration is reviewed by a second engineer** before applying to production.
5. **All migrations run in transactions** — if any statement fails, the whole migration rolls back.

### 23.2 Migration File Structure

```sql
-- 20260701_001_create_tenants.sql

BEGIN;

CREATE TYPE tenant_status AS ENUM ('trial', 'active', 'suspended', 'cancelled');

CREATE TABLE tenants (
  -- ... column definitions
);

CREATE INDEX idx_tenants_slug ON tenants(slug);

-- Insert platform seed data if needed
-- INSERT INTO ...

COMMIT;
```

### 23.3 Zero-Downtime Pattern

For tables that cannot tolerate a lock:

1. Add column with `DEFAULT` (no lock required in Postgres 11+)
2. Backfill in batches via a background job
3. Add `NOT NULL` constraint once backfill is complete (validates without full table lock in Postgres 12+)

---

## 24. Seed Data Strategy

### 24.1 Platform Seed (runs on every environment)

Platform seed data is the set of records that must exist before any tenant can be provisioned. This data is owned by the platform team and checked into version control.

| Table | Seed Data |
|---|---|
| `model_providers` | Anthropic, OpenAI, Google, Cohere |
| `model_definitions` | Claude Sonnet 5, Claude Haiku 4.5, GPT-4o, Gemini 2.0 |
| `billing_plans` | starter, growth, enterprise |
| `plan_features` | Per-plan feature entitlements |
| `platform_feature_flags` | All flags defaulting to `is_enabled = false` |

### 24.2 Tenant Seed (runs on tenant provisioning)

When a new tenant is created, the provisioning job seeds:

- Default `workspace` named after the organisation
- Default `control_fabric_policies` (platform baseline policies)
- Default `knowledge_base` (Workspace scope)
- Default `channel` (Web Chat)
- Trial `billing_subscription`

### 24.3 Development Seed

Development and staging environments include additional seed data:

- Demo tenant with realistic Digital Employees, Capabilities, and Workflows
- Sample Connector configurations (not connected to real external systems)
- Synthetic conversation history for UI development

---

## 25. Database Anti-Patterns

The following patterns are explicitly prohibited:

### 25.1 Cross-Tenant Joins

**Never** write a query that joins across `tenant_id` values. Even in admin reporting contexts, use separate queries per tenant and aggregate in application code. Cross-tenant joins are a data isolation failure, not a performance optimisation.

### 25.2 Working Memory as a DB Table

Do not create a `working_memory` or `session_state` table in Postgres. Ephemeral session state belongs in Redis with a TTL. A Postgres table for session state creates write amplification on the critical path, does not expire automatically, and will grow without bound.

### 25.3 Storing Raw Model Responses Without Attribution

Never store a raw LLM output in any table without also storing `model_definition_id`, `capability_run_id`, and `recorded_at`. Unattributed model responses cannot be audited, cannot be attributed for cost, and cannot be traced if a response is problematic.

### 25.4 Embedding Policies in Application Code

Control Fabric policies belong in `control_fabric_policies`. Do not encode access rules, approval requirements, or rate limits as hardcoded constants in application code. Rules must be queryable, auditable, and changeable without a code deployment.

### 25.5 Using `jsonb` as a Schema Escape Hatch

`jsonb` columns are appropriate for truly dynamic, unpredictable structures (tool call payloads, external system records, user-defined metadata). They are not appropriate for data that will be queried, filtered, or sorted. If you find yourself writing `WHERE jsonb_column->>'status' = 'active'`, the field should be a real column.

### 25.6 Conflating Digital Employees and Agents in the Schema

`digital_employees` and `agents` are separate tables because they are separate concepts. An `agent_id` should never appear in a customer-facing context. A `digital_employee_id` should never be used to track internal execution routing. The boundary is structural, not a convention.

### 25.7 Omitting `human_initiator_id` from Audit Records

Every audit event that results from a human action — even if several automation layers intervene — must trace back to the human who started the chain. The `human_initiator_id` field in `audit_trail` is not optional for human-initiated flows. Losing this attribution breaks the Delegation Chain principle and compliance requirements.

---

## 26. Final Recommended Table List

### Phase 1 Tables (MVP — Core Platform)

| # | Table | Domain |
|---|---|---|
| 1 | `tenants` | Platform |
| 2 | `organisations` | Platform |
| 3 | `users` | Platform |
| 4 | `teams` | Platform |
| 5 | `team_members` | Platform |
| 6 | `workspaces` | Workspace |
| 7 | `capabilities` | Workspace |
| 8 | `capability_versions` | Workspace |
| 9 | `digital_employees` | Digital Workforce |
| 10 | `responsibilities` | Digital Workforce |
| 11 | `digital_employee_capabilities` | Digital Workforce |
| 12 | `digital_employee_channels` | Digital Workforce |
| 13 | `agents` | Workforce Engine |
| 14 | `capability_runs` | Workforce Engine |
| 15 | `workflows` | Workflow |
| 16 | `workflow_versions` | Workflow |
| 17 | `workflow_runs` | Workflow |
| 18 | `workflow_step_runs` | Workflow |
| 19 | `control_fabric_policies` | Control Fabric |
| 20 | `policy_evaluations` | Control Fabric |
| 21 | `actions` | Control Fabric |
| 22 | `knowledge_bases` | Knowledge |
| 23 | `knowledge_items` | Knowledge |
| 24 | `knowledge_item_tags` | Knowledge |
| 25 | `channels` | Conversation |
| 26 | `conversations` | Conversation |
| 27 | `conversation_messages` | Conversation |
| 28 | `escalations` | Conversation |
| 29 | `handoffs` | Conversation |
| 30 | `handoff_events` | Conversation |
| 31 | `approval_requests` | Approval |
| 32 | `approval_decisions` | Approval |
| 33 | `connectors` | Connector |
| 34 | `integrations` | Connector |
| 35 | `connector_synced_records` | Connector |
| 36 | `model_providers` | Intelligence |
| 37 | `model_definitions` | Intelligence |
| 38 | `model_configurations` | Intelligence |
| 39 | `billing_plans` | Billing |
| 40 | `plan_features` | Billing |
| 41 | `billing_subscriptions` | Billing |
| 42 | `usage_records` | Billing |
| 43 | `audit_trail` | Audit |
| 44 | `domain_events` | Audit |

### Phase 2 Tables (AI FinOps + Operational Intelligence)

| # | Table | Domain |
|---|---|---|
| 45 | `ai_token_usage` | FinOps |
| 46 | `ai_cost_budgets` | FinOps |
| 47 | `execution_plans` | Workforce Engine |
| 48 | `platform_feature_flags` | Platform |

### Phase 3 Tables (Analytics + Optimization)

| # | Table | Domain |
|---|---|---|
| 49 | `performance_metrics` | Analytics |
| 50 | `insights` | Analytics |
| 51 | `recommendations` | Analytics |

### Phase 5 Tables (Reporting Infrastructure)

| # | Table | Domain |
|---|---|---|
| 52 | `ai_cost_rollups` | FinOps Reporting |
| 53 | `billing_subscription_history` | Billing History |

**Total: 53 tables across 5 phases.**

*Not a table:* Working Memory (Redis), Platform Seed Config (migration files), Dashboard state (application layer).

---

## 27. Implementation Priorities

### Phase 1 — Foundation (Weeks 1–4)

**Goal:** Authenticated multi-tenant shell with a single Digital Employee that can run a Capability and produce an Audit Trail entry.

1. `tenants`, `organisations`, `users` + Supabase Auth integration
2. `workspaces`, `capabilities`, `capability_versions`
3. `digital_employees`, `responsibilities`, `digital_employee_capabilities`
4. `agents`, `capability_runs`
5. `control_fabric_policies`, `policy_evaluations`, `actions`
6. `audit_trail`, `domain_events`
7. `billing_plans`, `billing_subscriptions`, `plan_features` (seed data only)
8. `model_providers`, `model_definitions`, `model_configurations` (Anthropic only)

**RLS deployed on every table from day one.** Not added later.

### Phase 2 — AI FinOps + Execution Plans (Weeks 5–8)

**Goal:** Every token tracked, every cost attributed, Execution Plans enabling human review before automated action.

1. `ai_token_usage`, `ai_cost_budgets`
2. `execution_plans`
3. `platform_feature_flags`
4. `usage_records` with metered billing hooks

### Phase 3 — Knowledge, Conversation & Connectors (Weeks 9–14)

**Goal:** Digital Employees with knowledge, conversational capability across channels, and connector-backed data access.

1. `knowledge_bases`, `knowledge_items`, `knowledge_item_tags` + pgvector index
2. `channels`, `conversations`, `conversation_messages`
3. `handoffs`, `handoff_events`, `escalations`
4. `approval_requests`, `approval_decisions`
5. `connectors`, `integrations`, `connector_synced_records`
6. `teams`, `team_members`

### Phase 4 — Workflows + Multi-Model (Weeks 15–20)

**Goal:** Orchestrated multi-step workflows, full model provider portability.

1. `workflows`, `workflow_versions`, `workflow_runs`, `workflow_step_runs`
2. Additional `model_providers` + `model_definitions` (OpenAI, Google, Cohere)
3. `digital_employee_channels` + omnichannel routing

### Phase 5 — Analytics & Reporting (Weeks 21–26)

**Goal:** Actionable insights, cost rollups, subscription history, optimisation recommendations.

1. `performance_metrics`, `insights`, `recommendations`
2. `ai_cost_rollups` (background aggregation jobs)
3. `billing_subscription_history`

---

*End of Document — DreamTeam AI Database Design v1.0*
