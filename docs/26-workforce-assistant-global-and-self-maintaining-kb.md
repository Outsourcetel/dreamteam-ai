# 26 — The Workforce Assistant: global, shelved, and self-maintaining

**Status:** designed, not built. Founder-approved 2026-07-25 to build next session.
**Prereqs already live:** migs 330 (anon isolation hardening) and 331 (features global).

---

## The problem, in one line

Every tenant should get the same Workforce Assistant, fed by DreamTeam's own
product knowledge — without that knowledge cluttering the customer's own library,
and without it going stale the moment we ship anything.

### Where it stands today (verified 2026-07-25)

| Fact | Value |
|---|---|
| Tenants with a Workforce Assistant | 12 of 27 |
| Their lifecycle status | `designed` — **not active anywhere** |
| Product KB location | 72 docs inside `outsourcetel-hq`, as ordinary tenant content |
| `knowledge_collections` | exists, **completely unused** — a clean slot |

---

## Part 1 — Store it once, reach into it

The obvious implementation is to copy the KB into all 27 tenants. That is wrong:
27× embedding cost, 27× drift, and every product-doc edit becomes 27 re-ingests
that will silently fall out of sync. One of them will be wrong within a week.

Instead: **one platform-owned library**, and tenant retrieval reaches into it.
Update once, every assistant everywhere knows it immediately.

### The isolation constraint (non-negotiable)

- platform knowledge → tenant answers: **yes**
- tenant knowledge → platform: **never**
- tenant A → tenant B: **never** (unchanged)

Build the widening function so it **takes no tenant parameter at all** — it can
only ever add the single platform library id. There is then no argument anyone
could pass to turn it into a leak. This is a direct lesson from mig 330: the
`auth.uid() IS NULL` guards were all *correct-looking* and all bypassable,
because the hole was in what the caller could supply. Remove the parameter,
remove the class of bug.

---

## Part 2 — Shelves (the UX)

The Knowledge page becomes two shelves, but only one is visible by default.

**Shelf 1 — Your knowledge.** Exactly as today. Counts, quality scores, gap
detection, freshness, re-embed jobs: **all computed on this shelf alone.** A
tenant who never opens the other shelf sees zero change. This is not cosmetic —
72 platform docs folded into their totals would distort every quality number on
the page and make their own gap analysis meaningless.

**Shelf 2 — collapsed to a single quiet row.** Not a tab, not a panel:

```
▸ DreamTeam product guide · 72 articles · read-only · maintained by DreamTeam
```

Expanded: visually distinct surface, a "provided" chip per row, and **no**
edit/delete/re-embed affordances anywhere.

### The framing is the design

Do not label it "DreamTeam docs". Label the expanded view:

> **What your Workforce Assistant knows**

That flips it from *someone else's files cluttering my library* into *an audit of
what my employee was taught* — which is precisely the governance posture this
product sells. When a customer asks "why did the assistant tell me that?", they
open the shelf. It becomes a feature instead of a thing to hide.

### Search that crosses over without polluting

Searching their library returns only their results. If the platform shelf also
matched, one subtle line underneath:

```
Also 3 matches in the DreamTeam product guide →
```

Discoverable when wanted, never mixed in.

### The employee itself

Platform-provided: auto-created in every tenant, including future ones, via the
same baseline lever used for feature defaults in mig 331 — so there is no
provisioning step to forget. Marked provided-by-platform so it cannot be renamed
or deleted into something broken, while the tenant still controls its voice and
its trust dial.

**Two things to handle up front, not discover later:**
1. Its answers cite platform docs — the citation link must resolve into the
   read-only shelf, or customers get a dead reference.
2. Its certification exam should be the **platform's** golden set, not the
   tenant's. Otherwise every tenant re-certifies the same employee against
   knowledge it does not have.

---

## Part 3 — The KB maintains itself

*Founder, 2026-07-25: "we also need a mechanism where the workplace assistance
knowledge doc gets auto updated and added with new features or modifications or
behaviours."*

This is the half that decides whether Part 1 is an asset or a liability. A
product KB that describes how the platform worked in July is worse than no KB —
the assistant will state stale behaviour **confidently**, which is the exact
failure this product exists to prevent.

### Do not build a new pipeline. Wire the ones that exist.

Already shipped and idle for this purpose:

| Existing machinery | Role here |
|---|---|
| `knowledge_revision_requests` | the draft that waits for a human |
| approve → auto-publish (mig 183) | the publish step |
| entity draft/amend (Living Workforce D1/D2) | the drafting pattern |
| knowledge gap detection | finds what the KB is *missing* |
| `staleness_watchdog`, `last_verified_at`, `review_interval_days`, `expires_at` | finds what has gone *stale* |

### The source of truth already exists, in prose

Every migration in this repo carries a long header explaining **what changed and
why**, written at the moment of the change. That is not a happy accident — it is
the house style, and it makes the changelog harvestable. Migration 325 explains
the judgment layer better than any doc written afterwards would.

### The loop

```
  ship something
        │
        ▼
  DETECT ── new migration header · new/changed feature_registry row
        │    · edge-function deploy · commit message · roadmap edit
        ▼
  DRAFT ─── the Assistant proposes the KB edit, citing the migration
        │   that caused it
        ▼
  GATE ──── lands as a knowledge_revision_request. NOT auto-published.
        │   A human approves. (Same gate a customer's DE gets.)
        ▼
  PUBLISH ─ approve → publish → re-embed → every assistant in every
            tenant knows it, instantly, because there is only one copy
```

Every published article carries provenance: *"updated from migration 331 ·
2026-07-25"*. So a customer reading the shelf can see not just what the
assistant knows, but when and why it learned it.

### Closing the other direction

Knowledge gap detection already fires when a DE cannot answer. Point the
Assistant's gaps at this same drafting pipeline: **a question customers keep
asking that the KB cannot answer is a doc that needs writing.** The KB then grows
from real demand rather than from someone's guess about what to document.

### Why this is worth more than the docs it produces

DreamTeam's own Workforce Assistant maintains DreamTeam's own product knowledge,
using DreamTeam's own draft → approve → publish governance, under the same
guardrails and certification as any customer employee.

That is the founder's "I am my customer" made literal, and it is demonstrable:
*the platform keeps its own documentation current using the machinery it sells.*
It is also the honest version — the human approval gate stays, so we are not
claiming an autonomy we have not earned.

---

## Build order (next session)

1. **332** — platform library + shelf model + the no-parameter widening function.
   Verify isolation with the same anon-probe method used for 330.
2. **333** — platform-provided employee + auto-provisioning on tenant create +
   retrieval union wired into `de-answer`.
3. **UI** — shelves in the Knowledge Library, collapsed by default; the
   "What your Workforce Assistant knows" view; search cross-over line.
4. **334** — the change-detector → draft → `knowledge_revision_requests` loop,
   plus gap-fed drafting.

Steps 1–3 make the assistant real. Step 4 keeps it true.
