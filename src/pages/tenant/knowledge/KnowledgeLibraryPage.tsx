import React, { useMemo, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';
import LiveKnowledgeLibrary from './LiveKnowledgeLibrary';

// ============================================================
// Knowledge Library — the 4-dimension browser.
// Every item tagged Entity × Audience × Type × Confidence.
// Collections + coverage reconciled with WorkforceDEsPage DE
// knowledge configs (TCP: Alex/Casey/Riley; PWC: Morgan/Avery).
// ============================================================

export type KEntity = 'Customer' | 'Vendor' | 'Workforce';
export type KAudience = 'All DEs' | 'Customer DEs' | 'Specialist DEs' | 'Humans only';
export const K_TYPES = ['Reference', 'Procedural', 'Regulatory', 'Institutional', 'Customer (PII)', 'Competitive', 'Training'] as const;
export type KType = (typeof K_TYPES)[number];

export interface KArticle {
  id: string;
  title: string;
  collection: string;
  entity: KEntity;
  type: KType;
  audience: KAudience;
  confidence: number;
  lastVerified: string; // yyyy-mm-dd
  usedBy: string[]; // DE names
  access: { de: string; level: 'read' | 'read_write' }[];
  versions: { version: string; date: string; note: string }[];
}

const v = (n: string, d: string, note: string) => ({ version: n, date: d, note });

export const TCP_ARTICLES: KArticle[] = [
  { id: 't1', title: '2FA reset procedure', collection: 'Troubleshooting Guides', entity: 'Customer', type: 'Procedural', audience: 'Customer DEs', confidence: 96, lastVerified: '2026-06-20', usedBy: ['Alex'], access: [{ de: 'Alex', level: 'read' }], versions: [v('1.3', '2026-06-20', 'Added SSO edge case'), v('1.2', '2026-04-02', 'Screenshots refreshed')] },
  { id: 't2', title: 'Enterprise tier pricing matrix', collection: 'Pricing Tiers', entity: 'Customer', type: 'Reference', audience: 'Customer DEs', confidence: 100, lastVerified: '2026-06-28', usedBy: ['Casey'], access: [{ de: 'Casey', level: 'read' }], versions: [v('4.0', '2026-06-28', 'FY27 price book'), v('3.2', '2026-01-15', 'Mid-year adjustment')] },
  { id: 't3', title: 'PTO accrual policy', collection: 'HR Policies', entity: 'Workforce', type: 'Regulatory', audience: 'Specialist DEs', confidence: 88, lastVerified: '2026-05-10', usedBy: ['Riley'], access: [{ de: 'Riley', level: 'read' }], versions: [v('2.1', '2026-05-10', 'State-law carve-outs added')] },
  { id: 't4', title: 'API authentication quickstart', collection: 'API Reference', entity: 'Customer', type: 'Reference', audience: 'All DEs', confidence: 94, lastVerified: '2026-06-15', usedBy: ['Alex'], access: [{ de: 'Alex', level: 'read' }], versions: [v('3.0', '2026-06-15', 'OAuth2 flow rewrite'), v('2.4', '2026-03-01', 'Token rotation notes')] },
  { id: 't5', title: 'Rate limiting guide', collection: 'API Reference', entity: 'Customer', type: 'Reference', audience: 'Customer DEs', confidence: 82, lastVerified: '2026-07-01', usedBy: ['Alex'], access: [{ de: 'Alex', level: 'read' }], versions: [v('1.0', '2026-07-01', 'Drafted by Alex, human-approved')] },
  { id: 't6', title: 'Core platform feature overview', collection: 'Product Docs', entity: 'Customer', type: 'Reference', audience: 'All DEs', confidence: 97, lastVerified: '2026-06-10', usedBy: ['Alex', 'Casey'], access: [{ de: 'Alex', level: 'read' }, { de: 'Casey', level: 'read' }], versions: [v('6.1', '2026-06-10', 'Q2 release features')] },
  { id: 't7', title: 'Data export & retention settings', collection: 'Product Docs', entity: 'Customer', type: 'Procedural', audience: 'Customer DEs', confidence: 91, lastVerified: '2026-05-22', usedBy: ['Alex'], access: [{ de: 'Alex', level: 'read' }], versions: [v('2.2', '2026-05-22', 'GDPR retention defaults')] },
  { id: 't8', title: 'Webhook configuration guide', collection: 'Product Docs', entity: 'Customer', type: 'Procedural', audience: 'Customer DEs', confidence: 74, lastVerified: '2026-02-18', usedBy: ['Alex'], access: [{ de: 'Alex', level: 'read' }], versions: [v('1.4', '2026-02-18', 'Retry section flagged incomplete')] },
  { id: 't9', title: 'Standard MSA template (12-month)', collection: 'Contract Templates', entity: 'Customer', type: 'Reference', audience: 'Customer DEs', confidence: 98, lastVerified: '2026-06-01', usedBy: ['Casey'], access: [{ de: 'Casey', level: 'read' }], versions: [v('5.0', '2026-06-01', 'Legal FY27 refresh')] },
  { id: 't10', title: 'Renewal discount approval thresholds', collection: 'Pricing Tiers', entity: 'Customer', type: 'Institutional', audience: 'Customer DEs', confidence: 92, lastVerified: '2026-04-12', usedBy: ['Casey'], access: [{ de: 'Casey', level: 'read' }], versions: [v('1.8', '2026-04-12', 'Max 20% w/o VP approval')] },
  { id: 't11', title: 'Zuora invoice generation runbook', collection: 'Zuora KB', entity: 'Customer', type: 'Procedural', audience: 'Customer DEs', confidence: 89, lastVerified: '2026-05-30', usedBy: ['Casey'], access: [{ de: 'Casey', level: 'read' }], versions: [v('2.0', '2026-05-30', 'New tax engine steps')] },
  { id: 't12', title: 'Zuora credit memo handling', collection: 'Zuora KB', entity: 'Customer', type: 'Procedural', audience: 'Customer DEs', confidence: 71, lastVerified: '2026-03-14', usedBy: ['Casey'], access: [{ de: 'Casey', level: 'read' }], versions: [v('1.1', '2026-03-14', 'Edge cases pending review')] },
  { id: 't13', title: 'Account health scoring model', collection: 'Customer History', entity: 'Customer', type: 'Customer (PII)', audience: 'Customer DEs', confidence: 85, lastVerified: '2026-06-05', usedBy: ['Alex', 'Casey'], access: [{ de: 'Alex', level: 'read_write' }, { de: 'Casey', level: 'read_write' }], versions: [v('3.1', '2026-06-05', 'Churn signals recalibrated')] },
  { id: 't14', title: 'Benefits open enrollment FAQ', collection: 'Benefits Handbook', entity: 'Workforce', type: 'Reference', audience: 'Specialist DEs', confidence: 94, lastVerified: '2026-06-18', usedBy: ['Riley'], access: [{ de: 'Riley', level: 'read' }], versions: [v('4.0', '2026-06-18', 'FY27 plan year')] },
  { id: 't15', title: 'New hire day-one checklist', collection: 'Onboarding Templates', entity: 'Workforce', type: 'Procedural', audience: 'Specialist DEs', confidence: 79, lastVerified: '2026-03-02', usedBy: ['Riley'], access: [{ de: 'Riley', level: 'read_write' }], versions: [v('4.1', '2026-03-02', 'IT provisioning steps merged')] },
  { id: 't16', title: 'Employee data access policy', collection: 'Employee Records', entity: 'Workforce', type: 'Regulatory', audience: 'Humans only', confidence: 90, lastVerified: '2026-01-15', usedBy: [], access: [{ de: 'Riley', level: 'read_write' }], versions: [v('1.5', '2026-01-15', 'HRBP approval gate added')] },
  { id: 't17', title: 'Severity classification rubric', collection: 'Troubleshooting Guides', entity: 'Customer', type: 'Institutional', audience: 'Customer DEs', confidence: 93, lastVerified: '2026-05-01', usedBy: ['Alex'], access: [{ de: 'Alex', level: 'read' }], versions: [v('1.4', '2026-05-01', 'P1 criteria tightened')] },
  { id: 't18', title: 'Known issue: bulk import timeouts', collection: 'Troubleshooting Guides', entity: 'Customer', type: 'Training', audience: 'All DEs', confidence: 68, lastVerified: '2026-02-01', usedBy: ['Alex'], access: [{ de: 'Alex', level: 'read' }], versions: [v('0.9', '2026-02-01', 'Workaround only — fix pending')] },
];

export const PWC_ARTICLES: KArticle[] = [
  { id: 'p1', title: 'KYC documentation checklist', collection: 'Client Engagement Docs', entity: 'Customer', type: 'Procedural', audience: 'Customer DEs', confidence: 95, lastVerified: '2026-06-22', usedBy: ['Morgan'], access: [{ de: 'Morgan', level: 'read_write' }], versions: [v('5.0', '2026-06-22', 'AML update per FinCEN')] },
  { id: 'p2', title: 'Engagement letter standard clauses', collection: 'Client Engagement Docs', entity: 'Customer', type: 'Reference', audience: 'Customer DEs', confidence: 97, lastVerified: '2026-05-15', usedBy: ['Morgan'], access: [{ de: 'Morgan', level: 'read_write' }], versions: [v('3.2', '2026-05-15', 'Risk clause refresh')] },
  { id: 'p3', title: 'Audit sampling methodology', collection: 'Service Methodology', entity: 'Customer', type: 'Institutional', audience: 'All DEs', confidence: 91, lastVerified: '2026-04-30', usedBy: ['Morgan', 'Avery'], access: [{ de: 'Morgan', level: 'read' }, { de: 'Avery', level: 'read' }], versions: [v('7.1', '2026-04-30', 'ISA 530 alignment')] },
  { id: 'p4', title: 'GDPR data subject request protocol', collection: 'Regulatory Library', entity: 'Customer', type: 'Regulatory', audience: 'Customer DEs', confidence: 93, lastVerified: '2026-05-01', usedBy: ['Morgan'], access: [{ de: 'Morgan', level: 'read' }], versions: [v('2.0', '2026-05-01', '30-day SLA workflow')] },
  { id: 'p5', title: 'Client complaint escalation matrix', collection: 'Client History', entity: 'Customer', type: 'Customer (PII)', audience: 'Customer DEs', confidence: 86, lastVerified: '2026-03-20', usedBy: ['Morgan'], access: [{ de: 'Morgan', level: 'read_write' }], versions: [v('1.3', '2026-03-20', 'Partner sign-off threshold')] },
  { id: 'p6', title: 'IRC §41 R&D credit eligibility summary', collection: 'Tax Code Library', entity: 'Customer', type: 'Reference', audience: 'Specialist DEs', confidence: 96, lastVerified: '2026-06-01', usedBy: ['Avery'], access: [{ de: 'Avery', level: 'read' }], versions: [v('2.4', '2026-06-01', 'Amortization rule change')] },
  { id: 'p7', title: 'FATCA reporting thresholds — individuals', collection: 'IRS Guidance', entity: 'Customer', type: 'Regulatory', audience: 'Specialist DEs', confidence: 98, lastVerified: '2026-06-25', usedBy: ['Avery'], access: [{ de: 'Avery', level: 'read' }], versions: [v('3.0', '2026-06-25', 'IRS Notice 2026-14 incorporated')] },
  { id: 'p8', title: 'Moline Properties doctrine — case summary', collection: 'Case Law Database', entity: 'Customer', type: 'Reference', audience: 'Specialist DEs', confidence: 92, lastVerified: '2026-02-10', usedBy: ['Avery'], access: [{ de: 'Avery', level: 'read' }], versions: [v('1.0', '2026-02-10', 'Initial brief')] },
  { id: 'p9', title: 'Memo: state tax nexus after Wayfair', collection: 'Internal Tax Memos', entity: 'Customer', type: 'Institutional', audience: 'Specialist DEs', confidence: 89, lastVerified: '2026-04-15', usedBy: ['Avery'], access: [{ de: 'Avery', level: 'read_write' }], versions: [v('2.1', '2026-04-15', 'Threshold table updated')] },
  { id: 'p10', title: 'Memo drafting standards & citation format', collection: 'Internal Tax Memos', entity: 'Workforce', type: 'Procedural', audience: 'Specialist DEs', confidence: 94, lastVerified: '2026-04-01', usedBy: ['Avery'], access: [{ de: 'Avery', level: 'read_write' }], versions: [v('3.2', '2026-04-01', 'Bluebook citation update')] },
  { id: 'p11', title: 'Independence & conflict-check requirements', collection: 'Regulatory Library', entity: 'Workforce', type: 'Regulatory', audience: 'Humans only', confidence: 90, lastVerified: '2026-01-20', usedBy: [], access: [{ de: 'Morgan', level: 'read' }], versions: [v('4.0', '2026-01-20', 'PCAOB rule refresh')] },
  { id: 'p12', title: 'IRS Notice 2026-14 summary — digital assets', collection: 'IRS Guidance', entity: 'Customer', type: 'Reference', audience: 'Specialist DEs', confidence: 76, lastVerified: '2026-07-01', usedBy: ['Avery'], access: [{ de: 'Avery', level: 'read' }], versions: [v('1.0', '2026-07-01', 'Filed by Avery — pending partner review')] },
];

const TODAY = new Date('2026-07-03');
export const daysSince = (d: string) => Math.round((TODAY.getTime() - new Date(d).getTime()) / 86400000);
export const isStale = (a: KArticle) => daysSince(a.lastVerified) > 90;

const typeBadge: Record<KType, string> = {
  'Reference': 'bg-sky-500/20 text-sky-400',
  'Procedural': 'bg-indigo-500/20 text-indigo-400',
  'Regulatory': 'bg-red-500/20 text-red-400',
  'Institutional': 'bg-amber-500/20 text-amber-400',
  'Customer (PII)': 'bg-purple-500/20 text-purple-400',
  'Competitive': 'bg-pink-500/20 text-pink-400',
  'Training': 'bg-teal-500/20 text-teal-400',
};

const entityBadge: Record<KEntity, string> = {
  Customer: 'bg-indigo-500/20 text-indigo-400',
  Vendor: 'bg-amber-500/20 text-amber-400',
  Workforce: 'bg-teal-500/20 text-teal-400',
};

export function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 90 ? 'bg-emerald-400' : value >= 70 ? 'bg-amber-400' : 'bg-red-400';
  const text = value >= 90 ? 'text-emerald-400' : value >= 70 ? 'text-amber-400' : 'text-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-dt-panel overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className={`text-xs font-medium ${text}`}>{value}%</span>
    </div>
  );
}

export function DEAvatars({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="text-xs text-dt-faint">—</span>;
  return (
    <div className="flex -space-x-1.5">
      {names.map(n => (
        <div key={n} title={n} className="w-6 h-6 rounded-full bg-indigo-600 border border-dt-border flex items-center justify-center text-white text-[10px] font-bold">{n[0]}</div>
      ))}
    </div>
  );
}

const FilterSelect = ({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) => (
  <label className="flex items-center gap-2">
    <span className="text-[11px] uppercase tracking-wide text-dt-muted">{label}</span>
    <select value={value} onChange={e => onChange(e.target.value)}
      className="bg-dt-card border border-dt-border rounded-lg px-2.5 py-1.5 text-xs text-dt-body focus:outline-none focus:border-dt-border-strong">
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  </label>
);

const KnowledgeLibraryPage = ({ setPage }: { setPage?: (p: import('../../../types').Page) => void }) => {
  return <LiveKnowledgeLibrary setPage={setPage} />;
};

export default KnowledgeLibraryPage;
