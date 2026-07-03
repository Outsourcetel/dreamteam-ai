// ============================================================
// COMPANY SEED DATA — single source of truth for demo companies
// and per-company summary counts (sidebar badges + dashboard KPIs).
// Counts are reconciled with the DE rosters in WorkforceDEsPage:
//   TCP — Alex (Customer Support), Casey (Renewal), Riley (HR & People)
//   PWC — Morgan (Client Relations), Avery (Tax Research)
// ============================================================

export type CompanyId = 'tcp' | 'pwc';

export interface CompanyProfile {
  id: CompanyId;
  name: string;
  industry: string;
  badge: string;
  badgeColor: string;
  activeFunctions: number;
  activeDEs: number;
}

export const COMPANIES: CompanyProfile[] = [
  {
    id: 'tcp',
    name: 'TCP Software',
    industry: 'Technology / SaaS',
    badge: 'TECH',
    badgeColor: '#6366f1',
    activeFunctions: 6,
    activeDEs: 3,
  },
  {
    id: 'pwc',
    name: 'PWC',
    industry: 'Financial Services',
    badge: 'FIN',
    badgeColor: '#0ea5e9',
    activeFunctions: 5,
    activeDEs: 2,
  },
];

export const COMPANIES_LOOKUP: Record<CompanyId, CompanyProfile> =
  Object.fromEntries(COMPANIES.map(c => [c.id, c])) as Record<CompanyId, CompanyProfile>;

export interface CompanySummary {
  desActive: number;
  desTotal: number;
  humanTasks: number;
  aiResolution: number;
  kbGaps: number;
  alerts: number;
  // Customer entity child counts (sidebar indicators)
  salesPipeline?: number;
  onboardingActive?: number;
  supportTickets?: number;
  atRiskAccounts?: number;
  renewalsDue?: number;
}

export const COMPANY_SUMMARY: Record<CompanyId, CompanySummary> = {
  tcp: {
    desActive: 3,
    desTotal: 3,
    humanTasks: 5,
    aiResolution: 87,
    kbGaps: 5,
    alerts: 2,
    salesPipeline: 12,
    onboardingActive: 2,
    supportTickets: 47,
    atRiskAccounts: 3,
    renewalsDue: 8,
  },
  pwc: {
    desActive: 2,
    desTotal: 2,
    humanTasks: 4,
    aiResolution: 79,
    kbGaps: 3,
    alerts: 2,
    onboardingActive: 1,
    atRiskAccounts: 1,
    renewalsDue: 2,
  },
};
