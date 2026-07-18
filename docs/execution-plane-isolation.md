# Execution-plane isolation — design (Frontier-20 #19, DESIGN ONLY)

*Added 2026-07-18. Status: **design document — nothing here is built**,
per the roadmap ("LARGE infra; DESIGN only now"). It exists so the
enterprise conversation ("can actions run inside OUR network?") has a
concrete, honest answer grounded in the real architecture.*

## The ask

Large customers increasingly require that an AI workforce's **actions
against their systems** (helpdesk writes, CRM updates, ERP calls) execute
from infrastructure they control — their VPC, their egress IPs, their
network policies — while the orchestration brain stays vendor-hosted.
This is the 2026 enterprise bar (per-session isolation à la Bedrock
AgentCore; VPC-deployed executors).

## Why DreamTeam's architecture makes this tractable

Every real-world action already funnels through **one chokepoint**:
`connector-hub`'s `execute_action`, which (a) resolves the action from
the registry, (b) runs `decide_action_execution` — trust dial, guardrails
always win, destructive always gates to a human — and (c) performs the
HTTP call to the customer's system with the connector credentials.

The isolation design splits (c) from (a)+(b). **Judgment stays hosted;
only the last-mile HTTP call moves into the customer's network.**

## Design

### Components

- **Hosted (unchanged):** DEs, retrieval, guardrails,
  `decide_action_execution`, approvals, audit chain, metering.
- **Remote Executor (new, customer-deployed):** a small stateless
  container in the customer VPC. Outbound-only — it polls the platform;
  the platform never connects in. Holds the connector credentials
  locally (they never leave the customer network in this mode).

### Dispatch protocol (pull, not push)

1. `execute_action` reaches its final step and, for tenants in isolation
   mode, writes an `action_dispatches` row (payload: action key, params,
   idempotency key — **no credentials**) instead of making the HTTP call.
2. The Remote Executor polls `claim_action_dispatch` authenticated by a
   **DE delegation token** (mig 178 — short-lived, DE-bound, scoped
   `executor.dispatch`, audited to the originating action). This is the
   exact credential model built in #14; no new auth system is needed.
3. It executes the call inside the VPC using locally-held credentials,
   then posts the result (status, response summary, latency) back.
4. `action_executions` completes exactly as today — same audit trail,
   same rollback columns, same metering. The Control Fabric's decisions
   were all made **before** dispatch, so a compromised executor can only
   refuse work or fail loudly; it cannot widen what was authorized.

### Trust boundary (the honest part)

- The platform never holds isolated tenants' connector credentials.
- The executor never sees prompts, knowledge, or other tenants' data —
  only the already-authorized action payloads for its own tenant.
- A stolen executor token is bounded by #14's design: minutes, one DE,
  one scope, revocable, audit-linked.
- What isolation does NOT change: guardrails, destructive gating, and
  approvals still run hosted. A customer wanting judgment itself
  on-prem is a different (much larger) product, out of scope.

### Failure modes

- Executor offline → dispatches age out to `failed` with an honest
  error and an operator alert; nothing silently queues forever
  (same stale-reclaim pattern as `de_work_items`, mig 166).
- Result never returns → same expiry; idempotency keys make customer-
  side retries safe exactly as they do today (mig 157).

## Build plan (when a customer actually needs it)

1. `action_dispatches` table + claim/complete RPCs + tenant
   `execution_mode` flag (default `hosted`) — ~1 migration, patterned on
   the proven work-queue machinery.
2. `execute_action` branch: `hosted` → today's path; `isolated` →
   dispatch row. One edge-function change at the existing chokepoint.
3. Reference executor image (single Deno/Node container, ~300 lines:
   poll → execute → report) + deployment doc.
4. Pilot with one design partner before general availability.

Estimated effort: 1–2 focused weeks including hardening — because steps
1–2 reuse queue, idempotency, and token machinery that already exists
and is already proven. That reuse is the point of designing it now.
