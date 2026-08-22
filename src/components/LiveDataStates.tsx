// ============================================================
// Shared UI states for LIVE-mode Customer pages: loading
// skeleton, "tables not provisioned" notice, and empty state.
// ============================================================

export function LiveLoadingSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 animate-pulse">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 rounded-xl bg-dt-card border border-dt-border" />
      ))}
    </div>
  );
}

// ⚠ THIS IS CUSTOMER-FACING COPY, on 15 surfaces including the Command Centre,
// Approvals, Audit Trail and Compliance. Until 2026-08-22 it named a file in
// this repository — `supabase/migrations/011_customer_entity.sql` — and told the
// reader to open "the Supabase SQL Editor". A customer has no repository, no
// Supabase project and no SQL Editor; the sentence disclosed our stack, implied
// the workspace was half-built, and named an action nobody on their side can
// take. Keep this text about THEIR workspace and OUR responsibility. The
// migration filename belongs in the operator's logs, never on their screen.
export function MissingTablesNotice() {
  return (
    <div className="rounded-xl border border-dt-border-strong bg-dt-card p-5 flex items-start gap-3">
      <span className="text-dt-support text-lg flex-shrink-0">◇</span>
      <div>
        <p className="text-sm font-medium text-dt-body mb-1">This workspace isn't set up for customer records yet</p>
        <p className="text-xs text-dt-support leading-relaxed">
          Your workspace is connected, but customer records haven't been switched on for it.
          That's something we enable — contact support and we'll turn it on, usually the same
          working day. Nothing you've entered has been lost.
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
        <p className="text-sm font-medium text-dt-danger mb-1">Couldn't load this page</p>
        <p className="text-xs text-red-400/80 leading-relaxed">
          {message || 'Something went wrong loading your data. Try again, and contact support if it keeps happening.'}
        </p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="text-xs px-3 py-1.5 rounded-lg bg-dt-danger-soft hover:brightness-110 text-dt-danger transition-colors flex-shrink-0"
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
    <div className="flex flex-col items-center justify-center text-center py-16 rounded-2xl border border-dashed border-dt-border bg-dt-panel">
      <div className="w-12 h-12 rounded-xl bg-dt-card border border-dt-border flex items-center justify-center text-xl mb-4">{icon}</div>
      <h2 className="text-lg font-semibold text-dt-body mb-2">{title}</h2>
      <p className="text-sm text-dt-muted max-w-sm mb-6">{body}</p>
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
            className="px-4 py-2 rounded-lg text-sm text-dt-support border border-dt-border-strong hover:border-dt-border-strong hover:text-dt-body transition-colors"
          >
            {secondaryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
