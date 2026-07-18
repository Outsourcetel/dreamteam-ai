# Computer-use runtime contract (Frontier-20 #18 — gates first, capability later)

*Added 2026-07-18. Status: **no runtime exists or ships with the platform.***

Migration 182 built the governance rails for browser/computer-use tasks
**before** any execution capability, so that when one lands it physically
cannot run ungoverned. This document is the contract a future runtime
must implement.

## What exists today (provably inert)

- Feature `computer_use` — **default OFF** per tenant. Proposals are
  refused until a workspace turns it on.
- `computer_use_tasks` — a DE may only **propose** a task (service-role
  RPC `propose_computer_use_task`): a goal (10–2000 chars), a mandatory
  **allowed-domains list (≥1)**, and a step budget (≤50). Every proposal
  opens an `approval_gate` human task; nothing is claimable before an
  explicit human approval.
- `computer_use_runtimes` — the registry of execution workers. It is
  **empty**, and only service-role can register one. A DB trigger (not
  RPC convention) blocks the `claimed`/`running` transitions unless the
  approval is `approved` **and** an active registered runtime holds the
  claim. All three gates were proven with live rollback tests, including
  the empty-domain bypass the tests themselves caught and closed.

## What a runtime must implement

1. **Claim** — call `claim_computer_use_task(task_id, runtime_id)`
   (service role). Returns goal, allowed_domains, max_steps, constraints.
2. **Sandbox** — one isolated, ephemeral browser session per task (no
   shared profiles, no persistent cookies, torn down after the task).
3. **Domain allowlist at navigation time** — every navigation target's
   host must match `allowed_domains` (exact or subdomain). Anything else
   is refused and recorded, never followed. Links found in page content
   are untrusted data (see `docs/SECURITY.md`, prompt-injection firewall).
4. **No credentials, ever** — the worker must refuse to type into
   password/OTP/payment fields and must never receive secrets in the
   task payload. Auth-walled flows are out of scope until a separate,
   founder-approved credential design exists.
5. **Step budget** — hard-stop at `max_steps`; a budget exhaustion is a
   `failed` task with an honest result, not a retry loop.
6. **Audit every step** — append `{step, action, url, screenshot_ref}`
   to `computer_use_tasks.audit` as it goes, so a human can replay what
   the agent saw and did. Screenshots go to platform storage, not the
   task row.
7. **Terminal states** — `done` with a plain-language `result`, or
   `failed` with the reason. The status trigger enforces the legal
   transitions; a worker cannot invent shortcuts.

## Candidate runtimes (founder decision, later)

Hosted browser sandboxes (Bedrock AgentCore browser, Browserbase) or a
self-hosted Playwright worker fleet. Whichever is chosen registers via
`computer_use_runtimes` and inherits every gate above unchanged.
