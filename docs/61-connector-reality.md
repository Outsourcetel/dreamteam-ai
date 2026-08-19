# 61 — Workstream P: connector reality check (2026-08-18)

Every integration gets one honest label: **live-proven** (a real write landed against a real
third-party system, with a receipt), **live-read-only**, **demo-only**, **built-unverified**, or
**vapour**. The test for "live-proven" is a receipt in `action_executions`, not a config row.

## 1. The headline — the only real integration has been dead for a week (register **B-13**)

```
erpnext · outsourcetel-hq
  status column:        "connected"
  last SUCCESS:         2026-08-11 21:30
  last ERROR:           2026-08-18 08:20  (today)
  consecutive failures: 6,714
  error:                http_402
```

`http_402` is *Payment Required* — the dev Frappe Cloud instance hit a billing wall on 11 August
and has been refusing every call since. That is **~43 retries an hour against a dead endpoint,
for seven days, with no circuit breaker.**

**The display is honest — the stored column is not.** `connectors.status` still reads
`connected`, but the UI never trusts it: `computeHealth()` returns `down` at 3+ consecutive
failures and `connectionState()` renders **"Not working"** in the danger tone. Read-path truth
over stored marker, correctly implemented. Nobody was lied to — **nobody was told, either**,
which is register C-8 for the third time in this review.

## 2. What has *actually* been written to a third-party system

`action_executions` carries a receipt only when something really executed:

| Decision | Count | With receipt |
|---|---|---|
| auto_executed | 31 | **31** |
| executed_after_approval | 16 | **16** |
| human_gated_destructive | 60 | 0 (gated, never run) |
| human_gated_trust | 50 | 0 (gated, never run) |
| failed | 12 | 0 |
| guardrail_blocked | 11 | 0 |
| expired | 6 | 0 |

**47 receipted executions in total.** By connector:

| Connector | Actions | Receipts | What it really is |
|---|---|---|---|
| generic_rest | 76 | 22 | **jsonplaceholder** — a public test API |
| template | 62 | 11 | **jsonplaceholder** via the template engine |
| dreamteam (self) | 36 | 10 | internal plumbing, not an integration |
| **erpnext** | **13** | **4** | **the only real third-party system** |

> **Four.** Four receipted writes against a genuine external system, ever — and that system has
> been down for a week.

## 3. The matrix — what may be said out loud

| Integration | Label | Evidence |
|---|---|---|
| **ERPNext** | 🟡 **live-proven, currently DOWN** | 4 receipted writes; dead since 08-11 (`http_402`) |
| **Stripe (MCP)** | 🟠 built-unverified | connector connected 08-05, 1 allowlisted MCP server, **0 receipted actions** |
| generic_rest ×3 | ⚪ demo-only | jsonplaceholder, on a suspended demo tenant |
| template ×2 | ⚪ demo-only | jsonplaceholder |
| Salesforce | 🔴 vapour | `disconnected`, labelled "no creds yet" |
| Zuora | 🔴 vapour | `disconnected` |
| Zendesk | 🔴 vapour | an edge function exists; **no connector row anywhere** |
| The other 75 | ⚪ **catalogue, not integrations** | `connector_providers` holds **75** entries |

### The 75-provider catalogue is a marketing hazard

`connector_providers` is a genuinely useful thing — 75 systems with setup metadata, credential
field definitions and help text, so an owner can *configure* one. It is **not** 75 working
integrations, and a screenshot of that list would imply exactly that. The five-rung connection
ladder in the UI is honest about this (rung 2 says *"available on request — built when the first
customer needs it"*); a website would need the same discipline.

## 4. What this changes

**docs/56's integration claim stands and gets sharper.** The honest external-integration count is
**one** (ERPNext), not two — Stripe is connected but has never executed anything, so it is
built-unverified, not live.

**It does not change the go/no-go**, because docs/57 already ranked integrations as a
*blocks-scale* gap, not a pilot blocker. The support wedge needs no connector at all.

**It adds two jobs:**

1. **Restore ERPNext** (a billing decision on the Frappe instance, or move to a real one) and
   **add a circuit breaker** — 6,714 retries at an endpoint that returned 402 six thousand times
   is not resilience, it is a loop nobody watches.
2. **Prove one Stripe write** end to end, or relabel Stripe as roadmap.

## 5. Verdict

The connector *machinery* is real: a template engine, 75 catalogued providers, an MCP path, a
receipt discipline that distinguishes a gated intention from a landed act, and a UI that derives
health rather than parroting a column. The connector *reality* is one integration, four writes,
and a week of silent failure.

That gap — excellent machinery, almost no traffic — is the same sentence this review has written
about the workforce, the trust ladder and the guardrails. It is the defining shape of the product
at four months.
