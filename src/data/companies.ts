// ============================================================
// COMPANY SEED DATA — single source of truth for demo companies
// and per-company summary counts (sidebar badges + dashboard KPIs).
// Counts are reconciled with the DE rosters in WorkforceDEsPage:
//   TCP — Alex (Customer Support), Casey (Renewal), Riley (HR & People)
//   PWC — Morgan (Client Relations), Avery (Tax Research)
// ============================================================

// Demo companies (TCP/PWC) were hard-deleted (commit 69605ea). The legacy id
// union is kept so demo-era pages still typecheck; their seed data stays empty
// and those pages never render outside demo mode.
export type CompanyId = 'tcp' | 'pwc';

export interface CompanyProfile {
  id: CompanyId;
  name: string;
  industry: string;
  badge: string;
  badgeColor: string;
  activeDEs: number;
}

export const COMPANIES: CompanyProfile[] = [];

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

export const COMPANY_SUMMARY: Record<CompanyId, CompanySummary> = {} as Record<CompanyId, CompanySummary>;
