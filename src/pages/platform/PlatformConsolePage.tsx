import React, { useState } from 'react';
import type { AuthUser, Tenant, PlatformPage, Page } from '../../types';
import { Badge, StatCard, Modal } from '../../components';
import { mockTenants } from '../../lib/mockData';
import type { DBTenant } from '../../lib/api';

const PlatformConsolePage = ({
  page,
  setPage,
  user,
  dbTenants,
}: {
  page: PlatformPage;
  setPage: (p: Page) => void;
  user: AuthUser;
  dbTenants?: DBTenant[];
}) => {
  // Use real DB tenants when available, fall back to mock data otherwise
  const tenants: Tenant[] = (dbTenants && dbTenants.length > 0)
    ? dbTenants.map((t: any) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        logo: t.logo_url || undefined,
        primaryColor: (t.settings && t.settings.primaryColor) || t.accent_color || '#6366f1',
        accentColor: t.accent_color || undefined,
        plan: t.plan,
        status: t.status,
        agentsActive: (t.settings && t.settings.agentsActive) ?? 0,
        usersCount: (t.settings && t.settings.usersCount) ?? 0,
        monthlyTokens: (t.settings && t.settings.monthlyTokens) ?? 0,
        tokenLimit: (t.settings && t.settings.tokenLimit) ?? 1000000,
        createdAt: (t.created_at || '').split('T')[0],
        industry: t.industry || '—',
        contactEmail: (t.settings && t.settings.contactEmail) || '',
      }))
    : mockTenants;
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [godModeTarget, setGodModeTarget] = useState<Tenant | null>(null);

  if (page === 'platform_home') {
    const totalTokens = tenants.reduce((s, t) => s + t.monthlyTokens, 0);
    const activeTenants = tenants.filter(
      (t) => t.status === 'active'
    ).length;
    const totalAgents = tenants.reduce((s, t) => s + t.agentsActive, 0);
    const totalUsers = tenants.reduce((s, t) => s + t.usersCount, 0);

    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Platform Overview</h1>
          <p className="text-slate-400 text-sm mt-1">
            DreamTeam AI — Master control centre for all tenants and system
            health
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Active Tenants"
            value={String(activeTenants)}
            icon="◈"
            color="indigo"
            trend={'of ' + tenants.length + ' total'}
          />
          <StatCard
            label="Total AI Agents"
            value={String(totalAgents)}
            icon="⚡"
            color="emerald"
            trend="Across all tenants"
          />
          <StatCard
            label="Platform Users"
            value={String(totalUsers)}
            icon="◈"
            color="blue"
            trend="All tenants"
          />
          <StatCard
            label="Monthly Tokens"
            value={(totalTokens / 1000000).toFixed(1) + 'M'}
            icon="⚡"
            color="amber"
            trend="Platform-wide"
          />
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">
            Recent Platform Events
          </h2>
          <div className="space-y-3">
            {[
              {
                event: 'New tenant onboarded: Umbrella Medical',
                time: '2 hr ago',
                type: 'success',
              },
              {
                event:
                  'Hooli Technologies exceeded 80% token limit — warning sent',
                time: '4 hr ago',
                type: 'warn',
              },
              {
                event: 'Pied Piper account suspended — payment failure',
                time: '1 day ago',
                type: 'error',
              },
              {
                event: 'Platform-wide model update to GPT-4o-latest',
                time: '2 days ago',
                type: 'info',
              },
              {
                event: 'Initech Solutions upgraded to Growth plan',
                time: '3 days ago',
                type: 'success',
              },
            ].map((e, i) => (
              <div key={i} className="flex items-start gap-3">
                <span
                  className={`text-sm ${
                    e.type === 'success'
                      ? 'text-emerald-400'
                      : e.type === 'warn'
                      ? 'text-amber-400'
                      : e.type === 'error'
                      ? 'text-red-400'
                      : 'text-blue-400'
                  }`}
                >
                  {e.type === 'success'
                    ? 'v'
                    : e.type === 'warn'
                    ? '!'
                    : e.type === 'error'
                    ? 'x'
                    : 'i'}
                </span>
                <span className="text-sm text-slate-300 flex-1">{e.event}</span>
                <span className="text-xs text-slate-600">{e.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (page === 'platform_tenants') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Tenant Management</h1>
            <p className="text-slate-400 text-sm mt-1">
              Manage all client workspaces — view, configure, and support
              tenants
            </p>
          </div>
          <button className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium bg-indigo-600 hover:bg-indigo-500">
            + Provision Tenant
          </button>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                {[
                  'Tenant',
                  'Plan',
                  'Status',
                  'Agents',
                  'Users',
                  'Tokens Used',
                  'Actions',
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {tenants.map((t) => (
                <tr
                  key={t.id}
                  className="hover:bg-slate-800/30 cursor-pointer transition-all"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white"
                        style={{
                          backgroundColor: t.primaryColor + '30',
                          border: '1px solid ' + t.primaryColor + '60',
                        }}
                      >
                        {t.name[0]}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-white">
                          {t.name}
                        </div>
                        <div className="text-xs text-slate-500">
                          {t.industry}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      label={t.plan}
                      color={
                        t.plan === 'enterprise'
                          ? 'purple'
                          : t.plan === 'growth'
                          ? 'blue'
                          : 'slate'
                      }
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      label={t.status}
                      color={
                        t.status === 'active'
                          ? 'green'
                          : t.status === 'trial'
                          ? 'yellow'
                          : 'red'
                      }
                    />
                  </td>
                  <td className="px-4 py-3 text-sm text-white">
                    {t.agentsActive}
                  </td>
                  <td className="px-4 py-3 text-sm text-white">
                    {t.usersCount}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm text-white">
                      {(t.monthlyTokens / 1000000).toFixed(1)}M
                    </div>
                    <div className="w-16 h-1 bg-slate-800 rounded-full mt-1">
                      <div
                        className="h-full rounded-full bg-indigo-500"
                        style={{
                          width: (t.monthlyTokens / t.tokenLimit) * 100 + '%',
                        }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => setSelectedTenant(t)}
                        className="text-xs px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-all"
                      >
                        View
                      </button>
                      <button
                        onClick={() => setGodModeTarget(t)}
                        className="text-xs px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded-lg transition-all"
                      >
                        Support Access
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selectedTenant && (
          <Modal
            title={selectedTenant.name + ' — Detail'}
            onClose={() => setSelectedTenant(null)}
          >
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Plan', value: selectedTenant.plan },
                  { label: 'Status', value: selectedTenant.status },
                  { label: 'Industry', value: selectedTenant.industry },
                  {
                    label: 'Active Agents',
                    value: String(selectedTenant.agentsActive),
                  },
                  { label: 'Users', value: String(selectedTenant.usersCount) },
                  {
                    label: 'Token Usage',
                    value:
                      (selectedTenant.monthlyTokens / 1000000).toFixed(1) + 'M',
                  },
                ].map((item, i) => (
                  <div key={i} className="bg-slate-800 rounded-xl p-3">
                    <div className="text-xs text-slate-400 mb-0.5">
                      {item.label}
                    </div>
                    <div className="text-sm font-medium text-white capitalize">
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setGodModeTarget(selectedTenant);
                    setSelectedTenant(null);
                  }}
                  className="flex-1 py-2.5 text-sm font-medium rounded-xl bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-all"
                >
                  Start Support Session
                </button>
                <button className="px-4 py-2.5 text-sm text-slate-400 hover:text-white bg-slate-800 rounded-xl transition-all">
                  Suspend
                </button>
              </div>
            </div>
          </Modal>
        )}
        {godModeTarget && (
          <Modal
            title={'Support Access: ' + godModeTarget.name}
            onClose={() => setGodModeTarget(null)}
          >
            <div className="space-y-4">
              <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                <p className="text-sm text-amber-300 font-medium mb-1">
                  Support Access — Remote Session
                </p>
                <p className="text-xs text-amber-400/70">
                  You are about to enter this tenant workspace with full access.
                  All actions will be logged and visible to the tenant owner.
                </p>
              </div>
              <div className="space-y-2 text-xs text-slate-400">
                <div className="flex justify-between">
                  <span>Access Level</span>
                  <span className="text-amber-300 font-medium">
                    Full Read and Write
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Audit logged</span>
                  <span className="text-white">Yes — visible to tenant</span>
                </div>
                <div className="flex justify-between">
                  <span>Session timeout</span>
                  <span className="text-white">60 minutes</span>
                </div>
              </div>
              <button
                onClick={() => setGodModeTarget(null)}
                className="w-full py-2.5 text-sm font-medium rounded-xl text-white bg-amber-600 hover:bg-amber-500 transition-all"
              >
                Enter Tenant Workspace
              </button>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  if (page === 'platform_health') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">System Health</h1>
          <p className="text-slate-400 text-sm mt-1">
            Real-time platform health across all services
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Platform Uptime"
            value="99.97%"
            icon="★"
            color="emerald"
            trend="30-day SLA"
          />
          <StatCard
            label="Avg API Latency"
            value="84ms"
            icon="✚"
            color="blue"
            trend="-12ms vs last week"
          />
          <StatCard
            label="Active Incidents"
            value="0"
            icon="⚠"
            color="emerald"
            trend="All clear"
          />
          <StatCard
            label="Error Rate"
            value="0.03%"
            icon="◎"
            color="amber"
            trend="Within SLA"
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            { name: 'API Gateway', latency: '42ms', uptime: '100%' },
            { name: 'AI Inference Layer', latency: '1.2s', uptime: '99.9%' },
            {
              name: 'Knowledge Embeddings',
              latency: '220ms',
              uptime: '99.98%',
            },
            { name: 'Agent Runtime', latency: '88ms', uptime: '99.97%' },
            { name: 'Data Connectors', latency: '150ms', uptime: '99.95%' },
            { name: 'Audit Log Service', latency: '30ms', uptime: '100%' },
          ].map((svc, i) => (
            <div
              key={i}
              className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <div>
                  <div className="text-sm font-medium text-white">
                    {svc.name}
                  </div>
                  <div className="text-xs text-slate-500">
                    {svc.latency} · {svc.uptime} uptime
                  </div>
                </div>
              </div>
              <Badge label="Operational" color="green" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (page === 'platform_revenue') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Revenue</h1>
          <p className="text-slate-400 text-sm mt-1">
            Platform revenue across all tenant subscriptions
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="MRR"
            value="$28,450"
            icon="◎"
            color="emerald"
            trend="+12% MoM"
          />
          <StatCard
            label="ARR"
            value="$341,400"
            icon="◎"
            color="indigo"
            trend="On track"
          />
          <StatCard
            label="Active Subscriptions"
            value="5"
            icon="◆"
            color="blue"
            trend="1 suspended"
          />
          <StatCard
            label="Avg Revenue/Tenant"
            value="$5,690"
            icon="★"
            color="amber"
            trend="Growing"
          />
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                {[
                  'Tenant',
                  'Plan',
                  'Monthly Revenue',
                  'Status',
                  'Next Renewal',
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {tenants.map((t) => {
                const rev =
                  t.plan === 'enterprise'
                    ? 1499
                    : t.plan === 'growth'
                    ? 299
                    : 99;
                return (
                  <tr
                    key={t.id}
                    className="hover:bg-slate-800/20 transition-all"
                  >
                    <td className="px-4 py-3 text-sm text-white">{t.name}</td>
                    <td className="px-4 py-3">
                      <Badge
                        label={t.plan}
                        color={
                          t.plan === 'enterprise'
                            ? 'purple'
                            : t.plan === 'growth'
                            ? 'blue'
                            : 'slate'
                        }
                      />
                    </td>
                    <td className="px-4 py-3 text-sm text-white">
                      {t.status === 'suspended'
                        ? '-'
                        : '$' + rev.toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        label={t.status}
                        color={
                          t.status === 'active'
                            ? 'green'
                            : t.status === 'trial'
                            ? 'yellow'
                            : 'red'
                        }
                      />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      July 1, 2026
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

  if (page === 'platform_remote_access') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Remote Access</h1>
          <p className="text-slate-400 text-sm mt-1">
            Support Access sessions and remote access to tenant workspaces
          </p>
        </div>
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-3">
            <span className="text-amber-400 text-lg">!</span>
            <div>
              <div className="text-sm font-medium text-amber-300">
                Support Access
              </div>
              <div className="text-xs text-amber-400/70">
                All remote sessions are fully logged and visible to tenant
                owners. Only authorised DT staff can initiate a Support Access session.
              </div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {tenants
            .filter((t) => t.status === 'active')
            .map((t) => (
              <div
                key={t.id}
                className="bg-slate-900 border border-slate-800 rounded-xl p-5"
              >
                <div className="flex items-center gap-3 mb-4">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold"
                    style={{
                      backgroundColor: t.primaryColor + '30',
                      border: '1px solid ' + t.primaryColor + '50',
                    }}
                  >
                    {t.name[0]}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white">
                      {t.name}
                    </div>
                    <div className="text-xs text-slate-500">{t.industry}</div>
                  </div>
                </div>
                <div className="space-y-1 text-xs text-slate-400 mb-4">
                  <div className="flex justify-between">
                    <span>Agents</span>
                    <span className="text-white">{t.agentsActive} active</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Users</span>
                    <span className="text-white">{t.usersCount}</span>
                  </div>
                </div>
                <button
                  onClick={() => setGodModeTarget(t)}
                  className="w-full py-2 text-sm font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-xl transition-all"
                >
                  Start Support Session
                </button>
              </div>
            ))}
        </div>
        {godModeTarget && (
          <Modal
            title={'Support Access: ' + godModeTarget.name}
            onClose={() => setGodModeTarget(null)}
          >
            <div className="space-y-4">
              <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                <p className="text-sm text-amber-300 font-medium mb-1">
                  Confirm Remote Access
                </p>
                <p className="text-xs text-amber-400/70">
                  Session will be logged and visible to the tenant owner.
                </p>
              </div>
              <button
                onClick={() => setGodModeTarget(null)}
                className="w-full py-2.5 text-sm font-medium rounded-xl text-white bg-amber-600 hover:bg-amber-500 transition-all"
              >
                Launch Remote Session
              </button>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 p-6">
      <p className="text-slate-400">Platform Console</p>
    </div>
  );
};

export default PlatformConsolePage;
