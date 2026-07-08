import React from 'react';

// ============================================================
// Shared UI states for LIVE-mode Customer pages: loading
// skeleton, "tables not provisioned" notice, and empty state.
// ============================================================

export function LiveLoadingSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 animate-pulse">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 rounded-xl bg-slate-900 border border-slate-800" />
      ))}
    </div>
  );
}

export function MissingTablesNotice() {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-5 flex items-start gap-3">
      <span className="text-slate-400 text-lg flex-shrink-0">◇</span>
      <div>
        <p className="text-sm font-medium text-slate-200 mb-1">Live data tables not yet provisioned</p>
        <p className="text-xs text-slate-400 leading-relaxed">
          Your workspace is connected, but the Customer data tables haven't been created in the
          database yet. Ask your administrator to run{' '}
          <code className="text-slate-300 bg-slate-800 px-1 py-0.5 rounded">supabase/migrations/011_customer_entity.sql</code>{' '}
          in the Supabase SQL Editor, then reload this page.
        </p>
      </div>
    </div>
  );
}

export function LiveErrorNotice({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-5 flex items-start gap-3">
      <span className="text-red-400 text-lg flex-shrink-0">!</span>
      <div className="flex-1">
        <p className="text-sm font-medium text-red-300 mb-1">Couldn't load this page</p>
        <p className="text-xs text-red-400/80 leading-relaxed">
          {message || 'Something went wrong loading your data. Try again, and contact support if it keeps happening.'}
        </p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 transition-colors flex-shrink-0"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function LiveEmptyState({
  icon = '◎',
  title,
  body,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
}: {
  icon?: string;
  title: string;
  body: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 rounded-2xl border border-dashed border-slate-800 bg-slate-900/30">
      <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-xl mb-4">{icon}</div>
      <h2 className="text-lg font-semibold text-slate-200 mb-2">{title}</h2>
      <p className="text-sm text-slate-500 max-w-sm mb-6">{body}</p>
      <div className="flex gap-3">
        {primaryLabel && onPrimary && (
          <button
            onClick={onPrimary}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors"
          >
            {primaryLabel}
          </button>
        )}
        {secondaryLabel && onSecondary && (
          <button
            onClick={onSecondary}
            className="px-4 py-2 rounded-lg text-sm text-slate-300 border border-slate-700 hover:border-slate-500 hover:text-white transition-colors"
          >
            {secondaryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
