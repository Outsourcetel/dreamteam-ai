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
| `TimelineStep` | audit replays, case steps | |
| `EmptyState` | EVERY empty list — headline + why + next action | blank boxes, bare "No data" |
| `Banner` | notices | ad-hoc colored divs |
| `Field` + `INPUT_CLS` | every form control | unstyled inputs |
| `SELECT_CLS` | a facet dropdown inside a `FilterBar` | a per-page select recipe |
| `Button size="touch"` | every control on the phone shell (`13`) — 52px, 16px text | `md` on a phone (~36px, under the 44px floor) |
| `TabBar` | hub tabs, profile sub-tabs | local tab strips |
| `TH`/`TD` + `TableScroll` | data tables (compact density) | tables that widen the page |
| `Modal` / `Drawer` | overlays (8 local Modals existed) | new overlay variants |
| `PageHeaderV2` (+`InHubContextV2`) | page titles; hub demotion built in | |

**v2 — four more, and no more** (design handoff `00` §06):

| Schema | Use it for | Never |
|---|---|---|
| `EmployeeCard` | one digital employee, **reporting work** — state, three stats, last action *or* why it stopped | a card that lists its configuration |
| `DecisionCard` | one thing waiting on a human: what, who prepared it, why it stopped, how long, 2–3 real choices | `QueueCard` — superseded, and DELETED from the kit 2026-08-21 after a reachability sweep found zero import sites and zero render sites |
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

## 7. Sanctioned exceptions + sweep record (2026-07-22 → 2026-08-21)

The estate-wide token sweep is DONE (commits 5ceb9e6 → this one): every page and
shared component runs on `dt-*` tokens; `ui.tsx`, `StatCard.tsx`, and
`Modal.tsx` in `src/components/` are now thin ADAPTERS over the primitives —
legacy imports keep working, new code imports `src/design/primitives` directly.
The Task-5 estate sweep (groups 1–8, closed 2026-08-21) drove all four
`audit-light-ready.mjs` metrics — bare `text-white`, `bg-slate-*`,
`border-slate-*`, `text-slate-*` — from a combined 216/28/6/2 to **zero**,
with every remaining raw hit either converted to a `dt-*` token or recorded
below as a named, script-excluded survivor. Nothing is silent baseline slack:
`node scripts/audit-light-ready.mjs --strict` reports 0/0/0/0 and any new hit
outside these rows is a real regression, not noise.

**Sanctioned raw-slate survivors** (do NOT convert; anything else is drift):
- **Control shades** — `slate-500`/`slate-600` (+alphas) on toggle knobs and
  tracks, placeholders (`placeholder-slate-500`), and focus rings. These are
  interaction affordances, not surfaces or text; they ride the navy remap and
  read correctly in both surface families. Toggle-track and status-chip
  *backgrounds* were converted in the Task-5 sweep (`bg-slate-500/600` →
  `bg-dt-border-strong`, or `bg-dt-neutral-soft` where the source was already
  translucent) — this exception is now narrowed to `focus:border-slate-500`/
  `600` and its paired `placeholder-slate-500`/`600`, which is genuinely load-
  bearing: `--dt-border-strong`'s light value (`#d0d5dd`) contrasts roughly
  1.4:1 against a white page — an all-but-invisible focus ring — while
  `slate-500` (`#64748b`) holds ~4.2:1 in both themes, because it does not
  ride the theme remap at all. Converting these would trade a correct
  fix for a real regression, so they stay literal until a `dt-control` token
  models focus-visible contrast explicitly. Exactly five lines, held by
  `scripts/audit-light-ready.mjs`'s `CONTROL_SHADE_FOCUS_RING` exclude:
  `AISessionPanel.tsx:242`, `GovernanceAIPanel.tsx:157`,
  `SecurityAccessPage.tsx:412`, `SecurityAccessPage.tsx:417`,
  `LivePlaybookBuilder.tsx:97` (all `focus:outline-none focus:border-slate-500`
  composer/input pairs). If a `dt-control` token lands later, convert them all
  in one scripted pass and delete the exclude.
- ~~**EmbedWidget light-theme branch**~~ — REMOVED 2026-08-06 along with
  `src/components/EmbedWidget.tsx` and the `/embed` route (it called an RPC that
  was never created). The customer-facing widget is `public/widget.js`, which is
  outside the app's token system entirely and carries its own styles; the
  light-neutral exemption that used to be recorded here no longer applies to any
  file under `src/`.

**Sanctioned bare-`text-white` survivors** (Task 5, group 8 — the audit's
`COLORED_BG` regex only recognizes literal `bg-<tailwind-color>-NNN` class
names; it cannot see a runtime `style={{backgroundColor: ...}}` or a
template-literal class like `` `${de.color}` ``, so these read as "bare" even
though the fill under them is a genuine, always-opaque solid color. Converting
any of these would be the wrong call under the mapping table's own "text-white
on a solid colored fill stays" rule — held by `scripts/audit-light-ready.mjs`'s
`SOLID_FILL_SURVIVORS` exclude list, one entry per line below):

| File : line | Fill | Reason |
|---|---|---|
| `EndUserChatPage.tsx` :321,363,385,433,460,533,635 | `style={{backgroundColor: brandColor \| accentColor}}` (one branch also uses a literal `#64748b` for `role==='system'`) | Portal chat header/avatar/composer/send-button and the customer's own outgoing bubble — brand-color fill, always opaque |
| `DEChatDock.tsx` :487,571,590,678,745,768 | `` className={`... ${de.color} ...`} `` | Per-DE avatar circles; `de.color` is always one of the file's own fixed `bg-{indigo,violet,sky,teal}-600` literals (never translucent) |
| `SettingsPage.tsx` :444,550,737,848,916,935 | `style={{backgroundColor: accentColor}}` | Active settings-nav tab + every primary Save/Copy/Generate button on the page |
| `UserManagementPage.tsx` :165,240,286,486 | `style={{backgroundColor: accentColor}}` | Invite-modal submit, "+ Invite Member", active status-filter pill, "Open Organisation" |
| `CommsSettingsCard.tsx` :53 | `style={{backgroundColor: accentColor}}` | Save button |
| `PageTabs.tsx` :27 | `style={page === t.id ? {backgroundColor: accentColor \|\| DEFAULT_ACCENT} : {}}` | Shared portal tab-bar primitive's active state (the inactive branch's `hover:text-white` was a real hazard and WAS converted to `hover:text-dt-body`) |
| `Sidebar.tsx` :320 | `style={{background: activeCompany.badgeColor}}` | Collapsed-sidebar company badge |
| `LoginPage.tsx` :146,148,152,167 | `style={{background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)'}}` on the `leftPanel` | Desktop-only (`hidden lg:flex`) marketing hero — a fixed dark-navy gradient that does not participate in the light/dark theme at all, so `text-white` is correct in both app themes |

**Sanctioned tone-tint text survivors** (Task 5T, Group A — employee/DE/ops;
the first real survivor the fifth `tone text-300` metric's estate conversion
found. Held by `scripts/audit-light-ready.mjs`'s `TONE_FILL_SURVIVORS`
exclude list):

| File : line | Fill | Reason |
|---|---|---|
| `DEChatDock.tsx` — the chat-bubble timestamp row (`msg.role === 'user' ? 'text-indigo-200' : 'text-dt-muted'`) | `bg-indigo-600` (a separate ternary a few lines up, same message row) | Both ternaries key off the same `msg.role === 'user'` check, so the timestamp only ever renders inside the bubble its own role paints — but `COLORED_BG` only looks within one physical line, so it cannot see the opaque fill one element up. `text-indigo-200` on an opaque same-family fill is the mapping table's own "leave it" case; converting only the text half to a `dt-*` token would swap in a light-theme-tuned value against the still-literal, non-theme-reactive `bg-indigo-600`, which is a real regression the original all-literal pairing did not have. |

**Sanctioned kept-hue identity badges** (Task 5T, Group A — employee/DE/ops;
non-semantic category/meta tags, not one of the five core semantics
(warn/ok/danger/info/accent), so per the mapping table's "deliberate
non-semantic identity" rule they keep their hue rather than being reassigned
to a semantic token. Made opaque so they read correctly in both themes and
are exempt via `COLORED_BG` — the `bg-{hue}-600 text-{hue}-100` recipe already
sanctioned by the mapping table's "tint on an opaque same-family fill"
exemption):

| Tag | Recipe | Where |
|---|---|---|
| `control fabric` / `evidence-assessed` / `real metrics` / `governed, single-hop` / `default-deny` / `measured live` / `your baselines, never estimated` | `bg-teal-600 text-teal-100` | `EmployeeFileSections.tsx`, 7 section-header identity tags (was `bg-teal-500/15 text-teal-300`) |
| `checklist` type badge (Human Tasks) | `bg-teal-600 text-teal-100` | `HumanTasksPage.tsx` `taskBadgeStyle` |
| `AI-written` / `derived from this employee's actual work` | `bg-violet-600 text-violet-100` | `EmployeeFileSections.tsx`, provenance tags (was `bg-violet-500/15 text-violet-300`) |
| `action_approval` type badge (Human Tasks) | `bg-fuchsia-600 text-fuchsia-100` | `HumanTasksPage.tsx` `taskBadgeStyle` |
| `SIMULATION — not a real item` | `bg-purple-600 text-purple-100 border border-purple-500` | `DEActivityPage.tsx` — a meta/provenance flag distinct from every real ok/warn/danger status on the same row |

**Hover/neutral vocabulary** (match the primitives, never invent):
secondary-button hover border = `hover:border-dt-muted`; neutral status chip =
`bg-dt-neutral-soft text-dt-neutral`; deep inset wells = `bg-dt-inset`;
punched-out rings on avatars/dots = `border-dt-page`; ghost-button/icon hover =
`hover:text-dt-body`; a colored link/button brightens within its own tone
family on hover (`text-teal-300 hover:text-teal-100`, `text-amber-500
hover:text-amber-300`) — never jump to a neutral or white hover state.

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
