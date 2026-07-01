import React, { useState, useEffect, useCallback } from 'react';
import type { AuthUser, Tenant } from '../../types';
import {
  fetchAgentActions,
  approveAgentAction,
  rejectAgentAction,
  type DBAgentAction,
} from '../../lib/api';
import { writeAuditLog } from '../../services/auditLogService';

type StatusFilter = 'pending' | 'approved' | 'rejected' | 'all';

interface ApprovalItem {
  id: string;
  deName: string;
  actionType: string;
  description: string;
  confidence: number;
  risk: 'high' | 'medium' | 'low';
  status: DBAgentAction['status'];
  age: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

function toItem(a: DBAgentAction): ApprovalItem {
  const score = a.confidence_score ?? 0.8;
  const risk: ApprovalItem['risk'] = score < 0.6 ? 'high' : score < 0.8 ? 'medium' : 'low';
  const created = new Date(a.created_at);
  const minsAgo = Math.round((Date.now() - created.getTime()) / 60000);
  const age = minsAgo < 60 ? `${minsAgo}m` : minsAgo < 1440 ? `${Math.round(minsAgo / 60)}h` : `${Math.round(minsAgo / 1440)}d`;

  return {
    id: a.id,
    deName: a.agent_name,
    actionType: a.action_type.replace(/_/g, ' '),
    description: a.description || a.action_type,
    confidence: Math.round(score * 100),
    risk,
    status: a.status,
    age,
    resolvedBy: a.approved_by ?? undefined,
    resolvedAt: a.approved_at ? new Date(a.approved_at).toLocaleString() : undefined,
  };
}

const RISK_STYLE: Record<ApprovalItem['risk'], string> = {
  high: 'text-red-400 bg-red-400/10 border border-red-400/20',
  medium: 'text-amber-400 bg-amber-400/10 border border-amber-400/20',
  low: 'text-emerald-400 bg-emerald-400/10 border border-emerald-400/20',
};

const STATUS_STYLE: Record<DBAgentAction['status'], string> = {
  pending: 'text-amber-400 bg-amber-400/10',
  approved: 'text-emerald-400 bg-emerald-400/10',
  rejected: 'text-red-400 bg-red-400/10',
  executed: 'text-blue-400 bg-blue-400/10',
  failed: 'text-red-500 bg-red-500/10',
};

const ApprovalsPage = ({ user, tenant }: { user?: AuthUser; tenant?: Tenant }) => {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<{ id: string; deName: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const accentColor = tenant?.primaryColor || '#6366f1';

  const load = useCallback(async () => {
    if (!tenant?.id) { setLoading(false); return; }
    setLoading(true);
    const actions = await fetchAgentActions(tenant.id, 100);
    setItems(actions.map(toItem));
    setLoading(false);
  }, [tenant?.id]);

  useEffect(() => { load(); }, [load]);

  const filtered = items.filter(i => statusFilter === 'all' || i.status === statusFilter);
  const pendingCount = items.filter(i => i.status === 'pending').length;

  const handleApprove = async (id: string) => {
    if (!user?.id) return;
    setDecidingId(id);
    const ok = await approveAgentAction(id, user.id);
    if (ok) {
      writeAuditLog({
        tenant_id: tenant?.id,
        actor_user_id: user.id,
        action: 'approve',
        entity_type: 'approval',
        entity_id: id,
        entity_name: items.find(i => i.id === id)?.deName,
      });
      setItems(prev => prev.map(i => i.id === id
        ? { ...i, status: 'approved', resolvedBy: user.name, resolvedAt: new Date().toLocaleString() }
        : i
      ));
    }
    setDecidingId(null);
  };

  const handleReject = async () => {
    if (!rejectModal || !user?.id) return;
    const { id } = rejectModal;
    setDecidingId(id);
    const ok = await rejectAgentAction(id, user.id, rejectReason || 'Declined by reviewer');
    if (ok) {
      writeAuditLog({
        tenant_id: tenant?.id,
        actor_user_id: user.id,
        action: 'reject',
        entity_type: 'approval',
        entity_id: id,
        entity_name: items.find(i => i.id === id)?.deName,
        after_data: { reason: rejectReason || 'Declined by reviewer' },
      });
      setItems(prev => prev.map(i => i.id === id
        ? { ...i, status: 'rejected', resolvedBy: user.name, resolvedAt: new Date().toLocaleString() }
        : i
      ));
    }
    setDecidingId(null);
    setRejectModal(null);
    setRejectReason('');
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">Approval Queue</h1>
            {pendingCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-medium">
                {pendingCount} awaiting decision
              </span>
            )}
          </div>
          <p className="text-slate-400 text-sm mt-1">
            Review and approve or reject actions requested by your Digital Employees
          </p>
        </div>
        <button
          onClick={load}
          className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 text-sm hover:bg-slate-700 transition-all"
        >
          ↺ Refresh
        </button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Pending', value: items.filter(i => i.status === 'pending').length, color: 'text-amber-400' },
          { label: 'Approved', value: items.filter(i => i.status === 'approved').length, color: 'text-emerald-400' },
          { label: 'Rejected', value: items.filter(i => i.status === 'rejected').length, color: 'text-red-400' },
          { label: 'Total', value: items.length, color: 'text-slate-300' },
        ].map((k, i) => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className={`text-2xl font-bold mb-1 ${k.color}`}>{k.value}</div>
            <div className="text-xs text-slate-500">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 bg-slate-800 rounded-xl p-1 mb-5 w-fit">
        {(['pending', 'approved', 'rejected', 'all'] as StatusFilter[]).map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium capitalize transition-all ${
              statusFilter === s ? 'text-white' : 'text-slate-400 hover:text-white'
            }`}
            style={statusFilter === s ? { backgroundColor: accentColor } : {}}
          >
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Queue */}
      {loading ? (
        <div className="py-20 text-center text-slate-600 text-sm">Loading approvals…</div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center">
          <div className="text-3xl mb-3">✓</div>
          <div className="text-slate-400 text-sm font-medium">
            {statusFilter === 'pending' ? 'All caught up — no pending approvals' : 'No items in this category'}
          </div>
          {statusFilter === 'pending' && (
            <div className="text-slate-600 text-xs mt-1">
              Digital Employees will request approval here when they need human sign-off
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(item => (
            <div
              key={item.id}
              className={`bg-slate-900 border rounded-xl p-5 transition-all ${
                item.status === 'pending'
                  ? 'border-slate-700 hover:border-slate-600'
                  : 'border-slate-800 opacity-75'
              }`}
            >
              <div className="flex items-start gap-4">
                {/* DE avatar */}
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold flex-shrink-0"
                  style={{ backgroundColor: accentColor + '25', color: accentColor }}
                >
                  {item.deName[0]}
                </div>

                {/* Main content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-sm font-semibold text-white">{item.deName}</span>
                    <span className="text-slate-600 text-xs">·</span>
                    <span className="text-xs text-slate-500 capitalize">{item.actionType}</span>
                    <span className="text-slate-600 text-xs">·</span>
                    <span className="text-xs text-slate-600">{item.age} ago</span>
                  </div>
                  <p className="text-sm text-slate-300 mb-3 leading-snug">{item.description}</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RISK_STYLE[item.risk]}`}>
                      {item.risk} risk
                    </span>
                    <span className="text-xs text-slate-600">
                      Confidence: <span className={`font-medium ${
                        item.confidence >= 80 ? 'text-emerald-400' : item.confidence >= 60 ? 'text-amber-400' : 'text-red-400'
                      }`}>{item.confidence}%</span>
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${STATUS_STYLE[item.status]}`}>
                      {item.status}
                    </span>
                    {item.resolvedBy && (
                      <span className="text-xs text-slate-600">
                        by {item.resolvedBy} at {item.resolvedAt}
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                {item.status === 'pending' && (
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      disabled={decidingId === item.id}
                      onClick={() => setRejectModal({ id: item.id, deName: item.deName })}
                      className="px-4 py-2 rounded-lg text-sm bg-slate-800 text-slate-300 hover:bg-red-600/20 hover:text-red-300 disabled:opacity-40 transition-all"
                    >
                      Reject
                    </button>
                    <button
                      disabled={decidingId === item.id}
                      onClick={() => handleApprove(item.id)}
                      className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40 transition-all"
                      style={{ backgroundColor: accentColor }}
                    >
                      {decidingId === item.id ? '…' : 'Approve'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reject modal */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl p-6">
            <h2 className="text-base font-bold text-white mb-1">Reject action</h2>
            <p className="text-xs text-slate-400 mb-4">
              Rejecting action requested by <span className="text-white">{rejectModal.deName}</span>.
              Optionally add a reason — it will be written to the audit log.
            </p>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder="Reason for rejection (optional)…"
              rows={3}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-red-500 resize-none mb-4"
            />
            <div className="flex gap-3">
              <button
                onClick={() => { setRejectModal(null); setRejectReason(''); }}
                className="flex-1 py-2.5 rounded-xl text-sm text-slate-400 bg-slate-800 hover:bg-slate-700 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={!!decidingId}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 transition-all"
              >
                {decidingId ? 'Rejecting…' : 'Confirm Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApprovalsPage;
