import React, { useState } from 'react';
import { recordTrainingFeedback, getDeploymentStage } from '../../lib/workforceApi';
import { BookOpen, CheckCircle, AlertCircle } from './icons';

interface DETrainingPanelProps {
  deId: string;
}

export function DETrainingPanel({ deId }: DETrainingPanelProps) {
  const [currentStage, setCurrentStage] = useState<string>('');
  const [feedbackType, setFeedbackType] = useState<'approval' | 'correction' | 'suggestion'>('approval');
  const [humanDecision, setHumanDecision] = useState('');
  const [correctionDetail, setCorrectionDetail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  React.useEffect(() => {
    const loadStage = async () => {
      const stage = await getDeploymentStage(deId);
      setCurrentStage(stage || '');
    };
    loadStage();
  }, [deId]);

  const handleSubmitFeedback = async () => {
    if (!humanDecision.trim()) {
      setMessage({ type: 'error', text: 'Please describe your feedback' });
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await recordTrainingFeedback(
        deId,
        humanDecision,
        feedbackType,
        feedbackType === 'correction'
          ? { from: '', to: correctionDetail || '', reasoning: '' }
          : undefined,
        feedbackType === 'correction'
      );

      setMessage({
        type: 'success',
        text: `Feedback recorded.${result.applied_to_charter ? ' Charter updated.' : ''}${result.should_promote_stage ? ' Ready for next stage!' : ''}`,
      });

      setHumanDecision('');
      setCorrectionDetail('');
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to record feedback',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!currentStage || !['shadow', 'co-pilot'].includes(currentStage)) {
    return null; // Only show for shadow/co-pilot stages
  }

  return (
    <div className="bg-slate-800 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <BookOpen className="w-4 h-4 text-blue-400" />
        <h3 className="font-bold text-slate-100">Train This DE</h3>
        <span className="text-xs bg-blue-900 text-blue-200 px-2 py-1 rounded ml-auto">
          {currentStage.toUpperCase()}
        </span>
      </div>

      <div className="space-y-3">
        {/* Feedback type */}
        <div>
          <label className="text-xs text-slate-400 block mb-1">Feedback Type</label>
          <select
            value={feedbackType}
            onChange={(e) => setFeedbackType(e.target.value as any)}
            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-sm"
          >
            <option value="approval">✓ Approval (DE did well)</option>
            <option value="correction">✎ Correction (DE should do this instead)</option>
            <option value="suggestion">💡 Suggestion (alternative approach)</option>
          </select>
        </div>

        {/* Human decision */}
        <div>
          <label className="text-xs text-slate-400 block mb-1">Your Decision / Feedback</label>
          <textarea
            value={humanDecision}
            onChange={(e) => setHumanDecision(e.target.value)}
            placeholder="e.g., 'This response was too formal. Customers need more empathy.'"
            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-sm h-16 resize-none"
          />
        </div>

        {/* Correction detail (if correction) */}
        {feedbackType === 'correction' && (
          <div>
            <label className="text-xs text-slate-400 block mb-1">What should it do instead?</label>
            <textarea
              value={correctionDetail}
              onChange={(e) => setCorrectionDetail(e.target.value)}
              placeholder="e.g., 'Acknowledge their frustration, use simpler language, offer a specific solution'"
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-sm h-12 resize-none"
            />
          </div>
        )}

        {/* Submit button */}
        <button
          onClick={handleSubmitFeedback}
          disabled={isSubmitting}
          className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white text-sm rounded transition"
        >
          {isSubmitting ? 'Recording...' : 'Record Feedback'}
        </button>

        {/* Message */}
        {message && (
          <div
            className={`flex items-start gap-2 p-2 rounded text-xs ${
              message.type === 'success'
                ? 'bg-green-900 text-green-200'
                : 'bg-red-900 text-red-200'
            }`}
          >
            {message.type === 'success' ? (
              <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            )}
            <span>{message.text}</span>
          </div>
        )}
      </div>
    </div>
  );
}
