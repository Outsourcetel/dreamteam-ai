import React, { useState, useEffect } from 'react'
import type { PendingAmendment, EntityKind } from '../lib/amendmentApi'
import { listPendingAmendments } from '../lib/amendmentApi'
import { AmendmentReviewCard } from './AmendmentReviewCard'
import { getAmendmentDetail } from '../lib/amendmentApi'
import type { AmendmentProposal } from '../lib/amendmentApi'

export function PendingAmendmentsWidget({
  entity_kind,
  entity_id,
  onAmendmentsChange,
}: {
  entity_kind: EntityKind
  entity_id: string
  onAmendmentsChange?: (count: number) => void
}) {
  const [pending, setPending] = useState<PendingAmendment[]>([])
  const [expanded, setExpanded] = useState(false)
  const [details, setDetails] = useState<Map<string, AmendmentProposal>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadAmendments()
  }, [entity_kind, entity_id])

  const loadAmendments = async () => {
    setLoading(true)
    const amendments = await listPendingAmendments(entity_kind, entity_id)
    setPending(amendments)
    onAmendmentsChange?.(amendments.length)

    // Load details for display
    const newDetails = new Map()
    for (const amendment of amendments) {
      const detail = await getAmendmentDetail(amendment.amendment_id)
      if (detail) {
        newDetails.set(amendment.amendment_id, detail)
      }
    }
    setDetails(newDetails)
    setLoading(false)
  }

  if (loading) {
    return <div className="text-xs text-slate-500">Loading amendments...</div>
  }

  if (pending.length === 0) {
    return null
  }

  return (
    <div className="space-y-2">
      {/* Badge */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded-lg hover:border-amber-500/50 transition-colors">
        <span className="text-xs font-medium text-amber-300">
          {pending.length} pending amendment{pending.length !== 1 ? 's' : ''}
        </span>
        <span className="text-amber-400">{expanded ? '▼' : '▶'}</span>
      </button>

      {/* Expanded List */}
      {expanded && (
        <div className="space-y-3 mt-3 border-t border-slate-700 pt-3">
          {pending.map(amendment => {
            const detail = details.get(amendment.amendment_id)
            return detail ? (
              <AmendmentReviewCard
                key={amendment.amendment_id}
                proposal={detail}
                onApprove={() => {
                  setPending(pending.filter(a => a.amendment_id !== amendment.amendment_id))
                  onAmendmentsChange?.(pending.length - 1)
                }}
                onReject={() => {
                  setPending(pending.filter(a => a.amendment_id !== amendment.amendment_id))
                  onAmendmentsChange?.(pending.length - 1)
                }}
              />
            ) : null
          })}
        </div>
      )}
    </div>
  )
}
