import React, { useState, useEffect, useCallback } from 'react';
import type { Page } from '../types';
import { useAuth } from '../context/AuthContext';
import { COMPANIES, COMPANY_SUMMARY } from '../data/companies';
import type { CompanyId } from '../data/companies';
import { countPendingChatEscalations } from '../lib/chatEscalations';

interface SidebarProps {
  page: Page;
  setPage: (page: Page) => void;
  user: any;
  tenant: any;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  godModeActive?: boolean;
  exitGodMode?: () => void;
  onLogout: () => void;
}

// ── Nav structure ────────────────────────────────────────────────
interface SubItem {
  id: Page;
  label: string;
  indicator?: { count?: number; color?: string; dot?: boolean };
}

interface NavGroup {
  id: string;
  label: string;
  icon: string;
  page?: Page;           // if clicking the group itself navigates
  children?: SubItem[];
  badge?: { text: string; color: string };
  defaultOpen?: boolean;
}

interface NavSection {
  title: string;
  groups: NavGroup[];
}

// Live badge counts: read the same localStorage state the pages persist,
// falling back to the static companies.ts values when nothing is stored.
export function computeLiveCounts(companyId: CompanyId): { humanTasks: number; kbGaps: number } {
  const s = COMPANY_SUMMARY[companyId];
  let humanTasks = s.humanTasks;
  let kbGaps = s.kbGaps;
  try {
    const stored = localStorage.getItem(`dt_ops_tasks_${companyId}`);
    if (stored) {
      // Stored shape: Record<taskId, decidedStatus> — one entry per seed-pending task decided.
      humanTasks = Math.max(0, s.humanTasks - Object.keys(JSON.parse(stored)).length);
    }
  } catch { /* fall back to static */ }
  // Escalations raised from the DE chat dock count as pending human tasks too.
  humanTasks += countPendingChatEscalations(companyId);
  try {
    const stored = localStorage.getItem(`dt_kb_gaps_${companyId}`);
    if (stored) {
      // Stored shape: Record<gapId, GapStatus> overrides; approved/retrained close a gap.
      const overrides = JSON.parse(stored) as Record<string, string>;
      const closed = Object.values(overrides).filter(v => v === 'approved' || v === 'retrained').length;
      kbGaps = Math.max(0, s.kbGaps - closed);
    }
  } catch { /* fall back to static */ }
  return { humanTasks, kbGaps };
}

function buildNav(companyId: CompanyId, live: { humanTasks: number; kbGaps: number }): NavSection[] {
  const isTCP = companyId === 'tcp';
  const s = COMPANY_SUMMARY[companyId];

  return [
    {
      title: '',
      groups: [
        {
          id: 'dashboard',
          label: 'Command Centre',
          icon: '⬡',
          page: 'dashboard',
        },
      ],
    },
    {
      title: 'ENTITIES',
      groups: [
        {
          id: 'customer',
          label: 'Customer',
          icon: '◎',
          page: 'entity_customer',
          defaultOpen: true,
          children: [
            { id: 'entity_customer_bd', label: 'Business Development', indicator: { dot: true, color: '#6366f1' } },
            { id: 'entity_customer_sales', label: 'Sales', indicator: s.salesPipeline !== undefined ? { count: s.salesPipeline, color: '#6366f1' } : undefined },
            { id: 'entity_customer_onboarding', label: 'Onboarding', indicator: s.onboardingActive !== undefined ? { count: s.onboardingActive, color: '#f59e0b' } : undefined },
            { id: 'entity_customer_support', label: 'Support', indicator: s.supportTickets !== undefined ? { count: s.supportTickets, color: '#22c55e' } : undefined },
            { id: 'entity_customer_success', label: 'Customer Success', indicator: s.atRiskAccounts !== undefined ? { count: s.atRiskAccounts, color: '#ef4444' } : undefined },
            { id: 'entity_customer_renewal', label: 'Renewal & Expansion', indicator: s.renewalsDue !== undefined ? { count: s.renewalsDue, color: '#f59e0b' } : undefined },
          ],
        },
        {
          id: 'vendor',
          label: 'Vendors & Partners',
          icon: '◈',
          page: 'entity_vendor',
          children: [
            { id: 'entity_vendor_sourcing', label: 'Sourcing' },
            { id: 'entity_vendor_contracts', label: 'Contracts' },
            { id: 'entity_vendor_management', label: 'Relationship Mgmt' },
          ],
        },
        {
          id: 'workforce_entity',
          label: 'Workforce',
          icon: '◉',
          page: 'entity_workforce',
          children: [
            { id: 'entity_workforce_talent', label: 'Talent Acquisition' },
            { id: 'entity_workforce_onboarding', label: 'Onboarding' },
            { id: 'entity_workforce_development', label: 'Performance & Dev' },
            { id: 'entity_workforce_payroll', label: 'Payroll & Benefits' },
          ],
        },
      ],
    },
    {
      title: 'OUTCOMES',
      groups: [
        { id: 'revenue', label: 'Revenue & Growth', icon: '↑', page: 'outcome_revenue' },
        {
          id: 'delivery',
          label: isTCP ? 'Product & Engineering' : 'Practice Delivery',
          icon: '◧',
          page: 'outcome_delivery',
        },
        { id: 'financial', label: 'Financial Health', icon: '$', page: 'outcome_financial' },
        {
          id: 'risk',
          label: 'Risk Posture',
          icon: '◬',
          page: 'outcome_risk',
          badge: s.alerts > 0 ? { text: `${s.alerts} alerts`, color: '#ef4444' } : undefined,
        },
      ],
    },
    {
      title: 'DIGITAL WORKFORCE',
      groups: [
        {
          id: 'des',
          label: 'Digital Employees',
          icon: '⚡',
          page: 'workforce_des',
          badge: { text: `${s.desActive} active`, color: '#22c55e' },
        },
      ],
    },
    {
      title: 'SPECIALISTS',
      groups: [
        {
          id: 'specialist_desk',
          label: 'Specialist Desk',
          icon: '◆',
          children: [
            { id: 'specialist_technical', label: 'Technical' },
            { id: 'specialist_legal', label: 'Legal' },
            { id: 'specialist_finance_deep', label: 'Finance', indicator: !isTCP ? { dot: true, color: '#14b8a6' } : undefined },
            { id: 'specialist_people', label: 'People' },
          ],
        },
      ],
    },
    {
      title: 'KNOWLEDGE',
      groups: [
        { id: 'kb_library', label: 'Library', icon: '◫', page: 'knowledge_library' },
        { id: 'kb_ingestion', label: 'Ingestion & Sources', icon: '↓', page: 'knowledge_ingestion' },
        { id: 'kb_gaps', label: 'Gap Detection', icon: '△', page: 'knowledge_gaps', badge: live.kbGaps > 0 ? { text: `${live.kbGaps} gaps`, color: '#f59e0b' } : undefined },
        { id: 'kb_quality', label: 'Quality & Coverage', icon: '✓', page: 'knowledge_quality' },
      ],
    },
    {
      title: 'SYSTEMS',
      groups: [
        { id: 'connectors', label: 'Connectors', icon: '⟷', page: 'systems_connectors' },
        { id: 'playbooks', label: 'Playbooks', icon: '▶', page: 'systems_playbooks' },
      ],
    },
    {
      title: 'OPERATIONS',
      groups: [
        {
          id: 'human_tasks',
          label: 'Human Tasks',
          icon: '✋',
          page: 'ops_human_tasks',
          badge: live.humanTasks > 0 ? { text: `${live.humanTasks} pending`, color: '#f59e0b' } : undefined,
        },
        { id: 'activity', label: 'Activity Log', icon: '≡', page: 'ops_activity' },
      ],
    },
    {
      title: 'INTELLIGENCE',
      groups: [
        { id: 'performance', label: 'Performance', icon: '◔', page: 'intelligence_performance' },
        { id: 'self_learning', label: 'Self-Learning', icon: '↻', page: 'intelligence_learning' },
        { id: 'insights', label: 'Insights', icon: '✦', page: 'intelligence_insights' },
      ],
    },
    {
      title: 'GOVERNANCE',
      groups: [
        { id: 'compliance', label: 'Compliance & Guardrails', icon: '⚑', page: 'gov_compliance' },
        { id: 'audit', label: 'Audit Trail', icon: '▤', page: 'gov_audit' },
        { id: 'security', label: 'Security & Access', icon: '⛨', page: 'gov_security' },
      ],
    },
    {
      title: 'SETUP',
      groups: [
        { id: 'company_setup', label: 'Company Setup', icon: '⚙', page: 'company_setup' },
      ],
    },
  ];
}

export function Sidebar({ page, setPage, user, tenant, collapsed, setCollapsed, godModeActive, exitGodMode, onLogout }: SidebarProps) {
  const { activeCompanyId, setActiveCompanyId, activeCompany } = useAuth();
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['customer']));
  const [showCompanyPicker, setShowCompanyPicker] = useState(false);
  const [liveCounts, setLiveCounts] = useState(() => computeLiveCounts(activeCompany.id));

  const refreshCounts = useCallback(() => {
    setLiveCounts(computeLiveCounts(activeCompanyId));
  }, [activeCompanyId]);

  useEffect(() => {
    refreshCounts();
    window.addEventListener('storage', refreshCounts);
    window.addEventListener('dt-state-changed', refreshCounts);
    return () => {
      window.removeEventListener('storage', refreshCounts);
      window.removeEventListener('dt-state-changed', refreshCounts);
    };
  }, [refreshCounts]);

  const nav = buildNav(activeCompany.id, liveCounts);

  const toggleGroup = (id: string) => {
    setOpenGroups(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const isActive = (p: Page) => page === p;
  const isChildActive = (children?: SubItem[]) => children?.some(c => c.id === page);

  if (collapsed) {
    return (
      <div className="w-14 bg-slate-950 border-r border-slate-800/50 flex flex-col items-center py-4 gap-3 flex-shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          className="w-8 h-8 rounded-lg bg-slate-800 text-slate-400 hover:text-white text-xs flex items-center justify-center"
        >
          →
        </button>
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white cursor-pointer"
          style={{ background: activeCompany.badgeColor }}
          onClick={() => setCollapsed(false)}
        >
          {activeCompany.badge}
        </div>
        <div className="w-px h-4 bg-slate-800" />
        {([
          { icon: '⬡', page: 'dashboard' as Page, label: 'Command Centre' },
          { icon: '◎', page: 'entity_customer' as Page, label: 'Customer' },
          { icon: '⚡', page: 'workforce_des' as Page, label: 'Digital Employees' },
          { icon: '◫', page: 'knowledge_library' as Page, label: 'Knowledge Library' },
          { icon: '⟷', page: 'systems_connectors' as Page, label: 'Connectors' },
          { icon: '✋', page: 'ops_human_tasks' as Page, label: 'Human Tasks' },
          { icon: '◔', page: 'intelligence_performance' as Page, label: 'Performance' },
          { icon: '⚑', page: 'gov_compliance' as Page, label: 'Compliance & Guardrails' },
        ]).map(item => (
          <button
            key={item.page}
            title={item.label}
            onClick={() => setPage(item.page)}
            className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs ${
              page === item.page
                ? 'bg-indigo-500/20 text-indigo-300'
                : 'bg-slate-900 text-slate-500 hover:text-white hover:bg-slate-800'
            }`}
          >
            {item.icon}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={onLogout} className="w-8 h-8 rounded-lg bg-slate-900 text-slate-500 hover:text-white text-xs flex items-center justify-center">
          ⇥
        </button>
      </div>
    );
  }

  return (
    <div className="w-60 bg-slate-950 border-r border-slate-800/50 flex flex-col flex-shrink-0 overflow-hidden">

      {/* Company selector */}
      <div className="p-3 border-b border-slate-800/50">
        <button
          onClick={() => setShowCompanyPicker(!showCompanyPicker)}
          className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-slate-900 transition-colors group"
        >
          <div className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold text-white flex-shrink-0" style={{ background: activeCompany.badgeColor }}>
            {activeCompany.badge}
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="text-xs font-semibold text-slate-100 truncate">{activeCompany.name}</div>
            <div className="text-[10px] text-slate-500 truncate">{activeCompany.industry}</div>
          </div>
          <span className="text-slate-600 text-xs group-hover:text-slate-400">⌄</span>
        </button>

        {showCompanyPicker && (
          <div className="mt-1 bg-slate-900 rounded-lg border border-slate-700/50 overflow-hidden">
            {COMPANIES.map((c) => (
              <button
                key={c.id}
                onClick={() => { setActiveCompanyId(c.id); setShowCompanyPicker(false); }}
                className={`w-full flex items-center gap-2 p-2 text-left hover:bg-slate-800 transition-colors ${c.id === activeCompanyId ? 'bg-slate-800/50' : ''}`}
              >
                <div className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold text-white" style={{ background: c.badgeColor }}>
                  {c.badge}
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-200">{c.name}</div>
                  <div className="text-[10px] text-slate-500">{c.activeDEs} DEs active</div>
                </div>
                {c.id === activeCompanyId && <span className="ml-auto text-indigo-400 text-xs">✓</span>}
              </button>
            ))}
            <button
              onClick={() => { setPage('company_setup'); setShowCompanyPicker(false); }}
              className="w-full flex items-center gap-2 p-2 text-left hover:bg-slate-800 border-t border-slate-700/50"
            >
              <div className="w-6 h-6 rounded bg-slate-700 flex items-center justify-center text-xs text-slate-400">+</div>
              <span className="text-xs text-slate-400">Add company</span>
            </button>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {nav.map(section => (
          <div key={section.title} className="mb-1">
            {section.title && (
              <div className="px-2 pt-3 pb-1 text-[9px] font-bold tracking-widest text-slate-600 uppercase">
                {section.title}
              </div>
            )}
            {section.groups.map(group => {
              const hasChildren = group.children && group.children.length > 0;
              const isOpen = openGroups.has(group.id) || isChildActive(group.children);
              const groupActive = group.page ? isActive(group.page) : false;
              const childActive = isChildActive(group.children);

              return (
                <div key={group.id}>
                  <button
                    onClick={() => {
                      if (hasChildren) {
                        toggleGroup(group.id);
                        if (group.page) setPage(group.page);
                      } else if (group.page) {
                        setPage(group.page);
                      }
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors mb-0.5 ${
                      groupActive || childActive
                        ? 'bg-indigo-500/10 text-indigo-300'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                    }`}
                  >
                    <span className="text-[13px] flex-shrink-0 w-4 text-center">{group.icon}</span>
                    <span className="text-xs font-medium flex-1 truncate">{group.label}</span>
                    {group.badge && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full" style={{ color: group.badge.color, background: group.badge.color + '20' }}>
                        {group.badge.text}
                      </span>
                    )}
                    {hasChildren && (
                      <span className={`text-[10px] text-slate-600 transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
                    )}
                  </button>

                  {hasChildren && isOpen && (
                    <div className="ml-3 pl-3 border-l border-slate-800 mb-1">
                      {group.children!.map(child => (
                        <button
                          key={child.id}
                          onClick={() => setPage(child.id)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors mb-0.5 ${
                            isActive(child.id)
                              ? 'bg-indigo-500/10 text-indigo-300'
                              : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900/50'
                          }`}
                        >
                          {child.indicator?.dot && (
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: child.indicator.color }} />
                          )}
                          <span className="text-xs flex-1 truncate">{child.label}</span>
                          {child.indicator?.count !== undefined && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-800" style={{ color: child.indicator.color }}>
                              {child.indicator.count}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User footer */}
      <div className="p-3 border-t border-slate-800/50">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
            {user?.name?.[0] ?? 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-slate-200 truncate">{user?.name}</div>
            <div className="text-[10px] text-slate-500 truncate">{user?.role?.replace(/_/g, ' ')}</div>
          </div>
          <div className="flex gap-1">
            <button onClick={() => setCollapsed(true)} className="w-6 h-6 rounded text-slate-600 hover:text-slate-300 text-xs flex items-center justify-center">
              ←
            </button>
            <button onClick={onLogout} className="w-6 h-6 rounded text-slate-600 hover:text-red-400 text-xs flex items-center justify-center">
              ⇥
            </button>
          </div>
        </div>
        {godModeActive && (
          <button onClick={exitGodMode} className="mt-2 w-full text-[10px] text-amber-500 hover:text-amber-300 text-center">
            Exit support session
          </button>
        )}
      </div>
    </div>
  );
}

export default Sidebar;
