# 09 — API and Integration Standards

**DreamTeam AI — Enterprise API & Integration Blueprint**
Version 1.0 | 2026-07-01

---

## Table of Contents

1. [API Philosophy](#1-api-philosophy)
2. [API Layers](#2-api-layers)
3. [Capability-Based API Design](#3-capability-based-api-design)
4. [Multi-Tenant API Safety](#4-multi-tenant-api-safety)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [Request & Response Standards](#6-request--response-standards)
7. [Error Handling Standards](#7-error-handling-standards)
8. [API Versioning](#8-api-versioning)
9. [Idempotency & Reliability](#9-idempotency--reliability)
10. [Async Operations](#10-async-operations)
11. [Webhook Standards](#11-webhook-standards)
12. [Connector Architecture](#12-connector-architecture)
13. [Integration Standards](#13-integration-standards)
14. [Tool Interface Standards](#14-tool-interface-standards)
15. [AI Tool Compatibility & MCP Readiness](#15-ai-tool-compatibility--mcp-readiness)
16. [Public API Future](#16-public-api-future)
17. [SDK Standards](#17-sdk-standards)
18. [Rate Limiting & Quotas](#18-rate-limiting--quotas)
19. [API Security](#19-api-security)
20. [Data Mapping Standards](#20-data-mapping-standards)
21. [Events & Event Naming](#21-events--event-naming)
22. [Audit Requirements](#22-audit-requirements)
23. [Observability Standards](#23-observability-standards)
24. [Documentation Standards](#24-documentation-standards)
25. [API Anti-Patterns](#25-api-anti-patterns)
26. [Final API Design Rules](#26-final-api-design-rules)

---

## 1. API Philosophy

### 1.1 What DreamTeam APIs Must Express

DreamTeam's APIs are not a technical interface to a database. They are a business interface to a Digital Workforce Platform. Every API design decision must be evaluated against one question: **does this express a domain concept that a business administrator, developer, or partner would recognise?**

APIs that expose infrastructure — agents, embeddings, model invocations, orchestration pipelines, vector indices — are implementation leakage. They belong behind the platform boundary, not in the contract.

### 1.2 Core API Principles

**APIs express domain concepts.**
Every endpoint, resource, and field name uses the vocabulary of `docs/05_Core_Domain_Model.md`. `digital_employees`, not `agents`. `capabilities`, not `skills` or `functions`. `handoffs`, not `transfer_events`. Domain terminology is permanent; infrastructure terminology is not.

**APIs are organisation-safe by construction.**
Every API that touches tenant data requires an authenticated organisation context. There is no opt-in tenant scoping — it is structural. An API that can be called without an organisation context is a platform API, not a product API, and must be explicitly designated and audited as such.

**APIs are permission-aware at every layer.**
Authentication proves identity. Authorisation proves entitlement. Both are evaluated on every request — not once at login. Role, policy, and control fabric checks apply at the API boundary before any business logic executes.

**APIs are auditable.**
Every API call that creates, modifies, triggers, or deletes a domain entity generates an Audit Trail entry. APIs are not silent. The Audit Trail is not optional for consequential operations.

**APIs are versioned from day one.**
No public API is released without a version. Unversioned APIs are technical debt with a ticking clock. Versioning is not added when a breaking change is needed — it is the starting state.

**APIs are boring, predictable, and stable.**
Consistent naming. Consistent error shapes. Consistent pagination. Consistent timestamps. Developer ergonomics compound over years: a consistent API surface means fewer support tickets, faster integrations, and faster SDK generation. Novelty in an API is a warning sign.

**APIs support business capabilities — not infrastructure complexity.**
A developer integrating with DreamTeam should be able to trigger a Capability, subscribe to events, manage knowledge, and handle approvals without understanding multi-agent orchestration, vector retrieval, or model provider routing. That complexity is the platform's responsibility.

**APIs hide internal agent complexity from customers.**
The Workforce Engine, Agents, Execution Plans, Intelligence Service calls, and model provider routing are internal. They do not appear in API responses, error messages, or webhook payloads. Customers interact with Digital Employees and Capabilities — never with the machinery underneath.

### 1.3 The Identity Contract

A critical precision from the domain model must govern every API:

- **`organisation_id`** — the customer-visible business entity identifier. Used in all public and partner APIs.
- **`tenant_id`** — the platform's internal isolation boundary. Used in internal service calls and database operations. Never exposed in public API responses.

The API gateway resolves `organisation_id` → `tenant_id` on every authenticated request. Public API documentation references `organisation_id` only.

---

## 2. API Layers

### 2.1 Layer Overview

DreamTeam operates five distinct API layers, each with a different audience, trust level, and stability contract.

| Layer | Audience | Stability | Auth Model |
|---|---|---|---|
| Frontend Application APIs | DreamTeam UI | Internal, may change | User session |
| Internal Service APIs | Backend services | Internal, versioned loosely | Service token |
| Capability Execution APIs | Tenant admins, developers | Public, strictly versioned | API key / OAuth |
| Admin & Platform APIs | DreamTeam operations | Internal / platform admin | Platform admin token |
| Public Partner & Marketplace APIs | Partners, ISVs, integrators | Public, strictly versioned | OAuth / partner key |

### 2.2 Frontend Application APIs

**Audience:** DreamTeam's React frontend exclusively.
**Stability:** Internal. May change without notice.
**Implementation:** Supabase auto-generated REST and Realtime APIs, supplemented by Edge Functions for business logic.

These APIs are not documented externally. They are not stable. They do not have a versioning contract. They exist to serve the UI. No external party should depend on them.

### 2.3 Internal Service APIs

**Audience:** Backend services, Edge Functions, background workers.
**Stability:** Internal. Breaking changes require coordination between services.
**Implementation:** Supabase Edge Functions with service-role credentials. Direct database access where appropriate.

Internal APIs bypass RLS via service-role key. Every internal API call that acts on behalf of a user or digital employee must explicitly carry and record the originating `organisation_id`, `actor_id`, and `human_initiator_id` for audit purposes. Service-role access is not anonymous access.

### 2.4 Capability Execution APIs

**Audience:** Tenant developers, workflow builders, external triggering systems.
**Stability:** Public. Strictly versioned. Breaking changes require deprecation windows.

This is the primary developer-facing layer. It exposes Capabilities as invocable business operations. The Workforce Engine executes internally; the API exposes only the capability contract — inputs, outputs, status lifecycle, and approval state.

Key surface:
```
POST   /v1/capabilities/{capability_id}/run
GET    /v1/capability-runs/{run_id}
GET    /v1/capability-runs/{run_id}/output
POST   /v1/capability-runs/{run_id}/cancel
GET    /v1/capabilities
GET    /v1/capabilities/{capability_id}
```

### 2.5 Admin & Platform APIs

**Audience:** DreamTeam operations team, support tooling, tenant provisioning systems.
**Stability:** Internal. Not exposed to customers.

Includes tenant provisioning, plan management, feature flag administration, platform-wide audit queries, and service health operations. Requires platform admin token — not available via customer API keys.

Tenant provisioning endpoint:
```
POST   /platform/v1/tenants                    -- provision new tenant
PATCH  /platform/v1/tenants/{tenant_id}        -- update tenant config
POST   /platform/v1/tenants/{tenant_id}/suspend
POST   /platform/v1/tenants/{tenant_id}/reinstate
```

### 2.6 Public Partner & Marketplace APIs

**Audience:** ISVs, technology partners, marketplace publishers.
**Stability:** Public. Strictly versioned. Governed by partner agreement.

Exposes the Publisher API for submitting and managing Marketplace artifacts (Capability templates, Connector packages, Digital Employee templates). Also exposes the install surface for Marketplace items into a tenant.

```
GET    /partner/v1/marketplace/listings
POST   /partner/v1/marketplace/listings            -- publish artifact
PUT    /partner/v1/marketplace/listings/{id}       -- update listing
POST   /partner/v1/marketplace/listings/{id}/submit-for-review
POST   /v1/marketplace/install/{listing_id}        -- install into tenant
```

### 2.7 What Is Not an API Layer

The following are internal components, not API layers:

- **Workforce Engine** — internal orchestrator; never directly callable
- **Intelligence Service** — internal abstraction; never directly callable
- **Control Fabric policy evaluator** — internal runtime; never directly callable
- **Agent coordination** — internal execution; never directly callable

If a developer needs to trigger a Capability, they use the Capability Execution API. The internal machinery is the platform's responsibility.

---

## 3. Capability-Based API Design

### 3.1 Capabilities as First-Class API Resources

DreamTeam's public API is capability-first. A Capability represents a discrete, named business outcome. The API contract for a Capability is the single source of truth for what it accepts, produces, requires, and costs.

Every Capability has a stable `capability_id` (UUID) and a human-readable `slug` (e.g. `qualify-lead`, `answer-question`). Either may be used to address a Capability in API calls.

### 3.2 Capability Run Lifecycle

```
POST /v1/capabilities/{capability_id}/run
```

**Request body:**
```json
{
  "organisation_id": "org_...",
  "actor_id": "usr_...",
  "idempotency_key": "idem_...",
  "input": {
    "customer_name": "Acme Corp",
    "query": "What is your cancellation policy?"
  },
  "context": {
    "conversation_id": "conv_...",
    "channel": "web_chat"
  },
  "options": {
    "async": true,
    "notify_webhook": "https://acme.com/hooks/dt"
  }
}
```

**Response (async):**
```json
{
  "run_id": "run_...",
  "capability_id": "cap_...",
  "status": "queued",
  "created_at": "2026-07-01T12:00:00Z",
  "estimated_duration_ms": 2000,
  "poll_url": "/v1/capability-runs/run_..."
}
```

### 3.3 Capability Run Status Lifecycle

```
queued
  └── running
        ├── waiting_for_approval
        │     ├── approved → running (resumes)
        │     └── rejected → cancelled
        ├── completed
        ├── failed
        └── cancelled
```

All status transitions are events in the Audit Trail. All transitions where `waiting_for_approval` is entered generate an `approval.requested` event and notify configured approvers.

### 3.4 Capability API Contract Schema

Every Capability exposes a complete API contract:

```json
{
  "capability_id": "cap_...",
  "slug": "qualify-lead",
  "name": "Qualify Lead",
  "description": "Evaluates a prospect record against ICP criteria and returns a qualification score with reasoning.",
  "workspace_id": "ws_...",
  "organisation_id": "org_...",
  "version": 3,
  "input_schema": {
    "type": "object",
    "required": ["lead_id"],
    "properties": {
      "lead_id": { "type": "string" },
      "additional_context": { "type": "string" }
    }
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "qualified": { "type": "boolean" },
      "score": { "type": "number", "minimum": 0, "maximum": 100 },
      "reasoning": { "type": "string" },
      "recommended_next_action": { "type": "string" }
    }
  },
  "permissions_required": ["capabilities:run", "connectors:crm:read"],
  "required_connectors": ["salesforce"],
  "approval_rules": {
    "requires_approval": false,
    "approval_threshold": null
  },
  "reversibility_class": "fully_reversible",
  "async_supported": true,
  "sync_timeout_ms": 10000,
  "audit_behavior": "always",
  "estimated_cost_usd": 0.004
}
```

### 3.5 Sync vs Async

Capabilities under approximately 5 seconds may run synchronously. Capabilities requiring connector reads, multi-step workflows, or human approval must run asynchronously. The `async` flag in the request options overrides platform defaults.

Synchronous response returns the completed output directly. Asynchronous response returns a `run_id` and `poll_url`. Webhooks deliver status updates without polling.

---

## 4. Multi-Tenant API Safety

### 4.1 Organisation ID Is Always Required

Every API call that touches tenant data must carry an `organisation_id`. This is not derived from the auth token alone — it is an explicit parameter. This prevents accidental cross-organisation access when a user belongs to multiple organisations (future multi-org support).

The `organisation_id` is validated against the authenticated user's memberships on every request. A valid token with an invalid `organisation_id` returns `403 Forbidden`, not `404 Not Found` — the distinction matters for information disclosure.

### 4.2 Membership Validation

Membership is checked after authentication and before any data access:

1. Resolve JWT → `user_id` + `auth_tenant_id`
2. Validate `organisation_id` from request → confirm membership
3. Resolve `organisation_id` → internal `tenant_id`
4. Set `app.tenant_id` session variable (activates RLS)
5. Proceed with request

If step 2 fails: `403 Forbidden`. If step 3 fails: `500` (internal mapping error — alert triggered).

### 4.3 Permission Checks

After membership validation, permission checks evaluate:

1. **Role check** — does the user's role permit this operation? (e.g. `viewer` cannot trigger Capability runs)
2. **Policy check** — does the Control Fabric permit this operation given active policies?
3. **Resource check** — does the requested resource belong to this organisation?

All three must pass. Failure at any layer returns `403` with an error code indicating which layer blocked the request (without leaking policy details).

### 4.4 Cross-Organisation Restrictions

- No API may return data from multiple organisations in a single response
- No search, filter, or aggregation query may cross organisation boundaries
- Error messages must never include data from another organisation (e.g. "a capability with that name already exists" — safe; "capability `qualify-lead` owned by Acme Corp already exists" — leaks cross-tenant data)
- Logs must be filtered at write time — no raw SQL errors containing cross-tenant IDs

### 4.5 Platform Admin Access

Platform admin operations use a separate token issued to DreamTeam operations. These tokens:

- Are not issued to customers under any circumstances
- Carry an explicit `platform_admin: true` claim
- Bypass organisation-level permission checks but not audit requirements
- Generate their own audit category: `platform_admin.*` events
- Are rotated on a maximum 90-day cycle

### 4.6 Service Account Access

Background jobs, scheduled workflows, and connector sync processes use service accounts:

- Issued per-organisation, not per-user
- Scoped to specific capability groups or connector types
- Cannot perform administrative operations (plan changes, user management)
- Generate audit events attributed to `actor_type: "service_account"` with `service_account_id`
- Revocable immediately without affecting user access

### 4.7 Tenant Leakage Prevention

**In errors:** Error messages are generic at the boundary. Internal details (table names, SQL errors, tenant IDs, other organisation names) never appear in error responses.

**In logs:** Application logs are tagged with `tenant_id` at write time. Log queries in observability tooling enforce tenant isolation — operations staff cannot accidentally see cross-tenant log streams.

**In search:** Full-text and semantic search queries are always scoped to the resolved `tenant_id`. No global search endpoint exists.

**In cache:** Cache keys always include `tenant_id` as a prefix. Shared cache layers must never use a key that could be resolved by another tenant.

**In analytics:** Aggregated analytics pipelines apply tenant filtering at source — not at the reporting layer. Report generation must not produce data that could reveal another tenant's activity even through inference.

---

## 5. Authentication & Authorization

### 5.1 Authentication Methods

**User Session Auth**
Supabase Auth JWT. Issued at login, carries `user_id`, `tenant_id`, and `role`. Expires after 1 hour; refresh tokens extend sessions. Used by the UI and developer-facing API calls on behalf of a logged-in user.

**API Keys**
Long-lived tokens issued to organisations for programmatic access. Prefixed: `dtk_live_` (production) and `dtk_test_` (sandbox). Stored as hashed values — the raw key is shown once at creation. API keys carry a scope list defining which Capability groups and API surfaces they may access. Rotatable without invalidating other keys.

**Service-to-Service Auth**
Supabase service-role key for internal services. Edge-to-edge calls between DreamTeam services use short-lived signed tokens (HMAC-SHA256, 5-minute TTL) carrying the service identity, the originating `tenant_id`, and the `human_initiator_id` if applicable.

**OAuth 2.0**
For partner integrations and future public API access. Supports Authorization Code flow (user-authorised access) and Client Credentials flow (machine-to-machine). Scopes map to Capability groups and resource types.

**Future: SAML / OIDC**
Enterprise SSO via SAML 2.0 or OIDC. Identity provider assertions are validated and mapped to DreamTeam user accounts at the Supabase Auth layer. DreamTeam never receives or stores IdP credentials.

**Future: SCIM 2.0**
Automated user provisioning and deprovisioning from enterprise directory systems (Okta, Azure AD, Entra ID). SCIM provisioning creates and deactivates DreamTeam user accounts without manual admin intervention. SCIM tokens are separate from API keys and scoped to the `/scim/v2/` endpoint group only.

**Future: Customer-Managed Service Accounts**
Organisations will be able to create and manage their own service accounts for integrations. These are separate from user accounts, carry explicit capability scopes, and are managed through the Control Fabric permission model.

### 5.2 Authorization Layers

Authorization is evaluated in order. All layers must pass:

```
1. Authentication
   └── Valid token? Unexpired? Correct issuer?

2. Tenant Membership
   └── organisation_id in request matches token's tenant? User active?

3. Role Check
   └── User role permits this HTTP method on this resource type?

4. Permission Check
   └── Specific permission granted? (e.g. capabilities:run, knowledge:write)

5. Control Fabric Policy Check
   └── Active policies permit this action for this actor on this resource?

6. Connector Scope Check (if applicable)
   └── API key / service account has scope for the connector this action uses?

7. Data Sensitivity Check (if applicable)
   └── Requested data is within actor's knowledge scope?
```

Failure at layer 1 → `401 Unauthorized`
Failure at layers 2–7 → `403 Forbidden` (with error code indicating layer)

### 5.3 Scopes

API key and OAuth scopes use a `resource:action` pattern:

| Scope | Description |
|---|---|
| `capabilities:read` | List and retrieve capability definitions |
| `capabilities:run` | Trigger capability runs |
| `capabilities:manage` | Create and modify capabilities |
| `digital_employees:read` | Read digital employee profiles |
| `digital_employees:manage` | Configure digital employees |
| `knowledge:read` | Read knowledge items |
| `knowledge:write` | Create and update knowledge items |
| `conversations:read` | Read conversation history |
| `connectors:read` | List connectors |
| `connectors:manage` | Configure connectors |
| `connectors:{type}:read` | Read from a specific connector type (e.g. `connectors:crm:read`) |
| `approvals:read` | Read approval requests |
| `approvals:decide` | Approve or reject approval requests |
| `webhooks:manage` | Manage webhook subscriptions |
| `audit:read` | Read audit trail |
| `admin:*` | All administrative operations (restricted) |

---

## 6. Request & Response Standards

### 6.1 Request Headers

Every API request should carry:

```http
Authorization: Bearer <token>
X-Organisation-ID: org_01HZXYZ...
X-Request-ID: req_01HZXYZ...        (client-generated; UUID or ULID)
X-Idempotency-Key: idem_...         (for mutating operations; optional)
Content-Type: application/json
Accept: application/json
```

`X-Request-ID` is echoed back in the response as `X-Request-ID`. If omitted, the server generates one. `X-Organisation-ID` is required for all tenant-scoped endpoints.

### 6.2 Response Envelope

All responses use a consistent envelope:

**Success (single resource):**
```json
{
  "data": { ... },
  "meta": {
    "request_id": "req_...",
    "organisation_id": "org_...",
    "timestamp": "2026-07-01T12:00:00.000Z",
    "api_version": "2026-07-01"
  }
}
```

**Success (collection):**
```json
{
  "data": [ ... ],
  "pagination": {
    "cursor": "cur_...",
    "has_more": true,
    "total_count": 247
  },
  "meta": {
    "request_id": "req_...",
    "organisation_id": "org_...",
    "timestamp": "2026-07-01T12:00:00.000Z",
    "api_version": "2026-07-01"
  }
}
```

**Error:**
```json
{
  "error": {
    "code": "CAPABILITY_RUN_APPROVAL_REQUIRED",
    "message": "This capability requires approval before execution.",
    "details": {
      "approval_request_id": "apr_...",
      "approvers": ["manager_role"],
      "expires_at": "2026-07-01T14:00:00.000Z"
    },
    "documentation_url": "https://docs.dreamteam.ai/errors/CAPABILITY_RUN_APPROVAL_REQUIRED"
  },
  "meta": {
    "request_id": "req_...",
    "timestamp": "2026-07-01T12:00:00.000Z"
  }
}
```

### 6.3 Timestamps

All timestamps are **ISO 8601 UTC** with millisecond precision: `2026-07-01T12:00:00.000Z`. No local time. No Unix epoch integers. No ambiguous timezone offsets.

### 6.4 Identifiers

All IDs use the `prefix_ULID` format (e.g. `org_01HZXYZ...`, `cap_01HZXYZ...`, `run_01HZXYZ...`). ULID provides lexicographic sortability without database sequence exposure. Prefix makes IDs self-describing in logs and errors.

| Resource | Prefix |
|---|---|
| Organisation | `org_` |
| Workspace | `ws_` |
| Digital Employee | `de_` |
| Capability | `cap_` |
| Capability Run | `run_` |
| Workflow | `wf_` |
| Workflow Run | `wfr_` |
| Connector | `con_` |
| Conversation | `conv_` |
| Approval Request | `apr_` |
| Handoff | `hnd_` |
| Knowledge Item | `ki_` |
| Webhook | `whk_` |
| API Key | `dtk_` |

### 6.5 Pagination

Cursor-based pagination. No offset pagination in public APIs — offset pagination is unstable under concurrent writes.

Request: `GET /v1/capabilities?cursor=cur_...&limit=50`

`limit` max: 100. Default: 20. Cursor is opaque — clients must not parse or construct it. `has_more: false` signals the final page.

### 6.6 Filtering & Sorting

Filtering uses query parameters with a consistent pattern:

```
GET /v1/capability-runs?status=completed&digital_employee_id=de_...&created_after=2026-06-01T00:00:00Z
```

Sorting: `sort=created_at:desc` or `sort=name:asc`. Default sort is `created_at:desc`.

### 6.7 Localization Readiness

All user-facing string fields (names, descriptions, error messages) are UTF-8. The API does not currently localise response strings, but:

- Error `message` fields are designed for translation (keyed by `code`)
- All date formatting is ISO 8601 (locale-neutral)
- Currency values are returned as `{ "amount": 1000, "currency": "GBP" }` — never as formatted strings

---

## 7. Error Handling Standards

### 7.1 Error Categories and HTTP Status Codes

| Category | HTTP Status | Error Code Prefix |
|---|---|---|
| Authentication error | 401 | `AUTH_` |
| Authorization error | 403 | `FORBIDDEN_` |
| Validation error | 422 | `VALIDATION_` |
| Policy violation | 403 | `POLICY_` |
| Approval required | 202 | `APPROVAL_` |
| Rate limit | 429 | `RATE_LIMIT_` |
| Connector error | 502 | `CONNECTOR_` |
| AI provider error | 503 | `AI_PROVIDER_` |
| Knowledge retrieval error | 500 | `KNOWLEDGE_` |
| Workflow error | 422 | `WORKFLOW_` |
| Resource not found | 404 | `NOT_FOUND_` |
| Conflict | 409 | `CONFLICT_` |
| System error | 500 | `SYSTEM_` |

**Note on Approval Required:** When a Capability run requires approval, the API returns `202 Accepted` (not an error), with an `approval_request_id` in the response. The `APPROVAL_REQUIRED` code is informational — execution has been accepted and is pending approval, not rejected.

### 7.2 Error Safety Rules

1. **Never return stack traces.** Internal exceptions are logged server-side; the API response contains only the error code, message, and safe details.
2. **Never reveal database details.** No table names, column names, constraint names, or SQL error messages in API responses.
3. **Never reveal cross-tenant information.** A `404` is returned for resources that exist but belong to another organisation — indistinguishable from truly missing resources.
4. **Never reveal internal architecture.** Words like "agent," "vector database," "embedding," "orchestrator," "model provider" must not appear in error messages.
5. **Always include a documentation URL.** Every error code links to a page that explains the error, its causes, and how to resolve it.

### 7.3 Validation Error Detail

Validation errors include field-level detail:

```json
{
  "error": {
    "code": "VALIDATION_INVALID_INPUT",
    "message": "The request body contains invalid fields.",
    "details": {
      "fields": {
        "input.lead_id": "Required field is missing.",
        "options.async": "Must be a boolean value."
      }
    },
    "documentation_url": "..."
  }
}
```

### 7.4 Connector and AI Provider Errors

Connector and AI provider errors are abstracted at the API boundary. The customer-facing error identifies the category but not the internal provider:

```json
{
  "error": {
    "code": "CONNECTOR_SYNC_FAILED",
    "message": "The CRM connector could not be reached. The operation has been queued for retry.",
    "details": {
      "connector_id": "con_...",
      "retry_after_seconds": 30,
      "run_id": "run_..."
    }
  }
}
```

The raw provider error (including provider name, endpoint, and response body) is logged internally and referenced by `run_id` for support investigation.

---

## 8. API Versioning

### 8.1 Versioning Scheme

Public APIs are versioned by **date** in the URL path: `/v1/` for the major version, with date-based minor versions tracked in the response header:

```
X-API-Version: 2026-07-01
```

Major version in path (`/v1/`, `/v2/`) indicates a breaking change generation. Date-based minor versions introduce additive changes (new fields, new endpoints, new enum values) without changing the major version.

### 8.2 Backwards Compatibility Rules

The following changes are **additive** (non-breaking) and require no version increment:

- Adding new optional fields to request or response bodies
- Adding new endpoints
- Adding new enum values (clients must handle unknown values gracefully)
- Adding new webhook event types
- Relaxing validation constraints

The following changes are **breaking** and require a new major version:

- Removing or renaming fields
- Changing field types
- Changing HTTP methods for existing endpoints
- Adding required request fields
- Changing error code values
- Removing enum values
- Changing pagination behaviour
- Changing authentication requirements

### 8.3 Deprecation Policy

1. A field, endpoint, or behaviour is marked deprecated with a `Deprecation: true` response header and a `Sunset: <date>` header indicating when it will be removed.
2. Deprecation notices appear in the API changelog and are sent to the registered developer email for any API key that has called the deprecated endpoint in the past 90 days.
3. **Minimum deprecation window: 12 months** for stable public APIs. 6 months for preview APIs.
4. Breaking changes are shipped in a new major version. The old version remains available for the deprecation window.
5. After the sunset date, the old version returns `410 Gone` with a migration guide URL.

### 8.4 Preview / Beta APIs

APIs under active development are marked with a `X-API-Status: preview` header. Preview APIs:

- May change without notice
- Are not covered by the deprecation policy
- Are not suitable for production integrations
- Are documented with explicit preview labelling

Preview APIs graduate to stable status with a formal changelog entry and a stable date version.

### 8.5 Marketplace API Compatibility

Marketplace listings declare which API versions they are compatible with. When an API version is sunset, the Marketplace registry flags incompatible listings. Partners must update their listings within the deprecation window or they are marked as deprecated in the Marketplace UI.

---

## 9. Idempotency & Reliability

### 9.1 Idempotency Keys

All mutating API operations (POST, PUT, PATCH, DELETE with side effects) accept an `X-Idempotency-Key` header. If an identical idempotency key is submitted within 24 hours, the server returns the original response without re-executing the operation.

Idempotency keys must be:
- Client-generated (UUID v4 or ULID)
- Unique per operation intent (not reused across different operations)
- Between 8 and 64 characters

Idempotency key storage: keyed by `(organisation_id, idempotency_key)`. Cross-organisation replay is not permitted.

### 9.2 Retry-Safe APIs

GET requests are always safe to retry. POST requests are retry-safe only when an idempotency key is provided. PUT and PATCH requests are idempotent by nature (applying the same state twice produces the same result) but still accept idempotency keys for client-side deduplication.

### 9.3 Duplicate Prevention

The following operations enforce server-side duplicate prevention in addition to idempotency keys:

- Capability runs: duplicate detection within a 60-second window on `(capability_id, input_hash, actor_id)` — returns `409 Conflict` with the original `run_id`
- Webhook subscriptions: duplicate detection on `(organisation_id, url, event_type)`
- Connector sync jobs: single active sync per connector — subsequent requests queue behind the active job

### 9.4 Webhook Replay Handling

Webhook endpoints must be idempotent. DreamTeam webhooks carry an `event_id` — the receiver must deduplicate on `event_id`. Events may be delivered more than once due to network retries. An event ID that has already been processed must be acknowledged with `200 OK` without reprocessing.

### 9.5 Long-Running Operations

Operations that may run for more than 30 seconds are always async. The initial POST returns a `run_id`. The client polls `GET /v1/capability-runs/{run_id}` or subscribes to webhook events. The server retains run state for a minimum of 30 days.

---

## 10. Async Operations

### 10.1 Async-First Operations

The following operation types are always asynchronous regardless of client preference:

| Operation | Typical Duration | Why Async |
|---|---|---|
| Capability runs (complex) | 2–60 seconds | Multi-step execution, connector reads, model invocation |
| Knowledge ingestion | 30 seconds – 10 minutes | Parsing, chunking, embedding generation |
| Connector sync | 1 second – 60 minutes | Rate limits, data volume, pagination |
| Workflow runs | 1 second – hours | Multi-step, approval gates, human-in-the-loop |
| Bulk imports | Minutes – hours | Data volume |
| AI evaluations | 10 seconds – 5 minutes | Model invocation, batch processing |
| Report generation | 30 seconds – 5 minutes | Aggregation, formatting |
| Data exports | 1 minute – 1 hour | Compliance serialisation, encryption |

### 10.2 Async Response Pattern

**Initiation:**
```
POST /v1/knowledge/ingest
→ 202 Accepted
{
  "job_id": "job_...",
  "status": "queued",
  "poll_url": "/v1/jobs/job_...",
  "estimated_duration_seconds": 120
}
```

**Polling:**
```
GET /v1/jobs/job_...
→ 200 OK
{
  "job_id": "job_...",
  "job_type": "knowledge.ingest",
  "status": "running",
  "progress": { "items_processed": 47, "items_total": 200 },
  "started_at": "2026-07-01T12:00:05Z",
  "updated_at": "2026-07-01T12:00:15Z"
}
```

**Completion:**
```json
{
  "status": "completed",
  "result": {
    "items_ingested": 200,
    "items_failed": 0,
    "knowledge_base_id": "kb_..."
  },
  "completed_at": "2026-07-01T12:02:05Z"
}
```

### 10.3 Status Lifecycle

All async jobs follow this status lifecycle:

```
queued → running → completed
                 → failed
                 → cancelled
running → waiting_for_approval → approved → running
                               → rejected → cancelled
```

`waiting_for_approval` is a suspended state where execution has paused for human decision. The job is not failing — it is waiting. The response includes an `approval_request_id`.

### 10.4 Job Cancellation

```
POST /v1/jobs/{job_id}/cancel
```

Cancellation is best-effort for running jobs. Queued jobs are cancelled immediately. For jobs with side effects already in progress (connector writes, emails sent), the audit trail records what was completed before cancellation.

---

## 11. Webhook Standards

### 11.1 Webhook Architecture

Webhooks deliver real-time event notifications to customer-configured HTTPS endpoints. The delivery model is **at-least-once** — endpoints must handle duplicate delivery using the `event_id`.

### 11.2 Webhook Subscription Management

```
POST   /v1/webhooks
GET    /v1/webhooks
GET    /v1/webhooks/{webhook_id}
PUT    /v1/webhooks/{webhook_id}
DELETE /v1/webhooks/{webhook_id}
POST   /v1/webhooks/{webhook_id}/test     -- send a test event
GET    /v1/webhooks/{webhook_id}/deliveries
POST   /v1/webhooks/{webhook_id}/deliveries/{delivery_id}/replay
```

### 11.3 Webhook Payload Structure

```json
{
  "event_id": "evt_...",
  "event_type": "capability.completed",
  "event_version": "2026-07-01",
  "organisation_id": "org_...",
  "workspace_id": "ws_...",
  "timestamp": "2026-07-01T12:01:05.000Z",
  "data": {
    "run_id": "run_...",
    "capability_id": "cap_...",
    "capability_slug": "qualify-lead",
    "digital_employee_id": "de_...",
    "status": "completed",
    "duration_ms": 1820,
    "output": { ... }
  }
}
```

### 11.4 Payload Signing

Every webhook delivery carries a signature header:

```
X-DreamTeam-Signature: sha256=<HMAC-SHA256 of payload body using webhook secret>
X-DreamTeam-Timestamp: 1751371265
```

Receivers must:
1. Reconstruct the signed string: `<timestamp>.<raw_body>`
2. Compute `HMAC-SHA256` using the webhook secret
3. Compare to the `sha256=` value using a constant-time comparison
4. Reject events where the timestamp is more than 5 minutes old (replay protection)

### 11.5 Retry Policy

Failed deliveries (non-2xx response or timeout after 30 seconds) are retried with exponential backoff:

| Attempt | Delay |
|---|---|
| 1 | Immediate |
| 2 | 30 seconds |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 12 hours |

After 6 failed attempts, the event enters the dead-letter queue. The webhook subscription is marked `degraded` after 10 consecutive failures. The subscription is automatically paused after 24 hours of consecutive failure with an alert to the registered admin.

### 11.6 Dead-Letter Queue

Dead-letter events are retained for 14 days. Customers can view and replay them via the webhook management API or the Workforce HQ dashboard. Replayed events carry the original `event_id` (for deduplication) and a `X-DreamTeam-Replay: true` header.

### 11.7 Supported Webhook Events

Events follow `domain.action` naming. Domain maps to the Core Domain Model. The Internal implementation concept (agent, model, orchestrator) never appears in event names.

**Conversation events:**
- `conversation.created`
- `conversation.completed`
- `conversation.escalated`
- `conversation.handed_off`

**Capability events:**
- `capability.run_started`
- `capability.run_completed`
- `capability.run_failed`
- `capability.run_cancelled`

**Approval events:**
- `approval.requested`
- `approval.approved`
- `approval.rejected`
- `approval.expired`

**Knowledge events:**
- `knowledge.ingestion_completed`
- `knowledge.ingestion_failed`
- `knowledge.gap_detected`
- `knowledge.item_updated`

**Workflow events:**
- `workflow.run_started`
- `workflow.run_completed`
- `workflow.run_failed`
- `workflow.step_completed`

**Connector events:**
- `connector.sync_completed`
- `connector.sync_failed`
- `connector.disconnected`
- `connector.rate_limited`

**Digital Employee events:**
- `digital_employee.status_changed`
- `digital_employee.handoff_initiated`

**Usage events:**
- `usage.budget_threshold_exceeded`
- `usage.rate_limit_approaching`

**Policy events:**
- `policy.action_blocked`
- `policy.approval_gate_triggered`

### 11.8 Event Versioning

Each event type carries an `event_version` date field. When the payload schema of an event changes in a non-backward-compatible way, the event version is incremented. Subscribers can pin to a specific event version. Old event versions are deprecated following the same 12-month window as API versions.

---

## 12. Connector Architecture

### 12.1 Connector as Platform Primitive

A Connector is a first-class platform primitive — not a plugin, not a third-party add-on, not an optional extension. It is the technical bridge between DreamTeam and an external system. Every Connector in the Connector Marketplace has been reviewed, tested, and certified against this specification.

No Digital Employee directly depends on vendor-specific Connector logic. Digital Employees declare which Capability types they support; Capabilities declare which Connector types they require. The Connector abstraction layer handles provider-specific implementation.

### 12.2 Connector Specification

Every Connector must declare a complete specification:

```json
{
  "connector_type": "salesforce",
  "display_name": "Salesforce",
  "provider": "Salesforce Inc.",
  "auth_methods": ["oauth2_authorization_code"],
  "required_scopes": ["api", "refresh_token", "offline_access"],
  "supported_objects": ["Contact", "Lead", "Opportunity", "Account", "Case"],
  "supported_actions": {
    "read": ["Contact", "Lead", "Opportunity", "Account", "Case"],
    "create": ["Lead", "Case", "Task"],
    "update": ["Contact", "Lead", "Opportunity"],
    "delete": []
  },
  "sync_behavior": {
    "supports_webhook": true,
    "supports_polling": true,
    "default_sync_interval_seconds": 300,
    "min_sync_interval_seconds": 60
  },
  "rate_limits": {
    "requests_per_second": 10,
    "daily_api_calls": 100000
  },
  "data_residency_compatible": true,
  "audit_logging": "always",
  "revocation_behavior": "immediate_credential_invalidation"
}
```

### 12.3 Connector Authentication

All credential storage uses Supabase Vault (at-rest encryption). Credentials are never logged, never returned in API responses, and never included in webhook payloads.

OAuth connectors store only `access_token` (encrypted) and `refresh_token` (encrypted). The raw token is never accessible via API — only the connector runtime uses it. Refresh is handled automatically before expiry.

API key connectors store encrypted keys. Customers are prompted to rotate connector credentials when they rotate their source system credentials.

### 12.4 Connector Health Monitoring

Each connector exposes a health signal:

```
GET /v1/connectors/{connector_id}/health
→ {
    "status": "healthy",
    "last_sync_at": "2026-07-01T11:55:00Z",
    "last_error": null,
    "consecutive_failures": 0,
    "rate_limit_remaining": 8421
  }
```

Health checks run on a 5-minute background schedule. Degraded connectors trigger `connector.health_degraded` events and surface warnings in the Workforce HQ dashboard.

### 12.5 Connector Revocation

When a connector is revoked (credentials removed, OAuth disconnected, connector deleted):

1. Active sync jobs are cancelled
2. Capability runs that depend on the connector are failed with `CONNECTOR_REVOKED` error
3. Workflows that use the connector are paused (not failed — they can resume when reconnected)
4. A `connector.disconnected` event is emitted
5. Audit trail records the revocation with actor and timestamp

Revocation is immediate. No grace period. Data already synced remains in `connector_synced_records` until the retention policy removes it.

---

## 13. Integration Standards

### 13.1 Connector vs Integration — The Distinction Matters

This distinction is foundational and must be maintained consistently across all API surfaces, documentation, and product UI.

**A Connector** is the technical capability to connect to an external system. It is configured once per Organisation. It handles authentication, rate limits, and the communication protocol. **It is reusable across all Capabilities and Workflows in the Organisation.**

**An Integration** is the configured use of a Connector within a specific Capability or Workflow. It defines: which objects to access, which fields to map, which transformation rules to apply, and what the Capability expects to receive. **Each Capability that uses Salesforce data has its own Integration configuration, but they all share the same Salesforce Connector.**

Analogy from the domain model: the Connector is the electrical outlet; the Integration is the specific appliance plugged in for a specific purpose.

### 13.2 Integration Setup

```
POST /v1/integrations
{
  "connector_id": "con_...",
  "capability_id": "cap_...",   // or workflow_id
  "name": "CRM Lead Sync — Qualify Lead Capability",
  "object_type": "Lead",
  "field_mappings": [
    { "source_field": "FirstName", "target_field": "lead.first_name" },
    { "source_field": "Email", "target_field": "lead.email_address" },
    { "source_field": "AnnualRevenue", "target_field": "lead.annual_revenue_usd" }
  ],
  "filters": {
    "status": "Open"
  },
  "permissions": {
    "read": true,
    "write": false
  }
}
```

### 13.3 Credential Handling

Integrations inherit their credentials from the parent Connector. Integrations do not store credentials — they reference the Connector's encrypted credential store via `connector_id`. This means:

- Rotating a connector's credentials automatically applies to all Integrations using that Connector
- Revoking a Connector's credentials immediately disables all its Integrations
- Integrations cannot escalate their own permissions beyond what the Connector allows

### 13.4 Sync Schedules

Integrations can configure sync cadence independently of the connector's default:

```json
{
  "sync_schedule": {
    "mode": "polling",
    "interval_seconds": 600,
    "full_sync_daily": true,
    "full_sync_time": "02:00"
  }
}
```

Or event-driven via connector webhook:

```json
{
  "sync_schedule": {
    "mode": "webhook",
    "connector_webhook_events": ["lead.created", "lead.updated"]
  }
}
```

### 13.5 Error Recovery

Integration sync failures follow the retry policy in Section 9. After 6 consecutive sync failures, the integration enters `error` status and emits `connector.sync_failed`. The integration does not automatically resume — an admin must acknowledge the error and reactivate.

During degraded sync periods, the Capability continues operating on the last-synced data. Stale data age is surfaced in the `data_freshness_seconds` field on affected Capability responses.

### 13.6 Disabling and Revoking Integrations

Disabling an Integration (`is_active: false`) stops future syncs but retains configuration and synced records. Re-enabling triggers a full sync. Deleting an Integration removes the configuration and marks synced records as `orphaned` (they are not immediately deleted — retention policy applies).

---

## 14. Tool Interface Standards

### 14.1 Tools as Governed Functions

A Tool is a specific, bounded, callable function that an Agent invokes during Capability execution. Tools are the mechanism by which the Digital Workforce creates effects in the world — creating records, sending messages, querying data, triggering processes.

Tools are not open-ended. Every Tool has a typed schema, a declared risk level, a permission requirement, and an audit behavior. There is no such thing as an ungoverned Tool.

### 14.2 Tool Specification Schema

```json
{
  "name": "create_crm_contact",
  "description": "Creates a new contact record in the connected CRM system.",
  "version": "1.0",
  "input_schema": {
    "type": "object",
    "required": ["first_name", "last_name", "email"],
    "properties": {
      "first_name": { "type": "string", "maxLength": 100 },
      "last_name": { "type": "string", "maxLength": 100 },
      "email": { "type": "string", "format": "email" },
      "company": { "type": "string" }
    }
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "contact_id": { "type": "string" },
      "created_at": { "type": "string", "format": "date-time" }
    }
  },
  "permissions_required": ["connectors:crm:write"],
  "risk_level": "medium",
  "reversibility_class": "partially_reversible",
  "requires_approval": false,
  "approval_threshold": null,
  "audit_behavior": "always",
  "connector_dependency": "crm",
  "timeout_ms": 5000,
  "retry_policy": {
    "max_attempts": 3,
    "backoff": "exponential",
    "retryable_errors": ["CONNECTOR_TIMEOUT", "CONNECTOR_RATE_LIMITED"]
  },
  "estimated_cost_impact": "low"
}
```

### 14.3 Tool Risk Levels

| Risk Level | Description | Default Approval |
|---|---|---|
| `low` | Read-only, no side effects | Never required |
| `medium` | Creates or modifies data; reversible | Policy-driven |
| `high` | Irreversible writes, financial, communications | Recommended |
| `critical` | Deletions, bulk operations, sensitive data export | Required |

Risk level is declared by the Tool definition, validated by the Control Fabric, and may be overridden to a higher level (but never lower) by Organisation Policy.

### 14.4 Permission-Awareness

Tools check permissions at invocation time, not at registration time. A Tool that is registered with `connectors:crm:write` permission will be blocked at runtime if the invoking Agent's permission set (as granted by the Control Fabric for this specific Capability run) does not include that scope. The Control Fabric decides; the Tool executes only if permitted.

### 14.5 Tool Audit Behavior

Every Tool invocation generates an audit record:

```json
{
  "event_type": "tool.invoked",
  "tool_name": "create_crm_contact",
  "capability_run_id": "run_...",
  "digital_employee_id": "de_...",
  "human_initiator_id": "usr_...",
  "input_summary": "first_name=Jane, last_name=Smith, email=j.smith@acme.com",
  "outcome": "success",
  "duration_ms": 342,
  "connector_id": "con_..."
}
```

Input data in audit records is summarised — not raw — to avoid storing sensitive field values in the audit trail. The full input/output is logged to operational logs with a shorter retention period.

---

## 15. AI Tool Compatibility & MCP Readiness

### 15.1 Design Principle: Adaptable, Not Coupled

DreamTeam's tool interface is designed to be **adaptable to emerging AI tool standards** rather than built on any single standard. This is a direct application of the platform's "AI models are interchangeable infrastructure" principle — the same reasoning applies to AI tool protocols.

Building natively against Anthropic's Model Context Protocol (MCP) would couple the platform's tool architecture to a single AI vendor's tooling standard. If that standard changes, or if a customer uses a different model provider, the platform's tool layer would require significant rework.

The correct architecture is: **DreamTeam defines its own typed tool interface; adapter layers translate that interface to MCP, OpenAI function calling, or any future standard.**

### 15.2 DreamTeam Tool Interface Properties

Every DreamTeam Tool already satisfies the properties that make MCP compatibility straightforward:

| Property | DreamTeam Tool | MCP Requirement |
|---|---|---|
| Typed input schema | JSON Schema | JSON Schema |
| Typed output schema | JSON Schema | JSON Schema |
| Discoverable | Yes — Tools are registered and queryable | Required |
| Permission-scoped | Yes — `permissions_required` field | Supported |
| Auditable | Yes — always | Supported |
| Organisation-scoped | Yes — inherited from Capability context | Required |
| Secret-hiding | Yes — credentials via Connector, never in Tool | Required |
| Approval gates | Yes — `requires_approval` field | Supported via sampling |

### 15.3 MCP Adapter Layer (Future)

When MCP or an equivalent protocol is required (e.g. for a customer's enterprise AI platform integration), an MCP Adapter Layer is added as a separate service:

```
DreamTeam Tool Registry
        ↓
   MCP Adapter Service        ← translates DreamTeam tool schemas to MCP tool specs
        ↓
   MCP Client (customer's AI platform or model provider)
```

The Adapter Layer does not bypass the Control Fabric. Every tool invocation coming through the MCP adapter is evaluated by the Control Fabric before execution. MCP is a discovery and invocation protocol, not a permission bypass.

### 15.4 Tool Discoverability API

Tools can be discovered programmatically:

```
GET /v1/tools
GET /v1/tools/{tool_name}
GET /v1/capabilities/{capability_id}/tools   -- tools available to this capability
```

This provides the foundation for any tool discovery protocol, including MCP's tool listing approach.

### 15.5 Organisation Scoping in Tool Calls

Tool invocations always carry organisation context. A tool called via any protocol — DreamTeam's native API, a future MCP adapter, or an SDK — must carry `organisation_id`. Tools cannot be invoked in an organisation-free context. This ensures that connector credentials, permission checks, and audit records are always correctly scoped.

---

## 16. Public API Future

### 16.1 Public API Readiness Criteria

A capability is ready for public API exposure when:

1. The domain concept is stable (defined in `docs/05_Core_Domain_Model.md`)
2. The database schema is stable (defined in `docs/08_Database_Design.md`)
3. The endpoint has been versioned from the start
4. Auth, permissions, and audit requirements are implemented
5. Error handling follows Section 7 of this document
6. The endpoint is covered by automated API contract tests
7. Documentation meets Section 24 standards

### 16.2 Public API Resource Groups

The following resource groups are planned for public API exposure, phased by implementation priority:

**Phase 1 — Core (with initial product):**
- `organisations` — read organisation profile, update settings
- `users` — list members, invite, deactivate
- `workspaces` — list, read
- `capabilities` — list, read, run, get run status
- `capability-runs` — read, cancel, list

**Phase 2 — Workforce & Knowledge:**
- `digital-employees` — list, read, update configuration
- `knowledge` — ingest, list, read, update, delete knowledge items
- `conversations` — read, list, create (for API-triggered conversations)
- `approvals` — read, list, decide (approve/reject)

**Phase 3 — Workflows & Integration:**
- `workflows` — list, read, trigger
- `workflow-runs` — read, cancel, list
- `connectors` — list, read (health, status)
- `webhooks` — full CRUD + delivery history + replay

**Phase 4 — Analytics & Governance:**
- `usage` — token usage, cost summaries, capability run volumes
- `audit-logs` — read, filter, export
- `insights` — list, read
- `recommendations` — list, read, dismiss

**Phase 5 — Developer Platform:**
- `marketplace` — browse, install, manage installed listings
- `tools` — discover, read specifications
- `partner/publisher` — publish listings, manage versions, view analytics

### 16.3 Data Portability API

Required for GDPR Article 20 compliance and enterprise customer data governance:

```
POST /v1/data-exports
{
  "scope": "full_organisation",
  "format": "json",
  "include": ["conversations", "knowledge", "audit_logs", "capability_runs"]
}
→ 202 Accepted — async job; download URL provided on completion
```

```
POST /v1/data-deletions
{
  "scope": "user",
  "user_id": "usr_...",
  "reason": "gdpr_erasure_request"
}
```

Data deletions follow the archival and anonymisation rules in `docs/08_Database_Design.md` Section 22. Audit trail records are anonymised, not deleted. The deletion job generates a `data.deletion_completed` event with a summary of what was removed.

---

## 17. SDK Standards

### 17.1 SDK Philosophy

DreamTeam SDKs are typed, thin wrappers around the stable public API. They contain:

- Auto-generated API client code from the OpenAPI schema
- Domain model types matching the Core Domain Model terminology
- Authentication helpers
- Pagination helpers
- Webhook signature verification utilities
- Idempotency key generation utilities

SDKs do not contain:

- Business logic
- Caching layers
- Retry logic (beyond simple HTTP retry on network errors)
- AI model integrations
- Data transformation rules

### 17.2 SDK Version Pinning

Each SDK release pins to a specific API date version. The SDK `package.json` / `pyproject.toml` / `.csproj` carries:

```json
{
  "name": "@dreamteam/sdk",
  "version": "1.4.0",
  "api_version": "2026-07-01"
}
```

The SDK version and API version are independent. Multiple SDK patch releases may target the same API version. When the API major version increments, a new major SDK version is released.

### 17.3 Type Generation

SDK types are generated from the OpenAPI schema using standard code generation tools. Domain model terminology is enforced at generation time — type names match Core Domain Model concept names. Generated types are checked into the repo alongside the generator configuration so they can be regenerated when the OpenAPI schema changes.

### 17.4 Target Languages

| Language | Priority | Status |
|---|---|---|
| TypeScript / JavaScript | P1 | Phase 2 |
| Python | P1 | Phase 3 |
| .NET (C#) | P2 | Phase 4 |
| Java | P2 | Phase 4 |

TypeScript and Python are prioritised because they are the dominant languages for AI/automation tooling — the audience most likely to integrate with DreamTeam programmatically.

### 17.5 SDK Deprecation

When an API version is deprecated, the corresponding SDK version is deprecated simultaneously. SDK consumers see deprecation warnings in their runtime logs (the SDK emits `DeprecationWarning` when calling deprecated endpoints). The SDK changelog documents which methods are deprecated and which new method to use instead.

---

## 18. Rate Limiting & Quotas

### 18.1 Rate Limiting Model

Rate limits operate at three levels simultaneously. All three must pass for a request to proceed.

| Level | Window | Default Limit | Exceeded Response |
|---|---|---|---|
| Organisation | 1 minute | 1,000 requests | `429` |
| User / API Key | 1 minute | 200 requests | `429` |
| Specific endpoint | 1 minute | Per-endpoint limit | `429` |

Rate limit state is stored in Redis. Headers on every response:

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 847
X-RateLimit-Reset: 1751371260
Retry-After: 23          (present only on 429 responses)
```

### 18.2 Capability Execution Limits

Capability runs have separate limits from general API calls, scoped to prevent runaway workflow executions:

| Plan | Concurrent Runs | Runs per Hour | Runs per Day |
|---|---|---|---|
| Starter | 5 | 100 | 1,000 |
| Growth | 20 | 500 | 10,000 |
| Enterprise | Configured | Configured | Configured |

Exceeding concurrent run limits queues the run (does not reject it) up to a configurable queue depth. Exceeding hourly/daily limits returns `429` with a `Retry-After` header.

### 18.3 AI Token Limits

AI token consumption is rate-limited and budget-gated (see `docs/08_Database_Design.md` Section 15.3). When a budget threshold is reached:

1. At 80% of budget: `usage.budget_threshold_exceeded` event emitted; admin alert sent
2. At 100% of budget: Capability runs requiring AI invocation return `429` with `USAGE_BUDGET_EXCEEDED` error
3. Budget resets at the start of the next billing period

Organisations can increase limits by upgrading plan or purchasing add-on capacity.

### 18.4 Connector Rate Limits

Connector sync operations respect the source system's rate limits (declared in the Connector specification). DreamTeam enforces these limits server-side:

- Tracks per-connector API call counts using a sliding window
- Queues sync operations that would exceed limits
- Emits `connector.rate_limited` events when queuing occurs
- Surfaces current rate limit state in the Connector health endpoint

### 18.5 Webhook Delivery Limits

Webhook endpoint delivery is rate-limited to protect customer infrastructure:

- Maximum 100 concurrent in-flight deliveries per webhook subscription
- If a customer endpoint is consistently slow (>10 seconds response time), delivery is throttled
- Burst: up to 500 events/minute per subscription; queued beyond that

### 18.6 Marketplace Limits

Marketplace API access for partners:

- Listing submissions: 10 per day per partner account
- Version updates: 50 per day per listing
- Analytics queries: 200 per hour per partner account

---

## 19. API Security

### 19.1 Input Validation

Every API endpoint validates inputs at the boundary before any business logic executes:

- **Schema validation** — request body matches declared JSON Schema; unknown fields are rejected (not silently dropped)
- **Type coercion is prohibited** — a string `"true"` is not accepted where a boolean `true` is required
- **Size limits** — request bodies max 1 MB for standard APIs, 10 MB for knowledge ingestion, 100 MB for file uploads
- **String sanitisation** — HTML and script content is stripped from string fields that will be displayed in UI surfaces
- **Enum validation** — unknown enum values are rejected with a validation error listing valid values

### 19.2 Output Filtering

Response data is filtered at the serialisation layer, not at the database query layer:

- Fields the actor lacks permission to see are omitted (not nulled) from responses
- PII fields are redacted in audit log API responses based on the requesting actor's data sensitivity clearance
- Internal IDs (`tenant_id`, `agent_id`, internal constraint names) are never included in public API responses

### 19.3 Least Privilege at Every Layer

- API keys are issued with the minimum scope set required for the integration
- Service accounts are scoped to the specific Capability groups they serve
- Platform admin tokens are short-lived (4-hour expiry)
- No API surface returns more data than the authenticated actor is permitted to see

### 19.4 CORS Standards

Public API (`api.dreamteam.ai`):
- `Access-Control-Allow-Origin`: Restricted to registered customer domains and DreamTeam's own frontend domains
- `Access-Control-Allow-Methods`: `GET, POST, PUT, PATCH, DELETE, OPTIONS`
- `Access-Control-Allow-Headers`: `Authorization, Content-Type, X-Organisation-ID, X-Request-ID, X-Idempotency-Key`
- Credentials are NOT allowed on CORS requests (`Access-Control-Allow-Credentials: false`)

The public API should never be called directly from a browser with user credentials. Browser-based access uses the DreamTeam frontend, which calls internal Supabase APIs.

### 19.5 Token Security

- JWT access tokens expire after 60 minutes
- Refresh tokens expire after 30 days (or on logout)
- API keys do not expire but are rotatable at any time; rotation does not invalidate other keys
- All tokens are validated on every request — there is no session cache that bypasses validation
- Stolen token mitigation: API keys can be immediately revoked; user sessions can be invalidated per-user or globally

### 19.6 Secrets Protection

- Connector credentials stored in Supabase Vault (AES-256 encryption at rest)
- API key values stored as bcrypt hashes — the raw key is shown exactly once at creation
- Webhook signing secrets shown once at creation; customers must save them
- No secret value ever appears in logs, error responses, webhook payloads, or audit records
- Internal service-to-service tokens are not logged (request headers are filtered before logging)

### 19.7 PII-Safe Logging

Structured logs are filtered at the emitter:

- `Authorization` header values are replaced with `[REDACTED]`
- `X-API-Key` values are replaced with `[REDACTED:key_prefix_****]`
- Email addresses in log strings are replaced with `[EMAIL_REDACTED]`
- Log fields that may contain PII (customer names, query text) are tagged `pii:true` and excluded from logs forwarded to third-party observability tools unless the customer has consented

### 19.8 Webhook Security

- Webhook endpoints must use HTTPS. HTTP endpoints are rejected at subscription creation.
- Self-signed certificates are rejected in production.
- Payloads are signed (see Section 11.4). Receivers that do not validate signatures are at risk — the documentation makes this explicit.
- Replay protection via timestamp validation (5-minute window).
- Customer webhook secrets are rotatable without disrupting existing subscriptions (dual-signing period of 24 hours during rotation).

### 19.9 Data Portability API Security

- Export jobs require `admin` role
- Export download URLs are pre-signed, single-use, expire in 1 hour
- Export jobs are rate-limited: 1 full export per 24 hours per organisation
- Deletion requests require multi-factor confirmation and generate a permanent audit record

---

## 20. Data Mapping Standards

### 20.1 The Mapping Problem

External systems do not use DreamTeam's domain model. A CRM calls it a `Lead`; DreamTeam's Capability calls it a `prospect`. A support system calls it a `requester_id`; DreamTeam's Capability expects a `customer_id`. Data mapping is the translation layer between external representations and the platform's domain model.

### 20.2 Object Mapping

Object mappings declare the correspondence between external system object types and DreamTeam domain concepts:

```json
{
  "connector_type": "salesforce",
  "object_mappings": [
    {
      "external_object": "Lead",
      "dreamteam_concept": "prospect",
      "direction": "bidirectional"
    },
    {
      "external_object": "Case",
      "dreamteam_concept": "support_ticket",
      "direction": "read_only"
    }
  ]
}
```

### 20.3 Field Mapping

Field mappings translate individual attributes:

```json
{
  "field_mappings": [
    { "source": "FirstName", "target": "first_name", "transform": null },
    { "source": "AnnualRevenue", "target": "annual_revenue_usd", "transform": "currency_usd" },
    { "source": "CreatedDate", "target": "created_at", "transform": "iso8601_utc" }
  ]
}
```

### 20.4 Transformation Rules

Built-in transforms:

| Transform | Description |
|---|---|
| `currency_usd` | Normalise to USD float |
| `iso8601_utc` | Convert any date format to ISO 8601 UTC |
| `lowercase` | Convert string to lowercase |
| `strip_html` | Remove HTML tags from string |
| `boolean_yn` | Map "Y"/"N" to `true`/`false` |
| `phone_e164` | Normalise to E.164 format |

Custom transforms are expressed as JSONata expressions for simple cases. Complex transforms require a custom Edge Function registered as an Integration Transform Handler.

### 20.5 Sync Conflicts

When the same record has been updated in both DreamTeam and the external system:

- Default policy: **external system wins** (the connector is the source of truth for external data)
- DreamTeam-created overrides: supported for records created through DreamTeam Tools (these are flagged as `source_of_truth: "dreamteam"`)
- Conflict events: `connector.sync_conflict_detected` — includes both versions for admin review

### 20.6 Data Lineage

Every `connector_synced_record` carries:

```json
{
  "connector_id": "con_...",
  "external_id": "003...",
  "record_type": "Contact",
  "first_synced_at": "2026-06-01T09:00:00Z",
  "last_synced_at": "2026-07-01T11:55:00Z",
  "checksum": "sha256:abc..."
}
```

Lineage is available through the audit trail: every Capability run that read connector data logs which `connector_synced_record` IDs contributed to the context.

### 20.7 Control Fabric and Mapping Governance

Customers can configure which fields are excluded from sync through the Control Fabric:

```json
{
  "policy_type": "data_access",
  "connector_id": "con_...",
  "excluded_fields": ["SSN", "DateOfBirth", "PersonalEmail"],
  "reason": "PII restriction — HR policy"
}
```

Excluded fields are never synced, never stored in `connector_synced_records`, and never available to Digital Employees.

---

## 21. Events & Event Naming

### 21.1 Event Naming Convention

Events use the `domain.action` pattern. Domain terms are drawn from the Core Domain Model. Internal concepts (agent, model, prompt, embedding) are never event domains.

Format: `<domain>.<past_tense_verb>`

All events are in past tense — they record what happened, not what is happening.

### 21.2 Event Taxonomy

**Organisation & User Events:**
```
organisation.created
organisation.updated
organisation.suspended
user.invited
user.joined
user.deactivated
user.role_changed
```

**Workspace Events:**
```
workspace.created
workspace.updated
workspace.archived
```

**Digital Employee Events:**
```
digital_employee.hired          -- DE configured and activated
digital_employee.updated
digital_employee.paused
digital_employee.retired
digital_employee.status_changed
digital_employee.handoff_initiated
```

**Capability Events:**
```
capability.created
capability.published
capability.run_started
capability.run_completed
capability.run_failed
capability.run_cancelled
capability.approval_required
capability.version_published
```

**Conversation Events:**
```
conversation.started
conversation.message_received
conversation.message_sent
conversation.escalated
conversation.handed_off
conversation.completed
conversation.abandoned
```

**Workflow Events:**
```
workflow.created
workflow.published
workflow.run_started
workflow.run_completed
workflow.run_failed
workflow.run_cancelled
workflow.step_completed
workflow.step_failed
workflow.approval_gate_triggered
```

**Approval Events:**
```
approval.requested
approval.approved
approval.rejected
approval.expired
approval.reminder_sent
```

**Handoff Events:**
```
handoff.created
handoff.accepted
handoff.resolved
handoff.expired
```

**Escalation Events:**
```
escalation.triggered
escalation.resolved
```

**Knowledge Events:**
```
knowledge.item_created
knowledge.item_updated
knowledge.item_deleted
knowledge.ingestion_started
knowledge.ingestion_completed
knowledge.ingestion_failed
knowledge.gap_detected
knowledge.collection_updated
```

**Connector & Integration Events:**
```
connector.connected
connector.sync_started
connector.sync_completed
connector.sync_failed
connector.sync_conflict_detected
connector.rate_limited
connector.health_degraded
connector.disconnected
integration.created
integration.updated
integration.disabled
```

**Control Fabric & Policy Events:**
```
policy.created
policy.updated
policy.action_blocked
policy.approval_gate_triggered
policy.violation_detected
```

**Usage & Billing Events:**
```
usage.budget_threshold_exceeded
usage.budget_exceeded
usage.rate_limit_approaching
usage.rate_limit_exceeded
billing.subscription_changed
billing.payment_failed
```

**Audit Events:**
```
audit.export_requested
audit.export_completed
```

**Data Management Events:**
```
data.export_requested
data.export_completed
data.deletion_requested
data.deletion_completed
```

**Marketplace Events:**
```
marketplace.listing_installed
marketplace.listing_uninstalled
marketplace.listing_updated
```

### 21.3 Event Schema

All events share a common envelope:

```json
{
  "event_id": "evt_...",
  "event_type": "capability.run_completed",
  "event_version": "2026-07-01",
  "organisation_id": "org_...",
  "workspace_id": "ws_...",
  "actor_type": "digital_employee",
  "actor_id": "de_...",
  "human_initiator_id": "usr_...",
  "timestamp": "2026-07-01T12:01:05.000Z",
  "data": { ... }
}
```

`human_initiator_id` is always set when the event chain traces back to a human action, preserving the Delegation Chain (see `docs/07_Security_and_Governance.md`).

---

## 22. Audit Requirements

### 22.1 What Must Be Audited

Every operation in the following categories generates an Audit Trail entry. There are no exceptions:

| Category | Operations |
|---|---|
| Capability execution | Start, complete, fail, cancel, approval state changes |
| Control Fabric decisions | Every allow, block, and approval-gate decision |
| Data access | Every connector read used in a Capability run |
| Tool invocations | Every Tool call with input summary and outcome |
| Approval lifecycle | Every request, decision, and expiry |
| Handoff lifecycle | Every creation, acceptance, and resolution |
| Knowledge changes | Ingestion, updates, deletions |
| User management | Invite, join, deactivate, role changes |
| Connector management | Connect, sync, disconnect, credential rotation |
| Policy changes | Create, update, activate, deactivate |
| Authentication | Login, logout, failed login, token rotation |
| Data exports | Request and completion |
| Data deletions | Request, processing, and completion |
| API key management | Create, rotate, revoke |

### 22.2 Audit Record Fields

Every audit record must carry:

```json
{
  "audit_id": "aud_...",
  "organisation_id": "org_...",
  "workspace_id": "ws_...",
  "event_type": "tool.invoked",
  "actor_type": "digital_employee",
  "actor_id": "de_...",
  "human_initiator_id": "usr_...",
  "target_entity_type": "connector_synced_record",
  "target_entity_id": "csr_...",
  "action_description": "Created contact record in Salesforce via create_crm_contact tool",
  "api_route": "POST /v1/capabilities/cap_.../run",
  "connector_id": "con_...",
  "tool_name": "create_crm_contact",
  "capability_run_id": "run_...",
  "outcome": "success",
  "policy_evaluation_id": "pev_...",
  "ip_address": "203.0.113.42",
  "user_agent": "DreamTeam-SDK/1.4.0 Python/3.12",
  "occurred_at": "2026-07-01T12:01:05.123Z"
}
```

### 22.3 Audit Immutability

Audit records are append-only at the database level (enforced by RLS policy — see `docs/08_Database_Design.md` Section 17). No API endpoint permits updating or deleting an audit record. Data deletion requests (GDPR) anonymise PII fields within the audit record but never remove the record itself.

---

## 23. Observability Standards

### 23.1 Structured Logging

All API and integration services emit structured JSON logs. Every log line includes:

```json
{
  "timestamp": "2026-07-01T12:00:00.000Z",
  "level": "info",
  "service": "capability-execution",
  "organisation_id": "org_...",
  "request_id": "req_...",
  "run_id": "run_...",
  "duration_ms": 1820,
  "message": "Capability run completed successfully"
}
```

PII fields are excluded from structured logs at emission (see Section 19.7).

### 23.2 Metrics

Platform-level metrics emitted by every service:

| Metric | Type | Labels |
|---|---|---|
| `api.request.count` | Counter | `method`, `path`, `status_code`, `organisation_id` |
| `api.request.duration_ms` | Histogram | `method`, `path` |
| `capability.run.count` | Counter | `capability_slug`, `status` |
| `capability.run.duration_ms` | Histogram | `capability_slug` |
| `connector.sync.duration_ms` | Histogram | `connector_type`, `status` |
| `connector.sync.records_processed` | Counter | `connector_type` |
| `ai.token.input_count` | Counter | `model_id`, `capability_slug` |
| `ai.token.output_count` | Counter | `model_id`, `capability_slug` |
| `ai.provider.latency_ms` | Histogram | `model_id` |
| `ai.provider.error.count` | Counter | `model_id`, `error_type` |
| `webhook.delivery.count` | Counter | `status` |
| `webhook.delivery.latency_ms` | Histogram | |
| `approval.pending.count` | Gauge | `organisation_id` |

### 23.3 Distributed Tracing

Every API request generates a trace with a root span. Trace context is propagated via W3C `traceparent` header across:

- API gateway → Edge Function → Database
- Edge Function → Connector
- Edge Function → Intelligence Service
- Intelligence Service → Model Provider

Traces are the primary debugging tool for cross-service latency investigation. Trace IDs are included in structured logs for correlation.

### 23.4 Key Operational Dashboards

| Dashboard | Key Metrics |
|---|---|
| API Health | Request rate, error rate (4xx, 5xx), p50/p99 latency |
| Capability Execution | Run volume, success rate, average duration, approval queue depth |
| Connector Health | Sync success rate, error rate, rate limit utilisation, record volume |
| AI Provider | Latency, error rate, token consumption, cost per hour |
| Webhook Delivery | Delivery success rate, dead-letter queue depth, retry count |
| Usage & Billing | Token consumption vs budget, API call volume vs plan limit |

### 23.5 Alerting Thresholds

| Condition | Severity | Response |
|---|---|---|
| API error rate > 1% over 5 minutes | Warning | On-call alert |
| API error rate > 5% over 2 minutes | Critical | Incident created |
| Capability run failure rate > 10% | Warning | On-call alert |
| AI provider error rate > 5% over 5 minutes | Critical | Failover evaluation |
| Connector sync failure: 6+ consecutive | Warning | Customer alert + on-call notification |
| Webhook dead-letter queue depth > 100 | Warning | On-call alert |
| Organisation AI budget at 80% | Info | Customer notification |

---

## 24. Documentation Standards

### 24.1 Every Public API Endpoint Must Document

1. **Purpose** — one paragraph: what this endpoint does, when to use it, what it returns
2. **Authentication** — which auth methods are accepted; which scopes are required
3. **Permissions** — role requirements; policy implications
4. **Request schema** — every field with type, required/optional, constraints, and an example value
5. **Response schema** — every field with type and description; example success response
6. **Error codes** — complete list of error codes this endpoint can return; resolution guidance for each
7. **Examples** — at least one full request/response pair in cURL and one SDK language
8. **Rate limits** — which limits apply; what to do when exceeded
9. **Audit behavior** — what audit event is generated; what fields are recorded
10. **API version** — which version introduced this endpoint; current status (stable/preview/deprecated)
11. **Deprecation status** — if deprecated: sunset date, migration guide URL

### 24.2 Documentation Must Not Include

- Internal architecture details (agent names, model providers, database table names)
- Implementation hints that reveal internal routing or execution strategy
- References to infrastructure components (Supabase, Redis, pgvector)
- Cross-tenant data examples

### 24.3 Interactive Documentation

All public API documentation is published as OpenAPI 3.1 specifications. Interactive documentation (Redoc or Scalar) allows developers to:

- Browse all endpoints
- See request/response schemas with examples
- Try API calls against their own sandbox organisation
- Generate code samples in multiple languages

The OpenAPI spec is the source of truth — documentation is generated from the spec, not written separately.

---

## 25. API Anti-Patterns

These patterns are explicitly prohibited. Any design review that encounters them should treat them as blocking issues.

### 25.1 Exposing Internal Agents to Customers

APIs must never reference Agents. Response bodies must never contain `agent_id`, `agent_type`, or any internal execution component identifier. Customers interact with Digital Employees and Capabilities. The Workforce Engine is invisible.

**Why it matters:** Exposing agents leaks implementation details that create coupling. When the internal execution model changes (and it will), external consumers break. The abstraction boundary exists precisely to prevent this.

### 25.2 Bypassing Permissions or Policy Checks

No API endpoint may skip permission or Control Fabric policy evaluation. There is no "internal fast path" that omits policy checks. Service-to-service calls that act on behalf of an organisation must carry the organisation context and evaluate permissions.

**Why it matters:** A permission bypass in an internal API is a privilege escalation vector. When internal APIs are called by compromised services or through misconfiguration, the only protection is that policy checks still run.

### 25.3 Non-Tenant-Scoped APIs

Every data API must require and validate an `organisation_id`. There is no API that returns data across all organisations except platform admin APIs, which are not accessible to customers.

**Why it matters:** A single missing `WHERE tenant_id = ?` clause is a data breach.

### 25.4 Vendor-Specific Logic in Business APIs

Capability APIs must not contain Salesforce-specific field names, OpenAI-specific parameters, or any other vendor-specific concepts. Business APIs express domain concepts. Vendor specifics are Connector implementation details.

**Why it matters:** If a customer switches CRM or AI provider, their integration with DreamTeam should not break. The abstraction layers exist to prevent this coupling.

### 25.5 Unclear or Leaking Error Messages

Error responses that reveal database table names, SQL constraint violations, cross-tenant resource names, internal service names, or stack traces are security vulnerabilities. Every error message must be reviewed: "what does this tell an attacker?"

**Why it matters:** Verbose errors are a reconnaissance tool. A stack trace reveals architecture. A SQL error reveals schema. A 404 on a resource that belongs to another tenant reveals its existence.

### 25.6 Unversioned Public APIs

Releasing a public API endpoint without a version in the URL (`/capabilities/...` instead of `/v1/capabilities/...`) is a commitment to never making a breaking change, or a commitment to a painful future migration. Both are bad outcomes.

**Why it matters:** Customers build systems on public APIs. An unversioned API cannot be changed without breaking those systems. Versioning from day one is always cheaper than retrofitting it later.

### 25.7 Non-Idempotent Retryable Operations

Write operations that can be safely retried must behave idempotently. A Capability run triggered twice with the same idempotency key must return the same `run_id` — not two separate runs. A connector sync triggered twice while one is in progress must return the existing job — not start a second sync.

**Why it matters:** Networks are unreliable. Clients retry. Without idempotency, a single network timeout doubles the work.

### 25.8 Storing Secrets in API Payloads

Connector credentials, API keys, and signing secrets must never appear in API responses — even in encrypted form. They must never be included in webhook payloads. They must never be logged.

**Why it matters:** Any field in an API response will eventually appear in a log, a screenshot, a bug report, or a cURL example in documentation. Secrets in API payloads will be leaked.

### 25.9 Silent Connector Failures

When a connector sync fails, the failure must:

1. Be logged with full context (connector ID, error type, attempt count)
2. Emit a `connector.sync_failed` event
3. Surface as a degraded health signal on the connector
4. Alert the organisation admin after threshold failures
5. Affect the `data_freshness_seconds` indicator on Capability responses

A connector that fails silently leaves Digital Employees operating on stale data without warning.

### 25.10 APIs That Cannot Be Audited

Any API that creates, modifies, or deletes domain data without generating an audit entry is an enterprise trust failure. Audit is not optional for consequential operations. The "is this audited?" question is part of every API design review.

### 25.11 Mixing Connector and Integration Concepts

Providing an API that conflates the Connector (technical binding) and the Integration (configured use) creates conceptual ambiguity that makes permission management, credential rotation, and audit interpretation difficult. Connectors and Integrations are distinct resources at `/v1/connectors/` and `/v1/integrations/` respectively.

### 25.12 `digital_employee.failed` as an Event

There is no such event. Digital Employees do not fail — Capabilities fail, Workflow runs fail, individual Tool calls fail. An event named `digital_employee.failed` exposes internal execution state and implies the Digital Employee persona is broken, rather than correctly identifying the specific execution that failed.

---

## 26. Final API Design Rules

These rules are permanent. They apply to every API endpoint, every webhook event, every connector specification, and every tool definition that DreamTeam ships. Any proposed design that violates a rule requires explicit architectural review and an amendment to this document.

---

**Rule 1: APIs express DreamTeam domain concepts.**
Every endpoint path, resource name, field name, and event type uses the vocabulary of `docs/05_Core_Domain_Model.md`. Infrastructure terminology (agent, embedding, prompt, vector, orchestrator) does not appear in the API surface.

**Rule 2: Capabilities are first-class API resources.**
The Capability is the atomic unit of business value. It is directly invocable, subscribable, and measurable via the API. The Workforce Engine is never directly addressable.

**Rule 3: Every API is organisation-safe by construction.**
Organisation context is required, validated, and enforced before any data access. There is no opt-in tenant scoping. There is no override. Cross-organisation data access does not exist.

**Rule 4: Every API is permission-aware at every layer.**
Authentication proves identity. Authorisation proves entitlement. Control Fabric policy checks prove operational permission. All three evaluate on every request. No layer is optional.

**Rule 5: Every consequential API action is auditable.**
Actions that create, modify, trigger, or delete domain entities generate Audit Trail entries. Silent consequential actions are governance failures. Audit behavior is declared in every endpoint's documentation.

**Rule 6: Connectors are reusable; Integrations are customer-configured.**
One Connector per external system per Organisation. Many Integrations per Connector. This distinction is maintained in API resource structure, documentation, and UI consistently.

**Rule 7: Tools are governed.**
Every Tool has a declared risk level, reversibility class, permission requirement, and audit behavior. There are no ungoverned Tools. The Control Fabric evaluates every Tool invocation before execution.

**Rule 8: Public APIs are stable and versioned.**
No public API endpoint exists without a version. No version is changed in a breaking way without a new major version and a minimum 12-month deprecation window.

**Rule 9: Internal complexity stays internal.**
Agents, model providers, orchestration strategies, embedding models, and vector retrieval are platform implementation details. They do not appear in API responses, error messages, webhook payloads, or documentation.

**Rule 10: Tool and AI protocol compatibility is achieved through adapters, not coupling.**
DreamTeam's tool interface is its own typed standard. Compatibility with MCP, OpenAI function calling, or any future protocol is achieved through an adapter layer. The core tool interface is not coupled to any AI vendor's protocol.

**Rule 11: Webhook events use domain names, never infrastructure names.**
Events are `capability.run_completed`, not `agent.execution.finished`. Events are `digital_employee.handoff_initiated`, not `llm.context.transferred`. Domain events are stable; infrastructure events are not.

**Rule 12: The Delegation Chain is preserved in every audit record.**
Every audit entry that results from a human action carries `human_initiator_id` — the user who started the chain, regardless of how many automation layers intervene. Trust is traceable to a human decision.

**Rule 13: API security is not a feature layer — it is the foundation.**
Input validation, output filtering, permission checks, audit logging, and secrets protection apply to every endpoint. Security is evaluated at design time, not added during review.

**Rule 14: Data portability and deletion are first-class API operations.**
Organisations have the right to export their data and request deletion of PII. These operations have governed API endpoints, are audited, and are implemented before the platform serves regulated industries.

**Rule 15: DreamTeam is a workforce platform — the API reflects this.**
The API does not feel like an AI API. It does not feel like a chatbot API. It feels like an enterprise workforce management API that happens to have AI execution underneath. The vocabulary, the resources, and the design choices should all reinforce this.

---

*End of Document — DreamTeam AI API and Integration Standards v1.0*
