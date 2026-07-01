import React from 'react';
import type { Page, AuthUser, Tenant } from '../types';

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
  const isDT = [
    'dt_super_admin',
    'dt_god_access',
    'dt_support',
    'dt_billing',
  ].includes(user.role);
  const isOwnerOrAdmin = ['tenant_owner', 'tenant_admin'].includes(user.role);
  const accentColor = tenant?.primaryColor || '#6366f1';

  const NavItem = ({
    id,
    label,
    icon,
  }: {
    id: Page;
    label: string;
    icon: string;
  }) => {
    const groupOf = (p: string): string => {
      if (p === 'hub_overview' || p.startsWith('hub_') || p.startsWith('knowledge_')) return 'knowledge';
      if (p === 'portal_overview' || p.startsWith('portal_')) return 'portal';
      if (p === 'agents' || p === 'swarm') return 'agents';
      if (p === 'cs') return 'cs';
      if (p === 'control_fabric') return 'control_fabric';
      if (p === 'capabilities') return 'capabilities';
      if (p === 'intelligence') return 'intelligence';
      if (p === 'security' || p === 'integrations' || p === 'connectors' || p === 'settings') return 'admin';
      return p;
    };
    const active = groupOf(page) === groupOf(id);
    return (
      <button
        onClick={() => setPage(id)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
          active
            ? 'text-white shadow-lg'
            : 'text-slate-400 hover:text-white hover:bg-white/5'
        }`}
        style={
          active
            ? {
                backgroundColor: accentColor + '30',
                borderLeft: `3px solid ${accentColor}`,
              }
            : {}
        }
      >
        <span className="text-base w-5 text-center flex-shrink-0">{icon}</span>
        {!collapsed && (
          <span className="flex-1 text-left truncate">{label}</span>
        )}
      </button>
    );
  };

  const Section = ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) => (
    <div className="mb-2">
      {!collapsed && (
        <p className="text-xs text-slate-600 uppercase tracking-widest px-3 py-2 font-semibold">
          {title}
        </p>
      )}
      {children}
    </div>
  );

  return (
    <div
      className={`h-screen flex flex-col border-r border-slate-800 bg-slate-950 transition-all duration-300 ${
        collapsed ? 'w-16' : 'w-64'
      }`}
    >
      <div className="flex items-center justify-between px-4 py-4 border-b border-slate-800">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold"
              style={{
                background: `linear-gradient(135deg, ${accentColor}, ${accentColor}80)`,
              }}
            >
              DT
            </div>
            <div>
              <div className="text-sm font-bold text-white">
                {tenant ? tenant.name : 'DreamTeam AI'}
              </div>
              <div className="text-xs text-slate-500">
                {tenant ? 'AI Platform' : 'Platform Console'}
              </div>
            </div>
          </div>
        )}
        {collapsed && (
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold mx-auto"
            style={{
              background: `linear-gradient(135deg, ${accentColor}, ${accentColor}80)`,
            }}
          >
            DT
          </div>
        )}
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className="text-slate-600 hover:text-slate-400 text-lg"
          >
            x
          </button>
        )}
      </div>

      {godModeActive && !collapsed && (
        <div className="mx-3 mt-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-sm">!</span>
            <span className="text-xs text-amber-300 font-medium">
              Support Access Active
            </span>
          </div>
          <button
            onClick={exitGodMode}
            className="text-xs text-amber-500 hover:text-amber-300 mt-1 underline"
          >
            Exit session
          </button>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
        {isDT ? (
          <>
            <Section title="Platform">
              <NavItem id="platform_home" label="Overview" icon="◐" />
              <NavItem id="platform_tenants" label="Tenants" icon="⊞" />
              <NavItem
                id="platform_remote_access"
                label="Remote Access"
                icon="⇄"
              />
              <NavItem id="platform_health" label="System Health" icon="✚" />
              <NavItem id="platform_revenue" label="Revenue" icon="◎" />
            </Section>
          </>
        ) : (
        <>
          <Section title="Workspace">
            <NavItem id="dashboard" label="Workforce HQ" icon="⌘" />
            <NavItem id="agents" label="Digital Employees" icon="⚡" />
            <NavItem id="hub_overview" label="Knowledge Hub" icon="◈" />
            <NavItem id="portal_overview" label="Customer Portal" icon="◎" />
            <NavItem id="insight" label="Insight Engine" icon="⚛" />
            <NavItem id="finance" label="Finance Control Tower" icon="🏦" />
            <NavItem id="revenue" label="Revenue Workspace" icon="$" />
            <NavItem id="hr" label="HR Workspace" icon="◉" />
            <NavItem id="cs" label="Customer Success" icon="★" />
            <NavItem id="implementation" label="Implementation" icon="⊞" />
            <NavItem id="marketplace" label="Marketplace" icon="⊕" />
          </Section>
          {isOwnerOrAdmin && (
            <Section title="Intelligence">
              <NavItem id="control_fabric" label="Control Fabric" icon="⇄" />
              <NavItem id="capabilities" label="Capabilities" icon="⚡" />
              <NavItem id="intelligence" label="AI Config" icon="⚛" />
            </Section>
          )}
          {isOwnerOrAdmin && (
            <Section title="Administration">
              <NavItem id="users" label="Team Members" icon="◉" />
              <NavItem id="security" label="Admin" icon="⚠" />
              <NavItem id="audit_log" label="Audit Log" icon="≡" />
            </Section>
          )}
        </>
        )}
      </nav>

      <div className="border-t border-slate-800 px-3 py-3">
        {!collapsed ? (
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
              style={{
                background: `linear-gradient(135deg, ${accentColor}, ${accentColor}90)`,
              }}
            >
              {user.avatar || user.name[0]}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-white truncate">
                {user.name}
              </div>
              <div className="text-xs text-slate-500 truncate">
                {user.role.replace(/_/g, ' ')}
              </div>
            </div>
          </div>
        ) : (
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white mx-auto"
            style={{
              background: `linear-gradient(135deg, ${accentColor}, ${accentColor}90)`,
            }}
          >
            {user.avatar || user.name[0]}
          </div>
        )}
        {!collapsed && onLogout && (
          <button
            onClick={onLogout}
            className="w-full mt-2 flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
          >
            <span>Sign Out</span>
          </button>
        )}
        {collapsed && (
          <button
            onClick={() => setCollapsed(false)}
            className="w-full mt-2 text-slate-600 hover:text-slate-400 text-xs text-center"
          >
            o
          </button>
        )}
      </div>
    </div>
  );
};

export default Sidebar;
