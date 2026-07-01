import React, { useState, useEffect } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { PageTabs, ADMIN_TABS } from '../../components';
import { updateTenant, savePlatformConfig, hasPlatformConfigKey, fetchTenants, fetchAllTenantsUsage, updateTenantBudget } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';

const INDUSTRIES = [
  'Technology', 'Financial Services', 'Healthcare', 'Retail & E-commerce',
  'Manufacturing', 'Legal & Compliance', 'Education', 'Real Estate',
  'Logistics & Supply Chain', 'Media & Entertainment',
];

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

const SettingsPage = ({
  user,
  tenant,
  page,
  setPage,
}: { user?: AuthUser; tenant?: Tenant; page?: Page; setPage?: (p: Page) => void } = {}) => {
  const { refreshTenant } = useAuth();
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [activeTab, setActiveTab] = useState<'general' | 'ai_engine' | 'usage' | 'billing' | 'security'>('general');

  // General tab
  const [orgName, setOrgName] = useState(tenant?.name || '');
  const [industry, setIndustry] = useState(tenant?.industry || 'Technology');
  const [contactEmail, setContactEmail] = useState(tenant?.contactEmail || user?.email || '');
  const [brandColor, setBrandColor] = useState(tenant?.primaryColor || '#6366f1');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  // AI Engine tab
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicSet, setAnthropicSet] = useState(false);
  const [openaiSet, setOpenaiSet] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [keyStatus, setKeyStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  // Usage tab
  const [tenants, setTenants] = useState<any[]>([]);
  const [usageMap, setUsageMap] = useState<Record<string, number>>({});
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({});
  const [budgetSaving, setBudgetSaving] = useState<string | null>(null);

  useEffect(() => {
    setOrgName(tenant?.name || '');
    setIndustry(tenant?.industry || 'Technology');
    setContactEmail(tenant?.contactEmail || user?.email || '');
    setBrandColor(tenant?.primaryColor || '#6366f1');
  }, [tenant, user]);

  useEffect(() => {
    if (activeTab === 'ai_engine') {
      Promise.all([
        hasPlatformConfigKey('ANTHROPIC_API_KEY'),
        hasPlatformConfigKey('OPENAI_API_KEY'),
      ]).then(([a, o]) => { setAnthropicSet(a); setOpenaiSet(o); });
    }
    if (activeTab === 'usage') {
      Promise.all([fetchTenants(), fetchAllTenantsUsage()]).then(([ts, usage]) => {
        setTenants(ts);
        const map: Record<string, number> = {};
        usage.forEach(u => { map[u.tenant_id] = u.tokens_used; });
        setUsageMap(map);
        const edits: Record<string, string> = {};
        ts.forEach(t => { edits[t.id] = String(t.monthly_token_budget ?? 100000); });
        setBudgetEdits(edits);
      });
    }
  }, [activeTab]);

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
    if (ok) await refreshTenant();
    setTimeout(() => setSaveStatus('idle'), 3000);
  };

  const handleSaveKeys = async () => {
    const entries: Record<string, string> = {};
    if (anthropicKey.trim()) entries['ANTHROPIC_API_KEY'] = anthropicKey.trim();
    if (openaiKey.trim()) entries['OPENAI_API_KEY'] = openaiKey.trim();
    if (!Object.keys(entries).length) return;
    setKeySaving(true);
    const ok = await savePlatformConfig(entries);
    setKeySaving(false);
    setKeyStatus(ok ? 'saved' : 'error');
    if (ok) {
      if (anthropicKey.trim()) { setAnthropicSet(true); setAnthropicKey(''); }
      if (openaiKey.trim()) { setOpenaiSet(true); setOpenaiKey(''); }
    }
    setTimeout(() => setKeyStatus('idle'), 4000);
  };

  const handleSaveBudget = async (tenantId: string) => {
    const val = parseInt(budgetEdits[tenantId] || '0', 10);
    if (isNaN(val) || val < 0) return;
    setBudgetSaving(tenantId);
    await updateTenantBudget(tenantId, val);
    setBudgetSaving(null);
    // refresh usage
    const [ts, usage] = await Promise.all([fetchTenants(), fetchAllTenantsUsage()]);
    setTenants(ts);
    const map: Record<string, number> = {};
    usage.forEach(u => { map[u.tenant_id] = u.tokens_used; });
    setUsageMap(map);
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={ADMIN_TABS} page={page} setPage={setPage} accentColor={accentColor} />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 text-sm mt-1">
          Manage your workspace, AI engine, and client token budgets
        </p>
      </div>
      <div className="flex gap-1 bg-slate-800 rounded-xl p-1 mb-6 overflow-x-auto w-fit">
        {(['general', 'ai_engine', 'usage', 'billing', 'security'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
              activeTab === t ? 'text-white' : 'text-slate-400 hover:text-white'
            }`}
            style={activeTab === t ? { backgroundColor: accentColor } : {}}
          >
            {t === 'ai_engine' ? 'AI Engine' : t === 'usage' ? 'Usage & Budgets' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── General ───────────────────────────────────────────────── */}
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
                  <div className="w-10 h-10 rounded-lg flex-shrink-0 border border-slate-700" style={{ backgroundColor: brandColor }} />
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

      {/* ── AI Engine ─────────────────────────────────────────────── */}
      {activeTab === 'ai_engine' && (
        <div className="max-w-2xl space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">AI Engine Keys</h2>
            <p className="text-xs text-slate-400 mb-5">
              These keys are stored encrypted in your database and shared across all your client tenants.
              You control usage and spend via the Usage & Budgets tab.
            </p>

            {/* Anthropic */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-slate-400">Anthropic API Key</label>
                {anthropicSet
                  ? <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Configured</span>
                  : <span className="text-xs text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded">Not set — DE responses disabled</span>}
              </div>
              <input
                type="password"
                value={anthropicKey}
                onChange={e => setAnthropicKey(e.target.value)}
                placeholder={anthropicSet ? 'Enter new key to replace existing…' : 'sk-ant-…'}
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
              />
              <p className="text-xs text-slate-600 mt-1">
                Get your key at console.anthropic.com → API Keys. Powers all Digital Employee responses.
              </p>
            </div>

            {/* OpenAI */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-slate-400">OpenAI API Key <span className="text-slate-600 font-normal">(optional)</span></label>
                {openaiSet
                  ? <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Configured — semantic search active</span>
                  : <span className="text-xs text-slate-500 bg-slate-700/50 px-2 py-0.5 rounded">Not set — keyword search only</span>}
              </div>
              <input
                type="password"
                value={openaiKey}
                onChange={e => setOpenaiKey(e.target.value)}
                placeholder={openaiSet ? 'Enter new key to replace existing…' : 'sk-…'}
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
              />
              <p className="text-xs text-slate-600 mt-1">
                Enables vector/semantic search in the knowledge base — significantly improves DE answer quality.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveKeys}
                disabled={keySaving || (!anthropicKey.trim() && !openaiKey.trim())}
                className="px-6 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-40 transition-all"
                style={{ backgroundColor: accentColor }}
              >
                {keySaving ? 'Saving…' : 'Save Keys'}
              </button>
              {keyStatus === 'saved' && <span className="text-xs text-emerald-400">Keys saved — edge functions will use them immediately</span>}
              {keyStatus === 'error' && <span className="text-xs text-red-400">Save failed</span>}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">How billing works</h2>
            <div className="space-y-2 text-xs text-slate-400 mt-3">
              <div className="flex gap-3"><span className="text-slate-600 w-4">1</span><span>You pay Anthropic directly for token usage across all tenants.</span></div>
              <div className="flex gap-3"><span className="text-slate-600 w-4">2</span><span>Each tenant has a monthly token budget you set — DEs stop responding when the budget is hit.</span></div>
              <div className="flex gap-3"><span className="text-slate-600 w-4">3</span><span>Haiku costs ~$0.25/M input tokens and ~$1.25/M output tokens — a 500-token query costs ~$0.001.</span></div>
              <div className="flex gap-3"><span className="text-slate-600 w-4">4</span><span>You can price AI usage into your service fee or charge clients per token at your own margin.</span></div>
            </div>
          </div>
        </div>
      )}

      {/* ── Usage & Budgets ────────────────────────────────────────── */}
      {activeTab === 'usage' && (
        <div className="max-w-3xl space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Monthly Token Budgets</h2>
            <p className="text-xs text-slate-400 mb-5">
              Set a monthly token limit per client. DEs stop responding when the limit is reached — resets on the 1st of each month.
              Current month: <span className="text-white font-mono">{new Date().toISOString().slice(0, 7)}</span>
            </p>

            {tenants.length === 0 ? (
              <div className="text-xs text-slate-600 py-4 text-center">Loading tenants…</div>
            ) : (
              <div className="space-y-3">
                {tenants.map(t => {
                  const used = usageMap[t.id] ?? 0;
                  const budget = parseInt(budgetEdits[t.id] ?? String(t.monthly_token_budget ?? 100000), 10);
                  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
                  const barColor = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : accentColor;
                  return (
                    <div key={t.id} className="bg-slate-800/50 rounded-xl p-4">
                      <div className="flex items-start justify-between gap-4 mb-3">
                        <div>
                          <div className="text-sm text-white font-medium">{t.name}</div>
                          <div className="text-xs text-slate-500 mt-0.5">{t.plan} · {t.status}</div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <input
                            type="number"
                            value={budgetEdits[t.id] ?? ''}
                            onChange={e => setBudgetEdits(prev => ({ ...prev, [t.id]: e.target.value }))}
                            className="w-28 bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500 font-mono text-right"
                            min={0}
                            step={10000}
                          />
                          <span className="text-xs text-slate-500">tokens/mo</span>
                          <button
                            onClick={() => handleSaveBudget(t.id)}
                            disabled={budgetSaving === t.id}
                            className="px-3 py-1.5 text-xs text-white rounded-lg disabled:opacity-40 transition-all"
                            style={{ backgroundColor: accentColor }}
                          >
                            {budgetSaving === t.id ? '…' : 'Save'}
                          </button>
                        </div>
                      </div>
                      <div className="flex justify-between text-xs text-slate-500 mb-1.5">
                        <span>{fmt(used)} used</span>
                        <span>{pct}% of {fmt(budget)}</span>
                      </div>
                      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, backgroundColor: barColor }}
                        />
                      </div>
                      {pct >= 90 && (
                        <p className="text-xs text-red-400 mt-1.5">Near limit — DEs will stop responding soon. Increase budget or wait for monthly reset.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {(activeTab === 'billing' || activeTab === 'security') && (
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
