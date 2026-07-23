# 22 — DE Deep Pass 2: Playbooks, Specialists/Consultation, DE↔DE Interaction

**Date:** 2026-07-23 · **Method:** 3 parallel deep code-readers, every claim file-referenced. Companion to [docs/21](21_DE_Concept_Evaluation.md) (pass 1). **This pass merges with pass 1 — no building committed yet.**

---

## The unifying meta-theme (both passes)

Pass 1 found a rich, well-governed **machinery layer**. Pass 2 explains *why parts of it feel inert*: **the impressive machinery is repeatedly not wired into the two loops where the DE actually lives — `de-answer` (chat/Q&A) and `de-work` (autonomy).** The dominant defect across the whole DE concept is not missing capability; it is **built-but-unreached-from-the-core-loops**:

- Pass 1: scorecard records don't gate work; compliance packs empty; watchers domain-limited.
- Pass 2: the executable playbook engine isn't called by the DE's brain; consult-an-expert and delegate-a-task aren't on the core loops; two complete collaboration engines have zero callers; learning is siloed per DE.

**So the highest-leverage program is a "wiring" program, not a "build new features" program.** Most of what would make the DE feel like a real, collaborating, procedure-following employee already exists one layer below where it's needed.

---

## A. PLAYBOOKS — two disconnected worlds

**World A — `playbook-execute`: a genuine executable engine.** 20 typed step primitives (`check_account`, `generate_invoice`, `human_approval`, `guardrail_check`, `connector_action`, `decision`, `agentic_step`, `consult_specialist`, `sub_playbook`, …), per-step assertion rules, one-level conditional branching (`decision` → `then/else`), human gates that pause the run, ordering validation, immutable `playbook_versions` snapshots, hash-chained audit, crash-safe resume via cron. Real side effects, all routed through the same `decide_action_execution` guardrail+trust gate. A competitor chatbot cannot claim this layer.

**World B — the DE's own brain: never runs it.** `de-work` (autonomy) plans **freely** and injects the DE's published SOP as **flattened prose** into the LLM prompt (only `instruction`/`checklist` text is extracted — mig 250; the decisions/gates/connector-actions are dropped). `de-answer` (chat) doesn't read playbooks at all — it answers from `knowledge_docs`, and a published playbook reaches it only as a **mirrored RAG doc it can cite**. So in the DE's day-to-day, an SOP's gates, branches, and tool-restrictions are **advisory text the model may or may not honor.**

**The bridge exists and is LIVE:** `agentic_step` (and its `custom_step` alias) hands a step to a bounded, budget-capped tool-use loop (`agentic-step-execute`) that routes every write through the same Control-Fabric gate. It uses the shared failover LLM client, so it is **not** dormant (the "ANTHROPIC_API_KEY" comments are stale). **But it only runs inside `playbook-execute`, never inside de-work's free planner.**

**Coaching pipeline = standout strength.** draft (`playbook-draft`) → Deep Study cross-exam → amend (`playbook-amend`, proven by counterfactual replay in the engine) → human review gate → publish (immutable snapshot). Amendments never auto-publish. Genuinely sophisticated and honest.

**Gaps:** (1) no step-level enforcement on the paths that matter (de-work/de-answer); (2) no situational playbook selection — de-work injects all ≤4 SOPs at once, the structured engine relies on external triggers naming a `definition_id`, nothing reasons "this situation → that procedure"; (3) lossy flattening drops all structure into the brief; (4) no per-step tool restriction in the free planner; (5) shallow conditionals (one level, scalar ops, no loops); (6) **no measurement of SOP adherence** — a run that ignores the SOP looks identical to a compliant one; the charter is dead (`OperatingCharterPanel` orphaned).

---

## B. SPECIALISTS + CONSULTATION — one word, three mechanisms

**"Specialist"/"consult" denote three structurally distinct systems that were never unified:**
- **System A — Specialist desk** (`is_specialist` DE + `specialist_sources` + `spec_consultations`): a grounded knowledge-retrieval desk. Runs the target's own sources + guardrails + data-grants. **No per-asker allow-list** — any caller naming a `specialist_key` can consult.
- **System B — DE-to-DE consultation** (`de_consultation_grants`, mig 111): a tenant-admin allow-list `(requester, target, category)`. Gates evidence-pipeline Step 3c, `de-orchestrate` routing, and cross-DE task assignment.
- **Third — `de_specialist_assignments`** (primary/secondary binding): feeds only the playbook `consult_specialist` `auto` resolver.

**The capability is wired only into peripheral paths.** `de-answer` and `de-work` expose **no consult tool and no task-assign tool**. A DE mid-conversation on a billing question **cannot** reach the finance specialist — it can only answer from its own knowledge or escalate to a human. Autonomous "I should ask the SME" exists in **exactly one surface**: a playbook `agentic_step`.

**Gaps:** (1) no consult on the primary loops; (2) two governance models disagree (System A has no allow-list, System B is strict — a tenant's careful grant graph doesn't constrain the desk); (3) **model-pin bug** — standalone consult ignores the target's per-DE model, hardcoded to `claude-sonnet-5` (only Step 3c honors `resolveDeModel`); (4) **consulting produces no learning** — results write `spec_consultations` (audit) but never the asker's memory/experience, so a DE re-consults from scratch every time; (5) Step 3c is unconditional (consults every grant on every qualifying run), the opposite of an employee *choosing* when to ask.

---

## C. DE↔DE COLLABORATION — engines built, callers missing

| Capability | Status | Evidence |
|---|---|---|
| Shared knowledge base | **REAL** | tenant-visible docs + per-DE scope + authority tiers (`hybrid_match_knowledge`, mig 236) |
| Team fallback coverage | **REAL but narrow** | `poll_de_work_sources_targets` enforces primary→backup→specialist chain — **only for who picks up NEW inbox items** (mig 128). Not in-flight handoff, not escalation routing. |
| Cross-DE task delegation | **THIN — dormant** | `request_de_task` (mig 234) opens a real case on the receiver, fully guarded — but **zero callers**: no de-work tool, no UI. |
| Supervisor routing | **THIN — dormant** | `de-orchestrate` picks the best teammate by responsibility and has them answer on the same thread — but **zero frontend callers**. |
| A2A protocol | **REAL but external-only** | `a2a` exposes a DE to *outside* orchestrators (inbound, answer-only); not internal DE-to-DE. |
| Mission across a team | **ABSENT** | `de-mission` is strictly single-DE by construction. |
| Escalate to a senior DE | **ABSENT (by design)** | escalation → `human_tasks` only. |
| Team learns from one member's fix | **ABSENT** | `de_memory`/experience hard-scoped to one `de_id`. No role/workforce shared brain — every DE is a learning island. |

---

## MERGED & RE-PRIORITIZED GAP MAP (pass 1 + pass 2)

**Tier 0 — correctness bugs (small, undermine the trust story):**
- Archetype binding at hire (`archetype_key` unset → role DEs mis-examined). *[pass 1]*
- Vacuous compliance-pack promise (all roles empty). *[pass 1]*
- Consult model-pin bug (target model ignored on standalone consult). *[pass 2]*

**Tier 1 — WIRE the machinery into the core loops (highest leverage, mostly wiring not building):**
- **Give `de-answer` and `de-work` a `consult_specialist` tool** so a DE can ask an SME mid-conversation/mid-task, not only inside a playbook. *[pass 2]*
- **Surface + trigger cross-DE delegation** (`request_de_task`): add a de-work tool + a human UI. Turns a dormant engine into real teamwork. *[pass 2]*
- **Wire `de-orchestrate`** into the widget/inbox as a supervisor entry point. *[pass 2]*
- **Make the DE's brain honor playbook structure** — at minimum situational SOP selection + step gates, ideally route procedural work through `agentic_step` instead of free-planning over flattened prose. *[pass 2]*

**Tier 2 — relevance & customization (real builds):**
- Generalize watchers beyond `customer_accounts`. *[pass 1]*
- Role/workforce-level shared learning (a fix by one DE reaches same-role DEs). *[pass 2 — the big conceptual gap]*
- Cross-conversation/account memory. *[pass 1]*
- Standing (recurring) missions installable; consider cross-DE missions. *[pass 1 + 2]*

**Tier 3 — coachability, adaptability, cohesion:**
- Cron-drive `de-improve`; learning from consultations (write to asker memory). *[pass 1 + 2]*
- Decide the scorecard's fate (gate work vs. stay records); unify split model routing. *[pass 1]*
- SOP-adherence measurement; unify the three specialist/consult mechanisms + one governance model. *[pass 2]*
- Redundant-surface cleanup; per-DE trust ladder; in-flight fallback handoff; escalate-to-senior-DE. *[pass 1 + 2]*

---

## Recommendation for the merge conversation

The single most important reframing: **before building anything new, wire what exists into `de-answer`/`de-work`.** Tier 1 is disproportionately high-value because the hard parts (governed delegation, governed consultation, executable procedures, supervisor routing) are already built and guarded — they just aren't reachable from the loops the DE actually runs in. Do Tier 0 bugs alongside. Then Tier 2 (shared learning + watcher genericity) is the real net-new investment that makes a *workforce* rather than a set of isolated employees.
