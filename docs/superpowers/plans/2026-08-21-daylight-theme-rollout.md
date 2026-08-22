# Daylight Theme Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the founder-chosen "Daylight" light theme (white surfaces, cobalt accent, Instrument Sans) as a complete second token set for the entire app, choosable per workspace through the existing branding system, and then flipped to the platform default — leaving the theme machinery ready for a later "Command Deck / Operator mode" third theme with a one-click switch.

**Architecture:** Every color in the app already resolves to `--dt-*` CSS variables (`src/design/tokens.css`), and per-tenant branding already swaps those variables at runtime (`src/design/branding.ts`, mig 247). Daylight is a full second value-set for the same variables, activated by a `light` class on `<html>` (the slot tokens.css has reserved since v1). The theme rides the existing **surface family** concept: `daylight` becomes a third curated family next to `midnight` and `graphite`, so the workspace-level "one click" is the branding card that already exists. The estate work is exposing and fixing every place that bypasses the tokens (711 `text-white` lines in 85 files, 67 `bg-slate-*` lines in 33 files measured 2026-08-21) — invisible on dark, broken on white.

**Tech Stack:** React + TypeScript + Vite + Tailwind (tokens via CSS custom properties), Supabase (Postgres migration for the branding constraint), `@fontsource-variable/instrument-sans` for the typeface.

**Design reference:** The approved look is Option A on the "DreamTeam Design Directions" canvas (artifact `83f39fe2-a5dd-41e2-9cf2-4d8aec686149`), artboards `Daylight` (Workforce) and `SupportDaylight` (Support inbox). Exact palette values are restated in Task 1 — the canvas is the visual court of appeal, this plan is the value source.

## Global Constraints

- `docs/design-system.md` is law — read it before any UI change. New/touched code uses primitives + `dt-*` tokens only.
- `node scripts/design-drift.mjs` must pass (no metric above its floor, every improvement pinned in the same commit) before every UI-touching commit.
- Verification per ship checklist: schema gallery + real pages, at 1536/1280/1024 widths, all four states (loading/empty/error/loaded), scrolled screenshots top AND bottom — in BOTH themes once Task 1 lands.
- Migrations: number ONLY via `npm run migrate:next -- <slug>`; commit AND push to `origin/main` before applying (`scripts/db-query.mjs` enforces both); assertions state the absence of a violation, never the presence of an example; `npm run audit:replayable` must pass.
- Applying the migration to production is a state-changing action: **stop and get the founder's go-ahead first** (standing approval is revoked).
- Never hardcode a color in new code — not slate, not hex, not `text-white`. Semantic colors by meaning: emerald=success, amber=needs-human, rose=failed/destructive, sky=info, accent=selected/active/AI.
- Scope: Daylight only. The Command Deck theme and the per-user Operator toggle are explicitly OUT of this plan (Task 1's infrastructure is what will make them cheap later).
- TypeScript must stay clean: `npx tsc --noEmit` passes after every task.

---

### Task 1: Light token set + theme plumbing

The complete Daylight value-set for every existing token, activated by the `light` class on `<html>` that `tokens.css` already reserves. Also: theme-aware scrollbars (currently hardcoded slate hex) and a dev-only way to see the light theme before anything else exists.

**Files:**
- Modify: `src/design/tokens.css` (the `:root.light` block at the bottom, currently lines 91–98)
- Modify: `src/style.css:7-19` (scrollbar colors → tokens)
- Modify: `src/main.tsx:39` area (theme class bootstrapping before render)

**Interfaces:**
- Produces: `:root.light` carrying a complete `--dt-*` value set; localStorage key `dt.surface` (values `'midnight' | 'graphite' | 'daylight'`) read at boot; dev URL override `?theme=light` / `?theme=dark`. Task 6's `applyBranding` writes `dt.surface` and toggles the same `light` class.

- [ ] **Step 1: Replace the reserved `:root.light` stub in `src/design/tokens.css` with the full Daylight set**

Replace the existing block (comment + `color-scheme: light;` only) with:

```css
/* ═══ DAYLIGHT — the light theme (founder-approved 2026-08-21). Same token
   names, second value set. Activated by class `light` on <html>; per-tenant
   branding still overrides accent vars on top via inline style. ═══ */
:root.light {
  /* Browser-painted surfaces flip with the theme (mirror of D-13). */
  color-scheme: light;

  /* ── Surfaces ── */
  --dt-page:    #f4f5f7;
  --dt-panel:   #ffffff;
  --dt-card:    #ffffff;
  --dt-inset:   #f2f4f7;

  /* ── Borders ── */
  --dt-border:        #e4e7ec;
  --dt-border-strong: #d0d5dd;

  /* ── Text (same five levels; dt-muted stays the floor for copy) ── */
  --dt-text-title:   #101828;
  --dt-text-body:    #1d2939;
  --dt-text-support: #475467;
  --dt-text-muted:   #667085;
  --dt-text-faint:   #98a2b3;

  /* ── Accent (Daylight cobalt; tenant-brandable at runtime) ── */
  --dt-accent:        #155eef;
  --dt-accent-strong: #1146d4;
  --dt-accent-hover:  #155eef;
  --dt-accent-soft:   #155eef14;
  --dt-accent-text:   #1146d4;

  /* ── Semantics (solid pastels — alpha washes vanish on white) ── */
  --dt-ok:        #067647; --dt-ok-soft:     #e8f5ee; --dt-ok-border:     #b7dfc8;
  --dt-warn:      #b54708; --dt-warn-soft:   #fdf3e0; --dt-warn-border:   #f5d698;
  --dt-danger:    #b42318; --dt-danger-soft: #fdecea; --dt-danger-border: #f4b3ae;
  --dt-info:      #0b6bab; --dt-info-soft:   #e7f3fb; --dt-info-border:   #b3d9f0;
  --dt-neutral:   #475467; --dt-neutral-soft:#f2f4f7; --dt-neutral-border:#e0e3e9;
}
```

Layout tokens are lengths and deliberately have no light variant.

- [ ] **Step 2: Make the global scrollbars theme-aware in `src/style.css`**

Replace the two hardcoded slate values inside the existing `@layer base` block:

```css
@layer base {
  * {
    scrollbar-width: thin;                                  /* Firefox */
    scrollbar-color: var(--dt-border-strong) transparent;
  }
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: var(--dt-border-strong); border-radius: 8px; }
  *::-webkit-scrollbar-thumb:hover { background: var(--dt-text-faint); }
  *::-webkit-scrollbar-corner { background: transparent; }
}
```

(Dark resolves to `#414b6e`/`#5b678d` — close to today's `#334155`/`#475569`; light resolves to `#d0d5dd`/`#98a2b3`.)

- [ ] **Step 3: Bootstrap the theme class in `src/main.tsx` before render**

Insert directly below `initSentry();`:

```tsx
// Theme bootstrapping. The class must be on <html> BEFORE first paint or the
// app flashes the wrong theme. Order of authority: dev URL override → the
// last surface family branding applied (cached by applyBranding in
// src/design/branding.ts) → dark default (flips to light in the
// default-flip task, after the estate is verified).
const LIGHT_SURFACES = new Set(['daylight']);
{
  const urlTheme = new URLSearchParams(window.location.search).get('theme');
  // Guarded like every other storage call in this codebase: a throw here
  // (sandboxed embed, storage disabled) runs before the error boundary
  // exists and would blank the whole app.
  let cached: string | null = null;
  try { cached = localStorage.getItem('dt.surface'); } catch { /* boot on the default */ }
  const light = urlTheme ? urlTheme === 'light' : (cached ? LIGHT_SURFACES.has(cached) : false);
  document.documentElement.classList.toggle('light', light);
}
```

The `?theme=` override is deliberately not DEV-gated: it changes nothing for anyone who doesn't type it, and it is the verification vehicle on preview deploys too.

- [ ] **Step 4: Verify both themes in the schema gallery**

Run the dev server (`.claude/launch.json` config), then open `/?dtpreview=1&theme=light` and `/?dtpreview=1&theme=dark`. Expected: every primitive (Button kinds, Chip tones, PanelCard, StatTile, EntityRow, EmptyState, Banner, Field, TabBar, table, Modal, Drawer) renders legibly in both; no white-on-white or navy-on-navy anywhere in the gallery. Take screenshots of both.

- [ ] **Step 5: Run the guards**

Run: `npx tsc --noEmit` — expected: clean.
Run: `node scripts/design-drift.mjs` — expected: `✓ no drift regressions` (this task adds zero component code).

- [ ] **Step 6: Commit**

```bash
git add src/design/tokens.css src/style.css src/main.tsx
git commit -m "feat(theme): Daylight light token set, theme-aware scrollbars, boot-time theme class"
```

---

### Task 2: Instrument Sans, behind a font token

Daylight's typeface, self-hosted (no runtime Google Fonts dependency), riding a new `--dt-font-sans` variable so the face flips with the theme — and so a later theme can bring its own face the same way. Note: today `Inter` is first in the Tailwind stack but nothing ever loads it, so dark currently renders in Segoe UI on Windows; this task does not change dark's stack, only tokenizes it.

**Files:**
- Modify: `package.json` (+ lockfile) — add `@fontsource-variable/instrument-sans`
- Modify: `src/main.tsx` (font import)
- Modify: `src/design/tokens.css` (font token in both blocks)
- Modify: `tailwind.config.js:6-19` (fontFamily → var)

**Interfaces:**
- Produces: `--dt-font-sans` defined on `:root` and `:root.light`; Tailwind `font-sans` resolves through it. Later themes add their value in their own block, nothing else changes.

- [ ] **Step 1: Install the font**

Run: `npm install @fontsource-variable/instrument-sans`
Expected: added to `dependencies`. If the package cannot be resolved, stop and report — do not substitute a CDN link.

- [ ] **Step 2: Import it in `src/main.tsx`**

Add below the `./style.css` import:

```tsx
import '@fontsource-variable/instrument-sans';
```

(Unconditional import: the woff2 loads either way; only the `light` block references the family, so dark pays one cached asset and zero layout change.)

- [ ] **Step 3: Add the font token to both blocks in `src/design/tokens.css`**

In `:root` (dark, next to the surface tokens):

```css
  --dt-font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
                  "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
```

In `:root.light`:

```css
  --dt-font-sans: "Instrument Sans Variable", ui-sans-serif, system-ui, -apple-system,
                  BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
```

- [ ] **Step 4: Point Tailwind's `sans` at the token in `tailwind.config.js`**

Replace the `fontFamily` block:

```js
      fontFamily: {
        sans: ['var(--dt-font-sans)'],
      },
```

- [ ] **Step 5: Verify**

Dev server → `/?dtpreview=1&theme=light`: gallery text renders in Instrument Sans (compare the double-story "a" and the "R" leg against Segoe UI; or check computed `font-family` on `<body>` via devtools). `/?dtpreview=1&theme=dark`: unchanged from before this task.
Run: `npx tsc --noEmit` and `node scripts/design-drift.mjs` — both clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main.tsx src/design/tokens.css tailwind.config.js
git commit -m "feat(theme): Instrument Sans for Daylight via --dt-font-sans token"
```

---

### Task 3: Light-readiness audit script

The measured worklist for the estate sweep, in the same spirit as `scripts/design-drift.mjs`: counts that only go down. It classifies `text-white` by whether the line also paints a colored background (on a solid colored fill, `text-white` is correct in both themes; as content color on a card it disappears on white).

**Files:**
- Create: `scripts/audit-light-ready.mjs`
- Modify: `package.json` (scripts: `"audit:light-ready": "node scripts/audit-light-ready.mjs"`)

**Interfaces:**
- Produces: `npm run audit:light-ready` printing per-metric counts + per-file listing; exit 1 in `--strict` mode when any metric exceeds its pinned baseline. Task 5 drives its numbers down and ratchets the baselines; the flip task (7) requires `bare text-white` and `bg-slate` to be 0.

- [ ] **Step 1: Write `scripts/audit-light-ready.mjs`**

```js
#!/usr/bin/env node
// Light-readiness audit — what still assumes a dark page under it.
// Same contract as design-drift.mjs: counts only go DOWN; --strict exits 1
// on any regression above the pinned baseline. Run with --files to see the
// per-file worklist.
import { execSync } from 'node:child_process';

const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', shell: 'bash' }).trim(); } catch { return ''; } };
const G = `src/ --include='*.tsx' --include='*.ts' --exclude-dir=design`;
const NO_COMMENTS = `| grep -v '^[[:space:]]*\\(//\\|\\*\\)'`;

// text-white beside a solid colored fill is CORRECT in both themes; the
// defect is text-white carrying content color on a token surface.
// Only an OPAQUE colored fill legitimizes text-white. A translucent tint
// (bg-indigo-500/10) is effectively the surface underneath — white text on it
// is a real light-theme hazard, so the shade must NOT carry a /NN opacity
// suffix. (?![\d/]) also stops bg-indigo-500/10 half-matching as bg-indigo-50.
const COLORED_BG = 'bg-((?:indigo|rose|emerald|sky|amber|violet|purple|blue|green|red|teal|cyan|orange|fuchsia|pink)-\\d+(?![\\d/])|dt-accent-strong|dt-accent-hover|gradient)';

const lines = (pat) => sh(`grep -rn "${pat}" ${G} ${NO_COMMENTS}`).split('\n').filter(Boolean);
const bareWhite = lines('text-white').filter(l => !new RegExp(COLORED_BG).test(l));
const slateBg = lines('bg-slate-');
const slateBorder = lines('border-slate-');
const slateText = lines('text-slate-');

// Baselines pinned 2026-08-21 (first measurement). Tighten in the SAME
// commit that lowers a number — design-drift.mjs enforces its own version
// of this rule for exactly the reason recorded there.
const BASELINE = { 'bare text-white': 452, 'bg-slate': 67, 'border-slate': 6, 'text-slate': 3 };
const NOW = {
  'bare text-white': bareWhite.length,
  'bg-slate': slateBg.length,
  'border-slate': slateBorder.length,
  'text-slate': slateText.length,
};

const strict = process.argv.includes('--strict');
const showFiles = process.argv.includes('--files');
let regressions = 0;
console.log('── Light readiness (must only go DOWN) ───────────────────────');
for (const k of Object.keys(BASELINE)) {
  const b = BASELINE[k], n = NOW[k];
  const mark = n > b ? '▲ REGRESSION' : n < b ? '▼ improved (pin it!)' : '· unchanged';
  if (n > b) regressions++;
  console.log(`${k.padEnd(20)} baseline ${String(b).padStart(4)} → now ${String(n).padStart(4)}  ${mark}`);
}
if (showFiles) {
  console.log('\n── bare text-white worklist ──');
  const perFile = {};
  for (const l of bareWhite) { const f = l.split(':')[0]; perFile[f] = (perFile[f] ?? 0) + 1; }
  Object.entries(perFile).sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`${String(n).padStart(4)}  ${f}`));
}
if (strict && regressions) { console.log(`✗ ${regressions} metric(s) regressed`); process.exit(1); }
console.log(regressions ? '▲ regressions present (non-strict run)' : '✓ within baseline');
```

- [ ] **Step 2: Calibrate the baseline honestly**

Run: `node scripts/audit-light-ready.mjs`
The pinned numbers above are estimates from a 2026-08-21 measurement (711 total text-white; ~452 assumed bare). Replace the four `BASELINE` values with the ACTUAL printed `now` numbers, in this same change — a baseline above reality is slack, below reality is a false alarm.

- [ ] **Step 3: Prove the checker can fail**

Add `<span className="text-white">x</span>` to any page component, run `node scripts/audit-light-ready.mjs --strict`, expected: exit 1 with `bare text-white … ▲ REGRESSION`. Revert the span, run again, expected: exit 0. (A checker that has never failed is theatre.)

- [ ] **Step 4: Register the npm script and commit**

Add to `package.json` scripts: `"audit:light-ready": "node scripts/audit-light-ready.mjs"`.

```bash
git add scripts/audit-light-ready.mjs package.json
git commit -m "feat(theme): light-readiness audit with ratcheted baselines"
```

---

### Task 4: Pilot pages verified light — primitives, shell, boot screens

Before converting the estate wholesale, prove Daylight on the flagship screens and fix everything the token swap alone doesn't cover in the shared layer: the app shell, the Sidebar, the crash screen, and any primitive that misbehaves on white.

**Files:**
- Modify: `src/main.tsx:9-26` (CrashFallback hardcodes `text-white`, `text-slate-400`, `bg-indigo-600`)
- Modify: `src/design/primitives.tsx` (only if the gallery check in Task 1 Step 4 surfaced defects — fix in place, tokens only)
- Modify: `src/components/Sidebar.tsx` (only where the light run shows breakage; it is already on dt tokens)

**Interfaces:**
- Consumes: `:root.light` (Task 1), `--dt-font-sans` (Task 2).
- Produces: Workforce hub + Support inbox + Command Centre certified in both themes — the reference screens for judging every later conversion.

- [ ] **Step 1: Fix CrashFallback in `src/main.tsx`**

```tsx
function CrashFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-dt-page p-6">
      <div className="max-w-sm text-center">
        <p className="text-lg font-semibold text-dt-title mb-2">Something went wrong</p>
        <p className="text-sm text-dt-support mb-4">
          This error has been reported. Try reloading the page — if it keeps happening, contact support.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-dt-accent-strong hover:bg-dt-accent-hover transition-colors"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
```

(`text-white` on the button stays — it sits on a solid accent fill, correct in both themes.)

- [ ] **Step 2: Walk the pilot pages in light**

Dev server with `?theme=light`, signed into the dev workspace. Pages, in order: `/` (Command Centre), Workforce hub (all five tabs), Support inbox (all four tabs, one conversation open with a pending draft if the seed has one), the login/boot screen (sign out to see it). At 1536, 1280 and 1024 wide; loading, empty, error and loaded states where reachable; scrolled to top AND bottom. Record every defect as `file → symptom` in a working list. Typical expected finds: white text on white, navy `bg-slate-800` panels, alpha-wash chips too faint, borders vanishing.

- [ ] **Step 3: Fix what Step 2 found — tokens only**

Every fix replaces a hardcoded color with the semantically correct `dt-*` class (title/body/support/muted for text; page/panel/card/inset for surfaces; semantic tones by meaning). No new hex, no new slate, no conditional "if light" styling in components — if a component needs theme-conditional logic, the token set is wrong; fix the token instead.

- [ ] **Step 4: Re-verify and guard**

Repeat Step 2's walk until clean in BOTH themes (dark must not regress — same walk with `?theme=dark`).
Run: `npx tsc --noEmit`, `node scripts/design-drift.mjs`, `node scripts/audit-light-ready.mjs --strict` — all clean (ratchet any improved audit numbers in this commit).

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "fix(theme): pilot screens (Command Centre, Workforce, Support) verified in Daylight"
```

---

### Task 4b: Make the alpha-modifier dt classes real — `--dt-accent-border`

Confirmed from a production build (2026-08-21, dist CSS grep): **zero** CSS rules are emitted for any `dt-*/NN` class — `tailwind.config.js` wires dt colors as plain `var()` strings, which do not support Tailwind alpha modifiers. So `border-dt-accent/30` (Chip accent tone), `border-dt-accent/40` (EntityRow selected, Button kind `ai`) and every other `/NN` usage have never rendered, in either theme. Pre-existing on `main`; fixed here because both themes need the borders visible. The fix follows the system's own shape — every semantic tone already has a `-border` token; accent gets one too. No relative-color syntax, no browser-floor change.

**Files:**
- Modify: `src/design/tokens.css` (accent-border token in `:root`, `:root.light`, and `.dt-force-dark`)
- Modify: `tailwind.config.js` (one line in the `dt` block)
- Modify: `src/design/primitives.tsx` + every `/NN` call site the grep finds

**Interfaces:**
- Produces: `--dt-accent-border` + Tailwind `border-dt-accent-border`; zero `dt-*/NN` classes remain in `src/`. Task 6's `applyBranding` derives this token at runtime (its step already amended).

- [ ] **Step 1: Add the token to all three blocks in `src/design/tokens.css`**

`:root`: `--dt-accent-border: #6366f14d;` (indigo-500/30 — the value `border-dt-accent/30` always MEANT). `:root.light`: `--dt-accent-border: #155eef4d;`. `.dt-force-dark`: the dark value again.

- [ ] **Step 2: Register it in `tailwind.config.js`** — in the `dt` color block, next to `'accent-soft'`: `'accent-border': 'var(--dt-accent-border)',`

- [ ] **Step 3: Enumerate and convert every `/NN` dt usage**

Run: `grep -rnE "(bg|border|text|ring|divide|outline|shadow|decoration|from|to|via)-dt-[a-z-]+/[0-9]+" src/ --include='*.tsx'`
Convert by role: `border-dt-accent/30` and `border-dt-accent/40` → `border-dt-accent-border`; `bg-dt-accent/NN` → `bg-dt-accent-soft`; `hover:border-dt-accent` stays (no modifier). Any usage that maps to neither: convert by the tone's meaning and list it explicitly in the report. After conversion the grep returns zero lines.

- [ ] **Step 4: Prove the rules now exist**

Run: `npm run build`, then `grep -c "dt-accent-border" dist/assets/*.css` — expected ≥ 1. Gallery probe (`?dtpreview=1`, both themes): Chip accent tone and EntityRow selected show a computed `borderColor` that is NOT transparent/currentcolor-fallback, in both themes.

- [ ] **Step 5: Guards, ratchet, commit**

`npx tsc --noEmit` · `node scripts/design-drift.mjs` · `node scripts/audit-light-ready.mjs --strict` — clean, floors ratcheted if improved.

```bash
git add -A src/ tailwind.config.js
git commit -m "fix(design): dt alpha-modifier classes never emitted CSS — accent gets a real border token"
```

---

### Task 5: Estate sweep — retire the dark-only classes

The bulk of the work: drive `bare text-white` and the slate remnants toward zero across the remaining pages, using the same scripted-conversion playbook as the 2026-07-22 sweep (commits b883129/a445f7b), then verify page-by-page. Expect several sessions; the audit script is the progress meter and the ratchet.

**Files:**
- Modify: broad — the ~85 files `npm run audit:light-ready -- --files` lists (worklist order: highest count first, but convert whole route-groups together so a page is never half-converted)
- Modify: `scripts/audit-light-ready.mjs` (`BASELINE` ratchets down in every conversion commit)

**Interfaces:**
- Consumes: the audit worklist (Task 3), the certified pilot screens as the visual reference (Task 4).
- Produces: `bare text-white`, `bg-slate`, `border-slate`, `text-slate` at 0 (or an explicitly documented sanctioned remainder — see Step 4), which is Task 7's precondition.

- [ ] **Step 1: Mechanical pass, one route-group at a time**

For each group (sweep order: Knowledge → Governance → Playbooks → Connected systems → Setup → remaining), apply the mapping — `sed` per file, then eyeball the diff before staging:

| From | To | Condition |
|---|---|---|
| `text-white` | `text-dt-title` | line has NO solid colored bg (audit's COLORED_BG regex) |
| `text-white` | keep | line paints a solid colored fill |
| `bg-slate-900\|950` | `bg-dt-page` | page-level ground |
| `bg-slate-800/40\|800` | `bg-dt-card` or `bg-dt-panel` | card vs grouped region — judge from markup |
| `bg-slate-900/60` | `bg-dt-inset` | wells inside cards |
| `border-slate-700\|800` | `border-dt-border` | default hairline |
| `border-slate-600` | `border-dt-border-strong` | hover/emphasis |
| `text-slate-*` | nearest text level (`dt-body`/`dt-support`/`dt-muted`) | by role, not by shade |
| `bg-slate-500\|600` (control shades, doc §7) | `bg-dt-border-strong` | toggle tracks etc. — check hover pairs |

- [ ] **Step 2: Verify each group in both themes before moving on**

Same walk protocol as Task 4 Step 2, scoped to the group's pages. A group is done when its pages are clean in light AND unchanged in dark.

- [ ] **Step 3: Ratchet in every conversion commit**

Run: `node scripts/audit-light-ready.mjs` — copy the improved numbers into `BASELINE` in the same commit.
Run: `node scripts/design-drift.mjs` — the slate metrics will improve; pin those floors too (it exits 1 until you do).

```bash
git add -A src/ scripts/audit-light-ready.mjs scripts/design-drift.mjs
git commit -m "fix(theme): <group> converted to tokens, light-verified; ratchets pinned"
```

- [ ] **Step 4: Close the sweep with an honest remainder**

If anything legitimately keeps a literal color (the doc §7 precedent: `EmbedWidget`'s light-branch is customer-site context), list each survivor in `docs/design-system.md` §7 with its reason, and encode the exemption in the audit script's grep (an `--exclude` for that file) rather than leaving permanent slack in the baseline. Target state: all four audit metrics at 0.

---

### Task 6: `daylight` as a surface family — the workspace-level switch

The branding system becomes the theme switch: a third curated surface tile on the Company Setup card, live-previewing instantly, saved per workspace. This is the founder's "one click" — and the same mechanism a Command Deck family plugs into later. **The apply-to-production step requires the founder's explicit go-ahead.**

**Files:**
- Create: `supabase/migrations/NNN_daylight_surface_family.sql` (NNN from `npm run migrate:next`)
- Modify: `src/design/branding.ts`
- Modify: `src/design/BrandingCard.tsx:10-13`

**Interfaces:**
- Consumes: `LIGHT_SURFACES` boot logic + `dt.surface` cache key (Task 1 — the literal set lives in main.tsx and is duplicated knowingly in branding.ts; keep the two lists identical).
- Produces: `surface_key` value `'daylight'` accepted by DB + RPC; `applyBranding` toggling the `light` root class and caching `dt.surface`; a third `SURFACES` tile in the card.

- [ ] **Step 1: Claim the migration number**

Run: `npm run migrate:next -- daylight_surface_family`
This claims the number on production and creates the file — never pick a number by hand.

- [ ] **Step 2: Write the migration**

```sql
-- Daylight joins the curated surface families (Design System: Daylight theme
-- rollout, plan 2026-08-21). Guardrail unchanged: curated keys, never
-- free-form.

ALTER TABLE public.tenant_branding
  DROP CONSTRAINT IF EXISTS tenant_branding_surface_key_check;
ALTER TABLE public.tenant_branding
  ADD CONSTRAINT tenant_branding_surface_key_check
  CHECK (surface_key IN ('midnight', 'graphite', 'daylight'));

CREATE OR REPLACE FUNCTION public.set_tenant_branding(p_accent_hex text, p_surface_key text DEFAULT 'midnight')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
-- Body identical to mig 247 except the widened validation list. Copy the
-- current body from: select prosrc from pg_proc where proname='set_tenant_branding';
-- and change only:  IF p_surface_key NOT IN ('midnight','graphite','daylight') THEN
$$;
-- CREATE OR REPLACE preserves the function's existing ACLs (mig 247 + the
-- default-EXECUTE hygiene of migs 610/630) — do not re-grant here.

DO $$
BEGIN
  -- Absence of a violation, never presence of an example (replayable on empty).
  IF EXISTS (SELECT 1 FROM public.tenant_branding
             WHERE surface_key NOT IN ('midnight','graphite','daylight')) THEN
    RAISE EXCEPTION 'tenant_branding holds a surface_key outside the curated set';
  END IF;
  -- Schema assertion: the constraint really carries all three keys.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tenant_branding_surface_key_check'
                   AND pg_get_constraintdef(oid) LIKE '%daylight%') THEN
    RAISE EXCEPTION 'surface_key CHECK does not include daylight';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
```

Before finalizing: fetch the real current `set_tenant_branding` body (`node scripts/db-query.mjs "select prosrc from pg_proc where proname='set_tenant_branding'"`) and inline it verbatim with only the validation list changed — the `$$` sketch above is a placeholder for THAT step inside this task, not for the executor to invent a body.

- [ ] **Step 3: Prove replayability, commit, push — then STOP for founder go-ahead**

Run: `npm run audit:replayable` — passes.

```bash
git add supabase/migrations/*_daylight_surface_family.sql
git commit -m "feat(theme): daylight surface family — constraint + RPC widened"
git push origin main
```

**Checkpoint:** production apply is state-changing — present the migration to the founder and wait for an explicit yes. Then: `node scripts/db-query.mjs --apply supabase/migrations/NNN_daylight_surface_family.sql` (it verifies committed + on-main itself). After DDL: confirm with a WRITE (`select set_tenant_branding(null, 'daylight')` against a dev tenant), not a HEAD probe.

- [ ] **Step 4: Teach `src/design/branding.ts` about light families**

```ts
export interface TenantBranding { accent_hex: string | null; surface_key: 'midnight' | 'graphite' | 'daylight' }

const SURFACES: Record<string, Record<string, string>> = {
  midnight: {}, // tokens.css :root defaults
  daylight: {}, // tokens.css :root.light defaults — the class carries it
  graphite: {
    '--dt-page': '#0a0a0c', '--dt-panel': '#17171c66', '--dt-card': '#17171c66',
    '--dt-inset': '#0a0a0c99', '--dt-border': '#2c2c3499', '--dt-border-strong': '#3f3f4a',
  },
};
// Must stay identical to LIGHT_SURFACES in src/main.tsx (boot-time copy).
const LIGHT_SURFACES = new Set(['daylight']);
```

In `applyBranding`, after the reset block:

```ts
  const key = b?.surface_key ?? 'midnight';
  document.documentElement.classList.toggle('light', LIGHT_SURFACES.has(key));
  try { localStorage.setItem('dt.surface', key); } catch { /* cosmetic */ }
  if (!b) return;
```

And make the accent-text derivation theme-aware (readable on white means darker, not lighter):

```ts
    root.style.setProperty('--dt-accent-text', LIGHT_SURFACES.has(key) ? mix(a, 0, 0.25) : mix(a, 255, 0.45));
    root.style.setProperty('--dt-accent-border', a + '4d');
```

- [ ] **Step 5: Add the tile to `src/design/BrandingCard.tsx`**

```ts
const SURFACES: { key: TenantBranding['surface_key']; label: string; swatch: string }[] = [
  { key: 'daylight', label: 'Daylight', swatch: '#f4f5f7' },
  { key: 'midnight', label: 'Midnight Navy', swatch: '#0c1123' },
  { key: 'graphite', label: 'Graphite', swatch: '#0a0a0c' },
];
```

- [ ] **Step 6: Verify end-to-end in dev**

Company Setup → click Daylight: whole app flips light instantly (dirty state on); Save → success message; reload → app boots light with no dark flash (the `dt.surface` cache from Step 4 is what prevents it); switch back to Midnight → flips dark, saves, reboots dark. Run `npx tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
git add src/design/branding.ts src/design/BrandingCard.tsx
git commit -m "feat(theme): Daylight choosable per workspace via branding card"
```

---

### Task 7: Flip the default

Daylight becomes what every workspace without an explicit choice sees — including login/boot screens and new tenants. Workspaces that SAVED Midnight or Graphite keep their choice (that's the branding contract). **Founder sign-off gates this task** — it is the moment every tenant's screen changes.

**Files:**
- Modify: `src/main.tsx` (default branch of the boot logic)
- Modify: `src/design/branding.ts` (`applyBranding(null)` treats no-row as daylight)
- Modify: `index.html:10` (`theme-color`)
- Check: `public/manifest.webmanifest` (`theme_color`/`background_color` if present)

**Interfaces:**
- Consumes: audit metrics at 0 (Task 5), branding switch live (Task 6).
- Produces: light-by-default platform; `DEFAULT_ACCENT` (`#6366f1`) deliberately unchanged — it is the JS fallback for `accentColor` props and flipping it would recolor branded dark workspaces; the few surfaces reading it show indigo until a tenant picks an accent. Accepted cosmetic seam, revisit with Operator mode.

- [ ] **Step 1: Precondition check**

Run: `node scripts/audit-light-ready.mjs --strict` — all four metrics 0 (or the documented §7 exemptions only). If not zero, this task does not start.

- [ ] **Step 2: Flip the boot default in `src/main.tsx`**

In the Task 1 block, change the final fallback:

```ts
  const light = urlTheme ? urlTheme === 'light' : (cached ? LIGHT_SURFACES.has(cached) : true);
```

- [ ] **Step 3: Flip the no-branding default in `src/design/branding.ts`**

In `applyBranding`, the no-row path becomes daylight:

```ts
  const key = b?.surface_key ?? 'daylight';
```

- [ ] **Step 4: Flip the browser chrome color in `index.html`**

```html
    <meta name="theme-color" content="#f4f5f7" />
```

Check `public/manifest.webmanifest` for `theme_color`/`background_color` and align both to `#f4f5f7` if present.

- [ ] **Step 5: Full-estate spot verification**

Signed out: login screen light. Fresh dev tenant (no branding row): everything light. The founder's workspace (saved midnight row): still dark until they choose otherwise — verify no flash of light before the saved row applies (the `dt.surface` cache covers reloads; first-ever visit on a new device may flash one frame — check and record what you actually see). Phone shell spot-check (`sw.js` must not cache stale CSS — hard-reload the PWA).

- [ ] **Step 6: Founder checkpoint, then commit and deploy**

Show the founder the verification evidence; on explicit go:

```bash
git add src/main.tsx src/design/branding.ts index.html public/manifest.webmanifest
git commit -m "feat(theme)!: Daylight is the platform default"
git push origin main
```

Post-deploy: verify production login screen renders light; grep the deployed bundle for `--dt-page:#f4f5f7` (or fetch and check computed style) rather than trusting the build log.

---

### Task 5T: The tone-text sweep — the dimension the audit never measured

Found by the final whole-branch review (2026-08-21): the estate carries ~749 lines of `text-{tone}-100|200|300` (amber-300 ×153, indigo-300 ×148, emerald-300 ×136, rose-300 ×116, red-300 ×84, + ~110 more) — dark-only semantic text at ~1.3–2.5:1 on white, invisible to the four original audit metrics. "Audit at 0" was satisfiable while the estate was not light-ready. This sweep closes the gap BEFORE the migration apply exposes the Daylight tile to tenant admins.

**Files:**
- Modify: `scripts/audit-light-ready.mjs` — fifth ratcheted metric `tone text-300` counting `text-(amber|indigo|emerald|rose|red|sky|teal|violet|purple|cyan|orange|fuchsia|pink|lime|yellow|green|blue)-(100|200|300)` lines NOT carrying an opaque same-line colored fill (reuse the opacity-aware COLORED_BG) and NOT inside `.dt-force-dark`-classed markup files' §7 exclusions; calibrate the baseline honestly, prove falsifiability.
- Modify: estate-wide per the worklist, Task-5 group pattern (2–3 groups, one review gate each).

**Mapping:** by SEMANTIC family — `text-amber-*` → `text-dt-warn`, `text-emerald-*` → `text-dt-ok`, `text-rose-*|red-*` → `text-dt-danger`, `text-sky-*` → `text-dt-info`, `text-indigo-*` → `text-dt-accent-text`; other hues → nearest semantic BY MEANING (violet/purple step-grade families keep their hue via a judgment entry — a raw tone on a token surface converts to the nearest dt text token; a tone on a solid same-hue fill stays). Tone families never reassigned. Survivors → §7 + exclusion, never slack.

**Done when:** fifth metric at 0 with documented survivors; guards clean; per-group reviews passed.

---

### Task 8: Warm Editorial — the fourth surface family (founder-requested 2026-08-21)

Option C from the design canvas becomes a choosable surface family, riding the exact machinery Tasks 1–6 built: a second LIGHT family expressed as class overrides on top of `:root.light`, one tile, one constraint widening. The one new mechanism is a **display-font token** for Editorial's serif headlines — invisible in every other theme because it defaults to the sans stack.

**Files:**
- Modify: `package.json`/lockfile (+ `@fontsource-variable/newsreader`, `@fontsource-variable/schibsted-grotesk`), `src/main.tsx` (font imports + boot), `src/design/tokens.css`, `tailwind.config.js`, `src/design/primitives.tsx`, `src/design/branding.ts`, `src/design/BrandingCard.tsx`
- Create: `supabase/migrations/NNN_warm_editorial_surface_family.sql` (NNN via `npm run migrate:next -- warm_editorial_surface_family`)

**Interfaces:**
- Produces: family key `'editorial'` (LIGHT); root classes `light editorial` together; `--dt-font-display` token + Tailwind `font-display`; dev override `?theme=light&surface=editorial`.

- [ ] **Step 1: Editorial token block in `src/design/tokens.css`**, AFTER `:root.light`:

```css
/* ═══ WARM EDITORIAL — the second light family (founder-requested 2026-08-21).
   Overrides on top of :root.light; activated by classes `light editorial`
   together. Cream paper, ink text, terracotta accent, serif display. ═══ */
:root.light.editorial {
  --dt-page:    #faf6ef;
  --dt-panel:   #fffdf8;
  --dt-card:    #fffdf8;
  --dt-inset:   #f3ede1;
  --dt-border:        #e5dcc9;
  --dt-border-strong: #d3c6ab;
  --dt-text-title:   #221c14;
  --dt-text-body:    #383024;
  --dt-text-support: #6b6152;
  --dt-text-muted:   #8a7f6e;
  --dt-text-faint:   #b0a693;
  --dt-accent:        #c14d21;
  --dt-accent-strong: #a63e17;
  --dt-accent-hover:  #c14d21;
  --dt-accent-soft:   #c14d2114;
  --dt-accent-text:   #a63e17;
  --dt-accent-border: #c14d214d;
  --dt-ok:      #37613a; --dt-ok-soft:     #e7efe0; --dt-ok-border:     #c3d5c4;
  --dt-warn:    #8a5406; --dt-warn-soft:   #f7ead0; --dt-warn-border:   #e8d3a4;
  --dt-danger:  #b42318; --dt-danger-soft: #fdecea; --dt-danger-border: #f4b3ae;
  --dt-info:    #16606c; --dt-info-soft:   #e3edee; --dt-info-border:   #b7d3d8;
  --dt-neutral: #6b6152; --dt-neutral-soft:#ede6d8; --dt-neutral-border:#dcd2c0;
  --dt-font-sans: "Schibsted Grotesk Variable", ui-sans-serif, system-ui, -apple-system,
                  BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --dt-font-display: "Newsreader Variable", Georgia, "Times New Roman", serif;
}
```

- [ ] **Step 2: the display-font token everywhere else.** In `:root` (next to `--dt-font-sans`): `--dt-font-display: var(--dt-font-sans);` — chained, so every existing theme renders headings exactly as today. AND pin it inside `.dt-force-dark` (`--dt-font-display: var(--dt-font-sans);`, next to that block's existing font pin): custom properties INHERIT computed values, so a forced-dark subtree under `<html class="light editorial">` would otherwise inherit Editorial's literal serif — the original version of this step claimed the `:root` chain sufficed, and the Task 8 probe proved it wrong. Verify with a computed-style probe that a `.dt-force-dark` heading resolves to the sans stack in editorial mode.

- [ ] **Step 3: Tailwind + fonts.** `tailwind.config.js` fontFamily gains `display: ['var(--dt-font-display)']`. `npm install @fontsource-variable/newsreader @fontsource-variable/schibsted-grotesk`; import both in `src/main.tsx` below the instrument-sans import. (No CDN substitutes; BLOCKED if unresolvable.)

- [ ] **Step 4: display wiring in `src/design/primitives.tsx`** — add `font-display` to exactly three elements: PageHeaderV2's title `h1`/`h2` element, PanelCard's header `h2`, StatTile's value div. Nothing else (EntityRow names, chips, body copy stay sans). Every non-editorial theme renders these identically (token defaults to sans) — state the verification for that claim.

- [ ] **Step 5: boot + branding.** `src/main.tsx`: the boot block gains a `surface` URL param (dev vehicle): `?theme=light&surface=editorial` toggles class `editorial` alongside `light`; otherwise `editorial` is toggled when the cached `dt.surface === 'editorial'`. `src/design/branding.ts`: `TenantBranding` union + `SURFACES.editorial = {}` + `LIGHT_SURFACES` gains `'editorial'` (BOTH copies — main.tsx and branding.ts, keep identical) + `applyBranding` toggles `document.documentElement.classList.toggle('editorial', key === 'editorial')` next to the `light` toggle. `src/design/BrandingCard.tsx`: tile `{ key: 'editorial', label: 'Warm Editorial', swatch: '#faf6ef' }` after Daylight.

- [ ] **Step 6: migration** — `npm run migrate:next -- warm_editorial_surface_family`; fetch the LIVE `set_tenant_branding` prosrc (it now includes daylight) and inline verbatim with the validation list widened to `('midnight','graphite','daylight','editorial')`; CHECK constraint drop/re-add with all four; absence-of-violation + schema assertions; `NOTIFY pgrst, 'reload schema';`. `npm run audit:replayable` passes. Commit on the branch; NO push, NO apply (founder-gated).

- [ ] **Step 7: verify + guards.** Dev server probes at `?theme=light&surface=editorial`: page bg `#faf6ef`, PanelCard h2 computed font-family starts "Newsreader Variable" AND `document.fonts.check('16px "Newsreader Variable"')` true; body text Schibsted; `?theme=light` (no surface): Daylight unchanged, headings still sans; `?theme=dark`: unchanged. All five audit metrics 0; drift clean; tsc; build. Commit code as `feat(theme): Warm Editorial surface family — cream, terracotta, serif display`.

---

### Task 9: Auto night-switching (founder-requested 2026-08-21)

A workspace-level toggle: when on, the workspace's chosen surface applies by day and a chosen NIGHT surface (default midnight) applies from 19:00–07:00 by each viewer's LOCAL clock, switching live at the boundary. Off by default; off = exactly today's behavior.

**Design decisions (locked):** workspace-level (rides `tenant_branding`), not per-user. Day window 07:00–18:59 local, hardcoded (a configurable window is a later ask). Night surface restricted to the two dark families. A NEW companion RPC rather than widening `set_tenant_branding` — adding defaulted parameters to an existing Postgres function creates an OVERLOAD (two functions, PostgREST ambiguity), and DROP+CREATE would shed ACLs; a companion avoids both.

**Files:**
- Create: `supabase/migrations/NNN_auto_night_switching.sql` (NNN via `npm run migrate:next -- auto_night_switching`)
- Modify: `src/design/branding.ts`, `src/design/BrandingCard.tsx`, `src/main.tsx`

**Interfaces:**
- Produces: `tenant_branding.auto_switch boolean not null default false` + `night_surface_key text null` (CHECK in ('midnight','graphite')); RPC `set_tenant_branding_auto(p_auto_switch boolean, p_night_surface_key text)`; `applyBranding` becomes schedule-aware; localStorage keys `dt.surface` (unchanged: caches the EFFECTIVE key) plus `dt.branding` (JSON `{surface, auto, night}` for flash-free boot).

- [ ] **Step 1: migration.** `ALTER TABLE public.tenant_branding ADD COLUMN auto_switch boolean NOT NULL DEFAULT false, ADD COLUMN night_surface_key text NULL;` + named CHECK `tenant_branding_night_surface_key_check` (`night_surface_key IS NULL OR night_surface_key IN ('midnight','graphite')`). New function `public.set_tenant_branding_auto(p_auto_switch boolean, p_night_surface_key text DEFAULT NULL) RETURNS jsonb SECURITY DEFINER SET search_path=public` — mirror `set_tenant_branding`'s existing body EXACTLY for its tenant-resolution and permission-check preamble (fetch the live prosrc and reuse that preamble verbatim; the mutation is `UPDATE public.tenant_branding SET auto_switch=p_auto_switch, night_surface_key=p_night_surface_key, updated_at=now() WHERE tenant_id=v_tenant` returning ok, plus the same not-found/validation error shapes; validate p_night_surface_key against the two dark keys when not null). ACL per repo law: `REVOKE ALL ... FROM PUBLIC, anon; GRANT EXECUTE ... TO authenticated, service_role;`. Assertions: absence-of-violation on data (`IF EXISTS (... night_surface_key NOT IN (...) AND night_surface_key IS NOT NULL)`) + schema assertions (both new columns exist via information_schema; the new function exists in pg_proc; the CHECK definition contains both keys). `NOTIFY pgrst, 'reload schema';` `npm run audit:replayable` passes. Commit alone; NO push, NO apply.
- [ ] **Step 2: schedule-aware branding runtime** in `src/design/branding.ts`:
  - `TenantBranding` gains `auto_switch: boolean; night_surface_key: 'midnight' | 'graphite' | null` (fetch selects them; treat missing columns — pre-apply window — as `false`/`null` so the deployed code degrades gracefully before the migration lands: `data?.auto_switch ?? false`).
  - `const NIGHT_STARTS = 19, NIGHT_ENDS = 7;` and `export const isNightNow = (d = new Date()) => { const h = d.getHours(); return h >= NIGHT_STARTS || h < NIGHT_ENDS; };`
  - `effectiveSurface(b)`: `b.auto_switch && isNightNow() ? (b.night_surface_key ?? 'midnight') : (b.surface_key ?? default)`. `applyBranding` applies the EFFECTIVE key's classes/overrides (accent handling unchanged — accent persists across day/night), caches `dt.surface` = effective key and `dt.branding` = the JSON triple (both in try/catch).
  - A module-level scheduler started by `loadAndApplyBranding`: `setInterval` every 60s + a `visibilitychange` listener; each tick recomputes the effective key from the LAST APPLIED branding (kept in a module variable) and re-calls `applyBranding` only when the effective key CHANGED (no churn). Guard against double-starting the scheduler.
- [ ] **Step 3: flash-free boot** in `src/main.tsx`: the boot block reads `dt.branding` (try/catch, JSON.parse guarded); when present and `auto` is true, compute night with the same 19/7 window inline (duplicate the two constants with a comment naming branding.ts as the twin, same pattern as LIGHT_SURFACES) and derive the boot classes from the effective key; otherwise fall back to the existing `dt.surface` path. `?surface=` override still wins.
- [ ] **Step 4: BrandingCard UI.** Below the surface tiles: a toggle row — label `Switch to a dark look at night`, sub-copy `From 7pm to 7am in each person's local time.` — rendered as the existing checkbox/toggle pattern used elsewhere in Setup (find one and reuse; do not invent a new control). When ON, a second tile row `Night look` offering exactly Midnight Navy and Graphite (reuse the SURFACES tile rendering, filtered). Save calls BOTH RPCs (`saveBranding` then `set_tenant_branding_auto` via a new `saveAutoNight` helper in branding.ts); failure of either keeps `dirty` and shows the error (follow the existing save() shape). Preview: toggling the switch previews the CURRENT effective state immediately (if it is night now and auto goes on, the night look applies as preview).
- [ ] **Step 5: verify + guards.** Probes (dev server, no auth needed for the mechanism): simulate via console by calling the exported `isNightNow(new Date('2026-08-21T20:00'))` → true, `('2026-08-21T12:00')` → false; boot-path: seed `dt.branding` in localStorage with `{surface:'daylight',auto:true,night:'midnight'}`, reload at a mocked... clock mocking is not available — instead verify BOTH branches by seeding the cache and checking the boot classes against the REAL current time's expected branch, and state which branch the wall clock exercised; the other branch is covered by the isNightNow unit probes. All guards clean (five audit zeros, drift, tsc, build). Commit: `feat(theme): auto night-switching — day look by day, dark look by night, per-workspace toggle`.

---

## Deferred (explicitly out of scope, recorded so it isn't lost)

- **Command Deck theme + Operator toggle:** a `:root.deck` token block (carbon palette, `--dt-font-mono` for numerals, radius/density tokens), `deck` in both `LIGHT_SURFACES`-style lists as a dark family, a per-USER toggle (profile-backed, not workspace-wide) in the header. Everything in Tasks 1–2 was shaped so this is additive.
- **`DEFAULT_ACCENT` unification** (15-call-site JS fallback vs per-theme CSS accents) — revisit with the toggle.
- **Marketing/site screenshots** in Daylight — after the flip, separate effort.

## Self-Review Notes

- Spec coverage: palette ✓ (T1), font ✓ (T2), estate exposure ✓ (T3+T5), pilot proof ✓ (T4), one-click workspace switch ✓ (T6), default flip ✓ (T7), dual-theme readiness ✓ (T1/T2 shape + Deferred).
- Known duplication, deliberate: `LIGHT_SURFACES` exists in `main.tsx` (boot, before any import cost) and `branding.ts` — both sites carry a comment naming the other.
- The one placeholder-shaped element (mig function body) is explicitly a fetch-then-inline step inside its own task, with the exact query to fetch it.
