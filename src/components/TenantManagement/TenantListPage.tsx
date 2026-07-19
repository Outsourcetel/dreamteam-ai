import React, { useState, useEffect } from 'react';
import { getAllTenantsSummary, type TenantSummary } from '../../lib/tenantManagementApi';
import { TenantDetailModal } from './TenantDetailModal';

export function TenantListPage() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);

  useEffect(() => {
    loadTenants();
  }, []);

  const loadTenants = async () => {
    setLoading(true);
    const data = await getAllTenantsSummary();
    setTenants(data || []);
    setLoading(false);
  };

  if (loading) {
    return <div className="animate-pulse h-96 bg-slate-800 rounded-lg" />;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-200">Tenant Management</h2>
          <p className="text-sm text-slate-400 mt-1">Monitor tenant activity, usage, and costs</p>
        </div>
        <button
          onClick={loadTenants}
          className="px-3 py-1 text-sm bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition"
        >
          Refresh
        </button>
      </div>

      {/* Tenants Table */}
      <div className="overflow-x-auto border border-slate-700 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 border-b border-slate-700">
            <tr>
              <th className="px-4 py-2 text-left text-slate-300 font-medium">Tenant</th>
              <th className="px-4 py-2 text-left text-slate-300 font-medium">Admin</th>
              <th className="px-4 py-2 text-left text-slate-300 font-medium">Industry</th>
              <th className="px-4 py-2 text-center text-slate-300 font-medium">DEs</th>
              <th className="px-4 py-2 text-center text-slate-300 font-medium">Features</th>
              <th className="px-4 py-2 text-center text-slate-300 font-medium">Adoption</th>
              <th className="px-4 py-2 text-right text-slate-300 font-medium">Monthly Cost</th>
              <th className="px-4 py-2 text-center text-slate-300 font-medium">Budget</th>
              <th className="px-4 py-2 text-center text-slate-300 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {tenants.map(tenant => (
              <tr key={tenant.tenant_id} className="hover:bg-slate-800/50 transition">
                {/* Tenant Name */}
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-200">{tenant.name}</div>
                  <div className="text-xs text-slate-500">{tenant.slug}</div>
                </td>

                {/* Admin Email */}
                <td className="px-4 py-3 text-slate-400">{tenant.admin_email || '-'}</td>

                {/* Industry */}
                <td className="px-4 py-3 text-slate-400">{tenant.industry || '-'}</td>

                {/* DE Count */}
                <td className="px-4 py-3 text-center">
                  <span className="inline-block px-2 py-1 bg-slate-700 text-slate-300 rounded text-xs">
                    {tenant.de_count}
                  </span>
                </td>

                {/* Active Features */}
                <td className="px-4 py-3 text-center">
                  <span className="inline-block px-2 py-1 bg-blue-900/30 text-blue-300 rounded text-xs">
                    {tenant.active_features}/8
                  </span>
                </td>

                {/* Adoption Score */}
                <td className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-16 h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 transition-all"
                        style={{ width: `${Math.min(tenant.adoption_score, 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-400">{tenant.adoption_score.toFixed(0)}%</span>
                  </div>
                </td>

                {/* Monthly Cost */}
                <td className="px-4 py-3 text-right">
                  <span className="font-mono text-slate-200">${tenant.monthly_cost.toFixed(2)}</span>
                </td>

                {/* Cost vs Budget */}
                <td className="px-4 py-3 text-center">
                  {tenant.cost_vs_budget !== null ? (
                    <span className={`text-xs font-medium px-2 py-1 rounded ${
                      tenant.cost_vs_budget > 100
                        ? 'bg-red-900/30 text-red-300'
                        : tenant.cost_vs_budget > 80
                        ? 'bg-amber-900/30 text-amber-300'
                        : 'bg-green-900/30 text-green-300'
                    }`}>
                      {tenant.cost_vs_budget.toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-xs text-slate-500">N/A</span>
                  )}
                </td>

                {/* Action */}
                <td className="px-4 py-3 text-center">
                  <button
                    onClick={() => setSelectedTenantId(tenant.tenant_id)}
                    className="text-xs px-2 py-1 bg-slate-600 hover:bg-slate-500 text-slate-200 rounded transition"
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Empty State */}
      {tenants.length === 0 && (
        <div className="p-8 text-center text-slate-400">
          No tenants found.
        </div>
      )}

      {/* Detail Modal */}
      {selectedTenantId && (
        <TenantDetailModal
          tenantId={selectedTenantId}
          onClose={() => setSelectedTenantId(null)}
          onRefresh={loadTenants}
        />
      )}
    </div>
  );
}
