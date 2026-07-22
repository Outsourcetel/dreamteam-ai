import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';
import { initSentry, SentryErrorBoundary } from './lib/sentry';

initSentry();

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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SentryErrorBoundary fallback={<CrashFallback />}>
      <App />
    </SentryErrorBoundary>
  </React.StrictMode>
);