import React, { useState } from 'react';
import type { AuthUser, Tenant } from '../../types';

type Category = 'All' | 'CRM' | 'Support' | 'HR' | 'Finance' | 'Communication' | 'Knowledge' | 'Identity' | 'Developer' | 'DE Packs';

interface Connector {
  id: string;
  name: string;
  category: Exclude<Category, 'All'>;
  description: string;
  icon: string;
  installs: number;
  rating: number;
  connected: boolean;
  featured?: boolean;
  popular?: boolean;
  dePack?: boolean;
  deCount?: number;
  tags: string[];
}

const connectors: Connector[] = [
  // DE Packs
  { id: 'dp1', name: 'Financial Services Pack', category: 'DE Packs', description: '6 pre-configured Digital Employees for banking, insurance, and wealth management — compliance-ready out of the box.', icon: '🏦', installs: 840, rating: 4.9, connected: false, featured: true, dePack: true, deCount: 6, tags: ['banking', 'compliance', 'fintech'] },
  { id: 'dp2', name: 'SaaS Customer Success Pack', category: 'DE Packs', description: '5 Digital Employees for B2B SaaS — renewal management, onboarding, support triage, QBR prep, and churn prediction.', icon: '★', installs: 1240, rating: 4.8, connected: false, featured: true, dePack: true, deCount: 5, tags: ['saas', 'cs', 'retention'] },
  { id: 'dp3', name: 'HR & People Operations Pack', category: 'DE Packs', description: '4 Digital Employees covering recruitment, onboarding, policy Q&A, and performance management.', icon: '◉', installs: 680, rating: 4.7, connected: false, dePack: true, deCount: 4, tags: ['hr', 'hiring', 'people'] },
  { id: 'dp4', name: 'Legal & Compliance Pack', category: 'DE Packs', description: '3 Digital Employees for contract review, policy monitoring, and regulatory change detection.', icon: '⚖', installs: 320, rating: 4.6, connected: false, dePack: true, deCount: 3, tags: ['legal', 'compliance', 'gdpr'] },
  { id: 'dp5', name: 'E-commerce Operations Pack', category: 'DE Packs', description: '5 Digital Employees for order management, returns, inventory queries, and customer service automation.', icon: '⊞', installs: 920, rating: 4.8, connected: false, popular: true, dePack: true, deCount: 5, tags: ['ecommerce', 'retail', 'orders'] },

  // CRM
  { id: 'c1', name: 'Salesforce', category: 'CRM', description: 'Sync customers, leads, opportunities, and account activity. DEs can update records and trigger workflows.', icon: '☁', installs: 4820, rating: 4.7, connected: true, popular: true, tags: ['crm', 'sales', 'leads'] },
  { id: 'c2', name: 'HubSpot', category: 'CRM', description: 'CRM contacts, deals, and email sequences. DEs qualify leads and push updates automatically.', icon: '⊕', installs: 3140, rating: 4.6, connected: false, popular: true, tags: ['crm', 'marketing', 'deals'] },
  { id: 'c3', name: 'Pipedrive', category: 'CRM', description: 'Pipeline management and activity tracking. Ideal for sales-focused Digital Employees.', icon: '⊃', installs: 890, rating: 4.4, connected: false, tags: ['crm', 'pipeline'] },

  // Support
  { id: 's1', name: 'Zendesk', category: 'Support', description: 'Bidirectional ticket sync. DEs resolve tickets, escalate edge cases, and index resolved conversations into the KB.', icon: '⊘', installs: 5100, rating: 4.8, connected: true, popular: true, tags: ['support', 'tickets', 'helpdesk'] },
  { id: 's2', name: 'Intercom', category: 'Support', description: 'AI answers in the Intercom live chat widget. Seamless handoff to human agents when confidence is low.', icon: '◇', installs: 2300, rating: 4.6, connected: false, featured: true, tags: ['chat', 'live support'] },
  { id: 's3', name: 'Freshdesk', category: 'Support', description: 'Ticket management and customer contact sync. Auto-resolve common queries with DE responses.', icon: '◈', installs: 1420, rating: 4.3, connected: false, tags: ['support', 'tickets'] },
  { id: 's4', name: 'Jira Service Management', category: 'Support', description: 'ITSM ticket creation, SLA tracking, and DE-assisted triage for IT and internal helpdesk teams.', icon: '◆', installs: 1870, rating: 4.5, connected: false, tags: ['itsm', 'it', 'helpdesk'] },

  // Knowledge
  { id: 'k1', name: 'Confluence', category: 'Knowledge', description: 'Auto-sync wiki pages and spaces to the Knowledge Hub. Changes trigger automatic re-embedding.', icon: '◎', installs: 3890, rating: 4.7, connected: true, popular: true, tags: ['wiki', 'docs', 'kb'] },
  { id: 'k2', name: 'Notion', category: 'Knowledge', description: 'Sync Notion pages, databases, and linked resources to the KB. Keeps your team wiki and AI in sync.', icon: '▣', installs: 2100, rating: 4.5, connected: false, featured: true, tags: ['notes', 'wiki', 'kb'] },
  { id: 'k3', name: 'Google Drive', category: 'Knowledge', description: 'Index Drive documents, Docs, and Sheets into the Knowledge Hub. Monitors for changes automatically.', icon: '△', installs: 4200, rating: 4.6, connected: true, popular: true, tags: ['docs', 'storage'] },
  { id: 'k4', name: 'SharePoint', category: 'Knowledge', description: 'Microsoft SharePoint and OneDrive document sync. Essential for Microsoft-first organisations.', icon: '◰', installs: 1650, rating: 4.3, connected: false, tags: ['microsoft', 'docs'] },
  { id: 'k5', name: 'GitHub', category: 'Knowledge', description: 'Index README files, wikis, and docs from repos. Keeps technical KB aligned with your codebase.', icon: '⊛', installs: 980, rating: 4.4, connected: false, tags: ['developer', 'docs', 'code'] },

  // Communication
  { id: 'comm1', name: 'Slack', category: 'Communication', description: 'AI notifications, approval requests, and slash commands via Slack. DEs post summaries and alerts.', icon: '#', installs: 5600, rating: 4.9, connected: true, popular: true, tags: ['slack', 'notifications', 'approvals'] },
  { id: 'comm2', name: 'Microsoft Teams', category: 'Communication', description: 'Adaptive card approvals, DE alerts, and conversational AI directly in Microsoft Teams.', icon: '⊠', installs: 3200, rating: 4.6, connected: false, featured: true, tags: ['microsoft', 'notifications'] },
  { id: 'comm3', name: 'Email (SMTP/IMAP)', category: 'Communication', description: 'DE-triggered outbound emails and inbound email parsing. Turn emails into structured actions.', icon: '✉', installs: 2800, rating: 4.5, connected: true, tags: ['email', 'outreach'] },

  // Finance
  { id: 'f1', name: 'Stripe', category: 'Finance', description: 'Payment status, subscription lookups, refund actions, and invoice generation for DEs.', icon: '$', installs: 3100, rating: 4.7, connected: true, popular: true, tags: ['payments', 'billing'] },
  { id: 'f2', name: 'QuickBooks', category: 'Finance', description: 'Invoice creation, expense categorisation, and financial reporting via Digital Employees.', icon: '◐', installs: 980, rating: 4.3, connected: false, tags: ['accounting', 'invoices'] },
  { id: 'f3', name: 'Xero', category: 'Finance', description: 'Accounts receivable, payable, and bank reconciliation. Finance DE can flag exceptions automatically.', icon: '✕', installs: 740, rating: 4.4, connected: false, tags: ['accounting', 'reconciliation'] },

  // HR
  { id: 'hr1', name: 'Workday', category: 'HR', description: 'Employee data, org structure, and HR processes. Onboarding DEs read and update Workday records.', icon: '◉', installs: 1240, rating: 4.5, connected: false, tags: ['hr', 'hris', 'employees'] },
  { id: 'hr2', name: 'BambooHR', category: 'HR', description: 'Employee records, leave management, and performance data for HR Digital Employees.', icon: '◈', installs: 870, rating: 4.4, connected: false, popular: true, tags: ['hr', 'leave', 'performance'] },
  { id: 'hr3', name: 'Greenhouse', category: 'HR', description: 'Recruitment pipeline and applicant tracking. Recruiting DE can screen CVs and schedule interviews.', icon: '◑', installs: 560, rating: 4.3, connected: false, tags: ['recruiting', 'ats'] },

  // Identity
  { id: 'id1', name: 'Okta', category: 'Identity', description: 'SSO authentication and user provisioning. DEs can reset passwords and unlock accounts safely.', icon: '⊙', installs: 2100, rating: 4.7, connected: false, popular: true, tags: ['sso', 'identity', 'security'] },
  { id: 'id2', name: 'Azure Active Directory', category: 'Identity', description: 'Microsoft identity management, group sync, and conditional access policy support.', icon: '⊗', installs: 1800, rating: 4.5, connected: false, tags: ['microsoft', 'sso', 'identity'] },
  { id: 'id3', name: 'Google Workspace', category: 'Identity', description: 'Google SSO, user directory sync, and Gmail/Calendar access for DE workflows.', icon: '◒', installs: 2400, rating: 4.6, connected: false, featured: true, tags: ['google', 'sso', 'directory'] },

  // Developer
  { id: 'dev1', name: 'Webhook (Inbound)', category: 'Developer', description: 'Receive events from any system and trigger DE workflows programmatically.', icon: '↯', installs: 3200, rating: 4.8, connected: true, popular: true, tags: ['api', 'events', 'automation'] },
  { id: 'dev2', name: 'REST API', category: 'Developer', description: 'Full programmatic access to DreamTeam — create conversations, trigger DEs, query the KB.', icon: '{ }', installs: 2900, rating: 4.9, connected: true, tags: ['api', 'developer'] },
  { id: 'dev3', name: 'Datadog', category: 'Developer', description: 'System health and performance monitoring. DEs can alert on anomalies and create incident tickets.', icon: '⊛', installs: 640, rating: 4.4, connected: false, tags: ['monitoring', 'observability'] },
];

const CATEGORY_ICONS: Record<string, string> = {
  'All': '⊞', 'DE Packs': '⚡', 'CRM': '◎', 'Support': '⊘', 'Knowledge': '◈',
  'Communication': '#', 'Finance': '$', 'HR': '◉', 'Identity': '⊙', 'Developer': '{ }',
};

const ConnectorMarketplacePage = ({ user, tenant }: { user?: AuthUser; tenant?: Tenant }) => {
  const accent = tenant?.primaryColor || '#6366f1';
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<Category>('All');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connected, setConnected] = useState<Set<string>>(
    () => new Set(connectors.filter(c => c.connected).map(c => c.id))
  );

  const categories: Category[] = ['All', 'DE Packs', 'CRM', 'Support', 'Knowledge', 'Communication', 'Finance', 'HR', 'Identity', 'Developer'];

  const filtered = connectors.filter(c =>
    (category === 'All' || c.category === category) &&
    (!search || c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.description.toLowerCase().includes(search.toLowerCase()) ||
      c.tags.some(t => t.includes(search.toLowerCase())))
  );

  const featured = filtered.filter(c => c.featured && !connected.has(c.id)).slice(0, 3);
  const connectedList = filtered.filter(c => connected.has(c.id));
  const available = filtered.filter(c => !connected.has(c.id) && !c.featured);

  const handleConnect = async (id: string) => {
    setConnecting(id);
    await new Promise(r => setTimeout(r, 1200));
    setConnected(prev => new Set([...prev, id]));
    setConnecting(null);
  };

  const handleDisconnect = (id: string) => {
    setConnected(prev => { const n = new Set(prev); n.delete(id); return n; });
  };

  const totalConnected = connected.size;
  const dePacks = connectors.filter(c => c.dePack && connected.has(c.id)).length;

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Connector Marketplace</h1>
          <p className="text-slate-400 text-sm mt-1">Connect your tools and deploy pre-built Digital Employee packs</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-sm font-semibold text-white">{totalConnected} connected</div>
            <div className="text-xs text-slate-500">{dePacks} DE packs installed</div>
          </div>
          <div className="w-px h-8 bg-slate-700" />
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white"
            style={{ backgroundColor: accent + '40', color: accent }}>
            {totalConnected}
          </div>
        </div>
      </div>

      {/* Search + Category */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">⊕</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search connectors, categories, or use-cases…"
            className="w-full pl-8 pr-4 bg-slate-800 border border-slate-700 rounded-xl py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div className="flex gap-1 bg-slate-800 rounded-xl p-1 overflow-x-auto flex-wrap">
          {categories.map(cat => (
            <button key={cat} onClick={() => setCategory(cat)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all flex items-center gap-1 ${
                category === cat ? 'text-white' : 'text-slate-400 hover:text-white'
              }`}
              style={category === cat ? { backgroundColor: accent } : {}}>
              <span>{CATEGORY_ICONS[cat]}</span> {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Connected */}
      {connectedList.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-emerald-400 rounded-full" /> Connected ({connectedList.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {connectedList.map(c => (
              <div key={c.id} className="bg-slate-900 border border-emerald-500/20 rounded-xl p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-lg flex-shrink-0">{c.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-white truncate">{c.name}</div>
                  <div className="text-xs text-emerald-400">Connected</div>
                </div>
                <button onClick={() => handleDisconnect(c.id)}
                  className="text-xs text-slate-600 hover:text-red-400 transition-all flex-shrink-0">✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Featured */}
      {featured.length > 0 && !search && (
        <div className="mb-8">
          <h2 className="text-sm font-semibold text-white mb-3">Featured</h2>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {featured.map(c => (
              <div key={c.id} className="bg-slate-900 border border-slate-700 rounded-xl p-5 relative overflow-hidden"
                style={{ borderColor: accent + '40' }}>
                <div className="absolute top-3 right-3 text-xs px-2 py-0.5 rounded-full text-white font-medium"
                  style={{ backgroundColor: accent }}>Featured</div>
                <div className="flex items-start gap-3 mb-3">
                  <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center text-2xl flex-shrink-0">{c.icon}</div>
                  <div>
                    <div className="text-sm font-semibold text-white">{c.name}</div>
                    <div className="text-xs text-slate-500">{c.category}{c.dePack ? ` · ${c.deCount} DEs included` : ''}</div>
                  </div>
                </div>
                <p className="text-xs text-slate-400 mb-4 leading-relaxed">{c.description}</p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span>★ {c.rating}</span>
                    <span>{c.installs.toLocaleString()} installs</span>
                  </div>
                  <button onClick={() => handleConnect(c.id)}
                    disabled={connecting === c.id}
                    className="text-xs px-3 py-1.5 rounded-lg text-white disabled:opacity-60 transition-all"
                    style={{ backgroundColor: accent }}>
                    {connecting === c.id ? 'Connecting…' : c.dePack ? 'Install Pack' : 'Connect'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All available */}
      {available.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-white mb-3">
            {search ? `Results for "${search}"` : category === 'All' ? 'All Connectors' : category}
            <span className="text-slate-500 font-normal ml-2">({available.length})</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {available.map(c => (
              <div key={c.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all group">
                <div className="flex items-start gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-xl flex-shrink-0">{c.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-semibold text-white">{c.name}</span>
                      {c.popular && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">Popular</span>}
                      {c.dePack && <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400">DE Pack</span>}
                    </div>
                    <div className="text-xs text-slate-500">{c.category}{c.dePack ? ` · ${c.deCount} DEs` : ''}</div>
                  </div>
                </div>
                <p className="text-xs text-slate-400 mb-4 line-clamp-2 leading-relaxed">{c.description}</p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span>★ {c.rating}</span>
                    <span>{c.installs >= 1000 ? `${(c.installs / 1000).toFixed(1)}K` : c.installs}</span>
                  </div>
                  <button onClick={() => handleConnect(c.id)}
                    disabled={connecting === c.id}
                    className="text-xs px-3 py-1.5 rounded-lg transition-all disabled:opacity-60 opacity-0 group-hover:opacity-100 text-white"
                    style={{ backgroundColor: accent }}>
                    {connecting === c.id ? 'Connecting…' : c.dePack ? 'Install Pack' : 'Connect'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {filtered.length === 0 && (
        <div className="text-center py-16 bg-slate-900 border border-slate-800 rounded-xl">
          <div className="text-3xl mb-3">⊕</div>
          <div className="text-sm font-medium text-white mb-1">No connectors found</div>
          <div className="text-xs text-slate-500">Try a different search term or category</div>
        </div>
      )}
    </div>
  );
};

export default ConnectorMarketplacePage;
