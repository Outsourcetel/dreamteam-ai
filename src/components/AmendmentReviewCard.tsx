// ── Amendment Review Card ──────────────────────────────────────────────
// Reusable display for amendment proposals across all entity types.
// Shows: rationale, redline (diff), evidence (if available), approve/reject buttons.

import { useState } from 'react';
import { type AmendmentProposal, type EntityKind, approveAmendment, rejectAmendment } from '../lib/amendmentApi';

export default function AmendmentReviewCard({
  amendment,
  entity_kind,
  onApprove,
  onReject,
  showActions = true,
}: {
  amendment: AmendmentProposal;
  entity_kind: EntityKind;
  onApprove?: () => void;
  onReject?: () => void;
  showActions?: boolean;
}) {
  const [isApproving, setIsApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const handleApprove = async () => {
    if (onApprove) {
      onApprove();
      return;
    }
    setIsApproving(true);
    setApprovalError(null);
    try {
      await approveAmendment(amendment.amendment_id);
    } catch (e) {
      setApprovalError(e instanceof Error ? e.message : 'Failed to approve');
    } finally {
      setIsApproving(false);
    }
  };

  const handleReject = async () => {
    if (onReject) {
      onReject();
      return;
    }
    setIsApproving(true);
    setApprovalError(null);
    try {
      await rejectAmendment(amendment.amendment_id, 'User dismissed');
    } catch (e) {
      setApprovalError(e instanceof Error ? e.message : 'Failed to reject');
    } finally {
      setIsApproving(false);
    }
  };

  const statusColors = {
    draft: 'border-slate-700 bg-slate-800/60',
    review_pending: 'border-amber-500/30 bg-amber-500/10',
    approved: 'border-teal-500/30 bg-teal-500/10',
    applied: 'border-emerald-500/30 bg-emerald-500/10',
    rejected: 'border-slate-700 bg-slate-800/60',
  };

  const statusBadgeColor = {
    draft: 'bg-slate-700 text-slate-200',
    review_pending: 'bg-amber-600 text-amber-100',
    approved: 'bg-teal-600 text-teal-100',
    applied: 'bg-emerald-600 text-emerald-100',
    rejected: 'bg-slate-700 text-slate-200',
  };

  const statusLabel = {
    draft: 'Proposed (validation issues)',
    review_pending: 'Awaiting approval',
    approved: 'Approved',
    applied: 'Applied',
    rejected: 'Dismissed',
  };

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${statusColors[amendment.status]}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">Amendment proposal</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {entity_kind === 'de' && 'Configuration change'}
            {entity_kind === 'playbook' && 'Steps change'}
            {entity_kind === 'specialist' && 'Charter change'}
          </p>
        </div>
        <span className={`text-xs font-medium px-2.5 py-1 rounded-lg ${statusBadgeColor[amendment.status]}`}>
          {statusLabel[amendment.status]}
        </span>
      </div>

      {/* Rationale */}
      <div>
        <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Why this change</p>
        <p className="text-xs text-slate-300">{amendment.rationale}</p>
      </div>

      {/* Evidence (if available) */}
      {amendment.evidence && (
        <div className="rounded-lg bg-slate-900/60 border border-slate-700 p-3">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Test results</p>
          <div className="space-y-1">
            {amendment.evidence.replay_status && (
              <p className="text-xs text-slate-300">
                Replay:{' '}
                <span
                  className={
                    amendment.evidence.replay_status === 'passed'
                      ? 'text-emerald-400 font-medium'
                      : 'text-amber-400 font-medium'
                  }
                >
                  {amendment.evidence.replay_status}
                </span>
              </p>
            )}
            {typeof amendment.evidence.replay_score_before === 'number' &&
              typeof amendment.evidence.replay_score_after === 'number' && (
                <p className="text-xs text-slate-300">
                  Score: {Math.round(amendment.evidence.replay_score_before)} →{' '}
                  <span className="font-medium text-teal-400">
                    {Math.round(amendment.evidence.replay_score_after)}
                  </span>
                </p>
              )}
            {typeof amendment.evidence.golden_set_passed === 'boolean' && (
              <p className="text-xs text-slate-300">
                Golden exam:{' '}
                <span className={amendment.evidence.golden_set_passed ? 'text-emerald-400' : 'text-amber-400'}>
                  {amendment.evidence.golden_set_passed ? '✓ passed' : '✗ some failures'}
                </span>
              </p>
            )}
          </div>
        </div>
      )}

      {/* Redline */}
      {amendment.redline.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Changes</p>
          <div className="space-y-2">
            {amendment.redline.map((line, i) => (
              <div key={i} className="text-xs font-mono text-slate-300">
                <p className="text-slate-400">{line.field}</p>
                {line.old && (
                  <p className="text-red-400/80 ml-2">
                    − {line.old}
                  </p>
                )}
                {line.new && (
                  <p className="text-emerald-400/80 ml-2">
                    + {line.new}
                  </p>
                )}
                {line.note && (
                  <p className="text-slate-500 ml-2 italic"># {line.note}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      {(amendment.model_id || amendment.input_tokens) && (
        <div className="text-[10px] text-slate-600 pt-1 border-t border-slate-700/50">
          {amendment.model_id && <p>{amendment.model_id}</p>}
          {amendment.input_tokens && amendment.output_tokens && (
            <p>{amendment.input_tokens + amendment.output_tokens} tokens</p>
          )}
        </div>
      )}

      {approvalError && (
        <div className="rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {approvalError}
        </div>
      )}

      {/* Actions */}
      {showActions && amendment.status !== 'applied' && amendment.status !== 'rejected' && (
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleApprove}
            disabled={isApproving}
            className="flex-1 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-60 transition-colors"
          >
            {isApproving ? 'Approving…' : 'Approve'}
          </button>
          <button
            onClick={handleReject}
            disabled={isApproving}
            className="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300 text-xs font-medium disabled:opacity-60 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
