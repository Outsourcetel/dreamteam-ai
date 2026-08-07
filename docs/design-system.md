# DreamTeam Design System v1 — the Program

**Status: LAW.** Every screen, feature, and component composes from this system.
Inventing a local variant of anything defined here is a design-drift bug (P1).
Founder-approved 2026-07-22.

**Taste profile (founder-locked):**
- Accent: **indigo** — actions, selection, active states
- Density: **comfortable surfaces, compact data tables** (Stripe/Linear hybrid)
- Theme: **dark now, light-ready** — all color flows through CSS variables
- Target: **excellent at 1280px+, usable at 1024px**; no phone layouts

**The three files that ARE the system:**
| File | Role |
|---|---|
| `src/design/tokens.css` | The only allowed colors/surfaces — CSS variables |
| `src/design/primitives.tsx` | The approved component schemas |
| `tailwind.config.js` (`dt.*` colors) | Token access as utilities (`bg-dt-card`, `text-dt-support`…) |

---

## 1. Foundations

### Surfaces — exactly four
| Token | Use |
|---|---|
| `bg-dt-page` | The app canvas. Pages never repaint it another shade. |
| `bg-dt-panel` | A grouped region on the page; hover state of cards |
| `bg-dt-card` | Cards. Radius `rounded-xl`, border `border-dt-border` |
| `bg-dt-inset` | Wells inside cards: inputs, code, previews |

### Borders — two
`border-dt-border` (default hairline) · `border-dt-border-strong` (hover/emphasis).
Focus is always `ring-2 ring-dt-accent`, never a border color change.

### Text — five levels, contrast floors are law
| Token | Role | Rule |
|---|---|---|
| `text-dt-title` | Page & section titles | |
| `text-dt-body` | Primary reading text | |
| `text-dt-support` | Descriptions, subtitles | |
| `text-dt-muted` | Meta, timestamps, micro-labels | **Floor for readable copy** |
| `text-dt-faint` | Decoration only | **Never sentences** |

Micro-labels: `text-[10px] uppercase tracking-wide text-dt-muted`. Only two
bracket sizes exist: `text-[10px]` (micro-labels) and `text-[11px]` (chips/meta).

### Semantic colors — meaning is fixed everywhere
`ok` (emerald) = healthy/success/published · `warn` (amber) = needs a human/pending
· `danger` (rose) = failed/blocked/destructive · `info` (sky) = informational
· `neutral` (slate) = inactive/idle · `accent` (indigo) = selected/active/AI-action.
Each tone has one chip recipe, one banner recipe, one soft-bg recipe (tokens).
Never mix (e.g. emerald never means "selected"; indigo never means "success").

### Rhythm
- Page gutter: `px-6`; page top: `pt-8`; between sections: `space-y-6` / `gap-6`
- Card padding: `px-5 py-4` (header) + `px-5 pb-5` (body) — via `PanelCard`
- Tile padding: `px-4 py-3` · grids of tiles: `gap-3`
- Radii: `rounded-lg` controls · `rounded-xl` cards/rows · `rounded-2xl` modals
- Motion: `transition-colors` only. No slides, no bounces, no gratuitous motion.

---

### Layout — tokenised in v2 (`src/design/tokens.css` §layout)

v1 tokenised colour and nothing else, so every page invented its own widths and
gutters. Same file, same law, surfaced through `tailwind.config.js` the same way.

| Token | Utility | Value | Use |
|---|---|---|---|
| `--dt-sidebar` | `w-dt-sidebar` | 248px | Full navigation |
| `--dt-sidebar-rail` | `w-dt-sidebar-rail` | 56px | Collapsed, and the auto state below 1280 |
| `--dt-gutter` | `p-dt-gutter` | `clamp(20px,3vw,40px)` | Page gutter |
| `--dt-content-max` | `max-w-dt-content` | 1180px | Reading and mixed pages |
| `--dt-content-wide` | `max-w-dt-content-wide` | 1440px | Table-heavy pages |
| `--dt-gap` / `--dt-gap-tight` | `gap-dt` / `gap-dt-tight` | 16 / 10px | Grid and stack rhythm |
| `--dt-card-min` | `grid-cols-dt-cards` | 380px | `auto-fit` — drops a column on its own |
| `--dt-kpi-min` / `--dt-tile-min` | `grid-cols-dt-kpis` / `-tiles` | 220 / 96px | Same, for stat rows |
| `--dt-drawer` / `-wide` | `w-dt-drawer` | `min(560px,90vw)` | Drawer widths |
| `--dt-row-compact` / `-comfort` | `min-h-dt-row-*` | 38 / 56px | The density rule, below |
| `--dt-field-max` | `max-w-dt-field` | 420px | A field wider than this is harder to read |

⚠ These are **lengths, not colours** — per-tenant branding must never reach
them. A workspace picks an accent; it does not pick a sidebar width.

### Density is per-surface, not per-app

The most common mistake is picking one density for everything. Ask what the
person is doing on the surface, then pick:

- **Data surface — compact.** Scanning and comparing many rows: history tables,
  the audit trail, a roster past ~12 people. `min-h-dt-row-compact`, 14px text,
  12px labels.
- **Decision surface — comfortable.** Reading a few items and deciding: employee
  cards, the approval queue, conversation threads. 16–22px padding, 14–17px
  text, **one** clear action.

### Three breakpoints, fluid between

Six tiers across 55 pages is more surface than anyone verifies, and an
unverified breakpoint is a liability. `clamp()` and `auto-fit` cover the rest.

| Screen | Width | Behaviour |
|---|---|---|
| `dt-large` | ≥1600px | Content capped; extra space buys a secondary panel, never longer lines |
| `dt-target` | 1280–1599px | **The design target.** Every screen is drawn here |
| `dt-compact` | 1024–1279px | Sidebar auto-collapses to the rail; grids drop a column themselves |
| — | <1024px | Not a reflow. A scoped mobile surface, if and when it is decided |

### Status vocabulary (`src/design/statusVocabulary.ts`)

Database enums leak into the UI everywhere; `needs_human` is a column value, not
something to show an owner. One module translates, so a screen never invents its
own wording — **six pages had grown their own `STATUS_META` before this, and they
disagreed.** Colour meanings are unchanged; only the words are.

⚠ **Display only.** Never compare against a label, never store one. `say(DE_STATUS,
row.status).label`, never `if (x === 'Working')`.

⚠ Grounded in the **check constraints**, not in a design document. It carries all
twelve `lifecycle_status` values the column actually permits. `RETIRED_FROM_UI`
lists the words that stay in code and never reach a screen.

## 2. The schema catalog (`src/design/primitives.tsx`)

| Schema | Use it for | Never |
|---|---|---|
| `Button` — `primary/secondary/ghost/danger/ai` × `sm/md` | every button | hand-rolled `<button className=…>` |
| `Chip` (tone, dot, pulse) | every status/tag | local chip recipes |
| `PanelCard` | every titled section | bare bordered divs with h3s |
| `StatTile` | number at a glance | local StatCard clones (8 existed) |
| `DetailTile` | labeled fact (Employee File strip) | |
| `EntityRow` | roster/tasks/conversations rows | bespoke row layouts |
| `QueueCard` | anything awaiting a human decision | |
| `TimelineStep` | audit replays, case steps | |
| `EmptyState` | EVERY empty list — headline + why + next action | blank boxes, bare "No data" |
| `Banner` | notices | ad-hoc colored divs |
| `Field` + `INPUT_CLS` | every form control | unstyled inputs |
| `TabBar` | hub tabs, profile sub-tabs | local tab strips |
| `TH`/`TD` + `TableScroll` | data tables (compact density) | tables that widen the page |
| `Modal` / `Drawer` | overlays (8 local Modals existed) | new overlay variants |
| `PageHeaderV2` (+`InHubContextV2`) | page titles; hub demotion built in | |

**v2 — four more, and no more** (design handoff `00` §06):

| Schema | Use it for | Never |
|---|---|---|
| `EmployeeCard` | one digital employee, **reporting work** — state, three stats, last action *or* why it stopped | a card that lists its configuration |
| `DecisionCard` | one thing waiting on a human: what, who prepared it, why it stopped, how long, 2–3 real choices | `QueueCard` (superseded; nothing imported it) |
| `FilterBar` | every list and report — presets, facets, search, saved views | a bespoke filter row per page |
| `SetupChecklist` | "hired but unfinished" — what's missing, why, one button, an honest estimate | `EmptyState` (a half-built thing is not an empty one) |

⚠ `EmployeeCard` takes **already-translated words**, never an enum — see
`src/design/statusVocabulary.ts`. ⚠ `DecisionCard`'s `nudge` slot is what stops
the queue being a treadmill: it tells the owner how to stop seeing this class of
decision at all.

⚠ **No width variant props.** All four reflow on their own width using
`grid-cols-dt-*` auto-fit and wrapping rows, so the same card works in a page
grid, a narrow column and a drawer. The handoff asked for container queries;
Tailwind 3.4 here has no container-query plugin and adding a build dependency to
avoid `flex-wrap` was not worth it. If it ever lands, these become `@container`
without touching a call site.

A screen needing a genuinely new schema: add it HERE with a row in this table —
never inline. That's how the catalog grows without drifting.

### Seeing them — the schema gallery

`?dtpreview=1` on the dev server (`src/design/SchemaGallery.tsx`, **dev only** —
the branch is compiled out of production). Every schema on one page, no session
needed, which is the only way to check a new one at all three widths before it
reaches a real screen.

It paid for itself on its first run, catching three things invisible in source:
`--dt-card-min` at the handoff's 380px silently costing the third employee
column (1138px available, 1172 needed — corrected to 360), `Chip` rendering a
whole sentence at 11px, and an `EmployeeCard` stat label truncating to "closed
without…". **Add a section here when you add a schema.**

## 3. Page templates — every screen declares one
| Template | Shape | Scrolling |
|---|---|---|
| **Hub** | header + `TabBar` + tab content | flows in `<main>` |
| **List** | header + filters + `EntityRow`s | flows |
| **Profile** | identity card + `DetailTile` strip + sub-tabs | flows |
| **Floor** | fixed-viewport panes (Support inbox) | own `flex-1 flex-col overflow-hidden` root; panes scroll inside |
| **Wizard** | stepper + one decision per screen | flows |

**The scroll contract:** `<main>` is THE scroll region. Pages are natural-height
blocks. Only a Floor page opts out. A page that owns neither model is broken.

## 4. States are part of the design
Every data surface ships all four or it isn't done:
**loading** (skeleton, same silhouette as loaded) · **empty** (`EmptyState` with
a next action) · **error** (`Banner tone="danger"` + retry) · **loaded**.

## 5. The ship checklist — every UI change, no exceptions
1. Composes from primitives + `dt-*` tokens — no raw `slate-*`/hex/inline styles in new code
2. Scrolled screenshots — top AND bottom of page, not just the fold
3. Three widths: 1536 / 1280 / 1024 — nothing overflows the page sideways
4. All four states present
5. Semantic colors used by meaning, not by looks
6. `node scripts/design-drift.mjs` — counts must not go UP

## 6. Migration
- **New code:** system-only, from day one.
- **Touched code:** anything you edit for another reason gets converted in place.
- **The sweep:** pilot (Workforce + Support) → founder look → then all 55 pages in
  traffic order: Command Centre → Browser Operator → Knowledge → Governance →
  Playbooks → Connected systems → Setup → the rest. `ui.tsx` (`PageHeader`,
  `th`/`td`) is legacy-compat until the sweep replaces its call sites.
- **The drift detector** (`scripts/design-drift.mjs`) prints the variant counts;
  the numbers only go down. Baseline 2026-07-22: 34 bg-slate variants · 16
  border variants · 13 radii · 8 local StatCards · 8 local Modals · 85 inline
  styles · 19 raw hex.

## 7. Sanctioned exceptions + sweep record (2026-07-22)

The estate-wide token sweep is DONE (commits 5ceb9e6 → this one): every page and
shared component runs on `dt-*` tokens; `ui.tsx`, `StatCard.tsx`, and
`Modal.tsx` in `src/components/` are now thin ADAPTERS over the primitives —
legacy imports keep working, new code imports `src/design/primitives` directly.
Detector baselines are ratcheted to the post-sweep floor (8 bg-slate · 3
border-slate · 7 StatCard files · 8 Modal files); they only go down from there.

**Sanctioned raw-slate survivors** (do NOT convert; anything else is drift):
- **Control shades** — `slate-500`/`slate-600` (+alphas) on toggle knobs and
  tracks, placeholders (`placeholder-slate-500`), and focus rings. These are
  interaction affordances, not surfaces or text; they ride the navy remap and
  read correctly in both surface families. If a `dt-control` token lands later,
  convert them all in one scripted pass.
- ~~**EmbedWidget light-theme branch**~~ — REMOVED 2026-08-06 along with
  `src/components/EmbedWidget.tsx` and the `/embed` route (it called an RPC that
  was never created). The customer-facing widget is `public/widget.js`, which is
  outside the app's token system entirely and carries its own styles; the
  light-neutral exemption that used to be recorded here no longer applies to any
  file under `src/`.

**Hover/neutral vocabulary** (match the primitives, never invent):
secondary-button hover border = `hover:border-dt-muted`; neutral status chip =
`bg-dt-neutral-soft text-dt-neutral`; deep inset wells = `bg-dt-inset`;
punched-out rings on avatars/dots = `border-dt-page`.

## 8. Width verification — the 3-width procedure

Checklist §5 requires every shipped screen to hold at 1536 / 1280 / 1024. Run it
without touching the founder's window:

1. Open the page in the agent-driven Chrome tab.
2. `resize_window` (claude-in-chrome) to **1280×900** — the founder-profile
   floor for "excellent". Screenshot top AND bottom of the scroll.
3. Resize to **1024×800** — "usable": no horizontal scrollbar on `<main>`, no
   clipped action buttons, tables scroll inside `TableScroll` not the page.
4. Resize back to the original size when done (leave the session as found).
5. What breaks first is almost always a grid without a `min-w-0` child or a
   fixed-width sidebar — fix with `grid-cols-1 md:grid-cols-2 xl:grid-cols-N`
   ladders and `TableScroll`, never by shrinking text below `text-xs`.
