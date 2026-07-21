# Browser Operator — runtime worker (Steel self-host)

The piece that actually drives Chrome for a Digital Employee. It's the **governed**
answer to ungoverned browser agents (e.g. Manus): every action is on an
**allowlist**, requires **human approval**, is **step-bounded**, is
**credential-safe** (the model never sees a password), and is **fully audited** —
the enterprise posture that a general autonomous agent doesn't give you.

It runs **outside** the Supabase/Vercel app (which can't host a browser) and talks
to DreamTeam only through the governed `mig-182 / 241 / 242` RPCs, so the database
stays the authority: a task can't run without approval **and** an active runtime.

## Architecture
```
  DreamTeam UI ──propose──▶ computer_use_tasks ──human approve──▶ (approved)
                                                                     │
   this worker ──register+heartbeat──▶ computer_use_runtimes         │ claim (atomic gate)
        │                                                            ▼
        └── Steel (self-hosted Chrome) ◀──Playwright CDP── run DOM-first loop with Claude
                     │                         (allowlist · no-creds · no irreversible · audit)
                     └── every step ──append_browser_task_step──▶ task.audit  ──▶ step replay in the UI
```
- **Engine:** DOM-first (reads the accessibility tree — cheaper/faster/more reliable
  on web apps; needs no computer-use beta). Vision fallback is a documented TODO.
- **Browser host:** [Steel](https://steel.dev) — open-source (Apache-2.0), free to
  self-host, isolated Chrome per task.

## Run it (free, self-hosted)
```bash
cd runtime/browser-operator
cp .env.example .env
#  set SUPABASE_SERVICE_ROLE_KEY  and  ANTHROPIC_API_KEY
docker compose up --build
```
That starts Steel + the worker. The worker registers itself; the **"browser
connected"** pill in the Browser Operator page turns green. Approve a task in the
UI and it runs, streaming its step-by-step replay back into the page.

Local dev without Docker: `npm install && npm run dev` (point `STEEL_BASE_URL` at a
running Steel, e.g. `http://localhost:3000`).

## What's enforced (in `src/agent.ts`)
- **Allowlist** — `navigate()` refuses any host not on the task's `allowed_domains`.
- **Credential-blindness** — the model never types into password fields; with the
  `vault_injected` policy the worker types a vault secret the model can't see;
  otherwise password entry is refused. (Bind `credentials.get()` in `src/index.ts`
  to your secret vault to enable vault login.)
- **Irreversible-action interception** — clicks that look like buy/pay/delete/send
  are refused and reported for a human.
- **Injection firewall** — page content is presented to the model as DATA, never
  instructions.
- **Step budget** — hard stop at the task's `max_steps`.

## Configuration
See `.env.example`. The worker needs the Supabase **service role** (kept only on
this server) and an **Anthropic key**.

## Status / honesty
Built as a complete, deploy-ready reference. It has **not** been run end-to-end
here (needs a live Steel host + Anthropic credits). Before production: pin the Steel
image tag, confirm Steel's exact session-create response shape against your Steel
version (`src/steel.ts`), bind the credential vault hook, and pilot on one
low-risk internal web app with a tight allowlist. The governance spine it plugs
into (approval gate, active-runtime requirement, audit) is already live in DreamTeam.
