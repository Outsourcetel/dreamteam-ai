import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';
import '@fontsource-variable/instrument-sans';
import { initSentry, SentryErrorBoundary } from './lib/sentry';

initSentry();

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

function CrashFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-dt-page p-6">
      <div className="max-w-sm text-center">
        <p className="text-lg font-semibold text-white mb-2">Something went wrong</p>
        <p className="text-sm text-slate-400 mb-4">
          This error has been reported. Try reloading the page — if it keeps happening, contact support.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors"
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