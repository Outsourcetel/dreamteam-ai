import React, { useState, useEffect, useMemo } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { PageTabs, ADMIN_TABS } from '../../components';
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
  return { name: type, avatar: type.slice(0, 2).toUpperCase(), avatarBg: 'bg-slate-600' };
}

// ── Schema data ────────────────────────────────────────────────

const SCHEMA_OBJECTS: Record<string, { name: string; fields: string[] }[]> = {
  salesforce: [
    { name: 'Account', fields: ['id', 'name', 'industry', 'annual_revenue', 'created_at', 'updated_at', 'owner_id'] },
    { name: 'Contact', fields: ['id', 'first_name', 'last_name', 'email', 'phone', 'account_id', 'created_at'] },
    { name: 'Opportunity', fields: ['id', 'name', 'stage', 'amount', 'close_date', 'account_id', 'owner_id'] },
    { name: 'Case', fields: ['id', 'subject', 'status', 'priority', 'account_id', 'contact_id', 'created_at'] },
    { name: 'Lead', fields: ['id', 'first_name', 'last_name', 'email', 'company', 'status', 'source'] },
  ],
  netsuite: [
    { name: 'Customer', fields: ['id', 'name', 'email', 'balance', 'currency', 'created_at', 'updated_at'] },
    { name: 'Invoice', fields: ['id', 'tranid', 'entity', 'amount', 'status', 'due_date', 'created_at'] },
    { name: 'JournalEntry', fields: ['id', 'tranid', 'memo', 'lines', 'period', 'created_by', 'created_at'] },
    { name: 'VendorBill', fields: ['id', 'vendor', 'amount', 'due_date', 'status', 'account', 'created_at'] },
    { name: 'PurchaseOrder', fields: ['id', 'vendor', 'total', 'status', 'ship_to', 'created_by', 'created_at'] },
  ],
  zuora: [
    { name: 'Account', fields: ['id', 'name', 'currency', 'status', 'payment_term', 'balance', 'created_at'] },
    { name: 'Subscription', fields: ['id', 'name', 'account_id', 'status', 'start_date', 'end_date', 'mrr'] },
    { name: 'Invoice', fields: ['id', 'invoice_number', 'account_id', 'amount', 'balance', 'due_date', 'status'] },
    { name: 'Payment', fields: ['id', 'account_id', 'amount', 'status', 'type', 'gateway_id', 'created_at'] },
    { name: 'RefundInvoicePayment', fields: ['id', 'payment_id', 'amount', 'refund_date', 'reason', 'status'] },
  ],
  stripe: [
    { name: 'Customer', fields: ['id', 'email', 'name', 'currency', 'balance', 'created', 'metadata'] },
    { name: 'Invoice', fields: ['id', 'customer', 'amount_due', 'amount_paid', 'status', 'due_date', 'created'] },
    { name: 'PaymentIntent', fields: ['id', 'amount', 'currency', 'status', 'customer', 'payment_method', 'created'] },
    { name: 'Subscription', fields: ['id', 'customer', 'status', 'current_period_start', 'current_period_end', 'plan'] },
    { name: 'Charge', fields: ['id', 'amount', 'currency', 'status', 'customer', 'description', 'created'] },
  ],
  hubspot: [
    { name: 'Contact', fields: ['id', 'email', 'firstname', 'lastname', 'phone', 'company', 'created_at'] },
    { name: 'Company', fields: ['id', 'name', 'domain', 'industry', 'num_employees', 'city', 'created_at'] },
    { name: 'Deal', fields: ['id', 'dealname', 'amount', 'dealstage', 'closedate', 'pipeline', 'owner_id'] },
    { name: 'Ticket', fields: ['id', 'subject', 'content', 'status', 'priority', 'contact_id', 'created_at'] },
  ],
  zendesk: [
    { name: 'Ticket', fields: ['id', 'subject', 'description', 'status', 'priority', 'requester_id', 'created_at'] },
    { name: 'User', fields: ['id', 'name', 'email', 'role', 'active', 'organization_id', 'created_at'] },
    { name: 'Organization', fields: ['id', 'name', 'domain_names', 'group_id', 'notes', 'created_at'] },
  ],
};

const DEFAULT_SCHEMA_MESSAGE: Record<string, string> = {
  postgresql: 'Connect and test to discover schema',
  mysql: 'Connect and test to discover schema',
  mongodb: 'Connect and test to discover schema',
  rest_api: 'Add endpoint mappings below',
  graphql: 'Add endpoint mappings below',
  webhook: 'Connect and test to discover schema',
};

// ── Log generator ──────────────────────────────────────────────

function generateLogs(conn: ConnectorConfig): string[] {
  const now = new Date('2026-07-02T09:15:23')
  const lines: string[] = []
  const counts = [1247, 1241, 1236, 1229, 1218]
  for (let i = 0; i < 5; i++) {
    const dt = new Date(now.getTime() - i * 15 * 60 * 1000)
    const ts = dt.toISOString().replace('T', ' ').slice(0, 19)
    lines.push(`[${ts}] ✓ Sync completed — ${counts[i].toLocaleString()} records processed`)
    const dt2 = new Date(dt.getTime() - 15000)
    const ts2 = dt2.toISOString().replace('T', ' ').slice(0, 19)
    lines.push(`[${ts2}] ◐ Sync started`)
  }
  return lines
}

// ── ConfigFields ───────────────────────────────────────────────

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

  return <div className="space-y-3">
    {inp('Base URL', 'base_url', { placeholder: 'https://api.example.com' })}
    {inp('API Key', 'api_key', { type: 'password' })}
  </div>;
}

// ── Connector Detail Panel ─────────────────────────────────────

function ConnectorDetailPanel({
  conn,
  tenantId,
  accentColor,
  onClose,
  onSave,
  onTest,
  onDelete,
  employees,
  onUnbind,
}: {
  conn: ConnectorConfig
  tenantId: string
  accentColor: string
  onClose: () => void
  onSave: (config: Record<string, string>, name: string) => void
  onTest: (conn: ConnectorConfig) => void
  onDelete: (id: string) => void
  employees: ReturnType<typeof useDigitalEmployees>['employees']
  onUnbind: (deId: string, connId: string) => void
}) {
  const [tab, setTab] = useState<'overview' | 'schema' | 'de_bindings' | 'logs'>('overview')
  const [editConfig, setEditConfig] = useState<Record<string, string>>({ ...conn.config })
  const [editName, setEditName] = useState(conn.name)
  const [expandedObject, setExpandedObject] = useState<string | null>(null)
  const [restEndpoints, setRestEndpoints] = useState<{ name: string; url: string }[]>([])
  const [newEndpointName, setNewEndpointName] = useState('')
  const [newEndpointUrl, setNewEndpointUrl] = useState('')

  const logs = useMemo(() => generateLogs(conn), [conn.id])
  const schemaObjects = SCHEMA_OBJECTS[conn.type] ?? null
  const schemaMessage = DEFAULT_SCHEMA_MESSAGE[conn.type] ?? null
  const isRestLike = conn.type === 'rest_api' || conn.type === 'graphql'

  const boundDEs = employees.filter(e => (e.knowledgeSources || []).includes(conn.id))

  const meta = connectorMeta(conn.type)

  const statusDot = (s: string) =>
    s === 'connected' ? 'bg-emerald-400' : s === 'testing' ? 'bg-amber-400 animate-pulse' : s === 'error' ? 'bg-rose-400' : 'bg-slate-600'

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-xl bg-slate-950 border-l border-slate-800 flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-800 flex items-center gap-4">
          <div className={`w-10 h-10 rounded-xl ${meta.avatarBg} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}>{meta.avatar}</div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-white truncate">{conn.name}</h2>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className={`w-1.5 h-1.5 rounded-full ${statusDot(conn.status)}`} />
              <span className="text-xs text-slate-500 capitalize">{conn.status}</span>
              <span className="text-slate-700">·</span>
              <span className="text-xs text-slate-500 capitalize">{conn.type.replace(/_/g, ' ')}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 text-xl leading-none flex-shrink-0">×</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-4 pb-0 border-b border-slate-800 overflow-x-auto">
          {(['overview', 'schema', 'de_bindings', 'logs'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${
                tab === t ? 'border-indigo-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
              style={tab === t ? { borderColor: accentColor } : {}}>
              {t === 'de_bindings' ? 'DE Bindings' : t.charAt(0).toUpperCase() + t.slice(1)}
              {t === 'de_bindings' && boundDEs.length > 0 ? ` (${boundDEs.length})` : ''}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">

          {tab === 'overview' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Connection Name</label>
                <input value={editName} onChange={e => setEditName(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-slate-500" />
              </div>
              <ConfigFields type={conn.type as ConnectorType} config={editConfig} setConfig={setEditConfig} />
              <div className="rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2 text-xs text-slate-500">
                Credentials stored locally in your browser — never sent to our servers
              </div>

              {/* Test connection */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-white">Connection Status</span>
                  <button onClick={() => onTest(conn)} disabled={conn.status === 'testing'}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all disabled:opacity-50">
                    {conn.status === 'testing' ? 'Testing…' : 'Test Connection'}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${statusDot(conn.status)}`} />
                  <span className="text-xs text-slate-400 capitalize">{conn.status}</span>
                  {conn.lastSync && <span className="text-xs text-slate-500 ml-auto">Last sync: {new Date(conn.lastSync).toLocaleTimeString()}</span>}
                </div>
                {conn.errorMessage && <p className="text-xs text-rose-400 mt-1">{conn.errorMessage}</p>}
                {conn.recordCount > 0 && (
                  <p className="text-xs text-slate-500 mt-1">{conn.recordCount.toLocaleString()} records indexed</p>
                )}
              </div>

              <button onClick={() => onSave(editConfig, editName)}
                className="w-full py-2 text-sm font-medium rounded-lg text-white" style={{ backgroundColor: accentColor }}>
                Save Changes
              </button>
              <button onClick={() => onDelete(conn.id)}
                className="w-full py-2 text-sm rounded-lg border border-red-800 text-red-400 hover:border-red-600 transition-all">
                Delete Connector
              </button>
            </div>
          )}

          {tab === 'schema' && (
            <div className="space-y-3">
              {schemaObjects ? (
                <>
                  <p className="text-xs text-slate-500 mb-3">Objects available via this connector. Click to expand fields.</p>
                  {schemaObjects.map(obj => (
                    <div key={obj.name} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                      <button
                        onClick={() => setExpandedObject(expandedObject === obj.name ? null : obj.name)}
                        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-800/50 transition-all"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-400">
                            {obj.name.slice(0, 2)}
                          </div>
                          <span className="text-sm font-medium text-white">{obj.name}</span>
                          <span className="text-xs text-slate-500">{obj.fields.length} fields</span>
                        </div>
                        <span className="text-slate-600 text-xs">{expandedObject === obj.name ? '▲' : '▼'}</span>
                      </button>
                      {expandedObject === obj.name && (
                        <div className="px-4 pb-3 border-t border-slate-800">
                          <div className="flex flex-wrap gap-1.5 mt-3">
                            {obj.fields.map(f => (
                              <span key={f} className="text-[10px] px-2 py-0.5 bg-slate-800 text-slate-400 rounded font-mono">{f}</span>
                            ))}
                          </div>
                          <p className="text-[10px] text-slate-600 mt-2">Last synced: {conn.lastSync ? new Date(conn.lastSync).toLocaleString() : 'Never'}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              ) : isRestLike ? (
                <div className="space-y-4">
                  <p className="text-xs text-slate-500">Add endpoint mappings to define what data is available.</p>
                  <div className="space-y-2">
                    {restEndpoints.map((ep, i) => (
                      <div key={i} className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
                        <span className="text-sm text-white flex-1 truncate">{ep.name}</span>
                        <span className="text-xs text-slate-500 truncate max-w-[160px]">{ep.url}</span>
                        <button onClick={() => setRestEndpoints(prev => prev.filter((_, j) => j !== i))} className="text-slate-700 hover:text-red-400 text-sm">×</button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input value={newEndpointName} onChange={e => setNewEndpointName(e.target.value)}
                      placeholder="Endpoint name"
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-slate-500" />
                    <input value={newEndpointUrl} onChange={e => setNewEndpointUrl(e.target.value)}
                      placeholder="/api/path"
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-slate-500" />
                    <button
                      onClick={() => {
                        if (newEndpointName.trim() && newEndpointUrl.trim()) {
                          setRestEndpoints(prev => [...prev, { name: newEndpointName.trim(), url: newEndpointUrl.trim() }])
                          setNewEndpointName('')
                          setNewEndpointUrl('')
                        }
                      }}
                      className="px-3 py-2 text-xs font-medium rounded-lg text-white" style={{ backgroundColor: accentColor }}>+</button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-10 border border-dashed border-slate-800 rounded-xl">
                  <p className="text-slate-500 text-sm">{schemaMessage}</p>
                </div>
              )}
            </div>
          )}

          {tab === 'de_bindings' && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500 mb-3">Digital Employees that have access to this connector.</p>
              {boundDEs.length === 0 && (
                <div className="text-center py-10 border border-dashed border-slate-800 rounded-xl">
                  <p className="text-slate-500 text-sm">No DEs bound yet.</p>
                  <p className="text-slate-600 text-xs mt-1">Use the "Connect your data to a DE" section below to bind.</p>
                </div>
              )}
              {boundDEs.map(de => (
                <div key={de.id} className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center text-indigo-300 text-sm font-bold flex-shrink-0">
                    {de.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white">{de.name}</div>
                    <div className="text-xs text-slate-500">{de.department}</div>
                    {de.capabilities && de.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {de.capabilities.slice(0, 3).map(cap => (
                          <span key={cap} className="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded">{cap}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => onUnbind(de.id, conn.id)}
                    className="px-3 py-1.5 text-xs rounded-lg border border-slate-700 text-slate-400 hover:border-red-700 hover:text-red-400 transition-all flex-shrink-0"
                  >
                    Unbind
                  </button>
                </div>
              ))}
            </div>
          )}

          {tab === 'logs' && (
            <div className="space-y-1.5">
              <p className="text-xs text-slate-500 mb-3">Recent sync activity for this connector.</p>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 font-mono">
                {logs.map((line, i) => (
                  <div key={i} className={`text-[11px] leading-relaxed ${line.includes('✓') ? 'text-emerald-400' : line.includes('◐') ? 'text-indigo-400' : 'text-slate-500'}`}>
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────

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
  const [detailConn, setDetailConn] = useState<ConnectorConfig | null>(null);
  const [bindConnId, setBindConnId] = useState('');
  const [bindDeId, setBindDeId] = useState('');
  const [bindSaved, setBindSaved] = useState(false);
  const [toast, setToast] = useState('');
  const [syncing, setSyncing] = useState<string | null>(null);

  useEffect(() => {
    setConnectors(loadConnectors(tenantId));
  }, [tenantId]);

  // Keep detailConn in sync when connectors update
  useEffect(() => {
    if (detailConn) {
      const updated = connectors.find(c => c.id === detailConn.id)
      if (updated) setDetailConn(updated)
    }
  }, [connectors]);

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

  const handleSync = async (conn: ConnectorConfig) => {
    setSyncing(conn.id);
    await new Promise(r => setTimeout(r, 2000));
    const newCount = Math.floor(Math.random() * 50) + 1;
    const updated = connectors.map(c => c.id === conn.id
      ? { ...c, lastSync: new Date().toISOString(), recordCount: c.recordCount + newCount }
      : c);
    persist(updated);
    setSyncing(null);
    setToast(`Synced ${newCount} new records from ${conn.name}`);
    setTimeout(() => setToast(''), 4000);
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

  const handleDetailSave = (config: Record<string, string>, name: string) => {
    if (!detailConn) return;
    persist(connectors.map(c => c.id === detailConn.id ? { ...c, config, name } : c));
    setToast('Configuration saved');
    setTimeout(() => setToast(''), 3000);
  };

  const handleDetailDelete = (id: string) => {
    persist(connectors.filter(c => c.id !== id));
    setDetailConn(null);
    setToast('Connector removed');
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

  const handleUnbind = async (deId: string, connId: string) => {
    const de = employees.find(e => e.id === deId);
    if (!de) return;
    const existing = de.knowledgeSources || [];
    await update(deId, { knowledgeSources: existing.filter((id: string) => id !== connId) });
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

      {/* Connectors grid */}
      {connectors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-10 text-center mb-6">
          <p className="text-slate-500 text-sm">No connectors yet. Add your first one to link a data source.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          {connectors.map(conn => {
            const meta = connectorMeta(conn.type);
            const isSyncing = syncing === conn.id;
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
                  <button onClick={() => handleTest(conn)} disabled={conn.status === 'testing' || isSyncing}
                    className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all disabled:opacity-50">
                    {conn.status === 'testing' ? 'Testing…' : 'Test Connection'}
                  </button>
                  {conn.status === 'connected' && (
                    <button onClick={() => handleSync(conn)} disabled={isSyncing}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all disabled:opacity-50">
                      {isSyncing ? (
                        <span className="flex items-center gap-1.5">
                          <div className="w-3 h-3 border border-slate-600 border-t-emerald-400 rounded-full animate-spin" />
                          Syncing
                        </span>
                      ) : 'Sync Now'}
                    </button>
                  )}
                  <button onClick={() => setDetailConn(conn)}
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

      {/* Connector Detail Panel */}
      {detailConn && (
        <ConnectorDetailPanel
          conn={detailConn}
          tenantId={tenantId}
          accentColor={accentColor}
          onClose={() => setDetailConn(null)}
          onSave={handleDetailSave}
          onTest={handleTest}
          onDelete={handleDetailDelete}
          employees={employees}
          onUnbind={handleUnbind}
        />
      )}
    </div>
  );
};

export default DataConnectorsPage;
