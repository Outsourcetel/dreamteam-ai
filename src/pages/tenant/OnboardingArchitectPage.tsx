import React, { useState } from 'react';
import { PageHeader } from '../../components/ui';
import { useDataMode } from '../../lib/dataMode';
import type { Page } from '../../types';
import {
  runOnboardingAssist, approveProposal,
  type ArchitectProposal, type OnboardingAssistResult,
} from '../../lib/onboardingArchitectApi';

// Icon + friendly noun for each builder action.
function proposalMeta(label: string): { icon: string; kind: string } {
  const l = label.toLowerCase();
  if (l.includes('digital employee')) return { icon: '⚡', kind: 'Digital Employee' };
  if (l.includes('playbook')) return { icon: '▶', kind: 'Playbook' };
  if (l.includes('specialist')) return { icon: '◆', kind: 'Specialist desk' };
  if (l.includes('connector')) return { icon: '⟷', kind: 'Connector' };
  return { icon: '✦', kind: 'Setup step' };
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function ProposalCard({ p, onApproved }: { p: ArchitectProposal; onApproved: () => void }) {
  const [state, setState] = useState<'idle' | 'working' | 'approved' | 'error'>('idle');
  const [err, setErr] = useState('');
  const meta = proposalMeta(p.action_label);
  const params = p.params || {};
  const title = str(params.name) || str(params.display_name) || str(params.provider) || p.action_label;

  const approve = async () => {
    if (!p.task_id) { setErr('This proposal is missing its approval task.'); setState('error'); return; }
    setState('working'); setErr('');
    try {
      await approveProposal(p.task_id);
      setState('approved');
      onApproved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create this.'); setState('error');
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300 text-lg">{meta.icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">{meta.kind}</span>
          </div>
          <h4 className="text-white font-semibold leading-tight mt-0.5">{title}</h4>

          {/* Details drawn from the proposal's parameters */}
          <div className="mt-2 space-y-1 text-[13px] text-slate-300">
            {str(params.department) && <div><span className="text-slate-500">Department:</span> {str(params.department)}</div>}
            {str(params.persona_name) && <div><span className="text-slate-500">Answers as:</span> {str(params.persona_name)}</div>}
            {str(params.category) && !str(params.provider) && <div><span className="text-slate-500">Type:</span> {str(params.category)}</div>}
            {str(params.description) && <p className="text-slate-400">{str(params.description)}</p>}
            {str(params.outline) && (
              <div className="mt-1 rounded-lg bg-black/20 border border-white/5 p-2.5 whitespace-pre-wrap text-slate-400 text-[12.5px]">{str(params.outline)}</div>
            )}
            {str(params.charter) && <p className="text-slate-400">{str(params.charter)}</p>}
            {str(params.provider) && <div><span className="text-slate-500">System:</span> {str(params.provider)}</div>}
          </div>
        </div>

        <div className="flex-none">
          {state === 'approved' ? (
            <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-[13px] font-medium text-emerald-300">✓ Created</span>
          ) : (
            <button
              onClick={approve}
              disabled={state === 'working'}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {state === 'working' ? 'Creating…' : 'Approve & create'}
            </button>
          )}
        </div>
      </div>
      {state === 'error' && <p className="mt-2 text-[12.5px] text-rose-300">{err}</p>}
    </div>
  );
}

const EXAMPLES = [
  'We run a dental clinic. We want an AI employee that answers patient questions about appointments, billing, and insurance.',
  'We\'re a B2B SaaS company. We need support that handles product how-to questions and a playbook for handling refund requests.',
  'We operate a chain of gyms. We\'d like an employee to answer members\' questions about memberships, classes, and billing.',
];

export default function OnboardingArchitectPage({ setPage }: { setPage?: (p: Page) => void }) {
  const dataMode = useDataMode();
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OnboardingAssistResult | null>(null);
  const [approvedCount, setApprovedCount] = useState(0);
  const [fatal, setFatal] = useState('');

  const design = async () => {
    if (desc.trim().length < 8) return;
    setBusy(true); setResult(null); setApprovedCount(0); setFatal('');
    try {
      const r = await runOnboardingAssist(desc.trim());
      if (r.error) setFatal(r.detail || r.error);
      else setResult(r);
    } catch (e) {
      setFatal(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <PageHeader
        title="Quick Start"
        subtitle="Describe your business and Ada, your Onboarding Architect, will propose your DreamTeam setup. Nothing is created until you approve it."
      />

      {dataMode !== 'live' ? (
        <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-[13.5px] text-amber-200/90">
          Quick Start runs in your live workspace. Sign in to your own workspace to have Ada design your setup.
        </div>
      ) : (
        <>
          {/* The brief */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <label className="block text-sm font-medium text-slate-200">Tell Ada about your business</label>
            <p className="mt-1 text-[13px] text-slate-400">What do you do, and what would you like your AI team to handle for your customers?</p>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={4}
              placeholder="e.g. We run a dental clinic and want an employee that answers patient questions about appointments, billing and insurance…"
              className="mt-3 w-full resize-y rounded-xl border border-white/10 bg-black/30 p-3 text-[14px] text-white placeholder:text-slate-600 outline-none focus:border-indigo-400/60"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={design}
                disabled={busy || desc.trim().length < 8}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {busy ? 'Ada is designing your setup…' : 'Design my setup'}
              </button>
              {!busy && !result && (
                <span className="text-[12.5px] text-slate-500">Takes ~30 seconds.</span>
              )}
            </div>
            {!result && !busy && (
              <div className="mt-4 border-t border-white/5 pt-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mb-2">Need inspiration?</div>
                <div className="flex flex-col gap-1.5">
                  {EXAMPLES.map((ex) => (
                    <button key={ex} onClick={() => setDesc(ex)} className="text-left text-[13px] text-indigo-300/90 hover:text-indigo-200">“{ex}”</button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {fatal && (
            <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-400/5 p-4 text-[13.5px] text-rose-200">{fatal}</div>
          )}

          {busy && (
            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-[13.5px] text-slate-400">
              Ada is reading your brief and designing the smallest setup that fits…
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="mt-6">
              {result.status === 'rate_limited' ? (
                <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-[13.5px] text-amber-200/90">
                  Ada got busy and couldn't finish this pass. Please try again in a minute.
                </div>
              ) : result.proposals.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-[13.5px] text-slate-400">
                  Ada didn't propose anything this time. Try describing your needs with a bit more detail.
                </div>
              ) : (
                <>
                  {result.summary && (
                    <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/[0.06] p-4">
                      <div className="text-[11px] uppercase tracking-wide text-indigo-300 font-semibold">Ada proposes</div>
                      <p className="mt-1 text-[13.5px] text-slate-200">{result.summary}</p>
                    </div>
                  )}
                  <p className="mt-4 mb-2 text-[12.5px] text-slate-500">
                    Review each item and approve what you want. Nothing is created until you approve it — new employees start supervised and can't act until you finish setting them up.
                  </p>
                  <div className="flex flex-col gap-3">
                    {result.proposals.map((p) => (
                      <ProposalCard key={p.execution_id} p={p} onApproved={() => setApprovedCount((c) => c + 1)} />
                    ))}
                  </div>
                  {approvedCount > 0 && (
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4">
                      <span className="text-[13.5px] text-emerald-200">
                        {approvedCount} item{approvedCount !== 1 ? 's' : ''} created. Find your new employees in the roster to finish setting them up.
                      </span>
                      {setPage && (
                        <button onClick={() => setPage('workforce_des')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-emerald-500">
                          Go to Digital Employees →
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
