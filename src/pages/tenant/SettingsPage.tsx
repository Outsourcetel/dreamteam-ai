import React, { useState, useEffect } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { PageTabs, ADMIN_TABS } from '../../components';
import { updateTenant, savePlatformConfig, hasPlatformConfigKey, fetchTenants, fetchAllTenantsUsage, updateTenantBudget } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useDataMode } from '../../lib/dataMode';
import {
  generateWidgetKey, fetchWidgetKeys, revokeWidgetKey, fetchEndUserSessions,
  WIDGET_ASK_URL, type WidgetKeyRow, type EndUserSessionRow,
} from '../../lib/widgetApi';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../components/LiveDataStates';

// THE canonical list (Wave 1.1) — the same one signup and Company
// Setup use, so a tenant's stored industry always matches a template.
import { INDUSTRY_NAMES as INDUSTRIES } from '../../lib/industries';

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
  const { refreshTenant, isDTUser } = useAuth();
  const accentColor = tenant?.primaryColor || '#6366f1';
  const dataMode = useDataMode();
  const [activeTab, setActiveTab] = useState<'general' | 'ai_engine' | 'usage' | 'widget' | 'billing' | 'security'>(() => {
    // One-shot deep-link hint (e.g. Getting Started "Get your widget key"
    // lands on the Widget tab instead of the org-name form). Consumed once.
    try {
      const hint = localStorage.getItem('dt_settings_tab');
      if (hint) {
        localStorage.removeItem('dt_settings_tab');
        if (['general', 'ai_engine', 'usage', 'widget', 'billing', 'security'].includes(hint)) return hint as 'widget';
      }
    } catch { /* ignore */ }
    return 'general';
  });

  // General tab
  const [orgName, setOrgName] = useState(tenant?.name || '');
  const [industry, setIndustry] = useState(tenant?.industry || 'Technology');
  const [contactEmail, setContactEmail] = useState(tenant?.contactEmail || user?.email || '');
  const [brandColor, setBrandColor] = useState(tenant?.primaryColor || '#6366f1');
  // Wave 4 — work-object vocabulary draft (see lib/vocabulary.ts).
  const [vocabDraft, setVocabDraft] = useState<Record<string, string>>(tenant?.vocabulary ?? {});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  // AI Engine tab
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [googleKey, setGoogleKey] = useState('');
  const [anthropicSet, setAnthropicSet] = useState(false);
  const [openaiSet, setOpenaiSet] = useState(false);
  const [googleSet, setGoogleSet] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [keyStatus, setKeyStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  // Widget & API tab
  const [widgetKeys, setWidgetKeys] = useState<WidgetKeyRow[]>([]);
  const [endUserSessions, setEndUserSessions] = useState<EndUserSessionRow[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [keyGenBusy, setKeyGenBusy] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);

  // Usage tab
  const [tenants, setTenants] = useState<any[]>([]);
  const [usageMap, setUsageMap] = useState<Record<string, number>>({});
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({});
  const [budgetSaving, setBudgetSaving] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<Record<string, string>>({});

  useEffect(() => {
    if (activeTab === 'ai_engine' && !isDTUser) setActiveTab('general');
  }, [activeTab, isDTUser]);

  useEffect(() => {
    setOrgName(tenant?.name || '');
    setIndustry(tenant?.industry || 'Technology');
    setContactEmail(tenant?.contactEmail || user?.email || '');
    setBrandColor(tenant?.primaryColor || '#6366f1');
    setVocabDraft(tenant?.vocabulary ?? {});
  }, [tenant, user]);

  useEffect(() => {
    if (activeTab === 'ai_engine' && isDTUser) {
      Promise.all([
        hasPlatformConfigKey('ANTHROPIC_API_KEY'),
        hasPlatformConfigKey('OPENAI_API_KEY'),
        hasPlatformConfigKey('GOOGLE_AI_KEY'),
      ]).then(([a, o, g]) => { setAnthropicSet(a); setOpenaiSet(o); setGoogleSet(g); });
    }
    if (activeTab === 'widget' && dataMode === 'live' && tenant?.id) {
      Promise.all([fetchWidgetKeys(tenant.id), fetchEndUserSessions(tenant.id)]).then(([ks, ss]) => {
        setWidgetKeys(ks);
        setEndUserSessions(ss);
      });
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
    // Vocabulary: trim values, drop empties (empty = fall back to default).
    const vocabulary: Record<string, string> = {};
    for (const [k, v] of Object.entries(vocabDraft)) {
      if (typeof v === 'string' && v.trim()) vocabulary[k] = v.trim();
    }
    const ok = await updateTenant(tenant.id, {
      name: orgName.trim() || tenant.name,
      industry,
      accent_color: brandColor,
      vocabulary,
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
    if (googleKey.trim()) entries['GOOGLE_AI_KEY'] = googleKey.trim();
    if (!Object.keys(entries).length) return;
    setKeySaving(true);
    const ok = await savePlatformConfig(entries);
    setKeySaving(false);
    setKeyStatus(ok ? 'saved' : 'error');
    if (ok) {
      if (anthropicKey.trim()) { setAnthropicSet(true); setAnthropicKey(''); }
      if (openaiKey.trim()) { setOpenaiSet(true); setOpenaiKey(''); }
      if (googleKey.trim()) { setGoogleSet(true); setGoogleKey(''); }
    }
    setTimeout(() => setKeyStatus('idle'), 4000);
  };

  const handleSaveBudget = async (tenantId: string) => {
    const val = parseInt(budgetEdits[tenantId] || '0', 10);
    if (isNaN(val) || val < 0) return;
    setBudgetSaving(tenantId);
    setBudgetError(prev => ({ ...prev, [tenantId]: '' }));
    const res = await updateTenantBudget(tenantId, val);
    setBudgetSaving(null);
    if (!res.ok) {
      setBudgetError(prev => ({ ...prev, [tenantId]: res.error || 'Could not save the budget.' }));
      return;
    }
    // refresh usage
    const [ts, usage] = await Promise.all([fetchTenants(), fetchAllTenantsUsage()]);
    setTenants(ts);
    const map: Record<string, number> = {};
    usage.forEach(u => { map[u.tenant_id] = u.tokens_used; });
    setUsageMap(map);
  };

  const handleGenerateKey = async () => {
    if (!tenant?.id || keyGenBusy) return;
    setKeyGenBusy(true);
    const plaintext = await generateWidgetKey(tenant.id, newKeyLabel || 'Default key');
    setKeyGenBusy(false);
    if (plaintext) {
      setGeneratedKey(plaintext);
      setKeyCopied(false);
      setNewKeyLabel('');
      setWidgetKeys(await fetchWidgetKeys(tenant.id));
    }
  };

  const handleRevokeKey = async (id: string) => {
    if (!tenant?.id) return;
    await revokeWidgetKey(id);
    setWidgetKeys(await fetchWidgetKeys(tenant.id));
  };

  const handleCopyKey = async () => {
    if (!generatedKey) return;
    try {
      await navigator.clipboard.writeText(generatedKey);
      setKeyCopied(true);
    } catch { /* clipboard unavailable */ }
  };

  const embedSnippet = `<script src="${window.location.origin}/widget.js"></script>
<script>
  DreamTeamWidget.init({
    key: 'dtw_YOUR_WIDGET_KEY',
    apiUrl: '${WIDGET_ASK_URL}',
    accountRef: 'YOUR_CUSTOMER_ID', endUserRef: 'EMPLOYEE_ID', displayName: 'Jane Doe',
  });
</script>`;

  const tabList = ((dataMode === 'live'
    ? ['general', 'ai_engine', 'usage', 'widget', 'billing', 'security']
    : ['general', 'ai_engine', 'usage', 'billing', 'security']) as Array<typeof activeTab>)
    .filter(t => t !== 'ai_engine' || isDTUser);

  return (
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
      <PageTabs tabs={ADMIN_TABS} page={page} setPage={setPage} accentColor={accentColor} />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 text-sm mt-1">
          Manage your workspace, AI engine, and client token budgets
        </p>
      </div>
      <div className="flex gap-1 bg-slate-700 rounded-xl p-1 mb-6 overflow-x-auto w-fit">
        {tabList.map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
              activeTab === t ? 'text-white' : 'text-slate-400 hover:text-white'
            }`}
            style={activeTab === t ? { backgroundColor: accentColor } : {}}
          >
            {t === 'ai_engine' ? 'AI Engine' : t === 'usage' ? 'Usage & Budgets' : t === 'widget' ? 'Widget & API' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── General ───────────────────────────────────────────────── */}
      {activeTab === 'general' && (
        <div className="max-w-2xl space-y-4">
          {tenant?.status === 'trial' && tenant?.trialEndsAt && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
              <p className="text-sm font-medium text-amber-300 mb-0.5">
                Trial — ends {new Date(tenant.trialEndsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
              <p className="text-xs text-amber-400/70">
                Your workspace will be paused automatically if the trial isn't upgraded by then. Contact us to talk about a plan.
              </p>
            </div>
          )}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Workspace Details</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Workspace Name</label>
                <input
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  placeholder="Your organisation name"
                  className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Industry</label>
                <select
                  value={industry}
                  onChange={e => setIndustry(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                >
                  {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
                </select>
              </div>
              {/* Wave 4 — work-object vocabulary: what YOU call the people
                  you serve and your value metric. Read by every live page. */}
              <div className="md:col-span-2 rounded-xl border border-slate-700 bg-slate-900/40 p-4">
                <p className="text-xs font-semibold text-white mb-0.5">Your vocabulary</p>
                <p className="text-[11px] text-slate-500 mb-3">Relabels the whole workspace — Patients instead of Customers, Contract value instead of ARR. Seeded from your industry; yours to change.</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {([
                    ['party_singular', 'You serve one…', 'Customer'],
                    ['party_plural', '…and many', 'Customers'],
                    ['value_metric', 'Value metric', 'ARR'],
                    ['renewal_label', 'Recurring commitment', 'Renewal'],
                    // Wave 5 — AI output style: every DE answer honors these.
                    ['ai_language', 'DE reply language', 'English (default)'],
                    ['ai_tone', 'DE tone of voice', 'e.g. warm, concise, formal'],
                  ] as const).map(([k, label, ph]) => (
                    <div key={k}>
                      <label className="text-[11px] font-medium text-slate-400 block mb-1">{label}</label>
                      <input value={vocabDraft[k] ?? ''} placeholder={ph}
                        onChange={e => setVocabDraft(v => ({ ...v, [k]: e.target.value }))}
                        className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500" />
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Contact Email</label>
                <input
                  value={contactEmail}
                  onChange={e => setContactEmail(e.target.value)}
                  type="email"
                  className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Brand Colour</label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={brandColor}
                    onChange={e => setBrandColor(e.target.value)}
                    className="w-10 h-10 rounded-lg cursor-pointer bg-slate-700 border border-slate-600 p-0.5"
                  />
                  <input
                    value={brandColor}
                    onChange={e => setBrandColor(e.target.value)}
                    placeholder="#6366f1"
                    className="flex-1 bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <div className="w-10 h-10 rounded-lg flex-shrink-0 border border-slate-600" style={{ backgroundColor: brandColor }} />
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

          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Danger Zone</h2>
            <p className="text-xs text-slate-500 mb-4">Irreversible actions — proceed with care.</p>
            <button className="px-4 py-2 text-xs font-medium text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-all">
              Delete Workspace
            </button>
          </div>
        </div>
      )}

      {/* ── AI Engine (platform admins only — keys are shared platform-wide) ── */}
      {activeTab === 'ai_engine' && isDTUser && (
        <div className="max-w-2xl space-y-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
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
                className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
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
                  : <span className="text-xs text-slate-500 bg-slate-600/50 px-2 py-0.5 rounded">Not set — keyword search only</span>}
              </div>
              <input
                type="password"
                value={openaiKey}
                onChange={e => setOpenaiKey(e.target.value)}
                placeholder={openaiSet ? 'Enter new key to replace existing…' : 'sk-…'}
                className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
              />
              <p className="text-xs text-slate-600 mt-1">
                Enables vector/semantic search in the knowledge base — significantly improves DE answer quality.
              </p>
            </div>

            {/* Google */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-slate-400">Google AI Key <span className="text-slate-600 font-normal">(optional)</span></label>
                {googleSet
                  ? <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Configured — Gemini models active</span>
                  : <span className="text-xs text-slate-500 bg-slate-600/50 px-2 py-0.5 rounded">Not set — Gemini models unavailable</span>}
              </div>
              <input
                type="password"
                value={googleKey}
                onChange={e => setGoogleKey(e.target.value)}
                placeholder={googleSet ? 'Enter new key to replace existing…' : 'AIza…'}
                className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
              />
              <p className="text-xs text-slate-600 mt-1">
                Get your key at aistudio.google.com → API Keys. Enables Gemini 1.5 Flash (cheapest overall) and Gemini 2.0 Flash.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveKeys}
                disabled={keySaving || (!anthropicKey.trim() && !openaiKey.trim() && !googleKey.trim())}
                className="px-6 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-40 transition-all"
                style={{ backgroundColor: accentColor }}
              >
                {keySaving ? 'Saving…' : 'Save Keys'}
              </button>
              {keyStatus === 'saved' && <span className="text-xs text-emerald-400">Keys saved — edge functions will use them immediately</span>}
              {keyStatus === 'error' && <span className="text-xs text-red-400">Save failed</span>}
            </div>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
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
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Monthly AI Budget</h2>
            <p className="text-xs text-slate-400 mb-5">
              {/* RLS scopes this list to what the caller can see: a normal
                  workspace sees only itself; an operator sees their clients —
                  so the copy stays singular-first, not "per client". */}
              {tenants.length > 1
                ? 'Set a monthly AI usage limit for each workspace. Digital Employees pause when a limit is reached — resets on the 1st of each month.'
                : 'Set a monthly AI usage limit for your workspace. Your Digital Employees pause when the limit is reached — it resets on the 1st of each month.'}
              {' '}Current month: <span className="text-white font-mono">{new Date().toISOString().slice(0, 7)}</span>
            </p>

            {tenants.length === 0 ? (
              <LiveLoadingSkeleton rows={2} />
            ) : (
              <div className="space-y-3">
                {tenants.map(t => {
                  const used = usageMap[t.id] ?? 0;
                  const budget = parseInt(budgetEdits[t.id] ?? String(t.monthly_token_budget ?? 100000), 10);
                  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
                  const barColor = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : accentColor;
                  return (
                    <div key={t.id} className="bg-slate-700/50 rounded-xl p-4">
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
                            className="w-28 bg-slate-700 border border-slate-600 text-white text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500 font-mono text-right"
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
                      <div className="h-2 bg-slate-600 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, backgroundColor: barColor }}
                        />
                      </div>
                      {pct >= 90 && (
                        <p className="text-xs text-red-400 mt-1.5">Near limit — DEs will stop responding soon. Increase budget or wait for monthly reset.</p>
                      )}
                      {budgetError[t.id] && (
                        <p className="text-xs text-red-400 mt-1.5">{budgetError[t.id]}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Widget & API (live mode only) ─────────────────────────── */}
      {activeTab === 'widget' && (
        <div className="max-w-3xl space-y-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Widget Keys</h2>
            <p className="text-xs text-slate-400 mb-4">
              Publishable keys for embedding your support chat widget in your product. Keys can only ask
              questions — they can never read or change data. We store only a hash; the key is shown once.
            </p>

            {generatedKey && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 mb-4">
                <div className="text-xs font-semibold text-emerald-400 mb-2">
                  New key generated — copy it now, it will not be shown again
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs text-white font-mono bg-slate-700 rounded-lg px-3 py-2 break-all">{generatedKey}</code>
                  <button
                    onClick={handleCopyKey}
                    className="px-3 py-2 text-xs text-white rounded-lg flex-shrink-0"
                    style={{ backgroundColor: accentColor }}
                  >
                    {keyCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 mb-5">
              <input
                value={newKeyLabel}
                onChange={e => setNewKeyLabel(e.target.value)}
                placeholder="Key label (e.g. Production portal)"
                className="flex-1 bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={handleGenerateKey}
                disabled={keyGenBusy}
                className="px-5 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-50 flex-shrink-0"
                style={{ backgroundColor: accentColor }}
              >
                {keyGenBusy ? 'Generating…' : 'Generate key'}
              </button>
            </div>

            {widgetKeys.length === 0 ? (
              <LiveEmptyState icon="⚿" title="No widget keys yet" body="Generate one to embed the widget." />
            ) : (
              <div className="space-y-2">
                {widgetKeys.map(k => (
                  <div key={k.id} className="flex items-center justify-between gap-3 bg-slate-700/50 rounded-xl px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm text-white font-medium truncate">
                        {k.label}
                        {!k.active && <span className="ml-2 text-xs text-red-400 bg-red-400/10 px-2 py-0.5 rounded">Revoked</span>}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        Created {new Date(k.created_at).toLocaleDateString()} · {k.request_count} requests ·
                        {k.last_used_at ? ` last used ${new Date(k.last_used_at).toLocaleString()}` : ' never used'}
                      </div>
                    </div>
                    {k.active && (
                      <button
                        onClick={() => handleRevokeKey(k.id)}
                        className="px-3 py-1.5 text-xs font-medium text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 flex-shrink-0"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Embed Snippet</h2>
            <p className="text-xs text-slate-400 mb-3">
              Paste into your product, replacing the placeholders. Full reference:{' '}
              <a href="https://github.com/Outsourcetel/dreamteam-ai/blob/main/docs/WIDGET-EMBED.md" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">docs/WIDGET-EMBED.md</a>
              {' '}· try it on the <a href="/widget-demo.html" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">demo page</a>.
            </p>
            <pre className="text-xs text-slate-300 font-mono bg-slate-700 rounded-xl p-4 overflow-x-auto whitespace-pre">{embedSnippet}</pre>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">End-User Activity</h2>
            <p className="text-xs text-slate-400 mb-3">Recent end users who asked questions through the widget.</p>
            {endUserSessions.length === 0 ? (
              <LiveEmptyState icon="◎" title="No end-user activity yet" body="Recent end users who ask questions through the widget will show up here." />
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 text-left">
                    <th className="pb-2 font-medium">Account</th>
                    <th className="pb-2 font-medium">Name</th>
                    <th className="pb-2 font-medium">First seen</th>
                    <th className="pb-2 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {endUserSessions.map(s => (
                    <tr key={s.id} className="border-t border-slate-700 text-slate-300">
                      <td className="py-2 font-mono">{s.account_external_ref || '—'}</td>
                      <td className="py-2">{s.display_name || s.end_user_ref || '—'}</td>
                      <td className="py-2 text-slate-500">{new Date(s.created_at).toLocaleDateString()}</td>
                      <td className="py-2 text-slate-500">{new Date(s.last_seen_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {(activeTab === 'billing' || activeTab === 'security') && (
        <div className="max-w-2xl">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 text-center">
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
