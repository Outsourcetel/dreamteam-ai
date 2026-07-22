/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
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
          ok: 'var(--dt-ok)', 'ok-soft': 'var(--dt-ok-soft)', 'ok-border': 'var(--dt-ok-border)',
          warn: 'var(--dt-warn)', 'warn-soft': 'var(--dt-warn-soft)', 'warn-border': 'var(--dt-warn-border)',
          danger: 'var(--dt-danger)', 'danger-soft': 'var(--dt-danger-soft)', 'danger-border': 'var(--dt-danger-border)',
          info: 'var(--dt-info)', 'info-soft': 'var(--dt-info-soft)', 'info-border': 'var(--dt-info-border)',
          neutral: 'var(--dt-neutral)', 'neutral-soft': 'var(--dt-neutral-soft)', 'neutral-border': 'var(--dt-neutral-border)',
        },
      },
    },
  },
  plugins: [],
};
