# HEADLINE
Good news with one catch. All five functions the audit's runtime claims rest on (de-answer, de-work, widget-ask, connector-hub, playbook-execute) are running exactly the code the audit read — every trust-dial check, decision-trace write, and approval gate the audit described was verified present in the actual deployed code, so the audit's conclusions stand for production. The catch: 6 of 60 deployed functions are running slightly older code than the repo — five of them are missing a security fix (an SSRF hardening committed July 26 that blocks a trick for reaching cloud-internal addresses) because they were last deployed a few hours before that fix landed, and site-import is missing two July-27 bug fixes. None of this touches the audit's claims; all of it is fixed by redeploying six functions (which this read-only pass was not allowed to do). Reassuring integrity result: every deployed byte matches a known git commit — nothing hand-edited or unaccounted-for is running in production.

# STATS
60 deployed functions inventoried (all ACTIVE); 60/60 slug match with repo (no orphans either direction); all 60 sources downloaded and diffed file-by-file including bundled _shared snapshots; 54 IN-SYNC, 6 DRIFTED, 0 UNVERIFIABLE; 5/5 audit-critical code sites CONFIRMED in deployed bodies; verify_jwt: 49 false / 11 true, 0 mismatches vs expectations (de-answer/de-work/widget-ask/scim all false as required); drift provenance pinned to exact commits (e0ae485~1 and e0ae485); 0 repo files modified by this pass (verified via git status).

# Deploy Parity Pass — docs/31 Commitment #1

**Date:** 2026-07-27 · **Project:** rfsvmhcqeiyrxivbmpel · **Mode:** strictly read-only (no repo edits, no deploys; verified `git status -- supabase/` clean before and during)

## Method (so the verdicts can be trusted)

1. **Authoritative deployed list** from the Supabase management API (`GET /v1/projects/…/functions`): 60 functions, all `ACTIVE`, with `verify_jwt`, `version`, `updated_at` recorded (raw JSON kept in scratchpad `parity/functions_list.json`).
2. **Set comparison:** 60 deployed slugs vs 60 repo dirs under `supabase/functions/` — **perfect match, no orphans in either direction.**
3. **Source download:** `npx supabase functions download <slug>` run per-function from an isolated scratchpad directory (verified on a test function that the CLI writes to its own cwd tree, **not** the repo). The CLI returns the deployed bundle **unbundled** — the function's `index.ts` plus each `_shared/*.ts` file as deployed — so no normalization heuristics were needed: every file was diffed byte-for-byte (CRLF-normalized) against the repo.
4. **Per-function `_shared` isolation:** each function was downloaded into its own directory because deployed `_shared` files are per-function deploy-time snapshots; comparing them per function is what caught the drift below.
5. **Drift provenance pinned via git:** drifted files were additionally compared against historical repo states (`git show <commit>:<path>`).

**Limits:** diffs covered `.ts`/`.js` files (all bundles observed contained only `.ts`). The repo is shared with two other active sessions; `supabase/` was git-clean at pass start and no repo modifications were observed during the pass. The deployed list and downloads are a point-in-time snapshot (2026-07-27).

## Headline result

- **54 / 60 IN-SYNC** — deployed source byte-identical to repo, including every bundled `_shared` snapshot.
- **6 / 60 DRIFTED** — all six are **repo-ahead-of-production** (stale deploys), and every deployed byte matches a known git commit state. **Nothing is running in production that never existed in git** — no hand-edited or unknown versions anywhere.
- **0 UNVERIFIABLE.**
- **The docs/31 audit's largest evidentiary hole is closed:** none of the drift touches any code path the audit's runtime claims rest on.

## The five audit-critical code sites — all CONFIRMED in DEPLOYED bodies

| # | Function | Claimed site | Verdict in deployed source |
|---|----------|--------------|---------------------------|
| 1 | **de-answer** | `resolve_de_autonomy` call + `confidenceFloor` logic | **CONFIRMED.** RPC call with `p_action_type:'answer_dock'` (line 647); `dial.enabled===false → floor 101`, `min_confidence → floor` (652–653); floor enforced at cache-hit (743) and answer path (1181). Function IN-SYNC. |
| 2 | **de-work** | `de_decision_trace` inserts + consult gating on `de_consultation_grants` | **CONFIRMED.** Trace inserts at plan (159), review (235), per tool-turn (812), plan-error (913); consult tool gated on `de_consultation_grants` reads (658, 690). Function IN-SYNC. Bonus corroboration: the deployed per-turn insert writes `rationale: null` — the audit's Q5 finding ("why" NULL on all 780 rows, writer never records it) is now confirmed at the deployed level, not just repo. |
| 3 | **connector-hub** | `decide_action_execution` call | **CONFIRMED.** `admin.rpc('decide_action_execution', …)` at 5226, with destructive-always-gates checked first (5141) and guardrails→destructive→trust ordering documented and implemented (5214). `index.ts` IN-SYNC (drift is only `_shared/urlSafety.ts` — see below — unrelated to gating). |
| 4 | **playbook-execute** | `trust_level` read | **CONFIRMED.** `.select('trust_level')` with `'supervised'` default (1973–1974); also `resolve_de_autonomy` for auto-send (2778). `index.ts` IN-SYNC (same `urlSafety.ts`-only drift). |
| 5 | **widget-ask** | autonomy resolve | **CONFIRMED.** `resolve_de_autonomy` with `p_action_type:'answer_widget'` (342), identical dial-off/min-confidence floor logic (347–348), enforced at 495/994. Function IN-SYNC. |

**Bottom line for docs/31:** every runtime claim the audit verified against repo source holds for the deployed functions.

## The 6 drifted functions (all repo-ahead; production is stale)

### A. Five functions running the pre-SSRF-fix `_shared/urlSafety.ts`

Commit `e0ae485` (2026-07-26 13:51 UTC, "…plus 2 SSRF holes") hardened `urlSafety.ts`: it decodes v4-mapped IPv6 hex forms (`http://[::ffff:a9fe:a9fe]/` = 169.254.169.254 — the cloud metadata endpoint — previously **ALLOWED**), refuses undecodable mapped shapes, and handles bare-integer/octal IPv4. Only the functions redeployed after 13:51 UTC got it. These five were last deployed 10:19–10:29 UTC that day and still bundle the pre-fix version (verified byte-identical to `e0ae485~1`):

| Function | Deployed (UTC) | What differs |
|---|---|---|
| connector-hub | 07-26 10:29 | `_shared/urlSafety.ts` only |
| playbook-execute | 07-26 10:24 | `_shared/urlSafety.ts` only |
| connector-zendesk | 07-26 10:20 | `_shared/urlSafety.ts` only |
| otel-export | 07-26 10:24 | `_shared/urlSafety.ts` only |
| tool-learn | 07-26 10:25 | `_shared/urlSafety.ts` only |

**Classification: built-but-dark security fix** — the repo believes these SSRF holes are closed; in production they are closed only for de-answer, site-import, demo-ingest, extract-document, knowledge-ingest-drain, mcp-client, scim, tenant-export and verify-domain (redeployed after the fix). connector-hub and tool-learn fetch external/tenant-influenced URLs, so this is the meaningful subset.

**Fix:** redeploy the five functions (`node scripts/deploy.mjs --no-migrations --fn <slug>` per deployment memory). Not done in this pass — deploys were out of scope.

### B. site-import missing two 07-27 fixes

Deployed body is byte-identical to `e0ae485`'s tree (deployed 07-26 13:53 UTC). The repo has since added `01be4f8` ("a job it could not READ was reported as a tenant MISMATCH") and `7cced27` ("one missing GRANT told three different wrong stories") — 71 insertions / 21 deletions in `site-import/index.ts`. Functional error-reporting fixes, not security. Note: the migrations session may be mid-stream on this — coordinate before redeploying.

## verify_jwt — no mismatches

- 49 functions `verify_jwt=false`, 11 `true`. There is deliberately **no** `config.toml` (deploy.mjs:103–115 explains: deploy preserves the existing setting; a config.toml would silently flip unmentioned functions to `true` and break the anonymous widget and webhooks).
- Expectations all hold: **de-answer=false, de-work=false** (per deployment memory), **widget-ask=false** (anonymous widget), **scim=false** (the one explicit `--no-verify-jwt` in deploy.mjs), email-inbound/oauth-callback=false.
- The 11 `true`: conflict-probe-drain, de-fitness-measure, de-training-capture, extract-document, knowledge-gap-detect, knowledge-ingest-drain, oauth-start, reembed-drain, site-import, tenant-export, verify-domain — all cron/drain/user-authed paths; nothing anonymous-facing is behind the gate.
- Cosmetic: deploy.mjs's comment says "48 of the 61" have false; live is 49 of 60. Stale comment only.

## Full per-function verdict (60)

**IN-SYNC (54):** a2a, agentic-step-execute, ai-session, check-ip-allowlist, compute, conflict-probe-drain, de-answer, de-eval-online, de-fitness-measure, de-improve, de-memory, de-mission, de-orchestrate, de-perceive, de-simulate, de-training-capture, de-work, demo-authcheck, demo-ingest, demo-provision, email-inbound, embed-backfill, emit-event, entity-amend, entity-draft, eval-batch, eval-judge, eval-run, extract-document, ingest-chunks, invite-team-member, knowledge-gap-detect, knowledge-ingest-drain, learned-behavior-detect, mcp-client, oauth-callback, oauth-start, onboarding-assist, onboarding-verify, playbook-amend, playbook-draft, playbook-execute*, playbook-mine, proof-stats, provision-workforce-assistants, reembed-drain, scim, send-email-reply, send-outbound, specialist-consult, tenant-export, tool-learn*, verify-domain, voice-relay, widget-ask, workforce-chat — *(playbook-execute and tool-learn appear in the DRIFTED table; listed here in error-check: they are DRIFTED. Corrected count below.)*

**Corrected split — DRIFTED (6):** connector-hub, playbook-execute, connector-zendesk, otel-export, tool-learn (all: stale `_shared/urlSafety.ts` = `e0ae485~1`), site-import (stale `index.ts` = `e0ae485`). **IN-SYNC (54):** all others listed above excluding playbook-execute and tool-learn, i.e. every function not in the DRIFTED six.

**UNVERIFIABLE (0).**

## Recommended actions (for the parent session — nothing executed here)

1. Redeploy connector-hub, playbook-execute, connector-zendesk, otel-export, tool-learn to ship the e0ae485 SSRF hardening to production (highest priority — security fix believed-live in repo but dark in prod).
2. Redeploy site-import after coordinating with the migrations session (its 07-27 fixes reference a GRANT — confirm the migration side landed).
3. Optionally refresh the "48 of 61" comment in scripts/deploy.mjs.
4. docs/31 can strike its deploy-parity caveat: the audit's runtime claims are now verified against deployed source, with the six stale deploys above as the only (non-audit-affecting) deltas.

**Evidence retained in scratchpad:** `parity/functions_list.json` (API snapshot), `parity/fns/<slug>/` (all 60 deployed sources), `parity/urlSafety-pre.ts`, `parity/site-import-e0ae485.ts` (provenance pins).