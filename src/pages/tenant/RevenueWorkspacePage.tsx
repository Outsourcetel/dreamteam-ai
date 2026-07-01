import React, { useState } from 'react';
import type { AuthUser, Tenant } from '../../types';

const RevenueWorkspacePage = ({
  user,
  tenant,
}: {
  user?: AuthUser;
  tenant?: Tenant;
}) => {
  const [timeRange, setTimeRange] = useState('30d');
  const accent = tenant?.primaryColor || '#10b981';

  const pipeline = [
    { stage: 'Prospecting', deals: 84, value: 1240000, de: 'Sales Assist DE', deActivity: 312 },
    { stage: 'Qualification', deals: 52, value: 2180000, de: 'Sales Assist DE', deActivity: 198 },
    { stage: 'Proposal', deals: 31, value: 3650000, de: 'Sales Assist DE', deActivity: 87 },
    { stage: 'Negotiation', deals: 14, value: 2940000, de: 'Sales Assist DE', deActivity: 43 },
    { stage: 'Closed Won', deals: 22, value: 1820000, de: 'Sales Assist DE', deActivity: 211 },
  ];

  const atRisk = [
    { account: 'Meridian Corp', arr: '$84,000', signal: 'No activity 18 days', action: 'Schedule exec call', severity: 'high' },
    { account: 'Oaktree Financial', arr: '$52,000', signal: 'Support tickets up 340%', action: 'CS team review', severity: 'high' },
    { account: 'Novus Systems', arr: '$36,000', signal: 'Usage dropped 60%', action: 'DE to send check-in', severity: 'medium' },
    { account: 'Apex Retail', arr: '$29,000', signal: 'Contract renewal in 14 days', action: 'Renewal proposal ready', severity: 'medium' },
    { account: 'Clearstream BV', arr: '$18,000', signal: 'Champion left company', action: 'Identify new champion', severity: 'low' },
  ];

  const winLoss = [
    { month: 'Feb', won: 14, lost: 6 },
    { month: 'Mar', won: 18, lost: 8 },
    { month: 'Apr', won: 22, lost: 7 },
    { month: 'May', won: 19, lost: 9 },
    { month: 'Jun', won: 26, lost: 5 },
    { month: 'Jul', won: 22, lost: 4 },
  ];

  const deContributions = [
    { name: 'Sales Assist DE', metric: 'Leads qualified', value: '847', change: '+34%', desc: 'Inbound chat + CRM enrichment' },
    { name: 'Sales Assist DE', metric: 'Proposals drafted', value: '63', change: '+21%', desc: 'Auto-populated from CRM data' },
    { name: 'Sales Assist DE', metric: 'Follow-ups sent', value: '1,204', change: '+58%', desc: 'Personalised sequences' },
    { name: 'Sales Assist DE', metric: 'Time saved (hrs)', value: '284h', change: '', desc: 'vs manual equivalent this month' },
  ];

  const totalPipelineValue = pipeline.reduce((s, p) => s + p.value, 0);
  const maxValue = Math.max(...pipeline.map(p => p.value));

  const sevColor = (s: string) =>
    s === 'high' ? 'text-red-400 bg-red-400/10 border-red-500/20' :
    s === 'medium' ? 'text-amber-400 bg-amber-400/10 border-amber-500/20' :
    'text-slate-400 bg-slate-700/30 border-slate-700';

  const maxWon = Math.max(...winLoss.map(w => w.won));

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">Revenue Workspace</h1>
            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs">Demo data</span>
          </div>
          <p className="text-slate-400 text-sm mt-1">Pipeline health, Digital Employee revenue activity, and accounts at risk</p>
        </div>
        <div className="flex items-center gap-2">
          {['7d', '30d', '90d'].map((r) => (
            <button key={r} onClick={() => setTimeRange(r)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${timeRange === r ? 'text-white' : 'text-slate-400 hover:text-white bg-slate-800'}`}
              style={timeRange === r ? { backgroundColor: accent } : {}}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Pipeline', value: `$${(totalPipelineValue / 1000000).toFixed(1)}M`, sub: `${pipeline.reduce((s, p) => s + p.deals, 0)} open deals`, icon: '$', trend: '+12% vs last month', up: true },
          { label: 'Closed This Month', value: '$1.82M', sub: '22 deals won', icon: '✓', trend: '+18% vs target', up: true },
          { label: 'Win Rate', value: '76%', sub: 'Last 90 days', icon: '◎', trend: '+8% vs prior period', up: true },
          { label: 'Revenue at Risk', value: '$219K', sub: '5 accounts flagged', icon: '⚠', trend: 'Requires attention', up: false },
        ].map((k, i) => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all">
            <div className="flex items-start justify-between mb-3">
              <span className="text-lg text-slate-400">{k.icon}</span>
              <span className={`text-xs font-medium ${k.up ? 'text-emerald-400' : 'text-amber-400'}`}>{k.trend}</span>
            </div>
            <div className="text-2xl font-bold text-white mb-1">{k.value}</div>
            <div className="text-xs text-slate-400 mb-1">{k.label}</div>
            <div className="text-xs text-slate-600">{k.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Pipeline by stage */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Pipeline by Stage</h2>
          <div className="space-y-3">
            {pipeline.map((p, i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="w-28 text-xs text-slate-400 flex-shrink-0">{p.stage}</div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${(p.value / maxValue) * 100}%`, backgroundColor: accent }} />
                    </div>
                    <span className="text-xs text-white font-medium w-16 text-right">${(p.value / 1000).toFixed(0)}K</span>
                  </div>
                </div>
                <div className="text-right w-20 flex-shrink-0">
                  <div className="text-xs text-slate-400">{p.deals} deals</div>
                  <div className="text-xs text-slate-600">{p.deActivity} DE actions</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-800 flex items-center justify-between">
            <span className="text-xs text-slate-500">Total pipeline value</span>
            <span className="text-sm font-bold text-white">${(totalPipelineValue / 1000000).toFixed(2)}M</span>
          </div>
        </div>

        {/* Win/Loss trend */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Win / Loss Trend</h2>
          <div className="flex items-end gap-2 h-32 mb-3">
            {winLoss.map((w, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                <div className="w-full flex flex-col gap-0.5" style={{ height: '120px', justifyContent: 'flex-end' }}>
                  <div className="w-full rounded-sm" style={{ height: `${(w.won / maxWon) * 80}px`, backgroundColor: accent }} />
                  <div className="w-full rounded-sm bg-red-500/50" style={{ height: `${(w.lost / maxWon) * 80}px` }} />
                </div>
                <span className="text-xs text-slate-600">{w.month}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 text-xs">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm inline-block" style={{ backgroundColor: accent }} />Won</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-red-500/50 inline-block" />Lost</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue at risk */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Revenue at Risk</h2>
            <span className="text-xs text-red-400">$219K ARR exposed</span>
          </div>
          <div className="space-y-2">
            {atRisk.map((a, i) => (
              <div key={i} className={`p-3 rounded-lg border ${sevColor(a.severity)}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-white">{a.account}</span>
                  <span className="text-xs font-semibold" style={{ color: accent }}>{a.arr}</span>
                </div>
                <div className="text-xs text-slate-500 mb-1">{a.signal}</div>
                <div className="text-xs text-slate-400">→ {a.action}</div>
              </div>
            ))}
          </div>
        </div>

        {/* DE contribution to revenue */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Digital Employee Revenue Contribution</h2>
          <div className="space-y-3 mb-4">
            {deContributions.map((d, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-slate-800/40">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ backgroundColor: accent + '25', color: accent }}>S</div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-xs font-medium text-white">{d.metric}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white">{d.value}</span>
                      {d.change && <span className="text-xs text-emerald-400">{d.change}</span>}
                    </div>
                  </div>
                  <div className="text-xs text-slate-500">{d.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <div className="text-xs text-emerald-300 font-medium">Est. $47,200 revenue influenced this month</div>
            <div className="text-xs text-slate-500 mt-0.5">via qualified leads, faster proposals, and reduced churn signals</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RevenueWorkspacePage;
