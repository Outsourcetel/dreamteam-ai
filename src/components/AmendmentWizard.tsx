// ── Improve by Describing — Amendment Wizard ─────────────────────────
// 5-step conversational journey: problem → context → working → proposal → done
// Reuses hire wizard patterns: flat state, error-as-data, phase messaging, step-conditional rendering.

import { useState } from 'react';
import {
  requestAmendment,
  approveAmendment,
  rejectAmendment,
  describeAmendmentStatus,
  type EntityKind,
  type AmendmentProposal,
} from '../lib/amendmentApi';
import AmendmentReviewCard from './AmendmentReviewCard';

type Step = 'problem' | 'context' | 'working' | 'proposal' | 'done';

const ENTITY_EXAMPLES: Record<EntityKind, string[]> = {
  de: [
    'This employee keeps saying we offer free shipping but we don't',
    'It escalates too often — should try harder to solve things itself',
    'It doesn't know our pricing and frequently gives wrong quotes',
  ],
  playbook: [
    'This step asks for sensitive information we shouldn't request',
    'This step takes too long and blocks too many tickets',
    'We changed our workflow and this step no longer fits',
  ],
  specialist: [
    'It frequently gives incorrect information about our products',
    'It's too slow to answer questions compared to before',
    'It should not be consulted for billing questions anymore',
  ],
};

export default function AmendmentWizard({
  entity_kind,
  entity_id,
  entity_name,
  onClose,
  onFinished,
}: {
  entity_kind: EntityKind;
  entity_id: string;
  entity_name: string;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [step, setStep] = useState<Step>('problem');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [problem, setProblem] = useState('');
  const [context, setContext] = useState('');
  const [proposal, setProposal] = useState<AmendmentProposal | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);

  const examples = ENTITY_EXAMPLES[entity_kind];

  const doRequest = async () => {
    if (problem.trim().length < 20) {
      setError('Describe the issue — what's not working? (at least 20 characters)');
      return;
    }

    setBusy(true);
    setError(null);
    setPhase('Analyzing the problem and gathering context…');

    try {
      const prop = await requestAmendment({
        entity_kind,
        entity_id,
        problem: problem.trim(),
        trigger: 'user_feedback',
        context: context.trim().length > 0 ? {user_notes: context} : undefined,
      });

      setProposal(prop);
      setStep('proposal');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to draft amendment');
    } finally {
      setBusy(false);
      setPhase('');
    }
  };

  const doApprove = async () => {
    if (!proposal) return;
    setIsApproving(true);
    setApprovalError(null);

    try {
      await approveAmendment(proposal.amendment_id);
      setStep('done');
    } catch (e) {
      setApprovalError(e instanceof Error ? e.message : 'Failed to approve amendment');
    } finally {
      setIsApproving(false);
    }
  };

  const doReject = async () => {
    if (!proposal) return;
    setIsApproving(true);
    setApprovalError(null);

    try {
      await rejectAmendment(proposal.amendment_id, 'User dismissed proposal');
      onFinished();
      onClose();
    } catch (e) {
      setApprovalError(e instanceof Error ? e.message : 'Failed to dismiss amendment');
    } finally {
      setIsApproving(false);
    }
  };

  const stepTitle = {
    problem: 'What's not working?',
    context: 'Tell me more (optional)',
    working: 'Drafting your amendment…',
    proposal: 'Here's what I propose',
    done: 'Amendment approved',
  }[step];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/70">
          <div>
            <h2 className="text-base font-semibold text-white">✨ Improve {entity_name}</h2>
            <p className="text-xs text-slate-500 mt-0.5">{stepTitle}</p>
          </div>
          {!busy && !isApproving && (
            <button onClick={onClose} className="text-slate-500 hover:text-white text-sm px-2 py-1">
              ✕
            </button>
          )}
        </div>

        <div className="p-6 space-y-5">
          {error && (
            <div className="rounded-xl border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          )}
          {approvalError && (
            <div className="rounded-xl border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {approvalError}
            </div>
          )}

          {/* ── Step 1: problem ── */}
          {step === 'problem' && (
            <>
              <p className="text-sm text-slate-300">
                Describe what's not working. Be specific — the more details, the better the amendment.
              </p>
              <textarea
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                rows={5}
                placeholder="e.g. This employee keeps saying we offer free shipping but we don't…"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none resize-none"
              />
              <div className="flex flex-wrap gap-2">
                {examples.map((ex, i) => (
                  <button
                    key={i}
                    onClick={() => setProblem(ex)}
                    className="text-[11px] px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 text-left max-w-full truncate"
                    style={{maxWidth: '100%'}}
                  >
                    {ex.slice(0, 60)}…
                  </button>
                ))}
              </div>
              <button
                onClick={() => setStep('context')}
                disabled={busy || problem.trim().length < 20}
                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium disabled:opacity-60 transition-colors"
              >
                Continue
              </button>
            </>
          )}

          {/* ── Step 2: context ── */}
          {step === 'context' && (
            <>
              <p className="text-sm text-slate-300">
                Any additional context? (optional — you can skip this)
              </p>
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                rows={4}
                placeholder="e.g. This started happening last week, affects about 10% of interactions, usually happens with new customers…"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none resize-none"
              />
              <div className="flex gap-3">
                <button
                  onClick={doRequest}
                  disabled={busy}
                  className="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium disabled:opacity-60 transition-colors"
                >
                  {busy ? phase || 'Working…' : 'Draft amendment'}
                </button>
                <button
                  onClick={doRequest}
                  disabled={busy}
                  className="px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300 text-sm font-medium disabled:opacity-60 transition-colors"
                >
                  Skip
                </button>
              </div>
            </>
          )}

          {/* ── Step 3: working ── */}
          {step === 'working' && (
            <div className="py-10 text-center space-y-4">
              <div className="mx-auto w-10 h-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
              <p className="text-sm text-slate-300">{phase || 'Working…'}</p>
              <p className="text-[11px] text-slate-500">
                {entity_kind === 'playbook'
                  ? 'Testing the amendment on a similar scenario…'
                  : 'Preparing your amendment proposal…'}
              </p>
            </div>
          )}

          {/* ── Step 4: proposal ── */}
          {step === 'proposal' && proposal && (
            <>
              <AmendmentReviewCard amendment={proposal} entity_kind={entity_kind} />
              <p className="text-xs text-slate-400 mt-4">
                Review the proposal above. You can approve it to apply the change, or dismiss if you'd like to try
                again.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={doApprove}
                  disabled={isApproving}
                  className="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium disabled:opacity-60 transition-colors"
                >
                  {isApproving ? 'Approving…' : 'Approve this change'}
                </button>
                <button
                  onClick={doReject}
                  disabled={isApproving}
                  className="px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300 text-sm font-medium disabled:opacity-60 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </>
          )}

          {/* ── Step 5: done ── */}
          {step === 'done' && proposal && (
            <>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                <p className="text-sm font-semibold text-white mb-2">✓ Amendment approved</p>
                {entity_kind === 'de' && (
                  <p className="text-xs text-slate-400">
                    {entity_name}'s configuration has been updated immediately. You can view the changes on their profile.
                  </p>
                )}
                {entity_kind === 'playbook' && (
                  <p className="text-xs text-slate-400">
                    The amendment has been applied as a draft. Review and publish it from the Playbook Builder when ready.
                  </p>
                )}
                {entity_kind === 'specialist' && (
                  <p className="text-xs text-slate-400">
                    {entity_name}'s charter has been updated. The change takes effect immediately.
                  </p>
                )}
              </div>
              <button
                onClick={() => {
                  onFinished();
                  onClose();
                }}
                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                View {entity_kind === 'playbook' ? 'playbook' : 'profile'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
