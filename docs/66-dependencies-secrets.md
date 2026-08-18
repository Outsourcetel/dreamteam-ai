# 66 — Workstream O: dependencies, secrets & supply chain (2026-08-18)

Two supply chains exist here and they are in **opposite** condition. The npm one is among the
tidiest I have measured; the Deno/edge one carries the real risk.

## 1. Headline — zero production-reachable vulnerabilities

`npm audit` reports **4 vulnerabilities (3 moderate, 1 high)**. Reported severity is not reachable
severity, so each was traced:

| Advisory | Package | Reachable here? |
|---|---|---|
| Vite middleware may serve files starting with the same name | vite | ❌ **dev server only** — not shipped |
| esbuild lets any website send requests to the dev server | esbuild | ❌ **dev server only** |
| Arbitrary constructor injection via `deserializeErrors()` in **SSR hydration** | react-router | ❌ **no SSR** — verified: zero `renderToString` / `hydrateRoot` / `StaticRouter`; entry is `createRoot` + `BrowserRouter` |
| **Open redirect via backslash** in `<Link>` and `useNavigate` | react-router / -dom | ❌ **no reachable path** — see below |

The open-redirect advisory is the one that *could* have applied to a client SPA, so it was checked
properly rather than waved off:

* **`<Link>` usages in the entire app: 0.** The product uses its own page-state router
  (`src/lib/pageRoutes.ts`), not react-router links.
* **`navigate()` call sites: 2**, both with non-user-controlled destinations —
  `App.tsx:136` navigates to `PAGE_TO_URL[currentPage]` (a static lookup table) and
  `EmployeeFilePage.tsx:1338` to a constant path plus query params.
* `window.location` assignments: 2 — one hardcoded `/platform`, one OAuth `authorize_url` returned
  by our own edge function.

**Verdict: patch on the next convenient upgrade, not as an incident.** Registers D-1 and D-2 can
be re-ranked accordingly.

## 2. The npm surface is genuinely small and clean

| Measure | Value |
|---|---|
| Direct production dependencies | **5** — `react`, `react-dom`, `react-router-dom`, `@supabase/supabase-js`, `@sentry/react` |
| Direct dev dependencies | 12 |
| **Total packages installed** | **134** |
| Production licenses | **5 of 5 MIT** |
| Copyleft / unknown / non-commercial | **none** |

134 total packages for a React application of this size is unusually restrained — a typical
equivalent carries 800–1,500. There is no license contamination and nothing abandoned in the
direct set. **This is a real asset in a procurement review** and should be said out loud.

## 3. No secret has ever been committed — verified, not assumed

`.env`, `.env.local` and `.env.test` are all gitignored today. History was checked properly:
every commit tree in `git rev-list --all` was tested for a `.env` blob.

Exactly one commit ever contained it — `97f6eac3` (22 June), removed 13 minutes later in
`8a3baa16`. Its contents:

```
CI=false
GENERATE_SOURCEMAP=false
```

Build flags from the CRA→Vite migration. **No credential of any kind has entered this
repository's history.**

## 4. The real supply-chain risk is the edge layer (register **D-12**)

| Edge function imports | Count |
|---|---|
| **Floating (no pinned version)** | **71** |
| Pinned to an exact version | 60 |

**54% of edge-function imports resolve to whatever the upstream host serves at deploy time**, with
no lockfile equivalent. These modules execute inside functions that hold the **service-role key** —
the credential that bypasses row-level security entirely.

That is the asymmetry worth stating plainly: the npm dependencies, which run in a browser with a
publishable key, are pinned and audited. The Deno dependencies, which run with unrestricted
database credentials, are not. A hijacked upstream module would land on the privileged side.

## 5. Secrets — where they live and when they moved

| Secret | Storage | Last rotated | Note |
|---|---|---|---|
| Connector credentials | **Vault references** (`connector_secrets`: 2 rows, 2 refs, 0 raw values) | — | mig 580's plaintext history is remediated (docs/62) |
| `ANTHROPIC_API_KEY` | `platform_config` (Vault-backed) | 2026-07-11 | 38 days |
| `RESEND_API_KEY` | `platform_config` (Vault-backed) | 2026-07-01 | **48 days — and register A-6 records it as the key pasted into a chat** |
| `SUPABASE_SERVICE_ROLE_KEY` | platform-injected into edge functions | — | never in repo (docs/50) |

**A-6 is the live secrets action:** a key that has appeared in a chat transcript should be treated
as disclosed regardless of who saw it. Rotating Resend costs minutes and the channel is currently
dormant anyway (D-9), so this is the cheapest possible time to do it — before email is lit, not
after.

## 6. What to do

1. **Rotate the Resend key** (A-6). Minutes, zero blast radius while email is dark.
2. **Pin the 71 floating edge imports** (D-12) — the highest-value supply-chain work in the repo,
   because that code runs privileged.
3. **Upgrade react-router and the vite toolchain** on the next convenient pass (D-1, D-2) — with
   the reachability analysis above attached, so nobody re-escalates them from a scanner summary.
4. Keep the dependency count small. It is currently a genuine advantage.

## 7. Verdict

**Nothing here blocks a pilot.** The npm chain is small, MIT-clean, and has no
production-reachable vulnerability; no credential has ever been committed; connector secrets are
in Vault.

The one finding that deserves real attention is structural rather than urgent: **the privileged
half of the system has the weaker supply chain.** Pinning 71 imports is a morning's work and
closes it.
