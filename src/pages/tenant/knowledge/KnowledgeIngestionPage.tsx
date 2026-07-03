import React, { useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';
import { K_TYPES } from './KnowledgeLibraryPage';
import type { KEntity, KAudience, KType } from './KnowledgeLibraryPage';

// ============================================================
// Ingestion & Sources — connected sources, processing pipeline,
// human review queue. Sources reconciled with the DE system
// access lists (Confluence/Zendesk for TCP, SharePoint/Thomson
// Reuters for PWC).
// ============================================================

interface Source {
  name: string;
  kind: string;
  status: 'connected' | 'error' | 'disconnected';
  docs: number;
  lastSync: string;
  note?: string;
}

const SOURCES: Record<CompanyId, Source[]> = {
  tcp: [
    { name: 'Confluence', kind: 'Wiki', status: 'connected', docs: 2340, lastSync: '15 min ago' },
    { name: 'Zendesk macros', kind: 'Support', status: 'connected', docs: 156, lastSync: '32 min ago' },
    { name: 'Google Drive', kind: 'Files', status: 'error', docs: 89, lastSync: '2 days ago', note: 'Pending re-authorization — OAuth token expired' },
    { name: 'Notion', kind: 'Wiki', status: 'disconnected', docs: 0, lastSync: '—', note: 'Not connected' },
  ],
  pwc: [
    { name: 'SharePoint', kind: 'Document Mgmt', status: 'connected', docs: 4120, lastSync: '20 min ago' },
    { name: 'Thomson Reuters feed', kind: 'Tax Research', status: 'connected', docs: 1875, lastSync: '1 hr ago' },
    { name: 'Internal memo archive', kind: 'Files', status: 'connected', docs: 640, lastSync: '3 hrs ago' },
  ],
};

interface ReviewItem {
  id: string;
  title: string;
  source: string;
  entity: KEntity;
  audience: KAudience;
  type: KType;
  confidence: number;
}

const REVIEW_SEED: Record<CompanyId, ReviewItem[]> = {
  tcp: [
    { id: 'r1', title: 'SAML assertion troubleshooting notes', source: 'Confluence', entity: 'Customer', audience: 'Customer DEs', type: 'Procedural', confidence: 81 },
    { id: 'r2', title: 'Q2 release notes — reporting module', source: 'Confluence', entity: 'Customer', audience: 'All DEs', type: 'Reference', confidence: 92 },
    { id: 'r3', title: 'Macro: refund request first response', source: 'Zendesk macros', entity: 'Customer', audience: 'Customer DEs', type: 'Training', confidence: 76 },
    { id: 'r4', title: 'Remote work equipment policy', source: 'Google Drive', entity: 'Workforce', audience: 'Specialist DEs', type: 'Regulatory', confidence: 68 },
    { id: 'r5', title: 'Competitor feature comparison — Q2', source: 'Google Drive', entity: 'Customer', audience: 'Humans only', type: 'Competitive', confidence: 73 },
  ],
  pwc: [
    { id: 'r1', title: 'Rev. Proc. 2026-23 summary', source: 'Thomson Reuters feed', entity: 'Customer', audience: 'Specialist DEs', type: 'Regulatory', confidence: 88 },
    { id: 'r2', title: 'Engagement risk scoring worksheet', source: 'SharePoint', entity: 'Customer', audience: 'Customer DEs', type: 'Institutional', confidence: 79 },
    { id: 'r3', title: 'Memo: transfer pricing documentation', source: 'Internal memo archive', entity: 'Customer', audience: 'Specialist DEs', type: 'Institutional', confidence: 84 },
    { id: 'r4', title: 'Client data handling addendum', source: 'SharePoint', entity: 'Customer', audience: 'Humans only', type: 'Customer (PII)', confidence: 71 },
  ],
};

const PIPELINE_BASE: Record<CompanyId, { stage: string; desc: string; count: number }[]> = {
  tcp: [
    { stage: 'Ingest', desc: 'Pulled from sources', count: 38 },
    { stage: 'Chunk', desc: 'Split & embedded', count: 22 },
    { stage: 'Classify', desc: 'Auto-tag Entity × Audience × Type', count: 14 },
    { stage: 'Confidence', desc: 'Scoring vs. corpus', count: 9 },
    { stage: 'Review', desc: 'Awaiting human review', count: 5 },
    { stage: 'Live', desc: 'Published this week', count: 12 },
  ],
  pwc: [
    { stage: 'Ingest', desc: 'Pulled from sources', count: 51 },
    { stage: 'Chunk', desc: 'Split & embedded', count: 30 },
    { stage: 'Classify', desc: 'Auto-tag Entity × Audience × Type', count: 11 },
    { stage: 'Confidence', desc: 'Scoring vs. corpus', count: 7 },
    { stage: 'Review', desc: 'Awaiting human review', count: 4 },
    { stage: 'Live', desc: 'Published this week', count: 9 },
  ],
};

const statusStyle: Record<Source['status'], { dot: string; label: string; text: string }> = {
  connected: { dot: 'bg-emerald-400', label: 'Connected', text: 'text-emerald-400' },
  error: { dot: 'bg-red-400', label: 'Error', text: 'text-red-400' },
  disconnected: { dot: 'bg-slate-600', label: 'Disconnected', text: 'text-slate-500' },
};

type ReviewState = Record<string, { decision?: 'approved' | 'rejected'; entity: KEntity; audience: KAudience; type: KType }>;

const KnowledgeIngestionPage = () => {
  const { activeCompanyId } = useAuth();
  const companyId = activeCompanyId as CompanyId;
  const sources = SOURCES[companyId];
  const seed = REVIEW_SEED[companyId];
  const lsKey = `dt_kb_review_${companyId}`;

  const [review, setReview] = useState<ReviewState>(() => {
    try {
      const s = localStorage.getItem(lsKey);
      if (s) return JSON.parse(s);
    } catch { /* noop */ }
    return Object.fromEntries(seed.map(r => [r.id, { entity: r.entity, audience: r.audience, type: r.type }]));
  });
  const [uploaded, setUploaded] = useState<string[]>([]);

  const save = (next: ReviewState) => {
    setReview(next);
    try { localStorage.setItem(lsKey, JSON.stringify(next)); } catch { /* noop */ }
  };
  const patch = (id: string, p: Partial<ReviewState[string]>) => {
    const cur = review[id] ?? { entity: 'Customer' as KEntity, audience: 'All DEs' as KAudience, type: 'Reference' as KType };
    save({ ...review, [id]: { ...cur, ...p } });
  };

  const pending = seed.filter(r => !review[r.id]?.decision);
  const decided = seed.length - pending.length;
  const pipeline = PIPELINE_BASE[companyId].map(s =>
    s.stage === 'Review' ? { ...s, count: Math.max(0, s.count - decided) + uploaded.length * 0 }
    : s.stage === 'Live' ? { ...s, count: s.count + seed.filter(r => review[r.id]?.decision === 'approved').length }
    : s.stage === 'Ingest' ? { ...s, count: s.count + uploaded.length }
    : s
  );

  const handleUpload = () => {
    setUploaded(u => [...u, `Uploaded document ${u.length + 1}.pdf`]);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-6">
      <PageHeader title="Ingestion & Sources" subtitle="Connect knowledge sources — every document is auto-tagged Entity × Audience × Type, scored, and human-reviewed before going live." />

      {/* Connected sources */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Connected sources</h3>
          <span className="text-xs text-slate-500">{sources.filter(s => s.status === 'connected').length} of {sources.length} healthy</span>
        </div>
        <table className="w-full text-sm text-slate-300">
          <thead className="bg-slate-900 border-b border-slate-800">
            <tr>
              <th className={th}>Source</th>
              <th className={th}>Kind</th>
              <th className={th}>Status</th>
              <th className={th}>Docs synced</th>
              <th className={th}>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {sources.map(s => {
              const st = statusStyle[s.status];
              return (
                <tr key={s.name} className="border-b border-slate-800/60">
                  <td className={`${td} text-white font-medium`}>{s.name}</td>
                  <td className={`${td} text-xs text-slate-400`}>{s.kind}</td>
                  <td className={td}>
                    <span className={`flex items-center gap-1.5 text-xs ${st.text}`}>
                      <span className={`w-2 h-2 rounded-full ${st.dot}`} />{st.label}
                    </span>
                    {s.note && <p className="text-[11px] text-slate-500 mt-0.5">{s.note}</p>}
                  </td>
                  <td className={td}>{s.docs > 0 ? s.docs.toLocaleString() : '—'}</td>
                  <td className={`${td} text-xs text-slate-400`}>{s.lastSync}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pipeline */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 mb-6">
        <h3 className="text-sm font-semibold text-white mb-4">Processing pipeline</h3>
        <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
          {pipeline.map((s, i) => (
            <React.Fragment key={s.stage}>
              <div className={`flex-1 min-w-[110px] rounded-xl border p-3 ${s.stage === 'Live' ? 'border-emerald-500/30 bg-emerald-500/5' : s.stage === 'Review' ? 'border-amber-500/30 bg-amber-500/5' : 'border-slate-800 bg-slate-950'}`}>
                <p className={`text-xs font-semibold ${s.stage === 'Live' ? 'text-emerald-400' : s.stage === 'Review' ? 'text-amber-400' : 'text-slate-300'}`}>{s.stage}</p>
                <p className="text-xl font-bold text-white mt-1">{s.count}</p>
                <p className="text-[10px] text-slate-500 mt-0.5 leading-tight">{s.desc}</p>
              </div>
              {i < pipeline.length - 1 && <span className="self-center text-slate-600">→</span>}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Review queue */}
        <div className="xl:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Human review queue</h3>
            <span className="text-xs text-slate-500">{pending.length} awaiting review</span>
          </div>
          <div className="divide-y divide-slate-800/60">
            {seed.map(r => {
              const st = review[r.id];
              const decision = st?.decision;
              return (
                <div key={r.id} className={`p-4 ${decision ? 'opacity-60' : ''}`}>
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <p className="text-sm font-medium text-white">{r.title}</p>
                      <p className="text-xs text-slate-500 mt-0.5">from {r.source} · auto-confidence {r.confidence}%</p>
                    </div>
                    {decision ? (
                      <span className={`text-xs px-2 py-1 rounded-full ${decision === 'approved' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                        {decision === 'approved' ? 'Approved — publishing' : 'Rejected'}
                      </span>
                    ) : (
                      <div className="flex gap-2 flex-shrink-0">
                        <button onClick={() => patch(r.id, { decision: 'approved' })} className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white">Approve</button>
                        <button onClick={() => patch(r.id, { decision: 'rejected' })} className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:border-red-500/50 hover:text-red-400">Reject</button>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {([
                      { label: 'Entity', value: st?.entity ?? r.entity, opts: ['Customer', 'Vendor', 'Workforce'], key: 'entity' as const },
                      { label: 'Audience', value: st?.audience ?? r.audience, opts: ['All DEs', 'Customer DEs', 'Specialist DEs', 'Humans only'], key: 'audience' as const },
                      { label: 'Type', value: st?.type ?? r.type, opts: [...K_TYPES], key: 'type' as const },
                    ]).map(f => (
                      <label key={f.label} className="flex items-center gap-1.5">
                        <span className="text-[10px] uppercase tracking-wide text-slate-500">{f.label}</span>
                        <select
                          disabled={!!decision}
                          value={f.value}
                          onChange={e => patch(r.id, { [f.key]: e.target.value } as any)}
                          className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-slate-600 disabled:opacity-60">
                          {f.opts.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Upload dropzone */}
        <div className="space-y-4">
          <button
            onClick={handleUpload}
            className="w-full rounded-2xl border-2 border-dashed border-slate-700 hover:border-indigo-500/50 bg-slate-900/30 p-8 text-center transition-colors group">
            <div className="w-10 h-10 mx-auto rounded-xl bg-slate-800 group-hover:bg-indigo-500/20 flex items-center justify-center text-lg mb-3 transition-colors">↑</div>
            <p className="text-sm font-medium text-slate-200">Drop files to ingest</p>
            <p className="text-xs text-slate-500 mt-1">PDF, DOCX, MD, HTML — auto-classified into the pipeline</p>
          </button>
          {uploaded.length > 0 && (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Just added</p>
              <div className="space-y-2">
                {uploaded.map(u => (
                  <div key={u} className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2">
                    <span className="text-xs text-slate-300">{u}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400">Ingesting…</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default KnowledgeIngestionPage;
