import React, { useEffect, useState } from 'react';
import type { Page } from '../types';
import { supabase } from '../supabase';

/**
 * Getting Started — ONE sequential first-run path (P0 structural bet #1).
 *
 * Replaces the old "three equal buttons" pattern (Quick Start / knowledge /
 * connectors all side-by-side) with an ordered checklist whose completion is
 * computed from REAL workspace state, not clicks:
 *   1. Hire  — a Digital Employee exists (besides Ada, who every workspace gets)
 *   2. Teach — at least one knowledge document exists
 *   3. Test  — a question has been asked (any chat message exists)
 *   4. Launch— an active widget key exists (chat installable on their site)
 * The current step is highlighted with ONE primary action; later steps stay
 * clickable (guidance, not a cage). All four done → compact success state.
 *
 * Ada remains the hero of step 1 — "hire with Ada" is the differentiator,
 * the wizard is the fallback. Hide collapses to a persistent chip
 * (per-workspace localStorage), never disappears for good.
 */

interface StepState { hired: boolean; taught: boolean; tested: boolean; launched: boolean }

async function loadStepState(tenantId?: string): Promise<StepState> {
  // Signup auto-provisions Ada AND starter DEs in the same transaction, so
  // "any DE exists" is a false-positive for a brand-new workspace. A hire
  // only counts if it happened meaningfully AFTER the workspace was created
  // (2-minute buffer — provisioning is same-transaction, seconds at most).
  let hireThreshold: string | null = null;
  if (tenantId) {
    const { data: t } = await supabase.from('tenants').select('created_at').eq('id', tenantId).maybeSingle();
    if (t?.created_at) hireThreshold = new Date(new Date(t.created_at).getTime() + 2 * 60 * 1000).toISOString();
  }
  let deQuery = supabase.from('digital_employees').select('id', { count: 'exact', head: true })
    .neq('name', 'DreamTeam Onboarding Architect');
  if (hireThreshold) deQuery = deQuery.gt('created_at', hireThreshold);
  const [des, docs, msgs, keys] = await Promise.all([
    deQuery,
    supabase.from('knowledge_docs').select('id', { count: 'exact', head: true }),
    supabase.from('de_messages').select('id', { count: 'exact', head: true }),
    supabase.from('widget_keys').select('id', { count: 'exact', head: true }).eq('active', true),
  ]);
  return {
    hired: (des.count ?? 0) > 0,
    taught: (docs.count ?? 0) > 0,
    tested: (msgs.count ?? 0) > 0,
    launched: (keys.count ?? 0) > 0,
  };
}

export default function GettingStartedGuide({
  setPage, tenantId,
}: { setPage: (p: Page) => void; tenantId?: string }) {
  const key = `dt_setup_guide_hidden_${tenantId || 'default'}`;
  const [hidden, setHidden] = useState<boolean>(() => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  });
  const [state, setState] = useState<StepState | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadStepState(tenantId).then(s => { if (!cancelled) setState(s); }).catch(() => { if (!cancelled) setState({ hired: false, taught: false, tested: false, launched: false }); });
    return () => { cancelled = true; };
  }, [tenantId]);

  const hide = () => { try { localStorage.setItem(key, '1'); } catch { /* ignore */ } setHidden(true); };
  const reopen = () => { try { localStorage.removeItem(key); } catch { /* ignore */ } setHidden(false); };

  if (hidden) {
    return (
      <button onClick={reopen}
        className="self-start inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white hover:border-indigo-500/50 transition-colors">
        <span className="text-indigo-400">✦</span> Setup guide
      </button>
    );
  }

  type Step = {
    done: boolean; title: string; body: string;
    primary: { label: string; page: Page; beforeNav?: () => void };
    secondary?: { label: string; page: Page };
  };
  const steps: Step[] = state ? [
    {
      done: state.hired, title: 'Hire your first Digital Employee',
      body: 'Tell Ada about your business in a sentence — she proposes the team; you approve. Or pick roles yourself with the wizard.',
      primary: { label: 'Hire with Ada →', page: 'onboarding_architect' as Page },
      secondary: { label: 'Use the setup wizard', page: 'company_setup' as Page },
    },
    {
      done: state.taught, title: 'Teach it your business',
      body: 'Upload documents or add pages from your website — your employee answers only from what you give it.',
      primary: { label: 'Add knowledge →', page: 'knowledge_library' as Page },
    },
    {
      done: state.tested, title: 'Ask it a question',
      body: 'Try it yourself before customers do. Ask something your documents cover and check the answer and its sources.',
      primary: { label: 'Meet your employees →', page: 'workforce_des' as Page },
    },
    {
      done: state.launched, title: 'Put it on your website',
      body: 'Create a widget key and drop one line of code into your site — or share the hosted chat link.',
      // One-shot hint so Settings opens on the Widget tab, not General.
      primary: { label: 'Get your widget key →', page: 'settings' as Page, beforeNav: () => { try { localStorage.setItem('dt_settings_tab', 'widget'); } catch { /* ignore */ } } },
    },
  ] : [];

  const doneCount = steps.filter(s => s.done).length;
  const allDone = state != null && doneCount === steps.length;
  const currentIdx = steps.findIndex(s => !s.done);

  if (allDone) {
    return (
      <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 to-slate-800/40 px-5 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300">✓</span>
          <div>
            <p className="text-white font-semibold text-[14px]">Your AI workforce is live</p>
            <p className="text-slate-400 text-xs mt-0.5">Hired, taught, tested and on your website. Watch it work in Performance, or hire for another role anytime.</p>
          </div>
        </div>
        <button onClick={hide} className="flex-none text-xs text-slate-500 hover:text-white transition-colors">Hide ✕</button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-indigo-500/25 bg-gradient-to-br from-indigo-500/10 to-slate-800/40 p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-300 text-lg">✦</div>
          <div>
            <h2 className="text-white font-semibold text-[15px]">Set up your AI workforce</h2>
            <p className="text-slate-400 text-xs mt-0.5">
              {state == null ? 'Checking your progress…' : `${doneCount} of ${steps.length} steps done — about 10 minutes total.`}
            </p>
          </div>
        </div>
        <button onClick={hide} title="Hide (reopen anytime from the Setup guide button)"
          className="flex-none text-xs text-slate-500 hover:text-white transition-colors">Hide ✕</button>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-slate-700/60 mb-4 overflow-hidden">
        <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500"
          style={{ width: state == null ? '4%' : `${Math.max(4, (doneCount / steps.length) * 100)}%` }} />
      </div>

      <ol className="space-y-2">
        {steps.map((s, i) => {
          const isCurrent = i === currentIdx;
          return (
            <li key={s.title}
              className={`rounded-xl px-4 py-3 transition-colors ${isCurrent ? 'bg-slate-800/80 border border-indigo-500/40' : 'bg-slate-800/30 border border-transparent'}`}>
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold ${
                  s.done ? 'bg-emerald-500/20 text-emerald-300' : isCurrent ? 'bg-indigo-500 text-white' : 'bg-slate-700 text-slate-400'
                }`}>{s.done ? '✓' : i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className={`text-[13.5px] font-medium ${s.done ? 'text-slate-400 line-through decoration-slate-600' : 'text-white'}`}>{s.title}</p>
                  {isCurrent && (
                    <>
                      <p className="text-slate-300 text-[13px] mt-1 leading-relaxed">{s.body}</p>
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <button onClick={() => { s.primary.beforeNav?.(); setPage(s.primary.page); }}
                          className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-indigo-500 transition-colors">
                          {s.primary.label}
                        </button>
                        {s.secondary && (
                          <button onClick={() => setPage(s.secondary.page)}
                            className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:text-white hover:border-slate-500 transition-colors">
                            {s.secondary.label}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {!s.done && !isCurrent && (
                  <button onClick={() => { s.primary.beforeNav?.(); setPage(s.primary.page); }}
                    className="flex-none text-[11px] text-slate-500 hover:text-indigo-300 transition-colors mt-1">
                    Jump ahead →
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
