import React, { useState, useEffect } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { Badge, PageTabs, ADMIN_TABS } from '../../components';
import { loadConnectors, saveConnectors, testConnector } from '../../lib/api';
import type { ConnectorConfig } from '../../lib/api';
import { useDigitalEmployees } from '../../lib/useDigitalEmployees';

type ConnectorType =
  | 'salesforce' | 'hubspot' | 'zendesk'
  | 'netsuite' | 'quickbooks' | 'xero'
  | 'zuora' | 'stripe' | 'chargebee'
  | 'rest_api' | 'graphql' | 'webhook'
  | 'postgresql' | 'mysql' | 'mongodb';

const CONNECTOR_GROUPS: { label: string; types: { type: ConnectorType; name: string; avatar: string; avatarBg: string }[] }[] = [
  {
    label: 'CRM & Support',
    types: [
      { type: 'salesforce', name: 'Salesforce', avatar: 'SF', avatarBg: 'bg-blue-500' },
      { type: 'hubspot', name: 'HubSpot', avatar: 'HS', avatarBg: 'bg-orange-500' },
      { type: 'zendesk', name: 'Zendesk', avatar: 'ZD', avatarBg: 'bg-green-500' },
    ],
  },
  {
    label: 'Finance & Billing',
    types: [
      { type: 'netsuite', name: 'NetSuite', avatar: 'NS', avatarBg: 'bg-sky-600' },
      { type: 'quickbooks', name: 'QuickBooks', avatar: 'QB', avatarBg: 'bg-emerald-600' },
      { type: 'xero', name: 'Xero', avatar: 'XR', avatarBg: 'bg-cyan-500' },
      { type: 'zuora', name: 'Zuora', avatar: 'ZU', avatarBg: 'bg-violet-600' },
      { type: 'stripe', name: 'Stripe', avatar: 'ST', avatarBg: 'bg-purple-600' },
      { type: 'chargebee', name: 'CB', avatar: 'CB', avatarBg: 'bg-pink-600' },
    ],
  },
  {
    label: 'Generic APIs',
    types: [
      { type: 'rest_api', name: 'REST API', avatar: 'RE', avatarBg: 'bg-slate-600' },
      { type: 'graphql', name: 'GraphQL', avatar: 'GQ', avatarBg: 'bg-rose-600' },
      { type: 'webhook', name: 'Webhook', avatar: 'WH', avatarBg: 'bg-amber-600' },
    ],
  },
  {
    label: 'Database',
    types: [
      { type: 'postgresql', name: 'PostgreSQL', avatar: 'PG', avatarBg: 'bg-blue-700' },
      { type: 'mysql', name: 'MySQL', avatar: 'MY', avatarBg: 'bg-orange-600' },
      { type: 'mongodb', name: 'MongoDB', avatar: 'MG', avatarBg: 'bg-green-700' },
    ],
  },
];

function connectorMeta(type: string) {
  for (const g of CONNECTOR_GROUPS) for (const t of g.types) if (t.type === type) return t;
  return { name: type, avatar: type.slice(0,2).toUpperCase(), avatarBg: 'bg-slate-600' };
}

function ConfigFields({ type, config, setConfig }: { type: ConnectorType; config: Record<string, string>; setConfig: (c: Record<string, string>) => void }) {
  const set = (k: string, v: string) => setConfig({ ...config, [k]: v });
  const inp = (label: string, key: string, opts?: { type?: string; placeholder?: string }) => (
    <div key={key}>
      <label className="text-xs text-slate-400 block mb-1">{label}</label>
      <input
        type={opts?.type || 'text'}
        placeholder={opts?.placeholder}
        value={config[key] || ''}
        onChange={e => set(key, e.target.value)}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
      />
    </div>
  );

  if (type === 'salesforce') return <div className="space-y-3">
    {inp('Instance URL', 'instance_url', { placeholder: 'https://yourorg.salesforce.com' })}
    {inp('Client ID', 'client_id')}
    {inp('Client Secret', 'client_secret', { type: 'password' })}
    <p className="text-xs text-slate-500">In production, this will redirect to Salesforce OAuth.</p>
  </div>;

  if (type === 'netsuite') return <div className="space-y-3">
    {inp('Account ID', 'account_id')}
    {inp('Consumer Key', 'consumer_key')}
    {inp('Consumer Secret', 'consumer_secret', { type: 'password' })}
    {inp('Token ID', 'token_id')}
    {inp('Token Secret', 'token_secret', { type: 'password' })}
  </div>;

  if (type === 'zuora') return <div className="space-y-3">
    {inp('Base URL', 'base_url', { placeholder: 'https://rest.zuora.com' })}
    {inp('Client ID', 'client_id')}
    {inp('Client Secret', 'client_secret', { type: 'password' })}
    {inp('Entity ID', 'entity_id')}
  </div>;

  if (type === 'stripe') return <div className="space-y-3">
    {inp('API Key', 'api_key', { placeholder: 'sk_live_...', type: 'password' })}
    {inp('Webhook Secret', 'webhook_secret', { type: 'password' })}
  </div>;

  if (type === 'rest_api' || type === 'graphql') return <div className="space-y-3">
    {inp('Base URL', 'base_url', { placeholder: 'https://api.example.com' })}
    <div>
      <label className="text-xs text-slate-400 block mb-1">Auth Type</label>
      <select value={config.auth_type || 'Bearer'} onChange={e => set('auth_type', e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
        <option>Bearer</option><option>API Key</option><option>Basic</option>
      </select>
    </div>
    {inp('Auth Value', 'auth_value', { type: 'password', placeholder: 'Token or key' })}
    {inp('Headers JSON (optional)', 'headers_json', { placeholder: '{"X-Custom": "value"}' })}
  </div>;

  if (type === 'postgresql' || type === 'mysql') return <div className="space-y-3">
    <div className="grid grid-cols-2 gap-3">
      {inp('Host', 'host', { placeholder: 'localhost' })}
      {inp('Port', 'port', { placeholder: type === 'postgresql' ? '5432' : '3306' })}
    </div>
    {inp('Database', 'database')}
    {inp('Username', 'username')}
    {inp('Password', 'password', { type: 'password' })}
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={config.ssl === 'true'} onChange={e => set('ssl', e.target.checked ? 'true' : 'false')} className="accent-indigo-500" />
      <span className="text-sm text-slate-300">SSL enabled</span>
    </label>
  </div>;

  // Default: Base URL + API Key
  return <div className="space-y-3">
    {inp('Base URL', 'base_url', { placeholder: 'https://api.example.com' })}
    {inp('API Key', 'api_key', { type: 'password' })}
  </div>;
}

const DataConnectorsPage = ({
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
  const tenantId = (tenant as any)?.id || (user as any)?.tenantId || 'demo';
  const { employees, update } = useDigitalEmployees(tenantId === 'demo' ? undefined : tenantId, []);

  const [connectors, setConnectors] = useState<ConnectorConfig[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addStep, setAddStep] = useState<1 | 2>(1);
  const [selectedType, setSelectedType] = useState<ConnectorType | null>(null);
  const [addName, setAddName] = useState('');
  const [addConfig, setAddConfig] = useState<Record<string, string>>({});
  const [editConnector, setEditConnector] = useState<ConnectorConfig | null>(null);
  const [editConfig, setEditConfig] = useState<Record<string, string>>({});
  const [bindConnId, setBindConnId] = useState('');
  const [bindDeId, setBindDeId] = useState('');
  const [bindSaved, setBindSaved] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    setConnectors(loadConnectors(tenantId));
  }, [tenantId]);

  const persist = (updated: ConnectorConfig[]) => {
    setConnectors(updated);
    saveConnectors(tenantId, updated);
  };

  const handleTest = async (conn: ConnectorConfig) => {
    persist(connectors.map(c => c.id === conn.id ? { ...c, status: 'testing' } : c));
    const res = await testConnector(conn);
    persist(connectors.map(c => c.id === conn.id ? {
      ...c,
      status: res.ok ? 'connected' : 'error',
      lastSync: res.ok ? new Date().toISOString() : c.lastSync,
      recordCount: res.recordCount ?? c.recordCount,
      errorMessage: res.error,
    } : c));
  };

  const handleAdd = () => {
    if (!selectedType || !addName.trim()) return;
    const conn: ConnectorConfig = {
      id: crypto.randomUUID(),
      tenantId,
      name: addName.trim(),
      type: selectedType,
      status: 'disconnected',
      config: addConfig,
      lastSync: null,
      recordCount: 0,
      createdAt: new Date().toISOString(),
    };
    persist([...connectors, conn]);
    setShowAdd(false);
    setAddStep(1);
    setSelectedType(null);
    setAddName('');
    setAddConfig({});
    setToast(`${conn.name} added — click "Test Connection" to verify`);
    setTimeout(() => setToast(''), 4000);
  };

  const handleEditSave = () => {
    if (!editConnector) return;
    persist(connectors.map(c => c.id === editConnector.id ? { ...c, config: editConfig } : c));
    setEditConnector(null);
    setToast('Configuration saved');
    setTimeout(() => setToast(''), 3000);
  };

  const handleBind = async () => {
    if (!bindConnId || !bindDeId) return;
    const de = employees.find(e => e.id === bindDeId);
    if (!de) return;
    const existing = de.knowledgeSources || [];
    if (!existing.includes(bindConnId)) {
      await update(bindDeId, { knowledgeSources: [...existing, bindConnId] });
    }
    setBindSaved(true);
    setTimeout(() => setBindSaved(false), 3000);
  };

  const statusDot = (s: string) =>
    s === 'connected' ? 'bg-emerald-400' : s === 'testing' ? 'bg-amber-400 animate-pulse' : s === 'error' ? 'bg-rose-400' : 'bg-slate-600';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={ADMIN_TABS} page={page} setPage={setPage} accentColor={accentColor} />

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Data Connectors</h1>
          <p className="text-slate-400 text-sm mt-1">Connect external systems — Digital Employees can query and act on live data</p>
        </div>
        <button onClick={() => { setShowAdd(true); setAddStep(1); setSelectedType(null); setAddName(''); setAddConfig({}); }}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium" style={{ backgroundColor: accentColor }}>
          + Add Connector
        </button>
      </div>

      {toast && <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">{toast}</div>}

      {/* Connected connectors */}
      {connectors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-10 text-center mb-6">
          <p className="text-slate-500 text-sm">No connectors yet. Add your first one to link a data source.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          {connectors.map(conn => {
            const meta = connectorMeta(conn.type);
            return (
              <div key={conn.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all">
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-9 h-9 rounded-lg ${meta.avatarBg} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>{meta.avatar}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white truncate">{conn.name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <div className={`w-1.5 h-1.5 rounded-full ${statusDot(conn.status)}`} />
                      <span className="text-xs text-slate-500 capitalize">{conn.status}</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5 text-xs mb-4">
                  <div className="flex justify-between text-slate-400"><span>Type</span><span className="text-slate-300 capitalize">{conn.type.replace(/_/g, ' ')}</span></div>
                  <div className="flex justify-between text-slate-400"><span>Records</span><span className="text-slate-300">{conn.recordCount > 0 ? conn.recordCount.toLocaleString() : '—'}</span></div>
                  <div className="flex justify-between text-slate-400"><span>Last sync</span><span className="text-slate-300">{conn.lastSync ? new Date(conn.lastSync).toLocaleTimeString() : '—'}</span></div>
                  {conn.errorMessage && <div className="text-rose-400 text-[10px] truncate">{conn.errorMessage}</div>}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleTest(conn)} disabled={conn.status === 'testing'}
                    className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all disabled:opacity-50">
                    {conn.status === 'testing' ? 'Testing…' : 'Test Connection'}
                  </button>
                  <button onClick={() => { setEditConnector(conn); setEditConfig({ ...conn.config }); }}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all">
                    Configure
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Use in DE binding */}
      {connectors.length > 0 && employees.length > 0 && (
        <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-1">Connect your data to a Digital Employee</h3>
          <p className="text-xs text-slate-400 mb-4">Give a DE access to a connector — it will be able to search records, look up customer data, or write back to the system.</p>
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Connector</label>
              <select value={bindConnId} onChange={e => setBindConnId(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none min-w-[180px]">
                <option value="">Select connector…</option>
                {connectors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Digital Employee</label>
              <select value={bindDeId} onChange={e => setBindDeId(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none min-w-[180px]">
                <option value="">Select DE…</option>
                {employees.map(de => <option key={de.id} value={de.id}>{de.name}</option>)}
              </select>
            </div>
            {bindConnId && bindDeId && (
              <div className="text-xs text-slate-500 max-w-xs">
                This DE will get: <span className="text-slate-300">read-only: search records, look up customer data</span>; if write connectors is enabled: <span className="text-slate-300">create/update records</span>
              </div>
            )}
            <button onClick={handleBind} disabled={!bindConnId || !bindDeId}
              className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-50" style={{ backgroundColor: accentColor }}>
              Save
            </button>
            {bindSaved && <span className="text-xs text-emerald-400">Saved</span>}
          </div>
        </div>
      )}

      {/* Add Connector Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold">{addStep === 1 ? 'Choose connector type' : `Configure ${selectedType ? connectorMeta(selectedType).name : ''}`}</h3>
              <button onClick={() => setShowAdd(false)} className="text-slate-500 hover:text-slate-200 text-xl">×</button>
            </div>

            {addStep === 1 && (
              <div className="space-y-4">
                {CONNECTOR_GROUPS.map(g => (
                  <div key={g.label}>
                    <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">{g.label}</p>
                    <div className="grid grid-cols-3 gap-2">
                      {g.types.map(t => (
                        <button key={t.type} onClick={() => { setSelectedType(t.type); setAddName(t.name); setAddStep(2); }}
                          className="flex items-center gap-2 p-3 rounded-xl border border-slate-700 hover:border-indigo-500 bg-slate-800 transition-all text-left">
                          <div className={`w-7 h-7 rounded-lg ${t.avatarBg} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>{t.avatar}</div>
                          <span className="text-xs text-slate-300 truncate">{t.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {addStep === 2 && selectedType && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Connection Name</label>
                  <input value={addName} onChange={e => setAddName(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" placeholder={`e.g. "TCP ${connectorMeta(selectedType).name}"`} />
                </div>
                <ConfigFields type={selectedType} config={addConfig} setConfig={setAddConfig} />
                <div className="rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2 text-xs text-slate-500">
                  Credentials stored locally in your browser — never sent to our servers
                </div>
                <div className="flex gap-2 pt-1">
                  <button onClick={() => setAddStep(1)} className="px-4 py-2 text-sm rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500">Back</button>
                  <button onClick={handleAdd} disabled={!addName.trim()} className="flex-1 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-50" style={{ backgroundColor: accentColor }}>Add Connector</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Edit/Configure Modal */}
      {editConnector && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold">Configure: {editConnector.name}</h3>
              <button onClick={() => setEditConnector(null)} className="text-slate-500 hover:text-slate-200 text-xl">×</button>
            </div>
            <ConfigFields type={editConnector.type as ConnectorType} config={editConfig} setConfig={setEditConfig} />
            <div className="rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2 text-xs text-slate-500 mt-3">
              Credentials stored locally in your browser — never sent to our servers
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={handleEditSave} className="flex-1 py-2 text-sm font-medium rounded-lg text-white" style={{ backgroundColor: accentColor }}>Save</button>
              <button onClick={() => { persist(connectors.filter(c => c.id !== editConnector.id)); setEditConnector(null); }}
                className="px-4 py-2 text-sm rounded-lg border border-red-800 text-red-400 hover:border-red-600">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DataConnectorsPage;
