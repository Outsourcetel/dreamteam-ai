# DreamTeam AI

A multi-tenant platform for **digital employees** (DEs) — AI workers that hold a
role, a reporting line and a permission scope, and do real work across support,
finance, sales and ops inside a customer's existing systems. The product
identity is a **governed workforce OS**: the differentiator we lead with is the
control fabric — approvals, trust dials, guardrails, audit trail — not raw
answer quality ([docs/24](docs/24-de-roadmap-of-record.md), founder-locked).
It never replaces a system of record; it sits on Postgres/Supabase plus a set
of connectors and adds the judgment layer on top.

**New here? Read in this order:** [CLAUDE.md](CLAUDE.md) (how work is done
here) → [docs/24](docs/24-de-roadmap-of-record.md) (what we are building and
why) → [docs/46](docs/46-census.md) (what is actually alive) →
[docs/47](docs/47-debt-map.md) (what is broken, measured).

---

## Getting it running

Requires **Node >= 22** (`package.json` engines). Verified on Node v24.18.0 /
npm 11.16.0.

```bash
npm install
cp .env.example .env      # fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev               # http://localhost:5173
```

Those two `VITE_` values are all the frontend needs — `src/lib/env.ts` throws at
startup if either is missing. Everything else is opt-in:

| File | Who reads it | Documented in |
|---|---|---|
| `.env` | the Vite frontend (`VITE_*` only) | `.env.example` |
| `.env.local` | scripts and deploy tooling (`SUPABASE_ACCESS_TOKEN`, service-role key) | [scripts/DEPLOY_SETUP.md](scripts/DEPLOY_SETUP.md) |
| `.env.test` | the live test suites, against the **dev** project only | [tests/README.md](tests/README.md) |

All three are gitignored. Deploys are deliberate and manual — frontend via
Vercel's API ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)), migrations and edge
functions via the Supabase Management API
([scripts/DEPLOY_SETUP.md](scripts/DEPLOY_SETUP.md)).

## The commands that matter

| Command | What it actually does |
|---|---|
| `npm run dev` | Vite dev server on `:5173`. Ready in ~1 s. |
| `npm run build` | `tsc --noEmit && vite build`. ~25 s; emits a 2.17 MB main bundle (580 kB gzip). **`tsconfig.json` includes only `src/`** — `supabase/` is not typechecked here. |
| `npm run test:unit` | The three credential-free vitest files (27 tests, ~1.3 s). Runs in CI. |
| `npm run certify:offline` | The 4 of certify's 9 sections that need no credentials: `typecheck`, `edge-typecheck`, `design-drift`, `suite`. ~65 s. Prints `OFFLINE SUBSET GREEN — 4/9` and names the 5 sections that did **not** run. Runs in CI on every push. |
| `npm run certify` | All 9 sections, including live probes against the database and the golden-path write loop. **Needs `SUPABASE_ACCESS_TOKEN` in `.env.local`** and takes ~3 min; only prints `CERTIFIED` when every section is green. |
| `npm test` | Full vitest sweep. Needs `.env.test` **and** an access token — it fails without them by design, rather than skipping. |

`certify` is the one green bar that means something. What each section asserts,
and which invariants are PROVEN vs merely believed, is
[docs/45](docs/45-certification-scoreboard.md).

## Map of the code

| Path | What is in it |
|---|---|
| `src/` | The React/Vite app — 203 files, ~79k lines. `pages/` (67), `components/` (57), `lib/` (62 API/domain modules), `design/` (the design system primitives + tokens). |
| | **Routing is not `<Route>` elements.** `src/lib/pageRoutes.ts` maps 67 `Page` keys to URLs, typed `Record<Page, string>` so an unmapped page is a compile error. `src/App.tsx` renders off the key. |
| `supabase/functions/` | 60 Deno edge functions plus `_shared/` — ~32k lines all told. The big ones are `connector-hub` (one adapter per connected system) and `playbook-execute` (one branch per step type). |
| `supabase/migrations/` | 672 tracked SQL files, applied in number order via the Management API — **not** `supabase db push`. Read [supabase/migrations/README.md](supabase/migrations/README.md) first: 001–010 are legacy and must not be re-applied. |
| `supabase/baseline/` | Generated snapshots the gates ratchet against — the EXECUTE allowlist, the edge type-error ceiling, the schema census. |
| `scripts/` | 22 `.mjs` operational scripts. The load-bearing ones: `certify.mjs`, `golden-path.mjs`, `audit-role-gates.mjs`, `audit-silent-refusals.mjs`, `deploy.mjs`, `db-query.mjs`. |
| `tests/` | 10 vitest files. Three are offline; the rest need real credentials and hit the isolated dev project, never production. `tests/README.md` explains why there are no mocks. |
| `docs/` | 142 files — see below. |
| `.github/workflows/ci.yml` | Typecheck, build, unit tests, `certify:offline`, prod-dependency audit; then tenant-isolation and ACL-invariant jobs. Every job either runs or fails — there is no skip. |

## Documentation

**The numbering is chronological, not a hierarchy — do not start at 05.**
`docs/` holds 43 numbered documents (05–47) written over five weeks. The
lowest-numbered ones (05–09) were last touched 2026-07-01 and are the stalest
things in the tree; the newest are the ones to trust.

**Current and load-bearing:**

| Doc | What it is |
|---|---|
| [CLAUDE.md](CLAUDE.md) | The working agreement. Loads every session; outranks everything else. |
| [docs/47-debt-map.md](docs/47-debt-map.md) | 86 measured findings, each with the command that produced it, plus a three-phase plan. Also lists the 14 claims that did **not** survive review. |
| [docs/46-census.md](docs/46-census.md) | What is alive, starved or dead — decided by `pg_stat_user_tables` and reference counting, not by taste. |
| [docs/45-certification-scoreboard.md](docs/45-certification-scoreboard.md) | The invariant ledger behind `npm run certify`, ringed by blast radius. |
| [docs/24-de-roadmap-of-record.md](docs/24-de-roadmap-of-record.md) | Founder-locked wedge and roadmap. [docs/23](docs/23-de-deep-analysis.md) is its evidence. |
| [docs/39-founder-decisions-execution-program.md](docs/39-founder-decisions-execution-program.md) | Decisions already made. Build from these; do not re-open them. |
| [docs/design-system.md](docs/design-system.md) | Design System v1. Adoption is part of shipping a primitive, not a follow-up. |
| [docs/44-org-scoped-permissions.md](docs/44-org-scoped-permissions.md) · [docs/29](docs/29-permissions-and-de-reporting-line.md) | The permission model: two axes, default deny. |
| [docs/38-the-functioning-de.md](docs/38-the-functioning-de.md) · [docs/37](docs/37-the-os-beyond-support.md) | What a DE actually does at runtime, and the OS beyond support. |
| [docs/41-commercial-viability-and-role-coverage.md](docs/41-commercial-viability-and-role-coverage.md) · [docs/42](docs/42-voice-channel-build-vs-partner.md) | Role coverage and the voice-channel decision. |
| [tests/README.md](tests/README.md) | Why the suites use real signups and real sessions, and which dev-project gaps are still open. |

**Historical — read for context, never as current state:** the 13 `.md` files at
the repo root (`WEEK1_*`, `WEEK2_*`, `SOPHIE_*`, `DEPLOYMENT_READY.md`, …) and
`docs/GO_LIVE_*`, `docs/PHASE1_*`, `docs/05`–`docs/09` are July snapshots. Where
a snapshot and a numbered audit disagree, the higher number wins.

`docs/kb/` is 65 **customer-facing** help articles, not engineering
documentation.
