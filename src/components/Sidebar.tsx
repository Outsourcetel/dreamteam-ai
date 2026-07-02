import React, { useState } from 'react';
import type { Page, AuthUser, Tenant } from '../types';

// Maps each service nav item to which pages count as "active" for it
const SERVICE_GROUPS: Record<string, string[]> = {
  portal_overview: [
    'portal_overview', 'portal_conversations', 'portal_escalations',
    'portal_actions', 'portal_approvals', 'portal_tickets', 'portal_settings', 'eu_chat', 'portal_email',
  ],
  finance: ['finance'],
  revenue: ['revenue'],
  hr: ['hr'],
  cs: ['cs'],
  implementation: ['implementation'],
};

const Sidebar = ({
  page,
  setPage,
  user,
  tenant,
  collapsed,
  setCollapsed,
  godModeActive,
  exitGodMode,
  onLogout,
}: {
  page: Page;
  setPage: (p: Page) => void;
  user: AuthUser;
  tenant?: Tenant;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  godModeActive?: boolean;
  exitGodMode?: () => void;
  onLogout?: () => void;
}) => {
  const isDT = ['dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing'].includes(user.role);
  const isOwnerOrAdmin = ['tenant_owner', 'tenant_admin'].includes(user.role);
  const accentColor = tenant?.primaryColor || '#6366f1';

  const [servicesOpen, setServicesOpen] = useState(true);

  // Which top-level group is the current page in?
  const activeGroup = (p: string): string => {
    if (p === 'dashboard') return 'dashboard';
    if (p === 'agents' || p === 'swarm') return 'agents';
    if (p === 'hub_overview' || p.startsWith('hub_') || p.startsWith('knowledge_')) return 'knowledge';
    if (p === 'playbooks') return 'playbooks';
    if (p === 'insight') return 'insight';
    if (p === 'control_fabric') return 'control_fabric';
    if (p === 'capabilities') return 'capabilities';
    if (p === 'intelligence') return 'intelligence';
    if (p === 'users') return 'users';
    if (p === 'admin_approvals') return 'admin_approvals';
    if (p === 'audit_log') return 'audit_log';
    if (p === 'security' || p === 'integrations' || p === 'connectors' || p === 'settings') return 'admin';
    if (p === 'marketplace') return 'marketplace';
    // Services
    for (const [key, pages] of Object.entries(SERVICE_GROUPS)) {
      if (pages.includes(p)) return `service_${key}`;
    }
    return p;
  };

  const isActive = (id: Page) => activeGroup(page) === activeGroup(id);
  const isServiceActive = (serviceId: string) =>
    (SERVICE_GROUPS[serviceId] ?? [serviceId]).includes(page);

  const NavItem = ({ id, label, icon, indent = false }: { id: Page; label: string; icon: string; indent?: boolean }) => {
    const active = isActive(id);
    return (
      <button
        onClick={() => setPage(id)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
          indent && !collapsed ? 'pl-7' : ''
        } ${active ? 'text-white shadow-sm' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
        style={active ? { backgroundColor: accentColor + '28', borderLeft: `3px solid ${accentColor}` } : {}}
        title={collapsed ? label : undefined}
      >
        <span className="text-base w-5 text-center flex-shrink-0">{icon}</span>
        {!collapsed && <span className="flex-1 text-left truncate">{label}</span>}
      </button>
    );
  };

  // Service item — highlights when any of the service's pages are active
  const ServiceItem = ({ id, label, icon }: { id: string; label: string; icon: string }) => {
    const active = isServiceActive(id);
    return (
      <button
        onClick={() => setPage(id as Page)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
          active ? 'text-white shadow-sm' : 'text-slate-400 hover:text-white hover:bg-white/5'
        }`}
        style={active ? { backgroundColor: accentColor + '28', borderLeft: `3px solid ${accentColor}` } : {}}
        title={collapsed ? label : undefined}
      >
        <span className="text-base w-5 text-center flex-shrink-0">{icon}</span>
        {!collapsed && <span className="flex-1 text-left truncate">{label}</span>}
      </button>
    );
  };

  const Section = ({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) => (
    <div className="mb-1">
      {!collapsed && (
        <div className="flex items-center justify-between px-3 pt-4 pb-1">
          <p className="text-xs text-slate-600 uppercase tracking-widest font-semibold">{title}</p>
          {action}
        </div>
      )}
      {collapsed && <div className="h-3" />}
      {children}
    </div>
  );

  const Divider = () => <div className="border-t border-slate-800/60 mx-3 my-2" />;

  return (
    <div className={`h-screen flex flex-col border-r border-slate-800 bg-slate-950 transition-all duration-300 ${collapsed ? 'w-16' : 'w-64'}`}>

      {/* Logo */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-slate-800">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold"
              style={{ background: `linear-gradient(135deg, ${accentColor}, ${accentColor}80)` }}>
              DT
            </div>
            <div>
              <div className="text-sm font-bold text-white">{tenant ? tenant.name : 'DreamTeam AI'}</div>
              <div className="text-xs text-slate-500">{tenant ? 'Workforce OS' : 'Platform Console'}</div>
            </div>
          </div>
        )}
        {collapsed && (
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold mx-auto"
            style={{ background: `linear-gradient(135deg, ${accentColor}, ${accentColor}80)` }}>
            DT
          </div>
        )}
        {!collapsed && (
          <button onClick={() => setCollapsed(true)} className="text-slate-600 hover:text-slate-400 text-lg">×</button>
        )}
      </div>

      {/* God Mode Banner */}
      {godModeActive && !collapsed && (
        <div className="mx-3 mt-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-sm">!</span>
            <span className="text-xs text-amber-300 font-medium">Support Access Active</span>
          </div>
          <button onClick={exitGodMode} className="text-xs text-amber-500 hover:text-amber-300 mt-1 underline">
            Exit session
          </button>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto py-2 px-2">

        {/* ── PLATFORM CONSOLE (DT staff only) ── */}
        {isDT ? (
          <Section title="Platform">
            <NavItem id="platform_home" label="Overview" icon="◐" />
            <NavItem id="platform_tenants" label="Tenants" icon="⊞" />
            <NavItem id="platform_remote_access" label="Remote Access" icon="⇄" />
            <NavItem id="platform_health" label="System Health" icon="✚" />
            <NavItem id="platform_revenue" label="Revenue" icon="◎" />
          </Section>
        ) : (
          <>
            {/* ── HOME ── */}
            <div className="mb-1">
              <NavItem id="dashboard" label="Workforce HQ" icon="⌘" />
            </div>

            <Divider />

            {/* ── SERVICES ── */}
            <div className="mb-1">
              {!collapsed && (
                <div className="flex items-center justify-between px-3 pt-3 pb-1">
                  <p className="text-xs text-slate-600 uppercase tracking-widest font-semibold">Services</p>
                  <button
                    onClick={() => setServicesOpen(v => !v)}
                    className="text-slate-600 hover:text-slate-400 text-xs transition-colors"
                  >
                    {servicesOpen ? '▲' : '▼'}
                  </button>
                </div>
              )}
              {collapsed && <div className="h-3" />}
              {(servicesOpen || collapsed) && (
                <>
                  <ServiceItem id="portal_overview" label="Customer Support" icon="◎" />
                  <ServiceItem id="hr" label="HR & People" icon="◉" />
                  <ServiceItem id="finance" label="Finance & Billing" icon="⬡" />
                  <ServiceItem id="revenue" label="Revenue Operations" icon="◆" />
                  <ServiceItem id="cs" label="Customer Success" icon="★" />
                  <ServiceItem id="implementation" label="Implementation" icon="⊞" />
                  {!collapsed && (
                    <button
                      onClick={() => setPage('marketplace')}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-slate-600 hover:text-indigo-400 transition-all border border-dashed border-slate-800 hover:border-indigo-800 mt-1"
                    >
                      <span className="w-5 text-center">⊕</span>
                      <span>Add Service</span>
                    </button>
                  )}
                </>
              )}
            </div>

            <Divider />

            {/* ── BUILD ── */}
            <Section title="Build">
              <NavItem id="agents" label="Digital Employees" icon="⚡" />
              <NavItem id="hub_overview" label="Knowledge Hub" icon="◈" />
              <NavItem id="playbooks" label="Playbooks" icon="▦" />
            </Section>

            <Divider />

            {/* ── INTELLIGENCE ── */}
            {isOwnerOrAdmin && (
              <Section title="Intelligence">
                <NavItem id="insight" label="Insight Engine" icon="⚛" />
                <NavItem id="control_fabric" label="Control Fabric" icon="⇄" />
                <NavItem id="intelligence" label="AI Config" icon="◐" />
              </Section>
            )}

            {isOwnerOrAdmin && <Divider />}

            {/* ── ADMINISTRATION ── */}
            {isOwnerOrAdmin && (
              <Section title="Administration">
                <NavItem id="users" label="Team Members" icon="◉" />
                <NavItem id="admin_approvals" label="Approvals" icon="✓" />
                <NavItem id="audit_log" label="Audit Log" icon="≡" />
                <NavItem id="security" label="Platform Config" icon="⚙" />
                <NavItem id="marketplace" label="Marketplace" icon="⊕" />
              </Section>
            )}
          </>
        )}
      </nav>

      {/* User footer */}
      <div className="border-t border-slate-800 px-3 py-3">
        {!collapsed ? (
          <>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                style={{ background: `linear-gradient(135deg, ${accentColor}, ${accentColor}90)` }}>
                {user.avatar || user.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-white truncate">{user.name}</div>
                <div className="text-xs text-slate-500 truncate">{user.role.replace(/_/g, ' ')}</div>
              </div>
            </div>
            {onLogout && (
              <button
                onClick={onLogout}
                className="w-full mt-2 flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
              >
                Sign Out
              </button>
            )}
          </>
        ) : (
          <>
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white mx-auto"
              style={{ background: `linear-gradient(135deg, ${accentColor}, ${accentColor}90)` }}>
              {user.avatar || user.name[0]}
            </div>
            <button
              onClick={() => setCollapsed(false)}
              className="w-full mt-2 text-slate-600 hover:text-slate-400 text-xs text-center"
            >
              →
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default Sidebar;
