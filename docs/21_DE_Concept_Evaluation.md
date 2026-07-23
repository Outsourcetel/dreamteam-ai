# 21 — The Digital Employee: Structural Evaluation & Gap Map

**Date:** 2026-07-23 · **Method:** 4 parallel code-level readers (UI surface, backend machinery, role/archetype system, runtime behavior), every claim file-referenced, synthesized here.
**Question posed:** map every DE tab/feature, evaluate cohesion, judge DE-specific vs generic and real vs decorative, and identify gaps to make the DE *skilled, coachable, adaptable, compliant, and true to its role*.

---

## 0. Headline verdict

**The DE is a real employee, not a chatbot — on its enforcement spine.** Three resolver RPCs (`resolve_de_autonomy`, `resolve_de_escalation`, guardrail resolvers) are read live by the three runtime paths (`de-answer`, `widget-ask`, `de-work`). Every per-DE lever that matters — persona, model, confidence floor, escalation rules, guardrails, scoped knowledge, memory, trust dial, action gates, lifecycle — genuinely changes behavior at runtime. **Compliance is the strongest dimension**, and the 2026 "records become gates" change (mig 258) closed a real feedback loop: a stale/failed cert or open incident automatically clamps autonomy and demotes reply-mode.

**But three structural weaknesses keep it from "brilliant":**
1. A **scorecard cluster** (Skills, KPIs, Health, execution telemetry, development items) that is *recorded-only* — honest and useful to humans, but it does not route or gate work. The DE's skills don't decide what it's assigned; its KPI targets don't change what it does.
2. **Config surfaces that promise more than the runtime delivers** — watchers imply "watch anything" but only watch `customer_accounts`; the hire UI promises mandatory compliance packs but every role ships zero; missions compile a recurring cadence but can't install one.
3. A **hire-time binding bug** that silently mis-scopes role certification exams.

Net: the *muscles and conscience* are real; the *scorecard and some of the "employee spec" are partly aspirational*, and a few honest gaps limit adaptability.

---

## 1. The DE anatomy (what exists)

**UI:** the Employee File at `/workforce/employee?de=` — **12 tabs, ~40 panels**, essentially zero mock/placeholder content (empty states are honest and data-driven). Tabs: Today, Work, How-I-operate, Record, Performance, Workbench (8 sub-sections), Profile, Capabilities, Trust & Autonomy, Development, Governance, +Specialist.

**Machinery (17 subsystems), classified by whether config changes behavior:**

| ENFORCED (changes runtime behavior) | RECORDED-ONLY (display / scorecard) | CATALOG-CRUFT (defined, never takes effect) |
|---|---|---|
| Trust dial (`de_autonomy`) | KPIs (`de_kpis`) | `compliance_pack_keys` (empty on all 12 roles) |
| Guardrails (scoped + action gate) | Skills / proficiency | `knowledge_scaffold` (0 readers) |
| Escalation conditions engine | Health rollup | `persona_preamble` (not read via catalog) |
| Certifications → records gate | Execution log / OTel / decision trace | `eval_category` (superseded by archetype scoping) |
| Memory (`de_memory`) | Development items* | `pass_threshold_pct` (hardcoded 80 instead) |
| Missions / delegation | | `required_connector_categories` |
| Model routing | | |
| Actions / registry / gate | | |
| Confidence floors | | |
| Watchers (Book of Work) | | |
| Lifecycle / versioning / retirement | | |
| Consultation (bounded) | | |

\* development items & KPIs bite *indirectly*: the same underlying metrics feed `detect_de_development_needs` and the reply-mode demotion sweep. The **signals** bite; the **rows** don't.

**Runtime truth:** answering and autonomous work are genuinely config-driven and compliance-gated. The one framing caveat: **the DE never sends outbound autonomously** — every external side-effect is a draft/proposal awaiting human approval. Correct for trust; means the "muscles" are draft-and-gate, not act-and-notify.

---

## 2. DE-specific vs generic

**Genuinely per-DE (the real individuation):** trust dial, guardrail scoping, escalation rules, memory, missions, model, actions availability, watchers, lifecycle, identity/persona, availability, reply-mode. These differ per employee and the difference is enforced.

**Tenant/global data shown *on* the DE page (honestly labeled, but not per-DE):** the entire **Performance tab** (tenant-wide RPCs filtered client-side to one DE), economics baselines, profile-field *definitions*, custom Skill/KPI *metric definitions*, compliance packs, the public-widget "front DE" selection, and the **earned-trust ladder** (workspace-wide, explicitly flagged not-yet-per-DE). These are candidates to make **truly per-DE** for real customization — e.g. a per-DE performance query, a per-DE trust ladder.

---

## 3. Real vs "there for the sake of being there"

- **Biting, real:** trust, guardrails, escalation, records-gate, memory, missions, actions, watchers, lifecycle, model, knowledge scoping. No theater here.
- **Scorecard, not control:** Skills proficiency, KPI target rows, Health rollup, execution telemetry, development-item rows. *Not* theater (they're honest, evidence-based, and drive human decisions + drift sweeps) — but they are the **weakest "employee" claim**: a DE's competence record does not govern its work. This is the biggest "present but inert at the behavior layer" cluster.
- **Catalog cruft (defined on every role, never takes effect):** `compliance_pack_keys`, `knowledge_scaffold`, `persona_preamble`, `eval_category`, `pass_threshold_pct`, `required_connector_categories`. The schema advertises a fuller employee than the system instantiates. **`compliance_pack_keys` is the most damaging**: the hire UI states "mandatory compliance packs apply from the first answer," but all 12 roles seed an empty array — the promise is currently vacuous.
- **Redundant UI:** two "work" surfaces (Work tab = action product; Workbench→Work = objectives/watchers/queue), two "operating" reads (How-I-operate tab vs Workbench), "Waiting on" rendered in three places. Cohesion cost, not correctness.

---

## 4. Per-archetype — "right DE for the right job"

**Good news: the role kits are substantive and genuinely applied.** `install_role_kit` stamps watchers, a published SOP playbook, employee-scoped guardrails, and connected systems onto the DE at hire, and all of these are *enforced* (guardrails on every path; SOP + guardrails injected into the autonomous work briefing; watchers drive the Book of Work). Kit completeness across the 12 active roles:

| role | watchers | SOP steps | guardrails | systems | setup Qs | compliance |
|---|---|---|---|---|---|---|
| support_agent | 1 | 6 | 4 | 1 | 8 | **0** |
| renewal_manager | 5 | 5 | 3 | 1 | 7 | **0** |
| cs_manager | 2 | 5 | 3 | 1 | 6 | **0** |
| billing_ar | 1 | 5 | 3 | 1 | 6 | **0** |
| accounting | 1 | 4 | 2 | 1 | 6 | **0** |
| fpa | 1 | 4 | 2 | 3 | 6 | **0** |
| onboarding | 2 | 7 | 3 | 1 | 4 | **0** |
| bdr | 1 | 5 | 4 | 1 | 6 | **0** |
| sdr | 2 | 5 | 3 | 1 | 6 | **0** |
| marketing | 1 | 5 | 3 | 1 | 6 | **0** |
| seo | 1 | 5 | 2 | 1 | 6 | **0** |
| google_ads | 1 | 5 | 5 | 1 | 6 | **0** |

Every role is genuinely differentiated — so a hired archetype DE *is* fit for its job. **The per-role weaknesses are systemic, not per-role:**
1. **Compliance is empty for every role** (the vacuous promise above).
2. **Two hire paths, only one gives a role.** "Describe the role" (plain-language) produces a DE with **no kit and no archetype** (`catalog_id = NULL`) — a role-less DE. Only "ready-made role" runs the kit. A large class of DEs can be born unfit for any specific job.
3. **The hire-time binding bug:** `instantiate_role_archetype` sets `catalog_id` but **not** `archetype_key`, and the role-aware cert/exam/routing stack reads only `archetype_key` (NULL until certified). So a freshly hired role DE is **examined only on universal questions**, not its role — the exact failure mig 265 fixed, reintroduced at the hire boundary.
4. **Role banks are drafted but inactive** (this session): each role now has starter golden questions, but they await founder activation, so exams aren't yet role-deep in practice.

---

## 5. Gap map — prioritized

**P0 — correctness bugs (cheap, high-impact):**
- **Fix the archetype binding at hire.** Patch `instantiate_role_archetype` to set `archetype_key := a.key`; add `catalog_id` as a fallback in `resolve_de_archetype`. Without this, every newly hired role DE is mis-examined.
- **Resolve the compliance-pack contradiction.** Either populate real `compliance_pack_keys` per role (HIPAA for a patient-support DE, TCPA for outreach, SOX/financial for accounting/fpa/billing) so the enforced attach-loop bites, or correct the UI promise. Compliance is the product's spine; a vacuous promise there is a credibility risk.

**P1 — close "implied but not delivered" (relevance & customization):**
- **Generalize watchers beyond `customer_accounts`.** This is the single biggest "generic surface implied, domain-limited delivery." A finance/accounting/billing DE can't watch its own domain's records. A generic "watch any entity/view on a condition" mechanism unlocks real per-role proactivity.
- **Make standing (recurring) missions installable** (currently hard-refused) — completes the mission keystone so a DE can hold an ongoing cadence, not just one-shot batches.
- **Give the DE cross-conversation/account memory.** Answer-path memory is conversation-scoped only — a DE forgets a customer between chats. Account-scoped episodic recall is what makes it feel like an employee who "remembers you."

**P2 — coachability & adaptability:**
- **Cron-drive `de-improve`.** Today a failed answer only becomes a proposed knowledge fix if something manually invokes it. Scheduling it (still human-approved) turns the DE genuinely self-coaching.
- **Decide the fate of the scorecard cluster.** Either (a) let Skills/KPIs actually gate/route work (don't assign work a DE isn't proficient at; a red KPI narrows autonomy) — turning records into controls — or (b) consciously keep them as human-facing records and stop implying otherwise. Right now they hover in between.
- **Unify model routing.** `model_id` governs answers, `de_model_routes` governs work — a per-DE routing entry has no effect on that DE's chat. One resolver.

**P3 — structure & cohesion:**
- Consolidate the redundant Work/operating surfaces; make the earned-trust ladder per-DE; surface & make the role editable post-hire (there is no `de_role_assignments` table despite docs referencing it); retire the catalog cruft (`knowledge_scaffold`, etc.) or wire it.

---

## 6. Recommendation

Do **P0 immediately** (two bugs, both small, both undermine trust in the exact governance story that is the product's differentiator). Then **P1** as the next build epic — watcher genericity is the highest-leverage single item for "right DE, right job across every domain." Treat **P2** as the "coachable/adaptable" investment and **P3** as cleanup. The foundation is genuinely strong; these close the gap between what the Employee File *shows* and what the DE *does*.
