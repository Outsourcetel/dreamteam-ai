import React, { useState } from 'react';
import type { AuthUser, Tenant } from '../../types';

type EventType = 'all' | 'user' | 'digital_employee' | 'knowledge' | 'approval' | 'security' | 'finance';

interface AuditEvent {
  id: string;
  ts: string;
  actor: string;
  actorType: 'user' | 'digital_employee' | 'system';
  eventType: Exclude<EventType, 'all'>;
  action: string;
  detail: string;
  status: 'success' | 'blocked' | 'escalated' | 'pending';
  ip?: string;
}

const mockEvents: AuditEvent[] = [
  { id: 'e1',  ts: '2026-07-01 14:42:11', actor: 'Support Specialist', actorType: 'digital_employee', eventType: 'digital_employee', action: 'Conversation resolved', detail: 'Resolved password reset for customer #8821 — confidence 94%', status: 'success' },
  { id: 'e2',  ts: '2026-07-01 14:39:04', actor: 'Sarah Mitchell', actorType: 'user', eventType: 'approval', action: 'Approval granted', detail: 'Approved credit of $450 to account #7712 (APR-441)', status: 'success', ip: '185.23.11.4' },
  { id: 'e3',  ts: '2026-07-01 14:31:58', actor: 'Billing Specialist', actorType: 'digital_employee', eventType: 'finance', action: 'Action blocked — awaiting approval', detail: 'Issue $450 credit to account #7712 — routed for human approval', status: 'pending' },
  { id: 'e4',  ts: '2026-07-01 14:28:33', actor: 'James Okafor', actorType: 'user', eventType: 'knowledge', action: 'Article published', detail: 'Published "Refund Policy v2" to Knowledge Hub', status: 'success', ip: '91.44.202.17' },
  { id: 'e5',  ts: '2026-07-01 14:22:10', actor: 'Compliance Officer', actorType: 'digital_employee', eventType: 'security', action: 'Policy flag raised', detail: 'Flagged response containing PII — escalated before delivery', status: 'escalated' },
  { id: 'e6',  ts: '2026-07-01 14:18:47', actor: 'Priya Nair', actorType: 'user', eventType: 'user', action: 'User role updated', detail: 'Changed James Okafor from tenant_user to tenant_manager', status: 'success', ip: '91.44.202.18' },
  { id: 'e7',  ts: '2026-07-01 14:11:03', actor: 'IT Helpdesk Specialist', actorType: 'digital_employee', eventType: 'digital_employee', action: 'Conversation escalated', detail: 'Could not resolve VPN issue — confidence 41% — sent to human', status: 'escalated' },
  { id: 'e8',  ts: '2026-07-01 14:04:29', actor: 'Tom Bergmann', actorType: 'user', eventType: 'user', action: 'Login', detail: 'Signed in from new device', status: 'success', ip: '62.153.88.22' },
  { id: 'e9',  ts: '2026-07-01 13:58:11', actor: 'Finance Analyst', actorType: 'digital_employee', eventType: 'finance', action: 'Exception detected', detail: 'Transaction TXN-9182 flagged — $12,400 variance vs expected range', status: 'escalated' },
  { id: 'e10', ts: '2026-07-01 13:51:44', actor: 'Knowledge Curator', actorType: 'digital_employee', eventType: 'knowledge', action: 'Knowledge gap detected', detail: '14 customers asked about "Refund Policy v2" — no article found', status: 'success' },
  { id: 'e11', ts: '2026-07-01 13:42:17', actor: 'Sarah Mitchell', actorType: 'user', eventType: 'approval', action: 'Approval denied', detail: 'Denied archive of 3 policy documents (APR-439) — pending legal review', status: 'blocked', ip: '185.23.11.4' },
  { id: 'e12', ts: '2026-07-01 13:35:09', actor: 'Onboarding Specialist', actorType: 'digital_employee', eventType: 'digital_employee', action: 'Onboarding task completed', detail: 'Sent welcome pack and tool access guide to Sarah Mitchell', status: 'success' },
  { id: 'e13', ts: '2026-07-01 13:28:53', actor: 'System', actorType: 'system', eventType: 'security', action: 'Failed login attempt', detail: '3 consecutive failures for unknown@example.com — account not found', status: 'blocked' },
  { id: 'e14', ts: '2026-07-01 13:19:31', actor: 'Priya Nair', actorType: 'user', eventType: 'user', action: 'Digital Employee enabled', detail: 'Enabled HR Advisor from catalog for HR & People department', status: 'success', ip: '91.44.202.18' },
  { id: 'e15', ts: '2026-07-01 12:58:04', actor: 'HR Advisor', actorType: 'digital_employee', eventType: 'digital_employee', action: 'Sensitive topic routed', detail: 'HR question re: disciplinary procedure escalated to HR team', status: 'escalated' },
  { id: 'e16', ts: '2026-07-01 12:41:22', actor: 'James Okafor', actorType: 'user', eventType: 'knowledge', action: 'Connector synced', detail: 'Confluence connector synced 847 articles to Knowledge Hub', status: 'success', ip: '91.44.202.17' },
  { id: 'e17', ts: '2026-07-01 12:22:17', actor: 'Compliance Officer', actorType: 'digital_employee', eventType: 'security', action: 'Unauthorized action blocked', detail: 'Blocked attempt to export customer list without approval', status: 'blocked' },
  { id: 'e18', ts: '2026-07-01 12:08:49', actor: 'Tom Bergmann', actorType: 'user', eventType: 'finance', action: 'Finance report viewed', detail: 'Accessed Q2 reconciliation report', status: 'success', ip: '62.153.88.22' },
];

const TYPE_LABELS: Record<Exclude<EventType, 'all'>, string> = {
  user: 'User Action',
  digital_employee: 'Digital Employee',
  knowledge: 'Knowledge',
  approval: 'Approval',
  security: 'Security',
  finance: 'Finance',
};

const STATUS_STYLE: Record<AuditEvent['status'], string> = {
  success: 'text-emerald-400 bg-emerald-400/10',
  blocked: 'text-red-400 bg-red-400/10',
  escalated: 'text-amber-400 bg-amber-400/10',
  pending: 'text-blue-400 bg-blue-400/10',
};

const TYPE_COLOR: Record<Exclude<EventType, 'all'>, string> = {
  user: 'text-indigo-400 bg-indigo-400/10',
  digital_employee: 'text-violet-400 bg-violet-400/10',
  knowledge: 'text-emerald-400 bg-emerald-400/10',
  approval: 'text-amber-400 bg-amber-400/10',
  security: 'text-red-400 bg-red-400/10',
  finance: 'text-blue-400 bg-blue-400/10',
};

const ACTOR_ICON: Record<AuditEvent['actorType'], string> = {
  user: '◉',
  digital_employee: '⚡',
  system: '⊟',
};

const AuditLogPage = ({ user, tenant }: { user?: AuthUser; tenant?: Tenant }) => {
  const [filter, setFilter] = useState<EventType>('all');
  const [search, setSearch] = useState('');

  const filtered = mockEvents.filter(e => {
    const matchType = filter === 'all' || e.eventType === filter;
    const matchSearch = !search || e.actor.toLowerCase().includes(search.toLowerCase()) || e.action.toLowerCase().includes(search.toLowerCase()) || e.detail.toLowerCase().includes(search.toLowerCase());
    return matchType && matchSearch;
  });

  const counts = mockEvents.reduce<Record<string, number>>((acc, e) => {
    acc[e.eventType] = (acc[e.eventType] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">Audit Log</h1>
            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs">Demo data</span>
          </div>
          <p className="text-slate-400 text-sm mt-1">Complete record of user actions, Digital Employee decisions, and security events</p>
        </div>
        <button className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 text-sm hover:bg-slate-700 transition-all">
          ↓ Export CSV
        </button>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        {(Object.entries(TYPE_LABELS) as [Exclude<EventType,'all'>, string][]).map(([type, label]) => (
          <button key={type} onClick={() => setFilter(filter === type ? 'all' : type)}
            className={`p-3 rounded-xl border transition-all text-left ${filter === type ? 'border-transparent' : 'border-slate-800 hover:border-slate-700 bg-slate-900'}`}
            style={filter === type ? { backgroundColor: '#1e293b', borderColor: '#6366f1' } : {}}>
            <div className="text-lg font-bold text-white">{counts[type] || 0}</div>
            <div className="text-xs text-slate-500">{label}</div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search actor, action, or detail..."
          className="flex-1 max-w-sm bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
          {(['all', 'user', 'digital_employee', 'knowledge', 'approval', 'security', 'finance'] as EventType[]).map(t => (
            <button key={t} onClick={() => setFilter(t)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all capitalize whitespace-nowrap ${filter === t ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>
              {t === 'all' ? 'All' : t === 'digital_employee' ? 'DE' : TYPE_LABELS[t as Exclude<EventType,'all'>]}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-500">{filtered.length} events</span>
      </div>

      {/* Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="grid grid-cols-12 gap-4 px-4 py-3 border-b border-slate-800 text-xs font-medium text-slate-500 uppercase tracking-wide">
          <div className="col-span-2">Timestamp</div>
          <div className="col-span-2">Actor</div>
          <div className="col-span-1">Type</div>
          <div className="col-span-2">Action</div>
          <div className="col-span-4">Detail</div>
          <div className="col-span-1">Status</div>
        </div>
        <div className="divide-y divide-slate-800/50">
          {filtered.map(e => (
            <div key={e.id} className="grid grid-cols-12 gap-4 px-4 py-3 hover:bg-slate-800/30 transition-all items-start">
              <div className="col-span-2 text-xs text-slate-500 font-mono pt-0.5">{e.ts.split(' ')[1]}<br /><span className="text-slate-700">{e.ts.split(' ')[0]}</span></div>
              <div className="col-span-2 flex items-start gap-2">
                <span className="text-slate-500 text-xs mt-0.5">{ACTOR_ICON[e.actorType]}</span>
                <div>
                  <div className="text-xs text-white font-medium leading-tight">{e.actor}</div>
                  <div className="text-xs text-slate-600 capitalize">{e.actorType.replace('_', ' ')}</div>
                </div>
              </div>
              <div className="col-span-1">
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${TYPE_COLOR[e.eventType]}`}>
                  {TYPE_LABELS[e.eventType].split(' ')[0]}
                </span>
              </div>
              <div className="col-span-2 text-xs text-slate-300 font-medium leading-snug">{e.action}</div>
              <div className="col-span-4 text-xs text-slate-500 leading-snug">{e.detail}{e.ip && <span className="ml-2 text-slate-700">· {e.ip}</span>}</div>
              <div className="col-span-1">
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${STATUS_STYLE[e.status]}`}>
                  {e.status}
                </span>
              </div>
            </div>
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="py-12 text-center text-slate-600 text-sm">No events match your filter</div>
        )}
      </div>

      <div className="mt-4 text-xs text-slate-600 text-center">
        Showing {filtered.length} of {mockEvents.length} events · Real-time audit trail connects when live Supabase data is available
      </div>
    </div>
  );
};

export default AuditLogPage;
