# 68 — Workstream S: documentation & knowledge accuracy (2026-08-18)

The corpus has grown from 78 files at review start to **177**. This workstream verifies the debt
map's nine documentation findings against today, classifies the corpus, and answers the pilot
question: *is there anything a customer could actually read?*

**It corrects two of my own earlier conclusions.**

## 1. Two corrections to this review

| Where | What I said | What is true |
|---|---|---|
| **docs/49 (Workstream A)** | "legacy caps-named docs (GO_LIVE_*, HIPAA policy) presumed stale until S clears them" | **Wrong for 7 of 10.** Most were touched within two weeks and carry honesty banners. `DISASTER_RECOVERY.md` is not merely current — Workstream E found it *accurate*, and better than the debt map's claim about it |
| **docs/56 (Workstream G)** | implied a pilot admin has nothing to read | **Wrong.** A 65-article customer knowledge base exists, is live in the product, and is embedded for retrieval (§4) |

## 2. Debt-map findings, re-verified

| # | Claim | Verdict today |
|---|---|---|
| 77 | No README, no index, no way in | ✅ **STANDS** — 177 docs, no `docs/README.md` |
| 78 | docs/08 declares 53 tables, 46 do not exist | ✅ **CONFIRMED EXACTLY** — independently re-derived: 53 named, **46 absent** |
| 79 | docs/09 documents a REST API that exists nowhere | ✅ **CONFIRMED** — 16 endpoints under `/v1`; **no `/v1` surface of any kind** |
| 82 | Staleness banners cover 5% of the corpus | ⬆️ **MATERIALLY IMPROVED** — now **76 of 177 (42%)** |
| 85 | Dated planning docs at the repo root | ✅ **STANDS** — 14 stray `.md` files |

### The two fiction documents (register **D-15**)

`docs/08_Database_Design.md` names 53 tables; **46 are absent from production**. Its vocabulary —
`agents`, `actions`, `approval_requests`, `billing_subscriptions`, `audit_trail`,
`ai_token_usage` — is the *original* design, superseded in reality by `digital_employees`,
`action_definitions`, `human_tasks`, `audit_events`, `de_token_usage`. It is the v1 design doc,
never updated and never marked.

`docs/09_API_and_Integration_Standards.md` documents 16 REST endpoints under `/v1` (capabilities,
capability-runs, tools, webhooks, connector health, jobs). **None exists.** The product is
PostgREST plus edge functions; there is no bespoke `/v1` API. If this were handed to an
integration partner, every endpoint in it would be fiction.

Both matter more than an ordinary stale doc because they are **the two a new engineer or a partner
reads first**, and because the corpus has an established banner convention (42% coverage) that
these two simply never received.

> **A note on how this finding was filed.** My first attempt was **refused by the register**: the
> verification I wrote matched the words "History" (a section heading) and `deprecated_at` (a
> column name), so its own check said the docs *were* marked. The tool's message — *"seeding a
> state nobody checked into the mechanism that exists to stop unchecked states is self-refuting"* —
> is exactly right. The finding was true; my evidence was sloppy. Refiled with a banner-shaped
> pattern that returns 0. **This is the register catching a reviewer, which is the strongest thing
> I can report about it.**

## 3. Corpus classification

| Stratum | Count | State |
|---|---|---|
| Numbered decision record (05–68) | ~64 | **The governed record.** Several founder-locked; this review added 49–68 |
| Product knowledge base (`docs/kb/`) | **65** | **Customer-facing, live, embedded** — see §4 |
| Legacy caps-named | 11 | 7 marked and recently touched · **3 unmarked**: `DEPLOYMENT.md`, `SCALABILITY_GAPS.md`, **`HIPAA-SECURITY-POLICY.md`** |
| Reference / design | ~23 | design-system, mcp-connector-design, benchmark, superpowers |
| Stray at repo root | 14 | outside `docs/` entirely, including two "SOPHIE_*" files naming a persona the product no longer uses |

**The single highest-risk document remains `HIPAA-SECURITY-POLICY.md`** — unmarked, five weeks
untouched, asserting a HIPAA programme that does not exist. Workstream N already recommended
deleting or standing it up; S confirms it is also the *only* legacy doc that is both unmarked and
makes a compliance claim.

## 4. The customer manual is not missing — it is good

`docs/kb/` holds **65 articles** across 11 areas: getting-started · digital-employees ·
tasks-approvals · knowledge · playbooks · connectors · governance · company-data ·
performance-outcomes · settings-billing, plus a `_STYLE.md`.

**It is live, not shelved:** `platform_knowledge_docs` holds **65** rows — an exact match — and
`platform_knowledge_chunks` holds **276 embedded chunks**, so the Workspace Assistant can answer
from it.

The writing is retrieval-aware and genuinely customer-shaped. A representative article opens:

* frontmatter carrying `title · category · feature · audience · difficulty · tags`
* a **question** as the title — *"Can the Workspace Assistant change settings for me?"* — matching
  how a user would ask
* tags that include the **wrong words people actually use** ("workplace assistant", "workforce
  assistance"), so search finds it anyway
* sections *What it is* / *What it can change — and what it can't*
* concrete, honest specifics: the exact UI location, and Undo available for **120 hours**

That is professional product documentation, and it materially improves the pilot picture from
docs/56. Its one weakness: **last updated 2026-07-27** — three weeks and roughly 90 migrations ago.

## 5. The missing manual list — much shorter than expected

Not "write a manual", but four gaps:

1. **A front door** (`docs/README.md`) — 177 documents with no index (debt #77). One page.
2. **Banner the two fiction docs** (D-15) — or delete them.
3. **Resolve `HIPAA-SECURITY-POLICY.md`** — delete or stand up the programme (docs/62).
4. **Refresh the KB** against the last three weeks of shipping, and put a review cadence on it —
   a customer-facing manual that drifts is worse than an internal one that does.

## 6. Verdict

**Documentation is a strength that is under-credited, with two sharp exceptions.** The corpus
marks its own staleness 42% of the time, the decision record is unusually rich, and the
customer-facing knowledge base is live, embedded and well written.

The exceptions are narrow and cheap: two foundational documents that describe a system that never
shipped, and one compliance policy asserting a programme that does not exist. None blocks a
pilot; all three would embarrass the product in a diligence pack.
