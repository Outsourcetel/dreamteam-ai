import React, { useState, useEffect } from 'react';
import { getTenantDetails, updateTenantFeatures, updateTenantBilling, calculateMonthlyCost, calculateEstimatedMonthlyCost, checkBudgetStatus, type TenantDetails } from '../../lib/tenantManagementApi';

interface TenantDetailModalProps {
  tenantId: string;
  onClose: () => void;
  onRefresh: () => void;
}

type Tab = 'profile' | 'features' | 'usage' | 'billing';

export function TenantDetailModal({ tenantId, onClose, onRefresh }: TenantDetailModalProps) {
  const [tenant, setTenant] = useState<TenantDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('profile');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadTenant();
  }, [tenantId]);

  const loadTenant = async () => {
    setLoading(true);
    const data = await getTenantDetails(tenantId);
    setTenant(data);
    setLoading(false);
  };

  const handleSaveFeatures = async () => {
    if (!tenant) return;
    setSaving(true);
    await updateTenantFeatures(tenantId, tenant.features);
    setSaving(false);
    onRefresh();
  };

  const handleSaveBilling = async () => {
    if (!tenant) return;
    setSaving(true);
    await updateTenantBilling(tenantId, tenant.billing);
    setSaving(false);
    onRefresh();
  };

  if (loading || !tenant) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-slate-900 border border-slate-700 rounded-lg p-8 max-w-2xl w-full animate-pulse h-96" />
      </div>
    );
  }

  const estimatedCost = calculateEstimatedMonthlyCost(tenant.billing, tenant.features, {
    responses: tenant.usage.total_responses_this_month,
    amendments: tenant.usage.total_amendments_created,
    deCount: 0, // Would need to fetch DE count
  });

  const budgetStatus = checkBudgetStatus(
    estimatedCost.total,
    tenant.limits.monthly_cost_limit,
    tenant.limits.soft_limit_alert_percent
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-4xl w-full max-h-96 flex flex-col">
        {/* Header */}
        <div className="border-b border-slate-700 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-200">{tenant.name}</h2>
            <p className="text-sm text-slate-400">{tenant.slug}</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-2xl"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-slate-700 px-6 flex gap-4">
          {(['profile', 'features', 'usage', 'billing'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-3 px-2 border-b-2 transition capitalize ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {activeTab === 'profile' && (
            <div className="space-y-3">
              <DetailRow label="Tenant ID" value={tenant.tenant_id} />
              <DetailRow label="Slug" value={tenant.slug} />
              <DetailRow label="Status" value={tenant.status} />
              <DetailRow label="Plan" value={tenant.plan} />
              <DetailRow label="Industry" value={tenant.industry || '-'} />
              <DetailRow label="Admin Name" value={tenant.admin_name || '-'} />
              <DetailRow label="Admin Email" value={tenant.admin_email || '-'} />
              <DetailRow label="Billing Email" value={tenant.billing_email || '-'} />
              <DetailRow label="Created" value={new Date(tenant.created_at).toLocaleDateString()} />
              <DetailRow
                label="Adoption Score"
                value={`${tenant.adoption_score.toFixed(1)}%`}
              />
            </div>
          )}

          {activeTab === 'features' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(tenant.features).map(([key, enabled]) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={e => {
                        setTenant({
                          ...tenant,
                          features: {
                            ...tenant.features,
                            [key]: e.target.checked,
                          },
                        });
                      }}
                      className="rounded"
                    />
                    <span className="text-sm text-slate-300 capitalize">
                      {key.replace(/_/g, ' ')}
                    </span>
                  </label>
                ))}
              </div>

              <div className="pt-3 border-t border-slate-700">
                <h3 className="text-sm font-medium text-slate-200 mb-2">Usage Limits</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <label className="text-slate-400">Monthly Cost Limit</label>
                    <input
                      type="number"
                      value={tenant.limits.monthly_cost_limit || ''}
                      onChange={e => {
                        const val = e.target.value ? parseFloat(e.target.value) : null;
                        setTenant({
                          ...tenant,
                          limits: {
                            ...tenant.limits,
                            monthly_cost_limit: val,
                          },
                        });
                      }}
                      placeholder="No limit"
                      className="w-full mt-1 px-2 py-1 bg-slate-800 border border-slate-700 text-slate-200 rounded text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-slate-400">Soft Limit Alert %</label>
                    <input
                      type="number"
                      value={tenant.limits.soft_limit_alert_percent}
                      onChange={e => {
                        setTenant({
                          ...tenant,
                          limits: {
                            ...tenant.limits,
                            soft_limit_alert_percent: parseFloat(e.target.value),
                          },
                        });
                      }}
                      className="w-full mt-1 px-2 py-1 bg-slate-800 border border-slate-700 text-slate-200 rounded text-xs"
                    />
                  </div>
                </div>
              </div>

              <button
                onClick={handleSaveFeatures}
                disabled={saving}
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded text-sm font-medium transition"
              >
                {saving ? 'Saving...' : 'Save Features'}
              </button>
            </div>
          )}

          {activeTab === 'usage' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <MetricCard
                  label="DEs Using Sophie Config"
                  value={tenant.usage.de_using_sophie_config}
                />
                <MetricCard
                  label="DEs Using Amendments"
                  value={tenant.usage.de_using_amendments}
                />
                <MetricCard
                  label="Total Responses (This Month)"
                  value={tenant.usage.total_responses_this_month}
                />
                <MetricCard
                  label="Total Amendments Created"
                  value={tenant.usage.total_amendments_created}
                />
                <MetricCard
                  label="Avg Response Confidence"
                  value={`${tenant.usage.avg_response_confidence.toFixed(1)}%`}
                />
                <MetricCard
                  label="Adoption Score"
                  value={`${tenant.usage.adoption_score.toFixed(1)}%`}
                />
              </div>
            </div>
          )}

          {activeTab === 'billing' && (
            <div className="space-y-4">
              <div className="p-3 bg-slate-800/50 border border-slate-700 rounded">
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="text-slate-400">Base Features</div>
                    <div className="text-lg font-semibold text-slate-200">
                      ${estimatedCost.base.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">Usage-Based</div>
                    <div className="text-lg font-semibold text-slate-200">
                      ${estimatedCost.usage.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className={`text-slate-400 ${
                      budgetStatus.alertLevel === 'critical'
                        ? 'text-red-400'
                        : budgetStatus.alertLevel === 'warning'
                        ? 'text-amber-400'
                        : ''
                    }`}>
                      Estimated Total
                    </div>
                    <div className={`text-lg font-semibold ${
                      budgetStatus.alertLevel === 'critical'
                        ? 'text-red-300'
                        : budgetStatus.alertLevel === 'warning'
                        ? 'text-amber-300'
                        : 'text-slate-200'
                    }`}>
                      ${estimatedCost.total.toFixed(2)}
                    </div>
                  </div>
                </div>

                {tenant.limits.monthly_cost_limit && (
                  <div className="mt-3 pt-3 border-t border-slate-700">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-slate-400">Budget: ${tenant.limits.monthly_cost_limit.toFixed(2)}</span>
                      <span className={budgetStatus.alertLevel === 'critical' ? 'text-red-400' : 'text-slate-400'}>
                        {budgetStatus.percentOfBudget?.toFixed(0)}% used
                      </span>
                    </div>
                    <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          budgetStatus.alertLevel === 'critical'
                            ? 'bg-red-500'
                            : budgetStatus.alertLevel === 'warning'
                            ? 'bg-amber-500'
                            : 'bg-green-500'
                        }`}
                        style={{
                          width: `${Math.min(budgetStatus.percentOfBudget || 0, 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2 text-sm">
                <h3 className="font-medium text-slate-200">Feature Pricing (Monthly)</h3>
                <PricingRow
                  label="Sophie Config"
                  value={tenant.billing.sophie_config_cost}
                  onChange={val => {
                    setTenant({
                      ...tenant,
                      billing: { ...tenant.billing, sophie_config_cost: val },
                    });
                  }}
                />
                <PricingRow
                  label="Amendment Journeys"
                  value={tenant.billing.amendment_cost}
                  onChange={val => {
                    setTenant({
                      ...tenant,
                      billing: { ...tenant.billing, amendment_cost: val },
                    });
                  }}
                />
                <PricingRow
                  label="Reply Mode"
                  value={tenant.billing.reply_mode_cost}
                  onChange={val => {
                    setTenant({
                      ...tenant,
                      billing: { ...tenant.billing, reply_mode_cost: val },
                    });
                  }}
                />

                <h3 className="font-medium text-slate-200 mt-3">Usage-Based Pricing</h3>
                <PricingRow
                  label="Per 1K Responses"
                  value={tenant.billing.cost_per_1k_responses}
                  onChange={val => {
                    setTenant({
                      ...tenant,
                      billing: { ...tenant.billing, cost_per_1k_responses: val },
                    });
                  }}
                />
                <PricingRow
                  label="Per Amendment"
                  value={tenant.billing.cost_per_amendment}
                  onChange={val => {
                    setTenant({
                      ...tenant,
                      billing: { ...tenant.billing, cost_per_amendment: val },
                    });
                  }}
                />
              </div>

              <button
                onClick={handleSaveBilling}
                disabled={saving}
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded text-sm font-medium transition"
              >
                {saving ? 'Saving...' : 'Save Billing Config'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-slate-800 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-200 font-mono">{value}</span>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="p-3 bg-slate-800 border border-slate-700 rounded">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg font-semibold text-slate-200 mt-1">{value}</div>
    </div>
  );
}

function PricingRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (val: number) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <div className="flex items-center gap-1">
        <span className="text-slate-500">$</span>
        <input
          type="number"
          step="0.01"
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="w-20 px-2 py-1 bg-slate-800 border border-slate-700 text-slate-200 rounded text-xs"
        />
      </div>
    </div>
  );
}
