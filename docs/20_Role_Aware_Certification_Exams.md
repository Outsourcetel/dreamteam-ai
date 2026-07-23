# 20 — Role-Aware Certification Exams (design)

**Status:** design-first, awaiting founder decisions. Not built.
**Date:** 2026-07-23
**Origin:** while verifying the Product Support DE re-cert (G6 gate), the exam ran to completion for the first time (see mig 264 driver) and scored **62.5% — FAILED**. Inspecting the failures showed the score was mostly an artifact of a **mis-scoped exam**, not a weak DE.

---

## 1. The problem, verified

The certification exam is what gates DE autonomy: a stale/failed cert clamps a DE to draft-mode (G6, mig 258). That gate is only as fair as the exam behind it. Two concrete defects:

### 1a. The exam is not role-scoped
`golden_qa` (the question bank) has **no role/archetype dimension** — columns are `question, expected_fragments, min_confidence, category, active`. `category` is a *question type* (procedure / knowledge / guardrail / escalation), not a role. `eval-run` loads **every active question for the tenant** with no filter, so **every DE — support, finance, renewal — sits the identical exam.**

The Product Support DE failed largely on questions outside its job:

| Failed question | Actually belongs to |
|---|---|
| "When is a renewal considered complete?" | Renewal DE |
| "A customer says they're considering cancelling — what do you do?" | Account Success DE |
| "Customer near their seat limit — what's the right move?" | Account Success / expansion |
| "An account's health score dropped 75→55…" | Account Success DE |

This is the **same one-size-fits-all anti-pattern already removed for escalation rules (mig 262) and KPIs (mig 263)** this cycle. The cert exam is the last major place it survives.

### 1b. The DE's archetype is not first-class (the prerequisite gap)
To scope an exam to a DE's role, the DE must *have* a queryable role. It doesn't:
- `digital_employees` has **no** archetype column (`catalog_id`, `specialist_key` both NULL for the support DE; `category='Customer'`, `department=''`).
- `de_role_assignments` uses `role_name` and is **empty** for this DE.
- `archetype_key` only appears on downstream records — `role_certifications`, `eval_runs`, `de_training_modules`, `de_model_routes` — i.e. it's an input *passed at cert time*, never stored on the DE itself.

So "support_agent" for this DE lives only on its (now stale) cert row. **Any role-aware feature — exams, training, model routing — is standing on sand until archetype is first-class on the DE.**

### 1c. Grading is brittle (secondary)
Pass = *every* `expected_fragment` is a case-insensitive substring of the answer **AND** confidence ≥ floor. A correct-but-reworded answer fails ("missing fragment `approval`" when the DE wrote "needs sign-off"). Worth softening, but secondary to scoping.

---

## 2. Proposed design

### Step A — make archetype first-class (prerequisite)
Add `archetype_key text` to `digital_employees`. Resolve/backfill in priority order:
1. latest `role_certifications.archetype_key` for the DE (where present),
2. else a mapping from `category`/`department` → archetype,
3. else `NULL` (unassigned — treated as "generalist", sits only universal questions).

Expose a helper `resolve_de_archetype(p_de_id) → text` so exam, training, and routing all read archetype the same way. Hiring / role-kit install writes it going forward.

### Step B — tag the question bank
Add `archetype_key text NULL` to `golden_qa`. Semantics:
- `archetype_key IS NULL` → **universal** question (product knowledge, governance, safety) — applies to *every* DE.
- `archetype_key = 'support_agent'` → only support DEs sit it.

Backfill the existing 24: keep the `knowledge`/`guardrail` product-and-safety ones **universal**; retag the renewal/CS `procedure`/`escalation` ones to their true archetype (`renewal_manager`, `account_success`).

### Step C — scope the exam in `eval-run`
One-line change to the loader:
```
.or(`archetype_key.is.null,archetype_key.eq.${deArchetype}`)
```
`deArchetype = resolve_de_archetype(targetDeId)`. A support DE now sits universal + support questions; a finance DE sits universal + finance. `certify_de_from_eval` threshold (80%) is unchanged — but now measured against a fair suite.

### Step D — seed per-archetype banks
Extend the mig-254 golden-exam seeding so each shipped archetype (support_agent, renewal_manager, account_success, finance_clerk, …) has its own question set, plus a shared universal set. This is the bulk of the work and should reuse the existing seeding path.

### Step E (optional) — soften grading
Offer per-question `match_mode`: `all_fragments` (today) or `any_fragment` or an LLM-judge rubric (eval-judge already exists). Default stays strict; loosen only where authors opt in.

---

## 3. Rollout & backward-compat
- All columns nullable → **zero break** on apply. Until archetypes are backfilled, `resolve_de_archetype` returns NULL and every DE sits the universal set only (strictly *fairer* than today, never worse).
- Ships global via baseline (per the always-live rule) — new tenants get archetype-tagged banks automatically.
- The mig-264 driver already completes whatever suite `eval-run` assembles, so no driver change.

## 4. Effort
- **A (archetype first-class):** 1 migration + backfill + `resolve_de_archetype` + hire-path write. ~½ day. *Highest leverage — unblocks training & routing too.*
- **B/C (tag + filter):** 1 migration + ~5-line `eval-run` change. ~2 hrs.
- **D (seed banks):** the real work — authoring per-role questions. Scales with archetype count.
- **E (grading):** optional, deferred.

## 5. Decisions for the founder
1. **Scope now or after pilot activation?** Recommendation: this is post-pilot-activation — activation (email/Sentry) is the open ROI.
2. **Archetype as a DE column (A) — yes?** Recommendation: yes; it's the missing spine under exams/training/routing, not just this fix.
3. **Who authors the per-role question banks (D)?** AI-drafted from each role's playbook + charter, founder-reviewed — reuses the existing draft-for-approval pattern.
4. **Soften grading (E) now or defer?** Recommendation: defer; scoping is the real win.
