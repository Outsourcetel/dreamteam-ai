import React, { useState, useEffect, useRef } from 'react';
import { supabase } from './supabase';
import {
  fetchTenants, fetchKnowledgeArticles, fetchConversations,
  fetchDashboardStats, fetchMyProfile,
  createConversation, createMessage,
  DBTenant, DBKnowledgeArticle, DBConversation
} from './lib/api';

// ============================================================
// TYPES - 3-LAYER ARCHITECTURE
// ============================================================

type PlatformPage =
  | 'platform_home'
  | 'platform_tenants'
  | 'platform_tenant_detail'
  | 'platform_remote_access'
  | 'platform_health'
  | 'platform_revenue';

type TenantPage =
  | 'dashboard'
  | 'agents'
  | 'swarm'
  | 'insight'
  | 'security'
  | 'integrations'
  | 'connectors'
  | 'settings'
  | 'hub_overview'
  | 'hub_articles'
  | 'hub_ingestion'
  | 'hub_training'
  | 'hub_analytics'
  | 'portal_overview'
  | 'portal_conversations'
  | 'portal_actions'
  | 'portal_approvals'
  | 'portal_tickets'
  | 'portal_settings'
  | 'knowledge_data'
  | 'knowledge_taxonomy'
  | 'knowledge_connectors'
  | 'knowledge_files';

type EndUserPage = 'eu_chat' | 'eu_actions' | 'eu_tickets';
type Page = PlatformPage | TenantPage | EndUserPage;

type UserRole =
  | 'dt_super_admin'
  | 'dt_god_access'
  | 'dt_support'
  | 'dt_billing'
  | 'tenant_owner'
  | 'tenant_admin'
  | 'tenant_manager'
  | 'tenant_user';

interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  tenantId?: string;
  avatar?: string;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  primaryColor: string;
  accentColor?: string;
  plan: 'starter' | 'growth' | 'enterprise';
  status: 'active' | 'suspended' | 'trial';
  agentsActive: number;
  usersCount: number;
  monthlyTokens: number;
  tokenLimit: number;
  createdAt: string;
  industry: string;
  contactEmail: string;
}

// ============================================================
// MOCK DATA
// ============================================================

const mockTenants: Tenant[] = [
  {
    id: 't1',
    name: 'Acme Corp',
    slug: 'acme',
    primaryColor: '#6366f1',
    plan: 'enterprise',
    status: 'active',
    agentsActive: 8,
    usersCount: 142,
    monthlyTokens: 2400000,
    tokenLimit: 5000000,
    createdAt: '2024-01-15',
    industry: 'SaaS',
    contactEmail: 'admin@acme.com',
  },
  {
    id: 't2',
    name: 'Globex Inc',
    slug: 'globex',
    primaryColor: '#10b981',
    plan: 'growth',
    status: 'active',
    agentsActive: 5,
    usersCount: 67,
    monthlyTokens: 980000,
    tokenLimit: 2000000,
    createdAt: '2024-03-20',
    industry: 'Manufacturing',
    contactEmail: 'it@globex.com',
  },
  {
    id: 't3',
    name: 'Initech Solutions',
    slug: 'initech',
    primaryColor: '#f59e0b',
    plan: 'starter',
    status: 'trial',
    agentsActive: 2,
    usersCount: 18,
    monthlyTokens: 120000,
    tokenLimit: 500000,
    createdAt: '2024-05-01',
    industry: 'Finance',
    contactEmail: 'cto@initech.com',
  },
  {
    id: 't4',
    name: 'Hooli Technologies',
    slug: 'hooli',
    primaryColor: '#ef4444',
    plan: 'enterprise',
    status: 'active',
    agentsActive: 12,
    usersCount: 340,
    monthlyTokens: 8100000,
    tokenLimit: 10000000,
    createdAt: '2023-11-08',
    industry: 'Technology',
    contactEmail: 'ops@hooli.com',
  },
  {
    id: 't5',
    name: 'Pied Piper',
    slug: 'piedpiper',
    primaryColor: '#8b5cf6',
    plan: 'growth',
    status: 'suspended',
    agentsActive: 0,
    usersCount: 22,
    monthlyTokens: 0,
    tokenLimit: 2000000,
    createdAt: '2024-02-14',
    industry: 'SaaS',
    contactEmail: 'admin@piedpiper.com',
  },
  {
    id: 't6',
    name: 'Umbrella Medical',
    slug: 'umbrella',
    primaryColor: '#0ea5e9',
    plan: 'enterprise',
    status: 'active',
    agentsActive: 7,
    usersCount: 89,
    monthlyTokens: 3200000,
    tokenLimit: 5000000,
    createdAt: '2024-04-03',
    industry: 'Healthcare',
    contactEmail: 'digital@umbrella.com',
  },
];

const mockUsers: AuthUser[] = [
  {
    id: 'u1',
    name: 'Alex Rivera',
    email: 'alex@dreamteam.ai',
    role: 'dt_super_admin',
    avatar: 'AR',
  },
  {
    id: 'u2',
    name: 'Jordan Blake',
    email: 'jordan@dreamteam.ai',
    role: 'dt_god_access',
    avatar: 'JB',
  },
  {
    id: 'u3',
    name: 'Sam Nguyen',
    email: 'sam@dreamteam.ai',
    role: 'dt_support',
    avatar: 'SN',
  },
  {
    id: 'u4',
    name: 'Chris Lee',
    email: 'chris@dreamteam.ai',
    role: 'dt_billing',
    avatar: 'CL',
  },
  {
    id: 'u5',
    name: 'Morgan Chen',
    email: 'morgan@acme.com',
    role: 'tenant_owner',
    tenantId: 't1',
    avatar: 'MC',
  },
  {
    id: 'u6',
    name: 'Taylor Smith',
    email: 'taylor@acme.com',
    role: 'tenant_admin',
    tenantId: 't1',
    avatar: 'TS',
  },
  {
    id: 'u7',
    name: 'Quinn Park',
    email: 'quinn@acme.com',
    role: 'tenant_manager',
    tenantId: 't1',
    avatar: 'QP',
  },
  {
    id: 'u8',
    name: 'Drew Wilson',
    email: 'drew@acme.com',
    role: 'tenant_user',
    tenantId: 't1',
    avatar: 'DW',
  },
  {
    id: 'u9',
    name: 'Jamie Torres',
    email: 'jamie@globex.com',
    role: 'tenant_owner',
    tenantId: 't2',
    avatar: 'JT',
  },
  {
    id: 'u10',
    name: 'Avery Johnson',
    email: 'avery@hooli.com',
    role: 'tenant_owner',
    tenantId: 't4',
    avatar: 'AJ',
  },
];

const canAccessPage = (role: UserRole, page: Page): boolean => {
  const isDtRole = [
    'dt_super_admin',
    'dt_god_access',
    'dt_support',
    'dt_billing',
  ].includes(role);
  const isTenantRole = [
    'tenant_owner',
    'tenant_admin',
    'tenant_manager',
    'tenant_user',
  ].includes(role);
  const dtOnlyPages = [
    'platform_home',
    'platform_tenants',
    'platform_tenant_detail',
    'platform_remote_access',
    'platform_health',
    'platform_revenue',
  ];
  if (dtOnlyPages.includes(page)) return isDtRole;
  return isTenantRole || isDtRole;
};

// ============================================================
// SHARED UI PRIMITIVES
// ============================================================

const Badge = ({
  label,
  color = 'slate',
}: {
  label: string;
  color?: string;
}) => {
  const colors: Record<string, string> = {
    green: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
    red: 'bg-red-500/20 text-red-300 border border-red-500/30',
    yellow: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
    blue: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
    purple: 'bg-purple-500/20 text-purple-300 border border-purple-500/30',
    slate: 'bg-slate-500/20 text-slate-300 border border-slate-500/30',
    indigo: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30',
    amber: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        colors[color] || colors.slate
      }`}
    >
      {label}
    </span>
  );
};

const StatCard = ({
  label,
  value,
  sub,
  icon,
  trend,
  color = 'indigo',
}: {
  label: string;
  value: string;
  sub?: string;
  icon: string;
  trend?: string;
  color?: string;
}) => {
  const colors: Record<string, string> = {
    indigo: 'from-indigo-500/20 to-indigo-600/10 border-indigo-500/20',
    emerald: 'from-emerald-500/20 to-emerald-600/10 border-emerald-500/20',
    amber: 'from-amber-500/20 to-amber-600/10 border-amber-500/20',
    blue: 'from-blue-500/20 to-blue-600/10 border-blue-500/20',
    purple: 'from-purple-500/20 to-purple-600/10 border-purple-500/20',
    red: 'from-red-500/20 to-red-600/10 border-red-500/20',
  };
  return (
    <div
      className={`bg-gradient-to-br ${
        colors[color] || colors.indigo
      } border rounded-xl p-4`}
    >
      <div className="flex items-start justify-between mb-3">
        <span className="text-xl">{icon}</span>
        {trend && <span className="text-xs text-emerald-400">{trend}</span>}
      </div>
      <div className="text-2xl font-bold text-white mb-1">{value}</div>
      <div className="text-sm text-slate-400">{label}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
};

const MiniLineChart = ({
  data,
  color = '#6366f1',
}: {
  data: number[];
  color?: string;
}) => {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 120;
  const h = 36;
  const pad = 4;
  const pts = data
    .map((v, i) => {
      const x = pad + (i / (data.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} className="opacity-80">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

const Spinner = () => (
  <svg
    className="animate-spin h-5 w-5 text-indigo-400"
    viewBox="0 0 24 24"
    fill="none"
  >
    <circle
      className="opacity-25"
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="4"
    />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
  </svg>
);

const Modal = ({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
    onClick={onClose}
  >
    <div
      className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white text-xl leading-none"
        >
          x
        </button>
      </div>
      {children}
    </div>
  </div>
);

// ============================================================
// SIDEBAR
// ============================================================

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
    const active = page === id;
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
              God Mode Active
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
              <NavItem id="platform_home" label="Overview" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem id="platform_tenants" label="Tenants" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem
                id="platform_remote_access"
                label="Remote Access"
                icon="ÃÂ¢ÃÂÃÂ"
              />
              <NavItem id="platform_health" label="System Health" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem id="platform_revenue" label="Revenue" icon="ÃÂ¢ÃÂÃÂ" />
            </Section>
          </>
        ) : (
          <>
            <Section title="Workspace">
              <NavItem id="dashboard" label="Dashboard" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem id="agents" label="AI Agents" icon="ÃÂ¢ÃÂÃÂ¡" />
              <NavItem id="swarm" label="Swarm Monitor" icon="ÃÂ¢ÃÂ¬ÃÂ¡" />
              <NavItem id="insight" label="Insight Engine" icon="ÃÂ¢ÃÂÃÂ" />
            </Section>
            <Section title="Knowledge Hub">
              <NavItem id="hub_overview" label="Overview" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem id="hub_articles" label="Articles and Docs" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem id="hub_ingestion" label="Ingestion Pipeline" icon="ÃÂ¢ÃÂ¬ÃÂ" />
              <NavItem id="hub_training" label="Team Training" icon="ÃÂ¢ÃÂ¬ÃÂ¡" />
              <NavItem id="hub_analytics" label="KB Analytics" icon="ÃÂ¢ÃÂÃÂ»" />
            </Section>
            <Section title="Customer Portal">
              <NavItem id="portal_overview" label="Overview" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem
                id="portal_conversations"
                label="Conversations"
                icon="ÃÂ¢ÃÂÃÂ"
              />
              <NavItem id="portal_actions" label="Agent Actions" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem id="portal_approvals" label="Approvals" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem id="portal_tickets" label="Tickets" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem id="portal_settings" label="Portal Settings" icon="ÃÂ¢ÃÂÃÂ" />
            </Section>
            <Section title="Knowledge &amp; Data">
              <NavItem id="knowledge_data" label="Overview" icon="ÃÂ¢ÃÂÃÂ" />
              <NavItem
                id="knowledge_taxonomy"
                label="Taxonomy Browser"
                icon="ÃÂ¢ÃÂÃÂ"
              />
              <NavItem
                id="knowledge_connectors"
                label="Data Connectors"
                icon="ÃÂ¢ÃÂÃÂ"
              />
              <NavItem id="knowledge_files" label="Imported Files" icon="ÃÂ¢ÃÂÃÂ¤" />
            </Section>
            {isOwnerOrAdmin && (
              <Section title="Admin">
                <NavItem id="connectors" label="Data Connectors" icon="ÃÂ¢ÃÂÃÂ" />
                <NavItem id="integrations" label="Integrations" icon="ÃÂ¢ÃÂ¬ÃÂ¡" />
                <NavItem id="security" label="Security and RBAC" icon="ÃÂ¢ÃÂÃÂ " />
                <NavItem id="settings" label="Settings" icon="ÃÂ¢ÃÂÃÂ" />
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

// ============================================================
// DASHBOARD PAGE
// ============================================================

const DashboardPage = ({
  user,
  tenant,
  dbStats,
}: {
  user?: AuthUser;
  tenant?: Tenant;
  dbStats?: {
    totalConversations: number; openConversations: number; resolvedConversations: number;
    totalArticles: number; publishedArticles: number; pendingApprovals: number; autoResolved: number;
    channelBreakdown: { chat: number; email: number; phone: number };
    sentimentBreakdown: { positive: number; neutral: number; negative: number };
  } | null;
}) => {
  const [timeRange, setTimeRange] = useState('7d');
  const accentColor = tenant?.primaryColor || '#6366f1';

  const kpiData = [
    {
      label: 'Active AI Agents',
      value: '8',
      sub: '2 pending config',
      icon: 'ÃÂ¢ÃÂÃÂ¡',
      color: 'indigo',
      trend: '+2 this week',
      sparkData: [4, 5, 5, 6, 7, 7, 8],
    },
    {
      label: 'Conversations Today',
      value: dbStats ? dbStats.totalConversations.toLocaleString() : '1,284',
      sub: dbStats ? `${dbStats.openConversations} open ÃÂ· ${dbStats.resolvedConversations} resolved` : 'Customers plus Staff',
      icon: 'ÃÂ¢ÃÂÃÂ',
      color: 'blue',
      trend: '+18%',
      sparkData: [800, 950, 1050, 920, 1100, 1200, 1284],
    },
    {
      label: 'Actions Completed',
      value: '342',
      sub: 'Agent-executed tasks',
      icon: 'ÃÂ¢ÃÂÃÂ',
      color: 'emerald',
      trend: '+34%',
      sparkData: [180, 220, 260, 200, 290, 310, 342],
    },
    {
      label: 'Pending Approvals',
      value: dbStats ? String(dbStats.pendingApprovals) : '12',
      sub: dbStats ? (dbStats.pendingApprovals > 0 ? `${dbStats.pendingApprovals} require human review` : 'All caught up!') : 'Require human review',
      icon: 'ÃÂ¢ÃÂÃÂ ',
      color: 'amber',
      trend: '3 urgent',
      sparkData: [5, 8, 12, 9, 11, 10, 12],
    },
    {
      label: 'KB Articles',
      value: dbStats ? dbStats.totalArticles.toLocaleString() : '2,847',
      sub: dbStats ? `${dbStats.publishedArticles} published ÃÂ· ${dbStats.totalArticles - dbStats.publishedArticles} drafts` : '94% coverage score',
      icon: 'ÃÂ¢ÃÂÃÂ',
      color: 'purple',
      trend: '+127 this month',
      sparkData: [2100, 2300, 2450, 2600, 2700, 2790, 2847],
    },
    {
      label: 'Avg Resolution Time',
      value: '1m 24s',
      sub: 'Down from 4m 12s',
      icon: 'ÃÂ¢ÃÂÃÂ',
      color: 'emerald',
      trend: '-66%',
      sparkData: [252, 210, 190, 170, 155, 140, 84],
    },
    {
      label: 'Customer Satisfaction',
      value: '94.2%',
      sub: 'Based on 1,140 ratings',
      icon: 'ÃÂ¢ÃÂÃÂ',
      color: 'amber',
      trend: '+2.1%',
      sparkData: [88, 90, 91, 92, 93, 93.5, 94.2],
    },
    {
      label: 'Token Usage',
      value: '2.4M',
      sub:
        'of ' +
        ((tenant?.tokenLimit || 5000000) / 1000000).toFixed(0) +
        'M limit',
      icon: 'ÃÂ¢ÃÂÃÂ',
      color: 'blue',
      trend: '48% used',
      sparkData: [300, 600, 900, 1200, 1600, 2000, 2400],
    },
  ];

  const recentActivity = [
    {
      time: '2m ago',
      agent: 'Support Agent',
      action: 'Resolved password reset for customer #8821',
      type: 'resolved',
      icon: 'v',
    },
    {
      time: '5m ago',
      agent: 'Onboarding Agent',
      action: 'Sent welcome email and setup guide to new hire Sarah M.',
      type: 'action',
      icon: '>',
    },
    {
      time: '12m ago',
      agent: 'Billing Agent',
      action: 'Generated invoice INV-2847 and dispatched to accounts',
      type: 'action',
      icon: '>',
    },
    {
      time: '18m ago',
      agent: 'Support Agent',
      action: 'Escalated ticket T-9921 ÃÂ¢ÃÂÃÂ confidence below threshold',
      type: 'escalated',
      icon: '!',
    },
    {
      time: '24m ago',
      agent: 'HR Agent',
      action: 'Answered direct deposit question for 3 employees',
      type: 'resolved',
      icon: 'v',
    },
    {
      time: '31m ago',
      agent: 'Compliance Agent',
      action: 'Flagged policy update in Q3 handbook ÃÂ¢ÃÂÃÂ KB refresh triggered',
      type: 'flagged',
      icon: 'f',
    },
    {
      time: '45m ago',
      agent: 'Sales Agent',
      action: 'Qualified lead from web chat and routed to CRM',
      type: 'action',
      icon: '>',
    },
    {
      time: '1h ago',
      agent: 'Billing Agent',
      action: 'Awaiting approval: Issue $450 credit to account 7712',
      type: 'pending',
      icon: 'p',
    },
  ];

  const typeColors: Record<string, string> = {
    resolved: 'text-emerald-400',
    action: 'text-blue-400',
    escalated: 'text-amber-400',
    flagged: 'text-orange-400',
    pending: 'text-purple-400',
  };

  const agentStatus = [
    {
      name: 'Support Agent',
      status: 'active',
      tasks: 48,
      accuracy: 96,
      icon: 'A',
    },
    {
      name: 'Onboarding Agent',
      status: 'active',
      tasks: 23,
      accuracy: 99,
      icon: 'B',
    },
    {
      name: 'Billing Agent',
      status: 'active',
      tasks: 31,
      accuracy: 98,
      icon: 'C',
    },
    {
      name: 'HR Knowledge Agent',
      status: 'active',
      tasks: 67,
      accuracy: 94,
      icon: 'D',
    },
    {
      name: 'Compliance Agent',
      status: 'active',
      tasks: 15,
      accuracy: 97,
      icon: 'E',
    },
    {
      name: 'Sales Assist Agent',
      status: 'active',
      tasks: 19,
      accuracy: 92,
      icon: 'F',
    },
    {
      name: 'IT Helpdesk Agent',
      status: 'active',
      tasks: 88,
      accuracy: 95,
      icon: 'G',
    },
    {
      name: 'Data Analyst Agent',
      status: 'idle',
      tasks: 4,
      accuracy: 100,
      icon: 'H',
    },
  ];

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">Dashboard</h1>
            {dbStats && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-400 font-medium">
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                Live DB
              </span>
            )}
          </div>
          <p className="text-slate-400 text-sm mt-1">
            Welcome back ÃÂ¢ÃÂÃÂ here is what your AI workforce is doing right now
          </p>
        </div>
        <div className="flex items-center gap-2">
          {['24h', '7d', '30d'].map((r) => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                timeRange === r
                  ? 'text-white'
                  : 'text-slate-400 hover:text-white bg-slate-800'
              }`}
              style={timeRange === r ? { backgroundColor: accentColor } : {}}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {kpiData.map((k, i) => (
          <div
            key={i}
            className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all"
          >
            <div className="flex items-start justify-between mb-3">
              <span className="text-lg text-slate-400">{k.icon}</span>
              <span className="text-xs text-emerald-400 font-medium">
                {k.trend}
              </span>
            </div>
            <div className="text-2xl font-bold text-white mb-1">{k.value}</div>
            <div className="text-xs text-slate-400 mb-2">{k.label}</div>
            <div className="text-xs text-slate-600">{k.sub}</div>
            <div className="mt-2">
              <MiniLineChart data={k.sparkData} color={accentColor} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Agent Status</h2>
            <Badge label="8 agents" color="indigo" />
          </div>
          <div className="space-y-2">
            {agentStatus.map((a, i) => (
              <div
                key={i}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50 transition-all"
              >
                <div className="w-7 h-7 rounded-lg bg-indigo-500/20 flex items-center justify-center text-xs text-indigo-300 font-bold">
                  {a.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-white truncate">
                    {a.name}
                  </div>
                  <div className="text-xs text-slate-500">
                    {a.tasks} tasks ÃÂÃÂ· {a.accuracy}% acc
                  </div>
                </div>
                <div
                  className={`w-2 h-2 rounded-full ${
                    a.status === 'active' ? 'bg-emerald-400' : 'bg-slate-600'
                  }`}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">
              Live Activity Feed
            </h2>
            <span className="flex items-center gap-1.5 text-xs text-emerald-400">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
              Live
            </span>
          </div>
          <div className="space-y-3">
            {recentActivity.map((a, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 rounded-lg bg-slate-800/40 hover:bg-slate-800/70 transition-all"
              >
                <span
                  className={`text-sm mt-0.5 ${
                    typeColors[a.type] || 'text-slate-400'
                  }`}
                >
                  {a.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-slate-300">
                      {a.agent}
                    </span>
                    <span className="text-xs text-slate-600">{a.time}</span>
                  </div>
                  <div className="text-xs text-slate-400">{a.action}</div>
                </div>
                {a.type === 'pending' && (
                  <button
                    className="text-xs px-2 py-1 rounded text-white flex-shrink-0"
                    style={{ backgroundColor: accentColor }}
                  >
                    Review
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Token Usage This Month
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              2.4M of {((tenant?.tokenLimit || 5000000) / 1000000).toFixed(0)}M
              tokens used
            </p>
          </div>
          <Badge label="48% used" color="blue" />
        </div>
        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: '48%', backgroundColor: accentColor }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-slate-500">
          <span>0</span>
          <span>Resets in 18 days</span>
          <span>{((tenant?.tokenLimit || 5000000) / 1000000).toFixed(0)}M</span>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// AI AGENTS PAGE
// ============================================================
// ============================================================
// KNOWLEDGE TAXONOMY + DATA SOURCE REGISTRY
// ============================================================

// --- Knowledge Taxonomy ---
interface KnowledgeTag {
  id: string;
  label: string;
  subTags: string[];
}

interface KnowledgeSubSection {
  id: string;
  label: string;
  articleCount: number;
}

interface KnowledgeSection {
  id: string;
  label: string;
  subSections: KnowledgeSubSection[];
}

interface KnowledgeModule {
  id: string;
  label: string;
  sections: KnowledgeSection[];
}

interface KnowledgeProduct {
  id: string;
  label: string;
  color: string;
  modules: KnowledgeModule[];
}

type KnowledgeItemType =
  | 'article'
  | 'release_note'
  | 'resolved_ticket'
  | 'file'
  | 'video'
  | 'policy';
type KnowledgeAudience = 'Customer' | 'Internal' | 'Both';
type EmbedStatus = 'indexed' | 'pending' | 'failed' | 'stale';

interface KnowledgeItem {
  id: string;
  title: string;
  type: KnowledgeItemType;
  audience: KnowledgeAudience;
  productId: string;
  moduleId: string;
  sectionId: string;
  subSectionId: string;
  tags: string[];
  subTags: string[];
  summary: string;
  author: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  freshnessScore: number;
  viewCount: number;
  helpfulRating: number;
  embedStatus: EmbedStatus;
  chunkCount: number;
  sourceConnectorId?: string;
  fileType?: string;
  fileSize?: string;
}

// --- Data Source / Connector Registry ---
type ConnectorCategory =
  | 'crm'
  | 'billing'
  | 'hr'
  | 'support'
  | 'analytics'
  | 'storage'
  | 'communication'
  | 'custom';
type ConnectorStatus = 'connected' | 'disconnected' | 'error' | 'syncing';
type FieldPermission = 'read' | 'write' | 'none';

interface ConnectorField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array';
  description: string;
  pii: boolean;
  defaultPermission: FieldPermission;
}

interface ConnectorObject {
  name: string;
  label: string;
  fields: ConnectorField[];
}

interface AgentConnectorBinding {
  agentId: string;
  objects: {
    objectName: string;
    fieldPermissions: Record<string, FieldPermission>;
  }[];
}

interface RegisteredConnector {
  id: string;
  name: string;
  category: ConnectorCategory;
  icon: string;
  status: ConnectorStatus;
  lastSync: string;
  syncFrequency: string;
  recordCount: number;
  objects: ConnectorObject[];
  agentBindings: AgentConnectorBinding[];
}

// --- Imported File ---
interface ImportedFile {
  id: string;
  name: string;
  type: string;
  size: string;
  uploadedAt: string;
  uploadedBy: string;
  status: 'processing' | 'indexed' | 'failed';
  chunkCount: number;
  productId?: string;
  moduleId?: string;
  sectionId?: string;
  audience: KnowledgeAudience;
  tags: string[];
}

interface ValidationBot {
  id: string;
  name: string;
  type:
    | 'confidence_reviewer'
    | 'knowledge_checker'
    | 'safety_guard'
    | 'compliance_bot'
    | 'hallucination_detector';
  enabled: boolean;
  threshold: number;
  action: 'flag' | 'block' | 'escalate' | 'log';
}

interface PipelineStage {
  id: string;
  name: string;
  type: 'retrieval' | 'reasoning' | 'validation' | 'action' | 'response';
  enabled: boolean;
  config: Record<string, string | number | boolean>;
}

interface AgentModelConfig {
  provider: 'openai' | 'anthropic' | 'google' | 'custom';
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  ragEnabled: boolean;
  ragTopK: number;
  contextWindow: number;
}

interface AgentDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  status: 'active' | 'idle' | 'disabled';
  capabilities: string[];
  triggers: string[];
  actions: string[];
  requiredApproval: boolean;
  confidenceThreshold: number;
  tasksThisMonth: number;
  successRate: number;
  modelConfig: AgentModelConfig;
  pipeline: PipelineStage[];
  validationBots: ValidationBot[];
  knowledgeSources: string[];
  memoryEnabled: boolean;
  multiAgentEnabled: boolean;
  subAgents: string[];
}

// ============================================================
// KNOWLEDGE TAXONOMY DATA
// ============================================================

const knowledgeTaxonomy: KnowledgeProduct[] = [
  {
    id: 'p1',
    label: 'DreamTeam Platform',
    color: '#6366f1',
    modules: [
      {
        id: 'm1',
        label: 'Getting Started',
        sections: [
          {
            id: 's1',
            label: 'Onboarding',
            subSections: [
              { id: 'ss1', label: 'Account Setup', articleCount: 8 },
              { id: 'ss2', label: 'First Login', articleCount: 4 },
              { id: 'ss3', label: 'Workspace Configuration', articleCount: 6 },
            ],
          },
          {
            id: 's2',
            label: 'Quick Start Guides',
            subSections: [
              { id: 'ss4', label: 'Admin Quick Start', articleCount: 5 },
              { id: 'ss5', label: 'End-User Quick Start', articleCount: 3 },
            ],
          },
        ],
      },
      {
        id: 'm2',
        label: 'Agent Management',
        sections: [
          {
            id: 's3',
            label: 'Creating Agents',
            subSections: [
              { id: 'ss6', label: 'Agent Templates', articleCount: 12 },
              { id: 'ss7', label: 'Custom Agent Builder', articleCount: 9 },
              { id: 'ss8', label: 'Agent Cloning', articleCount: 3 },
            ],
          },
          {
            id: 's4',
            label: 'Agent Configuration',
            subSections: [
              { id: 'ss9', label: 'LLM Model Selection', articleCount: 7 },
              { id: 'ss10', label: 'Pipeline Design', articleCount: 11 },
              { id: 'ss11', label: 'Validation Bots', articleCount: 6 },
            ],
          },
          {
            id: 's5',
            label: 'Agent Monitoring',
            subSections: [
              { id: 'ss12', label: 'Performance Metrics', articleCount: 5 },
              { id: 'ss13', label: 'Failure Alerts', articleCount: 4 },
            ],
          },
        ],
      },
      {
        id: 'm3',
        label: 'Knowledge Hub',
        sections: [
          {
            id: 's6',
            label: 'Content Management',
            subSections: [
              { id: 'ss14', label: 'Article Creation', articleCount: 7 },
              { id: 'ss15', label: 'Taxonomy Management', articleCount: 5 },
              { id: 'ss16', label: 'Bulk Import', articleCount: 4 },
            ],
          },
          {
            id: 's7',
            label: 'Ingestion & Sync',
            subSections: [
              { id: 'ss17', label: 'Connector Ingestion', articleCount: 8 },
              { id: 'ss18', label: 'Release Note Sync', articleCount: 3 },
              { id: 'ss19', label: 'Ticket Learning', articleCount: 6 },
            ],
          },
        ],
      },
      {
        id: 'm4',
        label: 'Billing & Subscriptions',
        sections: [
          {
            id: 's8',
            label: 'Plans & Pricing',
            subSections: [
              { id: 'ss20', label: 'Plan Comparison', articleCount: 5 },
              { id: 'ss21', label: 'Token Budgets', articleCount: 4 },
              { id: 'ss22', label: 'Upgrade Paths', articleCount: 3 },
            ],
          },
          {
            id: 's9',
            label: 'Invoices & Payments',
            subSections: [
              { id: 'ss23', label: 'Invoice Downloads', articleCount: 3 },
              { id: 'ss24', label: 'Payment Methods', articleCount: 4 },
              { id: 'ss25', label: 'Refund Policy', articleCount: 5 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'p2',
    label: 'Customer Portal',
    color: '#10b981',
    modules: [
      {
        id: 'm5',
        label: 'Customer Self-Service',
        sections: [
          {
            id: 's10',
            label: 'Account Management',
            subSections: [
              { id: 'ss26', label: 'Profile Settings', articleCount: 6 },
              { id: 'ss27', label: 'Password & Security', articleCount: 8 },
              { id: 'ss28', label: 'Team Members', articleCount: 4 },
            ],
          },
          {
            id: 's11',
            label: 'AI Chat Help',
            subSections: [
              { id: 'ss29', label: 'How to use AI Chat', articleCount: 5 },
              { id: 'ss30', label: 'Agent Capabilities', articleCount: 7 },
              { id: 'ss31', label: 'Escalation Process', articleCount: 3 },
            ],
          },
        ],
      },
      {
        id: 'm6',
        label: 'Support & Tickets',
        sections: [
          {
            id: 's12',
            label: 'Ticket Management',
            subSections: [
              { id: 'ss32', label: 'Creating Tickets', articleCount: 4 },
              { id: 'ss33', label: 'Ticket Statuses', articleCount: 3 },
              { id: 'ss34', label: 'Priority Levels', articleCount: 2 },
            ],
          },
          {
            id: 's13',
            label: 'Agent Actions',
            subSections: [
              { id: 'ss35', label: 'Requesting Actions', articleCount: 6 },
              { id: 'ss36', label: 'Approvals Explained', articleCount: 4 },
              { id: 'ss37', label: 'Audit Trail', articleCount: 3 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'p3',
    label: 'Integrations & APIs',
    color: '#f59e0b',
    modules: [
      {
        id: 'm7',
        label: 'API Reference',
        sections: [
          {
            id: 's14',
            label: 'Authentication',
            subSections: [
              { id: 'ss38', label: 'API Keys', articleCount: 4 },
              { id: 'ss39', label: 'OAuth 2.0', articleCount: 5 },
              { id: 'ss40', label: 'Webhook Secrets', articleCount: 3 },
            ],
          },
          {
            id: 's15',
            label: 'Endpoints',
            subSections: [
              { id: 'ss41', label: 'Agent Endpoints', articleCount: 12 },
              { id: 'ss42', label: 'Knowledge Endpoints', articleCount: 8 },
              { id: 'ss43', label: 'Webhook Events', articleCount: 9 },
            ],
          },
        ],
      },
      {
        id: 'm8',
        label: 'Native Integrations',
        sections: [
          {
            id: 's16',
            label: 'CRM',
            subSections: [
              { id: 'ss44', label: 'Salesforce Setup', articleCount: 7 },
              { id: 'ss45', label: 'HubSpot Setup', articleCount: 6 },
              { id: 'ss46', label: 'Pipedrive Setup', articleCount: 4 },
            ],
          },
          {
            id: 's17',
            label: 'Helpdesk',
            subSections: [
              { id: 'ss47', label: 'Zendesk Setup', articleCount: 8 },
              { id: 'ss48', label: 'Intercom Setup', articleCount: 6 },
              { id: 'ss49', label: 'Freshdesk Setup', articleCount: 5 },
            ],
          },
        ],
      },
    ],
  },
];

const knowledgeTags: KnowledgeTag[] = [
  {
    id: 't1',
    label: 'billing',
    subTags: ['refund', 'invoice', 'payment', 'subscription', 'credit'],
  },
  {
    id: 't2',
    label: 'security',
    subTags: ['2fa', 'sso', 'rbac', 'password', 'permissions'],
  },
  {
    id: 't3',
    label: 'agents',
    subTags: ['configuration', 'pipeline', 'model', 'validation', 'triggers'],
  },
  {
    id: 't4',
    label: 'onboarding',
    subTags: ['setup', 'first-steps', 'training', 'welcome', 'checklist'],
  },
  {
    id: 't5',
    label: 'integrations',
    subTags: ['api', 'webhook', 'crm', 'helpdesk', 'oauth'],
  },
  {
    id: 't6',
    label: 'knowledge',
    subTags: ['taxonomy', 'articles', 'ingestion', 'embedding', 'rag'],
  },
  {
    id: 't7',
    label: 'troubleshooting',
    subTags: ['errors', 'faq', 'workarounds', 'known-issues'],
  },
  {
    id: 't8',
    label: 'release-notes',
    subTags: ['v4-0', 'v4-1', 'v4-2', 'breaking-changes', 'improvements'],
  },
];

const mockKnowledgeItems: KnowledgeItem[] = [
  {
    id: 'ki1',
    title: 'How to Request a Refund',
    type: 'article',
    audience: 'Customer',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's9',
    subSectionId: 'ss25',
    tags: ['billing', 'refund'],
    subTags: ['refund', 'credit'],
    summary:
      'Step-by-step guide for customers requesting refunds through the portal or by contacting support.',
    author: 'Sarah Kim',
    version: '2.1',
    createdAt: '2025-11-01',
    updatedAt: '2026-06-10',
    freshnessScore: 98,
    viewCount: 4821,
    helpfulRating: 94,
    embedStatus: 'indexed',
    chunkCount: 6,
  },
  {
    id: 'ki2',
    title: 'Understanding Your Invoice',
    type: 'article',
    audience: 'Both',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's9',
    subSectionId: 'ss23',
    tags: ['billing'],
    subTags: ['invoice', 'payment'],
    summary:
      'Explains each line item on the DreamTeam monthly invoice including token usage, seat costs, and add-ons.',
    author: 'James Patel',
    version: '3.0',
    createdAt: '2025-09-15',
    updatedAt: '2026-05-22',
    freshnessScore: 95,
    viewCount: 3210,
    helpfulRating: 91,
    embedStatus: 'indexed',
    chunkCount: 8,
  },
  {
    id: 'ki3',
    title: 'Setting Up Two-Factor Authentication',
    type: 'article',
    audience: 'Customer',
    productId: 'p2',
    moduleId: 'm5',
    sectionId: 's10',
    subSectionId: 'ss27',
    tags: ['security'],
    subTags: ['2fa', 'password'],
    summary:
      'Complete guide to enabling and managing 2FA on your account using authenticator apps or SMS.',
    author: 'Maria Chen',
    version: '1.4',
    createdAt: '2025-08-20',
    updatedAt: '2026-06-01',
    freshnessScore: 99,
    viewCount: 5643,
    helpfulRating: 97,
    embedStatus: 'indexed',
    chunkCount: 5,
  },
  {
    id: 'ki4',
    title: 'Agent Pipeline Design Best Practices',
    type: 'article',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm2',
    sectionId: 's4',
    subSectionId: 'ss10',
    tags: ['agents'],
    subTags: ['pipeline', 'configuration'],
    summary:
      'Internal guide covering optimal pipeline stage ordering, confidence threshold tuning, and validation bot selection for different use cases.',
    author: 'Alex Rivera',
    version: '1.2',
    createdAt: '2026-01-10',
    updatedAt: '2026-06-15',
    freshnessScore: 100,
    viewCount: 892,
    helpfulRating: 98,
    embedStatus: 'indexed',
    chunkCount: 14,
  },
  {
    id: 'ki5',
    title: 'Salesforce CRM Integration Setup',
    type: 'article',
    audience: 'Both',
    productId: 'p3',
    moduleId: 'm8',
    sectionId: 's16',
    subSectionId: 'ss44',
    tags: ['integrations'],
    subTags: ['crm', 'oauth'],
    summary:
      'Complete walkthrough for connecting Salesforce to DreamTeam including OAuth flow, field mapping, and sync configuration.',
    author: 'Jordan Blake',
    version: '2.3',
    createdAt: '2025-10-05',
    updatedAt: '2026-04-18',
    freshnessScore: 87,
    viewCount: 2107,
    helpfulRating: 89,
    embedStatus: 'indexed',
    chunkCount: 11,
  },
  {
    id: 'ki6',
    title: 'Release Notes v4.2 ÃÂ¢ÃÂÃÂ Agent Enhancements',
    type: 'release_note',
    audience: 'Both',
    productId: 'p1',
    moduleId: 'm2',
    sectionId: 's4',
    subSectionId: 'ss9',
    tags: ['release-notes'],
    subTags: ['v4-2', 'improvements'],
    summary:
      'New multi-model routing, sub-agent orchestration improvements, and validation bot thresholds made configurable per action type.',
    author: 'Product Team',
    version: '4.2',
    createdAt: '2026-05-01',
    updatedAt: '2026-05-01',
    freshnessScore: 100,
    viewCount: 8941,
    helpfulRating: 96,
    embedStatus: 'indexed',
    chunkCount: 7,
  },
  {
    id: 'ki7',
    title: 'Resolved: Billing Agent double-charge on plan upgrade',
    type: 'resolved_ticket',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's8',
    subSectionId: 'ss22',
    tags: ['billing', 'troubleshooting'],
    subTags: ['subscription', 'known-issues'],
    summary:
      'Root cause analysis and resolution for billing agent incorrectly triggering two charges on same-day plan upgrades. Patched in v4.1.3.',
    author: 'Support Team',
    version: '4.1.3',
    createdAt: '2026-03-14',
    updatedAt: '2026-03-14',
    freshnessScore: 92,
    viewCount: 441,
    helpfulRating: 100,
    embedStatus: 'indexed',
    chunkCount: 4,
  },
  {
    id: 'ki8',
    title: 'RBAC Roles and Permissions Reference',
    type: 'policy',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm1',
    sectionId: 's1',
    subSectionId: 'ss3',
    tags: ['security'],
    subTags: ['rbac', 'permissions'],
    summary:
      'Complete reference for all 8 RBAC roles across DT Platform and Tenant tiers ÃÂ¢ÃÂÃÂ what each role can access, configure, and execute.',
    author: 'Alex Rivera',
    version: '2.0',
    createdAt: '2025-07-01',
    updatedAt: '2026-06-01',
    freshnessScore: 96,
    viewCount: 1823,
    helpfulRating: 99,
    embedStatus: 'indexed',
    chunkCount: 9,
  },
  {
    id: 'ki9',
    title: 'How to Submit a Support Ticket',
    type: 'article',
    audience: 'Customer',
    productId: 'p2',
    moduleId: 'm6',
    sectionId: 's12',
    subSectionId: 'ss32',
    tags: ['troubleshooting'],
    subTags: ['faq'],
    summary:
      'Guide for customers on submitting, tracking, and escalating support tickets through the Customer Portal.',
    author: 'Sarah Kim',
    version: '1.0',
    createdAt: '2025-06-15',
    updatedAt: '2026-03-10',
    freshnessScore: 88,
    viewCount: 9102,
    helpfulRating: 93,
    embedStatus: 'indexed',
    chunkCount: 5,
  },
  {
    id: 'ki10',
    title: 'Knowledge Taxonomy Design Guide',
    type: 'article',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm3',
    sectionId: 's6',
    subSectionId: 'ss15',
    tags: ['knowledge'],
    subTags: ['taxonomy', 'articles'],
    summary:
      'Internal guide for content authors on how to correctly classify articles using the Product-Module-Section-SubSection hierarchy and tagging system.',
    author: 'Jordan Blake',
    version: '1.1',
    createdAt: '2026-02-01',
    updatedAt: '2026-06-18',
    freshnessScore: 100,
    viewCount: 347,
    helpfulRating: 97,
    embedStatus: 'indexed',
    chunkCount: 8,
  },
  {
    id: 'ki11',
    title: 'Plan Upgrade Guide ÃÂ¢ÃÂÃÂ Enterprise Features',
    type: 'article',
    audience: 'Customer',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's8',
    subSectionId: 'ss22',
    tags: ['billing'],
    subTags: ['subscription', 'upgrade'],
    summary:
      'Everything included in the Enterprise plan upgrade: dedicated support, unlimited agents, custom SLA, and white-labelling.',
    author: 'James Patel',
    version: '2.0',
    createdAt: '2026-01-20',
    updatedAt: '2026-06-05',
    freshnessScore: 97,
    viewCount: 3421,
    helpfulRating: 95,
    embedStatus: 'indexed',
    chunkCount: 6,
  },
  {
    id: 'ki12',
    title: 'SSO Configuration with Okta',
    type: 'article',
    audience: 'Both',
    productId: 'p3',
    moduleId: 'm7',
    sectionId: 's14',
    subSectionId: 'ss39',
    tags: ['security', 'integrations'],
    subTags: ['sso', 'oauth'],
    summary:
      'Step-by-step for configuring single sign-on using Okta as the identity provider with SAML 2.0 or OIDC.',
    author: 'Maria Chen',
    version: '1.3',
    createdAt: '2025-12-01',
    updatedAt: '2026-05-10',
    freshnessScore: 94,
    viewCount: 1654,
    helpfulRating: 96,
    embedStatus: 'indexed',
    chunkCount: 10,
  },
];

const mockImportedFiles: ImportedFile[] = [
  {
    id: 'f1',
    name: 'HR_Policy_Handbook_2026.pdf',
    type: 'PDF',
    size: '2.4 MB',
    uploadedAt: '2026-06-01',
    uploadedBy: 'Alex Rivera',
    status: 'indexed',
    chunkCount: 142,
    productId: 'p1',
    moduleId: 'm1',
    sectionId: 's1',
    audience: 'Internal',
    tags: ['onboarding', 'security'],
  },
  {
    id: 'f2',
    name: 'Product_Pricing_Sheet_Q2_2026.xlsx',
    type: 'XLSX',
    size: '340 KB',
    uploadedAt: '2026-06-10',
    uploadedBy: 'Jordan Blake',
    status: 'indexed',
    chunkCount: 28,
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's8',
    audience: 'Both',
    tags: ['billing'],
  },
  {
    id: 'f3',
    name: 'Compliance_Audit_Report_2025.docx',
    type: 'DOCX',
    size: '1.1 MB',
    uploadedAt: '2026-04-15',
    uploadedBy: 'Maria Chen',
    status: 'indexed',
    chunkCount: 87,
    productId: 'p1',
    moduleId: 'm1',
    audience: 'Internal',
    tags: ['security', 'troubleshooting'],
  },
  {
    id: 'f4',
    name: 'Customer_Onboarding_Deck.pptx',
    type: 'PPTX',
    size: '5.2 MB',
    uploadedAt: '2026-05-20',
    uploadedBy: 'Sarah Kim',
    status: 'indexed',
    chunkCount: 64,
    productId: 'p2',
    moduleId: 'm5',
    audience: 'Customer',
    tags: ['onboarding'],
  },
  {
    id: 'f5',
    name: 'API_Reference_v4.2.md',
    type: 'MD',
    size: '890 KB',
    uploadedAt: '2026-06-15',
    uploadedBy: 'Alex Rivera',
    status: 'indexed',
    chunkCount: 211,
    productId: 'p3',
    moduleId: 'm7',
    audience: 'Both',
    tags: ['integrations'],
  },
  {
    id: 'f6',
    name: 'Sales_Battlecard_Competitive_Analysis.pdf',
    type: 'PDF',
    size: '1.8 MB',
    uploadedAt: '2026-06-18',
    uploadedBy: 'Jordan Blake',
    status: 'processing',
    chunkCount: 0,
    audience: 'Internal',
    tags: ['agents'],
  },
];

// ============================================================
// DATA CONNECTOR REGISTRY
// ============================================================

const registeredConnectors: RegisteredConnector[] = [
  {
    id: 'dc1',
    name: 'Salesforce CRM',
    category: 'crm',
    icon: 'SF',
    status: 'connected',
    lastSync: '5 min ago',
    syncFrequency: 'Real-time',
    recordCount: 14821,
    objects: [
      {
        name: 'Contact',
        label: 'Contact',
        fields: [
          {
            name: 'id',
            type: 'string',
            description: 'Unique contact ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'firstName',
            type: 'string',
            description: 'First name',
            pii: true,
            defaultPermission: 'read',
          },
          {
            name: 'lastName',
            type: 'string',
            description: 'Last name',
            pii: true,
            defaultPermission: 'read',
          },
          {
            name: 'email',
            type: 'string',
            description: 'Email address',
            pii: true,
            defaultPermission: 'read',
          },
          {
            name: 'accountId',
            type: 'string',
            description: 'Parent account ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'lastActivity',
            type: 'date',
            description: 'Last interaction date',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
      {
        name: 'Account',
        label: 'Account / Company',
        fields: [
          {
            name: 'id',
            type: 'string',
            description: 'Account ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'name',
            type: 'string',
            description: 'Company name',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'plan',
            type: 'string',
            description: 'Subscription plan',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'mrr',
            type: 'number',
            description: 'Monthly recurring revenue',
            pii: false,
            defaultPermission: 'none',
          },
          {
            name: 'healthScore',
            type: 'number',
            description: 'Account health score',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
      {
        name: 'Opportunity',
        label: 'Deal / Opportunity',
        fields: [
          {
            name: 'id',
            type: 'string',
            description: 'Opportunity ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'name',
            type: 'string',
            description: 'Deal name',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'stage',
            type: 'string',
            description: 'Deal stage',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'amount',
            type: 'number',
            description: 'Deal value',
            pii: false,
            defaultPermission: 'none',
          },
          {
            name: 'closeDate',
            type: 'date',
            description: 'Expected close date',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a8',
        objects: [
          {
            objectName: 'Contact',
            fieldPermissions: {
              id: 'read',
              firstName: 'read',
              lastName: 'read',
              email: 'read',
              accountId: 'read',
              lastActivity: 'read',
            },
          },
          {
            objectName: 'Account',
            fieldPermissions: {
              id: 'read',
              name: 'read',
              plan: 'read',
              mrr: 'none',
              healthScore: 'read',
            },
          },
          {
            objectName: 'Opportunity',
            fieldPermissions: {
              id: 'read',
              name: 'read',
              stage: 'read',
              amount: 'none',
              closeDate: 'read',
            },
          },
        ],
      },
    ],
  },
  {
    id: 'dc2',
    name: 'Stripe Billing',
    category: 'billing',
    icon: 'ST',
    status: 'connected',
    lastSync: '2 min ago',
    syncFrequency: 'Real-time',
    recordCount: 8234,
    objects: [
      {
        name: 'Customer',
        label: 'Billing Customer',
        fields: [
          {
            name: 'id',
            type: 'string',
            description: 'Stripe customer ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'email',
            type: 'string',
            description: 'Billing email',
            pii: true,
            defaultPermission: 'read',
          },
          {
            name: 'balance',
            type: 'number',
            description: 'Current balance / credit',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'defaultPaymentMethod',
            type: 'string',
            description: 'Default payment method ID',
            pii: false,
            defaultPermission: 'none',
          },
        ],
      },
      {
        name: 'Invoice',
        label: 'Invoice',
        fields: [
          {
            name: 'id',
            type: 'string',
            description: 'Invoice ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'amount',
            type: 'number',
            description: 'Invoice total in cents',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'status',
            type: 'string',
            description: 'paid / open / void',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'periodStart',
            type: 'date',
            description: 'Billing period start',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'periodEnd',
            type: 'date',
            description: 'Billing period end',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'lineItems',
            type: 'array',
            description: 'Invoice line items',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
      {
        name: 'Subscription',
        label: 'Subscription',
        fields: [
          {
            name: 'id',
            type: 'string',
            description: 'Subscription ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'plan',
            type: 'string',
            description: 'Plan name',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'status',
            type: 'string',
            description: 'active / past_due / cancelled',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'currentPeriodEnd',
            type: 'date',
            description: 'Next billing date',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'cancelAtPeriodEnd',
            type: 'boolean',
            description: 'Cancellation scheduled',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a3',
        objects: [
          {
            objectName: 'Customer',
            fieldPermissions: {
              id: 'read',
              email: 'read',
              balance: 'read',
              defaultPaymentMethod: 'none',
            },
          },
          {
            objectName: 'Invoice',
            fieldPermissions: {
              id: 'read',
              amount: 'read',
              status: 'read',
              periodStart: 'read',
              periodEnd: 'read',
              lineItems: 'read',
            },
          },
          {
            objectName: 'Subscription',
            fieldPermissions: {
              id: 'read',
              plan: 'read',
              status: 'read',
              currentPeriodEnd: 'read',
              cancelAtPeriodEnd: 'read',
            },
          },
        ],
      },
    ],
  },
  {
    id: 'dc3',
    name: 'BambooHR',
    category: 'hr',
    icon: 'HR',
    status: 'connected',
    lastSync: '1 hr ago',
    syncFrequency: 'Every 4 hours',
    recordCount: 342,
    objects: [
      {
        name: 'Employee',
        label: 'Employee Record',
        fields: [
          {
            name: 'id',
            type: 'string',
            description: 'Employee ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'firstName',
            type: 'string',
            description: 'First name',
            pii: true,
            defaultPermission: 'read',
          },
          {
            name: 'lastName',
            type: 'string',
            description: 'Last name',
            pii: true,
            defaultPermission: 'read',
          },
          {
            name: 'department',
            type: 'string',
            description: 'Department',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'role',
            type: 'string',
            description: 'Job title',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'startDate',
            type: 'date',
            description: 'Employment start date',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'salary',
            type: 'number',
            description: 'Annual salary',
            pii: true,
            defaultPermission: 'none',
          },
          {
            name: 'leaveBalance',
            type: 'number',
            description: 'Remaining leave days',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
      {
        name: 'LeaveRequest',
        label: 'Leave Request',
        fields: [
          {
            name: 'id',
            type: 'string',
            description: 'Request ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'employeeId',
            type: 'string',
            description: 'Employee reference',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'type',
            type: 'string',
            description: 'Leave type',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'status',
            type: 'string',
            description: 'approved / pending / rejected',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'startDate',
            type: 'date',
            description: 'Leave start date',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'endDate',
            type: 'date',
            description: 'Leave end date',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a2',
        objects: [
          {
            objectName: 'Employee',
            fieldPermissions: {
              id: 'read',
              firstName: 'read',
              lastName: 'read',
              department: 'read',
              role: 'read',
              startDate: 'read',
              salary: 'none',
              leaveBalance: 'read',
            },
          },
          {
            objectName: 'LeaveRequest',
            fieldPermissions: {
              id: 'read',
              employeeId: 'read',
              type: 'read',
              status: 'read',
              startDate: 'read',
              endDate: 'read',
            },
          },
        ],
      },
      {
        agentId: 'a7',
        objects: [
          {
            objectName: 'Employee',
            fieldPermissions: {
              id: 'read',
              firstName: 'read',
              lastName: 'read',
              department: 'read',
              role: 'read',
              startDate: 'read',
              salary: 'none',
              leaveBalance: 'read',
            },
          },
        ],
      },
    ],
  },
  {
    id: 'dc4',
    name: 'Zendesk Support',
    category: 'support',
    icon: 'ZD',
    status: 'connected',
    lastSync: '10 min ago',
    syncFrequency: 'Every 15 min',
    recordCount: 42187,
    objects: [
      {
        name: 'Ticket',
        label: 'Support Ticket',
        fields: [
          {
            name: 'id',
            type: 'number',
            description: 'Ticket number',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'subject',
            type: 'string',
            description: 'Ticket subject',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'status',
            type: 'string',
            description: 'open / pending / solved / closed',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'priority',
            type: 'string',
            description: 'low / normal / high / urgent',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'tags',
            type: 'array',
            description: 'Ticket tags',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'resolution',
            type: 'string',
            description: 'Resolution summary',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
      {
        name: 'Article',
        label: 'Help Center Article',
        fields: [
          {
            name: 'id',
            type: 'number',
            description: 'Article ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'title',
            type: 'string',
            description: 'Article title',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'body',
            type: 'string',
            description: 'Full article body',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'section',
            type: 'string',
            description: 'Help section',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'updatedAt',
            type: 'date',
            description: 'Last updated',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a1',
        objects: [
          {
            objectName: 'Ticket',
            fieldPermissions: {
              id: 'read',
              subject: 'read',
              status: 'read',
              priority: 'read',
              tags: 'read',
              resolution: 'read',
            },
          },
          {
            objectName: 'Article',
            fieldPermissions: {
              id: 'read',
              title: 'read',
              body: 'read',
              section: 'read',
              updatedAt: 'read',
            },
          },
        ],
      },
    ],
  },
  {
    id: 'dc5',
    name: 'Google Analytics',
    category: 'analytics',
    icon: 'GA',
    status: 'connected',
    lastSync: '1 hr ago',
    syncFrequency: 'Daily',
    recordCount: 0,
    objects: [
      {
        name: 'PageView',
        label: 'Page Views',
        fields: [
          {
            name: 'page',
            type: 'string',
            description: 'Page path',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'sessions',
            type: 'number',
            description: 'Session count',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'bounceRate',
            type: 'number',
            description: 'Bounce rate %',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'avgDuration',
            type: 'number',
            description: 'Avg session duration',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a8',
        objects: [
          {
            objectName: 'PageView',
            fieldPermissions: {
              page: 'read',
              sessions: 'read',
              bounceRate: 'read',
              avgDuration: 'read',
            },
          },
        ],
      },
    ],
  },
  {
    id: 'dc6',
    name: 'Google Drive / Files',
    category: 'storage',
    icon: 'GD',
    status: 'connected',
    lastSync: '30 min ago',
    syncFrequency: 'Every hour',
    recordCount: 1847,
    objects: [
      {
        name: 'File',
        label: 'File / Document',
        fields: [
          {
            name: 'id',
            type: 'string',
            description: 'File ID',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'name',
            type: 'string',
            description: 'File name',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'mimeType',
            type: 'string',
            description: 'MIME type',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'content',
            type: 'string',
            description: 'Parsed text content',
            pii: false,
            defaultPermission: 'read',
          },
          {
            name: 'modifiedAt',
            type: 'date',
            description: 'Last modified',
            pii: false,
            defaultPermission: 'read',
          },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a1',
        objects: [
          {
            objectName: 'File',
            fieldPermissions: {
              id: 'read',
              name: 'read',
              mimeType: 'read',
              content: 'read',
              modifiedAt: 'read',
            },
          },
        ],
      },
      {
        agentId: 'a7',
        objects: [
          {
            objectName: 'File',
            fieldPermissions: {
              id: 'read',
              name: 'read',
              mimeType: 'read',
              content: 'read',
              modifiedAt: 'read',
            },
          },
        ],
      },
    ],
  },
];

const defaultAgents: AgentDef[] = [
  {
    id: 'a1',
    name: 'Support Agent',
    description:
      'Handles tier-1 customer support using the knowledge base. Retrieves articles, reasons over context, validates confidence, and responds or escalates.',
    icon: 'S',
    category: 'Customer',
    status: 'active',
    capabilities: [
      'KB Search',
      'Ticket Creation',
      'Email Dispatch',
      'Customer Lookup',
    ],
    triggers: ['New chat message', 'Email received', 'Ticket created'],
    actions: [
      'Search KB',
      'Reply to customer',
      'Create ticket',
      'Escalate to human',
    ],
    requiredApproval: false,
    confidenceThreshold: 80,
    tasksThisMonth: 1284,
    successRate: 96,
    knowledgeSources: ['Product KB', 'Release Notes', 'Past Resolved Tickets'],
    memoryEnabled: true,
    multiAgentEnabled: true,
    subAgents: ['a5'],
    modelConfig: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      temperature: 0.3,
      maxTokens: 2048,
      systemPrompt:
        'You are a helpful support agent. Use the retrieved knowledge to answer questions accurately. If confidence is below threshold, escalate to a human agent.',
      ragEnabled: true,
      ragTopK: 5,
      contextWindow: 100000,
    },
    pipeline: [
      {
        id: 'p1',
        name: 'Intent Classification',
        type: 'reasoning',
        enabled: true,
        config: { model: 'fast', threshold: 0.7 },
      },
      {
        id: 'p2',
        name: 'KB Retrieval',
        type: 'retrieval',
        enabled: true,
        config: { topK: 5, minScore: 0.6, sources: 'all' },
      },
      {
        id: 'p3',
        name: 'Context Reasoning',
        type: 'reasoning',
        enabled: true,
        config: { temperature: 0.3, chainOfThought: true },
      },
      {
        id: 'p4',
        name: 'Validation Gate',
        type: 'validation',
        enabled: true,
        config: { minConfidence: 80, blockBelow: 60 },
      },
      {
        id: 'p5',
        name: 'Response Generation',
        type: 'response',
        enabled: true,
        config: { tone: 'helpful', maxLength: 300 },
      },
    ],
    validationBots: [
      {
        id: 'v1',
        name: 'Confidence Reviewer',
        type: 'confidence_reviewer',
        enabled: true,
        threshold: 80,
        action: 'escalate',
      },
      {
        id: 'v2',
        name: 'Knowledge Checker',
        type: 'knowledge_checker',
        enabled: true,
        threshold: 70,
        action: 'flag',
      },
      {
        id: 'v3',
        name: 'Safety Guard',
        type: 'safety_guard',
        enabled: true,
        threshold: 95,
        action: 'block',
      },
      {
        id: 'v4',
        name: 'Hallucination Detector',
        type: 'hallucination_detector',
        enabled: true,
        threshold: 85,
        action: 'escalate',
      },
    ],
  },
  {
    id: 'a2',
    name: 'Onboarding Agent',
    description:
      'Guides new employees through onboarding. Answers HR questions, assigns training modules, and sends personalised welcome communications.',
    icon: 'O',
    category: 'Internal',
    status: 'active',
    capabilities: [
      'HR KB Access',
      'Email Notifications',
      'Training Assignment',
      'Progress Tracking',
    ],
    triggers: [
      'New employee added',
      'Onboarding form submitted',
      'Day-1 trigger',
    ],
    actions: [
      'Send welcome email',
      'Assign training modules',
      'Answer HR questions',
      'Update HR system',
    ],
    requiredApproval: false,
    confidenceThreshold: 85,
    tasksThisMonth: 342,
    successRate: 99,
    knowledgeSources: [
      'HR Policies',
      'Training Catalogue',
      'Employee Handbook',
    ],
    memoryEnabled: true,
    multiAgentEnabled: false,
    subAgents: [],
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.2,
      maxTokens: 1500,
      systemPrompt:
        'You are an HR onboarding assistant. Guide new employees warmly and accurately through their first days. Always reference official HR policies.',
      ragEnabled: true,
      ragTopK: 4,
      contextWindow: 128000,
    },
    pipeline: [
      {
        id: 'p1',
        name: 'Employee Context Load',
        type: 'retrieval',
        enabled: true,
        config: { source: 'hr_system', fields: 'role,dept,startDate' },
      },
      {
        id: 'p2',
        name: 'Policy Retrieval',
        type: 'retrieval',
        enabled: true,
        config: { topK: 4, source: 'hr_kb' },
      },
      {
        id: 'p3',
        name: 'Personalised Reasoning',
        type: 'reasoning',
        enabled: true,
        config: { temperature: 0.2, personalise: true },
      },
      {
        id: 'p4',
        name: 'Compliance Check',
        type: 'validation',
        enabled: true,
        config: { checkPolicy: true },
      },
      {
        id: 'p5',
        name: 'Response + Action',
        type: 'action',
        enabled: true,
        config: { canEmail: true, canAssignTraining: true },
      },
    ],
    validationBots: [
      {
        id: 'v1',
        name: 'Confidence Reviewer',
        type: 'confidence_reviewer',
        enabled: true,
        threshold: 85,
        action: 'escalate',
      },
      {
        id: 'v2',
        name: 'Compliance Bot',
        type: 'compliance_bot',
        enabled: true,
        threshold: 90,
        action: 'block',
      },
      {
        id: 'v3',
        name: 'Safety Guard',
        type: 'safety_guard',
        enabled: true,
        threshold: 95,
        action: 'block',
      },
    ],
  },
  {
    id: 'a3',
    name: 'Billing Agent',
    description:
      'Manages billing inquiries, subscription changes, invoice generation, and refund requests with full audit trail and approval gates for transactions.',
    icon: 'B',
    category: 'Customer',
    status: 'active',
    capabilities: [
      'Invoice Lookup',
      'Subscription Management',
      'Refund Processing',
      'Payment Plans',
    ],
    triggers: [
      'Billing inquiry',
      'Payment failed',
      'Upgrade/downgrade request',
      'Refund request',
    ],
    actions: [
      'Lookup invoice',
      'Apply credit',
      'Process refund',
      'Update subscription',
      'Send receipt',
    ],
    requiredApproval: true,
    confidenceThreshold: 92,
    tasksThisMonth: 567,
    successRate: 98,
    knowledgeSources: [
      'Billing Policies',
      'Pricing Catalogue',
      'Customer Accounts',
    ],
    memoryEnabled: true,
    multiAgentEnabled: true,
    subAgents: ['a6'],
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'You are a billing specialist. Handle financial queries with precision. Never process refunds or subscription changes without reaching 92% confidence. Flag borderline cases for human review.',
      ragEnabled: true,
      ragTopK: 3,
      contextWindow: 128000,
    },
    pipeline: [
      {
        id: 'p1',
        name: 'Account Retrieval',
        type: 'retrieval',
        enabled: true,
        config: { source: 'billing_system', authenticate: true },
      },
      {
        id: 'p2',
        name: 'Intent + Amount Parse',
        type: 'reasoning',
        enabled: true,
        config: { extractAmount: true, extractPeriod: true },
      },
      {
        id: 'p3',
        name: 'Policy Check',
        type: 'validation',
        enabled: true,
        config: { checkRefundPolicy: true, checkPeriod: true },
      },
      {
        id: 'p4',
        name: 'Risk Assessment',
        type: 'validation',
        enabled: true,
        config: { maxAutoAmount: 100, requireApprovalAbove: 100 },
      },
      {
        id: 'p5',
        name: 'Transaction Execution',
        type: 'action',
        enabled: true,
        config: { requireApproval: true, auditLog: true },
      },
    ],
    validationBots: [
      {
        id: 'v1',
        name: 'Confidence Reviewer',
        type: 'confidence_reviewer',
        enabled: true,
        threshold: 92,
        action: 'block',
      },
      {
        id: 'v2',
        name: 'Compliance Bot',
        type: 'compliance_bot',
        enabled: true,
        threshold: 90,
        action: 'escalate',
      },
      {
        id: 'v3',
        name: 'Safety Guard',
        type: 'safety_guard',
        enabled: true,
        threshold: 99,
        action: 'block',
      },
      {
        id: 'v4',
        name: 'Hallucination Detector',
        type: 'hallucination_detector',
        enabled: true,
        threshold: 90,
        action: 'block',
      },
    ],
  },
  {
    id: 'a4',
    name: 'Account Agent',
    description:
      'Handles account management requests ÃÂ¢ÃÂÃÂ password resets, profile updates, access management, and 2FA. Operates with conservative confidence thresholds.',
    icon: 'A',
    category: 'Customer',
    status: 'active',
    capabilities: [
      'Profile Management',
      'Access Control',
      'Security Actions',
      'Notifications',
    ],
    triggers: ['Account change request', 'Security alert', 'Profile update'],
    actions: [
      'Reset password',
      'Update profile',
      'Revoke session',
      'Enable 2FA',
      'Send verification',
    ],
    requiredApproval: true,
    confidenceThreshold: 90,
    tasksThisMonth: 892,
    successRate: 97,
    knowledgeSources: ['Security Policies', 'Account FAQs', 'Identity KB'],
    memoryEnabled: false,
    multiAgentEnabled: false,
    subAgents: [],
    modelConfig: {
      provider: 'anthropic',
      model: 'claude-haiku-3-5',
      temperature: 0.1,
      maxTokens: 512,
      systemPrompt:
        'You are a security-focused account management agent. Always verify identity signals before taking account actions. When in doubt, do not act.',
      ragEnabled: true,
      ragTopK: 2,
      contextWindow: 200000,
    },
    pipeline: [
      {
        id: 'p1',
        name: 'Identity Verification',
        type: 'validation',
        enabled: true,
        config: { requireSessionToken: true, checkMFA: true },
      },
      {
        id: 'p2',
        name: 'Request Classification',
        type: 'reasoning',
        enabled: true,
        config: { classifyRisk: true },
      },
      {
        id: 'p3',
        name: 'Policy Retrieval',
        type: 'retrieval',
        enabled: true,
        config: { source: 'security_kb', topK: 2 },
      },
      {
        id: 'p4',
        name: 'Risk Gate',
        type: 'validation',
        enabled: true,
        config: {
          highRiskActions: 'revokeSession,resetPassword',
          requireApproval: true,
        },
      },
      {
        id: 'p5',
        name: 'Secure Action',
        type: 'action',
        enabled: true,
        config: { auditLog: true, notifyUser: true },
      },
    ],
    validationBots: [
      {
        id: 'v1',
        name: 'Confidence Reviewer',
        type: 'confidence_reviewer',
        enabled: true,
        threshold: 90,
        action: 'block',
      },
      {
        id: 'v2',
        name: 'Safety Guard',
        type: 'safety_guard',
        enabled: true,
        threshold: 98,
        action: 'block',
      },
      {
        id: 'v3',
        name: 'Compliance Bot',
        type: 'compliance_bot',
        enabled: true,
        threshold: 92,
        action: 'escalate',
      },
    ],
  },
  {
    id: 'a5',
    name: 'Knowledge Curator',
    description:
      'Validates retrieved knowledge for accuracy, freshness, and completeness. Acts as a sub-agent that other agents invoke before generating responses.',
    icon: 'K',
    category: 'Internal',
    status: 'active',
    capabilities: [
      'KB Validation',
      'Content Freshness Check',
      'Source Ranking',
      'Gap Detection',
    ],
    triggers: [
      'Sub-agent call from Support Agent',
      'Scheduled KB audit',
      'New article published',
    ],
    actions: [
      'Validate KB chunk',
      'Score relevance',
      'Flag outdated content',
      'Suggest knowledge gaps',
    ],
    requiredApproval: false,
    confidenceThreshold: 75,
    tasksThisMonth: 4521,
    successRate: 94,
    knowledgeSources: ['All KB Sources', 'Vector Index', 'Release Notes'],
    memoryEnabled: false,
    multiAgentEnabled: false,
    subAgents: [],
    modelConfig: {
      provider: 'google',
      model: 'gemini-2-flash',
      temperature: 0.0,
      maxTokens: 512,
      systemPrompt:
        'You are a knowledge quality auditor. Score retrieved chunks for relevance, accuracy, and freshness. Return a structured confidence score for each chunk.',
      ragEnabled: false,
      ragTopK: 0,
      contextWindow: 1000000,
    },
    pipeline: [
      {
        id: 'p1',
        name: 'Chunk Ingestion',
        type: 'retrieval',
        enabled: true,
        config: { acceptsChunks: true },
      },
      {
        id: 'p2',
        name: 'Freshness Check',
        type: 'validation',
        enabled: true,
        config: { maxAgeDays: 90, warnAt: 60 },
      },
      {
        id: 'p3',
        name: 'Relevance Scoring',
        type: 'reasoning',
        enabled: true,
        config: { scoreMethod: 'semantic+keyword' },
      },
      {
        id: 'p4',
        name: 'Quality Report',
        type: 'response',
        enabled: true,
        config: { format: 'structured_json' },
      },
    ],
    validationBots: [
      {
        id: 'v1',
        name: 'Hallucination Detector',
        type: 'hallucination_detector',
        enabled: true,
        threshold: 80,
        action: 'flag',
      },
    ],
  },
  {
    id: 'a6',
    name: 'Compliance Bot',
    description:
      'Reviews proposed agent actions for compliance with policies, regulations, and tenant-specific rules before authorising execution.',
    icon: 'C',
    category: 'Internal',
    status: 'active',
    capabilities: [
      'Policy Enforcement',
      'Regulatory Check',
      'Risk Classification',
      'Audit Trail',
    ],
    triggers: [
      'Pre-execution hook from any agent',
      'Scheduled audit',
      'Policy change event',
    ],
    actions: [
      'Approve action',
      'Reject action',
      'Flag for human review',
      'Log audit event',
    ],
    requiredApproval: false,
    confidenceThreshold: 95,
    tasksThisMonth: 2103,
    successRate: 99,
    knowledgeSources: ['Compliance Policies', 'Regulatory DB', 'Tenant Rules'],
    memoryEnabled: false,
    multiAgentEnabled: false,
    subAgents: [],
    modelConfig: {
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      temperature: 0.0,
      maxTokens: 256,
      systemPrompt:
        'You are a compliance enforcement agent. Evaluate proposed actions against policies. Return APPROVE, REJECT, or ESCALATE with reasoning.',
      ragEnabled: true,
      ragTopK: 5,
      contextWindow: 200000,
    },
    pipeline: [
      {
        id: 'p1',
        name: 'Policy Retrieval',
        type: 'retrieval',
        enabled: true,
        config: { source: 'compliance_kb', topK: 5 },
      },
      {
        id: 'p2',
        name: 'Action Analysis',
        type: 'reasoning',
        enabled: true,
        config: { structuredOutput: true, format: 'approve|reject|escalate' },
      },
      {
        id: 'p3',
        name: 'Audit Logging',
        type: 'action',
        enabled: true,
        config: { alwaysLog: true, immutable: true },
      },
    ],
    validationBots: [],
  },
  {
    id: 'a7',
    name: 'HR Knowledge Agent',
    description:
      'Answers internal employee questions about HR policies, benefits, leave, and payroll by querying the internal knowledge base.',
    icon: 'H',
    category: 'Internal',
    status: 'active',
    capabilities: [
      'HR Policy Lookup',
      'Leave Calculator',
      'Benefits Info',
      'Payroll FAQ',
    ],
    triggers: [
      'Employee question via chat',
      'HR ticket created',
      'Leave request',
    ],
    actions: [
      'Answer HR query',
      'Calculate leave balance',
      'Link to policy doc',
      'Create HR ticket',
    ],
    requiredApproval: false,
    confidenceThreshold: 82,
    tasksThisMonth: 728,
    successRate: 95,
    knowledgeSources: ['HR Policies', 'Benefits Handbook', 'Payroll Guide'],
    memoryEnabled: true,
    multiAgentEnabled: true,
    subAgents: ['a5'],
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.3,
      maxTokens: 1024,
      systemPrompt:
        'You are an internal HR assistant. Answer employee questions using official HR documentation. Be precise with numbers like leave balances and salary figures.',
      ragEnabled: true,
      ragTopK: 4,
      contextWindow: 128000,
    },
    pipeline: [
      {
        id: 'p1',
        name: 'Employee Auth',
        type: 'validation',
        enabled: true,
        config: { requireEmployeeId: true },
      },
      {
        id: 'p2',
        name: 'HR KB Retrieval',
        type: 'retrieval',
        enabled: true,
        config: { source: 'hr_kb', topK: 4 },
      },
      {
        id: 'p3',
        name: 'Answer Reasoning',
        type: 'reasoning',
        enabled: true,
        config: { temperature: 0.3, citeSource: true },
      },
      {
        id: 'p4',
        name: 'Confidence Gate',
        type: 'validation',
        enabled: true,
        config: { minConfidence: 82 },
      },
      {
        id: 'p5',
        name: 'Response',
        type: 'response',
        enabled: true,
        config: { includeSources: true },
      },
    ],
    validationBots: [
      {
        id: 'v1',
        name: 'Confidence Reviewer',
        type: 'confidence_reviewer',
        enabled: true,
        threshold: 82,
        action: 'escalate',
      },
      {
        id: 'v2',
        name: 'Knowledge Checker',
        type: 'knowledge_checker',
        enabled: true,
        threshold: 75,
        action: 'flag',
      },
    ],
  },
  {
    id: 'a8',
    name: 'Sales Intelligence Agent',
    description:
      'Assists the sales team with prospect research, product comparisons, pricing guidance, and CRM updates based on internal knowledge and product data.',
    icon: 'I',
    category: 'Internal',
    status: 'idle',
    capabilities: [
      'Product Comparison',
      'Pricing Lookup',
      'Prospect Research',
      'CRM Update',
    ],
    triggers: ['Sales team request', 'CRM record created', 'Deal stage change'],
    actions: [
      'Research prospect',
      'Generate comparison doc',
      'Suggest pricing',
      'Update CRM record',
    ],
    requiredApproval: false,
    confidenceThreshold: 78,
    tasksThisMonth: 203,
    successRate: 91,
    knowledgeSources: [
      'Product Catalogue',
      'Pricing Engine',
      'Competitive Intel',
      'CRM Data',
    ],
    memoryEnabled: true,
    multiAgentEnabled: false,
    subAgents: [],
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.5,
      maxTokens: 2048,
      systemPrompt:
        'You are a sales intelligence assistant. Help the sales team with accurate product info, competitive positioning, and deal strategies.',
      ragEnabled: true,
      ragTopK: 6,
      contextWindow: 128000,
    },
    pipeline: [
      {
        id: 'p1',
        name: 'CRM + Product Retrieval',
        type: 'retrieval',
        enabled: true,
        config: { sources: 'crm,product_kb,competitive_intel' },
      },
      {
        id: 'p2',
        name: 'Synthesis & Reasoning',
        type: 'reasoning',
        enabled: true,
        config: { temperature: 0.5, businessContext: true },
      },
      {
        id: 'p3',
        name: 'Confidence Gate',
        type: 'validation',
        enabled: true,
        config: { minConfidence: 78 },
      },
      {
        id: 'p4',
        name: 'Output + CRM Write',
        type: 'action',
        enabled: true,
        config: { canUpdateCRM: true, requireManagerApproval: false },
      },
    ],
    validationBots: [
      {
        id: 'v1',
        name: 'Confidence Reviewer',
        type: 'confidence_reviewer',
        enabled: true,
        threshold: 78,
        action: 'flag',
      },
      {
        id: 'v2',
        name: 'Hallucination Detector',
        type: 'hallucination_detector',
        enabled: true,
        threshold: 80,
        action: 'flag',
      },
    ],
  },
];

const AgentWorkforcePage = ({
  user,
  tenant,
}: {
  user?: AuthUser;
  tenant?: Tenant;
}) => {
  const [agents, setAgents] = useState<AgentDef[]>(defaultAgents);
  const [filter, setFilter] = useState<'all' | 'active' | 'idle' | 'disabled'>(
    'all'
  );
  const [catFilter, setCatFilter] = useState<'all' | 'Customer' | 'Internal'>(
    'all'
  );
  const [selectedAgent, setSelectedAgent] = useState<AgentDef | null>(null);
  const [configTab, setConfigTab] = useState<
    'overview' | 'model' | 'pipeline' | 'validators' | 'actions' | 'knowledge'
  >('overview');
  const accentColor = tenant?.primaryColor || '#6366f1';

  const filtered = agents.filter(
    (a) =>
      (filter === 'all' || a.status === filter) &&
      (catFilter === 'all' || a.category === catFilter)
  );

  const toggleStatus = (id: string) => {
    setAgents((prev) =>
      prev.map((a) =>
        a.id === id
          ? { ...a, status: a.status === 'active' ? 'idle' : 'active' }
          : a
      )
    );
  };

  const statusColor = (s: string) =>
    s === 'active'
      ? 'bg-emerald-500'
      : s === 'idle'
      ? 'bg-amber-500'
      : 'bg-slate-600';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">AI Agents</h1>
          <p className="text-slate-400 text-sm mt-1">
            Configure agents that assist customers and internal staff ÃÂ¢ÃÂÃÂ with
            full audit and approval controls
          </p>
        </div>
        <button
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
          style={{ backgroundColor: accentColor }}
        >
          + Add Agent
        </button>
      </div>

      {/* Agentic Pipeline Banner */}
      <div className="mb-6 bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
          How Agents Work ÃÂ¢ÃÂÃÂ Agentic Pipeline
        </div>
        <div className="flex items-center gap-2 overflow-x-auto">
          {[
            {
              step: '1',
              label: 'Query Received',
              desc: 'Chat / email / trigger',
              color: 'bg-blue-900 text-blue-300',
            },
            {
              step: '2',
              label: 'Intent & Routing',
              desc: 'Best agent selected',
              color: 'bg-indigo-900 text-indigo-300',
            },
            {
              step: '3',
              label: 'KB Retrieval',
              desc: 'RAG over knowledge base',
              color: 'bg-purple-900 text-purple-300',
            },
            {
              step: '4',
              label: 'LLM Reasoning',
              desc: 'Chain-of-thought with model',
              color: 'bg-violet-900 text-violet-300',
            },
            {
              step: '5',
              label: 'Validation Bots',
              desc: 'Confidence + Safety + Compliance',
              color: 'bg-yellow-900 text-yellow-300',
            },
            {
              step: '6',
              label: 'Respond or Escalate',
              desc: 'Auto-act or human review',
              color: 'bg-emerald-900 text-emerald-300',
            },
          ].map((s, idx, arr) => (
            <div key={s.step} className="flex items-center gap-2 flex-shrink-0">
              <div
                className={`px-3 py-2 rounded-lg ${s.color} text-center min-w-[120px]`}
              >
                <div className="text-xs font-bold mb-0.5">{s.label}</div>
                <div className="text-xs opacity-70">{s.desc}</div>
              </div>
              {idx < arr.length - 1 && (
                <span className="text-slate-600 text-lg">{'>'}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Total Agents"
          value={String(agents.length)}
          icon="ÃÂ¢ÃÂÃÂ¡"
          color="blue"
        />
        <StatCard
          label="Active"
          value={String(agents.filter((a) => a.status === 'active').length)}
          icon="ÃÂ¢ÃÂÃÂ"
          color="emerald"
        />
        <StatCard
          label="Customer Agents"
          value={String(agents.filter((a) => a.category === 'Customer').length)}
          icon="ÃÂ¢ÃÂÃÂ"
          color="purple"
        />
        <StatCard
          label="Internal Agents"
          value={String(agents.filter((a) => a.category === 'Internal').length)}
          icon="ÃÂ¢ÃÂÃÂ"
          color="amber"
        />
      </div>

      <div className="flex items-center gap-3 mb-5">
        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
          {(['all', 'active', 'idle', 'disabled'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all capitalize ${
                filter === f ? 'text-white' : 'text-slate-400 hover:text-white'
              }`}
              style={filter === f ? { backgroundColor: accentColor } : {}}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
          {(['all', 'Customer', 'Internal'] as const).map((c) => (
            <button
              key={c}
              onClick={() => setCatFilter(c)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                catFilter === c
                  ? 'text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
              style={catFilter === c ? { backgroundColor: accentColor } : {}}
            >
              {c === 'all' ? 'All' : c + ' Agents'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((agent) => (
          <div
            key={agent.id}
            className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all cursor-pointer"
            onClick={() => {
              setSelectedAgent(agent);
              setConfigTab('overview');
            }}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
                  style={{ backgroundColor: accentColor + '30' }}
                >
                  {agent.icon}
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">
                    {agent.name}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${statusColor(
                        agent.status
                      )}`}
                    />
                    <span className="text-xs text-slate-500 capitalize">
                      {agent.status}
                    </span>
                  </div>
                </div>
              </div>
              <label
                className="relative inline-flex items-center cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleStatus(agent.id);
                }}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={agent.status === 'active'}
                  readOnly
                />
                <div
                  className={`w-9 h-5 rounded-full transition-all ${
                    agent.status === 'active'
                      ? 'bg-emerald-500'
                      : 'bg-slate-700'
                  }`}
                >
                  <div
                    className={`w-4 h-4 bg-white rounded-full shadow transition-all mt-0.5 ${
                      agent.status === 'active' ? 'ml-4' : 'ml-0.5'
                    }`}
                  />
                </div>
              </label>
            </div>
            <p className="text-xs text-slate-400 mb-3 leading-relaxed">
              {agent.description}
            </p>
            <div className="flex flex-wrap gap-1 mb-3">
              <Badge
                label={agent.category}
                color={agent.category === 'Customer' ? 'blue' : 'purple'}
              />
              {agent.requiredApproval && (
                <Badge label="Approval required" color="amber" />
              )}
            </div>
            {/* Model + pipeline info */}
            <div className="flex items-center gap-2 mb-3 text-xs">
              <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                {agent.modelConfig.provider === 'anthropic'
                  ? 'Anthropic'
                  : agent.modelConfig.provider === 'openai'
                  ? 'OpenAI'
                  : agent.modelConfig.provider === 'google'
                  ? 'Google'
                  : 'Custom'}
              </span>
              <span className="text-slate-500">{agent.modelConfig.model}</span>
              <span className="ml-auto text-slate-600">
                {agent.pipeline.filter((p) => p.enabled).length} stages
              </span>
              <span className="text-slate-600">|</span>
              <span className="text-slate-600">
                {agent.validationBots.filter((v) => v.enabled).length}{' '}
                validators
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-slate-800/50 rounded-lg py-2">
                <div className="text-sm font-bold text-white">
                  {agent.tasksThisMonth.toLocaleString()}
                </div>
                <div className="text-xs text-slate-500">tasks/mo</div>
              </div>
              <div className="bg-slate-800/50 rounded-lg py-2">
                <div className="text-sm font-bold text-emerald-400">
                  {agent.successRate}%
                </div>
                <div className="text-xs text-slate-500">success rate</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {selectedAgent && (
        <Modal
          title={'Configure: ' + selectedAgent.name}
          onClose={() => setSelectedAgent(null)}
        >
          {/* Tab bar */}
          <div className="flex gap-1 mb-6 p-1 bg-slate-800 rounded-lg">
            {(
              [
                'overview',
                'model',
                'pipeline',
                'validators',
                'actions',
                'knowledge',
              ] as const
            ).map((t) => (
              <button
                key={t}
                className={`flex-1 py-2 px-2 rounded-md text-xs font-medium capitalize transition-colors ${
                  configTab === t
                    ? 'text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                style={configTab === t ? { backgroundColor: accentColor } : {}}
                onClick={() => setConfigTab(t)}
              >
                {t === 'validators'
                  ? 'Validators'
                  : t === 'knowledge'
                  ? 'Knowledge & Data'
                  : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {/* === OVERVIEW TAB === */}
          {configTab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-800 rounded-lg p-3">
                  <div className="text-xs text-slate-400 mb-1">Status</div>
                  <select
                    className="bg-slate-700 text-white text-sm rounded px-2 py-1 w-full"
                    defaultValue={selectedAgent.status}
                  >
                    <option value="active">Active</option>
                    <option value="idle">Idle</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>
                <div className="bg-slate-800 rounded-lg p-3">
                  <div className="text-xs text-slate-400 mb-1">Audience</div>
                  <select
                    className="bg-slate-700 text-white text-sm rounded px-2 py-1 w-full"
                    defaultValue={selectedAgent.category}
                  >
                    <option value="Customer">Customer-facing</option>
                    <option value="Internal">Internal Staff</option>
                    <option value="Both">Both</option>
                  </select>
                </div>
              </div>
              <div className="bg-slate-800 rounded-lg p-3">
                <div className="text-xs text-slate-400 mb-1">Description</div>
                <textarea
                  className="bg-slate-700 text-white text-sm rounded px-2 py-1 w-full resize-none"
                  rows={2}
                  defaultValue={selectedAgent.description}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-800 rounded-lg p-3">
                  <div className="text-xs text-slate-400 mb-1">
                    Confidence Threshold
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={50}
                      max={99}
                      defaultValue={selectedAgent.confidenceThreshold}
                      className="flex-1 accent-indigo-500"
                    />
                    <span className="text-white text-sm font-bold w-10 text-right">
                      {selectedAgent.confidenceThreshold}%
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    Agent escalates below this
                  </div>
                </div>
                <div className="bg-slate-800 rounded-lg p-3">
                  <div className="text-xs text-slate-400 mb-2">
                    Advanced Capabilities
                  </div>
                  <label className="flex items-center gap-2 mb-2 cursor-pointer">
                    <input
                      type="checkbox"
                      defaultChecked={selectedAgent.memoryEnabled}
                      className="accent-indigo-500"
                    />
                    <span className="text-slate-300 text-xs">
                      Conversation Memory
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      defaultChecked={selectedAgent.multiAgentEnabled}
                      className="accent-indigo-500"
                    />
                    <span className="text-slate-300 text-xs">
                      Multi-Agent Orchestration
                    </span>
                  </label>
                </div>
              </div>
              <div className="bg-slate-800 rounded-lg p-3">
                <div className="text-xs text-slate-400 mb-2">
                  Knowledge Sources
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedAgent.knowledgeSources.map((src) => (
                    <span
                      key={src}
                      className="px-2 py-1 bg-indigo-900 text-indigo-300 rounded text-xs flex items-center gap-1"
                    >
                      {src}
                      <button className="text-indigo-400 hover:text-red-400 ml-1">
                        x
                      </button>
                    </span>
                  ))}
                  <button className="px-2 py-1 bg-slate-700 text-slate-400 rounded text-xs hover:text-white border border-dashed border-slate-600">
                    + Add Source
                  </button>
                </div>
              </div>
              {selectedAgent.multiAgentEnabled &&
                selectedAgent.subAgents.length > 0 && (
                  <div className="bg-slate-800 rounded-lg p-3">
                    <div className="text-xs text-slate-400 mb-2">
                      Sub-Agents (called automatically)
                    </div>
                    <div className="flex gap-2">
                      {selectedAgent.subAgents.map((sid) => {
                        const sub = agents.find((a) => a.id === sid);
                        return sub ? (
                          <span
                            key={sid}
                            className="px-2 py-1 bg-emerald-900 text-emerald-300 rounded text-xs"
                          >
                            {sub.icon} {sub.name}
                          </span>
                        ) : null;
                      })}
                    </div>
                  </div>
                )}
            </div>
          )}

          {/* === MODEL TAB === */}
          {configTab === 'model' && (
            <div className="space-y-4">
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  LLM Provider & Model
                </div>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Provider</div>
                    <select
                      className="bg-slate-700 text-white text-sm rounded px-2 py-2 w-full"
                      defaultValue={selectedAgent.modelConfig.provider}
                    >
                      <option value="anthropic">Anthropic</option>
                      <option value="openai">OpenAI</option>
                      <option value="google">Google</option>
                      <option value="custom">Custom / Self-hosted</option>
                    </select>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Model</div>
                    <select
                      className="bg-slate-700 text-white text-sm rounded px-2 py-2 w-full"
                      defaultValue={selectedAgent.modelConfig.model}
                    >
                      <optgroup label="Anthropic">
                        <option value="claude-opus-4-5">
                          Claude Opus 4.5 (Most capable)
                        </option>
                        <option value="claude-sonnet-4-5">
                          Claude Sonnet 4.5 (Balanced)
                        </option>
                        <option value="claude-haiku-3-5">
                          Claude Haiku 3.5 (Fast)
                        </option>
                      </optgroup>
                      <optgroup label="OpenAI">
                        <option value="gpt-4o">GPT-4o</option>
                        <option value="gpt-4o-mini">GPT-4o Mini</option>
                        <option value="o3">o3 (Reasoning)</option>
                      </optgroup>
                      <optgroup label="Google">
                        <option value="gemini-2-pro">Gemini 2.0 Pro</option>
                        <option value="gemini-2-flash">Gemini 2.0 Flash</option>
                      </optgroup>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <div className="text-xs text-slate-500 mb-1">
                      Temperature
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.1}
                      className="bg-slate-700 text-white text-sm rounded px-2 py-2 w-full"
                      defaultValue={selectedAgent.modelConfig.temperature}
                    />
                    <div className="text-xs text-slate-600 mt-1">
                      0 = precise, 1 = creative
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">
                      Max Output Tokens
                    </div>
                    <input
                      type="number"
                      className="bg-slate-700 text-white text-sm rounded px-2 py-2 w-full"
                      defaultValue={selectedAgent.modelConfig.maxTokens}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">
                      Context Window
                    </div>
                    <input
                      type="number"
                      className="bg-slate-700 text-white text-sm rounded px-2 py-2 w-full"
                      defaultValue={selectedAgent.modelConfig.contextWindow}
                    />
                  </div>
                </div>
              </div>
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-2 font-semibold uppercase tracking-wide">
                  System Prompt
                </div>
                <textarea
                  className="bg-slate-700 text-white text-sm rounded px-3 py-2 w-full resize-none font-mono"
                  rows={5}
                  defaultValue={selectedAgent.modelConfig.systemPrompt}
                />
                <div className="text-xs text-slate-500 mt-1">
                  Use {'{kb_context}'} to inject retrieved knowledge. Use{' '}
                  {'{customer_name}'} for personalisation.
                </div>
              </div>
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  RAG (Retrieval-Augmented Generation)
                </div>
                <label className="flex items-center gap-2 mb-3 cursor-pointer">
                  <input
                    type="checkbox"
                    defaultChecked={selectedAgent.modelConfig.ragEnabled}
                    className="accent-indigo-500"
                  />
                  <span className="text-slate-300 text-sm">
                    Enable RAG ÃÂ¢ÃÂÃÂ inject retrieved KB context before reasoning
                  </span>
                </label>
                {selectedAgent.modelConfig.ragEnabled && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-slate-500 mb-1">
                        Top-K Chunks to Retrieve
                      </div>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        className="bg-slate-700 text-white text-sm rounded px-2 py-2 w-full"
                        defaultValue={selectedAgent.modelConfig.ragTopK}
                      />
                    </div>
                    <div>
                      <div className="text-xs text-slate-500 mb-1">
                        Retrieval Strategy
                      </div>
                      <select className="bg-slate-700 text-white text-sm rounded px-2 py-2 w-full">
                        <option value="semantic">Semantic (vector)</option>
                        <option value="hybrid">
                          Hybrid (semantic + keyword)
                        </option>
                        <option value="keyword">Keyword (BM25)</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* === PIPELINE TAB === */}
          {configTab === 'pipeline' && (
            <div className="space-y-3">
              <div className="text-xs text-slate-400 mb-3">
                The pipeline defines how this agent processes each incoming
                request ÃÂ¢ÃÂÃÂ from retrieval through reasoning to response. Drag to
                reorder stages.
              </div>
              {selectedAgent.pipeline.map((stage, idx) => {
                const stageColors: Record<string, string> = {
                  retrieval: 'text-blue-400 bg-blue-900',
                  reasoning: 'text-purple-400 bg-purple-900',
                  validation: 'text-yellow-400 bg-yellow-900',
                  action: 'text-emerald-400 bg-emerald-900',
                  response: 'text-indigo-400 bg-indigo-900',
                };
                const color =
                  stageColors[stage.type] || 'text-slate-400 bg-slate-700';
                return (
                  <div
                    key={stage.id}
                    className="bg-slate-800 rounded-lg p-3 border border-slate-700"
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-slate-600 text-sm font-mono w-5">
                        {idx + 1}.
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${color}`}
                      >
                        {stage.type}
                      </span>
                      <span className="text-white text-sm font-medium flex-1">
                        {stage.name}
                      </span>
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          defaultChecked={stage.enabled}
                          className="accent-indigo-500"
                        />
                        <span className="text-xs text-slate-400">Enabled</span>
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2 pl-8">
                      {Object.entries(stage.config).map(([k, v]) => (
                        <span
                          key={k}
                          className="px-2 py-0.5 bg-slate-700 rounded text-xs text-slate-400"
                        >
                          <span className="text-slate-500">{k}:</span>{' '}
                          <span className="text-slate-300">{String(v)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
              <button className="w-full py-2 rounded border border-dashed border-slate-600 text-slate-500 text-sm hover:border-indigo-500 hover:text-indigo-400 transition-colors">
                + Add Pipeline Stage
              </button>
            </div>
          )}

          {/* === VALIDATORS TAB === */}
          {configTab === 'validators' && (
            <div className="space-y-3">
              <div className="text-xs text-slate-400 mb-3">
                Validation bots run automatically at each reasoning step. They
                can flag, block, or escalate based on confidence scores, policy
                violations, or detected hallucinations.
              </div>
              {selectedAgent.validationBots.length === 0 && (
                <div className="text-center py-8 text-slate-500 text-sm">
                  No validators configured for this agent.
                </div>
              )}
              {selectedAgent.validationBots.map((bot) => {
                const botIcons: Record<string, string> = {
                  confidence_reviewer: 'CR',
                  knowledge_checker: 'KC',
                  safety_guard: 'SG',
                  compliance_bot: 'CB',
                  hallucination_detector: 'HD',
                };
                const botColors: Record<string, string> = {
                  confidence_reviewer: 'bg-blue-900 text-blue-300',
                  knowledge_checker: 'bg-indigo-900 text-indigo-300',
                  safety_guard: 'bg-red-900 text-red-300',
                  compliance_bot: 'bg-yellow-900 text-yellow-300',
                  hallucination_detector: 'bg-orange-900 text-orange-300',
                };
                const actionColors: Record<string, string> = {
                  flag: 'text-yellow-400',
                  block: 'text-red-400',
                  escalate: 'text-orange-400',
                  log: 'text-slate-400',
                };
                return (
                  <div
                    key={bot.id}
                    className="bg-slate-800 rounded-lg p-4 border border-slate-700"
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                          botColors[bot.type] || 'bg-slate-700 text-slate-300'
                        }`}
                      >
                        {botIcons[bot.type] || '?'}
                      </span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-white text-sm font-medium">
                            {bot.name}
                          </span>
                          <label className="flex items-center gap-1 cursor-pointer ml-auto">
                            <input
                              type="checkbox"
                              defaultChecked={bot.enabled}
                              className="accent-indigo-500"
                            />
                            <span className="text-xs text-slate-400">
                              Active
                            </span>
                          </label>
                        </div>
                        <div className="text-xs text-slate-500 mb-2 capitalize">
                          {bot.type.replace(/_/g, ' ')}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <div className="text-xs text-slate-500 mb-1">
                              Threshold
                            </div>
                            <div className="flex items-center gap-2">
                              <input
                                type="range"
                                min={50}
                                max={99}
                                defaultValue={bot.threshold}
                                className="flex-1 accent-indigo-500"
                              />
                              <span className="text-white text-xs font-bold w-8 text-right">
                                {bot.threshold}%
                              </span>
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-slate-500 mb-1">
                              If threshold breached
                            </div>
                            <select
                              className="bg-slate-700 text-white text-xs rounded px-2 py-1 w-full"
                              defaultValue={bot.action}
                            >
                              <option value="flag">Flag for review</option>
                              <option value="block">Block response</option>
                              <option value="escalate">
                                Escalate to human
                              </option>
                              <option value="log">Log only</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              <button className="w-full py-2 rounded border border-dashed border-slate-600 text-slate-500 text-sm hover:border-indigo-500 hover:text-indigo-400 transition-colors">
                + Add Validation Bot
              </button>
            </div>
          )}

          {/* === ACTIONS TAB === */}
          {configTab === 'actions' && (
            <div className="space-y-4">
              <div className="text-xs text-slate-400 mb-3">
                Define what this agent is permitted to do ÃÂ¢ÃÂÃÂ read-only queries,
                write actions, or financial transactions ÃÂ¢ÃÂÃÂ and whether each
                requires human approval.
              </div>
              <div className="space-y-2">
                {selectedAgent.actions.map((action) => {
                  const isTransaction =
                    action.toLowerCase().includes('refund') ||
                    action.toLowerCase().includes('payment') ||
                    action.toLowerCase().includes('charge') ||
                    action.toLowerCase().includes('subscription');
                  const isWrite =
                    action.toLowerCase().includes('create') ||
                    action.toLowerCase().includes('update') ||
                    action.toLowerCase().includes('send') ||
                    action.toLowerCase().includes('assign') ||
                    action.toLowerCase().includes('reset');
                  const actionType = isTransaction
                    ? 'transaction'
                    : isWrite
                    ? 'write'
                    : 'read';
                  const typeColors: Record<string, string> = {
                    read: 'bg-blue-900 text-blue-300',
                    write: 'bg-yellow-900 text-yellow-300',
                    transaction: 'bg-red-900 text-red-300',
                  };
                  return (
                    <div
                      key={action}
                      className="bg-slate-800 rounded-lg p-3 flex items-center gap-3"
                    >
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${typeColors[actionType]}`}
                      >
                        {actionType}
                      </span>
                      <span className="text-slate-200 text-sm flex-1">
                        {action}
                      </span>
                      <label className="flex items-center gap-1 cursor-pointer text-xs text-slate-400">
                        <input
                          type="checkbox"
                          defaultChecked={actionType === 'transaction'}
                          className="accent-orange-500"
                        />
                        Approval required
                      </label>
                      <label className="flex items-center gap-1 cursor-pointer text-xs text-slate-400">
                        <input
                          type="checkbox"
                          defaultChecked={true}
                          className="accent-indigo-500"
                        />
                        Audit log
                      </label>
                    </div>
                  );
                })}
              </div>
              <button className="w-full py-2 rounded border border-dashed border-slate-600 text-slate-500 text-sm hover:border-indigo-500 hover:text-indigo-400 transition-colors">
                + Add Permitted Action
              </button>
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Global Action Policy
                </div>
                <label className="flex items-center gap-2 mb-2 cursor-pointer">
                  <input
                    type="checkbox"
                    defaultChecked={selectedAgent.requiredApproval}
                    className="accent-orange-500"
                  />
                  <span className="text-slate-300 text-sm">
                    Require human approval for ALL actions (override)
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    defaultChecked={true}
                    className="accent-indigo-500"
                  />
                  <span className="text-slate-300 text-sm">
                    Always audit-log every action taken
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* === KNOWLEDGE & DATA TAB === */}
          {configTab === 'knowledge' && (
            <div className="space-y-4">
              <div className="text-xs text-slate-400 mb-3">
                Configure exactly which knowledge articles, data connector
                fields, and imported files this agent can retrieve during its
                RAG pipeline.
              </div>

              {/* Knowledge Sources ÃÂ¢ÃÂÃÂ taxonomy picker */}
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Knowledge Sources (KB Articles)
                </div>
                <div className="space-y-2">
                  {knowledgeTaxonomy.map((prod) => {
                    const items = mockKnowledgeItems.filter(
                      (i) => i.productId === prod.id
                    );
                    const connected = selectedAgent.knowledgeSources.some((s) =>
                      s
                        .toLowerCase()
                        .includes(prod.label.toLowerCase().split(' ')[0])
                    );
                    return (
                      <div
                        key={prod.id}
                        className="flex items-start gap-3 p-2 rounded-lg bg-slate-750 border border-slate-700"
                      >
                        <input
                          type="checkbox"
                          defaultChecked={connected}
                          className="mt-0.5 accent-indigo-500 flex-shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className="w-2 h-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: prod.color }}
                            />
                            <span className="text-sm text-white font-medium">
                              {prod.label}
                            </span>
                            <span className="text-xs text-slate-500 ml-auto">
                              {items.length} articles
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {prod.modules.slice(0, 3).map((mod) => (
                              <span
                                key={mod.id}
                                className="px-1.5 py-0.5 bg-slate-700 text-slate-400 rounded text-xs"
                              >
                                {mod.label}
                              </span>
                            ))}
                            {prod.modules.length > 3 && (
                              <span className="text-xs text-slate-600">
                                +{prod.modules.length - 3} more
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Data Connectors ÃÂ¢ÃÂÃÂ field-level scope */}
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Data Connector Bindings
                </div>
                <div className="space-y-2">
                  {registeredConnectors.map((dc) => {
                    const binding = dc.agentBindings.find(
                      (b) => b.agentId === selectedAgent.id
                    );
                    const isBound = !!binding;
                    const catColors2: Record<ConnectorCategory, string> = {
                      crm: 'bg-blue-900 text-blue-300',
                      billing: 'bg-emerald-900 text-emerald-300',
                      hr: 'bg-purple-900 text-purple-300',
                      support: 'bg-orange-900 text-orange-300',
                      analytics: 'bg-yellow-900 text-yellow-300',
                      storage: 'bg-slate-700 text-slate-300',
                      communication: 'bg-indigo-900 text-indigo-300',
                      custom: 'bg-red-900 text-red-300',
                    };
                    return (
                      <div
                        key={dc.id}
                        className={`p-3 rounded-lg border ${
                          isBound
                            ? 'border-indigo-700 bg-indigo-950/20'
                            : 'border-slate-700 bg-slate-750'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <input
                            type="checkbox"
                            defaultChecked={isBound}
                            className="accent-indigo-500 flex-shrink-0"
                          />
                          <span className="w-6 h-6 rounded bg-slate-700 flex items-center justify-center text-xs font-bold text-slate-300 flex-shrink-0">
                            {dc.icon}
                          </span>
                          <span className="text-sm text-white font-medium">
                            {dc.name}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-xs ${
                              catColors2[dc.category]
                            }`}
                          >
                            {dc.category}
                          </span>
                          <span
                            className={`text-xs ml-auto ${
                              dc.status === 'connected'
                                ? 'text-emerald-400'
                                : 'text-slate-500'
                            }`}
                          >
                            {dc.status}
                          </span>
                        </div>
                        {isBound && binding && (
                          <div className="ml-8 mt-1.5 flex flex-wrap gap-1">
                            {binding.objects.map((obj) => {
                              const readable = Object.entries(
                                obj.fieldPermissions
                              )
                                .filter(([, v]) => v === 'read')
                                .map(([k]) => k);
                              const writable = Object.entries(
                                obj.fieldPermissions
                              )
                                .filter(([, v]) => v === 'write')
                                .map(([k]) => k);
                              return (
                                <div key={obj.objectName} className="text-xs">
                                  <span className="text-slate-500">
                                    {obj.objectName}:{' '}
                                  </span>
                                  {readable.length > 0 && (
                                    <span className="text-emerald-500">
                                      read({readable.slice(0, 3).join(', ')}
                                      {readable.length > 3 ? '...' : ''})
                                    </span>
                                  )}
                                  {writable.length > 0 && (
                                    <span className="text-yellow-500 ml-1">
                                      write({writable.join(', ')})
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {!isBound && (
                          <div className="ml-8 text-xs text-slate-600 mt-0.5">
                            {dc.objects.length} objects available ÃÂ¢ÃÂÃÂ enable to
                            configure field permissions
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Imported Files */}
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Imported Files Access
                </div>
                <div className="space-y-1.5">
                  {mockImportedFiles
                    .filter((f) => f.status === 'indexed')
                    .map((file) => {
                      const fileTypeColors: Record<string, string> = {
                        PDF: 'text-red-400',
                        XLSX: 'text-emerald-400',
                        DOCX: 'text-blue-400',
                        PPTX: 'text-orange-400',
                        MD: 'text-slate-400',
                      };
                      return (
                        <div key={file.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            defaultChecked={
                              file.audience === 'Both' ||
                              (file.audience === 'Internal' &&
                                selectedAgent.category === 'Internal')
                            }
                            className="accent-indigo-500 flex-shrink-0"
                          />
                          <span
                            className={`text-xs font-bold ${
                              fileTypeColors[file.type] || 'text-slate-400'
                            }`}
                          >
                            {file.type}
                          </span>
                          <span className="text-xs text-slate-300 flex-1 truncate">
                            {file.name}
                          </span>
                          <span className="text-xs text-slate-600">
                            {file.chunkCount} chunks
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-xs bg-slate-700 ${
                              file.audience === 'Customer'
                                ? 'text-indigo-300'
                                : file.audience === 'Internal'
                                ? 'text-slate-300'
                                : 'text-teal-300'
                            }`}
                          >
                            {file.audience}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Retrieval Priority */}
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Retrieval Priority Order
                </div>
                <div className="text-xs text-slate-500 mb-2">
                  Sources are queried in this order during RAG retrieval. Drag
                  to reorder.
                </div>
                <div className="space-y-1.5">
                  {[
                    '1. Knowledge Base Articles',
                    '2. Data Connectors (live)',
                    '3. Imported Files',
                    '4. Insight Engine Queries',
                  ].map((item, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 p-2 bg-slate-700 rounded-lg cursor-move"
                    >
                      <span className="text-slate-600 text-xs">{'='}</span>
                      <span className="text-xs text-slate-300">{item}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Test Retrieval */}
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Test Retrieval
                </div>
                <div className="flex gap-2">
                  <input
                    placeholder={
                      'Enter a sample query to test what this agent would retrieve...'
                    }
                    className="flex-1 bg-slate-700 border border-slate-600 text-white text-xs rounded-lg px-3 py-2 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    className="px-3 py-2 rounded-lg text-white text-xs font-medium"
                    style={{ backgroundColor: accentColor }}
                  >
                    Test
                  </button>
                </div>
                <div className="mt-2 space-y-1.5 text-xs">
                  {[
                    {
                      source: 'KB Article',
                      title: 'How to Request a Refund',
                      breadcrumb:
                        'DreamTeam Platform ÃÂ¢ÃÂÃÂº Billing ÃÂ¢ÃÂÃÂº Invoices & Payments ÃÂ¢ÃÂÃÂº Refund Policy',
                      score: 0.94,
                    },
                    {
                      source: 'Stripe Billing',
                      title: 'Invoice #inv_2026_0621',
                      breadcrumb:
                        'Customer ÃÂ¢ÃÂÃÂº Invoice ÃÂ¢ÃÂÃÂº amount, status, lineItems',
                      score: 0.88,
                    },
                    {
                      source: 'Imported File',
                      title: 'Product_Pricing_Sheet_Q2_2026.xlsx',
                      breadcrumb:
                        'DreamTeam Platform ÃÂ¢ÃÂÃÂº Billing & Subscriptions',
                      score: 0.72,
                    },
                  ].map((r, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 p-2 bg-slate-900 rounded-lg"
                    >
                      <span
                        className={`px-1.5 py-0.5 rounded text-xs flex-shrink-0 ${
                          r.source === 'KB Article'
                            ? 'bg-indigo-900 text-indigo-300'
                            : r.source === 'Imported File'
                            ? 'bg-yellow-900 text-yellow-300'
                            : 'bg-emerald-900 text-emerald-300'
                        }`}
                      >
                        {r.source}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-slate-300 truncate">{r.title}</div>
                        <div className="text-slate-600 truncate">
                          {r.breadcrumb}
                        </div>
                      </div>
                      <span className="text-emerald-400 font-mono flex-shrink-0">
                        {r.score.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-700">
            <button
              onClick={() => setSelectedAgent(null)}
              className="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 text-sm hover:bg-slate-600"
            >
              Cancel
            </button>
            <button
              className="px-4 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90"
              style={{ backgroundColor: accentColor }}
            >
              Save Configuration
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ============================================================
// KNOWLEDGE HUB PAGE
// ============================================================

const KnowledgeHubPage = ({
  user,
  tenant,
  subPage,
    dbArticles = [],
}: {
  user?: AuthUser;
  tenant?: Tenant;
  subPage: TenantPage;
  dbArticles?: DBKnowledgeArticle[];
}) => {
  // Use real DB articles when available, fallback to mock
  const allKnowledgeItems = dbArticles.length > 0
    ? dbArticles.map(a => ({
        id: a.id, title: a.title, type: 'article' as const,
        audience: a.audience, tags: a.tags || [], subTags: [],
        summary: a.summary || '', author: '', version: '1.0',
        createdAt: a.created_at, updatedAt: a.updated_at,
        freshnessScore: a.freshness_score, viewCount: a.view_count,
        helpfulRating: a.helpful_count, embedStatus: 'embedded' as const,
        chunkCount: 0, status: a.status as any, category: a.category || '',
        productId: '', moduleId: '', sectionId: '', subSectionId: '',
        qualityScore: a.quality_score, body: a.body,
      }))
    : mockKnowledgeItems;

  const accentColor = tenant?.primaryColor || '#6366f1';
  const [searchQ, setSearchQ] = useState('');
  const [selectedArticle, setSelectedArticle] = useState<null | {
    id: string;
    title: string;
    category: string;
    tags: string[];
    status: string;
    views: number;
    helpful: number;
    audience: string;
    updated: string;
    content: string;
  }>(null);

  const articles = [
    {
      id: 'k1',
      title: 'Getting Started Guide',
      category: 'Onboarding',
      tags: ['setup', 'beginner'],
      status: 'published',
      views: 1842,
      helpful: 94,
      audience: 'both',
      updated: '2 days ago',
      content:
        'Welcome to our platform. This guide walks you through initial setup, configuration, and your first steps.',
    },
    {
      id: 'k2',
      title: 'Password Reset and Account Recovery',
      category: 'Security',
      tags: ['password', 'account'],
      status: 'published',
      views: 3201,
      helpful: 98,
      audience: 'customer',
      updated: '1 week ago',
      content:
        'Step-by-step instructions for resetting your password and recovering your account through email or SMS verification.',
    },
    {
      id: 'k3',
      title: 'Benefits Enrollment Process',
      category: 'HR',
      tags: ['benefits', 'enrollment'],
      status: 'published',
      views: 567,
      helpful: 92,
      audience: 'internal',
      updated: '3 days ago',
      content:
        'Annual benefits enrollment opens November 1. This guide covers all available plans, how to enroll, and key deadlines.',
    },
    {
      id: 'k4',
      title: 'API Integration Reference',
      category: 'Technical',
      tags: ['api', 'developers'],
      status: 'published',
      views: 2109,
      helpful: 89,
      audience: 'customer',
      updated: '5 days ago',
      content:
        'Complete API documentation including authentication, endpoints, rate limits, and code examples.',
    },
    {
      id: 'k5',
      title: 'Data Retention and Privacy Policy',
      category: 'Compliance',
      tags: ['privacy', 'gdpr'],
      status: 'published',
      views: 445,
      helpful: 86,
      audience: 'both',
      updated: '2 weeks ago',
      content:
        'Our data retention policy describes how long we keep data and how customers can request deletion.',
    },
    {
      id: 'k6',
      title: 'Expense Report Submission Guide',
      category: 'Finance',
      tags: ['expenses', 'finance'],
      status: 'draft',
      views: 0,
      helpful: 0,
      audience: 'internal',
      updated: 'Draft',
      content:
        'How to submit expense reports using our finance system, including approval thresholds and reimbursement timelines.',
    },
    {
      id: 'k7',
      title: 'Billing and Invoice FAQ',
      category: 'Billing',
      tags: ['billing', 'invoice'],
      status: 'published',
      views: 1654,
      helpful: 91,
      audience: 'customer',
      updated: '4 days ago',
      content:
        'Answers to common billing questions: payment methods, invoice generation, plan upgrades, and credit notes.',
    },
    {
      id: 'k8',
      title: 'Remote Work Policy',
      category: 'HR',
      tags: ['remote', 'policy'],
      status: 'published',
      views: 892,
      helpful: 88,
      audience: 'internal',
      updated: '1 month ago',
      content:
        'Company policy on remote and hybrid work arrangements, equipment allowances, and communication expectations.',
    },
    {
      id: 'k9',
      title: 'Product Release Notes v4.2',
      category: 'Releases',
      tags: ['release', 'changelog'],
      status: 'published',
      views: 2341,
      helpful: 95,
      audience: 'both',
      updated: '1 day ago',
      content:
        'Version 4.2 release notes including new features, improvements, bug fixes, and migration notes.',
    },
    {
      id: 'k10',
      title: 'SLA and Support Tiers',
      category: 'Support',
      tags: ['sla', 'support'],
      status: 'published',
      views: 1102,
      helpful: 93,
      audience: 'customer',
      updated: '1 week ago',
      content:
        'Details on our support tier system, response time guarantees, and how to escalate to higher support levels.',
    },
  ];

  const ingestionSources = [
    {
      name: 'Confluence Wiki',
      status: 'syncing',
      docs: 1248,
      lastSync: '10 min ago',
      icon: 'C',
    },
    {
      name: 'Zendesk Tickets',
      status: 'active',
      docs: 8421,
      lastSync: '1 hr ago',
      icon: 'Z',
    },
    {
      name: 'Google Drive',
      status: 'active',
      docs: 342,
      lastSync: '30 min ago',
      icon: 'G',
    },
    {
      name: 'Notion Workspace',
      status: 'active',
      docs: 567,
      lastSync: '2 hr ago',
      icon: 'N',
    },
    {
      name: 'GitHub READMEs',
      status: 'active',
      docs: 89,
      lastSync: '1 day ago',
      icon: 'H',
    },
    {
      name: 'PDF Uploads',
      status: 'active',
      docs: 124,
      lastSync: 'Continuous',
      icon: 'P',
    },
  ];

  const trainingModules = [
    {
      title: 'Product Overview and Features',
      completions: 87,
      duration: '45 min',
      category: 'Onboarding',
    },
    {
      title: 'Security Best Practices',
      completions: 92,
      duration: '30 min',
      category: 'Security',
    },
    {
      title: 'Customer Communication Standards',
      completions: 78,
      duration: '60 min',
      category: 'Service',
    },
    {
      title: 'Billing and Pricing Deep Dive',
      completions: 64,
      duration: '40 min',
      category: 'Finance',
    },
    {
      title: 'Compliance and Data Privacy',
      completions: 95,
      duration: '50 min',
      category: 'Compliance',
    },
    {
      title: 'Using the AI Assistant Effectively',
      completions: 71,
      duration: '25 min',
      category: 'AI Tools',
    },
  ];

  const filteredArticles = articles.filter(
    (a) =>
      a.title.toLowerCase().includes(searchQ.toLowerCase()) ||
      a.category.toLowerCase().includes(searchQ.toLowerCase())
  );

  if (subPage === 'hub_overview') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Knowledge Hub</h1>
          <p className="text-slate-400 text-sm mt-1">
            AI-powered knowledge for customers and internal staff ÃÂ¢ÃÂÃÂ one source
            of truth, served intelligently
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Total Articles"
            value="2,847"
            icon="ÃÂ¢ÃÂÃÂ"
            color="indigo"
            trend="+127 this month"
          />
          <StatCard
            label="Sources Syncing"
            value="6"
            icon="ÃÂ¢ÃÂÃÂ"
            color="emerald"
            trend="All healthy"
          />
          <StatCard
            label="Queries Answered"
            value="12,481"
            icon="ÃÂ¢ÃÂÃÂ"
            color="blue"
            trend="+18% this week"
          />
          <StatCard
            label="Coverage Score"
            value="94%"
            icon="ÃÂ¢ÃÂÃÂ"
            color="amber"
            trend="+2% vs last month"
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Audience Coverage
            </h2>
            <div className="space-y-3">
              {[
                {
                  label: 'Customer-Facing Articles',
                  count: 1420,
                  pct: 50,
                  color: '#3b82f6',
                },
                {
                  label: 'Internal Staff Articles',
                  count: 892,
                  pct: 31,
                  color: '#8b5cf6',
                },
                {
                  label: 'Shared Both Audiences',
                  count: 535,
                  pct: 19,
                  color: '#10b981',
                },
              ].map((item, i) => (
                <div key={i}>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>{item.label}</span>
                    <span className="text-white">
                      {item.count.toLocaleString()} ({item.pct}%)
                    </span>
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: item.pct + '%',
                        backgroundColor: item.color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Top Categories
            </h2>
            <div className="space-y-2">
              {[
                { name: 'Product and Features', count: 612 },
                { name: 'Billing and Payments', count: 489 },
                { name: 'Security and Compliance', count: 341 },
                { name: 'HR and People Ops', count: 298 },
                { name: 'Technical and API', count: 267 },
                { name: 'Onboarding', count: 224 },
              ].map((c, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50"
                >
                  <span className="flex-1 text-sm text-white">{c.name}</span>
                  <span className="text-xs text-slate-400">
                    {c.count} articles
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (subPage === 'hub_articles') {
    const kbItems = mockKnowledgeItems.filter((a) =>
      searchQ ? a.title.toLowerCase().includes(searchQ.toLowerCase()) : true
    );
    const published = kbItems.filter((a) => a.embedStatus === 'indexed').length;
    const drafts = kbItems.filter((a) => a.embedStatus === 'pending').length;
    const stale = kbItems.filter((a) => a.embedStatus === 'stale').length;
    const avgFresh = Math.round(
      kbItems.reduce((s, a) => s + a.freshnessScore, 0) / (kbItems.length || 1)
    );
    const avgQuality = Math.round(
      kbItems.reduce(
        (s, a) =>
          s +
          Math.min(
            100,
            Math.round(a.freshnessScore * 0.6 + (a.chunkCount / 30) * 40)
          ),
        0
      ) / (kbItems.length || 1)
    );
    const coverageGaps = [
      { topic: 'API Rate Limits & Throttling', activeCases: 47, articles: 0 },
      {
        topic: 'Multi-Factor Authentication Setup',
        activeCases: 34,
        articles: 0,
      },
      { topic: 'Bulk Data Export Guide', activeCases: 28, articles: 1 },
      { topic: 'Webhook Configuration', activeCases: 19, articles: 0 },
    ];
    const [showCreateModal, setShowCreateModal] = React.useState(false);
    const [createType, setCreateType] = React.useState<
      'write' | 'upload' | 'url' | 'template' | null
    >(null);
    const [newTitle, setNewTitle] = React.useState('');
    const [newBody, setNewBody] = React.useState('');
    const [filterStatus, setFilterStatus] = React.useState<string>('all');
    const [filterAudience, setFilterAudience] = React.useState<string>('all');
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Knowledge Base</h1>
            <p className="text-slate-400 text-sm mt-1">
              Articles, docs, and release notes tagged and indexed for AI
              retrieval
            </p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold shadow-lg hover:opacity-90 transition-opacity"
            style={{ backgroundColor: accentColor }}
          >
            + New Article
          </button>
        </div>
        <div className="grid grid-cols-6 gap-3 mb-6">
          {[
            { label: 'ARTICLES', value: kbItems.length, color: 'text-white' },
            { label: 'PUBLISHED', value: published, color: 'text-emerald-400' },
            { label: 'DRAFTS', value: drafts, color: 'text-yellow-400' },
            { label: 'STALE', value: stale, color: 'text-orange-400' },
            {
              label: 'AVG QUALITY',
              value: avgQuality + '%',
              color: 'text-violet-300',
            },
            {
              label: 'AVG FRESHNESS',
              value: avgFresh + '%',
              color: 'text-blue-300',
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className="bg-slate-900 border border-slate-800 rounded-xl p-4"
            >
              <p className="text-slate-500 text-xs font-semibold tracking-widest mb-1">
                {stat.label}
              </p>
              <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 mb-4">
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search articles, tags, KB IDs..."
            className="flex-1 max-w-sm bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
          />
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-violet-500"
          >
            <option value="all">All Status</option>
            <option value="indexed">Published</option>
            <option value="pending">Drafts</option>
            <option value="stale">Stale</option>
          </select>
          <select
            value={filterAudience}
            onChange={(e) => setFilterAudience(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-violet-500"
          >
            <option value="all">All Audiences</option>
            <option value="Customer">Customer</option>
            <option value="Internal">Internal</option>
            <option value="Both">Both</option>
          </select>
          <span className="text-slate-500 text-sm ml-auto">
            {kbItems.length} articles
          </span>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950">
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-24">
                  KB ID
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3">
                  ARTICLE
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-36">
                  TAGS
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-24">
                  UPDATED
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-28">
                  QUALITY
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-28">
                  FRESHNESS
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-24">
                  AUDIENCE
                </th>
                <th className="text-right text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-28">
                  ACTIONS
                </th>
              </tr>
            </thead>
            <tbody>
              {kbItems
                .filter(
                  (a) =>
                    filterStatus === 'all' || a.embedStatus === filterStatus
                )
                .filter(
                  (a) =>
                    filterAudience === 'all' || a.audience === filterAudience
                )
                .map((article, idx) => {
                  const quality = Math.min(
                    100,
                    Math.round(
                      article.freshnessScore * 0.6 +
                        (article.chunkCount / 30) * 40
                    )
                  );
                  const qualityColor =
                    quality >= 85
                      ? '#10b981'
                      : quality >= 65
                      ? '#f59e0b'
                      : '#ef4444';
                  const freshColor =
                    article.freshnessScore >= 80
                      ? '#10b981'
                      : article.freshnessScore >= 50
                      ? '#f59e0b'
                      : '#ef4444';
                  const kbId =
                    'KB-' +
                    String(1000 + idx * 37 + article.chunkCount)
                      .padStart(4, '0')
                      .substring(0, 4);
                  return (
                    <tr
                      key={article.id}
                      className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors group"
                    >
                      <td className="px-4 py-3 font-mono text-slate-500 text-xs">
                        {kbId} <span className="text-slate-700">v1</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-white text-sm leading-snug">
                          {article.title}
                        </div>
                        <div className="text-slate-500 text-xs mt-0.5 truncate max-w-xs">
                          {article.summary}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {article.tags.slice(0, 2).map((t) => (
                            <span
                              key={t}
                              className="px-2 py-0.5 rounded-full text-xs bg-slate-800 text-slate-300 border border-slate-700"
                            >
                              {t}
                            </span>
                          ))}
                          {article.tags.length > 2 && (
                            <span className="px-2 py-0.5 rounded-full text-xs text-slate-500">
                              +{article.tags.length - 2}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                        {new Date(article.updatedAt).toLocaleDateString(
                          'en-US',
                          { month: 'short', day: 'numeric', year: '2-digit' }
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-slate-800 rounded-full h-1.5 min-w-12">
                            <div
                              className="h-1.5 rounded-full"
                              style={{
                                width: quality + '%',
                                backgroundColor: qualityColor,
                              }}
                            ></div>
                          </div>
                          <span className="text-xs text-slate-400 w-6">
                            {quality}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-slate-800 rounded-full h-1.5 min-w-12">
                            <div
                              className="h-1.5 rounded-full"
                              style={{
                                width: article.freshnessScore + '%',
                                backgroundColor: freshColor,
                              }}
                            ></div>
                          </div>
                          <span className="text-xs text-slate-400 w-6">
                            {article.freshnessScore}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            article.audience === 'Customer'
                              ? 'bg-blue-900/40 text-blue-300 border border-blue-800'
                              : article.audience === 'Internal'
                              ? 'bg-purple-900/40 text-purple-300 border border-purple-800'
                              : 'bg-teal-900/40 text-teal-300 border border-teal-800'
                          }`}
                        >
                          {article.audience}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">
                            Edit
                          </button>
                          <button className="px-2 py-1 text-xs text-emerald-400 hover:bg-emerald-900/30 rounded transition-colors">
                            {article.embedStatus === 'indexed'
                              ? 'Live'
                              : 'Publish'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="bg-slate-900 border border-amber-800/40 rounded-xl overflow-hidden mb-6">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-amber-950/10">
            <div className="flex items-center gap-2">
              <span className="text-amber-400 text-sm">&#9888;</span>
              <span className="text-xs font-semibold text-slate-400 tracking-widest">
                COVERAGE GAPS
              </span>
              <span className="text-slate-600 mx-1">&#183;</span>
              <span className="text-xs text-slate-500">
                TOPICS WITH ZERO KB ARTICLES
              </span>
            </div>
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-900/30 text-amber-300 border border-amber-800/50">
              AI-DETECTED
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-2">
                  TOPIC
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-2 w-36">
                  ACTIVE CASES
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-2 w-24">
                  ARTICLES
                </th>
                <th className="px-4 py-2 w-36"></th>
              </tr>
            </thead>
            <tbody>
              {coverageGaps.map((gap, i) => (
                <tr
                  key={i}
                  className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors"
                >
                  <td className="px-4 py-3 text-slate-300 text-sm">
                    {gap.topic}
                  </td>
                  <td className="px-4 py-3 text-amber-400 font-semibold text-sm">
                    {gap.activeCases}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-sm">
                    {gap.articles}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => {
                        setShowCreateModal(true);
                        setNewTitle(gap.topic);
                        setCreateType('write');
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700 transition-colors ml-auto"
                    >
                      + Create Draft
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {showCreateModal && (
          <Modal
            title="New Knowledge Article"
            onClose={() => {
              setShowCreateModal(false);
              setCreateType(null);
              setNewTitle('');
              setNewBody('');
            }}
          >
            {!createType ? (
              <div>
                <p className="text-slate-400 text-sm mb-4">
                  How would you like to create this article?
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {(
                    [
                      {
                        type: 'write' as const,
                        label: 'Write Article',
                        desc: 'Create directly in the platform',
                      },
                      {
                        type: 'upload' as const,
                        label: 'Upload PDF / DOCX',
                        desc: 'Policy docs, manuals, guides',
                      },
                      {
                        type: 'url' as const,
                        label: 'Import from URL',
                        desc: 'Crawl your help centre or docs site',
                      },
                      {
                        type: 'template' as const,
                        label: 'Use a Template',
                        desc: 'Pre-built KB starter templates',
                      },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.type}
                      onClick={() => setCreateType(opt.type)}
                      className="p-4 bg-slate-800 border border-slate-700 rounded-xl text-left hover:border-violet-500 hover:bg-slate-700/80 transition-all"
                    >
                      <div className="text-white font-medium text-sm mb-1">
                        {opt.label}
                      </div>
                      <div className="text-slate-400 text-xs">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : createType === 'write' ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5 tracking-wider">
                    TITLE
                  </label>
                  <input
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="Article title..."
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5 tracking-wider">
                    CONTENT
                  </label>
                  <textarea
                    value={newBody}
                    onChange={(e) => setNewBody(e.target.value)}
                    placeholder="Write your article content..."
                    rows={7}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1.5 tracking-wider">
                      AUDIENCE
                    </label>
                    <select className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500">
                      <option>Customer</option>
                      <option>Internal</option>
                      <option>Both</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1.5 tracking-wider">
                      CATEGORY
                    </label>
                    <select className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500">
                      <option>Billing &amp; Subscriptions</option>
                      <option>Security &amp; Access</option>
                      <option>AI Agents &amp; Config</option>
                      <option>Onboarding</option>
                      <option>Integrations &amp; APIs</option>
                    </select>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                  <button
                    onClick={() => setCreateType(null)}
                    className="text-sm text-slate-400 hover:text-white transition-colors"
                  >
                    Back
                  </button>
                  <div className="flex gap-2">
                    <button className="px-4 py-2 rounded-xl text-sm bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors">
                      Save Draft
                    </button>
                    <button
                      className="px-4 py-2 rounded-xl text-sm text-white font-medium hover:opacity-90 transition-opacity"
                      style={{ backgroundColor: accentColor }}
                    >
                      Publish
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-10">
                <p className="text-slate-400 text-sm mb-2">
                  {createType === 'upload'
                    ? 'Drag and drop your PDF, DOCX, or MD file here, or click to browse'
                    : createType === 'url'
                    ? 'Enter the URL of your help centre or documentation site to crawl'
                    : 'Choose from pre-built KB article templates for common topics'}
                </p>
                {createType === 'upload' && (
                  <div className="mt-4 border-2 border-dashed border-slate-700 rounded-xl p-8 text-slate-500">
                    Click to select file or drag here
                  </div>
                )}
                {createType === 'url' && (
                  <input
                    placeholder="https://docs.yourcompany.com..."
                    className="mt-4 w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
                  />
                )}
                <button
                  onClick={() => setCreateType(null)}
                  className="mt-4 text-sm text-slate-500 hover:text-white transition-colors"
                >
                  Back to options
                </button>
              </div>
            )}
          </Modal>
        )}
      </div>
    );
  }

  if (subPage === 'hub_ingestion') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">
              Ingestion Pipeline
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Connect data sources ÃÂ¢ÃÂÃÂ content is automatically chunked, embedded,
              and indexed into the KB
            </p>
          </div>
          <button
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
            style={{ backgroundColor: accentColor }}
          >
            + Add Source
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {ingestionSources.map((src, i) => (
            <div
              key={i}
              className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/20 flex items-center justify-center text-lg font-bold text-indigo-300">
                  {src.icon}
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">
                    {src.name}
                  </div>
                  <Badge
                    label={src.status === 'syncing' ? 'Syncing' : 'Active'}
                    color={src.status === 'syncing' ? 'yellow' : 'green'}
                  />
                </div>
              </div>
              <div className="space-y-2 text-xs text-slate-400">
                <div className="flex justify-between">
                  <span>Documents indexed</span>
                  <span className="text-white">
                    {src.docs.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Last sync</span>
                  <span className="text-white">{src.lastSync}</span>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <button className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all">
                  Sync Now
                </button>
                <button className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all">
                  Settings
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">
            Pipeline Activity Log
          </h2>
          <div className="space-y-2">
            {[
              'Zendesk: 42 new tickets ingested and embedded ÃÂ¢ÃÂÃÂ 2 min ago',
              'Confluence: 8 pages updated, KB refresh triggered ÃÂ¢ÃÂÃÂ 12 min ago',
              'Google Drive: Policy doc v3.2 detected, diff processed ÃÂ¢ÃÂÃÂ 1 hr ago',
              'PDF Upload: Q3 Training Manual fully indexed 124 chunks ÃÂ¢ÃÂÃÂ 3 hr ago',
              'GitHub: 3 README files changed, embeddings updated ÃÂ¢ÃÂÃÂ 1 day ago',
            ].map((log, i) => (
              <div key={i} className="flex items-start gap-3 text-xs">
                <span className="text-emerald-400 mt-0.5">v</span>
                <span className="text-slate-300">{log}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (subPage === 'hub_training') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Team Training</h1>
          <p className="text-slate-400 text-sm mt-1">
            AI-powered training modules built from your knowledge base ÃÂ¢ÃÂÃÂ track
            staff completion
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {trainingModules.map((mod, i) => (
            <div
              key={i}
              className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all"
            >
              <div className="mb-3">
                <div className="text-sm font-semibold text-white mb-1">
                  {mod.title}
                </div>
                <div className="flex items-center gap-2">
                  <Badge label={mod.category} color="indigo" />
                  <span className="text-xs text-slate-500">{mod.duration}</span>
                </div>
              </div>
              <div className="mb-2">
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span>Team completion</span>
                  <span className="text-white">{mod.completions}%</span>
                </div>
                <div className="h-2 bg-slate-800 rounded-full">
                  <div
                    className="h-full rounded-full bg-indigo-500"
                    style={{ width: mod.completions + '%' }}
                  />
                </div>
              </div>
              <button className="w-full mt-3 py-2 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-all">
                View Details
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (subPage === 'hub_analytics') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">KB Analytics</h1>
          <p className="text-slate-400 text-sm mt-1">
            Understand how your knowledge base is performing for customers and
            staff
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Total Queries"
            value="12,481"
            icon="ÃÂ¢ÃÂÃÂ"
            color="indigo"
            trend="+18%"
          />
          <StatCard
            label="Self-Served"
            value="89%"
            icon="ÃÂ¢ÃÂÃÂ"
            color="emerald"
            trend="No human needed"
          />
          <StatCard
            label="Escalation Rate"
            value="11%"
            icon="ÃÂ¢ÃÂÃÂ "
            color="amber"
            trend="-3% this month"
          />
          <StatCard
            label="Avg Confidence"
            value="87%"
            icon="ÃÂ¢ÃÂÃÂ¡"
            color="blue"
            trend="+5% this month"
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Top Queries with Content Gaps
            </h2>
            <div className="space-y-2">
              {[
                { q: 'How do I export data to CSV?', count: 147, gap: true },
                {
                  q: 'What is the SLA for P1 incidents?',
                  count: 89,
                  gap: false,
                },
                {
                  q: 'Can I have multiple payment methods?',
                  count: 76,
                  gap: true,
                },
                { q: 'How to set up SSO with Okta?', count: 68, gap: false },
                { q: 'Where can I find my API key?', count: 54, gap: false },
              ].map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50"
                >
                  <span className="text-xs text-slate-500 w-5">{i + 1}</span>
                  <div className="flex-1">
                    <div className="text-xs text-white">{item.q}</div>
                    <div className="text-xs text-slate-500">
                      {item.count} queries
                    </div>
                  </div>
                  {item.gap && <Badge label="Content gap" color="red" />}
                </div>
              ))}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Query Volume Last 7 Days
            </h2>
            <div className="space-y-2">
              {[1800, 2100, 1950, 2300, 2450, 2280, 2601].map((v, i) => {
                const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                const pct = (v / 2601) * 100;
                return (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-xs text-slate-500 w-8">
                      {days[i]}
                    </span>
                    <div className="flex-1 h-2 bg-slate-800 rounded-full">
                      <div
                        className="h-full bg-indigo-500 rounded-full"
                        style={{ width: pct + '%' }}
                      />
                    </div>
                    <span className="text-xs text-slate-300 w-12 text-right">
                      {v.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6">
      <p className="text-slate-400">Knowledge Hub</p>
    </div>
  );
};

// ============================================================
// CUSTOMER PORTAL PAGE
// ============================================================

const CustomerPortalPage = ({
  user,
  tenant,
  subPage,
}: {
  user?: AuthUser;
  tenant?: Tenant;
  subPage: TenantPage;
}) => {
  const dbConvIdRef = React.useRef<string | null>(null);
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [chatInput, setChatInput] = useState('');
  const [messages, setMessages] = useState<
    {
      role: 'user' | 'agent';
      text: string;
      time: string;
      confidence?: number;
      actions?: string[];
    }[]
  >([
    {
      role: 'agent',
      text: 'Hi! I am your AI assistant. I can answer questions, look up your account info, and perform actions on your behalf. How can I help you today?',
      time: '10:00 AM',
    },
    {
      role: 'user',
      text: 'What is my current plan and how much have I used this month?',
      time: '10:01 AM',
    },
    {
      role: 'agent',
      text: 'You are on the Growth plan. This month you have used 980,000 of your 2,000,000 token allowance (49%). Your billing period resets in 18 days. Would you like me to send a usage summary to your email?',
      time: '10:01 AM',
      confidence: 97,
      actions: ['Send Usage Summary', 'Upgrade Plan', 'View Billing History'],
    },
  ]);
  const [typing, setTyping] = useState(false);
  const [traceVisible, setTraceVisible] = useState(false);
  const [traceSteps, setTraceSteps] = useState<
    {
      stage: string;
      status: 'pending' | 'running' | 'done' | 'escalated';
      detail: string;
      confidence?: number;
      duration?: number;
    }[]
  >([]);
  const [agentUsed, setAgentUsed] = useState('Support Agent');

  const runAgentPipeline = (query: string) => {
    const isBilling =
      query.toLowerCase().includes('bill') ||
      query.toLowerCase().includes('invoice') ||
      query.toLowerCase().includes('charge') ||
      query.toLowerCase().includes('payment') ||
      query.toLowerCase().includes('refund');
    const isSecurity =
      query.toLowerCase().includes('password') ||
      query.toLowerCase().includes('2fa') ||
      query.toLowerCase().includes('login') ||
      query.toLowerCase().includes('access') ||
      query.toLowerCase().includes('reset');
    const chosenAgent = isBilling
      ? 'Billing Agent'
      : isSecurity
      ? 'Account Agent'
      : 'Support Agent';
    setAgentUsed(chosenAgent);
    setTraceVisible(true);
    const stages = [
      {
        stage: 'Intent Classification',
        status: 'running' as const,
        detail: 'Classifying query intent and routing to best agent...',
        confidence: undefined,
        duration: undefined,
      },
      {
        stage: 'KB Retrieval',
        status: 'pending' as const,
        detail: '',
        confidence: undefined,
        duration: undefined,
      },
      {
        stage: 'Knowledge Validation',
        status: 'pending' as const,
        detail: '',
        confidence: undefined,
        duration: undefined,
      },
      {
        stage: 'LLM Reasoning',
        status: 'pending' as const,
        detail: '',
        confidence: undefined,
        duration: undefined,
      },
      {
        stage: 'Confidence Gate',
        status: 'pending' as const,
        detail: '',
        confidence: undefined,
        duration: undefined,
      },
      {
        stage: 'Response Generation',
        status: 'pending' as const,
        detail: '',
        confidence: undefined,
        duration: undefined,
      },
    ];
    setTraceSteps(stages);

    const kbChunks = isBilling
      ? [
          {
            title: 'How to Request a Refund',
            breadcrumb:
              'DreamTeam Platform ÃÂ¢ÃÂÃÂº Billing ÃÂ¢ÃÂÃÂº Invoices ÃÂ¢ÃÂÃÂº Refund Policy',
            connector: null,
            score: 0.94,
            fresh: 98,
          },
          {
            title: 'Understanding Your Invoice',
            breadcrumb:
              'DreamTeam Platform ÃÂ¢ÃÂÃÂº Billing ÃÂ¢ÃÂÃÂº Invoices ÃÂ¢ÃÂÃÂº Invoice Downloads',
            connector: null,
            score: 0.88,
            fresh: 95,
          },
          {
            title: 'Invoice #inv_2026_0621',
            breadcrumb:
              'Stripe Billing ÃÂ¢ÃÂÃÂº Invoice ÃÂ¢ÃÂÃÂº amount, status, periodStart, lineItems',
            connector: 'Stripe Billing',
            score: 0.91,
            fresh: 100,
          },
        ]
      : isSecurity
      ? [
          {
            title: 'Setting Up Two-Factor Authentication',
            breadcrumb:
              'Customer Portal ÃÂ¢ÃÂÃÂº Self-Service ÃÂ¢ÃÂÃÂº Password & Security ÃÂ¢ÃÂÃÂº 2FA',
            connector: null,
            score: 0.96,
            fresh: 99,
          },
          {
            title: 'RBAC Roles and Permissions Reference',
            breadcrumb:
              'DreamTeam Platform ÃÂ¢ÃÂÃÂº Getting Started ÃÂ¢ÃÂÃÂº Onboarding ÃÂ¢ÃÂÃÂº Workspace Config',
            connector: null,
            score: 0.81,
            fresh: 96,
          },
          {
            title: 'Contact #c_00128',
            breadcrumb: 'Salesforce CRM ÃÂ¢ÃÂÃÂº Contact ÃÂ¢ÃÂÃÂº id, email, lastActivity',
            connector: 'Salesforce CRM',
            score: 0.77,
            fresh: 100,
          },
        ]
      : [
          {
            title: 'Agent Pipeline Design Best Practices',
            breadcrumb:
              'DreamTeam Platform ÃÂ¢ÃÂÃÂº Agent Management ÃÂ¢ÃÂÃÂº Configuration ÃÂ¢ÃÂÃÂº Pipeline Design',
            connector: null,
            score: 0.89,
            fresh: 100,
          },
          {
            title: 'Release Notes v4.2',
            breadcrumb:
              'DreamTeam Platform ÃÂ¢ÃÂÃÂº Agent Management ÃÂ¢ÃÂÃÂº Configuration ÃÂ¢ÃÂÃÂº LLM Model Selection',
            connector: null,
            score: 0.83,
            fresh: 100,
          },
          {
            title: 'API_Reference_v4.2.md',
            breadcrumb: 'Imported File ÃÂ¢ÃÂÃÂº Integrations & APIs ÃÂ¢ÃÂÃÂº API Reference',
            connector: 'Google Drive / Files',
            score: 0.74,
            fresh: 95,
          },
        ];

    setTimeout(() => {
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 0
            ? {
                ...s,
                status: 'done',
                detail: 'Routed to ' + chosenAgent + ' ÃÂ¢ÃÂÃÂ confidence 97%',
                confidence: 97,
                duration: 120,
              }
            : i === 1
            ? { ...s, status: 'running', detail: 'Searching knowledge base...' }
            : s
        )
      );
    }, 600);
    setTimeout(() => {
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 1
            ? {
                ...s,
                status: 'done',
                detail:
                  'Retrieved ' +
                  kbChunks.length +
                  ' sources ÃÂ¢ÃÂÃÂ ' +
                  kbChunks
                    .map(
                      (c) =>
                        (c.connector ? '[' + c.connector + '] ' : '[KB] ') +
                        c.title +
                        ' (' +
                        (c.score * 100).toFixed(0) +
                        '%)'
                    )
                    .join(' | '),
                confidence: 89,
                duration: 340,
              }
            : i === 2
            ? {
                ...s,
                status: 'running',
                detail:
                  'Knowledge Curator bot validating chunk freshness and relevance...',
              }
            : s
        )
      );
    }, 1200);
    setTimeout(() => {
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 2
            ? {
                ...s,
                status: 'done',
                detail:
                  'All chunks passed freshness check. Avg relevance score: 0.87',
                confidence: 92,
                duration: 180,
              }
            : i === 3
            ? {
                ...s,
                status: 'running',
                detail:
                  'Reasoning over retrieved context with ' +
                  (isBilling
                    ? 'GPT-4o'
                    : isSecurity
                    ? 'Claude Haiku 3.5'
                    : 'Claude Sonnet 4.5') +
                  '...',
              }
            : s
        )
      );
    }, 1900);
    setTimeout(() => {
      const finalConfidence = isBilling ? 94 : isSecurity ? 88 : 91;
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 3
            ? {
                ...s,
                status: 'done',
                detail: 'Chain-of-thought complete. Draft response generated.',
                confidence: finalConfidence,
                duration: 820,
              }
            : i === 4
            ? {
                ...s,
                status: 'running',
                detail:
                  'Running Confidence Reviewer, Safety Guard, Hallucination Detector...',
              }
            : s
        )
      );
    }, 2800);
    setTimeout(() => {
      const fc = isBilling ? 94 : isSecurity ? 88 : 91;
      const passed = fc >= 80;
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 4
            ? {
                ...s,
                status: passed ? 'done' : 'escalated',
                detail: passed
                  ? 'All validators passed. Confidence ' +
                    fc +
                    '% above threshold of ' +
                    (isBilling ? '92' : isSecurity ? '90' : '80') +
                    '%. Auto-responding.'
                  : 'Confidence ' +
                    fc +
                    '% below threshold. Escalating to human.',
                confidence: fc,
                duration: 95,
              }
            : i === 5
            ? {
                ...s,
                status: 'running',
                detail: 'Formatting final response...',
              }
            : s
        )
      );
    }, 3500);
    setTimeout(() => {
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 5
            ? {
                ...s,
                status: 'done',
                detail: 'Response delivered. Audit log written.',
                confidence: undefined,
                duration: 55,
              }
            : s
        )
      );
      setTyping(false);
      const responses: Record<string, string> = {
        'Billing Agent':
          'I reviewed your billing account. Based on your current subscription, the charge is correct per your Growth plan at $299/month. Your last invoice was issued on June 1st. Would you like me to email you a copy, or is there a specific charge you would like me to investigate?',
        'Account Agent':
          'I can help you with account access. For security, I need to verify your identity before making any changes. I will send a verification code to your registered email. Once confirmed, I can reset your credentials or update your 2FA settings. Shall I proceed?',
        'Support Agent':
          'I found relevant information in the knowledge base. The feature you are asking about is available on your current plan. Would you like me to walk you through the setup, or would you prefer I send a step-by-step guide to your email?',
      };
      const chosenResp = responses[chosenAgent] || responses['Support Agent'];
      const actions = isBilling
        ? [
            'Email Invoice Copy',
            'View Billing History',
            'Speak to Billing Team',
          ]
        : isSecurity
        ? ['Send Verification Code', 'Reset via Email', 'Contact Security Team']
        : ['Show Setup Guide', 'Email Step-by-Step Guide', 'Book a Demo'];
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent' as const,
          text: chosenResp,
          time: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
          confidence: isBilling ? 94 : isSecurity ? 88 : 91,
          actions,
        },
      ]);
    }, 4200);
  };

  const sendMessage = () => {
    if (!chatInput.trim()) return;
    const msgText = chatInput.trim();
    const userMsg = {
      role: 'user' as const,
      text: msgText,
      time: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
    setMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setTyping(true);
    runAgentPipeline(msgText);
    if (tenant?.id) {
      (async () => {
        try {
          let convId = dbConvIdRef.current;
          if (!convId) {
            const conv = await createConversation({
              tenant_id: tenant.id,
              channel: 'chat',
              subject: msgText.substring(0, 80),
              customer_name: user?.name,
              customer_email: user?.email,
            });
            if (conv) { convId = conv.id; dbConvIdRef.current = conv.id; }
          }
          if (convId) {
            await createMessage({
              conversation_id: convId,
              tenant_id: tenant.id,
              role: 'user',
              content: msgText,
              requires_approval: false,
            });
          }
        } catch(e) { console.error('[DT] persist msg:', e); }
      })();
    }
  };

  const pendingApprovals = [
    {
      id: 'ap1',
      customer: 'Emily Carter',
      email: 'emily@acmeuser.com',
      action: 'Issue $350 credit to account',
      agent: 'Billing Agent',
      requestedAt: '15 min ago',
      confidence: 94,
      risk: 'medium',
    },
    {
      id: 'ap2',
      customer: 'James Liu',
      email: 'james@globexuser.com',
      action: 'Reset 2FA and send recovery codes',
      agent: 'Security Agent',
      requestedAt: '1 hr ago',
      confidence: 88,
      risk: 'high',
    },
    {
      id: 'ap3',
      customer: 'Maria Santos',
      email: 'maria@initechuser.com',
      action: 'Downgrade plan from Enterprise to Growth',
      agent: 'Account Agent',
      requestedAt: '2 hr ago',
      confidence: 97,
      risk: 'low',
    },
    {
      id: 'ap4',
      customer: 'Tom Baker',
      email: 'tom@hooliuser.com',
      action: 'Export all account data as CSV',
      agent: 'Data Agent',
      requestedAt: '3 hr ago',
      confidence: 99,
      risk: 'low',
    },
  ];

  const riskColors: Record<string, string> = {
    low: 'green',
    medium: 'amber',
    high: 'red',
  };

  const conversations = [
    {
      id: 'c1',
      customer: 'Emily Carter',
      preview: 'I need to update my payment method...',
      agent: 'Billing Agent',
      status: 'resolved',
      time: '10 min ago',
      messages: 6,
    },
    {
      id: 'c2',
      customer: 'James Liu',
      preview: 'My password reset link is not working',
      agent: 'Support Agent',
      status: 'escalated',
      time: '45 min ago',
      messages: 12,
    },
    {
      id: 'c3',
      customer: 'Sarah Kim',
      preview: 'Can you explain the API rate limits?',
      agent: 'Technical Agent',
      status: 'resolved',
      time: '1 hr ago',
      messages: 4,
    },
    {
      id: 'c4',
      customer: 'David Brown',
      preview: 'I want to add 3 more seats to my plan',
      agent: 'Account Agent',
      status: 'pending',
      time: '2 hr ago',
      messages: 8,
    },
    {
      id: 'c5',
      customer: 'Lisa Chen',
      preview: 'Onboarding help where do I start?',
      agent: 'Onboarding Agent',
      status: 'resolved',
      time: '3 hr ago',
      messages: 15,
    },
  ];

  const statusColors: Record<string, string> = {
    resolved: 'green',
    escalated: 'red',
    pending: 'amber',
  };

  const agentActions = [
    {
      name: 'Reset Password',
      description: 'Trigger password reset email for customer',
      risk: 'low',
      approval: false,
      usedToday: 142,
    },
    {
      name: 'Issue Credit',
      description:
        'Apply account credit up to $200 auto, above $200 requires approval',
      risk: 'medium',
      approval: true,
      usedToday: 23,
    },
    {
      name: 'Upgrade Plan',
      description: 'Move customer to higher plan tier immediately',
      risk: 'low',
      approval: false,
      usedToday: 8,
    },
    {
      name: 'Downgrade Plan',
      description: 'Reduce plan tier with confirmation workflow',
      risk: 'medium',
      approval: true,
      usedToday: 4,
    },
    {
      name: 'Export Account Data',
      description: 'Generate full data export GDPR compliant',
      risk: 'low',
      approval: false,
      usedToday: 31,
    },
    {
      name: 'Suspend Account',
      description: 'Temporarily suspend customer access',
      risk: 'high',
      approval: true,
      usedToday: 2,
    },
    {
      name: 'Reset 2FA',
      description: 'Disable and reset two-factor authentication',
      risk: 'high',
      approval: true,
      usedToday: 7,
    },
    {
      name: 'Change Billing Email',
      description: 'Update billing contact email address',
      risk: 'low',
      approval: false,
      usedToday: 19,
    },
  ];

  const tickets = [
    {
      id: 'T-9921',
      customer: 'James Liu',
      subject: 'Login issue 2FA not working',
      priority: 'urgent',
      status: 'open',
      assignee: 'Human Agent',
      created: '1 hr ago',
    },
    {
      id: 'T-9920',
      customer: 'Alex Patel',
      subject: 'Billing discrepancy on October invoice',
      priority: 'high',
      status: 'in_progress',
      assignee: 'Billing Agent',
      created: '3 hr ago',
    },
    {
      id: 'T-9919',
      customer: 'Sarah Kim',
      subject: 'API key rotation request',
      priority: 'medium',
      status: 'resolved',
      assignee: 'Tech Agent',
      created: '1 day ago',
    },
    {
      id: 'T-9918',
      customer: 'Oliver Chen',
      subject: 'Cannot download invoices as PDF',
      priority: 'low',
      status: 'resolved',
      assignee: 'Support Agent',
      created: '2 days ago',
    },
    {
      id: 'T-9917',
      customer: 'Emma Wilson',
      subject: 'SSO setup assistance needed',
      priority: 'medium',
      status: 'open',
      assignee: 'Tech Agent',
      created: '2 days ago',
    },
  ];

  const priorityColors: Record<string, string> = {
    urgent: 'red',
    high: 'amber',
    medium: 'blue',
    low: 'slate',
  };

  if (subPage === 'portal_overview') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Customer Portal</h1>
          <p className="text-slate-400 text-sm mt-1">
            AI agents serve your customers 24/7 ÃÂ¢ÃÂÃÂ answering questions, resolving
            issues, and taking action on their behalf
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Conversations Today"
            value="1,284"
            icon="ÃÂ¢ÃÂÃÂ"
            color="blue"
            trend="+18%"
          />
          <StatCard
            label="Self-Served"
            value="89%"
            icon="ÃÂ¢ÃÂÃÂ"
            color="emerald"
            trend="No human needed"
          />
          <StatCard
            label="Pending Approvals"
            value="12"
            icon="ÃÂ¢ÃÂÃÂ "
            color="amber"
            trend="3 urgent"
          />
          <StatCard
            label="Avg Response Time"
            icon="ÃÂ¢ÃÂÃÂ"
            value="< 2s"
            color="indigo"
            trend="AI-instant"
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Customer Satisfaction Trend
            </h2>
            <div className="flex items-end gap-2 h-24">
              {[82, 85, 87, 86, 90, 92, 94].map((v, i) => {
                const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
                return (
                  <div
                    key={i}
                    className="flex-1 flex flex-col items-center gap-1"
                  >
                    <div
                      className="w-full rounded-t"
                      style={{
                        height: ((v - 80) / 15) * 100 + '%',
                        backgroundColor: accentColor,
                        minHeight: '4px',
                      }}
                    />
                    <span className="text-xs text-slate-600">{days[i]}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex justify-between text-xs text-slate-400">
              <span>
                Average this week:{' '}
                <span className="text-emerald-400">91.7%</span>
              </span>
              <span>Target: 90%</span>
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Resolution Breakdown
            </h2>
            <div className="space-y-3">
              {[
                { label: 'Fully resolved by AI', pct: 71, color: '#10b981' },
                { label: 'AI plus action taken', pct: 18, color: accentColor },
                { label: 'Escalated to human', pct: 8, color: '#f59e0b' },
                { label: 'Created ticket', pct: 3, color: '#ef4444' },
              ].map((item, i) => (
                <div key={i}>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>{item.label}</span>
                    <span className="text-white">{item.pct}%</span>
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: item.pct + '%',
                        backgroundColor: item.color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (subPage === 'portal_conversations') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Conversations</h1>
            <p className="text-slate-400 text-sm mt-1">
              AI-handled customer conversations ÃÂ¢ÃÂÃÂ live and historical
            </p>
          </div>
          <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
            {['All', 'Open', 'Resolved', 'Escalated'].map((f) => (
              <button
                key={f}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white rounded-md"
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-6">
          {conversations.map((conv, i) => (
            <div
              key={i}
              className={`flex items-center gap-4 px-5 py-4 hover:bg-slate-800/40 cursor-pointer transition-all ${
                i < conversations.length - 1 ? 'border-b border-slate-800' : ''
              }`}
            >
              <div className="w-9 h-9 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300 flex-shrink-0">
                {conv.customer
                  .split(' ')
                  .map((n) => n[0])
                  .join('')}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-white">
                    {conv.customer}
                  </span>
                  <Badge
                    label={conv.status}
                    color={statusColors[conv.status]}
                  />
                </div>
                <div className="text-xs text-slate-400 truncate">
                  {conv.preview}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-xs text-slate-500">{conv.agent}</div>
                <div className="text-xs text-slate-600 mt-0.5">
                  {conv.messages} msgs ÃÂÃÂ· {conv.time}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">
              Live AI Agent Chat
              <span className="ml-2 text-xs px-2 py-0.5 bg-emerald-900 text-emerald-400 rounded-full">
                {agentUsed}
              </span>
            </h2>
            <button
              onClick={() => setTraceVisible((v) => !v)}
              className="text-xs px-2 py-1 rounded bg-slate-800 text-slate-400 hover:text-white transition-colors"
            >
              {traceVisible ? 'Hide' : 'Show'} Reasoning Trace
            </button>
          </div>

          {/* Agent Reasoning Trace Panel */}
          {traceVisible && traceSteps.length > 0 && (
            <div className="mb-4 bg-slate-950 border border-slate-700 rounded-xl p-3">
              <div className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wide">
                Agent Pipeline ÃÂ¢ÃÂÃÂ {agentUsed}
              </div>
              <div className="space-y-1.5">
                {traceSteps.map((step, idx) => {
                  const statusColors: Record<string, string> = {
                    pending: 'text-slate-600',
                    running: 'text-yellow-400 animate-pulse',
                    done: 'text-emerald-400',
                    escalated: 'text-orange-400',
                  };
                  const statusIcons: Record<string, string> = {
                    pending: 'O',
                    running: '~',
                    done: 'V',
                    escalated: '!',
                  };
                  return (
                    <div key={idx} className="flex items-start gap-2">
                      <span
                        className={`text-xs font-mono w-4 flex-shrink-0 font-bold mt-0.5 ${
                          statusColors[step.status]
                        }`}
                      >
                        {statusIcons[step.status]}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-slate-300">
                            {step.stage}
                          </span>
                          {step.confidence !== undefined && (
                            <span className="text-xs text-slate-500">
                              conf:{' '}
                              <span
                                className={
                                  step.confidence >= 80
                                    ? 'text-emerald-400'
                                    : 'text-orange-400'
                                }
                              >
                                {step.confidence}%
                              </span>
                            </span>
                          )}
                          {step.duration !== undefined && (
                            <span className="text-xs text-slate-600">
                              {step.duration}ms
                            </span>
                          )}
                        </div>
                        {step.detail && (
                          <div className="text-xs text-slate-500 mt-0.5 truncate">
                            {step.detail}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Chat messages */}
          <div className="space-y-3 mb-4 max-h-56 overflow-y-auto flex-1">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${
                  msg.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`max-w-xs rounded-2xl px-4 py-2.5 ${
                    msg.role === 'user'
                      ? 'text-white rounded-br-sm'
                      : 'bg-slate-800 text-slate-200 rounded-bl-sm'
                  }`}
                  style={
                    msg.role === 'user' ? { backgroundColor: accentColor } : {}
                  }
                >
                  <p className="text-xs">{msg.text}</p>
                  {msg.confidence && (
                    <p className="text-xs opacity-60 mt-1">
                      Confidence: {msg.confidence}%
                    </p>
                  )}
                  {msg.actions && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {msg.actions.map((a, j) => (
                        <button
                          key={j}
                          className="text-xs px-2 py-1 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-all"
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {typing && (
              <div className="flex justify-start">
                <div className="bg-slate-800 rounded-2xl rounded-bl-sm px-4 py-2.5">
                  <div className="flex gap-1 items-center">
                    <div className="flex gap-1">
                      <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" />
                      <span
                        className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce"
                        style={{ animationDelay: '0.1s' }}
                      />
                      <span
                        className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce"
                        style={{ animationDelay: '0.2s' }}
                      />
                    </div>
                    <span className="text-xs text-slate-500 ml-1">
                      {agentUsed} thinking...
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Suggested prompts */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {[
              'Why was I charged?',
              'Reset my password',
              'How do I set up SSO?',
            ].map((p) => (
              <button
                key={p}
                onClick={() => {
                  setChatInput(p);
                }}
                className="text-xs px-2 py-1 bg-slate-800 text-slate-400 hover:text-indigo-300 hover:bg-slate-700 rounded-lg border border-slate-700 transition-colors"
              >
                {p}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              placeholder="Ask anything ÃÂ¢ÃÂÃÂ billing, access, product..."
              className="flex-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={sendMessage}
              className="px-4 py-2.5 text-white text-sm rounded-xl font-medium"
              style={{ backgroundColor: accentColor }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (subPage === 'portal_actions') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Agent Actions</h1>
          <p className="text-slate-400 text-sm mt-1">
            Configure what actions agents can perform on behalf of customers ÃÂ¢ÃÂÃÂ
            with confidence gates and approval flows
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agentActions.map((action, i) => (
            <div
              key={i}
              className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="text-sm font-semibold text-white">
                  {action.name}
                </div>
                <div className="flex gap-2">
                  <Badge
                    label={action.risk + ' risk'}
                    color={riskColors[action.risk]}
                  />
                  {action.approval && (
                    <Badge label="Requires Approval" color="amber" />
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-400 mb-3">
                {action.description}
              </p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">
                  Used today:{' '}
                  <span className="text-white">{action.usedToday}</span>
                </span>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only" defaultChecked />
                  <div className="w-9 h-5 bg-indigo-500 rounded-full">
                    <div className="w-4 h-4 bg-white rounded-full shadow mt-0.5 ml-4" />
                  </div>
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (subPage === 'portal_approvals') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Approvals Queue</h1>
            <p className="text-slate-400 text-sm mt-1">
              Human-in-the-loop ÃÂ¢ÃÂÃÂ review agent actions that exceed confidence or
              risk thresholds
            </p>
          </div>
          <Badge label={pendingApprovals.length + ' pending'} color="amber" />
        </div>
        <div className="space-y-4">
          {pendingApprovals.map((item) => (
            <div
              key={item.id}
              className="bg-slate-900 border border-slate-800 rounded-xl p-5"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-white">
                      {item.action}
                    </span>
                    <Badge
                      label={item.risk + ' risk'}
                      color={riskColors[item.risk]}
                    />
                  </div>
                  <div className="text-xs text-slate-400">
                    Customer:{' '}
                    <span className="text-white">{item.customer}</span> ÃÂÃÂ·{' '}
                    {item.email}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    Requested by:{' '}
                    <span className="text-white">{item.agent}</span> ÃÂÃÂ·{' '}
                    {item.requestedAt}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-emerald-400">
                    {item.confidence}%
                  </div>
                  <div className="text-xs text-slate-500">confidence</div>
                </div>
              </div>
              <div className="h-1 bg-slate-800 rounded-full mb-3">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: item.confidence + '%' }}
                />
              </div>
              <div className="flex gap-3">
                <button className="flex-1 py-2 text-sm font-medium text-white rounded-xl bg-emerald-600 hover:bg-emerald-500 transition-all">
                  v Approve
                </button>
                <button className="flex-1 py-2 text-sm font-medium text-white rounded-xl bg-red-600/50 hover:bg-red-600/70 transition-all">
                  x Reject
                </button>
                <button className="px-4 py-2 text-sm text-slate-400 hover:text-white bg-slate-800 rounded-xl transition-all">
                  View Context
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (subPage === 'portal_tickets') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Support Tickets</h1>
            <p className="text-slate-400 text-sm mt-1">
              Escalated issues requiring human review ÃÂ¢ÃÂÃÂ AI continues to assist
              in context
            </p>
          </div>
          <button
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
            style={{ backgroundColor: accentColor }}
          >
            + New Ticket
          </button>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                {[
                  'Ticket ID',
                  'Customer',
                  'Subject',
                  'Priority',
                  'Status',
                  'Assignee',
                  'Created',
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
              {tickets.map((t) => (
                <tr
                  key={t.id}
                  className="hover:bg-slate-800/30 cursor-pointer transition-all"
                >
                  <td className="px-4 py-3 text-xs font-mono text-indigo-400">
                    {t.id}
                  </td>
                  <td className="px-4 py-3 text-sm text-white">{t.customer}</td>
                  <td className="px-4 py-3 text-sm text-slate-300">
                    {t.subject}
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      label={t.priority}
                      color={priorityColors[t.priority]}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      label={t.status.replace('_', ' ')}
                      color={
                        t.status === 'resolved'
                          ? 'green'
                          : t.status === 'open'
                          ? 'red'
                          : 'amber'
                      }
                    />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {t.assignee}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {t.created}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (subPage === 'portal_settings') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Portal Settings</h1>
          <p className="text-slate-400 text-sm mt-1">
            Configure the customer-facing AI portal experience
          </p>
        </div>
        <div className="max-w-2xl space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Portal Identity
            </h2>
            <div className="space-y-4">
              {[
                {
                  label: 'Portal Name',
                  value: (tenant?.name || 'Company') + ' Support',
                },
                {
                  label: 'Welcome Message',
                  value: 'Hi! How can I help you today?',
                },
                { label: 'Fallback Email', value: 'support@company.com' },
              ].map((f, i) => (
                <div key={i}>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">
                    {f.label}
                  </label>
                  <input
                    defaultValue={f.value}
                    className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Agent Behaviour
            </h2>
            <div className="space-y-3">
              {[
                {
                  label: 'Allow agents to take actions without approval',
                  desc: 'Low-risk actions are executed immediately',
                  checked: true,
                },
                {
                  label: 'Show confidence score to customers',
                  desc: 'Displays AI confidence below each response',
                  checked: false,
                },
                {
                  label: 'Enable conversation ratings',
                  desc: 'Prompt customers to rate at end of conversation',
                  checked: true,
                },
                {
                  label: 'Auto-create ticket on escalation',
                  desc: 'When agent cannot resolve, a ticket is auto-created',
                  checked: true,
                },
              ].map((setting, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-3 rounded-xl bg-slate-800/50"
                >
                  <div>
                    <div className="text-sm text-white">{setting.label}</div>
                    <div className="text-xs text-slate-500">{setting.desc}</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-4">
                    <input
                      type="checkbox"
                      className="sr-only"
                      defaultChecked={setting.checked}
                    />
                    <div
                      className={`w-9 h-5 rounded-full ${
                        setting.checked ? 'bg-indigo-500' : 'bg-slate-700'
                      }`}
                      style={
                        setting.checked ? { backgroundColor: accentColor } : {}
                      }
                    >
                      <div
                        className={`w-4 h-4 bg-white rounded-full shadow mt-0.5 transition-all ${
                          setting.checked ? 'ml-4' : 'ml-0.5'
                        }`}
                      />
                    </div>
                  </label>
                </div>
              ))}
            </div>
          </div>
          <button
            className="px-6 py-2.5 text-white text-sm font-medium rounded-xl"
            style={{ backgroundColor: accentColor }}
          >
            Save Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6">
      <p className="text-slate-400">Customer Portal</p>
    </div>
  );
};

// ============================================================
// INSIGHT ENGINE PAGE
// ============================================================

const InsightEnginePage = ({
  user,
  tenant,
}: {
  user?: AuthUser;
  tenant?: Tenant;
}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('gpt-4o');
  const [activeTab, setActiveTab] = useState<'query' | 'history' | 'usage'>(
    'query'
  );

  const models = [
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      provider: 'OpenAI',
      tokens: '128k',
      best: 'Reasoning and analysis',
    },
    {
      id: 'claude-3-5',
      name: 'Claude 3.5 Sonnet',
      provider: 'Anthropic',
      tokens: '200k',
      best: 'Long documents',
    },
    {
      id: 'gemini-1.5',
      name: 'Gemini 1.5 Pro',
      provider: 'Google',
      tokens: '1M',
      best: 'Multimodal tasks',
    },
    {
      id: 'llama-3',
      name: 'Llama 3 70B',
      provider: 'Self-hosted',
      tokens: '8k',
      best: 'Privacy-sensitive data',
    },
  ];

  const history = [
    {
      q: 'What were the top 5 customer complaints last quarter?',
      model: 'GPT-4o',
      tokens: 1842,
      time: '10 min ago',
    },
    {
      q: 'Summarise all HR policy changes in 2024',
      model: 'Claude 3.5 Sonnet',
      tokens: 5201,
      time: '2 hr ago',
    },
    {
      q: 'How does our refund rate compare to industry benchmarks?',
      model: 'GPT-4o',
      tokens: 2108,
      time: '1 day ago',
    },
    {
      q: 'Generate a weekly performance summary for the support team',
      model: 'GPT-4o',
      tokens: 3450,
      time: '2 days ago',
    },
    {
      q: 'What product features are customers asking for most?',
      model: 'Gemini 1.5 Pro',
      tokens: 1920,
      time: '3 days ago',
    },
  ];

  const runQuery = () => {
    if (!query.trim()) return;
    setLoading(true);
    setResult(null);
    setTimeout(() => {
      setLoading(false);
      setResult(
        'Based on your knowledge base and connected data sources, here is a summary of findings. Your query has been analysed across 2,847 KB articles, 8,421 resolved tickets, and 4 connected data sources. Key finding: 67% of queries match existing KB articles with high confidence. Top content gaps identified: CSV export documentation, SSO setup guides. Customer satisfaction correlates strongly with first-response time. Recommendation: Adding 3 new articles in the identified gap areas could reduce escalation rate by an estimated 8 to 12%.'
      );
    }, 2000);
  };

  const usageData = [
    1200000, 1800000, 1400000, 2100000, 1950000, 2400000, 2200000,
  ];
  const usageLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Insight Engine</h1>
          <p className="text-slate-400 text-sm mt-1">
            Query your knowledge base, connected data, and AI models in natural
            language
          </p>
        </div>
      </div>

      <div className="flex gap-1 bg-slate-800 rounded-xl p-1 mb-6 w-fit">
        {(['query', 'history', 'usage'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all capitalize ${
              activeTab === t ? 'text-white' : 'text-slate-400 hover:text-white'
            }`}
            style={activeTab === t ? { backgroundColor: accentColor } : {}}
          >
            {t}
          </button>
        ))}
      </div>

      {activeTab === 'query' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {models.map((m) => (
              <div
                key={m.id}
                onClick={() => setSelectedModel(m.id)}
                className={`p-3 rounded-xl border cursor-pointer transition-all bg-slate-900 ${
                  selectedModel === m.id
                    ? 'border-indigo-500'
                    : 'border-slate-800 hover:border-slate-700'
                }`}
                style={
                  selectedModel === m.id ? { borderColor: accentColor } : {}
                }
              >
                <div className="text-sm font-medium text-white">{m.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {m.provider}
                </div>
                <div className="text-xs text-slate-600 mt-1">
                  {m.tokens} ÃÂÃÂ· {m.best}
                </div>
              </div>
            ))}
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <label className="text-xs font-medium text-slate-400 block mb-2">
              Ask a question about your data, customers, or knowledge base
            </label>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. What were the most common customer complaints last month? or Which KB articles need updating?"
              rows={4}
              className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
            />
            <div className="flex items-center justify-between mt-3">
              <span className="text-xs text-slate-500">
                Searches: KB Articles, Tickets, Conversations, Connected data
                sources
              </span>
              <button
                onClick={runQuery}
                disabled={loading}
                className="flex items-center gap-2 px-5 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-60 transition-all"
                style={{ backgroundColor: accentColor }}
              >
                {loading ? (
                  <>
                    <Spinner /> Thinking...
                  </>
                ) : (
                  '> Run Query'
                )}
              </button>
            </div>
          </div>

          {result && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-emerald-400 text-sm">*</span>
                <span className="text-sm font-medium text-white">
                  Insight Result
                </span>
                <Badge label={selectedModel} color="indigo" />
                <Badge label="987 tokens used" color="blue" />
              </div>
              <div className="text-sm text-slate-300 leading-relaxed">
                {result}
              </div>
              <div className="flex gap-3 mt-4">
                <button className="px-4 py-2 text-xs text-slate-400 hover:text-white bg-slate-800 rounded-lg">
                  Export as PDF
                </button>
                <button className="px-4 py-2 text-xs text-slate-400 hover:text-white bg-slate-800 rounded-lg">
                  Save to KB
                </button>
                <button className="px-4 py-2 text-xs text-slate-400 hover:text-white bg-slate-800 rounded-lg">
                  Share
                </button>
              </div>
            </div>
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-3">
              Suggested Queries
            </h2>
            <div className="flex flex-wrap gap-2">
              {[
                'What are the top 5 customer complaints this month?',
                'Summarise HR policy changes in 2024',
                'Which KB articles have the lowest helpfulness rating?',
                'What product features are customers requesting most?',
                'Identify content gaps in the knowledge base',
                'How is agent performance trending this week?',
              ].map((sq, i) => (
                <button
                  key={i}
                  onClick={() => setQuery(sq)}
                  className="text-xs px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl border border-slate-700 hover:border-slate-600 transition-all"
                >
                  {sq}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'history' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          {history.map((h, i) => (
            <div
              key={i}
              className={`flex items-start gap-4 px-5 py-4 hover:bg-slate-800/40 cursor-pointer transition-all ${
                i < history.length - 1 ? 'border-b border-slate-800' : ''
              }`}
              onClick={() => {
                setQuery(h.q);
                setActiveTab('query');
              }}
            >
              <span className="text-slate-500 mt-0.5 text-sm">*</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white mb-1 truncate">{h.q}</div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <Badge label={h.model} color="indigo" />
                  <span>{h.tokens.toLocaleString()} tokens</span>
                  <span>{h.time}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'usage' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Tokens This Month"
              value="2.4M"
              icon="ÃÂ¢ÃÂÃÂ¡"
              color="blue"
              trend="48% of limit"
            />
            <StatCard
              label="Queries Run"
              value="847"
              icon="ÃÂ¢ÃÂÃÂ"
              color="indigo"
              trend="+12% this week"
            />
            <StatCard
              label="Avg Tokens Per Query"
              value="2,840"
              icon="ÃÂ¢ÃÂÃÂ¡"
              color="emerald"
              trend=""
            />
            <StatCard
              label="Cost Est MTD"
              value="$24.80"
              icon="ÃÂ¢ÃÂÃÂ"
              color="amber"
              trend="On track"
            />
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Daily Token Usage Last 7 Days
            </h2>
            <div className="flex items-end gap-2 h-32">
              {usageData.map((v, i) => {
                const maxV = Math.max(...usageData);
                const pct = (v / maxV) * 100;
                return (
                  <div
                    key={i}
                    className="flex-1 flex flex-col items-center gap-1"
                  >
                    <span className="text-xs text-slate-500">
                      {(v / 1000000).toFixed(1)}M
                    </span>
                    <div
                      className="w-full rounded-t"
                      style={{
                        height: pct + '%',
                        backgroundColor: accentColor,
                        opacity: 0.7,
                      }}
                    />
                    <span className="text-xs text-slate-600">
                      {usageLabels[i]}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Usage by Model
            </h2>
            <div className="space-y-3">
              {[
                { name: 'GPT-4o', pct: 58, tokens: '1.39M' },
                { name: 'Claude 3.5 Sonnet', pct: 27, tokens: '648K' },
                { name: 'Gemini 1.5 Pro', pct: 11, tokens: '264K' },
                { name: 'Llama 3 70B', pct: 4, tokens: '96K' },
              ].map((m, i) => (
                <div key={i}>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>{m.name}</span>
                    <span className="text-white">
                      {m.tokens} ({m.pct}%)
                    </span>
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: m.pct + '%',
                        backgroundColor: accentColor,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================
// SWARM MONITOR PAGE
// ============================================================

const SwarmPage = ({ tenant }: { tenant?: Tenant }) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, []);

  const nodes = [
    {
      id: 'hub',
      x: 240,
      y: 180,
      label: 'Knowledge Brain',
      color: accentColor,
      size: 28,
    },
    {
      id: 'support',
      x: 100,
      y: 80,
      label: 'Support Agent',
      color: '#3b82f6',
      size: 20,
    },
    {
      id: 'billing',
      x: 380,
      y: 80,
      label: 'Billing Agent',
      color: '#10b981',
      size: 20,
    },
    {
      id: 'onboard',
      x: 60,
      y: 220,
      label: 'Onboarding Agent',
      color: '#8b5cf6',
      size: 20,
    },
    { id: 'hr', x: 420, y: 220, label: 'HR Agent', color: '#f59e0b', size: 20 },
    {
      id: 'compliance',
      x: 120,
      y: 330,
      label: 'Compliance Agent',
      color: '#ef4444',
      size: 20,
    },
    {
      id: 'sales',
      x: 360,
      y: 330,
      label: 'Sales Agent',
      color: '#06b6d4',
      size: 20,
    },
    {
      id: 'it',
      x: 240,
      y: 360,
      label: 'IT Helpdesk Agent',
      color: '#84cc16',
      size: 20,
    },
  ];

  const edges = [
    ['hub', 'support'],
    ['hub', 'billing'],
    ['hub', 'onboard'],
    ['hub', 'hr'],
    ['hub', 'compliance'],
    ['hub', 'sales'],
    ['hub', 'it'],
    ['support', 'billing'],
  ];

  const getNode = (id: string) => nodes.find((n) => n.id === id)!;

  const liveEvents = [
    'Support Agent resolved ticket T-9921',
    'Billing Agent queued credit approval for $350',
    'HR Agent answered benefits query for 3 staff',
    'Compliance Agent flagged policy change ÃÂ¢ÃÂÃÂ KB refresh triggered',
    'Onboarding Agent sent Day-1 pack to new hire Sarah M.',
    'Sales Agent qualified lead from web chat and pushed to CRM',
    'IT Helpdesk resolved 4 password reset requests',
    'Knowledge Brain indexed 42 new Zendesk tickets',
  ];

  const [eventIdx, setEventIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setEventIdx((e) => (e + 1) % liveEvents.length),
      3000
    );
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Swarm Monitor</h1>
          <p className="text-slate-400 text-sm mt-1">
            Real-time view of all AI agents and knowledge flows
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
          <span className="text-xs text-emerald-400 font-medium">
            All agents live
          </span>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
        <svg
          viewBox="0 0 480 420"
          className="w-full"
          style={{ maxHeight: '360px' }}
        >
          {edges.map((e, i) => {
            const from = getNode(e[0]);
            const to = getNode(e[1]);
            const active = (tick + i) % 3 === 0;
            return (
              <line
                key={i}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={active ? accentColor : '#334155'}
                strokeWidth={active ? 2 : 1}
                opacity={active ? 0.8 : 0.3}
                strokeDasharray={active ? '4 2' : 'none'}
              />
            );
          })}
          {nodes.map((node) => (
            <g key={node.id}>
              <circle
                cx={node.x}
                cy={node.y}
                r={node.size}
                fill={node.color}
                opacity="0.15"
              />
              <circle
                cx={node.x}
                cy={node.y}
                r={node.size - 4}
                fill={node.color}
                opacity="0.3"
                stroke={node.color}
                strokeWidth="1.5"
              />
              <text
                x={node.x}
                y={node.y + 5}
                textAnchor="middle"
                fontSize={node.size === 28 ? '12' : '10'}
                fill="white"
              >
                AI
              </text>
              <text
                x={node.x}
                y={node.y + node.size + 14}
                textAnchor="middle"
                fontSize="9"
                fill="#94a3b8"
              >
                {node.label}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse flex-shrink-0" />
          <span className="text-sm text-slate-300">{liveEvents[eventIdx]}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {nodes
          .filter((n) => n.id !== 'hub')
          .map((node, i) => (
            <div
              key={i}
              className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center"
            >
              <div
                className="w-8 h-8 rounded-full mx-auto mb-2"
                style={{
                  backgroundColor: node.color + '30',
                  border: '1px solid ' + node.color + '60',
                }}
              />
              <div className="text-xs font-medium text-white mb-1">
                {node.label.replace(' Agent', '')}
              </div>
              <div className="flex items-center justify-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-emerald-400">Active</span>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
};

// ============================================================
// SECURITY PAGE
// ============================================================

const SecurityPage = ({
  user,
  tenant,
}: {
  user?: AuthUser;
  tenant?: Tenant;
}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [activeTab, setActiveTab] = useState<
    'overview' | 'rbac' | 'audit' | 'compliance'
  >('overview');

  const auditLogs = [
    {
      time: '10:42 AM',
      user: 'Morgan Chen',
      action: 'Approved credit request for customer Emily Carter ($350)',
      type: 'approval',
      severity: 'info',
    },
    {
      time: '10:38 AM',
      user: 'Support Agent',
      action:
        'Attempted password reset for customer James Liu ÃÂ¢ÃÂÃÂ awaiting approval',
      type: 'agent_action',
      severity: 'warn',
    },
    {
      time: '10:21 AM',
      user: 'Taylor Smith',
      action: 'Added new team member with manager role',
      type: 'admin',
      severity: 'info',
    },
    {
      time: '9:55 AM',
      user: 'Billing Agent',
      action: 'Issued $120 credit to account 7712 within auto-approve limit',
      type: 'agent_action',
      severity: 'info',
    },
    {
      time: '9:30 AM',
      user: 'Morgan Chen',
      action: 'Exported full tenant data backup',
      type: 'admin',
      severity: 'warn',
    },
    {
      time: '9:10 AM',
      user: 'IT Helpdesk Agent',
      action: 'Provisioned software access for new hire Sarah M.',
      type: 'agent_action',
      severity: 'info',
    },
  ];

  const teamMembers = [
    {
      name: 'Morgan Chen',
      email: 'morgan@acme.com',
      role: 'tenant_owner',
      lastActive: '2 min ago',
    },
    {
      name: 'Taylor Smith',
      email: 'taylor@acme.com',
      role: 'tenant_admin',
      lastActive: '1 hr ago',
    },
    {
      name: 'Quinn Park',
      email: 'quinn@acme.com',
      role: 'tenant_manager',
      lastActive: '3 hr ago',
    },
    {
      name: 'Drew Wilson',
      email: 'drew@acme.com',
      role: 'tenant_user',
      lastActive: '1 day ago',
    },
    {
      name: 'Sarah Martinez',
      email: 'sarah@acme.com',
      role: 'tenant_user',
      lastActive: '3 days ago',
    },
  ];

  const severityColor: Record<string, string> = {
    info: 'text-blue-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Security and RBAC</h1>
          <p className="text-slate-400 text-sm mt-1">
            Access control, audit logging, and compliance for your AI platform
          </p>
        </div>
        <div className="flex gap-1 bg-slate-800 rounded-xl p-1">
          {(['overview', 'rbac', 'audit', 'compliance'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all capitalize ${
                activeTab === t
                  ? 'text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
              style={activeTab === t ? { backgroundColor: accentColor } : {}}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Team Members"
              value={String(teamMembers.length)}
              icon="ÃÂ¢ÃÂÃÂ"
              color="blue"
            />
            <StatCard
              label="Active Sessions"
              value="3"
              icon="ÃÂ¢ÃÂÃÂ"
              color="emerald"
            />
            <StatCard
              label="Audit Events Today"
              value="47"
              icon="ÃÂ¢ÃÂÃÂ"
              color="indigo"
            />
            <StatCard
              label="Compliance Score"
              value="98%"
              icon="ÃÂ¢ÃÂÃÂ"
              color="amber"
              trend="Enterprise grade"
            />
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Security Posture
            </h2>
            <div className="space-y-3">
              {[
                {
                  label: 'Data Encryption at rest and in transit',
                  status: 'pass',
                },
                {
                  label: 'Multi-Factor Authentication enabled',
                  status: 'pass',
                },
                { label: 'RBAC roles correctly configured', status: 'pass' },
                { label: 'Agent action approval flows active', status: 'pass' },
                { label: 'Audit logging enabled', status: 'pass' },
                { label: 'SSO integration configured', status: 'warn' },
                { label: 'IP allowlist configured', status: 'warn' },
              ].map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-xl"
                >
                  <span
                    className={`text-sm ${
                      item.status === 'pass'
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                    }`}
                  >
                    {item.status === 'pass' ? 'v' : '!'}
                  </span>
                  <span className="text-sm text-white flex-1">
                    {item.label}
                  </span>
                  <Badge
                    label={item.status === 'pass' ? 'Pass' : 'Review'}
                    color={item.status === 'pass' ? 'green' : 'yellow'}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'rbac' && (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                Team Members and Roles
              </h2>
              <button
                className="text-xs px-3 py-1.5 text-white rounded-lg"
                style={{ backgroundColor: accentColor }}
              >
                Invite Member
              </button>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Member', 'Email', 'Role', 'Last Active'].map((h) => (
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
                {teamMembers.map((m, i) => (
                  <tr key={i} className="hover:bg-slate-800/30 transition-all">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white"
                          style={{ backgroundColor: accentColor + '60' }}
                        >
                          {m.name
                            .split(' ')
                            .map((n) => n[0])
                            .join('')}
                        </div>
                        <span className="text-sm text-white">{m.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {m.email}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        label={m.role.replace('tenant_', '')}
                        color={
                          m.role === 'tenant_owner'
                            ? 'red'
                            : m.role === 'tenant_admin'
                            ? 'amber'
                            : 'blue'
                        }
                      />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {m.lastActive}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'audit' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Audit Log</h2>
            <button className="text-xs px-3 py-1.5 text-slate-400 hover:text-white bg-slate-800 rounded-lg">
              Export CSV
            </button>
          </div>
          <div className="divide-y divide-slate-800">
            {auditLogs.map((log, i) => (
              <div
                key={i}
                className="flex items-start gap-4 px-5 py-3 hover:bg-slate-800/20 transition-all"
              >
                <span
                  className={`text-sm mt-0.5 ${severityColor[log.severity]}`}
                >
                  {log.type === 'agent_action'
                    ? '%'
                    : log.type === 'admin'
                    ? '*'
                    : '?'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-slate-300">
                      {log.user}
                    </span>
                    <Badge
                      label={log.type.replace('_', ' ')}
                      color={
                        log.type === 'agent_action'
                          ? 'blue'
                          : log.type === 'admin'
                          ? 'purple'
                          : 'slate'
                      }
                    />
                  </div>
                  <div className="text-xs text-slate-400">{log.action}</div>
                </div>
                <span className="text-xs text-slate-600 flex-shrink-0">
                  {log.time}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'compliance' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            {
              name: 'SOC 2 Type II',
              status: 'certified',
              desc: 'Annually audited. Last audit: Sept 2024',
              cert: 'Valid until Sept 2025',
            },
            {
              name: 'GDPR',
              status: 'certified',
              desc: 'Full compliance with EU data protection regulation',
              cert: 'Data Processing Agreement available',
            },
            {
              name: 'ISO 27001',
              status: 'certified',
              desc: 'Information security management systems',
              cert: 'Certificate ID: ISO-DT-2024-001',
            },
            {
              name: 'HIPAA',
              status: 'available',
              desc: 'Healthcare data protection ÃÂ¢ÃÂÃÂ available for healthcare tenants',
              cert: 'BAA available on request',
            },
            {
              name: 'PCI DSS',
              status: 'partial',
              desc: 'Payment card industry compliance ÃÂ¢ÃÂÃÂ Level 2 SAQ-D',
              cert: 'Renewal in progress',
            },
            {
              name: 'CCPA',
              status: 'certified',
              desc: 'California Consumer Privacy Act compliance',
              cert: 'Privacy policy updated Jan 2025',
            },
          ].map((c, i) => (
            <div
              key={i}
              className="bg-slate-900 border border-slate-800 rounded-xl p-5"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-slate-300 font-bold text-sm">
                  {c.name.slice(0, 3)}
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">
                    {c.name}
                  </div>
                  <Badge
                    label={
                      c.status === 'certified'
                        ? 'Certified'
                        : c.status === 'available'
                        ? 'Available'
                        : 'In Progress'
                    }
                    color={
                      c.status === 'certified'
                        ? 'green'
                        : c.status === 'available'
                        ? 'blue'
                        : 'yellow'
                    }
                  />
                </div>
              </div>
              <p className="text-xs text-slate-400 mb-2">{c.desc}</p>
              <p className="text-xs text-slate-500">{c.cert}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================
// INTEGRATIONS PAGE
// ============================================================

const IntegrationsPage = ({
  user,
  tenant,
}: {
  user?: AuthUser;
  tenant?: Tenant;
}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [showAddModal, setShowAddModal] = useState(false);

  const integrations = [
    {
      name: 'Slack',
      cat: 'Communication',
      connected: true,
      desc: 'AI notifications, approvals and commands via Slack',
    },
    {
      name: 'Microsoft Teams',
      cat: 'Communication',
      connected: false,
      desc: 'Agent alerts and approvals directly in Teams',
    },
    {
      name: 'Zendesk',
      cat: 'Support',
      connected: true,
      desc: 'Sync tickets and conversations bidirectionally',
    },
    {
      name: 'Intercom',
      cat: 'Support',
      connected: false,
      desc: 'AI answers in Intercom live chat widget',
    },
    {
      name: 'Salesforce',
      cat: 'CRM',
      connected: true,
      desc: 'Sync customers, leads, and account activity',
    },
    {
      name: 'HubSpot',
      cat: 'CRM',
      connected: false,
      desc: 'CRM contacts and deals sync with AI agents',
    },
    {
      name: 'Stripe',
      cat: 'Payments',
      connected: true,
      desc: 'Billing lookups and payment status for agents',
    },
    {
      name: 'QuickBooks',
      cat: 'Accounting',
      connected: false,
      desc: 'Invoice generation and financial data access',
    },
    {
      name: 'Jira',
      cat: 'Project',
      connected: false,
      desc: 'Ticket creation and issue tracking integration',
    },
    {
      name: 'Confluence',
      cat: 'Knowledge',
      connected: true,
      desc: 'Auto-sync wiki pages to Knowledge Hub',
    },
    {
      name: 'Notion',
      cat: 'Knowledge',
      connected: false,
      desc: 'Sync Notion pages and databases to KB',
    },
    {
      name: 'Google Drive',
      cat: 'Storage',
      connected: true,
      desc: 'Index Drive documents into the Knowledge Hub',
    },
    {
      name: 'Okta',
      cat: 'Identity',
      connected: false,
      desc: 'SSO authentication and user provisioning',
    },
    {
      name: 'Azure AD',
      cat: 'Identity',
      connected: false,
      desc: 'Microsoft identity management and SSO',
    },
    {
      name: 'Workday',
      cat: 'HR',
      connected: false,
      desc: 'Employee data and HR processes integration',
    },
    {
      name: 'BambooHR',
      cat: 'HR',
      connected: false,
      desc: 'HR records sync for onboarding agents',
    },
    {
      name: 'Webhook',
      cat: 'Developer',
      connected: true,
      desc: 'Custom webhook events for agent triggers',
    },
    {
      name: 'REST API',
      cat: 'Developer',
      connected: true,
      desc: 'Full API access for custom integrations',
    },
    {
      name: 'GitHub',
      cat: 'Developer',
      connected: false,
      desc: 'Sync READMEs and docs to Knowledge Hub',
    },
    {
      name: 'Datadog',
      cat: 'Monitoring',
      connected: false,
      desc: 'System health and performance monitoring',
    },
  ];

  const categories = [
    'All',
    ...Array.from(new Set(integrations.map((i) => i.cat))),
  ];
  const filtered = integrations.filter(
    (i) =>
      (category === 'All' || i.cat === category) &&
      i.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Integrations</h1>
          <p className="text-slate-400 text-sm mt-1">
            Connect your tools to extend agent capabilities and data access
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
          style={{ backgroundColor: accentColor }}
        >
          + Add Integration
        </button>
      </div>
      <div className="flex gap-4 mb-5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search integrations..."
          className="flex-1 max-w-sm bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
        />
        <div className="flex gap-1 bg-slate-800 rounded-xl p-1 overflow-x-auto">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                category === c
                  ? 'text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
              style={category === c ? { backgroundColor: accentColor } : {}}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map((intg, i) => (
          <div
            key={i}
            className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all"
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-medium text-white">
                  {intg.name}
                </div>
                <Badge label={intg.cat} color="slate" />
              </div>
              {intg.connected && (
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
              )}
            </div>
            <p className="text-xs text-slate-400 mb-3 leading-relaxed">
              {intg.desc}
            </p>
            <button
              className={`w-full py-1.5 rounded-lg text-xs font-medium transition-all ${
                intg.connected
                  ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                  : 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'
              }`}
            >
              {intg.connected ? 'v Connected' : 'Connect'}
            </button>
          </div>
        ))}
      </div>
      {showAddModal && (
        <Modal
          title="Add Custom Integration"
          onClose={() => setShowAddModal(false)}
        >
          <div className="space-y-4">
            {[
              {
                label: 'Integration Name',
                placeholder: 'My Custom API',
                type: 'text',
              },
              {
                label: 'Webhook URL',
                placeholder: 'https://api.yourapp.com/webhook',
                type: 'text',
              },
              { label: 'API Key', placeholder: 'sk-...', type: 'password' },
            ].map((f, i) => (
              <div key={i}>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">
                  {f.label}
                </label>
                <input
                  type={f.type}
                  placeholder={f.placeholder}
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
            ))}
            <button
              className="w-full py-2.5 text-white text-sm font-medium rounded-xl"
              style={{ backgroundColor: accentColor }}
            >
              Save Integration
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ============================================================
// KNOWLEDGE & DATA PAGE
// ============================================================

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
  const [selectedSubSection, setSelectedSubSection] = useState<string | null>(
    null
  );
  const [kbSearch, setKbSearch] = useState('');
  const [audienceFilter, setAudienceFilter] = useState<
    'All' | 'Customer' | 'Internal' | 'Both'
  >('All');
  const [typeFilter, setTypeFilter] = useState<'all' | KnowledgeItemType>(
    'all'
  );
  const [selectedConnector, setSelectedConnector] =
    useState<RegisteredConnector | null>(null);
  const [selectedAgent, setSelectedConnectorAgent] = useState<string>('all');

  const filteredItems = mockKnowledgeItems.filter((item) => {
    const matchSearch =
      !kbSearch ||
      item.title.toLowerCase().includes(kbSearch.toLowerCase()) ||
      item.summary.toLowerCase().includes(kbSearch.toLowerCase()) ||
      item.tags.some((t) => t.includes(kbSearch.toLowerCase()));
    const matchAudience =
      audienceFilter === 'All' || item.audience === audienceFilter;
    const matchType = typeFilter === 'all' || item.type === typeFilter;
    const matchProduct = !selectedProduct || item.productId === selectedProduct;
    const matchModule = !selectedModule || item.moduleId === selectedModule;
    const matchSection = !selectedSection || item.sectionId === selectedSection;
    const matchSubSection =
      !selectedSubSection || item.subSectionId === selectedSubSection;
    return (
      matchSearch &&
      matchAudience &&
      matchType &&
      matchProduct &&
      matchModule &&
      matchSection &&
      matchSubSection
    );
  });

  const getTaxBreadcrumb = (item: KnowledgeItem) => {
    const prod = knowledgeTaxonomy.find((p) => p.id === item.productId);
    const mod = prod?.modules.find((m) => m.id === item.moduleId);
    const sec = mod?.sections.find((s) => s.id === item.sectionId);
    const sub = sec?.subSections.find((ss) => ss.id === item.subSectionId);
    return [prod?.label, mod?.label, sec?.label, sub?.label]
      .filter(Boolean)
      .join(' ÃÂ¢ÃÂÃÂº ');
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
      mockImportedFiles
        .filter((f) => f.status === 'indexed')
        .reduce((s, f) => s + f.chunkCount, 0);
    const indexedItems = mockKnowledgeItems.filter(
      (i) => i.embedStatus === 'indexed'
    ).length;
    const staleItems = mockKnowledgeItems.filter(
      (i) => i.freshnessScore < 80
    ).length;
    const connectedDCs = registeredConnectors.filter(
      (c) => c.status === 'connected'
    ).length;
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">
            Knowledge &amp; Data
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Centralised knowledge taxonomy, connector registry, and file store ÃÂ¢ÃÂÃÂ
            powering every agent's RAG pipeline
          </p>
        </div>
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Knowledge Articles"
            value={String(mockKnowledgeItems.length)}
            icon="ÃÂ¢ÃÂÃÂ¡"
            color="indigo"
          />
          <StatCard
            label="Vector Chunks Indexed"
            value={String(totalChunks.toLocaleString())}
            icon="ÃÂ¢ÃÂÃÂ"
            color="emerald"
          />
          <StatCard
            label="Data Connectors"
            value={String(connectedDCs) + '/' + registeredConnectors.length}
            icon="ÃÂ¢ÃÂÃÂ"
            color="blue"
          />
          <StatCard
            label="Imported Files"
            value={String(mockImportedFiles.length)}
            icon="ÃÂ¢ÃÂÃÂ¤"
            color="purple"
          />
        </div>
        <div className="grid grid-cols-3 gap-4 mb-6">
          {knowledgeTaxonomy.map((prod) => {
            const items = mockKnowledgeItems.filter(
              (i) => i.productId === prod.id
            );
            const indexed = items.filter(
              (i) => i.embedStatus === 'indexed'
            ).length;
            const custItems = items.filter(
              (i) => i.audience === 'Customer' || i.audience === 'Both'
            ).length;
            const intItems = items.filter(
              (i) => i.audience === 'Internal' || i.audience === 'Both'
            ).length;
            return (
              <div
                key={prod.id}
                className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors cursor-pointer"
                onClick={() => {
                  setSelectedProduct(prod.id);
                  setPage('knowledge_taxonomy');
                }}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: prod.color }}
                  />
                  <span className="text-white font-semibold text-sm">
                    {prod.label}
                  </span>
                </div>
                <div className="text-2xl font-bold text-white mb-1">
                  {items.length}
                </div>
                <div className="text-xs text-slate-500 mb-3">
                  articles across {prod.modules.length} modules
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-slate-800 rounded-full h-1.5">
                      <div
                        className="bg-indigo-500 h-1.5 rounded-full"
                        style={{
                          width: items.length
                            ? (custItems / items.length) * 100 + '%'
                            : '0%',
                        }}
                      />
                    </div>
                    <span className="text-xs text-slate-500 w-24">
                      Customer: {custItems}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-slate-800 rounded-full h-1.5">
                      <div
                        className="bg-purple-500 h-1.5 rounded-full"
                        style={{
                          width: items.length
                            ? (intItems / items.length) * 100 + '%'
                            : '0%',
                        }}
                      />
                    </div>
                    <span className="text-xs text-slate-500 w-24">
                      Internal: {intItems}
                    </span>
                  </div>
                </div>
                <div className="mt-3 text-xs text-emerald-400">
                  {indexed}/{items.length} indexed
                </div>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="text-sm font-semibold text-white mb-3">
              Tag Cloud
            </div>
            <div className="flex flex-wrap gap-2">
              {knowledgeTags.map((tag) => {
                const count = mockKnowledgeItems.filter((i) =>
                  i.tags.includes(tag.label)
                ).length;
                return (
                  <span
                    key={tag.id}
                    className="px-2 py-1 bg-slate-800 text-slate-300 rounded-full text-xs cursor-pointer hover:bg-indigo-900 hover:text-indigo-300 transition-colors"
                  >
                    {tag.label} <span className="text-slate-500">{count}</span>
                  </span>
                );
              })}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="text-sm font-semibold text-white mb-3">
              Data Connector Health
            </div>
            <div className="space-y-2">
              {registeredConnectors.map((dc) => (
                <div key={dc.id} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300">
                    {dc.icon}
                  </div>
                  <div className="flex-1">
                    <div className="text-xs text-white">{dc.name}</div>
                    <div className="text-xs text-slate-500">
                      Synced {dc.lastSync}
                    </div>
                  </div>
                  <span
                    className={
                      dc.status === 'connected'
                        ? 'text-emerald-400 text-xs'
                        : 'text-red-400 text-xs'
                    }
                  >
                    {dc.status}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-xs ${
                      catColors[dc.category]
                    }`}
                  >
                    {dc.category}
                  </span>
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
      <div className="flex-1 overflow-hidden bg-slate-950 flex">
        {/* Taxonomy tree sidebar */}
        <div className="w-72 flex-shrink-0 border-r border-slate-800 overflow-y-auto p-4">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
            Taxonomy Tree
          </div>
          <button
            onClick={() => {
              setSelectedProduct(null);
              setSelectedModule(null);
              setSelectedSection(null);
              setSelectedSubSection(null);
            }}
            className={`w-full text-left px-2 py-1 rounded text-xs mb-2 ${
              !selectedProduct
                ? 'bg-indigo-900 text-indigo-300'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            All Products ({mockKnowledgeItems.length})
          </button>
          {knowledgeTaxonomy.map((prod) => (
            <div key={prod.id} className="mb-2">
              <button
                onClick={() => {
                  setSelectedProduct(
                    prod.id === selectedProduct ? null : prod.id
                  );
                  setSelectedModule(null);
                  setSelectedSection(null);
                  setSelectedSubSection(null);
                }}
                className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 ${
                  selectedProduct === prod.id
                    ? 'text-white font-medium'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: prod.color }}
                />
                {prod.label}
                <span className="ml-auto text-slate-600">
                  {
                    mockKnowledgeItems.filter((i) => i.productId === prod.id)
                      .length
                  }
                </span>
              </button>
              {selectedProduct === prod.id &&
                prod.modules.map((mod) => (
                  <div key={mod.id} className="ml-4">
                    <button
                      onClick={() => {
                        setSelectedModule(
                          mod.id === selectedModule ? null : mod.id
                        );
                        setSelectedSection(null);
                        setSelectedSubSection(null);
                      }}
                      className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1 ${
                        selectedModule === mod.id
                          ? 'text-indigo-300 font-medium'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      <span className="text-slate-700">
                        {selectedModule === mod.id ? 'v' : '>'}
                      </span>
                      {mod.label}
                      <span className="ml-auto text-slate-700">
                        {
                          mockKnowledgeItems.filter(
                            (i) => i.moduleId === mod.id
                          ).length
                        }
                      </span>
                    </button>
                    {selectedModule === mod.id &&
                      mod.sections.map((sec) => (
                        <div key={sec.id} className="ml-3">
                          <button
                            onClick={() => {
                              setSelectedSection(
                                sec.id === selectedSection ? null : sec.id
                              );
                              setSelectedSubSection(null);
                            }}
                            className={`w-full text-left px-2 py-0.5 rounded text-xs flex items-center gap-1 ${
                              selectedSection === sec.id
                                ? 'text-teal-300'
                                : 'text-slate-600 hover:text-slate-400'
                            }`}
                          >
                            <span>
                              {selectedSection === sec.id ? '-' : '+'}
                            </span>
                            {sec.label}
                          </button>
                          {selectedSection === sec.id &&
                            sec.subSections.map((ss) => (
                              <button
                                key={ss.id}
                                onClick={() =>
                                  setSelectedSubSection(
                                    ss.id === selectedSubSection ? null : ss.id
                                  )
                                }
                                className={`w-full text-left px-3 py-0.5 rounded text-xs flex items-center ml-2 ${
                                  selectedSubSection === ss.id
                                    ? 'text-yellow-300'
                                    : 'text-slate-700 hover:text-slate-500'
                                }`}
                              >
                                <span className="mr-1 text-slate-800">-</span>
                                {ss.label}
                                <span className="ml-auto text-slate-800">
                                  {ss.articleCount}
                                </span>
                              </button>
                            ))}
                        </div>
                      ))}
                  </div>
                ))}
            </div>
          ))}
        </div>

        {/* Articles panel */}
        <div className="flex-1 overflow-auto p-6">
          {/* Search + filters */}
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
                className={`px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
                  audienceFilter === a
                    ? 'text-white'
                    : 'bg-slate-900 text-slate-400 border border-slate-700'
                }`}
                style={
                  audienceFilter === a ? { backgroundColor: accentColor } : {}
                }
              >
                {a}
              </button>
            ))}
            <select
              value={typeFilter}
              onChange={(e) =>
                setTypeFilter(e.target.value as typeof typeFilter)
              }
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
          <div className="text-xs text-slate-500 mb-4">
            {filteredItems.length} items
          </div>
          <div className="space-y-3">
            {filteredItems.map((item) => (
              <div
                key={item.id}
                className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors"
              >
                <div className="flex items-start gap-3 mb-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          typeColors[item.type] || 'bg-slate-700 text-slate-300'
                        }`}
                      >
                        {item.type.replace(/_/g, ' ')}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          audienceColors[item.audience]
                        }`}
                      >
                        {item.audience}
                      </span>
                      <span
                        className={`text-xs ${embedColors[item.embedStatus]}`}
                      >
                        {item.embedStatus}
                      </span>
                      <span className="text-xs text-slate-600">
                        {item.chunkCount} chunks
                      </span>
                    </div>
                    <div className="text-sm font-semibold text-white mb-1">
                      {item.title}
                    </div>
                    <div className="text-xs text-slate-500 mb-2">
                      {item.summary}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-xs text-slate-600">
                      v{item.version}
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">
                      {item.updatedAt}
                    </div>
                    <div
                      className={`text-xs mt-1 ${
                        item.freshnessScore >= 90
                          ? 'text-emerald-400'
                          : item.freshnessScore >= 70
                          ? 'text-yellow-400'
                          : 'text-red-400'
                      }`}
                    >
                      {item.freshnessScore}% fresh
                    </div>
                  </div>
                </div>
                {/* Taxonomy breadcrumb */}
                <div className="text-xs text-slate-600 mb-2">
                  {getTaxBreadcrumb(item)}
                </div>
                {/* Tags */}
                <div className="flex flex-wrap gap-1">
                  {item.tags.map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded text-xs"
                    >
                      {t}
                    </span>
                  ))}
                  {item.subTags.map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 bg-slate-800/50 text-slate-600 rounded text-xs"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {filteredItems.length === 0 && (
              <div className="text-center py-16 text-slate-500 text-sm">
                No articles match the current filters.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---- DATA CONNECTORS ----
  if (subPage === 'connectors') {
    const agentOptions = [
      { id: 'all', name: 'All Agents' },
      ...['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']
        .map((id) => {
          const found = registeredConnectors
            .flatMap((c) => c.agentBindings)
            .find((b) => b.agentId === id);
          return found ? { id, name: 'Agent ' + id.toUpperCase() } : null;
        })
        .filter(Boolean),
    ] as { id: string; name: string }[];

    const displayConnectors =
      selectedAgent === 'all'
        ? registeredConnectors
        : registeredConnectors.filter((c) =>
            c.agentBindings.some((b) => b.agentId === selectedAgent)
          );

    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">
              Data Connector Registry
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Field-level permissions for every connector bound to an agent ÃÂ¢ÃÂÃÂ
              the source of truth for what agents can read and write
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
              <div
                key={dc.id}
                className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden"
              >
                {/* Header row */}
                <div
                  className="p-4 flex items-center gap-4 cursor-pointer hover:bg-slate-800/50 transition-colors"
                  onClick={() => setSelectedConnector(isExpanded ? null : dc)}
                >
                  <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-sm font-bold text-slate-300 flex-shrink-0">
                    {dc.icon}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-semibold text-white">
                        {dc.name}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          catColors[dc.category]
                        }`}
                      >
                        {dc.category}
                      </span>
                      <span className={`text-xs ${statusColors[dc.status]}`}>
                        {dc.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500">
                      Synced {dc.lastSync} ÃÂÃÂ· {dc.syncFrequency} ÃÂÃÂ·{' '}
                      {dc.recordCount.toLocaleString()} records ÃÂÃÂ·{' '}
                      {dc.objects.length} objects ÃÂÃÂ· {boundAgents} agent
                      {boundAgents !== 1 ? 's' : ''} bound
                    </div>
                  </div>
                  <span className="text-slate-600 text-sm">
                    {isExpanded ? 'v' : '>'}
                  </span>
                </div>

                {/* Expanded field-level mapping */}
                {isExpanded && (
                  <div className="border-t border-slate-800 p-4">
                    {dc.agentBindings.map((binding) => {
                      const agentNames: Record<string, string> = {
                        a1: 'Support Agent',
                        a2: 'Onboarding Agent',
                        a3: 'Billing Agent',
                        a4: 'Account Agent',
                        a5: 'Knowledge Curator',
                        a6: 'Compliance Bot',
                        a7: 'HR Knowledge Agent',
                        a8: 'Sales Intelligence Agent',
                      };
                      if (
                        selectedAgent !== 'all' &&
                        binding.agentId !== selectedAgent
                      )
                        return null;
                      return (
                        <div key={binding.agentId} className="mb-4">
                          <div className="text-xs font-semibold text-indigo-400 mb-2">
                            {agentNames[binding.agentId] || binding.agentId}
                          </div>
                          {binding.objects.map((obj) => {
                            const connObj = dc.objects.find(
                              (o) => o.name === obj.objectName
                            );
                            if (!connObj) return null;
                            return (
                              <div key={obj.objectName} className="mb-3">
                                <div className="text-xs text-slate-400 mb-1 font-medium">
                                  {connObj.label}
                                </div>
                                <div className="bg-slate-950 rounded-lg overflow-hidden">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="border-b border-slate-800">
                                        <th className="text-left px-3 py-1.5 text-slate-500 font-medium">
                                          Field
                                        </th>
                                        <th className="text-left px-3 py-1.5 text-slate-500 font-medium">
                                          Type
                                        </th>
                                        <th className="text-left px-3 py-1.5 text-slate-500 font-medium">
                                          Description
                                        </th>
                                        <th className="text-left px-3 py-1.5 text-slate-500 font-medium">
                                          PII
                                        </th>
                                        <th className="text-left px-3 py-1.5 text-slate-500 font-medium">
                                          Permission
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {connObj.fields.map((field) => {
                                        const perm =
                                          obj.fieldPermissions[field.name] ||
                                          'none';
                                        const permColors: Record<
                                          FieldPermission,
                                          string
                                        > = {
                                          read: 'text-emerald-400 bg-emerald-900/30',
                                          write:
                                            'text-yellow-400 bg-yellow-900/30',
                                          none: 'text-slate-600 bg-slate-800/50',
                                        };
                                        return (
                                          <tr
                                            key={field.name}
                                            className="border-b border-slate-800/50"
                                          >
                                            <td className="px-3 py-1.5 text-slate-300 font-mono">
                                              {field.name}
                                            </td>
                                            <td className="px-3 py-1.5 text-slate-600">
                                              {field.type}
                                            </td>
                                            <td className="px-3 py-1.5 text-slate-500">
                                              {field.description}
                                            </td>
                                            <td className="px-3 py-1.5">
                                              {field.pii ? (
                                                <span className="text-orange-400">
                                                  PII
                                                </span>
                                              ) : (
                                                <span className="text-slate-700">
                                                  -
                                                </span>
                                              )}
                                            </td>
                                            <td className="px-3 py-1.5">
                                              <span
                                                className={`px-2 py-0.5 rounded text-xs font-medium ${permColors[perm]}`}
                                              >
                                                {perm}
                                              </span>
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
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Imported Files</h1>
            <p className="text-slate-400 text-sm mt-1">
              Files uploaded or synced from storage connectors ÃÂ¢ÃÂÃÂ parsed,
              chunked, and indexed into the knowledge vector store
            </p>
          </div>
          <button
            className="px-4 py-2 rounded-xl text-white text-sm font-medium"
            style={{ backgroundColor: accentColor }}
          >
            + Upload File
          </button>
        </div>
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Total Files"
            value={String(mockImportedFiles.length)}
            icon="ÃÂ¢ÃÂÃÂ¤"
            color="indigo"
          />
          <StatCard
            label="Indexed"
            value={String(
              mockImportedFiles.filter((f) => f.status === 'indexed').length
            )}
            icon="ÃÂ¢ÃÂÃÂ"
            color="emerald"
          />
          <StatCard
            label="Processing"
            value={String(
              mockImportedFiles.filter((f) => f.status === 'processing').length
            )}
            icon="ÃÂ¢ÃÂÃÂ"
            color="yellow"
          />
          <StatCard
            label="Total Chunks"
            value={String(
              mockImportedFiles.reduce((s, f) => s + f.chunkCount, 0)
            )}
            icon="ÃÂ¢ÃÂÃÂ"
            color="blue"
          />
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">
                  File
                </th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">
                  Taxonomy
                </th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">
                  Audience
                </th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">
                  Tags
                </th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">
                  Chunks
                </th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">
                  Uploaded
                </th>
                <th className="text-left px-4 py-3 text-slate-500 text-xs font-semibold">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {mockImportedFiles.map((file) => {
                const prod = knowledgeTaxonomy.find(
                  (p) => p.id === file.productId
                );
                const mod = prod?.modules.find((m) => m.id === file.moduleId);
                return (
                  <tr
                    key={file.id}
                    className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-xs font-bold ${
                            typeIconColors[file.type] ||
                            'bg-slate-700 text-slate-300'
                          }`}
                        >
                          {file.type}
                        </span>
                        <div>
                          <div className="text-white text-xs font-medium">
                            {file.name}
                          </div>
                          <div className="text-slate-600 text-xs">
                            {file.size} ÃÂÃÂ· {file.uploadedBy}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {prod ? (
                        <div className="text-xs text-slate-400">
                          <div style={{ color: prod.color }}>{prod.label}</div>
                          {mod && (
                            <div className="text-slate-600">{mod.label}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-700 text-xs">
                          Unassigned
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          audienceColors[file.audience]
                        }`}
                      >
                        {file.audience}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {file.tags.map((t) => (
                          <span
                            key={t}
                            className="px-1.5 py-0.5 bg-slate-800 text-slate-500 rounded text-xs"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {file.chunkCount || '-'}
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {file.uploadedAt}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          statusColors[file.status]
                        }`}
                      >
                        {file.status}
                      </span>
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

// ============================================================
// DATA CONNECTORS PAGE
// ============================================================

const DataConnectorsPage = ({
  user,
  tenant,
}: {
  user?: AuthUser;
  tenant?: Tenant;
}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';

  const connectors = [
    {
      name: 'PostgreSQL Database',
      status: 'connected',
      tables: 42,
      lastSync: '5 min ago',
      records: '2.4M',
    },
    {
      name: 'Salesforce CRM',
      status: 'connected',
      tables: 18,
      lastSync: '1 hr ago',
      records: '89K',
    },
    {
      name: 'Zendesk',
      status: 'connected',
      tables: 8,
      lastSync: '10 min ago',
      records: '41K',
    },
    {
      name: 'Stripe',
      status: 'connected',
      tables: 12,
      lastSync: '2 hr ago',
      records: '12K',
    },
    {
      name: 'Google BigQuery',
      status: 'pending',
      tables: 0,
      lastSync: 'Not synced',
      records: '-',
    },
    {
      name: 'S3 Bucket',
      status: 'error',
      tables: 0,
      lastSync: 'Failed 3 hr ago',
      records: '-',
    },
  ];

  const statusColors: Record<string, string> = {
    connected: 'green',
    pending: 'yellow',
    error: 'red',
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Data Connectors</h1>
          <p className="text-slate-400 text-sm mt-1">
            Connect databases and data warehouses ÃÂ¢ÃÂÃÂ agents can query and act on
            live data
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
          <div
            key={i}
            className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all"
          >
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

// ============================================================
// SETTINGS PAGE
// ============================================================

const SettingsPage = ({
  user,
  tenant,
}: { user?: AuthUser; tenant?: Tenant } = {}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [activeTab, setActiveTab] = useState<
    'general' | 'tokens' | 'billing' | 'team' | 'security'
  >('general');

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 text-sm mt-1">
          Manage your workspace, team, and AI platform configuration
        </p>
      </div>
      <div className="flex gap-1 bg-slate-800 rounded-xl p-1 mb-6 overflow-x-auto w-fit">
        {(['general', 'tokens', 'billing', 'team', 'security'] as const).map(
          (t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all capitalize ${
                activeTab === t
                  ? 'text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
              style={activeTab === t ? { backgroundColor: accentColor } : {}}
            >
              {t}
            </button>
          )
        )}
      </div>

      {activeTab === 'general' && (
        <div className="max-w-2xl">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Workspace Details
            </h2>
            <div className="space-y-4">
              {[
                {
                  label: 'Workspace Name',
                  value: tenant?.name || 'My Workspace',
                },
                { label: 'Industry', value: tenant?.industry || 'Technology' },
                {
                  label: 'Contact Email',
                  value: tenant?.contactEmail || 'admin@company.com',
                },
              ].map((f, i) => (
                <div key={i}>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">
                    {f.label}
                  </label>
                  <input
                    defaultValue={f.value}
                    className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              ))}
            </div>
            <button
              className="mt-4 px-6 py-2.5 text-white text-sm font-medium rounded-xl"
              style={{ backgroundColor: accentColor }}
            >
              Save Changes
            </button>
          </div>
        </div>
      )}

      {activeTab === 'tokens' && (
        <div className="max-w-2xl">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1">
              Token Usage and Limits
            </h2>
            <p className="text-xs text-slate-400 mb-5">
              Control how many tokens each agent and feature can consume per
              day, week, and month.
            </p>
            <div className="mb-5">
              <div className="flex justify-between text-xs text-slate-400 mb-2">
                <span>Monthly usage</span>
                <span className="text-white">
                  2.4M of{' '}
                  {((tenant?.tokenLimit || 5000000) / 1000000).toFixed(0)}M
                  tokens
                </span>
              </div>
              <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: '48%', backgroundColor: accentColor }}
                />
              </div>
              <div className="flex justify-between mt-1 text-xs text-slate-600">
                <span>48% used</span>
                <span>Resets in 18 days</span>
              </div>
            </div>
            <div className="space-y-4">
              {[
                {
                  label: 'Monthly Token Limit',
                  value: '5,000,000',
                  unit: 'tokens',
                },
                {
                  label: 'Daily Token Budget',
                  value: '200,000',
                  unit: 'tokens/day',
                },
                {
                  label: 'Per-Agent Token Limit',
                  value: '50,000',
                  unit: 'tokens/day',
                },
                {
                  label: 'Single Query Cap',
                  value: '8,000',
                  unit: 'tokens/query',
                },
              ].map((f, i) => (
                <div key={i}>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">
                    {f.label} <span className="text-slate-600">({f.unit})</span>
                  </label>
                  <input
                    defaultValue={f.value}
                    className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              ))}
            </div>
            <div className="mt-5 space-y-3">
              {[
                {
                  label: 'Send warning at 80% usage',
                  desc: 'Email notification to workspace owners',
                  checked: true,
                },
                {
                  label: 'Block queries at 100% usage',
                  desc: 'Prevent overage charges by blocking new queries',
                  checked: true,
                },
              ].map((s, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-3 bg-slate-800/50 rounded-xl"
                >
                  <div>
                    <div className="text-sm text-white">{s.label}</div>
                    <div className="text-xs text-slate-500">{s.desc}</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only"
                      defaultChecked={s.checked}
                    />
                    <div className="w-9 h-5 bg-indigo-500 rounded-full">
                      <div className="w-4 h-4 bg-white rounded-full shadow mt-0.5 ml-4" />
                    </div>
                  </label>
                </div>
              ))}
            </div>
            <button
              className="mt-5 px-6 py-2.5 text-white text-sm font-medium rounded-xl"
              style={{ backgroundColor: accentColor }}
            >
              Save Token Settings
            </button>
          </div>
        </div>
      )}

      {(activeTab === 'billing' ||
        activeTab === 'team' ||
        activeTab === 'security') && (
        <div className="max-w-2xl">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
            <div className="text-4xl mb-3">*</div>
            <div className="text-sm font-medium text-white mb-1 capitalize">
              {activeTab} Settings
            </div>
            <div className="text-xs text-slate-400">
              Configuration options for {activeTab}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================
// PLATFORM CONSOLE PAGE (DreamTeam Super Admin)
// ============================================================

const PlatformConsolePage = ({
  page,
  setPage,
  user,
}: {
  page: PlatformPage;
  setPage: (p: Page) => void;
  user: AuthUser;
}) => {
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [godModeTarget, setGodModeTarget] = useState<Tenant | null>(null);

  if (page === 'platform_home') {
    const totalTokens = mockTenants.reduce((s, t) => s + t.monthlyTokens, 0);
    const activeTenants = mockTenants.filter(
      (t) => t.status === 'active'
    ).length;
    const totalAgents = mockTenants.reduce((s, t) => s + t.agentsActive, 0);
    const totalUsers = mockTenants.reduce((s, t) => s + t.usersCount, 0);

    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Platform Overview</h1>
          <p className="text-slate-400 text-sm mt-1">
            DreamTeam AI ÃÂ¢ÃÂÃÂ Master control centre for all tenants and system
            health
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Active Tenants"
            value={String(activeTenants)}
            icon="ÃÂ¢ÃÂÃÂ"
            color="indigo"
            trend={'of ' + mockTenants.length + ' total'}
          />
          <StatCard
            label="Total AI Agents"
            value={String(totalAgents)}
            icon="ÃÂ¢ÃÂÃÂ¡"
            color="emerald"
            trend="Across all tenants"
          />
          <StatCard
            label="Platform Users"
            value={String(totalUsers)}
            icon="ÃÂ¢ÃÂÃÂ"
            color="blue"
            trend="All tenants"
          />
          <StatCard
            label="Monthly Tokens"
            value={(totalTokens / 1000000).toFixed(1) + 'M'}
            icon="ÃÂ¢ÃÂÃÂ¡"
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
                  'Hooli Technologies exceeded 80% token limit ÃÂ¢ÃÂÃÂ warning sent',
                time: '4 hr ago',
                type: 'warn',
              },
              {
                event: 'Pied Piper account suspended ÃÂ¢ÃÂÃÂ payment failure',
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
              Manage all client workspaces ÃÂ¢ÃÂÃÂ view, configure, and support
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
              {mockTenants.map((t) => (
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
                        God Mode
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
            title={selectedTenant.name + ' ÃÂ¢ÃÂÃÂ Detail'}
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
                  Enter God Mode
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
            title={'God Mode: ' + godModeTarget.name}
            onClose={() => setGodModeTarget(null)}
          >
            <div className="space-y-4">
              <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                <p className="text-sm text-amber-300 font-medium mb-1">
                  God Mode Remote Access
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
                  <span className="text-white">Yes ÃÂ¢ÃÂÃÂ visible to tenant</span>
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
            icon="ÃÂ¢ÃÂÃÂ"
            color="emerald"
            trend="30-day SLA"
          />
          <StatCard
            label="Avg API Latency"
            value="84ms"
            icon="ÃÂ¢ÃÂÃÂ"
            color="blue"
            trend="-12ms vs last week"
          />
          <StatCard
            label="Active Incidents"
            value="0"
            icon="ÃÂ¢ÃÂÃÂ "
            color="emerald"
            trend="All clear"
          />
          <StatCard
            label="Error Rate"
            value="0.03%"
            icon="ÃÂ¢ÃÂÃÂ"
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
                    {svc.latency} ÃÂÃÂ· {svc.uptime} uptime
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
            icon="ÃÂ¢ÃÂÃÂ"
            color="emerald"
            trend="+12% MoM"
          />
          <StatCard
            label="ARR"
            value="$341,400"
            icon="ÃÂ¢ÃÂÃÂ"
            color="indigo"
            trend="On track"
          />
          <StatCard
            label="Active Subscriptions"
            value="5"
            icon="ÃÂ¢ÃÂÃÂ"
            color="blue"
            trend="1 suspended"
          />
          <StatCard
            label="Avg Revenue/Tenant"
            value="$5,690"
            icon="ÃÂ¢ÃÂÃÂ"
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
              {mockTenants.map((t) => {
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
            God Mode sessions and remote access to tenant workspaces
          </p>
        </div>
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-3">
            <span className="text-amber-400 text-lg">!</span>
            <div>
              <div className="text-sm font-medium text-amber-300">
                God Mode Access
              </div>
              <div className="text-xs text-amber-400/70">
                All remote sessions are fully logged and visible to tenant
                owners. Only authorised DT staff can initiate God Mode.
              </div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {mockTenants
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
                  Enter God Mode
                </button>
              </div>
            ))}
        </div>
        {godModeTarget && (
          <Modal
            title={'God Mode: ' + godModeTarget.name}
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

// ============================================================
// ONBOARDING WIZARD
// ============================================================

const OnboardingWizard = ({
  onComplete,
  tenant,
  user,
}: {
  onComplete: () => void;
  tenant?: Tenant;
  user?: AuthUser;
}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [step, setStep] = useState(0);
  const [brandName, setBrandName] = useState(tenant?.name || '');

  const steps = [
    { label: 'Workspace Brand', icon: '1' },
    { label: 'Data Connectors', icon: '2' },
    { label: 'Knowledge Base', icon: '3' },
    { label: 'AI Agents', icon: '4' },
    { label: 'Invite Team', icon: '5' },
    { label: 'Go Live', icon: '6' },
  ];

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="text-5xl mb-3">A</div>
              <h2 className="text-xl font-bold text-white mb-1">
                Set Up Your Workspace
              </h2>
              <p className="text-slate-400 text-sm">
                Customise your branded AI platform ÃÂ¢ÃÂÃÂ your customers and staff
                will see this
              </p>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">
                  Company Name
                </label>
                <input
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="Acme Corp"
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">
                  Industry
                </label>
                <input
                  placeholder="e.g. SaaS, Healthcare, Retail"
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-2">
                  Brand Colour
                </label>
                <div className="flex gap-2">
                  {[
                    '#6366f1',
                    '#10b981',
                    '#f59e0b',
                    '#ef4444',
                    '#8b5cf6',
                    '#0ea5e9',
                    '#ec4899',
                  ].map((c) => (
                    <div
                      key={c}
                      className="w-8 h-8 rounded-full cursor-pointer border-2 transition-all hover:scale-110"
                      style={{
                        backgroundColor: c,
                        borderColor:
                          c === accentColor ? 'white' : 'transparent',
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      case 1:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="text-5xl mb-3">B</div>
              <h2 className="text-xl font-bold text-white mb-1">
                Connect Your Data
              </h2>
              <p className="text-slate-400 text-sm">
                Connect data sources so AI agents have the right context
              </p>
            </div>
            <div className="space-y-3">
              {[
                {
                  name: 'Confluence or Notion',
                  desc: 'Import your existing documentation',
                },
                {
                  name: 'Zendesk or Intercom',
                  desc: 'Sync past tickets for KB learning',
                },
                { name: 'Google Drive', desc: 'Index documents and policies' },
                {
                  name: 'CRM Salesforce or HubSpot',
                  desc: 'Customer data for personalised responses',
                },
              ].map((src, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 bg-slate-800 rounded-xl cursor-pointer hover:bg-slate-700 transition-all"
                >
                  <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center text-slate-300 font-bold">
                    {src.name[0]}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-white">
                      {src.name}
                    </div>
                    <div className="text-xs text-slate-400">{src.desc}</div>
                  </div>
                  <button className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-all">
                    Connect
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      case 2:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="text-5xl mb-3">C</div>
              <h2 className="text-xl font-bold text-white mb-1">
                Build Your Knowledge Base
              </h2>
              <p className="text-slate-400 text-sm">
                Upload documents or write articles ÃÂ¢ÃÂÃÂ the AI uses this to answer
                queries
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                {
                  label: 'Upload PDF or DOCX',
                  desc: 'Policy docs, manuals, guides',
                },
                {
                  label: 'Write an Article',
                  desc: 'Create directly in the platform',
                },
                {
                  label: 'Import from URL',
                  desc: 'Crawl your help centre or docs site',
                },
                {
                  label: 'Use a Template',
                  desc: 'Pre-built KB starter templates',
                },
              ].map((opt, i) => (
                <div
                  key={i}
                  className="p-4 bg-slate-800 rounded-xl cursor-pointer hover:bg-slate-700 transition-all text-center"
                >
                  <div className="text-lg font-bold text-slate-300 mb-2">
                    {String.fromCharCode(65 + i)}
                  </div>
                  <div className="text-sm font-medium text-white mb-1">
                    {opt.label}
                  </div>
                  <div className="text-xs text-slate-400">{opt.desc}</div>
                </div>
              ))}
            </div>
          </div>
        );
      case 3:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="text-5xl mb-3">D</div>
              <h2 className="text-xl font-bold text-white mb-1">
                Activate AI Agents
              </h2>
              <p className="text-slate-400 text-sm">
                Choose which agents to deploy ÃÂ¢ÃÂÃÂ each serves customers or staff
              </p>
            </div>
            <div className="space-y-3">
              {[
                {
                  name: 'Customer Support Agent',
                  desc: 'Handles tier-1 support from your KB',
                  audience: 'Customer',
                },
                {
                  name: 'Onboarding Agent',
                  desc: 'Guides new employees through onboarding',
                  audience: 'Internal',
                },
                {
                  name: 'HR Knowledge Agent',
                  desc: 'Answers HR policy and benefits questions',
                  audience: 'Internal',
                },
                {
                  name: 'Billing Agent',
                  desc: 'Handles billing and payment queries',
                  audience: 'Customer',
                },
              ].map((agent, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 bg-slate-800 rounded-xl"
                >
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center text-sm text-indigo-300 font-bold">
                    {agent.name[0]}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium text-white">
                        {agent.name}
                      </div>
                      <Badge
                        label={agent.audience}
                        color={
                          agent.audience === 'Customer' ? 'blue' : 'purple'
                        }
                      />
                    </div>
                    <div className="text-xs text-slate-400">{agent.desc}</div>
                  </div>
                  <div className="w-9 h-5 bg-indigo-500 rounded-full flex items-center">
                    <div className="w-4 h-4 bg-white rounded-full shadow ml-4" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      case 4:
        return (
          <div className="space-y-5">
            <div className="text-center">
              <div className="text-5xl mb-3">E</div>
              <h2 className="text-xl font-bold text-white mb-1">
                Invite Your Team
              </h2>
              <p className="text-slate-400 text-sm">
                Add team members to manage agents, review approvals, and access
                the Knowledge Hub
              </p>
            </div>
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-2">
                  <input
                    placeholder="colleague@company.com"
                    className="flex-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                  <select className="bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2.5">
                    <option>Admin</option>
                    <option>Manager</option>
                    <option>User</option>
                  </select>
                </div>
              ))}
              <button className="w-full py-2 border border-dashed border-slate-700 text-slate-400 text-sm rounded-xl hover:border-indigo-500 hover:text-indigo-400 transition-all">
                + Add another
              </button>
            </div>
          </div>
        );
      case 5:
        return (
          <div className="space-y-5 text-center">
            <div className="text-6xl mb-3">F</div>
            <h2 className="text-xl font-bold text-white">You are all set!</h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Your AI platform is configured and ready. Agents are standing by,
              your Knowledge Hub is building, and your team has been invited.
            </p>
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                { label: 'Agents Ready', value: '4' },
                { label: 'KB Articles', value: '0' },
                { label: 'Team Members', value: '4' },
              ].map((item, i) => (
                <div key={i} className="bg-slate-800 rounded-xl p-3">
                  <div className="text-xl font-bold text-white">
                    {item.value}
                  </div>
                  <div className="text-xs text-slate-400">{item.label}</div>
                </div>
              ))}
            </div>
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
              <p className="text-sm text-emerald-300">
                Your AI platform will get smarter every day as agents learn from
                interactions
              </p>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 w-full max-w-lg mx-4">
        <div className="flex items-center justify-center gap-2 mb-8">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                  i < step
                    ? 'bg-emerald-500 text-white'
                    : i === step
                    ? 'text-white'
                    : 'bg-slate-800 text-slate-600'
                }`}
                style={i === step ? { backgroundColor: accentColor } : {}}
              >
                {i < step ? 'v' : String(i + 1)}
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`w-6 h-0.5 mx-1 ${
                    i < step ? 'bg-emerald-500' : 'bg-slate-800'
                  }`}
                />
              )}
            </div>
          ))}
        </div>
        <div className="mb-8">{renderStep()}</div>
        <div className="flex gap-3">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="px-5 py-2.5 text-slate-400 hover:text-white bg-slate-800 rounded-xl text-sm transition-all"
            >
              Back
            </button>
          )}
          <button
            onClick={() =>
              step < steps.length - 1 ? setStep(step + 1) : onComplete()
            }
            className="flex-1 py-2.5 text-white text-sm font-medium rounded-xl transition-all"
            style={{ backgroundColor: accentColor }}
          >
            {step === steps.length - 1 ? 'Launch Platform' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// LOGIN PAGE
// ============================================================

const LoginPage = ({ onLogin }: { onLogin: (u: AuthUser) => void }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const demoAccounts = [
    {
      group: 'DreamTeam Platform',
      users: [mockUsers[0], mockUsers[1], mockUsers[2], mockUsers[3]],
    },
    {
      group: 'Tenant: Acme Corp',
      users: [mockUsers[4], mockUsers[5], mockUsers[6], mockUsers[7]],
    },
    { group: 'Other Tenants', users: [mockUsers[8], mockUsers[9]] },
  ];

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (authError) {
        setError(authError.message);
      } else if (authData.user) {
        onLogin({
          id: authData.user.id,
          name: authData.user.user_metadata?.full_name || authData.user.email || 'User',
          email: authData.user.email || '',
          role: (authData.user.user_metadata?.role || 'tenant_admin') as any,
          tenantId: authData.user.user_metadata?.tenant_id || null,
          avatar: authData.user.user_metadata?.avatar || '',
          layer: (authData.user.user_metadata?.layer || 'tenant') as any,
        });
      }
    } catch (err: any) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex">
      <div
        className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)',
        }}
      >
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-20 w-64 h-64 rounded-full bg-indigo-500 blur-3xl" />
          <div className="absolute bottom-20 right-20 w-48 h-48 rounded-full bg-purple-500 blur-3xl" />
        </div>
        <div className="relative">
          <div className="flex items-center gap-3 mb-16">
            <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center text-white font-bold">
              DT
            </div>
            <div>
              <div className="text-white font-bold text-lg">DreamTeam AI</div>
              <div className="text-indigo-300 text-xs">
                Agentic Intelligence Platform
              </div>
            </div>
          </div>
          <h1 className="text-4xl font-bold text-white mb-4 leading-tight">
            AI agents that work
            <br />
            for you 24/7
          </h1>
          <p className="text-indigo-200 text-sm leading-relaxed mb-8">
            Knowledge base and configurable AI agents that serve your customers
            and internal staff equally ÃÂ¢ÃÂÃÂ with full audit trails and
            human-in-the-loop controls.
          </p>
          <div className="space-y-4">
            {[
              {
                label: 'Unified Knowledge Base',
                desc: 'One source of truth for customers and staff',
              },
              {
                label: 'Configurable AI Agents',
                desc: 'Agents that act on behalf of your customers',
              },
              {
                label: 'Human-in-the-Loop',
                desc: 'Approval flows and confidence gates built in',
              },
            ].map((f, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-indigo-300 flex-shrink-0 font-bold">
                  {String(i + 1)}
                </div>
                <div>
                  <div className="text-white text-sm font-medium">
                    {f.label}
                  </div>
                  <div className="text-indigo-300 text-xs">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative text-xs text-indigo-400">
          2026 DreamTeam AI. Enterprise Grade. SOC 2 Type II
        </div>
      </div>

      <div className="flex-1 flex flex-col justify-center p-8 lg:p-16">
        <div className="max-w-sm mx-auto w-full">
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-xs font-bold">
              DT
            </div>
            <span className="text-white font-bold">DreamTeam AI</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-1">Welcome back</h2>
          <p className="text-slate-400 text-sm mb-8">
            Sign in to your workspace
          </p>
          <div className="space-y-4 mb-6">
            <div>
              <label className="text-xs font-medium text-slate-400 block mb-1.5">
                Email
              </label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                type="email"
                placeholder="you@company.com"
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 block mb-1.5">
                Password
              </label>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                type="password"
                placeholder="..."
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              onClick={handleLogin}
              disabled={loading}
              className="w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-all flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Spinner /> Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </div>
          <div className="border-t border-slate-800 pt-5">
            <p className="text-xs text-slate-500 mb-3">
              Demo accounts ÃÂ¢ÃÂÃÂ click to log in instantly:
            </p>
            <div className="space-y-4">
              {demoAccounts.map((group, gi) => (
                <div key={gi}>
                  <p className="text-xs text-slate-600 uppercase tracking-wider mb-2">
                    {group.group}
                  </p>
                  <div className="space-y-1">
                    {group.users.map((u) => (
                      <button
                        key={u.id}
                        onClick={() => onLogin(u)}
                        className="w-full flex items-center gap-3 p-2.5 rounded-xl bg-slate-800/50 hover:bg-slate-800 transition-all text-left"
                      >
                        <div className="w-7 h-7 rounded-full bg-indigo-600/50 flex items-center justify-center text-xs font-bold text-indigo-300 flex-shrink-0">
                          {u.avatar}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-white truncate">
                            {u.name}
                          </div>
                          <div className="text-xs text-slate-500 truncate">
                            {u.role.replace(/_/g, ' ')}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// MAIN APP
// ============================================================

function App() {
  const [authedUser, setAuthedUser] = useState<AuthUser | null>(null);
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [godModeSession, setGodModeSession] = useState<{
    tenant: Tenant;
    operator: AuthUser;
  } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ Supabase real data ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
  const [dbTenants, setDbTenants] = useState<DBTenant[]>([]);
  const [dbArticles, setDbArticles] = useState<DBKnowledgeArticle[]>([]);
  const [dbConversations, setDbConversations] = useState<DBConversation[]>([]);
  const [dbStats, setDbStats] = useState<{
    totalConversations: number; openConversations: number; resolvedConversations: number;
    totalArticles: number; publishedArticles: number; pendingApprovals: number; autoResolved: number;
    channelBreakdown: { chat: number; email: number; phone: number };
    sentimentBreakdown: { positive: number; neutral: number; negative: number };
  } | null>(null);

  const isDTUser =
    authedUser &&
    ['dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing'].includes(
      authedUser.role
    );
  const isTenantUser =
    authedUser &&
    ['tenant_owner', 'tenant_admin', 'tenant_manager', 'tenant_user'].includes(
      authedUser.role
    );

  const currentTenant =
    godModeSession?.tenant ||
    (authedUser?.tenantId
      ? mockTenants.find((t) => t.id === authedUser.tenantId)
      : undefined);

  const handleLogin = (u: AuthUser) => {
    setAuthedUser(u);
    if (
      ['dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing'].includes(
        u.role
      )
    ) {
      setCurrentPage('platform_home');
    } else {
      setCurrentPage('dashboard');
      setShowOnboarding(true);
    }
  };

  const handleSetPage = (p: Page) => {
    if (!authedUser) return;
    if (canAccessPage(authedUser.role, p)) setCurrentPage(p);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setAuthedUser(null as any);
    setCurrentPage('dashboard');
    setDbTenants([]);
    setDbArticles([]);
    setDbConversations([]);
    setDbStats(null);
  };

  if (!authedUser) return <LoginPage onLogin={handleLogin} />;

  const renderPage = () => {
    const commonProps = {
      user: authedUser,
      tenant: currentTenant,
      page: currentPage,
      setPage: handleSetPage,
      accentColor: currentTenant?.accentColor,
    };
    if (isDTUser)
      return (
        <PlatformConsolePage
          page={currentPage as PlatformPage}
          setPage={handleSetPage}
          user={authedUser}
        />
      );
    switch (currentPage) {
      case 'dashboard':
        return <DashboardPage {...commonProps} dbStats={dbStats} />;
      case 'agents':
        return <AgentWorkforcePage {...commonProps} />;
      case 'swarm':
        return <SwarmPage tenant={currentTenant} />;
      case 'insight':
        return <InsightEnginePage {...commonProps} />;
      case 'security':
        return <SecurityPage {...commonProps} />;
      case 'integrations':
        return <IntegrationsPage {...commonProps} />;
      case 'connectors':
        return <DataConnectorsPage {...commonProps} />;
      case 'settings':
        return <SettingsPage {...commonProps} />;
      case 'knowledge_data':
      case 'knowledge_taxonomy':
      case 'knowledge_connectors':
      case 'knowledge_files':
        return <KnowledgeDataPage {...commonProps} />;
      case 'hub_overview':
      case 'hub_articles':
      case 'hub_ingestion':
      case 'hub_training':
      case 'hub_analytics':
        return <KnowledgeHubPage dbArticles={dbArticles} {...commonProps} subPage={currentPage} />;
      case 'portal_overview':
      case 'portal_conversations':
      case 'portal_actions':
      case 'portal_approvals':
      case 'portal_tickets':
      case 'portal_settings':
        return <CustomerPortalPage {...commonProps} subPage={currentPage} />;
      default:
        return <DashboardPage {...commonProps} />;
    }
  };


  // ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ Load Supabase data on login ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
  useEffect(() => {
    let _cleanup = false;
    if (!authedUser) {
      setDbTenants([]); setDbArticles([]); setDbConversations([]); setDbStats(null);
      return () => { _cleanup = true; };
    }
    (async () => {
      try {
        const profile = await fetchMyProfile();
        if (_cleanup) return;
        const tid = (profile?.tenant_id ?? authedUser.tenantId) as string | undefined;
        if (profile?.layer === 'platform') {
          const t = await fetchTenants();
          if (!_cleanup) setDbTenants(t);
        }
        if (tid) {
          const [a, c, s] = await Promise.all([
            fetchKnowledgeArticles(tid),
            fetchConversations(tid),
            fetchDashboardStats(tid),
          ]);
          if (!_cleanup) { setDbArticles(a); setDbConversations(c); setDbStats(s); }
        }
      } catch(e) { console.error('[DT] data load:', e); }
    })();
    return () => { _cleanup = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authedUser?.id]);


  return (
    <div className="flex h-screen bg-slate-950 overflow-hidden">
      {showOnboarding && isTenantUser && (
        <OnboardingWizard
          onComplete={() => setShowOnboarding(false)}
          tenant={currentTenant}
          user={authedUser}
        />
      )}
      <Sidebar
        page={currentPage}
        setPage={handleSetPage}
        user={authedUser}
        tenant={currentTenant}
        collapsed={sidebarCollapsed}
        setCollapsed={setSidebarCollapsed}
        godModeActive={!!godModeSession}
        exitGodMode={() => setGodModeSession(null)}
        onLogout={handleLogout}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        {godModeSession && (
          <div className="bg-amber-500/10 border-b border-amber-500/30 px-6 py-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-amber-400 text-sm">!</span>
              <span className="text-xs text-amber-300">
                God Mode active viewing {godModeSession.tenant.name} as{' '}
                {godModeSession.operator.name}
              </span>
            </div>
            <button
              onClick={() => setGodModeSession(null)}
              className="text-xs text-amber-500 hover:text-amber-300 underline transition-all"
            >
              Exit God Mode
            </button>
          </div>
        )}
        {renderPage()}
      </main>
    </div>
  );
}

export default App;
