import React, { useState } from 'react';
import type { AuthUser, Tenant } from '../../types';
import { Badge } from '../../components';
import MiniLineChart from '../../components/MiniLineChart';

const DashboardPage = ({
  user,
  tenant,
  dbStats,
}: {
  user?: AuthUser;
  tenant?: Tenant;
  dbStats?: {
    totalConversations: number; openConversations: number; resolvedConversations: number;
    totalArticles: number; publishedArticles: number; pendingApprovals: number; autoResolved: number;
    channelBreakdown: { chat: number; email: number; phone: number };
    sentimentBreakdown: { positive: number; neutral: number; negative: number };
  } | null;
}) => {
  const [timeRange, setTimeRange] = useState('7d');
  const accentColor = tenant?.primaryColor || '#6366f1';

  const kpiData = [
    {
      label: 'Active AI Agents',
      value: '8',
      sub: '2 pending config',
      icon: '⚡',
      color: 'indigo',
      trend: '+2 this week',
      sparkData: [4, 5, 5, 6, 7, 7, 8],
    },
    {
      label: 'Conversations Today',
      value: dbStats ? dbStats.totalConversations.toLocaleString() : '1,284',
      sub: dbStats ? `${dbStats.openConversations} open · ${dbStats.resolvedConversations} resolved` : 'Customers plus Staff',
      icon: '✉',
      color: 'blue',
      trend: '+18%',
      sparkData: [800, 950, 1050, 920, 1100, 1200, 1284],
    },
    {
      label: 'Actions Completed',
      value: '342',
      sub: 'Agent-executed tasks',
      icon: '⚙',
      color: 'emerald',
      trend: '+34%',
      sparkData: [180, 220, 260, 200, 290, 310, 342],
    },
    {
      label: 'Pending Approvals',
      value: dbStats ? String(dbStats.pendingApprovals) : '12',
      sub: dbStats ? (dbStats.pendingApprovals > 0 ? `${dbStats.pendingApprovals} require human review` : 'All caught up!') : 'Require human review',
      icon: '⚠',
      color: 'amber',
      trend: '3 urgent',
      sparkData: [5, 8, 12, 9, 11, 10, 12],
    },
    {
      label: 'KB Articles',
      value: dbStats ? dbStats.totalArticles.toLocaleString() : '2,847',
      sub: dbStats ? `${dbStats.publishedArticles} published · ${dbStats.totalArticles - dbStats.publishedArticles} drafts` : '94% coverage score',
      icon: '◈',
      color: 'purple',
      trend: '+127 this month',
      sparkData: [2100, 2300, 2450, 2600, 2700, 2790, 2847],
    },
    {
      label: 'Avg Resolution Time',
      value: '1m 24s',
      sub: 'Down from 4m 12s',
      icon: '✚',
      color: 'emerald',
      trend: '-66%',
      sparkData: [252, 210, 190, 170, 155, 140, 84],
    },
    {
      label: 'Customer Satisfaction',
      value: '94.2%',
      sub: 'Based on 1,140 ratings',
      icon: '★',
      color: 'amber',
      trend: '+2.1%',
      sparkData: [88, 90, 91, 92, 93, 93.5, 94.2],
    },
    {
      label: 'Token Usage',
      value: '2.4M',
      sub:
        'of ' +
        ((tenant?.tokenLimit || 5000000) / 1000000).toFixed(0) +
        'M limit',
      icon: '⊟',
      color: 'blue',
      trend: '48% used',
      sparkData: [300, 600, 900, 1200, 1600, 2000, 2400],
    },
  ];

  const recentActivity = [
    {
      time: '2m ago',
      agent: 'Support Agent',
      action: 'Resolved password reset for customer #8821',
      type: 'resolved',
      icon: 'v',
    },
    {
      time: '5m ago',
      agent: 'Onboarding Agent',
      action: 'Sent welcome email and setup guide to new hire Sarah M.',
      type: 'action',
      icon: '>',
    },
    {
      time: '12m ago',
      agent: 'Billing Agent',
      action: 'Generated invoice INV-2847 and dispatched to accounts',
      type: 'action',
      icon: '>',
    },
    {
      time: '18m ago',
      agent: 'Support Agent',
      action: 'Escalated ticket T-9921 — confidence below threshold',
      type: 'escalated',
      icon: '!',
    },
    {
      time: '24m ago',
      agent: 'HR Agent',
      action: 'Answered direct deposit question for 3 employees',
      type: 'resolved',
      icon: 'v',
    },
    {
      time: '31m ago',
      agent: 'Compliance Agent',
      action: 'Flagged policy update in Q3 handbook — KB refresh triggered',
      type: 'flagged',
      icon: 'f',
    },
    {
      time: '45m ago',
      agent: 'Sales Agent',
      action: 'Qualified lead from web chat and routed to CRM',
      type: 'action',
      icon: '>',
    },
    {
      time: '1h ago',
      agent: 'Billing Agent',
      action: 'Awaiting approval: Issue $450 credit to account 7712',
      type: 'pending',
      icon: 'p',
    },
  ];

  const typeColors: Record<string, string> = {
    resolved: 'text-emerald-400',
    action: 'text-blue-400',
    escalated: 'text-amber-400',
    flagged: 'text-orange-400',
    pending: 'text-purple-400',
  };

  const agentStatus = [
    { name: 'Support Agent', status: 'active', tasks: 48, accuracy: 96, icon: 'A' },
    { name: 'Onboarding Agent', status: 'active', tasks: 23, accuracy: 99, icon: 'B' },
    { name: 'Billing Agent', status: 'active', tasks: 31, accuracy: 98, icon: 'C' },
    { name: 'HR Knowledge Agent', status: 'active', tasks: 67, accuracy: 94, icon: 'D' },
    { name: 'Compliance Agent', status: 'active', tasks: 15, accuracy: 97, icon: 'E' },
    { name: 'Sales Assist Agent', status: 'active', tasks: 19, accuracy: 92, icon: 'F' },
    { name: 'IT Helpdesk Agent', status: 'active', tasks: 88, accuracy: 95, icon: 'G' },
    { name: 'Data Analyst Agent', status: 'idle', tasks: 4, accuracy: 100, icon: 'H' },
  ];

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">Dashboard</h1>
            {dbStats && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-400 font-medium">
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                Live DB
              </span>
            )}
            {!dbStats && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs">
                Demo data
              </span>
            )}
          </div>
          <p className="text-slate-400 text-sm mt-1">
            Welcome back — here is what your AI workforce is doing right now
          </p>
        </div>
        <div className="flex items-center gap-2">
          {['24h', '7d', '30d'].map((r) => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                timeRange === r
                  ? 'text-white'
                  : 'text-slate-400 hover:text-white bg-slate-800'
              }`}
              style={timeRange === r ? { backgroundColor: accentColor } : {}}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {kpiData.map((k, i) => (
          <div
            key={i}
            className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all"
          >
            <div className="flex items-start justify-between mb-3">
              <span className="text-lg text-slate-400">{k.icon}</span>
              <span className="text-xs text-emerald-400 font-medium">
                {k.trend}
              </span>
            </div>
            <div className="text-2xl font-bold text-white mb-1">{k.value}</div>
            <div className="text-xs text-slate-400 mb-2">{k.label}</div>
            <div className="text-xs text-slate-600">{k.sub}</div>
            <div className="mt-2">
              <MiniLineChart data={k.sparkData} color={accentColor} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Agent Status</h2>
            <Badge label="8 agents" color="indigo" />
          </div>
          <div className="space-y-2">
            {agentStatus.map((a, i) => (
              <div
                key={i}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50 transition-all"
              >
                <div className="w-7 h-7 rounded-lg bg-indigo-500/20 flex items-center justify-center text-xs text-indigo-300 font-bold">
                  {a.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-white truncate">
                    {a.name}
                  </div>
                  <div className="text-xs text-slate-500">
                    {a.tasks} tasks · {a.accuracy}% acc
                  </div>
                </div>
                <div
                  className={`w-2 h-2 rounded-full ${
                    a.status === 'active' ? 'bg-emerald-400' : 'bg-slate-600'
                  }`}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">
              Live Activity Feed
            </h2>
            <span className="flex items-center gap-1.5 text-xs text-emerald-400">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
              Live
            </span>
          </div>
          <div className="space-y-3">
            {recentActivity.map((a, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 rounded-lg bg-slate-800/40 hover:bg-slate-800/70 transition-all"
              >
                <span
                  className={`text-sm mt-0.5 ${
                    typeColors[a.type] || 'text-slate-400'
                  }`}
                >
                  {a.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-slate-300">
                      {a.agent}
                    </span>
                    <span className="text-xs text-slate-600">{a.time}</span>
                  </div>
                  <div className="text-xs text-slate-400">{a.action}</div>
                </div>
                {a.type === 'pending' && (
                  <button
                    className="text-xs px-2 py-1 rounded text-white flex-shrink-0"
                    style={{ backgroundColor: accentColor }}
                  >
                    Review
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Token Usage This Month
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              2.4M of {((tenant?.tokenLimit || 5000000) / 1000000).toFixed(0)}M
              tokens used
            </p>
          </div>
          <Badge label="48% used" color="blue" />
        </div>
        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: '48%', backgroundColor: accentColor }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-slate-500">
          <span>0</span>
          <span>Resets in 18 days</span>
          <span>{((tenant?.tokenLimit || 5000000) / 1000000).toFixed(0)}M</span>
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
