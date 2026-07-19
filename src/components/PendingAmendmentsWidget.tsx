// ── Pending Amendments Widget ──────────────────────────────────────────
// Status badge + expandable list. Shown on profile pages where amendments exist.

import { useEffect, useState } from 'react';
import { listPendingAmendments, type EntityKind, type AmendmentProposal } from '../lib/amendmentApi';
import AmendmentReviewCard from './AmendmentReviewCard';

export default function PendingAmendmentsWidget({
  entity_kind,
  entity_id,
}: {
  entity_kind: EntityKind;
  entity_id: string;
}) {
  const [amendments, setAmendments] = useState<AmendmentProposal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setIsLoading(true);
    listPendingAmendments(entity_kind, entity_id)
      .then(setAmendments)
      .finally(() => setIsLoading(false));
  }, [entity_kind, entity_id, refreshKey]);

  if (isLoading || amendments.length === 0) {
    return null;
  }

  const pending = amendments.filter((a) => a.status === 'review_pending').length;
  const draft = amendments.filter((a) => a.status === 'draft').length;

  return (
    <div className="space-y-3">
      {/* Collapsed badge */}
      {!isExpanded && (
        <button
          onClick={() => setIsExpanded(true)}
          className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-left text-sm hover:bg-amber-500/15 transition-colors"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-amber-300">
                {pending + draft} pending amendment{pending + draft !== 1 ? 's' : ''}
              </p>
              <p className="text-xs text-amber-200/80 mt-0.5">
                {pending} awaiting approval{draft > 0 ? `, ${draft} with issues` : ''}
              </p>
            </div>
            <span className="text-amber-400">›</span>
          </div>
        </button>
      )}

      {/* Expanded list */}
      {isExpanded && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Pending amendments</h3>
            <button
              onClick={() => setIsExpanded(false)}
              className="text-slate-500 hover:text-white text-xs px-2 py-1"
            >
              ✕
            </button>
          </div>

          <div className="space-y-3">
            {amendments.map((amendment) => (
              <AmendmentReviewCard
                key={amendment.amendment_id}
                amendment={amendment}
                entity_kind={entity_kind}
                onApprove={() => {
                  // Refresh the list after approval
                  setRefreshKey((k) => k + 1);
                }}
                onReject={() => {
                  // Refresh the list after rejection
                  setRefreshKey((k) => k + 1);
                }}
                showActions={true}
              />
            ))}
          </div>

          {amendments.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-4">No pending amendments</p>
          )}
        </div>
      )}
    </div>
  );
}
