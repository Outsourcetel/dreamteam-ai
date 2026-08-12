# 53 — Deferred-work census (2026-08-05 → 2026-08-12)

**The question:** *"How many failed/deferred pieces of work were found in the last
7 days and skipped because nobody told me to work on them?"*

**The answer: 47 still-open items.** Of those, **14 were genuinely walked past** —
nobody decided to defer them, they were named in a commit body, a document or a
gate's own output and then nothing happened. The other 33 were held back for a
reason that was written down at the time.

**Read-only census.** Nothing was fixed, applied, granted, decided or executed.
`action_executions` measured **186** before and after (docs/51's standing
invariant). The only repo write is this file. One certify run rewrote
`review/certify-last.json`; it was reverted, and the run is quoted below instead.

---

## 1. Denominators

Zero findings from zero comparisons is not a clean result, so here is what was
compared.

| Source | Examined | Deferral candidates |
|---|---|---|
| Git commits in window | **295 commits**, 9,710 lines of commit body, grepped for 18 markers (`not fixed`, `out of scope`, `deferred`, `NOT DONE`, `follow-up`, `blocked on`, `⚠`, …) | 218 matching lines → 41 distinct deferrals |
| Migrations | **155 ledger rows** with `applied_at` in the window (files 574→720); headers of 666–720 read | 9 |
| `docs/` | **16 documents**: 45, 47, 48, 49, 50, 51, 52 + 3 superpowers plans + 6 specs | 24 |
| `review/` | `certify-last.json`, `debt-map-findings.json` (**86 measured findings**) | 1 bloc + 4 broken out |
| Certify | one live `--fast` run, 2026-08-12 12:04 UTC | 5 live reds/notes |
| Code | `TODO`/`FIXME`/`HACK`/`XXX` added in window (`git log -p` over ts/tsx/mjs/sql) | **1** (added and removed the same day) |
| Memory | `MEMORY.md`, `security_deferred_items.md`, 30 topic files touched in window | 3 in-window |
| Unmerged branch `claude/goofy-swanson-5d16ef` | 6 commits, 2 of them migrations **already applied to production** | 3 |

```
Candidate deferrals identified ....... 84
  already closed since being named ... 37   (verified against live code/DB, not assumed)
  STILL OPEN ......................... 47
```

**How duplicates were removed.** The same defect is routinely named three times —
once in a commit body, once in a migration header, once in a doc. Counting is by
**defect**, keyed on the artefact it lives in (a function name, a file:line, a
table, a ledger row). Three worked examples:

- *"the platform cannot carry out this approval"* appears in mig 704's header, in
  `db6591f2`'s body, in docs/50 as F-1 and F-2, and twice in today's certify
  output. That is **two** defects (one task with no executor, one task naming a
  disabled definition), not six.
- *"dev is a divergent environment"* is debt finding #74, `10bbc641`'s "syncing
  dev is a substantial, separately…", docs/45's "dev is not a mirror", and docs/50
  F-4. **One** defect.
- *"`create_specialist` is still ADVERTISED"* (`e85d9c30`, 08-08) and F-2 are the
  same row seen from two ends; the advertisement half has since been disabled, so
  only the pending-approval half is counted.

**The 86-finding debt map is counted as one line, not 86.** docs/47's three
remediation phases named ~17 of the 86 and all three landed; the remaining ~69
carry no scheduled fix. Four of those 69 are broken out below because they were
carried forward by name (#0, #35, #57, #73). If you expand the bloc, the honest
total is **~115** — the 47 headline understates the backlog and says so here
rather than in a footnote.

### The 37 that were closed since being named

Not backlog. Listed so the number above can be checked, and because several were
still recorded as open in a document I read today.

migs 706/707/708/709 closed docs/51 ranked fixes **1–5** (online-eval sampler,
skills organ, the three invented time constants, `get_de_economics` benefit side,
learning-digest volume) — all five re-verified live in the function bodies ·
mig 720 closed docs/52 §8 step 7 (`promoteDeploymentStage` silently doing nothing)
· mig 692 closed 682's voice-turn exercise flag · mig 701 closed the half mig 677
deferred · mig 665 closed the anon-readable `eval_gate` view · `approval_authority`
went 0 rows → **142** · `action_definition_id` is now carried through de-work's
dispatch, closing `5817a375`'s "NAMED, NOT FIXED" · docs/48's four code items
landed in `61142f33` · the contacts `exec_sponsor` vocabulary bug landed in
`1ac25205` · docs/47 Phase 1 closed six (two gates that could not fail,
golden-path's exit, Node 20, certify-in-CI, two excluded offline test files, the
unwired security gate) · Phase 2 closed four (`media_assets`, the 37%-CPU cron,
ten starved AI budgets, the broken migration runner) · Phase 3 closed three
(`LiveWorkforceDEs.tsx`, the untested action gate, `dispatchTool`) · the README
front door exists · the role-gate checker now reads `pg_policies`, closing the
blind class `ec5b0aa8` named · My Profile, the six-tabs merge, employee deep
links, the per-employee autonomy UI, and the `embedText`/`chunkText`/
`parseJsonLoose` drift all landed.

**The registers themselves are stale, which is itself a finding** (a third case in
§4). docs/51 §7 (written
2026-08-12) lists voice-turn's exercise flag as "still open per 682's own header"
— mig 692 closed it on 08-11. docs/45's R0.8 residue still reads "28 functions
guard with `if auth_tenant_id() is not null and …`"; the live catalogue today
holds **1** such function (`can_access_de`) out of 926 public functions, 210 of
which reference `auth_tenant_id`, and **0** carry the full fail-open shape
(`… is not null and … <> auth_tenant_id()`). Either the class was closed without
a commit that says so, or the 28 was never a live-catalogue count. Reported as
**unresolved**, not as closed, and not counted in the 44.

---

## 2. The register — every still-open item

Severity: **(a)** security/authority · **(b)** correctness/silent-failure ·
**(c)** measurement/reporting · **(d)** hygiene/debt.
Why-skipped: **SCOPE** (out of scope by instruction) · **FOUNDER** (blocked on a
decision) · **TOOLING** (blocked on credentials, privileges or dwell time) ·
**WALKED PAST** (nobody decided anything).

| # | What | Where | Sev | Why skipped | First named | Verified today |
|---|---|---|---|---|---|---|
| A-1 | `storage` schema default ACL grants **`anon` and `authenticated` `arwdDxtm`** on every new table; both roles hold INSERT/UPDATE/DELETE/**TRUNCATE** on `storage.buckets`, `buckets_analytics`, `objects` right now | `pg_default_acl`, schema `storage` | a | **SCOPE** — docs/52 audited `public` only and named this in the same breath: *"unexamined, and a plausible second finding of the same shape"* | docs/52 §9, 08-12 | ✅ live catalogue |
| A-2 | The `public` default-ACL row whose grantor is `supabase_admin` still reads `anon=arwdDxtm \| authenticated=arwdDxtm` — the half of mig 715 that returned 42501 | mig 715 | a | **TOOLING** — `postgres` is not a superuser and not a member of `supabase_admin`. Compensating control: certify's TRUNCATE arm reads live grants | `09c16c6e`, 08-12 | ✅ certify NOTE + `pg_default_acl` |
| A-3 | `net.http_post/get/delete` granted to PUBLIC — an outbound-request primitive. A `REVOKE` as `postgres` is a **silent no-op** | schema `net` | a | **TOOLING** — not fixable by us. Compensating control: certify `net-not-exposed` (REST returns 406) | docs/45, 08-10; re-named docs/52 §9, 08-12 | ⏸ inherited, not re-probed |
| A-4 | `get_de_cost_metrics` shows per-employee spend for every employee in the workspace, not only those the caller is responsible for | `get_de_cost_metrics` | a | **FOUNDER** — narrowing changes what people see; a product call | docs/45, 08-10 | ⏸ not re-read |
| A-5 | **3 profiles carry `tenant_id` NULL, 1 of them `tenant_owner`.** `ON DELETE SET NULL` means every workspace deletion manufactures another. The cheapest mitigation was named — *deactivate that profile* — and never done | `profiles` | a | **WALKED PAST** | mig 663 header / docs/45, 08-10 | ✅ live count |
| A-6 | Resend API key rotation. The installed key is the one pasted into chat; the three steps are all the founder's. Blast radius still nil | `vault.secrets` | a | **FOUNDER** — only a `platform_super_admin` can write it, correctly | memory, 08-06 | ✅ `outbound_drafts` = 0 |
| B-1 | **F-6 — the phone says "Approved and sent." and sends nothing.** The draft-delivery consequence lives in one screen's JS, not in the decide RPC. `/m`'s button reads "Approve and send it"; the DB leaves the draft `draft_pending` | `MobileShell.tsx:102,164` | b | **FOUNDER** — landed in a fix backlog whose rule is *"nothing here gets fixed until the founder says go"* | docs/50, 08-12 (UI-proven) | ✅ no `approve_draft_reply` on either decide path |
| B-2 | F-1 — task `03aaa6dd` ("$15,600 invoice to Meridian Group") has no `action_executions` row on **either** linkage column. Deciding it empties the queue and sends nothing | `human_tasks` | b | **FOUNDER** — needs a withdraw or re-raise; the probe reports, never decides | certify ring-0, 08-11 | ✅ still `pending`; certify red |
| B-3 | F-2 — kinetic's pending approval names `create_specialist`, whose definition is `disabled`; the resolver only sees active ones → `action_definition_not_found` | `action_executions` | b | **FOUNDER** — *"a decision about someone else's pending work"* | `db6591f2`, 08-11 | ✅ certify red |
| B-4 | F-3 — onboarding binding `locations_configured → propose_connector` needs the `workforce_assistant` role; the employee this workspace gives onboarding work to does not have it | `onboarding_templates` | b | **FOUNDER** — grant the role or rebind the step | certify ring-0, 08-12 | ✅ certify red |
| B-5 | F-5 — widget-ask's no-docs branch sends a canned "check back soon" with `escalated:false`, **no human task, no event**. A fresh tenant's customer questions are recorded and nobody is told | `widget-ask/index.ts` ~L631 | b | **FOUNDER** — fix backlog | docs/50, 08-12 | ✅ code read |
| B-6 | F-4 — **dev is 74 migrations behind production.** `golden-path` — certify's only write-path proof — runs against a schema that predates migs 666–709, so the fixes for the F-1/F-2 class have no loop coverage at all | dev project | b | **SCOPE** — *"syncing dev is a substantial, separately scoped follow-up"* | `10bbc641` 08-09; measured docs/50 D, 08-12 | ⏸ dev not re-queried |
| B-7 | F-8 — golden-path's drift footer prints `(production: 881 / 284 / 657)` as a **string literal**. Production is never queried, so the one indicator that would have surfaced F-4 cannot change | `scripts/golden-path.mjs:327` | b | **FOUNDER** — fix backlog | docs/50 D, 08-12 | ✅ line read |
| B-8 | F-7 — certify's unexecutable-approval probe scans `action_executions` linkage only; the draft-reply consequence class is invisible to it, so B-1 could recur silently | `scripts/certify.mjs` | b | **FOUNDER** — fix backlog | docs/50, 08-12 | ⏸ follows from B-1 |
| B-9 | **Debt #0 — the playbook branch executor implements 6 of the 9 step types its own validator accepts.** `update_record`, `check_knowledge`, `read_reference` pass validation and are then dropped with `status:'skipped'`; the run is not failed. A playbook can report COMPLETED having done neither requested action | `playbook-execute/index.ts:219` vs `runBranchStep` | b | **WALKED PAST** — the record calls it *"the one finding that can produce a wrong business outcome"*, and it appears in none of docs/47's three phases | docs/47, 08-09; re-carried docs/50 D, 08-12 | ✅ 9 keys, 6 `case` arms |
| B-10 | **Two migrations are in the production ledger with no source on `main`.** `715_the_definition_says_which_engine_owns_it.sql` (applied 10:44:33) and `717_four_roles_get_a_procedure_and_intake.sql` (10:58:00) exist only on the unmerged branch `claude/goofy-swanson-5d16ef`. `main` holds *different* files at both numbers (10:37:33, 10:57:43) → **two new duplicate numbers created on 08-12**. Live consequence: `main`'s `execute-perimeter` is RED on `playbook_definitions_set_kind()`, a trigger function whose only source is that branch | `schema_migrations`, certify | b | **WALKED PAST** — certify reported both ORPHANED and the run was recorded as such | 08-12 | ✅ ledger + `git merge-base` |
| C-1 | ops_alerts channel saturated — **104 open** (64 `de_objective_wake_spin`, 23 `edge_function_error`), and the banner renders 6 rows. The weekly value digest, the founder's value read, is buried. It was 100 six hours before this census | `ops_alerts` | c | **WALKED PAST** — ranked 6th in docs/51 and never scheduled | docs/51, 08-12 | ✅ live count, and growing |
| C-2 | `get_dispatch_health` (mig 366) has **zero callers** in `src/` and `supabase/functions/` — an organ nobody reads | `get_dispatch_health` | c | **WALKED PAST** — same rank | docs/51, 08-12 | ✅ 0 grep hits |
| C-3 | `de_records_gate` branch (d) counts raw `evidence_runs` failures with **no origin predicate**, so an exam run failing on harness errors counts toward `degraded_metrics` — and that gate flips `external_reply_mode` | `de_records_gate` | c | **WALKED PAST** — ranked 7th | docs/51, 08-12 | ✅ body has no origin filter |
| C-4 | `get_workforce_trust_metrics`' `human_tasks` read lacks the origin predicate (immaterial today: 1 exercise task exists) | same | c | **WALKED PAST** — ranked 7th, "cheap future-proofing" | docs/51, 08-12 | ✅ body read |
| C-5 | Founder decision **D6** — one support-shaped exam gates every archetype's knowledge publishes tenant-wide. `outsourcetel` has been publish-gated since **2026-07-04** off a 2-question failed run; 29/29 certifications ever are `support_agent` | `eval_gate` + `gate_knowledge_publish` | c | **FOUNDER** | docs/51 ranked 8, 08-12 (open since docs/37) | ⏸ inherited |
| C-6 | The evidence spine (`evidence_runs`) is written **only** by the four answer paths. docs/37 Move 1 — the work engine writes the spine — remains unbuilt, so every spine-reading organ measures chat and nothing else | `supabase/functions/` | c | **WALKED PAST** — structural, unscheduled | docs/51 §1, 08-12 | ⏸ inherited |
| C-7 | The edge-typecheck ratchet was not re-pinned after four functions improved (`agentic-step-execute` 1→0, `ai-session` 12→0, `de-improve` 3→0, `de-mission` 6→0). Until it is, a regression back to those baselines passes | `scripts/certify.mjs` | c | **WALKED PAST** | 08-12 | ✅ certify prints the offer |
| D-1 | `react-router` / `react-router-dom`: 2 **moderate** advisories (open redirect via backslash; constructor injection in `deserializeErrors`) | `package.json` | d | deliberate — fix is a v7 major | docs/47, 08-09 | ✅ `npm audit` |
| D-2 | Toolchain advisories (1 high, dev-only) — vite/esbuild, major upgrade | `package.json` | d | deliberate — reports rather than blocks | docs/47, 08-09 | ✅ `npm audit` |
| D-3 | `golden-path` is armed but runs only in full local certify, not CI | `.github/workflows/ci.yml` | d | **TOOLING** — needs production credentials in CI | docs/47, 08-09 | ✅ CI runs `certify:offline` only |
| D-4 | Type-floor backlog — **25 `text-[9px]` across 12 files**, below the design system's floor (only `text-[10px]` and `text-[11px]` are legal bracket sizes) | `src/` | d | **WALKED PAST** — named three times in three commits, never picked up | `7c24a42b` / `b90db57e` / `e29348cd`, 08-07 | ✅ counted |
| D-5 | Design-drift named debt is frozen, not falling: raw hex colours **18** (baseline 18), radius variants **13** (baseline 13) | `scripts/design-drift.mjs` | d | **SCOPE** — *"plenty of raw colour — out of scope here, not fixed, not claimed"* | `dc8ebeb2`, 08-09 | ✅ drift run |
| D-6 | Shared-helper drift reported and left: **`callModel` has 7 non-shared definitions**, `renderTemplate` 2, `stripHtml` 1 | `supabase/functions/` | d | **SCOPE** — "different subsystems" | `d01f952a`, 08-06 | ✅ counted |
| D-7 | Debt #35 — **zero component tests** over ~73,790 lines of UI (18 test files, none renders a component) | `tests/` | d | **WALKED PAST** | docs/47, 08-09; re-carried docs/50 D | ✅ counted |
| D-8 | Debt #73 — the JWT gate for 59 edge functions exists only inside Supabase; nothing in the repo records it | `supabase/functions/` | d | **WALKED PAST** | docs/47, 08-09; re-carried 08-12 | ⏸ not re-verified |
| D-12 | Debt #57 — **68 floating version imports** across the edge functions. (The "no lockfile" half was refuted: `deno.lock` is tracked. The floating-import half stands) | `supabase/functions/` | d | **WALKED PAST** | docs/47, 08-09; re-carried docs/50 D, 08-12 | ⏸ not re-counted |
| D-9 | **W-1** — the email channel has never carried a message. `RESEND_INBOUND_SECRET` unset; the deployed function is dormant-honest (503). The default mid-market support channel | `email-inbound` | d | **FOUNDER** — wiring decision: keys + receiving domain | docs/50, 08-12 | ✅ 0 email conversations ever |
| D-10 | The approved-action driver ships **inert** — cron `approved-action-driver-5min` is `active=false`, `enabled_at` empty | `cron.job` | d | **FOUNDER** — awaiting go | `abaefe24` 08-09, re-asserted `e0fe5d2f` 08-11 | ✅ live |
| D-11 | The onboarding execution path has **never run end to end** — `action_executions` with `dedupe_key like 'onboarding:%'` = **0**. Blocked on two browser steps only a workspace owner can take | `action_executions` | d | **FOUNDER** — publish the draft, re-point the project | spec, 08-11 | ✅ live count |
| E-1 | Front Desk and IT Helpdesk **cannot be activated** — `gate_de_certification()` refuses `lifecycle_status='active'` without a passed `role_certifications` row. *"Deliberately not done"* rather than routed around the governance gate | branch `goofy-swanson` | b | **FOUNDER** — needs an exam run | 08-12 | ⏸ branch-held |
| E-2 | The two new watchers (Business Development ~24h, Marketing ~7d) have produced no work item; intake is wired but unobserved | branch `goofy-swanson` | b | **TOOLING** — dwell time | 08-12 | ⏸ branch-held |
| E-3 | `playbook-execute`'s 409 was never exercised end to end — server-to-server auth needs a credential the session could not hold (the key is returned only as a digest) | branch `goofy-swanson` | b | **TOOLING** — credentials | 08-12 | ⏸ branch-held |
| F-a | **`customer_account_contacts` holds 0 rows for every account.** 8 escalations wait on one question: who is the human being at Grant Plastics and West View | `customer_account_contacts` | d | **FOUNDER** — the one real decision in docs/48 | docs/48, 08-09 | ✅ 0 rows |
| F-b | The $85,000 commercial decision — escalate to formal dunning, or stop chasing. 22 tasks collapse to it; the machinery was fixed (migs 701/703), the decision was not | `human_tasks` | d | **FOUNDER** | docs/48, 08-09 | ⏸ machinery fixed |
| G-1 | **docs/47 debt-map remainder** — of 86 measured findings, the three phases named ~17; **~69 carry no scheduled fix**. Counted here as one line; four are broken out above | `review/debt-map-findings.json` | d | **WALKED PAST** — the plan stopped at Phase 3 and the rest was never triaged | docs/47, 08-09 | ✅ 86 vs plan |
| G-2 | Configurable onboarding step types (document instructions, spreadsheets, PDFs, links) — scoped 08-10, spec'd 08-11, **nothing built**. Storage foundation exists with 0 rows, 0 objects | `onboarding_templates` | d | **FOUNDER** — awaiting go | spec, 08-10 | ⏸ spec only |
| G-3 | 14 tenants still carry the 10-step starter checklist; migrating them is a UI opt-in | `onboarding_templates` | d | deliberate — *"not something to do on their behalf"* | spec, 08-11 | ⏸ inherited |
| G-4 | Voice channel: **0 `voice_messages` ever**. docs/50 lists "park formally" as a candidate; nobody decided | 3 edge functions | d | **FOUNDER** | docs/50, 08-12 | ⏸ inherited |
| G-5 | Support auto-close deliberately unbuilt — an open decision carried at baseline | `de_conversations` | d | **FOUNDER** | docs/49 §5, 08-11 | ⏸ inherited |
| G-6 | Workstream C's owed breadth: the security-deferred checklist walked item-by-item, and an **anon-role probe** (all attack evidence so far is cross-tenant-*authenticated*). The write-perimeter and default-grant halves were overtaken by migs 714–719 | — | a | **SCOPE** — session boundary | docs/50 C, 08-12 | ⏸ inherited |
| G-7 | docs/50's "open B residue": the push **lock-screen last hop** (n=1 device) and a watcher actually **firing** and creating a case | — | c | **TOOLING** — dwell time and a physical device | docs/50, 08-12 | ⏸ inherited |

### Breakdown

| Severity | Count | | Why skipped | Count |
|---|---|---|---|---|
| (a) security / authority | 7 | | **WALKED PAST** | **14** |
| (b) correctness / silent failure | 13 | | FOUNDER decision | 19 |
| (c) measurement / reporting | 8 | | SCOPE (by instruction) | 5 |
| (d) hygiene / debt | 19 | | TOOLING / credentials / dwell | 6 |
| | | | DELIBERATE (accepted trade-off) | 3 |
| **Total** | **47** | | **Total** | **47** |

Verified against live code, the live database or a live certify run today: **29**.
Carried forward on the naming document's own evidence without re-verification:
**18** — each marked ⏸ above rather than left ambiguous.

**DELIBERATE** is separated from the other four on purpose: D-1, D-2 and G-3 have a
stated trade-off (a major-version upgrade; a tenant-owned opt-in). They are open,
but nobody skipped them.

---

## 3. Fix next — ranked

1. **B-10 — merge or revert `claude/goofy-swanson-5d16ef`.** Production holds two
   migrations `main` cannot rebuild, and `main`'s certify is red on a function it
   has never seen. Every hour this sits, both trees drift further and the two new
   duplicate numbers get harder to reason about. Costs one merge, not one fix.
2. **B-1 (F-6) — move the draft-delivery consequence server-side.** A screen that
   says "Approved and sent." while nothing was sent is the single defect here that
   directly misleads a person about money.
3. **B-9 — the playbook branch executor.** Either implement the three missing step
   types or fail the run. Reporting COMPLETED for work not done is a wrong
   business outcome, not slow work.
4. **A-1 — the `storage` schema write perimeter.** `anon` holds TRUNCATE on
   `storage.objects`. Same shape docs/52 spent six migrations closing in `public`,
   one schema over, with a worse grantee. Audit for reachability first — these are
   Supabase-managed tables and the storage API must keep working.
5. **B-6 / B-7 (F-4 + F-8) — bring dev to production's ledger and make the drift
   footer measure.** Until then `golden-path` certifies a schema 74 migrations
   stale, and the indicator that would say so is a string literal.

Then: A-5 (deactivate the tenantless owner — one row, and the class re-arms on
every workspace deletion) · C-3 (the records gate flips reply mode off unfiltered
evidence) · C-1 (104 open alerts are burying the founder's weekly digest) ·
B-2/B-3/B-4 (three one-tap founder decisions that clear three certify reds).

---

## 4. What should never have been deferred

Three, and I am not softening them.

**1. B-10 — schema in production that the repository cannot rebuild.** This is the
exact failure `CLAUDE.md`'s migration section exists to prevent, and it happened on
2026-08-12, the same morning those rules were being cited in commit messages. Two
agents each ran `migrate:next`, each got a clean `O_EXCL` claim, and collided
anyway — because the claim is a file on disk in *one* working tree and the other
agent was on a branch. `certify` caught it, printed `ORPHANED` twice, the run was
committed with that red in it, and nobody merged the branch. The rule that failed
is not "claim the number"; it is that a red nobody owns is a red nobody fixes.

**2. B-1 (F-6) — a screen that lies about a $15,600 send.** It was proven on the
deployed application, on the surface the founder uses daily, and then filed behind
*"nothing here gets fixed until the founder says go."* Registering a defect is not
the same as containing it. A backlog is the right home for a slow query; it is the
wrong home for a UI that affirmatively reports an action it did not take.

**3. B-9 — the playbook branch executor.** Its own record labels it *"the one
finding here that can produce a wrong business outcome rather than just slow work
down."* It was measured on 08-09 with three independent sources of evidence, and
then omitted from all three remediation phases that same day. Nothing decided it
was less important than the seventeen items that were scheduled — it simply did
not make the list.

**Honourable mention, because it is the same reflex:** A-1. The document that spent
seven sections and six migrations closing `authenticated`'s write perimeter in
`public` named the `storage` twin in its own §9 — *"unexamined, and a plausible
second finding of the same shape"* — and stopped. Scope discipline says name it and
leave it, which is exactly what happened, and it is still correct. But "named and
left" only works if something later reads the list. This census is the first thing
that did, four days after doc 45 wrote its list and the same day doc 52 wrote its.

**The pattern under all four.** **Eleven of the fourteen** walked-past items were
named in a *document* rather than a commit body (one came from a commit body, two
from a gate's own output). Documents in this repo are written to be complete, not
to be worked. docs/50's `FIX BACKLOG` is the only register here with priorities and
an owner. docs/51's ranked fixes 1–5 were executed within hours; 6, 7 and 8 were
not, and nothing distinguishes them except where the session ended.

**The registers themselves go stale, which is how items get lost twice.** Three
found today: docs/51 §7 still lists voice-turn's exercise flag as open (closed by
mig 692); docs/45's R0.8 residue still names 28 fail-open guards (1 in the live
catalogue); docs/50's carried-forward r5 list still names #47 (the action gate now
has 18 tests) and #70 (refuted — 6 daily physical backups). A backlog nobody
re-measures is a backlog that stops being evidence.

---

## 5. Provenance

Read-only throughout. No migration, no `GRANT`, no `REVOKE`, no DDL, no decision,
no execution, no approval. `action_executions` = **186** at the start and at the
end. Certify's red rows and every allowlist were left exactly as found; the one
certify run performed was `--fast` (read-only probes) and its artefact was
reverted. `DETrainingPanel.tsx` and `workforceApi.ts` were not opened for edit —
a concurrent session owns them. `src/pages/tenant/EmployeeFileSections.tsx` was
already modified in the working tree when this census began and was left alone.
