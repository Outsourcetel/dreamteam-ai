import React, { useState } from 'react';
import type { AuthUser, Tenant, Page, KnowledgeItemType, ConnectorCategory, ConnectorStatus, FieldPermission, KnowledgeItem, RegisteredConnector } from '../../types';
import { PageTabs } from '../../components';
import { StatCard } from '../../components';
import {
  knowledgeTaxonomy,
  knowledgeTags,
  mockKnowledgeItems,
  mockImportedFiles,
  registeredConnectors,
} from './AgentWorkforcePage';

const HUB_TABS: { id: Page; label: string }[] = [
  { id: 'hub_overview', label: 'Overview' },
  { id: 'hub_articles', label: 'Articles' },
  { id: 'knowledge_taxonomy', label: 'Taxonomy' },
  { id: 'hub_ingestion', label: 'Ingestion' },
  { id: 'knowledge_connectors', label: 'Connectors' },
  { id: 'knowledge_files', label: 'Files' },
  { id: 'hub_training', label: 'Training' },
  { id: 'hub_analytics', label: 'Analytics' },
];

const KnowledgeDataPage = ({
  user,
  tenant,
  page,
  setPage,
  accentColor = '#6366f1',
}: {
  user: AuthUser | null;
  tenant?: Tenant;
  page: Page;
  setPage: (p: Page) => void;
  accentColor?: string;
}) => {
  const subPage =
    page === 'knowledge_data'
      ? 'overview'
      : page === 'knowledge_taxonomy'
      ? 'taxonomy'
      : page === 'knowledge_connectors'
      ? 'connectors'
      : page === 'knowledge_files'
      ? 'files'
      : 'overview';

  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  const [selectedModule, setSelectedModule] = useState<string | null>(null);
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [selectedSubSection, setSelectedSubSection] = useState<string | null>(null);
  const [kbSearch, setKbSearch] = useState('');
  const [audienceFilter, setAudienceFilter] = useState<'All' | 'Customer' | 'Internal' | 'Both'>('All');
  const [typeFilter, setTypeFilter] = useState<'all' | KnowledgeItemType>('all');
  const [selectedConnector, setSelectedConnector] = useState<RegisteredConnector | null>(null);
  const [selectedAgent, setSelectedConnectorAgent] = useState<string>('all');

  const filteredItems = mockKnowledgeItems.filter((item) => {
    const matchSearch =
      !kbSearch ||
      item.title.toLowerCase().includes(kbSearch.toLowerCase()) ||
      item.summary.toLowerCase().includes(kbSearch.toLowerCase()) ||
      item.tags.some((t) => t.includes(kbSearch.toLowerCase()));
    const matchAudience = audienceFilter === 'All' || item.audience === audienceFilter;
    const matchType = typeFilter === 'all' || item.type === typeFilter;
    const matchProduct = !selectedProduct || item.productId === selectedProduct;
    const matchModule = !selectedModule || item.moduleId === selectedModule;
    const matchSection = !selectedSection || item.sectionId === selectedSection;
    const matchSubSection = !selectedSubSection || item.subSectionId === selectedSubSection;
    return matchSearch && matchAudience && matchType && matchProduct && matchModule && matchSection && matchSubSection;
  });

  const getTaxBreadcrumb = (item: KnowledgeItem) => {
    const prod = knowledgeTaxonomy.find((p) => p.id === item.productId);
    const mod = prod?.modules.find((m) => m.id === item.moduleId);
    const sec = mod?.sections.find((s) => s.id === item.sectionId);
    const sub = sec?.subSections.find((ss) => ss.id === item.subSectionId);
    return [prod?.label, mod?.label, sec?.label, sub?.label].filter(Boolean).join(' › ');
  };

  const typeColors: Record<string, string> = {
    article: 'bg-blue-900 text-blue-300',
    release_note: 'bg-purple-900 text-purple-300',
    resolved_ticket: 'bg-emerald-900 text-emerald-300',
    file: 'bg-yellow-900 text-yellow-300',
    video: 'bg-red-900 text-red-300',
    policy: 'bg-orange-900 text-orange-300',
  };

  const audienceColors: Record<string, string> = {
    Customer: 'bg-indigo-900 text-indigo-300',
    Internal: 'bg-slate-700 text-slate-300',
    Both: 'bg-teal-900 text-teal-300',
  };

  const embedColors: Record<string, string> = {
    indexed: 'text-emerald-400',
    pending: 'text-yellow-400',
    failed: 'text-red-400',
    stale: 'text-orange-400',
  };

  const catColors: Record<ConnectorCategory, string> = {
    crm: 'bg-blue-900 text-blue-300',
    billing: 'bg-emerald-900 text-emerald-300',
    hr: 'bg-purple-900 text-purple-300',
    support: 'bg-orange-900 text-orange-300',
    analytics: 'bg-yellow-900 text-yellow-300',
    storage: 'bg-slate-700 text-slate-300',
    communication: 'bg-indigo-900 text-indigo-300',
    custom: 'bg-red-900 text-red-300',
  };

  // ---- OVERVIEW ----
  if (subPage === 'overview') {
    const totalChunks =
      mockKnowledgeItems.reduce((s, i) => s + i.chunkCount, 0) +
      mockImportedFiles.filter((f) => f.status === 'indexed').reduce((s, f) => s + f.chunkCount, 0);
    const indexedItems = mockKnowledgeItems.filter((i) => i.embedStatus === 'indexed').length;
    const staleItems = mockKnowledgeItems.filter((i) => i.freshnessScore < 80).length;
    const connectedDCs = registeredConnectors.filter((c) => c.status === 'connected').length;
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageTabs tabs={HUB_TABS} page={page} setPage={setPage} accentColor={accentColor} />
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Knowledge &amp; Data</h1>
          <p className="text-slate-400 text-sm mt-1">
            Centralised knowledge taxonomy, connector registry, and file store — powering every agent's RAG pipeline
          </p>
        </div>
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard label="Knowledge Articles" value={String(mockKnowledgeItems.length)} icon="≡" color="indigo" />
          <StatCard label="Vector Chunks Indexed" value={String(totalChunks.toLocaleString())} icon="⊟" color="emerald" />
          <StatCard label="Data Connectors" value={String(connectedDCs) + '/' + registeredConnectors.length} icon="⇄" color="blue" />
          <StatCard label="Imported Files" value={String(mockImportedFiles.length)} icon="▤" color="purple" />
        </div>
        <div className="grid grid-cols-3 gap-4 mb-6">
          {knowledgeTaxonomy.map((prod) => {
            const items = mockKnowledgeItems.filter((i) => i.productId === prod.id);
            const indexed = items.filter((i) => i.embedStatus === 'indexed').length;
            const custItems = items.filter((i) => i.audience === 'Customer' || i.audience === 'Both').length;
            const intItems = items.filter((i) => i.audience === 'Internal' || i.audience === 'Both').length;
            return (
              <div
                key={prod.id}
                className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors cursor-pointer"
                onClick={() => { setSelectedProduct(prod.id); setPage('knowledge_taxonomy'); }}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: prod.color }} />
                  <span className="text-white font-semibold text-sm">{prod.label}</span>
                </div>
                <div className="text-2xl font-bold text-white mb-1">{items.length}</div>
                <div className="text-xs text-slate-500 mb-3">articles across {prod.modules.length} modules</div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-slate-800 rounded-full h-1.5">
                      <div className="bg-indigo-500 h-1.5 rounded-full" style={{ width: items.length ? (custItems / items.length) * 100 + '%' : '0%' }} />
                    </div>
                    <span className="text-xs text-slate-500 w-24">Customer: {custItems}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-slate-800 rounded-full h-1.5">
                      <div className="bg-purple-500 h-1.5 rounded-full" style={{ width: items.length ? (intItems / items.length) * 100 + '%' : '0%' }} />
                    </div>
                    <span className="text-xs text-slate-500 w-24">Internal: {intItems}</span>
                  </div>
                </div>
                <div className="mt-3 text-xs text-emerald-400">{indexed}/{items.length} indexed</div>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="text-sm font-semibold text-white mb-3">Tag Cloud</div>
            <div className="flex flex-wrap gap-2">
              {knowledgeTags.map((tag) => {
                const count = mockKnowledgeItems.filter((i) => i.tags.includes(tag.label)).length;
                return (
                  <span key={tag.id} className="px-2 py-1 bg-slate-800 text-slate-300 rounded-full text-xs cursor-pointer hover:bg-indigo-900 hover:text-indigo-300 transition-colors">
                    {tag.label} <span className="text-slate-500">{count}</span>
                  </span>
                );
              })}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="text-sm font-semibold text-white mb-3">Data Connector Health</div>
            <div className="space-y-2">
              {registeredConnectors.map((dc) => (
                <div key={dc.id} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300">{dc.icon}</div>
                  <div className="flex-1">
                    <div className="text-xs text-white">{dc.name}</div>
                    <div className="text-xs text-slate-500">Synced {dc.lastSync}</div>
                  </div>
                  <span className={dc.status === 'connected' ? 'text-emerald-400 text-xs' : 'text-red-400 text-xs'}>{dc.status}</span>
                  <span className={`px-1.5 py-0.5 rounded text-xs ${catColors[dc.category]}`}>{dc.category}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- TAXONOMY BROWSER ----
  if (subPage === 'taxonomy') {
    return (
      <div className="flex-1 overflow-hidden bg-slate-950 flex flex-col">
        <div className="px-6 pt-6"><PageTabs tabs={HUB_TABS} page={page} setPage={setPage} accentColor={accentColor} /></div>
        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 flex-shrink-0 border-r border-slate-800 overflow-y-auto p-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Taxonomy Tree</div>
            <button
              onClick={() => { setSelectedProduct(null); setSelectedModule(null); setSelectedSection(null); setSelectedSubSection(null); }}
              className={`w-full text-left px-2 py-1 rounded text-xs mb-2 ${!selectedProduct ? 'bg-indigo-900 text-indigo-300' : 'text-slate-400 hover:text-white'}`}
            >
              All Products ({mockKnowledgeItems.length})
            </button>
            {knowledgeTaxonomy.map((prod) => (
              <div key={prod.id} className="mb-2">
                <button
                  onClick={() => { setSelectedProduct(prod.id === selectedProduct ? null : prod.id); setSelectedModule(null); setSelectedSection(null); setSelectedSubSection(null); }}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 ${selectedProduct === prod.id ? 'text-white font-medium' : 'text-slate-400 hover:text-white'}`}
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: prod.color }} />
                  {prod.label}
                  <span className="ml-auto text-slate-600">{mockKnowledgeItems.filter((i) => i.productId === prod.id).length}</span>
                </button>
                {selectedProduct === prod.id && prod.modules.map((mod) => (
                  <div key={mod.id} className="ml-4">
                    <button
                      onClick={() => { setSelectedModule(mod.id === selectedModule ? null : mod.id); setSelectedSection(null); setSelectedSubSection(null); }}
                      className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1 ${selectedModule === mod.id ? 'text-indigo-300 font-medium' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      <span className="text-slate-700">{selectedModule === mod.id ? 'v' : '>'}</span>
                      {mod.label}
                      <span className="ml-auto text-slate-700">{mockKnowledgeItems.filter((i) => i.moduleId === mod.id).length}</span>
                    </button>
                    {selectedModule === mod.id && mod.sections.map((sec) => (
                      <div key={sec.id} className="ml-3">
                        <button
                          onClick={() => { setSelectedSection(sec.id === selectedSection ? null : sec.id); setSelectedSubSection(null); }}
                          className={`w-full text-left px-2 py-0.5 rounded text-xs flex items-center gap-1 ${selectedSection === sec.id ? 'text-teal-300' : 'text-slate-600 hover:text-slate-400'}`}
                        >
                          <span>{selectedSection === sec.id ? '-' : '+'}</span>
                          {sec.label}
                        </button>
                        {selectedSection === sec.id && sec.subSections.map((ss) => (
                          <button
                            key={ss.id}
                            onClick={() => setSelectedSubSection(ss.id === selectedSubSection ? null : ss.id)}
                            className={`w-full text-left px-3 py-0.5 rounded text-xs flex items-center ml-2 ${selectedSubSection === ss.id ? 'text-yellow-300' : 'text-slate-700 hover:text-slate-500'}`}
                          >
                            <span className="mr-1 text-slate-800">-</span>
                            {ss.label}
                            <span className="ml-auto text-slate-800">{ss.articleCount}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="flex-1 overflow-auto p-6">
            <div className="flex gap-3 mb-5 flex-wrap">
              <input
                value={kbSearch}
                onChange={(e) => setKbSearch(e.target.value)}
                placeholder="Search articles, tags, summaries..."
                className="flex-1 min-w-48 bg-slate-900 border border-slate-700 text-white text-sm rounded-xl px-4 py-2 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              {(['All', 'Customer', 'Internal', 'Both'] as const).map((a) => (
                <button
                  key={a}
                  onClick={() => setAudienceFilter(a)}
                  className={`px-3 py-2 rounded-xl text-xs font-medium transition-colors ${audienceFilter === a ? 'text-white' : 'bg-slate-900 text-slate-400 border border-slate-700'}`}
                  style={audienceFilter === a ? { backgroundColor: accentColor } : {}}
                >
                  {a}
                </button>
              ))}
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
                className="bg-slate-900 border border-slate-700 text-slate-300 text-xs rounded-xl px-3 py-2 focus:outline-none"
              >
                <option value="all">All Types</option>
                <option value="article">Article</option>
                <option value="release_note">Release Note</option>
                <option value="resolved_ticket">Resolved Ticket</option>
                <option value="file">File</option>
                <option value="policy">Policy</option>
              </select>
            </div>
            <div className="text-xs text-slate-500 mb-4">{filteredItems.length} items</div>
            <div className="space-y-3">
              {filteredItems.map((item) => (
                <div key={item.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors">
                  <div className="flex items-start gap-3 mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${typeColors[item.type] || 'bg-slate-700 text-slate-300'}`}>{item.type.replace(/_/g, ' ')}</span>
                        <span className={`px-2 py-0.5 rounded text-xs ${audienceColors[item.audience]}`}>{item.audience}</span>
                        <span className={`text-xs ${embedColors[item.embedStatus]}`}>{item.embedStatus}</span>
                        <span className="text-xs text-slate-600">{item.chunkCount} chunks</span>
                      </div>
                      <div className="text-sm font-semibold text-white mb-1">{item.title}</div>
                      <div className="text-xs text-slate-500 mb-2">{item.summary}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-xs text-slate-600">v{item.version}</div>
                      <div className="text-xs text-slate-600 mt-0.5">{item.updatedAt}</div>
                      <div className={`text-xs mt-1 ${item.freshnessScore >= 90 ? 'text-emerald-400' : item.freshnessScore >= 70 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {item.freshnessScore}% fresh
                      </div>
                    </div>
                  </div>
                  <div className="text-xs text-slate-600 mb-2">{getTaxBreadcrumb(item)}</div>
                  <div className="flex flex-wrap gap-1">
                    {item.tags.map((t) => (
                      <span key={t} className="px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded text-xs">{t}</span>
                    ))}
                    {item.subTags.map((t) => (
                      <span key={t} className="px-1.5 py-0.5 bg-slate-800/50 text-slate-600 rounded text-xs">{t}</span>
                    ))}
                  </div>
                </div>
              ))}
              {filteredItems.length === 0 && (
                <div className="text-center py-16 text-slate-500 text-sm">No articles match the current filters.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- DATA CONNECTORS ----
  if (subPage === 'connectors') {
    const displayConnectors =
      selectedAgent === 'all'
        ? registeredConnectors
        : registeredConnectors.filter((c) => c.agentBindings.some((b) => b.agentId === selectedAgent));

    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageTabs tabs={HUB_TABS} page={page} setPage={setPage} accentColor={accentColor} />
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Data Connector Registry</h1>
            <p className="text-slate-400 text-sm mt-1">
              Field-level permissions for every connector bound to an agent — the source of truth for what agents can read and write
            </p>
          </div>
          <div className="flex gap-2">
            <select
              value={selectedAgent}
              onChange={(e) => setSelectedConnectorAgent(e.target.value)}
              className="bg-slate-900 border border-slate-700 text-slate-300 text-xs rounded-xl px-3 py-2 focus:outline-none"
            >
              <option value="all">All Agents</option>
              <option value="a1">Support Agent</option>
              <option value="a2">Onboarding Agent</option>
              <option value="a3">Billing Agent</option>
              <option value="a4">Account Agent</option>
              <option value="a5">Knowledge Curator</option>
              <option value="a7">HR Knowledge Agent</option>
              <option value="a8">Sales Intelligence Agent</option>
            </select>
          </div>
        </div>
        <div className="space-y-4">
          {displayConnectors.map((dc) => {
            const isExpanded = selectedConnector?.id === dc.id;
            const boundAgents = dc.agentBindings.length;
            const statusColors: Record<ConnectorStatus, string> = {
              connected: 'text-emerald-400',
              disconnected: 'text-slate-500',
              error: 'text-red-400',
              syncing: 'text-yellow-400',
            };
            return (
              <div key={dc.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div
                  className="p-4 flex items-center gap-4 cursor-pointer hover:bg-slate-800/50 transition-colors"
                  onClick={() => setSelectedConnector(isExpanded ? null : dc)}
                >
                  <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-sm font-bold text-slate-300 flex-shrink-0">{dc.icon}</div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-semibold text-white">{dc.name}</span>
                      <span className={`px-2 py-0.5 rounded text-xs ${catColors[dc.category]}`}>{dc.category}</span>
                      <span className={`text-xs ${statusColors[dc.status]}`}>{dc.status}</span>
                    </div>
                    <div className="text-xs text-slate-500">
                      Synced {dc.lastSync} · {dc.syncFrequency} · {dc.recordCount.toLocaleString()} records · {dc.objects.length} objects · {boundAgents} agent{boundAgents !== 1 ? 's' : ''} bound
                    </div>
                  </div>
                  <span className="text-slate-600 text-sm">{isExpanded ? 'v' : '>'}</span>
                </div>
                {isExpanded && (
                  <div className="border-t border-slate-800 p-4">
                    {dc.agentBindings.map((binding) => {
                      const agentNames: Record<string, string> = {
                        a1: 'Support Agent', a2: 'Onboarding Agent', a3: 'Billing Agent',
                        a4: 'Account Agent', a5: 'Knowledge Curator', a6: 'Compliance Bot',
                        a7: 'HR Knowledge Agent', a8: 'Sales Intelligence Agent',
                      };
                      if (selectedAgent !== 'all' && binding.agentId !== selectedAgent) return null;
                      return (
                        <div key={binding.agentId} className="mb-4">
                          <div className="text-xs font-semibold text-indigo-400 mb-2">{agentNames[binding.agentId] || binding.agentId}</div>
                          {binding.objects.map((obj) => {
                            const connObj = dc.objects.find((o) => o.name === obj.objectName);
                            if (!connObj) return null;
                            return (
                              <div key={obj.objectName} className="mb-3">
                                <div className="text-xs text-slate-400 mb-1 font-medium">{connObj.label}</div>
                                <div className="bg-slate-950 rounded-lg overflow-hidden">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="border-b border-slate-800">
                                        <th className="text-left px-3 py-1.5 text-slate-500 font-medium">Field</th>
                                        <th className="text-left px-3 py-1.5 text-slate-500 font-medium">Type</th>
                                        <th className="text-left px-3 py-1.5 text-slate-500 font-medium">Description</th>
                                        <th className="text-left px-3 py-1.5 text-slate-500 font-medium">PII</th>
                                        <th className="text-left px-3 py-1.5 text-slate-500 font-medium">Permission</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {connObj.fields.map((field) => {
                                        const perm = obj.fieldPermissions[field.name] || 'none';
                                        const permColors: Record<FieldPermission, string> = {
                                          read: 'text-emerald-400 bg-emerald-900/30',
                                          write: 'text-yellow-400 bg-yellow-900/30',
                                          none: 'text-slate-600 bg-slate-800/50',
                                        };
                                        return (
                                          <tr key={field.name} className="border-b border-slate-800/50">
                                            <td className="px-3 py-1.5 text-slate-300 font-mono">{field.name}</td>
                                            <td className="px-3 py-1.5 text-slate-600">{field.type}</td>
                                            <td className="px-3 py-1.5 text-slate-500">{field.description}</td>
                                            <td className="px-3 py-1.5">{field.pii ? <span className="text-orange-400">PII</span> : <span className="text-slate-700">-</span>}</td>
                                            <td className="px-3 py-1.5">
                                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${permColors[perm]}`}>{perm}</span>
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ---- IMPORTED FILES ----
  if (subPage === 'files') {
    const statusColors: Record<string, string> = {
      indexed: 'text-emerald-400 bg-emerald-900/30',
      processing: 'text-yellow-400 bg-yellow-900/30',
      failed: 'text-red-400 bg-red-900/30',
    };
    const typeIconColors: Record<string, string> = {
      PDF: 'bg-red-900 text-red-300',
      XLSX: 'bg-emerald-900 text-emerald-300',
      DOCX: 'bg-blue-900 text-blue-300',
      PPTX: 'bg-orange-900 text-orange-300',
      MD: 'bg-slate-700 text-slate-300',
    };
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageTabs tabs={HUB_TABS} page={page} setPage={setPage} accentColor={accentColor} />
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Imported Files</h1>
            <p className="text-slate-400 text-sm mt-1">
              Files uploaded or synced from storage connectors — parsed, chunked, and indexed into the knowledge vector store
            </p>
          </div>
          <button className="px-4 py-2 rounded-xl text-white text-sm font-medium" style={{ backgroundColor: accentColor }}>
            + Upload File
          </button>
        </div>
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard label="Total Files" value={String(mockImportedFiles.length)} icon="▤" color="indigo" />
          <StatCard label="Indexed" value={String(mockImportedFiles.filter((f) => f.status === 'indexed').length)} icon="☑" color="emerald" />
          <StatCard label="Processing" value={String(mockImportedFiles.filter((f) => f.status === 'processing').length)} icon="✚" color="yellow" />
          <StatCard label="Total Chunks" value={String(mockImportedFiles.reduce((s, f) => s + f.chunkCount, 0))} icon="⊟" color="blue" />
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">File</th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">Taxonomy</th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">Audience</th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">Tags</th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">Chunks</th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">Uploaded</th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {mockImportedFiles.map((file) => {
                const prod = knowledgeTaxonomy.find((p) => p.id === file.productId);
                const mod = prod?.modules.find((m) => m.id === file.moduleId);
                return (
                  <tr key={file.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${typeIconColors[file.type] || 'bg-slate-700 text-slate-300'}`}>{file.type}</span>
                        <div>
                          <div className="text-white text-xs font-medium">{file.name}</div>
                          <div className="text-slate-600 text-xs">{file.size} · {file.uploadedBy}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {prod ? (
                        <div className="text-xs text-slate-400">
                          <div style={{ color: prod.color }}>{prod.label}</div>
                          {mod && <div className="text-slate-600">{mod.label}</div>}
                        </div>
                      ) : (
                        <span className="text-slate-700 text-xs">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${audienceColors[file.audience]}`}>{file.audience}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {file.tags.map((t) => (
                          <span key={t} className="px-1.5 py-0.5 bg-slate-800 text-slate-500 rounded text-xs">{t}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{file.chunkCount || '-'}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{file.uploadedAt}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[file.status]}`}>{file.status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return null;
};

export default KnowledgeDataPage;
