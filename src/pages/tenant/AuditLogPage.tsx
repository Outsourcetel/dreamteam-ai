import React, { useState, useEffect } from 'react';
import type { AuthUser, Tenant } from '../../types';
import { fetchAuditLogs } from '../../services/auditLogService';

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

const ACTION_LABELS: Record<string, string> = {
  hire: 'Digital Employee hired',
  dismiss: 'Digital Employee dismissed',
  update: 'Record updated',
  update_role: 'Role updated',
  invite: 'User invited',
  create: 'Record created',
  delete: 'Record deleted',
  approve: 'Approved',
  reject: 'Rejected',
  login: 'Signed in',
  logout: 'Signed out',
};

function entityTypeToEventType(entityType: string): Exclude<EventType, 'all'> {
  if (entityType === 'digital_employee') return 'digital_employee';
  if (entityType === 'knowledge' || entityType === 'article') return 'knowledge';
  if (entityType === 'approval') return 'approval';
  if (entityType === 'security') return 'security';
  if (entityType === 'finance' || entityType === 'transaction') return 'finance';
  return 'user';
}

function dbRowToEvent(row: Record<string, unknown>): AuditEvent {
  const entityType = (row.entity_type as string) || 'user';
  const action = (row.action as string) || 'update';
  const entityName = (row.entity_name as string) || '';
  const afterData = row.after_data as Record<string, unknown> | null;

  let detail = entityName;
  if (afterData && Object.keys(afterData).length > 0) {
    const parts = Object.entries(afterData)
      .slice(0, 2)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    detail = entityName ? `${entityName} — ${parts}` : parts;
  }

  const actorUserId = row.actor_user_id as string | null;

  return {
    id: row.id as string,
    ts: new Date(row.created_at as string).toISOString().replace('T', ' ').slice(0, 19),
    actor: actorUserId ? actorUserId.slice(0, 8) + '…' : 'System',
    actorType: actorUserId ? 'user' : 'system',
    eventType: entityTypeToEventType(entityType),
    action: ACTION_LABELS[action] || action.replace(/_/g, ' '),
    detail: detail || entityType,
    status: 'success',
  };
}

const exportCsv = (events: AuditEvent[]) => {
  const headers = ['Timestamp', 'Actor', 'Actor Type', 'Event Type', 'Action', 'Detail', 'Status', 'IP'];
  const rows = events.map(e => [
    e.ts, e.actor, e.actorType, e.eventType, e.action,
    `"${e.detail.replace(/"/g, '""')}"`, e.status, e.ip || '',
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

const AuditLogPage = ({ user: _user, tenant }: { user?: AuthUser; tenant?: Tenant }) => {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<EventType>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!tenant?.id) { setLoading(false); return; }
    setLoading(true);
    fetchAuditLogs(tenant.id, { limit: 200 }).then(rows => {
      setEvents((rows ?? []).map(r => dbRowToEvent(r as unknown as Record<string, unknown>)));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [tenant?.id]);

  const filtered = events.filter(e => {
    const matchType = filter === 'all' || e.eventType === filter;
    const matchSearch = !search ||
      e.actor.toLowerCase().includes(search.toLowerCase()) ||
      e.action.toLowerCase().includes(search.toLowerCase()) ||
      e.detail.toLowerCase().includes(search.toLowerCase());
    return matchType && matchSearch;
  });

  const counts = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.eventType] = (acc[e.eventType] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Audit Log</h1>
          <p className="text-slate-400 text-sm mt-1">Complete record of user actions, Digital Employee decisions, and security events</p>
        </div>
        <button
          onClick={() => exportCsv(filtered)}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 text-sm hover:bg-slate-700 transition-all"
        >
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
          {loading ? (
            <div className="py-16 text-center text-slate-600 text-sm">Loading audit log…</div>
          ) : filtered.map(e => (
            <div key={e.id} className="grid grid-cols-12 gap-4 px-4 py-3 hover:bg-slate-800/30 transition-all items-start">
              <div className="col-span-2 text-xs text-slate-500 font-mono pt-0.5">
                {e.ts.split(' ')[1]}<br />
                <span className="text-slate-700">{e.ts.split(' ')[0]}</span>
              </div>
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
              <div className="col-span-4 text-xs text-slate-500 leading-snug">
                {e.detail}{e.ip && <span className="ml-2 text-slate-700">· {e.ip}</span>}
              </div>
              <div className="col-span-1">
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${STATUS_STYLE[e.status]}`}>
                  {e.status}
                </span>
              </div>
            </div>
          ))}
        </div>
        {!loading && filtered.length === 0 && (
          <div className="py-12 text-center text-slate-600 text-sm">
            {events.length === 0 ? 'No audit events yet — actions you take will appear here' : 'No events match your filter'}
          </div>
        )}
      </div>

      <div className="mt-4 text-xs text-slate-600 text-center">
        Showing {filtered.length} of {events.length} events · Live audit trail from your database
      </div>
    </div>
  );
};

export default AuditLogPage;
