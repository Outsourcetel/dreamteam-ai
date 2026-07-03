import React, { useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';
import { TCP_ARTICLES, PWC_ARTICLES, daysSince, isStale, ConfidenceBar } from './KnowledgeLibraryPage';

// ============================================================
// Quality & Coverage — coverage matrix (numbers identical to
// the DE knowledge configs in WorkforceDEsPage), freshness
// histogram, confidence calibration, stale queue.
// ============================================================

// Coverage matrix: rows = collections, cols = company DEs.
// Values copied verbatim from WorkforceDEsPage knowledge configs.
const COVERAGE: Record<CompanyId, { des: string[]; rows: { collection: string; values: (number | null)[] }[] }> = {
  tcp: {
    des: ['Alex', 'Casey', 'Riley'],
    rows: [
      { collection: 'Product Docs', values: [94, null, null] },
      { collection: 'API Reference', values: [87, null, null] },
      { collection: 'Troubleshooting Guides', values: [91, null, null] },
      { collection: 'Customer History', values: [78, 82, null] },
      { collection: 'Contract Templates', values: [null, 96, null] },
      { collection: 'Pricing Tiers', values: [null, 100, null] },
      { collection: 'Zuora KB', values: [null, 89, null] },
      { collection: 'HR Policies', values: [null, null, 88] },
      { collection: 'Benefits Handbook', values: [null, null, 94] },
      { collection: 'Onboarding Templates', values: [null, null, 76] },
      { collection: 'Employee Records', values: [null, null, 67] },
    ],
  },
  pwc: {
    des: ['Morgan', 'Avery'],
    rows: [
      { collection: 'Client Engagement Docs', values: [91, null] },
      { collection: 'Service Methodology', values: [88, null] },
      { collection: 'Regulatory Library', values: [84, null] },
      { collection: 'Client History', values: [79, null] },
      { collection: 'Tax Code Library', values: [null, 96] },
      { collection: 'Case Law Database', values: [null, 89] },
      { collection: 'Internal Tax Memos', values: [null, 82] },
      { collection: 'IRS Guidance', values: [null, 98] },
    ],
  },
};

interface CalibrationRow { article: string; deConf: number; humanFeedback: string; delta: string }
const CALIBRATION: Record<CompanyId, CalibrationRow[]> = {
  tcp: [
    { article: 'Webhook configuration guide', deConf: 74, humanFeedback: '3 corrections by L2 this month — DE was overconfident on retry section', delta: 'over' },
    { article: 'Zuora credit memo handling', deConf: 71, humanFeedback: 'Human reviewers approved 9/9 answers — DE underrates itself', delta: 'under' },
    { article: 'Known issue: bulk import timeouts', deConf: 68, humanFeedback: '2 escalations where the documented workaround failed', delta: 'over' },
  ],
  pwc: [
    { article: 'IRS Notice 2026-14 summary — digital assets', deConf: 76, humanFeedback: 'Partner flagged an outdated threshold in 1 of 4 cited answers', delta: 'over' },
    { article: 'Client complaint escalation matrix', deConf: 86, humanFeedback: 'All 12 escalations routed correctly — confidence can rise', delta: 'under' },
    { article: 'Memo: state tax nexus after Wayfair', deConf: 89, humanFeedback: 'Two states changed thresholds since last verification', delta: 'over' },
  ],
};

const heatCls = (v: number) =>
  v >= 90 ? 'bg-emerald-500/25 text-emerald-300'
  : v >= 80 ? 'bg-emerald-500/10 text-emerald-400'
  : v >= 70 ? 'bg-amber-500/15 text-amber-300'
  : 'bg-red-500/15 text-red-300';

const KnowledgeQualityPage = () => {
  const { activeCompanyId } = useAuth();
  const companyId = activeCompanyId as CompanyId;
  const matrix = COVERAGE[companyId];
  const articles = companyId === 'tcp' ? TCP_ARTICLES : PWC_ARTICLES;
  const calibration = CALIBRATION[companyId];
  const lsKey = `dt_kb_quality_${companyId}`;

  const [actions, setActions] = useState<Record<string, string>>(() => {
    try { const s = localStorage.getItem(lsKey); return s ? JSON.parse(s) : {}; } catch { return {}; }
  });
  const act = (key: string, label: string) => {
    const next = { ...actions, [key]: label };
    setActions(next);
    try { localStorage.setItem(lsKey, JSON.stringify(next)); } catch { /* noop */ }
  };

  const buckets = [
    { label: '0–30d', test: (d: number) => d <= 30, cls: 'bg-emerald-400' },
    { label: '31–60d', test: (d: number) => d > 30 && d <= 60, cls: 'bg-sky-400' },
    { label: '61–90d', test: (d: number) => d > 60 && d <= 90, cls: 'bg-amber-400' },
    { label: '>90d stale', test: (d: number) => d > 90, cls: 'bg-red-400' },
  ].map(b => ({ ...b, count: articles.filter(a => b.test(daysSince(a.lastVerified))).length }));
  const maxBucket = Math.max(...buckets.map(b => b.count), 1);

  const staleQueue = articles.filter(a => isStale(a) && !actions[`stale_${a.id}`]);
  const handledStale = articles.filter(a => isStale(a) && actions[`stale_${a.id}`]);

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-6">
      <PageHeader title="Quality & Coverage" subtitle="Coverage per DE, knowledge freshness, and confidence calibration against human feedback." />

      {/* Coverage matrix */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">Coverage matrix</h3>
          <p className="text-xs text-slate-500 mt-0.5">Collection coverage per Digital Employee — mirrors each DE's knowledge configuration.</p>
        </div>
        <table className="w-full text-sm text-slate-300">
          <thead className="bg-slate-900 border-b border-slate-800">
            <tr>
              <th className={th}>Collection</th>
              {matrix.des.map(d => <th key={d} className={`${th} text-center`}>{d}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map(r => (
              <tr key={r.collection} className="border-b border-slate-800/60">
                <td className={`${td} text-white`}>{r.collection}</td>
                {r.values.map((val, i) => (
                  <td key={matrix.des[i]} className={`${td} text-center`}>
                    {val === null
                      ? <span className="text-slate-700">—</span>
                      : <span className={`inline-block min-w-[3rem] text-xs font-medium px-2 py-1 rounded-lg ${heatCls(val)}`}>{val}%</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
        {/* Freshness histogram */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-1">Freshness</h3>
          <p className="text-xs text-slate-500 mb-4">Articles by time since last verification.</p>
          <div className="flex items-end gap-4 h-36">
            {buckets.map(b => (
              <div key={b.label} className="flex-1 flex flex-col items-center justify-end h-full">
                <span className="text-xs font-bold text-white mb-1">{b.count}</span>
                <div className={`w-full rounded-t-lg ${b.cls}`} style={{ height: `${Math.max((b.count / maxBucket) * 100, 4)}%` }} />
                <span className={`text-[10px] mt-2 ${b.label.includes('stale') ? 'text-red-400' : 'text-slate-500'}`}>{b.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Confidence calibration */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-1">Confidence calibration</h3>
          <p className="text-xs text-slate-500 mb-4">Articles where DE confidence disagreed with human feedback.</p>
          <div className="space-y-3">
            {calibration.map(c => {
              const key = `cal_${c.article}`;
              return (
                <div key={c.article} className="bg-slate-950 rounded-xl p-3 border border-slate-800">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium text-white">{c.article}</p>
                      <p className="text-[11px] text-slate-400 mt-1">{c.humanFeedback}</p>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${c.delta === 'over' ? 'bg-red-500/20 text-red-400' : 'bg-sky-500/20 text-sky-400'}`}>
                      {c.delta === 'over' ? 'Overconfident' : 'Underconfident'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <ConfidenceBar value={c.deConf} />
                    {actions[key] ? (
                      <span className="text-[11px] text-emerald-400">{actions[key]}</span>
                    ) : (
                      <button onClick={() => act(key, 'Recalibration queued')} className="text-[11px] px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:border-indigo-500/50 hover:text-indigo-400 transition-colors">
                        Recalibrate
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Stale queue */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Stale queue</h3>
            <p className="text-xs text-slate-500 mt-0.5">Articles unverified for more than 90 days.</p>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full ${staleQueue.length > 0 ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
            {staleQueue.length} pending
          </span>
        </div>
        {staleQueue.length === 0 && handledStale.length === 0 ? (
          <p className="p-6 text-sm text-slate-500 text-center">Nothing stale — all articles verified within 90 days.</p>
        ) : (
          <table className="w-full text-sm text-slate-300">
            <thead className="bg-slate-900 border-b border-slate-800">
              <tr>
                <th className={th}>Article</th>
                <th className={th}>Collection</th>
                <th className={th}>Last verified</th>
                <th className={th}>Confidence</th>
                <th className={`${th} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {[...staleQueue, ...handledStale].map(a => {
                const key = `stale_${a.id}`;
                const done = actions[key];
                return (
                  <tr key={a.id} className={`border-b border-slate-800/60 ${done ? 'opacity-60' : ''}`}>
                    <td className={`${td} text-white font-medium`}>{a.title}</td>
                    <td className={`${td} text-xs text-slate-400`}>{a.collection}</td>
                    <td className={`${td} text-xs text-red-400`}>{a.lastVerified} ({daysSince(a.lastVerified)}d)</td>
                    <td className={td}><ConfidenceBar value={a.confidence} /></td>
                    <td className={`${td} text-right`}>
                      {done ? (
                        <span className="text-xs text-emerald-400">{done}</span>
                      ) : (
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => act(key, 'Re-verification assigned')} className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white">Re-verify</button>
                          <button onClick={() => act(key, 'Archived')} className="text-xs px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500">Archive</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default KnowledgeQualityPage;
