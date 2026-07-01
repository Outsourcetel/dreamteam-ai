import React, { useState } from 'react';
import type { StoredDE } from '../lib/useDigitalEmployees';

const DEPARTMENTS = ['Customer Success', 'Finance', 'HR & People', 'Legal & Compliance', 'Revenue', 'IT', 'Operations'];

const KNOWLEDGE_SOURCES = [
  'Product Knowledge Base',
  'Release Notes',
  'Past Resolved Tickets',
  'HR Policies & Benefits',
  'Finance & Billing Data',
  'Legal & Compliance Docs',
  'Onboarding Guides',
  'API Documentation',
  'Internal Runbooks',
];

const ALL_CAPABILITIES = [
  { id: 'kb_search', label: 'Search Knowledge Base', cat: 'Knowledge' },
  { id: 'reply_customer', label: 'Reply to customers', cat: 'Communication' },
  { id: 'reply_internal', label: 'Reply to internal staff', cat: 'Communication' },
  { id: 'send_email', label: 'Send emails', cat: 'Communication' },
  { id: 'create_ticket', label: 'Create support tickets', cat: 'Support' },
  { id: 'update_ticket', label: 'Update ticket status', cat: 'Support' },
  { id: 'escalate_human', label: 'Escalate to human', cat: 'Support' },
  { id: 'lookup_account', label: 'Look up customer account', cat: 'Data' },
  { id: 'update_crm', label: 'Update CRM records', cat: 'Data' },
  { id: 'create_invoice', label: 'Create invoices', cat: 'Finance' },
  { id: 'issue_credit', label: 'Issue credits / refunds', cat: 'Finance' },
  { id: 'schedule_meeting', label: 'Schedule meetings', cat: 'Productivity' },
  { id: 'assign_training', label: 'Assign training modules', cat: 'HR' },
  { id: 'run_report', label: 'Generate reports', cat: 'Analytics' },
];

const CHANNELS = [
  { id: 'chat', label: 'Customer Chat' },
  { id: 'email', label: 'Email' },
  { id: 'internal', label: 'Internal Slack/Teams' },
  { id: 'phone', label: 'Phone (transcript)' },
];

const ICONS = ['S', 'B', 'H', 'C', 'R', 'I', 'D', 'F', 'L', 'O', 'T', 'A'];

const STEPS = ['Identity', 'Knowledge', 'Behaviour', 'Capabilities', 'Review'];

interface Props {
  onHire: (de: Omit<StoredDE, 'id' | 'createdAt' | 'tasksThisMonth' | 'successRate'>) => void;
  onClose: () => void;
  accentColor?: string;
}

export default function HireModal({ onHire, onClose, accentColor = '#6366f1' }: Props) {
  const [step, setStep] = useState(0);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('S');
  const [category, setCategory] = useState<'Customer' | 'Internal'>('Customer');
  const [department, setDepartment] = useState(DEPARTMENTS[0]);
  const [knowledgeSources, setKnowledgeSources] = useState<string[]>(['Product Knowledge Base']);
  const [confidenceThreshold, setConfidenceThreshold] = useState(80);
  const [requiredApproval, setRequiredApproval] = useState(false);
  const [channels, setChannels] = useState<string[]>(['chat']);
  const [capabilities, setCapabilities] = useState<string[]>(['kb_search', 'reply_customer', 'escalate_human']);

  const toggleArr = <T,>(arr: T[], val: T, set: (v: T[]) => void) =>
    set(arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val]);

  const canNext = () => {
    if (step === 0) return name.trim().length > 0 && description.trim().length > 0;
    if (step === 1) return knowledgeSources.length > 0;
    if (step === 3) return capabilities.length > 0;
    return true;
  };

  const handleHire = () => {
    onHire({
      name: name.trim(),
      description: description.trim(),
      icon,
      category,
      department,
      status: 'active',
      capabilities: capabilities.map(c => ALL_CAPABILITIES.find(a => a.id === c)?.label ?? c),
      channels,
      knowledgeSources,
      confidenceThreshold,
      requiredApproval,
    });
    onClose();
  };

  const capsByCategory = ALL_CAPABILITIES.reduce<Record<string, typeof ALL_CAPABILITIES>>((acc, c) => {
    if (!acc[c.cat]) acc[c.cat] = [];
    acc[c.cat].push(c);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-800">
          <div>
            <h2 className="text-lg font-bold text-white">Hire a Digital Employee</h2>
            <p className="text-xs text-slate-400 mt-0.5">Step {step + 1} of {STEPS.length} — {STEPS[step]}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-all text-xl leading-none">×</button>
        </div>

        {/* Step indicator */}
        <div className="px-6 py-3 border-b border-slate-800">
          <div className="flex items-center gap-0">
            {STEPS.map((s, i) => (
              <React.Fragment key={s}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                    i < step ? 'bg-emerald-500 text-white' :
                    i === step ? 'text-white' : 'bg-slate-700 text-slate-500'
                  }`} style={i === step ? { backgroundColor: accentColor } : {}}>
                    {i < step ? '✓' : i + 1}
                  </div>
                  <span className={`text-xs hidden sm:block ${i === step ? 'text-white font-medium' : 'text-slate-500'}`}>{s}</span>
                </div>
                {i < STEPS.length - 1 && <div className={`flex-1 h-px mx-2 ${i < step ? 'bg-emerald-500' : 'bg-slate-700'}`} />}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-6">
          {/* Step 0 - Identity */}
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Name *</label>
                <input
                  value={name} onChange={e => setName(e.target.value)}
                  placeholder="e.g. Support Specialist"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Description *</label>
                <textarea
                  value={description} onChange={e => setDescription(e.target.value)}
                  placeholder="What does this Digital Employee do? Who do they help?"
                  rows={3}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-400 mb-1.5 block">Category</label>
                  <div className="flex gap-2">
                    {(['Customer', 'Internal'] as const).map(c => (
                      <button key={c} onClick={() => setCategory(c)}
                        className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all ${category === c ? 'text-white border-transparent' : 'text-slate-400 border-slate-700 hover:border-slate-600'}`}
                        style={category === c ? { backgroundColor: accentColor, borderColor: accentColor } : {}}>
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1.5 block">Department</label>
                  <select value={department} onChange={e => setDepartment(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500">
                    {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-2 block">Icon</label>
                <div className="flex gap-2 flex-wrap">
                  {ICONS.map(i => (
                    <button key={i} onClick={() => setIcon(i)}
                      className="w-9 h-9 rounded-lg text-sm font-bold transition-all border"
                      style={icon === i
                        ? { backgroundColor: accentColor + '40', borderColor: accentColor, color: accentColor }
                        : { backgroundColor: '#1e293b', borderColor: '#334155', color: '#94a3b8' }}>
                      {i}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 1 - Knowledge */}
          {step === 1 && (
            <div className="space-y-2">
              <p className="text-xs text-slate-400 mb-4">Select which knowledge sources this Digital Employee can access and learn from.</p>
              {KNOWLEDGE_SOURCES.map(s => (
                <button key={s} onClick={() => toggleArr(knowledgeSources, s, setKnowledgeSources)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${
                    knowledgeSources.includes(s) ? 'border-transparent' : 'border-slate-700 hover:border-slate-600'
                  }`}
                  style={knowledgeSources.includes(s) ? { backgroundColor: accentColor + '15', borderColor: accentColor + '60' } : {}}>
                  <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border transition-all ${knowledgeSources.includes(s) ? 'border-transparent' : 'border-slate-600'}`}
                    style={knowledgeSources.includes(s) ? { backgroundColor: accentColor } : {}}>
                    {knowledgeSources.includes(s) && <span className="text-white text-xs">✓</span>}
                  </div>
                  <span className={`text-sm ${knowledgeSources.includes(s) ? 'text-white' : 'text-slate-400'}`}>{s}</span>
                </button>
              ))}
            </div>
          )}

          {/* Step 2 - Behaviour */}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-slate-400">Confidence Threshold</label>
                  <span className="text-sm font-bold text-white">{confidenceThreshold}%</span>
                </div>
                <input type="range" min={50} max={95} value={confidenceThreshold}
                  onChange={e => setConfidenceThreshold(Number(e.target.value))}
                  className="w-full accent-indigo-500" style={{ accentColor }} />
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>50% — responds more often</span>
                  <span>95% — escalates more often</span>
                </div>
                <div className="mt-3 p-3 rounded-lg bg-slate-800/50 text-xs text-slate-400">
                  Responses with confidence below <span className="text-white font-medium">{confidenceThreshold}%</span> will be escalated to a human for review before sending.
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-3 block">Channels</label>
                <div className="grid grid-cols-2 gap-2">
                  {CHANNELS.map(c => (
                    <button key={c.id} onClick={() => toggleArr(channels, c.id, setChannels)}
                      className={`flex items-center gap-2 p-3 rounded-xl border transition-all text-left ${channels.includes(c.id) ? 'border-transparent' : 'border-slate-700'}`}
                      style={channels.includes(c.id) ? { backgroundColor: accentColor + '15', borderColor: accentColor + '60' } : {}}>
                      <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border`}
                        style={channels.includes(c.id) ? { backgroundColor: accentColor, borderColor: accentColor } : { borderColor: '#475569' }}>
                        {channels.includes(c.id) && <span className="text-white text-xs">✓</span>}
                      </div>
                      <span className={`text-sm ${channels.includes(c.id) ? 'text-white' : 'text-slate-400'}`}>{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between p-4 rounded-xl bg-slate-800/50 border border-slate-700">
                  <div>
                    <div className="text-sm text-white font-medium">Require approval before acting</div>
                    <div className="text-xs text-slate-400 mt-0.5">Every action needs a human to approve before executing</div>
                  </div>
                  <button onClick={() => setRequiredApproval(!requiredApproval)}
                    className={`w-11 h-6 rounded-full transition-all relative flex-shrink-0 ${requiredApproval ? '' : 'bg-slate-700'}`}
                    style={requiredApproval ? { backgroundColor: accentColor } : {}}>
                    <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${requiredApproval ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Step 3 - Capabilities */}
          {step === 3 && (
            <div className="space-y-4">
              <p className="text-xs text-slate-400 mb-2">Select what this Digital Employee is allowed to do autonomously.</p>
              {Object.entries(capsByCategory).map(([cat, caps]) => (
                <div key={cat}>
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{cat}</div>
                  <div className="space-y-1.5">
                    {caps.map(c => (
                      <button key={c.id} onClick={() => toggleArr(capabilities, c.id, setCapabilities)}
                        className={`w-full flex items-center gap-3 p-2.5 rounded-lg border transition-all text-left ${capabilities.includes(c.id) ? 'border-transparent' : 'border-slate-800 hover:border-slate-700'}`}
                        style={capabilities.includes(c.id) ? { backgroundColor: accentColor + '12', borderColor: accentColor + '50' } : {}}>
                        <div className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border transition-all"
                          style={capabilities.includes(c.id) ? { backgroundColor: accentColor, borderColor: accentColor } : { borderColor: '#475569' }}>
                          {capabilities.includes(c.id) && <span className="text-white text-xs">✓</span>}
                        </div>
                        <span className={`text-sm ${capabilities.includes(c.id) ? 'text-white' : 'text-slate-400'}`}>{c.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Step 4 - Review */}
          {step === 4 && (
            <div className="space-y-4">
              <div className="flex items-center gap-4 p-4 rounded-xl bg-slate-800/50 border border-slate-700">
                <div className="w-14 h-14 rounded-xl flex items-center justify-center text-2xl font-bold text-white flex-shrink-0"
                  style={{ backgroundColor: accentColor + '30' }}>{icon}</div>
                <div>
                  <div className="text-lg font-bold text-white">{name}</div>
                  <div className="text-sm text-slate-400">{department} · {category}</div>
                  <div className="text-xs text-slate-500 mt-1">{description}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Knowledge Sources', value: `${knowledgeSources.length} selected` },
                  { label: 'Confidence Threshold', value: `${confidenceThreshold}%` },
                  { label: 'Channels', value: channels.length > 0 ? channels.join(', ') : 'None' },
                  { label: 'Requires Approval', value: requiredApproval ? 'Yes — all actions' : 'No — autonomous' },
                  { label: 'Capabilities', value: `${capabilities.length} actions enabled` },
                  { label: 'Initial Status', value: 'Active' },
                ].map((r, i) => (
                  <div key={i} className="p-3 rounded-lg bg-slate-800/40">
                    <div className="text-xs text-slate-500 mb-0.5">{r.label}</div>
                    <div className="text-sm text-white font-medium">{r.value}</div>
                  </div>
                ))}
              </div>
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300">
                This Digital Employee will be deployed immediately and appear in Workforce HQ.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800">
          <button onClick={step === 0 ? onClose : () => setStep(s => s - 1)}
            className="px-4 py-2 rounded-xl text-sm text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 transition-all">
            {step === 0 ? 'Cancel' : '← Back'}
          </button>
          {step < STEPS.length - 1 ? (
            <button onClick={() => setStep(s => s + 1)} disabled={!canNext()}
              className="px-5 py-2 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: accentColor }}>
              Continue →
            </button>
          ) : (
            <button onClick={handleHire}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white transition-all"
              style={{ backgroundColor: '#10b981' }}>
              Hire Digital Employee
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
