import React, { useState, useEffect } from 'react';
import type { AuthUser, Tenant, PlatformPage, Page } from '../../types';
import { Badge, StatCard, Modal } from '../../components';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../supabase';
import type { DBTenant, TenantProvisioningRequest, FeatureRegistryEntry, TenantFeatureOverride, PlatformConnectorHealthRow } from '../../lib/api';
import {
  fetchPendingProvisioningRequests, approveSubtenantRequest, rejectSubtenantRequest,
  setTenantSelfServe, setTenantStatus, requestSubtenant, fetchTenants,
  fetchFeatureRegistry, fetchTenantFeatureOverrides, setTenantFeatureOverride,
  fetchPlatformConnectorHealth,
} from '../../lib/api';
import MfaEnrollmentPanel from './MfaEnrollmentPanel';
import PlatformTeamPage from './PlatformTeamPage';

const dbTenantToTenant = (t: DBTenant): Tenant => ({
  id: t.id,
  name: t.name,
  slug: t.slug,
  logo: t.logo_url || undefined,
  primaryColor: (t.settings && (t.settings as any).primaryColor) || t.accent_color || '#6366f1',
  accentColor: t.accent_color || undefined,
  plan: t.plan,
  status: t.status,
  agentsActive: (t.settings && (t.settings as any).agentsActive) ?? 0,
  usersCount: (t.settings && (t.settings as any).usersCount) ?? 0,
  monthlyTokens: (t.settings && (t.settings as any).monthlyTokens) ?? 0,
  tokenLimit: (t.settings && (t.settings as any).tokenLimit) ?? 1000000,
  createdAt: (t.created_at || '').split('T')[0],
  industry: t.industry || '—',
  contactEmail: (t.settings && (t.settings as any).contactEmail) || '',
  parentTenantId: t.parent_tenant_id ?? null,
  allowSelfServeSubtenants: !!t.allow_self_serve_subtenants,
});

const PlatformConsolePage = ({
  page,
  setPage,
  user,
  dbTenants,
  dbTenantsLoaded,
}: {
  page: PlatformPage;
  setPage: (p: Page) => void;
  user: AuthUser;
  dbTenants?: DBTenant[];
  dbTenantsLoaded?: boolean;
}) => {
  const { enterRemoteAccess } = useAuth();
  // Local mirror of the prop, so a provision/suspend action can refresh the
  // list immediately without waiting on the parent's own resync cycle.
  const [localDbTenants, setLocalDbTenants] = useState<DBTenant[]>(dbTenants || []);
  useEffect(() => { setLocalDbTenants(dbTenants || []); }, [dbTenants]);
  const refetchTenants = async () => {
    setLocalDbTenants(await fetchTenants());
  };
  const tenants: Tenant[] = localDbTenants.map(dbTenantToTenant);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [godModeTarget, setGodModeTarget] = useState<Tenant | null>(null);
  const [entering, setEntering] = useState(false);
  const [enterError, setEnterError] = useState('');
  const [featureTarget, setFeatureTarget] = useState<Tenant | null>(null);
  const [showTestDebris, setShowTestDebris] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);

  // Real, DB-gated ONLY (is_platform_admin() enforced server-side): calls
  // start_platform_remote_access, which durably audits the session in
  // platform_access_events, then flips local godModeSession state and
  // routes into the tenant's own dashboard so the owner is actually
  // operating inside that tenant's real data — not just looking at a
  // confirmation modal that goes nowhere.
  const handleEnterRemoteAccess = async (tenant: Tenant) => {
    setEntering(true);
    setEnterError('');
    const res = await enterRemoteAccess(tenant);
    setEntering(false);
    if (res.ok) {
      setGodModeTarget(null);
      setSelectedTenant(null);
      setPage('dashboard');
    } else {
      setEnterError(res.error || 'Could not start Remote Access. Please try again.');
    }
  };

  // Tenants power every tab except Team & Permissions and Security, which
  // don't depend on the tenant list — only gate on the fetch for tabs that
  // actually need it, so those two stay usable even if it's slow.
  const tenantsGatedPage = page !== 'platform_team' && page !== 'platform_security';
  if (tenantsGatedPage && !dbTenantsLoaded) {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6 flex items-center justify-center">
        <p className="text-sm text-slate-500">Loading tenants…</p>
      </div>
    );
  }

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
            label="Total Digital Employees"
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

        <RecentPlatformEventsPanel tenants={tenants} />
      </div>
    );
  }

  if (page === 'platform_tenants') {
    const debrisTenants = tenants.filter((t) => t.name.startsWith('[TEST DEBRIS'));
    const visibleTenants = showTestDebris ? tenants : tenants.filter((t) => !t.name.startsWith('[TEST DEBRIS'));
    // Build a depth-ordered tree list: parents before children, indented by
    // depth, so the table renders as a readable nested hierarchy without a
    // separate graph widget. A tenant whose parent isn't in this list
    // (shouldn't happen, but defensive) is treated as top-level.
    const byParent = new Map<string | null, Tenant[]>();
    visibleTenants.forEach((t) => {
      const key = t.parentTenantId && visibleTenants.some((p) => p.id === t.parentTenantId) ? t.parentTenantId : null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(t);
    });
    const orderedRows: { tenant: Tenant; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      (byParent.get(parentId) || []).forEach((t) => {
        orderedRows.push({ tenant: t, depth });
        walk(t.id, depth + 1);
      });
    };
    walk(null, 0);

    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Tenant Management</h1>
            <p className="text-slate-400 text-sm mt-1">
              Manage all client workspaces — view, configure, and support
              tenants. Indented rows are sub-tenants nested under their parent.
            </p>
            {debrisTenants.length > 0 && (
              <p className="text-xs text-slate-500 mt-1">
                {showTestDebris
                  ? `Showing ${debrisTenants.length} suspended test tenant${debrisTenants.length === 1 ? '' : 's'} from earlier security testing — never billed, never active.`
                  : `${debrisTenants.length} suspended test tenant${debrisTenants.length === 1 ? '' : 's'} from earlier security testing hidden.`}{' '}
                <button
                  onClick={() => setShowTestDebris((v) => !v)}
                  className="text-indigo-400 hover:text-indigo-300 underline"
                >
                  {showTestDebris ? 'Hide them' : 'Show them'}
                </button>
              </p>
            )}
          </div>
          <button
            onClick={() => setProvisionOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium bg-indigo-600 hover:bg-indigo-500"
          >
            + Provision Tenant
          </button>
        </div>

        {provisionOpen && (
          <ProvisionTenantModal
            onClose={() => setProvisionOpen(false)}
            onCreated={async () => { setProvisionOpen(false); await refetchTenants(); }}
          />
        )}

        <PendingApprovalsPanel />

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
              {orderedRows.map(({ tenant: t, depth }) => (
                <tr
                  key={t.id}
                  className="hover:bg-slate-800/30 cursor-pointer transition-all"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3" style={{ paddingLeft: depth * 24 }}>
                      {depth > 0 && <span className="text-slate-600 text-xs flex-shrink-0">&#8627;</span>}
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
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
                          {t.allowSelfServeSubtenants && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 align-middle">
                              Self-serve sub-tenants ON
                            </span>
                          )}
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
                        onClick={() => setFeatureTarget(t)}
                        className="text-xs px-2 py-1 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 rounded-lg transition-all"
                      >
                        Features
                      </button>
                      <button
                        onClick={() => { setEnterError(''); setGodModeTarget(t); }}
                        className="text-xs px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded-lg transition-all"
                      >
                        Remote Access
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

              <div className="bg-slate-800 rounded-xl p-4 flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-white">
                    Let this tenant create sub-tenants instantly
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    Off by default — a request to create a sub-tenant under {selectedTenant.name} goes to the
                    platform for approval first. Turn this on once you trust {selectedTenant.name} to create
                    their own sub-accounts without review.
                  </div>
                </div>
                <SelfServeToggle tenant={selectedTenant} onChanged={(v) => setSelectedTenant({ ...selectedTenant, allowSelfServeSubtenants: v })} />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setEnterError('');
                    setGodModeTarget(selectedTenant);
                    setSelectedTenant(null);
                  }}
                  className="flex-1 py-2.5 text-sm font-medium rounded-xl bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-all"
                >
                  Remote Access
                </button>
                <SuspendToggle
                  tenant={selectedTenant}
                  onChanged={(status) => {
                    setSelectedTenant({ ...selectedTenant, status });
                    refetchTenants();
                  }}
                />
              </div>
            </div>
          </Modal>
        )}
        {featureTarget && (
          <Modal
            title={'Features — ' + featureTarget.name}
            onClose={() => setFeatureTarget(null)}
          >
            <FeatureTogglePanel tenant={featureTarget} />
          </Modal>
        )}
        {godModeTarget && (
          <Modal
            title={'Remote Access: ' + godModeTarget.name}
            onClose={() => { if (!entering) setGodModeTarget(null); }}
          >
            <div className="space-y-4">
              <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                <p className="text-sm text-amber-300 font-medium mb-1">
                  Remote Access — enter this tenant's workspace
                </p>
                <p className="text-xs text-amber-400/70">
                  You are about to work inside {godModeTarget.name}'s real workspace, seeing exactly what
                  their team sees. This session is recorded — who accessed it, when, and for how long.
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
                  <span>Recorded</span>
                  <span className="text-white">Yes — every session is logged</span>
                </div>
              </div>
              {enterError && <p className="text-xs text-red-400">{enterError}</p>}
              <button
                onClick={() => handleEnterRemoteAccess(godModeTarget)}
                disabled={entering}
                className="w-full py-2.5 text-sm font-medium rounded-xl text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-60 transition-all"
              >
                {entering ? 'Starting session…' : 'Enter Tenant Workspace'}
              </button>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  if (page === 'platform_health') {
    return <PlatformHealthPage />;
  }

  if (page === 'platform_revenue') {
    const byPlan = { starter: 0, growth: 0, enterprise: 0 } as Record<Tenant['plan'], number>;
    tenants.forEach((t) => { byPlan[t.plan] = (byPlan[t.plan] || 0) + 1; });

    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Revenue</h1>
          <p className="text-slate-400 text-sm mt-1">
            Plan mix across all tenants — no billing system is connected yet, so no dollar figures are shown.
          </p>
        </div>

        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-6">
          <p className="text-xs text-amber-300">
            Billing isn't connected to any payment provider yet — there's no real MRR, ARR, or renewal data to
            show. This page reflects only what's actually known: each tenant's plan tier and status.
          </p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard label="Total Tenants" value={String(tenants.length)} icon="◈" color="indigo" trend="All plans" />
          <StatCard label="Starter" value={String(byPlan.starter)} icon="◎" color="slate" trend="Plan tier" />
          <StatCard label="Growth" value={String(byPlan.growth)} icon="◆" color="blue" trend="Plan tier" />
          <StatCard label="Enterprise" value={String(byPlan.enterprise)} icon="★" color="purple" trend="Plan tier" />
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                {['Tenant', 'Plan', 'Status'].map((h) => (
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
                <tr key={t.id} className="hover:bg-slate-800/20 transition-all">
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
                </tr>
              ))}
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
            Enter any tenant's workspace to see exactly what they see
          </p>
        </div>
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-3">
            <span className="text-amber-400 text-lg">!</span>
            <div>
              <div className="text-sm font-medium text-amber-300">
                Remote Access
              </div>
              <div className="text-xs text-amber-400/70">
                Every remote-access session is recorded — who accessed which tenant, and when. Only the
                platform owner (you) can start one.
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
                  onClick={() => { setEnterError(''); setGodModeTarget(t); }}
                  className="w-full py-2 text-sm font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-xl transition-all"
                >
                  Remote Access
                </button>
              </div>
            ))}
        </div>

        <RemoteAccessWriteAuditPanel dbTenants={dbTenants} />

        {godModeTarget && (
          <Modal
            title={'Remote Access: ' + godModeTarget.name}
            onClose={() => { if (!entering) setGodModeTarget(null); }}
          >
            <div className="space-y-4">
              <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                <p className="text-sm text-amber-300 font-medium mb-1">
                  Confirm Remote Access
                </p>
                <p className="text-xs text-amber-400/70">
                  You'll be working inside {godModeTarget.name}'s real workspace. This session is recorded.
                </p>
              </div>
              {enterError && <p className="text-xs text-red-400">{enterError}</p>}
              <button
                onClick={() => handleEnterRemoteAccess(godModeTarget)}
                disabled={entering}
                className="w-full py-2.5 text-sm font-medium rounded-xl text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-60 transition-all"
              >
                {entering ? 'Starting session…' : 'Enter Tenant Workspace'}
              </button>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  if (page === 'platform_team') {
    return <PlatformTeamPage />;
  }

  if (page === 'platform_security') {
    return <MfaEnrollmentPanel />;
  }

  return (
    <div className="flex-1 p-6">
      <p className="text-slate-400">Platform Console</p>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// Recent Platform Events — a real feed composed from three actually-
// tracked sources (no fabricated content): Remote Access session
// starts/ends (platform_access_events), decided tenant-provisioning
// requests (tenant_provisioning_requests), and newly created tenants
// (from the tenants list already loaded by the parent page). Fetched
// once on mount via a ref so a re-render of the parent's tenants array
// (a new object identity every render) doesn't cause a refetch loop.
// ─────────────────────────────────────────────────────────────────
const relativeTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
};

// ─────────────────────────────────────────────────────────────────
// System Health — the old page was 100% fabricated (fake uptime,
// latency, incident counts, and six "services" all unconditionally
// "Operational"). Nothing in this codebase actually monitors API
// gateway/inference/embeddings/runtime/audit-log uptime or latency —
// building that is real infrastructure work, out of scope for a
// dummy-data cleanup pass. The one signal that IS actually tracked is
// connector health (connectors.status/consecutive_failures/
// last_ok_at, migration 027) — this page shows that, honestly, and
// says plainly that the rest isn't monitored yet rather than faking
// it.
// ─────────────────────────────────────────────────────────────────
const PlatformHealthPage = () => {
  const [rows, setRows] = useState<PlatformConnectorHealthRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPlatformConnectorHealth().then((r) => { if (!cancelled) setRows(r); });
    return () => { cancelled = true; };
  }, []);

  const total = rows?.length ?? 0;
  const healthy = (rows || []).filter((r) => r.status === 'connected' && r.consecutive_failures === 0).length;
  const failing = (rows || []).filter((r) => r.status === 'error' || r.consecutive_failures > 0).length;
  const disconnected = (rows || []).filter((r) => r.status === 'disconnected').length;

  const statusBadge = (r: PlatformConnectorHealthRow) => {
    if (r.status === 'error' || r.consecutive_failures > 0) return <Badge label="Failing" color="red" />;
    if (r.status === 'disconnected') return <Badge label="Disconnected" color="slate" />;
    return <Badge label="Healthy" color="green" />;
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">System Health</h1>
        <p className="text-slate-400 text-sm mt-1">
          Connector health across every tenant — the one system-health signal this platform actually tracks today.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Connectors Tracked" value={String(total)} icon="◈" color="indigo" trend="All tenants" />
        <StatCard label="Healthy" value={String(healthy)} icon="✓" color="emerald" trend="No recent failures" />
        <StatCard label="Failing" value={String(failing)} icon="⚠" color={failing > 0 ? 'amber' : 'emerald'} trend={failing > 0 ? 'Needs attention' : 'None'} />
        <StatCard label="Disconnected" value={String(disconnected)} icon="◎" color="slate" trend="Never connected / removed" />
      </div>

      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-6">
        <p className="text-xs text-amber-300">
          Platform-level infrastructure metrics (API latency, uptime, error rate, incidents) aren't monitored yet —
          shown here honestly rather than with placeholder numbers.
        </p>
      </div>

      {rows === null && <p className="text-xs text-slate-500 text-center py-10">Loading connector health…</p>}
      {rows !== null && rows.length === 0 && (
        <p className="text-xs text-slate-500 text-center py-10">No connectors configured by any tenant yet.</p>
      )}
      {rows !== null && rows.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                {['Tenant', 'Connector', 'Status', 'Consecutive Failures', 'Last OK', 'Last Error'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((r) => (
                <tr key={r.connector_id} className="hover:bg-slate-800/20 transition-all">
                  <td className="px-4 py-3 text-sm text-white">{r.tenant_name}</td>
                  <td className="px-4 py-3 text-sm text-slate-300">{r.display_name || r.provider}</td>
                  <td className="px-4 py-3">{statusBadge(r)}</td>
                  <td className="px-4 py-3 text-sm text-white">{r.consecutive_failures}</td>
                  <td className="px-4 py-3 text-xs text-slate-400">{relativeTime(r.last_ok_at)}</td>
                  <td className="px-4 py-3 text-xs text-slate-400 max-w-xs truncate">{r.last_error || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

interface PlatformFeedEvent {
  key: string;
  text: string;
  time: string;
  tone: 'success' | 'warn' | 'error' | 'info';
}

const RecentPlatformEventsPanel = ({ tenants }: { tenants: Tenant[] }) => {
  const [events, setEvents] = useState<PlatformFeedEvent[] | null>(null);
  const tenantsRef = React.useRef(tenants);
  tenantsRef.current = tenants;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [accessRes, decisionsRes] = await Promise.all([
        supabase
          .from('platform_access_events')
          .select('event, tenant_id, operator_name, created_at')
          .order('created_at', { ascending: false })
          .limit(6),
        supabase
          .from('tenant_provisioning_requests')
          .select('proposed_name, status, decided_at, rejection_reason')
          .neq('status', 'pending')
          .order('decided_at', { ascending: false })
          .limit(6),
      ]);
      if (cancelled) return;

      const currentTenants = tenantsRef.current;
      const items: PlatformFeedEvent[] = [];

      ((accessRes.data as any[]) || []).forEach((row) => {
        const tenantName = currentTenants.find((t) => t.id === row.tenant_id)?.name || 'a tenant workspace';
        items.push({
          key: `ra-${row.tenant_id}-${row.created_at}-${row.event}`,
          text: row.event === 'start'
            ? `${row.operator_name || 'A platform admin'} started Remote Access into ${tenantName}`
            : `${row.operator_name || 'A platform admin'} ended a Remote Access session in ${tenantName}`,
          time: row.created_at,
          tone: 'info',
        });
      });

      ((decisionsRes.data as any[]) || []).forEach((row) => {
        items.push({
          key: `tpr-${row.proposed_name}-${row.decided_at}`,
          text: row.status === 'approved'
            ? `Tenant request approved: ${row.proposed_name}`
            : `Tenant request rejected: ${row.proposed_name}${row.rejection_reason ? ' — ' + row.rejection_reason : ''}`,
          time: row.decided_at,
          tone: row.status === 'approved' ? 'success' : 'error',
        });
      });

      [...currentTenants]
        .filter((t) => !t.name.startsWith('[TEST DEBRIS'))
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, 6)
        .forEach((t) => {
          items.push({
            key: `tenant-${t.id}`,
            text: `New tenant created: ${t.name}`,
            time: t.createdAt,
            tone: 'success',
          });
        });

      items.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
      setEvents(items.slice(0, 8));
    })();
    return () => { cancelled = true; };
  }, []);

  const toneClasses: Record<PlatformFeedEvent['tone'], string> = {
    success: 'text-emerald-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
    info: 'text-blue-400',
  };
  const toneGlyph: Record<PlatformFeedEvent['tone'], string> = {
    success: '✓',
    warn: '!',
    error: '✕',
    info: 'i',
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <h2 className="text-sm font-semibold text-white mb-4">Recent Platform Events</h2>
      {events === null && (
        <p className="text-xs text-slate-500 text-center py-6">Loading recent activity…</p>
      )}
      {events !== null && events.length === 0 && (
        <p className="text-xs text-slate-500 text-center py-6">No platform activity recorded yet.</p>
      )}
      {events !== null && events.length > 0 && (
        <div className="space-y-3">
          {events.map((e) => (
            <div key={e.key} className="flex items-start gap-3">
              <span className={`text-sm ${toneClasses[e.tone]}`}>{toneGlyph[e.tone]}</span>
              <span className="text-sm text-slate-300 flex-1">{e.text}</span>
              <span className="text-xs text-slate-600 whitespace-nowrap">{relativeTime(e.time)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// Remote Access write audit — every write made during a remote-access
// session is logged server-side by the trg_remote_access_audit trigger
// (migrations 062/063). This panel is the founder's actual window into
// that log: who changed what, in which tenant, and (at a glance) which
// fields changed. RLS on remote_access_write_log already restricts
// SELECT to is_platform_admin(), so this query is safe as-is for any
// platform-layer user viewing this page.
// ─────────────────────────────────────────────────────────────────
interface RemoteAccessWriteLogRow {
  id: number;
  session_key: string | null;
  operator_user_id: string;
  operator_name: string | null;
  tenant_id: string;
  table_name: string;
  operation: string;
  row_pk: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: string;
}

const changedFields = (row: RemoteAccessWriteLogRow): string[] => {
  if (row.operation === 'INSERT') return row.new_data ? Object.keys(row.new_data) : [];
  if (row.operation === 'DELETE') return [];
  if (!row.old_data || !row.new_data) return [];
  const keys = new Set([...Object.keys(row.old_data), ...Object.keys(row.new_data)]);
  const changed: string[] = [];
  keys.forEach((k) => {
    const before = JSON.stringify(row.old_data ? row.old_data[k] : undefined);
    const after = JSON.stringify(row.new_data ? row.new_data[k] : undefined);
    if (before !== after) changed.push(k);
  });
  return changed;
};

const operationBadgeClasses: Record<string, string> = {
  INSERT: 'bg-emerald-500/15 text-emerald-300',
  UPDATE: 'bg-blue-500/15 text-blue-300',
  DELETE: 'bg-red-500/15 text-red-300',
};

const RemoteAccessWriteAuditPanel = ({ dbTenants }: { dbTenants?: DBTenant[] }) => {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<RemoteAccessWriteLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [tenantFilter, setTenantFilter] = useState<string>('all');
  const [detailRow, setDetailRow] = useState<RemoteAccessWriteLogRow | null>(null);

  const tenantName = (tenantId: string): string => {
    const t = dbTenants?.find((dt) => dt.id === tenantId);
    return t ? t.name : tenantId.slice(0, 8) + '…';
  };

  const load = async () => {
    setLoading(true);
    setError('');
    const { data, error: qError } = await supabase
      .from('remote_access_write_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    setLoading(false);
    setLoaded(true);
    if (qError) {
      setError(qError.message);
      return;
    }
    setRows((data as RemoteAccessWriteLogRow[]) || []);
  };

  useEffect(() => {
    if (expanded && !loaded) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const visibleRows = tenantFilter === 'all' ? rows : rows.filter((r) => r.tenant_id === tenantFilter);
  const tenantIdsInLog = Array.from(new Set(rows.map((r) => r.tenant_id)));

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mt-6">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left"
      >
        <div>
          <p className="text-sm font-semibold text-white">Write audit log</p>
          <p className="text-xs text-slate-400 mt-0.5">
            Every change made to a tenant's data during a remote-access session — who, what, and where.
          </p>
        </div>
        <span className="text-xs text-slate-500 flex-shrink-0">{expanded ? 'Hide ▲' : 'Show ▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-5 py-4">
          {loading && <p className="text-xs text-slate-500 py-4 text-center">Loading write log…</p>}
          {!loading && error && <p className="text-xs text-red-400 py-2">{error}</p>}

          {!loading && !error && (
            <>
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500">Tenant</label>
                  <select
                    value={tenantFilter}
                    onChange={(e) => setTenantFilter(e.target.value)}
                    className="bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-amber-500"
                  >
                    <option value="all">All tenants</option>
                    {tenantIdsInLog.map((tid) => (
                      <option key={tid} value={tid}>{tenantName(tid)}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={load}
                  className="text-xs px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-all"
                >
                  Refresh
                </button>
              </div>

              {visibleRows.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center">
                  No remote-access writes recorded{tenantFilter !== 'all' ? ' for this tenant' : ''} yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-800">
                        <th className="px-3 py-2 text-xs font-medium text-slate-500">When</th>
                        <th className="px-3 py-2 text-xs font-medium text-slate-500">Who</th>
                        <th className="px-3 py-2 text-xs font-medium text-slate-500">Tenant</th>
                        <th className="px-3 py-2 text-xs font-medium text-slate-500">Table</th>
                        <th className="px-3 py-2 text-xs font-medium text-slate-500">Operation</th>
                        <th className="px-3 py-2 text-xs font-medium text-slate-500">Changed fields</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {visibleRows.map((row) => {
                        const fields = changedFields(row);
                        return (
                          <tr
                            key={row.id}
                            onClick={() => setDetailRow(row)}
                            className="cursor-pointer hover:bg-slate-800/50 transition-all"
                          >
                            <td className="px-3 py-2.5 text-xs text-slate-400 whitespace-nowrap">
                              {new Date(row.created_at).toLocaleString()}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-white whitespace-nowrap">
                              {row.operator_name || 'Platform admin'}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-slate-300 whitespace-nowrap">
                              {tenantName(row.tenant_id)}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-slate-300 font-mono">{row.table_name}</td>
                            <td className="px-3 py-2.5">
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${operationBadgeClasses[row.operation] || 'bg-slate-700 text-slate-300'}`}>
                                {row.operation}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-xs text-slate-400 max-w-xs truncate">
                              {fields.length > 0 ? fields.join(', ') : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {detailRow && (
        <Modal
          title={`${detailRow.table_name} · ${detailRow.operation}`}
          onClose={() => setDetailRow(null)}
        >
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            <div className="text-xs text-slate-400 space-y-1">
              <div><span className="text-slate-500">When:</span> {new Date(detailRow.created_at).toLocaleString()}</div>
              <div><span className="text-slate-500">Who:</span> {detailRow.operator_name || 'Platform admin'}</div>
              <div><span className="text-slate-500">Tenant:</span> {tenantName(detailRow.tenant_id)}</div>
              <div><span className="text-slate-500">Row:</span> <span className="font-mono">{detailRow.row_pk || '—'}</span></div>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Changed fields</p>
              {changedFields(detailRow).length === 0 ? (
                <p className="text-xs text-slate-500">No field-level changes to show.</p>
              ) : (
                <div className="space-y-2">
                  {changedFields(detailRow).map((field) => (
                    <div key={field} className="bg-slate-800 rounded-xl p-3">
                      <div className="text-xs font-mono text-amber-300 mb-1">{field}</div>
                      <div className="text-xs text-slate-400 space-y-1">
                        <div>
                          <span className="text-slate-500">before:</span>{' '}
                          <span className="font-mono break-all">
                            {detailRow.old_data ? JSON.stringify(detailRow.old_data[field]) : '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500">after:</span>{' '}
                          <span className="font-mono break-all text-white">
                            {detailRow.new_data ? JSON.stringify(detailRow.new_data[field]) : '—'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// Pending sub-tenant creation approvals — requests routed to the
// platform (not the parent tenant) because the parent hasn't earned
// self-serve sub-tenant creation yet (migration 050). Plain language:
// a tenant asked to create a sub-account, and it's waiting on us.
// ─────────────────────────────────────────────────────────────────
const PendingApprovalsPanel = () => {
  const [requests, setRequests] = useState<TenantProvisioningRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejectTarget, setRejectTarget] = useState<TenantProvisioningRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetchPendingProvisioningRequests().then((rows) => {
      setRequests(rows);
      setLoading(false);
    });
  };

  useEffect(() => { load(); }, []);

  const handleApprove = async (id: string) => {
    setBusyId(id);
    await approveSubtenantRequest(id);
    setBusyId(null);
    load();
  };

  const handleReject = async () => {
    if (!rejectTarget || !rejectReason.trim()) return;
    setBusyId(rejectTarget.id);
    await rejectSubtenantRequest(rejectTarget.id, rejectReason.trim());
    setBusyId(null);
    setRejectTarget(null);
    setRejectReason('');
    load();
  };

  if (loading) return null;
  if (requests.length === 0) return null;

  return (
    <div className="bg-slate-900 border border-amber-500/30 rounded-xl overflow-hidden mb-6">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">Waiting on your approval</p>
          <p className="text-xs text-slate-400 mt-0.5">
            These tenants asked to create a sub-account. Nothing is created until you approve or reject.
          </p>
        </div>
        <span className="text-xs px-2 py-1 rounded-full bg-amber-500/15 text-amber-300 font-medium">
          {requests.length} pending
        </span>
      </div>
      <div className="divide-y divide-slate-800">
        {requests.map((r) => (
          <div key={r.id} className="px-5 py-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm text-white font-medium">{r.proposed_name}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {r.proposed_industry ? r.proposed_industry + ' · ' : ''}
                requested {new Date(r.created_at).toLocaleString()}
                {r.proposed_parent_tenant_id ? ' · sub-tenant request' : ' · new top-level tenant'}
              </div>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <button
                disabled={busyId === r.id}
                onClick={() => handleApprove(r.id)}
                className="text-xs px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 rounded-lg transition-all disabled:opacity-50"
              >
                Approve
              </button>
              <button
                disabled={busyId === r.id}
                onClick={() => setRejectTarget(r)}
                className="text-xs px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg transition-all disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
      {rejectTarget && (
        <Modal title={'Reject request — ' + rejectTarget.proposed_name} onClose={() => setRejectTarget(null)}>
          <div className="space-y-4">
            <p className="text-xs text-slate-400">
              Tell the requester why this sub-tenant isn't being created. This reason is recorded and visible to them.
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. Please provide more detail about the intended use case"
              className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-red-500 min-h-[90px]"
            />
            <button
              disabled={!rejectReason.trim()}
              onClick={handleReject}
              className="w-full py-2.5 text-sm font-medium rounded-xl text-white bg-red-600 hover:bg-red-500 transition-all disabled:opacity-50"
            >
              Confirm rejection
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// Self-serve toggle — plain-language on/off switch for
// tenants.allow_self_serve_subtenants.
// ─────────────────────────────────────────────────────────────────
const SelfServeToggle = ({ tenant, onChanged }: { tenant: Tenant; onChanged: (v: boolean) => void }) => {
  const [enabled, setEnabled] = useState(!!tenant.allowSelfServeSubtenants);
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    const next = !enabled;
    setSaving(true);
    const ok = await setTenantSelfServe(tenant.id, next);
    setSaving(false);
    if (ok) {
      setEnabled(next);
      onChanged(next);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={saving}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
        enabled ? 'bg-emerald-600' : 'bg-slate-700'
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
};

// ─────────────────────────────────────────────────────────────────
// Suspend / reactivate — the tenant-status write path, gated server-
// side on tenants.manage (migration 081). Suspending asks for a plain
// confirm click (it's reversible via the same button) rather than a
// separate modal, matching this page's existing lightweight style.
// ─────────────────────────────────────────────────────────────────
const SuspendToggle = ({ tenant, onChanged }: { tenant: Tenant; onChanged: (status: Tenant['status']) => void }) => {
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isSuspended = tenant.status === 'suspended';

  const apply = async () => {
    const nextStatus = isSuspended ? 'active' : 'suspended';
    setSaving(true);
    const res = await setTenantStatus(tenant.id, nextStatus);
    setSaving(false);
    setConfirming(false);
    if (res.ok) onChanged(nextStatus);
  };

  if (!isSuspended && confirming) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={apply}
          disabled={saving}
          className="px-4 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-xl transition-all disabled:opacity-50"
        >
          {saving ? 'Suspending…' : 'Confirm suspend'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="px-3 py-2.5 text-sm text-slate-400 hover:text-white transition-all"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => (isSuspended ? apply() : setConfirming(true))}
      disabled={saving}
      className={`px-4 py-2.5 text-sm font-medium rounded-xl transition-all disabled:opacity-50 ${
        isSuspended
          ? 'text-emerald-300 bg-emerald-500/20 hover:bg-emerald-500/30'
          : 'text-slate-400 hover:text-white bg-slate-800'
      }`}
    >
      {saving ? 'Working…' : isSuspended ? 'Reactivate' : 'Suspend'}
    </button>
  );
};

// ─────────────────────────────────────────────────────────────────
// Provision Tenant — the platform-admin fast path already built into
// request_subtenant (p_parent_tenant_id=null + tenants.provision):
// creates the tenant directly, no approval step, since the caller IS
// the approver.
// ─────────────────────────────────────────────────────────────────
const ProvisionTenantModal = ({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) => {
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) { setError('Tenant name is required.'); return; }
    setSaving(true);
    setError('');
    const res = await requestSubtenant(null, name.trim(), industry.trim() || undefined);
    setSaving(false);
    if (res && (res as any).ok) {
      onCreated();
    } else {
      setError((res as any)?.error || 'Could not create the tenant. Please try again.');
    }
  };

  return (
    <Modal title="Provision a new tenant" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Tenant name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Manufacturing"
            className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Industry (optional)</label>
          <input
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            placeholder="e.g. Manufacturing"
            className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          onClick={submit}
          disabled={saving || !name.trim()}
          className="w-full py-2.5 text-sm font-medium rounded-xl text-white bg-indigo-600 hover:bg-indigo-500 transition-all disabled:opacity-50"
        >
          {saving ? 'Creating…' : 'Create tenant'}
        </button>
      </div>
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────────
// Feature toggle panel — every feature_registry entry, with a live
// on/off switch reflecting tenant_feature_overrides, defaulting to the
// registry default when no override exists. Plain language throughout.
// ─────────────────────────────────────────────────────────────────
const FeatureTogglePanel = ({ tenant }: { tenant: Tenant }) => {
  const [registry, setRegistry] = useState<FeatureRegistryEntry[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchFeatureRegistry(), fetchTenantFeatureOverrides(tenant.id)]).then(([reg, over]) => {
      setRegistry(reg);
      const map: Record<string, boolean> = {};
      over.forEach((o) => { map[o.feature_key] = o.enabled; });
      setOverrides(map);
      setLoading(false);
    });
  }, [tenant.id]);

  const handleToggle = async (key: string, currentlyOn: boolean) => {
    setSavingKey(key);
    const next = !currentlyOn;
    const res = await setTenantFeatureOverride(tenant.id, key, next);
    setSavingKey(null);
    if (res.ok) setOverrides((prev) => ({ ...prev, [key]: next }));
  };

  if (loading) return <div className="text-xs text-slate-500 py-6 text-center">Loading features…</div>;

  const categories = Array.from(new Set(registry.map((r) => r.category || 'other')));

  return (
    <div className="space-y-4 max-h-[65vh] overflow-y-auto">
      {categories.map((cat) => (
        <div key={cat}>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">{cat.replace(/_/g, ' ')}</p>
          <div className="space-y-2">
            {registry.filter((r) => (r.category || 'other') === cat).map((r) => {
              const hasOverride = Object.prototype.hasOwnProperty.call(overrides, r.key);
              const isOn = hasOverride ? overrides[r.key] : r.default_enabled;
              return (
                <div key={r.key} className="bg-slate-800 rounded-xl p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-white font-medium">{r.label}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {r.description} · {r.default_enabled ? 'ON by default' : 'OFF by default'},
                      {' '}currently {isOn ? 'ON' : 'OFF'} for this tenant{hasOverride ? ' (custom override)' : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => handleToggle(r.key, isOn)}
                    disabled={savingKey === r.key}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
                      isOn ? 'bg-emerald-600' : 'bg-slate-700'
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isOn ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

export default PlatformConsolePage;
