import { useIsTenantAdmin } from '../../lib/useRoleGate';
import { useState } from 'react';
import { WorkforceAction, approveWorkforceAction } from '../../lib/workforceApi';
import { CheckCircle, XCircle, Loader } from './icons';
import { presentError } from '../../lib/presentError';

interface DraftApprovalCardProps {
  action: WorkforceAction;
}

export function DraftApprovalCard({ action }: DraftApprovalCardProps) {
  // ⚠ Not the same case as approving a human task. That routes through
  // decide_human_task, which refuses with a reason worth reading, and is
  // deliberately left open. This writes workforce_actions directly, and its
  // RLS policy is named "Admins can approve actions" — a refusal here says
  // nothing at all, and without .single() it would not even say that.
  const canApproveDrafts = useIsTenantAdmin();
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
      setError(presentError(err, 'Error approving'));
    } finally {
      setIsApproving(false);
    }
  };

  if (approved) {
    return (
      <div className="bg-dt-ok-soft border border-dt-ok-border rounded p-2 flex items-center gap-2">
        <CheckCircle className="w-4 h-4 text-dt-ok flex-shrink-0" />
        <span className="text-xs text-dt-ok">Approved</span>
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

      {error && <div className="text-dt-danger mt-1">{error}</div>}

      <div className="flex gap-1 mt-2">
        <button
          onClick={handleApprove}
          disabled={isApproving || !canApproveDrafts}
          className="flex-1 px-2 py-1 bg-green-600 hover:bg-green-700 disabled:bg-dt-border-strong text-white rounded text-xs transition flex items-center justify-center gap-1"
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
        <button className="flex-1 px-2 py-1 bg-dt-border-strong hover:bg-dt-panel text-dt-title rounded text-xs transition flex items-center justify-center gap-1">
          <XCircle className="w-3 h-3" />
          Reject
        </button>
      </div>
    </div>
  );
}
