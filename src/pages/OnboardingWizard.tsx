import React, { useState } from 'react';
import type { AuthUser, Tenant } from '../types';
import { Badge } from '../components';
import { updateTenantProfile } from '../lib/api';

const BRAND_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#ec4899'];

const OnboardingWizard = ({
  onComplete,
  tenant,
  user,
}: {
  onComplete: () => void;
  tenant?: Tenant;
  user?: AuthUser;
}) => {
  const [step, setStep] = useState(0);
  const [brandName, setBrandName] = useState(tenant?.name || '');
  const [industry, setIndustry] = useState('');
  const [accentColor, setAccentColor] = useState(tenant?.primaryColor || '#6366f1');
  const [saving, setSaving] = useState(false);

  const tenantId = tenant?.id ?? '';
  const isLive = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(tenantId);

  const steps = [
    { label: 'Workspace', icon: '1' },
    { label: 'Connectors', icon: '2' },
    { label: 'Knowledge', icon: '3' },
    { label: 'Digital Employees', icon: '4' },
    { label: 'Team', icon: '5' },
    { label: 'Launch', icon: '6' },
  ];

  const handleNext = async () => {
    if (step === 0 && isLive && brandName.trim()) {
      setSaving(true);
      await updateTenantProfile(tenantId, {
        name: brandName.trim(),
        industry: industry.trim() || undefined,
        accent_color: accentColor,
      });
      setSaving(false);
    }
    if (step < steps.length - 1) setStep(s => s + 1);
    else onComplete();
  };

  const inputCls = 'w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 placeholder-slate-500';

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl mx-auto mb-3 flex items-center justify-center text-2xl font-black text-white" style={{ backgroundColor: accentColor }}>
                {brandName ? brandName[0].toUpperCase() : 'W'}
              </div>
              <h2 className="text-xl font-bold text-white mb-1">Set Up Your Workspace</h2>
              <p className="text-slate-400 text-sm">Customise your branded AI platform — your customers and staff will see this</p>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Company Name *</label>
                <input value={brandName} onChange={e => setBrandName(e.target.value)} placeholder="Acme Corp" className={inputCls} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Industry</label>
                <input value={industry} onChange={e => setIndustry(e.target.value)} placeholder="e.g. SaaS, Healthcare, Retail" className={inputCls} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-2">Brand Colour</label>
                <div className="flex gap-2">
                  {BRAND_COLORS.map(c => (
                    <button key={c} onClick={() => setAccentColor(c)}
                      className="w-8 h-8 rounded-full border-2 transition-all hover:scale-110 flex-shrink-0"
                      style={{ backgroundColor: c, borderColor: c === accentColor ? 'white' : 'transparent' }} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      case 1:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl mx-auto mb-3 flex items-center justify-center text-2xl" style={{ backgroundColor: accentColor + '25' }}>🔌</div>
              <h2 className="text-xl font-bold text-white mb-1">Connect Your Data</h2>
              <p className="text-slate-400 text-sm">Connect data sources so Digital Employees have the right context</p>
            </div>
            <div className="space-y-3">
              {[
                { name: 'Confluence / Notion', desc: 'Import your existing documentation', icon: 'C' },
                { name: 'Zendesk / Intercom', desc: 'Sync past tickets for KB learning', icon: 'Z' },
                { name: 'Google Drive', desc: 'Index documents and policies', icon: 'G' },
                { name: 'CRM (Salesforce / HubSpot)', desc: 'Customer data for personalised responses', icon: 'S' },
              ].map((src, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-slate-800 rounded-xl cursor-pointer hover:bg-slate-700/80 transition-all">
                  <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center text-slate-300 text-xs font-bold flex-shrink-0">{src.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white">{src.name}</div>
                    <div className="text-xs text-slate-400">{src.desc}</div>
                  </div>
                  <button className="text-xs px-3 py-1.5 rounded-lg bg-slate-600 text-slate-200 hover:bg-slate-500 transition-all flex-shrink-0">Connect</button>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-500 text-center">You can connect data sources later from Data Connectors</p>
          </div>
        );
      case 2:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl mx-auto mb-3 flex items-center justify-center text-2xl" style={{ backgroundColor: accentColor + '25' }}>📚</div>
              <h2 className="text-xl font-bold text-white mb-1">Build Your Knowledge Base</h2>
              <p className="text-slate-400 text-sm">Upload documents or write articles — the AI uses this to answer queries</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Upload PDF / DOCX', desc: 'Policy docs, manuals, guides', icon: '📄' },
                { label: 'Write an Article', desc: 'Create directly in the platform', icon: '✍️' },
                { label: 'Import from URL', desc: 'Crawl your help centre or docs site', icon: '🔗' },
                { label: 'Use a Template', desc: 'Pre-built KB starter templates', icon: '📋' },
              ].map((opt, i) => (
                <div key={i} className="p-4 bg-slate-800 rounded-xl cursor-pointer hover:bg-slate-700/80 transition-all text-center">
                  <div className="text-2xl mb-2">{opt.icon}</div>
                  <div className="text-sm font-medium text-white mb-1">{opt.label}</div>
                  <div className="text-xs text-slate-400">{opt.desc}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-500 text-center">You can build your Knowledge Base at any time from Knowledge Hub</p>
          </div>
        );
      case 3:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl mx-auto mb-3 flex items-center justify-center text-2xl" style={{ backgroundColor: accentColor + '25' }}>🤖</div>
              <h2 className="text-xl font-bold text-white mb-1">Activate Digital Employees</h2>
              <p className="text-slate-400 text-sm">Choose which agents to deploy — each serves customers or staff</p>
            </div>
            <div className="space-y-3">
              {[
                { name: 'Customer Support Agent', desc: 'Handles tier-1 support from your KB', audience: 'Customer' },
                { name: 'Onboarding Agent', desc: 'Guides new customers through onboarding', audience: 'Customer' },
                { name: 'HR Knowledge Agent', desc: 'Answers HR policy and benefits questions', audience: 'Internal' },
                { name: 'Billing Agent', desc: 'Handles billing and payment queries', audience: 'Customer' },
              ].map((agent, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-slate-800 rounded-xl">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
                    style={{ backgroundColor: accentColor + '30', color: accentColor }}>{agent.name[0]}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium text-white">{agent.name}</div>
                      <Badge label={agent.audience} color={agent.audience === 'Customer' ? 'blue' : 'purple'} />
                    </div>
                    <div className="text-xs text-slate-400">{agent.desc}</div>
                  </div>
                  <div className="w-9 h-5 rounded-full flex-shrink-0" style={{ backgroundColor: accentColor }}>
                    <div className="w-4 h-4 bg-white rounded-full shadow mt-0.5 ml-4" />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-500 text-center">Manage Digital Employees from the Workforce page at any time</p>
          </div>
        );
      case 4:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl mx-auto mb-3 flex items-center justify-center text-2xl" style={{ backgroundColor: accentColor + '25' }}>👥</div>
              <h2 className="text-xl font-bold text-white mb-1">Invite Your Team</h2>
              <p className="text-slate-400 text-sm">Add team members to manage agents, review approvals, and access the Knowledge Hub</p>
            </div>
            <div className="space-y-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex gap-2">
                  <input placeholder="colleague@company.com"
                    className="flex-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                  <select className="bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2.5">
                    <option>Admin</option>
                    <option>Manager</option>
                    <option>User</option>
                  </select>
                </div>
              ))}
              <button className="w-full py-2 border border-dashed border-slate-700 text-slate-400 text-sm rounded-xl hover:border-slate-500 transition-all">
                + Add another
              </button>
            </div>
            <p className="text-xs text-slate-500 text-center">You can invite team members later from User Management</p>
          </div>
        );
      case 5:
        return (
          <div className="space-y-5 text-center">
            <div className="w-16 h-16 rounded-2xl mx-auto mb-1 flex items-center justify-center text-3xl" style={{ backgroundColor: accentColor }}>🚀</div>
            <h2 className="text-xl font-bold text-white">You're all set!</h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Your AI workforce is configured and ready. Digital Employees are standing by, your Knowledge Hub is being built, and your team has been invited.
            </p>
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                { label: 'Digital Employees', value: '4' },
                { label: 'KB Articles', value: '0' },
                { label: 'Team Members', value: '1' },
              ].map((item, i) => (
                <div key={i} className="bg-slate-800 rounded-xl p-4">
                  <div className="text-2xl font-bold text-white mb-1">{item.value}</div>
                  <div className="text-xs text-slate-400">{item.label}</div>
                </div>
              ))}
            </div>
            <div className="p-4 rounded-xl border" style={{ backgroundColor: accentColor + '15', borderColor: accentColor + '30' }}>
              <p className="text-sm font-medium" style={{ color: accentColor }}>Next step: Add knowledge base articles</p>
              <p className="text-xs text-slate-400 mt-1">The more content you add, the smarter your Digital Employees become.</p>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 w-full max-w-lg shadow-2xl">
        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center">
              <button
                onClick={() => i < step && setStep(i)}
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                  i < step ? 'bg-emerald-500 text-white cursor-pointer hover:bg-emerald-400' :
                  i === step ? 'text-white' : 'bg-slate-800 text-slate-600'
                }`}
                style={i === step ? { backgroundColor: accentColor } : {}}
              >
                {i < step ? '✓' : String(i + 1)}
              </button>
              {i < steps.length - 1 && (
                <div className={`w-6 h-0.5 mx-1 transition-all ${i < step ? 'bg-emerald-500' : 'bg-slate-800'}`} />
              )}
            </div>
          ))}
        </div>

        <div className="mb-8">{renderStep()}</div>

        <div className="flex gap-3">
          {step > 0 && (
            <button onClick={() => setStep(s => s - 1)}
              className="px-5 py-2.5 text-slate-400 hover:text-white bg-slate-800 rounded-xl text-sm transition-all">
              Back
            </button>
          )}
          {step < steps.length - 1 && (
            <button onClick={onComplete}
              className="px-4 py-2.5 text-slate-500 hover:text-slate-300 text-sm transition-all">
              Skip for now
            </button>
          )}
          <button
            onClick={handleNext}
            disabled={saving}
            className="flex-1 py-2.5 text-white text-sm font-medium rounded-xl transition-all disabled:opacity-60"
            style={{ backgroundColor: accentColor }}
          >
            {saving ? 'Saving…' : step === steps.length - 1 ? 'Launch Platform' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OnboardingWizard;
