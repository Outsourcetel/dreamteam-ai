/**
 * Sentry Integration Setup
 *
 * Initializes error tracking for production.
 * DSN loaded from environment variable VITE_SENTRY_DSN.
 */

import * as Sentry from '@sentry/react'
import { BrowserTracing } from '@sentry/tracing'

export function initializeSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN
  const environment = import.meta.env.MODE || 'development'

  if (!dsn) {
    console.warn('Sentry DSN not configured. Error tracking disabled.')
    return
  }

  Sentry.init({
    dsn,
    environment,
    integrations: [
      new BrowserTracing({
        // Track React Router if available
        routingInstrumentation: Sentry.reactRouterV6Instrumentation(window.history),
      }),
      new Sentry.Replay({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
    replaysSessionSampleRate: environment === 'production' ? 0.1 : 1.0,
    replaysOnErrorSampleRate: 1.0,
    beforeSend(event) {
      // Filter out non-critical errors
      if (event.exception) {
        const error = event.exception.values?.[0]?.value
        // Don't report network timeouts in user's browser
        if (error?.includes('timeout') || error?.includes('NetworkError')) {
          return null
        }
      }
      return event
    },
  })
}

/**
 * Capture exception with context
 */
export function captureException(error: Error, context?: Record<string, unknown>) {
  if (context) {
    Sentry.setContext('additional', context)
  }
  Sentry.captureException(error)
}

/**
 * Capture message
 */
export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info') {
  Sentry.captureMessage(message, level)
}

/**
 * Set user context for error tracking
 */
export function setSentryUser(user: { id: string; email?: string; tenant_id?: string }) {
  Sentry.setUser({
    id: user.id,
    email: user.email,
    username: user.tenant_id,
  })
}

/**
 * Clear user context (on logout)
 */
export function clearSentryUser() {
  Sentry.setUser(null)
}
