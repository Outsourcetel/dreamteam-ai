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

A screen needing a genuinely new schema: add it HERE with a row in this table —
never inline. That's how the catalog grows without drifting.

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
- **EmbedWidget light-theme branch** (`src/components/EmbedWidget.tsx`) — the
  chat widget renders on CUSTOMERS' websites, where `theme: 'light'` uses
  `bg-slate-100`/`border-slate-200` as the light neutral ramp on purpose. The
  app shell never renders this branch.

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
