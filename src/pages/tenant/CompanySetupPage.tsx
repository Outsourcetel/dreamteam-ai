import React, { useState } from 'react';
import { PageHeader } from '../../components/ui';
import type { Page } from '../../types';

// ── Types & seed data ─────────────────────────────────────────────

interface Industry {
  id: string;
  name: string;
  icon: string;
  templatePreview: string;
  recommendedHires: { role: string; why: string }[];
  guardrails: string[];
}

const INDUSTRIES: Industry[] = [
  {
    id: 'saas', name: 'Technology / SaaS', icon: '⚡',
    templatePreview: 'Support-heavy template: ticket resolution, renewal automation, developer-facing knowledge, and product-led onboarding flows.',
    recommendedHires: [
      { role: 'Customer Support DE', why: 'Highest-volume function in SaaS — fastest time-to-value' },
      { role: 'Renewal DE', why: 'Automates the renewal lifecycle from invoice to close' },
      { role: 'HR & People DE', why: 'Internal workforce requests once the team scales' },
    ],
    guardrails: ['No billing adjustments above threshold without approval', 'Never quote competitor pricing', 'No SLA commitments outside standard tier', 'PII masking on all customer data'],
  },
  {
    id: 'financial', name: 'Financial Services', icon: '$',
    templatePreview: 'Compliance-first template: KYC/AML workflows, partner review gates, strict PII redaction, and regulatory knowledge collections.',
    recommendedHires: [
      { role: 'Client Relations DE', why: 'Client communications, KYC intake, and engagement cadence' },
      { role: 'Research Specialist DE', why: 'Deep-domain research with mandatory human review' },
    ],
    guardrails: ['All client deliverables require partner review', 'No regulatory filings without human approval', 'PII redaction enforced', 'Sanctions screening on all new entities'],
  },
  {
    id: 'healthcare', name: 'Healthcare', icon: '＋',
    templatePreview: 'HIPAA-aligned template: patient-communication limits, PHI redaction everywhere, and clinician-in-the-loop gates on anything clinical.',
    recommendedHires: [
      { role: 'Patient Services DE', why: 'Scheduling, billing questions, and intake paperwork' },
      { role: 'HR & People DE', why: 'Credentialing reminders and staff onboarding' },
    ],
    guardrails: ['No clinical advice — ever', 'PHI redaction on every channel', 'Clinician review gate on all patient-facing health content', 'Consent verification before any record access'],
  },
  {
    id: 'ecommerce', name: 'E-commerce / Retail', icon: '◧',
    templatePreview: 'Volume-optimized template: order status, returns automation, refund approval gates, and seasonal-surge playbooks.',
    recommendedHires: [
      { role: 'Customer Support DE', why: 'Order status and returns are 70%+ of inbound volume' },
      { role: 'Vendor Management DE', why: 'Supplier communications and PO follow-ups' },
    ],
    guardrails: ['Refunds above threshold require approval', 'No price-match commitments without policy check', 'Fraud-pattern escalation mandatory', 'PII masking on payment data'],
  },
  {
    id: 'professional', name: 'Professional Services', icon: '◈',
    templatePreview: 'Engagement-centric template: client onboarding, deliverable review gates, time-and-billing hygiene, and knowledge capture from every engagement.',
    recommendedHires: [
      { role: 'Client Relations DE', why: 'Engagement intake, status updates, and satisfaction monitoring' },
      { role: 'Finance DE', why: 'WIP, billing, and collections hygiene' },
    ],
    guardrails: ['Client commitments above threshold require partner sign-off', 'No advice outside engaged scope', 'Deliverable review gate before client delivery', 'Conflict-of-interest check on new engagements'],
  },
];

const UNIVERSAL_FUNCTIONS = [
  { id: 'support', label: 'Customer Support', desc: 'Inbound question resolution and escalation' },
  { id: 'sales', label: 'Sales & Business Development', desc: 'Pipeline and outreach assistance' },
  { id: 'onboarding', label: 'Customer Onboarding', desc: 'Implementation and activation flows' },
  { id: 'renewal', label: 'Renewal & Expansion', desc: 'Renewal lifecycle automation' },
  { id: 'hr', label: 'HR & People', desc: 'Internal workforce requests' },
  { id: 'finance', label: 'Finance Operations', desc: 'Invoicing, AR/AP, and reporting' },
  { id: 'vendor', label: 'Vendor Management', desc: 'Supplier and partner coordination' },
  { id: 'knowledge', label: 'Knowledge Management', desc: 'Gap detection and library upkeep' },
];

const OPTIONAL_FUNCTIONS = [
  { id: 'legal', label: 'Legal (optional)', desc: 'Contract review support and policy lookups — specialist function, consulted on demand' },
];

const STEPS = ['Industry', 'Functions', 'First hires', 'Guardrails'];

// ── Page ──────────────────────────────────────────────────────────

interface SetupState {
  step: number;
  industryId: string | null;
  functions: string[];
}

const LS_KEY = 'dt_company_setup_draft';

export default function CompanySetupPage({ setPage }: { setPage: (p: Page) => void }) {
  const load = (): SetupState => {
    try {
      const s = localStorage.getItem(LS_KEY);
      if (s) return JSON.parse(s);
    } catch { /* noop */ }
    return { step: 0, industryId: null, functions: ['support', 'hr', 'knowledge'] };
  };

  const [state, setState] = useState<SetupState>(load);

  const save = (next: SetupState) => {
    setState(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch { /* noop */ }
  };

  const industry = INDUSTRIES.find(i => i.id === state.industryId) ?? null;
  const canNext = state.step === 0 ? !!industry : true;

  const toggleFn = (id: string) => {
    const next = state.functions.includes(id) ? state.functions.filter(f => f !== id) : [...state.functions, id];
    save({ ...state, functions: next });
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Company Setup"
        subtitle="Configure your industry template, activate the functions you need, and get Digital Employee hiring recommendations"
      />

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <button
              onClick={() => (i <= state.step || (i === state.step + 1 && canNext)) && save({ ...state, step: i })}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs transition-colors ${
                i === state.step ? 'bg-indigo-600 text-white'
                : i < state.step ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-slate-900 border border-slate-800 text-slate-500'
              }`}
            >
              <span className="w-4 h-4 rounded-full bg-slate-950/40 flex items-center justify-center text-[9px] font-bold">
                {i < state.step ? '✓' : i + 1}
              </span>
              {s}
            </button>
            {i < STEPS.length - 1 && <span className="text-slate-700 text-xs">—</span>}
          </React.Fragment>
        ))}
      </div>

      {/* Step 1: Industry */}
      {state.step === 0 && (
        <div>
          <h3 className="text-sm font-semibold text-white mb-3">Choose your industry</h3>
          <p className="text-xs text-slate-500 mb-4">Your industry sets the guardrail template, knowledge structure, and default playbooks every DE inherits.</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {INDUSTRIES.map(ind => (
              <button
                key={ind.id}
                onClick={() => save({ ...state, industryId: ind.id })}
                className={`text-left rounded-xl border p-4 transition-all ${state.industryId === ind.id ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-800 bg-slate-900 hover:border-slate-600'}`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-slate-300">{ind.icon}</span>
                  <span className="text-sm font-semibold text-white">{ind.name}</span>
                  {state.industryId === ind.id && <span className="ml-auto text-indigo-400 text-xs">✓ selected</span>}
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">{ind.templatePreview}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: Functions */}
      {state.step === 1 && (
        <div>
          <h3 className="text-sm font-semibold text-white mb-3">Activate functions</h3>
          <p className="text-xs text-slate-500 mb-4">Eight universal functions cover most businesses. You can activate more later — each function maps to entity and outcome pages in the sidebar.</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 mb-4">
            {UNIVERSAL_FUNCTIONS.map(f => (
              <button
                key={f.id}
                onClick={() => toggleFn(f.id)}
                className={`flex items-center gap-3 text-left rounded-xl border px-4 py-3 transition-all ${state.functions.includes(f.id) ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-slate-800 bg-slate-900 hover:border-slate-600'}`}
              >
                <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] flex-shrink-0 ${state.functions.includes(f.id) ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-600'}`}>
                  {state.functions.includes(f.id) ? '✓' : ''}
                </span>
                <div>
                  <p className="text-sm text-slate-200">{f.label}</p>
                  <p className="text-[11px] text-slate-500">{f.desc}</p>
                </div>
              </button>
            ))}
          </div>
          <p className="text-[10px] font-bold tracking-widest text-slate-600 uppercase mb-2">Optional</p>
          {OPTIONAL_FUNCTIONS.map(f => (
            <button
              key={f.id}
              onClick={() => toggleFn(f.id)}
              className={`flex items-center gap-3 text-left rounded-xl border px-4 py-3 transition-all w-full lg:w-1/2 ${state.functions.includes(f.id) ? 'border-purple-500/50 bg-purple-500/10' : 'border-slate-800 bg-slate-900 hover:border-slate-600'}`}
            >
              <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] flex-shrink-0 ${state.functions.includes(f.id) ? 'bg-purple-600 text-white' : 'bg-slate-800 text-slate-600'}`}>
                {state.functions.includes(f.id) ? '✓' : ''}
              </span>
              <div>
                <p className="text-sm text-slate-200">{f.label}</p>
                <p className="text-[11px] text-slate-500">{f.desc}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Step 3: First hires */}
      {state.step === 2 && industry && (
        <div>
          <h3 className="text-sm font-semibold text-white mb-3">Recommended first hires — {industry.name}</h3>
          <p className="text-xs text-slate-500 mb-4">Based on your industry, these Digital Employees deliver value fastest. Every DE starts in training and earns autonomy through the trust ladder.</p>
          <div className="space-y-3">
            {industry.recommendedHires.map((h, i) => (
              <div key={h.role} className="flex items-center gap-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
                <span className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold flex-shrink-0">{i + 1}</span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">{h.role}</p>
                  <p className="text-xs text-slate-400">{h.why}</p>
                </div>
                <button onClick={() => setPage('workforce_des')} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-indigo-600 hover:text-white transition-colors flex-shrink-0">
                  View DE roster
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {state.step === 2 && !industry && (
        <p className="text-sm text-slate-500">Choose an industry first to see hiring recommendations.</p>
      )}

      {/* Step 4: Guardrails */}
      {state.step === 3 && industry && (
        <div>
          <h3 className="text-sm font-semibold text-white mb-3">Guardrail template — {industry.name}</h3>
          <p className="text-xs text-slate-500 mb-4">Every DE you hire inherits this industry template on day one. You can add company-specific overrides in Compliance &amp; Guardrails.</p>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 mb-4">
            <div className="space-y-2">
              {industry.guardrails.map(g => (
                <div key={g} className="flex items-center gap-3 bg-slate-950 rounded-lg px-3 py-2.5">
                  <span className="text-red-400 text-xs flex-shrink-0">⚑</span>
                  <span className="text-sm text-slate-300">{g}</span>
                  <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">template</span>
                </div>
              ))}
            </div>
          </div>
          <button onClick={() => setPage('gov_compliance')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            Open Compliance &amp; Guardrails to review the full template →
          </button>
        </div>
      )}
      {state.step === 3 && !industry && (
        <p className="text-sm text-slate-500">Choose an industry first to preview its guardrail template.</p>
      )}

      {/* Nav buttons */}
      <div className="flex items-center gap-3 mt-8">
        {state.step > 0 && (
          <button onClick={() => save({ ...state, step: state.step - 1 })} className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm transition-colors">
            ← Back
          </button>
        )}
        {state.step < STEPS.length - 1 ? (
          <button
            onClick={() => canNext && save({ ...state, step: state.step + 1 })}
            disabled={!canNext}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue →
          </button>
        ) : (
          <button
            onClick={() => setPage('dashboard')}
            disabled={!industry}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm transition-colors disabled:opacity-40"
          >
            Finish setup → Command Centre
          </button>
        )}
        <span className="text-[11px] text-slate-600 ml-2">Progress is saved automatically.</span>
      </div>
    </div>
  );
}
