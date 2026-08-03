# MCP as a first-class, governed connector — design

**Status:** DESIGN, awaiting founder approval on the approach + a target MCP server. Nothing built.
**Date:** 2026-07-29
**Ask:** let a DE use any allowlisted MCP server's tools *through* the governance gate
and category contracts — not the current fetch-only specialist-consult lane.

---

## 0. The crux (the one idea the whole design rests on)

**MCP tools already carry the exact risk signal our action gate needs.** The MCP spec's
tool annotations — `readOnlyHint`, `destructiveHint`, `idempotentHint` — map 1:1 onto our
`action_definitions.risk` (`destructive` / `idempotent`). So an MCP tool becomes a
*registered action*: a read-only tool can auto-execute (subject to trust), a destructive
one is floored to human approval — through the **same** `decide_action_execution` →
`human_tasks` → `claim_gated_action_execution` path we already run for every connector
write. MCP stops being a special lane and becomes "just another provider" under the
existing moat.

> **Fail-safe rule (recommended, needs your nod):** a tool with NO annotations is treated
> as **destructive → human-gated** until proven read-only. A sloppily-annotated server can
> never auto-fire a side effect. This is the one design decision I want confirmed.

---

## 1. What already exists (reuse — this is why it's ~weeks not months)

- **`mcp-client` edge fn** — real MCP client (JSON-RPC 2.0 over Streamable HTTP:
  initialize → tools/list → tools/call), Vault-encrypted bearer auth, SSRF-safe. The transport is done.
- **`mcp_server_allowlist`** — servers must be approved before we call them. The security guardrail is done.
- **The action gate** — `decide_action_execution` (destructive-floor → guardrail → trust),
  `record_action_execution`, `human_tasks` (action_approval), `claim_gated_action_execution` (exactly-once).
- **`data_access_grants`** + `resolve_access` — per-DE, default-deny governed access.
- **`action_definitions`** + `get_agentic_tools_for_de` — the registered-action model + how tools reach a DE.
- **`connectors`** + Vault secrets + connector-hub router.

## 2. What's new (build)

1. **`mcp` connector provider.** A connector row: `provider='mcp'`, `config.mcp_url` (must be
   in `mcp_server_allowlist`), secret = the server's bearer token (Vault). Widen
   `connectors_provider_check`; add a `PROVIDERS.mcp` wizard entry (pick an allowlisted
   server + paste token).
2. **Handshake → tool registration.** connect/sync for an `mcp` connector calls mcp-client
   `handshake`, captures the FULL tool defs (name, description, inputSchema, **annotations**)
   — today it stores only a name/description summary — and upserts each tool as an
   `action_definition` (`provider='mcp'`, `execution={mcp_tool, connector_id}`,
   `param_schema` from the tool's inputSchema, `risk` derived from annotations per §0).
3. **Governed call path.** connector-hub `execute_action` for `provider='mcp'` → resolve the
   tool's `action_definition` → `decide_action_execution` (using the derived risk) → auto:
   mcp-client `call_tool` + receipt; gated: `human_tasks` → on approval, `claim_…` →
   `call_tool`. **Reuses the existing gate + claim + audit verbatim.**
4. **DE tool exposure.** `get_agentic_tools_for_de` already emits an action as a DE tool when
   the DE has a `write_back` grant on a connected connector — so MCP tools appear automatically
   once (2)+(3) land. Read-only tools need only `read`/`search`.
5. **Read semantics.** `readOnlyHint` tools return results fetch-only (like `category_op`,
   `persisted:false`) — nothing stored, cited in the audit trail.
6. **UI.** mcp connector wizard, per-tool inventory with a risk badge (auto / human-gated),
   and an allowlist-management surface (platform-admin).

## 3. Governance guarantees (the moat holds)

- Only **allowlisted** servers are callable (`mcp_server_allowlist`).
- Per-DE access via `data_access_grants` (destructive tool needs `write_back`).
- Every call flows through `decide_action_execution` → destructive floored to a human, audited,
  plain-language receipt, exactly-once claim.
- Fail-safe default (§0) → un-annotated ⇒ human-gated.
- Same drift/health/audit surfaces as any connector.

## 4. Phased plan (each independently provable, R3)

| Slice | Build | Exit proof |
|---|---|---|
| **M1** ✅ **SHIPPED 2026-08-04** (mig 541, commit 32ee618) | `mcp` provider + handshake captures annotations + `sync_mcp_tools` upserts tenant-scoped `action_definitions` with derived risk | **PROVEN**: echo→`destructive:false`, delete_widget→`true` (declared), poke→`true` (**fail-safe**, un-annotated) |
| **M2** ✅ **SHIPPED 2026-08-04** | governed call path — one `mcp_tool_call` executor for every tool on every server; tool name travels in the definition, never from the caller | **PROVEN**: execute_action → `human_gated_destructive` / `human_gated_trust` per derived risk; ungoverned direct `call_tool` **403 refused**; governed path executes and returns output. ⚠ approval→execute is human-gated by design (not faked) |
| **M3** | DE tool exposure + wizard UI + allowlist management | a DE sees + invokes an MCP tool; the destructive one gates for approval |
| **M4** | polish: per-tool receipts, health, audit surfacing | drift/health parity; screenshots |

**Effort: ~4–6 sessions**, because the gate, Vault, allowlist, and DE-tool machinery are all reused — the new code is provider registration + tool→action mapping + the mcp branch in execute_action.

## 5. Prerequisite (G0) — a target MCP server to prove against

To build+prove this (R3 forbids mocking the proof), we need one **allowlisted MCP server with
auth**. Options, founder picks:
- **HubSpot's MCP server** — ties to the earlier thread; needs HubSpot MCP credentials.
- **A public/reference MCP server** (e.g., a read-only demo server) — fastest for M1/M2.
- **A tiny local MCP server** we stand up — full control, no third-party creds.

## 6. Decisions — LOCKED 2026-07-29

1. **Approach APPROVED** — MCP as a provider whose tools become gated action_definitions.
2. **Fail-safe default: un-annotated tool ⇒ destructive ⇒ human-gated.** A server that omits
   annotations can never auto-fire a side effect.
3. **Proof target: a public reference MCP server.** Realized as a self-controlled MCP server
   deployed as an edge function (real Streamable-HTTP protocol, HTTPS so it passes the SSRF
   guard, no third-party creds) exposing three tools — a read-only one (readOnlyHint), a
   destructive one (destructiveHint), and one with NO annotations — so M1/M2 can prove risk
   derivation AND the fail-safe in one shot.

BUILDING M1 now.
