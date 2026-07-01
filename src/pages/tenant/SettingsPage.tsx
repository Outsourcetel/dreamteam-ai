import React, { useState, useEffect } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { PageTabs, ADMIN_TABS } from '../../components';
import { updateTenant } from '../../lib/api';

const INDUSTRIES = [
  'Technology', 'Financial Services', 'Healthcare', 'Retail & E-commerce',
  'Manufacturing', 'Legal & Compliance', 'Education', 'Real Estate',
  'Logistics & Supply Chain', 'Media & Entertainment',
];

const SettingsPage = ({
  user,
  tenant,
  page,
  setPage,
}: { user?: AuthUser; tenant?: Tenant; page?: Page; setPage?: (p: Page) => void } = {}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [activeTab, setActiveTab] = useState<'general' | 'tokens' | 'billing' | 'team' | 'security'>('general');

  // General tab state
  const [orgName, setOrgName] = useState(tenant?.name || '');
  const [industry, setIndustry] = useState(tenant?.industry || 'Technology');
  const [contactEmail, setContactEmail] = useState(tenant?.contactEmail || user?.email || '');
  const [brandColor, setBrandColor] = useState(tenant?.primaryColor || '#6366f1');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  useEffect(() => {
    setOrgName(tenant?.name || '');
    setIndustry(tenant?.industry || 'Technology');
    setContactEmail(tenant?.contactEmail || user?.email || '');
    setBrandColor(tenant?.primaryColor || '#6366f1');
  }, [tenant, user]);

  const handleSaveGeneral = async () => {
    if (!tenant?.id) { setSaveStatus('error'); return; }
    setSaving(true);
    const ok = await updateTenant(tenant.id, {
      name: orgName.trim() || tenant.name,
      industry,
      accent_color: brandColor,
    });
    setSaving(false);
    setSaveStatus(ok ? 'saved' : 'error');
    setTimeout(() => setSaveStatus('idle'), 3000);
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={ADMIN_TABS} page={page} setPage={setPage} accentColor={accentColor} />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 text-sm mt-1">
          Manage your workspace, team, and AI platform configuration
        </p>
      </div>
      <div className="flex gap-1 bg-slate-800 rounded-xl p-1 mb-6 overflow-x-auto w-fit">
        {(['general', 'tokens', 'billing', 'team', 'security'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all capitalize ${
              activeTab === t ? 'text-white' : 'text-slate-400 hover:text-white'
            }`}
            style={activeTab === t ? { backgroundColor: accentColor } : {}}
          >
            {t}
          </button>
        ))}
      </div>

      {activeTab === 'general' && (
        <div className="max-w-2xl space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Workspace Details</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Workspace Name</label>
                <input
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  placeholder="Your organisation name"
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Industry</label>
                <select
                  value={industry}
                  onChange={e => setIndustry(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                >
                  {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Contact Email</label>
                <input
                  value={contactEmail}
                  onChange={e => setContactEmail(e.target.value)}
                  type="email"
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Brand Colour</label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={brandColor}
                    onChange={e => setBrandColor(e.target.value)}
                    className="w-10 h-10 rounded-lg cursor-pointer bg-slate-800 border border-slate-700 p-0.5"
                  />
                  <input
                    value={brandColor}
                    onChange={e => setBrandColor(e.target.value)}
                    placeholder="#6366f1"
                    className="flex-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <div
                    className="w-10 h-10 rounded-lg flex-shrink-0 border border-slate-700"
                    style={{ backgroundColor: brandColor }}
                  />
                </div>
                <p className="text-xs text-slate-600 mt-1.5">Applied to sidebar, buttons, and highlights across the platform.</p>
              </div>
            </div>
            <div className="mt-5 flex items-center gap-3">
              <button
                onClick={handleSaveGeneral}
                disabled={saving}
                className="px-6 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-50 transition-all"
                style={{ backgroundColor: accentColor }}
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              {saveStatus === 'saved' && <span className="text-xs text-emerald-400">Saved successfully</span>}
              {saveStatus === 'error' && <span className="text-xs text-red-400">Save failed — check Supabase connection</span>}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Danger Zone</h2>
            <p className="text-xs text-slate-500 mb-4">Irreversible actions — proceed with care.</p>
            <button className="px-4 py-2 text-xs font-medium text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-all">
              Delete Workspace
            </button>
          </div>
        </div>
      )}

      {activeTab === 'tokens' && (
        <div className="max-w-2xl">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Token Usage and Limits</h2>
            <p className="text-xs text-slate-400 mb-5">
              Control how many tokens each Digital Employee and feature can consume per day, week, and month.
            </p>
            <div className="mb-5">
              <div className="flex justify-between text-xs text-slate-400 mb-2">
                <span>Monthly usage</span>
                <span className="text-white">
                  2.4M of {((tenant?.tokenLimit || 5000000) / 1000000).toFixed(0)}M tokens
                </span>
              </div>
              <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: '48%', backgroundColor: accentColor }} />
              </div>
              <div className="flex justify-between mt-1 text-xs text-slate-600">
                <span>48% used</span>
                <span>Resets in 18 days</span>
              </div>
            </div>
            <div className="space-y-4">
              {[
                { label: 'Monthly Token Limit', value: '5,000,000', unit: 'tokens' },
                { label: 'Daily Token Budget', value: '200,000', unit: 'tokens/day' },
                { label: 'Per-DE Token Limit', value: '50,000', unit: 'tokens/day' },
                { label: 'Single Query Cap', value: '8,000', unit: 'tokens/query' },
              ].map((f, i) => (
                <div key={i}>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">
                    {f.label} <span className="text-slate-600">({f.unit})</span>
                  </label>
                  <input
                    defaultValue={f.value}
                    className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              ))}
            </div>
            <div className="mt-5 space-y-3">
              {[
                { label: 'Send warning at 80% usage', desc: 'Email notification to workspace owners', checked: true },
                { label: 'Block queries at 100% usage', desc: 'Prevent overage charges by blocking new queries', checked: true },
              ].map((s, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-slate-800/50 rounded-xl">
                  <div>
                    <div className="text-sm text-white">{s.label}</div>
                    <div className="text-xs text-slate-500">{s.desc}</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only" defaultChecked={s.checked} />
                    <div className="w-9 h-5 bg-indigo-500 rounded-full">
                      <div className="w-4 h-4 bg-white rounded-full shadow mt-0.5 ml-4" />
                    </div>
                  </label>
                </div>
              ))}
            </div>
            <button
              className="mt-5 px-6 py-2.5 text-white text-sm font-medium rounded-xl"
              style={{ backgroundColor: accentColor }}
            >
              Save Token Settings
            </button>
          </div>
        </div>
      )}

      {(activeTab === 'billing' || activeTab === 'team' || activeTab === 'security') && (
        <div className="max-w-2xl">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
            <div className="text-4xl mb-3">*</div>
            <div className="text-sm font-medium text-white mb-1 capitalize">{activeTab} Settings</div>
            <div className="text-xs text-slate-400">Configuration options for {activeTab} coming soon.</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsPage;
