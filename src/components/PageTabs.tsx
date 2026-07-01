import React from 'react';
import type { Page } from '../types';

export const HUB_TABS: { id: Page; label: string }[] = [
  { id: 'hub_overview', label: 'Overview' },
  { id: 'hub_articles', label: 'Articles' },
  { id: 'knowledge_taxonomy', label: 'Taxonomy' },
  { id: 'hub_ingestion', label: 'Ingestion' },
  { id: 'knowledge_connectors', label: 'Connectors' },
  { id: 'knowledge_files', label: 'Files' },
  { id: 'hub_training', label: 'Training' },
  { id: 'hub_analytics', label: 'Analytics' },
];

export const PORTAL_TABS: { id: Page; label: string }[] = [
  { id: 'portal_overview', label: 'Overview' },
  { id: 'portal_conversations', label: 'Conversations' },
  { id: 'portal_actions', label: 'Workforce Actions' },
  { id: 'portal_approvals', label: 'Approvals' },
  { id: 'portal_tickets', label: 'Tickets' },
  { id: 'portal_escalations', label: 'Escalations' },
  { id: 'portal_settings', label: 'Settings' },
];

export const AGENT_TABS: { id: Page; label: string }[] = [
  { id: 'agents', label: 'Digital Employees' },
  { id: 'swarm', label: 'Workforce Engine' },
];

export const ADMIN_TABS: { id: Page; label: string }[] = [
  { id: 'security', label: 'Security & RBAC' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'connectors', label: 'Data Connectors' },
  { id: 'settings', label: 'Settings' },
];

const PageTabs = ({
  tabs,
  page,
  setPage,
  accentColor,
}: {
  tabs: { id: Page; label: string }[];
  page?: Page;
  setPage?: (p: Page) => void;
  accentColor?: string;
}) => (
  <div className="flex flex-wrap gap-1 bg-slate-800 rounded-xl p-1 mb-6 w-fit">
    {tabs.map((t) => (
      <button
        key={t.id}
        onClick={() => setPage && setPage(t.id)}
        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
          page === t.id ? 'text-white' : 'text-slate-400 hover:text-white'
        }`}
        style={page === t.id ? { backgroundColor: accentColor || '#6366f1' } : {}}
      >
        {t.label}
      </button>
    ))}
  </div>
);

export default PageTabs;
