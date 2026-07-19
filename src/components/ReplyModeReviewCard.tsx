import React, { useState } from 'react'
import type { DraftResponse } from '../lib/replyModeApi'
import { approveDraft, rejectDraft } from '../lib/replyModeApi'

interface ReplyModeReviewCardProps {
  draft: DraftResponse
  onApprove?: () => void
  onReject?: () => void
}

export function ReplyModeReviewCard({ draft, onApprove, onReject }: ReplyModeReviewCardProps) {
  const [approving, setApproving] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [editedContent, setEditedContent] = useState(draft.draft_content)
  const [rejectReason, setRejectReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleApprove = async () => {
    setApproving(true)
    try {
      await approveDraft(draft.draft_id, {
        edited_content: editMode ? editedContent : undefined,
      })
      onApprove?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to approve')
    } finally {
      setApproving(false)
    }
  }

  const handleReject = async () => {
    if (!rejectReason.trim()) {
      setError('Please provide a reason for rejection')
      return
    }
    setRejecting(true)
    try {
      await rejectDraft(draft.draft_id, rejectReason)
      onReject?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reject')
    } finally {
      setRejecting(false)
    }
  }

  const confidenceColor =
    draft.confidence === undefined
      ? 'text-slate-400'
      : draft.confidence >= 0.85
        ? 'text-emerald-400'
        : draft.confidence >= 0.7
          ? 'text-amber-400'
          : 'text-red-400'

  const expiresIn = Math.max(0, Math.floor((new Date(draft.expires_at).getTime() - Date.now()) / 60000))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-2xl max-h-[90vh] bg-slate-800 border border-slate-600 rounded-xl shadow-2xl flex flex-col">
        {/* Header */}
        <div className="border-b border-slate-700 px-6 py-4">
          <div className="flex items-center justify-between gap-4 mb-2">
            <h2 className="text-lg font-semibold text-white">Review Draft Response</h2>
            <div className="text-xs text-slate-400">Expires in {expiresIn}m</div>
          </div>
          <p className="text-sm text-slate-400">Question: {draft.user_question}</p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Confidence Badge */}
          {draft.confidence !== undefined && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-400">Confidence:</span>
              <span className={`text-sm font-semibold ${confidenceColor}`}>
                {(draft.confidence * 100).toFixed(0)}%
              </span>
              {draft.confidence < 0.7 && (
                <span className="text-xs text-red-300">⚠ Low confidence — consider editing or rejecting</span>
              )}
            </div>
          )}

          {/* Draft Content (Read-Only or Edit) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-slate-400">Draft Response</label>
              {!editMode && (
                <button
                  onClick={() => setEditMode(true)}
                  className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded transition-colors"
                >
                  ✎ Edit
                </button>
              )}
            </div>
            {editMode ? (
              <textarea
                value={editedContent}
                onChange={e => setEditedContent(e.target.value)}
                className="w-full h-32 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            ) : (
              <div className="bg-slate-900/50 border border-slate-700/50 rounded px-4 py-3 text-sm text-slate-200 whitespace-pre-wrap">
                {draft.draft_content}
              </div>
            )}
          </div>

          {/* Sources */}
          {draft.sources && draft.sources.length > 0 && (
            <div>
              <label className="text-xs font-medium text-slate-400 block mb-2">Sources</label>
              <div className="space-y-1">
                {draft.sources.map((source, idx) => (
                  <a
                    key={idx}
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs text-indigo-400 hover:text-indigo-300 underline truncate"
                    title={source.url}
                  >
                    {source.title}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Rejection Reason (only shown if rejecting) */}
          {rejecting && (
            <div>
              <label className="text-xs font-medium text-slate-400 block mb-2">Reason for Rejection</label>
              <textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                placeholder="Why are you rejecting this draft? (sent to DE for improvement)"
                className="w-full h-20 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-red-500"
              />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-900/20 border border-red-700/50 rounded p-2">
              <p className="text-xs text-red-300">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-700 px-6 py-4 flex gap-2">
          {!rejecting ? (
            <>
              <button
                onClick={() => setRejecting(true)}
                className="flex-1 px-4 py-2 bg-slate-700 hover:bg-red-900/40 text-red-300 rounded text-xs font-medium transition-colors"
              >
                ✗ Reject
              </button>
              <button
                onClick={handleApprove}
                disabled={approving}
                className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded text-xs font-medium text-white transition-colors"
              >
                {approving ? 'Approving...' : editMode ? '✓ Approve (Edited)' : '✓ Approve'}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setRejecting(false)}
                className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-xs font-medium transition-colors"
              >
                Cancel Rejection
              </button>
              <button
                onClick={handleReject}
                disabled={rejecting || !rejectReason.trim()}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded text-xs font-medium text-white transition-colors"
              >
                {rejecting ? 'Rejecting...' : 'Confirm Rejection'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-slate-900/70" />
    </div>
  )
}
