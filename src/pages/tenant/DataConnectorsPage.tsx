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
  | 'gainsight'
  | 'rest_api' | 'graphql' | 'webhook'
  | 'postgresql' | 'mysql' | 'mongodb';

const CONNECTOR_GROUPS: { label: string; types: { type: ConnectorType; name: string; avatar: string; avatarBg: string }[] }[] = [
  {
    label: 'CRM & Support',
    types: [
      { type: 'salesforce', name: 'Salesforce', avatar: 'SF', avatarBg: 'bg-blue-500' },
      { type: 'hubspot', name: 'HubSpot', avatar: 'HS', avatarBg: 'bg-orange-500' },
      { type: 'zendesk', name: 'Zendesk', avatar: 'ZD', avatarBg: 'bg-green-500' },
      { type: 'gainsight', name: 'Gainsight', avatar: 'GS', avatarBg: 'bg-teal-600' },
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
  gainsight: [
    { name: 'Company', fields: ['id', 'name', 'arr', 'health_score', 'health_trend', 'renewal_date', 'csm_owner', 'stage', 'risk_reason', 'nps_score'] },
    { name: 'Contract', fields: ['id', 'company_id', 'value', 'start_date', 'renewal_date', 'status', 'signed_by'] },
    { name: 'CTA', fields: ['id', 'company_id', 'type', 'priority', 'due_date', 'status', 'owner', 'notes'] },
    { name: 'Timeline', fields: ['id', 'company_id', 'type', 'notes', 'logged_by', 'created_at'] },
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

// ── Canonical fields (DreamTeam internal data model) ───────────

const CANONICAL_FIELDS = [
  { id: 'customer.id', label: 'Customer ID', type: 'string', description: 'Unique customer identifier', entity: 'Customer' },
  { id: 'customer.name', label: 'Customer Name', type: 'string', description: 'Full legal name or company name', entity: 'Customer' },
  { id: 'customer.email', label: 'Customer Email', type: 'email', description: 'Primary contact email', entity: 'Customer' },
  { id: 'customer.phone', label: 'Customer Phone', type: 'phone', description: 'Primary phone number', entity: 'Customer' },
  { id: 'customer.plan', label: 'Subscription Plan', type: 'string', description: 'Current subscription tier', entity: 'Customer' },
  { id: 'customer.status', label: 'Account Status', type: 'enum', description: 'active / suspended / churned', entity: 'Customer' },
  { id: 'invoice.id', label: 'Invoice ID', type: 'string', description: 'Unique invoice identifier', entity: 'Invoice' },
  { id: 'invoice.amount', label: 'Invoice Amount', type: 'currency', description: 'Total invoice value in USD', entity: 'Invoice' },
  { id: 'invoice.due_date', label: 'Due Date', type: 'date', description: 'Invoice payment due date', entity: 'Invoice' },
  { id: 'invoice.status', label: 'Invoice Status', type: 'enum', description: 'draft / sent / paid / overdue', entity: 'Invoice' },
  { id: 'payment.amount', label: 'Payment Amount', type: 'currency', description: 'Amount received', entity: 'Payment' },
  { id: 'payment.date', label: 'Payment Date', type: 'date', description: 'Date payment was received', entity: 'Payment' },
  { id: 'payment.method', label: 'Payment Method', type: 'string', description: 'Card / ACH / wire', entity: 'Payment' },
  { id: 'ticket.id', label: 'Support Ticket ID', type: 'string', description: 'Unique support case identifier', entity: 'Ticket' },
  { id: 'ticket.subject', label: 'Ticket Subject', type: 'string', description: 'Brief description of issue', entity: 'Ticket' },
  { id: 'ticket.status', label: 'Ticket Status', type: 'enum', description: 'open / pending / resolved / closed', entity: 'Ticket' },
  { id: 'ticket.priority', label: 'Priority', type: 'enum', description: 'low / normal / high / urgent', entity: 'Ticket' },
  { id: 'contract.start_date', label: 'Contract Start', type: 'date', description: 'Contract effective date', entity: 'Contract' },
  { id: 'contract.end_date', label: 'Contract End', type: 'date', description: 'Contract expiry date', entity: 'Contract' },
  { id: 'contract.value', label: 'Contract Value', type: 'currency', description: 'Total contract value', entity: 'Contract' },
];

type FieldMapping = {
  sourceField: string;
  transform: string;
  defaultValue: string;
  isPii: boolean;
  customExpr: string;
};

// ── Enhanced log type ─────────────────────────────────────────

interface EnhancedLog {
  ts: string;
  level: 'success' | 'info' | 'error';
  message: string;
  duration?: string;
  breakdown?: string;
}

function generateEnhancedLogs(_conn: ConnectorConfig): EnhancedLog[] {
  const now = new Date('2026-07-02T09:15:23');
  const logs: EnhancedLog[] = [];
  const counts = [1247, 1241, 1236, 1229, 1218];
  const durations = ['2.3s', '1.9s', '2.7s', '3.1s', '2.0s'];
  for (let i = 0; i < 5; i++) {
    const dt = new Date(now.getTime() - i * 15 * 60 * 1000);
    const ts = dt.toISOString().replace('T', ' ').slice(0, 19);
    const dt2 = new Date(dt.getTime() - 15000);
    const ts2 = dt2.toISOString().replace('T', ' ').slice(0, 19);
    logs.push({
      ts,
      level: 'success',
      message: `Sync completed — ${counts[i].toLocaleString()} records processed`,
      duration: durations[i],
      breakdown: `${counts[i] - 5} updated, 3 new, 2 deleted`,
    });
    logs.push({ ts: ts2, level: 'info', message: 'Sync started' });
  }
  return logs;
}

// ── ConfigFields ───────────────────────────────────────────────

// ── OAuth provider config ──────────────────────────────────────

const OAUTH_PROVIDERS: Record<string, {
  displayName: string;
  loginDomain: string;
  scopes: string;
  permissions: string[];
  fakeAccount: string;
}> = {
  salesforce: {
    displayName: 'Salesforce',
    loginDomain: 'login.salesforce.com',
    scopes: 'api refresh_token offline_access',
    permissions: ['Read and write CRM records', 'Access contacts and accounts', 'Manage opportunities and cases', 'Refresh access offline'],
    fakeAccount: 'DreamTeam Org (dreamteam.my.salesforce.com)',
  },
  hubspot: {
    displayName: 'HubSpot',
    loginDomain: 'app.hubspot.com',
    scopes: 'crm.objects.contacts.read crm.objects.deals.read',
    permissions: ['Read contacts and companies', 'Read deals and pipelines', 'Access marketing email data', 'View form submissions'],
    fakeAccount: 'DreamTeam Portal (portal ID 98432156)',
  },
  zendesk: {
    displayName: 'Zendesk',
    loginDomain: 'login.zendesk.com',
    scopes: 'read write',
    permissions: ['Read and manage tickets', 'Access user profiles', 'View helpdesk macros', 'Read ticket comments and history'],
    fakeAccount: 'dreamteam.zendesk.com',
  },
  quickbooks: {
    displayName: 'QuickBooks',
    loginDomain: 'appcenter.intuit.com',
    scopes: 'com.intuit.quickbooks.accounting',
    permissions: ['Read invoices and payments', 'Access chart of accounts', 'Read vendor and customer records', 'View financial reports'],
    fakeAccount: 'DreamTeam LLC (Company ID 1234567890)',
  },
  xero: {
    displayName: 'Xero',
    loginDomain: 'login.xero.com',
    scopes: 'accounting.transactions accounting.contacts',
    permissions: ['Read and write invoices', 'Access contacts and organisations', 'View bank transactions', 'Read purchase orders'],
    fakeAccount: 'DreamTeam Ltd (Xero Org: AU-dreamteam)',
  },
  chargebee: {
    displayName: 'Chargebee',
    loginDomain: 'dreamteam.chargebee.com',
    scopes: 'full_access',
    permissions: ['Read subscriptions and invoices', 'Access customer billing data', 'View payment transactions', 'Read addon and plan catalog'],
    fakeAccount: 'DreamTeam (dreamteam.chargebee.com)',
  },
};

const OAUTH_TYPES = new Set(Object.keys(OAUTH_PROVIDERS));

function ConfigFields({
  type, config, setConfig,
  authMethod, setAuthMethod, onOAuthConnect,
}: {
  type: ConnectorType;
  config: Record<string, string>;
  setConfig: (c: Record<string, string>) => void;
  authMethod?: 'oauth' | 'manual';
  setAuthMethod?: (m: 'oauth' | 'manual') => void;
  onOAuthConnect?: () => void;
}) {
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

  // OAuth-supported types: show auth method selector first
  if (OAUTH_TYPES.has(type) && type !== 'stripe') {
    const provider = OAUTH_PROVIDERS[type];
    const method = authMethod || 'oauth';
    const isConnected = config.oauth_connected === 'true';

    return (
      <div className="space-y-4">
        {/* Auth method selector */}
        <div>
          <label className="text-xs text-slate-400 block mb-2">Authentication Method</label>
          <div className="grid grid-cols-2 gap-2">
            {(['oauth', 'manual'] as const).map(m => (
              <button
                key={m}
                onClick={() => setAuthMethod?.(m)}
                className={`px-3 py-2.5 rounded-lg border text-left transition-all ${method === m
                  ? 'border-indigo-500 bg-indigo-500/10 text-white'
                  : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-500'}`}
              >
                <div className="text-xs font-semibold">{m === 'oauth' ? 'OAuth 2.0' : 'API Key / Manual'}</div>
                <div className="text-[10px] mt-0.5 opacity-70">{m === 'oauth' ? 'Recommended' : 'Advanced'}</div>
              </button>
            ))}
          </div>
        </div>

        {method === 'oauth' && !isConnected && (
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-3">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-white text-xs font-bold ${connectorMeta(type).avatarBg}`}>
                {connectorMeta(type).avatar}
              </div>
              <div>
                <div className="text-sm font-medium text-white">Connect with {provider.displayName}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">You'll be redirected to authorise DreamTeam AI</div>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium">Permissions requested</p>
              {provider.permissions.map(p => (
                <div key={p} className="flex items-center gap-2 text-xs text-slate-300">
                  <div className="w-1 h-1 rounded-full bg-indigo-400 flex-shrink-0" />
                  {p}
                </div>
              ))}
            </div>
            <div className="text-[10px] text-slate-600 font-mono bg-slate-950 rounded px-2 py-1 border border-slate-800">
              Scopes: {provider.scopes}
            </div>
            <button
              onClick={onOAuthConnect}
              className="w-full py-2 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 transition-all flex items-center justify-center gap-2"
            >
              <span>🔐</span> Connect with {provider.displayName}
            </button>
          </div>
        )}

        {method === 'oauth' && isConnected && (
          <div className="rounded-xl border border-emerald-700/50 bg-emerald-500/5 p-3 space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-xs font-medium text-emerald-300">OAuth Connected</span>
            </div>
            <p className="text-[11px] text-slate-400">{config.oauth_account || provider.fakeAccount}</p>
            <div className="flex flex-wrap gap-1 mt-1">
              {provider.scopes.split(' ').map(s => (
                <span key={s} className="text-[9px] px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded font-mono">{s}</span>
              ))}
            </div>
          </div>
        )}

        {method === 'manual' && (
          <div className="space-y-3">
            {type === 'salesforce' && <>
              {inp('Instance URL', 'instance_url', { placeholder: 'https://yourorg.salesforce.com' })}
              {inp('Client ID', 'client_id')}
              {inp('Client Secret', 'client_secret', { type: 'password' })}
            </>}
            {type === 'hubspot' && <>
              {inp('Access Token', 'access_token', { type: 'password', placeholder: 'pat-na1-...' })}
            </>}
            {type === 'zendesk' && <>
              {inp('Subdomain', 'subdomain', { placeholder: 'yourcompany' })}
              {inp('Email', 'email', { placeholder: 'admin@yourcompany.com' })}
              {inp('API Token', 'api_token', { type: 'password' })}
            </>}
            {type === 'quickbooks' && <>
              {inp('Realm ID (Company ID)', 'realm_id')}
              {inp('Access Token', 'access_token', { type: 'password' })}
              {inp('Refresh Token', 'refresh_token', { type: 'password' })}
            </>}
            {type === 'xero' && <>
              {inp('Client ID', 'client_id')}
              {inp('Client Secret', 'client_secret', { type: 'password' })}
              {inp('Tenant ID', 'tenant_id')}
            </>}
            {type === 'chargebee' && <>
              {inp('Site Name', 'site', { placeholder: 'yourcompany' })}
              {inp('API Key', 'api_key', { type: 'password' })}
            </>}
          </div>
        )}
      </div>
    );
  }

  // Stripe: API key only (not OAuth)
  if (type === 'stripe') return <div className="space-y-3">
    <div className="rounded-lg border border-amber-700/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
      Stripe uses API keys, not OAuth. Enter your secret key below.
    </div>
    {inp('Secret Key', 'api_key', { placeholder: 'sk_live_...', type: 'password' })}
    {inp('Webhook Secret', 'webhook_secret', { type: 'password' })}
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

  if (type === 'gainsight') return <div className="space-y-3">
    {inp('Gainsight Domain', 'domain', { placeholder: 'yourcompany.gainsightcloud.com' })}
    {inp('Access Key', 'access_key', { type: 'password' })}
    {inp('API Version', 'api_version', { placeholder: 'v1.0' })}
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

// ── Masking helpers ────────────────────────────────────────────

type MaskBehavior = 'redact' | 'partial' | 'hash' | 'mask_middle' | 'full';
type MaskingRule = { behavior: MaskBehavior; allowedRoles: string[] };

const MASK_LABELS: Record<MaskBehavior, string> = {
  redact: 'Redact ([REDACTED])',
  partial: 'Partial (joh***)',
  hash: 'Hash (SHA256:a3f2...)',
  mask_middle: 'Mask middle (j***@co.com)',
  full: 'Full (no masking)',
};

const ALL_ROLES = ['tenant_owner', 'tenant_admin', 'tenant_manager', 'tenant_user'];

function applyMask(value: string, behavior: MaskBehavior, viewerRole: string, allowedRoles: string[]): string {
  if (allowedRoles.includes(viewerRole)) return value;
  if (behavior === 'redact') return '[REDACTED]';
  if (behavior === 'partial') return value.slice(0, 3) + '***';
  if (behavior === 'hash') return 'SHA256:' + Math.abs(value.split('').reduce((a, c) => (a << 5) - a + c.charCodeAt(0), 0)).toString(16).slice(0, 8) + '...';
  if (behavior === 'mask_middle') {
    if (value.includes('@')) {
      const [local, domain] = value.split('@');
      return local[0] + '***@' + domain;
    }
    return value.slice(0, 3) + '***' + value.slice(-4);
  }
  return value;
}

const PREVIEW_RECORDS: Record<string, { field: string; canonicalId: string; value: string }[]> = {
  salesforce: [
    { field: 'customer.name', canonicalId: 'customer.name', value: 'Acme Corporation' },
    { field: 'customer.email', canonicalId: 'customer.email', value: 'john.doe@acme.com' },
    { field: 'customer.id', canonicalId: 'customer.id', value: '0018000001XYZ' },
    { field: 'invoice.amount', canonicalId: 'invoice.amount', value: '$12,450.00' },
    { field: 'customer.phone', canonicalId: 'customer.phone', value: '+1-555-867-4521' },
  ],
};

// ── Field Map Tab ──────────────────────────────────────────────

function FieldMapTab({ conn, accentColor }: { conn: ConnectorConfig; accentColor: string }) {
  const storageKey = `dt_connector_fieldmap_${conn.id}`;
  const maskingKey = `dt_connector_masking_${conn.id}`;
  const [mappings, setMappings] = useState<Record<string, FieldMapping>>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; }
  });
  const [maskingRules, setMaskingRules] = useState<Record<string, MaskingRule>>(() => {
    try { return JSON.parse(localStorage.getItem(maskingKey) || '{}'); } catch { return {}; }
  });
  const [selectedField, setSelectedField] = useState<string>(CANONICAL_FIELDS[0].id);
  const [saved, setSaved] = useState(false);
  const [previewRole, setPreviewRole] = useState<string>('tenant_user');

  const updateMaskingRule = (fieldId: string, patch: Partial<MaskingRule>) => {
    const current = maskingRules[fieldId] || { behavior: 'redact', allowedRoles: ['tenant_owner', 'tenant_admin'] };
    const next = { ...maskingRules, [fieldId]: { ...current, ...patch } };
    setMaskingRules(next);
    try { localStorage.setItem(maskingKey, JSON.stringify(next)); } catch {}
  };

  const schemaObjects = SCHEMA_OBJECTS[conn.type] ?? [];
  const allSourceFields: string[] = schemaObjects.flatMap(obj => obj.fields.map(f => `${obj.name}.${f}`));
  const mappedCount = Object.values(mappings).filter(m => m.sourceField && m.sourceField !== '').length;
  const entities = [...new Set(CANONICAL_FIELDS.map(f => f.entity))];
  const currentMapping: FieldMapping = mappings[selectedField] || { sourceField: '', transform: 'none', defaultValue: '', isPii: false, customExpr: '{{value}}.trim()' };

  const updateMapping = (updates: Partial<FieldMapping>) => {
    const next = { ...mappings, [selectedField]: { ...currentMapping, ...updates } };
    setMappings(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const autoMap = () => {
    const keywords: Record<string, string[]> = {
      'customer.id': ['id'], 'customer.name': ['name'], 'customer.email': ['email'],
      'customer.phone': ['phone'], 'customer.plan': ['plan', 'subscription', 'tier'],
      'customer.status': ['status'], 'invoice.id': ['id'], 'invoice.amount': ['amount', 'total'],
      'invoice.due_date': ['due_date', 'due'], 'invoice.status': ['status'],
      'payment.amount': ['amount'], 'payment.date': ['date', 'created'],
      'payment.method': ['method', 'type'], 'ticket.id': ['id'],
      'ticket.subject': ['subject', 'title'], 'ticket.status': ['status'],
      'ticket.priority': ['priority'], 'contract.start_date': ['start_date', 'start'],
      'contract.end_date': ['end_date', 'end'], 'contract.value': ['value', 'amount', 'total'],
    };
    const entityHints: Record<string, string[]> = {
      'customer': ['Account', 'Customer', 'Contact', 'Company'],
      'invoice': ['Invoice'], 'payment': ['Payment', 'Charge', 'PaymentIntent'],
      'ticket': ['Ticket', 'Case'], 'contract': ['Subscription', 'Contract'],
    };
    const next: Record<string, FieldMapping> = { ...mappings };
    for (const cf of CANONICAL_FIELDS) {
      if (next[cf.id]?.sourceField) continue;
      const entity = cf.id.split('.')[0];
      const kws = keywords[cf.id] || [];
      const preferredObjects = entityHints[entity] || [];
      let found = '';
      for (const obj of schemaObjects) {
        if (!preferredObjects.some(p => obj.name.toLowerCase().includes(p.toLowerCase()))) continue;
        for (const field of obj.fields) {
          if (kws.some(k => field.toLowerCase().includes(k.toLowerCase()))) { found = `${obj.name}.${field}`; break; }
        }
        if (found) break;
      }
      if (!found) {
        for (const obj of schemaObjects) {
          for (const field of obj.fields) {
            if (kws.some(k => field.toLowerCase().includes(k.toLowerCase()))) { found = `${obj.name}.${field}`; break; }
          }
          if (found) break;
        }
      }
      if (found) next[cf.id] = { sourceField: found, transform: 'none', defaultValue: '', isPii: false, customExpr: '{{value}}.trim()' };
    }
    setMappings(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const typeBadgeColor: Record<string, string> = {
    string: 'bg-blue-500/20 text-blue-300', email: 'bg-violet-500/20 text-violet-300',
    phone: 'bg-green-500/20 text-green-300', enum: 'bg-amber-500/20 text-amber-300',
    currency: 'bg-emerald-500/20 text-emerald-300', date: 'bg-sky-500/20 text-sky-300',
  };

  const cf = CANONICAL_FIELDS.find(f => f.id === selectedField);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-500">Map connector fields to DreamTeam's universal data model.</p>
          <p className="text-xs text-indigo-400 mt-0.5 font-medium">{mappedCount} / {CANONICAL_FIELDS.length} fields mapped</p>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-emerald-400">Saved</span>}
          <button onClick={autoMap} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all">Auto-map fields</button>
        </div>
      </div>

      <div className="w-full bg-slate-800 rounded-full h-1.5">
        <div className="h-1.5 rounded-full transition-all" style={{ width: `${(mappedCount / CANONICAL_FIELDS.length) * 100}%`, backgroundColor: accentColor }} />
      </div>

      <div className="flex gap-3" style={{ minHeight: 420 }}>
        <div className="w-52 flex-shrink-0 space-y-3 overflow-y-auto">
          {entities.map(entity => (
            <div key={entity}>
              <p className="text-[10px] uppercase tracking-widest text-slate-600 mb-1 px-1">{entity}</p>
              {CANONICAL_FIELDS.filter(f => f.entity === entity).map(field => {
                const isMapped = !!(mappings[field.id]?.sourceField);
                const isSelected = selectedField === field.id;
                return (
                  <button key={field.id} onClick={() => setSelectedField(field.id)}
                    className={`w-full text-left px-2 py-1.5 rounded-lg mb-0.5 transition-all ${isSelected ? 'bg-slate-800 border border-slate-600' : 'hover:bg-slate-900 border border-transparent'}`}>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isMapped ? 'bg-emerald-400' : 'bg-slate-700'}`} />
                      <span className="text-xs text-slate-300 truncate">{field.label}</span>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5 ml-3">
                      <span className={`text-[9px] px-1 py-0.5 rounded font-mono ${typeBadgeColor[field.type] || 'bg-slate-700 text-slate-400'}`}>{field.type}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex-1 bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
          {cf && (
            <>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-white">{cf.label}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${typeBadgeColor[cf.type] || 'bg-slate-700 text-slate-400'}`}>{cf.type}</span>
                  {currentMapping.isPii && <span className="text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-300 rounded">🔒 PII</span>}
                </div>
                <p className="text-xs text-slate-500">{cf.description}</p>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Mapped from</label>
                <select value={currentMapping.sourceField} onChange={e => updateMapping({ sourceField: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                  <option value="">(Not mapped)</option>
                  {allSourceFields.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Transform</label>
                <select value={currentMapping.transform} onChange={e => updateMapping({ transform: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                  <option value="none">None (raw value)</option>
                  <option value="uppercase">Uppercase</option>
                  <option value="lowercase">Lowercase</option>
                  <option value="truncate">Truncate to 100 chars</option>
                  <option value="parse_number">Parse as number</option>
                  <option value="format_currency">Format as currency ($X,XXX.XX)</option>
                  <option value="format_date">Format as date (YYYY-MM-DD)</option>
                  <option value="custom">Custom expression</option>
                </select>
                {currentMapping.transform === 'custom' && (
                  <input value={currentMapping.customExpr} onChange={e => updateMapping({ customExpr: e.target.value })}
                    className="w-full mt-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-emerald-300 font-mono focus:outline-none focus:border-indigo-500"
                    placeholder="{{value}}.trim().toLowerCase()" />
                )}
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Default value if null</label>
                <input value={currentMapping.defaultValue} onChange={e => updateMapping({ defaultValue: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  placeholder="Leave blank to use null" />
              </div>

              <div className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700">
                <div>
                  <div className="text-xs font-medium text-white">Mark as PII</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Will be masked in agent responses unless DE has PII access</div>
                </div>
                <button onClick={() => updateMapping({ isPii: !currentMapping.isPii })}
                  className={`w-10 h-6 rounded-full transition-all relative ${currentMapping.isPii ? 'bg-indigo-500' : 'bg-slate-700'}`}>
                  <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${currentMapping.isPii ? 'left-5' : 'left-1'}`} />
                </button>
              </div>

              {currentMapping.isPii && (
                <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                  🔒 This field will be masked in agent responses unless the DE has PII access enabled.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* PII Masking Rules */}
      {(() => {
        const piiFields = CANONICAL_FIELDS.filter(f => mappings[f.id]?.isPii);
        const previewRecords = PREVIEW_RECORDS[conn.type] || [];
        return (
          <div className="mt-4 rounded-xl border border-red-800/40 bg-red-500/5 p-4 space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-sm">&#128274;</span>
              <span className="text-sm font-semibold text-white">PII Masking Rules</span>
              <span className="ml-auto px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/15 text-red-400 border border-red-800/40">{piiFields.length} fields marked as PII</span>
            </div>

            {piiFields.length === 0 ? (
              <p className="text-xs text-slate-500">No fields marked as PII yet. Toggle "Mark as PII" on a field to configure masking.</p>
            ) : (
              <div className="space-y-3">
                {piiFields.map(cf => {
                  const rule = maskingRules[cf.id] || { behavior: 'redact' as MaskBehavior, allowedRoles: ['tenant_owner', 'tenant_admin'] };
                  return (
                    <div key={cf.id} className="bg-slate-900 border border-slate-700 rounded-xl p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-white">{cf.label}</span>
                        <span className="text-[10px] text-slate-500">{mappings[cf.id]?.sourceField || '(not mapped)'}</span>
                      </div>
                      <div className="grid grid-cols-1 gap-2">
                        <div>
                          <label className="text-[10px] text-slate-400 block mb-0.5">Masking behavior</label>
                          <select value={rule.behavior} onChange={e => updateMaskingRule(cf.id, { behavior: e.target.value as MaskBehavior })}
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none">
                            {(Object.entries(MASK_LABELS) as [MaskBehavior, string][]).map(([k, v]) => (
                              <option key={k} value={k}>{v}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] text-slate-400 block mb-1">Who can see unmasked</label>
                          <div className="flex flex-wrap gap-2">
                            {ALL_ROLES.map(r => (
                              <label key={r} className="flex items-center gap-1 cursor-pointer">
                                <input type="checkbox" className="accent-indigo-500"
                                  checked={rule.allowedRoles.includes(r)}
                                  onChange={e => {
                                    const next = e.target.checked ? [...rule.allowedRoles, r] : rule.allowedRoles.filter(x => x !== r);
                                    updateMaskingRule(cf.id, { allowedRoles: next });
                                  }} />
                                <span className="text-[10px] text-slate-300">{r.replace('tenant_', '')}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Masking Preview */}
            {previewRecords.length > 0 && (
              <div className="border-t border-red-800/30 pt-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium text-slate-300">Customer Record Preview (with masking applied)</p>
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-slate-400">View as role:</label>
                    <select value={previewRole} onChange={e => setPreviewRole(e.target.value)}
                      className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[10px] text-white focus:outline-none">
                      {ALL_ROLES.map(r => <option key={r} value={r}>{r.replace('tenant_', '')}</option>)}
                    </select>
                  </div>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                  {previewRecords.map((rec, i) => {
                    const rule = maskingRules[rec.canonicalId];
                    const isPii = mappings[rec.canonicalId]?.isPii;
                    const maskedVal = rule && isPii ? applyMask(rec.value, rule.behavior, previewRole, rule.allowedRoles) : rec.value;
                    const wasMasked = maskedVal !== rec.value;
                    return (
                      <div key={i} className={`flex items-center gap-3 px-3 py-2 text-[11px] font-mono ${i < previewRecords.length - 1 ? 'border-b border-slate-800' : ''}`}>
                        <span className="text-slate-500 w-32 flex-shrink-0">{rec.field}</span>
                        <span className={`flex-1 ${wasMasked ? 'text-amber-300' : 'text-slate-200'}`}>{maskedVal}</span>
                        {isPii && <span className={`text-[9px] px-1.5 py-0.5 rounded ${wasMasked ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/15 text-emerald-400'}`}>{wasMasked ? 'masked - PII' : 'full access'}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* DE access enforcement note */}
            <div className="border border-slate-700 rounded-lg px-3 py-2 text-[11px] text-slate-400 bg-slate-900/50">
              <p className="font-medium text-slate-300 mb-1">DE access enforcement</p>
              <p>When a DE queries this connector, PII fields are automatically masked based on the DE's trust level:</p>
              <ul className="mt-1 space-y-0.5 ml-3">
                <li>• <span className="text-slate-300">Supervised DE:</span> all PII masked</li>
                <li>• <span className="text-slate-300">Established DE:</span> partial masking</li>
                <li>• <span className="text-slate-300">Trusted DE:</span> full access to all fields</li>
              </ul>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Sync Config Section ────────────────────────────────────────

interface SyncFilter { field: string; operator: string; value: string; }
interface SyncConfig {
  mode: 'full' | 'incremental' | 'event';
  incrementalField: string;
  incrementalMethod: string;
  webhookEvents: string[];
  frequency: string;
  runAt: string;
  timezone: string;
  conflictResolution: string;
  filters: SyncFilter[];
}

function defaultSyncConfig(connType: string): SyncConfig {
  const fieldMap: Record<string, string> = {
    salesforce: 'LastModifiedDate', hubspot: 'updated_at', zendesk: 'updated_at',
    netsuite: 'updated_at', stripe: 'created',
  };
  return {
    mode: 'incremental', incrementalField: fieldMap[connType] || 'updated_at',
    incrementalMethod: 'timestamp', webhookEvents: [], frequency: 'hourly',
    runAt: '02:00', timezone: 'UTC', conflictResolution: 'newest',
    filters: connType === 'salesforce' ? [{ field: 'Account.type', operator: 'equals', value: 'Customer' }] : [],
  };
}

interface AlertConfig {
  onFail: boolean;
  onDrop: boolean;
  dropThreshold: number;
  onStale: boolean;
  staleHours: number;
  delivery: { inApp: boolean; email: boolean };
  emailAddr: string;
}

function defaultAlertConfig(): AlertConfig {
  return { onFail: true, onDrop: true, dropThreshold: 20, onStale: true, staleHours: 24, delivery: { inApp: true, email: false }, emailAddr: '' };
}

function SyncConfigSection({ conn, accentColor, onToast }: { conn: ConnectorConfig; accentColor: string; onToast: (msg: string) => void }) {
  const storageKey = `dt_connector_sync_${conn.id}`;
  const alertsKey = `dt_connector_alerts_${conn.id}`;
  const [cfg, setCfg] = useState<SyncConfig>(() => {
    try { return { ...defaultSyncConfig(conn.type), ...JSON.parse(localStorage.getItem(storageKey) || '{}') }; } catch { return defaultSyncConfig(conn.type); }
  });
  const [alertCfg, setAlertCfg] = useState<AlertConfig>(() => {
    try { return { ...defaultAlertConfig(), ...JSON.parse(localStorage.getItem(alertsKey) || '{}') }; } catch { return defaultAlertConfig(); }
  });
  const [newFilter, setNewFilter] = useState<SyncFilter>({ field: '', operator: 'equals', value: '' });

  const saveAlerts = (updates: Partial<AlertConfig>) => {
    const next = { ...alertCfg, ...updates };
    setAlertCfg(next);
    try { localStorage.setItem(alertsKey, JSON.stringify(next)); } catch {}
  };

  const schemaObjects = SCHEMA_OBJECTS[conn.type] ?? [];
  const allFields = schemaObjects.flatMap(obj => obj.fields.map(f => `${obj.name}.${f}`));

  const save = (updates: Partial<SyncConfig>) => {
    const next = { ...cfg, ...updates };
    setCfg(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  };

  const webhookUrlBase = `https://api.dreamteam.ai/webhooks/connector/${conn.id}`;
  const connectorEvents: Record<string, string[]> = {
    salesforce: ['account.created', 'account.updated', 'opportunity.won', 'case.created'],
    stripe: ['payment_intent.succeeded', 'invoice.paid', 'customer.subscription.updated', 'charge.failed'],
    hubspot: ['contact.created', 'deal.propertyChange', 'ticket.created'],
    zendesk: ['ticket.created', 'ticket.updated', 'user.created'],
    netsuite: ['invoice.created', 'payment.applied', 'customer.created'],
  };
  const events = connectorEvents[conn.type] || ['record.created', 'record.updated', 'record.deleted'];

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-4">
      <h3 className="text-sm font-semibold text-white">Sync Configuration</h3>

      <div>
        <label className="text-xs text-slate-400 block mb-2">Sync mode</label>
        <div className="space-y-2">
          {([
            { value: 'full', label: 'Full refresh', desc: 'Replace all data on each sync. Safest but slowest.' },
            { value: 'incremental', label: 'Incremental', desc: 'Only sync records changed since last sync. Faster, uses less API quota.', recommended: true },
            { value: 'event', label: 'Event-driven', desc: 'Sync triggered by webhook events in real-time.' },
          ] as const).map(opt => (
            <label key={opt.value} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${cfg.mode === opt.value ? 'border-indigo-500 bg-indigo-500/5' : 'border-slate-700 hover:border-slate-600'}`}>
              <input type="radio" name={`sync_mode_${conn.id}`} value={opt.value} checked={cfg.mode === opt.value} onChange={() => save({ mode: opt.value })} className="mt-0.5 accent-indigo-500" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-white">{opt.label}</span>
                  {'recommended' in opt && <span className="text-[9px] px-1.5 py-0.5 bg-indigo-500/20 text-indigo-300 rounded">Recommended</span>}
                </div>
                <span className="text-[11px] text-slate-500">{opt.desc}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      {cfg.mode === 'incremental' && (
        <div className="space-y-3 pl-1">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Track changes by</label>
            <select value={cfg.incrementalMethod} onChange={e => save({ incrementalMethod: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
              <option value="timestamp">Updated timestamp field</option>
              <option value="checksum">Record ID + checksum</option>
              <option value="webhook">Webhook events</option>
            </select>
          </div>
          {cfg.incrementalMethod === 'timestamp' && (
            <div>
              <label className="text-xs text-slate-400 block mb-1">Timestamp field name</label>
              <input value={cfg.incrementalField} onChange={e => save({ incrementalField: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" />
            </div>
          )}
        </div>
      )}

      {cfg.mode === 'event' && (
        <div className="space-y-3 pl-1">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Webhook URL</label>
            <div className="flex gap-2">
              <input readOnly value={webhookUrlBase} className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-400 font-mono focus:outline-none" />
              <button onClick={() => { navigator.clipboard.writeText(webhookUrlBase); onToast('Webhook URL copied'); }} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all">Copy</button>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-2">Events to listen for</label>
            <div className="space-y-1.5">
              {events.map(ev => (
                <label key={ev} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={cfg.webhookEvents.includes(ev)} onChange={e => {
                    const next = e.target.checked ? [...cfg.webhookEvents, ev] : cfg.webhookEvents.filter(x => x !== ev);
                    save({ webhookEvents: next });
                  }} className="accent-indigo-500" />
                  <span className="text-xs text-slate-300 font-mono">{ev}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {cfg.mode !== 'event' && (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Frequency</label>
            <select value={cfg.frequency} onChange={e => save({ frequency: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
              <option value="15min">Every 15 minutes</option>
              <option value="hourly">Hourly</option>
              <option value="6h">Every 6 hours</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          {(cfg.frequency === 'daily' || cfg.frequency === 'weekly') && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Run at (HH:MM)</label>
                <input type="time" value={cfg.runAt} onChange={e => save({ runAt: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Timezone</label>
                <select value={cfg.timezone} onChange={e => save({ timezone: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
                  <option value="UTC">UTC</option>
                  <option value="US/Eastern">US/Eastern</option>
                  <option value="US/Pacific">US/Pacific</option>
                  <option value="Europe/London">Europe/London</option>
                  <option value="Asia/Dubai">Asia/Dubai</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      <div>
        <label className="text-xs text-slate-400 block mb-2">When the same record is updated in both systems</label>
        <div className="space-y-1.5">
          {([
            { value: 'connector', label: 'Connector wins', desc: 'External system is source of truth' },
            { value: 'dreamteam', label: 'DreamTeam wins', desc: 'Our system overrides' },
            { value: 'newest', label: 'Newest update wins', desc: 'Compare timestamps' },
            { value: 'flag', label: 'Flag for manual review', desc: 'Add to conflict queue' },
          ] as const).map(opt => (
            <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name={`conflict_${conn.id}`} value={opt.value} checked={cfg.conflictResolution === opt.value} onChange={() => save({ conflictResolution: opt.value })} className="accent-indigo-500" />
              <span className="text-xs text-white">{opt.label}</span>
              <span className="text-xs text-slate-500">— {opt.desc}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs text-slate-400 block mb-2">Only sync records matching</label>
        <div className="space-y-2 mb-2">
          {cfg.filters.map((f, i) => (
            <div key={i} className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-300 font-mono flex-1 truncate">{f.field}</span>
              <span className="text-xs text-slate-500">{f.operator}</span>
              <span className="text-xs text-slate-300">{f.value}</span>
              <button onClick={() => save({ filters: cfg.filters.filter((_, j) => j !== i) })} className="text-slate-600 hover:text-red-400 text-sm ml-1">×</button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <select value={newFilter.field} onChange={e => setNewFilter(f => ({ ...f, field: e.target.value }))} className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none">
            <option value="">Field…</option>
            {allFields.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={newFilter.operator} onChange={e => setNewFilter(f => ({ ...f, operator: e.target.value }))} className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none">
            <option value="equals">equals</option>
            <option value="contains">contains</option>
            <option value="greater_than">greater than</option>
            <option value="less_than">less than</option>
            <option value="not_empty">not empty</option>
          </select>
          <input value={newFilter.value} onChange={e => setNewFilter(f => ({ ...f, value: e.target.value }))} placeholder="Value" className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none" />
          <button onClick={() => { if (newFilter.field) { save({ filters: [...cfg.filters, newFilter] }); setNewFilter({ field: '', operator: 'equals', value: '' }); } }}
            className="px-2 py-1.5 text-xs text-white rounded-lg" style={{ backgroundColor: accentColor }}>Add</button>
        </div>
      </div>

      <button onClick={() => { localStorage.setItem(storageKey, JSON.stringify(cfg)); onToast('Sync configuration saved'); }}
        className="w-full py-2 text-sm font-medium rounded-lg text-white" style={{ backgroundColor: accentColor }}>
        Save Sync Config
      </button>

      {/* Health Alerts */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-white">Health Alerts</h3>

        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-xs text-slate-300">Alert when sync fails</span>
          <button onClick={() => saveAlerts({ onFail: !alertCfg.onFail })}
            className={`w-9 h-5 rounded-full transition-all relative ${alertCfg.onFail ? 'bg-indigo-500' : 'bg-slate-700'}`}>
            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${alertCfg.onFail ? 'left-4' : 'left-0.5'}`} />
          </button>
        </label>

        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
            <button onClick={() => saveAlerts({ onDrop: !alertCfg.onDrop })}
              className={`w-9 h-5 rounded-full transition-all relative ${alertCfg.onDrop ? 'bg-indigo-500' : 'bg-slate-700'}`}>
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${alertCfg.onDrop ? 'left-4' : 'left-0.5'}`} />
            </button>
            <span className="text-xs text-slate-300">Alert when records drop by more than</span>
          </label>
          <div className="flex items-center gap-1">
            <input type="number" min={1} max={100} value={alertCfg.dropThreshold}
              onChange={e => saveAlerts({ dropThreshold: Math.min(100, Math.max(1, parseInt(e.target.value) || 20)) })}
              className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white text-center focus:outline-none" />
            <span className="text-xs text-slate-400">%</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
            <button onClick={() => saveAlerts({ onStale: !alertCfg.onStale })}
              className={`w-9 h-5 rounded-full transition-all relative ${alertCfg.onStale ? 'bg-indigo-500' : 'bg-slate-700'}`}>
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${alertCfg.onStale ? 'left-4' : 'left-0.5'}`} />
            </button>
            <span className="text-xs text-slate-300">Alert when out of sync for more than</span>
          </label>
          <div className="flex items-center gap-1">
            <input type="number" min={1} max={168} value={alertCfg.staleHours}
              onChange={e => saveAlerts({ staleHours: Math.min(168, Math.max(1, parseInt(e.target.value) || 24)) })}
              className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white text-center focus:outline-none" />
            <span className="text-xs text-slate-400">hours</span>
          </div>
        </div>

        <div>
          <label className="text-xs text-slate-400 block mb-2">Alert delivery</label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-indigo-500" checked={alertCfg.delivery.inApp}
                onChange={e => saveAlerts({ delivery: { ...alertCfg.delivery, inApp: e.target.checked } })} />
              <span className="text-xs text-slate-300">In-app notification</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-indigo-500" checked={alertCfg.delivery.email}
                onChange={e => saveAlerts({ delivery: { ...alertCfg.delivery, email: e.target.checked } })} />
              <span className="text-xs text-slate-300">Email</span>
            </label>
            {alertCfg.delivery.email && (
              <input value={alertCfg.emailAddr} onChange={e => saveAlerts({ emailAddr: e.target.value })}
                placeholder="alerts@yourcompany.com"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Lineage Tab ────────────────────────────────────────────────

function LineageTab({ conn, boundDEs }: { conn: ConnectorConfig; boundDEs: { id: string; name: string; icon?: string; department?: string }[] }) {
  const schemaObjects = SCHEMA_OBJECTS[conn.type] ?? [];
  const topObject = schemaObjects[0]?.name || 'Records';
  const seed = conn.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const usageCount = 20 + (seed % 181);
  const meta = connectorMeta(conn.type);

  const relativeTime = (h: number) => h === 0 ? 'Just now' : h < 1 ? `${Math.round(h * 60)}m ago` : `${Math.round(h)}h ago`;

  const traceTemplates: [string, string][] = [];
  for (const obj of schemaObjects.slice(0, 3)) {
    for (const field of obj.fields.slice(0, 3)) traceTemplates.push([obj.name, field]);
  }
  const fakeValues: Record<string, string[]> = {
    id: ['#10045', '#INV-2041', 'cus_abc123'], status: ['"Active"', '"Paid"', '"Open"'],
    amount: ['$12,450', '$3,200', '$89,000'], name: ['"TCP Inc"', '"Acme Corp"'],
    email: ['"admin@tcp.com"'], subject: ['"Integration issue"'],
    priority: ['"high"', '"urgent"'], due_date: ['"2026-08-15"'], balance: ['$4,250'],
  };
  const deNames = boundDEs.length > 0 ? boundDEs.map(d => d.name) : ['Support Agent', 'Billing Agent', 'Operations DE'];
  const traces = traceTemplates.slice(0, 5).map((tmpl, i) => {
    const [obj, field] = tmpl;
    const valArr = fakeValues[field] || ['"value"'];
    return { ts: relativeTime([0.05, 0.5, 1, 3, 7][i]), deName: deNames[i % deNames.length], query: `${obj}.${field}`, result: valArr[i % valArr.length] };
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Agent responses this month', value: usageCount.toString() },
          { label: 'Last used', value: '3 hours ago' },
          { label: 'Most queried object', value: topObject },
        ].map(stat => (
          <div key={stat.label} className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <div className="text-lg font-bold text-white">{stat.value}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{stat.label}</div>
          </div>
        ))}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <p className="text-xs text-slate-400 mb-3 font-medium">Data flow</p>
        <div className="flex items-center gap-2 overflow-x-auto">
          {[
            { label: meta.name, sub: 'Source System', color: 'border-blue-500/40 bg-blue-500/5' },
            null,
            { label: conn.name, sub: 'Connector', color: 'border-indigo-500/40 bg-indigo-500/5' },
            null,
            { label: deNames[0] || 'Digital Employee', sub: 'DE', color: 'border-violet-500/40 bg-violet-500/5' },
            null,
            { label: 'Customer Response', sub: '"Your status is…"', color: 'border-emerald-500/40 bg-emerald-500/5' },
          ].map((node, i) => {
            if (node === null) return <div key={i} className="text-slate-600 text-lg flex-shrink-0">→</div>;
            return (
              <div key={i} className={`flex-shrink-0 text-center px-3 py-2 rounded-lg border ${node.color}`}>
                <div className="text-xs font-medium text-white truncate max-w-[100px]">{node.label}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{node.sub}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-xs text-slate-400 font-medium mb-2">Recent query traces</p>
        <div className="space-y-1.5">
          {traces.map((trace, i) => (
            <div key={i} className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-[11px] font-mono">
              <span className="text-slate-600">[{trace.ts}] </span>
              <span className="text-violet-300">{trace.deName}</span>
              <span className="text-slate-400"> queried </span>
              <span className="text-blue-300">{trace.query}</span>
              <span className="text-slate-400"> → returned </span>
              <span className="text-emerald-300">{trace.result}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Health Dashboard Strip ─────────────────────────────────────

function HealthStrip({ connectors, accentColor, onSyncAll, syncingAll, syncAllProgress }: {
  connectors: ConnectorConfig[];
  accentColor: string;
  onSyncAll: () => void;
  syncingAll: boolean;
  syncAllProgress: number;
}) {
  const connected = connectors.filter(c => c.status === 'connected').length;
  const errors = connectors.filter(c => c.status === 'error').length;
  const totalRecords = connectors.reduce((a, c) => a + (c.recordCount || 0), 0);
  const lastSyncRaw = connectors.map(c => c.lastSync).filter(Boolean).sort().pop();
  const lastSyncLabel = lastSyncRaw ? (() => {
    const diff = Date.now() - new Date(lastSyncRaw).getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  })() : 'Never';

  const fieldMapsCount = connectors.filter(c => {
    try {
      const raw = localStorage.getItem(`dt_connector_fieldmap_${c.id}`);
      if (!raw) return false;
      const m: Record<string, FieldMapping> = JSON.parse(raw);
      return Object.values(m).some(v => v.sourceField);
    } catch { return false; }
  }).length;

  const healthStatus = errors > 0 && connected === 0 ? 'Offline' : errors > 0 ? 'Degraded' : 'Good';
  const healthColor = healthStatus === 'Good' ? 'text-emerald-400' : healthStatus === 'Degraded' ? 'text-amber-400' : 'text-rose-400';
  const healthDot = healthStatus === 'Good' ? 'bg-emerald-400' : healthStatus === 'Degraded' ? 'bg-amber-400' : 'bg-rose-400';
  const connectedCount = connectors.filter(c => c.status === 'connected').length;

  const TOTAL_CONNECTOR_TYPES = 15;
  const configuredTypes = new Set(connectors.map(c => c.type)).size;

  return (
    <div className="flex items-center gap-3 mb-6 overflow-x-auto pb-1">
      {[
        { label: 'Connected', value: connected.toString(), color: 'text-emerald-400', dot: null },
        { label: 'Errors', value: errors.toString(), color: errors > 0 ? 'text-rose-400' : 'text-slate-400', dot: null },
        { label: 'Last Sync', value: lastSyncLabel, color: 'text-slate-300', dot: null },
        { label: 'Records', value: totalRecords.toLocaleString(), color: 'text-slate-300', dot: null },
        { label: 'Field Maps', value: fieldMapsCount.toString(), color: 'text-indigo-300', dot: null },
        { label: 'Types Config\'d', value: `${configuredTypes}/${TOTAL_CONNECTOR_TYPES}`, color: 'text-slate-300', dot: null },
        { label: 'Sync Health', value: healthStatus, color: healthColor, dot: healthDot },
      ].map(s => (
        <div key={s.label} className="flex-shrink-0 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 min-w-[110px]">
          <div className={`text-lg font-bold flex items-center gap-1.5 ${s.color}`}>
            {s.dot && <div className={`w-2 h-2 rounded-full flex-shrink-0 ${s.dot}`} />}
            {s.value}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">{s.label}</div>
        </div>
      ))}
      <button onClick={onSyncAll} disabled={syncingAll} className="flex-shrink-0 px-4 py-3 text-xs font-medium text-white rounded-xl transition-all hover:opacity-90 disabled:opacity-60 flex items-center gap-2" style={{ backgroundColor: accentColor }}>
        {syncingAll ? (
          <>
            <div className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />
            {syncAllProgress}/{connectedCount}
          </>
        ) : 'Sync All'}
      </button>
    </div>
  );
}

// ── Connector Actions & Webhooks data ──────────────────────────

interface ConnectorAction {
  id: string;
  label: string;
  description: string;
  requiresApproval: boolean;
  params: string[];
}

interface ConnectorWebhook {
  event: string;
  description: string;
}

const CONNECTOR_ACTIONS: Record<string, ConnectorAction[]> = {
  zuora: [
    { id: 'create_invoice', label: 'Generate Invoice', description: 'Create a new invoice for a subscription', requiresApproval: true, params: ['subscription_id', 'amount', 'due_date'] },
    { id: 'mark_paid', label: 'Mark Invoice Paid', description: 'Record payment received and update invoice status', requiresApproval: false, params: ['invoice_id', 'payment_amount', 'payment_date'] },
    { id: 'send_payment_reminder', label: 'Send Payment Reminder', description: 'Trigger a payment reminder email via Zuora', requiresApproval: false, params: ['invoice_id', 'contact_email'] },
    { id: 'cancel_subscription', label: 'Cancel Subscription', description: 'Cancel a subscription at period end', requiresApproval: true, params: ['subscription_id', 'reason'] },
  ],
  gainsight: [
    { id: 'update_renewal_status', label: 'Update Renewal Status', description: 'Set the renewal stage in Gainsight (Renewed/Churned/At Risk)', requiresApproval: false, params: ['company_id', 'status', 'notes'] },
    { id: 'create_ctd', label: 'Create Call to Action', description: 'Create a CTA for the CSM to follow up', requiresApproval: false, params: ['company_id', 'type', 'due_date', 'priority'] },
    { id: 'log_timeline', label: 'Log Timeline Activity', description: 'Log an interaction or event to Gainsight timeline', requiresApproval: false, params: ['company_id', 'type', 'notes'] },
  ],
};

const CONNECTOR_WEBHOOKS: Record<string, ConnectorWebhook[]> = {
  zuora: [
    { event: 'payment.received', description: 'Fires when a payment is successfully processed' },
    { event: 'invoice.created', description: 'Fires when a new invoice is generated' },
    { event: 'subscription.renewal_upcoming', description: 'Fires 30/15/7 days before renewal' },
  ],
  gainsight: [
    { event: 'health_score.changed', description: 'Fires when a company health score changes significantly' },
    { event: 'renewal.approaching', description: 'Fires when renewal is within configured days' },
  ],
};

// ── Actions Tab ────────────────────────────────────────────────

function ActionsTab({ conn, accentColor, onToast }: { conn: ConnectorConfig; accentColor: string; onToast: (msg: string) => void }) {
  const actions = CONNECTOR_ACTIONS[conn.type] ?? [];
  const webhooks = CONNECTOR_WEBHOOKS[conn.type] ?? [];
  const [testModal, setTestModal] = useState<{ action: ConnectorAction; params: Record<string, string> } | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const openTest = (action: ConnectorAction) => {
    const params: Record<string, string> = {};
    action.params.forEach(p => { params[p] = ''; });
    setTestModal({ action, params });
    setTestResult(null);
  };

  const runTest = async () => {
    if (!testModal) return;
    setTesting(true);
    await new Promise(r => setTimeout(r, 1200));
    const mockResponses: Record<string, object> = {
      create_invoice: { invoice_id: 'INV-20260731-001', amount: 84420, status: 'draft', due_date: '2026-07-31', created_at: new Date().toISOString() },
      mark_paid: { invoice_id: testModal.params['invoice_id'] || 'INV-001', status: 'paid', payment_date: new Date().toISOString().split('T')[0], confirmation: 'PAY-' + Math.floor(Math.random() * 90000 + 10000) },
      send_payment_reminder: { sent: true, email: testModal.params['contact_email'] || 'billing@client.com', timestamp: new Date().toISOString() },
      cancel_subscription: { subscription_id: testModal.params['subscription_id'] || 'SUB-001', status: 'pending_cancellation', effective_date: '2026-08-01' },
      update_renewal_status: { company_id: testModal.params['company_id'] || 'CO-001', renewal_stage: testModal.params['status'] || 'Renewed', updated_at: new Date().toISOString() },
      create_ctd: { cta_id: 'CTA-' + Math.floor(Math.random() * 9000 + 1000), type: testModal.params['type'] || 'Renewal', status: 'open', created_at: new Date().toISOString() },
      log_timeline: { activity_id: 'ACT-' + Math.floor(Math.random() * 9000 + 1000), logged: true, timestamp: new Date().toISOString() },
    };
    const response = mockResponses[testModal.action.id] ?? { status: 'ok', message: 'Action simulated successfully' };
    setTestResult(JSON.stringify(response, null, 2));
    setTesting(false);
  };

  if (actions.length === 0) {
    return (
      <div className="text-center py-10 border border-dashed border-slate-800 rounded-xl">
        <p className="text-slate-500 text-sm">No actions defined for this connector.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold text-white mb-0.5">Connector Actions</p>
        <p className="text-xs text-slate-500">These actions can be triggered by Digital Employees and Playbooks.</p>
      </div>

      <div className="space-y-3">
        {actions.map(action => (
          <div key={action.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-sm font-medium text-white">{action.label}</span>
                  {action.requiresApproval
                    ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-700/30">Requires Approval</span>
                    : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700/50 text-slate-400">Auto-approved</span>
                  }
                </div>
                <p className="text-xs text-slate-400">{action.description}</p>
                {action.params.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {action.params.map(p => (
                      <span key={p} className="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-500 rounded font-mono">{p}</span>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => openTest(action)}
                className="flex-shrink-0 px-3 py-1.5 text-xs rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white transition-all"
              >
                Test Action
              </button>
            </div>
          </div>
        ))}
      </div>

      {webhooks.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Webhooks</p>
          <div className="space-y-2">
            {webhooks.map(wh => (
              <div key={wh.event} className="flex items-center justify-between gap-3 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
                <div>
                  <p className="text-xs font-mono text-indigo-300">{wh.event}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">{wh.description}</p>
                </div>
                <button
                  onClick={() => onToast('Configure endpoint: copy your webhook URL from the Sync tab')}
                  className="flex-shrink-0 px-2.5 py-1 text-[10px] rounded-lg border border-slate-700 text-slate-400 hover:border-slate-500 transition-all"
                >
                  Configure Endpoint
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Test Action Modal */}
      {testModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-950 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">Test: {testModal.action.label}</h3>
                <p className="text-xs text-slate-500 mt-0.5">Simulated — no real API call made</p>
              </div>
              <button onClick={() => { setTestModal(null); setTestResult(null); }} className="text-slate-600 hover:text-slate-400 text-xl leading-none">×</button>
            </div>
            <div className="px-5 py-4 space-y-3">
              {testModal.action.params.map(param => (
                <div key={param}>
                  <label className="text-xs text-slate-400 block mb-1 font-mono">{param}</label>
                  <input
                    value={testModal.params[param] || ''}
                    onChange={e => setTestModal(prev => prev ? { ...prev, params: { ...prev.params, [param]: e.target.value } } : null)}
                    placeholder={`Enter ${param}`}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              ))}

              {testResult && (
                <div>
                  <p className="text-xs text-emerald-400 mb-1">Response (mock)</p>
                  <pre className="text-[10px] bg-slate-900 border border-slate-800 rounded-xl p-3 text-emerald-300 font-mono overflow-x-auto">{testResult}</pre>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={runTest}
                  disabled={testing}
                  className="flex-1 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-50 transition-all"
                  style={{ backgroundColor: accentColor }}
                >
                  {testing ? 'Simulating…' : 'Run Test'}
                </button>
                <button onClick={() => { setTestModal(null); setTestResult(null); }} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Connector Detail Panel ─────────────────────────────────────

type DetailTab = 'overview' | 'schema' | 'field_map' | 'de_bindings' | 'lineage' | 'logs' | 'actions';

function ConnectorDetailPanel({
  conn, tenantId: _tenantId, accentColor, onClose, onSave, onTest, onDelete, onDuplicate, employees, onUnbind, onToast,
}: {
  conn: ConnectorConfig; tenantId: string; accentColor: string;
  onClose: () => void; onSave: (config: Record<string, string>, name: string) => void;
  onTest: (conn: ConnectorConfig) => void; onDelete: (id: string) => void;
  onDuplicate: (conn: ConnectorConfig) => void;
  employees: ReturnType<typeof useDigitalEmployees>['employees'];
  onUnbind: (deId: string, connId: string) => void;
  onToast: (msg: string) => void;
}) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const [editConfig, setEditConfig] = useState<Record<string, string>>({ ...conn.config });
  const [editName, setEditName] = useState(conn.name);
  const [expandedObject, setExpandedObject] = useState<string | null>(null);
  const [restEndpoints, setRestEndpoints] = useState<{ name: string; url: string }[]>([]);
  const [newEndpointName, setNewEndpointName] = useState('');
  const [newEndpointUrl, setNewEndpointUrl] = useState('');
  const [retryState, setRetryState] = useState<'idle' | 'waiting' | 'retrying'>('idle');
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [expandError, setExpandError] = useState(false);

  // OAuth state
  const [authMethod, setAuthMethod] = useState<'oauth' | 'manual'>(() =>
    (conn.config.oauth_connected === 'true') ? 'oauth' : 'oauth'
  );
  const [oauthModal, setOauthModal] = useState(false);
  const [oauthAuthorising, setOauthAuthorising] = useState(false);

  const provider = OAUTH_PROVIDERS[conn.type];

  const handleOAuthConnect = () => setOauthModal(true);

  const handleOAuthAuthorise = async () => {
    setOauthAuthorising(true);
    await new Promise(r => setTimeout(r, 1500));
    const now = new Date().toISOString();
    const p = OAUTH_PROVIDERS[conn.type];
    const nextConfig = {
      ...editConfig,
      oauth_connected: 'true',
      oauth_connected_at: now,
      oauth_scope: p?.scopes || '',
      oauth_account: p?.fakeAccount || conn.name,
    };
    setEditConfig(nextConfig);
    setOauthAuthorising(false);
    setOauthModal(false);
    onSave(nextConfig, editName);
    onToast(`✓ Connected to ${p?.displayName || conn.name} via OAuth`);
  };

  const handleOAuthDisconnect = () => {
    if (!window.confirm(`Disconnect ${provider?.displayName || conn.name}? This will require re-authorisation to reconnect.`)) return;
    const nextConfig = { ...editConfig };
    delete nextConfig.oauth_connected;
    delete nextConfig.oauth_connected_at;
    delete nextConfig.oauth_scope;
    delete nextConfig.oauth_account;
    setEditConfig(nextConfig);
    onSave(nextConfig, editName);
    onToast(`Disconnected from ${provider?.displayName || conn.name}`);
  };

  const handleOAuthReauthorise = () => setOauthModal(true);

  const oauthConnectedAt = editConfig.oauth_connected_at
    ? (() => {
        const diff = Date.now() - new Date(editConfig.oauth_connected_at).getTime();
        const mins = Math.round(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return `${Math.round(hrs / 24)}d ago`;
      })()
    : null;

  const logs = useMemo(() => generateEnhancedLogs(conn), [conn.id]);
  const schemaObjects = SCHEMA_OBJECTS[conn.type] ?? null;
  const schemaMessage = DEFAULT_SCHEMA_MESSAGE[conn.type] ?? null;
  const isRestLike = conn.type === 'rest_api' || conn.type === 'graphql';
  const boundDEs = employees.filter(e => (e.knowledgeSources || []).includes(conn.id));
  const meta = connectorMeta(conn.type);

  const statusDot = (s: string) =>
    s === 'connected' ? 'bg-emerald-400' : s === 'testing' ? 'bg-amber-400 animate-pulse' : s === 'error' ? 'bg-rose-400' : 'bg-slate-600';

  const handleRetry = async () => {
    const delays = [2, 4, 8];
    for (let attempt = 0; attempt < 3; attempt++) {
      setRetryAttempt(attempt + 1);
      setRetryState('waiting');
      let count = delays[attempt];
      setRetryCountdown(count);
      await new Promise<void>(resolve => {
        const iv = setInterval(() => { count--; setRetryCountdown(count); if (count <= 0) { clearInterval(iv); resolve(); } }, 1000);
      });
      setRetryState('retrying');
      await onTest(conn);
      await new Promise(r => setTimeout(r, 800));
      if (conn.status !== 'error') break;
    }
    setRetryState('idle');
    setRetryAttempt(0);
  };

  const hasActions = (CONNECTOR_ACTIONS[conn.type]?.length ?? 0) > 0;

  const TABS: { id: DetailTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'schema', label: 'Schema' },
    { id: 'field_map', label: 'Field Map' },
    { id: 'de_bindings', label: `DE Bindings${boundDEs.length > 0 ? ` (${boundDEs.length})` : ''}` },
    { id: 'lineage', label: 'Lineage' },
    { id: 'logs', label: 'Logs' },
    ...(hasActions ? [{ id: 'actions' as DetailTab, label: 'Actions' }] : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-xl bg-slate-950 border-l border-slate-800 flex flex-col shadow-2xl overflow-hidden relative">
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

        <div className="flex gap-1 px-6 pt-4 pb-0 border-b border-slate-800 overflow-x-auto">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${tab === t.id ? 'border-indigo-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
              style={tab === t.id ? { borderColor: accentColor } : {}}>
              {t.label}
            </button>
          ))}
        </div>

        {/* OAuth browser-window modal */}
        {oauthModal && provider && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-sm mx-4 rounded-xl overflow-hidden shadow-2xl border border-slate-700">
              {/* Browser chrome */}
              <div className="bg-slate-200 px-3 py-2 flex items-center gap-2">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-400" />
                  <div className="w-3 h-3 rounded-full bg-amber-400" />
                  <div className="w-3 h-3 rounded-full bg-emerald-400" />
                </div>
                <div className="flex-1 bg-white rounded px-2 py-0.5 font-mono text-[10px] text-slate-500 truncate">
                  🔒 {provider.loginDomain}/oauth2/authorize?client_id=dt_prod&scope={encodeURIComponent(provider.scopes)}&response_type=code
                </div>
              </div>
              {/* Fake login form */}
              <div className="bg-white px-6 py-6 space-y-4">
                <div className="text-center mb-2">
                  <div className={`w-12 h-12 rounded-xl mx-auto flex items-center justify-center text-white text-lg font-bold mb-3 ${connectorMeta(conn.type).avatarBg}`}>
                    {connectorMeta(conn.type).avatar}
                  </div>
                  <p className="text-sm font-semibold text-slate-800">Sign in to {provider.displayName}</p>
                  <p className="text-xs text-slate-500 mt-0.5">DreamTeam AI is requesting access</p>
                </div>
                <div>
                  <label className="text-[10px] text-slate-500 block mb-1 font-medium">Email</label>
                  <input disabled value="admin@yourcompany.com" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-400 bg-slate-50 cursor-not-allowed" />
                </div>
                <div>
                  <label className="text-[10px] text-slate-500 block mb-1 font-medium">Password</label>
                  <input disabled type="password" value="••••••••••" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-400 bg-slate-50 cursor-not-allowed" />
                </div>
                <div className="space-y-2 pt-1">
                  <button
                    onClick={handleOAuthAuthorise}
                    disabled={oauthAuthorising}
                    className="w-full py-2 text-sm font-semibold rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 transition-all disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {oauthAuthorising ? (
                      <>
                        <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Authorising…
                      </>
                    ) : `Authorise DreamTeam AI`}
                  </button>
                  <button onClick={() => setOauthModal(false)} disabled={oauthAuthorising}
                    className="w-full py-2 text-sm rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 transition-all disabled:opacity-50">
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4">

          {tab === 'overview' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Connection Name</label>
                <input value={editName} onChange={e => setEditName(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-slate-500" />
              </div>
              {/* OAuth connected banner */}
              {OAUTH_TYPES.has(conn.type) && editConfig.oauth_connected === 'true' && provider && (
                <div className="rounded-xl border border-emerald-700/50 bg-emerald-500/5 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-emerald-400" />
                      <span className="text-xs font-semibold text-emerald-300">✓ OAuth Connected</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={handleOAuthReauthorise} className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-all">Re-authorise</button>
                      <button onClick={handleOAuthDisconnect} className="text-[10px] text-rose-400 hover:text-rose-300 transition-all">Disconnect</button>
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-400">{editConfig.oauth_account || provider.fakeAccount}</p>
                  {oauthConnectedAt && <p className="text-[10px] text-slate-500">Authorised {oauthConnectedAt}</p>}
                  <div className="flex flex-wrap gap-1">
                    {(editConfig.oauth_scope || provider.scopes).split(' ').map(s => (
                      <span key={s} className="text-[9px] px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded font-mono">{s}</span>
                    ))}
                  </div>
                </div>
              )}

              <ConfigFields
                type={conn.type as ConnectorType}
                config={editConfig}
                setConfig={setEditConfig}
                authMethod={authMethod}
                setAuthMethod={setAuthMethod}
                onOAuthConnect={handleOAuthConnect}
              />
              <div className="rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2 text-xs text-slate-500">
                Credentials stored locally in your browser — never sent to our servers
              </div>
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
                {conn.recordCount > 0 && <p className="text-xs text-slate-500 mt-1">{conn.recordCount.toLocaleString()} records indexed</p>}
              </div>

              <SyncConfigSection conn={conn} accentColor={accentColor} onToast={onToast} />

              <button onClick={() => onSave(editConfig, editName)}
                className="w-full py-2 text-sm font-medium rounded-lg text-white" style={{ backgroundColor: accentColor }}>
                Save Changes
              </button>
              <button onClick={() => onDuplicate(conn)}
                className="w-full py-2 text-sm rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-all">
                Duplicate Connector
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
                      <button onClick={() => setExpandedObject(expandedObject === obj.name ? null : obj.name)}
                        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-800/50 transition-all">
                        <div className="flex items-center gap-3">
                          <div className="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-400">{obj.name.slice(0, 2)}</div>
                          <span className="text-sm font-medium text-white">{obj.name}</span>
                          <span className="text-xs text-slate-500">{obj.fields.length} fields</span>
                        </div>
                        <span className="text-slate-600 text-xs">{expandedObject === obj.name ? '▲' : '▼'}</span>
                      </button>
                      {expandedObject === obj.name && (
                        <div className="px-4 pb-3 border-t border-slate-800">
                          <div className="flex flex-wrap gap-1.5 mt-3">
                            {obj.fields.map(f => <span key={f} className="text-[10px] px-2 py-0.5 bg-slate-800 text-slate-400 rounded font-mono">{f}</span>)}
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
                    <input value={newEndpointName} onChange={e => setNewEndpointName(e.target.value)} placeholder="Endpoint name"
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-slate-500" />
                    <input value={newEndpointUrl} onChange={e => setNewEndpointUrl(e.target.value)} placeholder="/api/path"
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-slate-500" />
                    <button onClick={() => {
                      if (newEndpointName.trim() && newEndpointUrl.trim()) {
                        setRestEndpoints(prev => [...prev, { name: newEndpointName.trim(), url: newEndpointUrl.trim() }]);
                        setNewEndpointName(''); setNewEndpointUrl('');
                      }
                    }} className="px-3 py-2 text-xs font-medium rounded-lg text-white" style={{ backgroundColor: accentColor }}>+</button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-10 border border-dashed border-slate-800 rounded-xl">
                  <p className="text-slate-500 text-sm">{schemaMessage}</p>
                </div>
              )}
            </div>
          )}

          {tab === 'field_map' && <FieldMapTab conn={conn} accentColor={accentColor} />}

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
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center text-indigo-300 text-sm font-bold flex-shrink-0">{de.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white">{de.name}</div>
                    <div className="text-xs text-slate-500">{de.department}</div>
                    {de.capabilities && de.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {de.capabilities.slice(0, 3).map((cap: string) => <span key={cap} className="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded">{cap}</span>)}
                      </div>
                    )}
                  </div>
                  <button onClick={() => onUnbind(de.id, conn.id)} className="px-3 py-1.5 text-xs rounded-lg border border-slate-700 text-slate-400 hover:border-red-700 hover:text-red-400 transition-all flex-shrink-0">Unbind</button>
                </div>
              ))}
            </div>
          )}

          {tab === 'actions' && <ActionsTab conn={conn} accentColor={accentColor} onToast={onToast} />}

          {tab === 'lineage' && <LineageTab conn={conn} boundDEs={boundDEs} />}

          {tab === 'logs' && (
            <div className="space-y-1.5">
              <p className="text-xs text-slate-500 mb-3">Recent sync activity for this connector.</p>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 font-mono space-y-1">
                {logs.map((log, i) => {
                  const icon = log.level === 'success' ? '✓' : log.level === 'error' ? '✗' : '◐';
                  const color = log.level === 'success' ? 'text-emerald-400' : log.level === 'error' ? 'text-rose-400' : 'text-indigo-400';
                  return (
                    <div key={i} className="space-y-0.5">
                      <div className={`text-[11px] leading-relaxed ${color}`}>
                        <span className="text-slate-600">[{log.ts}]</span> {icon} {log.message}
                        {log.duration && <span className="text-slate-500 ml-2">· {log.duration}</span>}
                      </div>
                      {log.breakdown && <div className="text-[10px] text-slate-600 pl-4">{log.breakdown}</div>}
                      {i === 0 && log.level === 'error' && (
                        <button className="text-[10px] text-amber-400 hover:text-amber-300 mt-0.5 pl-4">Retry sync →</button>
                      )}
                    </div>
                  );
                })}
              </div>

              {conn.status === 'error' && (
                <div className="mt-4 rounded-xl border border-rose-800/50 bg-rose-500/5 p-4 space-y-2">
                  <p className="text-xs font-medium text-rose-300">Last sync failed</p>
                  {conn.errorMessage && (
                    <div>
                      <button onClick={() => setExpandError(x => !x)} className="text-[11px] text-rose-400 hover:text-rose-200 underline">
                        {expandError ? 'Hide' : 'View'} error details
                      </button>
                      {expandError && (
                        <pre className="mt-2 text-[10px] text-rose-300 bg-rose-900/20 border border-rose-800/30 rounded-lg p-3 font-mono overflow-x-auto whitespace-pre-wrap">
                          {conn.errorMessage}{'\n\nStack trace:\n  at Connector.sync (connector.ts:142)\n  at retryHandler (sync.ts:88)\n  Timeout: 30000ms exceeded'}
                        </pre>
                      )}
                    </div>
                  )}
                  {retryState === 'idle' && retryAttempt === 0 && (
                    <button onClick={handleRetry} className="px-3 py-1.5 bg-rose-700 hover:bg-rose-600 text-xs text-white rounded-lg transition-all">
                      Retry connection
                    </button>
                  )}
                  {retryState === 'waiting' && <p className="text-xs text-amber-300">Attempt {retryAttempt}/3 — Retrying in {retryCountdown}s…</p>}
                  {retryState === 'retrying' && (
                    <p className="text-xs text-amber-300 flex items-center gap-1.5">
                      <span className="w-3 h-3 border border-amber-600 border-t-amber-300 rounded-full animate-spin inline-block" />
                      Retrying… (attempt {retryAttempt}/3)
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────

const DataConnectorsPage = ({
  user, tenant, page, setPage,
}: {
  user?: AuthUser; tenant?: Tenant; page: Page; setPage: (p: Page) => void;
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
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncAllProgress, setSyncAllProgress] = useState(0);
  const [retryingConn, setRetryingConn] = useState<string | null>(null);
  const [retryCountdowns, setRetryCountdowns] = useState<Record<string, number>>({});
  const [syncAnomalies, setSyncAnomalies] = useState<Record<string, string>>({});

  useEffect(() => { setConnectors(loadConnectors(tenantId)); }, [tenantId]);

  useEffect(() => {
    if (detailConn) {
      const updated = connectors.find(c => c.id === detailConn.id);
      if (updated) setDetailConn(updated);
    }
  }, [connectors]);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 4000); };
  const persist = (updated: ConnectorConfig[]) => { setConnectors(updated); saveConnectors(tenantId, updated); };

  const handleTest = async (conn: ConnectorConfig) => {
    persist(connectors.map(c => c.id === conn.id ? { ...c, status: 'testing' } : c));
    const res = await testConnector(conn);
    persist(connectors.map(c => c.id === conn.id ? {
      ...c, status: res.ok ? 'connected' : 'error',
      lastSync: res.ok ? new Date().toISOString() : c.lastSync,
      recordCount: res.recordCount ?? c.recordCount, errorMessage: res.error,
    } : c));
  };

  const handleSync = async (conn: ConnectorConfig) => {
    setSyncing(conn.id);
    await new Promise(r => setTimeout(r, 2000));
    const isAnomaly = Math.random() < 0.1;
    if (isAnomaly && conn.recordCount > 0) {
      const dropPct = Math.floor(Math.random() * 20) + 10;
      const dropped = Math.floor(conn.recordCount * (dropPct / 100));
      persist(connectors.map(c => c.id === conn.id ? { ...c, lastSync: new Date().toISOString(), recordCount: Math.max(0, c.recordCount - dropped) } : c));
      setSyncAnomalies(prev => ({ ...prev, [conn.id]: `Sync anomaly detected: record count dropped ${dropPct}%. Review the Logs tab.` }));
      setSyncing(null);
      showToast(`Sync anomaly on ${conn.name} — record count dropped ${dropPct}%`);
    } else {
      const newCount = Math.floor(Math.random() * 50) + 1;
      persist(connectors.map(c => c.id === conn.id ? { ...c, lastSync: new Date().toISOString(), recordCount: c.recordCount + newCount } : c));
      setSyncAnomalies(prev => { const n = { ...prev }; delete n[conn.id]; return n; });
      setSyncing(null);
      showToast(`Synced ${newCount} new records from ${conn.name}`);
    }
  };

  const handleSyncAll = async () => {
    const connected = connectors.filter(c => c.status === 'connected');
    if (connected.length === 0) { showToast('No connected connectors to sync'); return; }
    setSyncingAll(true);
    setSyncAllProgress(0);
    for (let i = 0; i < connected.length; i++) {
      setSyncAllProgress(i);
      await handleSync(connected[i]);
      await new Promise(r => setTimeout(r, 300));
    }
    setSyncAllProgress(connected.length);
    setSyncingAll(false);
    showToast(`Synced all ${connected.length} connectors`);
  };

  const handleRetryCard = async (conn: ConnectorConfig) => {
    const delays = [2, 4, 8];
    setRetryingConn(conn.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      let count = delays[attempt];
      setRetryCountdowns(prev => ({ ...prev, [conn.id]: count }));
      await new Promise<void>(resolve => {
        const iv = setInterval(() => { count--; setRetryCountdowns(prev => ({ ...prev, [conn.id]: count })); if (count <= 0) { clearInterval(iv); resolve(); } }, 1000);
      });
      await handleTest(conn);
      await new Promise(r => setTimeout(r, 500));
      const latest = connectors.find(c => c.id === conn.id);
      if (latest?.status === 'connected') break;
    }
    setRetryingConn(null);
    setRetryCountdowns(prev => { const n = { ...prev }; delete n[conn.id]; return n; });
  };

  const handleAdd = () => {
    if (!selectedType || !addName.trim()) return;
    const conn: ConnectorConfig = {
      id: crypto.randomUUID(), tenantId, name: addName.trim(), type: selectedType,
      status: 'disconnected', config: addConfig, lastSync: null, recordCount: 0, createdAt: new Date().toISOString(),
    };
    persist([...connectors, conn]);
    setShowAdd(false); setAddStep(1); setSelectedType(null); setAddName(''); setAddConfig({});
    showToast(`${conn.name} added — click "Test Connection" to verify`);
  };

  const handleDetailSave = (config: Record<string, string>, name: string) => {
    if (!detailConn) return;
    persist(connectors.map(c => c.id === detailConn.id ? { ...c, config, name } : c));
    showToast('Configuration saved');
  };

  const handleDetailDelete = (id: string) => {
    persist(connectors.filter(c => c.id !== id));
    setDetailConn(null);
    showToast('Connector removed');
  };

  const handleDuplicate = (conn: ConnectorConfig) => {
    const copy: ConnectorConfig = {
      ...conn,
      id: crypto.randomUUID(),
      name: `${conn.name} (copy)`,
      status: 'disconnected',
      lastSync: null,
      recordCount: 0,
      createdAt: new Date().toISOString(),
    };
    persist([...connectors, copy]);
    showToast(`Duplicated as "${copy.name}"`);
  };

  const handleBind = async () => {
    if (!bindConnId || !bindDeId) return;
    const de = employees.find(e => e.id === bindDeId);
    if (!de) return;
    const existing = de.knowledgeSources || [];
    if (!existing.includes(bindConnId)) await update(bindDeId, { knowledgeSources: [...existing, bindConnId] });
    setBindSaved(true);
    setTimeout(() => setBindSaved(false), 3000);
  };

  const handleUnbind = async (deId: string, connId: string) => {
    const de = employees.find(e => e.id === deId);
    if (!de) return;
    await update(deId, { knowledgeSources: (de.knowledgeSources || []).filter((id: string) => id !== connId) });
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

      {connectors.length > 0 && (
        <HealthStrip connectors={connectors} accentColor={accentColor} onSyncAll={handleSyncAll} syncingAll={syncingAll} syncAllProgress={syncAllProgress} />
      )}

      {connectors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-10 text-center mb-6">
          <p className="text-slate-500 text-sm">No connectors yet. Add your first one to link a data source.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          {connectors.map(conn => {
            const meta = connectorMeta(conn.type);
            const isSyncing = syncing === conn.id;
            const isRetrying = retryingConn === conn.id;
            const countdown = retryCountdowns[conn.id];
            return (
              <div key={conn.id} className={`bg-slate-900 border rounded-xl p-5 hover:border-slate-700 transition-all ${conn.status === 'error' ? 'border-rose-800/50' : 'border-slate-800'}`}>
                {syncAnomalies[conn.id] && (
                  <div className="mb-3 flex items-start gap-2 px-3 py-2 bg-amber-500/10 border border-amber-700/40 rounded-lg">
                    <span className="text-amber-400 text-xs">&#9888;</span>
                    <span className="text-xs text-amber-300">{syncAnomalies[conn.id]}</span>
                    <button onClick={() => setSyncAnomalies(prev => { const n = { ...prev }; delete n[conn.id]; return n; })} className="ml-auto text-slate-500 hover:text-white text-sm leading-none">×</button>
                  </div>
                )}
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

                {conn.status === 'error' && conn.errorMessage && (
                  <div className="mb-3 text-xs text-rose-400 bg-rose-500/10 border border-rose-800/40 rounded-lg px-2 py-1.5 truncate">
                    {conn.errorMessage}
                  </div>
                )}

                <div className="space-y-1.5 text-xs mb-4">
                  <div className="flex justify-between text-slate-400"><span>Type</span><span className="text-slate-300 capitalize">{conn.type.replace(/_/g, ' ')}</span></div>
                  <div className="flex justify-between text-slate-400"><span>Records</span><span className="text-slate-300">{conn.recordCount > 0 ? conn.recordCount.toLocaleString() : '—'}</span></div>
                  <div className="flex justify-between text-slate-400"><span>Last sync</span><span className="text-slate-300">{conn.lastSync ? new Date(conn.lastSync).toLocaleTimeString() : '—'}</span></div>
                </div>

                <div className="flex gap-2 flex-wrap">
                  {conn.status === 'error' ? (
                    isRetrying ? (
                      <div className="flex-1 py-1.5 text-center text-xs text-amber-300">
                        {countdown > 0 ? `Retrying in ${countdown}s…` : 'Retrying…'}
                      </div>
                    ) : (
                      <button onClick={() => handleRetryCard(conn)} className="flex-1 py-1.5 bg-rose-700/30 hover:bg-rose-700/50 text-xs text-rose-300 rounded-lg transition-all border border-rose-800/40">
                        Retry
                      </button>
                    )
                  ) : (
                    <button onClick={() => handleTest(conn)} disabled={conn.status === 'testing' || isSyncing}
                      className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all disabled:opacity-50">
                      {conn.status === 'testing' ? 'Testing…' : 'Test Connection'}
                    </button>
                  )}
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
                  <button onClick={() => setDetailConn(conn)} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all">Configure</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
                      {g.types.map(t => {
                        const typeCount = connectors.filter(c => c.type === t.type && c.status === 'connected').length;
                        return (
                          <button key={t.type} onClick={() => { setSelectedType(t.type); setAddName(t.name); setAddStep(2); }}
                            className="flex items-center gap-2 p-3 rounded-xl border border-slate-700 hover:border-indigo-500 bg-slate-800 transition-all text-left">
                            <div className={`w-7 h-7 rounded-lg ${t.avatarBg} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>{t.avatar}</div>
                            <div className="flex-1 min-w-0">
                              <span className="text-xs text-slate-300 truncate block">{t.name}</span>
                              {typeCount > 0 && (
                                <span className="text-[9px] text-emerald-400">{typeCount} connected</span>
                              )}
                            </div>
                          </button>
                        );
                      })}
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

      {detailConn && (
        <ConnectorDetailPanel
          conn={detailConn} tenantId={tenantId} accentColor={accentColor}
          onClose={() => setDetailConn(null)} onSave={handleDetailSave} onTest={handleTest}
          onDelete={handleDetailDelete} onDuplicate={handleDuplicate} employees={employees} onUnbind={handleUnbind} onToast={showToast}
        />
      )}
    </div>
  );
};

export default DataConnectorsPage;
