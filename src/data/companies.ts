// ============================================================
// Company identity types. The legacy TCP/PWC demo seed data was removed
// with the demo-surface decommission (2026-07-23); a company id is now just
// a workspace/tenant id. These interfaces remain as shared shapes.
// ============================================================

export type CompanyId = string;

export interface CompanyProfile {
  id: CompanyId;
  name: string;
  industry: string;
  badge: string;
  badgeColor: string;
  activeDEs: number;
}

export interface CompanySummary {
  desActive: number;
  desTotal: number;
  humanTasks: number;
  aiResolution: number;
  kbGaps: number;
  alerts: number;
  salesPipeline?: number;
  onboardingActive?: number;
  supportTickets?: number;
  atRiskAccounts?: number;
  renewalsDue?: number;
}
