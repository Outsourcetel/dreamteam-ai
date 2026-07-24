# Security closeout — action-path defects (2026-07-25)

Three defects were found in the action/approval path during the §3 breadth design pass
(adversarial workflow `wf_1075f915-cfc`), fixed the same day, and then **checked against
production data to establish whether they were ever exploited**. This is the record.

All three were pre-existing; none were introduced by the §3 work. Evidence queries were
read-only.

---

## 1. Forged-approval gate bypass — CRITICAL

**What it was.** `connector-hub` skipped the entire action gate when the request carried an
`approved_execution_id` (`if (!approvedExecutionId) { …gate… }`). The claim added in
`89c34da` only engaged `if (gatedTaskId)`, so an id that resolved to nothing — a nonexistent
uuid, another tenant's row, or **the caller's own `mode:'preview'` row** (written with
`task_id` NULL) — fell through to `runRegisteredAction` and called the external system.
`connector-hub` authenticates any signed-in tenant member, so any member could execute any
registered action with **no** destructive floor, guardrails, semantic screen, amount check,
spend cap, or trust dial. The row was then recorded as `executed_after_approval`, so the
ledger asserted a human approved what no human saw.

**Fix.** `19ba32f` — the claim is mandatory. An unresolvable row or NULL `task_id` →
`approval_not_found`; a row belonging to a different action/connector → `approval_mismatch`
(an approval for action A can never be replayed onto action B); a task not actually approved
→ `approval_not_valid`. No path with `approved_execution_id` can reach the external call
without a successful claim.

**Was it exploited? NO.** Of **16** all-time executions claiming approval, **16** are backed
by a real `human_gated_*` row whose `human_tasks` status is `approved`. **0 unbacked.**
(175 executions total.)

---

## 2. Ungoverned MCP write path — CRITICAL

**What it was.** `mcp-client` `call_tool` invoked a third-party MCP tool with caller-supplied
arguments and sent the vault-decrypted bearer — a real external side effect — while calling
no governance whatsoever (no `decide_action_execution`, no approval, no exactly-once, no
audit of a gate decision). Authenticated on tenant membership alone.

**Fix.** `2e61e09` — returns `403 mcp_writes_not_governed`. Grep confirmed **zero** callers
in `src/` or `supabase/functions/`, so nothing legitimate broke. The governed re-enable is to
register MCP tools as `action_definitions` so they inherit the whole gate (deferred — see
docs/24; it needs a connector-mapping decision).

**Was it used? NO.** `call_tool` audits every invocation; **0** such audit events exist,
despite **2** MCP sources being configured (so the endpoint was reachable and simply never
called).

---

## 3. Wrong-system tool collision — HIGH

**What it was.** `get_agentic_tools_for_de` emitted agentic tool names as
`category || '__' || action_key` with no connector discriminator. A tenant with two connected
connectors in one category matches the same category-scoped `action_definitions` for both, so
the identical tool name was emitted twice with different `connector_id`s. `de-work` builds
`new Map(tools.map(t => [t.name, …]))` — duplicate keys silently collapse, **last connector
wins** — so an action (even a human-approved one) could execute against the *wrong external
system*. The duplicate name also entered the model's tool array twice, and a dotted
OpenAPI-derived `action_key` is illegal for the model API (a malformed tool definition 400s
the whole request, taking a tenant's entire workforce down).

**Fix.** mig 321 / `87e5e8e` — per-connector discriminator, charset-sanitised and
length-bounded to `^[a-zA-Z0-9_-]{1,64}$`. Safe because the name is opaque: both callers
resolve `connector_id`/`action_key` by looking the name up in the same emitted list, so it
round-trips. Proven in SQL: two connectors × same category+action → distinct names.

**Was it exploited? NO REAL EXPOSURE.** Exactly **one** tenant ever had 2 connected
connectors in a single category: **Acme Telecom (`acme-telecom`, a demo tenant)**, category
`product_system` — and both connectors point at **jsonplaceholder**, a public fake API
("Acme Product API (demo: jsonplaceholder /users)" and "JSONPlaceholder via template"). 7
executions occurred in that category. No real customer system could have been misrouted.

**Honest limitation:** this is inferred from present-day connector configuration. The
execution ledger does not record which connector the model *intended*, so a historical
misroute cannot be reconstructed directly — the conclusion rests on the fact that the only
affected tenant is a demo tenant whose two connectors both target a public test API.

---

## Net

| Defect | Severity | Fixed | Exploited |
|---|---|---|---|
| Forged-approval gate bypass | Critical | `19ba32f` | No — 16/16 approvals genuine |
| Ungoverned MCP `call_tool` | Critical | `2e61e09` | No — 0 invocations |
| Wrong-system tool collision | High | mig 321 / `87e5e8e` | No real exposure — demo tenant, public test API |

No customer data was exfiltrated, no unauthorised external action was executed, and no
credential left its connector's host. All three fixes are deployed and verified.
