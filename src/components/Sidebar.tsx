import React, { useState, useEffect, useCallback } from 'react';
import type { Page } from '../types';
import { useVocabulary } from '../lib/vocabulary';
import type { Vocabulary } from '../lib/vocabulary';
import { canAccessPage } from '../lib/navAccess';
import { useAuth } from '../context/AuthContext';
import type { CompanyId } from '../data/companies';
import { countPendingChatEscalations } from '../lib/chatEscalations';
import { listAccounts, listTickets, listInvoices, listHumanTasks, getPendingKnowledgeGapCount } from '../lib/customerApi';
import { listOpportunities } from '../lib/pipelineApi';
import { listProjects } from '../lib/onboardingApi';
import ChangePasswordModal from './ChangePasswordModal';

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

interface NavCounts {
  humanTasks: number;
  kbGaps: number;
  salesPipeline: number;
  onboardingActive: number;
  supportTickets: number;
  atRiskAccounts: number;
  renewalsDue: number;
}


// LIVE MODE ONLY. Real per-tenant counts, mirroring the exact same
// semantics LiveDashboard (DashboardPage.tsx) already uses for its own KPI
// tiles — the sidebar and the dashboard must never disagree with each
// other. A brand-new empty tenant correctly gets all zeros here, instead
// of the TCP demo company's static seed numbers.
export async function fetchLiveNavCounts(): Promise<NavCounts> {
  try {
    const [accounts, tickets, invoices, tasks, opportunities, projects, kbGaps] = await Promise.all([
      listAccounts(), listTickets(), listInvoices(), listHumanTasks(),
      listOpportunities(), listProjects(), getPendingKnowledgeGapCount(),
    ]);
    return {
      salesPipeline: opportunities.filter(o => o.stage !== 'won' && o.stage !== 'lost').length,
      onboardingActive: projects.filter(p => p.status === 'active').length,
      supportTickets: tickets.filter(t => t.status === 'open' || t.status === 'escalated').length,
      atRiskAccounts: accounts.filter(a => a.status === 'at_risk' || a.health_score < 45).length,
      renewalsDue: invoices.filter(i => i.status !== 'paid').length,
      humanTasks: tasks.filter(t => t.status === 'pending').length,
      kbGaps,
    };
  } catch (err) {
    console.error('fetchLiveNavCounts:', err);
    return { humanTasks: 0, kbGaps: 0, salesPipeline: 0, onboardingActive: 0, supportTickets: 0, atRiskAccounts: 0, renewalsDue: 0 };
  }
}

function buildNav(companyId: CompanyId, live: NavCounts, isLiveMode: boolean, vocab: Vocabulary): NavSection[] {
  // DE-CENTERED STRUCTURE (founder-approved 2026-07-11, mockup artifact
  // f43050e7): 8 sections, the Digital Employee at the center. A system
  // of record organizes around the data; DreamTeam organizes around the
  // employee — what each DE knows (Knowledge), what it can touch
  // (Connectors), how it works (Playbooks), who supervises it (My Tasks
  // + Governance). "Who we serve" is demoted to Company Data: the
  // business substrate the DEs work on top of, never the product.
  return [
    {
      title: '',
      groups: [
        {
          id: 'dashboard',
          label: 'Command Centre',
          icon: '⬡',
          page: 'dashboard',
          // Insights is the Command Centre's analysis drill-down (north-star IA).
          children: [
            { id: 'intelligence_insights', label: 'Insights' },
          ],
        },
      ],
    },
    {
      title: 'DIGITAL EMPLOYEES',
      groups: [
        {
          // One destination — Roster/At Work/Performance/Proving Ground/
          // Self-Learning are tabs inside the Workforce hub (north-star IA).
          id: 'des',
          label: 'Workforce',
          icon: '⚡',
          page: 'workforce_des',
        },
        // One destination — Inbox/Overview/Rules are tabs inside the Support hub.
        { id: 'support', label: 'Support', icon: '🎧', page: 'support_inbox' },
        { id: 'browser_operator', label: 'Browser Operator', icon: '🌐', page: 'browser_operator' },
        // Wave 4: the standalone Specialist Desk is retired. Specialists are
        // digital employees now — they live in the Roster, and their tools
        // (sources, media, consult, scribe, evidence) are the "Specialist
        // Tools" tab on their profile. The /specialist/* routes remain valid
        // for deep links during the transition.
      ],
    },
    {
      title: 'MY TASKS',
      groups: [
        {
          id: 'human_tasks',
          label: 'Approvals & Drafts',
          icon: '✋',
          page: 'ops_human_tasks',
          badge: live.humanTasks > 0 ? { text: `${live.humanTasks} pending`, color: '#f59e0b' } : undefined,
        },
        { id: 'activity', label: 'Activity Log', icon: '≡', page: 'ops_activity' },
      ],
    },
    {
      title: 'KNOWLEDGE',
      groups: [
        // One destination — Library/Sources/Gaps/Quality live as tabs inside
        // the Knowledge hub (north-star IA consolidation).
        { id: 'kb', label: 'Knowledge', icon: '◫', page: 'knowledge_library', badge: live.kbGaps > 0 ? { text: `${live.kbGaps} gaps`, color: '#f59e0b' } : undefined },
      ],
    },
    {
      title: 'PLAYBOOKS',
      groups: [
        { id: 'playbooks', label: 'Playbook Builder', icon: '▶', page: 'systems_playbooks' },
      ],
    },
    {
      // Founder brief: five must-have sections (Digital Employees,
      // Playbooks, Systems & Actions, Governance, Knowledge) plus at most
      // two more. CONNECTORS and COMPANY DATA were separate top-level
      // sections; they merge here because the company-data pages ARE views
      // over the systems these connectors reach — keeping them apart cost a
      // whole section for one link. Remaining extras: MY TASKS and SETUP.
      title: 'SYSTEMS & ACTIONS',
      groups: [
        { id: 'connectors', label: 'Connected systems', icon: '⟷', page: 'systems_connectors' },
        {
          id: 'customer',
          // Wave 4: the served-party noun and lifecycle labels come from
          // the tenant's vocabulary (industry-seeded, editable). Demo
          // tenants resolve to the SaaS defaults, so nothing changes there.
          // Founder restructure 2026-07-22: ONE Customers destination (the
          // hub carries the journey as tabs) — the 7-child mini-CRM tree
          // read as a product-story problem. At-risk count stays the badge.
          label: vocab.section_label,
          icon: '◎',
          page: 'entity_customer',
          badge: live.atRiskAccounts > 0 ? { text: `${live.atRiskAccounts} at risk`, color: '#ef4444' } : undefined,
        },
        // Wave 3: Vendors & Our People are fully NotYetAvailable-gated for
        // live tenants (descoped 2026-07-09) — hiding dead nav sections
        // from live workspaces instead of advertising empty pages. The
        // routes stay valid for deep links; demo keeps the full tree.
        ...(isLiveMode ? [] : [
          {
            id: 'vendor',
            label: 'Vendors & Partners',
            icon: '◈',
            page: 'entity_vendor' as Page,
            children: [
              { id: 'entity_vendor_sourcing' as Page, label: 'Sourcing' },
              { id: 'entity_vendor_contracts' as Page, label: 'Contracts' },
              { id: 'entity_vendor_management' as Page, label: 'Relationship Mgmt' },
            ],
          },
          {
            id: 'workforce_entity',
            label: 'Our People',
            icon: '◉',
            page: 'entity_workforce' as Page,
            children: [
              { id: 'entity_workforce_talent' as Page, label: 'Talent Acquisition' },
              { id: 'entity_workforce_onboarding' as Page, label: 'Onboarding' },
              { id: 'entity_workforce_development' as Page, label: 'Performance & Dev' },
              { id: 'entity_workforce_payroll' as Page, label: 'Payroll & Benefits' },
            ],
          },
        ]),
      ],
    },
    {
      title: 'GOVERNANCE',
      groups: [
        // One destination — Compliance/Audit/Security/Data/Identity/Trust are
        // tabs inside the Governance hub (north-star IA).
        { id: 'governance', label: 'Governance', icon: '⛨', page: 'gov_compliance' },
      ],
    },
    {
      title: 'SETUP',
      groups: [
        { id: 'onboarding_architect', label: 'Quick Start', icon: '✦', page: 'onboarding_architect' },
        { id: 'company_setup', label: 'Company Setup', icon: '⚙', page: 'company_setup' },
      ],
    },
  ];
}

export function Sidebar({ page, setPage, user, tenant, collapsed, setCollapsed, godModeActive, exitGodMode, onLogout }: SidebarProps) {
  const { activeCompanyId, setActiveCompanyId, activeCompany, isLiveTenant, liveTenantName } = useAuth();
  // No groups open by default — Company Data (the demoted entity
  // section) in particular starts collapsed per the DE-centered IA.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showCompanyPicker, setShowCompanyPicker] = useState(false);
  const [liveCounts, setLiveCounts] = useState<NavCounts>({
    humanTasks: 0, kbGaps: 0, salesPipeline: 0, onboardingActive: 0, supportTickets: 0, atRiskAccounts: 0, renewalsDue: 0,
  });

  const refreshCounts = useCallback(() => {
    let cancelled = false;
    fetchLiveNavCounts().then((counts) => { if (!cancelled) setLiveCounts(counts); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const cleanup = refreshCounts();
    window.addEventListener('storage', refreshCounts);
    window.addEventListener('dt-state-changed', refreshCounts);
    return () => {
      cleanup?.();
      window.removeEventListener('storage', refreshCounts);
      window.removeEventListener('dt-state-changed', refreshCounts);
    };
  }, [refreshCounts]);

  const vocab = useVocabulary();
  // Wave 5 — RBAC nav filtering: hide pages the user's role can't open
  // (canAccessPage tiers; handleSetPage already blocks them server of
  // navigation, this stops advertising dead links).
  const role = (user?.role ?? 'tenant_user') as Parameters<typeof canAccessPage>[0];
  const layer = user?.layer as Parameters<typeof canAccessPage>[2];
  const allowed = (p?: string) => !p || canAccessPage(role, p as Page, layer);
  // Platform operators (Outsourcetel) — they may explore the demo companies
  // for sales; real customers must NEVER see other companies in their nav.
  const isDtUser = layer === 'platform' || ['dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing'].includes(role as string);
  // Show the demo-company switcher only to demo/dev logins or platform
  // operators — never inside a paying customer's live workspace.
  const showDemoCompanies = !isLiveTenant || isDtUser;
  const nav = buildNav(activeCompany.id, liveCounts, true, vocab)
    .map(section => ({
      ...section,
      groups: section.groups
        .map(g => ({
          ...g,
          children: g.children?.filter(c => allowed(c.id as string)),
        }))
        .filter(g => allowed(g.page as string | undefined) && (g.page || (g.children && g.children.length > 0))),
    }))
    .filter(section => section.groups.length > 0);

  const toggleGroup = (id: string) => {
    setOpenGroups(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const isActive = (p: Page) => page === p
    // Hub tabs are distinct Page keys — keep the single nav entry lit on any of them.
    || (p === 'knowledge_library' && String(page).startsWith('knowledge_'))
    || (p === 'support_inbox' && String(page).startsWith('support_'))
    || (p === 'workforce_des' && ['ops_de_activity', 'intelligence_performance', 'intelligence_evals', 'intelligence_learning'].includes(String(page)))
    || (p === 'gov_compliance' && String(page).startsWith('gov_'));
  const isChildActive = (children?: SubItem[]) => children?.some(c => c.id === page);

  if (collapsed) {
    return (
      <div className="w-14 bg-dt-page border-r border-dt-border flex flex-col items-center py-4 gap-3 flex-shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          className="w-8 h-8 rounded-lg bg-dt-panel text-dt-support hover:text-white text-xs flex items-center justify-center"
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
        <div className="w-px h-4 bg-dt-panel" />
        {([
          { icon: '⬡', page: 'dashboard' as Page, label: 'Command Centre' },
          { icon: '⚡', page: 'workforce_des' as Page, label: 'Digital Employees' },
          { icon: '✋', page: 'ops_human_tasks' as Page, label: 'My Tasks' },
          { icon: '◫', page: 'knowledge_library' as Page, label: 'Knowledge' },
          { icon: '▶', page: 'systems_playbooks' as Page, label: 'Playbooks' },
          { icon: '⟷', page: 'systems_connectors' as Page, label: 'Connectors' },
          { icon: '◎', page: 'entity_customer' as Page, label: 'Company Data' },
          { icon: '⚑', page: 'gov_compliance' as Page, label: 'Governance' },
        ]).map(item => (
          <button
            key={item.page}
            title={item.label}
            onClick={() => setPage(item.page)}
            className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs ${
              page === item.page
                ? 'bg-indigo-500/20 text-indigo-300'
                : 'bg-dt-card text-dt-muted hover:text-white hover:bg-dt-panel'
            }`}
          >
            {item.icon}
          </button>
        ))}
        <div className="flex-1" />
        <a
          href="mailto:bkhan@outsourcetel.com?subject=DreamTeam%20AI%20support"
          title="Contact support"
          className="w-8 h-8 rounded-lg bg-dt-card text-dt-muted hover:text-white text-xs flex items-center justify-center"
        >
          ✉
        </a>
        <button onClick={onLogout} className="w-8 h-8 rounded-lg bg-dt-card text-dt-muted hover:text-white text-xs flex items-center justify-center">
          ⇥
        </button>
      </div>
    );
  }

  return (
    <div className="w-60 bg-dt-page border-r border-dt-border flex flex-col flex-shrink-0 overflow-hidden">

      {/* Company selector */}
      <div className="p-3 border-b border-dt-border">
        <button
          onClick={() => setShowCompanyPicker(!showCompanyPicker)}
          className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-dt-panel transition-colors group"
        >
          {isLiveTenant && !false ? (
            <>
              <div className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold text-white flex-shrink-0 bg-indigo-600">
                {(liveTenantName || 'C')[0].toUpperCase()}
              </div>
              <div className="flex-1 text-left min-w-0">
                <div className="text-xs font-semibold text-dt-title truncate">{liveTenantName || 'Your company'}</div>
                <div className="text-[10px] text-emerald-400 truncate">Live workspace</div>
              </div>
            </>
          ) : (
            <>
              <div className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold text-white flex-shrink-0" style={{ background: activeCompany.badgeColor }}>
                {activeCompany.badge}
              </div>
              <div className="flex-1 text-left min-w-0">
                <div className="text-xs font-semibold text-dt-title truncate">{activeCompany.name}</div>
                <div className="text-[10px] text-dt-muted truncate">{isLiveTenant ? 'Demo company' : activeCompany.industry}</div>
              </div>
            </>
          )}
          <span className="text-dt-faint text-xs group-hover:text-dt-support">⌄</span>
        </button>

        {showCompanyPicker && (
          <div className="mt-1 bg-dt-card rounded-lg border border-dt-border-strong overflow-hidden">
            {isLiveTenant && (
              <>
                <button
                  onClick={() => { setShowCompanyPicker(false); }}
                  className={`w-full flex items-center gap-2 p-2 text-left hover:bg-dt-panel transition-colors ${!false ? 'bg-dt-panel' : ''}`}
                >
                  <div className="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center text-[10px] font-bold text-white">
                    {(liveTenantName || 'C')[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="text-xs font-medium text-dt-body">{liveTenantName || 'Your company'}</div>
                    <div className="text-[10px] text-emerald-400">Live workspace</div>
                  </div>
                  {!false && <span className="ml-auto text-indigo-400 text-xs">✓</span>}
                </button>
                {showDemoCompanies && (
                  <div className="px-2 pt-2 pb-1 text-[9px] font-bold tracking-widest text-dt-faint uppercase border-t border-dt-border-strong">
                    Demo companies
                  </div>
                )}
              </>
            )}
            {/* Platform operator inside a demo: the way back to the console
                (mirrors the App-level false escape). */}
            {isDtUser && false && (
              <button
                onClick={() => { setShowCompanyPicker(false); }}
                className="w-full flex items-center gap-2 p-2 text-left hover:bg-dt-panel transition-colors border-b border-dt-border-strong"
              >
                <span className="w-7 h-7 rounded-md flex items-center justify-center text-xs bg-dt-panel text-dt-support flex-shrink-0">←</span>
                <span className="text-xs text-dt-support">Back to Platform Console</span>
              </button>
            )}
            <button
              onClick={() => { setPage('company_setup'); setShowCompanyPicker(false); }}
              className="w-full flex items-center gap-2 p-2 text-left hover:bg-dt-panel border-t border-dt-border-strong"
            >
              <div className="w-6 h-6 rounded bg-slate-600 flex items-center justify-center text-xs text-dt-support">+</div>
              <span className="text-xs text-dt-support">Add company</span>
            </button>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {nav.map(section => (
          <div key={section.title} className="mb-1">
            {section.title && (
              <div className="px-2 pt-3 pb-1 text-[9px] font-bold tracking-widest text-dt-faint uppercase">
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
                        : 'text-dt-support hover:text-dt-body hover:bg-dt-panel'
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
                      <span className={`text-[10px] text-dt-faint transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
                    )}
                  </button>

                  {hasChildren && isOpen && (
                    <div className="ml-3 pl-3 border-l border-dt-border mb-1">
                      {group.children!.map(child => (
                        <button
                          key={child.id}
                          onClick={() => setPage(child.id)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors mb-0.5 ${
                            isActive(child.id)
                              ? 'bg-indigo-500/10 text-indigo-300'
                              : 'text-dt-muted hover:text-dt-support hover:bg-dt-card'
                          }`}
                        >
                          {child.indicator?.dot && (
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: child.indicator.color }} />
                          )}
                          <span className="text-xs flex-1 truncate">{child.label}</span>
                          {child.indicator?.count !== undefined && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-dt-panel" style={{ color: child.indicator.color }}>
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
      <div className="p-3 border-t border-dt-border">
        <a
          href="mailto:bkhan@outsourcetel.com?subject=DreamTeam%20AI%20support"
          className="flex items-center gap-2 px-2 py-1.5 mb-2 rounded-md text-dt-muted hover:text-dt-support hover:bg-dt-card transition-colors text-xs"
        >
          <span className="w-4 text-center flex-shrink-0">✉</span>
          <span className="truncate">Contact support</span>
        </a>
        {/* Account menu — the old footer had sign-out only as an
            unlabeled ⇥ icon (founder couldn't find it) and no way to
            change a password at all. */}
        {accountMenuOpen && (
          <div className="mb-2 bg-dt-card border border-dt-border rounded-lg overflow-hidden">
            <button
              onClick={() => { setShowChangePassword(true); setAccountMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-dt-support hover:bg-dt-panel transition-colors"
            >
              <span className="w-4 text-center flex-shrink-0">🔑</span> Change password…
            </button>
            <button
              onClick={onLogout}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-dt-support hover:bg-dt-panel hover:text-red-300 transition-colors border-t border-dt-border"
            >
              <span className="w-4 text-center flex-shrink-0">⇥</span> Sign out
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAccountMenuOpen(v => !v)}
            className="flex items-center gap-2 flex-1 min-w-0 text-left rounded-md px-1 py-0.5 hover:bg-dt-card transition-colors"
            title="Account menu"
          >
            <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {user?.name?.[0] ?? 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-dt-body truncate">{user?.name}</div>
              <div className="text-[10px] text-dt-muted truncate">{user?.role?.replace(/_/g, ' ')}</div>
            </div>
            <span className={`text-dt-faint text-[10px] transition-transform ${accountMenuOpen ? 'rotate-180' : ''}`}>⌃</span>
          </button>
          <button onClick={() => setCollapsed(true)} className="w-6 h-6 rounded text-dt-faint hover:text-dt-support text-xs flex items-center justify-center flex-shrink-0">
            ←
          </button>
        </div>
        {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
        {godModeActive && (
          <button onClick={exitGodMode} className="mt-2 w-full text-[10px] text-amber-500 hover:text-amber-300 text-center">
            Exit Remote Access
          </button>
        )}
        <div className="flex items-center justify-center gap-3 mt-2 text-[10px] text-dt-faint">
          <a href="/terms" className="hover:text-dt-support transition-colors">Terms</a>
          <a href="/privacy" className="hover:text-dt-support transition-colors">Privacy</a>
        </div>
      </div>
    </div>
  );
}

export default Sidebar;
