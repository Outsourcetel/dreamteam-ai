import React, { useState } from 'react';
import type { AuthUser, Tenant } from '../types';
import { Badge } from '../components';

const OnboardingWizard = ({
  onComplete,
  tenant,
  user,
}: {
  onComplete: () => void;
  tenant?: Tenant;
  user?: AuthUser;
}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [step, setStep] = useState(0);
  const [brandName, setBrandName] = useState(tenant?.name || '');

  const steps = [
    { label: 'Workspace Brand', icon: '1' },
    { label: 'Data Connectors', icon: '2' },
    { label: 'Knowledge Base', icon: '3' },
    { label: 'Digital Employees', icon: '4' },
    { label: 'Invite Team', icon: '5' },
    { label: 'Go Live', icon: '6' },
  ];

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="text-5xl mb-3">A</div>
              <h2 className="text-xl font-bold text-white mb-1">
                Set Up Your Workspace
              </h2>
              <p className="text-slate-400 text-sm">
                Customise your branded AI platform — your customers and staff
                will see this
              </p>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">
                  Company Name
                </label>
                <input
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="Acme Corp"
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">
                  Industry
                </label>
                <input
                  placeholder="e.g. SaaS, Healthcare, Retail"
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-2">
                  Brand Colour
                </label>
                <div className="flex gap-2">
                  {[
                    '#6366f1',
                    '#10b981',
                    '#f59e0b',
                    '#ef4444',
                    '#8b5cf6',
                    '#0ea5e9',
                    '#ec4899',
                  ].map((c) => (
                    <div
                      key={c}
                      className="w-8 h-8 rounded-full cursor-pointer border-2 transition-all hover:scale-110"
                      style={{
                        backgroundColor: c,
                        borderColor:
                          c === accentColor ? 'white' : 'transparent',
                      }}
                    />
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
              <div className="text-5xl mb-3">B</div>
              <h2 className="text-xl font-bold text-white mb-1">
                Connect Your Data
              </h2>
              <p className="text-slate-400 text-sm">
                Connect data sources so Digital Employees have the right context
              </p>
            </div>
            <div className="space-y-3">
              {[
                {
                  name: 'Confluence or Notion',
                  desc: 'Import your existing documentation',
                },
                {
                  name: 'Zendesk or Intercom',
                  desc: 'Sync past tickets for KB learning',
                },
                { name: 'Google Drive', desc: 'Index documents and policies' },
                {
                  name: 'CRM Salesforce or HubSpot',
                  desc: 'Customer data for personalised responses',
                },
              ].map((src, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 bg-slate-800 rounded-xl cursor-pointer hover:bg-slate-700 transition-all"
                >
                  <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center text-slate-300 font-bold">
                    {src.name[0]}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-white">
                      {src.name}
                    </div>
                    <div className="text-xs text-slate-400">{src.desc}</div>
                  </div>
                  <button className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-all">
                    Connect
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      case 2:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="text-5xl mb-3">C</div>
              <h2 className="text-xl font-bold text-white mb-1">
                Build Your Knowledge Base
              </h2>
              <p className="text-slate-400 text-sm">
                Upload documents or write articles — the AI uses this to answer
                queries
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                {
                  label: 'Upload PDF or DOCX',
                  desc: 'Policy docs, manuals, guides',
                },
                {
                  label: 'Write an Article',
                  desc: 'Create directly in the platform',
                },
                {
                  label: 'Import from URL',
                  desc: 'Crawl your help centre or docs site',
                },
                {
                  label: 'Use a Template',
                  desc: 'Pre-built KB starter templates',
                },
              ].map((opt, i) => (
                <div
                  key={i}
                  className="p-4 bg-slate-800 rounded-xl cursor-pointer hover:bg-slate-700 transition-all text-center"
                >
                  <div className="text-lg font-bold text-slate-300 mb-2">
                    {String.fromCharCode(65 + i)}
                  </div>
                  <div className="text-sm font-medium text-white mb-1">
                    {opt.label}
                  </div>
                  <div className="text-xs text-slate-400">{opt.desc}</div>
                </div>
              ))}
            </div>
          </div>
        );
      case 3:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="text-5xl mb-3">D</div>
              <h2 className="text-xl font-bold text-white mb-1">
                Activate Digital Employees
              </h2>
              <p className="text-slate-400 text-sm">
                Choose which agents to deploy — each serves customers or staff
              </p>
            </div>
            <div className="space-y-3">
              {[
                {
                  name: 'Customer Support Agent',
                  desc: 'Handles tier-1 support from your KB',
                  audience: 'Customer',
                },
                {
                  name: 'Onboarding Agent',
                  desc: 'Guides new employees through onboarding',
                  audience: 'Internal',
                },
                {
                  name: 'HR Knowledge Agent',
                  desc: 'Answers HR policy and benefits questions',
                  audience: 'Internal',
                },
                {
                  name: 'Billing Agent',
                  desc: 'Handles billing and payment queries',
                  audience: 'Customer',
                },
              ].map((agent, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 bg-slate-800 rounded-xl"
                >
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center text-sm text-indigo-300 font-bold">
                    {agent.name[0]}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium text-white">
                        {agent.name}
                      </div>
                      <Badge
                        label={agent.audience}
                        color={
                          agent.audience === 'Customer' ? 'blue' : 'purple'
                        }
                      />
                    </div>
                    <div className="text-xs text-slate-400">{agent.desc}</div>
                  </div>
                  <div className="w-9 h-5 bg-indigo-500 rounded-full flex items-center">
                    <div className="w-4 h-4 bg-white rounded-full shadow ml-4" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      case 4:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="text-5xl mb-3">E</div>
              <h2 className="text-xl font-bold text-white mb-1">
                Invite Your Team
              </h2>
              <p className="text-slate-400 text-sm">
                Add team members to manage agents, review approvals, and access
                the Knowledge Hub
              </p>
            </div>
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-2">
                  <input
                    placeholder="colleague@company.com"
                    className="flex-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                  <select className="bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2.5">
                    <option>Admin</option>
                    <option>Manager</option>
                    <option>User</option>
                  </select>
                </div>
              ))}
              <button className="w-full py-2 border border-dashed border-slate-700 text-slate-400 text-sm rounded-xl hover:border-indigo-500 hover:text-indigo-400 transition-all">
                + Add another
              </button>
            </div>
          </div>
        );
      case 5:
        return (
          <div className="space-y-5 text-center">
            <div className="text-6xl mb-3">F</div>
            <h2 className="text-xl font-bold text-white">You are all set!</h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Your AI platform is configured and ready. Agents are standing by,
              your Knowledge Hub is building, and your team has been invited.
            </p>
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                { label: 'Agents Ready', value: '4' },
                { label: 'KB Articles', value: '0' },
                { label: 'Team Members', value: '4' },
              ].map((item, i) => (
                <div key={i} className="bg-slate-800 rounded-xl p-3">
                  <div className="text-xl font-bold text-white">
                    {item.value}
                  </div>
                  <div className="text-xs text-slate-400">{item.label}</div>
                </div>
              ))}
            </div>
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
              <p className="text-sm text-emerald-300">
                Your AI platform will get smarter every day as agents learn from
                interactions
              </p>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 w-full max-w-lg mx-4">
        <div className="flex items-center justify-center gap-2 mb-8">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                  i < step
                    ? 'bg-emerald-500 text-white'
                    : i === step
                    ? 'text-white'
                    : 'bg-slate-800 text-slate-600'
                }`}
                style={i === step ? { backgroundColor: accentColor } : {}}
              >
                {i < step ? 'v' : String(i + 1)}
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`w-6 h-0.5 mx-1 ${
                    i < step ? 'bg-emerald-500' : 'bg-slate-800'
                  }`}
                />
              )}
            </div>
          ))}
        </div>
        <div className="mb-8">{renderStep()}</div>
        <div className="flex gap-3">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="px-5 py-2.5 text-slate-400 hover:text-white bg-slate-800 rounded-xl text-sm transition-all"
            >
              Back
            </button>
          )}
          <button
            onClick={() =>
              step < steps.length - 1 ? setStep(step + 1) : onComplete()
            }
            className="flex-1 py-2.5 text-white text-sm font-medium rounded-xl transition-all"
            style={{ backgroundColor: accentColor }}
          >
            {step === steps.length - 1 ? 'Launch Platform' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OnboardingWizard;
