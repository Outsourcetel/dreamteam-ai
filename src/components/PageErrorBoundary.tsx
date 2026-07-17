import React from 'react'
import * as Sentry from '@sentry/react'

// Page-level error boundary. main.tsx has a ROOT SentryErrorBoundary, but
// that one catches at the very top — any uncaught render error there white-
// screens the entire app (nav, shell, in-progress work all gone). This
// boundary wraps only the current page body, so a crash in one page shows a
// contained fallback while the sidebar / chat dock / remote-access banner
// stay usable, and navigating elsewhere recovers (App keys this by page, so
// a route change remounts it clean). Still reports to Sentry — the root
// boundary never sees the error because we catch it first.
interface Props { children: React.ReactNode }
interface State { error: Error | null }

export default class PageErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    Sentry.captureException(error, { extra: { componentStack: info.componentStack } })
    // Also log so it's visible in the browser console during development.
    console.error('Page crashed:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex-1 overflow-auto bg-slate-900 p-6 flex items-center justify-center">
        <div className="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-rose-500/15 text-rose-300 flex items-center justify-center text-xl mx-auto mb-4">!</div>
          <h2 className="text-lg font-semibold text-white mb-2">This page hit an error</h2>
          <p className="text-sm text-slate-400 mb-1">
            The rest of the app is still working — use the sidebar to go somewhere else, or try again.
          </p>
          <p className="text-[11px] text-slate-600 font-mono break-words mb-5">
            {this.state.error.message || 'Unknown error'}
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="text-xs px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
}
