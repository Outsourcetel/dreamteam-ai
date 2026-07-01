import React from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { Badge, PageTabs, ADMIN_TABS } from '../../components';

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

  const connectors = [
    { name: 'PostgreSQL Database', status: 'connected', tables: 42, lastSync: '5 min ago', records: '2.4M' },
    { name: 'Salesforce CRM', status: 'connected', tables: 18, lastSync: '1 hr ago', records: '89K' },
    { name: 'Zendesk', status: 'connected', tables: 8, lastSync: '10 min ago', records: '41K' },
    { name: 'Stripe', status: 'connected', tables: 12, lastSync: '2 hr ago', records: '12K' },
    { name: 'Google BigQuery', status: 'pending', tables: 0, lastSync: 'Not synced', records: '-' },
    { name: 'S3 Bucket', status: 'error', tables: 0, lastSync: 'Failed 3 hr ago', records: '-' },
  ];

  const statusColors: Record<string, string> = {
    connected: 'green',
    pending: 'yellow',
    error: 'red',
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={ADMIN_TABS} page={page} setPage={setPage} accentColor={accentColor} />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Data Connectors</h1>
          <p className="text-slate-400 text-sm mt-1">
            Connect databases and data warehouses — agents can query and act on live data
          </p>
        </div>
        <button
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
          style={{ backgroundColor: accentColor }}
        >
          + Add Connector
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {connectors.map((c, i) => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-sm font-semibold text-white">{c.name}</div>
                <Badge label={c.status} color={statusColors[c.status]} />
              </div>
            </div>
            <div className="space-y-2 text-xs text-slate-400">
              <div className="flex justify-between">
                <span>Tables</span>
                <span className="text-white">{c.tables}</span>
              </div>
              <div className="flex justify-between">
                <span>Records</span>
                <span className="text-white">{c.records}</span>
              </div>
              <div className="flex justify-between">
                <span>Last sync</span>
                <span className="text-white">{c.lastSync}</span>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all">
                {c.status === 'error' ? 'Retry' : 'Sync Now'}
              </button>
              <button className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all">
                Config
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default DataConnectorsPage;
