import React, { useState, useEffect, useCallback } from 'react';
import type { Page } from '../types';
import { useVocabulary } from '../lib/vocabulary';
import type { Vocabulary } from '../lib/vocabulary';
import { canAccessPage } from '../lib/navAccess';
import { useAuth } from '../context/AuthContext';
import { COMPANIES, COMPANY_SUMMARY } from '../data/companies';
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

// DEMO MODE ONLY. Live badge counts: read the same localStorage state the
// demo pages persist, falling back to the static companies.ts seed values
// when nothing is stored. Live tenants never call this — see
// fetchLiveNavCounts below, which reads real per-tenant data instead.
export function computeLiveCounts(companyId: CompanyId): NavCounts {
  // COMPANY_SUMMARY has been EMPTY since the demo-company purge (69605ea) —
  // dereferencing the missing row crashed every tenant login into the error
  // boundary (2026-07-20 outage). All-zero fallback keeps the sidebar alive.
  const s = COMPANY_SUMMARY[companyId] ?? {
    desActive: 0, desTotal: 0, humanTasks: 0, aiResolution: 0, kbGaps: 0, alerts: 0,
  };
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
  return {
    humanTasks, kbGaps,
    salesPipeline: s.salesPipeline ?? 0,
    onboardingActive: s.onboardingActive ?? 0,
    supportTickets: s.supportTickets ?? 0,
    atRiskAccounts: s.atRiskAccounts ?? 0,
    renewalsDue: s.renewalsDue ?? 0,
  };
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
  // CompanyId keys DEMO content only (Wave 1.3): live tenants get one
  // neutral label set and never see demo-company badges or branching.
  const isTCP = companyId === 'tcp';
  const s = COMPANY_SUMMARY[companyId];

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
        },
      ],
    },
    {
      title: 'DIGITAL EMPLOYEES',
      groups: [
        {
          id: 'des',
          label: 'Roster',
          icon: '⚡',
          page: 'workforce_des',
          // Demo-only badge: NavCounts has no real DE/human headcount, so
          // live tenants get NO badge here rather than a demo company's.
          badge: isLiveMode ? undefined : { text: isTCP ? '3 DEs · 8 humans' : '2 DEs · 4 humans', color: '#22c55e' },
        },
        { id: 'de_activity', label: 'DE at Work', icon: '◉', page: 'ops_de_activity' },
        { id: 'support_inbox', label: 'Support Inbox', icon: '✉', page: 'support_inbox' },
        { id: 'performance', label: 'Performance', icon: '◔', page: 'intelligence_performance' },
        // Wave 3: live tenants get the single consolidated Outcomes page
        // (real economics/delivery/risk rollup). Demo keeps the 4-page
        // preview group. The alerts badge was demo-seeded (s.alerts) —
        // demo-only now, never shown to live tenants.
        isLiveMode
          ? { id: 'outcomes', label: 'Outcomes', icon: '↑', page: 'outcomes' as Page }
          : {
              id: 'outcomes',
              label: 'Outcomes',
              icon: '↑',
              badge: s.alerts > 0 ? { text: `${s.alerts} alerts`, color: '#ef4444' } : undefined,
              children: [
                { id: 'outcome_revenue', label: 'Revenue & Growth' },
                { id: 'outcome_delivery', label: 'Delivery' },
                { id: 'outcome_financial', label: 'Financial Health' },
                { id: 'outcome_risk', label: 'Risk Posture' },
              ],
            },
        { id: 'proving_ground', label: 'Proving Ground', icon: '▦', page: 'intelligence_evals' },
        { id: 'self_learning', label: 'Self-Learning', icon: '↻', page: 'intelligence_learning' },
        { id: 'insights', label: 'Insights', icon: '✦', page: 'intelligence_insights' },
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
        { id: 'kb_library', label: 'Library', icon: '◫', page: 'knowledge_library' },
        { id: 'kb_ingestion', label: 'Ingestion & Sources', icon: '↓', page: 'knowledge_ingestion' },
        { id: 'kb_gaps', label: 'Gap Detection', icon: '△', page: 'knowledge_gaps', badge: live.kbGaps > 0 ? { text: `${live.kbGaps} gaps`, color: '#f59e0b' } : undefined },
        { id: 'kb_quality', label: 'Quality & Coverage', icon: '✓', page: 'knowledge_quality' },
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
          label: vocab.section_label,
          icon: '◎',
          page: 'entity_customer',
          children: [
            { id: 'entity_customer_bd', label: 'Business Development', indicator: { dot: true, color: '#6366f1' } },
            { id: 'entity_customer_sales', label: 'Sales', indicator: { count: live.salesPipeline, color: '#6366f1' } },
            { id: 'entity_customer_onboarding', label: 'Onboarding', indicator: { count: live.onboardingActive, color: '#f59e0b' } },
            { id: 'entity_customer_support', label: 'Support', indicator: { count: live.supportTickets, color: '#22c55e' } },
            { id: 'entity_customer_success', label: `${vocab.party_singular} Success`, indicator: { count: live.atRiskAccounts, color: '#ef4444' } },
            { id: 'entity_customer_renewal', label: `${vocab.renewal_label} & Expansion`, indicator: { count: live.renewalsDue, color: '#f59e0b' } },
          ],
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
        { id: 'compliance', label: 'Compliance & Guardrails', icon: '⚑', page: 'gov_compliance' },
        { id: 'audit', label: 'Audit Trail', icon: '▤', page: 'gov_audit' },
        { id: 'security', label: 'Security & Access', icon: '⛨', page: 'gov_security' },
        { id: 'data_access', label: 'Data Access', icon: '⊘', page: 'gov_data_access' },
        { id: 'identity_inventory', label: 'Identity & Credentials', icon: '🔑', page: 'gov_identity_inventory' },
        { id: 'trust', label: 'Trust & Architecture', icon: '▣', page: 'gov_trust' },
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
  const { activeCompanyId, setActiveCompanyId, activeCompany, isLiveTenant, viewingDemo, setViewingDemo, liveTenantName, dataMode } = useAuth();
  // No groups open by default — Company Data (the demoted entity
  // section) in particular starts collapsed per the DE-centered IA.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showCompanyPicker, setShowCompanyPicker] = useState(false);
  const [liveCounts, setLiveCounts] = useState<NavCounts>(() => computeLiveCounts(activeCompany.id));

  const refreshCounts = useCallback(() => {
    if (dataMode === 'live') {
      let cancelled = false;
      fetchLiveNavCounts().then((counts) => { if (!cancelled) setLiveCounts(counts); });
      return () => { cancelled = true; };
    }
    setLiveCounts(computeLiveCounts(activeCompanyId));
    return undefined;
  }, [activeCompanyId, dataMode]);

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
  const nav = buildNav(activeCompany.id, liveCounts, dataMode === 'live', vocab)
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

  const isActive = (p: Page) => page === p;
  const isChildActive = (children?: SubItem[]) => children?.some(c => c.id === page);

  if (collapsed) {
    return (
      <div className="w-14 bg-slate-900 border-r border-slate-700/50 flex flex-col items-center py-4 gap-3 flex-shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          className="w-8 h-8 rounded-lg bg-slate-700 text-slate-400 hover:text-white text-xs flex items-center justify-center"
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
        <div className="w-px h-4 bg-slate-700" />
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
                : 'bg-slate-800 text-slate-500 hover:text-white hover:bg-slate-700'
            }`}
          >
            {item.icon}
          </button>
        ))}
        <div className="flex-1" />
        <a
          href="mailto:bkhan@outsourcetel.com?subject=DreamTeam%20AI%20support"
          title="Contact support"
          className="w-8 h-8 rounded-lg bg-slate-800 text-slate-500 hover:text-white text-xs flex items-center justify-center"
        >
          ✉
        </a>
        <button onClick={onLogout} className="w-8 h-8 rounded-lg bg-slate-800 text-slate-500 hover:text-white text-xs flex items-center justify-center">
          ⇥
        </button>
      </div>
    );
  }

  return (
    <div className="w-60 bg-slate-900 border-r border-slate-700/50 flex flex-col flex-shrink-0 overflow-hidden">

      {/* Company selector */}
      <div className="p-3 border-b border-slate-700/50">
        <button
          onClick={() => setShowCompanyPicker(!showCompanyPicker)}
          className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-slate-800 transition-colors group"
        >
          {isLiveTenant && !viewingDemo ? (
            <>
              <div className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold text-white flex-shrink-0 bg-indigo-600">
                {(liveTenantName || 'C')[0].toUpperCase()}
              </div>
              <div className="flex-1 text-left min-w-0">
                <div className="text-xs font-semibold text-slate-100 truncate">{liveTenantName || 'Your company'}</div>
                <div className="text-[10px] text-emerald-400 truncate">Live workspace</div>
              </div>
            </>
          ) : (
            <>
              <div className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold text-white flex-shrink-0" style={{ background: activeCompany.badgeColor }}>
                {activeCompany.badge}
              </div>
              <div className="flex-1 text-left min-w-0">
                <div className="text-xs font-semibold text-slate-100 truncate">{activeCompany.name}</div>
                <div className="text-[10px] text-slate-500 truncate">{isLiveTenant ? 'Demo company' : activeCompany.industry}</div>
              </div>
            </>
          )}
          <span className="text-slate-600 text-xs group-hover:text-slate-400">⌄</span>
        </button>

        {showCompanyPicker && (
          <div className="mt-1 bg-slate-800 rounded-lg border border-slate-600/50 overflow-hidden">
            {isLiveTenant && (
              <>
                <button
                  onClick={() => { setViewingDemo(false); setShowCompanyPicker(false); }}
                  className={`w-full flex items-center gap-2 p-2 text-left hover:bg-slate-700 transition-colors ${!viewingDemo ? 'bg-slate-700/50' : ''}`}
                >
                  <div className="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center text-[10px] font-bold text-white">
                    {(liveTenantName || 'C')[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="text-xs font-medium text-slate-200">{liveTenantName || 'Your company'}</div>
                    <div className="text-[10px] text-emerald-400">Live workspace</div>
                  </div>
                  {!viewingDemo && <span className="ml-auto text-indigo-400 text-xs">✓</span>}
                </button>
                {showDemoCompanies && (
                  <div className="px-2 pt-2 pb-1 text-[9px] font-bold tracking-widest text-slate-600 uppercase border-t border-slate-600/50">
                    Demo companies
                  </div>
                )}
              </>
            )}
            {/* Platform operator inside a demo: the way back to the console
                (mirrors the App-level viewingDemo escape). */}
            {isDtUser && viewingDemo && (
              <button
                onClick={() => { setViewingDemo(false); setShowCompanyPicker(false); }}
                className="w-full flex items-center gap-2 p-2 text-left hover:bg-slate-700 transition-colors border-b border-slate-600/50"
              >
                <span className="w-7 h-7 rounded-md flex items-center justify-center text-xs bg-slate-700 text-slate-300 flex-shrink-0">←</span>
                <span className="text-xs text-slate-300">Back to Platform Console</span>
              </button>
            )}
            {showDemoCompanies && COMPANIES.map((c) => (
              <button
                key={c.id}
                onClick={() => { setActiveCompanyId(c.id); if (isLiveTenant) setViewingDemo(true); setShowCompanyPicker(false); }}
                className={`w-full flex items-center gap-2 p-2 text-left hover:bg-slate-700 transition-colors ${c.id === activeCompanyId && (!isLiveTenant || viewingDemo) ? 'bg-slate-700/50' : ''}`}
              >
                <div className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold text-white" style={{ background: c.badgeColor }}>
                  {c.badge}
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-200">{c.name}</div>
                  <div className="text-[10px] text-slate-500">{c.activeDEs} DEs active</div>
                </div>
                {c.id === activeCompanyId && (!isLiveTenant || viewingDemo) && <span className="ml-auto text-indigo-400 text-xs">✓</span>}
              </button>
            ))}
            <button
              onClick={() => { setPage('company_setup'); setShowCompanyPicker(false); }}
              className="w-full flex items-center gap-2 p-2 text-left hover:bg-slate-700 border-t border-slate-600/50"
            >
              <div className="w-6 h-6 rounded bg-slate-600 flex items-center justify-center text-xs text-slate-400">+</div>
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
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
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
                    <div className="ml-3 pl-3 border-l border-slate-700 mb-1">
                      {group.children!.map(child => (
                        <button
                          key={child.id}
                          onClick={() => setPage(child.id)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors mb-0.5 ${
                            isActive(child.id)
                              ? 'bg-indigo-500/10 text-indigo-300'
                              : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'
                          }`}
                        >
                          {child.indicator?.dot && (
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: child.indicator.color }} />
                          )}
                          <span className="text-xs flex-1 truncate">{child.label}</span>
                          {child.indicator?.count !== undefined && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-700" style={{ color: child.indicator.color }}>
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
      <div className="p-3 border-t border-slate-700/50">
        <a
          href="mailto:bkhan@outsourcetel.com?subject=DreamTeam%20AI%20support"
          className="flex items-center gap-2 px-2 py-1.5 mb-2 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-800/50 transition-colors text-xs"
        >
          <span className="w-4 text-center flex-shrink-0">✉</span>
          <span className="truncate">Contact support</span>
        </a>
        {/* Account menu — the old footer had sign-out only as an
            unlabeled ⇥ icon (founder couldn't find it) and no way to
            change a password at all. */}
        {accountMenuOpen && (
          <div className="mb-2 bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
            <button
              onClick={() => { setShowChangePassword(true); setAccountMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-slate-300 hover:bg-slate-700 transition-colors"
            >
              <span className="w-4 text-center flex-shrink-0">🔑</span> Change password…
            </button>
            <button
              onClick={onLogout}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-slate-300 hover:bg-slate-700 hover:text-red-300 transition-colors border-t border-slate-700/60"
            >
              <span className="w-4 text-center flex-shrink-0">⇥</span> Sign out
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAccountMenuOpen(v => !v)}
            className="flex items-center gap-2 flex-1 min-w-0 text-left rounded-md px-1 py-0.5 hover:bg-slate-800/60 transition-colors"
            title="Account menu"
          >
            <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {user?.name?.[0] ?? 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-200 truncate">{user?.name}</div>
              <div className="text-[10px] text-slate-500 truncate">{user?.role?.replace(/_/g, ' ')}</div>
            </div>
            <span className={`text-slate-600 text-[10px] transition-transform ${accountMenuOpen ? 'rotate-180' : ''}`}>⌃</span>
          </button>
          <button onClick={() => setCollapsed(true)} className="w-6 h-6 rounded text-slate-600 hover:text-slate-300 text-xs flex items-center justify-center flex-shrink-0">
            ←
          </button>
        </div>
        {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
        {godModeActive && (
          <button onClick={exitGodMode} className="mt-2 w-full text-[10px] text-amber-500 hover:text-amber-300 text-center">
            Exit Remote Access
          </button>
        )}
        <div className="flex items-center justify-center gap-3 mt-2 text-[10px] text-slate-600">
          <a href="/terms" className="hover:text-slate-400 transition-colors">Terms</a>
          <a href="/privacy" className="hover:text-slate-400 transition-colors">Privacy</a>
        </div>
      </div>
    </div>
  );
}

export default Sidebar;
