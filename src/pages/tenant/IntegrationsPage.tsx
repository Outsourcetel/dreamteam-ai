import React, { useState } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { Badge, Modal, PageTabs, ADMIN_TABS } from '../../components';

const IntegrationsPage = ({
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
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [showAddModal, setShowAddModal] = useState(false);

  const integrations = [
    { name: 'Slack', cat: 'Communication', connected: true, desc: 'AI notifications, approvals and commands via Slack' },
    { name: 'Microsoft Teams', cat: 'Communication', connected: false, desc: 'Agent alerts and approvals directly in Teams' },
    { name: 'Zendesk', cat: 'Support', connected: true, desc: 'Sync tickets and conversations bidirectionally' },
    { name: 'Intercom', cat: 'Support', connected: false, desc: 'AI answers in Intercom live chat widget' },
    { name: 'Salesforce', cat: 'CRM', connected: true, desc: 'Sync customers, leads, and account activity' },
    { name: 'HubSpot', cat: 'CRM', connected: false, desc: 'CRM contacts and deals sync with AI agents' },
    { name: 'Stripe', cat: 'Payments', connected: true, desc: 'Billing lookups and payment status for agents' },
    { name: 'QuickBooks', cat: 'Accounting', connected: false, desc: 'Invoice generation and financial data access' },
    { name: 'Jira', cat: 'Project', connected: false, desc: 'Ticket creation and issue tracking integration' },
    { name: 'Confluence', cat: 'Knowledge', connected: true, desc: 'Auto-sync wiki pages to Knowledge Hub' },
    { name: 'Notion', cat: 'Knowledge', connected: false, desc: 'Sync Notion pages and databases to KB' },
    { name: 'Google Drive', cat: 'Storage', connected: true, desc: 'Index Drive documents into the Knowledge Hub' },
    { name: 'Okta', cat: 'Identity', connected: false, desc: 'SSO authentication and user provisioning' },
    { name: 'Azure AD', cat: 'Identity', connected: false, desc: 'Microsoft identity management and SSO' },
    { name: 'Workday', cat: 'HR', connected: false, desc: 'Employee data and HR processes integration' },
    { name: 'BambooHR', cat: 'HR', connected: false, desc: 'HR records sync for onboarding agents' },
    { name: 'Webhook', cat: 'Developer', connected: true, desc: 'Custom webhook events for agent triggers' },
    { name: 'REST API', cat: 'Developer', connected: true, desc: 'Full API access for custom integrations' },
    { name: 'GitHub', cat: 'Developer', connected: false, desc: 'Sync READMEs and docs to Knowledge Hub' },
    { name: 'Datadog', cat: 'Monitoring', connected: false, desc: 'System health and performance monitoring' },
  ];

  const categories = ['All', ...Array.from(new Set(integrations.map((i) => i.cat)))];
  const filtered = integrations.filter(
    (i) =>
      (category === 'All' || i.cat === category) &&
      i.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={ADMIN_TABS} page={page} setPage={setPage} accentColor={accentColor} />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Integrations</h1>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 mt-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs">
            Demo data — connection states are illustrative
          </span>
          <p className="text-slate-400 text-sm mt-1">
            Connect your tools to extend agent capabilities and data access
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
          style={{ backgroundColor: accentColor }}
        >
          + Add Integration
        </button>
      </div>
      <div className="flex gap-4 mb-5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search integrations..."
          className="flex-1 max-w-sm bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
        />
        <div className="flex gap-1 bg-slate-800 rounded-xl p-1 overflow-x-auto">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                category === c ? 'text-white' : 'text-slate-400 hover:text-white'
              }`}
              style={category === c ? { backgroundColor: accentColor } : {}}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map((intg, i) => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-medium text-white">{intg.name}</div>
                <Badge label={intg.cat} color="slate" />
              </div>
              {intg.connected && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
            </div>
            <p className="text-xs text-slate-400 mb-3 leading-relaxed">{intg.desc}</p>
            <button
              className={`w-full py-1.5 rounded-lg text-xs font-medium transition-all ${
                intg.connected
                  ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                  : 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'
              }`}
            >
              {intg.connected ? 'v Connected' : 'Connect'}
            </button>
          </div>
        ))}
      </div>
      {showAddModal && (
        <Modal title="Add Custom Integration" onClose={() => setShowAddModal(false)}>
          <div className="space-y-4">
            {[
              { label: 'Integration Name', placeholder: 'My Custom API', type: 'text' },
              { label: 'Webhook URL', placeholder: 'https://api.yourapp.com/webhook', type: 'text' },
              { label: 'API Key', placeholder: 'sk-...', type: 'password' },
            ].map((f, i) => (
              <div key={i}>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">{f.label}</label>
                <input
                  type={f.type}
                  placeholder={f.placeholder}
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
            ))}
            <button
              className="w-full py-2.5 text-white text-sm font-medium rounded-xl"
              style={{ backgroundColor: accentColor }}
            >
              Save Integration
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default IntegrationsPage;
