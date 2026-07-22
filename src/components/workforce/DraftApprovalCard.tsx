import React, { useState } from 'react';
import { WorkforceAction, approveWorkforceAction } from '../../lib/workforceApi';
import { CheckCircle, XCircle, Loader } from './icons';

interface DraftApprovalCardProps {
  action: WorkforceAction;
}

export function DraftApprovalCard({ action }: DraftApprovalCardProps) {
  const [isApproving, setIsApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    setIsApproving(true);
    setError(null);
    try {
      const result = await approveWorkforceAction(action.action_id);
      if (result.success) {
        setApproved(true);
      } else {
        setError(result.error || 'Failed to approve');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error approving');
    } finally {
      setIsApproving(false);
    }
  };

  if (approved) {
    return (
      <div className="bg-green-900 border border-green-700 rounded p-2 flex items-center gap-2">
        <CheckCircle className="w-4 h-4 text-green-300 flex-shrink-0" />
        <span className="text-xs text-green-100">Approved</span>
      </div>
    );
  }

  const actionLabel: Record<string, string> = {
    de_hire: 'Hire New DE',
    de_amend: 'Amend DE',
    de_retire: 'Retire DE',
    de_train: 'Training Update',
  };

  return (
    <div className="bg-dt-panel border border-dt-border-strong rounded p-2 text-xs">
      <div className="font-medium text-dt-body">{actionLabel[action.action_type] || action.action_type}</div>
      {action.proposal_rationale && (
        <p className="text-dt-support mt-1 line-clamp-2">{action.proposal_rationale}</p>
      )}

      {error && <div className="text-red-300 mt-1">{error}</div>}

      <div className="flex gap-1 mt-2">
        <button
          onClick={handleApprove}
          disabled={isApproving}
          className="flex-1 px-2 py-1 bg-green-600 hover:bg-green-700 disabled:bg-slate-600 text-white rounded text-xs transition flex items-center justify-center gap-1"
        >
          {isApproving ? (
            <>
              <Loader className="w-3 h-3 animate-spin" />
              Approving...
            </>
          ) : (
            <>
              <CheckCircle className="w-3 h-3" />
              Approve
            </>
          )}
        </button>
        <button className="flex-1 px-2 py-1 bg-slate-600 hover:bg-slate-500 text-dt-title rounded text-xs transition flex items-center justify-center gap-1">
          <XCircle className="w-3 h-3" />
          Reject
        </button>
      </div>
    </div>
  );
}
