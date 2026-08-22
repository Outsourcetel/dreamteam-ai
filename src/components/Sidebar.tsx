import { useState, useEffect, useCallback } from 'react';
import type { Page } from '../types';
import { useVocabulary } from '../lib/vocabulary';
import type { Vocabulary } from '../lib/vocabulary';
import { canAccessPage } from '../lib/navAccess';
import { useAuth } from '../context/AuthContext';
import type { CompanyId } from '../data/companies';
import { listAccounts, listTickets, listInvoices, listHumanTasks, getPendingKnowledgeGapCount } from '../lib/customerApi';
import { listOpportunities } from '../lib/pipelineApi';
import { listProjects } from '../lib/onboardingApi';
import ChangePasswordModal from './ChangePasswordModal';
import { ROLE_LABELS } from '../lib/useUsers';
import type { TenantRole } from '../lib/useUsers';

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
  /** A NUMBER, never a phrase — the row already says what is counted.
   *  Exactly one nav item sets `loud`; see the note on Approvals below. */
  badge?: { count: number; loud?: boolean };
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

function buildNav(companyId: CompanyId, live: NavCounts, vocab: Vocabulary): NavSection[] {
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
        // Founder IA change 2026-07-27: KNOWLEDGE and PLAYBOOKS were whole
        // sections holding ONE link each, and Customers sat under SYSTEMS &
        // ACTIONS. All three describe the same workforce from different angles
        // — what it knows, how it works, who it serves — so they read better
        // together than as three section headers costing four lines of chrome.
        // Net: 8 sections down to 6, same destinations, nothing hidden.
        { id: 'kb', label: 'Knowledge', icon: '◫', page: 'knowledge_library', badge: live.kbGaps > 0 ? { count: live.kbGaps } : undefined },
        { id: 'playbooks', label: 'Playbook Builder', icon: '▶', page: 'systems_playbooks' },
        {
          id: 'customer',
          // Served-party noun comes from the tenant's vocabulary (industry
          // seeded, editable). At-risk count stays the badge.
          label: vocab.section_label,
          icon: '◎',
          page: 'entity_customer',
          badge: live.atRiskAccounts > 0 ? { count: live.atRiskAccounts } : undefined,
        },
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
          // The ONE loud badge in the nav. Work has stopped and is waiting on
          // a person: if anything earns a solid fill it is this.
          badge: live.humanTasks > 0 ? { count: live.humanTasks, loud: true } : undefined,
        },
        { id: 'activity', label: 'Activity Log', icon: '≡', page: 'ops_activity' },
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
        { id: 'mcp', label: 'MCP servers', icon: '🔗', page: 'systems_mcp' },
        // ⚠ The Vendors & Partners and Our People nav trees stood here behind
        // `isLiveMode ? [] : [...]`. buildNav's only call site passed
        // isLiveMode = true, so that branch rendered NOTHING since Wave 3 —
        // and the reason it was left in place, "the routes stay valid for deep
        // links", was the defect: hiding a link never closed /vendor or
        // /workforce-entity, because the router asks canAccessPage, not the
        // Sidebar. Both the nine routes and this dead block are gone as of
        // 2026-08-20; see src/types/index.ts. The `isLiveMode` parameter that
        // gated it outlived its last reader and was dropped 2026-08-22, along
        // with the `isLiveTenant` the component destructured and never used.
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
        // Quick Start is no longer its own nav item: it is a one-time task
        // that held a permanent slot, and two "set up your company"
        // destinations gave no way to tell which one you wanted. It is now
        // offered inside Company Setup, and its route stays valid for the
        // Getting Started guide's deep link.
        // ⚠ THE RE-OPENABLE HALF of the founder's ruling — "Both: offered at
        // first login, re-openable later." First login lands here once
        // (AuthContext); without a nav entry a workspace that skipped, stopped
        // or wants to revisit would have no door at all, and the one-shot
        // localStorage flag means that first landing never comes back.
        //
        // ABOVE Company Setup on purpose: this is the question we now want a
        // new customer to answer, and the wizard below it is the fallback for
        // the things the conversation does not cover (industry, vocabulary,
        // pipeline stages, branding). Retiring that wizard is Plan 4, after
        // this is proven — not today.
        { id: 'discovery_interview', label: 'Setup Interview', icon: '✦', page: 'discovery_interview' },
        // Where the interview's drafts wait to be accepted, declined or set
        // aside. A separate entry rather than only a link from the interview:
        // a customer who parked halfway needs to reach their recommendations
        // without walking back through the conversation to find them.
        { id: 'discovery_proposals', label: 'What We Recommend', icon: '✓', page: 'discovery_proposals' },
        { id: 'company_setup', label: 'Company Setup', icon: '⚙', page: 'company_setup' },
        // People was UNREACHABLE: UserManagementPage exists and App.tsx routes
        // to it, but no nav entry pointed at 'users' — so a workspace owner
        // could not invite anybody. Same defect Settings had, found the same
        // way: by someone trying to do the thing and finding no door.
        // ADMIN tier already, via navAccess ADMIN_PAGES.
        { id: 'users', label: 'People & Access', icon: '◎', page: 'users' },
        // Your OWN record, not behind the screen for administering everyone
        // else. The employee record shipped reachable only by clicking a name
        // on People & Access, so a workspace owner could not find their own.
        { id: 'my_profile', label: 'My Profile', icon: '◐', page: 'my_profile' },
        // Organisation sits next to People & Access because the two answer
        // adjacent questions: who is in this workspace, and where do they sit.
        // Without the second, every approval landed in one shared queue with
        // assigned_user_id NULL on all 318 pending items (migs 587/588).
        { id: 'organisation', label: 'Organisation', icon: '◫', page: 'organisation' },
        { id: 'settings', label: 'Settings', icon: '◈', page: 'settings' },
      ],
    },
  ];
}

export function Sidebar({ page, setPage, user, tenant, collapsed, setCollapsed, godModeActive, exitGodMode, onLogout }: SidebarProps) {
  const { activeCompany, liveTenantName } = useAuth();
  // No groups open by default — Company Data (the demoted entity
  // section) in particular starts collapsed per the DE-centered IA.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
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
  // The DE reporting line (docs/29) can open a page the role tier alone would
  // hide — e.g. an employee's relation-manager reaching its approvals queue.
  // Must be passed here as well as in handleSetPage, or the page stays
  // reachable but invisible: navigable by deep link and absent from the nav.
  const deRelations = user?.deRelations as Parameters<typeof canAccessPage>[3];
  const allowed = (p?: string) => !p || canAccessPage(role, p as Page, layer, deRelations);
  const nav = buildNav(activeCompany.id, liveCounts, vocab)
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
          className="w-8 h-8 rounded-lg bg-dt-panel text-dt-support hover:text-dt-title text-xs flex items-center justify-center"
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
          { icon: '◈', page: 'settings' as Page, label: 'Settings' },
        ]).filter(item => allowed(item.page)).map(item => (
          <button
            key={item.page}
            title={item.label}
            onClick={() => setPage(item.page)}
            className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs ${
              page === item.page
                ? 'bg-dt-accent-soft text-dt-accent-text'
                : 'bg-dt-card text-dt-muted hover:text-dt-title hover:bg-dt-panel'
            }`}
          >
            {item.icon}
          </button>
        ))}
        <div className="flex-1" />
        <a
          href="mailto:bkhan@outsourcetel.com?subject=DreamTeam%20AI%20support"
          title="Contact support"
          className="w-8 h-8 rounded-lg bg-dt-card text-dt-muted hover:text-dt-title text-xs flex items-center justify-center"
        >
          ✉
        </a>
        <button onClick={onLogout} className="w-8 h-8 rounded-lg bg-dt-card text-dt-muted hover:text-dt-title text-xs flex items-center justify-center">
          ⇥
        </button>
      </div>
    );
  }

  return (
    <div className="w-dt-sidebar bg-dt-page border-r border-dt-border flex flex-col flex-shrink-0 overflow-hidden">

      {/* Workspace identity */}
      <div className="px-3 py-2 border-b border-dt-border">
        <div className="w-full flex items-center gap-2 rounded-lg">
          <div className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold text-white flex-shrink-0 bg-dt-accent-strong">
            {(liveTenantName || activeCompany.name || 'C')[0].toUpperCase()}
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="text-[13px] font-semibold text-dt-title truncate">{liveTenantName || activeCompany.name || 'Your company'}</div>
            <div className="text-xs text-dt-ok truncate">Live workspace</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {nav.map(section => (
          <div key={section.title}>
            {section.title && (
              <div className="px-2 pt-2 pb-0.5 text-xs font-semibold tracking-wider text-dt-muted uppercase leading-none">
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
                    className={`group relative w-full flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-md text-left transition-colors leading-4 ${
                      groupActive || childActive
                        ? 'bg-dt-accent-soft text-dt-accent-text before:absolute before:left-0 before:top-1 before:bottom-1 before:w-0.5 before:rounded-full before:bg-dt-accent'
                        : 'text-dt-support hover:text-dt-body hover:bg-dt-panel'
                    }`}
                  >
                    <span className="text-[13px] flex-shrink-0 w-4 text-center" aria-hidden>{group.icon}</span>
                    <span className="text-[13px] font-medium flex-1 truncate">{group.label}</span>
                    {group.badge && (
                      <span className={`text-xs font-semibold px-1.5 rounded-full tabular-nums leading-4 ${
                        group.badge.loud
                          ? 'bg-dt-warn text-dt-page'
                          : 'bg-dt-neutral-soft text-dt-support'
                      }`}>
                        {group.badge.count}
                      </span>
                    )}
                    {hasChildren && (
                      <span className={`text-xs text-dt-faint transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden>›</span>
                    )}
                  </button>

                  {hasChildren && isOpen && (
                    <div className="ml-3 pl-3 border-l border-dt-border mb-1">
                      {group.children!.map(child => (
                        <button
                          key={child.id}
                          onClick={() => setPage(child.id)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors ${
                            isActive(child.id)
                              ? 'bg-dt-accent-soft text-dt-accent-text'
                              : 'text-dt-muted hover:text-dt-support hover:bg-dt-card'
                          }`}
                        >
                          {child.indicator?.dot && (
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: child.indicator.color }} />
                          )}
                          <span className="text-[13px] flex-1 truncate">{child.label}</span>
                          {child.indicator?.count !== undefined && (
                            <span className="text-xs font-semibold px-1.5 rounded-full bg-dt-neutral-soft text-dt-support tabular-nums leading-4">
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
      <div className="px-3 py-2 border-t border-dt-border">
        {/* Account menu — the old footer had sign-out only as an
            unlabeled ⇥ icon (founder couldn't find it) and no way to
            change a password at all. */}
        {accountMenuOpen && (
          <div className="mb-2 bg-dt-card border border-dt-border rounded-lg overflow-hidden">
            {/* Terms and privacy left the permanent footer for the same reason
                Contact support did: read once if ever, and costing 24px of a
                nav that does not fit on the founder's own screen. */}
            <div className="flex items-center gap-3 px-3 py-2 text-xs text-dt-muted border-b border-dt-border">
              <a href="/terms" className="hover:text-dt-support transition-colors">Terms</a>
              <a href="/privacy" className="hover:text-dt-support transition-colors">Privacy</a>
            </div>
            <a
              href="mailto:bkhan@outsourcetel.com?subject=DreamTeam%20AI%20support"
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] text-dt-support hover:bg-dt-panel transition-colors"
            >
              <span className="w-4 text-center flex-shrink-0" aria-hidden>✉</span> Contact support
            </a>
            <button
              onClick={() => { setShowChangePassword(true); setAccountMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] text-dt-support hover:bg-dt-panel transition-colors border-t border-dt-border"
            >
              <span className="w-4 text-center flex-shrink-0" aria-hidden>🔑</span> Change password…
            </button>
            <button
              onClick={onLogout}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-dt-support hover:bg-dt-panel hover:text-dt-danger transition-colors border-t border-dt-border"
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
            <div className="w-7 h-7 rounded-full bg-dt-accent-strong flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {user?.name?.[0] ?? 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-dt-body truncate">{user?.name}</div>
              <div className="text-xs text-dt-muted truncate">{ROLE_LABELS[user?.role as TenantRole] ?? user?.role?.replace(/_/g, ' ')}</div>
            </div>
            <span className={`text-dt-faint text-xs transition-transform ${accountMenuOpen ? 'rotate-180' : ''}`} aria-hidden>⌃</span>
          </button>
          <button onClick={() => setCollapsed(true)} className="w-6 h-6 rounded text-dt-faint hover:text-dt-support text-xs flex items-center justify-center flex-shrink-0">
            ←
          </button>
        </div>
        {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
        {godModeActive && (
          <button onClick={exitGodMode} className="mt-2 w-full text-xs text-dt-warn hover:text-dt-warn text-center">
            Exit Remote Access
          </button>
        )}
      </div>
    </div>
  );
}

export default Sidebar;
