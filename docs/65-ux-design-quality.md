# 65 — Workstream K: UX & design quality (2026-08-18)

Static analysis plus a live drive of the deployed app as a stranger, on the nearly-fresh Review
Lab tenant. Accessibility was **measured in the running page** (computed styles, alpha-composited
contrast, real Tab traversal) rather than eyeballed.

> **Screenshots were not available** — the browser pane was hidden host-side, so the page could not
> composite frames. Everything below is extracted text, computed style and DOM state, which is
> more precise than a screenshot for accessibility but does not capture visual polish. A
> screenshot pass remains owed.

## 1. Four things I measured wrong first — and the corrections

Stated up front, because the wrong versions are the intuitive ones and someone acting on a draft
would have shipped four unnecessary fixes:

| First reading | Corrected finding | Why I was wrong |
|---|---|---|
| "0% of inputs use the kit" | **141 uses across 27 files** | the kit exposes `INPUT_CLS`, a className constant — not an `<Input>` component |
| "5 WCAG contrast failures" | **0 failures / 104 elements** | I treated `rgba(…, 0.1)` tints as opaque instead of compositing them over the dark ground |
| "40 of 40 controls have no focus ring" | **focus is visible** | programmatic `.focus()` does not trigger `:focus-visible`; a real Tab press does |
| "the small-screen gate ignores resize" | **the code is correct** | it uses `matchMedia` + a `change` listener; the stale render was an emulation artifact |

## 2. Design-system adoption — real, partial, and improving

`design-drift.mjs`: **no regressions**, 5 of 8 metrics improved (inline style objects 65→45, bg-slate
8→7, card padding 10→9), 3 unchanged (radius variants 13, raw hex 18, hand-rolled dialogs 0).
The ratchet works: drift can only go down.

Adoption is a different question from drift, and it is partial:

| Surface | Kit | Raw | Adoption |
|---|---|---|---|
| Buttons | 267 `<Button>` | 663 `<button>` | **29%** |
| Inputs | 141 `INPUT_CLS` | 350 `<input>` | **~40%** |
| Files importing the kit | 71 | of 132 | **54%** |

The kit supplies **24 primitives** (Button, Chip, PanelCard, StatTile, QueueCard, EmptyState,
Banner, Field, TabBar, TH/TD, TableScroll, Modal, Drawer, DecisionCard, FilterBar,
SetupChecklist…). `EmptyState` is used on **42 pages** — genuinely broad.

**Legacy `components/Modal` is down to 2 files** (debt-map #40 recorded 30). That is a large,
quiet win worth recording.

Remaining named debt: **`text-[9px]` — 25 uses across 12 files** (register D-4), below the design
system's type floor.

## 3. Accessibility — better than expected

| Check | Result |
|---|---|
| Contrast (WCAG AA, alpha-composited over the real ground) | **0 failures across 104 leaf text elements** |
| Icon-only buttons with no accessible name | **0** |
| Keyboard focus visibility | ✅ visible — `:focus-visible` matches on Tab, browser ring `auto 0.8px rgb(229,151,0)`, 3 focus-visible rules in CSS |
| `aria-label` usage across pages | 34 |
| **`color-scheme`** | ❌ **declared nowhere** (register **D-13**) |
| `prefers-reduced-motion` | ❌ unhandled, against 465 transition/animate classes |

**The one real defect (D-13):** the app's ground is `rgb(12,17,35)` — dark — but `color-scheme`
resolves to `normal`, so every browser-painted surface renders light against it: scrollbars,
native `select` dropdowns, date/time pickers, checkboxes, autofill backgrounds. There are 350 raw
inputs inheriting this. **The fix is one line** (`color-scheme: dark` on `:root`).

Focus deserves a nuance: it works, but via the *browser's* default ring rather than a designed
one. Fine for compliance, slightly at odds with a design system this deliberate.

## 4. First ten minutes as a stranger — the walkthrough

Signing in to a nearly-empty workspace, the dashboard shows:

1. **A setup checklist that knows where you are** — *"3 of 4 steps done — about 10 minutes total"*,
   with step 1 (Hire your first Digital Employee) offering two routes: a plain-English conversation
   or "Hire with Ada instead". Steps 2–4 (teach it, ask it, put it on your website) already ticked.
2. **Plain-language performance** — *"Your team handled 10 pieces of work in the last 30 days and
   brought 5 to you"*, then the two numbers beneath it. No jargon, no chart to decode.
3. **Decisions, with everything needed to decide** — each card carries the customer's question,
   the employee's draft, its confidence, and **how long it has been waiting**. "Open it" is the
   only call to action.
4. **An empty state that explains itself** — *"No employee is mid-task at this second. Watchers,
   playbook triggers, and the support inbox start work…"* This is the strongest UX pattern in the
   product: it says why nothing is happening, not merely that nothing is.
5. **Navigation grouped by intent** — 19 items under DIGITAL EMPLOYEES / MY TASKS / SYSTEMS &
   ACTIONS / GOVERNANCE / SETUP, with a live count badge on Approvals.
6. **Honest provenance** — a "LIVE · Real workspace data" badge, which matters in a product whose
   history includes demo data masquerading as real.

**The desk/phone split is handled with unusual care.** A narrow viewport is not given a broken
layout: it is offered the phone view or an explicit "carry on to the full app", and the code
comment explains the reasoning — *"covering a broken layout still renders the broken layout
underneath… the page simply does not mount."* That is a considered decision, not a media query.

**One thing observed but not reproduced:** on first render the dashboard showed a celebration
banner — *"Your AI workforce is live. Hired, taught, tested and on your website."* — while the
checklist beneath reports hiring as **not** done. On reload the banner was gone. Two completion
computations may disagree, but I saw it once and could not reproduce it, so it is recorded as an
observation, **not a finding**.

## 5. Page-by-page grade

| Area | Grade | Note |
|---|---|---|
| Dashboard / Command Centre | **A−** | best-in-product empty states, decision cards carry full context |
| Navigation | **B+** | grouped and labelled; 19 items is dense but scannable |
| Approvals & Drafts | **A−** | context, confidence and wait time on every card (docs/50) |
| Phone shell `/m` | **B+** | deliberate scope, honest about what needs a desk (docs/50) |
| Design-system consistency | **B−** | 29% button adoption; 24 primitives available and half-used |
| Accessibility | **B+** | contrast and names clean; `color-scheme` and reduced-motion missing |
| Visual polish | **incomplete** | screenshots unavailable this session |

## 6. Verdict and the cheap wins

**UX is a strength, not a risk.** The writing is the best part of this product's interface — empty
states that explain themselves, decisions that carry their evidence, a desk/phone split with a
stated rationale. Accessibility measured clean on the two axes that matter most.

Four cheap fixes, in order of value per minute:

1. **`color-scheme: dark`** — one line, fixes every native control and scrollbar (D-13).
2. **Raise `text-[9px]` to the type floor** — 25 uses, 12 files (D-4).
3. **Add a `prefers-reduced-motion` block** — 465 transitions currently have no escape.
4. **Push kit adoption past the halfway mark** — 29% of buttons is the largest remaining
   consistency gap, and every conversion also inherits the kit's focus ring.
