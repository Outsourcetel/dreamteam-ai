import React, { useMemo, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';

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
      <div className="w-16 h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className={`text-xs font-medium ${text}`}>{value}%</span>
    </div>
  );
}

export function DEAvatars({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="text-xs text-slate-600">—</span>;
  return (
    <div className="flex -space-x-1.5">
      {names.map(n => (
        <div key={n} title={n} className="w-6 h-6 rounded-full bg-indigo-600 border border-slate-900 flex items-center justify-center text-white text-[10px] font-bold">{n[0]}</div>
      ))}
    </div>
  );
}

const FilterSelect = ({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) => (
  <label className="flex items-center gap-2">
    <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
    <select value={value} onChange={e => onChange(e.target.value)}
      className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-slate-600">
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  </label>
);

const KnowledgeLibraryPage = () => {
  const { activeCompanyId } = useAuth();
  const companyId = activeCompanyId as CompanyId;
  const articles = companyId === 'tcp' ? TCP_ARTICLES : PWC_ARTICLES;

  const [fEntity, setFEntity] = useState('All');
  const [fAudience, setFAudience] = useState('All DEs');
  const [fType, setFType] = useState('All');
  const [fConf, setFConf] = useState('All');
  const [selected, setSelected] = useState<KArticle | null>(null);
  const [flagged, setFlagged] = useState<Record<string, boolean>>(() => {
    try { const s = localStorage.getItem(`dt_kb_stale_flags_${companyId}`); return s ? JSON.parse(s) : {}; } catch { return {}; }
  });

  const flagStale = (id: string) => {
    const next = { ...flagged, [id]: true };
    setFlagged(next);
    try { localStorage.setItem(`dt_kb_stale_flags_${companyId}`, JSON.stringify(next)); } catch { /* noop */ }
  };

  const filtered = useMemo(() => articles.filter(a => {
    if (fEntity !== 'All' && a.entity !== fEntity) return false;
    if (fAudience !== 'All DEs' && a.audience !== fAudience) return false;
    if (fType !== 'All' && a.type !== fType) return false;
    if (fConf === 'High (≥90)' && a.confidence < 90) return false;
    if (fConf === 'Medium (70-89)' && (a.confidence < 70 || a.confidence > 89)) return false;
    if (fConf === 'Low (<70)' && a.confidence >= 70) return false;
    return true;
  }), [articles, fEntity, fAudience, fType, fConf]);

  const avgConf = Math.round(articles.reduce((s, a) => s + a.confidence, 0) / articles.length);
  const staleCount = articles.filter(isStale).length;
  const byEntity = (['Customer', 'Vendor', 'Workforce'] as KEntity[]).map(e => ({ e, n: articles.filter(a => a.entity === e).length }));

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-6 relative">
      <PageHeader title="Knowledge Library" subtitle="Every item tagged by Entity × Audience × Type × Confidence — not by department." />

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total articles</p>
          <p className="text-xl font-bold text-white">{articles.length}</p>
          <p className="text-xs text-slate-500 mt-0.5">across {new Set(articles.map(a => a.collection)).size} collections</p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Avg confidence</p>
          <p className={`text-xl font-bold ${avgConf >= 90 ? 'text-emerald-300' : 'text-amber-300'}`}>{avgConf}%</p>
          <p className="text-xs text-slate-500 mt-0.5">across all items</p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Stale (&gt;90d unverified)</p>
          <p className={`text-xl font-bold ${staleCount > 0 ? 'text-red-300' : 'text-emerald-300'}`}>{staleCount}</p>
          <p className="text-xs text-slate-500 mt-0.5">needs re-verification</p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Coverage by entity</p>
          <div className="flex gap-3 mt-1">
            {byEntity.map(x => (
              <div key={x.e}>
                <p className="text-sm font-bold text-white">{x.n}</p>
                <p className="text-[10px] text-slate-500">{x.e}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-4 bg-slate-900/50 border border-slate-800 rounded-xl px-4 py-3 mb-4">
        <FilterSelect label="Entity" value={fEntity} onChange={setFEntity} options={['All', 'Customer', 'Vendor', 'Workforce']} />
        <FilterSelect label="Audience" value={fAudience} onChange={setFAudience} options={['All DEs', 'Customer DEs', 'Specialist DEs', 'Humans only']} />
        <FilterSelect label="Type" value={fType} onChange={setFType} options={['All', ...K_TYPES]} />
        <FilterSelect label="Confidence" value={fConf} onChange={setFConf} options={['All', 'High (≥90)', 'Medium (70-89)', 'Low (<70)']} />
        <span className="text-xs text-slate-500 ml-auto">{filtered.length} of {articles.length} items</span>
      </div>

      {/* Article table */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <table className="w-full text-sm text-slate-300">
          <thead className="bg-slate-900 border-b border-slate-800">
            <tr>
              <th className={th}>Title</th>
              <th className={th}>Collection</th>
              <th className={th}>Entity</th>
              <th className={th}>Type</th>
              <th className={th}>Audience</th>
              <th className={th}>Confidence</th>
              <th className={th}>Last verified</th>
              <th className={th}>Used by</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(a => (
              <tr key={a.id} onClick={() => setSelected(a)} className="border-b border-slate-800/60 hover:bg-slate-800/40 cursor-pointer transition-colors">
                <td className={`${td} text-white font-medium`}>
                  {a.title}
                  {(isStale(a) || flagged[a.id]) && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">stale</span>}
                </td>
                <td className={`${td} text-slate-400 text-xs`}>{a.collection}</td>
                <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${entityBadge[a.entity]}`}>{a.entity}</span></td>
                <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeBadge[a.type]}`}>{a.type}</span></td>
                <td className={`${td} text-xs text-slate-400`}>{a.audience}</td>
                <td className={td}><ConfidenceBar value={a.confidence} /></td>
                <td className={`${td} text-xs ${isStale(a) ? 'text-red-400' : 'text-slate-400'}`}>{a.lastVerified}</td>
                <td className={td}><DEAvatars names={a.usedBy} /></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="py-8 text-center text-sm text-slate-500">No articles match the current filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Detail slide-over */}
      {selected && (
        <div className="fixed inset-0 z-40 flex justify-end" onClick={() => setSelected(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div onClick={e => e.stopPropagation()} className="relative w-full max-w-md h-full bg-slate-900 border-l border-slate-800 overflow-y-auto p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-white">{selected.title}</h2>
                <p className="text-xs text-slate-500 mt-0.5">{selected.collection}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>
            </div>

            <div className="flex flex-wrap gap-2 mb-5">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${entityBadge[selected.entity]}`}>{selected.entity}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeBadge[selected.type]}`}>{selected.type}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">{selected.audience}</span>
            </div>

            <div className="bg-slate-950 rounded-xl p-4 mb-4 space-y-2">
              <div className="flex justify-between items-center"><span className="text-xs text-slate-500">Confidence</span><ConfidenceBar value={selected.confidence} /></div>
              <div className="flex justify-between"><span className="text-xs text-slate-500">Last verified</span><span className={`text-xs ${isStale(selected) ? 'text-red-400' : 'text-slate-300'}`}>{selected.lastVerified} ({daysSince(selected.lastVerified)}d ago)</span></div>
            </div>

            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Access list</p>
            <div className="space-y-2 mb-5">
              {selected.access.map(acc => (
                <div key={acc.de} className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[10px] font-bold">{acc.de[0]}</div>
                    <span className="text-sm text-slate-200">{acc.de}</span>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${acc.level === 'read_write' ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-800 text-slate-400'}`}>{acc.level === 'read_write' ? 'Read / Write' : 'Read'}</span>
                </div>
              ))}
              {selected.access.length === 0 && <p className="text-xs text-slate-600">No DE access — humans only.</p>}
            </div>

            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Version history</p>
            <div className="space-y-2 mb-6">
              {selected.versions.map(ver => (
                <div key={ver.version} className="bg-slate-950 rounded-lg px-3 py-2">
                  <div className="flex justify-between">
                    <span className="text-sm text-slate-200 font-medium">v{ver.version}</span>
                    <span className="text-xs text-slate-500">{ver.date}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">{ver.note}</p>
                </div>
              ))}
            </div>

            <button
              onClick={() => flagStale(selected.id)}
              disabled={!!flagged[selected.id]}
              className={`w-full text-sm px-3 py-2 rounded-lg border transition-colors ${flagged[selected.id] ? 'border-red-500/40 text-red-400 bg-red-500/10 cursor-default' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
              {flagged[selected.id] ? 'Flagged as stale — re-verification queued' : 'Flag as stale'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default KnowledgeLibraryPage;
