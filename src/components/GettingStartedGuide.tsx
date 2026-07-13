import React, { useState } from 'react';
import type { Page } from '../types';

/**
 * Getting Started guide — the always-available front door to setup.
 *
 * Shown on the Command Centre for every live workspace (new AND existing).
 * A customer can hide it once they feel set up, but it NEVER vanishes for
 * good: hiding collapses it to a persistent "Setup guide" chip that
 * re-opens it — customers can return to it as many times as they need
 * while they finish getting ready. Quick Start also stays in the sidebar.
 *
 * The hidden/shown preference is per-workspace (localStorage keyed by
 * tenant id), so hiding it in one workspace doesn't hide it in another.
 */
export default function GettingStartedGuide({
  setPage, tenantId,
}: { setPage: (p: Page) => void; tenantId?: string }) {
  const key = `dt_setup_guide_hidden_${tenantId || 'default'}`;
  const [hidden, setHidden] = useState<boolean>(() => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  });
  const hide = () => { try { localStorage.setItem(key, '1'); } catch { /* ignore */ } setHidden(true); };
  const reopen = () => { try { localStorage.removeItem(key); } catch { /* ignore */ } setHidden(false); };

  // Collapsed state — a small, permanent way back in.
  if (hidden) {
    return (
      <button
        onClick={reopen}
        className="self-start inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white hover:border-indigo-500/50 transition-colors"
      >
        <span className="text-indigo-400">✦</span> Setup guide
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-indigo-500/25 bg-gradient-to-br from-indigo-500/10 to-slate-900/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-300 text-lg">✦</div>
          <div className="min-w-0">
            <h2 className="text-white font-semibold text-[15px]">Set up your AI workforce</h2>
            <p className="text-slate-300 text-[13.5px] mt-1 max-w-2xl leading-relaxed">
              Tell Ada, your Onboarding Architect, about your business in one sentence — she proposes the
              Digital Employees, playbooks and connectors you need. You approve what you want; nothing is
              created until you do.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => setPage('onboarding_architect')}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors"
              >
                Open Quick Start →
              </button>
              <button
                onClick={() => setPage('knowledge_library')}
                className="rounded-lg border border-slate-700 px-3 py-2 text-[13px] text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
              >
                Add your knowledge
              </button>
              <button
                onClick={() => setPage('systems_connectors')}
                className="rounded-lg border border-slate-700 px-3 py-2 text-[13px] text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
              >
                Connect a system
              </button>
            </div>
          </div>
        </div>
        <button
          onClick={hide}
          title="Hide the setup guide (you can reopen it anytime)"
          className="flex-none text-xs text-slate-500 hover:text-white transition-colors"
        >
          Hide ✕
        </button>
      </div>
      <p className="mt-3 text-[11px] text-slate-500">
        Hiding this keeps it a click away — reopen it anytime from the “Setup guide” button until you're fully set up.
      </p>
    </div>
  );
}
