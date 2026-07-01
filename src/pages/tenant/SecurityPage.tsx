import React, { useState } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { Badge, StatCard, PageTabs, ADMIN_TABS } from '../../components';
import { supabase } from '../../supabase';

const SecurityPage = ({
  user,
  tenant,
  page,
  setPage,
}: {
  user?: AuthUser;
  tenant?: Tenant;
  page: Page;
  setPage: (p: Page) => void;
}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [activeTab, setActiveTab] = useState<'overview' | 'rbac' | 'audit' | 'compliance' | 'approvals'>('overview');

  const auditLogs = [
    { time: '10:42 AM', user: 'Morgan Chen', action: 'Approved credit request for customer Emily Carter ($350)', type: 'approval', severity: 'info' },
    { time: '10:38 AM', user: 'Support Agent', action: 'Attempted password reset for customer James Liu — awaiting approval', type: 'agent_action', severity: 'warn' },
    { time: '10:21 AM', user: 'Taylor Smith', action: 'Added new team member with manager role', type: 'admin', severity: 'info' },
    { time: '9:55 AM', user: 'Billing Agent', action: 'Issued $120 credit to account 7712 within auto-approve limit', type: 'agent_action', severity: 'info' },
    { time: '9:30 AM', user: 'Morgan Chen', action: 'Exported full tenant data backup', type: 'admin', severity: 'warn' },
    { time: '9:10 AM', user: 'IT Helpdesk Agent', action: 'Provisioned software access for new hire Sarah M.', type: 'agent_action', severity: 'info' },
  ];

  const teamMembers = [
    { name: 'Morgan Chen', email: 'morgan@acme.com', role: 'tenant_owner', lastActive: '2 min ago' },
    { name: 'Taylor Smith', email: 'taylor@acme.com', role: 'tenant_admin', lastActive: '1 hr ago' },
    { name: 'Quinn Park', email: 'quinn@acme.com', role: 'tenant_manager', lastActive: '3 hr ago' },
    { name: 'Drew Wilson', email: 'drew@acme.com', role: 'tenant_user', lastActive: '1 day ago' },
    { name: 'Sarah Martinez', email: 'sarah@acme.com', role: 'tenant_user', lastActive: '3 days ago' },
  ];

  const severityColor: Record<string, string> = {
    info: 'text-blue-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
  };

  const [adminPending, setAdminPending] = useState([
    { id: 'aa1', action: 'Reset 2FA and send recovery codes', agent: 'Security Agent', tenant: 'Globex Corp', confidence: 88, risk: 'high', requestedAt: '12 min ago' },
    { id: 'aa2', action: 'Issue $500 service credit', agent: 'Billing Agent', tenant: 'Acme Corp', confidence: 91, risk: 'medium', requestedAt: '40 min ago' },
    { id: 'aa3', action: 'Delete inactive user account', agent: 'Account Agent', tenant: 'Initech', confidence: 96, risk: 'high', requestedAt: '1 hr ago' },
  ]);
  const [adminDecisionLog, setAdminDecisionLog] = useState<any[]>([]);
  const [adminDecidingId, setAdminDecidingId] = useState<string | null>(null);
  const [adminToast, setAdminToast] = useState<any>(null);

  const handleAdminDecision = async (item: any, decision: string) => {
    setAdminDecidingId(item.id);
    const decidedAt = new Date();
    const deciderName = user && user.name ? user.name : 'Admin';
    try {
      await supabase.from('agent_actions').insert({
        action: item.action,
        agent: item.agent,
        tenant: item.tenant,
        confidence: item.confidence,
        risk: item.risk,
        status: decision,
        decided_by: deciderName,
        decided_at: decidedAt.toISOString(),
      });
    } catch (e) { /* audit table optional in demo */ }
    setAdminPending((prev) => prev.filter((x) => x.id !== item.id));
    setAdminDecisionLog((prev) => [
      { ...item, decision, deciderName, decidedAtLabel: decidedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
      ...prev,
    ]);
    setAdminDecidingId(null);
    setAdminToast({ decision, action: item.action });
    setTimeout(() => setAdminToast(null), 3200);
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={ADMIN_TABS} page={page} setPage={setPage} accentColor={accentColor} />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Security and RBAC</h1>
          <p className="text-slate-400 text-sm mt-1">
            Access control, audit logging, and compliance for your AI platform
          </p>
        </div>
        <div className="flex gap-1 bg-slate-800 rounded-xl p-1">
          {(['overview', 'rbac', 'approvals', 'audit', 'compliance'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all capitalize ${
                activeTab === t ? 'text-white' : 'text-slate-400 hover:text-white'
              }`}
              style={activeTab === t ? { backgroundColor: accentColor } : {}}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Team Members" value={String(teamMembers.length)} icon="👥" color="blue" />
            <StatCard label="Active Sessions" value="3" icon="🔐" color="emerald" />
            <StatCard label="Audit Events Today" value="47" icon="📋" color="indigo" />
            <StatCard label="Compliance Score" value="98%" icon="✅" color="amber" trend="Enterprise grade" />
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Security Posture</h2>
            <div className="space-y-3">
              {[
                { label: 'Data Encryption at rest and in transit', status: 'pass' },
                { label: 'Multi-Factor Authentication enabled', status: 'pass' },
                { label: 'RBAC roles correctly configured', status: 'pass' },
                { label: 'Agent action approval flows active', status: 'pass' },
                { label: 'Audit logging enabled', status: 'pass' },
                { label: 'SSO integration configured', status: 'warn' },
                { label: 'IP allowlist configured', status: 'warn' },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-xl">
                  <span className={`text-sm ${item.status === 'pass' ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {item.status === 'pass' ? 'v' : '!'}
                  </span>
                  <span className="text-sm text-white flex-1">{item.label}</span>
                  <Badge
                    label={item.status === 'pass' ? 'Pass' : 'Review'}
                    color={item.status === 'pass' ? 'green' : 'yellow'}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'rbac' && (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Team Members and Roles</h2>
              <button
                className="text-xs px-3 py-1.5 text-white rounded-lg"
                style={{ backgroundColor: accentColor }}
              >
                Invite Member
              </button>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Member', 'Email', 'Role', 'Last Active'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {teamMembers.map((m, i) => (
                  <tr key={i} className="hover:bg-slate-800/30 transition-all">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white"
                          style={{ backgroundColor: accentColor + '60' }}
                        >
                          {m.name.split(' ').map((n) => n[0]).join('')}
                        </div>
                        <span className="text-sm text-white">{m.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">{m.email}</td>
                    <td className="px-4 py-3">
                      <Badge
                        label={m.role.replace('tenant_', '')}
                        color={
                          m.role === 'tenant_owner'
                            ? 'red'
                            : m.role === 'tenant_admin'
                            ? 'amber'
                            : 'blue'
                        }
                      />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{m.lastActive}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'audit' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Audit Log</h2>
            <button className="text-xs px-3 py-1.5 text-slate-400 hover:text-white bg-slate-800 rounded-lg">
              Export CSV
            </button>
          </div>
          <div className="divide-y divide-slate-800">
            {auditLogs.map((log, i) => (
              <div key={i} className="flex items-start gap-4 px-5 py-3 hover:bg-slate-800/20 transition-all">
                <span className={`text-sm mt-0.5 ${severityColor[log.severity]}`}>
                  {log.type === 'agent_action' ? '%' : log.type === 'admin' ? '*' : '?'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-slate-300">{log.user}</span>
                    <Badge
                      label={log.type.replace('_', ' ')}
                      color={log.type === 'agent_action' ? 'blue' : log.type === 'admin' ? 'purple' : 'slate'}
                    />
                  </div>
                  <div className="text-xs text-slate-400">{log.action}</div>
                </div>
                <span className="text-xs text-slate-600 flex-shrink-0">{log.time}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'compliance' && (
        <>
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4 text-xs text-amber-300">
            Note: DreamTeam AI does not currently hold any of the certifications below. These represent compliance goals on our roadmap, not attained or audited certifications.
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { name: 'SOC 2 Type II', status: 'roadmap', desc: 'Not yet certified. Controls being designed.', cert: 'No audit completed' },
              { name: 'GDPR', status: 'roadmap', desc: 'Alignment in progress. Not independently verified.', cert: 'DPA not yet available' },
              { name: 'ISO 27001', status: 'roadmap', desc: 'Not yet certified.', cert: 'No certificate issued' },
              { name: 'HIPAA', status: 'roadmap', desc: 'Not supported yet. Planned for healthcare tenants.', cert: 'No BAA available' },
              { name: 'PCI DSS', status: 'roadmap', desc: 'Not yet assessed.', cert: 'No SAQ completed' },
              { name: 'CCPA', status: 'roadmap', desc: 'Alignment in progress. Not independently verified.', cert: 'Not yet attested' },
            ].map((c, i) => (
              <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-slate-300 font-bold text-sm">
                    {c.name.slice(0, 3)}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white">{c.name}</div>
                    <Badge label="On roadmap" color="slate" />
                  </div>
                </div>
                <p className="text-xs text-slate-400 mb-2">{c.desc}</p>
                <p className="text-xs text-slate-500">{c.cert}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {activeTab === 'approvals' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Agent Action Approvals</h2>
              <p className="text-xs text-slate-400 mt-1">Platform-level review of agent actions that exceeded confidence or risk thresholds</p>
            </div>
            <Badge label={adminPending.length + ' pending'} color="amber" />
          </div>
          {adminPending.length === 0 ? (
            <div className="text-center py-12 bg-slate-900 border border-slate-800 rounded-xl">
              <div className="text-3xl mb-2">{'✓'}</div>
              <p className="text-white font-semibold">All clear</p>
              <p className="text-slate-400 text-sm mt-1">No agent actions are awaiting review.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {adminPending.map((item) => (
                <div key={item.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-white">{item.action}</span>
                        <Badge label={item.risk + ' risk'} color={item.risk === 'high' ? 'red' : item.risk === 'medium' ? 'yellow' : 'green'} />
                      </div>
                      <div className="text-xs text-slate-400">{item.agent} · requested by {item.tenant} · {item.requestedAt}</div>
                    </div>
                    <div className="text-right ml-3">
                      <div className="text-sm font-bold text-emerald-400">{item.confidence}%</div>
                      <div className="text-xs text-slate-500">confidence</div>
                    </div>
                  </div>
                  <div className="flex gap-3 mt-3">
                    <button
                      onClick={() => handleAdminDecision(item, 'approved')}
                      disabled={adminDecidingId === item.id}
                      className="flex-1 py-2 text-sm font-medium text-white rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-all"
                    >
                      {adminDecidingId === item.id ? 'Working...' : '✓ Approve'}
                    </button>
                    <button
                      onClick={() => handleAdminDecision(item, 'rejected')}
                      disabled={adminDecidingId === item.id}
                      className="flex-1 py-2 text-sm font-medium text-white rounded-xl bg-red-600/50 hover:bg-red-600/70 disabled:opacity-50 transition-all"
                    >
                      {adminDecidingId === item.id ? 'Working...' : '✕ Reject'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {adminDecisionLog.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-slate-300 mb-3">Recent decisions</h2>
              <div className="space-y-2">
                {adminDecisionLog.map((d, idx) => (
                  <div key={d.id + '-' + idx} className="flex items-center justify-between bg-slate-900/60 border border-slate-800 rounded-lg px-4 py-2.5">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={'text-xs font-semibold px-2 py-0.5 rounded-full ' + (d.decision === 'approved' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400')}>
                        {d.decision === 'approved' ? 'Approved' : 'Rejected'}
                      </span>
                      <span className="text-sm text-white truncate">{d.action}</span>
                      <span className="text-xs text-slate-500 truncate">{d.tenant}</span>
                    </div>
                    <div className="text-xs text-slate-500 whitespace-nowrap ml-3">{d.deciderName} · {d.decidedAtLabel}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SecurityPage;
