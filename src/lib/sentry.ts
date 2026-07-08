// ============================================================
// Error monitoring (Sentry) — dormant until VITE_SENTRY_DSN is set,
// same pattern as every other "founder needs to provide a real
// credential" feature in this project (AI provider keys, Zendesk,
// etc.): the app runs identically without it, just without crash
// reporting. Local dev has no DSN by default, so nothing reports
// from developer machines; Vercel's production and preview
// environments both have the DSN configured.
// ============================================================
import * as Sentry from '@sentry/react';

export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Error monitoring only for now — no tracing/replay, to keep
    // this a lightweight crash-reporting integration rather than a
    // full observability suite. Can be expanded later if needed.
    tracesSampleRate: 0,
  });
}

export const SentryErrorBoundary = Sentry.ErrorBoundary;
