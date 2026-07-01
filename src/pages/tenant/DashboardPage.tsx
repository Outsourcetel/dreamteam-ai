import React, { useState, useEffect } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { useDigitalEmployees } from '../../lib/useDigitalEmployees';
import { fetchAgentActions, approveAgentAction, rejectAgentAction } from '../../lib/api';

const DashboardPage = ({
  user,
  tenant,
  setPage,
  dbStats,
}: {
  user?: AuthUser;
  tenant?: Tenant;
  setPage?: (p: Page) => void;
  dbStats?: {
    totalConversations: number; openConversations: number; resolvedConversations: number;
    totalArticles: number; publishedArticles: number; pendingApprovals: number; autoResolved: number;
    channelBreakdown?: { chat: number; email: number; phone: number };
    sentimentBreakdown?: { positive: number; neutral: number; negative: number };
  } | null;
}) => {
  const [timeRange, setTimeRange] = useState('7d');
  const accent = tenant?.primaryColor || '#6366f1';

  // Reads from the same localStorage store as AgentWorkforcePage so
  // newly hired DEs appear here immediately without a code change.
  const { employees: storedDEs } = useDigitalEmployees(tenant?.id, []);
  const digitalEmployees = storedDEs.length > 0
    ? storedDEs.map(d => ({
        name: d.name,
        dept: d.department,
        status: d.status,
        tasks: d.tasksThisMonth,
        accuracy: d.successRate,
        load: d.status === 'active' ? Math.min(95, 30 + d.tasksThisMonth % 65) : 5,
        lastActive: d.status === 'active' ? 'recently' : 'idle',
      }))
    : [
        { name: 'Support DE', dept: 'Customer Success', status: 'active', tasks: 48, accuracy: 96, load: 82, lastActive: '30s ago' },
        { name: 'Onboarding DE', dept: 'HR', status: 'active', tasks: 23, accuracy: 99, load: 45, lastActive: '2m ago' },
        { name: 'Billing DE', dept: 'Finance', status: 'active', tasks: 31, accuracy: 98, load: 61, lastActive: '1m ago' },
        { name: 'HR Knowledge DE', dept: 'HR', status: 'active', tasks: 67, accuracy: 94, load: 91, lastActive: '15s ago' },
        { name: 'Compliance DE', dept: 'Legal', status: 'active', tasks: 15, accuracy: 97, load: 28, lastActive: '5m ago' },
        { name: 'Sales Assist DE', dept: 'Revenue', status: 'active', tasks: 19, accuracy: 92, load: 38, lastActive: '3m ago' },
        { name: 'IT Helpdesk DE', dept: 'IT', status: 'active', tasks: 88, accuracy: 95, load: 95, lastActive: '10s ago' },
        { name: 'Data Analyst DE', dept: 'Operations', status: 'idle', tasks: 4, accuracy: 100, load: 5, lastActive: '22m ago' },
      ];

  type ApprovalItem = { id: string; de: string; action: string; risk: string; age: string };
  const mockApprovals: ApprovalItem[] = [
    { id: 'APR-441', de: 'Billing DE', action: 'Issue $450 credit to account #7712', risk: 'medium', age: '18m' },
    { id: 'APR-440', de: 'HR Knowledge DE', action: 'Update vacation policy for EMEA team', risk: 'low', age: '1h' },
    { id: 'APR-439', de: 'Compliance DE', action: 'Archive 3 outdated policy documents', risk: 'low', age: '2h' },
  ];
  const [approvals, setApprovals] = useState<ApprovalItem[]>(mockApprovals);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  // Fetch real pending actions from Supabase; fall back to mock on error/empty
  useEffect(() => {
    if (!tenant?.id) return;
    fetchAgentActions(tenant.id, 10).then(actions => {
      const pending = actions.filter(a => a.requires_approval && a.status === 'pending');
      if (pending.length > 0) {
        setApprovals(pending.map(a => ({
          id: a.id,
          de: a.agent_name,
          action: a.description || a.action_type,
          risk: a.confidence_score != null ? (a.confidence_score < 0.6 ? 'high' : a.confidence_score < 0.8 ? 'medium' : 'low') : 'medium',
          age: new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })));
      }
    });
  }, [tenant?.id]);

  const handleApproval = async (id: string, decision: 'approve' | 'deny') => {
    setDecidingId(id);
    const isReal = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
    if (isReal) {
      if (decision === 'approve') await approveAgentAction(id, user?.id || 'unknown');
      else await rejectAgentAction(id, user?.id || 'unknown');
    }
    setApprovals(prev => prev.filter(a => a.id !== id));
    setDecidingId(null);
  };

  const bottlenecks = [
    { label: 'IT Helpdesk DE at 95% load', severity: 'high', action: 'Consider deploying additional capacity' },
    { label: '3 escalations unassigned >30m', severity: 'high', action: 'Assign to human agent' },
    { label: 'Knowledge gap: Refund policy v2', severity: 'medium', action: 'Article draft ready for review' },
    { label: 'Onboarding flow stalled — 2 new hires', severity: 'medium', action: 'Check connector sync status' },
  ];

  const recommendations = [
    { icon: '↑', text: 'Deploy a second IT Helpdesk DE — current load at 95%, response time degrading during peak hours.', type: 'action' },
    { icon: '◈', text: 'Knowledge coverage for "Refund Policy v2" is 0%. 12 customers asked about it this week — draft an article.', type: 'knowledge' },
    { icon: '$', text: 'Digital Employees resolved 1,140 conversations that would have cost ~$8,550 in human agent time this week.', type: 'saving' },
    { icon: '★', text: 'CSAT is up 2.1% this month. Top driver: faster first response from Support DE (avg 8s vs 4m human).', type: 'insight' },
  ];

  const knowledgeHealth = [
    { label: 'Coverage Score', value: '94%', bar: 94, color: 'emerald' },
    { label: 'Freshness Score', value: '78%', bar: 78, color: 'blue' },
    { label: 'Articles Published', value: '2,847', bar: 100, color: 'indigo' },
    { label: 'Stale (>90 days)', value: '34', bar: 12, color: 'amber' },
  ];

  const totalTasks = digitalEmployees.reduce((s, d) => s + d.tasks, 0);
  const humanTasks = 48;
  const digitalPct = Math.round((totalTasks / (totalTasks + humanTasks)) * 100);
  const activeDeCount = digitalEmployees.filter(d => d.status === 'active').length;
  const idleDeCount = digitalEmployees.filter(d => d.status === 'idle').length;
  const pendingApprovalCount = dbStats?.pendingApprovals ?? approvals.length;
  const highRiskCount = approvals.filter((a: any) => a.risk === 'high').length;

  const riskColor = (r: string) =>
    r === 'high' ? 'text-red-400 bg-red-400/10' : r === 'medium' ? 'text-amber-400 bg-amber-400/10' : 'text-emerald-400 bg-emerald-400/10';

  const sevColor = (s: string) =>
    s === 'high' ? 'border-l-red-500' : 'border-l-amber-500';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">Workforce HQ</h1>
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-400 font-medium">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
              Live
            </span>
            {!dbStats && (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs">Demo data</span>
            )}
          </div>
          <p className="text-slate-400 text-sm mt-1">Your Digital Workforce command center — {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <div className="flex items-center gap-2">
          {['24h', '7d', '30d'].map((r) => (
            <button key={r} onClick={() => setTimeRange(r)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${timeRange === r ? 'text-white' : 'text-slate-400 hover:text-white bg-slate-800'}`}
              style={timeRange === r ? { backgroundColor: accent } : {}}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Empty state for brand-new tenants */}
      {storedDEs.length === 0 && !dbStats && (
        <div className="mb-6 bg-slate-900 border border-slate-700 rounded-xl p-8">
          <div className="max-w-lg mx-auto text-center">
            <div className="text-4xl mb-3">⚡</div>
            <h2 className="text-lg font-semibold text-white mb-2">Your Digital Workforce is ready to be built</h2>
            <p className="text-slate-400 text-sm mb-6">Hire your first Digital Employee, upload your knowledge base, and invite your team — your Workforce HQ will populate automatically.</p>
            <div className="grid grid-cols-3 gap-3">
              {[
                { icon: '⚡', label: 'Hire a Digital Employee', page: 'agents' as Page, desc: 'From the pre-built catalog' },
                { icon: '◈', label: 'Upload Knowledge', page: 'hub_ingestion' as Page, desc: 'Files, URLs, or connectors' },
                { icon: '◉', label: 'Invite Your Team', page: 'users' as Page, desc: 'Add managers and approvers' },
              ].map(item => (
                <button
                  key={item.page}
                  onClick={() => setPage?.(item.page)}
                  className="bg-slate-800 hover:bg-slate-700 rounded-xl p-4 text-left transition-all border border-slate-700 hover:border-slate-600"
                >
                  <div className="text-2xl mb-2">{item.icon}</div>
                  <div className="text-xs font-semibold text-white mb-1">{item.label}</div>
                  <div className="text-xs text-slate-500">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Top KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Active Digital Employees', value: String(activeDeCount || storedDEs.length), sub: `${idleDeCount} idle · ${storedDEs.length} total`, icon: '⚡', trend: 'from your workforce', trendUp: true },
          { label: 'Digital vs Human Workload', value: `${digitalPct}%`, sub: `${totalTasks} DE tasks · ${humanTasks} human tasks`, icon: '⇌', trend: 'DE-handled this period', trendUp: true },
          { label: 'Pending Approvals', value: String(pendingApprovalCount), sub: highRiskCount > 0 ? `${highRiskCount} high risk` : 'no high risk items', icon: '⚠', trend: pendingApprovalCount > 0 ? 'require action' : 'all clear', trendUp: pendingApprovalCount === 0 },
          { label: 'Knowledge Articles', value: String(dbStats?.publishedArticles ?? '—'), sub: dbStats ? `${dbStats.totalArticles} total · ${dbStats.totalArticles - dbStats.publishedArticles} draft` : 'loading…', icon: '◈', trend: 'in your knowledge hub', trendUp: true },
        ].map((k, i) => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all">
            <div className="flex items-start justify-between mb-3">
              <span className="text-lg text-slate-400">{k.icon}</span>
              <span className={`text-xs font-medium ${k.trendUp ? 'text-emerald-400' : 'text-amber-400'}`}>{k.trend}</span>
            </div>
            <div className="text-2xl font-bold text-white mb-1">{k.value}</div>
            <div className="text-xs text-slate-400 mb-1">{k.label}</div>
            <div className="text-xs text-slate-600">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Workforce Health */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Workforce Health</h2>
            <span className="text-xs text-slate-500">{digitalEmployees.filter(d => d.status === 'active').length} active · {digitalEmployees.filter(d => d.status === 'idle').length} idle</span>
          </div>
          <div className="space-y-2">
            {digitalEmployees.map((de, i) => (
              <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-slate-800/50 transition-all">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ backgroundColor: accent + '30', color: accent }}>
                  {de.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-white">{de.name}</span>
                    <span className="text-xs text-slate-600">{de.dept}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{ width: `${de.load}%`, backgroundColor: de.load > 85 ? '#f59e0b' : accent }} />
                    </div>
                    <span className="text-xs text-slate-500 w-8">{de.load}%</span>
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-xs text-white font-medium">{de.tasks} tasks</div>
                  <div className="text-xs text-slate-500">{de.accuracy}% acc</div>
                </div>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${de.status === 'active' ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              </div>
            ))}
          </div>
        </div>

        {/* Pending Approvals */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Pending Approvals</h2>
            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-xs">{approvals.length} open</span>
          </div>
          <div className="space-y-3">
            {approvals.map((a, i) => (
              <div key={i} className="p-3 rounded-lg bg-slate-800/50 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500 font-mono">{a.id}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${riskColor(a.risk)}`}>{a.risk}</span>
                </div>
                <p className="text-xs text-slate-300">{a.action}</p>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-600">{a.de} · {a.age} ago</span>
                  <div className="flex gap-1.5">
                    <button
                      disabled={decidingId === a.id}
                      onClick={() => handleApproval(a.id, 'deny')}
                      className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300 hover:bg-red-600/50 disabled:opacity-40 transition-all"
                    >Deny</button>
                    <button
                      disabled={decidingId === a.id}
                      onClick={() => handleApproval(a.id, 'approve')}
                      className="text-xs px-2 py-1 rounded text-white disabled:opacity-40 transition-all"
                      style={{ backgroundColor: accent }}
                    >{decidingId === a.id ? '…' : 'Approve'}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {approvals.length === 0 && (
            <div className="text-center py-4 text-xs text-emerald-400">All caught up — no pending approvals</div>
          )}
          <button
            onClick={() => setPage?.('admin_approvals')}
            className="mt-3 w-full text-xs text-slate-500 hover:text-slate-300 transition-all"
          >View all approvals →</button>
        </div>
      </div>

      {/* Bottom grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Operational Bottlenecks */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Operational Bottlenecks</h2>
          <div className="space-y-2">
            {bottlenecks.map((b, i) => (
              <div key={i} className={`p-3 rounded-lg bg-slate-800/50 border-l-2 ${sevColor(b.severity)}`}>
                <div className="text-xs text-slate-300 font-medium mb-1">{b.label}</div>
                <div className="text-xs text-slate-500">{b.action}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Business Recommendations */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Business Recommendations</h2>
          <div className="space-y-3">
            {recommendations.map((r, i) => (
              <div key={i} className="flex gap-3 p-3 rounded-lg bg-slate-800/40 hover:bg-slate-800/70 transition-all">
                <span className="text-base flex-shrink-0" style={{ color: accent }}>{r.icon}</span>
                <p className="text-xs text-slate-400 leading-relaxed">{r.text}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Knowledge Health */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Knowledge Health</h2>
          <div className="space-y-4">
            {knowledgeHealth.map((k, i) => (
              <div key={i}>
                <div className="flex justify-between mb-1.5">
                  <span className="text-xs text-slate-400">{k.label}</span>
                  <span className="text-xs font-medium text-white">{k.value}</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full"
                    style={{ width: `${k.bar}%`, backgroundColor: k.color === 'emerald' ? '#10b981' : k.color === 'blue' ? '#3b82f6' : k.color === 'indigo' ? accent : '#f59e0b' }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="text-xs text-amber-300 font-medium mb-1">34 articles need review</div>
            <div className="text-xs text-slate-500">Last updated &gt;90 days ago — may be outdated</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
