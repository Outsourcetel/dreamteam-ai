import React from 'react';
import type { Page } from '../types';

export const PORTAL_TABS: { id: Page; label: string }[] = [
  { id: 'entity_customer_support', label: 'Support Control Room' },
  { id: 'eu_chat', label: 'Customer View' },
];

export const ADMIN_TABS: { id: Page; label: string }[] = [
  { id: 'security', label: 'Security & RBAC' },
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
