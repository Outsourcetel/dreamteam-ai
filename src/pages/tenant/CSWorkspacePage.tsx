import React, { useState } from 'react';
import type { AuthUser, Tenant } from '../../types';

const CSWorkspacePage = ({
  user,
  tenant,
}: {
  user?: AuthUser;
  tenant?: Tenant;
}) => {
  const accent = tenant?.primaryColor || '#06b6d4';
  const [timeRange, setTimeRange] = useState('30d');
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);

  const accounts = [
    { id: 'a1', name: 'Meridian Corp', csm: 'Elena V.', arr: 84000, health: 32, risk: 'critical', renewalDays: 87, lastActivity: '18 days ago', nps: 4, tickets: 12, usagePct: 28, deEngaged: false, signals: ['No exec activity 18d', 'Support tickets +340%', 'Usage down 72%'] },
    { id: 'a2', name: 'Oaktree Financial', csm: 'Elena V.', arr: 52000, health: 45, risk: 'high', renewalDays: 112, lastActivity: '8 days ago', nps: 6, tickets: 7, usagePct: 51, deEngaged: true, signals: ['Support spike', 'QBR overdue 6 weeks'] },
    { id: 'a3', name: 'Novus Systems', csm: 'James O.', arr: 36000, health: 58, risk: 'medium', renewalDays: 204, lastActivity: '3 days ago', nps: 7, tickets: 2, usagePct: 61, deEngaged: true, signals: ['Usage dropped 60%', 'Champion changed role'] },
    { id: 'a4', name: 'Apex Retail', csm: 'Sarah M.', arr: 29000, health: 71, risk: 'medium', renewalDays: 14, lastActivity: '1 day ago', nps: 8, tickets: 1, usagePct: 79, deEngaged: true, signals: ['Renewal in 14 days'] },
    { id: 'a5', name: 'Clearstream BV', csm: 'James O.', arr: 18000, health: 82, risk: 'low', renewalDays: 241, lastActivity: 'Today', nps: 9, tickets: 0, usagePct: 88, deEngaged: true, signals: [] },
    { id: 'a6', name: 'TechCore Inc', csm: 'Sarah M.', arr: 67000, health: 91, risk: 'low', renewalDays: 156, lastActivity: 'Today', nps: 10, tickets: 1, usagePct: 94, deEngaged: true, signals: [] },
    { id: 'a7', name: 'Pinnacle Group', csm: 'Elena V.', arr: 43000, health: 76, risk: 'low', renewalDays: 189, lastActivity: '2 days ago', nps: 8, tickets: 3, usagePct: 81, deEngaged: true, signals: [] },
    { id: 'a8', name: 'Delta Logistics', csm: 'James O.', arr: 31000, health: 63, risk: 'medium', renewalDays: 62, lastActivity: '5 days ago', nps: 7, tickets: 4, usagePct: 67, deEngaged: false, signals: ['QBR not scheduled', 'Usage stagnant 3 weeks'] },
  ];

  const healthColor = (h: number) =>
    h >= 75 ? 'text-emerald-400' : h >= 50 ? 'text-amber-400' : 'text-red-400';

  const healthBg = (h: number) =>
    h >= 75 ? 'bg-emerald-500' : h >= 50 ? 'bg-amber-500' : 'bg-red-500';

  const riskBadge = (r: string) => ({
    critical: 'bg-red-500/20 text-red-400 border border-red-500/30',
    high: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
    medium: 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
    low: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
  }[r] || '');

  const totalArr = accounts.reduce((s, a) => s + a.arr, 0);
  const atRiskArr = accounts.filter(a => a.risk === 'critical' || a.risk === 'high').reduce((s, a) => s + a.arr, 0);
  const avgHealth = Math.round(accounts.reduce((s, a) => s + a.health, 0) / accounts.length);
  const renewingSoon = accounts.filter(a => a.renewalDays <= 90).length;

  const qbrPipeline = [
    { account: 'Meridian Corp', csm: 'Elena V.', dueDate: 'Overdue 6 weeks', status: 'overdue', prep: 15 },
    { account: 'Oaktree Financial', csm: 'Elena V.', dueDate: 'Due this week', status: 'urgent', prep: 40 },
    { account: 'Delta Logistics', csm: 'James O.', dueDate: 'Due in 2 weeks', status: 'pending', prep: 70 },
    { account: 'Novus Systems', csm: 'James O.', dueDate: 'Due in 3 weeks', status: 'pending', prep: 85 },
    { account: 'Apex Retail', csm: 'Sarah M.', dueDate: 'Scheduled Jul 18', status: 'scheduled', prep: 100 },
  ];

  const deActivity = [
    { de: 'CS Account DE', actions: 284, accounts: 6, topAction: 'Check-in emails', timeSaved: '18h' },
    { de: 'Support DE', actions: 142, accounts: 8, topAction: 'Ticket triage', timeSaved: '9h' },
    { de: 'Onboarding DE', actions: 67, accounts: 3, topAction: 'Feature walkthroughs', timeSaved: '5h' },
  ];

  const selectedAcc = accounts.find(a => a.id === selectedAccount);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Customer Success Workspace</h1>
          <p className="text-slate-400 text-sm mt-1">Account health, renewals, QBR pipeline, and DE-assisted engagement</p>
        </div>
        <div className="flex items-center gap-2">
          {['7d', '30d', '90d'].map(r => (
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
          { label: 'Total ARR Managed', value: `$${(totalArr / 1000).toFixed(0)}K`, sub: `${accounts.length} accounts`, icon: '$', trend: '+12% YoY', up: true },
          { label: 'ARR at Risk', value: `$${(atRiskArr / 1000).toFixed(0)}K`, sub: `${accounts.filter(a => ['critical','high'].includes(a.risk)).length} accounts flagged`, icon: '⚠', trend: 'Needs attention', up: false },
          { label: 'Avg Health Score', value: `${avgHealth}`, sub: 'Across all accounts', icon: '◎', trend: avgHealth >= 70 ? 'Healthy' : 'Below target', up: avgHealth >= 70 },
          { label: 'Renewals in 90 Days', value: String(renewingSoon), sub: `${accounts.filter(a => a.renewalDays <= 30).length} critical`, icon: '↻', trend: 'Require action', up: false },
        ].map((k, i) => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
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
        {/* Account Health Table */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Account Health Overview</h2>
            <span className="text-xs text-slate-500">Click a row to see signals</span>
          </div>
          <div className="space-y-2">
            {accounts.map(acc => (
              <div
                key={acc.id}
                onClick={() => setSelectedAccount(selectedAccount === acc.id ? null : acc.id)}
                className={`p-3 rounded-lg cursor-pointer transition-all ${selectedAccount === acc.id ? 'bg-slate-700/60 border border-slate-600' : 'hover:bg-slate-800/50'}`}
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold text-white">{acc.name}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${riskBadge(acc.risk)}`}>{acc.risk}</span>
                      {!acc.deEngaged && <span className="text-xs text-amber-400">No DE</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${healthBg(acc.health)}`} style={{ width: `${acc.health}%` }} />
                      </div>
                      <span className={`text-xs font-medium w-8 ${healthColor(acc.health)}`}>{acc.health}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-xs text-white font-medium">${(acc.arr / 1000).toFixed(0)}K</div>
                    <div className="text-xs text-slate-500">{acc.renewalDays}d renewal</div>
                  </div>
                </div>
                {selectedAccount === acc.id && acc.signals.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-slate-700 space-y-1">
                    {acc.signals.map((s, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="text-amber-400">!</span>
                        <span className="text-slate-400">{s}</span>
                      </div>
                    ))}
                    <div className="flex gap-2 mt-2">
                      <button className="text-xs px-2 py-1 rounded text-white transition-all" style={{ backgroundColor: accent }}>
                        Assign CS DE
                      </button>
                      <button className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300 hover:bg-slate-600 transition-all">
                        Schedule QBR
                      </button>
                      <button className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300 hover:bg-slate-600 transition-all">
                        View Account
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* QBR Pipeline */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">QBR Pipeline</h2>
          <div className="space-y-3">
            {qbrPipeline.map((q, i) => {
              const statusStyle = {
                overdue: 'text-red-400 bg-red-400/10',
                urgent: 'text-orange-400 bg-orange-400/10',
                pending: 'text-amber-400 bg-amber-400/10',
                scheduled: 'text-emerald-400 bg-emerald-400/10',
              }[q.status];
              return (
                <div key={i} className="p-3 bg-slate-800/50 rounded-lg space-y-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-xs font-semibold text-white">{q.account}</div>
                      <div className="text-xs text-slate-500">{q.csm}</div>
                    </div>
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${statusStyle}`}>{q.dueDate}</span>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>Prep</span><span className="text-white">{q.prep}%</span>
                    </div>
                    <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-indigo-500" style={{ width: `${q.prep}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <button className="mt-4 w-full py-2 text-xs text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-all">
            + Schedule QBR
          </button>
        </div>
      </div>

      {/* DE Activity */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6">
        <h2 className="text-sm font-semibold text-white mb-4">Digital Employee CS Activity</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {deActivity.map((de, i) => (
            <div key={i} className="bg-slate-800/50 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ backgroundColor: accent + '30', color: accent }}>
                  {de.de[0]}
                </div>
                <span className="text-xs font-semibold text-white">{de.de}</span>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">Actions this month</span><span className="text-white font-medium">{de.actions}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Accounts touched</span><span className="text-white">{de.accounts}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Top action</span><span className="text-white">{de.topAction}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Time saved</span><span className="text-emerald-400 font-medium">{de.timeSaved}</span></div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Renewal Risk Timeline */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-4">Renewal Risk Timeline</h2>
        <div className="space-y-2">
          {accounts
            .filter(a => a.renewalDays <= 250)
            .sort((a, b) => a.renewalDays - b.renewalDays)
            .map((acc, i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="w-32 text-xs text-slate-400 flex-shrink-0">{acc.name}</div>
                <div className="flex-1 h-4 bg-slate-800 rounded-full overflow-hidden relative">
                  <div
                    className={`h-full rounded-full ${healthBg(acc.health)}`}
                    style={{ width: `${Math.max(5, 100 - (acc.renewalDays / 250) * 100)}%` }}
                  />
                </div>
                <div className="w-16 text-xs text-right flex-shrink-0">
                  <span className={healthColor(acc.health)}>{acc.renewalDays}d</span>
                </div>
                <div className="w-20 text-xs text-slate-400 text-right flex-shrink-0">${(acc.arr / 1000).toFixed(0)}K ARR</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
};

export default CSWorkspacePage;
