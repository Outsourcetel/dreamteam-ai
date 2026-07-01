import React, { useState } from 'react';
import type { AuthUser, Tenant } from '../../types';

const HRWorkspacePage = ({
  user,
  tenant,
}: {
  user?: AuthUser;
  tenant?: Tenant;
}) => {
  const [timeRange, setTimeRange] = useState('30d');
  const accent = tenant?.primaryColor || '#8b5cf6';

  const departments = [
    { name: 'Customer Success', human: 12, digital: 2, deNames: ['Support DE', 'Onboarding DE'], load: 78 },
    { name: 'Finance', human: 6, digital: 1, deNames: ['Billing DE'], load: 61 },
    { name: 'HR & People', human: 4, digital: 1, deNames: ['HR Knowledge DE'], load: 91 },
    { name: 'Legal & Compliance', human: 3, digital: 1, deNames: ['Compliance DE'], load: 28 },
    { name: 'Revenue', human: 8, digital: 1, deNames: ['Sales Assist DE'], load: 38 },
    { name: 'IT', human: 5, digital: 1, deNames: ['IT Helpdesk DE'], load: 95 },
    { name: 'Operations', human: 7, digital: 1, deNames: ['Data Analyst DE'], load: 5 },
  ];

  const onboarding = [
    { name: 'Sarah Mitchell', role: 'Account Executive', dept: 'Revenue', day: 3, stage: 'Tools Setup', complete: 40 },
    { name: 'James Okafor', role: 'Senior Engineer', dept: 'IT', day: 7, stage: 'Team Introductions', complete: 65 },
    { name: 'Priya Nair', role: 'CS Manager', dept: 'Customer Success', day: 12, stage: 'Product Training', complete: 82 },
    { name: 'Tom Bergmann', role: 'Finance Analyst', dept: 'Finance', day: 1, stage: 'System Access', complete: 15 },
  ];

  const deWorkforceMetrics = [
    { label: 'HR queries answered', value: '1,847', de: 'HR Knowledge DE', sub: 'Policy, benefits, payroll questions', change: '+42%' },
    { label: 'Onboarding tasks automated', value: '312', de: 'Onboarding DE', sub: 'Account setup, comms, scheduling', change: '+28%' },
    { label: 'HR team hours saved', value: '94h', de: 'All DEs', sub: 'Equivalent to 2.5 FTE weeks', change: '' },
    { label: 'Employee satisfaction', value: '91%', de: 'HR survey', sub: '↑ 6% after DE deployment', change: '+6%' },
  ];

  const openRoles = [
    { title: 'Senior Product Designer', dept: 'Product', stage: 'Final interviews', candidates: 3, deAssist: true },
    { title: 'Enterprise AE', dept: 'Revenue', stage: 'Screening', candidates: 14, deAssist: true },
    { title: 'Data Engineer', dept: 'IT', stage: 'Offer stage', candidates: 1, deAssist: false },
    { title: 'Customer Success Manager', dept: 'CS', stage: 'Sourcing', candidates: 0, deAssist: true },
  ];

  const totalHuman = departments.reduce((s, d) => s + d.human, 0);
  const totalDigital = departments.reduce((s, d) => s + d.digital, 0);
  const ratio = Math.round((totalDigital / (totalHuman + totalDigital)) * 100);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">HR Workspace</h1>
            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs">Demo data</span>
          </div>
          <p className="text-slate-400 text-sm mt-1">Workforce composition, onboarding pipeline, and Digital Employee deployment across departments</p>
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
          { label: 'Human Headcount', value: String(totalHuman), sub: 'Across all departments', icon: '◉', trend: '+3 this month', up: true },
          { label: 'Digital Employees', value: String(totalDigital), sub: 'Deployed across 7 depts', icon: '⚡', trend: '+1 this month', up: true },
          { label: 'Digital Workforce Ratio', value: `${ratio}%`, sub: 'of total workforce capacity', icon: '⇌', trend: 'Up from 31% last quarter', up: true },
          { label: 'Active Onboarding', value: String(onboarding.length), sub: 'New hires in progress', icon: '→', trend: '2 completing this week', up: true },
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
        {/* Workforce by department */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Workforce by Department</h2>
          <div className="space-y-3">
            {departments.map((d, i) => {
              const totalCap = d.human + d.digital;
              const humanPct = Math.round((d.human / totalCap) * 100);
              const digitalPct = 100 - humanPct;
              return (
                <div key={i} className="flex items-center gap-4">
                  <div className="w-36 text-xs text-slate-400 flex-shrink-0 truncate">{d.name}</div>
                  <div className="flex-1">
                    <div className="flex h-2 rounded-full overflow-hidden gap-0.5">
                      <div className="h-full rounded-l-full bg-slate-600 transition-all" style={{ width: `${humanPct}%` }} />
                      <div className="h-full rounded-r-full transition-all" style={{ width: `${digitalPct}%`, backgroundColor: accent }} />
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 text-right">
                    <span className="text-xs text-slate-400 w-16">{d.human}H · {d.digital}DE</span>
                    <div className={`w-1.5 h-1.5 rounded-full ${d.load > 85 ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-slate-600 inline-block" /> Human</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm inline-block" style={{ backgroundColor: accent }} /> Digital Employee</span>
          </div>
        </div>

        {/* Onboarding pipeline */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Onboarding Pipeline</h2>
            <span className="text-xs text-slate-500">{onboarding.length} active</span>
          </div>
          <div className="space-y-3">
            {onboarding.map((o, i) => (
              <div key={i} className="p-3 rounded-lg bg-slate-800/50">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-white">{o.name}</span>
                  <span className="text-xs text-slate-500">Day {o.day}</span>
                </div>
                <div className="text-xs text-slate-500 mb-2">{o.role} · {o.dept}</div>
                <div className="flex items-center gap-2 mb-1">
                  <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${o.complete}%`, backgroundColor: accent }} />
                  </div>
                  <span className="text-xs text-slate-400 w-8">{o.complete}%</span>
                </div>
                <div className="text-xs text-slate-600">{o.stage}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 p-2 rounded-lg bg-slate-800/30 text-xs text-slate-500 text-center">
            Onboarding DE handling 40+ automated tasks
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* DE workforce metrics */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Digital Employee HR Impact</h2>
          <div className="space-y-3">
            {deWorkforceMetrics.map((m, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-slate-800/40">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ backgroundColor: accent + '25', color: accent }}>
                  {m.de[0]}
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-xs font-medium text-white">{m.label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white">{m.value}</span>
                      {m.change && <span className="text-xs text-emerald-400">{m.change}</span>}
                    </div>
                  </div>
                  <div className="text-xs text-slate-500">{m.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Open roles */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Open Roles</h2>
            <span className="text-xs text-slate-500">{openRoles.length} positions</span>
          </div>
          <div className="space-y-2">
            {openRoles.map((r, i) => (
              <div key={i} className="p-3 rounded-lg bg-slate-800/50 flex items-center gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-white">{r.title}</span>
                    {r.deAssist && (
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: accent + '25', color: accent }}>DE assisted</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">{r.dept} · {r.stage}</div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-bold text-white">{r.candidates}</div>
                  <div className="text-xs text-slate-600">candidates</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 p-3 rounded-lg bg-slate-800/30">
            <div className="text-xs text-slate-400 font-medium mb-0.5">Sales Assist DE screening Enterprise AE applicants</div>
            <div className="text-xs text-slate-600">Saved ~18 hours of initial review time this week</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HRWorkspacePage;
