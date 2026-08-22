# 51 — Measurement Organs Audit (Gap 5, read-only)

**Date:** 2026-08-12 · **Method:** every claim below was verified against the LIVE
database (read-only queries via `scripts/db-query.mjs`) and the LIVE function
catalog (`pg_get_functiondef`), not against migration files alone. Nothing was
written to the database; the only repo write is this document.
**Prior art:** docs/37 (organs lie), docs/38 (severed nerves), migs 491/500/571/
682/692 (honesty repairs). This audit asks: **what is true TODAY?**

> ⚠ **The ranked fixes below are HISTORY. Live state lives in
> `review/deferred-register.json`**, where `certify` › `deferred-register`
> re-derives it every run. Ranked fixes 1–5 landed within hours (migs 706–709,
> 720); 6, 7 and 8 did not, and nothing distinguished them except where the
> session ended — they are now register items `C-1`, `C-2`, `C-3`, `C-4`, `C-5`
> and `C-6`. §7's voice-turn line below was already stale when this document was
> written, which is the second reason the register exists. Add items with
> `npm run defer`.

The two failure classes hunted, per the brief:
1. **A metric that measures the TEST** — exam traffic counted as production.
2. **A stored marker read as truth** — a row that says "done"/"100%" with nothing behind it.

Counting discipline: every "clean" verdict below states its denominator. Zero
findings from zero comparisons is not a clean result.

---

## 1. Verdict tally

**28 numbered organs censused** (§2), plus 4 adjacent checks (list_de_health,
account health, learning digest, the dead `success_rate` marker) — **32 verdicts**:

| Verdict | Count | Organs |
|---|---|---|
| **HONEST** | 23 | eval-run/certifications · eval-judge · amendment fitness · sim/capability · get_de_performance_metrics · reply-mode gate (main path, one noted hole) · get_de_action_metrics · get_de_work_metrics · get_de_contract_metrics · KPI status+snapshot · approve-clean benchmark · weekly value digest · review-cost model · outcome metering + benchmark report (one inherited hole) · proof-stats · trust_evidence_for/ladder · get_workforce_trust_metrics · workforce heartbeat · ops-alert reader (channel saturated) · unit tripwires (687/688/694) · list_de_health · account health (510) · success_rate marker (dead, 0 rows — 491 holds) |
| **LIES** | 6 | de-eval-online sampling chain · assess_de_skills_internal · get_de_performance_summary (roi_hours_saved) · get_workforce_economics · get_playbook_economics · learning-digest volume block |
| **MEASURES-THE-EXAM** | 2 | eval_gate → knowledge-publish trigger (by scope) · get_de_economics benefit side (latent — fires the day a real tenant sets baselines) |
| **UNREAD** | 1 | get_dispatch_health (366) — zero callers in `src/` and `supabase/functions/` |

**Structural finding that frames everything:** the evidence spine
(`evidence_runs`) is still written ONLY by the four answer paths — `de-answer`,
`widget-ask`, `specialist-consult`, `voice-webhook` (grep of
`supabase/functions/` for `evidence_runs` inserts). docs/37 Move 1 (work engine
writes the spine) remains unbuilt, so every spine-reading organ measures chat
and nothing else. The work engine's own organs (499/500/502) exist but are a
parallel substrate.

---

## 2. Census — every organ, five answers

Columns: **Claims** (what it says it measures) · **Reads** (actual tables/filters)
· **Reader** (does a consumer exist) · **Authority** (wired to a decision?) ·
**Verdict + proof**.

### A. Exam / certification family

| # | Organ | Claims | Actually reads | Reader | Authority | Verdict |
|---|---|---|---|---|---|---|
| 1 | `eval-run` + `eval_runs` + `certify_de_from_eval` → `role_certifications` | Certification exam of a DE's answering, on the live pipeline | `golden_qa` (active), live de-answer with `channel='exam'` (eval-run/index.ts:288) | Proving Ground UI (`evalApi.ts`), `eval_gate`, `trust_evidence_for` source 1, `de_records_gate` (a) | Cert failure/staleness gates reply-mode via records gate | **HONEST** — it admits to being an exam and is filed as one. Coverage is the problem: **29 of 29 certifications ever are `support_agent`** (26 passed, 3 failed; live query). hq has active golden rows for `cs_manager` (4) and `renewal_manager` (4) — no exam has ever run for them. |
| 2 | `eval_gate` view (480) + `gate_knowledge_publish` trigger (253) | Latest quality verdict gates human knowledge publishes | `eval_runs` latest `status in ('passed','failed')` per **tenant** | BEFORE INSERT trigger on `knowledge_docs` | **YES — blocks publishes tenant-wide** | **MEASURES-THE-EXAM by scope.** A support-chat exam gates every archetype's knowledge, tenant-wide (docs/37 D6, still undecided). Live: `outsourcetel` gate = failed since **07-04** (0 passed / 2 failed), `acme-telecom` failed since 07-11, hq passed 08-05. The second real workspace has had human publishes gated for 5+ weeks on a 2-question failed run. |
| 3 | `eval-judge` | LLM judge of one Q/A pair | The pair it is handed; writes `eval_judgments` | eval-batch, de-eval-online, de-improve | Indirect | **HONEST instrument** — garbage-in applies (see #4). |
| 4 | `de-eval-online` + `sample_messages_for_online_eval` (168) + `de_eval_quality` (167) | "Samples recently-delivered **real** answers … scores … flags drift" (its own header) | `de_messages delivery='sent'` — **NO channel filter**, so exam answers (which the live pipeline marks sent) are sampled as production | drift → `activity_events quality_drift` (Insights); `de_eval_quality`; `get_benchmark_report.judged_quality` (Performance page) counts `source='online'` | Drift alerts; "judged live quality" number on Performance | **LIES.** Live 30d: of **139** `source='online'` judgments, **38 (27%) are exam-channel answers**, **80 (58%) have no message link** (so the message-id dedupe cannot fire for them), **21 (15%) provably production** (18 dock, 3 hosted). The one organ claiming continuous production QA graded more exams than production. `de_eval_quality`'s headline additionally blends golden+online+simulation. Note: mig 682 excluded `golden`/`simulation` from judged_quality — this contamination enters **labeled 'online'**, under the fix's radar. |
| 5 | `de-fitness-measure` + `amendment_metrics` + `fitness_run_progress` (310/312/313/690/695) | Before/after fitness of an applied persona amendment, on a frozen golden set (twenty questions) | Frozen `golden_qa` ids, de-simulate measure mode, both personas back-to-back | digest delta (309/389) → SelfLearningPage's fitness chip. **Corrected 2026-08-22:** this row named `amendmentMetricsApi.ts` as the path. It never was — that module had **zero importers** and was deleted. The chip reads `digest.amendments.fitness_avg_delta` from the workforce-learning-digest RPC (migration 309, pinned by 389), i.e. the number is computed in the database and the client only renders it. The 134-line client module was scaffolding for a design that was implemented server-side instead and never removed | Informs adopt/rollback review | **HONEST** — an exam **by declared design** (A/B on the same test), fail-closed NULL/NULL. Population: **1 measured row ever** (08-10); `amendment_fitness.enabled='true'`; cron `de-fitness-measure-driver` live (*/30). Denominator honesty: one measurement is a data point, not a track record. |
| 6 | `de-simulate` / `sim_runs` | Certification-grade capability simulation | Sim fixtures; candidate runs excluded from reporting (682 5e) | benchmark report `capability` block | Cert path | **HONEST**, labeled. |

### B. Production performance family

| # | Organ | Claims | Actually reads | Reader | Authority | Verdict |
|---|---|---|---|---|---|---|
| 7 | `get_de_performance_metrics` (current = 571) | Per-DE decisions/resolution/escalation/error/frustration | `evidence_run_decisions`+`evidence_runs`, **`conv.channel is distinct from 'exam'`** on decisions AND runs; rates NULL-not-0 (491) | Performance page (`api.ts:930`), KPI status, reply-mode gate, quarterly review | Feeds the demotion gate | **HONEST** (verified live: body carries the exam filter; `filters_exam_channel=true`). |
| 8 | `run_reply_mode_gate_internal` + `de_records_gate` (307/316) | Demote auto→draft when the record no longer supports it | Certs, incidents, exam-filtered perf metrics (571), **plus branch (d): raw `evidence_runs` 56d failure rate with NO origin/exam filter** | Cron `de-reply-mode-gate-15min` | **YES — flips `external_reply_mode`**; 11 `trust_demotion_notice` tasks, latest 08-11 | **HONEST on the main path**, one partial hole: branch (d) counts `evidence_runs.status='failed'` without `evidence_is_production(origin)` — an exam run that fails on harness errors counts toward `degraded_metrics`. (Origin column exists since 682; unused here.) |
| 9 | `get_de_action_metrics` (147/148) | What a DE actually DID (actions, autonomy) | `action_executions` with non-overlapping buckets; previews excluded (verified live: splits `executed_after_approval`, excludes `previewed`) | LivePerformancePage + Insights | Insight signals only | **HONEST** — the double-row gotcha is designed around. |
| 10 | `get_de_work_metrics` (500) | Work-engine throughput/escalations | `de_work_items`/`de_objectives`/`de_objective_wakes`; work-engine escalations only (`related_table in (…)`) | EmployeeFilePage (`api.ts:924`) | Display | **HONEST** (the 499 blended-population defect was fixed in 500). |
| 11 | `get_de_contract_metrics` (502) | What good work means per archetype | Continuity cases/agreements; `measurable=false` + reason when denominator is 0 | EmployeeFilePage | Display | **HONEST** — the model organ for "not measured ≠ 0". Only `renewal_manager` has a contract. |
| 12 | KPI organ: `de_kpis` + `kpi_metric_catalog` + `get_de_kpi_status` (263/308) + `snapshot_de_kpi_readings` (308/501) | Role-aware KPIs | Live-computes from exam-filtered perf (13w) + CSAT + action arm; manual fallback restricted to `source='manual'`; snapshot refuses fabricated zeros (501), cron daily | EmployeeFileSections:1824, LiveOutcomesPage:169 | Display; watcher thresholds | **HONEST but thin**: 6 KPI definitions and 10 readings platform-wide, all five distinct metrics = the support answer-path set. The "work-sourced KPI catalog" ambition of docs/37 Move 2 exists as 9 catalog rows, essentially unused. |
| 13 | `assess_de_skills_internal` (127/430) → `de_skills` | Skill proficiencies from "real decisions" | `evidence_run_decisions` + `evidence_runs` + CSAT + actions, 30d — **NO exam-channel filter, NO origin filter** | Employee File skills (`list_de_skills`); **mig 680 turns skill gaps into development-program items** | **YES — drives the development program** | **LIES — the strongest live instance of the 571 defect.** Proof (live): Technical Support (hq) skill row reads *"Escalated 97.5% of 81 decisions (last 30 days) → Case Resolution level 1"*; of those 81 decisions, **75 are exam-linked** (same query shape as 571's). The exam-filtered perf metric for the same DE sees a handful of real decisions; the skills organ still sees the exam. 8 of 595 skill rows carry a proficiency — most of those 8 are exam-manufactured. |
| 14 | `get_de_performance_summary` (492) | Per-DE panel incl. "ROI hours saved" | `action_executions` raw count → `roi_hours_saved = count × 0.5h` (492 body, line 75); count includes gated/blocked/preview rows and approval double-rows | WorkforceChatHubPage:93 → PerformanceDashboard.tsx:84 renders `{roi_hours_saved}h` | Display | **LIES.** 492 honestly nulled the fake CSAT and rates — and kept a **fabricated constant**: every `action_executions` row (including `human_gated_*` rows that never executed, and the second row of every approved action) is booked as 30 minutes of saved human time. |

### C. Value / economics family

| # | Organ | Claims | Actually reads | Reader | Authority | Verdict |
|---|---|---|---|---|---|---|
| 15 | `get_de_economics` (131, patched 391/402 for scope only) | Hours saved / FTE / ROI from tenant-typed baselines ("nothing here ever estimates a human's time") | Benefit side: `evidence_run_decisions`, `de_conversations`, — **NO exam filter** (verified live: `filters_exam_channel=false`); cost side: `de_token_usage` unfiltered (pinned) | LiveOutcomesPage:159 ("Hours saved" tile), OutcomeStatement, EmployeeFileSections:2050 | Founder-facing ROI | **MEASURES-THE-EXAM (latent + partial-live).** hq last 30d: **158 of 160 conversations and 75 of 91 decisions are exam traffic** — all counted as `conversations_answered`/`inquiries_handled`, which the pages already display. `hours_saved` itself is NULL today only because **no real tenant has baselines** (`workforce_baselines` = 1 row, tenant `sonic` — a demo). The day a real tenant types minutes in, the headline number is ~90% exam. The production-evidence ratchet pins this function **for its cost side only** ("exam spend makes economics look worse") — the benefit-side reads are outside the ratchet's table sieve entirely. |
| 16 | `get_workforce_economics` (193) | Whole-workforce P&L "from REAL data … the tenant's own FTE baseline" | `playbook_runs` completed × **`coalesce(action_minutes, 15)`** — a platform-invented 15-minute default | WorkforceEconomicsPanel (DEActivityPage:285) | Founder-facing | **LIES.** Violates the platform's own §12.3 doctrine (mig 131: "configured by the Organisation, not invented by the platform"; unconfigured ⇒ NULL). `human_minutes_saved` is fabricated for every unconfigured tenant, i.e. every real one. |
| 17 | `get_playbook_economics` (191) | Per-playbook P&L, "no baseline configured → minutes only, honestly null dollars" | Same `coalesce(v_bl.action_minutes, 15)` | LivePlaybookBuilder:1553 "~N min of human work covered" | Display | **LIES** — same invented default; the header calls the dollars honest while the minutes on screen are invented. |
| 18 | Approve-clean benchmark (`scripts/benchmark.mjs` + `benchmark_samples` 637) | Of drafts produced, fraction approved untouched | `human_tasks` draft-shaped types, enterprise+active tenants only, `decision_edit is null`; refuses to publish under n=20 | Operator script only (`--history`); no UI | Informs the founder | **HONEST — and honestly starved.** Live: **1 sample in the curve** (08-08); denominator today = **1 draft-shaped decision in 90 days** across real tenants ⇒ rate correctly reported UNMEASURABLE. The organ works; the sample does not exist. |
| 19 | `compose_weekly_value_digest` (689/702) | Weekly counts-only receipts per tenant, exams excluded, modeled review-minutes labeled | Work items, deliverables, non-exam conversations, human_tasks, payments, overdue face-value; `get_review_cost_internal` block | `ops_alerts` → OpsAlertsBanner (platform-gated) | Founder's weekly value read | **HONEST — but practically buried** (see #26): 14 W33 editions sit inside **100 open ops_alerts**; the banner renders 6 rows + "and 94 more". |
| 20 | `get_review_cost_internal` (691/698) | Modeled human-review minutes (the true COGS) | Standard minutes × exam-filtered decided tasks; outputs via `action_execution_landed()`; `basis='modeled_standard_minutes'` on every payload | Weekly digest | Founder-facing | **HONEST** — a model that says it is a model, everywhere. |
| 21 | `get_outcome_metering` + `get_benchmark_report` (682) | Billable outcomes; the four benchmark numbers with written definitions | `billable_outcomes`/`de_token_usage` through `evidence_is_production`; CSAT exam-filtered; golden/simulation judgments excluded | LivePerformancePage (`api.ts:997/1014`) | Billing surface; founder read | **HONEST**, with ONE inherited hole: `judged_quality` counts `source='online'` judgments, 27% of which are mislabeled exams (#4). The fix at the reader was right; the leak is upstream at the sampler. |
| 22 | `proof-stats` + ProofPage (/proof) | Public live counts, "demo environments and certification-exam traffic are excluded" | Counts scoped to hq with `channel<>'exam'`, `origin<>'exercise'` filters (index.ts:53-63) | ProofPage.tsx:47, routed App.tsx:258 | Public marketing claim | **HONEST** — the filters make the scope sentence true (682). Caveat carried forward from 682: `de_token_usage` shows **0 `exercise` rows ever** (2,172 all 'production') because no exam has run since 682 landed — the token-stamp path is **built, not yet proven live**. |

### D. Trust / authority family

| # | Organ | Claims | Actually reads | Reader | Authority | Verdict |
|---|---|---|---|---|---|---|
| 23 | `trust_evidence_for` (current = 692) + `compute_trust_evidence` + promotion/demotion machinery (025/458/461/584/585/586/682/692) | Evidence-based autonomy: eval pass rate, human approvals, guardrail blocks | eval_runs per-item (harness failures excluded, 585); human_tasks with `evidence_is_production(origin)`; guardrail blocks with origin filter; ceiling = founder's `max_level` (692) | TrustPage (`trustApi.ts:315`), compile-trust-plan | **YES — the autonomy ladder itself.** Fired for real: 11 demotion notices (latest 08-11), 2 promotions | **HONEST today.** The eval source counts exams deliberately — that criterion IS the exam, and says so. 65 active policies (57 per-DE). This organ is where the 682/692 honesty work landed hardest and it shows. |
| 24 | `get_workforce_trust_metrics` (621/622) | Workforce trust rollup | `action_executions` + `human_tasks` with **minimum-sample gates** (rates null below floor, flags say why) | trustApi.ts:430 → governance page | Display | **HONEST.** Minor future-proofing gap: its `human_tasks` read lacks the origin predicate — immaterial today (exactly **1** `origin='exercise'` task exists; all 31 decided-in-30d are production). |

### E. Ops / health family

| # | Organ | Claims | Actually reads | Reader | Authority | Verdict |
|---|---|---|---|---|---|---|
| 25 | `check_workforce_heartbeat` (522/525/526/527) | Is the workforce actually moving | Throughput + live rolled-back claim probe; raises AND clears its alerts | cron */15 ✓; `ops_alerts` → banner | Ops alarm | **HONEST** mechanism (self-testing by design). |
| 26 | `ops_alerts` channel + OpsAlertsBanner | Alerts reach a human | `list_ops_alerts` (platform-admin), DashboardPage:318 | — | The founder's only ops/digest channel | **HONEST reader, saturated channel.** Live: **100 open alerts** — 59 `de_objective_wake_spin`, 23 `edge_function_error`, 14 weekly digests, 4 other. Mig 527 got 35→2; the hygiene has regressed 50× and the weekly value digest now competes with two months of wake-spin noise for 6 banner rows. |
| 27 | `get_dispatch_health` (366) | Cron/pg_net outcome health | `cron.job_run_details` + `net._http_response` | **NONE** — zero callers in `src/` and `supabase/functions/` (repo-wide grep; only baseline/allowlist mentions) | None | **UNREAD.** The exact "written, never read" pattern docs/ops-visibility named — built the same day as the lesson. |
| 28 | Unit tripwires (687/688) + quarterly rest tripwire (694) | A unit performs or rests; nothing zombies | Fed/pulse via `action_execution_landed()` + exam-filtered conversations; rest-notice tasks carry `de_id NULL` so governance noise never becomes approval evidence | cron daily/weekly ✓; founder tasks | **YES — auto-RESTs units** | **HONEST** — and ratcheted (certify landed-predicate probe). Live states: 50 dormant / 18 fed / 2 resting / 13 exempt. |

Also verified, smaller: `list_de_health` (204) composes exam-filtered organs — inherits honesty (reader: LiveOutcomesPage:160). `compute_account_health_core` (510) stopped inventing scores; reader exists via `compute_tenant_health` → successApi → CustomerSuccessLive. `get_workforce_learning_digest` (311): quality trend excludes `simulation` only — inherits #4's online contamination — and its `volume.conversations` counts `de_conversations` with **no channel filter** (hq: 158/160 exam) → the SelfLearningPage "conversations" volume is exam-inflated: **LIES on the volume block**. `digital_employees.success_rate`: **0 non-null rows** (491 holds — the stored-marker lie stays dead). `de_learning_policies`: 17 enabled (696's feed landed).

---

## 3. The three worst offenders (with the one proof each)

1. **Online eval samples the exam it exists to be the alternative to.**
   `select channel, count(*) from eval_judgments j left join de_messages m on m.id=j.message_id left join de_conversations c on c.id=m.conversation_id where j.source='online' group by 1`
   → `exam: 38, (no-link): 80, dock: 18, hosted: 3` — of 139 "online production quality" judgments (all within 30d), 27% are exams and 58% can't be tied to any message (so they also defeat the sampler's dedupe). Feeds drift alerts and the Performance page's `judged_quality`.

2. **The skills organ re-created the exact defect mig 571 fixed, one table over.**
   Technical Support (hq): `de_skills` says *"Escalated 97.5% of 81 decisions → Case Resolution level 1"*; live join shows **75 of those 81 decisions are exam-linked**. `assess_de_skills_internal` (430) reads the same `evidence_run_decisions` as the performance metric but without 571's channel filter — and skill gaps feed the development program (mig 680), so exams are manufacturing development work.

3. **Three fabricated time-saved numbers, all founder-visible.**
   `get_workforce_economics`/`get_playbook_economics`: `coalesce(action_minutes, 15)` — a platform-invented 15-minute default the §12.3 doctrine explicitly forbids; `get_de_performance_summary`: `roi_hours_saved = action_executions count × 0.5h`, counting gated-never-executed rows and approval double-rows as saved half-hours. Rendered at WorkforceEconomicsPanel, LivePlaybookBuilder:1553, PerformanceDashboard.tsx:84.

---

## 4. Organs wired to real authority — are their inputs sound?

| Authority | Organ chain | Input soundness |
|---|---|---|
| Auto→draft demotion (reply mode) | cron → `run_reply_mode_gate_internal` → `de_records_gate` + `get_de_performance_metrics(8w)` | **Sound** on the metrics path (exam-excluded, 10-decision floor). One partial hole: records-gate branch (d) failure-rate reads raw `evidence_runs` without the origin predicate. |
| Autonomy ladder (promote/demote levels) | `trust_evidence_for` → `apply_trust_promotion` / demotion triggers | **Sound** (origin-filtered human+guardrail evidence, per-item eval counting, founder cap honored since 692). Bad data cannot silently move it today. |
| Knowledge publish block | `eval_gate` → `gate_knowledge_publish` trigger | **Mechanically sound, scope unsettled**: one support-shaped exam verdict gates all human publishes tenant-wide. `outsourcetel` has been publish-gated since 07-04 off a 2-question failed run. This is founder decision D6 (docs/37), still open. |
| Unit auto-REST | tripwire sweeps (688/694) | **Sound** — landed-predicate + exam-filtered, certify-ratcheted. |
| Development program intake | skill gaps (680) ← `de_skills` | **POISONED** — see offender #2. |
| Drift alerts / Insights | `de-eval-online` → `activity_events` | **Contaminated** — see offender #1. |

---

## 5. Ranked fix list (fix nothing here — this is the order)

1. **Filter the online-eval sampler and repair its dedupe** (`sample_messages_for_online_eval`: exclude `c.channel='exam'`; make eval-judge persist `message_id` atomically so the 58% unlinked class can't recur; make `de_eval_quality`'s headline production-only). *Why first: it is the platform's only continuous production-quality organ, it currently grades more exams than production, and it feeds both drift alerts and the founder-visible `judged_quality` number. Small diff, big claim restored.*
2. **Port mig 571's exam filter into `assess_de_skills_internal`** (and use `evidence_runs.origin` for the run-shaped signals). *Why second: proven live poisoning (75/81), and it drives the development program — exams are currently manufacturing remedial work items about exam behavior.*
3. **Delete the three fabricated time-saved constants** — the `coalesce(…,15)` in `get_workforce_economics` and `get_playbook_economics` (return NULL + `unconfigured`, as mig 131 already does), and `roi_hours_saved` in `get_de_performance_summary` (remove or derive from landed actions × configured baseline). *Why third: these are the numbers a buyer/founder quotes; the platform's own constitution already forbids them; each fix is a one-line honesty change plus UI empty-state.*
4. **Exam-filter `get_de_economics`' benefit side and widen the production-evidence ratchet's sieve** (add `evidence_run_decisions`/`de_conversations` count-reads to `scripts/production-evidence.mjs`, or extend the pin's reason to cover only the cost side — today the pin's sentence is true and incomplete). *Why: latent 90%-exam ROI headline armed to fire the day a real tenant types baselines in; the ratchet blind spot is how organs #13/#15/#16 slipped past 682.*
5. **Exam-filter the learning digest's volume block** (`get_workforce_learning_digest`: `channel <> 'exam'` on conversations; label the escalation count, which is actually all human_tasks). *SelfLearningPage currently reports 158 exam threads as workforce conversations.*
6. **Alert-channel hygiene** — extend `resolve_cleared_ops_alerts` rules (or per-kind pruning) to the 59 stale `wake_spin` and 23 `edge_function_error` rows so the weekly digest isn't buried; then either wire `get_dispatch_health` into a surface or delete it (an unread organ is not an organ).
7. **Add the origin predicate to `de_records_gate` branch (d)** and (cheap, future-proofing) to `get_workforce_trust_metrics`' human_tasks read.
8. **Decide D6 and run the first non-support exams** — activate the cs_manager/renewal_manager golden sets (4 active each, 0 exams ever), and scope `eval_gate` per archetype or per DE so one support exam stops gating a whole tenant's knowledge (outsourcetel publish-gated since 07-04). *Last not because it matters least, but because it is a founder decision plus exam runs, not a code fix.*

---

## 6. Denominators (the "0 problems" ledger)

- Online judgments 30d: **139** total → 38 exam / 80 unlinked / 21 production.
- hq 30d evidence: conversations **160** (158 exam) · decisions **91** (75 exam).
- Technical Support skill sample: **81** decisions, 75 exam-linked.
- Certifications ever: **29** (26 passed / 3 failed) — 29/29 `support_agent`.
- eval_gate rows: **3** tenants — hq passed 08-05 · acme failed 07-11 · outsourcetel failed 07-04.
- Approve-clean: **1** draft-shaped decision in 90d (needs 20) · **1** sample in `benchmark_samples`.
- KPIs: 6 definitions · 9 catalog rows · 10 readings (5 metric keys, all answer-path).
- Amendment fitness: **1** measured amendment ever · `enabled=true` · 0 in-flight.
- Trust: 65 active policies (57 per-DE) · 11 demotions fired · 2 promotions.
- ops_alerts open: **100** (59 wake_spin · 23 edge_function_error · 14 digests · 4 other).
- Origin stamps: `de_token_usage` 2,172 rows, **0** `exercise` (no exam since 682 — stamp unproven live) · `human_tasks` 1 exercise row · `evidence_runs` 75 exercise / 209 production · `billable_outcomes` 239 exercise / 142 production.
- `success_rate` fabrications remaining: **0** of all DEs (491 holds).
- `action_executions`: **186** before and after this audit (read-only confirmed).
- Unit tripwires: 50 dormant / 18 fed / 2 resting / 13 exempt.
- Evidence-spine writers: **4**, all answer-path — the work engine writes none.

## 7. What was NOT checked (stated, not papered over)

- Edge-function *internal* metrics (otel spans) — out of scope, no verdict.
- Whether the next certification exam actually stamps `de_token_usage.origin='exercise'` — built (682 writer), will only be proven by the next exam run.
- `get_de_guardrail_activity` (096) origin behavior — its trust-relevant twin inside `trust_evidence_for` is filtered; the display copy was not re-read.
- ~~Voice-turn's exercise flag (682's named follow-up) — still open per 682's own header.~~
  **STALE WHEN WRITTEN — CLOSED, with proof.** This line trusted migration 682's
  header instead of reading the deployed function, and the flag had already
  landed. Evidence, 2026-08-12: `supabase/functions/voice-turn/index.ts:339`
  reads `const isExercise = url.searchParams.get('exercise') === '1'`, and both
  guardrail-block writers stamp it — `origin: isExercise ? 'exercise' :
  'production'` at lines 272 and 446. `git log -S isExercise -- supabase/
  functions/voice-turn/index.ts` names exactly one commit, `67d32cce`
  ("feat(trust): voice tests self-mark …", mig 692). ⚠ **The lesson is the
  reason this correction is written out rather than deleted:** this audit's own
  method line says every claim was verified against the live system, and this
  one was not — it was carried from a migration header, which is precisely the
  "stored marker read as truth" class §1 hunts. Caught by docs/53's census the
  same day.
- The three legitimate certify REDs — deliberately untouched per brief.
- The "ops-visibility score" (42/100) is not a live organ — it was a one-time
  13-agent audit grade (2026-07-26). Its live descendants (ops_alerts channel,
  heartbeat, dispatch health) are censused above as #25–27.
