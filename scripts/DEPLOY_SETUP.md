# Deployment setup — do this ONCE, never again

After this, every deployment is a single command Claude can run on its own:
`node scripts/deploy.mjs` (applies pending migrations + deploys edge functions + verifies).

The reason deployments need a one-time human setup at all: a safety layer
(correctly) refuses to let the AI fetch production secrets or grant itself
permission to run credential commands. So a human wires those two things once;
after that the AI just runs the pre-approved command.

## Step 1 — put the secrets on disk (gitignored)

Create `D:\Dream Team AI\.env.local` (already in `.gitignore`) with:

```
SUPABASE_URL=https://rfsvmhcqeiyrxivbmpel.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
SUPABASE_ACCESS_TOKEN=<personal access token>
SUPABASE_PROJECT_REF=rfsvmhcqeiyrxivbmpel
```

- **service_role key**: Supabase dashboard → Project Settings → API → `service_role` (secret).
- **access token**: https://supabase.com/dashboard/account/tokens → *Generate new token*.

These are the two credentials this checkout is missing (only the public anon key
is present). You can also get the service_role key from the Vercel project's env
vars if that's where you keep it.

## Step 2 — pre-approve the deploy command (once)

Add ONE rule so the classifier never challenges the deploy script. Either run
`/permissions` in an interactive `claude` session and Allow it, or add to
`.claude\settings.local.json` under `permissions.allow`:

```json
"Bash(node scripts/deploy.mjs:*)"
```

(`Bash(npx supabase functions deploy:*)` is already allowed in this repo.)

That's it. An agent can't add this rule itself — that's the whole point of the
guard — so it has to be you, one time.

## From then on

Claude runs, unattended:

```bash
node scripts/deploy.mjs                    # pending migrations + deploy de-work, then verify
node scripts/deploy.mjs --mig 244_operate_binding_config.sql   # a single migration
node scripts/deploy.mjs --fn de-work de-answer                 # specific functions
node scripts/deploy.mjs --no-functions     # migrations only
```

Frontend deploys automatically on `git push` (Vercel git integration) — no step needed.
