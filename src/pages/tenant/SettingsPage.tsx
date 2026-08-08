import DataExportPanel from '../../components/DataExportPanel';
import SecurityAccessPage from './governance/SecurityAccessPage';
import DeleteWorkspacePanel from '../../components/DeleteWorkspacePanel';
import DomainClaimPanel from '../../components/sso/DomainClaimPanel';
import SsoPolicyPanel from '../../components/sso/SsoPolicyPanel';
import ScimTokensPanel from '../../components/sso/ScimTokensPanel';
import React, { useState, useEffect, useRef } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { updateTenant, savePlatformConfig, hasPlatformConfigKey, fetchTenants, fetchAllTenantsUsage, updateTenantBudget,
  getTenantLlmKeyStatus, saveTenantLlmKey, clearTenantLlmKey, setTenantLlmKeyMode, type LlmKeyMode } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { canAccessSettingsTab, type SettingsTab } from '../../lib/navAccess';
import {
  generateWidgetKey, fetchWidgetKeys, revokeWidgetKey, fetchEndUserSessions,
  rotateWidgetIdentitySecret, widgetIdentityConfigured,
  WIDGET_ASK_URL, type WidgetKeyRow, type EndUserSessionRow,
} from '../../lib/widgetApi';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../components/LiveDataStates';

// THE canonical list (Wave 1.1) — the same one signup and Company
// Setup use, so a tenant's stored industry always matches a template.
import { INDUSTRY_NAMES as INDUSTRIES } from '../../lib/industries';
import CommsSettingsCard from '../../components/CommsSettingsCard';
import AISessionPanel from '../../components/AISessionPanel';
import WorkforceTrustDefaults from '../../components/WorkforceTrustDefaults';
import WorkforceTrustPanel from '../../components/WorkforceTrustPanel';

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

// ── What you'd change there, not what it is built from ──────────────────
// "AI Engine", "Widget & API", "Workforce Trust" and "Usage & Budgets" name
// the subsystem. An owner opening Settings is looking for a decision.
//
// ⚠ KEYS ARE UNTOUCHED. Every one of these is still the exact SettingsTab
// value that canAccessSettingsTab filters on, that the Getting Started guide
// deep-links through `dt_settings_tab`, and that the ai_engine redirect
// targets. Only the words the owner reads have changed.
const SETTINGS_TAB_LABEL: Record<string, string> = {
  general: 'General',
  widget: 'The chat widget',
  billing: 'Billing',
  usage: "What you've used",
  trust: 'What they can do alone',
  ai_engine: 'The AI behind them',
  security: 'Sign-in & security',
  // Verified rather than guessed: this tab renders DomainClaimPanel,
  // SsoPolicyPanel and ScimTokensPanel — claiming your domain, the SSO
  // policy, and SCIM provisioning tokens. All three are how a company's own
  // identity provider connects, so "Single sign-on" is right; SCIM sits
  // under that umbrella for an owner even though it is provisioning.
  identity: 'Single sign-on',
  data: 'Your data',
};

const SETTINGS_GROUPS: { heading: string; tabs: string[] }[] = [
  { heading: 'Your workspace', tabs: ['general', 'widget', 'billing', 'usage'] },
  { heading: 'How your employees behave', tabs: ['trust', 'ai_engine'] },
  { heading: 'Security & data', tabs: ['security', 'identity', 'data'] },
];

const SettingsPage = ({
  user,
  tenant,
  page,
  setPage,
}: { user?: AuthUser; tenant?: Tenant; page?: Page; setPage?: (p: Page) => void } = {}) => {
  const { refreshTenant, isDTUser } = useAuth();
  // Least privilege on an unknown role: read_only, never a default that can see
  // billing. isDTUser stays in use below for platform-only content.
  const role = (user?.role ?? 'read_only') as Parameters<typeof canAccessSettingsTab>[0];
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [activeTab, setActiveTab] = useState<'general' | 'ai_engine' | 'usage' | 'widget' | 'billing' | 'security' | 'identity' | 'data' | 'trust'>(() => {
    // One-shot deep-link hint (e.g. Getting Started "Get your widget key"
    // lands on the Widget tab instead of the org-name form). Consumed once.
    try {
      const hint = localStorage.getItem('dt_settings_tab');
      if (hint) {
        localStorage.removeItem('dt_settings_tab');
        if (['general', 'ai_engine', 'usage', 'widget', 'billing', 'security', 'identity', 'data', 'trust'].includes(hint)) return hint as 'widget';
      }
    } catch { /* ignore */ }
    return 'general';
  });

  // W4-E: the workspace assistant, reachable where settings live.
  const [showAi, setShowAi] = useState(false);
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
  const [bedrockKey, setBedrockKey] = useState('');
  const [bedrockRegion, setBedrockRegion] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [googleKey, setGoogleKey] = useState('');
  const [anthropicSet, setAnthropicSet] = useState(false);
  const [bedrockSet, setBedrockSet] = useState(false);
  const [openaiSet, setOpenaiSet] = useState(false);
  const [googleSet, setGoogleSet] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [keyStatus, setKeyStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  // Whose key this workspace runs on (mig 541). 'platform' = we provide it and
  // bill for tokens; 'byo' = this workspace supplies its own and calls refuse
  // without it, rather than quietly borrowing the platform's.
  const [keyMode, setKeyMode] = useState<LlmKeyMode>('platform');
  const [keyError, setKeyError] = useState<string | null>(null);

  // Widget & API tab
  const [widgetKeys, setWidgetKeys] = useState<WidgetKeyRow[]>([]);
  const [endUserSessions, setEndUserSessions] = useState<EndUserSessionRow[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  // T2.3: per-key identity verification secret (shown once on rotate).
  const [identityConfigured, setIdentityConfigured] = useState<Record<string, boolean>>({});
  const [identitySecret, setIdentitySecret] = useState<{ keyId: string; secret: string } | null>(null);
  const [identityBusy, setIdentityBusy] = useState<string | null>(null);
  const [keyGenBusy, setKeyGenBusy] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);

  // Usage tab
  const [tenants, setTenants] = useState<any[]>([]);
  const [usageMap, setUsageMap] = useState<Record<string, number>>({});
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({});
  const [budgetSaving, setBudgetSaving] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<Record<string, string>>({});

  useEffect(() => {
    // Was: ai_engine only. Now any inaccessible tab — the 'dt_settings_tab'
    // deep-link hint and a role change can each strand someone on a tab they
    // may not open, which would render an empty panel rather than redirect.
    if (!canAccessSettingsTab(role, activeTab as SettingsTab, user?.layer)) {
      // Resolved inline rather than from tabList, which is declared further
      // down the component — 'general' is only the last resort, so a role that
      // somehow cannot open it still lands somewhere real instead of on a blank
      // panel.
      const firstAllowed = (['general', 'usage', 'trust', 'widget', 'identity', 'data', 'security', 'billing', 'ai_engine'] as SettingsTab[])
        .find(t => canAccessSettingsTab(role, t, user?.layer));
      setActiveTab((firstAllowed ?? 'general') as typeof activeTab);
    }
  }, [activeTab, role, user?.layer]);

  useEffect(() => {
    setOrgName(tenant?.name || '');
    setIndustry(tenant?.industry || 'Technology');
    setContactEmail(tenant?.contactEmail || user?.email || '');
    setBrandColor(tenant?.primaryColor || '#6366f1');
    setVocabDraft(tenant?.vocabulary ?? {});
  }, [tenant, user]);

  useEffect(() => {
    if (activeTab === 'ai_engine' && tenant?.id) {
      // This workspace's OWN keys first. Previously this read platform_config —
      // one global row — so every workspace saw the same answer and a tenant
      // could never tell whether a key was theirs.
      getTenantLlmKeyStatus(tenant.id).then((st) => {
        if (!st) return;
        setKeyMode(st.mode);
        const has = (k: string) => st.keys.some((x) => x.provider_key === k);
        setAnthropicSet(has('ANTHROPIC_API_KEY'));
        setBedrockSet(has('BEDROCK_API_KEY'));
        setOpenaiSet(has('OPENAI_API_KEY'));
        setGoogleSet(has('GOOGLE_AI_KEY'));
      });
    }
    if (activeTab === 'widget' && tenant?.id) {
      Promise.all([fetchWidgetKeys(tenant.id), fetchEndUserSessions(tenant.id)]).then(([ks, ss]) => {
        setWidgetKeys(ks);
        setEndUserSessions(ss);
        // T2.3: which keys have an identity secret configured.
        Promise.all(ks.filter(k => k.active).map(async k => [k.id, await widgetIdentityConfigured(k.id)] as const))
          .then(pairs => setIdentityConfigured(Object.fromEntries(pairs)));
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

  // Saves to THIS workspace's credentials, not the platform's. The old version
  // called savePlatformConfig, which writes one global row gated on a platform
  // capability — so a tenant admin got "not authorized", and a platform admin
  // changed the key for all sixteen workspaces at once.
  const handleSaveKeys = async () => {
    if (!tenant?.id) { setKeyStatus('error'); setKeyError('No workspace in scope.'); return; }
    const entries: Array<[string, string]> = [];
    if (anthropicKey.trim()) entries.push(['ANTHROPIC_API_KEY', anthropicKey.trim()]);
    if (bedrockKey.trim()) entries.push(['BEDROCK_API_KEY', bedrockKey.trim()]);
    if (openaiKey.trim()) entries.push(['OPENAI_API_KEY', openaiKey.trim()]);
    if (googleKey.trim()) entries.push(['GOOGLE_AI_KEY', googleKey.trim()]);
    if (!entries.length && !bedrockRegion.trim()) return;

    setKeySaving(true); setKeyError(null);
    const failures: string[] = [];
    for (const [name, value] of entries) {
      const err = await saveTenantLlmKey(tenant.id, name, value);
      if (err) failures.push(`${name}: ${err}`);
    }
    // The Bedrock region is configuration, not a credential, and stays platform
    // level — it is not secret and not per-workspace.
    if (bedrockRegion.trim()) await savePlatformConfig({ BEDROCK_REGION: bedrockRegion.trim() });
    setKeySaving(false);

    if (failures.length) {
      setKeyStatus('error'); setKeyError(failures.join(' · '));
    } else {
      setKeyStatus('saved');
      if (anthropicKey.trim()) { setAnthropicSet(true); setAnthropicKey(''); }
      if (bedrockKey.trim()) { setBedrockSet(true); setBedrockKey(''); }
      if (bedrockRegion.trim()) setBedrockRegion('');
      if (openaiKey.trim()) { setOpenaiSet(true); setOpenaiKey(''); }
      if (googleKey.trim()) { setGoogleSet(true); setGoogleKey(''); }
    }
    setTimeout(() => setKeyStatus('idle'), 4000);
  };

  const handleRemoveKey = async (providerKey: string, clearFlag: (v: boolean) => void) => {
    if (!tenant?.id) return;
    setKeySaving(true); setKeyError(null);
    const err = await clearTenantLlmKey(tenant.id, providerKey);
    setKeySaving(false);
    if (err) { setKeyStatus('error'); setKeyError(err); } else { clearFlag(false); setKeyStatus('saved'); }
    setTimeout(() => setKeyStatus('idle'), 4000);
  };

  // handleKeyModeChange removed with the radio buttons it served. It called
  // setTenantLlmKeyMode → a direct UPDATE on `tenants`, which RLS answers with
  // zero rows and no error, so it reported success and changed nothing. Which
  // account pays is set from the platform console.

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

  const handleRotateIdentity = async (keyId: string) => {
    if (identityBusy) return;
    setIdentityBusy(keyId);
    const r = await rotateWidgetIdentitySecret(keyId);
    setIdentityBusy(null);
    if (r.ok && r.secret) {
      setIdentitySecret({ keyId, secret: r.secret });
      setIdentityConfigured(prev => ({ ...prev, [keyId]: true }));
    }
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

  // ── Per-tab access (docs/29 decisions 2 and 3) ───────────────────────────
  // Settings is one page holding very different things: workspace vocabulary
  // sits beside billing, SSO, data export and workspace deletion. One tier for
  // the whole page would either lock managers out of settings they own, or hand
  // them billing. So each tab is gated on its own.
  //
  // Replaces a `true ? [...] : [...]` whose false branch was unreachable, and a
  // hand-rolled ai_engine check — both now expressed in one place that the
  // Sidebar and this page read from.
  //
  // Hiding a tab is PRESENTATION. Billing changes and workspace deletion are
  // enforced in the database; a role that reached this page by another route
  // still cannot perform them.
  const ALL_SETTINGS_TABS: SettingsTab[] =
    ['general', 'ai_engine', 'usage', 'trust', 'widget', 'identity', 'data', 'billing', 'security'];
  const tabList = ALL_SETTINGS_TABS
    .filter(t => canAccessSettingsTab(role, t, user?.layer))
    .map(t => t as typeof activeTab);

  // ── Switching tabs starts at the top of the new tab ──────────────────────
  // It used to keep the scroll offset, so choosing "Data" from halfway down
  // "Identity" landed you halfway down "Data" — past its heading, mid-panel,
  // with nothing to suggest you were not at the top. On this page that is
  // genuinely risky: the Data tab opens with the export panel and continues
  // into workspace deletion, so an inherited offset can drop someone straight
  // onto the destructive half of a screen they thought they were starting.
  //
  // Keyed off activeTab rather than the click handler so EVERY route in gets
  // it — the tab buttons, the 'dt_settings_tab' hand-off the Getting Started
  // guide uses to deep-link the Widget tab, and the ai_engine redirect above.
  //
  // The app scrolls inside <main> (App.tsx), not the window, so
  // window.scrollTo silently does nothing here. Rather than hard-code that
  // element and have this quietly rot if the shell changes, walk up to the
  // first genuinely scrolling ancestor and fall back to the window.
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let el: HTMLElement | null = pageRef.current;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        el.scrollTo({ top: 0 });
        return;
      }
      el = el.parentElement;
    }
    window.scrollTo({ top: 0 });
  }, [activeTab]);

  return (
    <div className="p-6" ref={pageRef}>
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="text-dt-support text-sm mt-1">
            Manage your workspace, AI engine, and client token budgets
          </p>
        </div>
        <button onClick={() => setShowAi(v => !v)}
          className="text-xs px-3 py-1.5 rounded-lg border border-indigo-500/40 text-indigo-300 hover:border-indigo-400 transition-colors shrink-0">
          ✨ Ask about settings
        </button>
      </div>
      {/* W4-E: the workspace assistant reaches Settings — it explains any
          setting in plain language; sensitive changes come back as
          proposals for a person, never auto-applied. */}
      {showAi && (
        <div className="mb-6">
          <AISessionPanel subjectKind="workspace" subjectLabel="Workspace settings"
            examples={['What does the confidence floor do?', 'Explain the AI budget and what happens when it runs out', 'Which model are my employees using?']} />
        </div>
      )}
      {/* ── Nine peers in a row is a list nobody reads ────────────────────
          Nine tabs sat in one horizontal strip, several of them named for
          the machinery ("AI Engine", "Widget & API", "Workforce Trust")
          rather than for the decision behind them. Grouped into three
          headings down the side, each tab says what you'd change there.
          ⚠ EVERY KEY IS UNCHANGED and the list is still built from
          `tabList`, which is ALL_SETTINGS_TABS filtered by
          canAccessSettingsTab — this only regroups and relabels what that
          filter already allowed. A group with nothing in it disappears
          rather than rendering an empty heading. */}
      <div className="flex gap-8 items-start">
        <nav className="w-52 shrink-0 space-y-5">
          {SETTINGS_GROUPS.map(g => {
            const items = g.tabs.filter(t => tabList.includes(t as typeof activeTab));
            if (!items.length) return null;
            return (
              <div key={g.heading}>
                <p className="text-xs font-medium text-dt-faint uppercase tracking-wider px-3 mb-1.5">{g.heading}</p>
                <div className="space-y-0.5">
                  {items.map(t => (
                    <button
                      key={t}
                      onClick={() => setActiveTab(t as typeof activeTab)}
                      className={`w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
                        activeTab === t ? 'text-white' : 'text-dt-support hover:text-dt-body hover:bg-dt-inset'
                      }`}
                      style={activeTab === t ? { backgroundColor: accentColor } : {}}
                    >
                      {SETTINGS_TAB_LABEL[t] ?? t}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="flex-1 min-w-0">

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
          <div className="bg-dt-card border border-dt-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Workspace Details</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-dt-support block mb-1.5">Workspace Name</label>
                <input
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  placeholder="Your organisation name"
                  className="w-full bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-dt-support block mb-1.5">Industry</label>
                <select
                  value={industry}
                  onChange={e => setIndustry(e.target.value)}
                  className="w-full bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                >
                  {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
                </select>
              </div>
              {/* Wave 4 — work-object vocabulary: what YOU call the people
                  you serve and your value metric. Read by every live page. */}
              <div className="md:col-span-2 rounded-xl border border-dt-border bg-dt-inset p-4">
                <p className="text-xs font-semibold text-white mb-0.5">Your vocabulary</p>
                <p className="text-[11px] text-dt-muted mb-3">Relabels the whole workspace — Patients instead of Customers, Contract value instead of ARR. Seeded from your industry; yours to change.</p>
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
                      <label className="text-[11px] font-medium text-dt-support block mb-1">{label}</label>
                      <input value={vocabDraft[k] ?? ''} placeholder={ph}
                        onChange={e => setVocabDraft(v => ({ ...v, [k]: e.target.value }))}
                        className="w-full bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500" />
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-dt-support block mb-1.5">Contact Email</label>
                <input
                  value={contactEmail}
                  onChange={e => setContactEmail(e.target.value)}
                  type="email"
                  className="w-full bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-dt-support block mb-1.5">Brand Colour</label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={brandColor}
                    onChange={e => setBrandColor(e.target.value)}
                    className="w-10 h-10 rounded-lg cursor-pointer bg-dt-panel border border-dt-border-strong p-0.5"
                  />
                  <input
                    value={brandColor}
                    onChange={e => setBrandColor(e.target.value)}
                    placeholder="#6366f1"
                    className="flex-1 bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <div className="w-10 h-10 rounded-lg flex-shrink-0 border border-dt-border-strong" style={{ backgroundColor: brandColor }} />
                </div>
                <p className="text-xs text-dt-faint mt-1.5">Applied to sidebar, buttons, and highlights across the platform.</p>
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

          <CommsSettingsCard accentColor={accentColor} />

          {/* The Danger Zone card that used to sit here is gone. It was a
              SECOND door to an irreversible action, and much the weaker of
              the two:

                · it had NO onClick — the button did nothing at all, so anyone
                  who found it learned the wrong thing about whether deleting
                  a workspace was possible
                · it carried none of the real flow's protections: no
                  export-your-data-first prompt, no list of what gets
                  destroyed, no retype-to-confirm, and no explanation that
                  deletion is a request a platform admin performs after the
                  workspace has been suspended

              DeleteWorkspacePanel on the Data tab is the real one. Two
              entrances to the same destructive act, where one skips every
              safeguard, is how a workspace gets destroyed by the path that
              never warned anybody. */}
        </div>
      )}

      {/* ── AI Engine — keys belong to THIS workspace (mig 541) ── */}
      {activeTab === 'ai_engine' && (
        <div className="max-w-2xl space-y-4">
          <div className="bg-dt-card border border-dt-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">AI Engine Keys</h2>
            <p className="text-xs text-dt-support mb-4">
              Keys are stored encrypted and belong to <strong className="text-dt-body">this workspace only</strong>.
              Every answer tries the engines in order — Anthropic first, then the Bedrock Claude fallback,
              then the optional cross-vendor tiers — and the first configured engine that responds serves it.
              Usage and spend are on the Usage &amp; Budgets tab.
            </p>

            {/* ⚠ THIS USED TO BE TWO RADIO BUTTONS, AND THEY DID NOTHING.
                They wrote `tenants.llm_key_mode` with a direct table update,
                and `tenants` has RLS on with only a SELECT policy — so the
                write matched zero rows. PostgREST reports that as SUCCESS, not
                an error, so the dot moved, nothing was saved, no error showed,
                and it snapped back on reload. Proven with `set local role
                authenticated`: rows_updated=0, mode unchanged, no exception.

                The database was right and the UI was wrong: which account pays
                is a commercial term, not a workspace preference. It is set from
                the platform console. Shown here read-only, because a customer
                still needs to know which it is — it changes what happens when a
                key is missing. */}
            <div className="mb-5 rounded-xl border border-dt-border-strong bg-dt-panel/60 p-3.5">
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <p className="text-xs font-medium text-dt-support">Which account pays for this workspace's AI?</p>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-600/50 text-dt-muted whitespace-nowrap">
                  set by your plan
                </span>
              </div>
              {keyMode === 'byo' ? (
                <p className="text-xs text-dt-support">
                  <strong className="text-dt-body">This workspace brings its own.</strong> Calls are billed to its own
                  provider account, using the keys below. If a key is missing, work <em>stops with a clear message</em>
                  rather than quietly falling back to ours.
                </p>
              ) : (
                <p className="text-xs text-dt-support">
                  <strong className="text-dt-body">We provide it.</strong> This workspace runs on DreamTeam AI's
                  provider account and we bill for what it uses. You can still add your own keys below — they take
                  precedence for this workspace as soon as they are saved.
                </p>
              )}
              <p className="text-[11px] text-dt-faint mt-1.5">
                To change which account pays, contact DreamTeam AI — it affects billing, so it is not a
                self-serve setting.
              </p>
              {keyMode === 'byo' && !anthropicSet && (
                <p className="text-xs text-amber-300 mt-2.5">
                  No Anthropic key is set for this workspace, so its Digital Employees cannot answer. Add one below.
                </p>
              )}
            </div>

            {keyError && <p className="text-xs text-rose-300 mb-4">{keyError}</p>}

            {/* Anthropic */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-dt-support">Anthropic API Key</label>
                {anthropicSet
                  ? <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Configured — primary engine</span>
                  : <span className="text-xs text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded">Not set — answers fall to the next engine</span>}
              </div>
              <input
                type="password"
                value={anthropicKey}
                onChange={e => setAnthropicKey(e.target.value)}
                placeholder={anthropicSet ? 'Enter new key to replace existing…' : 'sk-ant-…'}
                className="w-full bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
              />
              <p className="text-xs text-dt-faint mt-1">
                Get your key at console.anthropic.com → API Keys. The primary engine for all Digital Employee responses.
              </p>
            </div>

            {/* Bedrock — the same Claude models via AWS, the recommended fallback */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-dt-support">Amazon Bedrock Key — Claude fallback <span className="text-dt-faint font-normal">(recommended)</span></label>
                {bedrockSet
                  ? <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Configured — fallback armed</span>
                  : <span className="text-xs text-dt-muted bg-slate-600/50 px-2 py-0.5 rounded">Not set — no fallback if Anthropic is unavailable</span>}
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={bedrockKey}
                  onChange={e => setBedrockKey(e.target.value)}
                  placeholder={bedrockSet ? 'Enter new key to replace existing…' : 'Bedrock API key…'}
                  className="flex-1 bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <input
                  type="text"
                  value={bedrockRegion}
                  onChange={e => setBedrockRegion(e.target.value)}
                  placeholder="Region (us-east-1)"
                  className="w-44 bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>
              <p className="text-xs text-dt-faint mt-1">
                The SAME Claude models sold through AWS — zero behavior drift when Anthropic direct is down.
                In the AWS console: enable Claude model access in Bedrock, then generate a Bedrock API key.
                Billed to your AWS account at the same per-token list prices.
              </p>
            </div>

            {/* OpenAI */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-dt-support">OpenAI API Key <span className="text-dt-faint font-normal">(optional)</span></label>
                {openaiSet
                  ? <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Configured — cross-vendor fallback armed</span>
                  : <span className="text-xs text-dt-muted bg-slate-600/50 px-2 py-0.5 rounded">Not set — optional tier</span>}
              </div>
              <input
                type="password"
                value={openaiKey}
                onChange={e => setOpenaiKey(e.target.value)}
                placeholder={openaiSet ? 'Enter new key to replace existing…' : 'sk-…'}
                className="w-full bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
              />
              <p className="text-xs text-dt-faint mt-1">
                Optional third tier: used only when both Claude engines are unreachable. A different brain than
                your employees were certified on — continuity cover, not an equivalent. (Semantic search runs on
                built-in embeddings and does not need this key.)
              </p>
            </div>

            {/* Google */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-dt-support">Google AI Key <span className="text-dt-faint font-normal">(optional)</span></label>
                {googleSet
                  ? <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Configured — Gemini fallback armed</span>
                  : <span className="text-xs text-dt-muted bg-slate-600/50 px-2 py-0.5 rounded">Not set — optional tier</span>}
              </div>
              <input
                type="password"
                value={googleKey}
                onChange={e => setGoogleKey(e.target.value)}
                placeholder={googleSet ? 'Enter new key to replace existing…' : 'AIza…'}
                className="w-full bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
              />
              <p className="text-xs text-dt-faint mt-1">
                Optional fourth tier (Gemini) — same continuity-only role as OpenAI. Get a key at aistudio.google.com → API Keys.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveKeys}
                disabled={keySaving || (!anthropicKey.trim() && !bedrockKey.trim() && !bedrockRegion.trim() && !openaiKey.trim() && !googleKey.trim())}
                className="px-6 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-40 transition-all"
                style={{ backgroundColor: accentColor }}
              >
                {keySaving ? 'Saving…' : 'Save Keys'}
              </button>
              {keyStatus === 'saved' && <span className="text-xs text-emerald-400">Keys saved — edge functions will use them immediately</span>}
              {keyStatus === 'error' && <span className="text-xs text-red-400">Save failed</span>}
            </div>
          </div>

          <div className="bg-dt-card border border-dt-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">How failover works</h2>
            <div className="space-y-2 text-xs text-dt-support mt-3">
              <div className="flex gap-3"><span className="text-dt-faint w-4">1</span><span>Every answer tries Anthropic first. If it can't respond (key problem, rate limit, outage), the same request runs on the next configured engine — automatically, per answer.</span></div>
              <div className="flex gap-3"><span className="text-dt-faint w-4">2</span><span>Bedrock serves the identical Claude models, so answers, guardrails and certifications behave the same. OpenAI/Gemini are different brains — continuity cover only.</span></div>
              <div className="flex gap-3"><span className="text-dt-faint w-4">3</span><span>The moment Anthropic recovers, traffic flows back on its own — nothing to switch manually. Failovers are logged in the edge-function logs.</span></div>
            </div>
          </div>

          <div className="bg-dt-card border border-dt-border rounded-xl p-5">
            {/* ⚠ THIS WAS WRITTEN FOR THE PLATFORM OPERATOR AND SHOWN TO
                CUSTOMERS. It said "you pay the provider" (only true in byo),
                "a budget you set" (false in platform mode as of mig 632 — the
                server now refuses that write), and "charge clients per token at
                your own margin", which is reseller guidance addressed to us,
                rendered on a customer's settings page.

                Now it answers the question a tenant is actually asking: who is
                billed for MY workspace, and what happens when it runs out. It
                follows keyMode, so it cannot drift from what the server
                enforces. */}
            <h2 className="text-sm font-semibold text-white mb-1">How billing works</h2>
            {keyMode === 'byo' ? (
              <div className="space-y-2 text-xs text-dt-support mt-3">
                <div className="flex gap-3"><span className="text-dt-faint w-4">1</span><span>This workspace uses its <strong className="text-dt-body">own provider keys</strong>, so the provider bills you directly — Anthropic, or AWS when the Bedrock fallback serves the answer.</span></div>
                <div className="flex gap-3"><span className="text-dt-faint w-4">2</span><span>Because it is your account, <strong className="text-dt-body">you set your own monthly token budget</strong> on the Usage &amp; Budgets tab. Digital Employees pause when it is reached, and it resets on the 1st.</span></div>
                <div className="flex gap-3"><span className="text-dt-faint w-4">3</span><span>Roughly, a 500-token query costs about $0.001 at current Haiku list prices (~$0.25 per million input tokens, ~$1.25 per million output).</span></div>
                <div className="flex gap-3"><span className="text-dt-faint w-4">4</span><span>If a key is missing or rejected, work <strong className="text-dt-body">stops with a clear message</strong> rather than silently running on someone else's account.</span></div>
              </div>
            ) : (
              <div className="space-y-2 text-xs text-dt-support mt-3">
                <div className="flex gap-3"><span className="text-dt-faint w-4">1</span><span><strong className="text-dt-body">DreamTeam AI pays the provider</strong> for this workspace's answers and bills you as part of your plan — there is no separate provider account for you to manage.</span></div>
                <div className="flex gap-3"><span className="text-dt-faint w-4">2</span><span>Your plan includes a <strong className="text-dt-body">monthly token budget</strong>. Digital Employees pause when it is reached, and it resets on the 1st of each month. You can watch it on the Usage &amp; Budgets tab.</span></div>
                <div className="flex gap-3"><span className="text-dt-faint w-4">3</span><span>The budget is set with your plan, so it is not editable here. If you are hitting it often, contact DreamTeam AI and we will raise it.</span></div>
                <div className="flex gap-3"><span className="text-dt-faint w-4">4</span><span>Prefer to be billed by the provider directly? Add your own keys above and ask us to switch this workspace to its own account — then the budget becomes yours to set too.</span></div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Usage & Budgets ────────────────────────────────────────── */}
      {activeTab === 'usage' && (
        <div className="max-w-3xl space-y-4">
          <div className="bg-dt-card border border-dt-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Monthly AI Budget</h2>
            {/* ⚠ THIS HEADER STILL SAID "Set a monthly AI usage limit" after the
                editor below it became read-only for platform-mode workspaces —
                I fixed the input and the near-limit warning and missed the
                paragraph introducing them. Same defect, three feet higher up.
                It now leads with what the reader can actually do. */}
            <p className="text-xs text-dt-support mb-5">
              {/* RLS scopes this list to what the caller can see: a normal
                  workspace sees only itself; an operator sees their clients —
                  so the copy stays singular-first, not "per client". */}
              {tenants.length > 1
                ? 'Monthly AI usage against each workspace\'s limit. Digital Employees pause when a limit is reached — it resets on the 1st of each month.'
                : (isDTUser || tenants[0]?.llm_key_mode === 'byo')
                  ? 'Set a monthly AI usage limit for your workspace. Your Digital Employees pause when the limit is reached — it resets on the 1st of each month.'
                  : 'Your monthly AI usage against the limit included in your plan. Digital Employees pause when it is reached, and it resets on the 1st of each month — contact DreamTeam AI if you need more.'}
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
                    <div key={t.id} className="bg-dt-panel rounded-xl p-4">
                      <div className="flex items-start justify-between gap-4 mb-3">
                        <div>
                          <div className="text-sm text-white font-medium">{t.name}</div>
                          <div className="text-xs text-dt-muted mt-0.5">{t.plan} · {t.status}</div>
                        </div>
                        {/* ⚠ WHOSE MONEY. A workspace on OUR provider account
                            must not be able to raise the ceiling on spending we
                            pay for — that is a suggestion, not a limit. Mig 632
                            enforces it in set_tenant_monthly_budget; this only
                            stops the UI offering a control the server refuses,
                            which is the failure the key-mode radio had for
                            months. Where the workspace brings its own key, it is
                            their bill and the editor stays. */}
                        {(isDTUser || t.llm_key_mode === 'byo') ? (
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <input
                              type="number"
                              value={budgetEdits[t.id] ?? ''}
                              onChange={e => setBudgetEdits(prev => ({ ...prev, [t.id]: e.target.value }))}
                              className="w-28 bg-dt-panel border border-dt-border-strong text-white text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500 font-mono text-right"
                              min={0}
                              step={10000}
                            />
                            <span className="text-xs text-dt-muted">tokens/mo</span>
                            <button
                              onClick={() => handleSaveBudget(t.id)}
                              disabled={budgetSaving === t.id}
                              className="px-3 py-1.5 text-xs text-white rounded-lg disabled:opacity-40 transition-all"
                              style={{ backgroundColor: accentColor }}
                            >
                              {budgetSaving === t.id ? '…' : 'Save'}
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 flex-shrink-0 text-right">
                            <span className="text-sm text-white font-mono">{fmt(budget)}</span>
                            <span className="text-xs text-dt-muted">tokens/mo</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-600/50 text-dt-muted whitespace-nowrap">
                              set by your plan
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex justify-between text-xs text-dt-muted mb-1.5">
                        <span>{fmt(used)} used</span>
                        <span>{pct}% of {fmt(budget)}</span>
                      </div>
                      <div className="h-2 bg-slate-600 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, backgroundColor: barColor }}
                        />
                      </div>
                      {/* ⚠ Do not tell someone to do a thing the server will
                          refuse. On our provider account they cannot raise the
                          limit, so "increase budget" is advice that ends in an
                          error message. */}
                      {pct >= 90 && (
                        (isDTUser || t.llm_key_mode === 'byo') ? (
                          <p className="text-xs text-red-400 mt-1.5">Near limit — DEs will stop responding soon. Increase budget or wait for monthly reset.</p>
                        ) : (
                          <p className="text-xs text-red-400 mt-1.5">Near limit — DEs will stop responding soon. Contact DreamTeam AI to raise it, or wait for the monthly reset.</p>
                        )
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
          <div className="bg-dt-card border border-dt-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Widget Keys</h2>
            <p className="text-xs text-dt-support mb-4">
              Publishable keys for embedding your support chat widget in your product. Keys can only ask
              questions — they can never read or change data. We store only a hash; the key is shown once.
            </p>

            {generatedKey && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 mb-4">
                <div className="text-xs font-semibold text-emerald-400 mb-2">
                  New key generated — copy it now, it will not be shown again
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs text-white font-mono bg-dt-panel rounded-lg px-3 py-2 break-all">{generatedKey}</code>
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
                className="flex-1 bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
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
                  <div key={k.id} className="flex items-center justify-between gap-3 bg-dt-panel rounded-xl px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm text-white font-medium truncate">
                        {k.label}
                        {!k.active && <span className="ml-2 text-xs text-red-400 bg-red-400/10 px-2 py-0.5 rounded">Revoked</span>}
                      </div>
                      <div className="text-xs text-dt-muted mt-0.5">
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

          <div className="bg-dt-card border border-dt-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Embed Snippet</h2>
            <p className="text-xs text-dt-support mb-3">
              Paste into your product, replacing the placeholders. Full reference:{' '}
              <a href="https://github.com/Outsourcetel/dreamteam-ai/blob/main/docs/WIDGET-EMBED.md" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">docs/WIDGET-EMBED.md</a>
              {' '}· try it on the <a href="/widget-demo.html" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">demo page</a>.
            </p>
            <pre className="text-xs text-dt-support font-mono bg-dt-panel rounded-xl p-4 overflow-x-auto whitespace-pre">{embedSnippet}</pre>
          </div>

          {/* T2.3: identity verification — lets a verified caller be remembered across conversations */}
          <div className="bg-dt-card border border-dt-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">Identity verification <span className="text-dt-muted font-normal">· optional</span></h2>
            <p className="text-xs text-dt-support mb-3">
              Prove who’s asking so your Digital Employee can remember them across conversations (instead of starting cold each time).
              Your <strong className="text-dt-body">own server</strong> signs a short hash with a secret only it holds; anonymous visitors are unaffected.
              Nothing is remembered per-person until you set this up <em>and</em> forward the hash.
            </p>
            {widgetKeys.filter(k => k.active).length === 0 ? (
              <p className="text-xs text-dt-muted">Generate a widget key above first.</p>
            ) : (
              <div className="space-y-2">
                {widgetKeys.filter(k => k.active).map(k => (
                  <div key={k.id} className="flex items-center justify-between gap-2 bg-dt-page rounded-lg px-3 py-2 border border-dt-border">
                    <div className="min-w-0">
                      <p className="text-xs text-white truncate">{k.label}</p>
                      <p className="text-[11px] mt-0.5">
                        {identityConfigured[k.id]
                          ? <span className="text-emerald-300">● Configured</span>
                          : <span className="text-dt-muted">○ Not configured</span>}
                      </p>
                    </div>
                    <button
                      disabled={identityBusy === k.id}
                      onClick={() => void handleRotateIdentity(k.id)}
                      className="text-xs px-2.5 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:border-indigo-500 disabled:opacity-50 shrink-0">
                      {identityBusy === k.id ? '…' : identityConfigured[k.id] ? 'Rotate secret' : 'Set up'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {identitySecret && (
              <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="text-[11px] text-amber-200 mb-1.5 font-medium">Copy this secret now — it’s shown only once. Store it in your server’s environment; never ship it to the browser.</p>
                <code className="block text-[11px] text-white font-mono bg-dt-panel rounded-lg px-3 py-2 break-all mb-2">{identitySecret.secret}</code>
                <p className="text-[11px] text-dt-support mb-1">On your server, sign each end user’s hash and pass it to the widget as <code className="text-indigo-300">userHash</code>:</p>
                <pre className="text-[11px] text-dt-support font-mono bg-dt-panel rounded-lg p-3 overflow-x-auto whitespace-pre">{`const crypto = require('crypto');
const b64url = s => Buffer.from(s, 'utf8').toString('base64url');
const canonical =
  'dtwidget.v1\\n' +
  'euid=' + b64url(endUserRef) + '\\n' +
  'acct=' + b64url(accountRef || '');
const userHash = crypto
  .createHmac('sha256', SECRET)   // the secret above, from env
  .update(canonical).digest('hex');
// then: DreamTeamWidget.init({ …, endUserRef, accountRef, userHash })`}</pre>
                <button onClick={() => setIdentitySecret(null)} className="mt-2 text-[11px] text-dt-muted hover:text-dt-support">Done — I’ve saved it</button>
              </div>
            )}
          </div>

          <div className="bg-dt-card border border-dt-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">End-User Activity</h2>
            <p className="text-xs text-dt-support mb-3">Recent end users who asked questions through the widget.</p>
            {endUserSessions.length === 0 ? (
              <LiveEmptyState icon="◎" title="No end-user activity yet" body="Recent end users who ask questions through the widget will show up here." />
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-dt-muted text-left">
                    <th className="pb-2 font-medium">Account</th>
                    <th className="pb-2 font-medium">Name</th>
                    <th className="pb-2 font-medium">First seen</th>
                    <th className="pb-2 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {endUserSessions.map(s => (
                    <tr key={s.id} className="border-t border-dt-border text-dt-support">
                      <td className="py-2 font-mono">{s.account_external_ref || '—'}</td>
                      <td className="py-2">{s.display_name || s.end_user_ref || '—'}</td>
                      <td className="py-2 text-dt-muted">{new Date(s.created_at).toLocaleDateString()}</td>
                      <td className="py-2 text-dt-muted">{new Date(s.last_seen_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Identity — domain ownership, SSO policy, SCIM provisioning.
          Order matters: a domain must be VERIFIED before the SSO policy or JIT
          can route anyone by it, so the claim panel leads. */}
      {activeTab === 'identity' && (
        <div className="max-w-3xl space-y-6">
          <DomainClaimPanel />
          <SsoPolicyPanel />
          <ScimTokensPanel />
        </div>
      )}

      {/* Data rights — export before delete, deliberately in that order.
          Someone who arrives intending to delete should pass the export on the
          way, because the deletion is irreversible and there are no automated
          backups behind it. */}
      {activeTab === 'data' && (
        <div className="max-w-3xl space-y-6">
          <DataExportPanel />
          <DeleteWorkspacePanel />
        </div>
      )}

      {/* Workforce trust defaults (docs/31 Q7): the workspace-wide dial rows
          and tenant-wide promotion history finally have a Settings home —
          they used to be editable only from inside one arbitrary employee's
          file. Per-employee trust stays on each employee's file. */}
      {activeTab === 'trust' && (
        <div className="space-y-4">
          {/* Org-level first: the stop button and the workforce-wide measures.
              Neither mentions a job function. */}
          <WorkforceTrustPanel />
          {/* Then what is still genuinely workspace-level and true: ladder
              policies owned by no employee, and the promotion history. */}
          <WorkforceTrustDefaults setPage={setPage} />
        </div>
      )}

      {/* Security & Access moved here from the Governance hub (founder call).
          It was the ONE governance surface that is pure administration — API
          keys, MFA, sessions, IP allowlist — sitting at ADMIN tier inside a
          MANAGE-tier module, and it DUPLICATED this tab, which was only ever a
          "coming soon" placeholder. Nothing was lost in the merge: the real
          screen replaces a stub. */}
      {activeTab === 'security' && <SecurityAccessPage />}

      {activeTab === 'billing' && (
        <div className="max-w-2xl">
          <div className="bg-dt-card border border-dt-border rounded-xl p-8 text-center">
            <div className="text-4xl mb-3">*</div>
            <div className="text-sm font-medium text-white mb-1 capitalize">{activeTab} Settings</div>
            <div className="text-xs text-dt-support">Configuration options for {activeTab} coming soon.</div>
          </div>
        </div>
      )}
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
