import React, { useState } from 'react'
import type { AmendmentProposal } from '../lib/amendmentApi'
import { approveAmendment, rejectAmendment } from '../lib/amendmentApi'

export function AmendmentReviewCard({ proposal, onApprove, onReject }: {
  proposal: AmendmentProposal
  onApprove?: (amendment_id: string) => void
  onReject?: (amendment_id: string) => void
}) {
  const [approving, setApproving] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleApprove = async () => {
    setApproving(true)
    setError(null)
    const result = await approveAmendment(proposal.amendment_id)
    if (result.ok) {
      onApprove?.(proposal.amendment_id)
    } else {
      setError(result.error || 'Failed to approve amendment')
    }
    setApproving(false)
  }

  const handleReject = async () => {
    setRejecting(true)
    setError(null)
    const result = await rejectAmendment(proposal.amendment_id)
    if (result.ok) {
      onReject?.(proposal.amendment_id)
    } else {
      setError(result.error || 'Failed to reject amendment')
    }
    setRejecting(false)
  }

  const statusColors = {
    proposed: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
    approved: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
    rejected: 'bg-red-500/10 border-red-500/30 text-red-300',
    applied: 'bg-blue-500/10 border-blue-500/30 text-blue-300',
  }

  const entityLabels: Record<string, string> = {
    de: 'Digital Employee',
    playbook: 'Playbook',
    specialist: 'Specialist',
  }

  return (
    <div className="bg-dt-card border border-dt-border rounded-lg p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-dt-support uppercase tracking-wider">
              Amendment Proposal
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${statusColors[proposal.status]}`}>
              {proposal.status}
            </span>
          </div>
          <p className="text-sm text-dt-body font-medium">
            {entityLabels[proposal.entity_kind]} — {proposal.entity_id}
          </p>
        </div>
      </div>

      {/* Rationale */}
      <div className="bg-dt-inset rounded-lg p-3 border border-dt-border/30">
        <p className="text-xs text-dt-muted mb-1">Why this change:</p>
        <p className="text-sm text-dt-support">{proposal.rationale}</p>
      </div>

      {/* Redline */}
      <div className="space-y-2">
        <p className="text-xs text-dt-muted uppercase tracking-wider font-medium">Changes</p>
        {proposal.redline.length > 0 ? (
          proposal.redline.map((change, idx) => (
            <div key={idx} className="bg-dt-inset border border-dt-border/30 rounded-lg p-2.5 text-xs space-y-1">
              <p className="text-dt-support font-mono">{change.field}</p>
              <div className="space-y-0.5">
                <div className="text-red-400">
                  <span className="opacity-60">- </span>{change.old}
                </div>
                <div className="text-emerald-400">
                  <span className="opacity-60">+ </span>{change.new}
                </div>
              </div>
              {change.note && <p className="text-dt-muted italic">{change.note}</p>}
            </div>
          ))
        ) : (
          <p className="text-xs text-dt-muted">No field changes (configuration only)</p>
        )}
      </div>

      {/* Evidence */}
      {proposal.evidence && (proposal.evidence.replay_status || proposal.evidence.golden_set_impact) && (
        <div className="bg-dt-inset border border-dt-border/30 rounded-lg p-3 space-y-2">
          <p className="text-xs text-dt-muted uppercase tracking-wider font-medium">Testing Evidence</p>
          {proposal.evidence.replay_status && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-dt-support">Playbook Testing:</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                proposal.evidence.replay_status === 'passed'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : proposal.evidence.replay_status === 'failed'
                    ? 'bg-red-500/20 text-red-300'
                    : 'bg-slate-600 text-dt-support'
              }`}>
                {proposal.evidence.replay_status}
              </span>
            </div>
          )}
          {proposal.evidence.replay_score_before !== undefined && proposal.evidence.replay_score_after !== undefined && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-dt-support">Score:</span>
              <span className="text-dt-support">
                {proposal.evidence.replay_score_before.toFixed(2)} → {proposal.evidence.replay_score_after.toFixed(2)}
              </span>
            </div>
          )}
          {proposal.evidence.golden_set_impact && (
            <p className="text-xs text-dt-support">Golden set: {proposal.evidence.golden_set_impact}</p>
          )}
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-900/20 border border-red-700/50 rounded-lg p-2">
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      {/* Metadata */}
      <div className="flex items-center justify-between text-xs text-dt-muted pt-1 border-t border-dt-border">
        <span>{new Date(proposal.created_at).toLocaleDateString()}</span>
        <span>by {proposal.created_by}</span>
      </div>

      {/* Actions */}
      {(proposal.status === 'proposed' || proposal.status === 'approved') && (
        <div className="flex gap-2 pt-2 border-t border-dt-border">
          {proposal.status === 'proposed' && (
            <>
              <button
                onClick={handleApprove}
                disabled={approving || rejecting}
                className="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg text-xs font-medium text-white transition-colors">
                {approving ? 'Approving...' : 'Approve'}
              </button>
              <button
                onClick={handleReject}
                disabled={approving || rejecting}
                className="flex-1 px-3 py-2 bg-dt-panel hover:bg-dt-panel disabled:opacity-50 rounded-lg text-xs font-medium transition-colors">
                {rejecting ? 'Rejecting...' : 'Dismiss'}
              </button>
            </>
          )}
          {proposal.status === 'approved' && (
            <div className="text-xs text-emerald-400 py-2 px-3">
              ✓ Approved — awaiting application
            </div>
          )}
        </div>
      )}
    </div>
  )
}
