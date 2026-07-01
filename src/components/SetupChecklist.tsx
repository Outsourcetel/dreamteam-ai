import React, { useEffect, useState } from 'react';
import type { Page } from '../types';
import { fetchSetupChecklist, type SetupStep } from '../lib/api';

const DISMISS_KEY = (tenantId: string) => `dt_checklist_dismissed_${tenantId}`;

export const SetupChecklist = ({
  tenantId,
  accentColor,
  setPage,
}: {
  tenantId: string;
  accentColor?: string;
  setPage?: (p: Page) => void;
}) => {
  const accent = accentColor || '#6366f1';
  const [steps, setSteps] = useState<SetupStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISS_KEY(tenantId)) === '1') { setDismissed(true); setLoading(false); return; }
    } catch {}
    fetchSetupChecklist(tenantId).then(s => { setSteps(s); setLoading(false); });
  }, [tenantId]);

  if (dismissed || loading) return null;

  const done = steps.filter(s => s.done).length;
  const total = steps.length;
  const allDone = done === total;
  const pct = Math.round((done / total) * 100);

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY(tenantId), '1'); } catch {}
    setDismissed(true);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl mb-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-4 cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-sm font-semibold text-white">
              {allDone ? 'Setup complete' : 'Getting started'}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              allDone ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-700 text-slate-400'
            }`}>
              {done}/{total} done
            </span>
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden w-full max-w-xs">
            <div className="h-full rounded-full transition-all duration-500"
              style={{ width: pct + '%', backgroundColor: allDone ? '#10b981' : accent }} />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {allDone && (
            <button onClick={e => { e.stopPropagation(); dismiss(); }}
              className="text-xs text-slate-500 hover:text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-600 transition-all">
              Dismiss
            </button>
          )}
          <span className="text-slate-600 text-sm select-none">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Steps */}
      {expanded && (
        <div className="border-t border-slate-800 divide-y divide-slate-800/60">
          {steps.map(step => (
            <div key={step.id} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-800/30 transition-all group">
              {/* Status icon */}
              <div className={`w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold transition-all ${
                step.done ? 'bg-emerald-500 text-white' : 'bg-slate-800 border border-slate-700 text-slate-600'
              }`}>
                {step.done ? '✓' : ''}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${step.done ? 'text-slate-500 line-through' : 'text-white'}`}>
                  {step.label}
                </div>
                {!step.done && (
                  <div className="text-xs text-slate-500 mt-0.5">{step.description}</div>
                )}
              </div>

              {/* CTA */}
              {!step.done && setPage && (
                <button
                  onClick={() => setPage(step.page as Page)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-all flex-shrink-0 opacity-0 group-hover:opacity-100"
                >
                  {step.cta} →
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {allDone && expanded && (
        <div className="border-t border-slate-800 px-5 py-3 flex items-center gap-3">
          <span className="text-emerald-400 text-sm">✓</span>
          <span className="text-xs text-slate-400">Your workspace is fully configured. Your Digital Employees are ready to serve customers.</span>
        </div>
      )}
    </div>
  );
};

export default SetupChecklist;
