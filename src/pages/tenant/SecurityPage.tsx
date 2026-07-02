import React, { useState, useEffect, useRef } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { Badge, StatCard, PageTabs, ADMIN_TABS } from '../../components';
import { supabase } from '../../supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  keySuffix: string;
  permissions: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  status: 'active' | 'revoked';
}

interface Session {
  id: string;
  userName: string;
  userEmail: string;
  device: string;
  ipAddress: string;
  location: string;
  startedAt: string;
  lastActivityAt: string;
  isCurrent: boolean;
}

interface IpEntry {
  id: string;
  ip: string;
  label: string;
}

const PLATFORM_FEATURES = [
  { id: 'kb_approval_workflow', name: 'KB Approval Workflow', desc: 'Require articles to go through review before publishing', defaultOn: true, minRole: 'tenant_manager' },
  { id: 'playbook_execution', name: 'Playbook Execution', desc: 'Allow DEs to execute operational playbooks', defaultOn: true, minRole: 'tenant_admin' },
  { id: 'connector_write', name: 'Connector Write Access', desc: 'Allow DEs to write data back to connected systems', defaultOn: false, minRole: 'tenant_admin' },
  { id: 'outbound_email', name: 'Outbound DE Email', desc: 'Allow DEs to send emails on behalf of your brand', defaultOn: false, minRole: 'tenant_admin' },
  { id: 'invoice_generation', name: 'Invoice Generation', desc: 'Enable the invoice generator in Finance', defaultOn: true, minRole: 'tenant_manager' },
  { id: 'audit_export', name: 'Audit Log Export', desc: 'Allow exporting audit logs to CSV', defaultOn: true, minRole: 'tenant_owner' },
  { id: 'api_keys', name: 'API Key Management', desc: 'Allow creation of API keys for external integrations', defaultOn: true, minRole: 'tenant_owner' },
  { id: 'sso', name: 'SSO / SAML', desc: 'Enable single sign-on via SAML 2.0 or OIDC', defaultOn: false, minRole: 'tenant_owner' },
  { id: 'de_cost_controls', name: 'DE Cost Controls', desc: 'Enforce token budgets and cost limits per DE', defaultOn: true, minRole: 'tenant_admin' },
  { id: 'customer_portal_embed', name: 'Portal Embed Widget', desc: 'Enable the embeddable chat widget for external websites', defaultOn: true, minRole: 'tenant_admin' },
  { id: 'sentiment_routing', name: 'Sentiment-based Routing', desc: 'Route negative-sentiment conversations to senior agents', defaultOn: false, minRole: 'tenant_admin' },
  { id: 'multi_agent', name: 'Multi-Agent Collaboration', desc: 'Allow DEs to delegate tasks to other DEs', defaultOn: false, minRole: 'tenant_owner' },
];

const PERMISSION_GROUPS = [
  { label: 'Conversations', perms: ['read:conversations', 'write:conversations'] },
  { label: 'Knowledge Base', perms: ['read:knowledge', 'write:knowledge'] },
  { label: 'Playbooks', perms: ['read:playbooks', 'write:playbooks', 'execute:playbooks'] },
  { label: 'Digital Employees', perms: ['read:agents', 'configure:agents'] },
  { label: 'Connectors', perms: ['read:connectors', 'write:connectors'] },
  { label: 'Analytics', perms: ['read:analytics'] },
  { label: 'Admin', perms: ['admin:full'] },
];

const OIDC_PRESETS: Record<string, string> = {
  Okta: 'https://your-domain.okta.com/.well-known/openid-configuration',
  'Google Workspace': 'https://accounts.google.com/.well-known/openid-configuration',
  'Azure AD': 'https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration',
  Auth0: 'https://your-domain.auth0.com/.well-known/openid-configuration',
  Custom: '',
};

// ─── Component ───────────────────────────────────────────────────────────────

const SecurityPage = ({
  user,
  tenant,
  page,
  setPage,
}: {
  user?: AuthUser;
  tenant?: Tenant;
  page: Page;
  setPage: (p: Page) => void;
}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const tenantId = tenant?.id || 'demo';

  const [activeTab, setActiveTab] = useState<'overview' | 'rbac' | 'audit' | 'compliance' | 'approvals' | 'api_keys' | 'sso' | 'features' | 'sessions'>('overview');

  // ── toast ──
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  // ── audit logs ──
  const auditLogs = [
    { time: '10:42 AM', user: 'Morgan Chen', action: 'Approved credit request for customer Emily Carter ($350)', type: 'approval', severity: 'info' },
    { time: '10:38 AM', user: 'Support Agent', action: 'Attempted password reset for customer James Liu — awaiting approval', type: 'agent_action', severity: 'warn' },
    { time: '10:21 AM', user: 'Taylor Smith', action: 'Added new team member with manager role', type: 'admin', severity: 'info' },
    { time: '9:55 AM', user: 'Billing Agent', action: 'Issued $120 credit to account 7712 within auto-approve limit', type: 'agent_action', severity: 'info' },
    { time: '9:30 AM', user: 'Morgan Chen', action: 'Exported full tenant data backup', type: 'admin', severity: 'warn' },
    { time: '9:10 AM', user: 'IT Helpdesk Agent', action: 'Provisioned software access for new hire Sarah M.', type: 'agent_action', severity: 'info' },
  ];
  const [realAuditLogs, setRealAuditLogs] = useState<any[]>([]);
  const [auditSeverity, setAuditSeverity] = useState('all');
  const [auditType, setAuditType] = useState('all');
  const [auditRange, setAuditRange] = useState('last_7');
  const [auditUser, setAuditUser] = useState('');
  const [auditDrawer, setAuditDrawer] = useState<any>(null);

  useEffect(() => {
    if (!tenant?.id) return;
    supabase
      .from('audit_log')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => {
        if (data && data.length > 0) setRealAuditLogs(data);
      });
  }, [tenant?.id]);

  const displayedLogs = realAuditLogs.length > 0
    ? realAuditLogs.map((d: any) => ({
        time: new Date(d.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        user: d.actor_user_id || 'System',
        action: d.action,
        type: d.entity_type || 'system',
        severity: d.severity || 'info',
        raw: d,
      }))
    : auditLogs.map((l) => ({ ...l, raw: l }));

  const filteredLogs = displayedLogs.filter((l) => {
    if (auditSeverity !== 'all' && l.severity !== auditSeverity) return false;
    if (auditType !== 'all' && l.type !== auditType) return false;
    if (auditUser && !l.user.toLowerCase().includes(auditUser.toLowerCase())) return false;
    return true;
  });

  const exportAuditCSV = () => {
    const header = 'Timestamp,User,Action,Type,Severity\n';
    const rows = filteredLogs.map((l) => `"${l.time}","${l.user}","${l.action}","${l.type}","${l.severity}"`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_log_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── team members ──
  const teamMembers = [
    { name: 'Morgan Chen', email: 'morgan@acme.com', role: 'tenant_owner', lastActive: '2 min ago' },
    { name: 'Taylor Smith', email: 'taylor@acme.com', role: 'tenant_admin', lastActive: '1 hr ago' },
    { name: 'Quinn Park', email: 'quinn@acme.com', role: 'tenant_manager', lastActive: '3 hr ago' },
    { name: 'Drew Wilson', email: 'drew@acme.com', role: 'tenant_user', lastActive: '1 day ago' },
    { name: 'Sarah Martinez', email: 'sarah@acme.com', role: 'tenant_user', lastActive: '3 days ago' },
  ];

  const severityColor: Record<string, string> = {
    info: 'text-blue-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
  };

  // ── approvals ──
  const [adminPending, setAdminPending] = useState([
    { id: 'aa1', action: 'Reset 2FA and send recovery codes', agent: 'Security Agent', tenant: 'Globex Corp', confidence: 88, risk: 'high', requestedAt: '12 min ago' },
    { id: 'aa2', action: 'Issue $500 service credit', agent: 'Billing Agent', tenant: 'Acme Corp', confidence: 91, risk: 'medium', requestedAt: '40 min ago' },
    { id: 'aa3', action: 'Delete inactive user account', agent: 'Account Agent', tenant: 'Initech', confidence: 96, risk: 'high', requestedAt: '1 hr ago' },
  ]);
  const [adminDecisionLog, setAdminDecisionLog] = useState<any[]>([]);
  const [adminDecidingId, setAdminDecidingId] = useState<string | null>(null);
  const [adminToast, setAdminToast] = useState<any>(null);

  const handleAdminDecision = async (item: any, decision: string) => {
    setAdminDecidingId(item.id);
    const decidedAt = new Date();
    const deciderName = user && user.name ? user.name : 'Admin';
    try {
      await supabase.from('agent_actions').insert({
        action: item.action, agent: item.agent, tenant: item.tenant,
        confidence: item.confidence, risk: item.risk, status: decision,
        decided_by: deciderName, decided_at: decidedAt.toISOString(),
      });
    } catch (e) { /* optional */ }
    setAdminPending((prev) => prev.filter((x) => x.id !== item.id));
    setAdminDecisionLog((prev) => [
      { ...item, decision, deciderName, decidedAtLabel: decidedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
      ...prev,
    ]);
    setAdminDecidingId(null);
    setAdminToast({ decision, action: item.action });
    setTimeout(() => setAdminToast(null), 3200);
  };

  // ── API Keys ──
  const [apiKeys, setApiKeys] = useState<ApiKey[]>(() => {
    try { return JSON.parse(localStorage.getItem(`dt_api_keys_${tenantId}`) || '[]'); } catch { return []; }
  });
  const [showRevoked, setShowRevoked] = useState(false);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyPerms, setNewKeyPerms] = useState<string[]>([]);
  const [newKeyExpiry, setNewKeyExpiry] = useState('never');
  const [newKeyCustomDate, setNewKeyCustomDate] = useState('');
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null);

  const saveApiKeys = (keys: ApiKey[]) => {
    setApiKeys(keys);
    localStorage.setItem(`dt_api_keys_${tenantId}`, JSON.stringify(keys));
  };

  const generateApiKey = () => {
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    const fullKey = `dt_live_${hex}`;
    const expiresAt = newKeyExpiry === 'never' ? null
      : newKeyExpiry === '30d' ? new Date(Date.now() + 30 * 86400000).toISOString()
      : newKeyExpiry === '90d' ? new Date(Date.now() + 90 * 86400000).toISOString()
      : newKeyExpiry === '1y' ? new Date(Date.now() + 365 * 86400000).toISOString()
      : newKeyCustomDate ? new Date(newKeyCustomDate).toISOString() : null;
    const key: ApiKey = {
      id: crypto.randomUUID(),
      name: newKeyName || 'Unnamed Key',
      keyPrefix: 'dt_live_',
      keySuffix: hex.slice(-4),
      permissions: newKeyPerms,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      expiresAt,
      status: 'active',
    };
    saveApiKeys([...apiKeys, key]);
    setGeneratedKey(fullKey);
    setShowCreateKey(false);
    setNewKeyName(''); setNewKeyPerms([]); setNewKeyExpiry('never'); setNewKeyCustomDate('');
  };

  const revokeKey = (id: string) => {
    saveApiKeys(apiKeys.map((k) => k.id === id ? { ...k, status: 'revoked' as const } : k));
    setRevokeConfirm(null);
    showToast('API key revoked');
  };

  const keyUsage = useRef<Record<string, number>>({});
  const getUsage = (id: string) => {
    if (!keyUsage.current[id]) keyUsage.current[id] = Math.floor(Math.random() * 200) + 1;
    return keyUsage.current[id];
  };

  // ── SSO ──
  const [ssoConfig, setSsoConfig] = useState<any>(() => {
    try { return JSON.parse(localStorage.getItem(`dt_sso_config_${tenantId}`) || 'null'); } catch { return null; }
  });
  const [ssoProtocol, setSsoProtocol] = useState<'saml' | 'oidc'>('saml');
  const [samlForm, setSamlForm] = useState({ entityId: '', ssoUrl: '', certificate: '', emailAttr: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', firstNameAttr: 'givenname', lastNameAttr: 'surname', roleAttr: '' });
  const [oidcForm, setOidcForm] = useState({ preset: 'Custom', clientId: '', clientSecret: '', discoveryUrl: '', scopes: ['openid', 'email', 'profile', 'groups'] });
  const [ssoTesting, setSsoTesting] = useState(false);
  const [ssoTestResult, setSsoTestResult] = useState<string | null>(null);
  const [jitEnabled, setJitEnabled] = useState(false);
  const [jitRole, setJitRole] = useState('tenant_user');
  const [allowedDomains, setAllowedDomains] = useState('');

  const testSSO = () => {
    setSsoTesting(true); setSsoTestResult(null);
    setTimeout(() => { setSsoTesting(false); setSsoTestResult('success'); }, 1500);
  };

  const saveSSO = () => {
    const config = { protocol: ssoProtocol, saml: samlForm, oidc: oidcForm, jit: { enabled: jitEnabled, defaultRole: jitRole, allowedDomains }, savedAt: new Date().toISOString() };
    setSsoConfig(config);
    localStorage.setItem(`dt_sso_config_${tenantId}`, JSON.stringify(config));
    showToast('SSO configuration saved and enabled');
  };

  const downloadSpMetadata = () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor entityID="https://app.dreamteam.ai/saml/metadata/${tenantId}" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://app.dreamteam.ai/saml/acs/${tenantId}" index="1"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'dreamteam-sp-metadata.xml'; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Feature Flags ──
  const [features, setFeatures] = useState<Record<string, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`dt_features_${tenantId}`) || '{}');
      const defaults: Record<string, boolean> = {};
      PLATFORM_FEATURES.forEach((f) => { defaults[f.id] = f.id in saved ? saved[f.id] : f.defaultOn; });
      return defaults;
    } catch {
      const d: Record<string, boolean> = {};
      PLATFORM_FEATURES.forEach((f) => { d[f.id] = f.defaultOn; });
      return d;
    }
  });

  const saveFeatures = (next: Record<string, boolean>) => {
    setFeatures(next);
    localStorage.setItem(`dt_features_${tenantId}`, JSON.stringify(next));
  };

  const toggleFeature = (id: string) => saveFeatures({ ...features, [id]: !features[id] });

  const resetFeatures = () => {
    const d: Record<string, boolean> = {};
    PLATFORM_FEATURES.forEach((f) => { d[f.id] = f.defaultOn; });
    saveFeatures(d);
    showToast('Feature flags reset to defaults');
  };

  // ── Sessions ──
  const [sessions, setSessions] = useState<Session[]>([
    { id: 's1', userName: 'Morgan Chen', userEmail: 'morgan@acme.com', device: 'Chrome on Windows 11', ipAddress: '203.0.113.45', location: 'New York, US', startedAt: '2 hr ago', lastActivityAt: '2 min ago', isCurrent: true },
    { id: 's2', userName: 'Taylor Smith', userEmail: 'taylor@acme.com', device: 'Safari on iPhone 15', ipAddress: '192.168.1.42', location: 'Chicago, US', startedAt: '5 hr ago', lastActivityAt: '1 hr ago', isCurrent: false },
    { id: 's3', userName: 'Quinn Park', userEmail: 'quinn@acme.com', device: 'Firefox on macOS', ipAddress: '10.0.0.88', location: 'London, UK', startedAt: '1 day ago', lastActivityAt: '3 hr ago', isCurrent: false },
    { id: 's4', userName: 'Drew Wilson', userEmail: 'drew@acme.com', device: 'Chrome on Windows 10', ipAddress: '172.16.0.5', location: 'Toronto, CA', startedAt: '2 days ago', lastActivityAt: '1 day ago', isCurrent: false },
    { id: 's5', userName: 'Sarah Martinez', userEmail: 'sarah@acme.com', device: 'Edge on Windows 11', ipAddress: '192.168.2.10', location: 'Austin, US', startedAt: '3 days ago', lastActivityAt: '3 days ago', isCurrent: false },
  ]);
  const [revokeAllConfirm, setRevokeAllConfirm] = useState(false);
  const [sessionPolicy, setSessionPolicy] = useState<any>(() => {
    try { return JSON.parse(localStorage.getItem(`dt_session_policy_${tenantId}`) || '{}'); } catch { return {}; }
  });
  const [sessionTimeout, setSessionTimeout] = useState(sessionPolicy.timeout || '8h');
  const [requireReauth, setRequireReauth] = useState<boolean>(sessionPolicy.requireReauth ?? true);
  const [maxSessions, setMaxSessions] = useState<number>(sessionPolicy.maxSessions || 5);

  const saveSessionPolicy = () => {
    const p = { timeout: sessionTimeout, requireReauth, maxSessions };
    setSessionPolicy(p);
    localStorage.setItem(`dt_session_policy_${tenantId}`, JSON.stringify(p));
    showToast('Session policy saved');
  };

  const revokeSession = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    setSessions((prev) => prev.filter((x) => x.id !== id));
    showToast(`Session revoked — ${s?.userName} will be signed out`);
  };

  const revokeAllSessions = () => {
    setSessions((prev) => prev.filter((x) => x.isCurrent));
    setRevokeAllConfirm(false);
    showToast('All other sessions revoked');
  };

  const loginData = [8, 12, 5, 15, 9, 11, 7];
  const loginDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const loginMax = Math.max(...loginData);

  // ── IP Allowlist ──
  const [ipExpanded, setIpExpanded] = useState(false);
  const [mfaExpanded, setMfaExpanded] = useState(false);
  const [ipEnabled, setIpEnabled] = useState(false);
  const [ipList, setIpList] = useState<IpEntry[]>([]);
  const [mfaPolicy, setMfaPolicy] = useState<any>(() => {
    try { return JSON.parse(localStorage.getItem(`dt_mfa_policy_${tenantId}`) || '{}'); } catch { return {}; }
  });
  const [mfaFor, setMfaFor] = useState<string[]>(mfaPolicy.mfaFor || ['admins_only']);
  const [mfaMethods, setMfaMethods] = useState<string[]>(mfaPolicy.methods || ['authenticator']);

  const saveIpAllowlist = (enabled: boolean, list: IpEntry[]) => {
    localStorage.setItem(`dt_ip_allowlist_${tenantId}`, JSON.stringify({ enabled, list }));
  };

  const addIp = () => {
    const entry: IpEntry = { id: crypto.randomUUID(), ip: '', label: '' };
    const next = [...ipList, entry];
    setIpList(next); saveIpAllowlist(ipEnabled, next);
  };

  const updateIp = (id: string, field: 'ip' | 'label', val: string) => {
    const next = ipList.map((e) => e.id === id ? { ...e, [field]: val } : e);
    setIpList(next); saveIpAllowlist(ipEnabled, next);
  };

  const removeIp = (id: string) => {
    const next = ipList.filter((e) => e.id !== id);
    setIpList(next); saveIpAllowlist(ipEnabled, next);
  };

  const saveMfa = () => {
    const p = { mfaFor, methods: mfaMethods };
    setMfaPolicy(p);
    localStorage.setItem(`dt_mfa_policy_${tenantId}`, JSON.stringify(p));
    showToast('MFA policy saved');
  };

  const toggleArr = (arr: string[], val: string, set: (v: string[]) => void) => {
    set(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);
  };

  const securityItems = [
    { label: 'Data Encryption at rest and in transit', status: 'pass', expandable: false, key: '' },
    { label: 'Multi-Factor Authentication enabled', status: 'pass', expandable: true, key: 'mfa' },
    { label: 'RBAC roles correctly configured', status: 'pass', expandable: false, key: '' },
    { label: 'Agent action approval flows active', status: 'pass', expandable: false, key: '' },
    { label: 'Audit logging enabled', status: 'pass', expandable: false, key: '' },
    { label: 'SSO integration configured', status: ssoConfig ? 'pass' : 'warn', expandable: false, key: '' },
    { label: 'IP allowlist configured', status: ipEnabled && ipList.length > 0 ? 'pass' : 'warn', expandable: true, key: 'ip' },
  ];

  const TABS = ['overview', 'rbac', 'approvals', 'audit', 'compliance', 'api_keys', 'sso', 'features', 'sessions'] as const;
  const TAB_LABELS: Record<string, string> = {
    api_keys: 'API Keys', sso: 'SSO', features: 'Feature Flags', sessions: 'Sessions',
    overview: 'Overview', rbac: 'RBAC', approvals: 'Approvals', audit: 'Audit', compliance: 'Compliance',
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-emerald-600 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      <PageTabs tabs={ADMIN_TABS} page={page} setPage={setPage} accentColor={accentColor} />
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Security and RBAC</h1>
          <p className="text-slate-400 text-sm mt-1">Access control, audit logging, and compliance for your AI platform</p>
        </div>
        <div className="flex gap-1 bg-slate-800 rounded-xl p-1 flex-wrap justify-end max-w-2xl">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === t ? 'text-white' : 'text-slate-400 hover:text-white'}`}
              style={activeTab === t ? { backgroundColor: accentColor } : {}}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {/* ── OVERVIEW ── */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Team Members" value={String(teamMembers.length)} icon="👥" color="blue" />
            <StatCard label="Active Sessions" value={String(sessions.length)} icon="🔐" color="emerald" />
            <StatCard label="Audit Events Today" value="47" icon="📋" color="indigo" />
            <StatCard label="Compliance Score" value="98%" icon="✅" color="amber" trend="Enterprise grade" />
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Security Posture</h2>
            <div className="space-y-2">
              {securityItems.map((item, i) => (
                <div key={i}>
                  <div
                    className={`flex items-center gap-3 p-3 bg-slate-800/50 rounded-xl ${item.expandable ? 'cursor-pointer hover:bg-slate-800/80' : ''}`}
                    onClick={() => {
                      if (item.key === 'ip') setIpExpanded(!ipExpanded);
                      if (item.key === 'mfa') setMfaExpanded(!mfaExpanded);
                    }}
                  >
                    <span className={`text-sm ${item.status === 'pass' ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {item.status === 'pass' ? '✓' : '!'}
                    </span>
                    <span className="text-sm text-white flex-1">{item.label}</span>
                    {item.expandable && (
                      <span className="text-xs text-slate-500">{(item.key === 'ip' ? ipExpanded : mfaExpanded) ? '▲' : '▼'}</span>
                    )}
                    <Badge label={item.status === 'pass' ? 'Pass' : 'Review'} color={item.status === 'pass' ? 'green' : 'yellow'} />
                  </div>

                  {item.key === 'ip' && ipExpanded && (
                    <div className="mt-1 ml-4 p-4 bg-slate-800/30 border border-slate-700 rounded-xl space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-white font-medium">Enable IP Allowlist</span>
                        <button
                          onClick={() => { const next = !ipEnabled; setIpEnabled(next); saveIpAllowlist(next, ipList); }}
                          className={`relative w-10 h-5 rounded-full transition-colors ${ipEnabled ? 'bg-emerald-500' : 'bg-slate-600'}`}
                        >
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${ipEnabled ? 'left-5' : 'left-0.5'}`} />
                        </button>
                      </div>
                      {!ipEnabled && <p className="text-xs text-slate-400">All IPs allowed when disabled.</p>}
                      {ipEnabled && (
                        <>
                          {ipList.length === 0 && (
                            <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
                              No IPs added — all access will be blocked.
                            </div>
                          )}
                          <div className="text-xs text-slate-400 mb-1">
                            Your current IP: <span className="text-white">203.0.113.45</span>{' '}
                            <button className="text-indigo-400 hover:underline" onClick={() => {
                              const e: IpEntry = { id: crypto.randomUUID(), ip: '203.0.113.45', label: 'My IP' };
                              const next = [...ipList, e]; setIpList(next); saveIpAllowlist(ipEnabled, next);
                            }}>— Add this IP</button>
                          </div>
                          {ipList.map((entry) => (
                            <div key={entry.id} className="flex gap-2 items-center">
                              <input
                                className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500"
                                placeholder="192.168.1.0/24"
                                value={entry.ip}
                                onChange={(e) => updateIp(entry.id, 'ip', e.target.value)}
                              />
                              <input
                                className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500"
                                placeholder="Label (e.g. Office WiFi)"
                                value={entry.label}
                                onChange={(e) => updateIp(entry.id, 'label', e.target.value)}
                              />
                              <button className="text-red-400 hover:text-red-300 text-xs px-2" onClick={() => removeIp(entry.id)}>✕</button>
                            </div>
                          ))}
                          <button className="text-xs text-indigo-400 hover:text-indigo-300" onClick={addIp}>+ Add IP range</button>
                        </>
                      )}
                    </div>
                  )}

                  {item.key === 'mfa' && mfaExpanded && (
                    <div className="mt-1 ml-4 p-4 bg-slate-800/30 border border-slate-700 rounded-xl space-y-4">
                      <div>
                        <p className="text-xs text-slate-400 font-medium mb-2">Require MFA for:</p>
                        {[['all_users', 'All users'], ['admins_only', 'Admins only'], ['sensitive_areas', 'When accessing sensitive areas']].map(([val, lbl]) => (
                          <label key={val} className="flex items-center gap-2 mb-1 cursor-pointer">
                            <input type="checkbox" checked={mfaFor.includes(val)} onChange={() => toggleArr(mfaFor, val, setMfaFor)} className="accent-indigo-500" />
                            <span className="text-xs text-white">{lbl}</span>
                          </label>
                        ))}
                      </div>
                      <div>
                        <p className="text-xs text-slate-400 font-medium mb-2">Allowed MFA methods:</p>
                        {[['authenticator', 'Authenticator app'], ['sms', 'SMS'], ['email_otp', 'Email OTP']].map(([val, lbl]) => (
                          <label key={val} className="flex items-center gap-2 mb-1 cursor-pointer">
                            <input type="checkbox" checked={mfaMethods.includes(val)} onChange={() => toggleArr(mfaMethods, val, setMfaMethods)} className="accent-indigo-500" />
                            <span className="text-xs text-white">{lbl}</span>
                          </label>
                        ))}
                      </div>
                      <button className="text-xs px-3 py-1.5 text-white rounded-lg" style={{ backgroundColor: accentColor }} onClick={saveMfa}>Save MFA Policy</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── RBAC ── */}
      {activeTab === 'rbac' && (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Team Members and Roles</h2>
              <button className="text-xs px-3 py-1.5 text-white rounded-lg" style={{ backgroundColor: accentColor }}>Invite Member</button>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Member', 'Email', 'Role', 'Last Active'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {teamMembers.map((m, i) => (
                  <tr key={i} className="hover:bg-slate-800/30 transition-all">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ backgroundColor: accentColor + '60' }}>
                          {m.name.split(' ').map((n) => n[0]).join('')}
                        </div>
                        <span className="text-sm text-white">{m.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">{m.email}</td>
                    <td className="px-4 py-3">
                      <Badge label={m.role.replace('tenant_', '')} color={m.role === 'tenant_owner' ? 'red' : m.role === 'tenant_admin' ? 'amber' : 'blue'} />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{m.lastActive}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── AUDIT ── */}
      {activeTab === 'audit' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs text-slate-400 font-medium">Severity:</span>
              {['all', 'info', 'warn', 'error'].map((s) => (
                <button key={s} onClick={() => setAuditSeverity(s)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-all capitalize ${auditSeverity === s ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300' : 'border-slate-700 text-slate-400 hover:text-white'}`}>
                  {s}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs text-slate-400 font-medium">Type:</span>
              {['all', 'approval', 'agent_action', 'admin', 'system'].map((t) => (
                <button key={t} onClick={() => setAuditType(t)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-all ${auditType === t ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300' : 'border-slate-700 text-slate-400 hover:text-white'}`}>
                  {t.replace('_', ' ')}
                </button>
              ))}
            </div>
            <div className="flex gap-3 items-center flex-wrap">
              <select value={auditRange} onChange={(e) => setAuditRange(e.target.value)}
                className="bg-slate-800 border border-slate-700 text-xs text-white rounded-lg px-2 py-1.5">
                <option value="today">Today</option>
                <option value="last_7">Last 7 days</option>
                <option value="last_30">Last 30 days</option>
                <option value="custom">Custom</option>
              </select>
              <input value={auditUser} onChange={(e) => setAuditUser(e.target.value)}
                placeholder="Filter by user..."
                className="bg-slate-800 border border-slate-700 text-xs text-white rounded-lg px-3 py-1.5 placeholder-slate-500 w-40" />
              <button onClick={exportAuditCSV} className="ml-auto text-xs px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700">
                Export CSV
              </button>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Audit Log</h2>
              <span className="text-xs text-slate-500">{filteredLogs.length} entries</span>
            </div>
            <div className="divide-y divide-slate-800">
              {filteredLogs.map((log, i) => (
                <div key={i} className="flex items-start gap-4 px-5 py-3 hover:bg-slate-800/20 transition-all cursor-pointer" onClick={() => setAuditDrawer(log)}>
                  <span className={`text-sm mt-0.5 ${severityColor[log.severity] || 'text-slate-400'}`}>
                    {log.type === 'agent_action' ? '◆' : log.type === 'admin' ? '★' : '●'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-medium text-slate-300">{log.user}</span>
                      <Badge label={log.type.replace('_', ' ')} color={log.type === 'agent_action' ? 'blue' : log.type === 'admin' ? 'purple' : 'slate'} />
                      <Badge label={log.severity} color={log.severity === 'error' ? 'red' : log.severity === 'warn' ? 'yellow' : 'slate'} />
                    </div>
                    <div className="text-xs text-slate-400">{log.action}</div>
                  </div>
                  <span className="text-xs text-slate-600 flex-shrink-0">{log.time}</span>
                </div>
              ))}
            </div>
          </div>

          {auditDrawer && (
            <div className="fixed inset-0 z-40 flex" onClick={() => setAuditDrawer(null)}>
              <div className="flex-1 bg-black/40" />
              <div className="w-96 bg-slate-900 border-l border-slate-700 p-6 overflow-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-white">Log Entry Detail</h3>
                  <button className="text-slate-400 hover:text-white" onClick={() => setAuditDrawer(null)}>✕</button>
                </div>
                <div className="space-y-3">
                  {([['Time', auditDrawer.time], ['User', auditDrawer.user], ['Action', auditDrawer.action], ['Type', auditDrawer.type], ['Severity', auditDrawer.severity]] as [string, string][]).map(([k, v]) => (
                    <div key={k}>
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-0.5">{k}</p>
                      <p className="text-sm text-white">{v}</p>
                    </div>
                  ))}
                  {auditDrawer.raw?.before_data && (
                    <div>
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Before State</p>
                      <pre className="text-xs text-emerald-300 bg-slate-800 rounded-lg p-3 overflow-auto">{JSON.stringify(auditDrawer.raw.before_data, null, 2)}</pre>
                    </div>
                  )}
                  {auditDrawer.raw?.after_data && (
                    <div>
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">After State</p>
                      <pre className="text-xs text-amber-300 bg-slate-800 rounded-lg p-3 overflow-auto">{JSON.stringify(auditDrawer.raw.after_data, null, 2)}</pre>
                    </div>
                  )}
                  <button className="w-full text-xs px-3 py-2 text-white rounded-lg mt-2" style={{ backgroundColor: accentColor }} onClick={() => {
                    const csv = `Timestamp,User,Action,Type,Severity\n"${auditDrawer.time}","${auditDrawer.user}","${auditDrawer.action}","${auditDrawer.type}","${auditDrawer.severity}"`;
                    const blob = new Blob([csv], { type: 'text/csv' });
                    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'audit_entry.csv'; a.click();
                  }}>Export this entry</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── COMPLIANCE ── */}
      {activeTab === 'compliance' && (() => {
        const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const todayISO = new Date().toISOString().slice(0, 10);
        const overallScore = 73;

        const frameworks = [
          {
            name: 'SOC 2 Type II', abbr: 'SOC', status: 'In Progress', pct: 65, controls: [26, 40],
            gaps: ['Incident response procedures not documented', 'Vendor risk assessments incomplete', 'Change management process not formalized'],
            ctrlList: [
              { id: 'CC1.1', name: 'Management oversight', st: 'pass' },
              { id: 'CC2.1', name: 'Internal communications', st: 'pass' },
              { id: 'CC3.1', name: 'Risk assessment', st: 'fail' },
              { id: 'CC6.1', name: 'Logical access controls', st: 'pass' },
              { id: 'CC7.1', name: 'Change management', st: 'fail' },
              { id: 'CC8.1', name: 'Incident response', st: 'partial' },
            ],
          },
          {
            name: 'GDPR', abbr: 'GDP', status: 'In Progress', pct: 78, controls: [31, 40],
            gaps: ['Data retention policy needs update', 'Consent management not fully implemented'],
            ctrlList: [
              { id: 'Art.5', name: 'Data minimization', st: 'pass' },
              { id: 'Art.13', name: 'Privacy notice', st: 'pass' },
              { id: 'Art.17', name: 'Right to erasure', st: 'partial' },
              { id: 'Art.25', name: 'Privacy by design', st: 'pass' },
              { id: 'Art.32', name: 'Security measures', st: 'pass' },
              { id: 'Art.33', name: 'Breach notification', st: 'fail' },
            ],
          },
          {
            name: 'ISO 27001', abbr: 'ISO', status: 'In Progress', pct: 42, controls: [17, 40],
            gaps: ['Asset inventory not complete', 'Supplier security policies missing', 'Business continuity plan not tested'],
            ctrlList: [
              { id: 'A.5', name: 'Info security policies', st: 'pass' },
              { id: 'A.6', name: 'Organisation of security', st: 'partial' },
              { id: 'A.8', name: 'Asset management', st: 'fail' },
              { id: 'A.9', name: 'Access control', st: 'pass' },
              { id: 'A.12', name: 'Operations security', st: 'partial' },
            ],
          },
          {
            name: 'HIPAA', abbr: 'HIP', status: 'Not Started', pct: 0, controls: [0, 40],
            gaps: ['BAA not available', 'PHI data not classified', 'Audit controls not implemented'],
            ctrlList: [
              { id: '164.308', name: 'Administrative safeguards', st: 'fail' },
              { id: '164.310', name: 'Physical safeguards', st: 'fail' },
              { id: '164.312', name: 'Technical safeguards', st: 'fail' },
            ],
          },
          {
            name: 'PCI DSS', abbr: 'PCI', status: 'Not Started', pct: 0, controls: [0, 40],
            gaps: ['SAQ not completed', 'Cardholder data environment not scoped', 'Network segmentation not implemented'],
            ctrlList: [
              { id: 'Req 1', name: 'Install/maintain network controls', st: 'fail' },
              { id: 'Req 2', name: 'Secure vendor defaults', st: 'fail' },
              { id: 'Req 6', name: 'Develop secure systems', st: 'fail' },
            ],
          },
          {
            name: 'CCPA', abbr: 'CCP', status: 'In Progress', pct: 55, controls: [22, 40],
            gaps: ['Consumer request process not fully automated', 'Third-party data sharing not fully documented'],
            ctrlList: [
              { id: 'Sec.1798.100', name: 'Right to know', st: 'pass' },
              { id: 'Sec.1798.105', name: 'Right to delete', st: 'partial' },
              { id: 'Sec.1798.120', name: 'Right to opt-out', st: 'pass' },
              { id: 'Sec.1798.150', name: 'Security', st: 'fail' },
            ],
          },
        ];

        const [expandedFramework, setExpandedFramework] = useState<string | null>(null);
        const [reportModal, setReportModal] = useState(false);
        const [reportType, setReportType] = useState('Full Audit Report');
        const [reportFrameworks, setReportFrameworks] = useState<string[]>(['SOC 2 Type II', 'GDPR']);
        const [reportPeriod, setReportPeriod] = useState('This Quarter');
        const [reportIncludes, setReportIncludes] = useState<string[]>(['Audit log excerpt', 'Team access review']);
        const [generating, setGenerating] = useState(false);

        const toggleReportFw = (name: string) => setReportFrameworks(prev => prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]);
        const toggleReportInclude = (name: string) => setReportIncludes(prev => prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]);

        const generateReport = async () => {
          setGenerating(true);
          await new Promise(r => setTimeout(r, 2000));
          const selectedFws = frameworks.filter(f => reportFrameworks.includes(f.name));
          const ctrlRows = selectedFws.flatMap(f => f.ctrlList.map(c => `<tr><td style="padding:6px 12px;border-bottom:1px solid #334155">${f.name}</td><td style="padding:6px 12px;border-bottom:1px solid #334155">${c.id}</td><td style="padding:6px 12px;border-bottom:1px solid #334155">${c.name}</td><td style="padding:6px 12px;border-bottom:1px solid #334155;color:${c.st === 'pass' ? '#10b981' : c.st === 'fail' ? '#ef4444' : '#f59e0b'}">${c.st.toUpperCase()}</td></tr>`)).join('');
          const fwSummary = selectedFws.map(f => `<tr><td style="padding:6px 12px;border-bottom:1px solid #334155">${f.name}</td><td style="padding:6px 12px;border-bottom:1px solid #334155">${f.status}</td><td style="padding:6px 12px;border-bottom:1px solid #334155">${f.pct}%</td><td style="padding:6px 12px;border-bottom:1px solid #334155">${f.controls[0]}/${f.controls[1]}</td></tr>`).join('');
          const auditExcerpt = reportIncludes.includes('Audit log excerpt') ? `<h2 style="color:#e2e8f0;margin-top:32px">Audit Log Excerpt</h2><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>${['Timestamp','User','Action','Type','Severity'].map(h=>`<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #334155;color:#94a3b8">${h}</th>`).join('')}</tr></thead><tbody>${[['10:42 AM','Morgan Chen','Approved credit request $350','approval','info'],['10:38 AM','Support Agent','Password reset attempt — pending','agent_action','warn'],['10:21 AM','Taylor Smith','Added team member — manager role','admin','info'],['9:55 AM','Billing Agent','Issued $120 credit to account 7712','agent_action','info'],['9:30 AM','Morgan Chen','Exported tenant data backup','admin','warn']].map(r=>`<tr>${r.map(c=>`<td style="padding:6px 12px;border-bottom:1px solid #1e293b;color:#cbd5e1">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
          const accessReview = reportIncludes.includes('Team access review') ? `<h2 style="color:#e2e8f0;margin-top:32px">Team Access Review</h2><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>${['Name','Email','Role','Last Active'].map(h=>`<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #334155;color:#94a3b8">${h}</th>`).join('')}</tr></thead><tbody>${[['Morgan Chen','morgan@acme.com','Owner','2 min ago'],['Taylor Smith','taylor@acme.com','Admin','1 hr ago'],['Quinn Park','quinn@acme.com','Manager','3 hr ago'],['Drew Wilson','drew@acme.com','User','1 day ago']].map(r=>`<tr>${r.map(c=>`<td style="padding:6px 12px;border-bottom:1px solid #1e293b;color:#cbd5e1">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Compliance Report — ${todayISO}</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:32px}h1{color:#fff}h2{color:#e2e8f0;font-size:16px;margin-top:24px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:8px 12px;border-bottom:2px solid #334155;color:#94a3b8}td{padding:6px 12px;border-bottom:1px solid #1e293b;color:#cbd5e1}.badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px}.score{font-size:48px;font-weight:700;color:#6366f1}</style></head><body><div style="border-bottom:2px solid #6366f1;padding-bottom:16px;margin-bottom:24px"><h1 style="margin:0">DreamTeam AI — Compliance Report</h1><p style="color:#64748b;margin:4px 0">${reportType} · ${reportPeriod} · Generated ${today}</p></div><div style="display:flex;align-items:center;gap:24px;margin-bottom:24px"><div><div class="score">${overallScore}%</div><div style="color:#64748b;font-size:13px">Overall Compliance Score</div></div><div style="flex:1"><p style="color:#94a3b8;font-size:13px">This report covers ${selectedFws.length} framework(s): ${reportFrameworks.join(', ')}. Assessment date: ${today}.</p></div></div><h2>Framework Summary</h2><table><thead><tr><th>Framework</th><th>Status</th><th>Progress</th><th>Controls</th></tr></thead><tbody>${fwSummary}</tbody></table><h2>Controls Detail</h2><table><thead><tr><th>Framework</th><th>Control ID</th><th>Control Name</th><th>Status</th></tr></thead><tbody>${ctrlRows}</tbody></table>${auditExcerpt}${accessReview}<div style="margin-top:40px;border-top:1px solid #334155;padding-top:16px;color:#475569;font-size:12px">Prepared by: ${user?.name || 'Admin'} · ${today} · DreamTeam AI Compliance Platform</div></body></html>`;
          const blob = new Blob([html], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `compliance_report_${todayISO}.html`;
          a.click();
          URL.revokeObjectURL(url);
          setGenerating(false);
          setReportModal(false);
          showToast('✓ Compliance report downloaded');
        };

        const statusColor = (s: string) => s === 'In Progress' ? 'bg-blue-500/15 text-blue-300 border-blue-500/30' : s === 'Ready for Audit' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : s === 'Certified' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : 'bg-slate-700/50 text-slate-400 border-slate-600/30';

        return (
          <>
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4 text-xs text-amber-300">
              Note: DreamTeam AI does not currently hold any of the certifications below. These represent compliance goals on our roadmap, not attained or audited certifications.
            </div>

            {/* Score dashboard */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-4">
              <div className="flex items-center gap-6">
                {/* Circular gauge */}
                <div className="relative w-24 h-24 flex-shrink-0">
                  <div className="w-24 h-24 rounded-full" style={{ background: `conic-gradient(${accentColor} ${overallScore * 3.6}deg, #1e293b ${overallScore * 3.6}deg)` }}>
                    <div className="absolute inset-2 rounded-full bg-slate-900 flex items-center justify-center">
                      <span className="text-lg font-bold text-white">{overallScore}%</span>
                    </div>
                  </div>
                </div>
                <div className="flex-1">
                  <h2 className="text-base font-semibold text-white mb-0.5">Overall Compliance Score</h2>
                  <p className="text-xs text-slate-500 mb-3">Last assessed: {today}</p>
                  <button onClick={() => setReportModal(true)}
                    className="px-4 py-2 text-sm font-medium text-white rounded-xl hover:opacity-90"
                    style={{ backgroundColor: accentColor }}>
                    Generate Compliance Report
                  </button>
                </div>
              </div>
            </div>

            {/* Framework cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {frameworks.map((fw) => (
                <div key={fw.name} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-slate-300 font-bold text-sm">{fw.abbr}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-white">{fw.name}</div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${statusColor(fw.status)}`}>{fw.status}</span>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold text-white">{fw.pct}%</div>
                      <div className="text-xs text-slate-500">{fw.controls[0]}/{fw.controls[1]} controls</div>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="w-full bg-slate-700 rounded-full h-1.5 mb-3">
                    <div className="h-full rounded-full transition-all" style={{ width: `${fw.pct}%`, backgroundColor: fw.pct > 0 ? accentColor : 'transparent' }} />
                  </div>

                  {/* Gaps */}
                  <div className="mb-3">
                    <p className="text-xs text-slate-500 font-medium mb-1">Key gaps:</p>
                    <ul className="space-y-0.5">
                      {fw.gaps.map((g, i) => (
                        <li key={i} className="text-xs text-slate-400 flex items-start gap-1">
                          <span className="text-red-400 flex-shrink-0 mt-0.5">•</span>
                          {g}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Expandable controls */}
                  <button onClick={() => setExpandedFramework(expandedFramework === fw.name ? null : fw.name)}
                    className="text-xs text-slate-400 hover:text-white transition-all flex items-center gap-1">
                    View Controls {expandedFramework === fw.name ? '▲' : '▼'}
                  </button>
                  {expandedFramework === fw.name && (
                    <div className="mt-3 space-y-1">
                      {fw.ctrlList.map(c => (
                        <div key={c.id} className="flex items-center gap-2 px-2 py-1.5 bg-slate-800/50 rounded-lg">
                          <span className={`text-xs font-medium w-3 ${c.st === 'pass' ? 'text-emerald-400' : c.st === 'fail' ? 'text-red-400' : 'text-amber-400'}`}>
                            {c.st === 'pass' ? '✓' : c.st === 'fail' ? '✗' : '~'}
                          </span>
                          <span className="text-xs text-slate-500 font-mono w-16 flex-shrink-0">{c.id}</span>
                          <span className="text-xs text-slate-300">{c.name}</span>
                          <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${c.st === 'pass' ? 'bg-emerald-500/15 text-emerald-400' : c.st === 'fail' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'}`}>
                            {c.st}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Report modal */}
            {reportModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-white font-semibold">Generate Compliance Report</h3>
                    <button onClick={() => setReportModal(false)} className="text-slate-400 hover:text-white text-lg">×</button>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Report type</label>
                      <select value={reportType} onChange={e => setReportType(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
                        <option>Full Audit Report</option>
                        <option>Executive Summary</option>
                        <option>Gap Analysis</option>
                        <option>Controls Evidence</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-2">Frameworks</label>
                      <div className="space-y-1.5">
                        {frameworks.map(fw => (
                          <label key={fw.name} className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" className="accent-indigo-500"
                              checked={reportFrameworks.includes(fw.name)}
                              onChange={() => toggleReportFw(fw.name)} />
                            <span className="text-xs text-white">{fw.name}</span>
                            <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${statusColor(fw.status)}`}>{fw.pct}%</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Period</label>
                      <select value={reportPeriod} onChange={e => setReportPeriod(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
                        <option>This Quarter</option>
                        <option>Last Quarter</option>
                        <option>Custom date range</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-2">Include</label>
                      <div className="space-y-1.5">
                        {['Audit log excerpt', 'Team access review', 'Data flow diagram', 'Risk register'].map(item => (
                          <label key={item} className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" className="accent-indigo-500"
                              checked={reportIncludes.includes(item)}
                              onChange={() => toggleReportInclude(item)} />
                            <span className="text-xs text-white">{item}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <button onClick={generateReport} disabled={generating || reportFrameworks.length === 0}
                      className="w-full py-2.5 text-sm font-medium text-white rounded-xl disabled:opacity-50 hover:opacity-90 flex items-center justify-center gap-2"
                      style={{ backgroundColor: accentColor }}>
                      {generating ? (
                        <>
                          <span className="w-4 h-4 border border-white/40 border-t-white rounded-full animate-spin" />
                          Generating report…
                        </>
                      ) : 'Generate Report'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* ── APPROVALS ── */}
      {activeTab === 'approvals' && (
        <div>
          {adminToast && (
            <div className={`fixed top-4 right-4 z-50 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg ${adminToast.decision === 'approved' ? 'bg-emerald-600' : 'bg-red-600'}`}>
              {adminToast.decision === 'approved' ? '✓ Approved:' : '✕ Rejected:'} {adminToast.action}
            </div>
          )}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Agent Action Approvals</h2>
              <p className="text-xs text-slate-400 mt-1">Platform-level review of agent actions that exceeded confidence or risk thresholds</p>
            </div>
            <Badge label={adminPending.length + ' pending'} color="amber" />
          </div>
          {adminPending.length === 0 ? (
            <div className="text-center py-12 bg-slate-900 border border-slate-800 rounded-xl">
              <div className="text-3xl mb-2">✓</div>
              <p className="text-white font-semibold">All clear</p>
              <p className="text-slate-400 text-sm mt-1">No agent actions are awaiting review.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {adminPending.map((item) => (
                <div key={item.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-white">{item.action}</span>
                        <Badge label={item.risk + ' risk'} color={item.risk === 'high' ? 'red' : item.risk === 'medium' ? 'yellow' : 'green'} />
                      </div>
                      <div className="text-xs text-slate-400">{item.agent} · requested by {item.tenant} · {item.requestedAt}</div>
                    </div>
                    <div className="text-right ml-3">
                      <div className="text-sm font-bold text-emerald-400">{item.confidence}%</div>
                      <div className="text-xs text-slate-500">confidence</div>
                    </div>
                  </div>
                  <div className="flex gap-3 mt-3">
                    <button onClick={() => handleAdminDecision(item, 'approved')} disabled={adminDecidingId === item.id}
                      className="flex-1 py-2 text-sm font-medium text-white rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-all">
                      {adminDecidingId === item.id ? 'Working...' : '✓ Approve'}
                    </button>
                    <button onClick={() => handleAdminDecision(item, 'rejected')} disabled={adminDecidingId === item.id}
                      className="flex-1 py-2 text-sm font-medium text-white rounded-xl bg-red-600/50 hover:bg-red-600/70 disabled:opacity-50 transition-all">
                      {adminDecidingId === item.id ? 'Working...' : '✕ Reject'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {adminDecisionLog.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-slate-300 mb-3">Recent decisions</h2>
              <div className="space-y-2">
                {adminDecisionLog.map((d, idx) => (
                  <div key={d.id + '-' + idx} className="flex items-center justify-between bg-slate-900/60 border border-slate-800 rounded-lg px-4 py-2.5">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={'text-xs font-semibold px-2 py-0.5 rounded-full ' + (d.decision === 'approved' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400')}>
                        {d.decision === 'approved' ? 'Approved' : 'Rejected'}
                      </span>
                      <span className="text-sm text-white truncate">{d.action}</span>
                      <span className="text-xs text-slate-500 truncate">{d.tenant}</span>
                    </div>
                    <div className="text-xs text-slate-500 whitespace-nowrap ml-3">{d.deciderName} · {d.decidedAtLabel}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── API KEYS ── */}
      {activeTab === 'api_keys' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">API Keys</h2>
              <p className="text-xs text-slate-400 mt-1">API keys allow external systems and scripts to authenticate with DreamTeam AI.</p>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-slate-400">Show revoked</span>
                <button onClick={() => setShowRevoked(!showRevoked)}
                  className={`relative w-8 h-4 rounded-full transition-colors ${showRevoked ? 'bg-indigo-500' : 'bg-slate-600'}`}>
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${showRevoked ? 'left-4' : 'left-0.5'}`} />
                </button>
              </label>
              <button onClick={() => setShowCreateKey(true)} className="text-xs px-3 py-1.5 text-white rounded-lg" style={{ backgroundColor: accentColor }}>
                + Create API Key
              </button>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Name', 'Key', 'Permissions', 'Created', 'Last Used', 'Actions'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {apiKeys.filter((k) => showRevoked || k.status === 'active').map((k) => (
                  <tr key={k.id} className={`hover:bg-slate-800/30 transition-all ${k.status === 'revoked' ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-white">{k.name}</div>
                      {k.status === 'revoked' && <div className="text-xs text-red-400">Revoked</div>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-300">{k.keyPrefix}••••••••••••{k.keySuffix}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {k.permissions.slice(0, 3).map((p) => (
                          <span key={p} className="text-xs bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded">{p}</span>
                        ))}
                        {k.permissions.length > 3 && <span className="text-xs text-slate-500">+{k.permissions.length - 3}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{new Date(k.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-slate-500">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never'}</div>
                      <div className="text-xs text-slate-600">{getUsage(k.id)} times this month</div>
                    </td>
                    <td className="px-4 py-3">
                      {k.status === 'active' && (
                        <button onClick={() => setRevokeConfirm(k.id)} className="text-xs text-red-400 hover:text-red-300">Revoke</button>
                      )}
                    </td>
                  </tr>
                ))}
                {apiKeys.filter((k) => showRevoked || k.status === 'active').length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-slate-500">No API keys yet. Create one to get started.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {revokeConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-96">
                <h3 className="text-sm font-semibold text-white mb-2">Revoke this key?</h3>
                <p className="text-xs text-slate-400 mb-4">Any integrations using it will stop working immediately.</p>
                <div className="flex gap-3">
                  <button onClick={() => revokeKey(revokeConfirm)} className="flex-1 py-2 text-sm text-white rounded-xl bg-red-600 hover:bg-red-500">Revoke</button>
                  <button onClick={() => setRevokeConfirm(null)} className="flex-1 py-2 text-sm text-slate-300 rounded-xl bg-slate-800 hover:bg-slate-700">Cancel</button>
                </div>
              </div>
            </div>
          )}

          {showCreateKey && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-[540px] max-h-[80vh] overflow-auto">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-white">Create API Key</h3>
                  <button className="text-slate-400 hover:text-white" onClick={() => setShowCreateKey(false)}>✕</button>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">Key name</label>
                    <input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="e.g. CI/CD Pipeline"
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-2 block">Permissions</label>
                    {PERMISSION_GROUPS.map((g) => (
                      <div key={g.label} className="mb-3">
                        <p className="text-xs text-slate-500 mb-1">{g.label}</p>
                        <div className="space-y-1">
                          {g.perms.map((p) => (
                            <label key={p} className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={newKeyPerms.includes(p)}
                                onChange={() => toggleArr(newKeyPerms, p, setNewKeyPerms)} className="accent-indigo-500" />
                              <span className="text-xs text-white font-mono">{p}</span>
                              {p === 'admin:full' && <span className="text-xs text-amber-400">Full admin access — use with caution</span>}
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">Expiry</label>
                    <select value={newKeyExpiry} onChange={(e) => setNewKeyExpiry(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                      <option value="never">Never</option>
                      <option value="30d">30 days</option>
                      <option value="90d">90 days</option>
                      <option value="1y">1 year</option>
                      <option value="custom">Custom date</option>
                    </select>
                    {newKeyExpiry === 'custom' && (
                      <input type="date" value={newKeyCustomDate} onChange={(e) => setNewKeyCustomDate(e.target.value)}
                        className="mt-2 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                    )}
                  </div>
                  <button onClick={generateApiKey} className="w-full py-2 text-sm font-medium text-white rounded-xl" style={{ backgroundColor: accentColor }}>
                    Generate Key
                  </button>
                </div>
              </div>
            </div>
          )}

          {generatedKey && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-[480px]">
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4">
                  <p className="text-xs text-amber-300 font-medium">Copy this key now — it won't be shown again.</p>
                </div>
                <div className="bg-slate-800 rounded-lg p-3 mb-4 font-mono text-sm text-white break-all">{generatedKey}</div>
                <button onClick={() => { navigator.clipboard.writeText(generatedKey); showToast('API key copied to clipboard'); }}
                  className="w-full py-2.5 text-sm font-medium text-white rounded-xl mb-3" style={{ backgroundColor: accentColor }}>
                  Copy Key
                </button>
                <button onClick={() => setGeneratedKey(null)} className="w-full py-2 text-sm text-slate-400 hover:text-white">Done</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── SSO ── */}
      {activeTab === 'sso' && (
        <div className="space-y-6">
          <div className={`rounded-xl p-4 border text-sm ${ssoConfig ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-300'}`}>
            {ssoConfig
              ? `SSO active — ${ssoConfig.protocol === 'saml' ? 'SAML 2.0' : 'OIDC / OAuth 2.0'} configured`
              : 'SSO not configured — team members log in with email/password.'}
          </div>

          <div>
            <h2 className="text-sm font-semibold text-white mb-3">Select Protocol</h2>
            <div className="grid grid-cols-2 gap-4">
              {(['saml', 'oidc'] as const).map((p) => (
                <button key={p} onClick={() => setSsoProtocol(p)}
                  className={`px-4 py-4 rounded-xl border text-left transition-all ${ssoProtocol === p ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 bg-slate-900 hover:border-slate-600'}`}>
                  <div className="text-sm font-semibold text-white">{p === 'saml' ? 'SAML 2.0' : 'OIDC / OAuth 2.0'}</div>
                  <div className="text-xs text-slate-400 mt-1">{p === 'saml' ? 'Most enterprise IdPs — Okta, Azure AD, OneLogin' : 'Okta, Google Workspace, Azure AD, Auth0'}</div>
                </button>
              ))}
            </div>
          </div>

          {ssoProtocol === 'saml' && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-white">SAML 2.0 Configuration</h3>
              {([['IdP Entity ID', 'entityId', 'https://your-idp.com/saml/metadata'], ['IdP SSO URL', 'ssoUrl', 'https://your-idp.com/saml/sso']] as [string, keyof typeof samlForm, string][]).map(([lbl, key, ph]) => (
                <div key={key}>
                  <label className="text-xs text-slate-400 mb-1 block">{lbl}</label>
                  <input value={samlForm[key]} onChange={(e) => setSamlForm({ ...samlForm, [key]: e.target.value })} placeholder={ph}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500" />
                </div>
              ))}
              <div>
                <label className="text-xs text-slate-400 mb-1 block">IdP Certificate (PEM)</label>
                <textarea value={samlForm.certificate} onChange={(e) => setSamlForm({ ...samlForm, certificate: e.target.value })}
                  placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'}
                  rows={4} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 font-mono" />
              </div>
              <div>
                <h4 className="text-xs font-medium text-slate-300 mb-2">Attribute Mapping</h4>
                {([['Email attribute', 'emailAttr'], ['First name attribute', 'firstNameAttr'], ['Last name attribute', 'lastNameAttr'], ['Role attribute (optional)', 'roleAttr']] as [string, keyof typeof samlForm][]).map(([lbl, key]) => (
                  <div key={key} className="mb-2">
                    <label className="text-xs text-slate-500 mb-1 block">{lbl}</label>
                    <input value={samlForm[key]} onChange={(e) => setSamlForm({ ...samlForm, [key]: e.target.value })}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono" />
                  </div>
                ))}
              </div>
              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 space-y-2">
                <h4 className="text-xs font-medium text-slate-300 mb-2">SP Metadata (read-only)</h4>
                {([['Entity ID', `https://app.dreamteam.ai/saml/metadata/${tenantId}`], ['ACS URL', `https://app.dreamteam.ai/saml/acs/${tenantId}`]] as [string, string][]).map(([lbl, val]) => (
                  <div key={lbl} className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-500 flex-shrink-0">{lbl}</span>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-mono text-slate-300 truncate">{val}</span>
                      <button className="text-xs text-indigo-400 hover:text-indigo-300 flex-shrink-0" onClick={() => { navigator.clipboard.writeText(val); showToast('Copied'); }}>Copy</button>
                    </div>
                  </div>
                ))}
                <button onClick={downloadSpMetadata} className="text-xs text-indigo-400 hover:text-indigo-300 mt-1">Download SP Metadata XML</button>
              </div>
            </div>
          )}

          {ssoProtocol === 'oidc' && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-white">OIDC / OAuth 2.0 Configuration</h3>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Provider Preset</label>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(OIDC_PRESETS).map((p) => (
                    <button key={p} onClick={() => setOidcForm({ ...oidcForm, preset: p, discoveryUrl: OIDC_PRESETS[p] })}
                      className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${oidcForm.preset === p ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300' : 'border-slate-700 text-slate-400 hover:text-white'}`}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              {([['Client ID', 'clientId', 'text'], ['Client Secret', 'clientSecret', 'password'], ['Discovery URL', 'discoveryUrl', 'text']] as [string, keyof typeof oidcForm, string][]).map(([lbl, key, type]) => (
                <div key={key}>
                  <label className="text-xs text-slate-400 mb-1 block">{lbl}</label>
                  <input type={type} value={oidcForm[key] as string} onChange={(e) => setOidcForm({ ...oidcForm, [key]: e.target.value })}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                </div>
              ))}
              <div>
                <label className="text-xs text-slate-400 mb-2 block">Scopes</label>
                {['openid', 'email', 'profile', 'groups'].map((s) => (
                  <label key={s} className="flex items-center gap-2 mb-1 cursor-pointer">
                    <input type="checkbox" checked={oidcForm.scopes.includes(s)}
                      onChange={() => toggleArr(oidcForm.scopes, s, (v) => setOidcForm({ ...oidcForm, scopes: v }))} className="accent-indigo-500" />
                    <span className="text-xs font-mono text-white">{s}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={testSSO} disabled={ssoTesting}
              className="px-4 py-2 text-sm text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-xl border border-slate-700 disabled:opacity-50 transition-all">
              {ssoTesting ? 'Testing...' : 'Test SSO Connection'}
            </button>
            <button onClick={saveSSO} className="px-4 py-2 text-sm text-white rounded-xl" style={{ backgroundColor: accentColor }}>
              Save & Enable SSO
            </button>
          </div>
          {ssoTestResult === 'success' && (
            <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3">
              ✓ Connection successful — received test assertion from IdP
            </div>
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-white">JIT Provisioning</h3>
            <div className="flex items-center justify-between">
              <span className="text-sm text-white">Auto-create accounts for new SSO users</span>
              <button onClick={() => setJitEnabled(!jitEnabled)}
                className={`relative w-10 h-5 rounded-full transition-colors ${jitEnabled ? 'bg-emerald-500' : 'bg-slate-600'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${jitEnabled ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
            {jitEnabled && (
              <>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Default role for new users</label>
                  <select value={jitRole} onChange={(e) => setJitRole(e.target.value)}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                    <option value="tenant_user">tenant_user</option>
                    <option value="tenant_manager">tenant_manager</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Allowed email domains (comma-separated)</label>
                  <input value={allowedDomains} onChange={(e) => setAllowedDomains(e.target.value)} placeholder="acme.com, acmecorp.io"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500" />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── FEATURE FLAGS ── */}
      {activeTab === 'features' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400 max-w-xl">Feature flags let you control which capabilities are available in your workspace. Changes take effect immediately.</p>
            <button onClick={resetFeatures} className="text-xs px-3 py-1.5 text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 flex-shrink-0">Reset to defaults</button>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Feature', 'Enabled', 'Min Role'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {PLATFORM_FEATURES.map((f) => (
                  <tr key={f.id} className="hover:bg-slate-800/20 transition-all">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-white">{f.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{f.desc}</div>
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => toggleFeature(f.id)}
                        className={`relative w-10 h-5 rounded-full transition-colors ${features[f.id] ? 'bg-emerald-500' : 'bg-slate-600'}`}>
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${features[f.id] ? 'left-5' : 'left-0.5'}`} />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${f.minRole === 'tenant_owner' ? 'bg-red-500/15 text-red-400' : f.minRole === 'tenant_admin' ? 'bg-amber-500/15 text-amber-400' : 'bg-blue-500/15 text-blue-400'}`}>
                        {f.minRole.replace('tenant_', '')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── SESSIONS ── */}
      {activeTab === 'sessions' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Active Sessions</h2>
            <button onClick={() => setRevokeAllConfirm(true)} className="text-xs px-3 py-1.5 text-red-400 hover:text-red-300 bg-slate-800 rounded-lg border border-slate-700">
              Revoke all other sessions
            </button>
          </div>

          {revokeAllConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-96">
                <h3 className="text-sm font-semibold text-white mb-2">Revoke all other sessions?</h3>
                <p className="text-xs text-slate-400 mb-4">All users except you will be signed out immediately.</p>
                <div className="flex gap-3">
                  <button onClick={revokeAllSessions} className="flex-1 py-2 text-sm text-white rounded-xl bg-red-600 hover:bg-red-500">Revoke All</button>
                  <button onClick={() => setRevokeAllConfirm(false)} className="flex-1 py-2 text-sm text-slate-300 rounded-xl bg-slate-800 hover:bg-slate-700">Cancel</button>
                </div>
              </div>
            </div>
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  {['User', 'Device / Browser', 'IP Address', 'Location', 'Started', 'Last Activity', 'Actions'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-800/30 transition-all">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-white">{s.userName}</div>
                      <div className="text-xs text-slate-500">{s.userEmail}</div>
                      {s.isCurrent && <span className="text-xs text-indigo-400">(This session)</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">{s.device}</td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-400">{s.ipAddress}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{s.location}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{s.startedAt}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{s.lastActivityAt}</td>
                    <td className="px-4 py-3">
                      {!s.isCurrent && (
                        <button onClick={() => revokeSession(s.id)} className="text-xs text-red-400 hover:text-red-300">Revoke</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-4">Login Activity — Last 7 Days</h3>
            <div className="flex items-end gap-2 h-36">
              {loginData.map((v, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <span className="text-xs text-slate-500">{v}</span>
                  <div className="w-full rounded-t-md bg-indigo-500/70" style={{ height: `${(v / loginMax) * 80}px` }} />
                  <span className="text-xs text-slate-600">{loginDays[i]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-white">Session Policy</h3>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Session timeout</label>
              <select value={sessionTimeout} onChange={(e) => setSessionTimeout(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                <option value="1h">1 hour</option>
                <option value="4h">4 hours</option>
                <option value="8h">8 hours</option>
                <option value="24h">24 hours</option>
                <option value="7d">7 days</option>
                <option value="never">Never</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-white">Require re-authentication for sensitive actions</div>
                <div className="text-xs text-slate-500">Approve actions, export data, revoke access</div>
              </div>
              <button onClick={() => setRequireReauth(!requireReauth)}
                className={`relative w-10 h-5 rounded-full transition-colors ${requireReauth ? 'bg-emerald-500' : 'bg-slate-600'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${requireReauth ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Maximum concurrent sessions per user</label>
              <input type="number" min={1} max={10} value={maxSessions} onChange={(e) => setMaxSessions(Number(e.target.value))}
                className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
            </div>
            <button onClick={saveSessionPolicy} className="text-xs px-4 py-2 text-white rounded-lg" style={{ backgroundColor: accentColor }}>
              Save Policy
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SecurityPage;
