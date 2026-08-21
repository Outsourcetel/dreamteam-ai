/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--dt-font-sans)'],
        display: ['var(--dt-font-display)'],
      },
      // ── DreamTeam Design System v1 — semantic tokens (src/design/tokens.css).
      // New/touched UI composes from these; raw slate-* classes are legacy and
      // burn down via scripts/design-drift.mjs. docs/design-system.md is law.
      colors: {
        // ── Midnight Navy (founder-locked 2026-07-22) — the platform's dark.
        // The slate scale itself is remapped to an indigo-tinted navy ramp so
        // EVERY legacy slate-* class shifts hue in one move (lightness kept
        // close to real slate, so existing contrast relationships hold).
        // Per-tenant branding overrides arrive via CSS vars on top of this.
        slate: {
          50: '#f2f5fb', 100: '#e4e9f6', 200: '#cbd5ec', 300: '#a6b4d8',
          400: '#7b8ab3', 500: '#5b678d', 600: '#414b6e', 700: '#2d3554',
          800: '#171e39', 900: '#0c1123', 950: '#070a17',
        },
        dt: {
          page: 'var(--dt-page)',
          panel: 'var(--dt-panel)',
          card: 'var(--dt-card)',
          inset: 'var(--dt-inset)',
          border: 'var(--dt-border)',
          'border-strong': 'var(--dt-border-strong)',
          title: 'var(--dt-text-title)',
          body: 'var(--dt-text-body)',
          support: 'var(--dt-text-support)',
          muted: 'var(--dt-text-muted)',
          faint: 'var(--dt-text-faint)',
          accent: 'var(--dt-accent)',
          'accent-strong': 'var(--dt-accent-strong)',
          'accent-hover': 'var(--dt-accent-hover)',
          'accent-soft': 'var(--dt-accent-soft)',
          'accent-text': 'var(--dt-accent-text)',
          'accent-border': 'var(--dt-accent-border)',
          ok: 'var(--dt-ok)', 'ok-soft': 'var(--dt-ok-soft)', 'ok-border': 'var(--dt-ok-border)',
          warn: 'var(--dt-warn)', 'warn-soft': 'var(--dt-warn-soft)', 'warn-border': 'var(--dt-warn-border)',
          danger: 'var(--dt-danger)', 'danger-soft': 'var(--dt-danger-soft)', 'danger-border': 'var(--dt-danger-border)',
          info: 'var(--dt-info)', 'info-soft': 'var(--dt-info-soft)', 'info-border': 'var(--dt-info-border)',
          neutral: 'var(--dt-neutral)', 'neutral-soft': 'var(--dt-neutral-soft)', 'neutral-border': 'var(--dt-neutral-border)',
        },
      },

      // ── Design System v2 — LAYOUT tokens (src/design/tokens.css §layout).
      // Colour was tokenised in v1 and space was not, so every page invented
      // its own widths and gutters. Same variables, surfaced the same way, so
      // `w-dt-sidebar` and `bg-dt-card` are the same kind of statement.
      //
      // Registered under several scales on purpose: a width token is only
      // useful if it can also be a min-width, a grid track and a flex basis.
      spacing: {
        'dt-sidebar': 'var(--dt-sidebar)',
        'dt-sidebar-rail': 'var(--dt-sidebar-rail)',
        'dt-gutter': 'var(--dt-gutter)',
        'dt-gap': 'var(--dt-gap)',
        'dt-gap-tight': 'var(--dt-gap-tight)',
        'dt-row-compact': 'var(--dt-row-compact)',
        'dt-row-comfort': 'var(--dt-row-comfort)',
      },
      maxWidth: {
        'dt-content': 'var(--dt-content-max)',
        'dt-content-wide': 'var(--dt-content-wide)',
        'dt-field': 'var(--dt-field-max)',
        'dt-drawer': 'var(--dt-drawer)',
        'dt-drawer-wide': 'var(--dt-drawer-wide)',
      },
      minWidth: {
        'dt-card': 'var(--dt-card-min)',
        'dt-kpi': 'var(--dt-kpi-min)',
        'dt-tile': 'var(--dt-tile-min)',
      },
      minHeight: {
        'dt-row-compact': 'var(--dt-row-compact)',
        'dt-row-comfort': 'var(--dt-row-comfort)',
      },
      width: {
        'dt-sidebar': 'var(--dt-sidebar)',
        'dt-sidebar-rail': 'var(--dt-sidebar-rail)',
        'dt-drawer': 'var(--dt-drawer)',
        'dt-drawer-wide': 'var(--dt-drawer-wide)',
      },
      gap: {
        dt: 'var(--dt-gap)',
        'dt-tight': 'var(--dt-gap-tight)',
      },
      // Responsive grids that drop a column on their own, so 1024–1279 needs
      // no separate layout to maintain (handoff §04).
      gridTemplateColumns: {
        'dt-cards': 'repeat(auto-fit, minmax(var(--dt-card-min), 1fr))',
        'dt-kpis': 'repeat(auto-fit, minmax(var(--dt-kpi-min), 1fr))',
        'dt-tiles': 'repeat(auto-fit, minmax(var(--dt-tile-min), 1fr))',
      },
      // The three verified breakpoints. Six tiers across 55 pages is more
      // surface than anyone checks, and an unverified breakpoint is a
      // liability — clamp() and auto-fit cover everything between these.
      screens: {
        'dt-compact': '1024px',
        'dt-target': '1280px',
        'dt-large': '1600px',
      },
    },
  },
  plugins: [],
};
