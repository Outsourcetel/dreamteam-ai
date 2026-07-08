# Deployment

This project has **no CI/CD pipeline connected to GitHub or Vercel's own auto-deploy**. Pushing to `main` does **not** automatically trigger a production deployment. Every deploy is a deliberate, manual step. This document exists because that fact was previously undocumented anywhere — found during a pre-launch readiness review (2026-07-08) and flagged as a real operational risk: if the person who knows this process is unavailable, nobody else could ship a fix.

## Why there's no auto-deploy

Vercel's standard GitHub integration (deploy-on-push) was found to be unreliable for this project during earlier work and was abandoned in favor of triggering deploys directly against Vercel's REST API. This is a conscious tradeoff: more manual steps, but a deploy only happens when someone deliberately runs one.

## Prerequisites

- A Vercel API token with access to this project, saved locally as `.vercel-token` (repo root, gitignored — never commit this file).
- Node.js (any reasonably recent version — `fetch` must be available globally, so Node 18+).
- The commit you want to deploy must already be pushed to `origin/main` on GitHub (`Outsourcetel/dreamteam-ai`) — Vercel pulls the build from the GitHub commit SHA, not from your local working tree.

## Steps

1. **Push your commit to `main` first.** The deploy trigger references a commit SHA that must already exist on GitHub.
   ```
   git push origin main
   ```

2. **Get the full commit SHA** you just pushed:
   ```
   git log -1 --format=%H
   ```

3. **Trigger the deployment** via Vercel's Deployments API. The relevant identifiers for this project:
   - Team ID: `team_k1lPliHFcCqvXrbzb3WAFwA2`
   - Project ID: `prj_6KW8R0iQmZuvmb2G9JvGVDZ0PnoN`
   - GitHub repo ID: `1277034187`

   POST to `https://api.vercel.com/v13/deployments?teamId=team_k1lPliHFcCqvXrbzb3WAFwA2` with your Vercel token as a Bearer token and a JSON body:
   ```json
   {
     "name": "dreamteam-ai",
     "project": "prj_6KW8R0iQmZuvmb2G9JvGVDZ0PnoN",
     "target": "production",
     "gitSource": {
       "type": "github",
       "repoId": 1277034187,
       "ref": "main",
       "sha": "<the commit SHA from step 2>"
     }
   }
   ```

4. **Poll the deployment status** until it resolves. `GET https://api.vercel.com/v13/deployments/<deployment id>?teamId=team_k1lPliHFcCqvXrbzb3WAFwA2` and check the `readyState` field: `BUILDING` → `READY` (success) or `ERROR`/`CANCELED` (failed — check `errorMessage` in the response).

5. Once `readyState` is `READY`, the deploy is live at `dreamteam-ai-outsourcetel.vercel.app` (and any other aliases attached to the project).

A working reference implementation of steps 3-4 (as a small Node script) has been used throughout this project's development; recreate it from the API shape above if it's not already at hand.

## What actually gets checked before shipping

As of this doc, `npm run build` (which is also exactly what Vercel's `buildCommand` runs, per `vercel.json`) is `tsc --noEmit && vite build` — a real TypeScript type error will fail the build and the deployment will show `readyState: ERROR`. Before this was fixed (2026-07-08), the build command only ran `vite build`, meaning a type error could ship to production without being caught by the pipeline itself; the type-check had only ever been run as a separate manual step. There is still no automated test suite — see the readiness-review findings for that gap.

## Database migrations are a separate step

Deploying the frontend does **not** apply any pending database migrations. Migrations under `supabase/migrations/*.sql` are applied directly against the production Supabase project (`rfsvmhcqeiyrxivbmpel`) via the Supabase Management API (`POST https://api.supabase.com/v1/projects/rfsvmhcqeiyrxivbmpel/database/query`), authenticated with a Supabase access token saved locally as `.supabase-token` (gitignored, never commit). There is no `supabase db push`/CLI-based migration flow in active use for this project (see `supabase/migrations/README.md` for why) — each migration file is applied as its own SQL statement against that endpoint, in order, and the result should always be checked before moving on to the next one.

**Order matters**: if a frontend change depends on a new database function/table, apply the migration first, then deploy the frontend — not the other way around, since a mid-deploy window where new frontend code calls a not-yet-existing RPC would error for any user hitting it during that gap.

## Rollback

There is currently no one-command rollback for either the frontend or the database:

- **Frontend**: Vercel retains previous deployments and can be pointed back at an older one from the Vercel dashboard (promote an earlier deployment to production) — this has not been scripted/automated for this project yet.
- **Database**: migrations are forward-only. None of the files under `supabase/migrations/` have a corresponding down-migration, and most aren't safe to blindly re-run (they lack `IF NOT EXISTS`/`OR REPLACE` guards). If a migration needs to be undone, it requires hand-writing a new migration that reverses the specific change — there is no generic undo.
