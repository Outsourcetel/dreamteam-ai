import React, { useState } from 'react'
import type { EntityKind } from '../lib/amendmentApi'
import { requestAmendment } from '../lib/amendmentApi'
import { AmendmentReviewCard } from './AmendmentReviewCard'
import type { AmendmentProposal } from '../lib/amendmentApi'

const PHASE_MESSAGES = [
  'Analyzing your feedback...',
  'Understanding current state...',
  'Drafting improvements...',
  'Testing against golden set...',
  'Preparing proposal...',
]

export function AmendmentWizard({
  entity_kind,
  entity_id,
  entity_name,
  onClose,
  onSuccess,
}: {
  entity_kind: EntityKind
  entity_id: string
  entity_name: string
  onClose: () => void
  onSuccess?: () => void
}) {
  const [step, setStep] = useState<'problem' | 'context' | 'working' | 'proposal' | 'done'>('problem')
  const [problem, setProblem] = useState('')
  const [context, setContext] = useState('')
  const [phaseIdx, setPhaseIdx] = useState(0)
  const [proposal, setProposal] = useState<AmendmentProposal | null>(null)
  const [error, setError] = useState<string | null>(null)

  const contextPlaceholders: Record<EntityKind, string> = {
    de: 'e.g., Last 7 days: confidence 45%, escalation 35%, errors in billing responses',
    playbook: 'e.g., Step 3 fails 60% of time, customer frustration high',
    specialist: 'e.g., Verdicts overriding 40% of recommendations, trust degrading',
  }

  const problemExamples: Record<EntityKind, string[]> = {
    de: [
      'Says we offer free shipping but we do not',
      'Too cautious — escalates everything',
      'Misses nuance in billing edge cases',
    ],
    playbook: [
      'First step should ask email instead',
      'Step needs a human handoff for complex cases',
      'Should check knowledge base first',
    ],
    specialist: [
      'Judgments are too conservative',
      'Better reasoning needed for edge cases',
      'Weight recent feedback more heavily',
    ],
  }

  const handleStartAmendment = async () => {
    if (!problem.trim() || problem.length < 20) {
      setError('Please describe issue (20+ characters)')
      return
    }

    setError(null)
    setStep('working')

    const interval = setInterval(() => {
      setPhaseIdx(prev => (prev < PHASE_MESSAGES.length - 1 ? prev + 1 : prev))
    }, 800)

    try {
      const result = await requestAmendment({
        entity_kind,
        entity_id,
        problem: problem.trim(),
        trigger: 'user_feedback',
      })

      clearInterval(interval)

      if (result) {
        setProposal(result)
        setStep('proposal')
      } else {
        setError('Failed to generate proposal')
        setStep('problem')
      }
    } catch (e) {
      clearInterval(interval)
      setError(e instanceof Error ? e.message : 'Error')
      setStep('problem')
    }
  }

  const handleApproveProposal = () => {
    if (!proposal) return
    setStep('done')
    onSuccess?.()
  }

  const handleDismissProposal = () => {
    setStep('problem')
    setProblem('')
    setContext('')
    setPhaseIdx(0)
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/70" onClick={onClose} />

      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-2xl max-h-[90vh] bg-slate-800 border border-slate-600 rounded-xl shadow-2xl overflow-hidden flex flex-col">
          <div className="flex-shrink-0 border-b border-slate-700 px-6 py-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Improve {entity_name}</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {step === 'problem' && 'Step 1: Describe the issue'}
                {step === 'context' && 'Step 2: Add context'}
                {step === 'working' && 'Generating proposal...'}
                {step === 'proposal' && 'Review proposal'}
                {step === 'done' && 'Submitted'}
              </p>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl">
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {step === 'problem' && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-2">
                    What is not working?
                  </label>
                  <textarea
                    autoFocus
                    rows={4}
                    value={problem}
                    onChange={e => { setProblem(e.target.value); setError(null) }}
                    placeholder="Describe the issue..."
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-none"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    {problem.length < 20 ? `${20 - problem.length} more chars` : '✓ Ready'}
                  </p>
                </div>

                <div className="bg-slate-900/50 rounded-lg p-3 space-y-1.5">
                  <p className="text-xs text-slate-500 font-medium">Examples:</p>
                  {problemExamples[entity_kind].map((ex, i) => (
                    <button
                      key={i}
                      onClick={() => setProblem(ex)}
                      className="text-left text-xs text-slate-400 hover:text-indigo-400 px-2 py-1 rounded hover:bg-slate-800/50">
                      • {ex}
                    </button>
                  ))}
                </div>

                {error && (
                  <div className="bg-red-900/20 border border-red-700/50 rounded-lg p-2">
                    <p className="text-xs text-red-300">{error}</p>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => setStep('context')}
                    disabled={problem.length < 20}
                    className="flex-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-xs font-medium text-white">
                    Continue
                  </button>
                  <button onClick={onClose} className="flex-1 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {step === 'context' && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-2">Add context (optional)</label>
                  <textarea
                    rows={3}
                    value={context}
                    onChange={e => setContext(e.target.value)}
                    placeholder={contextPlaceholders[entity_kind]}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-none"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={handleStartAmendment}
                    className="flex-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-xs font-medium text-white">
                    Generate Proposal
                  </button>
                  <button onClick={() => setStep('problem')} className="flex-1 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs">
                    Back
                  </button>
                </div>
              </div>
            )}

            {step === 'working' && (
              <div className="space-y-4 py-8 text-center">
                <div className="flex justify-center">
                  <div className="w-12 h-12 border-4 border-slate-600 border-t-indigo-500 rounded-full animate-spin" />
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-slate-200">{PHASE_MESSAGES[phaseIdx]}</p>
                  <p className="text-xs text-slate-500">{phaseIdx + 1} of {PHASE_MESSAGES.length}</p>
                </div>
              </div>
            )}

            {step === 'proposal' && proposal && (
              <AmendmentReviewCard
                proposal={proposal}
                onApprove={handleApproveProposal}
                onReject={handleDismissProposal}
              />
            )}

            {step === 'done' && (
              <div className="space-y-4 py-8 text-center">
                <div className="text-4xl text-emerald-400">✓</div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-slate-200">Amendment submitted</p>
                  <p className="text-xs text-slate-500">Proposal awaiting review.</p>
                </div>
                <button
                  onClick={onClose}
                  className="w-full px-3 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-xs font-medium text-white">
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
