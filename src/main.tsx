import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';
import '@fontsource-variable/instrument-sans';
// Warm Editorial's display/body faces (Task 8) — loaded unconditionally like
// Instrument Sans above; inert unless the `editorial` class selects them via
// --dt-font-display / --dt-font-sans in tokens.css.
import '@fontsource-variable/newsreader';
import '@fontsource-variable/schibsted-grotesk';
import { initSentry, SentryErrorBoundary } from './lib/sentry';

initSentry();

// Theme bootstrapping. The class must be on <html> BEFORE first paint or the
// app flashes the wrong theme. Order of authority: dev URL override → the
// last surface family branding applied (cached by applyBranding in
// src/design/branding.ts) → dark default (flips to light in the
// default-flip task, after the estate is verified).
// Must stay identical to LIGHT_SURFACES in src/design/branding.ts (runtime copy).
const LIGHT_SURFACES = new Set(['daylight', 'editorial']);
// Auto night-switching (Task 9). Must stay identical to
// NIGHT_STARTS/NIGHT_ENDS/isNightNow in src/design/branding.ts (runtime
// twin) — duplicated here for the same reason as LIGHT_SURFACES above: the
// boot block cannot afford the import cost of branding.ts before first paint.
const NIGHT_STARTS = 19, NIGHT_ENDS = 7;
{
  const params = new URLSearchParams(window.location.search);
  const urlTheme = params.get('theme');
  const urlSurface = params.get('surface');
  // Guarded like every other storage call in this codebase: a throw here
  // (sandboxed embed, storage disabled) runs before the error boundary
  // exists and would blank the whole app.
  let cached: string | null = null;
  try { cached = localStorage.getItem('dt.surface'); } catch { /* boot on the default */ }
  // dt.branding {surface, auto, night} lets a flash-free boot recompute the
  // EFFECTIVE key itself (dt.surface alone is only last-APPLIED, which can be
  // stale by up to a tick after the day/night boundary if the page was left
  // open across it and reloaded before the 60s scheduler ticked). Only
  // consulted when there's no dev override — `?theme=`/`?surface=` still wins,
  // same precedence dt.surface already had.
  let effectiveKey: string | null = cached;
  if (!urlTheme) {
    try {
      const raw = localStorage.getItem('dt.branding');
      if (raw) {
        const b = JSON.parse(raw) as { surface?: string; auto?: boolean; night?: string | null };
        if (b && b.auto) {
          const h = new Date().getHours();
          const isNight = h >= NIGHT_STARTS || h < NIGHT_ENDS;
          effectiveKey = isNight ? (b.night ?? 'midnight') : (b.surface ?? cached ?? 'midnight');
        } else if (b && b.surface) {
          effectiveKey = b.surface;
        }
      }
    } catch { /* boot on the dt.surface fallback already in effectiveKey */ }
  }
  const light = urlTheme ? urlTheme === 'light' : (effectiveKey ? LIGHT_SURFACES.has(effectiveKey) : false);
  document.documentElement.classList.toggle('light', light);
  // Warm Editorial (Task 8): `?theme=light&surface=editorial` is the dev
  // vehicle; otherwise it follows the effective surface family like `light`
  // does (night surfaces are never editorial, so this is a no-op at night).
  const editorial = urlTheme ? urlSurface === 'editorial' : effectiveKey === 'editorial';
  document.documentElement.classList.toggle('editorial', editorial);
}

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

// Schema gallery at ?dtpreview=1 — DEV ONLY, and deliberately so.
//
// Every design-system component can be seen in one place without a signed-in
// session, which is the only way to check a new schema at 1024/1280/1536
// before it reaches a real screen. It earned its keep immediately: it caught
// --dt-card-min at 380px silently costing the third employee column, a chip
// rendering a whole sentence at 11px, and a stat label truncating to "closed
// without…". None of the three is visible from the source.
//
// `import.meta.env.DEV` is a compile-time constant, so the import and the
// branch are both dropped from the production bundle.
const previewing = import.meta.env.DEV && new URLSearchParams(window.location.search).has('dtpreview');
const SchemaPreview = React.lazy(() => import('./design/SchemaGallery'));

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SentryErrorBoundary fallback={<CrashFallback />}>
      {previewing
        ? <React.Suspense fallback={null}><SchemaPreview /></React.Suspense>
        : <App />}
    </SentryErrorBoundary>
  </React.StrictMode>
);